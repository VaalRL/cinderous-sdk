import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { sealAndWrap } from "../../src/protocol/nip59.js";
import {
  CandidateBatch,
  createSignal,
  parseSignal,
  readSignal,
  SDP_SIGNAL_KIND,
  type Signal,
} from "../../src/protocol/signaling.js";

const aliceSk = generateSecretKey();
const alicePk = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const bobPk = getPublicKey(bobSk);

describe("WebRTC SDP 信令（NIP-59 包封 ephemeral）", () => {
  it("offer 往返還原並驗證寄件人", () => {
    const offer: Signal = { type: "offer", sdp: "v=0...fake-offer" };
    const evt = createSignal(offer, aliceSk, bobPk, { now: 1_700_000_000 });
    const { sender, signal } = readSignal(evt, bobSk);
    expect(sender).toBe(alicePk);
    expect(signal).toEqual(offer);
  });

  it("candidate 往返（含 sdpMid/sdpMLineIndex）", () => {
    const cand: Signal = {
      type: "candidate",
      candidate: "candidate:1 1 UDP ...",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const evt = createSignal(cand, aliceSk, bobPk);
    expect(readSignal(evt, bobSk).signal).toEqual(cand);
  });

  it("外層為 21000-21999 ephemeral、帶 #p、作者非寄件人（隱藏誰呼叫誰）", () => {
    const evt = createSignal({ type: "answer", sdp: "ans" }, aliceSk, bobPk);
    expect(evt.kind).toBeGreaterThanOrEqual(21000);
    expect(evt.kind).toBeLessThanOrEqual(21999);
    expect(evt.kind).toBe(SDP_SIGNAL_KIND);
    expect(evt.tags).toContainEqual(["p", bobPk]);
    expect(evt.pubkey).not.toBe(alicePk);
    // ephemeral：不應帶 NIP-40 過期
    expect(evt.tags.find((t) => t[0] === "expiration")).toBeUndefined();
  });

  it("第三者無法讀取信令", () => {
    const evt = createSignal({ type: "offer", sdp: "x" }, aliceSk, bobPk);
    expect(() => readSignal(evt, generateSecretKey())).toThrow();
  });
});

describe("信令結構驗證（C5）", () => {
  it("合法 offer/candidate 通過", () => {
    expect(parseSignal(JSON.stringify({ type: "offer", sdp: "x" }))).toEqual({ type: "offer", sdp: "x" });
    expect(parseSignal(JSON.stringify({ type: "candidate", candidate: "c" }))).toEqual({
      type: "candidate",
      candidate: "c",
    });
  });

  it("缺欄位或未知類型拋錯", () => {
    expect(() => parseSignal(JSON.stringify({ type: "offer" }))).toThrow();
    expect(() => parseSignal(JSON.stringify({ type: "candidate" }))).toThrow();
    expect(() => parseSignal(JSON.stringify({ type: "bogus" }))).toThrow();
    expect(() => parseSignal("123")).toThrow();
  });

  it("批次 candidates 往返、過濾非法項", () => {
    const sig: Signal = {
      type: "candidates",
      candidates: [
        { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 },
        { candidate: "c2" },
      ],
    };
    const evt = createSignal(sig, aliceSk, bobPk);
    expect(readSignal(evt, bobSk).signal).toEqual(sig);
    // 非法項（缺 candidate）被過濾
    const parsed = parseSignal(JSON.stringify({ type: "candidates", candidates: [{ candidate: "ok" }, { x: 1 }] }));
    expect(parsed).toEqual({ type: "candidates", candidates: [{ candidate: "ok" }] });
  });

  it("CandidateBatch 累積後 drain 為單一批次、清空", () => {
    const b = new CandidateBatch();
    expect(b.drain()).toBeNull();
    b.add({ candidate: "a" });
    b.add({ candidate: "b", sdpMid: "0" });
    expect(b.size).toBe(2);
    const drained = b.drain();
    expect(drained).toEqual({ type: "candidates", candidates: [{ candidate: "a" }, { candidate: "b", sdpMid: "0" }] });
    expect(b.size).toBe(0);
    expect(b.drain()).toBeNull();
  });

  it("readSignal 對結構非法的內層內容拋錯", () => {
    const bad = sealAndWrap(
      { kind: SDP_SIGNAL_KIND, created_at: 1, tags: [], content: JSON.stringify({ type: "bogus" }) },
      aliceSk,
      bobPk,
      { kind: SDP_SIGNAL_KIND, tags: [["p", bobPk]] },
    );
    expect(() => readSignal(bad, bobSk)).toThrow();
  });
});
