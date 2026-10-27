// 各部署路徑共用、而且**不碰 Node** 的部分（SDK ADR 0021；原本在 common.ts，ADR 0008、0018）。
//
// wrangler 路徑（`./deploy`）與 REST API 路徑（`./deploy/cloudflare-api`）都從這裡取：
// 名稱驗證、健康檢查、Worker 的預設值、Durable Object 綁定與遷移、中繼的環境變數。
// 🔴 本檔與它引用的模組不得出現 `node:*`：外掛的行動版（iOS／Android）沒有 Node，
// 只要模組圖裡有一個就會在載入時崩潰。守門測試：tests/deploy/cloudflare-api-guard.test.ts。
import {
  allowedPubkeysFrom,
  ceilingClassOf,
  computeCeilingBudget,
  DO_CEILING_MAX_MIB,
  doCapacityFor,
  doCapacitySettings,
  knownLanes,
  NODE_CEILING_MAX_MIB,
  nodeCapacityFrom,
  PRD_MAX_CONNECTIONS_PER_PUBKEY,
  PRD_MAX_MESSAGES_PER_SECOND_PER_IP,
  READONLY_LANES_MAX,
} from '../relay/host-config.js';
import { allDoNames, LANE_ID_PATTERN } from '../relay/shard.js';
import { TRAFFIC_LIMITS } from '../relay/traffic-budget.js';

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
  messages?: { readonly 'zh-TW': string; readonly en: string };
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

export const DEFAULT_WORKER_NAME = 'cinderous-relay';
export const DEFAULT_COMPATIBILITY_DATE = '2026-09-01';

/** Worker 裡 Durable Object 的綁定名稱與類別（`src/relay/worker.ts` 的 `Env.RELAY_ROOM`／`RelayRoom`）。 */
export const RELAY_DO_BINDING = { name: 'RELAY_ROOM', className: 'RelayRoom' } as const;

/**
 * Durable Object 遷移，依序套用。wrangler.toml 與 REST 上傳共用這一份。
 * 🔴 已發出去的項目**不能改也不能刪**：已部署的站記得最後一個 tag，重新部署只送它之後的新項目。
 */
export const RELAY_DO_MIGRATIONS: readonly { tag: string; newSqliteClasses: readonly string[] }[] = [
  { tag: 'v1', newSqliteClasses: [RELAY_DO_BINDING.className] },
];

/** 名稱限制（Cloudflare Worker、Fly app、compose 專案都吃這個形狀）：小寫英數與連字號、不以連字號開頭、最長 63。 */
export const RELAY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertRelayName(name: string, what = '名稱'): void {
  if (!RELAY_NAME_PATTERN.test(name)) throw new Error(`${what}「${name}」不合法：只能用小寫英數與連字號、不以連字號開頭、最長 63 字`);
}

/**
 * 雙語的名稱檢查（SDK ADR 0055；CinderSync G20）：與 `assertRelayName` 同一個規則，回傳問題而不丟例外。
 * `worker`＝Worker 名稱（`workerName`）、`subdomain`＝workers.dev 子網域（`workersDevSubdomain`）。合法回 null。
 */
export function checkRelayName(name: string, kind: 'worker' | 'subdomain'): DeployIssue | null {
  if (typeof name === 'string' && RELAY_NAME_PATTERN.test(name)) return null;
  const shown = typeof name === 'string' ? name : String(name);
  const [path, zh, en] = kind === 'worker' ? ['workerName', 'Worker 名稱', 'Worker name'] : ['workersDevSubdomain', 'workers.dev 子網域', 'workers.dev subdomain'];
  return {
    path,
    code: 'invalid-name',
    severity: 'error',
    message: {
      'zh-TW': `${zh}「${shown}」不合法：只能用小寫英數與連字號、不以連字號開頭、最長 63 字`,
      en: `${en} "${shown}" is invalid: use lowercase letters, digits and hyphens only, do not start with a hyphen, at most 63 characters`,
    },
  };
}

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
export const VAULT_SYNC_MAX_FILE_MB = 17;
/** `MAX_FILE_MB` 允許的範圍 */
const MAX_FILE_MB_CAP = 1024;

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
export function maxFileMbVar(opts: RelayFileOptions, allowed: readonly string[] | undefined): string | undefined {
  const issues = new IssueList();
  const mb = maxFileMbIn(issues, opts, allowed !== undefined && allowed.length > 0);
  issues.throwFirst();
  return mb;
}

/** 私人路徑（SDK ADR 0051）：驗證、與 appLanes／fileLanes 互斥。🔴 訊息絕不回顯值（它是秘密）。 */
function privateLaneIn(issues: IssueList, opts: RelaySiteOptions): string | undefined {
  if (opts.privateLane === undefined) return undefined;
  const id = opts.privateLane;
  if (typeof id !== 'string' || !isPrivateLaneId(id)) {
    issues.error(
      'privateLane',
      'invalid-private-lane',
      `私人路徑（privateLane）不合法：必須是至少 ${PRIVATE_LANE_MIN_LENGTH} 字的隨機車道 id（小寫英數起頭，其餘可含 . _ -，最長 64 字；用 generatePrivateLaneId 產生）`,
      `privateLane is invalid: it must be a random lane id of at least ${PRIVATE_LANE_MIN_LENGTH} characters (starting with a lowercase letter or digit, may contain . _ -, at most 64; use generatePrivateLaneId)`,
    );
    return undefined;
  }
  const hasLanes = (list: readonly string[] | undefined) => Array.isArray(list) && list.length > 0;
  if (hasLanes(opts.appLanes) || hasLanes(opts.fileLanes)) {
    issues.error(
      'privateLane',
      'private-lane-exclusive',
      '私人路徑（privateLane）不能和 appLanes／fileLanes 一起用：這個模式整座站只有那一條路徑',
      'privateLane cannot be combined with appLanes / fileLanes: in this mode the relay has exactly one path',
    );
    return undefined;
  }
  return id;
}

function maxFileMbIn(issues: IssueList, opts: RelayFileOptions, hasAllowlist: boolean): string | undefined {
  if (opts.maxFileMb === undefined) return undefined;
  const mb = opts.maxFileMb;
  if (!Number.isInteger(mb) || mb < 1 || mb > MAX_FILE_MB_CAP) {
    issues.error(
      'maxFileMb',
      'out-of-range',
      `maxFileMb 必須是 1–${MAX_FILE_MB_CAP} 的整數，收到 ${mb}`,
      `maxFileMb must be an integer from 1 to ${MAX_FILE_MB_CAP}; got ${mb}`,
    );
    return undefined;
  }
  if (!hasAllowlist && opts.openFileRelay !== true) {
    issues.error(
      'maxFileMb',
      'open-file-relay',
      '開放中繼（沒有白名單）不應接受檔案塊：任何人都能把資料存進來、儲存沒有上限。請給白名單（allowedPubkeys）、改用私人路徑（privateLane），或明確設定 openFileRelay: true',
      'An open relay (no allowlist) should not accept file chunks: anyone could store data in it without limit. Set an allowlist (allowedPubkeys), use a private path (privateLane), or explicitly set openFileRelay: true',
    );
    return undefined;
  }
  return String(mb);
}

/**
 * 私人路徑（SDK ADR 0051）的最短長度：26 字 base32＝130 位元，至少 128 位元才猜不到。
 * 車道 id 本身最長 64 字（`LANE_ID_PATTERN`）。
 */
export const PRIVATE_LANE_MIN_LENGTH = 26;

/** base32 小寫字母表（RFC 4648 的字母，小寫）：每個字 5 位元，全部符合車道 id 規則。 */
const BASE32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * 產生私人路徑的車道 id（SDK ADR 0051）：26 字 base32 小寫，130 位元，以 WebCrypto `getRandomValues` 產生。
 * 每個位元組取低 5 位元（256 是 32 的倍數，沒有偏差）。不碰 Node：外掛的行動版也能用。
 */
export function generatePrivateLaneId(): string {
  const bytes = new Uint8Array(PRIVATE_LANE_MIN_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => BASE32_LOWER[b & 31]).join('');
}

/** 這個字串能不能當私人路徑：符合車道 id 規則（小寫英數起頭、其餘可含 . _ -、最長 64）而且至少 {@link PRIVATE_LANE_MIN_LENGTH} 字。 */
export function isPrivateLaneId(id: string): boolean {
  return typeof id === 'string' && id.length >= PRIVATE_LANE_MIN_LENGTH && LANE_ID_PATTERN.test(id);
}

/** 把私人路徑接到中繼的根網址後面：`wss://<host>` → `wss://<host>/app/<id>`（容忍結尾斜線）。 */
export function privateLaneEndpoint(baseEndpoint: string, laneId: string): string {
  return `${baseEndpoint.replace(/\/+$/, '')}/app/${laneId}`;
}

/**
 * 從中繼網址取回私人路徑（`wss://<host>/app/<id>` 的 `<id>`）；不是私人路徑（沒有 `/app/`、id 太短或不合法、
 * 不是網址）回 undefined。重新部署時用它從既有網址取回同一個 id（SDK ADR 0051）。
 */
export function privateLaneFromUrl(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const m = /^\/app\/([^/]+)\/?$/.exec(pathname);
  const id = m?.[1];
  return id !== undefined && isPrivateLaneId(id) ? id : undefined;
}

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
export const READ_ONLY_GRACE_DAYS = { min: 1, max: 30, default: 7 } as const;

/** 到期時間最遠可以設到「現在＋最長寬限期」再多一天（時鐘誤差與跨日） */
const READ_ONLY_MAX_AHEAD_SEC = (READ_ONLY_GRACE_DAYS.max + 1) * 86_400;

/** `READONLY_LANES` 的值：`<id>@<到期 unix 秒>`，逗號分隔（與中繼的 `readOnlyLanesFrom` 同一個格式） */
export function readOnlyLanesVar(lanes: readonly ReadOnlyLane[]): string {
  return lanes.map((lane) => `${lane.id}@${lane.expiresAt}`).join(',');
}

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
   * 只能讀（其他裝置從那裡收到搬家通知）。已經過期的項目直接略過（「過期的自動清掉」）；最多 {@link READONLY_LANES_MAX} 條、
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
  doCeilings?: Readonly<Record<string, { readonly offlineMib: number; readonly addressableMib: number }>>;
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
export const WORKER_ONLY_SITE_OPTIONS = [
  'appLanes',
  'fileLanes',
  'appLanePow',
  'developerDocsUrl',
  // 容量設定 Node 主機也支援了（SDK ADR 0099，只認 `strict`）；帳號儲存預算仍是 Cloudflare 帳號的概念
  'storageBudgetBytes',
] as const;

/** 只有 Node 主機會讀的選項（SDK ADR 0099）。 */
export const NODE_ONLY_SITE_OPTIONS = [
  'ceilingMode',
  'maxConnections',
  'maxConnectionsPerIp',
  'monthlyTrafficGib',
  'trafficResetDay',
  'trafficCount',
  'trafficNearFullPercent',
] as const;

/** 一鍵部署開放的數值範圍（SDK ADR 0037）。 */
export const RELAY_SITE_LIMITS = {
  maxTtlDays: { min: 1, max: 365 },
  maxConnectionsPerPubkey: { min: 1, max: 100 },
  maxMessagesPerSecondPerIp: { min: 1, max: 1000 },
  /** 全站同時連線數（SDK ADR 0100） */
  maxConnections: { min: 1, max: 1_000_000 },
  /** 每個 IP 的同時連線數（SDK ADR 0100） */
  maxConnectionsPerIp: { min: 1, max: 10_000 },
  /** 每月流量預算（GiB）、重置日、預警（SDK ADR 0101）：與中繼相同 */
  monthlyTrafficGib: TRAFFIC_LIMITS.monthlyGib,
  trafficResetDay: TRAFFIC_LIMITS.resetDay,
  trafficNearFullPercent: TRAFFIC_LIMITS.nearFullPercent,
  appLanePow: { min: 0, max: 32 },
  /** 每條已知租戶都是一顆獨立的 DO；名單是給「知道形狀的應用」，不是給任意數量的車道。 */
  maxAppLanes: 32,
  relayName: 100,
  relayDescription: 500,
  relayContact: 200,
  donation: 200,
  developerDocsUrl: 200,
  relaySoftwareUrl: 200,
  /** 檔案塊總開關／單檔上限（MB） */
  maxFileMb: { min: 1, max: MAX_FILE_MB_CAP },
  /** 每顆 DO 的天花板（MiB）：與中繼相同（單顆 SQLite DO 實體上限 10 GB） */
  doCeilingMib: { min: 1, max: DO_CEILING_MAX_MIB },
  /** Node 主機的天花板（MiB；SDK ADR 0099）：與中繼相同，實際上限交給硬碟 */
  nodeCeilingMib: { min: 1, max: NODE_CEILING_MAX_MIB },
  /** 保底（KiB）：64 KiB–16 MiB。中繼接受 1 KiB–64 MiB，一鍵部署收緊 */
  doGuaranteeKib: { min: 64, max: 16_384 },
  /** 溢位帶（%）：1–50。中繼接受到 100，一鍵部署收緊（最壞儲存量乘上 1 + r） */
  doBorrowPercent: { min: 1, max: 50 },
  doNearFullPercent: { min: 50, max: 99 },
} as const;

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
  message: { readonly 'zh-TW': string; readonly en: string };
}

/** 收集問題的小工具；`throwFirst` 讓「有錯就丟第一個」的舊介面沿用同一份規則。 */
export class IssueList {
  readonly issues: DeployIssue[] = [];

  error(path: string, code: string, zh: string, en: string): void {
    this.issues.push({ path, code, severity: 'error', message: { 'zh-TW': zh, en } });
  }

  warn(path: string, code: string, zh: string, en: string): void {
    this.issues.push({ path, code, severity: 'warning', message: { 'zh-TW': zh, en } });
  }

  get hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === 'error');
  }

  throwFirst(): void {
    const first = this.issues.find((issue) => issue.severity === 'error');
    if (first) throw new Error(first.message['zh-TW']);
  }
}

function intIn(issues: IssueList, what: string, value: number, range: { min: number; max: number }): string | undefined {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    issues.error(
      what,
      'out-of-range',
      `${what} 必須是 ${range.min}–${range.max} 的整數，收到 ${value}`,
      `${what} must be an integer from ${range.min} to ${range.max}; got ${value}`,
    );
    return undefined;
  }
  return String(value);
}

// 控制字元（含換行）一律拒絕：這些值會寫進 wrangler.toml、docker-compose.yml、fly.toml 與 NIP-11。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function textIn(issues: IssueList, what: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    issues.error(what, 'type', `${what} 必須是字串`, `${what} must be a string`);
    return undefined;
  }
  const text = value.trim();
  if (text === '') return undefined;
  if (CONTROL_CHARS.test(text)) {
    issues.error(what, 'control-chars', `${what} 不能含換行或控制字元`, `${what} must not contain line breaks or control characters`);
    return undefined;
  }
  if (text.length > max) {
    issues.error(what, 'too-long', `${what} 最長 ${max} 字，收到 ${text.length} 字`, `${what} may be at most ${max} characters; got ${text.length}`);
    return undefined;
  }
  return text;
}

/** https 網址（文件網址、軟體來源）：拒絕 `http:`、`javascript:` 與不是網址的字串。 */
function httpsUrlIn(issues: IssueList, what: string, value: string | undefined, max: number): string | undefined {
  const text = textIn(issues, what, value, max);
  if (text === undefined) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:') {
    issues.error(what, 'not-https', `${what} 必須是 https 網址，收到 ${text}`, `${what} must be an https URL; got ${text}`);
    return undefined;
  }
  return text;
}

/** 陣列型的選項（來自 JSON 設定檔時可能不是陣列）：不是陣列就記一筆問題、當作沒給。 */
function listIn(issues: IssueList, what: string, value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.error(what, 'type', `${what} 必須是字串陣列`, `${what} must be an array of strings`);
    return [];
  }
  return value;
}

function laneListIn(issues: IssueList, what: string, lanes: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of listIn(issues, what, lanes)) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!LANE_ID_PATTERN.test(id)) {
      issues.error(
        what,
        'invalid-lane',
        `${what}「${raw}」不是合法的車道 id：小寫英數起頭，其餘可含 . _ -，最長 64 字`,
        `${what} "${raw}" is not a valid lane id: it must start with a lowercase letter or digit, may contain . _ -, and be at most 64 characters`,
      );
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 車道 id 清單：每筆都要符合中繼的 `LANE_ID_PATTERN`（不自動轉小寫——寫錯要看得見）；去重、保留順序。 */
export function laneListVar(what: string, lanes: readonly string[] | undefined): string[] {
  const issues = new IssueList();
  const out = laneListIn(issues, what, lanes);
  issues.throwFirst();
  return out;
}

const workerOnlyZh = (keys: readonly string[]): string =>
  `${keys.join('、')} 只有 Cloudflare 版中繼支援：Node 主機（docker／fly）沒有應用車道（Cinderous ADR-0366 §決策 8；SDK ADR 0036）`;

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
export function relaySiteVars(opts: RelaySiteOptions, host: 'worker' | 'node'): Record<string, string> {
  const { vars, issues } = evaluateRelaySite(opts, host);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    // Node 主機收到 Worker 限定的參數：一直是一句話列出全部（v0.31 起的訊息），其他問題都排在它後面
    const workerOnly = errors.filter((issue) => issue.code === 'worker-only');
    throw new Error(workerOnly.length > 0 ? workerOnlyZh(workerOnly.map((issue) => issue.path)) : errors[0]!.message['zh-TW']);
  }
  return vars;
}

/**
 * 收集式驗證（SDK ADR 0050 §3）：與 {@link relaySiteVars} **同一份規則、同樣的順序**，但回傳全部問題、不丟例外。
 * 給互動介面一次列出所有問題；空陣列＝可以部署。壞型別（例如 JSON 設定檔把數字寫成字串）也列成問題。
 */
export function collectRelaySiteIssues(opts: RelaySiteOptions, host: 'worker' | 'node'): DeployIssue[] {
  return evaluateRelaySite(opts, host).issues;
}

function evaluateRelaySite(opts: RelaySiteOptions, host: 'worker' | 'node'): { vars: Record<string, string>; issues: DeployIssue[] } {
  const issues = new IssueList();
  const vars: Record<string, string> = {};
  try {
    siteVarsInto(issues, opts, host, vars);
  } catch (error) {
    // 保險：規則本身不該丟例外；萬一有（例如沒料到的型別），也列成問題而不是讓介面崩潰
    const message = error instanceof Error ? error.message : String(error);
    issues.error('', 'invalid', `站台參數無法驗證：${message}`, `The site options could not be validated: ${message}`);
  }
  return { vars, issues: issues.issues };
}

function siteVarsInto(issues: IssueList, opts: RelaySiteOptions, host: 'worker' | 'node', vars: Record<string, string>): void {
  if (host === 'node') {
    for (const key of WORKER_ONLY_SITE_OPTIONS) {
      const value = opts[key];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        issues.error(
          key,
          'worker-only',
          workerOnlyZh([key]),
          `${key} is only supported by the Cloudflare relay: the Node host (docker / fly / home-tunnel) has no app lanes (Cinderous ADR-0366 §8; SDK ADR 0036)`,
        );
      }
    }
  } else {
    for (const key of NODE_ONLY_SITE_OPTIONS) {
      if (opts[key] !== undefined) {
        issues.error(
          key,
          'node-only',
          `${key} 只有 Node 主機（docker／fly／home-tunnel）支援：Cloudflare 版滿了之後的行為由路由決定（主訊息平面拒收、車道淘汰；SDK ADR 0099）`,
          `${key} is only supported by the Node host (docker / fly / home-tunnel): on Cloudflare the routing decides (the message plane rejects, lanes evict; SDK ADR 0099)`,
        );
      }
    }
  }
  const limits = RELAY_SITE_LIMITS;
  const connections =
    opts.maxConnectionsPerPubkey === undefined
      ? String(PRD_MAX_CONNECTIONS_PER_PUBKEY)
      : intIn(issues, 'maxConnectionsPerPubkey', opts.maxConnectionsPerPubkey, limits.maxConnectionsPerPubkey);
  if (connections !== undefined) vars.MAX_CONNECTIONS_PER_PUBKEY = connections;
  const perIp =
    opts.maxMessagesPerSecondPerIp === undefined
      ? String(PRD_MAX_MESSAGES_PER_SECOND_PER_IP)
      : intIn(issues, 'maxMessagesPerSecondPerIp', opts.maxMessagesPerSecondPerIp, limits.maxMessagesPerSecondPerIp);
  if (perIp !== undefined) vars.MAX_MESSAGES_PER_SECOND_PER_IP = perIp;
  // 同時連線數（SDK ADR 0100）：只有 Node 主機；Cloudflare 版給了已在上面列成 node-only 錯誤
  if (host === 'node' && opts.maxConnections !== undefined) {
    const total = intIn(issues, 'maxConnections', opts.maxConnections, limits.maxConnections);
    if (total !== undefined) vars.MAX_CONNECTIONS = total;
  }
  if (host === 'node' && opts.maxConnectionsPerIp !== undefined) {
    const each = intIn(issues, 'maxConnectionsPerIp', opts.maxConnectionsPerIp, limits.maxConnectionsPerIp);
    if (each !== undefined) vars.MAX_CONNECTIONS_PER_IP = each;
  }
  if (host === 'node') trafficIn(issues, opts, vars);

  const rawAllowed = listIn(issues, 'allowedPubkeys', opts.allowedPubkeys);
  let allowed: string[] | undefined;
  let hasAllowlist = false;
  try {
    allowed = allowedPubkeysFrom(rawAllowed.join(','));
    hasAllowlist = allowed !== undefined && allowed.length > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.error('allowedPubkeys', 'invalid-pubkey', message, `allowedPubkeys contains an entry that is not a valid npub or 64-character hex public key (${message})`);
    // 名單有給、只是寫錯：後面「開放中繼收檔案塊」的檢查不該再多報一次
    hasAllowlist = rawAllowed.length > 0;
  }
  // 公鑰本來就是公開的，放 vars 即可、不必用 secret；放 vars 也讓站方在儀表板上看得到名單。
  if (allowed && allowed.length > 0) vars.ALLOWED_PUBKEYS = allowed.join(',');
  const name = textIn(issues, 'relayName', opts.relayName, limits.relayName);
  if (name !== undefined) vars.RELAY_NAME = name;
  const description = textIn(issues, 'relayDescription', opts.relayDescription, limits.relayDescription);
  if (description !== undefined) vars.RELAY_DESCRIPTION = description;
  const contact = textIn(issues, 'relayContact', opts.relayContact, limits.relayContact);
  if (contact !== undefined) vars.RELAY_CONTACT = contact;
  if (opts.relayPubkey !== undefined && (typeof opts.relayPubkey !== 'string' || opts.relayPubkey.trim() !== '')) {
    let operator: string[] | undefined;
    try {
      operator = typeof opts.relayPubkey === 'string' ? allowedPubkeysFrom(opts.relayPubkey) : undefined;
    } catch {
      operator = undefined;
    }
    if (!operator || operator.length !== 1) {
      issues.error(
        'relayPubkey',
        'invalid-pubkey',
        `relayPubkey 必須是一把 npub 或 64 字元 hex 公鑰，收到 ${opts.relayPubkey}`,
        `relayPubkey must be one npub or 64-character hex public key; got ${opts.relayPubkey}`,
      );
    } else {
      vars.RELAY_PUBKEY = operator[0]!;
    }
  }
  const donationVars: [keyof RelayDonationOptions, string][] = [
    ['githubSponsors', 'DONATE_GITHUB_SPONSORS'],
    ['buyMeACoffee', 'DONATE_BUY_ME_A_COFFEE'],
    ['liberapay', 'DONATE_LIBERAPAY'],
    ['lightning', 'DONATE_LIGHTNING'],
  ];
  for (const [key, envName] of donationVars) {
    const value = textIn(issues, `donations.${key}`, opts.donations?.[key], limits.donation);
    if (value !== undefined) vars[envName] = value;
  }
  if (opts.maxTtlDays !== undefined) {
    const ttl = intIn(issues, 'maxTtlDays', opts.maxTtlDays, limits.maxTtlDays);
    if (ttl !== undefined) vars.MAX_TTL_DAYS = ttl;
  }
  const privateLane = privateLaneIn(issues, opts);
  // 私人路徑模式（SDK ADR 0051）：路徑本身就是門票，開放寫入也可以收檔案塊（放寬 ADR 0027 §2）
  const fileMb = maxFileMbIn(issues, opts, hasAllowlist || privateLane !== undefined);
  if (fileMb !== undefined) vars.MAX_FILE_MB = fileMb;
  if (privateLane !== undefined) {
    vars.APP_LANES = privateLane;
    vars.LANES_ONLY = '1';
    // Node 主機沒有車道 DO：MAX_FILE_MB 照舊是全站開關，而全站只剩這一條路徑（Cinderous ADR-0371）
    if (fileMb !== undefined && host === 'worker') vars.FILE_LANES = privateLane;
  }

  const appLanes = laneListIn(issues, 'appLanes', opts.appLanes);
  if (appLanes.length > limits.maxAppLanes) {
    issues.error(
      'appLanes',
      'too-many-lanes',
      `appLanes 最多 ${limits.maxAppLanes} 條（每條是一顆獨立的 DO），收到 ${appLanes.length} 條`,
      `appLanes may list at most ${limits.maxAppLanes} lanes (each is its own Durable Object); got ${appLanes.length}`,
    );
  } else if (appLanes.length > 0) {
    vars.APP_LANES = appLanes.join(',');
  }
  const fileLaneList = laneListIn(issues, 'fileLanes', opts.fileLanes);
  if (fileLaneList.length > 0) {
    // 中繼會默默忽略不在 APP_LANES 上的檔案車道（只在 log 警告）；部署端直接擋下，設錯要看得見。
    const missing = fileLaneList.filter((id) => !appLanes.includes(id));
    if (missing.length > 0) {
      issues.error(
        'fileLanes',
        'file-lane-not-app-lane',
        `fileLanes 裡的車道必須同時在 appLanes 上（有自己的 DO）：${missing.join(', ')}`,
        `Every lane in fileLanes must also be in appLanes (with its own Durable Object): ${missing.join(', ')}`,
      );
    } else if (opts.maxFileMb === undefined) {
      issues.error(
        'fileLanes',
        'file-lanes-need-max-file-mb',
        'fileLanes 需要 maxFileMb（車道模式下它是單檔上限）',
        'fileLanes needs maxFileMb (in lane mode it is the per-file limit)',
      );
    } else if (fileMb !== undefined) {
      vars.FILE_LANES = fileLaneList.join(',');
    }
  }
  readOnlyLanesIn(issues, opts, [...(privateLane !== undefined ? [privateLane] : []), ...appLanes], vars);
  if (opts.appLanePow !== undefined) {
    const pow = intIn(issues, 'appLanePow', opts.appLanePow, limits.appLanePow);
    if (pow !== undefined && pow !== '0') vars.APP_LANE_POW = pow;
  }
  capacityIn(issues, opts, vars, host);
  const docs = httpsUrlIn(issues, 'developerDocsUrl', opts.developerDocsUrl, limits.developerDocsUrl);
  if (docs !== undefined) vars.DEVELOPER_DOCS_URL = docs;
  const software = httpsUrlIn(issues, 'relaySoftwareUrl', opts.relaySoftwareUrl, limits.relaySoftwareUrl);
  if (software !== undefined) vars.RELAY_SOFTWARE_URL = software;
}

/**
 * 唯讀寬限期（SDK ADR 0052）：驗證並寫出 `READONLY_LANES`。過期的略過；🔴 訊息絕不回顯車道 id（它曾經是秘密）。
 * `active` 是這次照常可寫的車道（私人路徑、`appLanes`）：同一條不能又可寫又唯讀。
 */
function readOnlyLanesIn(issues: IssueList, opts: RelaySiteOptions, active: readonly string[], vars: Record<string, string>): void {
  if (opts.readOnlyLanes === undefined) return;
  if (!Array.isArray(opts.readOnlyLanes)) {
    issues.error('readOnlyLanes', 'type', 'readOnlyLanes 必須是陣列', 'readOnlyLanes must be an array');
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const kept = new Map<string, number>();
  opts.readOnlyLanes.forEach((lane: ReadOnlyLane, index: number) => {
    const path = `readOnlyLanes[${index}]`;
    const id = typeof lane?.id === 'string' ? lane.id.trim() : '';
    if (!LANE_ID_PATTERN.test(id)) {
      issues.error(
        `${path}.id`,
        'invalid-read-only-lane',
        `${path}.id 不是合法的車道 id：小寫英數起頭，其餘可含 . _ -，最長 64 字`,
        `${path}.id is not a valid lane id: it must start with a lowercase letter or digit, may contain . _ -, and be at most 64 characters`,
      );
      return;
    }
    const expiresAt = lane.expiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      issues.error(`${path}.expiresAt`, 'out-of-range', `${path}.expiresAt 必須是 unix 秒（正整數）`, `${path}.expiresAt must be a unix time in seconds (a positive integer)`);
      return;
    }
    if (expiresAt <= nowSec) return; // 過期的自動清掉
    if (expiresAt > nowSec + READ_ONLY_MAX_AHEAD_SEC) {
      issues.error(
        `${path}.expiresAt`,
        'read-only-too-long',
        `${path} 的唯讀寬限期最長 ${READ_ONLY_GRACE_DAYS.max} 天`,
        `${path}: the read-only grace period is at most ${READ_ONLY_GRACE_DAYS.max} days`,
      );
      return;
    }
    if (active.includes(id)) {
      issues.error(
        path,
        'read-only-lane-active',
        `${path} 與這次照常可寫的車道（privateLane／appLanes）相同：同一條不能又可寫又唯讀`,
        `${path} is the same as a writable lane in this deployment (privateLane / appLanes): a lane cannot be both writable and read-only`,
      );
      return;
    }
    kept.set(id, Math.max(expiresAt, kept.get(id) ?? 0));
  });
  if (kept.size > READONLY_LANES_MAX) {
    issues.error(
      'readOnlyLanes',
      'too-many-lanes',
      `readOnlyLanes 最多 ${READONLY_LANES_MAX} 條（每條是一顆還留著資料的 DO），收到 ${kept.size} 條`,
      `readOnlyLanes may list at most ${READONLY_LANES_MAX} lanes (each is a Durable Object that still holds data); got ${kept.size}`,
    );
    return;
  }
  if (kept.size > 0) vars.READONLY_LANES = readOnlyLanesVar([...kept].map(([id, expiresAt]) => ({ id, expiresAt })));
}

/** 物件鍵的對象清單要依字母排序寫出（同一份設定每次產生同一個字串）。 */
function sortedEntries<T>(record: Readonly<Record<string, T>> | undefined): [string, T][] {
  if (record === undefined || record === null || typeof record !== 'object') return [];
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 容量設定（SDK ADR 0042）：驗證、產生五個環境變數，並用中繼**同一個解析器**確認每一項都會生效——
 * 中繼對設錯的項目只 `console.warn` 然後退回預設（可能比你設的大），部署端直接擋下。
 * 範圍錯了就不再做後面衍生的檢查（生效與否、預算）：那些是用不完整的設定算的，只會把同一個錯多報幾次。
 */
function capacityIn(issues: IssueList, opts: RelaySiteOptions, vars: Record<string, string>, host: 'worker' | 'node'): void {
  const limits = RELAY_SITE_LIMITS;
  const before = issues.issues.length;
  const ceilings: string[] = [];
  const ceilingMib = host === 'node' ? limits.nodeCeilingMib : limits.doCeilingMib;
  for (const [target, c] of sortedEntries(opts.doCeilings)) {
    const offline = intIn(issues, `doCeilings.${target}.offlineMib`, c?.offlineMib as number, ceilingMib);
    const addressable = intIn(issues, `doCeilings.${target}.addressableMib`, c?.addressableMib as number, ceilingMib);
    if (offline !== undefined && addressable !== undefined) ceilings.push(`${target}=${offline}/${addressable}`);
  }
  const numbers = (what: string, record: Readonly<Record<string, number>> | undefined, range: { min: number; max: number }): string[] => {
    const out: string[] = [];
    for (const [target, n] of sortedEntries(record)) {
      const value = intIn(issues, `${what}.${target}`, n, range);
      if (value !== undefined) out.push(`${target}=${value}`);
    }
    return out;
  };
  const guarantee = numbers('doGuaranteeKib', opts.doGuaranteeKib, limits.doGuaranteeKib);
  const borrow = numbers('doBorrowPercent', opts.doBorrowPercent, limits.doBorrowPercent);
  const nearFull = numbers('doNearFullPercent', opts.doNearFullPercent, limits.doNearFullPercent);
  const drops = [
    ...new Set(
      listIn(issues, 'doDropNotices', opts.doDropNotices)
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t !== ''),
    ),
  ];
  const mode = opts.ceilingMode;
  if (host === 'node' && mode !== undefined && mode !== 'reject' && mode !== 'evict') {
    issues.error(
      'ceilingMode',
      'invalid',
      `ceilingMode 只能是 reject 或 evict，收到 ${String(mode)}`,
      `ceilingMode must be reject or evict; got ${String(mode)}`,
    );
  }
  if (issues.issues.length > before) return;
  const capacity: Record<string, string> = {};
  if (host === 'node' && mode !== undefined) capacity.CEILING_MODE = mode;
  if (ceilings.length > 0) capacity.DO_CEILINGS_MIB = ceilings.join(',');
  if (guarantee.length > 0) capacity.DO_GUARANTEE_KIB = guarantee.join(',');
  if (borrow.length > 0) capacity.DO_BORROW_PERCENT = borrow.join(',');
  if (nearFull.length > 0) capacity.DO_NEAR_FULL_PERCENT = nearFull.join(',');
  if (drops.length > 0) capacity.DO_DROP_NOTICES = drops.join(',');
  Object.assign(vars, capacity);
  const env = { ...vars };
  if (host === 'node') {
    nodeCapacityIn(issues, env);
    return;
  }
  const settings = doCapacitySettings(env);
  if (settings.ignored.length > 0) {
    issues.error(
      'doCeilings',
      'capacity-ignored',
      `容量設定有中繼不會採用的項目：${settings.ignored.join('；')}。對象必須是 strict／public／lane／file 或路由會建立的 DO 名` +
        `（global、presence、shard-0..f、app-0..7、app:<appLanes 上的 id>），保底只能設在淘汰制（不是 strict）`,
      `The relay would ignore these capacity settings: ${settings.ignored.join('; ')}. Targets must be strict / public / lane / file or a DO name ` +
        `the router creates (global, presence, shard-0..f, app-0..7, app:<id in appLanes>); a guarantee only applies to evicting classes (not strict)`,
    );
    return;
  }
  // 溢位帶在淘汰制要有保底才生效（SDK ADR 0042）：設了卻不生效，擋下來。用中繼同一個函式逐顆 DO 算
  const idle = allDoNames(knownLanes(env.APP_LANES)).filter((doName) => {
    const doCapacity = doCapacityFor(env, doName);
    return doCapacity.overflowRatio !== undefined && ceilingClassOf(env, doName) !== 'strict' && doCapacity.guaranteeBytes === undefined;
  });
  if (idle.length > 0) {
    issues.error(
      'doBorrowPercent',
      'borrow-without-guarantee',
      `doBorrowPercent 在這些淘汰制的 DO 不會生效（沒有 doGuaranteeKib）：${idle.join(', ')}（SDK ADR 0042）`,
      `doBorrowPercent would have no effect on these evicting DOs (no doGuaranteeKib): ${idle.join(', ')} (SDK ADR 0042)`,
    );
    return;
  }
  if (opts.storageBudgetBytes !== undefined) {
    const budget = computeCeilingBudget(env, opts.storageBudgetBytes);
    if (!budget.withinBudget) {
      const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(0)} MiB`;
      issues.error(
        'storageBudgetBytes',
        'over-budget',
        `所有可能 DO 的最壞儲存加總 ${mib(budget.totalBytes)} 超過預算 ${mib(budget.budgetBytes)}` +
          `（${budget.rows.length} 顆 DO；每多一條 appLanes 車道多 ${mib(budget.laneCostBytes)}）。請調低 doCeilings 或溢位帶，或減少 appLanes`,
        `The worst-case storage across all possible DOs, ${mib(budget.totalBytes)}, exceeds the budget of ${mib(budget.budgetBytes)} ` +
          `(${budget.rows.length} DOs; each extra appLanes lane adds ${mib(budget.laneCostBytes)}). Lower doCeilings or the overflow band, or use fewer appLanes`,
      );
    }
  }
}

/** 每月流量預算（SDK ADR 0101）：只有 Node 主機。附屬的三項沒有預算就不會生效，擋下來 */
function trafficIn(issues: IssueList, opts: RelaySiteOptions, vars: Record<string, string>): void {
  const limits = RELAY_SITE_LIMITS;
  if (opts.monthlyTrafficGib === undefined) {
    const orphans = (['trafficResetDay', 'trafficCount', 'trafficNearFullPercent'] as const).filter((key) => opts[key] !== undefined);
    if (orphans.length > 0) {
      issues.error(
        orphans[0]!,
        'traffic-without-budget',
        `${orphans.join('、')} 要搭配 monthlyTrafficGib 才會生效（SDK ADR 0101）`,
        `${orphans.join(', ')} only take effect together with monthlyTrafficGib (SDK ADR 0101)`,
      );
    }
    return;
  }
  const gib = intIn(issues, 'monthlyTrafficGib', opts.monthlyTrafficGib, limits.monthlyTrafficGib);
  if (gib !== undefined) vars.MONTHLY_TRAFFIC_GIB = gib;
  if (opts.trafficResetDay !== undefined) {
    const day = intIn(issues, 'trafficResetDay', opts.trafficResetDay, limits.trafficResetDay);
    if (day !== undefined) vars.TRAFFIC_RESET_DAY = day;
  }
  if (opts.trafficCount !== undefined) {
    if (opts.trafficCount === 'total' || opts.trafficCount === 'out') vars.TRAFFIC_COUNT = opts.trafficCount;
    else {
      issues.error(
        'trafficCount',
        'invalid',
        `trafficCount 只能是 total 或 out，收到 ${String(opts.trafficCount)}`,
        `trafficCount must be total or out; got ${String(opts.trafficCount)}`,
      );
    }
  }
  if (opts.trafficNearFullPercent !== undefined) {
    const pct = intIn(issues, 'trafficNearFullPercent', opts.trafficNearFullPercent, limits.trafficNearFullPercent);
    if (pct !== undefined) vars.TRAFFIC_NEAR_FULL_PERCENT = pct;
  }
}

/**
 * Node 主機的容量設定（SDK ADR 0099）：用中繼同一個解析器確認每一項都會生效。Node 主機只有一套嚴格政策，
 * 所以對象只能是 `strict`；保底只在 `ceilingMode: 'evict'` 生效；淘汰制的溢位帶要同時有保底（與 Cloudflare 版相同）。
 */
function nodeCapacityIn(issues: IssueList, env: Record<string, string>): void {
  const { capacity, ignored } = nodeCapacityFrom(env);
  if (ignored.length > 0) {
    issues.error(
      'doCeilings',
      'capacity-ignored',
      `容量設定有中繼不會採用的項目：${ignored.join('；')}。Node 主機沒有車道與分片，對象只能是 strict；保底只在 ceilingMode 為 evict 時生效（SDK ADR 0099）`,
      `The relay would ignore these capacity settings: ${ignored.join('; ')}. The Node host has no lanes or shards, so the only target is strict; ` +
        `a guarantee only applies with ceilingMode evict (SDK ADR 0099)`,
    );
    return;
  }
  if (capacity?.evicts === true && capacity.overflowRatio !== undefined && capacity.guaranteeBytes === undefined) {
    issues.error(
      'doBorrowPercent',
      'borrow-without-guarantee',
      'ceilingMode 為 evict 時，doBorrowPercent 要同時有 doGuaranteeKib 才會生效（SDK ADR 0042、0099）',
      'With ceilingMode evict, doBorrowPercent only takes effect together with doGuaranteeKib (SDK ADR 0042, 0099)',
    );
  }
}

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
export function relayWorkerVars(opts: RelaySiteOptions = {}): Record<string, string> {
  return relaySiteVars(opts, 'worker');
}

/** `compatibility_date` 的形狀（YYYY-MM-DD）；寫錯的日期 Cloudflare 會在上傳時才拒絕，這裡先擋。 */
export function assertCompatibilityDate(date: string): void {
  const issue = checkCompatibilityDate(date);
  if (issue) throw new Error(issue.message['zh-TW']);
}

/** `assertCompatibilityDate` 的雙語問題版本（SDK ADR 0055）；合法回 null */
export function checkCompatibilityDate(date: string): DeployIssue | null {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  return {
    path: 'compatibilityDate',
    code: 'invalid-date',
    severity: 'error',
    message: { 'zh-TW': `compatibilityDate 必須是 YYYY-MM-DD，收到 ${String(date)}`, en: `compatibilityDate must be YYYY-MM-DD, got ${String(date)}` },
  };
}

/** 兩份車道名單是否相同（順序、大小寫、空白不計；與中繼的 `knownLanes` 同一個正規化）。 */
export function sameLaneList(a: string | undefined, b: string | undefined): boolean {
  const norm = (raw: string | undefined) => [...knownLanes(raw)].sort().join(',');
  return norm(a) === norm(b);
}

/** 健康檢查只需要這麼多；全域 `fetch` 與外掛的轉接器都相容。 */
export type HealthFetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 打 `/healthz` 直到回 `ok`：新部署要幾秒才上線，所以重試。
 * 全部失敗就丟例外——絕不能在沒驗到的情況下回報成功。
 */
export async function waitForHealthy(
  httpUrl: string,
  opts: { fetch?: HealthFetch; retries?: number; delayMs?: number } = {},
): Promise<void> {
  const doFetch: HealthFetch = opts.fetch ?? ((url) => fetch(url));
  const retries = opts.retries ?? 10;
  const delay = opts.delayMs ?? 3_000;
  let last = '沒有回應';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await doFetch(`${httpUrl}/healthz`);
      const body = (await response.text()).trim();
      if (response.status >= 200 && response.status < 300 && body === 'ok') return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) await sleep(delay);
  }
  throw new Error(`部署完成但健康檢查沒過：${httpUrl}/healthz 重試 ${retries} 次，最後一次是 ${last}`);
}
