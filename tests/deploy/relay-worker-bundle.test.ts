// 打包好的中繼 Worker（SDK ADR 0021）：
// 1. 提交的 relay-worker-bundle.ts 必須與原始碼一致（忘了重建，外掛就會部署出舊的中繼）；
// 2. 打包結果真的能跑：以 REST 上傳時的兩個模組（entry.mjs + relay.mjs）原樣載入，
//    `/healthz` 回 ok、NIP-11 帶注入的版號。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { relayWorkerSdkVersion, relayWorkerSource, renderApiWorkerEntry, WORKER_ENTRY_MODULE, WORKER_RELAY_MODULE } from '../../src/deploy/cloudflare-api/index.js';

const scriptUrl = new URL('../../scripts/build-relay-worker-bundle.mjs', import.meta.url).href;
const lf = (text: string) => text.replace(/\r\n/g, '\n');

describe('relay-worker-bundle.ts', () => {
  it('與原始碼一致（不一致請跑 npm run build:worker-bundle）', async () => {
    const script = (await import(scriptUrl)) as { OUTPUT_PATH: string; renderRelayWorkerBundleModule: () => Promise<string> };
    expect(lf(readFileSync(script.OUTPUT_PATH, 'utf8'))).toBe(lf(await script.renderRelayWorkerBundleModule()));
  }, 30_000);

  it('版號與 package.json 相同', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(relayWorkerSdkVersion).toBe(pkg.version);
  });

  it('沒有引用任何外部模組：單檔就能上傳', () => {
    expect(relayWorkerSource).not.toMatch(/\bfrom\s*["'][^"']+["']/);
    expect(relayWorkerSource).not.toMatch(/\bimport\s*\(/);
  });

  it('以上傳時的兩個模組載入：/healthz 回 ok、NIP-11 帶注入的版號、轉出 RelayRoom', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinderous-bundle-'));
    writeFileSync(join(dir, WORKER_ENTRY_MODULE), renderApiWorkerEntry('9.9.9'));
    writeFileSync(join(dir, WORKER_RELAY_MODULE), relayWorkerSource);
    const mod = (await import(pathToFileURL(join(dir, WORKER_ENTRY_MODULE)).href)) as {
      default: { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> };
      RelayRoom: unknown;
    };
    expect(typeof mod.RelayRoom).toBe('function');

    const health = await mod.default.fetch(new Request('https://my-relay.alice.workers.dev/healthz'), {}, {});
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    const info = await mod.default.fetch(
      new Request('https://my-relay.alice.workers.dev/', { headers: { Accept: 'application/nostr+json' } }),
      { RELAY_NAME: 'Alice relay' },
      {},
    );
    const body = (await info.json()) as { name: string; version: string };
    expect(body.version).toBe('9.9.9');
    expect(body.name).toBe('Alice relay');
  });
});
