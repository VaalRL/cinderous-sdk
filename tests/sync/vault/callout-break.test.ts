// 衝突 callout 後空一行（SDK ADR 0087）：Obsidian 會把 callout 下一行的內文算進 callout（懶惰續行），摺疊時那行看不到。
// 新格式：標題帶 `%% cinder-break %%`、callout 後固定一個空行；解析把這個空行算進 callout、解決時一起拿掉（往返不多空行）。
// 模式由版本資料決定（id 的標記，同 ADR 0046／0059）：所有版本頭都帶標記才用新格式，否則與 v0.60 位元組相同。
import { describe, expect, it } from 'vitest';

import {
  isCalloutBreakId,
  isCalloutCapableId,
  isMergeRulesId,
  markCalloutBreakId,
  markCalloutCapableId,
  markMergeRulesId,
  mergeWithConflictCallouts,
  parseConflictCallouts,
  resolveConflictCallout,
  supportsCalloutBreak,
  type CalloutAuthorOf,
  type VaultSyncOptions,
  type VaultVersion,
} from '../../../src/sync/vault/index.js';
import { type Device, Net } from './harness.js';

const T0 = Date.UTC(2026, 9, 1, 10, 32, 5);
const T1 = Date.UTC(2026, 9, 1, 10, 45, 0);
const mac = { label: 'MacBook', device: 'mac', at: T0 };
const phone = { label: 'iPhone', device: 'phone', at: T1 };
const authors: CalloutAuthorOf = (side) => (side === 'local' ? mac : phone);

const brk = (base: string, local: string, remote: string, who: CalloutAuthorOf = authors) =>
  mergeWithConflictCallouts(base, local, remote, who, { calloutBreak: true });
const old = (base: string, local: string, remote: string, who: CalloutAuthorOf = authors) => mergeWithConflictCallouts(base, local, remote, who);

describe('格式：callout 後空一行', () => {
  it('標題帶 %% cinder-break %%，callout 後固定一個空行（下一行內文不再被算進 callout）', () => {
    const r = brk('a\nX\nb', 'a\nX-mac\nb', 'a\nX-phone\nb')!;
    const id = r.callouts[0]!;
    expect(r.text).toBe(
      [
        'a',
        `> [!conflict]- 同步衝突（2 個版本） %% cinder-break %% %% cinder-conflict:${id} %%`,
        `> **MacBook · 2026-10-01 10:32 UTC** %% cinder-version:${T0}:mac %%`,
        '> X-mac',
        '>',
        `> **iPhone · 2026-10-01 10:45 UTC** %% cinder-version:${T1}:phone %%`,
        '> X-phone',
        '>',
        '',
        'b',
      ].join('\n'),
    );
  });

  it('沒開：與舊格式位元組相同（同一個 id）', () => {
    const r = old('a\nX\nb', 'a\nX-mac\nb', 'a\nX-phone\nb')!;
    expect(r.text).not.toContain('cinder-break');
    expect(r.text.endsWith('>\nb')).toBe(true);
    expect(brk('a\nX\nb', 'a\nX-mac\nb', 'a\nX-phone\nb')!.callouts).toEqual(r.callouts);
  });

  it('確定性：local／remote 對調得到位元組相同的結果', () => {
    const swapped: CalloutAuthorOf = (side) => (side === 'local' ? phone : mac);
    expect(brk('a\nX\nb', 'a\nX-phone\nb', 'a\nX-mac\nb', swapped)!.text).toBe(brk('a\nX\nb', 'a\nX-mac\nb', 'a\nX-phone\nb')!.text);
  });
});

describe('解析與解決：空行算進 callout，往返不多也不少空行', () => {
  const cases: Array<[string, string, string]> = [
    ['中間', 'a\nX\nb', 'a\nX-mac\nb'],
    ['後面本來就有空行', 'a\nX\n\nb', 'a\nX-mac\n\nb'],
    ['檔案最後一行、沒有結尾換行', 'a\nX', 'a\nX-mac'],
    ['檔案最後一行、有結尾換行', 'a\nX\n', 'a\nX-mac\n'],
  ];
  for (const [name, base, expected] of cases) {
    it(name, () => {
      const r = brk(base, base.replace('X', 'X-mac'), base.replace('X', 'X-phone'))!;
      const [c] = parseConflictCallouts(r.text);
      expect(c!.versions.map((v) => v.lines)).toEqual([['X-mac'], ['X-phone']]);
      expect(r.text.slice(c!.end)).toBe(base.slice(base.indexOf('X') + 2));
      expect(resolveConflictCallout(r.text, c!.id, 0)).toBe(expected);
    });
  }

  it('舊格式（沒有旗標）的 callout 後面的空行是使用者的：解析與解決都不動它', () => {
    const r = old('a\nX\n\nb', 'a\nX-mac\n\nb', 'a\nX-phone\n\nb')!;
    const [c] = parseConflictCallouts(r.text);
    expect(resolveConflictCallout(r.text, c!.id, 1)).toBe('a\nX-phone\n\nb');
  });
});

describe('再衝突：不巢狀、空行不累積', () => {
  const base = 'a\nb\nc';
  const first = brk(base, 'a\nB-mac\nc', 'a\nB-phone\nc')!;
  const pad = { label: 'iPad', device: 'pad', at: T1 + 60_000 };

  it('一邊是整個 callout（含後面的空行）、另一邊是第三台的修改 → 併入同一個 callout，只有一個空行', () => {
    const r = brk(base, first.text, 'a\nB-pad\nc', (side) => (side === 'local' ? mac : pad))!;
    const callouts = parseConflictCallouts(r.text);
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.versions.map((v) => v.lines[0])).toEqual(['B-mac', 'B-phone', 'B-pad']);
    expect(r.text).not.toContain('> >');
    expect(r.text.endsWith('>\n\nc')).toBe(true);
  });

  it('沒開的合併遇到帶旗標的 callout：退回衝突副本（null），與舊版裝置算出同一個結果', () => {
    expect(old(base, first.text, 'a\nB-pad\nc', (side) => (side === 'local' ? mac : pad))).toBeNull();
  });
});

describe('版本 id 的標記', () => {
  it('第 9–16 位；與合併規則、callout 的標記可以同時帶；合併版本＝父版本都支援', () => {
    const raw = '0123456789abcdef0123456789abcdef';
    const b = markCalloutBreakId(raw);
    expect(b.slice(0, 8)).toBe(raw.slice(0, 8));
    expect(b.slice(16)).toBe(raw.slice(16));
    expect([isCalloutBreakId(b), isCalloutBreakId(raw), isMergeRulesId(b), isCalloutCapableId(b)]).toEqual([true, false, false, false]);
    const all = markCalloutCapableId(markMergeRulesId(markCalloutBreakId(raw)));
    expect([isCalloutBreakId(all), isMergeRulesId(all), isCalloutCapableId(all)]).toEqual([true, true, true]);
    const v = (id: string, parents: string[] = []): VaultVersion => ({ id, parents, path: 'a.md', pathAt: 1, deleted: false, hash: 'a'.repeat(64), size: 1, text: true, at: 1, device: 'd', label: 'D', p2p: false });
    const x = markCalloutBreakId('a'.repeat(32));
    const y = markCalloutBreakId('b'.repeat(32));
    const z = 'c'.repeat(32);
    const m = 'd'.repeat(32);
    const n = 'e'.repeat(32);
    const nodes = { [x]: v(x), [y]: v(y), [z]: v(z), [m]: v(m, [x, y]), [n]: v(n, [x, z]) };
    expect([supportsCalloutBreak(nodes, m), supportsCalloutBreak(nodes, n), supportsCalloutBreak(nodes, 'f'.repeat(32))]).toEqual([true, false, false]);
  });
});

const BREAK_ON: Partial<VaultSyncOptions> = { conflictCallouts: true, calloutBreak: true };
const CALLOUTS_ONLY: Partial<VaultSyncOptions> = { conflictCallouts: true };

async function concurrent(options: Array<Partial<VaultSyncOptions>>, base: string, edits: string[]) {
  const net = new Net({ seed: 3, maxDelayMs: 50 });
  const list: Device[] = [];
  for (const [i, o] of options.entries()) list.push(await net.add(`d${i}`, { options: o }));
  await list[0]!.edit('n.md', base);
  await net.settle();
  for (const d of list) d.transport.setOnline(false);
  for (const [i, d] of list.entries()) {
    await d.edit('n.md', edits[i]!);
    await net.clock.advance(1000);
  }
  for (const d of list) d.transport.setOnline(true);
  await net.settle();
  return { net, list };
}

describe('協調器：模式由版本資料決定', () => {
  it('兩台都開：位元組相同的新格式；解決後寫回，另一台收到的內容沒有多出空行', async () => {
    const { net, list } = await concurrent([BREAK_ON, BREAK_ON], 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const [a, b] = list as [Device, Device];
    const text = a.vault.get('n.md')!;
    expect(b.vault.get('n.md')).toBe(text);
    expect(text).toContain('%% cinder-break %%');
    expect(text.endsWith('>\n\ny')).toBe(true);
    const [c] = parseConflictCallouts(text);
    await a.edit('n.md', resolveConflictCallout(text, c!.id, 'both-by-time'));
    await net.settle();
    expect(b.vault.get('n.md')).toBe('x\nline-a\nline-b\ny');
  });

  it('有一台沒開：兩台都是舊格式（與 v0.60 相同），位元組相同', async () => {
    const { list } = await concurrent([BREAK_ON, CALLOUTS_ONLY], 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const [a, b] = list as [Device, Device];
    const text = a.vault.get('n.md')!;
    expect(b.vault.get('n.md')).toBe(text);
    expect(text).not.toContain('cinder-break');
    expect(parseConflictCallouts(text)).toHaveLength(1);
  });

  it('setCalloutBreak 只影響之後寫出的版本；預設不帶標記', async () => {
    const net = new Net({ seed: 4 });
    const a = await net.add('a', { options: CALLOUTS_ONLY });
    expect(a.sync.calloutBreak).toBe(false);
    a.sync.setCalloutBreak(true);
    expect(a.sync.calloutBreak).toBe(true);
  });
});
