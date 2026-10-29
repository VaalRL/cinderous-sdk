import { type NostrEvent } from "../protocol/index.js";
export { EXPIRED_REJECT, OFFLINE_CEILING_REJECT } from "./reject-messages.js";
import { type OfflineStore } from "./message-store.js";
import { type RelayFilter, type RelayMessage } from "./protocol.js";
/** NIP-01：20000–29999 為 Ephemeral，中繼站不得持久化。 */
export declare function isEphemeral(kind: number): boolean;
export { leadingZeroBits } from "../protocol/index.js";
/** 要送往某連線的一則訊息。 */
export interface Outbound {
    to: string;
    message: RelayMessage;
    /**
     * 送出這則之後**關閉該連線**（ADR-0366 §容量）。
     *
     * 為什麼需要：進站訊息就是中繼站的計費單位，訊息一旦抵達，那次請求已經付掉了
     * ——只回一則 NOTICE 擋不住成本，對方可以在同一條連線上繼續灌。關掉它，濫用者
     * 就得重新升級連線，而升級那一關有以 IP 計數的速率限制（`worker.ts`）。
     * 兩道一起才把「每個 IP 的持續成本」壓成有界。
     *
     * `true` 等同 `{ code: 1008, reason: "rate-limited" }`（原本的行為）。其他原因帶自己的關閉碼，
     * 例如白名單外的人認證後以 4003 斷線（SDK ADR 0013；PRD 3.3）。
     */
    close?: true | CloseSignal;
}
/** 關閉連線時用的 WebSocket 關閉碼與原因（原因要短：瀏覽器只給 123 bytes）。 */
export interface CloseSignal {
    code: number;
    reason: string;
}
/** 宿主把 `Outbound.close` 換成實際的關閉碼與原因。 */
export declare function closeSignalOf(close: true | CloseSignal): CloseSignal;
/** 某連線的可序列化狀態快照（供 DO 休眠後還原；ADR-0059）。 */
export interface ConnSnapshot {
    connId: string;
    /** NIP-42 挑戰（未認證前）。 */
    challenge?: string;
    /** 已認證的 pubkey（認證後）。 */
    pubkey?: string;
    /** 客戶端 IP（每 IP 速率限制用；SDK ADR 0013）。 */
    ip?: string;
    /** 本站主機（NIP-42 `relay` tag 比對用，ADR-0235 H2）；DO 休眠後需還原。 */
    relayHost?: string;
    /** 此連線目前的訂閱（subId + filters）。 */
    subs: {
        subId: string;
        filters: RelayFilter[];
    }[];
}
export interface RelayCoreOptions {
    /**
     * 離線留言持久層（M2）。Ephemeral 事件**絕不會**寫入此處，
     * 以保證上線狀態/心跳純記憶體轉發、不寫資料庫。
     */
    store?: OfflineStore;
    /** 取得目前 unix 秒（用於 NIP-40 過期判定）；預設為系統時鐘。 */
    now?: () => number;
    /** 每連線最大訂閱數；超過則拒絕新訂閱（防濫用）。 */
    maxSubscriptions?: number;
    /** 持久化事件所需的最小 NIP-13 PoW 難度（0 = 不要求）。 */
    minPowDifficulty?: number;
    /**
     * 允許的時鐘偏移（秒），**對稱**窗。
     *
     * @deprecated 對稱窗與 NIP-59 不相容（ADR-0235 H1）——外層 `created_at` 會被隨機往前推
     * 最多 `TIMESTAMP_JITTER_SECONDS`（2 天），對稱設一個小值會把幾乎每一則 Gift Wrap 擋掉。
     * 請改用 {@link maxFutureSkewSec} ／ {@link maxPastSkewSec}。設此值等同兩者都設為它。
     */
    maxClockSkewSec?: number;
    /**
     * 未來方向的時鐘容忍（秒；ADR-0235 H1）。**沒有任何合法事件會是未來的**，
     * 所以這個方向可以收得很緊，只留給客戶端時鐘誤差。
     */
    maxFutureSkewSec?: number;
    /**
     * 過去方向的時鐘容忍（秒；ADR-0235 H1）。**必須大於 `TIMESTAMP_JITTER_SECONDS`（2 天）**
     * ——NIP-59 刻意把外層時戳往前推以免中繼從時序關聯出社交圖譜，那是隱私設計而非異常。
     */
    maxPastSkewSec?: number;
    /**
     * 重放去重窗（秒；ADR-0235 H1）：只有 `created_at` 落在「現在 ± 此值」內的事件才進去重快取。
     *
     * 為什麼不涵蓋整個過去窗：那是 2 天份的 event id，DO 記憶體撐不住。而且對封裝事件也沒必要
     * ——收件端本來就以 `rumor.id` 去重（ARCHITECTURE §4）。真正需要擋的是**裸的即時信標**
     * （kind 20000 心跳，用真實時戳），重放它就能偽造「某人在線」。
     */
    replayWindowSec?: number;
    /**
     * 每個 pubkey 每分鐘可發布的事件數上限（ADR-0235 H1）。
     *
     * 修正前**完全沒有**速率限制：任何人自產一把金鑰通過 AUTH，就能對單一全域房間的 DO
     * 無限灌事件。以 pubkey（而非連線）計數——否則換條連線就繞過去了。
     */
    maxEventsPerMinute?: number;
    /**
     * 每連線每分鐘可送進來的**訊息**數上限（ADR-0366 §容量）。超過即 NOTICE ＋ 關閉連線。
     *
     * 🔴 為什麼不能只靠 {@link maxEventsPerMinute}：那一項只數 EVENT，而**進站訊息才是
     * 計費單位**。`REQ`／`CLOSE` 一來一回就是兩次請求，開了又關可以無限重複，
     * 完全不經過事件限速——健康探針正是這個形狀，而它是實測下來最貴的一項。
     *
     * 以連線（而非 pubkey）計數，是因為要擋的東西發生在認證之前、也可能根本不發事件。
     * 換連線確實能繞過，那正是為什麼宿主端要再有一道以 IP 為鍵的升級限速。
     */
    maxMessagesPerMinute?: number;
    /**
     * 同一把公鑰最多幾條已認證連線（PRD 3.3；SDK ADR 0013）。超過的那一條認證被拒並關閉。
     * 未設＝不限（Cinderous 錨點：一個人好幾台裝置可能都連到同一片）。
     */
    maxConnectionsPerPubkey?: number;
    /**
     * 同一個 IP 的所有連線合計、每秒最多幾則訊息（PRD 3.3：20）。超過就關閉送出那則的連線。
     * 只對宿主給了 IP 的連線生效；未設＝不限。
     */
    maxMessagesPerSecondPerIp?: number;
    /**
     * 企業封閉模式（ADR-0044）：僅允許名單內 pubkey（hex）發布事件的 allowlist。
     * 未設＝開放中繼（現況）。設定後非名單成員的任何事件（含心跳）一律拒收，
     * 使「同一企業只用同一節點、外部客戶不進系統」在內容層成立。
     */
    allowedAuthors?: Iterable<string>;
    /**
     * 唯讀（SDK ADR 0052）：換了私人路徑之後的舊路徑在寬限期內只能讀。`true`＝整顆（Worker 的一顆 DO 只服務一條車道）；
     * 函式＝依連線判斷（Node 主機所有路徑共用一個 core）。唯讀的連線送 `EVENT` 一律 `OK false "restricted: read-only: …"`，
     * 擺在認證與一切檢查之前（不必先 AUTH 才知道寫不進去）；`REQ`、`AUTH`、`CLOSE` 照常。
     */
    readOnly?: boolean | ((connId: string) => boolean);
    /**
     * 企業政策（ADR-0048）：僅轉發/儲存 kind 在此名單的事件；其餘拒收。
     * 未設＝不限制。停用檔案/通話＝從名單排除其信令 kind（無信令即無 WebRTC）。
     */
    allowedKinds?: Iterable<number>;
    /**
     * 接受檔案塊事件（FILE_WRAP=1060，ADR-0162）：企業站以 `MAX_FILE_MB` 啟用。
     * 未設/false＝整類拒收（公共站零儲存風險）。錨點只在 `FILE_LANES` 列出的車道打開（Cinderous ADR-0371）。
     */
    acceptFileEvents?: boolean;
    /**
     * 一次 REQ 回傳歷史事件的位元組上限（Cinderous ADR-0371 §決策 6）；預設 {@link MAX_QUERY_BYTES}。
     * 同一個 REQ 的所有 filter **共用**這份預算——否則多塞幾個 filter 就能繞過。
     */
    maxQueryBytes?: number;
    /**
     * NIP-42 AUTH（開放中繼，ADR-0057）：開啟後連線須先回應 AUTH 挑戰才准讀寫；
     * 且帶 `#p` 的訂閱只能查自己的收件匣（認證 pubkey ∈ `#p`）。未設＝開放（現況）。
     * 企業模式維持 allowlist、不開此項（ADR-0044）。
     */
    requireAuth?: boolean;
    /**
     * 第三方應用車道（ADR-0366）：放寬 `scoped()`，讓「帶任一標籤 filter」也算具名
     * （大廳、世界、牌組瀏覽都是這個形狀）。**未設＝嚴格**，Cinderous 訊息平面不受影響。
     *
     * 🔴 這個旗標**只有在該連線已被路由到獨立 DO 時**才可以開——它不是權限開關，
     * 是「這顆 DO 裡沒有 Cinderous 資料」這個事實的下游推論。見 `shard.ts` 的 `routeForPath`。
     */
    publicLane?: boolean;
    /** 產生 AUTH 挑戰字串（測試可注入以求確定性）；預設 `crypto.randomUUID()`。 */
    authChallenge?: () => string;
    /**
     * AUTH 事件的最大年齡（秒；ADR-0235 H2）。限制側錄到的簽名可被使用的時間窗。
     * 未設＝不檢查（維持原行為）。NIP-42 建議 10 分鐘。
     */
    authMaxAgeSec?: number;
    /**
     * 收件確認的寬限（秒；SDK ADR 0067）。給了（而且 store 有 `ackInbox`）就處理 {@link "@cinderous/client/protocol"!INBOX_ACK_KIND}：
     * 本人確認過的列降為「現在＋寬限」到期；確認事件本身不存、不轉發。未設＝不處理，那個 kind 照一般瞬時事件轉發。
     * 宿主以 {@link inboxAckGraceFor} 算（比照未註冊應用的保存期、不超過站方保存上限），並在 NIP-11 宣告同一個值。
     */
    inboxAckGraceSec?: number;
    /**
     * 這個錯誤是不是宿主的儲存額度用完了（SDK ADR 0127）。是的話，處理到一半拋出來的錯誤不回 `error: internal`，
     * 改回 `OK false`（EVENT）或 `CLOSED`（REQ）帶 `over quota:`、一則同樣開頭的 NOTICE，並以 1013 關閉：
     * 客戶端照 1013 整座退避（SDK ADR 0108），不會在同一條連線上一直重送、一直失敗到重置。
     * Cloudflare DO 宿主給 `doFailureKind(e) === "over-quota"`；沒給＝一律當內部錯誤（Node 宿主沒有這種額度）。
     */
    isStorageExhausted?: (error: unknown) => boolean;
    /**
     * 宿主接手某些事件（SDK ADR 0049 §7、C′ R1）：通過大小、驗簽、白名單、kind 政策、時鐘窗、重放與速率限制之後呼叫。
     * 回傳陣列＝宿主已處理（含給寄件人的 `OK`）：**不寫庫、不扇出**，陣列原樣送出；回傳 undefined＝照一般流程。
     * `authedPubkey` 是這條連線經 NIP-42 證明的身分（沒有認證為 undefined）。IoT 即時通道以它把手機的指令轉給設備。
     */
    intercept?: (connId: string, event: NostrEvent, authedPubkey: string | undefined) => Outbound[] | undefined;
}
/**
 * 傳輸無關的中繼核心：管理各連線的訂閱、驗證事件並對符合的訂閱扇出。
 * 訂閱以 kind 建立反向索引，事件進來只比對「對該 kind 有興趣」的訂閱，
 * 避免每個事件掃過全體訂閱（O(N²)）。由 Worker / Durable Object 注入收發。
 */
export declare class RelayCore {
    private readonly opts;
    /** connId -> (subId -> entry)，權威來源。 */
    private readonly subs;
    /** kind -> 對該 kind 有興趣的訂閱。 */
    private readonly byKind;
    /** 未限制 kind（可匹配任何 kind）的訂閱。 */
    private readonly anyKindSubs;
    /** 已處理事件 id → created_at（重放窗內去重，防重放）。 */
    private readonly seenIds;
    /** pubkey → 該時間窗內的發布數與窗起點（ADR-0235 H1 速率限制）。 */
    private readonly rate;
    /** connId → 該時間窗內的進站訊息數與窗起點（ADR-0366 §容量）。 */
    private readonly connRate;
    /** 企業封閉模式的發布 allowlist（hex pubkey）；undefined＝開放（ADR-0044）。 */
    private readonly allowed;
    /** 企業政策的事件類型 allowlist（kind）；undefined＝不限制（ADR-0048）。 */
    private readonly allowedKinds;
    /** connId → NIP-42 認證狀態（挑戰、已認證 pubkey、本站主機）；ADR-0057／0235 H2。 */
    private readonly authState;
    /** connId → 客戶端 IP（宿主有給才有；SDK ADR 0013） */
    private readonly connIp;
    /** IP → 這一秒的訊息數 */
    private readonly ipRate;
    /**
     * connId → 本次連線打到的主機。**與 AUTH 狀態分離**（ADR-0260）：`authState` 只在
     * `requireAuth` 時才建立，但 NIP-62 的「這份清除請求是不是給本站的」在**沒有 AUTH 的
     * 自架站**同樣需要主機資訊——不分離的話，那些站會只認 `ALL_RELAYS`。
     */
    private readonly connHost;
    /** 是否要求 NIP-42 AUTH（開放中繼；ADR-0057）。 */
    private readonly requireAuth;
    /** pubkey → 正在讀他自己收件匣的訂閱數（SDK ADR 0042 丟棄計數）。 */
    private readonly inboxSubs;
    constructor(opts?: RelayCoreOptions);
    private newChallenge;
    private isAuthed;
    /** 這條連線完成 NIP-42 認證了嗎（SDK ADR 0111 的診斷用：認證過的連線一律不記） */
    isAuthenticated(connId: string): boolean;
    private now;
    /**
     * 建立連線；`requireAuth` 時回 NIP-42 AUTH 挑戰供宿主送出（否則空）。
     *
     * `relayHost`＝**本次請求打到的主機**（宿主從 request 取得）。給了它，AUTH 就會驗證
     * `relay` tag 指向本站（ADR-0235 H2）；不給則不強制（自架／測試維持原行為）。
     * 由宿主提供而非設定檔：同一份 Worker 可能同時服務多個網域，寫死會誤擋。
     */
    connect(connId: string, relayHost?: string, clientIp?: string): Outbound[];
    disconnect(connId: string): void;
    /**
     * 匯出某連線的可序列化狀態（訂閱＋認證）；供 DO 休眠後從 WebSocket attachment 還原
     * （ADR-0059）。休眠會清空記憶體，故每次狀態變動後宿主應存回此快照。
     */
    exportConn(connId: string): ConnSnapshot;
    /**
     * 移除某連線的一條訂閱（不送任何訊息；回傳是否真的有這條）。
     *
     * 客戶端 `CLOSE` 走這裡；宿主也用它關掉**無法持久化**的訂閱（Cinderous ADR-0373）——
     * 留著它的話，它在記憶體裡看起來能用，DO 休眠一次就無聲消失。
     */
    dropSubscription(connId: string, subId: string): boolean;
    /** 從快照還原連線狀態（重建訂閱索引與認證，不觸發任何送出）；休眠喚醒時呼叫（ADR-0059）。 */
    rehydrate(snapshot: ConnSnapshot): void;
    /**
     * 客戶端訊息入口。**整段包在例外圍籬內**（ADR-0235 C1）：`RelayCore` 是傳輸無關核心，
     * 宿主（Cloudflare DO / Node ws）各自 try/catch 只會漏掉其中一邊，且 DO 的未捕捉例外
     * 會中止整個 Durable Object——那是**單一全域房間**，等於全站連線一起斷。圍籬放在唯一
     * 入口，兩個宿主自動受保護。
     */
    handle(connId: string, raw: string): Outbound[];
    /** 這條連線是不是唯讀（SDK ADR 0052） */
    private isReadOnly;
    private dispatch;
    /**
     * 處理客戶端的 NIP-42 AUTH 回應：驗簽 ＋ kind ＋ 挑戰相符 ＋ **`relay` tag 指向本站**
     * ＋ 事件新鮮度 → 標記此連線認證身分。
     *
     * `relay` tag 那一項是 NIP-42 規範要求、而修正前**沒有做**的檢查（ADR-0235 H2）。
     * 少了它，惡意中繼 M 可以：連上真中繼 R 取得挑戰 C → 把 C 當成自己的挑戰丟給受害者 →
     * 受害者簽名回給 M → M 轉送給 R → **以受害者身分通過 R 的認證**，進而訂閱其加密收件匣。
     * 內容仍是密文，但「誰在何時收到幾則」已是完整的流量分析輸入。
     */
    private handleAuth;
    /** 未認證時回拒絕訊息並（重）發此連線的 AUTH 挑戰。 */
    private authRequired;
    /**
     * 訂閱必須**具名**（ADR-0123）：帶 `#p`（等於自己）或帶非空且有界的 `authors`。
     *
     * ## 修正前的缺口
     *
     * 舊版只檢查「有 `#p` 的 filter」：
     *
     * ```ts
     * const pValues = filter["#p"];
     * if (pValues && pValues.length > 0 && !pValues.every((v) => v === self)) return false;
     * ```
     *
     * **`pValues` 是 undefined 就直接放行。** 於是 `{"kinds":[20000]}`——沒有 `#p`、沒有
     * `authors`——完全合法，任何通過 AUTH 的人（隨手產一把金鑰就能通過）都能拿到**全站每一則
     * 心跳**：每個在線者的 pubkey、狀態訊息、正在聽什麼（ADR-0088 F5 把音樂併進了心跳）。
     *
     * 那不是「洩漏某個人的元資料」，是把整個使用者名冊連同即時線上狀態做成一支**消防水管**
     * ——攻擊者不需要事先知道任何 pubkey。`{"kinds":[1059]}` 同理：拿不到明文，但拿得到
     * 全站的收件人 p-tag 與時間分布（流量分析的完美輸入）。
     *
     * ## 為什麼可以直接擋掉
     *
     * 合法客戶端**從不**送這種 filter——引擎的 9 個 filter 全部帶 `#p` 或 `authors`。
     * 一個不會影響任何合法用法的限制，就該加上去。
     *
     * 「具名」的意思是：**你得先知道要問誰**。這不是完美的隱私（仍可訂閱任何已知 pubkey 的
     * 心跳——那是 Nostr 廣播式 presence 的固有性質，見 ADR-0120/0123 的已知限制），
     * 但它把攻擊從「一鍵拿到整個名冊」降級為「一次問一個你已經知道的人」。
     */
    private scoped;
    private handleReq;
    private handleEvent;
    /** 通過驗簽、時鐘窗與重放檢查之後：限速、政策、寫庫，收下才扇出。拒收一律經過 `reject`。 */
    private admit;
    /**
     * 宿主自己產生的事件（SDK ADR 0049 C′：relay 以閘道金鑰簽的 ack、狀態、retained）：可尋址與一般事件照取代／離線語意寫庫，
     * 再扇出給符合的訂閱。不經速率限制與白名單（是宿主自己簽的，不是哪條連線送來的）；寫庫被拒就不扇出、回空陣列。
     */
    publishLocal(event: NostrEvent): Outbound[];
    /** 對符合的訂閱扇出（不含給寄件人的 OK） */
    private deliver;
    /**
     * NIP-62 Request to Vanish（ADR-0260）：清除此 pubkey 在本站的一切。
     *
     * 三道閘，順序即嚴格程度：
     *
     * 1. **身分**：`requireAuth` 時要求已認證身分＝事件作者。簽章本身已證明作者身分，這一條擋的
     *    是**重放**——側錄到一顆舊的 vanish 事件（它是公開的、任何連上的人都可能看到），日後拿來
     *    重送。重放者過不了以該身分進行的 NIP-42 AUTH。（`seenIds` 只覆蓋近一小時。）
     * 2. **目標**：`relay` tag 必須是本站或 `ALL_RELAYS`（`vanishTargetsRelay` 對缺主機資訊時
     *    **fail-closed**，見 core `vanish.ts`）。
     * 3. **執行**：交給 store 刪除，不寫庫、不扇出。
     *
     * **刻意不扇出**：把「某某人要求清除資料」廣播給所有訂閱者，等於用一則公開事件宣告這個人的
     * 動作與時間點——與 Gift Wrap 藏元資料的整個立場相反。客戶端本來就是直接對每座 relay 送出
     * 請求（見 engine `requestVanish`），不需要靠中繼轉發。
     */
    private handleVanish;
    private index;
    /** 移除重放窗外、不再可能重放的已見 id，避免無限成長。 */
    private pruneSeen;
    /**
     * 固定時間窗計數（ADR-0235 H1）：同一 pubkey 在 60 秒窗內超過上限即拒。
     *
     * 刻意用固定窗而非令牌桶：DO 會在訊息之間休眠，記憶體狀態隨時可能消失——複雜的
     * 累積式演算法在這種環境下只是假象。固定窗即使被休眠重置，也仍然把「單次爆量」
     * 壓在上限以內，而那正是要防的東西。
     */
    /**
     * 每連線的固定窗計數（ADR-0366 §容量）。與 {@link allowRate} 同一套演算法與同一個理由：
     * DO 會休眠、記憶體會被清空，滑動窗在這種環境下只是假象；固定窗即使被休眠重置，
     * 也仍然把**單次爆量**壓在上限以內，而那正是要防的東西。
     */
    /** 每 IP、每秒的固定視窗計數（SDK ADR 0013）。 */
    private allowIpRate;
    private allowConnRate;
    private allowRate;
    /**
     * 從索引拿掉一條訂閱。`delivered`：這條訂閱就此結束（CLOSE、斷線）——它若是收件匣訂閱、又是那人最後一條，
     * 記下「到這裡為止的留言都即時送到了」（SDK ADR 0042 丟棄計數的水位線）。同一個 id 換新訂閱時傳 false。
     */
    private unindex;
}
/**
 * 儲存額度用完時給這條連線的回覆（SDK ADR 0127）：先結案它這一則（EVENT→`OK false`、REQ→`CLOSED`），
 * 再一則 NOTICE 並以 1013 關閉。從原始訊息只取 EVENT 的 id 與 REQ 的訂閱 id，取不到就只送 NOTICE。
 */
export declare function storageExhausted(connId: string, raw: string): Outbound[];
//# sourceMappingURL=relay-core.d.ts.map