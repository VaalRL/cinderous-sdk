// 隨機性質測試：P2P 批次串流（SDK ADR 0026）。與 property.test.ts 同一個世界，再加上：
// 裝置之間有 P2P（離線時通道也斷）、跑到一半加入一台全新的裝置、偶爾寫超過檔案塊層的大檔（只走 P2P）。
// 檢查同樣的性質：最終一致、不遺失資料、沒有卡住的版本；另外所有大檔內容都送達、沒有待直送的項目。
import { describe, expect, it } from 'vitest';

import { OPS, runSeed, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_P2P_PROPERTY_SEEDS ?? 16);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);

describe(`隨機性質測試＋P2P 批次（${SEEDS} 個種子 × ${OPS} 個操作；新裝置加入、大檔）`, () => {
  it('最終一致、不遺失資料、大檔都送達、沒有卡住的版本', { timeout: 900_000 }, async () => {
    let bigFiles = 0;
    let lateFiles = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world } = await runSeed(seed, { p2p: true, lateJoin: true, bigFiles: true });
      const context = `seed=${seed} (p2p)\n${world.log.join('\n')}`;
      // 檔案樹一致（逐位元組比；大檔不轉成字串，快很多）
      const [first, ...rest] = world.devices.map((d) => d.vault.files);
      for (const files of rest) {
        expect([...files.keys()].sort(), context).toEqual([...first!.keys()].sort());
        for (const [path, f] of files) expect(Buffer.from(f.bytes).equals(Buffer.from(first!.get(path)!.bytes)), `${context}\n${path}`).toBe(true);
      }
      for (const device of world.devices) {
        const status = device.sync.status();
        expect(status.waiting, `${context}\n${device.name} waiting`).toBe(0);
        expect(status.pending, `${context}\n${device.name} pending`).toEqual([]);
        expect(status.queue, `${context}\n${device.name} queue`).toBe(0);
        expect(status.pushes, `${context}\n${device.name} pushes`).toBe(0);
        expect(device.errors, `${context}\n${device.name} errors`).toEqual([]);
      }
      const present = new Set<string>();
      for (const f of world.devices[0]!.vault.files.values()) for (const t of tokensOf(f.bytes)) present.add(t);
      const lost = [...world.written].filter((t) => !world.removed.has(t) && !present.has(t));
      expect(lost, context).toEqual([]);
      bigFiles += [...world.devices[0]!.vault.files.keys()].filter((p) => p.startsWith('media/')).length;
      lateFiles += world.devices.find((d) => d.name === 'late')!.vault.files.size;
    }
    // 讓報告看得出這個測試真的走到大檔與新裝置
    expect(bigFiles).toBeGreaterThan(0);
    expect(lateFiles).toBeGreaterThan(SEEDS);
  });
});
