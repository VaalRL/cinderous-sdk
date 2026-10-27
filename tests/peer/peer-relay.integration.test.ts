// 整合（SDK ADR 0009）：真的 Node 中繼（嚴格平面、要求 NIP-42）＋真的 RelayPool。
// 證明 kind 21000 信令與 kind 20079 中繼框在 Cinderous 的規則下真的收發得到。
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { FRAME_PAYLOAD_BYTES } from '../../src/peer/frames.js';
import { PeerNode, type PeerChannel } from '../../src/peer/peer-node.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { RelayPool } from '../../src/relay-pool.js';
import { FakeRtcNetwork } from './fake-rtc.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function relayUrl(): Promise<string> {
  const port = 40_000 + Math.floor(Math.random() * 2_000);
  const relay = startNodeRelay({ PORT: String(port) }, { memory: true }); // 預設要求 NIP-42
  cleanups.push(() => relay.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  return `ws://127.0.0.1:${port}`;
}

function peer(url: string, identity: Identity, rtc: FakeRtcNetwork | null): PeerNode {
  const pool = new RelayPool({ urls: [url], identity });
  pool.connect();
  const node = new PeerNode({ identity, transport: pool, rtc: rtc ? rtc.factory : null, connectTimeoutMs: 3_000 });
  cleanups.push(() => {
    node.close();
    pool.close();
  });
  return node;
}

const nextPeer = (node: PeerNode) => new Promise<PeerChannel>((resolve) => node.onPeer(resolve));
const nextMessage = (channel: PeerChannel) => new Promise<Uint8Array>((resolve) => channel.onMessage(resolve));
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13) % 256);
const settle = () => new Promise((resolve) => setTimeout(resolve, 500)); // 等 AUTH 與訂閱就緒

describe('PeerNode × 真的中繼', () => {
  it('中繼軌：32 KB 以上的資料經嚴格平面雙向送達', async () => {
    const url = await relayUrl();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const a = peer(url, alice, null);
    const b = peer(url, bob, null);
    await settle();

    const incoming = nextPeer(b);
    const toBob = await a.connectPeer(bob.pubkey);
    const data = bytes(FRAME_PAYLOAD_BYTES * 2 + 123);
    await toBob.send(data);
    const fromAlice = await incoming;
    expect(await nextMessage(fromAlice)).toEqual(data);

    const reply = nextMessage(toBob);
    await fromAlice.send(bytes(7));
    expect(await reply).toEqual(bytes(7));
  }, 15_000);

  it('P2P：offer／answer／ICE 經真的中繼交換後連上', async () => {
    const url = await relayUrl();
    const network = new FakeRtcNetwork();
    const bob = Identity.generate();
    const a = peer(url, Identity.generate(), network);
    const b = peer(url, bob, network);
    await settle();

    const incoming = nextPeer(b);
    const toBob = await a.connectPeer(bob.pubkey);
    expect(toBob.mode).toBe('p2p-webrtc');
    expect((await incoming).mode).toBe('p2p-webrtc');
    // ICE 候選也經中繼送到了對方
    expect(network.created.every((pc) => pc.candidatesAdded.length > 0)).toBe(true);
  }, 15_000);
});
