/**
 * 中繼回給客戶端的拒收訊息（SDK ADR 0038 P0-R2；ADR 0040 詞元表）。
 *
 * 每一句都是「NIP-01 前綴＋英文詞元＋說明」：外站只看得懂前綴，我們的客戶端（`classifyRelayMessage`）多拿一層詞元。
 * 詞元取自 `protocol/relay-reject.ts` 的 {@link RELAY_REJECT_TOKENS}，契約測試逐句確認分類正確。
 *
 * 🔴 這些句子與 Cinderous 錨點（`relay/src/reject-messages.ts`）**逐字相同**：PR #9 把錨點切到 SDK 中繼時，
 * 客戶端看到的不變。改字要兩邊一起改。說明文字可以改，前綴與詞元是契約。
 */
import type { DroppedSummary } from "./capacity.js";
import type { AddressableRejectReason } from "./message-store.js";
/** 離線留言存不下（DO 天花板滿了而這個平面不淘汰；SDK ADR 0038 P0-R1）。 */
export declare const OFFLINE_CEILING_REJECT = "blocked: ceiling: \u672C\u7AD9\u96E2\u7DDA\u7559\u8A00\u7A7A\u9593\u5DF2\u6EFF\uFF0C\u9019\u5247\u672A\u4FDD\u5B58\u4E5F\u672A\u8F49\u9001\uFF1B\u8ACB\u6539\u7528\u5176\u4ED6\u4E2D\u7E7C\u6216\u7A0D\u5F8C\u518D\u8A66";
/** 事件自帶的 NIP-40 `expiration` 已經過了（SDK ADR 0038 P0-R1）。重送同一顆沒有用。 */
export declare const EXPIRED_REJECT = "invalid: expired: \u4E8B\u4EF6\u5DF2\u904E\u671F\uFF08NIP-40\uFF09\uFF0C\u672A\u4FDD\u5B58\u4E5F\u672A\u8F49\u9001";
/** 可尋址被拒的句子，依原因拆開（SDK ADR 0038 P0-R2；原本全部是同一句 {@link ADDRESSABLE_REJECT_GENERIC}）。 */
export declare const ADDRESSABLE_REJECT: Readonly<Record<AddressableRejectReason, string>>;
/**
 * 自訂的 `OfflineStore` 只實作了回 boolean 的 `putAddressable`、說不出原因時用的舊句子。
 * 沒有詞元，客戶端分成 `policy`（與 v0.31 以前相同）。
 */
export declare const ADDRESSABLE_REJECT_GENERIC = "blocked: \u53D6\u4EE3\u4E8B\u4EF6\u906D\u62D2\uFF08\u914D\u984D/\u5927\u5C0F/\u8F03\u820A\uFF09";
/** 其他拒收（`OK false`、`CLOSED`、`NOTICE`）。 */
export declare const REJECT: {
    readonly tooManyTags: "blocked: too-many-tags: tag 數超過上限";
    readonly tooManyRecipients: "blocked: too-many-recipients: 收件人數超過上限";
    readonly eventTooLarge: "blocked: too-large: 事件過大";
    readonly notAllowed: "blocked: not-allowed: 非本企業成員（allowlist）";
    readonly kindDisabled: "blocked: kind-disabled: 此事件類型已被政策停用";
    /** 🔴 ADR 0027 的 `isFileEventsDisabledReason` 認 `MAX_FILE_MB`，這個記號要留著 */
    readonly filesDisabled: "blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）";
    readonly fileChunkTooLarge: "blocked: too-large: 檔案塊過大";
    readonly badSignature: "invalid: bad-signature: 簽章驗證失敗";
    readonly clockSkew: "invalid: clock-skew: 時間戳超出允許範圍";
    readonly messageTooLarge: "invalid: too-large: 訊息過大";
    readonly vanishRelayTag: "invalid: relay-tag: relay tag 未指向本站（NIP-62）";
    /** NIP-01 的範例是 `OK true "duplicate: …"`：本站已經有這顆（SDK ADR 0038 決策 3） */
    readonly duplicate: "duplicate: seen: 事件重複";
    readonly eventsRateLimited: "rate-limited: events: 發送過於頻繁，請稍後再試";
    readonly messagesRateLimited: "rate-limited: messages: 訊息過於頻繁，連線將關閉（ADR-0366）";
    readonly ipRateLimited: "rate-limited: ip: 同一個 IP 的訊息過於頻繁，連線將關閉（PRD 3.3）";
    readonly subscriptionsLimit: "rate-limited: subscriptions: 訂閱數已達上限";
    readonly authRequired: "auth-required: nip42: 請先認證（NIP-42）";
    readonly scopeStrict: "restricted: scope: 訂閱必須指定 #p（自己）或 authors（ADR-0123）";
    readonly scopeLane: "restricted: scope: app lanes need a tag filter (e.g. #t, #d), authors, or #p set to yourself after NIP-42 AUTH (ADR-0366)";
    readonly notOnWhitelist: "restricted: not-allowed: 不在這座站的白名單上";
    readonly vanishSelfOnly: "restricted: self-only: 只能清除自己的資料（NIP-62）";
    /** 收件確認（SDK ADR 0067）：簽章者不是這條連線認證的身分 */
    readonly ackSelfOnly: "restricted: self-only: 只能確認自己的收件匣（SDK ADR 0067）";
    /** 收件確認的 content 不是逗號分隔、最多 500 個的 64 位小寫 hex（SDK ADR 0067） */
    readonly ackMalformed: "invalid: malformed: 收件確認格式不對（SDK ADR 0067）";
    /**
     * 唯讀寬限期的舊路徑（SDK ADR 0052）：讀得到、不收寫入。🔴 不提新網址、不提任何車道 id——
     * 新網址只經名單加密的搬家通知交給成員，拒絕訊息是任何拿到舊網址的人都看得到的。
     */
    readonly readOnly: "restricted: read-only: 這條路徑已停用、只能讀取（換了新網址），不再接受寫入";
    readonly authNoChallenge: "auth-failed: no-challenge: 尚未發出挑戰";
    readonly authBadEvent: "auth-failed: bad-auth: 認證事件無效或挑戰不符";
    readonly authRelayTag: "auth-failed: relay-tag: relay tag 未指向本站";
    readonly authTooOld: "auth-failed: too-old: 認證事件已過期";
    readonly internal: "error: internal: 內部錯誤，請稍後再試";
};
/** `pow: difficulty: 需要難度 N` */
export declare function powRejectMessage(minPow: number): string;
/** 同一把公鑰的已認證連線超過上限（SDK ADR 0013） */
export declare function tooManyConnectionsMessage(max: number): string;
/** 解析不了的客戶端訊息（`NOTICE`）；`reason` 是解析器給的英文短句 */
export declare function malformedMessage(reason: string): string;
/** 收進溢位帶（ADR 0039 B1）：`warning: borrowed: <秒>: …`。客戶端取秒數（`parseBorrowedWarning`），算即時送達、不算耐久收下。 */
export declare function borrowedWarning(ttlSec: number): string;
/** 接近天花板（ADR 0038 決策 5，粗分級）：`warning: near-full: <級>: …`。級只有站方設定的一級與 95。 */
export declare function nearFullWarning(percent: number): string;
/**
 * 丟棄計數（ADR 0038 M8）：收件人讀自己的收件匣時，在 EOSE 之前送一則 `NOTICE`。
 * `warning: dropped: <則數>: <最早 created_at>: <最晚 created_at>: …`——只有數量與時間範圍，沒有寄件人、沒有內容、沒有事件 id。
 * 用 `NOTICE` 而不是自訂訊息型別：NIP-01 客戶端對 `NOTICE` 只會記錄或顯示，不認得的訊息型別有的會報錯。
 */
export declare function droppedNotice(d: DroppedSummary): string;
/**
 * 升級請求被拒的原因（ADR-0368）。`over-quota`／`unavailable`（SDK ADR 0097）：路徑沒錯，是這座中繼的
 * Durable Object 起不來——寫入額度用完，或其他暫時的錯誤；客戶端該稍後再試或改用別座。
 */
export type RejectKind = "unknown-path" | "bad-lane" | "rate-limited"
/** 主平面同一個 IP 反覆重連（SDK ADR 0111；Cinderous ADR-0391）：以 1013 關閉、原因保留文件網址 */
 | "reconnect-limited" | "over-quota" | "unavailable"
/** 全站連線數已滿（`MAX_CONNECTIONS`；SDK ADR 0100） */
 | "too-many-connections"
/** 這個 IP 的連線數已滿（`MAX_CONNECTIONS_PER_IP`；SDK ADR 0100） */
 | "too-many-connections-ip";
/** 升級被拒時的關閉碼（policy violation）。 */
export declare const UPGRADE_REJECT_CLOSE_CODE = 1008;
/** 中繼暫時不能用時的關閉碼（SDK ADR 0097）：WebSocket 規格的 1013 Try Again Later，跟「你連錯了」的 1008 分開 */
export declare const UPGRADE_UNAVAILABLE_CLOSE_CODE = 1013;
/**
 * 升級被拒時送的 `NOTICE` 與關閉原因（ADR-0368）。Worker 與 Node 主機共用，兩邊的句子逐字相同。
 *
 * 🔴 **不回顯**對方送來的路徑，也**不含任何車道 id**（只有固定的 `<your-app-id>` 佔位）：
 * 僅限車道模式（SDK ADR 0051）的秘密車道不能從拒絕訊息裡被讀出來。
 */
export declare function upgradeRejection(kind: RejectKind, host: string, docsUrl: string | undefined): {
    notice: string;
    reason: string;
};
/**
 * 中繼的儲存額度今天用完了（SDK ADR 0097 的升級被拒、SDK ADR 0127 的已連著的連線，同一句）。
 * Cloudflare 免費方案的 Durable Object 每日讀取與寫入列數都有上限，哪一個先撞到都一樣（2026-10-22 錨點 1 撞到的是讀取）。
 * 前綴 `over quota:` 是客戶端分類的依據；關閉原因 `over quota`、關閉碼 1013。
 */
export declare const STORAGE_QUOTA_REJECTION: {
    readonly notice: string;
    readonly reason: string;
};
/**
 * 每月流量用完（SDK ADR 0101）：與 Cloudflare 額度用完同一個前綴（`over quota:`），客戶端一樣會改用別座；
 * 多說何時恢復。新連線與既有連線都收到這一則，以 1013 關閉。
 */
export declare function trafficQuotaRejection(resetsAtSec: number): {
    notice: string;
    reason: string;
};
/** 本月流量快用完（SDK ADR 0101）：與空間預警同一個詞元（`warning: near-full: <級>:`），客戶端照既有的分類認得 */
export declare function trafficNearFullWarning(percent: number): string;
/** 升級被拒時用哪個關閉碼（SDK ADR 0097、0100、0111）：暫時不能用的是 1013 Try Again Later，用法錯了是 1008 */
export declare function upgradeCloseCode(kind: RejectKind): number;
/** 僅限車道模式下，被拒路徑的 NIP-11 回應本文（SDK ADR 0051）：與猜錯車道一模一樣、不透露任何車道。 */
export declare const UNKNOWN_PATH_INFO_BODY = "unknown relay path";
//# sourceMappingURL=reject-messages.d.ts.map