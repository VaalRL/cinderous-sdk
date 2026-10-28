// 一鍵部署到 Cloudflare（PRD 5.3；SDK ADR 0008）。
// 真正的 wrangler 與網路都換成替身：測的是「產出的設定對不對、指令怎麼下、健康檢查怎麼判」。
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type CommandRunner,
  deployCloudflareRelay,
  renderWorkerEntry,
  renderWranglerToml,
  workersDevUrlFrom,
} from '../../src/deploy/cloudflare.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';

const alice = getPublicKey(generateSecretKey());

describe('renderWranglerToml', () => {
  it('Durable Object 名稱、SQLite 遷移與相容日期照 PRD 5.3.3', () => {
    const toml = renderWranglerToml({ name: 'my-relay', main: 'entry.mjs', compatibilityDate: '2026-09-01' });
    expect(toml).toContain('name = "my-relay"');
    expect(toml).toContain('main = "entry.mjs"');
    expect(toml).toContain('compatibility_date = "2026-09-01"');
    expect(toml).toContain('name = "RELAY_ROOM"');
    expect(toml).toContain('class_name = "RelayRoom"');
    expect(toml).toContain('new_sqlite_classes = ["RelayRoom"]');
  });

  it('有白名單才寫 [vars] ALLOWED_PUBKEYS；沒有就不出現', () => {
    expect(renderWranglerToml({ name: 'a', main: 'e.mjs', compatibilityDate: '2026-09-01', allowedPubkeys: [alice] })).toContain(
      `ALLOWED_PUBKEYS = "${alice}"`,
    );
    expect(renderWranglerToml({ name: 'a', main: 'e.mjs', compatibilityDate: '2026-09-01' })).not.toContain('ALLOWED_PUBKEYS');
  });
});

describe('renderWorkerEntry', () => {
  it('注入版號後轉出 SDK 的 Worker 與 RelayRoom（路徑一律正斜線）', () => {
    const entry = renderWorkerEntry({ sdkDistDir: 'C:\\sdk\\dist', version: '0.6.0' });
    expect(entry).toContain('"C:/sdk/dist/relay/version.js"');
    expect(entry).toContain('setRelayVersion("0.6.0")');
    expect(entry).toContain('export { default } from "C:/sdk/dist/relay/worker.js"');
    expect(entry).toContain('export * from "C:/sdk/dist/relay/worker.js"');
  });
});

describe('workersDevUrlFrom', () => {
  it('從 wrangler 的輸出抓出 workers.dev 網址', () => {
    const output = 'Uploaded my-relay (3.2 sec)\nDeployed my-relay triggers (1.1 sec)\n  https://my-relay.someone.workers.dev\nCurrent Version ID: x';
    expect(workersDevUrlFrom(output)).toBe('https://my-relay.someone.workers.dev');
  });

  it('沒有網址 → undefined', () => {
    expect(workersDevUrlFrom('Deployed my-relay triggers')).toBeUndefined();
  });
});

type Call = { cmd: string; args: string[]; env: Record<string, string | undefined> };

function fakeRun(stdout: string, code = 0): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return { code, stdout, stderr: code === 0 ? '' : '✘ [ERROR] Authentication error' };
    },
  };
}

const okFetch = (async () => ({ ok: true, status: 200, text: async () => 'ok' })) as unknown as typeof fetch;

const base = () => ({
  workDir: mkdtempSync(join(tmpdir(), 'cinderous-deploy-')),
  sdkDistDir: '/sdk/dist',
  version: '0.6.0',
  healthRetries: 3,
  healthDelayMs: 0,
});

describe('deployCloudflareRelay', () => {
  it('寫出設定、呼叫 wrangler deploy、健康檢查通過後回傳 wss 端點', async () => {
    const { run, calls } = fakeRun('Deployed\n  https://my-relay.someone.workers.dev\n');
    const opts = base();
    const steps: string[] = [];
    const result = await deployCloudflareRelay({
      ...opts,
      workerName: 'my-relay',
      allowedPubkeys: [npubEncode(alice)],
      apiToken: 'tok',
      accountId: 'acc',
      run,
      fetch: okFetch,
      onProgress: (status) => steps.push(status.step),
    });

    expect(result.relayEndpoint).toBe('wss://my-relay.someone.workers.dev');
    expect(result.httpUrl).toBe('https://my-relay.someone.workers.dev');
    expect(steps).toEqual(['config', 'deploy', 'health', 'done']);

    const toml = readFileSync(join(opts.workDir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain(`ALLOWED_PUBKEYS = "${alice}"`); // npub 已換成 hex
    expect(existsSync(join(opts.workDir, 'entry.mjs'))).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['wrangler@4', 'deploy', '--config', join(opts.workDir, 'wrangler.toml')]);
    // 🔴 帳號要明確帶：wrangler 會快取上一次登入的帳號，部署到錯的帳號不會報錯
    expect(calls[0]!.env.CLOUDFLARE_API_TOKEN).toBe('tok');
    expect(calls[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe('acc');
  });

  it('dryRun：加 --dry-run、不做健康檢查、沒有端點', async () => {
    const { run, calls } = fakeRun('--dry-run: exiting now.');
    const result = await deployCloudflareRelay({ ...base(), dryRun: true, run, fetch: okFetch });
    expect(calls[0]!.args).toContain('--dry-run');
    expect(result.relayEndpoint).toBeUndefined();
  });

  it('wrangler 失敗 → 丟出含 wrangler 錯誤訊息的例外', async () => {
    const { run } = fakeRun('', 1);
    await expect(deployCloudflareRelay({ ...base(), run, fetch: okFetch })).rejects.toThrow(/Authentication error/);
  });

  it('🔴 健康檢查一直不過 → 丟出診斷（附網址與最後的狀態），不能回報成功', async () => {
    const { run } = fakeRun('https://x.someone.workers.dev');
    const badFetch = (async () => ({ ok: false, status: 503, text: async () => 'nope' })) as unknown as typeof fetch;
    await expect(deployCloudflareRelay({ ...base(), run, fetch: badFetch })).rejects.toThrow(
      /https:\/\/x\.someone\.workers\.dev\/healthz.*503/,
    );
  });

  it('健康檢查頭幾次沒過、之後過了 → 成功（新 Worker 要幾秒才上線）', async () => {
    const { run } = fakeRun('https://x.someone.workers.dev');
    let n = 0;
    const flaky = (async () => (++n < 3 ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => 'ok' })) as unknown as typeof fetch;
    const result = await deployCloudflareRelay({ ...base(), run, fetch: flaky });
    expect(result.relayEndpoint).toBe('wss://x.someone.workers.dev');
  });

  it('Worker 名稱不合法 → 部署前就拒絕', async () => {
    const { run, calls } = fakeRun('');
    await expect(deployCloudflareRelay({ ...base(), workerName: 'My Relay!', run })).rejects.toThrow(/名稱/);
    expect(calls).toHaveLength(0);
  });

  it('白名單寫錯 → 部署前就拒絕（不會部署出一座開放中繼）', async () => {
    const { run, calls } = fakeRun('');
    await expect(deployCloudflareRelay({ ...base(), allowedPubkeys: ['npub1壞掉'], run })).rejects.toThrow(/ALLOWED_PUBKEYS/);
    expect(calls).toHaveLength(0);
  });
});

describe('PRD 3.3 的預設值（SDK ADR 0013）', () => {
  it('部署出來的站預設每把公鑰 5 條連線、每 IP 每秒 20 則', () => {
    const toml = renderWranglerToml({ name: 'a', main: 'e.mjs', compatibilityDate: '2026-09-01' });
    expect(toml).toContain('MAX_CONNECTIONS_PER_PUBKEY = "5"');
    expect(toml).toContain('MAX_MESSAGES_PER_SECOND_PER_IP = "20"');
  });
});

describe('deployCloudflareRelay：TURN 的 Token（SDK ADR 0118）', () => {
  it('部署後以 wrangler secret put 上傳，值走 stdin、不在參數與環境變數裡', async () => {
    const calls: (Call & { input?: string })[] = [];
    const run: CommandRunner = async (cmd, args, env, input) => {
      calls.push({ cmd, args, env, ...(input !== undefined ? { input } : {}) });
      return { code: 0, stdout: 'https://my-relay.someone.workers.dev', stderr: '' };
    };
    const opts = base();
    const steps: string[] = [];
    await deployCloudflareRelay({
      ...opts,
      workerName: 'my-relay',
      accountId: 'acc',
      turnKeyId: 'turn-key-1',
      turnApiToken: 'turn-secret-value',
      run,
      fetch: okFetch,
      onProgress: (status) => steps.push(`${status.step} ${status.message}`),
    });
    const configPath = join(opts.workDir, 'wrangler.toml');
    expect(calls.map((c) => c.args)).toEqual([
      ['wrangler@4', 'deploy', '--config', configPath],
      ['wrangler@4', 'secret', 'put', 'TURN_API_TOKEN', '--config', configPath],
    ]);
    expect(calls[1]!.input).toBe('turn-secret-value');
    expect(calls[1]!.env.CLOUDFLARE_ACCOUNT_ID).toBe('acc');
    expect(JSON.stringify(calls.map((c) => [c.args, c.env]))).not.toContain('turn-secret-value');
    expect(steps.join('\n')).not.toContain('turn-secret-value');
    expect(readFileSync(configPath, 'utf8')).toContain('TURN_KEY_ID = "turn-key-1"');
    expect(readFileSync(configPath, 'utf8')).not.toContain('turn-secret-value');
  });

  it('dryRun 不上傳 secret；沒給 Token 也不上傳', async () => {
    const dry = fakeRun('--dry-run: exiting now.');
    await deployCloudflareRelay({ ...base(), dryRun: true, turnKeyId: 'k', turnApiToken: 'turn-secret-value', run: dry.run, fetch: okFetch });
    expect(dry.calls).toHaveLength(1);
    const none = fakeRun('https://x.someone.workers.dev');
    await deployCloudflareRelay({ ...base(), turnKeyId: 'k', run: none.run, fetch: okFetch });
    expect(none.calls).toHaveLength(1);
  });

  it('secret put 失敗 → 丟例外（不回報成功），訊息不含 Token', async () => {
    let n = 0;
    const run: CommandRunner = async () =>
      ++n === 1 ? { code: 0, stdout: 'https://x.someone.workers.dev', stderr: '' } : { code: 1, stdout: '', stderr: '✘ [ERROR] secret failed' };
    const error = await deployCloudflareRelay({ ...base(), turnKeyId: 'k', turnApiToken: 'turn-secret-value', run, fetch: okFetch }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/secret failed/);
    expect((error as Error).message).not.toContain('turn-secret-value');
  });

  it('🔴 有 Token 卻沒有 turnKeyId → 部署前就拒絕', async () => {
    const { run, calls } = fakeRun('');
    await expect(deployCloudflareRelay({ ...base(), turnApiToken: 'turn-secret-value', run })).rejects.toThrow(/turnKeyId/);
    expect(calls).toHaveLength(0);
  });
});
