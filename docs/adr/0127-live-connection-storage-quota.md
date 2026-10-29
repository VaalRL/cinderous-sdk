# 0127. 已經連著的連線也說清楚「額度用完」

- 狀態：**已接受（Accepted，2026-10-29）**——使用者 2026-10-29 選「讓已經連著的連線也說清楚額度用完」並要求實作後合併
- 日期：2026-10-29
- 對應：SDK ADR 0097（升級被拒時的 `over quota:`＋1013）、0108（客戶端看懂 1013、整座退避 5 分鐘）、0101（Node 版每月流量用完，新舊連線都收到）、0126（同一天的讀取來源）；Cinderous ADR-0395（客戶端看懂 1013）；CinderSync ADR 0101

## Context

2026-10-22，錨點 1 的 CinderSync 車道撞到免費方案每日 500 萬列的**讀取**上限（ADR 0126）。之後每一條 SQL 都拋錯，直到 00:00 UTC 重置。

ADR 0097 只處理了**新連線**：DO 起不來時，Worker 接受升級、送 `over quota:` NOTICE、以 1013 關閉。但**已經連著的連線**走的是另一條路：

- `RelayCore.handle` 的 catch 一律回 `NOTICE "error: internal: 內部錯誤，請稍後再試"`，連線不關。
- 送出去的 EVENT 沒有 `OK`，客戶端只能等逾時。REQ 也沒有 `CLOSED`。
- 客戶端以為連線正常，在同一條連線上一直重送、一直失敗，直到重置。
- 喚醒還原（`ensureHydrated`）或存訂閱時撞到的話，錯誤在 core 之外，完全沒有接住。

CinderSync 那天的「中繼弄丟了刪除版本」（CinderSync ADR 0101），很可能就是這樣：寫入失敗，但沒有任何一個訊號說明原因。

另外，0097 的句子寫的是「storage **write** allowance」，但那天撞到的是讀取。

## Decision

### 1. core 可以分辨「額度用完」

`RelayCoreOptions.isStorageExhausted?: (error) => boolean`。DO 宿主給 `doFailureKind(e) === "over-quota"`（0097 的同一個判斷）；Node 宿主不給，一律照舊當內部錯誤。

處理到一半拋出、而且判定為額度用完時，`storageExhausted(connId, raw)` 回：

1. 先結案這一則：EVENT 回 `["OK", id, false, "over quota: …"]`，REQ 回 `["CLOSED", subId, "over quota: …"]`。從原始訊息只取 EVENT 的 id 與 REQ 的訂閱 id，取不到就略過這一步。
2. 一則 `NOTICE "over quota: …"`，送完以 **1013**、原因 `over quota` 關閉。

客戶端照 0108 整座退避 5 分鐘，不再在同一條連線上打。之後重連時 DO 若仍起不來，就走 0097 的升級被拒。

### 2. core 之外也接住

`webSocketMessage` 包一層：喚醒還原、存訂閱時撞到額度，送同一組回覆並關閉。其他錯誤照舊拋出，不把一般錯誤說成額度用完。

### 3. 句子改成讀寫都涵蓋

`STORAGE_QUOTA_REJECTION`（升級被拒與已連著的連線共用）：

> over quota: this relay has used up its daily storage allowance (rows read or written) and cannot serve connections until it resets (around 00:00 UTC). Use another relay meanwhile.

前綴 `over quota:` 與關閉原因 `over quota` 都不變。客戶端只看前綴，所以舊版客戶端照樣認得。

## Consequences

- 額度用完時，已經連著的客戶端會馬上知道原因，而不是等逾時、看到「內部錯誤」。
- 一般的 storage 錯誤（`SQLITE_BUSY` 之類）行為不變：NOTICE `error: internal`、連線不關。
- 判斷靠 Cloudflare 的錯誤訊息（0097 的正規表示式涵蓋 `rows read`、`rows written`、`free tier`、`quota`）。Cloudflare 改了措辭就會退回「內部錯誤」，不會誤判。
- 修正要部署到錨點才生效；部署照慣例要使用者另外同意。

## 測試

`tests/relay/worker.test.ts`〈額度用完時已經連著的連線〉：EVENT 回 `OK false over quota:`＋NOTICE＋1013（而且 `classifyRelayClose` 分類成 `unavailable`）；REQ 回 `CLOSED over quota:`＋1013；喚醒還原時就撞到額度也不拋、NOTICE＋1013；一般錯誤照舊 `error: internal`、不關；升級被拒用同一句。破壞測試 8/8。
