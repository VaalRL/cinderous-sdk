// 收件確認基準測試（ADR 0067 實作計畫第 4 項）用的中繼重放模型：給定每顆包的大小、到期與每台的上線輪次，
// 算出中繼佔用與補拉下載（含重複下載）。這個模型本身在 CI 裡測；耗時的測量在 inbox-ack-expiry.measure.ts，不進 CI。
import { describe, expect, it } from 'vitest';

import { replayRelay, type ReplayRow } from './relay-replay.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const row = (over: Partial<ReplayRow> = {}): ReplayRow => ({ recipient: 'b', bytes: 100, createdAt: 0, receivedAt: 0, expiresAt: 7 * DAY, ...over });
const base = { jitterMs: 2 * DAY, sampleMs: HOUR };

describe('replayRelay', () => {
  it('沒有確認：包放到期限，下一輪補拉再下載一次（算重複）', () => {
    const r = replayRelay([row()], [{ at: HOUR, dev: 'b' }, { at: 5 * HOUR, dev: 'b' }], { ...base, end: 6 * HOUR, graceMs: null });
    expect(r).toMatchObject({ downloadedRows: 2, downloadedBytes: 200, repeatedRows: 1, repeatedBytes: 100, peakBytes: 100, avgBytes: 100 });
  });

  it('確認後寬限 2 小時：處理完的包在那一輪＋2 小時到期，之後的輪次不再下載', () => {
    const r = replayRelay([row()], [{ at: HOUR, dev: 'b' }, { at: 5 * HOUR, dev: 'b' }], { ...base, end: 6 * HOUR, graceMs: 2 * HOUR });
    expect(r).toMatchObject({ downloadedRows: 1, repeatedRows: 0, peakBytes: 100 });
    // 取樣 1h…6h：1h、2h 還在，3h 起到期
    expect(r.avgBytes).toBeCloseTo(200 / 6);
  });

  it('只降收件人自己的列；沒上線的收件人的包照舊放著', () => {
    const rows = [row(), row({ recipient: 'c', bytes: 50 })];
    const r = replayRelay(rows, [{ at: HOUR, dev: 'b' }], { ...base, end: 4 * HOUR, graceMs: 0 });
    // 取樣 1h…4h：b 的在 1h 到期（寬限 0），c 的一直在
    expect(r.peakRowsPer).toEqual({ c: 1 });
    expect(r.avgBytes).toBeCloseTo(50);
  });

  it('還沒寄到中繼的包不會被這一輪確認，也不在這一輪下載', () => {
    const rows = [row({ createdAt: 3 * HOUR, receivedAt: 3 * HOUR })];
    const r = replayRelay(rows, [{ at: HOUR, dev: 'b' }, { at: 5 * HOUR, dev: 'b' }], { ...base, end: 5 * HOUR, graceMs: 0 });
    expect(r).toMatchObject({ downloadedRows: 1, repeatedRows: 0 });
  });

  it('補拉起點：上一輪減去時間戳抖動之前建立的包不再下載', () => {
    const rows = [row({ createdAt: 0, receivedAt: 0 })];
    const rounds = [{ at: HOUR, dev: 'b' }, { at: 4 * DAY, dev: 'b' }];
    const r = replayRelay(rows, rounds, { jitterMs: 2 * DAY, sampleMs: DAY, end: 4 * DAY, graceMs: null });
    // 第二輪的起點＝1h−2 天，包的 created_at 0 在起點之後 → 下載；第三輪以後（若有）起點越過它就不下載
    expect(r.downloadedRows).toBe(2);
    const r2 = replayRelay(rows, [...rounds, { at: 7 * DAY - HOUR, dev: 'b' }], { jitterMs: 2 * DAY, sampleMs: DAY, end: 7 * DAY, graceMs: null });
    expect(r2.downloadedRows).toBe(2);
  });
});
