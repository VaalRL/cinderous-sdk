// C′ R4 長輪詢的 Node 宿主（SDK ADR 0138）：自架主機直接掛住 HTTP 回應（Node 沒有休眠計費的顧慮），與 Workers 版同一套端點與語意。
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { deriveIotHome } from '../../src/iot/keys.js';
import { encodeIotDeviceFrame, generateIotDeviceToken, hashIotDeviceToken, parseIotDeviceFrame } from '../../src/iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_QUERY } from '../../src/iot/kinds.js';
import { newIotMsgId, parseIotBody } from '../../src/iot/content.js';
import { sealIotEnvelope } from '../../src/iot/envelope.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

const home = deriveIotHome('66'.repeat(32));
const gwSk = generateSecretKey();
const operator = generateSecretKey();
const token = generateIotDeviceToken();
const blind = home.blind('dev:lamp');
const key = home.deviceKey('lamp', 0);

const iotEnv = (): Record<string, string> => ({
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
});

const handles: { close(): void }[] = [];
const sockets: WebSocket[] = [];
const aborts: AbortController[] = [];
afterEach(() => {
  for (const a of aborts.splice(0)) a.abort();
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const h of handles.splice(0)) h.close();
});

const start = (): Promise<number> => opened(handles, startNodeRelay({ ...iotEnv(), PORT: '0' }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 手機：訂閱 25171 並收集事件 */
async function phone(port: number): Promise<{ ws: WebSocket; events: NostrEvent[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/iot/v1/home/${home.homeTag}`);
  sockets.push(ws);
  const events: NostrEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'a', { kinds: [IOT_KIND_ACK], '#h': [home.homeTag] }])));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as unknown[];
      if (m[0] === 'EOSE') resolve();
      if (m[0] === 'EVENT') events.push(m[2] as NostrEvent);
    });
    ws.on('error', reject);
  });
  return { ws, events };
}

function devEvent(type: 'dev-cmd' | 'dev-link'): NostrEvent {
  const now = Date.now();
  const env = sealIotEnvelope({ key, kid: 'lamp.0', dir: 'down', ctr: 1, ts: Math.floor(now / 1000), plaintext: 'ON' });
  return finalizeEvent(
    {
      kind: type === 'dev-cmd' ? IOT_KIND_COMMAND : IOT_KIND_QUERY,
      created_at: Math.floor(now / 1000),
      tags: [['h', home.homeTag], ['p', getPublicKey(gwSk)], ['dv', blind]],
      content: encryptDM(JSON.stringify({ v: 1, type, msgId: newIotMsgId(), ts: now, device: 'lamp', ...(type === 'dev-cmd' ? { env } : {}) }), operator, getPublicKey(gwSk)),
    },
    operator,
  );
}

const open = (e: NostrEvent) => parseIotBody(JSON.parse(decryptDM(e.content, home.homeKey, e.pubkey))) as { type: string; status?: string; transport?: string; online?: boolean };
const base = (port: number) => `http://127.0.0.1:${port}/iot/v1/dev/${home.homeTag}/${blind}`;
const auth = { Authorization: `Bearer ${token}` };
function poll(port: number, wait = 10): { res: Promise<Response>; abort: () => void } {
  const a = new AbortController();
  aborts.push(a);
  const res = fetch(`${base(port)}/next?wait=${wait}`, { headers: auth, signal: a.signal });
  res.catch(() => undefined); // 測試自己中止的那一輪
  return { res, abort: () => a.abort() };
}
const up = (t: 'ack' | 'state', ctr: number) =>
  encodeIotDeviceFrame({ t, env: sealIotEnvelope({ key, kid: 'lamp.0', dir: 'up', ctr, ts: Math.floor(Date.now() / 1000), plaintext: '{"type":"ack","status":"ok"}' }) });

describe('Node 宿主的長輪詢（SDK ADR 0138）', () => {
  it('權杖錯 → 401＋Cinder-Relay；GET …/ack → 405；沒有 op 的一般 GET 仍是 426', async () => {
    const p = await start();
    const bad = await fetch(`${base(p)}/next`, { headers: { Authorization: 'Bearer cit1_x' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('cinder-relay')).toBe('1');
    expect((await fetch(`${base(p)}/ack`, { headers: auth })).status).toBe(405);
    expect((await fetch(base(p), { headers: auth })).status).toBe(426);
  });

  it('等待中手機下指令 → 200 cmd 幀；dev-link 回報 transport: longpoll', async () => {
    const p = await start();
    const ph = await phone(p);
    const first = poll(p, 30);
    await sleep(100);
    ph.ws.send(JSON.stringify(['EVENT', devEvent('dev-link')]));
    await sleep(100);
    expect(ph.events.map(open)).toEqual([expect.objectContaining({ status: 'ok', online: true, transport: 'longpoll' })]);
    ph.ws.send(JSON.stringify(['EVENT', devEvent('dev-cmd')]));
    const res = await first.res;
    expect(res.status).toBe(200);
    expect(res.headers.get('cinder-relay')).toBe('1');
    expect(parseIotDeviceFrame(await res.text(), 'relay')?.t).toBe('cmd');
  });

  it('設備斷了這一輪 → 空檔內的指令保留，下一輪立刻 200', async () => {
    const p = await start();
    const ph = await phone(p);
    const first = poll(p, 30);
    await sleep(100);
    first.abort();
    await first.res.catch(() => undefined);
    await sleep(100);
    ph.ws.send(JSON.stringify(['EVENT', devEvent('dev-cmd')]));
    await sleep(100);
    expect(ph.events).toEqual([]); // 沒有 offline
    const again = await poll(p, 30).res;
    expect(again.status).toBe(200);
    expect(parseIotDeviceFrame(await again.text(), 'relay')?.t).toBe('cmd');
  });

  it('同一台又開一輪 → 舊的 409；POST ack → 204、手機收到 25171；路徑與幀不符 → 400', async () => {
    const p = await start();
    const ph = await phone(p);
    const first = poll(p, 30);
    await sleep(100);
    const second = poll(p, 30);
    const r1 = await first.res;
    expect(r1.status).toBe(409);
    second.abort();
    const ok = await fetch(`${base(p)}/ack`, { method: 'POST', headers: auth, body: up('ack', 1) });
    expect(ok.status).toBe(204);
    await sleep(100);
    expect(ph.events.map(open).map((b) => b.type)).toEqual(['dev-ack']);
    const wrong = await fetch(`${base(p)}/state`, { method: 'POST', headers: auth, body: up('ack', 2) });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/^invalid: iot-frame:/);
  });
});
