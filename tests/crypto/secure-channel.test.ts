// secureChannel（SDK ADR 0010 §2）：在已驗證身分的 PeerChannel 上握手，之後每則都走雙棘輪。
import { afterEach, describe, expect, it } from 'vitest';

import { SecurityDowngradeError } from '../../src/crypto/cinder-ek.js';
import { secureChannel } from '../../src/crypto/secure-channel.js';
import { Identity } from '../../src/identity.js';
import { PeerNode, type PeerChannel } from '../../src/peer/peer-node.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeRtcNetwork } from '../peer/fake-rtc.js';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

const nodes: PeerNode[] = [];
afterEach(() => {
  for (const node of nodes.splice(0)) node.close();
});

/** 經 PeerNode 開一條真的通道（預設走中繼：rtc null） */
async function connected(p2p = false) {
  const transport = new FakeTransport();
  transport.relay = true;
  const network = new FakeRtcNetwork();
  const alice = Identity.generate();
  const bob = Identity.generate();
  const make = (identity: Identity) => {
    const node = new PeerNode({ identity, transport, rtc: p2p ? network.factory : null, connectTimeoutMs: 3_000 });
    nodes.push(node);
    return node;
  };
  const a = make(alice);
  const b = make(bob);
  const incoming = new Promise<PeerChannel>((resolve) => b.onPeer(resolve));
  const toBob = await a.connectPeer(bob.pubkey);
  // 中繼軌要先有一框送到，對方才知道有這條通道：握手的第一則就是那一框
  return { alice, bob, toBob, incoming, transport };
}

describe('secureChannel', () => {
  for (const p2p of [false, true]) {
    it(`握手後雙向送達（${p2p ? 'P2P' : '中繼'}）；線路上看不到明文`, async () => {
      const { alice, bob, toBob, incoming, transport } = await connected(p2p);
      const [aSide, bSide] = await Promise.all([
        secureChannel(toBob, alice),
        incoming.then((channel) => secureChannel(channel, bob)),
      ]);
      expect(aSide.engineType).toBe('double-ratchet');
      expect(aSide.postQuantum).toBe(true);
      expect(bSide.peerPublicKey).toBe(alice.pubkey);

      const got = new Promise<Uint8Array>((resolve) => bSide.onMessage(resolve));
      await aSide.send(text('機密內容'));
      expect(read(await got)).toBe('機密內容');

      const back = new Promise<Uint8Array>((resolve) => aSide.onMessage(resolve));
      await bSide.send(text('收到'));
      expect(read(await back)).toBe('收到');

      if (!p2p) {
        // 中繼上每一框本身已是 NIP-59；這裡再確認：就算拆開 NIP-59，裡面也只有棘輪密文
        const opened = transport.published.map((e) => {
          try {
            return bob.openWrap(e).rumor.content;
          } catch {
            return '';
          }
        });
        const secret = Buffer.from(text('機密內容')).toString('base64');
        expect(opened.some((content) => content.includes(secret))).toBe(false);
      }
    });
  }

  it('後送的一方握手完成後可以立刻先送', async () => {
    const { alice, bob, toBob, incoming } = await connected();
    const [aSide, bSide] = await Promise.all([secureChannel(toBob, alice), incoming.then((c) => secureChannel(c, bob))]);
    const bobIsFirstSender = bob.pubkey > alice.pubkey ? bSide : aSide;
    const other = bobIsFirstSender === bSide ? aSide : bSide;
    const got = new Promise<Uint8Array>((resolve) => other.onMessage(resolve));
    await bobIsFirstSender.send(text('我先'));
    expect(read(await got)).toBe('我先');
  });

  it('🔴 一方要求後量子、另一方不要 → 要求的一方丟 SecurityDowngradeError', async () => {
    const { alice, bob, toBob, incoming } = await connected();
    const results = await Promise.allSettled([
      secureChannel(toBob, alice, { postQuantum: true, handshakeTimeoutMs: 500 }),
      incoming.then((c) => secureChannel(c, bob, { postQuantum: false, handshakeTimeoutMs: 500 })),
    ]);
    expect(results[0].status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(SecurityDowngradeError);
  });

  it('雙方都不要後量子 → 純古典也能通', async () => {
    const { alice, bob, toBob, incoming } = await connected();
    const [aSide, bSide] = await Promise.all([
      secureChannel(toBob, alice, { postQuantum: false }),
      incoming.then((c) => secureChannel(c, bob, { postQuantum: false })),
    ]);
    expect(aSide.postQuantum).toBe(false);
    const got = new Promise<Uint8Array>((resolve) => bSide.onMessage(resolve));
    await aSide.send(text('古典'));
    expect(read(await got)).toBe('古典');
  });

  it('對方一直不握手 → 逾時丟例外', async () => {
    const { alice, toBob } = await connected();
    await expect(secureChannel(toBob, alice, { handshakeTimeoutMs: 100 })).rejects.toThrow(/逾時/);
  });

  it('通道關閉 → 安全通道也關閉，之後不能送', async () => {
    const { alice, bob, toBob, incoming } = await connected();
    const [aSide] = await Promise.all([secureChannel(toBob, alice), incoming.then((c) => secureChannel(c, bob))]);
    let closed = false;
    aSide.onClose(() => {
      closed = true;
    });
    toBob.close();
    expect(closed).toBe(true);
    await expect(aSide.send(text('x'))).rejects.toThrow();
  });
});

describe('安全審查修正（ADR 0010 §5）', () => {
  it('🔴 #2 App 的監聽丟例外，不會讓之後的訊息全部被默默丟掉', async () => {
    const { alice, bob, toBob, incoming } = await connected();
    const [aSide, bSide] = await Promise.all([secureChannel(toBob, alice), incoming.then((c) => secureChannel(c, bob))]);
    const got: string[] = [];
    let first = true;
    bSide.onMessage((m) => {
      got.push(read(m));
      if (first) {
        first = false;
        throw new Error('App 的 bug');
      }
    });
    for (const word of ['one', 'two', 'three']) await aSide.send(text(word));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(got).toEqual(['one', 'two', 'three']);
  });

  it('🔴 #4 雙方都要確認過金鑰才算完成：對方中途放棄時，這邊不會「成功」連到空氣', async () => {
    const { alice, bob, toBob, incoming } = await connected();
    // Bob 要求後量子、Alice 不要：Bob 放棄；Alice 以前會自己宣告成功，現在要等對方確認而逾時
    const results = await Promise.allSettled([
      secureChannel(toBob, alice, { postQuantum: false, handshakeTimeoutMs: 400 }),
      incoming.then((c) => secureChannel(c, bob, { postQuantum: true, handshakeTimeoutMs: 400 })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('🔴 #4 通道的對方就是自己（同一個身分的兩台裝置）→ 拒絕', async () => {
    const me = Identity.generate();
    const fakeChannel = { peerPublicKey: me.pubkey } as unknown as PeerChannel;
    await expect(secureChannel(fakeChannel, me)).rejects.toThrow(/自己/);
  });

  it('#4 公鑰大小寫不一致也分得出誰是 Alice（先正規化）', async () => {
    const me = Identity.generate();
    const fakeChannel = { peerPublicKey: me.pubkey.toUpperCase() } as unknown as PeerChannel;
    await expect(secureChannel(fakeChannel, me)).rejects.toThrow(/自己/);
  });
});
