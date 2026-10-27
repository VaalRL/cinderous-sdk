// 星狀會話跑在真的 PeerNode＋secureChannel（雙棘輪）上（SDK ADR 0030）：P2P、中繼退路（kind 20079）、混合；
// 與後量子模式下每則小更新的實際開銷量測（§6）。
import { afterEach, describe, expect, it } from 'vitest';

import { secureChannel } from '../../src/crypto/secure-channel.js';
import { Identity } from '../../src/identity.js';
import { PeerNode, RELAY_FRAME_KIND, type PeerChannel } from '../../src/peer/peer-node.js';
import { StarHost, type StarMessage } from '../../src/star/host.js';
import { StarMember } from '../../src/star/member.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeRtcNetwork } from '../peer/fake-rtc.js';
import { FAST, read, sleep, text, until } from './helpers.js';

const nodes: PeerNode[] = [];
const hosts: StarHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  for (const n of nodes.splice(0)) n.close();
});

function world() {
  const transport = new FakeTransport();
  transport.relay = true;
  const network = new FakeRtcNetwork();
  const node = (identity: Identity, p2p: boolean) => {
    const n = new PeerNode({ identity, transport, rtc: p2p ? network.factory : null, connectTimeoutMs: 3_000, relayFramesPerMinute: 100_000 });
    nodes.push(n);
    return n;
  };
  return { transport, network, node };
}

async function hostWithMembers(modes: boolean[], postQuantum = true) {
  const w = world();
  const hostId = Identity.generate();
  const h = new StarHost({ identity: hostId, tuning: FAST, relayEventsPerMinute: 100_000 });
  hosts.push(h);
  h.listen(w.node(hostId, true), { secure: { postQuantum } });
  const hostGot: StarMessage[] = [];
  h.onMessage((m) => hostGot.push(m));
  const members = [];
  for (const p2p of modes) {
    const identity = Identity.generate();
    const invite = h.createInvite({ relays: ['wss://relay.example'] }).uri;
    const member = await StarMember.join({ identity, node: w.node(identity, p2p), invite, tuning: FAST, relayEventsPerMinute: 100_000, secure: { postQuantum } });
    const got: StarMessage[] = [];
    member.onMessage((m) => got.push(m));
    members.push({ identity, member, got });
  }
  return { ...w, h, hostId, hostGot, members };
}

describe('真的 PeerNode＋雙棘輪', () => {
  it('P2P：3 位成員加入、廣播、寄件人是通道認證的身分', async () => {
    const { h, members, hostGot } = await hostWithMembers([true, true, true]);
    expect(h.members().map((m) => m.mode)).toEqual(['p2p-webrtc', 'p2p-webrtc', 'p2p-webrtc']);
    expect(members[0]!.member.channel.postQuantum).toBe(true);
    members[0]!.member.send(text('yjs-update'));
    await until(() => members[1]!.got.length === 1 && members[2]!.got.length === 1 && hostGot.length === 1);
    expect(members[2]!.got[0]!.from).toBe(members[0]!.identity.pubkey);
  });

  it('🔴 中繼退路（沒有 WebRTC → kind 20079）：加入、轉送、踢出都照常；線路上只有密文', async () => {
    const { h, members, transport, hostGot } = await hostWithMembers([false, false, true]);
    expect(h.members().map((m) => m.mode).sort()).toEqual(['p2p-webrtc', 'relayed-websocket', 'relayed-websocket']);
    const secret = 'CONFIDENTIAL-note-body';
    members[0]!.member.send(text(secret));
    await until(() => members[1]!.got.length === 1 && members[2]!.got.length === 1 && hostGot.length === 1, 5_000);
    expect(read(members[1]!.got[0]!.payload)).toBe(secret);
    const relayEvents = transport.published.filter((e) => e.kind === RELAY_FRAME_KIND);
    expect(relayEvents.length).toBeGreaterThan(0);
    // 就算拆開 NIP-59，裡面也只有棘輪密文
    const b64 = Buffer.from(secret).toString('base64').slice(0, 16);
    expect(JSON.stringify(transport.published)).not.toContain(secret);
    expect(JSON.stringify(transport.published)).not.toContain(b64);

    h.kick(members[1]!.identity.pubkey);
    await until(() => members[1]!.member.closed, 5_000);
    expect(members[1]!.member.endedBy).toEqual({ type: 'ended', reason: 'kicked' });
    members[0]!.member.send(text('after-kick'));
    await until(() => members[2]!.got.length === 2, 5_000);
    await sleep(50);
    expect(members[1]!.got).toHaveLength(1);
  }, 30_000); // 真的雙棘輪加解密＋多台往返，整套平行跑、機器忙時超過預設 5 秒

  it('Host 的 PeerNode 關掉（P2P）：成員收到 host-lost', async () => {
    const { members } = await hostWithMembers([true]);
    const events: unknown[] = [];
    members[0]!.member.onEvent((e) => events.push(e));
    nodes[0]!.close(); // Host 的節點
    await until(() => members[0]!.member.closed, 3_000);
    expect(events.at(-1)).toMatchObject({ type: 'host-lost' });
  });
});

/** 記憶體裡的一對 PeerChannel（在雙棘輪之下），記錄每則的位元組數 */
class CountingChannel implements PeerChannel {
  readonly mode = 'p2p-webrtc' as const;
  readonly isEncrypted = true as const;
  closed = false;
  peer!: CountingChannel;
  readonly sent: number[] = [];
  readonly #listeners = new Set<(d: Uint8Array) => void>();
  readonly #buffered: Uint8Array[] = [];
  constructor(readonly peerPublicKey: string) {}
  async send(data: Uint8Array): Promise<void> {
    this.sent.push(data.length);
    const copy = data.slice();
    setTimeout(() => this.peer.receive(copy), 0);
  }
  receive(d: Uint8Array): void {
    if (this.#listeners.size === 0) this.#buffered.push(d);
    else for (const l of this.#listeners) l(d);
  }
  onMessage(l: (d: Uint8Array) => void): () => void {
    this.#listeners.add(l);
    for (const d of this.#buffered.splice(0)) l(d);
    return () => this.#listeners.delete(l);
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {
    this.closed = true;
  }
  needsLargePayloadWarning(): boolean {
    return false;
  }
}

async function measured(postQuantum: boolean) {
  const hostId = Identity.generate();
  const memberId = Identity.generate();
  const hc = new CountingChannel(memberId.pubkey);
  const mc = new CountingChannel(hostId.pubkey);
  hc.peer = mc;
  mc.peer = hc;
  const [hs, ms] = await Promise.all([secureChannel(hc, hostId, { postQuantum }), secureChannel(mc, memberId, { postQuantum })]);
  const h = new StarHost({ identity: hostId, tuning: { batchWindowMs: 5 } });
  hosts.push(h);
  h.attach(hs);
  const member = await StarMember.over(ms, { invite: h.createInvite({ relays: ['wss://relay.example'] }).uri, tuning: { batchWindowMs: 5 } });
  const hostGot: StarMessage[] = [];
  h.onMessage((m) => hostGot.push(m));
  const got: StarMessage[] = [];
  member.onMessage((m) => got.push(m));
  await sleep(30);

  const update = new Uint8Array(20).fill(1); // 一次按鍵的 Yjs 更新大約 20 B
  let mark = mc.sent.length;
  member.send(update);
  await until(() => hostGot.length === 1);
  const upOne = mc.sent.slice(mark).reduce((a, b) => a + b, 0);

  mark = hc.sent.length;
  h.send(update);
  await until(() => got.length === 1);
  const downOne = hc.sent.slice(mark).reduce((a, b) => a + b, 0);

  mark = mc.sent.length;
  for (let i = 0; i < 50; i += 1) member.send(update); // 同一個批次視窗內的 50 筆
  await until(() => hostGot.length === 51);
  const upBatch = mc.sent.slice(mark).reduce((a, b) => a + b, 0);
  const upBatchMessages = mc.sent.length - mark;
  return { upOne, downOne, upBatch, upBatchMessages };
}

describe('後量子開銷量測（ADR 0030 §6；ADR 0033 線路格式 v2）', () => {
  it('PQ：一則 20 B 更新 131 B（成員→Host）、170 B（Host→每位成員）；50 筆合併一包 1,503 B（v0.27 分別是 2,395／2,434／3,767 B）', async () => {
    const pq = await measured(true);
    expect(pq).toEqual({ upOne: 131, downOne: 170, upBatch: 1_503, upBatchMessages: 1 });
  });

  it('古典：同樣的量測 122／161／1,494 B', async () => {
    const classic = await measured(false);
    expect(classic).toEqual({ upOne: 122, downOne: 161, upBatch: 1_494, upBatchMessages: 1 });
  });
});
