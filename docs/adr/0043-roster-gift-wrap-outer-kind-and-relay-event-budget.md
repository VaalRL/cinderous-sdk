# 0043. 名單同步可選 NIP-59 禮物包外層（1059）；同一身分共用的中繼事件預算（PeerNode 預設 200 → 100）

- 狀態：**已接受（Accepted）**——2026-10-01，使用者授權持續補 SDK 缺口（起因是 DocHost 應用的需求研究）；實作於 v0.35.0
- 日期：2026-10-01
- 相關：本 repo ADR 0009（PeerNode、中繼軌）、**0028**（名單同步 §5）、0030（星狀會話的中繼軌預算）、0035（G8 補訂閱退讓兩天）、
  0036（DocHost 在自架站上的可行性）、0040（拒收詞元）、**0041**（健康狀態、限速退避）

## Context

DocHost 的需求研究查出兩個 SDK 缺口：

1. **名單同步只能用 kind 1060 外層**（`src/pairing/roster-sync.ts` 在 `buildRosterEvents`、`openRosterEvent`、`filters()`、`#ingest`
   四處寫死）。官方錨點與預設自架站的非檔案車道不收 1060（`blocked: files-disabled:`，Cinderous ADR-0162），
   所以不需要檔案車道的應用（DocHost）沒辦法同步名單。名單本身並不大：上限 32 台＋32 筆撤銷＋8 把金鑰、名稱全用 40 個中文字，
   包兩層 NIP-44＋base64 實測 **109,769 bytes**，遠低於所有 kind 共用的單顆上限 262,144 bytes（`relay-core` 的 `MAX_EVENT_BYTES`）。
2. **PeerNode 中繼軌預設每分鐘 200 框，會撞上中繼的每身分上限**。SDK 中繼以**認證身分**計數
  （`relay-core.ts` `admit()`：`rateKey = authState.pubkey ?? event.pubkey`），每把公鑰每分鐘 120 則事件，ephemeral 也算。
   已認證連線一分鐘連發 210 框只收下 120、其餘 `rate-limited: events:`（使用者實測；`tests/peer/peer-relay-rate.test.ts` 的對照組重現）。
   ADR 0009 當初的依據是「每連線每分鐘 240 則**訊息**」（`maxMessagesPerMinute`），漏看了較小的**事件**上限。
   而且同一身分的信令、名單同步、Vault 同步都落在同一個桶，各自限速、加起來仍會超過。

## 決策

### 1. `NostrRosterSync` 的 `outerKind?: 1059 | 1060`

- 新選項 `outerKind`（型別 `RosterOuterKind`），**預設 1060**（`DEFAULT_ROSTER_OUTER_KIND`；CinderSync 相容，行為與 v0.34 逐則相同）。
- `1059`：外層改用標準 NIP-59 禮物包（`sealAndWrap`，一次性金鑰簽、`#p`、7 天過期章），內層仍是 `VAULT_ROSTER_KIND = 4361`。
  四處都依選項：`buildRosterEvents(…, { outerKind })`、`openRosterEvent(event, signer, { outerKind })`（外層不符回 null）、`filters()`、`#ingest`。
  不是 1059／1060 丟 `RangeError`。
- 訂閱 1059 時 `since` 一樣往前退讓 NIP-59 的兩天；連線池補訂閱時 1059 本來就在 `BACKDATED_KINDS`（G8，ADR 0035），不用另外處理。
- **兩端要用同一個外層**：1060 的一端收不到 1059 的，反之亦然（測試守著）。同一份名單的每一台都要同時切換。
- 1059 也是 NIP-17 私訊的外層：收件匣訂閱（`dm.ts`）會看到這些事件，但內層 kind 不是 14，會被略過；名單同步也只認 4361。
- 白名單站：1059 本來就在「已認證成員的禮物包放行」之列（ADR 0028 §7）。

### 2. 中繼事件預算（`src/relay-budget.ts`）

- **常數（SSOT）**：`RELAY_MAX_EVENTS_PER_MINUTE = 120`（鏡射 `relay/host-config` 的 `MAX_EVENTS_PER_MINUTE`，測試釘住）；
  `DEFAULT_RELAY_EVENTS_PER_MINUTE = 100`（留 20 則給私訊、心跳等沒有經過預算的發布）；
  `RELAY_RATE_LIMIT_BACKOFF_MS = 60_000`（＝ `DEFAULT_RELAY_HEALTH_COOLDOWNS.rateLimitedMs`，中繼的計數窗）。
  `DEFAULT_RELAY_FRAMES_PER_MINUTE`（PeerNode）與 `DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE`（星狀會話）都改成指向它。
- **NIP-11**：`relayEventsPerMinute(nip11, fallback)`＝`cinder_max_events_per_minute` × 0.8、多座取最小。這就是 ADR 0030 的
  `starRelayEventsPerMinute`，搬到共用模組、星狀會話改成同一個函式（`starRelayEventsPerMinute === relayEventsPerMinute`）。SDK 中繼宣告 120 → 96。
- **`RelayEventBudget`**：滑動一分鐘的預算（任何 60 秒內最多 N 則 ⇒ 中繼的固定計數窗裡也不會超過）；`take()` 依呼叫順序排隊；
  `applyRelayInfo(nip11)` 取建構時速率與宣告值 × 0.8 的較小者（每次從建構時速率重算）；`backoff(ms)`。
- **同一身分共用**：`sharedRelayEventBudget(pubkey)`——同一個 JS 環境裡同一把公鑰一個預算。PeerNode、`NostrVaultTransport`、
  `NostrRosterSync` **沒有指定速率時**都用它；指定了（`relayFramesPerMinute`、`eventsPerMinute`）就用元件自己的預算（呼叫端自己負責分配，
  v0.34 的語意），或以 `relayBudget` 直接給一個實例。
- **限速拒收的退避**：`publishPaced(budget, publish, { done, retries = 2, onAttempt })`——先取預算再發布；任何一座回 `rate-limited:`
  （ADR 0040 詞元：`events`／`messages` 退避 60 秒，`ip` 1 秒）就**整個預算**退避；這一則沒有達標（預設：沒有任何一座收下；
  Vault／名單同步用 `meetsDurability`）時重送**同一顆**（被拒的事件不留在中繼的重放快取，ADR 0038 P0-R1），最多 2 次。
  每一次嘗試的拒收都經 `onPublishRejected` 回報；連線池的健康狀態照常把那一座標成整座 `backoff`、收下後清掉（ADR 0041）。
- **PeerNode**：預設 100（v0.34 是 200）；新選項 `relayBudget`、`relayInfo`（NIP-11 文件，自動取較小值）；新方法 `applyRelayInfo(nip11)`、
  getter `relayFramesPerMinute`。**信令（kind 21000）也取同一個預算**，但不重送（過時的 ICE 候選重送沒有意義）。
  封裝改在取到預算之後（等了一分鐘也不會帶舊的時間戳）。吞吐：每框 48,000 B × 100 ⇒ 約每秒 80 KB（原本設計值 160 KB，但實際上會被拒收）。
- **星狀會話**：`StarTransportOptions.relayInfo`；Host 與成員的預算＝`starRelayBudget(opts)`＝ `relayEventsPerMinute`（預設 100）與宣告值 × 0.8 的較小者。
  星狀會話經 PeerNode 的通道送出，所以 PeerNode 的預算才是最後一道；星狀會話的預算是讓它平均分配、不在 PeerNode 前面排隊。

### 3. 其他預設發送速率的檢查

| 元件 | v0.34 | 最壞情況 | v0.35 |
|---|---|---|---|
| PeerNode 中繼框 | 200／分鐘（自己的窗） | 一分鐘 200 則 > 120 | 100／分鐘，同一身分共用；限速退避重送 |
| PeerNode 信令 | 不限 | 一次連線十幾則（ICE 已批次） | 取同一個預算，不重送 |
| `NostrVaultTransport.send` | **不限** | 一則版本訊息＝塊數 × 裝置數（30 MB＝656 塊 × 每台）；第 121 顆起被拒，而協調器重試時以新的訊息 id 從頭再送，**超過 120 顆的訊息在要求認證的中繼上永遠送不完** | 依預算分批（30 MB 給一台約 7 分鐘）；被限速的那一顆退避後重送 |
| 協調器批次補送 `relayBulkPerHour` | 每小時 20 則**訊息** | 這是訊息數不是事件數，每則仍可能是幾百顆 | 不變；事件數由傳輸層的預算管 |
| `NostrRosterSync.announce` | 不限 | 一次最多 31 顆；一分鐘內 4 次變動就超過 | 取同一個預算 |
| 星狀會話（含心跳，中繼軌 15 秒一次） | 100／分鐘（鏈路層） | 經 PeerNode 送出，原本受 PeerNode 的 200 管 | 不變；預設改指向共用常數，可給 `relayInfo` |
| 私訊（`dm.ts`）、直接 `RelayPool.publish` | 不限 | 每則私訊 2 顆 | **不經過預算**（留 20 則的原因）；寫進文件 |
| 讀回稽核、補拉 | — | REQ 是訊息不是事件（每連線 240／分鐘） | 不變 |

## 實測與測試

- `tests/peer/peer-relay-rate.test.ts`：真的 `RelayCore`（要求 NIP-42、每分鐘 120 則）＋真的 `RelayPool`＋虛擬時鐘。
  預設速率 210 框全部收下、沒有任何拒收、任何一分鐘內 ≤ 100；對照組以 v0.34 的速率一分鐘發 200 則只收下 120、80 則 `rate-limited: events:`；
  中繼上限 10 而節點預算 1000 時，被限速的每一框都退避一整分鐘再重送、夾在中間的多框訊息完整送達、健康狀態出現整座 `backoff`、收下後清掉。
- `tests/relay-budget.test.ts`：常數與中繼、NIP-11、健康狀態冷卻一致；滑動窗；`applyRelayInfo`；排隊；`backoff`；共用；
  `rateLimitBackoffMs` 的詞元；部分限速不重送但之後退避；PeerNode／Vault／名單同步都走預算。
- `tests/pairing/roster-outer-kind.test.ts`：預設 1060 不變；外層只能是 1059／1060；1059 的 `since` 退讓兩天；兩種外層各自互通、不同外層不互通；
  SDK 中繼的 `guardFor('app')` 車道（沒開檔案事件）：1060 被拒（`blocked: files-disabled:`）、1059 同步得到；滿載名單 109,769 bytes 經車道收下並解得開。
- 共用的 `tests/core-bridge.ts`（從 `relay-pool-backdate-budget.test.ts` 抽出）：把 `RelayCore` 接成連線池看得懂的假 WebSocket。

## 相容性與下游

- **名單**：預設不變，CinderSync／Coffice 不需要升級或改設定。要改用 1059 的應用（DocHost）必須讓同一份名單的每一台同時使用 1059；
  混用版本或混用設定會互相收不到（不會出錯，只是不同步）。CinderSync 的 Vault 同步本來就需要檔案車道（1060），沒有理由改。
- **速率**：升級到 v0.35 之後，沒有指定速率的 PeerNode 中繼軌變慢（200 → 100 框／分鐘），但 v0.34 的 200 本來就有 40％ 以上被中繼拒收；
  Vault 同步走中繼的大檔會分好幾分鐘送完（原本超過 120 顆就送不完）。有指定 `relayFramesPerMinute` 的應用維持自己的值與自己的預算。
  建議應用拿到中繼的 NIP-11 後呼叫 `sharedRelayEventBudget(identity.pubkey).applyRelayInfo(docs)`（或 PeerNode 的 `relayInfo`），同一身分的元件一起調整。
- **主入口**：新增匯出 `RelayEventBudget`、`sharedRelayEventBudget`、`relayEventsPerMinute`、`publishPaced`、`rateLimitBackoffMs`、
  `DEFAULT_RELAY_EVENTS_PER_MINUTE`、`RELAY_MAX_EVENTS_PER_MINUTE`、`RELAY_RATE_LIMIT_BACKOFF_MS`；`./pairing`、`./sync/vault` 也匯出前三個（同一個模組實例）；
  `./pairing` 另匯出 `DEFAULT_ROSTER_OUTER_KIND`、`RosterOuterKind`；`./star` 匯出 `starRelayBudget`。

## 已知限制

- 預算只在同一個 JS 環境裡共用。同一把身分在**另一台裝置或另一個分頁**也在發，中繼的桶是共用的而預算不是——這時靠限速退避與重送收斂。
- 私訊與直接 `RelayPool.publish` 不經過預算；連線池層級的統一節流（所有發布都排隊）不在這一版。
- 重送最多 2 次；長時間被別人佔滿桶時，PeerNode 的 `send` 仍會丟錯誤（不默默丟資料），Vault 協調器依原本的退避重試。

## Consequences

- ＋ 不需要檔案車道的應用也能同步名單；預設行為不變。
- ＋ 同一身分的元件不再各自以為還有額度；中繼的速率數字只有一份（中繼常數、NIP-11、客戶端預設、健康狀態冷卻都由測試釘在一起）。
- ＋ Vault 同步的大檔在要求認證的中繼上終於送得完。
- － PeerNode 中繼軌的預設吞吐減半（約每秒 80 KB）；要更快的應用要知道中繼的實際上限並自己指定。
- － 多了一個模組層級的共用狀態（每把公鑰一個預算物件）。
