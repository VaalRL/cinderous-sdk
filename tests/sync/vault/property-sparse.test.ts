// 隨機性質測試：輕量成員（SDK ADR 0058）。與 property.test.ts 同一個世界（隨機編輯、新增、改名、刪除、上下線、重啟、
// 延遲、重送），其中 d1 是輕量成員（只保存 `d1/` 的內容），其他台宣告它是輕量的（送給它的範圍外版本只帶版本資訊）。
// 檢查：完整成員之間最終一致、不遺失資料；d1 的版本資訊與完整成員一致（每個檔案的路徑與雜湊都一樣）；d1 的磁碟上
// 恰好是範圍內的檔案（加上被擋下、不同步的本機新增）；d1 沒有保存任何範圍外的內容；沒有卡住的版本、沒有錯誤；
// d1 沒有因為「範圍外」而送出任何刪除。
import { describe, expect, it } from 'vitest';

import { compilePathScope, SWAP_SUFFIX } from '../../../src/sync/vault/index.js';
import { OPS, runSeed, SPARSE_SCOPE, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_SPARSE_PROPERTY_SEEDS ?? 24);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);
const inScope = compilePathScope(SPARSE_SCOPE);

describe(`隨機性質測試＋輕量成員（${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('完整成員一致、不遺失；輕量成員的版本資訊一致、磁碟上只有範圍內的、不保存範圍外的內容', { timeout: 900_000 }, async () => {
    let outOfScope = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world } = await runSeed(seed, { sparse: true, callouts: true, mergeRules: true });
      const context = `seed=${seed} (sparse)\n${world.log.join('\n')}`;
      const full = world.devices.filter((d) => d.name !== 'd1');
      const sparse = world.devices.find((d) => d.name === 'd1')!;
      // 輕量成員自己寫的、範圍外的內容要等完整成員確認收到才清（它們的摘要）：讓它們送一次摘要
      for (const d of full) d.sync.resync();
      await world.net.settle();
      await sparse.sync.tick();
      await world.net.settle();
      const trees = full.map((d) => d.vault.tree());
      for (const tree of trees.slice(1)) expect(tree, context).toEqual(trees[0]);
      for (const device of world.devices) {
        const status = device.sync.status();
        expect(status.waiting, `${context}\n${device.name} waiting`).toBe(0);
        expect(status.pending, `${context}\n${device.name} pending`).toEqual([]);
        expect(status.queue, `${context}\n${device.name} queue`).toBe(0);
        const errors = device.errors.filter((e) => !e.startsWith('sparse-base-missing'));
        expect(errors, `${context}\n${device.name} errors`).toEqual([]);
      }
      // 被擋下的本機新增：留在 d1、不同步（它們的內容不算遺失）
      const blocked = new Set(sparse.sync.blockedLocal().map((b) => b.path));
      const blockedTokens = new Set<string>();
      for (const path of blocked) for (const t of tokensOf(sparse.vault.files.get(path)?.bytes ?? new Uint8Array())) blockedTokens.add(t);
      const present = new Set<string>();
      for (const f of full[0]!.vault.files.values()) for (const t of tokensOf(f.bytes)) present.add(t);
      const lost = [...world.written].filter((t) => !world.removed.has(t) && !present.has(t) && !blockedTokens.has(t));
      expect(lost, context).toEqual([]);
      // 版本資訊一致
      const fullIndex = full[0]!.sync.index().map((e) => [e.path, e.hash]).sort();
      const sparseIndex = sparse.sync.remoteIndex().filter((e) => !e.deleted).map((e) => [e.path, e.hash]).sort();
      expect(sparseIndex, context).toEqual(fullIndex);
      // 磁碟上：恰好是範圍內的與快取的（與完整成員相同），加上被擋下的本機新增
      // 快取（例如這台新建、被收進同路徑檔案後交接過去的）也算在本機
      const cached = new Set(sparse.sync.remoteIndex().filter((e) => e.cached && !e.deleted).map((e) => e.path));
      const expected = Object.fromEntries(Object.entries(trees[0]!).filter(([path]) => inScope(path) || cached.has(path)));
      // 協調器自己的暫存名（`SWAP_SUFFIX`，不同步）：隨機操作偶爾把它改名成另一個暫存名，留在本機
      const actual = Object.fromEntries(Object.entries(sparse.vault.tree()).filter(([path]) => !blocked.has(path) && !SWAP_SUFFIX.test(path)));
      expect(actual, context).toEqual(expected);
      // 不保存範圍外的內容
      for (const entry of sparse.sync.remoteIndex()) {
        if (entry.inScope || entry.deleted) continue;
        outOfScope += 1;
        expect(await sparse.store.keys(`b:${entry.fileId}:`), `${context}\n${entry.path}`).toEqual([]);
      }
    }
    expect(outOfScope).toBeGreaterThan(0);
  });
});

const P2P_SEEDS = Number(process.env.VAULT_SPARSE_P2P_SEEDS ?? 8);

describe(`隨機性質測試＋輕量成員＋P2P 大檔＋中途加入（${P2P_SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('完整成員一致、不遺失；輕量成員的版本資訊一致、沒有卡住', { timeout: 900_000 }, async () => {
    for (let seed = FIRST; seed < FIRST + P2P_SEEDS; seed += 1) {
      const { world } = await runSeed(seed, { sparse: true, p2p: true, bigFiles: true, lateJoin: true });
      const context = `seed=${seed} (sparse, p2p)\n${world.log.join('\n')}`;
      const full = world.devices.filter((d) => d.name !== 'd1');
      const sparse = world.devices.find((d) => d.name === 'd1')!;
      for (const d of full) d.sync.resync();
      await world.net.settle();
      const trees = full.map((d) => d.vault.tree());
      for (const tree of trees.slice(1)) expect(tree, context).toEqual(trees[0]);
      for (const device of world.devices) {
        const status = device.sync.status();
        expect([status.waiting, status.queue], `${context}\n${device.name}`).toEqual([0, 0]);
        expect(status.pending, `${context}\n${device.name} pending`).toEqual([]);
        expect(device.errors.filter((e) => !e.startsWith('sparse-base-missing')), `${context}\n${device.name} errors`).toEqual([]);
      }
      const fullIndex = full[0]!.sync.index().map((e) => [e.path, e.hash]).sort();
      expect(sparse.sync.remoteIndex().filter((e) => !e.deleted).map((e) => [e.path, e.hash]).sort(), context).toEqual(fullIndex);
      const blocked = new Set(sparse.sync.blockedLocal().map((b) => b.path));
      const blockedTokens = new Set<string>();
      for (const path of blocked) for (const t of tokensOf(sparse.vault.files.get(path)?.bytes ?? new Uint8Array())) blockedTokens.add(t);
      const present = new Set<string>();
      for (const f of full[0]!.vault.files.values()) for (const t of tokensOf(f.bytes)) present.add(t);
      expect([...world.written].filter((t) => !world.removed.has(t) && !present.has(t) && !blockedTokens.has(t)), context).toEqual([]);
    }
  });
});
