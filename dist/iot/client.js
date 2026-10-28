import { encryptWithKey } from '../protocol/nip44.js';
import { RelayEventBudget, sharedRelayEventBudget } from '../relay-budget.js';
import { iotPubkeyOf, iotRoleOf, parseIotAcl } from './acl.js';
import { buildIotEvent, expirationOf, IotKeyring, newIotMsgId, tagValue, } from './content.js';
import { parseIotUpMessage } from './device-message.js';
import { deriveIotDeviceKeyDown, iotKid, openIotEnvelope, parseIotKid, sealIotEnvelope } from './envelope.js';
import { iotBlindNames } from './keys.js';
import { iotPushEndpointId, parseIotPushEndpoint, parseIotPushSubscriptions, } from './push.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE, IOT_MAX_TTL_SEC } from './kinds.js';
import { clampIot, IotReplayGuard } from './replay.js';
import { mergeIotRetained } from './retained.js';
import { assertIotTopic, IOT_ACL_TOPIC, IOT_PUSH_TOPIC, isValidIotDeviceId, topicMatches, topicSubscriptionPlan } from './topic.js';
import { iotPublish, iotQuery, iotVerified } from './transport.js';
export const IOT_DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
export const IOT_DEFAULT_COMMAND_RETRIES = 2;
export const IOT_DEFAULT_TTL_SEC = 30;
export const IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS = 8_000;
/** retained 多久沒更新就視為不可信（秒）：閘道每 6 小時刷新一次，留兩輪＋一小時 */
export const IOT_DEFAULT_STALE_AFTER_SEC = 13 * 3600;
/** 中繼的額度拒收（ADR 0049 §10）：`…iot-quota:<重置 unix 秒>` 或只有詞元 */
const QUOTA_REJECTION = /\biot-quota:\s*(\d{1,12})?/;
/** 即時等級（ADR 0049 §9.4 裁示 5）：ttl 預設 15 秒、夾 5–60；等 ack 預設 5 秒、不重送 */
export const IOT_REALTIME_DEFAULT_TTL_SEC = 15;
export const IOT_REALTIME_MAX_TTL_SEC = 60;
export const IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS = 5_000;
export class IotClient {
    #o;
    #gateway;
    #keyring;
    #budget;
    #now;
    #ackGuard;
    /** C′ up 信封的重放保護（`kid#ctr` × 信封時間）：ack 與狀態走不同的訂閱、可能亂序，所以不用「嚴格遞增」 */
    #upGuard;
    #waiters = new Map();
    #main;
    #rt;
    #rtDevices = new Map();
    #operatorSecret;
    /** down 信封的 ctr：發送端自己的序號（只進 AAD） */
    #downCtr = 0;
    #subs = new Set();
    #wakers = new Set();
    #closed = false;
    constructor(opts) {
        this.#o = opts;
        this.#gateway = iotPubkeyOf(opts.gateway);
        this.#keyring = new IotKeyring(opts.home, opts.signer);
        this.#budget = opts.budget ?? sharedRelayEventBudget(opts.signer.pubkey);
        this.#now = opts.now ?? Date.now;
        this.#ackGuard = new IotReplayGuard({ maxSkewSec: opts.maxSkewSec, now: this.#now });
        this.#upGuard = new IotReplayGuard({ maxSkewSec: opts.maxSkewSec, now: this.#now });
        this.#main = { pool: opts.pool, gateway: this.#gateway };
        const rt = opts.realtime;
        if (rt) {
            const gateway = rt.gateway !== undefined ? iotPubkeyOf(rt.gateway) : this.#gateway;
            const pool = rt.pool ?? opts.pool;
            this.#rt = pool === opts.pool && gateway === this.#gateway ? this.#main : { pool, gateway };
            for (const [id, ref] of Object.entries(rt.devices)) {
                if (!isValidIotDeviceId(id))
                    throw new RangeError(`設備 id 不合法：${id}`);
                const epoch = ref.epoch ?? 0;
                iotKid(id, epoch); // 檢查 epoch
                this.#rtDevices.set(id, { id, epoch, downByOperator: ref.class === 'lock' || ref.operatorSecret === true });
            }
            this.#operatorSecret = rt.operatorSecret;
        }
    }
    get gateway() {
        return this.#gateway;
    }
    /** 關掉所有訂閱 */
    close() {
        for (const route of [this.#main, this.#rt]) {
            route?.acks?.close();
            if (route)
                route.acks = undefined;
        }
        for (const sub of this.#subs)
            sub.close();
        this.#subs.clear();
        this.#closed = true;
        for (const wake of [...this.#wakers])
            wake();
    }
    // ── 操作與查詢 ────────────────────────────────────────────────────
    /** 下一則操作（kind 25170），等 ack */
    async command(topic, payload, opts = {}) {
        assertIotTopic(topic);
        if (opts.device !== undefined && !isValidIotDeviceId(opts.device))
            throw new RangeError(`設備 id 不合法：${opts.device}`);
        const realtime = opts.urgency === 'realtime';
        const qos = opts.qos ?? 1;
        const timeoutMs = Math.max(1, opts.ackTimeoutMs ?? opts.timeoutMs ?? (realtime ? IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS : IOT_DEFAULT_COMMAND_TIMEOUT_MS));
        const retries = qos === 1 ? Math.max(0, Math.floor(opts.retries ?? (realtime ? 0 : IOT_DEFAULT_COMMAND_RETRIES))) : 0;
        const ttlSec = realtime
            ? clampIot(opts.ttlSec, IOT_REALTIME_DEFAULT_TTL_SEC, 5, IOT_REALTIME_MAX_TTL_SEC)
            : clampIot(opts.ttlSec, IOT_DEFAULT_TTL_SEC, 5, IOT_MAX_TTL_SEC);
        const msgId = newIotMsgId();
        const ts = this.#now();
        const expiration = Math.floor(ts / 1000) + ttlSec;
        const rtDevice = opts.device !== undefined ? this.#rtDevices.get(opts.device) : undefined;
        let sent;
        if (rtDevice) {
            // C′：門鎖類沒有 operatorSecret 就做不出設備解得開的指令——不送（relay 也擋不了偽造，設備會直接丟掉）
            if (rtDevice.downByOperator && this.#operatorSecret === undefined)
                return { status: 'not-allowed', msgId, attempts: 0, reason: 'operator-secret' };
            const inner = { type: 'cmd', msgId, topic, payload, enc: opts.enc ?? 'utf8', ...(opts.confirmed !== undefined ? { confirmed: opts.confirmed } : {}), exp: expiration };
            const key = rtDevice.downByOperator ? deriveIotDeviceKeyDown(this.#operatorSecret, rtDevice.id, rtDevice.epoch) : this.#o.home.deviceKey(rtDevice.id, rtDevice.epoch);
            const env = this.#sealDown(rtDevice, key, ts, inner);
            const body = { v: 1, type: 'dev-cmd', msgId, ts, device: rtDevice.id, env, ...(opts.confirmed !== undefined ? { confirmed: opts.confirmed } : {}) };
            sent = await this.#sendAndWait(this.#rt, IOT_KIND_COMMAND, this.#rtTags(rtDevice, expiration), body, { msgId, timeoutMs, retries, expiration, toGateway: true });
        }
        else {
            const body = {
                v: 1,
                type: 'cmd',
                msgId,
                ts,
                topic,
                ...(opts.device !== undefined ? { device: opts.device } : {}),
                payload,
                enc: opts.enc ?? 'utf8',
                qos,
                ...(opts.confirmed !== undefined ? { confirmed: opts.confirmed } : {}),
            };
            const tags = [
                ['h', this.#o.home.homeTag],
                ['t', this.#o.home.blind(topic)],
                ['p', this.#gateway],
                ['expiration', String(expiration)],
            ];
            // C′ 與閘道是同一條路線（relay 就是這個家的閘道）：`$sys/acl` 由 relay 處理，外層要加密給它（SDK ADR 0121）
            const toGateway = topic === IOT_ACL_TOPIC && this.#rt === this.#main;
            sent = await this.#sendAndWait(this.#main, IOT_KIND_COMMAND, tags, body, { msgId, timeoutMs, retries, expiration, toGateway });
        }
        // ack 原文只給 query() 用；command() 的結果不帶它
        const { ack, ...result } = sent;
        const out = {
            ...result,
            ...(ack?.topics !== undefined ? { state: { topics: ack.topics, ts: ack.ts } } : {}),
            ...(ack?.reset !== undefined ? { reset: ack.reset } : {}),
        };
        if (!realtime || out.status !== 'timeout')
            return out;
        // 即時等級逾時：結果未知（不是失敗）——查一次設備實際的狀態（ADR 0049 §9.4）
        const after = opts.device !== undefined ? await this.query(opts.device, { timeoutMs }).catch(() => undefined) : undefined;
        return { ...out, status: 'unknown', ...(after ? { after } : {}) };
    }
    /** 要求設備立刻回報（kind 25173，`viewer` 以上）；閘道節流或逾時時回 retained */
    async query(device, opts = {}) {
        if (!isValidIotDeviceId(device))
            throw new RangeError(`設備 id 不合法：${device}`);
        const msgId = newIotMsgId();
        const ts = this.#now();
        const rtDevice = this.#rtDevices.get(device);
        const ttlSec = clampIot(opts.ttlSec, rtDevice ? IOT_REALTIME_DEFAULT_TTL_SEC : IOT_DEFAULT_TTL_SEC, 5, rtDevice ? IOT_REALTIME_MAX_TTL_SEC : IOT_MAX_TTL_SEC);
        const expiration = Math.floor(ts / 1000) + ttlSec;
        const timeoutMs = Math.max(1, opts.timeoutMs ?? IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS);
        let result;
        if (rtDevice) {
            // 查詢一律用 deviceKey（門鎖類也是）：viewer 也能查；設備只執行 `cmd` 幀
            const env = this.#sealDown(rtDevice, this.#o.home.deviceKey(rtDevice.id, rtDevice.epoch), ts, { type: 'query', msgId, exp: expiration });
            const body = { v: 1, type: 'dev-query', msgId, ts, device, env };
            result = await this.#sendAndWait(this.#rt, IOT_KIND_QUERY, this.#rtTags(rtDevice, expiration), body, { msgId, timeoutMs, retries: 0, expiration, toGateway: true });
        }
        else {
            const tags = [
                ['h', this.#o.home.homeTag],
                ['dv', this.#o.home.blind(iotBlindNames.device(device))],
                ['p', this.#gateway],
                ['expiration', String(expiration)],
            ];
            result = await this.#sendAndWait(this.#main, IOT_KIND_QUERY, tags, { v: 1, type: 'query', msgId, ts, device }, { msgId, timeoutMs, retries: 0, expiration });
        }
        if (result.ack) {
            const ack = result.ack;
            return {
                status: ack.status,
                ...(ack.topics !== undefined ? { state: { topics: ack.topics, ts: ack.ts } } : {}),
                fromRetained: ack.fromRetained === true || ack.status === 'throttled',
                ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
            };
        }
        // 閘道沒回（或中繼沒收）：退回 retained
        const retained = await this.getRetained(device).catch(() => undefined);
        return {
            status: result.status === 'quota' ? 'quota' : 'timeout',
            ...(retained ? { state: { topics: retained.topics, ts: retained.ts } } : {}),
            fromRetained: true,
            ...(result.status === 'relay-rejected' ? { reason: 'relay-rejected' } : {}),
        };
    }
    /**
     * 設備現在連著嗎（ADR 0049 §9.4）。C′：relay 以當下的連線即時回答（`dev-link`，不打擾設備、不落庫），`viewer` 以上；
     * 其他路線：retained 的 `online`（閘道最後一次知道的）。
     */
    async deviceLink(device, opts = {}) {
        if (!isValidIotDeviceId(device))
            throw new RangeError(`設備 id 不合法：${device}`);
        const rtDevice = this.#rtDevices.get(device);
        if (!rtDevice) {
            const retained = await this.getRetained(device).catch(() => undefined);
            return { transport: 'gateway', status: 'ok', ...(retained?.online !== undefined ? { online: retained.online } : {}), ...(retained ? { lastSeen: retained.ts } : {}) };
        }
        const msgId = newIotMsgId();
        const ts = this.#now();
        const expiration = Math.floor(ts / 1000) + IOT_REALTIME_DEFAULT_TTL_SEC;
        const timeoutMs = Math.max(1, opts.timeoutMs ?? IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS);
        const r = await this.#sendAndWait(this.#rt, IOT_KIND_QUERY, this.#rtTags(rtDevice, expiration), { v: 1, type: 'dev-link', msgId, ts, device }, { msgId, timeoutMs, retries: 0, expiration, toGateway: true });
        const ack = r.ack;
        if (!ack)
            return { transport: 'ws', status: r.status === 'timeout' ? 'unknown' : r.status };
        return {
            transport: 'ws',
            status: ack.status,
            ...(ack.status === 'ok' ? { online: ack.online === true } : {}),
            ...(ack.lastHeartbeat !== undefined ? { lastHeartbeat: ack.lastHeartbeat } : {}),
        };
    }
    /** 改角色名單（只有 owner 會成功；ADR 0049 §2.5） */
    updateAcl(op, opts = {}) {
        return this.command(IOT_ACL_TOPIC, JSON.stringify(op), opts);
    }
    /**
     * 登記（或更新）推播端點（ADR 0049 §11.1）：送到閘道的保留 topic `$sys/push`。端點本身再以 NIP-44 加密給閘道，其他成員讀不到；
     * 同一個端點再登記一次＝更新訂閱與續期。額度預警（`special: 'quota'`）只有 owner 能訂閱。
     * 端點怎麼來：UnifiedPush 網址由 App 的 distributor 給；推播閘道端點由 App 以 `sealIotPushToken` 封自己的 FCM／APNs token
     *（SDK 不做 FCM／APNs 註冊，ADR 0011 §6）。
     */
    async registerPush(endpoint, subscriptions, opts = {}) {
        const ep = parseIotPushEndpoint(endpoint, { allowPrivateHttp: true }); // 能不能用 http 由閘道決定
        const subs = parseIotPushSubscriptions(subscriptions.map((s) => {
            if ('device' in s) {
                if (!isValidIotDeviceId(s.device))
                    throw new RangeError(`設備 id 不合法：${s.device}`);
                return { dv: this.#o.home.blind(iotBlindNames.device(s.device)), mode: s.mode ?? 'standard' };
            }
            return { special: s.special, mode: s.mode ?? 'standard' };
        }));
        const sealedForGateway = encryptWithKey(JSON.stringify(ep), this.#o.signer.conversationKey(this.#gateway));
        const { registrationTtlSec, ...command } = opts;
        const payload = JSON.stringify({ op: 'register', endpoint: sealedForGateway, subscriptions: subs, ...(registrationTtlSec !== undefined ? { ttlSec: registrationTtlSec } : {}) });
        const result = await this.command(IOT_PUSH_TOPIC, payload, command);
        return { ...result, endpointId: iotPushEndpointId(ep) };
    }
    /** 更新推播訂閱或續期（＝再登記一次同一個端點） */
    updatePush(endpoint, subscriptions, opts = {}) {
        return this.registerPush(endpoint, subscriptions, opts);
    }
    /** 撤銷推播端點（自己的；owner 可以撤銷任何人的）。推播閘道那一側另以 `buildIotPushRevokeBody` 撤銷封包 */
    revokePush(endpointOrId, opts = {}) {
        const id = typeof endpointOrId === 'string' ? endpointOrId : iotPushEndpointId(parseIotPushEndpoint(endpointOrId, { allowPrivateHttp: true }));
        return this.command(IOT_PUSH_TOPIC, JSON.stringify({ op: 'remove', id }), opts);
    }
    #sealDown(device, key, tsMs, inner) {
        this.#downCtr += 1;
        return sealIotEnvelope({ key, kid: iotKid(device.id, device.epoch), dir: 'down', ctr: this.#downCtr, ts: Math.floor(tsMs / 1000), plaintext: JSON.stringify(inner) });
    }
    #rtTags(device, expiration) {
        return [
            ['h', this.#o.home.homeTag],
            ['p', this.#rt.gateway],
            ['dv', this.#o.home.blind(iotBlindNames.device(device.id))],
            ['expiration', String(expiration)],
        ];
    }
    /** 包成事件：閘道路線加密給全家（homePub）；C′ 的外層加密給 relay 的閘道公鑰（relay 要剝掉外層才能轉給設備） */
    #build(route, kind, tags, body, toGateway) {
        if (!toGateway)
            return buildIotEvent(this.#keyring, this.#o.signer, kind, tags, body);
        const content = encryptWithKey(JSON.stringify(body), this.#o.signer.conversationKey(route.gateway));
        return this.#o.signer.sign({ kind, created_at: Math.floor(body.ts / 1000), tags, content });
    }
    async #sendAndWait(route, kind, tags, body, p) {
        this.#ensureAcks(route);
        let acked;
        let wake;
        const waiter = {
            resolve: (ack) => {
                acked ??= ack;
                wake?.();
            },
        };
        const set = this.#waiters.get(p.msgId) ?? new Set();
        set.add(waiter);
        this.#waiters.set(p.msgId, set);
        let attempts = 0;
        let lastRejected;
        try {
            for (let attempt = 0; attempt <= p.retries && !this.#closed; attempt += 1) {
                if (attempt > 0 && Math.floor(this.#now() / 1000) >= p.expiration)
                    break; // 指令已過期：不再送
                // 每次重新簽章（新的 created_at 與 NIP-44 nonce ⇒ 新 id），內容的 msgId 與 ts 不變
                const event = this.#build(route, kind, tags, body, p.toGateway === true);
                attempts += 1;
                const outcome = await iotPublish(route.pool, this.#budget, event);
                if (acked)
                    break;
                lastRejected = outcome.ok ? undefined : outcome.rejected;
                // 中繼說今日額度用完（ADR 0049 §10）：重送也一樣，不必等
                if (lastRejected?.some((r) => QUOTA_REJECTION.test(r.reason)))
                    break;
                await this.#pause(p.timeoutMs * 2 ** attempt, (w) => {
                    wake = w;
                });
                wake = undefined;
                if (acked)
                    break;
            }
        }
        finally {
            set.delete(waiter);
            if (set.size === 0)
                this.#waiters.delete(p.msgId);
        }
        const ack = acked;
        if (ack) {
            return { status: ack.status, msgId: p.msgId, attempts, ackedAt: ack.ts, ...(ack.reason !== undefined ? { reason: ack.reason } : {}), ack };
        }
        if (lastRejected) {
            const quota = lastRejected.map((r) => QUOTA_REJECTION.exec(r.reason)).find((m) => m !== null);
            if (quota)
                return { status: 'quota', msgId: p.msgId, attempts, rejected: lastRejected, ...(quota[1] !== undefined ? { reset: Number(quota[1]) } : {}) };
            return { status: 'relay-rejected', msgId: p.msgId, attempts, rejected: lastRejected };
        }
        return { status: 'timeout', msgId: p.msgId, attempts };
    }
    /** 等 `ms` 毫秒，或被叫醒（收到 ack、`close()`） */
    #pause(ms, register) {
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                this.#wakers.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.#wakers.add(finish);
            register(finish);
        });
    }
    #ensureAcks(route) {
        if (route.acks)
            return;
        const filter = { kinds: [IOT_KIND_ACK], authors: [route.gateway], '#p': [this.#o.signer.pubkey], '#h': [this.#o.home.homeTag] };
        route.acks = route.pool.subscribe([filter], { onEvent: (event) => this.#onAck(route, event) });
    }
    #onAck(route, event) {
        if (event.kind !== IOT_KIND_ACK || event.pubkey !== route.gateway || !iotVerified(event))
            return;
        if (tagValue(event, 'h') !== this.#o.home.homeTag)
            return;
        const opened = this.#keyring.open(event.content, event.pubkey);
        let body;
        if (opened?.type === 'ack')
            body = opened;
        else if (opened?.type === 'dev-ack' && route === this.#rt) {
            // C′ 設備的 ack：回覆哪一則指令寫在信封裡面（relay 看不到）
            const up = this.#openUp(opened, true);
            if (up?.type !== 'ack')
                return;
            body = {
                v: 1,
                type: 'ack',
                msgId: opened.msgId,
                ts: opened.ts,
                inReplyTo: up.inReplyTo,
                status: up.status,
                device: opened.device,
                ...(up.reason !== undefined ? { reason: up.reason } : {}),
                ...(up.topics !== undefined ? { topics: up.topics } : {}),
            };
        }
        else
            return;
        const waiters = this.#waiters.get(body.inReplyTo);
        if (!waiters)
            return;
        const verdict = this.#ackGuard.check(body.msgId, body.ts);
        if (verdict.verdict !== 'fresh')
            return;
        for (const w of waiters)
            w.resolve(body);
    }
    /**
     * 解開 C′ 設備的 up 信封（以 `deviceKey`；只認設定的 epoch）。`live`：即時的 ack／狀態要在時間窗內、沒看過（`kid#ctr`）；
     * retained 是舊值，不做這兩項檢查。
     */
    #openUp(body, live) {
        const device = this.#rtDevices.get(body.device);
        const kid = parseIotKid(body.env.kid);
        if (!device || !kid || kid.deviceId !== device.id || kid.epoch !== device.epoch)
            return undefined;
        let plaintext;
        try {
            plaintext = openIotEnvelope(body.env, this.#o.home.deviceKey(device.id, device.epoch));
        }
        catch {
            return undefined;
        }
        if (live && this.#upGuard.check(`${body.env.kid}#${body.env.ctr}`, body.env.ts * 1000).verdict !== 'fresh')
            return undefined;
        return parseIotUpMessage(plaintext);
    }
    // ── 狀態 ─────────────────────────────────────────────────────────
    /** 訂閱即時狀態（kind 25172）；`pattern` 是 MQTT 樣式（`+`、`#`） */
    subscribeState(pattern, onMessage) {
        const plan = topicSubscriptionPlan(pattern);
        const blind = this.#o.home.blind;
        const filter = { kinds: [IOT_KIND_STATE], authors: [this.#gateway], '#h': [this.#o.home.homeTag] };
        if (plan.by === 'exact')
            filter['#t'] = [blind(plan.value)];
        if (plan.by === 'prefix')
            filter['#tp'] = [blind(plan.value)];
        const guard = new IotReplayGuard({ maxSkewSec: this.#o.maxSkewSec, now: this.#now });
        const sub = this.#o.pool.subscribe([filter], {
            onEvent: (event) => {
                if (event.kind !== IOT_KIND_STATE || event.pubkey !== this.#gateway || !iotVerified(event))
                    return;
                const body = this.#keyring.open(event.content, event.pubkey);
                if (!body || body.type !== 'state')
                    return;
                if (tagValue(event, 't') !== blind(body.topic) || !topicMatches(pattern, body.topic))
                    return;
                if (guard.check(body.msgId, body.ts).verdict !== 'fresh')
                    return;
                try {
                    onMessage({
                        topic: body.topic,
                        payload: body.payload,
                        enc: body.enc,
                        ts: body.ts,
                        ...(body.device !== undefined ? { device: body.device } : {}),
                        live: true,
                        ...(body.will !== undefined ? { will: body.will } : {}),
                        ...(body.inReplyTo !== undefined ? { inReplyTo: body.inReplyTo } : {}),
                    });
                }
                catch (error) {
                    this.#o.onError?.(error);
                }
            },
        });
        const subs = [sub];
        // C′ 設備的狀態：relay 看不到 topic，事件只以 `d`＝盲化設備 id 標記；topic 在信封裡，解開後才比對
        const rt = this.#rt;
        if (rt && this.#rtDevices.size > 0) {
            const blinds = [...this.#rtDevices.keys()].map((id) => blind(iotBlindNames.device(id)));
            const rtSub = rt.pool.subscribe([{ kinds: [IOT_KIND_STATE], authors: [rt.gateway], '#h': [this.#o.home.homeTag], '#d': blinds }], {
                onEvent: (event) => {
                    if (event.kind !== IOT_KIND_STATE || event.pubkey !== rt.gateway || !iotVerified(event))
                        return;
                    const body = this.#keyring.open(event.content, event.pubkey);
                    if (body?.type !== 'dev-state' || tagValue(event, 'd') !== blind(iotBlindNames.device(body.device)))
                        return;
                    const up = this.#openUp(body, true);
                    if (up?.type !== 'state')
                        return;
                    for (const [topic, value] of Object.entries(up.topics)) {
                        if (!topicMatches(pattern, topic))
                            continue;
                        try {
                            onMessage({ topic, payload: value.payload, enc: value.enc ?? 'utf8', ts: value.ts, device: body.device, live: true, ...(up.will !== undefined ? { will: up.will } : {}) });
                        }
                        catch (error) {
                            this.#o.onError?.(error);
                        }
                    }
                },
            });
            subs.push(rtSub);
        }
        for (const s of subs)
            this.#subs.add(s);
        return {
            close: () => {
                for (const s of subs) {
                    s.close();
                    this.#subs.delete(s);
                }
            },
        };
    }
    async #readRetained(filter, route = this.#main) {
        const events = await iotQuery(route.pool, [filter], this.#o.readTimeoutMs ?? 5_000);
        const out = [];
        for (const event of events) {
            if (event.kind !== IOT_KIND_RETAINED || event.pubkey !== route.gateway || !iotVerified(event))
                continue;
            if (tagValue(event, 'h') !== this.#o.home.homeTag)
                continue;
            const exp = expirationOf(event);
            if (exp !== undefined && exp <= Math.floor(this.#now() / 1000))
                continue;
            out.push({ event, body: this.#keyring.open(event.content, event.pubkey) });
        }
        return out;
    }
    #stale(ts) {
        return this.#now() - ts > (this.#o.staleAfterSec ?? IOT_DEFAULT_STALE_AFTER_SEC) * 1000;
    }
    /** 讀一台設備的 retained（31170），不打擾設備；沒有回 undefined */
    async getRetained(device) {
        if (!isValidIotDeviceId(device))
            throw new RangeError(`設備 id 不合法：${device}`);
        const rt = this.#rt;
        if (rt && this.#rtDevices.has(device)) {
            // C′：relay 保存的是最後一個狀態幀（每台至少隔 5 分鐘寫一次），只有那一幀帶到的 topic
            const blindId = this.#o.home.blind(iotBlindNames.device(device));
            const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [rt.gateway], '#d': [blindId] }, rt);
            const newest = rows
                .map((r) => r.body)
                .filter((b) => b?.type === 'dev-state' && b.device === device)
                .sort((a, b) => b.env.ts - a.env.ts)[0];
            const up = newest ? this.#openUp(newest, false) : undefined;
            if (up?.type !== 'state')
                return undefined;
            const ts = newest.env.ts * 1000;
            return { device, topics: up.topics, ts, stale: this.#stale(ts), complete: false };
        }
        const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [this.#gateway], '#dv': [this.#o.home.blind(iotBlindNames.device(device))] });
        const parts = rows.map((r) => r.body).filter((b) => b?.type === 'retained' && b.device === device);
        const merged = mergeIotRetained(parts);
        if (!merged)
            return undefined;
        return { ...merged, stale: this.#stale(merged.ts) };
    }
    /** 這個家所有有 retained 的設備 */
    async listDevices() {
        const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [this.#gateway], '#h': [this.#o.home.homeTag] });
        const byDevice = new Map();
        for (const { body } of rows) {
            if (body?.type !== 'retained')
                continue;
            const list = byDevice.get(body.device) ?? [];
            list.push(body);
            byDevice.set(body.device, list);
        }
        const out = [];
        for (const [device, parts] of byDevice) {
            const merged = mergeIotRetained(parts);
            out.push({
                device,
                ...(merged.online !== undefined ? { online: merged.online } : {}),
                lastSeen: merged.ts,
                topicCount: Object.keys(merged.topics).length,
                stale: this.#stale(merged.ts),
            });
        }
        return out.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
    }
    /** 閘道目前的角色名單（閘道發的 31170 `sys:acl`）；讀不到或格式不對回 undefined */
    async getAcl() {
        const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [this.#gateway], '#d': [this.#o.home.blind(iotBlindNames.acl)] });
        const newest = rows
            .map((r) => r.body)
            .filter((b) => b?.type === 'acl')
            .sort((a, b) => b.ts - a.ts)[0];
        if (newest?.type !== 'acl')
            return undefined;
        try {
            return parseIotAcl(newest.acl);
        }
        catch {
            return undefined;
        }
    }
    /** 自己在閘道名單上的角色（讀 `sys:acl`）；不在名單或過期回 undefined */
    async myRole() {
        const acl = await this.getAcl();
        return acl ? iotRoleOf(acl, this.#o.signer.pubkey, Math.floor(this.#now() / 1000)) : undefined;
    }
    /** 看閘道死活（31171 心跳；過期＝離線）。回傳停止函式 */
    watchGateway(onStatus) {
        let latest;
        let timer;
        let lastReported;
        const report = () => {
            const now = this.#now();
            const online = latest !== undefined && latest.online && latest.expiresAt * 1000 > now;
            const status = { online, ...(latest ? { lastSeen: latest.ts } : {}) };
            const key = JSON.stringify(status);
            if (key === lastReported)
                return;
            lastReported = key;
            try {
                onStatus(status);
            }
            catch (error) {
                this.#o.onError?.(error);
            }
        };
        const arm = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            if (!latest?.online)
                return;
            const ms = latest.expiresAt * 1000 - this.#now();
            if (ms <= 0)
                return;
            timer = setTimeout(report, ms + 50);
        };
        const filter = { kinds: [IOT_KIND_HEARTBEAT], authors: [this.#gateway], '#d': [this.#o.home.blind(iotBlindNames.gateway)] };
        const sub = this.#o.pool.subscribe([filter], {
            onEvent: (event) => {
                if (event.kind !== IOT_KIND_HEARTBEAT || event.pubkey !== this.#gateway || !iotVerified(event))
                    return;
                if (tagValue(event, 'h') !== this.#o.home.homeTag)
                    return;
                const body = this.#keyring.open(event.content, event.pubkey);
                const expiresAt = expirationOf(event);
                if (body?.type !== 'gw' || expiresAt === undefined)
                    return;
                if (latest && body.ts <= latest.ts)
                    return;
                latest = { ts: body.ts, online: body.online, expiresAt };
                report();
                arm();
            },
            onEose: () => report(),
        });
        this.#subs.add(sub);
        return () => {
            if (timer !== undefined)
                clearTimeout(timer);
            sub.close();
            this.#subs.delete(sub);
        };
    }
}
//# sourceMappingURL=client.js.map