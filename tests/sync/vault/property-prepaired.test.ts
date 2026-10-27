// 隨機性質測試：配對前各台就有檔案（SDK ADR 0048）。各台的 Vault 一開始就有同路徑、沒有共同祖先的檔案（內容不同、相同、
// 一方是空檔、全部是空檔），同時啟動、都在線，協調器自己的寫入也有回音（像 Obsidian＋CinderSync 的監聽）。
// 檢查：啟動後每台對每個衝突副本最多寫一次、原路徑最多（裝置數 − 1）次（不來回震盪）；之後照常隨機操作，最終一致、不遺失資料、沒有卡住的版本。
import { describe, expect, it } from 'vitest';

import { OPS, runSeed, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_PREPAIRED_PROPERTY_SEEDS ?? 40);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);

describe(`隨機性質測試＋配對前就有的檔案（${SEEDS} 個種子 × ${OPS} 個操作，有回音、沒有回音各一輪）`, () => {
  it.each([true, false])('啟動時寫入次數有界；之後最終一致、不遺失資料、沒有卡住的版本（回音：%s）', { timeout: 600_000 }, async (echo) => {
    let conflictsTotal = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world, conflicts, initialMaxWrites } = await runSeed(seed, { prepaired: true, echo });
      conflictsTotal += conflicts;
      const context = `seed=${seed} (prepaired, echo=${echo})\n${world.log.join('\n')}`;
      expect(initialMaxWrites, context).toBeLessThanOrEqual(1);
      const trees = world.devices.map((d) => d.vault.tree());
      for (const tree of trees.slice(1)) expect(tree, context).toEqual(trees[0]);
      for (const device of world.devices) {
        const status = device.sync.status();
        expect(status.waiting, `${context}\n${device.name} waiting`).toBe(0);
        expect(status.pending, `${context}\n${device.name} pending`).toEqual([]);
        expect(status.queue, `${context}\n${device.name} queue`).toBe(0);
        expect(device.errors, `${context}\n${device.name} errors`).toEqual([]);
      }
      const present = new Set<string>();
      for (const f of world.devices[0]!.vault.files.values()) for (const t of tokensOf(f.bytes)) present.add(t);
      const lost = [...world.written].filter((t) => !world.removed.has(t) && !present.has(t));
      expect(lost, context).toEqual([]);
    }
    expect(conflictsTotal).toBeGreaterThan(0);
  });
});
