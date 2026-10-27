// 客戶端對中繼容量訊號的處理（SDK ADR 0042）：`warning: near-full:` 是健康狀態的軟標記、`warning: dropped:` 是 onRelayDropped。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { RelayPool, type RelayDroppedReport, type RelayHealthSnapshot, type RelayRejection } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const A = 'wss://a.example';
const B = 'wss://b.example';
const writer = Identity.generate();
let counter = 0;
const wrap = () => {
  counter += 1;
  return writer.sign({ kind: 1059, created_at: 1_700_000_000 + counter, tags: [['p', writer.pubkey]], content: 'x' });
};
const snapshot = () => {
  counter += 1;
  return writer.sign({ kind: 30_078, created_at: 1_700_000_000 + counter, tags: [['d', 'x']], content: 'y' });
};
const NEAR_FULL = 'warning: near-full: 80: 本站這一類資料的空間已用 80% 以上；建議另存一份到其他中繼';
const DROPPED = 'warning: dropped: 3: 1790000000: 1790086400: 本站因空間不足刪掉了 3 則寄給你、還沒送到的留言';

describe('RelayPool：容量訊號（SDK ADR 0042）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let changes: [string, RelayHealthSnapshot][];
  let dropped: RelayDroppedReport[];
  let rejects: [string, RelayRejection][];
  let problems: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    factory = new SocketFactory();
    changes = [];
    dropped = [];
    rejects = [];
    problems = [];
    pool = new RelayPool({
      urls: [A, B],
      createSocket: factory.create,
      publishTimeoutMs: 1000,
      onRelayDropped: (report) => dropped.push(report),
      onRelayReject: (url, r) => rejects.push([url, r]),
      onRelayProblem: (_url, reason) => problems.push(reason),
    });
    pool.onRelayHealthChange((url, health) => changes.push([url, health]));
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  async function publishWith(event: ReturnType<typeof wrap>, a: string, b = '') {
    const pending = pool.publish(event);
    factory.latest(A).receive(['OK', event.id, true, a]);
    factory.latest(B).receive(['OK', event.id, true, b]);
    return pending;
  }

  it('near-full：收下（耐久），那一類資料記一個軟標記；不是 marks、不影響發布與 durability', async () => {
    const result = await publishWith(wrap(), NEAR_FULL);
    expect(result).toEqual({ accepted: [A, B], rejected: [] }); // 結果形狀與 v0.33 相同
    const health = pool.relayHealth().get(A)!;
    expect(health.marks).toEqual([]);
    expect(health.nearFull).toEqual([{ plane: 'offline', percent: 80, at: 1_700_000_000_000 }]);
    expect(pool.relayHealth().get(B)!.nearFull).toBeUndefined();
    expect(changes.filter(([url]) => url === A)).toHaveLength(1);
    expect(rejects).toEqual([]);
    // 帶 durability 的發布照樣送 A，而且 A 算耐久收下
    const e = wrap();
    const pending = pool.publish(e, { durability: { minAccepted: 2 } });
    factory.latest(A).receive(['OK', e.id, true, NEAR_FULL]);
    factory.latest(B).receive(['OK', e.id, true, '']);
    expect((await pending).durability?.satisfied).toBe(true);
    expect(changes.filter(([url]) => url === A)).toHaveLength(1); // 同一級只是延長，不再通知
  });

  it('同一類下一次收下沒帶預警就清掉；別的類不受影響', async () => {
    await publishWith(wrap(), NEAR_FULL);
    await publishWith(snapshot(), NEAR_FULL);
    expect(pool.relayHealth().get(A)!.nearFull?.map((n) => n.plane).sort()).toEqual(['addressable', 'offline']);
    await publishWith(wrap(), '');
    expect(pool.relayHealth().get(A)!.nearFull?.map((n) => n.plane)).toEqual(['addressable']);
  });

  it('dropped：NOTICE 解析成 onRelayDropped（連線池層級），不是拒收、不是問題；健康狀態記最近一次', () => {
    factory.latest(A).receive(['NOTICE', DROPPED]);
    expect(dropped).toEqual([{ url: A, count: 3, since: 1_790_000_000, until: 1_790_086_400 }]);
    expect(rejects).toEqual([]);
    expect(problems).toEqual([]);
    expect(pool.relayHealth().get(A)!.lastDropped).toEqual({ count: 3, since: 1_790_000_000, until: 1_790_086_400, at: 1_700_000_000_000 });
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
  });

  it('其他 warning: 開頭的 NOTICE 也不算拒收（仍交給 onRelayProblem 記錄）', () => {
    factory.latest(A).receive(['NOTICE', 'warning: something-new: 未來的詞元']);
    expect(rejects).toEqual([]);
    expect(problems).toEqual(['warning: something-new: 未來的詞元']);
    factory.latest(A).receive(['NOTICE', 'rate-limited: ip: 太快']);
    expect(rejects.map(([, r]) => r.kind)).toEqual(['rate-limited']);
  });
});
