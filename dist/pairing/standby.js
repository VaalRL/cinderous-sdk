/** 每台最多宣告幾座備援（32 台都塞滿，名單事件仍在中繼的單顆上限內；測試釘住） */
export const ROSTER_STANDBY_MAX_URLS = 4;
/** 備援網址最長幾個字（私人路徑約 80 字） */
export const ROSTER_STANDBY_MAX_URL_LENGTH = 200;
/** 測不通的網址，`refresh()` 隔多久才重測（毫秒） */
export const DEFAULT_STANDBY_RETRY_MS = 60 * 60_000;
/** 本機與區網的網域（RFC 6761 的 localhost、6762 的 .local、8375 的 .home.arpa 與常見的內部字尾；.test 等測試保留網域不算） */
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|lan|home\.arpa|internal|intranet|corp)$/;
function isPrivateIpv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m)
        return undefined;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && Number(m[3]) === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224);
}
/**
 * 主機是不是公開的：拒絕本機（`localhost`、127/8、`::1`）、私有與保留網段（10/8、172.16/12、192.168/16、100.64/10、
 * 169.254/16、0/8、多播、fc00::/7、fe80::/10、`::` 開頭的 IPv6——含 IPv4 對應位址）、區網網域（`.local`、`.lan`、`.home.arpa`、
 * `.internal`…）與單一標籤的主機名稱。`URL` 已經把 `0x7f.1` 之類的寫法正規化成點分十進位。
 * 只看網址本身：公開網域解析到私有位址（DNS rebinding）擋不了，見 ADR 0056。
 */
function isPublicHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === '')
        return false;
    if (host.includes(':')) {
        if (host.startsWith('::') || /^f[c-d][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host) || /^ff[0-9a-f]{0,2}:/.test(host))
            return false;
        return true;
    }
    const v4 = isPrivateIpv4(host);
    if (v4 !== undefined)
        return !v4;
    if (!host.includes('.'))
        return false;
    return !PRIVATE_SUFFIX.test(host);
}
/**
 * 分享用的備援網址正規化：`wss://`、有主機、不帶帳密與片段、主機公開、不超過長度上限；主機小寫、去掉結尾斜線
 * （路徑大小寫保留——私人路徑分大小寫）。不合規回 undefined。
 */
export function normalizeStandbyUrl(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > ROSTER_STANDBY_MAX_URL_LENGTH + 1)
        return undefined;
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== 'wss:' || url.username !== '' || url.password !== '' || url.hash !== '' || trimmed.includes('#'))
        return undefined;
    if (!isPublicHost(url.hostname))
        return undefined;
    const out = url.toString().replace(/\/+$/, '');
    return out.length <= ROSTER_STANDBY_MAX_URL_LENGTH ? out : undefined;
}
/** 備援清單裡分享得出去的：正規化、去重、最多前 {@link ROSTER_STANDBY_MAX_URLS} 座（其他的丟掉） */
export function shareableStandbyUrls(urls) {
    const out = [];
    for (const raw of urls) {
        const url = normalizeStandbyUrl(raw);
        if (url !== undefined && !out.includes(url))
            out.push(url);
        if (out.length >= ROSTER_STANDBY_MAX_URLS)
            break;
    }
    return out;
}
/** 這個網址能不能經名單分享給別台（見 {@link normalizeStandbyUrl}） */
export function isShareableStandbyUrl(raw) {
    return normalizeStandbyUrl(raw) !== undefined;
}
/** 比對用：協定與主機不分大小寫、結尾斜線不計（不合規的網址也能比，給「自己的清單」用） */
function sameKey(raw) {
    try {
        return new URL(raw.trim()).toString().replace(/\/+$/, '');
    }
    catch {
        return raw.trim();
    }
}
/**
 * 依別台的宣告列出建議新增的備援（SDK ADR 0056）。純邏輯、不測試：
 * 只**新增**（不移除、不碰主清單）；自己已經有的、被忽略的、不合規的網址不建議；同一個網址合併來源；依網址排序。
 */
export function planStandbyAdoption(opts) {
    const own = new Set(opts.own.map(sameKey));
    const ignored = new Set([...(opts.ignored ?? [])].map(sameKey));
    const out = new Map();
    const consider = (source, urls) => {
        if (opts.isMember && !opts.isMember(source.pubkey))
            return;
        for (const raw of urls) {
            const url = normalizeStandbyUrl(raw);
            if (url === undefined || own.has(url) || ignored.has(url))
                continue;
            const sources = out.get(url) ?? [];
            if (!sources.some((s) => s.pubkey === source.pubkey && s.via === source.via))
                sources.push(source);
            out.set(url, sources);
        }
    };
    for (const d of opts.declared)
        consider({ pubkey: d.pubkey, deviceId: d.deviceId, label: d.label, via: 'roster' }, d.urls);
    for (const o of opts.offers ?? [])
        consider({ ...o.source, via: 'pairing' }, o.urls);
    return [...out]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([url, sources]) => ({ url, sources }));
}
/**
 * 「建議新增的備援」清單（SDK ADR 0056）：餵它別台的宣告（`update`）與配對交來的（`offer`），它算出建議、自動測試新網址、
 * 有變化時通知（`onChange`）。**不自動採用**：應用列出 `list()`，使用者按「加入」時應用自己把網址加進備援清單
 * （之後 `update` 的 `own` 有它，建議就消失），按「忽略」時呼叫 `ignore(url)`，並把 `ignored()` 存在本機。
 */
export class StandbySuggestions {
    #probe;
    #retryMs;
    #now;
    #ignored = new Set();
    #results = new Map();
    #inflight = new Map();
    #offers = new Map();
    #listeners = new Set();
    #input = { own: [], declared: [] };
    #candidates = [];
    constructor(opts) {
        this.#probe = opts.probe;
        this.#retryMs = opts.retryMs ?? DEFAULT_STANDBY_RETRY_MS;
        this.#now = opts.now ?? (() => Date.now());
        for (const url of opts.ignored ?? [])
            this.#ignored.add(normalizeStandbyUrl(url) ?? sameKey(url));
    }
    /** 換上這台目前的中繼（主清單＋備援）與別台的宣告；新的網址自動開始測試 */
    update(input) {
        this.#input = { own: [...input.own], declared: [...input.declared], ...(input.isMember ? { isMember: input.isMember } : {}) };
        this.#recompute();
    }
    /** 配對時邀請方交來的備援（`PairingResult.standby`）；同一台再交一次會取代 */
    offer(source, urls) {
        this.#offers.set(source.pubkey, { source: { pubkey: source.pubkey, deviceId: source.deviceId, label: source.label }, urls: [...urls] });
        this.#recompute();
    }
    /** 目前的建議（不含自己已經有的、被忽略的），依網址排序 */
    list() {
        return this.#candidates.map((c) => {
            const r = this.#results.get(c.url);
            if (!r)
                return { ...c, probe: 'pending' };
            return { ...c, probe: r.reachable ? 'reachable' : 'unreachable', checkedAt: r.at };
        });
    }
    /** 使用者按了「忽略」：不再建議這個網址 */
    ignore(url) {
        const key = normalizeStandbyUrl(url) ?? sameKey(url);
        if (this.#ignored.has(key))
            return;
        this.#ignored.add(key);
        this.#recompute();
    }
    /** 忽略過的網址（應用存在本機，下次建構時以 `ignored` 傳回） */
    ignored() {
        return [...this.#ignored].sort();
    }
    onChange(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /** 測試還沒測過的、以及測不通而且超過重試間隔的建議；全部測完才 resolve */
    async refresh() {
        const now = this.#now();
        const due = this.#candidates.filter((c) => {
            const r = this.#results.get(c.url);
            return !r || (!r.reachable && now - r.at >= this.#retryMs);
        });
        await Promise.all(due.map((c) => this.#test(c.url)));
    }
    #test(url) {
        let run = this.#inflight.get(url);
        if (run)
            return run;
        run = this.#probe(url)
            .catch(() => false)
            .then((reachable) => {
            const prev = this.#results.get(url);
            this.#results.set(url, { reachable, at: this.#now() });
            if (prev?.reachable !== reachable || prev === undefined)
                this.#emit();
        })
            .finally(() => this.#inflight.delete(url));
        this.#inflight.set(url, run);
        return run;
    }
    #recompute() {
        const before = JSON.stringify(this.#candidates);
        this.#candidates = planStandbyAdoption({ ...this.#input, offers: [...this.#offers.values()], ignored: this.#ignored });
        if (JSON.stringify(this.#candidates) !== before)
            this.#emit();
        void this.refresh();
    }
    #emit() {
        for (const listener of [...this.#listeners]) {
            try {
                listener();
            }
            catch {
                // 監聽者的例外不影響建議
            }
        }
    }
}
//# sourceMappingURL=standby.js.map