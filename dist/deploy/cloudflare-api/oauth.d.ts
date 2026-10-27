import { type HttpFetch } from './http.js';
export declare const CLOUDFLARE_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export declare const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
/** 產生 PKCE 的 verifier 與 S256 challenge（RFC 7636）。verifier 由呼叫端暫存到回呼回來為止。 */
export declare function createPkcePair(): Promise<{
    verifier: string;
    challenge: string;
}>;
/** 產生防 CSRF 的 state；回呼時比對。 */
export declare function createOAuthState(): string;
export interface OAuthClientConfig {
    /** 應用自己在 Cloudflare 建立的 public OAuth client */
    clientId: string;
    /** 建立 client 時登記的回呼網址（完全相同） */
    redirectUri: string;
}
/** 授權頁網址：用瀏覽器打開，使用者同意後 Cloudflare 帶 `code` 與 `state` 導回 `redirectUri`。 */
export declare function buildOAuthAuthorizationUrl(opts: OAuthClientConfig & {
    scopes: readonly string[];
    state: string;
    codeChallenge: string;
}): string;
export interface OAuthTokens {
    /** 當成 `apiToken` 傳給部署函式，並設 `credential: 'oauth'` */
    accessToken: string;
    refreshToken?: string;
    /** 秒 */
    expiresIn?: number;
    scope?: string;
}
/** 以回呼帶回的 `code` 換 access token（PKCE，不需要 client secret）。 */
export declare function exchangeOAuthCode(opts: OAuthClientConfig & {
    code: string;
    codeVerifier: string;
    fetch?: HttpFetch;
}): Promise<OAuthTokens>;
/** 用 refresh token 換新的 access token（授權時要請求 `offline_access` 才會拿到 refresh token）。 */
export declare function refreshOAuthToken(opts: {
    clientId: string;
    refreshToken: string;
    fetch?: HttpFetch;
}): Promise<OAuthTokens>;
//# sourceMappingURL=oauth.d.ts.map