// 新裝置帶著同路徑的檔案加入、Vault 那份的歷史很深（SDK ADR 0088；2026-10-15 Pixel 8a 重設身分＋重新配對時實機發現）。
// 排程模式下兩台輪流上線（一輪＝上線、跑完、斷線）：
// - 補送原本一次只送被索取的那一個版本，新裝置每一輪只往回補一層祖先——歷史 6 層就要 6 個來回才併得進來；
// - 這段期間新裝置自己那一份已經被「同內容收斂」刪掉，磁碟上沒有這個檔。
import { describe, expect, it } from 'vitest';

import { decodeVaultMessage, encodeVaultMessage, validateVaultMessage, VaultWantResponder, type VaultSyncMessage, type VaultSyncOptions } from '../../../src/sync/vault/index.js';
import { type Device, flush, MemoryVault, Net } from './harness.js';

const CINDERSYNC: Partial<VaultSyncOptions> = { conflictCallouts: true, mergeRules: true };

/** 真的中繼上，新身分的收件匣是空的：加入之前的廣播不會補送給它（測試中繼預設會補送給所有裝置） */
function freshInbox(net: Net, d: Device): void {
  for (let i = 0; i < net.hub.messages.length; i += 1) d.transport.delivered.add(i);
}

/** 一輪：這台上線、跑完所有投遞，再斷線（排程模式） */
async function round(net: Net, d: Device): Promise<void> {
  d.transport.setOnline(true);
  await net.settle();
  d.transport.setOnline(false);
  await net.settle();
}

async function deepVault(depth: number, content: string) {
  const net = new Net({ seed: 5, options: CINDERSYNC });
  const a = await net.add('a');
  for (let i = 1; i < depth; i += 1) {
    await a.edit('n.md', `第 ${i} 版`);
    await net.settle();
    await net.clock.advance(60_000);
  }
  await a.edit('n.md', content);
  await net.settle();
  a.transport.setOnline(false);
  await net.settle();
  return { net, a };
}

describe('新裝置加入、Vault 那份的歷史很深（SDK ADR 0088）', () => {
  it('🔴 帶著內容相同的檔案加入：一個來回內就有整串歷史，磁碟上的檔案從頭到尾都在', async () => {
    const { net, a } = await deepVault(8, '最後的內容');
    const vault = new MemoryVault();
    vault.userWrite('n.md', '最後的內容');
    const c = await net.add('c', { vault, online: false });
    freshInbox(net, c);
    await round(net, c); // 新裝置第一輪：送出摘要與自己的檔案
    await round(net, a); // Vault 那台：回應
    await round(net, c); // 新裝置第二輪：收下
    expect(c.vault.files.has('n.md')).toBe(true);
    // 磁碟上那一份直接交給 Vault 的那個檔案：不刪、不搬到暫存名、不改寫（內容一樣）
    expect(c.vault.log.filter((l) => !l.startsWith('read '))).toEqual([]);
    expect(c.sync.status().waiting).toBe(0);
    await round(net, a);
    await round(net, c);
    expect(c.vault.tree()).toEqual(a.vault.tree());
    expect([...a.errors, ...c.errors]).toEqual([]);
  });

  it('🔴 新裝置上沒有這個檔：一個來回內就有整串歷史、檔案寫進來', async () => {
    const { net, a } = await deepVault(8, '最後的內容');
    const c = await net.add('c', { online: false });
    freshInbox(net, c);
    await round(net, c);
    await round(net, a);
    await round(net, c);
    expect(c.vault.get('n.md')).toBe('最後的內容');
    expect(c.sync.status().waiting).toBe(0);
    // 只寫一次最新的內容（祖先先到的話，每到一層就寫一次舊內容）
    expect(c.vault.log.filter((l) => l.startsWith('write '))).toEqual(['write n.md']);
  });

  it('同內容收斂的刪除到了、留下的那份確實沒到（扣住）：照舊刪（SDK ADR 0048），不會卡住；之後到了再寫回', async () => {
    const { net, a } = await deepVault(3, '最後的內容');
    const vault = new MemoryVault();
    vault.userWrite('n.md', '最後的內容');
    const c = await net.add('c', { vault, online: false });
    freshInbox(net, c);
    await round(net, c);
    const before = net.hub.messages.length;
    await round(net, a);
    // C 這一輪只收到「同內容收斂」的刪除版本：留下的那份的版本全部扣住
    const held: number[] = [];
    net.hub.messages.forEach((m, i) => {
      if (i >= before && m.type === 'node' && !m.node.deleted) {
        c.transport.delivered.add(i);
        held.push(i);
      }
    });
    expect(held.length).toBeGreaterThan(0);
    await round(net, c);
    expect(c.vault.files.has('n.md')).toBe(false);
    for (const i of held) c.transport.delivered.delete(i);
    await round(net, c);
    expect(c.vault.get('n.md')).toBe('最後的內容');
    expect(c.sync.status().waiting).toBe(0);
  });

  it('want 的 deep 旗標：來回；不是 true 的略過（舊版的驗證也只看 items）', () => {
    const want: VaultSyncMessage = { type: 'want', from: 'c', items: [['a'.repeat(32), 'b'.repeat(32)]], deep: true };
    expect(decodeVaultMessage(encodeVaultMessage(want))).toEqual(want);
    expect(validateVaultMessage({ type: 'want', from: 'c', items: [], deep: 'yes' })).toEqual({ type: 'want', from: 'c', items: [] });
  });

  it('🔴 兩輪之間的索取回應器（VaultWantResponder）也認得 deep：把那個版本的祖先一起送（子版本在前）', async () => {
    const { net, a } = await deepVault(5, '最後的內容');
    // 從 A 存下的紀錄取這個檔案的整串版本（線性歷史：每一版的父版本是上一版）
    const key = (await a.store.keys('f:'))[0]!;
    const rec = JSON.parse(new TextDecoder().decode((await a.store.get(key))!)) as { id: string; heads: string[]; nodes: Record<string, { id: string; parents: string[] }> };
    const chain: string[] = [];
    for (let id: string | undefined = rec.heads[0]; id; id = rec.nodes[id]?.parents[0]) chain.push(id);
    expect(chain.length).toBe(5);
    await a.sync.stop();
    a.transport.setOnline(true);
    const responder = new VaultWantResponder({ store: a.store, adapter: a.vault, transport: a.transport, deviceId: 'a' });
    responder.start();
    // C 只有傳輸層（沒有協調器）：只送這一則索取，不會一層一層再要
    const c = net.hub.transport('c', true);
    for (let i = 0; i < net.hub.messages.length; i += 1) c.delivered.add(i);
    const before = net.hub.messages.length;
    await c.send({ type: 'want', from: 'c', items: [[rec.id, chain[0]!]], deep: true }, { to: ['a'] });
    await net.settle();
    await flush();
    await net.settle();
    const sent = net.hub.messages.slice(before).filter((m): m is Extract<VaultSyncMessage, { type: 'node' }> => m.type === 'node' && m.from === 'a');
    // 要的那一個，接著是它的祖先（子版本在前）
    expect(sent.map((m) => m.node.id)).toEqual(chain);
    expect(responder.stats).toEqual({ answered: chain.length, skipped: 0 });
    await responder.stop();
  });
});
