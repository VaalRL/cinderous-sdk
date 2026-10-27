// 隨機性質測試：新裝置以 QR 配對加入（SDK ADR 0028）。與 property.test.ts 同一個世界，再加上：
// 每台裝置各自一把身分與一份名單；跑到一半，一台全新的裝置掃 d0 的 QR、雙方確認 SAS，名單經 NostrRosterSync
// 送到其他裝置；假中繼只投遞名單上的寄件裝置（名單更新前新裝置送的訊息會被丟掉，靠 resync 補上）。
// 檢查同樣的性質：最終一致、不遺失資料、沒有卡住的版本；新裝置拿到完整的檔案樹；各台名單一致。
import { describe, expect, it } from 'vitest';

import { OPS, runSeed, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_PAIRING_PROPERTY_SEEDS ?? 10);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);

describe(`隨機性質測試＋QR 配對加入（${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('配對後新裝置經協調器同步：最終一致、不遺失資料、名單一致', { timeout: 600_000 }, async () => {
    let lateFiles = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world } = await runSeed(seed, { lateJoin: true, pairing: true });
      const context = `seed=${seed} (pairing)\n${world.log.join('\n')}`;
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
      const pubkeys = [...world.members.values()].map((m) => m.identity.pubkey).sort();
      for (const m of world.members.values()) expect(m.membership.allowedPubkeys(), context).toEqual(pubkeys);
      lateFiles += world.devices.find((d) => d.name === 'late')!.vault.files.size;
    }
    expect(lateFiles).toBeGreaterThan(SEEDS);
  });
});
