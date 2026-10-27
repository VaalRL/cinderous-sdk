import { type CloudflareApiDeployment, type CloudflareApiDeployOptions } from './deploy.js';
/** 部署一座 Cinderous 中繼到 Cloudflare Workers；沒給 `workerSource` 就用打包在 SDK 裡的那份 */
export declare function deployCloudflareRelayViaApi(opts: CloudflareApiDeployOptions): Promise<CloudflareApiDeployment>;
//# sourceMappingURL=deploy-embedded.d.ts.map