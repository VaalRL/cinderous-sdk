// 可持久化的「等 P2P 才送」佇列（SDK ADR 0026 §3；ADR 0015〈還沒做〉的佇列持久化）。
//
// 與 `P2PFileQueue` 語意相同（只在 P2P 打通時送；對方主動連上來也會送），差別：
// - 走批次串流（`StreamTransfer`）：同一個對象排著的檔案一條串流送完，大檔從斷點續傳、有背壓，記憶體恆定；
// - 佇列寫進注入的儲存（`TransferQueueStore`，與 Vault 協調器的 `SyncStateStore` 同一個形狀），
//   App 重開後 `restore()` 讀回來，再用 `open` 重新打開檔案，接著送（收方的暫存還在就從斷點續傳）。
//
// `P2PFileQueue` 保留不動：它說的是 `FileTransfer`（0xCF）的線路格式，舊的收方只懂那個。
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { hashSource, StreamInterruptedError, StreamRejectedError, StreamTransfer } from './stream.js';
export const DEFAULT_STREAM_QUEUE_PURPOSE = 'cinderous/file/1';
const PREFIX = 'sq:';
/** 對方回報失敗幾次才放棄 */
const MAX_FAILURES = 3;
/** 重試也沒用的失敗原因（對方拒收、太大、沒有儲存、檔案不見了） */
const PERMANENT = /拒收|太大|沒有大檔儲存|已經不在/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyOf = (peer, id) => `${PREFIX}${peer}:${id}`;
export class P2PStreamQueue {
    #opts;
    #purpose;
    #items = new Map();
    #sending = new Set();
    #listeners = new Set();
    #offPeer;
    #wrapped = new WeakMap();
    #closed = false;
    constructor(opts) {
        this.#opts = opts;
        this.#purpose = opts.purpose ?? DEFAULT_STREAM_QUEUE_PURPOSE;
        this.#offPeer = opts.node.onPeer((channel) => {
            if (this.#usable(channel))
                void this.#sendAll(channel).catch(() => { });
        });
    }
    /** App 重開後讀回持久化的佇列；回傳讀回幾筆。之後照常 `flush`（或等對方連上來）。 */
    async restore() {
        const store = this.#opts.store;
        if (!store)
            return 0;
        let n = 0;
        for (const key of await store.keys(PREFIX)) {
            const raw = await store.get(key);
            if (!raw)
                continue;
            let file;
            try {
                file = JSON.parse(decoder.decode(raw));
            }
            catch {
                continue;
            }
            if (typeof file.peer !== 'string' || typeof file.id !== 'string' || keyOf(file.peer, file.id) !== key)
                continue;
            if (!this.#items.has(key)) {
                this.#items.set(key, { file, failures: 0, waiters: [] });
                n += 1;
            }
        }
        return n;
    }
    /** 排一個檔案給對方；對方校驗、處理完成時 resolve（對方已經有了也算完成：`skipped`）；對方拒收或校驗失敗時 reject。 */
    async enqueue(peer, input) {
        if (this.#closed)
            throw new Error('佇列已關閉');
        const id = input.id ?? bytesToHex(randomBytes(16));
        if (!ID.test(id))
            throw new TypeError('id 只能用英數與 ._:-，最長 128');
        const sha256 = input.sha256 ?? (await hashSource(input));
        const file = { peer, id, size: input.size, sha256, meta: input.meta ?? {}, at: this.#opts.now?.() ?? Date.now() };
        const key = keyOf(peer, id);
        await this.#opts.store?.set(key, encoder.encode(JSON.stringify(file)));
        return new Promise((resolve, reject) => {
            const existing = this.#items.get(key);
            const item = existing && existing.file.sha256 === sha256 ? existing : { file, failures: 0, waiters: existing?.waiters ?? [] };
            item.file = file;
            item.read = input.read;
            item.waiters.push({ resolve, reject });
            this.#items.set(key, item);
        });
    }
    pending(peer) {
        let n = 0;
        for (const item of this.#items.values())
            if (peer === undefined || item.file.peer === peer)
                n += 1;
        return n;
    }
    list() {
        return [...this.#items.values()].map((i) => ({ ...i.file }));
    }
    /** 每一筆有結果時通知（包括 `restore` 讀回來、沒有人在等 Promise 的那些） */
    onSettled(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /** 移出佇列（不送了） */
    async remove(peer, id) {
        const key = keyOf(peer, id);
        const item = this.#items.get(key);
        this.#items.delete(key);
        await this.#opts.store?.delete(key);
        for (const w of item?.waiters ?? [])
            w.reject(new Error('已移出佇列'));
    }
    /** 試著連到對方；打通 P2P（或允許中繼時）就把排著的都送過去。 */
    async flush(peer) {
        if (this.#closed || this.pending(peer) === 0)
            return;
        const channel = await this.#opts.node.connectPeer(peer);
        if (this.#usable(channel))
            await this.#sendAll(channel);
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#offPeer();
        for (const item of this.#items.values())
            for (const w of item.waiters)
                w.reject(new Error('佇列已關閉'));
        this.#items.clear();
    }
    #usable(channel) {
        return this.#opts.allowRelay === true || channel.mode !== 'relayed-websocket';
    }
    #wrap(channel) {
        const wrap = this.#opts.wrap;
        if (!wrap)
            return Promise.resolve(channel);
        let wrapped = this.#wrapped.get(channel);
        if (!wrapped)
            this.#wrapped.set(channel, (wrapped = wrap(channel)));
        return wrapped;
    }
    async #sendAll(raw) {
        const peer = raw.peerPublicKey;
        if (this.#sending.has(peer) || this.#closed)
            return;
        this.#sending.add(peer);
        try {
            const batch = [...this.#items.entries()].filter(([, item]) => item.file.peer === peer);
            if (batch.length === 0)
                return;
            const channel = await this.#wrap(raw);
            const entries = [];
            for (const [key, item] of batch) {
                const read = item.read ?? (await this.#opts.open?.(item.file)) ?? null;
                if (!read) {
                    this.#settle(key, item, { status: 'failed', reason: '檔案已經不在（重開後打不開）' });
                    continue;
                }
                item.read = read;
                entries.push([key, item, { id: item.file.id, size: item.file.size, sha256: item.file.sha256, meta: item.file.meta, read }]);
            }
            if (entries.length === 0)
                return;
            const stream = StreamTransfer.for(channel, this.#opts.transferOptions);
            try {
                await stream.send(entries.map(([, , e]) => e), {
                    purpose: this.#purpose,
                    count: entries.length,
                    bytes: entries.reduce((n, [, , e]) => n + e.size, 0),
                    onEntryDone: (i, _id, result) => {
                        const [key, item] = entries[i] ?? [];
                        if (key && item)
                            this.#settle(key, item, result);
                    },
                });
            }
            catch (error) {
                // 斷線、逾時、對方不收這個用途：留在佇列，下次打通再送（大檔會從斷點續傳）
                if (!(error instanceof StreamInterruptedError) && !(error instanceof StreamRejectedError))
                    throw error;
            }
        }
        finally {
            this.#sending.delete(peer);
        }
    }
    #settle(key, item, result) {
        if (this.#items.get(key) !== item)
            return;
        // 失敗多半是暫時的（對方正在收同一份、寫入失敗、傳輸中被改）：留在佇列，下次再送；連續失敗才放棄
        if (result.status === 'failed' && !PERMANENT.test(result.reason)) {
            item.failures += 1;
            if (item.failures < MAX_FAILURES)
                return;
        }
        this.#items.delete(key);
        void this.#opts.store?.delete(key).catch(() => { });
        for (const listener of this.#listeners) {
            try {
                listener({ ...item.file }, result);
            }
            catch {
                // App 的監聽出錯不影響佇列
            }
        }
        for (const w of item.waiters) {
            if (result.status === 'failed')
                w.reject(new Error(`對方回報失敗：${result.reason}`));
            else
                w.resolve(result);
        }
    }
}
//# sourceMappingURL=stream-queue.js.map