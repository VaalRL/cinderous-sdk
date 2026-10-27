// Markdown 合併規則與協調器（SDK ADR 0059）：同一天兩邊各自建立同路徑的 Markdown → 以空檔為共同祖先三方合併成一個檔案
// （裁示 5，取代「較晚的改名成衝突副本」）；勾選框衝突自動合併（裁示 7）。模式由版本資料（id 的標記）決定，所有裝置同一個結果；
// 有一台沒開就照舊。
import { describe, expect, it } from 'vitest';

import {
  isCalloutCapableId,
  isMergeRulesId,
  markCalloutCapableId,
  markMergeRulesId,
  parseConflictCallouts,
  supportsMergeRules,
  type VaultSyncOptions,
  type VaultVersion,
} from '../../../src/sync/vault/index.js';
import { type Device, Net } from './harness.js';

const ON: Partial<VaultSyncOptions> = { mergeRules: true };
const ON_CALLOUTS: Partial<VaultSyncOptions> = { mergeRules: true, conflictCallouts: true };
const DAY = 'Daily/2026-10-05.md';
const lines = (...xs: string[]) => xs.join('\n');

async function devices(options: Array<Partial<VaultSyncOptions>>, seed = 1, echoMs?: number, maxDelayMs = 50) {
  const net = new Net({ seed, maxDelayMs, ...(echoMs !== undefined ? { echoMs } : {}) });
  const list: Device[] = [];
  for (const [i, o] of options.entries()) list.push(await net.add(`d${i}`, { options: o }));
  return { net, list };
}

/** 全部離線、各自建立同一個路徑（內容不同），再一起上線 */
async function createOffline(net: Net, list: Device[], path: string, contents: string[]) {
  for (const d of list) d.transport.setOnline(false);
  for (const [i, d] of list.entries()) {
    await d.edit(path, contents[i]!);
    await net.clock.advance(1000);
  }
  for (const d of list) d.transport.setOnline(true);
  await net.settle();
}

function healthy(list: Device[]) {
  for (const d of list) {
    expect(d.errors, d.name).toEqual([]);
    const s = d.sync.status();
    expect([s.waiting, s.pending.length, s.queue], d.name).toEqual([0, 0, 0]);
  }
}

describe('版本 id 的標記', () => {
  it('合併規則的標記與 callout 的標記在不同位置、可以同時帶；合併版本＝父版本都支援', () => {
    const raw = '0123456789abcdef0123456789abcdef';
    const rules = markMergeRulesId(raw);
    expect(rules.slice(0, 16)).toBe(raw.slice(0, 16));
    expect(rules.slice(24)).toBe(raw.slice(24));
    expect([isMergeRulesId(rules), isMergeRulesId(raw), isCalloutCapableId(rules)]).toEqual([true, false, false]);
    const both = markCalloutCapableId(markMergeRulesId(raw));
    expect([isMergeRulesId(both), isCalloutCapableId(both)]).toEqual([true, true]);
    const v = (id: string, parents: string[] = []): VaultVersion => ({ id, parents, path: 'a.md', pathAt: 1, deleted: false, hash: 'a'.repeat(64), size: 1, text: true, at: 1, device: 'd', label: 'D', p2p: false });
    const a = markMergeRulesId('a'.repeat(32));
    const b = markMergeRulesId('b'.repeat(32));
    const old = 'c'.repeat(32);
    const m1 = v('d'.repeat(32), [a, b]);
    const m2 = v('e'.repeat(32), [a, old]);
    const nodes = { [a]: v(a), [b]: v(b), [old]: v(old), [m1.id]: m1, [m2.id]: m2 };
    expect([supportsMergeRules(nodes, m1.id), supportsMergeRules(nodes, m2.id), supportsMergeRules(nodes, 'f'.repeat(32))]).toEqual([true, false, false]);
  });

  it('預設（mergeRules 沒開）：版本不帶標記', async () => {
    const { list } = await devices([{}]);
    await list[0]!.edit('x.md', 'x');
    expect(isMergeRulesId(list[0]!.sync.index()[0]!.versionId)).toBe(false);
    expect(list[0]!.sync.mergeRules).toBe(false);
    list[0]!.sync.setMergeRules(true);
    await list[0]!.edit('y.md', 'y');
    expect(isMergeRulesId(list[0]!.sync.index().find((e) => e.path === 'y.md')!.versionId)).toBe(true);
  });
});

describe('同一天兩邊各自建立同路徑的 Markdown（裁示 5）', () => {
  const phone = lines('# 2026-10-05', '', '## 待辦', '- [ ] 繳電費', '', '## 紀錄', '');
  const desk = lines('# 2026-10-05', '', '## 待辦', '', '## 紀錄', '- 09:00 開會', '');

  it('以空檔為共同祖先三方合併成一個檔案：兩邊的內容都在、範本只出現一次、沒有衝突副本；兩台位元組相同', async () => {
    const { net, list } = await devices([ON, ON]);
    await createOffline(net, list, DAY, [phone, desk]);
    const [a, b] = list.map((d) => d.vault.tree());
    expect(a).toEqual(b);
    expect(a).toEqual({ [DAY]: lines('# 2026-10-05', '', '## 待辦', '- [ ] 繳電費', '', '## 紀錄', '- 09:00 開會', '') });
    expect(list.flatMap((d) => d.sync.status().conflicts)).toEqual([]);
    // 兩個檔案收成一個：只剩一個沒刪除的
    expect(list[0]!.sync.remoteIndex().filter((e) => !e.deleted)).toHaveLength(1);
    healthy(list);
  });

  it('磁碟上那一份直接交給留下的檔案：不先刪再寫（開著的筆記不會消失一下）——自己做合併、或別台的版本依序到達時', async () => {
    for (let seed = 1; seed <= 5; seed += 1) {
      const { net, list } = await devices([ON, ON], seed, undefined, 0);
      await createOffline(net, list, DAY, [phone, desk]);
      for (const d of list) expect(d.vault.log.filter((l) => l.startsWith('remove ')), `seed ${seed} ${d.name}`).toEqual([]);
      expect(list[0]!.vault.tree()).toEqual(list[1]!.vault.tree());
    }
  });

  it('同一處兩邊各自新增不同的行：開了 callout → 只有那幾行放進 callout；沒開 → 衝突副本（較晚的留在主檔）', async () => {
    const x = lines('# 日記', '早上喝咖啡');
    const y = lines('# 日記', '早上跑步');
    {
      const { net, list } = await devices([ON_CALLOUTS, ON_CALLOUTS]);
      await createOffline(net, list, DAY, [x, y]);
      const tree = list[0]!.vault.tree();
      expect(tree).toEqual(list[1]!.vault.tree());
      expect(Object.keys(tree)).toEqual([DAY]);
      const [callout] = parseConflictCallouts(tree[DAY]!);
      expect(callout!.versions.map((v) => [v.label, v.lines])).toEqual([
        ['D0', ['早上喝咖啡']],
        ['D1', ['早上跑步']],
      ]);
      expect(tree[DAY]!.startsWith('# 日記\n> [!conflict]')).toBe(true);
      healthy(list);
    }
    {
      const { net, list } = await devices([ON, ON]);
      await createOffline(net, list, DAY, [x, y]);
      const tree = list[0]!.vault.tree();
      expect(tree).toEqual(list[1]!.vault.tree());
      expect(Object.keys(tree).sort()).toHaveLength(2);
      expect(tree[DAY]).toBe(y);
      expect(Object.values(tree)).toContain(x);
      healthy(list);
    }
  });

  it('有一台沒開：照舊（較晚的改名成衝突副本）', async () => {
    const { net, list } = await devices([ON, {}]);
    await createOffline(net, list, DAY, [phone, desk]);
    const tree = list[0]!.vault.tree();
    expect(tree).toEqual(list[1]!.vault.tree());
    expect(Object.keys(tree)).toHaveLength(2);
    expect(list.flatMap((d) => d.sync.status().conflicts).map((c) => c.kind)).toContain('path-collision');
    healthy(list);
  });

  it('三台各自建立 × 5 個種子（到達順序不同）：位元組相同、三邊的內容都在（收的順序不同時可能多出衝突副本，見 ADR 0059 已知限制）', async () => {
    let single = 0;
    for (let seed = 1; seed <= 5; seed += 1) {
      const { net, list } = await devices([ON_CALLOUTS, ON_CALLOUTS, ON_CALLOUTS], seed);
      await createOffline(net, list, DAY, [lines('# 今天', 'A 寫的'), lines('# 今天', 'B 寫的'), lines('# 今天', '- [ ] C 的待辦')]);
      const trees = list.map((d) => d.vault.tree());
      expect(trees[1], `seed ${seed}`).toEqual(trees[0]);
      expect(trees[2], `seed ${seed}`).toEqual(trees[0]);
      const all = Object.values(trees[0]!).join('\n');
      for (const token of ['A 寫的', 'B 寫的', 'C 的待辦']) expect(all, `seed ${seed}`).toContain(token);
      expect(Object.keys(trees[0]!), `seed ${seed}`).toContain(DAY);
      if (Object.keys(trees[0]!).length === 1) single += 1;
      healthy(list);
    }
    expect(single).toBeGreaterThan(0);
  });

  it('非文字檔（二進位）照舊衝突副本；內容相同照舊直接收斂（ADR 0035 §G10）', async () => {
    const { net, list } = await devices([ON, ON]);
    for (const d of list) d.transport.setOnline(false);
    list[0]!.vault.userWrite('img.bin', new Uint8Array([0xff, 1]));
    await list[0]!.sync.notifyLocalChange('img.bin', 'create');
    list[1]!.vault.userWrite('img.bin', new Uint8Array([0xff, 2]));
    await list[1]!.sync.notifyLocalChange('img.bin', 'create');
    await list[0]!.edit('same.md', '一樣');
    await list[1]!.edit('same.md', '一樣');
    for (const d of list) d.transport.setOnline(true);
    await net.settle();
    const tree = list[0]!.vault.tree();
    expect(tree).toEqual(list[1]!.vault.tree());
    expect(Object.keys(tree).filter((p) => p.endsWith('.bin'))).toHaveLength(2);
    expect(Object.keys(tree).filter((p) => p.endsWith('.md'))).toEqual(['same.md']);
    healthy(list);
  });

  it('有回音（像 Obsidian＋CinderSync 的監聽）：不來回震盪，每台對原路徑最多寫兩次', async () => {
    const { net, list } = await devices([ON_CALLOUTS, ON_CALLOUTS], 3, 500);
    await createOffline(net, list, DAY, [phone, desk]);
    await net.clock.advance(5000);
    await net.settle();
    expect(list[0]!.vault.tree()).toEqual(list[1]!.vault.tree());
    for (const d of list) expect(d.vault.log.filter((l) => l === `write ${DAY}`).length, d.name).toBeLessThanOrEqual(2);
    healthy(list);
  });
});

describe('勾選框衝突自動合併（裁示 7）', () => {
  async function concurrent(options: Partial<VaultSyncOptions>, base: string, edits: [string, string]) {
    const { net, list } = await devices([options, options]);
    await list[0]!.edit('t.md', base);
    await net.settle();
    for (const d of list) d.transport.setOnline(false);
    await list[0]!.edit('t.md', edits[0]);
    await net.clock.advance(1000);
    await list[1]!.edit('t.md', edits[1]);
    for (const d of list) d.transport.setOnline(true);
    await net.settle();
    expect(list[0]!.vault.tree()).toEqual(list[1]!.vault.tree());
    healthy(list);
    return list[0]!.vault.tree();
  }

  it('兩台勾了相鄰的不同項目 → 都勾；同一項一台勾了（Tasks 附日期）一台沒勾 → 已勾的贏', async () => {
    const base = lines('# 待辦', '- [ ] a', '- [ ] b', '');
    expect(await concurrent(ON, base, [lines('# 待辦', '- [x] a ✅ 2026-10-05', '- [ ] b', ''), lines('# 待辦', '- [ ] a', '- [x] b', '')])).toEqual({
      't.md': lines('# 待辦', '- [x] a ✅ 2026-10-05', '- [x] b', ''),
    });
    expect(await concurrent(ON, base, [lines('# 待辦', '- [x] a', '- [ ] b', ''), lines('# 待辦', '- [x] a ✅ 2026-10-05', '- [ ] b', '')])).toEqual({
      't.md': lines('# 待辦', '- [x] a ✅ 2026-10-05', '- [ ] b', ''),
    });
  });

  it('沒開合併規則：照舊衝突副本；勾選以外的差異：照舊', async () => {
    const base = lines('- [ ] a', '- [ ] b');
    const off = await concurrent({}, base, [lines('- [x] a', '- [ ] b'), lines('- [ ] a', '- [x] b')]);
    expect(Object.keys(off)).toHaveLength(2);
    const text = await concurrent(ON, base, [lines('- [x] a', '- [ ] b'), lines('- [ ] a 改了字', '- [x] b')]);
    expect(Object.keys(text)).toHaveLength(2);
  });
});
