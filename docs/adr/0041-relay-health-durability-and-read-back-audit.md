# 0041. 每座中繼的健康狀態、耐久度要求與備援、讀回稽核、NIP-65／17 中繼清單（ADR 0038 P1）

- 狀態：**已接受（Accepted）**——2026-09-30，實作 ADR 0038 P1（客戶端）與決策 6、7（v0.33.0）；v0.34.0 的中繼端 `warning: borrowed:`／`near-full:`／`dropped:` 與健康狀態的軟標記見 ADR 0042；v0.35.1 讀到 NIP-11 後重新驗證「不適用」見 ADR 0044
- 加註（2026-10-01，ADR 0045）：`AuditReport.verified`（至少一座回完的目標）；`OwnEventAuditor` 只把 `verified` 往後排，一個都沒查到時不佔速率限制。`watchRelayFileLimits` 的回傳值多了 `refresh()`（仍可直接呼叫＝停止）。
- 日期：2026-09-30
- 相關：本 repo ADR 0005（一次性查詢）、0027（拒收分類成明確狀態、長退避）、0029（`loadRelayFileLimits` 取最小值）、
  0031（延遲連線、不共用連線）、0032／0035（補訂閱）、**0038**（容量故障分類與 P0／P1／P2）、0039（溢位帶 `warning: borrowed:`，提議中）、**0040**（詞元表）

## Context

ADR 0038 P0（v0.31.1、v0.32.0）讓客戶端拿得到結構化的拒收原因與部分拒收，但成功判定仍是「至少一座收下」，
而且知道了原因之後什麼都沒做：同一座滿了，下一則照樣往那裡送；所有中繼都滿了，應用只能自己想辦法；
寫入成功之後才被淘汰的（天花板淘汰、FIFO）完全看不到。P1 要補的是：

1. 依拒收分類記住每座中繼的狀態；
2. 讓應用宣告「要幾座耐久收下」，不夠時改用備援（只在應用提供備援清單時，決策 6）；
3. 讀回稽核，發現「寫入後才遺失」；
4. NIP-65（10002）與 NIP-17（10050）中繼清單的讀寫工具，由應用決定要不要發布（決策 7）；
5. 接進私訊、Vault、名單同步；**預設行為與 v0.32 完全相同**。

## 決策

### 1. 每座中繼的健康狀態（`src/relay-health.ts`，連線池內部）

不是分數，是依 ADR 0040 的分類記下「這一座對哪一類資料、到什麼時候不能用」：

| 分類 | 標記 | 範圍 | 多久（`healthCooldowns`） |
|---|---|---|---|
| `ceiling`／`quota` | `full` | 那一類資料：`offline`（一般 kind，含 1059／1060）、`addressable`、`replaceable`、`ephemeral`——中繼上是不同的天花板 | `fullMs`，預設 1 小時 |
| `policy`／`restricted`（`OK false`） | `inapplicable` | 那個 kind（`kind:1060`）——檔案事件未啟用不該連私訊一起擋 | `inapplicableMs`，預設 24 小時 |
| `too-large` | `inapplicable` | 那個 kind、**至少那麼大**的事件（`minBytes`）；小的照送 | 同上 |
| `rate-limited` | `backoff` | 整座 | 到計數窗結束：`ip` 詞元 1 秒，其他 `rateLimitedMs` 預設 60 秒 |
| 關閉碼 1008 `rate-limited`／`too-many-connections` | `backoff` | 整座 | `rateLimitedMs` |
| 關閉碼 4003、1008 其他（車道被拒） | `inapplicable` | 整座 | `inapplicableMs` |
| `invalid`、`stale`、`pow`、`error`、`timeout`、`disconnected`、`auth-failed:`（AUTH 事件本身被拒，多半是時鐘或挑戰） | 不標記，只記 `lastRejection` | — | — |

- `invalid` 是自己的錯：換哪座都一樣，所以不標記、不改用、不重試（ADR 0038 研究結果四 §2）。
- 任何一次收下（含 `duplicate`）清掉那一類的 `full`、那個 kind 的政策標記與整座的 `backoff`（「任何一座收下就恢復」）；
  `too-large` 不因小事件收下而清；**借用收下不清 `full`**（它本來就在天花板上）。
- 查詢：`pool.relayHealth()`（主要中繼與用過的備援，含連線狀態、有效標記、最近一次拒收／收下／借用）；
  訂閱：`pool.onRelayHealthChange(listener)`，只在標記出現、清掉、狀態改變、備援連上或斷線時通知——同一個標記只是延長**不通知**，
  所以「全部都滿」時每座只報一次。過期的標記是惰性清除（查詢時不列出），不另外通知。
- `pool.resetRelayHealth(url?)`：站方改了設定、重新讀過 NIP-11 之後由應用呼叫。
  > **加註（2026-10-01，ADR 0044）**：v0.35.1 起改用 `pool.revalidateRelay(url, nip11)`——只清文件看得出已不成立的「不適用」
  >（`files-disabled` 而現在 `cinder_accepts_files: true` 等）；`resetRelayHealth(url, { scope, state })` 可以只清一部分；
  > `watchRelayFileLimits` 預設每 30 分鐘重讀 NIP-11 並重新驗證。24 小時保留為「沒有重讀時」的上限。
- **只記錄、不改變預設行為**：v0.32 的 `publish(event)` 照舊送給每一座開著的中繼。只有帶 `durability` 的發布會略過被標記的中繼。
  因此預設路徑上的收下會自然清掉標記（中繼恢復了就看得到）。
- **不持久化**：冷卻最長一天，中繼的狀態會自己變；重新啟動後頂多每座多挨一次拒收就重新學會。
  持久化反而有害：重啟後拿著過期的「已滿」繼續略過一座早已恢復的中繼。快照是純資料，要記錄或顯示的應用可以自己存。

### 2. 耐久度要求：`publish(event, { durability: { minAccepted, standby } })`

- `minAccepted` 預設 1（決策 6）。**耐久收下**＝`OK true`（不帶 `warning: borrowed:`）或 `duplicate`。
- 流程：
  1. 主要中繼中被標記的**略過**（`skipped`，不送、不算拒收），其餘開著的同時送出（與 v0.32 相同）。
  2. 耐久收下數 < `minAccepted`，而且沒有任何一座回 `invalid`／`stale`（自己的錯、換座沒用）時，
     依序取 `standby` 的下一座：被標記的略過；否則**延遲連上**（ADR 0031 的做法），只把**這一則**送過去，
     夠了就停；連不上就換下一座（`not-connected`）。
  3. 沒給 `standby` 就不連任何新的中繼（決策 6）。
- 備援連線：不在 `urls` 裡、不經 `onStatusChange`／`status()`（應用的「在線」判斷只看主要中繼）、**不收常駐訂閱**、
  斷線不自動重連、閒置 `standbyIdleMs`（預設 60 秒）後斷線。應用要讓備援也收訂閱（例如讀的人也要從那裡讀）時設 `standbySubscribe: true`，
  那時它收常駐訂閱、不閒置斷線。`relayHealth()` 列出備援（`standby: true`）。
- 結果：`PublishResult.durability = { minAccepted, durable, satisfied, standbyUsed, relaysFull, relays[] }`，
  `relays[]` 是每一座的 `outcome`（`accepted`／`duplicate`／`borrowed`／`rejected`／`timeout`／`skipped`／`not-connected`）、分類、原因、`until`。
  備援的收下／拒收也併進 `accepted`／`rejected`；被略過的**不**放進 `rejected`（不會經 `onPublishRejected` 反覆回報同一個已知狀態）。
- **所有中繼都滿**：`relaysFull`＝沒滿足，而且其餘每一座（不算沒連上的）都是 `ceiling`／`quota`（拒收或因此被略過）或只借用。
  連線池本身不重試（一次發布就是一次）；在冷卻期內再發布，被標記的中繼全部略過、**一則都不送**，所以呼叫端的重試迴圈不會變成對中繼的風暴。
  每類資料的重試預算不因中繼數量放大：冷卻結束才會再各試一次。Vault 協調器把它轉成一次性的狀態（見 §6）。
- `warning: borrowed:`（ADR 0039，中繼尚未實作）：`classifyRelayMessage` 多一類 `borrowed`（`RELAY_WARNING_TOKENS.borrowed`，與拒收詞元分開，
  中繼沒送出前不進契約測試），`parseBorrowedWarning()` 取出保存秒數。`PublishResult.borrowed` 列出借用收下的中繼（**只有借用時才有這個欄位**）；
  借用照舊算進 `accepted`（v0.32 相容），但不計入 `minAccepted`，所以會觸發備援。

### 3. `queryEach`：逐座查詢

`pool.query` 把各座合起來，看不出哪一座少了。`pool.queryEach(filters, { timeoutMs, relays })` 回每一座的 `{ url, status, reason?, events }`：
`eose`＝完整回完，`closed`／`timeout`／`disconnected`／`not-connected`＝不知道。還沒開的主要中繼等到開（同一個逾時內）；
`relays` 裡不在 `urls` 的當備援延遲連上、查完閒置斷線。逐座驗簽：別座驗過的 id 不能替這一座作證。
與 `query` 共用同一條內部路徑（`#runQuery`），`query` 的行為不變。

### 4. 讀回稽核（`@cinderous/client/durability`）

- `auditOwnEvents(pool, targets, { self, relays?, sample?, batchSize?, timeoutMs?, markEvicted? })`：
  - 目標：`{ type: 'addressable', kind, pubkey, d, id?, createdAt?, updatedAt? }`（同一 (kind, pubkey) 的 `#d` 合併成一個 filter），
    `{ type: 'event', id, author? }`（`{ids, authors:[自己]}`），`{ type: 'event', id, recipient: 自己 }`（`{ids, #p:[自己]}`，收件匣）。
  - 回報 `missing`（目標 → **完整回了 EOSE 而且沒有**的中繼）、`outdated`（可尋址：那一座只剩比 `createdAt` 舊的版本）、
    `inconclusive`（逾時、被 CLOSED、斷線的中繼——不算遺失）、`unauditable`、`deferred`（抽樣沒輪到的數量）。
  - 抽樣：最久沒更新（`updatedAt` 最小）的優先——它們最先被「最快到期優先」淘汰；分批（預設每批 64 個目標，每批每座一個 REQ）。
  - 發現遺失時預設呼叫 `pool.markEvicted(url, kind)`：把那一座那一類標成已滿（ADR 0038 M4「發現遺失之後」），之後帶 `durability` 的發布會略過它、改用備援。
    補寫由應用做（它有事件本體）：`pool.publish(event, { durability })`。
- `OwnEventAuditor`：有速率限制（`minIntervalMs`，預設 10 分鐘；太快的 `run()` 回 `{ skipped: 'rate-limited', nextRunAt }`）、
  會輪流（剛查過的目標在 `recheckAfterMs`，預設 6 小時內往後排）、同時只跑一輪。
- 什麼時候跑由應用決定：寫完立刻查沒有用（淘汰發生在「別人之後寫入」時）；建議啟動、回到前景、每 6–24 小時。
- **限制**：
  - ❌ **寄給別人的禮物包查不到**（私訊、Vault 訊息、檔案塊）：外層作者是一次性金鑰、收件人不是自己，
    既不能以 `authors` 也不能以 `#p` 查（中繼的訂閱範圍限制，ADR-0123、0366）。這種目標放進來會列在 `unauditable`，不當成遺失。
    它們只能靠收件人端到端回報：Vault 協調器的摘要／索取已有（ADR 0025、0029）；私訊沒有，需要 P2 的每收件人丟棄計數或應用層回條。
  - 查得到但**讀不到**的：`inconclusive` 的中繼不知道有沒有；REQ 被 16 MB 位元組預算截斷不會出現在這裡（`#d`／`ids` 查詢量很小）。
  - 中繼可以說謊（回一顆它其實準備刪掉的事件）；稽核只能證明「查的當下還在」。
- 放在子路徑：只用連線池的應用不必載入（子路徑 5.4 KB minified）；子路徑零 Node 內建模組、只用連線池的**型別**。

### 5. NIP-65（10002）與 NIP-17（10050）小工具（`@cinderous/client/durability`）

- `relayListTemplate(entries)`／`parseRelayList(event)`：`r` 標籤、`read`／`write` 標記（兩者皆是不帶標記）、網址正規化（`normalizeRelayUrl`，保留車道路徑）。
- `relayListWithStandby(primary, standby, { standbyRead? })`：**把備援事先列進清單**（都標 write）。事後才臨時改寫到清單外的站，別的裝置找不到（ADR 0038 研究結果四 §5）。
- `dmRelayListTemplate(urls)`／`parseDmRelayList(event)`：kind 10050 的 `relay` 標籤。
- `relayListFilter(pubkeys)`＋`latestRelayLists(events)`：查對方的清單、每人每種只留最新的；
  `dmRelaysFor(lists, { fallbackToRead? })`：私訊寄往哪裡（有 10050 用它；沒有就 `none`——NIP-17 說不該寄，要不要退回 10002 read 由應用決定）；
  `outboxRelaysFor(lists)`：讀某位作者去哪幾座（10002 write）。
- **只產出未簽章範本、不自動發布**（決策 7）：`signer.sign(template)` 之後要不要 `publish` 是應用的決定——公開了別人找得到你、也看得到你用哪幾座。

### 6. 整合

| 使用方 | 選項 | 行為 |
|---|---|---|
| `DirectMessages` | `durability` | 兩份封裝各自要滿足；`SendOutcome.durability` 是給對方那一份的結果；不足時 `ok: false`、訊息說明幾座、是否都滿 |
| `NostrVaultTransport` | `durability` | 每一顆要滿足；中繼（含備援）都滿 → 丟 `RelaysFullError`（`code: 'relays-full'`）；被略過的中繼原因是「檔案事件未啟用」時仍丟 `RelayRejectsFilesError`（ADR 0027 不因略過而失效） |
| `VaultSyncCoordinator` | — | 認得 `RelaysFullError`（或 `{ code: 'relays-full' }`）：`status().blocked = 'relays-full'`、`error` 事件只發一次、以 `retryMaxMs` 長退避、有 P2P 時改走 P2P、任何一次送出成功就恢復——與 ADR 0027 同一個模式 |
| `NostrRosterSync` | `durability` | 每位收件人那一顆要滿足，否則 `announce` 失敗 |
| `loadRelayFileLimits` | — | 行為不變（對給定清單取最小值）；文件改成「傳實際寫入的那組」：`pool.writeSet(1060)`（沒被標記的主要中繼＋連著的備援）。新增 `watchRelayFileLimits({ pool, onLimits })`：寫入集合一變（備援連上、某座被標成已滿或恢復）就重算，NIP-11 每座只讀一次 |

`meetsDurability(result, durability)` 是共用的判斷：沒有要求＝v0.32 的「至少一座收下」；有要求＝`result.durability.satisfied`，
自訂傳輸層沒回報時以「收下但不是借用的座數 ≥ `minAccepted`」自己算。`PeerNode` 的中繼訊框（信令、P2P 失敗時的後備）不接：
那是即時的 ephemeral 性質，耐久度沒有意義。

### 7. 向下相容

- `RelayTransport.publish(event, options?)`：第二個參數選用，只收一個參數的自訂傳輸層照樣符合（會忽略耐久度要求；整合端用 `meetsDurability` 自己算）。
- 沒設定 `durability` 時，私訊、Vault、名單同步**只傳一個參數**給 `publish`（呼叫形狀與 v0.32 相同，測試釘住）。
- `PublishResult` 只有在借用（`borrowed`）或帶了 `durability`（`durability`）時才多欄位；其餘情況 `toEqual({ accepted, rejected })` 照舊成立（既有 1,640 個測試未改一行）。
- `RelayRejectKind` 多一個成員 `borrowed`：對分類結果做窮舉 `switch` 的 TypeScript 使用方要加一個分支（0.x 的小版本變動）。
- `VaultSyncStatus.blocked` 多一個值 `'relays-full'`，只有傳輸層設了 `durability` 才會出現。
- `status()`／`onStatusChange` 不列備援（應用的「在線」判斷不變）。

### 8. 打包大小

主入口 minified 161.3 → 169.7 KB（+8.4 KB，+5.2%）、gzip 57.3 → 60.4 KB（+3.1 KB）：連線池 +4.7 KB、健康狀態 2.7 KB、其餘是分類與整合。
稽核與中繼清單放在子路徑 `./durability`（5.4 KB／gzip 2.3 KB），不進主入口。`./sync/vault` 149.1 → 151.2 KB（`RelaysFullError`、`watchRelayFileLimits`）、
`./pairing` 114.4 → 114.8 KB。`./sync/vault`、`./pairing` 不拉進健康狀態與連線池執行期（子路徑測試釘住）。
（量法：esbuild `bundle`＋`minify`、`platform: neutral`、Node 內建模組 external；與 ADR 0040 的數字量法不同，只比前後。）

## 使用方怎麼採用（建議）

- **CinderSync、Coffice（Vault 協調器）**：`relayUrls` 兩座以上；`durability: { minAccepted: 1, standby: [第三座] }`，
  而且**第三座也要列在其他裝置的 `relayUrls`**（或設 `standbySubscribe`）——否則補到備援的訊息別台讀不到。
  `status().blocked === 'relays-full'` 時提示「中繼空間已滿」；以 `watchRelayFileLimits` 取代固定的 `loadRelayFileLimits(relayUrls)`。
- **DocHost**：`minAccepted: 2`（中繼上是唯一副本）、自架站為主、錨點為輔；以 `relayListWithStandby` 發布 10002（備援事先列上）；
  `OwnEventAuditor` 在啟動與每 6 小時查 64 個桶，`missing` 的桶以 `durability` 重送。
- **遊戲**：牌組、房間歷史（可尋址）用稽核；大廳與信令是 ephemeral，只受限速影響——健康狀態的 `backoff` 讓退避正確，不需要 `durability`。
- **Cinderous App（私訊）**：讀對方的 10050（`relayListFilter`＋`dmRelaysFor`）當 `standby`，或另開連線池直接寄往那裡；
  顯示 `SendOutcome.durability` 的部分收下。私訊寄給別人的那份無法稽核，要等 P2 的丟棄計數。

## Consequences

- ＋ 同一座滿了不再一直往那裡寫；全部都滿時只回報一次、不風暴；有備援的應用自動補到別座。
- ＋ 寫入後才被淘汰的作者資料（可尋址、自己的收件匣）看得見，而且會引導之後的發布避開那一座。
- ＋ 中繼清單可以與 Nostr 生態互通，是否公開由應用決定。
- ＋ 預設行為與 v0.32 相同，不採用就沒有任何差別。
- － 用備援就多一條連線、多一座中繼看得到元資料（ADR 0031 的成本）；備援預設不收訂閱，讀的一方要自己也連那一座。
- － 健康狀態不持久化：重啟後第一則仍會撞一次已滿的中繼。
- － 寄給別人的禮物包仍無法由寄件端稽核（P2 的丟棄計數才補得上私訊）。
- － `borrowed` 分類先於中繼實作（ADR 0039 仍是提議）；詞元若改名，客戶端要跟著改。
