/**
 * 每座中繼的健康狀態（SDK ADR 0038 研究結果四 §2；實作見 ADR 0041）。
 *
 * 不是一個分數，而是依拒收分類（ADR 0040）記下「這一座對哪一類資料暫時不能用、到什麼時候」：
 *
 * | 分類 | 標記 | 範圍 | 多久 |
 * |---|---|---|---|
 * | `ceiling`／`quota` | `full`（已滿） | 那一類資料（離線留言／可尋址／可取代／ephemeral） | `fullMs`（預設 1 小時） |
 * | `policy`／`restricted`（`OK false`） | `inapplicable`（不適用） | 那個 kind | `inapplicableMs`（預設 24 小時，或 `reset`） |
 * | `too-large` | `inapplicable` | 那個 kind、**至少這麼大**的事件 | 同上 |
 * | `rate-limited` | `backoff` | 整座 | 到計數窗結束（`ip` 詞元 1 秒，其他 `rateLimitedMs` 預設 60 秒） |
 * | 關閉碼 1008 `rate-limited`／`too-many-connections` | `backoff` | 整座 | `rateLimitedMs` |
 * | 關閉碼 4003、1008 其他（車道被拒） | `inapplicable` | 整座 | `inapplicableMs` |
 * | 關閉碼 1013（`unavailable`：額度用完、儲存起不來；SDK ADR 0108） | `backoff` | 整座 | `unavailableMs`（預設 5 分鐘）；那一座回了 EOSE 就清掉 |
 * | 關閉碼 4429（`unavailable`，詞元 `iot-quota`：C′ 家庭今日額度用完；SDK ADR 0122） | `backoff` | 整座 | 到原因帶的重置時間（加最多 60 秒抖動、最多一天）；沒帶＝`unavailableMs` |
 * | `invalid`、`stale`、`pow`、`error`、`timeout`、`disconnected`、`auth-failed:` | 不標記（只記最近一次） | — | — |
 *
 * `invalid` 是自己的錯：換哪座都一樣，所以不標記、不改用、不重試。
 * 重新讀到 NIP-11 時（`revalidateRelay`，SDK ADR 0044），文件看得出原因已不成立的「不適用」立刻清掉
 *（`files-disabled` 而現在 `cinder_accepts_files: true`、`too-large` 而上限已不小於那顆、`not-allowed` 而 `restricted_writes: false`）。
 * 任何一次收下（含 `duplicate`）會清掉那一類的 `full` 與整座的 `backoff`——「任何一座收下就恢復」。
 *
 * **只記錄，不改變預設行為**：v0.32 的 `publish(event)` 照舊送給每一座開著的中繼；
 * 只有帶 `durability` 的發布（ADR 0041）才會略過被標記的中繼。
 *
 * 不持久化（ADR 0041 §2）：冷卻最長一天、中繼的狀態會自己變，重新啟動後頂多每座多挨一次拒收就重新學會；
 * 快照是純資料，應用要記錄或顯示可以自己存。
 *
 * **軟標記**（SDK ADR 0042）：`OK true "warning: near-full: <級>:"` 記在 `nearFull`（那一類資料、哪一級、何時），
 * `NOTICE "warning: dropped:"` 記在 `lastDropped`。兩者都**不是** `marks`，不影響發布、不讓 `durability` 略過那一座——
 * 事件收下了（耐久），只是提醒應用「這座快滿了」「有幾則在這座遺失了」。同一類資料下一次收下而沒帶預警就清掉 `nearFull`。
 */
import { type RelayRejectKind } from './protocol/relay-reject.js';
/** `full`＝那一類資料滿了；`inapplicable`＝這座不收（政策、太大、白名單外）；`backoff`＝限速，等計數窗結束 */
export type RelayHealthState = 'full' | 'inapplicable' | 'backoff';
/** 中繼儲存上的分區（決定 `full` 的範圍）：離線留言與可尋址在中繼上是兩個天花板 */
export type RelayDataPlane = 'offline' | 'addressable' | 'replaceable' | 'ephemeral';
/** 一個標記的範圍：`*`＝整座；`offline` 等＝那一類資料；`kind:<n>`＝那個 kind */
export type RelayHealthScope = '*' | RelayDataPlane | `kind:${number}`;
export interface RelayHealthMark {
    readonly scope: RelayHealthScope;
    readonly state: RelayHealthState;
    /** 造成這個標記的拒收分類 */
    readonly kind: RelayRejectKind;
    readonly reason: string;
    /** 毫秒 */
    readonly since: number;
    /** 毫秒；過了就失效 */
    readonly until: number;
    /** `too-large`：這麼大（位元組）以上的事件才不送 */
    readonly minBytes?: number;
}
export interface RelayHealthSnapshot {
    readonly url: string;
    /** 延遲連上的備援（不在連線池的 `urls` 裡） */
    readonly standby: boolean;
    /** 連線狀態（`RelayPool.status()` 同義；備援另外列在這裡） */
    readonly status: 'connecting' | 'open' | 'closed';
    /** 還有效的標記 */
    readonly marks: readonly RelayHealthMark[];
    /** 最近一次拒收（含不標記的分類） */
    readonly lastRejection?: {
        readonly kind: RelayRejectKind;
        readonly reason: string;
        readonly at: number;
    };
    readonly lastAcceptedAt?: number;
    /** 最近一次 `OK true "warning: borrowed:"`（只是借用、不耐久；SDK ADR 0039） */
    readonly lastBorrowedAt?: number;
    /** 軟標記：哪幾類資料最近一次收下時帶了 `warning: near-full:`（粗分級，SDK ADR 0042）。不影響發布 */
    readonly nearFull?: readonly RelayNearFull[];
    /** 最近一次 `NOTICE "warning: dropped:"`：這座中繼刪掉了幾則寄給你、還沒送到的留言（SDK ADR 0042） */
    readonly lastDropped?: {
        readonly count: number;
        readonly since: number;
        readonly until: number;
        readonly at: number;
    };
}
/** 一類資料的「快滿了」軟標記（SDK ADR 0042） */
export interface RelayNearFull {
    readonly plane: RelayDataPlane;
    /** 中繼給的級（例如 80、95），不是精確用量 */
    readonly percent: number;
    /** 毫秒 */
    readonly at: number;
}
export interface RelayHealthCooldowns {
    /** `ceiling`／`quota` 之後多久不再往那裡寫那一類（毫秒）；預設 1 小時 */
    readonly fullMs?: number;
    /**
     * 政策、白名單外、太大之後多久不再試（毫秒）；預設 24 小時。這是「沒有重讀 NIP-11」時的上限：
     * 重讀到的文件表示原因已不成立時，`revalidateRelay`（`watchRelayFileLimits` 定期呼叫）立刻清掉（SDK ADR 0044）
     */
    readonly inapplicableMs?: number;
    /** 限速之後的退避（毫秒）；預設 60 秒（中繼每分鐘的計數窗） */
    readonly rateLimitedMs?: number;
    /** 以 1013 關閉（暫時不能用，SDK ADR 0108）之後多久不再用、多久之後才重連（毫秒）；預設 5 分鐘 */
    readonly unavailableMs?: number;
}
export declare const DEFAULT_RELAY_HEALTH_COOLDOWNS: Readonly<Required<RelayHealthCooldowns>>;
/** 某個 kind 在中繼上屬於哪一類（NIP-01 的 kind 範圍） */
export declare function relayDataPlaneOf(kind: number): RelayDataPlane;
/** 一次觀察到的結果（連線池在每次發布結案、中繼以關閉碼斷線時餵進來） */
export interface RelayObservation {
    readonly kind: RelayRejectKind;
    readonly reason: string;
    readonly token?: string | undefined;
    /** 那一則事件的 kind（`source: 'close'` 時沒有） */
    readonly eventKind?: number | undefined;
    /** 那一則事件的大小（位元組，約略） */
    readonly bytes?: number | undefined;
    readonly source: 'ok' | 'close';
    /** 中繼說了什麼時候恢復（毫秒時間；4429 `iot-quota:<reset>`，SDK ADR 0122）：標記到那時，不用預設冷卻 */
    readonly until?: number | undefined;
}
/** 連線池內部用；不從主入口匯出類別本身，只匯出型別與常數 */
export declare class RelayHealthTracker {
    #private;
    constructor(opts: {
        now?: () => number;
        cooldowns?: RelayHealthCooldowns;
        onChange: (url: string) => void;
    });
    /** 還有效的標記（順手清掉過期的） */
    marks(url: string): RelayHealthMark[];
    snapshot(url: string): Pick<RelayHealthSnapshot, 'marks' | 'lastRejection' | 'lastAcceptedAt' | 'lastBorrowedAt' | 'nearFull' | 'lastDropped'>;
    /**
     * 收下時的預警（SDK ADR 0042）：`percent` 有值＝這一類資料快滿了（軟標記）；undefined＝這次收下沒帶預警，清掉那一類的軟標記。
     * 只在出現、級數改變或清掉時通知。
     */
    nearFull(url: string, eventKind: number, percent: number | undefined): void;
    /** 中繼說有幾則寄給你的留言在送到之前被刪掉了（`NOTICE "warning: dropped:"`；SDK ADR 0042） */
    dropped(url: string, notice: {
        readonly count: number;
        readonly since: number;
        readonly until: number;
    }): void;
    /** 這一座現在該不該收到這一則（kind、大小）；該略過就回造成略過的標記 */
    blocking(url: string, eventKind: number, bytes: number): RelayHealthMark | undefined;
    /** 一次拒收（或帶關閉碼的斷線） */
    observe(url: string, o: RelayObservation): void;
    /** 收下了（`borrowed`＝只是借用）：清掉那一類的 `full` 與整座的 `backoff`（借用不清 `full`） */
    accepted(url: string, eventKind: number, borrowed?: boolean): void;
    /** 那一座回了 EOSE（能正常服務了）：清掉「暫時不能用」的標記（SDK ADR 0108） */
    served(url: string): void;
    /** 讀回稽核發現某座弄丟了自己的事件：把那一類標成已滿（ADR 0038 M4「發現遺失之後」） */
    markEvicted(url: string, eventKind: number): void;
    /** 清掉某座（或全部）的標記：設定改了、重新讀過 NIP-11 之後。`filter` 只清符合的（範圍、狀態；SDK ADR 0044） */
    reset(url?: string, filter?: RelayHealthResetFilter): void;
    /**
     * 重新讀到這座的 NIP-11（SDK ADR 0044）：清掉「文件已表示原因不成立」的不適用標記，回傳清掉的那些（有清才通知）。
     * 只清在 `observedAt`（讀文件的時間）**之前**出現的標記——讀到之後才被拒，代表文件與實際不符，不清。
     */
    revalidate(url: string, info: unknown, observedAt?: number): RelayHealthMark[];
}
/** `resetRelayHealth(url, filter)` 的篩選：只清這個範圍／這種狀態的標記（都省略＝全部） */
export interface RelayHealthResetFilter {
    readonly scope?: RelayHealthScope;
    readonly state?: RelayHealthState;
}
//# sourceMappingURL=relay-health.d.ts.map