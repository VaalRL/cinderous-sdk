import { describe, expect, it } from "vitest";
import {
  CallSession,
  createCallSignal,
  parseCallSignal,
  readCallSignal,
  type CallAction,
  type CallSignal,
} from "../../src/protocol/call.js";
import { CALL_SIGNAL_KIND } from "../../src/protocol/call.js";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";

const aliceSk = generateSecretKey();
const alicePk = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const bobPk = getPublicKey(bobSk);

/** 從動作串取出要送出的信令。 */
const sent = (actions: CallAction[]): CallSignal[] =>
  actions.filter((a): a is Extract<CallAction, { type: "send" }> => a.type === "send").map((a) => a.signal);
const has = (actions: CallAction[], type: CallAction["type"]) => actions.some((a) => a.type === type);

describe("通話狀態機（M8 信令核心）", () => {
  it("主叫完整流程：發起→送 invite→收 accept→連通→active", () => {
    const c = new CallSession();
    const a1 = c.startCall("call-1", "audio");
    expect(c.state).toBe("outgoing");
    expect(has(a1, "acquire-media")).toBe(true);
    expect(has(a1, "create-offer")).toBe(true);

    // 執行期建立 offer 後回饋 → 送出 invite
    const a2 = c.localDescription("OFFER_SDP");
    expect(sent(a2)).toEqual([{ type: "call-invite", callId: "call-1", media: "audio", sdp: "OFFER_SDP" }]);

    // 收到被叫 accept → 套用遠端 answer、轉 connecting
    const a3 = c.onSignal({ type: "call-accept", callId: "call-1", sdp: "ANSWER_SDP" });
    expect(c.state).toBe("connecting");
    expect(a3).toContainEqual({ type: "set-remote", sdp: "ANSWER_SDP", kind: "answer" });

    // ICE 連通 → active
    c.onConnected();
    expect(c.state).toBe("active");
  });

  it("被叫完整流程：收 invite→incoming→接聽→送 accept→連通", () => {
    const c = new CallSession();
    const a1 = c.onSignal({ type: "call-invite", callId: "call-2", media: "video", sdp: "OFFER_SDP" });
    expect(c.state).toBe("incoming");
    expect(a1).toEqual([]); // 僅響鈴，不自動回覆

    const a2 = c.accept();
    expect(c.state).toBe("connecting");
    expect(a2).toContainEqual({ type: "set-remote", sdp: "OFFER_SDP", kind: "offer" });
    expect(has(a2, "acquire-media")).toBe(true);
    expect(has(a2, "create-answer")).toBe(true);

    const a3 = c.localDescription("ANSWER_SDP");
    expect(sent(a3)).toEqual([{ type: "call-accept", callId: "call-2", sdp: "ANSWER_SDP" }]);

    c.onConnected();
    expect(c.state).toBe("active");
  });

  it("被叫拒接：送 call-reject(declined) 並結束", () => {
    const c = new CallSession();
    c.onSignal({ type: "call-invite", callId: "c3", media: "audio", sdp: "O" });
    const a = c.reject();
    expect(sent(a)).toEqual([{ type: "call-reject", callId: "c3", reason: "declined" }]);
    expect(has(a, "close")).toBe(true);
    expect(c.state).toBe("ended");
  });

  it("主叫收到 reject → 結束（含 ended 原因）", () => {
    const c = new CallSession();
    c.startCall("c4", "audio");
    c.localDescription("O");
    const a = c.onSignal({ type: "call-reject", callId: "c4", reason: "declined" });
    expect(a).toContainEqual({ type: "ended", reason: "declined" });
    expect(c.state).toBe("ended");
  });

  it("忙線：通話中又收到新 invite → 回 busy，且不影響現有通話", () => {
    const c = new CallSession();
    c.startCall("c5", "audio");
    c.localDescription("O");
    c.onSignal({ type: "call-accept", callId: "c5", sdp: "A" });
    c.onConnected();
    expect(c.state).toBe("active");

    const a = c.onSignal({ type: "call-invite", callId: "other", media: "audio", sdp: "O2" });
    expect(sent(a)).toEqual([{ type: "call-reject", callId: "other", reason: "busy" }]);
    expect(c.state).toBe("active"); // 現有通話不受影響
    expect(c.activeCallId).toBe("c5");
  });

  it("任一方掛斷：送 call-hangup 並結束", () => {
    const c = new CallSession();
    c.startCall("c6", "video");
    c.localDescription("O");
    c.onSignal({ type: "call-accept", callId: "c6", sdp: "A" });
    const a = c.hangup();
    expect(sent(a)).toEqual([{ type: "call-hangup", callId: "c6" }]);
    expect(c.state).toBe("ended");
  });

  it("收到對端 hangup → 結束", () => {
    const c = new CallSession();
    c.onSignal({ type: "call-invite", callId: "c7", media: "audio", sdp: "O" });
    c.accept();
    c.localDescription("A");
    c.onConnected();
    const a = c.onSignal({ type: "call-hangup", callId: "c7" });
    expect(has(a, "close")).toBe(true);
    expect(c.state).toBe("ended");
  });

  it("忽略不相干 callId 的信令", () => {
    const c = new CallSession();
    c.startCall("mine", "audio");
    c.localDescription("O");
    expect(c.onSignal({ type: "call-accept", callId: "stranger", sdp: "A" })).toEqual([]);
    expect(c.state).toBe("outgoing");
    expect(c.onSignal({ type: "call-hangup", callId: "stranger" })).toEqual([]);
    expect(c.state).toBe("outgoing");
  });
});

describe("通話信令傳輸（NIP-59 ephemeral，隱藏雙方）", () => {
  it("收件人可還原信令與寄件人；外層作者非寄件人", () => {
    const invite: CallSignal = { type: "call-invite", callId: "x", media: "video", sdp: "SDP" };
    const evt = createCallSignal(invite, aliceSk, bobPk);
    expect(evt.kind).toBe(CALL_SIGNAL_KIND);
    expect(evt.pubkey).not.toBe(alicePk);
    const { sender, signal } = readCallSignal(evt, bobSk);
    expect(sender).toBe(alicePk);
    expect(signal).toEqual(invite);
  });

  it("兩端經加密信令完成完整握手（invite↔accept）直到雙方 active", () => {
    const alice = new CallSession();
    const bob = new CallSession();
    // 迷你傳輸：把某端送出的信令經真實 createCallSignal→readCallSignal 交給對端。
    const deliver = (from: CallAction[], fromSk: typeof aliceSk, toPk: typeof bobPk, toSk: typeof bobSk, to: CallSession) =>
      sent(from).flatMap((sig) => to.onSignal(readCallSignal(createCallSignal(sig, fromSk, toPk), toSk).signal));

    // Alice 發起 → 產生 offer → 送 invite 給 Bob
    alice.startCall("h1", "audio");
    const aInvite = alice.localDescription("OFFER");
    deliver(aInvite, aliceSk, bobPk, bobSk, bob);
    expect(bob.state).toBe("incoming");

    // Bob 接聽 → 產生 answer → 送 accept 給 Alice
    bob.accept();
    const bAccept = bob.localDescription("ANSWER");
    deliver(bAccept, bobSk, alicePk, aliceSk, alice);
    expect(alice.state).toBe("connecting");

    // 兩端 ICE 連通 → 皆 active
    alice.onConnected();
    bob.onConnected();
    expect(alice.state).toBe("active");
    expect(bob.state).toBe("active");
    expect(alice.activeCallId).toBe("h1");
    expect(bob.activeCallId).toBe("h1");
  });

  it("call-candidate：狀態機忽略（回空動作）、傳輸可還原", () => {
    const c = new CallSession();
    c.startCall("cc", "audio");
    c.localDescription("O");
    // 收到 candidate 不改變通話控制狀態
    expect(c.onSignal({ type: "call-candidate", callId: "cc", candidate: "cand:1", sdpMid: "0" })).toEqual([]);
    expect(c.state).toBe("outgoing");
    // 傳輸 round-trip
    const evt = createCallSignal(
      { type: "call-candidate", callId: "cc", candidate: "cand:1", sdpMid: "0", sdpMLineIndex: 0 },
      aliceSk,
      bobPk,
    );
    const { signal } = readCallSignal(evt, bobSk);
    expect(signal).toEqual({ type: "call-candidate", callId: "cc", candidate: "cand:1", sdpMid: "0", sdpMLineIndex: 0 });
  });

  it("parseCallSignal 拒絕非法結構", () => {
    expect(() => parseCallSignal("{}")).toThrow();
    expect(() => parseCallSignal(JSON.stringify({ type: "call-invite", callId: "x" }))).toThrow();
    expect(() => parseCallSignal(JSON.stringify({ type: "call-invite", callId: "x", media: "text", sdp: "s" }))).toThrow();
    expect(() => parseCallSignal(JSON.stringify({ type: "nope", callId: "x" }))).toThrow();
  });
});
