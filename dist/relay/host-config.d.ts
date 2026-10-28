import { type MessageStoreOptions } from "./message-store.js";
import type { RelayCoreOptions } from "./relay-core.js";
/** 每收件人離線留言上限（防單一收件人塞爆免費額度；PRD §8）。 */
export declare const MAX_PER_RECIPIENT = 500;
/** 每連線訂閱數上限（ADR-0119）：客戶端合併後只用 1 個 REQ，16 已極寬鬆。 */
export declare const MAX_SUBSCRIPTIONS = 16;
/** 每 pubkey 每分鐘事件上限（ADR-0235 H1）。真實用量遠低於此（自適應心跳 60/300s）。 */
export declare const MAX_EVENTS_PER_MINUTE = 120;
/**
 * 每連線每分鐘**進站訊息**上限（ADR-0366 §容量）。超過即 NOTICE ＋ 關閉連線。
 *
 * 🔴 為什麼不能只有上面那一條：`MAX_EVENTS_PER_MINUTE` 只數 EVENT，而 Cloudflare 的
 * 計費單位是**進站訊息**。一組 `REQ` ＋ `CLOSE` 就是兩次請求，開了又關可以無限重複，
 * 完全不經過事件限速——健康探針正是這個形狀，實測下來它比整場對局還貴。
 *
 * 240 是「遠高於任何正常客戶端、又擋得住灌水」的一條線：必須**大於**
 * {@link MAX_EVENTS_PER_MINUTE}，否則發事件的人會先撞到這一條，
 * 那等於把事件上限偷偷改小（檔案分塊上傳就是連續的 EVENT）。此不變量由測試釘死。
 */
export declare const MAX_MESSAGES_PER_MINUTE = 240;
/** AUTH 事件最大年齡（秒；ADR-0235 H2）：NIP-42 建議，限制側錄簽名的可用時間。 */
export declare const AUTH_MAX_AGE_SEC = 600;
/** 未來方向時鐘容忍（秒）：沒有合法事件是未來的，只留客戶端時鐘誤差。 */
export declare const MAX_FUTURE_SKEW_SEC: number;
/**
 * 過去方向時鐘容忍（秒）。**必須大於 {@link "@cinderous/client/protocol"!TIMESTAMP_JITTER_SECONDS}**——NIP-59 刻意把外層
 * `created_at` 往前推最多 2 天以免中繼從時序關聯出社交圖譜，設小了會擋掉幾乎每一則 Gift Wrap。
 * 這條不變量由 `host-config.test.ts` 釘死。
 */
export declare const MAX_PAST_SKEW_SEC: number;
/**
 * 重放去重窗（秒）：只快取近期事件的 id。封裝事件不需要（收件端以 rumor.id 去重），
 * 真正要擋的是裸心跳（kind 20000）被重放來偽造「某人在線」。
 */
export declare const REPLAY_WINDOW_SEC: number;
/** TTL 上界（天）：clamp 防 `MAX_TTL_DAYS=99999` 這類手誤產生實質無界保留（ADR-0160）。 */
export declare const TTL_CAP_DAYS = 3650;
/**
 * 兩座宿主共用的濫用防護 `RelayCoreOptions` 片段（ADR-0235 H1）。
 * `store`／`requireAuth`／`acceptFileEvents` 由各宿主自行補上（來源不同）。
 */
export declare const ABUSE_GUARD: {
    readonly maxSubscriptions: 16;
    readonly authMaxAgeSec: 600;
    readonly maxEventsPerMinute: 120;
    readonly maxMessagesPerMinute: 240;
    readonly maxFutureSkewSec: number;
    readonly maxPastSkewSec: number;
    readonly replayWindowSec: number;
};
/**
 * 第三方應用車道的政策（ADR-0366 §決策 5／7）。
 *
 * 與嚴格平面共用整組 {@link ABUSE_GUARD}——**放寬的只有訂閱形狀與認證**，
 * 大小、tag 數、時鐘窗、訂閱數全部原樣。
 *
 * 🔴 `requireAuth: false` 的代價要講清楚：`RelayCore` 的速率桶在無 AUTH 時會退回
 * `event.pubkey`（見 `relay-core.ts` 的註解），而那是發送方自選的 ⇒ **per-pubkey 限速
 * 在這條車道上幾乎沒有牙**。誠實地說，開著 AUTH 也沒好多少（AUTH 只證明你掌握某把私鑰）。
 * 真正要擋的手段是綁「比較貴的東西」：IP 為鍵的 CF rate limit（`/turn` 已有先例）
 * 與 NIP-13 PoW——兩者都列在 ADR-0366 的後續行動，**不在本批**。
 *
 * 為什麼不乾脆要求 AUTH：下游其中一個客戶端的訊息 switch 根本不處理 `["AUTH", …]`
 * （`default: return;`），要求認證等於把它永久鎖在門外。
 */
export declare const APP_LANE_GUARD: {
    readonly publicLane: true;
    readonly requireAuth: false;
    readonly maxSubscriptions: 16;
    readonly authMaxAgeSec: 600;
    readonly maxEventsPerMinute: 120;
    readonly maxMessagesPerMinute: 240;
    readonly maxFutureSkewSec: number;
    readonly maxPastSkewSec: number;
    readonly replayWindowSec: number;
};
/**
 * PoW 難度上限（ADR-0366 P2 #11）。
 *
 * 期望嘗試次數是 `2^difficulty`，所以這個數字實質上是「還挖得動嗎」的界線：
 * 2^32 已經是分鐘級，再往上設就不是防濫用而是拒絕服務——而且是**對誠實使用者**的。
 */
export declare const MAX_POW_DIFFICULTY = 32;
/**
 * 由環境變數算出 PoW 難度（ADR-0366 P2 #11）。未設／壞值／負數 → 0（不要求）。
 */
export declare function powFrom(raw: string | undefined): number;
/** 路由出來的政策代號（`shard.ts` 的 `RelayRoute.profile`）。 */
export type RelayProfile = "strict" | "app";
/**
 * 政策代號 → `RelayCore` 設定片段（ADR-0366）。**兩座宿主的單一真實來源。**
 *
 * 這個函式存在的理由與 `ABUSE_GUARD` 相同（見本檔開頭）：政策若由 worker 與 node-relay
 * 各自拼一份，遲早會漂移成「路由到寬鬆 DO 卻套了嚴格政策」——而那只有在產線才看得出來。
 */
export declare function guardFor(profile: RelayProfile): Partial<RelayCoreOptions>;
/**
 * 本車道的 PoW 難度（ADR-0366 P2 #11）。
 *
 * 🔴 **嚴格平面恆為 0，而且不是設定，是事實**：本專案沒有任何挖礦實作，
 * 客戶端發不出帶 PoW 的事件（ARCHITECTURE §5：「啟用會讓現有安裝無法發訊息」）。
 * core 的 `minePow` 是這一批才加的，現有安裝不會有它。
 *
 * 🔴 **第三方車道預設也是 0**，原因與原本的預期不同：ADR-0366 §決策 7 寫「第三方客戶端
 * 現在才在寫 ⇒ 第一天就要求即無相容性包袱」——但實際查下來，《元素使》的
 * `claude/project-initialization-status-sqvfqh` **已經有能跑的 `packages/nostr`**，
 * 而它發布的可尋址牌組事件是持久化事件 ⇒ 今天打開就會弄壞一個正在運作的客戶端。
 * ⇒ 旋鈕做好、預設關閉，由 `APP_LANE_POW` 在下游備妥挖礦後開啟。
 *
 * ⚠ 打開之前要知道它**打不到**哪裡：PoW 只檢查**持久化**事件（`relay-core` 的
 * `if (!isEphemeral(kind))`）。大廳心跳與信令是 ephemeral ⇒ 不受影響——這正好是對的
 * （它們不佔儲存），但也意味著 PoW 擋不住大廳灌水，那條要靠 IP 限速。
 */
export declare function powForLane(profile: RelayProfile, appLanePowRaw: string | undefined): number;
/**
 * 由 `MAX_TTL_DAYS` 原始字串算出 store 的 `maxTtlSeconds`（ADR-0160）。
 * 未設／壞值／<1 → undefined（＝store 用預設 7 天）；否則 clamp 到 {@link TTL_CAP_DAYS}。
 */
export declare function ttlSecondsFromDays(raw: string | undefined): number | undefined;
/** 由 `MAX_FILE_MB` 原始字串判斷是否接受檔案塊（ADR-0162）：≥1 才收。 */
export declare function acceptFileEvents(raw: string | undefined): boolean;
/**
 * 每顆檔案塊的明文位元組（ADR-0162）。**鏡射** core 的 `FILE_CHUNK_BYTES` 與 SDK 的
 * `RELAY_FRAME_PAYLOAD_BYTES`——relay 看不到明文，只能用這個數字把「MB」換成「塊數」。
 * 包兩層 NIP-44 後每顆事件約 131KB（SDK ADR 0009 實測）。
 */
export declare const FILE_CHUNK_PLAINTEXT_BYTES = 48000;
/** 檔案車道每收件人配額要容得下幾個上限大小的檔案（Cinderous ADR-0371 §決策 3）。 */
export declare const FILE_LANE_QUOTA_FILES = 2;
/** 配額另留的塊數：同步協調訊息、摘要與重送（Cinderous ADR-0371 §決策 3）。 */
export declare const FILE_LANE_QUOTA_SLACK_CHUNKS = 128;
/**
 * **檔案車道那顆 DO** 的離線留言容量天花板（Cinderous ADR-0371 §決策 4）。
 *
 * 一般 DO 的 {@link DO_OFFLINE_MAX_BYTES}（128MB）裝不下兩位收件人各收一個 30MB 檔
 * （一個 30MB 檔在中繼上約 86MB）——而車道的天花板是**淘汰**制，裝不下就會默默刪掉
 * 別人還沒領的塊。1GiB 至少容得下三位收件人的整份最壞配額。
 *
 * 🔴 這是帳號層級免費額度的一部分：兩條檔案車道 × 1GiB＝2GiB，DO SQLite 免費 5GB
 * 是**整個帳號共用**的（主訊息平面也在裡面）。要調大之前先重算 Cinderous ADR-0371 §成本。
 */
export declare const FILE_LANE_OFFLINE_MAX_BYTES: number;
/** 一個 `maxFileMb` MB（MiB）的檔案要切成幾塊。 */
export declare function fileChunksFor(maxFileMb: number): number;
/** 檔案車道的每收件人檔案塊配額（Cinderous ADR-0371 §決策 3）：兩個上限檔＋餘裕。 */
export declare function fileLaneChunksPerRecipient(maxFileMb: number): number;
/** 決定檔案政策需要的三個站方設定。 */
export interface FileLaneEnv {
    MAX_FILE_MB?: string | undefined;
    FILE_LANES?: string | undefined;
    APP_LANES?: string | undefined;
    /** 唯讀寬限期的車道（SDK ADR 0052）：車道模式下沿用檔案車道的儲存設定，既有的檔案塊才留得住 */
    READONLY_LANES?: string | undefined;
}
/** `FILE_LANES` 有沒有設（空白字串視同未設）。有設就是「車道模式」，主平面整類拒收。 */
export declare function fileLanesMode(raw: string | undefined): boolean;
/**
 * `FILE_LANES` 裡真正生效的車道，與被忽略的那些（Cinderous ADR-0371 §決策 1）。
 *
 * 🔴 只有**同時在 `APP_LANES` 上**的才算：不在名單上的車道沒有自己的 DO，
 * 它落在共用雜湊分片——替它開檔案等於替那顆分片上所有陌生應用開檔案。
 */
export declare function fileLanes(env: FileLaneEnv): {
    active: ReadonlySet<string>;
    ignored: string[];
};
/** 一顆 DO 的檔案政策。`maxFileMb` 只在車道模式出現（NIP-11 對外宣告的單檔上限）。 */
export type FilePolicy = {
    accept: false;
} | {
    accept: true;
    maxFileMb?: number;
};
/**
 * 這顆 DO 收不收檔案塊（kind 1060）——**兩座宿主的單一真實來源**（Cinderous ADR-0371）。
 *
 * - `MAX_FILE_MB` 未設／<1 → 哪裡都不收（總開關，ADR-0162）。
 * - `FILE_LANES` **未設** → 與過去完全相同：全站收（企業自架相容），不宣告單檔上限。
 * - `FILE_LANES` **有設** → 只有 `laneId` 在生效名單上的 DO 收，`MAX_FILE_MB` 改當單檔上限；
 *   Cinderous 主訊息平面（嚴格平面）、共用分片與其他車道一律整類拒收。
 *
 * @param laneId 這顆 DO 服務的**名單上車道** id；嚴格平面與共用分片傳 `undefined`。
 */
export declare function filePolicyFor(env: FileLaneEnv, laneId?: string): FilePolicy;
/**
 * 由 `MAX_EVENTS_PER_MINUTE` 原始字串算出速率上限（node 自架可覆寫）。
 * 未設／壞值 → 預設 {@link MAX_EVENTS_PER_MINUTE}；<1 視為關閉（undefined）。
 */
export declare function eventsPerMinuteFrom(raw: string | undefined): number | undefined;
/**
 * 由 `MAX_MESSAGES_PER_MINUTE` 原始字串算出每連線訊息上限（node 自架可覆寫）。
 * 未設／壞值 → 預設 {@link MAX_MESSAGES_PER_MINUTE}；<1 視為關閉（undefined）。
 *
 * 🔴 **永遠不低於事件上限的兩倍**：自架者把 `MAX_EVENTS_PER_MINUTE` 調高之後，
 * 若訊息上限還夾在 240，他調的那個數字就是假的——而症狀是「事件被擋，
 * 但訊息說 rate-limited」，兩種完全不同的診斷。
 */
export declare function messagesPerMinuteFrom(raw: string | undefined, eventsPerMinute: number | undefined): number | undefined;
/**
 * 正規化「本次連線打到的主機」（ADR-0235 H2）：AUTH 的 `relay` tag 必須指向它。
 *
 * 接受單一主機或 `X-Forwarded-Host` 的逗號串（反向代理會疊加）——取**第一個**、小寫、去空白。
 * 空／undefined 回 undefined（＝不強制 relay tag 檢查，自架/測試維持原行為）。
 */
export declare function firstHost(raw: string | undefined): string | undefined;
/**
 * 第三方車道的可尋址位址配額（ADR-0366 P1 #7）。
 *
 * 預設的 5 是 ADR-0071 為「每人 5 台裝置」訂的，那描述的是**裝置數**——第三方車道上
 * 一位玩家可能同時有多份牌組與多個 epoch 的世界快照，套 5 會在第 6 份就被拒。
 *
 * ⚠ 64 是**有根據的猜測，待實測校準**（同 ADR-0006 對容量的處理方式）：它必須夠大
 * 才擋不到正常用法，又必須有界才擋得住「一個作者塞爆這顆 DO」。最壞情況是
 * 64 × {@link ADDRESSABLE_MAX_BYTES}（256KB）＝ 16MB／作者／kind——實際 payload
 * 遠小於此（一份牌組約 2KB），但這個數字該被量過再定案。
 */
export declare const APP_ADDRESSABLE_PER_AUTHOR = 64;
/**
 * **公用**車道（不在 `APP_LANES` 名單上）的可尋址位址配額（ADR-0366 §裁示）。
 *
 * 錨點對所有車道開放，所以這顆共用分片上跑的是我們**不知道其形狀**的應用。
 * 64 是替本專案四款遊戲的用法（多份牌組、多個 epoch 快照）量身訂的數字，
 * 沒有理由預設送給不認識的應用；16 對一般可尋址用途（名單、設定、個人檔案）
 * 綽綽有餘，而且把「一個作者塞爆共用分片」的上界壓低四倍。
 *
 * ⚠ 這不是門禁也不是防禦：車道 id 自報，陌生人把自己叫做 `lwd` 就會落進那顆 DO
 * 並拿到 64。它是**誠實的預設值**，真正的成本界線是升級限速與每連線訊息上限。
 */
export declare const PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR = 16;
/**
 * 車道上單顆可尋址事件的位元組上限（ADR-0366 §容量二）。
 *
 * 預設的 256KB 是為 ADR-0071 的**加密雲端快照**訂的；車道上的東西小得多
 * （《元素使》一份牌組約 2KB、世界快照數十 KB）。而「單顆上限 × 每連線訊息上限」
 * 就是**一條連線每分鐘能塞進多少位元組**——256KB × 240 ≈ 60MB/分，換成 32KB
 * 立刻降為 1/8。這是目前最便宜、最有效的一道。
 *
 * ⚠ 車道日後若真要放大型快照，改這個數字之前要先重算上面那個乘積。
 */
export declare const APP_ADDRESSABLE_MAX_BYTES: number;
/**
 * **每個作者**的可尋址總位元組上限（跨所有 kind；ADR-0366 §容量二）。
 *
 * 🔴 為什麼兩個平面都要有：位址配額的計數範圍是 (pubkey, **kind**)，而 kind 區間有一萬個
 * 且由發送方自選 ⇒ 沒有這一條，「每人每 kind N 個」實際上是「每人 N 萬個」，
 * 單一作者的可尋址儲存是**無界**的。嚴格平面同樣如此（NIP-42 擋不住——金鑰不用錢）。
 *
 * 數字的根據：
 * - 嚴格平面現有最大用途是 ADR-0071 的雲端快照，5 台裝置 × 256KB ＝ 1.25MB ⇒ 8MB 非常寬鬆。
 * - 車道（已知租戶）64 × 32KB ＝ 2MB／kind ⇒ 8MB 容得下牌組＋多個 epoch 的世界快照。
 * - 公用車道 16 × 32KB ＝ 512KB／kind ⇒ 2MB 對一般可尋址用途足夠。
 *
 * ⚠ **它擋不住換金鑰的人**（pubkey 不用錢，鑄一把是微秒級的事）。它擋的是「單一身分
 * 無限累積」；速率那一側由每連線訊息上限 × 單顆上限決定。要讓**總量**真的有界，
 * 還需要一道「整顆 DO 的可尋址容量天花板＋淘汰」——尚未實作，見 ADR-0366 §容量二。
 */
export declare const STRICT_ADDRESSABLE_BYTES_PER_AUTHOR: number;
export declare const APP_ADDRESSABLE_BYTES_PER_AUTHOR: number;
export declare const PUBLIC_LANE_ADDRESSABLE_BYTES_PER_AUTHOR: number;
/**
 * **公用分片**的保存期（秒；ADR-0367 §決策 1）：見習保存。
 *
 * 🔴 為什麼是「保存」而不是「進門等待」：等待對攻擊者免費且可平行（開一千個身分
 * 一起等就抵銷了），要讓等待構成成本必須數得出「他」是誰——而身分不用錢。
 * 把等待加在**保存**那一端，換金鑰就再也沒有用：每一把新金鑰都從頭蹲一次。
 *
 * 穩態儲存量因此是 `寫入速率 × 見習期` 而不是 `寫入速率 × 30 天`：
 * 以車道單顆 {@link APP_ADDRESSABLE_MAX_BYTES} × 每連線 {@link MAX_MESSAGES_PER_MINUTE}
 * 計，一條連線的穩態水位約 900MB 而不是數百 GB。
 *
 * 🔵 **只套在公用分片**：名單上的車道（我們知道其用法）與嚴格平面（ADR-0071 的
 * 「活躍即永久」契約）一個字都不動。這種規則設錯的症狀是「安靜地掉資料」，
 * 爆炸半徑因此刻意只落在陌生應用的資料上。
 *
 * ⚠ 代價：陌生應用「發完就離線」的資料會在兩小時後消失（活躍即刷新——
 * `putAddressable` 每次更新都重算到期時間）。這必須讓對方知道 ⇒ NIP-11 的
 * `retention` 與 `cinder_addressable_ttl_sec` 會如實回報這個值。
 */
export declare const PUBLIC_LANE_RETENTION_SECONDS: number;
/**
 * 收件確認的寬限（秒；SDK ADR 0067）：收件人確認處理完之後，那幾列在中繼上再留多久。
 *
 * 比照未註冊應用的保存期（使用者 2026-10-11 裁示），直接用 {@link PUBLIC_LANE_RETENTION_SECONDS}、不另設常數；
 * 這顆 DO 的保存上限更短時取保存上限（ADR-0160：站方上限恆為權威）。不另開設定項。
 * 宿主把它傳給 `RelayCore` 的 `inboxAckGraceSec`，NIP-11 的 `cinder_inbox_ack.grace_sec` 宣告同一個值。
 */
export declare function inboxAckGraceFor(store: Pick<MessageStoreOptions, "maxTtlSeconds">): number;
/**
 * **整顆 DO** 的可尋址容量天花板（ADR-0367 §決策 2）。
 *
 * 見習保存讓水位不會一直漲，天花板保證**極端情況也不撐爆**——兩者互補：
 * 前者管「平均」，後者管「最壞」。超過時車道淘汰**最快到期**者，
 * 而見習中的資料天然排在最前面（§決策 1 的直接結果，不是巧合）。
 *
 * 🔴 **嚴格平面只拒收、不淘汰**（{@link storeOptions} 只對車道打開淘汰）：
 * 那裡的資料是使用者的加密雲端快照，ADR-0071 承諾「活躍即永久」——
 * 刪別人的備份不可逆，而拒收看得見（回 `OK false`，營運者查得到）。
 *
 * ⚠ **這個數字待實測校準**（同 ADR-0006 對容量的處理）：它必須夠大才不會擋到正常用量
 * （嚴格平面 128MB ≈ 100 位使用者的雲端快照），又必須小到單顆 DO 不會撞上平台上限。
 * 帳號層級的總量是「天花板 × DO 數」，ADR-0006 的免費額度天花板不因此解除。
 */
export declare const DO_ADDRESSABLE_MAX_BYTES: number;
/**
 * **整顆 DO** 的離線留言容量天花板（ADR-0367 §決策 2）。
 *
 * 🔴 為什麼 FIFO 不夠：`MAX_PER_RECIPIENT` 是每**收件人** 500 則，而收件人可以亂編；
 * 更早的一個缺口是**沒有 `p` 標籤的事件全落在同一個「無收件人」桶，而 FIFO 根本不對
 * 它執行** ⇒ 那個桶只被 TTL 壓著，而遊戲的房間／世界事件正是這個形狀。
 *
 * ⚠ 不要用 `MAX_PER_RECIPIENT` 去補那個桶：一場對決約 20 顆持久化事件，500 只夠 25 場
 * ⇒ 熱門車道的房間歷史會被默默丟掉，而那是比塞爆更難查的故障。
 */
export declare const DO_OFFLINE_MAX_BYTES: number;
/** 1 MiB。`DO_CEILINGS_MIB` 的單位。 */
export declare const MIB: number;
/** 1 KiB。`DO_GUARANTEE_KIB` 的單位。 */
export declare const KIB = 1024;
/**
 * Cloudflare 免費方案帳號的 DO SQLite 儲存預算（Cinderous ADR-0377）：每帳號 5 GB 的 **80%**。
 *
 * 取**十進位** 4,000,000,000 bytes（≈ 3.73 GiB）：Cloudflare 的「5 GB」不論解讀成 5×10⁹ 還是
 * 5 GiB，4×10⁹ 都不超過它的 80%，取保守的那個。
 *
 * 🔴 為什麼要有：免費方案超過額度是**整個帳號**同類操作一起失敗——所有 DO、主訊息平面一起停。
 * 天花板乘上 DO 數原本加起來約 10 GiB（兩倍於額度），沒有任何東西守著總量。
 * {@link computeCeilingBudget} 依站方設定算出所有可能 DO 的天花板加總（含溢位帶），部署者的守門測試比這個數字。
 *
 * 剩下的 20% 留給天花板**不計入**的東西：SQLite 索引與頁面開銷、`ws_subs` 溢位表（ADR-0373）、
 * `inbox_drops` 丟棄計數表（SDK ADR 0042）、DO 的 key-value（車道政策、DO 名）。天花板只算事件 JSON 的長度。
 * 付費方案（超出只是多付錢）不必守這個數字：`computeCeilingBudget(vars, 自己的預算)`。
 */
export declare const ACCOUNT_STORAGE_BUDGET_BYTES = 4000000000;
/** 一顆 DO 的兩個容量天花板（位元組）。 */
export interface DoCeiling {
    offlineMaxBytes: number;
    addressableMaxBytes: number;
}
/**
 * DO 的天花板類別（Cinderous ADR-0377）。由 DO 名決定，與路由同一個事實：
 * - `strict`：Cinderous 主訊息平面（`global`、`presence`、`shard-0..f`）；滿了**拒收**。
 * - `public`：共用車道分片 `app-0..7`（名單外的陌生應用、見習保存）；滿了淘汰。
 * - `lane`：名單上的車道 `app:<id>`；滿了淘汰。
 * - `file`：名單上、又在 `FILE_LANES` 車道模式下收檔案塊的車道；滿了淘汰。
 */
export type CeilingClass = "strict" | "public" | "lane" | "file";
/**
 * 沒設 `DO_CEILINGS_MIB` 時的天花板——**與 ADR-0377 之前完全相同**（SDK 中立預設，ADR 0019；自架站行為不變）。
 * Cinderous 錨點以 `wrangler.toml` 的 `DO_CEILINGS_MIB` 覆寫。
 */
export declare const DEFAULT_DO_CEILINGS: Readonly<Record<CeilingClass, DoCeiling>>;
/** `DO_CEILINGS_MIB` 單一數值的上限（MiB）：Cloudflare 單顆 SQLite DO 的實體上限是 10 GB。 */
export declare const DO_CEILING_MAX_MIB = 8192;
/**
 * 容量設定各值的合法範圍（中繼端；SDK ADR 0042）。超出的項目不生效、列進 `ignored`。
 * 一鍵部署另有更緊的夾限（`deploy/shared` 的 `RELAY_SITE_LIMITS`，ADR 0037 原則 2）。
 */
export declare const DO_CAPACITY_LIMITS: {
    /** 保底（KiB）：1 KiB–64 MiB */
    readonly guaranteeKib: {
        readonly min: 1;
        readonly max: 65536;
    };
    /** 溢位帶（天花板的百分比） */
    readonly borrowPercent: {
        readonly min: 1;
        readonly max: 100;
    };
    /** 預警門檻（百分比）；另一級固定是 95 */
    readonly nearFullPercent: {
        readonly min: 50;
        readonly max: 99;
    };
};
/** 決定天花板與容量政策需要的站方設定（SDK ADR 0042）。 */
export interface CeilingEnv extends FileLaneEnv {
    /** Cinderous ADR-0377：`<對象>=<離線 MiB>/<可尋址 MiB>`，逗號分隔。 */
    DO_CEILINGS_MIB?: string | undefined;
    /** 保底（ADR 0038 P2）：`<對象>=<KiB>`，逗號分隔。只在淘汰制（`public`／`lane`／`file`）生效。 */
    DO_GUARANTEE_KIB?: string | undefined;
    /** 溢位帶（ADR 0039 B1）：`<對象>=<天花板的百分比>`，逗號分隔。淘汰制的 DO 要同時有保底才生效。 */
    DO_BORROW_PERCENT?: string | undefined;
    /** 粗分級預警（ADR 0038 決策 5）：`<對象>=<百分比>`，逗號分隔。 */
    DO_NEAR_FULL_PERCENT?: string | undefined;
    /** 丟棄計數（ADR 0038 M8）：開啟的對象，逗號分隔（`strict,lane,app:dochost`）。 */
    DO_DROP_NOTICES?: string | undefined;
    /** 僅限車道（SDK ADR 0051）：開了就只有 `APP_LANES` 上的車道會有 DO。 */
    LANES_ONLY?: string | undefined;
}
/**
 * 解析 `DO_CEILINGS_MIB`（Cinderous ADR-0377）：逗號分隔的 `<對象>=<離線 MiB>/<可尋址 MiB>`。
 *
 * 對象可以是**類別**（`strict`／`public`／`lane`／`file`，套用到該類的每一顆 DO），
 * 或**單顆 DO 名**（`global`、`presence`、`shard-a`、`app-3`、`app:dochost`），後者優先。
 *
 * 🔴 設錯的項目**不生效**、列在 `ignored`（宿主啟動時 `console.warn`，預算守門要求它為空）：
 * 形狀不對、數值不是 1–{@link DO_CEILING_MAX_MIB} 的整數、重複、對象不是路由會建立的 DO、
 * 或 `app:<id>` 不在 `APP_LANES` 上（不在名單上的車道沒有自己的 DO）。
 * 不生效＝退回類別值或預設值（預設值可能比站方的設定大）——所以設錯**一定要看得見**。
 */
export declare function doCeilings(env: CeilingEnv, 
/** Node 版（SDK ADR 0099）：只認 `strict`、上限放寬到 {@link NODE_CEILING_MAX_MIB}。沒給＝Cloudflare 版的規則 */
limits?: {
    valid?: ReadonlySet<string>;
    maxMib?: number;
}): {
    entries: ReadonlyMap<string, DoCeiling>;
    ignored: string[];
};
/** 解析五個容量設定（SDK ADR 0042）。 */
export declare function doCapacitySettings(env: CeilingEnv): {
    ceilings: ReadonlyMap<string, DoCeiling>;
    guaranteeKib: ReadonlyMap<string, number>;
    borrowPercent: ReadonlyMap<string, number>;
    nearFullPercent: ReadonlyMap<string, number>;
    dropNotices: ReadonlySet<string>;
    /** 沒有生效的項目（`<變數名>: <項目>`） */
    ignored: string[];
};
/** 一顆 DO 屬於哪一類天花板（Cinderous ADR-0377）。DO 名由 `routeForPath` 決定。 */
export declare function ceilingClassOf(env: CeilingEnv, doName: string): CeilingClass;
/**
 * 這顆 DO 的天花板（Cinderous ADR-0377）：單顆 DO 名的設定 → 類別的設定 → 預設值。
 * **兩處共用**：`RelayRoom` 組 store 時、預算加總時——算的就是真正在執行的數字。
 */
export declare function doCeilingFor(env: CeilingEnv, doName: string): DoCeiling;
/** 一顆 DO 的完整容量政策（SDK ADR 0042）：天花板＋保底、溢位帶、預警、丟棄計數。沒設的欄位不出現＝v0.33 行為。 */
export interface DoCapacity extends DoCeiling {
    /** 保底（位元組） */
    guaranteeBytes?: number;
    /** 溢位帶比例（0–1） */
    overflowRatio?: number;
    /** 預警門檻（百分比） */
    nearFullPercent?: number;
    /** 丟棄計數 */
    countDrops?: boolean;
    /**
     * 滿了淘汰而不是拒收（SDK ADR 0099）：只有 Node 版的 `CEILING_MODE=evict` 會給。
     * Cloudflare 版由 profile 決定（車道淘汰、嚴格平面拒收），`doCapacityFor` 不給這個欄位。
     */
    evicts?: boolean;
}
/** Node 版 `DO_CEILINGS_MIB` 單一數值的上限（MiB；SDK ADR 0099）：1 TiB。沒有 DO 的實體上限，實際上限交給硬碟。 */
export declare const NODE_CEILING_MAX_MIB = 1048576;
/** Node 版的容量設定（SDK ADR 0099）：Cloudflare 版那五個變數，加上 `CEILING_MODE`。 */
export interface NodeCapacityEnv extends CeilingEnv {
    /** 滿了之後：`reject`（預設，拒收）或 `evict`（淘汰最快到期的） */
    CEILING_MODE?: string | undefined;
}
/**
 * Node 版中繼的容量政策（SDK ADR 0099）。Node 版只有一套嚴格政策、沒有車道與分片，所以只認 `strict` 這個對象，
 * 其他對象設了不生效、列進 `ignored`（宿主啟動時 `console.warn`）。
 *
 * - 什麼都沒設＝`capacity` 不出現，store 用預設值——與這個 ADR 之前完全相同。
 * - `CEILING_MODE=evict`：滿了淘汰；這時保底（`DO_GUARANTEE_KIB`）才生效。`reject` 模式設了保底不生效。
 * - 溢位帶（`DO_BORROW_PERCENT`）兩種模式都接受：拒收制本來就借用（與 Cloudflare 主訊息平面相同），淘汰制要同時有保底。
 */
export declare function nodeCapacityFrom(env: NodeCapacityEnv): {
    capacity?: DoCapacity;
    ignored: string[];
};
/**
 * 這顆 DO 的容量政策（SDK ADR 0042）。每一項都是「單顆 DO 名 → 類別 → 沒設」的順序，與 {@link doCeilingFor} 相同。
 * **兩處共用**：`RelayRoom` 組 store 時、{@link computeCeilingBudget} 加總時。
 */
export declare function doCapacityFor(env: CeilingEnv, doName: string): DoCapacity;
/**
 * 溢位帶實際會不會用到（SDK ADR 0042）：拒收制（`strict`）的離線留言會；嚴格平面的可尋址不借用；
 * 淘汰制要同時有保底才會（沒有保底時淘汰制本來就收下每一則，帶子不生效）。
 */
export declare function borrowingPlanes(cls: CeilingClass, capacity: DoCapacity): {
    offline: boolean;
    addressable: boolean;
};
/** 一顆 DO 的最壞儲存量（位元組）：兩個天花板，會借用的那一側乘上 1 + r。 */
export declare function worstCaseBytes(cls: CeilingClass, capacity: DoCapacity): number;
/** 最壞加總的一列：一顆 DO。 */
export interface CeilingRow {
    doName: string;
    cls: CeilingClass;
    ceiling: DoCeiling;
    /** 容量政策（含天花板） */
    capacity: DoCapacity;
    /** 離線＋可尋址，含會用到的溢位帶。 */
    bytes: number;
}
/**
 * 依站方設定，**所有可能 DO** 的天花板加總（Cinderous ADR-0377；SDK ADR 0042 把溢位帶算進去）——帳號 DO SQLite 用量的政策上界。
 *
 * `laneCostBytes` 是「`APP_LANES` 再加一條車道」要多花的預算（`lane` 類別的最壞量）：
 * 名單上的每條車道都有自己的 DO，所以這個數字會隨名單成長，預算必須把它算進去。
 */
export declare function worstCaseStorage(env: CeilingEnv): {
    rows: CeilingRow[];
    totalBytes: number;
    laneCostBytes: number;
};
/**
 * 部署者的守門工具（SDK ADR 0042）：給中繼的環境變數（`relaySiteVars` 的結果、`wrangler.toml` 的 `[vars]`），
 * 算出所有可能 DO 的最壞儲存加總（含溢位帶）並與預算比較。把它放進自己的測試，`APP_LANES` 或天花板一改、超出預算就變紅。
 *
 * ```ts
 * const budget = computeCeilingBudget(vars);
 * expect(budget.ignored).toEqual([]);          // 設錯＝退回較大的預設值，預算不可信
 * expect(budget.withinBudget).toBe(true);
 * ```
 *
 * @param budgetBytes 預設 {@link ACCOUNT_STORAGE_BUDGET_BYTES}（免費方案 5 GB 的 80%）
 */
export declare function computeCeilingBudget(vars: CeilingEnv | Readonly<Record<string, string | undefined>>, budgetBytes?: number): {
    rows: CeilingRow[];
    totalBytes: number;
    laneCostBytes: number;
    budgetBytes: number;
    withinBudget: boolean;
    /** 還放得下幾條新車道（每條 `laneCostBytes`）；已經超出是 0 */
    lanesLeft: number;
    ignored: string[];
};
/**
 * 站方的已知租戶名單（`APP_LANES`，逗號分隔；ADR-0366 §裁示）。
 *
 * 🔴 **它不是白名單**：不在名單上的車道照常服務——錨點同時是公用 relay。
 * 名單決定的是「這條車道有沒有自己的 DO」，也因此決定它的可尋址配額。
 * 未設／空字串＝沒有已知租戶，所有車道共用雜湊分片（車道剛上線時的行為）。
 *
 * ⚠ **把一條車道加進名單或移出名單，等於換一顆 DO**：它先前存在舊 DO 裡的
 * 可尋址事件與離線留言不會跟著搬，會留在原處直到 TTL 到期。名單要在上線前定好，
 * 之後的變更請當成該車道的一次冷啟動。
 */
export declare function knownLanes(raw: string | undefined): ReadonlySet<string>;
/**
 * 僅限車道模式（`LANES_ONLY`；SDK ADR 0051）：`1` 或 `true`（不分大小寫）才開，其他一律關。
 *
 * 開了之後只有 `APP_LANES` 上的車道連得上：主平面（`/`、`/s/<n>`、`/presence`）與沒列的車道都拒絕。
 * 給「開放寫入＋不可猜的隨機路徑」的個人專屬中繼用——路徑本身就是門票，所以主平面不能留著。
 * 🔴 名單空著卻開了＝整座站什麼都連不上（宿主啟動時 `console.warn`）。
 */
export declare function lanesOnlyFrom(raw: string | undefined): boolean;
/** 唯讀車道最多幾條（`READONLY_LANES`；SDK ADR 0052）：每條是一顆還留著資料的 DO。 */
export declare const READONLY_LANES_MAX = 8;
/** 唯讀寬限期的車道設定（{@link readOnlyLanesFrom} 的結果）。 */
export interface ReadOnlyLaneSettings {
    /** 車道 id → 到期時間（unix 秒）。不論是否已過期都列出；生效與否看 {@link readOnlyLaneIds} */
    lanes: ReadonlyMap<string, number>;
    /** 寫錯而不採用的項目：🔴 只有「第幾項」與原因，**不含車道 id**（它是秘密，會進記錄） */
    ignored: string[];
}
/**
 * 換了私人路徑之後，舊路徑的唯讀寬限期（`READONLY_LANES`；SDK ADR 0052）：`<車道 id>@<到期 unix 秒>`，逗號分隔。
 *
 * 列在這裡、還沒到期的車道：**連得上、讀得到（REQ、AUTH），拒絕一切寫入**（`OK false "restricted: read-only: …"`）；
 * 到期後與認不得的路徑相同（`LANES_ONLY` 時是 `unknown-path`）。到期由中繼自己判斷，不需要再部署。
 * 同時在 `APP_LANES` 上的以 `APP_LANES` 為準（照常可寫）。寫錯的項目不採用、宿主啟動時 `console.warn`（不印 id）。
 */
export declare function readOnlyLanesFrom(raw: string | undefined): ReadOnlyLaneSettings;
/** 判斷唯讀車道需要的兩個設定。 */
export interface ReadOnlyLaneEnv {
    APP_LANES?: string | undefined;
    READONLY_LANES?: string | undefined;
}
/**
 * 現在（`nowSec`）生效的唯讀車道（SDK ADR 0052）：還沒到期、而且不在 `APP_LANES` 上（名單上的照常可寫）。
 * 路由（{@link routeForPath} 的 `readOnlyLanes`）與 DO 的寫入閘門都用它——兩邊同一個判斷。
 */
export declare function readOnlyLaneIds(env: ReadOnlyLaneEnv, nowSec: number): ReadonlySet<string>;
/**
 * 一條名單上車道（`app:<id>` 那顆 DO）現在的狀態（SDK ADR 0052）：
 * - `active`：在 `APP_LANES` 上，照常讀寫；
 * - `read-only`：在唯讀寬限期內；
 * - `expired`：唯讀期已過（列在 `READONLY_LANES` 但到期了，又不在 `APP_LANES` 上）——宿主關掉還開著的連線；
 * - `unlisted`：兩邊都沒有（例如從 `APP_LANES` 拿掉的舊車道；維持過去的行為，宿主不主動處理）。
 */
export declare function laneStateOf(env: ReadOnlyLaneEnv, laneId: string, nowSec: number): "active" | "read-only" | "expired" | "unlisted";
/**
 * store 選項（每收件人上限固定；TTL 由 env 決定；可尋址配額依車道，ADR-0366 P1 #7）。
 *
 * 🔵 可尋址 **TTL 不隨車道改變**（維持 30 天）：`putAddressable` 每次更新都會刷新到期時間，
 * 所以「活躍即永久」本來就成立，遊戲不需要更長的預設。真要拉長的是**自架的世界站**
 * （挑戰窗長度），那條路走 store 選項本身即可（P1 #8 把旋鈕做出來了），不需要動預設。
 */
export declare function storeOptions(maxTtlDaysRaw: string | undefined, profile?: RelayProfile, 
/** 這顆 DO 服務的是名單上的已知租戶嗎（ADR-0366 §裁示）；預設否＝公用配額。 */
knownLane?: boolean, 
/**
 * 檔案車道的單檔上限（MB；Cinderous ADR-0371）。只有 {@link filePolicyFor} 在車道模式下判定
 * 「這顆 DO 收檔案」時才給；給了就換成檔案車道的每收件人配額與 DO 天花板。
 */
maxFileMb?: number, 
/**
 * 這顆 DO 的容量政策（Cinderous ADR-0377 的天花板＋SDK ADR 0042 的保底、溢位帶、預警、丟棄計數；{@link doCapacityFor}）。
 * 給了就取代預設的 {@link DO_OFFLINE_MAX_BYTES}／{@link DO_ADDRESSABLE_MAX_BYTES}／{@link FILE_LANE_OFFLINE_MAX_BYTES}；
 * 不給＝預設值、沒有保底與溢位帶（自架的 node 宿主、尚不知道 DO 名的時候）。淘汰制與拒收制不因此改變。
 * 只給 {@link DoCeiling}（Cinderous ADR-0377 的簽名）也可以。
 */
capacity?: DoCeiling | DoCapacity): MessageStoreOptions;
/**
 * `MAX_CONNECTIONS_PER_PUBKEY`（PRD 3.3：5；SDK ADR 0013）：同一把公鑰最多幾條連線。
 * 沒設或壞值＝不限——Cinderous 錨點不設，一個人好幾台裝置可能都連到同一片。
 */
export declare function connectionsPerPubkeyFrom(raw: string | undefined): number | undefined;
/** `MAX_MESSAGES_PER_SECOND_PER_IP`（PRD 3.3：20；SDK ADR 0013）。沒設或壞值＝不限。 */
export declare function messagesPerSecondPerIpFrom(raw: string | undefined): number | undefined;
/** `MAX_CONNECTIONS`（SDK ADR 0100）：Node 版全站最多幾條同時連線。沒設或壞值＝不限。 */
export declare function maxConnectionsFrom(raw: string | undefined): number | undefined;
/**
 * `MAX_CONNECTIONS_PER_IP`（SDK ADR 0100）：Node 版同一個 IP 最多幾條同時連線。沒設或壞值＝不限——
 * 手機電信與公司網路常是很多人共用一個 IP，預設不擋。反向代理後方要 `TRUST_PROXY=1` 才看得到真正的來源。
 */
export declare function maxConnectionsPerIpFrom(raw: string | undefined): number | undefined;
/** `TRUST_PROXY` 最多信任幾層代理 */
export declare const TRUST_PROXY_MAX_HOPS = 10;
/**
 * `TRUST_PROXY`（SDK ADR 0013、0119）：前面有幾層信任的反向代理。`1`＝一層（Caddy、nginx、Fly 的邊緣、cloudflared）；
 * `2`–`10`＝幾層（例如 Cloudflare 橘色雲＋自己的 nginx）。沒設、`0`、壞值＝不信任 `X-Forwarded-For`——
 * 直接對外時那個標頭任何人都能偽造。
 */
export declare function trustedProxyHopsFrom(raw: string | undefined): number;
/**
 * 連線的真正來源（SDK ADR 0119）：信任 `hops` 層代理時，取 `X-Forwarded-For` **從右邊數**第 `hops` 段。
 * 會「附加」的代理（nginx 的 `$proxy_add_x_forwarded_for`、Cloudflare、Fly）把客戶端自己帶的值留在左邊，
 * 只有最右邊那幾段是信任的代理寫的——取第一段的話，客戶端在前面加一段就能換一個 IP、躲過每個 IP 的上限。
 * 段數比層數少：取最左邊（每一段都是信任的代理寫的）。沒有標頭或是空的：用連線的來源位址。
 */
export declare function clientIpFrom(forwardedFor: string | undefined, remoteAddress: string | undefined, hops: number): string | undefined;
/** SDK 自己的工具（`cinderous relay start`／`relay deploy`）預設套用的 PRD 3.3 數值。 */
export declare const PRD_MAX_CONNECTIONS_PER_PUBKEY = 5;
export declare const PRD_MAX_MESSAGES_PER_SECOND_PER_IP = 20;
/**
 * 白名單（`ALLOWED_PUBKEYS`；PRD 5.2 場景 B；SDK ADR 0008）：逗號／空白／換行分隔，`npub` 與 hex 混用皆可。
 * 沒設或全空＝`undefined`（開放中繼）。回傳去重後的小寫 hex，交給 `RelayCoreOptions.allowedAuthors`。
 *
 * 🔴 **有一筆寫錯就丟例外、整座站拒絕啟動**：略過壞的那筆，那個人會被擋在門外而站方不知道為什麼；
 * 把整份當沒設，更糟——私人站默默變成開放中繼。兩種都不會報錯，所以寧可開不起來。
 */
export declare function allowedPubkeysFrom(raw: string | undefined): string[] | undefined;
//# sourceMappingURL=host-config.d.ts.map