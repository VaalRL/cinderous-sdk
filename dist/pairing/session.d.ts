import type { NostrSigner } from '../protocol/signer.js';
import type { RelayTransport } from '../relay-pool.js';
import { PairingError } from './errors.js';
import { VaultMembership } from './roster.js';
import { type PairingInvite, type PairingRole } from './uri.js';
/** 配對訊息的 ephemeral kind（外層與內層相同；接在 21000 信令、21002 通話之後） */
export declare const PAIRING_KIND = 21003;
/** 使用者比對 SAS、按確認的時限（預設 3 分鐘） */
export declare const DEFAULT_PAIRING_CONFIRM_MS: number;
/** 掃描方等顯示方回應的時限（預設 60 秒） */
export declare const DEFAULT_PAIRING_HANDSHAKE_MS = 60000;
export declare const DEFAULT_PAIRING_RESEND_MS = 3000;
/** 掃描方允許的時鐘誤差（QR 的到期時間是顯示方的時鐘） */
export declare const PAIRING_CLOCK_SKEW_MS: number;
export interface PairingClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface PairingDevice {
    /** 協調器的 deviceId；預設 `defaultDeviceId(公鑰)` */
    deviceId?: string;
    /** 顯示在對方螢幕與名單上的名稱（例如「Windows 桌機」） */
    label?: string;
}
export interface PairingSessionOptions {
    /** 這台裝置的身分（例如 `Identity`；私鑰不交出） */
    signer: NostrSigner;
    /** 連到配對用中繼的連線池（`RelayPool` 符合）；掃描方要連到 QR 裡的中繼 */
    pool: RelayTransport;
    /** 成員這一側必填：這台裝置的 Vault 名單。配對成功時新裝置會被加進去 */
    membership?: VaultMembership;
    device?: PairingDevice;
    /**
     * 顯示方：要放進 QR 的中繼（依序取前 2 座放得下的）。
     * 成員：歡迎訊息裡交給新裝置的完整中繼清單（預設同 QR 的中繼）。
     */
    relays?: readonly string[];
    /**
     * 成員：歡迎訊息裡交給新裝置的備援中繼（SDK ADR 0056；新裝置那邊**只是建議**，要使用者確認才加入）。
     * 預設＝這台在名單上宣告的備援（`membership.declareStandby`）。只交分享得出去的（公開的 `wss://`，最多 4 座）。
     */
    standby?: readonly string[];
    clock?: PairingClock;
    confirmTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    resendMs?: number;
    /** 測試用：一次性秘密 */
    secret?: Uint8Array;
}
export interface PairingOfferOptions extends PairingSessionOptions {
    role: PairingRole;
    /** QR 有效期（毫秒），預設 5 分鐘 */
    ttlMs?: number;
}
export interface PairingPeer {
    pubkey: string;
    deviceId: string;
    label: string;
}
export type PairingState = 'waiting' | 'handshake' | 'confirming' | 'delivering' | 'complete' | 'failed';
export interface PairingResult {
    peer: PairingPeer;
    /** 成員：更新後的同一個名單；新裝置：新建立的名單（請存進機密儲存） */
    membership: VaultMembership;
    /** 新裝置：成員交來的中繼清單；成員：自己的 `relays` */
    relays: string[];
    /**
     * 新裝置：邀請方交來的備援中繼（SDK ADR 0056）——**建議**，請使用者確認後才加入（例如交給 `StandbySuggestions.offer`）；
     * 成員：自己交出去的。舊版成員不帶＝空陣列。
     */
    standby: string[];
    /** 成員：新裝置是否回報收到了（沒回報時名單仍已加入，對方可能要重掃） */
    acknowledged: boolean;
}
export interface PairingUpdate {
    state: PairingState;
    peer?: PairingPeer;
    sas?: string;
    error?: PairingError;
}
/** 一次配對。以 `createPairingOffer`（顯示 QR 的一方）或 `acceptPairingUri`（掃描的一方）建立。 */
export declare class PairingSession {
    #private;
    /** 顯示方才有：要做成 QR 的字串 */
    readonly uri: string | undefined;
    readonly invite: Readonly<PairingInvite>;
    /** `displayer`＝顯示 QR 的一方 */
    readonly position: 'displayer' | 'scanner';
    /** `member`＝已在 Vault 裡的一方 */
    readonly side: 'member' | 'joiner';
    /** @internal 請用 `createPairingOffer`／`acceptPairingUri` */
    constructor(invite: PairingInvite, position: 'displayer' | 'scanner', opts: PairingSessionOptions, uri?: string);
    get state(): PairingState;
    get peer(): PairingPeer | undefined;
    /** 6 位數短驗證碼：兩台螢幕都顯示，使用者比對一致才按確認 */
    get sas(): string | undefined;
    get error(): PairingError | undefined;
    /** SAS 算出來時完成（失敗時拒絕） */
    get ready(): Promise<{
        sas: string;
        peer: PairingPeer;
    }>;
    /** 配對完成時完成（失敗時以 `PairingError` 拒絕） */
    get result(): Promise<PairingResult>;
    onUpdate(listener: (update: PairingUpdate) => void): () => void;
    /** 使用者確認兩台的 SAS 相同 */
    confirm(): void;
    /** 使用者說 SAS 不同（或不認得對方）：通知對方、作廢 */
    reject(): void;
    cancel(): void;
    /** @internal */
    start(): void;
}
/**
 * 顯示 QR 的一方：產生一次性秘密與 QR 字串，開始等對方掃描。
 *
 * - `role: 'invite'`：這台是 Vault 成員（要給 `membership`），邀請新裝置加入；
 * - `role: 'join'`：這台是新裝置，請已經在 Vault 裡的裝置掃描。
 */
export declare function createPairingOffer(opts: PairingOfferOptions): PairingSession;
/** 掃描的一方：解析 QR 字串、連到裡面的中繼（`pool` 由應用依 `parsePairingUri(uri).relays` 建立）、開始握手。 */
export declare function acceptPairingUri(uri: string, opts: PairingSessionOptions): PairingSession;
//# sourceMappingURL=session.d.ts.map