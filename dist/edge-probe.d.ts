/**
 * 判定邊緣代答時 `RelayRejection.token` 的值。不在中繼的詞元表裡：這不是中繼說的，是連線池自己的判斷。
 */
export declare const EDGE_ANSWERED_TOKEN = "edge";
/** 探測結果 */
export type RelayEdgeProbe = 'relay' | 'edge' | 'unreachable';
/** 只用得到的那一小塊 `fetch` */
export type EdgeProbeFetch = (url: string, init: {
    headers: Record<string, string>;
    mode?: 'no-cors';
    signal?: AbortSignal;
}) => Promise<{
    type?: string;
    headers: {
        get(name: string): string | null;
    };
}>;
/** 每一次請求最多等多久（毫秒） */
export declare const EDGE_PROBE_TIMEOUT_MS = 10000;
/** `wss://host/path` → `https://host/path`（NIP-11 與 WebSocket 同一個網址） */
export declare function relayInfoUrlOf(relayUrl: string): string;
/**
 * 抓兩次 NIP-11，判斷回答的是不是中繼本身。
 *
 * 只花兩個 HTTP 請求；呼叫端要自己節制頻率（連線池只在「還沒連上就被關」連續發生時才問，每座最多 5 分鐘一次）。
 */
export declare function probeRelayEdge(relayUrl: string, fetchFn: EdgeProbeFetch, timeoutMs?: number): Promise<RelayEdgeProbe>;
//# sourceMappingURL=edge-probe.d.ts.map