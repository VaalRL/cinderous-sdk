import { openWrap, sealAndWrap } from "./nip59.js";
/** WebRTC 信令使用的 ephemeral kind（21000-21999，NIP-59 包封）。 */
export const SDP_SIGNAL_KIND = 21000;
/**
 * 將 WebRTC 信令封成 NIP-59 ephemeral 事件（kind 21000）。
 * 以 Gift Wrap 隱藏收發雙方，避免中繼站得知「誰在呼叫誰」；
 * 不帶 NIP-40 過期，僅供即時記憶體轉發。
 */
export function createSignal(signal, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
senderSk, recipientPk, opts = {}) {
    const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
    return sealAndWrap({ kind: SDP_SIGNAL_KIND, created_at: nowSec, tags: [], content: JSON.stringify(signal) }, senderSk, recipientPk, { kind: SDP_SIGNAL_KIND, tags: [["p", recipientPk]] });
}
/** 解開並驗證信令事件，回傳寄件人與信令內容。內容結構非法時拋錯。 */
export function readSignal(event, recipientSk) {
    const { sender, rumor } = openWrap(event, recipientSk);
    return { sender, signal: parseSignal(rumor.content) };
}
/** 解析並驗證信令內容結構（信任邊界檢查，避免後續 undefined 連鎖）。 */
export function parseSignal(content) {
    const value = JSON.parse(content);
    if (typeof value !== "object" || value === null) {
        throw new Error("信令格式錯誤：非物件");
    }
    const s = value;
    if (s.type === "offer" || s.type === "answer") {
        if (typeof s.sdp !== "string")
            throw new Error("信令缺少 sdp");
        return { type: s.type, sdp: s.sdp };
    }
    if (s.type === "candidate") {
        if (typeof s.candidate !== "string")
            throw new Error("信令缺少 candidate");
        return { type: "candidate", ...parseIce(s) };
    }
    if (s.type === "candidates") {
        if (!Array.isArray(s.candidates))
            throw new Error("candidates 非陣列");
        const list = [];
        for (const raw of s.candidates) {
            if (raw && typeof raw === "object" && typeof raw.candidate === "string") {
                list.push(parseIce(raw));
            }
        }
        return { type: "candidates", candidates: list };
    }
    throw new Error(`未知信令類型：${String(s.type)}`);
}
/** 從物件抽出 ICE candidate 欄位（只保留有效的可選欄位）。 */
function parseIce(s) {
    const out = { candidate: s.candidate };
    if (typeof s.sdpMid === "string")
        out.sdpMid = s.sdpMid;
    if (typeof s.sdpMLineIndex === "number")
        out.sdpMLineIndex = s.sdpMLineIndex;
    return out;
}
/**
 * ICE candidate 批次緩衝（A6）：短時間累積候選，`drain()` 一次取出為單一
 * {@link CandidatesSignal}，讓執行期以一則信令送出多個候選，減少中繼發佈數。
 */
export class CandidateBatch {
    buf = [];
    add(candidate) {
        this.buf.push(candidate);
    }
    get size() {
        return this.buf.length;
    }
    /** 取出目前緩衝為批次信令並清空；空時回傳 null。 */
    drain() {
        if (this.buf.length === 0)
            return null;
        const candidates = this.buf;
        this.buf = [];
        return { type: "candidates", candidates };
    }
}
//# sourceMappingURL=signaling.js.map