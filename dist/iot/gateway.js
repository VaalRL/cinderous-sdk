import { decryptWithKey } from '../protocol/nip44.js';
import { RelayEventBudget, sharedRelayEventBudget } from '../relay-budget.js';
import { applyIotAclOp, authorizeIot, iotRoleOf, parseIotAcl, parseIotAclOp, } from './acl.js';
import { buildIotEvent, expirationOf, IOT_PAYLOAD_MAX_BYTES, IotKeyring, newIotMsgId, tagValue, } from './content.js';
import { iotBlindNames } from './keys.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE, IOT_MAX_TTL_SEC } from './kinds.js';
import { fetchIotPushSend, parseIotPushEndpoint, parseIotPushOp } from './push.js';
import { IotPushRegistry, parseIotPushRegistrations } from './push-registry.js';
import { IotPushScheduler } from './push-scheduler.js';
import { clampIot, IotReplayGuard } from './replay.js';
import { packIotRetained } from './retained.js';
import { assertIotTopic, IOT_ACL_TOPIC, IOT_PUSH_TOPIC, isValidIotDeviceId, topicPrefixes } from './topic.js';
import { iotPublish, iotVerified } from './transport.js';
export const IOT_DEFAULT_HEARTBEAT_SEC = 60;
export const IOT_DEFAULT_RETAINED_REFRESH_SEC = 6 * 3600;
export const IOT_DEFAULT_QUERY_MIN_INTERVAL_SEC = 5;
export const IOT_DEFAULT_QUERY_TIMEOUT_MS = 5_000;
/** 可尋址事件沒送出去時的重試間隔（毫秒） */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];
function normalizeAcl(acl) {
    if (acl === undefined)
        return undefined;
    return parseIotAcl(acl);
}
export class IotGateway {
    #o;
    #keyring;
    #budget;
    #guard;
    #now;
    #heartbeatSec;
    #refreshSec;
    #queryIntervalMs;
    #devices = new Map();
    #pending = new Map();
    #live = new Map();
    #acl = { entries: [] };
    #aclChain = Promise.resolve();
    #sub;
    #heartbeat;
    #refresh;
    #running = false;
    #retries = new Map();
    /** 每個可尋址位址最後一次用的 `created_at`（秒） */
    #lastSec = new Map();
    /** 推播（沒開＝undefined） */
    #pushRegistry;
    #pushScheduler;
    #pushChain = Promise.resolve();
    /** 每個端點最後一次喚醒的時間戳（毫秒）：推播閘道要求同一個登記嚴格遞增 */
    #pushTs = new Map();
    constructor(opts) {
        this.#o = opts;
        this.#keyring = new IotKeyring(opts.home, opts.signer);
        this.#budget = opts.budget ?? sharedRelayEventBudget(opts.signer.pubkey);
        this.#now = opts.now ?? Date.now;
        this.#guard = new IotReplayGuard({ maxSkewSec: opts.maxSkewSec, size: opts.dedupeSize, now: this.#now });
        this.#heartbeatSec = clampIot(opts.heartbeatSec, IOT_DEFAULT_HEARTBEAT_SEC, 15, 600);
        this.#refreshSec = clampIot(opts.retainedRefreshSec, IOT_DEFAULT_RETAINED_REFRESH_SEC, 600, 86_400);
        this.#queryIntervalMs = clampIot(opts.queryMinIntervalSec, IOT_DEFAULT_QUERY_MIN_INTERVAL_SEC, 1, 300) * 1000;
        const initial = normalizeAcl(opts.acl);
        if (initial)
            this.#acl = initial;
        this.#pushRegistry = opts.push ? new IotPushRegistry({ ...(opts.push.limits ? { limits: opts.push.limits } : {}) }) : undefined;
    }
    get pubkey() {
        return this.#o.signer.pubkey;
    }
    /** 目前的角色名單（閘道本地為準） */
    acl() {
        return this.#acl;
    }
    /** 閘道收指令與查詢的過濾條件 */
    filters() {
        return [{ kinds: [IOT_KIND_COMMAND, IOT_KIND_QUERY], '#p': [this.pubkey], '#h': [this.#o.home.homeTag] }];
    }
    /** 讀回存檔的名單、訂閱、發出名單與第一次心跳、開始定期刷新 */
    async start() {
        if (this.#running)
            return;
        this.#running = true;
        const stored = await this.#o.aclStore?.load();
        if (stored)
            this.#acl = parseIotAcl(stored);
        else if (this.#o.aclStore && this.#acl.entries.length > 0)
            await this.#o.aclStore.save(this.#acl);
        if (!this.#acl.entries.some((e) => e.role === 'owner'))
            this.#o.onError?.(new Error('角色名單沒有 owner：之後沒有人能經 $sys/acl 修改名單'));
        await this.#startPush();
        this.#sub = this.#o.pool.subscribe(this.filters(), { onEvent: (event) => void this.#onEvent(event).catch((e) => this.#o.onError?.(e)) });
        this.#heartbeat = setInterval(() => void this.#publishHeartbeat(true).catch((e) => this.#o.onError?.(e)), this.#heartbeatSec * 1000);
        this.#refresh = setInterval(() => void this.#refreshAll().catch((e) => this.#o.onError?.(e)), this.#refreshSec * 1000);
        await Promise.all([this.#publishHeartbeat(true), this.#publishAcl()]);
    }
    /** 停止；`announceOffline`（預設 true）先發一顆 `online: false` 的心跳 */
    async stop(opts = {}) {
        if (!this.#running)
            return;
        this.#running = false;
        this.#sub?.close();
        this.#sub = undefined;
        clearInterval(this.#heartbeat);
        clearInterval(this.#refresh);
        for (const state of this.#devices.values())
            clearTimeout(state.retainedTimer);
        for (const list of this.#pending.values())
            for (const p of list)
                clearTimeout(p.timer);
        this.#pending.clear();
        for (const slot of this.#live.values())
            clearTimeout(slot.timer);
        for (const timer of this.#retries.values())
            clearTimeout(timer);
        this.#retries.clear();
        this.#pushScheduler?.stop();
        this.#pushScheduler = undefined;
        if (opts.announceOffline !== false)
            await this.#publishHeartbeat(false).catch(() => { });
    }
    /**
     * 設備回報了一個 topic 的值（橋接器收到 MQTT 訊息時呼叫）：更新本機快取 → 回覆等待中的查詢 → 發即時狀態（節流）→
     * 值有變就（合併延遲後）更新 retained。
     */
    async reportState(input) {
        assertIotTopic(input.topic);
        if (new TextEncoder().encode(input.payload).length > IOT_PAYLOAD_MAX_BYTES)
            throw new RangeError(`酬載超過 ${IOT_PAYLOAD_MAX_BYTES} bytes：${input.topic}`);
        const device = input.device ?? this.#o.handler.deviceOf?.(input.topic);
        if (device !== undefined && !isValidIotDeviceId(device))
            throw new RangeError(`設備 id 不合法：${device}`);
        const now = this.#now();
        const value = { payload: input.payload, ts: now, ...(input.enc && input.enc !== 'utf8' ? { enc: input.enc } : {}) };
        let changed = true;
        let onlineChanged = false;
        if (device !== undefined) {
            const state = this.#device(device);
            const previous = state.topics[input.topic];
            changed = previous === undefined || previous.payload !== value.payload || (previous.enc ?? 'utf8') !== (value.enc ?? 'utf8');
            state.topics[input.topic] = value;
            if (input.online !== undefined && input.online !== state.online) {
                state.online = input.online;
                onlineChanged = true;
            }
            this.#collectQueries(device);
        }
        const waiting = device !== undefined ? (this.#pending.get(device) ?? []) : [];
        const liveId = await this.#publishLive(input.topic, device, value, input.will, changed, waiting);
        if (device !== undefined && (changed || onlineChanged))
            this.#scheduleRetained(device);
        // 推播（裁示 1）：訂閱這台設備的端點在它的狀態**有變化**時被喚醒（重複回報同一個值不喚醒）；細部條件由 App 醒來後在本機判斷
        if (device !== undefined && (changed || onlineChanged || input.will === true))
            this.#notifyPush({ dv: this.#o.home.blind(iotBlindNames.device(device)) }, liveId);
    }
    /** 設備上線／離線（例如橋接器看到設備的 LWT）；只更新 retained 的 `online` */
    setDeviceOnline(device, online) {
        const state = this.#device(device);
        if (state.online === online)
            return;
        state.online = online;
        this.#scheduleRetained(device);
        this.#notifyPush({ dv: this.#o.home.blind(iotBlindNames.device(device)) });
    }
    /**
     * 特殊項目的喚醒（裁示 1：額度預警只有 owner 能訂閱）。路線 A 的閘道本身看不到中繼額度，由宿主（或日後的中繼送出端）呼叫；
     * `ref`＝相關事件的 id（選用）。沒開推播＝什麼都不做。
     */
    notifyPushSpecial(special, ref) {
        this.#notifyPush({ special }, ref);
    }
    /** 目前保存的推播登記（不含已過期的；沒開推播＝空陣列）。內容含端點能力，只給本機管理介面用 */
    pushRegistrations() {
        const registry = this.#pushRegistry;
        if (!registry)
            return [];
        const nowSec = Math.floor(this.#now() / 1000);
        return registry.list().filter((r) => r.expiresAt > nowSec);
    }
    /** 本機快取的一台設備（測試與橋接器用） */
    deviceSnapshot(device) {
        const state = this.#devices.get(device);
        return state ? { topics: { ...state.topics }, ...(state.online !== undefined ? { online: state.online } : {}) } : undefined;
    }
    #device(device) {
        let state = this.#devices.get(device);
        if (!state)
            this.#devices.set(device, (state = { topics: {} }));
        return state;
    }
    #log(entry) {
        try {
            this.#o.onLog?.(entry);
        }
        catch {
            // 紀錄失敗不影響閘道
        }
    }
    // ── 收：指令與查詢 ────────────────────────────────────────────────
    async #onEvent(event) {
        if (!this.#running)
            return;
        if (event.kind !== IOT_KIND_COMMAND && event.kind !== IOT_KIND_QUERY)
            return;
        if (event.pubkey === this.pubkey || !iotVerified(event))
            return;
        if (tagValue(event, 'h') !== this.#o.home.homeTag || !event.tags.some((t) => t[0] === 'p' && t[1] === this.pubkey))
            return;
        const opened = this.#keyring.open(event.content, event.pubkey);
        if (!opened)
            return this.#log({ kind: 'drop', from: event.pubkey, reason: 'undecryptable' });
        const expectType = event.kind === IOT_KIND_COMMAND ? 'cmd' : 'query';
        if (opened.type !== expectType || (opened.type !== 'cmd' && opened.type !== 'query'))
            return this.#log({ kind: 'drop', from: event.pubkey, reason: 'kind-mismatch' });
        const body = opened;
        if (body.type === 'cmd' && tagValue(event, 't') !== this.#o.home.blind(body.topic))
            return this.#log({ kind: 'drop', from: event.pubkey, reason: 'tag-mismatch' });
        const kind = body.type === 'cmd' ? 'command' : 'query';
        const nowSec = Math.floor(this.#now() / 1000);
        const expiration = expirationOf(event);
        const subject = body.type === 'cmd' ? { topic: body.topic, ...(body.device ? { device: body.device } : {}) } : { device: body.device };
        // 過期、沒有到期時間、或到期時間太遠：拒收（中繼與離線補收都不該送出過期指令；ADR 0049 §2.4）
        if (expiration === undefined || expiration > Math.floor(body.ts / 1000) + IOT_MAX_TTL_SEC) {
            return this.#ackOnce(event, body, 'rejected', 'expiration-required', kind, subject);
        }
        if (expiration <= nowSec)
            return this.#ackOnce(event, body, 'rejected', 'expired', kind, subject);
        const key = `${event.pubkey}:${body.msgId}`;
        const verdict = this.#guard.check(key, body.ts);
        if (verdict.verdict === 'duplicate') {
            // 冪等：重送同一個結果（QoS 1 的重送會被中繼視為新事件，因為每次都重新簽章）
            if (verdict.result)
                await this.#sendAck(event, { ...verdict.result, msgId: newIotMsgId(), ts: this.#now() });
            return;
        }
        if (verdict.verdict === 'too-old')
            return this.#ackOnce(event, body, 'rejected', 'stale', kind, subject);
        if (verdict.verdict === 'too-new')
            return this.#ackOnce(event, body, 'rejected', 'clock-skew', kind, subject);
        if (verdict.verdict === 'busy')
            return this.#ackOnce(event, body, 'rejected', 'busy', kind, subject);
        if (body.type === 'cmd')
            await this.#handleCommand(event, body, key, nowSec);
        else
            await this.#handleQuery(event, body, key, nowSec);
    }
    async #handleCommand(event, body, key, nowSec) {
        const device = body.device ?? this.#o.handler.deviceOf?.(body.topic);
        const auth = authorizeIot(this.#acl, { pubkey: event.pubkey, action: 'operate', topic: body.topic, ...(device !== undefined ? { device } : {}), ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}) }, nowSec);
        const subject = { topic: body.topic, ...(device !== undefined ? { device } : {}) };
        if (!auth.ok)
            return this.#finish(event, body, key, auth.status, auth.reason, 'command', subject);
        if (body.topic === IOT_ACL_TOPIC)
            return this.#handleAclOp(event, body, key);
        if (body.topic === IOT_PUSH_TOPIC)
            return this.#handlePushOp(event, body, key, auth.role);
        let outcome;
        try {
            outcome = await this.#o.handler.command({
                topic: body.topic,
                ...(device !== undefined ? { device } : {}),
                payload: body.payload,
                enc: body.enc,
                msgId: body.msgId,
                from: event.pubkey,
                role: auth.role,
            });
        }
        catch (error) {
            this.#o.onError?.(error);
            outcome = { status: 'rejected', reason: 'device-error' };
        }
        await this.#finish(event, body, key, outcome.status, outcome.reason, 'command', subject);
    }
    #handleAclOp(event, body, key) {
        const run = this.#aclChain.then(async () => {
            let status = 'ok';
            let reason;
            try {
                const op = parseIotAclOp(body.payload);
                const next = applyIotAclOp(this.#acl, op, Math.floor(this.#now() / 1000));
                await this.#o.aclStore?.save(next);
                this.#acl = next;
                // 撤銷成員：一併清掉他登記的推播端點（ADR 0049 §11.1）
                if (op.op === 'remove')
                    await this.#dropPushOwner(op.pubkey);
                await this.#publishAcl();
            }
            catch (error) {
                status = 'rejected';
                reason = error instanceof Error ? error.message.slice(0, 200) : 'invalid';
            }
            await this.#finish(event, body, key, status, reason, 'acl', { topic: IOT_ACL_TOPIC });
        });
        this.#aclChain = run.catch(() => { });
        return run;
    }
    // ── 推播（ADR 0049 §11.1）──────────────────────────────────────────
    /** 推播的變更一次一個（登記、移除、清掉某成員、對方回 gone） */
    #withPush(fn) {
        const registry = this.#pushRegistry;
        const run = this.#pushChain.then(() => fn(registry));
        this.#pushChain = run.then(() => { }, () => { });
        return run;
    }
    async #savePush(registry) {
        await this.#o.push?.store?.save(registry.list());
    }
    async #startPush() {
        const registry = this.#pushRegistry;
        const push = this.#o.push;
        if (!registry || !push)
            return;
        const stored = await push.store?.load();
        if (stored)
            registry.load(parseIotPushRegistrations(stored, { allowPrivateHttp: push.allowPrivateHttp === true }));
        if (registry.prune(Math.floor(this.#now() / 1000)).length > 0)
            await this.#savePush(registry);
        const send = push.send ?? fetchIotPushSend();
        this.#pushScheduler = new IotPushScheduler({
            limits: registry.limits,
            now: this.#now,
            ...(push.random ? { random: push.random } : {}),
            ...(push.timers ? { timers: push.timers } : {}),
            send: async (id, wake) => {
                const reg = registry.get(id);
                if (!reg || reg.expiresAt <= Math.floor(this.#now() / 1000))
                    return { status: 'ok' }; // 已撤銷或過期：不送
                return send(reg.endpoint, { ts: this.#nextPushTs(id), ...(wake.ref !== undefined ? { ref: wake.ref } : {}) });
            },
            onGone: (id) => {
                this.#log({ kind: 'push', reason: 'endpoint-gone' });
                void this.#withPush(async (r) => {
                    if (r.get(id)) {
                        r.remove(id, r.get(id).owner, true);
                        await this.#savePush(r);
                    }
                }).catch((e) => this.#o.onError?.(e));
            },
            onError: (_id, reason) => this.#log({ kind: 'push', reason: `send-failed:${reason}` }),
        });
    }
    /** 同一個端點的喚醒時間戳嚴格遞增（推播閘道以它防重放） */
    #nextPushTs(id) {
        const ts = Math.max(this.#now(), (this.#pushTs.get(id) ?? 0) + 1);
        this.#pushTs.set(id, ts);
        return ts;
    }
    #notifyPush(match, ref) {
        const registry = this.#pushRegistry;
        const scheduler = this.#pushScheduler;
        if (!registry || !scheduler || !this.#running)
            return;
        const nowSec = Math.floor(this.#now() / 1000);
        // 送出時再看一次角色：成員已被移除或過期 → 不送；特殊項目只給目前仍是 owner 的人
        const targets = registry.targets(match, nowSec, (owner, special) => {
            const role = iotRoleOf(this.#acl, owner, nowSec);
            return role !== undefined && (!special || role === 'owner');
        });
        for (const target of targets)
            scheduler.notify(target.id, target.mode, ref);
    }
    async #dropPushOwner(pubkey) {
        if (!this.#pushRegistry)
            return;
        await this.#withPush(async (registry) => {
            const gone = registry.removeByOwner(pubkey);
            for (const id of gone)
                this.#pushScheduler?.cancel(id);
            if (gone.length > 0)
                await this.#savePush(registry);
        });
    }
    #handlePushOp(event, body, key, role) {
        if (!this.#pushRegistry)
            return this.#finish(event, body, key, 'rejected', 'push-disabled', 'push', { topic: IOT_PUSH_TOPIC });
        return this.#withPush(async (registry) => {
            let status = 'ok';
            let reason;
            const nowSec = Math.floor(this.#now() / 1000);
            try {
                const op = parseIotPushOp(body.payload);
                if (op.op === 'register') {
                    const endpoint = this.#openPushEndpoint(op.endpoint, event.pubkey);
                    const outcome = registry.register({ owner: event.pubkey, endpoint, subscriptions: op.subscriptions, ...(op.ttlSec !== undefined ? { ttlSec: op.ttlSec } : {}), isOwner: role === 'owner' }, nowSec);
                    if (outcome.ok)
                        await this.#savePush(registry);
                    else
                        [status, reason] = ['rejected', outcome.reason];
                }
                else {
                    const why = registry.remove(op.id, event.pubkey, role === 'owner');
                    if (why === undefined) {
                        this.#pushScheduler?.cancel(op.id);
                        await this.#savePush(registry);
                    }
                    else
                        [status, reason] = ['rejected', why];
                }
            }
            catch (error) {
                status = 'rejected';
                reason = error instanceof Error ? error.message.slice(0, 200) : 'invalid';
            }
            await this.#finish(event, body, key, status, reason, 'push', { topic: IOT_PUSH_TOPIC });
        });
    }
    /** 端點以 NIP-44 加密給閘道（成員私鑰 × 閘道公鑰）：其他成員讀不到。錯誤訊息不含端點內容 */
    #openPushEndpoint(ciphertext, member) {
        let raw;
        try {
            raw = JSON.parse(decryptWithKey(ciphertext, this.#o.signer.conversationKey(member)));
        }
        catch {
            throw new RangeError('推播端點解不開（要以 NIP-44 加密給閘道）');
        }
        return parseIotPushEndpoint(raw, { allowPrivateHttp: this.#o.push?.allowPrivateHttp === true });
    }
    async #handleQuery(event, body, key, nowSec) {
        const subject = { device: body.device };
        const auth = authorizeIot(this.#acl, { pubkey: event.pubkey, action: 'query', device: body.device }, nowSec);
        if (!auth.ok)
            return this.#finish(event, body, key, auth.status, auth.reason, 'query', subject);
        const state = this.#device(body.device);
        const now = this.#now();
        if (state.lastQueryAt !== undefined && now - state.lastQueryAt < this.#queryIntervalMs) {
            // 節流：不打擾設備，以快取（＝retained）回覆
            return this.#finish(event, body, key, 'throttled', undefined, 'query', subject, { topics: { ...state.topics }, fromRetained: true });
        }
        state.lastQueryAt = now;
        const retainedReply = (reason) => this.#finish(event, body, key, 'ok', reason, 'query', subject, { topics: { ...state.topics }, fromRetained: true });
        if (!this.#o.handler.query)
            return retainedReply('no-native-query');
        const timer = setTimeout(() => void this.#timeoutQuery(body.device, key).catch((e) => this.#o.onError?.(e)), this.#o.queryTimeoutMs ?? IOT_DEFAULT_QUERY_TIMEOUT_MS);
        const pending = { event, body, key, timer, collecting: false };
        const list = this.#pending.get(body.device) ?? [];
        list.push(pending);
        this.#pending.set(body.device, list);
        let dispatch;
        try {
            dispatch = await this.#o.handler.query(body.device);
        }
        catch (error) {
            this.#o.onError?.(error);
            dispatch = 'unsupported';
        }
        if (dispatch === 'sent')
            return;
        if (!this.#dropPending(body.device, key))
            return; // 已經回覆過了（設備回得比 query() 還快）
        if (dispatch === 'unknown-device')
            await this.#finish(event, body, key, 'unknown-topic', 'unknown-device', 'query', subject);
        else
            await retainedReply('no-native-query');
    }
    #dropPending(device, key) {
        const list = this.#pending.get(device);
        const index = list?.findIndex((p) => p.key === key) ?? -1;
        if (!list || index === -1)
            return undefined;
        const [pending] = list.splice(index, 1);
        clearTimeout(pending.timer);
        if (list.length === 0)
            this.#pending.delete(device);
        return pending;
    }
    async #timeoutQuery(device, key) {
        const pending = this.#dropPending(device, key);
        if (!pending)
            return;
        const topics = { ...(this.#devices.get(device)?.topics ?? {}) };
        await this.#finish(pending.event, pending.body, key, 'timeout', 'device-silent', 'query', { device }, { topics, fromRetained: true });
    }
    /** 設備回報到了：等 `queryCollectMs` 收齊同一次回報的其他 topic，再回覆所有等待中的查詢 */
    #collectQueries(device) {
        const list = this.#pending.get(device);
        if (!list)
            return;
        for (const pending of list) {
            if (pending.collecting)
                continue;
            pending.collecting = true;
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => {
                const done = this.#dropPending(device, pending.key);
                if (!done)
                    return;
                const topics = { ...(this.#devices.get(device)?.topics ?? {}) };
                void this.#finish(done.event, done.body, done.key, 'ok', undefined, 'query', { device }, { topics }).catch((e) => this.#o.onError?.(e));
            }, this.#o.queryCollectMs ?? 300);
        }
    }
    // ── 發：ack、即時狀態、retained、心跳 ───────────────────────────────
    /** 記下結果（去重命中時重送）並回 ack */
    async #finish(event, body, key, status, reason, kind, subject, extra = {}) {
        const ack = this.#ackBody(body, status, reason, extra);
        this.#guard.settle(key, ack);
        this.#log({ kind, from: event.pubkey, status, ...(reason !== undefined ? { reason } : {}), ...subject });
        await this.#sendAck(event, ack);
    }
    /** 不進去重快取的回覆（過期、時間窗外：這些本來就不會被當成新的） */
    async #ackOnce(event, body, status, reason, kind, subject) {
        if (body.type !== 'cmd' && body.type !== 'query')
            return;
        this.#log({ kind, from: event.pubkey, status, reason, ...subject });
        await this.#sendAck(event, this.#ackBody(body, status, reason));
    }
    #ackBody(body, status, reason, extra = {}) {
        return {
            v: 1,
            type: 'ack',
            msgId: newIotMsgId(),
            ts: this.#now(),
            inReplyTo: body.msgId,
            status,
            ...(reason !== undefined ? { reason } : {}),
            ...(body.type === 'query' ? { device: body.device } : {}),
            ...(extra.topics !== undefined ? { topics: extra.topics } : {}),
            ...(extra.fromRetained ? { fromRetained: true } : {}),
        };
    }
    async #sendAck(event, ack) {
        const tags = [
            ['h', this.#o.home.homeTag],
            ['e', event.id],
            ['p', event.pubkey],
            ['expiration', String(Math.floor(ack.ts / 1000) + 60)],
        ];
        await this.#publish(buildIotEvent(this.#keyring, this.#o.signer, IOT_KIND_ACK, tags, ack));
    }
    /** 發即時狀態；回傳送出的事件 id（節流延後或不發＝undefined） */
    async #publishLive(topic, device, value, will, changed, waiting) {
        const throttle = this.#o.throttle ?? {};
        if (waiting.length === 0 && throttle.onChangeOnly && !changed)
            return undefined;
        const minMs = clampIot(throttle.minIntervalSec, 0, 0, 86_400) * 1000;
        const slotKey = `${device ?? ''}|${topic}`;
        const slot = this.#live.get(slotKey) ?? { lastAt: Number.NEGATIVE_INFINITY };
        this.#live.set(slotKey, slot);
        const now = this.#now();
        if (waiting.length === 0 && minMs > 0 && now - slot.lastAt < minMs) {
            // 節流期間：記下最後一個值，時間到補發
            slot.pending = { device, value, ...(will !== undefined ? { will } : {}) };
            slot.timer ??= setTimeout(() => {
                slot.timer = undefined;
                const latest = slot.pending;
                slot.pending = undefined;
                if (latest && this.#running) {
                    slot.lastAt = this.#now();
                    void this.#sendState(topic, latest.device, latest.value, latest.will, []).catch((e) => this.#o.onError?.(e));
                }
            }, slot.lastAt + minMs - now);
            return undefined;
        }
        slot.lastAt = now;
        slot.pending = undefined;
        return this.#sendState(topic, device, value, will, waiting);
    }
    async #sendState(topic, device, value, will, waiting) {
        const blind = this.#o.home.blind;
        const tags = [
            ['h', this.#o.home.homeTag],
            ['t', blind(topic)],
            ...topicPrefixes(topic).map((prefix) => ['tp', blind(prefix)]),
        ];
        if (device !== undefined)
            tags.push(['d', blind(iotBlindNames.device(device))]);
        for (const p of waiting)
            tags.push(['e', p.event.id]);
        const firstWaiting = waiting[0];
        const event = buildIotEvent(this.#keyring, this.#o.signer, IOT_KIND_STATE, tags, {
            v: 1,
            type: 'state',
            msgId: newIotMsgId(),
            ts: value.ts,
            topic,
            ...(device !== undefined ? { device } : {}),
            payload: value.payload,
            enc: value.enc ?? 'utf8',
            ...(firstWaiting ? { inReplyTo: firstWaiting.body.msgId } : {}),
            ...(will !== undefined ? { will } : {}),
        });
        return (await this.#publish(event)) ? event.id : undefined;
    }
    #scheduleRetained(device) {
        const state = this.#device(device);
        if (state.retainedTimer !== undefined || !this.#running)
            return;
        state.retainedTimer = setTimeout(() => {
            state.retainedTimer = undefined;
            void this.#publishRetained(device).catch((e) => this.#o.onError?.(e));
        }, this.#o.retainedDebounceMs ?? 1_000);
    }
    async #publishRetained(device) {
        const state = this.#devices.get(device);
        if (!state || !this.#running)
            return true;
        const blind = this.#o.home.blind;
        const parts = packIotRetained({ device, topics: state.topics, ts: this.#addressableTs(`retained:${device}`), ...(state.online !== undefined ? { online: state.online } : {}) });
        for (const body of parts) {
            const tags = [
                ['d', blind(iotBlindNames.devicePart(device, body.part))],
                ['dv', blind(iotBlindNames.device(device))],
                ['h', this.#o.home.homeTag],
            ];
            if (!(await this.#publish(buildIotEvent(this.#keyring, this.#o.signer, IOT_KIND_RETAINED, tags, body)))) {
                this.#retryLater(`retained:${device}`, () => this.#publishRetained(device));
                return false;
            }
        }
        return true;
    }
    async #publishAcl() {
        const tags = [
            ['d', this.#o.home.blind(iotBlindNames.acl)],
            ['h', this.#o.home.homeTag],
        ];
        const ok = await this.#publish(buildIotEvent(this.#keyring, this.#o.signer, IOT_KIND_RETAINED, tags, { v: 1, type: 'acl', msgId: newIotMsgId(), ts: this.#addressableTs('acl'), acl: this.#acl }));
        if (!ok)
            this.#retryLater('acl', () => this.#publishAcl());
        return ok;
    }
    async #publishHeartbeat(online) {
        const now = this.#addressableTs('heartbeat');
        const tags = [
            ['d', this.#o.home.blind(iotBlindNames.gateway)],
            ['h', this.#o.home.homeTag],
            ['expiration', String(Math.floor(now / 1000) + (online ? 3 * this.#heartbeatSec : this.#heartbeatSec))],
        ];
        const ok = await this.#publish(buildIotEvent(this.#keyring, this.#o.signer, IOT_KIND_HEARTBEAT, tags, { v: 1, type: 'gw', msgId: newIotMsgId(), ts: now, online, heartbeatSec: this.#heartbeatSec }));
        if (!ok && online)
            this.#retryLater('heartbeat', () => this.#publishHeartbeat(true));
        return ok;
    }
    /**
     * 可尋址事件的時間：同一個位址的 `created_at`（秒）必須嚴格遞增，否則中繼回 `blocked: stale:` 不取代
     *（例如同一秒內連改兩次名單、或剛發完心跳就關閉時的 `online: false`）。
     */
    #addressableTs(key) {
        const last = this.#lastSec.get(key);
        let ts = this.#now();
        if (last !== undefined && Math.floor(ts / 1000) <= last)
            ts = (last + 1) * 1000;
        this.#lastSec.set(key, Math.floor(ts / 1000));
        return ts;
    }
    async #refreshAll() {
        await this.#publishAcl();
        for (const device of this.#devices.keys())
            await this.#publishRetained(device);
    }
    async #publish(event) {
        const outcome = await iotPublish(this.#o.pool, this.#budget, event);
        if (!outcome.ok) {
            const reasons = outcome.rejected.map((r) => `${r.url}: ${r.reason}`).join('；');
            this.#o.onError?.(new Error(`IoT 事件（kind ${event.kind}）沒有任何中繼收下${reasons ? `：${reasons}` : ''}`));
        }
        return outcome.ok;
    }
    /**
     * 可尋址的事件（名單、retained、心跳）沒送出去（例如連線還沒開好、中繼暫時拒收）：稍後以新的時間重做一次，
     * 最多 {@link RETRY_DELAYS_MS} 的次數；之後交給定期刷新。同一個鍵同時只排一次。
     */
    #retryLater(key, run, attempt = 0) {
        if (!this.#running || this.#retries.has(key) || attempt >= RETRY_DELAYS_MS.length)
            return;
        const timer = setTimeout(() => {
            this.#retries.delete(key);
            if (!this.#running)
                return;
            void run()
                .then((ok) => {
                if (!ok)
                    this.#retryLater(key, run, attempt + 1);
            })
                .catch((e) => this.#o.onError?.(e));
        }, RETRY_DELAYS_MS[attempt]);
        this.#retries.set(key, timer);
    }
}
//# sourceMappingURL=gateway.js.map