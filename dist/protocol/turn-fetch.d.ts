import type { EventTemplate, NostrEvent } from "./event.js";
import type { SecretKey } from "./keys.js";
/**
 * ICE 伺服器（SDK ADR 0017）：與 DOM 的 `RTCIceServer` 相容，但不依賴 DOM 型別
 * ——這個檔也會被 Worker 與 Node 的型別檢查讀到，那兩個環境沒有 DOM。
 */
export interface IceServer {
    urls: string[];
    username?: string;
    credential?: string;
}
/**
 * 簽 NIP-98 授權的人（SDK ADR 0017）：可以直接給私鑰（Cinderous 原本的呼叫方式），
 * 也可以給任何會簽章的物件（SDK 的 `Identity` 不交出私鑰）。
 */
export type TurnSigner = SecretKey | {
    sign(template: EventTemplate): NostrEvent;
};
/** 注入用的最小 fetch 介面（避開 DOM/node fetch 型別差異，測試好替身）。 */
export interface TurnHttpResponse {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}
export type TurnFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
}) => Promise<TurnHttpResponse>;
/** 抓取結果：伺服器清單＋憑證有效秒數（供呼叫端排程刷新）。 */
export interface TurnResult {
    servers: IceServer[];
    /** Worker 回報的憑證有效秒數；缺席＝舊版 Worker（見 `TURN_TTL_FALLBACK_SEC`）。 */
    ttlSeconds?: number;
}
/**
 * `ttl` 缺席時的退路（ADR-0342 §2）。
 *
 * 舊版 Worker 用的是 86400（1 天），1 小時對它非常安全。**刻意不用更短的值**
 * ——那會在正常情況下浪費請求並吃掉速率限制配額。
 */
export declare const TURN_TTL_FALLBACK_SEC = 3600;
/**
 * 正規化 Cloudflare `/turn` 回應為 `IceServer[]`。回應的 `iceServers` 可能是單一物件
 * 或陣列；只保留 urls 為合法 ICE scheme 的條目，帳密原樣帶過。任何畸形 → `[]`。
 */
export declare function parseTurnResponse(json: unknown): IceServer[];
/** 取出 Worker 回報的憑證有效秒數（ADR-0342 §2）；缺席或畸形 → undefined。 */
export declare function parseTurnTtl(json: unknown): number | undefined;
/**
 * 從 relay 的 `/turn` 端點抓短期 TURN 憑證。任何失敗/未設定 → 空清單（no-op，退回純 STUN）。
 *
 * ⚠ **401 也是空清單**：那代表本端沒帶或帶錯授權（ADR-0342 §3.2）。仍然不報錯——
 * TURN 是保底，拿不到就純 STUN，不該拖垮通話建立。
 */
export declare function fetchTurnServers(endpoint: string, sk: TurnSigner, fetchFn?: TurnFetch): Promise<TurnResult>;
/**
 * 下次刷新要等多久（毫秒）。**半個 TTL**，夾在 [60s, 6h]。
 *
 * 下限防止極短 TTL 把客戶端變成打樁機（也會撞上速率限制）；
 * 上限維持舊行為的節奏，避免憑證長效時無謂地常刷。
 */
export declare function turnRefreshDelayMs(ttlSeconds: number | undefined): number;
/** 由 relay URL（`wss://host`）推導其 `/turn` 端點（`https://host/turn`）。非 ws(s) → undefined。 */
export declare function turnEndpointFromRelay(relayUrl: string | undefined): string | undefined;
/**
 * TURN 端點的候選序列（ADR-0356 §6）。
 *
 * ## 🔴 為什麼需要「後備」而不是單一端點
 *
 * `/turn` 端點原本**只從 home 推導**。ADR-0356 讓使用者能一鍵部署自己的 relay，而自架的
 * 節點**不帶 TURN 設定**（那是官方站的 key，不該跟著別人的節點跑）⇒ 它的 `/turn` 恆回 204
 * ⇒ 客戶端退回純 STUN ⇒ **部署自有節點會順手把通話保底關掉**。
 *
 * 使用者不會把這兩件事連起來。他只會發現「自從我建了自己的節點，某些人就打不通了」。
 * 這是 ADR-0342 §3.4「加一個功能、順手弄壞另一個」的同款形狀，所以修在同一份 ADR 裡。
 *
 * ## 順序的意思
 *
 * home 先試——那是他自己的站，用它最不需要解釋。home 給不出來才依序問錨點。
 *
 * ⚠ `explicit`（企業 `turnEndpoint`）存在時**只用它、不後備**：那是站方明確指定的端點，
 * 自作主張去問錨點等於把企業流量送給第三方。
 */
export declare function turnEndpointCandidates(homeUrl: string | undefined, anchors?: readonly string[], explicit?: string, opts?: {
    enterprise?: boolean;
}): string[];
/** 後備抓取的結果：多帶一個「是誰給的」供診斷。 */
export interface TurnFallbackResult extends TurnResult {
    /** 真正給出憑證的端點；全部沒給就是 undefined。 */
    endpoint?: string;
}
/**
 * 依序問每個候選端點，**第一個給得出伺服器的就用它**。
 *
 * 全部都給不出來時回空清單——與過去單一端點抓不到時的行為相同（退回純 STUN），
 * 所以這個改動對「home 本來就有 TURN」的使用者是零變化。
 */
export declare function fetchTurnWithFallback(endpoints: readonly string[], sk: TurnSigner, fetchFn?: TurnFetch): Promise<TurnFallbackResult>;
//# sourceMappingURL=turn-fetch.d.ts.map