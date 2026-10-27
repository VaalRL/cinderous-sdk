import type { NostrEvent } from "../protocol/event.js";
import type { SecretKeyOrSigner } from "../protocol/signer.js";
/** 快照事件 kind（NIP-78 應用資料，位於 NIP-33 可尋址範圍）。 */
export declare const SNAPSHOT_KIND = 30078;
/** 快照壽命：30 天＋每次備份刷新（對齊 relay 端上限，ADR-0071）。 */
export declare const SNAPSHOT_TTL_SECONDS: number;
/** 打包快照事件：明文 NIP-44 加密給自己、`d`＝裝置 id、expiration＝now＋30 天。 */
export declare function buildSnapshotEvent(plaintext: string, sk: SecretKeyOrSigner, deviceId: string, opts?: {
    now?: number;
}): NostrEvent;
/** 打包 purge 事件（content 空）：關閉備份時清除 relay 上此裝置的快照（ADR-0071）。 */
export declare function buildSnapshotPurge(sk: SecretKeyOrSigner, deviceId: string, opts?: {
    now?: number;
}): NostrEvent;
/** 解開自己的快照事件；非快照、非自己所發、purge 或解密失敗回 null。 */
export declare function openSnapshotEvent(event: NostrEvent, sk: SecretKeyOrSigner): string | null;
//# sourceMappingURL=snapshot.d.ts.map