// C′ 即時通道的家庭核心（SDK ADR 0049 §9、R1）：relay 的轉送半＋設備連線。平台無關、零 Node 內建模組、**不用計時器**
// （Workers DO 用了 setTimeout 就失去休眠，§9.2）——所有決定都在收到訊息的當下做完，回傳「要送什麼」交給宿主執行。
//
// 每個家庭一顆（Workers：DO `iot:<homeTag>`；Node：記憶體裡一個實例）。relay 在這條路線上**就是閘道**：
// - 持有閘道簽章金鑰（解開手機指令的外層 NIP-44、簽 ack／狀態）與設備權杖雜湊；**不持有家庭秘密與設備金鑰**（§2.6）。
// - 手機 → 設備：驗簽（RelayCore 已做）→ 角色授權（§2.5，以簽章者公鑰）→ 剝外層 → 檢查信封的 kid／epoch／時間 → 設備幀。
//   設備沒有連線就立刻回 25171 `offline`（即時等級不排隊，§9.4）；連線在但心跳過期回 `stale`。
// - 設備 → 全家：up 信封包成 25171（`p`＝還在等這台設備回覆的成員）／25172，狀態另以 31170 retained 保存（每台至少隔 5 分鐘）。
// - 設備在線與否不落庫（線上狀態不持久化）；`dev-link` 查詢以宿主的連線即時回答。
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { applyIotAclOp, authorizeIot, iotRoleAtLeast, iotRoleOf, parseIotAcl, parseIotAclOp, } from '../iot/acl.js';
import { IOT_ACL_TOPIC, IOT_QUOTA_TOPIC } from '../iot/topic.js';
import { newIotMsgId, parseIotBody } from '../iot/content.js';
import { encodeIotDeviceFrame, IOT_DEVICE_HEARTBEAT_ACK, parseIotDeviceFrame, verifyIotDeviceToken } from '../iot/device-frame.js';
import { IotUpCounterGuard, parseIotKid } from '../iot/envelope.js';
import { IOT_BLIND_LENGTH } from '../iot/keys.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE, IOT_STATE_KINDS } from '../iot/kinds.js';
import { getPublicKey } from '../protocol/keys.js';
import { decryptDM, encryptDM } from '../protocol/nip44.js';
import { finalizeEvent } from '../protocol/sign.js';
/** 門鎖類設備必填的本地開啟方式（ADR 0049 §10.5） */
export const IOT_LOCAL_FALLBACKS = ['key', 'keypad', 'lan', 'ble', 'button'];
/** 每個家庭最多幾台設備（§9.6 `maxDevicesPerHome`） */
export const IOT_REALTIME_MAX_DEVICES = 64;
export const IOT_REALTIME_DEFAULT_HEARTBEAT_SEC = 30;
export const IOT_REALTIME_DEFAULT_TTL_MAX_SEC = 60;
/** retained 每台最少隔多久寫一次（SQLite 每日寫入列是最可能先到頂的額度，§9.4） */
export const IOT_REALTIME_RETAINED_MIN_INTERVAL_SEC = 300;
/** 拒收訊息（ADR 0040 詞元句：「前綴: 詞元: 說明」） */
export const IOT_REALTIME_REJECT = {
    home: 'restricted: iot-home: this relay does not serve that home',
    token: 'restricted: iot-token: device token missing or wrong',
    device: 'restricted: iot-device: unknown device',
    gatewayOnly: 'restricted: iot-gateway-only: only the relay gateway publishes this kind here',
    notGateway: 'invalid: iot: the p tag must be this home gateway',
    undecryptable: 'invalid: iot: cannot open the outer layer (encrypt to the gateway pubkey)',
    body: 'invalid: iot: unknown or malformed body for this kind',
    dv: 'invalid: iot: dv tag does not match the device',
    kid: 'invalid: iot-e2ee: kid is not this device or its key epoch is retired',
    envTime: 'invalid: iot-e2ee: envelope timestamp outside the realtime window',
    msgTime: 'invalid: iot: message timestamp outside the realtime window',
    duplicate: 'duplicate: iot-msgid: already delivered to the device',
};
const PENDING_MAX_PER_DEVICE = 16;
const DELIVERED_MAX = 1024;
export class IotRealtimeHome {
    config;
    #gatewaySecret;
    #sockets;
    #aclStore;
    #now;
    #byBlind = new Map();
    #byId = new Map();
    #acl;
    /** 這台設備有哪些指令還在等 ack（記憶體；DO 休眠後遺失只影響 ack 的 `p`，信封裡仍有 inReplyTo） */
    #pending = new Map();
    /** 已經送到設備的 msgId → 到期（毫秒）：QoS 重送不再送一次；沒送到的（offline）之後重送照送 */
    #delivered = new Map();
    #upCounters = new IotUpCounterGuard({ maxEntries: IOT_REALTIME_MAX_DEVICES * 2 });
    #lastRetained = new Map();
    #heartbeatMs;
    #windowMs;
    constructor(config, gatewaySecret, opts) {
        this.config = config;
        this.#gatewaySecret = typeof gatewaySecret === 'string' ? hexToBytes(gatewaySecret) : gatewaySecret;
        if (getPublicKey(this.#gatewaySecret) !== config.gatewayPubkey)
            throw new RangeError('閘道私鑰與設定的 gatewayPubkey 不符');
        this.#sockets = opts.sockets;
        this.#aclStore = opts.aclStore;
        this.#now = opts.now ?? Date.now;
        for (const d of config.devices) {
            this.#byBlind.set(d.blindId, d);
            this.#byId.set(d.id, d);
        }
        this.#acl = this.#aclStore?.load() ?? parseIotAcl(config.acl);
        this.#heartbeatMs = (config.heartbeatSec ?? IOT_REALTIME_DEFAULT_HEARTBEAT_SEC) * 1000;
        this.#windowMs = (config.realtimeTtlMaxSec ?? IOT_REALTIME_DEFAULT_TTL_MAX_SEC) * 1000;
    }
    get homeTag() {
        return this.config.homeTag;
    }
    /** 目前的角色名單 */
    acl() {
        return this.#acl;
    }
    device(blindId) {
        return this.#byBlind.get(blindId);
    }
    /** 設備連線的權杖（`Authorization: Bearer <權杖>`）：Worker 在碰 DO 之前就驗，錯的不花 DO 請求 */
    authenticateDevice(blindId, authorization) {
        const device = this.#byBlind.get(blindId);
        if (!device)
            return { ok: false, status: 404, error: IOT_REALTIME_REJECT.device };
        const token = /^Bearer\s+(\S+)$/.exec(authorization ?? '')?.[1];
        if (!verifyIotDeviceToken(token, device.tokenHash))
            return { ok: false, status: 401, error: IOT_REALTIME_REJECT.token };
        return { ok: true, device };
    }
    /** 設備是 `online`、`stale` 還是 `offline` */
    linkState(blindId) {
        if (!this.#sockets.isConnected(blindId))
            return { state: 'offline' };
        const hb = this.#sockets.lastHeartbeatMs(blindId);
        if (hb !== undefined && this.#now() - hb > this.#heartbeatMs * 3)
            return { state: 'stale', lastHeartbeat: hb };
        return hb === undefined ? { state: 'online' } : { state: 'online', lastHeartbeat: hb };
    }
    /**
     * 給 `RelayCore` 的 `intercept`：這個家的 IoT 指令由轉送半處理；閘道專屬 kind 一律拒收；其他 kind 回 undefined（照一般流程）。
     * 呼叫時事件已經驗過簽章、kind 政策、時鐘窗與速率限制。
     */
    interceptPhoneEvent(connId, event, _authedPubkey) {
        if (IOT_STATE_KINDS.includes(event.kind))
            return this.#reject(connId, event, IOT_REALTIME_REJECT.gatewayOnly);
        if (event.kind !== IOT_KIND_COMMAND && event.kind !== IOT_KIND_QUERY)
            return undefined;
        if (tag(event, 'h') !== this.config.homeTag)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.home);
        if (tag(event, 'p') !== this.config.gatewayPubkey)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.notGateway);
        let body;
        try {
            body = parseIotBody(JSON.parse(decryptDM(event.content, this.#gatewaySecret, event.pubkey)));
        }
        catch {
            return this.#reject(connId, event, IOT_REALTIME_REJECT.undecryptable);
        }
        if (!body)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.body);
        const now = this.#now();
        if (Math.abs(body.ts - now) > this.#windowMs)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.msgTime);
        if (event.kind === IOT_KIND_COMMAND && body.type === 'cmd' && body.topic === IOT_ACL_TOPIC)
            return this.#aclOp(connId, event, body.msgId, body.payload);
        const wanted = event.kind === IOT_KIND_COMMAND ? ['dev-cmd'] : ['dev-query', 'dev-link'];
        if (!wanted.includes(body.type) || !('device' in body) || typeof body.device !== 'string')
            return this.#reject(connId, event, IOT_REALTIME_REJECT.body);
        const device = this.#byId.get(body.device);
        if (!device)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.device);
        if (tag(event, 'dv') !== device.blindId)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.dv);
        const ok = { to: connId, message: ['OK', event.id, true, ''] };
        const nowSec = Math.floor(now / 1000);
        const confirmed = 'confirmed' in body ? body.confirmed : undefined;
        const auth = authorizeIot(this.#acl, { pubkey: event.pubkey, action: event.kind === IOT_KIND_COMMAND ? 'operate' : 'query', device: device.id, ...(confirmed !== undefined ? { confirmed } : {}) }, nowSec);
        const minRoleOk = event.kind !== IOT_KIND_COMMAND || device.minRole === undefined || (auth.ok && iotRoleAtLeast(auth.role, device.minRole));
        if (!auth.ok || !minRoleOk) {
            const status = auth.ok ? 'not-allowed' : auth.status;
            return { outbound: [ok], publish: [this.#ack(event, body.msgId, device, status, { reason: auth.ok ? 'min-role' : auth.reason })] };
        }
        if (body.type === 'dev-link') {
            const link = this.linkState(device.blindId);
            return {
                outbound: [ok],
                publish: [this.#ack(event, body.msgId, device, 'ok', { online: link.state !== 'offline', ...(link.lastHeartbeat !== undefined ? { lastHeartbeat: link.lastHeartbeat } : {}) })],
            };
        }
        const env = body.env;
        if (!this.#kidOk(device, env.kid, nowSec))
            return this.#reject(connId, event, IOT_REALTIME_REJECT.kid);
        if (Math.abs(env.ts - nowSec) > this.#windowMs / 1000)
            return this.#reject(connId, event, IOT_REALTIME_REJECT.envTime);
        this.#pruneDelivered(now);
        if (this.#delivered.has(body.msgId))
            return { outbound: [{ to: connId, message: ['OK', event.id, true, IOT_REALTIME_REJECT.duplicate] }], publish: [] };
        const link = this.linkState(device.blindId);
        if (link.state !== 'online')
            return { outbound: [ok], publish: [this.#ack(event, body.msgId, device, link.state)] };
        const frame = encodeIotDeviceFrame({ t: event.kind === IOT_KIND_COMMAND ? 'cmd' : 'query', env });
        if (!this.#sockets.send(device.blindId, frame))
            return { outbound: [ok], publish: [this.#ack(event, body.msgId, device, 'offline')] };
        this.#delivered.set(body.msgId, now + this.#windowMs);
        while (this.#delivered.size > DELIVERED_MAX)
            this.#delivered.delete(this.#delivered.keys().next().value);
        const list = (this.#pending.get(device.blindId) ?? []).filter((p) => p.until > now);
        list.push({ pubkey: event.pubkey, eventId: event.id, msgId: body.msgId, until: now + this.#windowMs });
        this.#pending.set(device.blindId, list.slice(-PENDING_MAX_PER_DEVICE));
        return { outbound: [ok], publish: [] };
    }
    /**
     * 設備送來的幀：心跳回 `reply`（Workers 的自動回覆不會走到這裡；Node 宿主照回）；ack／state 包成給全家的事件。
     * 壞幀、kid 不是這台設備或已作廢的 epoch、ctr 沒有遞增 → 丟掉（不關連線，免得一個壞幀讓設備重連風暴）。
     */
    onDeviceFrame(blindId, data, opts = {}) {
        const device = this.#byBlind.get(blindId);
        const frame = parseIotDeviceFrame(data, 'device');
        if (!device || !frame)
            return { publish: [] };
        if (frame.t === 'hb')
            return { publish: [], reply: IOT_DEVICE_HEARTBEAT_ACK };
        if (frame.t !== 'ack' && frame.t !== 'state')
            return { publish: [] };
        // 額度分流（§10.3 95%）：丟遙測、留 ack——即時等級的指令結果比狀態回報重要
        if (opts.shed && frame.t === 'state')
            return { publish: [] };
        const now = this.#now();
        const env = frame.env;
        if (!this.#kidOk(device, env.kid, Math.floor(now / 1000)))
            return { publish: [] };
        if (!this.#upCounters.accept(env.kid, env.ctr))
            return { publish: [] };
        const body = { v: 1, type: frame.t === 'ack' ? 'dev-ack' : 'dev-state', msgId: newIotMsgId(), ts: now, device: device.id, env };
        if (frame.t === 'ack') {
            const pending = (this.#pending.get(blindId) ?? []).filter((p) => p.until > now);
            this.#pending.set(blindId, pending);
            const tags = [['h', this.config.homeTag], ...uniq(pending.map((p) => p.pubkey)).map((p) => ['p', p]), ...pending.map((p) => ['e', p.eventId])];
            return { publish: [this.#sign(IOT_KIND_ACK, tags, body)] };
        }
        const publish = [this.#sign(IOT_KIND_STATE, [['h', this.config.homeTag], ['d', blindId]], body)];
        const last = this.#lastRetained.get(blindId);
        if (last === undefined || now - last >= IOT_REALTIME_RETAINED_MIN_INTERVAL_SEC * 1000) {
            this.#lastRetained.set(blindId, now);
            publish.push(this.#sign(IOT_KIND_RETAINED, [['d', blindId], ['h', this.config.homeTag]], body));
        }
        return { publish };
    }
    /**
     * 額度預警與狀態（ADR 0049 §10.3）：25172、topic `$sys/quota`，`p`＝名單上的 owner（只給 owner，§10.4），內容加密給全家。
     * `payload` 是 JSON `{ state, used, limit, reset }`（reset＝下一個 UTC 00:00 的 unix 秒）。
     */
    quotaNotice(state, used, limit, reset) {
        const now = this.#now();
        const owners = this.#acl.entries.filter((e) => e.role === 'owner').map((e) => ['p', e.pubkey]);
        const body = {
            v: 1,
            type: 'state',
            msgId: newIotMsgId(),
            ts: now,
            topic: IOT_QUOTA_TOPIC,
            payload: JSON.stringify({ state, used, limit, reset }),
            enc: 'utf8',
        };
        return this.#sign(IOT_KIND_STATE, [['h', this.config.homeTag], ...owners], body);
    }
    #kidOk(device, kid, nowSec) {
        const parsed = parseIotKid(kid);
        if (!parsed || parsed.deviceId !== device.id)
            return false;
        if (parsed.epoch === device.epoch)
            return true;
        const prev = device.previousEpoch;
        return prev !== undefined && parsed.epoch === prev.epoch && nowSec <= prev.until;
    }
    #aclOp(connId, event, msgId, payload) {
        const ok = { to: connId, message: ['OK', event.id, true, ''] };
        const nowSec = Math.floor(this.#now() / 1000);
        if (iotRoleOf(this.#acl, event.pubkey, nowSec) !== 'owner') {
            return { outbound: [ok], publish: [this.#ack(event, msgId, undefined, 'not-allowed', { reason: 'owner-only' })] };
        }
        try {
            this.#acl = applyIotAclOp(this.#acl, parseIotAclOp(payload), nowSec);
        }
        catch (error) {
            return { outbound: [ok], publish: [this.#ack(event, msgId, undefined, 'rejected', { reason: String(error instanceof Error ? error.message : error).slice(0, 200) })] };
        }
        this.#aclStore?.save(this.#acl);
        return { outbound: [ok], publish: [this.#ack(event, msgId, undefined, 'ok')] };
    }
    #ack(event, inReplyTo, device, status, extra = {}) {
        const body = {
            v: 1,
            type: 'ack',
            msgId: newIotMsgId(),
            ts: this.#now(),
            inReplyTo,
            status,
            ...(device ? { device: device.id } : {}),
            ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
            ...(extra.online !== undefined ? { online: extra.online } : {}),
            ...(extra.lastHeartbeat !== undefined ? { lastHeartbeat: extra.lastHeartbeat } : {}),
        };
        return this.#sign(IOT_KIND_ACK, [['h', this.config.homeTag], ['p', event.pubkey], ['e', event.id]], body);
    }
    #sign(kind, tags, body) {
        return finalizeEvent({ kind, created_at: Math.floor(body.ts / 1000), tags, content: encryptDM(JSON.stringify(body), this.#gatewaySecret, this.config.homePub) }, this.#gatewaySecret);
    }
    #reject(connId, event, reason) {
        return { outbound: [{ to: connId, message: ['OK', event.id, false, reason] }], publish: [] };
    }
    #pruneDelivered(now) {
        for (const [id, until] of this.#delivered) {
            if (until > now)
                break;
            this.#delivered.delete(id);
        }
    }
}
function tag(event, name) {
    return event.tags.find((t) => t[0] === name)?.[1];
}
function uniq(items) {
    return [...new Set(items)];
}
const BLIND_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_BLIND_LENGTH}}$`);
const HEX64 = /^[0-9a-f]{64}$/;
const ROLES = ['viewer', 'operator', 'owner'];
/**
 * 解析 C′ 的設定（`IOT_REALTIME`，JSON；非秘密）與閘道金鑰（`IOT_GATEWAY_KEYS`，JSON `{homeTag: 64 位 hex}`；Worker secret）。
 * 收集式：一次列出所有問題，有問題的家庭不啟用（不默默套用一半）。
 */
export function parseIotRealtimeConfig(raw, gatewayKeys) {
    const issues = [];
    const homes = new Map();
    const add = (path, code, message) => void issues.push({ path, code, message });
    const list = raw?.homes;
    if (!Array.isArray(list)) {
        add('homes', 'shape', '需要 { "homes": [ … ] }');
        return { homes, issues };
    }
    list.forEach((h, i) => {
        const at = `homes[${i}]`;
        const before = issues.length;
        const home = (h ?? {});
        const homeTag = home.homeTag;
        if (typeof homeTag !== 'string' || !BLIND_PATTERN.test(homeTag))
            add(`${at}.homeTag`, 'home-tag', `homeTag 必須是 ${IOT_BLIND_LENGTH} 個 base64url 字元`);
        else if (homes.has(homeTag))
            add(`${at}.homeTag`, 'home-duplicate', '同一個 homeTag 出現兩次');
        for (const key of ['homePub', 'gatewayPubkey']) {
            if (typeof home[key] !== 'string' || !HEX64.test(home[key]))
                add(`${at}.${key}`, 'pubkey', `${key} 必須是 64 位小寫 hex`);
        }
        try {
            parseIotAcl(home.acl ?? []);
        }
        catch (error) {
            add(`${at}.acl`, 'acl', String(error instanceof Error ? error.message : error));
        }
        const devices = Array.isArray(home.devices) ? home.devices : [];
        if (!Array.isArray(home.devices))
            add(`${at}.devices`, 'shape', 'devices 必須是陣列');
        if (devices.length > IOT_REALTIME_MAX_DEVICES)
            add(`${at}.devices`, 'too-many-devices', `每個家庭最多 ${IOT_REALTIME_MAX_DEVICES} 台設備`);
        const ids = new Set();
        const blinds = new Set();
        devices.forEach((d, j) => {
            const p = `${at}.devices[${j}]`;
            const dev = (d ?? {});
            if (typeof dev.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(dev.id))
                add(`${p}.id`, 'device-id', '設備 id 只能用英數、點、底線、連字號（1–64 字）');
            if (typeof dev.blindId !== 'string' || !BLIND_PATTERN.test(dev.blindId))
                add(`${p}.blindId`, 'blind-id', `blindId 必須是 ${IOT_BLIND_LENGTH} 個 base64url 字元`);
            if (typeof dev.id === 'string' && typeof dev.blindId === 'string' && (ids.has(dev.id) || blinds.has(dev.blindId)))
                add(p, 'device-duplicate', '設備 id 或 blindId 重複');
            if (typeof dev.id === 'string')
                ids.add(dev.id);
            if (typeof dev.blindId === 'string')
                blinds.add(dev.blindId);
            if (!Number.isSafeInteger(dev.epoch) || dev.epoch < 0)
                add(`${p}.epoch`, 'epoch', 'epoch 必須是非負整數');
            if (typeof dev.tokenHash !== 'string' || !HEX64.test(dev.tokenHash))
                add(`${p}.tokenHash`, 'token-hash', 'tokenHash 必須是權杖的 SHA-256（64 位小寫 hex）——不要把權杖本身寫進設定');
            if (dev.minRole !== undefined && !ROLES.includes(dev.minRole))
                add(`${p}.minRole`, 'role', 'minRole 必須是 viewer／operator／owner');
            if (dev.class === 'lock') {
                const fb = dev.localFallback;
                if (!Array.isArray(fb) || fb.length === 0 || !fb.every((x) => IOT_LOCAL_FALLBACKS.includes(x))) {
                    add(`${p}.localFallback`, 'lock-local-fallback', `門鎖類設備必須列出不依賴 relay 的開啟方式（${IOT_LOCAL_FALLBACKS.join('／')}），ADR 0049 §10.5`);
                }
            }
            const prev = dev.previousEpoch;
            if (prev !== undefined && (!Number.isSafeInteger(prev.epoch) || !Number.isSafeInteger(prev.until)))
                add(`${p}.previousEpoch`, 'epoch', 'previousEpoch 需要整數 epoch 與 until（unix 秒）');
        });
        if (typeof homeTag !== 'string')
            return;
        const key = gatewayKeys[homeTag];
        let secret;
        if (typeof key !== 'string' || !HEX64.test(key))
            add(`${at}.gatewayKey`, 'gateway-key-missing', `IOT_GATEWAY_KEYS 沒有這個家庭（${homeTag}）的閘道私鑰`);
        else {
            secret = hexToBytes(key);
            if (typeof home.gatewayPubkey === 'string' && getPublicKey(secret) !== home.gatewayPubkey)
                add(`${at}.gatewayKey`, 'gateway-key-mismatch', '閘道私鑰與 gatewayPubkey 不符');
        }
        if (issues.length === before && secret)
            homes.set(homeTag, { config: home, gatewaySecret: secret });
    });
    return { homes, issues };
}
/** 給 CLI 與測試：把閘道私鑰轉成 `IOT_GATEWAY_KEYS` 的值 */
export function iotGatewayKeysJson(entries) {
    return JSON.stringify(Object.fromEntries(Object.entries(entries).map(([tag, sk]) => [tag, bytesToHex(sk)])));
}
//# sourceMappingURL=iot-realtime.js.map