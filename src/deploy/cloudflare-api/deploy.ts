// 以 Cloudflare REST API v4 部署中繼（SDK ADR 0021）：不需要 Node、不需要 wrangler。
//
// 流程：
// 1. 驗證 Token（`GET /user/tokens/verify`；OAuth access token 跳過這步）
// 2. 決定帳號：有給就用；沒給就列出帳號，只有一個才自動選
// 3. 確認 workers.dev 子網域（`GET /accounts/{id}/workers/subdomain`；沒有且呼叫端有給名字才 `PUT` 建立）
// 4. 查這個名稱的 Worker 目前套用到哪個遷移 tag（`GET /accounts/{id}/workers/scripts`），決定要送哪些遷移
// 5. multipart 上傳 module Worker（`PUT /accounts/{id}/workers/scripts/{name}`）
// 6. 開啟 workers.dev 路由（`POST /accounts/{id}/workers/scripts/{name}/subdomain`）
// 7. 打 `/healthz` 直到回 `ok`，回傳 `wss://<name>.<subdomain>.workers.dev`
import { knownLanes, lanesOnlyFrom, READONLY_LANES_MAX, readOnlyLanesFrom } from '../../relay/host-config.js';
import { LANE_ID_PATTERN } from '../../relay/shard.js';
import {
  assertCompatibilityDate,
  assertRelayName,
  checkCompatibilityDate,
  checkRelayName,
  collectRelaySiteIssues,
  DEFAULT_COMPATIBILITY_DATE,
  DEFAULT_WORKER_NAME,
  type DeployIssue,
  type DeployProgress,
  type DeployStep,
  type DeploySubstep,
  privateLaneEndpoint,
  READ_ONLY_GRACE_DAYS,
  type ReadOnlyLane,
  RELAY_DO_BINDINGS,
  RELAY_DO_MIGRATIONS,
  type RelaySiteOptions,
  type RelayWorkerSecrets,
  relayWorkerSecrets,
  relayWorkerVars,
  sameLaneList,
  waitForHealthy,
} from '../shared.js';
import { listAccounts, verifyToken } from './auth.js';
import { CloudflareApiError, cloudflareRequest, defaultHttp, type HttpFetch } from './http.js';
import { relayWorkerSdkVersion } from './relay-worker-info.js';

/**
 * 站台參數（白名單 `allowedPubkeys`、站名 `relayName`、已知租戶車道 `appLanes`、防濫用、保存期、檔案塊……）
 * 見 `RelaySiteOptions`（SDK ADR 0036、0037），與 wrangler、docker、fly 路徑共用同一份驗證。
 */
export interface CloudflareApiDeployOptions extends RelaySiteOptions, RelayWorkerSecrets {
  /** 使用者建立的 API Token（權限見 `REQUIRED_TOKEN_PERMISSIONS`），或 OAuth access token。由呼叫端保存。 */
  apiToken: string;
  /**
   * `apiToken` 是哪一種憑證。預設 `api-token`：先以 `/user/tokens/verify` 驗證。
   * `oauth`：OAuth access token 不能用那個端點驗證，改由後續第一個 API 呼叫判斷是否有效。
   */
  credential?: 'api-token' | 'oauth';
  /** 🔴 瀏覽器環境必須注入（Cloudflare API 沒有 CORS）；Obsidian 用 `requestUrl` 轉接器。沒給用全域 `fetch`。 */
  fetch?: HttpFetch;
  /** 沒給就列出帳號：只有一個時自動選，多個時丟 `account-ambiguous`（附 `accounts` 讓使用者選）。 */
  accountId?: string;
  /** Worker 名稱，也是網址的第一段。預設 `cinderous-relay`。 */
  workerName?: string;
  /**
   * 重新部署時允許已知租戶名單（`appLanes`）與線上那份不同。預設 false → `lane-change`，不上傳。
   * 🔴 名單改了＝那幾條車道換一顆 DO：舊 DO 裡的可尋址事件與離線留言不會搬過去（等 TTL 到期），
   * 對那幾條車道是一次冷啟動（SDK ADR 0036；Cinderous ADR-0366）。
   */
  allowLaneChange?: boolean;
  /**
   * 換私人路徑時，讓舊路徑進入唯讀寬限期（SDK ADR 0052）：`id` 是舊的車道 id、`graceDays` 1–30（預設 7）。
   * 部署出來的中繼 `APP_LANES` 只有新的、`READONLY_LANES` 加上舊的與到期時間：到期前舊網址連得上、讀得到、不收寫入
   * （其他裝置從那裡讀到搬家通知），到期後與認不得的路徑相同；舊路徑那顆 DO 的資料保留到期為止。
   * 要搭配 `privateLane`（新的）與 `allowLaneChange`。🔴 舊 id 也是秘密：錯誤訊息與進度不回顯。
   *
   * 不論有沒有給，重新部署都會**保留線上 `READONLY_LANES` 裡還沒到期的**（過期的清掉），不會把仍在寬限期的舊路徑弄丟。
   */
  retireLane?: { id: string; graceDays?: number };
  /** 帳號還沒有 workers.dev 子網域時要註冊的名字。沒給而帳號又沒有 → `subdomain-missing`。 */
  workersDevSubdomain?: string;
  /**
   * 名稱已被帳號裡另一支 Worker（不是這個 SDK 部署的中繼）佔用時，是否覆蓋。預設 false → `name-conflict`。
   * 🔴 覆蓋會換掉那支 Worker 的程式碼與設定，無法復原。
   */
  replaceExisting?: boolean;
  compatibilityDate?: string;
  /** 寫進 NIP-11 `version` 的版號（部署者的版號）。預設是打包這份 Worker 的 SDK 版號。 */
  version?: string;
  onProgress?: DeployProgress;
  /**
   * 要上傳的中繼 Worker 原始碼。`deployCloudflareRelayViaApi` 沒給就用打包在 SDK 裡的那份；
   * `deployCloudflareRelayWithWorker` 必填（SDK ADR 0094：外掛部署時才用 `fetchRelayWorker` 下載）。
   */
  workerSource?: string;
  /** 以下供測試或特殊環境替換 */
  apiBase?: string;
  healthRetries?: number;
  healthDelayMs?: number;
}

export interface CloudflareApiDeployment {
  workerName: string;
  accountId: string;
  /** 帳號的 workers.dev 子網域（不含 `.workers.dev`） */
  subdomain: string;
  httpUrl: string;
  /** 給客戶端連的端點。私人路徑模式（SDK ADR 0051）是含秘密路徑的完整網址 `wss://<host>/app/<id>`——它等同密碼 */
  relayEndpoint: string;
  /** 私人路徑模式才有：這次部署用的車道 id（等於 `privateLane`） */
  privateLane?: string;
  /** 部署後中繼上的唯讀寬限期（SDK ADR 0052；含保留下來的與這次 `retireLane` 的）。沒有就不出現 */
  readOnlyLanes?: ReadOnlyLane[];
  /** 這次有沒有送 Durable Object 遷移（第一次部署是 true；重新部署是 false） */
  migrationsApplied: boolean;
}

export const WORKER_ENTRY_MODULE = 'entry.mjs';
export const WORKER_RELAY_MODULE = 'relay.mjs';

/** 主模組：注入版號後轉出打包好的 Worker 與兩個 Durable Object 類別（與 wrangler 路徑的 `renderWorkerEntry` 同一個做法）。 */
export function renderApiWorkerEntry(version: string): string {
  const relay = JSON.stringify(`./${WORKER_RELAY_MODULE}`);
  return [
    '// 由 @cinderous/client/deploy/cloudflare-api 產生（SDK ADR 0021）。',
    `import { setRelayVersion } from ${relay};`,
    `setRelayVersion(${JSON.stringify(version)});`,
    `export { default, ${RELAY_DO_BINDINGS.map((b) => b.className).join(', ')} } from ${relay};`,
    '',
  ].join('\n');
}

export interface MigrationPayload {
  old_tag?: string;
  new_tag: string;
  steps: { new_sqlite_classes: string[] }[];
}

/**
 * 依已部署 Worker 目前的遷移 tag 決定要送的遷移（與 wrangler 的做法相同）：
 * - 沒有這支 Worker，或它沒有 tag → 送全部，不帶 `old_tag`
 * - tag 是我們的最後一個 → 不送（重新部署）
 * - tag 是我們較早的某一個 → 只送它之後的，帶 `old_tag`
 * - tag 不是我們的 → `undefined` 代表「不是這個 SDK 的中繼」，由呼叫端決定要不要覆蓋
 */
export function planMigrations(currentTag: string | undefined): { payload?: MigrationPayload; foreign: boolean } {
  const all = RELAY_DO_MIGRATIONS;
  const last = all[all.length - 1]!;
  const steps = (from: number) => all.slice(from).map((m) => ({ new_sqlite_classes: [...m.newSqliteClasses] }));
  if (!currentTag) return { payload: { new_tag: last.tag, steps: steps(0) }, foreign: false };
  const index = all.findIndex((m) => m.tag === currentTag);
  if (index === -1) return { payload: { old_tag: currentTag, new_tag: last.tag, steps: steps(0) }, foreign: true };
  if (index === all.length - 1) return { foreign: false };
  return { payload: { old_tag: currentTag, new_tag: last.tag, steps: steps(index + 1) }, foreign: false };
}

export interface WorkerMetadata {
  main_module: string;
  compatibility_date: string;
  bindings: (
    | { type: 'durable_object_namespace'; name: string; class_name: string }
    | { type: 'plain_text' | 'secret_text'; name: string; text: string }
  )[];
  /** 這次沒有帶的 secret（例如儀表板上另外設的 TURN Token）重新部署時保留 */
  keep_bindings: string[];
  observability: { enabled: boolean };
  migrations?: MigrationPayload;
}

export function buildWorkerMetadata(opts: {
  compatibilityDate: string;
  vars: Record<string, string>;
  /** Worker secret（SDK ADR 0118）：`secret_text` 綁定，取代線上同名的 secret */
  secrets?: Record<string, string>;
  migrations?: MigrationPayload;
}): WorkerMetadata {
  return {
    main_module: WORKER_ENTRY_MODULE,
    compatibility_date: opts.compatibilityDate,
    bindings: [
      ...RELAY_DO_BINDINGS.map((b) => ({ type: 'durable_object_namespace' as const, name: b.name, class_name: b.className })),
      ...Object.entries(opts.vars).map(([name, text]) => ({ type: 'plain_text' as const, name, text })),
      ...Object.entries(opts.secrets ?? {}).map(([name, text]) => ({ type: 'secret_text' as const, name, text })),
    ],
    keep_bindings: ['secret_text', 'secret_key'],
    observability: { enabled: true },
    ...(opts.migrations ? { migrations: opts.migrations } : {}),
  };
}

function randomBoundary(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `----cinderous${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 自己組 multipart/form-data 本文（Obsidian 的 `requestUrl` 不收 `FormData`）：
 * `metadata`（application/json）與每個 ES module（application/javascript+module）。
 */
export function buildMultipartBody(
  parts: { name: string; contentType: string; content: string; filename?: string }[],
  boundary: string = randomBoundary(),
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  for (const part of parts) {
    if (part.content.includes(boundary)) throw new Error('multipart 分隔字串與內容衝突，請重試');
  }
  const chunks = parts.map((part) => {
    const disposition = `form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}`;
    return `--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${part.contentType}\r\n\r\n${part.content}\r\n`;
  });
  const text = `${chunks.join('')}--${boundary}--\r\n`;
  return { body: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 部署一座 Cinderous 中繼到 Cloudflare Workers，全程走 REST API（可在 Obsidian 桌面與行動版執行）。
 * Worker 由呼叫端給（SDK ADR 0094）：只 import 這個函式不會把 117 KB 的 Worker 本體打包進去。
 * 要用 SDK 內嵌的那份就呼叫 `deployCloudflareRelayViaApi`。
 */
export async function deployCloudflareRelayWithWorker(
  opts: CloudflareApiDeployOptions & { workerSource: string },
): Promise<CloudflareApiDeployment> {
  const workerName = opts.workerName ?? DEFAULT_WORKER_NAME;
  assertRelayName(workerName, 'Worker 名稱');
  // 部署前先驗白名單與子網域名字：寫錯的名單部署上去，會是一座直接出錯的站
  const retired = retiredLane(opts);
  let readOnlyLanes: ReadOnlyLane[] = [...(opts.readOnlyLanes ?? []), ...(retired ? [retired] : [])];
  let vars = relayWorkerVars({ ...opts, ...(readOnlyLanes.length > 0 ? { readOnlyLanes } : {}) });
  const secrets = relayWorkerSecrets(opts);
  const compatibilityDate = opts.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
  assertCompatibilityDate(compatibilityDate);
  if (opts.workersDevSubdomain !== undefined) assertRelayName(opts.workersDevSubdomain, 'workers.dev 子網域');
  const progress: DeployProgress = opts.onProgress ?? (() => {});
  // 每個進度都帶子步驟 id 與雙語訊息（SDK ADR 0055）；`message` 照舊是中文
  const say = (step: DeployStep, substep: DeploySubstep, zh: string, en: string): void =>
    progress({ step, substep, message: zh, messages: { 'zh-TW': zh, en } });
  const http = opts.fetch ?? defaultHttp;
  const auth = { apiToken: opts.apiToken, fetch: http, ...(opts.apiBase ? { apiBase: opts.apiBase } : {}) };
  const ctx = { http, apiToken: opts.apiToken, ...(opts.apiBase ? { apiBase: opts.apiBase } : {}) };

  if (opts.credential === 'oauth') {
    if (opts.apiToken.trim() === '') throw new CloudflareApiError('token-invalid', 'OAuth access token 是空的');
  } else {
    say('config', 'verify-token', '驗證 Cloudflare API Token', 'Verifying the Cloudflare API token');
    await verifyToken(auth);
  }

  let accountId = opts.accountId;
  if (!accountId) {
    say('config', 'account', '查詢 Cloudflare 帳號', 'Looking up the Cloudflare account');
    const accounts = await listAccounts(auth);
    if (accounts.length === 0) {
      throw new CloudflareApiError('permission', '這把 Token 看不到任何帳號：建立 Token 時要把帳號加進「Account Resources」');
    }
    if (accounts.length > 1) {
      throw new CloudflareApiError('account-ambiguous', `這把 Token 能用 ${accounts.length} 個帳號，請指定要部署到哪一個`, { accounts });
    }
    accountId = accounts[0]!.id;
  }
  const account = `/accounts/${encodeURIComponent(accountId)}`;

  say('config', 'subdomain', '確認 workers.dev 子網域', 'Checking the workers.dev subdomain');
  const subdomain = await ensureSubdomain(ctx, account, opts.workersDevSubdomain);

  const scripts = await cloudflareRequest<{ id: string; migration_tag?: string }[]>(ctx, 'GET', `${account}/workers/scripts`);
  const existing = (scripts ?? []).find((script) => script.id === workerName);
  const plan = planMigrations(existing?.migration_tag);
  // 名稱被帳號裡另一支 Worker 佔用：它不是這個 SDK 部署的中繼（沒有遷移 tag，或 tag 不是我們的）
  if (existing && (plan.foreign || !existing.migration_tag) && !opts.replaceExisting) {
    throw new CloudflareApiError(
      'name-conflict',
      `帳號裡已經有一支叫「${workerName}」的 Worker，而且不是 Cinderous 中繼。換個名稱，或確認要覆蓋（replaceExisting）`,
    );
  }

  // 重新部署自己的中繼：已知租戶名單換了就是換 DO（SDK ADR 0036）。要明確同意才上傳。
  if (existing && existing.migration_tag && !plan.foreign) {
    say('config', 'live-config', '讀取線上的中繼設定', 'Reading the live relay settings');
    const live = await currentPlainTextVars(ctx, account, workerName, ['APP_LANES', 'LANES_ONLY', 'READONLY_LANES']);
    const current = { readable: live.readable, value: live.values.APP_LANES };
    const liveLanesOnly = lanesOnlyFrom(live.values.LANES_ONLY);
    const privateMode = vars.LANES_ONLY === '1' || liveLanesOnly;
    if (!current.readable) {
      say(
        'config',
        'live-config-skipped',
        '讀不到線上的設定，略過已知租戶名單的變更檢查',
        'Could not read the live settings; skipping the check for changes to the known app lanes',
      );
    } else if (privateMode && (!sameLaneList(current.value, vars.APP_LANES) || liveLanesOnly !== (vars.LANES_ONLY === '1')) && opts.allowLaneChange !== true) {
      // 私人路徑（SDK ADR 0051）：🔴 訊息不列任何車道 id——兩邊都是秘密，錯誤訊息會進畫面與記錄
      throw new CloudflareApiError(
        'lane-change',
        '私人路徑與線上的不同（或線上還不是私人路徑模式）：換了之後舊網址立刻失效，舊路徑上的資料留在原處等到期、不會搬過去；' +
          '其他裝置要改用新網址。確定要換請設 allowLaneChange，否則請帶同一個私人路徑重新部署',
      );
    } else if (!privateMode && !sameLaneList(current.value, vars.APP_LANES) && opts.allowLaneChange !== true) {
      const before = [...knownLanes(current.value)];
      const after = [...knownLanes(vars.APP_LANES)];
      const added = after.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !after.includes(id));
      throw new CloudflareApiError(
        'lane-change',
        `已知租戶名單（appLanes）與線上的不同${added.length ? `；新增 ${added.join(', ')}` : ''}${removed.length ? `；移除 ${removed.join(', ')}` : ''}。` +
          '名單改了＝那幾條車道換一顆 Durable Object，舊資料留在原處等到期、不會搬過去。確定要改請設 allowLaneChange，否則請帶同一份名單重新部署',
      );
    }
    // 唯讀寬限期（SDK ADR 0052）：線上還沒到期的保留（過期的、這次又變成可寫的清掉），不會因為重新部署弄丟
    const kept = current.readable ? keepLiveReadOnly(live.values.READONLY_LANES, readOnlyLanes, vars) : readOnlyLanes;
    if (kept !== readOnlyLanes) {
      readOnlyLanes = kept;
      vars = relayWorkerVars({ ...opts, readOnlyLanes });
    }
  }

  say('deploy', 'upload', `上傳 Worker「${workerName}」`, `Uploading the Worker "${workerName}"`);
  const metadata = buildWorkerMetadata({
    compatibilityDate,
    vars,
    secrets,
    ...(plan.payload ? { migrations: plan.payload } : {}),
  });
  const multipart = buildMultipartBody([
    { name: 'metadata', contentType: 'application/json', content: JSON.stringify(metadata) },
    {
      name: WORKER_ENTRY_MODULE,
      filename: WORKER_ENTRY_MODULE,
      contentType: 'application/javascript+module',
      content: renderApiWorkerEntry(opts.version ?? relayWorkerSdkVersion),
    },
    {
      name: WORKER_RELAY_MODULE,
      filename: WORKER_RELAY_MODULE,
      contentType: 'application/javascript+module',
      content: opts.workerSource,
    },
  ]);
  await cloudflareRequest(ctx, 'PUT', `${account}/workers/scripts/${encodeURIComponent(workerName)}`, {
    multipart: multipart.body,
    contentType: multipart.contentType,
  });

  say('deploy', 'route', '開啟 workers.dev 路由', 'Enabling the workers.dev route');
  await cloudflareRequest(ctx, 'POST', `${account}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {
    json: { enabled: true, previews_enabled: false },
  });

  const httpUrl = `https://${workerName}.${subdomain}.workers.dev`;
  // 新的 Worker（尤其是剛註冊的子網域）在邊緣上線要一段時間：重試，全部失敗才算失敗
  say('health', 'health', `檢查 ${httpUrl}/healthz`, `Checking ${httpUrl}/healthz`);
  try {
    await waitForHealthy(httpUrl, {
      fetch: (url) => http(url, { method: 'GET', headers: {} }),
      retries: opts.healthRetries ?? 20,
      ...(opts.healthDelayMs !== undefined ? { delayMs: opts.healthDelayMs } : {}),
    });
  } catch (error) {
    throw new CloudflareApiError('health', error instanceof Error ? error.message : String(error), { cause: error });
  }
  const baseEndpoint = httpUrl.replace(/^https:/, 'wss:');
  const privateLane = vars.LANES_ONLY === '1' ? opts.privateLane : undefined;
  const relayEndpoint = privateLane !== undefined ? privateLaneEndpoint(baseEndpoint, privateLane) : baseEndpoint;
  // 🔴 進度訊息不印私人路徑（它等同密碼；進度常被顯示在畫面或寫進記錄）
  if (privateLane !== undefined) say('done', 'done', `中繼站上線：${baseEndpoint}（私人路徑）`, `Relay is live: ${baseEndpoint} (private path)`);
  else say('done', 'done', `中繼站上線：${relayEndpoint}`, `Relay is live: ${relayEndpoint}`);
  return {
    workerName,
    accountId,
    subdomain,
    httpUrl,
    relayEndpoint,
    ...(privateLane !== undefined ? { privateLane } : {}),
    ...(vars.READONLY_LANES !== undefined
      ? { readOnlyLanes: [...readOnlyLanesFrom(vars.READONLY_LANES).lanes].map(([id, expiresAt]) => ({ id, expiresAt })) }
      : {}),
    migrationsApplied: plan.payload !== undefined,
  };
}

/**
 * `retireLane` → 一筆唯讀寬限期（SDK ADR 0052）。驗證在任何網路請求之前；🔴 訊息不回顯車道 id。
 */
/** `retireLane` 的檢查（部署時丟第一個、`collectCloudflareApiDeployIssues` 全部列出；同一份規則）。🔴 訊息不回顯 id */
function retireLaneIssues(opts: Pick<CloudflareApiDeployOptions, 'retireLane' | 'privateLane'>): DeployIssue[] {
  const retire = opts.retireLane;
  if (retire === undefined) return [];
  const issue = (code: string, zh: string, en: string): DeployIssue[] => [{ path: 'retireLane', code, severity: 'error', message: { 'zh-TW': zh, en } }];
  if (opts.privateLane === undefined) {
    return issue(
      'retire-needs-private-lane',
      'retireLane 要搭配 privateLane（新的私人路徑）：唯讀寬限期只給換了私人路徑之後的舊路徑',
      'retireLane needs privateLane (the new private path): the read-only grace period is only for the old path after switching private paths',
    );
  }
  const id = typeof retire.id === 'string' ? retire.id.trim() : '';
  if (!LANE_ID_PATTERN.test(id)) {
    return issue(
      'invalid-retire-lane',
      'retireLane.id 不是合法的車道 id：小寫英數起頭，其餘可含 . _ -，最長 64 字',
      'retireLane.id is not a valid lane id: start with a lowercase letter or digit, then letters, digits, . _ -, at most 64 characters',
    );
  }
  if (id === opts.privateLane) return issue('retire-lane-same', 'retireLane.id 與新的私人路徑相同：換路徑要用一個新的 id', 'retireLane.id is the same as the new private path: switching needs a new id');
  const days = retire.graceDays ?? READ_ONLY_GRACE_DAYS.default;
  if (!Number.isInteger(days) || days < READ_ONLY_GRACE_DAYS.min || days > READ_ONLY_GRACE_DAYS.max) {
    return issue(
      'invalid-grace-days',
      `retireLane.graceDays 必須是 ${READ_ONLY_GRACE_DAYS.min}–${READ_ONLY_GRACE_DAYS.max} 的整數，收到 ${String(days)}`,
      `retireLane.graceDays must be an integer from ${READ_ONLY_GRACE_DAYS.min} to ${READ_ONLY_GRACE_DAYS.max}, got ${String(days)}`,
    );
  }
  return [];
}

function retiredLane(opts: CloudflareApiDeployOptions): ReadOnlyLane | undefined {
  const retire = opts.retireLane;
  if (retire === undefined) return undefined;
  const first = retireLaneIssues(opts)[0];
  if (first) throw new Error(first.message['zh-TW']);
  const days = retire.graceDays ?? READ_ONLY_GRACE_DAYS.default;
  return { id: retire.id.trim(), expiresAt: Math.floor(Date.now() / 1000) + days * 86_400 };
}

/**
 * REST 部署之前一次列出所有問題（SDK ADR 0055；CinderSync G20）：Worker 名稱、workers.dev 子網域、相容日期、`retireLane`，
 * 再加上站台參數（`collectRelaySiteIssues(opts, 'worker')`），全部雙語、不丟例外。空陣列＝可以部署。
 * 規則與 `deployCloudflareRelayViaApi` 開頭的檢查相同（它丟第一個錯誤的中文訊息）。不檢查 Token 與帳號（那要連網）。
 */
export function collectCloudflareApiDeployIssues(opts: CloudflareApiDeployOptions): DeployIssue[] {
  const issues: DeployIssue[] = [];
  const push = (issue: DeployIssue | null) => {
    if (issue) issues.push(issue);
  };
  push(checkRelayName(opts.workerName ?? DEFAULT_WORKER_NAME, 'worker'));
  if (opts.workersDevSubdomain !== undefined) push(checkRelayName(opts.workersDevSubdomain, 'subdomain'));
  push(checkCompatibilityDate(opts.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE));
  issues.push(...retireLaneIssues(opts));
  issues.push(...collectRelaySiteIssues(opts, 'worker'));
  return issues;
}

/** REST 部署的子步驟（依出現順序；SDK ADR 0055） */
export const CLOUDFLARE_DEPLOY_SUBSTEPS: readonly DeploySubstep[] = ['verify-token', 'account', 'subdomain', 'live-config', 'live-config-skipped', 'upload', 'route', 'health', 'done'];

/**
 * 線上 `READONLY_LANES` 與這次的合併（SDK ADR 0052）：線上還沒到期、這次不是可寫的那幾條保留；同一條取較晚的到期；
 * 超過上限時留最晚到期的。沒有要加的回原本那份（同一個參照）。
 */
function keepLiveReadOnly(liveRaw: string | undefined, wanted: ReadOnlyLane[], vars: Record<string, string>): ReadOnlyLane[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const writable = knownLanes(vars.APP_LANES);
  const merged = new Map(wanted.map((lane) => [lane.id, lane.expiresAt]));
  let added = false;
  for (const [id, expiresAt] of readOnlyLanesFrom(liveRaw).lanes) {
    if (expiresAt <= nowSec || writable.has(id) || (merged.get(id) ?? 0) >= expiresAt) continue;
    merged.set(id, expiresAt);
    added = true;
  }
  if (!added) return wanted;
  return [...merged]
    .map(([id, expiresAt]) => ({ id, expiresAt }))
    .sort((a, b) => b.expiresAt - a.expiresAt)
    .slice(0, READONLY_LANES_MAX);
}

/**
 * 讀線上 Worker 的幾個 plain text 環境變數（`GET …/workers/scripts/{name}/settings`，一次請求）。
 * 讀不到（權限、網路、格式）時回 `readable: false`，由呼叫端決定要不要擋——這只是保護，不該讓部署失敗。
 */
async function currentPlainTextVars(
  ctx: { http: HttpFetch; apiToken: string; apiBase?: string },
  account: string,
  workerName: string,
  names: readonly string[],
): Promise<{ readable: boolean; values: Record<string, string | undefined> }> {
  try {
    const settings = await cloudflareRequest<{ bindings?: { type?: string; name?: string; text?: string }[] }>(
      ctx,
      'GET',
      `${account}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    );
    if (!settings || !Array.isArray(settings.bindings)) return { readable: false, values: {} };
    const values: Record<string, string | undefined> = {};
    for (const name of names) {
      values[name] = settings.bindings.find((b) => b.type === 'plain_text' && b.name === name)?.text;
    }
    return { readable: true, values };
  } catch {
    return { readable: false, values: {} };
  }
}

/** 回傳帳號的 workers.dev 子網域；沒有時用呼叫端給的名字註冊。 */
async function ensureSubdomain(
  ctx: { http: HttpFetch; apiToken: string; apiBase?: string },
  account: string,
  wanted: string | undefined,
): Promise<string> {
  try {
    const { subdomain } = await cloudflareRequest<{ subdomain: string }>(ctx, 'GET', `${account}/workers/subdomain`);
    if (subdomain) return subdomain;
  } catch (error) {
    // 10007：帳號還沒有 workers.dev 子網域（wrangler 也是這樣判斷）
    if (!(error instanceof CloudflareApiError) || !error.codes.includes(10007)) throw error;
  }
  if (!wanted) {
    throw new CloudflareApiError('subdomain-missing', '這個帳號還沒有 workers.dev 子網域：請取一個名字（workersDevSubdomain）');
  }
  const { subdomain } = await cloudflareRequest<{ subdomain: string }>(ctx, 'PUT', `${account}/workers/subdomain`, {
    json: { subdomain: wanted },
  });
  return subdomain ?? wanted;
}
