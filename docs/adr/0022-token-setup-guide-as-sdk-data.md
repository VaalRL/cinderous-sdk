# 0022. 建立 Cloudflare Token 的步驟說明由 SDK 以資料匯出；維持使用者 Token

- Status: Accepted
- Date: 2026-09-29
- 相關：ADR 0021（REST 部署、預填 Token 建立頁）、0019（中立預設值）；外掛 `obsidian-cindersync-dev`、`obsidian-cinder-coffice-dev` 的 ADR 0004

## Context

使用者決定一鍵部署先用「預填權限的 API Token 建立頁」，不做 OAuth，但步驟要寫清楚，讓一般使用者照做不會卡。兩個 Obsidian 外掛的設定頁都要顯示同樣的步驟與疑難排解。各自寫一份，遲早會跟 SDK 的權限、Token 名稱或錯誤分類對不上。

## Decision

### 1. 步驟文字是 SDK 的資料，外掛直接渲染

- `./deploy/cloudflare-api` 新增 `CLOUDFLARE_TOKEN_SETUP_GUIDE`（`zh-TW`、`en`），每種語言有：
  - `prerequisites`；
  - `steps`：有序陣列，第 0 步是事前準備，共 9 步，每步有穩定的 `id`、`title`、`body`；
  - `troubleshooting`：以 `CloudflareApiError.kind` 為鍵，每項有 `symptom`、`cause`、`fix`；
  - `links`、`notes`。
- 權限標籤取自 `REQUIRED_TOKEN_PERMISSIONS`，Token 名稱取自 `DEFAULT_TOKEN_NAME`，建立頁網址取自 `buildTokenCreationUrl()`，不重複寫死。
- `CloudflareErrorKind` 改由 `CLOUDFLARE_ERROR_KINDS` 常數陣列推出。新增 kind 時，`troubleshooting` 的 `Record` 型別讓 typecheck 失敗，測試也會失敗。
- 自訂名稱用 `buildCloudflareTokenSetupGuide({ tokenName, appName })`。應用名稱預設 `Obsidian`（`DEFAULT_GUIDE_APP_NAME`），因為目前會部署中繼的只有兩個 Obsidian 外掛；遊戲不部署中繼。
- 純資料、深度凍結、可 JSON 序列化；不引用 Node 模組（零 Node 守門測試照舊）。
- 人讀的版本在 `docs/guides/cloudflare-api-token.md`，內容與資料一致；外掛 README 自足地寫一份，註明設定頁的文字來自 SDK。

### 2. 維持使用者 Token（`accountId=*`），不改用帳號擁有的 Token

查證（2026-09-29）：

- 帳號擁有的 Token 要打 `GET /accounts/{account_id}/tokens/verify` 驗證；打 `GET /user/tokens/verify` 會回錯誤碼 1000「Invalid API Token」，即使 Token 有效。
  - 官方 API 參考：<https://developers.cloudflare.com/api/node/resources/accounts/subresources/tokens/methods/verify>
  - 實際案例：<https://github.com/noorinalabs/noorinalabs-deploy/issues/511>
- 官方〈Account API tokens〉頁把 Workers 列為支援，但**沒有寫** `GET /accounts` 對帳號 Token 的行為。這點無法從文件確認，也沒有實測。
  - <https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/>
- 帳號 Token 的預填網址是 `/?to=/:account/api-tokens`，使用者在儀表板上選帳號，但網址不會把選了哪個帳號傳回來。外掛要先知道 `accountId` 才能驗證，等於多一步「請貼上帳號 ID」。
- 建立帳號 Token 需要帳號層級的管理權限；使用者 Token 任何成員都能建立。

決定：

- 預設維持使用者 Token：`verifyToken()` 打 `/user/tokens/verify`，`listAccounts()` 找出帳號，一把 Token 貼上就能部署。
- 「All accounts」的範圍比較大，所以用步驟 3 引導有多個帳號的人改成「Include → 單一帳號」；步驟 4 建議設很近的 TTL；步驟 8 建議部署完就刪除。外掛本來就不保存 Token（外掛 ADR 0004）。
- `buildTokenCreationUrl({ kind: 'account' })` 與 `verifyToken({ accountId })` 保留給需要帳號 Token 的應用，本 ADR 不改。

### 3. 疑難排解如實描述 SDK 行為

- `health`：`deployCloudflareRelayViaApi` 預設重試 20 次、每次間隔 3 秒，約 1 分鐘；沒過就丟錯，不回報成功。說明寫「等幾分鐘再部署一次」，因為新子網域的 DNS 可能要更久。
- `name-conflict` 同時涵蓋「同名 Worker 不是中繼」與「子網域已被使用」（錯誤碼 10031）。
- 費用只寫「以官方方案為準」與查證當天的免費額度，附來源。

## Consequences

- ＋ 兩個外掛的步驟文字只有一個來源，權限或名稱改了會一起改。
- ＋ 錯誤分類與說明綁在一起，漏補會被 typecheck 與測試擋下。
- － 步驟文字進了函式庫，改措辭也要發 SDK 版本、外掛升版。
- － Cloudflare 改儀表板介面時，步驟可能過時；按鈕名稱照英文介面原文，要人工追蹤。
- － 使用者 Token 的預設範圍是 All accounts，要靠步驟說明引導縮小。
