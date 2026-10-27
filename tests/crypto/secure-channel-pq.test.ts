// secureChannel 的後量子線路格式協商（SDK ADR 0033 §5）與通道層的降級防護（§6）。
// 用記憶體裡的一對 PeerChannel，可以攔截、竄改、丟掉任何一框；「舊版對端」照 v0.27 的握手手刻。
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { SecurityDowngradeError } from '../../src/crypto/cinder-ek.js';
import { DoubleRatchetSession, generateRatchetKeyPair } from '../../src/crypto/double-ratchet.js';
import { secureChannel, UnsupportedRatchetVersionError } from '../../src/crypto/secure-channel.js';
import { Identity } from '../../src/identity.js';
import type { PeerChannel } from '../../src/peer/peer-node.js';
import { encodePqPublicKey, generatePqSeed, pqKeyFromSeed } from '../../src/protocol/index.js';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Filter = (data: Uint8Array) => Uint8Array | null;

/** 記憶體裡的一對 PeerChannel；`filter` 可以改掉或丟掉（回 null）送出的每一框 */
class MemoryChannel implements PeerChannel {
  readonly mode = 'p2p-webrtc' as const;
  readonly isEncrypted = true as const;
  closed = false;
  peer!: MemoryChannel;
  filter: Filter = (d) => d;
  readonly sent: Uint8Array[] = [];
  readonly #listeners = new Set<(d: Uint8Array) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #buffered: Uint8Array[] = [];
  constructor(readonly peerPublicKey: string) {}
  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('closed');
    this.sent.push(data.slice());
    const out = this.filter(data.slice());
    if (out) setTimeout(() => this.peer.receive(out), 0);
  }
  receive(d: Uint8Array): void {
    if (this.closed) return;
    if (this.#listeners.size === 0) this.#buffered.push(d);
    else for (const l of [...this.#listeners]) l(d);
  }
  onMessage(l: (d: Uint8Array) => void): () => void {
    this.#listeners.add(l);
    for (const d of this.#buffered.splice(0)) l(d);
    return () => this.#listeners.delete(l);
  }
  onClose(l: () => void): () => void {
    this.#closeListeners.add(l);
    return () => this.#closeListeners.delete(l);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.#closeListeners]) l();
    this.peer.close();
  }
  needsLargePayloadWarning(): boolean {
    return false;
  }
}

function channels() {
  const a = Identity.generate();
  const b = Identity.generate();
  const toB = new MemoryChannel(b.pubkey);
  const toA = new MemoryChannel(a.pubkey);
  toB.peer = toA;
  toA.peer = toB;
  return { a, b, toB, toA };
}

const isHello = (d: Uint8Array) => d[0] === 1;
const helloOf = (d: Uint8Array) => JSON.parse(read(d.subarray(1))) as Record<string, unknown>;
const ratchetFlags = (d: Uint8Array) => (d[0] === 2 && d[1] === 3 ? d[1 + 41]! : 0);

/**
 * v0.27 的對端（手刻）：hello 不帶 `pqf`；握手公式與 v0.27 相同。
 * 古典模式下它的線路格式與本版一模一樣，所以可以用本版的 `DoubleRatchetSession`（古典路徑沒有改）。
 */
function legacyPeer(channel: PeerChannel, identity: Identity, opts: { kem: boolean }) {
  const peer = channel.peerPublicKey;
  const iAmAlice = identity.pubkey < peer;
  const ephemeral = generateRatchetKeyPair();
  const kem = opts.kem ? pqKeyFromSeed(generatePqSeed()) : undefined;
  const helloBytes = utf8ToBytes(JSON.stringify({ v: 1, dh: bytesToHex(ephemeral.publicKey), ...(kem ? { kem: encodePqPublicKey(kem.pk) } : {}) }));
  const received: string[] = [];
  let session: DoubleRatchetSession | undefined;
  let confirmed = false;
  const sendRatchet = async (payload: Uint8Array) => {
    const env = await session!.encrypt(payload);
    await channel.send(concatBytes(new Uint8Array([2]), env.header, env.ciphertext));
  };
  channel.onMessage(async (bytes) => {
    if (bytes[0] === 1 && !session) {
      const hello = JSON.parse(read(bytes.subarray(1))) as { dh: string };
      const peerEph = hexToBytes(hello.dh);
      const dhOut = secp256k1.getSharedSecret(ephemeral.secretKey, concatBytes(new Uint8Array([2]), peerEph)).subarray(1, 33);
      const [aliceHello, bobHello] = iAmAlice ? [helloBytes, bytes.subarray(1)] : [bytes.subarray(1), helloBytes];
      const sharedSecret = hkdf(sha256, concatBytes(identity.conversationKey(peer), dhOut), utf8ToBytes('cinderous/dr/v1/handshake'), sha256(concatBytes(aliceHello, bobHello)), 32);
      const [alicePk, bobPk] = iAmAlice ? [identity.pubkey, peer] : [peer, identity.pubkey];
      const associatedData = concatBytes(utf8ToBytes('cinderous/dr/v1'), hexToBytes(alicePk), hexToBytes(bobPk));
      const common = { sharedSecret, associatedData, peerPublicKey: peer };
      session = iAmAlice
        ? DoubleRatchetSession.initAlice({ ...common, bobRatchetPublicKey: peerEph })
        : DoubleRatchetSession.initBob({ ...common, ratchetKeyPair: ephemeral });
      if (iAmAlice) await sendRatchet(new Uint8Array([0]));
      return;
    }
    if (bytes[0] === 2 && session) {
      const plaintext = await session.decrypt({ engineType: 'double-ratchet', header: bytes.slice(1, 42), ciphertext: bytes.slice(42) });
      if (!confirmed) {
        confirmed = true;
        if (!iAmAlice) await sendRatchet(new Uint8Array([0]));
      }
      if (plaintext[0] === 1) received.push(read(plaintext.subarray(1)));
    }
  });
  void channel.send(concatBytes(new Uint8Array([1]), helloBytes));
  return { received, send: (s: string) => sendRatchet(concatBytes(new Uint8Array([1]), text(s))) };
}

describe('secureChannel：後量子線路格式協商（ADR 0033 §5）', () => {
  it('hello 宣告 pqf [2]；雙方都是本版 → 用 v2 格式，資料訊息的 header 只有 50 B', async () => {
    const { a, b, toB, toA } = channels();
    const [aSide, bSide] = await Promise.all([secureChannel(toB, a), secureChannel(toA, b)]);
    expect(helloOf(toB.sent.find(isHello)!).pqf).toEqual([2]);
    expect(aSide.postQuantum).toBe(true);
    const got = new Promise<Uint8Array>((resolve) => bSide.onMessage(resolve));
    const mark = toB.sent.length;
    await aSide.send(text('hi'));
    expect(read(await got)).toBe('hi');
    const frame = toB.sent[mark]!;
    expect(frame[1]).toBe(3); // header 版本 3＝後量子 v2
    expect(frame.length).toBeLessThan(1 + 50 + 24 + 16 + 3 + 1200); // 至多再附一把公鑰
  });

  it('🔴 v0.27 的對端（hello 有 ML-KEM、沒有 pqf）且要後量子 → 丟 UnsupportedRatchetVersionError，不退回舊格式或古典', async () => {
    const { a, b, toB, toA } = channels();
    legacyPeer(toA, b, { kem: true });
    const error = await secureChannel(toB, a, { handshakeTimeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedRatchetVersionError);
    expect((error as UnsupportedRatchetVersionError).peerFormats).toEqual([]);
    expect((error as Error).message).toMatch(/0\.28\.0/);
  });

  it('🔴 中間人把對方 hello 的 pqf 拿掉 → 同樣明確拒絕（不會被降到舊格式）', async () => {
    const { a, b, toB, toA } = channels();
    toA.filter = (d) => {
      if (!isHello(d)) return d;
      const hello = helloOf(d);
      delete hello.pqf;
      return concatBytes(new Uint8Array([1]), utf8ToBytes(JSON.stringify(hello)));
    };
    const results = await Promise.allSettled([secureChannel(toB, a, { handshakeTimeoutMs: 800 }), secureChannel(toA, b, { handshakeTimeoutMs: 800 })]);
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnsupportedRatchetVersionError);
    expect(results[1].status).toBe('rejected');
  });

  it('🔴 中間人把 pqf 改成別的（例如假裝雙方都支援未來的 3）→ hello 雜湊進共享秘密，握手失敗', async () => {
    const { a, b, toB, toA } = channels();
    toA.filter = (d) => {
      if (!isHello(d)) return d;
      const hello = helloOf(d);
      hello.pqf = [2, 3];
      return concatBytes(new Uint8Array([1]), utf8ToBytes(JSON.stringify(hello)));
    };
    const results = await Promise.allSettled([secureChannel(toB, a, { handshakeTimeoutMs: 800 }), secureChannel(toA, b, { handshakeTimeoutMs: 800 })]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('#9 要後量子、對方不要 → SecurityDowngradeError 標的是本版的格式（pq-double-ratchet-v2）', async () => {
    const { a, b, toB, toA } = channels();
    const results = await Promise.allSettled([secureChannel(toB, a, { handshakeTimeoutMs: 500 }), secureChannel(toA, b, { postQuantum: false, handshakeTimeoutMs: 500 })]);
    const reason = (results[0] as PromiseRejectedResult).reason as SecurityDowngradeError;
    expect(reason).toBeInstanceOf(SecurityDowngradeError);
    expect(reason.pinned).toBe('pq-double-ratchet-v2');
  });

  it('純古典：v0.27 的對端照樣互通（古典 header 與 v0.27 相同，沒有 pqf 也接受）', async () => {
    const { a, b, toB, toA } = channels();
    const legacy = legacyPeer(toA, b, { kem: false });
    const side = await secureChannel(toB, a, { postQuantum: false });
    expect(side.postQuantum).toBe(false);
    const got = new Promise<Uint8Array>((resolve) => side.onMessage(resolve));
    await side.send(text('新→舊'));
    await legacy.send('舊→新');
    expect(read(await got)).toBe('舊→新');
    await sleep(20);
    expect(legacy.received).toEqual(['新→舊']);
  });

  it('pqRekeyInterval 傳得進會話：間隔 1 時雙向輪流很快就有輪次完成（header 的 mix 不是「沒有」）', async () => {
    const { a, b, toB, toA } = channels();
    const [aSide, bSide] = await Promise.all([secureChannel(toB, a, { pqRekeyInterval: 1 }), secureChannel(toA, b, { pqRekeyInterval: 1 })]);
    let bGot = 0;
    let aGot = 0;
    bSide.onMessage(() => (bGot += 1));
    aSide.onMessage(() => (aGot += 1));
    for (let i = 0; i < 6; i += 1) {
      await aSide.send(text(`a${i}`));
      await sleep(5);
      await bSide.send(text(`b${i}`));
      await sleep(5);
    }
    await sleep(20);
    expect([aGot, bGot]).toEqual([6, 6]);
    const mixed = [...toA.sent, ...toB.sent].filter((d) => d[0] === 2 && d[1] === 3 && new DataView(d.buffer, d.byteOffset).getUint32(1 + 46) !== 0xffff_ffff);
    expect(mixed.length).toBeGreaterThan(0);
  });
});

describe('secureChannel：選擇性丟包攻擊（ADR 0033 §6）', () => {
  it('🔴 中間人握手後專丟帶 ML-KEM 密文的框 → 後量子輪次完成不了，通道被關閉並回報 SecurityDowngradeError', async () => {
    const { a, b, toB, toA } = channels();
    const errors: unknown[] = [];
    const onListenerError = (e: unknown) => errors.push(e);
    const [aSide, bSide] = await Promise.all([
      secureChannel(toB, a, { pqRekeyInterval: 1, onListenerError }),
      secureChannel(toA, b, { pqRekeyInterval: 1, onListenerError }),
    ]);
    const dropCt: Filter = (d) => ((ratchetFlags(d) & 2) !== 0 ? null : d);
    toB.filter = dropCt;
    toA.filter = dropCt;
    let closed = false;
    aSide.onClose(() => (closed = true));
    aSide.onMessage(() => {});
    bSide.onMessage(() => {});
    for (let i = 0; i < 60 && !closed; i += 1) {
      await aSide.send(text(`a${i}`)).catch(() => {});
      await sleep(3);
      await bSide.send(text(`b${i}`)).catch(() => {});
      await sleep(3);
    }
    expect(closed).toBe(true);
    expect(errors.some((e) => e instanceof SecurityDowngradeError)).toBe(true);
  }, 20_000);
});
