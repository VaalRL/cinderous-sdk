# 0024. 非同步 `ChatStorage`：新增 `AsyncChatStorage`，讀取在背景、寫入排隊一次一個

- Status: Accepted
- Date: 2026-09-29
- 相關：ADR 0021〈後續〉#7（外掛 CC G6）、ADR 0001（`DirectMessages`、`Blocklist`）、ADR 0010（雙棘輪）

## Context

`ChatStorage` 是 `localStorage` 的同步子集（`getItem`／`setItem`）。外掛想用 IndexedDB，那是非同步的。

先查清楚 `ChatStorage` 存了什麼：只有兩個使用者——`DirectMessages`（NIP-17 對話紀錄）與 `Blocklist`（封鎖名單）。**雙棘輪的會話狀態不在 `ChatStorage` 裡**：`DoubleRatchetSession.exportState()` 把狀態交給應用自己加密保存（而且匯出即銷毀會話），`secureChannel` 也不碰儲存。所以這次的變更不會讓鏈金鑰或訊息金鑰經過非同步儲存。

但非同步仍然會帶來三種靜默錯誤：

1. **讀取還沒回來就寫**：新訊息讓只有新資料的狀態把整份舊紀錄蓋掉。
2. **寫入交錯**：兩次 `setItem` 同時進行，較舊的狀態晚一步寫完，蓋掉較新的（狀態回退）。
3. **讀取失敗還照寫**：一次 I/O 錯誤，接著的寫入就把整份紀錄清空。

## Decision

### 1. 新增介面，不改舊介面

```ts
interface AsyncChatStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
type ChatStorageLike = ChatStorage | AsyncChatStorage;
class MemoryAsyncChatStorage implements AsyncChatStorage { … } // 測試與範例
```

`DirectMessagesOptions.storage` 與 `new Blocklist(storage)` 改收 `ChatStorageLike`。

**不選**「把 `ChatStorage` 的回傳型別改成 `T | Promise<T>`」：那會讓直接呼叫 `storage.getItem()` 並把結果當字串用的既有程式編譯失敗。**不選**「同步→非同步轉接器、內部一律非同步」：同步儲存目前在建構時就讀回對話（`threads()` 立刻有值），全部改成非同步會改變既有行為。新增的介面讓同步實作者（`localStorage`、各遊戲）一行都不用改，行為也不變。

模式由 `getItem` 的回傳值決定（是不是 thenable），不看型別：外掛的包裝物件不一定宣告型別。

### 2. 讀寫的排程（內部 `StorageSlot`，不轉出）

- **同步儲存**：建構時同步讀、變更時直接寫，與以前的程式碼路徑相同。`ready()`、`flush()` 立刻完成。
- **非同步儲存**：
  - 讀取在背景進行，`ready()` 等它完成。讀回之前 `threads()` 是空的、`Blocklist.has()` 只看得到這次執行加的。
  - 所有寫入串在同一條 Promise 鏈上，**排在讀取之後、一次只跑一個、依序完成**。
  - 排隊中的寫入在**輪到它時**才序列化當下的狀態：多次變更合併成一次寫入，而且最後寫下的一定是最新狀態——不會回退。
  - 讀回之前收到的新訊息、呼叫的 `forget()`，以及 `Blocklist` 的 `add`／`remove`（依序），都會疊在讀回的資料上，再寫回一次。
  - **讀取失敗（reject），或讀回的內容合併時出錯，就不寫回**：這次執行只留在記憶體。同步儲存維持既有行為（讀取丟例外當作沒有）。讀回的對話形狀不對（沒有 `peer` 字串或 `lines` 陣列）的整段丟掉，同步與非同步相同。
  - 寫入失敗只吞掉，下一次變更會再試。鏈永遠不會變成 rejected（否則之後的寫入都不會執行）。
- `DirectMessages` 與 `Blocklist` 各新增 `ready(): Promise<void>` 與 `flush(): Promise<void>`（純新增）。

### 3. 使用上的注意

- 用非同步儲存時，先 `await blocklist.ready()` 再開收件匣；否則讀回名單之前，被封鎖的人的訊息會先進來（讀回之後不會自動移除已經收下的對話——與同步版「封鎖後呼叫 `forget`」的用法相同）。
- 同一個鍵同時被兩個 `DirectMessages`（例如兩個分頁）寫，仍然是最後寫的贏；這與 `localStorage` 相同，不在本 ADR 的範圍。

### 4. 雙棘輪的並發保證（順帶釘住）

雖然會話狀態不經過 `ChatStorage`，`encrypt`／`decrypt` 是 async 函式，同時處理多則訊息時必須保證「讀-改-寫」不交錯。現況是：兩個函式在第一個 `await` 之前就完成全部狀態變更（`decrypt` 失敗時整個還原成快照），JavaScript 的單執行緒保證它們不會交錯；`secureChannel` 的收訊另外有一條 Promise 佇列。

新增 `tests/crypto/double-ratchet-concurrency.test.ts` 把這件事釘住：同時加密 50 則，序號兩兩不同（沒有重用訊息金鑰）；同時解密亂序、跨 DH 步進的一批，全部解得開、重放全部被擋、之後雙向照常（狀態沒有回退）；同時進行中有一則壞掉，只有它失敗，其他則的進度不被交易式還原倒回。**日後若有人在狀態變更之間插入 `await`（例如改用 WebCrypto 或非同步儲存會話），這組測試會變紅**；那時要改成每個會話一條序列化鎖（Promise 鏈），而不是放寬測試。應用自己保存 `exportState()` 時也要以每個會話一把鎖序列化「匯出 → 寫入」，且不可還原較舊的一份（ADR 0010 已載明）。

## 實測（主入口大小，esbuild 壓縮打包）

| 入口 | v0.20.0 | v0.21.0 |
|---|---|---|
| 主入口全部 | 150.6KB（gzip 55.2KB） | 152.5KB（gzip 55.8KB） |
| 遊戲常用（`Identity`／`RelayPool`／`DirectMessages`／`Blocklist`） | 88.7KB（gzip 33.6KB） | 90.4KB（gzip 34.2KB） |
| `./sync` | 80.1KB（gzip 31.3KB） | 80.5KB（gzip 31.3KB） |
| `./protocol` | 94.4KB（gzip 35.6KB） | 95.0KB（gzip 35.7KB） |

遊戲常用入口多 1.7KB（gzip 0.6KB，約 +2%）：`StorageSlot` 的排程與合併，以及 ADR 0023 的簽章者分流。

## Consequences

- ＋ 外掛可以把私訊與封鎖名單放進 IndexedDB，不會遺失歷史、不會狀態回退、一次讀取失敗也不會清空紀錄。
- ＋ 同步實作者完全不受影響（型別與行為都相同）。
- ＋ 雙棘輪的並發保證從「讀程式碼才知道」變成有測試守著。
- － 非同步儲存時，讀回之前 `threads()` 是空的、封鎖名單是不完整的；應用要 `await ready()`。
- － 遊戲常用入口約多 1.7KB。
