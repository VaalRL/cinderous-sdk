// `@cinderous/client/deploy`：把 SDK 的中繼一鍵部署到 Cloudflare Workers（PRD 5.3；SDK ADR 0008）。
//
// 做法：在工作目錄寫出一份 `wrangler.toml` 與一支入口檔（注入版號後轉出 SDK 的 Worker），
// 再交給 `npx wrangler@4 deploy`。登入、建 Durable Object、上傳都由 wrangler 負責——
// 我們不自己打 Cloudflare API，免得和 wrangler 的行為分岔。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandFailure, defaultRunner, sdkVersion, } from './common.js';
import { assertCompatibilityDate, assertRelayName, DEFAULT_COMPATIBILITY_DATE, DEFAULT_WORKER_NAME, privateLaneEndpoint, relayWorkerSecrets, relayWorkerVars, waitForHealthy, } from './shared.js';
import { renderWorkerEntry, renderWranglerToml } from './render.js';
import { allowedPubkeysFrom } from '../relay/host-config.js';
export { DEFAULT_COMPATIBILITY_DATE, DEFAULT_WORKER_NAME } from './shared.js';
// 產生器搬到不碰 Node 的 render.ts（SDK ADR 0050），這裡轉出以維持原本的匯出
export { renderWorkerEntry, renderWranglerToml } from './render.js';
export { defaultRunner } from './common.js';
/** 從 `wrangler deploy` 的輸出抓出 workers.dev 網址。 */
export function workersDevUrlFrom(output) {
    return /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(output)?.[0];
}
/** 部署一座 Cinderous 中繼到 Cloudflare Workers（PRD 5.3.4 的程式化 API）。 */
export async function deployCloudflareRelay(opts = {}) {
    const workerName = opts.workerName ?? DEFAULT_WORKER_NAME;
    assertRelayName(workerName, 'Worker 名稱');
    // 部署前先驗白名單與所有站台參數：寫錯的名單部署上去，會是一座直接出錯的站（見 allowedPubkeysFrom）。
    const allowed = allowedPubkeysFrom((opts.allowedPubkeys ?? []).join(','));
    relayWorkerVars(opts);
    const secrets = relayWorkerSecrets(opts);
    const compatibilityDate = opts.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
    assertCompatibilityDate(compatibilityDate);
    const progress = opts.onProgress ?? (() => { });
    const workDir = opts.workDir ?? join(process.cwd(), '.cinderous', workerName);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, 'wrangler.toml');
    writeFileSync(join(workDir, 'entry.mjs'), renderWorkerEntry({
        sdkDistDir: opts.sdkDistDir ?? fileURLToPath(new URL('..', import.meta.url)),
        version: opts.version ?? sdkVersion(),
    }));
    writeFileSync(configPath, renderWranglerToml({
        name: workerName,
        main: 'entry.mjs',
        ...opts,
        compatibilityDate,
        ...(allowed ? { allowedPubkeys: allowed } : {}),
    }));
    progress({ step: 'config', message: `已寫出 ${configPath}` });
    const env = {};
    if (opts.apiToken)
        env.CLOUDFLARE_API_TOKEN = opts.apiToken;
    if (opts.accountId)
        env.CLOUDFLARE_ACCOUNT_ID = opts.accountId;
    const args = ['wrangler@4', 'deploy', '--config', configPath, ...(opts.dryRun ? ['--dry-run'] : [])];
    progress({ step: 'deploy', message: opts.dryRun ? '以 wrangler 試打包（不上傳）' : '以 wrangler 部署到 Cloudflare' });
    const result = await (opts.run ?? defaultRunner)('npx', args, env);
    if (result.code !== 0)
        throw commandFailure('wrangler 部署', result);
    if (opts.dryRun)
        return { workerName, configPath };
    // Worker secret（SDK ADR 0118）：值從 stdin 給 wrangler，不進參數、環境變數與任何檔案
    for (const [name, value] of Object.entries(secrets)) {
        progress({ step: 'deploy', message: `以 wrangler 設定 Worker secret ${name}` });
        const put = await (opts.run ?? defaultRunner)('npx', ['wrangler@4', 'secret', 'put', name, '--config', configPath], env, value);
        if (put.code !== 0)
            throw commandFailure(`wrangler secret put ${name}`, put);
    }
    const httpUrl = workersDevUrlFrom(`${result.stdout}\n${result.stderr}`);
    if (!httpUrl) {
        throw new Error('wrangler 回報成功，但輸出裡找不到 workers.dev 網址：這個帳號可能停用了 workers.dev 子網域，請到儀表板確認路由');
    }
    // 新的 Worker 在邊緣節點上線要幾秒鐘：重試幾次，全部失敗才算失敗——絕不能在沒驗到的情況下回報成功。
    progress({ step: 'health', message: `檢查 ${httpUrl}/healthz` });
    await waitForHealthy(httpUrl, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.healthRetries !== undefined ? { retries: opts.healthRetries } : {}),
        ...(opts.healthDelayMs !== undefined ? { delayMs: opts.healthDelayMs } : {}),
    });
    const base = httpUrl.replace(/^https:/, 'wss:');
    // 私人路徑（SDK ADR 0051）：給客戶端的是含秘密路徑的完整網址；進度訊息只印主機
    const relayEndpoint = opts.privateLane !== undefined ? privateLaneEndpoint(base, opts.privateLane) : base;
    progress({ step: 'done', message: `中繼站上線：${base}${opts.privateLane !== undefined ? '（私人路徑）' : ''}` });
    return { workerName, configPath, httpUrl, relayEndpoint };
}
//# sourceMappingURL=cloudflare.js.map