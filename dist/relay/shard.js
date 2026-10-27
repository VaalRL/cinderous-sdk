// 中繼分片路由（ADR-0241）：從單一全域 Durable Object 到「按收件人 pubkey 前綴分片＋presence 獨立層」。
//
// 分片鍵計算是 SSOT——`shardPrefix`／`shardPath` 由 core 提供、client 與 server 共用（見 core/shard.ts），
// 避免兩端算出不同分片而訊息路由到錯的 DO。本模組只加 **server 端路由**（URL 路徑 → DO 名選擇），
// 供 worker 的 `fetch` 依 URL 選 DO。每個分片與 presence 層都是同一個 `RelayRoom` 類的獨立實例——
// 分片＝路由、DO 邏輯不變。血條：一片崩只影響其 1/16 使用者。
import { SHARD_COUNT, shardPrefix } from "../protocol/index.js";
export { SHARD_COUNT, shardPath, shardPrefix } from "../protocol/index.js"; // SSOT re-export
/** presence 獨立層的 DO 名（ADR-0241）：廣播型、單一/少數 DO。 */
export const PRESENCE_LAYER_NAME = "presence";
/** 遷移期的舊全域 DO 名（切換＋舊留言 7 天自然過期；最低版本閘前的舊客戶端仍走這裡）。 */
export const LEGACY_GLOBAL_NAME = "global";
/** 訊息分片的 DO 名（ADR-0241）：`shard-<prefix>`（前綴＝core `shardPrefix`）。 */
export function messageShardName(pubkey) {
    return `shard-${shardPrefix(pubkey)}`;
}
/** 第三方應用車道的 DO 名前綴（ADR-0366）。 */
export const APP_LANE_PREFIX = "app-";
/**
 * 第三方車道的分片數（ADR-0366 §決策 3）。
 *
 * 取模是為了**上界**：車道 id 是客戶端自填的任意字串，不取模的話一個惡意客戶端
 * 用亂數字串就能生出幾百萬顆冷 DO。血條 1/8，與 ADR-0241 的 1/16 同一個思路。
 */
export const APP_LANE_SHARDS = 8;
/**
 * 車道 id 的合法形狀：小寫英數起頭，其餘可含 `.`／`_`／`-`，最長 64。
 * 部署端（`deploy/shared` 的 `appLanes`／`fileLanes`）用同一個樣式驗證（SDK ADR 0036）。
 */
export const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LANE_ID = LANE_ID_PATTERN;
/**
 * FNV-1a（32-bit）——把車道 id 雜湊進固定數量的分片。
 *
 * 刻意用這個而不是 `crypto`：路由要**同步**（worker 的 `fetch` 在選 DO 時就要算出來），
 * 而 `crypto.subtle` 是非同步的。FNV-1a 純算術、跨平台結果一致，而且這裡不需要
 * 密碼學強度——它只決定「哪一顆 DO」，不決定任何權限。
 */
export function laneShardOf(laneId) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < laneId.length; i++) {
        hash ^= laneId.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % APP_LANE_SHARDS;
}
/** 車道 id → DO 名（ADR-0366）。 */
export function appLaneName(laneId) {
    return `${APP_LANE_PREFIX}${laneShardOf(laneId)}`;
}
/**
 * 已知租戶的專屬 DO 名（ADR-0366 §裁示）。
 *
 * 用冒號而不是 `app-<id>`：後者會讓一條叫做 `3` 的車道與雜湊分片 `app-3` 共用 DO，
 * 而 `LANE_ID` 不允許冒號 ⇒ 這個命名空間乾淨、撞不到。
 */
export function namedLaneName(laneId) {
    return `app:${laneId}`;
}
/**
 * {@link routeForPath} **可能建立的每一顆 DO**（Cinderous ADR-0377 帳號儲存預算；SDK ADR 0042 移植）。
 *
 * 帳號的 DO SQLite 總量上界＝「每顆 DO 的天花板」加總，所以這份清單必須與路由一模一樣：
 * 少列一顆，預算就少算一顆。`shard.test.ts` 以大量路徑反查，確認路由出來的 DO 名都在這裡。
 *
 * 顆數：舊全域 1＋presence 1＋訊息分片 {@link SHARD_COUNT}＋共用車道分片 {@link APP_LANE_SHARDS}
 * ＋名單上的車道每條 1（**隨 `APP_LANES` 增加**）。
 */
export function allDoNames(known, opts = {}) {
    // 唯讀寬限期的車道（SDK ADR 0052）也有自己的 DO（名單上的以名單為準，不重複列）
    const readOnly = [...(opts.readOnlyLanes ?? [])].filter((id) => !known.has(id)).map(namedLaneName);
    // 僅限車道模式（SDK ADR 0051）：路由只會建立名單上那幾顆
    if (opts.lanesOnly === true)
        return [...[...known].map(namedLaneName), ...readOnly];
    return [
        LEGACY_GLOBAL_NAME,
        PRESENCE_LAYER_NAME,
        ...Array.from({ length: SHARD_COUNT }, (_, i) => `shard-${i.toString(16)}`),
        ...Array.from({ length: APP_LANE_SHARDS }, (_, i) => `${APP_LANE_PREFIX}${i}`),
        ...[...known].map(namedLaneName),
        ...readOnly,
    ];
}
/**
 * 由請求 URL 路徑決定路由（ADR-0366 §決策 2／4）。**認不得就回 `undefined`，宿主拒絕連線。**
 *
 *  - `/s/<prefix>`（單 hex nibble）→ `shard-<prefix>`（訊息片，嚴格）
 *  - `/presence` → presence 層（嚴格）
 *  - `/`（含空字串）→ 舊全域（嚴格；ADR-0241 遷移期回退，最低版本閘前的舊客戶端仍走這裡）
 *  - `/app/<laneId>` → 在 `knownLanes` 名單上＝ `app:<laneId>`（自己的 DO），
 *    否則 `app-<hash%8>`（共用分片）。**兩者都服務**——名單不是門禁（§裁示）
 *  - **其他一律 `undefined`**
 *
 * 🔴 **刻意不設預設值。** 原本是「認不得的路徑一律落到 `global`」，那讓
 * `/s/zz`、`/s/ab` 這種**算錯分片的客戶端**靜默落進舊全域；若把預設改成寬鬆車道，
 * 同一批路徑就會靜默落進公共規則——而那個失誤**不會報錯**（隱私默默降級），
 * 與「拒絕連線」的失誤（功能壞掉、當場看得見）代價完全不對稱。
 * 兩邊都正面列舉、其餘拒絕，就沒有預設值可以掉進去。
 */
export function routeForPath(pathname, knownLanes, opts = {}) {
    const path = pathname.replace(/\/+$/, ""); // 容忍尾斜線
    if (opts.lanesOnly === true) {
        // 僅限車道模式（SDK ADR 0051）：只有名單上的車道有路由，其他一律 undefined（宿主拒絕）。
        // 個人專屬中繼靠「路徑不可猜」擋濫用，主平面與共用分片若還開著，就是一扇任何人都猜得到的門。
        const route = routeForPath(path, knownLanes, { ...(opts.readOnlyLanes ? { readOnlyLanes: opts.readOnlyLanes } : {}) });
        return route?.profile === "app" && route.known ? route : undefined;
    }
    if (path === "")
        return { profile: "strict", doName: LEGACY_GLOBAL_NAME };
    const shard = /^\/s\/([0-9a-f])$/i.exec(path);
    if (shard?.[1])
        return { profile: "strict", doName: `shard-${shard[1].toLowerCase()}` };
    if (/^\/presence$/i.test(path))
        return { profile: "strict", doName: PRESENCE_LAYER_NAME };
    const lane = /^\/app\/(.+)$/.exec(path);
    if (lane?.[1]) {
        const laneId = lane[1].toLowerCase();
        // 形狀不合法就拒絕，不是「清乾淨後放行」——放行等於讓兩個不同的字串映到同一條車道。
        if (!LANE_ID.test(laneId))
            return undefined;
        const listed = knownLanes?.has(laneId) === true;
        // 唯讀寬限期（SDK ADR 0052）：舊路徑留在它原本那顆 DO，資料讀得到
        const readOnly = !listed && opts.readOnlyLanes?.has(laneId) === true;
        const known = listed || readOnly;
        return {
            profile: "app",
            doName: known ? namedLaneName(laneId) : appLaneName(laneId),
            laneId,
            known,
            ...(readOnly ? { readOnly: true } : {}),
        };
    }
    return undefined;
}
//# sourceMappingURL=shard.js.map