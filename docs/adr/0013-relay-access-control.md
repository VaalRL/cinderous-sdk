# 0013. 中繼存取控制：白名單外斷線 4003、每把公鑰的連線數、每個 IP 的訊息速率

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0008（`ALLOWED_PUBKEYS`）；PRD 3.3；Cinderous ADR-0044（企業封閉模式）、ADR-0366（每連線訊息上限）

## Context

PRD 3.3 對中繼有三條要求，ADR 0008 只做了白名單的寫入檢查：

1. 不在白名單上的人，**認證後立刻斷線**（WebSocket 4003），不讓機器人佔著連線吃記憶體。
2. 單一 IP 每秒最多 20 則訊息。
3. 單一公鑰的同時連線數最多 5 條。

現有的防護只有每條連線每分鐘 240 則（ADR-0366）。換一條連線、或同一個 IP 開很多條連線，就繞得過。

## Decision

三條都做在 `RelayCore`，兩個宿主（Worker、Node）照同一套規則。

| 規則 | 觸發 | 結果 |
|---|---|---|
| 白名單外 | 設了 `ALLOWED_PUBKEYS`，認證成功但不在名單上 | `OK false "restricted: …"`，以 **4003** 關閉 |
| 連線數 | 同一把公鑰已有 N 條已認證連線，第 N+1 條來認證 | 認證被拒，以 1008 `too-many-connections` 關閉；舊的斷掉就能再連 |
| IP 速率 | 同一個 IP 的所有連線合計，這一秒超過 N 則 | 關閉送出那則的連線（1008 `rate-limited`） |

實作上的細節：

- `Outbound.close` 從只能是 `true` 擴充為可帶 `{ code, reason }`。`true` 仍等於原本的 `1008 rate-limited`，舊行為不變。
- **IP 從哪裡來**：
  - Worker 用 `CF-Connecting-IP`，這是 Cloudflare 填的，客戶端偽造不了。
  - Node 預設用 socket 的來源位址。設 `TRUST_PROXY=1` 才信 `X-Forwarded-For`，因為直連時那個標頭任何人都能偽造。
  - 宿主沒給 IP 的連線（本機測試、內嵌中繼）不受 IP 速率限制。
- IP 對應會存進 DO 休眠快照，喚醒後照樣計算。
- **預設值**：
  - 函式庫與兩個宿主預設**不限**。Cinderous 錨點不設，因為一個人好幾台裝置可能連到同一片，5 條很容易撞到。
  - SDK 自己的工具預設套 PRD 的 5 與 20：`cinderous relay start` 帶進環境變數，`cinderous relay deploy` 寫進 wrangler 的 `[vars]`。
  - 環境變數 `MAX_CONNECTIONS_PER_PUBKEY`、`MAX_MESSAGES_PER_SECOND_PER_IP` 可以覆寫。

## Consequences

- ＋ 白名單站不再讓外人連著不走；同一個 IP 開多條連線也繞不過速率限制。
- ＋ Cinderous 錨點行為完全不變（三條都沒設）。
- － 在 Worker 上，連線數與 IP 速率是**每顆 DO 各自計算**。同一個人連到不同分片不合併計數，這是分片架構的代價；要全域計數得用 Cloudflare 的 rate limit binding，這次不做。
- － 白名單站上，外人連「讀」都不行了（原本只擋寫入）。這符合 PRD 與 Cinderous ADR-0044「外部客戶不進系統」的本意。在 v0.6 之前兩個宿主都還無法設定白名單，所以沒有既有部署受影響。
