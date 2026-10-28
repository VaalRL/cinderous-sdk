# 0050. 部署設定器：以設定檔 `cinderous.config.json` 為核心，CLI 精靈、網頁設定器只是產生它的介面；產出可攜的部署包與依選擇組合的部署說明

- 狀態：**已接受（Accepted，2026-10-02）**——使用者裁示見〈使用者裁示〉；**P0 已實作（v0.38.0）**，見〈P0 實作（v0.38.0）〉；P1 的 `cinderous init` 精靈與危險選項確認已做（SDK ADR 0117），`config migrate`、`cloudflareApiOptionsFromConfig`＋REST `secret_text` 未做
- 日期：2026-10-02
- 對應：使用者的問題「SDK 是否適合做一個介面，讓開發者快速選擇需要的功能與部署方式，然後產出一包可以直接部署的東西與部署說明」（研究報告見〈參考〉）。
  相關：本 repo ADR 0008（CLI、`.cinderous/`）、0013（存取控制）、0018（docker／fly 共用建置內容）、0019（中立預設）、0021（REST 部署、CORS、否決自架代理）、
  0022（Token 指南是 SDK 的資料）、0027（檔案塊需白名單）、0036／0037（`RelaySiteOptions`、參數範圍與安全邊界）、0042（容量與帳號預算）、0049（IoT 部署選項）。

## Context

SDK 已經有一鍵部署的大半零件：

- 四條部署路徑：wrangler、REST、docker、fly；
- 站台參數的單一驗證：`RelaySiteOptions`／`relaySiteVars`／`RELAY_SITE_LIMITS`／`WORKER_ONLY_SITE_OPTIONS`；
- 設定產生器：`renderWranglerToml`、`renderCompose`、`renderFlyToml`、`prepareNodeRelayContext`；
- 健康檢查、Token 指南資料、帳號儲存預算 `computeCeilingBudget`。

開發者仍然要自己拼湊旗標、讀 ADR 0037 的表格、自己寫部署說明。缺口有五個：

1. **選擇不能保存**：REST 重新部署是整份替換綁定，沒帶的參數會回到預設（ADR 0037 Consequences）。
2. **驗證遇到第一個錯誤就停**：適合部署前擋下，不適合互動介面一次列出所有問題。
3. **產出不可攜**：`.cinderous/<名稱>/entry.mjs` 用絕對路徑 import 本機 `node_modules` 裡的 SDK，不能提交，也不能交給別人。
4. **沒有依選擇組合的部署說明**：秘密、健康檢查、回滾、升級都要自己查。
5. **同一個參數要手寫很多遍**：型別、驗證、CLI `parseArgs`、`USAGE`、README 中英、ADR 表格。IoT（ADR 0049）還會再加十幾個 `--iot-*` 旗標與秘密。

限制條件：

- SDK 目前私有：第三方用不到 `npx`／`npm create`／Deploy 按鈕／公開映像。
- 產出包若內嵌 SDK 程式，依 AGPL §6 要附對應原始碼。
- 秘密（Cloudflare／Fly Token、TURN Token、IoT 閘道金鑰、家庭秘密、設備權杖、MQTT 密碼）絕不能進可分享的檔案或網址。
- Cloudflare API 沒有 CORS，靜態網頁不能替人部署（ADR 0021）。

## Decision（提議）

### 1. 形式：設定檔是核心，介面只負責產生它

| 形式 | 角色 | 階段 |
|---|---|---|
| (c) `cinderous.config.json`＋JSON Schema | **單一真實來源**：所有選擇（目標、站台參數、宿主選項、秘密引用、IoT），可提交、可 diff，每次部署帶同一份 | P0 |
| (a) `cinderous init` 精靈 | 逐題產生設定檔；不互動模式（`--yes`、旗標、`--from`）給 CI | P1 |
| (b) 網頁設定器（靜態頁） | 瀏覽器內產生設定檔、zip 或一行指令；**不部署、不收秘密、不發任何請求**（CSP `connect-src 'none'`） | SDK 公開後（P3） |
| (d) GHCR 映像、Deploy to Cloudflare 按鈕範本 repo、`create-cinderous` | 補充入口；範本 repo 本身由 `relay build` 產生 | SDK 公開後（P3） |

參考同類工具：

- Supabase `config.toml`＋`env()`＋`config push`：設定檔即真實來源；
- Cloudflare C3 與 create-hono：每一題都有對應旗標，可以完全不互動；
- Home Assistant add-on：由 schema 產生 UI；
- nostr-rs-relay／strfry：單一分區設定檔；
- Deploy to Cloudflare 按鈕：用 `.dev.vars.example` 宣告秘密。

### 2. 延伸既有 CLI 與 `./deploy`，不開平行套件

- 新指令：
  - `cinderous init`
  - `cinderous relay build --config <檔> --out <目錄>`：可攜的部署包，不寫絕對路徑。
  - `cinderous relay deploy --config <檔>`
  - `cinderous config validate|migrate|schema`
- 既有的 `relay deploy` 旗標照常可用，內部改成先組出設定再走同一條路。
- 新的**不碰 Node** 模組（從 `./deploy` 與 `./deploy/cloudflare-api` 轉出，納入 `cloudflare-api-guard` 守門），提供以下函式：
  - `DeployConfig` 型別、`DEPLOY_OPTION_SPECS` 描述表、`validateDeployConfig`；
  - `renderDeployPackage`（純函式，回傳 `{ path, content }[]`）；
  - `renderDeployGuide(config, locale)`；
  - `cloudflareApiOptionsFromConfig(config)`。
- 這個模組讓 CLI、網頁、Obsidian 外掛共用同一份驗證與產生器。外掛把使用者的選擇存成 `DeployConfig`，交給 `deployCloudflareRelayViaApi`。
- `create-cinderous`：上 npm 後才做，是只有幾十行的轉接程式，不放任何邏輯。

### 3. 選項模型與單一驗證

- `DeployConfig` 的欄位：
  - `configVersion: 1`、`sdk`（產生時的版號）；
  - `target`：`cloudflare`、`cloudflare-api`、`docker`、`fly`、`home-tunnel`；
  - `name`；
  - `site: RelaySiteOptions`：**原樣沿用**；
  - `node`：`persist`、`port`、`trustProxy`；
  - `cloudflare`：`accountId`、`compatibilityDate`、`workersDevSubdomain`；
  - `fly`：`region`；
  - `tunnel`：`hostname`；
  - `secrets`：`{ $env: string }` 引用；
  - `iot`：ADR 0049 落地時加入。
- **描述表** `DEPLOY_OPTION_SPECS`：每個欄位一筆，記錄型別、範圍（引用 `RELAY_SITE_LIMITS`）、預設、適用宿主、是否秘密、旗標名、中英說明、精靈題組。
  - 從它推出 JSON Schema（提交進 repo，`npm run check` 比對一致性）、CLI 旗標、`USAGE`、網頁表單、精靈題目。
  - 型別測試保證描述表的鍵與 `RelaySiteOptions` 一致。
- **收集式驗證**：從 `relaySiteVars` 抽出 `collectRelaySiteIssues(opts, host)`。它回傳全部的 `{ path, code, severity, message: { zh-TW, en } }`，不丟例外。`relaySiteVars` 改成「有錯就丟第一個」，**對外行為與訊息不變**，既有測試就是回歸測試。
- 規則：沿用既有的全部規則——Node 拒絕車道與容量參數、檔案塊需白名單、`fileLanes` ⊆ `appLanes`、溢位帶需保底、帳號預算。另外新增：
  - Worker 拒絕 `persist`／`trustProxy`，不再默默忽略；
  - TURN 只能用在 Worker；
  - `home-tunnel` ⇒ Node＋`trustProxy`，relay 的埠不對外發布，MQTT 只綁區網、不經 Tunnel；
  - `fly`＋IoT MQTT ⇒ 強制 TLS 8883；
  - IoT 的規則照 ADR 0049 §5（明文輪詢沒有開放站的開關、`required` 不收家庭秘密……）。
- 「不能關掉防線」（ADR 0037）在每個介面都相同。危險旗標在精靈裡要打字確認。

### 4. 秘密

- 設定檔與產出包**不含任何秘密值**，只寫 `{ "$env": "NAME" }`。產出包附 `.env.example`（Workers 另附 `.dev.vars.example`）與 `.gitignore`（排除 `.env`、`.secrets/`、`.dev.vars`、`*.db`）。
- 部署時依目標推送：
  - wrangler 路徑：`wrangler secret put`；
  - REST 路徑：`secret_text` 綁定（重新部署靠既有的 `keep_bindings` 保留）；
  - Fly：`fly secrets set`；
  - Docker：`env_file`。
- IoT 設備權杖與 MQTT 密碼在本機產生，原文只印一次或寫進 `.secrets/`；設定檔只放 SHA-256 或 scrypt 雜湊。
- 白名單公鑰可以放設定檔與 `[vars]`（ADR 0008），但**不放網址**：網頁設定器不把選擇編進 query string。
- `relay build` 發現設定檔裡有疑似 Token 的字串（不在 `$env` 裡）就拒絕。

### 5. 產出包

- 共同檔案：
  - `cinderous.config.json`
  - `README-DEPLOY.md`
  - `.env.example`
  - `.gitignore`
  - `LICENSE`（AGPL 原文）
  - `SOURCE.md`：SDK 確切版本的原始碼連結、§13 提醒
  - `.cinderous-generated`：產生的檔案清單與版號；重新產生前比對，被手改過的檔案先警告
- 各目標另外的檔案：

  | 目標 | 另外的檔案 |
  |---|---|
  | Workers | `wrangler.toml`、`src/entry.mjs`（import 套件名稱，不寫絕對路徑）、`package.json`（釘 SDK 版本、`wrangler@4`）。選項 `--self-contained` 改附預打包的 `relay.mjs` |
  | Docker | `docker-compose.yml`（秘密用 `env_file`）、`Dockerfile`、`server.mjs`、`package.json`、公開前的 `sdk/`（ADR 0018）。公開後改用 GHCR 映像，就不需要 `Dockerfile` 與 `sdk/` |
  | Fly | `fly.toml` 與 Docker 版相同的建置內容；IoT MQTT 時多一個 TCP 8883 服務 |
  | 家中主機＋Tunnel | `docker-compose.yml` 有兩個服務：relay（不發布埠，`TRUST_PROXY=1`）與 `cloudflared`（`TUNNEL_TOKEN` 從 `.env`）；IoT 時另有 `iot.config.json` 與 `.secrets/` |

- `README-DEPLOY.md` 由 `renderDeployGuide` 依選擇組合（zh-TW、en），段落如下：
  - 前置工具；
  - 取得憑證：Cloudflare 直接嵌入 `CLOUDFLARE_TOKEN_SETUP_GUIDE`，不另外抄一份（ADR 0022）；
  - 設定秘密；
  - 部署：一行指令，或原生工具；
  - 健康檢查：`/healthz`、NIP-11 欄位核對、`wss://` 連線片段；
  - 回滾：🔴 改了 `appLanes`，回滾拿不回舊 DO 的資料；
  - 升級；
  - 成本：`estimate`、`computeCeilingBudget`；
  - 安全檢查清單；
  - 授權摘要；
  - 選用的「連上這座中繼」客戶端片段，依所選功能決定要用哪些子路徑。
- 完整的客戶端應用範本（Node、網頁、Obsidian）**不在本 ADR 範圍**，列為後續。

### 6. 版本相容

- 產出包釘死 SDK 版本：公開前用 `sdk/` 內嵌或 `github:…#vX.Y.Z`，公開後用 npm 確切版號。
- 設定檔 schema 改版時，用逐版的純函式遷移（`config migrate`）。
- CLI 比設定檔的 `sdk` 舊 → 拒絕；比較新 → 警告，並列出這幾版之間影響部署的 ADR。
- 沿用既有的保證：DO 遷移只能附加、改 `appLanes` 要 `allowLaneChange`、`compatibility_date` 記在設定檔裡，不隨 CLI 改變。

### 7. 授權（AGPL-3.0-only）

- 產出包內嵌 SDK 程式時（`sdk/dist`、`relay.mjs`），是傳遞目的碼，要附 `LICENSE` 與確切版本的原始碼連結（§6）。私有 repo 的連結對第三方無效，所以**對外提供要等 SDK 公開**。
- 以相依引用 SDK 的產出包，散布義務最輕。部署後只有**修改過**中繼的人，才要依 §13 對網路使用者提供原始碼。說明裡要提醒，NIP-11 `software` 應指向修改後的原始碼。
- 產生的設定檔與膠水程式（範本的複本）另外以 **MIT-0** 例外條款授權（使用者裁示）；SDK 本體仍是 AGPL-3.0-only。

## 分階段實作計畫

| 階段 | 內容 | 工作量（單人、TDD） | 前提 |
|---|---|---|---|
| **P0** | `DeployConfig`、描述表、`collectRelaySiteIssues`（行為不變的重構）、JSON Schema 產生與一致性檢查、`relay build`（五種目標、可攜）、`relay deploy --config`、`renderDeployGuide`、`$env` 秘密引用、LICENSE／SOURCE.md；快照測試、與旗標路徑逐項相同的差異測試、中立模組守門；docker／fly 第一次真的跑一遍 | 6–9 天 | 無（私有期間自用） |
| **P1** | `cinderous init` 精靈（`node:readline`，不加相依；即時驗證；危險選項打字確認；隱藏輸入；`.secrets/`）、不互動模式、`config migrate`、`cloudflareApiOptionsFromConfig`＋REST `secret_text`（同時完成 ADR 0037 後續的 TURN 開放） | 3–5 天 | P0 |
| **P2** | IoT 選項以描述表模組接入（ADR 0049 的 `iotPolling`、`iotMqtt`、`iotGatewayPubkeys`、`NODE_ONLY_SITE_OPTIONS`、`iot.config.json`） | 每個 IoT 階段各 +1–2 天（算在 IoT 的工作量裡） | IoT P1／P2 |
| **P3** | 網頁設定器（靜態、瀏覽器內 zip）、GHCR 映像、Deploy 按鈕範本 repo、`create-cinderous` | 7–11 天 | SDK 公開、上 npm |

**與 IoT（ADR 0049）的先後（建議）**：

1. 設定器 P0 先做，約 1.5 週。IoT P0（`./iot` 協定與橋接器 A）跟中繼部署選項沒有交集，可以重疊進行。
2. IoT P1／P2 的部署選項直接寫成描述表項目，不在 CLI 手寫 `--iot-*` 旗標。
3. 最後做設定器 P1 精靈。

若 IoT 要更早：P0 先只做「描述表＋收集式驗證＋`DeployConfig`＋`$env`」（3–4 天），產生器與說明延到 IoT P1 之後。

## 風險

1. 公開前價值主要給自己：MVP 先拿「家中主機＋Tunnel＋IoT」的真實情境驗證。
2. 範本跟 wrangler／flyctl／cloudflared 的格式脫節：用快照測試，加上發版前的冒煙測試（`wrangler deploy --dry-run`、`docker compose config`、`fly config validate`）。
3. 設定檔跟儀表板手動改的值不一致：說明裡寫明「以設定檔為準，下一次部署會覆寫」。
4. 秘密誤提交：用 `.gitignore`，加上 build 時偵測疑似 Token 字串。
5. 選項爆炸：精靈只問必要題組（目標、存取、Vault 同步、IoT），其他放進「進階」。
6. AGPL 讓開發者卻步：用 SOURCE.md 與（待決的）產生器例外條款緩解。

## 待使用者決定的事項

1. 做不做、範圍：只做中繼部署（推薦），還是連客戶端應用範本一起做？
2. 形式組合：(c)＋(a)，公開後再做 (b)＋(d)（推薦）？
3. 與 IoT 的先後：設定器 P0 先做（推薦）、折衷方案（3–4 天的骨架），或先做 IoT？
4. 設定檔格式：JSON＋JSON Schema（推薦）、`cinderous.config.ts`，或 TOML？
5. 精靈的互動函式庫：`node:readline`，不加相依（推薦），或 `@clack/prompts`（MIT）？
6. 產生的設定檔與膠水程式要不要以 MIT-0／0BSD 例外條款授權（推薦）？
7. Workers 包的預設形式：以相依引用 SDK（推薦，公開後），還是預打包的 `relay.mjs`？
8. 說明語言：zh-TW＋en 兩份（推薦），還是依 `--locale` 只產生一份？
9. `home-tunnel` 列為正式目標（推薦）；要不要加 `node-bare`（systemd）？
10. NIP-11 `software` 要不要開放成可以設定（例如 `RELAY_SOFTWARE_URL`），讓改過中繼的人履行 §13？
11. 網頁設定器放哪裡（SDK 官網或 GitHub Pages），要不要附成本試算？
12. CLI 名稱沿用 `cinderous init`（推薦），上 npm 後另做 `create-cinderous`？

## 使用者裁示（2026-10-02）

| 項目 | 裁示 |
|---|---|
| 1. 範圍 | 只做中繼部署 |
| 2. 形式 | (c) 設定檔＋(a) CLI 精靈；網頁設定器留到 P3 |
| 3. 與 IoT 的先後 | 設定器 P0 先做，再做 IoT（IoT P0 可重疊） |
| 4. 設定檔格式 | JSON＋JSON Schema |
| 5. 精靈函式庫 | `node:readline`，不加相依 |
| 6. 產生物授權 | MIT-0 例外條款（依建議） |
| 9. `home-tunnel` | 列為正式目標；`node-bare` 不做 |
| 10. NIP-11 `software` | 開放設定 |

未逐項裁示、先採推薦值的：7（公開後以相依引用 SDK；公開前內嵌）、8（zh-TW＋en 兩份說明）、12（沿用 `cinderous init`）。11（網頁設定器放哪裡）延到 P3 再決定。

## P0 實作（v0.38.0）

### 模組

| 位置 | 內容 | 碰 Node？ |
|---|---|---|
| `src/deploy/shared.ts` | `collectRelaySiteIssues(opts, host)`（收集式、不丟例外、`{ path, code, severity, message: { zh-TW, en } }`）；`relaySiteVars` 改成「有錯就丟第一個」，訊息逐字不變（Node 收到多個 Worker 限定參數仍合併成一句）；`relaySoftwareUrl` → `RELAY_SOFTWARE_URL`；`RELAY_NAME_PATTERN`、`RELAY_SITE_LIMITS.maxFileMb` | 否 |
| `src/deploy/render.ts`（新） | 原本分散在 cloudflare／container／docker／fly 的產生器搬到這裡：`renderWranglerToml`、`renderWorkerEntry`、`renderDockerfile`、`renderServerEntry`、`relayEnvironment`、`renderCompose`（新增 Tunnel 模式）、`renderFlyToml`、`renderDockerignore`；原模組照舊轉出，預設輸出逐位元組不變 | 否 |
| `src/deploy/config/`（新子路徑 `@cinderous/client/deploy/config`） | `DeployConfig`、`DEPLOY_OPTION_SPECS`、`deployConfigJsonSchema`、`validateDeployConfig`、`findSecretLiterals`／`resolveSecret`、`renderDeployGuide`、`renderDeployPackage`、`modifiedGeneratedFiles` | 否（守門：`tests/deploy/deploy-config-guard.test.ts`） |
| `src/deploy/build.ts`（新） | `buildRelayPackage`：寫檔、複製 `sdk/`、比對 `.cinderous-generated` | 是 |
| `src/deploy/container.ts` | 抽出 `copySdkRuntime`（`sdk/` 多帶 `LICENSE` 與 `bin`） | 是 |
| `src/deploy/docker.ts` | `tunnel` 選項（home-tunnel）：不發布埠、強制 `TRUST_PROXY=1`、Token 只進 docker compose 的環境、健康檢查打 `https://<hostname>/healthz` | 是 |
| `src/relay/worker.ts`、`node-relay.ts` | NIP-11 `software` 讀 `RELAY_SOFTWARE_URL`，沒設仍是 SDK 的 repo（使用者裁示 10） | — |
| `src/cli/commands.ts` | `relay build`、`relay deploy --config`、`config validate`、`config schema`；旗標路徑改成「旗標 → `DeployConfig` → 部署參數」，與 `--config` 同一條路 | 是 |
| `schema/cinderous.config.schema.json` | 由描述表產生、提交；測試比對一致；匯出為 `@cinderous/client/config.schema.json` | — |

### 指令

```bash
npx cinderous config validate [cinderous.config.json]      # 一次列出所有問題；有錯回 1
npx cinderous config schema > schema.json                  # 印出 JSON Schema
npx cinderous relay build --config cinderous.config.json --out deploy/ [--self-contained] [--sdk-spec <相依>] [--force]
npx cinderous relay deploy --config deploy/cinderous.config.json [--dry-run] [--output-env <檔>]
```

`relay deploy --config` 從環境變數讀秘密，並讀設定檔旁邊的 `.env`（環境變數優先）。

### 與本 ADR 的差異（及理由）

1. **CLI 旗標與 `USAGE` 沒有從描述表產生**，改由測試保證描述表裡每個 `flag` 都出現在 `USAGE`、`env` 與 `relaySiteVars` 寫出的變數相同。理由：既有旗標的解析與錯誤訊息（用法錯誤回 2）要逐字不變；產生器在 P1 精靈一起做。
2. **旗標路徑不在 CLI 先驗站台參數**（`checkSite: false`），照舊交給部署函式——既有測試用的是不合法的 `npub1a`，提早驗證會改變行為。`--config` 路徑則一次驗全部。設定檔層級的新規則（Worker 拒絕 `node.*`）兩條路徑都套。
3. **疑似秘密的字串分兩級**：一定是秘密的形狀（`nsec1…`、Fly Token、cloudflared Tunnel Token、PEM 私鑰）→ 拒絕；只是「長得像 Token」（≥ 32 字、大小寫加數字）→ 提醒，不擋。理由：本 ADR §4 寫「拒絕」，但啟發式規則會誤判合法值（例如贊助帳號），使用者指示「build 時警告」。
4. **被手改過的產生檔案：拒絕覆寫**（不是只警告），要加 `--force`。輸出目錄裡同名、但不是 `relay build` 產生的檔案同樣拒絕。輸入的設定檔本身例外（以正規化後的內容覆寫，並寫入 `sdk` 版號）。換目標時，上一次產生、這次不需要而且沒被手改的檔案會被刪除。
5. **`cloudflare-api` 目標**：`relay build` 產生與 `cloudflare` 相同的 Workers 部署包（說明另外指向 `deployCloudflareRelayViaApi`）；`relay deploy --config` 對它回報「P1 才接上」（`cloudflareApiOptionsFromConfig`＋REST `secret_text` 本來就排在 P1）。
6. **JSON 檔放不了 MIT-0 標頭**（`cinderous.config.json`、`package.json`、清單）：以 `SOURCE.md` 列出的 MIT-0 檔案清單為準；其他產生檔案都有 `SPDX-License-Identifier: MIT-0` 標頭。預打包的 `src/relay.mjs` 標 `AGPL-3.0-only`。
7. **`.dev.vars.example` 沒有任何變數**：P0 的中繼沒有執行期秘密（TURN 在 P1）。
8. **JSON Schema 的 `$id` 用 URN**（`urn:cinderous:deploy-config:1`）：SDK 公開前沒有可解析的網址。
9. **`./deploy` 的守門放寬一點**：說明要嵌 Token 指南（ADR 0022 的資料），所以 `./deploy` 與 `./deploy/config` 會帶進 `cloudflare-api/guide.ts`、`auth.ts`、`http.ts` 這三個純函式檔；打包好的 Worker 與 REST 部署本體仍然不行（`tests/deploy/cloudflare-api-guard.test.ts`）。
10. `config migrate`、`cinderous init` 精靈不在 P0（P1）；schema 已有 `configVersion`。`config schema` 順手做了（只是印出 JSON Schema）。
11. **行為變更**：Cloudflare 目標給 `--persist`／`--port`（或設定檔的 `node.*`）改為用法錯誤，原本默默忽略（本 ADR §3 的新規則）。`.cinderous/<名稱>/sdk/` 多了 `LICENSE` 與 `bin`，`.dockerignore` 多排除 `.env`、`.secrets`、`*.db`。

### 驗證

- 單元與快照：`collectRelaySiteIssues` 逐項比對「`relaySiteVars` 丟出的訊息＝第一個錯誤」（24 組壞參數）；描述表、JSON Schema 一致性、驗證、秘密；五種目標的部署包快照、可攜（沒有絕對路徑）、不含秘密、MIT-0 標頭、確定性；兩種語言的說明段落；`buildRelayPackage` 的寫檔、清單比對、換目標、`--self-contained`；docker 的 Tunnel 模式；CLI 的旗標路徑與 `--config` 路徑交給部署函式的參數**逐項相同**（四組差異測試）。
- 冒煙（這台開發機，2026-10-02）：
  - 五種目標都以真的 CLI（`dist/cli/index.js`）`config validate`＋`relay build`；產生的 `docker-compose.yml`（兩份）以 PyYAML、`fly.toml`／`wrangler.toml` 以 Python `tomllib` 解析通過。
  - Workers：`--self-contained` 包與內嵌 `sdk/` 的包（`npm install` 後）都通過 `wrangler deploy --dry-run`（wrangler 4.146.0）；內嵌包另以 `wrangler dev`（本機 workerd）實際啟動：`/healthz` 回 `ok`，NIP-11 `software` 是設定的網址、`version` 正確。
  - Docker 包：`npm install` 後在主機的 Node 直接跑 `server.mjs`（與容器的 CMD 相同）：`/healthz` 回 `ok`、NIP-11 站名（含引號）與 `software` 正確、WebSocket 收到 `AUTH`、保存模式寫出 SQLite 檔；部署包裡 `npx cinderous config validate` 可用（`sdk/` 帶 `bin`）。
  - `relay deploy --config … --dry-run`（home-tunnel、cloudflare）通過。
- **沒有驗證**：這台機器沒有 Docker、flyctl 與 cloudflared，所以 `docker compose config`／`up`、`fly config validate`／`deploy`、真的 Cloudflare Tunnel 都還沒跑過（本 ADR P0「docker／fly 第一次真的跑一遍」**未完成**，要在有這些工具的環境補）。沒有部署到任何地方，也沒有使用任何 Cloudflare Token。

## Consequences

- ＋ 開發者選一次、存成一個檔，以後每次部署都帶同一份：解決 REST 重新部署回到預設的問題，也解決 `.cinderous/` 不可攜的問題。
- ＋ 每個參數只在描述表寫一次，旗標、驗證、Schema、說明、精靈、網頁都從它推出，比現在的重複更少。
- ＋ IoT 等新能力以「可選模組」接入，秘密有統一的處理方式。
- ＋ 秘密不進檔案、不進網址，網頁不發請求，維持零伺服器原則。
- － 多一份 schema 要做版本與遷移；多一組範本與快照測試要維護。
- － 對第三方的價值要等 SDK 公開（npm、GHCR、Deploy 按鈕、網頁都要公開才有意義）。

## 參考

- 研究報告：`research-sdk-configurator.md`（2026-10-02，session scratchpad；同日回報使用者）。
- Cloudflare C3：https://developers.cloudflare.com/pages/get-started/c3/
- Deploy to Cloudflare 按鈕：https://developers.cloudflare.com/workers/platform/deploy-buttons/
- create-hono：https://hono.dev/docs/guides/create-hono ；create-t3-app：https://create.t3.gg/en/installation
- Supabase 設定與秘密：https://supabase.com/docs/guides/local-development/managing-config
- Fly Launch：https://fly.io/docs/launch/create/
- Home Assistant add-on 設定：https://developers.home-assistant.io/docs/add-ons/configuration/
- nostr-rs-relay：https://github.com/scsibug/nostr-rs-relay/blob/master/config.toml ；strfry：https://github.com/hoytech/strfry/blob/master/strfry.conf
- AGPL-3.0：https://www.gnu.org/licenses/agpl-3.0.html
