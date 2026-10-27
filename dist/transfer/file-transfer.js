// 檔案傳輸與續傳（SDK ADR 0015）：跑在任何「位元組通道」上——`PeerChannel`（P2P 或中繼）與
// `secureChannel`（雙棘輪）都行。語意對齊 Cinderous ADR-0355：開始 → 收方回報已有多少 → 從那裡接著送 → 整檔校驗。
//
// 線路格式：第一個位元組 0xCF 是檔案傳輸的標記，第二個位元組是類型。
//   1 offer  JSON { id, name, mime, size, chunkSize }
//   2 accept JSON { id, have }        收方已有 `have` 位元組（續傳），送方從那裡接著送
//   3 reject JSON { id, reason }
//   4 chunk  [0xCF][4][id 16 位元組][offset 8 位元組大端序][資料]
//   5 end    JSON { id, sha256 }      整檔 SHA-256（hex）
//   6 done   JSON { id, ok, reason? } 收方校驗結果；送方收到才算完成
// ⚠ 同一條通道上 App 自己的訊息不要以 0xCF 開頭（或用 `isFileTransferMessage` 略過）。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { LARGE_PAYLOAD_WARNING_BYTES } from '../peer/peer-node.js';
const MAGIC = 0xcf;
const T_OFFER = 1;
const T_ACCEPT = 2;
const T_REJECT = 3;
const T_CHUNK = 4;
const T_END = 5;
const T_DONE = 6;
const ID_BYTES = 16;
const CHUNK_HEADER = 2 + ID_BYTES + 8;
export const DEFAULT_FILE_CHUNK_BYTES = 64 * 1024;
/** 收方預設的單檔上限：100 MB（檔案最後會整個讀進記憶體交給 App，同 Cinderous 的 maxMemoryFileSize）。 */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_FILES = 16;
/** 亂序先到、還接不上的分塊最多暫存多少位元組（沒有收端流量控制，不設上限就是 OOM）。 */
export const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const REPLY_TIMEOUT_MS = 30_000;
const DONE_TIMEOUT_MS = 60_000;
export function bytesSource(name, mime, bytes) {
    return { name, mime, size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}
/** 瀏覽器的 Blob／File：分段讀，不必整個載進記憶體 */
export function blobSource(name, mime, blob) {
    return { name, mime, size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}
export class MemoryPartialStore {
    #parts = new Map();
    async size(id) {
        return (this.#parts.get(id) ?? []).reduce((n, p) => n + p.length, 0);
    }
    async append(id, bytes) {
        const parts = this.#parts.get(id) ?? [];
        parts.push(bytes.slice());
        this.#parts.set(id, parts);
    }
    async read(id) {
        return concatBytes(...(this.#parts.get(id) ?? []));
    }
    async delete(id) {
        this.#parts.delete(id);
    }
}
export class FileRejectedError extends Error {
    name = 'FileRejectedError';
}
export class FileIntegrityError extends Error {
    name = 'FileIntegrityError';
}
/** 走中繼的大檔（PRD 2.3）：預設不送，App 提示使用者連同一個 Wi-Fi，或明確允許 */
export class LargeFileOverRelayError extends Error {
    name = 'LargeFileOverRelayError';
}
export function isFileTransferMessage(data) {
    return data[0] === MAGIC;
}
const encodeJson = (type, body) => concatBytes(new Uint8Array([MAGIC, type]), new TextEncoder().encode(JSON.stringify(body)));
const ID_RE = /^[0-9a-f]{32}$/;
const perChannel = new WeakMap();
export class FileTransfer {
    /**
     * 同一條通道只用一個實例：兩個實例掛在同一條通道上，對方的邀請會被回應兩次。
     * 第一次呼叫時的選項生效，之後的呼叫拿到同一個實例。
     */
    static for(channel, opts) {
        let transfer = perChannel.get(channel);
        if (!transfer || transfer.#closed) {
            transfer = new FileTransfer(channel, opts);
            perChannel.set(channel, transfer);
        }
        return transfer;
    }
    #channel;
    #chunkSize;
    #store;
    #maxFileBytes;
    #maxConcurrent;
    #maxPending;
    #onOffer;
    #onProgress;
    #incoming = new Map();
    #waiters = new Map();
    #fileListeners = new Set();
    #offMessage;
    #offClose;
    #closed = false;
    constructor(channel, opts = {}) {
        this.#channel = channel;
        this.#chunkSize = opts.chunkSize ?? DEFAULT_FILE_CHUNK_BYTES;
        if (!Number.isInteger(this.#chunkSize) || this.#chunkSize < 1)
            throw new RangeError('chunkSize 必須是正整數');
        this.#store = opts.store ?? new MemoryPartialStore();
        this.#maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        this.#maxConcurrent = opts.maxConcurrentFiles ?? DEFAULT_MAX_CONCURRENT_FILES;
        this.#maxPending = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
        this.#onOffer = opts.onOffer;
        this.#onProgress = opts.onProgress;
        this.#offMessage = channel.onMessage((data) => {
            if (isFileTransferMessage(data))
                void this.#onMessage(data).catch(() => { });
        });
        this.#offClose = channel.onClose?.(() => this.#shutdown(new Error('通道已關閉')));
    }
    /** 收到檔案（已通過整檔校驗）時通知；回傳取消函式 */
    onFile(listener) {
        this.#fileListeners.add(listener);
        return () => this.#fileListeners.delete(listener);
    }
    /** 送出檔案；收方校驗通過才算完成。斷線、被拒、校驗失敗都丟例外。 */
    async sendFile(source, opts = {}) {
        if (this.#closed)
            throw new Error('FileTransfer 已關閉');
        if (this.#channel.mode === 'relayed-websocket' && source.size > LARGE_PAYLOAD_WARNING_BYTES && !opts.allowLargeOverRelay) {
            throw new LargeFileOverRelayError('目前走中繼（對方不在同一個網路），超過 20 MB 的檔案預設不送：請改連同一個 Wi-Fi，或明確允許');
        }
        const id = opts.id ?? bytesToHex(randomBytes(ID_BYTES));
        if (!ID_RE.test(id))
            throw new Error('檔案 id 必須是 32 字元的小寫 hex');
        if (this.#waiters.has(id))
            throw new Error('同一個 id 的檔案正在傳送中');
        const offerReply = this.#await(id, REPLY_TIMEOUT_MS);
        await this.#channel.send(encodeJson(T_OFFER, { id, name: source.name, mime: source.mime, size: source.size, chunkSize: this.#chunkSize }));
        const reply = await offerReply;
        if (reply.type === 'reject')
            throw new FileRejectedError(`對方拒收：${reply.reason}`);
        if (reply.type !== 'accept')
            throw new Error('對方的回覆不正確');
        const have = reply.have;
        // 整檔雜湊：續傳時已送過的部分也要算進去（讀本機，不上網路）
        const hasher = sha256.create();
        const idBytes = hexToBytes(id);
        const report = (done) => {
            const progress = { id, done, total: source.size };
            opts.onProgress?.(progress);
            this.#onProgress?.(progress);
        };
        for (let offset = 0; offset < have; offset += this.#chunkSize) {
            hasher.update(await source.read(offset, Math.min(this.#chunkSize, have - offset)));
        }
        for (let offset = have; offset < source.size; offset += this.#chunkSize) {
            if (this.#closed)
                throw new Error('通道已關閉');
            const piece = await source.read(offset, Math.min(this.#chunkSize, source.size - offset));
            hasher.update(piece);
            const header = new Uint8Array(CHUNK_HEADER);
            header[0] = MAGIC;
            header[1] = T_CHUNK;
            header.set(idBytes, 2);
            new DataView(header.buffer).setBigUint64(2 + ID_BYTES, BigInt(offset));
            await this.#channel.send(concatBytes(header, piece));
            report(offset + piece.length);
        }
        if (source.size === 0)
            report(0);
        const doneReply = this.#await(id, DONE_TIMEOUT_MS);
        await this.#channel.send(encodeJson(T_END, { id, sha256: bytesToHex(hasher.digest()) }));
        const done = await doneReply;
        if (done.type !== 'done')
            throw new Error('對方的回覆不正確');
        if (!done.ok)
            throw new FileIntegrityError(`對方回報失敗：${done.reason ?? '整檔校驗不符'}`);
    }
    close() {
        this.#shutdown(new Error('FileTransfer 已關閉'));
    }
    #shutdown(error) {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#offMessage();
        this.#offClose?.();
        for (const waiter of this.#waiters.values())
            waiter.reject(error);
        this.#waiters.clear();
        // 收到一半的檔案留在暫存裡：同一個 id 再送來就從那裡接著收（續傳）
        this.#incoming.clear();
    }
    #await(id, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#waiters.delete(id);
                reject(new Error('對方沒有回應'));
            }, timeoutMs);
            this.#waiters.set(id, {
                resolve: (reply) => {
                    clearTimeout(timer);
                    this.#waiters.delete(id);
                    resolve(reply);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
    }
    async #onMessage(data) {
        const type = data[1];
        if (type === T_CHUNK) {
            if (data.length < CHUNK_HEADER)
                return;
            const id = bytesToHex(data.subarray(2, 2 + ID_BYTES));
            const offset = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(2 + ID_BYTES));
            this.#onChunk(id, offset, data.slice(CHUNK_HEADER));
            return;
        }
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(data.subarray(2)));
        }
        catch {
            return;
        }
        const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : undefined;
        if (!id)
            return;
        switch (type) {
            case T_OFFER:
                await this.#onOfferMessage(id, body);
                return;
            case T_ACCEPT:
                if (typeof body.have === 'number' && Number.isInteger(body.have) && body.have >= 0)
                    this.#waiters.get(id)?.resolve({ type: 'accept', have: body.have });
                return;
            case T_REJECT:
                this.#waiters.get(id)?.resolve({ type: 'reject', reason: String(body.reason ?? '') });
                return;
            case T_DONE: {
                const reply = { type: 'done', ok: body.ok === true };
                if (typeof body.reason === 'string')
                    reply.reason = body.reason;
                this.#waiters.get(id)?.resolve(reply);
                return;
            }
            case T_END: {
                const incoming = this.#incoming.get(id);
                if (!incoming || typeof body.sha256 !== 'string')
                    return;
                incoming.sha = body.sha256;
                this.#enqueue(incoming, () => this.#maybeFinish(incoming));
                return;
            }
        }
    }
    async #onOfferMessage(id, body) {
        const reject = (reason) => this.#channel.send(encodeJson(T_REJECT, { id, reason }));
        const { name, mime, size, chunkSize } = body;
        if (typeof name !== 'string' || name.length === 0 || name.length > 255 || typeof mime !== 'string' || mime.length > 255)
            return reject('格式不正確');
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 0)
            return reject('格式不正確');
        if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize < 1)
            return reject('格式不正確');
        if (size > this.#maxFileBytes)
            return reject(`檔案太大（上限 ${this.#maxFileBytes} 位元組）`);
        if (!this.#incoming.has(id) && this.#incoming.size >= this.#maxConcurrent)
            return reject('同時接收的檔案太多');
        const offer = { id, name, mime, size, chunkSize, from: this.#channel.peerPublicKey };
        const accept = this.#onOffer ? await this.#onOffer(offer) : true;
        if (!accept)
            return reject('收方拒絕');
        // 續傳：暫存裡已有的部分（超過檔案大小就是別的東西，清掉重來）
        let have = await this.#store.size(id);
        if (have > size) {
            await this.#store.delete(id);
            have = 0;
        }
        const hasher = sha256.create();
        if (have > 0)
            hasher.update(await this.#store.read(id));
        this.#incoming.set(id, { offer, received: have, hasher, pending: new Map(), pendingBytes: 0, finishing: false, queue: Promise.resolve() });
        await this.#channel.send(encodeJson(T_ACCEPT, { id, have }));
    }
    #enqueue(incoming, step) {
        incoming.queue = incoming.queue.then(step).catch(async () => {
            this.#incoming.delete(incoming.offer.id);
            await this.#store.delete(incoming.offer.id).catch(() => { });
            await this.#channel.send(encodeJson(T_DONE, { id: incoming.offer.id, ok: false, reason: '接收失敗' })).catch(() => { });
        });
    }
    #onChunk(id, offset, bytes) {
        const incoming = this.#incoming.get(id);
        if (!incoming || incoming.finishing)
            return;
        if (offset < incoming.received || incoming.pending.has(offset))
            return; // 重複
        if (offset + bytes.length > incoming.offer.size) {
            this.#enqueue(incoming, async () => {
                throw new Error('超過宣告的大小');
            });
            return;
        }
        incoming.pending.set(offset, bytes);
        incoming.pendingBytes += bytes.length;
        if (incoming.pendingBytes > this.#maxPending + incoming.offer.chunkSize) {
            this.#enqueue(incoming, async () => {
                throw new Error('亂序暫存超過上限');
            });
            return;
        }
        this.#enqueue(incoming, () => this.#drain(incoming));
    }
    /** 把接得上的分塊依序寫進暫存 */
    async #drain(incoming) {
        let next = incoming.pending.get(incoming.received);
        while (next) {
            const at = incoming.received;
            incoming.pending.delete(at);
            incoming.pendingBytes -= next.length;
            await this.#store.append(incoming.offer.id, next);
            incoming.hasher.update(next);
            incoming.received += next.length;
            this.#onProgress?.({ id: incoming.offer.id, done: incoming.received, total: incoming.offer.size });
            next = incoming.pending.get(incoming.received);
        }
        await this.#maybeFinish(incoming);
    }
    async #maybeFinish(incoming) {
        const { id, size } = incoming.offer;
        if (incoming.finishing || incoming.received !== size || incoming.sha === undefined)
            return;
        incoming.finishing = true;
        this.#incoming.delete(id);
        const ok = bytesToHex(incoming.hasher.digest()) === incoming.sha.toLowerCase();
        if (!ok) {
            await this.#store.delete(id);
            await this.#channel.send(encodeJson(T_DONE, { id, ok: false, reason: '整檔校驗不符' }));
            return;
        }
        const { chunkSize: _chunkSize, ...meta } = incoming.offer;
        const file = { ...meta, read: () => this.#store.read(id) };
        for (const listener of this.#fileListeners) {
            try {
                await listener(file);
            }
            catch {
                // App 的監聽出錯不影響回覆對方
            }
        }
        await this.#store.delete(id);
        await this.#channel.send(encodeJson(T_DONE, { id, ok: true }));
    }
}
//# sourceMappingURL=file-transfer.js.map