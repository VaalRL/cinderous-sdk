// FCM HTTP v1 送出層（SDK ADR 0049 §11.1 裁示 5；Workers 版與 Node 版共用）：服務帳號 JWT（RS256，WebCrypto）換 OAuth access token，
// 再 `POST /v1/projects/<id>/messages:send`。Android 是高優先空資料訊息；iOS 經 FCM 轉給 APNs（一般推播＋mutable-content；
// 只在 `PUSH_IOS=fcm` 時，Workers 版已棄用、建議直連 APNs——SDK ADR 0061）。
// 🔴 服務帳號只從環境變數／Worker secret 讀（`FCM_SERVICE_ACCOUNT`，整份 JSON）；錯誤只回代碼，不帶回應本文、token 或憑證。
import {} from './core.js';
import { importRs256Key, signJwt } from './jwt.js';
import { androidFcmMessage, DEFAULT_PUSH_IOS_LOC_KEY, iosFcmMessage } from './payload.js';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SEND_ORIGIN = 'https://fcm.googleapis.com';
/**
 * 解析服務帳號 JSON（Firebase 主控台 → 專案設定 → 服務帳號 → 產生新的私密金鑰）。
 * 🔴 錯誤訊息不含任何內容（`JSON.parse` 的錯誤會引用原文片段，所以不轉出它）。
 */
export function parseFcmServiceAccount(raw) {
    let obj;
    try {
        obj = JSON.parse(raw);
    }
    catch {
        throw new Error('FCM_SERVICE_ACCOUNT 不是 JSON（要放整份服務帳號 JSON）');
    }
    const o = obj;
    if (typeof o !== 'object' || o === null || o.type !== 'service_account')
        throw new Error('FCM_SERVICE_ACCOUNT 不是服務帳號 JSON（type 要是 service_account）');
    if (typeof o.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(o.project_id))
        throw new Error('FCM_SERVICE_ACCOUNT 缺少 project_id');
    if (typeof o.client_email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(o.client_email))
        throw new Error('FCM_SERVICE_ACCOUNT 缺少 client_email');
    if (typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY'))
        throw new Error('FCM_SERVICE_ACCOUNT 缺少 private_key');
    if (o.token_uri !== undefined && o.token_uri !== GOOGLE_TOKEN_URL)
        throw new Error(`FCM_SERVICE_ACCOUNT 的 token_uri 只接受 ${GOOGLE_TOKEN_URL}`);
    return {
        projectId: o.project_id,
        clientEmail: o.client_email,
        privateKeyPem: o.private_key,
        ...(typeof o.private_key_id === 'string' && /^[0-9a-f]{8,64}$/.test(o.private_key_id) ? { privateKeyId: o.private_key_id } : {}),
    };
}
/** OAuth access token 在到期前多久就換新的（秒） */
const TOKEN_REFRESH_MARGIN_SEC = 300;
export class FcmSender {
    #o;
    #fetch;
    #now;
    #key;
    #token;
    #pendingToken;
    constructor(opts) {
        this.#o = opts;
        this.#fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
        this.#now = opts.now ?? Date.now;
    }
    /** 啟動時先匯入私鑰（壞掉就早點失敗） */
    async ready() {
        await this.#cryptoKey();
    }
    #cryptoKey() {
        this.#key ??= importRs256Key(this.#o.account.privateKeyPem, 'FCM_SERVICE_ACCOUNT 的 private_key');
        return this.#key;
    }
    async #accessToken() {
        const nowSec = Math.floor(this.#now() / 1000);
        if (this.#token && this.#token.expiresAt - TOKEN_REFRESH_MARGIN_SEC > nowSec)
            return this.#token.value;
        this.#pendingToken ??= (async () => {
            try {
                const account = this.#o.account;
                const assertion = await signJwt(await this.#cryptoKey(), { alg: 'RS256', typ: 'JWT', ...(account.privateKeyId ? { kid: account.privateKeyId } : {}) }, { iss: account.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
                const res = await this.#fetch(GOOGLE_TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
                });
                if (!res.ok)
                    throw new Error(`oauth-${res.status}`);
                const body = (await res.json());
                if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number')
                    throw new Error('oauth-invalid');
                this.#token = { value: body.access_token, expiresAt: nowSec + body.expires_in };
                return body.access_token;
            }
            finally {
                this.#pendingToken = undefined;
            }
        })();
        return this.#pendingToken;
    }
    async send(delivery) {
        if (delivery.tokenType !== 'fcm')
            return { status: 'error', code: 'wrong-token-type' };
        const nowSec = Math.floor(this.#now() / 1000);
        const body = delivery.platform === 'android'
            ? androidFcmMessage(delivery.token)
            : iosFcmMessage(delivery.token, this.#o.iosLocKey ?? DEFAULT_PUSH_IOS_LOC_KEY, delivery.ref, nowSec);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let token;
            try {
                token = await this.#accessToken();
            }
            catch (error) {
                const code = error instanceof Error && /^oauth-[\w-]+$/.test(error.message) ? error.message : 'oauth';
                return { status: 'error', code };
            }
            let res;
            try {
                res = await this.#fetch(`${FCM_SEND_ORIGIN}/v1/projects/${encodeURIComponent(this.#o.account.projectId)}/messages:send`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            }
            catch {
                return { status: 'error', code: 'network' };
            }
            if (res.ok)
                return { status: 'ok' };
            if ((res.status === 401 || res.status === 403) && attempt === 0) {
                this.#token = undefined; // access token 失效：換一把再試一次
                continue;
            }
            return fcmResultOf(res.status, await errorCodeOf(res), res.headers.get('retry-after'));
        }
        return { status: 'error', code: 'auth' };
    }
}
/** 只取 FCM 錯誤的 `errorCode`（例如 UNREGISTERED），不保留其他內容 */
async function errorCodeOf(res) {
    try {
        const body = (await res.json());
        const code = body.error?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode;
        return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : undefined;
    }
    catch {
        return undefined;
    }
}
/** FCM 的狀態碼與 errorCode → 送出結果 */
export function fcmResultOf(status, errorCode, retryAfter) {
    if (errorCode === 'UNREGISTERED' || status === 404)
        return { status: 'gone' };
    if (status === 429 || errorCode === 'QUOTA_EXCEEDED' || status === 503 || status === 500) {
        const sec = retryAfter && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 60;
        return { status: 'retry', retryAfterSec: sec };
    }
    if (status === 401 || status === 403)
        return { status: 'error', code: 'auth' };
    return { status: 'error', code: errorCode ? errorCode.toLowerCase() : `http-${status}` };
}
//# sourceMappingURL=fcm.js.map