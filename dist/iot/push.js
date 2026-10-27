// IoT 推播的協定層（SDK ADR 0049 §11、§11.1 使用者裁示；沿用 Cinderous ADR-0272 與 SDK ADR 0011 §6）。中立、零 Node。
//
// 模型（裁示 3）：**client 自帶推播端點、憑證只在 App 開發者的推播閘道、誰知道端點誰就送**。
// - 推播端點兩種（裁示 6：UnifiedPush 與 FCM 同等）：
//   - `unifiedpush`：UnifiedPush／ntfy 網址（RFC 8030：送出端直接 POST 一則**沒有內容**的推播）；
//   - `gateway`：推播閘道網址＋以推播閘道公鑰加密的 token 封包（`sealed`，內含 FCM／APNs token 與「每次登記獨有密鑰」）
//     ＋那把密鑰（`key`）。送出端看不到 token，只能以密鑰對喚醒請求做 HMAC 簽章；推播閘道解封、驗簽、防重放、限速後才送。
// - 訂閱＝設備盲化 id（`dv`）清單＋每個訂閱的 `mode`（`standard` 預設／`instant`，裁示 2）；額度預警是特殊項目，只有 owner 能訂閱（裁示 1）。
// - 喚醒請求一律是空的：不含設備、內容、類別（裁示 3）。給推播閘道的請求只有封包、時間戳、簽章，以及（選用）iOS NSE 要回中繼取的
//   不透明事件 id（`ref`，只能是 64 位 hex；Android 與 UnifiedPush 一律不帶）。
// - 登記以加密指令送到保留 topic `$sys/push`（外層照常加密給全家；端點本身再以 NIP-44 加密給送出端，其他成員讀不到）。
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { generateSecretKey, getPublicKey } from '../protocol/keys.js';
import { conversationKey, encryptWithKey } from '../protocol/nip44.js';
import { iotPubkeyOf } from './acl.js';
import { IOT_BLIND_LENGTH } from './keys.js';
/** 推播協定版本（封包與喚醒請求的 `v`） */
export const IOT_PUSH_VERSION = 1;
/**
 * 推播的上限（裁示 7）。送出端（閘道、設備、日後的中繼）用前四項；推播閘道用後三項。
 * - `maxEndpoints`：每個家庭最多幾個推播端點（對齊 `ROSTER_MAX_DEVICES` 的 32）；
 * - `standardPerMinute`：標準模式每個端點每分鐘最多幾次（ADR-0272：60 秒合併）；
 * - `instantPerMinute`：即時模式每個端點每分鐘最多幾次（含標準）；
 * - `registrationTtlSec`：登記的存活（ADR-0272：30 天，啟動時續期）；
 * - `gatewayTokenPerHour`／`gatewayTokenPerMinute`：推播閘道每個 token 的上限（每分鐘的上限＝即時模式的上限，縱深防禦）；
 * - `gatewayMaxSkewSec`：推播閘道接受的時間戳誤差。
 */
export const IOT_PUSH_LIMITS = {
    maxEndpoints: { default: 32, min: 1, max: 256 },
    standardPerMinute: { default: 1, min: 1, max: 6 },
    instantPerMinute: { default: 6, min: 1, max: 30 },
    registrationTtlSec: { default: 30 * 86_400, min: 3_600, max: 30 * 86_400 },
    gatewayTokenPerHour: { default: 60, min: 1, max: 3_600 },
    gatewayTokenPerMinute: { default: 6, min: 1, max: 60 },
    gatewayMaxSkewSec: { default: 300, min: 30, max: 3_600 },
};
/**
 * 補上預設值並檢查範圍。`strict`（設定檔用）＝超出範圍丟例外；否則夾進範圍（程式內的選項）。
 */
export function iotPushLimits(input = {}, opts = {}) {
    const out = {};
    for (const key of Object.keys(IOT_PUSH_LIMITS)) {
        const spec = IOT_PUSH_LIMITS[key];
        const value = input[key];
        if (value === undefined) {
            out[key] = spec.default;
            continue;
        }
        if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
            if (opts.strict)
                throw new RangeError(`${key} 必須是 ${spec.min}–${spec.max} 的整數（收到 ${String(value)}）`);
            out[key] = Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, Math.floor(value))) : spec.default;
            continue;
        }
        out[key] = value;
    }
    return out;
}
/** 標準模式的抖動上限（毫秒）：ADR-0272 的 0–30 秒 */
export const IOT_PUSH_STANDARD_JITTER_MS = 30_000;
/** 即時模式的抖動上限（毫秒）：裁示 2 的 0–2 秒 */
export const IOT_PUSH_INSTANT_JITTER_MS = 2_000;
/** 推播的投遞存活（秒）：FCM `android.ttl`、APNs `apns-expiration`、UnifiedPush `TTL`；喚醒晚一小時以上就沒有意義 */
export const IOT_PUSH_DELIVERY_TTL_SEC = 3_600;
export const IOT_PUSH_URL_MAX = 2_048;
export const IOT_PUSH_SEALED_MAX = 4_096;
const SEALED_PREFIX = 'cp1';
const SEALED_PATTERN = /^cp1\.[0-9a-f]{64}\.[A-Za-z0-9+/]+={0,2}$/;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 區網或本機的主機（明文 http 只允許這些，例如家裡自架的 ntfy） */
export function isPrivateIotPushHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || /\.(local|lan|home\.arpa)$/.test(host))
        return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m)
        return /^f[cd][0-9a-f]{2}:/.test(host);
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
function checkUrl(raw, where, allowPrivateHttp) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > IOT_PUSH_URL_MAX)
        throw new RangeError(`${where} 要是 1–${IOT_PUSH_URL_MAX} 字元的網址`);
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new RangeError(`${where} 不是合法的網址`);
    }
    if (url.username !== '' || url.password !== '')
        throw new RangeError(`${where} 不能帶帳號密碼`);
    if (url.protocol === 'https:')
        return raw;
    if (url.protocol === 'http:' && allowPrivateHttp && isPrivateIotPushHost(url.hostname))
        return raw;
    throw new RangeError(`${where} 必須是 https://${allowPrivateHttp ? '（區網主機可以用 http://）' : ''}`);
}
/**
 * 驗證推播端點（不丟出端點內容：網址本身就是能力，不進錯誤訊息）。
 * `allowPrivateHttp`：允許 `http://` 的區網主機（家中橋接器送給家裡的 ntfy）；中繼當送出端時不得開。
 */
export function parseIotPushEndpoint(raw, opts = {}) {
    if (!isObject(raw))
        throw new RangeError('推播端點要是物件');
    const allow = opts.allowPrivateHttp === true;
    if (raw.type === 'unifiedpush') {
        if (Object.keys(raw).some((k) => k !== 'type' && k !== 'url'))
            throw new RangeError('unifiedpush 端點只有 type 與 url');
        return { type: 'unifiedpush', url: checkUrl(raw.url, 'unifiedpush 網址', allow) };
    }
    if (raw.type === 'gateway') {
        if (Object.keys(raw).some((k) => !['type', 'url', 'sealed', 'key'].includes(k)))
            throw new RangeError('gateway 端點只有 type、url、sealed、key');
        const url = checkUrl(raw.url, '推播閘道網址', allow).replace(/\/+$/, '');
        if (typeof raw.sealed !== 'string' || raw.sealed.length > IOT_PUSH_SEALED_MAX || !SEALED_PATTERN.test(raw.sealed))
            throw new RangeError('sealed 不是推播閘道的 token 封包');
        if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key))
            throw new RangeError('key 要是 64 位小寫 hex（每次登記獨有的密鑰）');
        return { type: 'gateway', url, sealed: raw.sealed, key: raw.key };
    }
    throw new RangeError('推播端點的 type 只能是 unifiedpush 或 gateway');
}
const b64id = (bytes) => base64urlnopad.encode(bytes).slice(0, IOT_BLIND_LENGTH);
/** 端點的 id（22 字元）：同一個端點登記兩次是同一筆（更新） */
export function iotPushEndpointId(endpoint) {
    const sealed = endpoint.type === 'gateway' ? endpoint.sealed : '';
    return b64id(sha256(utf8ToBytes(`cinder-push/v1/endpoint\n${endpoint.type}\n${endpoint.url}\n${sealed}`)));
}
/** 封包的登記 id（推播閘道以它防重放與撤銷；22 字元） */
export function iotPushRegId(sealed) {
    return b64id(sha256(utf8ToBytes(sealed)));
}
const FCM_TOKEN = /^[A-Za-z0-9_:-]{20,4096}$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
/** 檢查封包明文的形狀（推播閘道解開後用；不合法回 undefined） */
export function parseIotPushTokenPayload(raw) {
    if (!isObject(raw) || raw.v !== IOT_PUSH_VERSION)
        return undefined;
    if (raw.p !== 'android' && raw.p !== 'ios')
        return undefined;
    if (raw.tt !== 'fcm' && raw.tt !== 'apns')
        return undefined;
    if (raw.p === 'android' && raw.tt !== 'fcm')
        return undefined;
    if (typeof raw.t !== 'string' || !(raw.tt === 'fcm' ? FCM_TOKEN : APNS_TOKEN).test(raw.t))
        return undefined;
    if (typeof raw.k !== 'string' || !KEY_PATTERN.test(raw.k))
        return undefined;
    if (!Number.isSafeInteger(raw.iat) || !Number.isSafeInteger(raw.exp) || raw.exp <= raw.iat)
        return undefined;
    return raw;
}
/**
 * App 端：把推播 token 封給推播閘道（ephemeral secp256k1 × 推播閘道公鑰 → NIP-44 v2），並產生「每次登記獨有密鑰」。
 * 回傳的 `{ sealed, key }` 連同推播閘道網址就是一個 `gateway` 端點。**每登記一個送出端就封一次**（各自的密鑰：
 * 一個送出端外洩，不影響其他送出端的簽章，推播閘道也能逐一撤銷）。
 */
export function sealIotPushToken(gatewayPubkey, input) {
    const recipient = iotPubkeyOf(gatewayPubkey);
    const tokenType = input.tokenType ?? 'fcm';
    if (input.platform !== 'android' && input.platform !== 'ios')
        throw new RangeError('platform 只能是 android 或 ios');
    if (input.platform === 'android' && tokenType !== 'fcm')
        throw new RangeError('Android 只支援 FCM token');
    const token = tokenType === 'apns' ? input.token.trim().toLowerCase() : input.token.trim();
    if (!(tokenType === 'fcm' ? FCM_TOKEN : APNS_TOKEN).test(token))
        throw new RangeError(tokenType === 'fcm' ? 'FCM token 的格式不對' : 'APNs 裝置 token 要是 hex');
    const spec = IOT_PUSH_LIMITS.registrationTtlSec;
    const ttl = input.ttlSec === undefined ? spec.default : Math.min(spec.max, Math.max(spec.min, Math.floor(input.ttlSec)));
    const iat = Math.floor((input.now ?? Date.now()) / 1000);
    const key = bytesToHex(randomBytes(32));
    const payload = { v: 1, p: input.platform, tt: tokenType, t: token, k: key, iat, exp: iat + ttl };
    const ephemeral = generateSecretKey();
    const ciphertext = encryptWithKey(JSON.stringify(payload), conversationKey(ephemeral, recipient));
    return { sealed: `${SEALED_PREFIX}.${getPublicKey(ephemeral)}.${ciphertext}`, key, expiresAt: payload.exp };
}
/** 拆開封包外框（推播閘道用）：`{ epk, ciphertext }`；不是封包回 undefined */
export function splitIotPushSealed(sealed) {
    if (sealed.length > IOT_PUSH_SEALED_MAX || !SEALED_PATTERN.test(sealed))
        return undefined;
    const [, epk, ciphertext] = sealed.split('.');
    return { epk: epk, ciphertext: ciphertext };
}
// ── 喚醒請求（送出端 → 推播閘道／UnifiedPush）──────────────────────────
/** iOS NSE 回中繼取用的不透明事件 id：只能是 Nostr 事件 id（64 位小寫 hex），不能夾帶任何其他東西 */
export const IOT_PUSH_REF_PATTERN = /^[0-9a-f]{64}$/;
/** 要簽的字串：時間戳（毫秒）、`ref`、登記 id；換行分隔 */
export function iotPushWakeMessage(regId, ts, ref) {
    return `cinder-push/v1/wake\n${ts}\n${ref ?? ''}\n${regId}`;
}
export function iotPushRevokeMessage(regId, ts) {
    return `cinder-push/v1/revoke\n${ts}\n${regId}`;
}
/** HMAC-SHA256（hex）：以「每次登記獨有密鑰」簽 */
export function iotPushSign(keyHex, message) {
    return bytesToHex(hmac(sha256, hexToBytes(keyHex), utf8ToBytes(message)));
}
const WAKE_KEYS = new Set(['v', 'sealed', 'ts', 'sig', 'ref']);
/**
 * 喚醒請求一律是空的（裁示 3）：本文只能有 `v`、`sealed`、`ts`、`sig`、選用的 `ref`（64 位 hex）。
 * 多一個欄位（設備、類別、內容、標題）就丟例外——送出端與推播閘道都呼叫它。
 */
export function assertEmptyIotPushWake(body) {
    if (!isObject(body) || Object.keys(body).some((k) => !WAKE_KEYS.has(k)))
        throw new Error('喚醒請求只能帶封包、時間戳、簽章與不透明的事件 id：不得帶設備、內容或類別');
    if (body.v !== IOT_PUSH_VERSION || typeof body.sealed !== 'string' || !Number.isSafeInteger(body.ts) || typeof body.sig !== 'string')
        throw new Error('喚醒請求的格式不對');
    if (body.ref !== undefined && (typeof body.ref !== 'string' || !IOT_PUSH_REF_PATTERN.test(body.ref)))
        throw new Error('ref 只能是 64 位小寫 hex 的事件 id');
}
export function buildIotPushWakeBody(endpoint, wake) {
    const ref = wake.ref !== undefined && IOT_PUSH_REF_PATTERN.test(wake.ref) ? wake.ref : undefined;
    const regId = iotPushRegId(endpoint.sealed);
    const body = { v: 1, sealed: endpoint.sealed, ts: wake.ts, sig: iotPushSign(endpoint.key, iotPushWakeMessage(regId, wake.ts, ref)), ...(ref ? { ref } : {}) };
    assertEmptyIotPushWake(body);
    return body;
}
/** App 端停用推播時：請推播閘道撤銷這個登記（直到封包到期） */
export function buildIotPushRevokeBody(endpoint, ts) {
    return { v: 1, sealed: endpoint.sealed, ts, sig: iotPushSign(endpoint.key, iotPushRevokeMessage(iotPushRegId(endpoint.sealed), ts)) };
}
/**
 * 喚醒請求：
 * - `unifiedpush`：`POST <網址>`，本文**空的**（RFC 8030 §5 沒有內容的推播），`TTL`＋`Urgency: high`；`ref` 不送；
 * - `gateway`：`POST <推播閘道>/v1/wake`，本文 {@link IotPushWakeBody}。
 */
export function buildIotPushRequest(endpoint, wake) {
    if (endpoint.type === 'unifiedpush') {
        return { url: endpoint.url, method: 'POST', headers: { TTL: String(IOT_PUSH_DELIVERY_TTL_SEC), Urgency: 'high' }, body: '' };
    }
    return {
        url: `${endpoint.url.replace(/\/+$/, '')}/v1/wake`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildIotPushWakeBody(endpoint, wake)),
    };
}
/** `Retry-After`（秒數或 HTTP 日期）→ 毫秒；沒有或看不懂回 `fallbackMs` */
export function retryAfterMs(header, nowMs, fallbackMs = 60_000) {
    if (header === null || header === undefined || header.trim() === '')
        return fallbackMs;
    const v = header.trim();
    if (/^\d{1,9}$/.test(v))
        return Number(v) * 1000;
    const at = Date.parse(v);
    return Number.isNaN(at) ? fallbackMs : Math.max(0, at - nowMs);
}
/** HTTP 狀態 → 送出結果（UnifiedPush 與推播閘道共用） */
export function iotPushResultOf(status, retryAfter, nowMs) {
    if (status >= 200 && status < 300)
        return { status: 'ok' };
    if (status === 404 || status === 410)
        return { status: 'gone' };
    if (status === 429 || status === 503)
        return { status: 'retry', retryAfterMs: retryAfterMs(retryAfter, nowMs) };
    return { status: 'error', reason: `http-${status}` };
}
/**
 * 預設的送出函式：以 `fetch` 送 {@link buildIotPushRequest}。錯誤原因只有狀態碼或 `network`／`timeout`——
 * **不含網址**（UnifiedPush 網址本身就是能力，不能進日誌）。
 */
export function fetchIotPushSend(fetchImpl = (...args) => globalThis.fetch(...args), opts = {}) {
    const now = opts.now ?? Date.now;
    return async (endpoint, wake) => {
        const req = buildIotPushRequest(endpoint, wake);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
        try {
            const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal, redirect: 'manual' });
            return iotPushResultOf(res.status, res.headers.get('retry-after'), now());
        }
        catch {
            return { status: 'error', reason: controller.signal.aborted ? 'timeout' : 'network' };
        }
        finally {
            clearTimeout(timer);
        }
    };
}
export const IOT_PUSH_MODES = ['standard', 'instant'];
export const IOT_PUSH_SPECIALS = ['quota'];
/** 一個登記最多幾個訂閱 */
export const IOT_PUSH_MAX_SUBSCRIPTIONS = 64;
const BLIND_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_BLIND_LENGTH}}$`);
/** 驗證訂閱清單：`dv` 是盲化 id、`mode` 預設 standard、不重複 */
export function parseIotPushSubscriptions(raw) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > IOT_PUSH_MAX_SUBSCRIPTIONS)
        throw new RangeError(`訂閱要是 1–${IOT_PUSH_MAX_SUBSCRIPTIONS} 項`);
    const seen = new Set();
    return raw.map((item) => {
        if (!isObject(item))
            throw new RangeError('每個訂閱都要是物件');
        const mode = item.mode ?? 'standard';
        if (!IOT_PUSH_MODES.includes(mode))
            throw new RangeError('mode 只能是 standard 或 instant');
        let sub;
        if (item.dv !== undefined && item.special === undefined) {
            if (typeof item.dv !== 'string' || !BLIND_PATTERN.test(item.dv))
                throw new RangeError('dv 要是設備的盲化 id');
            sub = { dv: item.dv, mode: mode };
        }
        else if (item.special !== undefined && item.dv === undefined) {
            if (!IOT_PUSH_SPECIALS.includes(item.special))
                throw new RangeError('special 只有 quota');
            sub = { special: item.special, mode: mode };
        }
        else {
            throw new RangeError('每個訂閱只能有 dv 或 special 其中一個');
        }
        const key = 'dv' in sub ? `dv:${sub.dv}` : `special:${sub.special}`;
        if (seen.has(key))
            throw new RangeError('訂閱有重複的項目');
        seen.add(key);
        return sub;
    });
}
const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_BLIND_LENGTH}}$`);
/** 驗證 `$sys/push` 的操作內容；不合法丟例外 */
export function parseIotPushOp(payload) {
    let raw;
    try {
        raw = JSON.parse(payload);
    }
    catch {
        throw new RangeError('推播登記要是 JSON');
    }
    if (!isObject(raw))
        throw new RangeError('推播登記要是物件');
    if (raw.op === 'register') {
        if (typeof raw.endpoint !== 'string' || raw.endpoint.length === 0 || raw.endpoint.length > 8_192)
            throw new RangeError('endpoint 要是加密給送出端的字串');
        const subscriptions = parseIotPushSubscriptions(raw.subscriptions);
        if (raw.ttlSec !== undefined && (!Number.isSafeInteger(raw.ttlSec) || raw.ttlSec <= 0))
            throw new RangeError('ttlSec 要是正整數（秒）');
        return { op: 'register', endpoint: raw.endpoint, subscriptions, ...(raw.ttlSec !== undefined ? { ttlSec: raw.ttlSec } : {}) };
    }
    if (raw.op === 'remove') {
        if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id))
            throw new RangeError('remove 要帶端點 id');
        return { op: 'remove', id: raw.id };
    }
    throw new RangeError('推播登記只有 register 與 remove');
}
//# sourceMappingURL=push.js.map