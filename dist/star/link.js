import { RELAY_FRAME_PAYLOAD_BYTES } from '../peer/frames.js';
import { DEFAULT_RELAY_EVENTS_PER_MINUTE, relayEventsPerMinute } from '../relay-budget.js';
import { decodePacket, encodePacket, isStarPacket, RECORD_HEADER_BYTES } from './wire.js';
export const realTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    now: () => Date.now(),
};
/** 棘輪訊息（後量子）加上分框的固定開銷，估算中繼框數用 */
const RATCHET_OVERHEAD_ESTIMATE = 2_400;
export function defaultTuning(mode, maxPayloadBytes) {
    const relay = mode === 'relayed-websocket';
    const maxPacketBytes = Math.max(relay ? 44_000 : 256 * 1024, maxPayloadBytes) + 64 * 1024;
    return {
        batchWindowMs: relay ? 250 : 16,
        // 中繼軌：一包裝得進一框（48,000 B 扣掉後量子 header 與餘裕）＝一個中繼事件
        maxBatchBytes: relay ? 44_000 : 256 * 1024,
        maxQueueBytes: 8 * 1024 * 1024,
        maxQueueRecords: 4_096,
        heartbeatMs: relay ? 15_000 : 5_000,
        timeoutMs: relay ? 60_000 : 20_000,
        reliable: !relay,
        rtoMs: 4_000,
        maxRetransmits: 6,
        maxUnacked: 128,
        ackDelayMs: 1_000,
        reorderLimit: 256,
        reorderMaxBytes: 16 * 1024 * 1024,
        gapTimeoutMs: 30_000,
        maxPacketBytes,
    };
}
/** 中繼軌的預設事件預算（每分鐘）：低於 SDK 中繼的每把公鑰每分鐘 120 則（NIP-11 `cinder_max_events_per_minute`）。與 `PeerNode` 同一個預設（SDK ADR 0043） */
export const DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE = DEFAULT_RELAY_EVENTS_PER_MINUTE;
/**
 * 從中繼的 NIP-11 文件算出星狀會話該用的每分鐘事件預算：宣告值 × 0.8（留給信令、心跳以外的其他用途）。
 * 沒宣告就回 `fallback`。多座中繼時取最小的。與 `relayEventsPerMinute`（PeerNode、Vault、名單同步）是同一個函式（SDK ADR 0043）。
 */
export const starRelayEventsPerMinute = relayEventsPerMinute;
/** 星狀會話實際用的預算：`relayEventsPerMinute`（預設 100）與 `relayInfo` 宣告值 × 0.8 的較小者（SDK ADR 0043） */
export function starRelayBudget(opts) {
    const base = opts.relayEventsPerMinute ?? DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE;
    return opts.relayInfo === undefined ? base : Math.min(base, relayEventsPerMinute(opts.relayInfo, base));
}
export function resolveTuning(mode, maxPayloadBytes, override) {
    const extra = typeof override === 'function' ? override(mode) : override;
    return { ...defaultTuning(mode, maxPayloadBytes), ...(extra ?? {}) };
}
export class Link {
    #channel;
    #t;
    #h;
    #timers;
    #minIntervalMs;
    #queue = [];
    #queuedBytes = 0;
    #oldestQueuedAt = 0;
    #nextLseq = 1;
    #unacked = [];
    #recvContig = 0;
    /** 亂序暫存：存原始封包位元組，輪到時才解碼（不為暫存的東西建一堆物件，安全審查 H2） */
    #reorder = new Map();
    #reorderBytes = 0;
    #gapSince;
    #needAckSince;
    #gapAck = false;
    #resend = [];
    #lastSentAt;
    /** 上一包（節流用）；第一包不必等 */
    #pacedAt = Number.NEGATIVE_INFINITY;
    #lastFrames = 1;
    #lastRecvAt;
    #inFlight = false;
    #flushTimer;
    #tickTimer;
    #state = 'open';
    #closingDone;
    #off = [];
    stats = { queuedBytes: 0, queuedRecords: 0, unacked: 0, packetsSent: 0, bytesSent: 0, retransmits: 0, droppedVolatile: 0 };
    constructor(channel, tuning, handlers, opts = {}) {
        this.#channel = channel;
        this.#t = tuning;
        this.#h = handlers;
        this.#timers = opts.timers ?? realTimers;
        this.#minIntervalMs = opts.minIntervalMs ?? (() => 0);
        this.#lastSentAt = this.#timers.now();
        this.#lastRecvAt = this.#timers.now();
    }
    /** 開始收（通道在這之前收到的訊息會在這裡一次交出，所以擁有者要先把鏈路存好再呼叫） */
    start() {
        if (this.#off.length > 0 || this.#state === 'closed')
            return;
        this.#off.push(this.#channel.onClose(() => this.fail('closed')));
        this.#off.push(this.#channel.onMessage((data) => this.#onData(data)));
        if (this.#channel.closed === true) {
            this.fail('closed');
            return;
        }
        this.#scheduleTick();
    }
    /** 佇列裡每位寄件人佔了多少位元組 */
    queuedByOrigin() {
        const out = new Map();
        for (const q of this.#queue)
            if (q.origin !== undefined)
                out.set(q.origin, (out.get(q.origin) ?? 0) + q.bytes);
        return out;
    }
    /** 丟掉佇列裡某位寄件人還沒送出的紀錄 */
    purge(origin) {
        const kept = this.#queue.filter((q) => q.origin !== origin);
        if (kept.length === this.#queue.length)
            return;
        this.#queue = kept;
        this.#queuedBytes = kept.reduce((n, q) => n + q.bytes, 0);
        this.#syncStats();
    }
    /** 換一組參數（例如 Host 在對方加入前用較嚴的上限，加入後放寬） */
    retune(tuning) {
        this.#t = tuning;
    }
    /** 丟掉還沒送的，只送這一筆（例如「你被踢了」），送完或 `graceMs` 到了就關 */
    endWith(record, graceMs) {
        if (this.#state !== 'open')
            return Promise.resolve();
        this.#queue = [];
        this.#queuedBytes = 0;
        this.#queue.push({ record, bytes: RECORD_HEADER_BYTES + record.body.length, volatile: false, origin: undefined });
        this.#queuedBytes = RECORD_HEADER_BYTES + record.body.length;
        this.#oldestQueuedAt = this.#timers.now();
        this.#syncStats();
        return this.closeAfterFlush(graceMs);
    }
    get peerPublicKey() {
        return this.#channel.peerPublicKey;
    }
    get mode() {
        return this.#channel.mode;
    }
    get channel() {
        return this.#channel;
    }
    get open() {
        return this.#state === 'open';
    }
    get maxQueueBytes() {
        return this.#t.maxQueueBytes;
    }
    get queuedBytes() {
        return this.#queuedBytes;
    }
    /**
     * 排進佇列。放不下時先丟佇列裡最舊的可丟棄紀錄；還是放不下：本筆可丟棄就默默丟掉（回 true），
     * 否則回 false（溢出，由擁有者決定怎麼處理，通常是斷掉這條鏈路）。
     */
    enqueue(record, volatile = false, origin) {
        if (this.#state !== 'open')
            return true;
        const bytes = RECORD_HEADER_BYTES + record.body.length;
        const fits = () => this.#queuedBytes + bytes <= this.#t.maxQueueBytes && this.#queue.length + 1 <= this.#t.maxQueueRecords;
        if (!fits()) {
            for (let i = 0; i < this.#queue.length && !fits();) {
                const q = this.#queue[i];
                if (q.volatile) {
                    this.#queue.splice(i, 1);
                    this.#queuedBytes -= q.bytes;
                    this.stats.droppedVolatile += 1;
                }
                else
                    i += 1;
            }
            if (!fits()) {
                if (volatile) {
                    this.stats.droppedVolatile += 1;
                    return true;
                }
                return false;
            }
        }
        if (this.#queue.length === 0)
            this.#oldestQueuedAt = this.#timers.now();
        this.#queue.push({ record, bytes, volatile, origin });
        this.#queuedBytes += bytes;
        this.#syncStats();
        this.#kick();
        return true;
    }
    /** 不再收新資料；把佇列送完（或等到 `graceMs`）再關通道。 */
    closeAfterFlush(graceMs) {
        if (this.#state !== 'open')
            return Promise.resolve();
        this.#state = 'closing';
        return new Promise((resolve) => {
            const timer = this.#timers.setTimeout(() => this.#finishClosing(), graceMs);
            this.#closingDone = () => {
                this.#timers.clearTimeout(timer);
                resolve();
            };
            this.#kick();
        });
    }
    /** 立刻關閉並回報原因（只回報一次） */
    fail(reason) {
        if (this.#state === 'closed')
            return;
        const wasOpen = this.#state === 'open';
        this.#teardown();
        if (wasOpen)
            this.#h.onFail(reason);
    }
    /** 靜默關閉（擁有者自己要關，不回報） */
    close() {
        if (this.#state === 'closed')
            return;
        this.#teardown();
    }
    #teardown() {
        this.#state = 'closed';
        this.#timers.clearTimeout(this.#flushTimer);
        this.#timers.clearTimeout(this.#tickTimer);
        for (const off of this.#off.splice(0))
            off();
        this.#queue = [];
        this.#queuedBytes = 0;
        this.#unacked = [];
        this.#resend = [];
        this.#reorder.clear();
        this.#syncStats();
        try {
            this.#channel.close();
        }
        catch {
            // 已經關了
        }
        const done = this.#closingDone;
        this.#closingDone = undefined;
        done?.();
    }
    #finishClosing() {
        if (this.#state === 'closing')
            this.#teardown();
    }
    #syncStats() {
        this.stats.queuedBytes = this.#queuedBytes;
        this.stats.queuedRecords = this.#queue.length;
        this.stats.unacked = this.#unacked.length;
    }
    // ── 送 ──────────────────────────────────────────────
    #kick() {
        if (this.#state === 'closed' || this.#inFlight)
            return;
        const now = this.#timers.now();
        let due;
        const canSendData = this.#t.reliable || this.#state === 'closing' || this.#unacked.length < this.#t.maxUnacked;
        if (this.#resend.length > 0)
            due = now;
        if (this.#queue.length > 0 && canSendData) {
            const full = this.#queuedBytes >= this.#t.maxBatchBytes || this.#state === 'closing';
            const at = full ? now : this.#oldestQueuedAt + this.#t.batchWindowMs;
            due = due === undefined ? at : Math.min(due, at);
        }
        if (!this.#t.reliable && this.#needAckSince !== undefined) {
            const at = this.#gapAck ? now : this.#needAckSince + this.#t.ackDelayMs;
            due = due === undefined ? at : Math.min(due, at);
        }
        if (due === undefined) {
            // 關閉中：中繼軌要等最後幾包（例如「你被踢了」）被確認才關，掉了會重送；寬限時間到了照關（安全審查 L5）
            if (this.#state === 'closing' && this.#queue.length === 0 && (this.#t.reliable || this.#unacked.length === 0))
                this.#finishClosing();
            return;
        }
        const paced = Math.max(due, this.#pacedAt + this.#minIntervalMs() * this.#lastFrames);
        this.#timers.clearTimeout(this.#flushTimer);
        this.#flushTimer = this.#timers.setTimeout(() => void this.#flush(), Math.max(0, paced - now));
    }
    async #flush() {
        if (this.#state === 'closed' || this.#inFlight)
            return;
        this.#inFlight = true;
        try {
            if (this.#resend.length > 0) {
                const r = this.#resend.shift();
                r.sentAt = this.#timers.now();
                r.tries += 1;
                this.stats.retransmits += 1;
                await this.#write(r.bytes);
                return;
            }
            const canSendData = this.#t.reliable || this.#state === 'closing' || this.#unacked.length < this.#t.maxUnacked;
            const records = [];
            if (canSendData) {
                let size = 0;
                while (this.#queue.length > 0) {
                    const q = this.#queue[0];
                    if (records.length > 0 && size + q.bytes > this.#t.maxBatchBytes)
                        break;
                    this.#queue.shift();
                    this.#queuedBytes -= q.bytes;
                    size += q.bytes;
                    records.push(q.record);
                }
                if (this.#queue.length > 0)
                    this.#oldestQueuedAt = this.#timers.now();
            }
            if (records.length === 0 && (this.#t.reliable || this.#needAckSince === undefined))
                return;
            const sequenced = records.length > 0;
            if (sequenced && this.#nextLseq > 0xffff_ffff) {
                this.fail('desync'); // 鏈路序號用完（約 43 億包）：請重新加入
                return;
            }
            const lseq = sequenced ? this.#nextLseq++ : 0;
            const bytes = encodePacket(sequenced, lseq, this.#recvContig, records);
            this.#needAckSince = undefined;
            this.#gapAck = false;
            if (sequenced && !this.#t.reliable)
                this.#unacked.push({ lseq, bytes, sentAt: this.#timers.now(), tries: 0 });
            this.#syncStats();
            await this.#write(bytes);
        }
        finally {
            this.#inFlight = false;
            this.#kick();
        }
    }
    async #write(bytes) {
        this.#lastSentAt = this.#timers.now();
        this.#pacedAt = this.#lastSentAt;
        this.#lastFrames = this.mode === 'relayed-websocket' ? Math.max(1, Math.ceil((bytes.length + RATCHET_OVERHEAD_ESTIMATE) / RELAY_FRAME_PAYLOAD_BYTES)) : 1;
        this.stats.packetsSent += 1;
        this.stats.bytesSent += bytes.length;
        try {
            await this.#channel.send(bytes);
        }
        catch (error) {
            // 通道關了：鏈路失效。沒關（例如中繼暫時拒收）：中繼軌留著底稿，逾時會重送；P2P 軌不會發生
            if (this.#channel.closed === true || this.#t.reliable)
                this.fail('closed');
            else
                this.#h.onError?.(error);
        }
        this.#lastSentAt = this.#timers.now();
    }
    // ── 收 ──────────────────────────────────────────────
    #onData(data) {
        if (this.#state === 'closed' || !isStarPacket(data))
            return; // 同一條通道上的其他協定（例如 StreamTransfer）不歸我管
        if (data.length > this.#t.maxPacketBytes) {
            this.fail('protocol');
            return;
        }
        const packet = decodePacket(data);
        if (!packet || (!packet.sequenced && packet.records.length > 0)) {
            this.fail('protocol');
            return;
        }
        this.#lastRecvAt = this.#timers.now();
        if (!this.#onAck(packet.ack, !packet.sequenced) || !packet.sequenced)
            return;
        if (packet.lseq <= this.#recvContig || this.#reorder.has(packet.lseq)) {
            this.#wantAck(false); // 重複：對方大概沒收到確認
            return;
        }
        if (packet.lseq !== this.#recvContig + 1) {
            // P2P 軌本身可靠有序：跳號只可能是對方亂來
            if (this.#t.reliable) {
                this.fail('protocol');
                return;
            }
            const size = data.length;
            if (packet.lseq - this.#recvContig > this.#t.reorderLimit || this.#reorderBytes + size > this.#t.reorderMaxBytes) {
                this.fail('desync');
                return;
            }
            this.#reorder.set(packet.lseq, data.slice());
            this.#reorderBytes += size;
            this.#gapSince ??= this.#timers.now();
            this.#wantAck(true);
            return;
        }
        this.#deliver(packet.records);
        for (;;) {
            const next = this.#reorder.get(this.#recvContig + 1);
            if (!next)
                break;
            this.#reorder.delete(this.#recvContig + 1);
            this.#reorderBytes -= next.length;
            this.#deliver(decodePacket(next).records);
        }
        if (this.#reorder.size === 0) {
            this.#gapSince = undefined;
            this.#reorderBytes = 0;
        }
        this.#wantAck(false);
    }
    #deliver(records) {
        this.#recvContig += 1;
        if (this.#state !== 'open' || records.length === 0)
            return;
        try {
            this.#h.onRecords(records);
        }
        catch (error) {
            this.#h.onError?.(error);
        }
    }
    #wantAck(gap) {
        if (this.#t.reliable)
            return;
        this.#needAckSince ??= this.#timers.now();
        if (gap)
            this.#gapAck = true;
        this.#kick();
    }
    #onAck(ack, standalone) {
        // 確認了我還沒送的號碼：對方亂來（安全審查 L3）
        if (ack >= this.#nextLseq) {
            this.fail('protocol');
            return false;
        }
        if (this.#t.reliable)
            return true;
        let dropped = false;
        while (this.#unacked.length > 0 && this.#unacked[0].lseq <= ack) {
            this.#unacked.shift();
            dropped = true;
        }
        if (dropped) {
            this.#resend = this.#resend.filter((r) => r.lseq > ack);
            this.#syncStats();
            this.#kick();
        }
        // 單獨的確認封包而且確認號落後：對方看到缺號了，先補第一個缺的（快速重送）
        const first = this.#unacked[0];
        if (standalone && first && first.lseq === ack + 1 && !this.#resend.includes(first) && this.#timers.now() - first.sentAt >= this.#t.ackDelayMs) {
            this.#resend.push(first);
            this.#kick();
        }
        return true;
    }
    // ── 計時 ─────────────────────────────────────────────
    #scheduleTick() {
        const every = Math.max(5, Math.min(this.#t.heartbeatMs, this.#t.rtoMs, this.#t.gapTimeoutMs) / 4);
        this.#tickTimer = this.#timers.setTimeout(() => {
            if (this.#state === 'closed')
                return;
            this.#tick();
            if (!this.#isClosed())
                this.#scheduleTick();
        }, every);
    }
    #isClosed() {
        return this.#state === 'closed';
    }
    #tick() {
        const now = this.#timers.now();
        const minInterval = this.#minIntervalMs();
        // 中繼軌的心跳也要守事件預算：間隔至少是節流間隔；逾時至少是三個心跳（安全審查 M2）
        const heartbeat = Math.max(this.#t.heartbeatMs, minInterval);
        if (now - this.#lastRecvAt > Math.max(this.#t.timeoutMs, 3 * heartbeat)) {
            this.fail('timeout');
            return;
        }
        if (this.#gapSince !== undefined && now - this.#gapSince > this.#t.gapTimeoutMs) {
            this.fail('desync');
            return;
        }
        if (!this.#t.reliable && this.#unacked.length > 0) {
            const first = this.#unacked[0];
            if (now - first.sentAt > this.#t.rtoMs) {
                if (first.tries >= this.#t.maxRetransmits) {
                    this.fail('desync');
                    return;
                }
                for (const u of this.#unacked)
                    if (now - u.sentAt > this.#t.rtoMs && !this.#resend.includes(u))
                        this.#resend.push(u);
                this.#kick();
            }
        }
        if (this.#state === 'open' && now - this.#lastSentAt >= heartbeat && now - this.#pacedAt >= minInterval * this.#lastFrames && this.#queue.length === 0 && !this.#inFlight) {
            // 心跳：空封包（帶確認）。可靠軌也送，對方靠它判斷我們還在
            this.#inFlight = true;
            const bytes = encodePacket(false, 0, this.#recvContig, []);
            this.#needAckSince = undefined;
            this.#gapAck = false;
            void this.#write(bytes).finally(() => {
                this.#inFlight = false;
                this.#kick();
            });
        }
    }
}
//# sourceMappingURL=link.js.map