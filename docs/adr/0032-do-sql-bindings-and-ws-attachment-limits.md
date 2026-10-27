# 0032. 中繼移植兩個正式環境修正：DO SQLite 綁定參數上限（Cinderous ADR-0372）與 WebSocket attachment 16KB 上限（Cinderous ADR-0373）

- 狀態：Accepted
- 日期：2026-09-29
- 對應：Cinderous ADR-0372（PR #12，分支 `claude/relay-sql-param-limit`，commit `87b36d71`）、
  Cinderous ADR-0373（PR #13，分支 `claude/relay-ws-attachment-limit`，commit `7dac40d8`）。兩個 PR 在本 ADR 寫成時
  **尚未合併**到 Cinderous main（使用者要統一部署），本 ADR 以兩個分支的內容為準。
  相關：本 repo ADR 0007（中繼搬進 SDK）、0008／0013（白名單、每把公鑰連線數、每 IP 速率、關閉碼）、
  0021（REST 一鍵部署內嵌的 Worker）、0028 §7（白名單站放行已認證成員的禮物包）、0029（檔案車道移植與 schema 相容測試）。

## Context

Cinderous PR #9 會讓官方錨點改跑 SDK 的中繼（`@cinderous/client/relay/worker`）。Cinderous 在 `wrangler dev` 上實測撞到兩個
Cloudflare 平台上限，各開了一個 PR 修正；兩份 ADR 的〈後續〉都寫明「SDK 需移植同一修正，PR #9 合併前須先補齊，
否則部署它等於把本 ADR 撤銷」。SDK 的中繼與 Cinderous 的同一段程式碼逐字相同，所以兩個問題 SDK 都有：

1. **DO SQLite 每次查詢最多 100 個綁定參數**（Cloudflare Limits 頁）。`SqlMessageStore.query()` 把 `#p`／`authors`／`ids`／
   `kinds`／標籤值逐一展成 `IN (?,…)` ⇒ 一個欄位 98～99 個值就拋例外 ⇒ 客戶端收到 `NOTICE 內部錯誤`、沒有 EOSE、同一 REQ
   後面的 filter 不重播。本機測試用 node:sqlite（上限 32766）看不出來。
2. **WebSocket attachment 最多 16,384 bytes**。`RelayRoom.persist()` 把連線的全部訂閱塞進 attachment ⇒ 同一連線 `authors`
   合計約 240 把以上時 `serializeAttachment` 在 `webSocketMessage` 裡拋**未捕捉例外**：客戶端什麼都收不到，訂閱只留在記憶體，
   DO 休眠一次就無聲消失。

SDK 另有 Cinderous 沒有的功能（白名單、每把公鑰連線數、每 IP 速率、關閉碼 4003、檔案車道與白名單的合併規則），
移植後這些都要照常運作。限制：TDD、向下相容、零 Node 子路徑守門、主入口打包不變大、`dist/` 進版控。

## Decision

以兩個分支的 relay 差異直接套上 SDK（`git diff … | git apply`，路徑改寫），衝突的段落手動對齊；測試同樣套上，再加 SDK 專屬的組合測試。

### 對照表

| Cinderous | SDK |
| --- | --- |
| ADR-0372：`inJson(column, values)`＝`column IN (SELECT value FROM json_each(?))`，整串值一個綁定參數；非陣列照舊拋（由例外圍籬轉 NOTICE） | 同（`sql-message-store.ts`，patch 乾淨套上） |
| ADR-0372：`query()` 的 `#p`／`authors`／`ids`／`kinds`（離線表與可尋址表）與標籤值改用 `pushIn`；刪除 `placeholders`／`push2` | 同；`src/` 內已無任何動態展開的 `IN (…)` |
| ADR-0372：寫入與刪除路徑本來就固定個數，不改（加測試釘住） | 同 |
| ADR-0372：12 個測試，「綁定參數 > 100 就丟錯」的 `SqlExec` 替身、與記憶體版逐一對照（修正前 11 紅） | 同（`tests/relay/sql-message-store.test.ts`，修正前同樣 11 紅） |
| ADR-0373：`conn-persistence.ts`（`ConnPersistence`、`ATTACHMENT_MAX_BYTES`、`INLINE_BUDGET_BYTES` 12KiB、`MAX_CONN_SUB_BYTES` 512KiB、`ws_subs(conn_id, sub_id, filters)` 以 `CREATE TABLE IF NOT EXISTS` 建立） | 逐字相同（只把註解與記錄裡的 ADR 編號加上「Cinderous」） |
| ADR-0373：由小到大塞 attachment、其餘溢位；只在內容變了才寫（心跳零寫入、喚醒後第一則也不重寫）；先寫溢位列 → attachment → 刪舊列 | 同 |
| ADR-0373：合計超限回 `CLOSED invalid:`、存不住回 `CLOSED error:`（那條的 EVENT／EOSE 不送）、喚醒找不到溢位列回 `CLOSED error: … lost …` 並立刻更正 attachment；都有 `console` 記錄 | 同；**線路上的字串逐字相同**（含結尾的 `(ADR-0373)`，那是 Cinderous 的編號——PR #9 之後錨點改跑本檔，客戶端看到的不該變） |
| ADR-0373：`RelayCore.dropSubscription(connId, subId)`，客戶端 `CLOSE` 改走它 | 同（新增的公開方法，向下相容） |
| ADR-0373：`webSocketClose`／`webSocketError`／伺服端主動關閉都經 `forget()` 刪列；`webSocketError` 也先還原 | 同；SDK 的主動關閉多了幾種原因（白名單外 4003、每把公鑰連線數 1008、每 IP 速率 1008），全部走同一個 `dispatch` → `forget()` |
| ADR-0373：喚醒還原時清孤兒列；`alarm()` 也觸發還原 | 同 |
| ADR-0373：假 DO 的 attachment 超過 16KB 就拋、`ws_subs` 寫入計數與故障注入；14 個測試（修正前 12 紅） | 同（`tests/relay/worker.test.ts`，修正前同樣 12 紅） |

### 差異（只保留 SDK 原有的功能）

- `ConnSnapshot` 在 SDK 多一個 `ip` 欄（每 IP 速率，SDK ADR 0013）。它照樣進 attachment 的「標頭」，算在 12KiB 預算扣掉的那一段裡
  （IPv6 最多約 45 bytes，對 4KiB 餘裕無感）。Cinderous 寫下的 attachment 沒有這欄 ⇒ 還原後不做每 IP 速率，直到那條連線重連
  ——與 v0.26 以前升級時的行為相同。
- SDK 的 `fetch` 在「升級前就釘住的車道 DO 補記車道 id」時會重建 `RelayCore` 並 `hydrated = false`：下一次 `ensureHydrated`
  由 `ConnPersistence.load()` 重新讀 attachment 與溢位表，「已持久化」狀態一併重設，不會重寫。
- `dispatch` 的關閉碼走 SDK 的 `closeSignalOf`（Cinderous 只有 1008 rate-limited）。
- 註解與記錄的 ADR 編號加上「Cinderous」前綴；`wrangler.toml`、錨點設定等部署設定不移植（ADR 0019）。

### 兩者結合的行為（新增測試）

- **假 DO 的 SQL 也限 100 個綁定參數**（`FakeState.raw`）：宿主層的每一個測試從此都在 DO 的上限下跑，既有 100 個 worker 測試照樣通過。
- 白名單 × 溢位：成員的 1024 把訂閱 EOSE、休眠後收得到另一位成員的事件；車道上沒認證就先訂了 400 把、再以名單外身分認證
  ⇒ 4003 斷線且溢位列清掉；每把公鑰連線數 1：休眠還原後照樣數得到舊連線（第二條 1008、第一條的大訂閱照常、沒留下列）；
  每 IP 速率超限 1008 ⇒ 溢位列清掉。
- 檔案車道 × 大量 authors：`kinds:[1060]` ＋ 150 把 authors 補回全部 150 顆並 EOSE；`kinds:[1060]` ＋ 300 把（溢位）休眠後新塊仍即時送到。
- 以上 7 個（含下節的切換測試）在修正前全部是紅的。

## DO 遷移／相容

- `ws_subs` 用 `CREATE TABLE IF NOT EXISTS`，不需 wrangler migration（類別本來就是 `new_sqlite_classes`）。
- `tests/relay/schema-compat.test.ts` 延伸：起點是「Cinderous PR #12＋#13 套用後」的 schema——把 `claude/relay-ws-attachment-limit` 的
  `relay/src` 疊上 `claude/relay-sql-param-limit` 的 `sql-message-store.ts`，以 esbuild 打包、在 node:sqlite 上**真正執行**它的
  `RelayRoom`（認證、REQ 300 把、REQ 1 把）後 dump `sqlite_master`（`sub_id` 後面的兩個空白原樣保留）。驗證：SDK（`SqlMessageStore`
  ＋`ConnPersistence`，與 `RelayRoom` 建構子相同）打開它不丟例外、重跑不丟例外、結構一字不差；SDK 從零建的 schema 與它完全相同；
  從 Cinderous main（ADR-0371，還沒有 `ws_subs`）升上來收斂到同一份；Cinderous 形狀的 attachment（欄位 connId／challenge／pubkey／
  relayHost／subs／spilled，同一次 dump 取得）與 `ws_subs` 列由 SDK 還原、孤兒列清掉。
- `tests/relay/worker.test.ts`：同一顆 DO（KV 已由 Cinderous 釘住、`ws_subs` 有一列、socket attachment 是 Cinderous 的形狀）由 SDK 的
  `RelayRoom` 接手：兩條訂閱（inline 的 small、溢位的 hb）都收得到心跳，喚醒後第一則訊息零寫入、不搬家，已認證身分照常。
- **真實 DO SQLite 上的切換**（`wrangler dev`，同一個 `--persist-to` 目錄、同一個 Worker 名）：先跑 Cinderous PR #12＋#13 的打包
  （`/` 認證、存一則寄給自己的 1059、REQ 300 把 ⇒ EOSE），連線開著直接殺掉 wrangler（模擬部署重啟、`webSocketClose` 沒跑）
  ⇒ DO 裡留下 1 列孤兒；換 SDK v0.27.0 的 REST 打包啟動：認證、`#p` 取回 Cinderous 版存的留言、REQ 300 把 EOSE、閒置 25 秒後
  心跳扇出收到；停掉後檢查 DO 的 SQLite 檔：schema（3 表 7 索引）不變、`ws_subs` 0 列（孤兒已清、自己的列在關閉時刪）、留言 1 列。
  這同時補上 ADR 0029 建議的「PR #9 部署前以 `wrangler dev` 對 DO 建構子遷移路徑做一次真實冒煙」。
- 回滾到 v0.26：舊程式不認得 `spilled`、不讀 `ws_subs` ⇒ 回到修正前的行為（大訂閱休眠後遺失），不會更糟；`ws_subs` 留在 DO 裡，
  每條大訂閱一列，佔用極小。

## 實測（`wrangler dev`，本機 workerd）

入口用的是 **REST 一鍵部署內嵌的 `relayWorkerSource`**（`npm run build` 重新產生），不是原始碼——部署出去的就是這一份。
設定：`APP_LANES=testgame`、`FILE_LANES=testgame`、`MAX_FILE_MB=30`；檔案車道 `/app/testgame` 先以 150 把不同金鑰各發一顆 1060。
「閒置後」＝閒置 25 秒再發（Cinderous ADR-0373 已驗證 `wrangler dev` 會在這段時間內讓 DO 休眠；下表 v0.26 那欄的「50 把收到、
260 把收不到」再次證明記憶體確實清空過）。

| 情境 | v0.26.0（修正前的打包） | v0.27.0 |
| --- | --- | --- |
| 檔案車道 REQ `kinds:[1060]` ＋ authors 98／99／150 | NOTICE／NOTICE／NOTICE（98 把加上 kinds 就超過 100） | 98／99／150 顆 ＋ EOSE |
| 檔案車道 REQ ids 150 ＋ authors 150 | NOTICE | 150 顆 ＋ EOSE |
| 檔案車道 REQ `#t` 150 ＋ authors 150 | NOTICE | 150 顆 ＋ EOSE |
| 嚴格平面（已認證）REQ `kinds:[20000]` authors 50 | EOSE | EOSE |
| 同上 authors 260／1024 | **無回應**（workerd：`Uncaught Error: A WebSocket 'attachment' cannot be larger than 16384 bytes`） | EOSE／EOSE |
| 檔案車道 REQ `kinds:[1060]` authors 300 | **無回應** | EOSE |
| 同一連線 8 條 × 1024 把 | 8 條都無回應 | 前 7 條 EOSE、第 8 條 `CLOSED invalid: … 512 KiB …`（記錄 `s7(too-large)`） |
| 閒置後扇出：50／260／1024 把 | 收到／**收不到**／**收不到** | 收到／收到／收到 |
| 閒置後扇出：8 × 1024 那條連線 | 全收不到 | s0–s6 收到、s7（已關閉）沒有 |
| 閒置後扇出：檔案車道 300 把的新塊 | **收不到** | 收到 |
| 喚醒時 `CLOSED … lost` | — | 0 則 |

## 測試

- 移植：`sql-message-store`（+12）、`worker`（+14）。
- 新增：`worker`（+7：白名單 4、檔案車道 2、從 Cinderous 版切換 1）、`schema-compat`（+4）。
- 合計新增 37 個；全套 100 個檔案、1,394 個測試通過。`npm run check`（型別、測試、建置、`dist` 與內嵌 Worker 與原始碼一致）全綠。

## 打包大小（esbuild 壓縮）

- 主入口 156,341 B——**不變**。
- `./relay` 64,861 → 65,039 B（`dropSubscription`）；`./relay/worker` 65,462 → 70,590 B（`ConnPersistence`）。
- REST 一鍵部署內嵌的 Worker（`relayWorkerSource`）64,513 → 69,389 B。

## 自我審查

- **綁定參數**：離線表最多 9 ＋ 2 × 標籤鍵數、可尋址表 5 ＋ 2 × 標籤鍵數。單一 filter 超過 45 個**不同**標籤鍵仍會超過 100 ⇒
  NOTICE（與修正前相同；合法客戶端不會這樣送，有 40 鍵的測試）。惡意 filter 放非字串值時，修正前綁定就拋、現在比對不到回空 EOSE。
  `json_each` 的虛擬表列可能計入讀取列數（每次查詢多 N 列），遠少於分批查詢。以上與 Cinderous ADR-0372 相同，未另做處理。
- **溢位**：一般情況（約 180 把以下）仍是零 storage 讀寫；大訂閱只在 REQ／改訂閱／CLOSE 時寫 1 列、心跳不寫；喚醒只在有溢位時讀整張表。
  寫入順序保證不會有「attachment 指著不存在的列」，最多留下孤兒列，由下一次還原或 `alarm()` 清掉（有測試、也在 `wrangler dev` 上驗過）。
- **SDK 專屬關閉路徑**：4003（白名單外）、1008（每把公鑰連線數、每 IP 速率、每分鐘速率）都由 `dispatch` 經 `forget()` 刪列——
  被拒的連線不會留下溢位列（有測試）。每把公鑰連線數依 `authState` 計算，而 `pubkey` 在 attachment 標頭裡，溢位不影響還原。
- **不靜默**：`save()` 不拋；`webSocketMessage` 從此沒有未捕捉例外的路徑。`CLOSED` 之後要不要重訂由客戶端決定——SDK 的 `RelayPool`
  目前不會對 `CLOSED` 自動重訂、只經 `onRelayProblem` 回報原因（與 Cinderous 引擎相同，Cinderous ADR-0373〈後續 3〉）；合法客戶端只有「表列遺失」這個極罕見情況會拿到它。
- **線路字串帶 Cinderous 的 ADR 編號**：`CLOSED` 原因裡的 `(ADR-0373)` 指的是 Cinderous 的 ADR，不是本 repo 的。刻意保留逐字相同，
  讓錨點從 Cinderous 版切到 SDK 版時客戶端看到的一樣；客戶端只該看前綴（`invalid:`／`error:`）。
- **遷移相容**：schema 逐字相同（測試＋真實 DO SQLite）；KV 鍵名不變；attachment 多一個 `spilled` 欄，舊版 attachment（沒有此欄）照常還原
  （Cinderous 移植來的回歸測試）。
- **Node 主機**（`node-relay.ts`）沒有 attachment；它選用 `SqlMessageStore` 時跑在 node:sqlite（上限 32766）上，`json_each(?)` 的查詢結果與修正前相同（同一組對照測試），不受影響。
- **殘餘風險**：若平台日後調低 attachment 上限，連線 id／挑戰／主機本身存不下時首次存檔會失敗、只留記錄（與 Cinderous 相同）。
  兩個 Cinderous PR 若在合併前再改，這裡要跟著重移植；`schema-compat` 的「結構一字不差」會先紅。

## Consequences

- ＋ SDK 中繼具備 Cinderous PR #12＋#13 的完整修正，PR #9 合併不會把 ADR-0372／0373 撤銷；同一顆 DO 從 Cinderous（含兩個 PR）
  切到 SDK 版有單元測試與 `wrangler dev` 實測守著。
- ＋ REST／wrangler／Docker／Fly 一鍵部署出的自架中繼一併修好（白名單站的成員通訊錄超過約 240 人時，心跳訂閱不再於休眠後消失）。
- － `./relay/worker` 與內嵌 Worker 約大 5 KB；DO 多一張 `ws_subs` 表。
- ⚠ 已部署的 SDK 中繼要重新部署才有這兩個修正。
