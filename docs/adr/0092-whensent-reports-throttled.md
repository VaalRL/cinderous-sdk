# 0092. `whenSent` 多回報 `throttled`：剩下的都在等中繼補送的限速時不讓呼叫端空等

- 狀態：**已接受（Accepted，2026-10-16）**——使用者 2026-10-16「查」
- 日期：2026-10-16
- 對應：ADR 0026（批次模式、中繼限速補送）、0029／0068（塊數預算）、0045（`whenSent`）、0091（按收件人限速）；CinderSync ADR 0086

## Context
2026-10-16 實測：桌機 A 的佇列有 151 筆要給離線的手機（批次模式），按「立即同步」時那一輪跑了約 4 分鐘才以 `timeout` 結束，
狀態列一直是「同步中…」。原因：剩下的那些都在等經中繼補送的每小時限速（或塊數預算），`whenSent` 卻沒有對應的狀態——
既不是 `sent`、也不是 `blocked`——應用只能靠自己的「多久沒進展」計時（CinderSync 的 `BULK_STALL_MS` 兩段共 4 分鐘）才收工。

## Decision
- `#buildNext` 因限速或配額而暫停（排了重試計時器）時記下下一次的時間 `#throttledUntil`；每次重新排都先清掉。
- `whenSent` 在「沒有在忙（排隊、送出中、摘要、在途）、也沒有直連正在試（`#p2pRunning`）、而且剩下的都在等限速」時回報
  `{ state: 'throttled', queue, retryAt }`。直連在試時照舊等（那可能真的在前進）。
- `VaultSentResult.state` 多一個值、多一個欄位 `retryAt`。

## Alternatives Considered
- **應用把停滯判定縮短**：仍是猜；而且直連在送時需要長一點的耐心，兩者無法用同一個時間兼顧。
- **併進 `blocked`**：`blocked` 是「中繼明確不收」，要換中繼或等站方；限速是「等一下就會送」，提示與處理都不同。

## Consequences
- ＋ 只剩給離線裝置的積壓時，一輪同步在幾秒內結束（沒送的留到下一輪或直連）。
- － 新的狀態值：只認得舊值的呼叫端會把它當成未知狀態（CinderSync 同版處理）。
- 驗證：`tests/sync/vault/scheduled-sync.test.ts`〈剩下的都在等中繼補送的限速 → throttled〉〈沒有限速時照舊是 sent〉；全套 209 檔 2,997 項。
