// C′ R5：Shelly Gen2+ Outbound WebSocket 的明文轉譯（SDK ADR 0049 §9.5、SDK ADR 0139）。平台無關，Workers DO 與 Node 宿主共用。
//
// Shelly 以 `Ws.SetConfig { server: "wss://…/iot/v1/shelly/<homeTag>/<blindId>?token=…" }` 外連 relay，講明文 JSON-RPC 2.0 的子集：
//   relay → Shelly：`{"id":<n>,"src":"cinder-relay","method":"Switch.Set","params":{"id":0,"on":true}}`
//   Shelly → relay：回覆 `{"id":<n>,"result":{…}}`／`{"id":<n>,"error":{"code","message"}}`，或通知 `{"method":"NotifyStatus","params":{…}}`
//
// relay 替這台設備扮演「會封信封的設備」：手機與 relay 的其他部分看到的，與 E2EE 設備（./iot/device）一模一樣。
// - 用**這台設備的** deviceKey（不是家庭秘密）解 down 信封、封 up 信封：relay 被攻破只賠這幾台明文設備，不賠全家（最小權限）。
// - 與 ./iot/device 相同的檢查：信封時間 ±60 秒、指令沒過期、msgId 去重（重送回同一個 ack、不再送 RPC）。
// - up 計數器以時間為底（`max(上一個 + 1, 毫秒 × 1024)`）：DO 休眠或主機重開後不需要存檔也不會重用 GCM nonce；
//   到 2248 年前都是安全整數。前提是主機時鐘不倒退超過重開的間隔。
import { openIotEnvelope, sealIotEnvelope } from '../iot/envelope.js';
import { encodeIotDeviceFrame, parseIotDeviceFrame } from '../iot/device-frame.js';
import { parseIotDownMessage } from '../iot/device-message.js';
import { isValidIotTopic } from '../iot/topic.js';
export { IOT_SHELLY_MAX_SWITCHES } from './iot-realtime-config.js';
/** relay 在 RPC 裡自稱的 `src`（Shelly 回覆時放在 `dst`） */
export const IOT_SHELLY_RPC_SRC = 'cinder-relay';
const MAX_SKEW_SEC = 60;
const SEEN_MAX = 256;
const PENDING_MAX = 32;
/** RPC 等回覆最多多久（毫秒）：之後的回覆丟掉（手機那邊早就是 unknown） */
const PENDING_TTL_MS = 30_000;
const PAYLOAD = { on: true, off: false, '1': true, '0': false, true: true, false: false, toggle: 'toggle' };
export class IotShellyTranslator {
    #kid;
    #key;
    #now;
    #byTopic = new Map();
    #bySwitch = new Map();
    #seen = new Map();
    #pending = new Map();
    #rpcId = 0;
    #ctr = 0;
    constructor(opts) {
        this.#kid = `${opts.device.id}.${opts.device.epoch}`;
        this.#key = opts.deviceKey;
        this.#now = opts.now ?? Date.now;
        for (const sw of opts.device.shelly?.switches ?? []) {
            if (!isValidIotTopic(sw.topic))
                continue;
            this.#byTopic.set(sw.topic, sw.id);
            this.#bySwitch.set(sw.id, sw.topic);
        }
    }
    /** relay → 設備的幀（`cmd`／`query`，down 信封）→ Shelly RPC；馬上能回答的（不認得的 topic、過期）直接回 up ack */
    fromRelay(text) {
        const none = { toDevice: [], up: [] };
        const frame = parseIotDeviceFrame(text, 'relay');
        if (!frame || (frame.t !== 'cmd' && frame.t !== 'query') || frame.env.kid !== this.#kid)
            return none;
        let plaintext;
        try {
            plaintext = openIotEnvelope(frame.env, this.#key);
        }
        catch {
            return none; // 解不開＝不是持有金鑰的人做的：不回任何東西
        }
        const msg = parseIotDownMessage(plaintext);
        if (!msg || msg.type !== frame.t)
            return none;
        const now = this.#now();
        const nowSec = Math.floor(now / 1000);
        for (const [id, s] of this.#seen)
            if (s.exp < nowSec - MAX_SKEW_SEC)
                this.#seen.delete(id);
        const prior = this.#seen.get(msg.msgId);
        if (prior)
            return prior.ack ? { toDevice: [], up: [this.#seal(prior.ack)] } : none;
        if (Math.abs(frame.env.ts - nowSec) > MAX_SKEW_SEC || msg.exp < nowSec)
            return this.#answer(msg.msgId, msg.exp, { status: 'rejected', reason: 'expired' });
        this.#seen.set(msg.msgId, { exp: msg.exp });
        while (this.#seen.size > SEEN_MAX)
            this.#seen.delete(this.#seen.keys().next().value);
        if (msg.type === 'query')
            return this.#rpc({ kind: 'status', msgId: msg.msgId, exp: msg.exp, until: now + PENDING_TTL_MS }, 'Shelly.GetStatus');
        const sw = this.#byTopic.get(msg.topic);
        if (sw === undefined)
            return this.#answer(msg.msgId, msg.exp, { status: 'unknown-topic' });
        const want = msg.enc === 'utf8' ? PAYLOAD[msg.payload.trim().toLowerCase()] : undefined;
        if (want === undefined)
            return this.#answer(msg.msgId, msg.exp, { status: 'rejected', reason: 'bad-payload' });
        if (want === 'toggle')
            return this.#rpc({ kind: 'toggle', msgId: msg.msgId, exp: msg.exp, topic: msg.topic, until: now + PENDING_TTL_MS }, 'Switch.Toggle', { id: sw });
        return this.#rpc({ kind: 'set', msgId: msg.msgId, exp: msg.exp, topic: msg.topic, on: want, until: now + PENDING_TTL_MS }, 'Switch.Set', { id: sw, on: want });
    }
    /** Shelly 送來的訊息：RPC 回覆 → up ack；`NotifyStatus`／`NotifyFullStatus` 的開關輸出 → up state；其他丟掉 */
    fromDevice(text) {
        const none = { toDevice: [], up: [] };
        let raw;
        try {
            raw = JSON.parse(text);
        }
        catch {
            return none;
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            return none;
        const m = raw;
        const now = this.#now();
        if (typeof m.id === 'number' && ('result' in m || 'error' in m)) {
            const p = this.#pending.get(m.id);
            if (!p)
                return none;
            this.#pending.delete(m.id);
            if (p.until < now)
                return none;
            if (m.error !== undefined) {
                const code = m.error?.code;
                return this.#answer(p.msgId, p.exp, { status: 'rejected', reason: `shelly:${typeof code === 'number' ? code : 'error'}` });
            }
            const result = (m.result ?? {});
            if (p.kind === 'set')
                return this.#answer(p.msgId, p.exp, { status: 'ok', topics: { [p.topic]: this.#value(p.on, now) } });
            if (p.kind === 'toggle') {
                const wasOn = result.was_on;
                return this.#answer(p.msgId, p.exp, { status: 'ok', ...(typeof wasOn === 'boolean' ? { topics: { [p.topic]: this.#value(!wasOn, now) } } : {}) });
            }
            const topics = this.#switchTopics(result, now);
            return this.#answer(p.msgId, p.exp, { status: 'ok', ...(Object.keys(topics).length > 0 ? { topics } : {}) });
        }
        if ((m.method === 'NotifyStatus' || m.method === 'NotifyFullStatus') && m.params !== null && typeof m.params === 'object') {
            const topics = this.#switchTopics(m.params, now);
            if (Object.keys(topics).length === 0)
                return none;
            return { toDevice: [], up: [this.#seal({ type: 'state', topics })] };
        }
        return none;
    }
    /** `switch:<id>.output` → 對應 topic 的 ON／OFF */
    #switchTopics(status, now) {
        const topics = {};
        for (const [id, topic] of this.#bySwitch) {
            const output = status[`switch:${id}`]?.output;
            if (typeof output === 'boolean')
                topics[topic] = this.#value(output, now);
        }
        return topics;
    }
    #value(on, now) {
        return { payload: on ? 'ON' : 'OFF', ts: now };
    }
    #rpc(p, method, params) {
        const now = this.#now();
        for (const [id, q] of this.#pending)
            if (q.until < now)
                this.#pending.delete(id);
        while (this.#pending.size >= PENDING_MAX)
            this.#pending.delete(this.#pending.keys().next().value);
        this.#rpcId = (this.#rpcId % 2_000_000_000) + 1;
        this.#pending.set(this.#rpcId, p);
        return { toDevice: [JSON.stringify({ id: this.#rpcId, src: IOT_SHELLY_RPC_SRC, method, ...(params ? { params } : {}) })], up: [] };
    }
    /** 回一個 ack（記進去重表：重送同一個 msgId 回同一個 ack） */
    #answer(msgId, exp, r) {
        const ack = { type: 'ack', inReplyTo: msgId, ...r };
        this.#seen.set(msgId, { exp, ack });
        return { toDevice: [], up: [this.#seal(ack)] };
    }
    #seal(msg) {
        const now = this.#now();
        this.#ctr = Math.max(this.#ctr + 1, now * 1024);
        const env = sealIotEnvelope({ key: this.#key, kid: this.#kid, dir: 'up', ctr: this.#ctr, ts: Math.floor(now / 1000), plaintext: JSON.stringify(msg) });
        return encodeIotDeviceFrame({ t: msg.type, env });
    }
}
//# sourceMappingURL=iot-shelly.js.map