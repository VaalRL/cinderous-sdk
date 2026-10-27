// 檔案墓碑（SDK ADR 0011 §4；PRD 2.6）：刪掉的檔案留一筆 `{ path, deletedAt }` 隨快照同步，
// 別台才知道要刪、而不是把它當成「我這邊少了一個檔案」又傳回來（幽靈復活）。
import { SNAPSHOT_TTL_SECONDS } from './snapshot.js';
/** 墓碑壽命：與快照壽命對齊（30 天）。超過就清掉，墓碑不會無限累積。 */
export const TOMBSTONE_TTL_MS = SNAPSHOT_TTL_SECONDS * 1000;
/** 離線超過這麼久才回來的裝置視為「沉睡」：它的墓碑可能已被別台清掉。 */
export const STALE_DEVICE_MS = TOMBSTONE_TTL_MS;
/** 合併兩份墓碑清單：同一路徑取較新的刪除時間。可交換，任意順序合併結果都一樣。 */
export function mergeTombstones(a, b) {
    const byPath = new Map();
    for (const t of [...a, ...b]) {
        const current = byPath.get(t.path);
        if (current === undefined || t.deletedAt > current)
            byPath.set(t.path, t.deletedAt);
    }
    return [...byPath].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([path, deletedAt]) => ({ path, deletedAt }));
}
/**
 * 這個檔案算不算已刪（PRD 的 LWW）：檔案的修改時間比墓碑新 ⇒ 刪了之後又重新建立，復活；否則已刪。
 * 平手算已刪：寧可不要讓刪掉的檔案復活。
 */
export function isDeleted(path, modifiedAt, tombstones) {
    const tombstone = tombstones.find((t) => t.path === path);
    if (!tombstone)
        return false;
    return modifiedAt === undefined || tombstone.deletedAt >= modifiedAt;
}
/** 清掉超過壽命的墓碑。 */
export function gcTombstones(tombstones, now, ttlMs = TOMBSTONE_TTL_MS) {
    return tombstones.filter((t) => now - t.deletedAt <= ttlMs);
}
/**
 * 沉睡裝置隔離（PRD 2.6.1）：離線超過 30 天才回來，它手上的墓碑可能已被別台清掉，
 * 直接合併會讓別台早已刪掉的檔案復活 ⇒ 回 true，由 App 請使用者確認後再合併。
 * 從沒同步過的新裝置不算（它沒有舊資料可以復活）。
 */
export function isStaleDevice(lastSyncAt, now, thresholdMs = STALE_DEVICE_MS) {
    return lastSyncAt !== undefined && now - lastSyncAt > thresholdMs;
}
//# sourceMappingURL=tombstones.js.map