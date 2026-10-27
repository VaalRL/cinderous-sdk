// 協調器 × 真的 PeerNode（假 WebRTC、假中繼）× secureChannel（SDK ADR 0026 §5）：
// peerNodeLink 以通道認證的公鑰對應裝置；批次串流跑在雙棘輪上，DataChannel 上看不到明文；
// P2P 打不通時小檔批次走中繼軌（kind 20079，ephemeral），不是 kind 1060。
import { afterEach, describe, expect, it } from 'vitest';

import { secureChannel } from '../../../src/crypto/secure-channel.js';
import { Identity } from '../../../src/identity.js';
import { PeerNode, RELAY_FRAME_KIND } from '../../../src/peer/peer-node.js';
import { FILE_WRAP_KIND } from '../../../src/sync/file-relay.js';
import { peerNodeLink, VaultSyncCoordinator, type VaultSyncMessage, type VaultSyncTransport } from '../../../src/sync/vault/index.js';
import { MemorySyncStateStore } from '../../../src/sync/vault/state-store.js';
import { FakeTransport } from '../../fake-transport.js';
import { FakeRtcNetwork, type FakeDataChannel } from '../../peer/fake-rtc.js';
import { MemoryVault } from './harness.js';

/** 中繼那條（kind 1060）永遠離線：這個測試只看 P2P */
const offline: VaultSyncTransport = {
  send: async () => {
    throw new Error('offline');
  },
  onMessage: () => () => {},
  onStatusChange: () => () => {},
  isOnline: () => false,
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(mode: 'ok' | 'fail', secure: boolean) {
  const relay = new FakeTransport();
  relay.relay = true;
  const network = new FakeRtcNetwork();
  network.mode = mode;
  const ids = { a: Identity.generate(), b: Identity.generate() };
  const devices = { a: ids.a.pubkey, b: ids.b.pubkey };
  const make = (name: 'a' | 'b', vault: MemoryVault) => {
    // 打洞逾時給寬一點：整套測試同時跑時 CPU 滿載，200 ms 會在假的 WebRTC 連上前就改走中繼（'fail' 模式靠 ICE failed 立即改走中繼，不受影響）
    const node = new PeerNode({ identity: ids[name], transport: relay, rtc: network.factory, connectTimeoutMs: 2_000, acceptFrom: (pk) => Object.values(devices).includes(pk) });
    const peers = peerNodeLink({
      node,
      devices,
      ...(secure ? { wrap: (channel) => secureChannel(channel as Parameters<typeof secureChannel>[0], ids[name]) } : {}),
    });
    const sync = new VaultSyncCoordinator({ adapter: vault, store: new MemorySyncStateStore(), transport: offline, deviceId: name, peers, tickMs: 0, stream: { openTimeoutMs: 3_000 } });
    cleanups.push(async () => {
      await sync.stop();
      node.close();
    });
    return { node, sync, vault };
  };
  const a = make('a', new MemoryVault());
  const b = make('b', new MemoryVault());
  await a.sync.start();
  await b.sync.start();
  return { relay, network, a, b };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('逾時');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SECRET = '機密筆記內容-不該出現在線路上';

describe('協調器 × PeerNode', () => {
  it('🔴 P2P＋secureChannel：40 個檔案經批次串流送達；DataChannel 上只有雙棘輪密文', async () => {
    const { network, a, b } = await setup('ok', true);
    for (let i = 0; i < 40; i += 1) a.vault.userWrite(`n/${i}.md`, `${SECRET} ${i}`);
    await a.sync.scan();
    await until(() => b.vault.files.size === 40);
    expect(b.vault.tree()).toEqual(a.vault.tree());
    const frames = network.created.flatMap((pc) => (pc.channel ? (pc.channel as FakeDataChannel).sent : []));
    expect(frames.length).toBeGreaterThan(0);
    const needle = new TextEncoder().encode(SECRET.slice(0, 8));
    const leaked = frames.some((f) => Buffer.from(f).includes(Buffer.from(needle)));
    expect(leaked).toBe(false);
  }, 30_000);

  it('🔴 P2P 打不通：小檔批次走中繼軌（kind 20079，每框 NIP-59），不會發 kind 1060', async () => {
    const { relay, a, b } = await setup('fail', false);
    for (let i = 0; i < 15; i += 1) a.vault.userWrite(`m/${i}.md`, `內容 ${i}`);
    await a.sync.scan();
    await until(() => b.vault.files.size === 15);
    const kinds = new Set(relay.published.map((e) => e.kind));
    expect(kinds.has(RELAY_FRAME_KIND)).toBe(true);
    expect(kinds.has(FILE_WRAP_KIND)).toBe(false);
    // 中繼看不到內容：每框都是 NIP-59
    expect(relay.published.some((e) => e.content.includes('內容'))).toBe(false);
  }, 30_000);

  it('peerNodeLink：名單外的公鑰找上門不理；名單內的對應回 deviceId', async () => {
    const relay = new FakeTransport();
    relay.relay = true;
    const network = new FakeRtcNetwork();
    const me = Identity.generate();
    const friend = Identity.generate();
    const stranger = Identity.generate();
    const mine = new PeerNode({ identity: me, transport: relay, rtc: network.factory, connectTimeoutMs: 200 });
    const link = peerNodeLink({ node: mine, devices: { friend: friend.pubkey } });
    const seen: string[] = [];
    link.onIncoming((device) => seen.push(device));
    const f = new PeerNode({ identity: friend, transport: relay, rtc: network.factory, connectTimeoutMs: 200 });
    const s = new PeerNode({ identity: stranger, transport: relay, rtc: network.factory, connectTimeoutMs: 200 });
    cleanups.push(() => {
      mine.close();
      f.close();
      s.close();
    });
    await f.connectPeer(me.pubkey);
    await s.connectPeer(me.pubkey);
    await until(() => seen.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['friend']);
    expect(link.devices()).toEqual(['friend']);
    expect(await link.open('nobody')).toBeNull();
  }, 30_000);

  it('peerNodeLink 的 devices 可以是函式（SDK ADR 0028）：配對或撤銷後立即生效', async () => {
    const relay = new FakeTransport();
    relay.relay = true;
    const network = new FakeRtcNetwork();
    const me = Identity.generate();
    const friend = Identity.generate();
    let devices: Record<string, string> = {};
    const mine = new PeerNode({ identity: me, transport: relay, rtc: network.factory, connectTimeoutMs: 200 });
    const link = peerNodeLink({ node: mine, devices: () => devices });
    const seen: string[] = [];
    link.onIncoming((device) => seen.push(device));
    const f = new PeerNode({ identity: friend, transport: relay, rtc: network.factory, connectTimeoutMs: 200 });
    cleanups.push(() => {
      mine.close();
      f.close();
    });
    expect(link.devices()).toEqual([]);
    expect(await link.open('friend')).toBeNull();
    devices = { friend: friend.pubkey };
    expect(link.devices()).toEqual(['friend']);
    await f.connectPeer(me.pubkey);
    await until(() => seen.length > 0);
    expect(seen).toEqual(['friend']);
    devices = {};
    expect(await link.open('friend')).toBeNull();
  }, 30_000);
});

// 型別檢查用：VaultSyncMessage 仍是三種（這一批沒有新增中繼上的訊息類型）
const _kinds: VaultSyncMessage['type'][] = ['node', 'digest', 'want'];
void _kinds;
