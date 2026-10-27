# 0100. Node 版中繼的同時連線數上限：全站與每個 IP，沒設就不限

- 狀態：**已接受（Accepted，2026-10-19）**——使用者 2026-10-19 依序討論後「開始實作」
- 日期：2026-10-19
- 對應：SDK ADR 0099（空間上限）、0101（每月流量預算）、0013（存取控制：`MAX_CONNECTIONS_PER_PUBKEY`）、0097（DO 起不來時說明原因的形狀）；Cinderous ADR-0368（拒絕連線時說明原因）

## Context

Node 版中繼原本能限制的只有：
- 每把公鑰幾條連線（`MAX_CONNECTIONS_PER_PUBKEY`）；
- 每個 IP 每秒送幾則訊息（`MAX_MESSAGES_PER_SECOND_PER_IP`）。

**沒有全站連線總數的上限，也沒有每個 IP 的連線數上限。** 有人開幾萬條連線卻什麼都不送，就能把 VPS 的記憶體吃光。公鑰上限擋不住，因為連線在認證前就佔了資源。

## Decision

使用者 2026-10-19 選定：

1. **`MAX_CONNECTIONS`**：全站同時連線數上限。沒設或壞值就是不限，與之前相同，既有的站升級後不會突然拒人。
2. **`MAX_CONNECTIONS_PER_IP`**：同一個 IP 的同時連線數上限。沒設就是不限，因為手機電信與公司網路常是很多人共用一個 IP，預設擋會誤傷。來源 IP 的判斷與既有的訊息限速相同：`TRUST_PROXY=1` 時看 `X-Forwarded-For` 的第一個位址。
3. **超過時的回應**：與 SDK ADR 0097 同一個形狀，也就是接受升級、送一則 `NOTICE`、以 **1013 Try Again Later** 關閉。不附開發文件，因為這不是用法錯誤。
   - 全站滿了：`too many connections: this relay is at its connection limit. Retry in a few minutes or use another relay.`
   - IP 滿了：`too many connections: too many open connections from your IP address. Close some or use another relay.`
   - `RejectKind` 多了 `too-many-connections` 與 `too-many-connections-ip`。
   - 新增 `upgradeCloseCode(kind)`，統一「暫時不能用就是 1013、用法錯了就是 1008」。Cloudflare 版的 `rejectUpgrade` 也改用它。
4. **只數真正進來的連線**：被擋的不佔名額。`close` 與 `error` 都會觸發清理，只扣一次。
5. **只做 Node 版**：
   - Cloudflare 版的連線分散在很多顆 Durable Object，要算全站總數得跨 DO 協調，而且每次連線又多讀寫儲存，會耗額度。
   - Cloudflare 本身也擋大量連線。
6. **部署設定器**：`maxConnections`（1–1,000,000）、`maxConnectionsPerIp`（1–10,000），只給 Node 主機（`NODE_ONLY_SITE_OPTIONS`），只寫在設定檔。

## Alternatives Considered

- **預設一個保守值**（例如 1000）：沒設定的站也有保護，但大站升級後可能開始拒人。
- **每個 IP 預設寬鬆值**（例如 100）：擋得住單一來源開幾萬條，但仍可能誤傷共用 IP 的大型網路。使用者選擇預設不限、由站主決定。
- **直接回 HTTP 503**：最省資源，但瀏覽器的 WebSocket 看不到升級失敗的原因（ADR-0368 的理由）。
- **Cloudflare 版每顆 DO 各自限制**：不是全站總數，意義不同，暫時不做。

## Consequences

- ＋ VPS 站主可以依機器規格設上限，記憶體不會被大量閒置連線吃光。
- ＋ 被擋的客戶端看得到原因，會改用別座。
- － 連線仍要先完成 WebSocket 升級才被擋，被擋的那一下仍有少量成本。真正的大流量攻擊要靠前面的反向代理或防火牆。
- 驗證：
  - `tests/relay/node-connections.test.ts`：解析、句子與關閉碼；實際開一台 Node 中繼，全站滿了被擋、有人離開又進得來、每個 IP 各自計算、被擋的不佔名額、沒設就不限；
  - `tests/deploy/relay-site-options.test.ts`。
