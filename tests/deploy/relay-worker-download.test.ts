// 部署時才下載中繼 Worker（SDK ADR 0094）：外掛不必把 117 KB 的 Worker 打包進去，只帶版號與 SHA-256。
// 1. 雜湊與打包好的 Worker 一致（產生器同時寫兩份，忘了重建這裡會失敗）；
// 2. 下載後比對雜湊，不一致就不部署（`worker-integrity`），下載失敗是 `worker-download`；
// 3. 只 import 輕量版（`deployCloudflareRelayWithWorker`、`fetchRelayWorker`）的程式，打包後沒有 Worker 本體。
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  CloudflareApiError,
  deployCloudflareRelayWithWorker,
  fetchRelayWorker,
  type HttpFetch,
  relayWorkerSdkVersion,
  relayWorkerSha256,
  relayWorkerSource,
} from '../../src/deploy/cloudflare-api/index.js';

const URL_ = 'https://example.com/relay-worker-0.0.0.js';

function serve(body: string, status = 200): { fetch: HttpFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return { status, text: async () => body };
    },
  };
}

describe('中繼 Worker 的雜湊（SDK ADR 0094）', () => {
  it('🔴 relayWorkerSha256 是打包好的 Worker（UTF-8）的 SHA-256', () => {
    expect(relayWorkerSha256).toBe(createHash('sha256').update(relayWorkerSource, 'utf8').digest('hex'));
    expect(relayWorkerSdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('fetchRelayWorker', () => {
  it('🔴 下載、比對雜湊相符就回傳原始碼', async () => {
    const http = serve(relayWorkerSource);
    await expect(fetchRelayWorker({ url: URL_, fetch: http.fetch })).resolves.toBe(relayWorkerSource);
    expect(http.calls).toEqual([`GET ${URL_}`]);
  });

  it('🔴 內容被改過（雜湊不符）：worker-integrity，不回傳內容', async () => {
    const http = serve(`${relayWorkerSource}// tampered`);
    const error = await fetchRelayWorker({ url: URL_, fetch: http.fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).kind).toBe('worker-integrity');
  });

  it('可指定別的雜湊（測試或自架的 Worker）', async () => {
    const body = 'export default {};';
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    await expect(fetchRelayWorker({ url: URL_, sha256, fetch: serve(body).fetch })).resolves.toBe(body);
  });

  it('🔴 HTTP 不是 200、或連不上：worker-download', async () => {
    const notFound = await fetchRelayWorker({ url: URL_, fetch: serve('nope', 404).fetch }).catch((e: unknown) => e);
    expect((notFound as CloudflareApiError).kind).toBe('worker-download');
    expect((notFound as CloudflareApiError).status).toBe(404);
    const offline: HttpFetch = async () => {
      throw new Error('offline');
    };
    const down = await fetchRelayWorker({ url: URL_, fetch: offline }).catch((e: unknown) => e);
    expect((down as CloudflareApiError).kind).toBe('worker-download');
  });

  it('只收 https 網址', async () => {
    const error = await fetchRelayWorker({ url: 'http://example.com/w.js', fetch: serve(relayWorkerSource).fetch }).catch((e: unknown) => e);
    expect((error as CloudflareApiError).kind).toBe('worker-download');
  });

  it('兩種新錯誤都有中英疑難排解（SDK ADR 0022 的唯一來源）', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      expect(CLOUDFLARE_TOKEN_SETUP_GUIDE[locale].troubleshooting['worker-download'].fix).not.toBe('');
      expect(CLOUDFLARE_TOKEN_SETUP_GUIDE[locale].troubleshooting['worker-integrity'].fix).not.toBe('');
    }
  });
});

describe('輕量版部署不帶 Worker 本體', () => {
  it('🔴 deployCloudflareRelayWithWorker 一定要給 workerSource（型別上必填）', () => {
    // @ts-expect-error workerSource 必填
    const call = () => deployCloudflareRelayWithWorker({ apiToken: 't' });
    expect(typeof call).toBe('function');
  });

  it('🔴 只 import 輕量版的程式打包之後，沒有 Worker 本體', async () => {
    const entry = fileURLToPath(new URL('../../src/deploy/cloudflare-api/index.ts', import.meta.url));
    const result = await build({
      stdin: {
        contents: `import { deployCloudflareRelayWithWorker, fetchRelayWorker, relayWorkerSha256 } from ${JSON.stringify(entry)};\nconsole.log(deployCloudflareRelayWithWorker, fetchRelayWorker, relayWorkerSha256);`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    const text = result.outputFiles[0]?.text ?? '';
    // Worker 本體裡的 Durable Object 類別名稱只會出現在打包好的 Worker 原始碼字串裡
    expect(text).not.toContain(relayWorkerSource.slice(0, 200));
    expect(text.length).toBeLessThan(relayWorkerSource.length);
  }, 30_000);
});
