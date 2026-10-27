// `StarHost`：星狀會話的 Host（SDK ADR 0030）。
//
// ⚠ 這**不是**端到端的群組加密。每位成員與 Host 之間各有一條成對的雙棘輪通道；
// 成員送來的訊息由 Host **解密**、蓋上 Host 序號與寄件人，再用其他成員各自的通道**重新加密**轉送。
// Host 看得到（也改得了）經過它的每一則內容——只能讓你信任的人當 Host。
//
// Host 負責：邀請與加入、離開與踢出、成員名單事件、全體一致的順序（Host 序號）、單播、每位成員的背壓。
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { secureChannel } from '../crypto/secure-channel.js';
import { InviteBook } from './invite.js';
import { Link, realTimers, resolveTuning, starRelayBudget } from './link.js';
import { decodeJoin, decodeSend, encodeDeliver, encodeJson, encodeRoster, RecordType, sanitizeStarLabel, STAR_MAX_RECIPIENTS, } from './wire.js';
export const DEFAULT_STAR_MAX_MEMBERS = 16;
/** 成員上限的天花板：Host 對每位成員各加密一次，人越多 Host 的 CPU 與上行越吃緊 */
export const STAR_MAX_MEMBERS_LIMIT = 64;
export const DEFAULT_STAR_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const STAR_MAX_PAYLOAD_LIMIT = 16 * 1024 * 1024;
export const DEFAULT_STAR_JOIN_TIMEOUT_MS = 10_000;
export const DEFAULT_STAR_APPROVE_TIMEOUT_MS = 120_000;
/** 結束時等最後一包送出的時間 */
const END_GRACE_MS = 2_000;
/** 加入前每個封包的上限：JOIN 只有秘密＋名稱，幾十個位元組 */
const PRE_JOIN_MAX_PACKET_BYTES = 1_024;
export const DEFAULT_STAR_INBOUND_RATE = {
    messagesPerSecond: 200,
    burstMessages: 2_000,
    bytesPerSecond: 1024 * 1024,
    // 突發不超過每成員佇列上限（8 MiB）的 1/4：一個人一口氣灌不滿別人的佇列（安全審查 H1）
    burstBytes: 2 * 1024 * 1024,
};
export class StarHostError extends Error {
    name = 'StarHostError';
}
export class StarHost {
    /** 這個 Host 會話的 id（隨機；成員從 WELCOME 拿到） */
    sessionId;
    hostPubkey;
    #identity;
    #opts;
    #timers;
    #maxMembers;
    #maxPayload;
    #rate;
    #invites;
    #members = new Map();
    #pending = new Set();
    #banned = new Set();
    #messageListeners = new Set();
    #eventListeners = new Set();
    #handshaking = 0;
    #seq = 0;
    #closed = false;
    constructor(opts) {
        const host = opts.identity.pubkey.toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(host))
            throw new StarHostError('Host 公鑰格式不對');
        const maxMembers = opts.maxMembers ?? DEFAULT_STAR_MAX_MEMBERS;
        if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > STAR_MAX_MEMBERS_LIMIT)
            throw new StarHostError(`成員上限要在 1 到 ${STAR_MAX_MEMBERS_LIMIT} 之間`);
        const maxPayload = opts.maxPayloadBytes ?? DEFAULT_STAR_MAX_PAYLOAD_BYTES;
        if (!Number.isInteger(maxPayload) || maxPayload < 1 || maxPayload > STAR_MAX_PAYLOAD_LIMIT)
            throw new StarHostError('酬載上限不合法');
        this.hostPubkey = host;
        this.sessionId = bytesToHex(randomBytes(16));
        this.#identity = opts.identity;
        this.#opts = opts;
        this.#timers = opts.timers ?? realTimers;
        this.#maxMembers = maxMembers;
        this.#maxPayload = maxPayload;
        this.#rate = { ...DEFAULT_STAR_INBOUND_RATE, ...(opts.inboundRate ?? {}) };
        this.#invites = new InviteBook(host, () => this.#timers.now());
    }
    get closed() {
        return this.#closed;
    }
    get maxPayloadBytes() {
        return this.#maxPayload;
    }
    // ── 邀請 ─────────────────────────────────────────────
    /** 產生邀請字串（`cinderous-star:1.…`），交給對方（QR、私訊、複製連結）。預設 10 分鐘、一次性。 */
    createInvite(opts) {
        if (this.#closed)
            throw new StarHostError('會話已結束');
        return this.#invites.create(opts, this.#maxMembers);
    }
    /** 撤銷還沒用掉的邀請；已經加入的人不受影響（要請他離開用 `kick`） */
    revokeInvite(id) {
        return this.#invites.revoke(id);
    }
    invites() {
        return this.#invites.list();
    }
    // ── 連線 ─────────────────────────────────────────────
    /**
     * 接上 `PeerNode`：有人連進來就做雙棘輪握手，再等它送加入請求。
     * `accept` 回 false 的連線不碰（留給 App 的其他用途）；同一條 PeerChannel 只能有一方做 `secureChannel`。
     */
    listen(node, opts = {}) {
        const identity = this.#identity;
        if (typeof identity.conversationKey !== 'function')
            throw new StarHostError('listen 需要完整的 Identity（要做雙棘輪握手）');
        return node.onPeer((channel) => {
            const peer = channel.peerPublicKey.toLowerCase();
            if (opts.accept && !opts.accept(peer))
                return;
            if (this.#closed || this.#banned.has(peer) || (this.#pending.size + this.#handshaking >= this.#maxPending && !this.#evictIdlePending())) {
                channel.close();
                return;
            }
            this.#handshaking += 1;
            secureChannel(channel, identity, { onListenerError: this.#opts.onError, ...(opts.secure ?? {}) })
                .then((secure) => {
                // 握手完成到交給 Host 之間通道就關了：SecureChannel 不會補發關閉通知，這裡先看一眼（安全審查 L2）
                if (channel.closed)
                    secure.close();
                else
                    this.attach(secure);
            }, (error) => {
                channel.close();
                this.#opts.onError?.(error);
            })
                .finally(() => {
                this.#handshaking -= 1;
            });
        });
    }
    /**
     * 交給 Host 一條已完成握手的成對通道（`secureChannel` 的結果）。對方要在時限內送出加入請求（帶邀請秘密），
     * 否則關掉。對方的身分就是通道認證過的公鑰。
     */
    attach(channel) {
        if (channel.engineType !== 'double-ratchet')
            throw new StarHostError('星狀會話只接受雙棘輪通道（secureChannel 的結果）');
        const peer = channel.peerPublicKey.toLowerCase();
        if (this.#closed || peer === this.hostPubkey || this.#banned.has(peer) || (this.#pending.size >= this.#maxPending && !this.#evictIdlePending())) {
            channel.close();
            return;
        }
        const pending = { pubkey: peer, link: undefined, timer: undefined, joining: false, tuning: resolveTuning(channel.mode, this.#maxPayload, this.#opts.tuning) };
        pending.link = new Link(channel, 
        // 加入前還不知道是誰：只收得下一個小小的 JOIN，亂序暫存也只給一點點（未加入的連線撐不爆 Host 的記憶體）
        { ...pending.tuning, maxPacketBytes: PRE_JOIN_MAX_PACKET_BYTES, reorderLimit: 4, reorderMaxBytes: 4 * PRE_JOIN_MAX_PACKET_BYTES }, {
            onRecords: (records) => {
                if (pending.member)
                    this.#onMemberRecords(pending.member, records);
                else
                    this.#onPendingRecords(pending, records);
            },
            onFail: (reason) => {
                this.#dropPending(pending);
                if (pending.member)
                    this.#remove(pending.member, reason);
            },
            onError: this.#opts.onError,
        }, { timers: this.#timers, minIntervalMs: () => this.#minIntervalMs(pending.link) });
        pending.timer = this.#timers.setTimeout(() => {
            if (this.#pending.has(pending) && !pending.joining) {
                this.#dropPending(pending);
                pending.link.close();
            }
        }, this.#opts.joinTimeoutMs ?? DEFAULT_STAR_JOIN_TIMEOUT_MS);
        this.#pending.add(pending);
        pending.link.start();
    }
    get #maxPending() {
        return this.#opts.maxPendingJoins ?? 32;
    }
    /** 等待名額滿了：踢掉最舊一條還沒送 JOIN 的，讓新來的有機會（換金鑰佔名額的人擋不住真的要加入的人，安全審查 M1） */
    #evictIdlePending() {
        for (const p of this.#pending) {
            if (!p.joining) {
                this.#dropPending(p);
                p.link.close();
                return true;
            }
        }
        return false;
    }
    #dropPending(pending) {
        this.#timers.clearTimeout(pending.timer);
        this.#pending.delete(pending);
    }
    #onPendingRecords(pending, records) {
        if (pending.joining)
            return;
        const first = records[0];
        const join = first && first.type === RecordType.Join ? decodeJoin(first.body) : null;
        if (!join) {
            this.#dropPending(pending);
            pending.link.fail('protocol');
            return;
        }
        pending.joining = true;
        void this.#handleJoin(pending, join.secret, join.label).catch((error) => {
            this.#opts.onError?.(error);
            this.#reject(pending, 'denied');
        });
    }
    async #handleJoin(pending, secret, label) {
        const peer = pending.pubkey;
        // 先驗邀請（不扣次數）：沒有有效邀請的人只會拿到邀請相關的原因，看不到人數滿了沒、自己有沒有被封鎖（安全審查 L1）
        const checked = this.#invites.check(secret, peer);
        if (!checked.ok) {
            secret.fill(0);
            return this.#reject(pending, checked.reason);
        }
        if (this.#closed)
            return this.#reject(pending, 'closed');
        if (this.#banned.has(peer))
            return this.#reject(pending, 'banned');
        if (!this.#members.has(peer) && this.#members.size >= this.#maxMembers)
            return this.#reject(pending, 'full');
        const redeemed = this.#invites.redeem(secret, peer);
        secret.fill(0);
        if (!redeemed.ok)
            return this.#reject(pending, redeemed.reason);
        if (this.#opts.approveJoin) {
            this.#timers.clearTimeout(pending.timer); // 等使用者按按鈕可能比加入時限久；另有核准時限
            let approveTimer;
            const timedOut = new Promise((resolve) => {
                approveTimer = this.#timers.setTimeout(() => resolve(false), this.#opts.approveTimeoutMs ?? DEFAULT_STAR_APPROVE_TIMEOUT_MS);
            });
            const request = { pubkey: peer, ...(label ? { label } : {}), inviteId: redeemed.inviteId, mode: pending.link.mode };
            const ok = await Promise.race([Promise.resolve(this.#opts.approveJoin(request)), timedOut]);
            this.#timers.clearTimeout(approveTimer);
            if (!ok)
                return this.#reject(pending, 'denied');
            if (!pending.link.open)
                return;
            if (this.#closed)
                return this.#reject(pending, 'closed');
            if (this.#banned.has(peer))
                return this.#reject(pending, 'banned');
            if (!this.#members.has(peer) && this.#members.size >= this.#maxMembers)
                return this.#reject(pending, 'full');
        }
        this.#admit(pending, label, redeemed.inviteId);
    }
    #reject(pending, reason) {
        this.#dropPending(pending);
        if (!pending.link.open)
            return;
        void pending.link.endWith(encodeJson(RecordType.Reject, { reason }), END_GRACE_MS);
        this.#emit({ type: 'rejected', pubkey: pending.pubkey, reason });
    }
    #admit(pending, label, inviteId) {
        this.#dropPending(pending);
        const peer = pending.pubkey;
        const existing = this.#members.get(peer);
        if (existing)
            this.#remove(existing, 'replaced');
        const member = {
            pubkey: peer,
            label: sanitizeStarLabel(label),
            link: pending.link,
            channel: pending.link.channel,
            joinedAt: this.#timers.now(),
            bucket: { messages: this.#rate.burstMessages, bytes: this.#rate.burstBytes, at: this.#timers.now() },
            inviteId,
        };
        const roster = [{ pubkey: this.hostPubkey }];
        for (const m of this.#members.values())
            roster.push(m.label ? { pubkey: m.pubkey, label: m.label } : { pubkey: m.pubkey });
        this.#members.set(peer, member);
        pending.member = member;
        member.link.retune(pending.tuning);
        const seq = ++this.#seq;
        const welcome = { session: this.sessionId, host: this.hostPubkey, you: peer, next: seq + 1, members: roster, maxPayloadBytes: this.#maxPayload };
        member.link.enqueue(encodeJson(RecordType.Welcome, welcome));
        this.#fanout(encodeRoster({ seq, event: 'joined', pubkey: peer, reason: undefined, label: member.label }), (m) => m !== member, false);
        this.#emit({ type: 'joined', pubkey: peer, ...(member.label ? { label: member.label } : {}), seq, inviteId });
    }
    // ── 成員送來的 ───────────────────────────────────────
    #onMemberRecords(member, records) {
        for (const record of records) {
            if (this.#members.get(member.pubkey) !== member)
                return; // 已經離開或被踢：之後的一律不處理
            if (record.type === RecordType.Leave) {
                this.#remove(member, 'left');
                return;
            }
            const send = record.type === RecordType.Send ? decodeSend(record.body) : null;
            if (!send || send.payload.length > this.#maxPayload) {
                this.#remove(member, 'protocol');
                return;
            }
            if (!this.#takeRate(member, send.payload.length)) {
                this.#remove(member, 'rate-limit');
                return;
            }
            this.#route(member.pubkey, send);
        }
    }
    #takeRate(member, bytes) {
        const b = member.bucket;
        const now = this.#timers.now();
        const dt = Math.max(0, now - b.at) / 1000;
        b.at = now;
        b.messages = Math.min(this.#rate.burstMessages, b.messages + dt * this.#rate.messagesPerSecond);
        b.bytes = Math.min(this.#rate.burstBytes, b.bytes + dt * this.#rate.bytesPerSecond);
        if (b.messages < 1 || b.bytes < bytes)
            return false;
        b.messages -= 1;
        b.bytes -= bytes;
        return true;
    }
    /** 蓋上 Host 序號、依寄件人與收件人轉送。回傳序號；沒有任何收件人時回 undefined（不耗序號）。 */
    #route(from, send) {
        let targets;
        let toHost;
        if (send.to) {
            const wanted = new Set(send.to.map((pk) => pk.toLowerCase()));
            if (send.echo)
                wanted.add(from);
            toHost = wanted.has(this.hostPubkey) && from !== this.hostPubkey;
            if (from === this.hostPubkey)
                wanted.delete(this.hostPubkey);
            targets = (m) => wanted.has(m.pubkey);
            if (!toHost && ![...this.#members.values()].some(targets))
                return undefined;
        }
        else {
            toHost = from !== this.hostPubkey;
            targets = (m) => m.pubkey !== from || send.echo;
            if (!toHost && ![...this.#members.values()].some(targets))
                return undefined;
        }
        const seq = ++this.#seq;
        const record = encodeDeliver({ seq, from, unicast: send.to !== undefined, volatile: send.volatile, topic: send.topic, payload: send.payload });
        this.#fanout(record, targets, send.volatile, from === this.hostPubkey ? undefined : from);
        if (toHost) {
            const message = { seq, from, topic: send.topic, payload: send.payload.slice(), unicast: send.to !== undefined, volatile: send.volatile };
            for (const listener of this.#messageListeners) {
                try {
                    listener(message);
                }
                catch (error) {
                    this.#opts.onError?.(error);
                }
            }
        }
        return seq;
    }
    #fanout(record, targets, volatile, origin) {
        const overflowed = [];
        const culprits = new Set();
        for (const m of this.#members.values()) {
            if (!targets(m) || m.link.enqueue(record, volatile, origin))
                continue;
            overflowed.push(m);
            // 誰塞滿了這個佇列？某位成員一個人佔了超過一半，就是它灌的：請「它」離開，不是請慢的收件人離開（安全審查 H1）
            let worst;
            let worstBytes = 0;
            for (const [pk, bytes] of m.link.queuedByOrigin()) {
                if (bytes > worstBytes) {
                    worst = pk;
                    worstBytes = bytes;
                }
            }
            if (worst !== undefined && worst !== m.pubkey && worstBytes * 2 > m.link.maxQueueBytes && this.#members.has(worst))
                culprits.add(worst);
        }
        for (const pk of culprits) {
            const culprit = this.#members.get(pk);
            if (!culprit)
                continue;
            for (const m of this.#members.values())
                m.link.purge(pk); // 它還沒送出的都不送了（收到一部分的人要跟 Host 重新同步）
            this.#remove(culprit, 'rate-limit');
        }
        for (const m of overflowed) {
            if (this.#members.get(m.pubkey) !== m)
                continue;
            if (origin !== undefined && culprits.has(origin))
                continue; // 灌的人自己的這一則：丟掉
            if (culprits.size > 0 && m.link.enqueue(record, volatile, origin))
                continue;
            // 真的是它自己太慢：請它離開（它可以重新加入再同步），不能讓它拖垮其他人
            this.#remove(m, 'overflow');
        }
    }
    #remove(member, reason) {
        if (this.#members.get(member.pubkey) !== member)
            return;
        this.#members.delete(member.pubkey);
        if (member.link.open) {
            if (reason === 'left')
                void member.link.closeAfterFlush(END_GRACE_MS);
            else
                void member.link.endWith(encodeJson(RecordType.End, { reason }), END_GRACE_MS);
        }
        if (this.#closed)
            return;
        const seq = ++this.#seq;
        this.#fanout(encodeRoster({ seq, event: 'left', pubkey: member.pubkey, reason, label: undefined }), () => true, false);
        this.#emit({ type: 'left', pubkey: member.pubkey, reason, seq });
    }
    #minIntervalMs(link) {
        if (link.mode !== 'relayed-websocket')
            return 0;
        let relayed = 0;
        // 只算已加入的成員：還沒加入的連線不能稀釋正式成員的事件預算（安全審查 M1）
        for (const m of this.#members.values())
            if (m.link.mode === 'relayed-websocket' && m.link.open)
                relayed += 1;
        const budget = starRelayBudget(this.#opts);
        return Math.ceil((60_000 * Math.max(1, relayed)) / Math.max(1, budget));
    }
    // ── Host 自己也是參與者 ─────────────────────────────
    /** Host 自己送（廣播或單播）。回傳 Host 序號；沒有任何收件人回 undefined。 */
    send(payload, opts = {}) {
        if (this.#closed)
            throw new StarHostError('會話已結束');
        if (!(payload instanceof Uint8Array))
            throw new StarHostError('酬載要是 Uint8Array');
        if (payload.length > this.#maxPayload)
            throw new StarHostError(`酬載超過上限 ${this.#maxPayload} B；大檔請用 StreamTransfer`);
        const topic = opts.topic ?? 0;
        if (!Number.isInteger(topic) || topic < 0 || topic > 255)
            throw new StarHostError('topic 要是 0–255');
        if (opts.to && opts.to.length > STAR_MAX_RECIPIENTS)
            throw new StarHostError(`單播最多 ${STAR_MAX_RECIPIENTS} 位`);
        return this.#route(this.hostPubkey, { payload: payload.slice(), topic, volatile: opts.volatile === true, echo: false, to: opts.to?.map((pk) => pk.toLowerCase()) });
    }
    /** 收到給 Host 的訊息（廣播，或單播給 Host 的），依 Host 序號的順序 */
    onMessage(listener) {
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }
    onEvent(listener) {
        this.#eventListeners.add(listener);
        return () => this.#eventListeners.delete(listener);
    }
    #emit(event) {
        for (const listener of this.#eventListeners) {
            try {
                listener(event);
            }
            catch (error) {
                this.#opts.onError?.(error);
            }
        }
    }
    // ── 成員管理 ─────────────────────────────────────────
    members() {
        return [...this.#members.values()].map((m) => ({
            pubkey: m.pubkey,
            ...(m.label ? { label: m.label } : {}),
            mode: m.link.mode,
            joinedAt: m.joinedAt,
            stats: { ...m.link.stats },
        }));
    }
    has(pubkey) {
        return this.#members.has(pubkey.toLowerCase());
    }
    /**
     * 請一位成員離開：關掉它的通道，之後它送的一律不轉、也收不到任何東西。
     * 成對通道之下，其他人的通道不受影響、不必重新協商。`ban`（預設 true）：這個會話內不能再用別的邀請回來。
     */
    kick(pubkey, opts = {}) {
        const pk = pubkey.toLowerCase();
        if (opts.ban !== false)
            this.#banned.add(pk);
        for (const p of [...this.#pending]) {
            if (p.pubkey === pk) {
                this.#dropPending(p);
                p.link.close();
            }
        }
        const member = this.#members.get(pk);
        if (!member)
            return false;
        // 封鎖只擋這把公鑰；它用的邀請（可能還能用好幾次）一併撤銷，換一把新金鑰也回不來（安全審查 M4）
        if (opts.revokeInvite ?? opts.ban !== false)
            this.#invites.revoke(member.inviteId);
        this.#remove(member, 'kicked');
        return true;
    }
    unban(pubkey) {
        return this.#banned.delete(pubkey.toLowerCase());
    }
    /**
     * 這位成員的底層成對通道（雙棘輪）。大檔（蟲洞投影的附件）用 `StreamTransfer.for(channel)` 走同一條通道：
     * 串流的封包標記（0xCB）與星狀會話（0xC5）不同，互不干擾。注意這條路**不經 Host 轉送**，是 Host 與這位成員之間的直送。
     */
    channelOf(pubkey) {
        return this.#members.get(pubkey.toLowerCase())?.channel;
    }
    /** 結束會話：每位成員收到 `host-closed`，所有邀請作廢。 */
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#invites.revokeAll();
        for (const p of [...this.#pending]) {
            this.#dropPending(p);
            if (p.link.open)
                void p.link.endWith(encodeJson(RecordType.Reject, { reason: 'closed' }), END_GRACE_MS);
        }
        for (const m of [...this.#members.values()])
            this.#remove(m, 'host-closed');
    }
}
//# sourceMappingURL=host.js.map