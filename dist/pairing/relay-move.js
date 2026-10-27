import { openWrap, sealAndWrap } from '../protocol/nip59.js';
/** 中繼搬家通知的內層 rumor kind（名單 4361、裝置宣告簽章 4362 之後） */
export const VAULT_RELAY_MOVE_KIND = 4363;
/** 通知的 NIP-40 保存期：最長唯讀寬限期（30 天）多一天。中繼會再以自己的上限截短 */
export const DEFAULT_RELAY_MOVE_TTL_SECONDS = 31 * 86_400;
/** 網址最長幾個字（中繼網址＋26 字私人路徑約 80 字） */
export const RELAY_MOVE_MAX_URL_LENGTH = 512;
/** 送出前等連線開起來最多多久（毫秒） */
export const DEFAULT_RELAY_MOVE_CONNECT_MS = 10_000;
const FILE_WRAP_KIND = 1060;
const GIFT_WRAP_KIND = 1059;
/** `wss://`／`ws://`、有主機、不含帳密與 fragment、不超過長度上限 */
export function isRelayMoveUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > RELAY_MOVE_MAX_URL_LENGTH)
        return false;
    try {
        const url = new URL(value);
        return (url.protocol === 'wss:' || url.protocol === 'ws:') && url.host !== '' && url.username === '' && url.password === '' && url.hash === '';
    }
    catch {
        return false;
    }
}
/** 比對用的正規化：協定與主機小寫（`URL` 已經做了）、去掉結尾斜線 */
function normalized(url) {
    try {
        return new URL(url).toString().replace(/\/+$/, '');
    }
    catch {
        return url;
    }
}
/** 兩個中繼網址是不是同一座（協定與主機不分大小寫、結尾斜線不計；路徑分大小寫） */
export function sameRelayUrl(a, b) {
    return normalized(a) === normalized(b);
}
function outerKindOf(kind) {
    if (kind === undefined)
        return FILE_WRAP_KIND;
    if (kind !== GIFT_WRAP_KIND && kind !== FILE_WRAP_KIND)
        throw new RangeError(`搬家通知的外層 kind 只能是 1059 或 1060（收到 ${String(kind)}）`);
    return kind;
}
/** 把一則搬家通知包成給每位收件人的事件（與名單同步同一種封裝） */
export function buildRelayMoveEvents(move, signer, recipients, opts = {}) {
    if (!isRelayMoveUrl(move.from) || !isRelayMoveUrl(move.to))
        throw new Error('搬家通知的網址必須是 wss:// 或 ws:// 的中繼網址');
    if (sameRelayUrl(move.from, move.to))
        throw new Error('搬家通知的新舊網址相同');
    if (!Number.isFinite(move.at) || move.at <= 0)
        throw new Error('搬家通知的時間不對');
    const kind = outerKindOf(opts.outerKind);
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    const content = JSON.stringify({ v: 1, from: move.from, to: move.to, at: Math.floor(move.at), ...(move.device ? { device: move.device } : {}) });
    const expiration = String(nowSec + (opts.ttlSeconds ?? DEFAULT_RELAY_MOVE_TTL_SECONDS));
    return recipients.map((to) => sealAndWrap({ kind: VAULT_RELAY_MOVE_KIND, created_at: nowSec, tags: [], content }, signer, to, {
        kind,
        tags: [
            ['p', to],
            ['expiration', expiration],
        ],
    }));
}
/**
 * 解開搬家通知；不是搬家通知、解不開、格式不對、外層不是 `outerKind`（預設 1060）回 null。
 * 不驗寄件人是否為成員——那是收方的事（`NostrRosterSync` 會驗）。
 */
export function openRelayMoveEvent(event, signer, opts = {}) {
    if (event.kind !== outerKindOf(opts.outerKind))
        return null;
    try {
        const opened = openWrap(event, signer);
        if (opened.rumor.kind !== VAULT_RELAY_MOVE_KIND)
            return null;
        const body = JSON.parse(opened.rumor.content);
        if (body.v !== 1 || !isRelayMoveUrl(body.from) || !isRelayMoveUrl(body.to) || sameRelayUrl(body.from, body.to))
            return null;
        if (typeof body.at !== 'number' || !Number.isFinite(body.at) || body.at <= 0)
            return null;
        const device = typeof body.device === 'string' && body.device.length <= 64 ? body.device : undefined;
        return { from: body.from, to: body.to, at: body.at, ...(device ? { device } : {}), sender: opened.sender };
    }
    catch {
        return null;
    }
}
/**
 * 把搬家通知送到指定的中繼（SDK ADR 0052）。收件人是名單上**目前有效**的每一台（含自己）；被撤銷的不在裡面。
 * 回傳哪幾座收下了全部收件人的那一顆——呼叫端據此決定要不要部署（「至少一座收下才部署」）。
 * 這台已經不在名單上（被撤銷）時丟例外。
 */
export async function announceRelayMove(opts) {
    const { membership } = opts;
    if (!membership.active)
        throw new Error('這台裝置已不在名單上，不能送搬家通知');
    const relays = [...new Set(opts.relays)];
    const recipients = membership.devices().map((device) => device.pubkey);
    const now = (opts.now ?? Date.now)();
    const move = {
        from: opts.move.from,
        to: opts.move.to,
        at: opts.move.at ?? now,
        ...((opts.move.device ?? membership.selfDevice?.deviceId) ? { device: opts.move.device ?? membership.selfDevice.deviceId } : {}),
    };
    const events = buildRelayMoveEvents(move, opts.signer, recipients, {
        now,
        ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
        ...(opts.outerKind !== undefined ? { outerKind: opts.outerKind } : {}),
    });
    if (relays.length === 0)
        return { accepted: [], failed: [], recipients: recipients.length };
    const connection = opts.connect(relays);
    try {
        await waitOpen(connection, relays, opts.connectTimeoutMs ?? DEFAULT_RELAY_MOVE_CONNECT_MS);
        const results = [];
        for (const event of events)
            results.push(await connection.publish(event));
        const accepted = relays.filter((url) => results.every((result) => result.accepted.some((u) => sameRelayUrl(u, url))));
        return { accepted, failed: relays.filter((url) => !accepted.includes(url)), recipients: recipients.length };
    }
    finally {
        connection.close();
    }
}
/** 等每一座都開起來（或逾時）。沒有狀態介面的連線不等 */
function waitOpen(connection, relays, timeoutMs) {
    const status = connection.status?.bind(connection);
    const onChange = connection.onStatusChange?.bind(connection);
    if (!status || !onChange)
        return Promise.resolve();
    const allOpen = () => relays.every((url) => status().get(url) === 'open');
    if (allOpen())
        return Promise.resolve();
    return new Promise((resolve) => {
        let off = () => undefined;
        const timer = setTimeout(done, timeoutMs);
        function done() {
            clearTimeout(timer);
            off();
            resolve();
        }
        off = onChange(() => {
            if (allOpen())
                done();
        });
    });
}
/**
 * 新網址真的連得上嗎（SDK ADR 0052 的「切換前先測試」）：讀它的 NIP-11（`Accept: application/nostr+json`），
 * 回 200 的 JSON 物件、而且不是唯讀寬限期中的路徑才算。僅限車道的中繼對還沒部署上去的路徑回 404——部署失敗時不會有人切換。
 * 任何錯誤都回 false（下一輪再試）。
 */
export async function probeRelayEndpoint(url, fetch) {
    try {
        const http = new URL(url);
        if (http.protocol === 'wss:')
            http.protocol = 'https:';
        else if (http.protocol === 'ws:')
            http.protocol = 'http:';
        else
            return false;
        const response = await fetch(http.toString(), { method: 'GET', headers: { Accept: 'application/nostr+json' } });
        if (response.status !== 200)
            return false;
        const doc = JSON.parse(await response.text());
        if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
            return false;
        return doc.cinder_read_only_until === undefined;
    }
    catch {
        return false;
    }
}
/**
 * 依收到的搬家通知決定新的中繼清單（SDK ADR 0052）。純邏輯＋`probe`，不改任何狀態：
 * - 只**替換**清單裡已經有的舊網址（原地、保持順序），不新增；新網址已經在清單裡就只拿掉舊的（去重）。
 * - 同一個舊網址有好幾則：從最新的開始試，第一個 `probe` 成功的採用；都不成功就不動（部署失敗、還沒上線）。
 * - 備援清單同理；新網址已經在主清單時從備援拿掉（兩份不重複）。
 * - 連鎖（A→B 之後 B→C）最多跟 `maxHops` 層。
 */
export async function planRelayMoves(opts) {
    let primary = [...opts.primary];
    let standby = [...(opts.standby ?? [])];
    const applied = [];
    const probed = new Map();
    const probe = (url) => {
        const key = normalized(url);
        let result = probed.get(key);
        if (!result) {
            result = opts.probe(url).catch(() => false);
            probed.set(key, result);
        }
        return result;
    };
    const maxHops = opts.maxHops ?? 4;
    for (let hop = 0; hop < maxHops; hop += 1) {
        let changed = false;
        for (const current of [...primary, ...standby]) {
            const candidates = opts.moves
                .filter((move) => sameRelayUrl(move.from, current) && !sameRelayUrl(move.to, current))
                .sort((a, b) => b.at - a.at);
            for (const move of candidates) {
                if (!(await probe(move.to)))
                    continue;
                const replace = (list) => dedupe(list.map((url) => (sameRelayUrl(url, current) ? move.to : url)));
                primary = replace(primary);
                standby = replace(standby).filter((url) => !primary.some((p) => sameRelayUrl(p, url)));
                applied.push({ from: current, to: move.to });
                changed = true;
                break;
            }
        }
        if (!changed)
            break;
    }
    return { primary, standby, applied };
}
function dedupe(list) {
    const out = [];
    for (const url of list)
        if (!out.some((u) => sameRelayUrl(u, url)))
            out.push(url);
    return out;
}
//# sourceMappingURL=relay-move.js.map