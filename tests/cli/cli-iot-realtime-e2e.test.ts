// 家庭秘密輪換的端到端（SDK ADR 0123）：CLI 產生 → 輪換 → 以 CLI 的輸出起真的 Node 中繼、連真的設備與手機。
// 留下來的人（新秘密）照常開燈；被踢的人（舊秘密）連家庭端點都連不上，也訂不到任何東西。
import { join } from 'node:path';

import { hexToBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';

import { type CliDeps, runCli } from '../../src/cli/commands.js';
import { Identity } from '../../src/identity.js';
import { connectIotDevice, memoryIotDeviceCounterStore, type IotDeviceCommand } from '../../src/iot/device.js';
import { deriveIotHome, generateIotHomeSecret, IotClient } from '../../src/iot/index.js';
import { startNodeRelay, type NodeRelayEnv } from '../../src/relay/node-relay.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { RelayPool } from '../../src/relay-pool.js';
import { opened } from '../node-relay-harness.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FILE = join('/work', 'iot-realtime.json');

function cli(env: NodeRelayEnv, files: Record<string, string>) {
  const out: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('不該部署');
  };
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
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
  };
  return { deps, out, value: (name: string) => out.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1) };
}

const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function openPool(url: string, identity: Identity): Promise<RelayPool> {
  const pool = new RelayPool({ urls: [url], identity, reconnectDelaysMs: [60_000] });
  pool.connect();
  cleanups.push(() => pool.close());
  for (let i = 0; i < 50 && ![...pool.status().values()].includes('open'); i++) await sleep(20);
  return pool;
}

describe('🔴 家庭秘密輪換：CLI 的輸出直接拿來用（SDK ADR 0123）', () => {
  it('踢掉 viewer 之後：重燒的設備＋新秘密的手機照常開燈；舊秘密連不上家庭端點', async () => {
    const owner = Identity.generate();
    const viewer = Identity.generate();
    const oldSecret = generateIotHomeSecret();
    const files: Record<string, string> = {};
    const made = cli({ IOT_HOME_SECRET: oldSecret }, files);
    await runCli(['iot', 'realtime', 'home', '--owner', owner.pubkey], made.deps);
    const lamp = cli({ IOT_HOME_SECRET: oldSecret }, files);
    await runCli(['iot', 'realtime', 'device', 'lamp'], lamp.deps);
    const token = lamp.value('IOT_DEVICE_TOKEN')!;
    // owner 用 App 加了 viewer——這裡直接寫進設定檔（輪換以設定檔的名單為準）
    const cfg = JSON.parse(files[FILE]!) as { homes: { acl: unknown[] }[] };
    cfg.homes[0]!.acl.push({ pubkey: viewer.pubkey, role: 'viewer' });
    files[FILE] = JSON.stringify(cfg);

    const newSecret = generateIotHomeSecret();
    const rotated = cli({ IOT_HOME_SECRET: oldSecret, IOT_NEW_HOME_SECRET: newSecret, IOT_GATEWAY_KEYS: made.value('IOT_GATEWAY_KEYS')! }, files);
    expect(await runCli(['iot', 'realtime', 'home', '--rotate-secret', '--remove', viewer.pubkey], rotated.deps)).toBe(0);

    const handles: { close(): void }[] = [];
    const port = await opened(handles, startNodeRelay({ DB_PATH: ':memory:', PORT: '0', IOT_REALTIME: files[FILE]!, IOT_GATEWAY_KEYS: rotated.value('IOT_GATEWAY_KEYS')! }));
    cleanups.push(() => handles.forEach((h) => h.close()));
    const next = deriveIotHome(newSecret);
    const old = deriveIotHome(oldSecret);

    // 重燒：新網址、新金鑰，權杖照舊
    const commands: IotDeviceCommand[] = [];
    let connected!: () => void;
    const up = new Promise<void>((r) => (connected = r));
    const dev = connectIotDevice({
      url: `ws://127.0.0.1:${port}/iot/v1/dev/${next.homeTag}/${rotated.value('IOT_DEVICE_BLIND_ID')!}`,
      token,
      deviceKey: hexToBytes(rotated.value('IOT_DEVICE_KEY')!),
      kid: rotated.value('IOT_DEVICE_KID')!,
      counterStore: memoryIotDeviceCounterStore(),
      onCommand: (cmd) => {
        commands.push(cmd);
        return { status: 'ok' };
      },
      onLinkState: (s) => {
        if (s === 'connected') connected();
      },
    });
    cleanups.push(() => dev.close());
    await up;

    const gateway = made.out.find((l) => l.startsWith('# 手機端的閘道公鑰'))!.split('：').at(-1)!;
    const pool = await openPool(`ws://127.0.0.1:${port}/iot/v1/home/${next.homeTag}`, owner);
    const phone = new IotClient({
      pool,
      signer: owner,
      home: next,
      gateway,
      budget: new RelayEventBudget({ perMinute: 6000 }),
      realtime: { devices: JSON.parse(rotated.value('IOT_PHONE_DEVICES')!) },
    });
    cleanups.push(() => phone.close());
    expect((await phone.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime' })).status).toBe('ok');
    expect(commands.map((c) => c.payload)).toEqual(['ON']);

    // 被踢的人：舊的 homeTag 已經不是這座 relay 服務的家
    const kicked = await openPool(`ws://127.0.0.1:${port}/iot/v1/home/${old.homeTag}`, viewer);
    expect([...kicked.status().values()]).not.toContain('open');
  });
});
