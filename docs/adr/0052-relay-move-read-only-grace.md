# 0052. 換私人路徑之後：舊路徑的唯讀寬限期（`READONLY_LANES`、`retireLane`）與名單加密的中繼搬家通知

- 狀態：**已接受（Accepted，2026-10-04）**——使用者 2026-10-04 指示「先做 G21」並給定設計；實作於 v0.42.0
- 日期：2026-10-04
- 對應：CinderSync ARCHITECTURE §5 **G21**（中繼清單只在配對時交付一次；換了私人路徑，其他裝置的舊網址立刻失效）；CinderSync 的新 ADR（0026）。
  相關：本 repo ADR 0028（配對與名單、`NostrRosterSync`）、0043（名單外層 1059／1060）、0051（私人路徑、`LANES_ONLY`、`allowLaneChange`）、0050（設定器、秘密只寫 `$env`）；
  Cinderous ADR-0366（車道路由）、ADR-0368（拒絕時說明原因、不回顯路徑）。

## Context

ADR 0051 的補救是「網址外洩就換一個 id 重新部署」，但換了之後**舊網址立刻失效**，而其他裝置（CinderSync 的排程同步每 1–24 小時才連一次）
只知道舊網址：它們再也連不上，只能手動從部署的那台複製新網址。ADR 0051〈殘餘風險〉與 CinderSync ADR 0025 都把這個記為 G21。

要解決的是兩件事：

1. **其他裝置怎麼拿到新網址**——而且只有**目前名單上的成員**拿得到（換路徑常常正是因為移除了一台裝置，或網址外洩）。
2. **晚上線的裝置**（部署那一刻不在線）怎麼還收得到——舊網址一失效，放在它上面的任何通知都讀不到。

## Decision

### §1 中繼：舊路徑的唯讀寬限期（`READONLY_LANES`，兩座宿主同一個環境變數）

- `READONLY_LANES=<車道 id>@<到期 unix 秒>[,…]`（`readOnlyLanesFrom`；id 不分大小寫、同一條列兩次取較晚的；最多 `READONLY_LANES_MAX = 8` 條；
  寫錯的項目不採用、宿主啟動時 `console.warn`，**只印第幾項與原因、不印 id**——它曾經是私人路徑）。
- 列在上面、**還沒到期**、而且不在 `APP_LANES` 上的車道（`readOnlyLaneIds(env, nowSec)`）：
  - **路由**：`routeForPath(…, { readOnlyLanes })` 把它送到它**原本那顆 DO**（`app:<id>`、`known: true`、多一個 `readOnly: true`）；`LANES_ONLY` 時也算連得上。
  - **寫入一律拒絕**：`RelayCore` 新選項 `readOnly`（Worker：整顆 DO；Node：依連線，因為所有路徑共用一個 core）。`EVENT` 回
    `OK false "restricted: read-only: 這條路徑已停用、只能讀取（換了新網址），不再接受寫入"`，擺在認證與一切檢查之前。新詞元 `read-only`（`restricted` 類，換座有用、重試沒用）。
    🔴 句子**不提新網址、不提任何車道**：拒絕訊息是任何拿到舊網址的人都看得到的，新網址只經名單加密的通知交出（§3）。
  - **讀照常**：`REQ`、`AUTH`、`CLOSE`、既有資料都在。
  - **NIP-11**：`limitation.restricted_writes: true`、`cinder_read_only_until: <到期>`、`cinder_accepts_files: false`（寫入一律被拒，客戶端不必試）。
- **到期由中繼自己判斷，不需要再部署**：到期後路由與認不得的路徑相同（`LANES_ONLY` 時 `unknown-path` 的 NOTICE＋1008、NIP-11 404，逐字相同）；
  還開著的連線在**下一則訊息**時以同一個拒絕關掉（Worker 的 `webSocketMessage`、Node 的 `message`；`laneStateOf` 回 `expired`）。
- **資料保留到期為止**：舊車道那顆 DO 不刪；車道模式（有 `FILE_LANES`）下唯讀車道沿用檔案車道的儲存設定（天花板、每收件人塊數，`fileLanes()`），
  否則換路徑後那顆 DO 以一般車道的天花板重組、既有檔案塊可能被淘汰。到期之後的資料照 ADR 0051 的說法等各自的 TTL。
- 帳號儲存預算（`allDoNames`／`worstCaseStorage`／`computeCeilingBudget`）把唯讀車道算進去（不論是否已過期，保守）。
- 同時在 `APP_LANES` 上的以 `APP_LANES` 為準（照常可寫）。沒設＝與 v0.41 完全相同。

### §2 部署：`retireLane` 與 `readOnlyLanes`

- `RelaySiteOptions.readOnlyLanes?: { id, expiresAt }[]` → `READONLY_LANES`（`readOnlyLanesVar`）。四條部署路徑共用 `relaySiteVars`：
  過期的**自動略過**；不合法（`invalid-read-only-lane`）、超過現在＋31 天（`read-only-too-long`）、與這次可寫的車道相同（`read-only-lane-active`）、超過 8 條（`too-many-lanes`）都拒絕，**訊息不回顯 id**。Node 主機也支援。
- REST 一鍵部署（`deployCloudflareRelayViaApi`）新選項 **`retireLane: { id, graceDays? }`**（`READ_ONLY_GRACE_DAYS`：1–30，預設 7）：
  要搭配新的 `privateLane`（與 `allowLaneChange`）；驗證在任何網路請求之前。部署出來 `APP_LANES` 只有新的、`READONLY_LANES` 加上舊的與「現在＋天數」。
- **重新部署不弄丟寬限期**：一次讀線上設定（`APP_LANES`、`LANES_ONLY`、`READONLY_LANES`），線上還沒到期、這次又不是可寫的那幾條保留（同一條取較晚的到期；
  超過上限留最晚到期的）；過期的清掉。讀不到線上設定時只寫這次的（與 ADR 0051 的檢查同一個「讀不到就略過」）。結果多 `readOnlyLanes`。

### §3 搬家通知（`./pairing`；與名單同一個封裝、同一個訂閱）

放在 SDK 而不是外掛：它是「名單成員之間傳送、只給目前成員」的協定（CinderSync 的硬規則：同步、加密、傳輸一律走 SDK），與 `NostrRosterSync` 同一個信任模型。

- **格式**：NIP-59，外層與名單相同（預設 1060，`outerKind: 1059` 可選），內層 rumor **kind 4363**（4361 名單、4362 裝置宣告簽章之後；查過沒有撞號），
  內容 `{ v: 1, from, to, at, device? }`，`expiration` 預設 31 天（中繼會以自己的上限截短）。外層看不出網址。
- **收件人＝名單上目前有效的每一台，含自己**：被撤銷的裝置不在收件人裡，收不到新網址（這正好補上 ADR 0051／CinderSync ADR 0025「被移除的裝置仍知道網址」——移除裝置後換路徑，它就被擋在外面）。
  含自己是為了「部署回報失敗、其實已經上線」時這台也能從通知自我修正（§4 的規則對它一樣成立）。
- **送出** `announceRelayMove({ membership, signer, move, relays, connect })`：呼叫端給連線（例如 `new RelayPool`；`./pairing` 子路徑仍零執行期相依），
  先等連線開起來（預設 10 秒），每位收件人一顆，回傳**收下了全部收件人那一顆**的中繼。用法（CinderSync）：
  1. 部署**之前**：產生新 id、預測新網址（同一個 Worker、同一個子網域），送到**舊路徑（此時還能寫）＋所有其他共同的中繼（主清單與備援）**；
     **至少一座收下才部署**，否則不部署（說明原因）。
  2. 部署成功後：同一則（實際網址與預測的不同時用實際的、時間較新）再送到**新路徑＋其他中繼**（舊路徑已唯讀）。
- **收到**：`NostrRosterSync` 新選項 `onRelayMove`——名單事件解不開時試搬家通知，寄件人必須是本機名單上的**有效成員**才交出（非成員偽造的、已被撤銷的成員寄的都丟掉）。

### §4 採用規則：只替換、取最新、**切換前先測試新網址**（取代「確認訊息」）

使用者的設計列了兩種做法擇一：「部署成功後再送一則『已生效』確認，收方收到確認才切換」或「收方切換前先測試新網址能連上再替換」。**選後者**，理由：

- 部署成功之後舊路徑**已經唯讀**，「已生效」確認寫不進舊路徑；而晚上線的裝置只連得到舊路徑——確認做法對最需要它的那群裝置無效。
- 僅限車道的中繼對**還沒部署上去的路徑回 NIP-11 404**（ADR 0051），部署成功後回 200：測試本身就是「部署確實成功」的證明，不需要另一則訊息、也沒有「確認送丟了」的狀態。

規則（`planRelayMoves` 純邏輯＋`probe`；`probeRelayEndpoint` 讀 NIP-11，200 的 JSON 物件、而且**不是**唯讀寬限期中的路徑才算）：

- 只**替換**自己清單（主清單或備援）裡已經有的舊網址：原地、保持順序、去重；新網址已在主清單就從備援拿掉。不在清單裡的網址不採用（不新增）。
- 同一個舊網址有好幾則：從最新的開始試，第一個測得通的採用；都不通就不動。所以**部署失敗＝沒有任何裝置切換**，之後的重試（同一個新 id）或另一個新路徑的通知
  自然取代舊的——不需要「取消」訊息。
- 連鎖搬家（A→B、B→C）最多跟 4 層；每個網址一輪只測一次。

### §5 設定器（ADR 0050）

- 描述表 `site.readOnlyLanes`（`secret-ref`，env `READONLY_LANES`）：設定檔**只能寫 `{ "$env": "NAME" }`**（舊 id 也是秘密），值是 `READONLY_LANES` 的格式；
  `DeploySiteOptions.readOnlyLanes` 是 `SecretRef`、JSON Schema 重新產生；驗證以佔位值（`READ_ONLY_LANE_PLACEHOLDER`）；`relay deploy --config` 部署時解析（沒有值＝沒有，格式不對丟例外、不印 id）。
- 部署包不含秘密：Workers 的 `wrangler.toml` 不寫、說明教 `npx wrangler@4 secret put READONLY_LANES`；compose `READONLY_LANES: "${NAME:-}"`（沒設＝沒有，不擋啟動）；
  Fly 不寫進 `fly.toml`、說明教 `fly secrets set`；`.env.example` 列出變數。`DEPLOY_AFFECTING_CHANGES` 加 0.42.0。
- Token 指南的 `lane-change` 說明改成「舊網址不能再寫入（有寬限期時到期前還能讀）；支援搬家通知的應用會自動讓其他裝置改用新網址」。

## 與使用者設計的差異

- 「部署失敗時訊息要能被取消或覆蓋」：以 §4 的「取最新而且測得通的」達成，**沒有**另做取消訊息或可取代事件——失敗的新路徑永遠測不通，等同自動取消。
- 「收方切換前先測試」與「已生效確認」擇一：選測試（理由見 §4）。
- 收件人含自己（使用者的設計只說「目前名單上的成員」）：為了部署回報失敗但其實已上線時的自我修正；對其他規則沒有影響。
- 舊的根路徑（ADR 0051 之前的白名單部署）轉成私人路徑時**沒有**唯讀寬限期：`READONLY_LANES` 只認車道，根路徑在 `LANES_ONLY` 下立刻被拒。部署前的通知仍會寫到舊站（那時還能寫），
  只有部署當下在線、或經其他共同中繼的裝置收得到。

## 殘餘風險

- **寬限期內舊網址仍可讀**：拿到舊網址的人（例如外洩的對象、被移除的裝置）在到期前還能讀到舊路徑上的**密文**與中繼後設資料（誰的 `#p`、時間、大小），不能寫。
  寬限期愈長愈多；可選 1 天。內容本來就端對端加密，讀不到。
- **全部錯過寬限期又沒有共同中繼的裝置**仍然拿不到新網址（只能手動貼）——應用要在「連舊網址得到 `unknown-path`」時提示（`isUnknownRelayPathMessage`）。
- 新網址的「測試」是 NIP-11 GET：被動的網路觀察者看得到這台去讀新網址（路徑在 TLS 裡，只看得到主機）；與平常連線相同。
- 部署前的通知送到其他共同中繼時，那些中繼看得到一顆寄給每位成員的禮物包（大小、時間），與名單同步相同。
- 測試用的是 Node 主機（真的開一台、同一個 SQLite 模擬重新部署）與假的 DO 環境；**尚未在真的 Cloudflare 上換過一次路徑**。

## 測試

- `tests/relay/read-only-lanes.test.ts`：解析（大小寫、重複、上限、寫錯不回顯 id）、`readOnlyLaneIds`／`laneStateOf` 的到期、`routeForPath` 與 `allDoNames`／預算、
  檔案政策沿用、`RelayCore` 的唯讀閘門（認證前就拒、讀照常、依連線判斷）。
- `tests/relay/lanes-only.test.ts`（Worker 路由）：寬限期內舊路徑落在原本的 DO、到期後與認不得的路徑逐字相同、NIP-11 的唯讀宣告。
- `tests/relay/worker.test.ts`（假 DO）：同一份 storage 換環境＝重新部署，舊資料讀得到、寫入被拒且不提新網址；連線期間到期 → 下一則就以 1008 關掉；新路徑照常可寫。
- `tests/relay/lanes-only-node.test.ts`（真的 Node 主機）：舊路徑寫入被拒、新路徑可寫、NIP-11 唯讀、不重啟就到期。
- `tests/relay/reject-contract.test.ts`：`restricted: read-only:` 的分類。
- `tests/deploy/private-lane.test.ts`：`readOnlyLanes` 的驗證與不回顯；`retireLane`（預設 7 天、1–30、驗證在請求之前）、重新部署保留還沒到期的、連換兩次；設定器（Schema、`$env`、部署包、`resolveSiteSecrets`）。
- `tests/pairing/relay-move.test.ts`：格式（外層看不出網址、別人解不開）、`onRelayMove` 只交出成員寄的（非成員偽造、已撤銷的成員都丟掉）、`announceRelayMove`
  （收件人含自己、被移除的不在裡面、等連線、逾時）、`planRelayMoves`（只替換、不新增、測試失敗不換、取最新、備援、連鎖）、`probeRelayEndpoint`；
  **端到端**（真的 Node 中繼＋SQLite）：A 部署前送到舊路徑 → 換路徑重新部署 → 晚上線的 B 從唯讀的舊路徑收到、測試新網址、換過去；被移除的 C 收不到；到期後舊路徑 `unknown-path`。

## Consequences

- ＋ 換路徑不再需要每台手動改網址：目前名單上的裝置在寬限期內（預設 7 天）任何一次同步就會自動換過去；有共同中繼的裝置過了寬限期也收得到。
- ＋ 移除裝置後換路徑，被移除的那台被擋在外面（收不到新網址），補上 ADR 0051 的殘餘風險。
- ＋ 中繼不需要新狀態、不需要再部署：到期純粹是環境變數與時鐘。
- － 寬限期內舊網址仍可讀（密文與後設資料）。
- － 多一個環境變數要在重新部署時保留（REST 路徑自動處理；wrangler／docker／fly 要自己帶）。
