# 0040. 中繼拒收訊息的詞元表與客戶端分類（ADR 0038 P0-R2／P0-C）

- 狀態：**已接受（Accepted）**——2026-09-30，實作 ADR 0038 決策 2、3 與 P0-R2、P0-C（v0.32.0）
- 日期：2026-09-30
- 相關：本 repo ADR 0027（檔案事件未啟用的偵測）、0032（CLOSED 不自動重訂）、**0038**（容量故障分類、P0 分階段）；
  Cinderous ADR-0373（CLOSED 不靜默）、ADR-0375（P0-R1 錨點版）、ADR-0376（P0-R2 錨點版）

## Context

ADR 0038 決策 2 定了格式「NIP-01 前綴＋英文詞元＋說明」，決策 3 定了 `duplicate` 改回 `OK true`。
要落地的是：詞元有哪些、各自對應什麼客戶端分類、放在哪裡當單一真實來源、舊中繼與第三方中繼怎麼相容。

## 決策

### 1. 詞元是共用常數，完整句子只在中繼

- `src/protocol/relay-reject.ts`：`RELAY_REJECT_TOKENS`（詞元）、`classifyRelayMessage()`、`classifyRelayClose()`、`relayRejectKindOf()`。
  不帶任何中文句子，只用連線池的應用不會把中繼的句子一起載入（主入口 minified 160.1 → 165.1 KB、gzip 56.4 → 58.1 KB，約 +3%，含連線池的新邏輯）。
- `src/relay/reject-messages.ts`：中繼送出的每一句（`REJECT`、`ADDRESSABLE_REJECT`、`OFFLINE_CEILING_REJECT`、`EXPIRED_REJECT`…）。
  Cinderous 錨點 `relay/src/reject-messages.ts` 逐字相同（PR #9 切換時客戶端看到的不變）。
- 契約測試 `tests/relay/reject-contract.test.ts`：逐句確認前綴、詞元、分類，並確認沒有沒人用的詞元；另外跑一輪 `RelayCore` 的拒收情境，確認送出的每一則都認得出詞元。

### 2. 詞元表

| 前綴 | 詞元 | 情況 | 客戶端分類（`kind`） |
|---|---|---|---|
| `blocked` | `too-many-tags` | tag 數 > 128 | `too-large` |
| `blocked` | `too-many-recipients` | `p` > 16 | `too-large` |
| `blocked` | `too-large` | 事件 > 256 KB、檔案塊 > 200 KB、可尋址單顆超過上限 | `too-large` |
| `blocked` | `not-allowed` | 白名單外的作者 | `policy` |
| `blocked` | `kind-disabled` | kind 被政策停用 | `policy` |
| `blocked` | `files-disabled` | 檔案事件未啟用（句子保留 `MAX_FILE_MB`，ADR 0027） | `policy` |
| `blocked` | `quota` | 可尋址：每 (作者, kind) 位址數滿、每作者總量滿（兩句說明不同） | `quota` |
| `blocked` | `ceiling` | 嚴格平面 DO 天花板滿（離線留言、可尋址各一句） | `ceiling` |
| `blocked` | `stale` | 可尋址：比這個位址現有的舊 | `stale` |
| `invalid` | `bad-signature` | 簽章錯 | `invalid` |
| `invalid` | `clock-skew` | 時戳超出時鐘窗 | `invalid` |
| `invalid` | `expired` | 事件自帶的 NIP-40 `expiration` 已過（離線、可尋址） | `invalid` |
| `invalid` | `too-large` | `NOTICE`：單則訊息 > 384 KB；`CLOSED`：訂閱存不進 512 KiB | `too-large` |
| `invalid` | `relay-tag` | NIP-62 清除請求的 `relay` tag 不是本站 | `invalid` |
| `invalid` | `malformed` | `NOTICE`：解析不了的客戶端訊息 | `invalid` |
| `rate-limited` | `events` | 每把公鑰每分鐘事件數 | `rate-limited` |
| `rate-limited` | `messages` | 每連線每分鐘訊息數（`NOTICE`＋1008 關閉） | `rate-limited` |
| `rate-limited` | `ip` | 每 IP 每秒訊息數（`NOTICE`＋1008 關閉） | `rate-limited` |
| `rate-limited` | `subscriptions` | 每連線訂閱數（`CLOSED`） | `rate-limited` |
| `restricted` | `scope` | 訂閱範圍不合（`CLOSED`，嚴格平面中文、車道英文） | `restricted` |
| `restricted` | `not-allowed` | 白名單外的人認證（AUTH 的 `OK`＋4003 關閉） | `restricted` |
| `restricted` | `too-many-connections` | 同一把公鑰連線過多（AUTH 的 `OK`＋1008 關閉） | `restricted` |
| `restricted` | `self-only` | 清除別人的資料（NIP-62） | `restricted` |
| `auth-required` | `nip42` | 未認證就寫或訂閱 | `auth-required` |
| `auth-failed` | `no-challenge`／`bad-auth`／`relay-tag`／`too-old` | AUTH 事件被拒（Cinderous 自己的前綴，沿用） | `restricted` |
| `pow` | `difficulty` | PoW 不足 | `pow` |
| `duplicate` | `seen` | 重放窗內重複（**`OK true`**） | `duplicate`（＝收下） |
| `error` | `internal` | 內部例外（`NOTICE`） | `error` |
| `error` | `resubscribe` | 訂閱在 DO 重啟後遺失、或一時存不住（`CLOSED`） | `error`（客戶端重訂） |

`kind` 的「可重試」「換座有用」沿用 ADR 0038 M1 的表（`relayRejectKindOf`）；`timeout`、`disconnected`、`unknown` 是連線池自己的分類。

**附帶條件的收下與通知**（`warning:` 前綴，`RELAY_WARNING_TOKENS`；SDK ADR 0042）：

| 前綴 | 詞元 | 情況 | 客戶端分類（`kind`） |
|---|---|---|---|
| `warning` | `borrowed` | `OK true "warning: borrowed: <秒>: …"`：收進溢位帶（ADR 0039） | `borrowed`（即時送達、不算耐久收下） |
| `warning` | `near-full` | `OK true "warning: near-full: <級>: …"`：這一類資料的空間已達那一級（粗分級） | `near-full`（收下、耐久；健康狀態的軟標記） |
| `warning` | `dropped` | `NOTICE "warning: dropped: <則數>: <since>: <until>: …"`：寄給你、還沒送到的留言被刪了（EOSE 之前） | 不是拒收（`parseDroppedNotice`、`onRelayDropped`） |

**刻意沒有改的**：車道升級被拒的 `NOTICE`（`unknown relay path…`、`invalid app lane…`、`rate-limited: too many new connections…`）與關閉原因。
它們是 Cinderous 開發者文件〈Error messages〉逐字列出的契約（「NOTICE starts with …」），第三方應用可能照字比對；
客戶端改以關閉碼（1008＋原因）分類，`classifyRelayMessage` 也認得這幾句舊文字。

### 3. 解析規則

1. 冒號前的第一個單字（小寫、`[a-z][a-z0-9-]*`）是前綴；再下一個同樣形狀、後接冒號的是詞元。說明文字可以是任何語言。
2. 分類先看前綴（NIP-01／NIP-42 的標準前綴，加上 `mute`、`unsupported`、Cinderous 的 `auth-failed`）；前綴是 `blocked` 或 `invalid` 時，
   `too-large`／`too-many-*`／`quota`／`ceiling`／`stale` 這幾個詞元會覆寫分類。其他詞元只是資訊。
3. 第三方中繼沒有詞元：`blocked: you are banned` 分成 `policy`。它若剛好寫了 `blocked: quota: …` 也會被當成 `quota`——可以接受，意思相同。
4. 舊中繼的句子照樣認得：`blocked:`＋`MAX_FILE_MB` 是 `files-disabled`；`error:`＋`please resubscribe` 是 `resubscribe`；舊的可尋址那一句沒有詞元，分成 `policy`。

### 4. 可尋址被拒拆開

`OfflineStore` 加**選用**方法 `putAddressableResult(event, nowSec)`，回 `{ ok: true }` 或 `{ ok: false, reason }`，
`reason` 是 `stale`／`too-large`／`address-quota`／`byte-quota`／`expired`／`ceiling`。`MessageStore` 與 `SqlMessageStore` 都實作，
`putAddressable()`（boolean）改成它的 `.ok`，行為逐位元不變。`RelayCore` 有這個方法就依原因回對應的句子；
只實作 boolean 的自訂 store 回舊句子 `blocked: 取代事件遭拒（配額/大小/較舊）`（`ADDRESSABLE_REJECT_GENERIC`）。

### 5. `duplicate` 改回 `OK true`，以及重放快取

- 重放窗內再送同一顆：`OK true "duplicate: seen: 事件重複"`，不扇出、不寫庫（第一次已經做過）。
- 前提是「留在重放快取裡的都真的收下過」：v0.31.1 已讓記入之後的每一種拒收都拿掉它；本版再補一個漏洞——
  **store 丟例外**（SQLite 滿了、DO 被重設）時外層圍籬回 `NOTICE error: internal:`，以前這顆會留在快取裡，重送只拿到 `duplicate`；
  現在拿掉（`RelayCore.admit` 包在 try/catch 裡）。
- 客戶端兩種都認：舊中繼的 `OK false "duplicate:"` 與新的 `OK true` 都算收下、不回報拒收。

### 6. 客戶端（P0-C）

- `PublishResult.rejected[]` 加 `kind`、`retryable`、`tryOtherRelays`、`token`（型別上是選用：自訂 `RelayTransport` 不必給，`classifyPublishRejection()` 補回）。
- `SocketLike` 的 `close` 事件可以帶 `code`／`reason`（瀏覽器與 `ws` 都有）：1008 `rate-limited`＝限速踢線，進行中的發布以 `rate-limited` 結案、
  重連直接用最長退避；4003＝`restricted`；1008 `too-many-connections`＝`restricted`；沒有關閉碼＝網路斷線（照舊）。
- `onRelayReject(url, rejection)`：每一座的 `OK false`（不含 `duplicate`）、`CLOSED`、帶前綴的 `NOTICE`、帶關閉碼的斷線，`source` 區分來源。
  **部分拒收**從這裡看得到。
- 私訊 `SendOutcome` 加 `accepted`／`rejected`（給對方那一份）；私訊、Vault 傳輸層、名單同步、`PeerNode` 加 `onPublishRejected(report)`。
  成功判定不變（至少一座收下）；`minAccepted` 是 P1。`publishRejections()` 不含 `not connected`（那一座根本沒送到）。
- 常駐訂閱被 `CLOSED`：**修改 ADR 0032**——詞元是 `resubscribe` 時對那一座重訂（接續游標），同一訂閱同一座 30 秒內只一次，避免中繼一直存不住時變成迴圈；
  `auth-required` 照舊在認證後補送；其他（`scope`、`too-large`、`subscriptions`…）不重訂，照舊經 `onRelayProblem`，並多經 `onRelayReject`。
- `isFileEventsDisabledReason()` 改用分類（`blocked` 前綴＋`files-disabled` 詞元，舊句子由第 3 節第 4 點認得）。
- 新檔 `src/publish-rejections.ts`：`./pairing`、`./sync/vault` 子路徑用得到分類，但不能把連線池執行期拉進來（子路徑測試）。

## Consequences

- ＋ 應用拿得到結構化的拒收原因與部分拒收；配額、天花板、較舊、太大不再混成同一句。
- ＋ 被 DO 重啟弄丟的常駐訂閱會自動回來（Cinderous ADR-0373 的 `CLOSED` 以前只有應用自己處理才有用）。
- ＋ `duplicate` 與 NIP-01 一致；store 例外不再造成「重送只拿到 duplicate」的靜默遺失。
- － `PublishResult.rejected` 的元素多了欄位：以 `toEqual({ url, reason })` 比對的測試要改。
- － 詞元成為契約，改詞元要兩個 repo 一起改並過契約測試；錨點要部署才會帶詞元（舊錨點照樣以前綴分類）。
- － Cinderous App v0.0.18 的外送匣只看前綴，不受影響，也還用不到詞元（見 Cinderous ADR-0376、0377）。
