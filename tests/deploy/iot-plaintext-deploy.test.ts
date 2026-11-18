// C′ R5 Shelly 明文轉譯的部署接線（SDK ADR 0139）：危險旗標 `site.iotPlaintextDevices`（ADR 0117 的 dangerous 機制）、
// 白名單必填、秘密 `IOT_PLAINTEXT_DEVICE_KEYS`（每台 Shelly 一把 deviceKey，不是家庭秘密）。CLI `iot realtime device --shelly-switch`。
import { join } from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { type CliDeps, runCli } from '../../src/cli/commands.js';
import { dangerConfirmWord, dangerousChoices, DEPLOY_OPTION_SPECS, type DeployConfig } from '../../src/deploy/config/index.js';
import { collectRelaySiteIssues, iotPlaintextDeviceKeysSecret, relaySiteVars, relayWorkerSecrets, type RelaySiteOptions } from '../../src/deploy/shared.js';
import { deriveIotHome, generateIotHomeSecret } from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/keys.js';
import { iotPlaintextFrom, parseIotRealtimeConfig } from '../../src/relay/iot-realtime.js';
import type { IotRealtimeHomeConfig } from '../../src/relay/iot-realtime-config.js';

const HOME_TAG = 'h'.repeat(22);
const allow = [getPublicKey(generateSecretKey())];
const KEY = 'ab'.repeat(32);

function realtime(shelly = true): NonNullable<RelaySiteOptions['iotRealtime']> {
  return {
    homes: [
      {
        homeTag: HOME_TAG,
        homePub: getPublicKey(generateSecretKey()),
        gatewayPubkey: getPublicKey(generateSecretKey()),
        acl: [{ pubkey: getPublicKey(generateSecretKey()), role: 'owner' }],
        devices: [
          { id: 'lamp', blindId: 'd'.repeat(22), epoch: 0, tokenHash: 'a'.repeat(64) },
          ...(shelly ? [{ id: 'plug', blindId: 'e'.repeat(22), epoch: 0, tokenHash: 'b'.repeat(64), transport: 'shelly' as const, shelly: { switches: [{ id: 0, topic: 'home/plug' }] } }] : []),
        ],
      },
    ],
  } as unknown as NonNullable<RelaySiteOptions['iotRealtime']>;
}

describe('站台參數 iotPlaintextDevices → IOT_PLAINTEXT_DEVICES（SDK ADR 0139）', () => {
  it('兩種主機都寫成 1；沒給就不設', () => {
    for (const host of ['worker', 'node'] as const) {
      expect(relaySiteVars({ iotRealtime: realtime(), iotPlaintextDevices: true, allowedPubkeys: allow }, host).IOT_PLAINTEXT_DEVICES).toBe('1');
      expect(relaySiteVars({ iotRealtime: realtime(false), allowedPubkeys: allow }, host).IOT_PLAINTEXT_DEVICES).toBeUndefined();
    }
  });

  it('🔴 要有白名單（開放站與官方錨點不提供）、要有 iotRealtime；有 Shelly 設備卻沒開旗標也擋', () => {
    const codes = (opts: RelaySiteOptions) => collectRelaySiteIssues(opts, 'node').map((i) => i.code);
    expect(codes({ iotRealtime: realtime(), iotPlaintextDevices: true })).toContain('iot-plaintext-needs-allowlist');
    expect(codes({ iotPlaintextDevices: true, allowedPubkeys: allow })).toContain('iot-needs-realtime');
    expect(codes({ iotRealtime: realtime(), allowedPubkeys: allow })).toContain('iot-plaintext-disabled');
    expect(codes({ iotRealtime: realtime(), iotPlaintextDevices: true, allowedPubkeys: allow })).toEqual([]);
  });

  it('描述表：site.iotPlaintextDevices 是危險選項（精靈要打字確認、部署說明列進安全檢查清單）；secrets.iotPlaintextDeviceKeys 是秘密', () => {
    const spec = DEPLOY_OPTION_SPECS.find((s) => s.path === 'site.iotPlaintextDevices')!;
    expect(spec).toMatchObject({ type: 'boolean', dangerous: true, env: 'IOT_PLAINTEXT_DEVICES' });
    expect(dangerConfirmWord(spec)).toBe('iotPlaintextDevices');
    const config = { target: 'docker', site: { iotPlaintextDevices: true } } as unknown as DeployConfig;
    expect(dangerousChoices(config).map((s) => s.path)).toContain('site.iotPlaintextDevices');
    expect(DEPLOY_OPTION_SPECS.find((s) => s.path === 'secrets.iotPlaintextDeviceKeys')).toMatchObject({ secret: true, defaultEnv: 'IOT_PLAINTEXT_DEVICE_KEYS' });
  });
});

describe('秘密 IOT_PLAINTEXT_DEVICE_KEYS', () => {
  it('每台 Shelly 一把：寫成 JSON 的 Worker secret', () => {
    const keys = { [`${HOME_TAG}/plug`]: KEY };
    expect(JSON.parse(iotPlaintextDeviceKeysSecret(keys, realtime()))).toEqual(keys);
    expect(relayWorkerSecrets({ iotPlaintextDeviceKeys: keys, iotRealtime: realtime() }).IOT_PLAINTEXT_DEVICE_KEYS).toBe(JSON.stringify(keys));
  });

  it('🔴 不是 Shelly 的設備、缺 Shelly 設備、不是 64 位 hex、沒有 iotRealtime 都丟例外；訊息不含金鑰', () => {
    const cases: Record<string, string>[] = [{ [`${HOME_TAG}/lamp`]: KEY, [`${HOME_TAG}/plug`]: KEY }, {}, { [`${HOME_TAG}/plug`]: 'nope' }];
    for (const keys of cases) {
      let message = '';
      try {
        iotPlaintextDeviceKeysSecret(keys, realtime());
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(KEY);
    }
    expect(() => iotPlaintextDeviceKeysSecret({ [`${HOME_TAG}/plug`]: KEY }, undefined)).toThrow();
  });
});

describe('CLI：iot realtime device --shelly-switch', () => {
  function harness(env: Record<string, string>, files: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
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
      writeFile: (path, content) => void (files[path] = content),
      readFile: (path) => files[path],
    };
    return { deps, out, err, files };
  }
  const valueOf = (out: string[], name: string) => out.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);

  it('寫進 transport: shelly 與開關對應；印出 IOT_PLAINTEXT_DEVICE_KEYS 那一筆與 Shelly 的 Ws.SetConfig 網址；relay 開了旗標就接受', async () => {
    const homeSecret = generateIotHomeSecret();
    const files: Record<string, string> = {};
    const owner = npubEncode(allow[0]!);
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(0);
    const h = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'plug', '--shelly-switch', '0=home/plug', '--shelly-switch', '1=home/usb'], h.deps)).toBe(0);
    const home = deriveIotHome(homeSecret);
    const cfg = JSON.parse(files[join('/work', 'iot-realtime.json')]!) as { homes: IotRealtimeHomeConfig[] };
    expect(cfg.homes[0]!.devices[0]).toMatchObject({ id: 'plug', transport: 'shelly', shelly: { switches: [{ id: 0, topic: 'home/plug' }, { id: 1, topic: 'home/usb' }] } });
    const entry = JSON.parse(`{${valueOf(h.out, 'IOT_PLAINTEXT_DEVICE_KEYS_ENTRY')!}}`) as Record<string, string>;
    expect(entry).toEqual({ [`${home.homeTag}/plug`]: bytesToHex(home.deviceKey('plug', 0)) });
    expect(valueOf(h.out, 'SHELLY_WS_SERVER')).toMatch(new RegExp(`^wss://<relay>/iot/v1/shelly/${home.homeTag}/${home.blind('dev:plug')}\\?token=cit1_`));
    const plaintext = iotPlaintextFrom({ IOT_PLAINTEXT_DEVICES: '1', ALLOWED_PUBKEYS: allow[0]!, IOT_PLAINTEXT_DEVICE_KEYS: JSON.stringify(entry) });
    const gw = { [home.homeTag]: bytesToHex(generateSecretKey()) };
    expect(parseIotRealtimeConfig(cfg, gw, plaintext).issues.map((i) => i.code)).toEqual(['gateway-key-mismatch']);
    // 輪換：印出新版本那一筆（relay 換用新金鑰）；換權杖：印出新的 Shelly 網址
    const r = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'plug', '--rotate', '--new-token'], r.deps)).toBe(0);
    expect(JSON.parse(`{${valueOf(r.out, 'IOT_PLAINTEXT_DEVICE_KEYS_ENTRY')!}}`)).toEqual({ [`${home.homeTag}/plug`]: bytesToHex(home.deviceKey('plug', 1)) });
    expect(valueOf(r.out, 'SHELLY_WS_SERVER')).not.toBe(valueOf(h.out, 'SHELLY_WS_SERVER'));
  });

  it('門鎖類不能走 Shelly；開關格式錯是用法錯誤', async () => {
    const homeSecret = generateIotHomeSecret();
    const files: Record<string, string> = {};
    await runCli(['iot', 'realtime', 'home', '--owner', npubEncode(allow[0]!)], harness({ IOT_HOME_SECRET: homeSecret }, files).deps);
    const h = harness({ IOT_HOME_SECRET: homeSecret, IOT_OPERATOR_SECRET: 'cd'.repeat(32) }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'door', '--class', 'lock', '--local-fallback', 'key', '--shelly-switch', '0=home/door'], h.deps)).toBe(2);
    expect(h.err.join(' ')).toMatch(/Shelly/);
    expect(await runCli(['iot', 'realtime', 'device', 'plug', '--shelly-switch', 'x=home/plug'], h.deps)).toBe(2);
    expect(h.err.join(' ')).toMatch(/--shelly-switch/);
    // 沒寫進設定檔
    expect(h.files[join('/work', 'iot-realtime.json')]).not.toContain('door');
  });
});
