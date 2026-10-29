# 0126. 喚醒與分頁補拉只讀需要的列

- 狀態：**已接受（Accepted，2026-10-29）**——使用者 2026-10-29 選「先找出讀這麼多列的查詢」並要求實作後合併
- 日期：2026-10-29
- 對應：SDK ADR 0102、0103（同一類問題的前兩次：淘汰與保底用量）、0084（外掛啟動從頭補拉收件匣）、0029（`until` 分頁）；Cinderous ADR-0371（檔案車道、兩步選取）、ADR-0235 C2（pubkey/kind 回填）；CinderSync ADR 0101（那天「中繼弄丟的版本」）

## Context

2026-10-22 00–05 UTC，錨點 1 在 CinderSync 車道的一顆 DO 讀了 **5,349,422 列**（寫入 71,981 列、請求 12,069 次），超過免費方案每日 500 萬列的讀取上限。之後整天沒有任何讀寫：額度用完後每一條 SQL 都失敗，直到 00:00 UTC 重置。時段正好是 CinderSync 拿手機實測的那幾個小時。平均每次請求讀約 440 列。

用 miniflare（真的 workerd＋SQLite，讀 Cloudflare 計費用的 `cursor.rowsRead`）跑真的 `SqlMessageStore`，表裡約 4,600 列（兩位收件人、各約 2,300 顆檔案塊），量到三個來源：

| 操作 | 讀取列數 | 來源 |
|---|---|---|
| 建 store（每次喚醒建**兩次**：建構子一次、`buildCore` 一次） | 4,631 | pubkey/kind 回填 `WHERE pubkey IS NULL OR kind IS NULL`：`OR` 加上 `kind` 沒有索引，每次掃全表 |
| 喚醒後第一次寫入 | 6,949 | 總量快取是空的，`SUM(bytes)` 掃整個分桶索引（4,628）；加上這位收件人的桶計數（2,316） |
| 可尋址事件的**每一次**寫入 | 整張 addressable | 總量沒有快取，每次 `SUM(LENGTH(json))` |
| `#p`＋kinds 補拉一頁（16 MB 預算、LIMIT 1024） | 4,098 | 排序 `created_at, rowid` 跳過索引中間兩欄，SQLite 把整個桶讀出來排序（`USE TEMP B-TREE FOR LAST TERM OF ORDER BY`），兩步各一次 |

DO 用 hibernation，閒置幾秒就會被收走，下一則訊息進來時重建。所以實測那種「連一下、送幾塊、斷線、重連」的模式，每次喚醒都要付 2×全表＋全表＋全桶，翻頁時每頁再付 2×全桶。

## Decision

### 1. 回填只看 `pubkey`，而且先建索引

`pubkey` 與 `kind` 一直是一起寫的（這段回填與每一次 INSERT），所以只看 `pubkey IS NULL` 不會漏。先 `CREATE INDEX idx_offline_pubkey` 再 UPDATE，`IS NULL` 就走索引：沒有舊列時讀 0 列。

### 2. 資料庫大小當用量的上界

新選項 `MessageStoreOptions.sizeUpperBound?: () => number`，只有 SQL 版用。DO 宿主給 `ctx.storage.sql.databaseSize`。

- 每一列的 json 都完整存在資料庫裡，UTF-8 位元組數不小於 `JSON.stringify(...).length`，所以資料庫大小不會小於實際用量。
- 寫入時，**快取是空的**而且「上界＋這一筆 ≤ 天花板」：直接當作放得下（與 `decideCapacity` 的 `fit` 同一個結果），不 `SUM`。
- 預警同理：上界沒到預警線就不精算。
- 可尋址事件：上界證明放得下**而且**沒到預警線才走捷徑，`usedAfter` 回上界（呼叫端只拿它判預警）。
- 上界只用來**確定放得下**，從不用來拒收、淘汰或預警。證明不了（接近天花板、宿主沒給、給的不是有限非負數）就照舊精算。

### 3. 離線留言的排序照索引順序

`boundedSelect` 對 `offline_msgs` 改用 `created_at DESC, expiration DESC, bytes DESC, rowid DESC`。這正好是分桶索引 `(recipient, kind, created_at, expiration, bytes)` 加上隱含的 rowid 倒著讀，所以：

- `#p`＋單一 kind（補拉收件匣、`until` 分頁）順著索引讀，讀滿 LIMIT 就停；
- 仍然是全序（同一秒的列也排得出先後），兩步選取（ADR-0371）挑到的仍是同一批。

addressable 表不變（`created_at DESC, rowid DESC`）。

### 量測（修正後，同一張表）

| 操作 | 修正前 | 修正後 |
|---|---|---|
| 建 store | 4,631 | **4** |
| 喚醒後第一次寫入 | 6,949 | **2,321**（剩下的是桶計數） |
| 補拉一頁（16 MB） | 4,098 | **2,048**（LIMIT×2） |
| 補拉一頁（沒有預算） | 2,049 | **1,024** |

## Consequences

- 一次「喚醒＋寫一塊」從約 3 倍全表降到約一個桶。對 10-22 那種負載，讀取大約少一個數量級。
- **還剩的**：喚醒後第一次寫給某位收件人時，要數一次他的桶（`enforceCap`），代價是那個桶的大小，上限是每收件人的檔案塊數。要再省就得把桶計數存進表裡，每次寫入多寫一列；寫入額度（每日 10 萬列）比讀取（500 萬列）緊 50 倍，現在不換。
- 同一秒內的排序從「後寫的在前」變成「到期晚的在前、再來大的在前」。NIP-01 沒有規定同一秒的順序，`forEachPage` 也不依賴它。
- 只修 SQL 版。記憶體版沒有讀取計費，不變。Node 版中繼（node:sqlite）沒給上界，照舊精算。
- 修正要部署到錨點才生效；部署照慣例要使用者另外同意。
- CinderSync ADR 0101 的「中繼弄丟了刪除版本」，很可能就是那天讀取額度用完、寫入失敗。這件事記在 CinderSync 那邊。

## 測試

`tests/relay/wake-reads.test.ts`：重開 store 時沒有任何 SQL 掃整張 `offline_msgs`（部分索引除外）、升級前的列仍會回填、給了上界時離線與可尋址寫入都不 `SUM`、上界偏大或無效時照舊精算（拒收與預警結果不變）、`#p`＋kinds 分頁的查詢計畫沒有 `TEMP B-TREE`、同一秒多顆時翻頁不漏不重、兩步挑到同一批。node:sqlite 量不到列數，所以跟 ADR 0102 一樣用查詢計畫與「下了哪些 SQL」守住；列數以 miniflare 實測。
