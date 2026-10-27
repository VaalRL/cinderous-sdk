// 隨機性質測試：Markdown 合併規則（SDK ADR 0059）。與 property.test.ts 同一個世界（隨機編輯含同一行衝突、同名新增、延遲、斷線、
// 重送、重啟），每台都開 `mergeRules`＋`conflictCallouts`；另一輪是「配對前各台就有同路徑的檔案」＋回音（同路徑新建的合併最常見的情境）。
// 同樣的性質：最終一致（位元組相同）、不遺失資料（每一個沒被使用者刪掉的 token 都還在）、沒有卡住的版本、沒有錯誤；callout 不巢狀。
import { describe, expect, it } from 'vitest';

import { OPS, runSeed, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_MERGE_RULES_PROPERTY_SEEDS ?? 24);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);
const NESTED = /^> > \[!conflict\]/m;

for (const mode of ['random', 'prepaired'] as const) {
  describe(`隨機性質測試＋Markdown 合併規則（${mode === 'random' ? '隨機操作' : '配對前就有同路徑的檔案＋回音'}；${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
    it('最終一致、不遺失資料、沒有卡住的版本、callout 不巢狀', { timeout: 900_000 }, async () => {
      for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
        const { world } = await runSeed(seed, { mergeRules: true, callouts: true, ...(mode === 'prepaired' ? { prepaired: true, echo: true } : {}) });
        const trees = world.devices.map((d) => d.vault.tree());
        const context = `seed=${seed} (mergeRules, ${mode})\n${world.log.join('\n')}`;
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
        for (const [path, text] of Object.entries(trees[0]!)) if (path.endsWith('.md')) expect(NESTED.test(text), `${context}\n${path}`).toBe(false);
      }
    });
  });
}
