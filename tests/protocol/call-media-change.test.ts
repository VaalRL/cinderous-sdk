import { describe, expect, it } from "vitest";
import { CallSession, parseCallSignal, type CallAction } from "../../src/protocol/call.js";

/** 把一通通話推進到 active（主叫視角）。 */
function activeCaller(media: "audio" | "video" = "audio"): CallSession {
  const s = new CallSession();
  s.startCall("c1", media);
  s.localDescription("offer-sdp");
  s.onSignal({ type: "call-accept", callId: "c1", sdp: "answer-sdp" });
  s.onConnected();
  return s;
}

/** 把一通通話推進到 active（被叫視角）。 */
function activeCallee(media: "audio" | "video" = "audio"): CallSession {
  const s = new CallSession();
  s.onSignal({ type: "call-invite", callId: "c1", media, sdp: "offer-sdp" });
  s.accept();
  s.localDescription("answer-sdp");
  s.onConnected();
  return s;
}

const sent = (actions: CallAction[]): CallAction[] => actions.filter((a) => a.type === "send");

describe("通話中媒體型態升降級（ADR-0338）", () => {
  it("初始狀態：兩個方向都等於 invite 當時的型態", () => {
    const s = activeCaller("audio");
    expect(s.localMedia).toBe("audio");
    expect(s.remoteMedia).toBe("audio");
    expect(s.effectiveMedia).toBe("audio");

    const v = activeCaller("video");
    expect(v.localMedia).toBe("video");
    expect(v.remoteMedia).toBe("video");
  });

  it("升級：取得媒體 → 通知對端；**不產生任何 SDP 動作**", () => {
    const s = activeCaller("audio");
    const actions = s.setLocalMedia("video");
    // 整個功能不觸碰 SDP：沒有 create-offer / create-answer / set-remote（ADR-0338 §3）。
    expect(actions.map((a) => a.type)).toEqual(["acquire-media", "send"]);
    expect(actions[0]).toEqual({ type: "acquire-media", media: "video" });
    expect(sent(actions)[0]).toEqual({
      type: "send",
      signal: { type: "call-media", callId: "c1", media: "video" },
    });
  });

  it("🔴 升級只改自己這一邊——對端的型態不動（不會替對方開鏡頭）", () => {
    const s = activeCaller("audio");
    s.setLocalMedia("video");
    expect(s.localMedia).toBe("video");
    expect(s.remoteMedia).toBe("audio"); // 他沒答應也沒被強迫
    // 任一方為視訊 ⇒ 要開視訊版面。
    expect(s.effectiveMedia).toBe("video");
  });

  it("降級：只通知，不必再取媒體", () => {
    const s = activeCaller("video");
    const actions = s.setLocalMedia("audio");
    expect(actions.map((a) => a.type)).toEqual(["send"]);
    expect(s.localMedia).toBe("audio");
  });

  it("設成目前已是的型態＝什麼都不做（不送冗餘信令）", () => {
    const s = activeCaller("audio");
    expect(s.setLocalMedia("audio")).toEqual([]);
    const v = activeCaller("video");
    expect(v.setLocalMedia("video")).toEqual([]);
  });

  it("🔴 只有 active 時能改——其餘狀態一律空動作", () => {
    const outgoing = new CallSession();
    outgoing.startCall("c1", "audio");
    expect(outgoing.state).toBe("outgoing");
    expect(outgoing.setLocalMedia("video")).toEqual([]);

    const incoming = new CallSession();
    incoming.onSignal({ type: "call-invite", callId: "c1", media: "audio", sdp: "s" });
    expect(incoming.state).toBe("incoming");
    expect(incoming.setLocalMedia("video")).toEqual([]);

    const connecting = new CallSession();
    connecting.startCall("c1", "audio");
    connecting.localDescription("o");
    connecting.onSignal({ type: "call-accept", callId: "c1", sdp: "a" });
    expect(connecting.state).toBe("connecting");
    expect(connecting.setLocalMedia("video")).toEqual([]);

    expect(new CallSession().setLocalMedia("video")).toEqual([]);
  });

  it("收到對端的 call-media：更新 remoteMedia，不影響自己", () => {
    const s = activeCallee("audio");
    const actions = s.onSignal({ type: "call-media", callId: "c1", media: "video" });
    expect(actions).toEqual([]); // 純通知，執行期無事可做（軌道由 ontrack 進來）
    expect(s.remoteMedia).toBe("video");
    expect(s.localMedia).toBe("audio");
    expect(s.effectiveMedia).toBe("video");
  });

  it("別通的 call-media 一律忽略（callId 不符）", () => {
    const s = activeCallee("audio");
    s.onSignal({ type: "call-media", callId: "other", media: "video" });
    expect(s.remoteMedia).toBe("audio");
  });

  it("非通話中收到 call-media 不得改動任何狀態", () => {
    const s = new CallSession();
    s.onSignal({ type: "call-media", callId: "c1", media: "video" });
    expect(s.state).toBe("idle");
    expect(s.localMedia).toBeNull();
  });

  it("掛斷後兩個方向都清空（不留給下一通）", () => {
    const s = activeCaller("video");
    s.hangup();
    expect(s.localMedia).toBeNull();
    expect(s.remoteMedia).toBeNull();
    expect(s.effectiveMedia).toBeNull();
  });

  it("雙方同時升級不會互相覆蓋（各自方向獨立，無 glare）", () => {
    const s = activeCaller("audio");
    s.setLocalMedia("video");
    s.onSignal({ type: "call-media", callId: "c1", media: "video" });
    expect(s.localMedia).toBe("video");
    expect(s.remoteMedia).toBe("video");
  });

  describe("線路格式（信任邊界）", () => {
    it("解析合法的 call-media", () => {
      expect(parseCallSignal(JSON.stringify({ type: "call-media", callId: "c1", media: "video" }))).toEqual({
        type: "call-media",
        callId: "c1",
        media: "video",
      });
    });

    it("media 非法 → 丟例外（不讓髒值進狀態機）", () => {
      expect(() => parseCallSignal(JSON.stringify({ type: "call-media", callId: "c1", media: "3d" }))).toThrow();
      expect(() => parseCallSignal(JSON.stringify({ type: "call-media", callId: "c1" }))).toThrow();
    });

    it("call-media 不帶 sdp——帶了也不會被讀進來（ADR-0338 §3）", () => {
      const parsed = parseCallSignal(
        JSON.stringify({ type: "call-media", callId: "c1", media: "video", sdp: "偷渡的" }),
      );
      expect(parsed).not.toHaveProperty("sdp");
    });
  });
});
