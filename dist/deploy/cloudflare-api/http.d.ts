export declare const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export interface HttpRequestInit {
    method: string;
    headers: Record<string, string>;
    /** multipart 上傳是 `Uint8Array`（Obsidian 的 `requestUrl` 不收 `FormData`，所以 SDK 自己組 multipart 本文）。 */
    body?: string | Uint8Array<ArrayBuffer>;
}
export interface HttpResponseLike {
    status: number;
    text(): Promise<string>;
}
/** 與全域 `fetch` 相容的最小 HTTP 函式。 */
export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;
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
export declare const CLOUDFLARE_ERROR_KINDS: readonly ["token-invalid", "permission", "account-ambiguous", "subdomain-missing", "name-conflict", "quota", "network", "lane-change", "health", "worker-download", "worker-integrity", "api"];
export type CloudflareErrorKind = (typeof CLOUDFLARE_ERROR_KINDS)[number];
export interface CloudflareAccount {
    id: string;
    name: string;
}
export declare class CloudflareApiError extends Error {
    readonly name = "CloudflareApiError";
    readonly kind: CloudflareErrorKind;
    /** HTTP 狀態碼（沒有回應時沒有） */
    readonly status: number | undefined;
    /** Cloudflare 回應裡 `errors[].code` */
    readonly codes: number[];
    /** `account-ambiguous` 時可選的帳號 */
    readonly accounts: CloudflareAccount[] | undefined;
    constructor(kind: CloudflareErrorKind, message: string, extra?: {
        status?: number;
        codes?: number[];
        accounts?: CloudflareAccount[];
        cause?: unknown;
    });
}
/** 依 HTTP 狀態碼與 Cloudflare 錯誤碼分類。 */
export declare function classifyCloudflareError(status: number | undefined, codes: readonly number[]): CloudflareErrorKind;
/** 呼叫一個 API；成功回 `result`，失敗丟 `CloudflareApiError`。 */
export declare function cloudflareRequest<T>(ctx: {
    http: HttpFetch;
    apiToken: string;
    apiBase?: string;
}, method: string, path: string, body?: {
    json: unknown;
} | {
    multipart: Uint8Array<ArrayBuffer>;
    contentType: string;
}): Promise<T>;
/** 預設的 HTTP：全域 `fetch`（Node 20+、瀏覽器）。瀏覽器環境會被 CORS 擋，請注入。 */
export declare const defaultHttp: HttpFetch;
//# sourceMappingURL=http.d.ts.map