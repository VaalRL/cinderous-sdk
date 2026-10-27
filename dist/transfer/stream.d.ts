import type { ByteChannel, PartialFileStore } from './file-transfer.js';
export declare const STREAM_MAGIC = 203;
/** 串流線路格式版本；日後改格式要升版，收端略過不認得的版本 */
export declare const STREAM_WIRE_VERSION = 1;
/** 送方每次讀多少、每個 DATA 紀錄最多多大 */
export declare const DEFAULT_STREAM_CHUNK_BYTES: number;
/** 送方累積到這麼多位元組就送出一則（小檔的多個紀錄併成一則，省下中繼軌的事件數） */
export declare const DEFAULT_STREAM_FLUSH_BYTES: number;
/** 收方給的信用視窗：送出但還沒被處理完（寫進儲存）的位元組上限 */
export declare const DEFAULT_STREAM_WINDOW_BYTES: number;
/** 不超過這個大小的檔案在記憶體裡組起來；更大的寫進 `StreamingFileStore`，可以續傳 */
export declare const DEFAULT_STREAM_INLINE_BYTES: number;
/** 單檔上限（寫進儲存時）：64 GiB。收方可以調整；宣告超過就拒收那個檔案 */
export declare const DEFAULT_MAX_STREAM_ENTRY_BYTES: number;
/** 一個工作階段最多幾個檔案 */
export declare const DEFAULT_MAX_STREAM_ENTRIES = 100000;
/** 同時進行的收方工作階段上限 */
export declare const DEFAULT_MAX_STREAM_SESSIONS = 8;
/** 多久沒有任何進展就放棄（收方保留已寫入的部分，下次續傳） */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60000;
/** 送方等收方回應 OPEN 多久 */
export declare const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 15000;
/** 每個檔案（與工作階段）附帶的中繼資料 JSON 上限 */
export declare const MAX_STREAM_META_BYTES: number;
/** 收方的大檔暫存：`PartialFileStore` 加上分段讀取，選配原子提交。 */
export interface StreamingFileStore extends PartialFileStore {
    /** 讀暫存裡的一段（續傳時重算雜湊、交給 App 時分段讀；不必整檔進記憶體） */
    readRange(id: string, offset: number, length: number): Promise<Uint8Array>;
    /**
     * 整檔校驗通過、而且 App 的監聽都成功之後呼叫：把暫存原子地變成正式檔案（例如 rename 暫存檔 → 目的地）。
     * 提交之後 `size(id)` 應回 0。沒有實作就改呼叫 `delete(id)`。校驗失敗的暫存一律 `delete`，不會提交。
     */
    commit?(id: string, info: StreamCommitInfo): Promise<void>;
    /**
     * 這份暫存是本機的**單一檔案**時回傳它的路徑（SDK ADR 0089）：整檔校驗通過後放進 `ReceivedEntry.stagedPath`，
     * App 可以直接改名取用、不必讀出再寫（行動版經原生橋接的讀寫很耗記憶體）。呼叫前要把還在記憶體的部分寫進檔案。
     * App 取走之後這份暫存就不在了：之後的 `commit`／`delete` 要容忍檔案不存在。沒有實作＝沒有這個路徑。
     */
    localPath?(id: string): Promise<string | undefined>;
}
export interface StreamCommitInfo {
    sha256: string;
    size: number;
    entryId: string;
    meta: Record<string, unknown>;
    from: string;
    purpose: string;
}
/** 記憶體實作（測試與範例）。`committed` 是提交後的內容。 */
export declare class MemoryStreamingStore implements StreamingFileStore {
    #private;
    readonly committed: Map<string, Uint8Array<ArrayBufferLike>>;
    size(id: string): Promise<number>;
    append(id: string, bytes: Uint8Array): Promise<void>;
    read(id: string): Promise<Uint8Array>;
    readRange(id: string, offset: number, length: number): Promise<Uint8Array>;
    commit(id: string): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 要送的一個檔案。`sha256` 必須事先知道（大檔用 `hashSource` 分段算，不必整檔進記憶體）。 */
export interface StreamEntry {
    /** 英數與 `._:-`，最長 128 */
    id: string;
    size: number;
    /** 整檔 SHA-256（小寫 hex） */
    sha256: string;
    meta?: Record<string, unknown>;
    read(offset: number, length: number): Promise<Uint8Array>;
}
export declare function bytesEntry(id: string, bytes: Uint8Array, meta?: Record<string, unknown>): StreamEntry;
/** 分段算整檔 SHA-256，記憶體只佔一段。 */
export declare function hashSource(source: {
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}, chunkBytes?: number): Promise<string>;
export type StreamEntryResult = {
    status: 'ok';
} | {
    status: 'skipped';
} | {
    status: 'failed';
    reason: string;
};
export interface StreamSessionInfo {
    /** 工作階段 id（hex） */
    id: string;
    /** 對方公鑰（通道已認證） */
    from: string;
    purpose: string;
    /** 送方宣告的檔案數、總位元組數（只是提示；實際以收到的為準，各有上限） */
    count?: number;
    bytes?: number;
    meta?: Record<string, unknown>;
}
export interface StreamEntryHeader {
    index: number;
    id: string;
    size: number;
    sha256: string;
    meta: Record<string, unknown>;
}
/** 收到、已通過 SHA-256 校驗的一個檔案 */
export interface ReceivedEntry extends StreamEntryHeader {
    session: StreamSessionInfo;
    /** 小檔（≤ inline 上限）在記憶體裡的內容；大檔沒有這個欄位，請用 `readRange` */
    bytes?: Uint8Array;
    readRange(offset: number, length: number): Promise<Uint8Array>;
    /** 整檔讀進記憶體（大檔請避免） */
    read(): Promise<Uint8Array>;
    /**
     * 暫存區回報的本機檔案路徑（`StreamingFileStore.localPath`；SDK ADR 0089）：內容已通過整檔 SHA-256 校驗，
     * App 可以直接改名取用。只有存進暫存區（大檔）、而且暫存區實作了 `localPath` 時才有
     */
    stagedPath?: string;
}
/**
 * 某一種用途（`purpose`）的收方處理器。同一條通道可以有多種用途（例如 Vault 同步與一般檔案佇列），
 * 各自有自己的儲存與規則；送方宣告的用途沒有人處理就拒收。
 */
export interface StreamHandler {
    /** 大檔（> `inlineBytes`）寫到哪裡；沒有就拒收大檔 */
    store?: StreamingFileStore;
    inlineBytes?: number;
    maxEntryBytes?: number;
    maxEntries?: number;
    /** 要不要開這個工作階段；預設要 */
    onSession?(info: StreamSessionInfo): boolean | Promise<boolean>;
    /**
     * 收資料之前決定這個檔案：`true` 收、`'skip'` 不需要（例如已經有了）、`false` 拒收。
     * 大檔選 skip／false 時送方不會送資料；小檔的資料已經在路上，收到就丟。預設 `true`。
     */
    accept?(header: StreamEntryHeader, session: StreamSessionInfo): boolean | 'skip' | Promise<boolean | 'skip'>;
    /**
     * 校驗通過的檔案。這個函式結束之後：大檔的暫存會被提交（`commit`）或刪除。
     * 丟例外＝這個檔案失敗（送方收到 failed），大檔的暫存保留，下次續傳不必重送。
     */
    onEntry(entry: ReceivedEntry): void | Promise<void>;
    /**
     * 收方進度（SDK ADR 0053 §G14）：開始收一個檔案（含續傳的起點）、每段資料、每個檔案有結果之後通知。同步呼叫、次數多，
     * 要更新畫面請自己節流；丟例外不影響傳輸。
     */
    onProgress?(progress: StreamReceiveProgress): void;
    /**
     * 工作階段結束（SDK ADR 0053 §G14）：`finished`＝送方送完（END）、`rejected`＝收方拒絕或協定錯誤、
     * `dropped`＝斷線、逾時或送方取消。只在 OPEN 之後（找得到處理器）才通知，每個工作階段一次。
     */
    onSessionEnd?(session: StreamSessionInfo, outcome: StreamSessionOutcome): void;
}
/** 收方的工作階段怎麼結束的（`onSessionEnd`） */
export type StreamSessionOutcome = 'finished' | 'rejected' | 'dropped';
/** 收方進度（`StreamHandler.onProgress`） */
export interface StreamReceiveProgress {
    session: StreamSessionInfo;
    /** 已經有結果的檔案數（收完、略過、拒收、失敗） */
    entries: number;
    /** 這個工作階段實際收到的資料位元組（續傳時不含之前已經有的部分） */
    bytes: number;
    /** 正在收的檔案；`received` 含續傳之前已經有的部分 */
    entry?: {
        index: number;
        id: string;
        size: number;
        received: number;
        meta: Record<string, unknown>;
    };
}
/** 可注入的時間來源與計時器（測試用假的時鐘；形狀與 Vault 協調器的 `VaultSyncClock` 相同） */
export interface StreamTimers {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface StreamTransferOptions {
    timers?: StreamTimers;
    chunkBytes?: number;
    flushBytes?: number;
    /** 收方給送方的信用視窗 */
    windowBytes?: number;
    maxSessions?: number;
    idleTimeoutMs?: number;
    openTimeoutMs?: number;
}
export interface SendStreamOptions {
    /** 收方依這個找處理器（英數與 `._:/-`，最長 64） */
    purpose: string;
    meta?: Record<string, unknown>;
    /** 預計的檔案數、總位元組數（給收方的 onSession 參考） */
    count?: number;
    bytes?: number;
    /** 每個檔案有結果時通知（收方校驗、處理完之後） */
    onEntryDone?(index: number, id: string, result: StreamEntryResult): void;
    onProgress?(progress: {
        entries: number;
        bytes: number;
    }): void;
}
export interface StreamSendResult {
    results: StreamEntryResult[];
    entries: number;
    /** 實際送出的資料位元組（續傳時不含對方已有的部分） */
    bytes: number;
}
export declare class StreamRejectedError extends Error {
    readonly name = "StreamRejectedError";
}
/** 串流中斷（斷線、逾時）。`results` 是中斷前已經有結果的檔案，其餘的下次再送（大檔會續傳）。 */
export declare class StreamInterruptedError extends Error {
    readonly results: ReadonlyArray<StreamEntryResult | undefined>;
    readonly name = "StreamInterruptedError";
    constructor(message: string, results: ReadonlyArray<StreamEntryResult | undefined>);
}
/** 收方回報整批清單不符（檔案數或清單雜湊對不上：有檔案在途中被加入或漏掉） */
export declare class StreamIntegrityError extends Error {
    readonly name = "StreamIntegrityError";
}
export declare function isStreamMessage(data: Uint8Array): boolean;
/** 收發兩端共用的統計（測試量記憶體占用用） */
export interface StreamStats {
    /** 收方：收到但還沒處理完的位元組峰值 */
    peakBufferedBytes: number;
    /** 送方：送出但還沒被確認的位元組峰值 */
    peakInflightBytes: number;
    /** 收方：組在記憶體裡的小檔位元組峰值 */
    peakInlineBytes: number;
}
/**
 * 批次串流的一端（收送兩用）。同一條通道只用一個實例（`StreamTransfer.for`），用途不同的處理器用 `handle` 掛上。
 *
 * ```ts
 * const stream = StreamTransfer.for(channel);
 * stream.handle('files', { store, onEntry: async (entry) => save(entry) });
 * await stream.send(entries, { purpose: 'files' });
 * ```
 */
export declare class StreamTransfer {
    #private;
    static for(channel: ByteChannel, opts?: StreamTransferOptions): StreamTransfer;
    constructor(channel: ByteChannel, opts?: StreamTransferOptions);
    get closed(): boolean;
    /** 收發的記憶體峰值（測試與監控用） */
    stats(): StreamStats;
    /** 掛上某種用途的收方處理器；回傳取消函式 */
    handle(purpose: string, handler: StreamHandler): () => void;
    /**
     * 送一批檔案（可以是陣列、產生器或非同步產生器；檔案依序送出）。
     * 收方處理完最後一個檔案、而且整批清單相符時完成。中途斷線丟 `StreamInterruptedError`（附已有的結果）。
     */
    send(entries: Iterable<StreamEntry> | AsyncIterable<StreamEntry>, opts: SendStreamOptions): Promise<StreamSendResult>;
    close(): void;
}
//# sourceMappingURL=stream.d.ts.map