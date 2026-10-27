import type { PeerNode } from '../peer/peer-node.js';
import { type FileSource, type FileTransferOptions, type SendFileOptions } from './file-transfer.js';
export interface P2PFileQueueOptions {
    node: PeerNode;
    transferOptions?: FileTransferOptions;
}
export declare class P2PFileQueue {
    #private;
    constructor(opts: P2PFileQueueOptions);
    /** 排一個檔案給對方；對方校驗通過時完成。同一個檔案要能續傳，請給固定的 `opts.id`。 */
    enqueue(peer: string, source: FileSource, opts?: SendFileOptions): Promise<void>;
    pending(peer?: string): number;
    /** 試著連到對方；打通 P2P 就把排著的都送過去。只打得通中繼就繼續排著。 */
    flush(peer: string): Promise<void>;
    close(): void;
}
//# sourceMappingURL=p2p-queue.d.ts.map