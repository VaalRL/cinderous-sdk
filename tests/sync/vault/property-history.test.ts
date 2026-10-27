// 版本歷史的隨機性質測試（SDK ADR 0063）：隨機操作跑完之後，一台裝置把整個 Vault 回到跑到一半的時間點，再用操作紀錄裡
// 「還原之前」的檢查點回到還原之前——
// - 每一步之後所有裝置一致、沒有卡住的版本、沒有錯誤；
// - 還原不遺失內容：還原前在的每個 token，還原後不是還在 Vault 裡，就是在這台的歸檔（`hc:`）裡；
// - 再還原回去之後，還原前的內容一個都沒少；沒有跳過、也沒有新的衝突時，整棵樹和還原前完全相同。
import { describe, expect, it } from 'vitest';

import type { Device } from './harness.js';
import { rng } from './harness.js';
import { archiveIntegrity, decodeHc } from './history-integrity.js';
import { OPS, runSeed, settleAll, tokensOf, type World } from './property-world.js';

const SEEDS = Number(process.env.VAULT_HISTORY_SEEDS ?? 12);
const FIRST = Number(process.env.VAULT_PROPERTY_FIRST_SEED ?? 1);

function vaultTokens(device: Device): Set<string> {
  const out = new Set<string>();
  for (const f of device.vault.files.values()) for (const t of tokensOf(f.bytes)) out.add(t);
  return out;
}

async function archiveTokens(device: Device): Promise<Set<string>> {
  await device.sync.idle();
  const out = new Set<string>();
  for (const key of await device.store.keys('hc:')) {
    const bytes = await device.store.get(key);
    if (bytes) for (const t of tokensOf(decodeHc(bytes)!.content)) out.add(t);
  }
  return out;
}

function converged(world: World, context: string): void {
  const trees = world.devices.map((d) => d.vault.tree());
  for (const tree of trees.slice(1)) expect(tree, context).toEqual(trees[0]);
  for (const device of world.devices) {
    const status = device.sync.status();
    expect(device.errors, `${context}\n${device.name} errors`).toEqual([]);
    expect(status.waiting, `${context}\n${device.name} waiting`).toBe(0);
    expect(status.pending, `${context}\n${device.name} pending`).toEqual([]);
    expect(status.queue, `${context}\n${device.name} queue`).toBe(0);
  }
}

const conflictCount = (world: World) => world.devices.reduce((n, d) => n + d.sync.status().conflicts.length, 0);

describe(`版本歷史的隨機性質測試（${SEEDS} 個種子 × ${OPS} 個操作）`, () => {
  it('整個 Vault 回到時間點、再回到還原之前：一致、不遺失內容', { timeout: 600_000 }, async () => {
    let exact = 0;
    let changed = 0;
    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const { world } = await runSeed(seed);
      const random = rng(seed * 31);
      const device = world.devices[Math.floor(random() * world.devices.length)]!;
      const context = (step: string) => `seed=${seed} ${step} on ${device.name}\n${world.log.join('\n')}`;
      converged(world, context('before'));
      const before = device.vault.tree();
      const beforeTokens = vaultTokens(device);
      const conflictsBefore = conflictCount(world);

      // 回到跑到一半的時間點
      await world.net.clock.advance(1000);
      const plan = await device.sync.planRestoreVault(world.midAt!, { removeCreatedAfter: random() < 0.5 });
      const report = await device.sync.restoreVault(plan);
      changed += report.restored.length + report.removed.length;
      for (const s of report.skipped) expect(s.reason, `${context('restore')}\n${JSON.stringify(s)}`).not.toBe('error');
      await settleAll(world);
      converged(world, context('restore'));
      const kept = new Set([...vaultTokens(device), ...(await archiveTokens(device))]);
      const lost = [...beforeTokens].filter((t) => !kept.has(t));
      expect(lost, context('restore lost')).toEqual([]);
      for (const d of world.devices) await archiveIntegrity(d);

      // 再回到還原之前：操作紀錄的最新一筆就是剛才的還原，`before` 是它自動建立的檢查點
      const [op] = device.sync.operations();
      expect(op?.kind, context('operations')).toBe('restore-vault');
      expect(op!.counts, context('operations')).toEqual({ restored: report.restored.length, removed: report.removed.length, skipped: report.skipped.length });
      await world.net.clock.advance(1000);
      const undo = await device.sync.planRestoreVault({ checkpoint: op!.before!, removeCreatedAfter: true });
      expect([undo.source, undo.mixed], context('undo plan')).toEqual(['checkpoint', false]);
      const undone = await device.sync.restoreVault(undo);
      for (const s of undone.skipped) expect(s.reason, `${context('undo')}\n${JSON.stringify(s)}`).not.toBe('error');
      await settleAll(world);
      converged(world, context('undo'));
      for (const d of world.devices) await archiveIntegrity(d);
      const after = vaultTokens(device);
      expect([...beforeTokens].filter((t) => !after.has(t)), context('undo lost')).toEqual([]);
      if (undone.skipped.length === 0 && conflictCount(world) === conflictsBefore) {
        expect(device.vault.tree(), context('undo exact')).toEqual(before);
        exact += 1;
      }
    }
    // 讓報告看得出真的有還原東西、也真的驗到完全回去
    expect(changed).toBeGreaterThan(SEEDS);
    expect(exact).toBeGreaterThan(0);
  });
});
