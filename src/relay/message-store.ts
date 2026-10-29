import type { NostrEvent } from "../protocol/index.js";
import { matchFilter } from "./filters.js";
import type { RelayFilter } from "./protocol.js";
import {
  BORROW_TTL_SECONDS,
  borrowedExpiration,
  borrowPerKey,
  decideCapacity,
  DROPPED_RECIPIENTS_MAX,
  type DroppedSummary,
  mergeDropped,
  nearFullGrade,
  overflowBand,
  pickExcess,
} from "./capacity.js";

/** 讀取事件的 NIP-40 過期時間（unix 秒）；無或非法時回 undefined。 */
export function getExpiration(event: NostrEvent): number | undefined {
  const tag = event.tags.find((t) => t[0] === "expiration");
  if (!tag || tag[1] === undefined) return undefined;
  const seconds = Number(tag[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

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
   * **資料庫大小的上界**（位元組；SDK ADR 0126）：只有 SQL 版用。給了，寫入時先拿它判斷「一定放得下、一定沒到預警線」，
   * 成立就不 `SUM` 整張表（喚醒後第一次寫入原本要掃整個分桶索引、可尋址事件每次寫入都掃）。不成立才照舊精算——
   * 它只用來**確定放得下**，從不用來拒收、淘汰或預警。DO 宿主給 `ctx.storage.sql.databaseSize`：
   * 每一列的 json 都完整存在資料庫裡（UTF-8 位元組數 ≥ `JSON.stringify(...).length`），所以它不會小於實際用量。
   */
  sizeUpperBound?: () => number;
  /**
   * **丟棄計數**（SDK ADR 0042；ADR 0038 M8）：因 FIFO、天花板淘汰、借用到期而刪掉寄給某位收件人的留言時，按收件人累計；
   * 收件人下次訂閱自己的收件匣時由中繼送一則 `NOTICE "warning: dropped: …"`。未設＝不計（v0.33 行為）。
   */
  countDrops?: boolean;
}

/** {@link OfflineStore.putResult} 的結果（SDK ADR 0042）：收下時可能是借用（`borrowedTtlSec`）或接近天花板（`nearFull`）。 */
export type OfflinePutResult =
  | { readonly ok: true; readonly borrowedTtlSec?: number; readonly nearFull?: number }
  | { readonly ok: false; readonly reason: "expired" | "ceiling" };

/** 預設留言壽命上限：7 天（對齊 client 端 gift wrap 的預設 TTL）。 */
export const DEFAULT_MAX_TTL_SECONDS = 7 * 86_400;

/**
 * 單次查詢的回傳筆數硬上限（ADR-0235 C2）。客戶端每收件人最多 500 則
 * （`MAX_PER_RECIPIENT`），1024 已是兩倍餘裕。**這是把「一次 REQ 撈爆 DO 記憶體」
 * 變成不可能的那一行**——`OfflineStore` 的兩個實作都必須遵守。
 */
export const MAX_QUERY_ROWS = 1024;

/**
 * 單次 REQ 回傳的位元組上限（Cinderous ADR-0371 §決策 6）。
 *
 * 🔴 為什麼筆數上限不夠：{@link MAX_QUERY_ROWS} 是為聊天訂的（一則幾 KB）。檔案塊一顆約
 * 131KB，1024 顆就是 134MB——超過 DO 的 128MB 記憶體上限，DO 會在組回應的途中被重置，
 * 客戶端重連、再 REQ、再重置。16MB 約 120 顆檔案塊、上萬則聊天，後者碰不到它。
 * 超過的部分由客戶端依 NIP-01 以 `until` 分頁取回。
 */
export const MAX_QUERY_BYTES = 16 * 1024 * 1024;

/** 有效筆數上限：尊重 `filter.limit`（NIP-01），但一律夾在 {@link MAX_QUERY_ROWS} 之內。 */
export function queryLimit(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return MAX_QUERY_ROWS;
  return Math.min(Math.floor(requested), MAX_QUERY_ROWS);
}

/** 檔案塊外層 kind（ADR-0162）；**必須鏡射 core `KIND.FILE_WRAP`**（relay 不依賴 core runtime）。 */
export const FILE_WRAP_KIND = 1060;

/**
 * 加密雲端快照 kind（ADR-0071）；**必須鏡射 core `SNAPSHOT_KIND`**（同上，relay 不依賴 core runtime）。
 *
 * 為什麼這個常數存在：ADR-0071 的「只回給作者本人」原本是對**整個**可尋址區間
 * （30000–39999）生效的，而那個區間裡只有這一個 kind 是「加密給自己的私人快照」。
 * 其餘可尋址事件（第三方應用的公開資料）天生就是要給別人讀的，閘在那裡等於它們
 * 永遠只有作者看得到。⇒ 閘門收窄到這一個 kind（ADR-0366 §決策 5）。
 */
export const SNAPSHOT_KIND = 30078;

/**
 * 是否為「只有作者本人讀得到」的私人可尋址事件（ADR-0071 ／ ADR-0366 §決策 5）。
 *
 * ⚠ **不要**改回 {@link isAddressableKind}——那是 NIP-33 的**儲存語意**（取代規則），
 * 與「誰讀得到」是兩件事。混用會讓每一個新的可尋址 kind 都默默變成作者專屬。
 */
export function isAuthorOnlyKind(kind: number): boolean {
  return kind === SNAPSHOT_KIND;
}

/**
 * 這顆可尋址事件是不是「清除」（Cinderous ADR-0071 purge）：**只有快照**的空 content 才是。
 *
 * 關閉雲端備份時「已關閉」必須立即為真，所以快照用空 content 表示「刪掉我這台的那份」。
 * 但這條約定原本套在**所有**可取代／可尋址 kind 上，而 NIP-17 的 10050、NIP-65 的 10002、
 * NIP-02 的 kind 3 依規格 content 本來就是空字串——中繼對它們回 `OK true`、實際上卻把它們刪了（SDK ADR 0083）。
 * 其他 kind 要撤回，用 NIP-09 刪除請求或發一顆較新的取代。
 */
export function isAddressablePurge(event: NostrEvent): boolean {
  return isAuthorOnlyKind(event.kind) && event.content === "";
}
/** 檔案塊每收件人預設配額（≈500MB 密文；企業站自己的儲存自己決策）。 */
export const DEFAULT_FILE_PER_RECIPIENT = 4000;
/** 單顆檔案塊事件的大小 sanity 上限（48KB 明文 ×2 膨脹之上留餘裕）。 */
export const FILE_EVENT_MAX_BYTES = 200_000;

/**
 * 有效到期時間（ADR-0065）：`min(標籤值, now + 上限)`；無標籤即 `now + 上限`。
 * 防兩種永存縫隙：無 expiration 的事件、以及惡意超長 expiration。
 */
export function effectiveExpiration(event: NostrEvent, nowSec: number, maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS): number {
  const cap = nowSec + maxTtlSeconds;
  const tagged = getExpiration(event);
  return tagged === undefined ? cap : Math.min(tagged, cap);
}

// ── 可取代／可尋址事件（取代語意；ADR-0035／0071） ─────────────────────────

/** NIP-33 可尋址範圍：每 (kind, pubkey, d) 只保留最新一顆（取代語意）。 */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/**
 * NIP-01 可取代範圍（ADR-0035）：kind 0／3／10000–19999——每 (kind, pubkey) 只保留最新一顆。
 *
 * Cinderous 用到：`RELAY_LIST_KIND`(10037)、`ORG_ROSTER_KIND`(10038)、`NODE_ATTEST_KIND`(10039)。
 * 過去這些走一般 `put` 而**不斷累積**：health-check cron 每小時發佈一次簽章清單，7 天 TTL 內
 * 就囤了上百份重複——客戶端每次連線都得全部下載一遍。
 */
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/**
 * 需要「取代語意」的事件（可取代 ∪ 可尋址）。
 *
 * 實作上兩者共用同一條路徑：**NIP-01 的可取代 ≡ `d` 為空字串的可尋址**——`dTagOf` 對沒有
 * `d` 標籤的事件正好回空字串，故 key `(kind, pubkey, "")` 天然就是「每 (kind, pubkey) 一顆」。
 */
export function isReplaceableOrAddressable(kind: number): boolean {
  return isReplaceableKind(kind) || isAddressableKind(kind);
}

/** 事件的 `d` 標籤（可尋址事件的位址元件）；無則空字串（＝NIP-01 可取代事件的隱含位址）。 */
export function dTagOf(event: NostrEvent): string {
  return event.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

/**
 * 新事件是否應**取代**既有那顆（NIP-01）：較新者勝；`created_at` 相同時**保留 id 字典序較小者**
 * ——這是 NIP-01 指定的決勝規則，確保所有中繼站對同一組事件收斂到**同一顆**。
 */
export function shouldReplace(existing: NostrEvent, incoming: NostrEvent): boolean {
  if (incoming.created_at !== existing.created_at) return incoming.created_at > existing.created_at;
  return incoming.id < existing.id;
}

/** 單顆可尋址事件上限（序列化後字元數；ADR-0071 快照 256KB）。 */
export const ADDRESSABLE_MAX_BYTES = 262_144;
/** 每 (pubkey, kind) 的位址（d 值）數上限（ADR-0071：每人 5 台裝置）。 */
export const ADDRESSABLE_MAX_PER_AUTHOR = 5;
/** 可尋址事件壽命上限：30 天、每次備份刷新——活躍者永不過期、棄用帳號自動回收（ADR-0071）。 */
export const ADDRESSABLE_TTL_SECONDS = 30 * 86_400;

/**
 * 可尋址／可取代事件被拒的原因（SDK ADR 0038 P0-R2）：
 * `stale` 比這個位址現有的舊；`too-large` 單顆超過上限；`address-quota` 這個作者在這個 kind 的位址數滿了；
 * `byte-quota` 這個作者的可尋址總量滿了；`expired` 自帶的 expiration 已過；`ceiling` 這顆 DO 的可尋址天花板滿了而不淘汰。
 */
export type AddressableRejectReason = "stale" | "too-large" | "address-quota" | "byte-quota" | "expired" | "ceiling";

/** {@link OfflineStore.putAddressableResult} 的結果；收下時可能是借用或接近天花板（SDK ADR 0042） */
export type AddressablePutResult =
  | { readonly ok: true; readonly borrowedTtlSec?: number; readonly nearFull?: number }
  | { readonly ok: false; readonly reason: AddressableRejectReason };

/** 收下（共用同一個物件，免得每次寫入都配置一個） */
export const ADDRESSABLE_PUT_OK: AddressablePutResult = { ok: true };
/** 組一個拒收結果（記憶體與 SQL 版共用） */
export function addressableRejected(reason: AddressableRejectReason): AddressablePutResult {
  return { ok: false, reason };
}

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
export function recipientsOf(event: NostrEvent): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "p" && tag[1] !== undefined) out.push(tag[1]);
  }
  return out;
}

/** 以 event id 去重（保留首次出現）；供記憶體與 SQL 版共用。 */
export function dedupById(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}

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
export function batchOf(event: NostrEvent): number | undefined {
  return event.kind === FILE_WRAP_KIND ? getExpiration(event) : undefined;
}

export class MessageStore implements OfflineStore {
  /** 收件人 pubkey → 該收件人的留言。 */
  private readonly byRecipient = new Map<string, NostrEvent[]>();
  /** 無 `p` 標籤的事件。 */
  private noRecipient: NostrEvent[] = [];
  /** event id → 有效到期時間（ADR-0065：每列壽命必有界）。 */
  private readonly effExp = new Map<string, number>();
  /** 可尋址事件（ADR-0071）：`kind\0pubkey\0d` → 最新一顆。 */
  private readonly addressable = new Map<string, NostrEvent>();
  /** 以借用收下的離線事件 id（溢位帶，SDK ADR 0042）。 */
  private readonly borrowedIds = new Set<string>();
  /** 以借用收下的可尋址位址（鍵同 {@link addressable}）。 */
  private readonly borrowedAddr = new Set<string>();
  /** 事件 id → 寫入序號：丟棄計數的水位線用（SQL 版用 rowid；SDK ADR 0042）。 */
  private readonly seq = new Map<string, number>();
  private nextSeq = 1;
  /** 收件人 → 丟棄計數與水位線（序號 ≤ `mark` 的留言已經送到了）。 */
  private readonly drops = new Map<string, { summary?: DroppedSummary; mark: number; updatedAt: number }>();
  /** 誰正在線上收自己的收件匣（`RelayCore` 設定）。 */
  private inboxProbe: (recipient: string) => boolean = () => false;

  constructor(private readonly opts: MessageStoreOptions = {}) {}

  setInboxProbe(probe: (recipient: string) => boolean): void {
    this.inboxProbe = probe;
  }

  /** 寫入可取代／可尋址事件（取代語意＋配額；ADR-0035／0071）。可取代事件無 `d` → 每 (kind,pubkey) 一顆。 */
  putAddressable(event: NostrEvent, nowSec: number): boolean {
    return this.putAddressableResult(event, nowSec).ok;
  }

  /** 同 {@link putAddressable}，被拒時帶原因（SDK ADR 0038 P0-R2）；收下時帶借用與預警（SDK ADR 0042）。 */
  putAddressableResult(event: NostrEvent, nowSec: number): AddressablePutResult {
    const prefix = `${event.kind}\0${event.pubkey}\0`;
    const key = prefix + dTagOf(event);
    const existing = this.addressable.get(key);
    if (existing && !shouldReplace(existing, event)) return addressableRejected("stale"); // 較舊（或同時但 id 較大）→ 不取代
    if (isAddressablePurge(event)) {
      // purge：關閉備份時「已關閉」必須立即為真（ADR-0071）；只限快照（ADR 0083）。
      if (existing) {
        this.addressable.delete(key);
        this.borrowedAddr.delete(key);
        this.effExp.delete(existing.id);
      }
      return ADDRESSABLE_PUT_OK;
    }
    const size = JSON.stringify(event).length;
    if (size > (this.opts.addressableMaxBytes ?? ADDRESSABLE_MAX_BYTES)) return addressableRejected("too-large");
    if (!existing) {
      let count = 0;
      for (const k of this.addressable.keys()) if (k.startsWith(prefix)) count++;
      if (count >= (this.opts.addressablePerAuthor ?? ADDRESSABLE_MAX_PER_AUTHOR)) return addressableRejected("address-quota");
    }
    const budget = this.opts.addressableBytesPerAuthor;
    if (budget !== undefined) {
      // 取代既有位址時算的是**差額**：把舊的那顆先扣掉，否則更新到一半就再也更新不了。
      let used = 0;
      for (const [k, e] of this.addressable) {
        if (e.pubkey !== event.pubkey || k === key) continue;
        used += JSON.stringify(e).length;
      }
      if (used + size > budget) return addressableRejected("byte-quota");
    }
    let eff = effectiveExpiration(event, nowSec, this.opts.addressableTtlSeconds ?? ADDRESSABLE_TTL_SECONDS);
    if (eff <= nowSec) return addressableRejected("expired");
    const placed = this.placeAddressable(key, event.pubkey, size);
    if (placed === undefined) return addressableRejected("ceiling");
    if (existing) this.effExp.delete(existing.id);
    const ttl = this.opts.borrowTtlSeconds ?? BORROW_TTL_SECONDS;
    if (placed.borrowed) {
      eff = borrowedExpiration(eff, nowSec, ttl);
      this.borrowedAddr.add(key);
    } else {
      this.borrowedAddr.delete(key);
    }
    this.addressable.set(key, event);
    this.effExp.set(event.id, eff);
    if (placed.borrowed) return { ok: true, borrowedTtlSec: ttl };
    const nearFull = nearFullGrade(this.addressableBytes(), this.opts.addressableMaxTotalBytes, this.opts.nearFullPercent);
    return nearFull === undefined ? ADDRESSABLE_PUT_OK : { ok: true, nearFull };
  }

  /** 目前可尋址佔用的位元組（`except` 那個位址不算：它即將被取代）。 */
  private addressableBytes(except?: string): number {
    let used = 0;
    for (const [k, e] of this.addressable) if (k !== except) used += JSON.stringify(e).length;
    return used;
  }

  /** 目前離線留言佔用的位元組（每位收件人各算一份，與 SQL 版的「一列」對齊）。 */
  private offlineBytes(): number {
    let used = 0;
    for (const { event } of this.offlineRows()) used += JSON.stringify(event).length;
    return used;
  }

  /** 每一列離線留言（每位收件人一列；無 `p` 者 `recipient = ''`）。 */
  private offlineRows(): { event: NostrEvent; recipient: string }[] {
    const rows: { event: NostrEvent; recipient: string }[] = [];
    for (const event of this.noRecipient) rows.push({ event, recipient: "" });
    for (const [recipient, bucket] of this.byRecipient) for (const event of bucket) rows.push({ event, recipient });
    return rows;
  }

  /** 保底份額的 key：收件人；沒有收件人的列以作者計（SDK ADR 0042）。 */
  private static ownerOf(event: NostrEvent, recipient: string): string {
    return recipient === "" ? event.pubkey : recipient;
  }

  /** 每個 key 的離線用量（`borrowed` 選正常列或借用列）。 */
  private offlineUsage(borrowed: boolean): Map<string, number> {
    const usage = new Map<string, number>();
    for (const { event, recipient } of this.offlineRows()) {
      if (this.borrowedIds.has(event.id) !== borrowed) continue;
      const owner = MessageStore.ownerOf(event, recipient);
      usage.set(owner, (usage.get(owner) ?? 0) + JSON.stringify(event).length);
    }
    return usage;
  }

  /** 依到期時間由近而遠排好的離線列（`borrowed` 選正常列或借用列）。 */
  private offlineRowsByExpiry(borrowed: boolean): { event: NostrEvent; recipient: string; owner: string; bytes: number }[] {
    return this.offlineRows()
      .filter(({ event }) => this.borrowedIds.has(event.id) === borrowed)
      .map(({ event, recipient }) => ({
        event,
        recipient,
        owner: MessageStore.ownerOf(event, recipient),
        bytes: JSON.stringify(event).length,
      }))
      .sort((a, b) => (this.effExp.get(a.event.id) ?? 0) - (this.effExp.get(b.event.id) ?? 0));
  }

  /**
   * 這顆 DO 放不放得下這筆離線留言、怎麼放（ADR-0367 §決策 2；SDK ADR 0042 的保底與溢位帶）。
   * 回 undefined＝拒收；`borrowed`＝放進溢位帶。決策與 SQL 版共用 `decideCapacity`。
   */
  private placeOffline(size: number, copies: number, owners: readonly string[], nowSec: number): { borrowed: boolean } | undefined {
    const max = this.opts.offlineMaxTotalBytes;
    if (max === undefined) return { borrowed: false };
    const need = size * copies;
    let used = this.offlineBytes();
    const guarantee = this.opts.guaranteeBytes;
    const band = overflowBand(max, this.opts.overflowRatio);
    let borrowedTotal: number | undefined;
    let plan: { event: NostrEvent; recipient: string; owner: string; bytes: number }[] = [];
    const borrowed = (): number => (borrowedTotal ??= [...this.offlineUsage(true).values()].reduce((a, b) => a + b, 0));
    const decision = decideCapacity({
      max,
      used,
      need,
      evicts: this.opts.ceilingEvicts === true,
      guarantee,
      band,
      planeBorrows: true,
      borrowed,
      withinGuarantee: () => {
        const usage = this.offlineUsage(false);
        return owners.every((o) => (usage.get(o) ?? 0) + size <= guarantee!);
      },
      excessAvailable: () => {
        const usage = this.offlineUsage(false);
        const mine = new Set(owners);
        const candidates = this.offlineRowsByExpiry(false).filter(
          (r) => !mine.has(r.owner) && (usage.get(r.owner) ?? 0) > guarantee!,
        );
        const picked = pickExcess(candidates, usage, guarantee!, used - borrowed() + need - max);
        plan = picked.rows;
        return picked.freed;
      },
      borrowFitsPerKey: () => {
        const usage = this.offlineUsage(true);
        const perKey = borrowPerKey(band, this.opts.borrowPerKeyBytes);
        return owners.every((o) => (usage.get(o) ?? 0) + size <= perKey);
      },
    });
    switch (decision.type) {
      case "fit":
        return { borrowed: false };
      case "borrow":
        return { borrowed: true };
      case "reject":
        return undefined;
      case "reclaim": {
        const gone: { event: NostrEvent; recipient: string }[] = [];
        for (const row of this.offlineRowsByExpiry(true)) {
          if (used + need <= max) break;
          used -= this.dropRow(row.event, row.recipient, nowSec);
          gone.push(row);
        }
        this.dropBatchMates(gone, nowSec); // 整批淘汰（SDK ADR 0085）
        return { borrowed: false };
      }
      case "excess": {
        const gone = [...this.offlineRowsByExpiry(true), ...plan];
        for (const row of gone) this.dropRow(row.event, row.recipient, nowSec);
        this.dropBatchMates(gone, nowSec);
        return { borrowed: false };
      }
      case "legacy": {
        // v0.33 原樣：依到期時間由近而遠淘汰，直到騰得出空間
        const victims = [...this.effExp.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
        for (const id of victims) {
          if (used + need <= max) break;
          const gone: { event: NostrEvent; recipient: string }[] = [];
          used -= this.dropOffline(id, nowSec, gone);
          used -= this.dropBatchMates(gone, nowSec);
        }
        return used + need <= max ? { borrowed: false } : undefined;
      }
    }
  }

  /**
   * 可尋址那一側的同一套決策（SDK ADR 0042）。`key` 是即將被取代的位址（不算進用量），`pubkey` 是保底的 key。
   */
  private placeAddressable(key: string, pubkey: string, size: number): { borrowed: boolean } | undefined {
    const max = this.opts.addressableMaxTotalBytes;
    if (max === undefined) return { borrowed: false };
    let used = this.addressableBytes(key);
    const guarantee = this.opts.guaranteeBytes;
    const band = overflowBand(max, this.opts.overflowRatio);
    const others = (borrowed: boolean): [string, NostrEvent, number][] =>
      [...this.addressable.entries()]
        .filter(([k]) => k !== key && this.borrowedAddr.has(k) === borrowed)
        .map(([k, e]): [string, NostrEvent, number] => [k, e, JSON.stringify(e).length])
        .sort((a, b) => (this.effExp.get(a[1].id) ?? 0) - (this.effExp.get(b[1].id) ?? 0));
    const usageOf = (borrowed: boolean): Map<string, number> => {
      const usage = new Map<string, number>();
      for (const [, e, n] of others(borrowed)) usage.set(e.pubkey, (usage.get(e.pubkey) ?? 0) + n);
      return usage;
    };
    let borrowedTotal: number | undefined;
    const borrowed = (): number => (borrowedTotal ??= others(true).reduce((a, [, , n]) => a + n, 0));
    let plan: { key: string; owner: string; bytes: number; id: string }[] = [];
    const decision = decideCapacity({
      max,
      used,
      need: size,
      evicts: this.opts.ceilingEvicts === true,
      guarantee,
      band,
      planeBorrows: this.opts.addressableBorrows !== false,
      borrowed,
      withinGuarantee: () => (usageOf(false).get(pubkey) ?? 0) + size <= guarantee!,
      excessAvailable: () => {
        const usage = usageOf(false);
        const candidates = others(false)
          .filter(([, e]) => e.pubkey !== pubkey && (usage.get(e.pubkey) ?? 0) > guarantee!)
          .map(([k, e, n]) => ({ key: k, owner: e.pubkey, bytes: n, id: e.id }));
        const picked = pickExcess(candidates, usage, guarantee!, used - borrowed() + size - max);
        plan = picked.rows;
        return picked.freed;
      },
      borrowFitsPerKey: () =>
        (usageOf(true).get(pubkey) ?? 0) + size <= borrowPerKey(band, this.opts.borrowPerKeyBytes),
    });
    const drop = (k: string, id: string): void => {
      this.addressable.delete(k);
      this.borrowedAddr.delete(k);
      this.effExp.delete(id);
    };
    switch (decision.type) {
      case "fit":
        return { borrowed: false };
      case "borrow":
        return { borrowed: true };
      case "reject":
        return undefined;
      case "reclaim":
        for (const [k, e, n] of others(true)) {
          if (used + size <= max) break;
          drop(k, e.id);
          used -= n;
        }
        return { borrowed: false };
      case "excess":
        for (const [k, e] of others(true)) drop(k, e.id);
        for (const row of plan) drop(row.key, row.id);
        return { borrowed: false };
      case "legacy": {
        // v0.33 原樣：依到期時間由近而遠淘汰，直到騰得出空間
        const byExpiry = [...this.addressable.entries()]
          .filter(([k]) => k !== key)
          .sort((a, b) => (this.effExp.get(a[1].id) ?? 0) - (this.effExp.get(b[1].id) ?? 0));
        for (const [k, e] of byExpiry) {
          if (used + size <= max) break;
          used -= JSON.stringify(e).length;
          drop(k, e.id);
        }
        return used + size <= max ? { borrowed: false } : undefined;
      }
    }
  }

  /** 事件還在任何一個離線桶裡嗎。 */
  private stillStored(id: string): boolean {
    if (this.noRecipient.some((e) => e.id === id)) return true;
    for (const bucket of this.byRecipient.values()) if (bucket.some((e) => e.id === id)) return true;
    return false;
  }

  /** 忘掉一顆不再存在的離線事件的附帶資料（到期時間、借用、序號）。 */
  private forgetOffline(id: string): void {
    this.effExp.delete(id);
    this.borrowedIds.delete(id);
    this.seq.delete(id);
  }

  /** 刪掉一列（某位收件人的那一份），回傳釋放的位元組；記進丟棄計數。 */
  private dropRow(event: NostrEvent, recipient: string, nowSec: number): number {
    let freed = 0;
    const keep = (e: NostrEvent): boolean => {
      if (freed > 0 || e.id !== event.id) return true;
      freed = JSON.stringify(e).length;
      return false;
    };
    if (recipient === "") {
      this.noRecipient = this.noRecipient.filter(keep);
    } else {
      const bucket = this.byRecipient.get(recipient);
      if (bucket) {
        const next = bucket.filter(keep);
        if (next.length === 0) this.byRecipient.delete(recipient);
        else this.byRecipient.set(recipient, next);
      }
    }
    if (freed > 0) {
      this.noteDropped(recipient, event, nowSec);
      if (!this.stillStored(event.id)) this.forgetOffline(event.id);
    }
    return freed;
  }

  /**
   * 整批淘汰（SDK ADR 0085）：中繼自己刪掉的檔案塊，同一收件人、同一個 `expiration` 標籤（＝同一次送出）的其餘檔案塊一起刪，
   * 回傳釋放的位元組。只刪一部分會切出永遠收不齊的孤兒：佔空間到過期、每次補拉都被整批再下載。
   * 批次靠中繼本來就看得到的值判斷（不加任何元資料）；同一秒送給同一人的另一則可能被一起刪（ADR 0085 已知取捨）。
   */
  private dropBatchMates(dropped: readonly { event: NostrEvent; recipient: string }[], nowSec: number): number {
    const batches = new Map<string, Set<number>>();
    for (const { event, recipient } of dropped) {
      const batch = batchOf(event);
      if (batch === undefined || recipient === "") continue;
      const set = batches.get(recipient) ?? new Set<number>();
      set.add(batch);
      batches.set(recipient, set);
    }
    let freed = 0;
    for (const [recipient, set] of batches) {
      const mates = (this.byRecipient.get(recipient) ?? []).filter((e) => set.has(batchOf(e) ?? NaN));
      for (const e of mates) freed += this.dropRow(e, recipient, nowSec);
    }
    return freed;
  }

  /** 從所有桶移除某個 id，回傳釋放的位元組（v0.33 的淘汰）。`removed` 給了就把移除的列放進去。 */
  private dropOffline(id: string, nowSec: number, removedOut?: { event: NostrEvent; recipient: string }[]): number {
    let freed = 0;
    const removed: { event: NostrEvent; recipient: string }[] = [];
    const keep = (recipient: string) => (e: NostrEvent): boolean => {
      if (e.id !== id) return true;
      freed += JSON.stringify(e).length;
      removed.push({ event: e, recipient });
      return false;
    };
    this.noRecipient = this.noRecipient.filter(keep(""));
    for (const [recipient, bucket] of this.byRecipient) {
      const next = bucket.filter(keep(recipient));
      if (next.length === 0) this.byRecipient.delete(recipient);
      else this.byRecipient.set(recipient, next);
    }
    for (const { event, recipient } of removed) this.noteDropped(recipient, event, nowSec);
    if (freed > 0) this.forgetOffline(id);
    removedOut?.push(...removed);
    return freed;
  }

  /**
   * 寄給 `recipient` 的一則被刪掉了（FIFO、天花板淘汰、借用到期）：記進丟棄計數（SDK ADR 0042）。
   * 不計：沒開 `countDrops`、沒有收件人、收件人正在線上收收件匣（即時收到了）、在上次送到的水位線以前就存了（送到過）。
   */
  private noteDropped(recipient: string, event: NostrEvent, nowSec: number): void {
    if (this.opts.countDrops !== true || recipient === "" || this.inboxProbe(recipient)) return;
    const entry = this.drops.get(recipient);
    if ((this.seq.get(event.id) ?? 0) <= (entry?.mark ?? 0)) return;
    this.drops.set(recipient, {
      summary: mergeDropped(entry?.summary, 1, event.created_at, event.created_at),
      mark: entry?.mark ?? 0,
      updatedAt: nowSec,
    });
    if (this.drops.size > DROPPED_RECIPIENTS_MAX) {
      let oldest: string | undefined;
      let at = Infinity;
      for (const [r, e] of this.drops) if (e.updatedAt < at) [oldest, at] = [r, e.updatedAt];
      if (oldest !== undefined) this.drops.delete(oldest);
    }
  }

  takeDropped(recipient: string, nowSec: number): DroppedSummary | undefined {
    if (this.opts.countDrops !== true) return undefined;
    const summary = this.drops.get(recipient)?.summary;
    this.drops.set(recipient, { mark: this.nextSeq - 1, updatedAt: nowSec });
    return summary !== undefined && summary.count > 0 ? summary : undefined;
  }

  markDelivered(recipient: string, nowSec: number): void {
    if (this.opts.countDrops !== true) return;
    const entry = this.drops.get(recipient);
    this.drops.set(recipient, { ...(entry?.summary ? { summary: entry.summary } : {}), mark: this.nextSeq - 1, updatedAt: nowSec });
  }

  ackInbox(recipient: string, ids: readonly string[], expiresAt: number, nowSec: number): number {
    const bucket = this.byRecipient.get(recipient);
    if (!bucket) return 0;
    const wanted = new Set(ids);
    let lowered = 0;
    for (const event of bucket) {
      if (!wanted.has(event.id) || this.isExpired(event, nowSec)) continue;
      const others = recipientsOf(event);
      if (others.length !== 1 || others[0] !== recipient) continue;
      const exp = this.effExp.get(event.id) ?? getExpiration(event);
      if (exp !== undefined && exp <= expiresAt) continue;
      this.effExp.set(event.id, expiresAt);
      lowered += 1;
    }
    return lowered;
  }

  /** 寫入一筆留言；若已過期則拒絕並回 false。 */
  put(event: NostrEvent, nowSec: number): boolean {
    return this.putResult(event, nowSec).ok;
  }

  /** 同 {@link put}，說出結果的細節（SDK ADR 0042）。 */
  putResult(event: NostrEvent, nowSec: number): OfflinePutResult {
    if (this.isExpired(event, nowSec)) return { ok: false, reason: "expired" };
    const recipients = recipientsOf(event);
    // 一則事件在每位收件人底下各存一份（SQL 版就是各一列），天花板要照這個算。
    const copies = Math.max(1, recipients.length);
    const owners = [...new Set(recipients.length > 0 ? recipients : [event.pubkey])];
    const placed = this.placeOffline(JSON.stringify(event).length, copies, owners, nowSec);
    if (placed === undefined) return { ok: false, reason: "ceiling" };
    const ttl = this.opts.borrowTtlSeconds ?? BORROW_TTL_SECONDS;
    const eff = effectiveExpiration(event, nowSec, this.opts.maxTtlSeconds);
    this.effExp.set(event.id, placed.borrowed ? borrowedExpiration(eff, nowSec, ttl) : eff);
    if (placed.borrowed) this.borrowedIds.add(event.id);
    else this.borrowedIds.delete(event.id);
    this.seq.set(event.id, this.nextSeq++);
    if (recipients.length === 0) {
      this.noRecipient.push(event);
    } else {
      for (const recipient of recipients) {
        const bucket = this.byRecipient.get(recipient) ?? [];
        bucket.push(event);
        this.byRecipient.set(recipient, bucket);
      }
      this.enforceCap(recipients, nowSec);
    }
    if (placed.borrowed) return { ok: true, borrowedTtlSec: ttl };
    const nearFull = nearFullGrade(this.offlineBytes(), this.opts.offlineMaxTotalBytes, this.opts.nearFullPercent);
    return nearFull === undefined ? { ok: true } : { ok: true, nearFull };
  }

  /**
   * 查詢符合 filter 且未過期的留言。
   *
   * 回傳筆數與 SQL 版一樣有界（ADR-0235 C2）——兩個實作共用同一份 `OfflineStore` 契約，
   * 行為分歧會讓「用記憶體版寫的測試」保證不了產線的 SQL 版。
   */
  query(filter: RelayFilter, nowSec: number, maxBytes?: number): NostrEvent[] {
    const candidates = this.candidatesFor(filter);
    const hit = candidates.filter((e) => !this.isExpired(e, nowSec) && matchFilter(filter, e));
    const limit = queryLimit(filter.limit);
    if (hit.length <= limit && maxBytes === undefined) return hit;
    // 超量時取**最新**的（與 SQL 版的 `ORDER BY created_at DESC LIMIT ?` 一致）。
    const newest = [...hit].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
    if (maxBytes === undefined) return newest;
    // 位元組預算（Cinderous ADR-0371 §決策 6）：與 SQL 版同一個規則——由新到舊，放不下就停。
    const out: NostrEvent[] = [];
    let spent = 0;
    for (const e of newest) {
      const n = JSON.stringify(e).length;
      if (spent + n > maxBytes) break;
      spent += n;
      out.push(e);
    }
    return out;
  }

  /** 清除所有已過期留言。借用列到期算丟棄（SDK ADR 0042）；一般的保存期到期不算——那是宣告過的契約。 */
  prune(nowSec: number): void {
    const survivors = new Set<string>();
    // 借用列到期（2 小時）：同一批正常存放的也一起刪（SDK ADR 0085），否則借用的那幾塊一走就剩下收不齊的
    const borrowedGone: { event: NostrEvent; recipient: string }[] = [];
    for (const [recipient, bucket] of this.byRecipient) {
      const kept = bucket.filter((e) => {
        if (!this.isExpired(e, nowSec)) return true;
        if (this.borrowedIds.has(e.id)) {
          this.noteDropped(recipient, e, nowSec);
          borrowedGone.push({ event: e, recipient });
        }
        return false;
      });
      if (kept.length > 0) this.byRecipient.set(recipient, kept);
      else this.byRecipient.delete(recipient);
      for (const e of kept) survivors.add(e.id);
    }
    this.dropBatchMates(borrowedGone, nowSec);
    for (const bucket of this.byRecipient.values()) for (const e of bucket) survivors.add(e.id);
    this.noRecipient = this.noRecipient.filter((e) => !this.isExpired(e, nowSec));
    for (const e of this.noRecipient) survivors.add(e.id);
    // 可尋址事件（ADR-0071）：過期即回收（棄用帳號的快照空間自動釋放）
    for (const [key, e] of this.addressable) {
      if (this.isExpired(e, nowSec)) {
        this.addressable.delete(key);
        this.borrowedAddr.delete(key);
      } else survivors.add(e.id);
    }
    // 同步清 effExp（避免 id → 到期時間的殘留成為另一種孤兒）
    for (const id of this.effExp.keys()) {
      if (!survivors.has(id)) this.forgetOffline(id);
    }
    // 丟棄計數只留一個保存期：更久沒動的收件人，那些留言本來也會到期（SDK ADR 0042）
    const keepFor = this.opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    for (const [r, e] of this.drops) if (e.updatedAt <= nowSec - keepFor) this.drops.delete(r);
  }

  /** NIP-62 清除（ADR-0260）：刪掉此人發的、寄給他的、以及他的可尋址事件。 */
  vanish(pubkey: string, _nowSec: number): number {
    const removed = new Set<string>();

    // 1. 寄給他的：整個收件人桶（Gift Wrap 外層是一次性金鑰，`p` 是唯一的鍵）。
    for (const e of this.byRecipient.get(pubkey) ?? []) removed.add(e.id);
    this.byRecipient.delete(pubkey);

    // 2. 他發的：掃其餘桶（他可能是別人收件匣裡的作者——裸事件如心跳並不封裝）。
    for (const [recipient, bucket] of this.byRecipient) {
      const kept = bucket.filter((e) => {
        if (e.pubkey !== pubkey) return true;
        removed.add(e.id);
        return false;
      });
      if (kept.length > 0) this.byRecipient.set(recipient, kept);
      else this.byRecipient.delete(recipient);
    }
    this.noRecipient = this.noRecipient.filter((e) => {
      if (e.pubkey !== pubkey) return true;
      removed.add(e.id);
      return false;
    });

    // 3. 他的可尋址事件（ADR-0071 雲端快照）。
    for (const [key, e] of this.addressable) {
      if (e.pubkey !== pubkey) continue;
      removed.add(e.id);
      this.addressable.delete(key);
      this.borrowedAddr.delete(key);
    }

    // 4. 他的丟棄計數（SDK ADR 0042）：清除就是一切。
    this.drops.delete(pubkey);

    // 同一顆事件可能同時存在於多個收件人桶——只有**確定沒有任何一份倖存**時才收 effExp，
    // 否則會讓其他收件人手上那份失去到期時間（`isExpired` 退回 tag，永存縫隙就回來了）。
    const survivors = new Set<string>();
    for (const bucket of this.byRecipient.values()) for (const e of bucket) survivors.add(e.id);
    for (const e of this.noRecipient) survivors.add(e.id);
    for (const e of this.addressable.values()) survivors.add(e.id);
    for (const id of removed) if (!survivors.has(id)) this.forgetOffline(id);

    return removed.size;
  }

  /** 依 filter 縮小候選集合：帶 `#p` 時僅取相關收件人桶，否則全掃。 */
  private candidatesFor(filter: RelayFilter): NostrEvent[] {
    const pValues = filter["#p"];
    if (pValues && pValues.length > 0) {
      return dedupById(pValues.flatMap((r) => this.byRecipient.get(r) ?? []));
    }
    return this.allEvents();
  }

  private allEvents(): NostrEvent[] {
    const all: NostrEvent[] = [];
    for (const bucket of this.byRecipient.values()) all.push(...bucket);
    all.push(...this.noRecipient);
    all.push(...this.addressable.values()); // 快照走 authors+kinds 查詢（無 `#p`）
    return dedupById(all);
  }

  private isExpired(event: NostrEvent, nowSec: number): boolean {
    const exp = this.effExp.get(event.id) ?? getExpiration(event);
    return exp !== undefined && exp <= nowSec;
  }

  private enforceCap(recipients: string[], nowSec: number): void {
    const cap = this.opts.maxPerRecipient;
    const fileCap = this.opts.filePerRecipient ?? DEFAULT_FILE_PER_RECIPIENT;
    for (const recipient of recipients) {
      const bucket = this.byRecipient.get(recipient);
      if (!bucket) continue;
      // ADR-0162：檔案塊（1060）與聊天留言**分桶計數**——由新到舊各自保留至上限。
      const sorted = [...bucket].sort((a, b) => a.created_at - b.created_at);
      const keptReversed: NostrEvent[] = [];
      const trimmed: NostrEvent[] = [];
      let chat = 0;
      let file = 0;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const e = sorted[i]!;
        if (e.kind === FILE_WRAP_KIND) {
          if (file >= fileCap) {
            trimmed.push(e);
            continue;
          }
          file++;
        } else if (cap !== undefined) {
          if (chat >= cap) {
            trimmed.push(e);
            continue;
          }
          chat++;
        }
        keptReversed.push(e);
      }
      this.byRecipient.set(recipient, keptReversed.reverse());
      for (const e of trimmed) {
        this.noteDropped(recipient, e, nowSec);
        if (!this.stillStored(e.id)) this.forgetOffline(e.id);
      }
      this.dropBatchMates(trimmed.map((event) => ({ event, recipient })), nowSec); // 整批淘汰（SDK ADR 0085）
    }
  }
}
