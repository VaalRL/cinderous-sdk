// 秒級水化與省電（SDK ADR 0011 §5；PRD 2.5）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TIMESTAMP_JITTER_SECONDS } from '../../src/protocol/index.js';
import { FastHydrator, type HydratorPool, type VisibilitySource } from '../../src/sync/hydrator.js';

class FakeVisibility implements VisibilitySource {
  hidden = false;
  readonly listeners = new Set<(hidden: boolean) => void>();
  isHidden() {
    return this.hidden;
  }
  onChange(listener: (hidden: boolean) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(hidden: boolean) {
    this.hidden = hidden;
    for (const listener of this.listeners) listener(hidden);
  }
}

function fakePool() {
  const calls: string[] = [];
  const queries: { since?: number; until?: number }[][] = [];
  const pool: HydratorPool = {
    connect: () => calls.push('connect'),
    close: () => calls.push('close'),
    query: async (filters) => {
      queries.push(filters as { since?: number; until?: number }[]);
      return [{ id: 'e1', created_at: 100 }] as never;
    },
  };
  return { pool, calls, queries };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('FastHydrator', () => {
  it('啟動就拉一次增量；since 往前退讓 NIP-59 的時間倒填窗（否則會靜默漏訊）', async () => {
    const { pool, queries } = fakePool();
    let last: number | undefined = 1_000_000;
    const got: unknown[] = [];
    const hydrator = new FastHydrator({
      pool,
      filters: [{ kinds: [1059], '#p': ['me'] }],
      onEvents: (events) => got.push(...events),
      lastSyncAt: () => last,
      setLastSyncAt: (sec) => {
        last = sec;
      },
      visibility: new FakeVisibility(),
    });
    await hydrator.start();
    expect(queries[0]![0]!.since).toBe(1_000_000 - TIMESTAMP_JITTER_SECONDS);
    expect(got).toHaveLength(1);
    expect(last).toBe(Math.floor(Date.now() / 1000));
    hydrator.stop();
  });

  it('從來沒同步過 → 不帶 since（拉全部）', async () => {
    const { pool, queries } = fakePool();
    const hydrator = new FastHydrator({ pool, filters: [{ kinds: [1] }], onEvents: () => {}, lastSyncAt: () => undefined, setLastSyncAt: () => {}, visibility: new FakeVisibility() });
    await hydrator.start();
    expect(queries[0]![0]!.since).toBeUndefined();
    hydrator.stop();
  });

  it('隱藏超過 15 秒才斷線省電；回到前景就重連並再拉一次', async () => {
    const { pool, calls, queries } = fakePool();
    const visibility = new FakeVisibility();
    const hydrator = new FastHydrator({ pool, filters: [{ kinds: [1] }], onEvents: () => {}, lastSyncAt: () => 1, setLastSyncAt: () => {}, visibility });
    await hydrator.start();

    visibility.set(true);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(calls).not.toContain('close');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toContain('close');

    visibility.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toBe('connect');
    // 每次增量拉取＝第一頁（不帶 until）＋確認沒有更舊的那一頁（SDK ADR 0029）
    expect(queries.filter((q) => q[0]!.until === undefined)).toHaveLength(2);
    hydrator.stop();
  });

  it('隱藏不到 15 秒又回來 → 不斷線、不重連，但照樣拉一次增量', async () => {
    const { pool, calls, queries } = fakePool();
    const visibility = new FakeVisibility();
    const hydrator = new FastHydrator({ pool, filters: [{ kinds: [1] }], onEvents: () => {}, lastSyncAt: () => 1, setLastSyncAt: () => {}, visibility });
    await hydrator.start();
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(5_000);
    visibility.set(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([]);
    // 每次增量拉取＝第一頁（不帶 until）＋確認沒有更舊的那一頁（SDK ADR 0029）
    expect(queries.filter((q) => q[0]!.until === undefined)).toHaveLength(2);
    hydrator.stop();
  });

  it('查詢失敗不更新同步時間（下次會重拉，不會漏）', async () => {
    const { pool } = fakePool();
    pool.query = async () => {
      throw new Error('斷線');
    };
    let last: number | undefined = 42;
    const hydrator = new FastHydrator({
      pool,
      filters: [{ kinds: [1] }],
      onEvents: () => {},
      lastSyncAt: () => last,
      setLastSyncAt: (sec) => {
        last = sec;
      },
      visibility: new FakeVisibility(),
    });
    await expect(hydrator.resume()).rejects.toThrow();
    expect(last).toBe(42);
    hydrator.stop();
  });
});
