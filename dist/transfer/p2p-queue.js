import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { FileRejectedError, FileTransfer } from './file-transfer.js';
export class P2PFileQueue {
    #node;
    #transferOptions;
    #queues = new Map();
    #offPeer;
    #closed = false;
    constructor(opts) {
        this.#node = opts.node;
        this.#transferOptions = opts.transferOptions;
        this.#offPeer = opts.node.onPeer((channel) => {
            if (channel.mode === 'p2p-webrtc')
                void this.#sendAll(channel);
        });
    }
    /** 排一個檔案給對方；對方校驗通過時完成。同一個檔案要能續傳，請給固定的 `opts.id`。 */
    enqueue(peer, source, opts = {}) {
        if (this.#closed)
            return Promise.reject(new Error('佇列已關閉'));
        // 沒給 id 就在這裡固定一個：重試時用同一個 id，對方才能從斷點續傳
        const fixed = { ...opts, id: opts.id ?? bytesToHex(randomBytes(16)) };
        return new Promise((resolve, reject) => {
            const list = this.#queues.get(peer) ?? [];
            list.push({ source, opts: fixed, resolve, reject, sending: false });
            this.#queues.set(peer, list);
        });
    }
    pending(peer) {
        if (peer !== undefined)
            return this.#queues.get(peer)?.length ?? 0;
        let n = 0;
        for (const list of this.#queues.values())
            n += list.length;
        return n;
    }
    /** 試著連到對方；打通 P2P 就把排著的都送過去。只打得通中繼就繼續排著。 */
    async flush(peer) {
        if (this.#closed || this.pending(peer) === 0)
            return;
        const channel = await this.#node.connectPeer(peer);
        if (channel.mode === 'p2p-webrtc')
            await this.#sendAll(channel);
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#offPeer();
        for (const list of this.#queues.values())
            for (const item of list)
                item.reject(new Error('佇列已關閉'));
        this.#queues.clear();
    }
    async #sendAll(channel) {
        const list = this.#queues.get(channel.peerPublicKey);
        if (!list)
            return;
        const transfer = FileTransfer.for(channel, this.#transferOptions);
        for (const item of [...list]) {
            if (item.sending || this.#closed)
                continue;
            item.sending = true;
            try {
                await transfer.sendFile(item.source, item.opts);
                list.splice(list.indexOf(item), 1);
                if (list.length === 0)
                    this.#queues.delete(channel.peerPublicKey);
                item.resolve();
            }
            catch (error) {
                if (error instanceof FileRejectedError) {
                    // 對方明確拒收：重試也沒用，移出佇列並回報
                    list.splice(list.indexOf(item), 1);
                    if (list.length === 0)
                        this.#queues.delete(channel.peerPublicKey);
                    item.reject(error);
                    continue;
                }
                item.sending = false; // 斷線或其他失敗：留在佇列，下次打通再送（固定 id ⇒ 從斷點續傳）
                if (channel.closed)
                    return;
            }
        }
    }
}
//# sourceMappingURL=p2p-queue.js.map