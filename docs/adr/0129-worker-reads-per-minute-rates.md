# 0129. Worker 讀每分鐘速率

- 狀態：**已接受（Accepted，2026-10-30）**——使用者 2026-10-30：「讓 Worker 讀每分鐘速率的環境變數，順便更新 ADR 0042 過時的狀態」
- 日期：2026-10-30
- 對應：ADR 0037（一鍵部署參數：〈後續〉「Worker 讀 `MAX_EVENTS_PER_MINUTE`／`MAX_MESSAGES_PER_MINUTE`（只允許調高到某個上限、不允許關閉），與 Node 主機一致」）、0043（客戶端照 `cinder_max_events_per_minute` 的八成發）；Cinderous ADR-0235 H1、ADR-0366 §容量

## Context

兩條每分鐘速率：

- 每把公鑰每分鐘事件（`maxEventsPerMinute`，預設 120）；
- 每條連線每分鐘訊息（`maxMessagesPerMinute`，預設 240）。

Node 版會讀 `MAX_EVENTS_PER_MINUTE`／`MAX_MESSAGES_PER_MINUTE`，設 0 可以關掉。Worker 一律用預設值，在 `wrangler.toml` 設了也沒有作用。

另外，兩座宿主的 NIP-11 都把 `cinder_max_events_per_minute` 寫死成 120。Node 版調過或關掉之後，NIP-11 照樣說 120。客戶端照這個數字的八成發（ADR 0043）：站方調高了，客戶端還是發得慢；站方關掉了，文件還在說有上限。

## Decision

1. **Worker 讀這兩個變數**，照 ADR 0037 的規則（`workerRateLimitsFrom`）：
   - 只能調高：0、負數、低於預設、壞值一律當沒設。不能關掉，也不往下調。
   - 有上限：事件最多 600、訊息最多 1200（事件上限的兩倍）。超過就夾到上限。
   - 訊息上限不低於事件上限的兩倍（與 Node 版的 `messagesPerMinuteFrom` 同一條不變量）。
   - 車道與嚴格平面套同一組值。
2. **NIP-11 宣告實際套用的值**：兩座宿主都把生效的事件上限傳給 `buildRelayInfo`。Node 版設 0 關掉時，文件不出現這一欄。
3. **一鍵部署表單維持不開放**（ADR 0037 的表）。要調的人在 `wrangler.toml` 的 `[vars]` 或 Cloudflare 後台設。

## 理由

- **為什麼只能調高**：Cloudflare 以進站訊息計費（WebSocket 訊息 20 則算一次請求），這兩條是每條連線的成本界線。關掉等於把帳單交給任何一個連線；往下調會讓沒讀 NIP-11 的客戶端（預設照 100 則／分鐘發）撞到限速。
- **為什麼上限是 600／1200**：每秒 10 則事件已經是即時協作的量級。再往上，單一連線一天就能吃掉免費方案相當大的一部分請求額度，這時該做的是另外部署付費方案，不是調這個數字。
- **為什麼 Node 版不比照夾限**：自架主機沒有按則計費，關掉限速是站方自己的取捨（ADR 0037 表格已註明一鍵部署不提供這條路）。

## Consequences

- Worker 上設了 `MAX_EVENTS_PER_MINUTE=300`，事件上限就真的是 300，NIP-11 也說 300；客戶端照 240 則／分鐘發。
- 原本在 Worker 上設了低於預設值的站（不太可能有），行為不變：之前那個設定本來就沒有作用。
- Cinderous 錨點沒有設這兩個變數，部署後行為與 NIP-11 都不變。
- 修正要部署到錨點才生效；部署照慣例要使用者另外同意。

## 測試

- `tests/relay/host-config.test.ts`〈Worker 的速率覆寫〉：未設是 120／240；調高採用，訊息不低於事件的兩倍；0、負數、低於預設、壞值都回預設；超過上限夾到上限。
- `tests/relay/worker.test.ts`〈Worker 讀每分鐘速率〉：NIP-11 宣告生效的值；同一把公鑰一口氣送 130 則，預設擋 10 則，設 300 一則都不擋。
- `tests/relay/node-capacity.test.ts`：Node 版 NIP-11 跟著設定走，設 0 時不宣告。

修正前七條都是紅的。
