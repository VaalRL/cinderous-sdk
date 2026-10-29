// 分辨「中繼主機有回應、卻不是中繼在回答」與「網路斷了」（SDK ADR 0125）。
//
// Cloudflare Workers 免費方案的每日請求數用完時，邊緣直接回 Error 1027，Worker 根本沒執行：
// 送不出 NOTICE、也送不出 1013（SDK ADR 0108 的路徑走不到）。瀏覽器的 WebSocket 兩種情況都只給 1006。
//
// 但 NIP-11 規定中繼的資訊文件要帶 CORS 標頭（SDK 的 Worker 也一定帶），邊緣的錯誤頁不會帶。所以對同一個網址抓兩次：
//
// | 誰在回答             | 一般 fetch | `no-cors` fetch | 判斷           |
// | -------------------- | ---------- | --------------- | -------------- |
// | 中繼                 | 成功       | 成功            | `relay`        |
// | 邊緣代答（例如 1027）| 失敗       | 成功（不透明）  | `edge`         |
// | 網路斷了             | 失敗       | 失敗            | `unreachable`  |
//
// 不在瀏覽器（Node 不檢查 CORS）時第一次就會成功，改看有沒有 `Access-Control-Allow-Origin`。
//
// ⚠ `edge` 只說明「回答的不是中繼」，不保證是額度用完：Worker 當掉（1101）、公司的攔截代理也長這樣。
/**
 * 判定邊緣代答時 `RelayRejection.token` 的值。不在中繼的詞元表裡：這不是中繼說的，是連線池自己的判斷。
 */
export const EDGE_ANSWERED_TOKEN = 'edge';
/** 每一次請求最多等多久（毫秒） */
export const EDGE_PROBE_TIMEOUT_MS = 10_000;
/** `wss://host/path` → `https://host/path`（NIP-11 與 WebSocket 同一個網址） */
export function relayInfoUrlOf(relayUrl) {
    return relayUrl.replace(/^ws(s?):\/\//i, (_m, s) => `http${s}://`);
}
/**
 * 抓兩次 NIP-11，判斷回答的是不是中繼本身。
 *
 * 只花兩個 HTTP 請求；呼叫端要自己節制頻率（連線池只在「還沒連上就被關」連續發生時才問，每座最多 5 分鐘一次）。
 */
export async function probeRelayEdge(relayUrl, fetchFn, timeoutMs = EDGE_PROBE_TIMEOUT_MS) {
    const url = relayInfoUrlOf(relayUrl);
    const headers = { Accept: 'application/nostr+json' };
    try {
        const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        // 瀏覽器：拿得到回應就一定通過了 CORS（`type: 'cors'`）。同源或不在瀏覽器：看標頭
        if (res.type === 'cors' || res.headers.get('access-control-allow-origin') !== null)
            return 'relay';
        return 'edge';
    }
    catch {
        // 瀏覽器擋下沒有 CORS 的回應、或真的連不上：再問一次不透明的
    }
    try {
        await fetchFn(url, { headers, mode: 'no-cors', signal: AbortSignal.timeout(timeoutMs) });
        return 'edge';
    }
    catch {
        return 'unreachable';
    }
}
//# sourceMappingURL=edge-probe.js.map