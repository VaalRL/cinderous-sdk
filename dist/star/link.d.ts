import type { SecureChannel } from '../crypto/secure-channel.js';
import type { TransportMode } from '../peer/peer-node.js';
import { type StarEndReason, type WireRecord } from './wire.js';
/** 鏈路需要的通道能力（`secureChannel` 回傳的物件就是） */
export type StarChannel = Pick<SecureChannel, 'peerPublicKey' | 'mode' | 'engineType' | 'send' | 'onMessage' | 'onClose' | 'close'> & {
    /** 有的話用來偵測「交給我之前就關了」（`PeerChannel` 有；`SecureChannel` 沒有，由 `listen`／`join` 事先檢查） */
    readonly closed?: boolean;
};
export interface StarTimers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    now(): number;
}
export declare const realTimers: StarTimers;
export interface LinkTuning {
    /** 批次視窗：第一筆紀錄進佇列後最多等這麼久就送 */
    batchWindowMs: number;
    /** 一個封包最多裝多少位元組的紀錄（單筆超過就自己一包） */
    maxBatchBytes: number;
    /** 每條鏈路的佇列上限（位元組／筆） */
    maxQueueBytes: number;
    maxQueueRecords: number;
    /** 多久沒送東西就送心跳 */
    heartbeatMs: number;
    /** 多久沒收到對方任何東西就判定斷線 */
    timeoutMs: number;
    /** true＝底層可靠且有序（P2P DataChannel）：不留底、不重送 */
    reliable: boolean;
    /** 送出後多久沒被確認就重送（只在不可靠的中繼軌） */
    rtoMs: number;
    maxRetransmits: number;
    /** 送出未確認的封包上限：到了就先不送新資料（背壓回到佇列） */
    maxUnacked: number;
    /** 收到確認前延遲多久才單獨回一個確認封包（能搭便車就不單獨送） */
    ackDelayMs: number;
    /** 亂序暫存上限（封包數／位元組）與缺號最久等多久 */
    reorderLimit: number;
    reorderMaxBytes: number;
    gapTimeoutMs: number;
    /** 收到的單一封包上限 */
    maxPacketBytes: number;
}
export declare function defaultTuning(mode: TransportMode, maxPayloadBytes: number): LinkTuning;
/** 中繼軌的預設事件預算（每分鐘）：低於 SDK 中繼的每把公鑰每分鐘 120 則（NIP-11 `cinder_max_events_per_minute`）。與 `PeerNode` 同一個預設（SDK ADR 0043） */
export declare const DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE = 100;
/**
 * 從中繼的 NIP-11 文件算出星狀會話該用的每分鐘事件預算：宣告值 × 0.8（留給信令、心跳以外的其他用途）。
 * 沒宣告就回 `fallback`。多座中繼時取最小的。與 `relayEventsPerMinute`（PeerNode、Vault、名單同步）是同一個函式（SDK ADR 0043）。
 */
export declare const starRelayEventsPerMinute: (nip11: unknown, fallback?: number) => number;
/** 星狀會話實際用的預算：`relayEventsPerMinute`（預設 100）與 `relayInfo` 宣告值 × 0.8 的較小者（SDK ADR 0043） */
export declare function starRelayBudget(opts: Pick<StarTransportOptions, 'relayEventsPerMinute' | 'relayInfo'>): number;
/** Host 與成員共用的傳輸選項 */
export interface StarTransportOptions {
    /** 中繼軌每分鐘最多送幾個事件（整個身分合計；Host 會平均分給走中繼的成員）。預設 100 */
    relayEventsPerMinute?: number;
    /**
     * 中繼的 NIP-11 文件（一份或多份）：有 `cinder_max_events_per_minute` 就自動取「宣告值 × 0.8」與 `relayEventsPerMinute` 的較小者
     *（SDK ADR 0043）。同一身分的 `PeerNode` 也應該給同一份（`relayInfo` 選項或 `applyRelayInfo`）。
     */
    relayInfo?: unknown;
    /** 調整鏈路參數（批次視窗、佇列上限、心跳……）；可依通道模式給不同的值 */
    tuning?: Partial<LinkTuning> | ((mode: TransportMode) => Partial<LinkTuning>);
    timers?: StarTimers;
    /** 內部錯誤（App 監聽丟例外、中繼暫時拒收）的通知 */
    onError?: (error: unknown) => void;
}
export declare function resolveTuning(mode: TransportMode, maxPayloadBytes: number, override: StarTransportOptions['tuning']): LinkTuning;
export interface LinkHandlers {
    /** 依序交出對方送來的紀錄（同一封包的紀錄一次交出） */
    onRecords(records: WireRecord[]): void;
    /** 鏈路失效（逾時、失步、協定錯誤、通道關閉）；只會呼叫一次，之後鏈路已關 */
    onFail(reason: StarEndReason): void;
    onError?(error: unknown): void;
}
export interface LinkStats {
    queuedBytes: number;
    queuedRecords: number;
    unacked: number;
    packetsSent: number;
    bytesSent: number;
    retransmits: number;
    droppedVolatile: number;
}
export declare class Link {
    #private;
    readonly stats: LinkStats;
    constructor(channel: StarChannel, tuning: LinkTuning, handlers: LinkHandlers, opts?: {
        timers?: StarTimers;
        minIntervalMs?: () => number;
    });
    /** 開始收（通道在這之前收到的訊息會在這裡一次交出，所以擁有者要先把鏈路存好再呼叫） */
    start(): void;
    /** 佇列裡每位寄件人佔了多少位元組 */
    queuedByOrigin(): Map<string, number>;
    /** 丟掉佇列裡某位寄件人還沒送出的紀錄 */
    purge(origin: string): void;
    /** 換一組參數（例如 Host 在對方加入前用較嚴的上限，加入後放寬） */
    retune(tuning: LinkTuning): void;
    /** 丟掉還沒送的，只送這一筆（例如「你被踢了」），送完或 `graceMs` 到了就關 */
    endWith(record: WireRecord, graceMs: number): Promise<void>;
    get peerPublicKey(): string;
    get mode(): TransportMode;
    get channel(): StarChannel;
    get open(): boolean;
    get maxQueueBytes(): number;
    get queuedBytes(): number;
    /**
     * 排進佇列。放不下時先丟佇列裡最舊的可丟棄紀錄；還是放不下：本筆可丟棄就默默丟掉（回 true），
     * 否則回 false（溢出，由擁有者決定怎麼處理，通常是斷掉這條鏈路）。
     */
    enqueue(record: WireRecord, volatile?: boolean, origin?: string): boolean;
    /** 不再收新資料；把佇列送完（或等到 `graceMs`）再關通道。 */
    closeAfterFlush(graceMs: number): Promise<void>;
    /** 立刻關閉並回報原因（只回報一次） */
    fail(reason: StarEndReason): void;
    /** 靜默關閉（擁有者自己要關，不回報） */
    close(): void;
}
//# sourceMappingURL=link.d.ts.map