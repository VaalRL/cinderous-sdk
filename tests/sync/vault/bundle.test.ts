// 小檔合併（SDK ADR 0095）：同一組收件人、佇列裡兩個以上的小版本，連同內容合成一則 `bundle`，一則不超過一個訊框（48 KB）。
// 只送給宣告看得懂的裝置（`bundleDevices`）；名單上還有看不懂的，給它的照舊一則一則送。
import { describe, expect, it } from 'vitest';

import {
  BUNDLE_CAPABILITY,
  decodeVaultMessage,
  encodedVaultMessageLength,
  encodeVaultMessage,
  sha256Hex,
  validateVaultMessage,
  VAULT_FRAME_BYTES,
  type VaultSyncMessage,
  type VaultSyncOptions,
  type VaultVersion,
} from '../../../src/sync/vault/index.js';
import { type Device, MemoryVault, Net, text } from './harness.js';

const version = (body: string, over: Partial<VaultVersion> = {}): VaultVersion => ({
  id: 'b'.repeat(32),
  parents: [],
  path: 'notes/x.md',
  pathAt: 1,
  deleted: false,
  hash: sha256Hex(text(body)),
  size: text(body).length,
  text: true,
  at: 1,
  device: 'dev-a',
  label: 'A',
  p2p: false,
  ...over,
});

describe('codec：bundle', () => {
  const bundle: VaultSyncMessage = {
    type: 'bundle',
    from: 'dev-a',
    items: [
      { fileId: 'a'.repeat(32), node: version('one'), content: text('one') },
      { fileId: 'c'.repeat(32), node: version('', { id: 'd'.repeat(32), path: 'gone.md', deleted: true, hash: '', size: 0 }) },
      { fileId: 'e'.repeat(32), node: version('三', { id: 'f'.repeat(32), path: 'notes/三.md' }), content: text('三') },
    ],
  };

  it('🔴 來回：每一項的版本與內容都還原；刪除的那一項沒有內容', () => {
    expect(decodeVaultMessage(encodeVaultMessage(bundle))).toEqual(bundle);
    expect(encodedVaultMessageLength(bundle)).toBe(encodeVaultMessage(bundle).length);
  });

  it('🔴 逐項驗證：內容雜湊不符、刪除卻帶內容、危險路徑、空的 → 整則丟掉', () => {
    const items = (bundle as Extract<VaultSyncMessage, { type: 'bundle' }>).items;
    expect(validateVaultMessage({ ...bundle, items: [{ ...items[0]!, content: text('two') }] })).toBeNull();
    expect(validateVaultMessage({ ...bundle, items: [{ ...items[1]!, content: text('x') }] })).toBeNull();
    expect(validateVaultMessage({ ...bundle, items: [{ ...items[0]!, node: version('one', { path: '../x' }) }] })).toBeNull();
    expect(validateVaultMessage({ ...bundle, items: [] })).toBeNull();
    // 標頭宣告的長度跟後面的位元組對不上
    const bytes = encodeVaultMessage(bundle);
    expect(decodeVaultMessage(bytes.subarray(0, bytes.length - 1))).toBeNull();
  });

  it('能力名稱固定（名單上的宣告）', () => {
    expect(BUNDLE_CAPABILITY).toBe('vaultBundles');
  });
});

const ALL: Partial<VaultSyncOptions> = { bundleDevices: ['a', 'b', 'c'] };

async function trio(options: Array<Partial<VaultSyncOptions>>) {
  // 延遲 0：訊息照送出的順序到（摘要不會比內容先到而引起索取、重送）
  const net = new Net({ seed: 3, maxDelayMs: 0 });
  const list: Device[] = [];
  for (const [i, name] of ['a', 'b', 'c'].entries()) list.push(await net.add(name, { options: options[i] ?? {} }));
  await net.settle();
  return { net, list };
}

/** a 離線時改好幾個檔，再上線（佇列裡一次有好幾項） */
async function editOffline(net: Net, a: Device, files: Record<string, string>) {
  a.transport.setOnline(false);
  for (const [path, body] of Object.entries(files)) {
    await a.edit(path, body);
    await net.clock.advance(10);
  }
  a.transport.setOnline(true);
  await net.settle();
}

const small = (n: number, size = 200) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`notes/n${i}.md`, `# ${i}\n${'x'.repeat(size)}`]));

describe('協調器：小檔合併', () => {
  it('🔴 每台都看得懂：好幾個小檔合成一則 bundle，其他裝置都收到', async () => {
    const { net, list } = await trio([ALL, ALL, ALL]);
    const [a] = list as [Device, Device, Device];
    await editOffline(net, a, small(8));
    const fromA = net.hub.messages.filter((m) => m.from === 'a' && (m.type === 'node' || m.type === 'bundle'));
    expect(fromA.filter((m) => m.type === 'node')).toEqual([]);
    expect(fromA.filter((m) => m.type === 'bundle')).toHaveLength(1);
    const trees = net.trees();
    expect(trees[1]).toEqual(trees[0]);
    expect(trees[2]).toEqual(trees[0]);
    expect(Object.keys(trees[0]!)).toHaveLength(8);
    expect(await a.sync.whenSent({ timeoutMs: 1 })).toMatchObject({ state: 'sent', queue: 0 });
  });

  it('🔴 一則不超過一個訊框：裝不下的留給下一則', async () => {
    const { net, list } = await trio([ALL, ALL, ALL]);
    await editOffline(net, list[0]!, small(30, 3_000));
    const bundles = net.hub.messages.filter((m) => m.from === 'a' && m.type === 'bundle');
    expect(bundles.length).toBeGreaterThanOrEqual(2);
    for (const m of bundles) expect(encodedVaultMessageLength(m)).toBeLessThanOrEqual(VAULT_FRAME_BYTES);
    const paths = new Set(bundles.flatMap((m) => (m.type === 'bundle' ? m.items.map((item) => item.node.path) : [])));
    expect(paths.size).toBe(30);
    expect(net.trees()[1]).toEqual(net.trees()[0]);
  });

  it('🔴 比一個訊框大的檔照舊單獨一則；其他小檔照樣合', async () => {
    const { net, list } = await trio([ALL, ALL, ALL]);
    await editOffline(net, list[0]!, { ...small(4), 'big.md': 'y'.repeat(60_000) });
    const fromA = net.hub.messages.filter((m) => m.from === 'a');
    expect(fromA.some((m) => m.type === 'node' && m.node.path === 'big.md')).toBe(true);
    expect(fromA.some((m) => m.type === 'bundle' && m.items.some((item) => item.node.path === 'big.md'))).toBe(false);
    expect(fromA.filter((m) => m.type === 'bundle')).toHaveLength(1);
    expect(net.trees()[2]).toEqual(net.trees()[0]);
  });

  it('🔴 有一台看不懂（沒宣告）：廣播的版本照舊一則一則送，舊版那台照樣收到', async () => {
    const PARTIAL: Partial<VaultSyncOptions> = { bundleDevices: ['a', 'b'] };
    const { net, list } = await trio([PARTIAL, PARTIAL, {}]);
    await editOffline(net, list[0]!, small(5));
    expect(net.hub.messages.some((m) => m.type === 'bundle')).toBe(false);
    expect(net.trees()[2]).toEqual(net.trees()[0]);
  });

  it('沒設定 bundleDevices（預設）：行為跟以前一樣', async () => {
    const { net, list } = await trio([{}, {}, {}]);
    await editOffline(net, list[0]!, small(5));
    expect(net.hub.messages.some((m) => m.type === 'bundle')).toBe(false);
    expect(net.trees()[1]).toEqual(net.trees()[0]);
  });

  it('只有一個小版本：照舊送 node（不必包）', async () => {
    const { net, list } = await trio([ALL, ALL, ALL]);
    await editOffline(net, list[0]!, small(1));
    expect(net.hub.messages.some((m) => m.type === 'bundle')).toBe(false);
    expect(net.trees()[1]).toEqual(net.trees()[0]);
  });

  it('執行中改宣告（名單變了）：setBundleDevices 之後才合', async () => {
    const { net, list } = await trio([{}, {}, {}]);
    const a = list[0]!;
    a.sync.setBundleDevices(['a', 'b', 'c']);
    await editOffline(net, a, small(4));
    expect(net.hub.messages.filter((m) => m.from === 'a' && m.type === 'bundle')).toHaveLength(1);
    expect(net.trees()[2]).toEqual(net.trees()[0]);
  });
});

describe('限速補送：一包算一則（SDK ADR 0095）', () => {
  it('🔴 P2P 打不通、120 個小檔要經中繼補送：每小時 20 則的限速下，一小時內就補完（沒合的時候要好幾個小時）', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 20, bundleDevices: ['a', 'b'] } });
    net.mesh!.reachable = () => false;
    const vault = new MemoryVault();
    for (let i = 0; i < 120; i += 1) vault.userWrite(`notes/${i % 20}/n-${i}.md`, `# ${i}\n內容 ${i}\n`);
    const a = await net.add('a', { vault, online: false });
    const sent: VaultSyncMessage['type'][] = [];
    const send = a.transport.send.bind(a.transport);
    a.transport.send = async (message, options) => {
      await send(message, options);
      sent.push(message.type);
    };
    const b = await net.add('b');
    const t0 = net.clock.now();
    a.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(net.clock.now() - t0).toBeLessThan(3_600_000);
    expect(sent.filter((type) => type === 'bundle').length).toBeLessThanOrEqual(20);
    expect(sent.filter((type) => type === 'node').length).toBeLessThan(10);
    expect(a.errors).toEqual([]);
  });
});

describe('有一台積壓時也合（SDK ADR 0096：照實際的收件人與欠款分組）', () => {
  it('🔴 c 新加入、積壓（P2P 打不通、每小時只補 1 則）：a 新改的幾篇照常合成一則即時送給 b；給 c 的積壓也是一則一則「包」補送', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 1, bundleDevices: ['a', 'b', 'c'] } });
    const vault = new MemoryVault();
    // 每篇約 4 KB：一則只裝得下十幾篇，c 會積壓好幾個小時
    for (let i = 0; i < 60; i += 1) vault.userWrite(`notes/${i % 20}/n-${i}.md`, `# ${i}
${'內容'.repeat(700)}
`);
    const a = await net.add('a', { vault });
    const b = await net.add('b');
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    net.mesh!.reachable = () => false;
    const c = await net.add('c');
    for (let i = 0; i < 60 && !a.sync.status().bulk; i += 1) await net.clock.advance(60_000);
    expect(a.sync.status().bulk).toBe(true);
    const sent: Array<{ type: VaultSyncMessage['type']; items: number; to: string }> = [];
    const send = a.transport.send.bind(a.transport);
    a.transport.send = async (message, options) => {
      await send(message, options);
      sent.push({ type: message.type, items: message.type === 'bundle' ? message.items.length : 1, to: (options?.to ?? ['all']).join(',') });
    };
    // 一次改好幾篇（外掛的改檔通知會防抖、一起進佇列；這裡以短暫離線模擬）
    a.transport.setOnline(false);
    for (let i = 0; i < 5; i += 1) await a.edit(`fresh/${i}.md`, `剛改的 ${i}`);
    a.transport.setOnline(true);
    for (let i = 0; i < 6; i += 1) await net.clock.advance(10_000);
    for (let i = 0; i < 5; i += 1) expect(b.vault.get(`fresh/${i}.md`)).toBe(`剛改的 ${i}`);
    // 給 b 的新修改：合成一則（不是一篇一則），不被 c 的積壓拖住
    const toB = sent.filter((m) => m.to === 'b' && (m.type === 'node' || m.type === 'bundle'));
    expect(toB).toHaveLength(1);
    expect(toB[0]?.type).toBe('bundle');
    expect(toB.reduce((n, m) => n + m.items, 0)).toBe(5);
    // 給 c 的積壓：每一則限速名額都裝滿一包（不是一則一篇）
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
    const toC = sent.filter((m) => m.to === 'c' && (m.type === 'node' || m.type === 'bundle'));
    expect(toC.filter((m) => m.type === 'bundle').length).toBeGreaterThan(0);
    expect(toC.length).toBeLessThan(15);
    expect(a.errors).toEqual([]);
  });
});
