// 家庭預算（SDK ADR 0049 §10.3）：每顆家庭 DO 自己計本 UTC 日的近似用量——Cloudflare 不會在 100% 準時擋下（R0 實測結果四），
// 所以這是第一道防線：80% 預警、95% 分流（丟遙測、留指令）、100% 關連線並回結構化 503。
import { describe, expect, it } from 'vitest';
import { IotHomeQuota, iotDefaultHomeDailyRequests, nextUtcMidnightSec } from '../../src/relay/iot-quota.js';

const DAY = Date.UTC(2026, 9, 14) / 1000; // 2026-10-14 00:00 UTC

describe('IotHomeQuota', () => {
  it('依序跨過 warn（80%）、shed（95%）、exhausted（100%），每個門檻只回報一次', () => {
    let now = (DAY + 3600) * 1000;
    const q = new IotHomeQuota(100, () => now);
    const crossed: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = q.add();
      if (r.crossed) crossed.push(`${i + 1}:${r.crossed}`);
    }
    expect(crossed).toEqual(['80:warn', '95:shed', '100:exhausted']);
    expect(q.state()).toBe('exhausted');
    expect(q.resetAt()).toBe(DAY + 86_400);
    now += 86_400_000; // 跨過 UTC 午夜歸零
    expect(q.add().state).toBe('ok');
    expect(q.snapshot()).toEqual({ day: DAY + 86_400, used: 1 });
  });

  it('每 64 次或跨過門檻時才要求寫回（計數本身不能吃掉寫入額度）；可以從寫回的值恢復', () => {
    const q = new IotHomeQuota(10_000, () => (DAY + 10) * 1000);
    const persists = Array.from({ length: 130 }, () => q.add().persist).filter(Boolean).length;
    expect(persists).toBe(2);
    const restored = new IotHomeQuota(10_000, () => (DAY + 20) * 1000, q.snapshot());
    expect(restored.snapshot().used).toBe(130);
    const stale = new IotHomeQuota(10_000, () => (DAY + 86_400 + 5) * 1000, q.snapshot());
    expect(stale.snapshot()).toEqual({ day: DAY + 86_400, used: 0 });
  });

  it('預設每家預算：帳號每日 100,000 ÷ 家庭數 × 0.5（留一半給 relay 其他流量）；可覆寫', () => {
    expect(iotDefaultHomeDailyRequests(1)).toBe(50_000);
    expect(iotDefaultHomeDailyRequests(4)).toBe(12_500);
    expect(iotDefaultHomeDailyRequests(4, '3000')).toBe(3000);
    expect(iotDefaultHomeDailyRequests(4, 'nope')).toBe(12_500);
  });

  it('下一個 UTC 午夜', () => {
    expect(nextUtcMidnightSec(DAY * 1000)).toBe(DAY + 86_400);
    expect(nextUtcMidnightSec((DAY + 86_399) * 1000)).toBe(DAY + 86_400);
  });
});
