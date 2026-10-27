// 版本歷史只在 client 端（SDK ADR 0063）：本機歸檔（和版本圖分開）、列出／讀取／還原、最近刪除的檔案、
// 整個 Vault 回到時間點；中繼與線上格式不變。
import { describe, expect, it } from 'vitest';

import {
  compilePathFilter,
  isVaultHistoryError,
  isVaultScopeError,
  type VaultContentScope,
  type VaultSyncOptions,
} from '../../../src/sync/vault/index.js';
import { type Device, MemoryVault, Net, str, text } from './harness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function pair(options: Partial<VaultSyncOptions> = {}, b: Partial<VaultSyncOptions> = {}) {
  const net = new Net({ maxDelayMs: 30 });
  const a = await net.add('a', { options });
  const bb = await net.add('b', { options: { ...options, ...b } });
  return { net, a, b: bb };
}

function healthy(...devices: Device[]) {
  for (const d of devices) {
    expect(d.errors, d.name).toEqual([]);
    const s = d.sync.status();
    expect(s.pending, `${d.name} pending`).toEqual([]);
    expect(s.queue, `${d.name} queue`).toBe(0);
  }
}

async function readText(d: Device, versionId: string): Promise<string | null> {
  const bytes = await d.sync.readHistory(versionId);
  return bytes ? str(bytes) : null;
}

describe('歸檔：和版本圖分開', () => {
  it('本機與收到的版本都歸檔（含內容）；版本圖修剪後歸檔照樣在', async () => {
    const { net, a, b } = await pair({ maxVersionsPerFile: 8 });
    for (let i = 0; i < 30; i += 1) {
      await a.edit('n.md', `第 ${i} 版`);
      await net.settle();
      await net.clock.advance(1000);
    }
    for (const d of [a, b]) {
      const h = await d.sync.history('n.md');
      expect(h, d.name).toHaveLength(30);
      // 新到舊
      expect(h[0]!.at).toBeGreaterThan(h[29]!.at);
      expect(h.every((e) => e.content && e.restorable && e.text && !e.deleted && e.device === 'a' && e.label === 'A')).toBe(true);
      expect(await readText(d, h[29]!.versionId)).toBe('第 0 版');
      expect(await readText(d, h[0]!.versionId)).toBe('第 29 版');
      // 版本圖已經修剪：最早的版本不在了
      expect(await d.sync.readVersionContent(h[29]!.fileId, h[29]!.versionId)).toBeNull();
    }
    // 內容以雜湊去重，存在 hc:
    expect((await a.store.keys('hc:')).length).toBe(30);
    expect(a.sync.historyStatus()).toMatchObject({ enabled: true, files: 1, versions: 30 });
    healthy(a, b);
  });

  it('依 fileId 也查得到；改名後同一份歷史（含舊路徑）；舊路徑查不到現在的檔案以外的東西', async () => {
    const { net, a, b } = await pair();
    await a.edit('old.md', '一');
    await net.settle();
    await a.rename('old.md', 'dir/new.md');
    await a.edit('dir/new.md', '二');
    await net.settle();
    const h = await b.sync.history('dir/new.md');
    expect(h.map((e) => [e.path, e.content])).toEqual([
      ['dir/new.md', true],
      ['dir/new.md', true],
      ['old.md', true],
    ]);
    expect(await b.sync.history({ fileId: h[0]!.fileId })).toEqual(h);
    expect(await b.sync.history(h[0]!.fileId)).toEqual(h);
    expect(await b.sync.history('DIR/NEW.md')).toEqual(h); // 比對方式同 pathKey（預設不分大小寫）
    expect(await b.sync.history('old.md')).toEqual(h); // 曾經在這個路徑的檔案
    expect(await b.sync.history('nope.md')).toEqual([]);
    healthy(a, b);
  });

  it('排除範圍裡的路徑不歸檔（ADR 0047）', async () => {
    const { net, a } = await pair({ excludes: compilePathFilter(['private/']) });
    await a.edit('private/x.md', 'secret');
    await a.edit('ok.md', 'ok');
    await net.settle();
    expect(await a.sync.history('private/x.md')).toEqual([]);
    expect(await a.sync.history('ok.md')).toHaveLength(1);
  });

  it('二進位檔只記版本資訊、不存內容（裁示 2）；內容和現在相同才算可還原', async () => {
    const { net, a, b } = await pair();
    await a.edit('img.png', new Uint8Array([0x89, 0x50, 1]));
    await a.edit('img.png', new Uint8Array([0x89, 0x50, 2]));
    await net.settle();
    for (const d of [a, b]) {
      const h = await d.sync.history('img.png');
      expect(h.map((e) => [e.text, e.content, e.restorable, e.size])).toEqual([
        [false, false, true, 3],
        [false, false, false, 3],
      ]);
      expect(await d.store.keys('hc:')).toEqual([]);
      expect(await d.sync.readHistory(h[1]!.versionId)).toBeNull();
      expect([...(await d.sync.readHistory(h[0]!.versionId))!]).toEqual([0x89, 0x50, 2]);
      await expect(d.sync.restore('img.png', h[1]!.versionId)).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'binary');
      expect(await d.sync.restore('img.png', h[0]!.versionId)).toMatchObject({ outcome: 'unchanged' });
    }
    healthy(a, b);
  });

  it('既有的狀態儲存（升級前）：啟動時從版本圖還留著的版本與內容補進歸檔', async () => {
    const net = new Net({ maxDelayMs: 30 });
    const a = await net.add('a', { options: { history: { enabled: false } } });
    for (let i = 0; i < 12; i += 1) {
      await a.edit('n.md', `v${i}`);
      await net.clock.advance(1000);
    }
    await a.edit('img.png', new Uint8Array([1, 2, 3]));
    await net.settle();
    expect(await a.sync.history('n.md')).toEqual([]);
    expect(await a.store.keys('ha:')).toEqual([]);
    // 升級：同一份狀態儲存，打開歷史
    await a.sync.stop();
    const { VaultSyncCoordinator } = await import('../../../src/sync/vault/index.js');
    a.sync = new VaultSyncCoordinator({ adapter: a.vault, store: a.store, transport: a.transport, deviceId: 'a', deviceLabel: 'A', clock: net.clock, tickMs: 0 });
    await a.sync.start();
    const h = await a.sync.history('n.md');
    // 離線累積：還沒送出的本機版本被下一次取代，所以版本圖裡只有送出過的那些
    expect(h.length).toBeGreaterThan(0);
    expect(h[0]!.content).toBe(true);
    expect(await readText(a, h[0]!.versionId)).toBe('v11');
    expect((await a.sync.history('img.png')).map((e) => [e.text, e.content])).toEqual([[false, false]]);
    // 再重開不會重複補
    const keys = (await a.store.keys('ha:')).length;
    await a.restart();
    expect(await a.sync.history('n.md')).toEqual(h);
    expect((await a.store.keys('ha:')).length).toBe(keys);
  });
});

describe('🔴 被收進另一個檔案的刪除版本（SDK ADR 0079）', () => {
  it('新裝置帶著同內容的檔案加入（G10 收斂）：歷史裡那個刪除版本標 absorbed，不當成使用者刪除；最近刪除不列', async () => {
    const net = new Net();
    const a = await net.add('a');
    await a.edit('same.md', '一樣的內容');
    await net.settle();
    const vault = new MemoryVault();
    vault.userWrite('same.md', '一樣的內容');
    await net.clock.advance(1000);
    const c = await net.add('c', { vault });
    await net.settle();
    for (const d of [a, c]) {
      const h = await d.sync.history('same.md');
      const deleted = h.filter((e) => e.deleted);
      expect(deleted.length).toBeGreaterThan(0);
      expect(deleted.every((e) => e.absorbed === true)).toBe(true);
      expect(h.filter((e) => !e.deleted).every((e) => e.absorbed === undefined)).toBe(true);
      expect(d.sync.deletedFiles()).toEqual([]);
    }
  });

  it('使用者真的刪掉：不帶 absorbed', async () => {
    const net = new Net();
    const a = await net.add('a');
    await a.edit('gone.md', '要刪');
    await net.settle();
    await a.remove('gone.md');
    await net.settle();
    const h = await a.sync.history('gone.md');
    expect(h.find((e) => e.deleted)?.absorbed).toBeUndefined();
  });
});

describe('還原單一檔案', () => {
  it('把舊內容當成新的本機修改寫回（以目前版本頭為父），照常同步；不改寫歷史', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', '第一版');
    await net.settle();
    await a.edit('n.md', '第二版');
    await net.settle();
    const [v2, v1] = await a.sync.history('n.md');
    const result = await a.sync.restore('n.md', v1!.versionId);
    expect(result).toMatchObject({ path: 'n.md', fileId: v1!.fileId, outcome: 'restored' });
    expect(result.versionId).not.toBe(v1!.versionId);
    await net.settle();
    expect(a.vault.get('n.md')).toBe('第一版');
    expect(b.vault.get('n.md')).toBe('第一版');
    // 歷史多一版（新版本），舊的都還在
    const h = await b.sync.history('n.md');
    expect(h.map((e) => e.versionId)).toEqual([result.versionId, v2!.versionId, v1!.versionId]);
    expect(b.sync.index()[0]!.versionId).toBe(result.versionId);
    // 內容本來就相同：不產生版本
    expect(await a.sync.restore('n.md', v1!.versionId)).toMatchObject({ outcome: 'unchanged', versionId: result.versionId });
    expect(a.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });

  it('寫回前先把磁碟上還沒通知的修改收成版本（不遺失）', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', '一');
    await a.edit('n.md', '二');
    await net.settle();
    const old = (await a.sync.history('n.md')).at(-1)!;
    a.vault.userWrite('n.md', '使用者剛打的字'); // 還沒通知
    await a.sync.restore('n.md', old.versionId);
    await net.settle();
    expect(b.vault.get('n.md')).toBe('一');
    const typed = (await a.sync.history('n.md')).find((e) => e.hash !== old.hash && e.content);
    expect(await Promise.all((await a.sync.history('n.md')).map((e) => readText(a, e.versionId)))).toContain('使用者剛打的字');
    expect(typed).toBeDefined();
    healthy(a, b);
  });

  it('還原到另一個檔案佔著的路徑：寫成那個檔案的新版本；未知版本與刪除版本丟 VaultHistoryError', async () => {
    const { net, a, b } = await pair();
    await a.edit('x.md', 'x 的內容');
    await a.edit('y.md', 'y 的內容');
    await net.settle();
    const x = (await a.sync.history('x.md'))[0]!;
    await a.sync.restore('y.md', x.versionId);
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'x.md': 'x 的內容', 'y.md': 'x 的內容' });
    await expect(a.sync.restore('y.md', 'f'.repeat(32))).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'unknown');
    await a.remove('x.md');
    await net.settle();
    const del = (await a.sync.history('x.md'))[0]!;
    expect(del.deleted).toBe(true);
    await expect(a.sync.restore('x.md', del.versionId)).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'deleted');
    healthy(a, b);
  });

  it('最近刪除的檔案：列出、還原（同一個檔案身分）；刪除超過保留天數就清掉', async () => {
    const { net, a, b } = await pair();
    await a.edit('d/gone.md', '要刪的');
    await a.edit('keep.md', 'k');
    await net.settle();
    const before = net.clock.now();
    await b.remove('d/gone.md');
    await net.settle();
    const [del] = a.sync.deletedFiles();
    expect(del).toMatchObject({ path: 'd/gone.md', device: 'b', label: 'B' });
    expect(del!.lastVersion).toMatchObject({ path: 'd/gone.md', content: true, restorable: true });
    expect(a.sync.deletedFiles({ since: net.clock.now() + 1 })).toEqual([]);
    expect(a.sync.deletedFiles({ since: before })).toHaveLength(1);
    const result = await a.sync.restore(del!.path, del!.lastVersion!.versionId);
    expect(result.fileId).toBe(del!.fileId);
    await net.settle();
    expect(b.vault.get('d/gone.md')).toBe('要刪的');
    expect(a.sync.deletedFiles()).toEqual([]);
    expect(b.sync.deletedFiles()).toEqual([]);
    // 再刪一次，等墓碑過了保留期被清掉（版本圖裡沒有這個檔案了）
    await a.remove('d/gone.md');
    await net.settle();
    await net.clock.advance(31 * DAY);
    await a.sync.tick();
    await b.sync.tick();
    await net.settle();
    expect(a.sync.tombstones()).toEqual([]);
    // 保留天數 30：刪除超過 30 天的檔案整個從歸檔清掉（墓碑清了還原得回來另見下一個測試，保留天數設長）
    expect(a.sync.deletedFiles()).toEqual([]);
    expect(await a.sync.history('d/gone.md')).toEqual([]);
    healthy(a, b);
  });

  it('墓碑清掉之後（版本圖不認得）也還原得回來：當成新檔', async () => {
    const { net, a, b } = await pair({ history: { keepDays: 365 } });
    await a.edit('gone.md', '舊內容');
    await net.settle();
    await a.remove('gone.md');
    await net.settle();
    await net.clock.advance(31 * DAY);
    await a.sync.tick();
    await b.sync.tick();
    await net.settle();
    expect(a.sync.tombstones()).toEqual([]);
    const [del] = a.sync.deletedFiles();
    expect(del!.lastVersion?.restorable).toBe(true);
    const result = await a.sync.restore('gone.md', del!.lastVersion!.versionId);
    expect(result.outcome).toBe('restored');
    await net.settle();
    expect(b.vault.get('gone.md')).toBe('舊內容');
    healthy(a, b);
  });
});

describe('整個 Vault 回到時間點 T（裁示 6）', () => {
  async function scenario() {
    const { net, a, b } = await pair();
    await a.edit('keep.md', '不變');
    await a.edit('edit.md', '原本');
    await a.edit('ren.md', '會被改名');
    await a.edit('del.md', '會被刪');
    await a.edit('img.png', new Uint8Array([1, 2, 3]));
    await net.settle();
    await net.clock.advance(MIN);
    const T = net.clock.now();
    await net.clock.advance(MIN);
    await b.edit('edit.md', '改過了');
    await b.rename('ren.md', 'moved/ren2.md');
    await b.remove('del.md');
    await b.edit('new.md', 'T 之後才建立');
    await b.edit('img.png', new Uint8Array([9, 9]));
    await b.rename('keep.md', 'tmp.md');
    await b.rename('tmp.md', 'keep.md'); // 改了又改回：T 時的路徑一樣
    await net.settle();
    return { net, a, b, T };
  }

  it('vaultAt：每個檔案取 at ≤ T 的最後一版，路徑是 T 時的路徑；二進位檔只在內容與現在相同時可還原', async () => {
    const { a, T, net, b } = await scenario();
    const at = (await a.sync.vaultAt(T)).files;
    expect(at.map((e) => [e.path, e.restorable])).toEqual([
      ['del.md', true],
      ['edit.md', true],
      ['img.png', false],
      ['keep.md', true],
      ['ren.md', true],
    ]);
    expect(at.every((e) => e.at <= T)).toBe(true);
    expect((await a.sync.vaultAt(net.clock.now())).files.map((e) => e.path)).toEqual(['edit.md', 'img.png', 'keep.md', 'moved/ren2.md', 'new.md']);
    expect((await a.sync.vaultAt(0)).files).toEqual([]);
    healthy(a, b);
  });

  it('planRestoreVault 只預覽（不動磁碟）；restoreVault 逐檔執行、照常同步；二進位檔跳過並回報', async () => {
    const { a, b, net, T } = await scenario();
    const before = a.vault.tree();
    const plan = await a.sync.planRestoreVault(T);
    expect(a.vault.tree()).toEqual(before);
    expect(plan.revert.map((i) => [i.from, i.path])).toEqual([
      ['edit.md', 'edit.md'],
      ['moved/ren2.md', 'ren.md'],
    ]);
    expect(plan.undelete.map((i) => i.path)).toEqual(['del.md']);
    expect(plan.remove).toEqual([]);
    expect(plan.unrestorable.map((i) => [i.path, i.reason])).toEqual([['img.png', 'binary']]);
    const report = await a.sync.restoreVault(plan);
    expect(report.restored.map((i) => i.path)).toEqual(['del.md', 'edit.md', 'ren.md']);
    expect(report.removed).toEqual([]);
    expect(report.skipped.map((i) => [i.path, i.reason])).toEqual([['img.png', 'binary']]);
    await net.settle();
    const expected = { 'del.md': '會被刪', 'edit.md': '原本', 'img.png': '\t\t', 'keep.md': '不變', 'new.md': 'T 之後才建立', 'ren.md': '會被改名' };
    expect(a.vault.tree()).toEqual(expected);
    expect(b.vault.tree()).toEqual(expected);
    // 改名是改回去（同一個檔案），刪除的復原是同一個檔案
    expect((await b.sync.history('ren.md')).map((e) => e.path)).toContain('moved/ren2.md');
    expect(a.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });

  it('removeCreatedAfter：T 之後才建立的刪掉（內容在歸檔裡，之後找得回來）；只限部分路徑', async () => {
    const { a, b, net, T } = await scenario();
    const partial = await a.sync.planRestoreVault(T, { paths: ['moved/', 'ren.md'], removeCreatedAfter: true });
    expect([...partial.revert, ...partial.undelete, ...partial.remove].map((i) => i.fileId)).toEqual([a.sync.lookup('moved/ren2.md')!.fileId]);
    const plan = await a.sync.planRestoreVault(T, { removeCreatedAfter: true });
    expect(plan.remove.map((i) => i.path)).toEqual(['new.md']);
    const report = await a.sync.restoreVault(plan);
    expect(report.removed.map((i) => i.path)).toEqual(['new.md']);
    await net.settle();
    expect(b.vault.files.has('new.md')).toBe(false);
    const [gone] = b.sync.deletedFiles();
    expect(gone!.path).toBe('new.md');
    expect(await readText(b, gone!.lastVersion!.versionId)).toBe('T 之後才建立');
    healthy(a, b);
  });

  it('還原本身可以再還原：回到還原之前的時間點（removeCreatedAfter）', async () => {
    const { a, b, net, T } = await scenario();
    const before = a.vault.tree();
    await net.clock.advance(MIN);
    const justBefore = net.clock.now();
    await net.clock.advance(MIN);
    await a.sync.restoreVault(await a.sync.planRestoreVault(T, { removeCreatedAfter: true }));
    await net.settle();
    expect(b.vault.tree()).not.toEqual(before);
    await net.clock.advance(MIN);
    const undo = await b.sync.planRestoreVault(justBefore, { removeCreatedAfter: true });
    const report = await b.sync.restoreVault(undo);
    expect(report.skipped).toEqual([]);
    await net.settle();
    expect(a.vault.tree()).toEqual(before);
    expect(b.vault.tree()).toEqual(before);
    healthy(a, b);
  });

  it('改名成環（互換名字）：先改到空著的路徑再搬回（照順序收到的裝置不會路徑相撞）', async () => {
    // 投遞照順序：收到的順序顛倒時，和使用者自己連續改名一樣可能產生路徑相撞的副本（既有行為，不遺失；性質測試涵蓋）
    const net = new Net({ maxDelayMs: 0 });
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', 'X');
    await a.edit('y.md', 'Y');
    await net.settle();
    await net.clock.advance(MIN);
    const T = net.clock.now();
    await net.clock.advance(MIN);
    await a.rename('x.md', 'tmp.md');
    await a.rename('y.md', 'x.md');
    await a.rename('tmp.md', 'y.md');
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'x.md': 'Y', 'y.md': 'X' });
    const report = await b.sync.restoreVault(await b.sync.planRestoreVault(T));
    expect(report.skipped).toEqual([]);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'x.md': 'X', 'y.md': 'Y' });
    expect(b.vault.tree()).toEqual({ 'x.md': 'X', 'y.md': 'Y' });
    healthy(a, b);
  });

  it('要寫的路徑被預覽外的檔案佔著：跳過回報 occupied（不覆寫）', async () => {
    const { net, a, b } = await pair();
    await a.edit('x.md', '原本的 x');
    await net.settle();
    await net.clock.advance(MIN);
    const T = net.clock.now();
    await net.clock.advance(MIN);
    await a.remove('x.md');
    await net.settle();
    await a.edit('x.md', '新的 x（另一個檔案）');
    await net.settle();
    const plan = await a.sync.planRestoreVault(T);
    expect(plan.undelete.map((i) => i.path)).toEqual(['x.md']);
    const report = await a.sync.restoreVault(plan);
    expect(report.skipped.map((i) => [i.path, i.reason])).toEqual([['x.md', 'occupied']]);
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'x.md': '新的 x（另一個檔案）' });
    healthy(a, b);
  });
});

describe('保留規則', () => {
  it('稀疏化：時間過去之後，背景維護把舊版本變疏（1 小時全留、1 天每小時一版、之後每天一版）', async () => {
    const { net, a } = await pair({ history: { dayBoundary: 'utc' } });
    for (let i = 0; i < 6; i += 1) {
      await a.edit('n.md', `v${i}`);
      await net.clock.advance(10 * MIN);
    }
    await net.settle();
    expect(await a.sync.history('n.md')).toHaveLength(6);
    await net.clock.advance(3 * HOUR);
    await a.sync.tick();
    // 同一個（或兩個）小時：每個小時只留最新的一版，最新的一版一定在
    const h = await a.sync.history('n.md');
    expect(h.length).toBeLessThanOrEqual(2);
    expect(await readText(a, h[0]!.versionId)).toBe('v5');
    await net.clock.advance(40 * DAY);
    await a.sync.tick();
    expect(await a.sync.history('n.md')).toHaveLength(1);
    // 清掉的內容也從 hc: 刪掉
    expect((await a.store.keys('hc:')).length).toBe(1);
  });

  it('總容量上限：從最舊的清，每個檔案至少留一版', async () => {
    const { net, a } = await pair({ history: { maxBytes: 100 } });
    for (let i = 0; i < 5; i += 1) {
      await a.edit('a.md', `${'a'.repeat(30)}${i}`);
      await a.edit('b.md', `${'b'.repeat(30)}${i}`);
      await net.clock.advance(1000);
    }
    await net.settle();
    expect(a.sync.historyStatus().bytes).toBeLessThanOrEqual(100);
    expect((await a.sync.history('a.md')).length).toBeGreaterThanOrEqual(1);
    expect((await a.sync.history('b.md')).length).toBeGreaterThanOrEqual(1);
    expect(await readText(a, (await a.sync.history('a.md'))[0]!.versionId)).toBe(`${'a'.repeat(30)}4`);
  });

  it('clearHistory：清空歸檔（狀態儲存裡的 ha:／hc: 都刪掉）；重開後不從版本圖補回來；之後的修改照常歸檔', async () => {
    const { net, a } = await pair();
    await a.edit('n.md', '一');
    await a.edit('n.md', '二');
    await net.settle();
    await a.sync.clearHistory();
    expect(await a.sync.history('n.md')).toEqual([]);
    expect(await a.store.keys('ha:')).toEqual([]);
    expect(await a.store.keys('hc:')).toEqual([]);
    await a.restart();
    expect(await a.sync.history('n.md')).toEqual([]);
    await net.clock.advance(1000);
    await a.edit('n.md', '三');
    expect((await a.sync.history('n.md')).map((e) => e.content)).toEqual([true]);
  });

  it('setHistory：關掉後不再新增（既有的讀得到）；調小保留規則立刻套用', async () => {
    const { net, a } = await pair();
    await a.edit('n.md', '一');
    await net.clock.advance(1000);
    await a.edit('n.md', '二');
    await a.sync.setHistory({ enabled: false });
    await a.edit('n.md', '三');
    expect(await a.sync.history('n.md')).toHaveLength(2);
    expect(a.sync.historyStatus().enabled).toBe(false);
    await a.sync.setHistory({ enabled: true, maxVersionsPerFile: 1 });
    expect(await a.sync.history('n.md')).toHaveLength(1);
    await net.settle();
  });
});

describe('輕量成員（ADR 0058、0060）', () => {
  const DAILY: VaultContentScope = { content: ['Daily/'] };

  async function sparsePair(history?: VaultSyncOptions['history']) {
    const net = new Net({ maxDelayMs: 30 });
    const vault = new MemoryVault();
    vault.userWrite('Daily/d.md', '今天');
    vault.userWrite('Notes/x.md', 'x');
    const a = await net.add('a', { vault, options: { peerScopes: { b: ['Daily/'] } } });
    await net.settle();
    const b = await net.add('b', { options: { scope: DAILY, ...(history ? { history } : {}) } });
    await net.settle();
    return { net, a, b };
  }

  it('預設關閉（裁示 4）', async () => {
    const { b, a, net } = await sparsePair();
    await a.edit('Daily/d.md', '今天改了');
    await net.settle();
    expect(await b.sync.history('Daily/d.md')).toEqual([]);
    expect(b.sync.historyStatus().enabled).toBe(false);
  });

  it('打開後只歸檔範圍內、內容在本機的版本；清掉本機副本（evict）不產生刪除紀錄', async () => {
    const { a, b, net } = await sparsePair({ enabled: true });
    await a.edit('Daily/d.md', '今天改了');
    await a.edit('Notes/x.md', 'x 改了');
    await net.settle();
    expect((await b.sync.history('Daily/d.md')).map((e) => e.content)).toEqual([true, true]);
    expect(await b.sync.history('Notes/x.md')).toEqual([]);
    // fetch 下來的（快取）：內容在本機 → 之後的版本歸檔
    await Promise.all([b.sync.fetch('Notes/x.md'), net.settle()]);
    expect((await b.sync.history('Notes/x.md')).map((e) => e.content)).toEqual([true]);
    const result = await b.sync.evict('Notes/x.md');
    expect(result.evicted).toBe(true);
    expect((await b.sync.history('Notes/x.md')).some((e) => e.deleted)).toBe(false);
    expect(b.sync.deletedFiles()).toEqual([]);
    healthy(a, b);
  });

  it('還原到範圍外（內容不在這台）：restore 丟 VaultScopeError；restoreVault 回報 scope、不中途丟出', async () => {
    const { a, b, net } = await sparsePair({ enabled: true });
    await Promise.all([b.sync.fetch('Notes/x.md'), net.settle()]);
    await net.clock.advance(MIN);
    const T = net.clock.now();
    await net.clock.advance(MIN);
    await a.edit('Notes/x.md', 'x 改了');
    await a.edit('Daily/d.md', '今天改了');
    await net.settle();
    await b.sync.evict('Notes/x.md');
    const old = (await b.sync.history('Notes/x.md')).at(-1)!;
    await expect(b.sync.restore('Notes/x.md', old.versionId)).rejects.toSatisfy((e) => isVaultScopeError(e) && e.code === 'base-missing');
    const plan = await b.sync.planRestoreVault(T);
    expect(plan.unrestorable.map((i) => [i.path, i.reason])).toEqual([['Notes/x.md', 'not-local']]);
    const report = await b.sync.restoreVault({ ...plan, revert: [...plan.revert, { ...old, path: 'Notes/x.md', from: 'Notes/x.md' }] });
    expect(report.restored.map((i) => i.path)).toEqual(['Daily/d.md']);
    expect(report.skipped.map((i) => [i.path, i.reason])).toEqual([
      ['Notes/x.md', 'not-local'],
      ['Notes/x.md', 'scope'],
    ]);
    await net.settle();
    expect(a.vault.get('Daily/d.md')).toBe('今天');
    expect(a.vault.get('Notes/x.md')).toBe('x 改了');
    healthy(a, b);
  });
});

describe('中繼不變', () => {
  it('不新增任何訊息種類：歸檔與還原只送一般的版本', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', '一');
    await a.edit('n.md', '二');
    await net.settle();
    await a.sync.restore('n.md', (await a.sync.history('n.md')).at(-1)!.versionId);
    await net.settle();
    // 簽收單（SDK ADR 0068）與歷史無關，是同步本身的訊息
    expect(net.hub.messages.every((m) => ['node', 'nodes', 'digest', 'want', 'receipt'].includes(m.type))).toBe(true);
    expect(text(b.vault.get('n.md')!)).toEqual(text('一'));
  });
});
