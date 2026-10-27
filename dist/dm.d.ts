/**
 * 私訊（SDK ADR 0001；源自《沒當好爸爸》ADR 0025）：標準 NIP-17。kind 14 rumor（不簽）→ kind 13 seal（寄件人簽、NIP-44 加給收件人）
 * → kind 1059 gift wrap（一次性金鑰簽、只有 `p` 標籤）。同一份 rumor 封兩次：給對方、給自己，
 * 回來時以 rumor id 去重——任何支援 NIP-17 的客戶端都讀得到，Relay 只看得到收件人與密文。
 *
 * 不做前向保密與多裝置同步（那是 Cinderous 本體的事）；對話存在本機，Relay 上只留 7 天。
 *
 * 封裝與拆封走 `protocol/nip59`（經 `Identity.sealAndWrap`／`openWrap`）：SDK 裡禮物包只有這一份實作
 * （SDK ADR 0012）。它與 nostr-tools 的 NIP-17 雙向互通，由 `dm.test.ts` 釘住。
 */
import type { Event } from 'nostr-tools/core';
import { type ChatStorageLike } from './chat-storage.js';
import type { Identity } from './identity.js';
import { type ClassifiedRejection, type PublishRejectionReport } from './publish-rejections.js';
import type { DurabilityResult, PublishDurability, RelayTransport } from './relay-pool.js';
export declare const DM_RUMOR_KIND = 14;
export declare const DM_SEAL_KIND = 13;
export declare const DM_WRAP_KIND = 1059;
/** 一則私訊的字數上限 */
export declare const DM_MAX_CHARS = 1000;
/** 收件匣往回看多久：已知租戶車道上一般事件保存 7 天 */
export declare const DM_LOOKBACK_SEC: number;
/** 每位對象在本機保留的則數、最多幾段對話 */
export declare const DM_HISTORY_PER_PEER = 200;
export declare const DM_PEERS_LIMIT = 50;
/** 對話在儲存裡的預設鍵；各應用可用 `storageKey` 沿用自己既有的鍵 */
export declare const DEFAULT_DM_STORAGE_KEY = "cinderous:dm:threads";
/** 解開的一則私訊 */
export interface ReceivedDm {
    /** rumor id：兩份封裝解出來相同，用來去重 */
    readonly id: string;
    /** 對話的另一方 */
    readonly peer: string;
    readonly text: string;
    /** rumor 的 created_at（秒；真正的發送時間） */
    readonly at: number;
    readonly mine: boolean;
}
export interface DmLine {
    readonly id: string;
    readonly text: string;
    readonly at: number;
    readonly mine: boolean;
}
export interface DmThread {
    readonly peer: string;
    readonly lines: readonly DmLine[];
    readonly lastAt: number;
}
/** localStorage 的子集：測試注入記憶體版。非同步的儲存（IndexedDB 等）用 `AsyncChatStorage`（SDK ADR 0024） */
export interface ChatStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
export interface WrapDmRequest {
    readonly identity: Identity;
    readonly to: string;
    readonly text: string;
    readonly nowSec: number;
}
/** 封一則私訊：回傳 [給對方的, 給自己的]。空白或超過字數丟例外。 */
export declare function wrapDm(request: WrapDmRequest): Event[];
/** 解開給我的封裝；不是給我的、被改過、冒名（seal 簽章者≠rumor 作者）、形狀不對一律 `null`。 */
export declare function unwrapDm(identity: Identity, wrap: Event): ReceivedDm | null;
export interface DirectMessagesOptions {
    readonly transport: RelayTransport;
    readonly identity: Identity;
    /** 毫秒；測試可注入 */
    readonly now?: () => number;
    /**
     * 對話存哪裡；省略就只放記憶體。可以是同步的 `ChatStorage`（例如 `localStorage`），
     * 也可以是非同步的 `AsyncChatStorage`（例如 IndexedDB；SDK ADR 0024）——後者要 `await ready()` 才讀得到舊對話。
     */
    readonly storage?: ChatStorageLike;
    /** 對話存在哪個鍵；預設 `DEFAULT_DM_STORAGE_KEY`。已上線的應用填自己原本的鍵，舊對話才讀得回來 */
    readonly storageKey?: string;
    readonly isBlocked?: (pubkey: string) => boolean;
    /**
     * 有中繼拒收時回報（SDK ADR 0038 P0-C）：兩份封裝（給對方、給自己）各報一次。
     * 成功與否照舊以「至少一座收下」判斷；這裡讓應用看得到「三座裡兩座因為滿了沒收」。
     */
    readonly onPublishRejected?: (report: PublishRejectionReport) => void;
    /**
     * 耐久度要求（SDK ADR 0041）：兩份封裝各自要至少 `minAccepted` 座**耐久收下**（借用不算）才算送出；
     * 不足時只有給了 `standby` 才會延遲連上備援補發。省略＝v0.32 的判斷（至少一座收下）。
     * 建議：`standby` 放對方 NIP-17（kind 10050）公布的收件中繼（`@cinderous/client/durability` 的 `dmRelaysFor`）。
     */
    readonly durability?: PublishDurability;
}
export interface SendOutcome {
    readonly ok: boolean;
    readonly message: string;
    /** 給對方那一份：收下的中繼（v0.32；SDK ADR 0038 P0-C） */
    readonly accepted?: readonly string[];
    /** 給對方那一份：拒收的中繼與分類（不含沒連上的）；部分拒收時 `ok` 仍是 true */
    readonly rejected?: readonly ClassifiedRejection[];
    /** 給對方那一份的耐久度結果（有設定 `durability`、而且傳輸層是 `RelayPool` 時才有；v0.33） */
    readonly durability?: DurabilityResult;
}
/** 私訊收件匣與對話紀錄。收件匣訂閱是 `#p` 自己，車道要先 NIP-42（RelayPool 帶身分時自動處理）。 */
export declare class DirectMessages {
    #private;
    constructor(options: DirectMessagesOptions);
    threads(): readonly DmThread[];
    /** 舊對話讀回來之後完成。同步儲存（或沒有儲存）立刻完成。 */
    ready(): Promise<void>;
    /** 到目前為止的變更都寫進儲存之後完成。同步儲存（或沒有儲存）立刻完成。 */
    flush(): Promise<void>;
    /** 開收件匣；立刻回呼一次目前的對話，之後每次變動都回呼。 */
    watch(listener: (threads: readonly DmThread[]) => void): () => void;
    /** 送一則：本機先記下，兩份封裝都發；全部 Relay 拒收就回失敗（訊息仍留在本機紀錄）。 */
    send(to: string, text: string): Promise<SendOutcome>;
    /** 拿掉和某人的整段對話（封鎖時用） */
    forget(peer: string): void;
}
//# sourceMappingURL=dm.d.ts.map