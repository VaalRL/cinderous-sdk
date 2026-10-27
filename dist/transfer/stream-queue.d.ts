import type { ByteChannel } from './file-transfer.js';
import { type StreamEntryResult, type StreamTransferOptions } from './stream.js';
/** 鍵值儲存（非同步）。IndexedDB、檔案、記憶體都可以；形狀與 `SyncStateStore` 相同。 */
export interface TransferQueueStore {
    get(key: string): Promise<Uint8Array | null>;
    set(key: string, value: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix: string): Promise<string[]>;
}
/** 持久化的一筆（不含內容；重開後用 `open` 重新取得） */
export interface QueuedStreamFile {
    peer: string;
    id: string;
    size: number;
    sha256: string;
    meta: Record<string, unknown>;
    /** 排進佇列的時間（毫秒） */
    at: number;
}
export interface StreamFileInput {
    /** 同一個檔案重排時用同一個 id；預設隨機 */
    id?: string;
    size: number;
    /** 沒給就在排隊時分段算一次（記憶體只佔一段） */
    sha256?: string;
    /** 給收方的中繼資料（例如檔名）；也會存進佇列，重開後 `open` 用它找回檔案 */
    meta?: Record<string, unknown>;
    read(offset: number, length: number): Promise<Uint8Array>;
}
/** 只用到的節點能力；`PeerNode` 符合 */
export interface StreamQueuePeerNode {
    connectPeer(pubkey: string): Promise<ByteChannel & {
        readonly closed?: boolean;
    }>;
    onPeer(listener: (channel: ByteChannel & {
        readonly closed?: boolean;
    }) => void): () => void;
}
export interface P2PStreamQueueOptions {
    node: StreamQueuePeerNode;
    /** 佇列寫到哪裡；沒給就只在記憶體 */
    store?: TransferQueueStore;
    /** 重開後重新打開檔案（檔案不見了回 null，那一筆以失敗結束） */
    open?(file: QueuedStreamFile): Promise<((offset: number, length: number) => Promise<Uint8Array>) | null>;
    /** 收方依這個找處理器；預設 `DEFAULT_STREAM_QUEUE_PURPOSE` */
    purpose?: string;
    /** 只打得通中繼也送（預設不送：這一層的檔案大到不該走中繼） */
    allowRelay?: boolean;
    /** 在通道上再包一層（例如 `secureChannel` 的雙棘輪） */
    wrap?(channel: ByteChannel): Promise<ByteChannel>;
    transferOptions?: StreamTransferOptions;
    now?(): number;
}
export declare const DEFAULT_STREAM_QUEUE_PURPOSE = "cinderous/file/1";
export declare class P2PStreamQueue {
    #private;
    constructor(opts: P2PStreamQueueOptions);
    /** App 重開後讀回持久化的佇列；回傳讀回幾筆。之後照常 `flush`（或等對方連上來）。 */
    restore(): Promise<number>;
    /** 排一個檔案給對方；對方校驗、處理完成時 resolve（對方已經有了也算完成：`skipped`）；對方拒收或校驗失敗時 reject。 */
    enqueue(peer: string, input: StreamFileInput): Promise<StreamEntryResult>;
    pending(peer?: string): number;
    list(): QueuedStreamFile[];
    /** 每一筆有結果時通知（包括 `restore` 讀回來、沒有人在等 Promise 的那些） */
    onSettled(listener: (file: QueuedStreamFile, result: StreamEntryResult) => void): () => void;
    /** 移出佇列（不送了） */
    remove(peer: string, id: string): Promise<void>;
    /** 試著連到對方；打通 P2P（或允許中繼時）就把排著的都送過去。 */
    flush(peer: string): Promise<void>;
    close(): void;
}
//# sourceMappingURL=stream-queue.d.ts.map