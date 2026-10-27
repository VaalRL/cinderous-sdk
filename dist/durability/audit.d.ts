import type { Filter } from 'nostr-tools/filter';
import type { QueryEachOptions, RelayQueryResult } from '../relay-pool.js';
/** `RelayPool` 直接符合；`markEvicted` 有的話，發現遺失時把那一座那一類資料標成已滿（ADR 0038 M4） */
export interface AuditPool {
    queryEach(filters: Filter[], options?: QueryEachOptions): Promise<RelayQueryResult[]>;
    markEvicted?(url: string, eventKind: number): void;
}
export type AuditTarget = {
    readonly type: 'addressable';
    readonly kind: number;
    readonly pubkey: string;
    readonly d: string;
    /** 最新一版的 id 與時間：查回來的比它舊＝最新那一版在那一座不見了（`outdated`） */
    readonly id?: string;
    readonly createdAt?: number;
    /** 最後更新時間（秒）；抽樣時最久沒更新的優先（它們最先被「最快到期優先」淘汰） */
    readonly updatedAt?: number;
} | {
    readonly type: 'event';
    readonly id: string;
    readonly kind?: number;
    /** 作者（預設自己；沒有 `recipient` 時才用） */
    readonly author?: string;
    /** 收件人（`#p`）；必須是自己才查得到 */
    readonly recipient?: string;
    readonly updatedAt?: number;
};
export interface AuditOptions {
    /** 自己的公鑰：決定哪些目標查得到 */
    readonly self: string;
    /** 要查哪幾座；預設連線池的 `urls`（不在裡面的當備援延遲連上） */
    readonly relays?: readonly string[];
    /** 這一輪最多查幾個目標（抽樣）；預設全部 */
    readonly sample?: number;
    /** 每個 REQ 放幾個目標；預設 64 */
    readonly batchSize?: number;
    /** 每批的逾時（毫秒） */
    readonly timeoutMs?: number;
    /** 發現遺失時呼叫 `pool.markEvicted`（有的話）；預設 true */
    readonly markEvicted?: boolean;
}
export interface AuditFinding {
    readonly target: AuditTarget;
    /** 確認不在（那一座回了 EOSE 而且沒有）的中繼 */
    readonly relays: readonly string[];
}
export interface AuditOutdated {
    readonly target: AuditTarget;
    readonly relay: string;
    /** 那一座現有的（比目標舊） */
    readonly found: {
        readonly id: string;
        readonly created_at: number;
    };
}
export interface AuditReport {
    /** 這一輪查了哪些目標 */
    readonly checked: readonly AuditTarget[];
    /**
     * `checked` 裡至少有一座中繼完整回了 EOSE 的目標（SDK ADR 0045，G12a）。不在這裡的＝每一座都是「不知道」，
     * 不能當成「查過、沒事」（`OwnEventAuditor` 不會把它們往後排）。
     */
    readonly verified: readonly AuditTarget[];
    /** 抽樣時這一輪沒查的數量 */
    readonly deferred: number;
    /** 查不到的目標（寄給別人的禮物包等） */
    readonly unauditable: readonly AuditTarget[];
    /** 確認遺失：目標 → 哪幾座沒有 */
    readonly missing: readonly AuditFinding[];
    /** 可尋址：那一座只剩比較舊的版本 */
    readonly outdated: readonly AuditOutdated[];
    /** 沒有完整回覆的中繼（逾時、被 CLOSED、斷線、沒連上）：在那裡的結果是「不知道」，不算遺失 */
    readonly inconclusive: readonly {
        readonly url: string;
        readonly status: RelayQueryResult['status'];
        readonly reason?: string;
    }[];
}
/**
 * 一次讀回稽核：抽樣（最久沒更新的優先）、分批、逐座查。只把「那一座完整回了 EOSE 而且沒有」算成遺失；
 * 逾時、被 CLOSED、斷線的中繼列在 `inconclusive`。
 */
export declare function auditOwnEvents(pool: AuditPool, targets: readonly AuditTarget[], options: AuditOptions): Promise<AuditReport>;
export interface OwnEventAuditorOptions extends Omit<AuditOptions, 'sample'> {
    readonly pool: AuditPool;
    /** 兩輪之間至少隔多久（毫秒）；預設 10 分鐘。太快的 `run()` 直接回 `{ skipped: 'rate-limited' }` */
    readonly minIntervalMs?: number;
    /** 每輪最多查幾個；預設 64 */
    readonly sample?: number;
    /** 查過的目標多久內往後排（毫秒），讓抽樣輪流查到每一個；預設 6 小時 */
    readonly recheckAfterMs?: number;
    /** 毫秒 */
    readonly now?: () => number;
}
/**
 * 有速率限制、會輪流的稽核器：每輪抽樣 `sample` 個，最久沒更新的優先，但剛查過的往後排；
 * 兩輪之間至少隔 `minIntervalMs`。同時只跑一輪（重複呼叫拿到同一個結果）。
 */
export declare class OwnEventAuditor {
    #private;
    constructor(opts: OwnEventAuditorOptions);
    /** 下一輪最早什麼時候可以跑（毫秒） */
    nextRunAt(): number;
    run(targets: readonly AuditTarget[]): Promise<AuditReport | {
        readonly skipped: 'rate-limited';
        readonly nextRunAt: number;
    }>;
}
//# sourceMappingURL=audit.d.ts.map