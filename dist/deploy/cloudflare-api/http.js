// Cloudflare REST API v4 的最小客戶端（SDK ADR 0021）：注入式 HTTP、回應解析、錯誤分類。
//
// 🔴 HTTP 一定要能注入：Cloudflare API 不回 CORS 標頭，瀏覽器環境（Obsidian 行動版的 WebView、
// 桌面版的渲染行程）直接 `fetch` 會被擋。Obsidian 外掛要注入 `requestUrl` 的轉接器（見 README）。
// SDK 不依賴 obsidian 套件，只定義下面這個最小介面；全域 `fetch` 本身就相容。
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
/**
 * 錯誤分類，給 UI 決定怎麼提示：
 * - `token-invalid`：Token 錯了、過期或停用 → 請使用者重新建立 Token
 * - `permission`：Token 有效但權限不足 → 提示缺哪些權限（`REQUIRED_TOKEN_PERMISSIONS`）
 * - `account-ambiguous`：Token 能用好幾個帳號、呼叫端沒指定 → 讓使用者選（`error.accounts`）
 * - `subdomain-missing`：帳號還沒有 workers.dev 子網域、呼叫端也沒給 → 請使用者取一個
 * - `name-conflict`：Worker 名稱已被帳號裡另一支不是中繼的 Worker 佔用，或子網域被別人用了
 * - `quota`：超過額度或被限流（Worker 數量、腳本大小、請求速率）
 * - `network`：連不到 Cloudflare
 * - `lane-change`：重新部署時已知租戶名單（`appLanes`）與線上的不同，而呼叫端沒有 `allowLaneChange`（SDK ADR 0036）
 * - `health`：部署完成但站沒通過健康檢查
 * - `worker-download`：部署時下載中繼 Worker 失敗（連不上、HTTP 不是 200、網址不是 https；SDK ADR 0094）
 * - `worker-integrity`：下載到的 Worker 與預期的 SHA-256 不符，不部署（SDK ADR 0094）
 * - `api`：其他 API 錯誤（`codes` 保留 Cloudflare 的原始錯誤碼）
 *
 * 這份清單是唯一來源：型別由它推出，`CLOUDFLARE_TOKEN_SETUP_GUIDE` 的疑難排解也以它為鍵（SDK ADR 0022），
 * 新增一種 kind 卻忘了補說明，typecheck 與測試都會失敗。
 */
export const CLOUDFLARE_ERROR_KINDS = [
    'token-invalid',
    'permission',
    'account-ambiguous',
    'subdomain-missing',
    'name-conflict',
    'quota',
    'network',
    'lane-change',
    'health',
    'worker-download',
    'worker-integrity',
    'api',
];
export class CloudflareApiError extends Error {
    name = 'CloudflareApiError';
    kind;
    /** HTTP 狀態碼（沒有回應時沒有） */
    status;
    /** Cloudflare 回應裡 `errors[].code` */
    codes;
    /** `account-ambiguous` 時可選的帳號 */
    accounts;
    constructor(kind, message, extra = {}) {
        super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
        this.kind = kind;
        this.status = extra.status;
        this.codes = extra.codes ?? [];
        this.accounts = extra.accounts;
    }
}
// 錯誤碼的來源見 ADR 0021〈錯誤分類〉：HTTP 狀態碼是主要依據，錯誤碼只補狀態碼分不出來的情況。
const TOKEN_INVALID_CODES = new Set([1000, 6003, 6111, 9109]);
const PERMISSION_CODES = new Set([10000]);
const QUOTA_CODES = new Set([971, 10027, 10037]);
const NAME_CONFLICT_CODES = new Set([10031]);
/** 依 HTTP 狀態碼與 Cloudflare 錯誤碼分類。 */
export function classifyCloudflareError(status, codes) {
    if (codes.some((code) => TOKEN_INVALID_CODES.has(code)))
        return 'token-invalid';
    if (status === 429 || codes.some((code) => QUOTA_CODES.has(code)))
        return 'quota';
    if (codes.some((code) => NAME_CONFLICT_CODES.has(code)))
        return 'name-conflict';
    if (codes.some((code) => PERMISSION_CODES.has(code)) || status === 403)
        return 'permission';
    if (status === 401)
        return 'token-invalid';
    return 'api';
}
/** 呼叫一個 API；成功回 `result`，失敗丟 `CloudflareApiError`。 */
export async function cloudflareRequest(ctx, method, path, body) {
    const headers = { Authorization: `Bearer ${ctx.apiToken}` };
    let payload;
    if (body && 'json' in body) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body.json);
    }
    else if (body) {
        headers['Content-Type'] = body.contentType;
        payload = body.multipart;
    }
    const url = `${ctx.apiBase ?? CLOUDFLARE_API_BASE}${path}`;
    let response;
    try {
        response = await ctx.http(url, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new CloudflareApiError('network', `連不到 Cloudflare（${method} ${path}）：${reason}`, { cause: error });
    }
    const text = await response.text();
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        envelope = undefined;
    }
    const ok = response.status >= 200 && response.status < 300 && envelope?.success !== false;
    if (ok && envelope)
        return envelope.result;
    const errors = envelope?.errors ?? [];
    const codes = errors.map((e) => e.code).filter((code) => typeof code === 'number');
    const detail = errors.map((e) => `[${e.code ?? '?'}] ${e.message ?? ''}`.trim()).join('；') || text.slice(0, 200);
    throw new CloudflareApiError(classifyCloudflareError(response.status, codes), `Cloudflare API 失敗（${method} ${path}，HTTP ${response.status}）：${detail}`, { status: response.status, codes });
}
/** 預設的 HTTP：全域 `fetch`（Node 20+、瀏覽器）。瀏覽器環境會被 CORS 擋，請注入。 */
export const defaultHttp = (url, init) => fetch(url, init);
//# sourceMappingURL=http.js.map