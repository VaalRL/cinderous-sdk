// 中繼暫時不能用（1013 Try Again Later；SDK ADR 0108）：2026-10-22 錨點的 Cloudflare 儲存寫入額度用完，每條新連線都收到
// `NOTICE "over quota: …"` 後以 1013 關閉。連線池原本當成一般斷線：每 10 秒重連一次、沒有健康標記，應用只看得到「離線」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { classifyRelayClose, relayRejectKindOf } from '../src/protocol/relay-reject.js';
import { RelayPool, type RelayRejection } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const A = 'wss://a.example';
const B = 'wss://b.example';
const MIN = 60_000;

describe('classifyRelayClose：1013＝這座暫時不能用（SDK ADR 0108）', () => {
  it('1013 不論原因都是 unavailable：稍後可重試、換座有用', () => {
    expect(classifyRelayClose(1013, 'over quota')).toMatchObject({ kind: 'unavailable', code: 1013, reason: 'over quota', retryable: true, tryOtherRelays: true });
    expect(classifyRelayClose(1013, 'temporarily unavailable').kind).toBe('unavailable');
    expect(classifyRelayClose(1013).kind).toBe('unavailable');
    expect(relayRejectKindOf('unavailable')).toEqual({ retryable: true, tryOtherRelays: true });
  });
});

describe('🔴 RelayPool：中繼以 1013 關閉（SDK ADR 0108）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let rejections: [string, RelayRejection][];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // 1013 的等待時間有抖動（SDK ADR 0130）；這裡驗的是精確時間
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 實機看到的樣子：接受升級、送說明、以 1013 關閉 */
  function overQuota(url: string) {
    const socket = factory.latest(url);
    socket.open();
    socket.receive(['NOTICE', 'over quota: this relay has used up its storage write allowance for today and cannot open connections until it resets (around 00:00 UTC). Use another relay meanwhile.']);
    socket.serverClose(1013, 'over quota');
  }

  it('回報關閉碼與分類；整座標成暫時不能用（5 分鐘）', () => {
    overQuota(B);
    expect(rejections).toContainEqual([B, expect.objectContaining({ source: 'close', code: 1013, kind: 'unavailable', reason: 'over quota' })]);
    const marks = pool.relayHealth().get(B)!.marks;
    expect(marks).toEqual([expect.objectContaining({ scope: '*', state: 'backoff', kind: 'unavailable', reason: 'over quota' })]);
    expect(marks[0]!.until - marks[0]!.since).toBe(5 * MIN);
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
  });

  it('重連等到標記過期（不是每 10 秒）；又被 1013 關閉就再等 5 分鐘', () => {
    overQuota(B);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(factory.forUrl(B)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.forUrl(B)).toHaveLength(2);
    overQuota(B);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(factory.forUrl(B)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(factory.forUrl(B)).toHaveLength(3);
  });

  it('應用要求立刻重連（reconnectNow）而且恢復了（回了 EOSE）：清掉標記', () => {
    overQuota(B);
    pool.subscribe([{ kinds: [1] }], { onEvent: () => undefined });
    pool.reconnectNow(B);
    const socket = factory.latest(B);
    socket.open();
    const req = socket.sentOfType('REQ').at(-1)!;
    expect(pool.relayHealth().get(B)!.marks.length).toBe(1);
    socket.receive(['EOSE', req[1]]);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
  });

  it('標記還在時，要求耐久的發布略過那一座', async () => {
    overQuota(B);
    pool.reconnectNow(B);
    factory.latest(B).open();
    const event = Identity.generate().sign({ kind: 1059, created_at: 1_700_000_000, tags: [], content: 'x' });
    const result = pool.publish(event, { durability: { minAccepted: 1 } });
    expect(factory.latest(B).sentOfType('EVENT')).toEqual([]);
    factory.latest(A).receive(['OK', event.id, true, '']);
    expect((await result).accepted).toEqual([A]);
  });
});
