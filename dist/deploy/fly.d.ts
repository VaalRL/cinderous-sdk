import { type CommandRunner, type DeployProgress, type RelayDeployment } from './common.js';
export { DEFAULT_FLY_REGION, renderFlyToml } from './render.js';
import { type RelaySiteOptions } from './shared.js';
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
export declare function deployFlyRelay(opts?: FlyDeployOptions): Promise<RelayDeployment>;
//# sourceMappingURL=fly.d.ts.map