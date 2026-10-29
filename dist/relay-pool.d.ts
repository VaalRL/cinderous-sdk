/**
 * 多 Relay 連接池（SDK ADR 0001；源自《沒當好爸爸》ADR 0007／0024）：對設定裡的每個 Relay 同時保持一條 WebSocket，
 * 發布送給全部、訂閱對全部下同一個 REQ、事件以 id 去重；哪一個斷了就按退避時間重連並補送訂閱，
 * 其他 Relay 照常服務，所以主力斷線時使用者無感。
 *
 * NIP-42：有給身分時，Relay 送 AUTH 挑戰就簽 kind 22242 回覆；認證成功後補送所有訂閱，
 * 認證前被「auth-required」擋下的發布重送一次。沒給身分就當匿名，要求認證的 Relay 會拒絕我們。
 *
 * 所有進站事件先驗簽章（Relay 不可信，ARCHITECTURE 伍節）。WebSocket 以介面注入，Node 測試用假的。
 */
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { type EdgeProbeFetch } from './edge-probe.js';
import type { Identity } from './identity.js';
import { type RelayDroppedNotice, type RelayRejectKind, type RelayRejectTraits } from './protocol/relay-reject.js';
import { type RelayHealthCooldowns, type RelayHealthMark, type RelayHealthResetFilter, type RelayHealthSnapshot } from './relay-health.js';
export { DEFAULT_RELAY_HEALTH_COOLDOWNS, relayDataPlaneOf, type RelayDataPlane, type RelayHealthCooldowns, type RelayHealthMark, type RelayHealthResetFilter, type RelayHealthScope, type RelayHealthSnapshot, type RelayHealthState, type RelayNearFull, } from './relay-health.js';
export { classifyPublishRejection, durabilityShortfall, meetsDurability, publishRejections, reportPublishRejections, type ClassifiedRejection, type PublishRejectionReport, } from './publish-rejections.js';
/**
 * `code`／`reason` 只有 `close` 事件才有（瀏覽器與 `ws` 都給；SDK ADR 0038 P0-C）。
 * 舊的注入實作不給也行：沒有關閉碼就當成一般的網路斷線。
 */
export type SocketListener = (event: {
    readonly data?: string;
    readonly code?: number;
    readonly reason?: string;
}) => void;
/** 只用到的 WebSocket 子集 */
export interface SocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: SocketListener): void;
}
export type RelayStatus = 'connecting' | 'open' | 'closed';
/**
 * 某一座沒收下這次發布（SDK ADR 0038 P0-C）。`kind` 以後的欄位是 v0.32 加的：
 * `RelayPool` 一定會填；自訂的 `RelayTransport` 可能沒有，用 {@link classifyPublishRejection} 補回。
 */
export interface RejectedRelay {
    readonly url: string;
    /** 中繼給的原文（`OK false` 的第 4 欄），或 `timeout`／`not connected`／`disconnected…` */
    readonly reason: string;
    readonly kind?: RelayRejectKind;
    readonly retryable?: boolean;
    readonly tryOtherRelays?: boolean;
    /** 前綴後的英文詞元（只有 Cinderous／SDK 中繼會帶） */
    readonly token?: string;
}
export interface PublishResult {
    /** 收下的 Relay：回 OK true 的（含 `warning: borrowed:`），加上回 `duplicate:` 的（本來就有這顆，NIP-01） */
    readonly accepted: string[];
    /** 拒絕、逾時或沒連上的 Relay 與原因 */
    readonly rejected: RejectedRelay[];
    /**
     * `accepted` 裡只是「借用」收下的（`OK true "warning: borrowed:"`：溢位帶、短保存、最先淘汰；SDK ADR 0039／0041）。
     * 沒有借用時**沒有這個欄位**（v0.32 的結果形狀不變）。
     */
    readonly borrowed?: string[];
    /** 發布時帶了 `durability` 才有（SDK ADR 0041） */
    readonly durability?: DurabilityResult;
}
/**
 * 耐久度要求（SDK ADR 0038 研究結果四、ADR 0041）。不給＝v0.32 的行為（送給每一座開著的、至少一座收下算成功）。
 */
export interface PublishDurability {
    /**
     * 至少幾座**耐久收下**才算滿足：`OK true`、`duplicate` 算；`warning: borrowed:` 不算。預設 1（決策 6）。
     */
    readonly minAccepted?: number;
    /**
     * 備援中繼（不在 `urls` 裡）。收下數不足、而且拒收是「換別座有用」的分類時，依序**延遲連上**下一座、只補發這一則；
     * 閒置 `standbyIdleMs` 後斷線，不加進常駐訂閱（除非 `standbySubscribe`）。省略＝不自動連備援（決策 6）。
     */
    readonly standby?: readonly string[];
    /**
     * 主要中繼**一座都沒開**（只是沒連線，不是拒收或已滿）時要不要改用備援（SDK ADR 0078）。預設 true（之前的行為）。
     * 排程連線的應用（例如兩輪之間刻意斷線）請設 false：照實回報沒送到、讓呼叫端記成待送，下次連上主要中繼再送——
     * 否則兩輪之間的發布全部只落在備援上，沒設同一座備援的裝置永遠收不到。主要中繼開著但拒收、已滿時照舊改用備援。
     */
    readonly standbyWhenDisconnected?: boolean;
}
export interface PublishOptions {
    readonly durability?: PublishDurability;
    /**
     * 只送給這幾座（SDK ADR 0067：收件確認只送給宣告了 `cinder_inbox_ack` 的中繼）。不在池裡的忽略；結果只列這幾座。
     * 給了就不走 `durability` 的路徑（不看健康狀態、不用備援）。只收兩個參數的自訂傳輸層會忽略它、照舊送給全部。
     */
    readonly relays?: readonly string[];
}
/**
 * 一座中繼對這次發布的結果（`durability.relays`）：`skipped`＝健康狀態標記了（已滿、不適用、退避中），這次沒送；
 * `not-connected`＝沒連上（備援連不上也是）。
 */
export type RelayPublishOutcome = 'accepted' | 'duplicate' | 'borrowed' | 'rejected' | 'timeout' | 'skipped' | 'not-connected';
export interface RelayPublishState {
    readonly url: string;
    readonly standby: boolean;
    readonly outcome: RelayPublishOutcome;
    readonly kind?: RelayRejectKind;
    readonly reason?: string;
    /** `skipped`：標記到什麼時候（毫秒） */
    readonly until?: number;
}
export interface DurabilityResult {
    readonly minAccepted: number;
    /** 耐久收下的中繼（不含借用） */
    readonly durable: readonly string[];
    readonly satisfied: boolean;
    /** 這次延遲連上、送了這一則的備援 */
    readonly standbyUsed: readonly string[];
    /**
     * 沒滿足，而且其餘每一座都是「滿了」（`ceiling`／`quota`、因此被略過、或只借用）：
     * 應用該回報一次、長退避，不要一直重試（ADR 0038 §4，比照 ADR 0027）。
     */
    readonly relaysFull: boolean;
    /** 每一座的結果（主要中繼依 `urls` 順序，接著是用到的備援） */
    readonly relays: readonly RelayPublishState[];
}
/** `queryEach` 每一座的結果（SDK ADR 0041） */
export interface RelayQueryResult {
    readonly url: string;
    /** `eose`＝完整回完；`closed`＝被中繼 `CLOSED`；`timeout`／`disconnected`／`not-connected`＝不知道這座有沒有 */
    readonly status: 'eose' | 'closed' | 'timeout' | 'disconnected' | 'not-connected';
    readonly reason?: string;
    /** 這一座回的事件（已驗簽、這一座內去重） */
    readonly events: readonly Event[];
}
/** `queryResult` 的一座（SDK ADR 0045）：狀態同 {@link RelayQueryResult}，不含那一座的事件 */
export interface RelayQueryStatus {
    readonly url: string;
    readonly status: RelayQueryResult['status'];
    readonly reason?: string;
    /** 只讀的中繼（`readUrls`，SDK ADR 0054）：不算進 `answered` */
    readonly read?: true;
}
/**
 * `queryResult` 的結果（SDK ADR 0045，G12a）：`answered`＝完整回了 EOSE 的中繼數。
 * `answered === 0`＝**沒有任何一座查完**（都沒開、逾時、被 CLOSED、查到一半斷線）——不是「查完但沒結果」，
 * 依查詢結果推進游標或水位的程式碼此時不得推進。
 */
export interface RelayQueryOutcome {
    /** 去重、驗過簽、依 `created_at` 由新到舊（與 `query` 相同） */
    readonly events: Event[];
    readonly answered: number;
    /** 每一座的狀態（依 `urls` 順序） */
    readonly relays: readonly RelayQueryStatus[];
}
export interface QueryEachOptions {
    readonly timeoutMs?: number;
    /** 要查哪幾座；預設 `urls`。不在 `urls` 裡的當備援延遲連上（查完閒置斷線） */
    readonly relays?: readonly string[];
}
/** `onRelayDropped` 的內容（SDK ADR 0042） */
export interface RelayDroppedReport extends RelayDroppedNotice {
    readonly url: string;
}
/** 中繼的一次拒收（`onRelayReject`；SDK ADR 0038 P0-C） */
export interface RelayRejection extends RelayRejectTraits {
    /**
     * `ok`＝某次發布的 `OK false`；`closed`＝訂閱被 `CLOSED`；`notice`＝帶前綴的 `NOTICE`；`close`＝中繼以關閉碼斷線；
     * `probe`＝連線池自己探測出來的（SDK ADR 0125）：連不上時主機有回應、回答的卻不是中繼（`token: 'edge'`）
     */
    readonly source: 'ok' | 'closed' | 'notice' | 'close' | 'probe';
    readonly kind: RelayRejectKind;
    readonly reason: string;
    readonly token?: string;
    readonly eventId?: string;
    readonly subId?: string;
    /** WebSocket 關閉碼（`source: 'close'`） */
    readonly code?: number;
}
/**
 * 連不上時的邊緣探測（SDK ADR 0125）。Cloudflare 的每日請求數用完時，邊緣直接回 1027、Worker 沒執行，
 * 送不出 1013；瀏覽器只看得到 1006。連線池在「還沒連上就斷」連續發生時抓兩次 NIP-11（見 `probeRelayEdge`），
 * 判定是邊緣代答就當成 1013：回報 `onRelayReject`（`source: 'probe'`、`kind: 'unavailable'`、`token: 'edge'`）、
 * 整座標成暫時不能用、重連等到標記過期。
 */
export interface EdgeProbeOptions {
    /** 預設 `globalThis.fetch` */
    readonly fetch?: EdgeProbeFetch;
    /** 連續幾次「還沒連上就斷」才探測；預設 2 */
    readonly afterFailures?: number;
    /** 同一座兩次探測至少隔多久（毫秒）；預設 5 分鐘 */
    readonly minIntervalMs?: number;
}
export interface SubscriptionHandlers {
    onEvent(event: Event, relayUrl: string): void;
    /** 第一個 Relay 送 EOSE 時叫一次 */
    onEose?(): void;
}
export interface Subscription {
    close(): void;
}
/**
 * NIP-59 外層時戳最多被往前推多久（秒）：兩天。與 `protocol/nip59` 的 `TIMESTAMP_JITTER_SECONDS` 是同一個數字
 * （測試釘住兩者相等；這裡不直接匯入，免得只用連線池的應用把封裝程式也拉進來）。
 * 規範：NIP-59「created_at … should be tweaked … up to two days in the past」。
 */
export declare const NIP59_MAX_BACKDATE_SEC: number;
/**
 * 外層時戳可能被往前推的 kind（SDK ADR 0035）：1059＝NIP-59／NIP-17 禮物包，1060＝SDK 的檔案塊、Vault 同步訊息、
 * 裝置名單的外層。另外所有帶 `#p` 的 filter（收件匣類：通話信令 21002、SDP 21000 等也是禮物包）一律視為可能被回溯。
 */
export declare const BACKDATED_KINDS: readonly number[];
export interface SubscribeOptions {
    /**
     * 重新連上時補訂閱的 `since` 要比游標再往前退讓多少秒（SDK ADR 0035）。
     * 省略＝自動判斷：kinds 含 {@link BACKDATED_KINDS} 或帶 `#p` 的 filter 退讓 {@link NIP59_MAX_BACKDATE_SEC}，其他照原游標。
     * 給數字＝這個訂閱的每一個 filter 都退讓這麼多；0＝完全不退讓（呼叫端自己處理）。
     */
    readonly backdateWindowSec?: number;
}
/** 這個 filter 收的事件，外層時間可能被往前推（NIP-59）嗎 */
export declare function isBackdatableFilter(filter: Filter): boolean;
/**
 * 補訂閱時某個 filter 的 `since`：游標（看過最新的 created_at）減去回溯窗，但不比 filter 原本的 `since` 早。
 * 回溯窗：呼叫端宣告的優先，否則依 {@link isBackdatableFilter} 自動判斷。
 */
export declare function resumeSince(filter: Filter, cursor: number, backdateWindowSec?: number): number;
/** 上層（大廳、聊天、私訊）只依賴這兩個方法；測試用假的傳輸層取代整個池 */
export interface RelayTransport {
    /** `options` 是 v0.33 新增的（SDK ADR 0041）；只收一個參數的自訂傳輸層照樣符合這個介面（會忽略耐久度要求） */
    publish(event: Event, options?: PublishOptions): Promise<PublishResult>;
    /** `options` 是 v0.30 新增的（SDK ADR 0035）；只收兩個參數的自訂傳輸層照樣符合這個介面 */
    subscribe(filters: Filter[], handlers: SubscriptionHandlers, options?: SubscribeOptions): Subscription;
}
export interface RelayPoolOptions {
    /** 依優先順序列出的 Relay（主力在前） */
    readonly urls: readonly string[];
    /** 回應 NIP-42 AUTH 挑戰用的身分；省略就不認證 */
    readonly identity?: Pick<Identity, 'sign'>;
    /** 預設 `new WebSocket(url)` */
    readonly createSocket?: (url: string) => SocketLike;
    /** 重連退避（毫秒），用完就一直用最後一段 */
    readonly reconnectDelaysMs?: readonly number[];
    /**
     * 連線撐過這段時間（毫秒）才斷，退避才歸零。Relay 對限速或錯誤路徑是
     * 「接受連線、送 NOTICE、立刻關閉」（Cinderous ADR-0368）；一開啟就歸零的話，那會變成
     * 每 0.5 秒一次的迴圈，很快撞上車道每個 IP 每分鐘 30 條新連線的限速。預設 30 秒。
     */
    readonly reconnectStableMs?: number;
    /**
     * Relay 回報的問題：非 auth-required 的 CLOSED（例如 restricted）與 NOTICE。
     * auth-required 不回報——認證成功後會自動補送。用途是記錄，讓「這個 Relay 不回這個訂閱」
     * 查得到原因，不影響其他 Relay。
     */
    readonly onRelayProblem?: (url: string, reason: string) => void;
    /**
     * 結構化的拒收回報（SDK ADR 0038 P0-C）：每一座的 `OK false`（不含 `duplicate`）、訂閱被 `CLOSED`、
     * 帶 NIP-01 前綴的 `NOTICE`、以及中繼以關閉碼斷線（1008 限速、4003 白名單外…）。
     * **部分拒收**（有的中繼收、有的拒）也從這裡看得到——`publish` 的結果只要有一座收下，上層通常就當成功。
     * 一般的網路斷線（沒有關閉碼）不算拒收，不回報。
     */
    readonly onRelayReject?: (url: string, rejection: RelayRejection) => void;
    /**
     * 中繼說有幾則寄給你、還沒送到的留言在它那裡被刪掉了（FIFO、天花板淘汰、借用到期；SDK ADR 0042）。
     * 在你讀自己的收件匣（`#p` 是自己的訂閱）時、那一座的 EOSE 之前來一次；中繼送出後就歸零。只有數量與時間範圍（寄件時間，
     * 禮物包的外層時間被往前推過，找回時要放寬兩天）。應用可以提示「有 N 則在這座中繼上遺失」，或向其他裝置索取。
     */
    readonly onRelayDropped?: (report: RelayDroppedReport) => void;
    readonly publishTimeoutMs?: number;
    /** 訂閱 id 的前綴（除錯時分得出是哪個應用開的）；預設 `cdr` */
    readonly subscriptionPrefix?: string;
    /** 進站訊框的位元組上限：超過就整框丟掉（擋惡意中繼塞爆記憶體）。省略＝不限 */
    readonly maxFrameBytes?: number;
    /** 連線多久沒開起來就放棄、照退避重連（毫秒）。省略＝一直等（交給瀏覽器） */
    readonly connectTimeoutMs?: number;
    /** 健康狀態的冷卻時間（SDK ADR 0041）；預設見 `DEFAULT_RELAY_HEALTH_COOLDOWNS` */
    readonly healthCooldowns?: RelayHealthCooldowns;
    /** 備援連線閒置多久斷線（毫秒）；預設 60 秒 */
    readonly standbyIdleMs?: number;
    /** 用到的備援也收常駐訂閱、不閒置斷線（預設 false：備援只用來補發） */
    readonly standbySubscribe?: boolean;
    /**
     * 「只訂閱、不寫入」的中繼（SDK ADR 0054；CinderSync G11）：與主要中繼一起 `connect()`、斷線照退避重連、收常駐訂閱，
     * `query`／`queryResult` 也查（`answered` 只算主要中繼）；**一般發布不寫給它們**，只有發布的 `durability.standby`
     * 列了它、而且主要中繼不夠時才補發（沿用這條連線）。用法：把備援中繼同時列在這裡與 `durability.standby`，
     * 別台補發到備援的訊息這台就讀得到。不經 `status()`／`onStatusChange`（「在線」只看主要中繼），狀態見 `relayHealth()`。
     * 已經在 `urls` 裡的忽略。
     */
    readonly readUrls?: readonly string[];
    /**
     * 每個訂閱最多記住幾個已收事件的 id（去重用；SDK ADR 0124）。超過就先忘最早收到的。
     * 平常用不到上限：補訂閱不會再重播、又收到超過 {@link SEEN_GRACE_MS} 的 id 本來就會定期忘掉。預設 50,000。
     */
    readonly maxSeenPerSubscription?: number;
    /**
     * 連不上時分辨「邊緣代答」與「網路斷了」（SDK ADR 0125）。預設：用預設的 WebSocket、而且有 `fetch` 時開啟；
     * 注入了 `createSocket`（測試或自訂傳輸）時預設關閉，要明確給一個物件才開。`false` 關閉。
     */
    readonly edgeProbe?: false | EdgeProbeOptions;
}
export declare const DEFAULT_RECONNECT_DELAYS_MS: readonly number[];
export declare const DEFAULT_RECONNECT_STABLE_MS = 30000;
export declare const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;
export declare const DEFAULT_STANDBY_IDLE_MS = 60000;
/** 每個訂閱預設最多記住幾個已收 id（SDK ADR 0124） */
export declare const DEFAULT_MAX_SEEN_PER_SUBSCRIPTION = 50000;
/** 每收幾則新事件整理一次訂閱的去重表（SDK ADR 0124） */
export declare const SEEN_PRUNE_EVERY = 1024;
/** 連續幾次「還沒連上就斷」才做邊緣探測（SDK ADR 0125） */
export declare const DEFAULT_EDGE_PROBE_AFTER_FAILURES = 2;
/** 同一座兩次邊緣探測至少隔多久（毫秒；SDK ADR 0125）：每次花兩個 HTTP 請求，額度用完時也是請求 */
export declare const DEFAULT_EDGE_PROBE_INTERVAL_MS: number;
/** 探測判定邊緣代答時回報的原因（SDK ADR 0125） */
export declare const EDGE_ANSWERED_REASON = "edge: the relay host answered, but not the relay (most likely its host daily request quota, e.g. Cloudflare error 1027; resets around 00:00 UTC)";
/**
 * 收到之後至少記住多久（毫秒；SDK ADR 0124）：一次載入歷史時，別座晚幾分鐘才送到的同一則照樣去重。
 * 過了這段時間、而且早於補訂閱的 `since`（{@link resumeSince}）的才會忘——補訂閱不會再重播那些。
 */
export declare const SEEN_GRACE_MS: number;
/** 一次性查詢的逾時以「多久沒有新資料」計，最長延到逾時的幾倍（SDK ADR 0077） */
export declare const QUERY_MAX_EXTENSION = 12;
export declare class RelayPool implements RelayTransport {
    #private;
    constructor(options: RelayPoolOptions);
    /** 對每個 Relay 開連線；之後斷線會自動重連，直到 `close()`。 */
    connect(): void;
    /** 關掉全部連線並停止重連。 */
    close(): void;
    status(): ReadonlyMap<string, RelayStatus>;
    /**
     * 換掉（或拿掉）回應 NIP-42 的身分。給應用「先開連線池、之後才知道玩家金鑰」用：
     * 已經收過挑戰、還沒認證的連線會立刻補回覆。傳 null 之後就當匿名，不再回應新的挑戰。
     */
    setAuthIdentity(identity: Pick<Identity, 'sign'> | null): void;
    onStatusChange(listener: (url: string, status: RelayStatus) => void): () => void;
    /**
     * 送給所有開著的 Relay；每個 Relay 的 OK／拒絕／逾時都整理進結果。
     *
     * 帶 `durability`（SDK ADR 0041）時：略過健康狀態標記的中繼（已滿、不適用、退避中）；耐久收下數（不含借用）
     * 不足 `minAccepted`、拒收又是「換別座有用」的分類時，依序延遲連上 `standby` 並只補發這一則。
     * 不帶就是 v0.32 的行為，結果形狀也相同。
     */
    publish(event: Event, options?: PublishOptions): Promise<PublishResult>;
    /**
     * 每座中繼（主要與用過的備援）的健康狀態（SDK ADR 0041）：依拒收分類記下的標記、最近一次拒收／收下／借用。
     * 只存在記憶體（不持久化）；過期的標記不列出。
     */
    relayHealth(): ReadonlyMap<string, RelayHealthSnapshot>;
    /** 健康狀態變了（新標記、標記清掉、備援連上或斷線）；同一個標記只是延長不通知。回傳取消函式 */
    onRelayHealthChange(listener: (url: string, health: RelayHealthSnapshot) => void): () => void;
    /**
     * 清掉某座（或全部）的標記：站方改了設定之後。`filter` 只清某個範圍或某種狀態（例如 `{ scope: 'kind:1060' }`；SDK ADR 0044）。
     * 手上有新讀到的 NIP-11 時，優先用 {@link revalidateRelay}——它只清文件看得出已不成立的那些。
     */
    resetRelayHealth(url?: string, filter?: RelayHealthResetFilter): void;
    /**
     * 重新讀到某座的 NIP-11 之後重新驗證它的「不適用」標記（SDK ADR 0044）：文件表示原因已不成立的立刻清掉、
     * 經 `onRelayHealthChange` 通知（有清才通知），回傳清掉的標記。`info` 收原始 NIP-11 文件或 `fetchRelayFilePolicy` 的結果。
     *
     * 看得出來的：`files-disabled` ＋ `cinder_accepts_files: true`；`too-large`（檔案塊除外）＋ 宣告的上限不小於被拒的那顆；
     * `not-allowed` ＋ `limitation.restricted_writes: false`。其餘（kind 停用、已滿、限速、整座被拒）不動。
     * `observedAt`（預設現在）是讀到文件的時間：之後才出現的標記不清（文件與實際不符時不會每則都清掉重試）。
     * `watchRelayFileLimits` 每次讀 NIP-11 都會呼叫它（預設每 30 分鐘重讀一次）。
     */
    revalidateRelay(url: string, info: unknown, options?: {
        observedAt?: number;
    }): RelayHealthMark[];
    /** 讀回稽核發現某座弄丟了自己的事件：把那一類資料標成已滿一段時間（ADR 0038 M4） */
    markEvicted(url: string, eventKind: number): void;
    /**
     * 這一類事件實際會寫到哪幾座（SDK ADR 0038 §6）：沒被標記的主要中繼（不論現在連線與否），加上連著的備援。
     * `loadRelayFileLimits(pool.writeSet(1060))` 就是對實際寫入的那組取最小值。
     */
    writeSet(eventKind: number, bytes?: number): string[];
    /** 對每個 Relay 下同一個 REQ（之後才連上的也會補），事件以 id 去重、先驗簽。 */
    subscribe(filters: Filter[], handlers: SubscriptionHandlers, options?: SubscribeOptions): Subscription;
    /**
     * 逐座探針（SDK ADR 0003）：只對 `url` 那一座送一個小查詢，量到 EOSE 的往返時間（毫秒）。
     * 用來判斷「連得上但不轉發」的站。filter 要帶範圍（例如 `#t`），否則車道會 `CLOSED restricted`。
     * 沒連上、被 CLOSED、逾時或中途斷線都 reject。
     */
    ping(url: string, filters: Filter[], timeoutMs?: number): Promise<number>;
    /**
     * 跳過退避，立刻重連這一座（已經開著或正在連就不動）。給應用的健康探針用：
     * 探針本身是定期的，不該被退避擋住（SDK ADR 0004）。
     */
    reconnectNow(url: string): void;
    /** 最近一次從這一座收到任何訊息的時間（毫秒）；沒收過是 null。有流量的站就不必探 */
    lastActivityAt(url: string): number | null;
    /**
     * 一次性查詢（SDK ADR 0005）：對每一座開著的站送同一個 REQ，**全部**回 EOSE（或被 CLOSED、斷線）
     * 才回；逾時就帶著已收到的回。結果以 id 去重、先驗簽，依 `created_at` 由新到舊。
     * 還沒有任何一座開起來時，先等第一座開起來（同一個逾時內）。
     */
    query(filters: Filter[], timeoutMs?: number): Promise<Event[]>;
    /**
     * 與 `query` 相同的一次性查詢，另外回報每一座的狀態與「幾座完整回完」（SDK ADR 0045，G12a）。
     * `query` 在一座都沒開、或查到一半全部斷線時也回空陣列，分不出「查完了、沒有」與「根本沒查到」；
     * 依結果推進游標的程式碼（分頁補拉、喚醒時的增量）請用這個，`answered === 0` 時不推進。
     */
    queryResult(filters: Filter[], timeoutMs?: number, options?: {
        readonly waitForPrimary?: boolean;
    }): Promise<RelayQueryOutcome>;
    /**
     * 逐座查詢（SDK ADR 0041，讀回稽核用）：與 `query` 相同的 REQ，但每一座的結果分開回，
     * 看得出「哪一座少了哪些」，也分得出「這座回完了、沒有」（`eose`）與「不知道」（`timeout`、`closed`…）。
     * 還沒開的主要中繼等到開（同一個逾時內）；`relays` 裡不在 `urls` 的當備援延遲連上，查完閒置斷線。
     */
    queryEach(filters: Filter[], options?: QueryEachOptions): Promise<RelayQueryResult[]>;
    /** 這一座是否已通過 NIP-42 認證 */
    isAuthenticated(url: string): boolean;
}
//# sourceMappingURL=relay-pool.d.ts.map