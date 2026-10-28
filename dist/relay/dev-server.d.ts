import type { NodeRelayHandle } from "./node-relay.js";
/**
 * 本機開發用的真實 Nostr relay：以 `ws` 包住與生產同一套 `RelayCore`。
 * 供兩個瀏覽器分頁/客戶端經真實 WebSocket 對話（Cloudflare 部署見 worker.ts）。
 *
 * 用法：`pnpm --filter @cinderous/relay build:dev && pnpm --filter @cinderous/relay dev`
 */
/** 啟動本機開發用的純記憶體中繼（SDK ADR 0007：原本是腳本，改成可呼叫的函式）。 */
export declare function startDevRelay(port?: number): NodeRelayHandle;
//# sourceMappingURL=dev-server.d.ts.map