# 0058. 輕量成員（sparse member）：知道完整的 Vault 架構、只保存部分檔案內容；送出端依收件人裁剪、按需取得、安全清除

- 狀態：**已接受（Accepted）**——使用者 2026-10-05 裁示（見〈使用者需求與裁示〉）；實作於 v0.46.0
- 日期：2026-10-05
- 相關：本 repo ADR **0025**（協調器、版本圖、摘要對帳、`want`）、0026（P2P 批次與大檔直送）、**0028**（名單）、0035 §G9（能力宣告）、
  0045（排程同步、`digestPolicy`）、**0047**（排除不等於刪除；§4 第 5 列的風險在這裡修掉）、0053 §G17（`peerStatus`）、**0056**（名單上自簽的延伸欄位）；
  **0059**（同一批裁示的 Markdown 合併規則）

## 使用者需求與裁示（2026-10-05）

使用者要做一個獨立的手機 App（名稱未定，不在這次範圍）。它是 Vault 群組的**完整成員**——信任模型不變：握有全部金鑰，使用者已接受這個風險——但
**知道完整的 Vault 架構（所有檔案的版本資訊），只取得部分檔案的內容**；可以在特定資料夾新增檔案並同步出去；桌機照舊用 CinderSync。

| # | 問題 | 裁示 | SDK 怎麼做（本 ADR） |
|---|---|---|---|
| 1 | 怎麼省流量 | **甲：送出端依收件人裁剪內容**（每個收件人本來就各自一份禮物包） | §7：完整成員送給宣告為輕量的收件人時，範圍外的版本只帶版本資訊（中繼、直連、初次補送都一樣） |
| 2 | 預設內容範圍 | daily note 資料夾＋最近 7 天＋手動釘選；按需下載快取上限 200 MB（LRU） | App 的預設；SDK 提供機制與參數：`scope.content`（規則或函式）、`pin`、`fetch`、`scope.cacheBytes`（預設 200 MiB）（§1、§3） |
| 3 | 可以新增檔案的資料夾 | 預設 daily note 資料夾＋`Inbox/`（App 端設定） | SDK 提供「允許新增的範圍」：`scope.create`＋`canCreate(path)`，範圍外的新檔不同步、明確回報（§5） |
| 4 | 按需下載 | **甲：完整成員常駐回應索取** | 走既有的 `want`（加 `fetch` 旗標：要的是內容，不裁剪）；完整成員在排程模式兩輪之間可以只跑 `VaultWantResponder`（§9）。CinderSync 端之後做 |
| 5 | 同一天兩邊各自建立同路徑 Markdown | 以空檔為共同祖先三方合併，合不了退回 callout／副本 | ADR 0059 |
| 6 | daily note 設定 | App 內使用者指定路徑 | 不關 SDK（App 把它換算成 `scope.content`／`scope.create`） |
| 7 | 勾選框衝突自動合併 | 放 v1 | ADR 0059 |
| 8／9／10 | App 技術、名稱；CinderSync 支援輕量成員 | 不在這次範圍；CinderSync 下一步另外做 | §13 給接手的人的整合指引 |

## 決策

### 1. 協調器的內容範圍（`scope`）

```ts
new VaultSyncCoordinator({ ..., scope: { content: ['Daily/', 'Inbox/'], cacheBytes: 200 * 1024 * 1024, create: ['Daily/', 'Inbox/'] } });
await sync.setScope({ content: (path) => isRecentDaily(path) || path.startsWith('Inbox/') });  // 執行中更新（滾動視窗）
sync.setScope(null);                                                                            // 改回完整成員
```

- `VaultContentScope`：`content`（必填）＝內容範圍；`cacheBytes`（預設 `DEFAULT_SPARSE_CACHE_BYTES`＝200 MiB）；`create`（選填）＝允許新增的範圍。
- 範圍的寫法 `VaultPathScope`：gitignore 語法的規則清單（陣列，或一行一條的整段文字；沿用 ADR 0047 的語法、NFC、預設不分大小寫，**符合＝在範圍內**——與排除清單相反）、
  `{ includes(path) }`，或函式（滾動視窗這種依日期算的用函式最直接）。`compilePathScope` 是同一個編譯器（設定頁、名單宣告共用）。
- **有效的內容範圍**＝規則（`content`）∪ 釘選（`pin`）∪ 快取（`fetch` 抓下來的，LRU）∪ 正在 `fetch` 的。看的是檔案目前的版本頭的路徑（被別台改名搬出範圍＝離開範圍）。
- 省略 `scope`＝完整成員，行為與 v0.45 相同（新分支都不會進入；測試照舊）。

### 2. 範圍外的檔案：只有版本資訊

| | 完整成員 | 輕量成員、範圍外 |
|---|---|---|
| 收版本、併入版本圖、摘要列出、`peerStatus` 計算 | ✓ | ✓（一樣；對帳不會反覆索取，也不會被反覆補送） |
| 合併並發的版本頭 | ✓ | ✗（留給完整成員；它們的確定性合併版本到了就收斂成一個版本頭，同 ADR 0047 §4 的排除） |
| 寫進磁碟 | ✓ | ✗；本機原本有的一份（離開範圍）**清掉，不產生任何版本**（§4） |
| 保存內容（`b:` 鍵、等父版本時的 `w:` 鍵） | ✓ | ✗：`#integrate` 收到內容也不存（只留在這次工作的快取裡）、`#gcFile` 只留還沒送出的本機版本的內容、等父版本的版本不留內容 |
| 「內容還沒到」（`pending`） | ✓ | ✗（不等、不索取） |

列出整個架構：`remoteIndex()`（每一個所知的檔案，含刪除了、墓碑還在保留期內的）與 `lookup(path)`（比對方式同 `pathKey`，沒刪除的優先），每筆
`VaultRemoteEntry`：`fileId`、`versionId`、`path`、`size`、`hash`、`deleted`、`modifiedAt`（版本的混合邏輯時鐘，相當於最後修改時間）、
`local`（磁碟上就是這個版本）、`inScope`、`pinned`、`cached`、`conflicted`（還有好幾個版本頭）。完整成員也能用。`index()` 不變（只列磁碟上的）。

`status().scope`：`{ local: { files, bytes }, cached: { files, bytes }, limit, known }`（只有設了 `scope` 才有）。

### 3. 按需取得、釘選、快取

- `fetch(path | { fileId }, { timeoutMs? })`：內容已經在這台就直接回傳（並更新 LRU 的使用時間）；否則把檔案加進快取、向其他裝置索取
  （`want` 帶 `fetch: true`，**不受索取節流**）、收到後寫進磁碟再回傳內容。逾時從呼叫的時候算起；逾時、不認得、已刪除、被排除、協調器停止丟
  `VaultScopeError`（`code`：`timeout`／`unknown`／`deleted`／`excluded`／`stopped`）——逾時後下載仍在背景進行，之後再呼叫即可。
  大檔（只走直連）：`want` 帶 `fetch` 時完整成員把它排進直送並立刻試連（§7）。完整成員也能用 `fetch`（等還沒到的內容）。
- `pin(path)`／`unpin(path)`／`pinned()`：釘的是**檔案**（fileId），改名後仍然釘著；釘選的不受 LRU 與內容規則影響，內容不在就索取。
  `unpin` 之後變成一般的快取（最近使用），之後依 LRU 決定。不認得的路徑 `pin` 丟 `VaultScopeError('unknown')`。
- **LRU**：只算 `fetch` 抓下來、不在規則範圍、沒釘選、磁碟上有的檔案；超過 `cacheBytes` 從最久沒用的清（事件 `evicted`，`reason: 'lru'`）。
  兩個例外：**最近用的那一個不清**（單一檔案比上限還大時 `fetch` 也拿得到）、**正在 `fetch` 的不清**。使用時間：`fetch`、本機修改。
  釘選與快取的清單持久化在 `m`（`pin`、`lru`），重啟後還在。

### 4. 安全清除本機副本：`evict(path)`（並修掉 ADR 0047 §4 第 5 列的風險）

`evict(path)` 刪掉磁碟上的檔案與保存的內容，**不產生任何版本**——其他裝置照常保留；之後重新納入（內容範圍、釘選、`fetch`、`setExcludes` 移除排除）時
**當成要重新抓**，不會被當成「使用者刪了它」。回傳 `VaultEvictResult`：

| 情況 | 結果 |
|---|---|
| 輕量成員、範圍外（快取、取消釘選的）且本機有 | 清掉（`evicted: true`；釘選的一併取消） |
| 在內容規則範圍內；或完整成員的同步中檔案 | 不清（`in-scope`：清了會立刻再寫回來） |
| 本機有還沒收進來的修改 | 先收成本機版本（不遺失），回 `unsent`，**送出、而且有完整成員確認收到之後**自動清掉（§10） |
| **因排除而停止追蹤的本機副本**（`detached()`，完整成員也適用） | 清掉；本機改過就不清（`modified`，否則修改會遺失）；應用自己先刪了再呼叫＝記成清掉（不是刪除） |
| 本機沒有、不認得 | `not-local`／`unknown` |

**為什麼不另加停止追蹤的原因 `why: 'e'`**：清掉之後的紀錄就是「磁碟上沒有、也不是停止追蹤」——這正是「從來沒下載過的遠端檔案」的狀態，
重新納入時協調器本來就會照常抓內容、寫進磁碟，不需要另一個狀態；`detached()` 不會多一種原因要外掛處理。

**ADR 0047 §4 第 5 列的風險**（「從排除移除：排除期間被使用者刪掉的當作一次本機刪除」）：用排除做滾動視窗的應用，若自己刪掉視窗外的本機副本來省空間，
重新納入時會被當成使用者刪除、產生刪除版本、刪掉每一台的檔案。現在應用改呼叫 `evict(path)`：停止追蹤的紀錄被清成「遠端檔案」，重新納入時重新抓。
測試把兩種做法並排釘住（直接刪＝刪除版本，ADR 0047 的定義不變；`evict`＝重新抓回來、沒有刪除版本）。輕量成員的滾動視窗本來就不需要排除：
`setScope` 換範圍時離開範圍的自動清掉、進入範圍的自動抓（測試：9 天的 daily note、7 天視窗前進兩天，沒有任何刪除版本，改回完整成員後整棵樹一致）。

清掉時協調器經 `applyRemote`／`adapter.remove` 刪檔（帶前置條件：內容就是記的那一份，不是的話先收成本機版本），之後的「刪除」回音不會被當成本機刪除
（紀錄已經不在磁碟上）。事件 `evicted: { fileId, path, reason: 'scope' | 'lru' | 'evict' }`（新事件，不改 `applied` 的型別）。

### 5. 沒有基準內容不得產生版本；允許新增的範圍

- 在一個**內容不在這台的檔案路徑**上出現了本機新檔（例如 App 沒先 `fetch` 就讓使用者打字）：**不產生任何版本**——它不知道遠端的內容，任何版本都可能覆蓋或刪掉別人的內容。
  `notifyLocalChange` 以 `VaultScopeError('base-missing')` reject；全量掃描遇到時發 `error` 事件（`context: 'sparse-base-missing'`，同一個檔案沒變就只報一次）；
  `blockedLocal()` 列出被擋下的本機檔案。檔案留在本機原處、協調器不碰。正確的做法是先 `fetch` 再改（修改的是快取的檔案，照常同步）。
  之後若使用者仍 `fetch` 這個路徑：寫入時發現本機有一個不認得的檔案，照 ADR 0025 §6 收成一個**新檔**，與遠端檔案路徑相撞——開了 Markdown 合併規則就以空檔為祖先合併
  （ADR 0059），否則衝突副本。兩邊的內容都留著。
- **允許新增的範圍**（裁示 3，`scope.create`）：範圍外新增的本機檔案不同步、不產生版本，`notifyLocalChange` 以 `VaultScopeError('create-outside')` reject、
  `error` 事件 `sparse-create-outside`、列在 `blockedLocal()`。`canCreate(path)` 給 App 的 UI 先判斷。**改名與修改既有檔案不受限**（那不是新增）。
  省略 `create`＝不限。建議 `create` 是 `content` 的子集（新增的檔案本來就該留在這台）。

### 6. 名單宣告（比照 ADR 0056 的 `standby`）

- `membership.declareSparse(patterns | null)`：這台自己簽的**內容範圍宣告**（名單上與 `caps`、`standby` 並列的新欄位 `sparse`；`null`＝完整成員）。
  規則正規化（去空白、空行、`#` 註解、去重）；最多 `ROSTER_SPARSE_MAX_PATTERNS`（16）條、每條 ≤ `ROSTER_SPARSE_MAX_PATTERN_LENGTH`（200）字、整份 JSON ≤ 1,024 字、
  不能有控制字元，不合規丟 `RangeError`。`./pairing` 不匯入同步零件，所以這裡只看形狀；收方以 `compilePathScope` 編譯（不合法的行略過）。
- `membership.scopeOf(pubkey)`（輕量回規則、完整回 null、不是成員回 undefined）、`sparseMembers()`、`fullMembers()`（沒宣告的＝完整，含舊版）。
- `membership.allDeclare(feature)`：所有有效成員（含自己）的能力宣告裡 `feature` 都是 true（ADR 0059 的開關用）。
- 合併規則同 `standby`：同一台取 `at` 較晚的；簽章不對或不合規的**只丟那一筆**；被撤銷的丟掉；舊版（≤ v0.45）解析時略過、轉送時丟掉這一欄，新版以聯集保留，不會來回震盪。
- 配對的歡迎訊息只帶邀請方自己的那一筆（其他成員的之後經名單同步補上），歡迎訊息大小不受成員數影響；32 台都塞滿（含備援）名單事件仍在中繼單顆上限內（測試釘住）。
- 宣告的是**規則**（給送出端裁剪用），不是這台實際的有效範圍：釘選與快取經常變動，不放進名單；宣告比實際範圍窄時，範圍內缺內容的版本由 `fetch` 補（多一個往返），
  所以滾動視窗的 App 可以宣告整個 daily note 資料夾。

### 7. 送出端裁剪（裁示 1）

協調器選項 `peerScopes`（deviceId → 範圍）與 `setPeerScopes(scopes | null)`；應用從名單換算：`sync.setPeerScopes(sparsePeerScopes(membership))`（名單 `change` 時再呼叫）。

- **中繼**：`VaultSyncTransport.send(message, options?)` 多一個選用參數 `VaultSendOptions`：`to`（只送給這些 deviceId）、`omitContentFor`（送給這些 deviceId 時拿掉內容）。
  每個收件人本來就各自一份禮物包，`NostrVaultTransport` 對被裁剪的收件人改送「同一則訊息、沒有內容」的訊框（只編碼一次）。要對得上 deviceId，所以只有給了
  `deviceOf` 才做（`transport.targeted === true`）；做不到時照舊全部、完整地送（收方照樣不保存——只是多花流量）。自訂傳輸層可以略過這個參數（相容）。
- 哪些收件人被裁剪：宣告為輕量、版本在它的範圍外、而且**它沒有明確要內容**（`want` 帶 `fetch` 的會記在佇列項目的 `full`，送給它時不裁剪）。
- **補送只給輕量成員時只送給它們**（`to`）；完整成員要的補送照舊廣播（其他裝置順便收到，少一輪對帳，v0.45 的行為不變）。
- **只有版本資訊的合併訊息 `nodes`**：佇列裡送給同一組輕量收件人、都只帶版本資訊的版本，連續的合成一則（一個訊框以內、最多 200 個）。只在傳輸層照收件人送（`targeted`）
  而且收件人都宣告為輕量（必然是 v0.46 以上）時才用——舊版不認得 `nodes`，不能廣播出去。新加入的輕量成員要整個 Vault 的版本資訊時，5,000 個檔案只要幾十則，
  而且不會一次塞爆收件人在中繼上的檔案塊配額（預設 4,000 塊／7 天）。
- **直連**（P2P 批次）：範圍外的版本對輕量收件人只送版本（`c = 0`、0 位元組）；大檔不排直送給範圍外的輕量成員（本機新版本、收到它的摘要時都一樣），
  它 `fetch`（`want` 帶 `fetch`）時才排。
- **初次補送**（新成員空摘要時的整批補送）走上面同一條路：只收版本資訊＋範圍內內容。

實測（`sparse.test.ts`，記憶體假中繼、編碼後位元組）：5,000 個檔案（每檔約 1.2 KB，範圍內 50 個）的 Vault，新成員加入時收到的——
**完整成員 5,000 則／7,976,350 B；輕量成員 84 則／1,647,898 B**（剩下的位元組幾乎都是 5,000 個版本的中繼資料，每個約 330 B）。
直連：範圍外 30 個 5 KB 的檔案＋一個大檔，輕量成員加入時直連流量 < 200 KB；`fetch` 大檔時才直送。

### 8. 輕量成員不是內容來源

- 它不回應自己手上沒有內容的**內容索取**（`want` 帶 `fetch`）——回了也只是沒有內容的版本；其他裝置會回。回應**版本索取**（缺父版本）照常（只帶版本資訊）。
- 完整成員不向它要大檔（直送是內容持有者主動推，輕量成員只推它磁碟上有的）。
- `peerStatus(device).sparse`：這台的 `peerScopes` 宣告它是輕量的；`missing` 照樣只算版本（輕量成員也有完整的版本資訊，所以「它少了幾個檔案」的語意不變）。

### 9. 只回應索取的輕量訂閱：`VaultWantResponder`（裁示 4 甲）

給完整成員（例如 CinderSync 的排程模式）在兩輪同步之間常駐：只處理 `want`——讀協調器存下的狀態（`f:` 版本圖、`b:` 內容）與磁碟上的檔案（雜湊相符才算）、
以 `to: [索取者]` 回 `node`（帶 `fetch` 的不裁剪；沒帶的依 `peerScopes` 裁剪）。**不跑整輪同步、不送摘要、不寫磁碟、不改任何狀態**。

```ts
const live = new NostrVaultTransport({ pool, signer, devices, deviceOf, backfillPages: 0, since: Math.floor(Date.now() / 1000) });
const responder = new VaultWantResponder({ store, adapter, transport: live, deviceId, peerScopes: sparsePeerScopes(membership) });
live.start(); responder.start();
// 下一輪同步開始前：await responder.stop(); live.stop(); 然後照常 sync.start()
```

- **不要和同一個 Vault 的協調器同時跑**（協調器在跑時它自己就會回應；兩個都回只是重複、冪等）。
- 用**另一個傳輸層實例**、不補拉歷史：其他訊息（別台的版本、摘要）照樣留在中繼上，下一輪同步由協調器自己的起點補拉；這裡收到也只是略過，**不推進協調器的補拉起點**。
- 耗電與流量：常駐的只有一條訂閱（`#p` 是自己的 1060），沒有計時器、不送任何東西，直到有人索取。代價是同步期間的訊息會收兩次（這裡解開後略過、下一輪協調器補拉時再收一次）——
  量等於兩輪之間別台的修改數。回應一則索取＝讀一次狀態儲存（＋可能讀一次檔案）＋每個版本一顆禮物包（每分鐘的事件預算照 ADR 0043 共用）。行動裝置不建議跑它
  （它們本來就不是被索取的對象）；桌機在排程模式下跑，手機的 `fetch` 才有人回。大檔（只走直連）不經這裡；要直送大檔請跑協調器（或之後另議）。
- `stats`：回了幾個、略過幾個（不認得、內容不在手上、送不出去）；`maxItems` 限制一則索取最多處理幾項（預設 1,000）。

### 10. 不遺失資料的補強（同版修正）

輕量成員會清掉範圍外的本機內容，所以「內容只剩一份」的時間窗變長了，以下三條一起做（完整成員也受惠）：

1. **輕量成員自己寫的內容，等完整成員確認收到才清**：要清的檔案若目前的版本是這台寫的，必須至少一台**完整成員**已知有它（或它的後代）——來自它的摘要、直連確認、
   或它以那個版本為父版本送來的新版本（ADR 0053 §G17 的同一套已知版本頭）。中繼「送出成功」不算：對方可能還沒收到，而中繼只保存 7 天。
   確認到了（摘要、`notePeer`）、送出完成、背景維護（`tick`）時都會再看一次。
2. **內容晚到也收下**：收到一個已經有的版本的內容時，只要有版本頭是同一份內容、而且這台沒有（不在磁碟上、也沒保存），就收下（v0.45 只在「正在等」時才收——
   先收到只有版本資訊的補送、或重開後忘了在等的，內容到了會被丟掉）。比對內容雜湊：改名、相撞改名等後代版本與它同內容。
3. **重開後重新排「還在等內容」的檔案**：「在等」不持久化，v0.45 重開後要等下一次對帳才會再要；現在啟動時把「有沒刪除的版本頭、不在磁碟上、沒被排除」的檔案重新排進來，
   缺內容的再要一次。

（隨機性質測試在補上這三條之前抓到：輕量成員新建的範圍外檔案送出後立刻清掉，完整成員先收到只有版本資訊的補送、重開後又丟掉晚到的內容——這份內容就此沒有任何地方有。）

### 11. 相容

- 線上格式：`want` 多一個選用欄位 `fetch`（舊版略過，照舊回完整內容）；新的訊息型別 `nodes` 只送給宣告為輕量的收件人（必然是 v0.46 以上），而且只在傳輸層照收件人送時；
  `VaultSyncTransport.send` 多一個選用參數（自訂傳輸層可以忽略）；`VaultSyncTransport.targeted` 選用。版本節點與 `VAULT_WIRE_VERSION` 不變。
- 名單：`sparse` 欄位舊版略過（同 `standby`）。舊版完整成員不認得宣告：照舊送完整內容，輕量成員照樣不保存（只是多花流量）。
- 狀態：`m` 多 `pin`、`lru`；佇列項目多 `full`、`again`（送出中被加了收件對象時，送完留著再送一次——傳輸層照收件人送之後才需要）；舊版讀到略過。
- 沒有 `scope`、沒有 `peerScopes`：v0.45 的行為（§10 的三條補強除外，它們只讓內容更不容易丟）。既有 vault 測試（含所有隨機性質測試、同樣的種子）全部照過；
  `peerStatus` 的回傳多一個 `sparse` 欄位（一個用 `toEqual` 比對整個物件的測試補上了 `sparse: false`）。

### 12. 已知限制

1. 輕量成員對範圍外的檔案不合併：完整成員都離線時，範圍外的並發修改會一直是好幾個版本頭（`remoteIndex` 的 `conflicted`）——不影響範圍內。
2. `fetch` 一個還有好幾個版本頭的檔案：這台會自己合併；共同祖先的內容若不在這台（範圍外不保存），合併退回衝突副本，與完整成員的乾淨合併以涵蓋規則收斂（ADR 0025 已知限制，不遺失資料，可能多一份副本）。
3. 宣告的規則與實際範圍不同步：宣告窄了＝多一次 `fetch` 往返；宣告寬了＝多花流量。滾動視窗建議宣告整個資料夾。
4. 快取的檔案若在別台被改，送給輕量成員的新版本只帶版本資訊（它的宣告不含快取），它會再 `fetch` 一次（多一個往返）。
5. 在「內容不在這台的檔案路徑」上被擋下的本機檔案，`fetch` 之後會變成與遠端檔案路徑相撞（§5），不會自動當成那個檔案的修改。
6. 使用者在檔案管理員裡直接刪掉快取的檔案＝刪除（那是同步中的檔案）；App 的「從這台移除」要呼叫 `evict`。
7. `VaultWantResponder` 不送大檔；與協調器同時跑會重複回應。

### 13. 整合指引

**App（輕量成員）**：

```ts
const scope = { content: [`${dailyFolder}/`, 'Inbox/'], create: [`${dailyFolder}/`, 'Inbox/'], cacheBytes: 200 * 1024 * 1024 };
membership.declareSparse(scope.content);                        // 名單宣告（送出端據此裁剪）
const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, scope, mergeRules: membership.allDeclare(MERGE_RULES_CAPABILITY) });
// 最近 7 天：每天換一次範圍（函式也可以），離開的自動清掉、進來的自動抓
await sync.setScope({ ...scope, content: (p) => isWithinDays(p, 7) || p.startsWith('Inbox/') });
const tree = sync.remoteIndex();                                // 整個 Vault 的架構（路徑、大小、時間、是否在本機）
const bytes = await sync.fetch('Projects/plan.md', { timeoutMs: 15_000 });  // 打開範圍外的筆記
await sync.pin('Projects/plan.md');                             // 一直留著
await sync.evict('Projects/plan.md');                           // 「從這台移除」——不是刪除
if (!sync.canCreate(path)) showError('這個資料夾不能新增');
try { await sync.notifyLocalChange(path, 'create'); } catch (e) { if (isVaultScopeError(e)) showBlocked(e.code, e.path); }
```

**CinderSync（完整成員）**：名單 `change` 時 `sync.setPeerScopes(sparsePeerScopes(membership))`、`sync.setMergeRules(membership.allDeclare(MERGE_RULES_CAPABILITY))`；
`NostrVaultTransport` 要給 `deviceOf`（才裁剪得到、才用得上 `nodes`）；排程模式兩輪之間跑 `VaultWantResponder`（§9）；設定頁可以用 `peerStatuses()` 的 `sparse`
標示「這台只有部分內容」。排除清單的滾動視窗若要清本機副本，改用 `evict`（§4）。

## 測試（TDD）

- `tests/sync/vault/sparse.test.ts`（21）：初次加入（範圍內寫入、範圍外只有版本資訊、不保存、`remoteIndex`／`lookup`／`status().scope`、`nodes` 訊息）；之後的修改（大小雜湊跟著變、摘要與 `peerStatus` 一致）；
  完整成員沒宣告／傳輸層做不到依收件人送時 b 照樣不保存；`fetch`（寫入、快取、別台改了跟著更新、快取的檔案可以改並送出）；`fetch` 的錯誤（不認得、已刪除、逾時、之後抓得到）；
  LRU（清最久沒用的、不是刪除、使用時間更新順序）；比上限還大的單一檔案；`pin`／`unpin`（改名後仍釘著）；重啟後釘選與快取還在；`evict`（不產生刪除版本、再抓得回來、
  各種不清的原因、本機修改先收成版本、確認後才清）；🔴 ADR 0047 §4 第 5 列的風險（直接刪＝刪除版本、`evict`＝重新抓回來）；停止追蹤的副本被改過不清、應用先刪了再 `evict`；
  滾動視窗（`setScope` 前進兩天、改回完整成員）；`base-missing`（reject、只報一次、`blockedLocal`、不送任何版本）；`create-outside`（範圍外擋下、範圍內照常、改名不受限）；
  5,000 檔加入的訊息數與位元組；直連（範圍外只送版本、大檔 `fetch` 時才直送）；輕量成員不回內容索取；`sparsePeerScopes`。
- `tests/sync/vault/sparse-wire.test.ts`（5）：`want` 的 `fetch` 與 `nodes` 的來回與驗證；`NostrVaultTransport` 的 `omitContentFor`／`to`（真的加解密）、沒有 `deviceOf` 時照舊；`VaultWantResponder`。
- `tests/pairing/sparse.test.ts`（8）：宣告、簽章、合併、`scopeOf`／`sparseMembers`／`fullMembers`／`allDeclare`、`compilePathScope`；`null` 改回完整；不合規丟錯；🔴 竄改與冒名只丟那一筆、
  舊名單不震盪；撤銷丟掉、持久化；32 台塞滿仍在上限內；歡迎訊息只帶邀請方的。
- `tests/sync/vault/property-sparse.test.ts`：隨機世界（編輯、新增、改名、刪除、上下線、重啟、延遲、重送、沒通知只靠掃描）裡 d1 是輕量成員：完整成員一致、不遺失（被擋下的本機新增除外）、
  d1 的版本資訊與完整成員一致、d1 磁碟上恰好是範圍內與快取的檔案、d1 不保存範圍外的內容、沒有卡住。預設 24 個種子（另以 150 個種子跑過），另一組加 P2P、大檔、中途加入新裝置 8 個種子（另以 24 個跑過）。
