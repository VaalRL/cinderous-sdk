/**
 * `@cinderous/client/transfer`（SDK ADR 0015、0023、0026）：檔案傳輸與續傳、「等 P2P 才送」的佇列，
 * 以及批次串流（多檔一條串流、大檔寫進注入的儲存、續傳、背壓）與可持久化的佇列。
 *
 * 跑在任何位元組通道（`ByteChannel`，例如 `PeerChannel` 或 `SecureChannel`）上，網路與儲存一律注入。
 * 主入口 `@cinderous/client` 轉出 `FileTransfer`／`P2PFileQueue` 那一批（同一個實作）；
 * 批次串流（ADR 0026）只在這個子路徑，主入口的打包大小不變。
 */
export * from './file-transfer.js';
export * from './p2p-queue.js';
export * from './stream.js';
export * from './stream-queue.js';
//# sourceMappingURL=index.d.ts.map