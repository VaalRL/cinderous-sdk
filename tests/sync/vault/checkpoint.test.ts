// 檢查點與操作紀錄（SDK ADR 0063〈使用者裁示（2026-10-08，補充：參考 git）〉）：整個 Vault 的清單（像 commit／tree）、
// 還原之前自動建立的檢查點與操作紀錄（像 ORIG_HEAD／reflog）、命名檢查點（像 tag，內容一直保留）、時間點優先從檢查點推算。
// 只在這台、不同步；沒有分支、不改寫歷史。
import { describe, expect, it } from 'vitest';

import { isVaultHistoryError, MAX_NAMED_CHECKPOINTS, VaultSyncCoordinator, type VaultContentScope, type VaultSyncOptions } from '../../../src/sync/vault/index.js';
import { type Device, MemoryVault, Net, str } from './harness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function pair(options: Partial<VaultSyncOptions> = {}) {
  const net = new Net({ maxDelayMs: 0 });
  const a = await net.add('a', { options });
  const b = await net.add('b', { options });
  await net.settle();
  return { net, a, b };
}

function healthy(...devices: Device[]) {
  for (const d of devices) {
    expect(d.errors, d.name).toEqual([]);
    const s = d.sync.status();
    expect(s.pending, `${d.name} pending`).toEqual([]);
    expect(s.queue, `${d.name} queue`).toBe(0);
  }
}

describe('自動檢查點（補充 1）', () => {
  it('同步告一段落時建立，最多每小時一個；沒有變化不建立；依稀疏化規則保留', async () => {
    const { net, a } = await pair({ history: { dayBoundary: 'utc' } });
    // 啟動後第一次靜止：建立一個（空的 Vault）
    expect(a.sync.checkpoints().map((c) => [c.kind, c.files])).toEqual([['auto', 0]]);
    await a.edit('n.md', '一');
    await net.settle();
    expect(a.sync.checkpoints()).toHaveLength(1); // 一小時內不再建立
    await net.clock.advance(HOUR + MIN);
    await a.edit('n.md', '二');
    await net.settle();
    expect(a.sync.checkpoints().map((c) => c.files)).toEqual([1, 0]);
    // 沒有變化：不建立
    await net.clock.advance(HOUR + MIN);
    await a.sync.tick();
    await net.settle();
    expect(a.sync.checkpoints()).toHaveLength(2);
    // 一天裡每小時一個，三天後只剩每天一個（最新的一定在）
    for (let i = 0; i < 6; i += 1) {
      await net.clock.advance(HOUR + MIN);
      await a.edit('n.md', `第 ${i} 小時`);
      await net.settle();
    }
    expect(a.sync.checkpoints().length).toBeGreaterThanOrEqual(7);
    const latest = a.sync.checkpoints()[0]!;
    await net.clock.advance(3 * DAY);
    await a.sync.tick();
    const left = a.sync.checkpoints();
    expect(left.length).toBeLessThanOrEqual(3);
    expect(left.map((c) => c.id)).toContain(latest.id);
    // 留下的照樣解得出來（差異鏈改了基準）
    expect((await a.sync.vaultAt({ checkpoint: latest.id })).files.map((f) => f.path)).toEqual(['n.md']);
    await a.restart();
    expect(a.sync.checkpoints().map((c) => c.id)).toEqual(left.map((c) => c.id));
    expect((await a.sync.vaultAt({ checkpoint: latest.id })).files.map((f) => f.path)).toEqual(['n.md']);
  });

  it('checkpoint()：立刻建立一般的檢查點；和最新的相同時回那一個；{ auto: true } 一小時內回 null', async () => {
    const { a } = await pair();
    await a.edit('n.md', '一');
    const c1 = await a.sync.checkpoint();
    expect(c1).toMatchObject({ kind: 'auto', files: 1 });
    expect(await a.sync.checkpoint()).toEqual(c1);
    await a.edit('n.md', '二');
    expect(await a.sync.checkpoint({ auto: true })).toBeNull();
  });
});

describe('自動檢查點由應用決定時機（SDK ADR 0072）', () => {
  const autos = (d: Device) => d.sync.checkpoints().filter((c) => c.kind === 'auto');

  it("autoCheckpoint: 'app'：協調器自己不建；checkpoint({ auto: true, minIntervalMs }) 從上一個自動檢查點算起，沒滿不建、沒變動不建", async () => {
    const { net, a } = await pair({ autoCheckpoint: 'app' });
    await a.edit('n.md', '一');
    await net.settle();
    await net.clock.advance(5 * HOUR);
    await a.edit('n.md', '二');
    await net.settle();
    expect(autos(a)).toEqual([]);
    const first = await a.sync.checkpoint({ auto: true, minIntervalMs: 8 * HOUR });
    expect(first?.kind).toBe('auto');
    await a.edit('n.md', '三');
    await net.settle();
    await net.clock.advance(7 * HOUR);
    expect(await a.sync.checkpoint({ auto: true, minIntervalMs: 8 * HOUR })).toBeNull(); // 還沒滿 8 小時
    await net.clock.advance(HOUR + MIN);
    const second = await a.sync.checkpoint({ auto: true, minIntervalMs: 8 * HOUR });
    expect(second?.kind).toBe('auto');
    // 沒有變動：不建，也不佔掉這一段——有變動之後馬上建得出來
    await net.clock.advance(9 * HOUR);
    expect(await a.sync.checkpoint({ auto: true, minIntervalMs: 8 * HOUR })).toBeNull();
    await a.edit('n.md', '四');
    await net.settle();
    expect((await a.sync.checkpoint({ auto: true, minIntervalMs: 8 * HOUR }))?.kind).toBe('auto');
    expect(autos(a)).toHaveLength(3);
    // 命名與還原之前的檢查點不受影響
    expect((await a.sync.checkpoint({ name: '手動' }))?.kind).toBe('named');
    healthy(a);
  });

  it("預設（'idle'）：沒有變動的那一次嘗試不再佔掉一整個小時（從上一個建立的檢查點算起，沒變動的過幾分鐘再試）", async () => {
    const { net, a } = await pair({ history: { dayBoundary: 'utc' } });
    expect(autos(a)).toHaveLength(1);
    await net.clock.advance(HOUR + MIN);
    // 一小時後靜止、沒有變動的嘗試
    await a.sync.scan();
    await net.settle();
    expect(autos(a)).toHaveLength(1);
    await net.clock.advance(10 * MIN);
    await a.edit('n.md', '一');
    await net.settle();
    expect(autos(a)).toHaveLength(2);
  });
});

describe('命名檢查點（補充 3）', () => {
  it('建立、列出、改名、刪除；名稱不合格、同名丟 checkpoint-name；上限 50 個丟 checkpoint-limit（不自動清掉任何一個）', async () => {
    const { a } = await pair();
    await a.edit('n.md', '一');
    const v1 = await a.sync.checkpoint({ name: '  交稿前  ' });
    expect(v1).toMatchObject({ kind: 'named', name: '交稿前', files: 1 });
    await expect(a.sync.checkpoint({ name: '交稿前' })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-name');
    await expect(a.sync.checkpoint({ name: '   ' })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-name');
    expect(await a.sync.renameCheckpoint(v1!.id, '交稿版')).toMatchObject({ name: '交稿版' });
    await expect(a.sync.renameCheckpoint('nope', 'x')).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-unknown');
    for (let i = 1; i < MAX_NAMED_CHECKPOINTS; i += 1) await a.sync.checkpoint({ name: `第 ${i} 個` });
    await expect(a.sync.checkpoint({ name: '第 51 個' })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-limit');
    expect(a.sync.checkpoints().filter((c) => c.kind === 'named')).toHaveLength(MAX_NAMED_CHECKPOINTS);
    // 自動檢查點改名就變成命名的：也算進上限
    const auto = a.sync.checkpoints().find((c) => c.kind === 'auto')!;
    await expect(a.sync.renameCheckpoint(auto.id, '升級')).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-limit');
    await a.sync.deleteCheckpoint(v1!.id);
    expect(await a.sync.renameCheckpoint(auto.id, '升級')).toMatchObject({ kind: 'named', name: '升級' });
    await expect(a.sync.deleteCheckpoint(v1!.id)).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-unknown');
  });

  it('內容一直保留：超過保留天數與 maxBytes、版本歷史清掉了，照樣還原得回來；pinnedBytes 另外回報；刪掉才放開', async () => {
    const { net, a, b } = await pair({ history: { maxBytes: 64 } });
    await a.edit('n.md', '交稿的版本');
    await net.settle();
    const tag = (await a.sync.checkpoint({ name: '交稿' }))!;
    const pinned = new TextEncoder().encode('交稿的版本').length;
    for (let i = 0; i < 5; i += 1) {
      await net.clock.advance(HOUR);
      await a.edit('n.md', `之後改的第 ${i} 版，內容比較長一些`);
      await net.settle();
    }
    await net.clock.advance(60 * DAY);
    await a.sync.tick();
    await net.settle();
    // 版本歷史只剩最新的一版（超過保留天數與容量），交稿的那一版不在歷史裡了
    expect(await a.sync.history('n.md')).toHaveLength(1);
    const status = a.sync.historyStatus();
    expect(status.pinnedBytes).toBe(pinned);
    expect(status.bytes - status.pinnedBytes).toBeLessThanOrEqual(64);
    expect(a.sync.checkpoints().map((c) => c.id)).toContain(tag.id);
    // 從命名檢查點還原
    const plan = await a.sync.planRestoreVault({ checkpoint: tag.id });
    expect([plan.source, plan.mixed, plan.checkpoint?.name]).toEqual(['checkpoint', false, '交稿']);
    expect(plan.revert.map((i) => i.path)).toEqual(['n.md']);
    const report = await a.sync.restoreVault(plan);
    expect(report.skipped).toEqual([]);
    await net.settle();
    expect(b.vault.get('n.md')).toBe('交稿的版本');
    // 重開後照樣釘著
    await a.restart();
    expect(a.sync.historyStatus().pinnedBytes).toBe(pinned);
    // 刪掉命名檢查點：沒有其他人用的內容一起放開
    await a.sync.deleteCheckpoint(tag.id);
    expect(a.sync.historyStatus().pinnedBytes).toBe(0);
    healthy(a, b);
  });
});

describe('還原之前的檢查點與操作紀錄（補充 2）', () => {
  it('restoreVault 先建立「還原之前」的檢查點、記一筆操作；還原到那個檢查點就復原', async () => {
    const { net, a, b } = await pair();
    await a.edit('a.md', 'A');
    await a.edit('b.md', 'B');
    await net.settle();
    const t = (await a.sync.checkpoint({ name: '整理前' }))!;
    await a.edit('a.md', 'A 改過');
    await a.rename('b.md', 'dir/b.md');
    await a.edit('c.md', '新的');
    await net.settle();
    const before = a.vault.tree();
    const report = await a.sync.restoreVault(await a.sync.planRestoreVault({ checkpoint: t.id, removeCreatedAfter: true }));
    expect(report.skipped).toEqual([]);
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'a.md': 'A', 'b.md': 'B' });
    const [op] = a.sync.operations();
    expect(op).toMatchObject({ kind: 'restore-vault', target: { checkpoint: t.id }, counts: { restored: 2, removed: 1, skipped: 0 } });
    expect(op!.restored.sort()).toEqual(['a.md', 'b.md']);
    expect(op!.removed).toEqual(['c.md']);
    const pre = a.sync.checkpoints().find((c) => c.id === op!.before)!;
    expect(pre.kind).toBe('restore');
    // 復原這次還原
    const undo = await a.sync.restoreVault(await a.sync.planRestoreVault({ checkpoint: op!.before!, removeCreatedAfter: true }));
    expect(undo.skipped).toEqual([]);
    await net.settle();
    expect(a.vault.tree()).toEqual(before);
    expect(b.vault.tree()).toEqual(before);
    expect(a.sync.operations().map((o) => o.kind)).toEqual(['restore-vault', 'restore-vault']);
    // 單一檔案的還原也記一筆
    await a.sync.restore('a.md', (await a.sync.history('a.md')).at(-1)!.versionId);
    expect(a.sync.operations()[0]).toMatchObject({ kind: 'restore-file', target: { path: 'a.md' }, restored: ['a.md'] });
    await net.settle();
    healthy(a, b);
  });

  it('改名跨檢查點：同一個檔案改回當時的路徑與內容（含互換名字）', async () => {
    const { net, a, b } = await pair();
    await a.edit('x.md', 'X');
    await a.edit('y.md', 'Y');
    await a.edit('notes/a.md', '一');
    await net.settle();
    const c1 = (await a.sync.checkpoint())!;
    const ids = Object.fromEntries(a.sync.index().map((e) => [e.path, e.fileId]));
    await a.rename('x.md', 'tmp.md');
    await a.rename('y.md', 'x.md');
    await a.rename('tmp.md', 'y.md');
    await a.rename('notes/a.md', 'archive/a.md');
    await a.edit('archive/a.md', '二');
    await net.settle();
    const c2 = (await a.sync.checkpoint())!;
    const at2 = b.vault.tree();
    await a.sync.restoreVault(await a.sync.planRestoreVault({ checkpoint: c1.id }));
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'notes/a.md': '一', 'x.md': 'X', 'y.md': 'Y' });
    // 同一個檔案身分
    expect(Object.fromEntries(b.sync.index().map((e) => [e.path, e.fileId]))).toEqual(ids);
    await a.sync.restoreVault(await a.sync.planRestoreVault({ checkpoint: c2.id }));
    await net.settle();
    expect(b.vault.tree()).toEqual(at2);
    expect(a.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });
});

describe('時間點的解法：檢查點 vs 各檔推算（補充 4）', () => {
  it('有檢查點時從它開始（指定時間在它之後有變動 → mixed）；指定檢查點就是那一刻；沒有檢查點才各檔推算（mixed）', async () => {
    const net = new Net({ maxDelayMs: 0 });
    // 升級前（歷史關閉）留下的版本：啟動時補進歸檔，但這之前沒有任何檢查點
    const a = await net.add('a', { options: { history: { enabled: false } } });
    await a.edit('old.md', '升級前');
    await net.clock.advance(MIN);
    const beforeUpgrade = net.clock.now();
    await net.clock.advance(MIN);
    await a.sync.stop();
    a.sync = new VaultSyncCoordinator({ adapter: a.vault, store: a.store, transport: a.transport, deviceId: 'a', deviceLabel: 'A', clock: net.clock, tickMs: 0 });
    await a.sync.start();
    await net.settle();
    const [auto] = a.sync.checkpoints();
    expect(auto).toMatchObject({ kind: 'auto', files: 1 });
    const recon = await a.sync.vaultAt(beforeUpgrade);
    expect([recon.source, recon.mixed, recon.checkpoint]).toEqual(['reconstructed', true, undefined]);
    expect(recon.files.map((f) => [f.path, f.restorable])).toEqual([['old.md', true]]);
    // 檢查點那一刻：確切
    const exact = await a.sync.vaultAt(auto!.at);
    expect([exact.source, exact.mixed, exact.checkpoint?.id]).toEqual(['checkpoint', false, auto!.id]);
    // 之後有變動：從檢查點開始、蓋上之後的版本
    await net.clock.advance(MIN);
    await a.edit('new.md', '之後');
    await a.rename('old.md', 'renamed.md');
    const later = await a.sync.vaultAt(net.clock.now() + 1000);
    expect([later.source, later.mixed]).toEqual(['checkpoint', true]);
    expect(later.files.map((f) => f.path)).toEqual(['new.md', 'renamed.md']);
    expect((await a.sync.vaultAt({ checkpoint: auto!.id })).files.map((f) => f.path)).toEqual(['old.md']);
    await expect(a.sync.vaultAt({ checkpoint: 'nope' })).rejects.toThrow(/沒有檢查點/);
    const plan = await a.sync.planRestoreVault({ checkpoint: auto!.id, removeCreatedAfter: true });
    expect(plan.revert.map((i) => [i.from, i.path])).toEqual([['renamed.md', 'old.md']]);
    expect(plan.remove.map((i) => i.path)).toEqual(['new.md']);
  });
});

describe('輕量成員、清空、不同步', () => {
  it('輕量成員：範圍外的檔案列在檢查點、但標成不能還原', async () => {
    const net = new Net({ maxDelayMs: 0 });
    const vault = new MemoryVault();
    vault.userWrite('Daily/d.md', '今天');
    vault.userWrite('Notes/x.md', 'x');
    const a = await net.add('a', { vault, options: { peerScopes: { b: ['Daily/'] } } });
    await net.settle();
    const scope: VaultContentScope = { content: ['Daily/'] };
    const b = await net.add('b', { options: { scope, history: { enabled: true } } });
    await net.settle();
    const cp = (await b.sync.checkpoint({ name: '手機' }))!;
    expect(cp.files).toBe(2);
    expect((await b.sync.vaultAt({ checkpoint: cp.id })).files.map((f) => [f.path, f.restorable])).toEqual([
      ['Daily/d.md', true],
      ['Notes/x.md', false],
    ]);
    await a.edit('Notes/x.md', 'x 改了');
    await a.edit('Daily/d.md', '今天改了');
    await net.settle();
    const plan = await b.sync.planRestoreVault({ checkpoint: cp.id });
    expect(plan.revert.map((i) => i.path)).toEqual(['Daily/d.md']);
    expect(plan.unrestorable.map((i) => [i.path, i.reason])).toEqual([['Notes/x.md', 'not-local']]);
    healthy(a, b);
  });

  it('clearHistory 也清掉檢查點與操作紀錄；檢查點與操作紀錄不送出任何訊息', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', '一');
    await net.settle();
    const sent = net.hub.messages.filter((m) => m.type !== 'receipt').length;
    const cp = (await a.sync.checkpoint({ name: '一' }))!;
    await a.edit('n.md', '二');
    await net.settle();
    expect(net.hub.messages.filter((m) => m.type !== 'receipt').length).toBe(sent + 1); // 只有「二」這個版本（另有 b 的簽收單，SDK ADR 0068）
    await a.sync.restoreVault(await a.sync.planRestoreVault({ checkpoint: cp.id }));
    await net.settle();
    expect(str(b.vault.files.get('n.md')!.bytes)).toBe('一');
    await a.sync.clearHistory();
    expect(a.sync.checkpoints()).toEqual([]);
    expect(a.sync.operations()).toEqual([]);
    expect(a.sync.historyStatus()).toMatchObject({ checkpoints: 0, bytes: 0, pinnedBytes: 0 });
    expect(await a.store.keys('hk:')).toEqual([]);
    expect(await a.store.get('ho')).toBeNull();
    await a.restart();
    expect(a.sync.checkpoints().filter((c) => c.kind !== 'auto')).toEqual([]);
    healthy(a, b);
  });
});
