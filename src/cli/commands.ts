// `cinderous` 命令列（PRD 5.2、5.3、5.4；SDK ADR 0008、0050）。
// 這個檔只解讀旗標、把工作交出去；起中繼、部署、讀寫檔都經由 `CliDeps`，測試換成替身。
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { BuildRelayPackageOptions, RelayPackageBuild } from '../deploy/build.js';
import type { CloudflareDeployment, CloudflareDeployOptions } from '../deploy/cloudflare.js';
import type { RelayDeployment } from '../deploy/common.js';
import {
  DEPLOY_TARGETS,
  type DeployConfig,
  type DeployGuideLocale,
  type DeployIssue,
  type DeploySiteOptions,
  renderDeployConfigFile,
  renderDeployConfigJsonSchema,
  runInitWizard,
  resolveSecret,
  resolveSiteSecrets,
  resolveStringOrSecret,
  secretEnvName,
  serviceOfConfig,
  siteWithPlaceholders,
  validateDeployConfig,
} from '../deploy/config/index.js';
import type { DockerDeployOptions, DockerTunnelOptions } from '../deploy/docker.js';
import type { FlyDeployOptions } from '../deploy/fly.js';
import type { RelaySiteOptions } from '../deploy/shared.js';
import {
  type ConsumptionSimulationInput,
  type CryptoMode,
  estimateResourceConsumption,
  formatEstimationReport,
  type TargetTier,
} from '../estimator.js';
import { Identity } from '../identity.js';
import { iotPubkeyOf, IOT_ROLES, type IotAcl, type IotAclEntryInput, type IotRole } from '../iot/acl.js';
import { resolveIotBridgeConfig, resolveIotClientConfig, type ResolvedIotBridgeConfig, type ResolvedIotClientConfig } from '../iot/bridge/config.js';
import type { IotCommandResult } from '../iot/client.js';
import type { IotGatewayLogEntry } from '../iot/gateway.js';
import { deriveIotHome, generateIotHomeSecret } from '../iot/keys.js';
import { npubEncode } from '../protocol/keys.js';
import { PRD_MAX_CONNECTIONS_PER_PUBKEY, PRD_MAX_MESSAGES_PER_SECOND_PER_IP } from '../relay/host-config.js';
import type { NodeRelayEnv, NodeRelayOptions } from '../relay/node-relay.js';

export interface CliDeps {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeRelayEnv;
  cwd: string;
  startNodeRelay: (env: NodeRelayEnv, options?: NodeRelayOptions) => { close(): void };
  deployCloudflareRelay: (options: CloudflareDeployOptions) => Promise<CloudflareDeployment>;
  deployDockerRelay: (options: DockerDeployOptions) => Promise<RelayDeployment>;
  deployFlyRelay: (options: FlyDeployOptions) => Promise<RelayDeployment>;
  writeFile: (path: string, content: string) => void;
  /** 讀文字檔；不存在回 undefined（`--config`、`.env`；SDK ADR 0050） */
  readFile?: (path: string) => string | undefined;
  /** `relay build`：把部署包寫到磁碟（SDK ADR 0050） */
  buildRelayPackage?: (options: BuildRelayPackageOptions) => Promise<RelayPackageBuild>;
  /** 執行中的 SDK 版號：與設定檔的 `sdk` 比對（ADR 0050 §6） */
  sdkVersion?: string;
  /** `init` 精靈：問一題、回傳輸入的一行（SDK ADR 0117）；沒有＝這個環境不能互動，只能用 --yes */
  prompt?: (question: string) => Promise<string>;
  /** `iot bridge`：啟動家中橋接器（SDK ADR 0049） */
  startIotBridge?: (
    config: ResolvedIotBridgeConfig,
    extra: { aclPath: string; pushPath?: string; onLog?: (entry: IotGatewayLogEntry) => void; onError?: (error: unknown) => void },
  ) => Promise<{ gatewayNpub: string; homeTag: string; close(): Promise<void> }>;
  /** `iot acl`：以成員（owner）身分連上 relay */
  connectIotClient?: (config: ResolvedIotClientConfig) => Promise<{ client: IotAclClient; close(): void }>;
  /** `iot build`：寫出橋接器的 Docker 建置內容，回傳寫了哪些檔 */
  prepareIotBridgeContext?: (opts: { workDir: string; configPath?: string }) => string[];
}

/** `iot acl` 用到的 `IotClient` 子集 */
export interface IotAclClient {
  updateAcl(op: { op: 'add'; entry: IotAclEntryInput } | { op: 'remove'; pubkey: string }): Promise<IotCommandResult>;
  getAcl(): Promise<IotAcl | undefined>;
}

export const USAGE = `用法：cinderous <指令> [選項]

  cinderous relay start    在這台機器起一座中繼（預設純記憶體）
      --port, -p <埠>             預設 8787（或環境變數 PORT）
      --persist                   改用 SQLite 保存離線留言，重啟不會清空
      --db-path <路徑>            搭配 --persist，預設 cinderous-relay.db
      --allowed-pubkeys, -k <名單> 只讓這些人寫入（逗號分隔的 npub 或 hex）
      --no-auth                   不要求 NIP-42 登入
      --name <站名>               NIP-11 顯示的站名
      --max-file-mb <MB>          接受檔案塊（kind 1060；全站開關）；Vault 同步必須開，建議 17（需要白名單）
      --open-file-relay           沒有白名單也接受檔案塊（不建議）

  cinderous relay deploy   部署一座中繼
      --config, -c <檔>           改用設定檔（cinderous.config.json，SDK ADR 0050）；只能再加 --output-env、--dry-run
      --provider, -p <廠商>       cloudflare（預設）、docker（這台機器）、fly（Fly.io）
      --name, -n <名稱>           Worker／容器／Fly app 名稱，預設 cinderous-relay
      --allowed-pubkeys, -k <名單> 白名單；沒給＝開放中繼
      --api-token, -t <token>     cloudflare 預設讀 CLOUDFLARE_API_TOKEN、fly 預設讀 FLY_API_TOKEN
      --account-id, -a <id>       cloudflare：預設讀 CLOUDFLARE_ACCOUNT_ID
      --compatibility-date <日期>  cloudflare：預設 2026-09-01
      --region, -r <區域>          fly：預設 nrt（東京）
      --port <埠>                 docker：對外的埠，預設 8080
      --persist                   docker／fly：以 SQLite 保存離線留言（掛 volume）
      --max-file-mb <MB>          接受檔案塊（kind 1060；全站開關）；Vault 同步必須開，建議 17（需要白名單）
      --open-file-relay           沒有白名單也接受檔案塊（不建議：儲存沒有上限）
      --relay-name <站名>          NIP-11 站名（最長 100 字）
      --relay-description <文字>   NIP-11 描述（最長 500 字）
      --relay-contact <聯絡方式>   NIP-11 聯絡方式（最長 200 字）
      --relay-software-url <網址>  NIP-11 software（https）：改過中繼程式時指向修改後的原始碼（AGPL §13）
      --max-ttl-days <天>          離線留言保存上限，1–365，預設 7
      --max-connections-per-pubkey <n>      同一把公鑰最多幾條連線，1–100，預設 5
      --max-messages-per-second-per-ip <n>  同一個 IP 每秒最多幾則，1–1000，預設 20
      --app-lanes <名單>           cloudflare：已知租戶車道（逗號分隔，例如 dochost）；改名單＝換 DO
      --file-lanes <名單>          cloudflare：只在這些車道收檔案塊（須在 --app-lanes 上，並給 --max-file-mb）
      --app-lane-pow <難度>        cloudflare：車道的 PoW 最低難度，0–32，預設 0
      --developer-docs-url <網址>  cloudflare：連線被拒時附上的開發文件網址（https）
      --output-env, -o <檔案>      端點寫到這個檔，預設 .env.cinderous
      --dry-run                   只產生設定（cloudflare 另外試打包），不部署
      --non-interactive, -y       不詢問（目前本來就不詢問，保留給腳本用）

  cinderous relay build    依設定檔產生可攜的部署包與部署說明（SDK ADR 0050）
      --config, -c <檔>           預設 cinderous.config.json
      --out, -o <目錄>            預設設定檔所在的資料夾
      --self-contained            Workers：附預打包的中繼（src/relay.mjs），不需要安裝 SDK
      --sdk-spec <相依>           SDK 改以套件相依安裝（例如 github:VaalRL/cinderous-sdk#v0.78.0），不內嵌 sdk/
      --force                     覆寫被手改過、或不是 relay build 產生的檔案

  cinderous init           逐題產生設定檔 cinderous.config.json（SDK ADR 0117）；危險選項要打字確認才會開
      --out, -o <檔>              預設 cinderous.config.json
      --provider, -p <目標>       cloudflare、cloudflare-api、docker、fly、home-tunnel；沒給就問
      --advanced                  也問進階題組（NIP-11、上限、車道、容量、宿主、秘密）
      --yes, -y                   不詢問、全部用預設值（要搭配 --provider；危險選項一律不開）
      --force                     覆寫已經存在的設定檔
      --locale <zh-TW|en>         題目與說明的語言，預設 zh-TW

  cinderous iot bridge     家中 IoT 橋接器：本地 MQTT broker ↔ relay，端到端加密（SDK ADR 0049；需要 npm install mqtt）
      --config, -c <檔>           預設 iot-bridge.json（秘密只寫 { "$env": "NAME" }；設定檔旁邊的 .env 會被讀）
      --acl-file <檔>             角色名單存檔（覆寫設定檔的 aclFile）
      --push-file <檔>            推播端點存檔（設定檔有 push 段時；覆寫 push.storeFile）
  cinderous iot acl list|add|remove   以 owner 身分管理閘道的角色名單（經 $sys/acl）
      --config, -c <檔>           預設 iot-client.json（relays、gateway、homeSecret、memberKey）
      add <npub> --role <viewer|operator|owner> [--devices a,b*] [--topics home/+/light/#] [--expires-at <Unix 秒>] [--label <名稱>]
      remove <npub>
  cinderous iot keygen     產生新的家庭秘密與閘道私鑰（只印這一次；放進 .env）
  cinderous iot push-keygen  產生推播閘道的私鑰 PUSH_GATEWAY_KEY（只印這一次）與公鑰（App 用它封 token；ADR 0049 §11.1）
  cinderous iot build      寫出橋接器的 Docker 建置內容（Dockerfile、compose.yaml、.env.example、sdk/）
      --out, -o <目錄>            預設 iot-bridge
      --config, -c <檔>           一併複製這份 iot-bridge.json

  cinderous config validate [檔]  驗證設定檔，一次列出所有問題（預設 cinderous.config.json）
  cinderous config schema          印出設定檔的 JSON Schema

  cinderous estimate       試算資源消耗與營運成本
      --mode <cinder-ek|double-ratchet>  預設 cinder-ek
      --pq[=true|false]           後量子混合加密，預設關
      --devices <n>               每人裝置數，預設 3
      --collaborators <n>         群組人數，預設 1
      --daily-actions <n>         每人每日動作數，預設 300
      --payload-kb <n>            每次動作的資料量（KB），預設 15
      --p2p-rate <0~1>            P2P 打洞成功率，預設 0.85
      --tier <tier-0-public|tier-1-selfhosted|tier-2-serverless>
      --json                      輸出 JSON`;

class UsageError extends Error {}

function positiveInt(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${flag} 要是正整數，收到「${raw}」`);
  return value;
}

function oneOf<T extends string>(flag: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new UsageError(`${flag} 只能是 ${allowed.join('、')}，收到「${raw}」`);
  return raw as T;
}

const splitList = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** `cinderous estimate` 的旗標 → 試算器輸入。壞值直接報錯，不默默換成預設。 */
export function parseEstimateArgs(argv: string[]): ConsumptionSimulationInput & { json: boolean } {
  // `--pq` 單獨出現視為開啟
  const normalized = argv.map((arg) => (arg === '--pq' ? '--pq=true' : arg));
  const { values } = parseArgs({
    args: normalized,
    strict: true,
    options: {
      mode: { type: 'string' },
      pq: { type: 'string' },
      devices: { type: 'string' },
      collaborators: { type: 'string' },
      'daily-actions': { type: 'string' },
      'payload-kb': { type: 'string' },
      'p2p-rate': { type: 'string' },
      tier: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const pq = oneOf('--pq', values.pq, ['true', 'false', '1', '0'], 'false');
  const payloadKb = Number(values['payload-kb'] ?? '15');
  if (!Number.isFinite(payloadKb) || payloadKb <= 0) throw new UsageError(`--payload-kb 要是正數，收到「${values['payload-kb']}」`);
  const input: ConsumptionSimulationInput & { json: boolean } = {
    cryptoMode: oneOf<CryptoMode>('--mode', values.mode, ['cinder-ek', 'double-ratchet'], 'cinder-ek'),
    postQuantum: pq === 'true' || pq === '1',
    devicesCount: positiveInt('--devices', values.devices, 3),
    collaboratorsCount: positiveInt('--collaborators', values.collaborators, 1),
    dailyActionsCount: positiveInt('--daily-actions', values['daily-actions'], 300),
    averagePayloadBytes: Math.round(payloadKb * 1000),
    json: values.json === true,
  };
  if (values['p2p-rate'] !== undefined) {
    const rate = Number(values['p2p-rate']);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new UsageError(`--p2p-rate 要介於 0 到 1，收到「${values['p2p-rate']}」`);
    input.p2pSuccessRate = rate;
  }
  if (values.tier !== undefined) {
    input.targetTier = oneOf<TargetTier>('--tier', values.tier, ['tier-0-public', 'tier-1-selfhosted', 'tier-2-serverless'], 'tier-2-serverless');
  }
  return input;
}

/**
 * `cinderous relay start` 的旗標 → Node 主機的環境變數與選項。
 * 以既有環境變數為底：Docker 用 `-e` 設的值照樣生效，旗標只覆寫有給的那幾個。
 */
export function parseRelayStartArgs(argv: string[], baseEnv: NodeRelayEnv): { env: NodeRelayEnv; options: NodeRelayOptions } {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      port: { type: 'string', short: 'p' },
      persist: { type: 'boolean' },
      'db-path': { type: 'string' },
      'allowed-pubkeys': { type: 'string', short: 'k' },
      'no-auth': { type: 'boolean' },
      name: { type: 'string' },
      'max-file-mb': { type: 'string' },
      'open-file-relay': { type: 'boolean' },
    },
  });
  const env: NodeRelayEnv = {
    // PRD 3.3 的防濫用預設（SDK ADR 0013）；環境變數有設就以環境變數為準
    MAX_CONNECTIONS_PER_PUBKEY: String(PRD_MAX_CONNECTIONS_PER_PUBKEY),
    MAX_MESSAGES_PER_SECOND_PER_IP: String(PRD_MAX_MESSAGES_PER_SECOND_PER_IP),
    ...baseEnv,
  };
  if (values.port !== undefined) env.PORT = String(positiveInt('--port', values.port, 8787));
  if (values['allowed-pubkeys'] !== undefined) env.ALLOWED_PUBKEYS = values['allowed-pubkeys'];
  if (values['no-auth']) env.REQUIRE_AUTH = '0';
  if (values.name !== undefined) env.RELAY_NAME = values.name;
  if (values['max-file-mb'] !== undefined) {
    // 與部署同一條規則（ADR 0027）：開放中繼收檔案塊＝任何人都能存進來
    if (!env.ALLOWED_PUBKEYS && values['open-file-relay'] !== true) throw new UsageError('--max-file-mb 需要白名單（--allowed-pubkeys），或明確加 --open-file-relay');
    env.MAX_FILE_MB = String(positiveInt('--max-file-mb', values['max-file-mb'], 1));
  }
  const persist = values.persist === true;
  if (persist) env.DB_PATH = values['db-path'] ?? 'cinderous-relay.db';
  return { env, options: { memory: !persist } };
}

const PROVIDERS = ['cloudflare', 'docker', 'fly'] as const;
type Provider = (typeof PROVIDERS)[number];

/** 只有 Cloudflare 版中繼支援的旗標（Node 主機沒有車道；SDK ADR 0036）。 */
const CLOUDFLARE_ONLY_FLAGS = ['app-lanes', 'file-lanes', 'app-lane-pow', 'developer-docs-url'] as const;

/** 給了 `--config` 時還能一起用的旗標：設定檔之外、每次部署可以不同的東西 */
const CONFIG_COMPANION_FLAGS = ['config', 'output-env', 'dry-run', 'non-interactive'] as const;

function nonNegativeInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`${flag} 要是 0 以上的整數，收到「${raw}」`);
  return value;
}

/**
 * 交給部署函式的參數（旗標路徑與 `--config` 路徑的共同形狀；SDK ADR 0050 §2）。
 * 站台參數原樣是 `RelaySiteOptions`，與四條部署路徑同一份。
 */
interface DeployArgs {
  provider: Provider;
  outputEnv: string;
  name?: string;
  site: RelaySiteOptions;
  apiToken?: string;
  accountId?: string;
  compatibilityDate?: string;
  region?: string;
  port?: number;
  persist: boolean;
  trustProxy?: boolean;
  tunnel?: DockerTunnelOptions;
  dryRun: boolean;
}

/** 旗標路徑才有、不進設定檔的值：憑證（`--api-token` 是秘密，`--account-id` 不寫進可分享的檔案）與每次部署可以不同的東西 */
interface FlagOverrides {
  apiToken?: string;
  accountId?: string;
  outputEnv: string;
  dryRun: boolean;
}

function parseDeployFlags(argv: string[]): { config: DeployConfig; overrides: FlagOverrides; configFile?: string } {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      config: { type: 'string', short: 'c' },
      provider: { type: 'string', short: 'p' },
      name: { type: 'string', short: 'n' },
      'allowed-pubkeys': { type: 'string', short: 'k' },
      'api-token': { type: 'string', short: 't' },
      'account-id': { type: 'string', short: 'a' },
      'compatibility-date': { type: 'string' },
      region: { type: 'string', short: 'r' },
      port: { type: 'string' },
      persist: { type: 'boolean' },
      'output-env': { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean' },
      'non-interactive': { type: 'boolean', short: 'y' },
      'max-file-mb': { type: 'string' },
      'open-file-relay': { type: 'boolean' },
      'relay-name': { type: 'string' },
      'relay-description': { type: 'string' },
      'relay-contact': { type: 'string' },
      'relay-software-url': { type: 'string' },
      'max-ttl-days': { type: 'string' },
      'max-connections-per-pubkey': { type: 'string' },
      'max-messages-per-second-per-ip': { type: 'string' },
      'app-lanes': { type: 'string' },
      'file-lanes': { type: 'string' },
      'app-lane-pow': { type: 'string' },
      'developer-docs-url': { type: 'string' },
    },
  });
  const overrides: FlagOverrides = { outputEnv: values['output-env'] ?? '.env.cinderous', dryRun: values['dry-run'] === true };
  if (values.config !== undefined) {
    // 設定檔是單一真實來源：站台參數只能在一個地方（SDK ADR 0050 §1）
    const extra = Object.keys(values).filter((key) => !(CONFIG_COMPANION_FLAGS as readonly string[]).includes(key));
    if (extra.length > 0) {
      throw new UsageError(`--config 不能和 ${extra.map((f) => `--${f}`).join('、')} 一起用：把它們寫進設定檔（只能另外加 --output-env、--dry-run）`);
    }
    return { config: { configVersion: 1, target: 'cloudflare' }, overrides, configFile: values.config };
  }
  const provider = oneOf<Provider>('--provider', values.provider, PROVIDERS, 'cloudflare');
  if (provider !== 'cloudflare') {
    const given = CLOUDFLARE_ONLY_FLAGS.filter((flag) => values[flag] !== undefined);
    if (given.length > 0) {
      throw new UsageError(`${given.map((f) => `--${f}`).join('、')} 只有 --provider=cloudflare 支援：Node 主機（docker／fly）沒有應用車道`);
    }
  }
  // 站台參數：範圍與其他驗證交給 relaySiteVars（四條部署路徑同一份），這裡只把字串轉成型別
  const site: DeploySiteOptions = {};
  if (values['allowed-pubkeys'] !== undefined) site.allowedPubkeys = splitList(values['allowed-pubkeys']);
  if (values['max-file-mb'] !== undefined) site.maxFileMb = positiveInt('--max-file-mb', values['max-file-mb'], 1);
  if (values['open-file-relay'] === true) site.openFileRelay = true;
  if (values['relay-name'] !== undefined) site.relayName = values['relay-name'];
  if (values['relay-description'] !== undefined) site.relayDescription = values['relay-description'];
  if (values['relay-contact'] !== undefined) site.relayContact = values['relay-contact'];
  if (values['relay-software-url'] !== undefined) site.relaySoftwareUrl = values['relay-software-url'];
  if (values['max-ttl-days'] !== undefined) site.maxTtlDays = positiveInt('--max-ttl-days', values['max-ttl-days'], 7);
  if (values['max-connections-per-pubkey'] !== undefined) {
    site.maxConnectionsPerPubkey = positiveInt('--max-connections-per-pubkey', values['max-connections-per-pubkey'], PRD_MAX_CONNECTIONS_PER_PUBKEY);
  }
  if (values['max-messages-per-second-per-ip'] !== undefined) {
    site.maxMessagesPerSecondPerIp = positiveInt('--max-messages-per-second-per-ip', values['max-messages-per-second-per-ip'], PRD_MAX_MESSAGES_PER_SECOND_PER_IP);
  }
  if (values['app-lanes'] !== undefined) site.appLanes = splitList(values['app-lanes']);
  if (values['file-lanes'] !== undefined) site.fileLanes = splitList(values['file-lanes']);
  if (values['app-lane-pow'] !== undefined) site.appLanePow = nonNegativeInt('--app-lane-pow', values['app-lane-pow']);
  if (values['developer-docs-url'] !== undefined) site.developerDocsUrl = values['developer-docs-url'];

  const config: DeployConfig = { configVersion: 1, target: provider };
  if (values.name !== undefined) config.name = values.name;
  if (Object.keys(site).length > 0) config.site = site;
  const node: NonNullable<DeployConfig['node']> = {};
  if (values.persist === true) node.persist = true;
  if (values.port !== undefined) node.port = positiveInt('--port', values.port, 8080);
  if (Object.keys(node).length > 0) config.node = node;
  if (values['compatibility-date'] !== undefined) config.cloudflare = { compatibilityDate: values['compatibility-date'] };
  if (values.region !== undefined) config.fly = { region: values.region };
  if (values['api-token'] !== undefined) overrides.apiToken = values['api-token'];
  if (values['account-id'] !== undefined) overrides.accountId = values['account-id'];
  return { config, overrides };
}

/**
 * 設定 → 部署函式的參數（SDK ADR 0050 §2）：`--config` 與旗標兩條路徑都走這裡，所以同一組選擇得到同一組部署參數。
 * 秘密在這裡才從環境讀（`$env` 引用，沒有就用各工具慣用的變數名稱）。
 */
function deployArgsFromConfig(config: DeployConfig, env: NodeRelayEnv, overrides: FlagOverrides): DeployArgs {
  if (serviceOfConfig(config) === 'push-gateway') {
    throw new UsageError(
      'relay deploy --config 只部署中繼：推播閘道（service: push-gateway）請用 relay build 產生部署包，照 README-DEPLOY.md 以 wrangler／docker compose／fly 部署（SDK ADR 0049 §11.1）',
    );
  }
  if (config.target === 'cloudflare-api') {
    throw new UsageError(
      'cloudflare-api 目標的 relay deploy --config 在 P1 才接上（SDK ADR 0050）：外掛請用 deployCloudflareRelayViaApi；終端機請把 target 改成 cloudflare（同一座中繼），或用 relay build 產生的 wrangler 設定',
    );
  }
  const provider: Provider = config.target === 'home-tunnel' ? 'docker' : config.target;
  const args: DeployArgs = {
    provider,
    outputEnv: overrides.outputEnv,
    // 秘密（私人路徑，SDK ADR 0051）在這裡才從環境讀；--dry-run 只產生設定，沒有值時用佔位值
    site: siteSecretsFor(config, env, overrides.dryRun),
    persist: config.node?.persist === true,
    dryRun: overrides.dryRun,
  };
  if (config.name !== undefined) args.name = config.name;
  if (provider === 'cloudflare') {
    const apiToken = overrides.apiToken ?? resolveSecret(config.secrets?.cloudflareApiToken, env, 'CLOUDFLARE_API_TOKEN');
    if (apiToken) args.apiToken = apiToken;
    const accountId = overrides.accountId ?? resolveStringOrSecret(config.cloudflare?.accountId, env, 'CLOUDFLARE_ACCOUNT_ID');
    if (accountId) args.accountId = accountId;
    if (config.cloudflare?.compatibilityDate !== undefined) args.compatibilityDate = config.cloudflare.compatibilityDate;
  }
  if (provider === 'fly') {
    const apiToken = overrides.apiToken ?? resolveSecret(config.secrets?.flyApiToken, env, 'FLY_API_TOKEN');
    if (apiToken) args.apiToken = apiToken;
    if (config.fly?.region !== undefined) args.region = config.fly.region;
  }
  if (config.target === 'docker') {
    if (config.node?.port !== undefined) args.port = config.node.port;
    if (config.node?.trustProxy === true) args.trustProxy = true;
  }
  if (config.target === 'home-tunnel') {
    const tokenEnv = secretEnvName(config, 'tunnelToken');
    const token = resolveSecret(config.secrets?.tunnelToken, env, tokenEnv);
    args.tunnel = {
      hostname: config.tunnel!.hostname!,
      tokenEnv,
      ...(token !== undefined ? { token } : {}),
      ...(config.tunnel?.cloudflaredImage !== undefined ? { image: config.tunnel.cloudflaredImage } : {}),
    };
  }
  return args;
}

function siteSecretsFor(config: DeployConfig, env: NodeRelayEnv, dryRun: boolean | undefined): RelaySiteOptions {
  try {
    return resolveSiteSecrets(config.site, env);
  } catch (error) {
    if (dryRun) return siteWithPlaceholders(config.site);
    throw error;
  }
}

async function deployWith(args: DeployArgs, deps: CliDeps): Promise<{ configPath: string; relayEndpoint?: string }> {
  const onProgress = (status: { step: string; message: string }) => deps.stdout(`[${status.step}] ${status.message}`);
  const common = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...args.site,
    ...(args.dryRun ? { dryRun: true } : {}),
    onProgress,
  };
  switch (args.provider) {
    case 'docker':
      return deps.deployDockerRelay({
        ...common,
        persist: args.persist,
        ...(args.port !== undefined ? { port: args.port } : {}),
        ...(args.trustProxy ? { trustProxy: true } : {}),
        ...(args.tunnel ? { tunnel: args.tunnel } : {}),
      });
    case 'fly':
      return deps.deployFlyRelay({
        ...common,
        persist: args.persist,
        ...(args.region !== undefined ? { region: args.region } : {}),
        ...(args.apiToken ? { apiToken: args.apiToken } : {}),
      });
    case 'cloudflare': {
      const { name, ...rest } = common;
      return deps.deployCloudflareRelay({
        ...rest,
        ...(name !== undefined ? { workerName: name } : {}),
        ...(args.apiToken ? { apiToken: args.apiToken } : {}),
        ...(args.accountId ? { accountId: args.accountId } : {}),
        ...(args.compatibilityDate ? { compatibilityDate: args.compatibilityDate } : {}),
      });
    }
  }
}

/** 印出驗證的問題；回傳有沒有錯誤 */
function reportIssues(issues: readonly DeployIssue[], deps: CliDeps): boolean {
  for (const issue of issues) {
    const where = issue.path === '' ? '' : `${issue.path}：`;
    deps.stderr(`${issue.severity === 'error' ? '✖' : '⚠'} ${where}${issue.message['zh-TW']}`);
  }
  return issues.some((issue) => issue.severity === 'error');
}

/** 很小的 `.env` 解析：`KEY=VALUE`、`#` 註解、去掉成對的引號。只讀、不寫（秘密不經過 CLI 的輸出）。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

/** 讀設定檔：不存在、不是 JSON 都回報並回傳 undefined */
function readConfigFile(path: string, deps: CliDeps): unknown {
  if (!deps.readFile) {
    deps.stderr('這個環境不支援讀檔（readFile）');
    return undefined;
  }
  const text = deps.readFile(path);
  if (text === undefined) {
    deps.stderr(`找不到設定檔：${path}`);
    return undefined;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as unknown;
  } catch (error) {
    deps.stderr(`設定檔不是合法的 JSON（${path}）：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function relayDeploy(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseDeployFlags(argv);
  let config = parsed.config;
  let env: NodeRelayEnv = deps.env;
  if (parsed.configFile !== undefined) {
    const configPath = resolve(deps.cwd, parsed.configFile);
    const input = readConfigFile(configPath, deps);
    if (input === undefined) return 1;
    const validation = validateDeployConfig(input, deps.sdkVersion !== undefined ? { sdkVersion: deps.sdkVersion } : {});
    if (reportIssues(validation.issues, deps)) return 1;
    config = input as DeployConfig;
    // 設定檔旁邊的 .env（部署包的慣例）：環境變數優先
    const dotEnv = deps.readFile?.(join(dirname(configPath), '.env'));
    if (dotEnv !== undefined) env = { ...parseDotEnv(dotEnv), ...deps.env };
  } else {
    // 旗標路徑：先組出設定、檢查設定檔層級的規則（例如 Worker 不吃 --persist）；站台參數照舊交給部署函式驗證
    const validation = validateDeployConfig(config, { checkSite: false });
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) throw new UsageError(errors.map((issue) => issue.message['zh-TW']).join('\n'));
    reportIssues(validation.issues, deps);
  }
  const args = deployArgsFromConfig(config, env, parsed.overrides);
  if (args.tunnel && args.tunnel.token === undefined && !args.dryRun) {
    // 沒有 Token，cloudflared 起不來：在起任何容器之前就說清楚
    deps.stderr(`找不到 Cloudflare Tunnel Token：請在環境變數或設定檔旁邊的 .env 設定 ${args.tunnel.tokenEnv}`);
    return 1;
  }
  if (!args.site.allowedPubkeys || args.site.allowedPubkeys.length === 0) {
    deps.stderr('⚠ 沒有設定白名單（--allowed-pubkeys）：部署出來的是開放中繼，任何人都能寫入。');
  }
  try {
    const deployment = await deployWith(args, deps);
    if (!deployment.relayEndpoint) {
      deps.stdout(`已產生設定（未部署），在 ${deployment.configPath}`);
      return 0;
    }
    const envPath = join(deps.cwd, args.outputEnv);
    deps.writeFile(envPath, `CINDEROUS_RELAY_URL=${deployment.relayEndpoint}\n`);
    deps.stdout(`中繼站上線：${deployment.relayEndpoint}`);
    deps.stdout(`端點已寫入 ${envPath}`);
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function relayBuild(argv: string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      config: { type: 'string', short: 'c' },
      out: { type: 'string', short: 'o' },
      'self-contained': { type: 'boolean' },
      'sdk-spec': { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  if (!deps.buildRelayPackage) {
    deps.stderr('這個環境不支援 relay build');
    return 1;
  }
  const configPath = resolve(deps.cwd, values.config ?? 'cinderous.config.json');
  const input = readConfigFile(configPath, deps);
  if (input === undefined) return 1;
  const outDir = resolve(deps.cwd, values.out ?? dirname(configPath));
  try {
    const result = await deps.buildRelayPackage({
      config: input,
      configPath,
      outDir,
      ...(values['self-contained'] ? { selfContained: true } : {}),
      ...(values['sdk-spec'] !== undefined ? { sdkSpec: values['sdk-spec'] } : {}),
      ...(values.force ? { force: true } : {}),
    });
    reportIssues(result.warnings, deps);
    deps.stdout(`已產生部署包：${result.outDir}（${result.files.length} 個檔案${result.copiedSdk ? '，另含 sdk/' : ''}）`);
    if (result.removed.length > 0) deps.stdout(`移除了不再需要的舊檔：${result.removed.join('、')}`);
    deps.stdout('接著照 README-DEPLOY.md（English: README-DEPLOY.en.md）部署。秘密放 .env（從 .env.example 複製），不要提交。');
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** `cinderous init`（SDK ADR 0117）：逐題問完寫出設定檔；還有錯誤也照寫（之後改檔再 config validate），但回 1 */
async function init(argv: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      provider: { type: 'string', short: 'p' },
      advanced: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', default: false },
      locale: { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new UsageError(`init 不吃位置參數，收到：${positionals.join(' ')}`);
  const target = values.provider === undefined ? undefined : oneOf('--provider', values.provider, DEPLOY_TARGETS, 'cloudflare');
  const locale = oneOf<DeployGuideLocale>('--locale', values.locale, ['zh-TW', 'en'], 'zh-TW');
  if (values.yes && target === undefined) throw new UsageError('init --yes 要搭配 --provider（不詢問就沒辦法選目標）');
  const path = resolve(deps.cwd, values.out ?? 'cinderous.config.json');
  if (!values.force && deps.readFile?.(path) !== undefined) {
    deps.stderr(`${path} 已經存在；要覆寫請加 --force`);
    return 1;
  }
  const ask = values.yes ? async () => '' : deps.prompt;
  if (ask === undefined) {
    deps.stderr('這個環境不能互動：加 --yes --provider <目標> 全部用預設值');
    return 1;
  }
  let result: Awaited<ReturnType<typeof runInitWizard>>;
  try {
    result = await runInitWizard(
      { ask, say: (line) => deps.stdout(line) },
      { locale, advanced: values.advanced, ...(target !== undefined ? { target } : {}), ...(deps.sdkVersion !== undefined ? { sdkVersion: deps.sdkVersion } : {}) },
    );
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  deps.writeFile(path, renderDeployConfigFile(result.config, deps.sdkVersion));
  for (const issue of result.issues) deps.stderr(`${issue.severity === 'error' ? '✖' : '⚠'} ${issue.path === '' ? '' : `${issue.path}：`}${issue.message[locale]}`);
  const zh = locale === 'zh-TW';
  deps.stdout(zh ? `已寫出 ${path}` : `Wrote ${path}`);
  if (result.issues.some((issue) => issue.severity === 'error')) {
    deps.stdout(zh ? '還有錯誤：改好設定檔後跑 cinderous config validate。' : 'There are still errors: fix the file, then run cinderous config validate.');
    return 1;
  }
  deps.stdout(zh ? `下一步：cinderous relay build --config ${path} --out deploy/` : `Next: cinderous relay build --config ${path} --out deploy/`);
  return 0;
}

function configCommand(sub: string | undefined, argv: string[], deps: CliDeps): number {
  if (sub === 'schema') {
    if (argv.length > 0) throw new UsageError(`config schema 不需要參數，收到：${argv.join(' ')}`);
    deps.stdout(renderDeployConfigJsonSchema().trimEnd());
    return 0;
  }
  if (sub === 'validate') {
    const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: { config: { type: 'string', short: 'c' } } });
    if (positionals.length > 1) throw new UsageError('config validate 只吃一個設定檔');
    const configPath = resolve(deps.cwd, values.config ?? positionals[0] ?? 'cinderous.config.json');
    const input = readConfigFile(configPath, deps);
    if (input === undefined) return 1;
    const validation = validateDeployConfig(input, deps.sdkVersion !== undefined ? { sdkVersion: deps.sdkVersion } : {});
    const hasErrors = reportIssues(validation.issues, deps);
    if (hasErrors) return 1;
    deps.stdout(validation.issues.length === 0 ? `設定檔沒有問題：${configPath}` : `設定檔可以用（有 ${validation.issues.length} 則提醒）：${configPath}`);
    return 0;
  }
  // migrate 在 ADR 0050 P1，還沒做；精靈是 `cinderous init`（SDK ADR 0117）
  throw new UsageError(`不認得的指令：config ${sub ?? ''}（可用：config validate、config schema）`);
}

// ── IoT（SDK ADR 0049 P0）─────────────────────────────────────────────

/** 讀 JSON 設定檔，並把設定檔旁邊的 `.env` 併進環境（環境變數優先；與 relay deploy --config 相同的慣例） */
function readIotConfig(path: string, deps: CliDeps): { input: unknown; env: NodeRelayEnv } | undefined {
  const input = readConfigFile(path, deps);
  if (input === undefined) return undefined;
  const dotEnv = deps.readFile?.(join(dirname(path), '.env'));
  return { input, env: dotEnv !== undefined ? { ...parseDotEnv(dotEnv), ...deps.env } : deps.env };
}

function shortKey(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  } catch {
    return pubkey.slice(0, 12);
  }
}

async function iotBridge(argv: string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: { config: { type: 'string', short: 'c' }, 'acl-file': { type: 'string' }, 'push-file': { type: 'string' } } });
  if (!deps.startIotBridge) {
    deps.stderr('這個環境不支援 iot bridge');
    return 1;
  }
  const configPath = resolve(deps.cwd, values.config ?? 'iot-bridge.json');
  const read = readIotConfig(configPath, deps);
  if (!read) return 1;
  let config: ResolvedIotBridgeConfig;
  try {
    config = resolveIotBridgeConfig(read.input, read.env);
  } catch (error) {
    deps.stderr(`✖ ${configPath}：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const aclPath = values['acl-file'] !== undefined ? resolve(deps.cwd, values['acl-file']) : resolve(dirname(configPath), config.aclFile);
  const pushPath = config.push ? (values['push-file'] !== undefined ? resolve(deps.cwd, values['push-file']) : resolve(dirname(configPath), config.push.storeFile)) : undefined;
  try {
    const bridge = await deps.startIotBridge(config, {
      aclPath,
      ...(pushPath !== undefined ? { pushPath } : {}),
      onLog: (e) => {
        const what = e.topic ?? e.device ?? '';
        deps.stdout(`[${e.kind}] ${e.from ? shortKey(e.from) : '-'} ${what} → ${e.status ?? '-'}${e.reason ? `（${e.reason}）` : ''}`);
      },
      onError: (error) => deps.stderr(`⚠ ${error instanceof Error ? error.message : String(error)}`),
    });
    deps.stdout(`IoT 橋接器啟動：閘道 ${bridge.gatewayNpub}；家 ${bridge.homeTag}；relay ${config.relays.join('、')}；MQTT ${config.mqtt.url}`);
    deps.stdout(`角色名單存檔：${aclPath}（只有 owner 能經 $sys/acl 修改）`);
    if (pushPath !== undefined) deps.stdout(`推播端點存檔：${pushPath}（成員經 $sys/push 登記；內含端點能力，不要提交）`);
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function formatAcl(acl: IotAcl): string[] {
  const lines = acl.entries.map((e) => {
    const parts = [e.role.padEnd(8), npubEncode(e.pubkey)];
    if (e.label) parts.push(`「${e.label}」`);
    if (e.devices) parts.push(`devices=${e.devices.join(',')}`);
    if (e.topics) parts.push(`topics=${e.topics.join(',')}`);
    if (e.expiresAt !== undefined) parts.push(`到期 ${new Date(e.expiresAt * 1000).toISOString()}`);
    return parts.join('  ');
  });
  for (const rule of acl.rules ?? []) {
    lines.push(`規則      ${rule.topic}${rule.minRole ? `  minRole=${rule.minRole}` : ''}${rule.confirm ? '  需確認' : ''}`);
  }
  return lines;
}

async function iotAcl(argv: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      role: { type: 'string' },
      devices: { type: 'string' },
      topics: { type: 'string' },
      'expires-at': { type: 'string' },
      label: { type: 'string' },
    },
  });
  const [action, target, ...extra] = positionals;
  if (action !== 'list' && action !== 'add' && action !== 'remove') throw new UsageError('iot acl 只有 list、add、remove');
  if (extra.length > 0) throw new UsageError(`多出來的參數：${extra.join(' ')}`);
  if (action === 'list' && target !== undefined) throw new UsageError('iot acl list 不需要參數');
  if (action !== 'list' && target === undefined) throw new UsageError(`iot acl ${action} 要給成員的 npub 或 hex 公鑰`);
  let pubkey: string | undefined;
  if (target !== undefined) {
    try {
      pubkey = iotPubkeyOf(target);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }
  let entry: IotAclEntryInput | undefined;
  if (action === 'add') {
    if (values.role === undefined) throw new UsageError('iot acl add 要給 --role（viewer、operator、owner）');
    const role = oneOf<IotRole>('--role', values.role, IOT_ROLES, 'viewer');
    const expiresAt = values['expires-at'] !== undefined ? positiveInt('--expires-at', values['expires-at'], 0) : undefined;
    entry = {
      pubkey: pubkey!,
      role,
      ...(values.devices !== undefined ? { devices: splitList(values.devices) } : {}),
      ...(values.topics !== undefined ? { topics: splitList(values.topics) } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(values.label !== undefined ? { label: values.label } : {}),
    };
  } else if ([values.role, values.devices, values.topics, values['expires-at'], values.label].some((v) => v !== undefined)) {
    throw new UsageError(`iot acl ${action} 不吃 --role／--devices／--topics／--expires-at／--label`);
  }
  if (!deps.connectIotClient) {
    deps.stderr('這個環境不支援 iot acl');
    return 1;
  }
  const configPath = resolve(deps.cwd, values.config ?? 'iot-client.json');
  const read = readIotConfig(configPath, deps);
  if (!read) return 1;
  let config: ResolvedIotClientConfig;
  try {
    config = resolveIotClientConfig(read.input, read.env);
  } catch (error) {
    deps.stderr(`✖ ${configPath}：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { client, close } = await deps.connectIotClient(config);
  try {
    if (action === 'list') {
      const acl = await client.getAcl();
      if (!acl) {
        deps.stderr('讀不到閘道的角色名單（閘道沒在線、relay 不對、或家庭秘密不對）');
        return 1;
      }
      for (const line of formatAcl(acl)) deps.stdout(line);
      return 0;
    }
    const result = await client.updateAcl(action === 'add' ? { op: 'add', entry: entry! } : { op: 'remove', pubkey: pubkey! });
    if (result.status !== 'ok') {
      deps.stderr(`閘道沒有接受：${result.status}${result.reason ? `（${result.reason}）` : ''}`);
      return 1;
    }
    deps.stdout(action === 'add' ? `已設定 ${npubEncode(pubkey!)} 為 ${entry!.role}` : `已移除 ${npubEncode(pubkey!)}`);
    return 0;
  } finally {
    close();
  }
}

function iotKeygen(argv: string[], deps: CliDeps): number {
  if (argv.length > 0) throw new UsageError(`iot keygen 不需要參數，收到：${argv.join(' ')}`);
  const homeSecret = generateIotHomeSecret();
  const gateway = Identity.generate();
  deps.stdout('# 新的 IoT 家庭（SDK ADR 0049）：以下秘密只顯示這一次，請放進 .env（不要提交）；家庭秘密以 QR 配對發給家人');
  deps.stdout(`IOT_HOME_SECRET=${homeSecret}`);
  deps.stdout(`IOT_GATEWAY_KEY=${gateway.nsec()}`);
  deps.stdout(`# 閘道公鑰（App 與 iot-client.json 的 gateway）：${gateway.npub}`);
  deps.stdout(`# 家的路由標籤（homeTag）：${deriveIotHome(homeSecret).homeTag}`);
  return 0;
}

function iotBuild(argv: string[], deps: CliDeps): number {
  const { values } = parseArgs({ args: argv, strict: true, options: { out: { type: 'string', short: 'o' }, config: { type: 'string', short: 'c' } } });
  if (!deps.prepareIotBridgeContext) {
    deps.stderr('這個環境不支援 iot build');
    return 1;
  }
  const workDir = resolve(deps.cwd, values.out ?? 'iot-bridge');
  const configPath = values.config !== undefined ? resolve(deps.cwd, values.config) : undefined;
  if (configPath !== undefined && readConfigFile(configPath, deps) === undefined) return 1;
  const files = deps.prepareIotBridgeContext({ workDir, ...(configPath !== undefined ? { configPath } : {}) });
  deps.stdout(`已產生橋接器的建置內容：${workDir}（${files.join('、')}）`);
  if (configPath === undefined) deps.stdout('請把 iot-bridge.json 放進這個資料夾。');
  deps.stdout('接著：cp .env.example .env 並填入秘密，然後 docker compose up -d --build');
  return 0;
}

function iotPushKeygen(argv: string[], deps: CliDeps): number {
  if (argv.length > 0) throw new UsageError(`iot push-keygen 不需要參數，收到：${argv.join(' ')}`);
  const key = Identity.generate();
  deps.stdout('# 推播閘道（SDK ADR 0049 §11.1）：私鑰只顯示這一次，放進推播閘道的 .env 或 Worker secret（不要提交）');
  deps.stdout(`PUSH_GATEWAY_KEY=${key.nsec()}`);
  deps.stdout(`# 公鑰（App 以它封推播 token；也可以從 GET /v1/info 讀）：${key.pubkey}`);
  return 0;
}

async function iotCommand(sub: string | undefined, argv: string[], deps: CliDeps): Promise<number> {
  if (sub === 'bridge') return iotBridge(argv, deps);
  if (sub === 'acl') return iotAcl(argv, deps);
  if (sub === 'keygen') return iotKeygen(argv, deps);
  if (sub === 'push-keygen') return iotPushKeygen(argv, deps);
  if (sub === 'build') return iotBuild(argv, deps);
  throw new UsageError(`不認得的指令：iot ${sub ?? ''}（可用：iot bridge、iot acl、iot keygen、iot push-keygen、iot build）`);
}

/** 執行一次命令列；回傳結束碼（0 成功、1 執行失敗、2 用法錯誤）。 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, sub, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      deps.stdout(USAGE);
      return 0;
    }
    if (command === 'estimate') {
      const { json, ...input } = parseEstimateArgs(argv.slice(1));
      const report = estimateResourceConsumption(input);
      deps.stdout(json ? JSON.stringify(report, null, 2) : formatEstimationReport(input, report));
      return 0;
    }
    if (command === 'relay' && sub === 'start') {
      const { env, options } = parseRelayStartArgs(rest, deps.env);
      deps.startNodeRelay(env, options);
      return 0;
    }
    if (command === 'relay' && sub === 'deploy') return await relayDeploy(rest, deps);
    if (command === 'relay' && sub === 'build') return await relayBuild(rest, deps);
    if (command === 'init') return await init(argv.slice(1), deps);
    if (command === 'config') return configCommand(sub, rest, deps);
    if (command === 'iot') return await iotCommand(sub, rest, deps);
    throw new UsageError(`不認得的指令：${argv.join(' ')}`);
  } catch (error) {
    // parseArgs 的錯誤（不認得的旗標、缺值）與我們自己的 UsageError 都是用法問題
    const code = (error as { code?: string }).code;
    if (error instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
      deps.stderr((error as Error).message);
      deps.stderr(USAGE);
      return 2;
    }
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
