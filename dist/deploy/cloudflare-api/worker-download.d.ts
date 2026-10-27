import { type HttpFetch } from './http.js';
export interface FetchRelayWorkerOptions {
    /** Worker 的下載網址（只收 https）。內容要跟這份 SDK 打包的 `relayWorkerSource` 一字不差 */
    url: string;
    /** 預期的 SHA-256（十六進位）；預設是這份 SDK 打包的 Worker 的雜湊 */
    sha256?: string;
    fetch?: HttpFetch;
}
/**
 * 下載中繼 Worker 並比對雜湊，相符才回傳原始碼（交給 `deployCloudflareRelayWithWorker` 的 `workerSource`）。
 * @throws {CloudflareApiError} `worker-download`（連不上、HTTP 不是 200、網址不是 https）、`worker-integrity`（雜湊不符）
 */
export declare function fetchRelayWorker(opts: FetchRelayWorkerOptions): Promise<string>;
//# sourceMappingURL=worker-download.d.ts.map