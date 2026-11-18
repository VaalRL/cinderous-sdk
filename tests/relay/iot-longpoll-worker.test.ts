// C′ R4 長輪詢的 Workers 宿主（SDK ADR 0138）：Worker 掛住 HTTP、DO 不掛。
// - `GET /iot/v1/dev/<homeTag>/<blindId>/next?wait=`：Worker 先驗權杖，再對 DO 開一條休眠式 WebSocket、自己 `setTimeout` 等；
//   DO 送出一個幀就關掉那條（一輪只回一個幀）。逾時 204；4429 → 503 結構化；4409 → 409。
// - `POST …/ack`、`POST …/state`：本體＝設備幀，成功 204；95% 分流時 `state` 回 503（遙測先丟，ack 照轉）。
// 以假的 DurableObjectState 與成對的假 WebSocket 跑真的程式路徑。
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeState, FakeWs, installWorkerFakes } from './iot-worker-fakes.js';
import { deriveIotHome } from '../../src/iot/keys.js';
import { encodeIotDeviceFrame, generateIotDeviceToken, hashIotDeviceToken, parseIotDeviceFrame } from '../../src/iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_STATE } from '../../src/iot/kinds.js';
import { newIotMsgId, parseIotBody } from '../../src/iot/content.js';
import { sealIotEnvelope } from '../../src/iot/envelope.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import worker, { IotHomeRoom, relayInfoFrom, type Env } from '../../src/relay/worker.js';

beforeAll(installWorkerFakes);

afterEach(() => {
  vi.useRealTimers();
});

const home = deriveIotHome('55'.repeat(32));
const gwSk = generateSecretKey();
const operator = generateSecretKey();
const lampToken = generateIotDeviceToken();
const lampBlind = home.blind('dev:lamp');
const lampKey = home.deviceKey('lamp', 0);
const QUOTA_KEY = 'cinder:iot-quota';

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    IOT_REALTIME: JSON.stringify({
      homes: [
        {
          homeTag: home.homeTag,
          homePub: home.homePub,
          gatewayPubkey: getPublicKey(gwSk),
          acl: [{ pubkey: getPublicKey(operator), role: 'operator' }],
          devices: [{ id: 'lamp', blindId: lampBlind, epoch: 0, tokenHash: hashIotDeviceToken(lampToken) }],
        },
      ],
    }),
    IOT_GATEWAY_KEYS: JSON.stringify({ [home.homeTag]: bytesToHex(gwSk) }),
    ...over,
  } as Env;
}

/** 一個家：Worker env（DO 命名空間指向同一顆 room）＋可以模擬休眠喚醒 */
function setup(over: Partial<Env> = {}, opts: { used?: number } = {}) {
  const state = new FakeState();
  if (opts.used !== undefined) state.kv.set(QUOTA_KEY, { day: Math.floor(Date.now() / 86_400_000) * 86_400, used: opts.used });
  const calls: string[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (req: Request) => {
        calls.push(`${req.method} ${new URL(req.url).pathname}`);
        await state.ready;
        return state.room!.fetch(req);
      },
    }),
  };
  const e = baseEnv({ IOT_HOME: ns as unknown as Env['IOT_HOME'], ...over });
  const wake = () => (state.room = new IotHomeRoom(state as unknown as DurableObjectState, e));
  wake();
  return { state, env: e, calls, wake, room: () => state.room! };
}

const base = `https://relay.example/iot/v1/dev/${home.homeTag}/${lampBlind}`;
const auth = { Authorization: `Bearer ${lampToken}` };
const next = (e: Env, wait = 10, headers: Record<string, string> = auth) => worker.fetch(new Request(`${base}/next?wait=${wait}`, { headers }), e);
const post = (e: Env, what: 'ack' | 'state', body: string, headers: Record<string, string> = auth) =>
  worker.fetch(new Request(`${base}/${what}`, { method: 'POST', headers, body }), e);

async function connectPhone(room: IotHomeRoom, state: FakeState): Promise<FakeWs> {
  const before = state.sockets.length;
  await room.fetch(new Request(`https://relay.example/iot/v1/home/${home.homeTag}`, { headers: { Upgrade: 'websocket' } }));
  const ws = state.sockets[before]!;
  ws.drain();
  room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(['REQ', 'a', { kinds: [IOT_KIND_ACK, IOT_KIND_STATE], '#h': [home.homeTag] }]));
  ws.drain();
  return ws;
}

function command(nowMs = Date.now()): NostrEvent {
  const env = sealIotEnvelope({ key: lampKey, kid: 'lamp.0', dir: 'down', ctr: 1, ts: Math.floor(nowMs / 1000), plaintext: 'ON' });
  return finalizeEvent(
    {
      kind: IOT_KIND_COMMAND,
      created_at: Math.floor(nowMs / 1000),
      tags: [['h', home.homeTag], ['p', getPublicKey(gwSk)], ['dv', lampBlind]],
      content: encryptDM(JSON.stringify({ v: 1, type: 'dev-cmd', msgId: newIotMsgId(), ts: nowMs, device: 'lamp', env }), operator, getPublicKey(gwSk)),
    },
    operator,
  );
}

const phoneSend = (room: IotHomeRoom, ws: FakeWs, msg: unknown[]) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
let upCtr = 0;
const upFrame = (t: 'ack' | 'state') =>
  encodeIotDeviceFrame({ t, env: sealIotEnvelope({ key: lampKey, kid: 'lamp.0', dir: 'up', ctr: ++upCtr, ts: Math.floor(Date.now() / 1000), plaintext: '{"type":"ack","status":"ok"}' }) });
const bodies = (ws: FakeWs) =>
  ws
    .drain()
    .map((m) => JSON.parse(m) as unknown[])
    .filter((m) => m[0] === 'EVENT')
    .map((m) => m[2] as NostrEvent)
    .map((ev) => parseIotBody(JSON.parse(decryptDM(ev.content, home.homeKey, ev.pubkey))) as { type: string; status?: string });
/** 讓 Worker 的 await 鏈跑完（DO fetch → 掛上監聽） */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('NIP-11：長輪詢照實宣告（SDK ADR 0138）', () => {
  it('cinder_iot.realtime.longpoll＝true', () => {
    const { env } = setup();
    expect(relayInfoFrom(env).cinder_iot).toEqual({ realtime: { ws: true, longpoll: true, heartbeat_sec: 30 } });
  });
});

describe('GET …/next', () => {
  it('權杖錯 → 401，不碰 DO；POST 也一樣', async () => {
    const { env, calls } = setup();
    const r = await next(env, 10, { Authorization: 'Bearer cit1_nope' });
    expect(r.status).toBe(401);
    expect(r.headers.get('Cinder-Relay')).toBe('1');
    expect((await post(env, 'ack', upFrame('ack'), {})).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('等待中手機下指令 → 200，本體＝cmd 幀；DO 送完就關掉那一條', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { env, state, room } = setup();
    const phone = await connectPhone(room(), state);
    const pending = next(env, 30);
    await settle();
    const lp = state.sockets.find((w) => w.tags.includes(`dev:${lampBlind}`))!;
    expect(lp.closed).toBe(false);
    phoneSend(room(), phone, ['EVENT', command()]);
    expect(bodies(phone)).toEqual([]); // 沒有 offline／stale
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('Cinder-Relay')).toBe('1');
    expect(parseIotDeviceFrame(await res.text(), 'relay')?.t).toBe('cmd');
    expect(lp.closed).toBe(true);
  });

  it('沒有指令 → 等到 wait 秒回 204；空檔內來的指令保留，下一輪直接 200（DO 不開 WebSocket）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { env, state, room } = setup();
    const phone = await connectPhone(room(), state);
    const pending = next(env, 10);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(204);
    expect(state.getWebSockets(`dev:${lampBlind}`)).toEqual([]);
    phoneSend(room(), phone, ['EVENT', command()]);
    expect(bodies(phone)).toEqual([]); // 空檔：保留，不回 offline
    const before = state.sockets.length;
    const again = await next(env, 10);
    expect(again.status).toBe(200);
    expect(parseIotDeviceFrame(await again.text(), 'relay')?.t).toBe('cmd');
    expect(state.sockets.length).toBe(before);
  });

  it('同一台設備又開一輪 → 舊的那輪 409 replaced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { env } = setup();
    const first = next(env, 30);
    await settle();
    const second = next(env, 30);
    await settle();
    const r1 = await first;
    expect(r1.status).toBe(409);
    expect(JSON.parse(await r1.text()).error).toMatch(/^restricted: iot-replaced:/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await second).status).toBe(204);
  });

  it('本家今日預算用完 → 503＋Cinder-Quota: home-budget＋Retry-After（DO 的結構化回應原樣轉出）', async () => {
    const { env } = setup({ IOT_HOME_DAILY_REQUESTS: '20' } as Partial<Env>, { used: 20 });
    const r = await next(env);
    expect(r.status).toBe(503);
    expect(r.headers.get('Cinder-Quota')).toBe('home-budget');
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('等待中預算用完（DO 以 4429 關掉）→ 503 home-budget，帶重置時間', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { env, state, room } = setup({ IOT_HOME_DAILY_REQUESTS: '20' } as Partial<Env>, { used: 17 });
    const pending = next(env, 30); // 18
    await settle();
    const phone = await connectPhone(room(), state); // 19、20 → 用完
    expect(phone.closed).toBe(true);
    const r = await pending;
    expect(r.status).toBe(503);
    expect(r.headers.get('Cinder-Quota')).toBe('home-budget');
    expect(JSON.parse(await r.text()).reset % 86_400).toBe(0);
  });
});

describe('POST …/ack、…/state', () => {
  it('ack → 204，手機收到 25171；🔴 休眠喚醒後也收得到（先還原手機的訂閱再扇出）', async () => {
    const { env, state, room, wake } = setup();
    const phone = await connectPhone(room(), state);
    wake(); // 新的 DO 實例、同一份 storage 與連線
    await new Promise((r) => setTimeout(r, 0));
    const res = await post(env, 'ack', upFrame('ack'));
    expect(res.status).toBe(204);
    expect(bodies(phone).map((b) => b.type)).toEqual(['dev-ack']);
  });

  it('路徑與幀的 t 不符、不是設備幀 → 400 invalid: iot-frame:；GET ack → 405', async () => {
    const { env } = setup();
    const wrong = await post(env, 'state', upFrame('ack'));
    expect(wrong.status).toBe(400);
    expect(JSON.parse(await wrong.text()).error).toMatch(/^invalid: iot-frame:/);
    expect((await post(env, 'ack', 'nope')).status).toBe(400);
    const get = await worker.fetch(new Request(`${base}/ack`, { headers: auth }), env);
    expect(get.status).toBe(405);
  });

  it('95% 分流：state → 503 Cinder-Quota: home-shed；ack 照轉', async () => {
    const { env, state, room } = setup({ IOT_HOME_DAILY_REQUESTS: '100' } as Partial<Env>, { used: 95 });
    const phone = await connectPhone(room(), state);
    const shed = await post(env, 'state', upFrame('state'));
    expect(shed.status).toBe(503);
    expect(shed.headers.get('Cinder-Quota')).toBe('home-shed');
    expect(Number(shed.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await post(env, 'ack', upFrame('ack'))).status).toBe(204);
    expect(bodies(phone).filter((b) => b.type === 'dev-ack')).toHaveLength(1);
  });
});

describe('既有的 WebSocket 設備：休眠喚醒後設備先送 ack', () => {
  it('🔴 手機仍收得到 25171（以前只在手機先送訊息時才還原訂閱）', async () => {
    const { state, room, wake } = setup();
    const before = state.sockets.length;
    await room().fetch(new Request(base, { headers: { Upgrade: 'websocket', ...auth } }));
    const dev = state.sockets[before]!;
    const phone = await connectPhone(room(), state);
    const woke = wake();
    await new Promise((r) => setTimeout(r, 0));
    woke.webSocketMessage(dev as unknown as WebSocket, upFrame('ack'));
    expect(bodies(phone).map((b) => b.type)).toEqual(['dev-ack']);
  });
});
