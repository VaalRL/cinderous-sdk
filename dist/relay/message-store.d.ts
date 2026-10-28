import type { NostrEvent } from "../protocol/index.js";
import type { RelayFilter } from "./protocol.js";
import { type DroppedSummary } from "./capacity.js";
/** 讀取事件的 NIP-40 過期時間（unix 秒）；無或非法時回 undefined。 */
export declare function getExpiration(event: NostrEvent): number | undefined;
export interface MessageStoreOptions {
    /** 每位收件人（`p` 標籤）保留的最大留言數，超量丟棄最舊。 */
    maxPerRecipient?: number;
    /**
     * 檔案塊（FILE_WRAP=1060，ADR-0162）每收件人配額——與聊天留言**分桶**，
     * 檔案塊絕不把聊天訊息擠出 FIFO。預設 {@link DEFAULT_FILE_PER_RECIPIENT}。
     */
    filePerRecipient?: number;
    /**
     * 留言壽命上限（秒；預設 7 天）。無 `expiration` 標籤的事件以此為預設 TTL、
     * 有標籤者也不得超過此上限——任何一列的壽命都有界，孤兒資料在數學上不可能（ADR-0065）。
     */
    maxTtlSeconds?: number;
    /**
     * 每 (pubkey, kind) 的可尋址位址數上限；預設 {@link ADDRESSABLE_MAX_PER_AUTHOR}（5）。
     *
     * 5 是為 ADR-0071 的「每人 5 台裝置」訂的——那個數字描述的是**裝置數**，
     * 不是「一個人能發布幾份可尋址資料」。第三方車道上一位玩家可能同時有多份牌組與
     * 多個 epoch 的世界快照，套 5 會在第 6 份就被拒（ADR-0366 P1 #7）。
     */
    addressablePerAuthor?: number;
    /**
     * 可尋址事件的壽命上限（秒）；預設 {@link ADDRESSABLE_TTL_SECONDS}（30 天）。
     * 自架的世界站可以拉長——挑戰窗的長度因此是**可調的營運參數**，不是協定限制。
     */
    addressableTtlSeconds?: number;
    /**
     * 單顆可尋址事件的位元組上限；預設 {@link ADDRESSABLE_MAX_BYTES}（256KB）。
     *
     * 256KB 是為 ADR-0071 的**加密雲端快照**訂的。第三方車道上的東西小得多
     * （一份牌組約 2KB、世界快照數十 KB），沿用 256KB 等於把「每分鐘能塞進多少位元組」
     * 放大八倍——而那個乘積就是塞爆一顆 DO 需要多久（ADR-0366 §容量二）。
     */
    addressableMaxBytes?: number;
    /**
     * **每個作者**的可尋址總位元組上限（跨所有 kind）；未設＝不限制。
     *
     * 🔴 為什麼需要它：{@link addressablePerAuthor} 的計數範圍是 **(pubkey, kind)**，
     * 而 NIP-33 的 kind 區間有一萬個、且由發送方自選 ⇒ 「每人每 kind 64 個」實際上是
     * 「每人 64 萬個」。沒有這一條，可尋址儲存對單一作者是無界的。
     *
     * ⚠ 它**擋不住換金鑰的人**（pubkey 不用錢）：真正的速率界線是每連線訊息上限
     * 乘上 {@link addressableMaxBytes}。這一條擋的是「單一身分無限累積」。
     */
    addressableBytesPerAuthor?: number;
    /**
     * **整顆 DO** 的可尋址總位元組天花板（ADR-0367 §決策 2）；未設＝不限制。
     *
     * 每作者總量擋不住換金鑰（pubkey 不用錢），所以還需要一道與身分無關的上限。
     * 超過時的行為由 {@link ceilingEvicts} 決定。
     */
    addressableMaxTotalBytes?: number;
    /**
     * 達到天花板時**淘汰最快到期者**（true）或**拒收新寫入**（false，預設）。兩張表共用。
     *
     * 🔴 嚴格平面一律 false：那裡的資料是使用者的加密雲端快照，ADR-0071 承諾
     * 「活躍即永久」——刪別人的備份不可逆，而拒收看得見。車道才用淘汰，
     * 而且「最快到期優先」讓見習中的資料天然排最前面（ADR-0367 §決策 1）。
     */
    ceilingEvicts?: boolean;
    /**
     * **整顆 DO** 的離線留言總位元組天花板（ADR-0367 §決策 2）；未設＝不限制。
     *
     * 🔴 為什麼 FIFO 不夠：`maxPerRecipient` 是每**收件人** 500 則，而收件人可以亂編；
     * 更早的一個缺口是**沒有 `p` 標籤的事件落在同一個「無收件人」桶裡，而 FIFO 根本
     * 不對它執行** ⇒ 那個桶只被 TTL 壓著。遊戲的房間／世界事件正是這個形狀。
     *
     * ⚠ 不要改用 `maxPerRecipient` 去補那個桶：一場對決約 20 顆持久化事件，500 只夠
     * 25 場 ⇒ 熱門車道的房間歷史會被默默丟掉。位元組天花板＋依到期淘汰才是對的形狀。
     */
    offlineMaxTotalBytes?: number;
    /**
     * **保底份額**（SDK ADR 0042；ADR 0038 P2）：共用 DO 內每個 key 的保底位元組。key＝可尋址的作者；
     * 離線留言的收件人（沒有 `p` 的列以作者計）。保底內的資料**不會因為別人寫入而被淘汰**；天花板滿了先淘汰超出保底的部分，
     * 沒有可淘汰的就拒收（`blocked: ceiling:`）。未設＝沒有保底（v0.33 行為）。
     *
     * 只在淘汰制（{@link ceilingEvicts}）生效：拒收制本來就不刪別人的資料。決策見 `capacity.ts`。
     */
    guaranteeBytes?: number;
    /**
     * **溢位帶**比例 r（SDK ADR 0042；ADR 0039 B1）：天花板 C 之上再收 C × r 的「借用」，保存 {@link borrowTtlSeconds}、永遠最先被淘汰，
     * 回 `OK true "warning: borrowed: …"`。未設或 0＝沒有溢位帶。淘汰制要同時設 {@link guaranteeBytes} 才生效。
     */
    overflowRatio?: number;
    /** 借用列的保存秒數；預設 `BORROW_TTL_SECONDS`（2 小時）。 */
    borrowTtlSeconds?: number;
    /** 溢位帶內每個 key 最多借多少位元組；預設帶子的 1/16。 */
    borrowPerKeyBytes?: number;
    /**
     * 可尋址事件能不能借用；預設可以。嚴格平面設 false（雲端快照 30078 等「活躍即永久」的備份不能變成 2 小時，ADR 0039 待決事項 3）。
     */
    addressableBorrows?: boolean;
    /**
     * **粗分級預警**（SDK ADR 0042；ADR 0038 P2 決策 5）：寫入後用量達天花板的這個百分比以上（以及 95％ 以上）時，
     * `OK true` 帶 `warning: near-full: <級>: …`。只有兩級、不公開精確用量。未設＝不預警。
     */
    nearFullPercent?: number;
    /**
     * **丟棄計數**（SDK ADR 0042；ADR 0038 M8）：因 FIFO、天花板淘汰、借用到期而刪掉寄給某位收件人的留言時，按收件人累計；
     * 收件人下次訂閱自己的收件匣時由中繼送一則 `NOTICE "warning: dropped: …"`。未設＝不計（v0.33 行為）。
     */
    countDrops?: boolean;
}
/** {@link OfflineStore.putResult} 的結果（SDK ADR 0042）：收下時可能是借用（`borrowedTtlSec`）或接近天花板（`nearFull`）。 */
export type OfflinePutResult = {
    readonly ok: true;
    readonly borrowedTtlSec?: number;
    readonly nearFull?: number;
} | {
    readonly ok: false;
    readonly reason: "expired" | "ceiling";
};
/** 預設留言壽命上限：7 天（對齊 client 端 gift wrap 的預設 TTL）。 */
export declare const DEFAULT_MAX_TTL_SECONDS: number;
/**
 * 單次查詢的回傳筆數硬上限（ADR-0235 C2）。客戶端每收件人最多 500 則
 * （`MAX_PER_RECIPIENT`），1024 已是兩倍餘裕。**這是把「一次 REQ 撈爆 DO 記憶體」
 * 變成不可能的那一行**——`OfflineStore` 的兩個實作都必須遵守。
 */
export declare const MAX_QUERY_ROWS = 1024;
/**
 * 單次 REQ 回傳的位元組上限（Cinderous ADR-0371 §決策 6）。
 *
 * 🔴 為什麼筆數上限不夠：{@link MAX_QUERY_ROWS} 是為聊天訂的（一則幾 KB）。檔案塊一顆約
 * 131KB，1024 顆就是 134MB——超過 DO 的 128MB 記憶體上限，DO 會在組回應的途中被重置，
 * 客戶端重連、再 REQ、再重置。16MB 約 120 顆檔案塊、上萬則聊天，後者碰不到它。
 * 超過的部分由客戶端依 NIP-01 以 `until` 分頁取回。
 */
export declare const MAX_QUERY_BYTES: number;
/** 有效筆數上限：尊重 `filter.limit`（NIP-01），但一律夾在 {@link MAX_QUERY_ROWS} 之內。 */
export declare function queryLimit(requested?: number): number;
/** 檔案塊外層 kind（ADR-0162）；**必須鏡射 core `KIND.FILE_WRAP`**（relay 不依賴 core runtime）。 */
export declare const FILE_WRAP_KIND = 1060;
/**
 * 加密雲端快照 kind（ADR-0071）；**必須鏡射 core `SNAPSHOT_KIND`**（同上，relay 不依賴 core runtime）。
 *
 * 為什麼這個常數存在：ADR-0071 的「只回給作者本人」原本是對**整個**可尋址區間
 * （30000–39999）生效的，而那個區間裡只有這一個 kind 是「加密給自己的私人快照」。
 * 其餘可尋址事件（第三方應用的公開資料）天生就是要給別人讀的，閘在那裡等於它們
 * 永遠只有作者看得到。⇒ 閘門收窄到這一個 kind（ADR-0366 §決策 5）。
 */
export declare const SNAPSHOT_KIND = 30078;
/**
 * 是否為「只有作者本人讀得到」的私人可尋址事件（ADR-0071 ／ ADR-0366 §決策 5）。
 *
 * ⚠ **不要**改回 {@link isAddressableKind}——那是 NIP-33 的**儲存語意**（取代規則），
 * 與「誰讀得到」是兩件事。混用會讓每一個新的可尋址 kind 都默默變成作者專屬。
 */
export declare function isAuthorOnlyKind(kind: number): boolean;
/**
 * 這顆可尋址事件是不是「清除」（Cinderous ADR-0071 purge）：**只有快照**的空 content 才是。
 *
 * 關閉雲端備份時「已關閉」必須立即為真，所以快照用空 content 表示「刪掉我這台的那份」。
 * 但這條約定原本套在**所有**可取代／可尋址 kind 上，而 NIP-17 的 10050、NIP-65 的 10002、
 * NIP-02 的 kind 3 依規格 content 本來就是空字串——中繼對它們回 `OK true`、實際上卻把它們刪了（SDK ADR 0083）。
 * 其他 kind 要撤回，用 NIP-09 刪除請求或發一顆較新的取代。
 */
export declare function isAddressablePurge(event: NostrEvent): boolean;
/** 檔案塊每收件人預設配額（≈500MB 密文；企業站自己的儲存自己決策）。 */
export declare const DEFAULT_FILE_PER_RECIPIENT = 4000;
/** 單顆檔案塊事件的大小 sanity 上限（48KB 明文 ×2 膨脹之上留餘裕）。 */
export declare const FILE_EVENT_MAX_BYTES = 200000;
/**
 * 有效到期時間（ADR-0065）：`min(標籤值, now + 上限)`；無標籤即 `now + 上限`。
 * 防兩種永存縫隙：無 expiration 的事件、以及惡意超長 expiration。
 */
export declare function effectiveExpiration(event: NostrEvent, nowSec: number, maxTtlSeconds?: number): number;
/** NIP-33 可尋址範圍：每 (kind, pubkey, d) 只保留最新一顆（取代語意）。 */
export declare function isAddressableKind(kind: number): boolean;
/**
 * NIP-01 可取代範圍（ADR-0035）：kind 0／3／10000–19999——每 (kind, pubkey) 只保留最新一顆。
 *
 * Cinderous 用到：`RELAY_LIST_KIND`(10037)、`ORG_ROSTER_KIND`(10038)、`NODE_ATTEST_KIND`(10039)。
 * 過去這些走一般 `put` 而**不斷累積**：health-check cron 每小時發佈一次簽章清單，7 天 TTL 內
 * 就囤了上百份重複——客戶端每次連線都得全部下載一遍。
 */
export declare function isReplaceableKind(kind: number): boolean;
/**
 * 需要「取代語意」的事件（可取代 ∪ 可尋址）。
 *
 * 實作上兩者共用同一條路徑：**NIP-01 的可取代 ≡ `d` 為空字串的可尋址**——`dTagOf` 對沒有
 * `d` 標籤的事件正好回空字串，故 key `(kind, pubkey, "")` 天然就是「每 (kind, pubkey) 一顆」。
 */
export declare function isReplaceableOrAddressable(kind: number): boolean;
/** 事件的 `d` 標籤（可尋址事件的位址元件）；無則空字串（＝NIP-01 可取代事件的隱含位址）。 */
export declare function dTagOf(event: NostrEvent): string;
/**
 * 新事件是否應**取代**既有那顆（NIP-01）：較新者勝；`created_at` 相同時**保留 id 字典序較小者**
 * ——這是 NIP-01 指定的決勝規則，確保所有中繼站對同一組事件收斂到**同一顆**。
 */
export declare function shouldReplace(existing: NostrEvent, incoming: NostrEvent): boolean;
/** 單顆可尋址事件上限（序列化後字元數；ADR-0071 快照 256KB）。 */
export declare const ADDRESSABLE_MAX_BYTES = 262144;
/** 每 (pubkey, kind) 的位址（d 值）數上限（ADR-0071：每人 5 台裝置）。 */
export declare const ADDRESSABLE_MAX_PER_AUTHOR = 5;
/** 可尋址事件壽命上限：30 天、每次備份刷新——活躍者永不過期、棄用帳號自動回收（ADR-0071）。 */
export declare const ADDRESSABLE_TTL_SECONDS: number;
/**
 * 可尋址／可取代事件被拒的原因（SDK ADR 0038 P0-R2）：
 * `stale` 比這個位址現有的舊；`too-large` 單顆超過上限；`address-quota` 這個作者在這個 kind 的位址數滿了；
 * `byte-quota` 這個作者的可尋址總量滿了；`expired` 自帶的 expiration 已過；`ceiling` 這顆 DO 的可尋址天花板滿了而不淘汰。
 */
export type AddressableRejectReason = "stale" | "too-large" | "address-quota" | "byte-quota" | "expired" | "ceiling";
/** {@link OfflineStore.putAddressableResult} 的結果；收下時可能是借用或接近天花板（SDK ADR 0042） */
export type AddressablePutResult = {
    readonly ok: true;
    readonly borrowedTtlSec?: number;
    readonly nearFull?: number;
} | {
    readonly ok: false;
    readonly reason: AddressableRejectReason;
};
/** 收下（共用同一個物件，免得每次寫入都配置一個） */
export declare const ADDRESSABLE_PUT_OK: AddressablePutResult;
/** 組一個拒收結果（記憶體與 SQL 版共用） */
export declare function addressableRejected(reason: AddressableRejectReason): AddressablePutResult;
/**
 * 離線留言持久層的行為契約（ADR-0056）。記憶體版（{@link MessageStore}）與
 * Worker 端 DO SQLite 版（`SqlMessageStore`）皆實作，`RelayCore` 依此介面接。
 */
export interface OfflineStore {
    /**
     * 寫入一筆留言。回 false＝**沒有存下**：已過期，或這顆 DO 的離線天花板滿了而不淘汰
     *（`offlineMaxTotalBytes` 且沒開 `ceilingEvicts`）。`RelayCore` 據此回 `OK false`、不扇出（SDK ADR 0038 P0-R1）。
     * 每收件人 FIFO 與天花板淘汰是「收下新的、刪掉舊的」，回 true。
     */
    put(event: NostrEvent, nowSec: number): boolean;
    /**
     * 寫入可尋址事件（ADR-0071）：以 (kind, pubkey, d) 取代舊顆、只留 created_at 最新；
     * 快照的 `content === ""` ＝刪除既有（purge，{@link isAddressablePurge}）。較舊、超額（大小/位址數）或已過期回 false。
     */
    putAddressable(event: NostrEvent, nowSec: number): boolean;
    /**
     * 與 {@link putAddressable} 相同，但被拒時說出原因（SDK ADR 0038 P0-R2）。`RelayCore` 有這個方法就用它，
     * 依原因回不同的 `OK false`（`blocked: stale:`、`blocked: quota:`…）；沒有就退回 boolean 與一句通用的拒收。
     * 選用：v0.31 以前寫的自訂 store 不必改。
     */
    putAddressableResult?(event: NostrEvent, nowSec: number): AddressablePutResult;
    /**
     * 查詢符合 filter 且未過期的留言。
     *
     * `maxBytes`（Cinderous ADR-0371 §決策 6）：只回**最新**、累計 JSON 大小不超過它的那幾顆；
     * 一顆都放不下就回空。客戶端要更舊的，照 NIP-01 以 `until` 分頁。未給＝不限。
     */
    query(filter: RelayFilter, nowSec: number, maxBytes?: number): NostrEvent[];
    /** 清除所有已過期留言。 */
    prune(nowSec: number): void;
    /**
     * NIP-62 清除請求（ADR-0260）：刪掉某 pubkey 在本站的一切——
     *
     * 1. **他發的**事件（`pubkey` 相符）；
     * 2. **寄給他的**事件（`p` 標籤相符）——Gift Wrap 外層是一次性金鑰，這是唯一能定位收件匣的鍵；
     * 3. 他的可尋址事件（雲端快照等）。
     *
     * 回傳刪除的事件數（去重後），供宿主記錄；呼叫端不得依它做流程判斷。
     */
    vanish(pubkey: string, nowSec: number): number;
    /**
     * 與 {@link put} 相同，但說出結果的細節（SDK ADR 0042）：被拒的原因、收下時是不是借用、有沒有接近天花板。
     * `RelayCore` 有這個方法就用它；選用，v0.33 以前寫的自訂 store 不必改。
     */
    putResult?(event: NostrEvent, nowSec: number): OfflinePutResult;
    /**
     * 收件人讀自己的收件匣時呼叫（SDK ADR 0042）：取出並**歸零**這位收件人的丟棄計數，並記下「到這裡為止的留言都送到了」
     * （之後才刪掉的這些不再計入）。沒有被刪的回 undefined。只在 `countDrops` 時有作用。
     */
    takeDropped?(recipient: string, nowSec: number): DroppedSummary | undefined;
    /** 收件人的收件匣訂閱結束時呼叫：記下「到這裡為止的留言都即時送到了」（SDK ADR 0042）。 */
    markDelivered?(recipient: string, nowSec: number): void;
    /**
     * `RelayCore` 告訴 store「誰正在線上收自己的收件匣」（SDK ADR 0042）：這些人的留言被刪掉不算丟棄——他們已經即時收到了。
     */
    setInboxProbe?(probe: (recipient: string) => boolean): void;
    /**
     * 收件確認（SDK ADR 0067）：把**只寄給** `recipient` 一人、id 在 `ids` 裡的離線留言，到期時間降為
     * `min(原本, expiresAt)`。只會提早、不會延後；回傳實際提早的列數。
     * 寄給多位收件人的事件不動（記憶體版的到期時間是每顆事件一份，降了會連累其他收件人）。
     * 身分檢查（AUTH＝簽章者＝收件人）由 `RelayCore` 負責。選用：沒實作的 store 不宣告這個功能。
     */
    ackInbox?(recipient: string, ids: readonly string[], expiresAt: number, nowSec: number): number;
}
/** 取事件的收件人（`p` 標籤值）清單；供記憶體與 SQL 版共用。 */
export declare function recipientsOf(event: NostrEvent): string[];
/** 以 event id 去重（保留首次出現）；供記憶體與 SQL 版共用。 */
export declare function dedupById(events: NostrEvent[]): NostrEvent[];
/**
 * 離線留言的持久化行為（NIP-40 過期、每收件人配額）。
 *
 * 以收件人（`p` 標籤）為索引：NIP-17 私訊查詢一律帶 `#p`，因此常見路徑
 * 只掃該收件人的留言而非全體（O(該收件人) 而非 O(全部)）。無 `p` 標籤的
 * 事件與不帶 `#p` 的查詢走全掃備援。Worker 端接 D1 時應比照以
 * `p_tag`/`expiration` 建索引。
 */
/**
 * 檔案塊的批次（SDK ADR 0085）：`expiration` 標籤的值。同一次送出的所有檔案塊共用同一個值（SDK vault 傳輸層、Cinderous 傳檔都是迴圈外算一次）。
 * 不是檔案塊、或沒有 `expiration` 標籤 → undefined（不參與整批淘汰）。
 */
export declare function batchOf(event: NostrEvent): number | undefined;
export declare class MessageStore implements OfflineStore {
    private readonly opts;
    /** 收件人 pubkey → 該收件人的留言。 */
    private readonly byRecipient;
    /** 無 `p` 標籤的事件。 */
    private noRecipient;
    /** event id → 有效到期時間（ADR-0065：每列壽命必有界）。 */
    private readonly effExp;
    /** 可尋址事件（ADR-0071）：`kind\0pubkey\0d` → 最新一顆。 */
    private readonly addressable;
    /** 以借用收下的離線事件 id（溢位帶，SDK ADR 0042）。 */
    private readonly borrowedIds;
    /** 以借用收下的可尋址位址（鍵同 {@link addressable}）。 */
    private readonly borrowedAddr;
    /** 事件 id → 寫入序號：丟棄計數的水位線用（SQL 版用 rowid；SDK ADR 0042）。 */
    private readonly seq;
    private nextSeq;
    /** 收件人 → 丟棄計數與水位線（序號 ≤ `mark` 的留言已經送到了）。 */
    private readonly drops;
    /** 誰正在線上收自己的收件匣（`RelayCore` 設定）。 */
    private inboxProbe;
    constructor(opts?: MessageStoreOptions);
    setInboxProbe(probe: (recipient: string) => boolean): void;
    /** 寫入可取代／可尋址事件（取代語意＋配額；ADR-0035／0071）。可取代事件無 `d` → 每 (kind,pubkey) 一顆。 */
    putAddressable(event: NostrEvent, nowSec: number): boolean;
    /** 同 {@link putAddressable}，被拒時帶原因（SDK ADR 0038 P0-R2）；收下時帶借用與預警（SDK ADR 0042）。 */
    putAddressableResult(event: NostrEvent, nowSec: number): AddressablePutResult;
    /** 目前可尋址佔用的位元組（`except` 那個位址不算：它即將被取代）。 */
    private addressableBytes;
    /** 目前離線留言佔用的位元組（每位收件人各算一份，與 SQL 版的「一列」對齊）。 */
    private offlineBytes;
    /** 每一列離線留言（每位收件人一列；無 `p` 者 `recipient = ''`）。 */
    private offlineRows;
    /** 保底份額的 key：收件人；沒有收件人的列以作者計（SDK ADR 0042）。 */
    private static ownerOf;
    /** 每個 key 的離線用量（`borrowed` 選正常列或借用列）。 */
    private offlineUsage;
    /** 依到期時間由近而遠排好的離線列（`borrowed` 選正常列或借用列）。 */
    private offlineRowsByExpiry;
    /**
     * 這顆 DO 放不放得下這筆離線留言、怎麼放（ADR-0367 §決策 2；SDK ADR 0042 的保底與溢位帶）。
     * 回 undefined＝拒收；`borrowed`＝放進溢位帶。決策與 SQL 版共用 `decideCapacity`。
     */
    private placeOffline;
    /**
     * 可尋址那一側的同一套決策（SDK ADR 0042）。`key` 是即將被取代的位址（不算進用量），`pubkey` 是保底的 key。
     */
    private placeAddressable;
    /** 事件還在任何一個離線桶裡嗎。 */
    private stillStored;
    /** 忘掉一顆不再存在的離線事件的附帶資料（到期時間、借用、序號）。 */
    private forgetOffline;
    /** 刪掉一列（某位收件人的那一份），回傳釋放的位元組；記進丟棄計數。 */
    private dropRow;
    /**
     * 整批淘汰（SDK ADR 0085）：中繼自己刪掉的檔案塊，同一收件人、同一個 `expiration` 標籤（＝同一次送出）的其餘檔案塊一起刪，
     * 回傳釋放的位元組。只刪一部分會切出永遠收不齊的孤兒：佔空間到過期、每次補拉都被整批再下載。
     * 批次靠中繼本來就看得到的值判斷（不加任何元資料）；同一秒送給同一人的另一則可能被一起刪（ADR 0085 已知取捨）。
     */
    private dropBatchMates;
    /** 從所有桶移除某個 id，回傳釋放的位元組（v0.33 的淘汰）。`removed` 給了就把移除的列放進去。 */
    private dropOffline;
    /**
     * 寄給 `recipient` 的一則被刪掉了（FIFO、天花板淘汰、借用到期）：記進丟棄計數（SDK ADR 0042）。
     * 不計：沒開 `countDrops`、沒有收件人、收件人正在線上收收件匣（即時收到了）、在上次送到的水位線以前就存了（送到過）。
     */
    private noteDropped;
    takeDropped(recipient: string, nowSec: number): DroppedSummary | undefined;
    markDelivered(recipient: string, nowSec: number): void;
    ackInbox(recipient: string, ids: readonly string[], expiresAt: number, nowSec: number): number;
    /** 寫入一筆留言；若已過期則拒絕並回 false。 */
    put(event: NostrEvent, nowSec: number): boolean;
    /** 同 {@link put}，說出結果的細節（SDK ADR 0042）。 */
    putResult(event: NostrEvent, nowSec: number): OfflinePutResult;
    /**
     * 查詢符合 filter 且未過期的留言。
     *
     * 回傳筆數與 SQL 版一樣有界（ADR-0235 C2）——兩個實作共用同一份 `OfflineStore` 契約，
     * 行為分歧會讓「用記憶體版寫的測試」保證不了產線的 SQL 版。
     */
    query(filter: RelayFilter, nowSec: number, maxBytes?: number): NostrEvent[];
    /** 清除所有已過期留言。借用列到期算丟棄（SDK ADR 0042）；一般的保存期到期不算——那是宣告過的契約。 */
    prune(nowSec: number): void;
    /** NIP-62 清除（ADR-0260）：刪掉此人發的、寄給他的、以及他的可尋址事件。 */
    vanish(pubkey: string, _nowSec: number): number;
    /** 依 filter 縮小候選集合：帶 `#p` 時僅取相關收件人桶，否則全掃。 */
    private candidatesFor;
    private allEvents;
    private isExpired;
    private enforceCap;
}
//# sourceMappingURL=message-store.d.ts.map