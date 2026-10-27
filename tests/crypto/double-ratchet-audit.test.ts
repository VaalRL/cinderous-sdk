// ADR 0033 §10：後量子線路格式 v2 的安全審查修正，每項一個測試。
// 用 vi.mock 包住 hybrid-kem：可以讓「下一把產生的 ML-KEM 公鑰」不合法（模擬有 bug 或惡意的已認證對方），
// 也可以記下每一次解封裝的共享秘密，檢查用過之後有沒有清零。
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DoubleRatchetSession, generateRatchetKeyPair, RatchetProtocolError } from '../../src/crypto/double-ratchet.js';
import * as kem from '../../src/protocol/hybrid-kem.js';

const hooks = vi.hoisted(() => ({ corruptNextPk: false, decapsulated: [] as Uint8Array[] }));

vi.mock('../../src/protocol/hybrid-kem.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/protocol/hybrid-kem.js')>();
  return {
    ...actual,
    pqKeyFromSeed: (seed: Uint8Array) => {
      const pair = actual.pqKeyFromSeed(seed);
      if (hooks.corruptNextPk) {
        hooks.corruptNextPk = false;
        pair.pk[0] = 0xff; // 第一個係數 = 0xfff ≥ q
        pair.pk[1] = pair.pk[1]! | 0x0f;
      }
      return pair;
    },
    pqDecapsulate: (sk: Uint8Array, ct: Uint8Array) => {
      const ss = actual.pqDecapsulate(sk, ct);
      hooks.decapsulated.push(ss);
      return ss;
    },
  };
});

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

function pair(opts: { interval?: number; maxSkippedKeys?: number; bobSeed?: boolean } = {}) {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
  const associatedData = text('alice|bob');
  const bobDh = generateRatchetKeyPair();
  const seed = kem.generatePqSeed();
  const bobKem = kem.pqKeyFromSeed(seed);
  const common = { sharedSecret, associatedData, pqRekeyInterval: opts.interval, maxSkippedKeys: opts.maxSkippedKeys };
  const alice = DoubleRatchetSession.initAlice({ ...common, peerPublicKey: 'b'.repeat(64), bobRatchetPublicKey: bobDh.publicKey, bobKemPublicKey: bobKem.pk });
  const bob = DoubleRatchetSession.initBob({
    ...common,
    peerPublicKey: 'a'.repeat(64),
    ratchetKeyPair: bobDh,
    kemKeyPair: bobKem,
    kemSeed: opts.bobSeed === false ? undefined : seed,
  });
  return { alice, bob };
}

beforeEach(() => {
  hooks.corruptNextPk = false;
  hooks.decapsulated.length = 0;
});

describe('安全審查修正（ADR 0033 §10）', () => {
  it('🔴 #2／#5 已認證的對方送來不合法的 ML-KEM 公鑰（係數 ≥ q）→ 收下時就丟 RatchetProtocolError、會話銷毀（不會卡成永遠送不出去）', async () => {
    const { alice, bob } = pair({ interval: 1 });
    await bob.decrypt(await alice.encrypt(text('start'))); // Bob 用掉握手的 ML-KEM，換下一把……
    hooks.corruptNextPk = true;
    // ……下一把在 Bob 解開 Alice 的密文時才產生；先讓 Alice 封一輪給 Bob 的 1 號公鑰
    await alice.decrypt(await bob.encrypt(text('confirm')));
    await bob.decrypt(await alice.encrypt(text('a1'))); // 帶密文 → Bob 換 2 號公鑰（被弄壞）
    const bad = await bob.encrypt(text('b1')); // 附上壞掉的 2 號公鑰
    await expect(alice.decrypt(bad)).rejects.toBeInstanceOf(RatchetProtocolError);
    expect(alice.canSend).toBe(false);
    await expect(alice.encrypt(text('x'))).rejects.toThrow(/銷毀/);
  });

  it('🔴 #3 步進那一則自己帶的密文：解封裝出的共享秘密在同一次解密用掉後清零；只有還在等混入的那一份不是零', async () => {
    const { alice, bob } = pair({ interval: 1 });
    for (let i = 0; i < 12; i += 1) {
      await bob.decrypt(await alice.encrypt(text(`a${i}`)));
      await alice.decrypt(await bob.encrypt(text(`b${i}`)));
    }
    expect(hooks.decapsulated.length).toBeGreaterThan(8);
    const nonZero = hooks.decapsulated.filter((ss) => ss.some((b) => b !== 0));
    expect(nonZero.length).toBeLessThanOrEqual(2); // 每一方最多一份等混入的
  });

  it('#4 initBob 沒給 kemSeed：exportState 直接拒絕，而且不銷毀會話（以前會先銷毀再匯出一份還原不了的狀態）', async () => {
    const { alice, bob } = pair({ bobSeed: false });
    await expect(bob.exportState()).rejects.toThrow(/kemSeed/);
    expect(read(await bob.decrypt(await alice.encrypt(text('still here'))))).toBe('still here');
  });

  it('#7 新鏈的 pn 與 n 各自在上限內、合計超過 maxSkippedKeys → 在 MAC 之前就拒絕（偽造訊息最多逼我們算 maxSkip 次 HMAC）', async () => {
    const { alice, bob } = pair({ maxSkippedKeys: 100 });
    await bob.decrypt(await alice.encrypt(text('start')));
    for (let i = 0; i < 60; i += 1) await alice.encrypt(text('lost')); // 舊鏈掉 60 則
    await alice.decrypt(await bob.encrypt(text('b')));
    for (let i = 0; i < 50; i += 1) await alice.encrypt(text('lost')); // 新鏈再掉 50 則
    const late = await alice.encrypt(text('late'));
    await expect(bob.decrypt(late)).rejects.toThrow(/跳過/);
  });

  it('#8 fromState 拒絕不一致的後量子狀態：同一把公鑰已封裝卻還留著、不合法的公鑰、看門狗計數超過上限、刪掉傳送鏈、retired 不是陣列、跳過金鑰的序號超過上限', async () => {
    const { alice, bob } = pair({ interval: 2 });
    await bob.decrypt(await alice.encrypt(text('start')));
    await alice.decrypt(await bob.encrypt(text('confirm'))); // Alice 拿到 Bob 的 1 號公鑰
    const j = JSON.parse(new TextDecoder().decode(await alice.exportState())) as Record<string, unknown>;
    expect(typeof j.peerKemPk).toBe('string');
    const load = (patch: Record<string, unknown>) => DoubleRatchetSession.fromState(new TextEncoder().encode(JSON.stringify({ ...j, ...patch })));
    expect(() => load({})).not.toThrow();
    const pk = Uint8Array.from(atob(j.peerKemPk as string), (c) => c.charCodeAt(0));
    pk[0] = 0xff;
    pk[1] = pk[1]! | 0x0f;
    expect(() => load({ peerKemPk: btoa(String.fromCharCode(...pk)) })).toThrow(/peerKemPk/);
    const ct = btoa(String.fromCharCode(...new Uint8Array(1088)));
    expect(() => load({ outId: j.peerKemId, outCt: ct, outSs: 'ab'.repeat(32) })).toThrow(/peerKemPk/);
    expect(() => load({ outStall: 1_000_000 })).toThrow(/outStall/);
    expect(() => load({ pkStall: 17 })).toThrow(/pkStall/);
    expect(() => load({ cks: undefined })).toThrow(/cks/);
    expect(() => load({ retired: 'x' })).toThrow(/retired/);
    expect(() => load({ skipped: [[`${'a'.repeat(64)}:99999999999`, 'ab'.repeat(32)]] })).toThrow(/skipped/);
  });
});
