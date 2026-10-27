# 0046. Markdown 同一行衝突就地放進 callout（取代衝突副本）；模式由版本資料決定（v0.36.0）

- 狀態：**已接受（Accepted）**——2026-10-01，使用者核准；實作於 v0.36.0
- 日期：2026-10-01
- 補註（2026-10-05，[ADR 0059](0059-markdown-merge-rules-same-path-creation-and-task-checkboxes.md)）：同一套「由版本 id 的標記決定模式」用在 Markdown 合併規則（標記在 id 的第 17–24 位，與 callout 的標記並存）；callout 合併先試勾選框規則，解不開的才放進 callout。
- 相關：本 repo ADR 0011 §3（`merge3`）、**0025**（協調器、確定性合併、衝突副本、`computeHeads` 的涵蓋規則）、0028（名單、G9 能力宣告的前身）、
  0035 §G9（`declareCapabilities`、`minCapability`）、0045（排程同步）；CinderSync 的衝突呈現決定（使用者，2026-10-01）

## Context

排程同步（CinderSync ADR 0018）讓「兩台在兩輪之間改了同一行」變多。ADR 0025 的規則是：`merge3` 有衝突就把較晚的一方留在主檔、
另一方的**完整**內容存成衝突副本（`筆記 (衝突-iPhone-20261001-104500).md`）。對筆記來說這很難收拾：要開兩個檔案逐行比對，
而且衝突的通常只有一兩行。使用者的決定：

1. Markdown 檔的同一行（同一個 merge3 衝突區塊）衝突，改為在檔案裡**插入 Obsidian callout**，只包住衝突的那幾行；其他部分照常三方合併。
2. callout 裡放**所有**衝突版本（包含「你這邊的」），每段標示**裝置名稱與時間**；被取代的版本也在裡面，**不再另存衝突副本**。
3. 「兩個都留」依時間排序（舊 → 新；時間相同依裝置 id 等確定性鍵）。
4. 外掛做「解決衝突」命令；SDK 提供解析與解決的 API。

硬限制：**確定性**（ADR 0025：每台裝置對同一組版本頭算出位元組相同的結果與版本 id）、**模式選擇也必須確定性**、只對 `.md`、
特殊內容要安全轉義或退回、機器可解析、已存在的 callout 再衝突要收斂不巢狀。

## 決策

### 1. 格式（定案）

（id 為示意；`mac`／`phone` 是 deviceId，`MacBook`／`iPhone` 是版本節點的 `label`）

```
> [!conflict]- 同步衝突（2 個版本） %% cinder-conflict:3fa1c2d4e5b6 %%
> **MacBook · 2026-10-01 10:32 UTC** %% cinder-version:1790850725000:mac %%
> 我這樣改
>
> **iPhone · 2026-10-01 10:45 UTC** %% cinder-version:1790851500000:phone %%
> 我那樣改
> 而且多一行
>
```

- `[!conflict]-`：自訂 callout 類型、預設摺疊（Obsidian 對未知類型用預設樣式；外掛可以用 CSS `.callout[data-callout="conflict"]` 上色）。
- 標題文字**固定**（「同步衝突（N 個版本）」）：它是檔案內容的一部分，各裝置必須一樣，所以不能隨裝置語言或外掛設定改變；也不寫產品名（SDK 中立）。
- **衝突 id**：12 位 hex，`sha256("cinder-conflict\0" + JSON([[at, device, lines]…]))` 的前綴——只由排好的版本決定。
- 每個版本一行標頭：`**名稱 · YYYY-MM-DD HH:MM UTC**` 加 `%% cinder-version:<at 毫秒>:<deviceId> %%`；內容逐行加 `> `（空行是單獨的 `>`）；
  每個版本後面固定一行單獨的 `>`（分隔；最後一個是結尾，擋掉 Markdown 的「懶惰續行」，後面不必插空行）。
- `%% … %%` 是 Obsidian 註解：閱讀模式看不到，標記不干擾閱讀。
- **時間一律 UTC、到分鐘**：要位元組相同就不能用各裝置的時區。取捨：使用者在檔案裡看到的是 UTC；精確的毫秒在標記裡，
  外掛的「解決衝突」畫面用 `versions[i].at` 轉成本地時間顯示。不用 ISO（`2026-10-01T10:32:05.000Z`）是因為難讀。
- **裝置名稱取自版本節點的 `label`**（寫入那台的 `deviceLabel`，隨版本同步、不可變），不看名單：名單的 `deviceName` 在各裝置可能不同步。
  名稱裡的控制字元換成空白、Markdown 字元加反斜線；`label` 空的用 deviceId。
- **沒有相對字眼**（「你這邊」）：哪一段是本機由外掛比對 `versions[i].device === 本機 deviceId` 標示。
- 排序：`(at, device, 內容)`；同一裝置、同一時間、同樣內容去重。

### 2. 模式選擇：由版本資料決定

不能看各裝置當下的名單能力（名單同步可能延遲，A 認為對方都支援、B 還不知道 → 兩台算出不同的合併 → 分岔）。

- **能力記在版本 id 裡**：開了 `conflictCallouts` 的裝置產生的本機版本 id ＝ 隨機 24 位 hex ＋ `sha256("cinder-callout-v1\0" + 前 24 位)` 的前 8 位
  （`markCalloutCapableId`／`isCalloutCapableId`）。
  - 為什麼不加新欄位：舊版的 `parseVersion` 只保留已知欄位——舊版裝置存下、補送（摘要索取、`want`）的版本會**丟掉**旗標，
    先從舊版那裡收到這個版本的新裝置就會判斷成「不支援」，與直接收到的新裝置分岔。id 則會原樣經過任何版本的儲存與轉送。
  - 舊版的隨機 id 巧合符合的機率 2⁻³²；巧合時只是那個版本被當成支援（見 §4 的收斂）。
- **合併版本（兩個以上父版本）＝所有父版本都支援**。在**加入版本時**算好並持久化（`FileRecord.cm`），之後修剪祖先也不改變答案；
  v0.35 存下的紀錄沒有這一欄，用到時從版本圖補算（舊紀錄裡的版本都沒有標記，結果都是 false）。
  路徑相撞、衝突副本等由內容決定 id 的單父版本沒有標記＝不支援（保守）。
- **只有參與合併的所有版本頭都支援時才用 callout**（`planMerge(…, { callouts })`），否則照舊衝突副本。
  只對 **`.md`**（不分大小寫，看這一步合併後的路徑）、而且兩邊與共同祖先都是文字、拿得到祖先內容時；其他文字檔與二進位照舊。
- `conflictCallouts` 預設 **false**：這台寫出的版本不帶標記，與 v0.35 位元組相同。注意：沒開的新版裝置仍然**會**照版本資料
  算出 callout 合併（模式不看本機選項），所以同一組版本頭在每台新版裝置上結果一樣。

### 3. 收斂的證明（同 ADR 0025 的框架）

令 `c(v)` 為版本 v 的能力：非合併版本 `c(v) = isCalloutCapableId(v.id)`；合併版本 `c(v) = ∧ c(p)`（p 為父版本）。

1. `c` 只依賴版本圖本身：id 不可變；合併版本的父版本在它被加入時都已存在（協調器在父版本到齊前把版本放在等待區，ADR 0025），
   所以加入時算出的 `c(v)` 與任何一台、任何時間算的一樣；之後修剪祖先不重算（持久化）。
2. 合併模式 `m(H) = ∧_{h∈H} c(h)` 只依賴版本頭集合 H；`computeHeads` 的版本頭與順序本來就只依賴版本圖（ADR 0025）。
3. `planMerge(nodes, H, content, { callouts: m(H) })` 是純函式：callout 的內容只用到版本頭的 `label`／`device`／`at`／內容與共同祖先的內容，
   排序與 id 都是確定性的。所以任何兩台有同一組版本頭的新版裝置，算出位元組相同的內容、同一個雜湊、同一個合併 id
   （`deterministicId('merge', 排序後的版本頭, 雜湊, 路徑)`）——收到對方的合併版本就是「已經有了」。
4. 多於兩個版本頭時依 `computeHeads` 的順序兩兩合併；前一步產生的 callout 在下一步衝突時會被**攤開併入**（§5），
   版本排序不看合併順序，所以 {a,b} 再併 c 與 {a,c} 再併 b 得到同樣的 callout；即使衝突區塊的邊界不同而結果不同，兩個合併版本
   互相涵蓋（同一組葉子），`computeHeads` 的涵蓋規則留 id 較小的那個——兩者都含全部版本的內容，選哪個都不遺失資料。

例外（都收斂、都不遺失資料，只是可能多一個節點或一份副本）：

- **v0.35 以前的裝置**不認得標記，對同一組「都支援」的版本頭算出衝突副本版本；新版算出 callout 版本。兩個合併版本父版本相同 → 互相涵蓋 →
  每台（含舊版，涵蓋規則相同）都留 id 較小的那個；舊版建立的衝突副本檔案會留下（多一份內容，不遺失）。
- **孤兒**：父版本等了 `orphanAfterMs`（一天）還沒到、被直接併入的版本，在那台裝置上算成不支援，與其他裝置可能不同 → 同上，靠涵蓋規則收斂。
- 標記的 2⁻³² 巧合：同上。

### 4. 與 G9 能力宣告（名單 `caps`）的關係

能力宣告**不參與**模式選擇（理由見 §2），只給 UI 用：開了 `conflictCallouts` 的應用宣告
`membership.declareCapabilities({ ...CURRENT_DEVICE_CAPABILITIES, [CONFLICT_CALLOUTS_CAPABILITY]: true })`（鍵是 `conflictCallouts`），
UI 以 `membership.devices().filter((d) => membership.capabilitiesOf(d.pubkey)?.conflictCallouts !== true)` 找出還沒升級（或沒開）的裝置，
提示「這些裝置參與的同一行衝突仍會產生衝突副本」。名單的 `caps` 允許額外的布林欄位，舊版原樣保留、照驗簽章（ADR 0035），不需要改名單格式。

### 5. 特殊內容：轉義或退回衝突副本

`mergeWithConflictCallouts(base, local, remote, authorOf)` 任何一處不安全就回 null，協調器退回衝突副本（舊行為），不損壞內容、不遺失資料：

| 情況 | 處理 |
|---|---|
| 版本內容是引言或已有的 callout 開頭（`> …`、`> [!note]`） | 轉義：再加一層 `> `（`> > [!note]`），解析時剝一層，往返不變 |
| 空行、整段刪掉的版本 | 空行＝單獨的 `>`；刪掉＝版本沒有內容行，選它就是刪掉那幾行 |
| CRLF | 三份都是純 CRLF：轉成 LF 合併、再轉回；`parse`／`resolve` 也認得並維持 CRLF。**換行混用 → 退回** |
| 衝突在程式碼圍欄裡、在 front matter 裡、或檔案開頭的 `---` 被改 | 退回（callout 會變成程式碼或破壞 YAML） |
| 衝突處前一行或後一行是 `>` 開頭 | 退回（會併進同一個引言區塊） |
| 版本內容有未閉合的圍欄、單數個 `%%`／`$$`、`<!--` 與 `-->` 不成對、含 `\r` | 退回（會吞掉 callout 後面的行） |
| 版本內容帶著 `cinder-conflict:`／`cinder-version:` 標記（半個 callout、或使用者自己打的） | 退回（不巢狀） |
| 超過 16 個版本、2,000 行或 256 KiB | 退回 |

**2026-10-02 補註（ADR 0048，v0.37.1）**：三方合併合不起來、其中一方是 0 位元組時，直接採用有內容的一方——不放 callout、也不產生副本（空白的那一段沒有任何內容會遺失）。此判斷先於 callout，只看版本大小，每台一致。

### 6. 已存在的 callout 再次衝突

- 衝突區塊的一邊**整段就是一個 callout**（例如 a、b 已合出 callout，第三台 c 離線時也改了同一行）：把它的版本**攤開併入**新的 callout
  （去重、重排、重算 id）——一個 callout、三個版本，不巢狀。
- 一邊是 callout 的**一部分**或帶著標記的其他內容：退回衝突副本（§5）。
- 兩台**各自解決得不一樣**（共同祖先是 callout，兩邊都拿掉了 callout、留下不同的內容）：新的 callout 只放兩個解決結果，
  標示解決的裝置與時間；原本的版本已經被兩邊的使用者處理過，不再出現。
- 一台解決、另一台沒動：乾淨合併成解決後的內容。
- 已知的外觀問題：衝突區塊的邊界由 diff 決定，極少數情況下再衝突的 callout 前後可能多一個空行（確定性、不影響內容）。

### 7. API

`@cinderous/client/sync/vault`：

- `VaultSyncOptions.conflictCallouts?: boolean`（預設 false）。
- `VaultConflict.callouts?: string[]`：`kind: 'text'`、就地放進 callout 時帶衝突 id，沒有 `copyPath`。
- `parseConflictCallouts(text): ConflictCallout[]`——`{ id, versions: [{ label, device, at, lines }], startLine, endLine, start, end }`
  （行號與字元位置，給編輯器捲動與標示用）。手動刪掉的 callout 自然不在結果裡＝已解決。
- `resolveConflictCallout(text, id, choice)`——`choice`：版本索引、`'both-by-time'`、`{ text }`。回傳新的全文，由外掛寫回
  （成為新的本機版本，正常同步）；找不到 id 丟例外、索引超出範圍丟 `RangeError`；CRLF 維持 CRLF。
- 純函式也匯出：`mergeWithConflictCallouts`、`renderConflictCallout`、`isMarkdownPath`、`markCalloutCapableId`、`isCalloutCapableId`、
  `supportsConflictCallouts`、`CONFLICT_CALLOUT_*` 常數、`CONFLICT_CALLOUTS_CAPABILITY`；`merge3Chunks`（`./sync`）。

## 線上格式與相容

- **版本節點沒有新增欄位**：能力在 id 裡。舊版照常解析、儲存、轉送這些版本；它們的合併規則不變（§3 的例外）。
- 協調器的 `f:` 紀錄多一個選配欄位 `cm`（能力快取），舊版讀到忽略；新版讀不到就補算。
- 預設（`conflictCallouts: false`）與 v0.35 位元組相同：本機版本 id 不帶標記，同行衝突照舊衝突副本（測試釘住）。

## 給 CinderSync 的「解決衝突」命令

1. 協調器 `conflictCallouts: true`；`declareCapabilities` 加 `conflictCallouts: true`；設定頁提示名單上沒宣告的裝置。
2. `conflict` 事件有 `callouts` 時：通知「`path` 有 N 處衝突」，提供開啟檔案＋「解決衝突」。
3. 命令（作用中的 Markdown 檔）：`parseConflictCallouts(editor.getValue())` → 逐處顯示 Modal：每個版本一張卡片（名稱、`at` 轉本地時間、
   `device === 本機` 標「這台」、內容），按鈕「用這個版本」（索引）、「兩個都留（依時間）」、「手動編輯」（預填 both-by-time 的文字、存回 `{ text }`）。
   每處 `resolveConflictCallout` 後以 `vault.process`（或編輯器交易）寫回、通知協調器；沒有了就結束。手動刪掉 callout 也算解決。
4. 可以用 `startLine`／`endLine` 在編輯器裡捲到該處、加 CSS `.callout[data-callout="conflict"]`。
5. 狀態列的「衝突」計數：掃描有 callout 的檔案（`parseConflictCallouts(...).length`），或沿用 `status().conflicts`（記錄性質）。

## 驗證（TDD）

- `tests/sync/vault/conflict-callout.test.ts`（純函式）：格式逐位元組（golden）、local／remote 對調位元組相同與同一個 id、時間相同依裝置排序、
  名稱轉義、空行與刪除版本往返、`.md` 判斷；parse 的 id／版本／行號／字元位置；選版本／兩個都留／自訂文字、索引超出範圍、找不到 id、
  手動刪除＝已解決、多處逐一解決、檔尾（有無結尾換行）精確還原；CRLF 往返、換行混用、圍欄內與未閉合圍欄、成對圍欄放得進、front matter、
  緊鄰引言、引言與 callout 開頭的轉義往返、標記／`%%`／`<!--`、超長；再衝突攤開併入、兩台解決不同、一台解決一台沒動。
- `tests/sync/vault/conflict-callout-sync.test.ts`（協調器）：id 標記與合併版本的能力推導、預設不帶標記（衝突副本，釘住）、
  兩台都支援 → 位元組相同與同一個 id、沒有副本、事件帶 callouts；解決後寫回同步到另一台；`.txt` 照舊副本；圍欄內退回副本且內容完整；
  一台沒開 → 兩台都是副本；三台同時改同一行 × 5 個種子（不同到達順序）位元組相同、一個 callout、三個版本依時間排序；
  兩台各自解決不同 → 新 callout 兩個結果；callout 還在時第三台改同一行 → 併入同一個 callout。拿掉 callout 路徑時 9 個失敗。
- `tests/sync/vault/property-callout.test.ts`：隨機操作（含同行衝突、延遲、重送、斷線、重啟）× 24 個種子 × 兩種模式（全部支援、混一台沒開）：
  位元組相同、沒有遺失（每個沒被使用者刪掉的 token 都在原檔、callout 或副本裡）、沒有卡住的版本、沒有巢狀 callout、callout 真的出現。
  另以 150 個種子 × 兩種模式跑過一次。
