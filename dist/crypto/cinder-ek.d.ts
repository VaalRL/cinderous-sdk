import type { Identity } from '../identity.js';
import type { NostrEvent } from '../protocol/event.js';
import type { Opened, RumorInput, WrapSpec } from '../protocol/nip59.js';
/** 對方的加密等級比先前釘選的弱（或公告不見了）：可能有人在中間把它剝掉（PRD 3.4）。 */
export declare class SecurityDowngradeError extends Error {
    readonly peer: string;
    /** 先前見過的最強機制 */
    readonly pinned: string;
    /** 這次看到的機制；`undefined`＝公告不見了 */
    readonly declared: string | undefined;
    readonly name = "SecurityDowngradeError";
    constructor(peer: string, 
    /** 先前見過的最強機制 */
    pinned: string, 
    /** 這次看到的機制；`undefined`＝公告不見了 */
    declared: string | undefined);
}
/**
 * 釘選過的對方改發了我們不認得的新版 EK 公告（ADR 0010 §5，安全審查 #9）。
 * 對方是升級不是被攻擊，但我們讀不懂，只能退回身分金鑰、失去前向保密 ⇒ 不默默退回，請 App 提示更新 SDK。
 */
export declare class PeerUpgradedError extends Error {
    readonly peer: string;
    readonly version: number;
    readonly name = "PeerUpgradedError";
    constructor(peer: string, version: number);
}
export interface CinderEkOptions {
    /** 發後量子公告、收後量子封裝；預設 true（同 Cinderous `EK_PQ_ANNOUNCE`） */
    postQuantum?: boolean;
    rotateIntervalMs?: number;
    graceMs?: number;
    now?: () => number;
}
export type OpenedWith = Opened & {
    /** `ek`＝用 EK 解開（前向保密）；`identity`＝對方封給身分金鑰（對方沒開 FS 或還不知道我的 EK） */
    via: 'ek' | 'identity';
    /**
     * 寄件人是我們釘選過的 FS 聯絡人（安全審查 #10）。`via === 'identity'` 而這裡是 true，
     * 表示對方這次沒用我的 EK——可能只是對方還沒拿到我的公告，也可能有人擋掉了；要不要警告由 App 決定。
     */
    senderPinned: boolean;
};
export declare class CinderEkKeyring {
    #private;
    private constructor();
    /** 新的金鑰環：生成第一把 EK。 */
    static create(identity: Identity, opts?: CinderEkOptions): CinderEkKeyring;
    /** 從 `exportState` 的內容還原。格式不對就丟例外，不會默默變成空的金鑰環。 */
    static fromState(identity: Identity, json: string, opts?: CinderEkOptions): CinderEkKeyring;
    /** 匯出狀態（含 EK 私鑰）：App 必須加密後再保存。不含身分私鑰。 */
    exportState(): string;
    /** 目前的 EK 公鑰 */
    get currentPublicKey(): string;
    /** 滿輪替週期（預設 7 天）就換一把新的，並刪掉過了寬限期的舊私鑰。回傳是否換了。 */
    rotateIfDue(): boolean;
    /** 我的 kind 10040 公告（身分簽章）：輪替後要重新發布。 */
    buildAnnounce(): NostrEvent;
    /**
     * 封給對方：有公告就封給對方目前的 EK（對方有後量子就走混合式），沒有就封給身分金鑰。
     * rumor 裡順便夾上我目前的 EK，對方解開就學到。
     * 對方的加密等級比先前釘選的弱 → 丟 `SecurityDowngradeError`，不送。
     */
    seal(rumor: RumorInput, peer: string, announce: NostrEvent | undefined, wrap: WrapSpec): NostrEvent;
    /** 解封：依序試目前的 EK、寬限期內的舊 EK，最後退回身分金鑰。 */
    open(event: NostrEvent): OpenedWith;
}
//# sourceMappingURL=cinder-ek.d.ts.map