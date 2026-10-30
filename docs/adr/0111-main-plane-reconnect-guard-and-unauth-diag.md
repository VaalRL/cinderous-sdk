# 0111. 主平面的反覆重連限速與「沒認證就斷線」的診斷（移植 Cinderous ADR-0391、0392）

- 狀態：**已接受（Accepted，2026-10-27）**——使用者 2026-10-27 同意 Cinderous PR #9 的計畫：「1 ok」（先把 0391、0392 移植到 SDK，發 v0.77.0）
- 日期：2026-10-27
- 對應：Cinderous ADR-0391（主平面的反覆重連限速）、0392（沒認證就斷線的診斷）、0370（Cinderous 中繼改用 SDK 的中繼）；SDK ADR 0064（中繼日誌不帶使用者資料）、0097（1013 的回絕形狀）、0108（用戶端遇到 1013 整座退避）

## Context

Cinderous PR #9 要讓 Cinderous 的中繼直接用 SDK 的中繼（ADR-0370）。SDK 已經移植了 Cinderous 中繼到 ADR-0390 為止的改動，缺兩份：

- **ADR-0391**（2026-10-20）：錨點 2 一天約 4.6 萬次 DO 請求，87% 是同一個來源每 8 秒重連 `shard-b`。主平面原本完全不限速。修法是兩道閘：
  - Worker 那一道：Cloudflare 限速 binding `STRICT_UPGRADE_LIMIT`，以「IP＋DO 名」每 60 秒 4 次；
  - DO 那一道：記憶體裡以 IP 計 10 分鐘 20 次，超過擋 10 分鐘。
- **ADR-0392**：0391 部署後來源改成輪替 IP，所以加了預設關閉的診斷，記下這種連線送了什麼。

0391 已經部署在錨點上（錨點 1 目前的版本帶 `STRICT_UPGRADE_LIMIT` binding）。PR #9 切到 SDK 的中繼時，若 SDK 沒有這兩道閘，錨點的防護就會在部署時默默消失。

## Decision

1. **照 Cinderous 的實作逐字移植**：`src/relay/reconnect-guard.ts`、`src/relay/unauth-diag.ts` 與它們的測試。Worker 整合的位置、條件與 Cinderous 相同：
   - Worker：`route.profile !== "app"`、有 binding、有 `CF-Connecting-IP` 才限，鍵是 `${ip} ${route.doName}`（大小寫變化繞不過去）。
   - DO：在 `acceptWebSocket` 與**任何儲存寫入之前**（包括第一次釘住政策）回絕，只花這一次 DO 請求；不寫儲存，DO 被回收時計數歸零。最多記 2,048 個 IP。
   - `RECONNECT_GUARD`：`次數/窗口秒/封鎖秒`，預設 `20/600/600`，`off` 關掉；格式不對退回預設，打錯字不會讓防護消失。
   - `DIAG_UNAUTH_LOG=1` 才開診斷；認證過的連線一律不記；不記內容、公鑰、IP、filter 的其他欄位。`RelayCore` 多一個公開的 `isAuthenticated(connId)`。
2. **回絕形狀**：新的 `RejectKind` `"reconnect-limited"`，句子與 Cinderous 錨點逐字相同：
   - NOTICE：`rate-limited: too many reconnects from your IP; wait a few minutes before reconnecting.`，有文件網址時加 ` Docs: <url>`；
   - 以 **1013** 關閉，原因是 `rate-limited: reconnects; docs: <url>`；超過 123 bytes 或沒有文件網址時只留 `rate-limited: reconnects`。
   - 和其他 1013（額度用完、儲存起不來）不同的是**原因保留文件網址**：這是用法太頻繁，開發者可以查得到原因。
   - 用戶端照 ADR 0108 把 1013 當成「這座暫時不能用」、整座退避 5 分鐘，不會立刻再連（有測試守著）。
3. **DO 那一道預設開啟，Worker 那一道要站主自己綁**：SDK 的部署工具（`relay deploy`、`relay build`、`cloudflare-api`）目前不產生任何限速 binding（`APP_LANE_LIMIT` 也一樣），這次不改。Cinderous 的 `wrangler.toml` 照舊綁著 `STRICT_UPGRADE_LIMIT`，所以 PR #9 切過去之後兩道都在。兩份 README 補一段說明。
4. **只有 Cloudflare 版**：Node 版中繼（`relay start`）已經有 `MAX_CONNECTIONS_PER_IP`（ADR 0100），重連的成本也不是按請求計費，這次不加。
5. **發成 v0.77.0**：`RejectKind` 多一個值、`RelayCore` 多一個公開方法、Worker 多三個設定。

## Alternatives Considered

- **DO 那一道預設關閉**：SDK 的站主就不會因為行為改變而意外擋人；但錨點切到 SDK 時要記得設，忘了就沒有防護。Cinderous 的預設本來就是開的，正常用戶端每個分片一條連線、連上就掛著，10 分鐘 20 次只有壞掉的用戶端才會碰到。
- **把計數寫進 DO storage**：DO 回收後還記得，但每次升級都多一次寫入，正好是這道閘要省的成本；也違反中繼不持久化線上狀態的原則。
- **部署工具順便產生 `STRICT_UPGRADE_LIMIT` binding**：限速 binding 要 `namespace_id`，站主在同一個帳號有多座 Worker 時要自己挑；和 `APP_LANE_LIMIT` 一起之後再決定。

## Consequences

- ＋ PR #9 切到 SDK 的中繼時，錨點的防護不會消失。
- ＋ 照 SDK 自架的 Cloudflare 中繼也有 DO 那一道。
- － 行為改變：同一個 IP 後面有很多裝置、又一直斷線重連的站（例如公司網路），在 10 分鐘內第 21 次升級起會被擋 10 分鐘。可以用 `RECONNECT_GUARD` 放寬或關掉。
- － 診斷要部署時打開、看完重新部署關掉；日誌只在 `wrangler tail` 當下看得到。
- 驗證：
  - 移植的單元測試（`reconnect-guard`、`unauth-diag`）；
  - Worker 測試：兩道閘、`off` 與自訂值、車道不套、回絕句子逐字、1013 的用戶端分類、診斷開關與認證過不記；
  - `log-hygiene` 測試照舊通過（`console.log(line)` 不帶使用者資料）。

## 後續（2026-10-30）

- ADR 0130：用戶端被重連閘擋下時不再整座等 5 分鐘，改從 60 秒起退避（連續被擋才加倍到 5 分鐘），並加抖動，避免共用 IP 後面的人同時重連。
- ADR 0131：DO 那一道改成主要只計沒認證就斷線的連線（10 分鐘 20 條），認證過的只算總上限（預設 60），共用 IP 後面的正常使用者不再被一起擋。
