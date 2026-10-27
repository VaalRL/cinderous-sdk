// 雙棘輪的並發（SDK ADR 0024 §4）：`encrypt`／`decrypt` 是 async 函式，但狀態的「讀-改-寫」
// 必須在第一個 await 之前一次做完。若日後有人在中間插入 await（例如改成非同步儲存、WebCrypto），
// 同時送出的兩則就可能拿到同一把訊息金鑰——這組測試會變紅。
import { describe, expect, it } from 'vitest';

import { DoubleRatchetSession, generateRatchetKeyPair } from '../../src/crypto/double-ratchet.js';
import type { EncryptedEnvelope } from '../../src/crypto/types.js';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

function pair() {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
  const associatedData = text('alice|bob');
  const bobDh = generateRatchetKeyPair();
  const alice = DoubleRatchetSession.initAlice({
    sharedSecret,
    associatedData,
    peerPublicKey: 'b'.repeat(64),
    bobRatchetPublicKey: bobDh.publicKey,
  });
  const bob = DoubleRatchetSession.initBob({ sharedSecret, associatedData, peerPublicKey: 'a'.repeat(64), ratchetKeyPair: bobDh });
  return { alice, bob };
}

const headerKey = (e: EncryptedEnvelope) => Array.from(e.header).join(',');

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('雙棘輪：同時處理多則訊息', () => {
  it('同時加密 50 則：每則的 header（序號）都不同，不會重用訊息金鑰', async () => {
    const { alice, bob } = pair();
    const envelopes = await Promise.all(Array.from({ length: 50 }, (_, i) => alice.encrypt(text(`m${i}`))));
    expect(new Set(envelopes.map(headerKey)).size).toBe(50);
    // 密文也兩兩不同（同一把金鑰加密不同明文仍可能不同，所以真正的保證是上面的序號）
    expect(new Set(envelopes.map((e) => Array.from(e.ciphertext).join(','))).size).toBe(50);
    const opened = await Promise.all(envelopes.map((e) => bob.decrypt(e)));
    expect(opened.map(read)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
  });

  it('同時解密亂序到達的一批（含跨 DH 步進）：全部解得開、狀態不回退、重放被擋', async () => {
    const { alice, bob } = pair();
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => alice.encrypt(text(`a${i}`))));
    await bob.decrypt(first[0]!);
    await alice.decrypt(await bob.encrypt(text('b0'))); // Alice 步進，開新鏈
    const second = await Promise.all(Array.from({ length: 10 }, (_, i) => alice.encrypt(text(`c${i}`))));
    const batch = shuffle([...first.slice(1), ...second]);

    const results = await Promise.allSettled(batch.map((e) => bob.decrypt(e)));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const texts = results.map((r) => (r.status === 'fulfilled' ? read(r.value) : '')).sort();
    expect(texts).toEqual([...first.slice(1).map((_, i) => `a${i + 1}`), ...second.map((_, i) => `c${i}`)].sort());

    // 每一則都只能用一次：同時重放整批，全部失敗
    const replays = await Promise.allSettled(batch.map((e) => bob.decrypt(e)));
    expect(replays.every((r) => r.status === 'rejected')).toBe(true);

    // 狀態沒有回退：之後雙向照常
    expect(read(await alice.decrypt(await bob.encrypt(text('b1'))))).toBe('b1');
    expect(read(await bob.decrypt(await alice.encrypt(text('a-last'))))).toBe('a-last');
  });

  it('同時進行中有一則壞掉：壞的那則失敗，其他則不受影響（交易式還原不會把別則的進度一起倒回）', async () => {
    const { alice, bob } = pair();
    const envelopes = await Promise.all(Array.from({ length: 6 }, (_, i) => alice.encrypt(text(`m${i}`))));
    const broken: EncryptedEnvelope = { ...envelopes[2]!, ciphertext: envelopes[2]!.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b)) };
    const results = await Promise.allSettled([envelopes[5]!, broken, envelopes[0]!, envelopes[3]!, envelopes[1]!, envelopes[4]!].map((e) => bob.decrypt(e)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    // 壞掉那則的正本之後仍然解得開（跳過的金鑰還在）
    expect(read(await bob.decrypt(envelopes[2]!))).toBe('m2');
  });
});
