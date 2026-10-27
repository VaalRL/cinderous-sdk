# 0011. 多裝置同步：快照與檔案塊照搬 Cinderous，補三方合併、墓碑、秒級水化與推播介面

- Status: Accepted
- Date: 2026-09-27
- 相關：
  - SDK：ADR 0007、0009、0010；PRD 2.4、2.5、2.6
  - Cinderous：ADR-0071（加密雲端快照）、ADR-0162（檔案塊）、ADR-0224（墓碑）

## Context

PRD 2.4 到 2.6 描述的是「兩台裝置從不同時在線，也能同步」。其中 Cinderous 已經有的：

| 模組 | 內容 |
|---|---|
| `snapshot.ts` | kind 30078，加密給自己，`d` 是裝置 id，30 天 |
| `file-relay.ts` | kind 1060，每塊 48,000 B，NIP-59 |
| `sync.ts` | `DeviceSyncState`：訊息 id 去重、可變狀態以後寫者為準（LWW），可交換 |
| `or-set.ts` | 集合的合併，含墓碑 |

Cinderous 沒有的：

- 三層分流的判斷；
- 行級三方合併（diff3）與衝突副本命名；
- 檔案墓碑的 30 天清理與「沉睡裝置隔離」；
- 手機喚醒時的快速水化與背景省電；
- 推播介面。

## Decision

### 1. 照搬進 `@cinderous/client/sync`

`snapshot`、`file-relay`、`sync`、`or-set` 原樣搬來，測試一起搬；Cinderous 改從 SDK 轉出，比照 ADR 0007。

`file-relay` 原本從 Cinderous 的 `constants.ts`（App 的 kind 總表）取 `FILE_WRAP`／`FILE_CHUNK`。搬到 SDK 後，這兩個常數就定義在 `file-relay.ts` 裡，並由 Cinderous 的測試釘住：兩邊的數字必須一致。

### 2. 三層分流 `classifyPayload(bytes)`

| 大小 | 走哪一層 |
|---|---|
| ≤ 256 KB | 快照（kind 30078） |
| ≤ 16 MB | 檔案塊（kind 1060） |
| 更大 | `p2p`：等兩台同時在線時用 `PeerNode` 直傳 |

門檻直接取中繼與檔案塊的常數（`ADDRESSABLE_MAX_BYTES`、`FILE_CHUNK_BYTES × FILE_CHUNK_MAX_TOTAL`），不另抄一份數字。

⚠ 快照上限要扣掉加密與 JSON 的膨脹，所以判斷用的是「加密後大小的估計」，不是明文大小。

### 3. 行級三方合併 `merge3(base, local, remote)`

- 以行為單位，用 Myers diff 算出「共同祖先 → 本機」與「共同祖先 → 遠端」的差異。兩邊改到不重疊的區塊就自動合併。
- 兩邊改了同一塊、而且改得不一樣，就是衝突。回傳衝突區塊，交給 App 的衝突解決 UI（PRD 2.6.2）。
- SDK 提供：
  - 「拼接」用的衝突標記：`renderWithConflictMarkers`；
  - 衝突副本檔名：`conflictCopyName`，格式照 PRD 的 `[檔名] (衝突-[設備別名]-[時間戳]).md`。
- 兩邊做了一模一樣的修改，不算衝突。

### 4. 檔案墓碑

- 墓碑是 `{ path, deletedAt }`。檔案的修改時間比墓碑新就「自動復活」，否則視為已刪（PRD 的 LWW）。
- 合併墓碑時，同一路徑取較新的 `deletedAt`（可交換）。
- 超過 30 天的墓碑清掉（與快照壽命對齊）。
- **沉睡裝置隔離**：一台裝置離線超過 30 天才回來，它手上的墓碑可能已被別台清掉。這時它的變更先不合併，`isStaleDevice` 回 `true`，由 App 請使用者確認，避免已刪的檔案被舊機復活。

### 5. 秒級水化與省電 `FastHydrator`

- **喚醒時**：
  - App 先顯示本機快取（樂觀就緒，這是 App 的事）；
  - SDK 立刻用 `since` 發一次輕量查詢拉增量。
  - 🔴 `since` 要**往前退讓 NIP-59 的時間倒填窗**（`TIMESTAMP_JITTER_SECONDS`，兩天）。否則剛寄出、外層時間卻被倒填到兩天前的禮物包會被濾掉，而且是靜默漏訊（Cinderous ADR-0109 同一個坑）。
- **隱藏超過 15 秒**：主動 `pool.close()` 省電；回到前景就 `pool.connect()`。訂閱會由連線池自動補回。
- 可見性的來源用注入的（瀏覽器預設用 `document.visibilitychange`），測試與 React Native 可自己接。

### 6. 推播介面：預設關閉，只准送「空的喚醒訊號」

- 型別照 PRD 2.5.2。預設是 `disabled`（純隱私模式，完全靠喚醒時水化）。
- SDK **不實作** APNs 或 FCM 的註冊。那需要 App 自己的開發者帳號與原生程式碼，放在 SDK 裡只會是空殼。
- SDK 提供兩個工具：
  - `silentTicklePayload(provider)`：產生 PRD 規定的喚醒訊號，例如 iOS 的 `{"aps":{"content-available":1}}`；
  - `assertZeroKnowledgePush(payload)`：推播內容只要多了任何一個欄位（標題、內文、寄件人），就丟例外。

## Consequences

- ＋ 快照、檔案塊的格式與 Cinderous 相同，互相讀得懂。
- ＋ 三方合併、墓碑、水化、推播都是純函式或可注入的小元件，App 可以只挑需要的用。
- － 衝突解決的 UI、樂觀就緒、游標保護都是 App 的事，SDK 只提供資料。
- － 推播要 App 自己接平台，SDK 只守住「不准帶內容」這條線。
