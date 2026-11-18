// SDK ADR 0140：Python 參考設備（examples/iot-device-python）↔ 真的 Node 中繼 ↔ TypeScript 手機端 IotClient。
//
// 選用：要有 Python 與相依套件才會跑——預設找 `examples/iot-device-python/.venv` 的 python，或以 `CINDER_IOT_PYTHON` 指定。
// 找不到就略過（CI 沒有裝 Python 相依；協定的逐位元組相容由 device-vectors.test.ts＋pytest 保證）。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { deriveIotHome, generateIotDeviceToken, generateIotHomeSecret, hashIotDeviceToken, IotClient } from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { RelayPool } from '../../src/relay-pool.js';
import { opened } from '../node-relay-harness.js';

const exampleDir = fileURLToPath(new URL('../../examples/iot-device-python', import.meta.url));
const venvPython = join(exampleDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.CINDER_IOT_PYTHON ?? (existsSync(venvPython) ? venvPython : undefined);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface PyEvent {
  event: string;
  state?: string;
  topic?: string;
  payload?: string;
}

function startPythonDevice(env: Record<string, string>): { proc: ChildProcess; events: PyEvent[]; waitFor(pred: (e: PyEvent) => boolean, ms?: number): Promise<PyEvent> } {
  const proc = spawn(python!, ['-m', 'cinder_iot_device'], { cwd: exampleDir, env: { ...process.env, ...env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events: PyEvent[] = [];
  let buf = '';
  let stderr = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) events.push(JSON.parse(line) as PyEvent);
    }
  });
  proc.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  cleanups.push(() => {
    proc.kill();
  });
  return {
    proc,
    events,
    async waitFor(pred, ms = 10_000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (proc.exitCode !== null) throw new Error(`Python 設備結束了（${proc.exitCode}）：${stderr}`);
        await sleep(25);
      }
      throw new Error(`等不到 Python 設備的事件；目前：${JSON.stringify(events)}；stderr：${stderr}`);
    },
  };
}

describe.skipIf(python === undefined)('Python 參考設備 ↔ Node 中繼 ↔ IotClient（SDK ADR 0140，選用）', () => {
  it('指令往返：Python 設備收到明文、ack 帶回執行後的狀態；查詢拿到目前狀態', async () => {
    const home = deriveIotHome(generateIotHomeSecret());
    const gwSk = generateSecretKey();
    const owner = Identity.generate();
    const token = generateIotDeviceToken();
    const blindId = home.blind('dev:lamp');
    const handles: { close(): void }[] = [];
    const port = await opened(
      handles,
      startNodeRelay({
        DB_PATH: ':memory:',
        PORT: '0',
        IOT_REALTIME: JSON.stringify({
          homes: [{ homeTag: home.homeTag, homePub: home.homePub, gatewayPubkey: getPublicKey(gwSk), acl: [{ pubkey: owner.pubkey, role: 'owner' }], devices: [{ id: 'lamp', blindId, epoch: 0, tokenHash: hashIotDeviceToken(token) }] }],
        }),
        IOT_GATEWAY_KEYS: JSON.stringify({ [home.homeTag]: bytesToHex(gwSk) }),
      }),
    );
    cleanups.push(() => handles.forEach((h) => h.close()));

    const dir = mkdtempSync(join(tmpdir(), 'cinder-iot-py-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dev = startPythonDevice({
      IOT_DEVICE_URL: `ws://127.0.0.1:${port}/iot/v1/dev/${home.homeTag}/${blindId}`,
      IOT_DEVICE_TOKEN: token,
      IOT_DEVICE_KID: 'lamp.0',
      IOT_DEVICE_KEY: bytesToHex(home.deviceKey('lamp', 0)),
      IOT_DEVICE_COUNTER_FILE: join(dir, 'ctr'),
      IOT_TRUST_SYSTEM_CLOCK: '1', // 測試機的時鐘就是 relay 的時鐘；正式設備走 SNTP
    });
    await dev.waitFor((e) => e.event === 'link' && e.state === 'connected');

    const pool = new RelayPool({ urls: [`ws://127.0.0.1:${port}/iot/v1/home/${home.homeTag}`], identity: owner });
    pool.connect();
    for (let i = 0; i < 100 && ![...pool.status().values()].includes('open'); i++) await sleep(20);
    const client = new IotClient({ pool, signer: owner, home, gateway: getPublicKey(gwSk), budget: new RelayEventBudget({ perMinute: 6000 }), readTimeoutMs: 1_000, realtime: { devices: { lamp: {} } } });
    cleanups.push(() => {
      client.close();
      pool.close();
    });

    const r = await client.command('home/lamp/power', '開', { device: 'lamp', urgency: 'realtime', ackTimeoutMs: 5_000 });
    expect(r.status).toBe('ok');
    expect(r.state?.topics['home/lamp/power']?.payload).toBe('開');
    expect(await dev.waitFor((e) => e.event === 'command')).toMatchObject({ topic: 'home/lamp/power', payload: '開', enc: 'utf8' });

    const q = await client.query('lamp', { timeoutMs: 5_000 });
    expect(q.status).toBe('ok');
    expect(q.state?.topics['home/lamp/power']?.payload).toBe('開');
  }, 30_000);
});
