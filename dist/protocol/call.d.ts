import type { NostrEvent } from "./event.js";
import type { PubkeyHex } from "./keys.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** 通話控制信令使用的 ephemeral kind（與 SDP 資料通道信令 21000 區隔）。 */
export declare const CALL_SIGNAL_KIND = 21002;
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
export type CallSignal = CallInvite | CallAccept | CallReject | CallHangup | CallCandidate | CallMediaChange;
/** 通話狀態（單一通話槽的本端視角）。 */
export type CallState = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";
/**
 * 狀態機要求執行期採取的動作。執行期（RTCPeerConnection + getUserMedia）落實，
 * 並把本端產生的 SDP 以 {@link CallSession.localDescription} 回饋。
 */
export type CallAction = {
    type: "acquire-media";
    media: CallMedia;
} | {
    type: "create-offer";
} | {
    type: "create-answer";
} | {
    type: "set-remote";
    sdp: string;
    kind: "offer" | "answer";
} | {
    type: "send";
    signal: CallSignal;
} | {
    type: "ended";
    reason: CallEndReason;
} | {
    type: "close";
};
/** 通話生命週期狀態機（與 I/O 無關，便於單元測試）。 */
export declare class CallSession {
    private _state;
    private callId;
    /** invite 當時談定的型態；升降級後仍保留，供 `accept()` 取媒體用。 */
    private media;
    /** 我正在送什麼（ADR-0338）。`null`＝沒有通話。 */
    private _localMedia;
    /** 對方正在送什麼（ADR-0338）。與 `_localMedia` **各自獨立**。 */
    private _remoteMedia;
    private remoteOffer;
    /** 本端 SDP 產生後要送出的信令類型。 */
    private awaiting;
    get state(): CallState;
    get activeCallId(): string | null;
    /** 我正在送的媒體型態（ADR-0338）。 */
    get localMedia(): CallMedia | null;
    /** 對方正在送的媒體型態（ADR-0338）。 */
    get remoteMedia(): CallMedia | null;
    /**
     * 有效型態：**任一方**為視訊即視訊。UI 用它決定要不要開視訊版面
     * ——「他送視訊、我只送語音」也必須看得到他。
     */
    get effectiveMedia(): CallMedia | null;
    private idle;
    /** 主叫：發起通話。之後執行期取得媒體並建立 offer，再以 localDescription 回饋。 */
    startCall(callId: string, media: CallMedia): CallAction[];
    /** 被叫：接聽。執行期套用遠端 offer、取得媒體並建立 answer，再以 localDescription 回饋。 */
    accept(): CallAction[];
    /** 被叫：拒接。 */
    reject(): CallAction[];
    /** 任一方：掛斷（響鈴中或通話中）。 */
    hangup(): CallAction[];
    /** 執行期完成本端 SDP 後回饋，狀態機據此送出對應的通話信令。 */
    localDescription(sdp: string): CallAction[];
    /** 收到對端的通話控制信令。 */
    onSignal(signal: CallSignal): CallAction[];
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
    setLocalMedia(media: CallMedia): CallAction[];
    /** ICE/DTLS 連通後由執行期呼叫，轉為 active。 */
    onConnected(): CallAction[];
    private onInvite;
    private onAccept;
    /**
     * 對端改了他那一方的型態（ADR-0338）。純通知——他的軌道由 `ontrack` 自己進來，
     * 執行期無事可做，所以回傳空動作。
     */
    private onMediaChange;
    private onReject;
    private onHangup;
    private end;
}
/** 將通話控制信令封成 kind 21002 的 ephemeral Gift Wrap 事件。 */
export declare function createCallSignal(signal: CallSignal, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
senderSk: SecretKeyOrSigner, recipientPk: PubkeyHex, opts?: {
    now?: number;
}): NostrEvent;
/** 解開並驗證通話信令事件。 */
export declare function readCallSignal(event: NostrEvent, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
recipientSk: SecretKeyOrSigner): {
    sender: PubkeyHex;
    signal: CallSignal;
};
/** 解析並驗證通話信令結構（信任邊界檢查）。 */
export declare function parseCallSignal(content: string): CallSignal;
//# sourceMappingURL=call.d.ts.map