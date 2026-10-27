# 0076. 認證前被應用車道以 restricted 擋下的 REQ：客戶端當成等認證；SDK 中繼改回 auth-required

- 狀態：**已接受（Accepted，2026-10-13）**——使用者 2026-10-13：CinderSync 自動化實機驗證找到 →「三個 bug 都修」；實作於 v0.57.0
- 日期：2026-10-13
- 對應：ADR 0005（一次性查詢、auth-required 重送）、0045（`queryResult`、`answered`）；Cinderous ADR-0366／0369（應用車道的範圍檢查與可選 AUTH）

## Context
2026-10-13 在兩個真實的 Obsidian（CinderSync）上連錨點車道 `/app/cindersync` 驗證時發現：**剛連上時的第一個查詢一定回 0 筆**，緊接著再查就有 145 筆（4/4 重現）。

應用車道一連上就發 NIP-42 挑戰，但不強制認證。範圍檢查規定 `#p` 只能是自己，而「自己」要認證後才算數。所以認證完成前到的 `#p` REQ 會收到：

```
CLOSED  restricted: (scope:) app lanes need ... #p set to yourself after NIP-42 AUTH
```

這不是 `auth-required:`。RelayPool 把 `restricted:` 當成永久拒絕：
- 一次性查詢直接結案為 `closed`，不在認證後重送；
- 常駐訂閱會經 `onRelayProblem` 回報（認證後 `#sendSubscriptions` 照樣補送，所以訂閱本身沒丟）。

影響：CinderSync 每一輪的補拉（`backfill()`）只試兩次，第一次固定浪費；Cinderous 的錨點與 SDK 中繼都是這樣回。

## 決策
1. **客戶端（RelayPool）**：同時符合下面三個條件時，`restricted:` 的 CLOSED 當成「等認證」——查詢記進 `awaitingAuth`、認證成功後重送；常駐訂閱不回報（認證後照常補送）。認證後仍被擋才算拒絕。
   - 有身分可以認證；
   - 這條連線收過挑戰；
   - 還沒認證完成。

   沒收過挑戰（不做 NIP-42 的中繼）時照舊直接算拒絕，不會空等到逾時。
2. **SDK 中繼**：應用車道上還沒認證就送帶 `#p` 的 REQ、而範圍檢查不過時，回 `auth-required:`（附挑戰），不再回 `restricted:`。裸 filter 等「認證後也不會過」的照舊 `restricted:`；認證後 `#p` 指向別人照舊 `restricted:`。
3. Cinderous 的錨點跑的是 Cinderous 自己的中繼：不在這裡改。客戶端的修正讓現有的錨點不必重新部署就好了；錨點改用 SDK 中繼（Cinderous PR #9）之後兩邊一致。

## 試過、沒有採用
- **只改中繼**：已部署的錨點與使用者自架的中繼要重新部署才生效；客戶端修正立刻對所有中繼有效。
- **任何 restricted 都等認證**：不做 NIP-42 的中繼真的拒絕時，查詢會空等到逾時；以「收過挑戰」區分。
- **連上後先等認證完成才送 REQ**：不需要認證的中繼會被拖慢，要另外判斷；現在的做法只在真的被擋時才等。

## Consequences
- ＋ 剛連上的第一個查詢不再浪費；CinderSync 補拉的兩次嘗試都有效。
- ＋ 常駐訂閱不再在認證前誤報「中繼拒絕」。
- ＋ SDK 中繼的回應符合 NIP-42：標準的客戶端看到 `auth-required:` 就知道要認證後重送。
- － 中繼的拒絕訊息改了：依賴舊文字（`restricted: … after NIP-42 AUTH`）的第三方客戶端要改看 `auth-required:`（Cinderous ADR-0369 的兩個測試已照新語意更新）。
- 驗證：`tests/relay-pool.test.ts`〈認證前被應用車道以 restricted 擋下〉（查詢重送、認證後仍擋才算拒絕、訂閱不回報、沒收過挑戰照舊拒絕）；`tests/relay/relay-core.test.ts`〈車道上還沒認證就送 `#p`：回 auth-required〉與 ADR-0369 組更新。
