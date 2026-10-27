// APNs 直連（SDK ADR 0049 §11.1 裁示 5；SDK ADR 0061：Workers 版也直連）：provider token（JWT ES256，WebCrypto）＋HTTP/2。
// 這個檔中立：JWT、請求內容（`buildApnsRequest`）、回應對照（`apnsResultOf`）與送出流程（`ApnsSender`）由兩版共用，只有傳輸不同——
// Node 版注入 `./iot/push-gateway/node` 的 `http2ApnsTransport`（`node:http2`）；Workers 版用這裡的 `fetchApnsTransport`
// （一般 `fetch()`：Cloudflare 邊緣代為與 APNs 講 HTTP/2，ADR 0049 §11 實測；本機 `wrangler dev` 連不上）。
// 🔴 .p8 金鑰只從環境變數／Worker secret 讀（`APNS_KEY`）；錯誤只回代碼，不帶回應本文、token 或金鑰。
import {} from './core.js';
import { importEs256Key, signJwt } from './jwt.js';
import { DEFAULT_PUSH_IOS_LOC_KEY, iosWakePayload } from './payload.js';
import { IOT_PUSH_DELIVERY_TTL_SEC } from '../push.js';
export const APNS_ORIGINS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
/** 從環境變數讀 APNs 憑證（`APNS_KEY`、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC`、`APNS_ENV`）；錯誤只寫變數名稱 */
export function apnsCredentialsFromEnv(env) {
    const keyPem = env.APNS_KEY;
    if (!keyPem || !keyPem.includes('PRIVATE KEY'))
        throw new Error('缺少 APNS_KEY（.p8 的內容）');
    const keyId = env.APNS_KEY_ID?.trim() ?? '';
    if (!/^[A-Z0-9]{10}$/.test(keyId))
        throw new Error('APNS_KEY_ID 要是 10 字元的 Key ID');
    const teamId = env.APNS_TEAM_ID?.trim() ?? '';
    if (!/^[A-Z0-9]{10}$/.test(teamId))
        throw new Error('APNS_TEAM_ID 要是 10 字元的 Team ID');
    const topic = env.APNS_TOPIC?.trim() ?? '';
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(topic))
        throw new Error('APNS_TOPIC 要是 App 的 bundle id（例如 com.example.app）');
    const environment = env.APNS_ENV?.trim() || 'production';
    if (environment !== 'production' && environment !== 'sandbox')
        throw new Error('APNS_ENV 只能是 production 或 sandbox');
    return { keyPem, keyId, teamId, topic, environment };
}
/** APNs 回應本文最多保留多少字元（只用來取 `reason`） */
const APNS_MAX_RESPONSE_CHARS = 4096;
/**
 * 以 `fetch()` 送 APNs（Workers 版）：Cloudflare 邊緣的子請求會與 APNs 協商 HTTP/2（ADR 0049 §11 實測：6／6 次拿到 APNs 真正的回應）。
 * Node 的 `fetch`（undici）預設只講 HTTP/1.1、APNs 不收，所以 Node 版用 `http2ApnsTransport`。失敗只丟 `network`。
 */
export function fetchApnsTransport(opts = {}) {
    const doFetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    const timeoutMs = opts.timeoutMs ?? 10_000;
    return {
        post: async (origin, path, headers, body) => {
            const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
            let res;
            try {
                res = await doFetch(`${origin}${path}`, { method: 'POST', headers, body, ...(signal ? { signal } : {}) });
            }
            catch {
                throw new Error('network');
            }
            let text = '';
            try {
                text = (await res.text()).slice(0, APNS_MAX_RESPONSE_CHARS);
            }
            catch {
                // 本文讀不到：只看狀態碼
            }
            return { status: res.status, body: text };
        },
    };
}
/**
 * provider token 的重簽間隔（秒）。Apple：同一顆 token 最多用 1 小時，也不要比 20 分鐘更頻繁地換（否則 `TooManyProviderTokenUpdates`）。
 * 取 50 分鐘：在 20–60 分鐘之間，並留 10 分鐘給時鐘誤差。
 */
export const APNS_JWT_REFRESH_SEC = 50 * 60;
/** APNs 裝置 token：hex（目前 64 字元，Apple 保留變長的可能） */
const APNS_DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
/**
 * 組出一則 APNs 請求（純函式；兩版共用）：`POST /3/device/<token>`、`authorization: bearer <provider token>`、
 * 一般推播（`apns-push-type: alert`、高優先 10、到期＝現在＋{@link IOT_PUSH_DELIVERY_TTL_SEC}），本文經 `iosWakePayload` 守門。
 */
export function buildApnsRequest(input) {
    return {
        origin: input.origin ?? APNS_ORIGINS[input.credentials.environment],
        path: `/3/device/${input.deviceToken}`,
        headers: {
            authorization: `bearer ${input.providerToken}`,
            'apns-topic': input.credentials.topic,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(input.nowSec + IOT_PUSH_DELIVERY_TTL_SEC),
            'content-type': 'application/json',
        },
        body: JSON.stringify(iosWakePayload(input.locKey, input.ref)),
    };
}
/** 簽一顆 APNs provider token（ES256；header `alg`／`kid`，claims `iss`＝Team ID、`iat`） */
export function signApnsProviderToken(key, credentials, nowSec) {
    return signJwt(key, { alg: 'ES256', kid: credentials.keyId }, { iss: credentials.teamId, iat: nowSec });
}
export class ApnsSender {
    #o;
    #now;
    #key;
    #jwt;
    #pending;
    constructor(opts) {
        this.#o = opts;
        this.#now = opts.now ?? Date.now;
    }
    async ready() {
        await this.#cryptoKey();
    }
    #cryptoKey() {
        this.#key ??= importEs256Key(this.#o.credentials.keyPem, 'APNS_KEY');
        return this.#key;
    }
    /** 快取中的 provider token；過了重簽間隔才簽新的，同時要的只簽一次 */
    #token() {
        const nowSec = Math.floor(this.#now() / 1000);
        if (this.#jwt && nowSec - this.#jwt.issuedAt < APNS_JWT_REFRESH_SEC)
            return Promise.resolve(this.#jwt.value);
        this.#pending ??= (async () => {
            try {
                const value = await signApnsProviderToken(await this.#cryptoKey(), this.#o.credentials, nowSec);
                this.#jwt = { value, issuedAt: nowSec };
                return value;
            }
            finally {
                this.#pending = undefined;
            }
        })();
        return this.#pending;
    }
    async send(delivery) {
        if (delivery.platform !== 'ios' || delivery.tokenType !== 'apns' || !APNS_DEVICE_TOKEN.test(delivery.token))
            return { status: 'error', code: 'wrong-token-type' };
        const creds = this.#o.credentials;
        const locKey = this.#o.iosLocKey ?? DEFAULT_PUSH_IOS_LOC_KEY;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let token;
            try {
                token = await this.#token();
            }
            catch {
                return { status: 'error', code: 'jwt' };
            }
            const req = buildApnsRequest({
                credentials: creds,
                deviceToken: delivery.token,
                providerToken: token,
                nowSec: Math.floor(this.#now() / 1000),
                locKey,
                ...(delivery.ref !== undefined ? { ref: delivery.ref } : {}),
                ...(this.#o.origin ? { origin: this.#o.origin } : {}),
            });
            let res;
            try {
                res = await this.#o.transport.post(req.origin, req.path, req.headers, req.body);
            }
            catch {
                return { status: 'error', code: 'network' };
            }
            const reason = apnsReasonOf(res.body);
            if (res.status === 403 && reason === 'ExpiredProviderToken' && attempt === 0) {
                // 重簽一次再送；別的請求已經換過（快取裡不是這顆）就直接用新的，不重複簽
                if (this.#jwt?.value === token)
                    this.#jwt = undefined;
                continue;
            }
            return apnsResultOf(res.status, reason);
        }
        return { status: 'error', code: 'auth', apnsReason: 'ExpiredProviderToken' };
    }
}
/**
 * Apple 文件列出的 APNs 錯誤 `reason`（Handling notification responses from APNs；依狀態碼排列）。
 * 推播閘道的日誌只記這些字串，其餘一律 `other`（SDK ADR 0062 §6）——本文是外部輸入，不原樣寫進日誌。
 */
export const APNS_REASONS = [
    // 400
    'BadCollapseId',
    'BadDeviceToken',
    'BadExpirationDate',
    'BadMessageId',
    'BadPriority',
    'BadTopic',
    'DeviceTokenNotForTopic',
    'DuplicateHeaders',
    'IdleTimeout',
    'InvalidPushType',
    'MissingDeviceToken',
    'MissingTopic',
    'PayloadEmpty',
    'TopicDisallowed',
    // 403
    'BadCertificate',
    'BadCertificateEnvironment',
    'BadEnvironmentKeyInToken',
    'ExpiredProviderToken',
    'Forbidden',
    'InvalidProviderToken',
    'MissingProviderToken',
    'UnrelatedKeyIdInToken',
    // 404、405
    'BadPath',
    'MethodNotAllowed',
    // 410
    'ExpiredToken',
    'Unregistered',
    // 413
    'PayloadTooLarge',
    // 429
    'TooManyProviderTokenUpdates',
    'TooManyRequests',
    // 500、503
    'InternalServerError',
    'ServiceUnavailable',
    'Shutdown',
];
const APNS_REASON_SET = new Set(APNS_REASONS);
/** 日誌用的 reason：白名單內原樣、其他（含沒有本文）一律 `other` */
export function apnsReasonCodeOf(reason) {
    return reason !== undefined && APNS_REASON_SET.has(reason) ? reason : 'other';
}
/** APNs 錯誤本文的 `reason`（只取代碼） */
export function apnsReasonOf(body) {
    try {
        const reason = JSON.parse(body).reason;
        return typeof reason === 'string' && /^[A-Za-z]{1,40}$/.test(reason) ? reason : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * APNs 的狀態碼與 reason → 送出結果。非 200 一律帶 `apnsReason`（白名單內的 reason 或 `other`），推播閘道把它寫進日誌、不寫進回應。
 * `403 BadEnvironmentKeyInToken`（金鑰限定 Sandbox 或 Production、與 `APNS_ENV` 不符）單獨給 `key-environment`，其他 403 是 `auth`。
 */
export function apnsResultOf(status, reason) {
    if (status === 200)
        return { status: 'ok' };
    const apnsReason = apnsReasonCodeOf(reason);
    if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')
        return { status: 'gone', apnsReason };
    if (status === 429 || status === 503 || status === 500)
        return { status: 'retry', retryAfterSec: 60, apnsReason };
    if (status === 403)
        return { status: 'error', code: apnsReason === 'BadEnvironmentKeyInToken' ? 'key-environment' : 'auth', apnsReason };
    return { status: 'error', code: apnsReason === 'other' ? `http-${status}` : apnsReason.toLowerCase(), apnsReason };
}
//# sourceMappingURL=apns.js.map