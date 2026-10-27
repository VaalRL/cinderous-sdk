// 版本歷史 v0.50（SDK ADR 0063〈待決〉三題裁示）：
// - 裁示 3：歸檔的版本資訊用到時才載入——啟動時只讀每檔摘要（`hs:` 分片），`history()`／`readHistory()` 第一次用到才讀
//   那個檔案的 `ha:`（之後放在 LRU 快取），整庫的 `vaultAt`／`planRestoreVault` 逐檔讀；v0.49 的格式啟動時遷移一次。
// - 裁示 1：`removeCreatedBinaries`——T 之後建立的二進位檔列入刪除、標 irreversible，刪之前交給應用備份。
// - 裁示 2：「還原之前」的檢查點跟著保留天數過期；操作紀錄留著、標成不能復原，復原時丟有型別的錯誤。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { isVaultHistoryError, type VaultRestoreItem, type VaultSyncOptions } from '../../../src/sync/vault/index.js';
import { type Device, Net, str } from './harness.js';
import { archiveIntegrity, decodeHc, HC_MAGIC } from './history-integrity.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function pair(options: Partial<VaultSyncOptions> = {}) {
  const net = new Net({ maxDelayMs: 30 });
  const a = await net.add('a', { options });
  const b = await net.add('b', { options });
  return { net, a, b };
}

function healthy(...devices: Device[]) {
  for (const d of devices) {
    expect(d.errors, d.name).toEqual([]);
    expect(d.sync.status().pending, `${d.name} pending`).toEqual([]);
  }
}

/** 數狀態儲存的讀取（依鍵的字首） */
function countReads(d: Device): Map<string, number> {
  const counts = new Map<string, number>();
  const store = d.store;
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const prefix = key.includes(':') ? key.slice(0, key.indexOf(':') + 1) : key;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    return get(key);
  };
  return counts;
}

/** 把狀態儲存改回 v0.49 的格式：沒有 `hs:`／`hq`、`hc:` 只有內容、`m` 沒有 hv／hl（`ha:` 的格式兩版相同） */
async function toV049(d: Device): Promise<void> {
  await d.sync.stop();
  const store = d.store;
  for (const key of [...(await store.keys('hs:')), 'hq']) await store.delete(key);
  for (const key of await store.keys('hc:')) await store.set(key, decodeHc((await store.get(key))!)!.content.slice());
  const meta = JSON.parse(str((await store.get('m'))!)) as Record<string, unknown>;
  delete meta.hv;
  delete meta.hl;
  await store.set('m', new TextEncoder().encode(JSON.stringify(meta)));
}

describe('歸檔的版本資訊用到時才載入（v0.50 裁示 3）', () => {
  it('啟動時只讀摘要（不讀任何 ha:）；概況、最近刪除照樣有；history() 第一次才讀那個檔案、之後走快取', async () => {
    const { net, a } = await pair();
    for (let i = 0; i < 5; i += 1) {
      await a.edit('a.md', `a${i}`);
      await a.edit('b.md', `b${i}`);
      await net.clock.advance(1000);
    }
    await a.remove('b.md');
    await net.settle();
    const before = { status: a.sync.historyStatus(), deleted: a.sync.deletedFiles(), history: await a.sync.history('a.md') };
    const reads = countReads(a);
    await a.restart();
    expect(reads.get('ha:') ?? 0).toBe(0);
    expect(reads.get('hs:') ?? 0).toBeGreaterThan(0);
    expect(a.sync.historyStatus()).toEqual(before.status);
    expect(a.sync.deletedFiles()).toEqual(before.deleted);
    expect(a.sync.deletedFiles()[0]).toMatchObject({ path: 'b.md', lastVersion: { restorable: true } });
    expect(await a.sync.history('a.md')).toEqual(before.history);
    expect(reads.get('ha:')).toBe(1);
    expect(await a.sync.history('a.md')).toEqual(before.history);
    expect(reads.get('ha:')).toBe(1);
    // 只給版本 id：在快取裡找得到，不再讀
    expect(str((await a.sync.readHistory(before.history[4]!.versionId))!)).toBe('a0');
    expect(reads.get('ha:')).toBe(1);
    // 給 { fileId, versionId }（例如最近刪除的 lastVersion）：直接讀那個檔案
    const last = a.sync.deletedFiles()[0]!.lastVersion!;
    expect(str((await a.sync.readHistory(last))!)).toBe('b4');
    expect(reads.get('ha:')).toBe(2);
    healthy(a);
  });

  it('快取有上限（LRU）：讀過很多檔案之後，最早讀的被清掉、下次再讀', async () => {
    const net = new Net({ maxDelayMs: 0 });
    const a = await net.add('a');
    for (let i = 0; i < 300; i += 1) await a.edit(`f${i}.md`, `內容 ${i}`);
    await net.settle();
    await a.restart();
    const reads = countReads(a);
    for (let i = 0; i < 300; i += 1) expect(await a.sync.history(`f${i}.md`)).toHaveLength(1);
    expect(reads.get('ha:')).toBe(300);
    // 快取在工作結束時整理（沒有人拿著歸檔物件的時候）
    await a.sync.tick();
    await a.sync.history('f299.md');
    expect(reads.get('ha:')).toBe(300);
    await a.sync.history('f0.md');
    expect(reads.get('ha:')).toBe(301);
    healthy(a);
  });

  it('整庫的時間點逐檔讀：T 在每個檔案最新版本之後時只看摘要（不讀 ha:），往回看才讀有變動的檔案', async () => {
    const { net, a } = await pair({ history: { dayBoundary: 'utc' } });
    for (let i = 0; i < 20; i += 1) await a.edit(`n${i}.md`, `v1-${i}`);
    await net.settle();
    await net.clock.advance(2 * HOUR);
    const T = net.clock.now();
    await net.clock.advance(HOUR);
    await a.edit('n3.md', 'v2-3');
    await net.settle();
    await a.restart();
    const reads = countReads(a);
    const now = await a.sync.vaultAt(net.clock.now() + 1000);
    expect(now.files).toHaveLength(20);
    expect(reads.get('ha:') ?? 0).toBe(0);
    const plan = await a.sync.planRestoreVault(T);
    expect(plan.revert.map((i) => [i.path, i.hash === bytesToHex(sha256(new TextEncoder().encode('v1-3')))])).toEqual([['n3.md', true]]);
    // 只讀了有 T 之後版本的那一個檔案
    expect(reads.get('ha:')).toBe(1);
    await a.sync.restoreVault(plan);
    await net.settle();
    expect(a.vault.get('n3.md')).toBe('v1-3');
    await archiveIntegrity(a);
    healthy(a);
  });

  it('從 v0.49 的格式遷移：歷史、內容、檢查點、最近刪除都在；hc: 改成帶參照者；沒人參照的清掉；之後啟動不再遷移', async () => {
    const { net, a, b } = await pair();
    await a.edit('a.md', '一');
    await net.clock.advance(1000);
    await a.edit('a.md', '二');
    await a.edit('img.png', new Uint8Array([1, 2, 3]));
    await a.edit('gone.md', '要刪的');
    await net.settle();
    await a.remove('gone.md');
    await net.settle();
    const tag = (await a.sync.checkpoint({ name: '遷移前' }))!;
    await net.clock.advance(1000);
    await a.edit('a.md', '三');
    await net.settle();
    const before = {
      history: await a.sync.history('a.md'),
      status: a.sync.historyStatus(),
      deleted: a.sync.deletedFiles(),
      checkpoints: a.sync.checkpoints(),
    };
    await toV049(a);
    // 寫到一半重開留下的、沒有人參照的內容
    const orphan = new TextEncoder().encode('孤兒');
    await a.store.set(`hc:${bytesToHex(sha256(orphan))}`, orphan);
    // v0.49 每次啟動都從版本圖補：拿掉一筆，遷移時要補回來
    const fileId = before.history[0]!.fileId;
    const record = JSON.parse(str((await a.store.get(`ha:${fileId}`))!)) as { entries: Array<{ versionId: string }> };
    const removed = record.entries.pop()!;
    await a.store.set(`ha:${fileId}`, new TextEncoder().encode(JSON.stringify(record)));
    await a.restart();
    expect(removed.versionId).toBe(before.history[0]!.versionId);
    await net.settle();
    expect((await a.sync.history('a.md')).map((e) => e.versionId)).toEqual(before.history.map((e) => e.versionId));
    expect(str((await a.sync.readHistory(before.history[2]!))!)).toBe('一');
    expect(a.sync.historyStatus()).toMatchObject({ files: before.status.files, versions: before.status.versions, pinnedBytes: before.status.pinnedBytes });
    expect(a.sync.deletedFiles()).toEqual(before.deleted);
    expect(a.sync.checkpoints()).toEqual(before.checkpoints);
    expect(await a.store.get(`hc:${bytesToHex(sha256(orphan))}`)).toBeNull();
    const meta = JSON.parse(str((await a.store.get('m'))!)) as { hv?: number; hl?: boolean };
    expect(meta).toMatchObject({ hv: 2, hl: true });
    await archiveIntegrity(a);
    // 從遷移前的命名檢查點還原照樣可以
    const plan = await a.sync.planRestoreVault({ checkpoint: tag.id });
    expect(plan.revert.map((i) => i.path)).toEqual(['a.md']);
    await a.sync.restoreVault(plan);
    await net.settle();
    expect(b.vault.get('a.md')).toBe('二');
    // 再重開：不再讀 ha:
    const reads = countReads(a);
    await a.restart();
    expect(reads.get('ha:') ?? 0).toBe(0);
    await archiveIntegrity(a);
    healthy(a, b);
  });

  it('遷移中斷（部分 hc: 已經是新格式）：重來一次結果相同', async () => {
    const { net, a } = await pair();
    await a.edit('a.md', '一');
    await net.clock.advance(1000);
    await a.edit('a.md', '二');
    await net.settle();
    const history = await a.sync.history('a.md');
    await toV049(a);
    const [first] = await a.store.keys('hc:');
    const raw = (await a.store.get(first!))!;
    const owners = new TextEncoder().encode(JSON.stringify([history[0]!.fileId]));
    const value = new Uint8Array(8 + owners.length + raw.length);
    value.set(HC_MAGIC, 0);
    new DataView(value.buffer).setUint32(4, owners.length);
    value.set(owners, 8);
    value.set(raw, 8 + owners.length);
    await a.store.set(first!, value);
    await a.restart();
    expect((await a.sync.history('a.md')).map((e) => e.versionId)).toEqual(history.map((e) => e.versionId));
    for (const e of history) expect(await a.sync.readHistory(e)).not.toBeNull();
    await archiveIntegrity(a);
    healthy(a);
  });

  it('歷史關閉期間的版本：重新打開時逐檔補（有缺口的標記）；一直開著時重開不逐檔比對', async () => {
    const net = new Net({ maxDelayMs: 0 });
    const a = await net.add('a');
    await a.edit('a.md', '開著');
    await net.settle();
    await a.sync.setHistory({ enabled: false });
    await net.clock.advance(1000);
    await a.edit('a.md', '關著時改的');
    await net.settle();
    expect(await a.sync.history('a.md')).toHaveLength(1);
    await a.sync.setHistory({ enabled: true });
    expect((await a.sync.history('a.md')).map((e) => e.content)).toEqual([true, true]);
    // 一直開著：重開時不讀任何 ha:
    const reads = countReads(a);
    await a.restart();
    await a.sync.idle();
    expect(reads.get('ha:') ?? 0).toBe(0);
    healthy(a);
  });

  it('容量整理逐檔進行：從所有檔案裡最舊的版本清，每個檔案至少留一版；不必先讀完整個歸檔', async () => {
    const { net, a } = await pair({ history: { maxBytes: 400 } });
    for (let i = 0; i < 6; i += 1) {
      for (const f of ['a', 'b', 'c']) await a.edit(`${f}.md`, `${f.repeat(40)}${i}`);
      await net.clock.advance(1000);
    }
    await net.settle();
    expect(a.sync.historyStatus().bytes).toBeLessThanOrEqual(400);
    for (const f of ['a', 'b', 'c']) {
      const h = await a.sync.history(`${f}.md`);
      expect(h.length).toBeGreaterThanOrEqual(1);
      expect(str((await a.sync.readHistory(h[0]!))!)).toBe(`${f.repeat(40)}5`);
    }
    await archiveIntegrity(a);
  });
});

describe('T 之後建立的二進位檔（v0.50 裁示 1 乙）', () => {
  async function setup() {
    const { net, a, b } = await pair();
    await a.edit('keep.md', '留著');
    await net.settle();
    await net.clock.advance(HOUR);
    const T = net.clock.now();
    await net.clock.advance(HOUR);
    await a.edit('later.md', '之後');
    await a.edit('img.png', new Uint8Array([0x89, 0x50, 1, 2, 3]));
    await a.edit('doc.pdf', new Uint8Array(20).fill(7));
    await net.settle();
    return { net, a, b, T };
  }

  it('預覽：只有 removeCreatedAfter＋removeCreatedBinaries 都打開才列入刪除、標 irreversible、附總大小', async () => {
    const { a, T } = await setup();
    const def = await a.sync.planRestoreVault(T, { removeCreatedAfter: true });
    expect(def.remove.map((i) => i.path)).toEqual(['later.md']);
    expect(def.unrestorable.map((i) => [i.path, i.reason])).toEqual([
      ['doc.pdf', 'binary'],
      ['img.png', 'binary'],
    ]);
    expect(def.irreversibleBytes).toBe(0);
    const onlyBin = await a.sync.planRestoreVault(T, { removeCreatedBinaries: true });
    expect([onlyBin.remove, onlyBin.irreversibleBytes]).toEqual([[], 0]);
    const plan = await a.sync.planRestoreVault({ at: T, removeCreatedAfter: true, removeCreatedBinaries: true });
    expect(plan.remove.map((i) => [i.path, i.irreversible ?? false, i.size, i.text])).toEqual([
      ['doc.pdf', true, 20, false],
      ['img.png', true, 5, false],
      ['later.md', false, 6, true],
    ]);
    expect(plan.irreversibleBytes).toBe(25);
    expect(plan.unrestorable).toEqual([]);
  });

  it('預覽：沒打開 removeCreatedAfter 時，T 之後建立的檔案列在 keep（會留著；文字與二進位都列，依路徑排序），執行時不動（ADR 0070）', async () => {
    const { a, T } = await setup();
    const plan = await a.sync.planRestoreVault(T);
    expect(plan.keep?.map((i) => [i.path, i.size, i.text])).toEqual([
      ['doc.pdf', 20, false],
      ['img.png', 5, false],
      ['later.md', 6, true],
    ]);
    expect([plan.remove, plan.unrestorable]).toEqual([[], []]);
    const scoped = await a.sync.planRestoreVault(T, { paths: ['*.md'] });
    expect(scoped.keep?.map((i) => i.path)).toEqual(['later.md']);
    // 打開了就不在 keep（改列刪除或無法還原）
    expect((await a.sync.planRestoreVault(T, { removeCreatedAfter: true })).keep).toEqual([]);
    const report = await a.sync.restoreVault(plan);
    expect([report.removed, report.restored]).toEqual([[], []]);
    expect(str(a.vault.files.get('later.md')!.bytes)).toBe('之後');
  });

  it('執行：每個不可復原的刪除之前呼叫 beforeIrreversible（磁碟上的內容就是預覽時的）；備份失敗的不刪、回報 backup-failed', async () => {
    const { net, a, b, T } = await setup();
    const plan = await a.sync.planRestoreVault(T, { removeCreatedAfter: true, removeCreatedBinaries: true });
    const backups = new Map<string, Uint8Array>();
    const seen: VaultRestoreItem[] = [];
    const report = await a.sync.restoreVault(plan, {
      beforeIrreversible: (item) => {
        seen.push(item);
        if (item.path === 'doc.pdf') throw new Error('磁碟滿了');
        backups.set(item.path, a.vault.files.get(item.path)!.bytes.slice());
      },
    });
    expect(seen.map((i) => [i.path, i.irreversible])).toEqual([
      ['doc.pdf', true],
      ['img.png', true],
    ]);
    expect([...backups.get('img.png')!]).toEqual([0x89, 0x50, 1, 2, 3]);
    expect(report.removed.map((i) => [i.path, i.irreversible ?? false])).toEqual([
      ['img.png', true],
      ['later.md', false],
    ]);
    expect(report.skipped.map((s) => [s.path, s.reason, (s.error as Error | undefined)?.message])).toEqual([['doc.pdf', 'backup-failed', '磁碟滿了']]);
    await net.settle();
    expect(Object.keys(b.vault.tree()).sort()).toEqual(['doc.pdf', 'keep.md']);
    // 回 false 也算沒備份
    const again = await a.sync.planRestoreVault(T, { removeCreatedAfter: true, removeCreatedBinaries: true });
    const refused = await a.sync.restoreVault(again, { beforeIrreversible: () => false });
    expect(refused.skipped.map((s) => [s.path, s.reason])).toEqual([['doc.pdf', 'backup-failed']]);
    // 復原這次還原：二進位檔救不回來（歸檔沒有內容），文字檔回來了
    const [, op] = a.sync.operations();
    expect(op!.undoAvailable).toBe(true);
    const undo = await a.sync.planRestoreVault({ checkpoint: op!.before!, removeCreatedAfter: true });
    expect(undo.undelete.map((i) => i.path)).toEqual(['later.md']);
    expect(undo.unrestorable.map((i) => [i.path, i.reason])).toEqual([['img.png', 'binary']]);
    healthy(a, b);
  });

  it('沒給 beforeIrreversible：照預覽直接刪（應用在預覽時已明確選了）', async () => {
    const { net, a, b, T } = await setup();
    const report = await a.sync.restoreVault(await a.sync.planRestoreVault(T, { removeCreatedAfter: true, removeCreatedBinaries: true }));
    expect(report.removed.map((i) => i.path)).toEqual(['doc.pdf', 'img.png', 'later.md']);
    await net.settle();
    expect(Object.keys(b.vault.tree())).toEqual(['keep.md']);
    healthy(a, b);
  });

  it('預覽之後二進位檔被改了：不刪（changed），也不呼叫 beforeIrreversible', async () => {
    const { a, T } = await setup();
    const plan = await a.sync.planRestoreVault(T, { removeCreatedAfter: true, removeCreatedBinaries: true, paths: ['img.png'] });
    await a.edit('img.png', new Uint8Array([9, 9]));
    let called = 0;
    const report = await a.sync.restoreVault(plan, { beforeIrreversible: () => void (called += 1) });
    expect(called).toBe(0);
    expect(report.skipped.map((s) => [s.path, s.reason])).toEqual([['img.png', 'changed']]);
    expect([...a.vault.files.get('img.png')!.bytes]).toEqual([9, 9]);
  });
});

describe('「還原之前」的檢查點跟著保留天數（v0.50 裁示 2 甲）', () => {
  async function restored(options: Partial<VaultSyncOptions> = {}) {
    const { net, a, b } = await pair(options);
    await a.edit('n.md', '一');
    await net.settle();
    await net.clock.advance(HOUR);
    const T = net.clock.now();
    await net.clock.advance(HOUR);
    await a.edit('n.md', '二');
    await net.settle();
    await a.sync.restoreVault(await a.sync.planRestoreVault(T));
    await net.settle();
    return { net, a, b };
  }

  it('過期後：檢查點清掉，操作紀錄照留但 undoAvailable false（before-expired）；重開後一樣；復原丟 checkpoint-expired', async () => {
    const { net, a } = await restored({ history: { keepDays: 2 } });
    const [op] = a.sync.operations();
    expect([op!.undoAvailable, op!.undoUnavailable]).toEqual([true, undefined]);
    await net.clock.advance(2 * DAY - 3 * HOUR);
    await a.sync.tick();
    expect(a.sync.checkpoints().map((c) => c.id)).toContain(op!.before);
    await net.clock.advance(4 * HOUR);
    await a.sync.tick();
    expect(a.sync.checkpoints().map((c) => c.id)).not.toContain(op!.before);
    const [after] = a.sync.operations();
    expect(after).toMatchObject({ id: op!.id, before: op!.before, undoAvailable: false, undoUnavailable: 'before-expired', counts: op!.counts });
    await expect(a.sync.planRestoreVault({ checkpoint: op!.before! })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-expired' && e.versionId === op!.before);
    await expect(a.sync.vaultAt({ checkpoint: op!.before! })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-expired');
    await a.restart();
    expect(a.sync.operations()[0]).toMatchObject({ undoAvailable: false, undoUnavailable: 'before-expired' });
    await expect(a.sync.planRestoreVault({ checkpoint: op!.before! })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-expired');
  });

  it('被刪掉的是 before-deleted（不認得的檢查點照舊 checkpoint-unknown）；單一檔案的還原是 no-checkpoint；永久保留時不過期', async () => {
    const { net, a } = await restored({ history: { keepDays: Infinity } });
    const [op] = a.sync.operations();
    const [latest] = await a.sync.history('n.md');
    const older = (await a.sync.history('n.md')).find((e) => e.hash !== latest!.hash)!;
    await a.sync.restore('n.md', older);
    expect(a.sync.operations()[0]).toMatchObject({ kind: 'restore-file', undoAvailable: false, undoUnavailable: 'no-checkpoint' });
    await net.clock.advance(400 * DAY);
    await a.sync.tick();
    expect(a.sync.operations()[1]).toMatchObject({ id: op!.id, undoAvailable: true });
    await a.sync.deleteCheckpoint(op!.before!);
    expect(a.sync.operations()[1]).toMatchObject({ undoAvailable: false, undoUnavailable: 'before-deleted' });
    await expect(a.sync.planRestoreVault({ checkpoint: op!.before! })).rejects.toSatisfy((e) => isVaultHistoryError(e) && e.code === 'checkpoint-unknown');
  });
});
