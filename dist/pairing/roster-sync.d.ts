import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from '../protocol/event.js';
import type { NostrSigner } from '../protocol/signer.js';
import { type PublishRejectionReport } from '../publish-rejections.js';
import { RelayEventBudget } from '../relay-budget.js';
import type { PublishDurability, RelayStatus, RelayTransport } from '../relay-pool.js';
import { type ReceivedRelayMove } from './relay-move.js';
import type { VaultMembership } from './roster.js';
/** 名單同步的內層 rumor kind（外層 1060 或 1059） */
export declare const VAULT_ROSTER_KIND = 4361;
/** 與檔案塊相同的外層 kind（不從 `./sync` 匯入，免得把同步零件拉進這個子路徑） */
declare const FILE_WRAP_KIND = 1060;
/** NIP-59 禮物包 */
declare const GIFT_WRAP_KIND = 1059;
/** 名單事件的外層 kind（SDK ADR 0043）：1060＝與檔案塊相同（預設，CinderSync 相容）；1059＝標準禮物包，不需要中繼開檔案事件 */
export type RosterOuterKind = typeof GIFT_WRAP_KIND | typeof FILE_WRAP_KIND;
export declare const DEFAULT_ROSTER_OUTER_KIND: RosterOuterKind;
export declare const DEFAULT_ROSTER_TTL_SECONDS: number;
/**
 * 「有未送出的名單變動」標記的持久化（SDK ADR 0045，G12d）。存一個布林值就好（例如 IndexedDB、`localStorage`）；
 * 不要存進會被同步出去的設定檔。
 */
export interface RosterPendingStore {
    load(): boolean | Promise<boolean>;
    save(pending: boolean): void | Promise<void>;
}
export interface NostrRosterSyncOptions {
    /** `RelayPool` 直接符合；有 `onStatusChange` 時 `retryOnReconnect` 才有作用 */
    pool: RelayTransport & {
        onStatusChange?(listener: (url: string, status: RelayStatus) => void): () => void;
    };
    signer: NostrSigner;
    membership: VaultMembership;
    ttlSeconds?: number;
    /** 訂閱起點（秒）；自動往前退讓 NIP-59 的兩天倒填窗 */
    since?: number;
    now?: () => number;
    /** 送出失敗等錯誤 */
    onError?: (error: unknown) => void;
    /**
     * 有中繼拒收時回報（SDK ADR 0038 P0-C），每位收件人的事件一次。成功照舊以「每位收件人至少一座收下」判斷。
     */
    onPublishRejected?: (report: PublishRejectionReport) => void;
    /**
     * 耐久度要求（SDK ADR 0041）：每位收件人的名單事件要至少 `minAccepted` 座耐久收下（借用不算）才算送出；
     * 不足時只有給了 `standby` 才會延遲連上備援補發。省略＝v0.32 的判斷（至少一座收下）。
     */
    durability?: PublishDurability;
    /**
     * 外層 kind（SDK ADR 0043）：預設 1060（v0.34 以前的唯一選擇，CinderSync 相容）。1059＝標準 NIP-59 禮物包，
     * 給不收 1060 的中繼（`blocked: files-disabled:`）。**同一份名單的每一台都要用同一個值**。
     */
    outerKind?: RosterOuterKind;
    /**
     * 每分鐘最多發幾顆（SDK ADR 0043）。指定了就用自己的預算；省略＝與同一身分的 PeerNode、Vault 同步共用
     * `sharedRelayEventBudget(signer.pubkey)`（預設每分鐘 100）。滿載一次是 31 顆。
     */
    eventsPerMinute?: number;
    /** 直接指定預算；優先於 `eventsPerMinute` */
    relayBudget?: RelayEventBudget;
    /**
     * 送不出去的名單變動（SDK ADR 0045，G12d）：任何一次送給全部成員的 `announce()`（名單變動自動觸發、`start()` 的宣告）
     * 有收件人沒送到，就記成 `pending`；之後一次完整送達才清掉。給了 `pendingStore` 時標記跨重開。
     * `retryOnReconnect: true`：連線池回報任何一座變回 `open` 時自動重送整份名單（預設 false＝v0.35 的行為，只記不送；
     * 應用可以在自己的時機呼叫 `retryPending()`）。
     */
    pendingStore?: RosterPendingStore;
    retryOnReconnect?: boolean;
    /**
     * 開自己的訂閱（預設 true）。`false`：不訂閱，事件由應用以 `ingestEvents` 餵進來（SDK ADR 0082）——
     * 外層同為 1060 時接 Vault 傳輸層的 `onOtherEvent`，中繼就不會把同一批檔案塊回兩次。收送名單變動、宣告照舊。
     */
    subscribe?: boolean;
    /**
     * 收到中繼搬家通知（SDK ADR 0052；內層 kind 4363，與名單同一個訂閱、同一個外層）。只交出寄件人是本機名單上**有效成員**的；
     * 要不要採用（替換清單裡的舊網址、先測試新網址）由應用決定，見 `planRelayMoves`。同一顆事件只交一次。
     */
    onRelayMove?: (move: ReceivedRelayMove) => void;
    /**
     * 收到本機名單上**有效成員**寄的名單或搬家通知（SDK ADR 0053 §G17）：交出寄件人與寄出時間（毫秒），例如交給
     * 協調器的 `notePeerActivity(deviceId, at)`，「最後一次看到它」就含名單訊息。補拉到的舊事件交出的是當時的寄出時間。
     * 同一顆事件只交一次。
     */
    onMemberActivity?: (activity: RosterMemberActivity) => void;
}
/** `onMemberActivity` 交出的動靜 */
export interface RosterMemberActivity {
    /** 寄件人（seal 簽章者）的公鑰 */
    readonly pubkey: string;
    /** 名單上它的 deviceId（找不到時沒有） */
    readonly deviceId?: string;
    /** 寄出的時間（毫秒） */
    readonly at: number;
}
/** 把完整名單包成給每位收件人的事件 */
export declare function buildRosterEvents(membership: VaultMembership, signer: NostrSigner, recipients: readonly string[], opts?: {
    now?: number;
    ttlSeconds?: number;
    outerKind?: RosterOuterKind;
}): NostrEvent[];
/**
 * 給被撤銷的裝置的通知（SDK ADR 0105）：一份精簡名單，只有它自己的撤銷紀錄與舊金鑰。
 * `excludeKeyIds`：它拿不到的金鑰（撤銷時輪換出來的新金鑰）。它不在撤銷紀錄裡、或扣掉之後沒有金鑰可放（名單格式至少要一把）時回 null。
 */
export declare function buildRevocationNotice(membership: VaultMembership, signer: NostrSigner, revoked: string, opts: {
    excludeKeyIds: readonly string[];
    now?: number;
    ttlSeconds?: number;
    outerKind?: RosterOuterKind;
}): NostrEvent | null;
/**
 * 解開名單事件；不是名單、解不開、格式不對、外層不是 `outerKind`（預設 1060）回 null
 *（不驗寄件人是否為成員，那是 `merge` 的事）
 */
export declare function openRosterEvent(event: Event | NostrEvent, signer: NostrSigner, opts?: {
    outerKind?: RosterOuterKind;
}): {
    sender: string;
    roster: unknown;
    sentAt: number;
} | null;
/** 名單的收送。`start()` 後，名單變動會自動送出；收到其他成員的名單會自動合併。 */
export declare class NostrRosterSync {
    #private;
    constructor(opts: NostrRosterSyncOptions);
    /** 這個同步器用的外層 kind */
    get outerKind(): RosterOuterKind;
    /** 有沒有送不出去、還沒完整送達的名單變動（SDK ADR 0045，G12d） */
    get pending(): boolean;
    /** 訂閱、開始監聽名單變動；`announce` 為 true（預設）時先把目前的名單送一次（給離線超過中繼保留期的成員補齊） */
    start(opts?: {
        announce?: boolean;
    }): void;
    stop(): void;
    /**
     * 有未送出的名單變動就重送整份名單（SDK ADR 0045，G12d）；回傳有沒有送。送不出去時 reject（標記留著）。
     * 同時呼叫共用同一次。
     */
    retryPending(): Promise<boolean>;
    /** 1059、1060 都是會被倒填時間的 kind：`since` 往前退讓兩天，連線池補訂閱時也會（G8，SDK ADR 0035） */
    filters(): Filter[];
    /** 補拉到的事件（例如 `FastHydrator`）走同一條路 */
    ingestEvents(events: readonly Event[]): void;
    /** 把目前的名單送給所有有效的其他成員（或指定的收件人）。依序送出；每位收件人至少一座中繼接受才算成功。 */
    announce(recipients?: readonly string[]): Promise<void>;
}
export {};
//# sourceMappingURL=roster-sync.d.ts.map