// 設備端 connectIotDevice（SDK ADR 0120）以假的 WebSocket 測：時間窗、fail-closed、去重、計數器先存再送、心跳死線、額度與被擠掉的退讓。
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectIotDevice,
  generateIotDeviceToken,
  IOT_DEVICE_HEARTBEAT,
  IOT_DEVICE_HEARTBEAT_ACK,
  memoryIotDeviceCounterStore,
  type IotDeviceLinkInfo,
  type IotDeviceLinkState,
  type IotDeviceOptions,
  type IotDeviceSocket,
} from '../../src/iot/device.js';
import { encodeIotDeviceFrame, parseIotDeviceFrame } from '../../src/iot/device-frame.js';
import { parseIotUpMessage } from '../../src/iot/device-message.js';
import { openIotEnvelope, sealIotEnvelope } from '../../src/iot/envelope.js';
import { newIotMsgId } from '../../src/iot/content.js';

const key = new Uint8Array(32).fill(7);
const keyDown = new Uint8Array(32).fill(9);
const token = generateIotDeviceToken();

class FakeSocket implements IotDeviceSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.serverClose(code ?? 1000, reason ?? '');
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(text: string): void {
    this.onmessage?.({ data: text });
  }
  serverClose(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  /** 送出的 up 訊息（解開） */
  up(): { t: string; ctr: number; msg: ReturnType<typeof parseIotUpMessage> }[] {
    return this.sent
      .filter((s) => s !== IOT_DEVICE_HEARTBEAT)
      .map((s) => {
        const frame = parseIotDeviceFrame(s, 'device')!;
        if (frame.t === 'hb') throw new Error('hb');
        return { t: frame.t, ctr: frame.env.ctr, msg: parseIotUpMessage(openIotEnvelope(frame.env, key)) };
      });
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const conns: { close(): void }[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) c.close();
  vi.useRealTimers();
});

function setup(opts: Partial<IotDeviceOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const states: [IotDeviceLinkState, IotDeviceLinkInfo][] = [];
  const executed: string[] = [];
  const store = memoryIotDeviceCounterStore();
  const conn = connectIotDevice({
    url: 'wss://a.example/iot/v1/dev/h/d',
    token,
    deviceKey: key,
    kid: 'door.0',
    counterStore: store,
    onCommand: (cmd) => (executed.push(cmd.payload), { status: 'ok' }),
    onLinkState: (s, info) => states.push([s, info]),
    webSocket: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    reconnect: { minMs: 10, maxMs: 1_000 },
    ...opts,
  });
  conns.push(conn);
  return { conn, sockets, states, executed, store };
}

function down(t: 'cmd' | 'query', inner: Record<string, unknown>, o: { k?: Uint8Array; ts?: number; kid?: string } = {}): string {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const env = sealIotEnvelope({ key: o.k ?? key, kid: o.kid ?? 'door.0', dir: 'down', ctr: 1, ts, plaintext: JSON.stringify(inner) });
  return encodeIotDeviceFrame({ t, env });
}

const cmd = (payload: string, extra: Record<string, unknown> = {}) => ({ type: 'cmd', msgId: newIotMsgId(), topic: 'home/door/open', payload, enc: 'utf8', exp: Math.floor(Date.now() / 1000) + 15, ...extra });

describe('連線與標頭', () => {
  it('帶 Authorization: Bearer <權杖>；打開後回報 connected', async () => {
    const { sockets, states } = setup();
    expect(sockets[0]!.headers).toEqual({ Authorization: `Bearer ${token}` });
    sockets[0]!.open();
    expect(states.map(([s]) => s)).toEqual(['connecting', 'connected']);
  });

  it('權杖或 kid 格式不對：一開始就丟例外', () => {
    expect(() => setup({ token: 'abc' })).toThrow(/cit1_/);
    expect(() => setup({ kid: 'door' })).toThrow(/kid/);
  });
});

describe('指令', () => {
  it('執行、回 ack；同一個 msgId 重送 → 回同一個 ack、不再執行；ctr 嚴格遞增且先存再送', async () => {
    const { sockets, executed, store } = setup();
    sockets[0]!.open();
    const c = cmd('PULSE');
    sockets[0]!.receive(down('cmd', c));
    await flush();
    sockets[0]!.receive(down('cmd', c));
    await flush();
    expect(executed).toEqual(['PULSE']);
    const up = sockets[0]!.up();
    expect(up.map((u) => u.msg)).toEqual([
      { type: 'ack', inReplyTo: c.msgId, status: 'ok' },
      { type: 'ack', inReplyTo: c.msgId, status: 'ok' },
    ]);
    expect(up.map((u) => u.ctr)).toEqual([1, 2]);
    expect(store.value).toBe(2);
  });

  it('重開機：計數器從存下的值接著往上', async () => {
    const store = memoryIotDeviceCounterStore(41);
    const { sockets } = setup({ counterStore: store });
    sockets[0]!.open();
    sockets[0]!.receive(down('cmd', cmd('X')));
    await flush();
    expect(sockets[0]!.up()[0]!.ctr).toBe(42);
  });

  it('信封時間在時間窗外或內容已過期 → 不執行，回 rejected: expired', async () => {
    const { sockets, executed } = setup({ maxSkewSec: 15 });
    sockets[0]!.open();
    sockets[0]!.receive(down('cmd', cmd('OLD'), { ts: Math.floor(Date.now() / 1000) - 60 }));
    sockets[0]!.receive(down('cmd', cmd('EXPIRED', { exp: Math.floor(Date.now() / 1000) - 1 })));
    await flush();
    expect(executed).toEqual([]);
    expect(sockets[0]!.up().map((u) => u.msg)).toMatchObject([
      { status: 'rejected', reason: 'expired' },
      { status: 'rejected', reason: 'expired' },
    ]);
  });

  it('時鐘還沒同步 → 拒絕所有指令（fail-closed）', async () => {
    let synced = false;
    const { sockets, executed } = setup({ clockSynced: () => synced });
    sockets[0]!.open();
    sockets[0]!.receive(down('cmd', cmd('A')));
    await flush();
    synced = true;
    sockets[0]!.receive(down('cmd', cmd('B')));
    await flush();
    expect(executed).toEqual(['B']);
    expect(sockets[0]!.up()[0]!.msg).toMatchObject({ status: 'rejected', reason: 'clock-unsynced' });
  });

  it('門鎖類：cmd 只認 deviceKeyDown；以 deviceKey 做的指令解不開、什麼都不回；query 用 deviceKey', async () => {
    const { sockets, executed } = setup({ deviceKeyDown: keyDown, onQuery: () => ({ 'home/door/lock': 'LOCKED' }) });
    sockets[0]!.open();
    sockets[0]!.receive(down('cmd', cmd('FORGED'))); // deviceKey
    sockets[0]!.receive(down('cmd', cmd('REAL'), { k: keyDown }));
    const q = { type: 'query', msgId: newIotMsgId(), exp: Math.floor(Date.now() / 1000) + 15 };
    sockets[0]!.receive(down('query', q));
    sockets[0]!.receive(down('query', { ...q, msgId: newIotMsgId() }, { k: keyDown })); // 查詢幀以 down 金鑰：解不開
    await flush();
    expect(executed).toEqual(['REAL']);
    const up = sockets[0]!.up().map((u) => u.msg);
    expect(up).toHaveLength(2);
    expect(up[1]).toMatchObject({ type: 'ack', inReplyTo: q.msgId, status: 'ok', topics: { 'home/door/lock': { payload: 'LOCKED' } } });
  });

  it('幀與內容的種類不一致（query 幀裡包 cmd）、別台設備的 kid → 丟掉', async () => {
    const { sockets, executed } = setup();
    sockets[0]!.open();
    sockets[0]!.receive(down('query', cmd('SMUGGLED')));
    sockets[0]!.receive(down('cmd', cmd('OTHER'), { kid: 'lamp.0' }));
    await flush();
    expect(executed).toEqual([]);
    expect(sockets[0]!.sent).toEqual([]);
  });

  it('onCommand 丟例外 → 回 rejected: device-error', async () => {
    const { sockets } = setup({ onCommand: () => { throw new Error('boom'); }, onError: () => {} });
    sockets[0]!.open();
    sockets[0]!.receive(down('cmd', cmd('X')));
    await flush();
    expect(sockets[0]!.up()[0]!.msg).toMatchObject({ status: 'rejected', reason: 'device-error' });
  });
});

describe('狀態', () => {
  it('publishState：沒連線回 false（不排隊）；連上後送 state 幀', async () => {
    const { conn, sockets } = setup();
    expect(await conn.publishState({ 'home/door/lock': 'LOCKED' })).toBe(false);
    sockets[0]!.open();
    expect(await conn.publishState({ 'home/door/lock': 'LOCKED' })).toBe(true);
    expect(sockets[0]!.up()).toMatchObject([{ t: 'state', msg: { type: 'state', topics: { 'home/door/lock': { payload: 'LOCKED' } } } }]);
  });
});

describe('心跳與重連', () => {
  it('每 intervalSec 送 hb；收到 hb-ack 就繼續；timeoutSec 內沒回 → 關掉重連', async () => {
    vi.useFakeTimers();
    const { sockets, states } = setup({ heartbeat: { intervalSec: 30, timeoutSec: 10 } });
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.sent).toEqual([IOT_DEVICE_HEARTBEAT]);
    sockets[0]!.receive(IOT_DEVICE_HEARTBEAT_ACK);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.sent).toEqual([IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.closedWith?.code).toBe(4000);
    expect(states.at(-1)![0]).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('4429 iot-quota:<reset>：沒有備援 → 睡到重置時間；有備援 → 馬上換站', async () => {
    vi.useFakeTimers();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const a = setup();
    a.sockets[0]!.open();
    a.sockets[0]!.serverClose(4429, `iot-quota:${reset}`);
    const [state, info] = a.states.at(-1)!;
    expect(state).toBe('quota-exhausted');
    expect(info.reset).toBe(reset);
    expect(info.retryInMs).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.sockets).toHaveLength(1);

    const b = setup({ standbyUrls: ['wss://b.example/iot/v1/dev/h/d'] });
    b.sockets[0]!.open();
    b.sockets[0]!.serverClose(4429, `iot-quota:${reset}`);
    await vi.advanceTimersByTimeAsync(20);
    expect(b.sockets.map((s) => s.url)).toEqual(['wss://a.example/iot/v1/dev/h/d', 'wss://b.example/iot/v1/dev/h/d']);
  });

  it('4409（同一台設備的新連線擠掉這條）→ replaced，退到最長間隔', async () => {
    vi.useFakeTimers();
    const { sockets, states } = setup();
    sockets[0]!.open();
    sockets[0]!.serverClose(4409, 'replaced');
    expect(states.at(-1)).toEqual(['replaced', expect.objectContaining({ code: 4409, retryInMs: 1_000 })]);
  });

  it('升級失敗（沒打開就關了）→ relay-error，換下一站', async () => {
    vi.useFakeTimers();
    const { sockets, states } = setup({ standbyUrls: ['wss://b.example/x'] });
    sockets[0]!.serverClose(1006);
    expect(states.at(-1)![0]).toBe('relay-error');
    await vi.advanceTimersByTimeAsync(20);
    expect(sockets[1]!.url).toBe('wss://b.example/x');
  });

  it('close()：不再重連', async () => {
    vi.useFakeTimers();
    const { conn, sockets, states } = setup();
    sockets[0]!.open();
    conn.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)![0]).toBe('closed');
  });
});
