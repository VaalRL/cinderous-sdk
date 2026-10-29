// 常駐訂閱記住的已收 id 有上限（SDK ADR 0124）：聊天 App 一開好幾天，心跳讓去重表一直長大。
// 整理規則：補訂閱不會再重播的（created_at 早於補訂閱的 since）、而且收到超過寬限時間的才忘；超過上限先忘最早收到的。
import type { Event } from 'nostr-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { type Filter } from 'nostr-tools/filter';
import { DEFAULT_MAX_SEEN_PER_SUBSCRIPTION, RelayPool, SEEN_GRACE_MS, SEEN_PRUNE_EVERY } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const PRIMARY = 'wss://primary.example';
const BACKUP = 'wss://backup.example';
const T0 = 1_700_000_000;
/** 測試用的小上限：整理週期跟著上限（{@link SEEN_PRUNE_EVERY} 比它大），每 8 則整理一次 */
const CAP = 8;

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('RelayPool 訂閱的去重表有上限（SDK ADR 0124）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  const writer = Identity.generate();
  const sign = (kind: number, createdAt: number, content: string): Event =>
    plain(writer.sign({ kind, created_at: createdAt, tags: [], content }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 * 1000);
    factory = new SocketFactory();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  /** 開一個訂閱，回傳「餵某座一則」與收到的內容 */
  function subscribe(filters: Filter[], urls = [PRIMARY], maxSeenPerSubscription = CAP) {
    pool = new RelayPool({
      urls,
      createSocket: factory.create,
      maxSeenPerSubscription,
    });
    pool.connect();
    for (const url of urls) factory.latest(url).open();
    const received: string[] = [];
    pool.subscribe(filters, { onEvent: (event) => received.push(event.content) });
    const feed = (event: Event, url = PRIMARY) => {
      const [req] = factory.latest(url).sentOfType('REQ');
      factory.latest(url).receive(['EVENT', req?.[1], event]);
    };
    return { received, feed };
  }

  /** 再送 CAP − 1 則較新的：加上先送的那一則剛好 CAP 則，觸發一次定期整理、但不超過上限 */
  function flood(feed: (event: Event, url?: string) => void, kind: number, createdAt: number) {
    for (let i = 0; i < CAP - 1; i++) feed(sign(kind, createdAt, `n${i}`));
  }

  it('預設每 1024 則整理一次、上限 5 萬', () => {
    subscribe([{ kinds: [20078] }]);
    expect(SEEN_PRUNE_EVERY).toBe(1024);
    expect(DEFAULT_MAX_SEEN_PER_SUBSCRIPTION).toBe(50_000);
  });

  it('補訂閱不會重播、又收到很久的那些會被忘掉；還在補訂閱範圍內的照樣去重', () => {
    const { received, feed } = subscribe([{ kinds: [20078] }]);
    const old = sign(20078, T0, 'old');
    feed(old);
    vi.setSystemTime(T0 * 1000 + SEEN_GRACE_MS + 1000);
    const now = T0 + SEEN_GRACE_MS / 1000 + 1;
    flood(feed, 20078, now);
    received.length = 0;

    feed(old); // 早於游標、收到超過寬限：已經忘了（中繼不照 since 重播時才會再出現）
    feed(sign(20078, now, 'n5')); // 與游標同一秒：補訂閱會重播，要記著
    expect(received).toEqual(['old']);
  });

  it('寬限內不忘：一次載入歷史時，別座晚到的同一則照樣去重', () => {
    const { received, feed } = subscribe([{ kinds: [20078] }], [PRIMARY, BACKUP]);
    const old = sign(20078, T0 - 3600, 'old');
    feed(old);
    flood(feed, 20078, T0);
    received.length = 0;

    feed(old, BACKUP);
    expect(received).toEqual([]);
  });

  it('可能被回溯的 filter（禮物包）：兩天內的都記著——補訂閱會往前退讓兩天重播', () => {
    const { received, feed } = subscribe([{ kinds: [1059], '#p': [writer.pubkey] }]);
    const dayOld = sign(1059, T0 - 86_400, 'day-old');
    feed(dayOld);
    vi.setSystemTime(T0 * 1000 + SEEN_GRACE_MS + 1000);
    flood(feed, 1059, T0 + SEEN_GRACE_MS / 1000);
    received.length = 0;

    feed(dayOld);
    expect(received).toEqual([]);
  });

  it('超過 maxSeenPerSubscription：先忘最早收到的，寬限內也一樣（記憶體上限優先）', () => {
    const { received, feed } = subscribe([{ kinds: [20078] }], [PRIMARY], 3);
    const events = [0, 1, 2, 3].map((i) => sign(20078, T0, `e${i}`));
    for (const event of events) feed(event);
    received.length = 0;

    feed(events[0]!);
    feed(events[3]!);
    expect(received).toEqual(['e0']);
  });
});
