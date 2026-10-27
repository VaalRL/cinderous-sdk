// 授權的預設做法（SDK ADR 0021）：「開瀏覽器到預填權限的 API Token 建立頁」——使用者在自己的儀表板
// 按「建立」，把 Token 貼回來。不需要任何註冊，SDK 也不必帶 client id。
// （Cloudflare 2026-06 起也開放第三方 OAuth，但 client 要由應用自己註冊；見 oauth.ts。）
//
// 預填網址的格式照官方文件：
// https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
// Token 由呼叫端保存（例如外掛交給自己的 SecretStore）；SDK 不碰儲存。
import { type CloudflareAccount, CloudflareApiError, cloudflareRequest, defaultHttp, type HttpFetch } from './http.js';

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
export const REQUIRED_TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  { key: 'workers_scripts', type: 'edit', label: 'Account → Workers Scripts → Edit' },
  { key: 'account_settings', type: 'read', label: 'Account → Account Settings → Read' },
];

export const DEFAULT_TOKEN_NAME = 'Cinderous relay deploy';

// 官方範例把 `*` 寫成 %2A、空白寫成 %20；encodeURIComponent 不會編 `*`，所以補上。
const encode = (value: string): string => encodeURIComponent(value).replace(/\*/g, '%2A');

/**
 * 產生預填權限的 API Token 建立頁網址，交給呼叫端用瀏覽器打開。
 * - `user`（預設）：`/profile/api-tokens`，Token 屬於使用者本人，可用 `/user/tokens/verify` 驗證。
 * - `account`：帳號擁有的 Token（不綁個人）。驗證時要給 `accountId`。
 */
export function buildTokenCreationUrl(opts: { name?: string; kind?: 'user' | 'account' } = {}): string {
  const permissions = encode(JSON.stringify(REQUIRED_TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }))));
  const name = encode(opts.name ?? DEFAULT_TOKEN_NAME);
  if (opts.kind === 'account') {
    return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${permissions}&name=${name}`;
  }
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${permissions}&accountId=%2A&zoneId=all&name=${name}`;
}

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

const ctxOf = (auth: CloudflareApiAuth) => ({
  http: auth.fetch ?? defaultHttp,
  apiToken: auth.apiToken,
  ...(auth.apiBase ? { apiBase: auth.apiBase } : {}),
});

/**
 * 驗證 Token：有效且為 `active` 才回傳；否則丟 `CloudflareApiError`（kind `token-invalid`）。
 * 給 `accountId` 時改打帳號 Token 的驗證端點。
 */
export async function verifyToken(auth: CloudflareApiAuth & { accountId?: string }): Promise<TokenStatus> {
  if (auth.apiToken.trim() === '') throw new CloudflareApiError('token-invalid', 'Cloudflare API Token 是空的');
  const path = auth.accountId ? `/accounts/${encodeURIComponent(auth.accountId)}/tokens/verify` : '/user/tokens/verify';
  const result = await cloudflareRequest<{ id: string; status: string; expires_on?: string }>(ctxOf(auth), 'GET', path);
  if (result?.status !== 'active') {
    throw new CloudflareApiError('token-invalid', `Cloudflare API Token 無法使用（狀態：${result?.status ?? '未知'}）`);
  }
  return { id: result.id, status: result.status, ...(result.expires_on ? { expiresOn: result.expires_on } : {}) };
}

/** 列出這把 Token 能用的帳號（`GET /accounts`，一頁 50 筆，讀到沒有為止）。 */
export async function listAccounts(auth: CloudflareApiAuth): Promise<CloudflareAccount[]> {
  const accounts: CloudflareAccount[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await cloudflareRequest<{ id: string; name: string }[]>(ctxOf(auth), 'GET', `/accounts?per_page=50&page=${page}`);
    for (const account of batch ?? []) accounts.push({ id: account.id, name: account.name });
    if (!batch || batch.length < 50) break;
  }
  return accounts;
}
