// NIP-42 客戶端認證（AUTH）。開放中繼以此要求「先證明掌握某 pubkey，才准讀寫」，
// 關掉「第三方探測他人加密收件匣元資料」（ADR-0057）。此模組只管 AUTH 事件的
// 建構與解析，純函式可測；relay 端的挑戰/驗證/閘門在 `@cinderous/relay`。
import { signWith } from "./key-ops.js";
/** NIP-42 客戶端認證事件的 kind。 */
export const AUTH_KIND = 22242;
/**
 * 建構 NIP-42 AUTH 回應事件（客戶端以私鑰簽章）。relay 發 `["AUTH", challenge]` 挑戰後，
 * 客戶端以此回 `["AUTH", event]`。`relayUrl` 填 `relay` tag、`challenge` 填 `challenge` tag。
 */
export function buildAuthEvent(challenge, relayUrl, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk, opts = {}) {
    return signWith({
        kind: AUTH_KIND,
        created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
        tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
        ],
        content: "",
    }, sk);
}
/** 取 AUTH 事件的 `challenge` tag 值；無則 undefined。 */
export function authChallengeOf(event) {
    return event.tags.find((t) => t[0] === "challenge")?.[1];
}
/** 取 AUTH 事件的 `relay` tag 值（客戶端自稱正在對哪一座中繼認證）；無則 undefined。 */
export function authRelayOf(event) {
    return event.tags.find((t) => t[0] === "relay")?.[1];
}
/**
 * 從中繼 URL 取可比對的主機（小寫，含 port）；無法解析回 undefined。
 * 接受 `wss://`／`ws://`／`https://`／`http://`，也接受省略 scheme 的裸主機。
 */
export function relayHostOf(url) {
    if (!url)
        return undefined;
    const withScheme = /^[a-z]+:\/\//i.test(url) ? url : `wss://${url}`;
    try {
        const u = new URL(withScheme);
        return u.host.toLowerCase() || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * AUTH 事件的 `relay` tag 是否指向本站（NIP-42 規範要求的檢查；ADR-0235 H2）。
 *
 * ## 為什麼這個檢查是必要的
 *
 * 只比對 `challenge` 相符是**不夠的**。惡意中繼 M 可以：
 *   1. 自己連上真中繼 R，拿到 R 發的挑戰 C
 *   2. 把 C 當成「自己的」挑戰丟給連上 M 的受害者
 *   3. 受害者簽出 AUTH 事件回給 M
 *   4. M 把該事件原封轉送給 R → **以受害者身分通過 R 的認證**
 *
 * 之後 M 就能以受害者身分訂閱其加密收件匣。內容雖仍是密文，但「誰在什麼時候收到幾則訊息」
 * 已經是完整的流量分析輸入——而 Gift Wrap 的全部意義就是不讓任何人取得這個。
 *
 * `relay` tag 綁死了「這張簽名是給誰的」：受害者簽的是 `relay: M`，R 一看主機不是自己就拒收。
 *
 * 只比對**主機**（不含 scheme／路徑／尾斜線）：客戶端記的是 `wss://host`，中繼收到的是
 * `https://host/`，兩者本來就不會逐字相同。
 */
export function authRelayMatches(event, expectedHost) {
    const claimed = relayHostOf(authRelayOf(event));
    const expected = relayHostOf(expectedHost);
    return claimed !== undefined && expected !== undefined && claimed === expected;
}
//# sourceMappingURL=nip42.js.map