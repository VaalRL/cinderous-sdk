// 每座中繼的健康狀態、耐久度要求與延遲連線的備援、queryEach（SDK ADR 0038 P1；ADR 0041）。
// 多座假中繼：有的滿、有的限速、有的正常；假計時器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { classifyRelayMessage, parseBorrowedWarning } from '../src/protocol/relay-reject.js';
import { RelayPool, type RelayHealthSnapshot } from '../src/relay-pool.js';
import { SocketFactory, type FakeSocket } from './fake-socket.js';

const A = 'wss://a.example';
const B = 'wss://b.example';
const S1 = 'wss://standby-1.example';
const S2 = 'wss://standby-2.example';

const writer = Identity.generate();
let counter = 0;
/** kind 1059（離線留言那一類） */
function wrap(content = 'x') {
  counter += 1;
  return writer.sign({ kind: 1059, created_at: 1_700_000_000 + counter, tags: [['p', writer.pubkey]], content });
}
function addressable(d: string) {
  counter += 1;
  return writer.sign({ kind: 31438, created_at: 1_700_000_000 + counter, tags: [['d', d]], content: 'bucket' });
}

const CEILING = 'blocked: ceiling: 本站離線留言空間已滿';
const BORROWED = 'warning: borrowed: 7200: 本站空間暫時不足，這則只保存 2 小時';

/** 對某座送出的 EVENT 回 OK（最新那一顆） */
function answer(socket: FakeSocket, ok: boolean, reason = ''): void {
  const events = socket.sentOfType('EVENT');
  const event = events[events.length - 1]![1] as { id: string };
  socket.receive(['OK', event.id, ok, reason]);
}

describe('RelayPool：健康狀態（ADR 0041 §1）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let changes: [string, RelayHealthSnapshot][];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    factory = new SocketFactory();
    changes = [];
    pool = new RelayPool({ urls: [A, B], createSocket: factory.create, reconnectDelaysMs: [100, 5000], publishTimeoutMs: 1000 });
    pool.onRelayHealthChange((url, health) => changes.push([url, health]));
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('ceiling → 那一類（離線留言）標成已滿 1 小時；重複拒收只通知一次；過期後自己消失', async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = pool.publish(wrap());
      answer(factory.latest(A), true);
      answer(factory.latest(B), false, CEILING);
      await result;
    }
    const health = pool.relayHealth().get(B)!;
    expect(health.marks).toEqual([
      expect.objectContaining({ scope: 'offline', state: 'full', kind: 'ceiling', until: Date.now() + 3_600_000 }),
    ]);
    expect(health.lastRejection).toMatchObject({ kind: 'ceiling', reason: CEILING });
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
    expect(pool.relayHealth().get(A)!.lastAcceptedAt).toBe(Date.now());
    expect(changes.filter(([url]) => url === B)).toHaveLength(1);
    // 可尋址是另一個天花板：不受影響
    expect(pool.writeSet(31438)).toEqual([A, B]);
    expect(pool.writeSet(1059)).toEqual([A]);
    vi.advanceTimersByTime(3_600_000);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
    expect(pool.writeSet(1059)).toEqual([A, B]);
  });

  it('quota（可尋址）→ 可尋址那一類已滿；之後任何一次收下就清掉（恢復）', async () => {
    let result = pool.publish(addressable('b1'));
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, 'blocked: quota: 可尋址位址已滿（64／kind）');
    await result;
    expect(pool.relayHealth().get(B)!.marks).toEqual([expect.objectContaining({ scope: 'addressable', state: 'full', kind: 'quota' })]);
    result = pool.publish(addressable('b2')); // 預設發布照舊送給 B（不看健康狀態）
    answer(factory.latest(A), true);
    answer(factory.latest(B), true);
    await result;
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
    expect(changes.filter(([url]) => url === B)).toHaveLength(2); // 標記、清掉
  });

  it('rate-limited → 整座退避到計數窗結束（每分鐘 60 秒；ip 詞元 1 秒）', async () => {
    let result = pool.publish(wrap());
    answer(factory.latest(A), false, 'rate-limited: events: 發送過於頻繁');
    answer(factory.latest(B), false, 'rate-limited: ip: 每秒訊息過多');
    await result;
    expect(pool.relayHealth().get(A)!.marks).toEqual([expect.objectContaining({ scope: '*', state: 'backoff', until: Date.now() + 60_000 })]);
    expect(pool.relayHealth().get(B)!.marks).toEqual([expect.objectContaining({ scope: '*', state: 'backoff', until: Date.now() + 1000 })]);
    vi.advanceTimersByTime(1000);
    expect(pool.writeSet(1059)).toEqual([B]);
    result = pool.publish(wrap());
    answer(factory.latest(A), true); // 收下也清掉退避
    answer(factory.latest(B), true);
    await result;
    expect(pool.writeSet(1059)).toEqual([A, B]);
  });

  it('政策不合 → 那個 kind 不適用；too-large → 那個 kind、這麼大以上的不適用', async () => {
    let result = pool.publish(wrap());
    answer(factory.latest(A), false, 'blocked: kind-disabled: 此事件類型已被政策停用');
    answer(factory.latest(B), false, 'blocked: too-large: 事件過大');
    await result;
    expect(pool.relayHealth().get(A)!.marks).toEqual([expect.objectContaining({ scope: 'kind:1059', state: 'inapplicable', kind: 'policy' })]);
    const tooLarge = pool.relayHealth().get(B)!.marks[0]!;
    expect(tooLarge).toMatchObject({ scope: 'kind:1059', state: 'inapplicable', kind: 'too-large' });
    expect(tooLarge.minBytes).toBeGreaterThan(100);
    expect(pool.writeSet(1059, tooLarge.minBytes! - 1)).toEqual([B]); // 小一點的照送
    expect(pool.writeSet(1059, tooLarge.minBytes!)).toEqual([]);
    expect(pool.writeSet(1060)).toEqual([A, B]); // 別的 kind 不受影響
    pool.resetRelayHealth();
    expect(pool.writeSet(1059, 1e9)).toEqual([A, B]);
  });

  it('auth-failed（AUTH 事件本身被拒，多半暫時）不標記；restricted: not-allowed 標那個 kind 不適用', async () => {
    const result = pool.publish(wrap());
    answer(factory.latest(A), false, 'auth-failed: too-old: 認證事件過舊');
    answer(factory.latest(B), false, 'restricted: not-allowed: 非本企業成員');
    await result;
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
    expect(pool.relayHealth().get(B)!.marks).toEqual([expect.objectContaining({ scope: 'kind:1059', state: 'inapplicable', kind: 'restricted' })]);
  });

  it('invalid → 自己的錯：不標記（只記最近一次拒收）', async () => {
    const result = pool.publish(wrap());
    answer(factory.latest(A), false, 'invalid: clock-skew: 時戳超出範圍');
    answer(factory.latest(B), true);
    await result;
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
    expect(pool.relayHealth().get(A)!.lastRejection).toMatchObject({ kind: 'invalid' });
    expect(changes).toEqual([]);
  });

  it('關閉碼：1008 rate-limited → 整座退避；4003 → 整座不適用', () => {
    factory.latest(A).serverClose(1008, 'rate-limited: messages');
    factory.latest(B).serverClose(4003, 'restricted: not-allowed');
    expect(pool.relayHealth().get(A)!.marks).toEqual([expect.objectContaining({ scope: '*', state: 'backoff', kind: 'rate-limited' })]);
    expect(pool.relayHealth().get(B)!.marks).toEqual([expect.objectContaining({ scope: '*', state: 'inapplicable', kind: 'restricted' })]);
    expect(pool.writeSet(1059)).toEqual([]);
  });

  it('borrowed：收下但記成借用；PublishResult 多一個 borrowed 欄位（只有借用時才有）', async () => {
    const result = pool.publish(wrap());
    answer(factory.latest(A), true, BORROWED);
    answer(factory.latest(B), true);
    expect(await result).toEqual({ accepted: [A, B], rejected: [], borrowed: [A] });
    expect(pool.relayHealth().get(A)!.lastBorrowedAt).toBe(Date.now());
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
  });
});

describe('classifyRelayMessage：warning: borrowed（SDK ADR 0039；客戶端先認得）', () => {
  it('分成 borrowed、帶保存秒數；不是拒收的前綴', () => {
    expect(classifyRelayMessage(BORROWED)).toMatchObject({ prefix: 'warning', token: 'borrowed', kind: 'borrowed', tryOtherRelays: true });
    expect(parseBorrowedWarning(BORROWED)).toEqual({ ttlSec: 7200 });
    expect(parseBorrowedWarning('warning: borrowed: 暫存')).toEqual({ ttlSec: undefined });
    expect(parseBorrowedWarning('duplicate: seen: 重複')).toBeUndefined();
    expect(classifyRelayMessage('warning: ceiling: 92%').kind).toBe('unknown');
  });
});

describe('RelayPool：耐久度要求與備援（ADR 0041 §2）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    factory = new SocketFactory();
    pool = new RelayPool({
      urls: [A, B],
      createSocket: factory.create,
      reconnectDelaysMs: [100, 5000],
      publishTimeoutMs: 1000,
      standbyIdleMs: 30_000,
    });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('🔴 預設（不帶 durability）與 v0.32 相同：被標記的中繼照送、結果形狀不變、不連備援', async () => {
    let result = pool.publish(wrap());
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, CEILING);
    await result;
    const event = wrap();
    result = pool.publish(event);
    expect(factory.latest(B).sentOfType('EVENT').at(-1)).toEqual(['EVENT', JSON.parse(JSON.stringify(event))]);
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, CEILING);
    const out = await result;
    expect(Object.keys(out).sort()).toEqual(['accepted', 'rejected']);
    expect(out.accepted).toEqual([A]);
    expect(factory.sockets.map((s) => s.url)).toEqual([A, B]);
  });

  it('minAccepted 預設 1：夠了就不連備援', async () => {
    const result = pool.publish(wrap(), { durability: { standby: [S1] } });
    await vi.advanceTimersByTimeAsync(0);
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, CEILING);
    const out = await result;
    expect(out.durability).toMatchObject({ minAccepted: 1, durable: [A], satisfied: true, standbyUsed: [], relaysFull: false });
    expect(out.durability!.relays).toEqual([
      { url: A, standby: false, outcome: 'accepted' },
      expect.objectContaining({ url: B, standby: false, outcome: 'rejected', kind: 'ceiling' }),
    ]);
    expect(factory.forUrl(S1)).toEqual([]);
  });

  it('🔴 不足 minAccepted 才延遲連上備援、只補發那一則；不送常駐訂閱；閒置後斷線、不重連', async () => {
    pool.subscribe([{ kinds: [1059], '#p': [writer.pubkey] }], { onEvent: () => {} });
    const event = wrap();
    const result = pool.publish(event, { durability: { minAccepted: 2, standby: [S1, S2] } });
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, CEILING);
    await vi.advanceTimersByTimeAsync(0);
    // 備援現在才連
    expect(factory.forUrl(S1)).toHaveLength(1);
    factory.latest(S1).open();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.latest(S1).sentOfType('EVENT')).toEqual([['EVENT', JSON.parse(JSON.stringify(event))]]);
    expect(factory.latest(S1).sentOfType('REQ')).toEqual([]);
    answer(factory.latest(S1), true);
    const out = await result;
    expect(out.durability).toMatchObject({ durable: [A, S1], satisfied: true, standbyUsed: [S1], relaysFull: false });
    expect(out.accepted).toEqual([A, S1]);
    expect(factory.forUrl(S2)).toEqual([]); // 夠了就不再往下
    expect(pool.status().has(S1)).toBe(false); // status() 只列主要中繼
    expect(pool.relayHealth().get(S1)).toMatchObject({ standby: true, status: 'open' });
    expect(pool.writeSet(1059)).toEqual([A, S1]);

    vi.advanceTimersByTime(30_000);
    expect(pool.relayHealth().get(S1)).toMatchObject({ status: 'closed' });
    vi.advanceTimersByTime(60_000);
    expect(factory.forUrl(S1)).toHaveLength(1); // 沒有重連
    expect(pool.writeSet(1059)).toEqual([A]);
  });

  describe('🔴 standbyWhenDisconnected（SDK ADR 0078）：主要中繼只是沒連線時要不要改用備援', () => {
    const offline = () =>
      new RelayPool({ urls: [A, B], createSocket: factory.create, reconnectDelaysMs: [100, 5000], publishTimeoutMs: 1000, standbyIdleMs: 30_000 });

    it('false：主要中繼一座都沒開（排程模式兩輪之間）→ 不連備援、照實回報沒送到（讓呼叫端記成待送）', async () => {
      const idle = offline(); // 沒有 connect()
      const out = await idle.publish(wrap(), { durability: { standby: [S1], standbyWhenDisconnected: false } });
      expect(factory.forUrl(S1)).toEqual([]);
      expect(out.durability).toMatchObject({ satisfied: false, standbyUsed: [] });
      expect(out.durability!.relays.map((r) => r.outcome)).toEqual(['not-connected', 'not-connected']);
      idle.close();
    });

    it('預設 true：與之前相同，主要中繼沒連線也改用備援', async () => {
      const idle = offline();
      const result = idle.publish(wrap(), { durability: { standby: [S1] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(factory.forUrl(S1)).toHaveLength(1);
      factory.latest(S1).open();
      await vi.advanceTimersByTimeAsync(0);
      answer(factory.latest(S1), true);
      expect((await result).durability).toMatchObject({ satisfied: true, standbyUsed: [S1] });
      idle.close();
    });

    it('false：主要中繼開著但拒收（滿了）→ 照舊改用備援（ADR 0041 的情境不變）', async () => {
      const result = pool.publish(wrap(), { durability: { standby: [S1], standbyWhenDisconnected: false } });
      answer(factory.latest(A), false, CEILING);
      answer(factory.latest(B), false, CEILING);
      await vi.advanceTimersByTimeAsync(0);
      expect(factory.forUrl(S1)).toHaveLength(1);
      factory.latest(S1).open();
      await vi.advanceTimersByTimeAsync(0);
      answer(factory.latest(S1), true);
      expect((await result).durability).toMatchObject({ satisfied: true, standbyUsed: [S1] });
    });
  });

  it('沒給 standby：不足也不連任何新的中繼（決策 6）', async () => {
    const result = pool.publish(wrap(), { durability: { minAccepted: 2 } });
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, CEILING);
    const out = await result;
    expect(out.durability).toMatchObject({ satisfied: false, relaysFull: true, standbyUsed: [] });
    expect(factory.sockets.map((s) => s.url)).toEqual([A, B]);
  });

  it('🔴 warning: borrowed 不計入 minAccepted：觸發備援', async () => {
    const result = pool.publish(wrap(), { durability: { standby: [S1] } });
    answer(factory.latest(A), true, BORROWED);
    answer(factory.latest(B), false, CEILING);
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S1).open();
    await vi.advanceTimersByTimeAsync(0);
    answer(factory.latest(S1), true);
    const out = await result;
    expect(out.borrowed).toEqual([A]);
    expect(out.accepted).toEqual([A, S1]);
    expect(out.durability).toMatchObject({ durable: [S1], satisfied: true });
    expect(out.durability!.relays[0]).toMatchObject({ url: A, outcome: 'borrowed' });
  });

  it('只有借用、沒有備援 → 不滿足，而且算「滿了」', async () => {
    const result = pool.publish(wrap(), { durability: {} });
    answer(factory.latest(A), true, BORROWED);
    answer(factory.latest(B), true, BORROWED);
    const out = await result;
    expect(out.durability).toMatchObject({ satisfied: false, relaysFull: true, durable: [] });
  });

  it('🔴 全部都滿（含備援）：回報 relaysFull；之後冷卻期間一則都不送（沒有重試風暴）；冷卻過後才再試', async () => {
    const changes: string[] = [];
    pool.onRelayHealthChange((url, h) => changes.push(`${url}:${h.marks.map((m) => m.state).join(',')}`));
    const first = pool.publish(wrap(), { durability: { standby: [S1] } });
    answer(factory.latest(A), false, CEILING);
    answer(factory.latest(B), false, CEILING);
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S1).open();
    await vi.advanceTimersByTimeAsync(0);
    answer(factory.latest(S1), false, CEILING);
    expect((await first).durability).toMatchObject({ satisfied: false, relaysFull: true });

    const sentBefore = factory.sockets.reduce((n, s) => n + s.sentOfType('EVENT').length, 0);
    for (let i = 0; i < 20; i += 1) {
      const out = await pool.publish(wrap(), { durability: { standby: [S1] } });
      expect(out.durability).toMatchObject({ satisfied: false, relaysFull: true });
      expect(out.durability!.relays.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    }
    expect(factory.sockets.reduce((n, s) => n + s.sentOfType('EVENT').length, 0)).toBe(sentBefore);
    // 每座只通知一次「已滿」（加上備援連上／斷線的通知）
    expect(changes.filter((c) => c.endsWith(':full'))).toEqual([`${A}:full`, `${B}:full`, `${S1}:full`]);

    vi.advanceTimersByTime(3_600_000);
    const later = pool.publish(wrap(), { durability: { standby: [S1] } });
    await vi.advanceTimersByTimeAsync(0);
    answer(factory.latest(A), true);
    expect(factory.latest(B).sentOfType('EVENT')).toHaveLength(2);
    answer(factory.latest(B), true);
    expect((await later).durability).toMatchObject({ satisfied: true, durable: [A, B] });
  });

  it('invalid（自己的錯）：不改用備援', async () => {
    const result = pool.publish(wrap(), { durability: { standby: [S1] } });
    answer(factory.latest(A), false, 'invalid: bad-signature: 簽章錯誤');
    answer(factory.latest(B), false, 'invalid: bad-signature: 簽章錯誤');
    const out = await result;
    expect(out.durability).toMatchObject({ satisfied: false, relaysFull: false, standbyUsed: [] });
    expect(factory.forUrl(S1)).toEqual([]);
  });

  it('限速中的那座略過、到計數窗結束才恢復；備援連不上就換下一座', async () => {
    let result = pool.publish(wrap());
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, 'rate-limited: events: 發送過於頻繁');
    await result;
    result = pool.publish(wrap(), { durability: { minAccepted: 2, standby: [S1, S2] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.latest(B).sentOfType('EVENT')).toHaveLength(1); // 這次沒送 B
    answer(factory.latest(A), true);
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S1).fail(); // 第一座備援連不上
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S2).open();
    await vi.advanceTimersByTimeAsync(0);
    answer(factory.latest(S2), true);
    const out = await result;
    expect(out.durability!.relays.map((r) => [r.url, r.outcome])).toEqual([
      [A, 'accepted'],
      [B, 'skipped'],
      [S1, 'not-connected'],
      [S2, 'accepted'],
    ]);
    expect(out.durability).toMatchObject({ satisfied: true, standbyUsed: [S2] });
  });

  it('standbySubscribe：備援也收常駐訂閱、不閒置斷線', async () => {
    pool.close();
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [A], createSocket: factory.create, publishTimeoutMs: 1000, standbyIdleMs: 1000, standbySubscribe: true });
    pool.connect();
    factory.latest(A).open();
    pool.subscribe([{ kinds: [1059], '#p': [writer.pubkey] }], { onEvent: () => {} });
    const result = pool.publish(wrap(), { durability: { minAccepted: 2, standby: [S1] } });
    answer(factory.latest(A), true);
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S1).open();
    expect(factory.latest(S1).sentOfType('REQ')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    answer(factory.latest(S1), true);
    await result;
    vi.advanceTimersByTime(10_000);
    expect(pool.relayHealth().get(S1)!.status).toBe('open');
  });
});

describe('RelayPool.queryEach（ADR 0041 §3）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000, standbyIdleMs: 5000 });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('每座的結果分開回：eose／closed／timeout，事件逐座驗簽', async () => {
    const e1 = JSON.parse(JSON.stringify(addressable('b1')));
    const forged = { ...e1, content: '被改過' };
    const result = pool.queryEach([{ kinds: [31438], authors: [writer.pubkey] }], { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    const [reqA] = factory.latest(A).sentOfType('REQ');
    const [reqB] = factory.latest(B).sentOfType('REQ');
    factory.latest(A).receive(['EVENT', reqA![1], e1]);
    factory.latest(A).receive(['EOSE', reqA![1]]);
    factory.latest(B).receive(['EVENT', reqB![1], forged]); // 同 id、內容不對：B 不能靠 A 的驗證作證
    factory.latest(B).receive(['CLOSED', reqB![1], 'restricted: scope: 範圍不合']);
    const out = await result;
    expect(out.map((r) => [r.url, r.status, r.events.length])).toEqual([
      [A, 'eose', 1],
      [B, 'closed', 0],
    ]);
    expect(out[1]!.reason).toBe('restricted: scope: 範圍不合');
  });

  it('逾時的是 timeout；不在 urls 裡的當備援延遲連上、查完閒置斷線', async () => {
    const result = pool.queryEach([{ ids: ['00'.repeat(32)], authors: [writer.pubkey] }], { timeoutMs: 500, relays: [A, S1] });
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S1).open();
    await vi.advanceTimersByTimeAsync(0);
    const [reqS] = factory.latest(S1).sentOfType('REQ');
    factory.latest(S1).receive(['EOSE', reqS![1]]);
    await vi.advanceTimersByTimeAsync(500);
    const out = await result;
    expect(out.map((r) => [r.url, r.status])).toEqual([
      [A, 'timeout'],
      [S1, 'eose'],
    ]);
    expect(factory.forUrl(B).flatMap((s) => s.sentOfType('REQ'))).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(pool.relayHealth().get(S1)!.status).toBe('closed');
  });
});
