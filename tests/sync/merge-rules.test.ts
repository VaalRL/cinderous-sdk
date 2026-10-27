// Markdown 合併規則的純函式（SDK ADR 0059）：任務勾選框的衝突自動合併、沒有共同祖先時以空檔為祖先（兩邊共同的行）合併。
import { describe, expect, it } from 'vitest';

import { commonLinesBase, merge3, merge3Chunks, resolveTaskCheckboxConflict } from '../../src/sync/merge3.js';

const lines = (...xs: string[]) => xs.join('\n');
const resolve = resolveTaskCheckboxConflict;

describe('resolveTaskCheckboxConflict（裁示 7）', () => {
  it('兩邊都改了同一行、只差在勾選：已勾的贏，與 local／remote 的順序無關', () => {
    const conflict = { base: ['- [ ] 買牛奶'], local: ['- [x] 買牛奶'], remote: ['- [ ] 買牛奶 '] };
    // remote 多了一個空白＝文字不同 → 不是只差在勾選
    expect(resolve(conflict)).toBeNull();
    expect(resolve({ base: ['- [ ] a', '- [ ] b'], local: ['- [x] a', '- [ ] b'], remote: ['- [ ] a', '- [x] b'] })).toEqual(['- [x] a', '- [x] b']);
    expect(resolve({ base: ['- [ ] a', '- [ ] b'], local: ['- [ ] a', '- [x] b'], remote: ['- [x] a', '- [ ] b'] })).toEqual(['- [x] a', '- [x] b']);
  });

  it('Tasks 外掛的完成日期：有日期的贏、都有取較早的；日期不影響「是不是同一個任務」', () => {
    const base = ['- [ ] 繳費 📅 2026-10-06'];
    const dated = ['- [x] 繳費 📅 2026-10-06 ✅ 2026-10-05'];
    const plain = ['- [x] 繳費 📅 2026-10-06'];
    const later = ['- [x] 繳費 📅 2026-10-06 ✅ 2026-10-07'];
    expect(resolve({ base, local: dated, remote: plain })).toEqual(dated);
    expect(resolve({ base, local: plain, remote: dated })).toEqual(dated);
    expect(resolve({ base, local: later, remote: dated })).toEqual(dated);
    expect(resolve({ base, local: dated, remote: later })).toEqual(dated);
    // 勾了（帶日期）vs 沒勾：已勾的贏
    expect(resolve({ base: plain, local: dated, remote: base })).toEqual(dated);
  });

  it('祖先逐行對得上：只有一邊改的那一行取改的那邊（一台把勾拿掉、另一台沒動那一行）', () => {
    const base = ['- [x] a', '- [ ] b'];
    expect(resolve({ base, local: ['- [ ] a', '- [ ] b'], remote: ['- [x] a', '- [x] b'] })).toEqual(['- [ ] a', '- [x] b']);
    expect(resolve({ base, local: ['- [x] a', '- [x] b'], remote: ['- [ ] a', '- [ ] b'] })).toEqual(['- [ ] a', '- [x] b']);
  });

  it('各種項目符號、縮排、引言裡的任務都認得；[x] 與 [X] 取字典序較小的', () => {
    for (const prefix of ['- ', '* ', '+ ', '1. ', '12) ', '  - ', '\t- ', '> - ', '> > * ']) {
      expect(resolve({ base: [`${prefix}[ ] t`], local: [`${prefix}[x] t`], remote: [`${prefix}[ ] t`] }), prefix).toEqual([`${prefix}[x] t`]);
    }
    expect(resolve({ base: ['- [ ] t'], local: ['- [x] t'], remote: ['- [X] t'] })).toEqual(['- [X] t']);
    expect(resolve({ base: ['- [ ] t'], local: ['- [X] t'], remote: ['- [x] t'] })).toEqual(['- [X] t']);
  });

  it('只要有一行不是「同一個任務只差在勾選」就不處理（文字、縮排、項目符號、行數、其他狀態、一般文字的相鄰修改）', () => {
    expect(resolve({ base: ['- [ ] a'], local: ['- [x] a'], remote: ['- [ ] A'] })).toBeNull();
    expect(resolve({ base: ['- [ ] a'], local: ['- [x] a'], remote: ['  - [ ] a'] })).toBeNull();
    expect(resolve({ base: ['- [ ] a'], local: ['- [x] a'], remote: ['* [ ] a'] })).toBeNull();
    expect(resolve({ base: ['- [ ] a'], local: ['- [x] a'], remote: ['- [ ] a', '- [ ] b'] })).toBeNull();
    expect(resolve({ base: ['- [ ] a'], local: ['- [x] a'], remote: ['- [/] a'] })).toBeNull();
    expect(resolve({ base: ['x', 'y'], local: ['x1', 'y'], remote: ['x', 'y1'] })).toBeNull();
    expect(resolve({ base: [], local: [], remote: [] })).toBeNull();
    expect(resolve({ base: ['- [ ] a'], local: ['[x] a'], remote: ['[ ] a'] })).toBeNull();
  });

  it('接在 merge3 上：同一行衝突只差在勾選 → 乾淨合併；沒給規則時照舊是衝突', () => {
    const base = lines('# 今天', '- [ ] a', '- [ ] b', '結尾');
    const local = lines('# 今天', '- [x] a ✅ 2026-10-05', '- [ ] b', '結尾');
    const remote = lines('# 今天', '- [ ] a', '- [x] b', '結尾');
    expect(merge3(base, local, remote).clean).toBe(false);
    expect(merge3(base, local, remote, { resolve })).toEqual({ clean: true, merged: lines('# 今天', '- [x] a ✅ 2026-10-05', '- [x] b', '結尾'), conflicts: [] });
    expect(merge3(base, remote, local, { resolve }).merged).toBe(lines('# 今天', '- [x] a ✅ 2026-10-05', '- [x] b', '結尾'));
    // 混著一般文字的衝突照舊
    const textual = lines('# 今天', '- [x] a', '- [ ] b 改了字', '結尾');
    expect(merge3(base, textual, remote, { resolve }).clean).toBe(false);
    expect(merge3Chunks(base, local, remote, { resolve }).every((c) => c.kind === 'ok')).toBe(true);
  });
});

describe('commonLinesBase（裁示 5：以空檔為祖先，衝突精簡到真正不同的地方）', () => {
  it('祖先＝兩邊共同的行；相同的範本只出現一次、只有一邊有的行直接採用', () => {
    const phone = lines('# 2026-10-05', '', '## 待辦', '- [ ] 繳電費', '', '## 紀錄');
    const desk = lines('# 2026-10-05', '', '## 待辦', '', '## 紀錄', '- 09:00 開會');
    const base = commonLinesBase(phone, desk);
    expect(base).toBe(lines('# 2026-10-05', '', '## 待辦', '', '## 紀錄'));
    const result = merge3(base, phone, desk);
    expect(result).toEqual({ clean: true, merged: lines('# 2026-10-05', '', '## 待辦', '- [ ] 繳電費', '', '## 紀錄', '- 09:00 開會'), conflicts: [] });
    expect(merge3(commonLinesBase(desk, phone), desk, phone).merged).toBe(result.merged);
  });

  it('同一處兩邊各自新增不同的行 → 衝突（只有那幾行）；不會刪掉任何一邊的內容', () => {
    const a = lines('# 日記', '早上喝咖啡');
    const b = lines('# 日記', '早上跑步');
    const result = merge3(commonLinesBase(a, b), a, b);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ base: [], local: ['早上喝咖啡'], remote: ['早上跑步'] }]);
  });

  it('真正的空檔祖先（沒有精簡）會把整份當成一個衝突——這就是要精簡的原因', () => {
    const a = lines('# 日記', '早上喝咖啡');
    const b = lines('# 日記', '早上跑步');
    expect(merge3('', a, b).conflicts).toHaveLength(1);
    expect(merge3('', a, b).conflicts[0]!.local).toEqual(['# 日記', '早上喝咖啡']);
  });

  it('一邊是空檔或兩邊相同：祖先就是較少的那一邊，合併結果是有內容的那一邊', () => {
    expect(merge3(commonLinesBase('', 'x\ny'), '', 'x\ny').merged).toBe('x\ny');
    expect(merge3(commonLinesBase('x\ny', 'x\ny'), 'x\ny', 'x\ny').merged).toBe('x\ny');
  });

  it('同一處兩邊都新增、只差在勾選的任務也自動合併', () => {
    const a = lines('# 2026-10-05', '- [x] 繳電費 ✅ 2026-10-05');
    const b = lines('# 2026-10-05', '- [ ] 繳電費');
    expect(merge3(commonLinesBase(a, b), a, b, { resolve }).merged).toBe(a);
  });
});
