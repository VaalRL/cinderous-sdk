// 隨機性質測試：衝突 callout（SDK ADR 0046）。與 property.test.ts 同一個世界（隨機編輯含同一行衝突、延遲、斷線、重送、重啟），
// 每台開 `conflictCallouts`（或混一台沒開的）。同樣的性質：最終一致（位元組相同）、不遺失資料（每一個沒被使用者刪掉的
// token 都還在——在原檔、callout 裡、或衝突副本裡）、沒有卡住的版本；另外 callout 真的出現過、而且沒有巢狀的 callout。
import { describe, expect, it } from 'vitest';

import { parseConflictCallouts } from '../../../src/sync/vault/index.js';
import { OPS, runSeed, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_CALLOUT_PROPERTY_SEEDS ?? 24);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);
const NESTED = /^> > \[!conflict\]/m;

for (const mode of [true, 'mixed'] as const) {
  describe(`隨機性質測試＋衝突 callout（${mode === true ? '全部支援' : '混一台不支援'}；${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
    it('最終一致、不遺失資料、沒有卡住的版本、callout 不巢狀', { timeout: 900_000 }, async () => {
      let callouts = 0;
      for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
        const { world } = await runSeed(seed, { callouts: mode });
        const trees = world.devices.map((d) => d.vault.tree());
        const context = `seed=${seed} (callouts=${String(mode)})\n${world.log.join('\n')}`;
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
        for (const [path, text] of Object.entries(trees[0]!)) {
          if (!path.endsWith('.md')) continue;
          expect(NESTED.test(text), `${context}\n${path}`).toBe(false);
          callouts += parseConflictCallouts(text).length;
        }
      }
      // 讓報告看得出這個測試真的走到 callout 路徑
      expect(callouts).toBeGreaterThan(0);
    });
  });
}
