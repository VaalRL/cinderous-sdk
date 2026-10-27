# 0038. 中繼資料上限造成的「靜默故障」：分類、回報與自動改用其他中繼（研究）

- 狀態：**已接受（Accepted）**——2026-09-30 使用者對〈待決事項〉7 項皆採建議（見〈決策〉）；P0-R1 已完成（v0.31.1）；P0-R2、P0-C 已完成（v0.32.0，詞元表見 ADR 0040）；**P1 已完成（v0.33.0，見 ADR 0041）**；**P2 已完成（v0.34.0，見 ADR 0042；錨點尚未部署）**
- 日期：2026-09-30
- 相關：本 repo ADR 0003（逐座探針）、0005（一次性查詢）、0013（存取控制）、0027（拒收分類成明確狀態）、0029（檔案車道、分頁、取最小值）、
  0031（跨外掛共用連線：建議不做）、0032（CLOSED 不自動重訂）、0035（補訂閱退讓）、0036（DocHost 共用 DO 的淘汰風險）、0037（一鍵部署參數）；
  Cinderous ADR-0366（車道、容量）、0367（見習保存、DO 天花板）、0371（檔案車道、REQ 位元組預算）、0372、0373（CLOSED 不靜默）
- 範圍：研究部分文中「現況」都以 v0.31.0（`b18841d`）的程式為準，行號是撰寫時的位置。P0-R1 的實作見〈P0-R1 實作紀錄〉，P0-R2／P0-C 見〈P0-R2／P0-C 實作紀錄〉與 ADR 0040；P1 見〈P1 實作紀錄〉與 ADR 0041；P2 見〈P2 實作紀錄〉與 ADR 0042。

## Context

ADR 0036 指出：官方錨點的 `/app/dochost` 是所有 DocHost 使用者共用的一顆 Durable Object，可尋址容量天花板 128 MB，
滿了就淘汰最快到期的資料；約 64 位重度使用者就會互相擠掉資料，**而被擠掉的人看不到任何錯誤**。
同一類問題不只在這裡：每作者可尋址配額、每收件人留言 FIFO、檔案車道 1 GiB 天花板、REQ 16 MB 位元組預算、保存期到期、速率限制斷線都有。

要回答的問題：這些失敗 SDK 能不能看到？看得到的，SDK 現在有沒有處理？看不到的，有什麼辦法讓它看得到？
看得到之後，SDK 能不能自動改寫到別座中繼？

## 研究結果一：故障分類

分兩類。**(a) 寫入當下就被拒**：中繼回了 `OK false`／`CLOSED`／`NOTICE`＋斷線，客戶端其實拿得到訊號，問題是有沒有用上。
**(b) 寫入成功之後才遺失**：中繼先回 `OK true`，之後才刪掉或讀不到，客戶端完全沒有訊號，這才是真正的靜默。

### 🔴 先講一個實際的缺陷：嚴格平面「滿了就拒收」其實回的是 `OK true`

Cinderous ADR-0367 §決策 2 的承諾是：嚴格平面不淘汰，滿了就回可診斷的 `OK false`，讓人看得到。
**可尋址事件做到了，離線留言沒有做到。**

- `SqlMessageStore.put()`（`src/relay/sql-message-store.ts:329–371`）撞到 `offlineMaxTotalBytes` 而且 `ceilingEvicts` 沒開時，回 `false`。
- `RelayCore.handleEvent()`（`src/relay/relay-core.ts:725`）寫的是 `this.opts.store?.put(event, this.now());`，**沒看回傳值**，接著無條件回 `OK true`，還照常扇出。
- 可尋址那一側（`relay-core.ts:721`）有看回傳值，會回 `OK false "blocked: …"`。

以 `dist/` 實測（`MessageStore`，`offlineMaxTotalBytes: 10_000`，不淘汰，五顆各約 3 KB 的 1059）：五顆都回 `OK true`，**只存了兩顆**。
嚴格平面的 `storeOptions` 對每顆 DO 設 `offlineMaxTotalBytes = 128 MB`（`src/relay/host-config.ts:447`），不淘汰（第 449 行只有車道開）。
所以一顆嚴格平面 DO 的離線留言滿了之後，**每一則新的私訊、Vault 訊息、名單更新都會回 `OK true` 然後不見**；
寄件端以為送達，收件端永遠收不到，站方也看不到錯誤。Cinderous 錨點的 `relay/src/relay-core.ts:648` 是同一行，同一個缺陷。
`put()` 另一個回 `false` 的情況（事件自帶的 `expiration` 已經過了）也一樣被當成成功，這一種無害。

它不在本研究原本列的清單裡，但它讓 (a) 類變成 (b) 類，而且發生在最不該發生的平面。建議不等本 ADR 其他部分，先單獨修（見〈建議方案〉P0-R1）。

### (a) 寫入當下就被拒：中繼的訊號與 SDK 的處理

中繼端的訊號（SDK 中繼，`src/relay/relay-core.ts`；錨點相同）：

| 情況 | 中繼回什麼 | 位置 |
|---|---|---|
| tag 數 > 128、`p` > 16、事件 > 256 KB | `OK false "blocked: …"` | `relay-core.ts:628–636` |
| 簽章錯、時戳超出時鐘窗 | `OK false "invalid: …"` | `:638–669` |
| 白名單外的作者、kind 被政策停用 | `OK false "blocked: …"` | `:651–658` |
| 重放窗內重複 | `OK false "duplicate: 事件重複"`（NIP-01 的範例是 `OK true "duplicate: …"`，見下） | `:674–676` |
| 每把公鑰每分鐘 120 則 | `OK false "rate-limited: …"` | `:687–691` |
| 檔案事件未啟用、檔案塊 > 200 KB | `OK false "blocked: 檔案事件未啟用（MAX_FILE_MB）"`／`"blocked: 檔案塊過大"` | `:702–709` |
| PoW 不足 | `OK false "pow: 需要難度 N"` | `:713–716` |
| **可尋址：每 (作者, kind) 位址數、單顆大小、每作者 8 MB／2 MB、比現有的舊、已過期、嚴格平面天花板滿** | 全部是同一句 `OK false "blocked: 取代事件遭拒（配額/大小/較舊）"` | `:721–723`；判斷在 `sql-message-store.ts:374–427` |
| 未認證就寫（嚴格平面） | `OK false "auth-required: …"`＋重發挑戰 | `:428–430` |
| 單則訊息 > 384 KB（解析前） | **只有** `NOTICE "invalid: 訊息過大"`，沒有 `OK` | `:420–422` |
| 每 IP 每秒上限、每連線每分鐘 240 則 | `NOTICE "rate-limited: …"`＋以 1008 關閉 | `:390–410` |
| 白名單外的人認證、同一把公鑰連線過多 | `OK false "restricted: …"`（AUTH 的 OK）＋以 4003／1008 關閉 | `:489–510` |
| 車道升級：未知路徑、壞車道名、每 IP 升級限速 | 接受後送 `NOTICE`，以 1008 關閉 | `src/relay/worker.ts:285–307` |
| 訂閱範圍不合、訂閱數上限 | `CLOSED "restricted: …"`／`"rate-limited: 訂閱數已達上限"` | `relay-core.ts:439–454, 590–593` |
| 訂閱存不住、DO 重啟後遺失 | `CLOSED "invalid: … 512 KiB"`／`"error: … please resubscribe"` | `worker.ts:599–664` |
| 內部例外 | `NOTICE "error: 內部錯誤"`，沒有 EOSE | `relay-core.ts:412–415` |

SDK 客戶端的處理（`src/relay-pool.ts` 與使用它的模組）：

| 訊號 | 現況 | 有沒有丟掉訊號 |
|---|---|---|
| `OK false` | `publish()` 把每座的原因字串原樣放進 `PublishResult.rejected[].reason`（`relay-pool.ts:298–354`）；**不分類**，也**不經過** `onRelayProblem` | 字串留著，但沒有結構。只有 `auth-required` 被特別處理（認證後重送，`:771–780`） |
| `OK false "duplicate:"` | 算成拒收 | 🟡 誤判：中繼其實已經有這顆 |
| 部分中繼拒收 | 私訊（`src/dm.ts:262–272`）、Vault 傳輸層（`src/sync/vault/nostr-transport.ts:232–239`）、名單同步（`src/pairing/roster-sync.ts:119`）、`peer-node`（`src/peer/peer-node.ts:386`）都只看「**有沒有至少一座**收下」 | 🔴 丟掉：三座裡兩座因配額拒收，應用照樣回成功；冗餘默默少了，應用不知道 |
| 所有中繼都拒收 | 私訊回 `ok: false`＋原因串接；Vault 只認得一種原因（`isFileEventsDisabledReason`，ADR 0027）→ `status().blocked = 'relay-rejects-files'`；其他原因一律「沒有中繼接受」＋指數退避 | 🟡 部分：配額、天花板、太大、限速全部混成同一個一般錯誤，退避策略一樣 |
| `NOTICE` | 交給 `onRelayProblem(url, reason)`（`:810–812`） | 🟡 看得到文字，但和哪一則發布無關；超過 384 KB 的事件只收到 NOTICE，`publish` 等到逾時才以 `timeout` 結案 |
| 斷線的關閉碼與原因（1008 rate-limited、4003、too-many-connections） | `SocketLike` 的 `close` 監聽只拿 `{ data? }`（`:17–26, 571–577`），**關閉碼與原因沒有讀**；進行中的發布一律以 `disconnected` 結案（`:622–627`） | 🔴 丟掉：「被限速踢掉」和「網路斷了」看起來一樣，重連退避也一樣 |
| `CLOSED`（非 auth-required） | 一次性查詢當作這一座結束；常駐訂閱只交給 `onRelayProblem`，**不重訂**（ADR 0032） | 🟡 看得到，但常駐訂閱在那一座就此停止，應用通常沒接 `onRelayProblem` |
| 事前宣告（NIP-11） | Vault 讀 `cinder_accepts_files`、單檔上限、每收件人塊數、保存期，多座取最嚴（`relay-check.ts` 的 `relayFileLimits`，ADR 0029） | 只有 Vault 用；可尋址配額（v0.31 新增欄位）沒有讀取工具 |

### (b) 寫入成功之後才遺失：真正的靜默

| 失敗 | 觸發條件 | 位置 | 誰受害 | 誰拿得到訊號 |
|---|---|---|---|---|
| **車道可尋址天花板淘汰** | 車道 DO 可尋址總量 > 128 MB（`DO_ADDRESSABLE_MAX_BYTES`），`ceilingEvicts: true` 只在車道開 | `sql-message-store.ts:462–486`（依到期時間由近到遠刪）；`host-config.ts:446–449` | 同一顆 DO 裡**最快到期的別人**（DocHost：最久沒更新的使用者） | 沒有人。寫的人拿到 `OK true`，被刪的人不在線 |
| **車道離線留言天花板淘汰** | 車道 DO 離線總量 > 128 MB（檔案車道 1 GiB） | `sql-message-store.ts:435–454`；`host-config.ts:447, 460` | 最快到期的別人的留言、檔案塊 | 沒有人 |
| **嚴格平面離線天花板**（上面的缺陷） | 嚴格 DO 離線總量 > 128 MB | `relay-core.ts:725` | **新寫入的那一則** | 應該是寫的人，但被 `OK true` 蓋掉 |
| **每收件人 FIFO** | 同一位收件人名下聊天類 > 500 則（嚴格平面**也有**）；檔案塊 > 1,440 塊（檔案車道）／4,000 塊（企業） | `sql-message-store.ts:634–664`（`enforceCap`）；`host-config.ts:18, 444` | 收件人最舊、還沒領的留言 | 沒有人。寄件人不知道；收件人只看到最新的那些 |
| **保存期到期** | 離線預設 7 天（公用分片 2 小時）；可尋址 30 天（公用分片 2 小時），每次更新重算 | `effectiveExpiration`、`prune()`（`sql-message-store.ts:600–604`）；`host-config.ts:431–454` | 離線太久的收件人、太久沒更新的作者 | 事前可讀 NIP-11 `retention`／`cinder_addressable_ttl_sec`；**事件自帶的更長 `expiration` 會被默默夾短**，`OK true` 不說 |
| **REQ 被截斷** | 一次 REQ 所有 filter 合計 > 16 MB（`MAX_QUERY_BYTES`），或單一 filter > 1,024 筆 | `relay-core.ts:606–621`（預算用完就 `break`，照樣送 EOSE）；`sql-message-store.ts:575–598` | 讀的人拿不到較舊的那些 | 沒有訊號。1,024 筆有 NIP-11 `max_limit`；16 MB 沒有宣告。SDK 以「翻到空頁才停」處理（`src/sync/hydrator.ts:68–97`，ADR 0029） |
| **車道換 DO** | 已知租戶名單改了，車道換到別顆 DO | ADR 0036 §2 | 整條車道的舊資料 | 讀的人看到空的 |

(b) 類裡，**只有淘汰與 FIFO 會刪掉還在保存期內、而且作者仍在乎的資料**；到期是宣告過的契約，截斷是讀取問題（資料還在）。
下面的機制主要針對淘汰與 FIFO。

## 研究結果二：規範與社群慣例

- **NIP-01**：`OK` 的第 4 個參數在 `false` 時「必須是機器可讀的單字前綴＋`:`＋人讀訊息」；`true` 時可以是空字串，也可以帶訊息
  （規範範例：`["OK", id, true, "pow: difficulty 25>=24"]`、`["OK", id, true, "duplicate: already have this event"]`）。
  標準前綴：`duplicate`、`pow`、`blocked`、`rate-limited`、`invalid`、`restricted`、`mute`、`error`；`CLOSED` 範例另有 `unsupported`。
  `NOTICE` 沒有任何處理規則。⇒ **沒有「配額」或「儲存已滿」的標準前綴**；`OK true` 帶說明文字是合法的。
- **NIP-42**：`auth-required:`＝還沒認證；`restricted:`＝已認證但「這把金鑰不被允許，**或超出它的授權**」——後半句是規範裡最接近「配額」的語意。
- **NIP-11**：`limitation` 有 `max_message_length`、`max_subscriptions`、`max_limit`、`max_event_tags`、`max_content_length`、`min_pow_difficulty`、
  `auth_required`、`payment_required`、`restricted_writes`、`created_at_lower_limit`／`upper_limit`、`default_limit` 等；**沒有任何容量、配額、目前負載的欄位**。
  `retention` 在 2026-02 的精簡中已從主文件移除（本 SDK 仍輸出它，現存的實作仍會讀）。
- **NIP-65**（kind 10002）：作者公布自己的 write／read 中繼；發布到作者的 write 中繼與每位被標記者的 read 中繼；建議每類 2–4 座。
- **NIP-17**（kind 10050）：收件人公布收私訊的中繼；寄件端**只**發到那些中繼；沒有公布就不該寄。
- **NIP-77**（Negentropy）：客戶端與中繼以集合協調找出「誰缺哪些 id」，只交換 id 不傳事件——是大量讀回稽核的有效率做法，但本中繼不支援。
- 社群沒有「配額／淘汰通知」的 NIP 或通行慣例（搜尋 nostr-protocol/nips 的 issue／PR 未見；NIP-95 的討論提到沒有儲存配額預測）。
  現有生態的做法就是 NIP-65 的多中繼冗餘加上客戶端自己判斷。

來源：[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)、[NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md)（[修改紀錄](https://github.com/nostr-protocol/nips/commits/master/11.md)）、
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)、[NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)、
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md)、[NIP-77](https://github.com/nostr-protocol/nips/blob/master/77.md)、
[NIP-95 討論](https://github.com/nostr-protocol/nips/pull/345)。2026-09-30 讀取。

## 研究結果三：各機制的評估

| # | 機制 | 改哪裡 | 能不能補 (b) | 成本 | 隱私 | Nostr 相容 | 結論 |
|---|---|---|---|---|---|---|---|
| M1 | 客戶端把 `OK`／`CLOSED`／`NOTICE`／關閉碼**分類成結構化錯誤**，經 `publish` 結果與事件回報 | SDK 客戶端（＋中繼把訊息講清楚） | 否，只處理 (a) | 幾乎零 | 無影響 | 完全相容（外站只剩標準前綴那一層） | **做（P0）** |
| M2 | 修嚴格平面 `OK true` 缺陷；可尋址拒收分成不同原因 | SDK 中繼 → 錨點 | 把一種 (b) 變回 (a) | 零 | 無 | 相容 | **做（P0）** |
| M3 | 每座中繼的健康狀態＋依分類改用其他中繼 | SDK 客戶端 | 間接（配合 M4） | 多連線的成本（ADR 0031） | 多一座中繼看得到元資料 | 相容；可配 NIP-65／17 | **做（P1）** |
| M4 | **讀回稽核**：寫入後或定期以 `authors`＋`#d`／`ids` 逐座查回 | SDK 客戶端 | **可以**，是唯一只改客戶端就能補 (b) 的辦法 | 每次稽核一個 REQ，讀 N 列 | 有限制，見下 | 相容 | **做（P1），只用在作者看得到的資料** |
| M5 | `OK true "warning: …"` 預警接近天花板 | 中繼 | 預防性：讓寫的人在淘汰前改寫別處 | 零額外訊息 | 洩漏 DO 使用率的粗略分級 | NIP-01 允許 `true` 帶訊息；外站忽略 | 可做（P2），分級要粗 |
| M6 | NIP-11 公布**即時**容量壓力 | 中繼 | 預防性 | 每次讀 NIP-11 要查 DO；會被快取 | 公開整顆 DO 的使用量 | 非標準欄位 | **不做即時值**；只補**靜態**上限（P2） |
| M7 | 淘汰時對作者發 ephemeral「淘汰通知」 | 中繼 | 只對在線作者 | 中繼要簽事件、新 kind | 車道不做 AUTH 就無法私下送達 | 非標準 | **不做** |
| M8 | 淘汰時留**墓碑**／每收件人「丟棄計數」 | 中繼 | **可以**：讀的人知道「曾經有、被刪了」 | 每次淘汰多寫一列 | 墓碑透露的與原本相同；計數只給收件人本人 | 回報管道非標準 | 做計數（P2）；可尋址墓碑待定 |
| M9 | 共用 DO 內的**公平份額**：先拒寫入，而不是擠掉別人 | 中繼 | **把 (b) 轉成 (a)**——根本解之一 | 淘汰查詢多一個分組 | 無 | 相容 | 做（P2），以「保底份額」形式 |

### M1：前綴解析與結構化錯誤

建議的分類（`RelayRejectKind`）與它對後續動作的意義：

| 分類 | 來源 | 可重試？ | 換別座有用？ |
|---|---|---|---|
| `duplicate` | `duplicate:`（true 或 false） | — | **當成已收下** |
| `auth-required` | `auth-required:` | 認證後 | — |
| `restricted` | `restricted:`（白名單外、只能清除自己的） | 否 | 是 |
| `policy` | `blocked:` 的 kind 停用、檔案未啟用、白名單外 | 否（站方改設定才行） | 是 |
| `pow` | `pow:` | 挖夠再送 | 是 |
| `too-large` | `blocked:` 的事件／檔案塊過大、`NOTICE invalid: 訊息過大` | 否 | 看對方上限（NIP-11） |
| `quota` | 可尋址位址數、每作者總量 | 等自己的舊資料到期 | 是 |
| `ceiling` | DO 天花板滿（嚴格平面拒收；M2 修好後才會出現） | 等別人到期 | **是（主要的改用理由）** |
| `stale` | 可尋址比現有的舊 | 否 | 否（不是錯誤，別座多半也一樣） |
| `rate-limited` | `rate-limited:`、1008 `rate-limited` 關閉 | 退避後 | 可以，但別把量平移過去 |
| `invalid` | `invalid:` | 否 | **否**（是我們自己的錯，換哪座都一樣） |
| `error`／`timeout`／`disconnected`／`unknown` | 其他 | 退避後 | 是 |

- 第三方中繼只保證 NIP-01 的前綴，所以分類先看前綴，再看冒號後第一個**英文詞元**（只有 Cinderous／SDK 中繼會帶）。
  中繼訊息目前多半是中文句子，分類若靠比對中文字（像 ADR 0027 比對 `MAX_FILE_MB`）很脆弱。
  SDK 同時擁有中繼與客戶端，可以把詞元定成**共用常數**（單一真實來源），雙方都引用，加契約測試。
  建議格式：`blocked: quota: 可尋址位址已滿（64／kind）`、`blocked: ceiling: …`、`blocked: too-large: …`——
  外站只看得懂 `blocked`，我們的客戶端多拿一層。
- `duplicate` 要當成已收下：NIP-01 範例是 `OK true`，本中繼回 `OK false`。客戶端先相容兩種；中繼要不要改成 `true` 待決。
- 關閉碼：`SocketLike` 的 `close` 監聽改成可選的 `{ code?, reason? }`（瀏覽器與 `ws` 都有，舊的注入實作不給也行），進行中的發布以 `rate-limited` 結案，不是 `disconnected`。
- 回報：`PublishResult.rejected[]` 加 `kind` 與 `retryable`（只加欄位，舊用法不壞）；`onRelayProblem` 旁邊加結構化的 `onRelayReject(url, { kind, reason, eventId?, subId? })`。
- 部分成功要浮上來：私訊的 `SendOutcome`、Vault 傳輸層、名單同步至少要能回報「幾座收下、幾座因什麼拒收」，由 P1 的耐久性要求判斷夠不夠。

### M4：讀回稽核

- **能稽核什麼，受訂閱範圍限制**（ADR-0123、0366）：嚴格平面的 REQ 要帶 `#p`（只能是自己）或 `authors`；車道要帶標籤、`authors` 或自己的 `#p`。
  - ✅ **作者看得到的資料**：可尋址（DocHost `{kinds:[31438], authors:[pk], "#d":[…]}`、遊戲牌組、雲端快照 30078）、一般的作者事件。
  - ✅ **自己的收件匣**：`{ids:[…], "#p":[自己]}`（嚴格平面要先 AUTH）。私訊寄給自己的那一份也算。
  - ❌ **寄給別人的禮物包**（私訊、Vault 訊息、檔案塊）：外層作者是一次性金鑰，收件人不是自己，寄件人查不回。
    這一類只能靠**收件人端到端回報**——Vault 協調器的摘要／索取就是（ADR 0025、0029），私訊目前沒有。
- **要逐座查**：`pool.query` 把各座結果合起來，看不出哪一座少了。需要 `queryEach`（每座各自的結果與 EOSE／CLOSED）。
- **成本**：一次稽核＝每座一個 REQ（計費以進站訊息算，一次一則）＋讀 N 列（`ids`／`#d` 有索引）。DocHost 64 個桶一次查完約 64 列讀取，
  每天幾次遠低於免費額度（讀取 500 萬列／日）。
- **頻率**：寫入後立刻查回**沒有用**——天花板淘汰發生在「別人之後寫入」時，剛寫完一定還在。有意義的是：
  (1) 裝置啟動、回到前景時查一次；(2) 固定間隔（例如每 6–24 小時）；(3) 抽樣：只查最久沒更新的那幾個 `d`（它們最先被「最快到期優先」淘汰）。
- **發現遺失之後**：重送到那一座（它可能又會被擠掉）或改寫到別座（見 M3、下節），並把那一座標成 `ceiling` 一段時間。
- 隱私：稽核查的是自己已經公開寫過的位址，中繼原本就知道；多透露的只有「這個作者多久來查一次」。
- NIP-77 可以把「幾百個 id 逐一查」變成一次協調，但要中繼支援，列在最後。

### M5／M6：預警與 NIP-11

- `OK true "warning: ceiling: 92%"` 合乎 NIP-01（`true` 可以帶訊息），不認得的客戶端照舊當成功。只在超過門檻時帶，分級取粗（80％、95％），
  別讓人以寫入探測精確使用量。它對「寫的人」有用（可以提早改寫別處），對「會被擠掉的人」沒用——那個人不在線。
- 即時壓力放進 NIP-11 不划算：Worker 回 NIP-11 目前不碰 DO（`buildRelayInfo` 只讀設定），改成每次都查 DO 會多一次 DO 請求，
  而且客戶端與 CDN 會快取；還等於對全世界公開使用量。
- **靜態上限應該補進 NIP-11**：DO 天花板與策略（`cinder_ceiling_bytes`、`cinder_ceiling_policy: "evict" | "reject"`）、每作者可尋址總量、
  REQ 位元組預算，以及標準的 `max_event_tags`、`max_content_length`、`min_pow_difficulty`。讓客戶端**連線前**就知道這座是淘汰制。

### M7／M8：淘汰通知與墓碑

- 通知作者不可行：禮物包的作者是一次性金鑰，中繼不知道真正的寄件人；可尋址的作者知道，但車道不做 AUTH，無法私下送達，
  而作者離線時通知本身也存不住（它就是被擠出去的那種東西）。
- **每收件人丟棄計數**是便宜又有用的替代：`enforceCap` 或天花板淘汰刪掉某位收件人的留言時，把（收件人, 丟棄數, 最近一次時間）加一。
  收件人（嚴格平面已 AUTH）下次 `#p` 訂閱時，在 EOSE 前收到一則 `NOTICE "dropped: <subId> N since T"`，
  或擴充一個 Cinderous 專屬欄位。收件人因此知道「有東西沒收到」，可以向其他裝置索取（Vault）或提示使用者（私訊）。
  隱私：只給收件人本人。成本：每次淘汰多寫一列（淘汰本來就在寫）。
- 可尋址墓碑（kind, pubkey, d, 被刪的 id, 時間，保存一段時間）：讀者查 `#d` 時可以知道「這個桶在這一座被淘汰了」，
  據此向別座或別台裝置要完整狀態。問題是 NIP-01 沒有「查詢結果外的附註」管道，只能用 `NOTICE` 或非標準訊息；另寫一個 kind 會違反 filter 語意。
  價值中等，建議排在公平份額之後再看要不要做。

### M9：公平份額——把靜默刪除轉成看得見的拒收

「最快到期優先」在公用分片上是對的（見習資料、攻擊者先死，ADR-0367）；在**已知租戶車道**上，大家都是 30 天、每次更新就刷新，
它其實就是「最久沒更新的人先死」，而那個人不在線。

- 單純改成「滿了就拒收」：攻擊者可以塞滿之後讓所有人都寫不進去（車道不做 AUTH、金鑰不用錢）。
- 單純改成「用最多的人先淘汰」：攻擊者把資料拆到很多把金鑰，最大戶反而是誠實的重度使用者。
- **建議：保底份額**。每個作者在這顆 DO 裡有一份保底（例如 ceiling ÷ 預期使用者數，DocHost 可以取 512 KB–2 MB），
  保底內的資料**不會因為別人寫入而被淘汰**；超出保底的是「溢出」，天花板滿時先淘汰溢出（最快到期優先）；
  沒有溢出可淘汰時**拒收**，回 `OK false "blocked: ceiling: …"`。
  - 誠實使用者：只要在保底內，就不會被別人擠掉；超出保底的部分有可能被擠掉，但那部分是他自己的溢出。
  - 以大量金鑰攻擊：每把都在保底內，填滿後的效果是**新寫入被拒**——(a) 類、看得見、客戶端可以改用別座——而不是刪掉別人的資料。
  - 代價：保底讓總容量用不滿；淘汰查詢要多算每作者用量（`idx_addressable_pubkey` 已存在）。
- 這對可尋址是根本解；對禮物包離線留言不完全適用（外層作者是一次性金鑰，公平要以收件人計，而每收件人 FIFO 本來就是那樣）。
- 對 DocHost 真正的根本解仍是 ADR 0036 建議 A：中繼只存差異、帶期限，不存完整狀態；以及讓 DocHost 使用者以**自架站為主、錨點為輔**。

## 研究結果四：自動改用其他中繼的設計

### 現況的基礎

- `RelayPool.publish` 本來就是**同時發給所有開著的中繼**，訂閱與一次性查詢本來就**合併所有中繼**（ADR 0001、0005）。
  所以「多座同時寫入、多座合併讀取」已經是預設，缺的是：(1) 知道每座的結果是什麼意思；(2) 知道「夠不夠」；(3) 不夠時有備援可用；
  (4) 讀的人知道要去哪幾座讀。

### 建議的設計

1. **應用宣告耐久性要求**（新的選項，預設等於現況）：
   `durability: { minAccepted: number, standby?: string[] }`，可以依用途分開（私訊、Vault 訊息、可尋址狀態各一組）。
   `minAccepted` 預設 1（與現況相同）；DocHost、雲端快照這類「中繼上的唯一副本」建議 2。
2. **每座中繼的健康狀態**（`RelayHealth`）：依 M1 的分類記錄每座的最近結果，而不是一個分數：
   - `ceiling`／`quota` → 這一座對「這一類資料」標成**已滿**一段冷卻時間（例如 1 小時，或該類資料保存期的一小段），期間不再往那裡寫這一類；
   - `policy`／`restricted`／`too-large` → 對這一類標成**不適用**，直到設定改變（重新讀 NIP-11 或重新連線）；
   - `rate-limited` → 退避，時間至少到對方的計數窗結束（每分鐘窗 60 秒、每 IP 每秒窗 1 秒）；
   - `invalid` → 不改用、不重試，直接回報給應用（這是我們的錯）；
   - `error`／`timeout`／`disconnected` → 照現有退避。
3. **改用別座**：一次發布的有效收下數（`accepted` 加上 `duplicate`）低於 `minAccepted`，而且拒收是「換別座有用」的分類時，
   延遲連上 `standby` 裡的下一座（ADR 0031 的延遲連線），只把這一則補發過去；一段時間沒用到再斷線。
   讀回稽核（M4）發現某座遺失時走同一條路。
4. **所有中繼都滿時不能風暴式重試**：與 ADR 0027 §4 同一個模式——狀態轉換時回報**一次**（例如 `status().blocked = 'relays-full'`），
   之後只以最長退避偶爾試一次，任何一座收下就恢復。每類資料一個全域的重試預算，不因中繼數量放大。
5. **讀的人要知道去哪讀**：改寫到備援之後，只有「會去讀那一座」的人拿得到。
   - 作者自己的資料（DocHost、牌組、快照）：以 NIP-65 kind 10002 公布 write 中繼，**備援要事先列在清單上**（清單 2–4 座，與 NIP-65 建議一致），
     讀的時候合併清單上所有中繼。事後才臨時改寫到清單外的站，別的裝置找不到。
   - 私訊：寄件端應該發到收件人的 NIP-17 kind 10050 中繼；目前 `DmClient` 用的是自己的連線池。
   - Vault：裝置名單（ADR 0028）已是成員之間共享的簽章資料，可以帶每台裝置的收件中繼；或直接要求所有裝置使用同一份 `relayUrls`。
6. **與 `loadRelayFileLimits` 取最小值的關係**：取最小值的前提是「每一則都送到每一座」。加入備援後，限制應該對**這一類資料實際的寫入集合**取最小值：
   備援一接上就把它的 NIP-11 併進來重算，被標成已滿或不適用的那座暫時不列入。補送預算（`relayChunkBudget`）照舊以最嚴那座計，最保守。

### 與各使用方的整合

| 使用方 | 要做的事 |
|---|---|
| CinderSync、Coffice（Vault 協調器） | `relayUrls` 多座已經支援；加 `standby` 與 `minAccepted`；`status()` 帶每座健康狀態與 `blocked: 'relays-full'`；FIFO 擠掉的由摘要／索取補回（已有），再加上 P2 的丟棄計數即可主動觸發索取 |
| DocHost | 自己的客戶端不一定用 `RelayPool`：SDK 匯出獨立的 `classifyRelayMessage()` 與 `auditAddressable()`（逐座查 `#d`、回每座缺哪些桶）；建議以自架站為主、錨點為輔，`minAccepted: 2`；配合 ADR 0036 建議 A |
| 遊戲 | 大廳、信令是 ephemeral，只受限速影響，分類後可以正確退避；牌組、房間歷史是可尋址／無收件人事件，可以用讀回稽核 |
| Cinderous App（私訊） | 部分拒收要能顯示；目標中繼改讀 kind 10050；嚴格平面天花板缺陷修好之前，私訊可能「顯示已送出、對方收不到」 |

## 建議方案（分階段）

| 階段 | 內容 | SDK 客戶端 | SDK 中繼 | Cinderous 錨點 | 工作量（粗估） | 風險 |
|---|---|---|---|---|---|---|
| **P0-R1** ✅ v0.31.1 | 嚴格平面離線天花板回 `OK false "blocked: ceiling: …"`、不扇出；已過期回 `OK false "invalid: …"` | — | `relay-core.ts:725` 看 `put()` 回傳值；測試對兩個 store | **要部署**（或隨 PR #9） | 半天 | 低；滿了之後寄件端開始看到失敗（本來就是真相） |
| **P0-R2** ✅ v0.32.0 | 拒收訊息加穩定的英文詞元（`quota`、`ceiling`、`too-large`、`stale`…），可尋址那句拆開；詞元做成中繼與客戶端共用的常數；`duplicate` 改回 `OK true`（決策 3，本階段做） | 引用常數 | `relay-core.ts`、`sql-message-store.ts`／`message-store.ts` 的 `putAddressable` 要回原因而不只是 `boolean`（介面變更） | 要部署 | 1 天 | 低到中：`OfflineStore` 是公開介面，要保留 `boolean` 相容；`isFileEventsDisabledReason` 的契約（含 `MAX_FILE_MB`）要保留 |
| **P0-C** ✅ v0.32.0 | `classifyRelayMessage()`；`PublishResult.rejected[].kind／retryable`；`duplicate` 當收下；讀關閉碼；`onRelayReject`；私訊、Vault、名單回報部分拒收 | ✅ | — | — | 1–2 天 | 低；只加欄位。對外站只能分到 NIP-01 前綴那一層 |
| **P1** ✅ v0.33.0 | `RelayHealth`、`durability { minAccepted, standby }`、延遲連線備援、全滿時一次回報＋長退避；`queryEach`；`auditAddressable`／收件匣稽核；NIP-65 10002 與 NIP-17 10050 的讀寫小工具；Vault 協調器與 `relayFileLimits` 接上 | ✅ | — | — | 4–6 天 | 中：連線數增加（成本、ADR 0031）、更多中繼看得到元資料、使用者自己的中繼多存一份 |
| **P2** | NIP-11 補靜態上限與天花板策略；`OK true "warning: ceiling: …"` 粗分級；每收件人丟棄計數與回報；已知租戶車道的保底份額淘汰；（之後）可尋址墓碑、NIP-77 | 讀新欄位、處理警告與丟棄計數 | ✅（新增一張計數表、淘汰查詢改寫） | **要部署**；schema 遷移 | 4–7 天＋部署驗證（`wrangler dev`） | 中：DO schema 遷移、淘汰語意改變（公平份額會讓部分寫入從「成功後被刪」變成「直接被拒」，這正是目的，但使用方要有 P1 才接得住） |

順序的理由：P0 讓「已經拿得到的訊號」不再被丟掉，並修掉唯一一個「中繼說謊」的地方；沒有 P0，P1 的改用判斷無從做起。
P1 只改客戶端就能補上大部分 (b)（作者看得到的資料靠讀回稽核，禮物包靠收件人端到端回報）。
P2 要動錨點並做 schema 遷移，放最後，而且要在使用方有了 P1 之後才開公平份額，否則「改成拒收」只是把問題換成另一種失敗。

## 決策（2026-09-30，使用者核准）

〈待決事項〉7 項全部採建議：

1. **先單獨修 P0-R1**，而且先於 Cinderous PR #9（錨點改用 SDK 中繼）：錨點先在自己的 `relay/` 修掉、部署，
   PR #9 切換時客戶端看到的拒收訊息逐字相同。部署仍須使用者另行同意。
2. **詞元格式採「NIP-01 前綴＋英文詞元＋說明」**：`blocked: ceiling: …`、`blocked: quota: …`、`invalid: expired: …`；
   說明文字可以是中文（客戶端只看前兩層）。
3. **`duplicate` 改回 `OK true`**（對齊 NIP-01 範例）——P0-R1 這一批**不做**，列入 P0-R2。
4. **已知租戶車道採保底份額**，每作者保底約 2 MB（P2）。
5. **預警只做粗分級**（例如 80％、95％），不公開精確用量（P2）。
6. **`minAccepted` 預設 1**；只有應用提供了備援清單（`standby`）時，SDK 才自動延遲連上備援（P1）。
7. **中繼清單 NIP-65（10002）與 NIP-17（10050）兩者都支援**，由應用決定要不要發布（P1）。

## P0-R1 實作紀錄（v0.31.1）

- `RelayCore.handleEvent` 改看 `store.put()` 的回傳值。`put()` 回 `false` 只有兩種原因，中繼先自己判斷過期、剩下的就是天花板：
  - 事件自帶的 NIP-40 `expiration` 已經過了 → `OK false "invalid: expired: 事件已過期（NIP-40），未保存也未轉送"`（`EXPIRED_REJECT`）；
  - 這顆 DO 的離線天花板滿了而且不淘汰（嚴格平面）→ `OK false "blocked: ceiling: 本站離線留言空間已滿，這則未保存也未轉送；請改用其他中繼或稍後再試"`（`OFFLINE_CEILING_REJECT`）。
  兩句都從 `@cinderous/client/relay` 匯出；Cinderous 錨點逐字相同。
- **不扇出**（定案）。理由：
  - NIP-01：`OK false` 的意思是「沒收下」。轉送一顆沒收下的事件，中繼就同時說了兩件相反的事。
  - Cinderous ADR-0367 §決策 2 的承諾是「滿了就拒收、讓人看得見」，拒收的東西不該部分生效。
  - 若照常扇出：在線的收件人收到、離線的其他裝置收不到（多裝置時同一位收件人的狀態分裂）；
    寄件端依 `false` 重送或改寄別座時，在線的那台會收到第二次。事件 id 相同，客戶端多半會去重，
    但「中繼說沒收、其實送到一半」讓寄件端無法判斷要不要重送，這比多一次重送更糟。
  - 不扇出的代價：在線收件人這一則要等寄件端改寄別座（多中繼發布本來就是同時送出，其他座多半已收下）或空間騰出來後重送。
- **被拒的事件不記進重放快取**。修正前，重放窗內的事件在通過時鐘窗後就記成「見過」，之後任何一種拒收（限速、PoW、檔案未啟用、可尋址被拒、以及這次的天花板）
  都不會把它拿掉——空間騰出來後重送同一顆，只會拿到 `duplicate`，而 NIP-01 客戶端（以及 P0-C 之後的 SDK）會把 `duplicate` 當成已送達，又是一次靜默遺失。
  現在所有在記入之後的拒收都會把它拿掉；只有真的收下（或 Ephemeral 轉發、清除成功）才留著。拒收當下回的訊息不變。
- 不變的：可尋址路徑（仍是同一句 `blocked: 取代事件遭拒（配額/大小/較舊）`，拆分屬 P0-R2）；每收件人 FIFO 與車道天花板淘汰（「收下新的、刪掉舊的」，`put()` 回 `true`）仍回 `OK true`；
  已存在的同一顆（SQL 版 `fresh.length === 0`）仍回 `OK true`。
- 測試：`tests/relay/relay-core.test.ts`（對 `MessageStore` 與 `SqlMessageStore` 各跑：五顆約 3 KB、天花板 10 KB → 兩顆 `OK true` 且都在庫、三顆 `blocked: ceiling:` 且不扇出；
  已過期；車道淘汰仍全收；FIFO 仍收；被拒後重送不是 `duplicate`，可尋址亦同）；`tests/relay/worker.test.ts`（真正的 `RelayRoom`、嚴格平面 128 MB 天花板、16 位收件人各約 240 KB）。

## P0-R2／P0-C 實作紀錄（v0.32.0）

詳見 ADR 0040（詞元表、解析規則、相容性）。重點：

- **中繼（P0-R2）**：所有 `OK false`、`CLOSED`、關鍵 `NOTICE` 改成「前綴＋詞元＋說明」，句子集中在 `src/relay/reject-messages.ts`，詞元來自 `src/protocol/relay-reject.ts`。
  可尋址那一句依原因拆開（`stale`、`too-large`、`quota`×2、`expired`、`ceiling`），靠 `OfflineStore` 新增的**選用**方法 `putAddressableResult()`；
  只實作 boolean 的自訂 store 照舊可用、回舊句子。`duplicate` 改回 `OK true`（決策 3）。
  另補一個 P0-R1 沒蓋到的洞：store **丟例外**時這顆事件以前會留在重放快取裡（重送只拿到 `duplicate`），現在拿掉。
- **沒改的**：車道升級被拒的三句 `NOTICE` 與關閉原因——那是 Cinderous 開發者文件逐字列出的契約；客戶端以關閉碼分類。
- **客戶端（P0-C）**：`classifyRelayMessage()`／`classifyRelayClose()`；`PublishResult.rejected[]` 加 `kind`／`retryable`／`tryOtherRelays`／`token`；
  `duplicate`（兩種）算收下；`SocketLike` 的 close 帶 `code`／`reason`，1008 `rate-limited` 以 `rate-limited` 結案、重連用最長退避，4003 是 `restricted`；
  `onRelayReject` 回報每一座的拒收（含部分拒收）；私訊 `SendOutcome.accepted／rejected`，私訊、Vault、名單同步、`PeerNode` 的 `onPublishRejected`；
  常駐訂閱被 `CLOSED …resubscribe` 時對那一座重訂（30 秒一次，修改 ADR 0032）。成功判定不變，`minAccepted` 留給 P1。
- **Cinderous 錨點**：ADR-0376（逐字相同的 P0-R2，PR 待部署）；Cinderous App 分片連線沒處理 `OK` 的缺口另見 ADR-0377。
  App v0.0.18 的外送匣只看前綴（`classifyOk`），詞元加在前綴後面不影響它；`duplicate` 改 `OK true` 對它是改善（以前算「已確認」但沒標成已送中繼）。

## P1 實作紀錄（v0.33.0）

詳見 ADR 0041。重點：

- **健康狀態**：`ceiling`／`quota` → 那一類資料（離線留言／可尋址…）標 `full` 1 小時；政策、白名單外 → 那個 kind 標 `inapplicable` 24 小時；
  `too-large` → 那個 kind、那麼大以上；`rate-limited` → 整座退避到計數窗結束；關閉碼 1008／4003 分別是退避／不適用；`invalid` 不標記。
  `relayHealth()`、`onRelayHealthChange`、`resetRelayHealth`、`markEvicted`、`writeSet(kind)`。不持久化。**只記錄，不改變預設發布**。
- **耐久度**：`publish(event, { durability: { minAccepted = 1, standby } })`：略過被標記的中繼；耐久收下（不含 `warning: borrowed:`）不足、
  又不是自己的錯時，依序延遲連上備援、只補發這一則；備援不收常駐訂閱（`standbySubscribe` 可開）、閒置斷線、不自動重連。
  結果帶每座狀態與 `relaysFull`；冷卻期內全部略過、一則都不送。
- **讀回稽核**與 **NIP-65／17** 在新子路徑 `@cinderous/client/durability`：`auditOwnEvents`／`OwnEventAuditor`（抽樣、最久沒更新優先、速率限制、
  發現遺失就 `markEvicted`）；寄給別人的禮物包列為 `unauditable`。`queryEach` 在連線池上。
- **整合**：私訊、Vault 傳輸層、名單同步加選用的 `durability`；協調器認得 `RelaysFullError` → `blocked: 'relays-full'`（一次回報、長退避，比照 ADR 0027）；
  `loadRelayFileLimits` 改傳實際寫入的那組（`pool.writeSet(1060)`），新增 `watchRelayFileLimits` 自動重算。
- **向下相容**：不帶 `durability` 時行為與結果形狀和 v0.32 相同，整合端只傳一個參數給 `publish`；既有測試一行未改。

## P2 實作紀錄（v0.34.0）

詳見 ADR 0042。重點：

- **保底份額**（決策 4）：`DO_GUARANTEE_KIB`（SDK 預設關閉，錨點建議 `lane=2048`）；只在淘汰制生效；保底內的寫入先刪借用列再刪別人超出保底的部分（事先算得夠才動手），
  超出保底的寫入只能借用，借不到就 `blocked: ceiling:`。沒有收件人的列以作者計。
- **粗分級預警**（決策 5）：`DO_NEAR_FULL_PERCENT`；`OK true "warning: near-full: <級>: …"`，只有站方的一級與 95；客戶端記成健康狀態的軟標記 `nearFull`，不影響發布。
- **丟棄計數**（M8）：`DO_DROP_NOTICES`；FIFO、天花板淘汰、借用收回與到期刪掉**還沒送到**的留言時按收件人累計（水位線＋線上判斷），
  收件人讀自己的收件匣時在 EOSE 前收到 `NOTICE "warning: dropped: <則數>: <since>: <until>: …"`，送出即歸零；客戶端 `onRelayDropped`。
- **NIP-11 靜態上限**（M6）：`cinder_ceiling_policy`、`cinder_ceiling_bytes`，以及設了才出現的保底、借用、預警、丟棄計數欄位。
- 同一版也做了 ADR 0039 B1（溢位帶）與 Cinderous ADR-0377 的 `DO_CEILINGS_MIB` 移植（`computeCeilingBudget` 含溢位帶）。可尋址墓碑、NIP-77 仍未做。
- 沒設任何新變數時與 v0.33 逐則相同（以 v0.33.0 原樣的 store 對照）；DO SQLite 相容遷移，Cinderous main 升上來與回滾都有測試。

## 待決事項（已於 2026-09-30 決定，見〈決策〉；原文保留）

1. **P0-R1 要不要立刻單獨修並部署到兩座錨點**（不等本 ADR 其他部分）？它是實際的缺陷，而且影響 Cinderous 私訊。
   部署須使用者同意；與 PR #9（錨點改用 SDK 中繼，暫緩合併）的先後也要定。
2. **詞元格式**：`blocked: quota: …` 這種「標準前綴＋英文詞元＋說明」是否採用？說明文字維持中文還是改英文（車道的讀者是第三方開發者）？
3. **`duplicate` 改成 `OK true`**（對齊 NIP-01 範例）？客戶端無論如何都會相容兩種。
4. **已知租戶車道（DocHost）的天花板策略**：維持淘汰、改成拒收、或保底份額（建議）？保底取多少？
5. **預警與丟棄計數**要不要做（M5、M8）：會對寫入者透露粗略的 DO 使用率。
6. **預設耐久性**：私訊、Vault、可尋址狀態的 `minAccepted` 預設值，以及 SDK 是否可以自行延遲連上備援（多一座連線的成本與元資料外洩由應用承擔）。
7. **中繼清單從哪來**：採用 NIP-65／NIP-17（與生態相容，但要公開發布清單）或由應用自行提供（較私密，但別的客戶端找不到）。

## Consequences（若依此提議實作）

- ＋ 嚴格平面不再「回成功、實際丟掉」。
- ＋ 應用拿得到結構化的拒收原因與部分成功的資訊，能依原因決定重試、改用或提示使用者；所有中繼都滿時不會重試風暴。
- ＋ 作者看得到的資料（DocHost、牌組、快照）可以用讀回稽核發現淘汰並自動補到別座；共用 DO 的公平份額讓重度使用者先被拒，而不是別人被默默刪除。
- － 寄給別人的禮物包仍無法由寄件端稽核，只能靠收件人端到端回報（Vault 已有；私訊沒有）。
- － 更多連線與中繼：成本上升、更多中繼看得到「誰在何時寫了多少」。
- － 中繼訊息成為客戶端依賴的契約（詞元），之後改訊息要走契約測試。
- － P0-R1、P0-R2、P2 都要部署錨點；P2 要做 DO schema 遷移。
