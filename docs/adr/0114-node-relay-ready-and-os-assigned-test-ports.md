# 0114. `startNodeRelay` 回傳 `ready`；測試改由系統分配埠

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28 同意修公開 repo CI 反覆失敗的測試（「ok」）
- 日期：2026-10-28（v0.77.3）
- 對應：SDK ADR 0099（Node 版的空間上限）、0110（公開 repo 的 CI）

## Context

公開 repo 的 CI 最近四次失敗三次，都是 `tests/relay/node-capacity.test.ts` 的「reject（預設）：滿了回 blocked: ceiling」：第 6 則約 200 KB 的留言應該被 1 MiB 的天花板擋下，CI 上卻是 6 則全收。本機（Windows）幾乎都過，只在全套負載下失敗過一次（ADR 0110 的驗證段）。

- 容量的計算是確定性的（同樣的輸入，第 6 則一定 `ceiling`），所以收下 6 則的很可能不是這個測試開的那座中繼。
- 測試用 `40_000 + 隨機 2000` 選埠。另外三個測試檔（`iot-node`、`lanes-only-node`、`peer-relay`）也在同一段，其他測試檔在相鄰的段；Linux 的臨時埠（32768–60999）涵蓋這幾段，Windows 的（49152 以上）不涵蓋，與「CI 常壞、本機幾乎不壞」相符。
- 測試開站後固定等 100 ms 就連線，不知道站到底開了沒有，也拿不到實際的埠。`startNodeRelay` 監聽失敗時沒有任何回報管道。
- CI 日誌裡看不到 `EADDRINUSE`，所以撞埠的確切路徑沒有證實。

## Decision

1. **`startNodeRelay` 回傳 `NodeRelayHandle`**：`close()` 之外多一個 `ready: Promise<number>`——開始監聽後給出實際的埠（`PORT=0` 時由系統分配），監聽失敗（例如 `EADDRINUSE`）就 reject。啟動訊息印實際的埠。
   - 純新增，既有的呼叫端不用改。沒人等 `ready` 而監聽失敗時，是未處理的 rejection，與之前「沒人接的 `error` 事件」一樣讓程序結束。
2. **`node-capacity` 的三個開站測試改成 `PORT: '0'` 並 `await ready`**，不再挑隨機埠、不再固定等 100 ms。

## Consequences

- ＋ 這個測試不可能再連到別的測試的中繼；也不必猜站開了沒有。
- ＋ 用 SDK 開 Node 中繼的人可以用 `PORT=0` 並知道實際的埠，也接得到監聽失敗。
- － 其他 11 個測試檔仍用固定範圍的隨機埠（見〈後續〉）。
- － 撞埠是推論；若這個測試在 CI 上仍然失敗，原因在別處，要再查。（後來確實在別處，見〈補充：`node-capacity` 的真正原因〉）

## 補充：其他測試檔也改（2026-10-28，v0.77.4）

v0.77.3 的公開 CI：`node-capacity` 過了，換 `call-relay` 失敗，日誌直接是 `listen EADDRINUSE: address already in use :::43560`——撞埠在 CI 上確實會發生（Context 的推論得到證實）。所以〈後續〉當天就做：

- `startDevRelay` 也回傳 `NodeRelayHandle`（`ready` 的語意相同）。
- 新增 `tests/node-relay-harness.ts` 的 `opened(handles, relay)`：登記關站、回傳實際的埠。
- 11 個測試檔全部改成 `PORT: '0'`＋`await ready`，拿掉開站後固定等 100 ms；`relay-move` 第一次由系統分配，重新部署沿用同一個埠。用埠號當暫存檔名的兩處改用 `process.pid`＋時間。
- 現在 `tests/` 裡沒有任何固定範圍的隨機埠。

## 補充：`node-capacity` 的真正原因（2026-10-28，v0.77.6）

改用系統分配埠之後，v0.77.5 的公開 CI 上 `node-capacity` 的「reject（預設）」**仍然失敗**——所以 Context 對這個測試的推論（連到別的測試的中繼）是錯的。本機單獨連跑約 1/15 會重現；印出 OK 之後看到：

- 測試的 `bigNote` 每則各取一次現在時間、`created_at = now - n`。六則剛好跨過秒的邊界時，有兩則的 `created_at` 相同；內容、作者、收件人也相同 ⇒ **同一個事件 id**。
- 中繼對重複的事件回 `OK true "duplicate: …"`，只存了五則，第六則放得下就收了。中繼的行為是對的。

修正：六則從同一個 `now` 往回推（`bigNotes`）。`tests/` 裡沒有其他同樣寫法的地方。`call-relay` 的 `EADDRINUSE` 是真的撞埠，前面的改動仍然需要。

## 後續（未做）

- ~~其他用隨機埠開中繼的測試檔改用 `PORT=0`＋`ready`；`startDevRelay` 也要有 `ready`。~~（v0.77.4 已做）

## 驗證

- `tests/relay/node-host.test.ts`：`PORT=0` 時 `ready` 給出可連線的埠；埠被佔用時 `ready` 以 `EADDRINUSE` 失敗（先失敗，實作後通過）。
- `tests/relay/node-capacity.test.ts` 全過；`npm run check`；公開 repo 的 CI。
