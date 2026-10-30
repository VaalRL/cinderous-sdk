# 0108. 中繼以 1013 關閉＝這座暫時不能用：分類、整座退避 5 分鐘、配對逾時說是中繼的問題

- 狀態：**已接受（Accepted，2026-10-22）**——使用者 2026-10-22 指示「要先修上面那個 1013 的問題」
- 日期：2026-10-22
- 對應：SDK ADR 0038 P0-C（關閉碼分類）、0041（健康狀態）、0097（DO 起不來時以 1013 說明原因）、0101（每月流量用完）；CinderSync 實機重測（SDK ADR 0107）

## Context

2026-10-22 下午在 motorola 實機重測 ADR 0106／0107 時，錨點 1當天的 Cloudflare 儲存寫入額度用完。中繼照 ADR 0097 的設計接受升級，送出 `NOTICE "over quota: … until it resets (around 00:00 UTC). Use another relay meanwhile."`，再以 **1013 `over quota`** 關閉。

中繼端早就說清楚原因了，但客戶端看不懂：

- `classifyRelayClose` 只認 4003 與 1008，**1013 當成一般斷線**（`disconnected`），所以：
  - 沒有健康標記，`relayHealth()` 的 `marks` 是空的；
  - 照一般退避重連，最長 10 秒一次，每次都馬上被關。額度要到隔天才恢復，等於整天每 10 秒打一次；
  - 要求耐久的發布不會略過它。
- 應用只看得到「離線」：
  - CinderSync 的狀態列顯示離線，沒有原因；
  - 新裝置配對等滿 60 秒，只說「另一台裝置沒有及時回應」，使用者會去檢查另一台，而不是知道中繼今天不能用。

## Decision

1. **分類**：`RelayRejectKind` 新增 `unavailable`（`retryable: true`、`tryOtherRelays: true`）。`classifyRelayClose` 把 **1013 一律分成 `unavailable`**，不看原因；`over quota`、`temporarily unavailable`、每月流量用完都是這個碼。
2. **健康狀態**：以 1013 關閉時，整座（`*`）記一個 `backoff` 標記，`kind: 'unavailable'`、帶中繼給的原因，維持 `unavailableMs`（新增的冷卻，預設 **5 分鐘**）。
   - 照既有規則，要求耐久的發布會略過它；
   - 那一座回了任何 `EOSE` 就清掉這個標記（`RelayHealthTracker.served`）。之所以不在連上（`open`）時清，是因為額度用完時中繼一樣接受升級，之後才關。
3. **重連**：以 1013 關閉的那一座，**等到標記過期才重連**（`max(最長退避, 標記剩下的時間)`），每 5 分鐘試一次。
   - 不解析 NOTICE 裡的恢復時間：格式只有我們自己的中繼有，5 分鐘也夠快恢復；
   - 應用要求的 `reconnectNow`（健康探針）照舊立刻重連，不受影響。
4. **配對**：握手逾時時，如果連線池看得到健康狀態（`RelayPool.relayHealth`），而且**每一座主要中繼**都有 `unavailable` 標記（備援不算），就以新的 `PairingFailure` **`relay-unavailable`** 結束，訊息帶中繼給的原因。
   - 有一座沒被標記、或者自訂傳輸層沒有健康狀態時，照舊回 `timeout`。

## Consequences

- ＋ 錨點額度用完時，客戶端每 5 分鐘試一次，不再每 10 秒一次；用量恢復後最慢 5 分鐘連回。
- ＋ 應用看得到原因：`onRelayReject` 收到 `kind: 'unavailable'`、`code: 1013`，`relayHealth()` 的標記帶 `over quota`。可以照實說「這座中繼今天的額度用完」，配對失敗也能說是中繼的問題。
- ＋ 不改線上格式，中繼不必升版（ADR 0097 起就送 1013）。
- － `PairingFailure` 多一個值：用 `Record<PairingFailure, string>` 對應訊息的應用要補一句（TypeScript 會提示）。
- － 中繼恢復之後，最多晚 5 分鐘才連回（除非應用先 `reconnectNow`）。
- 測試：
  - `tests/relay-pool-unavailable.test.ts`：1013 的分類、標記 5 分鐘、重連等到標記過期、再被關就再等、`reconnectNow` 後回了 EOSE 就清掉、耐久發布略過；
  - `tests/pairing/relay-unavailable.test.ts`：每一座都不能用時是 `relay-unavailable`；有一座正常、只有備援不能用、沒有健康狀態時照舊 `timeout`。
  - 變異測試：拿掉配對的判斷、拿掉 EOSE 清標記，各有一項失敗。

## 後續（2026-10-30）

- ADR 0130：關閉原因是 `rate-limited: reconnects`（重連太頻繁，ADR 0111）時改從 60 秒起退避、連續被擋才加倍到 5 分鐘；所有 1013 的等待多加 0～20% 抖動。
