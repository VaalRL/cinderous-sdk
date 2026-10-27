// Cloudflare OAuth（Authorization Code＋PKCE）的最小輔助函式（SDK ADR 0021）。
//
// Cloudflare 自 2026-06-03 起開放「自管 OAuth client」：桌面、行動、CLI 這類公開客戶端用 PKCE（S256），
// 不需要 client secret。https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
//
// 🔴 SDK 不附 client id：OAuth client 屬於「應用」（例如某個 Obsidian 外掛），要由應用開發者在自己的
// Cloudflare 帳號建立、驗證網域後設為 public，才能讓任何 Cloudflare 使用者授權。SDK 保持中立（ADR 0019）。
// 沒有自己的 client 時，用 auth.ts 的 API Token 建立頁（不需要任何註冊）。
//
// Scope 名稱要以 `GET /oauth/scopes` 查到的為準（官方文件：scope 名稱對應 API Token 的權限名稱）；
// 部署中繼需要的是 Workers Scripts 寫入與帳號讀取。
import { CloudflareApiError, type HttpFetch, defaultHttp } from './http.js';

export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** 產生 PKCE 的 verifier 與 S256 challenge（RFC 7636）。verifier 由呼叫端暫存到回呼回來為止。 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64Url(random);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
}

/** 產生防 CSRF 的 state；回呼時比對。 */
export function createOAuthState(): string {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return base64Url(random);
}

export interface OAuthClientConfig {
  /** 應用自己在 Cloudflare 建立的 public OAuth client */
  clientId: string;
  /** 建立 client 時登記的回呼網址（完全相同） */
  redirectUri: string;
}

/** 授權頁網址：用瀏覽器打開，使用者同意後 Cloudflare 帶 `code` 與 `state` 導回 `redirectUri`。 */
export function buildOAuthAuthorizationUrl(
  opts: OAuthClientConfig & { scopes: readonly string[]; state: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${CLOUDFLARE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export interface OAuthTokens {
  /** 當成 `apiToken` 傳給部署函式，並設 `credential: 'oauth'` */
  accessToken: string;
  refreshToken?: string;
  /** 秒 */
  expiresIn?: number;
  scope?: string;
}

async function tokenRequest(http: HttpFetch, form: Record<string, string>): Promise<OAuthTokens> {
  let response;
  try {
    response = await http(CLOUDFLARE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new CloudflareApiError('network', `連不到 Cloudflare OAuth：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const text = await response.text();
  let json: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // 下面統一處理
  }
  if (response.status >= 200 && response.status < 300 && json.access_token) {
    return {
      accessToken: json.access_token,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      ...(typeof json.expires_in === 'number' ? { expiresIn: json.expires_in } : {}),
      ...(json.scope ? { scope: json.scope } : {}),
    };
  }
  // RFC 6749 §5.2：invalid_grant＝code 或 refresh token 無效、過期、已用過
  const kind = json.error === 'invalid_grant' || response.status === 401 ? 'token-invalid' : 'api';
  const detail = json.error ? `${json.error}${json.error_description ? `：${json.error_description}` : ''}` : text.slice(0, 200);
  throw new CloudflareApiError(kind, `Cloudflare OAuth 失敗（HTTP ${response.status}）：${detail}`, { status: response.status });
}

/** 以回呼帶回的 `code` 換 access token（PKCE，不需要 client secret）。 */
export function exchangeOAuthCode(
  opts: OAuthClientConfig & { code: string; codeVerifier: string; fetch?: HttpFetch },
): Promise<OAuthTokens> {
  return tokenRequest(opts.fetch ?? defaultHttp, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });
}

/** 用 refresh token 換新的 access token（授權時要請求 `offline_access` 才會拿到 refresh token）。 */
export function refreshOAuthToken(opts: { clientId: string; refreshToken: string; fetch?: HttpFetch }): Promise<OAuthTokens> {
  return tokenRequest(opts.fetch ?? defaultHttp, {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
}
