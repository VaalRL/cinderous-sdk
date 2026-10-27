// 合併＋抖動排程器（SDK ADR 0049 §11.1 裁示 2）：以注入的時鐘、亂數、計時器驗證時序。
import { describe, expect, it } from 'vitest';

import { IotPushScheduler, type IotPushTimers } from '../../src/iot/push-scheduler.js';
import type { IotPushSendResult } from '../../src/iot/push.js';

class FakeClock implements IotPushTimers {
  now = 1_000_000;
  #seq = 0;
  readonly #tasks = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = (this.#seq += 1);
    this.#tasks.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }
  /** 前進 ms 毫秒，依序跑到期的計時器（每跑一個讓出一次，讓 async 的 send 結算） */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#tasks.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
    this.now = end;
  }
}

function setup(opts: { random?: number; results?: IotPushSendResult[]; limits?: { standardPerMinute?: number; instantPerMinute?: number } } = {}) {
  const clock = new FakeClock();
  const sent: { id: string; at: number; ref?: string }[] = [];
  const results = [...(opts.results ?? [])];
  const gone: string[] = [];
  const errors: string[] = [];
  const scheduler = new IotPushScheduler({
    send: async (id, wake) => {
      sent.push({ id, at: clock.now, ...(wake.ref !== undefined ? { ref: wake.ref } : {}) });
      return results.shift() ?? { status: 'ok' };
    },
    now: () => clock.now,
    random: () => opts.random ?? 0.5,
    timers: clock,
    ...(opts.limits ? { limits: opts.limits } : {}),
    onGone: (id) => gone.push(id),
    onError: (id, reason) => errors.push(`${id}:${reason}`),
  });
  return { clock, sent, scheduler, gone, errors, t0: clock.now };
}

describe('標準模式（預設）：60 秒合併＋0–30 秒抖動', () => {
  it('第一次在 0–30 秒抖動後送出；期間的事件合併成一次', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0.5 });
    scheduler.notify('ep', 'standard', 'a'.repeat(64));
    await clock.advance(10_000);
    scheduler.notify('ep', 'standard', 'b'.repeat(64));
    scheduler.notify('ep', 'standard');
    await clock.advance(10_000);
    expect(sent).toEqual([{ id: 'ep', at: t0 + 15_000, ref: 'b'.repeat(64) }]);
  });

  it('抖動的範圍由亂數決定：0 → 立刻、接近 1 → 接近 30 秒', async () => {
    const a = setup({ random: 0 });
    a.scheduler.notify('ep', 'standard');
    await a.clock.advance(0);
    expect(a.sent.map((s) => s.at - a.t0)).toEqual([0]);
    const b = setup({ random: 0.999 });
    b.scheduler.notify('ep', 'standard');
    await b.clock.advance(31_000);
    expect(b.sent.map((s) => s.at - b.t0)).toEqual([29_970]);
  });

  it('同一個端點兩次喚醒至少隔 60 秒（再加抖動）', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0 });
    scheduler.notify('ep', 'standard');
    await clock.advance(1_000);
    scheduler.notify('ep', 'standard');
    await clock.advance(30_000);
    scheduler.notify('ep', 'standard');
    await clock.advance(120_000);
    expect(sent.map((s) => s.at - t0)).toEqual([0, 60_000]);
  });

  it('standardPerMinute 可調：2／分 → 間隔 30 秒', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0, limits: { standardPerMinute: 2 } });
    scheduler.notify('ep', 'standard');
    await clock.advance(1);
    scheduler.notify('ep', 'standard');
    await clock.advance(60_000);
    expect(sent.map((s) => s.at - t0)).toEqual([0, 30_000]);
  });

  it('不同端點各自計算', async () => {
    const { clock, sent, scheduler } = setup({ random: 0 });
    scheduler.notify('a', 'standard');
    scheduler.notify('b', 'standard');
    await clock.advance(0);
    expect(sent.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('即時模式：不合併、0–2 秒抖動、每分鐘最多 6 次', () => {
  it('每一則都送（0–2 秒內）', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0.5 });
    scheduler.notify('ep', 'instant');
    await clock.advance(5_000);
    scheduler.notify('ep', 'instant');
    await clock.advance(5_000);
    expect(sent.map((s) => s.at - t0)).toEqual([1_000, 6_000]);
  });

  it('超過 6 次／分：第 7 次等到視窗空出來', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0 });
    for (let i = 0; i < 7; i += 1) {
      scheduler.notify('ep', 'instant');
      await clock.advance(1_000);
    }
    await clock.advance(60_000);
    expect(sent.map((s) => s.at - t0)).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000, 60_000]);
  });

  it('即時送出時，等待中的標準喚醒一併滿足', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0.5 });
    scheduler.notify('ep', 'standard'); // 預計 15 秒
    await clock.advance(2_000);
    scheduler.notify('ep', 'instant'); // 提前到 3 秒
    await clock.advance(120_000);
    expect(sent.map((s) => s.at - t0)).toEqual([3_000]);
  });

  it('剛即時送過：之後的標準要等 60 秒', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0 });
    scheduler.notify('ep', 'instant');
    await clock.advance(1_000);
    scheduler.notify('ep', 'standard');
    await clock.advance(120_000);
    expect(sent.map((s) => s.at - t0)).toEqual([0, 60_000]);
  });
});

describe('送出結果', () => {
  it('gone：交給 onGone、不再送', async () => {
    const { clock, sent, scheduler, gone } = setup({ random: 0, results: [{ status: 'gone' }] });
    scheduler.notify('ep', 'instant');
    await clock.advance(0);
    expect(gone).toEqual(['ep']);
    expect(scheduler.pending('ep')).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('retry：Retry-After 之前不送，這次的喚醒延後', async () => {
    const { clock, sent, scheduler, t0 } = setup({ random: 0, results: [{ status: 'retry', retryAfterMs: 90_000 }] });
    scheduler.notify('ep', 'instant', 'c'.repeat(64));
    await clock.advance(0);
    scheduler.notify('ep', 'instant');
    await clock.advance(200_000);
    expect(sent.map((s) => [s.at - t0, s.ref])).toEqual([
      [0, 'c'.repeat(64)],
      [90_000, 'c'.repeat(64)],
    ]);
  });

  it('error：照標準間隔重試，最多 3 次', async () => {
    const err = { status: 'error', reason: 'http-500' } as const;
    const { clock, sent, scheduler, errors, t0 } = setup({ random: 0, results: [err, err, err] });
    scheduler.notify('ep', 'instant');
    await clock.advance(600_000);
    expect(sent.map((s) => s.at - t0)).toEqual([0, 60_000, 120_000]);
    expect(errors).toEqual(['ep:http-500']);
  });

  it('cancel 與 stop 清掉等待中的喚醒', async () => {
    const { clock, sent, scheduler } = setup({ random: 0.5 });
    scheduler.notify('a', 'standard');
    scheduler.notify('b', 'standard');
    scheduler.cancel('a');
    expect(scheduler.pending('a')).toBeUndefined();
    scheduler.stop();
    scheduler.notify('c', 'instant');
    await clock.advance(100_000);
    expect(sent).toEqual([]);
  });
});
