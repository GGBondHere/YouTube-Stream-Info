// ==UserScript==
// @name         YouTube Stream Info
// @name:zh-CN   YouTube Stream Info - 网速与 CDN 地区显示
// @name:zh-TW   YouTube Stream Info - 網速與 CDN 地區顯示
// @namespace    urn:youtube-stream-info
// @version      1.0.0
// @description  在 YouTube 原生播放器中显示网速与 CDN 地区，支持 MB/s、Mbps 切换及详细统计信息换算
// @description:zh-TW 在 YouTube 原生播放器中顯示網速與 CDN 地區，支援 MB/s、Mbps 切換及詳細統計資訊換算
// @description:en Show connection speed and CDN region in YouTube's native player, with MB/s or Mbps and conversion in Stats for nerds.
// @author       GGBondHere
// @license      MIT
// @homepageURL  https://github.com/GGBondHere/YouTube-Stream-Info
// @supportURL   https://github.com/GGBondHere/YouTube-Stream-Info/issues
// @icon         https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/youtube-icon.svg
// @icon64       https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/youtube-icon.svg
// @match        https://www.youtube.com/*
// @run-at       document-start
// @sandbox      JavaScript
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addStyle
// @connect      cloudflare-dns.com
// @connect      dns.google
// @connect      api.country.is
// @connect      ipwho.is
// @downloadURL  https://raw.githubusercontent.com/GGBondHere/YouTube-Stream-Info/main/youtube-stream-info.user.js
// @updateURL    https://raw.githubusercontent.com/GGBondHere/YouTube-Stream-Info/main/youtube-stream-info.user.js
// ==/UserScript==

(() => {
    'use strict';

    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const instanceKey = Symbol.for('youtube-stream-info.instance');
    if (page[instanceKey]) return;

    // Firefox 的 JavaScript 沙箱需要将供页面调用的函数导出到页面作用域。
    function pageCallable(callback) {
        return typeof exportFunction === 'function' ? exportFunction(callback, page) : callback;
    }

    const limits = Object.freeze({
        requestMs: 4000,
        dnsMs: 600000,
        countryMs: 86400000,
        retryMs: 60000,
        forbiddenMs: 600000,
        dnsEntries: 128,
        countryEntries: 512,
        cnameHops: 8,
        geoParallel: 2,
    });
    const storagePrefix = 'ysi.v1.';
    const countryPrefix = `${storagePrefix}country.`;
    const dnsProviders = [
        { id: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query', rateMs: 60000 },
        { id: 'google', url: 'https://dns.google/resolve', rateMs: 60000 },
    ];
    const geoProviders = [
        { id: 'country', url: 'https://api.country.is/', rateMs: 60000 },
        { id: 'ipwho', url: 'https://ipwho.is/', rateMs: 86400000 },
    ];
    const memoryStorage = new Map();
    const storage = {
        get(key, fallback) {
            try { return GM_getValue(key, fallback); }
            catch { return memoryStorage.has(key) ? memoryStorage.get(key) : fallback; }
        },
        set(key, value) {
            memoryStorage.set(key, value);
            try { GM_setValue(key, value); } catch { /* 存储不可用时继续使用当前页内存。 */ }
        },
        remove(key) {
            memoryStorage.delete(key);
            try { GM_deleteValue(key); } catch { /* 不影响播放。 */ }
        },
        keys() {
            try { return GM_listValues(); } catch { return [...memoryStorage.keys()]; }
        },
    };
    const savedPreferences = storage.get(`${storagePrefix}preferences`, {});
    const preferences = {
        speedUnit: savedPreferences?.speedUnit === 'Mbps' ? 'Mbps' : 'MB/s',
        addressFamily: savedPreferences?.addressFamily === 'IPv6' ? 'IPv6' : 'IPv4',
        regionVisible: savedPreferences?.regionVisible !== false,
    };

    function aborted() {
        return new DOMException('识别已取消', 'AbortError');
    }

    function assertLive(signal) {
        if (signal.aborted) throw aborted();
    }

    function normalizeHost(value) {
        if (typeof value !== 'string') return null;
        const host = value.toLowerCase().replace(/\.$/, '');
        if (host.length > 253 || !host.split('.').every(label =>
            label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
        return host;
    }

    function mediaUrl(value) {
        try {
            const url = new URL(value, location.href);
            const host = normalizeHost(url.hostname);
            if (url.protocol !== 'https:' || !host ||
                !(host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) ||
                url.pathname !== '/videoplayback') return null;
            return url;
        } catch { return null; }
    }

    function normalizeIp(value) {
        if (typeof value !== 'string' || value !== value.trim()) return null;
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
            const parts = value.split('.');
            if (parts.some(part => Number(part) > 255 || (part.length > 1 && part[0] === '0'))) return null;
            return parts.map(Number).join('.');
        }
        if (!value.includes(':') || /[^a-fA-F0-9:.]/.test(value)) return null;
        try {
            return new URL(`https://[${value}]/`).hostname.slice(1, -1).toLowerCase();
        } catch { return null; }
    }

    const names = new Intl.DisplayNames(['zh-Hans'], { type: 'region', fallback: 'none' });
    function countryName(code) {
        if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
        const shortNames = { HK: '香港', MO: '澳门', TW: '台湾' };
        if (shortNames[code]) return shortNames[code];
        if (['ZZ', 'XX', 'EU', 'UN', 'QO'].includes(code)) return null;
        try { return names.of(code) || null; } catch { return null; }
    }

    function trimMap(map, capacity) {
        const now = Date.now();
        for (const [key, entry] of map) if (entry.expires <= now) map.delete(key);
        while (map.size > capacity) map.delete(map.keys().next().value);
    }

    function touch(map, key, entry) {
        map.delete(key);
        map.set(key, entry);
    }

    function freshEntry(map, key) {
        const entry = map.get(key);
        if (!entry || entry.expires <= Date.now()) {
            map.delete(key);
            return null;
        }
        touch(map, key, entry);
        return entry;
    }

    const dnsCache = new Map();
    const countryCache = new Map();
    const hostFailures = new Map();
    const ipFailures = new Map();
    const providerCooldowns = new Map();
    const hostJobs = new Map();
    const ipJobs = new Map();
    const jobControllers = new Set();
    let cacheVersion = 0;
    let geoRunning = 0;
    const geoQueue = [];

    function pruneStoredCountries() {
        const valid = [];
        const now = Date.now();
        for (const key of storage.keys()) {
            if (!key.startsWith(countryPrefix)) continue;
            const item = storage.get(key, null);
            if (!item || !Number.isFinite(item.expires) || item.expires <= now || !countryName(item.code)) {
                storage.remove(key);
            } else valid.push({ key, created: Number(item.created) || 0 });
        }
        valid.sort((a, b) => b.created - a.created);
        for (const item of valid.slice(limits.countryEntries)) storage.remove(item.key);
    }

    function cachedCountry(ip) {
        const memory = freshEntry(countryCache, ip);
        if (memory) return memory;
        const key = countryPrefix + ip;
        const saved = storage.get(key, null);
        if (saved && Number.isFinite(saved.expires) && saved.expires > Date.now() && countryName(saved.code)) {
            touch(countryCache, ip, saved);
            trimMap(countryCache, limits.countryEntries);
            return saved;
        }
        if (saved) storage.remove(key);
        return null;
    }

    function cooldownUntil(provider) {
        const key = `${storagePrefix}cooldown.${provider.id}`;
        const stored = storage.get(key, 0);
        return Math.max(providerCooldowns.get(provider.id) || 0, Number(stored) || 0);
    }

    function retryDelay(headers, fallback) {
        const match = String(headers || '').match(/^retry-after:\s*(.+)$/im);
        if (!match) return fallback;
        const seconds = Number(match[1]);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const deadline = Date.parse(match[1]);
        return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : fallback;
    }

    function blockProvider(provider, delay) {
        const until = Math.max(cooldownUntil(provider), Date.now() + delay);
        providerCooldowns.set(provider.id, until);
        storage.set(`${storagePrefix}cooldown.${provider.id}`, until);
    }

    // 独立计时器同时覆盖匿名请求的传输与正文接收，不依赖 fetch 模式的 timeout 行为。
    function requestJson(provider, url, signal, headers = {}) {
        assertLive(signal);
        if (cooldownUntil(provider) > Date.now()) return Promise.reject(new Error('接口冷却中'));
        return new Promise((resolve, reject) => {
            let finished = false;
            let handle;
            let timer;
            const finish = (error, value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                if (error) reject(error); else resolve(value);
            };
            const cancel = () => {
                finish(aborted());
                try { handle?.abort(); } catch { /* 回调已结束。 */ }
            };
            signal.addEventListener('abort', cancel, { once: true });
            timer = setTimeout(() => {
                blockProvider(provider, limits.retryMs);
                finish(new Error('接口超时'));
                try { handle?.abort(); } catch { /* 回调已结束。 */ }
            }, limits.requestMs);
            try {
                handle = GM_xmlhttpRequest({
                    method: 'GET', url, headers, anonymous: true, responseType: 'json',
                    onload(response) {
                        if (finished) return;
                        if (signal.aborted) return cancel();
                        const status = response.status;
                        if (status === 403) blockProvider(provider, limits.forbiddenMs);
                        if (status === 429) blockProvider(provider, retryDelay(response.responseHeaders, provider.rateMs));
                        if (status >= 500) blockProvider(provider, limits.retryMs);
                        if (status < 200 || status >= 300) return finish(new Error(`接口 HTTP ${status}`));
                        try {
                            const final = new URL(response.finalUrl || url);
                            if (final.protocol !== 'https:' || final.hostname !== new URL(provider.url).hostname) {
                                throw new Error('接口发生意外重定向');
                            }
                            const data = response.response ?? JSON.parse(response.responseText);
                            if (!data || typeof data !== 'object') throw new Error('接口返回格式无效');
                            finish(null, data);
                        } catch {
                            blockProvider(provider, limits.retryMs);
                            finish(new Error('接口返回格式无效'));
                        }
                    },
                    onerror() {
                        if (finished) return;
                        blockProvider(provider, limits.retryMs);
                        finish(new Error('接口网络错误'));
                    },
                    onabort() { finish(aborted()); },
                    ontimeout() {
                        if (finished) return;
                        blockProvider(provider, limits.retryMs);
                        finish(new Error('接口超时'));
                    },
                });
            } catch {
                blockProvider(provider, limits.retryMs);
                finish(new Error('跨域请求不可用'));
            }
        });
    }

    function negativeTtl(data) {
        let ttl = limits.dnsMs / 1000;
        for (const record of data.Authority || []) {
            if (record.type !== 6) continue;
            const minimum = Number(String(record.data).trim().split(/\s+/).pop());
            if (Number.isFinite(record.TTL) && record.TTL >= 0) ttl = Math.min(ttl, record.TTL);
            if (Number.isFinite(minimum) && minimum >= 0) ttl = Math.min(ttl, minimum);
        }
        return ttl;
    }

    async function queryAddressType(provider, originalHost, type, signal) {
        let host = originalHost;
        let ttl = limits.dnsMs / 1000;
        let aliasesSeen = 0;
        const visited = new Set();
        for (let hop = 0; hop <= limits.cnameHops; hop++) {
            assertLive(signal);
            if (visited.has(host)) throw new Error('DNS 别名循环');
            visited.add(host);
            const query = new URL(provider.url);
            query.searchParams.set('name', host);
            query.searchParams.set('type', String(type));
            const data = await requestJson(provider, query.href, signal, { Accept: 'application/dns-json' });
            if (![0, 3].includes(data.Status) || data.TC === true) throw new Error('DNS 响应不完整');
            if (data.Answer !== undefined && !Array.isArray(data.Answer)) throw new Error('DNS 记录格式无效');
            const nx = data.Status === 3;
            const answer = Array.isArray(data.Answer) ? data.Answer : [];
            let owner = host;
            let nextHost = null;
            for (;;) {
                const records = answer.filter(record => normalizeHost(record.name) === owner);
                const addresses = records.filter(record => record.type === type);
                if (addresses.length) {
                    if (nx) throw new Error('DNS 响应状态与地址记录冲突');
                    for (const record of addresses) {
                        const ip = normalizeIp(record.data);
                        if (!ip || (type === 1) !== !ip.includes(':') || !Number.isFinite(record.TTL) || record.TTL < 0) {
                            continue;
                        }
                        return { ip, ttl: Math.min(ttl, record.TTL), nx: false };
                    }
                    throw new Error('DNS 地址记录无效');
                }
                const aliases = records.filter(record => record.type === 5);
                if (!aliases.length) break;
                if (++aliasesSeen > limits.cnameHops) throw new Error('DNS 别名链过长');
                if (aliases.length !== 1 || !Number.isFinite(aliases[0].TTL) || aliases[0].TTL < 0) {
                    throw new Error('DNS 别名记录无效');
                }
                const alias = normalizeHost(aliases[0].data);
                if (!alias || visited.has(alias)) throw new Error('DNS 别名循环');
                ttl = Math.min(ttl, aliases[0].TTL);
                nextHost = alias;
                owner = alias;
                if (answer.some(record => normalizeHost(record.name) === alias)) {
                    visited.add(alias);
                } else break;
            }
            ttl = Math.min(ttl, negativeTtl(data));
            if (nx || !nextHost) return { ip: null, ttl, nx };
            // 响应只包含 CNAME 时，向同一个服务继续查询；已经展开的末端别名允许再次查询。
            visited.delete(nextHost);
            host = nextHost;
        }
        throw new Error('DNS 别名链过长');
    }

    async function resolveAddress(host, signal, version) {
        const cached = freshEntry(dnsCache, host);
        if (cached) return cached;
        const preferredType = preferences.addressFamily === 'IPv6' ? 28 : 1;
        const alternateType = preferredType === 1 ? 28 : 1;
        let lastError = new Error('DNS 不可用');
        for (const provider of dnsProviders) {
            assertLive(signal);
            try {
                const preferred = await queryAddressType(provider, host, preferredType, signal);
                assertLive(signal);
                let selected = preferred;
                let ttl = preferred.ttl;
                if (!preferred.ip) {
                    // 只有有效的无记录响应才换地址类型；查询错误由下一家 DNS 服务重试。
                    selected = await queryAddressType(provider, host, alternateType, signal);
                    assertLive(signal);
                    if (preferred.nx && selected.ip) throw new Error('DNS 地址类型响应冲突');
                    ttl = Math.min(ttl, selected.ttl);
                }
                ttl = Math.min(ttl, selected.ip ? limits.dnsMs / 1000 : limits.retryMs / 1000);
                const entry = {
                    ip: selected.ip,
                    family: selected.ip ? (selected.ip.includes(':') ? 'IPv6' : 'IPv4') : null,
                    expires: Date.now() + ttl * 1000,
                };
                if (version === cacheVersion) {
                    touch(dnsCache, host, entry);
                    trimMap(dnsCache, limits.dnsEntries);
                }
                return entry;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                lastError = error;
            }
        }
        throw lastError;
    }

    function drainGeoQueue() {
        while (geoRunning < limits.geoParallel && geoQueue.length) {
            const item = geoQueue.shift();
            if (item.signal.aborted) { item.reject(aborted()); continue; }
            geoRunning++;
            Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
                geoRunning--;
                drainGeoQueue();
            });
        }
    }

    function queueGeo(work, signal) {
        assertLive(signal);
        return new Promise((resolve, reject) => {
            geoQueue.push({ work, signal, resolve, reject });
            drainGeoQueue();
        });
    }

    function lookupCountry(ip, signal, version) {
        const cached = cachedCountry(ip);
        if (cached) return Promise.resolve(cached);
        if (freshEntry(ipFailures, ip)) return Promise.reject(new Error('地址查询冷却中'));
        if (ipJobs.has(ip)) return ipJobs.get(ip);
        const job = queueGeo(async () => {
            let lastError = new Error('地区不可用');
            for (const provider of geoProviders) {
                assertLive(signal);
                try {
                    const data = await requestJson(provider, provider.url + encodeURIComponent(ip), signal);
                    assertLive(signal);
                    const code = provider.id === 'country' ? data.country : data.country_code;
                    if (normalizeIp(data.ip) !== ip || !countryName(code) ||
                        (provider.id === 'ipwho' && data.success !== true)) throw new Error('地区结果无效');
                    const entry = { code, created: Date.now(), expires: Date.now() + limits.countryMs };
                    if (version === cacheVersion) {
                        touch(countryCache, ip, entry);
                        trimMap(countryCache, limits.countryEntries);
                        storage.set(countryPrefix + ip, entry);
                        pruneStoredCountries();
                    }
                    return entry;
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    lastError = error;
                }
            }
            if (version === cacheVersion) {
                touch(ipFailures, ip, { expires: Date.now() + limits.retryMs });
                trimMap(ipFailures, limits.countryEntries);
            }
            throw lastError;
        }, signal);
        ipJobs.set(ip, job);
        job.finally(() => { if (ipJobs.get(ip) === job) ipJobs.delete(ip); }).catch(() => {});
        return job;
    }

    function resolveRegion(host) {
        const failure = freshEntry(hostFailures, host);
        if (failure) return Promise.resolve({ label: '未知', hint: failure.hint, expires: failure.expires });
        if (hostJobs.has(host)) return hostJobs.get(host);
        const controller = new AbortController();
        const version = cacheVersion;
        jobControllers.add(controller);
        const job = (async () => {
            let failureHint = '媒体域名解析失败或响应不完整，暂时无法确认地区。';
            try {
                const address = await resolveAddress(host, controller.signal, version);
                if (!address.ip) {
                    failureHint = '媒体域名没有解析到可查询的 IPv4 或 IPv6 地址。';
                    throw new Error('没有可查询地址');
                }
                failureHint = `${address.family} 地址的地区查询未成功，可能是接口不可用、超时、限流或返回结果无效。`;
                const country = await lookupCountry(address.ip, controller.signal, version);
                assertLive(controller.signal);
                const label = countryName(country.code);
                const hint = `${address.family} 地址查询参考：${label}。\n` +
                    '根据第一条有效解析地址查询，不能确认代理服务器实际连接的地址。';
                const expires = Math.min(address.expires, country.expires);
                return { label, hint, expires };
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                if (version === cacheVersion) {
                    touch(hostFailures, host, { hint: failureHint, expires: Date.now() + limits.retryMs });
                    trimMap(hostFailures, limits.dnsEntries);
                }
                return { label: '未知', hint: failureHint, expires: Date.now() + limits.retryMs };
            }
        })();
        hostJobs.set(host, job);
        job.finally(() => {
            jobControllers.delete(controller);
            if (hostJobs.get(host) === job) hostJobs.delete(host);
        }).catch(() => {});
        return job;
    }

    function cancelLookups() {
        cacheVersion++;
        for (const controller of jobControllers) controller.abort();
        jobControllers.clear();
        hostJobs.clear();
        ipJobs.clear();
        for (const item of geoQueue.splice(0)) item.reject(aborted());
    }

    const regionHints = {
        '等待媒体': '尚未观察到可确认属于当前视频的媒体请求；正在等待可识别的媒体域名。',
        '识别中': '正在查询媒体域名的解析地址及其地区。',
        '未知': '暂时无法确认媒体地区，可稍后使用“重新识别 CDN”重试。',
    };
    const runtime = {
        epoch: 0, routeId: null, player: null, ad: false, ready: false,
        started: performance.now(), selectedHost: null, requestTime: -1,
        evidence: 0, regionVersion: 0, regionPending: false, regionExpires: 0,
        regionLabel: '等待媒体', regionHint: regionHints['等待媒体'], speed: null, snapshot: null,
        interval: null, animation: null, suspended: false, destroyed: false,
        navigationFrom: null,
    };
    function setRegionStatus(label, hint = regionHints[label]) {
        runtime.regionLabel = label;
        runtime.regionHint = hint || '地区参考来自媒体域名解析与 IP 地区查询。';
    }
    const panelSelectors = '.html5-video-info-panel-content, .ytp-sfn-content';
    const ownsNode = node => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return Boolean(element?.closest('[data-ysi]'));
    };

    function readKbpsText(value) {
        if (typeof value !== 'string') return null;
        const match = value.match(/(?:^|[^\d.,])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*kbps\b/i);
        if (!match) return null;
        const number = Number(match[1].replaceAll(',', ''));
        return Number.isFinite(number) && number >= 0 ? number : null;
    }

    function statsValue(value) {
        if (typeof value === 'string' && value.trim().startsWith('{')) {
            try { return JSON.parse(value); } catch { return value; }
        }
        return value;
    }

    function readKbpsStats(input) {
        const value = statsValue(input);
        if (typeof value === 'string') {
            const line = value.split(/\n/).find(item => /connection\s*speed|bandwidth|连接速度|連線速度/i.test(item));
            return readKbpsText(line);
        }
        if (!value || typeof value !== 'object') return null;
        for (const [key, item] of Object.entries(value)) {
            if (!/bandwidth|connection.?speed|连接速度|連線速度/i.test(key)) continue;
            const labelled = readKbpsText(item);
            if (labelled !== null) return labelled;
            if (/(?:_kbps|Kbps)$/i.test(key) &&
                (typeof item === 'number' || (typeof item === 'string' && /^\d+(?:\.\d+)?$/.test(item)))) {
                const number = Number(item);
                if (Number.isFinite(number) && number >= 0) return number;
            }
        }
        return null;
    }

    function safePlayerCall(player, name, ...args) {
        try {
            const api = player?.wrappedJSObject || player;
            if (typeof api?.[name] === 'function') return Reflect.apply(api[name], api, args);
        } catch { /* 播放器私有接口可能随页面版本变化。 */ }
        return null;
    }

    function visibleStatsTarget() {
        if (!runtime.player) return null;
        for (const panel of runtime.player.querySelectorAll(panelSelectors)) {
            if (!panel.getClientRects().length) continue;
            const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (ownsNode(node)) continue;
                const kbps = readKbpsText(node.nodeValue);
                if (kbps !== null && node.parentElement) return { element: node.parentElement, kbps };
            }
        }
        return null;
    }

    function speedLabel(kbps) {
        const unit = preferences.speedUnit;
        const divisor = unit === 'Mbps' ? 1000 : 8000;
        return kbps === null ? `— ${unit}` : `${(kbps / divisor).toFixed(2)} ${unit}`;
    }

    function playbackSnapshot(player, routeId) {
        const videoData = safePlayerCall(player, 'getVideoData');
        const response = statsValue(safePlayerCall(player, 'getPlayerResponse'));
        let stats = safePlayerCall(player, 'getStatsForNerds', 0);
        let speed = readKbpsStats(stats);
        if (speed === null) {
            const alternative = safePlayerCall(player, 'getStatsForNerds');
            if (alternative !== null) stats = alternative;
            speed = readKbpsStats(alternative);
        }
        if (speed === null) speed = readKbpsStats(safePlayerCall(player, 'getDebugText'));
        if (speed === null) speed = visibleStatsTarget()?.kbps ?? null;
        const parsedStats = statsValue(stats);
        const reportedId = videoData?.video_id || response?.videoDetails?.videoId || parsedStats?.video_id;
        const ready = reportedId === routeId;
        const formats = new Map();
        if (ready) {
            const data = response?.streamingData;
            const regular = Array.isArray(data?.formats) ? data.formats : [];
            const adaptive = Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : [];
            for (const format of [...regular, ...adaptive]) {
                if (format && format.itag !== undefined && typeof format.mimeType === 'string') {
                    formats.set(String(format.itag), format.mimeType);
                }
            }
        }
        let cpn = videoData?.cpn || parsedStats?.cpn || parsedStats?.sCPN;
        if (typeof cpn !== 'string' || !/^[\w-]{6,64}$/.test(cpn)) cpn = null;
        if (!cpn && parsedStats && typeof parsedStats === 'object') {
            for (const [key, value] of Object.entries(parsedStats)) {
                if (!/cpn/i.test(key) || typeof value !== 'string') continue;
                const parts = value.match(/\/\s*([\w-]{6,64})\s*$/);
                if (parts) { cpn = parts[1]; break; }
            }
        }
        const sabrUrl = ready ? mediaUrl(response?.streamingData?.serverAbrStreamingUrl) : null;
        return {
            ready, speed: ready ? speed : null, formats, cpn,
            sabr: sabrUrl ? {
                host: sabrUrl.hostname,
                id: sabrUrl.searchParams.get('id'),
                source: sabrUrl.searchParams.get('source'),
            } : null,
        };
    }

    const bar = document.createElement('span');
    bar.dataset.ysi = 'bar';
    bar.hidden = true;
    const speedNode = document.createElement('span');
    const separator = document.createElement('span');
    separator.textContent = '·';
    const regionNode = document.createElement('span');
    regionNode.dataset.ysi = 'region';
    bar.append(speedNode, separator, regionNode);
    const blueNode = document.createElement('span');
    blueNode.dataset.ysi = 'stats';
    blueNode.hidden = true;
    const stylesheet = `
        [data-ysi="bar"] { display:inline-flex; align-items:center; gap:6px;
            align-self:center; flex:0 0 auto; height:100%; margin-inline:6px;
            float:left; color:#fff; font:600 13px/1.2 Arial,sans-serif; font-variant-numeric:tabular-nums;
            white-space:nowrap; pointer-events:none; vertical-align:middle; }
        [data-ysi="bar"].ysi-compact { font-size:11px; gap:4px; margin-inline:4px; }
        [data-ysi="region"] { pointer-events:auto; cursor:help; }
        [data-ysi="stats"] { color:#009fe8; font-family:inherit; font-size:inherit;
            font-weight:700; margin-inline-start:6px;
            white-space:nowrap; pointer-events:none; font-variant-numeric:tabular-nums; }
        [data-ysi][hidden] { display:none !important; }
    `;
    let styleNode = null;
    const menuIds = [];
    let watchedPlayer = null;
    let watchedControls = null;
    const playerObserver = new MutationObserver(() => scheduleReconcile());
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => render()) : {
        observe() {}, disconnect() {},
    };

    function writeText(element, value) {
        if (element.textContent !== value) element.textContent = value;
    }

    function mountStyle() {
        if (styleNode?.isConnected) return;
        if (!document.documentElement) return;
        try { styleNode = GM_addStyle(stylesheet); } catch { /* 使用页面样式节点降级。 */ }
        if (!styleNode || typeof styleNode.setAttribute !== 'function') {
            styleNode = document.createElement('style');
            styleNode.textContent = stylesheet;
            document.documentElement.appendChild(styleNode);
        }
        if (styleNode) styleNode.dataset.ysi = 'style';
    }

    function controlsRow(controls) {
        return controls?.closest('.ytp-chrome-controls') || controls?.closest('.ytp-chrome-bottom') || controls?.parentElement;
    }

    function controlSlot(player) {
        const right = player.querySelector('.ytp-right-controls');
        if (!right) return null;
        const settings = right.querySelector('.ytp-settings-button');
        const fullscreen = right.querySelector('.ytp-fullscreen-button');
        if (!settings || !fullscreen) return right;
        // 新版控制区可能多包一层分组，挂在设置和全屏按钮共同的原生容器中。
        let slot = settings.parentElement;
        while (slot && slot !== right && !slot.contains(fullscreen)) slot = slot.parentElement;
        return slot && right.contains(slot) ? slot : right;
    }

    function fitControls(controls) {
        const row = controlsRow(controls);
        if (!row) { bar.hidden = true; return; }
        // 先取得未加入文字时的原生控件尺寸；不把 flex 填充的空白容器宽度当成按钮宽度。
        bar.hidden = true;
        bar.classList.remove('ysi-compact');
        const bounds = row.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        const candidates = [...row.querySelectorAll(
            'button, [role="button"], .ytp-button, .ytp-time-display, .ytp-volume-panel, .ytp-chapter-title-content',
        )].filter(element => !ownsNode(element) && element.getClientRects().length);
        const baseline = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)))
            .map(element => ({ element, rect: element.getBoundingClientRect() }))
            .filter(item => item.rect.width > 0 && item.rect.height > 0);
        const fits = () => {
            bar.hidden = false;
            const info = bar.getBoundingClientRect();
            if (info.width <= 0 || info.height <= 0 || info.left < bounds.left - 1 ||
                info.right > bounds.right + 1 || info.top < bounds.top - 1 || info.bottom > bounds.bottom + 1) return false;
            return baseline.every(({ element, rect: before }) => {
                const current = element.getBoundingClientRect();
                if (element.matches('button, [role="button"], .ytp-button') &&
                    (current.width < before.width - 1 || current.height < before.height - 1 ||
                        Math.abs(current.top - before.top) > 1)) return false;
                const overlaps = info.left < current.right - 1 && info.right > current.left + 1 &&
                    info.top < current.bottom - 1 && info.bottom > current.top + 1;
                return !overlaps && current.left >= bounds.left - 1 && current.right <= bounds.right + 1;
            });
        };
        if (fits()) return;
        bar.classList.add('ysi-compact');
        if (!fits()) bar.hidden = true;
    }

    function render() {
        if (runtime.destroyed) return;
        const active = runtime.routeId && runtime.player?.isConnected && !runtime.suspended;
        const controls = active ? controlSlot(runtime.player) : null;
        if (controls && bar.parentElement !== controls) controls.prepend(bar);
        if (controls !== watchedControls) {
            resizeObserver.disconnect();
            watchedControls = controls;
            if (controls) {
                resizeObserver.observe(controls);
                const row = controlsRow(controls);
                if (row) resizeObserver.observe(row);
            }
        }
        regionNode.hidden = !preferences.regionVisible;
        separator.hidden = !preferences.regionVisible;
        writeText(speedNode, speedLabel(runtime.speed));
        writeText(regionNode, runtime.regionLabel);
        if (regionNode.title !== runtime.regionHint) regionNode.title = runtime.regionHint;
        bar.hidden = !active || runtime.ad || !controls;
        if (!bar.hidden) fitControls(controls);
        const target = active && runtime.ready && !runtime.ad ? visibleStatsTarget() : null;
        if (target) {
            if (blueNode.parentElement !== target.element) target.element.appendChild(blueNode);
            writeText(blueNode, `(${speedLabel(target.kbps)})`);
            blueNode.hidden = false;
        } else blueNode.hidden = true;
    }

    function resetSelection() {
        runtime.selectedHost = null;
        runtime.requestTime = -1;
        runtime.evidence = 0;
        runtime.regionVersion++;
        runtime.regionPending = false;
        runtime.regionExpires = 0;
        setRegionStatus('等待媒体');
        runtime.speed = null;
        runtime.snapshot = null;
        runtime.ready = false;
        cancelLookups();
    }

    function routeVideoId() {
        if (location.pathname !== '/watch') return null;
        const id = new URL(location.href).searchParams.get('v');
        return id && /^[\w-]+$/.test(id) ? id : null;
    }

    function reconcile() {
        if (runtime.destroyed || runtime.suspended) return;
        mountStyle();
        const routeId = routeVideoId();
        const player = routeId ? document.getElementById('movie_player') : null;
        const ad = Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'));
        if (routeId !== runtime.routeId || player !== runtime.player || ad !== runtime.ad) {
            runtime.epoch++;
            runtime.started = performance.now();
            runtime.routeId = routeId;
            runtime.player = player;
            runtime.ad = ad;
            resetSelection();
        }
        if (runtime.navigationFrom && routeId !== runtime.navigationFrom) runtime.navigationFrom = null;
        if (player !== watchedPlayer) {
            playerObserver.disconnect();
            watchedPlayer = player;
            if (player) playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
        }
        if (routeId && player && !ad && !runtime.navigationFrom) {
            const snapshot = playbackSnapshot(player, routeId);
            // 播放器已换到其他内容时，旧 Host 不再属于当前界面，即使 URL 还没有完成更新。
            if (runtime.ready && !snapshot.ready) {
                runtime.epoch++;
                runtime.started = performance.now();
                resetSelection();
            }
            runtime.snapshot = snapshot;
            runtime.ready = snapshot.ready;
            runtime.speed = snapshot.speed;
        } else {
            runtime.ready = false;
            runtime.speed = null;
        }
        if (routeId && player) {
            if (runtime.interval === null) runtime.interval = setInterval(reconcile, 1000);
        } else if (runtime.interval !== null) {
            clearInterval(runtime.interval);
            runtime.interval = null;
        }
        render();
    }

    function scheduleReconcile() {
        if (runtime.animation !== null || runtime.destroyed || runtime.suspended) return;
        runtime.animation = requestAnimationFrame(() => {
            runtime.animation = null;
            reconcile();
        });
    }

    function identifySelectedHost() {
        const host = runtime.selectedHost;
        if (!host || !preferences.regionVisible || !runtime.ready || runtime.ad || runtime.suspended) return;
        if (runtime.regionPending || runtime.regionExpires > Date.now()) return;
        const epoch = runtime.epoch;
        const version = runtime.regionVersion;
        runtime.regionPending = true;
        setRegionStatus('识别中');
        render();
        resolveRegion(host).then(result => {
            if (runtime.destroyed || !preferences.regionVisible || runtime.epoch !== epoch ||
                runtime.regionVersion !== version || runtime.selectedHost !== host) return;
            setRegionStatus(result.label, result.hint);
            runtime.regionExpires = result.expires;
            runtime.regionPending = false;
            render();
        }).catch(error => {
            if (runtime.epoch !== epoch || runtime.regionVersion !== version || runtime.selectedHost !== host) return;
            runtime.regionPending = false;
            if (error.name !== 'AbortError') {
                setRegionStatus('未知');
                runtime.regionExpires = Date.now() + limits.retryMs;
                render();
            }
        });
    }

    function acceptMedia(event) {
        if (!preferences.regionVisible || !runtime.ready || runtime.ad || runtime.suspended ||
            event.epoch !== runtime.epoch || event.started < runtime.started ||
            !['video', 'shared'].includes(event.track) || event.started < runtime.requestTime) return;
        // 时序条目中的 URL 是请求目标，不能覆盖本会话已经观察到的最终响应 Host。
        if (event.evidence < runtime.evidence) return;
        const changed = runtime.selectedHost !== event.host;
        runtime.requestTime = event.started;
        runtime.evidence = event.evidence;
        if (changed) {
            runtime.selectedHost = event.host;
            runtime.regionVersion++;
            runtime.regionPending = false;
            runtime.regionExpires = 0;
            setRegionStatus('识别中');
        }
        identifySelectedHost();
    }

    function mimeTrack(mime) {
        if (typeof mime !== 'string') return null;
        if (/^video\//i.test(mime)) return 'video';
        if (/^audio\//i.test(mime)) return 'audio';
        return null;
    }

    function requestInputUrl(input) {
        if (typeof input === 'string') return input;
        try {
            if (input instanceof page.URL) return input.href;
            if (input instanceof page.Request) return input.url;
        } catch { /* 任意自定义对象仍交给原生请求函数处理，不额外触发其转换。 */ }
        return null;
    }

    function requestCandidate(value, started = null) {
        if (!preferences.regionVisible || runtime.suspended || runtime.destroyed) return null;
        const url = mediaUrl(value);
        if (!url) return null;
        reconcile();
        const requestStarted = started ?? performance.now();
        const snapshot = runtime.snapshot;
        if (!runtime.ready || runtime.ad || runtime.navigationFrom || requestStarted < runtime.started) return null;
        const cpn = url.searchParams.get('cpn');
        if (cpn && snapshot.cpn && cpn !== snapshot.cpn) return null;
        const itag = url.searchParams.get('itag');
        const fromFormat = mimeTrack(snapshot.formats.get(itag));
        const fromQuery = mimeTrack(url.searchParams.get('mime'));
        const conflict = fromFormat && fromQuery && fromFormat !== fromQuery;
        const sabr = snapshot.sabr;
        const sharedMatch = Boolean(sabr && sabr.id &&
            url.searchParams.get('id') === sabr.id && url.searchParams.get('source') === sabr.source);
        return {
            epoch: runtime.epoch, started: requestStarted, host: url.hostname,
            hint: conflict ? 'conflict' : fromFormat || fromQuery,
            cpnMatched: Boolean(cpn && snapshot.cpn && cpn === snapshot.cpn),
            sharedMatch,
        };
    }

    function responseTrack(candidate, contentType) {
        if (candidate.hint === 'conflict') return 'unknown';
        const explicit = mimeTrack(contentType);
        if (explicit && candidate.hint && explicit !== candidate.hint) return 'unknown';
        if (explicit || candidate.hint) return explicit || candidate.hint;
        if (candidate.sharedMatch && /^application\/vnd\.yt-ump(?:;|$)/i.test(contentType || '')) return 'shared';
        return 'unknown';
    }

    function noteResponse(candidate, finalUrl, contentType, status) {
        if (!candidate || status < 200 || status >= 300) return;
        const final = mediaUrl(finalUrl);
        if (!final) return;
        reconcile();
        acceptMedia({
            epoch: candidate.epoch, started: candidate.started, host: final.hostname,
            track: responseTrack(candidate, contentType), evidence: 2,
        });
    }

    let originalFetch = null;
    let fetchWrapper = null;
    let originalOpen = null;
    let originalSend = null;
    let openWrapper = null;
    let sendWrapper = null;
    let xhrPrototype = null;
    let timingObserver = null;
    const xhrRecords = new WeakMap();
    const xhrListeners = new Set();
    const hookProblems = [];

    function installMediaObservers() {
        try {
            if (typeof page.fetch !== 'function') throw new Error('fetch 不可用');
            originalFetch = page.fetch;
            const ignoreResult = pageCallable(() => {});
            fetchWrapper = pageCallable(function (...args) {
                let candidate = null;
                try {
                    const value = requestInputUrl(args[0]);
                    if (value) candidate = requestCandidate(value);
                } catch { /* 观察失败不能阻断媒体请求。 */ }
                const promise = Reflect.apply(originalFetch, this, args);
                if (candidate) {
                    try {
                        promise.then(pageCallable(response => {
                            try {
                                noteResponse(candidate, response.url, response.headers.get('content-type'), response.status);
                            } catch { /* 旁路回调不改变原始 Promise 的结果。 */ }
                        }), ignoreResult).catch(ignoreResult);
                    } catch { /* 原始返回值始终原样返回。 */ }
                }
                return promise;
            });
            page.fetch = fetchWrapper;
            if (page.fetch !== fetchWrapper) throw new Error('fetch 不能写入页面');
        } catch { hookProblems.push('fetch'); }
        try {
            xhrPrototype = page.XMLHttpRequest?.prototype;
            if (!xhrPrototype || typeof xhrPrototype.open !== 'function' || typeof xhrPrototype.send !== 'function') {
                throw new Error('XHR 不可用');
            }
            originalOpen = xhrPrototype.open;
            originalSend = xhrPrototype.send;
            openWrapper = pageCallable(function (...args) {
                const result = Reflect.apply(originalOpen, this, args);
                try {
                    const previous = xhrRecords.get(this);
                    if (previous?.listener) {
                        this.removeEventListener('loadend', previous.listener);
                        xhrListeners.delete(previous);
                    }
                    const value = requestInputUrl(args[1]);
                    xhrRecords.set(this, { xhr: this, candidate: value ? requestCandidate(value) : null, listener: null });
                } catch { /* 原生 open 已成功，观察逻辑不能改变返回结果。 */ }
                return result;
            });
            sendWrapper = pageCallable(function (...args) {
                let record = null;
                try {
                    record = xhrRecords.get(this);
                    if (record?.candidate && !record.listener) {
                        record.candidate.started = performance.now();
                        record.listener = () => {
                            xhrListeners.delete(record);
                            try {
                                if (xhrRecords.get(this) === record) {
                                    noteResponse(record.candidate, this.responseURL, this.getResponseHeader('content-type'), this.status);
                                }
                            } catch { /* 不读取响应正文，失败和中止响应不参与地区识别。 */ }
                        };
                        this.addEventListener('loadend', record.listener, { once: true });
                        xhrListeners.add(record);
                    }
                } catch { /* 继续原生 send。 */ }
                try { return Reflect.apply(originalSend, this, args); }
                catch (error) {
                    if (record?.listener) {
                        this.removeEventListener('loadend', record.listener);
                        xhrListeners.delete(record);
                        record.listener = null;
                    }
                    throw error;
                }
            });
            xhrPrototype.open = openWrapper;
            xhrPrototype.send = sendWrapper;
            if (xhrPrototype.open !== openWrapper || xhrPrototype.send !== sendWrapper) throw new Error('XHR 不能写入页面');
        } catch {
            hookProblems.push('XHR');
            try {
                if (xhrPrototype?.open === openWrapper) xhrPrototype.open = originalOpen;
                if (xhrPrototype?.send === sendWrapper) xhrPrototype.send = originalSend;
            } catch { /* 其他扩展可能保护了这些属性。 */ }
        }
        try {
            timingObserver = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    try {
                        if (entry.startTime < runtime.started) continue;
                        // 已由页面钩子覆盖的请求不重复采用原始 URL；跨域状态不可见时也不猜成功。
                        if ((entry.initiatorType === 'fetch' && page.fetch === fetchWrapper) ||
                            (entry.initiatorType === 'xmlhttprequest' && xhrPrototype?.send === sendWrapper)) continue;
                        const candidate = requestCandidate(entry.name, entry.startTime);
                        if (!candidate || !candidate.cpnMatched || entry.responseStatus < 200 ||
                            entry.responseStatus >= 300 || !Number.isFinite(entry.responseStatus)) continue;
                        acceptMedia({
                            epoch: candidate.epoch, started: candidate.started, host: candidate.host,
                            track: responseTrack(candidate, entry.contentType), evidence: 1,
                        });
                    } catch { /* Resource Timing 是补充证据，不是实际连接地址接口。 */ }
                }
            });
            timingObserver.observe({ type: 'resource', buffered: true });
        } catch { timingObserver = null; hookProblems.push('Resource Timing'); }
        if (hookProblems.length) console.warn(`[YouTube Stream Info] ${hookProblems.join('、')} 观察不可用；无法确认的地区显示未知。`);
    }

    function invalidateCurrentRegion(clearAddress) {
        const host = runtime.selectedHost;
        const knownAddress = host ? dnsCache.get(host)?.ip : null;
        cancelLookups();
        runtime.regionVersion++;
        runtime.regionPending = false;
        runtime.regionExpires = 0;
        setRegionStatus('等待媒体');
        if (host) {
            dnsCache.delete(host);
            hostFailures.delete(host);
        }
        if (clearAddress && knownAddress) {
            countryCache.delete(knownAddress);
            ipFailures.delete(knownAddress);
            storage.remove(countryPrefix + knownAddress);
        }
        identifySelectedHost();
        render();
    }

    function clearIdentificationCache() {
        cancelLookups();
        dnsCache.clear();
        countryCache.clear();
        hostFailures.clear();
        ipFailures.clear();
        for (const key of storage.keys()) if (key.startsWith(countryPrefix)) storage.remove(key);
        runtime.regionVersion++;
        runtime.regionPending = false;
        runtime.regionExpires = 0;
        setRegionStatus('等待媒体');
        // 服务端限流冷却不是地区缓存；手动清空缓存也不绕过 Retry-After。
        identifySelectedHost();
        render();
    }

    function registerMenus() {
        for (const id of menuIds.splice(0)) {
            try { GM_unregisterMenuCommand(id); } catch { /* 页面退出时菜单可能已经移除。 */ }
        }
        const add = (label, callback) => {
            try { menuIds.push(GM_registerMenuCommand(label, callback)); } catch { /* 不影响显示。 */ }
        };
        const nextUnit = preferences.speedUnit === 'MB/s' ? 'Mbps' : 'MB/s';
        add(`速度单位：${preferences.speedUnit}（切换为 ${nextUnit}）`, () => {
            preferences.speedUnit = nextUnit;
            storage.set(`${storagePrefix}preferences`, preferences);
            registerMenus();
            reconcile();
        });
        const nextFamily = preferences.addressFamily === 'IPv4' ? 'IPv6' : 'IPv4';
        add(`地区查询：${preferences.addressFamily} 优先（切换为 ${nextFamily} 优先）`, () => {
            preferences.addressFamily = nextFamily;
            storage.set(`${storagePrefix}preferences`, preferences);
            dnsCache.clear();
            hostFailures.clear();
            registerMenus();
            invalidateCurrentRegion(false);
        });
        add(`${preferences.regionVisible ? '✓' : '○'} 显示 CDN 地区`, () => {
            preferences.regionVisible = !preferences.regionVisible;
            storage.set(`${storagePrefix}preferences`, preferences);
            cancelLookups();
            runtime.regionVersion++;
            runtime.regionPending = false;
            runtime.regionExpires = 0;
            setRegionStatus('等待媒体');
            registerMenus();
            reconcile();
            identifySelectedHost();
        });
        add('重新识别 CDN', () => invalidateCurrentRegion(true));
        add('清空识别缓存', clearIdentificationCache);
    }

    function onNavigateStart() {
        runtime.epoch++;
        runtime.started = performance.now();
        runtime.navigationFrom = routeVideoId();
        resetSelection();
        render();
    }

    function onNavigateFinish() {
        runtime.navigationFrom = null;
        reconcile();
    }

    function onPageHide(event) {
        if (!event.persisted) { destroy(); return; }
        runtime.suspended = true;
        runtime.epoch++;
        resetSelection();
        clearInterval(runtime.interval);
        runtime.interval = null;
        if (runtime.animation !== null) cancelAnimationFrame(runtime.animation);
        runtime.animation = null;
        playerObserver.disconnect();
        resizeObserver.disconnect();
        watchedPlayer = null;
        watchedControls = null;
        bar.hidden = true;
        blueNode.hidden = true;
    }

    function onPageShow() {
        runtime.suspended = false;
        runtime.started = performance.now();
        reconcile();
    }

    const documentObserver = new MutationObserver(records => {
        const relevant = records.some(record => {
            if (ownsNode(record.target)) return false;
            const nodes = [...record.addedNodes, ...record.removedNodes];
            if (nodes.length && nodes.every(ownsNode)) return false;
            if (runtime.player?.contains(record.target)) return true;
            return nodes.some(node => node.nodeType === Node.ELEMENT_NODE &&
                (node.id === 'movie_player' || node.contains(runtime.player) || node.querySelector('#movie_player')));
        });
        if (relevant) scheduleReconcile();
    });

    function destroy() {
        if (runtime.destroyed) return;
        runtime.destroyed = true;
        cancelLookups();
        clearInterval(runtime.interval);
        if (runtime.animation !== null) cancelAnimationFrame(runtime.animation);
        documentObserver.disconnect();
        playerObserver.disconnect();
        resizeObserver.disconnect();
        timingObserver?.disconnect();
        document.removeEventListener('yt-navigate-start', onNavigateStart);
        document.removeEventListener('yt-navigate-finish', onNavigateFinish);
        document.removeEventListener('yt-page-data-updated', onNavigateFinish);
        document.removeEventListener('DOMContentLoaded', scheduleReconcile);
        window.removeEventListener('popstate', onNavigateFinish);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        try {
            if (page.fetch === fetchWrapper) page.fetch = originalFetch;
            if (xhrPrototype?.open === openWrapper) xhrPrototype.open = originalOpen;
            if (xhrPrototype?.send === sendWrapper) xhrPrototype.send = originalSend;
        } catch { /* 仅恢复仍属于本实例的钩子，不覆盖其他扩展后安装的钩子。 */ }
        for (const record of xhrListeners) record.xhr.removeEventListener('loadend', record.listener);
        xhrListeners.clear();
        for (const id of menuIds) {
            try { GM_unregisterMenuCommand(id); } catch { /* 扩展已清理。 */ }
        }
        bar.remove();
        blueNode.remove();
        styleNode?.remove();
        try { delete page[instanceKey]; } catch { /* 页面已经销毁。 */ }
    }

    try {
        const description = { version: '1.0.0' };
        const instance = typeof cloneInto === 'function' ? cloneInto(description, page) : description;
        instance.destroy = pageCallable(destroy);
        page[instanceKey] = instance;
    } catch {
        console.warn('[YouTube Stream Info] 页面访问不可用，脚本未启动。');
        return;
    }
    installMediaObservers();
    registerMenus();
    documentObserver.observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener('yt-navigate-start', onNavigateStart);
    document.addEventListener('yt-navigate-finish', onNavigateFinish);
    document.addEventListener('yt-page-data-updated', onNavigateFinish);
    document.addEventListener('DOMContentLoaded', scheduleReconcile, { once: true });
    window.addEventListener('popstate', onNavigateFinish);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    pruneStoredCountries();
    reconcile();
})();
