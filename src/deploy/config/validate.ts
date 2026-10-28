// 設定檔的收集式驗證（SDK ADR 0050 §3）：一次列出所有問題、不丟例外。
// 型別檢查由描述表推出；站台參數交給 `collectRelaySiteIssues`（與四條部署路徑同一份規則，訊息逐字相同）；
// 另外加上設定檔層級的規則（目標與宿主、Tunnel、版本相容、秘密）。
import { WILDCARD_BIND_ADDRESSES } from '../render.js';
import { collectRelaySiteIssues, type DeployIssue, IssueList, type RelaySiteOptions } from '../shared.js';
import { DEFAULT_PUSH_GATEWAY_IOS, DEPLOY_OPTION_SPECS, type DeployOptionSpec, specAppliesTo } from './specs.js';
import { ENV_NAME_PATTERN, findSecretLiterals, siteWithPlaceholders } from './secrets.js';
import {
  DEPLOY_CONFIG_VERSION,
  DEPLOY_TARGETS,
  type DeployConfig,
  type DeploySiteOptions,
  type DeployTarget,
  hostOfTarget,
  isSecretRef,
  serviceOfConfig,
} from './types.js';

export interface ValidateDeployConfigOptions {
  /** 執行中的 SDK／CLI 版號：與設定檔的 `sdk` 比對（ADR 0050 §6）。沒給＝不比對。 */
  sdkVersion?: string;
  /**
   * false＝不驗證站台參數（`relay deploy` 的旗標路徑：站台參數照舊交給部署函式驗證，行為與 v0.37 相同）。預設 true。
   */
  checkSite?: boolean;
}

export interface DeployConfigValidation {
  /** 沒有 `error`（可以有 `warning`） */
  ok: boolean;
  issues: DeployIssue[];
}

/**
 * 影響部署的變更（ADR 0050 §6）：設定檔是舊版 SDK 產生的，CLI 列出這幾版之間要注意的事。
 * 只收「重新部署時行為會變」或「要多設一項才會動」的變更。
 */
export const DEPLOY_AFFECTING_CHANGES: readonly { version: string; adr: string; 'zh-TW': string; en: string }[] = [
  {
    version: '0.23.0',
    adr: '0027',
    'zh-TW': 'Vault 同步需要中繼接受檔案塊（site.maxFileMb，建議 17）',
    en: 'Vault sync needs the relay to accept file chunks (site.maxFileMb, 17 recommended)',
  },
  {
    version: '0.31.0',
    adr: '0036、0037',
    'zh-TW': '站台參數（appLanes、保存期、限速、NIP-11）開放；改 appLanes＝換 DO',
    en: 'Site parameters (appLanes, retention, rate limits, NIP-11) opened up; changing appLanes moves lanes to new DOs',
  },
  {
    version: '0.34.0',
    adr: '0042',
    'zh-TW': '容量政策（天花板、保底、溢位帶）；沒設時行為不變',
    en: 'Capacity policy (ceilings, guarantees, overflow band); unchanged when unset',
  },
  {
    version: '0.38.0',
    adr: '0050',
    'zh-TW': '設定檔驅動的部署；Worker 目標設了 node.persist／trustProxy 改為拒絕（原本默默忽略）；NIP-11 software 可設定',
    en: 'Config-driven deployment; Worker targets now reject node.persist / trustProxy (previously ignored silently); NIP-11 software is configurable',
  },
  {
    version: '0.40.0',
    adr: '0049 §11.1',
    'zh-TW': '新服務 service: push-gateway（參考推播閘道）；沒寫 service 仍是 relay，行為不變',
    en: 'New service: push-gateway (reference push gateway); without service it is still relay, unchanged',
  },
  {
    version: '0.41.0',
    adr: '0051',
    'zh-TW': '私人路徑模式 site.privateLane（只寫 $env）：開放寫入＋不可猜的隨機路徑、LANES_ONLY；沒設時行為不變',
    en: 'Private path mode site.privateLane ($env only): open writes behind an unguessable random path, LANES_ONLY; unchanged when unset',
  },
  {
    version: '0.42.0',
    adr: '0052',
    'zh-TW': '換私人路徑時的唯讀寬限期 site.readOnlyLanes（只寫 $env，中繼 READONLY_LANES）：舊路徑到期前只能讀；沒設時行為不變',
    en: 'Read-only grace period after a private path change, site.readOnlyLanes ($env only; relay READONLY_LANES): the old path is read-only until it expires; unchanged when unset',
  },
  {
    version: '0.47.0',
    adr: '0061',
    'zh-TW': '推播閘道 Workers 版可直連 APNs（pushGateway.ios: "apns"，要 APNs 設定與 secrets.apnsKey）；沒寫 ios 仍經 FCM、行為不變，但 Workers 版這條路已棄用（警告）',
    en: 'The push gateway Workers edition can reach APNs directly (pushGateway.ios: "apns", needs the APNs settings and secrets.apnsKey); without ios it still goes through FCM, unchanged, but that path is deprecated on Workers (warning)',
  },
  {
    version: '0.48.0',
    adr: '0062',
    'zh-TW': '【breaking】推播閘道 pushGateway.ios（PUSH_IOS）沒寫時改為 "apns"（兩版都是）：沒寫 ios 的設定要補 apnsTopic、apnsKeyId、apnsTeamId 與 secrets.apnsKey，只要 Android 就設 "off"，仍要經 FCM 就明寫 "fcm"（兩版都已棄用）；舊的 iOS FCM 登記不再送出，要等 App 重新登記',
    en: '[breaking] The push gateway pushGateway.ios (PUSH_IOS) now defaults to "apns" on both editions: configs without ios need apnsTopic, apnsKeyId, apnsTeamId and secrets.apnsKey, or "off" for Android only, or an explicit "fcm" to keep going through FCM (deprecated on both editions); existing iOS FCM registrations stop waking until the app re-registers',
  },
  {
    version: '0.51.0',
    adr: '0067',
    'zh-TW': '中繼處理收件確認（NIP-11 cinder_inbox_ack）：處理完的 Vault 同步包 2 小時後清掉；不需要新設定，重新部署才生效',
    en: 'The relay handles inbox acks (NIP-11 cinder_inbox_ack): processed Vault sync wraps expire 2 hours later; no new settings, takes effect after a redeploy',
  },  {
    version: '0.79.0',
    adr: '0118',
    'zh-TW': 'TURN 可以從設定檔設定（site.turnKeyId、site.turnTtlSeconds，Token 是 secrets.turnApiToken，部署時以 Worker secret 上傳）；沒設時行為不變。🔴 TURN 流量由 Cloudflare Realtime 另外計費',
    en: 'TURN can be set in the config (site.turnKeyId, site.turnTtlSeconds; the token is secrets.turnApiToken and is uploaded as a Worker secret); unchanged when unset. 🔴 TURN traffic is billed separately by Cloudflare Realtime',
  },  {
    version: '0.80.0',
    adr: '0119',
    'zh-TW': 'Node 中繼取 X-Forwarded-For 改為從右邊數（TRUST_PROXY=<層數>；原本取第一段，客戶端可以偽造）；docker 開了 node.trustProxy 時 compose 只發布在 127.0.0.1（反向代理在別台要設 node.bindAddress）；新增 HOST／relay start --host',
    en: 'The Node relay now reads X-Forwarded-For from the right (TRUST_PROXY=<hops>; it used the first entry, which clients can forge); with node.trustProxy, the docker compose file publishes on 127.0.0.1 only (set node.bindAddress if the reverse proxy is on another host); new HOST / relay start --host',
  },  {
    version: '0.81.0',
    adr: '0121',
    'zh-TW': 'Cloudflare Worker 一律帶 IOT_HOME 綁定，重新部署會套用 Durable Object 遷移 v2（新增 IotHomeRoom，沒有資料）；沒設 site.iotRealtime 時行為不變。IoT 即時通道（C′）可從設定檔開（site.iotRealtime，閘道私鑰是 secrets.iotGatewayKeys）',
    en: 'Cloudflare Workers always carry the IOT_HOME binding, so a redeploy applies Durable Object migration v2 (adds IotHomeRoom, no data); nothing changes without site.iotRealtime. The IoT realtime channel (C′) can be turned on from the config (site.iotRealtime; gateway keys are secrets.iotGatewayKeys)',
  },
];

/** 比較 x.y.z（預發行標記忽略）：a < b 回負數 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function valueAt(config: Record<string, unknown>, path: string): unknown {
  let node: unknown = config;
  for (const part of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** 設定檔每一層允許的鍵（由描述表推出） */
function allowedKeys(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>([['', new Set(['$schema'])]]);
  for (const spec of DEPLOY_OPTION_SPECS) {
    const parts = spec.path.split('.');
    for (let i = 0; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('.');
      if (!out.has(parent)) out.set(parent, new Set());
      out.get(parent)!.add(parts[i]!);
    }
  }
  out.set('site.donations', new Set(['githubSponsors', 'buyMeACoffee', 'liberapay', 'lightning']));
  return out;
}

const SECTION_LABEL: Record<string, { zh: string; en: string }> = {
  string: { zh: '字串', en: 'a string' },
  integer: { zh: '整數', en: 'an integer' },
  boolean: { zh: 'true 或 false', en: 'true or false' },
  list: { zh: '字串陣列', en: 'an array of strings' },
  object: { zh: '物件', en: 'an object' },
};

/**
 * 型別檢查（由描述表推出）。站台參數只檢查型別——範圍與其他規則交給 `collectRelaySiteIssues`，訊息才會與部署路徑一致。
 * 回傳 false＝型別不對（後面的規則不再看這一項）。
 */
function checkType(issues: IssueList, spec: DeployOptionSpec, value: unknown): boolean {
  const path = spec.path;
  const site = path.startsWith('site.');
  const typeError = (kind: keyof typeof SECTION_LABEL): false => {
    issues.error(path, 'type', `${path} 必須是${SECTION_LABEL[kind]!.zh}`, `${path} must be ${SECTION_LABEL[kind]!.en}`);
    return false;
  };
  switch (spec.type) {
    case 'string':
    case 'pubkey':
    case 'https-url':
      if (typeof value !== 'string') return typeError('string');
      if (site) return true;
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        issues.error(path, 'too-long', `${path} 最長 ${spec.maxLength} 字`, `${path} may be at most ${spec.maxLength} characters`);
        return false;
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        issues.error(path, 'pattern', `${path} 的格式不對：「${value}」`, `${path} has the wrong format: "${value}"`);
        return false;
      }
      return true;
    case 'enum':
      if (typeof value !== 'string' || !(spec.enum ?? []).includes(value)) {
        issues.error(path, 'enum', `${path} 只能是 ${(spec.enum ?? []).join('、')}，收到 ${JSON.stringify(value)}`, `${path} must be one of ${(spec.enum ?? []).join(', ')}; got ${JSON.stringify(value)}`);
        return false;
      }
      return true;
    case 'integer':
      if (typeof value !== 'number') return typeError('integer');
      if (site) return true;
      if (!Number.isInteger(value) || (spec.range && (value < spec.range.min || value > spec.range.max))) {
        const range = spec.range ? `${spec.range.min}–${spec.range.max} 的` : '';
        const rangeEn = spec.range ? ` from ${spec.range.min} to ${spec.range.max}` : '';
        issues.error(path, 'out-of-range', `${path} 必須是 ${range}整數，收到 ${value}`, `${path} must be an integer${rangeEn}; got ${value}`);
        return false;
      }
      return true;
    case 'boolean':
      return typeof value === 'boolean' ? true : typeError('boolean');
    case 'string-list':
    case 'pubkey-list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? true : typeError('list');
    case 'record':
      return isPlainObject(value) ? true : typeError('object');
    case 'secret-ref':
    case 'string-or-secret-ref': {
      if (typeof value === 'string' && spec.type === 'string-or-secret-ref') {
        if (spec.pattern && !spec.pattern.test(value)) {
          issues.error(path, 'pattern', `${path} 的格式不對：「${value}」`, `${path} has the wrong format: "${value}"`);
          return false;
        }
        return true;
      }
      if (typeof value === 'string') {
        issues.error(
          path,
          'secret-literal',
          `${path} 是秘密：設定檔只能寫 { "$env": "變數名稱" }，不能直接寫值`,
          `${path} is a secret: the config may only contain { "$env": "NAME" }, never the value itself`,
        );
        return false;
      }
      if (!isSecretRef(value) || Object.keys(value).length !== 1 || !ENV_NAME_PATTERN.test(value.$env)) {
        issues.error(
          path,
          'secret-ref',
          `${path} 必須是 { "$env": "變數名稱" }（英數與底線，不以數字開頭）`,
          `${path} must be { "$env": "NAME" } (letters, digits and underscores, not starting with a digit)`,
        );
        return false;
      }
      return true;
    }
  }
}

/** 不適用的設定：Worker 收到 Node 主機的選項、port 給了不發布埠的目標 → 拒絕（設了卻不生效）；其他區段 → 提醒。 */
function checkApplicable(issues: IssueList, spec: DeployOptionSpec, target: DeployTarget): void {
  if (!spec.targets || spec.targets.includes(target)) return;
  const zh = `${spec.path} 不適用於 ${target} 目標`;
  const en = `${spec.path} does not apply to the ${target} target`;
  if (spec.path.startsWith('node.')) {
    issues.error(spec.path, 'not-applicable', `${zh}：設了卻不生效，比部署失敗更難查`, `${en}: a setting that silently does nothing is harder to debug than a failed deployment`);
  } else {
    issues.warn(spec.path, 'not-applicable', `${zh}，會被忽略`, `${en} and is ignored`);
  }
}

/** 推播閘道（ADR 0049 §11.1）的設定檔層級規則：與執行期 `pushGatewayConfigFromEnv` 相同的限制，部署前就擋下 */
function checkPushGateway(issues: IssueList, config: Record<string, unknown>, target: DeployTarget): void {
  const push = isPlainObject(config.pushGateway) ? config.pushGateway : {};
  if (target === 'cloudflare-api') {
    issues.error(
      'target',
      'push-gateway-target',
      '推播閘道不支援 cloudflare-api 目標（REST 部署只有中繼）：請用 cloudflare（wrangler）',
      'The push gateway does not support the cloudflare-api target (REST deployment is relay-only): use cloudflare (wrangler)',
    );
  }
  const explicitIos = typeof push.ios === 'string' ? push.ios : undefined;
  const ios = explicitIos ?? DEFAULT_PUSH_GATEWAY_IOS;
  if (ios === 'fcm') {
    // SDK ADR 0061、0062：兩版都能直連 APNs；iOS 經 FCM 仍可用，但兩版都已棄用
    issues.warn(
      'pushGateway.ios',
      'push-ios-fcm-deprecated',
      'iOS 經 FCM 已棄用（Google 也看得到 iOS 的喚醒時間點）：Workers 版與 Node 版都能直連 APNs，請改設 pushGateway.ios: "apns" 並填 apnsTopic、apnsKeyId、apnsTeamId 與 secrets.apnsKey（SDK ADR 0062）；不用 iOS 就設 "off"',
      'iOS via FCM is deprecated (Google also sees when iOS phones are woken): both the Workers and Node editions can reach APNs directly — set pushGateway.ios: "apns" with apnsTopic, apnsKeyId, apnsTeamId and secrets.apnsKey (SDK ADR 0062); set "off" if you do not use iOS',
    );
  }
  if (ios === 'apns') {
    for (const key of ['apnsTopic', 'apnsKeyId', 'apnsTeamId']) {
      if (push[key] !== undefined) continue;
      if (explicitIos === undefined) {
        // SDK ADR 0062：v0.48.0 起沒寫 ios 就是 apns（breaking）——寫明預設值與三種改法
        issues.error(
          `pushGateway.${key}`,
          'required',
          `pushGateway.ios 沒寫時預設是 "apns"（v0.48.0 起，iOS 直連 APNs）：請設定 pushGateway.${key}（以及 apnsTopic、apnsKeyId、apnsTeamId 與 secrets.apnsKey）；只支援 Android 就設 pushGateway.ios: "off"（不需要 Apple 金鑰）；仍要經 FCM 就明寫 pushGateway.ios: "fcm"（已棄用）`,
          `pushGateway.ios defaults to "apns" since v0.48.0 (iOS talks to APNs directly): set pushGateway.${key} (along with apnsTopic, apnsKeyId, apnsTeamId and secrets.apnsKey); for Android only, set pushGateway.ios: "off" (no Apple key needed); to keep going through FCM, set pushGateway.ios: "fcm" explicitly (deprecated)`,
        );
      } else {
        issues.error(`pushGateway.${key}`, 'required', `直連 APNs（pushGateway.ios=apns）必須設定 pushGateway.${key}`, `Direct APNs (pushGateway.ios=apns) requires pushGateway.${key}`);
      }
    }
  }
  if (push.android === false && ios === 'off') {
    issues.error('pushGateway', 'push-nothing', 'Android 與 iOS 都關了：推播閘道沒有東西可送', 'Both Android and iOS are off: the push gateway has nothing to send');
  }
}

/**
 * 驗證 `cinderous.config.json`（SDK ADR 0050 §3）：回傳**全部**問題，不丟例外。`ok`＝沒有 `error`。
 * 接受任何值（剛 `JSON.parse` 出來的東西），所以 UI 可以在使用者每改一欄就重新驗證。
 */
export function validateDeployConfig(input: unknown, opts: ValidateDeployConfigOptions = {}): DeployConfigValidation {
  const issues = new IssueList();
  const done = (): DeployConfigValidation => {
    // 同一個欄位、同一類問題只報一次（例如秘密欄位直接寫值，型別檢查與秘密掃描都會抓到）
    const seen = new Set<string>();
    const unique = issues.issues.filter((issue) => {
      const key = `${issue.path}\u0000${issue.code === 'secret-like' ? 'secret-literal' : issue.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ok: !unique.some((issue) => issue.severity === 'error'), issues: unique };
  };
  if (!isPlainObject(input)) {
    issues.error('', 'type', '設定檔必須是 JSON 物件', 'The config must be a JSON object');
    return done();
  }
  const config = input;

  // 未知的鍵：打錯字（例如 maxTtlDay）要看得見，不能被默默忽略
  for (const [parent, keys] of allowedKeys()) {
    const node = parent === '' ? config : valueAt(config, parent);
    if (!isPlainObject(node)) continue;
    for (const key of Object.keys(node)) {
      if (!keys.has(key)) {
        const path = parent === '' ? key : `${parent}.${key}`;
        issues.error(path, 'unknown-key', `不認得的設定：${path}`, `Unknown setting: ${path}`);
      }
    }
  }

  // 版本
  if (config.configVersion === undefined) {
    issues.error('configVersion', 'required', `缺少 configVersion（目前是 ${DEPLOY_CONFIG_VERSION}）`, `configVersion is missing (currently ${DEPLOY_CONFIG_VERSION})`);
  } else if (typeof config.configVersion === 'number' && config.configVersion > DEPLOY_CONFIG_VERSION) {
    issues.error(
      'configVersion',
      'unsupported-version',
      `這份設定是第 ${config.configVersion} 版格式，這個 CLI 只認得到第 ${DEPLOY_CONFIG_VERSION} 版：請升級 @cinderous/client`,
      `This config uses format version ${config.configVersion}; this CLI only understands up to ${DEPLOY_CONFIG_VERSION}. Upgrade @cinderous/client`,
    );
    return done();
  } else if (config.configVersion !== DEPLOY_CONFIG_VERSION) {
    issues.error('configVersion', 'unsupported-version', `configVersion 必須是 ${DEPLOY_CONFIG_VERSION}`, `configVersion must be ${DEPLOY_CONFIG_VERSION}`);
  }
  if (config.target === undefined) {
    issues.error('target', 'required', `缺少 target（${DEPLOY_TARGETS.join('、')}）`, `target is missing (${DEPLOY_TARGETS.join(', ')})`);
    return done();
  }
  if (typeof config.target !== 'string' || !(DEPLOY_TARGETS as readonly string[]).includes(config.target)) {
    issues.error(
      'target',
      'enum',
      `target 只能是 ${DEPLOY_TARGETS.join('、')}，收到 ${JSON.stringify(config.target)}`,
      `target must be one of ${DEPLOY_TARGETS.join(', ')}; got ${JSON.stringify(config.target)}`,
    );
    return done();
  }
  const target = config.target as DeployTarget;
  const host = hostOfTarget(target);
  const service = serviceOfConfig(config);

  // 區段本身要是物件
  for (const section of ['site', 'node', 'cloudflare', 'fly', 'tunnel', 'pushGateway', 'secrets']) {
    if (config[section] !== undefined && !isPlainObject(config[section])) {
      issues.error(section, 'type', `${section} 必須是物件`, `${section} must be an object`);
    }
  }

  // 由描述表推出的型別檢查、必填、適用性
  let siteTypesOk = true;
  for (const spec of DEPLOY_OPTION_SPECS) {
    if (spec.path === 'configVersion' || spec.path === 'target') continue;
    const value = valueAt(config, spec.path);
    if (value === undefined) {
      if (spec.requiredFor?.includes(target)) {
        issues.error(spec.path, 'required', `${target} 目標必須設定 ${spec.path}`, `The ${target} target requires ${spec.path}`);
      }
      continue;
    }
    const typeOk = checkType(issues, spec, value);
    if (!typeOk && spec.path.startsWith('site.')) siteTypesOk = false;
    if (typeOk && spec.services && !spec.services.includes(service)) {
      const section = spec.path.startsWith('site.') ? 'site' : spec.path;
      issues.error(
        section,
        'not-applicable-service',
        `${section} 只適用於 ${spec.services.join('、')} 服務（這份設定是 ${service}）：設了卻不生效`,
        `${section} only applies to the ${spec.services.join(', ')} service (this config is ${service}): it would silently do nothing`,
      );
      continue;
    }
    // 站台參數的宿主限制交給 collectRelaySiteIssues（worker-only），這裡只看目標
    if (typeOk && !spec.path.startsWith('site.') && !specAppliesTo(spec, target, host)) checkApplicable(issues, spec, target);
  }

  // 設定檔層級的規則
  if (target === 'fly' || target === 'home-tunnel') {
    const node = isPlainObject(config.node) ? config.node : {};
    if (node.trustProxy === false) {
      issues.error(
        'node.trustProxy',
        'trust-proxy-required',
        `${target} 的連線一定經過代理（${target === 'fly' ? 'Fly 的邊緣' : 'Cloudflare Tunnel'}）：node.trustProxy 不能是 false，否則 IP 限速會把所有人算成同一個來源`,
        `${target} connections always come through a proxy (${target === 'fly' ? 'the Fly edge' : 'Cloudflare Tunnel'}): node.trustProxy cannot be false, or IP rate limits would count everyone as one source`,
      );
    }
  }
  // 發布位址（SDK ADR 0119）：信任 X-Forwarded-For 又對所有網卡發布＝直接連埠的人能偽造 IP
  if (target === 'docker' && isPlainObject(config.node) && config.node.trustProxy === true) {
    const bind = config.node.bindAddress;
    if (typeof bind === 'string' && WILDCARD_BIND_ADDRESSES.includes(bind)) {
      issues.warn(
        'node.bindAddress',
        'public-bind-trust-proxy',
        `node.bindAddress 是 ${bind}（所有網卡）又開了 node.trustProxy：直接連 ${bind} 的人可以自己帶 X-Forwarded-For 假裝成任何 IP，躲過每個 IP 的上限；Docker 發布的埠也會繞過 ufw。反向代理在同一台就拿掉 bindAddress（會用 127.0.0.1）`,
        `node.bindAddress is ${bind} (all interfaces) while node.trustProxy is on: anyone connecting directly can send their own X-Forwarded-For and pose as any IP, dodging per-IP limits; ports published by Docker also bypass ufw. If the reverse proxy is on the same host, remove bindAddress (127.0.0.1 is used)`,
      );
    }
  }
  const compat = valueAt(config, 'cloudflare.compatibilityDate');
  if (typeof compat === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(compat) && Number.isNaN(Date.parse(`${compat}T00:00:00Z`))) {
    issues.error('cloudflare.compatibilityDate', 'pattern', `cloudflare.compatibilityDate 不是有效的日期：${compat}`, `cloudflare.compatibilityDate is not a valid date: ${compat}`);
  }

  if (service === 'push-gateway') checkPushGateway(issues, config, target);

  // 站台參數：與部署路徑同一份規則（訊息逐字相同）
  if (service === 'relay' && opts.checkSite !== false && siteTypesOk) {
    // 秘密（私人路徑）以佔位值驗證：規則與部署路徑相同，但設定檔裡沒有、也不需要真的值
    const site: RelaySiteOptions = siteWithPlaceholders((isPlainObject(config.site) ? config.site : {}) as DeploySiteOptions);
    for (const issue of collectRelaySiteIssues(site, host)) {
      issues.issues.push({ ...issue, path: issue.path === '' ? 'site' : `site.${issue.path}` });
    }
    const allowlist = Array.isArray(site.allowedPubkeys) ? site.allowedPubkeys.length : 0;
    if (site.privateLane !== undefined) {
      issues.warn(
        'site.privateLane',
        'private-lane',
        '私人路徑模式：開放寫入，網址（wss://<host>/app/<id>）等同密碼——不要貼到公開地方；外洩就換一個重新部署',
        'Private path mode: writes are open and the URL (wss://<host>/app/<id>) is a password — never post it publicly; if it leaks, deploy again with a new one',
      );
    } else if (allowlist === 0) {
      issues.warn(
        'site.allowedPubkeys',
        'open-relay',
        '沒有設定白名單：部署出來的是開放中繼，任何人都能寫入、用你的額度',
        'No allowlist: this deploys an open relay that anyone can write to on your quota',
      );
    }
  }

  // 版本相容（ADR 0050 §6）
  if (opts.sdkVersion !== undefined && typeof config.sdk === 'string' && config.sdk !== '') {
    const cmp = compareVersions(config.sdk, opts.sdkVersion);
    if (cmp > 0) {
      issues.error(
        'sdk',
        'sdk-newer',
        `這份設定由較新的 SDK（${config.sdk}）產生，這個 CLI 是 ${opts.sdkVersion}：請升級 @cinderous/client 再部署`,
        `This config was produced by a newer SDK (${config.sdk}); this CLI is ${opts.sdkVersion}. Upgrade @cinderous/client before deploying`,
      );
    } else if (cmp < 0) {
      const between = DEPLOY_AFFECTING_CHANGES.filter(
        (c) => compareVersions(c.version, config.sdk as string) > 0 && compareVersions(c.version, opts.sdkVersion!) <= 0,
      );
      if (between.length > 0) {
        issues.warn(
          'sdk',
          'sdk-older',
          `這份設定由 ${config.sdk} 產生，這個 CLI 是 ${opts.sdkVersion}；中間影響部署的變更：` +
            between.map((c) => `v${c.version}（ADR ${c.adr}）${c['zh-TW']}`).join('；'),
          `This config was produced by ${config.sdk}; this CLI is ${opts.sdkVersion}. Changes in between that affect deployment: ` +
            between.map((c) => `v${c.version} (ADR ${c.adr}) ${c.en}`).join('; '),
        );
      }
    }
  }

  // 直接寫進去的秘密
  issues.issues.push(...findSecretLiterals(config));
  return done();
}

/** 驗證後轉型；有錯就丟例外（訊息列出全部錯誤，繁中）。給已經確定要用這份設定的呼叫端。 */
export function assertDeployConfig(input: unknown, opts: ValidateDeployConfigOptions = {}): DeployConfig {
  const result = validateDeployConfig(input, opts);
  if (!result.ok) {
    const lines = result.issues.filter((i) => i.severity === 'error').map((i) => `- ${i.path === '' ? '' : `${i.path}：`}${i.message['zh-TW']}`);
    throw new Error(`設定檔有 ${lines.length} 個錯誤：\n${lines.join('\n')}`);
  }
  return input as unknown as DeployConfig;
}
