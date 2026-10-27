# 0055. REST 部署進度的子步驟 id 與雙語訊息；名稱檢查的雙語問題

- 狀態：**已接受（Accepted，2026-10-04）**——實作於 v0.43.0
- 日期：2026-10-04
- 對應：CinderSync ARCHITECTURE §5 **G20**（外掛 ADR 0024 設定頁的部署區塊）。相關：本 repo ADR 0021（REST 部署）、0022（雙語 Token 指南）、
  0050（`collectRelaySiteIssues`、`DeployIssue`）、0051／0052（私人路徑不回顯）。

## Context

`deployCloudflareRelayViaApi` 的 `onProgress.message`、部署前的名稱檢查（`assertRelayName`）只有中文；進度只有粗的 `step`，
`config` 同時代表驗證 Token 與確認子網域。外掛只好依 `step` 顯示自己的中英文字、名稱錯誤顯示自己的在地化提示。

## Decision

- **進度**：`DeployProgress` 的參數改成 `DeployProgressStatus`，多兩個選用欄位（wrangler／docker／fly 不變）：
  - `substep`：`verify-token`、`account`、`subdomain`、`live-config`（重新部署時讀線上設定）、`live-config-skipped`（讀不到、略過變更檢查）、
    `upload`、`route`、`health`、`done`（`CLOUDFLARE_DEPLOY_SUBSTEPS` 依出現順序）；
  - `messages: { 'zh-TW', en }`；`message` 照舊是中文（與 `messages['zh-TW']` 相同，相容）。
  - REST 部署每個進度都帶；新增「查詢帳號」（沒給 `accountId` 時）與「讀取線上設定」兩個進度。OAuth 不驗 Token、給了帳號就沒有對應的子步驟。
  - 🔴 雙語訊息同樣不含私人路徑（ADR 0051）：完成時只說「（私人路徑）／(private path)」。
- **名稱與部署前檢查**：
  - `checkRelayName(name, 'worker' | 'subdomain')`、`checkCompatibilityDate(date)`：與 `assertRelayName`／`assertCompatibilityDate` 同一份規則，回 `DeployIssue`（`path`、`code`、雙語 `message`）或 null；
  - `collectCloudflareApiDeployIssues(opts)`：Worker 名稱、子網域、相容日期、`retireLane`、站台參數（`collectRelaySiteIssues(opts, 'worker')`）一次列出，不丟例外、不連網；
  - `retireLane` 的檢查改成問題清單（`retire-needs-private-lane`、`invalid-retire-lane`、`retire-lane-same`、`invalid-grace-days`），部署時照舊丟第一個的中文訊息（不回顯 id）。
- **不做**：`CloudflareApiError.message` 仍只有中文——錯誤來自 Cloudflare 的回應與網路，外掛已經以 `kind` 加 Token 指南的雙語疑難排解（ADR 0022）顯示；
  若要雙語，下一步是在錯誤上加 `messages`（與這裡同一個形狀），逐一處理每個丟出點。

## 外掛（CinderSync）怎麼改用

- 進度：依 `substep` 顯示，或直接顯示 `messages[locale]`；拿掉依 `step` 推測的文字。
- 名稱檢查：部署前呼叫 `collectCloudflareApiDeployIssues(opts)`，顯示 `issue.message[locale]`；拿掉自己的在地化提示。

## 測試

`tests/deploy/cloudflare-api-progress.test.ts`：子步驟順序、雙語訊息、`message` 相容、重新部署與讀不到線上設定、私人路徑不出現、OAuth＋指定帳號、
`checkRelayName`、`collectCloudflareApiDeployIssues`、`retireLane` 的問題碼與部署時的例外一致。既有 `cloudflare-api.test.ts` 照舊通過。
