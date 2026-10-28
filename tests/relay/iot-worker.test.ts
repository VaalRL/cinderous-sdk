// C′ 的 Workers 宿主（SDK ADR 0049 §9.2、R1）：Worker 路由 `/iot/v1/home/<homeTag>`、`/iot/v1/dev/<homeTag>/<blindId>`，
// 家庭 DO `IotHomeRoom`（休眠式 WebSocket、心跳自動回覆、單一設備連線）。以假的 DurableObjectState 跑真的程式路徑。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
// 只匯入協定模組（不經 ./iot 的 index）：index 會帶進手機端的 RelayPool，它的 DOM WebSocket 型別在 Workers 設定下對不上
import { deriveIotHome } from '../../src/iot/keys.js';
import {
  encodeIotDeviceFrame,
  generateIotDeviceToken,
  hashIotDeviceToken,
  IOT_DEVICE_HEARTBEAT,
  IOT_DEVICE_HEARTBEAT_ACK,
  parseIotDeviceFrame,
} from '../../src/iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_RETAINED, IOT_KIND_STATE } from '../../src/iot/kinds.js';
import { newIotMsgId, parseIotBody } from '../../src/iot/content.js';
import { sealIotEnvelope } from '../../src/iot/envelope.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import worker, { IotHomeRoom, relayInfoFrom, type Env } from '../../src/relay/worker.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

class FakeWs {
  attachment: unknown = null;
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  tags: string[] = [];
  serializeAttachment(o: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(o));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  send(s: string): void {
    if (this.closed) throw new Error('closed');
    this.sent.push(s);
  }
  accept(): void {}
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  drain(): string[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}

class FakePair {
  0 = new FakeWs();
  1 = new FakeWs();
}

class FakeAutoResponse {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

class FakeState {
  sockets: FakeWs[] = [];
  alarm: number | null = null;
  autoResponse: FakeAutoResponse | undefined;
  heartbeatAt = new Map<FakeWs, Date>();
  kv = new Map<string, unknown>();
  private readonly db = new DatabaseSync(':memory:');
  storage = {
    sql: {
      exec: (query: string, ...bindings: (string | number | null)[]) => ({
        toArray: () => {
          const stmt = this.db.prepare(query);
          if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
          stmt.run(...bindings);
          return [];
        },
      }),
    },
    getAlarm: async () => this.alarm,
    setAlarm: async (t: number) => void (this.alarm = t),
    get: async <T>(k: string) => this.kv.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void this.kv.set(k, v),
  };
  blockConcurrencyWhile = async (fn: () => Promise<void>) => fn();
  acceptWebSocket(ws: FakeWs, tags: string[]): void {
    ws.tags = tags;
    this.sockets.push(ws);
  }
  getWebSockets(tag?: string): FakeWs[] {
    const live = this.sockets.filter((w) => !w.closed);
    return tag === undefined ? live : live.filter((w) => w.tags.includes(tag));
  }
  setWebSocketAutoResponse(pair: FakeAutoResponse): void {
    this.autoResponse = pair;
  }
  getWebSocketAutoResponseTimestamp(ws: FakeWs): Date | null {
    return this.heartbeatAt.get(ws) ?? null;
  }
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocketPair = FakePair;
  g.WebSocketRequestResponsePair = FakeAutoResponse;
  // Node 的 Response 不收 101（Workers 的 WebSocket 升級要用）：換成支援標頭與 text() 的替身
  g.Response = class {
    readonly status: number;
    readonly headers: Headers;
    constructor(
      readonly body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    async text(): Promise<string> {
      return typeof this.body === 'string' ? this.body : '';
    }
  };
});

const SECRET = '33'.repeat(32);
const home = deriveIotHome(SECRET);
const gwSk = generateSecretKey();
const operator = generateSecretKey();
const lampToken = generateIotDeviceToken();
const lampBlind = home.blind('dev:lamp');
const lampKey = home.deviceKey('lamp', 0);

function env(over: Partial<Env> = {}): Env {
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

/** 假的 DO 命名空間：記下 Worker 把請求轉給哪一顆 */
function namespace(room: () => IotHomeRoom) {
  const calls: string[] = [];
  return {
    calls,
    ns: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: (req: Request) => {
          calls.push(id);
          return room().fetch(req);
        },
      }),
    },
  };
}

const upgrade = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://relay.example${path}`, { headers: { Upgrade: 'websocket', ...headers } });

async function bodyOf(res: Response): Promise<{ status: number; json: { error?: string }; relay: string | null }> {
  return { status: res.status, json: JSON.parse(await res.text()), relay: res.headers.get('Cinder-Relay') };
}

describe('NIP-11 cinder_iot.realtime（SDK ADR 0120）', () => {
  it('有 IOT_HOME 綁定、至少一個家庭有效才宣告；不列家庭', () => {
    const ns = namespace(() => {
      throw new Error('不該碰 DO');
    }).ns as unknown as Env['IOT_HOME'];
    const doc = relayInfoFrom(env({ IOT_HOME: ns }));
    expect(doc.cinder_iot).toEqual({ realtime: { ws: true, longpoll: false, heartbeat_sec: 30 } });
    expect(JSON.stringify(doc)).not.toContain(home.homeTag);
    expect(relayInfoFrom(env()).cinder_iot).toBeUndefined(); // 沒有綁定
    expect(relayInfoFrom(env({ IOT_HOME: ns, IOT_GATEWAY_KEYS: '{}' })).cinder_iot).toBeUndefined(); // 家庭無效
  });
});

describe('Worker 路由（碰 DO 之前就擋）', () => {
  it('沒有開 C′（沒有 IOT_HOME 綁定或設定）→ 404 blocked: iot-disabled:，帶 Cinder-Relay', async () => {
    const r = await bodyOf(await worker.fetch(upgrade(`/iot/v1/home/${home.homeTag}`), {} as Env));
    expect(r).toMatchObject({ status: 404, relay: '1' });
    expect(r.json.error).toMatch(/^blocked: iot-disabled:/);
  });

  it('不在設定裡的家 → 403 restricted: iot-home:；權杖錯 → 401 restricted: iot-token:；都沒有碰 DO', async () => {
    const { ns, calls } = namespace(() => {
      throw new Error('不該碰 DO');
    });
    const e = env({ IOT_HOME: ns as unknown as Env['IOT_HOME'] });
    const homeless = await bodyOf(await worker.fetch(upgrade(`/iot/v1/home/${'Z'.repeat(22)}`), e));
    expect(homeless).toMatchObject({ status: 403 });
    expect(homeless.json.error).toMatch(/^restricted: iot-home:/);
    const badToken = await bodyOf(await worker.fetch(upgrade(`/iot/v1/dev/${home.homeTag}/${lampBlind}`, { Authorization: 'Bearer cit1_nope' }), e));
    expect(badToken).toMatchObject({ status: 401 });
    expect(badToken.json.error).toMatch(/^restricted: iot-token:/);
    expect(calls).toEqual([]);
  });

  it('合法的請求轉給 `iot:<homeTag>` 那顆 DO；不是 WebSocket 升級 → 426', async () => {
    const state = new FakeState();
    let room: IotHomeRoom | undefined;
    const { ns, calls } = namespace(() => (room ??= new IotHomeRoom(state as unknown as DurableObjectState, e)));
    const e = env({ IOT_HOME: ns as unknown as Env['IOT_HOME'] });
    const res = await worker.fetch(upgrade(`/iot/v1/dev/${home.homeTag}/${lampBlind}`, { Authorization: `Bearer ${lampToken}` }), e);
    expect(res.status).toBe(101);
    expect(calls).toEqual([`iot:${home.homeTag}`]);
    const plain = await worker.fetch(new Request(`https://relay.example/iot/v1/home/${home.homeTag}`), e);
    expect(plain.status).toBe(426);
  });
});

async function connectDevice(room: IotHomeRoom, state: FakeState): Promise<FakeWs> {
  const before = state.sockets.length;
  const res = await room.fetch(upgrade(`/iot/v1/dev/${home.homeTag}/${lampBlind}`, { Authorization: `Bearer ${lampToken}` }));
  expect(res.status).toBe(101);
  return state.sockets[before]!;
}

async function connectPhone(room: IotHomeRoom, state: FakeState): Promise<FakeWs> {
  const before = state.sockets.length;
  await room.fetch(upgrade(`/iot/v1/home/${home.homeTag}`));
  const ws = state.sockets[before]!;
  ws.drain(); // AUTH 挑戰
  return ws;
}

const phoneSend = (room: IotHomeRoom, ws: FakeWs, msg: unknown[]) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));

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

describe('家庭 DO（IotHomeRoom）', () => {
  it('建構時設定心跳自動回覆，字串與設備送的逐位元組相同（不喚醒 DO、不計費）', () => {
    const state = new FakeState();
    new IotHomeRoom(state as unknown as DurableObjectState, env());
    expect(state.autoResponse).toEqual(new FakeAutoResponse(IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK));
  });

  it('手機下指令 → 在線設備收到 cmd 幀；設備 ack → 手機收到 25171', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, env());
    const dev = await connectDevice(room, state);
    expect(dev.tags).toEqual([`dev:${lampBlind}`]);
    const phone = await connectPhone(room, state);
    phoneSend(room, phone, ['REQ', 'a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }]);
    phone.drain();
    const cmd = command();
    phoneSend(room, phone, ['EVENT', cmd]);
    expect(JSON.parse(phone.drain()[0]!)).toEqual(['OK', cmd.id, true, '']);
    const frame = parseIotDeviceFrame(dev.drain()[0]!, 'relay');
    expect(frame?.t).toBe('cmd');
    const up = sealIotEnvelope({ key: lampKey, kid: 'lamp.0', dir: 'up', ctr: 1, ts: Math.floor(Date.now() / 1000), plaintext: '{"status":"ok"}' });
    room.webSocketMessage(dev as unknown as WebSocket, encodeIotDeviceFrame({ t: 'ack', env: up }));
    const [, , ack] = JSON.parse(phone.drain()[0]!) as [string, string, NostrEvent];
    expect(ack.kind).toBe(IOT_KIND_ACK);
    expect(parseIotBody(JSON.parse(decryptDM(ack.content, home.homeKey, ack.pubkey)))).toMatchObject({ type: 'dev-ack', device: 'lamp' });
  });

  it('同一台設備只留一條連線：新的連上後舊的以 4409 關掉', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, env());
    const first = await connectDevice(room, state);
    const second = await connectDevice(room, state);
    expect(first.closed).toBe(true);
    expect(first.closeCode).toBe(4409);
    expect(second.closed).toBe(false);
  });

  it('心跳時間取平台的自動回覆時間戳；超過 3 倍間隔沒有心跳 → 指令回 stale、不送', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, env());
    const dev = await connectDevice(room, state);
    state.heartbeatAt.set(dev, new Date(Date.now() - 10 * 60_000));
    const phone = await connectPhone(room, state);
    phoneSend(room, phone, ['REQ', 'a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }]);
    phone.drain();
    phoneSend(room, phone, ['EVENT', command()]);
    const ackMsg = phone.drain().map((m) => JSON.parse(m) as unknown[]).find((m) => m[0] === 'EVENT') as [string, string, NostrEvent];
    expect(parseIotBody(JSON.parse(decryptDM(ackMsg[2].content, home.homeKey, ackMsg[2].pubkey)))).toMatchObject({ status: 'stale' });
    expect(dev.drain()).toEqual([]);
  });

  it('休眠喚醒（新的 DO 實例、同一份 storage）：仍認得這是哪個家，設備連線照常轉送', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, env());
    const dev = await connectDevice(room, state);
    const phone = await connectPhone(room, state);
    phoneSend(room, phone, ['REQ', 'a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }]);
    phone.drain();
    const woke = new IotHomeRoom(state as unknown as DurableObjectState, env());
    await new Promise((r) => setTimeout(r, 0));
    phoneSend(woke, phone, ['EVENT', command()]);
    expect(parseIotDeviceFrame(dev.drain()[0]!, 'relay')?.t).toBe('cmd');
  });
});

describe('家庭預算（ADR 0049 §10.3）', () => {
  it('80% → owner 收到 $sys/quota 預警；95% → 設備的狀態幀被丟掉、ack 照轉；100% → 所有連線以 4429 關掉、新升級回 503 結構化', async () => {
    const state = new FakeState();
    const e = env({ IOT_HOME_DAILY_REQUESTS: '20' } as Partial<Env>);
    const room = new IotHomeRoom(state as unknown as DurableObjectState, e);
    const dev = await connectDevice(room, state); // 1
    const phone = await connectPhone(room, state); // 2
    phoneSend(room, phone, ['REQ', 's', { kinds: [IOT_KIND_STATE], '#h': [home.homeTag] }]); // 3
    phone.drain();
    let ctr = 0;
    const stateFrame = () =>
      encodeIotDeviceFrame({ t: 'state', env: sealIotEnvelope({ key: lampKey, kid: 'lamp.0', dir: 'up', ctr: ++ctr, ts: Math.floor(Date.now() / 1000), plaintext: 'x' }) });
    const events = () => phone.drain().map((m) => JSON.parse(m) as unknown[]).filter((m) => m[0] === 'EVENT').map((m) => m[2] as NostrEvent);
    const bodies = () => events().map((ev) => parseIotBody(JSON.parse(decryptDM(ev.content, home.homeKey, ev.pubkey))) as { type: string; topic?: string; payload?: string });
    for (let i = 0; i < 12; i++) room.webSocketMessage(dev as unknown as WebSocket, stateFrame()); // 4–15
    expect(bodies().filter((b) => b.type === 'dev-state')).toHaveLength(12);
    room.webSocketMessage(dev as unknown as WebSocket, stateFrame()); // 16 → 80%
    const atWarn = bodies();
    expect(atWarn.find((b) => b.topic === '$sys/quota')).toMatchObject({ type: 'state' });
    expect(JSON.parse(atWarn.find((b) => b.topic === '$sys/quota')!.payload!)).toMatchObject({ state: 'warn', limit: 20 });
    room.webSocketMessage(dev as unknown as WebSocket, stateFrame()); // 17
    room.webSocketMessage(dev as unknown as WebSocket, stateFrame()); // 18
    expect(bodies().filter((b) => b.type === 'dev-state')).toHaveLength(2); // 80% 只預警、不分流
    room.webSocketMessage(dev as unknown as WebSocket, stateFrame()); // 19 → 95%（分流）：這一則狀態被丟掉，只有預警
    const atShed = bodies();
    expect(atShed.filter((b) => b.type === 'dev-state')).toHaveLength(0);
    expect(JSON.parse(atShed.find((b) => b.topic === '$sys/quota')!.payload!)).toMatchObject({ state: 'shed' });
    room.webSocketMessage(dev as unknown as WebSocket, stateFrame()); // 20 → 100%
    expect(dev.closed).toBe(true);
    expect(dev.closeCode).toBe(4429);
    expect(phone.closed).toBe(true);
    const res = await room.fetch(upgrade(`/iot/v1/home/${home.homeTag}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('Cinder-Quota')).toBe('home-budget');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = JSON.parse(await res.text()) as { error: string; reset: number };
    expect(body.error).toMatch(/^rate-limited: iot-quota:/);
    expect(body.reset % 86_400).toBe(0);
  });

  it('預算寫回 storage，休眠喚醒後接著算（不是歸零）', async () => {
    const state = new FakeState();
    const e = env({ IOT_HOME_DAILY_REQUESTS: '1000' } as Partial<Env>);
    const room = new IotHomeRoom(state as unknown as DurableObjectState, e);
    const dev = await connectDevice(room, state);
    for (let i = 0; i < 70; i++) room.webSocketMessage(dev as unknown as WebSocket, IOT_DEVICE_HEARTBEAT);
    const saved = state.kv.get('cinder:iot-quota') as { used: number } | undefined;
    expect(saved?.used).toBeGreaterThanOrEqual(64);
  });
});

describe('Worker 捕捉 DO 超量例外（ADR 0049 §10.3 第 2 點）', () => {
  it('stub.fetch 丟 Exceeded allowed volume → 503＋Cinder-Quota: do-requests＋Retry-After 到 UTC 午夜', async () => {
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: () => Promise.reject(new Error('Exceeded allowed volume of requests in Durable Objects free tier')),
      }),
    };
    const res = await worker.fetch(upgrade(`/iot/v1/home/${home.homeTag}`), env({ IOT_HOME: ns as unknown as Env['IOT_HOME'] }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Cinder-Quota')).toBe('do-requests');
    expect(res.headers.get('Cinder-Relay')).toBe('1');
    const other = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: () => Promise.reject(new Error('boom')) }),
    };
    const generic = await worker.fetch(upgrade(`/iot/v1/home/${home.homeTag}`), env({ IOT_HOME: other as unknown as Env['IOT_HOME'] }));
    expect(generic.status).toBe(503);
    expect(generic.headers.get('Cinder-Quota')).toBeNull();
  });
});

describe('名單公告與每家的可尋址上限（SDK ADR 0121）', () => {
  const lamps = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].map((id) => ({ id, token: generateIotDeviceToken(), blind: home.blind(`dev:${id}`) }));
  const aclBlindId = home.blind('sys:acl');
  const wideEnv = (): Env =>
    env({
      IOT_REALTIME: JSON.stringify({
        homes: [
          {
            homeTag: home.homeTag,
            homePub: home.homePub,
            gatewayPubkey: getPublicKey(gwSk),
            aclBlindId,
            acl: [{ pubkey: getPublicKey(operator), role: 'operator' }],
            devices: lamps.map((l) => ({ id: l.id, blindId: l.blind, epoch: 0, tokenHash: hashIotDeviceToken(l.token) })),
          },
        ],
      }),
    });
  const query = (room: IotHomeRoom, phone: FakeWs, filter: Record<string, unknown>): NostrEvent[] => {
    phone.drain();
    phoneSend(room, phone, ['REQ', 'q', filter]);
    return phone
      .drain()
      .map((m) => JSON.parse(m) as unknown[])
      .filter((m) => m[0] === 'EVENT')
      .map((m) => m[2] as NostrEvent);
  };

  it('手機連上後 relay 以 31170 公告角色名單（d＝aclBlindId、加密給全家、閘道簽名）', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, wideEnv());
    const phone = await connectPhone(room, state);
    const [announce] = query(room, phone, { kinds: [IOT_KIND_RETAINED], '#d': [aclBlindId] });
    expect(announce?.pubkey).toBe(getPublicKey(gwSk));
    expect(announce?.tags).toEqual(expect.arrayContaining([['d', aclBlindId], ['h', home.homeTag]]));
    const body = JSON.parse(decryptDM(announce!.content, home.homeKey, announce!.pubkey)) as { type: string; acl: { entries: { pubkey: string; role: string }[] } };
    expect(body.type).toBe('acl');
    expect(body.acl.entries).toEqual([expect.objectContaining({ pubkey: getPublicKey(operator), role: 'operator' })]);
  });

  it('沒有 aclBlindId 就不公告', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, env());
    const phone = await connectPhone(room, state);
    expect(query(room, phone, { kinds: [IOT_KIND_RETAINED] })).toEqual([]);
  });

  it('🔴 六台設備的 retained 全部留下（嚴格平面的 5 筆上限不適用於家庭）', async () => {
    const state = new FakeState();
    const room = new IotHomeRoom(state as unknown as DurableObjectState, wideEnv());
    for (const l of lamps) {
      const before = state.sockets.length;
      const res = await room.fetch(upgrade(`/iot/v1/dev/${home.homeTag}/${l.blind}`, { Authorization: `Bearer ${l.token}` }));
      expect(res.status).toBe(101);
      const dev = state.sockets[before]!;
      const up = sealIotEnvelope({ key: home.deviceKey(l.id, 0), kid: `${l.id}.0`, dir: 'up', ctr: 1, ts: Math.floor(Date.now() / 1000), plaintext: JSON.stringify({ type: 'state', topics: { [`home/${l.id}`]: 'ON' } }) });
      room.webSocketMessage(dev as unknown as WebSocket, encodeIotDeviceFrame({ t: 'state', env: up }));
    }
    const phone = await connectPhone(room, state);
    const retained = query(room, phone, { kinds: [IOT_KIND_RETAINED], '#d': lamps.map((l) => l.blind) });
    expect(new Set(retained.map((e) => e.tags.find((t) => t[0] === 'd')![1]))).toEqual(new Set(lamps.map((l) => l.blind)));
  });
});
