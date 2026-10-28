// 部署選項的描述表 `DEPLOY_OPTION_SPECS`（SDK ADR 0050 §3）：每個欄位寫一次——型別、範圍、預設、適用宿主與目標、
// 是否秘密、`relay deploy` 的旗標、中繼的環境變數、中英說明、精靈題組。JSON Schema、設定檔驗證的型別檢查、
// 部署說明都從這裡推出；CLI 旗標與 USAGE 由測試比對它（tests/deploy/deploy-config.test.ts）。
// 範圍一律引用 `RELAY_SITE_LIMITS`，不另抄一份。
import { DEFAULT_COMPATIBILITY_DATE, DEFAULT_WORKER_NAME, RELAY_NAME_PATTERN, RELAY_SITE_LIMITS, type RelaySiteOptions } from '../shared.js';
import { LANE_ID_PATTERN } from '../../relay/shard.js';
import { PRD_MAX_CONNECTIONS_PER_PUBKEY, PRD_MAX_MESSAGES_PER_SECOND_PER_IP } from '../../relay/host-config.js';
import { DEFAULT_CLOUDFLARED_IMAGE, DEFAULT_DOCKER_PORT, DEFAULT_FLY_REGION } from '../render.js';
import { type DeployConfig, DEPLOY_SERVICES, type DeployService, type DeployTarget, type RelayHost } from './types.js';

/** 值的型別（決定驗證、JSON Schema 與表單元件） */
export type DeployOptionType =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'string-list'
  | 'pubkey'
  | 'pubkey-list'
  | 'https-url'
  | 'secret-ref'
  | 'string-or-secret-ref'
  | 'record';

/** 精靈的題組（P1 `cinderous init` 依它分組；只有 `basic`、`access`、`vault` 會在不進「進階」時詢問） */
export type DeployOptionGroup = 'basic' | 'access' | 'vault' | 'nip11' | 'limits' | 'lanes' | 'capacity' | 'host' | 'secrets' | 'push';

export interface DeployOptionSpec {
  /** 在設定檔裡的路徑，例如 `site.maxTtlDays` */
  path: string;
  type: DeployOptionType;
  enum?: readonly string[];
  range?: { readonly min: number; readonly max: number };
  maxLength?: number;
  maxItems?: number;
  /** 字串（或清單每一項）要符合的正規表示式 */
  pattern?: RegExp;
  default?: string | number | boolean;
  /** 只有這些宿主支援（站台參數）；沒給＝兩種都支援 */
  hosts?: readonly RelayHost[];
  /** 只有這些目標用得到；沒給＝全部 */
  targets?: readonly DeployTarget[];
  /** 只有這些服務用得到（`relay`、`push-gateway`）；沒給＝兩種都用 */
  services?: readonly DeployService[];
  /** 某些目標必填 */
  requiredFor?: readonly DeployTarget[];
  /** 秘密：設定檔只能放 `{ "$env": "NAME" }` */
  secret?: boolean;
  /** 秘密沒給時讀的環境變數 */
  defaultEnv?: string;
  /** `cinderous relay deploy` 對應的旗標（不含 `--`）；沒有＝只能寫在設定檔 */
  flag?: string;
  /** 中繼讀的環境變數 */
  env?: string;
  group: DeployOptionGroup;
  /** 危險選項：P1 精靈要打字確認；說明裡列進安全檢查清單 */
  dangerous?: boolean;
  /** `record` 型別的 JSON Schema（其他型別由描述自動推出） */
  schema?: Readonly<Record<string, unknown>>;
  description: { readonly 'zh-TW': string; readonly en: string };
}

const limits = RELAY_SITE_LIMITS;
const CONTAINER_TARGETS: readonly DeployTarget[] = ['docker', 'fly', 'home-tunnel'];
const WORKER_TARGETS: readonly DeployTarget[] = ['cloudflare', 'cloudflare-api'];

const intRecord = (range: { min: number; max: number }) => ({
  type: 'object',
  additionalProperties: { type: 'integer', minimum: range.min, maximum: range.max },
});

/**
 * 站台參數：鍵必須與 {@link RelaySiteOptions} **完全相同**（型別在編譯期保證：少一個、多一個都編不過）。
 */
const SITE_OPTION_SPECS: { readonly [K in keyof Required<RelaySiteOptions>]: Omit<DeployOptionSpec, 'path'> } = {
  allowedPubkeys: {
    type: 'pubkey-list',
    flag: 'allowed-pubkeys',
    env: 'ALLOWED_PUBKEYS',
    group: 'access',
    description: {
      'zh-TW': '白名單：只有這些公鑰（npub 或 64 字元 hex）能寫入。沒給＝開放中繼，任何人都能用你的額度。寫錯任何一筆就拒絕部署。',
      en: 'Allowlist: only these public keys (npub or 64-character hex) may write. Empty means an open relay that anyone can use on your quota. Any malformed entry stops the deployment.',
    },
  },
  privateLane: {
    type: 'secret-ref',
    env: 'LANES_ONLY',
    group: 'access',
    description: {
      'zh-TW':
        '私人路徑（SDK ADR 0051）：開放寫入＋不可猜的隨機路徑。值是至少 26 字的隨機車道 id（例如 `openssl rand -hex 16`），只能寫 { "$env": "NAME" }。中繼設 APP_LANES＝它、LANES_ONLY=1（Cloudflare 開檔案時 FILE_LANES＝它），只接受 wss://<host>/app/<id>；白名單變成選用。🔴 這個網址等同密碼，外洩就換一個重新部署。',
      en: 'Private path (SDK ADR 0051): open writes behind an unguessable random path. The value is a random lane id of at least 26 characters (e.g. `openssl rand -hex 16`), written only as { "$env": "NAME" }. The relay gets APP_LANES = it and LANES_ONLY=1 (plus FILE_LANES = it on Cloudflare with files on) and accepts only wss://<host>/app/<id>; the allowlist becomes optional. 🔴 The URL is a password: if it leaks, deploy again with a new one.',
    },
  },
  readOnlyLanes: {
    type: 'secret-ref',
    env: 'READONLY_LANES',
    group: 'access',
    description: {
      'zh-TW':
        '唯讀寬限期（SDK ADR 0052）：換了私人路徑之後，舊路徑到期前只能讀（其他裝置從那裡收到搬家通知），到期後與認不得的路徑相同。值是 `<舊車道 id>@<到期 unix 秒>`（逗號分隔、最多 8 條、最長 30 天），只能寫 { "$env": "NAME" }（舊的 id 也是秘密）。過期的項目自動略過；一鍵部署（REST）的「換新路徑」會自動算出並保留線上還沒到期的。',
      en: 'Read-only grace period (SDK ADR 0052): after the private path changes, the old path stays readable (other devices pick up the move notice there) but rejects writes until it expires, then behaves like an unknown path. The value is `<old lane id>@<expiry unix seconds>` (comma-separated, at most 8, at most 30 days), written only as { "$env": "NAME" } (the old id is a secret too). Expired entries are skipped; the one-click (REST) “new private path” computes it and keeps the live ones that have not expired.',
    },
  },
  relayName: {
    type: 'string',
    maxLength: limits.relayName,
    flag: 'relay-name',
    env: 'RELAY_NAME',
    group: 'nip11',
    description: { 'zh-TW': 'NIP-11 站名。沒給用 SDK 的中立名稱。', en: 'NIP-11 relay name. Defaults to the SDK\'s neutral name.' },
  },
  relayDescription: {
    type: 'string',
    maxLength: limits.relayDescription,
    flag: 'relay-description',
    env: 'RELAY_DESCRIPTION',
    group: 'nip11',
    description: { 'zh-TW': 'NIP-11 描述。', en: 'NIP-11 description.' },
  },
  relayContact: {
    type: 'string',
    maxLength: limits.relayContact,
    flag: 'relay-contact',
    env: 'RELAY_CONTACT',
    group: 'nip11',
    description: { 'zh-TW': 'NIP-11 聯絡方式（mailto:、網址或 Nostr）。', en: 'NIP-11 contact (mailto:, a URL or Nostr).' },
  },
  relayPubkey: {
    type: 'pubkey',
    env: 'RELAY_PUBKEY',
    group: 'nip11',
    description: { 'zh-TW': 'NIP-11 營運者公鑰（npub 或 hex，寫入 hex）。', en: 'NIP-11 operator public key (npub or hex; stored as hex).' },
  },
  donations: {
    type: 'record',
    env: 'DONATE_*',
    group: 'nip11',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        ['githubSponsors', 'buyMeACoffee', 'liberapay', 'lightning'].map((key) => [key, { type: 'string', maxLength: limits.donation }]),
      ),
    },
    description: {
      'zh-TW': '贊助管道（githubSponsors、buyMeACoffee、liberapay、lightning；每項 ≤ 200 字）。全部沒給＝不顯示贊助入口。',
      en: 'Donation links (githubSponsors, buyMeACoffee, liberapay, lightning; ≤ 200 characters each). None means no donation card.',
    },
  },
  relaySoftwareUrl: {
    type: 'https-url',
    maxLength: limits.relaySoftwareUrl,
    flag: 'relay-software-url',
    env: 'RELAY_SOFTWARE_URL',
    group: 'nip11',
    description: {
      'zh-TW': 'NIP-11 software：這座站跑的程式的原始碼網址（https）。沒給＝SDK 的 repo。改過中繼程式再對外服務的人，依 AGPL §13 要指向修改後的原始碼。',
      en: 'NIP-11 software: the source code URL of the program this relay runs (https). Defaults to the SDK repository. If you modified the relay and offer it to others, AGPL §13 requires pointing this at your modified source.',
    },
  },
  maxTtlDays: {
    type: 'integer',
    range: limits.maxTtlDays,
    default: 7,
    flag: 'max-ttl-days',
    env: 'MAX_TTL_DAYS',
    group: 'limits',
    description: { 'zh-TW': '離線留言保存上限（天）。', en: 'Offline message retention cap (days).' },
  },
  maxConnectionsPerPubkey: {
    type: 'integer',
    range: limits.maxConnectionsPerPubkey,
    default: PRD_MAX_CONNECTIONS_PER_PUBKEY,
    flag: 'max-connections-per-pubkey',
    env: 'MAX_CONNECTIONS_PER_PUBKEY',
    group: 'limits',
    description: { 'zh-TW': '同一把公鑰最多幾條連線。', en: 'Maximum connections per public key.' },
  },
  maxMessagesPerSecondPerIp: {
    type: 'integer',
    range: limits.maxMessagesPerSecondPerIp,
    default: PRD_MAX_MESSAGES_PER_SECOND_PER_IP,
    flag: 'max-messages-per-second-per-ip',
    env: 'MAX_MESSAGES_PER_SECOND_PER_IP',
    group: 'limits',
    description: {
      'zh-TW': '同一個 IP 每秒最多幾則訊息；超過就斷線。一次推很多事件的客戶端要自己節流。',
      en: 'Maximum messages per second per IP; the connection is closed beyond that. Clients that push many events at once must throttle.',
    },
  },
  maxFileMb: {
    type: 'integer',
    range: limits.maxFileMb,
    flag: 'max-file-mb',
    env: 'MAX_FILE_MB',
    group: 'vault',
    description: {
      'zh-TW': '接受檔案塊（kind 1060）：Vault 同步必須開，建議 17。沒有 fileLanes 時是全站開關。開放中繼另外要 openFileRelay。',
      en: 'Accept file chunks (kind 1060): required for vault sync, 17 recommended. Without fileLanes it is a site-wide switch. An open relay additionally needs openFileRelay.',
    },
  },
  openFileRelay: {
    type: 'boolean',
    flag: 'open-file-relay',
    group: 'vault',
    dangerous: true,
    description: {
      'zh-TW': '沒有白名單也接受檔案塊（不建議：任何人都能存資料進來，儲存沒有上限）。',
      en: 'Accept file chunks without an allowlist (not recommended: anyone can store data, with no storage limit).',
    },
  },
  appLanes: {
    type: 'string-list',
    pattern: LANE_ID_PATTERN,
    maxItems: limits.maxAppLanes,
    hosts: ['worker'],
    flag: 'app-lanes',
    env: 'APP_LANES',
    group: 'lanes',
    dangerous: true,
    description: {
      'zh-TW': '已知租戶車道（例如 dochost）：每條一顆 DO。🔴 改名單＝那條車道換一顆 DO，舊資料不會搬過去、回滾也拿不回來。',
      en: 'Known app lanes (e.g. dochost): one Durable Object each. 🔴 Changing the list moves a lane to a new DO; old data is not moved and a rollback does not bring it back.',
    },
  },
  fileLanes: {
    type: 'string-list',
    pattern: LANE_ID_PATTERN,
    hosts: ['worker'],
    flag: 'file-lanes',
    env: 'FILE_LANES',
    group: 'lanes',
    description: {
      'zh-TW': '只在這些車道收檔案塊（須在 appLanes 上，並給 maxFileMb；這時 maxFileMb 是單檔上限）。',
      en: 'Accept file chunks only on these lanes (must be in appLanes and needs maxFileMb, which then becomes the per-file limit).',
    },
  },
  appLanePow: {
    type: 'integer',
    range: limits.appLanePow,
    default: 0,
    hosts: ['worker'],
    flag: 'app-lane-pow',
    env: 'APP_LANE_POW',
    group: 'lanes',
    dangerous: true,
    description: {
      'zh-TW': '車道的 NIP-13 PoW 最低難度（0＝不要求）。🔴 開之前確認車道的客戶端會挖礦，否則持久化事件全被拒。',
      en: 'Minimum NIP-13 PoW difficulty on lanes (0 = none). 🔴 Make sure the lane\'s clients mine first, or all their persistent events are rejected.',
    },
  },
  developerDocsUrl: {
    type: 'https-url',
    maxLength: limits.developerDocsUrl,
    hosts: ['worker'],
    flag: 'developer-docs-url',
    env: 'DEVELOPER_DOCS_URL',
    group: 'nip11',
    description: { 'zh-TW': '連線被拒時附上的開發文件網址（https）。', en: 'Developer docs URL included when a connection is refused (https).' },
  },
  doCeilings: {
    type: 'record',
    env: 'DO_CEILINGS_MIB',
    group: 'capacity',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['offlineMib', 'addressableMib'],
        properties: {
          // 結構描述給兩種宿主共用，取較寬的 Node 上限；Cloudflare 版的 8192 由驗證規則守（SDK ADR 0099）
          offlineMib: { type: 'integer', minimum: limits.nodeCeilingMib.min, maximum: limits.nodeCeilingMib.max },
          addressableMib: { type: 'integer', minimum: limits.nodeCeilingMib.min, maximum: limits.nodeCeilingMib.max },
        },
      },
    },
    description: {
      'zh-TW':
        '每顆 DO 的容量天花板（MiB）：鍵是 strict／public／lane／file 或單顆 DO 名。帳號總量＝天花板 × DO 數，用 storageBudgetBytes 守。' +
        'Cloudflare 版每項 1–8192；Node 主機只認 strict，1–1048576（1 TiB）。',
      en:
        'Per-DO capacity ceilings (MiB), keyed by strict / public / lane / file or a single DO name. Account total = ceiling × number of DOs; guard it with storageBudgetBytes. ' +
        'Cloudflare: 1–8192 each; Node host: strict only, 1–1048576 (1 TiB).',
    },
  },
  doGuaranteeKib: {
    type: 'record',
    env: 'DO_GUARANTEE_KIB',
    group: 'capacity',
    schema: intRecord(limits.doGuaranteeKib),
    description: { 'zh-TW': '共用 DO 內每位作者／收件人的保底（KiB）。只能設在淘汰制的對象。', en: 'Guaranteed share per author / recipient in shared DOs (KiB). Evicting classes only.' },
  },
  doBorrowPercent: {
    type: 'record',
    env: 'DO_BORROW_PERCENT',
    group: 'capacity',
    schema: intRecord(limits.doBorrowPercent),
    description: { 'zh-TW': '溢位帶（天花板之上借用的百分比）；淘汰制要同時設保底。', en: 'Overflow band (percent borrowed above the ceiling); evicting classes also need a guarantee.' },
  },
  doNearFullPercent: {
    type: 'record',
    env: 'DO_NEAR_FULL_PERCENT',
    group: 'capacity',
    schema: intRecord(limits.doNearFullPercent),
    description: { 'zh-TW': '粗分級預警的門檻（%）。', en: 'Coarse near-full warning threshold (%).' },
  },
  doDropNotices: {
    type: 'string-list',
    env: 'DO_DROP_NOTICES',
    group: 'capacity',
    description: { 'zh-TW': '開啟丟棄計數的對象。', en: 'Targets with dropped-message counts enabled.' },
  },
  maxConnections: {
    type: 'integer',
    range: limits.maxConnections,
    hosts: ['node'],
    env: 'MAX_CONNECTIONS',
    group: 'limits',
    description: { 'zh-TW': '全站最多幾條同時連線；沒設＝不限。只有 Node 主機。', en: 'Maximum simultaneous connections for the whole relay; unset = unlimited. Node host only.' },
  },
  maxConnectionsPerIp: {
    type: 'integer',
    range: limits.maxConnectionsPerIp,
    hosts: ['node'],
    env: 'MAX_CONNECTIONS_PER_IP',
    group: 'limits',
    description: {
      'zh-TW': '同一個 IP 最多幾條同時連線；沒設＝不限（手機電信與公司網路常共用 IP）。只有 Node 主機。',
      en: 'Maximum simultaneous connections per IP; unset = unlimited (mobile carriers and offices often share an IP). Node host only.',
    },
  },
  monthlyTrafficGib: {
    type: 'integer',
    range: limits.monthlyTrafficGib,
    hosts: ['node'],
    env: 'MONTHLY_TRAFFIC_GIB',
    group: 'limits',
    description: {
      'zh-TW': '每月流量預算（GiB）；用完暫停服務到重置日。只算 WebSocket 資料量，建議設成 VPS 方案的九成。只有 Node 主機。',
      en: 'Monthly traffic budget (GiB); service pauses until the reset day once used up. Counts WebSocket data only, so set about 90% of your VPS plan. Node host only.',
    },
  },
  trafficResetDay: {
    type: 'integer',
    range: limits.trafficResetDay,
    hosts: ['node'],
    env: 'TRAFFIC_RESET_DAY',
    group: 'limits',
    description: { 'zh-TW': '每月幾號 00:00 UTC 歸零（1–28，預設 1）。', en: 'Day of month the budget resets at 00:00 UTC (1–28, default 1).' },
  },
  trafficCount: {
    type: 'enum',
    enum: ['total', 'out'],
    hosts: ['node'],
    env: 'TRAFFIC_COUNT',
    group: 'limits',
    description: { 'zh-TW': '流量怎麼算：total（預設，進出合計）或 out（只算出去的）。', en: 'What counts: total (default, both directions) or out (outbound only).' },
  },
  trafficNearFullPercent: {
    type: 'integer',
    range: limits.trafficNearFullPercent,
    hosts: ['node'],
    env: 'TRAFFIC_NEAR_FULL_PERCENT',
    group: 'limits',
    description: { 'zh-TW': '用到幾 % 開始在 OK 帶預警（50–99）。', en: 'Percent of the budget at which OK messages start carrying a warning (50–99).' },
  },
  ceilingMode: {
    type: 'enum',
    enum: ['reject', 'evict'],
    hosts: ['node'],
    env: 'CEILING_MODE',
    group: 'capacity',
    description: {
      'zh-TW': '滿了之後：reject（預設，拒收）或 evict（淘汰最快到期的）。只有 Node 主機。',
      en: 'When full: reject (default) or evict (drop what expires soonest). Node host only.',
    },
  },
  storageBudgetBytes: {
    type: 'integer',
    range: { min: 1, max: Number.MAX_SAFE_INTEGER },
    hosts: ['worker'],
    group: 'capacity',
    description: {
      'zh-TW': '帳號儲存預算（位元組）：所有可能 DO 的最壞加總超過就拒絕部署。免費方案建議 4,000,000,000（5 GB 的 80%）。',
      en: 'Account storage budget (bytes): deployment is refused if the worst case across all possible DOs exceeds it. Free plan: 4,000,000,000 (80% of 5 GB) recommended.',
    },
  },
};

const TOP_LEVEL_SPECS: readonly DeployOptionSpec[] = [
  {
    path: 'configVersion',
    type: 'integer',
    range: { min: 1, max: 1 },
    group: 'basic',
    description: { 'zh-TW': '設定檔格式的版號（目前是 1）。', en: 'Config file format version (currently 1).' },
  },
  {
    path: 'sdk',
    type: 'string',
    maxLength: 64,
    group: 'basic',
    description: { 'zh-TW': '產生這份設定的 SDK 版號（relay build 會寫入）。', en: 'SDK version that produced this config (written by relay build).' },
  },
  {
    path: 'target',
    type: 'enum',
    enum: ['cloudflare', 'cloudflare-api', 'docker', 'fly', 'home-tunnel'],
    flag: 'provider',
    group: 'basic',
    description: {
      'zh-TW': '部署目標：cloudflare（wrangler）、cloudflare-api（REST，外掛用）、docker、fly、home-tunnel（家中主機＋Cloudflare Tunnel）。',
      en: 'Deployment target: cloudflare (wrangler), cloudflare-api (REST, for plugins), docker, fly, home-tunnel (home server + Cloudflare Tunnel).',
    },
  },
  {
    path: 'service',
    type: 'enum',
    enum: DEPLOY_SERVICES,
    default: 'relay',
    group: 'basic',
    description: {
      'zh-TW': '部署哪個服務：relay（Cinderous 中繼，預設）或 push-gateway（App 開發者的參考推播閘道；Workers 目標＝Workers 版，docker／fly／home-tunnel＝Node 版；兩版的 iOS 都能直連 APNs）。',
      en: 'Which service to deploy: relay (the Cinderous relay, default) or push-gateway (the app developer\'s reference push gateway; Workers targets = Workers edition, docker / fly / home-tunnel = Node edition; both can reach APNs directly for iOS).',
    },
  },
  {
    path: 'name',
    type: 'string',
    pattern: RELAY_NAME_PATTERN,
    default: DEFAULT_WORKER_NAME,
    flag: 'name',
    group: 'basic',
    description: {
      'zh-TW': 'Worker／容器／Fly app 名稱：小寫英數與連字號、不以連字號開頭、最長 63 字。',
      en: 'Worker / container / Fly app name: lowercase letters, digits and hyphens, not starting with a hyphen, at most 63 characters.',
    },
  },
  {
    path: 'node.persist',
    type: 'boolean',
    services: ['relay'],
    default: false,
    targets: CONTAINER_TARGETS,
    flag: 'persist',
    group: 'host',
    description: { 'zh-TW': '以 SQLite 保存離線留言（掛 volume）；預設純記憶體，重啟即清空。', en: 'Keep offline messages in SQLite on a volume; default is memory-only (cleared on restart).' },
  },
  {
    path: 'node.port',
    type: 'integer',
    range: { min: 1, max: 65_535 },
    default: DEFAULT_DOCKER_PORT,
    targets: ['docker'],
    flag: 'port',
    group: 'host',
    description: { 'zh-TW': 'docker：對外的埠。', en: 'docker: host port.' },
  },
  {
    path: 'node.trustProxy',
    type: 'boolean',
    services: ['relay'],
    default: false,
    targets: CONTAINER_TARGETS,
    dangerous: true,
    group: 'host',
    description: {
      'zh-TW': '信任前面代理的 X-Forwarded-For（TRUST_PROXY=1）。docker 只有在反向代理後方才開；fly 與 home-tunnel 一定開。',
      en: 'Trust X-Forwarded-For from a proxy in front (TRUST_PROXY=1). For docker only behind a reverse proxy; always on for fly and home-tunnel.',
    },
  },
  {
    path: 'cloudflare.accountId',
    type: 'string-or-secret-ref',
    pattern: /^[0-9a-f]{32}$/,
    targets: WORKER_TARGETS,
    flag: 'account-id',
    defaultEnv: 'CLOUDFLARE_ACCOUNT_ID',
    group: 'host',
    description: {
      'zh-TW': 'Cloudflare Account ID（32 字元 hex；不是秘密）。有多個帳號時務必給：wrangler 會沿用上次登入的帳號。',
      en: 'Cloudflare Account ID (32 hex characters; not a secret). Set it when you have several accounts: wrangler reuses the last one you logged into.',
    },
  },
  {
    path: 'cloudflare.compatibilityDate',
    type: 'string',
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    default: DEFAULT_COMPATIBILITY_DATE,
    targets: WORKER_TARGETS,
    flag: 'compatibility-date',
    group: 'host',
    description: {
      'zh-TW': 'Workers 的 compatibility_date（YYYY-MM-DD）。記在設定檔裡，不隨 CLI 升級改變。',
      en: 'Workers compatibility_date (YYYY-MM-DD). Recorded in the config so it does not change with CLI upgrades.',
    },
  },
  {
    path: 'cloudflare.workersDevSubdomain',
    type: 'string',
    pattern: /^[a-z0-9][a-z0-9-]{0,62}$/,
    targets: WORKER_TARGETS,
    group: 'host',
    description: {
      'zh-TW': 'workers.dev 子網域（帳號的那一段）。REST 路徑在帳號還沒有子網域時用它註冊；部署說明用它寫出完整網址。',
      en: 'workers.dev subdomain (the account part). The REST path registers it when the account has none; the deploy guide uses it to spell out the full URL.',
    },
  },
  {
    path: 'fly.region',
    type: 'string',
    pattern: /^[a-z]{3}$/,
    default: DEFAULT_FLY_REGION,
    targets: ['fly'],
    flag: 'region',
    group: 'host',
    description: { 'zh-TW': 'Fly 區域代碼（例如 nrt、sin、iad）。', en: 'Fly region code (e.g. nrt, sin, iad).' },
  },
  {
    path: 'tunnel.hostname',
    type: 'string',
    pattern: /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    targets: ['home-tunnel'],
    requiredFor: ['home-tunnel'],
    group: 'host',
    description: {
      'zh-TW': '對外的主機名稱（例如 relay.example.com，要在你放到 Cloudflare 的網域下）。客戶端連 wss://<這個名稱>。',
      en: 'Public hostname (e.g. relay.example.com, under a domain on Cloudflare). Clients connect to wss://<this name>.',
    },
  },
  {
    path: 'tunnel.cloudflaredImage',
    type: 'string',
    pattern: /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/,
    default: DEFAULT_CLOUDFLARED_IMAGE,
    targets: ['home-tunnel'],
    group: 'host',
    description: {
      'zh-TW': 'cloudflared 映像。要可重現就釘版本或 digest（例如 cloudflare/cloudflared:2026.9.0）。',
      en: 'cloudflared image. Pin a version or digest for reproducible deployments (e.g. cloudflare/cloudflared:2026.9.0).',
    },
  },
  {
    path: 'secrets.cloudflareApiToken',
    type: 'secret-ref',
    secret: true,
    defaultEnv: 'CLOUDFLARE_API_TOKEN',
    targets: WORKER_TARGETS,
    flag: 'api-token',
    group: 'secrets',
    description: {
      'zh-TW': 'Cloudflare API Token 的環境變數名稱。沒給讀 CLOUDFLARE_API_TOKEN；都沒有就交給 wrangler 自己的登入（wrangler login）。',
      en: 'Environment variable holding the Cloudflare API token. Defaults to CLOUDFLARE_API_TOKEN; without one, wrangler\'s own login (wrangler login) is used.',
    },
  },
  {
    path: 'secrets.flyApiToken',
    type: 'secret-ref',
    secret: true,
    defaultEnv: 'FLY_API_TOKEN',
    targets: ['fly'],
    flag: 'api-token',
    group: 'secrets',
    description: {
      'zh-TW': 'Fly API Token 的環境變數名稱。沒給讀 FLY_API_TOKEN；都沒有就交給 flyctl 自己的登入（fly auth login）。',
      en: 'Environment variable holding the Fly API token. Defaults to FLY_API_TOKEN; without one, flyctl\'s own login (fly auth login) is used.',
    },
  },
  {
    path: 'secrets.tunnelToken',
    type: 'secret-ref',
    secret: true,
    defaultEnv: 'TUNNEL_TOKEN',
    targets: ['home-tunnel'],
    requiredFor: ['home-tunnel'],
    group: 'secrets',
    description: {
      'zh-TW': 'Cloudflare Tunnel Token 的環境變數名稱（cloudflared 用；寫在部署包的 .env，不要提交）。',
      en: 'Environment variable holding the Cloudflare Tunnel token (used by cloudflared; put it in the package\'s .env and never commit it).',
    },
  },
];

/**
 * 推播閘道的上限（ADR 0049 §11.1 裁示 7）：與 `@cinderous/client/iot` 的 `IOT_PUSH_LIMITS` 相同的數字
 *（這個模組不能引用 `./iot`——部署設定器不帶進 IoT 程式；測試比對兩者一致）。
 */
export const PUSH_GATEWAY_LIMIT_SPECS = {
  tokenPerHour: { min: 1, max: 3_600, default: 60 },
  tokenPerMinute: { min: 1, max: 60, default: 6 },
  maxSkewSec: { min: 30, max: 3_600, default: 300 },
  maxRegistrationDays: { min: 1, max: 30, default: 30 },
} as const;

/**
 * `pushGateway.ios` 沒寫時的值（SDK ADR 0062：v0.48.0 起是直連 APNs）。部署設定器不引用 `./iot`，
 * 由測試比對執行期的 `DEFAULT_PUSH_GATEWAY_IOS_MODE`。
 */
export const DEFAULT_PUSH_GATEWAY_IOS = 'apns' as const;

const PUSH: readonly DeployService[] = ['push-gateway'];
const limitRange = (key: keyof typeof PUSH_GATEWAY_LIMIT_SPECS) => ({ min: PUSH_GATEWAY_LIMIT_SPECS[key].min, max: PUSH_GATEWAY_LIMIT_SPECS[key].max });

/** 推播閘道（`service: 'push-gateway'`）的選項與執行期秘密 */
const PUSH_GATEWAY_SPECS: readonly DeployOptionSpec[] = [
  {
    path: 'pushGateway.android',
    type: 'boolean',
    default: true,
    services: PUSH,
    env: 'PUSH_ANDROID',
    group: 'push',
    description: {
      'zh-TW': 'Android：經 FCM 送高優先的空資料訊息（需要 Firebase 服務帳號）。關掉時 Android App 請改用 UnifiedPush（不需要推播閘道）。',
      en: 'Android: high-priority empty data messages via FCM (needs a Firebase service account). When off, Android apps should use UnifiedPush instead (no push gateway needed).',
    },
  },
  {
    path: 'pushGateway.ios',
    type: 'enum',
    enum: ['apns', 'fcm', 'off'],
    default: DEFAULT_PUSH_GATEWAY_IOS,
    services: PUSH,
    env: 'PUSH_IOS',
    group: 'push',
    description: {
      'zh-TW': 'iOS：apns＝直連 APNs（預設，v0.48.0 起；Workers 版與 Node 版都可以，不經 Google，要 APNs 金鑰）；fcm＝經 Firebase 轉給 APNs（已棄用：Google 也看得到 iOS 喚醒的時間點）；off＝不支援 iOS（只要 Android 時用它，不需要 Apple 金鑰）。',
      en: 'iOS: apns = talk to APNs directly (the default since v0.48.0; both the Workers and Node editions, no Google, needs an APNs key); fcm = through Firebase to APNs (deprecated: Google also sees when iOS devices are woken); off = no iOS (use it for Android-only deployments; no Apple key needed).',
    },
  },
  {
    path: 'pushGateway.iosLocKey',
    type: 'string',
    pattern: /^[A-Z][A-Z0-9_]{0,63}$/,
    default: 'CINDER_WAKE',
    services: PUSH,
    env: 'PUSH_IOS_LOC_KEY',
    group: 'push',
    description: {
      'zh-TW': 'iOS 通知的在地化鍵（大寫英數與底線）：推播裡沒有任何文字，App 的 Localizable.strings 提供「有新動態」之類的通用字樣；NSE 解密後改寫。',
      en: 'Localization key for the iOS alert (uppercase letters, digits, underscores): the push carries no text; the app\'s Localizable.strings supplies a generic phrase, which the NSE rewrites after decrypting.',
    },
  },
  {
    path: 'pushGateway.apnsTopic',
    type: 'string',
    pattern: /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
    services: PUSH,
    env: 'APNS_TOPIC',
    group: 'push',
    description: { 'zh-TW': '直連 APNs：App 的 bundle id（apns-topic）。', en: 'Direct APNs: the app\'s bundle id (apns-topic).' },
  },
  {
    path: 'pushGateway.apnsKeyId',
    type: 'string',
    pattern: /^[A-Z0-9]{10}$/,
    services: PUSH,
    env: 'APNS_KEY_ID',
    group: 'push',
    description: { 'zh-TW': '直連 APNs：.p8 金鑰的 Key ID（10 字元；不是秘密）。', en: 'Direct APNs: the Key ID of the .p8 key (10 characters; not a secret).' },
  },
  {
    path: 'pushGateway.apnsTeamId',
    type: 'string',
    pattern: /^[A-Z0-9]{10}$/,
    services: PUSH,
    env: 'APNS_TEAM_ID',
    group: 'push',
    description: { 'zh-TW': '直連 APNs：Apple Developer 的 Team ID（10 字元）。', en: 'Direct APNs: the Apple Developer Team ID (10 characters).' },
  },
  {
    path: 'pushGateway.apnsEnvironment',
    type: 'enum',
    enum: ['production', 'sandbox'],
    default: 'production',
    services: PUSH,
    env: 'APNS_ENV',
    group: 'push',
    description: {
      'zh-TW': '直連 APNs：production（App Store／TestFlight）或 sandbox（Xcode 直接安裝的開發版）。',
      en: 'Direct APNs: production (App Store / TestFlight) or sandbox (development builds installed from Xcode).',
    },
  },
  {
    path: 'pushGateway.tokenPerHour',
    type: 'integer',
    range: limitRange('tokenPerHour'),
    default: PUSH_GATEWAY_LIMIT_SPECS.tokenPerHour.default,
    services: PUSH,
    env: 'PUSH_TOKEN_PER_HOUR',
    group: 'push',
    description: {
      'zh-TW': '每個推播 token 每小時最多送幾次（裁示 7，預設 60）。所有送出端（設備、IoT 閘道、中繼）合計。',
      en: 'Maximum wakes per push token per hour (ruling 7, default 60), across all senders (devices, IoT gateways, relays).',
    },
  },
  {
    path: 'pushGateway.tokenPerMinute',
    type: 'integer',
    range: limitRange('tokenPerMinute'),
    default: PUSH_GATEWAY_LIMIT_SPECS.tokenPerMinute.default,
    services: PUSH,
    env: 'PUSH_TOKEN_PER_MINUTE',
    group: 'push',
    description: {
      'zh-TW': '每個推播 token 每分鐘最多送幾次（預設 6＝即時模式的上限；縱深防禦，送出端本來就會合併與節流）。',
      en: 'Maximum wakes per push token per minute (default 6 = the instant-mode limit; defence in depth, senders already coalesce and throttle).',
    },
  },
  {
    path: 'pushGateway.maxSkewSec',
    type: 'integer',
    range: limitRange('maxSkewSec'),
    default: PUSH_GATEWAY_LIMIT_SPECS.maxSkewSec.default,
    services: PUSH,
    env: 'PUSH_MAX_SKEW_SEC',
    group: 'push',
    description: {
      'zh-TW': '喚醒請求的時間戳最多與推播閘道差幾秒（防重放的時間窗；設備要有 NTP）。',
      en: 'Maximum clock difference (seconds) between a wake request\'s timestamp and the gateway (the replay window; devices need NTP).',
    },
  },
  {
    path: 'pushGateway.maxRegistrationDays',
    type: 'integer',
    range: limitRange('maxRegistrationDays'),
    default: PUSH_GATEWAY_LIMIT_SPECS.maxRegistrationDays.default,
    services: PUSH,
    env: 'PUSH_MAX_REGISTRATION_DAYS',
    group: 'push',
    description: {
      'zh-TW': 'token 封包最長能活幾天（ADR-0272：30 天；App 啟動時續期）。超過的封包一律拒絕。',
      en: 'Maximum lifetime of a token envelope in days (ADR-0272: 30 days; apps renew on launch). Longer envelopes are refused.',
    },
  },
  {
    path: 'secrets.pushGatewayKey',
    type: 'secret-ref',
    secret: true,
    defaultEnv: 'PUSH_GATEWAY_KEY',
    services: PUSH,
    group: 'secrets',
    description: {
      'zh-TW': '推播閘道私鑰的環境變數名稱（cinderous iot push-keygen 產生）。換掉它＝所有 App 的 token 封包作廢，要重新登記。',
      en: 'Environment variable holding the push gateway\'s private key (generate with cinderous iot push-keygen). Rotating it invalidates every app\'s token envelope; apps must re-register.',
    },
  },
  {
    path: 'secrets.fcmServiceAccount',
    type: 'secret-ref',
    secret: true,
    defaultEnv: 'FCM_SERVICE_ACCOUNT',
    services: PUSH,
    group: 'secrets',
    description: {
      'zh-TW': 'Firebase 服務帳號 JSON 的環境變數名稱（整份 JSON 一行）。Android 或 iOS 經 FCM 時必填。',
      en: 'Environment variable holding the Firebase service account JSON (the whole JSON on one line). Required for Android or iOS via FCM.',
    },
  },
  {
    path: 'secrets.apnsKey',
    type: 'secret-ref',
    secret: true,
    defaultEnv: 'APNS_KEY',
    services: PUSH,
    group: 'secrets',
    description: {
      'zh-TW': 'APNs .p8 金鑰內容的環境變數名稱（換行寫成 \\n）。直連 APNs（pushGateway.ios=apns，Workers 版與 Node 版）時必填；Workers 版也可以把 .p8 檔直接導入 wrangler secret。',
      en: 'Environment variable holding the APNs .p8 key contents (newlines written as \\n). Required for direct APNs (pushGateway.ios=apns, Workers and Node editions); on Workers you can also pipe the .p8 file straight into wrangler secret.',
    },
  },
];

/** 所有設定欄位的描述表（SDK ADR 0050 §3）。站台參數在 `site.` 之下，順序與 {@link RelaySiteOptions} 的宣告相同。 */
export const DEPLOY_OPTION_SPECS: readonly DeployOptionSpec[] = Object.freeze([
  ...TOP_LEVEL_SPECS,
  ...PUSH_GATEWAY_SPECS,
  ...Object.entries(SITE_OPTION_SPECS).map(([key, spec]) => ({ path: `site.${key}`, services: ['relay'], ...spec }) as DeployOptionSpec),
]);

/** 站台參數的鍵（＝ `RelaySiteOptions` 的鍵；測試比對 `WORKER_ONLY_SITE_OPTIONS` 與描述表的 `hosts`）。 */
export const SITE_OPTION_KEYS = Object.freeze(Object.keys(SITE_OPTION_SPECS) as (keyof RelaySiteOptions)[]);

export function deployOptionSpec(path: string): DeployOptionSpec | undefined {
  return DEPLOY_OPTION_SPECS.find((spec) => spec.path === path);
}

/** 這個目標適用嗎（站台參數另看宿主） */
export function specAppliesTo(spec: DeployOptionSpec, target: DeployTarget, host: RelayHost): boolean {
  if (spec.targets && !spec.targets.includes(target)) return false;
  if (spec.hosts && !spec.hosts.includes(host)) return false;
  return true;
}

/**
 * 目標強制的值不算危險選擇：fly 與 home-tunnel 的連線一定經過代理，`node.trustProxy` 一定要開（`validateDeployConfig` 擋 false）。
 */
const FORCED_ON: Readonly<Record<string, readonly DeployTarget[]>> = { 'node.trustProxy': ['fly', 'home-tunnel'] };

function valueAt(config: unknown, path: string): unknown {
  let node: unknown = config;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** 這個值是不是「開了危險選項」：布林 true、數字大於預設、清單不是空的；目標強制的值不算 */
export function isDangerousValue(spec: DeployOptionSpec, value: unknown, target: DeployTarget): boolean {
  if (spec.dangerous !== true || value === undefined) return false;
  if (FORCED_ON[spec.path]?.includes(target) === true) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > (typeof spec.default === 'number' ? spec.default : 0);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 設定裡開了哪些危險選項（部署說明的安全檢查清單、精靈的確認都看它） */
export function dangerousChoices(config: DeployConfig): DeployOptionSpec[] {
  return DEPLOY_OPTION_SPECS.filter((spec) => isDangerousValue(spec, valueAt(config, spec.path), config.target));
}

/** 開危險選項要打的字：欄位名稱的最後一段（`site.openFileRelay` → `openFileRelay`） */
export function dangerConfirmWord(spec: DeployOptionSpec): string {
  return spec.path.slice(spec.path.lastIndexOf('.') + 1);
}
