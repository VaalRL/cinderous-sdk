// 分框（SDK ADR 0009 §2）：DataChannel 與中繼兩條軌道共用同一種框。
//
// 框頭 17 位元組：[0] 版本、[1..9) 訊息 id、[9..13) 序號、[13..17) 總數（大端序）。
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 17;
/** DataChannel 每框承載 16 KB（ADR 0006）：瀏覽器之間相容性最好的訊息大小。 */
export const FRAME_PAYLOAD_BYTES = 16 * 1024;
/**
 * 中繼軌每框承載 48,000 B（ADR 0006，同 Cinderous 的檔案塊 kind 1060）。
 * 包兩層 NIP-44 後約 131 KB，低於中繼單則上限 262,144 B（ADR 0009 更正）。
 */
export const RELAY_FRAME_PAYLOAD_BYTES = 48_000;
/** 收端接受的單框承載上限：兩條軌道中較大的那個。 */
export const MAX_FRAME_PAYLOAD_BYTES = RELAY_FRAME_PAYLOAD_BYTES;
/** 一則訊息預設上限 64 MB：對方宣稱的總數超過就整則不收。 */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** 組到一半的訊息預設 60 秒沒收齊就丟掉。 */
export const DEFAULT_ASSEMBLY_TIMEOUT_MS = 60_000;
const ID_BYTES = 8;
/** 把一則訊息切成框。空資料也是一框，對方才收得到「空訊息」。 */
export function encodeFrames(data, payloadBytes = FRAME_PAYLOAD_BYTES) {
    const id = randomBytes(ID_BYTES);
    const total = Math.max(1, Math.ceil(data.length / payloadBytes));
    const frames = [];
    for (let seq = 0; seq < total; seq += 1) {
        const payload = data.subarray(seq * payloadBytes, (seq + 1) * payloadBytes);
        const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
        const view = new DataView(frame.buffer);
        frame[0] = FRAME_VERSION;
        frame.set(id, 1);
        view.setUint32(9, seq);
        view.setUint32(13, total);
        frame.set(payload, FRAME_HEADER_BYTES);
        frames.push(frame);
    }
    return frames;
}
/** 解開一框；格式不對就回 null（對方送什麼都不該讓我們拋例外）。 */
export function decodeFrame(frame) {
    if (frame.length < FRAME_HEADER_BYTES || frame[0] !== FRAME_VERSION)
        return null;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const seq = view.getUint32(9);
    const total = view.getUint32(13);
    if (total === 0 || seq >= total)
        return null;
    return { id: bytesToHex(frame.subarray(1, 1 + ID_BYTES)), seq, total, payload: frame.subarray(FRAME_HEADER_BYTES) };
}
/** 已交出的訊息 id 記住多少筆（擋掉晚到的重複框）。 */
const COMPLETED_MEMORY = 1_024;
/** 把框組回訊息：亂序可、重複可，逾時或過大的整則丟掉。 */
export class FrameAssembler {
    #pending = new Map();
    #completed = new Set();
    #maxBytes;
    #timeoutMs;
    #now;
    constructor(opts = {}) {
        this.#maxBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
        this.#timeoutMs = opts.timeoutMs ?? DEFAULT_ASSEMBLY_TIMEOUT_MS;
        this.#now = opts.now ?? Date.now;
    }
    get pendingCount() {
        return this.#pending.size;
    }
    /** 收一框；收齊時回傳整則訊息，否則回 undefined。 */
    push(raw) {
        const now = this.#now();
        for (const [id, pending] of this.#pending) {
            if (now - pending.startedAt > this.#timeoutMs) {
                this.#pending.delete(id);
                this.#remember(id); // 逾時的也記住：之後補來的框不該重新開一則殘缺的
            }
        }
        const frame = decodeFrame(raw);
        if (!frame || this.#completed.has(frame.id) || frame.payload.length > MAX_FRAME_PAYLOAD_BYTES)
            return undefined;
        // 非最後一框是滿的：由它推得出整則的大小，太大就不必等收齊才發現
        const claimed = frame.seq < frame.total - 1 ? (frame.total - 1) * frame.payload.length : 0;
        if (claimed > this.#maxBytes) {
            this.#drop(frame.id);
            return undefined;
        }
        let pending = this.#pending.get(frame.id);
        if (!pending) {
            pending = { total: frame.total, parts: new Map(), bytes: 0, startedAt: now };
            this.#pending.set(frame.id, pending);
        }
        if (pending.total !== frame.total || pending.parts.has(frame.seq))
            return undefined; // 總數對不上、或重複的框
        pending.parts.set(frame.seq, frame.payload.slice());
        pending.bytes += frame.payload.length;
        if (pending.bytes > this.#maxBytes) {
            this.#drop(frame.id); // 以實際收到的量為準：對方謊報框大小也撐不爆
            return undefined;
        }
        if (pending.parts.size < pending.total)
            return undefined;
        this.#pending.delete(frame.id);
        this.#remember(frame.id);
        let length = 0;
        for (const part of pending.parts.values())
            length += part.length;
        const out = new Uint8Array(length);
        let offset = 0;
        for (let seq = 0; seq < pending.total; seq += 1) {
            const part = pending.parts.get(seq);
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }
    #drop(id) {
        this.#pending.delete(id);
        this.#remember(id);
    }
    #remember(id) {
        this.#completed.add(id);
        if (this.#completed.size > COMPLETED_MEMORY) {
            const oldest = this.#completed.values().next().value;
            if (oldest !== undefined)
                this.#completed.delete(oldest);
        }
    }
}
//# sourceMappingURL=frames.js.map