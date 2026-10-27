// `PeerNode`／`connectPeer`（SDK ADR 0009）：NIP-59 信令、DataChannel、打不通就改走中繼。
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { FRAME_PAYLOAD_BYTES, RELAY_FRAME_PAYLOAD_BYTES } from '../../src/peer/frames.js';
import { LARGE_PAYLOAD_WARNING_BYTES, PeerNode, type PeerChannel, RELAY_FRAME_KIND, type PeerNodeOptions } from '../../src/peer/peer-node.js';
import { SDP_SIGNAL_KIND } from '../../src/protocol/index.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeRtcNetwork } from './fake-rtc.js';

const nodes: PeerNode[] = [];
afterEach(() => {
  for (const node of nodes.splice(0)) node.close();
});

function setup(options: Partial<PeerNodeOptions> = {}) {
  const transport = new FakeTransport();
  transport.relay = true; // 發布即轉給所有訂閱者，模擬大家連著同一座中繼
  const network = new FakeRtcNetwork();
  const alice = Identity.generate();
  const bob = Identity.generate();
  const make = (identity: Identity) => {
    const node = new PeerNode({ identity, transport, rtc: network.factory, connectTimeoutMs: 3_000, ...options });
    nodes.push(node);
    return node;
  };
  return { transport, network, alice, bob, a: make(alice), b: make(bob) };
}

const nextPeer = (node: PeerNode) => new Promise<PeerChannel>((resolve) => node.onPeer(resolve));
const nextMessage = (channel: PeerChannel) => new Promise<Uint8Array>((resolve) => channel.onMessage(resolve));
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 256);

describe('打洞成功：P2P', () => {
  it('connectPeer 拿到 p2p 通道；對方的 onPeer 也拿到；大訊息雙向完整送達', async () => {
    const { a, b, bob, alice } = setup();
    const incoming = nextPeer(b);
    const toBob = await a.connectPeer(bob.pubkey);
    const fromAlice = await incoming;

    expect(toBob.mode).toBe('p2p-webrtc');
    expect(fromAlice.mode).toBe('p2p-webrtc');
    expect(fromAlice.peerPublicKey).toBe(alice.pubkey);
    expect(toBob.isEncrypted).toBe(true);

    const data = bytes(FRAME_PAYLOAD_BYTES * 2 + 10);
    const received = nextMessage(fromAlice);
    await toBob.send(data);
    expect(await received).toEqual(data);

    const reply = nextMessage(toBob);
    await fromAlice.send(bytes(3));
    expect(await reply).toEqual(bytes(3));
  });

  it('🔴 信令是 kind 21000 的 NIP-59：外層看不出寄件人，第三者解不開', async () => {
    const { a, transport, alice, bob } = setup();
    await a.connectPeer(bob.pubkey);
    const signals = transport.published.filter((e) => e.kind === SDP_SIGNAL_KIND);
    expect(signals.length).toBeGreaterThan(0);
    for (const event of signals) {
      expect(event.pubkey).not.toBe(alice.pubkey);
      expect(event.pubkey).not.toBe(bob.pubkey);
    }
    const offer = signals.find((e) => e.tags.some((t) => t[0] === 'p' && t[1] === bob.pubkey))!;
    expect(() => Identity.generate().openWrap(offer)).toThrow();
  });

  it('多座中繼重複送達同一則信令，不會多開連線', async () => {
    const { a, b, transport, bob, network } = setup();
    const original = transport.deliver.bind(transport);
    transport.deliver = (event) => {
      original(event);
      original(event);
    };
    const incoming = nextPeer(b);
    await a.connectPeer(bob.pubkey);
    await incoming;
    expect(network.created).toHaveLength(2); // 一邊一條，沒有因為重複的 offer 多開
  });

  it('同時互相呼叫（glare）：最後雙方各只剩一條、互相連得上', async () => {
    const { a, b, alice, bob } = setup();
    const [toBob, toAlice] = await Promise.all([a.connectPeer(bob.pubkey), b.connectPeer(alice.pubkey)]);
    expect(toBob.mode).toBe('p2p-webrtc');
    expect(toAlice.mode).toBe('p2p-webrtc');
    const received = nextMessage(toAlice);
    await toBob.send(bytes(5));
    expect(await received).toEqual(bytes(5));
  });
});

describe('打不通：改走中繼（PRD 2.3）', () => {
  it('ICE failed → 雙方都改走中繼；資料以 kind 20079 的 NIP-59 送達', async () => {
    const { a, b, network, transport, alice, bob } = setup();
    network.mode = 'fail';
    const incoming = nextPeer(b);
    const toBob = await a.connectPeer(bob.pubkey);
    expect(toBob.mode).toBe('relayed-websocket');

    // 中繼軌每框 48,000 B（ADR 0006；ADR 0009 更正）：比 DataChannel 的 16 KB 大
    const data = bytes(RELAY_FRAME_PAYLOAD_BYTES + 1);
    await toBob.send(data);
    const fromAlice = await incoming;
    expect(fromAlice.mode).toBe('relayed-websocket');
    const frames = transport.published.filter((e) => e.kind === RELAY_FRAME_KIND);
    expect(frames).toHaveLength(2);
    // 包兩層 NIP-44 之後仍遠低於中繼的單則上限（262,144 B）
    expect(Math.max(...frames.map((e) => JSON.stringify(e).length))).toBeLessThan(262_144);
    expect(frames.every((e) => e.pubkey !== alice.pubkey)).toBe(true); // 中繼看不出是誰傳的
    expect(frames.every((e) => e.tags.some((t) => t[0] === 'p' && t[1] === bob.pubkey))).toBe(true);
  });

  it('中繼通道雙向送得通，大訊息組得回來', async () => {
    const { a, b, network, bob } = setup();
    network.mode = 'fail';
    const incoming = nextPeer(b);
    const toBob = await a.connectPeer(bob.pubkey);
    const first = bytes(RELAY_FRAME_PAYLOAD_BYTES * 2 + 7);
    await toBob.send(first);
    const fromAlice = await incoming;
    // 第一則在 onPeer 之前就到了：通道要先收著，註冊 onMessage 時交出來
    expect(await nextMessage(fromAlice)).toEqual(first);
    const reply = nextMessage(toBob);
    await fromAlice.send(bytes(9));
    expect(await reply).toEqual(bytes(9));
  });

  it('ICE 一直卡著 → 逾時後改走中繼', async () => {
    const { a, network, bob } = setup({ connectTimeoutMs: 50 });
    network.mode = 'hang';
    const started = Date.now();
    const toBob = await a.connectPeer(bob.pubkey);
    expect(toBob.mode).toBe('relayed-websocket');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('rtc: null（環境沒有 WebRTC）→ 直接走中繼，不送任何 SDP', async () => {
    const { a, transport, bob } = setup({ rtc: null });
    const toBob = await a.connectPeer(bob.pubkey);
    expect(toBob.mode).toBe('relayed-websocket');
    expect(transport.published.filter((e) => e.kind === SDP_SIGNAL_KIND)).toHaveLength(0);
  });

  it('重複送達的框不會讓訊息交出兩次', async () => {
    const { a, b, transport, bob } = setup({ rtc: null });
    const original = transport.deliver.bind(transport);
    transport.deliver = (event) => {
      original(event);
      original(event);
    };
    const incoming = nextPeer(b);
    const toBob = await a.connectPeer(bob.pubkey);
    const got: Uint8Array[] = [];
    await toBob.send(bytes(4));
    (await incoming).onMessage((m) => got.push(m));
    await toBob.send(bytes(6));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(got).toEqual([bytes(4), bytes(6)]);
  });

  it('中繼拒收 → send 丟例外（不能默默丟資料）', async () => {
    const { a, transport, bob } = setup({ rtc: null });
    const toBob = await a.connectPeer(bob.pubkey);
    transport.accepted = [];
    await expect(toBob.send(bytes(1))).rejects.toThrow(/中繼/);
  });

  it('中繼軌依每分鐘框數限速（Cinderous 中繼超過會斷線）', async () => {
    const waits: number[] = [];
    const { a, bob } = setup({
      rtc: null,
      relayFramesPerMinute: 2,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const toBob = await a.connectPeer(bob.pubkey);
    await toBob.send(bytes(RELAY_FRAME_PAYLOAD_BYTES * 2 + 1)); // 3 框
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(0);
  });
});

describe('其他', () => {
  it('acceptFrom 拒絕的人：不回應、不出現在 onPeer', async () => {
    const { a, network, bob } = setup({ acceptFrom: () => false, connectTimeoutMs: 50 });
    let offered = false;
    nodes[1]!.onPeer(() => {
      offered = true;
    });
    await a.connectPeer(bob.pubkey);
    expect(network.created).toHaveLength(1); // bob 沒有建立連線
    expect(offered).toBe(false);
  });

  it('needsLargePayloadWarning：只有走中繼且超過 20 MB 才要提示', async () => {
    const relayed = await setup({ rtc: null }).a.connectPeer(Identity.generate().pubkey);
    expect(relayed.needsLargePayloadWarning(LARGE_PAYLOAD_WARNING_BYTES + 1)).toBe(true);
    expect(relayed.needsLargePayloadWarning(LARGE_PAYLOAD_WARNING_BYTES)).toBe(false);
    const s = setup();
    const direct = await s.a.connectPeer(s.bob.pubkey);
    expect(direct.needsLargePayloadWarning(LARGE_PAYLOAD_WARNING_BYTES * 10)).toBe(false);
  });

  it('關掉通道：onClose 被叫、之後 send 丟例外', async () => {
    const { a, bob } = setup();
    const toBob = await a.connectPeer(bob.pubkey);
    let closed = false;
    toBob.onClose(() => {
      closed = true;
    });
    toBob.close();
    expect(closed).toBe(true);
    await expect(toBob.send(bytes(1))).rejects.toThrow();
  });

  it('不能連自己', async () => {
    const { a, alice } = setup();
    await expect(a.connectPeer(alice.pubkey)).rejects.toThrow();
  });
});
