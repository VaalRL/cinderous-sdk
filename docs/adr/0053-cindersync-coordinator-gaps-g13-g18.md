# 0053. CinderSync 的協調器缺口 G13–G18：blocked 重新驗證、直連進度、退避重設、補送速率可調、各裝置已知的版本頭、衝突副本檔名解析

- 狀態：**已接受（Accepted，2026-10-04）**——G13、G14、G15、G16、G17(a)、G18 實作於 v0.43.0；**G17(b)「輕量的已收到回報」：使用者裁示 B0，不做**（2026-10-05，見 §G17(b)）
- 日期：2026-10-04
- 對應：CinderSync ARCHITECTURE §5 **G13–G18**（外掛 ADR 0021 P2P 直連、0022 各裝置的接收狀態、0023 衝突數依磁碟）。
  相關：本 repo ADR 0025（協調器、`FileRecord.peers`）、0026（P2P 批次串流、批次模式、`relayBulkPerHour`）、0027／0041（`blocked`）、
  0028（摘要對帳）、0029（塊數預算）、0045（`digestPolicy`、`whenSent`）、0048（`#freePath`）；CinderSync ADR 0019（**否決「每輪多送摘要」**）。

## Context

CinderSync 接上 P2P 直連與裝置清單之後，在外掛層繞過了協調器的六個缺口：

| 缺口 | 外掛的繞法 |
|---|---|
| G13 `blocked` 只在下一則經中繼送成功時清掉 | 佇列先經直連送完時，狀態列一直顯示「中繼不收檔案」，直到下一個修改 |
| G14 沒有 P2P 進度 | 收方以暫存大小、送方以通道送出的位元組估算 |
| G15 P2P 退避沒有公開的重設 | 把自己開的通道當成「對方找上門」交給協調器來重設退避 |
| G16 `relayBulkPerHour` 只能在建構時設定 | 取每小時 120 則折衷 |
| G17 沒有公開「各裝置已知的版本頭」 | `peer-receipts.ts` 觀察傳輸層訊息、自己記一份近似（看不到直連上的版本與名單訊息） |
| G18 沒有公開的衝突副本檔名解析 | `conflict-copies.ts` 以正規式拆開、再用 `conflictCopyName` 組回去比對；`#freePath` 的編號規則自己抄一份 |

## Decision

### §G13 佇列清空時清掉 `blocked`；下一則經中繼的照常驗證

`blocked`（`relay-rejects-files`／`relays-full`）的意思是「有東西卡在中繼上、而且重試沒用」。佇列清空（例如全部經直連送達每一台）時這句話不再成立，
所以 `#dropOutbox` 讓佇列變成空的那一刻，清掉 `blocked`、送出失敗（`state: 'error'`）與退避。

- **重新驗證＝下一則要經中繼的版本**：中繼還是不收 → 再標記一次、再發一次 `error`（`relay-rejects-files`／`relays-full`）；收了 → 不再標記。
  不另外發探測訊息（協調器不知道中繼是誰；探一次就是多一則 1060，與 CinderSync ADR 0019 的精神相違）。要主動知道中繼收不收，用既有的
  `watchRelayFileLimits`／`checkRelayAcceptsFiles`（NIP-11）與連線池的健康狀態（ADR 0044）。
- 佇列裡還有**別台沒收到**的版本（它不在線、直連送不到）：`blocked` 留著——那是真的卡在中繼上。
- 既有測試「中繼拒收時改走 P2P，佇列清空後仍是 `blocked`」的期望隨之改成「清掉」。

### §G14 直連傳輸進度

- **串流層**（`./transfer`）：`StreamHandler` 新增 `onProgress`（開始收一個檔案〔含續傳的起點〕、每段資料、每個檔案有結果之後；
  `entries`＝有結果的檔案數、`bytes`＝這個工作階段實際收到的資料位元組〔續傳不含已有的〕、`entry`＝正在收的檔案與已收位元組〔含已有的〕）
  與 `onSessionEnd(session, 'finished' | 'rejected' | 'dropped')`。同步呼叫、監聽丟例外不影響傳輸。送方原本就有 `SendStreamOptions.onProgress`。
- **協調器**：每條批次串流（送或收）一筆 `VaultTransferProgress`：`device`、`direction`、`mode`（`p2p-webrtc`／`relayed-websocket`）、
  `files`／`bytes` 的 `done` 與 `total`、`current`（正在傳的檔案 `fileId`、`path`、`size`、`done`）、`startedAt`／`updatedAt`、結束時 `ended`。
  - `transfers()`：進行中的（複本）；`on('progress')`：每筆最多每 `progressIntervalMs`（預設 250 ms，0＝每段都通知）一次，**開始與結束一定通知**；
  - `status().p2pBytes = { sent, received }`：這個協調器啟動以來經直連實際傳的資料位元組（只會增加；有 `peers` 才有）——外掛判斷「批次有沒有在前進」用。
    不放進 `status` 事件的去重簽章（否則每段資料都觸發 `status`）。
- 送方的總數是預估（對方已有的大檔內容會被略過、續傳只送剩下的、開始後才發現已經經中繼送到的項目會被跳過）；收方的總數是送方宣告的提示。

### §G15 `retryPeers(device?)`

重設 P2P 退避並立刻再試；省略＝名單上每一台；名單外、自己的 id 忽略；沒有 `peers` 時什麼都不做。內部就是既有的 `#scheduleP2P(device, true)`。

### §G16 `setRelayBulkPerHour(n)`

執行中改批次模式的中繼補送速率，立刻生效（清掉等待中的計時器、重新推一次）。**0＝暫停經中繼補送**（只走 P2P；調回來就繼續）——
這就是「有可用直連時自己暫停中繼補送」的開關，由應用決定何時開關（它比協調器更清楚直連是不是真的在前進）。小數取整數、負數與 NaN 丟 `RangeError`；
getter `relayBulkPerHour`。塊數預算（`relayLimits`）照樣守著。建構選項的行為不變（最小 1，避免既有的 0 變成「永遠不補送」）。

### §G17(a) 公開各裝置已知的版本頭與接收狀態（只用已經在收送的訊息）

- `peerStatus(device)`：`lastSeenAt`（最後一次收到它任何同步訊息〔中繼、直連〕或應用通報的時間）、`reportedAt`（最後一次收齊它的完整摘要）、
  `missing`（這台目前的版本裡〔含刪除〕，就這台所知它還沒有的檔案數：某個版本頭不被它已知的任何版本頭涵蓋——相同或是後代）、`files`、`known`
  （`known === 0 && reportedAt === null`＝完全不知道它有什麼，外掛顯示「還不知道」）。
- `peerStatuses()`：名單上（`peers.devices()`）與看過的每一台；`knownHeads(device)`：內部 `FileRecord.peers` 的唯讀複本。
- `notePeerActivity(device, at?)`：應用在協調器之外看到它有動靜（直連握手、名單訊息）時通報，只往後推。時間存在 meta（`ps`），跨重開保留。
- **新的知識來源（不多送訊息）**：直連批次的送達確認（`onEntryDone` 的 `ok`／`skipped`）——收方**併入之後**才回成功——現在記成對方已知的版本頭。
  既有來源不變：它送來的版本（`#notePeer`）、它的摘要。經中繼送出的版本不知道對方收到沒有，仍要等它的下一份摘要或以那個版本為父版本的新版本。
- **名單同步**：`NostrRosterSync` 新選項 `onMemberActivity({ pubkey, deviceId?, at })`——收到本機名單上有效成員寄的名單或搬家通知時交出，
  `at` 是內層 rumor 的寄出時間（外層被 NIP-59 往前推過，不用它；補拉到的舊事件交出的是當時的時間，不會把「最後一次看到」推到現在）。
  `openRosterEvent` 結果多 `sentAt`。外掛把它接到 `coordinator.notePeerActivity(deviceId, at)`。
- 經中繼收到的同步訊息沒有可信的寄出時間（`VaultSyncMessage` 不帶時間），`lastSeenAt` 用這台收到的時間——補拉到的舊訊息會算成「現在」。與外掛現況相同，記在限制裡。
- 寫 `FileRecord.peers` 的地方多了直連確認：它也用在修剪內容時保留「對方已知版本頭」的內容（可能的合併祖先）。記錄更準確只會讓保留的祖先更對，不影響正確性。
  沒有改「完整摘要裡沒有的檔案」的處理（不清掉舊記錄），避免改到修剪行為。

### §G17(b) 輕量的「已收到」回報——**使用者裁示 B0：不做**（2026-10-05）

只靠 (a)，另一台收到**經中繼**送來的修改之後，這台要等它下一次送摘要（啟動後第一輪、每天一次）、送來新版本，或兩台之間有直連，才會顯示「已收到」。
要更即時，**一定要多送某種訊息**；CinderSync ADR 0019 否決的是「每輪多送一整份摘要」，輕量回報是否可接受由使用者決定。選項：

| 選項 | 做法 | 成本 | 相容 |
|---|---|---|---|
| **B1 附在下一則本來就要送的訊息** | 版本／摘要／索取訊息加選用欄位 `acks: [fileId, head][]`（自上次以來收下的） | **零額外事件**；但收方沒有修改就永遠不送，等同 (a) | 舊版收端的 `validateVaultMessage` 重組物件、會略過未知欄位；線上編碼要確認不會被舊版拒收 |
| **B2 新訊息 `type: 'ack'`（kind 1060 內層）** | 收方收下別台的版本後去抖（例如 60 秒或一輪結束）送一則，只列剛收到的檔案與版本頭 | 有收到修改的那一輪，每位成員多 1 則 1060（傳輸層每位收件人一顆）；佔中繼配額但遠小於整份摘要 | 舊版收端 `validateVaultMessage` 回 null → 發 `invalid-message` 錯誤；要以名單能力宣告（ADR 0035 G9）只送給支援的成員 |
| **B3 ephemeral 回報（kind 2xxxx，不存）** | 同 B2，但用不會被存的 ephemeral kind | 只到達此刻在線的寄件人；不佔儲存配額，但佔事件速率預算（ADR 0043） | 同 B2；需要新 kind 與中繼放行 |
| B0 不做 | 只有 (a) | 無 | — |

**建議**：先 B0（(a) 已經涵蓋直連與「它再改同一個檔案」），若使用者要更即時再做 **B2＋能力宣告**、預設關閉、去抖到「一輪結束」，排程同步每輪最多多一則。
B1 看似免費，但「收方不改檔就永遠不回報」正是外掛要解決的情境，效果有限。

**使用者裁示（2026-10-05）：B0，不做。** 不新增任何訊息或欄位；「已收到」只靠 (a)（直連確認、對方的下一則版本或摘要、名單動靜）。
經中繼收到的修改，顯示「已收到」會延遲到對方下一次送摘要或新版本（見 Consequences）。日後若要更即時，另開 ADR 重議（B2＋能力宣告、預設關閉的建議仍在上表）。

### §G18 `parseConflictCopyName(path)` 與 `freePathCandidate(path, n)`（`./sync`，與 `conflictCopyName` 同一處）

- `parseConflictCopyName`：拆回 `original`、`label`（換掉禁用字元之後的）、`at`（UTC 毫秒，精確到秒）、`copyPath`（沒有編號的副本路徑）、`n`（≥ 2 的編號）；
  只認 `conflictCopyName` 組得出來的名稱（組回去比對），使用者自己取的「會議 (衝突-討論).md」、日期溢位、禁用字元、編號 0／1／前導 0 都回 null。
- `freePathCandidate`：協調器的 `#freePath` 改用它（行為不變），副檔名拆法與 `conflictCopyName` 共用。
- 「以磁碟為準的衝突清單」不做：協調器不掃描磁碟；外掛以 `parseConflictCopyName` 加自己的 Vault 監聽維護清單（外掛 ADR 0023 的做法），就不必再抄規則。

## 外掛（CinderSync）怎麼改用

| 缺口 | 拿掉 | 改用 |
|---|---|---|
| G13 | 「恢復後再寫一個檔案確認」的測試繞法 | 不必改程式；狀態列依 `status().blocked`（佇列清空就消失） |
| G14 | 收方看暫存大小、送方數通道位元組（`PeerSync` 的 `bytesSent`／`bytesReceived`、`progress()`） | `coordinator.on('progress')`／`transfers()` 顯示；`syncRound` 的停滯判斷改看 `status().p2pBytes.sent + received` |
| G15 | 把自己開的通道當成對方找上門 | `probe()` 打通之後呼叫 `coordinator.retryPeers(device)` |
| G16 | 固定 `RELAY_BULK_PER_HOUR = 120` | 有直連在前進時 `setRelayBulkPerHour(0)`，直連斷了或停滯時調回（例如 120） |
| G17 | `peer-receipts.ts` 的近似、`onMessage` 觀察 | `coordinator.peerStatus(device)`（`missing`、`lastSeenAt`、`reportedAt`、`known`）；`PeerSync` 的 `onActivity` 與名單同步的 `onMemberActivity` 接到 `notePeerActivity` |
| G18 | `conflict-copies.ts` 的正規式與 `FREE_SUFFIX` | `parseConflictCopyName(path)`（`@cinderous/client/sync`），清單維護留在外掛 |

## Consequences

- ＋ 外掛拿掉五個近似；進度、接收狀態與副本規則都只有 SDK 一份。
- ＋ 預設行為不變：沒有呼叫新 API 時，只有 G13（佇列清空後 `blocked` 消失）與 `status().p2pBytes` 這個新欄位看得出差別。
- － G13 清掉後，中繼若還是不收，下一個修改會再看到一次 `relay-rejects-files` 錯誤（每次「有東西卡住」各一次）。
- － G17 經中繼的回報仍然延遲（§G17(b) 裁示 B0、不做）；`lastSeenAt` 對補拉到的舊同步訊息算成收到的時間。

## 測試

`tests/sync/vault/peer-controls.test.ts`（G13 三種情境、G15、G16）、`tests/transfer/stream.test.ts`（收方進度、續傳起點、結束通知）、
`tests/sync/vault/p2p-progress.test.ts`、`tests/sync/vault/peer-status.test.ts`（含「收方不為回報多送任何訊息」）、`tests/pairing/roster-activity.test.ts`、
`tests/sync/merge3.test.ts`（G18）、`tests/sync/vault/coordinator.test.ts`（協調器產生的副本拆得回來）、`tests/sync/vault/relay-files.test.ts`（更新的期望）。
