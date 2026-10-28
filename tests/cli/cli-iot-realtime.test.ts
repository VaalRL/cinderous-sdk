// C′ 的 CLI（SDK ADR 0121）：`iot realtime home|device` 產生設定與只印一次的秘密；`relay start --iot-realtime` 讀設定。
import { join } from 'node:path';

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { type CliDeps, runCli } from '../../src/cli/commands.js';
import { deriveIotDeviceKeyDown, deriveIotHome, generateIotHomeSecret, hashIotDeviceToken } from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/keys.js';
import { checkIotRealtimeAclShape, checkIotRealtimeConfig, type IotRealtimeHomeConfig } from '../../src/relay/iot-realtime-config.js';
import { parseIotRealtimeConfig } from '../../src/relay/iot-realtime.js';
import type { NodeRelayEnv } from '../../src/relay/node-relay.js';

function harness(env: NodeRelayEnv = {}, files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const started: NodeRelayEnv[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('不該部署');
  };
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env,
    cwd: '/work',
    startNodeRelay: (e) => {
      started.push(e);
      return { close() {} };
    },
    deployCloudflareRelay: unused,
    deployDockerRelay: unused,
    deployFlyRelay: unused,
    writeFile: (path, content) => {
      files[path] = content;
    },
    readFile: (path) => files[path],
  };
  return { deps, out, err, files, started };
}

/** 從輸出裡拿 `NAME=value` 那一行的值 */
const valueOf = (out: string[], name: string): string | undefined => out.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
const FILE = join('/work', 'iot-realtime.json');

describe('cinderous iot realtime home（SDK ADR 0121）', () => {
  it('新家庭：寫進設定檔（公開值），閘道私鑰與 operator 秘密只印這一次', async () => {
    const homeSecret = generateIotHomeSecret();
    const owner = npubEncode(getPublicKey(generateSecretKey()));
    const h = harness({ IOT_HOME_SECRET: homeSecret });
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner], h.deps)).toBe(0);
    const home = deriveIotHome(homeSecret);
    const cfg = JSON.parse(h.files[FILE]!) as { homes: IotRealtimeHomeConfig[] };
    expect(cfg.homes).toHaveLength(1);
    expect(cfg.homes[0]).toMatchObject({ homeTag: home.homeTag, homePub: home.homePub, aclBlindId: home.blind('sys:acl'), acl: [{ pubkey: owner, role: 'owner' }], devices: [] });
    const keys = JSON.parse(valueOf(h.out, 'IOT_GATEWAY_KEYS')!) as Record<string, string>;
    expect(getPublicKey(hexToBytes(keys[home.homeTag]!))).toBe(cfg.homes[0]!.gatewayPubkey);
    expect(valueOf(h.out, 'IOT_OPERATOR_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    // 🔴 設定檔裡沒有任何秘密
    expect(h.files[FILE]).not.toContain(keys[home.homeTag]);
    expect(h.files[FILE]).not.toContain(homeSecret);
    // relay 與部署設定器都接受
    expect(checkIotRealtimeConfig(cfg, checkIotRealtimeAclShape).issues).toEqual([]);
    expect(parseIotRealtimeConfig(cfg, keys).issues).toEqual([]);
  });

  it('既有的閘道私鑰在環境裡：印出合併後的整份（secret 是整份換掉）；同一個家庭不重複加', async () => {
    const owner = getPublicKey(generateSecretKey());
    const first = harness({ IOT_HOME_SECRET: generateIotHomeSecret() });
    await runCli(['iot', 'realtime', 'home', '--owner', owner], first.deps);
    const firstKeys = valueOf(first.out, 'IOT_GATEWAY_KEYS')!;
    const secondSecret = generateIotHomeSecret();
    const second = harness({ IOT_HOME_SECRET: secondSecret, IOT_GATEWAY_KEYS: firstKeys }, first.files);
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner], second.deps)).toBe(0);
    const merged = JSON.parse(valueOf(second.out, 'IOT_GATEWAY_KEYS')!) as Record<string, string>;
    expect(Object.keys(merged)).toHaveLength(2);
    expect(JSON.parse(second.files[FILE]!).homes).toHaveLength(2);
    const again = harness({ IOT_HOME_SECRET: secondSecret, IOT_GATEWAY_KEYS: JSON.stringify(merged) }, second.files);
    expect(await runCli(['iot', 'realtime', 'home', '--owner', owner], again.deps)).toBe(1);
    expect(again.err.join('\n')).toMatch(/已經在/);
  });

  it('沒有家庭秘密、沒有 owner：用法錯誤', async () => {
    expect(await runCli(['iot', 'realtime', 'home', '--owner', getPublicKey(generateSecretKey())], harness().deps)).toBe(2);
    expect(await runCli(['iot', 'realtime', 'home'], harness({ IOT_HOME_SECRET: generateIotHomeSecret() }).deps)).toBe(2);
  });
});

describe('cinderous iot realtime device（SDK ADR 0121）', () => {
  async function withHome() {
    const homeSecret = generateIotHomeSecret();
    const h = harness({ IOT_HOME_SECRET: homeSecret });
    await runCli(['iot', 'realtime', 'home', '--owner', getPublicKey(generateSecretKey())], h.deps);
    const operatorSecret = valueOf(h.out, 'IOT_OPERATOR_SECRET')!;
    const gatewayKeys = valueOf(h.out, 'IOT_GATEWAY_KEYS')!;
    return { homeSecret, operatorSecret, gatewayKeys, files: h.files };
  }

  it('一般設備：設定檔只有 tokenHash 與 blindId；權杖與設備金鑰只印這一次', async () => {
    const { homeSecret, gatewayKeys, files } = await withHome();
    const h = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp'], h.deps)).toBe(0);
    const home = deriveIotHome(homeSecret);
    const device = (JSON.parse(files[FILE]!) as { homes: IotRealtimeHomeConfig[] }).homes[0]!.devices[0]!;
    const token = valueOf(h.out, 'IOT_DEVICE_TOKEN')!;
    expect(device).toEqual({ id: 'lamp', blindId: home.blind('dev:lamp'), epoch: 0, tokenHash: hashIotDeviceToken(token) });
    expect(valueOf(h.out, 'IOT_DEVICE_KID')).toBe('lamp.0');
    expect(valueOf(h.out, 'IOT_DEVICE_KEY')).toBe(bytesToHex(home.deviceKey('lamp', 0)));
    expect(valueOf(h.out, 'IOT_DEVICE_KEY_DOWN')).toBeUndefined();
    expect(files[FILE]).not.toContain(token);
    expect(parseIotRealtimeConfig(JSON.parse(files[FILE]!), JSON.parse(gatewayKeys)).homes.size).toBe(1);
  });

  it('門鎖類：要 --local-fallback 與 operator 秘密；印出 down 金鑰（以 operator 秘密衍生）', async () => {
    const { homeSecret, operatorSecret, files } = await withHome();
    const noFallback = harness({ IOT_HOME_SECRET: homeSecret, IOT_OPERATOR_SECRET: operatorSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'door', '--class', 'lock'], noFallback.deps)).toBe(2);
    const noSecret = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'door', '--class', 'lock', '--local-fallback', 'key'], noSecret.deps)).toBe(2);
    const h = harness({ IOT_HOME_SECRET: homeSecret, IOT_OPERATOR_SECRET: operatorSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'door', '--class', 'lock', '--local-fallback', 'key,keypad', '--min-role', 'operator'], h.deps)).toBe(0);
    const device = (JSON.parse(files[FILE]!) as { homes: IotRealtimeHomeConfig[] }).homes[0]!.devices[0]!;
    expect(device).toMatchObject({ id: 'door', class: 'lock', localFallback: ['key', 'keypad'], minRole: 'operator' });
    expect(valueOf(h.out, 'IOT_DEVICE_KEY_DOWN')).toBe(bytesToHex(deriveIotDeviceKeyDown(operatorSecret, 'door', 0)));
  });

  it('同一個 id 不能加兩次；家庭不在設定檔裡要先跑 home', async () => {
    const { homeSecret, files } = await withHome();
    await runCli(['iot', 'realtime', 'device', 'lamp'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps);
    const dup = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp'], dup.deps)).toBe(1);
    const other = harness({ IOT_HOME_SECRET: generateIotHomeSecret() }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp'], other.deps)).toBe(1);
    expect(other.err.join('\n')).toMatch(/iot realtime home/);
  });
});

describe('輪換（SDK ADR 0122）', () => {
  async function withLamp(cls: 'lock' | 'general' = 'general') {
    const homeSecret = generateIotHomeSecret();
    const h = harness({ IOT_HOME_SECRET: homeSecret });
    await runCli(['iot', 'realtime', 'home', '--owner', getPublicKey(generateSecretKey())], h.deps);
    const operatorSecret = valueOf(h.out, 'IOT_OPERATOR_SECRET')!;
    const gatewayKeys = valueOf(h.out, 'IOT_GATEWAY_KEYS')!;
    const add = harness({ IOT_HOME_SECRET: homeSecret, IOT_OPERATOR_SECRET: operatorSecret }, h.files);
    const args = cls === 'lock' ? ['--class', 'lock', '--local-fallback', 'key'] : [];
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', ...args], add.deps)).toBe(0);
    const token = valueOf(add.out, 'IOT_DEVICE_TOKEN')!;
    return { homeSecret, operatorSecret, gatewayKeys, files: h.files, token };
  }
  const lampOf = (files: Record<string, string>) => (JSON.parse(files[FILE]!) as { homes: IotRealtimeHomeConfig[] }).homes[0]!.devices[0]!;

  it('device --rotate：epoch 加 1、舊版本寬限一天（previousEpoch）；權杖不變；印出新版本的 kid／金鑰與手機端的設定', async () => {
    const { homeSecret, gatewayKeys, files, token } = await withLamp();
    const before = Math.floor(Date.now() / 1000);
    const h = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate'], h.deps)).toBe(0);
    const lamp = lampOf(files);
    expect(lamp).toMatchObject({ epoch: 1, tokenHash: hashIotDeviceToken(token) });
    expect(lamp.previousEpoch!.epoch).toBe(0);
    expect(lamp.previousEpoch!.until).toBeGreaterThanOrEqual(before + 86_400);
    expect(lamp.previousEpoch!.until).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86_400);
    const home = deriveIotHome(homeSecret);
    expect(valueOf(h.out, 'IOT_DEVICE_KID')).toBe('lamp.1');
    expect(valueOf(h.out, 'IOT_DEVICE_KEY')).toBe(bytesToHex(home.deviceKey('lamp', 1)));
    expect(valueOf(h.out, 'IOT_DEVICE_TOKEN')).toBeUndefined();
    expect(JSON.parse(valueOf(h.out, 'IOT_PHONE_DEVICE')!)).toEqual({ lamp: { epoch: 1, previousEpoch: lamp.previousEpoch } });
    expect(parseIotRealtimeConfig(JSON.parse(files[FILE]!), JSON.parse(gatewayKeys)).issues).toEqual([]);
  });

  it('--grace-sec 0＝不寬限（舊版本立刻作廢）；超過 7 天是用法錯誤；再換一次時舊的寬限被取代並提醒', async () => {
    const { homeSecret, files } = await withLamp();
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate', '--grace-sec', '604801'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(2);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(0);
    const again = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate', '--grace-sec', '0'], again.deps)).toBe(0);
    expect(again.err.join('\n')).toMatch(/epoch 0.*寬限/);
    const lamp = lampOf(files);
    expect(lamp.epoch).toBe(2);
    expect(lamp.previousEpoch).toBeUndefined();
  });

  it('門鎖類輪換要 IOT_OPERATOR_SECRET，印出新版本的 down 金鑰', async () => {
    const { homeSecret, operatorSecret, files } = await withLamp('lock');
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(2);
    const h = harness({ IOT_HOME_SECRET: homeSecret, IOT_OPERATOR_SECRET: operatorSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate'], h.deps)).toBe(0);
    expect(valueOf(h.out, 'IOT_DEVICE_KEY_DOWN')).toBe(bytesToHex(deriveIotDeviceKeyDown(operatorSecret, 'lamp', 1)));
    expect(JSON.parse(valueOf(h.out, 'IOT_PHONE_DEVICE')!).lamp).toMatchObject({ epoch: 1, class: 'lock' });
  });

  it('device --new-token：換權杖（外洩時），epoch 不變；舊權杖的雜湊不在了', async () => {
    const { homeSecret, files, token } = await withLamp();
    const h = harness({ IOT_HOME_SECRET: homeSecret }, files);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--new-token'], h.deps)).toBe(0);
    const fresh = valueOf(h.out, 'IOT_DEVICE_TOKEN')!;
    expect(fresh).not.toBe(token);
    expect(lampOf(files)).toMatchObject({ epoch: 0, tokenHash: hashIotDeviceToken(fresh) });
    expect(files[FILE]).not.toContain(hashIotDeviceToken(token));
  });

  it('沒有這台設備就不能輪換；--rotate 與 --epoch、--class 不能一起給', async () => {
    const { homeSecret, files } = await withLamp();
    expect(await runCli(['iot', 'realtime', 'device', 'fan', '--rotate'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(1);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--rotate', '--epoch', '5'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(2);
    expect(await runCli(['iot', 'realtime', 'device', 'lamp', '--new-token', '--class', 'lock'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(2);
  });

  it('home --rotate-gateway：新的閘道公鑰寫進設定、IOT_GATEWAY_KEYS 整份換掉這一家；舊私鑰立刻不能用（不寬限）', async () => {
    const { homeSecret, gatewayKeys, files } = await withLamp();
    const other = harness({ IOT_HOME_SECRET: generateIotHomeSecret(), IOT_GATEWAY_KEYS: gatewayKeys }, files);
    await runCli(['iot', 'realtime', 'home', '--owner', getPublicKey(generateSecretKey())], other.deps);
    const bothKeys = valueOf(other.out, 'IOT_GATEWAY_KEYS')!;
    const homeTag = deriveIotHome(homeSecret).homeTag;
    const oldPub = (JSON.parse(files[FILE]!) as { homes: IotRealtimeHomeConfig[] }).homes[0]!.gatewayPubkey;
    // 有別的家庭時一定要給既有的整份，否則印出來的會少掉別家
    expect(await runCli(['iot', 'realtime', 'home', '--rotate-gateway'], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(2);
    const h = harness({ IOT_HOME_SECRET: homeSecret, IOT_GATEWAY_KEYS: bothKeys }, files);
    expect(await runCli(['iot', 'realtime', 'home', '--rotate-gateway'], h.deps)).toBe(0);
    const cfg = JSON.parse(files[FILE]!) as { homes: IotRealtimeHomeConfig[] };
    const keys = JSON.parse(valueOf(h.out, 'IOT_GATEWAY_KEYS')!) as Record<string, string>;
    expect(Object.keys(keys)).toHaveLength(2);
    expect(cfg.homes[0]!.gatewayPubkey).not.toBe(oldPub);
    expect(getPublicKey(hexToBytes(keys[homeTag]!))).toBe(cfg.homes[0]!.gatewayPubkey);
    expect(cfg.homes[0]!.devices).toHaveLength(1);
    expect(parseIotRealtimeConfig(cfg, keys).issues).toEqual([]);
    expect(parseIotRealtimeConfig(cfg, JSON.parse(bothKeys)).issues.length).toBeGreaterThan(0);
    expect(h.out.join('\n')).toContain(cfg.homes[0]!.gatewayPubkey);
  });

  it('home --rotate-gateway：家庭不在設定檔裡就失敗；不能與 --owner 一起給', async () => {
    const { homeSecret, files } = await withLamp();
    expect(await runCli(['iot', 'realtime', 'home', '--rotate-gateway'], harness({ IOT_HOME_SECRET: generateIotHomeSecret() }, files).deps)).toBe(1);
    expect(await runCli(['iot', 'realtime', 'home', '--rotate-gateway', '--owner', getPublicKey(generateSecretKey())], harness({ IOT_HOME_SECRET: homeSecret }, files).deps)).toBe(2);
  });
});

describe('cinderous relay start --iot-realtime（SDK ADR 0121）', () => {
  it('讀設定檔寫進 IOT_REALTIME；閘道私鑰只從環境讀', async () => {
    const homeSecret = generateIotHomeSecret();
    const made = harness({ IOT_HOME_SECRET: homeSecret });
    await runCli(['iot', 'realtime', 'home', '--owner', getPublicKey(generateSecretKey())], made.deps);
    const keys = valueOf(made.out, 'IOT_GATEWAY_KEYS')!;
    const h = harness({ IOT_GATEWAY_KEYS: keys }, made.files);
    expect(await runCli(['relay', 'start', '--iot-realtime', 'iot-realtime.json'], h.deps)).toBe(0);
    expect(JSON.parse(h.started[0]!.IOT_REALTIME!)).toEqual(JSON.parse(made.files[FILE]!));
    expect(h.started[0]!.IOT_GATEWAY_KEYS).toBe(keys);
  });

  it('🔴 設定壞了、少了閘道私鑰、私鑰對不上：不啟動（不帶著一半的家庭跑起來）', async () => {
    const made = harness({ IOT_HOME_SECRET: generateIotHomeSecret() });
    await runCli(['iot', 'realtime', 'home', '--owner', getPublicKey(generateSecretKey())], made.deps);
    const homeTag = (JSON.parse(made.files[FILE]!) as { homes: IotRealtimeHomeConfig[] }).homes[0]!.homeTag;
    const missing = harness({}, made.files);
    expect(await runCli(['relay', 'start', '--iot-realtime', 'iot-realtime.json'], missing.deps)).toBe(2);
    expect(missing.err.join('\n')).toMatch(/IOT_GATEWAY_KEYS/);
    const wrong = harness({ IOT_GATEWAY_KEYS: JSON.stringify({ [homeTag]: bytesToHex(generateSecretKey()) }) }, made.files);
    expect(await runCli(['relay', 'start', '--iot-realtime', 'iot-realtime.json'], wrong.deps)).toBe(2);
    const broken = harness({ IOT_GATEWAY_KEYS: '{}' }, { [FILE]: '{"homes":[{"homeTag":"x"}]}' });
    expect(await runCli(['relay', 'start', '--iot-realtime', 'iot-realtime.json'], broken.deps)).toBe(2);
    expect(broken.err.join('\n')).toMatch(/homeTag/);
    for (const x of [missing, wrong, broken]) expect(x.started).toEqual([]);
  });
});
