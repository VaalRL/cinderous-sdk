# 0008. 中繼白名單、純記憶體模式、`cinderous` 命令列與一鍵部署

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0006（relay-lite 預設純記憶體、`--persist` 才寫 SQLite；CLI 叫 `cinderous relay deploy`）、ADR 0007（中繼搬進 SDK，這次只搬家、新功能另做）；PRD 5.2、5.3、5.4

## Context

ADR 0007 把 Cinderous 的中繼原樣搬進 SDK。PRD 5.2 列了三種架站場景，要兌現它們還缺四樣：

1. 白名單 `ALLOWED_PUBKEYS`（場景 B 的 Docker 範例、5.3 的 `--allowed-pubkeys`）；
2. relay-lite 預設純記憶體、`--persist` 才寫 SQLite（ADR 0006 拍板）；
3. `cinderous relay deploy`（場景 C）與程式化部署 API（5.3.4）；
4. `cinderous estimate`（5.4.3）。試算器函式庫已有，缺命令列。

## Decision

### 1. 白名單沿用既有的 `allowedAuthors`

`RelayCore` 早就有 `allowedAuthors`（Cinderous ADR-0044 企業封閉模式：名單外的事件回 `blocked:`）。這次只補三件事：

- 環境變數 `ALLOWED_PUBKEYS` 的解析：`host-config.allowedPubkeysFrom`，接受 `npub` 或 hex 混用，以逗號、空白或換行分隔。
- 兩個宿主都接上：
  - Worker：**所有路徑一體適用，含 `/app/` 車道**。只擋嚴格平面的話，私人站換個路徑就被繞過。
  - Node 主機。
- NIP-11 的 `restricted_writes` 在有白名單時為 `true`。

🔴 **名單寫錯任何一筆，整座站拒絕啟動**：Node 主機丟例外，Worker 的 Durable Object 建構失敗。另外兩種做法都更糟，而且都不會報錯：

- 略過錯的那筆：那個人被擋在門外，站方不知道為什麼。
- 把整份名單當沒設：私人站默默變成開放中繼。

白名單**只管寫入**。讀取仍靠 NIP-42 與收件匣 ACL；而且中繼上的內容本來就全是密文。這和 Cinderous ADR-0044 的語意相同。

### 2. 純記憶體是 Node 主機的選項，不是另一支程式

- `startNodeRelay(env, { memory: true })` 改用 `MessageStore`（純 JS），**完全不載入 `node:sqlite`**。沒有 SQLite 的 Node 版本也能起純記憶體站。
- 不給選項時照舊寫 SQLite 檔。Cinderous 的 Docker 與樹莓派部署行為不變。
- 預設純記憶體放在 **CLI 那一層**：`cinderous relay start` 預設記憶體，加 `--persist` 才寫檔。這不會改變函式庫既有呼叫端的行為。
- 沒有照 PRD 另寫一支「< 80 行的 relay-lite 腳本」：那會是第二套中繼邏輯，正是 ADR 0007 要消除的東西。

### 3. `@cinderous/client/deploy`：產生設定，交給 wrangler

`deployCloudflareRelay()` 的步驟：

1. 在工作目錄（預設 `.cinderous/<名稱>/`）寫出 `wrangler.toml`，內容：
   - `RELAY_ROOM`／`RelayRoom`，以 SQLite 遷移；
   - observability；
   - 有白名單時加上 `[vars] ALLOWED_PUBKEYS`。
2. 寫出入口檔 `entry.mjs`：注入 SDK 版號，再轉出 SDK 的 Worker。
3. 執行 `npx wrangler@4 deploy --config …`。
4. 從輸出抓 workers.dev 網址，打 `/healthz` 重試到回 `ok`。
5. 回傳 `wss://` 端點。

幾個取捨：

- **不自己打 Cloudflare API**：
  - 登入（OAuth）、建立 Durable Object、上傳都交給 wrangler，不另寫一套會和 wrangler 分岔的行為。
  - 代價是需要能執行 `npx`。
- **白名單放 `vars`，不用 `wrangler secret put`**（PRD 5.3.2 寫的是 secret）：
  - 公鑰本來就是公開的。
  - 放在 vars 會跟著設定檔走，儀表板上也看得到。
  - secret 還得等 Worker 已經存在才能設定，一鍵流程要多一步。
- **帳號要明確帶**：`apiToken`／`accountId` 會轉成 `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`。wrangler 會沿用上次登入的帳號，部署到錯的帳號並不會報錯。
- **健康檢查沒過就回報失敗**，不回報成功。新 Worker 上線要幾秒，所以預設重試 10 次、間隔 3 秒。
- 部署前先驗證 Worker 名稱與白名單，錯了就不呼叫 wrangler。
- 不加 `nodejs_compat`：SDK 的 Worker 沒用到 Node API，而 Cinderous 錨點跑的就是不加的設定。

### 4. `cinderous` 命令列

- 單一 bin `cinderous`，使用 `node:util` 的 `parseArgs`，不加相依。
- 指令：
  - `relay start`
  - `relay deploy`
  - `estimate`（旗標照 PRD 5.4.3，另加 `--json`）
- 旗標解讀與執行分開：`runCli(argv, deps)` 的起站、部署、寫檔都經由注入，測試全用替身。
- 結束碼：0 成功，1 執行失敗，2 用法錯誤。
- 壞值（例如 `--devices=0`）直接報錯，不默默換成預設值：否則試算結果會悄悄變成另一個情境。
- `relay deploy` 沒給白名單時警告「這會是開放中繼」（PRD「開放前警示」）。
- 部署成功後把端點寫進 `.env.cinderous`。

### 5. SDK 的 CI

`.github/workflows/ci.yml` 在 Node 22、24 跑 `npm run check`，內容是：

1. 型別檢查；
2. 測試；
3. 打包；
4. **確認提交的 `dist/` 與原始碼一致**。遊戲以 git 相依安裝，安裝時不會跑 build，`dist/` 忘了重建，遊戲就會拿到舊程式。

## 還沒做（刻意留到之後）

- `--provider=docker|fly`：目前會明確回報不支援。
- `--subdomain`：wrangler 沒有以單次部署指定子網域的方式。
- 互動模式下自動列出帳號供選擇、部署後的配對 QR Code。
- Docker 映像 `cinderous/relay-lite`：要發布到公開 registry，等 SDK 公開再做。

## Consequences

- ＋ PRD 5.2 的場景 B（自架）與場景 C（一鍵上 Cloudflare）可以用了，試算器也有命令列。
- ＋ 白名單只有一種寫法、一套解析；Worker、Node、CLI、部署 API 共用。
- ＋ 真機驗證：
  - `relay start` 起純記憶體站，白名單生效，沒有產生 SQLite 檔；
  - `relay deploy --dry-run` 經真的 wrangler 4.141 打包成功，綁定正確。
- － 部署依賴 `npx` 與網路（第一次會下載 wrangler）。
- － 部署產生的入口檔用**絕對路徑**指向本機 SDK 的 `dist/`。換機器要重新執行 `relay deploy`，不能搬走 `.cinderous/` 目錄。
