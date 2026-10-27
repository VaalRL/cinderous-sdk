// 用 SDK 內嵌的中繼 Worker 部署（SDK ADR 0021 的原介面）。單獨一個模組（SDK ADR 0094）：
// 只 import `deployCloudflareRelayWithWorker` 的程式不會連帶打包 117 KB 的 Worker 本體。
import { deployCloudflareRelayWithWorker } from './deploy.js';
import { relayWorkerSource } from './relay-worker-bundle.js';
/** 部署一座 Cinderous 中繼到 Cloudflare Workers；沒給 `workerSource` 就用打包在 SDK 裡的那份 */
export function deployCloudflareRelayViaApi(opts) {
    return deployCloudflareRelayWithWorker({ ...opts, workerSource: opts.workerSource ?? relayWorkerSource });
}
//# sourceMappingURL=deploy-embedded.js.map