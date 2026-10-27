// 隨機性質測試：同步排除範圍（SDK ADR 0047）。與 property.test.ts 同一個世界（隨機編輯、改名、刪除、延遲、斷線、重送、重啟、
// 不通知只靠掃描），另外每台裝置一組各自不同的隨機排除規則，跑到一半隨機加入／移除。
//
// 性質：
// 1. 每次 `setExcludes`：本機的內容一個都沒少、沒有排進任何真的刪除（在 property-world 的 changeExcludes 裡檢查）。
// 2. 規則還在時：沒有錯誤、沒有卡住的版本與送出佇列；「共同範圍」（每台都沒排除的路徑）各裝置一致；
//    任何一次寫入的內容，除非使用者自己刪掉，都還在某一台的磁碟上（排除範圍裡的也算）——**沒有任何裝置因為排除而刪掉別台的內容**。
// 3. 全部移除規則（重新納入）之後：整棵檔案樹各裝置一致、不遺失資料、沒有卡住的版本。
import { describe, expect, it } from 'vitest';

import { OPS, releaseExcludes, runSeed, sharedView, tokensOf } from './property-world.js';

const SEEDS = Number(process.env.VAULT_EXCLUDES_PROPERTY_SEEDS ?? 24);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);

describe(`隨機性質測試＋同步排除範圍（${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('排除不等於刪除、共同範圍一致、重新納入後完全一致', { timeout: 900_000 }, async () => {
    let changes = 0;
    let detached = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world } = await runSeed(seed, { excludes: true });
      const context = () => `seed=${seed}\n${world.log.join('\n')}`;
      changes += world.exclChanges;

      // 規則還在
      for (const device of world.devices) {
        const status = device.sync.status();
        expect(device.errors, `${context()}\n${device.name} errors`).toEqual([]);
        expect(status.waiting, `${context()}\n${device.name} waiting`).toBe(0);
        expect(status.queue, `${context()}\n${device.name} queue`).toBe(0);
        const list = device.sync.detached();
        detached += list.length;
      }
      const views = sharedView(world);
      for (const view of views.slice(1)) expect(view, context()).toEqual(views[0]);
      const anywhere = new Set<string>();
      for (const device of world.devices) for (const f of device.vault.files.values()) for (const t of tokensOf(f.bytes)) anywhere.add(t);
      expect([...world.written].filter((t) => !world.removed.has(t) && !anywhere.has(t)), context()).toEqual([]);

      // 全部重新納入
      await releaseExcludes(world);
      const trees = world.devices.map((d) => d.vault.tree());
      for (const tree of trees.slice(1)) expect(tree, context()).toEqual(trees[0]);
      for (const device of world.devices) {
        const status = device.sync.status();
        expect(device.errors, `${context()}\n${device.name} errors`).toEqual([]);
        expect(status.waiting, `${context()}\n${device.name} waiting`).toBe(0);
        expect(status.pending, `${context()}\n${device.name} pending`).toEqual([]);
        expect(status.queue, `${context()}\n${device.name} queue`).toBe(0);
      }
      const present = new Set<string>();
      for (const f of world.devices[0]!.vault.files.values()) for (const t of tokensOf(f.bytes)) present.add(t);
      expect([...world.written].filter((t) => !world.removed.has(t) && !present.has(t)), context()).toEqual([]);
    }
    // 讓報告看得出這個測試真的走到排除的路徑
    expect(changes).toBeGreaterThan(SEEDS);
    expect(detached).toBeGreaterThan(0);
  });
});

const P2P_SEEDS = Number(process.env.VAULT_EXCLUDES_P2P_SEEDS ?? 8);

describe(`隨機性質測試＋同步排除範圍＋P2P 大檔（${P2P_SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('被排除的大檔不收內容也不卡住；重新納入後完全一致', { timeout: 900_000 }, async () => {
    for (let seed = FIRST; seed < FIRST + P2P_SEEDS; seed += 1) {
      const { world } = await runSeed(seed, { excludes: true, p2p: true, bigFiles: true, lateJoin: true });
      const context = () => `seed=${seed} (p2p)\n${world.log.join('\n')}`;
      for (const device of world.devices) expect(device.errors, `${context()}\n${device.name} errors`).toEqual([]);
      const views = sharedView(world);
      for (const view of views.slice(1)) expect(view, context()).toEqual(views[0]);
      await releaseExcludes(world);
      const trees = world.devices.map((d) => d.vault.tree());
      for (const tree of trees.slice(1)) expect(tree, context()).toEqual(trees[0]);
      for (const device of world.devices) {
        const status = device.sync.status();
        expect(device.errors, `${context()}\n${device.name} errors`).toEqual([]);
        expect(status.waiting, `${context()}\n${device.name} waiting`).toBe(0);
        expect(status.pending, `${context()}\n${device.name} pending`).toEqual([]);
        expect(status.queue, `${context()}\n${device.name} queue`).toBe(0);
      }
      const present = new Set<string>();
      for (const f of world.devices[0]!.vault.files.values()) for (const t of tokensOf(f.bytes)) present.add(t);
      expect([...world.written].filter((t) => !world.removed.has(t) && !present.has(t)), context()).toEqual([]);
    }
  });
});
