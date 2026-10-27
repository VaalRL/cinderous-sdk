# 0035. 補訂閱對禮物包退讓兩天（G8）、名單上的裝置能力宣告（G9）、內容相同的路徑相撞直接收斂（G10）

- Status: Accepted
- Date: 2026-09-30
- 相關：ADR 0004（補訂閱游標）、0011／0029（`FastHydrator`、分頁 `forEachPage`）、0025（協調器）、0027／0029（kind 1060、單檔門檻）、0028（名單）、0032（中繼 REQ 位元組預算）；
  CinderSync ADR 0013（G8 止血 `ResubscribingPool`）；Cinderous `relay-backend.ts` 的 `inboxSince`／`fileSince`（同一個問題的既有正解）
- 發現者：CinderSync Phase 2（G8、G9、G10 三個 SDK 缺口）

## G8：重新連上後漏收外層時間被往前推的禮物包

### Context

`RelayPool`（ADR 0004）在每條訂閱記「看過最新的 `created_at`」（以本機時鐘為上限），重連或認證成功後以
`since = max(filter.since, 游標)` 補送 REQ，少重播。

NIP-59 規定 seal 與 gift wrap 的 `created_at` 要隨機往前推（「tweaked … up to two days in the past」）；SDK 的
`sealAndWrap` 以 `TIMESTAMP_JITTER_SECONDS = 2 × 86,400` 實作。**中繼對即時轉發也套用 `since`**（NIP-01；SDK 自己的
`relay/filters.ts` `matchFilter`，Cinderous 中繼相同）。所以重連一次之後，別人寄來、外層時間被往前推超過「距重連的時間」的
禮物包全部被中繼濾掉——直到下一次重連（下一次的 since 又是新的游標，問題重來）。App 重開或重新 `watch()` 才會以較寬的
since 重新訂閱而補回（中繼保存 7 天內）。

受影響的 SDK 路徑（都走 `pool.subscribe`）：

| 使用者 | filter | 外層 | 後果 |
|---|---|---|---|
| `DirectMessages.watch` | `{kinds:[1059], #p:[我], since: now−7d}` | NIP-17 禮物包 | 重連後的私訊漏收 |
| `NostrVaultTransport.start` | `{kinds:[1060], #p:[我]}` | 協調器訊息 | 重連後其他裝置的變更收不到（CinderSync 實測） |
| `NostrRosterSync.start` | `{kinds:[1060], #p:[我]}` | 名單 | 名單變動收不到 |
| `CallManager` | `{kinds:[21002], #p:[我]}` | 通話信令（禮物包、外層時間有抖動） | 重連後來電響不起來 |
| `PeerNode` | `{kinds:[21000, 20079], #p:[我]}` | SDP 信令（禮物包） | 重連後 `connectPeer` 對方收不到 offer |

不受影響：`FastHydrator.resume`（since 已退讓 `sinceSlackSeconds`，預設兩天）、`NostrVaultTransport.backfill`
與 `filters()`、`NostrRosterSync.filters()`（都退讓兩天）、`pool.query`（一次性、沒有游標）。

**重現**（先寫的失敗測試）：`tests/dm-reconnect.integration.test.ts` 以真的 Node 中繼（嚴格平面、NIP-42）＋ 真的
`DirectMessages`：第一則外層時間＝現在（游標前進到現在）→ 關掉 Bob 的 socket、連線池重連 → 第二則外層時間往前推一天 →
修正前 Bob **收不到**（第 76 行斷言失敗）。同檔第二則以 raw kind 1060 重現 CinderSync ADR 0013 釘住的情境，一樣失敗。

### 各應用是否受影響（2026-09-30 唯讀檢查）

| 專案 | 狀態 | 位置 | 結論 |
|---|---|---|---|
| SoLeague | SDK 只在 `claude/cinderous-sdk` 分支（v0.29.0，PR 中；main 用自寫連線池、重連送原 filter，不受影響） | `apps/web/src/components/online/OnlineLeagueApp.tsx:39,75`、`LeagueChat.tsx:36`（`dms.watch`） | **聯盟私訊受影響**（中低：重進聊天或重開補回）。聯盟資料 31081／1081 是真實時間戳，不受影響 |
| not-a-good-dad | 同上（`packages/nostr/package.json` v0.29.0，PR 中） | `packages/nostr/src/lobby.ts:194,371-373`（`DirectMessages`／`watchDms`） | **私訊受影響**（中低）。邀請／挑戰／對戰信令走 kind 20078、寄件人本人簽、真實時間戳，不受影響 |
| elementalist（`elementalist-sdk` worktree） | `claude/cinderous-sdk`（v0.29.0） | `src/adapters/NostrRelayPool.ts` 只用 `query`／`publish`；`packages/nostr/src/dm.ts:100-104` since 退讓兩天 | **不受影響** |
| last-working-day | `claude/cinderous-sdk`（v0.18.0）；**main 自寫連線池有同樣的 bug** | SDK 分支：`packages/platform-browser/src/relay.ts:303-309` 轉交 `sdk.subscribe`、`giftStore.ts:307-314` 訂 1059（應用層已退讓兩天，但重連時被 SDK 游標蓋掉）；main：`relay.ts:473-474`、`564-568` `since: max(filter.since, lastCreatedAt)` | **受影響（中高）**：1059 裝的是遊戲內禮物（已扣款）與私訊；App 開著期間漏收，重開才補回，超過中繼 7 天保存期就永久遺失。另有定期探針 `reconnectNow`（`relay.ts:251-254`）讓重連更頻繁 |
| Cinderous App（origin/main） | 不用 SDK 的 `RelayPool`（`packages/core/src/relay-client.ts:47` 原樣送 filter） | `packages/engine/src/backend/relay-backend.ts:1161,1175`（`inboxSince`／`fileSince`）、`:1197-1220`（`since = seen − TIMESTAMP_JITTER_SECONDS`）、`:2307-2317`（每座各自水位） | **不受影響**（已經是正解；本 ADR 就是把它搬進 SDK） |

已上線（main）的遊戲都還沒用 SDK 的 `RelayPool`，所以**正式環境裡只有 last-working-day main 的自寫連線池有同樣問題**；
其餘受影響的是 PR 中的 SDK 分支，升到 v0.30 即修正。

### Decision

`RelayPool` 補訂閱時，對「可能被回溯時間戳」的 filter，`since` 從游標再往前退讓 NIP-59 的最大值：

```ts
export const NIP59_MAX_BACKDATE_SEC = 2 * 86_400;   // 測試釘住 === protocol/nip59 的 TIMESTAMP_JITTER_SECONDS
export const BACKDATED_KINDS = [1059, 1060];
isBackdatableFilter(f)  // f['#p'] !== undefined || f.kinds 含 1059／1060
resumeSince(f, cursor, backdateWindowSec?) = max(f.since ?? 0, cursor − window)
pool.subscribe(filters, handlers, { backdateWindowSec })   // 呼叫端宣告；省略＝自動判斷；0＝關閉
```

- **為什麼 `#p` 一律算**：收件匣類的 filter 收的幾乎都是禮物包（1059、1060、21000、21002 都是），而 kinds 清單無法窮舉應用自訂的
  外層 kind。代價只是 `#p` filter 重連時多拉兩天內寄給自己的事件；對 ephemeral kind（2xxxx）中繼不存，代價為零。
- **為什麼退讓游標而不是「現在 − 兩天」**：游標 ≤ 斷線時間，而斷線後寄出的事件外層時間 ≥ 寄出時間 − 兩天 ≥ 游標 − 兩天，所以不漏；
  又不會像 CinderSync 的止血那樣在沒有游標時也重拉。
- 同一條訂閱裡只有可能被回溯的那幾個 filter 退讓，其他照原游標；filter 原本的 since 比較新就用原本的。
- `SubscribeOptions` 是第三個選用參數：只收兩個參數的自訂 `RelayTransport` 仍符合介面（TypeScript 允許參數較少的實作）。

**重複事件**：訂閱內的 `seen`（整條訂閱存活期間的 id 集合，本來就有）擋掉重拉回來、已經交給上層的事件——測試釘住。

**流量**：每次重連多拉的是「游標往前兩天內、符合 filter 的已存事件」，而那一次 REQ 受中繼的位元組預算限制
（Cinderous／SDK 中繼 `MAX_QUERY_BYTES` 16 MB，ADR 0032；另有 1024 筆上限），所以每座中繼每次重連最多多拉一份預算：

- 私訊（1059，每顆約 1–3 KB，後量子多 1.45 KB）：兩天 100 則約 0.3 MB，通常只有幾 KB。
- Vault 同步（1060，每塊約 64 KB 的 JSON）：最壞每座 16 MB。CinderSync 的止血本來就是這個量；`backfill()`（v0.25 起）重連時
  本來也會把兩天內的分頁再翻一次，兩者重疊。
- 被預算截掉的較舊事件（離線期間積下、時間又被往前推的）由 `NostrVaultTransport.backfill()`／`forEachPage` 以 `until` 分頁補齊。

`tests/relay-pool-backdate-budget.test.ts` 以 SDK 自己的 `RelayCore`（12 KB 預算）驗證：重拉的位元組 ≤ 預算＋小訊框；
重連後即時送來、往前推一天的事件收得到（修正前失敗）；被預算截掉的 5 顆離線事件由分頁全部補齊；訂閱內不重複交。

**`FastHydrator`／`NostrVaultTransport.backfill`**：檢查後沒有同樣的游標問題（都以「上次成功的開始時間 − 兩天」當 since），不改；
只更新 `backfill()` 的說明（不再是「連線池會漏」，而是「REQ 預算截掉的要靠它補」）。

### 被否決的替代方案

- **重連時送 `limit: 0`（只要即時事件），存量交給 `backfill`**：可以消掉 1060 的雙重重拉，但 SDK／Cinderous 中繼目前把
  `limit ≤ 0` 當成「不設限」（`queryLimit`），要先改中繼並部署；私訊也沒有 `backfill`。列為後續（見疑慮）。
- **每座中繼各自游標**（Cinderous 的做法）：更精準，但要改 `ActiveSubscription` 的結構，兩天窗已經足夠正確；不做。
- **游標改記本機時間**：不能解決問題（外層時間可以比本機時間早兩天）。

## G9：名單上的裝置能力宣告

### Context

ADR 0029 讓經中繼送的單檔門檻可以依中繼調到 30 MB 以上，但 ≤ v0.24 的收端只收得下 16.5 MB；`VaultMembership` 名單沒有版本或
能力欄位，外掛無法確認每一台都 ≥ v0.25，只能永遠停在 16.5 MB。

### Decision

- 名單加一個選用欄位 `caps: RosterCapability[]`，每筆 `{ pubkey, caps: { sdk, maxRelayFileBytes, …未來旗標 }, at, sig }`：
  - **裝置自己簽**（領域分隔的 `caps` 簽章，涵蓋 vaultId、公鑰、正規化 JSON 的能力、時間）——別的成員改不了、也冒名不了；
  - 同一台取 `at` 較晚的（平手取簽章較大，各台一致）；被撤銷、不在名單上的裝置的宣告一併丟掉；
  - 形狀限制：最多 8 個英數鍵、值為字串（≤ 24）／非負安全整數／布林、`sdk` 是 semver、`maxRelayFileBytes ≥ 1`、
    正規化 JSON ≤ 160 字元（32 台都塞滿仍放得進歡迎訊息與名單事件的 NIP-44 明文上限，既有的上限測試加上能力後照樣通過）。
    未知的鍵原樣保留、照驗簽章（向前相容）。
- API（`@cinderous/client/pairing`）：
  - `membership.declareCapabilities(caps = CURRENT_DEVICE_CAPABILITIES)`：簽、放進名單、發 `change`（`reason: 'caps'`，由
    `NostrRosterSync` 送出）；內容沒變回 false、不重簽，建議每次啟動呼叫；
  - `membership.capabilitiesOf(pubkey)`、`membership.minCapability()` → `{ maxRelayFileBytes, sdk, missing }`：
    任何一台沒宣告就回 `LEGACY_MAX_RELAY_FILE_BYTES`（16.5 MB）、`sdk: null`，並列出是哪幾台；
  - `CURRENT_DEVICE_CAPABILITIES = { sdk: SDK_VERSION, maxRelayFileBytes: 64 MiB }`（v0.25 起收端的絕對上限；測試釘住與
    `RELAY_FILE_MAX_BYTES_CAP`、`FILE_TIER_MAX_BYTES`、`package.json` 版本一致——配對子路徑不匯入同步零件）。
- 協調器（`./sync/vault`）：`memberCapabilities` 選項與 `setMemberCapabilities({ maxRelayFileBytes })`；經中繼的門檻＝
  min(中繼的 `maxFileBytes`, 成員)，`relayMaxFileBytes` 讀得到目前值。省略＝不設限（與 v0.29 相同）。接法：
  `membership.onChange(() => sync.setMemberCapabilities(membership.minCapability()))`。

### 相容性

- 舊版（≤ v0.29）解析名單只看 `v`、`vaultId`、`devices`、`revoked`、`keys`，**略過** `caps`，照常合併；它轉送的名單沒有 `caps`，
  新版合併時以聯集保留自己的，`#serialized` 不變就不發 `change`，所以不會來回震盪（測試釘住）。
- `MembershipChange.reason` 多了 `'caps'`：對 reason 做窮舉 `switch`＋`never` 檢查的使用方會在型別上看到新成員（行為不受影響）。

### 安全性

能力是**自我宣告**。惡意（或被入侵的）成員可以宣稱比實際高的能力，後果只是其他裝置經中繼送給它較大的檔案、它自己收不下
（它本來就能丟掉任何收到的東西）；它不能替別台宣告（簽章綁公鑰），不能讓別台收到超過它們自己宣告的上限——`minCapability`
取最小值，誇大只會讓下限不變或由別台決定。宣告過低只會讓整個 Vault 的門檻降低（退回 P2P，不遺失資料），這與成員本來就能
拒收或撤銷他人的權力相比不構成新的威脅。被撤銷後其宣告立即不算。可接受。

## G10：內容相同的同路徑檔案不再產生衝突副本

### Context

兩個**不同的檔案**（不同 fileId，例如新裝置帶著與 Vault 相同的筆記加入）要用同一個路徑時，協調器（ADR 0025）讓先佔用的留下、
其他的改名成衝突副本——內容一樣也照改，新裝置加入時產生大量無意義的副本。同一個檔案的兩個版本內容相同時，`mergeTwo` 本來就直接收斂，
不受影響。

### Decision

`#resolveCollision` 對每一個輸家，若它目前的版本與留下者的**內容雜湊相同**（兩者都沒刪），就：

- 在輸家的版本圖加一個刪除版本（id＝`deterministicId('dedupe', fileId, …heads)`，欄位全由輸家的版本決定——每台各自處理得到同一個版本）；
- 輸家若已經落地在這個路徑、磁碟內容就是這個雜湊、而留下者還沒落地：把磁碟那一份改記在留下者名下（base＝留下者的版本），
  **不動磁碟**；之後在這台的編輯屬於留下的檔案。
- 其他情況（例如輸家在磁碟上有還沒收進來、可能不同的內容，或兩者都已落地在不同路徑）照舊產生衝突副本——絕不刪掉可能不同的內容。

**與舊版混用**：≤ v0.29 的裝置對同一組相撞產生「改名成副本」的版本；它與這裡的刪除版本是輸家的兩個並行版本頭，合併規則
「一邊刪、另一邊只改名沒改內容 → 刪」讓所有裝置收斂到同一個結果（舊版那台會把它剛產生的副本刪掉，內容與留下者相同，不遺失）。

**相撞後、收斂前輸家又被修改**：修改是刪除版本的並行版本頭，合併規則「一邊刪、另一邊改了內容 → 保留修改」讓它復活，
內容已不同，下一次相撞照舊產生副本——不遺失（測試釘住）。

大小寫不同的同名檔案（`Note.md`／`note.md`）內容相同時也會收斂成一個，保留先佔用者的大小寫。

**2026-10-02 補註（ADR 0048，v0.37.1）**：同樣的刪除版本也用在**空檔**——相撞的檔案中有非空的，留下者改為第一個非空的，0 位元組的輸家直接收掉、不產生副本（磁碟上的空檔以前置條件移除，不移交給內容不同的留下者）。另：G10 的刪除版本比留下者先到時，接收的那台會先移除、等留下者到了再寫回同一份內容（既有行為，內容不變），列為 0048〈未處理〉。v0.37.0 在配對前就有不同內容的檔案時衝突副本會來回覆寫，根因是改名回音的誤讀（不是 G10），見 0048。

### 測試

新裝置帶與 Vault 相同的檔案加入 → 零衝突副本、內容不同的那一個照舊產生副本；兩台離線各自建立同名同內容 → 只剩一個、之後兩邊編輯互通；
第三台之後才加入、重開協調器後仍一致；相撞後輸家又改 → 不遺失。既有的收斂與不遺失性質測試（`property*.test.ts`）照樣通過。

## Consequences

- ＋ 重連不再讓私訊、Vault 同步、名單、通話與 P2P 信令靜默中斷；CinderSync 可以拿掉 `ResubscribingPool` 止血。
- ＋ 外掛可以在「每台都宣告 ≥ 30 MB」之後才把單檔門檻調過 16.5 MB，而且自動跟著名單變化。
- ＋ 新裝置加入不再產生一堆內容相同的衝突副本。
- － `#p`／1059／1060 訂閱每次重連多拉最多一份 REQ 預算（Vault 同步最壞每座 16 MB，與 `backfill()` 重疊）。
- － 名單多一欄（32 台塞滿約 +12 KB 明文）；主入口打包 +337 B（gzip +141 B），`./pairing` +2.9 KB（gzip +1.0 KB）。

## 疑慮與後續

- 1060 重連時與 `backfill()` 的雙重重拉：可在中繼支援 `limit: 0`（只要即時）之後，讓 `NostrVaultTransport` 以
  `{ backdateWindowSec, resumeStoredEvents: false }` 之類的選項只取即時，存量完全交給分頁。需要先改中繼並部署，另開 ADR。
- 能力宣告是自我宣告（見安全性）；若將來有「門檻過高會傷害別台」的能力，要改成需要其他成員背書。
- last-working-day main 的自寫連線池（`relay.ts:564-568`）需要各自修正（或改用 SDK v0.30）。
