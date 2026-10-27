// 混合式金鑰封裝（後量子 EK Phase 2／3）。
//
// 🔴 本檔最重要的一組測試是「**少任何一半就導不出同一把金鑰**」。
// 原因見 `hybrid-kem.ts` 檔頭：混合式 KDF 若把古典那一半接錯，結果是**降低了古典
// 安全性**去換一個還沒人需要的後量子性質——而那種錯誤**不會讓任何功能測試變紅**，
// 兩端照樣算得出同一把金鑰、訊息照樣送得到。只有針對性的測試抓得到。

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  generatePqSeed,
  hybridConversationKey,
  PQ_CIPHERTEXT_BYTES,
  PQ_PUBLIC_KEY_BYTES,
  PQ_SECRET_KEY_BYTES,
  PQ_SEED_BYTES,
  pqDecapsulate,
  pqEncapsulate,
  pqKeyFromSeed,
} from "../../src/protocol/hybrid-kem.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
/** 一對新的 ML-KEM 金鑰（種子隨機）。 */
const newKey = () => pqKeyFromSeed(generatePqSeed());

describe("ML-KEM-768 原語", () => {
  it("金鑰與密文的長度符合 FIPS 203（訊息體積的成本就是這個數字）", () => {
    const kp = newKey();
    expect(kp.pk.length).toBe(PQ_PUBLIC_KEY_BYTES);
    expect(kp.pk.length).toBe(1184);
    expect(kp.sk.length).toBe(PQ_SECRET_KEY_BYTES);
    const { ct } = pqEncapsulate(kp.pk);
    expect(ct.length).toBe(PQ_CIPHERTEXT_BYTES);
    expect(ct.length).toBe(1088);
  });

  it("封裝／解封裝往返得到同一把共享祕密", () => {
    const kp = newKey();
    const { ct, ss } = pqEncapsulate(kp.pk);
    expect(hex(pqDecapsulate(kp.sk, ct))).toBe(hex(ss));
  });

  it("每次封裝都是新的（同一把公鑰兩次封裝不得相同）", () => {
    const kp = newKey();
    const a = pqEncapsulate(kp.pk);
    const b = pqEncapsulate(kp.pk);
    expect(hex(a.ct)).not.toBe(hex(b.ct));
    expect(hex(a.ss)).not.toBe(hex(b.ss));
  });

  it("🔴 隱式拒絕：密文被竄改**不會拋錯**，而是回一把不同的祕密", () => {
    // 這是 ML-KEM 的設計，不是缺陷。但讀程式的人必須知道「解封裝成功」≠「密文是好的」
    // ——真正的攔截在 NIP-44 那層的 MAC 驗證（落進 ADR-0316 的 maybeEkLoss 桶）。
    const kp = newKey();
    const { ct, ss } = pqEncapsulate(kp.pk);
    const tampered = new Uint8Array(ct);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    const got = pqDecapsulate(kp.sk, tampered); // 不拋
    expect(hex(got)).not.toBe(hex(ss));
  });

  it("用錯金鑰同樣不拋，只是得到不同的祕密", () => {
    const a = newKey();
    const b = newKey();
    const { ct, ss } = pqEncapsulate(a.pk);
    expect(hex(pqDecapsulate(b.sk, ct))).not.toBe(hex(ss));
  });
});

// ── 🔴 種子導出必須跨版本穩定（Phase 3）────────────────────────────────────────

describe("種子導出（只存 64 bytes，不存 2400）", () => {
  it("種子長度是 FIPS 203 的 d‖z", () => {
    expect(PQ_SEED_BYTES).toBe(64);
    expect(generatePqSeed().length).toBe(64);
  });

  it("同一顆種子永遠導出同一對金鑰", () => {
    const seed = new Uint8Array(64).fill(7);
    const a = pqKeyFromSeed(seed);
    const b = pqKeyFromSeed(seed);
    expect(hex(a.pk)).toBe(hex(b.pk));
    expect(hex(a.sk)).toBe(hex(b.sk));
  });

  it("🔴 釘死的測試向量——相依若改了導出方式，這條會紅", () => {
    // ⚠ 我們**只存種子**（64 bytes）而不存展開後的 2400-byte 私鑰（理由見 `PQ_SEED_BYTES`：
    // 實測 per-device 分發事件會從 4.5 KB 漲到 110 KB）。
    // 代價是：導出方式一變，既有種子就導出**不同的金鑰** ⇒ 所有訊息解不開。
    // FIPS 203 把 KeyGen(d,z) 標準化了，但 `@noble/post-quantum` 是 **pre-1.0**
    // ⇒ 用固定向量鎖住，升級相依時才會被告知而不是靜默壞掉。
    const seed = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) seed[i] = i;
    const kp = pqKeyFromSeed(seed);
    expect(kp.pk.length).toBe(1184);
    expect(hex(sha256(kp.pk))).toBe("0b7934c83125c788995e2ba6bd761e33046b3e40571be53e023309a29f398cc9");
  });

  it("不同種子導出不同金鑰", () => {
    expect(hex(newKey().pk)).not.toBe(hex(newKey().pk));
  });

  it("種子長度不對即拋", () => {
    expect(() => pqKeyFromSeed(new Uint8Array(32))).toThrow();
    expect(() => pqKeyFromSeed(new Uint8Array(0))).toThrow();
  });
});

describe("混合式對話金鑰", () => {
  /** 造一組完整的輸入（古典 ECDH ＋ ML-KEM）。 */
  const inputs = () => {
    const aSk = secp256k1.utils.randomSecretKey();
    const bSk = secp256k1.utils.randomSecretKey();
    const ssClassic = secp256k1.getSharedSecret(aSk, secp256k1.getPublicKey(bSk)).slice(1, 33);
    const kp = newKey();
    const { ct, ss: ssPq } = pqEncapsulate(kp.pk);
    return { ssClassic, ssPq, ct, kp };
  };

  it("輸出 32 bytes（NIP-44 對話金鑰的長度）", () => {
    const { ssClassic, ssPq, ct } = inputs();
    expect(hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" }).length).toBe(32);
  });

  it("同樣的輸入導出同樣的金鑰（雙方才算得出同一把）", () => {
    const { ssClassic, ssPq, ct } = inputs();
    const a = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    const b = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    expect(hex(a)).toBe(hex(b));
  });

  // ── 🔴 核心：兩半都必須參與 ─────────────────────────────────────────────

  it("🔴 換掉古典那一半 ⇒ 金鑰不同（證明古典真的有進 KDF）", () => {
    const { ssClassic, ssPq, ct } = inputs();
    const other = inputs().ssClassic;
    expect(hex(ssClassic)).not.toBe(hex(other));
    const a = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    const b = hybridConversationKey({ ssClassic: other, ssPq, ct, layer: "wrap" });
    expect(hex(a)).not.toBe(hex(b));
  });

  it("🔴 換掉後量子那一半 ⇒ 金鑰不同（證明 PQ 真的有進 KDF）", () => {
    const { ssClassic, ssPq, ct } = inputs();
    const other = inputs().ssPq;
    const a = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    const b = hybridConversationKey({ ssClassic, ssPq: other, ct, layer: "wrap" });
    expect(hex(a)).not.toBe(hex(b));
  });

  it("🔴 少任何一半 ⇒ **拋錯**，不得靜默退回單邊", () => {
    // 靜默退回正是檔頭警告的那個失敗模式：功能一切正常，而古典安全性被偷偷拿掉了。
    const { ssClassic, ssPq, ct } = inputs();
    expect(() => hybridConversationKey({ ssClassic: new Uint8Array(0), ssPq, ct, layer: "wrap" })).toThrow();
    expect(() => hybridConversationKey({ ssClassic, ssPq: new Uint8Array(0), ct, layer: "wrap" })).toThrow();
  });

  it("🔴 兩半不可互換位置（串接順序固定，否則兩端會導出不同的金鑰）", () => {
    const { ssClassic, ssPq, ct } = inputs();
    const a = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    const swapped = hybridConversationKey({ ssClassic: ssPq, ssPq: ssClassic, ct, layer: "wrap" });
    expect(hex(a)).not.toBe(hex(swapped));
  });

  // ── 綁定與域分離 ───────────────────────────────────────────────────────

  it("🔴 seal 與 wrap 兩層導出不同的金鑰（只帶一份 ct 的前提）", () => {
    // 省下 1452 bytes 的代價是兩層共用同一個 ssPq ⇒ 域分離必須真的生效。
    const { ssClassic, ssPq, ct } = inputs();
    const seal = hybridConversationKey({ ssClassic, ssPq, ct, layer: "seal" });
    const wrap = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    expect(hex(seal)).not.toBe(hex(wrap));
  });

  it("ct 有綁進去：同樣的兩個祕密、不同的 ct ⇒ 金鑰不同", () => {
    const { ssClassic, ssPq, ct } = inputs();
    const otherCt = inputs().ct;
    const a = hybridConversationKey({ ssClassic, ssPq, ct, layer: "wrap" });
    const b = hybridConversationKey({ ssClassic, ssPq, ct: otherCt, layer: "wrap" });
    expect(hex(a)).not.toBe(hex(b));
  });

  it("ct 長度不對即拋（避免把截斷的密文當成合法輸入）", () => {
    const { ssClassic, ssPq, ct } = inputs();
    expect(() => hybridConversationKey({ ssClassic, ssPq, ct: ct.slice(0, 100), layer: "wrap" })).toThrow();
  });

  it("端到端：寄件端封裝、收件端解封裝，兩邊導出同一把金鑰", () => {
    const aSk = secp256k1.utils.randomSecretKey();
    const bSk = secp256k1.utils.randomSecretKey();
    const bSeed = generatePqSeed();
    const bPq = pqKeyFromSeed(bSeed);

    // 寄件端（只知道對方的公鑰）
    const ssClassicSend = secp256k1.getSharedSecret(aSk, secp256k1.getPublicKey(bSk)).slice(1, 33);
    const { ct, ss: ssPqSend } = pqEncapsulate(bPq.pk);
    const kSend = hybridConversationKey({ ssClassic: ssClassicSend, ssPq: ssPqSend, ct, layer: "wrap" });

    // 收件端（只存了種子，用時才展開）
    const recovered = pqKeyFromSeed(bSeed);
    const ssClassicRecv = secp256k1.getSharedSecret(bSk, secp256k1.getPublicKey(aSk)).slice(1, 33);
    const ssPqRecv = pqDecapsulate(recovered.sk, ct);
    const kRecv = hybridConversationKey({ ssClassic: ssClassicRecv, ssPq: ssPqRecv, ct, layer: "wrap" });

    expect(hex(kSend)).toBe(hex(kRecv));
  });
});
