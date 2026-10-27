# 0097. Durable Object 起不來時說明原因：額度用完與暫時無法使用，以 1013 關閉

- 狀態：**已接受（Accepted，2026-10-19）**——使用者 2026-10-19「好，附上原因」
- 日期：2026-10-19
- 對應：Cinderous ADR-0368（拒絕連線時說明原因）、ADR-0387（同一件事在 Cinderous 的中繼）；CinderSync ADR 0094、0095 的實機測試

## Context

2026-10-19 錨點 1 的 Durable Objects 免費每日寫入額度被用光。整座中繼對任何路徑的 WebSocket 升級都回 500，錯誤碼 1101（Worker 拋出例外），包括：
- 聊天主中繼的根路徑；
- `/app/cindersync`、`/app/dochost`。

原因是 Worker 把連線轉給 Durable Object 時直接 `return stub.fetch(request)`，沒有接住錯誤。結果：
- 客戶端分不出這是「這座暫時不能用、改用別座」還是「我用錯了」。
- 畫面上沒辦法說清楚原因。
- 只會一直重試，每次重試又是一次失敗的請求。

## Decision

1. Worker 轉給 Durable Object 時接住錯誤：`stub.fetch` 拋錯，或回 5xx 而且沒有 WebSocket。
2. 照 ADR-0368 的形狀回應：接受升級、送一則 `NOTICE`、關閉。關閉碼改用 **1013 Try Again Later**，跟「你連錯了」的 1008 分開。
3. 兩種原因：

   | 情況 | 判斷方式 | `NOTICE` 開頭 | 內容 |
   |---|---|---|---|
   | 額度用完 | 錯誤訊息含 `exceeded allowed rows written／read`、`free tier`、`quota` | `over quota:` | 說明約在 00:00 UTC 恢復，先改用別座 |
   | 其他錯誤 | 其餘 | `temporarily unavailable:` | 請稍後再試或改用別座 |

   這兩種不是用法錯誤，所以不附開發者文件網址。
4. 內部錯誤訊息只寫進 Worker 日誌（`console.error`），不回給客戶端，以免洩漏路徑或實作細節。
5. 正常的回應（101 等）原樣轉回。

## Alternatives Considered

- **回 HTTP 503 加 `Retry-After`**：瀏覽器的 `WebSocket` 看不到升級失敗的狀態碼與標頭，只會得到一個沒有原因的錯誤。ADR-0368 就是為了這個才改成「接受、送 NOTICE、關閉」。
- **不分兩種原因**：額度用完時「多久會恢復」是使用者最想知道的事，值得單獨說。

## Consequences

- ＋ 錨點額度用完時，客戶端拿得到明確的原因與恢復時間，可以馬上換別座；畫面也能照實說明。
- － 判斷「額度用完」靠的是 Cloudflare 的錯誤訊息文字。改了就會落到「暫時無法使用」，仍是正確的退路。
- 要部署到錨點才生效（Cinderous ADR-0387；部署要使用者同意）。
- 驗證：`tests/relay/worker.test.ts`〈DO 起不來時說明原因〉。
