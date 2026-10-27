# 0094. 部署時才下載中繼 Worker：外掛只帶版號與 SHA-256

- 狀態：**已接受（Accepted，2026-10-19）**——使用者 2026-10-19 選「機制先做好，等公開時再切換」
- 日期：2026-10-19
- 對應：ADR 0021（REST API 一鍵部署、內嵌 `relayWorkerSource`）、0022（疑難排解以錯誤 kind 為鍵）；CinderSync ADR 0094

## Context

CinderSync 與 Cinder Coffice 的 `main.js` 各約 1 MB。用 esbuild 的 metafile 量（2026-10-19）：
- `./deploy/cloudflare-api` 佔 152 KB，其中 **117 KB 是打包好的中繼 Worker 字串**（`relayWorkerSource`）；
- 每個使用者都帶著它，但只有按「部署」那一次會用到，很多人從不部署。

`deploy.ts` 原本靜態 import `relayWorkerSource` 當 `workerSource` 的預設值，所以只要用到部署就一定打包進去。

使用者 2026-10-19 決定：部署時才從網路下載 Worker，外掛只放它的雜湊值做驗證。機制先做好，等公開時再切換：
- 下載網址會是公開 repo 的 GitHub release；
- 公開 repo 還沒建，SDK 也還是私有的；
- 現在先不放到任何公開的地方，也不動錨點。

## Decision

1. **版號與雜湊另存一個小檔** `relay-worker-info.ts`，跟 `relay-worker-bundle.ts` 由同一個產生器一起寫：
   - `relayWorkerSdkVersion`；
   - `relayWorkerSha256`：`relayWorkerSource` 的 UTF-8 位元組的 SHA-256，十六進位。

   `npm run check` 會確認兩個檔都跟原始碼一致。
2. **`deployCloudflareRelayWithWorker(opts & { workerSource: string })`**：
   - 原本的部署流程，Worker 由呼叫端給，型別上必填；
   - 只 import 它不會打包 Worker 本體（有測試用 esbuild 打包來確認）。
3. **`deployCloudflareRelayViaApi`** 搬到 `deploy-embedded.ts`，行為不變：沒給 `workerSource` 就用內嵌的那份。
   - SDK 是 `sideEffects: false`，沒用到它的程式會被剔除。
4. **`fetchRelayWorker({ url, sha256?, fetch? })`**：
   - 用注入的 HTTP 下載，只收 https；
   - 用 WebCrypto 算 SHA-256，預設跟 `relayWorkerSha256` 比對；
   - 相符才回傳原始碼。
5. **兩種新的錯誤 kind**，`CLOUDFLARE_TOKEN_SETUP_GUIDE` 有對應的中英疑難排解：
   - `worker-download`：連不上、HTTP 不是 200、網址不是 https；
   - `worker-integrity`：雜湊不符，不部署。
6. **公開時要補的事**（不在這次範圍）：
   - 發布流程把 `relayWorkerSource` 原樣上傳成 release asset（例如 `relay-worker-<版號>.js`）；
   - 外掛改呼叫 `fetchRelayWorker` 加 `deployCloudflareRelayWithWorker`，下載網址帶版號。

## Alternatives Considered

- **放在官方錨點上、現在就切換**：要重新部署錨點，而且中繼程式會在 SDK 公開前先公開。
- **不做，維持內嵌**：每個使用者多帶 117 KB。
- **`workerSource` 改成必填、不留內嵌版**：52 個既有測試與 CLI 都要改；留著舊介面不影響輕量版的打包大小。

## Consequences

- ＋ 外掛切換之後少 117 KB；雜湊寫死在外掛裡，下載來源被換掉也不會部署到使用者的帳號。
- ＋ 既有呼叫端不必改，`deployCloudflareRelayViaApi` 行為不變。
- － 切換之後，部署時要能連上下載網址；離線部署會得到 `worker-download`。
- － Worker 的下載網址要跟版號一起維護，每一版都要上傳 release asset。
- 驗證：`tests/deploy/relay-worker-download.test.ts`（雜湊、下載與比對、兩種錯誤、輕量版不帶 Worker 本體）。
