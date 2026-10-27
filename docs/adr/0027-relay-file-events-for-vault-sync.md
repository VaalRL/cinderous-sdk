# 0027. Vault 同步需要中繼接受檔案事件：部署可設 `MAX_FILE_MB`、拒收分類成明確狀態、NIP-11 預先偵測

- Status: Accepted
- Date: 2026-09-29
- 加註（2026-10-04，ADR 0051）：§2「沒有白名單時開檔案事件要 `openFileRelay`」對**私人路徑模式**（`privateLane`：開放寫入＋不可猜的隨機路徑、`LANES_ONLY`）放寬，路徑本身就是門票；沒有私人路徑時規則不變。
- 相關：ADR 0021（REST 一鍵部署、`relayWorkerVars`）、0018（Docker／Fly）、0008（白名單、CLI）、0025（協調器外層是 kind 1060）、0026（P2P 批次）；Cinderous ADR-0162（檔案塊是企業限定、`MAX_FILE_MB`）

## Context

2026-09-29 發現：

- `relay-core.ts` 在 `acceptFileEvents` 沒開時整類拒收 kind 1060（`OK false "blocked: 檔案事件未啟用（MAX_FILE_MB）"`）；只有 `MAX_FILE_MB >= 1` 才開（`host-config.acceptFileEvents`）。
- v0.19.0 起的 REST 一鍵部署（`deployCloudflareRelayViaApi` → `relayWorkerVars`）、wrangler、Docker、Fly 路徑**都沒有辦法設** `MAX_FILE_MB`。實測部署的站 NIP-11 是 `cinder_accepts_files: false`；兩座 Cinderous 錨點也是 false。
- v0.22.0 的 Vault 協調器外層就是 kind 1060（ADR 0025 §5）。所以 CinderSync 用一鍵部署建出來的中繼，**所有同步事件都會被拒收**。假中繼測試不經過 `RelayCore`，沒抓到。
- 被拒時 `NostrVaultTransport.send` 丟一般的「沒有中繼接受」，協調器以指數退避一直重試，狀態只是 `error`，外掛無從得知原因。

## Decision

### §1 部署可以開檔案事件（SSOT：`shared.maxFileMbVar`）

- 所有部署路徑多兩個選項：`maxFileMb`（1–1024 的整數，寫進 `MAX_FILE_MB`）與 `openFileRelay`。
  - Worker：`relayWorkerVars`（wrangler.toml 的 `[vars]` 與 REST 上傳的 `plain_text` 共用）。
  - 容器：`relayEnvironment`（Docker、Fly）。
  - 命令列：`cinderous relay deploy --max-file-mb <MB> [--open-file-relay]`、`cinderous relay start --max-file-mb <MB> [--open-file-relay]`（`relay start` 同樣要白名單）。
- 兩條路徑呼叫同一個 `maxFileMbVar` 驗證，不會分岔。
- 匯出建議值 `VAULT_SYNC_MAX_FILE_MB = 17`（涵蓋檔案塊層上限 48,000 B × 360 ≈ 16.5 MB；中繼目前只看是否 ≥ 1）。

### §2 預設仍然不開；開放中繼要另外明確允許

- **預設不開**（維持 ADR-0162 的「公共站零儲存風險」）。遊戲與 Cinderous 聊天用的中繼不需要檔案塊，重新部署既有的站也不會因為升級 SDK 而突然開始存檔案。
- **沒有白名單時開檔案事件＝部署前丟例外**，除非 `openFileRelay: true`。理由：中繼的檔案塊配額是「每位收件人 4,000 顆、7 天」，收件人（`#p`）可以隨便編，開放中繼等於任何人都能把儲存塞滿。Vault 同步的中繼本來就該是只有自己裝置能寫的私人中繼。
- 外掛（CinderSync、Coffice）的一鍵部署應該傳 `maxFileMb: VAULT_SYNC_MAX_FILE_MB` 並帶白名單（自己各裝置的公鑰）。這是外掛那邊要改的，SDK 不替它決定。

### §3 對 Cloudflare 免費額度與儲存的影響

檔案塊存在 Durable Object 的 SQLite。Cloudflare 文件（2026-09 讀取）：

| | Workers Free | Workers Paid |
|---|---|---|
| 儲存 | 5 GB（總量） | 含 5 GB-month，之後 $0.20／GB-month |
| 寫入列數 | 100,000／天 | 含 5,000 萬／月 |
| 讀取列數 | 500 萬／天 | 含 250 億／月 |

- 每顆檔案塊約 131 KB（48,000 B 明文包兩層 NIP-44），7 天到期。每位收件人最多 4,000 顆 ≈ 500 MB。個人 Vault 有 3 台裝置時，最壞約 1.5 GB，在免費的 5 GB 之內。
- 寫入列數：一顆事件是一列（加上索引），每天 10 萬列在個人用量下綽綽有餘；大量同步改走 P2P（ADR 0026），不佔這個額度。
- 所以開檔案事件的私人中繼可以留在免費方案；開放中繼則沒有上限可言（§2 擋住）。

### §4 拒收分類成明確的錯誤與狀態

- `isFileEventsDisabledReason(reason)`：`blocked:` 前綴而且提到 `MAX_FILE_MB`。契約測試直接拿 SDK 自己的 `RelayCore` 拒收原因來比，改了訊息就會失敗。中繼程式碼本身沒有改（Worker 打包不變）。
- `NostrVaultTransport.send`：**每一座**中繼都以這個原因拒收時，丟 `RelayRejectsFilesError`（`code: 'relay-rejects-files'`，附中繼網址）；有一座只是斷線等其他原因時，仍是一般錯誤、照常退避。自訂傳輸層丟任何 `code === 'relay-rejects-files'` 的錯誤也一樣被認得（`isRelayRejectsFilesError`）。
- 協調器收到時：
  - `status().blocked = 'relay-rejects-files'`，`state` 為 `error`；
  - `error` 事件（`context: 'relay-rejects-files'`）**只發一次**（狀態轉換時）；
  - 不再指數退避，直接用最長的退避（預設 5 分鐘）偶爾探一次——站方之後開了就自動恢復，成功送出一則就清掉 `blocked`；
  - 有 `peers` 時進入批次模式（ADR 0026）：只要有待送出的版本就改走 P2P，在線的裝置之間照樣同步。

### §5 連線前預先偵測：`checkRelayAcceptsFiles`

- `checkRelayAcceptsFiles(relayUrl, { fetch })`：`wss://` 換成 `https://`，帶 `Accept: application/nostr+json` 讀 NIP-11，回 `acceptsFiles`：
  - `true`／`false`：中繼宣告了 `cinder_accepts_files`；
  - `null`：沒有這個欄位（不是 Cinderous 中繼或版本太舊），只能實際送送看。
- HTTP 錯誤或不是 JSON 就丟例外。`fetch` 可注入（Obsidian 的 `requestUrl` 包一層）。在 `./sync/vault`，零 Node。

## 測試

- `tests/sync/vault/relay-files.test.ts`（9）：`RelayCore` 拒收原因的契約；其他 `blocked:` 原因不算；傳輸層全拒 → `RelayRejectsFilesError`、原因混雜 → 一般錯誤；**假中繼拒收 1060 的情境**：狀態 `blocked`、錯誤只報一次、半小時內只探幾次、站方開啟後自動恢復並同步；有 P2P 時雙方照樣同步；NIP-11 偵測（讀 `buildRelayInfo` 的輸出，開與不開、非 Cinderous 中繼、HTTP 錯誤、不是 JSON、網址轉換）。
- `tests/deploy/relay-file-events.test.ts`（5）：Worker 變數、wrangler.toml、容器環境變數；開放中繼沒有 `openFileRelay` 就拒絕；壞值；REST 部署在打任何 API 之前就拒絕；命令列旗標（`relay start` 沒有白名單拒絕）。

## 沒有改的

- 兩座 Cinderous 錨點的設定（正式環境，不在這一批）。
- 中繼程式碼與它的拒收訊息。

## Consequences

- ＋ 一鍵部署出來的中繼可以給 Vault 同步用；外掛能在連線前提示、同步時看到明確原因，而不是永遠「同步中／錯誤」。
- ＋ 開放中繼不會不小心變成誰都能存檔案的儲存空間。
- － 外掛必須記得傳 `maxFileMb`（沒傳就是不收）；README 與本 ADR 寫明。
- － 分類依賴拒收訊息裡的 `MAX_FILE_MB` 字樣；由契約測試守著。
