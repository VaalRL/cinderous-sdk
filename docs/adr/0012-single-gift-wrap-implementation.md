# 0012. SDK 內只留一份禮物包實作；外掛規格文件對齊 ADR 0006

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0001（私訊 `dm.ts`）、ADR 0006（名稱與分塊）、ADR 0009（`protocol/nip59` 搬入 SDK）

## Context

v0.9 之後 SDK 裡有兩份 NIP-59 禮物包實作：

- `dm.ts`：v0.1 就有，直接用 nostr-tools 的 NIP-44 自己組 seal 與 wrap；
- `protocol/nip59`：ADR 0009 從 Cinderous 搬來，連線、Cinder EK、信令都用它。

兩份做同一件事，改一邊就可能忘了另一邊，不符單一來源。

另外，`docs/companion-specs/` 兩份外掛規格（CinderSync、Cinder Coffice）裡還有 ADR 0006 已經改掉的名稱與數字。

## Decision

1. **`wrapDm`／`unwrapDm` 改走 `Identity.sealAndWrap`／`openWrap`**，也就是 `protocol/nip59`。對外 API 不變。
   - 既有測試原封不動全過：與 nostr-tools NIP-17 雙向互通、一份 rumor 封兩次、冒名拒絕。
   - 順帶變嚴格：`openWrap` 會核對 rumor id 與內容相符，舊實作只是重算 id。
2. **`protocol/nip59` 的 `openWrap` 加上「seal 必須是 kind 13」**。
   - 這是 `dm.ts` 原本有、`nip59` 沒有的檢查，併入時一起帶過來。
   - NIP-59 本來就這樣規定，Cinderous 送出的 seal 也一律是 13。
   - Cinderous 轉出這份實作，所以升版後 App 也會多這道檢查。
3. **外掛規格文件對齊 ADR 0006**：
   - Cinder Coffice：後量子混合的古典半邊由 X25519 改為 secp256k1。
   - CinderSync：
     - DataChannel 分幀由 64KB 改為 16KB，走中繼則是 48,000 B；
     - Durable Object 綁定由 `RELAY_STORAGE` 改為 `RELAY_ROOM`。
   - `RESEARCH-JOURNEY.md` 是歷史紀錄，不改。

## 沒有改的

- 外掛規格裡「軍規」「Military-Grade」這類行銷用語當時沒動；後來產品決定移除（2026-09-27），改成「實驗性」的如實描述。

## Consequences

- ＋ 禮物包只有一份實作，私訊與連線、EK 走同一套驗證。
- － Cinderous 升到這一版後多一道 seal kind 檢查。理論上不影響（它送的一律是 13），但它收到的若有別的客戶端送出非 13 的 seal，會從「收下」變成「拒收」。
