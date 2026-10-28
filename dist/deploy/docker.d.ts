import { type CommandRunner, type DeployProgress, type RelayDeployment } from './common.js';
import { type RelaySiteOptions, type RelayWorkerSecrets } from './shared.js';
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
export interface DockerDeployOptions extends RelaySiteOptions, Pick<RelayWorkerSecrets, 'iotGatewayKeys'> {
    /** compose 專案與容器名稱；預設 cinderous-relay */
    name?: string;
    /** 對外的埠（對應容器的 8080）；預設 8080 */
    port?: number;
    /** 寫 SQLite 到 named volume；預設純記憶體 */
    persist?: boolean;
    /** 前面有反向代理時設 true */
    trustProxy?: boolean;
    /**
     * 只把埠發布在這個 IP（SDK ADR 0119）。沒給時，`trustProxy` 就是 `127.0.0.1`（反向代理在同一台；Docker 發布的埠會繞過 ufw），
     * 否則所有網卡。Tunnel 模式不發布埠，用不到。
     */
    bindAddress?: string;
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
export declare function deployDockerRelay(opts?: DockerDeployOptions): Promise<RelayDeployment>;
//# sourceMappingURL=docker.d.ts.map