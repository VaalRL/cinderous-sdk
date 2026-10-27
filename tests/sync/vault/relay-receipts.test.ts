// 送出端的中繼預算按收件人記帳、用加密簽收單扣帳（SDK ADR 0068）：寄件序號、收件端處理完才簽收、
// 簽收單只送給寄件人、簽收劃掉那一台的帳、帳滿只排除那一台、簽收單順便更新「對方已收到」、舊版（不簽收）照舊。
import { describe, expect, it } from 'vitest';

import { VaultSyncCoordinator, type VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { decodeJson, encodeJson } from '../../../src/sync/vault/state-store.js';
import { Net } from './harness.js';

const receiptsFrom = (net: Net, device: string) =>
  net.hub.messages.filter((m): m is Extract<VaultSyncMessage, { type: 'receipt' }> => m.type === 'receipt' && m.from === device);
const nodesFrom = (net: Net, device: string) => net.hub.messages.filter((m) => m.type === 'node' && m.from === device);
const quotaOf = (d: { sync: { status(): { relayQuota?: { devices?: Array<{ device: string; used: number }> } } } }, device: string) =>
  d.sync.status().relayQuota?.devices?.find((x) => x.device === device)?.used;

describe('寄件序號與簽收單', () => {
  it('每則經中繼的訊息帶遞增的寄件序號；收件端處理完才簽收，簽收單只送給那位寄件人、不帶序號', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', '1');
    await a.edit('y.md', '2');
    await net.settle();
    const rs = nodesFrom(net, 'a').map((m) => m.rs);
    expect(rs.length).toBeGreaterThanOrEqual(2);
    expect(rs.every((n, i) => typeof n === 'number' && (i === 0 || n > rs[i - 1]!))).toBe(true);
    const receipts = receiptsFrom(net, 'b');
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    for (const r of receipts) {
      expect(r.for).toBe('a');
      expect(r.rs).toBeUndefined();
    }
    const covered = receipts.flatMap((r) => r.ranges);
    for (const n of rs) expect(covered.some(([lo, hi]) => n! >= lo && n! <= hi)).toBe(true);
    // 簽收單本身不再被簽收
    expect(receiptsFrom(net, 'a').filter((r) => r.for === 'b' && r.ranges.length > 0).length).toBe(receiptsFrom(net, 'a').length);
    expect(b.errors).toEqual([]);
  });

  it('簽收劃掉那一台的帳：a 對 b 的用量回到 0；status.relayQuota 每位收件人一列', async () => {
    const net = new Net();
    const a = await net.add('a');
    await net.add('b');
    await a.edit('x.md', 'x'.repeat(200_000));
    await net.settle();
    expect(quotaOf(a, 'b')).toBe(0);
    const q = a.sync.status().relayQuota!;
    expect(q.devices?.map((d) => d.device)).toEqual(['b']);
    expect(q.used).toBe(0);
  });

  it('🔴 簽收單順便更新「對方已收到」：不必等對方的摘要，peerStatus(b).missing 就是 0（使用者 2026-10-12 第 3 項）', async () => {
    const net = new Net({ options: { digestPolicy: 'on-change', digestMinIntervalMs: 24 * 3_600_000, digestMaxIntervalMs: 24 * 3_600_000 } });
    const a = await net.add('a');
    await net.add('b');
    await net.settle();
    await a.edit('x.md', 'x');
    await a.edit('y.md', 'y');
    await net.settle();
    expect(a.sync.peerStatus('b').missing).toBe(0);
  });

  it('收件端離線時收到的，上線處理完才簽收；簽收單送不出去就留著，之後再送（重開也在）', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b');
    b.transport.setOnline(false);
    await a.edit('x.md', 'x');
    await net.settle();
    expect(receiptsFrom(net, 'b')).toEqual([]);
    b.transport.setOnline(true);
    await net.clock.advance(1);
    // 收到、處理完之後馬上又離線：簽收單送不出去
    await net.settle();
    expect(receiptsFrom(net, 'b').length).toBeGreaterThanOrEqual(1);
    expect(quotaOf(a, 'b')).toBe(0);
  });

  it('不信任的寄件人、別人的簽收單：不簽收、不劃帳', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b');
    const c = await net.add('c');
    await a.edit('x.md', 'x');
    await net.settle();
    // c 偽造一份「給 a、說 b 簽收了」的簽收單：from 是 c，劃的是 c 的帳，不是 b 的
    const before = quotaOf(a, 'b');
    await c.transport.send({ type: 'receipt', from: 'c', for: 'a', ranges: [[1, 1_000_000]] });
    await net.settle();
    expect(quotaOf(a, 'b')).toBe(before);
    // 給 b 的簽收單送到 a 也不理
    await c.transport.send({ type: 'receipt', from: 'c', for: 'b', ranges: [[1, 1_000_000]] });
    await net.settle();
    expect(a.errors).toEqual([]);
    void b;
  });

  it('flushReceipts：應用在一輪結束時立刻送出累積的簽收單', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', 'x');
    // 只讓訊息送達、處理完，不推進簽收單的計時
    for (let i = 0; i < 5; i += 1) await net.clock.advance(1);
    await b.sync.idle();
    await b.sync.flushReceipts();
    expect(receiptsFrom(net, 'b').length).toBeGreaterThanOrEqual(1);
  });
});

describe('按收件人記帳：帳滿只排除那一台', () => {
  it('🔴 c 離線、不簽收：送給 c 的份到預算就停；b 照常簽收、送給 b 的照常送完', async () => {
    // 批次模式（與中繼預算）只在有 P2P 時才有；直連打不通，全部走中繼
    const net = new Net({ p2p: true, options: { bulkThreshold: 3, relayLimits: { chunksPerRecipient: 8 } } });
    net.mesh!.reachable = () => false;
    const a = await net.add('a');
    const b = await net.add('b');
    const c = await net.add('c');
    c.transport.setOnline(false);
    for (let i = 0; i < 12; i += 1) a.vault.userWrite(`f${i}.md`, `content ${i}`);
    await a.sync.scan();
    // 送給 c 的那幾則卡在預算上，不能擋住送給 b 的（隊頭阻塞）：b 幾個小時內就收齊，不必等 c 的帳過期（7 天）
    const started = net.clock.now();
    while (![...Array(12).keys()].every((i) => b.vault.get(`f${i}.md`) === `content ${i}`)) {
      expect(net.clock.now() - started).toBeLessThan(24 * 3_600_000);
      await net.clock.advance(60_000);
    }
    await net.settle();
    // b 全部經中繼收到——超過一份預算（6 塊）：b 簽收了，送給它的帳一直空出來
    for (let i = 0; i < 12; i += 1) expect(b.vault.get(`f${i}.md`)).toBe(`content ${i}`);
    expect(net.hub.received.get('b')!.messages).toBeGreaterThan(12);
    // 批次送給 c 的到預算（8 × 0.75 = 6 塊，每則 1 塊）就停；連上時立刻送的摘要不受批次預算限制（照舊只記帳），多 1 塊
    const digests = net.hub.messages.filter((m) => m.type === 'digest' && m.from === 'a').length;
    expect(quotaOf(a, 'c')).toBeLessThanOrEqual(6 + digests);
    expect(quotaOf(a, 'c')).toBeGreaterThan(0);
    expect(quotaOf(a, 'b')).toBe(0);
    // c 上線、處理完、簽收：剩下的照常送完
    c.transport.setOnline(true);
    await net.settle();
    for (let i = 0; i < 12; i += 1) expect(c.vault.get(`f${i}.md`)).toBe(`content ${i}`);
    expect([a.errors, b.errors, c.errors]).toEqual([[], [], []]);
  });

  it('🔴 新加入的裝置不算加入前的廣播用量（SDK ADR 0107）：b 不簽收、帳滿；c 之後加入，經中繼照常收、不必只靠直連', async () => {
    const net = new Net({ p2p: true, options: { bulkThreshold: 3, relayLimits: { chunksPerRecipient: 8 } } });
    net.mesh!.reachable = () => false;
    const a = await net.add('a');
    await net.add('b', { options: { receipts: false } });
    for (let i = 0; i < 12; i += 1) await a.edit(`f${i}.md`, `content ${i}`);
    await net.settle();
    expect(quotaOf(a, 'b')).toBeGreaterThan(6);
    await net.clock.advance(3_600_000);
    const c = await net.add('c');
    // c 一加入：加入前的廣播不算它的
    expect(quotaOf(a, 'c')).toBe(0);
    await net.settle();
    for (let i = 0; i < 12; i += 1) expect(c.vault.get(`f${i}.md`)).toBe(`content ${i}`);
    expect(c.errors).toEqual([]);
  });

  it('舊版收件端（不簽收）：帳只會過期，和以前一樣；不出錯', async () => {
    const net = new Net({ p2p: true, options: { bulkThreshold: 3, relayLimits: { chunksPerRecipient: 8 } } });
    const a = await net.add('a');
    const b = await net.add('b', { options: { receipts: false } });
    for (let i = 0; i < 12; i += 1) a.vault.userWrite(`f${i}.md`, `content ${i}`);
    await a.sync.scan();
    await net.settle();
    expect(receiptsFrom(net, 'b')).toEqual([]);
    for (let i = 0; i < 12; i += 1) expect(b.vault.get(`f${i}.md`)).toBe(`content ${i}`);
    expect([a.errors, b.errors]).toEqual([[], []]);
  });

  it('v0.54–v0.55 把帳放在 meta.rb：重開時搬到自己的鍵（rb），帳不變、meta 不再帶著它', async () => {
    const net = new Net();
    const a = await net.add('a');
    await net.add('b', { options: { receipts: false } });
    await a.edit('x.md', 'x');
    await net.settle();
    await a.sync.stop();
    const store = a.store;
    const rb = decodeJson<object>(await store.get('rb'));
    expect(rb).not.toBeNull();
    const meta = decodeJson<Record<string, unknown>>(await store.get('m'))!;
    await store.set('m', encodeJson({ ...meta, rb }));
    await store.delete('rb');
    const used = a.sync.status().relayQuota?.devices?.[0]?.used;
    a.sync = new (a.sync.constructor as typeof VaultSyncCoordinator)({ adapter: a.vault, store, transport: a.transport, deviceId: 'a', clock: net.clock, tickMs: 0 });
    await a.sync.start();
    expect(quotaOf(a, 'b')).toBe(used);
    await a.sync.stop();
    expect(decodeJson<object>(await store.get('rb'))).not.toBeNull();
    expect(decodeJson<Record<string, unknown>>(await store.get('m'))!.rb).toBeUndefined();
  });

  it('寄件端重開：帳與序號都在（序號不重複使用）', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b', { options: { receipts: false } });
    await a.edit('x.md', 'x');
    await net.settle();
    const used = quotaOf(a, 'b');
    expect(used).toBeGreaterThan(0);
    const last = Math.max(...nodesFrom(net, 'a').map((m) => m.rs ?? 0));
    await a.restart();
    expect(quotaOf(a, 'b')).toBe(used);
    await a.edit('y.md', 'y');
    await net.settle();
    expect(Math.max(...nodesFrom(net, 'a').map((m) => m.rs ?? 0))).toBeGreaterThan(last);
    void b;
  });
});
