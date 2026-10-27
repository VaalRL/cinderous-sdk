# 0036. 一鍵部署可以設定已知租戶車道（`appLanes`）；自架站上的 DocHost 可行性；「只同步差異」的建議

- 狀態：Accepted
- 日期：2026-09-30
- 對應：DocHost（Tauri EPUB 閱讀器）的請求 1。相關：本 repo ADR 0008（白名單）、0013（PRD 3.3 防濫用預設）、
  0019（中立預設值）、0021／0022（REST 一鍵部署與 Token 說明）、0027（檔案事件）、0029（檔案車道）；
  Cinderous ADR-0366（應用車道與已知租戶）、0367（見習保存、DO 天花板）、0371（`FILE_LANES`）。
  參數的逐項研究在 [ADR 0037](0037-one-click-deploy-parameters.md)。

## Context

DocHost 在官方錨點的 `/app/dochost` 車道跨裝置同步劃線、筆記、書籤、閱讀位置（錨點的 `APP_LANES` 已含 `dochost`）。
它要在 App 內用 `@cinderous/client/deploy/cloudflare-api` 一鍵部署**自己的**中繼，部署後自己的中繼與兩座錨點都連；Token 不保存。

DocHost 的線路：連 `wss://<host>/app/dochost`；**客戶端不處理 NIP-42 AUTH**（只送 REQ／EVENT／CLOSE）；事件 kind 31438
（可尋址），`d` 是 HMAC 值、現行 64 個桶；content 是 gzip → XChaCha20-Poly1305 → base64（`dh1:` 前綴）；
查詢 `{kinds:[31438], authors:[pk], "#d":[…]}`。

缺口：`deployCloudflareRelayViaApi` 只收白名單、站名、檔案塊，**不能設 `APP_LANES`**。自架站沒有 `APP_LANES=dochost` 時，
`/app/dochost` 落到公用車道：可尋址配額 16／(作者, kind)、見習保存 2 小時——64 個桶放不下，放得下的兩小時後也不見了。

使用者對同步的原則（DocHost 轉述）：「同步資料都是一次性的，同步後就由本地資料作為單一來源，所以同步不是完整資料同步，
而是只同步改變的資料。」——中繼上是傳遞用的差異，不是長期的完整狀態。

## Decision

### 1. `RelaySiteOptions`：四條部署路徑共用的站台參數

`deploy/shared.ts` 新增 `RelaySiteOptions` 與 `relaySiteVars(opts, host)`，是**唯一**把參數驗證並轉成中繼環境變數的地方：

- REST（`deployCloudflareRelayViaApi`）與 wrangler（`deployCloudflareRelay`）走 `host: 'worker'`（`relayWorkerVars` 保留為別名）；
- docker／fly 的 `relayEnvironment` 走 `host: 'node'`。

四個部署函式的選項型別都 `extends RelaySiteOptions`，CLI 的 `relay deploy` 旗標與之同名（kebab-case）。
本版開放的參數與範圍見 ADR 0037；這裡只記與 DocHost 直接相關的：

| 選項 | 環境變數 | 規則 |
|---|---|---|
| `appLanes: string[]` | `APP_LANES` | 每筆符合中繼的 `LANE_ID_PATTERN`（`^[a-z0-9][a-z0-9._-]{0,63}$`，從 `relay/shard.ts` 匯出，同一個樣式）；不自動轉小寫；去重；最多 32 條（每條一顆 DO）。 |
| `fileLanes: string[]` | `FILE_LANES` | 必須都在 `appLanes` 上、而且要給 `maxFileMb`——中繼會默默忽略的設錯，部署端直接擋。 |
| `maxMessagesPerSecondPerIp` | `MAX_MESSAGES_PER_SECOND_PER_IP` | 1–1000，預設 20（PRD 3.3）。一次推很多事件的客戶端需要它。 |
| `maxTtlDays` | `MAX_TTL_DAYS` | 1–365；沒給＝中繼預設 7 天。 |

**Node 主機沒有車道**（Cinderous ADR-0366 §決策 8：它是單一嚴格平面，刻意不帶車道政策）。`appLanes`、`fileLanes`、`appLanePow`、
`developerDocsUrl` 給 docker／fly 會**丟例外**（CLI 回用法錯誤）：設了卻不生效，比部署失敗更難查。這是「四條路徑一致」的意思——
同一份驗證、同一個名字、不支援的地方明確拒絕，而不是各自默默不同。

驗證都在**寫任何檔案、打任何 API 之前**完成（docker／fly 原本先寫建置內容才組環境變數，已調換順序）。
wrangler.toml 的值改以 JSON 字串寫成 TOML 基本字串：站名、描述是自由文字，引號與反斜線要跳脫（控制字元在驗證時就拒絕）。
`compatibilityDate` 另外驗證 `YYYY-MM-DD`。

### 2. 重新部署的冪等與「改名單＝換 DO」

REST 上傳會整份替換 plain text 綁定，所以**忘了帶 `appLanes` 的重新部署會把車道搬走**：名單上的車道有自己的 DO
（`namedLaneName(id)`），名單外的落在雜湊分片（`app-<0..7>`）。舊 DO 裡的可尋址事件與離線留言不會搬，等 TTL 到期——
對那條車道是一次冷啟動（Cinderous ADR-0366 的同一個警告）。

- REST 路徑重新部署自己的中繼時先讀線上設定（`GET …/workers/scripts/{name}/settings`），`APP_LANES` 與這次不同
  （順序、大小寫、空白不計，與中繼的 `knownLanes` 同一個正規化）就丟新的錯誤分類 **`lane-change`**、不上傳，訊息列出新增／移除哪幾條；
  呼叫端明確設 `allowLaneChange: true` 才上傳。讀不到線上設定（權限、網路）不擋部署，只在進度訊息說明略過檢查——這是保護，不是門檻。
- `lane-change` 加進 `CLOUDFLARE_ERROR_KINDS`，Token 說明（`CLOUDFLARE_TOKEN_SETUP_GUIDE` 中英兩版、`docs/guides/cloudflare-api-token.md`）
  補上對應的疑難排解。
- wrangler 路徑沒有對應的檢查（wrangler 自己管上傳），在文件寫明：重新部署要帶同一份名單。
- 名單相同的重新部署完全冪等：同一份綁定、不送遷移。

### 3. NIP-11 多宣告三個欄位（中繼改動，低風險、DocHost 需要）

`buildRelayInfo` 新增（兩座宿主都有）：

- `cinder_addressable_per_author`：這條路徑的可尋址位址配額（嚴格 5、已知租戶 64、公用車道 16）；
- `cinder_addressable_max_bytes`：單顆可尋址事件上限（嚴格 256 KB、車道 32 KB）；
- `cinder_max_messages_per_second_per_ip`：只有設了才出現（Cinderous 錨點不設＝不限、不出現）。

理由與既有的 `cinder_addressable_ttl_sec` 相同：客戶端原本只能「送到第 17 個被拒」才知道自己落在哪一種車道。DocHost 連線前讀
`https://<host>/app/dochost`（`Accept: application/nostr+json`）就能確認自架站有沒有把它設成已知租戶、要不要節流。
⚠ 這三欄目前只在 SDK 中繼；錨點要等 Cinderous 改用 SDK 中繼（PR #9）或移植後才有，讀不到時客戶端照舊用保守值。

中繼程式有改，`relayWorkerSource` 重新產生。

## DocHost 在自架站上的可行性（有測試）

`tests/relay/worker.test.ts`〈自架站上的 DocHost 形狀〉把部署端 `relayWorkerVars(...)` 產生的環境變數**直接**餵給 Worker，
以 DocHost 的形狀（不做 AUTH、kind 31438、HMAC `d`、64 個桶）驗證：

1. **不需要實作 NIP-42 AUTH。** 車道（`/app/<id>`）的政策是 `requireAuth: false`：REQ 以 `authors` 或任一標籤 filter 具名即可，
   EVENT 不需要認證。車道連線一建立會收到一則 `["AUTH", <challenge>]`（為了讓想查 `#p` 的客戶端能認證）——**DocHost 必須忽略這則訊息**，
   不能把它當錯誤。DocHost 不用 `#p`，所以不受「`#p` 只能是認證過的自己」影響。
2. **白名單可以用，而且不需要 AUTH。** 白名單（`ALLOWED_PUBKEYS`）檢查的是**事件簽章者**（`event.pubkey`），不是連線身分；
   DocHost 以 `pk` 簽事件，只要 `pk` 在名單上就寫得進去，名單外的金鑰被拒（`blocked`）。
   - 要列進名單的是**簽事件的那把公鑰**。若 DocHost 各裝置用不同金鑰簽，每把都要列；若用同一把（`authors:[pk]` 的形狀暗示如此），列一把即可。
   - 白名單只管**寫入**。讀取不經白名單：任何人都能以 `authors:[pk]` 讀到密文。內容已加密、`d` 是 HMAC 值，洩漏的只有「這把公鑰有幾個桶、多大、何時更新」這類中繼資料。
   - 建議：自架站**帶白名單**部署（`allowedPubkeys: [pk]`）。開放站也能用（靠加密內容、HMAC `d` 與配額），但任何人都能把資料存進你的帳號額度。
3. **配額：** `appLanes: ['dochost']` 之後 `/app/dochost` 是已知租戶——64 個位址／(pk, 31438)，**64 個桶剛好放滿、第 65 個被拒**
   （沒有餘裕）；更新既有的桶（取代語意，`created_at` 較新者勝）不受影響。單顆事件（整顆 JSON）上限 **32 KB**；每個作者全部可尋址合計 8 MB；
   保存 30 天、每次更新重算。沒設 `appLanes` 則只放得下 16 個，而且 2 小時後消失。
4. **🔴 速率：** 一鍵部署預設 `MAX_MESSAGES_PER_SECOND_PER_IP=20`（錨點不設）。DocHost 一口氣推 64 個桶會在**第 21 則被斷線**。
   DocHost 要嘛節流（每秒 ≤ 15 則，含 REQ／CLOSE，留餘裕），要嘛部署時把 `maxMessagesPerSecondPerIp` 調高（例如 100）。
   另外所有車道都有每連線每分鐘 240 則訊息、每把公鑰每分鐘 120 則事件（`ABUSE_GUARD`，不可調）——64 桶一次推完沒問題，
   連續重推或重試迴圈會撞到。`MAX_CONNECTIONS_PER_PUBKEY` 只對完成 AUTH 的連線計數，對 DocHost 沒有作用。
5. **docker／fly 不可行。** Node 主機是單一嚴格平面：預設要求 AUTH、`/app/dochost` 不分流、可尋址配額 5。DocHost 要自架只能用 Cloudflare 版。

DocHost 需要做的最小清單：部署時帶 `appLanes: ['dochost']`（與建議的 `allowedPubkeys: [pk]`）；收到 `["AUTH", …]` 忽略；
推送節流或調高每 IP 上限；重新部署時帶同一份名單（遇到 `lane-change` 讓使用者確認）。

## 依「只同步差異」原則的建議（不改 DocHost，只提建議與 SDK 端支援）

### 現況的落差

64 個可尋址桶存的是**完整狀態**（每個桶是那一段資料的最新全貌），中繼以「活躍即永久」保存（30 天、每次更新重算）。這與原則有三個落差：

1. **中繼上長期存在一份完整狀態**（雖然加密）。原則是「同步後由本地為單一來源」，中繼只該留傳遞中的差異。
2. **改一筆劃線就重傳整個桶**（最多 32 KB），而且 64 個桶剛好頂到已知租戶配額，沒有擴充空間。
3. **🔴 在錨點上會變成別人的問題。** 錨點的 `/app/dochost` 是**所有 DocHost 使用者共用的一顆 DO**，而車道 DO 的可尋址容量天花板是
   128 MB、超過時**淘汰最快到期者**（Cinderous ADR-0367 §決策 2）。每位使用者最多 64 × 32 KB ≈ 2 MB，約 64 位重度使用者就會開始互相淘汰——
   而被淘汰的一方看不到任何錯誤。完整狀態放在中繼上，使用者一多就會安靜地掉資料。

### 建議的做法

**A（建議）：差異以一般事件傳遞、帶 NIP-40 期限。**

- 每次同步把「上次推送之後改變的資料」打成一則（或少數幾則，每則 ≤ 32 KB）一般事件（regular kind，1000–9999 之間 DocHost 自選一個），
  content 照舊加密；帶 `["expiration", now + N]`，N 取「裝置可以離線多久」（例如 7–14 天；中繼再以 `MAX_TTL_DAYS` 夾，預設 7 天）。
- 讀取用 `{kinds:[K], authors:[pk], since: 游標 − 時鐘餘裕}`，以事件 id 去重、套用後推進游標；一次 REQ 最多 1,024 則／16 MB，超過用 `until` 分頁。
- 差異要能**冪等、可交換地套用**（例如每筆變更帶自己的 id 與時間戳、刪除以墓碑表示），因為各裝置收到的順序不同、也可能重複收到。
- 離線超過保存期的裝置收不齊差異：這時退回「完整交換」——由另一台在線裝置直接給（P2P），或下面的檢查點。這是原則下唯一需要完整狀態的時刻，而且只在那一刻。
- 好處：中繼上只剩保存期內的差異；一筆劃線只傳一筆；不受可尋址配額限制；在錨點上走一般事件的無收件人桶，受 TTL 與天花板約束，量級小得多。

**B（保守、改動最小）：保留可尋址，但定位成「最新差異摘要」並加期限。**

- 現有 kind 31438 的事件**現在就可以**加 `["expiration", now + N]`：中繼取 `min(過期章, 30 天)`（測試釘住：3 天的章 3 天後消失、400 天的章夾到 30 天）。
  這一步不需要任何 SDK 或中繼改版，錨點上也成立——最低成本地把「永久完整狀態」變成「N 天後消失」。
- 進一步把桶的內容從「該段全貌」改成「尚未被所有裝置確認的變更」，並把桶數降到每台裝置少數幾個（`d = HMAC(裝置‖槽)`），
  確認後清空。缺點是要處理「哪些裝置確認過」，比 A 複雜，而且可尋址的取代語意會讓並行寫入同一個桶時互相覆蓋。

### 車道層級的參數要不要在部署時可設

- **保存期**：DocHost 用 NIP-40 就能自己縮短（A、B 都是），而且在錨點上同樣有效——**不需要**車道層級的保存期旋鈕。
  自架站的一般事件保存上限已經可以用 `maxTtlDays` 設。
- **可尋址配額**：若採 A，DocHost 不再需要 64；若維持完整狀態，64 剛好頂滿、將來需要更多時才值得做。
  需要時的設計見 ADR 0037〈後續〉的 `APP_LANE_POLICY`（例如 `dochost:addr=128,ttl=14d`），部署端以 `appLanePolicies` 開放；本版不做。

## Consequences

- ＋ DocHost（與任何第三方應用）可以一鍵部署出把自己設為已知租戶的中繼；四條路徑同一份驗證，docker／fly 明確拒絕不支援的參數。
- ＋ 忘了帶名單的重新部署不會再默默把車道搬走（REST 路徑）。
- ＋ 客戶端能從 NIP-11 讀到配額與每 IP 上限。
- － REST 重新部署多一個 API 呼叫（讀設定）。
- － `CloudflareErrorKind` 多一種 `lane-change`：依錯誤分類顯示文字的 UI 會自動拿到說明（以 `CLOUDFLARE_TOKEN_SETUP_GUIDE` 為鍵）；
  自己寫 `switch` 的要補一個分支。
- － 中繼的打包 Worker 重新產生（只多三個 NIP-11 欄位）；主入口不受影響。

## 後續

- NIP-11 的三個新欄位移植到 Cinderous 錨點（或隨 PR #9 改用 SDK 中繼）。
- 車道層級的政策（`APP_LANE_POLICY`）見 ADR 0037。
- wrangler 路徑的名單變更檢查（需要讀 wrangler 的線上設定，或改走 REST 讀一次）。
