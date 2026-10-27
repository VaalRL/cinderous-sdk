import type { SqlExec } from "./sql-message-store.js";
/** 每月流量預算（SDK ADR 0101）。 */
export interface TrafficBudget {
    /** 一個計費週期最多多少位元組 */
    budgetBytes: number;
    /** 每月幾號 00:00 UTC 歸零（1–28，對齊 VPS 的帳單日） */
    resetDay: number;
    /** `total`＝進出合計（預設，不會少算）；`out`＝只算出去的 */
    count: "total" | "out";
    /** 用到這個百分比以上，`OK true` 帶 `warning: near-full:`（另一級固定是 95） */
    nearFullPercent?: number;
}
/** 預算的合法範圍（SDK ADR 0101）。 */
export declare const TRAFFIC_LIMITS: {
    /** 每月預算（GiB）：1 GiB–1 PiB */
    readonly monthlyGib: {
        readonly min: 1;
        readonly max: 1048576;
    };
    /** 重置日：1–28（每個月都有） */
    readonly resetDay: {
        readonly min: 1;
        readonly max: 28;
    };
    /** 預警門檻（%）：與空間預警相同 */
    readonly nearFullPercent: {
        readonly min: 50;
        readonly max: 99;
    };
};
/** Node 版中繼讀的流量設定。 */
export interface TrafficEnv {
    MONTHLY_TRAFFIC_GIB?: string | undefined;
    TRAFFIC_RESET_DAY?: string | undefined;
    TRAFFIC_COUNT?: string | undefined;
    TRAFFIC_NEAR_FULL_PERCENT?: string | undefined;
}
/**
 * 解析流量設定（SDK ADR 0101）。沒設 `MONTHLY_TRAFFIC_GIB`＝不限（與之前相同）。
 * 設錯的項目不生效、列進 `ignored`（宿主啟動時 `console.warn`）：壞掉的預算等於沒有預算，一定要看得見。
 */
export declare function trafficBudgetFrom(env: TrafficEnv): {
    budget?: TrafficBudget;
    ignored: string[];
};
/** 這個時間點落在哪個計費週期（UTC）：重置日當天 00:00 起算，到下個月同一天。`key` 是起始日（YYYY-MM-DD）。 */
export declare function trafficPeriod(nowMs: number, resetDay: number): {
    start: number;
    end: number;
    key: string;
};
/** 寫回 SQLite 的間隔：每則訊息都寫會多一次磁碟寫入；當機最多少算這段時間的量 */
export declare const TRAFFIC_FLUSH_MS = 30000;
/**
 * 流量計數（SDK ADR 0101）。給了 `exec` 就把用量存進 SQLite 的 `traffic_usage`（每個週期一列），重開不會歸零；
 * 純記憶體模式不給，重開就從零開始（宿主啟動時提醒）。
 */
export declare class TrafficMeter {
    #private;
    constructor(budget: TrafficBudget, opts?: {
        exec?: SqlExec;
        now?: () => number;
    });
    /** 記一筆：`in`＝客戶端送來的，`out`＝中繼送出去的（位元組）。`count: out` 時不算進來的 */
    record(direction: "in" | "out", bytes: number): void;
    /** 這一期的用量 */
    snapshot(): {
        usedBytes: number;
        budgetBytes: number;
        percent: number;
        exhausted: boolean;
        resetsAt: number;
    };
    /** 粗分級預警（與空間預警相同的兩級）：達到站方設定的一級或 95 時回那一級；沒設預警或還沒到回 undefined */
    nearFullLevel(): number | undefined;
    /** 寫回 SQLite（宿主每 {@link TRAFFIC_FLUSH_MS} 與關閉時呼叫） */
    flush(): void;
}
//# sourceMappingURL=traffic-budget.d.ts.map