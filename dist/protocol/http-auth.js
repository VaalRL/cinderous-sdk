// NIP-98 風格的 HTTP 請求簽章（ADR-0342 §3.2）：用身分金鑰證明「這個請求是我發的」。
//
// ## 為什麼要有它
//
// relay Worker 的 `/turn` 端點在任何驗證之前——任何人 `GET` 就拿到 TURN 憑證，
// 而 **TURN 是通用中繼**，等於免費 proxy（ADR-0336 §2）。
//
// ## 它證明什麼、不證明什麼
//
// ✅ 「持有 `pubkey` 私鑰的人，在 `created_at` 前後的時間窗內，對**這個 URL＋method** 發了請求。」
//
// 🔴 **它不證明「你是這座 relay 的使用者」**，也擋不住有心人——產一把金鑰是微秒級的事。
// 買到的是**可歸責性**（請求綁得上一個 pubkey）。
//
// ⚠ **不要拿 pubkey 當速率限制的 key**：它由請求方自選、換一把不用錢，
// 以它計數等於沒有限制。速率限制要用比較貴的東西（IP）——見 ADR-0342 §3.1。
//
// 真正的執法把手見 ADR-0342 §3.3。
//
// ## 綁定的三件事，缺一不可
//
// - **URL**：否則對 A 端點簽的可以拿去打 B 端點。
// - **method**：否則 GET 的簽章可以拿去 POST。
// - **時間**：否則永久可重放。
import { signWith } from "./key-ops.js";
import { verifyEvent } from "./sign.js";
/** NIP-98 HTTP Auth 事件 kind。 */
export const HTTP_AUTH_KIND = 27235;
/**
 * 允許的時鐘偏移（秒）。
 *
 * ⚠ 太嚴會擋掉時鐘不準的裝置（他們拿不到 TURN、退回純 STUN）；
 * 太鬆則放大重放窗口。60 秒是兩者的折衷。
 */
export const HTTP_AUTH_SKEW_SEC = 60;
/** 簽一個綁定 URL＋method＋時間的授權事件。 */
export function buildHttpAuthEvent(url, method, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk, nowSec = Math.floor(Date.now() / 1000)) {
    return signWith(httpAuthTemplate(url, method, nowSec), sk);
}
/**
 * 未簽章的授權事件範本（SDK ADR 0017：從 `buildHttpAuthEvent` 抽出，
 * 讓不交出私鑰的簽章者——例如 SDK 的 `Identity`——也能簽出同一種格式）。
 */
export function httpAuthTemplate(url, method, nowSec = Math.floor(Date.now() / 1000)) {
    return {
        kind: HTTP_AUTH_KIND,
        created_at: nowSec,
        // 大小寫正規化在**簽與驗兩側都做**，否則 "GET"／"get" 會驗不過。
        tags: [
            ["u", url],
            ["method", method.toUpperCase()],
        ],
        content: "",
    };
}
/**
 * UTF-8 安全的 base64。
 *
 * ⚠ **不能直接 `btoa(JSON.stringify(...))`**：`btoa` 只吃 Latin-1，遇到任何
 * 碼位 > U+00FF 就丟 `InvalidCharacterError`。目前事件內容全是 ASCII（hex、URL、
 * `"GET"`、空 content），但**端點若換成 IDN 主機名或含非 ASCII 路徑就會炸**——
 * 那是埋著的地雷，不是現在的 bug。先在編碼層擋掉。
 */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin);
}
/** 對應的解碼。 */
function fromBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
/** 包成 `Authorization` 標頭的值。 */
export function httpAuthHeader(event) {
    return `Nostr ${toBase64(JSON.stringify(event))}`;
}
/**
 * 事件結構驗證——**必須在 `verifyEvent` 之前**（ADR-0235 C1）。
 *
 * `verifyEvent` 只保證「`id` 是這串 JSON 的 sha256、`sig` 是 `pubkey` 對 `id` 的簽章」，
 * **完全不檢查欄位型別**。攻擊者可以對 `{tags:{}}` 這種形狀自己算 hash、自己簽，
 * `verifyEvent` 會回傳 true，接著 `tags.find(...)` 拋 `TypeError`。
 */
export function isValidAuthEventShape(e) {
    if (typeof e !== "object" || e === null || Array.isArray(e))
        return false;
    const ev = e;
    if (!Number.isFinite(ev.kind) || !Number.isFinite(ev.created_at))
        return false;
    for (const field of ["id", "pubkey", "sig", "content"]) {
        if (typeof ev[field] !== "string")
            return false;
    }
    if (!Array.isArray(ev.tags))
        return false;
    for (const tag of ev.tags) {
        if (!Array.isArray(tag))
            return false;
        for (const v of tag)
            if (typeof v !== "string")
                return false;
    }
    return true;
}
function tagValue(event, name) {
    return event.tags.find((t) => t[0] === name)?.[1];
}
/**
 * 驗證 `Authorization` 標頭。回傳簽署者 pubkey，或 `null`（一律當作未授權）。
 *
 * ⚠ **回傳 `null` 不區分原因**——對外不說「是簽章壞了還是時間過期」，
 * 那對攻擊者是免費的偵錯資訊，對正常使用者也幫不上忙（他們的客戶端會自己重簽）。
 */
export function verifyHttpAuth(header, url, method, nowSec = Math.floor(Date.now() / 1000)) {
    if (!header)
        return null;
    const m = /^Nostr\s+(.+)$/i.exec(header.trim());
    if (!m)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(fromBase64(m[1]));
    }
    catch {
        return null;
    }
    // 🔴 順序不可調換：先結構、後簽章（見 isValidAuthEventShape 的說明）。
    if (!isValidAuthEventShape(parsed))
        return null;
    const event = parsed;
    if (event.kind !== HTTP_AUTH_KIND)
        return null;
    if (Math.abs(nowSec - event.created_at) > HTTP_AUTH_SKEW_SEC)
        return null;
    if (tagValue(event, "u") !== url)
        return null;
    if (tagValue(event, "method") !== method.toUpperCase())
        return null;
    if (!verifyEvent(event))
        return null;
    return event.pubkey;
}
//# sourceMappingURL=http-auth.js.map