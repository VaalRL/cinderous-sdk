# 0070. 整庫還原的預覽列出「之後建立、會留著的檔案」（`keep`）

- 狀態：**已接受（Accepted，2026-10-12）**——使用者 2026-10-12 裁示（CinderSync TODO〈整庫還原的預覽〉：「要」）；實作於 v0.53.0
- 日期：2026-10-12
- 對應：ADR **0063**（版本歷史、整庫回到時間點、`planRestoreVault`）、0063 補充（v0.50 的 `removeCreatedBinaries`）；CinderSync ADR 0055

## Context
`planRestoreVault(T)` 沒打開 `removeCreatedAfter` 時，T 之後才建立的檔案**完全不出現在預覽裡**（`addToRestorePlan` 直接 return）。使用者看預覽時以為 Vault 會「回到 T 時的樣子」，執行後卻多出一堆檔案，不知道那是刻意留下的。

## 決策
- `VaultRestorePlan` 多一欄 `keep?: VaultRestoreItem[]`：T 之後建立、這次**留著**的檔案（文字與二進位都列，依路徑排序；`paths` 範圍照樣套用；本機排除的不列）。
- 只在 `removeCreatedAfter` 沒打開時有；打開時這些檔案照舊改列 `remove`（或 `unrestorable`），`keep` 是空陣列。
- **只給預覽顯示**：`restoreVault` 不讀這一欄、不動這些檔案；不算在變更數裡。
- 選配欄位：舊版、或應用自己組的預覽沒有這一欄，照常執行。

## Alternatives Considered
- **列在 `unrestorable`（原因 `kept`）**：它們不是「無法還原」，是使用者選擇留著；混在一起誤導。否決。
- **只回個數**：使用者要看得到是哪些檔案才能決定要不要勾「刪除之後建立的」。否決。

## Consequences
- ＋ 預覽與執行結果一致：看得到會多出哪些檔案。
- － 預覽多一份清單（大 Vault 的 T 很早時可能很長；應用自己截斷顯示，CinderSync 每組最多列 N 個＋「還有 M 個」）。
- 驗證：`tests/sync/vault/history-lazy.test.ts`〈預覽：沒打開 removeCreatedAfter 時，T 之後建立的檔案列在 keep…〉（文字與二進位都列、依路徑排序、`paths` 範圍、打開時是空的、執行時不動）。
