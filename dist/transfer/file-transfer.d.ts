import { type TransportMode } from '../peer/peer-node.js';
export declare const DEFAULT_FILE_CHUNK_BYTES: number;
/** 收方預設的單檔上限：100 MB（檔案最後會整個讀進記憶體交給 App，同 Cinderous 的 maxMemoryFileSize）。 */
export declare const DEFAULT_MAX_FILE_BYTES: number;
export declare const DEFAULT_MAX_CONCURRENT_FILES = 16;
/** 亂序先到、還接不上的分塊最多暫存多少位元組（沒有收端流量控制，不設上限就是 OOM）。 */
export declare const DEFAULT_MAX_PENDING_BYTES: number;
/** 只用到的通道能力；`PeerChannel` 與 `SecureChannel` 都符合 */
export interface ByteChannel {
    readonly peerPublicKey: string;
    readonly mode?: TransportMode;
    send(data: Uint8Array): Promise<void>;
    onMessage(listener: (data: Uint8Array) => void): () => void;
    onClose?(listener: () => void): () => void;
}
/** 要送的檔案：只要能說出大小、能按位移讀一段 */
export interface FileSource {
    name: string;
    mime: string;
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}
export declare function bytesSource(name: string, mime: string, bytes: Uint8Array): FileSource;
/** 瀏覽器的 Blob／File：分段讀，不必整個載進記憶體 */
export declare function blobSource(name: string, mime: string, blob: {
    size: number;
    slice(start: number, end: number): {
        arrayBuffer(): Promise<ArrayBuffer>;
    };
}): FileSource;
/**
 * 收方的暫存。預設放記憶體；要續傳跨越 App 重開、或大檔寫硬碟，就換成自己的實作。
 * 同一個 id 的內容一律從 0 開始連續寫入。
 */
export interface PartialFileStore {
    size(id: string): Promise<number>;
    append(id: string, bytes: Uint8Array): Promise<void>;
    read(id: string): Promise<Uint8Array>;
    delete(id: string): Promise<void>;
}
export declare class MemoryPartialStore implements PartialFileStore {
    #private;
    size(id: string): Promise<number>;
    append(id: string, bytes: Uint8Array): Promise<void>;
    read(id: string): Promise<Uint8Array>;
    delete(id: string): Promise<void>;
}
export interface FileOffer {
    id: string;
    name: string;
    mime: string;
    size: number;
    chunkSize: number;
    /** 對方的公鑰 */
    from: string;
}
export interface ReceivedFile extends Omit<FileOffer, 'chunkSize'> {
    /** 讀出整個檔案（已通過整檔校驗）。監聽回傳之後暫存就會清掉，要保存請在監聽裡讀完。 */
    read(): Promise<Uint8Array>;
}
export interface TransferProgress {
    id: string;
    done: number;
    total: number;
}
export declare class FileRejectedError extends Error {
    readonly name = "FileRejectedError";
}
export declare class FileIntegrityError extends Error {
    readonly name = "FileIntegrityError";
}
/** 走中繼的大檔（PRD 2.3）：預設不送，App 提示使用者連同一個 Wi-Fi，或明確允許 */
export declare class LargeFileOverRelayError extends Error {
    readonly name = "LargeFileOverRelayError";
}
export declare function isFileTransferMessage(data: Uint8Array): boolean;
export interface FileTransferOptions {
    chunkSize?: number;
    store?: PartialFileStore;
    maxFileBytes?: number;
    maxConcurrentFiles?: number;
    maxPendingBytes?: number;
    /** 收到邀請時決定要不要收；預設大小在上限內就收 */
    onOffer?: (offer: FileOffer) => boolean | Promise<boolean>;
    onProgress?: (progress: TransferProgress) => void;
}
export interface SendFileOptions {
    /** 同一個檔案重送時用同一個 id，收方才能續傳（32 字元 hex）；預設隨機 */
    id?: string;
    onProgress?: (progress: TransferProgress) => void;
    /** 走中繼也要送超過 20 MB 的檔案 */
    allowLargeOverRelay?: boolean;
}
export declare class FileTransfer {
    #private;
    /**
     * 同一條通道只用一個實例：兩個實例掛在同一條通道上，對方的邀請會被回應兩次。
     * 第一次呼叫時的選項生效，之後的呼叫拿到同一個實例。
     */
    static for(channel: ByteChannel, opts?: FileTransferOptions): FileTransfer;
    constructor(channel: ByteChannel, opts?: FileTransferOptions);
    /** 收到檔案（已通過整檔校驗）時通知；回傳取消函式 */
    onFile(listener: (file: ReceivedFile) => void | Promise<void>): () => void;
    /** 送出檔案；收方校驗通過才算完成。斷線、被拒、校驗失敗都丟例外。 */
    sendFile(source: FileSource, opts?: SendFileOptions): Promise<void>;
    close(): void;
}
//# sourceMappingURL=file-transfer.d.ts.map