// 一次性秘密寫進 `.secrets/`（SDK ADR 0137，完成 ADR 0050 §4「原文只印一次或寫進 .secrets/」）：
// `--save-secrets`／`--secrets-dir <dir>` 讓秘密那幾行改寫進檔案，終端只印路徑——不留在捲動紀錄與 CI 日誌裡。
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CliDeps, runCli } from '../../src/cli/commands.js';
import { generateIotHomeSecret, hashIotDeviceToken } from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/keys.js';
import type { IotRealtimeHomeConfig } from '../../src/relay/iot-realtime-config.js';
import type { NodeRelayEnv } from '../../src/relay/node-relay.js';

interface SavedSecret {
  dir: string;
  name: string;
  content: string;
}

function harness(env: NodeRelayEnv = {}, opts: { failSecretWrite?: boolean; noSecretWriter?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {};
  const saved: SavedSecret[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('不該部署');
  };
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env,
    cwd: '/work',
    startNodeRelay: () => ({ close() {} }),
    deployCloudflareRelay: unused,
    deployDockerRelay: unused,
    deployFlyRelay: unused,
    writeFile: (path, content) => {
      files[path] = content;
    },
    readFile: (path) => files[path],
    ...(opts.noSecretWriter
      ? {}
      : {
          writeSecretFile: (dir: string, name: string, content: string) => {
            if (opts.failSecretWrite) throw new Error('EACCES: 磁碟不給寫');
            saved.push({ dir, name, content });
            return join(dir, name);
          },
        }),
  };
  return { deps, out, err, files, saved };
}

const valueIn = (lines: string[], name: string): string | undefined => lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
const linesOf = (s: SavedSecret): string[] => s.content.split('\n');

describe('一次性秘密寫進 .secrets/（SDK ADR 0137）', () => {
  it('iot keygen --save-secrets：秘密只在檔案裡，終端只有路徑與公開值', async () => {
    const h = harness();
    expect(await runCli(['iot', 'keygen', '--save-secrets'], h.deps)).toBe(0);
    expect(h.saved).toHaveLength(1);
    const file = h.saved[0]!;
    expect(file.dir).toBe(join('/work', '.secrets'));
    const homeSecret = valueIn(linesOf(file), 'IOT_HOME_SECRET');
    const gatewayKey = valueIn(linesOf(file), 'IOT_GATEWAY_KEY');
    expect(homeSecret).toBeTruthy();
    expect(gatewayKey).toMatch(/^nsec1/);
    const stdout = h.out.join('\n');
    // 🔴 秘密值不在終端
    expect(stdout).not.toContain(homeSecret!);
    expect(stdout).not.toContain(gatewayKey!);
    expect(valueIn(h.out, 'IOT_HOME_SECRET')).toBeUndefined();
    // 終端說了寫到哪裡，公開值（閘道公鑰）照舊印
    expect(stdout).toContain(join('/work', '.secrets', file.name));
    expect(stdout).toMatch(/npub1/);
    // 檔名不含秘密、是 .env
    expect(file.name).toMatch(/^iot-keygen\.\d{8}T\d{6}Z\.env$/);
  });

  it('--secrets-dir <dir>：相對路徑以 cwd 為準，也等於開了 --save-secrets', async () => {
    const h = harness();
    expect(await runCli(['iot', 'push-keygen', '--secrets-dir', 'keys/push'], h.deps)).toBe(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.dir).toBe(join('/work', 'keys/push'));
    const key = valueIn(linesOf(h.saved[0]!), 'PUSH_GATEWAY_KEY');
    expect(key).toMatch(/^nsec1/);
    expect(h.out.join('\n')).not.toContain(key!);
    expect(h.saved[0]!.name).toMatch(/^iot-push-gateway\./);
  });

  it('沒有旗標：輸出與以前完全一樣（秘密照舊印、不寫檔）', async () => {
    const h = harness();
    expect(await runCli(['iot', 'keygen'], h.deps)).toBe(0);
    expect(h.saved).toHaveLength(0);
    expect(valueIn(h.out, 'IOT_HOME_SECRET')).toBeTruthy();
  });

  it('iot realtime home／device --save-secrets：權杖與金鑰在檔案裡，設定檔與終端都沒有；公開值照舊印', async () => {
    const homeSecret = generateIotHomeSecret();
    const owner = npubEncode(getPublicKey(generateSecretKey()));
    const h = harness({ IOT_HOME_SECRET: homeSecret });
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner, '--save-secrets'], h.deps)).toBe(0);
    const homeFile = h.saved[0]!;
    expect(homeFile.name).toMatch(/^iot-realtime-home-[0-9A-Za-z_-]+\.\d{8}T\d{6}Z\.env$/);
    const gatewayKeys = valueIn(linesOf(homeFile), 'IOT_GATEWAY_KEYS');
    const operator = valueIn(linesOf(homeFile), 'IOT_OPERATOR_SECRET');
    expect(gatewayKeys).toBeTruthy();
    expect(operator).toMatch(/^[0-9a-f]{64}$/);
    expect(h.out.join('\n')).not.toContain(operator!);
    expect(h.out.join('\n')).not.toContain(gatewayKeys!);

    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--save-secrets'], h.deps)).toBe(0);
    expect(h.saved).toHaveLength(2);
    const devFile = h.saved[1]!;
    expect(devFile.name).toMatch(/^iot-realtime-device-lamp\./);
    const token = valueIn(linesOf(devFile), 'IOT_DEVICE_TOKEN')!;
    const key = valueIn(linesOf(devFile), 'IOT_DEVICE_KEY')!;
    expect(token).toBeTruthy();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const stdout = h.out.join('\n');
    expect(stdout).not.toContain(token);
    expect(stdout).not.toContain(key);
    // 燒錄要一起用的公開值：檔案裡有（一份完整的 .env），終端也照舊有
    expect(valueIn(linesOf(devFile), 'IOT_DEVICE_ID')).toBe('lamp');
    expect(valueIn(h.out, 'IOT_DEVICE_ID')).toBe('lamp');
    expect(valueIn(h.out, 'IOT_DEVICE_KID')).toBeTruthy();
    // 設定檔只存雜湊，對得上檔案裡的權杖
    const cfg = JSON.parse(h.files[join('/work', 'iot-realtime.json')]!) as { homes: IotRealtimeHomeConfig[] };
    expect(cfg.homes[0]!.devices[0]!.tokenHash).toBe(hashIotDeviceToken(token));
  });

  it('換權杖（--new-token）也走同一條路', async () => {
    const h = harness({ IOT_HOME_SECRET: generateIotHomeSecret() });
    const owner = npubEncode(getPublicKey(generateSecretKey()));
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner], h.deps)).toBe(0);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp'], h.deps)).toBe(0);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--new-token', '--save-secrets'], h.deps)).toBe(0);
    expect(h.saved).toHaveLength(1);
    const token = valueIn(linesOf(h.saved[0]!), 'IOT_DEVICE_TOKEN')!;
    expect(token).toBeTruthy();
    expect(h.out.slice(-6).join('\n')).not.toContain(token);
  });

  it('🔴 寫檔失敗：退回印在終端並警告——設定檔已經改了，秘密不能跟著消失', async () => {
    const h = harness({}, { failSecretWrite: true });
    expect(await runCli(['iot', 'keygen', '--save-secrets'], h.deps)).toBe(0);
    expect(valueIn(h.out, 'IOT_HOME_SECRET')).toBeTruthy();
    expect(h.err.join('\n')).toMatch(/EACCES/);
    expect(h.err.join('\n')).toMatch(/改印在終端/);
  });

  it('環境不能寫秘密檔：一開始就是用法錯誤，什麼都沒改', async () => {
    const homeSecret = generateIotHomeSecret();
    const owner = npubEncode(getPublicKey(generateSecretKey()));
    const h = harness({ IOT_HOME_SECRET: homeSecret }, { noSecretWriter: true });
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner, '--save-secrets'], h.deps)).toBe(2);
    expect(h.files[join('/work', 'iot-realtime.json')]).toBeUndefined();
    expect(h.out).toHaveLength(0);
  });
});
