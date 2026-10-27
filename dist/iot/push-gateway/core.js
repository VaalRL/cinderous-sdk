// 參考推播閘道的核心（SDK ADR 0049 §11.1 裁示 3、5、7）：Workers 版與 Node 版共用，中立（只用 fetch 的 Request／Response）。
//
// - FCM／APNs 憑證**只在這裡**（裁示 3）：設備、IoT 閘道、中繼都只拿到「token 封包＋每次登記獨有密鑰」，看不到 token。
// - 收 `POST /v1/wake`：本文一律是空的喚醒（`assertEmptyIotPushWake`）→ 以推播閘道私鑰解封 → 過期拒絕 → 以封包內的密鑰驗 HMAC 簽章
//  （常數時間比較）→ 時間戳在視窗內、且同一個登記嚴格遞增（防重放）→ 撤銷拒絕 → 每個 token 每分鐘／每小時的上限 → 送出。
// - `POST /v1/revoke`：App 停用推播時以同一把密鑰撤銷這個封包（直到它到期）。
// - `GET /v1/info`：推播閘道公鑰與支援的平台（App 依 `ios` 決定封 FCM token 還是 APNs 裝置 token）。
// - 🔴 憑證、token、密鑰、封包內容絕不出現在回應、錯誤訊息或日誌裡；日誌只有結果代碼。
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { getPublicKey, nsecDecode } from '../../protocol/keys.js';
import { conversationKey, decryptWithKey } from '../../protocol/nip44.js';
import { assertEmptyIotPushWake, IOT_PUSH_LIMITS, IOT_PUSH_VERSION, iotPushRegId, iotPushRevokeMessage, iotPushSign, iotPushWakeMessage, parseIotPushTokenPayload, splitIotPushSealed, } from '../push.js';
import { DEFAULT_PUSH_IOS_LOC_KEY, PUSH_IOS_LOC_KEY_PATTERN } from './payload.js';
/** 沒寫 `PUSH_IOS` 時的 iOS 模式（SDK ADR 0062；部署設定器的 `pushGateway.ios` 預設值由測試比對這裡） */
export const DEFAULT_PUSH_GATEWAY_IOS_MODE = 'apns';
export const DEFAULT_PUSH_GATEWAY_LIMITS = {
    tokenPerHour: IOT_PUSH_LIMITS.gatewayTokenPerHour.default,
    tokenPerMinute: IOT_PUSH_LIMITS.gatewayTokenPerMinute.default,
    maxSkewSec: IOT_PUSH_LIMITS.gatewayMaxSkewSec.default,
    maxRegistrationDays: IOT_PUSH_LIMITS.registrationTtlSec.default / 86_400,
};
/** 推播閘道讀的環境變數（Worker 是 secret／vars，Node 是環境變數或 .env） */
export const PUSH_GATEWAY_ENV = {
    key: 'PUSH_GATEWAY_KEY',
    fcmServiceAccount: 'FCM_SERVICE_ACCOUNT',
    apnsKey: 'APNS_KEY',
    apnsKeyId: 'APNS_KEY_ID',
    apnsTeamId: 'APNS_TEAM_ID',
    apnsTopic: 'APNS_TOPIC',
    apnsEnvironment: 'APNS_ENV',
    ios: 'PUSH_IOS',
    android: 'PUSH_ANDROID',
    tokenPerHour: 'PUSH_TOKEN_PER_HOUR',
    tokenPerMinute: 'PUSH_TOKEN_PER_MINUTE',
    maxSkewSec: 'PUSH_MAX_SKEW_SEC',
    maxRegistrationDays: 'PUSH_MAX_REGISTRATION_DAYS',
    iosLocKey: 'PUSH_IOS_LOC_KEY',
};
/** 推播閘道的上限在部署設定器裡的範圍（`DEPLOY_OPTION_SPECS` 的 `pushGateway.*` 引用這裡） */
export const PUSH_GATEWAY_LIMIT_RANGES = {
    tokenPerHour: { ...IOT_PUSH_LIMITS.gatewayTokenPerHour },
    tokenPerMinute: { ...IOT_PUSH_LIMITS.gatewayTokenPerMinute },
    maxSkewSec: { ...IOT_PUSH_LIMITS.gatewayMaxSkewSec },
    maxRegistrationDays: { min: 1, max: 30, default: 30 },
};
/** 64 位 hex 或 nsec → 私鑰位元組 */
function secretKeyOf(raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw))
        return hexToBytes(raw.toLowerCase());
    if (raw.startsWith('nsec1'))
        return nsecDecode(raw);
    throw new RangeError('bad key');
}
function intFromEnv(env, name, range) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '')
        return range.default;
    if (!/^\d{1,9}$/.test(raw.trim()))
        throw new RangeError(`${name} 要是 ${range.min}–${range.max} 的整數`);
    const value = Number(raw.trim());
    if (value < range.min || value > range.max)
        throw new RangeError(`${name} 要是 ${range.min}–${range.max} 的整數`);
    return value;
}
/** 讀 `PUSH_IOS`（沒寫或空白＝`DEFAULT_PUSH_GATEWAY_IOS_MODE`）。Node 版據此決定要不要帶 HTTP/2 傳輸 */
export function pushGatewayIosModeFromEnv(env) {
    const ios = env[PUSH_GATEWAY_ENV.ios]?.trim() || DEFAULT_PUSH_GATEWAY_IOS_MODE;
    if (ios !== 'apns' && ios !== 'fcm' && ios !== 'off')
        throw new Error(`${PUSH_GATEWAY_ENV.ios} 只能是 apns、fcm 或 off`);
    return ios;
}
/**
 * 從環境變數組出設定（不含送出層的憑證：FCM／APNs 憑證由 `fcmCredentialsFromEnv`、`apnsCredentialsFromEnv` 讀）。
 * 🔴 錯誤訊息只寫變數名稱，**不寫值**。
 */
export function pushGatewayConfigFromEnv(env, _host) {
    const rawKey = env[PUSH_GATEWAY_ENV.key];
    if (rawKey === undefined || rawKey.trim() === '')
        throw new Error(`缺少 ${PUSH_GATEWAY_ENV.key}（推播閘道私鑰：64 位 hex 或 nsec；cinderous iot push-keygen 產生）`);
    let secretKey;
    try {
        secretKey = secretKeyOf(rawKey.trim());
        getPublicKey(secretKey);
    }
    catch {
        throw new Error(`${PUSH_GATEWAY_ENV.key} 的格式不對（要 64 位 hex 或 nsec）`);
    }
    const ios = pushGatewayIosModeFromEnv(env);
    const androidRaw = env[PUSH_GATEWAY_ENV.android]?.trim() || '1';
    if (androidRaw !== '1' && androidRaw !== '0')
        throw new Error(`${PUSH_GATEWAY_ENV.android} 只能是 1 或 0`);
    const iosLocKey = env[PUSH_GATEWAY_ENV.iosLocKey]?.trim() || DEFAULT_PUSH_IOS_LOC_KEY;
    if (!PUSH_IOS_LOC_KEY_PATTERN.test(iosLocKey))
        throw new Error(`${PUSH_GATEWAY_ENV.iosLocKey} 只能是大寫英數與底線（在地化鍵，不是文字）`);
    if (androidRaw === '0' && ios === 'off')
        throw new Error('Android 與 iOS 都關了：推播閘道沒有東西可送');
    return {
        secretKey,
        pubkey: getPublicKey(secretKey),
        android: androidRaw === '1',
        ios,
        iosLocKey,
        limits: {
            tokenPerHour: intFromEnv(env, PUSH_GATEWAY_ENV.tokenPerHour, PUSH_GATEWAY_LIMIT_RANGES.tokenPerHour),
            tokenPerMinute: intFromEnv(env, PUSH_GATEWAY_ENV.tokenPerMinute, PUSH_GATEWAY_LIMIT_RANGES.tokenPerMinute),
            maxSkewSec: intFromEnv(env, PUSH_GATEWAY_ENV.maxSkewSec, PUSH_GATEWAY_LIMIT_RANGES.maxSkewSec),
            maxRegistrationDays: intFromEnv(env, PUSH_GATEWAY_ENV.maxRegistrationDays, PUSH_GATEWAY_LIMIT_RANGES.maxRegistrationDays),
        },
    };
}
/** 一個 token 最多記幾個登記（每個送出端一個；撤銷的要留到到期，否則撤銷會失效） */
export const PUSH_MAX_REGS_PER_TOKEN = 256;
function prune(state, nowMs) {
    state.hits = state.hits.filter((t) => t > nowMs - 3_600_000);
    const nowSec = Math.floor(nowMs / 1000);
    for (const [id, reg] of Object.entries(state.regs))
        if (reg.exp <= nowSec)
            delete state.regs[id];
}
function regSlot(state, regId, exp) {
    const existing = state.regs[regId];
    if (existing)
        return existing;
    if (Object.keys(state.regs).length >= PUSH_MAX_REGS_PER_TOKEN) {
        // 先淘汰沒被撤銷、最早到期的；全都是撤銷的就拒絕（撤銷紀錄不能丟）
        const victim = Object.entries(state.regs)
            .filter(([, r]) => !r.revoked)
            .sort((a, b) => a[1].exp - b[1].exp)[0];
        if (!victim)
            return undefined;
        delete state.regs[victim[0]];
    }
    const slot = { last: 0, exp };
    state.regs[regId] = slot;
    return slot;
}
/**
 * 決定這一次喚醒能不能送（並記下）。`floorTs`＝沒見過的登記的時間戳下限（Node 版是啟動時間：重啟後重放不了重啟前的請求）。
 * 時間窗由呼叫端先檢查。
 */
export function admitPushWake(state, req, limits, floorTs = 0) {
    prune(state, req.now);
    const slot = regSlot(state, req.regId, req.exp);
    if (!slot)
        return { verdict: 'busy' };
    if (slot.revoked)
        return { verdict: 'revoked' };
    if (req.ts <= Math.max(slot.last, floorTs))
        return { verdict: 'replay' };
    const minute = state.hits.filter((t) => t > req.now - 60_000);
    if (minute.length >= limits.tokenPerMinute)
        return { verdict: 'rate-limited', retryAfterSec: Math.max(1, Math.ceil((minute[minute.length - limits.tokenPerMinute] + 60_000 - req.now) / 1000)) };
    if (state.hits.length >= limits.tokenPerHour)
        return { verdict: 'rate-limited', retryAfterSec: Math.max(1, Math.ceil((state.hits[state.hits.length - limits.tokenPerHour] + 3_600_000 - req.now) / 1000)) };
    slot.last = req.ts;
    state.hits.push(req.now);
    return { verdict: 'ok' };
}
/** 撤銷一個登記（直到封包到期） */
export function revokePushRegistration(state, req, floorTs = 0) {
    prune(state, req.now);
    const slot = regSlot(state, req.regId, req.exp);
    if (!slot)
        return 'busy';
    if (req.ts <= Math.max(slot.last, floorTs))
        return 'replay';
    slot.last = req.ts;
    slot.revoked = true;
    return 'ok';
}
/** 記憶體版（Node 版、測試）。重啟後：沒見過的登記只收啟動之後的時間戳（重放不了重啟前的請求），撤銷紀錄會遺失（文件註明） */
export function memoryPushGatewayStore(opts = {}) {
    const floor = (opts.now ?? Date.now)();
    const states = new Map();
    const maxTokens = opts.maxTokens ?? 100_000;
    const get = (key) => {
        let state = states.get(key);
        if (!state) {
            if (states.size >= maxTokens) {
                const oldest = states.keys().next().value;
                if (oldest !== undefined)
                    states.delete(oldest);
            }
            states.set(key, (state = { hits: [], regs: {} }));
        }
        return state;
    };
    return {
        admit: async (req, limits) => admitPushWake(get(req.tokenKey), req, limits, floor),
        revoke: async (req) => revokePushRegistration(get(req.tokenKey), req, floor),
        size: () => states.size,
    };
}
/** 喚醒與撤銷請求本文的上限（封包 ≤ 4 KB） */
export const PUSH_GATEWAY_MAX_BODY_BYTES = 8 * 1024;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
/** token 的鍵（速率限制與狀態以它分組；只存雜湊） */
export function pushTokenKey(payload) {
    return base64urlnopad.encode(sha256(utf8ToBytes(`cinder-push/v1/token\n${payload.tt}\n${payload.t}`)));
}
/** 常數時間比較兩個 hex 字串 */
function sameHex(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
async function readBody(request) {
    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > PUSH_GATEWAY_MAX_BODY_BYTES)
        throw new Error('too-large');
    const text = await request.text();
    if (utf8ToBytes(text).length > PUSH_GATEWAY_MAX_BODY_BYTES)
        throw new Error('too-large');
    return JSON.parse(text);
}
/** 以推播閘道私鑰解開封包；解不開或形狀不對回 undefined */
export function openIotPushToken(secretKey, sealed) {
    const parts = splitIotPushSealed(sealed);
    if (!parts)
        return undefined;
    try {
        return parseIotPushTokenPayload(JSON.parse(decryptWithKey(parts.ciphertext, conversationKey(secretKey, parts.epk))));
    }
    catch {
        return undefined;
    }
}
/** 建立推播閘道的 HTTP 處理函式（`(Request) => Response`；Workers 直接用，Node 版轉接） */
export function createPushGatewayHandler(opts) {
    const { config } = opts;
    const now = opts.now ?? Date.now;
    const log = (entry) => {
        try {
            opts.onLog?.(entry);
        }
        catch {
            // 日誌失敗不影響送出
        }
    };
    /** 共同的驗證：本文 → 解封 → 到期 → 簽章 → 時間窗。回傳錯誤回應或驗過的內容 */
    async function verify(request, kind) {
        let body;
        try {
            body = await readBody(request);
        }
        catch (error) {
            return error.message === 'too-large' ? json(413, { error: 'too-large' }) : json(400, { error: 'invalid' });
        }
        try {
            if (kind === 'wake')
                assertEmptyIotPushWake(body);
            else if (typeof body !== 'object' || body === null || Object.keys(body).some((k) => !['v', 'sealed', 'ts', 'sig'].includes(k)) ||
                body.v !== IOT_PUSH_VERSION || typeof body.sealed !== 'string' ||
                !Number.isSafeInteger(body.ts) || typeof body.sig !== 'string')
                throw new Error('invalid');
        }
        catch {
            return json(400, { error: 'invalid' });
        }
        const b = body;
        const payload = openIotPushToken(config.secretKey, b.sealed);
        if (!payload)
            return json(400, { error: 'invalid-token' });
        const nowMs = now();
        const nowSec = Math.floor(nowMs / 1000);
        if (payload.exp <= nowSec)
            return json(410, { error: 'expired' });
        if (payload.exp - payload.iat > config.limits.maxRegistrationDays * 86_400 || payload.iat > nowSec + config.limits.maxSkewSec)
            return json(400, { error: 'ttl-too-long' });
        const regId = iotPushRegId(b.sealed);
        const message = kind === 'wake' ? iotPushWakeMessage(regId, b.ts, b.ref) : iotPushRevokeMessage(regId, b.ts);
        if (!/^[0-9a-f]{64}$/.test(b.sig) || !sameHex(iotPushSign(payload.k, message), b.sig))
            return json(401, { error: 'bad-signature' });
        if (Math.abs(b.ts - nowMs) > config.limits.maxSkewSec * 1000)
            return json(400, { error: 'clock-skew' });
        return { payload, regId, ts: b.ts, ...(b.ref !== undefined ? { ref: b.ref } : {}) };
    }
    function senderFor(payload) {
        if (payload.p === 'android')
            return config.android ? opts.senders.fcm : undefined;
        if (payload.tt === 'fcm')
            return config.ios === 'fcm' ? opts.senders.fcm : undefined;
        return config.ios === 'apns' ? opts.senders.apns : undefined;
    }
    async function wake(request) {
        const checked = await verify(request, 'wake');
        if (checked instanceof Response) {
            log({ event: 'wake', result: `rejected-${checked.status}` });
            return checked;
        }
        const { payload, regId, ts } = checked;
        const platform = payload.p;
        const sender = senderFor(payload);
        if (!sender) {
            log({ event: 'wake', result: 'platform-disabled', platform });
            return json(501, { error: 'platform-disabled' });
        }
        const verdict = await opts.store.admit({ tokenKey: pushTokenKey(payload), regId, ts, exp: payload.exp, now: now() }, config.limits);
        if (verdict.verdict !== 'ok') {
            log({ event: 'wake', result: verdict.verdict, platform });
            if (verdict.verdict === 'rate-limited')
                return json(429, { error: 'rate-limited' }, { 'Retry-After': String(verdict.retryAfterSec) });
            if (verdict.verdict === 'revoked')
                return json(410, { error: 'revoked' });
            if (verdict.verdict === 'busy')
                return json(503, { error: 'busy' }, { 'Retry-After': '60' });
            return json(409, { error: 'replay' });
        }
        // Android 一律不帶 ref（ADR-0272：Android 是空喚醒）
        const ref = platform === 'ios' ? checked.ref : undefined;
        let result;
        try {
            result = await sender.send({ platform, tokenType: payload.tt, token: payload.t, ...(ref !== undefined ? { ref } : {}) });
        }
        catch {
            result = { status: 'error', code: 'sender-threw' };
        }
        // apnsReason 只進日誌（維運者看），不進回應（送出端不需要、也不該知道推播閘道的憑證狀態）；再以字元集守一次門
        const apnsReason = result.status !== 'ok' && typeof result.apnsReason === 'string' && /^[A-Za-z]{1,40}$/.test(result.apnsReason) ? result.apnsReason : undefined;
        log({ event: 'wake', result: result.status === 'error' ? `error-${result.code}` : result.status, platform, ...(apnsReason ? { apnsReason } : {}) });
        switch (result.status) {
            case 'ok':
                return json(202, { ok: true });
            case 'gone':
                return json(410, { error: 'unregistered' });
            case 'retry':
                return json(503, { error: 'upstream-busy' }, { 'Retry-After': String(Math.max(1, Math.ceil(result.retryAfterSec))) });
            default:
                return json(502, { error: 'upstream' });
        }
    }
    async function revoke(request) {
        const checked = await verify(request, 'revoke');
        if (checked instanceof Response) {
            log({ event: 'revoke', result: `rejected-${checked.status}` });
            return checked;
        }
        const outcome = await opts.store.revoke({ tokenKey: pushTokenKey(checked.payload), regId: checked.regId, ts: checked.ts, exp: checked.payload.exp, now: now() });
        log({ event: 'revoke', result: outcome, platform: checked.payload.p });
        if (outcome === 'replay')
            return json(409, { error: 'replay' });
        if (outcome === 'busy')
            return json(503, { error: 'busy' }, { 'Retry-After': '60' });
        return json(200, { ok: true });
    }
    const info = {
        v: IOT_PUSH_VERSION,
        pubkey: config.pubkey,
        android: config.android,
        ios: config.ios,
        maxRegistrationDays: config.limits.maxRegistrationDays,
        limits: { tokenPerHour: config.limits.tokenPerHour, tokenPerMinute: config.limits.tokenPerMinute },
    };
    return async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === '/healthz')
            return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
        if (request.method === 'GET' && path === '/v1/info')
            return json(200, info, { 'Access-Control-Allow-Origin': '*' });
        if (path === '/v1/wake' || path === '/v1/revoke') {
            if (request.method !== 'POST')
                return json(405, { error: 'method-not-allowed' }, { Allow: 'POST' });
            return path === '/v1/wake' ? wake(request) : revoke(request);
        }
        return json(404, { error: 'not-found' });
    };
}
//# sourceMappingURL=core.js.map