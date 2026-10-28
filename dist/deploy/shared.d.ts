export type DeployStep = 'config' | 'deploy' | 'health' | 'done';
/**
 * 部署進度的子步驟（SDK ADR 0055；CinderSync G20）：比 `step` 細、穩定的 id，介面依它顯示自己的文字。
 * 目前只有 REST 部署（`deployCloudflareRelayViaApi`）提供。
 */
export type DeploySubstep = 'verify-token' | 'account' | 'subdomain' | 'live-config' | 'live-config-skipped' | 'upload' | 'route' | 'health' | 'done';
export interface DeployProgressStatus {
    step: DeployStep;
    /** 中文訊息（v0.42 以前就有；與 `messages['zh-TW']` 相同） */
    message: string;
    /** 子步驟 id（REST 部署才有；SDK ADR 0055） */
    substep?: DeploySubstep;
    /** 雙語訊息（REST 部署才有；SDK ADR 0055）。🔴 不含私人路徑等秘密 */
    messages?: {
        readonly 'zh-TW': string;
        readonly en: string;
    };
}
export type DeployProgress = (status: DeployProgressStatus) => void;
/** 部署的結果（wrangler／docker／fly 共用） */
export interface RelayDeployment {
    name: string;
    /** 產生的主要設定檔 */
    configPath: string;
    /** dryRun 時沒有 */
    httpUrl?: string;
    /** 給客戶端連的端點；dryRun 時沒有 */
    relayEndpoint?: string;
}
export declare const DEFAULT_WORKER_NAME = "cinderous-relay";
export declare const DEFAULT_COMPATIBILITY_DATE = "2026-09-01";
/** Worker 裡 Durable Object 的綁定名稱與類別（`src/relay/worker.ts` 的 `Env.RELAY_ROOM`／`RelayRoom`）。 */
export declare const RELAY_DO_BINDING: {
    readonly name: "RELAY_ROOM";
    readonly className: "RelayRoom";
};
/**
 * Durable Object 遷移，依序套用。wrangler.toml 與 REST 上傳共用這一份。
 * 🔴 已發出去的項目**不能改也不能刪**：已部署的站記得最後一個 tag，重新部署只送它之後的新項目。
 */
export declare const RELAY_DO_MIGRATIONS: readonly {
    tag: string;
    newSqliteClasses: readonly string[];
}[];
/** 名稱限制（Cloudflare Worker、Fly app、compose 專案都吃這個形狀）：小寫英數與連字號、不以連字號開頭、最長 63。 */
export declare const RELAY_NAME_PATTERN: RegExp;
export declare function assertRelayName(name: string, what?: string): void;
/**
 * 雙語的名稱檢查（SDK ADR 0055；CinderSync G20）：與 `assertRelayName` 同一個規則，回傳問題而不丟例外。
 * `worker`＝Worker 名稱（`workerName`）、`subdomain`＝workers.dev 子網域（`workersDevSubdomain`）。合法回 null。
 */
export declare function checkRelayName(name: string, kind: 'worker' | 'subdomain'): DeployIssue | null;
/**
 * 建議給 Vault 同步（CinderSync、Cinder Coffice）用的 `MAX_FILE_MB`（SDK ADR 0027）：
 * 協調器的外層是 kind 1060 檔案塊，中繼沒開檔案事件就整類拒收，同步完全不會動。
 *
 * 🔴 一鍵部署出來的是**自架單人中繼**（白名單、沒有 `FILE_LANES`）：這時 `MAX_FILE_MB` 只是**全站開關**
 * ——≥ 1 就整站收檔案塊，數值本身中繼不強制、NIP-11 也不宣告單檔上限（與 Cinderous ADR-0371
 * 「沒設 `FILE_LANES` 時的行為」一致；SDK ADR 0029）。客戶端因此用預設的 16.5 MB 當經中繼的單檔上限，
 * 要更大可在協調器以 `relayLimits` 自行設定。`MAX_FILE_MB` 變成「單檔上限」只發生在設了 `FILE_LANES`
 * 的車道模式（多租戶的 Cloudflare 站；自架單人站不需要）。
 * 數值 17 對應預設的檔案塊層上限（每塊 48,000 B × 360 塊 ≈ 16.5 MB）。
 */
export declare const VAULT_SYNC_MAX_FILE_MB = 17;
/** 檔案事件（kind 1060）的設定；部署前驗證 */
export interface RelayFileOptions {
    /**
     * 接受檔案塊（kind 1060）：設 ≥ 1 的整數（MB）即啟用（`MAX_FILE_MB`）。沒給＝不收（預設；公共站零儲存風險）。
     * Vault 同步一定要開：用 `VAULT_SYNC_MAX_FILE_MB`。
     * 部署出來的站沒有 `FILE_LANES`，所以這是**全站開關**，不是中繼強制的單檔上限（SDK ADR 0029）。
     */
    maxFileMb?: number;
    /**
     * 允許「開放中繼（沒有白名單）」也收檔案塊。預設 false：沒有白名單時開檔案事件會丟例外——
     * 任何人都能把檔案塊存進你的中繼（每位收件人 4,000 顆、7 天），收件人又可以隨便編，儲存沒有上限。
     */
    openFileRelay?: boolean;
}
/** 驗證並產生 `MAX_FILE_MB`；`allowed` 是已經驗證過的白名單。沒開回 undefined。 */
export declare function maxFileMbVar(opts: RelayFileOptions, allowed: readonly string[] | undefined): string | undefined;
/**
 * 私人路徑（SDK ADR 0051）的最短長度：26 字 base32＝130 位元，至少 128 位元才猜不到。
 * 車道 id 本身最長 64 字（`LANE_ID_PATTERN`）。
 */
export declare const PRIVATE_LANE_MIN_LENGTH = 26;
/**
 * 產生私人路徑的車道 id（SDK ADR 0051）：26 字 base32 小寫，130 位元，以 WebCrypto `getRandomValues` 產生。
 * 每個位元組取低 5 位元（256 是 32 的倍數，沒有偏差）。不碰 Node：外掛的行動版也能用。
 */
export declare function generatePrivateLaneId(): string;
/** 這個字串能不能當私人路徑：符合車道 id 規則（小寫英數起頭、其餘可含 . _ -、最長 64）而且至少 {@link PRIVATE_LANE_MIN_LENGTH} 字。 */
export declare function isPrivateLaneId(id: string): boolean;
/** 把私人路徑接到中繼的根網址後面：`wss://<host>` → `wss://<host>/app/<id>`（容忍結尾斜線）。 */
export declare function privateLaneEndpoint(baseEndpoint: string, laneId: string): string;
/**
 * 從中繼網址取回私人路徑（`wss://<host>/app/<id>` 的 `<id>`）；不是私人路徑（沒有 `/app/`、id 太短或不合法、
 * 不是網址）回 undefined。重新部署時用它從既有網址取回同一個 id（SDK ADR 0051）。
 */
export declare function privateLaneFromUrl(url: string): string | undefined;
/**
 * 換了私人路徑之後，舊路徑的唯讀寬限期（SDK ADR 0052；中繼的 `READONLY_LANES`）。
 * 到期前舊網址連得上、讀得到、不收寫入（其他裝置從這裡讀到「中繼搬家」通知）；到期後與認不得的路徑相同。
 */
export interface ReadOnlyLane {
    /** 舊的車道 id（🔴 它曾經是私人路徑＝秘密；錯誤訊息與進度都不回顯） */
    readonly id: string;
    /** 到期時間（unix 秒） */
    readonly expiresAt: number;
}
/** 唯讀寬限期的天數（SDK ADR 0052）：1–30，預設 7。 */
export declare const READ_ONLY_GRACE_DAYS: {
    readonly min: 1;
    readonly max: 30;
    readonly default: 7;
};
/** `READONLY_LANES` 的值：`<id>@<到期 unix 秒>`，逗號分隔（與中繼的 `readOnlyLanesFrom` 同一個格式） */
export declare function readOnlyLanesVar(lanes: readonly ReadOnlyLane[]): string;
/** 營運者自報的贊助管道（NIP-11 `cinder_donations`；Cinderous ADR-0089）。全部沒給＝不顯示贊助入口（ADR 0019）。 */
export interface RelayDonationOptions {
    githubSponsors?: string;
    buyMeACoffee?: string;
    liberapay?: string;
    lightning?: string;
}
/**
 * 一鍵部署可以設定的中繼參數（SDK ADR 0036、0037）。四條部署路徑（REST、wrangler、docker、fly）共用，
 * 驗證與環境變數的對應只寫在 {@link relaySiteVars} 一處。
 *
 * 每一項都對應中繼**已經在讀**的環境變數；中繼寫死的常數（可尋址配額、每收件人上限、每顆 DO 天花板、
 * 每分鐘事件上限……）不在這裡——要開放得先改中繼（見 ADR 0037 的〈後續〉）。
 * 🔴 沒有任何選項能「關掉限速」或「無界保存」：範圍都有上下限，超出就在部署前丟例外。
 */
export interface RelaySiteOptions extends RelayFileOptions {
    /** 白名單（`ALLOWED_PUBKEYS`）：`npub` 或 hex。沒給＝開放中繼。寫錯任何一筆，部署前就拒絕。 */
    allowedPubkeys?: readonly string[];
    /**
     * 私人路徑模式（SDK ADR 0051）：個人專屬中繼「開放寫入＋不可猜的隨機路徑」。給一個至少 128 位元的隨機車道 id
     * （{@link generatePrivateLaneId}；符合車道 id 規則、至少 {@link PRIVATE_LANE_MIN_LENGTH} 字），部署出來的中繼：
     * `APP_LANES`＝它、`LANES_ONLY=1`（主平面與其他路徑一律拒絕），Cloudflare 版開了 `maxFileMb` 時 `FILE_LANES`＝它。
     * 客戶端連 `wss://<host>/app/<id>`（{@link privateLaneEndpoint}）。
     *
     * - 白名單在這個模式下**選用**：沒有白名單也可以收檔案塊（不需要 `openFileRelay`；放寬 ADR 0027 §2）。
     * - 🔴 這個 id **等同密碼**：網址外洩＝任何人都能寫入、用你的額度。補救是換一個 id 重新部署（舊網址立即失效）。
     * - 與 `appLanes`／`fileLanes` 互斥。Node 主機（docker／fly／home-tunnel）也支援（沒有 `FILE_LANES`，`MAX_FILE_MB` 照舊是全站開關）。
     * - 部署設定檔（`cinderous.config.json`）裡只能寫 `{ "$env": "NAME" }`（它是秘密）。
     */
    privateLane?: string;
    /**
     * 唯讀寬限期的舊路徑（SDK ADR 0052；`READONLY_LANES`）：換了私人路徑之後，舊的車道 id 到 `expiresAt` 為止
     * 只能讀（其他裝置從那裡收到搬家通知）。已經過期的項目直接略過（「過期的自動清掉」）；最多 {@link "@cinderous/client/relay"!READONLY_LANES_MAX} 條、
     * 最遠到現在＋31 天；不能與 `privateLane`／`appLanes` 重複。REST 部署另有 `retireLane` 自動算出這一項並保留線上還沒到期的。
     * 🔴 舊的 id 也是秘密：錯誤訊息不回顯；設定檔只能寫 `{ "$env": "NAME" }`（值是 `READONLY_LANES` 的格式）。
     */
    readOnlyLanes?: readonly ReadOnlyLane[];
    /** NIP-11 站名（`RELAY_NAME`）。沒給用 SDK 的中立預設值（ADR 0019）。最長 100 字。 */
    relayName?: string;
    /** NIP-11 描述（`RELAY_DESCRIPTION`）。最長 500 字。 */
    relayDescription?: string;
    /** NIP-11 聯絡方式（`RELAY_CONTACT`），例如 `mailto:` 或網址。最長 200 字。 */
    relayContact?: string;
    /** NIP-11 營運者公鑰（`RELAY_PUBKEY`）：`npub` 或 hex，寫進去的是 hex。 */
    relayPubkey?: string;
    /** 贊助管道（`DONATE_*`）。每項最長 200 字。 */
    donations?: RelayDonationOptions;
    /**
     * NIP-11 `software`（`RELAY_SOFTWARE_URL`；SDK ADR 0050 使用者裁示 10）：這座站跑的程式的原始碼網址，必須是 https、最長 200 字。
     * 沒給＝SDK 的中立預設（SDK 的 repo，ADR 0019）。🔴 **改過中繼程式**再對外提供服務的人，AGPL §13 要求向網路使用者提供
     * 修改後的原始碼：把這一項指向你的修改版。兩種主機都支援。
     */
    relaySoftwareUrl?: string;
    /**
     * 離線留言（一般事件）的保存上限（天，`MAX_TTL_DAYS`；Cinderous ADR-0160）。1–365，沒給＝中繼預設 7 天。
     * 不影響可尋址事件（固定 30 天、每次更新重算）與公用車道的見習保存（2 小時）。
     */
    maxTtlDays?: number;
    /** 同一把公鑰最多幾條連線（`MAX_CONNECTIONS_PER_PUBKEY`；PRD 3.3）。1–100，預設 5。只對完成 NIP-42 AUTH 的連線計數。 */
    maxConnectionsPerPubkey?: number;
    /**
     * 同一個 IP 每秒最多幾則進站訊息（`MAX_MESSAGES_PER_SECOND_PER_IP`；PRD 3.3）。1–1000，預設 20。
     * 超過就關閉那條連線。🔴 一次推很多事件的客戶端（例如一口氣上傳 64 個桶）要自己節流，或把這個值調高。
     */
    maxMessagesPerSecondPerIp?: number;
    /**
     * 已知租戶名單（`APP_LANES`；Cinderous ADR-0366 §裁示）：這些車道（`/app/<id>`）各自有一顆 DO，
     * 可尋址配額 64／(作者, kind)、保存期是正常的 30 天；不在名單上的車道落到公用分片（16、見習 2 小時）。
     * **不是白名單**：沒列的車道照常服務。只有 Cloudflare 版有車道（Node 主機沒有）。
     *
     * 🔴 名單改了＝那條車道換一顆 DO：舊 DO 裡的可尋址事件與離線留言不會搬過去（等 TTL 到期），
     * 對那條車道而言是一次冷啟動。重新部署要帶**同一份**名單（REST 路徑會檢查，見 `allowLaneChange`）。
     */
    appLanes?: readonly string[];
    /**
     * 只在這幾條車道收檔案塊（`FILE_LANES`；Cinderous ADR-0371）。必須同時在 `appLanes` 上、而且要開 `maxFileMb`；
     * 設了之後 `maxFileMb` 變成這幾條車道的**單檔上限**，其他路徑一律不收。只有 Cloudflare 版。
     */
    fileLanes?: readonly string[];
    /**
     * 車道的 NIP-13 PoW 最低難度（`APP_LANE_POW`）。0–32，0＝不要求（預設）。只有 Cloudflare 版、只影響車道。
     * 🔴 打開之前先確認該車道的客戶端會挖礦，否則它們的持久化事件會全部被拒。
     */
    appLanePow?: number;
    /** 連線被拒時指向的開發文件網址（`DEVELOPER_DOCS_URL`；Cinderous ADR-0368）。必須是 https。只有 Cloudflare 版。 */
    developerDocsUrl?: string;
    /**
     * 每顆 DO 的容量天花板（`DO_CEILINGS_MIB`；Cinderous ADR-0377，SDK ADR 0042）。鍵是類別（`strict`／`public`／`lane`／`file`）
     * 或單顆 DO 名（`global`、`presence`、`shard-a`、`app-3`、`app:<appLanes 上的 id>`），單顆優先；值是離線與可尋址各幾 MiB（1–8192）。
     * 沒給＝中繼預設（每顆 128／128 MiB、檔案車道離線 1 GiB）。🔴 帳號總量是「天花板 × DO 數」：用 `storageBudgetBytes` 或
     * `computeCeilingBudget` 守。Node 主機（SDK ADR 0099）只認 `strict`，上限放寬到 1 TiB（1–1048576）。
     */
    doCeilings?: Readonly<Record<string, {
        readonly offlineMib: number;
        readonly addressableMib: number;
    }>>;
    /**
     * 保底份額（`DO_GUARANTEE_KIB`；SDK ADR 0042，ADR 0038 P2）：共用 DO 內每位作者／收件人的保底（KiB，64–16384）。
     * 只能設在淘汰制的對象（`public`／`lane`／`file` 或它們的 DO 名）。Node 主機要 `ceilingMode: 'evict'` 才能設在 `strict`（SDK ADR 0099）。
     */
    doGuaranteeKib?: Readonly<Record<string, number>>;
    /**
     * 溢位帶（`DO_BORROW_PERCENT`；SDK ADR 0042，ADR 0039 B1）：天花板之上借用的百分比（1–50）。借用保存 2 小時、最先被淘汰。
     * 淘汰制的對象要同時設保底才生效（沒有就拒絕部署——設了卻不生效比部署失敗更難查）。會讓最壞儲存量乘上 1 + r。Node 主機只認 `strict`。
     */
    doBorrowPercent?: Readonly<Record<string, number>>;
    /** 粗分級預警（`DO_NEAR_FULL_PERCENT`；SDK ADR 0042）：50–99。會對寫入者透露「這顆 DO 快滿了」的粗略分級。Node 主機只認 `strict`。 */
    doNearFullPercent?: Readonly<Record<string, number>>;
    /** 丟棄計數（`DO_DROP_NOTICES`；SDK ADR 0042）：開啟的對象。每次讀收件匣多一次寫入。Node 主機只認 `strict`。 */
    doDropNotices?: readonly string[];
    /**
     * 滿了之後（`CEILING_MODE`；SDK ADR 0099）：`reject`（預設，拒收、寄件端收到 `blocked: ceiling`）或 `evict`（淘汰最快到期的）。
     * 只有 Node 主機：Cloudflare 版由路由決定（主訊息平面拒收、車道淘汰）。
     */
    ceilingMode?: 'reject' | 'evict';
    /** 全站最多幾條同時連線（`MAX_CONNECTIONS`；SDK ADR 0100）。沒給＝不限。只有 Node 主機 */
    maxConnections?: number;
    /** 同一個 IP 最多幾條同時連線（`MAX_CONNECTIONS_PER_IP`；SDK ADR 0100）。沒給＝不限（共用 IP 的人不會被誤擋）。只有 Node 主機 */
    maxConnectionsPerIp?: number;
    /**
     * 每月流量預算（`MONTHLY_TRAFFIC_GIB`；SDK ADR 0101）。沒給＝不限。用完時新舊連線都收到 `over quota:`、到重置日恢復。
     * 中繼只算得到 WebSocket 裡的資料量，建議設成 VPS 方案的九成左右。只有 Node 主機
     */
    monthlyTrafficGib?: number;
    /** 每月幾號 00:00 UTC 歸零（`TRAFFIC_RESET_DAY`，1–28，預設 1）：對齊 VPS 的帳單日。要有 `monthlyTrafficGib` */
    trafficResetDay?: number;
    /** 流量怎麼算（`TRAFFIC_COUNT`）：`total`（預設，進出合計）或 `out`（只算出去的）。要有 `monthlyTrafficGib` */
    trafficCount?: 'total' | 'out';
    /** 用到幾 % 開始在 `OK` 帶預警（`TRAFFIC_NEAR_FULL_PERCENT`，50–99）。要有 `monthlyTrafficGib` */
    trafficNearFullPercent?: number;
    /**
     * 帳號儲存預算（位元組）：給了就在部署前以 `computeCeilingBudget` 算所有可能 DO 的最壞加總（含溢位帶），超出就拒絕部署。
     * Cloudflare 免費方案建議 `ACCOUNT_STORAGE_BUDGET_BYTES`（5 GB 的 80%）。沒給＝不檢查（中繼的預設天花板本身就超過免費額度，見 ADR 0039）。
     */
    storageBudgetBytes?: number;
}
/** 只有 Cloudflare 版中繼會讀的選項（Node 主機沒有車道、也不讀文件網址）。 */
export declare const WORKER_ONLY_SITE_OPTIONS: readonly ["appLanes", "fileLanes", "appLanePow", "developerDocsUrl", "storageBudgetBytes"];
/** 只有 Node 主機會讀的選項（SDK ADR 0099）。 */
export declare const NODE_ONLY_SITE_OPTIONS: readonly ["ceilingMode", "maxConnections", "maxConnectionsPerIp", "monthlyTrafficGib", "trafficResetDay", "trafficCount", "trafficNearFullPercent"];
/** 一鍵部署開放的數值範圍（SDK ADR 0037）。 */
export declare const RELAY_SITE_LIMITS: {
    readonly maxTtlDays: {
        readonly min: 1;
        readonly max: 365;
    };
    readonly maxConnectionsPerPubkey: {
        readonly min: 1;
        readonly max: 100;
    };
    readonly maxMessagesPerSecondPerIp: {
        readonly min: 1;
        readonly max: 1000;
    };
    /** 全站同時連線數（SDK ADR 0100） */
    readonly maxConnections: {
        readonly min: 1;
        readonly max: 1000000;
    };
    /** 每個 IP 的同時連線數（SDK ADR 0100） */
    readonly maxConnectionsPerIp: {
        readonly min: 1;
        readonly max: 10000;
    };
    /** 每月流量預算（GiB）、重置日、預警（SDK ADR 0101）：與中繼相同 */
    readonly monthlyTrafficGib: {
        readonly min: 1;
        readonly max: 1048576;
    };
    readonly trafficResetDay: {
        readonly min: 1;
        readonly max: 28;
    };
    readonly trafficNearFullPercent: {
        readonly min: 50;
        readonly max: 99;
    };
    readonly appLanePow: {
        readonly min: 0;
        readonly max: 32;
    };
    /** 每條已知租戶都是一顆獨立的 DO；名單是給「知道形狀的應用」，不是給任意數量的車道。 */
    readonly maxAppLanes: 32;
    readonly relayName: 100;
    readonly relayDescription: 500;
    readonly relayContact: 200;
    readonly donation: 200;
    readonly developerDocsUrl: 200;
    readonly relaySoftwareUrl: 200;
    /** 檔案塊總開關／單檔上限（MB） */
    readonly maxFileMb: {
        readonly min: 1;
        readonly max: 1024;
    };
    /** 每顆 DO 的天花板（MiB）：與中繼相同（單顆 SQLite DO 實體上限 10 GB） */
    readonly doCeilingMib: {
        readonly min: 1;
        readonly max: 8192;
    };
    /** Node 主機的天花板（MiB；SDK ADR 0099）：與中繼相同，實際上限交給硬碟 */
    readonly nodeCeilingMib: {
        readonly min: 1;
        readonly max: 1048576;
    };
    /** 保底（KiB）：64 KiB–16 MiB。中繼接受 1 KiB–64 MiB，一鍵部署收緊 */
    readonly doGuaranteeKib: {
        readonly min: 64;
        readonly max: 16384;
    };
    /** 溢位帶（%）：1–50。中繼接受到 100，一鍵部署收緊（最壞儲存量乘上 1 + r） */
    readonly doBorrowPercent: {
        readonly min: 1;
        readonly max: 50;
    };
    readonly doNearFullPercent: {
        readonly min: 50;
        readonly max: 99;
    };
};
/** 驗證問題的嚴重度：`error` 會讓部署被拒，`warning` 只提醒（SDK ADR 0050 §3）。 */
export type DeployIssueSeverity = 'error' | 'warning';
/**
 * 一則驗證問題（SDK ADR 0050 §3）。收集式驗證一次回傳全部，給互動介面（精靈、網頁、外掛設定頁）一次列出。
 * - `path`：相對於被驗證的物件，例如 `maxTtlDays`、`doCeilings.global.offlineMib`；設定檔驗證會再加上 `site.` 之類的前綴。
 * - `code`：穩定的機器可讀代碼（例如 `out-of-range`、`worker-only`、`invalid-lane`），UI 可以依它決定怎麼呈現。
 * - `message`：繁中與英文各一句；繁中與 `relaySiteVars` 丟出的例外訊息逐字相同。
 */
export interface DeployIssue {
    path: string;
    code: string;
    severity: DeployIssueSeverity;
    message: {
        readonly 'zh-TW': string;
        readonly en: string;
    };
}
/** 收集問題的小工具；`throwFirst` 讓「有錯就丟第一個」的舊介面沿用同一份規則。 */
export declare class IssueList {
    readonly issues: DeployIssue[];
    error(path: string, code: string, zh: string, en: string): void;
    warn(path: string, code: string, zh: string, en: string): void;
    get hasErrors(): boolean;
    throwFirst(): void;
}
/** 車道 id 清單：每筆都要符合中繼的 `LANE_ID_PATTERN`（不自動轉小寫——寫錯要看得見）；去重、保留順序。 */
export declare function laneListVar(what: string, lanes: readonly string[] | undefined): string[];
/**
 * 驗證 {@link RelaySiteOptions} 並產生中繼的環境變數（SDK ADR 0036、0037）——**四條部署路徑的單一真實來源**。
 *
 * - `host: 'worker'`：Cloudflare（REST 與 wrangler）。
 * - `host: 'node'`：docker／fly 的 Node 主機。它沒有車道（Cinderous ADR-0366 §決策 8），
 *   給了 {@link WORKER_ONLY_SITE_OPTIONS} 會丟例外——設了卻不生效，比部署失敗更難查。
 *
 * PRD 3.3 的防濫用預設（ADR 0013）永遠寫入：每把公鑰 5 條連線、每 IP 每秒 20 則。
 * 有錯就丟**第一個**錯誤；要一次拿到全部問題用 {@link collectRelaySiteIssues}（同一份規則，SDK ADR 0050 §3）。
 */
export declare function relaySiteVars(opts: RelaySiteOptions, host: 'worker' | 'node'): Record<string, string>;
/**
 * 收集式驗證（SDK ADR 0050 §3）：與 {@link relaySiteVars} **同一份規則、同樣的順序**，但回傳全部問題、不丟例外。
 * 給互動介面一次列出所有問題；空陣列＝可以部署。壞型別（例如 JSON 設定檔把數字寫成字串）也列成問題。
 */
export declare function collectRelaySiteIssues(opts: RelaySiteOptions, host: 'worker' | 'node'): DeployIssue[];
/**
 * Worker 的環境變數（plain text vars）。wrangler.toml 的 `[vars]` 與 REST 上傳的 `plain_text` 綁定共用。
 * 等於 `relaySiteVars(opts, 'worker')`；保留這個名字維持相容。
 *
 * - PRD 3.3 的防濫用預設（SDK ADR 0013）：每把公鑰 5 條連線、每 IP 每秒 20 則。
 * - 白名單（ADR 0008）：先驗證、npub 轉 hex；寫錯任何一筆就丟例外，不會部署出一座開放中繼。
 * - 站名（ADR 0019）：沒給就不設，NIP-11 用 SDK 的中立預設值。
 * - 檔案塊（ADR 0027）：`maxFileMb` 才開；開放中繼要另外明確允許。
 * - 已知租戶與其他參數（ADR 0036、0037）：見 {@link RelaySiteOptions}。
 */
export declare function relayWorkerVars(opts?: RelaySiteOptions): Record<string, string>;
/** `compatibility_date` 的形狀（YYYY-MM-DD）；寫錯的日期 Cloudflare 會在上傳時才拒絕，這裡先擋。 */
export declare function assertCompatibilityDate(date: string): void;
/** `assertCompatibilityDate` 的雙語問題版本（SDK ADR 0055）；合法回 null */
export declare function checkCompatibilityDate(date: string): DeployIssue | null;
/** 兩份車道名單是否相同（順序、大小寫、空白不計；與中繼的 `knownLanes` 同一個正規化）。 */
export declare function sameLaneList(a: string | undefined, b: string | undefined): boolean;
/** 健康檢查只需要這麼多；全域 `fetch` 與外掛的轉接器都相容。 */
export type HealthFetch = (url: string) => Promise<{
    status: number;
    text(): Promise<string>;
}>;
/**
 * 打 `/healthz` 直到回 `ok`：新部署要幾秒才上線，所以重試。
 * 全部失敗就丟例外——絕不能在沒驗到的情況下回報成功。
 */
export declare function waitForHealthy(httpUrl: string, opts?: {
    fetch?: HealthFetch;
    retries?: number;
    delayMs?: number;
}): Promise<void>;
//# sourceMappingURL=shared.d.ts.map