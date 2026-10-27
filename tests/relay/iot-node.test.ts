// C′ 的 Node 宿主（SDK ADR 0049 §9、R1）：與 Workers 版同一個 IotRealtimeHome，自架主機（家中 Node relay＋Tunnel）用。
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { deriveIotHome } from '../../src/iot/keys.js';
import {
  encodeIotDeviceFrame,
  generateIotDeviceToken,
  hashIotDeviceToken,
  IOT_DEVICE_HEARTBEAT,
  IOT_DEVICE_HEARTBEAT_ACK,
  parseIotDeviceFrame,
} from '../../src/iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND } from '../../src/iot/kinds.js';
import { newIotMsgId, parseIotBody } from '../../src/iot/content.js';
import { sealIotEnvelope } from '../../src/iot/envelope.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';

const port = () => 40_000 + Math.floor(Math.random() * 2_000);
const home = deriveIotHome('44'.repeat(32));
const gwSk = generateSecretKey();
const operator = generateSecretKey();
const token = generateIotDeviceToken();
const blind = home.blind('dev:lamp');
const key = home.deviceKey('lamp', 0);

function iotEnv(p: number): Record<string, string> {
  return {
    PORT: String(p),
    DB_PATH: ':memory:',
    IOT_REALTIME: JSON.stringify({
      homes: [
        {
          homeTag: home.homeTag,
          homePub: home.homePub,
          gatewayPubkey: getPublicKey(gwSk),
          acl: [{ pubkey: getPublicKey(operator), role: 'operator' }],
          devices: [{ id: 'lamp', blindId: blind, epoch: 0, tokenHash: hashIotDeviceToken(token) }],
        },
      ],
    }),
    IOT_GATEWAY_KEYS: JSON.stringify({ [home.homeTag]: bytesToHex(gwSk) }),
  };
}

const handles: { close(): void }[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const h of handles.splice(0)) h.close();
});

async function start(env: Record<string, string>): Promise<void> {
  handles.push(startNodeRelay(env));
  await new Promise((r) => setTimeout(r, 100));
}

/** 開一條連線並收集訊息 */
function open(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; next: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    const queue: string[] = [];
    const waiters: ((s: string) => void)[] = [];
    ws.on('message', (d) => {
      const s = d.toString();
      const w = waiters.shift();
      if (w) w(s);
      else queue.push(s);
    });
    const next = () =>
      new Promise<string>((res, rej) => {
        const q = queue.shift();
        if (q !== undefined) return res(q);
        const timer = setTimeout(() => rej(new Error('沒有收到訊息')), 3_000);
        waiters.push((s) => {
          clearTimeout(timer);
          res(s);
        });
      });
    ws.on('open', () => resolve({ ws, next }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, headers: res.headers })));
    ws.on('error', reject);
  });
}

describe('Node 宿主的 C′ 即時通道', () => {
  it('權杖錯 → 升級失敗 401，帶 Cinder-Relay；不認得的家 → 403；沒開 C′ 的站 → 404', async () => {
    const p = port();
    await start(iotEnv(p));
    await expect(open(`ws://127.0.0.1:${p}/iot/v1/dev/${home.homeTag}/${blind}`, { Authorization: 'Bearer cit1_x' })).rejects.toMatchObject({
      status: 401,
      headers: { 'cinder-relay': '1' },
    });
    await expect(open(`ws://127.0.0.1:${p}/iot/v1/home/${'Q'.repeat(22)}`)).rejects.toMatchObject({ status: 403 });
    const plain = port();
    await start({ PORT: String(plain), DB_PATH: ':memory:' });
    await expect(open(`ws://127.0.0.1:${plain}/iot/v1/home/${home.homeTag}`)).rejects.toMatchObject({ status: 404 });
  });

  it('設備心跳回 hb-ack；手機指令 → 設備收到 cmd；設備 ack → 手機收到 25171；一般 Nostr 路徑不受影響', async () => {
    const p = port();
    await start(iotEnv(p));
    const dev = await open(`ws://127.0.0.1:${p}/iot/v1/dev/${home.homeTag}/${blind}`, { Authorization: `Bearer ${token}` });
    dev.ws.send(IOT_DEVICE_HEARTBEAT);
    expect(await dev.next()).toBe(IOT_DEVICE_HEARTBEAT_ACK);
    const phone = await open(`ws://127.0.0.1:${p}/iot/v1/home/${home.homeTag}`);
    phone.ws.send(JSON.stringify(['REQ', 'a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }]));
    expect(JSON.parse(await phone.next())[0]).toBe('EOSE');
    const now = Date.now();
    const env = sealIotEnvelope({ key, kid: 'lamp.0', dir: 'down', ctr: 1, ts: Math.floor(now / 1000), plaintext: 'ON' });
    const cmd: NostrEvent = finalizeEvent(
      {
        kind: IOT_KIND_COMMAND,
        created_at: Math.floor(now / 1000),
        tags: [['h', home.homeTag], ['p', getPublicKey(gwSk)], ['dv', blind]],
        content: encryptDM(JSON.stringify({ v: 1, type: 'dev-cmd', msgId: newIotMsgId(), ts: now, device: 'lamp', env }), operator, getPublicKey(gwSk)),
      },
      operator,
    );
    phone.ws.send(JSON.stringify(['EVENT', cmd]));
    expect(JSON.parse(await phone.next())).toEqual(['OK', cmd.id, true, '']);
    expect(parseIotDeviceFrame(await dev.next(), 'relay')?.t).toBe('cmd');
    const up = sealIotEnvelope({ key, kid: 'lamp.0', dir: 'up', ctr: 1, ts: Math.floor(Date.now() / 1000), plaintext: '{"status":"ok"}' });
    dev.ws.send(encodeIotDeviceFrame({ t: 'ack', env: up }));
    const [type, , ack] = JSON.parse(await phone.next()) as [string, string, NostrEvent];
    expect(type).toBe('EVENT');
    expect(parseIotBody(JSON.parse(decryptDM(ack.content, home.homeKey, ack.pubkey)))).toMatchObject({ type: 'dev-ack', device: 'lamp' });
    // 一般 Nostr 路徑照舊（NIP-42 挑戰）
    const main = await open(`ws://127.0.0.1:${p}/`);
    expect(JSON.parse(await main.next())[0]).toBe('AUTH');
  });

  it('同一台設備的新連線把舊的以 4409 關掉', async () => {
    const p = port();
    await start(iotEnv(p));
    const url = `ws://127.0.0.1:${p}/iot/v1/dev/${home.homeTag}/${blind}`;
    const first = await open(url, { Authorization: `Bearer ${token}` });
    const closed = new Promise<number>((r) => first.ws.on('close', (code) => r(code)));
    await open(url, { Authorization: `Bearer ${token}` });
    expect(await closed).toBe(4409);
  });
});
