// 行級三方合併（SDK ADR 0011 §3；PRD 2.6）。
import { describe, expect, it } from 'vitest';

import { conflictCopyName, diffLines, freePathCandidate, merge3, parseConflictCopyName, renderWithConflictMarkers } from '../../src/sync/merge3.js';

const lines = (...xs: string[]) => xs.join('\n');

describe('diffLines', () => {
  it('回傳兩邊相同的行（最長共同子序列），索引遞增', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });

  it('空的一邊 → 沒有相同的行', () => {
    expect(diffLines([], ['a'])).toEqual([]);
    expect(diffLines(['a'], [])).toEqual([]);
  });
});

describe('merge3', () => {
  const base = lines('# 標題', '第一段', '第二段', '第三段');

  it('兩邊都沒改 → 原樣', () => {
    expect(merge3(base, base, base)).toEqual({ clean: true, merged: base, conflicts: [] });
  });

  it('只有一邊改 → 取改的那邊', () => {
    const local = lines('# 標題', '第一段（改）', '第二段', '第三段');
    expect(merge3(base, local, base).merged).toBe(local);
    expect(merge3(base, base, local).merged).toBe(local);
  });

  it('兩邊改不同段落 → 自動合併，沒有衝突', () => {
    const local = lines('# 標題', '第一段（本機）', '第二段', '第三段');
    const remote = lines('# 標題', '第一段', '第二段', '第三段（遠端）');
    const result = merge3(base, local, remote);
    expect(result.clean).toBe(true);
    expect(result.merged).toBe(lines('# 標題', '第一段（本機）', '第二段', '第三段（遠端）'));
  });

  it('一邊刪行、另一邊改別行 → 自動合併', () => {
    const local = lines('# 標題', '第二段', '第三段');
    const remote = lines('# 標題', '第一段', '第二段', '第三段（遠端）');
    expect(merge3(base, local, remote)).toMatchObject({ clean: true, merged: lines('# 標題', '第二段', '第三段（遠端）') });
  });

  it('兩邊做了一模一樣的修改 → 不算衝突', () => {
    const both = lines('# 標題', '第一段（同樣的改法）', '第二段', '第三段');
    expect(merge3(base, both, both)).toMatchObject({ clean: true, merged: both });
  });

  it('兩邊改同一段而且改得不一樣 → 衝突，回報三方的內容', () => {
    const local = lines('# 標題', '第一段（本機）', '第二段', '第三段');
    const remote = lines('# 標題', '第一段（遠端）', '第二段', '第三段');
    const result = merge3(base, local, remote);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ base: ['第一段'], local: ['第一段（本機）'], remote: ['第一段（遠端）'] }]);
  });

  it('兩邊在檔尾加了不同的內容 → 衝突', () => {
    const result = merge3(base, lines(base, '本機新增'), lines(base, '遠端新增'));
    expect(result.clean).toBe(false);
    expect(result.conflicts[0]).toEqual({ base: [], local: ['本機新增'], remote: ['遠端新增'] });
  });

  it('衝突之外的部分照樣合併', () => {
    const local = lines('# 標題（本機）', '第一段（本機）', '第二段', '第三段');
    const remote = lines('# 標題', '第一段（遠端）', '第二段', '第三段（遠端）');
    const result = merge3(base, local, remote);
    expect(result.conflicts).toHaveLength(1);
    // 標題與第一段相鄰，同屬一個不穩定區塊；第三段只有遠端改 ⇒ 自動合併
    expect(renderWithConflictMarkers(result)).toContain('第三段（遠端）');
  });
});

describe('renderWithConflictMarkers（PRD「雙版本合併拼接」）', () => {
  it('衝突區塊前後插入標記，兩邊全文都保留', () => {
    const result = merge3(lines('a', 'b', 'c'), lines('a', 'B1', 'c'), lines('a', 'B2', 'c'));
    expect(renderWithConflictMarkers(result, { local: 'MacBook', remote: 'ThinkPad' })).toBe(
      lines('a', '<<<<<<< MacBook', 'B1', '=======', 'B2', '>>>>>>> ThinkPad', 'c'),
    );
  });

  it('沒有衝突 → 就是合併結果', () => {
    const result = merge3('a', 'b', 'a');
    expect(renderWithConflictMarkers(result)).toBe('b');
  });
});

describe('conflictCopyName（PRD：[檔名] (衝突-[設備別名]-[時間戳]).md）', () => {
  const at = Date.UTC(2026, 8, 27, 10, 15, 30);

  it('保留副檔名', () => {
    expect(conflictCopyName('notes/doc.md', 'MacBook', at)).toBe('notes/doc (衝突-MacBook-20260927-101530).md');
  });

  it('沒有副檔名、或只有開頭的點（隱藏檔）', () => {
    expect(conflictCopyName('Makefile', 'x', at)).toBe('Makefile (衝突-x-20260927-101530)');
    expect(conflictCopyName('.env', 'x', at)).toBe('.env (衝突-x-20260927-101530)');
  });

  it('設備別名裡的路徑字元換掉，不會把副本寫到別的資料夾', () => {
    expect(conflictCopyName('doc.md', '../壞/名字', at)).toBe('doc (衝突-.._壞_名字-20260927-101530).md');
  });
});

describe('parseConflictCopyName（CinderSync G18；與 conflictCopyName、協調器的 #freePath 同一處維護）', () => {
  const at = Date.UTC(2026, 8, 27, 10, 15, 30);

  it('🔴 沒有副檔名的原檔＋含點的裝置名稱（README＋「Joe.Mac」）：拆得回來，含編號（v0.44.0 修正）', () => {
    const copy = conflictCopyName('README', 'Joe.Mac', at);
    expect(copy).toBe('README (衝突-Joe.Mac-20260927-101530)');
    expect(parseConflictCopyName(copy)).toEqual({ original: 'README', label: 'Joe.Mac', at, copyPath: copy });
    // 編號加在「副檔名」之前（`README (衝突-Joe 2.Mac-…)`）：這個名稱同時也是裝置「Joe 2.Mac」的副本，兩種讀法的原檔都是 README
    const numbered = freePathCandidate(copy, 2);
    expect(numbered).toBe('README (衝突-Joe 2.Mac-20260927-101530)');
    expect(parseConflictCopyName(numbered)).toMatchObject({ original: 'README', at });
    const nested = conflictCopyName('notes/v1.2/README', 'a.b', at);
    expect(parseConflictCopyName(nested)?.original).toBe('notes/v1.2/README');
  });

  it('🔴 conflictCopyName 產生的檔名都拆得回來（原檔、裝置名稱、時間）', () => {
    for (const [path, label] of [
      ['notes/doc.md', 'MacBook'],
      ['Makefile', 'x'],
      ['.env', 'x'],
      ['a/b/c.tar.gz', 'Pixel-8 Pro'],
      ['doc.md', '../壞/名字'],
      ['會議 (衝突-討論).md', '我的-手機'],
    ] as const) {
      const copy = conflictCopyName(path, label, at);
      expect(parseConflictCopyName(copy)).toEqual({ original: path, label: label.replace(/[/\\:*?"<>|]/g, '_'), at, copyPath: copy });
    }
  });

  it('🔴 名稱被佔用時協調器加的編號（從 2 起，加在副檔名之前）也認得', () => {
    const copy = conflictCopyName('notes/doc.md', 'MacBook', at);
    expect(freePathCandidate(copy, 2)).toBe('notes/doc (衝突-MacBook-20260927-101530) 2.md');
    expect(parseConflictCopyName(freePathCandidate(copy, 2))).toEqual({ original: 'notes/doc.md', label: 'MacBook', at, copyPath: copy, n: 2 });
    expect(parseConflictCopyName(freePathCandidate(copy, 17))?.n).toBe(17);
    // 沒有副檔名
    const bare = conflictCopyName('Makefile', 'x', at);
    expect(parseConflictCopyName(freePathCandidate(bare, 3))).toMatchObject({ original: 'Makefile', n: 3 });
  });

  it('衝突副本的衝突副本：最外層的原檔是內層的副本', () => {
    const inner = conflictCopyName('doc.md', 'A', at);
    const outer = conflictCopyName(inner, 'B', at + 1000);
    expect(parseConflictCopyName(outer)).toMatchObject({ original: inner, label: 'B', at: at + 1000 });
  });

  it('不是 SDK 產生的：使用者自己取的名字、日期不合法、編號 0／1／前導 0、裝置名稱含會被換掉的字元 → null', () => {
    for (const path of [
      'notes/doc.md',
      '會議 (衝突-討論).md',
      'doc (衝突-A-20261327-101530).md', // 13 月
      'doc (衝突-A-20260927-246030).md', // 24:60
      'doc (衝突-A-2026927-101530).md',
      'doc (衝突-A-20260927-101530) 1.md',
      'doc (衝突-A-20260927-101530) 0.md',
      'doc (衝突-A-20260927-101530) 02.md',
      'doc (衝突-A:B-20260927-101530).md',
      'doc (衝突-A-20260927-101530).md.bak',
      'doc(衝突-A-20260927-101530).md',
    ]) {
      expect(parseConflictCopyName(path), path).toBeNull();
    }
  });

  it('freePathCandidate 與 conflictCopyName 拆副檔名的方式相同（資料夾名稱裡的點不算）', () => {
    expect(freePathCandidate('a.b/c', 2)).toBe('a.b/c 2');
    expect(freePathCandidate('a/.env', 2)).toBe('a/.env 2');
    expect(freePathCandidate('x.md', 2)).toBe('x 2.md');
  });
});
