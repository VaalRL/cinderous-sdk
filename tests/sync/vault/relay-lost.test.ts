// 中繼弄丟的版本（SDK ADR 0106；2026-10-22 motorola 實機）：新加入的手機收到 75 個檔的建立版本，刪除版本卻在中繼上不見了
// （寄件端看到成功、從佇列移除）。之後手機的摘要說它沒有，寄件端卻當作「經中繼送出、還在路上」（SDK ADR 0074）不重送，
// 手機也不再送摘要——一直留著桌機已經刪掉的檔。對方簽收了更後面的序號、這一則卻一直沒簽收，就當作弄丟了，重送一次。
import { describe, expect, it } from 'vitest';

import type { VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { Net } from './harness.js';

const MIN = 60_000;

/** 訊息帶的版本（`node`／`nodes`／`bundle`） */
function versionsOf(message: VaultSyncMessage): Array<{ path: string; deleted: boolean }> {
  if (message.type === 'node') return [message.node];
  if (message.type === 'nodes') return message.items.map(([, node]) => node);
  if (message.type === 'bundle') return message.items.map((item) => item.node);
  return [];
}

/** a 有 5 個檔、都刪掉了；c 之後才加入，中繼弄丟 a 送給 c、第一則帶 `d/f0.md` 刪除版本的訊息 */
async function lateJoinWithLoss(opts: { receipts?: boolean; dropAll?: boolean } = {}) {
  const net = new Net({ options: { tickMs: MIN } });
  const a = await net.add('a');
  for (let i = 0; i < 5; i += 1) a.vault.userWrite(`d/f${i}.md`, `content ${i}`);
  await a.sync.scan();
  await net.clock.advance(MIN);
  for (let i = 0; i < 5; i += 1) await a.remove(`d/f${i}.md`);
  await net.clock.advance(MIN);
  const before = net.hub.sends.length;
  let dropped = 0;
  net.hub.drop = (from, message) => {
    if (from !== 'a' || !versionsOf(message).some((n) => n.deleted && n.path === 'd/f0.md')) return false;
    if (dropped > 0 && !opts.dropAll) return false;
    dropped += 1;
    return true;
  };
  const c = await net.add('c', opts.receipts === false ? { options: { receipts: false } } : {});
  return { net, a, c, dropped: () => dropped, before };
}

/** c 加入之後，a 送出、中繼收下的帶 `d/f0.md` 刪除版本的訊息（被弄丟的那一則不算） */
const toC = (net: Net, before: number) => net.hub.sends.slice(before).filter((s) => s.from === 'a' && versionsOf(s.message).some((n) => n.deleted && n.path === 'd/f0.md'));

describe('🔴 中繼弄丟的版本：對方簽收了後面的、這一則一直沒簽收就重送（SDK ADR 0106）', () => {
  it('新加入的裝置漏收一則刪除：約 10 分鐘後重送一次，檔案刪掉', async () => {
    const { net, a, c, dropped, before } = await lateJoinWithLoss();
    for (let i = 0; i < 5; i += 1) await net.clock.advance(MIN);
    expect(dropped()).toBe(1);
    expect(c.vault.get('d/f0.md')).toBe('content 0'); // 還沒過門檻：照舊當作在路上
    for (let i = 0; i < 15; i += 1) await net.clock.advance(MIN);
    expect(c.vault.tree()).toEqual({});
    // 重送一次（照既有的補送規則：完整成員要的照舊廣播）
    expect(toC(net, before).length).toBe(1);
    expect([a.errors, c.errors]).toEqual([[], []]);
  });

  it('沒有弄丟：不重送', async () => {
    const net = new Net({ options: { tickMs: MIN } });
    const a = await net.add('a');
    for (let i = 0; i < 5; i += 1) a.vault.userWrite(`d/f${i}.md`, `content ${i}`);
    await a.sync.scan();
    await net.clock.advance(MIN);
    for (let i = 0; i < 5; i += 1) await a.remove(`d/f${i}.md`);
    await net.clock.advance(MIN);
    const before = net.hub.sends.length;
    const c = await net.add('c');
    for (let i = 0; i < 60; i += 1) await net.clock.advance(MIN);
    expect(c.vault.tree()).toEqual({});
    expect(toC(net, before).length).toBe(1);
  });

  it('對方離線、什麼都還沒簽收：不當作弄丟（等它上線補拉）', async () => {
    const net = new Net({ options: { tickMs: MIN } });
    const a = await net.add('a');
    const c = await net.add('c');
    await net.clock.advance(MIN);
    c.transport.setOnline(false);
    for (let i = 0; i < 5; i += 1) await a.edit(`x${i}.md`, `x ${i}`);
    for (let i = 0; i < 60; i += 1) await net.clock.advance(MIN);
    const nodesToC = net.hub.sends.filter((s) => s.from === 'a' && versionsOf(s.message).some((n) => n.path === 'x0.md'));
    expect(nodesToC.length).toBe(1);
    c.transport.setOnline(true);
    for (let i = 0; i < 5; i += 1) await net.clock.advance(MIN);
    expect(c.vault.get('x0.md')).toBe('x 0');
  });

  it('重送的那一則又弄丟：下一次再重送（每次都要對方簽收了更後面的）', async () => {
    const { net, c, dropped } = await lateJoinWithLoss({ dropAll: true });
    for (let i = 0; i < 25; i += 1) await net.clock.advance(MIN);
    expect(dropped()).toBe(2);
    // 第二次弄丟後，c 要再簽收比它更後面的才會再判定：a 再寫一筆，c 收到、簽收
    net.hub.drop = undefined;
    const a = net.devices[0]!;
    await a.edit('later.md', 'later');
    for (let i = 0; i < 25; i += 1) await net.clock.advance(MIN);
    expect(c.vault.get('d/f0.md')).toBeUndefined();
  });

  it('舊版收件端（不簽收）：看不出弄丟，維持原狀', async () => {
    const { net, c, dropped, before } = await lateJoinWithLoss({ receipts: false });
    for (let i = 0; i < 60; i += 1) await net.clock.advance(MIN);
    expect(dropped()).toBe(1);
    expect(c.vault.get('d/f0.md')).toBe('content 0');
    expect(toC(net, before)).toEqual([]);
  });
});
