# 0063. 版本歷史只在 client 端：本機歸檔、列出、讀取與還原

- 狀態：**已接受（Accepted，2026-10-08）**。原則由使用者裁示：「歷史版本功能應該只實作在 client 端」；〈待決事項〉六題同日裁示，見〈使用者裁示〉；同日補充參考 git 的檢查點、操作紀錄、命名檢查點（〈使用者裁示（2026-10-08，補充：參考 git）〉）。**已實作於 v0.49.0**（見〈實作〉）；〈待決〉三題同日裁示、**實作於 v0.50.0**（見〈實作（v0.50）〉）。
- 日期：2026-10-08
- 對應：
  - ADR **0025**（Vault 協調器、版本圖）、**0047**（排除範圍）、**0058**（輕量成員）、**0060**（清掉不是刪除）。
  - CinderSync ADR 0008（覆寫前備份到 `.trash/cindersync-backup`）、0034。

## Context

2026-10-08 檢查「SDK 與中繼的同步機制有沒有版本控制」，結果如下。

**SDK `./sync/vault`**：每個檔案有一張版本圖，欄位有 `id`、`parents`、`device`、`at`、`hash`、`path`、`deleted`，可以分岔、合併，刪除與改名也都算版本。但它只為合併服務：
- 版本紀錄每檔保留最近 64 筆（超過 96 才清，`DEFAULT_MAX_VERSIONS_PER_FILE`）。
- 內容方面，文字檔只留最近 8 版加版本頭（`DEFAULT_BASE_VERSIONS_KEPT`），二進位檔只留版本頭。
- 公開 API 只有 `readVersionContent`（讀得到的才算數）和 `index()`（只列版本頭）。**沒有列出歷史、沒有還原，也沒有整個 vault 的時間點。**

**中繼**：Vault 訊息以 kind 1060 封裝，**7 天後過期**（`DEFAULT_VAULT_TTL_SECONDS`），是加密信箱，不保存歷史。ADR-0071 的快照每台裝置只留最新一份。

**CinderSync**：被覆寫或刪除前會複製到 `.trash/cindersync-backup`，只在本機、沒有介面可以瀏覽。

使用者希望有類似 Obsidian Sync「版本歷史」的能力，並裁示**只在 client 端實作**。這符合本專案「中繼只轉發密文與暫時狀態、不持久化」的原則：歷史留在使用者自己的裝置上，中繼不增加任何保存或容量負擔。

## Decision（草案）

1. **中繼不變。** 不新增事件種類、不延長 TTL、不保存任何歷史。
2. **SDK 新增本機歸檔（history archive），和同步用的版本圖分開。**
   - 版本圖照舊依 `maxVersionsPerFile`、`DEFAULT_BASE_VERSIONS_KEPT` 清理，合併邏輯不受影響。
   - 歸檔另外記錄 `{ fileId, versionId, path, at, device, label, hash, size, deleted }`，內容以 `hash` 去重後存在同一個 state store（例如 key `h:<hash>`）。版本圖清掉某個版本，不會連帶清掉歸檔。
   - 這台**自己產生的**版本和**收到的**版本都歸檔。輕量成員只歸檔內容範圍內、而且內容確實在本機的版本。
   - 歸檔只存在本機的 state store（IndexedDB 等），**不同步**。每台各自保存，保護等級和磁碟上的檔案相同。
3. **保留規則**，由選項 `history` 設定：
   - 保留天數、每檔最多版本數、總容量上限、是否包含二進位檔。
   - **稀疏化**：越舊保留得越疏，例如 1 小時內全留、1 天內每小時一版、之後每天一版。避免 Obsidian 每幾秒自動存檔，把歸檔塞滿幾乎相同的版本。
   - 超過容量上限時，從最舊的開始清，但每個檔案至少保留一版。
4. **API（草案）**：
   - `history(pathOrFileId)`：列出歸檔中的版本，含已刪除的檔案。
   - `readHistory(versionId)`：讀出內容。
   - `restore(path, versionId)`：把舊內容當成**新的本機修改**寫回，產生一個以目前版本頭為父的新版本，照常同步，**不改寫歷史**。已刪除的檔案也可以還原。
   - `deletedFiles({ since })`：列出最近刪除的檔案。
   - 「整個 vault 回到時間 T」可以從各檔歸檔推導，列為之後的工作。
5. **CinderSync**（另寫外掛 ADR）：
   - 「檔案歷史」視窗：版本列表，以及和目前內容的差異比較，可以還原。
   - 「最近刪除的檔案」。
   - 設定頁設定保留規則。
   - `.trash/cindersync-backup` 是否還要保留，屬於待決事項。
6. **歸檔成員不是新角色。** 家裡常開的電腦或 NAS 只要是完整成員，把保留規則設長（例如永久、包含二進位檔），就是整個群組的長期歷史來源；手機維持短保留或關閉。
7. **隱私**：歷史從不離開裝置。重設身分（CinderSync ADR 0029）或移除裝置時，要提供「一併清除歷史」的選項。

## 待決事項（逐項與使用者討論）

1. **預設保留規則**：完整成員預設文字檔保留 30 天、每檔最多 100 版、總上限 1 GB 嗎？
2. **二進位檔要不要預設歸檔**：圖片、PDF 很佔空間。建議預設**不歸檔**，只在設定裡開啟，或交給歸檔成員。
3. **稀疏化規則**：「1 小時全留、1 天每小時一版、之後每天一版」可以嗎？
4. **輕量成員（手機）的預設**：關閉，還是只保留 7 天？
5. **CinderSync 的 `.trash/cindersync-backup`**：歷史上線後還要不要保留？建議改成只在歷史關閉時使用，避免重複佔空間。
6. **整個 vault 回到某個時間點**：v1 要不要做？建議先不做。

## 使用者裁示（2026-10-08）

| # | 事項 | 裁示 |
|---|---|---|
| 1 | 預設保留規則 | **照建議**：完整成員的文字檔保留 30 天、每檔最多 100 版、總容量上限 1 GB |
| 2 | 二進位檔 | **只保留路徑等版本資訊**：歸檔記錄 `path`、`at`、`device`、`label`、`hash`、`size`、`deleted`，**不存內容**。歷史列表看得到修改紀錄，但不能從歸檔還原內容；如果內容剛好和現在的檔案相同（同一個 `hash`），就算已還原。設定裡**不提供**「包含二進位內容」的選項 |
| 3 | 稀疏化 | **照建議**：1 小時內全留、1 天內每小時一版、之後每天一版（各區段保留該區段最新的一版） |
| 4 | 輕量成員（手機）預設 | **關閉**，可以自行開啟 |
| 5 | CinderSync `.trash/cindersync-backup` | **只在歷史關閉時使用**；歷史開啟時，覆寫與刪除的保護交給歸檔 |
| 6 | 整個 vault 回到時間點 | **v1 就做**，規格見下方 |

### 整個 vault 回到時間點 T（裁示 6）

- **`vaultAt(T)`**：依各檔歸檔，取得每個檔案在時間 T 的狀態。每個檔案取 `at ≤ T` 的最後一版；如果那一版是刪除，或 T 時檔案還不存在，就視為不存在。
  回傳 `{ path, versionId, hash, size, text, restorable }` 的清單；二進位檔只有在內容和現在相同時，`restorable` 才為真。
- **`planRestoreVault(T, { paths?, removeCreatedAfter? })`**：**只做預覽**，列出四類變更：
  - 要改回的檔案；
  - 要復原的已刪除檔案；
  - `removeCreatedAfter` 打開時，要刪掉的「T 之後才建立的」檔案（預設**不刪**）；
  - 無法還原的檔案，例如二進位內容不在歸檔、或超出保留範圍。
- **`restoreVault(plan)`**：照預覽逐檔執行。每個檔案都是一次新的本機修改或刪除，照常同步，**不改寫歷史**；無法還原的跳過並回報。
  因為是一般的新版本，還原之後也可以再用 `restoreVault` 回到還原之前。
- **限制**：
  - 只能回到這台裝置的歸檔涵蓋的時間：受保留規則與稀疏化影響，越久以前越不精確（稀疏化後是「那一天最後的版本」）。
  - 這台加入群組之前的狀態無法還原。
  - 輕量成員只涵蓋內容範圍。

## 使用者裁示（2026-10-08，補充：參考 git）

使用者同日裁示「好 加上」：整個 vault 回到時間點的功能借用 git 的幾個概念，一併在 v0.49.0 做。

| # | 項目（git 的對應） | 裁示 |
|---|---|---|
| 1 | **檢查點**（commit／tree） | 某一刻整個 vault 的清單：路徑 → `{ fileId, versionId, hash, size, text }`。內容沿用歸檔的雜湊去重儲存，檢查點只多一份清單；清單以相對於前一個檢查點的差異或其他精簡形式保存，5,000 個檔案的清單應在幾百 KB 以內。同步告一段落（靜止）時自動建立，**最多每小時一個**；應用也能呼叫（例如 `checkpoint({ auto: true })`）。自動檢查點套用和檔案歷史相同的稀疏化。輕量成員的檢查點只涵蓋範圍內的內容，範圍外的標成不能還原 |
| 2 | **還原之前的檢查點＋操作紀錄**（ORIG_HEAD／reflog） | `restoreVault(plan)` 先自動建立一個標成「還原之前」的檢查點；本機操作紀錄記一筆（時間、目標 T 或檢查點、改了哪些、跳過哪些）。復原一次還原＝還原到那個檢查點。`operations()` 列出紀錄 |
| 3 | **命名檢查點**（tag） | `checkpoint({ name })`。不稀疏化、不過期，最多 50 個，超過時**明確拒絕**、不默默清掉任何一個。`checkpoints()` 列出，可改名、刪除。內容即使超過 `keepDays` 與 `maxBytes` 也要保留：歸檔清理把命名檢查點參照的雜湊當成釘住，容量另外回報釘住的位元組 |
| 4 | **時間點的解法** | `vaultAt(T)`、`planRestoreVault` 優先用 T 之前（含）最近的檢查點，結果註明 `source: 'checkpoint' \| 'reconstructed'`；沒有檢查點才逐檔推算，並標示結果可能組合了從沒同時存在過的版本。也可以直接指定檢查點：`planRestoreVault({ checkpoint: id, paths?, removeCreatedAfter? })`；`paths` 照舊可以只還原資料夾 |

不變的限制：**沒有分支**；**不改寫歷史**（還原一律產生新版本）；歷史與檢查點**不同步、不離開裝置**，中繼不變；`clearHistory()` 一併清掉檢查點與操作紀錄。

## 實作（v0.49.0）

### API（`VaultSyncCoordinator`，`@cinderous/client/sync/vault`）

| 方法 | 說明 |
|---|---|
| 選項 `history: { enabled?, keepDays?, maxVersionsPerFile?, maxBytes?, dayBoundary? }` | 預設完整成員開（30 天、100 版、1 GiB、`dayBoundary: 'local'`），輕量成員（有 `scope`）關；執行中 `setHistory(partial)` |
| `history(pathOrFileId \| { fileId })` | 新到舊的 `VaultHistoryEntry`（含已刪除的檔案、改名前的路徑；`content`、`restorable`）。字串先當 fileId，否則當路徑：現在／最後在這個路徑上的檔案，沒有就找曾經在的 |
| `readHistory(versionId)` | 歸檔內容；二進位檔只有和現在相同時讀得到；刪除或讀不到回 null |
| `restore(path, versionId)` | 寫回 `path` 當成新的本機修改（父版本＝目前的版本頭）；`path` 上沒有檔案而版本所屬的檔案已刪除時，以同一個身分復活；回 `{ fileId, path, versionId, outcome: 'restored' \| 'unchanged' }`；失敗丟 `VaultHistoryError` 或 `VaultScopeError` |
| `deletedFiles({ since? })` | 最後一版是刪除的檔案（不含「路徑相撞同內容」「同路徑新建的合併」這種被收進別的檔案的刪除），帶 `lastVersion` |
| `vaultAt(T \| { checkpoint })` | `VaultSnapshot { at, source, checkpoint?, mixed, files }` |
| `planRestoreVault(T \| { at?, checkpoint?, paths?, removeCreatedAfter? }, options?)` | 預覽 `{ revert, undelete, remove, unrestorable, source, checkpoint?, mixed }` |
| `restoreVault(plan)` | 先建「還原之前」的檢查點，再執行；回 `{ restored, removed, skipped }`；記操作紀錄 |
| `checkpoint({ name? , auto? })`、`checkpoints()`、`renameCheckpoint(id, name)`、`deleteCheckpoint(id)` | 檢查點；`auto: true` 一小時內或沒有變化回 null |
| `operations()` | 操作紀錄，新到舊（`before` 是還原之前的檢查點） |
| `historyStatus()` | `{ enabled, files, versions, checkpoints, bytes, pinnedBytes, maxBytes }` |
| `clearHistory()` | 清空歸檔、檢查點、操作紀錄 |

純函式（`history.ts`，也從 `./sync/vault` 匯出）：`thinHistory`、`overByteBudget`、`fileStateAt`、`buildRestorePlan`、`encodeManifest`／`diffManifest`／`decodeManifest`／`isEmptyDiff`、`VaultHistoryError`。

```ts
const sync = new VaultSyncCoordinator({ ...options, history: { keepDays: 30 } });
// 檔案歷史視窗
const versions = sync.history('notes/a.md');            // 新到舊
const old = await sync.readHistory(versions[3].versionId); // 和目前內容做差異比較
await sync.restore('notes/a.md', versions[3].versionId);   // 新的本機修改，照常同步
// 最近刪除的檔案
for (const f of sync.deletedFiles({ since: Date.now() - 7 * 864e5 })) {
  if (f.lastVersion?.restorable) await sync.restore(f.path, f.lastVersion.versionId);
}
// 整個 vault 回到昨天早上九點（只看 Projects/），預覽後執行，之後可以復原
const plan = sync.planRestoreVault(yesterday9am, { paths: ['Projects/'] });
const report = await sync.restoreVault(plan);
const [op] = sync.operations();
await sync.restoreVault(sync.planRestoreVault({ checkpoint: op.before!, removeCreatedAfter: true }));
// 命名檢查點
const tag = await sync.checkpoint({ name: '交稿前' });
```

### 儲存格式（同一個 `SyncStateStore`，不同步）

| 鍵 | 內容 |
|---|---|
| `ha:<fileId>` | 一個檔案的歸檔：`{ fileId, entries: [{ versionId, path, at, n, device, label, hash, size, deleted, text, content, absorbed? }], born?, cut?, dropped? }`。`n` 是這台的歸檔序號（`at` 相同時分先後：合併版本的 `at` 等於較晚的父版本）；`born`＝收到了檔案的第一個版本（沒有父版本）時的時間，比它早的時間點檔案確定不存在；`cut`＝保留規則從前面清掉的最新時間；`dropped`＝歸檔清掉、版本圖可能還留著的版本 id（最多 256 個，啟動時不再補回來） |
| `hc:<sha256>` | 歸檔的內容（只有文字檔），以雜湊去重：參照數＝歸檔版本＋檢查點，在記憶體裡算（啟動時從 `ha:`／`hk:` 重建），歸零才刪；啟動時沒有任何參照的（寫到一半重開）清掉 |
| `hk:<id>` | 檢查點：`{ id, n, at, kind, name?, files, hn, base?, m }`。`m` 是清單：完整的 `{ s }` 或相對於 `base` 的差異 `{ s, d }`；每一列 `[fileId, 路徑或 [前綴長度, 其餘], versionId, hash, size, flags]`，依路徑排序、路徑前綴共用、hex 的 id 與雜湊改成 base64url；`hn` 是建立時的歸檔序號 |
| `ho` | 操作紀錄（最多 200 筆，每筆的路徑清單最多 1,000 個） |
| `m`（既有） | 多了 `hs`（歸檔序號）、`hx`（上次清空的時間）、`cs`、`os`（檢查點、操作紀錄序號） |

**為什麼另用 `hc:`、不和版本圖的 `b:<fileId>:<hash>` 共用參照計數**：`b:` 是每個檔案一份、由版本圖的修剪（`#gcFile`）、清掉墓碑（`#dropRecord`）、輕量成員清掉內容等好幾條路徑直接刪除，而且只為合併保留；和歸檔共用就要讓這些路徑都知道歸檔的參照，等於把歷史的保留規則塞進同步的關鍵路徑。分開之後兩邊各管各的，代價是最近幾版文字檔的內容在 `b:` 與 `hc:` 各一份（文字檔小，每檔最多 8 版）。`hc:` 以雜湊全域去重（不分檔案），改名、衝突副本、還原回同樣內容都不多佔。

**升級**：既有的狀態儲存一開始沒有歸檔；啟動時把版本圖裡還沒歸檔的版本補進來（每檔最多 64 版的版本資訊，內容則是版本圖還留著的——文字檔最近 8 版——加上磁碟上的那一版）。版本圖已經修剪掉的、這台加入之前的，找不回來。之後每次啟動也會補（例如歷史關閉期間的版本），清空過歷史（`clearHistory`）之前的不補。

### 歸檔

- 每次工作（`#run`）結束、清掉這次工作的內容快取之前歸檔這次加入的版本（`#addNode`、內容落地的 `#setDisk` 都記下來）；內容從這次工作的快取、版本圖保存的或磁碟上（雜湊相符）拿。內容晚到（先收到版本資訊）的文字版本先記版本資訊，之後任何一次工作的快取裡出現那份內容就收下。歸檔出錯只發 `error`（`history`），不影響同步。
- 不歸檔：排除範圍（`ignore`／`excludes`）裡的路徑；輕量成員範圍外的、內容不在本機的（打開歷史時才歸檔）。清掉本機副本（evict）不產生版本，所以不會有「刪除」紀錄。
- 被收進另一個檔案的刪除（路徑相撞同內容的 dedupe、同路徑新建合併的 fold）標成 `absorbed`，不列在 `deletedFiles`。

### 保留與稀疏化（裁示 1、3）

- 純函式 `thinHistory`：最新的一版一律留（檔案目前的狀態；只有最新一版是刪除而且超過保留天數時整個檔案清掉）；1 小時內全留；1 天內每個小時留最新的；之後到保留天數為止每天留最新的；更舊的清掉；再依 `maxVersionsPerFile` 從最舊的清。**刪除不佔區段**：同一個區段裡刪除之前最後一版有內容的照留，「最近刪除的檔案」才還原得回來。性質：隔一段時間再做一次，結果和一次做到那個時間相同（不含版本數上限），所以背景維護怎麼排都一樣。
- **「每天」的一天用這台裝置的當地日期**（預設 `dayBoundary: 'local'`，含日光節約時間；`'utc'` 可選，測試用它）。理由：使用者看到的是「那一天最後的版本」，以台灣來說 UTC 的日界在早上 8 點，「昨天最後的版本」會變成昨天早上 7:59 的那一版，違反直覺；稀疏化只決定留哪一版、不影響同步，各台用不同的日界沒有一致性問題。小時的界線只有非整點時差的時區會不同。
- 容量（`maxBytes`）：命名檢查點釘住的不算；超過時先從最舊的版本清（每個檔案至少留最新的一版；被檢查點留著的內容清了版本也省不下，不清），還是超過就清最舊的自動／「還原之前」檢查點（最新的檢查點不清）。
- 背景維護（`tick`）、每次歸檔動到的檔案、`setHistory` 都會套用。

### 還原

- 寫入走一般的寫入路徑（`#apply`：有 `applyRemote` 就交給應用，否則轉接器），帶前置條件；寫入前先把磁碟上還沒通知的修改收成版本（並歸檔）；寫完從磁碟讀回來收成本機版本、照常合併與送出。前置條件一直不符（使用者一直在改）就放棄（`restore` 丟錯、`restoreVault` 回報 `changed`）。
- **不遺失**：要覆寫或刪掉的現有內容必須在歸檔裡（覆寫或刪了才找得回來），否則不做（`content-missing`）；因此 T 之後建立的**二進位檔不刪**（`binary`）。
- `restoreVault` 的順序：先刪（騰出路徑）→ 改回路徑（目的地被預覽裡另一個要搬走的檔案佔著就等它；成環——例如互換名字——就把擋路的那一個先改名到一個空著的路徑，那一版標成不可合併、一定照順序送出，別台不會看到兩個檔案同時要同一個路徑）→ 寫回內容 → 復原已刪除的檔案（目的地被預覽外的檔案佔著就跳過 `occupied`，不覆寫）。
- 輕量成員：內容不在這台的檔案、範圍外不能新增的路徑，`restore` 丟 `VaultScopeError`，`restoreVault` 回報 `scope`。

### 檢查點與時間點（補充）

- 清單＝磁碟上同步中的每個檔案（磁碟上的版本），加上還在、但內容不在這台的（標成不在本機）；被排除、停止追蹤、刪除的不列。建立時把文字檔的內容確定存進 `hc:`（拿不到的標成不在本機），之後由檢查點參照住，歸檔清掉那個版本也不影響。
- 清單以差異鏈存：每個檢查點相對於前一個；平常只有最舊的一個是完整的（刪掉它時下一個改成完整的；刪掉中間的，下一個改成相對於再前一個）。實測（`tests/sync/vault/history.test.ts`）：5,000 個檔案（含中文路徑）的完整清單約 **573 KiB**（直接 JSON 的一半），改 10 個檔案的差異約 **1.2 KB**。
- 自動檢查點：每次工作結束、佇列與送出佇列都空、沒有在等的內容與版本時，最多每小時試一次；和最新的檢查點相同就不建立。依稀疏化規則保留（最新的一定在）；「還原之前」的保留天數內都留；命名的不動。
- 時間點：T 之前（含）最近的檢查點當起點，**檢查點之後歸檔**（歸檔序號 `n` 大於它的 `hn`）、時間不晚於 T 的版本蓋在上面（有蓋到就 `mixed: true`）；指定檢查點就是那一刻的清單（`mixed: false`）。沒有檢查點時逐檔取 `at ≤ T` 的最後一版（`reconstructed`、`mixed: true`）。用歸檔序號而不是 `at` 判斷「之後」，時間相同、或別台時間較早的版本晚到時都不會漏。檢查點建立時把混合邏輯時鐘推到它的時間，之後的本機版本一定比它晚。

### 測試

- 純函式（`history.test.ts`，18）：稀疏化各區段、日界、刪除不佔區段、合併版本同時間、版本數上限、永久保留、重複套用的性質（60 個種子）；容量；`fileStateAt`；預覽的四類、只限路徑、安全規則；清單的編碼、差異與大小。
- 協調器（`history-sync.test.ts` 24、`checkpoint.test.ts` 9）：見 `feat` 提交說明。
- 隨機性質測試（`property-history.test.ts`，12 個種子 × 150 個操作）：一台裝置把整個 vault 回到跑到一半的時間點、再用操作紀錄的「還原之前」檢查點回去；每一步之後各台一致、沒有卡住、沒有錯誤；還原前的每個 token 不是還在 vault 就是在這台的歸檔裡；回去之後一個都沒少，沒有跳過也沒有新衝突時整棵樹完全相同。
- 順手修正兩個既有缺口（時序改變讓既有的性質測試撞出來，各加確定性的回歸測試；另一個提交）：只走直連的大檔內容，完整成員背景維護時也會再要一次（唯一有內容的那台在對方送摘要時正好排除了它）；輕量成員被擋下的路徑之後由同步中的檔案佔用時，不再一直列在 `blockedLocal()`。

### 和草案、裁示的差異

1. **T 之後建立的二進位檔不刪**（`removeCreatedAfter` 也一樣，回報 `binary`）；同理要覆寫的現有內容不在歸檔就不覆寫。裁示 2 不存二進位內容，刪了或覆寫了就找不回來，違反「還原本身可以再還原」。
2. **`restore(path, versionId)` 是「把那一版的內容寫到 `path`」**：`path` 上有別的檔案時寫成那個檔案的新版本，而不是拒絕；整個 vault 的改名與身分由 `restoreVault` 處理。
3. **`vaultAt` 回傳物件**（`VaultSnapshot`，含 `source`、`mixed`），不是清單——補充 4 要求註明來源。
4. **「優先用最近的檢查點」做成「從檢查點開始、蓋上之後到 T 的變動」**：只用檢查點會讓「回到 5 分鐘前」實際回到 55 分鐘前；蓋上的部分以 `mixed` 標示。要確切的狀態就指定檢查點。
5. **還原寫入經 `applyRemote`**（有的話）：開著的筆記交給編輯器處理；CinderSync 的 `applyRemote` 在歷史開啟時不必再備份到 `.trash`（裁示 5）。
6. **「還原之前」的檢查點不稀疏化**，只依保留天數過期（同一小時內的兩次還原都要能各自復原）。
7. **時間是混合邏輯時鐘**（版本的 `at`），可能略快於牆上時間；「回到剛才」請用操作紀錄的檢查點，不要用 `Date.now()` 算。
8. 5,000 個檔案的**完整**清單約 573 KiB（路徑長、含中文時），略高於「幾百 KB」的上緣；但整個歸檔平常只有一份完整的清單，其餘都是差異（每改一個檔案約 120 B）。

### 待決

- CinderSync 的介面（檔案歷史視窗、最近刪除、整庫還原的預覽、檢查點列表、設定頁）與 `.trash/cindersync-backup` 在歷史開啟時停用——外掛 ADR（CinderSync ADR 0039–0041，已完成）。
- 要不要讓使用者明確選擇「刪掉 T 之後建立的二進位檔」（目前一律不刪）。→ 裁示 1 乙，v0.50。
- 「還原之前」檢查點的保留期是否要和一般歸檔分開設定。→ 裁示 2 甲，v0.50。
- 歸檔的中繼資料啟動時整份讀進記憶體（每版約 200 B）：極大的 vault（數萬個檔案 × 100 版）要不要改成按需載入。→ 裁示 3 乙，v0.50。

### 使用者裁示（2026-10-08，〈待決〉三題；v0.50.0 實作）

| # | 事項 | 裁示 |
|---|---|---|
| 1 | 整庫還原時，T 之後建立的二進位檔 | **乙**：`planRestoreVault` 新增選項 `removeCreatedBinaries`（預設 `false`，只在 `removeCreatedAfter` 打開時才有效）。打開時，這些二進位檔列入「刪除」，並標示 `irreversible: true`（歸檔沒有內容，「復原這次還原」救不回來），預覽附上總大小。應用要在刪除前自行備份：CinderSync 先複製到 `.trash/cindersync-backup`（CinderSync ADR 0040 的原則：歷史保護不到的才用備份） |
| 2 | 「還原前」檢查點的保留期 | **甲**：跟著歷史的保留天數（`keepDays`）過期，不另設。過期後，操作紀錄**保留**那一筆，但標示 `undoAvailable: false`（原因：還原前的檢查點已過期）；應用把「復原」按鈕停用並說明 |
| 3 | 很大的 vault 的歸檔版本資訊 | **乙：用到時才載入**。啟動時只載入每個檔案的摘要（筆數、最新／最舊時間、佔用大小、是否有已刪除版本）；`history()` 第一次被呼叫時才讀那個檔案的完整紀錄（之後快取，用 LRU 限制記憶體）；整庫的 `vaultAt`／`planRestoreVault`／清理改為逐檔串流讀取。舊格式（v0.49.0 的 `ha:`）在啟動時一次性遷移出摘要 |

### 實作（v0.50）

#### API 變更

| 項目 | v0.49 | v0.50 |
|---|---|---|
| `history(target)` | 同步回陣列 | **回 Promise**（第一次用到那個檔案才讀完整紀錄） |
| `vaultAt(T \| { checkpoint })` | 同步 | **回 Promise**（逐檔讀） |
| `planRestoreVault(...)` | 同步 | **回 Promise**；新選項 `removeCreatedBinaries`（只在 `removeCreatedAfter` 打開時有效） |
| `VaultRestorePlan` | — | 新欄位 `irreversibleBytes`（`remove` 裡標 `irreversible` 的總大小，沒有是 0） |
| `VaultRestoreItem` | — | 新欄位 `irreversible?: true` |
| `restoreVault(plan)` | — | `restoreVault(plan, { beforeIrreversible? })` |
| `readHistory(v)`、`restore(path, v)` | `v` 是版本 id | 也接受 `{ fileId, versionId }`（例如 `history()` 回來的那一筆；最快） |
| `operations()` 的每一筆 | — | 新欄位 `undoAvailable: boolean`、`undoUnavailable?: 'before-expired' \| 'before-deleted' \| 'before-evicted' \| 'no-checkpoint'` |
| `VaultRestoreSkipReason` | — | 新增 `backup-failed` |
| `VaultHistoryErrorCode` | — | 新增 `checkpoint-expired` |
| 純函式 | `buildRestorePlan` | 另外匯出逐檔的 `emptyRestorePlan`／`addToRestorePlan`／`finishRestorePlan`（`RestoreFileContext`）；`CurrentFile` 的 `live` 可帶 `text`、`size` |

`historyStatus()`、`deletedFiles()`、`checkpoints()`、`operations()` 仍是同步的（從摘要與記憶體裡的檢查點算）。
三個方法改成非同步是 **breaking**；CinderSync 是唯一的使用者，同版調整（CinderSync ADR 0042）。

#### 裁示 1：T 之後建立的二進位檔

- 預覽：`removeCreatedAfter` 與 `removeCreatedBinaries` 都打開時，T 之後建立、內容不在歸檔的**二進位檔**列入 `remove`，標 `irreversible: true`，大小加進 `irreversibleBytes`；文字檔的內容不在歸檔照樣不刪（`content-missing`）。現在這一版的大小與是否文字檔由 `CurrentFile` 帶（不必為了預覽讀完整的歸檔）。
- 執行：`restoreVault(plan, { beforeIrreversible })`。每一個不可復原的刪除，在「磁碟上的內容確認和預覽相同」之後、**正要刪之前**呼叫一次 `beforeIrreversible(item)`（`item.path` 是現在的路徑）；丟錯或回 `false` 就不刪那個檔案、回報 `backup-failed`（`error` 是丟出的錯誤），其他照常。刪除仍帶前置條件，備份之後檔案又被改了就不刪（`changed`）。
- **為什麼是逐檔的回呼，而不是預覽前一次備份全部**：(1) 執行時才知道哪些真的會刪（之後被改的、被跳過的不必備份）；(2) 回呼時協調器已經確認磁碟上的內容就是要刪的那一份，備份的正是被刪掉的內容；(3) 一個備份失敗只影響那一個檔案。回呼在協調器的工作佇列裡執行，裡面不要呼叫這個協調器的其他方法（會互等）。
- 沒給 `beforeIrreversible`：照預覽直接刪（應用在預覽時已經明確選了 `removeCreatedBinaries`）。SDK 不備份這些檔案。

#### 裁示 2：「還原之前」的檢查點跟著保留天數

- 行為本來就是跟著 `keepDays`（v0.49 的 `#cpRetain`）；v0.50 加測試確認（到期前一刻還在、過了就清；`keepDays: Infinity` 永不過期）。
- 檢查點被清掉時，拿它當 `before` 的操作紀錄記下原因（存在 `ho` 的 `ux`：過期 `expired`、`deleteCheckpoint` 刪的 `deleted`、容量整理清的 `evicted`），重開後照樣在。`operations()` 換成 `undoAvailable`／`undoUnavailable`；單一檔案的 `restore` 沒有檢查點，是 `no-checkpoint`。
- 拿過期的檢查點復原：`planRestoreVault({ checkpoint })`、`vaultAt({ checkpoint })` 丟 `VaultHistoryError('checkpoint-expired')`（`versionId` 是檢查點 id）；其他不在的檢查點照舊 `checkpoint-unknown`。

#### 裁示 3：用到時才載入——儲存格式

| 鍵 | 內容 | v0.49 |
|---|---|---|
| `ha:<fileId>` | 一個檔案完整的歸檔，**格式不變** | 同 |
| `hs:<00–ff>` | **新**：每檔摘要的分片（fileId 的 FNV-1a 低 8 位，256 片），`{ fileId: 摘要 }`。摘要：`c` 版本數、`o` 最舊時間、`l` 最新的一版（整筆）、`lv` 最新一版是刪除時刪除前最後一版、`ps` 其他用過的路徑（最多 16）、`b` 佔用、`d` 有刪除、`nx` 最大歸檔序號、`top` 歸檔過的最新時間、`w` 在等內容的雜湊、`t` 下一次稀疏化可能有變化的時間、`born`、`cut` | — |
| `hc:<sha256>` | **改**：`00 63 68 32`（魔術字）＋4 位元組長度＋參照的檔案（fileId 的 JSON 清單）＋內容 | 只有內容 |
| `hq` | **新**：只有檢查點留著、沒有任何檔案參照的內容 `{ 雜湊: 大小 }` | — |
| `m` | 多了 `hv: 2`（格式版本）、`hl`（歸檔和版本圖之間沒有缺口） | — |
| `hk:`、`ho` | 不變（`ho` 每筆多了 `ux`） | 同 |

**為什麼摘要用 256 個分片**，而不是每檔一個 `hs:<fileId>` 或整份一個索引：
- 每檔一個鍵：啟動要讀 2 萬次；CinderSync 的 IndexedDB 每次 `get` 是一個交易，數萬次要好幾秒。
- 整份一個索引：每次改一個檔案就要重寫整份（2 萬檔約 8 MB）。
- 256 片：啟動讀 256 次；改一個檔案只重寫它那一片（2 萬檔時一片約 30 KB，小 vault 只有幾 KB）。

**為什麼內容帶「參照的檔案」**：v0.49 的參照數在記憶體裡、啟動時讀完所有版本重建——這正是要拿掉的事。改成每份內容自己記得哪些檔案參照它：一個檔案第一個版本參照、最後一個版本放開時才讀寫那份內容；檔案的版本參照幾次只看那個檔案自己的紀錄（讀進來時算）。檢查點的參照照舊在記憶體（啟動時從清單建立，大小是「檢查點裡的檔案數」等級，不是版本數）。沒有任何檔案參照、只剩檢查點留著的內容記在 `hq`，檢查點放開時刪。寫入順序讓當機只會留下多的內容（之後由 `clearHistory` 清），不會少。不另外用 `hr:<雜湊>` 記參照：鍵的數量會加倍（CinderSync 的 `keys()` 是整個資料庫的 `getAllKeys`）。

**佔用（`bytes`）怎麼算**：各檔摘要的 `b`（那個檔案的版本參照的內容，檔案內以雜湊去重）＋`hq`。和 v0.49 的差別：**不同檔案剛好內容相同時各算一次**（磁碟上只存一份），所以 `bytes` 可能略高於實際（偏保守，容量整理會早一點清）。

**載入與快取**：
- 啟動：讀 `hs:` 分片與 `hq`，建立摘要、在等內容的雜湊、佔用；**不讀任何 `ha:`**。
- `history()`、`readHistory()`、`restore()`、歸檔新版本：第一次用到那個檔案時讀 `ha:`，放進 LRU 快取（最多 256 個檔案或 2 萬版，先到先算）；改過還沒寫回的不清；只在沒有人拿著歸檔物件的時候整理（每次工作結束、整庫整理的檔案之間）。同一個檔案同時有兩處要讀時共用一次讀取。
- 只給版本 id 時：先找快取、摘要（最新一版、刪除前一版）、版本圖，都沒有才逐檔找（慢）；給 `{ fileId, versionId }` 直接讀那個檔案。
- 整庫（`vaultAt`、`planRestoreVault`）：在佇列裡跑但不算「同步中」（`#runRead`：不歸檔、不寫回、不觸發自動檢查點），逐檔判斷，用不到快取的讀完就丟。**摘要夠用就不讀**：沒有檢查點時 T 晚於那個檔案最新一版；從檢查點推算時那個檔案在檢查點之後沒有新歸檔（`nx ≤ hn`）、或最新一版就是要蓋上的那一版；指定檢查點時清單的版本就是摘要的最新一版。
- 稀疏化：背景維護只整理摘要的 `t`（某一版跨過 1 小時、1 天、保留天數的最早時間）到了的檔案，或版本數超過上限的；`setHistory` 整理全部。容量整理以摘要的最舊時間建小根堆，用到才讀那個檔案，從所有檔案裡最舊的、可以清的版本開始清（和 v0.49 的順序相同）。整庫整理每 128 個檔案寫出一次、清一次快取。
- 補版本圖的版本：`m.hl`（歷史一直開著、沒有缺口）時，啟動只補比摘要 `top` 還新的版本，不逐檔比對；歷史關閉過（啟動時關著、或 `setHistory` 關掉）就清掉 `hl`，下次打開時逐檔比對（工作結束時讀歸檔去重）。

**遷移（v0.49 → v0.50）**：`m` 沒有 `hv: 2` 時，啟動時：
1. 逐檔讀 `ha:`（格式不變、不改寫），算出摘要；順便和版本圖比對，補上還沒歸檔的版本（v0.49 每次啟動做的事，這樣遷移後不必再逐檔讀一次）。
2. 逐個讀 `hc:`：有檔案參照的改寫成「參照的檔案＋內容」，只有檢查點留著的記進 `hq`，都沒有的（寫到一半重開留下的）刪掉。`hc:` 兩種格式都讀得懂（有魔術字才當新格式），改寫是冪等的。
3. 最後寫出摘要、`hq` 與 `m`（`hv: 2`、沒有缺口時 `hl`）。中途中斷就整個重做。
v0.49 今天才發布，實際要遷移的歸檔很小；測試用預先放好 v0.49 格式的狀態儲存驗證（`tests/sync/vault/history-lazy.test.ts`），含中斷後重做。

**降級**：v0.50 寫過的狀態儲存給 v0.49 讀，`hc:` 的值帶了標頭、雜湊對不上，歷史內容會讀不到（不影響同步）。不提供降級遷移。

#### 實測（`scripts/bench-history.mjs`）

合成 v0.49 格式的歸檔：20,000 個檔案 × 每檔 50 版（文字檔 80%、每份內容 120 B；共 100 萬版、80 萬份內容、狀態儲存 82 萬個鍵），記憶體狀態儲存，Node 26、`--expose-gc`，同一台機器（負載不同時數字差到 2 倍，列範圍）：

| | v0.49.0 | v0.50.0 第一次啟動（遷移） | v0.50.0 之後的啟動 |
|---|---|---|---|
| `start()` | 4.0–10.5 秒 | 9.5–23 秒（一次） | **0.15–0.53 秒** |
| 啟動後堆積增量 | **+392 MiB** | +11.9 MiB | **+11.2 MiB** |
| 第一次 `history(某檔)` | 0.1–3 ms | 1–2 ms | 0.3–0.9 ms |
| `vaultAt(剛才)`（摘要夠用） | 94–151 ms | 26 ms | 46–89 ms |
| `planRestoreVault(7 天前)`（合成資料每個檔案 7 天內都有版本：每檔都要讀） | 55–97 ms | 2.6–3.0 秒 | 2.6–2.7 秒 |

整庫預覽在「每個檔案都有變動」時變慢（要逐檔讀），這是用啟動時間與常駐記憶體換的；實際的 vault 只有變動過的檔案需要讀。這些數字不進 CI、測試裡也沒有計時的斷言。

#### 測試

- `history-lazy.test.ts`（13）：啟動不讀任何 `ha:`、概況與最近刪除照樣有、`history()` 第一次才讀且之後走快取、快取上限（300 個檔案）、整庫時間點只讀有變動的檔案、從 v0.49 格式遷移（含孤兒內容清掉、補回版本圖的版本、命名檢查點照樣還原、之後啟動不再遷移）、遷移中斷重做、歷史關閉過後的逐檔補、容量逐檔整理；二進位檔（預覽的兩個開關、`beforeIrreversible` 的呼叫時機與內容、丟錯／回 false、沒給回呼、預覽之後被改了）；還原前的檢查點過期（到期前後、重開、`checkpoint-expired`、`before-deleted`、`no-checkpoint`、永久保留）。
- `history.test.ts`：`removeCreatedBinaries` 的純函式測試。
- 歸檔的完整性檢查（`history-integrity.ts`）：每份內容的參照者真的參照它、每個有內容的版本內容都在、摘要和 `ha:` 一致、`bytes` 等於重算的值；性質測試（`property-history.test.ts`）每次還原與復原之後對每台都檢查。
- 既有測試改成 `await`（`history`／`vaultAt`／`planRestoreVault`）。

#### 和裁示的差異

1. **`bytes` 不再跨檔案去重**（見上）：要精確就得在記憶體裡留全部的雜湊，違反裁示 3 的目的。偏高、不偏低。
2. **摘要比裁示列的多**：除了筆數、最新／最舊時間、佔用、是否有已刪除版本，還存最新的一版整筆、刪除前一版、用過的路徑、在等的內容、下一次稀疏化的時間與歸檔序號——`deletedFiles`、路徑查詢與「時間點只讀有變動的檔案」需要；每檔約 400 B（2 萬檔約 11 MiB 堆積）。
3. **整庫預覽也排進佇列**（`#runRead`）：逐檔讀之間不會看到同步改到一半的狀態；不算「同步中」、不觸發自動檢查點。
4. **`readHistory`／`restore` 多接受 `{ fileId, versionId }`**：只給版本 id 而它不在快取、摘要、版本圖時要逐檔找；介面上給整筆最快。
5. **`beforeIrreversible` 是 `restoreVault` 的選項**（每次呼叫），不是協調器的選項：備份的位置與失敗時怎麼回報由那次操作的介面決定。

#### 待決

- 整庫預覽在大 vault、而且 T 很早時要讀很多 `ha:`（IndexedDB 上 2 萬次讀取可能要數秒）：CinderSync 的預覽要顯示讀取中；之後可以考慮在摘要多存「每天最後一版」讓更早的 T 也不用讀。
- CinderSync 的 `keys(prefix)` 是整個資料庫的 `getAllKeys` 再篩：歸檔很大時（數十萬個 `hc:`）每次列舉都會把所有鍵讀出來；協調器啟動時仍會列舉 `f:`、`q:` 等。可以改用 `IDBKeyRange`（外掛的事）。

### 風險

- 歸檔只在有歸檔的裝置上；裝置遺失或重灌，那台的歷史就沒了（裁示原則，不變）。
- 本機空間：預設上限 1 GiB 不含命名檢查點釘住的內容；50 個命名檢查點理論上可以釘住很多內容（`pinnedBytes` 讓應用顯示）。
- 別台收到還原產生的改名時，若收到的順序顛倒，和使用者自己連續改名一樣可能產生路徑相撞的衝突副本（既有行為，內容不遺失）；成環的情形已經以照順序送出的暫存改名避免同一台送出時的相撞。
- 還原會在短時間內產生很多版本（每個檔案一個），大量還原會進入批次模式、受中繼的塊數預算限制（既有機制）。
- 時間點推算（沒有檢查點、或 T 在檢查點之後）可能組合出從沒同時存在過的版本（`mixed`）；稀疏化後越久以前越不精確。

## Consequences（預期）

- ＋ 誤刪、改壞都找得回來，中繼完全不受影響。
- ＋ 和 Obsidian Sync 不同：歷史不在雲端，「伺服器看不到、也不保存」的承諾不變。
- － 歷史只存在有歸檔的裝置上。裝置遺失或重灌，那台的歷史就沒了；需要長期歷史，要靠一台長保留的完整成員。
- － 本機空間增加；預設上限與稀疏化用來控制。
- － 某台裝置**加入前**的歷史它看不到，因為歷史不同步。
