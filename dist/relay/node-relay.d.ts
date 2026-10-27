import { type TrafficBudget } from "./traffic-budget.js";
/** 宿主從環境變數讀設定（與原本的腳本同一組名稱；見 docs/self-hosting-raspberry-pi.md） */
export type NodeRelayEnv = Record<string, string | undefined>;
/** 環境變數之外、由呼叫端（例如 CLI）決定的選項。 */
export interface NodeRelayOptions {
    /**
     * 純記憶體（SDK ADR 0006 §relay-lite：預設純記憶體、`--persist` 才寫 SQLite）。
     * 開了就**不碰** `DB_PATH`，重啟即清空。未設＝照原本的行為寫 SQLite 檔（Docker／樹莓派的既有部署不變）。
     */
    memory?: boolean;
    /**
     * 每月流量預算（SDK ADR 0101），取代環境變數 `MONTHLY_TRAFFIC_GIB` 等。給嵌入者與測試用——
     * 環境變數只收整數 GiB，測試用不完。
     */
    trafficBudget?: TrafficBudget;
}
/**
 * 啟動 Node 版中繼（SDK ADR 0007：原本是一載入就開 server 的腳本，改成可呼叫的函式）。
 * 回傳 `close()`：停掉 HTTP／WebSocket 伺服器與清除排程、關掉 SQLite。
 */
export declare function startNodeRelay(env?: NodeRelayEnv, opts?: NodeRelayOptions): {
    close(): void;
};
//# sourceMappingURL=node-relay.d.ts.map