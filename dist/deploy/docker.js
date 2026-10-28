// `cinderous relay deploy --provider=docker`（SDK ADR 0018）：在這台機器上用 docker compose 起一座中繼。
//
// 對外公開時請在前面放 TLS 反向代理（例如 Caddy），客戶端才連得到 `wss://`；
// 代理後方請加 `TRUST_PROXY=1`，IP 限速才會用到真正的來源位址。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPubkeysFrom } from '../relay/host-config.js';
import { assertRelayName, commandFailure, defaultRunner, waitForHealthy, } from './common.js';
import { prepareNodeRelayContext } from './container.js';
import { BIND_ADDRESS_PATTERN, composeBindAddress, DEFAULT_DOCKER_PORT, relayEnvironment, renderCompose, WILDCARD_BIND_ADDRESSES } from './render.js';
import { privateLaneEndpoint } from './shared.js';
// 產生器搬到不碰 Node 的 render.ts（SDK ADR 0050），這裡轉出以維持原本的匯出
export { DEFAULT_DOCKER_PORT, renderCompose } from './render.js';
export async function deployDockerRelay(opts = {}) {
    const name = opts.name ?? 'cinderous-relay';
    assertRelayName(name);
    const port = opts.port ?? DEFAULT_DOCKER_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error(`埠號不合法：${port}`);
    const tunnel = opts.tunnel;
    if (tunnel && !/^[a-z0-9.-]+$/.test(tunnel.hostname))
        throw new Error(`Tunnel 主機名稱不合法：${tunnel.hostname}`);
    if (opts.bindAddress !== undefined && !BIND_ADDRESS_PATTERN.test(opts.bindAddress)) {
        throw new Error(`bindAddress 不是 IP 位址：${opts.bindAddress}（例如 127.0.0.1，或 IPv6 的 ::1，不加方括號）`);
    }
    const trustProxy = opts.trustProxy === true || tunnel !== undefined;
    const bind = tunnel ? undefined : composeBindAddress(opts.bindAddress, trustProxy);
    const allowed = allowedPubkeysFrom((opts.allowedPubkeys ?? []).join(','));
    const progress = opts.onProgress ?? (() => { });
    // 先驗證站台參數再寫任何檔案（SDK ADR 0036）
    const environment = relayEnvironment({
        ...opts,
        ...(allowed ? { allowedPubkeys: allowed } : {}),
        persist: opts.persist === true,
        // Tunnel 模式所有連線都經過 cloudflared：一定要信 X-Forwarded-For，IP 限速才不會把所有人算成同一個來源
        trustProxy,
    });
    const workDir = opts.workDir ?? join(process.cwd(), '.cinderous', name);
    prepareNodeRelayContext({ workDir, ...(opts.sdkRoot ? { sdkRoot: opts.sdkRoot } : {}), ...(opts.version ? { version: opts.version } : {}) });
    const configPath = join(workDir, 'docker-compose.yml');
    writeFileSync(configPath, renderCompose({
        name,
        port,
        environment,
        ...(bind !== undefined ? { bindAddress: bind } : {}),
        ...(tunnel ? { tunnel: { tokenEnv: tunnel.tokenEnv, ...(tunnel.image !== undefined ? { image: tunnel.image } : {}) } } : {}),
    }));
    progress({ step: 'config', message: `已寫出 ${configPath}` });
    if (opts.dryRun)
        return { name, configPath };
    progress({ step: 'deploy', message: '以 docker compose 建置並啟動' });
    // Token 只放進 docker compose 的環境（compose 以它代入 cloudflared 的 TUNNEL_TOKEN），不寫檔
    const runEnv = tunnel?.token !== undefined ? { [tunnel.tokenEnv]: tunnel.token } : {};
    const result = await (opts.run ?? defaultRunner)('docker', ['compose', '-f', configPath, '-p', name, 'up', '-d', '--build'], runEnv);
    if (result.code !== 0)
        throw commandFailure('docker compose', result);
    // 只發布在某個位址時，健康檢查要打那個位址（localhost 不一定連得到）
    const local = bind === undefined || WILDCARD_BIND_ADDRESSES.includes(bind) ? 'localhost' : bind.includes(':') ? `[${bind}]` : bind;
    const httpUrl = tunnel ? `https://${tunnel.hostname}` : `http://${local}:${port}`;
    progress({ step: 'health', message: `檢查 ${httpUrl}/healthz` });
    await waitForHealthy(httpUrl, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.healthRetries !== undefined ? { retries: opts.healthRetries } : {}),
        ...(opts.healthDelayMs !== undefined ? { delayMs: opts.healthDelayMs } : {}),
    });
    const base = tunnel ? `wss://${tunnel.hostname}` : `ws://${local}:${port}`;
    // 私人路徑（SDK ADR 0051）：給客戶端的是含秘密路徑的完整網址；進度訊息只印主機
    const relayEndpoint = opts.privateLane !== undefined ? privateLaneEndpoint(base, opts.privateLane) : base;
    const shown = `${base}${opts.privateLane !== undefined ? '（私人路徑）' : ''}`;
    progress({ step: 'done', message: tunnel ? `中繼站上線：${shown}` : `中繼站上線：${shown}（對外公開請在前面放 TLS 反向代理）` });
    return { name, configPath, httpUrl, relayEndpoint };
}
//# sourceMappingURL=docker.js.map