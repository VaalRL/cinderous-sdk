import { describe, expect, it } from "vitest";
import { getEventHash } from "../../src/protocol/event.js";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { DEFAULT_MAX_ITERATIONS, leadingZeroBits, meetsPow, minePow } from "../../src/protocol/pow.js";
import { verifyEvent } from "../../src/protocol/sign.js";

const template = (content = "x") => ({ kind: 1078, created_at: 1700000000, tags: [["t", "game"]], content });

describe("NIP-13 難度量測", () => {
  it("數 id 開頭的零位元", () => {
    expect(leadingZeroBits("f".repeat(64))).toBe(0);
    expect(leadingZeroBits("7" + "f".repeat(63))).toBe(1);
    expect(leadingZeroBits("0f" + "f".repeat(62))).toBe(4);
    expect(leadingZeroBits("00" + "f".repeat(62))).toBe(8);
    expect(leadingZeroBits("000f" + "f".repeat(60))).toBe(12);
  });
});

describe("minePow", () => {
  it("挖到目標難度，且事件仍然驗得過", () => {
    const sk = generateSecretKey();
    const e = minePow(template(), sk, 8);
    expect(leadingZeroBits(e.id)).toBeGreaterThanOrEqual(8);
    expect(verifyEvent(e)).toBe(true);
    expect(e.pubkey).toBe(getPublicKey(sk));
  });

  it("難度 0 等同直接簽章（不做無謂的迴圈）", () => {
    const sk = generateSecretKey();
    const e = minePow(template(), sk, 0);
    expect(e.tags.some((t) => t[0] === "nonce")).toBe(false);
    expect(verifyEvent(e)).toBe(true);
  });

  it("nonce tag 只有一個——每一輪是**換掉**它，不是疊上去", () => {
    const e = minePow(template(), generateSecretKey(), 8);
    expect(e.tags.filter((t) => t[0] === "nonce")).toHaveLength(1);
    expect(e.tags.find((t) => t[0] === "t")).toEqual(["t", "game"]); // 原有 tag 保留
  });

  it("nonce tag 帶自報的目標難度（NIP-13）", () => {
    const e = minePow(template(), generateSecretKey(), 8);
    expect(e.tags.find((t) => t[0] === "nonce")?.[2]).toBe("8");
  });

  it("🔴 已挖過的事件再挖一次不會累積 nonce", () => {
    const sk = generateSecretKey();
    const once = minePow(template(), sk, 4);
    const twice = minePow({ ...once, tags: once.tags }, sk, 4);
    expect(twice.tags.filter((t) => t[0] === "nonce")).toHaveLength(1);
  });

  it("挖不到就拋，不會無限轉——當掉比失敗難查", () => {
    expect(() => minePow(template(), generateSecretKey(), 24, { maxIterations: 32 })).toThrow(/挖礦未達難度/);
  });

  it("負數或非整數難度直接拒絕", () => {
    const sk = generateSecretKey();
    expect(() => minePow(template(), sk, -1)).toThrow(/非負整數/);
    expect(() => minePow(template(), sk, 1.5)).toThrow(/非負整數/);
  });

  it("上限是有意義的數字（期望嘗試次數＝2^難度）", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(2 ** 24);
  });
});

describe("meetsPow", () => {
  it("🔴 只看 id 的前導零，不信 nonce tag 自報的 target", () => {
    // 自報值是給人看的提示，不是證據——拿它當判準等於讓發送方自己決定及不及格。
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const lying = { kind: 1, created_at: 1, tags: [["nonce", "0", "32"]], content: "", pubkey };
    const id = getEventHash(lying);
    expect(meetsPow({ id }, 32)).toBe(leadingZeroBits(id) >= 32);
    expect(meetsPow({ id }, 0)).toBe(true);
  });
});
