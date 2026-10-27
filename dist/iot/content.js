// IoT 事件的內容與封裝（SDK ADR 0049 §2.3）：NIP-44 v2，寄件人私鑰 × `homePub`——一則只加密一次，任何持有家庭秘密的成員
// 都能以 `homeKey × 寄件人公鑰` 解開。這裡只做「內容長什麼樣、怎麼驗、怎麼包成事件」；收送與授權在 client／gateway。
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { conversationKey, decryptWithKey, encryptWithKey } from '../protocol/nip44.js';
import { parseIotEnvelope } from './envelope.js';
import { IOT_PROTOCOL_VERSION } from './kinds.js';
import { isValidIotDeviceId, isValidIotTopic } from './topic.js';
export const IOT_ACK_STATUSES = ['ok', 'rejected', 'timeout', 'unknown-topic', 'not-allowed', 'throttled', 'offline', 'stale', 'quota'];
/** 單一酬載的位元組上限（指令與狀態；設備的訊息很短，這是防濫用上界） */
export const IOT_PAYLOAD_MAX_BYTES = 8 * 1024;
/** retained 單顆的明文上限：NIP-44 補齊與 base64 之後約 22 KB，在車道可尋址上限 32 KB 之內（ADR 0049 §2.3） */
export const IOT_RETAINED_PART_MAX_BYTES = 16 * 1024;
/** 一台設備的 retained 最多拆成幾顆 */
export const IOT_RETAINED_MAX_PARTS = 8;
/** reason 欄位最長幾個字元 */
const REASON_MAX = 200;
/** 新的 128 位元訊息 id（32 位 hex） */
export function newIotMsgId() {
    return bytesToHex(randomBytes(16));
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMsgId = (v) => typeof v === 'string' && /^[0-9A-Za-z_-]{16,64}$/.test(v);
const isTs = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isEnc = (v) => v === 'utf8' || v === 'base64';
const byteLength = (s) => new TextEncoder().encode(s).length;
const isPayload = (v) => typeof v === 'string' && byteLength(v) <= IOT_PAYLOAD_MAX_BYTES;
const optional = (v, check) => v === undefined || check(v);
const isBool = (v) => typeof v === 'boolean';
const isReason = (v) => typeof v === 'string' && v.length <= REASON_MAX;
function isTopicValues(v) {
    if (!isObject(v))
        return false;
    return Object.entries(v).every(([topic, value]) => isValidIotTopic(topic) && isObject(value) && isPayload(value.payload) && optional(value.enc, isEnc) && isTs(value.ts));
}
/** 驗證解開的內容；不認得或欄位不對回 undefined（不丟例外：中繼與其他成員都不可信） */
export function parseIotBody(raw) {
    if (!isObject(raw) || raw.v !== IOT_PROTOCOL_VERSION || !isMsgId(raw.msgId) || !isTs(raw.ts))
        return undefined;
    switch (raw.type) {
        case 'cmd':
            if (!isValidIotTopic(raw.topic) || !optional(raw.device, isValidIotDeviceId) || !isPayload(raw.payload) || !isEnc(raw.enc))
                return undefined;
            if (raw.qos !== 0 && raw.qos !== 1)
                return undefined;
            if (!optional(raw.confirmed, isBool))
                return undefined;
            return raw;
        case 'query':
            return isValidIotDeviceId(raw.device) ? raw : undefined;
        case 'ack':
            if (!isMsgId(raw.inReplyTo) || !IOT_ACK_STATUSES.includes(raw.status))
                return undefined;
            if (!optional(raw.reason, isReason) || !optional(raw.topics, isTopicValues) || !optional(raw.device, isValidIotDeviceId))
                return undefined;
            if (!optional(raw.fromRetained, isBool) || !optional(raw.online, isBool))
                return undefined;
            if (!optional(raw.lastHeartbeat, isTs) || !optional(raw.reset, isTs))
                return undefined;
            return raw;
        case 'dev-cmd':
        case 'dev-query': {
            const env = parseIotEnvelope(raw.env);
            if (!isValidIotDeviceId(raw.device) || !env || env.dir !== 'down' || !optional(raw.confirmed, isBool))
                return undefined;
            return { ...raw, env };
        }
        case 'dev-link':
            return isValidIotDeviceId(raw.device) && raw.env === undefined ? raw : undefined;
        case 'dev-ack':
        case 'dev-state': {
            const env = parseIotEnvelope(raw.env);
            if (!isValidIotDeviceId(raw.device) || !env || env.dir !== 'up')
                return undefined;
            return { ...raw, env };
        }
        case 'state':
            if (!isValidIotTopic(raw.topic) || !optional(raw.device, isValidIotDeviceId) || !isPayload(raw.payload) || !isEnc(raw.enc))
                return undefined;
            if (!optional(raw.inReplyTo, isMsgId) || !optional(raw.will, isBool))
                return undefined;
            return raw;
        case 'retained': {
            if (!isValidIotDeviceId(raw.device) || !isTopicValues(raw.topics) || !optional(raw.online, isBool))
                return undefined;
            const { part, parts } = raw;
            if (!Number.isInteger(parts) || parts < 1 || parts > IOT_RETAINED_MAX_PARTS)
                return undefined;
            if (!Number.isInteger(part) || part < 0 || part >= parts)
                return undefined;
            return raw;
        }
        case 'acl':
            return 'acl' in raw ? raw : undefined;
        case 'gw':
            if (!isBool(raw.online) || !Number.isInteger(raw.heartbeatSec))
                return undefined;
            return raw;
        default:
            return undefined;
    }
}
/**
 * NIP-44 對話金鑰的快取：寄件時是「自己的簽章者 × homePub」，收件時是「homeKey × 寄件人公鑰」。
 * 兩者都是 ECDH，每則事件重算太浪費。
 */
export class IotKeyring {
    #home;
    #signer;
    #sendKey;
    #recv = new Map();
    constructor(home, signer) {
        this.#home = home;
        this.#signer = signer;
    }
    /** 把內容加密給全家（寄件人＝自己的簽章者） */
    seal(body) {
        this.#sendKey ??= this.#signer.conversationKey(this.#home.homePub);
        return encryptWithKey(JSON.stringify(body), this.#sendKey);
    }
    /** 以 homeKey 解開某人寄給全家的內容；解不開或格式不對回 undefined */
    open(content, sender) {
        let key = this.#recv.get(sender);
        if (key === undefined) {
            try {
                key = conversationKey(this.#home.homeKey, sender);
            }
            catch {
                return undefined;
            }
            if (this.#recv.size > 256)
                this.#recv.clear();
            this.#recv.set(sender, key);
        }
        try {
            return parseIotBody(JSON.parse(decryptWithKey(content, key)));
        }
        catch {
            return undefined;
        }
    }
}
/** 包成已簽章的事件 */
export function buildIotEvent(keyring, signer, kind, tags, body) {
    const template = { kind, created_at: Math.floor(body.ts / 1000), tags, content: keyring.seal(body) };
    return signer.sign(template);
}
/** 事件的某個標籤值（第一個） */
export function tagValue(event, name) {
    return event.tags.find((t) => t[0] === name)?.[1];
}
/** NIP-40 `expiration`（秒）；沒有或不合法回 undefined */
export function expirationOf(event) {
    const raw = tagValue(event, 'expiration');
    if (raw === undefined || !/^\d{1,12}$/.test(raw))
        return undefined;
    return Number(raw);
}
//# sourceMappingURL=content.js.map