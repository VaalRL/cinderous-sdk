// 語音/視訊通話信令核心（M8）。
//
// 通話控制信令（invite/accept/reject/hangup）走既有 NIP-59 ephemeral 通道
// （Gift Wrap 包封，隱藏「誰在呼叫誰」），與資料通道信令（signaling.ts 的
// offer/answer/candidate）以不同 kind 區隔。ICE candidate 的細節由執行期
// （RTCPeerConnection）處理；本模組專注「通話生命週期狀態機」，純邏輯、可測。

import type { NostrEvent } from "./event.js";
import type { PubkeyHex } from "./keys.js";
import { openWrap, sealAndWrap } from "./nip59.js";
import type { SecretKeyOrSigner } from "./signer.js";

/** 通話控制信令使用的 ephemeral kind（與 SDP 資料通道信令 21000 區隔）。 */
export const CALL_SIGNAL_KIND = 21002;

/** 通話媒體種類。 */
export type CallMedia = "audio" | "video";

/** 掛斷/拒接原因。 */
export type CallEndReason = "declined" | "busy" | "hangup";

/**
 * 通話**連線失敗**原因（ADR-0243，供 UI 提示）：
 * - `unreachable`：ICE 從未打通就失敗——多為對稱 NAT／嚴格防火牆下無公共 TURN 退路（可改網路重試）。
 * - `lost`：已連上後中途斷線——多為網路不穩（可再撥）。
 */
export type CallFailureReason = "unreachable" | "lost";

export interface CallInvite {
  type: "call-invite";
  callId: string;
  media: CallMedia;
  /** 主叫端的 SDP offer。 */
  sdp: string;
}
export interface CallAccept {
  type: "call-accept";
  callId: string;
  /** 被叫端的 SDP answer。 */
  sdp: string;
}
export interface CallReject {
  type: "call-reject";
  callId: string;
  reason: "declined" | "busy";
}
export interface CallHangup {
  type: "call-hangup";
  callId: string;
}
/**
 * 通話中改變**自己這一方**的媒體型態（ADR-0338）。
 *
 * 🔴 **不帶 SDP，也不是請求。** 語意是「我從現在開始送 `media`」——因為視訊 transceiver
 * 在建立通話時就預先協商好了，換軌靠 `replaceTrack`，不需要重新協商（⇒ 沒有 glare）。
 *
 * ⚠ 它**不會**讓對端開鏡頭：媒體型態是每方向各自獨立的。
 */
export interface CallMediaChange {
  type: "call-media";
  callId: string;
  media: CallMedia;
}
export interface CallCandidate {
  type: "call-candidate";
  callId: string;
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

/**
 * 通話信令。控制信令（invite/accept/reject/hangup）驅動 {@link CallSession}；
 * `call-candidate` 為 trickle ICE，由執行期直接套用到通話的 RTCPeerConnection，
 * 狀態機不處理（`onSignal` 對其回傳空動作）。
 */
export type CallSignal =
  | CallInvite
  | CallAccept
  | CallReject
  | CallHangup
  | CallCandidate
  | CallMediaChange;

/** 通話狀態（單一通話槽的本端視角）。 */
export type CallState = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";

/**
 * 狀態機要求執行期採取的動作。執行期（RTCPeerConnection + getUserMedia）落實，
 * 並把本端產生的 SDP 以 {@link CallSession.localDescription} 回饋。
 */
export type CallAction =
  | { type: "acquire-media"; media: CallMedia }
  | { type: "create-offer" }
  | { type: "create-answer" }
  | { type: "set-remote"; sdp: string; kind: "offer" | "answer" }
  | { type: "send"; signal: CallSignal }
  | { type: "ended"; reason: CallEndReason }
  | { type: "close" };

/** 通話生命週期狀態機（與 I/O 無關，便於單元測試）。 */
export class CallSession {
  private _state: CallState = "idle";
  private callId: string | null = null;
  /** invite 當時談定的型態；升降級後仍保留，供 `accept()` 取媒體用。 */
  private media: CallMedia | null = null;
  /** 我正在送什麼（ADR-0338）。`null`＝沒有通話。 */
  private _localMedia: CallMedia | null = null;
  /** 對方正在送什麼（ADR-0338）。與 `_localMedia` **各自獨立**。 */
  private _remoteMedia: CallMedia | null = null;
  private remoteOffer: string | null = null;
  /** 本端 SDP 產生後要送出的信令類型。 */
  private awaiting: "invite" | "accept" | null = null;

  get state(): CallState {
    return this._state;
  }

  get activeCallId(): string | null {
    return this.callId;
  }

  /** 我正在送的媒體型態（ADR-0338）。 */
  get localMedia(): CallMedia | null {
    return this._localMedia;
  }

  /** 對方正在送的媒體型態（ADR-0338）。 */
  get remoteMedia(): CallMedia | null {
    return this._remoteMedia;
  }

  /**
   * 有效型態：**任一方**為視訊即視訊。UI 用它決定要不要開視訊版面
   * ——「他送視訊、我只送語音」也必須看得到他。
   */
  get effectiveMedia(): CallMedia | null {
    if (this._localMedia === null && this._remoteMedia === null) return null;
    return this._localMedia === "video" || this._remoteMedia === "video" ? "video" : "audio";
  }

  private idle(): boolean {
    return this._state === "idle" || this._state === "ended";
  }

  /** 主叫：發起通話。之後執行期取得媒體並建立 offer，再以 localDescription 回饋。 */
  startCall(callId: string, media: CallMedia): CallAction[] {
    if (!this.idle()) return [];
    this._state = "outgoing";
    this.callId = callId;
    this.media = media;
    this._localMedia = media;
    this._remoteMedia = media; // invite 談定的型態；之後各自可變（ADR-0338）
    this.awaiting = "invite";
    return [{ type: "acquire-media", media }, { type: "create-offer" }];
  }

  /** 被叫：接聽。執行期套用遠端 offer、取得媒體並建立 answer，再以 localDescription 回饋。 */
  accept(): CallAction[] {
    if (this._state !== "incoming" || !this.remoteOffer || !this.media) return [];
    this._state = "connecting";
    this.awaiting = "accept";
    return [
      { type: "set-remote", sdp: this.remoteOffer, kind: "offer" },
      { type: "acquire-media", media: this.media },
      { type: "create-answer" },
    ];
  }

  /** 被叫：拒接。 */
  reject(): CallAction[] {
    if (this._state !== "incoming" || !this.callId) return [];
    const callId = this.callId;
    this.end();
    return [
      { type: "send", signal: { type: "call-reject", callId, reason: "declined" } },
      { type: "ended", reason: "declined" },
      { type: "close" },
    ];
  }

  /** 任一方：掛斷（響鈴中或通話中）。 */
  hangup(): CallAction[] {
    if (this.idle() || !this.callId) return [];
    const callId = this.callId;
    this.end();
    return [
      { type: "send", signal: { type: "call-hangup", callId } },
      { type: "ended", reason: "hangup" },
      { type: "close" },
    ];
  }

  /** 執行期完成本端 SDP 後回饋，狀態機據此送出對應的通話信令。 */
  localDescription(sdp: string): CallAction[] {
    if (this.awaiting === "invite" && this.callId && this.media) {
      this.awaiting = null;
      return [
        { type: "send", signal: { type: "call-invite", callId: this.callId, media: this.media, sdp } },
      ];
    }
    if (this.awaiting === "accept" && this.callId) {
      this.awaiting = null;
      return [{ type: "send", signal: { type: "call-accept", callId: this.callId, sdp } }];
    }
    return [];
  }

  /** 收到對端的通話控制信令。 */
  onSignal(signal: CallSignal): CallAction[] {
    switch (signal.type) {
      case "call-invite":
        return this.onInvite(signal);
      case "call-accept":
        return this.onAccept(signal);
      case "call-reject":
        return this.onReject(signal);
      case "call-hangup":
        return this.onHangup(signal);
      case "call-media":
        return this.onMediaChange(signal);
      case "call-candidate":
        return []; // ICE candidate 由執行期直接處理。
    }
  }

  /**
   * 通話中改變**自己這一方**的媒體型態（ADR-0338）。
   *
   * 🔴 **不產生任何 SDP 動作**：視訊 transceiver 在建立通話時就預先協商好，
   * 換軌由執行期以 `replaceTrack` 完成 ⇒ 沒有重新協商，也就沒有 glare。
   *
   * ⚠ 只在 `active` 時有效——其餘狀態改型態會與初次協商賽跑，而那幾秒使用者按不到。
   *
   * ⚠ **升級時先 `acquire-media` 再 `send`**：取媒體可能失敗（使用者不給相機權限），
   * 先宣告後失敗會讓對端等一個永遠不會來的畫面（§6-3）。執行期若取媒體失敗，
   * 應把型態改回去而不是續送。
   */
  setLocalMedia(media: CallMedia): CallAction[] {
    if (this._state !== "active" || !this.callId) return [];
    if (this._localMedia === media) return []; // 沒變就不送冗餘信令
    this._localMedia = media;
    const notify: CallAction = {
      type: "send",
      signal: { type: "call-media", callId: this.callId, media },
    };
    // 降級不必再取媒體——執行期只要 replaceTrack(null) 並停掉相機。
    return media === "video" ? [{ type: "acquire-media", media }, notify] : [notify];
  }

  /** ICE/DTLS 連通後由執行期呼叫，轉為 active。 */
  onConnected(): CallAction[] {
    if (this._state !== "connecting") return [];
    this._state = "active";
    return [];
  }

  private onInvite(sig: CallInvite): CallAction[] {
    // 忙線：已在其他通話 → 回拒 busy，不改變本端狀態。
    if (!this.idle()) {
      return [{ type: "send", signal: { type: "call-reject", callId: sig.callId, reason: "busy" } }];
    }
    this._state = "incoming";
    this.callId = sig.callId;
    this.media = sig.media;
    this._localMedia = sig.media;
    this._remoteMedia = sig.media;
    this.remoteOffer = sig.sdp;
    return [];
  }

  private onAccept(sig: CallAccept): CallAction[] {
    if (this._state !== "outgoing" || sig.callId !== this.callId) return [];
    this._state = "connecting";
    return [{ type: "set-remote", sdp: sig.sdp, kind: "answer" }];
  }

  /**
   * 對端改了他那一方的型態（ADR-0338）。純通知——他的軌道由 `ontrack` 自己進來，
   * 執行期無事可做，所以回傳空動作。
   */
  private onMediaChange(sig: CallMediaChange): CallAction[] {
    if (sig.callId !== this.callId || this.idle()) return [];
    this._remoteMedia = sig.media;
    return [];
  }

  private onReject(sig: CallReject): CallAction[] {
    if (sig.callId !== this.callId || this.idle()) return [];
    this.end();
    return [{ type: "ended", reason: sig.reason }, { type: "close" }];
  }

  private onHangup(sig: CallHangup): CallAction[] {
    if (sig.callId !== this.callId || this.idle()) return [];
    this.end();
    return [{ type: "ended", reason: "hangup" }, { type: "close" }];
  }

  private end(): void {
    this._state = "ended";
    this.callId = null;
    this.media = null;
    this._localMedia = null;
    this._remoteMedia = null;
    this.remoteOffer = null;
    this.awaiting = null;
  }
}

// ── 傳輸（NIP-59 ephemeral，隱藏雙方） ──────────────────────────────────────

/** 將通話控制信令封成 kind 21002 的 ephemeral Gift Wrap 事件。 */
export function createCallSignal(
  signal: CallSignal,
  /** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
  senderSk: SecretKeyOrSigner,
  recipientPk: PubkeyHex,
  opts: { now?: number } = {},
): NostrEvent {
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  return sealAndWrap(
    { kind: CALL_SIGNAL_KIND, created_at: nowSec, tags: [], content: JSON.stringify(signal) },
    senderSk,
    recipientPk,
    { kind: CALL_SIGNAL_KIND, tags: [["p", recipientPk]] },
  );
}

/** 解開並驗證通話信令事件。 */
export function readCallSignal(
  event: NostrEvent,
  /** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
  recipientSk: SecretKeyOrSigner,
): { sender: PubkeyHex; signal: CallSignal } {
  const { sender, rumor } = openWrap(event, recipientSk);
  return { sender, signal: parseCallSignal(rumor.content) };
}

/** 解析並驗證通話信令結構（信任邊界檢查）。 */
export function parseCallSignal(content: string): CallSignal {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null) throw new Error("通話信令格式錯誤：非物件");
  const s = value as Record<string, unknown>;
  if (typeof s.callId !== "string" || s.callId.length === 0) throw new Error("通話信令缺少 callId");
  const callId = s.callId;
  switch (s.type) {
    case "call-invite":
      if (s.media !== "audio" && s.media !== "video") throw new Error("通話信令 media 非法");
      if (typeof s.sdp !== "string") throw new Error("call-invite 缺少 sdp");
      return { type: "call-invite", callId, media: s.media, sdp: s.sdp };
    case "call-accept":
      if (typeof s.sdp !== "string") throw new Error("call-accept 缺少 sdp");
      return { type: "call-accept", callId, sdp: s.sdp };
    case "call-reject":
      if (s.reason !== "declined" && s.reason !== "busy") throw new Error("call-reject reason 非法");
      return { type: "call-reject", callId, reason: s.reason };
    case "call-hangup":
      return { type: "call-hangup", callId };
    case "call-media":
      // 只讀 media——即使對端偷渡 sdp 也不會進到這裡（ADR-0338 §3：本信令不觸碰 SDP）。
      if (s.media !== "audio" && s.media !== "video") throw new Error("call-media media 非法");
      return { type: "call-media", callId, media: s.media };
    case "call-candidate": {
      if (typeof s.candidate !== "string") throw new Error("call-candidate 缺少 candidate");
      const out: CallCandidate = { type: "call-candidate", callId, candidate: s.candidate };
      if (typeof s.sdpMid === "string") out.sdpMid = s.sdpMid;
      if (typeof s.sdpMLineIndex === "number") out.sdpMLineIndex = s.sdpMLineIndex;
      return out;
    }
    default:
      throw new Error(`未知通話信令類型：${String(s.type)}`);
  }
}
