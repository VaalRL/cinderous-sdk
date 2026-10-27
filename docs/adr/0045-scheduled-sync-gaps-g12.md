# 0045. 排程同步的缺口（G12）：沒有中繼回完的查詢不推進游標、「送完了」訊號、摘要節流、名單重送、手動重讀 NIP-11（v0.36.0）

- 狀態：**已接受（Accepted）**——2026-10-01，使用者核准；實作於 v0.36.0
- 日期：2026-10-01
- 相關：本 repo ADR 0005（一次性查詢 `query`）、0011 §5（`FastHydrator`）、0025（協調器、送出佇列）、0028（摘要對帳、名單同步）、
  0029（分頁補拉 `forEachPage`、`backfill`）、0041（讀回稽核 `inconclusive`、`watchRelayFileLimits`）、0044（定期重讀 NIP-11）；
  CinderSync ADR 0018（排程同步）與其 ARCHITECTURE §5 **G12**

## Context

CinderSync 改成**排程同步**（ADR 0018）：平常不連中繼，每 1–24 小時連上一輪「先收再送」後斷線。調查 v0.35.1 時找到五個缺口，
外掛層先以最小方式繞過（`query-gate.ts`、`RoundTransport` 的摘要節流與輪詢判定、`rosterDirty`），記為 G12：

- **(a) 資料遺失**：`RelayPool.query()` 在一座都沒開時等一下就回 `[]`；查到一半全部斷線、全部逾時、全部被 `CLOSED` 也一樣回
  （部分或空的）陣列。`forEachPage` 把「一頁沒有新事件」當成「翻完了」，`NostrVaultTransport.backfill()` 就把補拉起點推到現在
  ——沒連線時觸發的那次補拉（同步服務啟動時就有一次）會讓更早的訊息**永遠補不回來**。`FastHydrator.resume()` 同樣會呼叫
  `setLastSyncAt(現在)`；`queryPaged` 回空陣列假裝查完。這不只是排程模式的問題：任何在離線、或中繼全掛時呼叫這些 API 的應用都會中招。
- **(b)** 沒有「這一輪送完了」的可等待訊號：`idle()` 不含網路送出，狀態看不到摘要與索取的送出。
- **(c)** 協調器**每次**「離線 → 在線」都送一份摘要：排程模式每一輪都重新連線，「沒有修改」的一輪也會發事件。
- **(d)** `NostrRosterSync` 名單一變就送，送不出去（沒連線）不會重試；`start()` 的宣告也一樣。
- **(e)** `watchRelayFileLimits` 只能設定固定的 `refreshMs`，沒有「現在重讀一次」。

## 決策

**預設行為除了 (a) 的修正以外不變**；(b)–(e) 都是新增的 API 或選項，各有向下相容的測試釘住舊行為。

### (a) 區分「沒有任何中繼完成查詢」與「查完但沒結果」

1. **`RelayPool.queryResult(filters, timeoutMs?)`**（新）：與 `query` 同一個 REQ、同樣的去重驗簽排序，另外回
   `{ events, answered, relays: [{ url, status, reason? }] }`。`answered`＝完整回了 EOSE 的座數；狀態沿用 `queryEach`
   的 `eose`／`closed`／`timeout`／`disconnected`／`not-connected`（不另存每座的事件，記憶體與 `query` 相同）。
   `query()` 改成 `queryResult().events`，**回傳值不變**（它沒有游標可推進；要游標的請用 `queryResult` 或下面的分頁）。
2. **完成的定義：至少一座回了 EOSE**（`answered ≥ 1`）。理由：發布的成功條件本來就是「至少一座收下」（ADR 0005／0041），
   一座都沒回完才是 G12 的情境；要求「每一座都回完」會讓一座長期掛掉的中繼把游標永遠卡住（每次都從頭翻 64 頁）。
   殘留的風險（只存在 A 座的事件、查詢時只有 B 回完）由 Vault 的摘要對帳（ADR 0028）與耐久度要求（ADR 0041）補；
   需要更嚴的應用可以自己看 `relays`。
3. **`HydratorPool.queryResult?`**（選配）：有的話 `forEachPage` 每一頁都用它；某一頁 `answered === 0` 就停下，回
   `{ events, complete: false, unanswered: true, relays }`。已經交出去的頁照樣算數（重複的事件在下一輪被去重）。
   只有 `query` 的自訂池分不出來，沿用舊行為。回完的情況回傳值與 v0.35 **完全相同**（沒有 `unanswered` 欄位，測試以 `toEqual` 釘住）。
4. **游標一律不推進**：
   - `NostrVaultTransport.backfill()`：`unanswered` 時起點不動，並以 **`RelayQueryIncompleteError`** reject（v0.35 是回 0 並推進）。
     自訂池沒有 `queryResult` 但有 `status()` 時，盡力判斷：查完時一座都沒開＝沒回完（查到一半斷線又連上的分不出來，ADR 記為已知限制）。
     新增 `VaultRelayPool.queryResult?`。
   - `FastHydrator.resume()`：不呼叫 `setLastSyncAt`，丟 `RelayQueryIncompleteError`（`start()`／回到前景本來就 `catch`）；
     拿到的頁照樣交給 `onEvents`，沒有任何事件時**不**再呼叫 `onEvents([])`（那一次呼叫的語意是「查完了」）。
   - `queryPaged()`：丟 `RelayQueryIncompleteError`（`events` 帶著已拿到的），不再回空陣列假裝查完。
   - 讀回稽核（ADR 0041）：`AuditReport` 新增 **`verified`**（至少一座回完的那一批目標）。`OwnEventAuditor` 只把 `verified`
     記成「查過了」往後排；**一個都沒查到時不佔速率限制**（連上之後可以馬上再跑）。`missing` 本來就只算回完的座，不變。
5. 全面檢查過的其他游標／水位：連線池常駐訂閱的補訂閱游標只在收到事件時前進（不受查詢影響）；`DirectMessages` 用固定回溯窗的訂閱、
   沒有持久化游標；協調器的 `lastSyncAt` 只在真的收到訊息或送出成功時更新；名單同步沒有游標。都不需要改。

### (b) `coordinator.whenSent({ timeoutMs? })`

回傳 `{ state, queue, blocked?, pausedReason? }`：

- `sent`：送出佇列清空、沒有在途的訊息（版本、摘要、索取）、排隊中的本機工作也做完；**連上時的摘要也已交給傳輸層**。
- 無法前進時立刻回報、不空等：`offline`（傳輸層離線）、`paused`（沉睡裝置）、`blocked`（中繼明確不收，帶原因；佇列留到下一輪）、`stopped`。
- 一般的送出失敗照常退避重試、繼續等；給了 `timeoutMs` 時到了回 `timeout`（計時器用協調器的 `clock`）。
- P2P 的大檔內容（`pushes`）不算：它們等對方在線，不屬於這一輪的中繼送出。
- 「收完」＝`transport.backfill()` ＋ `idle()`（已有）。外掛「連續 3 秒沒有收送」的輪詢判定可以拿掉。

實作時順手修了一個既有的競態：送摘要期間排進來的版本，因為 `#pump()` 遇到「正在 pumping」直接返回、而送完摘要後迴圈就結束，
會留在佇列裡直到下一次觸發；現在送完摘要後再看一次佇列（`continue`）。

### (c) 摘要節流：`digestPolicy`

協調器新選項：

| 選項 | 預設 | 說明 |
|---|---|---|
| `digestPolicy` | `'on-connect'` | v0.35 的行為：每次離線 → 在線都送 |
| | `'on-change'` | 上一份摘要之後**這台有新的版本要廣播**（本機修改、合併、衝突副本…；不含只補送給某一台的）才送；從沒送過、或距離上一份超過 `digestMaxIntervalMs` 也送 |
| | `'manual'` | 從不自動送 |
| `digestMinIntervalMs` | 0 | 連上時的自動摘要至少間隔多久（`on-connect`／`on-change`） |
| `digestMaxIntervalMs` | 一天 | `on-change` 的定期對帳；0＝不定期送 |

`resync()` 永遠照送。「上一份摘要的時間」與「有新版本要廣播」記在協調器的 `m` 狀態（`digestAt`、`digestDirty`），跨重開；
送摘要期間又有新版本時標記留著（世代計數）。效果：排程模式 `'on-change'` 下沒有修改的一輪**一則事件都不發**（收照樣收）。
代價與 CinderSync 的外掛層節流相同：中繼遺失又沒有通知的訊息，最晚 `digestMaxIntervalMs` 之後才由對帳補回。
不採「只看版本頭的指紋」：收到別台的修改（快轉）也會改變版本頭，沒有本機修改的一輪就會送摘要；別台送來的它們自己有，不需要這台再宣告。

### (d) 名單送不出去：記住、可重送

`NostrRosterSync`：

- **`pending`**（唯讀）：任何一次「送給全部成員」的 `announce()`（名單變動自動觸發、`start()` 的宣告）有收件人沒送到就設為 true；
  之後一次完整送達才清掉。只送給指定收件人的 `announce(recipients)` 成功不清。
- **`retryPending()`**：有待送的就重送整份名單（名單是完整快照，重送是冪等的），回傳有沒有送；同時呼叫共用一次。
- **`retryOnReconnect: true`**：連線池（有 `onStatusChange` 時，`RelayPool` 有）任何一座變回 `open` 就自動 `retryPending()`。
  **預設 false**——v0.35 行為（只記不送），應用在自己的時機呼叫 `retryPending()`。
- **`pendingStore: { load(), save(pending) }`**：標記跨重開。協調器的 `SyncStateStore` 是 Vault 協調器自己的命名空間，名單同步不碰它；
  一個布林值交給應用存（IndexedDB、`localStorage`），不要存進會被同步出去的設定檔（同 `VaultMembership` 的持久化原則）。
- 順手：`start()` 的宣告失敗不再變成未處理的 promise rejection。

### (e) `watchRelayFileLimits(...).refresh()`

回傳值改成 `RelayFileLimitsWatch`：**仍然可以直接呼叫**（＝停止，與 v0.35 相同），另有 `stop()` 與 **`refresh()`**——現在就重讀一輪
（寫入集合裡的每座＋被標成不適用的，ADR 0044 的同一套），重新驗證、重算限制，**定期重讀從這時候重新起算**；同時呼叫共用一輪，停止後什麼都不做。
排程同步的應用在每一輪開始時呼叫，`refreshMs` 可以設 0，不必另開計時器。

## 線上格式與相容

- 沒有任何線上格式改變。`m` 狀態多兩個選配欄位（`digestAt`、`digestDirty`），舊版讀到忽略、新版讀不到＝從沒送過摘要（`on-change` 會送一份）。
- (a) 的行為改變只發生在「沒有任何中繼回完」時：`backfill()`／`resume()`／`queryPaged()` 由「回成功並推進」改為「reject、不推進」。
  `RelayQueryIncompleteError`（`isRelayQueryIncompleteError`）從 `./sync` 與 `./sync/vault`（經 `forEachPage` 的模組）匯出；
  `RelayQueryOutcome`、`RelayQueryStatus` 型別從主入口匯出。

## 給 CinderSync 的整合（拿掉 G12 的暫時做法）

1. **`query-gate.ts` 整個拿掉**：傳輸層直接用 `RelayPool`（或包裝時一併轉交 `queryResult`）。沒連線時的那次補拉會 reject、起點不動；
   連上時傳輸層自己觸發的補拉回傳同一個 promise。若仍要保留包裝，`queryResult` 必須轉交，否則退回 `status()` 的盡力判斷。
2. **`RoundTransport` 的摘要節流拿掉**：協調器設 `digestPolicy: 'on-change'`（`digestMaxIntervalMs` 預設一天＝原本的定期對帳）。
   `allowNextDigest()` 改成 `coordinator.resync()`。啟動後第一份摘要：`'on-change'` 只在有修改、從沒送過或超過一天時送；
   要保留「每次啟動送一份」就在第一輪呼叫一次 `resync()`。
3. **一輪的完成判定**改成：`await transport.backfill().catch(...)` → `await coordinator.idle()` → `await coordinator.whenSent({ timeoutMs: 剩餘時間 })`，
   依 `state` 決定 done／blocked／paused／timeout。`RoundTransport.busy()`／`activity()` 與 500 ms 輪詢可以拿掉。
4. **`rosterDirty` 拿掉**：`new NostrRosterSync({ …, pendingStore, retryOnReconnect: true })`；每一輪開始時 `await roster.retryPending().catch(() => false)`
   （或靠 `retryOnReconnect`）。本機的名單變動仍會即時嘗試送，失敗就留在 `pending`。
5. **NIP-11**：`const watch = watchRelayFileLimits({ …, refreshMs: 0 })`，每一輪開始 `await watch.refresh()`；停止照舊 `watch()`。

## 已知限制

- (a) 的「至少一座回完」：只存在另一座、而那座這次沒回完的事件會被跳過（游標前進）；由摘要對帳與耐久度要求補。
- 只有 `query`、沒有 `queryResult` 的自訂池：`forEachPage` 分不出來；`NostrVaultTransport` 只能以 `status()` 盡力判斷。
- `whenSent` 的 `sent` 是「交給傳輸層」：中繼收下之後被淘汰的，由讀回稽核與摘要對帳處理（ADR 0041、0028）。

## 驗證（TDD）

- `tests/sync/query-unanswered.test.ts`：`queryResult` 的四種狀態（沒開、一座回完、查到一半全部斷線、被 CLOSED）；`forEachPage`
  第一頁沒人回／翻到一半斷線／回完無事件（`toEqual` 釘住舊形狀）／只有 `query` 的池；`queryPaged` 丟錯並帶已拿到的事件；
  `FastHydrator` 不推進、下一次同一個 `since`；`backfill` 不推進（`queryResult` 與 `status()` 兩條路）。拿掉修正時全部失敗。
- `tests/durability/audit.test.ts`：`verified`、沒查到的不往後排、不佔速率限制。
- `tests/sync/vault/scheduled-sync.test.ts`：`whenSent` 的 sent（含摘要）／offline／blocked／timeout／paused／stopped；
  `digestPolicy` 預設每次連上都送（釘住）、`on-change` 沒修改的三輪零事件但照樣收到別台的修改、有修改才送、超過一天送、跨重開、`manual`、`digestMinIntervalMs`。
- `tests/pairing/roster-pending.test.ts`：預設只記不送（釘住）、手動重送、`retryOnReconnect`、`start()` 的宣告失敗、`pendingStore` 跨重開、指定收件人不清標記。
- `tests/relay-pool-revalidate.test.ts`：`refresh()` 立刻重讀並清標記、同時呼叫只讀一輪、停止後不讀、直接呼叫仍是停止、定期重讀重新起算。
