# 0031. 跨外掛共用中繼連線（Cinder Coffice G8）：評估後建議不做；各自連線、以既有旋鈕壓低成本

- 狀態：Accepted（評估結論，無程式變更）
- 日期：2026-09-29
- 相關：
  - ADR 0021〈後續〉#9（CC G8）、#10（PQ header 成本，本 ADR §6 記錄現況）
  - ADR 0003（延後認證、每站 ping）、0004（`reconnectNow`、`lastActivityAt`）、0013（每把公鑰連線數）、0019（中立預設值）、0023（`NostrSigner`）、0025（`VaultSyncCoordinator`／`NostrVaultTransport`）、0028（每台裝置各自一把身分）、0029（檔案車道）、0030（星狀會話、後量子開銷以批次緩解）
  - 外掛（唯讀參考）：`obsidian-cinder-coffice` ARCHITECTURE §2.1（`SyncGuardService`）、§3.7、§5 G8，PRD §2（「兩個外掛之間能否共用中繼連線，待評估」）、ADR 0003；`obsidian-cindersync` ARCHITECTURE §3、§4，ADR 0003

## Context

同一個 Obsidian Vault 可能同時啟用 CinderSync（`cindersync`）與 Cinder Coffice（`cinder-coffice`）。兩者都把 SDK 打包進自己的 `main.js`，各自 `new RelayPool({ urls: settings.relayUrls, identity })`：

- CinderSync：池子只做 Vault 同步（kind 30078 快照、kind 1060 檔案塊、信令）。身分 `cindersync-identity`，每台裝置一把（外掛 ADR 0003、SDK ADR 0028）。
- Coffice：池子給信令（`PeerNode`）、離線私訊（`DirectMessages`）、中繼備援通道（kind 20079）與內建同步共用。身分 `cinder-coffice-persona`。偵測到 CinderSync 啟用時，`SyncGuardService` 讓內建同步整條不啟動。
- 官方錨點上兩者是**不同車道**：`wss://…/app/cindersync` 與 `wss://…/app/cinder-coffice`。不同路徑就是不同 WebSocket、不同 Durable Object、不同政策與配額（Cinderous ADR-0366／0371）。

Coffice 的 PRD 原本寫「與獨立版共用連線池」，G8 問的是：值不值得讓兩個外掛共用同一條（或同一組）中繼連線。

## 查證：Obsidian 外掛之間能怎麼共享物件

| 機制 | 狀態 | 來源 |
|---|---|---|
| `this.app.plugins.getPlugin(id)`／`app.plugins.plugins[id]` 取得另一個外掛的實例 | **不在公開 API**：官方 `obsidian.d.ts` 的 `App` 只宣告 `keymap`、`scope`、`workspace`、`vault`、`metadataCache`、`fileManager`、`lastEvent`、`renderContext`、`secretStorage`，沒有 `plugins`。社群普遍在用，但屬未文件化的內部物件，型別要自己補、隨時可能變 | [obsidian-api `obsidian.d.ts`](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)、[論壇：How to access other plugins as dependencies?](https://forum.obsidian.md/t/how-to-access-other-plugins-as-dependencies/14469)、[論壇：Inter-plugin Communication](https://forum.obsidian.md/t/inter-plugin-communication-expose-api-to-other-plugins/23618) |
| 掛在全域 `window` 上 | 可行但官方指南要求避免用全域 `app`／`window.app`；論壇提醒全域命名衝突（曾有外掛蓋掉 `window.moment`） | [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)、[論壇：Inter-plugin Communication](https://forum.obsidian.md/t/inter-plugin-communication-expose-api-to-other-plugins/23618) |
| `app.workspace.trigger` 自訂事件 | 可行（未型別化的字串事件），只能傳訊息，不適合傳一個有生命週期的連線物件 | 同上 |
| 外掛相依宣告（manifest 裡寫「依賴某外掛」） | **沒有**。2024-09 的功能請求至今沒有官方回應 | [FR: Add plugin dependencies](https://forum.obsidian.md/t/fr-add-plugin-dependencies/88254) |
| 載入順序 | 不保證。`onload()` 時對方可能還沒載入，要等 `workspace.onLayoutReady` 再找；對方停用時要自己處理 | [論壇：How to access other plugins as dependencies?](https://forum.obsidian.md/t/how-to-access-other-plugins-as-dependencies/14469) |
| 卸載 | 官方指南：外掛建立的資源（事件監聽等）**必須**在卸載時釋放 | [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) |
| 隔離 | **沒有沙盒**：「Obsidian cannot reliably restrict plugins to specific permissions or access levels」，外掛與 Obsidian 同權限 | [Plugin security](https://obsidian.md/help/plugin-security) |

小結：技術上做得到（`getPlugin` 拿到對方實例、呼叫它匯出的方法），但走的是未文件化的內部 API，沒有相依宣告、沒有載入順序保證，卸載規則還要求擁有者關掉自己的連線。

## 評估

### §1 收益：在官方錨點上是零

`RelayPool` 以**完整網址**當連線的鍵（`#connections: Map<url, Connection>`）。`/app/cindersync` 與 `/app/cinder-coffice` 是兩個網址，共用池子也還是兩條 WebSocket；伺服器端它們落在兩顆不同的 DO。**不同車道＝不能合併成一條連線**，這不是實作細節，是錨點的設計（車道各自的檔案政策、可尋址配額、NIP-11 文件都綁在路徑上）。

唯一可能合併的情境：兩個外掛都填了**同一個網址**（例如自架站的根路徑）。

| 項目 | 各自連線（2 外掛 × R 座） | 共用（同網址時） | 備註 |
|---|---|---|---|
| WebSocket 數 | 2R | 錨點：仍是 2R；同網址自架站：R | 典型 R＝1～2 |
| TLS／升級握手 | 啟動與每次回前景各 2R 次 | 同上減半（僅同網址） | 每次約 1～2 RTT、數 KB |
| NIP-42 AUTH | 錨點車道：**0**（車道不要求 AUTH，`guardFor('app')`）；嚴格站：每條連線 1 次 kind 22242 簽章（毫秒級） | 無法省：兩個外掛是兩把身分，`RelayPool` 一次只綁一個 `identity`，relay-core 每條連線也只記一把 pubkey | 共用反而要一條連線認兩把身分，SDK 與中繼都不支援 |
| 錨點每 IP 車道升級（`APP_LANE_LIMIT` 30／分） | 每座錨點啟動 2 次 | 1 次（僅同網址；錨點上不成立） | 30 的額度遠用不完；`reconnectStableMs` 已擋重連風暴 |
| 每把公鑰 120 事件／分 | 兩把身分各自一桶 | 不變（按 pubkey 算，不按連線） | |
| 每連線 240 進站訊息／分、16 個訂閱 | 各自一份額度 | **變差**：兩個外掛的 REQ／EVENT／CLOSE 擠同一份 | Vault 首次同步的連續 EVENT 會吃掉 Coffice 信令的額度，超限整條連線被關，兩邊一起斷 |
| `MAX_CONNECTIONS_PER_PUBKEY`（自架預設 5） | 兩把身分各算各的 | 不變 | |
| 行動裝置電量 | 見下 | | |

電量：閒置的 WebSocket 本身幾乎不耗電，耗電來自**無線電被喚醒**（心跳、推播）。SDK 的 `RelayPool` 沒有內建心跳（ping 由 App 呼叫，ADR 0003），所以差別只在兩個外掛各自排的心跳是否錯開；Obsidian 行動版切到背景時 WebSocket 通常被系統暫停，兩個外掛都靠回前景時 `FastHydrator` 補拉。對齊或拉長心跳、閒置斷線（§4）拿得到的省電，與共用連線差不多，而且不必跨外掛。

### §2 風險：共用把兩個外掛綁成一個故障域

1. **兩份 SDK 不相容**。各自打包就是兩份類別定義：A 的 `RelayPool` 交給 B，`instanceof` 失敗；B 的程式碼碰 A 的 `#private` 欄位直接 `TypeError`；只能靠結構型別呼叫公開方法，而兩邊的 SDK 版本會錯開（外掛各自升版），`Subscription`、`PublishResult`、`onRelayProblem` 的行為差異在執行期才爆。要穩定就得凍結一個跨版本的「共享連線協定」——等於為兩個外掛多養一個公開 API。
2. **生命週期**。官方指南要求卸載時釋放資源：擁有連線的外掛被停用或**更新**（更新＝卸載再載入），另一個外掛的訂閱與進行中的協作會話立刻斷；沒有相依宣告，也沒有「對方要卸載了」的正式通知。誰擁有、誰借用、借用方怎麼接手，每一種組合（只裝一個、兩個都裝、先後啟用、一個更新）都要測。
3. **身分不同**。NIP-42 認證綁身分，`RelayPool` 一次只有一個 `identity`（`setAuthIdentity` 是換，不是加）。CinderSync 用裝置身分、Coffice 用 Persona；共用連線要嘛只認一把（另一把在嚴格站被 `auth-required` 擋），要嘛改 SDK 與中繼支援一條連線多把身分——為了省一條連線不值得。
4. **隔離**。Obsidian 本來就沒有外掛沙盒（`secretStorage` 別的外掛也讀得到，外掛 ADR 0003），所以共用不會讓「惡意外掛」多拿到什麼。但它會讓**意外**變容易：共用池子上 B 看得到 A 的訂閱與全部進站事件（都是密文，但 metadata——誰、何時、多大——一覽無遺），A 的 bug（例如訂閱沒關、灌事件）直接吃 B 的配額或讓 B 斷線。各自連線時這些問題停在各自的外掛裡。
5. **除錯**。中繼的 NOTICE／CLOSED、速率限制、斷線原因要分辨是哪個外掛造成的；`subscriptionPrefix` 只能分訂閱，分不了發布與配額。使用者回報「同步斷了」時，要先問另一個外掛的版本與狀態。

### §3 結論：**建議不做**

- 官方錨點（兩個外掛的主要用法）上收益是零：不同車道本來就是不同連線。
- 只剩「兩個外掛填同一個自架網址」省得到 R 條連線與 R 次握手，換來 §2 的五項風險、一個跨外掛跨版本的相容承諾，以及依賴未文件化的 `app.plugins`。
- SDK 不新增任何共享機制（不做全域註冊表、不做 `RelayPool` 的跨實例借用）。

### §4 替代方案：各自連線、壓低成本（全部是既有能力，不需要改 SDK）

給外掛的建議（寫在這裡當參考，本 ADR 不改外掛；外掛採不採用由外掛自己的 ADR 決定）：

1. **Coffice 在 CinderSync 啟用時完全不碰 Vault 同步**：`SyncGuardService` 判定後，不建立 `VaultSyncCoordinator`、不呼叫 `NostrVaultTransport.start()`（它才是下 `{kinds:[1060], #p:[我]}` 訂閱與補拉的地方，ADR 0025），也不訂閱 kind 30078。建構這些物件本身不連線、不訂閱，所以只要不 `start()` 就零成本。判定要在 `workspace.onLayoutReady` 之後做（載入順序不保證），並監聽 CinderSync 之後被啟用／停用的情況。
2. **延遲連線**：`RelayPool` 的 `connect()` 是明確呼叫的。Coffice 在沒有協作、對話、同步需求時可以不 `connect()`（或只連信令需要的那一座），第一次邀請／開對話時再連。
3. **閒置斷線**：`lastActivityAt(url)`＋`close()`／`connect()`（ADR 0004）已足夠讓外掛在行動版閒置 N 分鐘後斷線、回前景再連並靠 `FastHydrator` 補拉。
4. **心跳**：SDK 不強制心跳。外掛若要保活，用 `ping()`，行動版拉長間隔（Cinderous App 用自適應 60／300 秒），兩個外掛沒有理由用比這更短的間隔。
5. **同一座中繼的連線數**：每個外掛對每個網址本來就只有一條連線（`RelayPool` 以網址去重）。自架嚴格站的 `MAX_CONNECTIONS_PER_PUBKEY` 預設 5，按 pubkey 算，兩個外掛各一把身分，不會互相擠。
6. **設定頁提示**：兩個外掛都裝時，用錨點的人本來就會分到兩條車道，這是正常的，不需要要求使用者填同一個網址。

### §5 觸發重新評估的條件

任一條成立就重開 G8：

1. Obsidian 提供**正式的外掛相依或外掛間 API**（manifest 相依宣告、公開的 `getPlugin` 型別、或官方的服務註冊機制）。
2. 兩個外掛**合併成一個外掛**，或 Coffice 改成「要求安裝 CinderSync」——那時共用是同一份程式碼內的事，沒有跨版本問題。
3. 錨點或 SDK 中繼**改成多個 App 共用一條連線的多工協定**（例如一條 WebSocket 帶多條車道），不同車道不再等於不同連線。
4. 實測顯示兩個外掛的連線造成可量測的問題：行動版電量或流量有使用者回報、錨點的 `APP_LANE_LIMIT`／每連線訊息上限因兩個外掛同時重連而被打到，且 §4 的措施已用上仍不夠。
5. 出現第三個以上依賴 SDK、會和這兩個外掛同時裝在同一個 Vault、而且連**同一個網址**的外掛（收益隨外掛數線性成長）。

## §6 順帶記錄：ADR 0021〈後續〉#10（PQ header 成本）的現況

> **2026-09-29 加註**：使用者已同意改線路格式，**已在 v0.28.0 完成**，見 [ADR 0033](0033-pq-ratchet-header-cost.md)。查證結果：Cinderous App v0.0.18（main 與 PR #9）沒有雙棘輪、沒有會解 SDK 雙棘輪訊息的路徑（它用 `hybrid-kem.ts` 每則無狀態封裝），所以不需要與 App 協調；新格式以 hello 的 `pqf` 協商，v0.27 的後量子對端明確拒絕。以下保留當時的記錄。

只記錄，不改任何程式：

- **線路格式未改**：雙棘輪後量子模式每則訊息仍固定帶 2,314 B header（ADR 0010）。「只在 DH 步進時附 KEM 欄位」仍只是評估項目。
- **星狀會話以應用層批次緩解**（ADR 0030 §6）：批次視窗內的紀錄合成一則棘輪訊息，實測 50 則 20 B 更新合成一則 3,767 B（每則約 75 B）；單則 20 B 更新仍是 2,395 B（成員→Host）。
- **改線路格式需與 Cinderous App 協調**：Cinderous App（v0.0.18）用自己的加密實作。任何一方單獨改格式，雙方就互相解不開。協調時要先確認 App v0.0.18 有沒有會解 SDK 雙棘輪訊息的路徑（ADR 0010 記載 Cinderous 當時刻意沒做雙棘輪），再決定影響範圍、版本協商與過渡期。
- **待使用者決定**：要不要改、何時改、要不要做版本旗標讓新舊並存。決定前 SDK 不動線路格式。

## Consequences

- ＋ 兩個外掛各自一個故障域：一個停用、更新、出 bug、被限速，不會拖垮另一個。
- ＋ 不依賴 Obsidian 未文件化的 `app.plugins`，不用凍結跨外掛跨版本的連線協定。
- ＋ SDK 不需要新 API；§4 全部用既有的 `connect()`／`close()`／`lastActivityAt()`／`ping()`／`VaultSyncCoordinator` 的 `start()`／`stop()`。
- － 兩個外掛填同一個自架網址時，每座中繼多一條 WebSocket 與一次握手（嚴格站多一次 AUTH 簽章）。
- － 兩個外掛各自排心跳時，行動版的無線電喚醒次數可能加倍；要靠外掛自己拉長或對齊間隔。
- － Coffice PRD 的「與獨立版共用連線池」一句要由外掛自己更新（本 ADR 不改外掛）。
