# 0117. `cinderous init` 精靈：題目從描述表推出、危險選項打字確認；部署說明的安全檢查清單改由 `dangerous` 產生

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「先實作精靈與檢查清單」
- 日期：2026-10-28
- 對應：SDK ADR 0050（部署設定器；本 ADR 做掉它 P1 的精靈）、0116（部署設定參考頁，決策 4 說 `dangerous` 還沒有程式在用）

## Context

`DEPLOY_OPTION_SPECS` 有四個欄位標了 `dangerous`：`node.trustProxy`、`site.openFileRelay`、`site.appLanes`、`site.appLanePow`。ADR 0050 的計畫是「P1 精靈要打字確認；說明裡列進安全檢查清單」，但兩件事都還沒做：

- 精靈（`cinderous init`）不存在，CLI 裡只有一行「init 精靈與 migrate 在 P1」的註解。開發者要自己照 JSON Schema 寫設定檔。
- 部署說明（`renderDeployGuide`）第 9 節的安全檢查清單是手寫的，沒有讀 `dangerous`：
  - `site.appLanes` 沒有列。它是最難回頭的選項（改名單＝換一顆 DO，舊資料拿不回來）。
  - docker 目標不管有沒有開 `trustProxy`，都會列一條提醒。
  - 文字是另外寫的，和描述表的說明不同步。

## Decision

### 1. 精靈的核心不碰 Node：`src/deploy/config/wizard.ts`

- `runInitWizard(io, opts)`：`io` 只有 `ask(question) → Promise<string>` 與 `say(line)`。CLI 接 `node:readline`，測試用腳本；之後的網頁設定器（ADR 0050 P3）也能用同一份。
- **題目從描述表推出**（`wizardQuestions(target, advanced)`），不另外維護題目清單：
  - 依描述表的順序；只問適用這個目標與宿主的、中繼用的欄位。
  - 不問：`configVersion`、`sdk`（精靈寫入）、`target`（另外先問）、`service`（精靈只產生中繼的設定）、`record` 型別（容量設定、贊助管道：一行寫不清楚，直接改設定檔）。
  - 不進「進階」時只問 `basic`、`access`、`vault` 題組（ADR 0050 風險 5），**加上這個目標的必填欄位**（例如 home-tunnel 的 `tunnel.hostname` 與 Tunnel Token）。`--advanced` 才問其他題組。
- **輸入解讀**（`parseWizardAnswer`）：Enter＝不設（用預設）；布林收 y／n／是／否；清單用半形或全形逗號、空白分隔。**秘密只問環境變數的名稱**（ADR 0050 §4），可以是秘密的欄位用 `$env:NAME`。
- **驗證用 `validateDeployConfig`**（與 `config validate` 同一份規則與訊息），分兩種：
  - 只跟這一題的值有關的錯誤（型別、範圍、格式、必填、壞的公鑰或車道名稱……，`FIELD_ERROR_CODES`）：當場重問，最多 3 次，之後停止、不寫檔。不互動模式每題都回空字串，必填題因此不會無限重問。
  - 跨欄位的錯誤（例如「開了檔案塊卻沒有白名單」，後面的 `openFileRelay` 可能會解決）：先提醒，問完一輪後回頭重問那些題一次。
- **危險選項打字確認**：值「開了」（布林 true、數字大於預設、清單不是空的）就印出 🔴 與描述表的說明，要打出欄位名稱的最後一段（`openFileRelay`、`appLanes`……）才開；打錯或直接 Enter＝不開，也不寫進設定檔。
  - 目標強制的值不算：fly 與 home-tunnel 的 `trustProxy` 一定要開（`validateDeployConfig` 擋 false），不再問一次確認。

### 2. 「開了哪些危險選項」只有一份判斷：`specs.ts`

`isDangerousValue(spec, value, target)`、`dangerousChoices(config)`、`dangerConfirmWord(spec)` 放在描述表旁邊，從 `@cinderous/client/deploy/config` 匯出。精靈和部署說明都用它。

### 3. 部署說明的安全檢查清單：每個開了的危險選項一條

第 9 節原本手寫的三條（docker 的 `trustProxy`、`openFileRelay`、`appLanePow`）改成：

```
- [ ] 🔴 `<欄位>`：<描述表的說明>
```

`dangerousChoices(config)` 列出的每一項一條，中英說明直接用描述表的。白名單、`.env`、各目標的 Token 那幾條不變。

### 4. CLI：`cinderous init`

```bash
npx cinderous init [--out cinderous.config.json] [--provider <目標>] [--advanced] [--yes] [--force] [--locale zh-TW|en]
```

- 寫檔用 `relay build` 同一個 `renderDeployConfigFile`（固定的鍵順序，記下 SDK 版號）。
- 檔案已經存在：不覆寫，要加 `--force`。
- 問完還有錯誤：照寫（答案不會白答），列出錯誤、回 1，提示改檔後跑 `config validate`。
- `--yes`：不詢問、全部用預設值，要搭配 `--provider`。預設值都不是危險值，所以 `--yes` 不會打開任何危險選項。必填題答不出來時停止，不寫檔。
- `CliDeps.prompt`：真的 CLI 用 `node:readline`。讀到的行先排隊，所以管線一次送進好幾行也拿得到。輸入結束時，等待中的題目以錯誤結束，不會卡住。沒有 `prompt`（不能互動）又沒加 `--yes` 時，說明要加 `--yes --provider`。
- 題目與說明的語言：`--locale`，預設 zh-TW（其他 CLI 訊息仍是中文）。

## 不做（這次）

ADR 0050 P1 的其他項目還沒做：`config migrate`、`cloudflareApiOptionsFromConfig`＋REST `secret_text`、隱藏輸入與 `.secrets/`。精靈只問環境變數的名稱、不收秘密值，所以目前不需要隱藏輸入。

## Consequences

- ＋ `dangerous` 從「只是標記」變成真的有作用：精靈要確認、說明會列出、參考頁會寫明（ADR 0116 決策 4 的文字一起改）。
- ＋ 新增或改一個欄位，精靈的題目、說明、驗證都跟著描述表變，不用另外改精靈。
- ＋ `appLanes` 現在會出現在安全檢查清單上（原本漏掉）。
- － docker 沒開 `trustProxy` 時，清單不再列那條提醒（只列開了的）。開了才列，與其他危險選項一致。
- － 跨欄位錯誤只回頭重問一次；還有錯就照寫、回 1，要自己改設定檔。

## 驗證

- `tests/deploy/deploy-wizard.test.ts`（20 個）：
  - 題目（基本、必填、進階、只問適用的）、輸入解讀（含秘密只收名稱）；
  - 危險值的判斷（含 fly／home-tunnel 的 `trustProxy` 不算）；
  - 精靈的流程：全部 Enter、先問目標、當場重問、3 次後停止、打對確認字才開、打錯不開並回頭重問跨欄位的題、進階的 `appLanes`、英文；
  - 檢查清單：中英兩種語言每個開了的危險選項都列出、docker 開了才列 `trustProxy`、fly 不列、沒開就沒有。
  - 故意把確認改成一律通過、把清單的迴圈拿掉，各有 2 個測試失敗；改回後通過。
- `tests/cli/cli-config.test.ts`（新增 8 個）：寫檔後 `config validate` 通過、確認字打錯不寫進去、`--yes`、用法錯誤、不覆寫與 `--force`、必填題停止不寫檔、不能互動的提示、英文。
- `tests/deploy/deploy-package.test.ts` 的快照：cloudflare 多了 `site.appLanes` 一條、docker 少了 `trustProxy` 一條，其餘不變。
- 真的 CLI（`dist/cli/index.js`，管線輸入）：docker 目標問完寫出設定檔（`openFileRelay` 打字確認後才開）；`config validate` 通過；`relay build` 產生的 `README-DEPLOY.md` 檢查清單有 `site.openFileRelay`。輸入提前結束時印「輸入已經結束，精靈停止」、回 1、不寫檔。
- 部署設定參考頁重新產生（危險選項的說明、開頭的指令多了 `cinderous init`）。
