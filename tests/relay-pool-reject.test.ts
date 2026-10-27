// RelayPool 的拒收分類（SDK ADR 0038 P0-C）：rejected[].kind、duplicate 當收下、關閉碼、onRelayReject、CLOSED 依詞元重訂。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { classifyPublishRejection, RelayPool, type RelayRejection } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const A = 'wss://a.example';
const B = 'wss://b.example';

function signed(identity: Identity, content: string, createdAt = 1_700_000_000) {
  return identity.sign({ kind: 20078, created_at: createdAt, tags: [['t', 'demo']], content });
}

describe('RelayPool：拒收分類與回報（SDK ADR 0038 P0-C）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let rejections: [string, RelayRejection][];

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new SocketFactory();
    rejections = [];
    pool = new RelayPool({
      urls: [A, B],
      createSocket: factory.create,
      reconnectDelaysMs: [100, 200, 5000],
      publishTimeoutMs: 1000,
      onRelayReject: (url, rejection) => rejections.push([url, rejection]),
    });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('OK false 帶詞元：rejected[] 有 kind／retryable／token；部分拒收經 onRelayReject 回報', async () => {
    const event = signed(Identity.generate(), 'x');
    const result = pool.publish(event);
    factory.latest(A).receive(['OK', event.id, true, '']);
    factory.latest(B).receive(['OK', event.id, false, 'blocked: ceiling: 本站離線留言空間已滿']);
    const { accepted, rejected } = await result;
    expect(accepted).toEqual([A]);
    expect(rejected).toEqual([
      {
        url: B,
        reason: 'blocked: ceiling: 本站離線留言空間已滿',
        kind: 'ceiling',
        retryable: true,
        tryOtherRelays: true,
        token: 'ceiling',
      },
    ]);
    expect(rejections).toEqual([
      [B, expect.objectContaining({ source: 'ok', eventId: event.id, kind: 'ceiling', token: 'ceiling' })],
    ]);
  });

  it('duplicate 不是拒收：OK false「duplicate:」（舊中繼）與 OK true「duplicate:」都算收下，不回報', async () => {
    const event = signed(Identity.generate(), 'x');
    const result = pool.publish(event);
    factory.latest(A).receive(['OK', event.id, false, 'duplicate: 事件重複']);
    factory.latest(B).receive(['OK', event.id, true, 'duplicate: seen: 事件重複']);
    expect(await result).toEqual({ accepted: [A, B], rejected: [] });
    expect(rejections).toEqual([]);
  });

  it('逾時與沒連上也有分類（timeout／disconnected）', async () => {
    pool.close();
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000 });
    pool.connect();
    factory.latest(A).open();
    const result = pool.publish(signed(Identity.generate(), 'x'));
    vi.advanceTimersByTime(1000);
    const { rejected } = await result;
    expect(rejected).toEqual([
      expect.objectContaining({ url: A, reason: 'timeout', kind: 'timeout', retryable: true }),
      expect.objectContaining({ url: B, reason: 'not connected', kind: 'disconnected' }),
    ]);
  });

  it('被 1008 rate-limited 踢掉：進行中的發布以 rate-limited 結案；回報關閉碼；重連用最長的退避', async () => {
    const event = signed(Identity.generate(), 'x');
    const result = pool.publish(event);
    factory.latest(A).receive(['OK', event.id, true, '']);
    factory.latest(B).serverClose(1008, 'rate-limited');
    const { rejected } = await result;
    expect(rejected).toEqual([expect.objectContaining({ url: B, kind: 'rate-limited', retryable: true })]);
    expect(rejected[0]!.reason).toMatch(/^disconnected/);
    expect(rejections).toContainEqual([B, expect.objectContaining({ source: 'close', code: 1008, kind: 'rate-limited' })]);
    // 退避表是 [100, 200, 5000]：限速踢線直接用 5000，而不是 100
    vi.advanceTimersByTime(4999);
    expect(factory.forUrl(B)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.forUrl(B)).toHaveLength(2);
  });

  it('4003 白名單外：分成 restricted、不可重試；一般斷線（沒有關閉碼）照舊是 disconnected、照舊退避', async () => {
    factory.latest(A).serverClose(4003, 'restricted');
    expect(rejections).toContainEqual([A, expect.objectContaining({ source: 'close', code: 4003, kind: 'restricted', retryable: false })]);
    const before = factory.forUrl(B).length;
    factory.latest(B).fail();
    expect(rejections.filter(([url]) => url === B)).toEqual([]); // 網路斷線不是「拒收」，不回報
    vi.advanceTimersByTime(100);
    expect(factory.forUrl(B)).toHaveLength(before + 1);
  });

  it('常駐訂閱被 CLOSED「error: resubscribe:」：對那一座重訂一次（30 秒內不重複）', () => {
    pool.subscribe([{ kinds: [20078], '#t': ['demo'] }], { onEvent: () => {} });
    const [req] = factory.latest(A).sentOfType('REQ');
    factory.latest(A).receive(['CLOSED', req?.[1], 'error: resubscribe: subscription was lost when the relay restarted; please resubscribe (ADR-0373)']);
    expect(factory.latest(A).sentOfType('REQ')).toHaveLength(2);
    expect(factory.latest(B).sentOfType('REQ')).toHaveLength(1);
    factory.latest(A).receive(['CLOSED', req?.[1], 'error: resubscribe: again']);
    expect(factory.latest(A).sentOfType('REQ')).toHaveLength(2);
    expect(rejections).toContainEqual([A, expect.objectContaining({ source: 'closed', subId: req?.[1], token: 'resubscribe' })]);
    vi.advanceTimersByTime(30_000);
    factory.latest(A).receive(['CLOSED', req?.[1], 'error: subscription was lost when the relay restarted; please resubscribe (ADR-0373)']);
    expect(factory.latest(A).sentOfType('REQ')).toHaveLength(3); // 舊中繼沒有詞元的句子也認得
  });

  it('常駐訂閱被 CLOSED「restricted: scope:」／「invalid: too-large:」：不重訂，只回報', () => {
    pool.subscribe([{ kinds: [20078] }], { onEvent: () => {} });
    const [req] = factory.latest(A).sentOfType('REQ');
    factory.latest(A).receive(['CLOSED', req?.[1], 'restricted: scope: app lanes need a tag filter']);
    factory.latest(B).receive(['CLOSED', req?.[1], 'invalid: too-large: subscriptions on this connection exceed 512 KiB']);
    expect(factory.latest(A).sentOfType('REQ')).toHaveLength(1);
    expect(factory.latest(B).sentOfType('REQ')).toHaveLength(1);
    expect(rejections.map(([url, r]) => [url, r.kind])).toEqual([
      [A, 'restricted'],
      [B, 'too-large'],
    ]);
  });

  it('客戶端自己關掉的訂閱收到 CLOSED 不重訂', () => {
    const sub = pool.subscribe([{ kinds: [20078], '#t': ['demo'] }], { onEvent: () => {} });
    const [req] = factory.latest(A).sentOfType('REQ');
    sub.close();
    factory.latest(A).receive(['CLOSED', req?.[1], 'error: resubscribe: lost']);
    expect(factory.latest(A).sentOfType('REQ')).toHaveLength(1);
  });

  it('NOTICE 有認得的前綴才回報成拒收（例如超大訊息）', () => {
    factory.latest(A).receive(['NOTICE', 'invalid: too-large: 訊息過大']);
    factory.latest(A).receive(['NOTICE', 'hello there']);
    expect(rejections).toEqual([[A, expect.objectContaining({ source: 'notice', kind: 'too-large' })]]);
  });
});

describe('classifyPublishRejection：沒有 kind 的舊結果（自訂傳輸層）也分得出來', () => {
  it('依 reason 推回分類', () => {
    expect(classifyPublishRejection({ url: A, reason: 'timeout' }).kind).toBe('timeout');
    expect(classifyPublishRejection({ url: A, reason: 'not connected' }).kind).toBe('disconnected');
    expect(classifyPublishRejection({ url: A, reason: 'disconnected' }).kind).toBe('disconnected');
    expect(classifyPublishRejection({ url: A, reason: 'blocked: quota: 滿了' }).kind).toBe('quota');
    expect(classifyPublishRejection({ url: A, reason: 'x', kind: 'ceiling' }).kind).toBe('ceiling');
  });
});
