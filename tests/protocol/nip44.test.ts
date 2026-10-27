import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { decryptDM, encryptDM } from "../../src/protocol/nip44.js";

describe("NIP-44 端到端加密", () => {
  const aliceSk = generateSecretKey();
  const alicePk = getPublicKey(aliceSk);
  const bobSk = generateSecretKey();
  const bobPk = getPublicKey(bobSk);

  it("收件人可解出寄件人加密的明文（含 Unicode）", () => {
    const msg = "嗨 Bob！🎵 secret";
    const ct = encryptDM(msg, aliceSk, bobPk);
    expect(decryptDM(ct, bobSk, alicePk)).toBe(msg);
  });

  it("密文不等於明文且每次不同（隨機 nonce）", () => {
    const msg = "same plaintext";
    const ct1 = encryptDM(msg, aliceSk, bobPk);
    const ct2 = encryptDM(msg, aliceSk, bobPk);
    expect(ct1).not.toBe(msg);
    expect(ct1).not.toBe(ct2);
  });

  it("第三者（錯誤金鑰）無法解密", () => {
    const ct = encryptDM("for bob only", aliceSk, bobPk);
    const eveSk = generateSecretKey();
    expect(() => decryptDM(ct, eveSk, alicePk)).toThrow();
  });
});
