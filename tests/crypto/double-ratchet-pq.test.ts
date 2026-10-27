// 雙棘輪後量子線路格式 v2（SDK ADR 0033）：ML-KEM 輪次與 DH 步進脫鉤、延後混入、每條鏈最多附一次。
// 直接用 Alice／Bob 兩端的會話，把狀態機、遺失與亂序、重放、降級、並發、長時間單向、匯出還原一條一條測。
import { describe, expect, it } from 'vitest';

import { SecurityDowngradeError } from '../../src/crypto/cinder-ek.js';
import {
  DEFAULT_PQ_REKEY_INTERVAL,
  DoubleRatchetSession,
  generateRatchetKeyPair,
  PQ_STALL_LIMIT,
  ratchetHeaderLength,
} from '../../src/crypto/double-ratchet.js';
import type { EncryptedEnvelope } from '../../src/crypto/types.js';
import { generatePqSeed, pqKeyFromSeed } from '../../src/protocol/index.js';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

const BASE = 50; // 後量子 v2 的固定 header
const PK = 4 + 1184;
const CT = 4 + 1088;
const NONE = 0xffff_ffff;

function pair(opts: { interval?: number; maxSkippedKeys?: number } = {}) {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
  const associatedData = text('alice|bob');
  const bobDh = generateRatchetKeyPair();
  const bobKem = pqKeyFromSeed(generatePqSeed());
  const common = { sharedSecret, associatedData, maxSkippedKeys: opts.maxSkippedKeys, pqRekeyInterval: opts.interval };
  const alice = DoubleRatchetSession.initAlice({ ...common, peerPublicKey: 'b'.repeat(64), bobRatchetPublicKey: bobDh.publicKey, bobKemPublicKey: bobKem.pk });
  const bob = DoubleRatchetSession.initBob({ ...common, peerPublicKey: 'a'.repeat(64), ratchetKeyPair: bobDh, kemKeyPair: bobKem });
  return { alice, bob };
}

const view = (e: EncryptedEnvelope) => new DataView(e.header.buffer, e.header.byteOffset, e.header.byteLength);
const flags = (e: EncryptedEnvelope) => e.header[41]!;
const hasPk = (e: EncryptedEnvelope) => (flags(e) & 1) !== 0;
const hasCt = (e: EncryptedEnvelope) => (flags(e) & 2) !== 0;
const ackPk = (e: EncryptedEnvelope) => view(e).getUint32(42);
const mix = (e: EncryptedEnvelope) => view(e).getUint32(46);
const ctId = (e: EncryptedEnvelope) => view(e).getUint32(BASE + (hasPk(e) ? PK : 0));
const withHeader = (e: EncryptedEnvelope, edit: (h: Uint8Array) => Uint8Array): EncryptedEnvelope => ({ ...e, header: edit(e.header.slice()) });

/** 建好會話：Alice 送第一則（握手綁定）、Bob 回一則，雙方都收到對方的 ML-KEM 公鑰 */
async function established(interval = DEFAULT_PQ_REKEY_INTERVAL) {
  const { alice, bob } = pair({ interval });
  await bob.decrypt(await alice.encrypt(text('start')));
  await alice.decrypt(await bob.encrypt(text('confirm')));
  return { alice, bob };
}

/** 固定種子的亂數（xorshift32），讓遺失模擬可重現 */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

describe('後量子 v2：header 格式與大小', () => {
  it('Alice 第一則帶握手密文＋自己的公鑰（2,330 B）；Bob 第一則帶新公鑰（1,238 B）；之後每則 50 B', async () => {
    const { alice, bob } = pair();
    const a0 = await alice.encrypt(text('start'));
    expect(a0.kemAlgorithm).toBe('pq-double-ratchet-v2');
    expect(a0.header[0]).toBe(3);
    expect(a0.header.length).toBe(BASE + PK + CT);
    expect(ctId(a0)).toBe(0);
    expect(mix(a0)).toBe(NONE);
    await bob.decrypt(a0);

    const b0 = await bob.encrypt(text('confirm'));
    expect(b0.header.length).toBe(BASE + PK);
    expect(ackPk(b0)).toBe(0); // 收到 Alice 的 0 號公鑰
    await alice.decrypt(b0);

    for (let i = 0; i < 10; i += 1) {
      const a = await alice.encrypt(text(`a${i}`));
      expect(a.header.length).toBe(BASE);
      expect(ackPk(a)).toBe(1); // 收到 Bob 的 1 號公鑰，Bob 不必再附
      await bob.decrypt(a);
    }
    const b1 = await bob.encrypt(text('b1'));
    expect(b1.header.length).toBe(BASE);
  });

  it('ratchetHeaderLength：依旗標算長度；不認得的版本、保留旗標、長度不足 → 0', async () => {
    const { alice } = pair();
    const a0 = await alice.encrypt(text('x'));
    const wire = new Uint8Array([...a0.header, 9, 9, 9]);
    expect(ratchetHeaderLength(wire)).toBe(a0.header.length);
    expect(ratchetHeaderLength(a0.header.slice(0, 100))).toBe(0);
    const reserved = a0.header.slice();
    reserved[41] = 4;
    expect(ratchetHeaderLength(reserved)).toBe(0);
    const legacy = a0.header.slice();
    legacy[0] = 2;
    expect(ratchetHeaderLength(legacy)).toBe(0);
    expect(ratchetHeaderLength(new Uint8Array(41).fill(1))).toBe(41);
  });

  it('pqRekeyInterval 必須是 1～10000 的整數', () => {
    for (const interval of [0, -1, 1.5, 10_001, Number.NaN]) expect(() => pair({ interval })).toThrow(/pqRekeyInterval/);
  });
});

describe('後量子 v2：KEM 輪次的狀態機', () => {
  it('送滿間隔才封裝；密文附一次；對方下一次步進混入（mix）；帶密文那一則之後的訊息都照常', async () => {
    const { alice, bob } = await established(3);
    const a1 = await alice.encrypt(text('a1')); // Alice 已送 2 則（start、a1）
    const a2 = await alice.encrypt(text('a2')); // 第 3 則：送滿間隔 → 這一則開始時還是 2，不封
    const a3 = await alice.encrypt(text('a3')); // 送滿 3 則 → 封給 Bob 的 1 號公鑰
    const a4 = await alice.encrypt(text('a4'));
    expect([a1, a2, a3, a4].map(hasCt)).toEqual([false, false, true, false]);
    expect(ctId(a3)).toBe(1);
    expect(a3.header.length).toBe(BASE + CT);
    for (const m of [a1, a2, a3, a4]) await bob.decrypt(m);

    // Bob 的傳送鏈是收到 a1 時開的（那時還沒有密文）⇒ 這條鏈沒有混入；Bob 換了新公鑰（2 號）要附上
    const b1 = await bob.encrypt(text('b1'));
    expect(mix(b1)).toBe(NONE);
    expect(hasPk(b1)).toBe(true);
    await alice.decrypt(b1);

    // Alice 開新鏈：對方還沒混入 ⇒ 再附一次同一份密文；並回報收到 2 號公鑰
    const a5 = await alice.encrypt(text('a5'));
    expect(hasCt(a5)).toBe(true);
    expect(ctId(a5)).toBe(1);
    expect(ackPk(a5)).toBe(2);
    await bob.decrypt(a5);

    // Bob 步進：混入 1 號輪次
    const b2 = await bob.encrypt(text('b2'));
    expect(mix(b2)).toBe(1);
    expect(b2.header.length).toBe(BASE);
    expect(read(await alice.decrypt(b2))).toBe('b2');

    // 1 號輪次完成：不再重帶；Alice 又送滿 3 則、手上有 Bob 的 2 號公鑰 ⇒ 開始 2 號輪次
    const a6 = await alice.encrypt(text('a6'));
    expect(ctId(a6)).toBe(2);
    expect(read(await bob.decrypt(a6))).toBe('a6');
  });

  it('雙向輪流（每則都是新的一步）：沒有輪次時 header 都是 50 B，輪次只在間隔到了才出現', async () => {
    const { alice, bob } = await established(10);
    const sizes: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const a = await alice.encrypt(text(`a${i}`));
      await bob.decrypt(a);
      const b = await bob.encrypt(text(`b${i}`));
      await alice.decrypt(b);
      sizes.push(a.header.length, b.header.length);
    }
    const heavy = sizes.filter((s) => s > BASE).length;
    // 每一方每 10 則一輪：一份密文＋一把新公鑰 ⇒ 120 則裡約 4×(120/20) 則帶 KEM
    expect(heavy).toBeGreaterThan(8);
    expect(heavy).toBeLessThanOrEqual(30);
    expect(sizes.filter((s) => s === BASE).length).toBeGreaterThanOrEqual(90);
  });

  it('pqRekeyInterval 1：每一步都有輪次在跑（接近 v1 的後量子自癒頻率），照樣互通', async () => {
    const { alice, bob } = await established(1);
    let mixed = 0;
    for (let i = 0; i < 20; i += 1) {
      const a = await alice.encrypt(text(`a${i}`));
      await bob.decrypt(a);
      const b = await bob.encrypt(text(`b${i}`));
      await alice.decrypt(b);
      if (mix(a) !== NONE) mixed += 1;
      if (mix(b) !== NONE) mixed += 1;
    }
    expect(mixed).toBeGreaterThanOrEqual(15);
  });
});

describe('後量子 v2：遺失與亂序', () => {
  it('Alice 第一條鏈（握手綁定）每則都帶握手密文：第一則遺失，後面的照樣解得開', async () => {
    const { alice, bob } = pair();
    const m1 = await alice.encrypt(text('1'));
    const m2 = await alice.encrypt(text('2'));
    const m3 = await alice.encrypt(text('3'));
    expect([m1, m2, m3].every(hasCt)).toBe(true);
    expect(read(await bob.decrypt(m3))).toBe('3');
    expect(read(await bob.decrypt(m2))).toBe('2');
    expect(read(await bob.decrypt(await alice.decrypt(await bob.encrypt(text('b'))).then(() => alice.encrypt(text('4')))))).toBe('4');
  });

  it('🔴 帶密文的那一則遺失：同一條鏈的其他則照樣解得開；下一條鏈重帶，之後完成輪次', async () => {
    const { alice, bob } = await established(2);
    const a1 = await alice.encrypt(text('a1'));
    const a2 = await alice.encrypt(text('a2')); // 封裝、帶密文 → 遺失
    const a3 = await alice.encrypt(text('a3'));
    expect(hasCt(a2)).toBe(true);
    await bob.decrypt(a1);
    expect(read(await bob.decrypt(a3))).toBe('a3'); // 不依賴密文

    const b1 = await bob.encrypt(text('b1'));
    expect(mix(b1)).toBe(NONE); // Bob 沒拿到密文，沒混入
    await alice.decrypt(b1);
    const a4 = await alice.encrypt(text('a4'));
    expect(hasCt(a4)).toBe(true); // 新鏈重帶
    await bob.decrypt(a4);
    const b2 = await bob.encrypt(text('b2'));
    expect(mix(b2)).toBe(ctId(a4));
    expect(read(await alice.decrypt(b2))).toBe('b2');
  });

  it('🔴 DH 步進的第一則（帶密文與公鑰）遺失：同一步的後續訊息照樣解得開', async () => {
    const { alice, bob } = await established(1);
    await bob.decrypt(await alice.encrypt(text('a1')));
    await alice.decrypt(await bob.encrypt(text('b1')));
    const first = await alice.encrypt(text('first')); // 新鏈的第一則
    const second = await alice.encrypt(text('second'));
    expect(first.header.length).toBeGreaterThan(BASE);
    expect(second.header.length).toBe(BASE);
    expect(read(await bob.decrypt(second))).toBe('second'); // 先到的是第二則：DH 步進照做
    expect(read(await bob.decrypt(first))).toBe('first'); // 晚到的第一則用跳過的金鑰解，KEM 欄位照收
    const b = await bob.encrypt(text('b2'));
    expect(read(await alice.decrypt(b))).toBe('b2');
  });

  it('帶密文的那一則比對方步進還晚到：先照常步進（不混入），晚到後在下一步混入', async () => {
    const { alice, bob } = await established(2);
    await bob.decrypt(await alice.encrypt(text('a1')));
    const withCt = await alice.encrypt(text('a2'));
    expect(hasCt(withCt)).toBe(true);
    const b1 = await bob.encrypt(text('b1'));
    await alice.decrypt(b1);
    const a3 = await alice.encrypt(text('a3')); // 新鏈，重帶
    // 網路上 a3 先到，而且 a3 那份重帶也被丟了：用不帶密文的版本無法模擬（header 受 MAC 保護），
    // 所以改測「晚到的第一份」：Bob 先收 a3（取得密文並步進）、再收 withCt（跳過的金鑰，重帶的密文已處理過→略過）
    await bob.decrypt(a3);
    expect(read(await bob.decrypt(withCt))).toBe('a2');
    const b2 = await bob.encrypt(text('b2'));
    expect(mix(b2)).toBe(ctId(withCt));
    expect(read(await alice.decrypt(b2))).toBe('b2');
  });

  it('20% 隨機遺失＋亂序、雙向約 1,200 則：到達的每一則都解得開、輪次持續完成、看門狗不誤判', async () => {
    const random = rng(20260929);
    const { alice, bob } = await established(5);
    let delivered = 0;
    let mixes = 0;
    for (let round = 0; round < 120; round += 1) {
      for (const [from, to] of [
        [alice, bob],
        [bob, alice],
      ] as const) {
        const burst = await Promise.all(Array.from({ length: 1 + Math.floor(random() * 9) }, (_, i) => from.encrypt(text(`${round}:${i}`))));
        const arriving = burst.filter(() => random() >= 0.2);
        for (let i = arriving.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [arriving[i], arriving[j]] = [arriving[j]!, arriving[i]!];
        }
        for (const m of arriving) {
          await to.decrypt(m);
          delivered += 1;
          if (mix(m) !== NONE) mixes += 1;
        }
      }
    }
    expect(delivered).toBeGreaterThan(600);
    expect(mixes).toBeGreaterThan(30);
  }, 60_000);
});

describe('後量子 v2：長時間單向傳送', () => {
  it('對方一直不回：密文只帶一次、不會每則重帶；對方一回就完成輪次', async () => {
    const { alice, bob } = await established(10);
    const sizes: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const m = await alice.encrypt(text(`typing ${i}`));
      sizes.push(m.header.length);
      await bob.decrypt(m);
    }
    expect(sizes.filter((s) => s === BASE + CT)).toHaveLength(1);
    expect(sizes.filter((s) => s === BASE)).toHaveLength(499);
    // Bob 的傳送鏈是在密文到之前開的：這一則還不能混入；混入要等 Bob 下一次步進（一個來回）
    const b = await bob.encrypt(text('reply'));
    expect(mix(b)).toBe(NONE);
    await alice.decrypt(b);
    const a = await alice.encrypt(text('next'));
    expect(hasCt(a)).toBe(true); // Alice 的新鏈重帶一次（Bob 其實已經有了，會略過）
    await bob.decrypt(a);
    const b2 = await bob.encrypt(text('reply2'));
    expect(mix(b2)).toBe(ctId(a));
    expect(read(await alice.decrypt(b2))).toBe('reply2');
  });
});

describe('後量子 v2：重放與降級', () => {
  it('🔴 重放帶密文的訊息、重放握手第一則 → 拒絕；重帶的同一份密文不會被解封裝第二次', async () => {
    const { alice, bob } = pair({ interval: 2 });
    const start = await alice.encrypt(text('start'));
    await bob.decrypt(start);
    await expect(bob.decrypt(start)).rejects.toThrow(/收過/);
    await alice.decrypt(await bob.encrypt(text('confirm')));
    await bob.decrypt(await alice.encrypt(text('a1')));
    const withCt = await alice.encrypt(text('a2'));
    await bob.decrypt(withCt);
    await expect(bob.decrypt(withCt)).rejects.toThrow(/收過/);
    // 重帶（新鏈的第一則，同一份密文）：Bob 已經有這一輪，略過
    await alice.decrypt(await bob.encrypt(text('b1')));
    const again = await alice.encrypt(text('a3'));
    expect(ctId(again)).toBe(ctId(withCt));
    await bob.decrypt(again);
    const b2 = await bob.encrypt(text('b2'));
    expect(mix(b2)).toBe(ctId(withCt));
    expect(read(await alice.decrypt(b2))).toBe('b2');
  });

  it('🔴 拿掉 KEM 欄位（旗標清零、截短）、改成古典版本、改成 v0.27 的舊版本 → 拒絕，狀態不變', async () => {
    const { alice, bob } = await established(1);
    await bob.decrypt(await alice.encrypt(text('a1')));
    await alice.decrypt(await bob.encrypt(text('b1')));
    const m = await alice.encrypt(text('secret'));
    expect(m.header.length).toBeGreaterThan(BASE);
    const stripped = withHeader(m, (h) => {
      const out = h.slice(0, BASE);
      out[41] = 0;
      return out;
    });
    await expect(bob.decrypt(stripped)).rejects.toThrow();
    const classic = withHeader(m, (h) => {
      const out = h.slice(0, 41);
      out[0] = 1;
      return out;
    });
    await expect(bob.decrypt(classic)).rejects.toThrow(/版本/);
    const legacy = withHeader(m, (h) => {
      h[0] = 2;
      return h;
    });
    await expect(bob.decrypt(legacy)).rejects.toThrow(/v0\.27/);
    expect(read(await bob.decrypt(m))).toBe('secret');
  });

  it('🔴 竄改 mix（輪次參照）、ackPk、密文編號 → 拒絕，狀態不變', async () => {
    const { alice, bob } = await established(2);
    await bob.decrypt(await alice.encrypt(text('a1')));
    const withCt = await alice.encrypt(text('a2'));
    await bob.decrypt(withCt);
    await alice.decrypt(await bob.encrypt(text('b1')));
    await bob.decrypt(await alice.encrypt(text('a3')));
    const b2 = await bob.encrypt(text('b2'));
    expect(mix(b2)).not.toBe(NONE);
    const set32 = (at: number, value: number) => (h: Uint8Array) => {
      new DataView(h.buffer).setUint32(at, value);
      return h;
    };
    for (const bad of [set32(46, NONE), set32(46, mix(b2) + 1), set32(42, ackPk(b2) + 1), set32(42, NONE)]) {
      await expect(alice.decrypt(withHeader(b2, bad))).rejects.toThrow();
    }
    const withCtBad = withHeader(withCt, set32(BASE, ctId(withCt) + 1));
    await expect(bob.decrypt(withCtBad)).rejects.toThrow();
    expect(read(await alice.decrypt(b2))).toBe('b2');
  });

  it('🔴 握手綁定的第一條鏈拿掉密文 → 拒絕（不會變成只有古典的起點）', async () => {
    const { alice, bob } = pair();
    const a0 = await alice.encrypt(text('start'));
    const noCt = withHeader(a0, (h) => {
      const out = h.slice(0, BASE + PK);
      out[41] = 1;
      return out;
    });
    await expect(bob.decrypt(noCt)).rejects.toThrow(/握手/);
    expect(read(await bob.decrypt(a0))).toBe('start');
  });

  it(`🔴 選擇性丟包攻擊：專丟帶密文的訊息 → 對方步進 ${PQ_STALL_LIMIT} 次以上仍沒混入就丟 SecurityDowngradeError 並銷毀會話`, async () => {
    const { alice, bob } = await established(2);
    let error: unknown;
    try {
      for (let i = 0; i < 200; i += 1) {
        const a = await alice.encrypt(text(`a${i}`));
        if (!hasCt(a)) await bob.decrypt(a); // 攻擊者丟掉帶密文的
        const b = await bob.encrypt(text(`b${i}`));
        if (!hasCt(b)) await alice.decrypt(b);
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecurityDowngradeError);
    // 會話已銷毀：不能再用
    const destroyed = [alice, bob].filter((s) => !s.canSend);
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
  });

  it(`🔴 選擇性丟包攻擊：專丟帶公鑰的訊息 → 同樣在 ${PQ_STALL_LIMIT} 步後拒絕`, async () => {
    const { alice, bob } = pair({ interval: 2 });
    await bob.decrypt(await alice.encrypt(text('start')));
    let error: unknown;
    try {
      for (let i = 0; i < 200; i += 1) {
        const b = await bob.encrypt(text(`b${i}`));
        if (!hasPk(b)) await alice.decrypt(b);
        const a = await alice.encrypt(text(`a${i}`));
        if (!hasPk(a)) await bob.decrypt(a);
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecurityDowngradeError);
  });
});

describe('後量子 v2：並發', () => {
  it('同時加密 50 則（間隔 1，輪次在其中開始）：序號兩兩不同、只有一則帶密文、全部解得開', async () => {
    const { alice, bob } = await established(1);
    const envelopes = await Promise.all(Array.from({ length: 50 }, (_, i) => alice.encrypt(text(`m${i}`))));
    expect(new Set(envelopes.map((e) => view(e).getUint32(37))).size).toBe(50);
    expect(envelopes.filter(hasCt)).toHaveLength(1);
    const opened = await Promise.all(envelopes.map((e) => bob.decrypt(e)));
    expect(opened.map(read)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
  });

  it('同時解密亂序到達的一批（跨 DH 步進、含密文與公鑰）：全部解得開、重放全擋、之後照常', async () => {
    const { alice, bob } = await established(1);
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => alice.encrypt(text(`a${i}`))));
    await bob.decrypt(first[0]!);
    await alice.decrypt(await bob.encrypt(text('b0')));
    const second = await Promise.all(Array.from({ length: 10 }, (_, i) => alice.encrypt(text(`c${i}`))));
    const batch = [...first.slice(1), ...second].reverse();
    const results = await Promise.allSettled(batch.map((e) => bob.decrypt(e)));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const replays = await Promise.allSettled(batch.map((e) => bob.decrypt(e)));
    expect(replays.every((r) => r.status === 'rejected')).toBe(true);
    expect(read(await alice.decrypt(await bob.encrypt(text('b1'))))).toBe('b1');
    expect(read(await bob.decrypt(await alice.encrypt(text('a-last'))))).toBe('a-last');
  });
});

describe('後量子 v2：匯出與還原', () => {
  it('輪次進行到一半（Alice 等混入、Bob 等步進）匯出再還原：接著完成輪次', async () => {
    const { alice, bob } = await established(2);
    await bob.decrypt(await alice.encrypt(text('a1')));
    const withCt = await alice.encrypt(text('a2'));
    await bob.decrypt(withCt);
    const a = DoubleRatchetSession.fromState(await alice.exportState());
    const b = DoubleRatchetSession.fromState(await bob.exportState());
    await a.decrypt(await b.encrypt(text('b1')));
    await b.decrypt(await a.encrypt(text('a3')));
    const b2 = await b.encrypt(text('b2'));
    expect(mix(b2)).toBe(ctId(withCt));
    expect(read(await a.decrypt(b2))).toBe('b2');
  });

  it('Alice 的第一條鏈（還帶握手密文）匯出再還原：Bob 照樣解得開', async () => {
    const { alice, bob } = pair();
    const restored = DoubleRatchetSession.fromState(await alice.exportState());
    expect(read(await bob.decrypt(await restored.encrypt(text('start'))))).toBe('start');
  });

  it('🔴 還原時驗證：v0.27 的後量子狀態、out/in 欄位不完整、編號不一致、長度不對、古典帶後量子欄位 → 丟例外', async () => {
    const { alice, bob } = await established(2);
    await bob.decrypt(await alice.encrypt(text('a1')));
    await bob.decrypt(await alice.encrypt(text('a2'))); // Alice 有 out、Bob 有 in
    const aj = JSON.parse(new TextDecoder().decode(await alice.exportState())) as Record<string, unknown>;
    const bj = JSON.parse(new TextDecoder().decode(await bob.exportState())) as Record<string, unknown>;
    expect(aj.outId).toBeDefined();
    expect(bj.inId).toBeDefined();
    const load = (j: Record<string, unknown>, patch: Record<string, unknown>) =>
      DoubleRatchetSession.fromState(new TextEncoder().encode(JSON.stringify({ ...j, ...patch })));
    expect(() => load(aj, {})).not.toThrow();
    expect(() => load(bj, {})).not.toThrow();
    expect(() => load(aj, { v: 1 })).toThrow(/v0\.27/);
    expect(() => load(aj, { outSs: undefined })).toThrow(/out/);
    expect(() => load(aj, { outId: 99 })).toThrow(/outId/);
    expect(() => load(aj, { outCt: 'AAAA' })).toThrow();
    expect(() => load(bj, { inSs: undefined })).toThrow(/in/);
    expect(() => load(bj, { inId: 5 })).toThrow(/inId/);
    expect(() => load(aj, { peerAck: 7 })).toThrow(/peerAck/);
    expect(() => load(aj, { interval: 0 })).toThrow(/pqRekeyInterval/);
    expect(() => load(aj, { kemId: -1 })).toThrow(/kemId/);
    expect(() => load(aj, { sendMix: 5 })).toThrow(/sendMix/);
    expect(() => load(aj, { pkSent: 'yes' })).toThrow(/pkSent/);
    expect(() => load(aj, { pq: false })).toThrow(/古典/);
  });

  it('v0.27 匯出的古典會話（v:1）照樣還原', async () => {
    const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
    const bobDh = generateRatchetKeyPair();
    const common = { sharedSecret, associatedData: text('ad') };
    const alice = DoubleRatchetSession.initAlice({ ...common, peerPublicKey: 'b'.repeat(64), bobRatchetPublicKey: bobDh.publicKey });
    const bob = DoubleRatchetSession.initBob({ ...common, peerPublicKey: 'a'.repeat(64), ratchetKeyPair: bobDh });
    const j = JSON.parse(new TextDecoder().decode(await alice.exportState())) as Record<string, unknown>;
    const old = DoubleRatchetSession.fromState(new TextEncoder().encode(JSON.stringify({ ...j, v: 1 })));
    expect(read(await bob.decrypt(await old.encrypt(text('old'))))).toBe('old');
  });
});

describe('後量子 v2：量測（ADR 0033 §4）', () => {
  it('header 大小：連續打字 50 B、DH 步進 50 B、輪次開始 1,142 B、換公鑰 1,238 B、握手第一則 2,330 B（v1 每則 2,314 B）', async () => {
    const { alice, bob } = pair({ interval: 50 });
    const a0 = await alice.encrypt(text('start'));
    await bob.decrypt(a0);
    const b0 = await bob.encrypt(text('confirm'));
    await alice.decrypt(b0);
    const typing: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const m = await alice.encrypt(text('k'));
      typing.push(m.header.length);
      await bob.decrypt(m);
    }
    const step = await bob.encrypt(text('reply'));
    expect({ first: a0.header.length, bobFirst: b0.header.length, typing: [...new Set(typing)], step: step.header.length }).toEqual({
      first: 2_330,
      bobFirst: 1_238,
      typing: [50],
      step: 50,
    });
  });

  it('攤提：雙向輪流 600 則、間隔 50 → 平均每則 header ≈ 94 B（v1 固定 2,314 B）', async () => {
    const { alice, bob } = await established(50);
    let total = 0;
    for (let i = 0; i < 300; i += 1) {
      const a = await alice.encrypt(text('x'));
      await bob.decrypt(a);
      const b = await bob.encrypt(text('y'));
      await alice.decrypt(b);
      total += a.header.length + b.header.length;
    }
    const average = total / 600;
    // 理論值：每一方每 50 則一份密文（1,092）＋一把新公鑰（1,188）⇒ 50 + 2 × 2,280 ÷ 100 ≈ 96 B；實測 94 B
    expect(Math.round(average)).toBeGreaterThanOrEqual(90);
    expect(Math.round(average)).toBeLessThanOrEqual(100);
  }, 60_000);
});
