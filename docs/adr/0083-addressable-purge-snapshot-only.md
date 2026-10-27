# 0083. 可取代事件的「空 content＝清除」只限快照：標準的 10050／10002／kind 3 不再被中繼默默刪掉

- 狀態：**已接受（Accepted，2026-10-14）**——Cinderous ADR-0382 §7；使用者 2026-10-14「合併 PR #23，先做 purge 修正」
- 日期：2026-10-14
- 對應：Cinderous ADR-0071（雲端快照的 purge）、**0382**（可選的公開聯絡方式）；ADR 0038 P0-R2（`putAddressableResult` 的拒收原因）

## Context
中繼的 `putAddressableResult`（`MessageStore` 與 `SqlMessageStore`）對**所有**可取代（kind 0／3／10000–19999）與可尋址（30000–39999）事件，
都把 `content === ""` 當成「清除舊的那顆、不存新的」。這條約定出自 Cinderous ADR-0071：關閉雲端備份時「已關閉」必須立即為真，
快照（kind 30078）就用空 content 表示「刪掉我這台的那份」。

但依規格 content 本來就是空字串的標準事件有：NIP-17 的 **10050**（私訊收件中繼）、NIP-65 的 **10002**（中繼清單）、NIP-02 的 **kind 3**（追蹤清單）。
2026-10-14 對兩座錨點實測：發布 10050 回 `OK true`，別人以 `authors` 查卻查不到——中繼說收了，實際上把它刪了。
Cinderous ADR-0382 要讓第三方 Nostr 客戶端靠 10050 找到使用者，這個行為會讓整個功能失效。

## Decision
- 新增 `isAddressablePurge(event)`＝`isAuthorOnlyKind(event.kind) && event.content === ""`（目前只有 kind 30078），兩個 store 共用。
- 其他 kind 的空 content 是普通內容：照常取代、保存、回 `OK true`、查得到。
- 要撤回其他 kind，用 NIP-09 刪除請求，或發一顆較新的取代（例如清空標籤的 10050）。

## Alternatives Considered
- **列出「空 content 是普通內容」的 kind 白名單**（10050、10002、3）：之後每個新標準都要記得加；反過來列「哪些是 purge」只有快照一個，範圍最小。
- **改用標籤表示清除**（例如 `["purge"]`）：要同時改所有發布快照的客戶端；而快照之外沒有人用這條約定，限縮 kind 就夠了。

## Consequences
- ＋ 標準的 10050／10002／kind 3 存得進、查得到；中繼不再對它們回不實的 `OK true`。
- ＋ 快照的 purge 行為不變（Cinderous 只有 `purgeCloudSnapshot` 用到）。
- － 若有客戶端曾依賴「對非快照 kind 發空 content 來刪除」：之後會變成存一顆空的。Cinderous 與本 SDK 的程式碼都沒有這種用法。
- `tests/relay/capacity-compat.test.ts` 與移植前 store 逐則比對時，空 content 只產生給快照：其他 kind 的差異是這裡的刻意改變，不屬於那份測試要比對的容量政策。
- 驗證：`tests/relay/message-store.test.ts`、`tests/relay/sql-message-store.test.ts`、`tests/relay/relay-core.test.ts`〈purge 只限快照〉。
