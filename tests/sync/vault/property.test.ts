// 隨機化的性質測試（SDK ADR 0025 §測試）：多台裝置隨機操作＋隨機網路延遲、斷線、重送、重啟，
// 最後所有裝置的檔案樹一致，而且任何一次本機寫入的內容，除非是使用者自己刪掉的，都還找得到
// （在原檔或衝突副本裡）。每個種子可重現：失敗時訊息裡有種子與操作紀錄。
import { describe, expect, it } from 'vitest';

import { OPS, runSeed, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_PROPERTY_SEEDS ?? 40);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);

describe(`隨機性質測試（${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('最終一致、不遺失資料、沒有卡住的版本', { timeout: 600_000 }, async () => {
    let totalConflicts = 0;
    let totalTokens = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world, conflicts } = await runSeed(seed);
      totalConflicts += conflicts;
      const trees = world.devices.map((d) => d.vault.tree());
      const context = `seed=${seed}\n${world.log.join('\n')}`;
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
      totalTokens += world.written.size;
    }
    // 讓報告看得出這個測試真的有走到衝突路徑
    expect(totalConflicts).toBeGreaterThan(0);
    expect(totalTokens).toBeGreaterThan(SEEDS * 10);
  });
});
