# 0087. 衝突 callout 後空一行：Obsidian 不再把下一行內文算進 callout

- 狀態：**已接受（Accepted，2026-10-15）**——使用者 2026-10-15「兩個需要我決定的：依你建議方式修復」（選項 A：補空行，新舊版混用另開 ADR 處理）
- 日期：2026-10-15
- 對應：ADR 0025（確定性合併）、**0046**（衝突 callout；模式由版本 id 的標記決定）、**0059**（合併規則的標記與名單開關——本 ADR 照抄它的機制）、
  0035 §G9（能力宣告）；CinderSync ADR 0077（同時發現）

## Context
ADR 0046 的 callout 最後一行是單獨的 `>`，標準 CommonMark 在那裡結束引言；但 **Obsidian 1.14 會把 callout 下一行的內文也算進 callout**
（懶惰續行，閱讀模式與即時預覽都是）。callout 預設摺疊（`[!conflict]-`），那行內文就直接看不到——使用者會以為內容不見了。

只有空行能結束 Obsidian 的引言。但 callout 是確定性合併的輸出：合併版本的 id 含內容雜湊（`deterministicId('merge', …heads, hash, path)`），
同一組版本頭在新舊版各自算出不同位元組，就是兩個不同的合併版本，再互相合併；舊版遇到「callout 後多一行空行」的那一邊，
`exactCallout` 不認得、又看到標記 → 退回衝突副本。直接改格式會讓新舊版混用時分歧、多出副本。

## Decision
照 ADR 0059 的做法，**模式由版本資料決定、名單上所有成員都宣告才啟用**：

1. **標記**：版本 id 第 9–16 位是前 8 位的雜湊（`markCalloutBreakId`／`isCalloutBreakId`；標籤 `cinder-callout-break-v1`）。
   與合併規則（17–24 位）、callout（最後 8 位）的標記可以同時帶，依序標這個、合併規則、callout（後者只改自己的位置、保留前面的）。
   合併版本＝父版本都帶（`supportsCalloutBreak`，加入時算好、持久化在紀錄的 `cb`，同 `cm`／`mr`）。
2. **開關**：協調器選項 `calloutBreak`（預設 false）與 `setCalloutBreak(on)`；能力鍵 `CALLOUT_BREAK_CAPABILITY = 'calloutBreak'`。
   應用在名單 `change` 時 `setCalloutBreak(membership.allDeclare(CALLOUT_BREAK_CAPABILITY))`——有任何一台（含舊版）沒宣告就關。
3. **模式**：callout 模式打開、且**所有**版本頭都帶標記時，`planMerge(…, { calloutBreak: true })`；否則與 v0.60 位元組相同（測試釘住）。
4. **新格式**：標題在 `cinder-conflict` 註解之前多一個 `%% cinder-break %%`（舊版的 `HEADER_RE` 照樣認得），callout 後**固定**接一個空行
   （不論下一行是什麼、在不在檔尾——固定才能在解決時精確拿掉）。
   - `parseConflictCallouts`：標題帶旗標、後面是空行 → 那個空行算進 callout（`endLine`／`end` 包含它）。`resolveConflictCallout` 因此一起拿掉，往返不多空行。
     沒有旗標的舊 callout 後面的空行是使用者的，不動。
   - 再衝突：新格式下，一邊是「帶旗標的 callout＋後面的空行」也算整個 callout（攤開併入、不巢狀）。舊格式照 v0.60（同舊版裝置的結果：退回衝突副本）。

## Alternatives Considered
- **直接改格式**：新舊版混用時分歧（見 Context）。
- **只在下一行不是空行時才補**：解決時分不出空行是補的還是使用者的；固定補＋旗標才能精確往返。
- **不改格式，只在文件提醒**：摺疊時看不到內容的誤導仍在。
- **新增版本欄位記格式**：舊版的 `parseVersion` 會丟掉新欄位、轉送時遺失；id 的標記會原樣經過舊版（ADR 0046 的理由）。

## Consequences
- ＋ 名單都升級後，新的衝突 callout 後面一定有空行，Obsidian 摺疊時不再藏住下一行。
- ＋ 新舊版混用時兩邊照舊格式、位元組相同；名單開關保證用新格式時名單上沒有舊版。
- － 已經存在的舊格式 callout 不會改寫，照舊會吞下一行，解決後就沒了。
- － 名單開關延遲（一台還沒關就寫了帶標記的版本）或之後加入舊版裝置：那時遇到帶旗標的 callout 的合併照舊格式，可能退回衝突副本（不遺失資料）。
- － 版本 id 的隨機部分再少 32 位（剩 64 位隨機，巧合碰撞仍可忽略）。
- 驗證：`tests/sync/vault/callout-break.test.ts`（格式、沒開時位元組相同、確定性、四種位置的解析與往返、舊 callout 的空行不動、再衝突不巢狀、
  沒開時遇到帶旗標的 callout 退回副本、標記的位置與並存、協調器：兩台都開＝新格式且解決後不多空行、一台沒開＝兩台都舊格式）；
  原有 `conflict-callout`、`conflict-callout-sync`、`merge-rules-sync` 全過。
