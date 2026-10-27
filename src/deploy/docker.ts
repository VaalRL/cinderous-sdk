// `cinderous relay deploy --provider=docker`（SDK ADR 0018）：在這台機器上用 docker compose 起一座中繼。
//
// 對外公開時請在前面放 TLS 反向代理（例如 Caddy），客戶端才連得到 `wss://`；
// 代理後方請加 `TRUST_PROXY=1`，IP 限速才會用到真正的來源位址。
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
import { DEFAULT_DOCKER_PORT, relayEnvironment, renderCompose } from './render.js';
import { privateLaneEndpoint, type RelaySiteOptions } from './shared.js';

// 產生器搬到不碰 Node 的 render.ts（SDK ADR 0050），這裡轉出以維持原本的匯出
export { DEFAULT_DOCKER_PORT, renderCompose } from './render.js';

/**
 * 家中主機＋Cloudflare Tunnel（SDK ADR 0050 §5 的 `home-tunnel`）：relay 不發布埠，同一個 compose 裡的 cloudflared
 * 以 Tunnel Token 對外；健康檢查打 `https://<hostname>/healthz`，端點是 `wss://<hostname>`。
 */
export interface DockerTunnelOptions {
  /** Cloudflare 上設定的公開主機名稱 */
  hostname: string;
  /** compose 代入 Token 的環境變數名稱（設定檔 `secrets.tunnelToken.$env`） */
  tokenEnv: string;
  /** Token 的值：只交給 docker compose 的環境，不寫進任何檔案。沒給＝交給既有的環境變數 */
  token?: string;
  /** cloudflared 映像 */
  image?: string;
}

/**
 * 站台參數（白名單、站名、防濫用、保存期、檔案塊……）見 `RelaySiteOptions`（SDK ADR 0036、0037）；
 * 只有 Cloudflare 版支援的參數（`appLanes` 等）在這裡會丟例外——Node 主機沒有車道。
 */
export interface DockerDeployOptions extends RelaySiteOptions {
  /** compose 專案與容器名稱；預設 cinderous-relay */
  name?: string;
  /** 對外的埠（對應容器的 8080）；預設 8080 */
  port?: number;
  /** 寫 SQLite 到 named volume；預設純記憶體 */
  persist?: boolean;
  /** 前面有反向代理時設 true */
  trustProxy?: boolean;
  /** 家中主機＋Cloudflare Tunnel：給了就不發布埠、強制 `TRUST_PROXY=1`（SDK ADR 0050） */
  tunnel?: DockerTunnelOptions;
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

export async function deployDockerRelay(opts: DockerDeployOptions = {}): Promise<RelayDeployment> {
  const name = opts.name ?? 'cinderous-relay';
  assertRelayName(name);
  const port = opts.port ?? DEFAULT_DOCKER_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`埠號不合法：${port}`);
  const tunnel = opts.tunnel;
  if (tunnel && !/^[a-z0-9.-]+$/.test(tunnel.hostname)) throw new Error(`Tunnel 主機名稱不合法：${tunnel.hostname}`);
  const allowed = allowedPubkeysFrom((opts.allowedPubkeys ?? []).join(','));
  const progress = opts.onProgress ?? (() => {});

  // 先驗證站台參數再寫任何檔案（SDK ADR 0036）
  const environment = relayEnvironment({
    ...opts,
    ...(allowed ? { allowedPubkeys: allowed } : {}),
    persist: opts.persist === true,
    // Tunnel 模式所有連線都經過 cloudflared：一定要信 X-Forwarded-For，IP 限速才不會把所有人算成同一個來源
    trustProxy: opts.trustProxy === true || tunnel !== undefined,
  });
  const workDir = opts.workDir ?? join(process.cwd(), '.cinderous', name);
  prepareNodeRelayContext({ workDir, ...(opts.sdkRoot ? { sdkRoot: opts.sdkRoot } : {}), ...(opts.version ? { version: opts.version } : {}) });
  const configPath = join(workDir, 'docker-compose.yml');
  writeFileSync(
    configPath,
    renderCompose({
      name,
      port,
      environment,
      ...(tunnel ? { tunnel: { tokenEnv: tunnel.tokenEnv, ...(tunnel.image !== undefined ? { image: tunnel.image } : {}) } } : {}),
    }),
  );
  progress({ step: 'config', message: `已寫出 ${configPath}` });
  if (opts.dryRun) return { name, configPath };

  progress({ step: 'deploy', message: '以 docker compose 建置並啟動' });
  // Token 只放進 docker compose 的環境（compose 以它代入 cloudflared 的 TUNNEL_TOKEN），不寫檔
  const runEnv: Record<string, string | undefined> = tunnel?.token !== undefined ? { [tunnel.tokenEnv]: tunnel.token } : {};
  const result = await (opts.run ?? defaultRunner)('docker', ['compose', '-f', configPath, '-p', name, 'up', '-d', '--build'], runEnv);
  if (result.code !== 0) throw commandFailure('docker compose', result);

  const httpUrl = tunnel ? `https://${tunnel.hostname}` : `http://localhost:${port}`;
  progress({ step: 'health', message: `檢查 ${httpUrl}/healthz` });
  await waitForHealthy(httpUrl, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.healthRetries !== undefined ? { retries: opts.healthRetries } : {}),
    ...(opts.healthDelayMs !== undefined ? { delayMs: opts.healthDelayMs } : {}),
  });
  const base = tunnel ? `wss://${tunnel.hostname}` : `ws://localhost:${port}`;
  // 私人路徑（SDK ADR 0051）：給客戶端的是含秘密路徑的完整網址；進度訊息只印主機
  const relayEndpoint = opts.privateLane !== undefined ? privateLaneEndpoint(base, opts.privateLane) : base;
  const shown = `${base}${opts.privateLane !== undefined ? '（私人路徑）' : ''}`;
  progress({ step: 'done', message: tunnel ? `中繼站上線：${shown}` : `中繼站上線：${shown}（對外公開請在前面放 TLS 反向代理）` });
  return { name, configPath, httpUrl, relayEndpoint };
}
