# 0044. 重新讀到 NIP-11 後重新驗證「不適用」標記；`watchRelayFileLimits` 定期重讀（v0.35.1）

- 狀態：**已接受（Accepted）**——2026-10-01，使用者核准；實作於 v0.35.1
- 日期：2026-10-01
- 相關：本 repo ADR 0027（檔案事件未啟用的拒收）、0029（NIP-11 檔案政策）、0040（拒收詞元）、**0041**（健康狀態、耐久度、`watchRelayFileLimits`）

## Context

CinderSync 升 v0.35 時發現：中繼回 `blocked: files-disabled:`（或其他政策類拒收）時，ADR 0041 §1 把那座標成
「不適用」（`inapplicable`，範圍 `kind:1060`）**24 小時**。站方之後打開檔案事件（NIP-11 `cinder_accepts_files: true`），
帶 `durability` 的發布仍會略過那一座，直到 24 小時過去或應用重開——ADR 0041 只留了一個粗的出口 `resetRelayHealth(url)`，
要應用自己判斷什麼時候該清、而且一清就把那座所有標記（含真的已滿）都清掉。

結果 CinderSync 不敢開 `durability`：開了之後，「中繼開放檔案事件後自動恢復」的端到端測試會失敗
（預設發布路徑照送、收下就清，所以沒開 `durability` 時恢復得了；開了之後被略過，就再也收不到能清掉標記的那次收下）。

## 決策

### 1. SSOT 入口：`pool.revalidateRelay(url, info, { observedAt? })`

連線池是健康狀態的唯一持有者，所以「讀到新文件 → 哪些標記不成立了」放在連線池（`RelayHealthTracker.revalidate`），
其他讀 NIP-11 的地方都把文件交給它，不各自判斷：

- `info` 收**原始 NIP-11 文件**或 **`fetchRelayFilePolicy` 的結果**（兩種形狀的欄位都認）。不是物件就什麼都不做。
- 清掉的標記經 `onRelayHealthChange` 通知（有清才通知，一次），回傳清掉的那些。
- **只清 `observedAt`（讀文件的時間，預設現在）之前出現的標記**：讀到「收檔案」之後才被拒，代表文件與實際不符
  （快取、CDN、路徑不同），這時不清——否則每次重讀都清掉、下一則再撞一次。

文件**看得出來**原因已不成立的，才清：

| 標記 | 文件裡的依據 | 清掉的條件 |
|---|---|---|
| `kind:1060` 政策類，原因 `blocked: files-disabled:`（或舊中繼 `blocked: …MAX_FILE_MB…`） | `cinder_accepts_files`／`acceptsFiles` | `=== true` |
| `too-large`（不含 1060） | `limitation.max_message_length`；可尋址另看 `cinder_addressable_max_bytes` | 宣告了，而且**每一個**宣告的上限都 ≥ 被拒的那顆（`minBytes`） |
| `restricted: not-allowed:`／`blocked: not-allowed:`（白名單外） | `limitation.restricted_writes` | `=== false` |

**不動**的：

- `kind-disabled`：NIP-11（含 Cinderous 的延伸欄位）沒有「停用哪些 kind」的欄位，看不出來。站方改了設定時應用用 `resetRelayHealth(url, { scope })`。
- 檔案塊的 `too-large`：中繼的檔案塊單顆上限（`FILE_EVENT_MAX_BYTES` 200,000）沒有宣告，`max_message_length`（262,144）比它大，拿來判斷會誤清。
- `full`（`ceiling`／`quota`）：NIP-11 只有靜態天花板、沒有即時用量（ADR 0038 M6），看不出來；1 小時冷卻與「任何一次收下就清」不變。
- `backoff`（限速）與整座的關閉碼標記：前者本來就只到計數窗結束；後者（4003）多半是認證或白名單，等同 `not-allowed` 但沒有 kind，保守不動。
- 讀不到、沒宣告（`null`、沒有欄位）：當成「不知道」，不清。

`fetchRelayFilePolicy` 多帶三個選用欄位（有宣告才有）：`maxMessageLength`、`restrictedWrites`、`addressableMaxBytes`，
讓只拿得到 policy 的 `watchRelayFileLimits` 也判斷得了 `too-large` 與白名單外。

`sharedRelayEventBudget(...).applyRelayInfo` 不當入口：它管的是同一身分的事件預算（ADR 0043），沒有連線池的參照；
應用手上有原始文件時，同一份文件另外交給 `pool.revalidateRelay` 即可。

### 2. 精準的手動出口：`resetRelayHealth(url?, { scope?, state? })`

原本的 `resetRelayHealth(url?)` 照舊（不帶篩選＝全清）。帶篩選只清符合的那些，例如站方告訴你「kind 停用改掉了」時
`resetRelayHealth(url, { scope: 'kind:1060' })`，不會順便把那座真的已滿的 `offline` 也清掉。沒有清到任何東西就不通知。

### 3. `watchRelayFileLimits` 定期重讀 NIP-11（`refreshMs`，預設 30 分鐘）

- 原本 NIP-11 每座只讀一次（永遠快取）。現在每 `refreshMs` 重讀一輪：**寫入集合裡的每一座，加上有「不適用」標記的那幾座**
  ——被標成不適用的那座不在寫入集合裡，不特別列進來就永遠看不到它恢復。
- 每次讀到（含第一次）就 `pool.revalidateRelay(url, policy, { observedAt: 讀之前的時間 })`；有清掉 → 健康狀態通知 → 寫入集合變了 → 重算限制。
  每一輪結束也強制重算一次（上限、配額可能改了，即使集合沒變）。
- `refreshMs: 0`（或負數）＝不重讀，與 v0.35.0 相同。
- **請求量**：每座每輪一個 `GET`（`Accept: application/nostr+json`）。3 座、30 分鐘＝每台裝置每天 144 個；
  10 台裝置共用一座 Cloudflare 免費方案的中繼（每天 100,000 個請求）是每天 480 個，0.5%。NIP-11 由 Worker 直接回、不進 DO。
  不在更短的間隔上重讀：站方改設定是罕見事件，30 分鐘的恢復延遲換每座每天 48 個請求是合理的；要更快的應用自己縮短，
  或在使用者按「重新檢查」時直接 `fetchRelayFilePolicy` ＋ `revalidateRelay`。
- 只在 `watchRelayFileLimits` 裡排程：它本來就是「持續追蹤中繼檔案政策」的那個長命物件，有停止函式；
  連線池本身不發 HTTP（ADR 0031：連線池只管 WebSocket，HTTP 能力由應用注入，Obsidian 要包 `requestUrl`）。

### 4. 「不適用」的 24 小時：保留，改成「沒有重讀時的上限」

評估過三個方案：

| 方案 | 優點 | 缺點 |
|---|---|---|
| A. 縮短（例如 1 小時） | 沒有重讀的應用也恢復得快 | 對**真的**不收的中繼（第三方、企業白名單、`kind-disabled`）每小時多撞一次；那些拒收不會自己變 |
| B. 改成「直到下次讀到 NIP-11」（沒有期限） | 語意最精確 | 沒讀 NIP-11 的應用（多數第三方中繼沒有 Cinderous 欄位）**永遠**不恢復，只能靠收下或重開；看不出來的類別（`kind-disabled`）也永遠卡住 |
| **C. 保留 24 小時當上限＋讀到文件就重新驗證（採用）** | 有讀 NIP-11 的應用在下一輪（≤30 分鐘）恢復；沒讀的與 v0.35.0 相同；看不出來的類別仍有上限 | 看不出來的類別仍要等 24 小時或 `resetRelayHealth` |

預設行為不變：沒呼叫 `revalidateRelay`、沒用 `watchRelayFileLimits`（或 `refreshMs: 0`）時與 v0.35.0 逐則相同。
`healthCooldowns.inapplicableMs` 本來就可以調，應用覺得 24 小時太長可以自己縮短。

## 測試（`tests/relay-pool-revalidate.test.ts`）

- `files-disabled` → 重讀到 `cinder_accepts_files: true` → 立即恢復（寫入集合、`durability` 不再略過、通知一次）；舊中繼的拒收句、policy 形狀也認得；
- NIP-11 仍是 `false`／`null`／沒欄位／不是物件 → 不清、不通知；
- 已滿、`kind-disabled`、限速不受影響；`too-large` 依宣告上限（一般 kind、可尋址、1060 不動）；`not-allowed` 看 `restricted_writes`；
- `observedAt` 早於標記 → 不清；沒有重讀時照舊 24 小時；`resetRelayHealth(url, { scope／state })`；
- `watchRelayFileLimits`：29 分鐘還沒、30 分鐘那一輪恢復並重算，被標記的那座也重讀、每座一輪一次；`refreshMs: 0` 不重讀；停止後不再重讀；
- `fetchRelayFilePolicy` 只有宣告時才帶新欄位（沒宣告的形狀與 v0.35.0 `toEqual` 相同）。

## Consequences

- ＋ 站方打開檔案事件（或提高上限、移出白名單）之後，用 `watchRelayFileLimits` 的應用在一輪內恢復；CinderSync 可以開 `durability`。
- ＋ 判斷集中在連線池一處；手動出口變精準，不必為了一個 kind 清掉整座。
- ＋ 預設行為不變；新欄位、新選項都是選用的（patch 版）。
- － `watchRelayFileLimits` 每座每 30 分鐘多一個 HTTP 請求（可關）。
- － `kind-disabled`、檔案塊 `too-large`、整座的關閉碼仍看不出來，要等 24 小時或手動 `resetRelayHealth`。
- － 依賴中繼的 NIP-11 誠實；文件與實際不符時，`observedAt` 保證一輪最多多撞一次。
