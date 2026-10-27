// 雙棘輪核心（SDK ADR 0010 §2）：照 Signal 規格，外加後量子混合步進。
// 直接用初始化函式組出 Alice／Bob 兩端，把規格裡的邊界情況一條一條測。
import { describe, expect, it } from 'vitest';

import {
  DoubleRatchetSession,
  generateRatchetKeyPair,
  type RatchetInit,
} from '../../src/crypto/double-ratchet.js';
import { generatePqSeed, pqKeyFromSeed } from '../../src/protocol/index.js';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

function pair(postQuantum: boolean, maxSkippedKeys?: number) {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
  const associatedData = text('alice|bob');
  const bobDh = generateRatchetKeyPair();
  const bobKem = postQuantum ? pqKeyFromSeed(generatePqSeed()) : undefined;
  const base: Omit<RatchetInit, 'role'> = { sharedSecret, associatedData, peerPublicKey: 'x', maxSkippedKeys };
  const alice = DoubleRatchetSession.initAlice({
    ...base,
    peerPublicKey: 'b'.repeat(64),
    bobRatchetPublicKey: bobDh.publicKey,
    bobKemPublicKey: bobKem?.pk,
  });
  const bob = DoubleRatchetSession.initBob({ ...base, peerPublicKey: 'a'.repeat(64), ratchetKeyPair: bobDh, kemKeyPair: bobKem });
  return { alice, bob };
}

for (const postQuantum of [false, true]) {
  describe(`雙棘輪（${postQuantum ? '後量子混合' : '純古典'}）`, () => {
    it('雙向來回：每一則都解得開', async () => {
      const { alice, bob } = pair(postQuantum);
      for (let round = 0; round < 3; round += 1) {
        expect(read(await bob.decrypt(await alice.encrypt(text(`a${round}`))))).toBe(`a${round}`);
        expect(read(await alice.decrypt(await bob.encrypt(text(`b${round}`))))).toBe(`b${round}`);
      }
      expect(alice.postQuantum).toBe(postQuantum);
    });

    it('同一條鏈內亂序到達：照樣解得開', async () => {
      const { alice, bob } = pair(postQuantum);
      const [m1, m2, m3] = [await alice.encrypt(text('1')), await alice.encrypt(text('2')), await alice.encrypt(text('3'))];
      expect(read(await bob.decrypt(m3))).toBe('3');
      expect(read(await bob.decrypt(m1))).toBe('1');
      expect(read(await bob.decrypt(m2))).toBe('2');
    });

    it('跨 DH 步進亂序：舊鏈晚到的訊息也解得開', async () => {
      const { alice, bob } = pair(postQuantum);
      const a1 = await alice.encrypt(text('a1'));
      const a2 = await alice.encrypt(text('a2'));
      await bob.decrypt(a1);
      await alice.decrypt(await bob.encrypt(text('b1'))); // Alice 步進
      const a3 = await alice.encrypt(text('a3'));
      expect(read(await bob.decrypt(a3))).toBe('a3');
      expect(read(await bob.decrypt(a2))).toBe('a2'); // 舊鏈的金鑰還在跳過的清單裡
    });

    it('🔴 同一則解第二次 → 失敗（訊息金鑰用過即刪：逐則前向保密）', async () => {
      const { alice, bob } = pair(postQuantum);
      const m = await alice.encrypt(text('一次'));
      await bob.decrypt(m);
      await expect(bob.decrypt(m)).rejects.toThrow();
    });

    it('🔴 竄改密文或 header → 失敗，而且會話狀態不變（之後的正常訊息照樣解得開）', async () => {
      const { alice, bob } = pair(postQuantum);
      const m1 = await alice.encrypt(text('1'));
      const badCipher = { ...m1, ciphertext: m1.ciphertext.slice() };
      badCipher.ciphertext[0]! ^= 1;
      await expect(bob.decrypt(badCipher)).rejects.toThrow();
      const badHeader = { ...m1, header: m1.header.slice() };
      badHeader.header[40]! ^= 1; // 訊息序號
      await expect(bob.decrypt(badHeader)).rejects.toThrow();
      expect(read(await bob.decrypt(m1))).toBe('1');
      expect(read(await bob.decrypt(await alice.encrypt(text('2'))))).toBe('2');
    });

    it('跳過太多則 → 丟例外（PRD：跳過金鑰有上限），狀態不變', async () => {
      const { alice, bob } = pair(postQuantum, 5);
      const first = await alice.encrypt(text('first'));
      for (let i = 0; i < 6; i += 1) await alice.encrypt(text('skip'));
      const late = await alice.encrypt(text('late'));
      await expect(bob.decrypt(late)).rejects.toThrow(/跳過/);
      expect(read(await bob.decrypt(first))).toBe('first');
    });

    it('同一段明文加密兩次，密文不同（每則都是新金鑰）', async () => {
      const { alice } = pair(postQuantum);
      const a = await alice.encrypt(text('same'));
      const b = await alice.encrypt(text('same'));
      expect(a.ciphertext).not.toEqual(b.ciphertext);
    });

    it('匯出再還原：接著聊', async () => {
      const { alice, bob } = pair(postQuantum);
      await bob.decrypt(await alice.encrypt(text('1')));
      const restored = DoubleRatchetSession.fromState(await bob.exportState());
      expect(read(await alice.decrypt(await restored.encrypt(text('2'))))).toBe('2');
      expect(read(await restored.decrypt(await alice.encrypt(text('3'))))).toBe('3');
    });

    it('destroy 之後不能再用', async () => {
      const { alice } = pair(postQuantum);
      alice.destroy();
      await expect(alice.encrypt(text('x'))).rejects.toThrow();
    });
  });
}

describe('後量子步進', () => {
  it('header（線路格式 v2，ADR 0033）：第一則帶握手密文與公鑰（2,330 B），之後只有 50 B；每一輪換一把 KEM 公鑰', async () => {
    const { alice, bob } = pair(true);
    const a1 = await alice.encrypt(text('a1'));
    expect(a1.kemAlgorithm).toBe('pq-double-ratchet-v2');
    expect(a1.header.length).toBe(50 + 4 + 1184 + 4 + 1088);
    await bob.decrypt(a1);
    const b1 = await bob.encrypt(text('b1'));
    expect(b1.header.length).toBe(50 + 4 + 1184); // Bob 用掉握手的 ML-KEM，換新的一把
    await alice.decrypt(b1);
    const a2 = await alice.encrypt(text('a2'));
    expect(a2.header.length).toBe(50);
    expect(b1.header.slice(54, 54 + 1184)).not.toEqual(a1.header.slice(54, 54 + 1184));
  });

  it('純古典的 header 只有 41 位元組', async () => {
    const { alice } = pair(false);
    const m = await alice.encrypt(text('x'));
    expect(m.header.length).toBe(41);
    expect(m.kemAlgorithm).toBeUndefined();
  });

  it('🔴 拿掉後量子欄位（假裝成古典）→ 解不開，不會默默降級', async () => {
    const { alice, bob } = pair(true);
    const m = await alice.encrypt(text('x'));
    const stripped = { ...m, header: m.header.slice(0, 41) };
    stripped.header[0] = 1;
    await expect(bob.decrypt(stripped)).rejects.toThrow();
  });
});

describe('安全審查修正（ADR 0010 §5）', () => {
  it('🔴 #1 從同一份狀態還原兩次各自加密：金鑰流不可重用（隨機 nonce）', async () => {
    const { alice } = pair(false);
    const saved = await alice.exportState();
    const one = DoubleRatchetSession.fromState(saved);
    const two = DoubleRatchetSession.fromState(saved);
    const a = await one.encrypt(text('AAAAAAAAAAAAAAAA'));
    const b = await two.encrypt(text('BBBBBBBBBBBBBBBB'));
    // 若 nonce 相同，密文的 XOR 會等於明文的 XOR（'A'^'B' = 0x03）
    const xor = a.ciphertext.slice(24, 40).map((x, i) => x ^ b.ciphertext[24 + i]!);
    expect([...xor].every((x) => x === 3)).toBe(false);
  });

  it('🔴 #1 exportState 是「搬走」：匯出後原本的會話不能再用', async () => {
    const { alice } = pair(false);
    await alice.exportState();
    await expect(alice.encrypt(text('x'))).rejects.toThrow();
  });

  it('🔴 #3 還原時驗證格式：缺 maxSkip、長度不對、計數為負、後量子缺種子 → 丟例外', async () => {
    const { alice } = pair(true);
    const good = JSON.parse(new TextDecoder().decode(await alice.exportState())) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify({ ...good, ...patch }));
    expect(() => DoubleRatchetSession.fromState(bad({ maxSkip: undefined }))).toThrow();
    expect(() => DoubleRatchetSession.fromState(bad({ rk: 'abcd' }))).toThrow();
    expect(() => DoubleRatchetSession.fromState(bad({ ns: -1 }))).toThrow();
    expect(() => DoubleRatchetSession.fromState(bad({ kemSeed: undefined }))).toThrow();
    expect(() => DoubleRatchetSession.fromState(bad({ pq: false, kemSeed: undefined }))).toThrow();
  });

  it('🔴 #3 maxSkippedKeys 必須是 1～10000 的整數', () => {
    for (const maxSkippedKeys of [0, -1, 1.5, Infinity, 10_001]) {
      expect(() => pair(false, maxSkippedKeys)).toThrow();
    }
  });

  it('#6 同一條鏈上已經收過的序號 → 直接拒絕（不必算到 MAC 才失敗）', async () => {
    const { alice, bob } = pair(false);
    const m1 = await alice.encrypt(text('1'));
    await bob.decrypt(m1);
    await bob.decrypt(await alice.encrypt(text('2')));
    await expect(bob.decrypt(m1)).rejects.toThrow(/收過/);
  });

  it('#6 已經退役的舊鏈、而且沒有留金鑰的訊息 → 直接拒絕，不做 DH 步進', async () => {
    const { alice, bob } = pair(false);
    const a1 = await alice.encrypt(text('a1'));
    await bob.decrypt(a1);
    await alice.decrypt(await bob.encrypt(text('b1')));
    await bob.decrypt(await alice.encrypt(text('a2'))); // Bob 步進，Alice 的第一條鏈退役
    await expect(bob.decrypt(a1)).rejects.toThrow(/退役|收過/);
  });
});
