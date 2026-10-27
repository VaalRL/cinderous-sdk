// `cinderous relay deploy --provider=fly`（SDK ADR 0018）：用 flyctl 部署到 Fly.io。
//
// - 只跑一台（`--ha=false`）：純記憶體或單一 SQLite 檔的中繼沒辦法多台共享狀態。
// - 不自動停機（`auto_stop_machines = "off"`）：WebSocket 長連線，停機就斷。
// - Fly 的邊緣會代理連線，所以信任 X-Forwarded-For（`TRUST_PROXY=1`），IP 限速才看得到真正的來源。
// - 保存模式的 volume 只在不存在時建立：重複建會多一顆、多付錢。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { allowedPubkeysFrom } from '../relay/host-config.js';
import {
  assertRelayName,
  type CommandRunner,
  commandFailure,
  defaultRunner,
  type DeployProgress,
  type RelayDeployment,
  waitForHealthy,
} from './common.js';
import { prepareNodeRelayContext } from './container.js';
import { DEFAULT_FLY_REGION, FLY_VOLUME_NAME as VOLUME_NAME, relayEnvironment, renderFlyToml } from './render.js';

// 產生器搬到不碰 Node 的 render.ts（SDK ADR 0050），這裡轉出以維持原本的匯出
export { DEFAULT_FLY_REGION, renderFlyToml } from './render.js';
import { privateLaneEndpoint, type RelaySiteOptions } from './shared.js';


/**
 * 站台參數（白名單、站名、防濫用、保存期、檔案塊……）見 `RelaySiteOptions`（SDK ADR 0036、0037）；
 * 只有 Cloudflare 版支援的參數（`appLanes` 等）在這裡會丟例外——Node 主機沒有車道。
 */
export interface FlyDeployOptions extends RelaySiteOptions {
  /** Fly app 名稱，也是 `<名稱>.fly.dev`；預設 cinderous-relay */
  name?: string;
  region?: string;
  persist?: boolean;
  /** Fly API token；沒給就用 flyctl 自己的登入狀態（`fly auth login`） */
  apiToken?: string;
  workDir?: string;
  dryRun?: boolean;
  onProgress?: DeployProgress;
  run?: CommandRunner;
  fetch?: typeof fetch;
  sdkRoot?: string;
  version?: string;
  healthRetries?: number;
  healthDelayMs?: number;
}

export async function deployFlyRelay(opts: FlyDeployOptions = {}): Promise<RelayDeployment> {
  const name = opts.name ?? 'cinderous-relay';
  assertRelayName(name, 'Fly app 名稱');
  const region = opts.region ?? DEFAULT_FLY_REGION;
  if (!/^[a-z]{3}$/.test(region)) throw new Error(`Fly 區域代碼不合法：${region}（例如 nrt、sin、iad）`);
  const allowed = allowedPubkeysFrom((opts.allowedPubkeys ?? []).join(','));
  const persist = opts.persist === true;
  const progress = opts.onProgress ?? (() => {});
  const run = opts.run ?? defaultRunner;
  const env: Record<string, string | undefined> = opts.apiToken ? { FLY_API_TOKEN: opts.apiToken } : {};

  // 先驗證站台參數再寫任何檔案（SDK ADR 0036）
  const environment = relayEnvironment({ ...opts, ...(allowed ? { allowedPubkeys: allowed } : {}), persist, trustProxy: true });
  const workDir = opts.workDir ?? join(process.cwd(), '.cinderous', name);
  prepareNodeRelayContext({ workDir, ...(opts.sdkRoot ? { sdkRoot: opts.sdkRoot } : {}), ...(opts.version ? { version: opts.version } : {}) });
  const configPath = join(workDir, 'fly.toml');
  writeFileSync(configPath, renderFlyToml({ name, region, environment, persist }));
  progress({ step: 'config', message: `已寫出 ${configPath}` });
  if (opts.dryRun) return { name, configPath };

  progress({ step: 'deploy', message: '以 flyctl 建立 app 並部署' });
  const created = await run('fly', ['apps', 'create', name], env);
  // 已經存在不算失敗：重新部署同一個 app 是正常情況
  if (created.code !== 0 && !/already (been )?taken|already exists/i.test(`${created.stdout}\n${created.stderr}`)) {
    throw commandFailure('fly apps create', created);
  }

  if (persist) {
    const listed = await run('fly', ['volumes', 'list', '--app', name, '--json'], env);
    if (listed.code !== 0) throw commandFailure('fly volumes list', listed);
    let volumes: { name?: string }[] = [];
    try {
      volumes = JSON.parse(listed.stdout || '[]') as { name?: string }[];
    } catch {
      throw new Error('fly volumes list 的輸出不是 JSON，無法判斷 volume 是否已存在；為免重複建立（會多付錢），先停在這裡');
    }
    if (!volumes.some((v) => v.name === VOLUME_NAME)) {
      const createdVolume = await run('fly', ['volumes', 'create', VOLUME_NAME, '--app', name, '--region', region, '--size', '1', '--yes'], env);
      if (createdVolume.code !== 0) throw commandFailure('fly volumes create', createdVolume);
    }
  }

  const deployed = await run('fly', ['deploy', '--config', configPath, '--app', name, '--remote-only', '--ha=false'], env);
  if (deployed.code !== 0) throw commandFailure('fly deploy', deployed);

  const httpUrl = `https://${name}.fly.dev`;
  progress({ step: 'health', message: `檢查 ${httpUrl}/healthz` });
  await waitForHealthy(httpUrl, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.healthRetries !== undefined ? { retries: opts.healthRetries } : {}),
    ...(opts.healthDelayMs !== undefined ? { delayMs: opts.healthDelayMs } : {}),
  });
  const base = `wss://${name}.fly.dev`;
  // 私人路徑（SDK ADR 0051）：給客戶端的是含秘密路徑的完整網址；進度訊息只印主機
  const relayEndpoint = opts.privateLane !== undefined ? privateLaneEndpoint(base, opts.privateLane) : base;
  progress({ step: 'done', message: `中繼站上線：${base}${opts.privateLane !== undefined ? '（私人路徑）' : ''}` });
  return { name, configPath, httpUrl, relayEndpoint };
}
