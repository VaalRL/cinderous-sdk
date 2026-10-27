// 輕量成員的線上格式（SDK ADR 0058）：`want` 的 `fetch` 旗標、只有版本資訊的 `nodes` 訊息；
// `NostrVaultTransport` 依收件人送（`to`）與對某些收件人拿掉內容（`omitContentFor`）——要有 `deviceOf` 才做；
// `VaultWantResponder`：只回應索取、不改任何狀態。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../../src/identity.js';
import { openWrap } from '../../../src/protocol/nip59.js';
import {
  createNostrVaultTransport,
  decodeVaultMessage,
  encodeVaultMessage,
  sha256Hex,
  validateVaultMessage,
  VaultWantResponder,
  type VaultSyncMessage,
  type VaultVersion,
} from '../../../src/sync/vault/index.js';
import { FakeTransport } from '../../fake-transport.js';
import { flush, Net, text } from './harness.js';

const version = (over: Partial<VaultVersion> = {}): VaultVersion => ({
  id: 'b'.repeat(32),
  parents: [],
  path: 'notes/x.md',
  pathAt: 1,
  deleted: false,
  hash: sha256Hex(text('hi')),
  size: 2,
  text: true,
  at: 1,
  device: 'dev-a',
  label: 'A',
  p2p: false,
  ...over,
});

describe('codec：want 的 fetch、nodes 訊息', () => {
  it('來回；舊版的驗證會略過 fetch（只看 items）', () => {
    const want: VaultSyncMessage = { type: 'want', from: 'dev-b', items: [['a'.repeat(32), 'b'.repeat(32)]], fetch: true };
    expect(decodeVaultMessage(encodeVaultMessage(want))).toEqual(want);
    expect(validateVaultMessage({ type: 'want', from: 'dev-b', items: [], fetch: 'yes' })).toEqual({ type: 'want', from: 'dev-b', items: [] });
    const nodes: VaultSyncMessage = { type: 'nodes', from: 'dev-a', items: [['a'.repeat(32), version()], ['c'.repeat(32), version({ id: 'd'.repeat(32), deleted: true, hash: '', size: 0 })]] };
    expect(decodeVaultMessage(encodeVaultMessage(nodes))).toEqual(nodes);
  });

  it('nodes 逐項驗證：空的、壞的 id、危險路徑、帶內容 → 整則丟掉', () => {
    expect(validateVaultMessage({ type: 'nodes', from: 'dev-a', items: [] })).toBeNull();
    expect(validateVaultMessage({ type: 'nodes', from: 'dev-a', items: [['nope', version()]] })).toBeNull();
    expect(validateVaultMessage({ type: 'nodes', from: 'dev-a', items: [['a'.repeat(32), version({ path: '../x' })]] })).toBeNull();
    expect(validateVaultMessage({ type: 'nodes', from: 'dev-a', items: [['a'.repeat(32), version()]], content: text('hi') })).toBeNull();
  });
});

describe('NostrVaultTransport：依收件人送、拿掉內容', () => {
  function setup(withDeviceOf: boolean) {
    const pool = new FakeTransport();
    const [alice, bob, carol] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const ids = new Map([
      [alice.pubkey, 'dev-a'],
      [bob.pubkey, 'dev-b'],
      [carol.pubkey, 'dev-c'],
    ]);
    const t = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey, carol.pubkey], ...(withDeviceOf ? { deviceOf: (pk: string) => ids.get(pk) } : {}) });
    const open = (id: Identity) =>
      pool.published.filter((e) => e.tags.some((tag) => tag[0] === 'p' && tag[1] === id.pubkey)).map((e) => decodeFrame(openWrap(e, id).rumor.content));
    return { pool, t, alice, bob, carol, open };
  }
  const decodeFrame = (content: string) => {
    const frame = JSON.parse(content) as { d: string };
    const bin = atob(frame.d);
    return decodeVaultMessage(Uint8Array.from(bin, (c) => c.charCodeAt(0)))!;
  };
  const withContent: VaultSyncMessage = { type: 'node', from: 'dev-a', fileId: 'a'.repeat(32), node: version(), content: text('hi') };

  it('omitContentFor：那台只收到版本資訊，其他台照常；to：只送給指定的裝置', async () => {
    const { t, bob, carol, open } = setup(true);
    expect(t.targeted).toBe(true);
    await t.send(withContent, { omitContentFor: ['dev-b'] });
    expect(open(bob)).toEqual([{ type: 'node', from: 'dev-a', fileId: 'a'.repeat(32), node: version() }]);
    expect(open(carol)).toEqual([withContent]);
    await t.send({ type: 'want', from: 'dev-a', items: [] }, { to: ['dev-c'] });
    expect(open(bob)).toHaveLength(1);
    expect(open(carol)).toHaveLength(2);
  });

  it('沒有 deviceOf：做不到，照舊全部、完整地送（targeted 是 false）', async () => {
    const { t, bob, carol, open } = setup(false);
    expect(t.targeted).toBe(false);
    await t.send(withContent, { to: ['dev-c'], omitContentFor: ['dev-b'] });
    expect(open(bob)).toEqual([withContent]);
    expect(open(carol)).toEqual([withContent]);
  });
});

describe('VaultWantResponder：只回應索取的常駐訂閱', () => {
  it('讀協調器存下的狀態回應內容索取；不碰磁碟以外的東西、不送摘要；不認得的與沒有內容的略過', async () => {
    const net = new Net({ maxDelayMs: 10 });
    const a = await net.add('a', { options: { peerScopes: { b: ['Daily/'] } } });
    await a.edit('Notes/x.md', 'x 的內容');
    await a.edit('Daily/d.md', 'd');
    const b = await net.add('b', { options: { scope: { content: ['Daily/'] } } });
    await net.settle();
    // a 的協調器停下（排程模式兩輪之間），換成只回應索取的訂閱
    await a.sync.stop();
    const responder = new VaultWantResponder({ store: a.store, adapter: a.vault, transport: a.transport, deviceId: 'a', peerScopes: { b: ['Daily/'] } });
    responder.start();
    const before = net.hub.messages.length;
    const fetching = b.sync.fetch('Notes/x.md');
    await net.settle();
    await flush();
    await net.settle();
    expect(new TextDecoder().decode(await fetching)).toBe('x 的內容');
    const sent = net.hub.messages.slice(before).filter((m) => m.from === 'a');
    expect(sent.map((m) => m.type)).toEqual(['node']);
    expect(responder.stats).toEqual({ answered: 1, skipped: 0 });
    // 不認得的版本：略過
    net.hub.accept('b', { type: 'want', from: 'b', items: [['f'.repeat(32), 'e'.repeat(32)]], fetch: true });
    await net.settle();
    await flush();
    expect(responder.stats).toEqual({ answered: 1, skipped: 1 });
    await responder.stop();
    expect(b.errors).toEqual([]);
  });
});
