// 加密雲端快照（ADR-0071）：狀態快照 NIP-44 加密給**自己**、以 NIP-33 可尋址事件
// 發佈（`d` tag＝裝置 id、relay 端每裝置只留最新）。nsec 持有者可解、relay 只見密文。
//
// 本模組只管「事件包裝/解包」；內容組裝與合併在 app 層（依儲存介面），
// relay 端配額與取代語意見 relay/message-store（ADR-0071 J1）。
//
// 金鑰參數可以是原始私鑰，也可以是不交出私鑰的 `NostrSigner`（例如 `Identity`；SDK ADR 0023）。
import { pubkeyOf, signWith } from "../protocol/key-ops.js";
import { decryptDM, encryptDM } from "../protocol/nip44.js";
/** 快照事件 kind（NIP-78 應用資料，位於 NIP-33 可尋址範圍）。 */
export const SNAPSHOT_KIND = 30078;
/** 快照壽命：30 天＋每次備份刷新（對齊 relay 端上限，ADR-0071）。 */
export const SNAPSHOT_TTL_SECONDS = 30 * 86_400;
/** 打包快照事件：明文 NIP-44 加密給自己、`d`＝裝置 id、expiration＝now＋30 天。 */
export function buildSnapshotEvent(plaintext, sk, deviceId, opts = {}) {
    const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
    return signWith({
        kind: SNAPSHOT_KIND,
        created_at: nowSec,
        tags: [
            ["d", deviceId],
            ["expiration", String(nowSec + SNAPSHOT_TTL_SECONDS)],
        ],
        content: encryptDM(plaintext, sk, pubkeyOf(sk)),
    }, sk);
}
/** 打包 purge 事件（content 空）：關閉備份時清除 relay 上此裝置的快照（ADR-0071）。 */
export function buildSnapshotPurge(sk, deviceId, opts = {}) {
    const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
    return signWith({ kind: SNAPSHOT_KIND, created_at: nowSec, tags: [["d", deviceId]], content: "" }, sk);
}
/** 解開自己的快照事件；非快照、非自己所發、purge 或解密失敗回 null。 */
export function openSnapshotEvent(event, sk) {
    if (event.kind !== SNAPSHOT_KIND || event.content === "")
        return null;
    if (event.pubkey !== pubkeyOf(sk))
        return null;
    try {
        return decryptDM(event.content, sk, event.pubkey);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=snapshot.js.map