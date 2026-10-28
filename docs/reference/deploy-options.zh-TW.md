# 部署設定參考

> 由 `npm run docs:reference` 從 `DEPLOY_OPTION_SPECS`（`src/deploy/config/specs.ts`）產生，請勿手動修改。

[English](deploy-options.md)

`cinderous.config.json` 的每一個欄位。這個檔案記下一次部署的所有選擇（[ADR 0050](../adr/0050-deploy-configurator.md)）；同樣的規則也寫在 JSON Schema [`schema/cinderous.config.schema.json`](../../schema/cinderous.config.schema.json)（匯出為 `@cinderous/client/config.schema.json`）。

```sh
npx cinderous init
npx cinderous config validate cinderous.config.json
npx cinderous relay build --config cinderous.config.json --out deploy/
npx cinderous relay deploy --config deploy/cinderous.config.json
```

- `site.` 底下是中繼的站台參數，與 `RelaySiteOptions` 相同。
- **旗標**是 `cinderous relay deploy` 對應的旗標；沒有旗標的只能寫在設定檔。
- **環境變數**是中繼自己讀的，不經過 CLI 直接跑中繼時用。
- 秘密不寫進設定檔，只能寫參照：`{ "$env": "NAME" }`。

## 總覽

| 欄位 | 旗標 | 環境變數 |
| --- | --- | --- |
| `configVersion` | — | — |
| `sdk` | — | — |
| `target` | `--provider` | — |
| `service` | — | — |
| `name` | `--name` | — |
| `node.persist` | `--persist` | — |
| `node.port` | `--port` | — |
| `node.trustProxy` | — | — |
| `cloudflare.accountId` | `--account-id` | — |
| `cloudflare.compatibilityDate` | `--compatibility-date` | — |
| `cloudflare.workersDevSubdomain` | — | — |
| `fly.region` | `--region` | — |
| `tunnel.hostname` | — | — |
| `tunnel.cloudflaredImage` | — | — |
| `secrets.cloudflareApiToken` | `--api-token` | — |
| `secrets.flyApiToken` | `--api-token` | — |
| `secrets.tunnelToken` | — | — |
| `pushGateway.android` | — | `PUSH_ANDROID` |
| `pushGateway.ios` | — | `PUSH_IOS` |
| `pushGateway.iosLocKey` | — | `PUSH_IOS_LOC_KEY` |
| `pushGateway.apnsTopic` | — | `APNS_TOPIC` |
| `pushGateway.apnsKeyId` | — | `APNS_KEY_ID` |
| `pushGateway.apnsTeamId` | — | `APNS_TEAM_ID` |
| `pushGateway.apnsEnvironment` | — | `APNS_ENV` |
| `pushGateway.tokenPerHour` | — | `PUSH_TOKEN_PER_HOUR` |
| `pushGateway.tokenPerMinute` | — | `PUSH_TOKEN_PER_MINUTE` |
| `pushGateway.maxSkewSec` | — | `PUSH_MAX_SKEW_SEC` |
| `pushGateway.maxRegistrationDays` | — | `PUSH_MAX_REGISTRATION_DAYS` |
| `secrets.pushGatewayKey` | — | — |
| `secrets.fcmServiceAccount` | — | — |
| `secrets.apnsKey` | — | — |
| `site.allowedPubkeys` | `--allowed-pubkeys` | `ALLOWED_PUBKEYS` |
| `site.privateLane` | — | `LANES_ONLY` |
| `site.readOnlyLanes` | — | `READONLY_LANES` |
| `site.relayName` | `--relay-name` | `RELAY_NAME` |
| `site.relayDescription` | `--relay-description` | `RELAY_DESCRIPTION` |
| `site.relayContact` | `--relay-contact` | `RELAY_CONTACT` |
| `site.relayPubkey` | — | `RELAY_PUBKEY` |
| `site.donations` | — | `DONATE_*` |
| `site.relaySoftwareUrl` | `--relay-software-url` | `RELAY_SOFTWARE_URL` |
| `site.maxTtlDays` | `--max-ttl-days` | `MAX_TTL_DAYS` |
| `site.maxConnectionsPerPubkey` | `--max-connections-per-pubkey` | `MAX_CONNECTIONS_PER_PUBKEY` |
| `site.maxMessagesPerSecondPerIp` | `--max-messages-per-second-per-ip` | `MAX_MESSAGES_PER_SECOND_PER_IP` |
| `site.maxFileMb` | `--max-file-mb` | `MAX_FILE_MB` |
| `site.openFileRelay` | `--open-file-relay` | — |
| `site.appLanes` | `--app-lanes` | `APP_LANES` |
| `site.fileLanes` | `--file-lanes` | `FILE_LANES` |
| `site.appLanePow` | `--app-lane-pow` | `APP_LANE_POW` |
| `site.developerDocsUrl` | `--developer-docs-url` | `DEVELOPER_DOCS_URL` |
| `site.doCeilings` | — | `DO_CEILINGS_MIB` |
| `site.doGuaranteeKib` | — | `DO_GUARANTEE_KIB` |
| `site.doBorrowPercent` | — | `DO_BORROW_PERCENT` |
| `site.doNearFullPercent` | — | `DO_NEAR_FULL_PERCENT` |
| `site.doDropNotices` | — | `DO_DROP_NOTICES` |
| `site.maxConnections` | — | `MAX_CONNECTIONS` |
| `site.maxConnectionsPerIp` | — | `MAX_CONNECTIONS_PER_IP` |
| `site.monthlyTrafficGib` | — | `MONTHLY_TRAFFIC_GIB` |
| `site.trafficResetDay` | — | `TRAFFIC_RESET_DAY` |
| `site.trafficCount` | — | `TRAFFIC_COUNT` |
| `site.trafficNearFullPercent` | — | `TRAFFIC_NEAR_FULL_PERCENT` |
| `site.ceilingMode` | — | `CEILING_MODE` |
| `site.storageBudgetBytes` | — | — |

## 基本

### `configVersion`

設定檔格式的版號（目前是 1）。

- 型別：整數，1

### `sdk`

產生這份設定的 SDK 版號（relay build 會寫入）。

- 型別：字串，最長 64 字

### `target`

部署目標：cloudflare（wrangler）、cloudflare-api（REST，外掛用）、docker、fly、home-tunnel（家中主機＋Cloudflare Tunnel）。

- 型別：其中之一
- 可用的值：`cloudflare`, `cloudflare-api`, `docker`, `fly`, `home-tunnel`
- 旗標：`--provider`

### `service`

部署哪個服務：relay（Cinderous 中繼，預設）或 push-gateway（App 開發者的參考推播閘道；Workers 目標＝Workers 版，docker／fly／home-tunnel＝Node 版；兩版的 iOS 都能直連 APNs）。

- 型別：其中之一
- 可用的值：`relay`, `push-gateway`
- 預設：`relay`

### `name`

Worker／容器／Fly app 名稱：小寫英數與連字號、不以連字號開頭、最長 63 字。

- 型別：字串
- 格式：`^[a-z0-9][a-z0-9-]{0,62}$`
- 預設：`cinderous-relay`
- 旗標：`--name`

## 存取

### `site.allowedPubkeys`

白名單：只有這些公鑰（npub 或 64 字元 hex）能寫入。沒給＝開放中繼，任何人都能用你的額度。寫錯任何一筆就拒絕部署。

- 型別：公鑰清單（npub 或 hex）
- 旗標：`--allowed-pubkeys`
- 環境變數：`ALLOWED_PUBKEYS`
- 服務：`relay`

### `site.privateLane`

私人路徑（SDK ADR 0051）：開放寫入＋不可猜的隨機路徑。值是至少 26 字的隨機車道 id（例如 `openssl rand -hex 16`），只能寫 { "$env": "NAME" }。中繼設 APP_LANES＝它、LANES_ONLY=1（Cloudflare 開檔案時 FILE_LANES＝它），只接受 wss://&lt;host&gt;/app/&lt;id&gt;；白名單變成選用。🔴 這個網址等同密碼，外洩就換一個重新部署。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 環境變數：`LANES_ONLY`
- 服務：`relay`

### `site.readOnlyLanes`

唯讀寬限期（SDK ADR 0052）：換了私人路徑之後，舊路徑到期前只能讀（其他裝置從那裡收到搬家通知），到期後與認不得的路徑相同。值是 `<舊車道 id>@<到期 unix 秒>`（逗號分隔、最多 8 條、最長 30 天），只能寫 { "$env": "NAME" }（舊的 id 也是秘密）。過期的項目自動略過；一鍵部署（REST）的「換新路徑」會自動算出並保留線上還沒到期的。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 環境變數：`READONLY_LANES`
- 服務：`relay`

## Vault 同步

### `site.maxFileMb`

接受檔案塊（kind 1060）：Vault 同步必須開，建議 17。沒有 fileLanes 時是全站開關。開放中繼另外要 openFileRelay。

- 型別：整數，1–1024
- 旗標：`--max-file-mb`
- 環境變數：`MAX_FILE_MB`
- 服務：`relay`

### `site.openFileRelay`

沒有白名單也接受檔案塊（不建議：任何人都能存資料進來，儲存沒有上限）。

- 型別：布林值
- 旗標：`--open-file-relay`
- 服務：`relay`

⚠️ **危險選項**：`cinderous init` 要打出選項名稱才會開，部署說明也會把它列進安全檢查清單。開之前先讀完上面的說明。

## NIP-11 站台資訊

### `site.relayName`

NIP-11 站名。沒給用 SDK 的中立名稱。

- 型別：字串，最長 100 字
- 旗標：`--relay-name`
- 環境變數：`RELAY_NAME`
- 服務：`relay`

### `site.relayDescription`

NIP-11 描述。

- 型別：字串，最長 500 字
- 旗標：`--relay-description`
- 環境變數：`RELAY_DESCRIPTION`
- 服務：`relay`

### `site.relayContact`

NIP-11 聯絡方式（mailto:、網址或 Nostr）。

- 型別：字串，最長 200 字
- 旗標：`--relay-contact`
- 環境變數：`RELAY_CONTACT`
- 服務：`relay`

### `site.relayPubkey`

NIP-11 營運者公鑰（npub 或 hex，寫入 hex）。

- 型別：公鑰（npub 或 hex）
- 環境變數：`RELAY_PUBKEY`
- 服務：`relay`

### `site.donations`

贊助管道（githubSponsors、buyMeACoffee、liberapay、lightning；每項 ≤ 200 字）。全部沒給＝不顯示贊助入口。

- 型別：物件（見 JSON Schema）
- 環境變數：`DONATE_*`
- 服務：`relay`

### `site.relaySoftwareUrl`

NIP-11 software：這座站跑的程式的原始碼網址（https）。沒給＝SDK 的 repo。改過中繼程式再對外服務的人，依 AGPL §13 要指向修改後的原始碼。

- 型別：https 網址，最長 200 字
- 旗標：`--relay-software-url`
- 環境變數：`RELAY_SOFTWARE_URL`
- 服務：`relay`

### `site.developerDocsUrl`

連線被拒時附上的開發文件網址（https）。

- 型別：https 網址，最長 200 字
- 旗標：`--developer-docs-url`
- 環境變數：`DEVELOPER_DOCS_URL`
- 中繼宿主：Cloudflare（Worker）
- 服務：`relay`

## 上限

### `site.maxTtlDays`

離線留言保存上限（天）。

- 型別：整數，1–365
- 預設：`7`
- 旗標：`--max-ttl-days`
- 環境變數：`MAX_TTL_DAYS`
- 服務：`relay`

### `site.maxConnectionsPerPubkey`

同一把公鑰最多幾條連線。

- 型別：整數，1–100
- 預設：`5`
- 旗標：`--max-connections-per-pubkey`
- 環境變數：`MAX_CONNECTIONS_PER_PUBKEY`
- 服務：`relay`

### `site.maxMessagesPerSecondPerIp`

同一個 IP 每秒最多幾則訊息；超過就斷線。一次推很多事件的客戶端要自己節流。

- 型別：整數，1–1000
- 預設：`20`
- 旗標：`--max-messages-per-second-per-ip`
- 環境變數：`MAX_MESSAGES_PER_SECOND_PER_IP`
- 服務：`relay`

### `site.maxConnections`

全站最多幾條同時連線；沒設＝不限。只有 Node 主機。

- 型別：整數，1–1000000
- 環境變數：`MAX_CONNECTIONS`
- 中繼宿主：Node 主機
- 服務：`relay`

### `site.maxConnectionsPerIp`

同一個 IP 最多幾條同時連線；沒設＝不限（手機電信與公司網路常共用 IP）。只有 Node 主機。

- 型別：整數，1–10000
- 環境變數：`MAX_CONNECTIONS_PER_IP`
- 中繼宿主：Node 主機
- 服務：`relay`

### `site.monthlyTrafficGib`

每月流量預算（GiB）；用完暫停服務到重置日。只算 WebSocket 資料量，建議設成 VPS 方案的九成。只有 Node 主機。

- 型別：整數，1–1048576
- 環境變數：`MONTHLY_TRAFFIC_GIB`
- 中繼宿主：Node 主機
- 服務：`relay`

### `site.trafficResetDay`

每月幾號 00:00 UTC 歸零（1–28，預設 1）。

- 型別：整數，1–28
- 環境變數：`TRAFFIC_RESET_DAY`
- 中繼宿主：Node 主機
- 服務：`relay`

### `site.trafficCount`

流量怎麼算：total（預設，進出合計）或 out（只算出去的）。

- 型別：其中之一
- 可用的值：`total`, `out`
- 環境變數：`TRAFFIC_COUNT`
- 中繼宿主：Node 主機
- 服務：`relay`

### `site.trafficNearFullPercent`

用到幾 % 開始在 OK 帶預警（50–99）。

- 型別：整數，50–99
- 環境變數：`TRAFFIC_NEAR_FULL_PERCENT`
- 中繼宿主：Node 主機
- 服務：`relay`

## 車道（Cloudflare）

### `site.appLanes`

已知租戶車道（例如 dochost）：每條一顆 DO。🔴 改名單＝那條車道換一顆 DO，舊資料不會搬過去、回滾也拿不回來。

- 型別：字串清單，最多 32 項
- 格式：`^[a-z0-9][a-z0-9._-]{0,63}$`
- 旗標：`--app-lanes`
- 環境變數：`APP_LANES`
- 中繼宿主：Cloudflare（Worker）
- 服務：`relay`

⚠️ **危險選項**：`cinderous init` 要打出選項名稱才會開，部署說明也會把它列進安全檢查清單。開之前先讀完上面的說明。

### `site.fileLanes`

只在這些車道收檔案塊（須在 appLanes 上，並給 maxFileMb；這時 maxFileMb 是單檔上限）。

- 型別：字串清單
- 格式：`^[a-z0-9][a-z0-9._-]{0,63}$`
- 旗標：`--file-lanes`
- 環境變數：`FILE_LANES`
- 中繼宿主：Cloudflare（Worker）
- 服務：`relay`

### `site.appLanePow`

車道的 NIP-13 PoW 最低難度（0＝不要求）。🔴 開之前確認車道的客戶端會挖礦，否則持久化事件全被拒。

- 型別：整數，0–32
- 預設：`0`
- 旗標：`--app-lane-pow`
- 環境變數：`APP_LANE_POW`
- 中繼宿主：Cloudflare（Worker）
- 服務：`relay`

⚠️ **危險選項**：`cinderous init` 要打出選項名稱才會開，部署說明也會把它列進安全檢查清單。開之前先讀完上面的說明。

## 儲存容量

### `site.doCeilings`

每顆 DO 的容量天花板（MiB）：鍵是 strict／public／lane／file 或單顆 DO 名。帳號總量＝天花板 × DO 數，用 storageBudgetBytes 守。Cloudflare 版每項 1–8192；Node 主機只認 strict，1–1048576（1 TiB）。

- 型別：物件（見 JSON Schema）
- 環境變數：`DO_CEILINGS_MIB`
- 服務：`relay`

### `site.doGuaranteeKib`

共用 DO 內每位作者／收件人的保底（KiB）。只能設在淘汰制的對象。

- 型別：物件（見 JSON Schema）
- 環境變數：`DO_GUARANTEE_KIB`
- 服務：`relay`

### `site.doBorrowPercent`

溢位帶（天花板之上借用的百分比）；淘汰制要同時設保底。

- 型別：物件（見 JSON Schema）
- 環境變數：`DO_BORROW_PERCENT`
- 服務：`relay`

### `site.doNearFullPercent`

粗分級預警的門檻（%）。

- 型別：物件（見 JSON Schema）
- 環境變數：`DO_NEAR_FULL_PERCENT`
- 服務：`relay`

### `site.doDropNotices`

開啟丟棄計數的對象。

- 型別：字串清單
- 環境變數：`DO_DROP_NOTICES`
- 服務：`relay`

### `site.ceilingMode`

滿了之後：reject（預設，拒收）或 evict（淘汰最快到期的）。只有 Node 主機。

- 型別：其中之一
- 可用的值：`reject`, `evict`
- 環境變數：`CEILING_MODE`
- 中繼宿主：Node 主機
- 服務：`relay`

### `site.storageBudgetBytes`

帳號儲存預算（位元組）：所有可能 DO 的最壞加總超過就拒絕部署。免費方案建議 4,000,000,000（5 GB 的 80%）。

- 型別：整數，至少 1
- 中繼宿主：Cloudflare（Worker）
- 服務：`relay`

## 宿主

### `node.persist`

以 SQLite 保存離線留言（掛 volume）；預設純記憶體，重啟即清空。

- 型別：布林值
- 預設：`false`
- 旗標：`--persist`
- 部署目標：`docker`, `fly`, `home-tunnel`
- 服務：`relay`

### `node.port`

docker：對外的埠。

- 型別：整數，1–65535
- 預設：`8080`
- 旗標：`--port`
- 部署目標：`docker`

### `node.trustProxy`

信任前面代理的 X-Forwarded-For（TRUST_PROXY=1）。docker 只有在反向代理後方才開；fly 與 home-tunnel 一定開。

- 型別：布林值
- 預設：`false`
- 部署目標：`docker`, `fly`, `home-tunnel`
- 服務：`relay`

⚠️ **危險選項**：`cinderous init` 要打出選項名稱才會開，部署說明也會把它列進安全檢查清單。開之前先讀完上面的說明。

### `cloudflare.accountId`

Cloudflare Account ID（32 字元 hex；不是秘密）。有多個帳號時務必給：wrangler 會沿用上次登入的帳號。

- 型別：字串，或 `{ "$env": "NAME" }`
- 格式：`^[0-9a-f]{32}$`
- 旗標：`--account-id`
- 沒給時讀：`CLOUDFLARE_ACCOUNT_ID`
- 部署目標：`cloudflare`, `cloudflare-api`

### `cloudflare.compatibilityDate`

Workers 的 compatibility_date（YYYY-MM-DD）。記在設定檔裡，不隨 CLI 升級改變。

- 型別：字串
- 格式：`^\d{4}-\d{2}-\d{2}$`
- 預設：`2026-09-01`
- 旗標：`--compatibility-date`
- 部署目標：`cloudflare`, `cloudflare-api`

### `cloudflare.workersDevSubdomain`

workers.dev 子網域（帳號的那一段）。REST 路徑在帳號還沒有子網域時用它註冊；部署說明用它寫出完整網址。

- 型別：字串
- 格式：`^[a-z0-9][a-z0-9-]{0,62}$`
- 部署目標：`cloudflare`, `cloudflare-api`

### `fly.region`

Fly 區域代碼（例如 nrt、sin、iad）。

- 型別：字串
- 格式：`^[a-z]{3}$`
- 預設：`nrt`
- 旗標：`--region`
- 部署目標：`fly`

### `tunnel.hostname`

對外的主機名稱（例如 relay.example.com，要在你放到 Cloudflare 的網域下）。客戶端連 wss://&lt;這個名稱&gt;。

- 型別：字串
- 格式：`^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`
- 部署目標：`home-tunnel`
- 必填於：`home-tunnel`

### `tunnel.cloudflaredImage`

cloudflared 映像。要可重現就釘版本或 digest（例如 cloudflare/cloudflared:2026.9.0）。

- 型別：字串
- 格式：`^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$`
- 預設：`cloudflare/cloudflared:latest`
- 部署目標：`home-tunnel`

## 秘密

### `secrets.cloudflareApiToken`

Cloudflare API Token 的環境變數名稱。沒給讀 CLOUDFLARE_API_TOKEN；都沒有就交給 wrangler 自己的登入（wrangler login）。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 旗標：`--api-token`
- 秘密：設定檔只能寫 `{ "$env": "NAME" }`; 沒給時讀 `CLOUDFLARE_API_TOKEN`
- 部署目標：`cloudflare`, `cloudflare-api`

### `secrets.flyApiToken`

Fly API Token 的環境變數名稱。沒給讀 FLY_API_TOKEN；都沒有就交給 flyctl 自己的登入（fly auth login）。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 旗標：`--api-token`
- 秘密：設定檔只能寫 `{ "$env": "NAME" }`; 沒給時讀 `FLY_API_TOKEN`
- 部署目標：`fly`

### `secrets.tunnelToken`

Cloudflare Tunnel Token 的環境變數名稱（cloudflared 用；寫在部署包的 .env，不要提交）。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 秘密：設定檔只能寫 `{ "$env": "NAME" }`; 沒給時讀 `TUNNEL_TOKEN`
- 部署目標：`home-tunnel`
- 必填於：`home-tunnel`

### `secrets.pushGatewayKey`

推播閘道私鑰的環境變數名稱（cinderous iot push-keygen 產生）。換掉它＝所有 App 的 token 封包作廢，要重新登記。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 秘密：設定檔只能寫 `{ "$env": "NAME" }`; 沒給時讀 `PUSH_GATEWAY_KEY`
- 服務：`push-gateway`

### `secrets.fcmServiceAccount`

Firebase 服務帳號 JSON 的環境變數名稱（整份 JSON 一行）。Android 或 iOS 經 FCM 時必填。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 秘密：設定檔只能寫 `{ "$env": "NAME" }`; 沒給時讀 `FCM_SERVICE_ACCOUNT`
- 服務：`push-gateway`

### `secrets.apnsKey`

APNs .p8 金鑰內容的環境變數名稱（換行寫成 \n）。直連 APNs（pushGateway.ios=apns，Workers 版與 Node 版）時必填；Workers 版也可以把 .p8 檔直接導入 wrangler secret。

- 型別：秘密參照 `{ "$env": "NAME" }`
- 秘密：設定檔只能寫 `{ "$env": "NAME" }`; 沒給時讀 `APNS_KEY`
- 服務：`push-gateway`

## 推播閘道

### `pushGateway.android`

Android：經 FCM 送高優先的空資料訊息（需要 Firebase 服務帳號）。關掉時 Android App 請改用 UnifiedPush（不需要推播閘道）。

- 型別：布林值
- 預設：`true`
- 環境變數：`PUSH_ANDROID`
- 服務：`push-gateway`

### `pushGateway.ios`

iOS：apns＝直連 APNs（預設，v0.48.0 起；Workers 版與 Node 版都可以，不經 Google，要 APNs 金鑰）；fcm＝經 Firebase 轉給 APNs（已棄用：Google 也看得到 iOS 喚醒的時間點）；off＝不支援 iOS（只要 Android 時用它，不需要 Apple 金鑰）。

- 型別：其中之一
- 可用的值：`apns`, `fcm`, `off`
- 預設：`apns`
- 環境變數：`PUSH_IOS`
- 服務：`push-gateway`

### `pushGateway.iosLocKey`

iOS 通知的在地化鍵（大寫英數與底線）：推播裡沒有任何文字，App 的 Localizable.strings 提供「有新動態」之類的通用字樣；NSE 解密後改寫。

- 型別：字串
- 格式：`^[A-Z][A-Z0-9_]{0,63}$`
- 預設：`CINDER_WAKE`
- 環境變數：`PUSH_IOS_LOC_KEY`
- 服務：`push-gateway`

### `pushGateway.apnsTopic`

直連 APNs：App 的 bundle id（apns-topic）。

- 型別：字串
- 格式：`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`
- 環境變數：`APNS_TOPIC`
- 服務：`push-gateway`

### `pushGateway.apnsKeyId`

直連 APNs：.p8 金鑰的 Key ID（10 字元；不是秘密）。

- 型別：字串
- 格式：`^[A-Z0-9]{10}$`
- 環境變數：`APNS_KEY_ID`
- 服務：`push-gateway`

### `pushGateway.apnsTeamId`

直連 APNs：Apple Developer 的 Team ID（10 字元）。

- 型別：字串
- 格式：`^[A-Z0-9]{10}$`
- 環境變數：`APNS_TEAM_ID`
- 服務：`push-gateway`

### `pushGateway.apnsEnvironment`

直連 APNs：production（App Store／TestFlight）或 sandbox（Xcode 直接安裝的開發版）。

- 型別：其中之一
- 可用的值：`production`, `sandbox`
- 預設：`production`
- 環境變數：`APNS_ENV`
- 服務：`push-gateway`

### `pushGateway.tokenPerHour`

每個推播 token 每小時最多送幾次（裁示 7，預設 60）。所有送出端（設備、IoT 閘道、中繼）合計。

- 型別：整數，1–3600
- 預設：`60`
- 環境變數：`PUSH_TOKEN_PER_HOUR`
- 服務：`push-gateway`

### `pushGateway.tokenPerMinute`

每個推播 token 每分鐘最多送幾次（預設 6＝即時模式的上限；縱深防禦，送出端本來就會合併與節流）。

- 型別：整數，1–60
- 預設：`6`
- 環境變數：`PUSH_TOKEN_PER_MINUTE`
- 服務：`push-gateway`

### `pushGateway.maxSkewSec`

喚醒請求的時間戳最多與推播閘道差幾秒（防重放的時間窗；設備要有 NTP）。

- 型別：整數，30–3600
- 預設：`300`
- 環境變數：`PUSH_MAX_SKEW_SEC`
- 服務：`push-gateway`

### `pushGateway.maxRegistrationDays`

token 封包最長能活幾天（ADR-0272：30 天；App 啟動時續期）。超過的封包一律拒絕。

- 型別：整數，1–30
- 預設：`30`
- 環境變數：`PUSH_MAX_REGISTRATION_DAYS`
- 服務：`push-gateway`
