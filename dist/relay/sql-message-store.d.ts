import type { NostrEvent } from "../protocol/index.js";
import { type AddressablePutResult, type OfflinePutResult, type MessageStoreOptions, type OfflineStore } from "./message-store.js";
import type { RelayFilter } from "./protocol.js";
import { type DroppedSummary } from "./capacity.js";
/**
 * 最小同步 SQL 執行介面（ADR-0056）。產線包 Durable Object 的 `ctx.storage.sql.exec()`
 * （同步）；測試以 `node:sqlite` 包出真 SQLite。回傳每列為欄名→值的物件陣列。
 */
export type SqlExec = (query: string, ...bindings: (string | number | null)[]) => Record<string, unknown>[];
/**
 * 離線留言持久層的 SQL 版（ADR-0056）：以 DO 內建 SQLite 落地，行為對齊記憶體版
 * {@link MessageStore}（NIP-40 過期、每收件人配額、`#p` 索引），但同步、可持久。
 *
 * schema：每個 `p` 標籤一列（`(id, recipient)` 為主鍵）；無 `p` 者以 `recipient=''` 存。
 */
export declare class SqlMessageStore implements OfflineStore {
    private readonly sql;
    private readonly opts;
    constructor(sql: SqlExec, opts?: MessageStoreOptions);
    /**
     * 離線留言目前佔用的位元組（快取；`undefined`＝下次用到時重算一次）。Cinderous ADR-0371 §決策 5。
     *
     * 🔴 為什麼要快取：天花板每次寫入都要問「現在用了多少」。就算改讀索引，`SUM` 仍要掃過
     * **每一列**的索引項，而 Cloudflare 以「讀取列數」計費（免費層每日 500 萬列）——一顆滿載的
     * 檔案車道 DO 有數千列，上傳一個 30MB 檔（656 塊）就會把一整天的額度讀光。
     * 寫入時加、刪除時減；刪除路徑算不出確切數字的（prune、vanish）直接作廢，下次重算。
     */
    private offlineUsed;
    /** 每個（收件人, 桶）目前的列數（快取，理由同上）。鍵見 {@link bucketKey}。 */
    private readonly bucketCounts;
    /** 借用列的總量（快取；SDK ADR 0042）。只在天花板滿了才用得到，從部分索引算、很便宜。 */
    private offlineBorrowed;
    /**
     * 每個 key（收件人；沒有收件人的列＝作者）的**正常列**用量（快取；SDK ADR 0042 保底份額）。
     * 只有設了保底、而且天花板滿了才建（一次掃過分桶索引），之後寫入時加、刪除時減或重算那一個 key。
     */
    private ownerNormal;
    /** 丟棄計數表的列數（快取；上限 `DROPPED_RECIPIENTS_MAX`）。 */
    private dropRows;
    /** 誰正在線上收自己的收件匣（`RelayCore` 設定；SDK ADR 0042）。 */
    private inboxProbe;
    /** 作廢所有快取（下次用到時從索引重算）。 */
    private invalidateUsage;
    setInboxProbe(probe: (recipient: string) => boolean): void;
    private usedOfflineBytes;
    /** 借用列的總量（部分索引 `idx_offline_borrowed`，只掃借用列）。 */
    private borrowedOfflineBytes;
    /** 某個 key 的借用量（部分索引）。 */
    private ownerBorrowedBytes;
    /**
     * 每個 key 的正常列用量（SDK ADR 0042）。
     *
     * 🔴 刻意不在大表上讀 `borrowed` 欄：它是 `ADD COLUMN` 加的、排在 json 後面，檔案塊的 json 在溢位頁上，
     * 讀它要把整串溢位頁走完（Cinderous ADR-0371 §決策 5 的教訓）。所以用「分桶索引上的總量 − 部分索引上的借用量」。
     */
    private ownerNormalUsage;
    put(event: NostrEvent, nowSec: number): boolean;
    /** 同 {@link put}，說出結果的細節（SDK ADR 0042）。行為與記憶體版對齊。 */
    putResult(event: NostrEvent, nowSec: number): OfflinePutResult;
    /** 寫入可取代／可尋址事件（取代語意＋配額；ADR-0035／0071）。行為對齊記憶體版。 */
    putAddressable(event: NostrEvent, nowSec: number): boolean;
    /** 同 {@link putAddressable}，被拒時帶原因（SDK ADR 0038 P0-R2）；收下時帶借用與預警（SDK ADR 0042）。原因與記憶體版逐字對齊。 */
    putAddressableResult(event: NostrEvent, nowSec: number): AddressablePutResult;
    /**
     * 這顆 DO 放不放得下這筆離線留言、怎麼放（ADR-0367 §決策 2；SDK ADR 0042 的保底與溢位帶）。行為與記憶體版逐字對齊。
     * 回 undefined＝拒收；`borrowed`＝放進溢位帶。決策由 `capacity.ts` 的 `decideCapacity` 做，這裡只執行。
     *
     * 🔴 為什麼 FIFO 不夠：`enforceCap` 只對**真正的收件人**執行，而沒有 `p` 標籤的事件
     * 落在 `recipient = ''` ⇒ 那個桶原本只被 TTL 壓著，而遊戲的房間事件正是這個形狀。
     */
    private placeOffline;
    /**
     * 可尋址那一側的同一套決策（ADR-0367 §決策 2；SDK ADR 0042）。行為與記憶體版逐字對齊。
     * `replacedLen`／`replacedBorrowed` 是**即將被取代**的那一列——它會被換掉，不該算進已用空間。
     */
    private placeAddressable;
    /**
     * 被刪掉的離線列記進丟棄計數（SDK ADR 0042；ADR 0038 M8）。
     *
     * 不計：沒開 `countDrops`、沒有收件人的列、收件人正在線上收收件匣（即時收到了）、
     * rowid 不超過那位收件人上次讀收件匣時的水位線（那時就在庫裡，已經送到過）。
     */
    private recordDrops;
    /** 丟棄計數表多了一列：超過上限就刪最久沒更新的（收件人可以亂編，表不能無限長）。 */
    private noteNewDropRow;
    /** 目前離線表的最大 rowid：丟棄計數的水位線（這之前存的都送到了）。 */
    private deliveredMark;
    takeDropped(recipient: string, nowSec: number): DroppedSummary | undefined;
    markDelivered(recipient: string, nowSec: number): void;
    /**
     * 查詢符合 filter 且未過期的留言。
     *
     * ## 為什麼過濾條件必須下推到 SQL（ADR-0235 C2）
     *
     * 修正前，沒有 `#p` 的 filter 會走
     * `SELECT json FROM offline_msgs WHERE expiration > ?`——**整張表**（所有使用者的離線留言）
     * 撈進記憶體、逐筆 `JSON.parse`，再於 JS 端 `matchFilter` 過濾。
     *
     * 而 `relay-core` 的 `scoped()` 明文允許「沒有 `#p`、但有 `authors`」的訂閱（ADR-0071 的
     * 快照查詢正是這個形狀），連 `authors: []` 都放行——它匹配不到任何事件，卻會完整跑一次
     * 全表掃描。也就是說 `{"authors":[]}` 是一個**零成本、零收穫、全代價**的 payload。
     * Durable Object 記憶體上限 128MB，而這是**單一全域房間**：重複送幾次就 OOM，全站掉線。
     *
     * 現在 `#p`／`authors`／`ids`／`kinds`／`since`／`until` 全部進 WHERE（有索引），並一律帶
     * `LIMIT`。`matchFilter` 仍是最終權威（`#e` 等標籤 filter 只能在 JS 判），但它現在跑在
     * **有界且已縮小**的候選集上。
     *
     * 「訂閱必須具名」則**不**在這一層——那是 `relay-core.scoped()` 的職責（ADR-0123）。
     * 儲存層若也擋，會讓「Ephemeral 不入庫」這類**否定斷言**變成恆真的空轉測試。
     * 這裡只負責一件事：**任何查詢的代價都有界**。
     */
    query(filter: RelayFilter, nowSec: number, maxBytes?: number): NostrEvent[];
    /**
     * 取出最新的列，但**累計大小不超過 `budget`**（Cinderous ADR-0371 §決策 6）。沒給預算＝與過去相同。
     *
     * 🔴 為什麼要分兩步：`toArray()` 一次把結果全部搬進記憶體，而 DO 的記憶體上限是 128MB。
     * 一位收件人名下的檔案塊可能有上千顆、每顆約 131KB——一次 REQ 就是上百 MB，DO 當場重置。
     * 先只讀大小（分桶索引上就有）算出放得下幾列，再取那幾列的 json。
     * 排序多一個 `rowid` 當決勝，兩步才保證挑中的是同一批列。
     */
    private boundedSelect;
    prune(nowSec: number): void;
    /**
     * 收件確認（SDK ADR 0067）：同 {@link OfflineStore.ackInbox}。走主鍵 `(id, recipient)`，不讀 json。
     * 「只寄給一人」以**庫裡還有沒有同 id、別的收件人的列**判斷（讀 json 的標籤要走溢位頁，檔案塊一顆約 131KB）。
     */
    ackInbox(recipient: string, ids: readonly string[], expiresAt: number, nowSec: number): number;
    /**
     * NIP-62 清除（ADR-0260）：`pubkey = ?`（他發的）**或** `recipient = ?`（寄給他的
     * ——Gift Wrap 外層是一次性金鑰，`p` 是唯一能定位收件匣的鍵），外加他的可尋址事件。
     *
     * 兩欄都有索引（`idx_offline_pubkey`／`idx_offline_bucket` 的 recipient 前綴），故不是全表掃描。
     */
    vanish(pubkey: string, _nowSec: number): number;
    /**
     * 這幾列的收件人、批次（SDK ADR 0085）與桶別：**以 rowid 逐列查**，只讀要刪的那幾列（SDK ADR 0102）。
     *
     * 🔴 原本寫成 `INDEXED BY idx_offline_batch ... rowid IN (...)`，想「只讀索引、不碰 json 溢位頁」，
     * 但部分索引不是以 rowid 排序——SQLite 只能把整個索引掃一遍（每顆檔案塊都在裡面），
     * 塞滿的檔案車道每次淘汰讀約 4,400 列，2026-10-19 一小時把錨點 1 的讀取額度用完。
     * 改成 rowid 查詢：要讀這幾列在大表上的欄位（`batch`／`kind` 在 json 後面，要走溢位頁），但只有這幾列。
     */
    private describeRows;
    /**
     * 這幾列被刪掉了：借用量與每個人的正常列用量照實扣掉（SDK ADR 0103）。原本整個作廢，
     * 下一次要判斷保底時以 `GROUP BY` 掃過整個分桶索引重建（塞滿的檔案車道每次約 4,200 列）。
     */
    private forgetUsage;
    /** 這幾列被刪掉了：從各自那一桶的列數快取扣掉（沒快取的桶下次照舊重數）。SDK ADR 0102 */
    private forgetRows;
    /**
     * 整批淘汰（SDK ADR 0085）：被刪掉的檔案塊所屬的那一批（同收件人、同 `batch`）其餘的列一起刪，回傳釋放的位元組；記進丟棄計數。
     * 只刪一部分會切出永遠收不齊的孤兒。行為與記憶體版逐字對齊。
     */
    private dropBatchMates;
    /**
     * 分桶修剪（ADR-0162：檔案塊與聊天留言各自計數、各自由舊到新丟棄）。
     *
     * 只修剪**這次寫入落到的那一桶**：另一桶的列數沒變，不需要看（修正前兩桶每次都掃）。
     * 列數走快取，只有超量時才讀出要刪的那幾列——而且只讀 `idx_offline_bucket` 的索引項。
     */
    private enforceCap;
}
//# sourceMappingURL=sql-message-store.d.ts.map