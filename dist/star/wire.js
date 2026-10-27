// 星狀會話的線路格式（SDK ADR 0030 §3）：跑在每一條成對的 `secureChannel`（雙棘輪）**裡面**。
//
// 雙棘輪的線路格式完全不動：這裡的位元組是棘輪加密前的明文。
//
// 封包：[0] 0xC5（標記，與 FileTransfer 0xCF、StreamTransfer 0xCB 不衝突，可共用同一條通道）
//       [1] 版本 1
//       [2] 旗標 bit0＝有序號（要進重排／重送）
//       [3..7)  鏈路序號 lseq（u32，1 起；無序號的封包是 0）
//       [7..11) 確認 ack（u32：我已連續收到對方的第幾號）
//       之後是 0～多筆紀錄：[類型 u8][長度 u32][內容]
//
// 一個封包裝多筆紀錄＝批次：後量子模式每則棘輪訊息固定帶 2,314 B 的 header，合併多筆小更新才攤得掉（ADR 0030 §6）。
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
export const STAR_MAGIC = 0xc5;
export const STAR_WIRE_VERSION = 1;
export const PACKET_HEADER_BYTES = 11;
export const RECORD_HEADER_BYTES = 5;
const FLAG_SEQUENCED = 0x01;
/** 一個封包最多幾筆紀錄 */
export const MAX_RECORDS_PER_PACKET = 4_096;
const PK_BYTES = 32;
const PK_HEX = /^[0-9a-f]{64}$/;
/** 成員自己報的顯示名稱（未經認證，只是標籤）上限 */
export const STAR_LABEL_MAX_BYTES = 64;
/** 邀請秘密長度（128 位元） */
export const STAR_INVITE_SECRET_BYTES = 16;
/** 單播一次最多指定幾位收件人 */
export const STAR_MAX_RECIPIENTS = 64;
export const RecordType = {
    Join: 1,
    Welcome: 2,
    Reject: 3,
    Leave: 4,
    End: 5,
    Send: 6,
    Deliver: 7,
    Roster: 8,
};
const REASON_CODES = ['left', 'kicked', 'overflow', 'timeout', 'replaced', 'desync', 'protocol', 'closed', 'host-closed', 'rate-limit'];
export function reasonCode(reason) {
    return REASON_CODES.indexOf(reason) + 1;
}
export function reasonFromCode(code) {
    return REASON_CODES[code - 1];
}
export function isStarPacket(data) {
    return data.length >= 2 && data[0] === STAR_MAGIC && data[1] === STAR_WIRE_VERSION;
}
export function encodePacket(sequenced, lseq, ack, records) {
    let size = PACKET_HEADER_BYTES;
    for (const r of records)
        size += RECORD_HEADER_BYTES + r.body.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out[0] = STAR_MAGIC;
    out[1] = STAR_WIRE_VERSION;
    out[2] = sequenced ? FLAG_SEQUENCED : 0;
    view.setUint32(3, lseq);
    view.setUint32(7, ack);
    let offset = PACKET_HEADER_BYTES;
    for (const r of records) {
        out[offset] = r.type;
        view.setUint32(offset + 1, r.body.length);
        out.set(r.body, offset + RECORD_HEADER_BYTES);
        offset += RECORD_HEADER_BYTES + r.body.length;
    }
    return out;
}
/** 解封包；格式不對回 null（對方送什麼都不該讓我們拋例外） */
export function decodePacket(data) {
    if (data.length < PACKET_HEADER_BYTES || !isStarPacket(data))
        return null;
    const flags = data[2];
    if ((flags & ~FLAG_SEQUENCED) !== 0)
        return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sequenced = (flags & FLAG_SEQUENCED) !== 0;
    const lseq = view.getUint32(3);
    const ack = view.getUint32(7);
    if (sequenced !== lseq > 0)
        return null;
    const records = [];
    let offset = PACKET_HEADER_BYTES;
    while (offset < data.length) {
        if (data.length - offset < RECORD_HEADER_BYTES || records.length >= MAX_RECORDS_PER_PACKET)
            return null;
        const type = data[offset];
        const length = view.getUint32(offset + 1);
        const start = offset + RECORD_HEADER_BYTES;
        if (length > data.length - start)
            return null;
        // 只有 LEAVE 可以是空的：擋掉「一包塞幾十萬筆空紀錄」的記憶體放大（安全審查 H2）
        if (length === 0 && type !== RecordType.Leave)
            return null;
        records.push({ type, body: data.subarray(start, start + length) });
        offset = start + length;
    }
    return { sequenced, lseq, ack, records };
}
// ── 紀錄內容 ──────────────────────────────────────────────
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });
/** 顯示名稱：去掉控制字元、截到上限（以位元組計，不切斷字元） */
export function sanitizeStarLabel(label) {
    if (typeof label !== 'string')
        return undefined;
    // eslint-disable-next-line no-control-regex
    let clean = label.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').trim();
    while (utf8.encode(clean).length > STAR_LABEL_MAX_BYTES)
        clean = Array.from(clean).slice(0, -1).join('');
    return clean.length > 0 ? clean : undefined;
}
function labelBytes(label) {
    const clean = sanitizeStarLabel(label);
    return clean ? utf8.encode(clean) : new Uint8Array(0);
}
function readLabel(bytes) {
    if (bytes.length === 0)
        return undefined;
    if (bytes.length > STAR_LABEL_MAX_BYTES)
        return null;
    try {
        return sanitizeStarLabel(fromUtf8.decode(bytes));
    }
    catch {
        return null;
    }
}
export function encodeJoin(secret, label) {
    const l = labelBytes(label);
    const body = new Uint8Array(STAR_INVITE_SECRET_BYTES + l.length);
    body.set(secret, 0);
    body.set(l, STAR_INVITE_SECRET_BYTES);
    return { type: RecordType.Join, body };
}
export function decodeJoin(body) {
    if (body.length < STAR_INVITE_SECRET_BYTES)
        return null;
    const label = readLabel(body.subarray(STAR_INVITE_SECRET_BYTES));
    if (label === null)
        return null;
    return { secret: body.slice(0, STAR_INVITE_SECRET_BYTES), label };
}
export function encodeJson(type, value) {
    return { type, body: utf8.encode(JSON.stringify(value)) };
}
function parseJson(body) {
    if (body.length > 64 * 1024)
        return undefined;
    try {
        return JSON.parse(fromUtf8.decode(body));
    }
    catch {
        return undefined;
    }
}
const isPk = (x) => typeof x === 'string' && PK_HEX.test(x);
const isSeq = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 1;
export function decodeWelcome(body) {
    const w = parseJson(body);
    if (!w || typeof w !== 'object')
        return null;
    if (typeof w.session !== 'string' || !/^[0-9a-f]{32}$/.test(w.session))
        return null;
    if (!isPk(w.host) || !isPk(w.you) || !isSeq(w.next))
        return null;
    if (typeof w.maxPayloadBytes !== 'number' || !Number.isSafeInteger(w.maxPayloadBytes) || w.maxPayloadBytes < 1)
        return null;
    if (!Array.isArray(w.members) || w.members.length > 1_024)
        return null;
    const members = [];
    for (const m of w.members) {
        if (!m || typeof m !== 'object' || !isPk(m.pubkey))
            return null;
        const label = sanitizeStarLabel(m.label);
        members.push(label ? { pubkey: m.pubkey, label } : { pubkey: m.pubkey });
    }
    return { session: w.session, host: w.host, you: w.you, next: w.next, members, maxPayloadBytes: w.maxPayloadBytes };
}
const REJECT_REASONS = ['invalid-invite', 'expired', 'revoked', 'used', 'full', 'banned', 'denied', 'closed'];
export function decodeReason(body, allowed) {
    const v = parseJson(body);
    return v && typeof v === 'object' && typeof v.reason === 'string' && allowed.includes(v.reason) ? v.reason : null;
}
export const decodeReject = (body) => decodeReason(body, REJECT_REASONS);
export const decodeEnd = (body) => decodeReason(body, REASON_CODES);
const SEND_VOLATILE = 0x01;
const SEND_ECHO = 0x02;
const SEND_UNICAST = 0x04;
export function encodeSend(s) {
    const to = s.to ?? [];
    const body = new Uint8Array(3 + to.length * PK_BYTES + s.payload.length);
    body[0] = (s.volatile ? SEND_VOLATILE : 0) | (s.echo ? SEND_ECHO : 0) | (s.to ? SEND_UNICAST : 0);
    body[1] = s.topic;
    body[2] = to.length;
    to.forEach((pk, i) => body.set(hexToBytes(pk), 3 + i * PK_BYTES));
    body.set(s.payload, 3 + to.length * PK_BYTES);
    return { type: RecordType.Send, body };
}
export function decodeSend(body) {
    if (body.length < 3)
        return null;
    const flags = body[0];
    if ((flags & ~(SEND_VOLATILE | SEND_ECHO | SEND_UNICAST)) !== 0)
        return null;
    const count = body[2];
    const unicast = (flags & SEND_UNICAST) !== 0;
    if (!unicast && count !== 0)
        return null;
    if (count > STAR_MAX_RECIPIENTS || body.length < 3 + count * PK_BYTES)
        return null;
    const to = [];
    for (let i = 0; i < count; i += 1)
        to.push(bytesToHex(body.subarray(3 + i * PK_BYTES, 3 + (i + 1) * PK_BYTES)));
    return {
        volatile: (flags & SEND_VOLATILE) !== 0,
        echo: (flags & SEND_ECHO) !== 0,
        topic: body[1],
        to: unicast ? to : undefined,
        payload: body.subarray(3 + count * PK_BYTES),
    };
}
const DELIVER_UNICAST = 0x01;
const DELIVER_VOLATILE = 0x02;
function writeSeq(view, offset, seq) {
    view.setUint32(offset, Math.floor(seq / 0x1_0000_0000));
    view.setUint32(offset + 4, seq >>> 0);
}
function readSeq(view, offset) {
    return view.getUint32(offset) * 0x1_0000_0000 + view.getUint32(offset + 4);
}
/** 轉送紀錄：`from` 由 Host 依**通道認證過的身分**填入 */
export function encodeDeliver(d) {
    const body = new Uint8Array(8 + PK_BYTES + 2 + d.payload.length);
    const view = new DataView(body.buffer);
    writeSeq(view, 0, d.seq);
    body.set(hexToBytes(d.from), 8);
    body[40] = (d.unicast ? DELIVER_UNICAST : 0) | (d.volatile ? DELIVER_VOLATILE : 0);
    body[41] = d.topic;
    body.set(d.payload, 42);
    return { type: RecordType.Deliver, body };
}
export function decodeDeliver(body) {
    if (body.length < 42)
        return null;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const seq = readSeq(view, 0);
    const flags = body[40];
    if (!isSeq(seq) || (flags & ~(DELIVER_UNICAST | DELIVER_VOLATILE)) !== 0)
        return null;
    return {
        seq,
        from: bytesToHex(body.subarray(8, 40)),
        unicast: (flags & DELIVER_UNICAST) !== 0,
        volatile: (flags & DELIVER_VOLATILE) !== 0,
        topic: body[41],
        payload: body.subarray(42),
    };
}
export function encodeRoster(r) {
    const l = labelBytes(r.label);
    const body = new Uint8Array(8 + 1 + PK_BYTES + 1 + l.length);
    const view = new DataView(body.buffer);
    writeSeq(view, 0, r.seq);
    body[8] = r.event === 'joined' ? 1 : 2;
    body.set(hexToBytes(r.pubkey), 9);
    body[41] = r.reason ? reasonCode(r.reason) : 0;
    body.set(l, 42);
    return { type: RecordType.Roster, body };
}
export function decodeRoster(body) {
    if (body.length < 42)
        return null;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const seq = readSeq(view, 0);
    const event = body[8] === 1 ? 'joined' : body[8] === 2 ? 'left' : undefined;
    if (!isSeq(seq) || !event)
        return null;
    const code = body[41];
    const reason = code === 0 ? undefined : reasonFromCode(code);
    if (code !== 0 && !reason)
        return null;
    const label = readLabel(body.subarray(42));
    if (label === null)
        return null;
    return { seq, event, pubkey: bytesToHex(body.subarray(9, 41)), reason, label };
}
//# sourceMappingURL=wire.js.map