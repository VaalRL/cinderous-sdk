# 0042. 共用 DO 的容量政策：每顆 DO 的天花板設定、保底份額、溢位帶、粗分級預警與丟棄計數（ADR 0038 P2、ADR 0039 B1）

- 狀態：**已接受（Accepted）**——2026-09-30 使用者核准；實作於 v0.34.0。~~錨點尚未部署~~（2026-10-30 更正：錨點已部署——Cinderous PR #9 於 2026-10-28 合併，兩座錨點從那天起跑的就是 SDK 的中繼）
- 日期：2026-09-30
- 相關：本 repo ADR 0019（SDK 預設值中立）、0029（schema 相容）、0032（DO SQLite 綁定上限）、0036／0037（一鍵部署參數、夾限原則）、
  **0038**（容量故障分類；決策 4 保底約每作者 2 MB、決策 5 只做粗分級預警；M8 丟棄計數）、**0039**（溢位帶；使用者採建議：+25%、2 小時、最先淘汰、
  嚴格平面可尋址不借用、超出保底的新寫入只能借用）、**0040**（詞元表）、**0041**（`warning: borrowed:` 非耐久、健康狀態）；
  Cinderous ADR-0367（淘汰制 vs 拒收制）、0371、0375、0376、**0377**（`DO_CEILINGS_MIB`、`cinder:do-name`、帳號預算守門）
- 範圍：SDK 中繼（`src/relay/*`）＋客戶端解析；這是 Cinderous 錨點移植的基準實作（SSOT），程式與句子要能逐字搬過去。

## Context

ADR 0038 P2 留下三件中繼端的事：共用 DO 的**保底份額**（把「成功後被別人擠掉」轉成看得見的拒收）、**粗分級預警**、**每收件人丟棄計數**；
ADR 0039 B1 是同一顆 DO 內的**溢位帶**（天花板之上的短期借用）。另外 Cinderous ADR-0377 已在錨點把天花板改成可設定（`DO_CEILINGS_MIB`）
並用測試守住帳號總量（免費方案 5 GB）；錨點若經 PR #9 改跑 SDK 中繼，SDK 沒有同樣的設定就會退回每顆 128/128 MiB（加總 10 GiB）。
所以這一版同時做四件事，而且所有新行為**預設關閉**（ADR 0019：SDK 預設值中立，錨點在自己的 `wrangler.toml` 打開）。

## 決策

### 1. 天花板可設定（Cinderous ADR-0377 逐字移植）

- `DO_CEILINGS_MIB = "<對象>=<離線 MiB>/<可尋址 MiB>,…"`；對象是類別 `strict`／`public`／`lane`／`file` 或單顆 DO 名（`global`、`presence`、`shard-0..f`、`app-0..7`、`app:<APP_LANES 上的 id>`）；
  單顆 → 類別 → 預設。設錯的項目（形狀、1–8192 以外、重複、DO 不存在）不生效、`console.warn`。沒設＝128/128 MiB、檔案車道離線 1 GiB（v0.33）。
- 函式與 Cinderous 同名同義：`MIB`、`ACCOUNT_STORAGE_BUDGET_BYTES`（4×10⁹）、`DoCeiling`、`CeilingClass`、`DEFAULT_DO_CEILINGS`、`DO_CEILING_MAX_MIB`、
  `doCeilings`、`ceilingClassOf`、`doCeilingFor`、`worstCaseStorage`、`CeilingRow`；`shard.ts` 的 `allDoNames`。`storeOptions` 第 5 個參數接受 `DoCeiling`（Cinderous 的簽名）或 `DoCapacity`。
- **DO 名持久化**：storage 鍵 `cinder:do-name`（與 Cinderous 同一個鍵）。第一次 fetch 記下；升級前就釘住政策的 DO 在下一次 fetch 補記並重組 store；
  休眠喚醒（沒有 fetch）從 storage 讀回。`worker.ts` 的做法與 Cinderous `relay/src/worker.ts`（22e3860c）逐段相同。
- **預算工具給部署者**：`computeCeilingBudget(vars, budgetBytes = ACCOUNT_STORAGE_BUDGET_BYTES)` → `{ rows, totalBytes, laneCostBytes, budgetBytes, withinBudget, lanesLeft, ignored }`，
  從 `./relay`、`./deploy`、`./deploy/cloudflare-api` 匯出。**溢位帶算進最壞量**（Cinderous ADR-0377〈與 SDK ADR 0039 的對應〉要求的）：會借用的那一側乘上 1 + r。
  以錨點的 `wrangler.toml` 四個變數測得 33 顆 DO、3,724,541,952 bytes（與 ADR-0377 的表逐位元相同）、還能加 4 條車道；加 `strict=25` 的溢位帶是 3740 MiB，仍在預算內。

### 2. 保底份額（ADR 0038 P2）

- `DO_GUARANTEE_KIB = "<對象>=<KiB>"`。key：可尋址＝作者；離線＝每一列的收件人，**沒有收件人的列（遊戲房間事件）以作者計**（否則整個無收件人桶只有一份保底）。
- **只在淘汰制生效**（`public`／`lane`／`file`）：拒收制本來就不刪別人的資料，保底在那裡沒有意義；設在 `strict` 的項目不生效並警告，部署端直接拒絕。
- 天花板滿了時（決策在 `src/relay/capacity.ts` 的 `decideCapacity`，兩個 store 共用，只執行不決策）：
  1. 寫的人（這一則的每一個 key）寫入後仍在保底內 → 先刪**全部借用列**，再刪**別人超出保底的部分**（最快到期優先，任何 key 都不會被刪到低於保底；`pickExcess`）。
     事先算得出騰得夠才動手，不夠就拒收、一列都不刪（避免「淘汰了還是拒收」的半套）。
  2. 寫的人超出保底 → 只能借用（第 3 節）；借不到就 `OK false "blocked: ceiling: …"`。**不擠掉任何人天花板內的資料**（使用者決策，ADR 0039 待決事項 4）。
- 沒設保底的淘汰制 DO：與 v0.33 逐位元相同（最快到期優先、一批 256 列），連查詢都相同。
- 候選上限 1024 列；每 key 用量在 SQL 版是記憶體快取（天花板滿了才建：一次掃分桶索引；FIFO 刪某人的列時只重算那一位）。
  🔴 不在大表上讀 `borrowed` 欄：它是 `ADD COLUMN` 加的、排在 json 後面，檔案塊的 json 在溢位頁上（Cinderous ADR-0371 §決策 5 的教訓），改用「分桶索引總量 − 部分索引上的借用量」。

### 3. 溢位帶（ADR 0039 B1）

- `DO_BORROW_PERCENT = "<對象>=<百分比>"`（中繼接受 1–100，一鍵部署 1–50）。借用保存 `BORROW_TTL_SECONDS` = 7200 秒：
  **中繼不能改事件的 NIP-40 `expiration`（有簽章）**，所以把儲存欄位 `expiration` 設成 `min(原本的有效到期, now + 7200)`，由既有的 prune（每小時 alarm）與查詢的到期過濾收走；
  回 `OK true "warning: borrowed: 7200: 本站空間暫時不足，這則只保存 2 小時、會最先被刪除；要長期保存請另存一份到其他中繼"`。收下了就照常扇出。
- 用量模型：天花板 C 對**正常寫入**生效（正常＋借用總量 ≤ C），C × (1 + r) 對**借用**生效。
  - 正常寫入超過 C、但正常列本身放得下 → 刪借用列（最快到期優先）直到放得下（`reclaim`：「原訂用途開始使用時，借來的資料直接被覆蓋」）。
  - **借用永遠不淘汰任何東西**：帶子滿了，新的借用不擠舊的借用，也不擠正常列，直接拒收。
  - 每個 key 在帶子裡最多借帶子的 1/16（`BORROW_KEY_SHARE`；store 選項 `borrowPerKeyBytes` 可覆寫）。
- 在哪裡生效：拒收制（嚴格平面）的**離線留言**；**嚴格平面的可尋址（30078 雲端快照、10037 名單…）不借用**（`addressableBorrows: false`，保住「活躍即永久」）；
  淘汰制要**同時有保底**才生效——沒有保底的淘汰制本來就收下每一則，帶子只會讓先來的借用被後來的正常寫入覆蓋，沒有好處（設了卻不生效，部署端拒絕）。
- 借用列不升級：同一個可尋址位址再更新時重新判斷；取代一顆正常列時若只能借用，新版本就只保存 2 小時（ADR 0039 已接受這個語意；寫的人拿到 `borrowed`，P1 的客戶端會補到備援）。
- 客戶端（ADR 0041，已實作）：`borrowed` 算即時送達、不算耐久收下；借用收下不清 `full` 標記。丟棄計數把借用到期算進去（第 5 節）。

### 4. 粗分級預警（ADR 0038 決策 5）

- `DO_NEAR_FULL_PERCENT = "<對象>=<50–99>"`。寫入後總量（正常＋借用）達那一級或 95％ 以上：`OK true "warning: near-full: <級>: 本站這一類資料的空間已用 <級>% 以上；建議另存一份到其他中繼"`。
  **只有兩級**（站方的門檻與 95），不回精確百分比；離線與可尋址各自以自己的天花板算。借用收下時只回 `borrowed`（一則 `OK` 只帶一句）。
- 客戶端：`classifyRelayMessage` 多一類 `near-full`（`retryable: false`、`tryOtherRelays: false`：收下了、耐久）；`parseNearFullWarning()`；
  `RelayHealthSnapshot.nearFull: { plane, percent, at }[]` 是**軟標記**——不是 `marks`、不影響發布與 `durability`、同一類下一次沒帶預警的收下就清掉；
  出現、改級、清掉時經 `onRelayHealthChange` 通知一次。

### 5. 丟棄計數（ADR 0038 M8）

- `DO_DROP_NOTICES = "<對象>,…"`。計入：FIFO 修剪、天花板淘汰（v0.33 路徑與保底的份額外淘汰）、借用列被收回、借用到期（prune）刪掉的**有收件人**的離線列。
  不計：一般的保存期到期（宣告過的契約）、NIP-62 清除、可尋址（作者用讀回稽核，ADR 0041）。
- 🔴 **只算「還沒送到」的**：否則每位活躍的私訊使用者每次連線都會看到「FIFO 刪了 N 則」（刪的是早就讀過的舊訊息），計數就沒有意義。
  - 水位線：收件人讀收件匣時記下當時 `offline_msgs` 的最大 rowid（記憶體版是寫入序號）；rowid 不超過水位線的列當時就在庫裡、已經送到過，之後被刪不算。
  - 線上：`RelayCore` 追蹤「誰正在讀自己的收件匣」（已認證、某個 filter 的 `#p` 含自己、不只收 ephemeral），經 `store.setInboxProbe()` 告訴 store；
    這些人的留言被刪不算（即時收到了）。訂閱結束（`CLOSE`、斷線、同 id 換成非收件匣）時 `store.markDelivered()` 推進水位線。休眠喚醒時訂閱從 attachment 還原，狀態跟著回來。
  - 殘餘：rowid 在最大列被刪後可能被重用（少算）；REQ 被 1024 列／16 MB 預算截斷時水位線照樣推進（少算）；多裝置時計數以公鑰計，一台讀了就歸零。
- 送達：收件人**讀自己的收件匣**時（上面的條件），在那個 REQ 的 EOSE 之前送
  `["NOTICE", "warning: dropped: <則數>: <since>: <until>: 本站因空間不足刪掉了 N 則寄給你、還沒送到的留言；可向你的其他裝置或寄件人索取"]`，送出即歸零。
  `since`／`until` 是被刪事件 `created_at` 的範圍（禮物包外層時間被 NIP-59 往前推過，找回時要放寬兩天）。只有數量與時間範圍——沒有寄件人、內容、事件 id。
- **為什麼是 `NOTICE`**：NIP-01 客戶端對 `NOTICE` 只記錄或顯示；自訂訊息型別有的客戶端會報錯；`CLOSED` 會結束訂閱；`EOSE` 不能帶內容；另寫一個 kind 會違反 filter 語意。
  前綴 `warning` 不是 NIP-01 的標準前綴但形狀相同（單字＋冒號），第三方客戶端當成一段說明。只給**已認證的本人**（嚴格平面的 `#p` 本來就只能是自己；沒有 AUTH 的站從不送）。
- 上限：每位收件人最多 `DROPPED_COUNT_MAX`（1,000,000）；表最多 `DROPPED_RECIPIENTS_MAX`（10,000）位收件人（超過刪最久沒更新的）；超過一個保存期（`maxTtlSeconds`）沒動的列在 prune 刪掉。
- 成本：開啟後每次讀收件匣＝1 讀＋1 寫；每次收件匣訂閱結束＝1 寫；每批被刪的列按收件人各 1 讀＋1 寫。沒開就一次都沒有（`takeDropped` 直接回 undefined）。
- 客戶端：`parseDroppedNotice()`；`RelayPoolOptions.onRelayDropped({ url, count, since, until })`（連線層級，哪一條訂閱觸發都一樣）；
  `RelayHealthSnapshot.lastDropped`；這則 `NOTICE` 不經 `onRelayProblem`、不算拒收。其他 `warning:` 開頭的 `NOTICE` 也不再算拒收。

### 6. NIP-11（只有靜態值，ADR 0038 M6）

依路徑那顆 DO 的設定（Worker 以 `routeForPath` 算出 DO 名，與 DO 實際套用的同一個 `doCapacityFor`）：
`cinder_ceiling_policy`（`"evict"`／`"reject"`，一律出現）、`cinder_ceiling_bytes: { offline, addressable }`（一律出現）、
`cinder_guarantee_bytes`（淘汰制有保底時）、`cinder_borrow_ttl_sec`／`cinder_borrow_percent`／`cinder_borrow_planes`（`["offline"]` 或 `["offline","addressable"]`，帶子實際生效時）、
`cinder_near_full_percent`（例如 `[80, 95]`）、`cinder_drop_notices: true`。即時用量不公開。

### 7. 一鍵部署（ADR 0037 原則）

`RelaySiteOptions` 新增 `doCeilings`（1–8192 MiB）、`doGuaranteeKib`（64–16384 KiB，只能是淘汰制對象）、`doBorrowPercent`（1–50，比中繼緊）、`doNearFullPercent`（50–99）、
`doDropNotices`、`storageBudgetBytes`（給了就以 `computeCeilingBudget` 檢查，超出拒絕部署）。每一項用中繼**同一個解析器**確認會生效，否則部署前丟例外；
淘汰制設了溢位帶卻沒有保底也拒絕。只有 Cloudflare 版（Node 主機沒有 DO 名與車道）。沒有給任何一項＝不寫任何變數。

### 8. Schema 遷移（DO SQLite）

```sql
ALTER TABLE offline_msgs ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0
ALTER TABLE addressable ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0
CREATE INDEX idx_offline_borrowed ON offline_msgs(recipient, pubkey, expiration, bytes, created_at) WHERE borrowed = 1
CREATE INDEX idx_addressable_borrowed ON addressable(pubkey, expiration) WHERE borrowed = 1
CREATE TABLE inbox_drops (recipient TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, since INTEGER, until INTEGER,
                          mark INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)
CREATE INDEX idx_inbox_drops_updated ON inbox_drops(updated_at)
```

- 全部 `IF NOT EXISTS`／吞掉「欄位已存在」，每次喚醒重跑冪等；`ADD COLUMN` 有預設值，SQLite 不重寫表。**不論設定開不開都遷移**（之後打開設定不必再遷移）。
- 部分索引只收借用列（平常是零列）：正常寫入不多寫任何索引項。
- 回滾：舊程式（Cinderous main、SDK v0.33）的 `INSERT` 不帶 `borrowed` ⇒ 預設 0；新表它不碰；借用列的短到期時間寫在 `expiration`，舊的 prune 照樣收走。
- 測試：`schema-compat.test.ts`（Cinderous main 22e3860c 的 schema——含 ADR-0375／0376／0377，那三個 ADR 不動 SQLite，重抄比對過——升上來收斂到 SDK 從零建的、逐字等於「Cinderous＋上面六條」）；
  `capacity-compat.test.ts` 以 **v0.33.0 原樣的 store**（`tests/fixtures/v0.33-stores.mjs`，`gen-v0.33-stores.mjs` 從 tag 打包）打開新 DB 讀寫、再升級回來。

### 9. 向下相容

- 沒設任何新變數：`capacity-compat.test.ts` 把同一串 400 則混合寫入（多收件人、無收件人、檔案塊、已過期、可尋址取代／較舊／清除、prune、NIP-62）
  分別丟給 v0.33.0 與現在的兩個 store（拒收制、淘汰制、沒有天花板 × 3 個種子），每一則的結果、每 25 則的庫存都相同，而且 `putResult` 沒有附帶欄位（`OK true` 的訊息仍是空字串）。
- `OfflineStore` 新增的都是**選用**方法（`putResult`、`takeDropped`、`markDelivered`、`setInboxProbe`）；`AddressablePutResult` 的 `ok: true` 多了選用欄位。
- `RelayRejectKind` 多一個成員 `near-full`：對它窮舉 `switch` 的 TypeScript 使用方要加一個分支（0.x 的小版本變動，同 v0.33 的 `borrowed`）。
- NIP-11 一律多兩個靜態欄位（`cinder_ceiling_policy`、`cinder_ceiling_bytes`）；其餘只有設了才出現。

## 給 Cinderous 錨點的移植清單

1. `relay/src/capacity.ts`：整檔搬（純函式、無依賴）。
2. `relay/src/message-store.ts`：`MessageStoreOptions` 的 7 個新欄位、`OfflinePutResult`、`AddressablePutResult` 的選用欄位、`OfflineStore` 的 4 個選用方法、`MessageStore` 整個類別。
3. `relay/src/sql-message-store.ts`：建構子尾端的遷移（第 8 節）、快取欄位、`putResult`／`putAddressableResult`／`placeOffline`／`placeAddressable`／`recordDrops`／`takeDropped`／`markDelivered`、
   `prune`／`vanish`／`enforceCap` 的改動、檔尾的 `EXCESS_CANDIDATES` 與 `DroppedRow`。
4. `relay/src/relay-core.ts`：`SubEntry.inbox`、`inboxSubs`、建構子的 `setInboxProbe`、`index`／`unindex(entry, delivered)`、`handleReq` 的換訂閱與 EOSE 前的 `NOTICE`、
   `admit` 的 `note`（`putResult` 優先）、檔尾的 `readsOwnInbox`／`okNote`。
5. `relay/src/reject-messages.ts`：`borrowedWarning`、`nearFullWarning`、`droppedNotice`（句子逐字）。`packages/core` 的客戶端若要解析：`RELAY_WARNING_TOKENS` 的 `near-full`／`dropped`。
6. `relay/src/host-config.ts`：已有 ADR-0377 的部分，補 `KIB`、`DO_CAPACITY_LIMITS`、`CeilingEnv` 的 4 個變數、`doCapacitySettings`、`DoCapacity`、`doCapacityFor`、`borrowingPlanes`、
   `worstCaseBytes`、`computeCeilingBudget`，`worstCaseStorage` 改成含溢位帶（`CeilingRow` 多 `capacity`），`storeOptions` 的第 5 參數改接 `DoCapacity`（`capacityStoreOptions`）。
7. `relay/src/worker.ts`：`Env` 的 4 個變數、建構子的 `doCapacitySettings(env).ignored` 警告、`buildCore` 改用 `doCapacityFor`、`relayInfoFrom` 第 5 參數 `doName`（NIP-11）。DO 名那段已相同。
8. `relay/src/nip11.ts`：`capacity` 設定與第 6 節的欄位。
9. `relay/wrangler.toml`（兩份 vars）：建議先只開 `DO_BORROW_PERCENT = "strict=25"`、`DO_NEAR_FULL_PERCENT = "strict=80,lane=80,file=80"`、`DO_DROP_NOTICES = "strict,file"`；
   `DO_GUARANTEE_KIB = "lane=2048"` 等客戶端都有 P1 再開（ADR 0038：「改成拒收」要客戶端接得住）。`wrangler-vars.test.ts` 的預算測試改用 `worstCaseStorage`（已含溢位帶）並要求 `doCapacitySettings(v).ignored` 為空。
10. 測試：`tests/relay/capacity*.test.ts`、`ceiling-budget.test.ts`、`schema-compat.test.ts`、`worker.test.ts` 的〈容量設定與 DO 名〉可以直接搬。
11. 部署前後：先記回滾點；部署後量一次 `databaseSize`；確認舊版客戶端（App v0.0.18 只看前綴）把 `OK true "warning: …"` 當成功——前綴判斷只看 `true`/`false`，不受影響。

## Consequences

- ＋ 共用 DO 裡保底內的資料不再被別人的寫入默默刪掉；滿了的後果從「別人成功後被刪」變成「超出保底的人被拒或只借到 2 小時」——看得見、客戶端（P1）接得住。
- ＋ 撞到天花板不必立刻失敗：溢位帶給尖峰 2 小時的緩衝，在線的收件人照常收到，寫的人知道只存 2 小時。
- ＋ 收件人第一次知道「有 N 則在這座中繼上、送到之前就被刪了」。
- ＋ SDK 中繼與錨點的天花板設定、DO 名、預算守門一致，PR #9 合併後不會退回 10 GiB。
- － 會對寫入者透露「這顆 DO 快滿了」的粗略分級；會對收件人透露「有幾則被刪」（本人的資料）。
- － 開啟丟棄計數後每次讀收件匣多一次寫入；保底淘汰要掃每 key 用量（只在天花板滿時）。
- － 溢位帶讓每顆 DO 的最壞儲存量乘上 1 + r（`computeCeilingBudget` 算進去了）；帳號總量閘（ADR 0039 B4）仍未做。
- － 中繼 bundle 變大（`./relay` minified 74.9 → 98.7 KB、Worker 82 → 100 KB，主要是沒有被 minify 的 SQL 字串）；主入口只多 1.2 KB（解析函式與軟標記）。
