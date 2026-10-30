import { type DoCapacity, type RelayProfile } from "./host-config.js";
/** NIP-11 的 media type；只有帶這個 `Accept` 的請求才拿到 JSON。 */
export declare const NIP11_MEDIA_TYPE = "application/nostr+json";
/**
 * 本站**實際強制**的 NIP。
 *
 * 刻意只列「relay 這一層真的做了事」的：NIP-17／25／09／59 等是**客戶端**語意（中繼看到的
 * 只是密文外殼），列上去等於對外謊報能力。誠實的清單讓探測器與客戶端能信任它。
 *
 * - 01：事件／簽章／REQ／EOSE
 * - 11：本文件
 * - 13：PoW（`minPowDifficulty`）
 * - 40：過期時戳（＋站方 TTL 上限，ADR-0065）
 * - 42：AUTH（預設開，ADR-0057）
 * - 62：Request to Vanish（ADR-0260）
 */
export declare const SUPPORTED_NIPS: readonly [1, 11, 13, 40, 42, 62];
/** 營運者可填的贊助管道（ADR-0089）；全空＝不顯示贊助入口。 */
export interface CinderDonations {
    github_sponsors?: string | undefined;
    buy_me_a_coffee?: string | undefined;
    liberapay?: string | undefined;
    lightning?: string | undefined;
}
/** 組裝 NIP-11 文件所需的站方設定（由各宿主從自己的環境變數取得）。 */
export interface Nip11Config {
    name?: string | undefined;
    description?: string | undefined;
    /** 營運者公鑰（hex）。 */
    pubkey?: string | undefined;
    contact?: string | undefined;
    /** 站方 TTL 上限原始字串（`MAX_TTL_DAYS`）；未設＝預設 7 天。 */
    maxTtlDays?: string | undefined;
    /** 是否接受檔案塊（`MAX_FILE_MB` 已啟用；ADR-0162）。 */
    acceptsFiles?: boolean | undefined;
    /**
     * 本路徑的單檔上限（MB；Cinderous ADR-0371）。只有 `FILE_LANES` 車道模式下、這條車道收檔案時才有值。
     * relay 看不到明文、也無法重組檔案 ⇒ 這個上限只能**宣告**，由客戶端遵守；
     * relay 端真正擋的是每收件人的檔案塊配額（一併宣告）。
     */
    maxFileMb?: number | undefined;
    /** 是否要求 NIP-42 AUTH。 */
    authRequired?: boolean | undefined;
    /**
     * 這座站處理收件確認嗎（SDK ADR 0067）。未設＝處理（兩個宿主預設都開）；`false`＝不宣告
     *（Node 版 `REQUIRE_AUTH=0`：不發 AUTH 挑戰，就沒有人證明得了「自己的收件匣」）。
     */
    inboxAck?: boolean | undefined;
    /** 設了白名單（`ALLOWED_PUBKEYS`）：只有名單上的人能寫入（SDK ADR 0008）。 */
    writeRestricted?: boolean | undefined;
    /**
     * 本路徑在唯讀寬限期內（SDK ADR 0052）：到期時間（unix 秒）。有值時 `restricted_writes: true`、
     * `cinder_read_only_until` 宣告到期時間；宿主同時把 `acceptsFiles` 設成 false（寫入一律被拒，客戶端不必試）。
     */
    readOnlyUntil?: number | undefined;
    /**
     * 本路徑的政策（ADR-0366）：`strict`＝Cinderous 訊息平面，`app`＝第三方車道。
     * 未設＝`strict`。同一座 Worker 會依請求路徑回不同的文件——一份文件描述不了兩種政策。
     */
    profile?: RelayProfile | undefined;
    /**
     * 本路徑是不是名單上的已知租戶（ADR-0366 §裁示）。公用分片的保存期短得多
     * （ADR-0367 §決策 1），而**不揭露就是不誠實**——對方無從得知「發完就走的資料
     * 兩小時後會消失」。未設＝否（公用分片），與 `storeOptions` 的預設同一側。
     */
    knownLane?: boolean | undefined;
    /**
     * 同一個 IP 每秒最多幾則訊息（`MAX_MESSAGES_PER_SECOND_PER_IP`；PRD 3.3、SDK ADR 0013）。
     * 沒設＝不限，文件也不出現這一欄（SDK ADR 0036）。
     */
    maxMessagesPerSecondPerIp?: number | undefined;
    /**
     * 每把公鑰每分鐘事件上限（SDK ADR 0129）：宿主實際套用的值。沒給＝預設 {@link MAX_EVENTS_PER_MINUTE}；
     * `"off"`＝Node 版設 0 關掉了，文件不出現這一欄。原本一律寫預設值，調過的站會讓客戶端照錯的數字發。
     */
    maxEventsPerMinute?: number | "off" | undefined;
    /**
     * 這條路徑那顆 DO 的容量政策（Cinderous ADR-0377；SDK ADR 0042；`doCapacityFor`）。沒給＝預設天花板、沒有保底與溢位帶。
     * 只宣告**靜態**上限與政策，不宣告即時用量（ADR 0038 M6）。
     */
    capacity?: DoCapacity | undefined;
    /** 贊助管道（ADR-0089）。 */
    donations?: CinderDonations | undefined;
    /** 節點自報（ADR-0092）：已簽章的 `CinderNodeDeclaration` 事件（JSON 字串）。 */
    nodeAttestation?: string | undefined;
    /**
     * IoT 即時通道（SDK ADR 0049 §9.6、SDK ADR 0120）：這座站有沒有開 C′（`IOT_REALTIME` 至少一個家庭有效）。
     * 只宣告能力與心跳間隔，**不列家庭**（homeTag 是路由標籤，列出來等於公開這座站服務哪些家）。
     */
    iotRealtime?: {
        heartbeatSec: number;
    } | undefined;
    software?: string | undefined;
    version?: string | undefined;
}
/**
 * 組出 NIP-11 文件。**未設定的欄位一律不出現**（而非填佔位字串）——一份宣稱
 * `contact: ""` 的文件比沒有 contact 更糟：它讓「有沒有人可問責」這件事變得模糊。
 */
export declare function buildRelayInfo(cfg?: Nip11Config): Record<string, unknown>;
/** 請求是否在要 NIP-11 文件（`Accept: application/nostr+json`）。 */
export declare function wantsRelayInfo(accept: string | null | undefined): boolean;
/** NIP-11 回應的標頭（含 CORS——瀏覽器版客戶端要跨源抓，比照 `/turn`）。 */
export declare const NIP11_HEADERS: {
    readonly "content-type": "application/nostr+json; charset=utf-8";
    readonly "Access-Control-Allow-Origin": "*";
};
//# sourceMappingURL=nip11.d.ts.map