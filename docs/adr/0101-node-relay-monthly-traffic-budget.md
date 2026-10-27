# 0101. Node 版中繼的每月流量預算：用完就停止服務並說明，到重置日恢復

- 狀態：**已接受（Accepted，2026-10-19）**——使用者 2026-10-19 依序討論後「開始實作」
- 日期：2026-10-19
- 對應：SDK ADR 0099（空間上限）、0100（同時連線數）、0097（`over quota:` 與 1013 的形狀）、0042（`warning: near-full:` 預警的兩級）

## Context

VPS 的流量方案多半按月計，超過可能加收費用或降速。Node 版中繼原本沒有任何頻寬或總流量的限制。站主無法保證「這座中繼不會讓我的帳單超量」。

## Decision

使用者 2026-10-19 選定：

1. **每月預算**：`MONTHLY_TRAFFIC_GIB`（整數 GiB，1 GiB–1 PiB）。沒設就是不限，與之前相同。
2. **計費週期**：
   - `TRAFFIC_RESET_DAY`（1–28，預設 1）：每月那一天 00:00 UTC 歸零，對齊 VPS 的帳單日。只到 28 號，因為每個月都有這一天。
   - 用量存在 SQLite 的 `traffic_usage` 表，每個週期一列，所以重開不會歸零。
   - 每 30 秒與關閉時寫回一次，當機最多少算 30 秒的量。
   - 純記憶體模式沒有 SQLite，重開就歸零，啟動時會提醒。
   - 這張表只在設了預算的 Node 主機上建立，不在 `SqlMessageStore` 裡。Cloudflare 版與 Cinderous 的 schema 相容性（ADR-0379）不受影響。
3. **算哪個方向**：`TRAFFIC_COUNT=total`（預設，進出合計，不會少算）或 `out`（只算出去的）。
4. **用完之後**：
   - 新連線與既有連線都收到 `over quota: this relay has used up its monthly traffic allowance and cannot serve connections until it resets (<日期> UTC). Use another relay meanwhile.`，並以 1013 關閉。
   - 前綴與 Cloudflare 額度用完相同（SDK ADR 0097），客戶端一樣會改用別座。
   - 到重置日自動恢復，日誌每個週期只寫一次。
   - 這樣保證不會超出預算。代價是用完後連站主自己也連不上。
5. **快用完時提醒**：`TRAFFIC_NEAR_FULL_PERCENT`（50–99）。
   - 達到時，收下的 `OK true` 帶 `warning: near-full: <級>: 本站本月流量已用…`，分兩級：站方設定的一級與 95。
   - 詞元與空間預警相同，客戶端照既有的分類認得（`near-full`），不需要更新。
   - 已經帶別的警告（空間快滿、借用）的 OK 不蓋掉。
   - 伺服器日誌也寫一次。
   - NIP-11 多一個 `cinder_traffic` 欄位：`budget_bytes`、`count`、`used_percent`、`resets_at`，以及有設時的 `near_full_percent`。只公開百分比，確切位元組只寫日誌。
6. **只算 WebSocket 裡的資料量**：TLS 與 HTTP 的開銷算在前面的反向代理上，中繼看不到。README 與部署說明都寫「預算請設成方案的九成左右」。NIP-11 與 `/healthz` 的 HTTP 回應不算。
7. **部署設定器**：`monthlyTrafficGib`、`trafficResetDay`、`trafficCount`、`trafficNearFullPercent`，只給 Node 主機。附屬的三項沒有 `monthlyTrafficGib` 就不會生效，所以拒絕部署。
8. `NodeRelayOptions.trafficBudget`：給嵌入者與測試直接指定位元組數。環境變數只收整數 GiB。

## Alternatives Considered

- **每天一份預算**：遇到爆量最多停一天，但前幾天沒用完的不能累積，也對不上月計的帳單。
- **每月加每天都能設**：多一組設定。目前沒有需要。
- **用完後只留白名單**：自己不斷線，但可能超出預算。
- **用完後降速**：服務不停但很慢，也仍可能超出預算。
- **每則訊息都寫回 SQLite**：完全不會少算，但每則訊息都多一次磁碟寫入。

## Consequences

- ＋ VPS 站主可以保證中繼的流量不會讓帳單超量。快用完時，客戶端與站主都會提前知道。
- － 中繼看不到 TLS 與 HTTP 的開銷，要靠站主留餘裕。
- － 用完後站主自己也連不上，要等重置日，或手動調高預算再重開。
- － 當機最多少算 30 秒的量。
- 驗證：
  - `tests/relay/traffic-budget.test.ts`：解析、計費週期（含跨年）、計數、兩級預警、存進 SQLite 重開不歸零、換週期歸零；實際開一台 Node 中繼，看 `near-full` 預警與 NIP-11，以及用完後新舊連線都收到 `over quota` 並以 1013 關閉；
  - `tests/deploy/relay-site-options.test.ts`。
