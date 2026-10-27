// 中繼分片的共享計算原語（ADR-0241）：**客戶端與伺服端必須算出同一個分片**，否則訊息會被路由到
// 錯的 DO 而消失。故分片鍵的計算放 core（SSOT），由 relay（server 路由）與 engine（client 連線/發布）
// 共用——server 的 `shardNameForPath` 與 client 連的 `shardPath` 都以此 `shardPrefix` 為準。
//
// 分片鍵＝收件人 pubkey 高 nibble（16 片）。收件匣天然同片；跨分片路由由 pubkey 直接算（免 hint）。

/** 訊息分片數（ADR-0241）：按收件人 pubkey 高 nibble 取 16 片。血條 1/16。 */
export const SHARD_COUNT = 16;

/** 收件人 pubkey → 分片前綴（單一 hex nibble `0`–`f`）。非法/空 → `"0"`（安全預設，不丟事件）。 */
export function shardPrefix(pubkey: string | undefined): string {
  const c = pubkey?.[0]?.toLowerCase();
  return c !== undefined && /^[0-9a-f]$/.test(c) ? c : "0";
}

/** 客戶端連某 pubkey 訊息片的 URL 路徑（ADR-0241）：`/s/<prefix>`。自己片＝`shardPath(自己pubkey)`。 */
export function shardPath(pubkey: string | undefined): string {
  return `/s/${shardPrefix(pubkey)}`;
}

/** presence 獨立層的 URL 路徑（ADR-0241）：多對多廣播、不進訊息分片。 */
export const PRESENCE_PATH = "/presence";
