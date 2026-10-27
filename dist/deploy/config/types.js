/** 設定檔 schema 的版號。改版時以逐版的純函式遷移（`config migrate`，P1）。 */
export const DEPLOY_CONFIG_VERSION = 1;
/**
 * 部署目標（SDK ADR 0050 §3、§5）：
 * - `cloudflare`：Cloudflare Workers，以 wrangler 部署；
 * - `cloudflare-api`：Cloudflare Workers，以 REST API 部署（外掛用；CLI 的 `relay deploy --config` 在 P1 才接上）；
 * - `docker`：這台機器的 docker compose；
 * - `fly`：Fly.io；
 * - `home-tunnel`：家中主機＋Cloudflare Tunnel（relay 不發布埠，`cloudflared` 對外）。
 */
export const DEPLOY_TARGETS = ['cloudflare', 'cloudflare-api', 'docker', 'fly', 'home-tunnel'];
/**
 * 部署的服務（SDK ADR 0050；ADR 0049 §11.1 裁示 5、7）：
 * - `relay`（預設）：Cinderous 中繼；
 * - `push-gateway`：App 開發者的參考推播閘道（FCM／APNs 憑證只在這裡）。Workers 目標＝Workers 版，
 *   Node 目標（docker、fly、home-tunnel）＝Node 版；兩版的 iOS 都能直連 APNs（SDK ADR 0061）。
 */
export const DEPLOY_SERVICES = ['relay', 'push-gateway'];
/** 設定檔的服務（沒寫＝`relay`） */
export function serviceOfConfig(config) {
    return config.service === 'push-gateway' ? 'push-gateway' : 'relay';
}
export function hostOfTarget(target) {
    return target === 'cloudflare' || target === 'cloudflare-api' ? 'worker' : 'node';
}
export function isSecretRef(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.$env === 'string';
}
//# sourceMappingURL=types.js.map