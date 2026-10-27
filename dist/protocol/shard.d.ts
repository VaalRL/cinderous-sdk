/** 訊息分片數（ADR-0241）：按收件人 pubkey 高 nibble 取 16 片。血條 1/16。 */
export declare const SHARD_COUNT = 16;
/** 收件人 pubkey → 分片前綴（單一 hex nibble `0`–`f`）。非法/空 → `"0"`（安全預設，不丟事件）。 */
export declare function shardPrefix(pubkey: string | undefined): string;
/** 客戶端連某 pubkey 訊息片的 URL 路徑（ADR-0241）：`/s/<prefix>`。自己片＝`shardPath(自己pubkey)`。 */
export declare function shardPath(pubkey: string | undefined): string;
/** presence 獨立層的 URL 路徑（ADR-0241）：多對多廣播、不進訊息分片。 */
export declare const PRESENCE_PATH = "/presence";
//# sourceMappingURL=shard.d.ts.map