// 協調器的 Nostr 網路層（SDK ADR 0025 §5）：沿用 kind 1060 外層、新的內層 kind、真的加解密。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../../src/identity.js';
import { openWrap } from '../../../src/protocol/nip59.js';
import type { NostrSigner } from '../../../src/protocol/signer.js';
import { FILE_WRAP_KIND, parseFileChunk, wrapFileChunk } from '../../../src/sync/file-relay.js';
import {
  createNostrVaultTransport,
  frameVaultMessage,
  MemorySyncStateStore,
  VAULT_FRAME_BYTES,
  VAULT_OP_KIND,
  VaultSyncCoordinator,
  type VaultSyncMessage,
} from '../../../src/sync/vault/index.js';
import { FakeTransport } from '../../fake-transport.js';
import { flush, MemoryVault } from './harness.js';

const node = (content?: Uint8Array): VaultSyncMessage => ({
  type: 'node',
  from: 'dev-a',
  fileId: 'a'.repeat(32),
  node: {
    id: 'b'.repeat(32),
    parents: [],
    path: 'notes/x.md',
    pathAt: 1,
    deleted: false,
    hash: 'c'.repeat(64),
    size: 0,
    text: true,
    at: 1,
    device: 'dev-a',
    label: 'A',
    p2p: false,
  },
  ...(content ? { content } : {}),
});

/** 只有三個成員、沒有 nsec 的簽章者（ADR 0023 的測試手法） */
function bareSigner(identity: Identity): NostrSigner {
  return Object.freeze({
    pubkey: identity.pubkey,
    sign: (t: Parameters<Identity['sign']>[0]) => identity.sign(t),
    conversationKey: (pk: string) => identity.conversationKey(pk),
  });
}

describe('NostrVaultTransport', () => {
  it('外層 kind 1060（#p、過期章），內層是新的 kind；舊客戶端的 parseFileChunk 會略過', async () => {
    const pool = new FakeTransport();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const t = createNostrVaultTransport({ pool, signer: bareSigner(alice), devices: [bob.pubkey], now: () => 1_790_000_000_000 });
    await t.send({ type: 'want', from: 'dev-a', items: [['a'.repeat(32), 'b'.repeat(32)]] });
    expect(pool.published).toHaveLength(1);
    const event = pool.published[0]!;
    expect(event.kind).toBe(FILE_WRAP_KIND);
    expect(event.tags).toEqual([
      ['p', bob.pubkey],
      ['expiration', String(1_790_000_000 + 7 * 86_400)],
    ]);
    const opened = openWrap(event, bob);
    expect(opened.rumor.kind).toBe(VAULT_OP_KIND);
    expect(opened.sender).toBe(alice.pubkey);
    expect(parseFileChunk(opened.rumor)).toBeNull();
    // 中繼只看得到密文
    expect(JSON.stringify(event)).not.toContain('dev-a');
  });

  it('大訊息切成多個訊框，收端重組（亂序也行）', async () => {
    const pool = new FakeTransport();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const sender = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey] });
    const receiver = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey] });
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => got.push(m));
    const content = new Uint8Array(VAULT_FRAME_BYTES * 2 + 123).map((_, i) => i % 251);
    const { sha256Hex } = await import('../../../src/sync/vault/graph.js');
    const message = node(content);
    if (message.type === 'node') message.node = { ...message.node, hash: sha256Hex(content), size: content.length, text: false };
    await sender.send(message);
    expect(pool.published).toHaveLength(3);
    for (const e of [...pool.published].reverse()) pool.deliver(e);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(message);
    expect(frameVaultMessage(message)).toHaveLength(3);
  });

  it('🔴 還沒有人監聽時收到的（訂閱一開始補送的積存）：留著，第一個監聽者註冊時依序交給它，不丟（SDK ADR 0075）', async () => {
    const pool = new FakeTransport();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const sender = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey] });
    // 應用先建立傳輸層（訂閱立刻開始），協調器載入狀態後才註冊監聽
    const receiver = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey] });
    const first = node();
    const second: VaultSyncMessage = { type: 'want', from: 'dev-a', items: [['a'.repeat(32), 'b'.repeat(32)]] };
    await sender.send(first);
    await sender.send(second);
    for (const e of pool.published) pool.deliver(e);
    // 同一則重送（例如補拉又拿到）不會交兩次
    for (const e of pool.published) pool.deliver(e);
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => got.push(m));
    await flush();
    expect(got).toEqual([first, second]);
    // 之後收到的照常即時交出；第二個監聽者不會再收到舊的
    const later: VaultSyncMessage[] = [];
    receiver.onMessage((m) => later.push(m));
    pool.published.length = 0;
    await sender.send(first);
    for (const e of pool.published) pool.deliver(e);
    expect(got).toHaveLength(3);
    expect(later).toEqual([first]);
  });

  it('不在信任名單的寄件人、不是協調器訊框的 1060（例如 Cinderous 的檔案塊）一律略過', async () => {
    const pool = new FakeTransport();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const mallory = Identity.generate();
    const receiver = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey] });
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => got.push(m));
    const intruder = createNostrVaultTransport({ pool, signer: mallory, devices: [bob.pubkey] });
    await intruder.send(node());
    for (const e of pool.published) pool.deliver(e);
    pool.deliver(wrapFileChunk({ tid: 't', seq: 0, total: 1, name: 'x.png', mime: 'image/png', data: new Uint8Array([1]) }, alice, bob.pubkey));
    expect(got).toEqual([]);
  });

  it('setDevices（SDK ADR 0028）：配對加入後收送新裝置；撤銷後不再送給它、也不再收它', async () => {
    const pool = new FakeTransport();
    const [alice, bob, carol] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const t = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey] });
    const got: VaultSyncMessage[] = [];
    t.onMessage((m) => got.push(m));
    const fromCarol = createNostrVaultTransport({ pool, signer: carol, devices: [bob.pubkey] });
    await fromCarol.send(node());
    for (const e of pool.published.splice(0)) pool.deliver(e);
    expect(got).toHaveLength(0); // 還不認得 carol
    t.setDevices([alice.pubkey, carol.pubkey]);
    await fromCarol.send(node());
    for (const e of pool.published.splice(0)) pool.deliver(e);
    expect(got).toHaveLength(1);
    await t.send(node());
    expect(pool.published.map((e) => e.tags.find((x) => x[0] === 'p')![1]).sort()).toEqual([alice.pubkey, carol.pubkey].sort());
    pool.published.splice(0);
    t.setDevices([alice.pubkey]); // 撤銷 carol
    await t.send(node());
    expect(pool.published.map((e) => e.tags.find((x) => x[0] === 'p')![1])).toEqual([alice.pubkey]);
    pool.published.splice(0);
    await fromCarol.send(node());
    for (const e of pool.published.splice(0)) pool.deliver(e);
    expect(got).toHaveLength(1);
  });

  it('deviceOf（SDK ADR 0028）：名單上的裝置冒用另一台的 deviceId → 丟掉', async () => {
    const pool = new FakeTransport();
    const [alice, bob] = [Identity.generate(), Identity.generate()];
    const ids: Record<string, string> = { [alice.pubkey]: 'dev-a' };
    const t = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey], deviceOf: (pk) => ids[pk] });
    const got: VaultSyncMessage[] = [];
    t.onMessage((m) => got.push(m));
    const fromAlice = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey] });
    await fromAlice.send(node()); // from: 'dev-a'
    await fromAlice.send({ ...node(), from: 'dev-other' } as VaultSyncMessage);
    for (const e of pool.published.splice(0)) pool.deliver(e);
    expect(got.map((m) => m.from)).toEqual(['dev-a']);
  });

  it('沒有中繼接受 → send 丟例外（協調器會退避重試）；線上狀態跟著連線池', async () => {
    const pool = new FakeTransport();
    pool.accepted = [];
    const alice = Identity.generate();
    const bob = Identity.generate();
    const t = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey] });
    await expect(t.send(node())).rejects.toThrow('沒有中繼接受');

    let statuses = new Map([['wss://r', 'closed' as const]]) as Map<string, 'open' | 'closed' | 'connecting'>;
    const listeners = new Set<(url: string, status: 'open' | 'closed' | 'connecting') => void>();
    const pool2 = Object.assign(new FakeTransport(), {
      status: () => statuses,
      onStatusChange: (l: (url: string, status: 'open' | 'closed' | 'connecting') => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
    });
    const t2 = createNostrVaultTransport({ pool: pool2, signer: alice, devices: [bob.pubkey] });
    const seen: boolean[] = [];
    t2.onStatusChange((o) => seen.push(o));
    expect(t2.isOnline()).toBe(false);
    statuses = new Map([['wss://r', 'open']]);
    for (const l of listeners) l('wss://r', 'open');
    expect(t2.isOnline()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('filters()／ingestEvents()：給 FastHydrator 補拉用，since 往前退讓 NIP-59 倒填窗，重複事件去重', async () => {
    const pool = new FakeTransport();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const receiver = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey], since: 1_000_000 });
    expect(receiver.filters()).toEqual([{ kinds: [FILE_WRAP_KIND], '#p': [bob.pubkey], since: 1_000_000 - 2 * 86_400 }]);
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => got.push(m));
    const sender = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey] });
    await sender.send(node());
    receiver.ingestEvents(pool.published);
    receiver.ingestEvents(pool.published);
    expect(got).toHaveLength(1);
  });
});

describe('兩台裝置經 Nostr（真的加解密）同步', () => {
  it('新增、改名、修改、刪除、並發合併', async () => {
    const pool = new FakeTransport();
    pool.relay = true;
    const ids = [Identity.generate(), Identity.generate()];
    const devices = ids.map((identity, i) => {
      const vault = new MemoryVault();
      const transport = createNostrVaultTransport({ pool, signer: bareSigner(identity), devices: [ids[1 - i]!.pubkey] });
      const sync = new VaultSyncCoordinator({ adapter: vault, store: new MemorySyncStateStore(), transport, deviceId: `dev-${i}`, tickMs: 0 });
      return { vault, sync };
    });
    const settle = async () => {
      for (let i = 0; i < 20; i += 1) {
        await flush();
        for (const d of devices) await d.sync.idle();
      }
    };
    for (const d of devices) await d.sync.start();
    const [a, b] = devices as [(typeof devices)[0], (typeof devices)[0]];

    a.vault.userWrite('n.md', '一\n二\n三');
    await a.sync.notifyLocalChange('n.md', 'create');
    await settle();
    expect(b.vault.get('n.md')).toBe('一\n二\n三');

    a.vault.userRename('n.md', 'dir/n.md');
    await a.sync.notifyLocalChange('dir/n.md', 'rename', 'n.md');
    await settle();
    expect(Object.keys(b.vault.tree())).toEqual(['dir/n.md']);

    // 並發：兩邊同時改不同行（直接改檔再通知，兩則訊息交錯送達）
    a.vault.userWrite('dir/n.md', '一 A\n二\n三');
    b.vault.userWrite('dir/n.md', '一\n二\n三 B');
    await Promise.all([a.sync.notifyLocalChange('dir/n.md'), b.sync.notifyLocalChange('dir/n.md')]);
    await settle();
    expect(a.vault.get('dir/n.md')).toBe('一 A\n二\n三 B');
    expect(b.vault.tree()).toEqual(a.vault.tree());

    b.vault.userRemove('dir/n.md');
    await b.sync.notifyLocalChange('dir/n.md', 'delete');
    await settle();
    expect(a.vault.tree()).toEqual({});
    expect(pool.published.every((e) => e.kind === FILE_WRAP_KIND)).toBe(true);
  });
});

describe('主要中繼連不上時改用備援（SDK ADR 0093）', () => {
  /** 主要中繼一座（關著）、備援一座（只讀，開著）的假連線池 */
  function pools() {
    const published: Array<{ options: unknown }> = [];
    const statusListeners = new Set<() => void>();
    const pool = {
      published,
      publish: async (event: unknown, options?: unknown) => {
        void event;
        published.push({ options });
        return { accepted: ['wss://standby'], rejected: [] };
      },
      subscribe: () => ({ close: () => undefined }),
      status: () => new Map([['wss://primary', 'closed' as const]]),
      onStatusChange: (listener: () => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      relayHealth: () =>
        new Map([
          ['wss://primary', { status: 'closed' as const }],
          ['wss://standby', { status: 'open' as const }],
        ]),
      onRelayHealthChange: () => () => undefined,
      query: async () => [],
      queryOptions: [] as unknown[],
      queryResult: async (filters: unknown, timeoutMs: unknown, options?: unknown) => ({
        _: (pool.queryOptions.push(options), filters, timeoutMs),
        events: [],
        answered: 0,
        relays: [
          { url: 'wss://primary', status: 'not-connected' as const },
          { url: 'wss://standby', status: 'eose' as const, read: true },
        ],
      }),
    };
    return pool;
  }

  it('打開之後備援開著就算在線；送出時主要中繼沒連線也補發到備援；關掉就回到原狀', async () => {
    const pool = pools();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const t = createNostrVaultTransport({
      pool: pool as never,
      signer: bareSigner(alice),
      devices: [bob.pubkey],
      durability: { minAccepted: 1, standby: ['wss://standby'], standbyWhenDisconnected: false },
    });
    const changes: boolean[] = [];
    t.onStatusChange((online) => changes.push(online));
    t.start();
    expect(t.isOnline()).toBe(false);
    t.setStandbyFallback(true);
    expect(t.isOnline()).toBe(true);
    await t.send({ type: 'want', from: 'dev-a', items: [['a'.repeat(32), 'b'.repeat(32)]] });
    expect(pool.published.at(-1)?.options).toMatchObject({ durability: { standbyWhenDisconnected: true } });
    t.setStandbyFallback(false);
    expect(t.isOnline()).toBe(false);
    expect(changes).toEqual([true, false]);
    t.stop();
  });

  it('補拉：打開時備援回完也算回完（起點會前進）；沒打開時照舊只算主要中繼', async () => {
    const pool = pools();
    const alice = Identity.generate();
    const t = createNostrVaultTransport({ pool: pool as never, signer: bareSigner(alice), devices: [], since: 1000 });
    await expect(t.backfill()).rejects.toThrow();
    t.setStandbyFallback(true);
    await expect(t.backfill()).resolves.toBe(0);
    // 改用備援時不等主要中繼開（SDK ADR 0093）
    expect(pool.queryOptions.at(-1)).toEqual({ waitForPrimary: false });
  });
});
