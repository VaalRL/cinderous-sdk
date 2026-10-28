# 0116. 部署設定參考頁：從 `DEPLOY_OPTION_SPECS` 產生、提交進 `docs/reference/`

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「先做 部署設定參考頁」（ADR 0113〈後續〉P2）
- 日期：2026-10-28
- 對應：SDK ADR 0050（部署設定器、描述表）、0113（說明網站）、0115（API 參考）

## Context

`cinderous.config.json` 的每個欄位都寫在 `DEPLOY_OPTION_SPECS`（ADR 0050 §3）一次：型別、範圍、預設、適用的宿主與目標、是否秘密、`relay deploy` 的旗標、中繼的環境變數、中英說明。JSON Schema、設定檔驗證、部署說明都從它推出，但沒有一頁讓人從頭讀到尾、或查「這個環境變數是哪個欄位」。

- API 參考（ADR 0115）只看得到 `DEPLOY_OPTION_SPECS` 是一個陣列，看不到裡面的內容。
- JSON Schema 有型別與範圍，但沒有旗標、環境變數、宿主限制，說明也只有一種語言。

## Decision

1. **產生器是純函式**：`site/deploy-reference.mjs` 的 `renderDeployReference(specs, lang)`，產出中英兩份 Markdown：
   - 開頭：檔案是什麼、三個 CLI 指令、欄位／旗標／環境變數／秘密的意思；
   - 總覽表：欄位、旗標、環境變數各一欄。不連到各節：GitHub 與 VitePress 對 `site.maxTtlDays` 這種標題產生的錨點不同；
   - 依題組（`group`）分節，每個欄位一節：說明、型別（範圍、長度、清單上限）、可用的值、格式、預設、旗標、環境變數、秘密、宿主、目標、服務、必填於、危險標記。
   - 說明裡反引號以外的 `<`、`>` 跳脫（`wss://<host>/…` 在 GitHub 上會被當成 HTML 吃掉）。
2. **產出提交進 repo**：`docs/reference/deploy-options.md`（英文）與 `deploy-options.zh-TW.md`。GitHub 上直接可讀，網站把它們當一般頁面（ADR 0113），放進側欄「自架中繼」。
3. **不會過時**：`tests/site/deploy-reference.test.ts` 拿 `src` 的描述表比對已提交的兩個檔案；改了描述表沒重新產生（`npm run docs:reference`，讀 `dist`）就失敗——與 `dist` 的做法相同。
4. **危險標記照實寫**：`dangerous` 目前沒有程式在用（精靈的打字確認、部署說明的檢查清單都還沒做），頁面只寫「開之前先讀完說明」。
   - 補充（2026-10-28，SDK ADR 0117）：精靈的打字確認與部署說明的檢查清單都做了，頁面改寫成「`cinderous init` 要打出選項名稱才會開，部署說明也會把它列進安全檢查清單」；開頭的指令多了 `cinderous init`。

## Consequences

- ＋ 描述表是唯一的來源：改一個欄位，參考頁、Schema、驗證、部署說明一起變。
- ＋ 用環境變數自己跑中繼的人，也能從總覽表查到對應的欄位與旗標。
- － 多兩個產生出來的檔案（各約 670 行），改描述表要記得跑 `npm run docs:reference`（測試會提醒）。
- － `record` 型別（容量設定、贊助管道）只寫「見 JSON Schema」，沒有展開它的結構。

## 驗證

- `tests/site/deploy-reference.test.ts`：每節的內容、中文版、秘密／必填／危險／宿主、列舉與長度與格式、`<…>` 跳脫、總覽表；已提交的兩個檔案與描述表一致；每個欄位都在頁面上（先失敗，實作後通過）。
- `npm run docs:build`：沒有壞掉的連結；頁面上 Schema 連到 GitHub、ADR 0050 連到網站的頁面、`<host>` 顯示成文字。
