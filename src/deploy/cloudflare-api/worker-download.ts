// 部署時才下載中繼 Worker（SDK ADR 0094）：外掛只帶版號與 SHA-256（`relayWorkerSha256`，幾十個位元組），
// 不帶 117 KB 的 Worker 本體。下載後比對雜湊，不符就不部署——下載來源被換掉或被中途改寫，都不會部署到使用者的帳號。
//
// HTTP 一樣要注入（Obsidian 用 `requestUrl` 轉接器）；沒給用全域 `fetch`。雜湊用 WebCrypto（Obsidian 桌面、行動版、Node 都有）。
import { CloudflareApiError, defaultHttp, type HttpFetch } from './http.js';
import { relayWorkerSha256 } from './relay-worker-info.js';

export interface FetchRelayWorkerOptions {
  /** Worker 的下載網址（只收 https）。內容要跟這份 SDK 打包的 `relayWorkerSource` 一字不差 */
  url: string;
  /** 預期的 SHA-256（十六進位）；預設是這份 SDK 打包的 Worker 的雜湊 */
  sha256?: string;
  fetch?: HttpFetch;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 下載中繼 Worker 並比對雜湊，相符才回傳原始碼（交給 `deployCloudflareRelayWithWorker` 的 `workerSource`）。
 * @throws {CloudflareApiError} `worker-download`（連不上、HTTP 不是 200、網址不是 https）、`worker-integrity`（雜湊不符）
 */
export async function fetchRelayWorker(opts: FetchRelayWorkerOptions): Promise<string> {
  if (!/^https:\/\//i.test(opts.url)) {
    throw new CloudflareApiError('worker-download', `中繼 Worker 的下載網址必須是 https：${opts.url}`);
  }
  const http = opts.fetch ?? defaultHttp;
  let status: number;
  let text: string;
  try {
    const response = await http(opts.url, { method: 'GET', headers: {} });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CloudflareApiError('worker-download', `下載不到中繼 Worker（${opts.url}）：${reason}`, { cause: error });
  }
  if (status !== 200) {
    throw new CloudflareApiError('worker-download', `下載中繼 Worker 失敗（${opts.url}，HTTP ${status}）`, { status });
  }
  const expected = (opts.sha256 ?? relayWorkerSha256).toLowerCase();
  const actual = await sha256Hex(text);
  if (actual !== expected) {
    throw new CloudflareApiError('worker-integrity', `下載到的中繼 Worker 與預期的不同（SHA-256 ${actual}，預期 ${expected}），不部署`);
  }
  return text;
}
