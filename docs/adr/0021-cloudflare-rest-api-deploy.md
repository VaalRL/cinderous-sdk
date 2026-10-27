# 0021. 不依賴 Node 的 Cloudflare 一鍵部署：REST API、注入式 HTTP、預先打包的 Worker、瀏覽器授權

- Status: Accepted
- Date: 2026-09-29
- 相關：ADR 0008（`./deploy` 交給 wrangler）、0018（共用部署模組）、0019（中立預設值）、0020（打包大小）；外掛缺口 G1／G2（`obsidian-cindersync-dev`、`obsidian-cinder-coffice-dev` 的 ARCHITECTURE.md §5）

## Context

兩個 Obsidian 外掛初始化時發現：

- `@cinderous/client/deploy` 的 `deployCloudflareRelay` 在模組載入時就引用 `node:fs`、`node:child_process`，再執行 `npx wrangler@4 deploy`。外掛只要匯入就會在行動版（iOS／Android，沒有 Node）崩潰；桌面版也要使用者裝好 Node 與 npx。
- README「Programmatic SDK Deployment (e.g. from Obsidian Plugins)」的範例與實作不符。

使用者已核准補上，並**明確不要 wrangler CLI 的過渡方案**。

## Decision

### 1. 新子路徑 `@cinderous/client/deploy/cloudflare-api`

- 名稱說明它是什麼：「Cloudflare 的 API 路徑」，與 `./deploy`（wrangler／docker／fly，都靠外部指令）並列。
- **模組圖裡零 Node 內建模組**。守門測試 `tests/deploy/cloudflare-api-guard.test.ts` 用 esbuild 實際打包這個入口，把所有 Node 內建模組標成外部，metafile 裡只要出現一個就失敗；也確認沒有把 `cloudflare.ts`／`common.ts` 拉進來。對照組是 `./deploy`，確認測試真的抓得到 `node:child_process`。
- `./deploy` 保持原樣、向下相容。純邏輯抽到 `src/deploy/shared.ts`（不碰 Node），兩條路徑共用一份：
  - 名稱驗證 `assertRelayName`、健康檢查 `waitForHealthy`、`DEFAULT_WORKER_NAME`／`DEFAULT_COMPATIBILITY_DATE`；
  - Durable Object 綁定 `RELAY_DO_BINDING` 與遷移 `RELAY_DO_MIGRATIONS`；
  - Worker 環境變數 `relayWorkerVars`：防濫用預設（ADR 0013）、白名單（ADR 0008）、站名（ADR 0019：沒給就不設）。
  - `common.ts` 轉出原本的名稱，`wrangler.toml` 的產出逐字不變（已比對）。
- `waitForHealthy` 的 `fetch` 參數放寬成只需要 `{ status, text() }` 的最小型別。全域 `fetch` 仍然相容。

### 2. 注入式 HTTP

- 所有請求都經過呼叫端提供的 `HttpFetch`：`(url, { method, headers, body }) => Promise<{ status, text() }>`。全域 `fetch` 本身就符合；沒給就用它（Node 20+、CLI）。
- **瀏覽器環境必須注入**：Cloudflare API 不回 CORS 標頭，Obsidian 的渲染行程與行動版 WebView 直接 `fetch` 會被擋。Obsidian 用 `requestUrl` 轉接（README 有範例）。SDK 不依賴 obsidian 套件。
- multipart 本文由 SDK 自己組成 `Uint8Array`：`requestUrl` 不收 `FormData`。
- 健康檢查也走注入的 HTTP，而且**不帶** `Authorization`：Token 只送到 `api.cloudflare.com`。

### 3. 授權：預設「預填權限的 API Token 建立頁」，另提供 OAuth PKCE 輔助

**查證結果**（2026-09-29）：

- 任務原本的前提是「Cloudflare 沒有給第三方的公開 OAuth」。**這已經不成立**：Cloudflare 在 2026-06-03 推出自管 OAuth client。桌面、行動、CLI 這類公開客戶端用 Authorization Code＋PKCE（S256），不需要 client secret。
  - https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/
  - https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
  - 端點：https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/ （`/oauth2/auth`、`/oauth2/token`）
- 但 OAuth client 屬於「應用」：要在某個 Cloudflare 帳號建立，驗證 client 網址的網域（DNS TXT）後才能設為 public，讓任何 Cloudflare 使用者授權。設為 public 之後不能改回 private。SDK 是中立的函式庫（ADR 0019），不該替所有使用者持有一個 client id。
- 預填 Token 建立頁的網址格式，以官方文件〈API token template URLs〉為準：
  - https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
  - 使用者 Token：`https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<URL 編碼的 JSON 陣列>&accountId=*&zoneId=all&name=<名稱>`
  - 帳號 Token：`https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=…&name=…`
  - 陣列元素是 `{ "key": "<權限 key>", "type": "read|edit|…" }`。

**決定**：

- **預設：開 Token 建立頁**。不需要任何註冊，今天就能用。
  - `buildTokenCreationUrl({ name?, kind?: 'user' | 'account' })`，預填最小權限 `REQUIRED_TOKEN_PERMISSIONS`：
    - `workers_scripts: edit`：上傳 Worker、Durable Object 遷移、workers.dev 子網域與路由。官方 API 文件上這些端點要求的都是「Workers Scripts Write」。
    - `account_settings: read`：列出帳號。
  - `verifyToken()`：使用者 Token 打 `GET /user/tokens/verify`；給 `accountId` 時改打帳號 Token 的 `GET /accounts/{id}/tokens/verify`。
  - `listAccounts()`：`GET /accounts`，分頁讀完。
- **選用：OAuth PKCE 輔助**（`oauth.ts`）。給自己註冊了 public client 的應用使用：
  - 函式：`createPkcePair`、`createOAuthState`、`buildOAuthAuthorizationUrl`、`exchangeOAuthCode`、`refreshOAuthToken`；
  - 部署時帶 `credential: 'oauth'`：OAuth access token 不能用 `/user/tokens/verify` 驗證，所以跳過，由之後的 API 呼叫判斷；
  - scope 名稱由呼叫端給，要以 `GET /oauth/scopes` 查到的為準。SDK 沒有 client，**無法實測**這條路徑。
- Token 由呼叫端保存，SDK 不碰儲存，沿用 `SecretStore` 的接縫精神。

### 4. 部署流程（REST API v4）

`deployCloudflareRelayViaApi(opts)`：

| # | 請求 | 說明 |
|---|---|---|
| 1 | `GET /user/tokens/verify` | 狀態不是 `active` → `token-invalid`；`credential: 'oauth'` 時跳過 |
| 2 | `GET /accounts` | 只在沒給 `accountId` 時呼叫。0 個 → `permission`；多個 → `account-ambiguous`（附 `accounts`） |
| 3 | `GET /accounts/{id}/workers/subdomain` | 錯誤碼 10007＝還沒有子網域：有給 `workersDevSubdomain` 就 `PUT` 註冊，沒給 → `subdomain-missing` |
| 4 | `GET /accounts/{id}/workers/scripts` | 找同名 Worker 的 `migration_tag`，決定要送哪些遷移（見 §6） |
| 5 | `PUT /accounts/{id}/workers/scripts/{name}` | multipart 上傳，內容見下 |
| 6 | `POST /accounts/{id}/workers/scripts/{name}/subdomain` | `{ enabled: true, previews_enabled: false }` |
| 7 | `GET https://<name>.<subdomain>.workers.dev/healthz` | 重試到回 `ok`，預設 20 次。沒過 → `health`，**不回報成功** |

multipart 上傳有三段：

- `metadata`（`application/json`）：
  - `main_module: "entry.mjs"`、`compatibility_date`；
  - `bindings`：`durable_object_namespace` `RELAY_ROOM`／`RelayRoom`，加上 `plain_text` 環境變數；
  - `keep_bindings: ["secret_text", "secret_key"]`：站方在儀表板另外設的 secret（例如 TURN 的 Token）重新部署時保留；
  - `observability: { enabled: true }`；
  - 需要時帶 `migrations`，用多步驟格式 `{ old_tag?, new_tag, steps: [{ new_sqlite_classes: ["RelayRoom"] }] }`。
- `entry.mjs`（`application/javascript+module`）：注入 NIP-11 版號後，轉出 `default` 與 `RelayRoom`。做法與 wrangler 路徑的 `renderWorkerEntry` 相同，版號經 `JSON.stringify` 跳脫。
- `relay.mjs`（`application/javascript+module`）：預先打包的中繼 Worker（§5）。

格式核對來源：

- https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
- https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/
- https://developers.cloudflare.com/api/resources/accounts/methods/list/
- https://developers.cloudflare.com/workers/platform/infrastructure-as-code/
- `migrations` 的型別（`WorkersMultipleStepMigrations`）以官方的 cloudflare-typescript SDK 為準。

進度沿用 `DeployProgress`：`config`（驗證、帳號、子網域）→ `deploy`（上傳、開路由）→ `health` → `done`。

### 5. Worker 程式碼：建置時打包成單一模組字串

- `scripts/build-relay-worker-bundle.mjs` 用 esbuild 把 `src/relay/worker.ts` 打包成一個 ES module。
  - 設定：`platform: neutral`、`conditions: workerd/worker/browser`、壓縮、保留授權註解。
  - 轉出 `default`、`RelayRoom` 與 `setRelayVersion`。
- 產出寫成 `src/deploy/cloudflare-api/relay-worker-bundle.ts`，匯出 `relayWorkerSource` 與 `relayWorkerSdkVersion`（打包時的 package.json 版號）。這個檔案進版控，再由 tsc 編進 `dist/`。
- `npm run build` 會先重新產生它。`npm run check` 的 diff 檢查涵蓋它。另外 `tests/deploy/relay-worker-bundle.test.ts` 會：
  - 重打一次，與提交的版本比對；
  - 以上傳時的兩個模組原樣載入，確認 `/healthz` 回 `ok`、NIP-11 帶注入的版號與站名。
- esbuild 以 devDependency 釘確切版本 `0.28.2`，同一版本在各平台的輸出相同，CI 的 dist 比對才會穩定。
- 大小：Worker 約 62KB；整個子路徑壓縮打包約 78KB（gzip 約 29KB）。
- **只有這個子路徑會帶進 Worker**：套件是 `sideEffects: false`，主入口不引用它。守門測試確認主入口、`./protocol`、`./sync`、`./deploy` 的打包結果都不含它。主入口前後都是 154,259 bytes，沒有變化。

### 6. 冪等：重新部署不重送已套用的遷移

Cloudflare 會記住 Worker 最後套用的遷移 tag；重送已套用的遷移會被拒絕。做法與 wrangler 相同（`deploy-helpers/src/deploy/helpers/durable.ts`），只是改用有文件的 `GET /workers/scripts` 讀 `migration_tag`：

| 目前的 tag | 送出 |
|---|---|
| 沒有這支 Worker | 全部遷移，不帶 `old_tag` |
| 我們的最後一個（`v1`） | 不送 `migrations` |
| 我們較早的某一個 | 之後的步驟，帶 `old_tag` |
| 不是我們的，或同名 Worker 沒有 tag | 視為**名稱衝突**：丟 `name-conflict`，不上傳。帶 `replaceExisting: true` 才覆蓋（送全部，`old_tag` 對齊 Cloudflare 上的狀態） |

用 wrangler 路徑部署過的站，tag 也是 `v1`，所以可以直接改用 REST 路徑重新部署。

### 7. 錯誤分類

`CloudflareApiError.kind` 的值與判斷方式：

- `token-invalid`：HTTP 401；錯誤碼 1000、6003、6111、9109；verify 回傳的狀態不是 active；OAuth 回 `invalid_grant`。
- `permission`：HTTP 403；錯誤碼 10000；Token 看不到任何帳號。
- `account-ambiguous`：Token 能用多個帳號，錯誤物件附 `accounts`。
- `subdomain-missing`：帳號沒有 workers.dev 子網域，呼叫端也沒給名字。
- `name-conflict`：同名 Worker 不是中繼；錯誤碼 10031（子網域已被使用）。
- `quota`：HTTP 429；錯誤碼 971、10027（腳本太大）、10037（Worker 數量上限）。
- `network`、`health`；其他一律歸 `api`，並保留 `status` 與原始 `codes`。

錯誤碼的來源與可信度：

- **有依據**：10000、10007、10031 取自 wrangler 原始碼（`deploy-helpers/src/triggers/subdomain.ts`、`worker-not-found-error.ts`）。
- **沒有官方對照表可查**：1000、6003、6111、9109、971、10027、10037 是常見的觀察值。所以分類以 HTTP 狀態碼為主，錯誤碼只補狀態碼分不出來的情況；分錯時會落到 `api`，原始錯誤碼仍在。

## 否決的方案

- **wrangler 過渡方案**（桌面版先 `child_process` 呼叫 `npx wrangler`）：使用者明確不要。行動版仍然不能用，而且要使用者裝 Node。
- **自架 OAuth 代理**（SDK 作者架一個服務幫使用者換 token）：違反零伺服器原則；使用者的 Cloudflare 憑證也會經過第三方。
- **SDK 附一個公用 OAuth client id**：client 綁在某個帳號與網域上，等於 SDK 替所有應用背書，也違反中立預設（ADR 0019）。
- **執行期才打包 Worker**：外掛不能帶 esbuild，行動版更不行。
- **宣告式 `exports` 取代 `migrations`**：官方 API 已有 Durable Object 的宣告式 `exports`，但 wrangler 仍以 `migrations` 為主。這次沿用相同做法，之後再評估。

## 驗證的範圍

- 全部以假的 HTTP 測試：請求順序、Bearer 標頭（健康檢查不帶）、multipart 各段與 metadata、冪等重新部署、名稱衝突、帳號與子網域分支、各類錯誤、Token 網址逐字符合官方格式、PKCE。
- 打包好的 Worker 在 Node 裡以上傳時的兩個模組實際載入並回應。
- **真實帳號實測（2026-09-29，v0.19.0）**：以錨點 1 的 Cloudflare 帳號、`credential: 'oauth'`（wrangler 登入的 OAuth token，scope 含 workers write）部署 `cinder-relay-apitest`：
  - 第 1 次 2.8 秒上線，`migrationsApplied: true`；同名第 2 次 4.5 秒，`migrationsApplied: false`（冪等成立）；
  - NIP-11 帶出注入的站名與 `version: 0.19.0`；WebSocket 完成 NIP-42 認證、訂閱、發送 kind 21000 並收到回推；
  - 測完以 REST `DELETE` 刪除，網址回 404；正式錨點不受影響。
  - `credential: 'api-token'`（使用者自建 Token＋`verifyToken`）仍只有假 HTTP 測試。
- **尚未驗證**：
  - OAuth PKCE 流程：沒有 client；
  - `obsidian://` 這類自訂 scheme 能不能當 redirect URI，文件沒寫。

## 後續：其他外掛提出的 SDK 缺口（先記錄、不實作）

SDK 目前沒有待辦或 roadmap 文件（PRD 6.3 只有時間軸），所以記在這裡。編號對應外掛 ARCHITECTURE.md §5；CS＝CinderSync，CC＝Cinder Coffice。

1. ~~**Vault 層級的同步協調器**（CS G3／CC G2）：路徑到版本的索引、merge3 所需共同祖先的保存、變更佇列與離線佇列、改名語意、套用遠端變更的回呼與回環抑制。儲存以轉接器注入，兩個外掛共用。~~ **已完成（v0.22.0，[ADR 0025](0025-vault-sync-coordinator.md)）**：`@cinderous/client/sync/vault` 的 `VaultSyncCoordinator`（檔案系統、狀態儲存、時間、網路皆注入）與 `NostrVaultTransport`（沿用 kind 1060 外層）。大檔只標記「待 P2P」，批次串流仍是第 2 項。
2. ~~**首次全量同步：小檔批次的 P2P 串流**（CS G4／CC G3）：在 `PeerChannel`／`FileTransfer` 上把多個小檔合成一條串流，接收端邊收邊寫入。~~ **已完成（v0.23.0，[ADR 0026](0026-p2p-batch-stream-and-large-file-streaming.md)）**：`./transfer` 的 `StreamTransfer`（新線路格式 0xCB＋版本）；協調器給 `peers` 後，新裝置加入與大量變更改走 P2P 批次。
3. ~~**QR 裝置配對與金鑰交付**（CS G5）：QR 承載的配對資訊，加上安全的金鑰交付協定，讓新裝置取得共用身分或被加入裝置目錄（kind 10041）。~~ **已完成（v0.24.0，[ADR 0028](0028-qr-device-pairing-and-vault-roster.md)）**：`@cinderous/client/pairing`。每台裝置各自一把身分（不交付私鑰）；QR 帶一次性秘密，握手＝秘密＋臨時 ECDH＋身分金鑰，雙方確認 6 位數 SAS；產物是 `VaultMembership`（互相信任的裝置清單＋共享 Vault 金鑰），撤銷時輪換。不用 kind 10041（它是單一身分底下的裝置子金鑰），名單改由成員互送（內層 kind 4361）。
4. ~~**大檔串流寫入磁碟、傳送佇列持久化**（CS G6）：ADR 0015〈還沒做〉的兩項。~~ **已完成（v0.23.0，[ADR 0026](0026-p2p-batch-stream-and-large-file-streaming.md)）**：`StreamingFileStore`（分塊寫入、續傳、校驗後原子提交）、`P2PStreamQueue`（可持久化）；協調器的大檔經 P2P 直送並以 `writeStream` 寫入。
5. ~~**`./transfer` 子路徑**（CS G7）：`FileTransfer`、`P2PFileQueue` 目前只從主入口匯出。~~ **已完成（v0.21.0，[ADR 0023](0023-transfer-subpath-and-nostr-signer.md) §1）**
6. ~~**多人星狀會話**（CC G4）：一個 Host 管理多條 `SecureChannel`，處理扇出與成員進出。~~ **已完成（v0.26.0，[ADR 0030](0030-star-session.md)）**：`@cinderous/client/star` 的 `StarHost`／`StarMember`。Host 解密再以各成員的成對通道重新加密轉送（Host 看得到全部內容，不是端到端群組加密）；邀請一次性／有時效／可撤銷、踢出、名單事件、Host 序號全序、單播、每成員背壓、中繼軌事件預算與重送；不自動換 Host。
7. ~~**非同步 `ChatStorage`**（CC G6）：目前是同步介面，外掛想用 IndexedDB。~~ **已完成（v0.21.0，[ADR 0024](0024-async-chat-storage.md)）**
8. ~~**同步 API 需要原始私鑰，但 `Identity` 不交出私鑰**（CC G7）：`buildSnapshotEvent`、`wrapFileChunk` 等收 `SecretKey`。應讓它們接受 `Identity`，或由第 1 項的協調器封裝。~~ **已完成（v0.21.0，[ADR 0023](0023-transfer-subpath-and-nostr-signer.md) §2）**：`./sync`、`./protocol` 收私鑰的 API 都改收 `SecretKey | NostrSigner`，`Identity` 直接可用。
9. ~~**跨外掛共用中繼連線**（CC G8）：待評估。~~ **已評估（見 [ADR 0031](0031-cross-plugin-relay-connection-sharing.md)）**：建議不做。官方錨點上兩個外掛是不同車道（不同網址＝不同連線），共用省不到連線；只有兩者填同一個自架網址時才省得到，代價是跨外掛跨版本的相容承諾、生命週期綁在一起、兩把身分無法共用一條 NIP-42 連線。改以各自連線＋延遲連線、閒置斷線、Coffice 在 CinderSync 啟用時不啟動 Vault 同步訂閱壓低成本；列有重新評估的條件。
10. ~~**PQ 模式每則訊息的 header 成本**（CC G5）：每則固定 2,314 B。評估只在 DH 步進時附 KEM 欄位。~~ **已完成（v0.28.0，[ADR 0033](0033-pq-ratchet-header-cost.md)）**：後量子線路格式 v2——ML-KEM 輪次與 DH 步進脫鉤（預設每方每 50 則一輪）、延後到對方下一步混入、每條鏈只附一次；每則 header 2,314 → 50 B（雙向輪流攤提 94 B），星狀會話一則按鍵 2,395 → 131 B。hello 以 `pqf` 協商，v0.27 的後量子對端明確拒絕（古典照常互通）；選擇性丟包由看門狗偵測後關閉。
11. 本 ADR 自己的後續：
    - ~~真實帳號實測~~（2026-09-29 已完成 OAuth token 路徑，見〈驗證的範圍〉）；
    - 評估 CLI 的 `relay deploy --provider=cloudflare` 在有 `--api-token` 時改走 REST 路徑，就不再需要 npx；
    - 評估宣告式 `exports`。

## Consequences

- ＋ 外掛（桌面與行動版）可以一鍵部署自己的中繼，不需要 Node、wrangler 或任何伺服器。
- ＋ wrangler 路徑與 REST 路徑共用名稱規則、綁定、遷移、環境變數與健康檢查，不會分岔。
- ＋ 重新部署是冪等的，也能接手 wrangler 部署過的站。
- － 這個子路徑多了約 62KB 的 Worker 原始碼（只有匯入它的應用才會帶）。
- － 每次改中繼程式都要重新產生 bundle；`npm run build` 會自動做，測試與 `check` 會擋住忘記的情況。
- － 多了一個 devDependency（esbuild，釘確切版本）。
- － 錯誤碼分類有一部分是觀察值（見 §7）。
