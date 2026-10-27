import { type CloudflareAccount, type HttpFetch } from './http.js';
export interface TokenPermission {
    /** 官方文件〈Permission reference〉裡的 key */
    key: string;
    type: 'read' | 'edit';
    /** 給 UI 顯示的儀表板名稱 */
    label: string;
}
/**
 * 部署中繼需要的最小權限：
 * - Workers Scripts：Edit —— 上傳 Worker、Durable Object 遷移、workers.dev 子網域與路由
 * - Account Settings：Read —— 列出帳號（沒指定帳號時讓使用者選）
 */
export declare const REQUIRED_TOKEN_PERMISSIONS: readonly TokenPermission[];
export declare const DEFAULT_TOKEN_NAME = "Cinderous relay deploy";
/**
 * 產生預填權限的 API Token 建立頁網址，交給呼叫端用瀏覽器打開。
 * - `user`（預設）：`/profile/api-tokens`，Token 屬於使用者本人，可用 `/user/tokens/verify` 驗證。
 * - `account`：帳號擁有的 Token（不綁個人）。驗證時要給 `accountId`。
 */
export declare function buildTokenCreationUrl(opts?: {
    name?: string;
    kind?: 'user' | 'account';
}): string;
export interface CloudflareApiAuth {
    apiToken: string;
    /** 注入的 HTTP（Obsidian 用 `requestUrl` 轉接器）；沒給用全域 `fetch` */
    fetch?: HttpFetch;
    /** 測試用 */
    apiBase?: string;
}
export interface TokenStatus {
    id: string;
    status: string;
    expiresOn?: string;
}
/**
 * 驗證 Token：有效且為 `active` 才回傳；否則丟 `CloudflareApiError`（kind `token-invalid`）。
 * 給 `accountId` 時改打帳號 Token 的驗證端點。
 */
export declare function verifyToken(auth: CloudflareApiAuth & {
    accountId?: string;
}): Promise<TokenStatus>;
/** 列出這把 Token 能用的帳號（`GET /accounts`，一頁 50 筆，讀到沒有為止）。 */
export declare function listAccounts(auth: CloudflareApiAuth): Promise<CloudflareAccount[]>;
//# sourceMappingURL=auth.d.ts.map