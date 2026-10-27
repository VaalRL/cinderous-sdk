import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { PubkeyHex } from '../../protocol/keys.js';
import type { NostrSigner } from '../../protocol/signer.js';
import { type PublishRejectionReport } from '../../publish-rejections.js';
import { RelayEventBudget } from '../../relay-budget.js';
import type { PublishDurability, RelayStatus, RelayTransport } from '../../relay-pool.js';
import { type HydratorPool } from '../hydrator.js';
import type { VaultSendOptions, VaultSyncMessage, VaultSyncTransport } from './types.js';
/** 協調器訊框的內層 rumor kind（外層仍是 1060）。舊客戶端不認得，直接略過。 */
export declare const VAULT_OP_KIND = 4360;
/** 每個訊框的位元組上限（明文），與檔案塊相同 */
export declare const VAULT_FRAME_BYTES = 48000;
/** 中繼保留多久（秒）：與檔案塊相同，7 天 */
export declare const DEFAULT_VAULT_TTL_SECONDS: number;
/** 補拉每一頁的逾時（以「多久沒有新資料」計；SDK ADR 0077）：實測中繼準備 151 則／15.9 MB 的一頁要約 8 秒才送出第一則 */
export declare const BACKFILL_PAGE_TIMEOUT_MS = 30000;
/**
 * 一則訊息最多幾個訊框（收端防禦）：經中繼的絕對上限（64 MiB）的內容＋1 MiB 標頭 ⇒ 1,420 個。
 * v0.24 以前以 16.5 MB 為準（381 個）；30 MB 的檔案要 656 個（SDK ADR 0029）。
 */
export declare const VAULT_MAX_FRAMES: number;
/** RelayPool 直接符合；只要 publish／subscribe，有 status 就用來判斷線上與否 */
export interface VaultRelayPool extends RelayTransport {
    status?(): ReadonlyMap<string, RelayStatus>;
    onStatusChange?(listener: (url: string, status: RelayStatus) => void): () => void;
    /** 每一座（含只讀的備援）的健康狀態（`RelayPool.relayHealth`）；改用備援（`setStandbyFallback`）時用來看備援開著沒有 */
    relayHealth?(): ReadonlyMap<string, {
        readonly status: RelayStatus;
    }>;
    onRelayHealthChange?(listener: (url: string, health: {
        readonly status: RelayStatus;
    }) => void): () => void;
    /** 一次性查詢（`RelayPool.query`）。有的話，啟動與重新連上時以 `until` 分頁補拉歷史（SDK ADR 0029） */
    query?: HydratorPool['query'];
    /**
     * 回報幾座回完的查詢（`RelayPool.queryResult`，SDK ADR 0045）。有的話，沒有任何中繼回完的補拉不推進起點。
     * 只有 `query` 時退而看 `status()`：查完時一座都沒開就當作沒回完（查到一半斷線又連上的分不出來）。
     */
    queryResult?: HydratorPool['queryResult'];
}
export interface NostrVaultTransportOptions {
    pool: VaultRelayPool;
    /** 這台裝置的身分（例如 `Identity`；不交出私鑰，SDK ADR 0023） */
    signer: NostrSigner;
    /** 同一個 Vault 其他裝置的公鑰。幾台裝置共用同一把身分時，也把自己的公鑰放進來 */
    devices: readonly PubkeyHex[];
    /** 只接受這些寄件人；預設 `devices` 加上自己 */
    trusted?: readonly PubkeyHex[];
    /**
     * 寄件公鑰 → 它的協調器 deviceId（SDK ADR 0028，例如 `(pk) => membership.deviceIdOf(pk)`）。給了就檢查訊息的
     * `from` 必須是寄件人自己的 deviceId，對不上的丟掉：名單上的一台裝置不能冒用另一台的 deviceId。
     */
    deviceOf?: (pubkey: PubkeyHex) => string | undefined;
    ttlSeconds?: number;
    /** 訂閱起點（秒，通常是上次同步的時間）；會自動往前退讓 NIP-59 的時間倒填窗 */
    since?: number;
    /** 現在時間（毫秒） */
    now?: () => number;
    /**
     * 補拉歷史最多翻幾頁（SDK ADR 0029）；預設 `DEFAULT_MAX_PAGES`。0＝不補拉（只靠常駐訂閱，v0.24 的行為）。
     * 只有 `pool.query` 存在時才會補拉。
     */
    backfillPages?: number;
    /**
     * 補拉每一頁的逾時（毫秒，以「多久沒有新資料」計，SDK ADR 0077）；預設 {@link BACKFILL_PAGE_TIMEOUT_MS}。
     * 中繼準備一頁大的收件匣（約 16 MB 的檔案塊）要好幾秒才送出第一則，連線池預設的 5 秒會在送出前就放棄。
     */
    backfillTimeoutMs?: number;
    /**
     * 有中繼拒收時回報（SDK ADR 0038 P0-C），每一則事件一次。送出成功與否照舊以「至少一座收下」判斷；
     * 這裡讓應用看得到部分拒收（例如三座裡一座滿了）。全部拒收時 `send` 照舊丟錯誤，這裡也會先報一次。
     */
    onPublishRejected?: (report: PublishRejectionReport) => void;
    /**
     * 耐久度要求（SDK ADR 0041）：每一顆要至少 `minAccepted` 座**耐久收下**（借用不算）才算送出；
     * 不足時只有給了 `standby` 才會延遲連上備援補發那一顆。中繼（含備援）都滿了時丟 `RelaysFullError`，
     * 協調器回報一次 `status().blocked = 'relays-full'` 並長退避。省略＝v0.32 的判斷（至少一座收下）。
     * 建議 `standby` 放一座也列在其他裝置 `relayUrls` 裡的中繼（否則別台讀不到）。
     */
    durability?: PublishDurability;
    /**
     * 每分鐘最多發幾顆（SDK ADR 0043）。指定了就用這個傳輸層自己的預算；省略＝與同一身分的 PeerNode、名單同步共用
     * `sharedRelayEventBudget(signer.pubkey)`（預設每分鐘 100）。一則 30 MB 的版本訊息是 656 顆 × 每台裝置，所以會分好幾分鐘送完，
     * 而不是送到第 121 顆被中繼以 `rate-limited: events:` 拒收。
     */
    eventsPerMinute?: number;
    /** 直接指定預算；優先於 `eventsPerMinute` */
    relayBudget?: RelayEventBudget;
    /** 中繼的 NIP-11 文件：有 `cinder_max_events_per_minute` 就自動取「宣告值 × 0.8」與目前速率的較小者 */
    relayInfo?: unknown;
    /**
     * 收件確認（SDK ADR 0067）：處理完的包請中繼提早清掉。預設開；`false`＝不送。
     * 只送給 `inboxAckRelays`（宣告了 `cinder_inbox_ack` 的那幾座）；一座都沒有就不送。
     */
    inboxAck?: boolean;
    /**
     * 宣告了收件確認的中繼（SDK ADR 0067 §2），通常是 `inboxAckRelays(policies)`（`watchRelayFileLimits` 的 `onLimits` 第三個參數）。
     * 執行中可用 `setInboxAckRelays` 更新。省略＝還不知道，處理完的 id 先留著。
     */
    inboxAckRelays?: readonly string[];
    /** 累積滿幾個就送一則確認（1–{@link INBOX_ACK_MAX_IDS}；預設 {@link INBOX_ACK_MAX_IDS}）。也是一則確認最多帶幾個 */
    inboxAckBatch?: number;
    /**
     * 解得開、但不是同步訊框的外層事件（例如外層同為 1060 的名單、中繼搬家通知；SDK ADR 0082）：交給應用，每顆只交一次。
     * 寄件人不論在不在信任名單上都交（剛配對的新裝置寄來的名單）——由接手的一方自己驗證。
     * 給 `NostrRosterSync({ subscribe: false })` 的 `ingestEvents`，名單同步就不必再開一個同樣的訂閱（中繼會把同一批檔案塊再回一次）。
     */
    onOtherEvent?: (event: Event) => void;
}
/** 收件確認：沒滿也在這麼久之內送出（毫秒；SDK ADR 0067 §3） */
export declare const INBOX_ACK_FLUSH_MS: number;
/** 把一則訊息切成訊框（純函式，測試與自訂傳輸層也可以用） */
export declare function frameVaultMessage(message: VaultSyncMessage, messageId?: string): string[];
/** 經 Nostr 中繼（kind 1060）收送協調器訊息。 */
export declare class NostrVaultTransport implements VaultSyncTransport {
    #private;
    constructor(opts: NostrVaultTransportOptions);
    /** 換成新的「宣告了收件確認的中繼」（SDK ADR 0067 §2）；有留著的確認就排一次送出 */
    setInboxAckRelays(urls: readonly string[]): void;
    /**
     * 現在就把處理完的 id 送出確認（SDK ADR 0067 §3）：每則最多 {@link INBOX_ACK_MAX_IDS} 個、只送給宣告了的中繼。
     * 沒有宣告的中繼、或沒有一座收下時留著下次再送。同時呼叫多次共用同一輪。平常不必呼叫：滿 500 個、
     * 每 5 分鐘、補拉完成、`stop()` 時都會自動送。
     */
    flushInboxAcks(): Promise<void>;
    /**
     * 換成新的裝置名單（SDK ADR 0028：配對加入、撤銷後由 `VaultMembership` 的 `change` 呼叫）。
     * 之後送出的訊息只給新名單上的裝置、只收新信任名單的寄件人；`trusted` 省略時＝`devices` 加上自己。
     */
    setDevices(devices: readonly PubkeyHex[], trusted?: readonly PubkeyHex[]): void;
    /** 訂閱 `{kinds:[1060], #p:[我]}`。 */
    start(): void;
    stop(): void;
    /** 給 `FastHydrator` 用的過濾條件（喚醒時補拉） */
    filters(): Filter[];
    /**
     * 以 `until` 分頁補拉離線期間的歷史（SDK ADR 0029），回傳拿到幾則。連上時（`start()` 時已經連上，或之後連上）會自動呼叫（SDK ADR 0080）。
     *
     * 為什麼常駐訂閱不夠：中繼一次 REQ 回傳的量有上限（Cinderous ADR-0371：16 MB，約 120 顆檔案塊），
     * 而且不會說被截斷了——離線一陣子回來、名下積了幾百塊時，訂閱只拿得到最新的那一段。
     * （v0.30 起連線池補訂閱時對 1060 自動往前退讓兩天，重連之後的即時事件不再被 since 擋掉（SDK ADR 0035）；
     * 但那一次 REQ 仍受中繼的位元組預算限制，離線期間積下來、被截掉的較舊事件要靠這裡分頁補齊。）
     * 沒有 `pool.query`（自訂的連線池）或 `backfillPages: 0` 時什麼都不做。
     *
     * 沒有任何中繼完成查詢（都沒開、逾時、查到一半全部斷線；SDK ADR 0045，G12a）時**不推進起點**，並以
     * `RelayQueryIncompleteError` reject（v0.35 以前會回 0 並把起點推到現在，之前的訊息永遠補不回來）。
     */
    backfill(): Promise<number>;
    /** 交給 `FastHydrator` 的 `onEvents`：補拉到的事件走同一條路（重複的會被去重） */
    ingestEvents(events: readonly Event[]): void;
    /**
     * 依 `options` 送（SDK ADR 0058）：給了 `deviceOf` 才做得到（收件人的公鑰要對得上協調器的 deviceId）——
     * `to` 只送給那些裝置、`omitContentFor` 對那些裝置拿掉內容（只帶版本資訊）。
     */
    get targeted(): boolean;
    /** 目前的收件裝置（deviceId；SDK ADR 0068）：給了 `deviceOf` 才知道 */
    recipients(): string[] | undefined;
    send(message: VaultSyncMessage, options?: VaultSendOptions): Promise<void>;
    onMessage(listener: (message: VaultSyncMessage) => unknown): () => void;
    onStatusChange(listener: (online: boolean) => void): () => void;
    isOnline(): boolean;
    /**
     * 主要中繼連不上時改用備援（SDK ADR 0093）：打開時「在線」也算開著的備援（只讀中繼）、送出時主要中繼沒連線也補發到備援、
     * 補拉時備援回完也算回完。應用在一輪同步發現主要中繼連不上、而且每台裝置都設了同一組備援時打開，這一輪結束就關掉——
     * 平常兩輪之間主要中繼只是沒連線，不該改送備援（SDK ADR 0078）。
     */
    setStandbyFallback(on: boolean): void;
}
/** 建立並開始訂閱。 */
export declare function createNostrVaultTransport(opts: NostrVaultTransportOptions): NostrVaultTransport;
//# sourceMappingURL=nostr-transport.d.ts.map