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
- － 撞埠是推論；若這個測試在 CI 上仍然失敗，原因在別處，要再查。

## 後續（未做）

- 其他用隨機埠開中繼的測試檔改用 `PORT=0`＋`ready`：`call-relay`、`dm-reconnect`、`bridge-e2e`、`relay-move`、`peer-relay`、`iot-node`、`lanes-only-node`、`node-connections`、`node-host`、`traffic-budget`、`inbox-ack.e2e`。`startDevRelay` 也要有 `ready`。

## 驗證

- `tests/relay/node-host.test.ts`：`PORT=0` 時 `ready` 給出可連線的埠；埠被佔用時 `ready` 以 `EADDRINUSE` 失敗（先失敗，實作後通過）。
- `tests/relay/node-capacity.test.ts` 全過；`npm run check`；公開 repo 的 CI。
