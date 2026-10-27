// 衝突 callout 與協調器（SDK ADR 0046）：模式由版本資料決定、多台裝置收斂到位元組相同的結果、
// 非 Markdown 與舊版照舊衝突副本、解決後的文字正常同步、再衝突不巢狀。
import { describe, expect, it } from 'vitest';

import {
  isCalloutCapableId,
  markCalloutCapableId,
  parseConflictCallouts,
  resolveConflictCallout,
  supportsConflictCallouts,
  type VaultConflict,
  type VaultSyncOptions,
  type VaultVersion,
} from '../../../src/sync/vault/index.js';
import { Net, type Device } from './harness.js';

const ON: Partial<VaultSyncOptions> = { conflictCallouts: true };

async function devices(names: string[], options: Record<string, Partial<VaultSyncOptions>> = {}, seed = 1) {
  const net = new Net({ seed, maxDelayMs: 50 });
  const out: Device[] = [];
  for (const name of names) out.push(await net.add(name, { options: options[name] ?? ON }));
  return { net, devices: out };
}

/** 每台都先拿到同一份檔案，然後全部離線、各改同一行，再一起上線 */
async function concurrentEdit(net: Net, list: Device[], path: string, base: string, edits: string[]) {
  await list[0]!.edit(path, base);
  await net.settle();
  for (const d of list) d.transport.setOnline(false);
  for (const [i, d] of list.entries()) {
    await d.edit(path, edits[i]!);
    await net.clock.advance(1000);
  }
  for (const d of list) d.transport.setOnline(true);
  await net.settle();
}

const conflictsOf = (list: Device[]): VaultConflict[] => list.flatMap((d) => d.sync.status().conflicts);

describe('版本 id 帶「支援 callout」的標記（模式由版本資料決定）', () => {
  it('markCalloutCapableId／isCalloutCapableId；合併版本＝父版本都支援', () => {
    const marked = markCalloutCapableId('0123456789abcdef0123456789abcdef');
    expect(marked.slice(0, 24)).toBe('0123456789abcdef01234567');
    expect(isCalloutCapableId(marked)).toBe(true);
    expect(isCalloutCapableId('0123456789abcdef0123456789abcdef')).toBe(false);
    const v = (id: string, parents: string[] = []): VaultVersion => ({ id, parents, path: 'a.md', pathAt: 1, deleted: false, hash: 'a'.repeat(64), size: 1, text: true, at: 1, device: 'd', label: 'D', p2p: false });
    const a = markCalloutCapableId('a'.repeat(32));
    const b = markCalloutCapableId('b'.repeat(32));
    const old = 'c'.repeat(32);
    const nodes = { [a]: v(a), [b]: v(b), [old]: v(old), m1: v('d'.repeat(32), [a, b]), m2: v('e'.repeat(32), [a, old]) };
    nodes[nodes.m1.id] = nodes.m1;
    nodes[nodes.m2.id] = nodes.m2;
    expect(supportsConflictCallouts(nodes, nodes.m1.id)).toBe(true);
    expect(supportsConflictCallouts(nodes, nodes.m2.id)).toBe(false);
    expect(supportsConflictCallouts(nodes, 'f'.repeat(32))).toBe(false); // 不認得的版本：保守
  });

  it('預設（conflictCallouts 沒開）：版本不帶標記，行為與 v0.35 相同（同行衝突 → 衝突副本）', async () => {
    const { net, devices: list } = await devices(['a', 'b'], { a: {}, b: {} });
    await concurrentEdit(net, list, 'n.md', 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    for (const d of list) for (const { versionId } of d.sync.index()) expect(isCalloutCapableId(versionId)).toBe(false);
    expect(Object.keys(list[0]!.vault.tree()).sort()).toHaveLength(2);
    expect(conflictsOf(list).every((c) => c.copyPath !== undefined && c.callouts === undefined)).toBe(true);
  });
});

describe('兩台都支援：Markdown 同行衝突 → 就地 callout', () => {
  it('兩台得到位元組相同的檔案、同一個 callout id；沒有衝突副本；衝突事件帶 callouts', async () => {
    const { net, devices: list } = await devices(['a', 'b']);
    await concurrentEdit(net, list, 'n.md', 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const [ta, tb] = list.map((d) => d.vault.tree());
    expect(ta).toEqual(tb);
    expect(Object.keys(ta!)).toEqual(['n.md']);
    const [callout] = parseConflictCallouts(ta!['n.md']!);
    expect(callout!.versions.map((v) => [v.label, v.lines])).toEqual([
      ['A', ['line-a']],
      ['B', ['line-b']],
    ]);
    const events = conflictsOf(list);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ kind: 'text', path: 'n.md', callouts: [callout!.id] });
    expect(events.every((e) => e.copyPath === undefined)).toBe(true);
  });

  it('解決後寫回＝新的本機版本，正常同步到另一台', async () => {
    const { net, devices: list } = await devices(['a', 'b']);
    const [a, b] = list as [Device, Device];
    await concurrentEdit(net, list, 'n.md', 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const text = a.vault.get('n.md')!;
    const [c] = parseConflictCallouts(text);
    await a.edit('n.md', resolveConflictCallout(text, c!.id, 'both-by-time'));
    await net.settle();
    expect(b.vault.get('n.md')).toBe('x\nline-a\nline-b\ny');
  });

  it('非 Markdown（.txt）照舊衝突副本', async () => {
    const { net, devices: list } = await devices(['a', 'b']);
    await concurrentEdit(net, list, 'n.txt', 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const tree = list[0]!.vault.tree();
    expect(Object.keys(tree)).toHaveLength(2);
    expect(Object.values(tree).some((t) => t.includes('[!conflict]'))).toBe(false);
  });

  it('特殊內容（衝突在程式碼圍欄裡）退回衝突副本，內容完整', async () => {
    const { net, devices: list } = await devices(['a', 'b']);
    await concurrentEdit(net, list, 'c.md', '```\ncode\n```', ['```\ncode-a\n```', '```\ncode-b\n```']);
    const tree = list[0]!.vault.tree();
    expect(list[1]!.vault.tree()).toEqual(tree);
    expect(Object.keys(tree)).toHaveLength(2);
    const all = Object.values(tree).join('\n');
    expect(all).toContain('code-a');
    expect(all).toContain('code-b');
  });
});

describe('模式選擇：任何一個版本頭來自不支援的寫入端 → 衝突副本', () => {
  it('a 支援、b 沒開 → 兩台都產生衝突副本（同一個結果）', async () => {
    const { net, devices: list } = await devices(['a', 'b'], { a: ON, b: {} });
    await concurrentEdit(net, list, 'n.md', 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const [ta, tb] = list.map((d) => d.vault.tree());
    expect(ta).toEqual(tb);
    expect(Object.keys(ta!)).toHaveLength(2);
    expect(Object.values(ta!).some((t) => t.includes('[!conflict]'))).toBe(false);
  });
});

describe('確定性：多台裝置、不同到達順序', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`三台同時改同一行（seed ${seed}）：三台位元組相同、只有一個 callout、三個版本都在、依時間排序`, async () => {
      const { net, devices: list } = await devices(['a', 'b', 'c'], {}, seed);
      await concurrentEdit(net, list, 'n.md', 'top\nline\nbottom', ['top\nline-a\nbottom', 'top\nline-b\nbottom', 'top\nline-c\nbottom']);
      const trees = list.map((d) => d.vault.tree());
      expect(trees[1]).toEqual(trees[0]);
      expect(trees[2]).toEqual(trees[0]);
      expect(Object.keys(trees[0]!)).toEqual(['n.md']);
      const callouts = parseConflictCallouts(trees[0]!['n.md']!);
      expect(callouts).toHaveLength(1);
      expect(callouts[0]!.versions.map((v) => v.lines[0])).toEqual(['line-a', 'line-b', 'line-c']);
      expect(trees[0]!['n.md']).not.toContain('> >');
    });
  }
});

describe('已存在的 callout 再次遇到衝突', () => {
  it('兩台各自解決得不一樣 → 收斂成一個新的 callout（兩個解決結果），不巢狀', async () => {
    const { net, devices: list } = await devices(['a', 'b']);
    const [a, b] = list as [Device, Device];
    await concurrentEdit(net, list, 'n.md', 'x\nline\ny', ['x\nline-a\ny', 'x\nline-b\ny']);
    const text = a.vault.get('n.md')!;
    const [c] = parseConflictCallouts(text);
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('n.md', resolveConflictCallout(text, c!.id, 0));
    await net.clock.advance(1000);
    await b.edit('n.md', resolveConflictCallout(text, c!.id, 1));
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual(b.vault.tree());
    const after = parseConflictCallouts(a.vault.get('n.md')!);
    expect(after).toHaveLength(1);
    expect(after[0]!.versions.map((v) => v.lines)).toEqual([['line-a'], ['line-b']]);
    expect(a.vault.get('n.md')).not.toContain('> >');
  });

  it('callout 還在時第三台改了同一行 → 版本併入同一個 callout', async () => {
    const { net, devices: list } = await devices(['a', 'b', 'c']);
    const [a, b, c] = list as [Device, Device, Device];
    await a.edit('n.md', 'x\nline\ny');
    await net.settle();
    for (const d of list) d.transport.setOnline(false);
    await a.edit('n.md', 'x\nline-a\ny');
    await net.clock.advance(1000);
    await b.edit('n.md', 'x\nline-b\ny');
    await net.clock.advance(1000);
    await c.edit('n.md', 'x\nline-c\ny');
    // a、b 先合併出 callout；c 之後才上線
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(parseConflictCallouts(a.vault.get('n.md')!)[0]!.versions).toHaveLength(2);
    c.transport.setOnline(true);
    await net.settle();
    const trees = list.map((d) => d.vault.tree());
    expect(trees[1]).toEqual(trees[0]);
    expect(trees[2]).toEqual(trees[0]);
    const after = parseConflictCallouts(trees[0]!['n.md']!);
    expect(after).toHaveLength(1);
    expect(after[0]!.versions.map((v) => v.lines[0])).toEqual(['line-a', 'line-b', 'line-c']);
  });
});
