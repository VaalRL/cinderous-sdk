// Cloudflare OAuth（Authorization Code＋PKCE）輔助函式與部署的 OAuth 憑證（SDK ADR 0021）。全部用假的 HTTP。
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildOAuthAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  deployCloudflareRelayViaApi,
  exchangeOAuthCode,
  type HttpFetch,
  type HttpRequestInit,
  refreshOAuthToken,
} from '../../src/deploy/cloudflare-api/index.js';

const base64Url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function tokenEndpoint(status: number, body: unknown) {
  const calls: { url: string; init: HttpRequestInit }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => JSON.stringify(body) };
  };
  return { http, calls };
}

describe('PKCE', () => {
  it('challenge 是 verifier 的 SHA-256（base64url、無補齊）', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(base64Url(createHash('sha256').update(verifier).digest()));
  });

  it('每次都不同', async () => {
    expect((await createPkcePair()).verifier).not.toBe((await createPkcePair()).verifier);
    expect(createOAuthState()).not.toBe(createOAuthState());
  });
});

describe('buildOAuthAuthorizationUrl', () => {
  it('帶齊 code＋S256 PKCE 所需的參數', () => {
    const url = new URL(
      buildOAuthAuthorizationUrl({
        clientId: 'client-1',
        redirectUri: 'obsidian://cinderous-oauth',
        scopes: ['scope.a', 'offline_access'],
        state: 'st',
        codeChallenge: 'ch',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'obsidian://cinderous-oauth',
      scope: 'scope.a offline_access',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });
});

describe('換 token', () => {
  it('exchangeOAuthCode：表單送 code、verifier、client_id，不送 client secret', async () => {
    const endpoint = tokenEndpoint(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' });
    const tokens = await exchangeOAuthCode({ clientId: 'c', redirectUri: 'obsidian://cb', code: 'the-code', codeVerifier: 'v', fetch: endpoint.http });
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scope: 's' });
    const call = endpoint.calls[0]!;
    expect(call.url).toBe('https://dash.cloudflare.com/oauth2/token');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(call.init.body as string))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'obsidian://cb',
      client_id: 'c',
      code_verifier: 'v',
    });
  });

  it('refreshOAuthToken：grant_type=refresh_token', async () => {
    const endpoint = tokenEndpoint(200, { access_token: 'at2' });
    expect(await refreshOAuthToken({ clientId: 'c', refreshToken: 'rt', fetch: endpoint.http })).toEqual({ accessToken: 'at2' });
    expect(Object.fromEntries(new URLSearchParams(endpoint.calls[0]!.init.body as string))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt',
      client_id: 'c',
    });
  });

  it('invalid_grant → token-invalid；其他錯誤 → api', async () => {
    await expect(
      refreshOAuthToken({ clientId: 'c', refreshToken: 'old', fetch: tokenEndpoint(400, { error: 'invalid_grant' }).http }),
    ).rejects.toMatchObject({ kind: 'token-invalid' });
    await expect(
      refreshOAuthToken({ clientId: 'c', refreshToken: 'x', fetch: tokenEndpoint(400, { error: 'invalid_request' }).http }),
    ).rejects.toMatchObject({ kind: 'api' });
  });
});

describe('以 OAuth access token 部署', () => {
  it('credential: oauth → 不打 /user/tokens/verify（那是 API Token 專用），其餘流程相同', async () => {
    const urls: string[] = [];
    const reply = (result: unknown) => ({ status: 200, text: async () => JSON.stringify({ success: true, errors: [], result }) });
    const http: HttpFetch = async (url, init) => {
      urls.push(`${init.method} ${url}`);
      expect(url.includes('workers.dev') || init.headers.Authorization === 'Bearer oauth-at').toBe(true);
      if (url.endsWith('/tokens/verify')) throw new Error('不該驗證');
      if (url.includes('/accounts?')) return reply([{ id: 'acc1', name: 'A' }]);
      if (url.endsWith('/workers/subdomain')) return reply({ subdomain: 'alice' });
      if (url.endsWith('/workers/scripts')) return reply([]);
      if (url.endsWith('/healthz')) return { status: 200, text: async () => 'ok' };
      return reply({});
    };
    const result = await deployCloudflareRelayViaApi({ apiToken: 'oauth-at', credential: 'oauth', fetch: http, workerName: 'r', healthDelayMs: 0 });
    expect(result.relayEndpoint).toBe('wss://r.alice.workers.dev');
    expect(urls.some((u) => u.includes('tokens/verify'))).toBe(false);
  });
});
