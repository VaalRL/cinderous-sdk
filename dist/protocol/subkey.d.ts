import { type NostrEvent } from "./event.js";
import { type PubkeyHex, type SecretKey } from "./keys.js";
import { type Opened, type RecipientKeyLike } from "./nip59.js";
import type { NostrSigner, SecretKeyOrSigner } from "./signer.js";
/** EK 公告事件 kind（ADR-0245；接續 10037/10038/10039 的可取代事件範圍）。 */
export declare const EK_ANNOUNCE_KIND = 10040;
/** FS 能力宣告版本字串（ADR-0245）：寫進簽章個人檔的 `fs` 欄位供 TOFU 釘選/降級偵測。 */
export declare const FS_CAPABILITY = "ek-v1";
/**
 * 混合式（後量子）EK 的能力值（ADR-0365 Phase 4b）。
 *
 * 比 `ek-v1` **強**：同樣的輪替與刪除性質，外加「今天被側錄的密文未來解不開」。
 * 長度 8 ≤ `FS_CAPABILITY_MAX_LEN`（超過會被 `parseProfile` 整欄丟掉而**靜默失效**）。
 *
 * ⚠ 宣告它的條件與 `EK_PQ_ANNOUNCE` **綁在一起**：沒有真的公告 `pq` 就宣告這個值，
 * 是在說一件沒在跑的事（ADR-0302 §4 的紅線），而且會讓每個舊版聯絡人白白記進
 * `unsupported`。兩者必須同時成立。
 */
export declare const FS_CAPABILITY_PQ = "ek-pq-v1";
/**
 * **明示退場**的能力值（ADR-0306 D3.3）：宣告「我不再做 FS」。
 *
 * 為什麼需要一個明示值，而不是把欄位拿掉：欄位缺席與「刻意停止」在收件端**看起來一樣**，
 * 而後者會讓已釘選的對方永遠觸發降級警告（`fsWouldDowngrade`），
 * 那句警告的意思是「對方可能正在被攻擊」——**停用與被攻擊無法區分**。
 *
 * 安全性由 ADR-0245 §81 的既有性質保證：`fs` 寫在**簽章個人檔**內、**不可偽造**
 * ⇒ 攻擊者無法偽造退場宣告來剝奪你的 FS，只能扣住你的新個人檔，
 * 而那樣對方仍看到舊的 `ek-v1`、仍然警告 ⇒ **失敗方向落在安全側**。
 */
export declare const FS_RETIRED = "none";
/**
 * 能力字串的長度上限（**與 `profile.ts` 的實際限制對齊**）。
 *
 * ⚠ `parseProfile` 只收 `fs.length <= 16`，超過即**丟棄整個欄位** ⇒ 對方會被判為
 * `absent`（沒有宣告）而不是 `unknown`（宣告了我不認得的機制）——**靜默失效**，
 * 收件端完全看不出對方宣告過什麼。故**新增能力值時必須先過這一關**。
 */
export declare const FS_CAPABILITY_MAX_LEN = 16;
/**
 * 對方的 FS 能力宣告，解讀為四種**互斥**狀態（ADR-0306 D3.3c／ADR-0302 §1–2）。
 *
 * - `fs`：正在做我們支援的 FS（**凡在 `FS_SCHEME_RANK` 內者**：`ek-v1`／`ek-pq-v1`）⇒ TOFU 釘選。
 * - `retired`：**明示停止**（硬退）⇒ 應解除釘選，不得再發降級警告。
 * - `unknown`：宣告了我們不認得的機制（例如日後的 `ek-v2`／`ratchet-v1`）
 *   ⇒ 對方是**升級**不是降級；⚠ 舊碼把它與 `absent` 混為一談（ADR-0302 §2 指出
 *   那個「碰巧安全但語意錯誤」的缺陷）。
 * - `absent`：沒有宣告（今天絕大多數聯絡人）。
 */
export type FsCapability = "fs" | "retired" | "unknown" | "absent";
/**
 * 解讀簽章個人檔的 `fs` 欄位。不信任網路來源：非字串／空白一律當 `absent`。
 *
 * 🔴 **「我們支援哪些機制」一律由 `FS_SCHEME_RANK` 決定，不得再寫死一個字串**（ADR-0365）。
 * 原本這裡是 `v === FS_CAPABILITY`，於是加入 `ek-pq-v1` 的那一刻，**同一個版本的兩台
 * 客戶端會互相判成「宣告了我不認得的機制，請更新」**——雙方都是最新版，卻都叫對方更新。
 * 強度表與「認不認得」必須是同一份事實。
 */
export declare function readFsCapability(fs: unknown, rank?: Readonly<Record<string, number>>): FsCapability;
/** rumor 內嵌 EK hint 的 tag 名（比照 ADR-0035 relay hint；夾在**加密內層** rumor、中繼看不到）。 */
export declare const EK_HINT_TAG = "ek";
/**
 * EK grace 窗（毫秒）：預設 7 天。一把 EK 被更新的一把**取代**後，仍保留 grace 供解在途訊息；
 * 超窗即刪（刪除紀律＝FS 真正生效的下半場）。current（最新）永不刪。
 */
export declare const FS_GRACE_MS: number;
/**
 * 自動輪替間隔（毫秒；ADR-0313）：預設 7 天，**與 grace 相同是刻意的**——
 * 每 7 天輪替 ＋ 舊把被取代 7 天後回收 ⇒ 穩態下手上恆為 2 把（current ＋ 一把 grace 內）。
 *
 * 為什麼需要自動：FS 來自「刪掉舊金鑰」，而 `pruneFsKeys` 保證 current 永不刪
 * ⇒ **從不輪替＝priv(EK) 永遠活著＝零 FS**。啟用卻不輪替的使用者以為自己受保護，
 * 那比沒開更糟。這個紀律不該外包給使用者的記性（ADR-0313）。
 */
export declare const FS_ROTATE_INTERVAL_MS: number;
/**
 * 現在該不該輪替 EK（ADR-0313）：current（最大 `at`）的年齡達到間隔即回 true。
 *
 * 看的是**金鑰年齡**而非計時器，因為 App 大部分時間是關著的——計時器在關閉期間不跑，
 * 重啟又從零計時，一個每天開關 App 的使用者可能永遠輪不到。年齡把離線期間也算進去。
 *
 * 無金鑰（尚未啟用）回 false——生成第一把是 `enableFs` 的事，不是輪替。
 */
export declare function shouldRotateFs<T extends {
    at: number;
}>(keys: T[], now: number, intervalMs?: number): boolean;
/**
 * 依 grace 修剪 EK 金鑰（ADR-0245 刪除紀律）：保留 current（最大 `at`）＋「被取代未逾 grace」者；
 * 逾 grace 的舊 EK 回收（＝真正刪除，之後被側錄的密文再也解不開）。純函式；`now` 由呼叫端傳入。
 */
export declare function pruneFsKeys<T extends {
    at: number;
}>(keys: T[], now: number, graceMs?: number): T[];
/** 一筆 TOFU 釘選（ADR-0302 §3）。 */
export interface FsPin {
    /** 曾見過**最強**的機制（TOFU 基準）——**只升不降**，見 `pinAfterDeclare`。 */
    scheme: string;
    /** 這個 `scheme` 被釘上的時間（毫秒）。 */
    at: number;
    /**
     * 對方**目前**宣告的機制；與 `scheme` 相同時省略。
     * 有值＝對方退回了較弱的機制＝降級證據（送訊時據此警告）。
     */
    declared?: string;
}
/** 儲存形。⚠ 舊資料（與舊版客戶端送來的快照）是 `true`，**會一直存在**，見 `readPin`。 */
export type StoredFsPin = FsPin | true;
/**
 * 讀一筆釘選，**吸收舊的布林形**（ADR-0302 §3：`true` 視為 `{ scheme: "ek-v1", at: 0 }`）。
 *
 * `at: 0` 是刻意的——我們不知道它何時被釘上，而假造一個「現在」會讓它看起來比實際新。
 */
export declare function readPin(v: StoredFsPin | undefined): FsPin | undefined;
/**
 * 已知機制的強度序（ADR-0302 §3）。**未列出的一律視為「不可比」**，不是「較弱」。
 *
 * ⚠ **這張表不保證是全序。** 目前只有一項所以看不出來，但選項空間其實有兩個軸——
 * 「共用金鑰 vs per-device session」與「古典 vs 後量子」。`ek-pq-v1`（後量子但無 PCS）
 * 與 `ratchet-v1`（有 PCS 但非後量子）**各有對方沒有的東西**，用一個整數排不出來。
 * 真要加第二個軸時這裡要換成偏序，而 `compareFsStrength` 的 `"incomparable"`
 * 已經替那一天留好位置（見 `docs/research/double-ratchet-on-current-design.md` §1.1）。
 */
export declare const FS_SCHEME_RANK: Readonly<Record<string, number>>;
/** 兩個機制的強度關係。`"incomparable"` 涵蓋「不認得」與「兩軸各有勝負」。 */
export type FsStrength = "weaker" | "same" | "stronger" | "incomparable";
/**
 * 比較 `a` 相對於 `b` 的強度（ADR-0302 §3）。
 *
 * 🔴 **不認得的一律回 `"incomparable"`，不回 `"weaker"`。** 那是安全側的預設：
 * 把「我沒聽過這個機制」當成降級，就是把「你該更新」講成「對方可能被攻擊」
 * ——ADR-0302 §4 的紅線。那種情形由 `markFsUnsupported` 走另一條路處理。
 */
export declare function compareFsStrength(a: string, b: string, rank?: Readonly<Record<string, number>>): FsStrength;
/**
 * 收到對方的能力宣告後，算出新的釘選（ADR-0302 §3）。純函式，供引擎與測試共用。
 *
 * 規則只有一條，但它是整個 TOFU 的根：**`scheme` 只升不降**。
 * 若允許較弱的宣告覆蓋釘選，攻擊者只要宣告弱的就能把基準拉低 ⇒ 釘選形同虛設。
 * 較弱的宣告改記進 `declared`，讓送訊時警告得出來。
 */
export declare function pinAfterDeclare(prev: StoredFsPin | undefined, scheme: string, now: number, rank?: Readonly<Record<string, number>>): FsPin;
/**
 * 合併兩筆釘選，**取較強的**（ADR-0302 §3；雲端快照與配對捆包用）。
 *
 * 🔴 原本的合併是「union，本機優先」。換成記強度之後那會**拉低基準**：
 * 遠端若釘了較強的機制而本機還在較弱的，本機優先就等於把較強的那筆丟掉。
 * TOFU 的「一台釘＝全釘」推廣到多強度，正確的形狀是**取最強**。
 *
 * 降級證據（`declared`）只在**兩邊基準相同**時保留——基準不同時取較強的那一筆，
 * 而較弱那一筆的「目前宣告」對較強的基準沒有意義。
 */
export declare function strongerPin(a: StoredFsPin | undefined, b: StoredFsPin | undefined, rank?: Readonly<Record<string, number>>): FsPin | undefined;
/**
 * 只有「他有 EK」這個證據、**不知道是哪一版機制**時的釘選（ADR-0365）。
 *
 * 🔴 **存在的理由是一個假警報。** 訊息內嵌的 `ek` hint（ADR-0245／0326）只說明對方有 EK，
 * 不帶版本。在只有一階的世界裡拿 `FS_CAPABILITY` 去 `pinAfterDeclare` 是無害的；
 * 但 `ek-pq-v1` 進來之後，那個呼叫對一個已釘在 `ek-pq-v1` 的對方會判成 `"weaker"`
 * ⇒ 寫下 `declared: "ek-v1"` ⇒ `pinIsDowngraded` 為真 ⇒ 送訊時跳
 * 「對方退回較弱的機制」——**而對方什麼都沒做，他只是傳了一則訊息給我**。
 *
 * ⇒ 規則：**已經釘過就完全不動**（不動基準、也不寫降級證據）；沒釘過才以 `fallback` 建立。
 * 真正的降級只能由**帶版本的來源**判定：kind 10040 的 `v`，或簽章個人檔的 `fs` 宣告。
 */
export declare function pinOnEvidence(prev: StoredFsPin | undefined, fallback: string, now: number): FsPin;
/** 這筆釘選代表「對方退回了較弱的機制」嗎（ADR-0302 §3 的降級判據之一）。 */
export declare function pinIsDowngraded(v: StoredFsPin | undefined): boolean;
/**
 * 解封失敗的觀測記錄（ADR-0316）。
 *
 * **桶名帶著不確定性是刻意的。** 密碼學上無法區分「我沒有正確的金鑰」與「這段密文是垃圾」——
 * NIP-44 兩者都是 MAC 驗證失敗。唯一確定的方向是**不對稱**的：從未持有過 EK 時的失敗
 * 確定與 FS 無關；有或曾有 EK 時則無法區分。把 `maybeEkLoss` 叫成 `ekLoss` 會讓下一個
 * 讀這段程式的人把猜測當成事實。
 */
export interface FsFailureLog {
    /** 從未持有過 EK 時的失敗＝**確定與 FS 無關**（畸形事件／不是給我的）。不對使用者顯示。 */
    notFs: number;
    /** 有或曾有 EK 時的失敗＝**可能**是 EK 已回收，也可能只是畸形事件。 */
    maybeEkLoss: number;
    /** 最後一次 `maybeEkLoss` 的時間（毫秒）；供 UI 顯示與比對最近一次輪替。 */
    lastEkLossAt?: number;
}
/** 空記錄（舊存檔缺欄位時的預設）。 */
export declare const EMPTY_FS_FAILURE_LOG: FsFailureLog;
/**
 * 一顆**暫時解不開**、留著等 EK 同步回來再試的事件（ADR-0325）。
 *
 * `openWrapWithEks` 的註解一直寫著「全部失敗＝拋（呼叫端顯示未解、**待 EK 同步後重試**）」，
 * 但 ADR-0316 §決策-6 把保留列為獨立後續、當時不做——這裡把那件事補上。
 */
export interface PendingFsEvent {
    /** 外層 wrap 的事件 id（去重用）。 */
    id: string;
    /** 留下來的時間（毫秒）——TTL 從這裡算，不是事件的 `created_at`（那由寄件人控制）。 */
    at: number;
    /** 原始事件 JSON。 */
    json: string;
}
/**
 * 保留上限。
 *
 * 🔴 **這個清單是攻擊者填得進來的**：密碼學上分不出「缺 EK」與「垃圾密文」（ADR-0316），
 * 所以任何人朝我送 `#p` 垃圾都會被留下來。上限與 TTL 不是效能考量，是**濫用防線**。
 */
export declare const FS_PENDING_MAX = 50;
/** 保留期限：30 天。EK 若 30 天還沒同步回來，那台裝置多半也不會回來了。 */
export declare const FS_PENDING_TTL_MS: number;
/** 丟掉逾期的。 */
export declare function prunePendingFs(list: PendingFsEvent[], now: number): PendingFsEvent[];
/**
 * 留下一顆解不開的事件。
 *
 * - **同一顆不重複留**（跨中繼會收到同一顆好幾次）——已在清單內就**原樣回傳**，
 *   呼叫端可據此跳過一次寫入（ADR-0316 已提醒過「每次失敗都寫一次儲存」）。
 * - 滿了**丟最舊的**。⚠ 這代表**灌爆可以把真的擠掉**——分不出真假就沒有更好的排序依據，
 *   已記在 ADR-0325〈買不到什麼〉。
 */
export declare function retainPendingFs(list: PendingFsEvent[], entry: PendingFsEvent, now: number): PendingFsEvent[];
/**
 * 記一次解封失敗（純 reducer）。`hadEk`＝我現在有或曾經有過 EK。
 * 不變更輸入。
 */
export declare function recordFsFailure(log: FsFailureLog, at: number, hadEk: boolean): FsFailureLog;
/** 加密子鑰對（傳輸金鑰，非身分）。 */
export interface EncryptionKey {
    sk: SecretKey;
    pk: PubkeyHex;
}
/** 生成一把獨立隨機 EK（**不可**從 nsec 導出，否則無 FS）。 */
export declare function generateEncryptionKey(): EncryptionKey;
/**
 * 建構 kind 10040 EK 公告（由 IK 簽章）：內容帶**當前**（`ek`）與可選**下一把**（`next`）公鑰。
 * 可取代事件＝每身分只留最新一顆；供「首次接觸/查詢」發現對方當前 EK。
 */
export declare function buildEkAnnounce(
/** 身分私鑰，或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
ikSk: SecretKeyOrSigner, ekPk: PubkeyHex, opts?: {
    next?: PubkeyHex;
    now?: number;
    /**
     * 後量子封裝金鑰（base64；Phase 2）。**給了才發 `v: 2`。**
     *
     * 🔴 預設不給、預設仍發 `v: 1` 是**順序紅線**（計畫 §5）：
     * 還沒更新的客戶端讀到 `v: 2` 會回 `null` ⇒ 在它眼中對方「沒有 EK」
     * ⇒ 送訊時跳「疑似降級（對方可能正在被攻擊）」
     * ⇒ **第一個升級的人會被所有舊版聯絡人誤報成被攻擊**。
     *
     * 形狀同 ADR-0358 的金鑰輪替並存期：**先發布讀得懂 v2 的版本 → 等普及 → 才開始發 v2**。
     */
    pq?: string;
    /** 下一週的後量子封裝金鑰（消除週界空窗；同 `next` 的理由）。 */
    nextPq?: string;
}): NostrEvent;
/**
 * kind 10040 公告的 `content`（SDK ADR 0010：從 `buildEkAnnounce` 抽出，
 * 讓不交出私鑰的簽章者——例如 SDK 的 `Identity`——也能發出同一種格式）。
 */
export declare function ekAnnounceContent(ekPk: PubkeyHex, opts?: {
    next?: PubkeyHex;
    pq?: string;
    nextPq?: string;
}): string;
/**
 * 驗證並解析 kind 10040 公告（不信任網路來源）：檢查 kind、簽章、內容格式與公鑰合法性。
 * 回 `{ ik, ek, next? }`（`ik`＝公告者身分＝`event.pubkey`）；任何不合法 → `null`。
 */
/** EK 公告的古典版本（`buildEkAnnounce` 預設寫進 `content.v`）。 */
export declare const EK_ANNOUNCE_VERSION = 1;
/**
 * 後量子公告版本（Phase 2）。⚠ **讀得懂 ≠ 發得出**——
 * `buildEkAnnounce` 只有在明確給了 `pq` 時才發這一版，理由見該函式的 `pq` 說明。
 */
export declare const EK_ANNOUNCE_PQ_VERSION = 2;
/**
 * 🚦 **整個後量子推行只有這一個開關**（ADR-0365 Phase 4b）。
 *
 * `true` ＝ 我的 kind 10040 公告帶 `pq`（`v:2`），升級過的對方會用混合式加密給我；
 * 同時個人檔宣告 `FS_CAPABILITY_PQ`。兩件事**必須同時**發生，理由見該常數。
 *
 * ## 為什麼一開始是關著的，以及憑什麼現在打開
 *
 * 風險從來不是「陌生人解不開」——那只會退回純古典。真正的風險是
 * **我自己另一台還沒更新的裝置**：它拿得到 EK 私鑰（ADR-0322 S2 分發），卻沒有 pq 種子、
 * 也沒有混合式程式碼 ⇒ 那台上的訊息**永久解不開**（不是延遲，是沒有金鑰）。
 * 公告是可取代事件、全網只有一份，中間沒有協商餘地。
 *
 * 2026-09-21 實測第三方安裝基數：GitHub Releases 史上總下載 **12 次**，
 * 而帶著 v2 讀端的 v0.0.16／v0.0.17 是 **0**；兩座中繼 30 天 requests 2,235 與 74，
 * 且尖峰日與發版日重合 ⇒ 沒有第三方安裝基數要等。
 *
 * ⚠ **但下載量看不到自己的裝置**（v0.0.15 起皆本機建置），而中繼因 ADR-0123 具名訂閱
 * 也數不出身分數。⇒ 這個開關的**真正閘門是發版前的人工確認**：
 * 「我手上每一台裝置都跑到了這一版嗎」（設定→裝置，對照 ADR-0322 目錄）。
 * 程式擋不住這件事——只有一台漏掉，那台就開始永久丟訊。
 *
 * ## 打開之後仍然成立的事
 *
 * - 對方沒升級 ⇒ 我讀到 v1 公告 ⇒ 該則走純古典。**不斷訊**。
 * - 我的 EK 沒有種子（舊金鑰、或被舊版客戶端往返時丟掉）⇒ 仍發 v1。**不說謊**。
 * - 這**不會**讓產品變成「量子安全」：簽章仍是 secp256k1。文案紅線見 `nip59.ts` 檔頭、
 *   ADR-0306 D2.2，以及 `packages/i18n/src/i18n.test.ts` 的後量子文案紅線。
 * - 外部密碼學審計（ADR-0306，期限 2027-01-30）**仍未完成**——FS 整體本來就以
 *   「實驗性、預設關閉、未經審計」出貨，後量子繼承同一個姿態，不是新增一類曝險。
 */
export declare const EK_PQ_ANNOUNCE = true;
/**
 * 讀 kind 10040 公告的結果（ADR-0302 §1）。
 *
 * 🔴 **「不認得的版本」與「垃圾」必須分開。** 兩者都回 `null` 的話，一個**升級了的**對方
 * 在我們眼中就等於「沒有 EK」，而那會讓送訊時跳出「疑似降級（對方可能被攻擊）」
 * ——對升級的人那是謊話（ADR-0302 §2／§4 的紅線）。個人檔那半已於 ADR-0306 D3.3c 做掉，
 * 公告這半一直漏著，而**後量子的公告正是 `v: 2`**：不修的話第一個升級的人就會被誤報。
 */
export type EkAnnounce = {
    kind: "ok";
    ik: PubkeyHex;
    ek: PubkeyHex;
    next?: PubkeyHex;
    /** 後量子封裝金鑰（base64）；`v: 1` 的公告沒有這一欄。 */
    pq?: string;
    nextPq?: string;
}
/** 結構合法、簽章正確，但 `v` 不是我們認得的 ⇒ **對方升級了**，不是壞掉。 */
 | {
    kind: "newer";
    ik: PubkeyHex;
    v: number;
};
/**
 * 驗證並解析 kind 10040 公告（不信任網路來源）。
 *
 * 回 `null` 的只有**真正的壞東西**：kind 不符、簽章錯、content 不是 JSON、
 * 或版本雖認得但欄位不合法。版本不認得但結構完整 → 回 `"newer"`。
 */
export declare function readEkAnnounce(event: NostrEvent): EkAnnounce | null;
/** 在 rumor tags 內設/換上「我的當前 EK」hint（送訊息時夾，對方解開即學到）。只留最新一個。 */
export declare function withEkHint(tags: string[][], ekPk: PubkeyHex): string[][];
/** 讀 rumor tags 內的 EK hint（合法 64-hex 才回，否則 undefined）。 */
export declare function ekHintOf(tags: string[][]): PubkeyHex | undefined;
/**
 * 以多把候選私鑰依序嘗試解封（ADR-0245）：候選＝`[當前 EK sk, …grace 內舊 EK sk, IK sk]`。
 * - EK sk 命中＝正常 FS 解密（訊息到達時解一次，之後走本機封存）。
 * - 退回 IK sk＝向後相容（非 FS 寄件人加密到收件人身分金鑰）。
 * - 全部失敗＝拋（呼叫端顯示未解、待 EK 同步後重試）。nip44 有 MAC，錯鑰必失敗、無假陽性。
 *
 * 候選可以是裸的 `SecretKey`（純古典，現況），也可以是 `{ sk, pqSk }`（混合式，ADR-0365）。
 * 身分那一把也可以直接給 `NostrSigner`（例如 `Identity`；SDK ADR 0023）。
 * ⚠ **混合式候選要帶著展開後的 `pqSk` 進來**：這裡會逐把重試，在迴圈內展開種子等於
 * 每次失敗都多跑一次 keygen；展開與快取是呼叫端的事。
 */
export declare function openWrapWithEks(wrapEvent: NostrEvent, candidateSks: (RecipientKeyLike | NostrSigner)[]): Opened;
//# sourceMappingURL=subkey.d.ts.map