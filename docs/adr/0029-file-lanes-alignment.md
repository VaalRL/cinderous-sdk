# 0029. 對齊中繼的檔案車道（Cinderous ADR-0371）：客戶端依 NIP-11 決定單檔上限與補送預算、以 `until` 分頁取回；中繼逐項移植 `FILE_LANES`

- 狀態：Accepted
- 日期：2026-09-29
- 加註（2026-10-01，ADR 0045）：`forEachPage` 的「一頁沒有新事件就停」在**沒有任何中繼回完**時會誤判成翻完了；v0.36 起池有 `queryResult` 時該頁回 `unanswered`、`backfill()`／`FastHydrator` 不推進起點並丟 `RelayQueryIncompleteError`，`queryPaged` 丟錯。
- 對應：Cinderous ADR-0371（檔案車道，Cinderous main merge commit `73756982`，錨點 1 已部署驗證）。
  相關：本 repo ADR 0007（中繼搬進 SDK）、0019（中立預設值）、0025（協調器）、0026（批次模式與補送速率）、
  0027（Vault 同步需要中繼收檔案事件）、0028 §7（白名單站放行已認證成員的禮物包）。

## Context

Cinderous ADR-0371 讓官方錨點**只在** `cindersync`、`cinder-coffice` 兩條已知租戶車道（`/app/<id>`）收 kind 1060，
`MAX_FILE_MB=30` 在那個模式代表**單檔上限**，NIP-11（車道路徑）宣告 `cinder_max_file_mb: 30` 與
`cinder_file_chunks_per_recipient: 1440`，保存 7 天、每顆檔案車道 DO 天花板 1 GiB；儲存層加 `bytes` 欄與覆蓋索引、
用量快取；一次 REQ 最多回 16 MB（超過由客戶端用 `until` 分頁）；並修了重複 `p` 多算、檔案桶配額依附聊天上限。
ADR-0371〈後續〉點名 SDK 的四個缺口，以及 PR #9（Cinderous 改用 SDK 中繼）合併前 SDK 中繼必須具備同一套功能：

1. 收端檔案塊層上限 360 塊（≈16.5 MB）、`VAULT_SYNC_MAX_FILE_MB = 17`：30 MB 的檔案經中繼到不了。
2. `DEFAULT_RELAY_BULK_PER_HOUR = 20` 是以「4,000 塊／7 天」設計，而且數的是**則**不是**塊**——一則帶內容的訊息
   可能有幾百塊。1,440 塊的車道上連續補送 72 小時就會把最舊、收件人還沒領的塊 FIFO 擠掉。
3. SDK 不分頁：中繼的位元組預算把回應截斷（而且不回報）時，離線回來只拿得到最新的約 120 塊，一則大訊息的訊框收不齊。
4. 讀 NIP-11 要讀**車道路徑**的那份（根路徑是主訊息平面，不收檔案）。

限制：TDD、向下相容、零 Node 子路徑守門、主入口打包不變大；SDK 預設值不寫任何錨點專屬的值（ADR 0019）。

## Decision

### A. 客戶端

**§A1 單檔上限：收端只擋絕對上限，送端依中繼宣告**

- `RELAY_FILE_MAX_BYTES_CAP = 64 MiB`（`./sync`）：收端防 DoS 的絕對上限。`FILE_CHUNK_MAX_TOTAL` 360 → 1,399、
  協調器訊框上限 `VAULT_MAX_FRAMES` 381 → 1,420、`validateVaultMessage` 的內容上限都改以它為準。
  收端不知道送端用的是哪一座中繼、宣告多少，所以不再要求「大小與 `p2p` 旗標」和自己的門檻一致；
  只保留「大檔一定大於快照層」與「非大檔不超過絕對上限」。
- 送端的中繼層門檻由 `relayTierMaxBytes(maxFileMb)`（MiB → 位元組，夾在 [快照層上限＋1, 64 MiB]）決定；
  `classifyPayload(size, fileTierMaxBytes?)` 多一個參數（預設不變）。30 MB ＝ 31,457,280 B ＝ **656 塊**；
  一則帶 30 MB 內容的版本訊息，標頭塞得進最後一塊的 30 KB 餘裕，仍是 656 塊（測試釘住）。
- **預設不變**：沒有中繼宣告時仍是 `FILE_TIER_MAX_BYTES`（360 × 48,000 ＝ 17,280,000 B）。
  🔴 舊版（≤ v0.24）收端只收得下這麼大：把門檻調高之前，同一個 Vault 的每一台裝置都要先升到 v0.25。

**§A2 讀中繼的檔案政策（NIP-11，車道路徑）**

- `fetchRelayFilePolicy(url, { fetch })`：`wss://<host>/app/<車道>` → `GET https://<host>/app/<車道>`
  （`Accept: application/nostr+json`，路徑保留），回 `acceptsFiles`、`maxFileMb`、`fileChunksPerRecipient`、
  `retentionSeconds`（NIP-11 `retention` 中明確涵蓋 1060 的那項優先，其次不分 kind 的那項）。
  `checkRelayAcceptsFiles` 改為同一個函式（回傳多了三個選填欄位，向下相容）。測試以 SDK 自己的 Worker 路由驗證。
- `relayFileLimits(policies, { ttlSeconds })`：多座合成**最嚴的**一組——協調器一則訊息同時送到每一座。
  明確不收檔案的那座不參與；讀不到或沒宣告的欄位用保守預設；單檔上限與配額取最小、保存期取最長（但不超過自己的過期章）。
- `loadRelayFileLimits(urls)`：逐座讀、讀不到的當未知（不丟例外），回傳合成結果與每座的政策。
- 保守預設 `DEFAULT_RELAY_FILE_LIMITS`：16.5 MB、**848 塊**（中繼檔案車道的配額公式「2 × 上限檔塊數 ＋ 128」
  套上預設門檻 360 塊）、7 天。比任何已知的設定都小（中繼預設 4,000；Cinderous 檔案車道 1,440），而且不是錨點的值。

**§A3 補送預算改以塊計算，而且以「保存期內的總量」執行**

- 協調器新選項 `relayLimits`（`maxFileBytes`、`chunksPerRecipient`、`retentionSeconds`）與方法 `setRelayLimits()`
  （連線後讀到 NIP-11 再調整）。
- 預算 `relayChunkBudget = ⌊配額 × RELAY_QUOTA_SAFETY(0.75)⌋`；**任何一段保存期內**，這台裝置寄給同一位收件人的
  塊數（每則訊息的訊框數，`vaultFrameCount(encodedVaultMessageLength(message))`）不超過預算。
  1,440 塊／7 天 → 1,080 塊；平均安全速率（`safeRelayChunksPerHour`）＝ 1,080 ÷ 168 ≈ **6.4 塊／小時**。
- 為什麼不是「每小時 N 塊」的固定速率：一顆 30 MB 的檔案 656 塊，任何小於 656／小時的固定速率都會讓它永遠送不出去；
  而用漏桶放行大訊息又會在一段保存期內超量（上界是「預算 ＋ 最大訊息」）。以保存期為窗直接對應中繼的 FIFO＋TTL，
  是能證明「不擠掉」的最緊的做法：656 塊可以一次送出，之後等最舊的用量過了保存期。用量是空的時候一律放行
  （一則比整份預算大的訊息不能永遠卡住；預算 1,080 ≥ 656）。
- 用量以小時為桶記在協調器的持久化狀態（`m` 的 `relayUse`，最多約 169 筆），**跨重開保留**；整小時都過期才丟（寧可多算）。
  所有經傳輸層送出的訊息（版本、摘要、索取）都計入；**只有批次模式會等**（即時的少量變更照舊立刻送）。
  `status().relayQuota = { used, budget }`。
- `DEFAULT_RELAY_BULK_PER_HOUR = 20`（則／小時）保留為平滑；配額由塊數預算守。

**§A4 分頁取回**

- `forEachPage(pool, filters, onPage, { maxPages })`／`queryPaged`（`./sync`，只用 `pool.query`）：
  以這一頁最舊的 `created_at` 當下一頁的 `until`（NIP-01 含邊界，同一秒的不會漏；整頁都是同一秒時往前推一秒，
  保證前進），**直到一頁沒有任何新事件為止**——不猜中繼有沒有截斷（中繼不回報）。代價是每次多一個（通常是空的）REQ。
  `maxPages` 預設 64（每頁至多 16 MB）；撞到上限回 `complete: false`。
- `FastHydrator.resume()` 預設分頁（`maxPages: 1` 回到 v0.24 的行為）；撞到頁數上限時**不前進**同步時間。
- `NostrVaultTransport.backfill()`：連線池有 `query`（`RelayPool` 有）就在 `start()` 與**重新連上**時分頁補拉；
  起點是上一次成功補拉開始的時間（退讓 NIP-59 的兩天倒填窗）。這也補上既有的縫：連線池重新連上時以「看過的最新時間」
  當 `since` 補訂閱，外層時間被往前推的禮物包會落在它前面。沒有 `query`（自訂連線池）或 `backfillPages: 0` 時不動。
- 主入口不變：分頁全部在 `./sync` 實作、只用 `RelayPool` 既有的 `query`，沒有改連線池。

### B. 中繼（`./relay`；以 Cinderous main `73756982` 為準逐項移植）

| Cinderous ADR-0371 | SDK |
| --- | --- |
| §1 `FILE_LANES`、`fileLanesMode`、`fileLanes`（須同時在 `APP_LANES`、否則忽略並 `console.warn`）、`filePolicyFor`（fail-closed） | 同（`host-config.ts`） |
| §1 DO 記住車道 id（`cinder:lane-id`），升級前釘住的 DO 下次連線補記、不回 409 | 同（`worker.ts`，鍵名相同） |
| §1 node 主機沒有車道：`filePolicyFor(env)`；設了 `FILE_LANES` 整站不收並警告 | 同（`node-relay.ts` 的 `startNodeRelay(env)`） |
| §2 NIP-11 `cinder_max_file_mb`、`cinder_file_chunks_per_recipient`（只在車道模式、收檔案的路徑） | 同（`nip11.ts`、`relayInfoFrom(env, profile, known, laneId)`） |
| §3 `FILE_CHUNK_PLAINTEXT_BYTES`、`fileChunksFor`、`fileLaneChunksPerRecipient`（2 × 上限檔 ＋ 128） | 同 |
| §4 `FILE_LANE_OFFLINE_MAX_BYTES` 1 GiB；`storeOptions(..., maxFileMb)` | 同 |
| §5 `bytes` 欄、部分索引回填、`idx_offline_bucket` 取代 `idx_offline_recipient`、用量／分桶快取、`INSERT OR IGNORE` 不重算、只修剪落到的那一桶、重複 `p` 去重、檔案桶無條件修剪 | 同（`sql-message-store.ts`） |
| §6 `MAX_QUERY_BYTES` 16 MB、`query(filter, now, maxBytes)` 兩步選取、`RelayCore.maxQueryBytes` 整個 REQ 共用 | 同（`message-store.ts`、`relay-core.ts`） |
| §7 錨點設定（`wrangler.toml` 的 30、`cindersync,cinder-coffice`） | **不移植**：那是 Cinderous 的部署設定（ADR 0019）。SDK 只提供 `FILE_LANES`／`MAX_FILE_MB` 的能力，預設都不設 |

- 差異只有 SDK 既有的部分（白名單、每把公鑰連線數、每 IP 速率、關閉碼、中立的文件網址與站名、`relayVersion()`），
  以及註解裡的 ADR 編號加上「Cinderous」前綴。移植方式是把 `73756982` 的 relay 差異套上 SDK（`git apply`／`patch`），
  衝突的幾段手動對齊；測試同樣移植（`host-config`、`relay-core`、`sql-message-store`、`worker`）。
  `wrangler-vars.test.ts`（錨點設定檢查）不移植。
- **與 ADR 0028 §7 合併後的行為**（使用者 2026-09-29 已確認 §7）：白名單判斷在檔案政策**之前**，兩道都要過——
  已認證成員在檔案車道送外層是一次性金鑰的 1060 → 收；同一個成員在主平面或非檔案車道 → 仍被「檔案事件未啟用」擋下
  （例外不越過檔案政策）；車道上沒認證（AUTH 是選擇性的）→ 白名單擋下；沒有 `FILE_LANES` 的自架站 → 成員在根路徑就能送。
  `tests/relay/worker.test.ts` 四個情境釘住，`access-control.test.ts` 既有的 §7 測試照舊通過。

### C. 一鍵部署的 `maxFileMb`：全站開關

REST／wrangler／Docker／Fly 與 `cinderous relay deploy|start --max-file-mb` 部署出來的是**自架單人中繼**（白名單、沒有車道），
不帶 `FILE_LANES`。依 Cinderous ADR-0371 §1 的表格，這時 `MAX_FILE_MB` 只是**全站開關**：≥ 1 整站收 1060，
數值中繼不強制、NIP-11 也不宣告單檔上限——客戶端因此用預設 16.5 MB（要更大就在協調器設 `relayLimits`）。
`MAX_FILE_MB` 變成「單檔上限」只發生在設了 `FILE_LANES` 的車道模式（多租戶的 Cloudflare 站；自架單人站不需要，
全站開放搭配白名單即可）。`VAULT_SYNC_MAX_FILE_MB` 維持 17；文件、命令列說明與測試寫清楚。

## DO SQLite 遷移相容

- `tests/relay/schema-compat.test.ts`：起點不是 SDK 自己建的表，而是**逐字抄下** Cinderous main 建構子跑完後的
  `sqlite_master`（把 `73756982` 的 `sql-message-store.ts` 以 esbuild 打包、對空的 node:sqlite 跑一次再 dump）。
  驗證：SDK 建構子打開它不丟例外且等冪、結構一字不差；SDK 從零建出來的 schema 與 Cinderous main 完全相同；
  Cinderous main 寫的列照常可讀、計入分桶配額與天花板；從 ADR-0371 之前（＝SDK v0.24）的 schema 升上來同樣收斂到同一份。
- `tests/relay/worker.test.ts`：一顆 storage 已由 Cinderous main 釘住（`cinder:lane-profile`、`cinder:lane-known`、
  `cinder:lane-id` ＋上述 schema ＋一顆既有的檔案塊）的 DO，由 SDK 的 `RelayRoom` 接手：連線 101（不是 409）、
  REQ 取回舊塊、繼續收新塊且寫入 `bytes`。

## 測試

- 移植：`host-config`（+9）、`relay-core`（+2）、`sql-message-store`（+8）、`worker`（+10）。
- 新增：`schema-compat`（5）、`worker`（+6：DO 從 Cinderous 版切換 1、白名單 × 檔案車道 4、客戶端經 Worker 路由讀車道 NIP-11 1）、
  `relay-file-events`（+1：部署出的站是全站開關）、`tests/sync/vault/relay-limits.test.ts`（20）：
  30 MB＝656 塊且每道收端防線收得下、64 MiB 絕對上限、分流門檻、NIP-11 路徑與 `retention` 解析、多座合成（最嚴、未知、
  不收檔案的不參與、保存期）、`loadRelayFileLimits` 容錯、安全速率；協調器 20 MB 依宣告走中繼／預設走 P2P、`setRelayLimits`；
  **P2P 打不通、300 個 200 KB 檔案（1,500 塊以上）批次補送：模擬的 FIFO 1,440 塊／7 天中繼從不淘汰、任何 7 天窗 ≤ 預算＋門檻以下的尾巴、
  超過一份保存期才送完、最後收斂**；用量跨重開保留；分頁（以 SDK 自己的 `RelayCore` 設小預算、不回報截斷：300 顆全拿到、
  同一秒跨頁不漏、`since` 與 `maxPages`）；`NostrVaultTransport` 訂閱只拿到部分訊框時補拉讓 1 MiB 訊息完整重組（沒有 `query` 時重組不起來）。
- 調整：`hydrator.test.ts` 兩處改為數「第一頁」（每次增量拉取多一個確認沒有更舊的空頁）；`p2p.test.ts` 的「小檔標成大檔」仍被拒。
- 合計新增 61 個測試；全套 93 個檔案、1,280 個測試通過。

## 實測

- 打包（esbuild 壓縮）：主入口 156,341 B（gzip 56,678 B）——**不變**；`./sync` 82.5 → 83.5 KB；`./sync/vault` 143.1 → 147.9 KB；
  `./relay` 62.1 → 64.9 KB；`./transfer`、`./pairing` 不變。

## 自我審查（漏收、配額擠掉、遷移相容）

- **漏收**
  - 截斷不回報：每次都翻到空頁才停，不依賴「數量／位元組接近預算」的猜測。撞到 `maxPages` 回 `complete: false`，
    水化器與補拉都**不前進**起點（前進了，下次的 `since` 會把沒拿到的永遠跳過）。
  - 多座中繼內容不一致、又各自被截斷時，`pool.query` 合併後以最舊時間往回翻，可能跳過較新那座被截斷的部分（沒有逐座的歸屬資訊，
    而加在 `RelayPool` 會讓主入口變大）。錨點兩座收到的是同一批發布，實務上一致；不一致時協調器的摘要／索取會補回。列為殘餘風險。
  - `pool.query` 逾時回傳部分結果：中繼由新到舊送，部分結果是連續的前段，下一頁從那裡接著翻；整頁逾時拿到 0 則會被當成「翻完了」——
    與 v0.24 相同的既有行為（常駐訂閱仍在），未處理。
  - 收端上限放寬到 64 MiB 後，重組記憶體仍受 `MAX_ASSEMBLY_BYTES`（64 MB，正在重組的那一則不算）約束。
- **配額擠掉**
  - 預算只約束**這台裝置**；同一位收件人有多台寄件裝置同時大量補送時可能合計超過配額（安全係數 0.75 留的餘裕是為此）。
  - **即時模式不等**（待送 < 10 則、使用者當下的變更）：一次丟進幾個 30 MB 的檔案（未達批次門檻）仍會立刻全部送出，
    可能超過 1,440 塊——與 v0.24 相同。用量照樣記帳，之後的批次補送會讓出；被擠掉的塊由摘要／索取重送。列為殘餘風險。
  - 中繼即使收件人已經領過也不刪（NIP-40 到期才刪），所以用量以「送出後一段保存期」計，不以「對方收到」提前釋放。
- **遷移相容**：schema 逐字相同（測試）；KV 鍵名相同；`DROP INDEX IF EXISTS`、`ADD COLUMN` 的等冪都在測試裡跑兩次。
  ADR-0371〈後續 4〉的 DO SQLite 綁定參數 100 個上限是兩邊共同的既有問題，本 ADR 不處理（**已於 v0.27 處理：[ADR 0032](0032-do-sql-bindings-and-ws-attachment-limits.md)**；遷移路徑也已在 `wrangler dev` 上實測）；PR #9 部署前仍建議以
  `wrangler dev` 對 DO 建構子的遷移路徑做一次真實冒煙測試（部分索引、`DROP INDEX`、`rowid` 在 node:sqlite 與 DO SQLite 之間可能有差異）。
- **向下相容**：`checkRelayAcceptsFiles`、`classifyPayload`、`FILE_TIER_MAX_BYTES`、`relayBulkPerHour`、`FastHydrator` 的呼叫方式都不變；
  預設門檻不變，所以不設 `relayLimits` 的外掛與舊版裝置互通如舊。行為改變的只有：批次補送多了塊數預算（預設保守值 848 塊／7 天，
  比 v0.24 的「20 則／小時」嚴）、水化與傳輸層多了分頁的 REQ、收端接受更大的內容。

## Consequences

- ＋ CinderSync／Cinder Coffice 在錨點的檔案車道上可以經中繼送 30 MB 的檔案；批次補送不再把收件人還沒領的塊擠掉；
  離線回來的積壓不論多少都拿得齊。
- ＋ SDK 中繼具備 Cinderous main 的 `FILE_LANES` 全套行為與儲存層修正，PR #9 合併不會把 ADR-0371 撤銷；
  同一顆 DO 從 Cinderous 版切到 SDK 版有測試守著。
- － 外掛要自己呼叫 `loadRelayFileLimits` 並 `setRelayLimits`，而且只能在 Vault 的每一台都升到 v0.25 之後調高門檻。
- － 沒有宣告的中繼上，批次補送比 v0.24 慢（保守預設）；每次拉取多一個 REQ。
- ⚠ 已部署的 SDK 中繼要重新部署才有儲存層與查詢預算的修正；首次喚醒會建索引、回填 `bytes`（讀過一次整張離線表）。
