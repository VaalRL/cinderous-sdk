# 0118. TURN 從設定檔設定、Token 以 Worker secret 上傳；`relay deploy --config` 接上 `cloudflare-api`；`config migrate`

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「那繼續 處理 ADR 0050 P1 剩下的：config migrate，以及讓 REST 一鍵部署也能從設定檔帶秘密。」
- 日期：2026-10-28
- 對應：SDK ADR 0050（部署設定器；本 ADR 做掉它 P1 剩下的 `config migrate`、`cloudflareApiOptionsFromConfig`＋REST `secret_text`）、0037（一鍵部署參數；TURN 那一列原本是「不開放（後續）」）、0021（REST 部署）、0064（打包好的 Worker 不含秘密）、0117（精靈）

## Context

ADR 0050 P1 還剩三件事：

1. **REST 部署從設定檔帶秘密**。`deployCloudflareRelayViaApi` 只上傳 `plain_text` 綁定，另外以 `keep_bindings: ['secret_text', 'secret_key']` 保留儀表板上手動設的 secret。中繼目前唯一的執行期秘密是 TURN 的 API Token（`TURN_API_TOKEN`），但 TURN 根本不在 `RelaySiteOptions` 裡（ADR 0037 的表：「不開放（後續）」），要用 TURN 只能自己到儀表板設三個變數。
2. **`relay deploy --config` 對 `cloudflare-api` 目標丟用法錯誤**（「在 P1 才接上」）。外掛要自己把設定檔換成 `deployCloudflareRelayViaApi` 的參數，CLI 也不能用 REST 部署。
3. **`config migrate`**：ADR 0050 §6 寫了「舊版設定檔以 `config migrate` 遷移」，但沒有實作；`validateDeployConfig` 只會警告「這份設定由舊版 SDK 產生」。

## Decision

### 1. TURN 進站台參數；Token 是 Worker secret

- `RelaySiteOptions` 加 `turnKeyId`（→ `TURN_KEY_ID`，英數、`_`、`-`，最長 64）與 `turnTtlSeconds`（→ `TURN_TTL_SECONDS`，60–172800；Worker 預設 86400）。兩個都只適用 Worker（`WORKER_ONLY_SITE_OPTIONS`）：Node 主機沒有 `/turn`。`turnTtlSeconds` 沒有 `turnKeyId` → `ttl-without-turn`。
- 描述表新增 `turn` 題組（`site.turnKeyId`、`site.turnTtlSeconds`、`secrets.turnApiToken`）；JSON Schema、部署設定參考頁、精靈（進階）都從描述表跟著變。
- **Token 不是站台參數**。它放在新的 `RelayWorkerSecrets { turnApiToken?: string }`，`deployCloudflareRelayViaApi` 與 `deployCloudflareRelay` 都收。`relayWorkerSecrets(opts)` 把它換成 `{ TURN_API_TOKEN }`；有 Token 卻沒有 `turnKeyId` 就丟例外（Worker 不會用它，多半是漏設）。🔴 例外訊息只有欄位名稱，不含值。
- **REST**：Token 成為 `secret_text` 綁定，取代線上同名的 secret；`keep_bindings` 不變，所以這次沒帶的 secret（例如儀表板上另外設的）照舊保留。沒給 Token＝不送 `secret_text`，沿用線上已經有的。
- **wrangler**：`wrangler deploy` 成功後跑 `npx wrangler@4 secret put TURN_API_TOKEN --config <path>`，**值走 stdin**，不進參數、環境變數與任何檔案（`wrangler.toml` 只有 `TURN_KEY_ID`）。`CommandRunner` 因此多一個可選的 `input` 參數；沒給時 stdin 照舊繼承終端機（首次登入要能互動）。`--dry-run` 不上傳 secret；`secret put` 失敗＝部署失敗，不回報成功。
- 設定檔裡是 `secrets.turnApiToken: { "$env": "NAME" }`（沒給讀 `TURN_API_TOKEN`）。部署包：`.env.example` 與 `.dev.vars.example` 列出 Token 的變數；說明的第 3 節說明 Token 怎麼放，第 4 節教 `wrangler secret put TURN_API_TOKEN`，第 8 節成本寫明 **TURN 流量由 Cloudflare Realtime 另外計費、不在 Workers 免費額度內**，第 9 節安全檢查清單多一條 Token 的處理。都只在設了 `turnKeyId` 時出現。

### 2. `cloudflareApiOptionsFromConfig(config, env)`

放在 `@cinderous/client/deploy/config`（零 Node；只有型別依賴 REST 部署本體，守門測試照舊）：`cloudflare-api` 目標的設定檔 → `deployCloudflareRelayViaApi` 的參數（`fetch`、`onProgress`、`workerSource` 由呼叫端加）。

- 秘密在這裡才從 `env` 讀：Cloudflare API Token（`secrets.cloudflareApiToken`，預設 `CLOUDFLARE_API_TOKEN`）、Account ID（`cloudflare.accountId`，字串或引用）、私人路徑與唯讀寬限期（`resolveSiteSecrets`）、TURN 的 Token。
- 🔴 沒有 Cloudflare API Token 就丟例外，訊息只有變數名稱。REST 路徑沒有 `wrangler login` 可以退回。
- 不是 `cloudflare-api` 目標、或是推播閘道（REST 只部署中繼）→ 丟例外。
- 設定檔要先用 `validateDeployConfig` 驗過；站台參數由部署函式驗證，這裡不重複。

### 3. CLI：`relay deploy --config` 接上 `cloudflare-api`

- `CliDeps.deployCloudflareRelayViaApi`（真的 CLI 接 `@cinderous/client/deploy/cloudflare-api`）。參數來自 `cloudflareApiOptionsFromConfig`，外掛與 CLI 是同一份對應。
- 沒有 Token → 回 1、說變數名稱。`--dry-run` → 用法錯誤：REST 沒有試打包，要先看設定就用 `relay build`，或把目標改成 `cloudflare` 加 `--dry-run`（同一座中繼）。
- `cloudflare`（wrangler）目標也從設定檔帶 TURN 的 Token 給 `deployCloudflareRelay`。

### 4. `config migrate`

- 純函式 `migrateDeployConfig(input, { sdkVersion })`（`@cinderous/client/deploy/config`）：
  1. 依序套用 `DEPLOY_CONFIG_MIGRATIONS` 裡的格式遷移（一次升一版；缺一步 → `no-migration`）。**`configVersion` 目前只有 1，所以登記表是空的**；要改格式時在這裡加一步、把 `DEPLOY_CONFIG_VERSION` 加一。
  2. `sdk` 改成執行中的版號。🔴 設定檔由較新的 SDK（`sdk-newer`）或較新的格式（`unsupported-version`）產生時拒絕：不降級。
  3. 列出 `sdk`（不含）到這一版（含）之間的 `DEPLOY_AFFECTING_CHANGES`；沒有 `sdk` 欄位就不知道從哪一版來，不列。
  4. 用 `validateDeployConfig` 驗證結果；不改到輸入的物件。
- CLI：`cinderous config migrate [檔] [--dry-run]`。有錯 → 列出、回 1、不寫檔；已經是這一版 → 不寫檔；`--dry-run` → 印出結果不寫檔；否則用 `renderDeployConfigFile`（與 `relay build`、`init` 同一個固定鍵順序）寫回，提示用 `relay build --force` 重新產生部署包。
- `DEPLOY_AFFECTING_CHANGES` 加一筆 0.79.0：TURN 可以從設定檔設定、另外計費。

## 不做（這次）

- 隱藏輸入與 `.secrets/`（ADR 0050 P1 的其他項目）：精靈只問環境變數的名稱、不收秘密值，CLI 讀 `.env`，目前不需要。
- 其他 Worker secret（例如推播閘道的 APNs 金鑰）不經 `RelayWorkerSecrets`：推播閘道不支援 REST 目標，wrangler 路徑另有說明。
- 部署後讀回 secret 確認：Cloudflare 不回傳 secret 的值；以 `/turn` 實際換發來驗。

## Consequences

- ＋ TURN 從「到儀表板手設三個變數」變成設定檔的兩個欄位加一個 `$env` 引用，重新部署不會漏。
- ＋ 外掛與 CLI 用同一個 `cloudflareApiOptionsFromConfig`，設定檔 → REST 參數只有一份對應。
- ＋ `config migrate` 的格式遷移有了登記處；之後改格式不必另想機制。
- － wrangler 路徑每次部署多跑一次 `wrangler secret put`（只在給了 Token 時）。它會產生一個新的 Worker 版本。
- － TURN 另外計費：說明、參考頁與 `DEPLOY_AFFECTING_CHANGES` 都寫了，但部署工具不會擋。
- － `cloudflare-api` 目標沒有 `--dry-run`。

## 驗證

- `tests/deploy/cloudflare-api.test.ts`（新增 4 個）：`TURN_KEY_ID`、`TURN_TTL_SECONDS` 是 `plain_text`、Token 是 `secret_text`、`keep_bindings` 不變、進度訊息不含 Token；沒給 Token 不送 `secret_text`；有 Token 沒 `turnKeyId`、有 TTL 沒 `turnKeyId` → 部署前就拒絕、沒有任何 HTTP 請求。
- `tests/deploy/cloudflare.test.ts`（新增 4 個）：`wrangler secret put` 的參數、值走 stdin、參數／環境變數／進度／`wrangler.toml` 都不含 Token；`--dry-run` 與沒給 Token 不上傳；`secret put` 失敗 → 例外、訊息不含 Token；有 Token 沒 `turnKeyId` → 不跑 wrangler。
- `tests/deploy/deploy-config-cloudflare-api.test.ts`（5 個）：全部欄位、預設變數名稱、沒有 TURN Token、沒有 Cloudflare Token、錯的目標與推播閘道。
- `tests/deploy/deploy-config-migrate.test.ts`（8 個）：v1 只換 `sdk` 並列出中間的變更、已經是這一版、沒有 `sdk`、較新的 SDK／格式、不是物件、遷移後還有錯、以注入的遷移步驟測依序套用與不改輸入、缺遷移步驟。
- `tests/deploy/deploy-package.test.ts`（新增 4 個＋快照）：有 `turnKeyId` 時 `.env.example`、`.dev.vars.example`、`wrangler.toml`、說明（兩種語言）的內容；沒有 TURN 時都不列；`cloudflare-api` 的說明不再說「P1 才接上」。快照只有 `.dev.vars.example` 與 `cloudflare-api` 說明的那幾句改了。
- `tests/cli/cli-config.test.ts`（新增 8 個，取代原本的「P1 才接上」）：`cloudflare-api` 從 `.env` 讀兩個 Token、交給 REST 部署、輸出不含秘密；沒有 Token、`--dry-run`、環境不支援；wrangler 目標帶 TURN Token；`config migrate` 寫回、`--dry-run`、已經是這一版、較新的 SDK 與有錯、用法。
- 真的程序：`defaultRunner` 以 stdin 把值交給子程序（Windows，經 shell）收到的內容相同；`dist/cli/index.js config migrate` 對 0.70.0 的設定 `--dry-run`、寫回、再跑一次「不需要遷移」；`relay deploy --config` 對 `cloudflare-api` 沒有 Token 時回 1、`--dry-run` 是用法錯誤。
- 全部測試 3204 個通過。**沒有對真的 Cloudflare 帳號部署 TURN**（要另外建 TURN 金鑰、會另外計費）。
