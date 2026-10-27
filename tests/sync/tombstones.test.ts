// 檔案墓碑（SDK ADR 0011 §4；PRD 2.6）。
import { describe, expect, it } from 'vitest';

import { gcTombstones, isDeleted, isStaleDevice, mergeTombstones, TOMBSTONE_TTL_MS } from '../../src/sync/tombstones.js';

const DAY = 86_400_000;

describe('墓碑', () => {
  it('合併：同一路徑取較新的刪除時間；可交換（順序不影響結果）', () => {
    const a = [{ path: 'a.md', deletedAt: 10 }, { path: 'b.md', deletedAt: 5 }];
    const b = [{ path: 'a.md', deletedAt: 20 }, { path: 'c.md', deletedAt: 1 }];
    const expected = [
      { path: 'a.md', deletedAt: 20 },
      { path: 'b.md', deletedAt: 5 },
      { path: 'c.md', deletedAt: 1 },
    ];
    expect(mergeTombstones(a, b)).toEqual(expected);
    expect(mergeTombstones(b, a)).toEqual(expected);
  });

  it('LWW：檔案比墓碑新 → 復活；墓碑比較新 → 已刪', () => {
    const tombstones = [{ path: 'doc.md', deletedAt: 100 }];
    expect(isDeleted('doc.md', 150, tombstones)).toBe(false); // 刪了之後又重新建立
    expect(isDeleted('doc.md', 50, tombstones)).toBe(true);
    expect(isDeleted('other.md', 50, tombstones)).toBe(false);
  });

  it('🔴 平手算已刪（寧可不要讓刪掉的檔案復活）', () => {
    expect(isDeleted('doc.md', 100, [{ path: 'doc.md', deletedAt: 100 }])).toBe(true);
  });

  it('超過 30 天的墓碑清掉；30 天內的保留', () => {
    const now = 1_000 * DAY;
    const kept = { path: 'new.md', deletedAt: now - 29 * DAY };
    const gone = { path: 'old.md', deletedAt: now - 31 * DAY };
    expect(gcTombstones([kept, gone], now)).toEqual([kept]);
    expect(TOMBSTONE_TTL_MS).toBe(30 * DAY);
  });
});

describe('沉睡裝置隔離', () => {
  it('🔴 離線超過 30 天才回來 → 視為沉睡（它的墓碑可能已被別台清掉，變更要先請使用者確認）', () => {
    const now = 1_000 * DAY;
    expect(isStaleDevice(now - 31 * DAY, now)).toBe(true);
    expect(isStaleDevice(now - 29 * DAY, now)).toBe(false);
  });

  it('從沒同步過的新裝置不算沉睡', () => {
    expect(isStaleDevice(undefined, 1_000 * DAY)).toBe(false);
  });
});
