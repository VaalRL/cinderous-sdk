# 0089. 暫存是單一本機檔案時回報路徑：收完的大檔可以直接改名進 Vault，不讀出再寫

- 狀態：**已接受（Accepted，2026-10-15）**——使用者 2026-10-15「依你建議修改」
- 日期：2026-10-15
- 對應：ADR 0026（P2P 串流與暫存 `StreamingFileStore`）、0057（`VaultContentSource.sha256`）；CinderSync ADR 0027、0082；
  CinderSync TODO〈ADR 0027〉2026-10-15 Pixel 8a 實測

## Context
大檔經 P2P 收到後，協調器把暫存交給轉接器的 `writeStream`：轉接器分段讀出暫存、附加寫進 Vault 旁的暫存檔、最後改名到目的地。
2026-10-15 在 Pixel 8a（Obsidian 行動版）收 200 MB：接收期間記憶體只多 25～50 MB，但收完寫進 Vault 的 30～40 秒高峰 +160～255 MB。
單獨實驗：行動版每次讀寫都經原生橋接轉 base64，暫時的大字串在垃圾回收前堆起來——`appendBinary` 4 MiB×50＝+175 MB、`readBinary` 4 MiB×50＝+75 MB，
**改名 50 ms、記憶體不變**。收完之後「讀出再寫」整份內容，正是那個高峰。

## Decision
- `StreamingFileStore` 加選配的 `localPath(id): Promise<string | undefined>`：暫存是本機的**單一檔案**時回傳路徑（呼叫前要把還在記憶體的部分寫進檔案）。
- 串流整檔校驗通過、交給 App 之前呼叫它，放進 `ReceivedEntry.stagedPath`；協調器的大檔來源帶上 `VaultContentSource.stagedPath`
  （協調器包裝的暫存也轉傳 `localPath`）。
- 轉接器可以直接把那個檔案改名成目的地（前置條件、備份照舊），不讀出再寫。取走之後暫存就不在了：之後的 `delete`／`commit` 要容忍檔案不存在。
- 沒有實作 `localPath`、或拿不到路徑：照舊分段讀（行為與 v0.62 相同）。

## Alternatives Considered
- **只把附加寫入改小（1 MiB）**：單獨量有效（+50 MB），實際流程沒改善——讀回暫存的那一半還在；已撤回。
- **SDK 直接操作 Vault 的檔案系統做改名**：SDK 不知道 App 的暫存與 Vault 在不在同一個檔案系統、怎麼改名；交給轉接器決定。

## Consequences
- ＋ App 的暫存改成單一檔案（例如 CinderSync 在有 `appendBinary` 時）之後，收完只做一次改名，收尾不再讀寫整份內容。
- － 暫存被取走之後，同一份內容的重送要重新傳（原本也會在寫入後刪暫存，差別不大）。
- 驗證：`tests/sync/vault/p2p.test.ts`〈暫存區回報本機路徑時，交給 writeStream 的來源帶 stagedPath〉；全套 209 檔 2,989 項通過。
