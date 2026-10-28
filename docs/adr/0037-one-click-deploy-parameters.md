# 0037. 一鍵部署開放哪些參數：逐項定案（範圍、夾限、安全邊界、免費額度、NIP-11）

- 狀態：Accepted
- 日期：2026-09-30
- 對應：DocHost 的請求 2。相關：本 repo ADR 0008、0013、0018、0019（中立預設值）、0021、0027、0029、0036；
  Cinderous ADR-0071、0089、0160（TTL 夾限）、0162、0235、0243、0342、0356、0366、0367、0368、0371。

## Context

一鍵部署（REST、wrangler、docker、fly）原本只開放 Worker 名稱、白名單、站名、檔案塊。第三方應用（第一個是 DocHost）部署自己的中繼時
需要更多：已知租戶車道、限速、保存期、NIP-11 的營運者資訊。開放得太少，應用只能叫使用者去儀表板手改環境變數（而下一次一鍵部署又會把它蓋掉）；
開放得太多，一個設定畫面就能部署出「不限速、無界保存」的中繼，帳單與濫用都算在使用者頭上。

原則：

1. **只開放中繼已經在讀的環境變數**，並在部署端驗證範圍；中繼寫死的常數要開放，得先改中繼（列入〈後續〉）。
2. **不能關掉防線**：沒有任何選項能「不限速」或「無界保存」；數值範圍都有上下限，超出在部署前丟例外，而不是交給中繼默默夾限。
3. **SDK 預設值中立**（ADR 0019）：沒給就不設，不把錨點專屬的值（站名、文件網址、贊助、已知租戶）寫成 SDK 預設。
4. **Node 主機與 Worker 同一份驗證**（ADR 0036 `relaySiteVars`）；只有 Worker 支援的參數在 Node 主機上明確拒絕。

## Decision

「本版」＝v0.31 已在 `RelaySiteOptions`（或既有部署選項）開放並有測試；「不開放」＝一鍵部署不提供（站方要自己改設定，並理解它的後果）；
「後續」＝值得開放但需要先改中繼。免費額度的數字以 Cloudflare 官方為準（撰寫時：Workers 免費 10 萬請求／日；SQLite 型 DO 免費
10 萬請求／日、SQLite 儲存全帳號共 5 GB、每日寫入約 10 萬列；WebSocket 進站訊息以 20:1 折算請求）。

| 參數 | 環境變數 | 決定 | 預設 | 合法範圍／夾限 | 安全邊界 | 免費額度與儲存 | NIP-11 |
|---|---|---|---|---|---|---|---|
| Worker 名稱 | —（Worker 名、網址第一段） | 本版（既有 `workerName`） | `cinderous-relay` | 小寫英數與 `-`，不以 `-` 開頭，≤ 63 | 同名的非中繼 Worker 預設不覆蓋（`name-conflict`，ADR 0021） | 無 | 無 |
| 站名 | `RELAY_NAME` | 本版 | 不設（SDK 中立名） | trim 後 ≤ 100 字；拒絕換行與控制字元 | 值會進 TOML／YAML，一律跳脫 | 無 | `name` |
| 描述 | `RELAY_DESCRIPTION` | 本版 | 不設（SDK 中立描述） | ≤ 500 字；同上 | 同上 | 無 | `description` |
| 聯絡方式 | `RELAY_CONTACT` | 本版 | 不設（欄位不出現） | ≤ 200 字 | 不驗證格式（`mailto:`、網址、Nostr 皆可） | 無 | `contact` |
| 營運者公鑰 | `RELAY_PUBKEY` | 本版 | 不設 | 一把 `npub` 或 hex，寫入 hex | — | 無 | `pubkey` |
| 贊助管道 | `DONATE_*` | 本版（`donations`） | 全不設（不顯示贊助卡） | 每項 ≤ 200 字 | 不替站方預填任何人的帳號（ADR 0019） | 無 | `cinder_donations` |
| 白名單 | `ALLOWED_PUBKEYS` | 本版（既有） | 不設＝開放中繼（CLI 會警告） | `npub`／hex，寫錯一筆就拒絕部署 | 🔴 寫錯不能退化成開放中繼（ADR 0008）；只管寫入，不管讀取 | 開放中繼＝任何人都能用你的額度 | `limitation.restricted_writes` |
| 已知租戶車道 | `APP_LANES` | 本版（ADR 0036） | 不設 | 每筆符合 `LANE_ID_PATTERN`；≤ 32 條；去重 | 改名單＝換 DO，REST 重新部署要 `allowLaneChange` | 每條一顆 DO；可尋址天花板每顆 128 MB、離線留言天花板每顆 128 MB，全帳號共用 5 GB | 車道路徑的 `cinder_addressable_*`、`retention` |
| 檔案車道 | `FILE_LANES` | 本版 | 不設 | ⊆ `appLanes`，且需要 `maxFileMb` | 中繼會忽略的設錯，部署端直接擋 | 每條檔案車道 DO 天花板 1 GiB（Cinderous ADR-0371 §成本） | `cinder_max_file_mb`、`cinder_file_chunks_per_recipient` |
| 檔案塊總開關／單檔上限 | `MAX_FILE_MB` | 本版（既有 `maxFileMb`） | 不收 | 1–1024 整數 | 開放中繼要另外 `openFileRelay: true`（ADR 0027） | 每收件人 4,000 塊（沒設 `FILE_LANES`）；最壞 4,000 × 約 131 KB ≈ 520 MB／收件人 | `cinder_accepts_files` |
| 離線留言保存上限 | `MAX_TTL_DAYS` | 本版 | 不設＝7 天 | 1–365 整數（中繼另有 3,650 的硬夾，ADR-0160） | 無界保存不開放；> 365 要自己改設定 | 穩態儲存 ≈ 寫入速率 × 保存期；每收件人 500 則的 FIFO 另外限量 | `retention` |
| 可尋址 TTL、配額、單顆上限 | —（常數：30 天；5／64／16；256 KB／32 KB；每作者 8 MB／2 MB） | 不開放（後續：`APP_LANE_POLICY`） | — | — | 配額是「一個作者塞爆一顆 DO」的界線 | 見上 | `cinder_addressable_ttl_sec`、`cinder_addressable_per_author`、`cinder_addressable_max_bytes`（v0.31 新增） |
| 每顆 DO 天花板 | —（常數：128 MB 可尋址、128 MB 離線、檔案車道 1 GiB） | 不開放 | — | — | 調大前要重算全帳號 5 GB | 直接決定帳號儲存上限 | 無 |
| 每收件人留言上限 | —（常數 500；檔案塊另計） | 不開放 | — | — | 收件人可亂編，這一條只是 FIFO，不是總量界線 | — | `cinder_max_per_recipient` |
| 每公鑰每分鐘事件 | —（Worker 常數 120；Node 讀 `MAX_EVENTS_PER_MINUTE`） | 不開放（後續：Worker 也讀） | 120 | — | 🔴 Node 版可設 0＝關閉，一鍵部署**不**提供這條路 | 每則事件至少一列寫入 | `cinder_max_events_per_minute` |
| 每連線每分鐘訊息 | —（Worker 常數 240；Node 讀 `MAX_MESSAGES_PER_MINUTE`） | 不開放 | 240 | 必須 ≥ 事件上限 × 2（`messagesPerMinuteFrom`） | 同上 | Cloudflare 以進站訊息計費，這是主要的成本界線 | 無 |
| 每 IP 每秒訊息 | `MAX_MESSAGES_PER_SECOND_PER_IP` | 本版 | 20（PRD 3.3） | 1–1000 整數 | 不能設成「不限」；⚠ 每顆 DO 各自計算 | 20／秒 × 86,400 ≫ 免費額度，它擋的是爆量不是日總量 | `cinder_max_messages_per_second_per_ip`（v0.31 新增，有設才出現） |
| 每公鑰連線數 | `MAX_CONNECTIONS_PER_PUBKEY` | 本版 | 5（PRD 3.3） | 1–100 整數 | 只對完成 AUTH 的連線計數（車道上不做 AUTH 的客戶端不受限） | 連線本身按 DO 時長計 | 無 |
| 車道升級 IP 限速 | `APP_LANE_LIMIT`（rate limit 綁定） | 後續 | 未綁定＝不限 | 需要 `ratelimit` 綁定（namespace、limit、period） | 開放站最該有的一道；一鍵部署目前沒有 | 擋在碰到 DO 之前，省 DO 請求 | 無 |
| PoW 最低難度 | `APP_LANE_POW` | 本版（`appLanePow`，只影響車道） | 0（不要求） | 0–32 整數（0 不寫入） | 🔴 開之前確認車道客戶端會挖礦，否則持久化事件全被拒；嚴格平面恆為 0 | 把寫入成本轉給寫入者 | `supported_nips` 含 13（難度本身目前不宣告，後續） |
| NIP-42 requireAuth | —（Worker：嚴格平面恆開、車道恆關；Node 讀 `REQUIRE_AUTH`） | 不開放 | — | — | 嚴格平面關 AUTH＝任何人讀別人的收件匣；車道開 AUTH＝把不處理 AUTH 的客戶端鎖在門外 | — | `limitation.auth_required` |
| 文件網址 | `DEVELOPER_DOCS_URL` | 本版（Worker 限定） | 不設（不附網址，ADR 0019） | https、≤ 200 字 | 拒絕 `http:`、`javascript:` 等 | 無 | 無（出現在拒絕連線的 NOTICE／關閉原因） |
| compatibility_date | —（Worker 設定） | 本版（既有，加格式驗證） | `2026-09-01` | `YYYY-MM-DD` | 改日期會改變執行期行為；預設隨 SDK 版本更新並測試 | 無 | 無 |
| 健康檢查 | —（部署端） | 本版（既有 `healthRetries`、`healthDelayMs`） | REST 20 次、wrangler／docker／fly 10 次；間隔 3 秒 | 呼叫端決定 | 🔴 沒通過就不回報成功（永遠如此） | 每次檢查一個 Worker 請求 | 無 |
| TURN | `TURN_KEY_ID`、`TURN_API_TOKEN`（secret）、`TURN_TTL_SECONDS`、`TURN_LIMIT` | `turnKeyId`、`turnTtlSeconds`＋Token 走 secret（SDK ADR 0118） | 未設＝`/turn` 回 204 | — | Token 是 secret，要走 secret 綁定；TURN 另計費（Cloudflare Realtime） | 免費額度外另計流量 | 無 |
| observability | —（Worker 設定） | 固定開 | `enabled: true` | — | 關掉就看不到 `FILE_LANES` 設錯等警告 | 免費方案有日誌量上限，中繼的日誌量很小 | 無 |
| 節點自報 | `NODE_ATTESTATION` | 不開放 | — | 需要營運者簽章的事件 | 簽章要在營運者端做，不該經過部署表單 | — | `cinder_node` |

### 實作（v0.31）

- `RelaySiteOptions`、`relaySiteVars(opts, 'worker' | 'node')`、`RELAY_SITE_LIMITS`、`WORKER_ONLY_SITE_OPTIONS`、`laneListVar`、
  `assertCompatibilityDate`；`relayWorkerVars` 保留為 `relaySiteVars(opts, 'worker')`。從 `./deploy` 與 `./deploy/cloudflare-api` 匯出。
- CLI `relay deploy`：`--relay-name`、`--relay-description`、`--relay-contact`、`--max-ttl-days`、`--max-connections-per-pubkey`、
  `--max-messages-per-second-per-ip`、`--app-lanes`、`--file-lanes`、`--app-lane-pow`、`--developer-docs-url`；
  後四個配 `--provider=docker|fly` 是用法錯誤。營運者公鑰與贊助管道只在程式化 API 提供。
- NIP-11 多三個欄位（ADR 0036 §3）。

## Consequences

- ＋ 應用可以在自己的設定畫面提供「站名、保存期、限速、已知租戶」，不必叫使用者進儀表板；每個值在部署前就驗證。
- ＋ 沒有任何組合能部署出不限速或無界保存的中繼。
- － 數值範圍是部署端的政策，不是中繼的：站方仍然可以在儀表板把環境變數改到範圍外（中繼另有自己的夾限，例如 TTL 3,650 天、PoW 32）。
- － 參數變多，REST 重新部署時沒帶的參數會回到預設（上傳整份替換綁定）。只有 `appLanes` 有變更檢查（改了會搬資料）；
  其他參數回到預設不會丟資料，但應用應該把使用者的選擇記下來、每次部署帶同一份。

## 後續

- **`APP_LANE_POLICY`（車道層級政策）**：`<lane>:addr=<n>,ttl=<days>,max=<KB>` 形式，只對 `APP_LANES` 上的車道生效，數值有上下限
  （例如位址 16–256、TTL 1–90 天、單顆 8–64 KB），NIP-11 如實宣告。需要改 `storeOptions` 與兩座宿主，另開 ADR；部署端以 `appLanePolicies` 開放。
- **車道升級 IP 限速的綁定**：REST metadata 加 `ratelimit` 綁定、wrangler.toml 加對應設定；開放站建議預設開。
- **Worker 讀 `MAX_EVENTS_PER_MINUTE`／`MAX_MESSAGES_PER_MINUTE`**（只允許調高到某個上限、不允許關閉），與 Node 主機一致。
- **TURN**：以 secret 綁定上傳 Token（REST 的 `secret_text`），部署表單只收 Key ID；另計費要在 UI 說明。（已做：SDK ADR 0118，wrangler 路徑用 `wrangler secret put`、值走 stdin。）
- **PoW 難度宣告**：NIP-11 `limitation.min_pow_difficulty` 依車道回報。
