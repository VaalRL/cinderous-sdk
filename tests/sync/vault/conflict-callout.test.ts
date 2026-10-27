// Markdown 的衝突 callout（SDK ADR 0046）：格式、解析與解決的往返、特殊內容退回、再衝突不巢狀。
import { describe, expect, it } from 'vitest';

import {
  CONFLICT_CALLOUT_MAX_LINES,
  isMarkdownPath,
  mergeWithConflictCallouts,
  parseConflictCallouts,
  renderConflictCallout,
  resolveConflictCallout,
  type CalloutAuthorOf,
} from '../../../src/sync/vault/index.js';

const T0 = Date.UTC(2026, 9, 1, 10, 32, 5);
const T1 = Date.UTC(2026, 9, 1, 10, 45, 0);
const mac = { label: 'MacBook', device: 'mac', at: T0 };
const phone = { label: 'iPhone', device: 'phone', at: T1 };
/** local＝MacBook，remote＝iPhone */
const authors: CalloutAuthorOf = (side) => (side === 'local' ? mac : phone);

function merge(base: string, local: string, remote: string, who: CalloutAuthorOf = authors) {
  return mergeWithConflictCallouts(base, local, remote, who);
}

describe('格式（定案）', () => {
  it('只包住衝突的那幾行；其他部分照常三方合併；版本依時間排序、標示裝置名稱與 UTC 時間；最後一行是單獨的 >', () => {
    const base = '# 標題\n第一段\n中間\n結尾';
    const local = '# 標題（Mac 改）\n第一段\n中間 Mac\n結尾';
    const remote = '# 標題\n第一段\n中間 iPhone\n結尾\n追加';
    const result = merge(base, local, remote)!;
    expect(result.callouts).toHaveLength(1);
    const id = result.callouts[0]!;
    expect(result.text).toBe(
      [
        '# 標題（Mac 改）',
        '第一段',
        `> [!conflict]- 同步衝突（2 個版本） %% cinder-conflict:${id} %%`,
        `> **MacBook · 2026-10-01 10:32 UTC** %% cinder-version:${T0}:mac %%`,
        '> 中間 Mac',
        '>',
        `> **iPhone · 2026-10-01 10:45 UTC** %% cinder-version:${T1}:phone %%`,
        '> 中間 iPhone',
        '>',
        '結尾',
        '追加',
      ].join('\n'),
    );
  });

  it('確定性：local／remote 對調（另一台裝置的合併順序）得到位元組相同的結果與 id', () => {
    const base = 'a\nb\nc';
    const x = merge(base, 'a\nB1\nc', 'a\nB2\nc')!;
    const swapped: CalloutAuthorOf = (side) => (side === 'local' ? phone : mac);
    const y = merge(base, 'a\nB2\nc', 'a\nB1\nc', swapped)!;
    expect(y.text).toBe(x.text);
    expect(y.callouts).toEqual(x.callouts);
  });

  it('時間相同依裝置 id 排序；裝置名稱裡的 Markdown 字元與換行被轉義', () => {
    const { lines } = renderConflictCallout([
      { label: 'z*bold*\n', device: 'zz', at: T0, lines: ['z'] },
      { label: 'a', device: 'aa', at: T0, lines: ['a'] },
    ]);
    expect(lines[1]).toContain('**a · ');
    expect(lines[4]).toContain('**z\\*bold\\* · ');
    const [parsed] = parseConflictCallouts(lines.join('\n'));
    expect(parsed!.versions.map((v) => v.label)).toEqual(['a', 'z*bold*']);
  });

  it('空行與「整段刪掉」的版本都保留得住', () => {
    const { id, lines } = renderConflictCallout([
      { ...mac, lines: ['', 'x', ''] },
      { ...phone, lines: [] },
    ]);
    const [parsed] = parseConflictCallouts(['前', ...lines, '後'].join('\n'));
    expect(parsed!.id).toBe(id);
    expect(parsed!.versions.map((v) => v.lines)).toEqual([['', 'x', ''], []]);
  });

  it('只有 .md 用 callout', () => {
    expect(isMarkdownPath('notes/a.md')).toBe(true);
    expect(isMarkdownPath('A.MD')).toBe(true);
    expect(isMarkdownPath('a.markdown')).toBe(false);
    expect(isMarkdownPath('a.txt')).toBe(false);
  });
});

describe('parseConflictCallouts／resolveConflictCallout 往返', () => {
  const base = 'a\nb\nc';
  const local = 'a\nB-mac\nc';
  const remote = 'a\nB-phone\nB-phone-2\nc';
  const merged = () => merge(base, local, remote)!;

  it('解析出 id、版本、行號與字元位置', () => {
    const { text, callouts } = merged();
    const [c] = parseConflictCallouts(text);
    expect(c!.id).toBe(callouts[0]);
    expect(c!.versions).toEqual([
      { label: 'MacBook', device: 'mac', at: T0, lines: ['B-mac'] },
      { label: 'iPhone', device: 'phone', at: T1, lines: ['B-phone', 'B-phone-2'] },
    ]);
    expect(text.split('\n')[c!.startLine]).toMatch(/^> \[!conflict\]-/);
    expect(text.slice(c!.start, c!.end).split('\n')[0]).toMatch(/^> \[!conflict\]-/);
    expect(text.slice(c!.end)).toBe('c');
  });

  it('選某個版本／兩個都留（依時間）／自訂文字', () => {
    const { text, callouts } = merged();
    const id = callouts[0]!;
    expect(resolveConflictCallout(text, id, 0)).toBe('a\nB-mac\nc');
    expect(resolveConflictCallout(text, id, 1)).toBe(remote);
    expect(resolveConflictCallout(text, id, 'both-by-time')).toBe('a\nB-mac\nB-phone\nB-phone-2\nc');
    expect(resolveConflictCallout(text, id, { text: '自己寫\n兩行' })).toBe('a\n自己寫\n兩行\nc');
    expect(() => resolveConflictCallout(text, id, 5)).toThrow(RangeError);
    expect(() => resolveConflictCallout(text, 'ffffffffffff', 0)).toThrow('找不到');
  });

  it('手動刪掉 callout＝已解決（解析不到）', () => {
    const { text } = merged();
    const lines = text.split('\n').filter((line) => !line.startsWith('>'));
    expect(parseConflictCallouts(lines.join('\n'))).toEqual([]);
  });

  it('同一份文件好幾處衝突：各自有 id，逐處解決', () => {
    const r = merge('1\nx\n2\ny\n3', '1\nx-mac\n2\ny-mac\n3', '1\nx-phone\n2\ny-phone\n3')!;
    expect(r.callouts).toHaveLength(2);
    const once = resolveConflictCallout(r.text, r.callouts[1]!, 1);
    expect(parseConflictCallouts(once).map((c) => c.id)).toEqual([r.callouts[0]]);
    expect(resolveConflictCallout(once, r.callouts[0]!, 0)).toBe('1\nx-mac\n2\ny-phone\n3');
  });

  it('衝突在檔案最後一行（沒有結尾換行）也能精確還原', () => {
    const r = merge('a\nlast', 'a\nlast-mac', 'a\nlast-phone')!;
    expect(resolveConflictCallout(r.text, r.callouts[0]!, 0)).toBe('a\nlast-mac');
    const withNewline = merge('a\nlast\n', 'a\nlast-mac\n', 'a\nlast-phone\n')!;
    expect(resolveConflictCallout(withNewline.text, withNewline.callouts[0]!, 1)).toBe('a\nlast-phone\n');
  });
});

describe('特殊內容：轉義或退回衝突副本（null），絕不損壞內容', () => {
  it('CRLF：三份都是 CRLF → 結果維持 CRLF，解析與解決照樣可用', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const r = merge(crlf('a\nb\nc\n'), crlf('a\nB1\nc\n'), crlf('a\nB2\nc\n'))!;
    expect(r.text.includes('\r\n')).toBe(true);
    expect(/(^|[^\r])\n/.test(r.text)).toBe(false);
    const [c] = parseConflictCallouts(r.text);
    expect(c!.versions.map((v) => v.lines)).toEqual([['B1'], ['B2']]);
    expect(resolveConflictCallout(r.text, c!.id, 0)).toBe(crlf('a\nB1\nc\n'));
  });

  it('換行混用 → null', () => {
    expect(merge('a\r\nb\r\nc', 'a\r\nB1\r\nc', 'a\nB2\nc')).toBeNull();
    expect(merge('a\nb\nc', 'a\nB1\rx\nc', 'a\nB2\nc')).toBeNull();
  });

  it('衝突在程式碼圍欄裡 → null；版本內容有未閉合的圍欄 → null；成對的圍欄放得進去', () => {
    expect(merge('```\ncode\n```', '```\ncode-mac\n```', '```\ncode-phone\n```')).toBeNull();
    expect(merge('a\nb\nc', 'a\n```js\nc', 'a\nB2\nc')).toBeNull();
    const ok = merge('a\nb\nc', 'a\n```js\nx()\n```\nc', 'a\nB2\nc')!;
    expect(parseConflictCallouts(ok.text)[0]!.versions[0]!.lines).toEqual(['```js', 'x()', '```']);
  });

  it('front matter 裡的衝突 → null（不能把 callout 插進 YAML）', () => {
    expect(merge('---\ntags: a\n---\nbody', '---\ntags: mac\n---\nbody', '---\ntags: phone\n---\nbody')).toBeNull();
    // front matter 之後的衝突照常
    expect(merge('---\nt: 1\n---\nbody', '---\nt: 1\n---\nbody-mac', '---\nt: 1\n---\nbody-phone')).not.toBeNull();
  });

  it('前後緊鄰引言（> 開頭的行）→ null（否則會併進同一個引言區塊）', () => {
    expect(merge('> q\nb\nc', '> q\nB1\nc', '> q\nB2\nc')).toBeNull();
    expect(merge('a\nb\n> q', 'a\nB1\n> q', 'a\nB2\n> q')).toBeNull();
  });

  it('內容本身是引言或 callout 的開頭：加一層 > 轉義，往返不變', () => {
    const r = merge('a\nb\nc', 'a\n> 引言\n> [!note] 標題\nc', 'a\nB2\nc')!;
    expect(r.text).toContain('> > [!note] 標題');
    expect(resolveConflictCallout(r.text, r.callouts[0]!, 0)).toBe('a\n> 引言\n> [!note] 標題\nc');
  });

  it('內容帶著 callout 標記、未成對的 %% 或 <!-- → null', () => {
    expect(merge('a\nb\nc', 'a\n%% cinder-conflict:abcdefabcdef %%\nc', 'a\nB2\nc')).toBeNull();
    expect(merge('a\nb\nc', 'a\n%% 註解沒關\nc', 'a\nB2\nc')).toBeNull();
    expect(merge('a\nb\nc', 'a\n<!-- 沒關\nc', 'a\nB2\nc')).toBeNull();
  });

  it('超長 → null', () => {
    const long = Array.from({ length: CONFLICT_CALLOUT_MAX_LINES }, (_, i) => `line ${i}`).join('\n');
    expect(merge('a\nb\nc', `a\n${long}\nc`, 'a\nB2\nc')).toBeNull();
  });
});

describe('已存在的 callout 再次衝突：收斂、不巢狀', () => {
  const base = 'a\nb\nc';
  const first = merge(base, 'a\nB-mac\nc', 'a\nB-phone\nc')!;
  const pad = { label: 'iPad', device: 'pad', at: T1 + 60_000 };

  it('一邊是整個 callout、另一邊是第三台的修改 → 版本攤開併入同一個 callout（3 個版本）', () => {
    const r = merge(base, first.text, 'a\nB-pad\nc', (side) => (side === 'local' ? mac : pad))!;
    const callouts = parseConflictCallouts(r.text);
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.versions.map((v) => v.lines[0])).toEqual(['B-mac', 'B-phone', 'B-pad']);
    expect(r.text).not.toContain('> >');
  });

  it('兩台各自解決得不一樣（祖先是 callout）→ 新的 callout 只放兩個解決結果', () => {
    const resolvedMac = resolveConflictCallout(first.text, first.callouts[0]!, 0);
    const resolvedPhone = resolveConflictCallout(first.text, first.callouts[0]!, 1);
    const later = (side: 'local' | 'remote') => (side === 'local' ? { ...mac, at: T1 + 1 } : { ...phone, at: T1 + 2 });
    const r = merge(first.text, resolvedMac, resolvedPhone, later)!;
    const callouts = parseConflictCallouts(r.text);
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.versions.map((v) => v.lines)).toEqual([['B-mac'], ['B-phone']]);
  });

  it('一台解決、另一台沒動 callout → 乾淨合併成解決後的內容（不需要 callout）', () => {
    const resolved = resolveConflictCallout(first.text, first.callouts[0]!, 'both-by-time');
    // 沒有衝突時 mergeWithConflictCallouts 照樣回傳合併結果、callouts 為空（呼叫端只在 merge3 有衝突時才用它）
    const r = merge(first.text, resolved, first.text)!;
    expect(r.callouts).toEqual([]);
    expect(r.text).toBe('a\nB-mac\nB-phone\nc');
  });
});
