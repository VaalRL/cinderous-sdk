import type { Event } from 'nostr-tools/core';
import type { NostrEvent } from '../protocol/event.js';
import type { NostrSigner } from '../protocol/signer.js';
import type { RelayStatus, RelayTransport } from '../relay-pool.js';
import type { VaultMembership } from './roster.js';
import type { RosterOuterKind } from './roster-sync.js';
/** 中繼搬家通知的內層 rumor kind（名單 4361、裝置宣告簽章 4362 之後） */
export declare const VAULT_RELAY_MOVE_KIND = 4363;
/** 通知的 NIP-40 保存期：最長唯讀寬限期（30 天）多一天。中繼會再以自己的上限截短 */
export declare const DEFAULT_RELAY_MOVE_TTL_SECONDS: number;
/** 網址最長幾個字（中繼網址＋26 字私人路徑約 80 字） */
export declare const RELAY_MOVE_MAX_URL_LENGTH = 512;
/** 送出前等連線開起來最多多久（毫秒） */
export declare const DEFAULT_RELAY_MOVE_CONNECT_MS = 10000;
/** 一則搬家通知 */
export interface RelayMove {
    /** 舊網址（收方清單裡要有它才會替換） */
    readonly from: string;
    /** 新網址 */
    readonly to: string;
    /** 送出的時間（毫秒）：同一個舊網址取最新的 */
    readonly at: number;
    /** 送出的裝置（名單上的 deviceId）；只用來顯示 */
    readonly device?: string;
}
/** 收到、而且寄件人已驗證是名單成員的通知 */
export interface ReceivedRelayMove extends RelayMove {
    /** 寄件人（seal 簽章者）的公鑰 */
    readonly sender: string;
}
/** `wss://`／`ws://`、有主機、不含帳密與 fragment、不超過長度上限 */
export declare function isRelayMoveUrl(value: unknown): value is string;
/** 兩個中繼網址是不是同一座（協定與主機不分大小寫、結尾斜線不計；路徑分大小寫） */
export declare function sameRelayUrl(a: string, b: string): boolean;
/** 把一則搬家通知包成給每位收件人的事件（與名單同步同一種封裝） */
export declare function buildRelayMoveEvents(move: RelayMove, signer: NostrSigner, recipients: readonly string[], opts?: {
    now?: number;
    ttlSeconds?: number;
    outerKind?: RosterOuterKind;
}): NostrEvent[];
/**
 * 解開搬家通知；不是搬家通知、解不開、格式不對、外層不是 `outerKind`（預設 1060）回 null。
 * 不驗寄件人是否為成員——那是收方的事（`NostrRosterSync` 會驗）。
 */
export declare function openRelayMoveEvent(event: Event | NostrEvent, signer: NostrSigner, opts?: {
    outerKind?: RosterOuterKind;
}): ReceivedRelayMove | null;
/** 送出用的連線：`RelayPool` 直接符合。有 `status`／`onStatusChange` 時會先等連線開起來 */
export interface RelayMoveConnection extends RelayTransport {
    close(): void;
    status?(): ReadonlyMap<string, RelayStatus>;
    onStatusChange?(listener: (url: string, status: RelayStatus) => void): () => void;
}
export interface AnnounceRelayMoveOptions {
    membership: VaultMembership;
    signer: NostrSigner;
    /** 要送的通知；`at` 省略＝現在、`device` 省略＝這台的 deviceId */
    move: Omit<RelayMove, 'at' | 'device'> & {
        at?: number;
        device?: string;
    };
    /** 送到哪些中繼（部署前：舊網址與其他共同的中繼；部署後：新網址與其他中繼） */
    relays: readonly string[];
    /** 開一個連到 `relays` 的連線（例如 `(urls) => { const p = new RelayPool({ urls, identity }); p.connect(); return p; }`）；送完會 `close()` */
    connect: (urls: readonly string[]) => RelayMoveConnection;
    outerKind?: RosterOuterKind;
    ttlSeconds?: number;
    /** 等連線開起來最多多久（毫秒）；預設 10 秒 */
    connectTimeoutMs?: number;
    now?: () => number;
}
export interface AnnounceRelayMoveResult {
    /** 收下了**每一位**收件人那一顆的中繼 */
    accepted: string[];
    /** 其他（拒收、逾時、沒連上） */
    failed: string[];
    /** 收件人數（有效成員，含自己） */
    recipients: number;
}
/**
 * 把搬家通知送到指定的中繼（SDK ADR 0052）。收件人是名單上**目前有效**的每一台（含自己）；被撤銷的不在裡面。
 * 回傳哪幾座收下了全部收件人的那一顆——呼叫端據此決定要不要部署（「至少一座收下才部署」）。
 * 這台已經不在名單上（被撤銷）時丟例外。
 */
export declare function announceRelayMove(opts: AnnounceRelayMoveOptions): Promise<AnnounceRelayMoveResult>;
/** 讀中繼 NIP-11 用的 HTTP（與 `./sync/vault` 的 `RelayInfoFetch` 同一個形狀；外掛注入 requestUrl 版本） */
export type RelayMoveProbeFetch = (url: string, init: {
    method: 'GET';
    headers: Record<string, string>;
}) => Promise<{
    status: number;
    text(): Promise<string>;
}>;
/**
 * 新網址真的連得上嗎（SDK ADR 0052 的「切換前先測試」）：讀它的 NIP-11（`Accept: application/nostr+json`），
 * 回 200 的 JSON 物件、而且不是唯讀寬限期中的路徑才算。僅限車道的中繼對還沒部署上去的路徑回 404——部署失敗時不會有人切換。
 * 任何錯誤都回 false（下一輪再試）。
 */
export declare function probeRelayEndpoint(url: string, fetch: RelayMoveProbeFetch): Promise<boolean>;
export interface PlanRelayMovesOptions {
    /** 這台的主中繼清單 */
    primary: readonly string[];
    /** 這台的備援中繼清單（與主清單不重複） */
    standby?: readonly string[];
    /** 收到的通知（寄件人已驗證） */
    moves: readonly RelayMove[];
    /** 新網址連得上嗎（`probeRelayEndpoint`） */
    probe: (url: string) => Promise<boolean>;
    /** 連鎖搬家（A→B、B→C）最多跟幾層；預設 4 */
    maxHops?: number;
}
export interface RelayMovePlan {
    primary: string[];
    standby: string[];
    /** 這次替換了哪些（依序） */
    applied: {
        from: string;
        to: string;
    }[];
}
/**
 * 依收到的搬家通知決定新的中繼清單（SDK ADR 0052）。純邏輯＋`probe`，不改任何狀態：
 * - 只**替換**清單裡已經有的舊網址（原地、保持順序），不新增；新網址已經在清單裡就只拿掉舊的（去重）。
 * - 同一個舊網址有好幾則：從最新的開始試，第一個 `probe` 成功的採用；都不成功就不動（部署失敗、還沒上線）。
 * - 備援清單同理；新網址已經在主清單時從備援拿掉（兩份不重複）。
 * - 連鎖（A→B 之後 B→C）最多跟 `maxHops` 層。
 */
export declare function planRelayMoves(opts: PlanRelayMovesOptions): Promise<RelayMovePlan>;
//# sourceMappingURL=relay-move.d.ts.map