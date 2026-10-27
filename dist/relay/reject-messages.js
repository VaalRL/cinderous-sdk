/**
 * 中繼回給客戶端的拒收訊息（SDK ADR 0038 P0-R2；ADR 0040 詞元表）。
 *
 * 每一句都是「NIP-01 前綴＋英文詞元＋說明」：外站只看得懂前綴，我們的客戶端（`classifyRelayMessage`）多拿一層詞元。
 * 詞元取自 `protocol/relay-reject.ts` 的 {@link RELAY_REJECT_TOKENS}，契約測試逐句確認分類正確。
 *
 * 🔴 這些句子與 Cinderous 錨點（`relay/src/reject-messages.ts`）**逐字相同**：PR #9 把錨點切到 SDK 中繼時，
 * 客戶端看到的不變。改字要兩邊一起改。說明文字可以改，前綴與詞元是契約。
 */
/** 離線留言存不下（DO 天花板滿了而這個平面不淘汰；SDK ADR 0038 P0-R1）。 */
export const OFFLINE_CEILING_REJECT = "blocked: ceiling: 本站離線留言空間已滿，這則未保存也未轉送；請改用其他中繼或稍後再試";
/** 事件自帶的 NIP-40 `expiration` 已經過了（SDK ADR 0038 P0-R1）。重送同一顆沒有用。 */
export const EXPIRED_REJECT = "invalid: expired: 事件已過期（NIP-40），未保存也未轉送";
/** 可尋址被拒的句子，依原因拆開（SDK ADR 0038 P0-R2；原本全部是同一句 {@link ADDRESSABLE_REJECT_GENERIC}）。 */
export const ADDRESSABLE_REJECT = {
    stale: "blocked: stale: 這個位址已有較新的事件，未取代",
    "too-large": "blocked: too-large: 可尋址事件超過單顆大小上限",
    "address-quota": "blocked: quota: 這個作者在這個 kind 的位址數已達上限",
    "byte-quota": "blocked: quota: 這個作者的可尋址資料總量已達上限",
    expired: EXPIRED_REJECT,
    ceiling: "blocked: ceiling: 本站可尋址資料空間已滿，這則未保存也未轉送；請改用其他中繼或稍後再試",
};
/**
 * 自訂的 `OfflineStore` 只實作了回 boolean 的 `putAddressable`、說不出原因時用的舊句子。
 * 沒有詞元，客戶端分成 `policy`（與 v0.31 以前相同）。
 */
export const ADDRESSABLE_REJECT_GENERIC = "blocked: 取代事件遭拒（配額/大小/較舊）";
/** 其他拒收（`OK false`、`CLOSED`、`NOTICE`）。 */
export const REJECT = {
    tooManyTags: "blocked: too-many-tags: tag 數超過上限",
    tooManyRecipients: "blocked: too-many-recipients: 收件人數超過上限",
    eventTooLarge: "blocked: too-large: 事件過大",
    notAllowed: "blocked: not-allowed: 非本企業成員（allowlist）",
    kindDisabled: "blocked: kind-disabled: 此事件類型已被政策停用",
    /** 🔴 ADR 0027 的 `isFileEventsDisabledReason` 認 `MAX_FILE_MB`，這個記號要留著 */
    filesDisabled: "blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）",
    fileChunkTooLarge: "blocked: too-large: 檔案塊過大",
    badSignature: "invalid: bad-signature: 簽章驗證失敗",
    clockSkew: "invalid: clock-skew: 時間戳超出允許範圍",
    messageTooLarge: "invalid: too-large: 訊息過大",
    vanishRelayTag: "invalid: relay-tag: relay tag 未指向本站（NIP-62）",
    /** NIP-01 的範例是 `OK true "duplicate: …"`：本站已經有這顆（SDK ADR 0038 決策 3） */
    duplicate: "duplicate: seen: 事件重複",
    eventsRateLimited: "rate-limited: events: 發送過於頻繁，請稍後再試",
    messagesRateLimited: "rate-limited: messages: 訊息過於頻繁，連線將關閉（ADR-0366）",
    ipRateLimited: "rate-limited: ip: 同一個 IP 的訊息過於頻繁，連線將關閉（PRD 3.3）",
    subscriptionsLimit: "rate-limited: subscriptions: 訂閱數已達上限",
    authRequired: "auth-required: nip42: 請先認證（NIP-42）",
    scopeStrict: "restricted: scope: 訂閱必須指定 #p（自己）或 authors（ADR-0123）",
    scopeLane: "restricted: scope: app lanes need a tag filter (e.g. #t, #d), authors, or #p set to yourself after NIP-42 AUTH (ADR-0366)",
    notOnWhitelist: "restricted: not-allowed: 不在這座站的白名單上",
    vanishSelfOnly: "restricted: self-only: 只能清除自己的資料（NIP-62）",
    /** 收件確認（SDK ADR 0067）：簽章者不是這條連線認證的身分 */
    ackSelfOnly: "restricted: self-only: 只能確認自己的收件匣（SDK ADR 0067）",
    /** 收件確認的 content 不是逗號分隔、最多 500 個的 64 位小寫 hex（SDK ADR 0067） */
    ackMalformed: "invalid: malformed: 收件確認格式不對（SDK ADR 0067）",
    /**
     * 唯讀寬限期的舊路徑（SDK ADR 0052）：讀得到、不收寫入。🔴 不提新網址、不提任何車道 id——
     * 新網址只經名單加密的搬家通知交給成員，拒絕訊息是任何拿到舊網址的人都看得到的。
     */
    readOnly: "restricted: read-only: 這條路徑已停用、只能讀取（換了新網址），不再接受寫入",
    authNoChallenge: "auth-failed: no-challenge: 尚未發出挑戰",
    authBadEvent: "auth-failed: bad-auth: 認證事件無效或挑戰不符",
    authRelayTag: "auth-failed: relay-tag: relay tag 未指向本站",
    authTooOld: "auth-failed: too-old: 認證事件已過期",
    internal: "error: internal: 內部錯誤，請稍後再試",
};
/** `pow: difficulty: 需要難度 N` */
export function powRejectMessage(minPow) {
    return `pow: difficulty: 需要難度 ${minPow}`;
}
/** 同一把公鑰的已認證連線超過上限（SDK ADR 0013） */
export function tooManyConnectionsMessage(max) {
    return `restricted: too-many-connections: 同一把公鑰最多 ${max} 條連線`;
}
/** 解析不了的客戶端訊息（`NOTICE`）；`reason` 是解析器給的英文短句 */
export function malformedMessage(reason) {
    return `invalid: malformed: ${reason}`;
}
// ── 收下了、但附帶條件：`OK true "warning: …"` 與 `NOTICE "warning: …"`（SDK ADR 0042；ADR 0040 詞元表）──────
// NIP-01 允許 `OK true` 帶訊息；不認得的客戶端照舊當成功。`warning` 不是 NIP-01 的標準前綴，但形狀相同（單字＋冒號），
// 我們的客戶端（`classifyRelayMessage`）依詞元分類；第三方客戶端只看到一段說明。
/** 秒數寫成人讀的長度（`7200` → `2 小時`）。 */
function humanSeconds(sec) {
    if (sec % 3600 === 0)
        return `${sec / 3600} 小時`;
    if (sec % 60 === 0)
        return `${sec / 60} 分鐘`;
    return `${sec} 秒`;
}
/** 收進溢位帶（ADR 0039 B1）：`warning: borrowed: <秒>: …`。客戶端取秒數（`parseBorrowedWarning`），算即時送達、不算耐久收下。 */
export function borrowedWarning(ttlSec) {
    return `warning: borrowed: ${ttlSec}: 本站空間暫時不足，這則只保存 ${humanSeconds(ttlSec)}、會最先被刪除；要長期保存請另存一份到其他中繼`;
}
/** 接近天花板（ADR 0038 決策 5，粗分級）：`warning: near-full: <級>: …`。級只有站方設定的一級與 95。 */
export function nearFullWarning(percent) {
    return `warning: near-full: ${percent}: 本站這一類資料的空間已用 ${percent}% 以上；建議另存一份到其他中繼`;
}
/**
 * 丟棄計數（ADR 0038 M8）：收件人讀自己的收件匣時，在 EOSE 之前送一則 `NOTICE`。
 * `warning: dropped: <則數>: <最早 created_at>: <最晚 created_at>: …`——只有數量與時間範圍，沒有寄件人、沒有內容、沒有事件 id。
 * 用 `NOTICE` 而不是自訂訊息型別：NIP-01 客戶端對 `NOTICE` 只會記錄或顯示，不認得的訊息型別有的會報錯。
 */
export function droppedNotice(d) {
    return `warning: dropped: ${d.count}: ${d.since}: ${d.until}: 本站因空間不足刪掉了 ${d.count} 則寄給你、還沒送到的留言；可向你的其他裝置或寄件人索取`;
}
/** 中繼暫時不能用、稍後或換一座再試（SDK ADR 0097、0100）：不是用法錯了，不附開發文件、以 1013 關閉 */
const TRY_AGAIN_LATER = new Set([
    "over-quota",
    "unavailable",
    "too-many-connections",
    "too-many-connections-ip",
]);
/** 升級被拒時的關閉碼（policy violation）。 */
export const UPGRADE_REJECT_CLOSE_CODE = 1008;
/** 中繼暫時不能用時的關閉碼（SDK ADR 0097）：WebSocket 規格的 1013 Try Again Later，跟「你連錯了」的 1008 分開 */
export const UPGRADE_UNAVAILABLE_CLOSE_CODE = 1013;
/** WebSocket 規格的關閉原因上限（UTF-8 bytes）。 */
const CLOSE_REASON_MAX_BYTES = 123;
/**
 * 升級被拒時送的 `NOTICE` 與關閉原因（ADR-0368）。Worker 與 Node 主機共用，兩邊的句子逐字相同。
 *
 * 🔴 **不回顯**對方送來的路徑，也**不含任何車道 id**（只有固定的 `<your-app-id>` 佔位）：
 * 僅限車道模式（SDK ADR 0051）的秘密車道不能從拒絕訊息裡被讀出來。
 */
export function upgradeRejection(kind, host, docsUrl) {
    const docs = docsUrl?.trim() || undefined;
    const docsTail = docs ? ` Docs: ${docs}` : "";
    const lane = `wss://${host}/app/<your-app-id>`;
    const [short, notice] = kind === "too-many-connections"
        ? ["too many connections", "too many connections: this relay is at its connection limit. Retry in a few minutes or use another relay."]
        : kind === "too-many-connections-ip"
            ? [
                "too many connections",
                "too many connections: too many open connections from your IP address. Close some or use another relay.",
            ]
            : kind === "over-quota"
                ? [
                    "over quota",
                    "over quota: this relay has used up its storage write allowance for today and cannot open connections " +
                        "until it resets (around 00:00 UTC). Use another relay meanwhile.",
                ]
                : kind === "unavailable"
                    ? ["temporarily unavailable", "temporarily unavailable: this relay could not open its storage. Retry in a few minutes or use another relay."]
                    : kind === "reconnect-limited"
                        ? ["rate-limited: reconnects", `rate-limited: too many reconnects from your IP; wait a few minutes before reconnecting.${docsTail}`]
                        : kind === "rate-limited"
                            ? ["rate-limited", `rate-limited: too many new connections to app lanes from your IP; retry in a minute.${docsTail}`]
                            : kind === "bad-lane"
                                ? [
                                    "invalid app lane",
                                    `invalid app lane: connect to ${lane}, where the id is 1-64 characters of a-z 0-9 . _ - ` +
                                        `and starts with a letter or digit (the "/app/" prefix is lowercase).${docsTail}`,
                                ]
                                : ["unknown relay path", `unknown relay path. Third-party apps connect to ${lane}.${docsTail}`];
    // 中繼暫時不能用（SDK ADR 0097、0100）：不是用法錯了，不附開發者文件
    if (TRY_AGAIN_LATER.has(kind))
        return { notice, reason: short };
    const withDocs = docs ? `${short}; docs: ${docs}` : short;
    const reason = new TextEncoder().encode(withDocs).length <= CLOSE_REASON_MAX_BYTES ? withDocs : short;
    return { notice, reason };
}
/**
 * 每月流量用完（SDK ADR 0101）：與 Cloudflare 額度用完同一個前綴（`over quota:`），客戶端一樣會改用別座；
 * 多說何時恢復。新連線與既有連線都收到這一則，以 1013 關閉。
 */
export function trafficQuotaRejection(resetsAtSec) {
    const when = new Date(resetsAtSec * 1000).toISOString().slice(0, 16).replace("T", " ");
    return {
        notice: `over quota: this relay has used up its monthly traffic allowance and cannot serve connections until it resets (${when} UTC). ` +
            "Use another relay meanwhile.",
        reason: "over quota",
    };
}
/** 本月流量快用完（SDK ADR 0101）：與空間預警同一個詞元（`warning: near-full: <級>:`），客戶端照既有的分類認得 */
export function trafficNearFullWarning(percent) {
    return `warning: near-full: ${percent}: 本站本月流量已用 ${percent}% 以上；用完後會暫停服務到下個重置日，建議另外連一座中繼`;
}
/** 升級被拒時用哪個關閉碼（SDK ADR 0097、0100、0111）：暫時不能用的是 1013 Try Again Later，用法錯了是 1008 */
export function upgradeCloseCode(kind) {
    // 反覆重連（SDK ADR 0111）：用法沒錯、只是太頻繁，也是 1013——用戶端會整座退避（SDK ADR 0108），不會立刻再連
    return TRY_AGAIN_LATER.has(kind) || kind === "reconnect-limited" ? UPGRADE_UNAVAILABLE_CLOSE_CODE : UPGRADE_REJECT_CLOSE_CODE;
}
/** 僅限車道模式下，被拒路徑的 NIP-11 回應本文（SDK ADR 0051）：與猜錯車道一模一樣、不透露任何車道。 */
export const UNKNOWN_PATH_INFO_BODY = "unknown relay path";
//# sourceMappingURL=reject-messages.js.map