// `StarMember`：星狀會話的成員端（SDK ADR 0030）。
//
// 成員只連 Host 一條成對的雙棘輪通道。收到的每一則都是 Host 轉送的：寄件人（`from`）與序號（`seq`）由 Host 填，
// Host 能讀、也能改經過它的內容——這是星狀拓撲的信任前提，不是端到端群組加密。
import { secureChannel } from '../crypto/secure-channel.js';
import { DEFAULT_STAR_JOIN_TIMEOUT_MS } from './host.js';
import { isStarInviteExpired, parseStarInvite } from './invite.js';
import { Link, realTimers, resolveTuning, starRelayBudget } from './link.js';
import { decodeDeliver, decodeEnd, decodeReject, decodeRoster, decodeWelcome, encodeJoin, encodeSend, RecordType, STAR_MAX_RECIPIENTS, } from './wire.js';
const PK_HEX = /^[0-9a-f]{64}$/;
const LEAVE_GRACE_MS = 2_000;
/** 還沒註冊 onMessage 時最多先收著幾則 */
const MAX_BUFFERED = 10_000;
export class StarJoinError extends Error {
    reason;
    name = 'StarJoinError';
    constructor(reason, message) {
        super(message ?? `無法加入星狀會話：${reason}`);
        this.reason = reason;
    }
}
export class StarMemberError extends Error {
    code;
    name = 'StarMemberError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class StarMember {
    hostPubkey;
    #welcome;
    #link;
    #channel;
    #opts;
    #me;
    #roster = new Map();
    #messageListeners = new Set();
    #eventListeners = new Set();
    #buffered = [];
    #bufferedEvents = [];
    #lastSeq = 0;
    #state = 'joining';
    #endReason;
    #joinResult;
    /** 經 `PeerNode` 連到邀請裡的 Host、做雙棘輪握手、送出加入請求。 */
    static async join(opts) {
        const invite = typeof opts.invite === 'string' ? parseStarInvite(opts.invite) : opts.invite;
        const now = (opts.timers ?? realTimers).now();
        if (isStarInviteExpired(invite, now))
            throw new StarJoinError('expired', '邀請已過期');
        if (invite.host === opts.identity.pubkey.toLowerCase())
            throw new StarJoinError('wrong-host', '不能加入自己當 Host 的會話');
        const channel = await opts.node.connectPeer(invite.host);
        let secure;
        try {
            secure = await secureChannel(channel, opts.identity, { onListenerError: opts.onError, ...(opts.secure ?? {}) });
        }
        catch (error) {
            channel.close();
            throw error;
        }
        if (channel.closed)
            throw new StarJoinError('closed', '與 Host 的通道在握手後就關了');
        return StarMember.#over(secure, { ...opts, invite }, opts.identity.pubkey.toLowerCase());
    }
    /** 在一條已完成握手、對方是 Host 的成對通道上加入。 */
    static async over(channel, opts) {
        return StarMember.#over(channel, opts, undefined);
    }
    static async #over(channel, opts, me) {
        const parsed = typeof opts.invite === 'string' ? parseStarInvite(opts.invite) : opts.invite;
        // 自己的一份秘密：送出 JOIN 後清掉；不把邀請留在會話的選項裡（安全審查 M3）
        const invite = { ...parsed, secret: parsed.secret.slice() };
        const { invite: _dropped, ...rest } = opts;
        void _dropped;
        if (channel.engineType !== 'double-ratchet')
            throw new StarJoinError('protocol', '星狀會話只接受雙棘輪通道（secureChannel 的結果）');
        if (channel.peerPublicKey.toLowerCase() !== invite.host) {
            channel.close();
            throw new StarJoinError('wrong-host', '通道的對方不是邀請裡的 Host');
        }
        const member = new StarMember(channel, invite.host, rest, me);
        try {
            await member.#joined(invite, rest);
        }
        finally {
            invite.secret.fill(0);
        }
        return member;
    }
    constructor(channel, host, opts, me) {
        this.hostPubkey = host;
        this.#channel = channel;
        this.#opts = opts;
        this.#me = me;
        const budget = starRelayBudget(opts);
        this.#link = new Link(channel, 
        // 成員收的上限先用預設，WELCOME 之後照 Host 宣告的酬載上限檢查
        resolveTuning(channel.mode, 16 * 1024 * 1024, opts.tuning), {
            onRecords: (records) => this.#onRecords(records),
            onFail: (reason) => this.#onLinkFail(reason),
            onError: opts.onError,
        }, { timers: opts.timers ?? realTimers, minIntervalMs: () => (channel.mode === 'relayed-websocket' ? Math.ceil(60_000 / Math.max(1, budget)) : 0) });
    }
    #joined(invite, opts) {
        const timers = opts.timers ?? realTimers;
        return new Promise((resolve, reject) => {
            const timer = timers.setTimeout(() => {
                this.#failJoin(new StarJoinError('timeout', 'Host 沒有回覆加入請求'));
            }, opts.joinTimeoutMs ?? DEFAULT_STAR_JOIN_TIMEOUT_MS);
            this.#joinResult = {
                resolve: () => {
                    timers.clearTimeout(timer);
                    resolve();
                },
                reject: (error) => {
                    timers.clearTimeout(timer);
                    reject(error);
                },
            };
            this.#link.start();
            this.#link.enqueue(encodeJoin(invite.secret, opts.label));
            invite.secret.fill(0);
        });
    }
    #failJoin(error) {
        if (this.#state !== 'joining')
            return;
        this.#state = 'ended';
        this.#link.close();
        const result = this.#joinResult;
        this.#joinResult = undefined;
        result?.reject(error);
    }
    // ── 收 ──────────────────────────────────────────────
    #onRecords(records) {
        for (const record of records) {
            if (this.#state === 'ended')
                return;
            if (this.#state === 'joining') {
                this.#onJoinRecord(record);
                continue;
            }
            switch (record.type) {
                case RecordType.Deliver: {
                    const d = decodeDeliver(record.body);
                    if (!d || d.payload.length > this.#welcome.maxPayloadBytes)
                        return this.#protocolError();
                    if (d.seq <= this.#lastSeq)
                        continue; // 重複或倒退：Host 不該這樣，丟掉
                    this.#lastSeq = d.seq;
                    this.#deliver({ seq: d.seq, from: d.from, topic: d.topic, payload: d.payload.slice(), unicast: d.unicast, volatile: d.volatile });
                    break;
                }
                case RecordType.Roster: {
                    const r = decodeRoster(record.body);
                    if (!r)
                        return this.#protocolError();
                    if (r.seq <= this.#lastSeq)
                        continue;
                    this.#lastSeq = r.seq;
                    if (r.event === 'joined') {
                        this.#roster.set(r.pubkey, r.label ? { pubkey: r.pubkey, label: r.label } : { pubkey: r.pubkey });
                        this.#emit({ type: 'joined', pubkey: r.pubkey, ...(r.label ? { label: r.label } : {}), seq: r.seq });
                    }
                    else {
                        this.#roster.delete(r.pubkey);
                        this.#emit({ type: 'left', pubkey: r.pubkey, reason: r.reason, seq: r.seq });
                    }
                    break;
                }
                case RecordType.End: {
                    const reason = decodeEnd(record.body);
                    this.#end({ type: 'ended', reason: reason ?? 'protocol' });
                    return;
                }
                default:
                    return this.#protocolError();
            }
        }
    }
    #onJoinRecord(record) {
        if (record.type === RecordType.Welcome) {
            const welcome = decodeWelcome(record.body);
            if (!welcome || welcome.host !== this.hostPubkey || (this.#me !== undefined && welcome.you !== this.#me)) {
                this.#failJoin(new StarJoinError('protocol', 'Host 的回覆格式不對'));
                return;
            }
            this.#welcome = welcome;
            this.#lastSeq = welcome.next - 1;
            this.#link.retune(resolveTuning(this.#channel.mode, welcome.maxPayloadBytes, this.#opts.tuning)); // 依 Host 宣告的上限收緊
            for (const m of welcome.members)
                if (m.pubkey !== welcome.you)
                    this.#roster.set(m.pubkey, m);
            this.#state = 'joined';
            const result = this.#joinResult;
            this.#joinResult = undefined;
            result?.resolve();
            return;
        }
        if (record.type === RecordType.Reject) {
            this.#failJoin(new StarJoinError(decodeReject(record.body) ?? 'protocol'));
            return;
        }
        if (record.type === RecordType.End) {
            const reason = decodeEnd(record.body);
            this.#failJoin(new StarJoinError(reason === 'kicked' ? 'kicked' : reason === 'host-closed' ? 'host-closed' : 'protocol'));
            return;
        }
        this.#failJoin(new StarJoinError('protocol', 'Host 在加入完成前送了別的東西'));
    }
    #protocolError() {
        this.#end({ type: 'host-lost', reason: 'protocol' });
    }
    #onLinkFail(reason) {
        if (this.#state === 'joining') {
            this.#failJoin(new StarJoinError(reason === 'timeout' ? 'timeout' : reason === 'protocol' ? 'protocol' : 'closed'));
            return;
        }
        const lost = reason === 'timeout' || reason === 'desync' || reason === 'protocol' ? reason : 'closed';
        this.#end({ type: 'host-lost', reason: lost });
    }
    #end(event) {
        if (this.#state === 'ended')
            return;
        this.#state = 'ended';
        this.#endReason = event;
        this.#link.close();
        this.#emit(event);
    }
    #deliver(message) {
        if (this.#messageListeners.size === 0) {
            // 沒人聽又堆太多：明確結束，不默默丟（安全審查 L6）
            if (this.#buffered.length >= MAX_BUFFERED) {
                this.#end({ type: 'ended', reason: 'overflow' });
                return;
            }
            this.#buffered.push(message);
            return;
        }
        for (const listener of this.#messageListeners) {
            try {
                listener(message);
            }
            catch (error) {
                this.#opts.onError?.(error);
            }
        }
    }
    #emit(event) {
        if (this.#eventListeners.size === 0) {
            if (this.#bufferedEvents.length < 1_000)
                this.#bufferedEvents.push(event);
            return;
        }
        for (const listener of this.#eventListeners) {
            try {
                listener(event);
            }
            catch (error) {
                this.#opts.onError?.(error);
            }
        }
    }
    // ── 公開 API ────────────────────────────────────────
    /** 我的公鑰（Host 認得的身分） */
    get me() {
        return this.#welcome.you;
    }
    get sessionId() {
        return this.#welcome.session;
    }
    get maxPayloadBytes() {
        return this.#welcome.maxPayloadBytes;
    }
    get closed() {
        return this.#state !== 'joined';
    }
    /** 結束的原因（還在會話裡時是 undefined） */
    get endedBy() {
        return this.#endReason;
    }
    /** 最後處理到的 Host 序號 */
    get lastSeq() {
        return this.#lastSeq;
    }
    get stats() {
        return { ...this.#link.stats };
    }
    /** 目前的其他參與者（含 Host，不含自己） */
    members() {
        return [...this.#roster.values()].map((m) => ({ ...m }));
    }
    /**
     * 送出（經 Host 轉送）。佇列滿了丟 `StarMemberError('backpressure')`（`volatile` 的則默默丟掉）。
     * `echo`：也送回給自己，拿到這則的 Host 序號（例如聊天要照全體順序顯示）。
     */
    send(payload, opts = {}) {
        if (this.#state !== 'joined')
            throw new StarMemberError('closed', '已經不在會話裡');
        if (!(payload instanceof Uint8Array))
            throw new StarMemberError('bad-argument', '酬載要是 Uint8Array');
        if (payload.length > this.#welcome.maxPayloadBytes)
            throw new StarMemberError('too-large', `酬載超過 Host 的上限 ${this.#welcome.maxPayloadBytes} B；大檔請用 StreamTransfer`);
        const topic = opts.topic ?? 0;
        if (!Number.isInteger(topic) || topic < 0 || topic > 255)
            throw new StarMemberError('bad-argument', 'topic 要是 0–255');
        let to;
        if (opts.to) {
            to = [...new Set(opts.to.map((pk) => pk.toLowerCase()))];
            if (to.length > STAR_MAX_RECIPIENTS || to.some((pk) => !PK_HEX.test(pk)))
                throw new StarMemberError('bad-argument', '單播收件人不合法');
        }
        const ok = this.#link.enqueue(encodeSend({ payload: payload.slice(), topic, volatile: opts.volatile === true, echo: opts.echo === true, to }), opts.volatile === true);
        if (!ok)
            throw new StarMemberError('backpressure', '送出佇列滿了（連線太慢）；稍後再送，或降低送出頻率');
    }
    /** 佇列裡還沒送出的位元組（App 可以據此自己節流） */
    get bufferedAmount() {
        return this.#link.queuedBytes;
    }
    /** 收到的訊息（依 Host 序號遞增）；註冊前到的會在註冊當下交出 */
    onMessage(listener) {
        this.#messageListeners.add(listener);
        for (const message of this.#buffered.splice(0)) {
            try {
                listener(message);
            }
            catch (error) {
                this.#opts.onError?.(error);
            }
        }
        return () => this.#messageListeners.delete(listener);
    }
    /** 成員名單變動與結束事件；註冊前發生的會在註冊當下交出 */
    onEvent(listener) {
        this.#eventListeners.add(listener);
        for (const event of this.#bufferedEvents.splice(0)) {
            try {
                listener(event);
            }
            catch (error) {
                this.#opts.onError?.(error);
            }
        }
        return () => this.#eventListeners.delete(listener);
    }
    /** 與 Host 之間的成對通道（大檔可用 `StreamTransfer.for(channel)`；那是與 Host 的直送，不經轉送） */
    get channel() {
        return this.#channel;
    }
    /** 離開會話：告訴 Host、送完就關。 */
    async leave() {
        if (this.#state !== 'joined')
            return;
        this.#state = 'ended';
        this.#endReason = { type: 'ended', reason: 'left' };
        this.#link.enqueue({ type: RecordType.Leave, body: new Uint8Array(0) });
        await this.#link.closeAfterFlush(LEAVE_GRACE_MS);
        this.#emit(this.#endReason);
    }
}
//# sourceMappingURL=member.js.map