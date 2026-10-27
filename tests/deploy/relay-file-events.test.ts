// 部署時可以開檔案事件（kind 1060，`MAX_FILE_MB`）（SDK ADR 0027）。Vault 同步的外層就是 1060，
// 沒開的中繼會整類拒收。各部署路徑共用 shared.relayWorkerVars／maxFileMbVar（SSOT）。
import { describe, expect, it } from 'vitest';

import { runCli, type CliDeps } from '../../src/cli/commands.js';
import { relayEnvironment } from '../../src/deploy/container.js';
import { renderWranglerToml } from '../../src/deploy/cloudflare.js';
import { maxFileMbVar, relayWorkerVars, VAULT_SYNC_MAX_FILE_MB } from '../../src/deploy/shared.js';
import { deployCloudflareRelayViaApi } from '../../src/deploy/cloudflare-api/index.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { filePolicyFor } from '../../src/relay/host-config.js';
import { buildRelayInfo } from '../../src/relay/nip11.js';

const alice = getPublicKey(generateSecretKey());

describe('部署：可以開檔案事件（SSOT：relayWorkerVars／relayEnvironment 共用驗證）', () => {
  it('🔴 Worker 環境變數：maxFileMb → MAX_FILE_MB；預設不開', () => {
    expect(relayWorkerVars({ allowedPubkeys: [alice] }).MAX_FILE_MB).toBeUndefined();
    expect(relayWorkerVars({ allowedPubkeys: [alice], maxFileMb: VAULT_SYNC_MAX_FILE_MB }).MAX_FILE_MB).toBe('17');
    expect(renderWranglerToml({ name: 'r', main: 'e.mjs', compatibilityDate: '2026-09-01', allowedPubkeys: [alice], maxFileMb: 17 })).toContain('MAX_FILE_MB = "17"');
    expect(relayEnvironment({ allowedPubkeys: [alice], persist: false, trustProxy: false, maxFileMb: 17 }).MAX_FILE_MB).toBe('17');
  });

  it('🔴 開放中繼（沒有白名單）開檔案事件 → 部署前就拒絕，除非明確 openFileRelay', () => {
    expect(() => relayWorkerVars({ maxFileMb: 17 })).toThrow('白名單');
    expect(() => relayEnvironment({ persist: false, trustProxy: false, maxFileMb: 17 })).toThrow('白名單');
    expect(relayWorkerVars({ maxFileMb: 17, openFileRelay: true }).MAX_FILE_MB).toBe('17');
  });

  it('🔴 自架單人中繼沒有車道：部署出的站不帶 FILE_LANES ⇒ MAX_FILE_MB 是全站開關、NIP-11 不宣告單檔上限（SDK ADR 0029；Cinderous ADR-0371）', () => {
    const vars = relayWorkerVars({ allowedPubkeys: [alice], maxFileMb: 30 });
    const env = relayEnvironment({ allowedPubkeys: [alice], persist: false, trustProxy: false, maxFileMb: 30 });
    for (const v of [vars, env]) {
      expect(v.FILE_LANES).toBeUndefined();
      expect(filePolicyFor(v)).toEqual({ accept: true }); // 全站收、沒有 maxFileMb
    }
    const doc = buildRelayInfo({ acceptsFiles: true });
    expect(doc.cinder_accepts_files).toBe(true);
    expect(doc.cinder_max_file_mb).toBeUndefined();
    expect(doc.cinder_file_chunks_per_recipient).toBeUndefined();
  });

  it('壞值拒絕', () => {
    for (const bad of [0, -1, 1.5, 5000, Number.NaN]) expect(() => maxFileMbVar({ maxFileMb: bad }, [alice]), String(bad)).toThrow('maxFileMb');
  });
});

describe('一鍵部署（REST）與命令列', () => {
  it('🔴 REST：沒有白名單又要開檔案事件 → 在打任何 API 之前就拒絕', async () => {
    let calls = 0;
    await expect(
      deployCloudflareRelayViaApi({
        apiToken: 't',
        maxFileMb: VAULT_SYNC_MAX_FILE_MB,
        fetch: async () => {
          calls += 1;
          return { status: 500, text: async () => '' };
        },
      }),
    ).rejects.toThrow('白名單');
    expect(calls).toBe(0);
  });

  it('命令列：--max-file-mb／--open-file-relay 交給各家部署；relay start 的 --max-file-mb 變成 MAX_FILE_MB', async () => {
    const deployed: unknown[] = [];
    const docker: unknown[] = [];
    const started: unknown[] = [];
    const deps: CliDeps = {
      stdout: () => {},
      stderr: () => {},
      env: {},
      cwd: '/work',
      startNodeRelay: (env) => {
        started.push(env);
        return { close() {} };
      },
      deployDockerRelay: async (options) => {
        docker.push(options);
        return { name: 'r', configPath: '/x', httpUrl: 'http://localhost:8080', relayEndpoint: 'ws://localhost:8080' };
      },
      deployFlyRelay: async () => ({ name: 'r', configPath: '/x' }),
      deployCloudflareRelay: async (options) => {
        deployed.push(options);
        return { workerName: 'r', configPath: '/x', httpUrl: 'https://r.workers.dev', relayEndpoint: 'wss://r.workers.dev' };
      },
      writeFile: () => {},
    };
    expect(await runCli(['relay', 'deploy', '-k', 'npub1a', '--max-file-mb', '17'], deps)).toBe(0);
    expect(deployed[0]).toMatchObject({ maxFileMb: 17 });
    expect(await runCli(['relay', 'deploy', '--provider', 'docker', '--max-file-mb', '17', '--open-file-relay'], deps)).toBe(0);
    expect(docker[0]).toMatchObject({ maxFileMb: 17, openFileRelay: true });
    expect(await runCli(['relay', 'start', '--max-file-mb', '17'], deps)).not.toBe(0); // 沒有白名單
    expect(started).toHaveLength(0);
    expect(await runCli(['relay', 'start', '-k', alice, '--max-file-mb', '17'], deps)).toBe(0);
    expect(started[0]).toMatchObject({ MAX_FILE_MB: '17' });
  });
});
