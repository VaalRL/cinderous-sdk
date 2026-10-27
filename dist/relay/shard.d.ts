export { SHARD_COUNT, shardPath, shardPrefix } from "../protocol/index.js";
/** presence 獨立層的 DO 名（ADR-0241）：廣播型、單一/少數 DO。 */
export declare const PRESENCE_LAYER_NAME = "presence";
/** 遷移期的舊全域 DO 名（切換＋舊留言 7 天自然過期；最低版本閘前的舊客戶端仍走這裡）。 */
export declare const LEGACY_GLOBAL_NAME = "global";
/** 訊息分片的 DO 名（ADR-0241）：`shard-<prefix>`（前綴＝core `shardPrefix`）。 */
export declare function messageShardName(pubkey: string | undefined): string;
/** 第三方應用車道的 DO 名前綴（ADR-0366）。 */
export declare const APP_LANE_PREFIX = "app-";
/**
 * 第三方車道的分片數（ADR-0366 §決策 3）。
 *
 * 取模是為了**上界**：車道 id 是客戶端自填的任意字串，不取模的話一個惡意客戶端
 * 用亂數字串就能生出幾百萬顆冷 DO。血條 1/8，與 ADR-0241 的 1/16 同一個思路。
 */
export declare const APP_LANE_SHARDS = 8;
/**
 * 車道 id 的合法形狀：小寫英數起頭，其餘可含 `.`／`_`／`-`，最長 64。
 * 部署端（`deploy/shared` 的 `appLanes`／`fileLanes`）用同一個樣式驗證（SDK ADR 0036）。
 */
export declare const LANE_ID_PATTERN: RegExp;
/**
 * FNV-1a（32-bit）——把車道 id 雜湊進固定數量的分片。
 *
 * 刻意用這個而不是 `crypto`：路由要**同步**（worker 的 `fetch` 在選 DO 時就要算出來），
 * 而 `crypto.subtle` 是非同步的。FNV-1a 純算術、跨平台結果一致，而且這裡不需要
 * 密碼學強度——它只決定「哪一顆 DO」，不決定任何權限。
 */
export declare function laneShardOf(laneId: string): number;
/** 車道 id → DO 名（ADR-0366）。 */
export declare function appLaneName(laneId: string): string;
/**
 * 一次連線的路由結果（ADR-0366）。
 *
 * `profile` 同時決定**用哪一份政策**（嚴格＝Cinderous 訊息平面，寬鬆＝第三方車道），
 * 所以路由與政策是同一個決定、在同一個地方做完——分成兩處遲早會漂移成
 * 「路由到寬鬆 DO 卻套了嚴格政策」這種只在產線才看得出來的錯。
 */
export type RelayRoute = {
    profile: "strict";
    doName: string;
} | {
    profile: "app";
    doName: string;
    laneId: string;
    /**
     * 這條車道在站方的**已知租戶名單**（`APP_LANES`）上嗎（ADR-0366 §裁示）。
     *
     * 🔴 **名單不是門禁**：沒列的照樣連得上——錨點同時是公用 relay。名單決定的是
     * **落在哪顆 DO**（因而決定儲存配額）：列了就有自己的 DO，沒列的共用雜湊分片。
     * 它也**不是憑證**：車道 id 是自報的，陌生人打 `/app/lwd` 一樣會落進那顆 DO
     * （§決策 1）。買到的是「我們知道形狀的流量」與「陌生流量」不共用一顆 DO 的血條。
     */
    known: boolean;
    /**
     * 唯讀寬限期的車道（`READONLY_LANES`；SDK ADR 0052）：換了私人路徑之後的舊路徑。落在它原本那顆 DO（`app:<id>`、
     * `known: true`），可以連、可以讀，寫入一律拒絕。只有唯讀時才有這個欄位。
     */
    readOnly?: true;
};
/**
 * 已知租戶的專屬 DO 名（ADR-0366 §裁示）。
 *
 * 用冒號而不是 `app-<id>`：後者會讓一條叫做 `3` 的車道與雜湊分片 `app-3` 共用 DO，
 * 而 `LANE_ID` 不允許冒號 ⇒ 這個命名空間乾淨、撞不到。
 */
export declare function namedLaneName(laneId: string): string;
/**
 * {@link routeForPath} **可能建立的每一顆 DO**（Cinderous ADR-0377 帳號儲存預算；SDK ADR 0042 移植）。
 *
 * 帳號的 DO SQLite 總量上界＝「每顆 DO 的天花板」加總，所以這份清單必須與路由一模一樣：
 * 少列一顆，預算就少算一顆。`shard.test.ts` 以大量路徑反查，確認路由出來的 DO 名都在這裡。
 *
 * 顆數：舊全域 1＋presence 1＋訊息分片 {@link SHARD_COUNT}＋共用車道分片 {@link APP_LANE_SHARDS}
 * ＋名單上的車道每條 1（**隨 `APP_LANES` 增加**）。
 */
export declare function allDoNames(known: ReadonlySet<string>, opts?: RouteOptions): string[];
/** 路由選項（SDK ADR 0051）。 */
export interface RouteOptions {
    /**
     * 僅限車道（`LANES_ONLY`）：只接受 `knownLanes` 上的車道；主平面（`/`、`/s/<n>`、`/presence`）與
     * 沒列的車道一律沒有路由。個人專屬中繼的「開放寫入＋不可猜的隨機路徑」靠它。
     */
    lanesOnly?: boolean;
    /**
     * 唯讀寬限期的車道（SDK ADR 0052；呼叫端已依時間篩過，見 `host-config.readOnlyLaneIds`）：路由到它原本那顆 DO
     * （`app:<id>`），`LANES_ONLY` 時也算連得上。不在 `knownLanes` 上的才算（名單上的照常可寫）。
     */
    readOnlyLanes?: ReadonlySet<string>;
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
export declare function routeForPath(pathname: string, knownLanes?: ReadonlySet<string>, opts?: RouteOptions): RelayRoute | undefined;
//# sourceMappingURL=shard.d.ts.map