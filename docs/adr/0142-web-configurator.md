# 0142. 網頁部署設定器：放在 SDK 說明網站、瀏覽器內產生設定檔／zip 部署包／一行指令，附本機成本試算

- 狀態：**已接受（Accepted，2026-11-18）**——使用者 2026-11-18 裁示：網頁設定器放在 SDK 說明網站（vaalrl.github.io/cinderous-sdk）、要附成本試算（ADR 0050 P3 的 (b)；同時回答 ADR 0050〈使用者裁示〉延後的第 11 題「網頁設定器放哪裡」）
- 日期：2026-11-18
- 對應：SDK ADR 0050（部署設定器；P3 (b)「靜態頁、不部署、不收秘密、不發任何請求、CSP `connect-src 'none'`」）、0117（`cinderous init` 精靈與危險選項打字確認）、0110（公開 repo、不上 npm）、0113（說明網站）、0002（成本試算是決策參考）

## Context

ADR 0050 把部署設定器設計成「以設定檔 `cinderous.config.json` 為核心，CLI 精靈、網頁設定器只是產生它的介面」。P0（設定檔、描述表、`relay build`）、P1（`cinderous init` 精靈，ADR 0117／0137）已做；P3 的 (b) 網頁設定器還沒做，前提「SDK 公開」已達成（ADR 0110、0113，網站已上線），「上 npm」已由 ADR 0110 否決、改以 GitHub tag 相依。

要求（ADR 0050 (b)）：靜態頁、一切在瀏覽器裡做；不部署、不收秘密、不發任何網路請求；選擇不進網址。

## Decision

### 1. 放在 SDK 說明網站（使用者裁示）

- 頁面：`site/configurator.md`（en，網址 `/cinderous-sdk/configurator`）、`site/zh-TW/configurator.md`（`/cinderous-sdk/zh-TW/configurator`），以 VitePress `rewrites` 放到網站根目錄；側欄「自架中繼」、上方導覽、首頁按鈕都有入口（中英）。
- 元件：`site/.vitepress/components/WebConfigurator.vue`，只是薄殼；網站建置時把 SDK 原始碼打包進去（同一個 repo、同一個 tag，不需要另外版號同步）。
- 不另開 repo 或網域：說明網站已經由 GitHub Pages 部署（ADR 0113），多一個頁面不增加維運面。

### 2. 邏輯是純 TS 模組，與 CLI 共用

- `src/deploy/config/web.ts`（從 `@cinderous/client/deploy/config` 匯出，外掛或其他前端也能重用）：
  - `webFormGroups(target, advanced)`：欄位＝`wizardQuestions`（與 `cinderous init` 同一份描述表、同一套「不問」的規則），依題組分好；`basic`／`access`／`vault` 以外的題組是「進階」，預設收合。
  - `setWebField(config, spec, raw, confirm?)`：解析用 `parseWizardAnswer`、寫入用 `withValue`、只跟這一欄有關的錯誤用 `validateDeployConfig`＋`FIELD_ERROR_CODES` 當場擋——三者都是精靈原本的函式（`withValue`、`FIELD_ERROR_CODES` 改為匯出）。🔴 危險選項（`isDangerousValue`）要 `confirm` 等於 `dangerConfirmWord(spec)` 才開，與精靈相同；關掉不用確認。
  - 跨欄位錯誤與警告由頁面直接呼叫 `validateDeployConfig` 整體列出；有錯誤就不給下載。
  - `webOutputs(config, ctx)`：設定檔＝`renderDeployConfigFile`；部署包＝`renderDeployPackage`，SDK 以 `{ kind: 'spec', spec: 'github:VaalRL/cinderous-sdk#v<版號>' }` 引用（等同 `relay build --sdk-spec`；`embed` 要複製整個 `sdk/`，瀏覽器做不到）；Workers 目標可勾「自帶中繼」（等同 `--self-contained`），預打包的 Worker 原始碼（約 190 KB）只有勾了才以動態 import 載入——那是同一個網站的程式檔，不是對外請求。
  - `webBuildCommand(version)`：`npx --yes github:VaalRL/cinderous-sdk#v<版號> relay build --config cinderous.config.json --out deploy --sdk-spec github:…`（或 `--self-contained`），在自己電腦上產生同一份部署包。
  - `webEstimate(target, input)`：SDK `./estimator`，Workers 目標用 `tier-2-serverless`、其他用 `tier-1-selfhosted`；輸入不合法回 `error`，不丟例外（表單一邊打一邊算）。
- LICENSE 全文在網站建置時以 Vite `?raw` 內嵌（部署包要附 AGPL 全文，ADR 0050），不在瀏覽器裡抓。

### 3. zip：自己寫最小的 STORE 產生器，不加相依

`src/deploy/zip.ts`：`crc32`（IEEE 802.3 查表）＋`createStoreZip(entries, { root?, date? })`。只做 STORE（不壓縮）——部署包是幾十 KB 文字（自帶中繼約 200 KB），不壓縮也無妨，換來不加任何相依、幾十行就能審完。UTF-8 檔名旗標、Unix 權限 644、時間以 UTC 寫（同輸入同日期＝同位元組）；拒絕絕對路徑、`..`、反斜線、磁碟代號（zip slip）、重複路徑；不支援 ZIP64（超過 65535 個檔或 4 GiB 就丟錯，而不是產生壞檔）。檔案放在 `<name>/` 底下，解壓後不會散在目前目錄。

### 4. 隱私：不發請求、不進網址、不收秘密

- 元件裡沒有 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`；不讀寫 `location.search`／`hash`、`history`、`localStorage`／`sessionStorage`／`indexedDB`／cookie——`tests/site/web-configurator-page.test.ts` 掃元件原始碼守住。下載用 `Blob`＋`URL.createObjectURL`，複製指令用 Clipboard API。
- 秘密欄位（`secret-ref`）只收環境變數名稱，存成 `{ "$env": "名稱" }`；`string-or-secret-ref` 可以填值或 `$env:名稱`（與精靈相同）。頁面上方寫明「秘密只填名稱，值之後放進 `.env` 或平台的 secret」。
- 頁面加 CSP meta：`connect-src 'none'; form-action 'none'; base-uri 'self'`（VitePress 頁面 frontmatter 的 `head`）。

**CSP 的限制（照實寫）**：

1. GitHub Pages 不能設 HTTP 標頭，只能用 `<meta http-equiv>`；meta 版的 CSP 不支援 `frame-ancestors`、`report-uri`、`sandbox`。
2. VitePress 是單頁應用：**直接打開設定器網址時** CSP 生效；從網站其他頁面點連結切過來（用戶端導覽）不會重新載入文件，meta 是後來插入的，瀏覽器不套用。所以「不發請求」的主要保證是程式本身（上面的守門測試），CSP 是直接開啟時的第二道。
3. 沒有限制 `script-src`：VitePress 的主題需要行內腳本（深色模式切換），加上去會壞頁面。

### 5. 表單不支援的欄位

物件型別（`record`）的欄位精靈也不問，網頁同樣不給，頁面照實列出、請使用者下載設定檔後直接改：`site.donations`、`site.doCeilings`、`site.doGuaranteeKib`、`site.doBorrowPercent`、`site.doNearFullPercent`、`site.iotRealtime`（五種目標目前都是這六個；以 `webUnsupportedFields(target)` 為準）。另外：

- `configVersion`、`sdk`、`target`、`service` 不是題目（固定或由上方的目標選擇決定）；推播閘道（`service: "push-gateway"`）不在網頁上做：手寫設定檔後用 `cinderous relay build`（SDK ADR 0049 §11.1）。
- 不能匯入既有設定檔再修改（這一版只從頭產生；要改既有設定用 `cinderous init` 或手改＋`cinderous config validate`）。
- 部署包不能內嵌 SDK（`embed`），一律以 GitHub tag 相依或自帶中繼。

## Consequences

- 想自架的人不用先裝 Node／SDK 也能拿到設定檔與部署包；規則與 CLI 同一份，不會兩邊漂移（`webFormGroups` 的測試直接比對 `wizardQuestions`、`webOutputs` 的測試直接比對 `renderDeployPackage`）。
- 網站建置多打包一份部署設定器（約 300 KB，未壓縮）；預打包 Worker 分開成動態載入的區塊。
- 頁面上的 SDK 版號＝網站建置時的 `package.json` 版號；網站由 main 建置，所以頁面產出的部署包引用的 tag 必須已經推上公開 repo（發版流程本來就是先打 tag 再推）。

## 實機驗證（2026-11-18，無頭 Edge＋DevTools，`vitepress preview`）

- 中英兩頁都正常渲染，CSP meta 在；填錯的名稱、公鑰當場在欄位下報錯，改對就消失；危險選項要打對確認字才開，檢查區列出開了哪些危險選項。
- 下載的 `cinderous.config.json` 內容與所填一致；Docker 目標的 zip 解析出 13 個檔（與 `relay build` 相同的清單）。
- 整個操作過程 `performance` 沒有任何新的網路請求。
- **實測抓到一個問題並已修**：換部署目標會把已填的欄位整份清掉。改成 `webSwitchTarget`：新目標也有的欄位照原值重新套用，沒有的丟掉並在頁面上列出；危險選項必須已確認過才帶過去（不能藉換目標繞過確認），兩條規則都有單元測試。
- **更正（2026-11-18，程式碼審查）**：上一條第一次寫下時，元件其實**沒有匯入** `webSwitchTarget`（加匯入的腳本碰到 CRLF 沒套上、也沒檢查），換目標丟 ReferenceError 被 Vue 吞掉，設定的 `target` 一直停在 cloudflare——使用者選 Docker 卻下載到 Cloudflare 的部署包。當時的實測只看「欄位沒被清掉」（沒換成功當然沒清），沒看下載的設定檔，所以誤報為通過。已修：
  - 補上匯入；`tests/site/web-configurator-page.test.ts` 新增「編譯後的 `<script setup>` 沒有找不到的名稱」（用 TypeScript 檢查 `compileScript` 的輸出；網站建置本身不做型別檢查）。
  - 換目標時「拿掉的欄位」誤列了設定檔自己的 `configVersion`、`sdk`，一併修正並補測試。
  - 重新實測（無頭 Edge）：五種目標輪流切換，**下載的** `cinderous.config.json` 的 `target`、`name`、危險選項都跟著目前選的目標；zip 內是該目標的檔案（docker：Dockerfile＋docker-compose.yml；fly：Dockerfile＋fly.toml；兩種 Workers：wrangler.toml）；home-tunnel 沒填 Tunnel 主機名稱時不給下載；沒有任何錯誤、沒有任何網路請求。
- 順修：英文版按鈕用了全形括號。

## 不做（這次）

- 匯入既有設定檔、`record` 欄位的表單、推播閘道的表單。
- 瀏覽器端直接呼叫 Cloudflare API 部署（違反「不部署、不收秘密」；外掛的一鍵部署是 ADR 0021／0118 的路）。
- ADR 0050 P3 的其他項目：(d) GHCR 映像、Deploy 按鈕範本 repo、`create-cinderous`。
