// 「只訂閱、不寫入」的中繼（SDK ADR 0054；CinderSync G11 第 2 部分）：readUrls 與 durability.standby 搭配。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { RelayPool, type RelayStatus } from '../src/relay-pool.js';
import { SocketFactory, type FakeSocket } from './fake-socket.js';

const A = 'wss://a.example';
const S = 'wss://standby.example';

const writer = Identity.generate();
let counter = 0;
function wrap() {
  counter += 1;
  return writer.sign({ kind: 1059, created_at: 1_700_000_000 + counter, tags: [['p', writer.pubkey]], content: 'x' });
}

function answerLast(socket: FakeSocket, ok: boolean, reason = ''): void {
  const events = socket.sentOfType('EVENT');
  const event = events[events.length - 1]![1] as { id: string };
  socket.receive(['OK', event.id, ok, reason]);
}

describe('RelayPool：readUrls', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let statuses: Array<[string, RelayStatus]>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    factory = new SocketFactory();
    statuses = [];
    pool = new RelayPool({ urls: [A], readUrls: [S, A], createSocket: factory.create, reconnectDelaysMs: [100, 5000], publishTimeoutMs: 1000, standbyIdleMs: 60_000 });
    pool.onStatusChange((url, status) => statuses.push([url, status]));
    pool.connect();
    factory.latest(A).open();
    factory.latest(S).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('🔴 connect() 就連上、收常駐訂閱（事件交給同一個 handler、以 id 去重）；EOSE 只看主要中繼', () => {
    const events: string[] = [];
    let eose = 0;
    pool.subscribe([{ kinds: [1059] }], { onEvent: (e, url) => events.push(`${url}:${e.id.slice(0, 4)}`), onEose: () => (eose += 1) });
    const reqS = factory.latest(S).sentOfType('REQ');
    expect(reqS).toHaveLength(1);
    const id = String(reqS[0]![1]);
    const event = wrap();
    factory.latest(S).receive(['EVENT', id, event]);
    factory.latest(A).receive(['EVENT', id, event]);
    factory.latest(S).receive(['EOSE', id]);
    expect(eose).toBe(0);
    factory.latest(A).receive(['EOSE', id]);
    expect(eose).toBe(1);
    expect(events).toEqual([`${S}:${event.id.slice(0, 4)}`]);
    // 「在線」只看主要中繼
    expect([...pool.status().keys()]).toEqual([A]);
    expect(statuses.every(([url]) => url === A)).toBe(true);
    expect(pool.relayHealth().get(S)).toMatchObject({ standby: true, status: 'open' });
  });

  it('🔴 一般發布不寫給它；寫入集合不含它', async () => {
    const result = pool.publish(wrap());
    answerLast(factory.latest(A), true);
    expect(await result).toMatchObject({ accepted: [A] });
    expect(factory.latest(S).sentOfType('EVENT')).toHaveLength(0);
    expect(pool.writeSet(1059)).toEqual([A]);
  });

  it('🔴 durability.standby 列了它、主要中繼滿了 → 沿用同一條連線補發；閒置後離開寫入集合但不斷線', async () => {
    const result = pool.publish(wrap(), { durability: { minAccepted: 1, standby: [S] } });
    answerLast(factory.latest(A), false, 'blocked: ceiling: 已滿');
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.forUrl(S)).toHaveLength(1); // 沒有另開連線
    answerLast(factory.latest(S), true);
    const done = await result;
    expect(done.durability).toMatchObject({ satisfied: true, standbyUsed: [S], durable: [S] });
    expect(pool.writeSet(31438)).toEqual([A, S]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.writeSet(31438)).toEqual([A]);
    expect(factory.latest(S).readyState).toBe(1);
  });

  it('🔴 開始補發（進入寫入集合）與閒置（離開）都經健康狀態通知：watchRelayFileLimits 跟著重算（v0.44.0 修正）', async () => {
    const seen: Array<[string, string[]]> = [];
    pool.onRelayHealthChange((url) => seen.push([url, pool.writeSet(1060)]));
    const result = pool.publish(wrap(), { durability: { minAccepted: 1, standby: [S] } });
    answerLast(factory.latest(A), false, 'blocked: ceiling: 已滿');
    await vi.advanceTimersByTimeAsync(0);
    answerLast(factory.latest(S), true);
    await result;
    // 最後一次通知時，寫入集合已經含它（主要中繼被標成已滿）
    expect(seen.at(-1)).toEqual([S, [S]]);
    seen.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.at(-1)).toEqual([S, []]);
  });

  it('🔴 斷線照退避重連、補訂閱', async () => {
    pool.subscribe([{ kinds: [1059] }], { onEvent: () => undefined });
    factory.latest(S).fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory.forUrl(S)).toHaveLength(2);
    factory.latest(S).open();
    expect(factory.latest(S).sentOfType('REQ')).toHaveLength(1);
  });

  it('🔴 queryResult 也查它（事件合併）；answered 只算主要中繼，relays 標出 read', async () => {
    const query = pool.queryResult([{ kinds: [1059] }], 1000);
    await vi.advanceTimersByTimeAsync(0);
    const event = wrap();
    const reqS = factory.latest(S).sentOfType('REQ');
    const id = String(reqS[reqS.length - 1]![1]);
    factory.latest(S).receive(['EVENT', id, event]);
    factory.latest(S).receive(['EOSE', id]);
    await vi.advanceTimersByTimeAsync(1000);
    let outcome = await query;
    expect(outcome.events.map((e) => e.id)).toEqual([event.id]);
    expect(outcome.answered).toBe(0); // 主要中繼沒回
    expect(outcome.relays).toEqual([
      { url: A, status: 'timeout' },
      { url: S, status: 'eose', read: true },
    ]);

    const second = pool.queryResult([{ kinds: [1059] }], 1000);
    await vi.advanceTimersByTimeAsync(0);
    for (const url of [A, S]) {
      const reqs = factory.latest(url).sentOfType('REQ');
      factory.latest(url).receive(['EOSE', String(reqs[reqs.length - 1]![1])]);
    }
    outcome = await second;
    expect(outcome.answered).toBe(1);
  });

  it('🔴 主要中繼一座都沒開：waitForPrimary: false 時不等它，直接查開著的備援（SDK ADR 0093）', async () => {
    const lonely = new RelayPool({ urls: ['wss://down.example'], readUrls: [S], createSocket: factory.create, publishTimeoutMs: 1000 });
    lonely.connect();
    factory.latest(S).open();
    const query = lonely.queryResult([{ kinds: [1059] }], 1000, { waitForPrimary: false });
    await vi.advanceTimersByTimeAsync(0);
    const reqs = factory.latest(S).sentOfType('REQ');
    expect(reqs.length).toBeGreaterThan(0);
    factory.latest(S).receive(['EOSE', String(reqs[reqs.length - 1]![1])]);
    const outcome = await query;
    expect(outcome.relays).toContainEqual({ url: S, status: 'eose', read: true });
    lonely.close();
  });

  it('close() 全部關掉、之後 connect() 再連；lastActivityAt 也看得到它', async () => {
    factory.latest(S).receive(['NOTICE', 'hi']);
    expect(pool.lastActivityAt(S)).toBe(Date.now());
    pool.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(factory.forUrl(S)).toHaveLength(1);
    pool.connect();
    expect(factory.forUrl(S)).toHaveLength(2);
  });
});
