import type { DeclaredStandby } from './roster.js';
/** 每台最多宣告幾座備援（32 台都塞滿，名單事件仍在中繼的單顆上限內；測試釘住） */
export declare const ROSTER_STANDBY_MAX_URLS = 4;
/** 備援網址最長幾個字（私人路徑約 80 字） */
export declare const ROSTER_STANDBY_MAX_URL_LENGTH = 200;
/** 測不通的網址，`refresh()` 隔多久才重測（毫秒） */
export declare const DEFAULT_STANDBY_RETRY_MS: number;
/**
 * 分享用的備援網址正規化：`wss://`、有主機、不帶帳密與片段、主機公開、不超過長度上限；主機小寫、去掉結尾斜線
 * （路徑大小寫保留——私人路徑分大小寫）。不合規回 undefined。
 */
export declare function normalizeStandbyUrl(raw: unknown): string | undefined;
/** 備援清單裡分享得出去的：正規化、去重、最多前 {@link ROSTER_STANDBY_MAX_URLS} 座（其他的丟掉） */
export declare function shareableStandbyUrls(urls: readonly unknown[]): string[];
/** 這個網址能不能經名單分享給別台（見 {@link normalizeStandbyUrl}） */
export declare function isShareableStandbyUrl(raw: unknown): boolean;
/** 一則建議的來源裝置 */
export interface StandbySuggestionSource {
    readonly pubkey: string;
    readonly deviceId: string;
    readonly label: string;
    /** `roster`：名單上它自己簽的宣告；`pairing`：配對時邀請方交來的 */
    readonly via: 'roster' | 'pairing';
}
/** 配對時交來的建議（`PairingResult.standby` 加上邀請方） */
export interface StandbyOffer {
    readonly source: Omit<StandbySuggestionSource, 'via'>;
    readonly urls: readonly string[];
}
/** 一個建議新增的備援（還沒測試） */
export interface StandbyCandidate {
    /** 正規化後的網址 */
    readonly url: string;
    readonly sources: readonly StandbySuggestionSource[];
}
export interface PlanStandbyAdoptionOptions {
    /** 這台已經有的中繼（主清單＋備援）：這些不建議 */
    readonly own: readonly string[];
    /** 其他有效成員的宣告（`membership.declaredStandbys()`） */
    readonly declared: readonly DeclaredStandby[];
    /** 配對時交來的 */
    readonly offers?: readonly StandbyOffer[];
    /** 使用者忽略過的網址 */
    readonly ignored?: Iterable<string>;
    /** 來源要是有效成員（例如 `(pk) => membership.isMember(pk)`）；省略＝不過濾 */
    readonly isMember?: (pubkey: string) => boolean;
}
/**
 * 依別台的宣告列出建議新增的備援（SDK ADR 0056）。純邏輯、不測試：
 * 只**新增**（不移除、不碰主清單）；自己已經有的、被忽略的、不合規的網址不建議；同一個網址合併來源；依網址排序。
 */
export declare function planStandbyAdoption(opts: PlanStandbyAdoptionOptions): StandbyCandidate[];
/** 建議的測試狀態：`pending`＝還沒測完；只有 `reachable` 的應該讓使用者採用 */
export type StandbyProbeState = 'pending' | 'reachable' | 'unreachable';
export interface StandbySuggestion extends StandbyCandidate {
    readonly probe: StandbyProbeState;
    /** 最後一次測完的時間（毫秒） */
    readonly checkedAt?: number;
}
export interface StandbySuggestionsOptions {
    /** 網址連得上嗎（例如 `(url) => probeRelayEndpoint(url, fetch)`：讀 NIP-11） */
    readonly probe: (url: string) => Promise<boolean>;
    /** 之前忽略過的（應用存在本機、建構時傳回） */
    readonly ignored?: Iterable<string>;
    /** 測不通的隔多久才重測；預設 1 小時 */
    readonly retryMs?: number;
    readonly now?: () => number;
}
/**
 * 「建議新增的備援」清單（SDK ADR 0056）：餵它別台的宣告（`update`）與配對交來的（`offer`），它算出建議、自動測試新網址、
 * 有變化時通知（`onChange`）。**不自動採用**：應用列出 `list()`，使用者按「加入」時應用自己把網址加進備援清單
 * （之後 `update` 的 `own` 有它，建議就消失），按「忽略」時呼叫 `ignore(url)`，並把 `ignored()` 存在本機。
 */
export declare class StandbySuggestions {
    #private;
    constructor(opts: StandbySuggestionsOptions);
    /** 換上這台目前的中繼（主清單＋備援）與別台的宣告；新的網址自動開始測試 */
    update(input: Omit<PlanStandbyAdoptionOptions, 'offers' | 'ignored'>): void;
    /** 配對時邀請方交來的備援（`PairingResult.standby`）；同一台再交一次會取代 */
    offer(source: Omit<StandbySuggestionSource, 'via'>, urls: readonly string[]): void;
    /** 目前的建議（不含自己已經有的、被忽略的），依網址排序 */
    list(): StandbySuggestion[];
    /** 使用者按了「忽略」：不再建議這個網址 */
    ignore(url: string): void;
    /** 忽略過的網址（應用存在本機，下次建構時以 `ignored` 傳回） */
    ignored(): string[];
    onChange(listener: () => void): () => void;
    /** 測試還沒測過的、以及測不通而且超過重試間隔的建議；全部測完才 resolve */
    refresh(): Promise<void>;
}
//# sourceMappingURL=standby.d.ts.map