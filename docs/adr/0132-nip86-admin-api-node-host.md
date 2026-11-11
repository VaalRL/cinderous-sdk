# 0132. 自架 Node 主機的 NIP-86 管理 API：成員只能用簽章名冊改

- 狀態：**已接受（Accepted，2026-11-11）**——使用者 2026-11-11 接受 Cinderous ADR-0261 並同意「只在自架 Node 主機開、官方錨點不開」
- 日期：2026-11-11
- 對應：Cinderous ADR-0261（NIP-86 規劃）、0044（企業封閉 allowlist）、0047（簽章名冊＝成員權威）、0048（事件類型政策）、0260（NIP-11）、0370（協定搬進 SDK）；SDK ADR 0007（Node 主機）、0008（`ALLOWED_PUBKEYS`）

## Context

自架企業站的成員（`ALLOWED_PUBKEYS`）與站名都只能在啟動時用環境變數設，改一個人就要重開站。Cinderous ADR-0261 選了 NIP-86 子集＋專屬方法 `cinder_applyroster`，但卡在「Cloudflare 版有分片，執行期更新要傳到每一顆 DO」。

使用者決定只在 **Node 主機**開：它只有一個 `RelayCore`，沒有分片傳播的問題；官方錨點（Worker）不受影響、不必重新部署。

## Decision

1. **只在 Node 主機（`startNodeRelay`）提供，預設關**。設了 `NIP86_ADMIN_PUBKEYS`（運維金鑰，npub 或 hex，逗號分隔）才開；沒設＝這個端點不存在，行為與之前完全相同。Worker 不實作。
2. **傳輸**：對中繼站同一個網址 `POST`，`Content-Type: application/nostr+json+rpc`，內容 `{"method": "...", "params": [...]}`，回 `{"result": ..., "error": ...}`。內容上限 1 MiB。
3. **授權**：NIP-98（`Authorization: Nostr <base64>`），簽署者要在 `NIP86_ADMIN_PUBKEYS` 裡；**必須帶 `payload` tag**（內容的 sha256），`u` 比對主機＋路徑（http／https 都接受——反向代理後面分不出原本的協定），時間窗 60 秒。失敗一律 401、不說原因。
4. **成員只能用簽章名冊改**：
   - `cinder_applyroster [名冊事件]`：用 `ROSTER_ADMIN_PUBKEY` 驗（`verifyOrgRoster`），**比上次套用的新**才採用（`updatedAt`），名單＝`rosterAllowlist`（不含已輪替作廢的舊金鑰）。
   - `allowpubkey`／`unallowpubkey`／`banpubkey`／`unbanpubkey` 回錯誤、指向名冊流程。否則中繼能悄悄加人，客戶端驗不出來（Cinderous ADR-0047）。
   - `listallowedpubkeys` 唯讀；`listbannedpubkeys` 恆空（本站沒有封鎖清單）。
5. 🔴 **運維金鑰不得等於名冊金鑰**：`ROSTER_ADMIN_PUBKEY` 出現在 `NIP86_ADMIN_PUBKEYS` 裡就拒絕啟動。名冊金鑰是組織的成員權威、離線保管；運維金鑰是這台機器的憑證，可能交給託管方。混在一起等於把成員權威交出去。
6. **事件類型政策**：新增 `ALLOWED_KINDS`（寫錯任何一筆就拒絕啟動，同 `ALLOWED_PUBKEYS`）。`allowkind`／`disallowkind`／`listallowedkinds` 只改**已存在**的清單：
   - 沒設 `ALLOWED_KINDS`＝全部接受：`allowkind` 不必做事、回 `true`；`disallowkind` 回錯誤（沒有清單可以刪，也不從一個 kind 起建清單——那會讓整站只剩那一種事件）。
   - 不能刪掉最後一個 kind（那等於整站拒收）。
7. **站名與說明**：`changerelayname`／`changerelaydescription` 改 NIP-11 的 `name`／`description`（各 100／2000 字以內）。
8. **持久化**：有 SQLite 檔時存在 `cinder_admin_state` 表，重開後**蓋過**環境變數（名冊、事件類型、站名、說明）；純記憶體模式重開就回到環境變數的值（啟動時警告）。
9. **宣告**：開了才在 NIP-11 `supported_nips` 加 86；`supportedmethods` 只列實際提供的方法（沒設 `ROSTER_ADMIN_PUBKEY` 就不列 `cinder_applyroster`）。
10. **紀錄**：每次成功的寫入在主機日誌記一行（運維金鑰前 8 碼＋方法），不記參數內容。
11. 名冊驗證程式（`org-roster`）自 Cinderous `packages/core` 搬到 `@cinderous/client/protocol`，Cinderous 照原名轉出（同 Cinderous ADR-0370 的做法）。

## 理由

- Node 主機單一核心，套用名冊就是換掉一個 Set，沒有分散式問題。
- 名冊本身帶管理者簽章，運維 API 只是**送達管道**，權威沒有移動。
- `disallowkind` 不從空清單起建：一行指令讓整站只收一種事件，是很難察覺的事故。

## Alternatives Considered

- **Worker 也做**：要先解分片傳播（共享設定 DO 或 KV），而官方錨點沒有企業成員可管。等真的有託管企業站在 Cloudflare 上再做。
- **運維金鑰直接改成員**：最簡單，但成員資格變成客戶端驗不出的東西。否決（Cinderous ADR-0261 選項 2）。
- **防重放表**：簽章綁了內容與 60 秒時間窗，方法都是冪等或後蓋前；重放只能在 60 秒內重做同一件事。先不做，記在殘餘風險。

## Consequences

- 正面：自架企業站改成員、改政策、改站名都不用重開。
- 殘餘風險：
  - 新的對外 HTTP 面；以內容上限、先驗結構後驗簽、預設關限制。
  - 60 秒內可重放同一個請求（見上）。例如 A→B→A 改站名時，攻擊者重送「改成 B」的請求；要能截到 TLS 裡的標頭才辦得到。
  - `cinder_applyroster` 是非標準方法，通用 NIP-86 工具不會用。
- 後續：Cinderous 升級本版後，企業管理端可加「推送名冊到自架站」的按鈕（另開 Cinderous PR）。
