# 0098. 中繼拿掉 `idx_offline_kind`：每則離線留言少寫一列

- 狀態：**已接受（Accepted，2026-10-19）**——使用者 2026-10-19「依你建議」（先跑查詢計畫確認沒有查詢依賴它，再拿掉）
- 日期：2026-10-19
- 對應：Cinderous ADR-0388（同一件事在 Cinderous 的中繼，DDL 逐字相同）；SDK ADR 0029／0042（schema 與 Cinderous 逐字相同）、0097（DO 額度用完時說明原因）

## Context

2026-10-19 錨點 1 的 Durable Objects 免費每日寫入額度被用光，整座中繼一整天連不上（ADR 0097）。DO SQLite 依「寫入列數」計費，每個索引都算一列。一則離線留言寫入時，表本身加上各索引大約要寫 5–6 列，刪除時也一樣。

`idx_offline_kind` 是 Cinderous ADR-0235 C2 為了把 `kinds` 下推到 SQL 而加的。後來 Cinderous ADR-0371 加了以 `recipient, kind` 開頭的分桶索引 `idx_offline_bucket`，它就少有用處了。

`RelayCore.scoped()` 只放行三種形狀的過濾條件：
- 帶 `#p`；
- 帶 `authors`；
- 第三方車道上帶任一標籤。

用 node:sqlite 對 `query()` 實際組出來的 SQL 跑 `EXPLAIN QUERY PLAN`，結果：
- **`#p`**（＋kinds＋since）：走分桶索引。有沒有 `idx_offline_kind` 都一樣。
- **`authors`**：走 pubkey 索引。
- **`authors`＋kinds**（快照、`durability/audit.ts`、`iot/client.ts`）：有 `idx_offline_kind` 時，規劃器在沒有統計資料的情況下**選了它**，同 kind 的所有列都掃一遍。拿掉後改走選擇性高得多的 pubkey 索引。
- **每收件人上限的計數與修剪**：走分桶索引（涵蓋）。
- **只有一種會變慢**：第三方車道上「標籤＋kinds、不帶 authors」，會從 kind 索引退成掃到期索引。不帶 kinds 的標籤查詢本來就是這樣掃。SDK 自己送出的標籤過濾條件全都帶 `authors`。

## Decision

1. 建構子不再建 `idx_offline_kind`，改成 `DROP INDEX IF EXISTS idx_offline_kind`。這是等冪的，每次喚醒都跑也沒有成本。
2. Cinderous 的中繼做同樣的修改（ADR-0388），兩邊從零建出來的 schema 仍逐字相同。
3. 測試（`tests/relay/schema-compat.test.ts`）：
   - 期望 schema 加上 `SDK_0098_REMOVALS`；
   - 新增〈離線留言查詢的索引〉：記下 `query()` 實際下的 SQL、看查詢計畫。`#p` 要走分桶索引；`authors`＋kinds 要走 pubkey 索引、不能是 kind 索引。

## Alternatives Considered

- **保留**：它主要的作用是讓規劃器在 `authors`＋kinds 時選錯，卻每次寫入與刪除都多寫一列。
- **把 pubkey 索引改成 `(pubkey, kind)`**：不會省下寫入列數，只是讓 `authors`＋kinds 再快一點，現在沒有需要。

## Consequences

- ＋ 每則離線留言的寫入與刪除各少一列，約省下離線留言寫入量的六分之一。
- ＋ `authors`＋kinds 查詢改走選擇性高的索引。
- － 第三方車道「標籤＋kinds、不帶 authors」的查詢改掃到期索引。這類查詢一律帶 `LIMIT` 與位元組預算，車道是各自獨立的 DO。
- － 升級後第一次喚醒要刪掉整個索引，是一次性的寫入。回滾時舊版會把它建回來，也是一次性的寫入。
- 要部署到錨點才生效（部署要使用者同意）。
