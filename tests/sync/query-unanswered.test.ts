// G12(a)（SDK ADR 0045）：一座中繼都沒完成查詢時，不能當成「翻完了、沒有東西」——否則補拉游標被推到現在，
// 之前的訊息永遠補不回來。區分「沒有任何中繼完成查詢」與「查完但沒結果」；沒有完成的查詢不得推進游標，查到一半全部斷線也一樣。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../../src/identity.js';
import { RelayPool } from '../../src/relay-pool.js';
import {
  FastHydrator,
  forEachPage,
  isRelayQueryIncompleteError,
  queryPaged,
  RelayQueryIncompleteError,
  type HydratorPool,
} from '../../src/sync/hydrator.js';
import { BACKFILL_PAGE_TIMEOUT_MS, NostrVaultTransport } from '../../src/sync/vault/nostr-transport.js';
import { SocketFactory } from '../fake-socket.js';

const PRIMARY = 'wss://primary.example';
const BACKUP = 'wss://backup.example';

describe('RelayPool.queryResult：分得出「沒有任何一座回完」', () => {
  let factory: SocketFactory;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [PRIMARY, BACKUP], createSocket: factory.create, reconnectDelaysMs: [100_000], publishTimeoutMs: 1000 });
  });
  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('一座都沒開：answered 0、每座 not-connected（query 照舊回空陣列）', async () => {
    pool.connect();
    const outcome = pool.queryResult([{ kinds: [1] }], 300);
    await vi.advanceTimersByTimeAsync(300);
    const result = await outcome;
    expect(result.events).toEqual([]);
    expect(result.answered).toBe(0);
    expect(result.relays.map((r) => r.status)).toEqual(['not-connected', 'not-connected']);
    const legacy = pool.query([{ kinds: [1] }], 300);
    await vi.advanceTimersByTimeAsync(300);
    expect(await legacy).toEqual([]);
  });

  it('查完但沒結果：answered ≥ 1（有一座 EOSE 就算回完）', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(BACKUP).open();
    const outcome = pool.queryResult([{ kinds: [1] }], 500);
    const [req] = factory.latest(PRIMARY).sentOfType('REQ');
    factory.latest(PRIMARY).receive(['EOSE', req?.[1]]);
    await vi.advanceTimersByTimeAsync(500);
    const result = await outcome;
    expect(result.answered).toBe(1);
    expect(result.relays.find((r) => r.url === PRIMARY)?.status).toBe('eose');
    expect(result.relays.find((r) => r.url === BACKUP)?.status).toBe('timeout');
  });

  it('查到一半全部斷線：answered 0、狀態 disconnected', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(BACKUP).open();
    const outcome = pool.queryResult([{ kinds: [1] }], 1000);
    factory.latest(PRIMARY).fail();
    factory.latest(BACKUP).fail();
    const result = await outcome;
    expect(result.answered).toBe(0);
    expect(result.relays.map((r) => r.status)).toEqual(['disconnected', 'disconnected']);
  });

  it('被 CLOSED（例如 restricted）不算回完', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    const outcome = pool.queryResult([{ kinds: [1] }], 1000);
    const [req] = factory.latest(PRIMARY).sentOfType('REQ');
    factory.latest(PRIMARY).receive(['CLOSED', req?.[1], 'restricted: 名單外']);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await outcome;
    expect(result.answered).toBe(0);
    expect(result.relays.find((r) => r.url === PRIMARY)).toMatchObject({ status: 'closed', reason: 'restricted: 名單外' });
  });
});

/** 只有 query／queryResult 的假池：`answered` 決定每一頁是否有中繼回完 */
function scriptedPool(pages: Array<{ answered: number; events: Array<{ id: string; created_at: number }> }>) {
  let i = 0;
  const calls: number[] = [];
  const pool: Pick<HydratorPool, 'query' | 'queryResult'> = {
    query: async () => (pages[Math.min(i++, pages.length - 1)]!.events as never),
    queryResult: async () => {
      const page = pages[Math.min(i++, pages.length - 1)]!;
      calls.push(page.answered);
      return { events: page.events as never, answered: page.answered, relays: [{ url: PRIMARY, status: page.answered > 0 ? 'eose' : 'not-connected' }] };
    },
  };
  return { pool, calls };
}

describe('forEachPage／queryPaged：沒有中繼回完 ≠ 翻完了', () => {
  it('第一頁就沒人回：complete false、unanswered true（不是「翻完了」）', async () => {
    const { pool } = scriptedPool([{ answered: 0, events: [] }]);
    const result = await forEachPage(pool, [{ kinds: [1] }], () => {});
    expect(result.complete).toBe(false);
    expect(result.unanswered).toBe(true);
    expect(result.relays?.[0]?.status).toBe('not-connected');
  });

  it('翻到一半斷線：前面幾頁照樣交出去，但不算完成', async () => {
    const { pool } = scriptedPool([
      { answered: 1, events: [{ id: 'a', created_at: 100 }] },
      { answered: 0, events: [] },
    ]);
    const got: string[] = [];
    const result = await forEachPage(pool, [{ kinds: [1] }], (events) => got.push(...events.map((e) => e.id)));
    expect(got).toEqual(['a']);
    expect(result).toMatchObject({ events: 1, complete: false, unanswered: true });
  });

  it('有人回完而且沒有新事件：complete true（向下相容：沒有 unanswered 欄位）', async () => {
    const { pool } = scriptedPool([{ answered: 1, events: [] }]);
    expect(await forEachPage(pool, [{ kinds: [1] }], () => {})).toEqual({ events: 0, complete: true });
  });

  it('queryPaged：沒人回完時丟 RelayQueryIncompleteError（帶著已拿到的事件），不再回空陣列假裝查完', async () => {
    const { pool } = scriptedPool([
      { answered: 1, events: [{ id: 'a', created_at: 100 }] },
      { answered: 0, events: [] },
    ]);
    const error = await queryPaged(pool, [{ kinds: [1] }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayQueryIncompleteError);
    expect(isRelayQueryIncompleteError(error)).toBe(true);
    expect((error as RelayQueryIncompleteError).events.map((e) => e.id)).toEqual(['a']);
  });

  it('只有 query 的自訂池：沿用舊行為（無從分辨）', async () => {
    const pool = { query: async () => [] as never };
    expect(await forEachPage(pool, [{ kinds: [1] }], () => {})).toEqual({ events: 0, complete: true });
  });
});

describe('FastHydrator：沒有中繼回完時不推進同步時間', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('resume() 丟 RelayQueryIncompleteError；lastSyncAt 不變；下一次照舊從同一個起點拉', async () => {
    const { pool: scripted } = scriptedPool([
      { answered: 0, events: [] },
      { answered: 1, events: [] },
    ]);
    let last: number | undefined = 1_000_000;
    const sinces: Array<number | undefined> = [];
    const pool: HydratorPool = {
      connect() {},
      close() {},
      query: scripted.query,
      queryResult: async (filters, timeoutMs) => {
        sinces.push(filters[0]!.since);
        return scripted.queryResult!(filters, timeoutMs);
      },
    };
    const hydrator = new FastHydrator({
      pool,
      filters: [{ kinds: [1059] }],
      onEvents: () => {},
      lastSyncAt: () => last,
      setLastSyncAt: (sec) => {
        last = sec;
      },
      visibility: null,
    });
    await expect(hydrator.resume()).rejects.toBeInstanceOf(RelayQueryIncompleteError);
    expect(last).toBe(1_000_000);
    await hydrator.resume();
    expect(sinces[0]).toBe(sinces[1]);
    expect(last).toBe(Math.floor(Date.now() / 1000));
  });
});

describe('NostrVaultTransport.backfill：沒連上時不把補拉起點推到現在（CinderSync 排程同步的資料遺失）', () => {
  it('第一次補拉沒人回完 → 起點不動；連上後再補拉，since 仍是最初的起點', async () => {
    const me = Identity.generate();
    let answered = 0;
    const sinces: Array<number | undefined> = [];
    let now = 2_000_000_000_000;
    const transport = new NostrVaultTransport({
      pool: {
        publish: async () => ({ accepted: [], rejected: [] }) as never,
        subscribe: () => ({ close() {} }),
        query: async () => [],
        queryResult: async (filters) => {
          sinces.push(filters[0]!.since);
          return { events: [], answered, relays: [] };
        },
      },
      signer: me,
      devices: [],
      since: 1_900_000_000,
      now: () => now,
    });
    await expect(transport.backfill()).rejects.toBeInstanceOf(RelayQueryIncompleteError);
    now += 3_600_000;
    answered = 1;
    await transport.backfill();
    expect(sinces[1]).toBe(sinces[0]);
    // 這一次回完了：下一次從這一次開始的時間接續
    await transport.backfill();
    expect(sinces[2]).toBeGreaterThan(sinces[1]!);
  });

  it('🔴 補拉每一頁用較長的逾時（中繼準備一頁大的收件匣要好幾秒；SDK ADR 0077）；可以調', async () => {
    const me = Identity.generate();
    const timeouts: Array<number | undefined> = [];
    const pool = {
      publish: async () => ({ accepted: [], rejected: [] }) as never,
      subscribe: () => ({ close() {} }),
      query: async () => [],
      queryResult: async (_filters: unknown, timeoutMs?: number) => {
        timeouts.push(timeoutMs);
        return { events: [], answered: 1, relays: [] };
      },
    };
    await new NostrVaultTransport({ pool, signer: me, devices: [] }).backfill();
    expect(timeouts).toEqual([BACKFILL_PAGE_TIMEOUT_MS]);
    expect(BACKFILL_PAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    await new NostrVaultTransport({ pool, signer: me, devices: [], backfillTimeoutMs: 10_000 }).backfill();
    expect(timeouts.at(-1)).toBe(10_000);
  });

  it('🔴 start() 時一座都沒連上：不補拉（連上時才補拉）；應用連上後第一次補拉不會共用一個連線前就開始、注定沒回完的查詢（SDK ADR 0080）', async () => {
    const me = Identity.generate();
    let open = false;
    const listeners: Array<() => void> = [];
    let calls = 0;
    let release: (() => void) | undefined;
    const pool = {
      publish: async () => ({ accepted: [], rejected: [] }) as never,
      subscribe: () => ({ close() {} }),
      query: async () => [],
      queryResult: (): Promise<{ events: never[]; answered: number; relays: never[] }> => {
        calls += 1;
        const answered = open ? 1 : 0;
        // 沒連線時的查詢要等到逾時才回（實機約 30 秒）
        if (!open) return new Promise((resolve) => (release = () => resolve({ events: [], answered, relays: [] })));
        return Promise.resolve({ events: [], answered, relays: [] });
      },
      status: () => new Map([[PRIMARY, open ? 'open' : 'closed']]),
      onStatusChange: (listener: () => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const transport = new NostrVaultTransport({ pool: pool as never, signer: me, devices: [] });
    transport.start();
    await Promise.resolve();
    expect(calls).toBe(0);
    open = true;
    for (const listener of listeners) listener();
    await transport.backfill();
    expect(calls).toBe(1);
    release?.();
    // 一開始就連上：照舊在 start() 補拉
    const online = new NostrVaultTransport({ pool: pool as never, signer: me, devices: [] });
    online.start();
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it('自訂池只有 query＋status：查完時一座都沒開 → 當作沒回完', async () => {
    const me = Identity.generate();
    let open = false;
    const sinces: Array<number | undefined> = [];
    const transport = new NostrVaultTransport({
      pool: {
        publish: async () => ({ accepted: [], rejected: [] }) as never,
        subscribe: () => ({ close() {} }),
        query: async (filters) => {
          sinces.push(filters[0]!.since);
          return [];
        },
        status: () => new Map([[PRIMARY, open ? 'open' : 'closed']]),
      },
      signer: me,
      devices: [],
      since: 1_900_000_000,
      now: () => 2_000_000_000_000,
    });
    await expect(transport.backfill()).rejects.toBeInstanceOf(RelayQueryIncompleteError);
    open = true;
    await transport.backfill();
    await transport.backfill();
    expect(sinces[1]).toBe(sinces[0]);
    expect(sinces[2]).toBeGreaterThan(sinces[1]!);
  });
});
