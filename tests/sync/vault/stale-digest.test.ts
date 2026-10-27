// 過時的摘要不觸發重送（SDK ADR 0074）：摘要帶「已處理到各寄件人的寄件序號」（`seen`）與狀態識別碼（`sid`），
// 寄件人在那之後才經中繼送給它、還在保存期內的版本不重送（還在路上）。真的遺失的，之後的摘要（序號已經超過、或過了保存期）照樣補送；
// 收件人的狀態重建過（`sid` 換了）、或對方是舊版（摘要沒有 `seen`）照舊重送。
import { describe, expect, it } from 'vitest';

import { decodeVaultMessage, encodeVaultMessage } from '../../../src/sync/vault/codec.js';
import type { VaultSendOptions, VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { type Device, Net } from './harness.js';

/** 記下 `device` 每則版本訊息送給誰：版本 id → 每一份的收件人 */
function recordSends(net: Net, device: Device): Map<string, string[][]> {
  const sent = new Map<string, string[][]>();
  const t = device.transport;
  const send = t.send.bind(t);
  t.send = async (message: VaultSyncMessage, options?: VaultSendOptions) => {
    await send(message, options);
    const to = options?.to ?? net.hub.others(device.name);
    const ids = message.type === 'node' ? [message.node.id] : message.type === 'nodes' ? message.items.map(([, v]) => v.id) : [];
    for (const id of ids) sent.set(id, [...(sent.get(id) ?? []), [...to]]);
  };
  return sent;
}

/** 送給 `recipient` 超過一份的版本數 */
const duplicatesTo = (sent: Map<string, string[][]>, recipient: string) =>
  [...sent.values()].filter((copies) => copies.filter((to) => to.includes(recipient)).length > 1).length;

const digestsFrom = (net: Net, device: string) =>
  net.hub.messages.filter((m): m is Extract<VaultSyncMessage, { type: 'digest' }> => m.type === 'digest' && m.from === device);

describe('過時的摘要（SDK ADR 0074）', () => {
  it('線上格式：摘要帶 seen 與 sid；不合法的整則丟掉；沒有這兩欄（舊版）照收', () => {
    const base: VaultSyncMessage = { type: 'digest', from: 'a', digestId: 'f'.repeat(32), part: 0, parts: 1, files: [] };
    const digest: VaultSyncMessage = { ...base, seen: [['b', 12], ['c', 1]], sid: '0'.repeat(32) };
    expect(decodeVaultMessage(encodeVaultMessage(digest))).toEqual(digest);
    expect(decodeVaultMessage(encodeVaultMessage(base))).toEqual(base);
    for (const bad of [{ seen: [['b', 0]] }, { seen: [['b', 1.5]] }, { seen: [['bad id!', 1]] }, { seen: [['b', 1, 2]] }, { seen: 'x' }, { sid: 'xyz' }]) {
      expect(decodeVaultMessage(encodeVaultMessage({ ...base, ...bad } as unknown as VaultSyncMessage))).toBeNull();
    }
  });

  it('摘要帶已處理到的寄件序號與這份狀態的識別碼（重開不變）', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', 'x');
    await net.settle();
    b.sync.resync({ lost: false });
    await net.settle();
    const last = digestsFrom(net, 'b').at(-1)!;
    const rs = Math.max(...net.hub.messages.filter((m) => m.from === 'a' && m.rs !== undefined).map((m) => m.rs!));
    expect(last.seen).toEqual([['a', rs]]);
    expect(last.sid).toMatch(/^[0-9a-f]{32}$/);
    await b.restart();
    b.sync.resync({ lost: false });
    await net.settle();
    expect(digestsFrom(net, 'b').at(-1)!.sid).toBe(last.sid);
  });

  it('🔴 離線的那台回來：它的摘要比中繼上積著的版本先送出，別台不再重送那些版本', async () => {
    const net = new Net({ maxDelayMs: 2_000, seed: 7 });
    const a = await net.add('a');
    const b = await net.add('b');
    const c = await net.add('c');
    const sentA = recordSends(net, a);
    const sentB = recordSends(net, b);
    await net.settle();
    c.transport.setOnline(false);
    for (let i = 0; i < 20; i += 1) await (i % 2 ? a : b).edit(`n/${i}.md`, `v ${i}`);
    await net.settle();
    c.transport.setOnline(true);
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
    expect(duplicatesTo(sentA, 'c') + duplicatesTo(sentB, 'c')).toBe(0);
  });

  it('🔴 剛啟動的那台的摘要晚到（寄件人已經把新版本送出去了）：不重送', async () => {
    const net = new Net({ maxDelayMs: 2_000, seed: 13 });
    const a = await net.add('a');
    const sent = recordSends(net, a);
    await net.add('b');
    for (let i = 0; i < 30; i += 1) await a.edit(`n/${i}.md`, `v ${i}`);
    await net.settle();
    expect(net.devices[1]!.vault.tree()).toEqual(a.vault.tree());
    expect(duplicatesTo(sent, 'b')).toBe(0);
  });

  it('真的在中繼上遺失：之後處理到更新的訊息，下一份摘要就補送', async () => {
    const net = new Net();
    const a = await net.add('a');
    const c = await net.add('c');
    await net.settle();
    // 送給 c 的這一則在路上遺失
    let drop = true;
    net.hub.trust = (receiver, sender) => !(drop && receiver === 'c' && sender === 'a');
    await a.edit('x.md', 'x');
    await net.settle();
    drop = false;
    c.sync.resync({ lost: false }); // 序號還沒超過：x 可能還在路上，不重送
    await net.settle();
    expect(c.vault.files.has('x.md')).toBe(false);
    await a.edit('y.md', 'y');
    await net.settle();
    c.sync.resync({ lost: false }); // 已經處理到比 x 新的訊息：x 確實沒到
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
  });

  it('真的遺失、之後也沒有新訊息：過了中繼的保存期，摘要就補送', async () => {
    const net = new Net({ options: { relayLimits: { retentionSeconds: 7_200 } } });
    const a = await net.add('a');
    const c = await net.add('c');
    await net.settle();
    let drop = true;
    net.hub.trust = (receiver, sender) => !(drop && receiver === 'c' && sender === 'a');
    await a.edit('x.md', 'x');
    await net.settle();
    drop = false;
    c.sync.resync({ lost: false });
    await net.settle();
    expect(c.vault.files.has('x.md')).toBe(false);
    await net.clock.advance(3 * 3_600_000);
    c.sync.resync({ lost: false });
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
  });

  it('resync() 預設（這台可能漏收，例如名單晚到被擋掉）：摘要不帶 seen，對方照舊重送；lost: false 才帶', async () => {
    const net = new Net();
    const a = await net.add('a');
    const c = await net.add('c');
    await net.settle();
    let drop = true;
    net.hub.trust = (receiver, sender) => !(drop && receiver === 'c' && sender === 'a');
    await a.edit('x.md', 'x');
    await net.settle();
    drop = false;
    c.sync.resync();
    await net.settle();
    expect(digestsFrom(net, 'c').at(-1)!.seen).toBeUndefined();
    expect(c.vault.tree()).toEqual(a.vault.tree());
  });

  it('收件人的狀態重建過（同一個裝置 id、新的 sid）：照舊重送', async () => {
    const net = new Net();
    const a = await net.add('a');
    const c = await net.add('c');
    await net.settle();
    let drop = true;
    net.hub.trust = (receiver, sender) => !(drop && receiver === 'c' && sender === 'a');
    await a.edit('x.md', 'x');
    await net.settle();
    drop = false;
    // c 的同步狀態整個不見了（例如清掉了 IndexedDB），vault 還是空的
    await c.sync.stop();
    for (const key of await c.store.keys('')) await c.store.delete(key);
    await c.restart();
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
  });

  it('舊版的收件人（摘要沒有 seen）：照舊重送它缺的', async () => {
    const net = new Net();
    const a = await net.add('a');
    const c = await net.add('c');
    // c 是舊版：送出的摘要拿掉新欄位
    const send = c.transport.send.bind(c.transport);
    c.transport.send = async (message, options) => {
      if (message.type === 'digest') {
        const { seen: _seen, sid: _sid, ...old } = message;
        return send(old, options);
      }
      return send(message, options);
    };
    await net.settle();
    let drop = true;
    net.hub.trust = (receiver, sender) => !(drop && receiver === 'c' && sender === 'a');
    await a.edit('x.md', 'x');
    await net.settle();
    drop = false;
    c.sync.resync({ lost: false });
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
  });
});
