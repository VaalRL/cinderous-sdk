# 0001. v0.1：先做 Nostr 客戶端層與試算器；授權改 AGPL；以 git 相依發布、`dist/` 進版控

- Status: Accepted
- Date: 2026-09-27

## Context

PRD 描繪了六個套件：`@cinderous/client`、`relay-core`、`relay-lite`、`relay-serverless`、`cli` 與 estimator。
它們含三層中繼、Cinder EK 與後量子雙棘輪兩套加密引擎、WebRTC P2P 連線、一鍵部署與推播，
但沒有定 MVP，而且有幾處自相矛盾，見下方「未決」。

盤點結果：

- **真正的使用者是四款遊戲**：《辭職信》《元素使》《沒當好爸爸》《菜鳥教頭》。它們接上 Cinderous 中繼時，
  各自寫了一份 1,000～1,700 行的 Nostr 客戶端：多中繼連線池、NIP-42、NIP-17 私訊、封鎖名單。
  其中《菜鳥教頭》那份是整份照抄《沒當好爸爸》的。
  PRD 裡的兩個 Obsidian 外掛（CinderSync、Coffice）目前只有文件。
- Cinderous 本體已經有 relay-core、Docker 自架、一鍵部署、Cinder EK、後量子混合封裝與 WebRTC 信令，
  也都有測試；但沒有雙棘輪，混合封裝用的是 secp256k1 而不是 PRD 寫的 X25519。
- 可以抽出來的實作都是 AGPL（Cinderous）或 GPL（《沒當好爸爸》），SDK 原本寫的是 MIT。

## Decision

1. **授權改為 AGPL-3.0-only**（2026-09-27 產品決定）。
   - 程式碼因此可以直接從既有、已測試的實作抽出，不必另外重新授權。
   - 使用本 SDK 的應用在散布或以網路提供服務時，也必須依 AGPL 提供對應原始碼。
2. **v0.1 只做 `@cinderous/client` 的 Nostr 層與 estimator**：
   - `RelayPool`：多中繼同時連、以 id 去重、驗簽、NIP-42 AUTH、退避重連，連線撐過 30 秒才把退避歸零、
     `onRelayProblem`、訂閱前綴可設定。
   - `Identity`：NIP-01／19、NIP-44 v2，私鑰不外露。
   - `DirectMessages`／`wrapDm`／`unwrapDm`：標準 NIP-17。一份 rumor 封兩次、以 rumor id 去重；
     已用測試驗證能和 nostr-tools 雙向互通。
   - `Blocklist`、`loadOrCreateIdentity`／`SecretStore`。
   - `@cinderous/client/estimator`：規則見 ADR 0002。

   來源是《沒當好爸爸》`packages/nostr`（commit `1bf726a`）：它最乾淨，WebSocket 與儲存都以介面注入。
   只改三處：介面改名 `RelayTransport`、訂閱前綴改成可設定、儲存鍵改成可設定。
   儲存鍵可設定，是為了讓已上線的遊戲沿用原本的鍵，玩家的舊私訊與封鎖名單才讀得回來。
3. **發布方式**：GitHub 私有 repo，遊戲用 git 相依。
   - `dist/` 進版控。原因一：pnpm 10 預設不跑相依套件的 build script。
     原因二：Node 的 type stripping 不處理 `node_modules` 裡的 `.ts`，而《元素使》用 `node --test` 直接載入。
   - `npm run check` 會重新建置，並要求 `dist/` 沒有差異。
   - 之後要上 npm 再另定。
4. **不在 v0.1 的範圍**：relay-core／relay-lite、Cinder EK、雙棘輪、`connectPeer`（WebRTC）、部署 CLI、推播。

## 未決（PRD 內的矛盾，動到相關套件前要先拍板）

> 2026-09-27 已全部拍板，見 [ADR 0006](0006-prd-contradictions-resolved.md)。

- relay-lite「零持久化」與 30078／1060 要存 30 天互相衝突。
- 信令事件 20078 用真實公鑰簽、`p` 標籤是明文，與「NIP-59 讓公共節點只看得到亂碼」衝突。
- EK 的二進位格式沒有定義；輪替週期寫了 24 小時與「每週」兩種，Cinderous 實際是 7 天。
- 混合封裝的古典半邊：PRD 寫 X25519，Cinderous 用 secp256k1。
- CLI 指令名稱、DO binding 名稱與分塊大小，SDK PRD 和 CinderSync PRD 各寫各的。

## Consequences

- ＋ 四款遊戲可以刪掉各自的複本，修一次就四款都修好，第一個例子是 30 秒穩定歸零的退避。
- ＋ 從已經在生產環境跑的程式碼起步，不是從 PRD 空想。
- － 《元素使》原本刻意不用 nostr-tools、只用 `@noble`，連線池也是一次只連一座。
  改用 SDK 之後，這兩點都要改：前者依賴會變，後者要改成同時連多座。
- － AGPL 會傳染到使用它的遊戲；對要閉源散布的專案不適用。
- － 私有 repo 的 git 相依，遊戲的 CI 要有讀取權限，例如 deploy key 或 token。
