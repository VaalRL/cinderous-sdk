// NIP-11 Relay Information Document（ADR-0260，承接 ADR-0089／0092 的未竟待辦）。
//
// ## 為什麼這份檔案存在
//
// ADR-0089（營運者贊助入口）與 ADR-0092（節點自報 `cinder_node`）**都建立在「relay 能回一份
// NIP-11 文件」之上**，但兩座宿主過去對 HTTP GET 一律只回純文字 `"Cinderous relay"`。於是：
//
// - 社群營運者**沒有任何收入面**（贊助連結無處可放，見 ADR-0257 §2）；
// - 節點申請流程（ADR-0092）缺了它指定的載體；
// - 客戶端要知道站方政策（TTL／檔案／速率）只能**送出去被拒才知道**。
//
// 這不是新決策，是把已接受的決策做完。
//
// ## 契約：只有明確要 JSON 的人才拿得到 JSON
//
// 依 `Accept: application/nostr+json` 分支；**不帶此 header 時維持原純文字 200**——PaaS／
// 容器健康檢查（ADR-0075）與既有探測都靠那個 200，改掉會讓部署中的站看起來像掛了。

import { INBOX_ACK_KIND } from "../protocol/index.js";
import { BORROW_TTL_SECONDS, NEAR_FULL_TOP_PERCENT, overflowBand } from "./capacity.js";
import {
  type DoCapacity,
  inboxAckGraceFor,
  MAX_EVENTS_PER_MINUTE,
  MAX_FUTURE_SKEW_SEC,
  MAX_PAST_SKEW_SEC,
  MAX_PER_RECIPIENT,
  MAX_SUBSCRIPTIONS,
  type RelayProfile,
  storeOptions,
} from "./host-config.js";
import {
  ADDRESSABLE_MAX_BYTES,
  ADDRESSABLE_MAX_PER_AUTHOR,
  ADDRESSABLE_TTL_SECONDS,
  DEFAULT_MAX_TTL_SECONDS,
  MAX_QUERY_ROWS,
} from "./message-store.js";

/** NIP-11 的 media type；只有帶這個 `Accept` 的請求才拿到 JSON。 */
export const NIP11_MEDIA_TYPE = "application/nostr+json";

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
export const SUPPORTED_NIPS = [1, 11, 13, 40, 42, 62] as const;

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
  iotRealtime?: { heartbeatSec: number } | undefined;
  software?: string | undefined;
  version?: string | undefined;
}

/** 去掉值為 undefined／空字串的欄位；全空的物件本身也一併拿掉。 */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === "") continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * 組出 NIP-11 文件。**未設定的欄位一律不出現**（而非填佔位字串）——一份宣稱
 * `contact: ""` 的文件比沒有 contact 更糟：它讓「有沒有人可問責」這件事變得模糊。
 */
export function buildRelayInfo(cfg: Nip11Config = {}): Record<string, unknown> {
  // 🔴 直接問 `storeOptions`，不自己算一份：文件要說的就是**這座站實際在執行的那組值**。
  // 兩邊各算各的，遲早會出現「文件說 7 天、實際存 2 小時」——而那種謊言查起來最貴。
  const store = storeOptions(cfg.maxTtlDays, cfg.profile ?? "strict", cfg.knownLane === true, cfg.maxFileMb, cfg.capacity);
  // 溢位帶實際生效的平面（與 store 的決策同一個條件，`capacity.ts`）：拒收制，或淘汰制又有保底；嚴格平面的可尋址不借用
  const evicts = store.ceilingEvicts === true;
  const borrowsAt = (max: number | undefined, plane: boolean): boolean =>
    plane && overflowBand(max, store.overflowRatio) > 0 && (!evicts || store.guaranteeBytes !== undefined);
  const borrowPlanes = [
    ...(borrowsAt(store.offlineMaxTotalBytes, true) ? ["offline"] : []),
    ...(borrowsAt(store.addressableMaxTotalBytes, store.addressableBorrows !== false) ? ["addressable"] : []),
  ];
  const ttlSeconds = store.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
  const addressableTtl = store.addressableTtlSeconds ?? ADDRESSABLE_TTL_SECONDS;
  const donations = compact({ ...(cfg.donations ?? {}) });

  let nodeAttestation: unknown;
  if (cfg.nodeAttestation) {
    try {
      nodeAttestation = JSON.parse(cfg.nodeAttestation); // 壞 JSON 就當沒設，不讓整份文件掛掉
    } catch {
      nodeAttestation = undefined;
    }
  }

  return compact({
    // 預設值是中立的 SDK 名稱（SDK ADR 0019）；Cinderous 的錨點以 RELAY_NAME 設成 "Cinderous relay"
    name: cfg.name ?? "Cinderous SDK relay",
    description:
      cfg.description ??
      "Cinderous 中繼站：只轉發密文的 Nostr relay（Ephemeral 純轉發、NIP-40 有界保留）。",
    pubkey: cfg.pubkey,
    contact: cfg.contact,
    supported_nips: [...SUPPORTED_NIPS],
    // 這座站跑的是 SDK 的中繼程式（SDK ADR 0007）：軟體來源就是 SDK
    software: cfg.software ?? "https://github.com/VaalRL/cinderous-sdk",
    version: cfg.version,
    /**
     * 站方硬性限制——把「送出去被拒才知道」變成「連線前就知道」。
     * 值全部取自實際生效的常數，不是另抄一份（抄一份就會漂移）。
     */
    limitation: compact({
      max_subscriptions: MAX_SUBSCRIPTIONS,
      max_limit: MAX_QUERY_ROWS,
      max_message_length: ADDRESSABLE_MAX_BYTES,
      auth_required: cfg.authRequired === true,
      payment_required: false, // 本專案不做站內金流（PRD §12）
      restricted_writes: cfg.authRequired === true || cfg.writeRestricted === true || cfg.readOnlyUntil !== undefined,
    }),
    /** 唯讀寬限期（SDK ADR 0052）：這條路徑到這個時間（unix 秒）為止只能讀，之後與認不得的路徑相同。 */
    ...(cfg.readOnlyUntil !== undefined ? { cinder_read_only_until: cfg.readOnlyUntil } : {}),
    retention: [{ time: ttlSeconds }],
    /** 每 pubkey 每分鐘事件上限（ADR-0235 H1）；非 NIP-11 標準欄位，故加前綴。 */
    cinder_max_events_per_minute: MAX_EVENTS_PER_MINUTE,
    /** 每收件人離線留言上限（PRD §8）。 */
    cinder_max_per_recipient: MAX_PER_RECIPIENT,
    /**
     * 時鐘窗（秒；ADR-0235 H1）。**客戶端算得出來才有用**：
     * 第三方的 epoch 結算要以「過去窗」為下界決定「多久之後這個 epoch 不可能再被塞事件」
     *（見 `docs/research/game-layer-spec.md` §4.3），而在此之前那個值**沒有任何管道問得到**。
     * 非 NIP-11 標準欄位，故加前綴。
     */
    cinder_max_past_skew_sec: MAX_PAST_SKEW_SEC,
    cinder_max_future_skew_sec: MAX_FUTURE_SKEW_SEC,
    /**
     * 訂閱政策（ADR-0366）：`named`＝必須帶 `#p`（自己）或 `authors`（ADR-0123）；
     * `tagged`＝另外接受任一標籤 filter。同樣是「連線前就知道」而不是「送出去被拒才知道」。
     */
    cinder_subscription_scope: cfg.profile === "app" ? "tagged" : "named",
    /**
     * 可尋址事件（NIP-33）的壽命（秒）。**原本完全沒有揭露過**——客戶端只能猜，
     * 而公用分片的見習保存（ADR-0367）讓這個值從 30 天變成 2 小時，猜錯的代價是
     * 「我發的牌組不見了」。`retention` 講的是留言，這一欄講的是可尋址事件。
     */
    cinder_addressable_ttl_sec: addressableTtl,
    /**
     * 可尋址事件的配額（SDK ADR 0036）：每 (作者, kind) 幾個位址、單顆幾位元組（事件 JSON 長度）。
     * 與 `cinder_addressable_ttl_sec` 同一個理由——已知租戶 64、公用車道 16、嚴格平面 5，
     * 客戶端原本只能「送到第 17 個被拒」才知道自己落在哪一種車道。
     */
    cinder_addressable_per_author: store.addressablePerAuthor ?? ADDRESSABLE_MAX_PER_AUTHOR,
    cinder_addressable_max_bytes: store.addressableMaxBytes ?? ADDRESSABLE_MAX_BYTES,
    /**
     * 每 IP 每秒訊息上限（SDK ADR 0036）：超過就被斷線，而一次推很多事件的客戶端需要據此節流。
     * 只有設了才出現（Cinderous 錨點不設）。
     */
    ...(cfg.maxMessagesPerSecondPerIp !== undefined
      ? { cinder_max_messages_per_second_per_ip: cfg.maxMessagesPerSecondPerIp }
      : {}),
    /**
     * 容量天花板與滿了之後的政策（SDK ADR 0042；ADR 0038 M6）：`evict`＝淘汰最快到期的（車道），`reject`＝拒收（嚴格平面）。
     * 只有靜態上限；即時用量不公開（`warning: near-full:` 只給寫入者粗分級）。讓客戶端**連線前**就知道這座是淘汰制。
     */
    cinder_ceiling_policy: evicts ? "evict" : "reject",
    cinder_ceiling_bytes: compact({
      offline: store.offlineMaxTotalBytes,
      addressable: store.addressableMaxTotalBytes,
    }),
    /** 保底份額（SDK ADR 0042）：每位作者／收件人在這顆 DO 內不會被別人擠掉的量。只有設了才出現。 */
    ...(store.guaranteeBytes !== undefined && evicts ? { cinder_guarantee_bytes: store.guaranteeBytes } : {}),
    /**
     * 溢位帶（SDK ADR 0042；ADR 0039）：天花板之上的借用，保存 `cinder_borrow_ttl_sec` 秒、最先被淘汰。
     * 中繼不能改事件的 NIP-40 `expiration`（有簽章），借用的保存期只能在這裡與 `OK true "warning: borrowed: …"` 說。
     */
    ...(borrowPlanes.length > 0
      ? {
          cinder_borrow_ttl_sec: store.borrowTtlSeconds ?? BORROW_TTL_SECONDS,
          cinder_borrow_percent: Math.round((store.overflowRatio ?? 0) * 100),
          cinder_borrow_planes: borrowPlanes,
        }
      : {}),
    /** 粗分級預警的兩級（SDK ADR 0042）：寫入後達這些百分比以上時 `OK true` 帶 `warning: near-full:`。 */
    ...(store.nearFullPercent !== undefined
      ? {
          cinder_near_full_percent:
            store.nearFullPercent < NEAR_FULL_TOP_PERCENT ? [store.nearFullPercent, NEAR_FULL_TOP_PERCENT] : [store.nearFullPercent],
        }
      : {}),
    /**
     * 收件確認（SDK ADR 0067 §2）：收件人處理完可以送這個 kind，中繼把那幾列降為「現在＋`grace_sec`」到期。
     * 客戶端只對宣告了的中繼送。唯讀寬限期的路徑不宣告（寫入一律被拒）。
     */
    ...(cfg.readOnlyUntil === undefined && cfg.inboxAck !== false
      ? { cinder_inbox_ack: { kind: INBOX_ACK_KIND, grace_sec: inboxAckGraceFor(store) } }
      : {}),
    /** 丟棄計數（SDK ADR 0042）：讀自己的收件匣時會收到 `NOTICE "warning: dropped: …"`。 */
    ...(store.countDrops === true ? { cinder_drop_notices: true } : {}),
    /**
     * IoT 即時通道（SDK ADR 0049 §9.6）：`ws`＝設備常駐 WebSocket；`longpoll` 還沒實作（R4），如實寫 false。
     */
    ...(cfg.iotRealtime !== undefined
      ? { cinder_iot: { realtime: { ws: true, longpoll: false, heartbeat_sec: cfg.iotRealtime.heartbeatSec } } }
      : {}),
    /** 是否接受檔案塊（ADR-0162）：false＝整類拒收，客戶端不必試。 */
    cinder_accepts_files: cfg.acceptsFiles === true,
    /**
     * 檔案車道（Cinderous ADR-0371）：單檔上限（MB）與每收件人檔案塊配額（塊數，每塊 48,000 B 明文）。
     * 未設 `FILE_LANES` 的站（企業自架）不出現這兩欄——那裡 `MAX_FILE_MB` 仍只是開關。
     */
    ...(cfg.acceptsFiles === true && cfg.maxFileMb !== undefined
      ? { cinder_max_file_mb: cfg.maxFileMb, cinder_file_chunks_per_recipient: store.filePerRecipient }
      : {}),
    /** 營運者自報的贊助管道（ADR-0089）；全空則整個欄位不出現＝無贊助入口。 */
    ...(Object.keys(donations).length > 0 ? { cinder_donations: donations } : {}),
    /** 營運者簽章的節點自報（ADR-0092）；供維護者工具拉取驗簽。 */
    ...(nodeAttestation !== undefined ? { cinder_node: nodeAttestation } : {}),
  });
}

/** 請求是否在要 NIP-11 文件（`Accept: application/nostr+json`）。 */
export function wantsRelayInfo(accept: string | null | undefined): boolean {
  return typeof accept === "string" && accept.toLowerCase().includes(NIP11_MEDIA_TYPE);
}

/** NIP-11 回應的標頭（含 CORS——瀏覽器版客戶端要跨源抓，比照 `/turn`）。 */
export const NIP11_HEADERS = {
  "content-type": `${NIP11_MEDIA_TYPE}; charset=utf-8`,
  "Access-Control-Allow-Origin": "*",
} as const;
