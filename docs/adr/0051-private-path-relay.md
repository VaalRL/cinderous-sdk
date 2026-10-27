# 0051. 個人專屬中繼的私人路徑模式：開放寫入＋不可猜的隨機路徑（`LANES_ONLY`、`privateLane`）

- 狀態：**已接受（Accepted，2026-10-04）**——使用者裁示「好，照丁做」（方案丁）；實作於 v0.41.0
- 日期：2026-10-04
- 補充（v0.42.0）：換路徑之後舊網址不再「立即失效」——ADR 0052 加了唯讀寬限期（`READONLY_LANES`、`retireLane`）與名單加密的中繼搬家通知，讓其他裝置自動改用新網址。
- 對應：CinderSync ARCHITECTURE §5 G19（部署出的中繼強制白名單，新裝置無法只靠它配對）；CinderSync ADR 0024（一鍵部署帶白名單）由 CinderSync 的新 ADR 部分取代。
  相關：本 repo ADR 0008（白名單）、0021（REST 一鍵部署、重新部署檢查）、0022（Token 指南）、**0027 §2**（開放中繼收檔案要白名單或 `openFileRelay`——本 ADR 對私人路徑放寬）、
  0029（檔案車道、`FILE_LANES`）、0036（`appLanes`、`lane-change`）、0042（帳號儲存預算）、0050（部署設定器、秘密只寫 `$env`）；Cinderous ADR-0366（車道路由、「名單不是門禁」）、ADR-0368（拒絕時說明原因、不回顯路徑）、ADR-0371（檔案車道）。

## Context

一鍵部署出來的「個人專屬中繼」有兩個互相衝突的需求：

- **新裝置要能只靠它配對**。ADR 0024（CinderSync）讓部署出的中繼帶白名單（自己各裝置的公鑰），於是一台還不在名單上的新裝置連配對訊息都送不進去（CinderSync G19）；要先在舊裝置上把新裝置加進白名單、重新部署，才配得起來。
- **開放又會被濫用額度**。預設網址是 `cinderous-relay.<子網域>.workers.dev`：Worker 名稱是預設值、子網域常常就是帳號名稱——**猜得到**。開放中繼收檔案塊（每位收件人 4,000 顆、7 天）等於誰都能把你的免費額度用完（ADR 0027 §2 的理由）。

內容本來就是端對端加密（NIP-44／NIP-59），開放寫入**不影響機密性**，只影響資源濫用。所以要擋的是「找得到這座站的陌生人」，而不是「看得到內容的人」。

評估過的方案（使用者 2026-10-04 選丁）：

| | 做法 | 為什麼不選／選 |
|---|---|---|
| 甲 | 維持白名單強制 | G19 無解 |
| 乙 | 開放、什麼都不加 | 網址猜得到，額度可被濫用 |
| 丙 | 中繼上做配對邀請碼／臨時放行 | 中繼要有狀態與新協定，複雜度高 |
| **丁** | **開放寫入＋不可猜的隨機路徑** | 只需要路由層的一個開關；網址本身就是門票 |

## Decision

### §1 中繼：`LANES_ONLY`（兩座宿主同一個環境變數）

- `LANES_ONLY=1`（或 `true`，不分大小寫；其他值一律關）時，**只接受 `APP_LANES` 上的車道**。主平面（`/`、`/s/<n>`、`/presence`）、沒列的車道、其他路徑的 WebSocket 一律拒絕。
- 路由是同一個函式：`routeForPath(path, knownLanes, { lanesOnly })`（`shard.ts`），Worker 的 `fetch` 與 DO 的 `fetch` 共用 `routeOf(env)`。`allDoNames(known, { lanesOnly })` 只列名單上那幾顆 DO，`worstCaseStorage`／`computeCeilingBudget` 因此照實際可能建立的 DO 計算（個人中繼：一顆檔案車道 DO）。
- **拒絕的樣子與一般「認不得的路徑」逐字相同**（ADR-0368 的 NOTICE＋1008 關閉，句子由新的共用函式 `upgradeRejection` 組，兩座宿主相同）。這個模式下連 `/app/<不合法>` 也回 `unknown-path` 而不是 `bad-lane`——「車道 id 不合法」會讓人分得出猜的形狀對不對，秘密車道的站不該對猜測給任何回饋。句子本來就不回顯路徑，只有固定的 `<your-app-id>` 佔位。
- **NIP-11**：被拒的路徑回 `404`、本文 `unknown relay path`（帶 CORS），根路徑、分片、猜錯的車道三者完全相同；秘密車道回它自己的文件（檔案政策、單檔上限照實宣告）。文件裡本來就沒有車道 id。
- HTTP 首頁（`Cinderous relay`）與 `/healthz` 不受影響，不列任何車道。
- `LANES_ONLY` 開著但 `APP_LANES` 是空的：整座站什麼都連不上（fail-closed），啟動時 `console.warn`。這正好讓 wrangler 路徑「先部署、再 `wrangler secret put APP_LANES`」之間沒有開放的空窗。
- **Node 主機**（docker／fly／home-tunnel）：同一個變數、同一個 `routeForPath`。它沒有車道 DO，名單只當**門**用；通過的連線仍是本站唯一的嚴格政策（要 NIP-42 AUTH），不會因此變成寬鬆車道（ADR-0366 §決策 8）。被拒的升級同樣 NOTICE＋1008，NIP-11 同樣 404。沒開＝與過去完全相同（任何路徑都接受）。

### §2 部署：`privateLane`（私人路徑模式）

- `RelaySiteOptions.privateLane`：一個**至少 128 位元的隨機車道 id**。`generatePrivateLaneId()` 以 WebCrypto `getRandomValues` 產生 26 字 base32 小寫（130 位元；每個位元組取低 5 位元，256 是 32 的倍數，沒有偏差），不碰 Node。驗證規則：符合車道 id 規則（`LANE_ID_PATTERN`）且至少 `PRIVATE_LANE_MIN_LENGTH = 26` 字（呼叫端自己給的也照這個驗；SDK 量不出隨機性，文件要求用密碼學亂數）。
- `relaySiteVars` 寫出：`APP_LANES`＝它、`LANES_ONLY=1`；Cloudflare 版開了 `maxFileMb` 時 `FILE_LANES`＝它（`MAX_FILE_MB` 在車道模式是單檔上限，與官方錨點的 `/app/cindersync` 同一套政策：檔案車道 DO、離線 1 GiB、可尋址 64／作者）。Node 主機沒有 `FILE_LANES`，`MAX_FILE_MB` 照舊是全站開關——而全站只剩這一條路徑。
- 與 `appLanes`／`fileLanes` **互斥**（`private-lane-exclusive`）：這個模式整座站只有一條路徑。`privateLane` 不是 Worker 限定的選項。
- **白名單改為選用**。ADR 0027 §2「沒有白名單時開檔案事件要 `openFileRelay`」對私人路徑模式**放寬**：路徑本身就是門票。仍可同時給白名單（兩道一起擋）。
- 錯誤訊息**不回顯**這個值（`invalid-private-lane`）；REST 重新部署的 `lane-change` 訊息在私人路徑模式也不列任何車道 id（兩邊都是秘密，錯誤訊息會進畫面與記錄）；部署進度只印主機加「（私人路徑）」。
- **回傳完整網址**：`deployCloudflareRelayViaApi`、`deployCloudflareRelay`（wrangler）、docker、fly 的 `relayEndpoint` 都是 `wss://<host>/app/<id>`（`privateLaneEndpoint`），REST 的結果另有 `privateLane`。`httpUrl` 仍是根網址（健康檢查打 `/healthz`）。`privateLaneFromUrl(url)` 從既有網址取回 id（只認得夠長、合法的私人路徑），重新部署時沿用。
- **重新部署**：沿用同一個 id＝冪等。換 id（網址外洩時），或從白名單模式改成私人路徑模式，REST 路徑會回 `lane-change`，要 `allowLaneChange: true` 才上傳——換了之後舊網址立即失效、舊 DO 的資料留在原處等到期，其他裝置要改用新網址。

### §3 設定器（ADR 0050）

- 描述表新增 `site.privateLane`，型別 `secret-ref`：設定檔**只能寫 `{ "$env": "NAME" }`**（它等同密碼；設定檔與部署包可提交）。`DeployConfig.site` 的型別是 `DeploySiteOptions`（`privateLane` 換成 `SecretRef`）；JSON Schema 重新產生。
- 驗證以佔位值（`PRIVATE_LANE_PLACEHOLDER`）跑同一份站台規則；有私人路徑時不提醒「開放中繼」，改提醒「網址等同密碼」（`private-lane`）。
- 部署包不含秘密：Workers 的 `wrangler.toml` 只寫 `LANES_ONLY`，`APP_LANES`／`FILE_LANES` 留註解、由說明教 `npx wrangler@4 secret put`；compose 的 `APP_LANES` 從 `.env` 代入（`${NAME:?…}`，沒設就不啟動）；`fly.toml` 不含 `APP_LANES`，說明教 `fly secrets set APP_LANES=… --stage`。`.env.example` 列出變數。中英部署說明的端點、健康檢查（根路徑 NIP-11 回 404 是對的）、WebSocket 測試、安全檢查清單、範例程式都換成私人路徑。
- `relay deploy --config` 部署時才從環境讀出值（`resolveSiteSecrets`），沒有值就不部署、訊息只有變數名稱；`--dry-run` 用佔位值。旗標路徑不開這個選項（命令列參數會進 shell 歷史）。
- `DEPLOY_AFFECTING_CHANGES` 加 0.41.0 一筆。

## 殘餘風險

- **網址外洩＝任何人可寫**：私人路徑模式的安全性完全建立在網址保密上。它會出現在：使用者的裝置（外掛設定）、配對碼、CinderSync 經中繼加密傳送的名單／設定、Cloudflare 帳號的儀表板（REST 部署寫成 plain text 變數）、Worker 的請求記錄（路徑），以及 wrangler／fly 直接部署時寫在本機工作目錄的設定檔（`.cinderous/<name>/wrangler.toml`、`fly.toml`）。**補救＝換一個 id 重新部署**（`allowLaneChange`），舊網址立即失效；其他裝置要拿到新網址。
- 外洩之後、換路徑之前，濫用者能做的與 ADR 0027 §2 描述的相同（佔用檔案車道的配額與帳號儲存），**讀不到內容**（端對端加密）；每 IP 每秒 20 則、每公鑰 5 條連線的 PRD 3.3 限速仍在。
- 128 位元的路徑不可能被猜中；但拒絕訊息與 NIP-11 只保證「不透露車道」，**看得出這是一座僅限車道的站**（根路徑被拒），這是刻意接受的。
- 換路徑等於換一顆 DO：舊路徑上還沒送達的離線留言與檔案塊不會搬過去（等 TTL 到期）。正常流程裡其他裝置在線時會從彼此或新路徑補齊。

## 測試

- `tests/relay/lanes-only.test.ts`（Worker）：環境變數解析、`routeForPath`／`allDoNames`／`worstCaseStorage` 的僅限車道模式、秘密車道落在自己的 DO、其他路徑（含 `/app/<不合法>`、猜錯的車道）的 NOTICE 與關閉原因和一般站逐字相同且不含秘密、NIP-11 404 本文相同、秘密車道的文件宣告檔案政策、首頁與 `/healthz` 不變、沒開時行為不變。
- `tests/relay/lanes-only-node.test.ts`（Node 主機，真的開一台）：秘密車道收到 AUTH 挑戰、其他路徑 NOTICE＋1008、NIP-11 404、沒開時任何路徑可連。
- `tests/deploy/private-lane.test.ts`：產生器（`getRandomValues`、形狀、長度）、網址組合與取回、`relaySiteVars`（Worker／Node、白名單選用、互斥、不回顯值、ADR 0027 §2 不變）、REST 部署（完整網址、沿用冪等、換路徑 `lane-change` 且訊息不含秘密、`allowLaneChange`、不合法時不發請求）、設定器（Schema、`$env` 才合法、提醒、wrangler／compose／fly 部署包不含秘密、說明的指令）、CLI 從環境讀值與缺值時拒絕。

## Consequences

- ＋ 新裝置只要拿到網址（配對碼）就能配對，不必先改白名單重新部署（CinderSync G19）。
- ＋ 預設網址猜不到：陌生人連不上、也探測不到有哪些車道。
- ＋ 自架（docker／fly／home-tunnel）用同一個環境變數。
- － 網址成為秘密，外洩要換路徑重新部署；所有拿到網址的地方都要當密碼處理（見〈殘餘風險〉）。
- － 私人路徑模式的站不再服務主平面：不能同時當 Cinderous 聊天或其他應用的公用中繼。
