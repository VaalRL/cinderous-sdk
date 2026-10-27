# 0007. 中繼與共用協定搬進 SDK：SDK 成為中繼唯一來源，Cinderous 的中繼是部署實例

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0001（範圍、git 相依）、ADR 0006（PRD 矛盾拍板）；Cinderous ADR-0005（自建 Worker relay）、
  ADR-0056（DO SQLite）、ADR-0241（分片）、ADR-0260（NIP-11）、ADR-0354（合一 Worker）、ADR-0366～0369（車道）

## Context

產品決定（2026-09-27）：`relay-core`／`relay-lite` 要**完整收納**現在的 Cinderous relay，SDK 成為中繼的唯一來源；
Cinderous 的 `relay/` 只留部署設定與運維。這推翻了先前「relay 與客戶端不分 repo」的建議——
代價是協定改動從「一次提交改兩邊」變成「SDK 先發版、Cinderous 再升版」。

搬移時發現：中繼用到的 `@cinderous/core` 是**客戶端與中繼共用的協定**（NIP-42、NIP-98、NIP-62、NIP-13、分片路徑、
NIP-59 時間倒填常數，以及底層的事件序列化與 Schnorr 驗章）。中繼搬走，這些也得搬，否則 SDK 會反過來依賴 Cinderous。

## Decision

1. **共用協定搬進 SDK**（`@cinderous/client/protocol`）：
   - Cinderous `packages/core` 的 `event`、`sign`、`keys`、`nip42`、`http-auth`、`vanish`、`pow`、`shard` **原樣**搬來；
     `TIMESTAMP_JITTER_SECONDS` 放 `protocol/nip59.ts`。
   - 仍用 `@noble/curves` 1.x、`@noble/hashes` 1.x 自己實作，與 Cinderous 現在逐位元組相同，不改用 nostr-tools。
   - Cinderous core 改成從這裡轉出，App 其他程式不必改 import。
2. **中繼搬進 SDK**（Cinderous `relay/src` 原樣搬來）：

   | 入口 | 內容 |
   |---|---|
   | `@cinderous/client/relay` | `RelayCore`、協定解析、filter、記憶體／SQL 儲存、政策（嚴格平面、車道、公用車道）、NIP-11、分片路由、版號 |
   | `@cinderous/client/relay/worker` | Cloudflare Worker＋Durable Object（`RelayRoom`）、`/turn`、拒絕連線附文件網址 |
   | `@cinderous/client/relay/node` | `startNodeRelay(env)`（SQLite 持久化、預設 NIP-42）、`startDevRelay(port)`（純記憶體） |

   - 測試一起搬：relay 9 組，約 3,000 行。
   - Node 主機原本是「一載入就開 server 的腳本」，改成可呼叫的函式並回傳 `close()`，補了真的開起來的冒煙測試。
3. **版號由宿主注入**：NIP-11 的 `version` 是**部署者的版號**（Cinderous App 的「一鍵更新節點」比的是 App 版本），
   不是 SDK 的版本。宿主在載入時呼叫 `setRelayVersion()`。
4. **單一套件、子路徑入口**，不照 PRD 拆成 `@cinderous/relay-core` 等三個套件：
   - npm 的 git 相依不支援子目錄，而遊戲有用 npm 的。
   - 共用協定同在一個套件，才不會出現套件之間互相依賴 git 版本。
   - 上 npm 時再拆出獨立名稱。
5. **型別檢查分三組**：主體（含 DOM）、Worker（`@cloudflare/workers-types`）、Node（`@types/node`），避免全域型別互相污染。
   `ws` 改為 optional dependency，只有 Node 主機需要，Bun 內建 WebSocket。
6. **留在 Cinderous 的**：
   - 兩座錨點的 `wrangler*.toml`（APP_LANES、secrets、限速 binding）；
   - 官網與中繼合一的膠水（ADR-0354）；
   - 運維工具 `bootstrap/`：它依賴 App 自己的簽章中繼清單、准入規則與探測，是 Cinderous 生態的運維，不是中繼功能；
   - `in-memory-network`：串 App 的 `RelayClient` 與 SDK 的 `RelayCore`，給 engine 的離線模式與測試用；
   - 讀 `wrangler.toml` 的設定測試、App 與中繼的整合測試。
7. **PRD 的白名單模式（`ALLOWED_PUBKEYS`）與 `--persist` 旗標**是新功能，不在這次搬移裡。
   這次只做「行為一致的搬家」，新功能之後另外加。

## Consequences

- ＋ 中繼與共用協定各只有一份；四款遊戲、Cinderous App、Cinderous 的中繼看到的是同一套規則。
- ＋ 任何人都能用 SDK 起一座與 Cinderous 錨點同一套行為的中繼（Worker 或 Node）。
- － 改協定要先改 SDK、打標籤，Cinderous 再升版；兩邊不能在同一個提交裡一起改。
- － Cinderous 的 core、engine、relay 會依賴私有 repo 的 SDK：CI 與 Tauri 打包都要能讀它。
- － 已知小差異：SDK 的 `noUnusedLocals` 比 Cinderous 嚴，搬來時拿掉 `sql-message-store` 一個沒用到的 import（行為不變）。
