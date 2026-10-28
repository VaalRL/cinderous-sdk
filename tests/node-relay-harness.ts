// 測試用：開一台 Node 中繼並等它開始監聽（SDK ADR 0114）。
// 一律用 `PORT: '0'` 讓系統分配埠：固定範圍的隨機埠會撞到別的測試或 Linux 的臨時埠（CI 上出現過 EADDRINUSE）。
import type { NodeRelayHandle } from '../src/relay/node-relay.js';

/** 把中繼登記進 `handles`（afterEach 關站用），回傳實際的埠 */
export function opened(handles: { close(): void }[], relay: NodeRelayHandle): Promise<number> {
  handles.push(relay);
  return relay.ready;
}
