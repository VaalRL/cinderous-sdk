# 0057. `writeStream` 的來源帶內容的 SHA-256

- 狀態：**已接受（Accepted，2026-10-04）**——實作於 v0.44.0
- 日期：2026-10-04
- 對應：CinderSync ARCHITECTURE §5 **G22**（外掛 ADR 0027：大檔以 `appendBinary` 寫暫存檔再改名）。相關：本 repo ADR 0026（`writeStream`、`StreamingFileStore`、`hashSource`）、0053（同一批 CinderSync 缺口）。

## Context

協調器把 P2P 收到的大檔交給 `VaultAdapter.writeStream(path, source, expectHash)`，`source` 是 `VaultContentSource`＝`{ size, read(offset, length) }`。
協調器其實知道內容的雜湊（版本的 `node.hash`），卻沒放進來源。CinderSync 寫暫存檔時已經以 `hashSource` 邊寫邊算 SHA-256，但沒有東西可以比，
改名進 Vault 前只能確認大小，內容正確與否只靠收完時的校驗——中間的暫存讀取（分段檔、快取）出錯就會把錯的內容改名進去。

這個值可不可信：P2P 串流的收方逐塊算整檔 SHA-256，**不符就不交付**（`StreamTransfer`：刪暫存、回失敗；續傳時已有的部分重新讀出來算）；
交付前 `parseVaultEntryMeta` 又要求送方宣告的 `sha256` 等於版本的 `node.hash`。所以到 `#receiveEntry` 時，`node.hash` 就是已經校驗過的內容雜湊。

## Decision

- `VaultContentSource` 加選配的 `sha256?: string`：64 字元小寫 hex，與 `VaultVersion.hash`、`StreamEntry.sha256` 同一個名稱與格式（不另取 `hash`／`contentHash`）。
- 協調器建立的來源一定帶：
  - P2P 收到的大檔（交給 `writeStream` 的那一個）＝`node.hash`（上述已校驗的值）；
  - 送方從磁碟讀的來源（`#diskSource`，只在磁碟上的雜湊等於 `node.hash` 時建立）也帶，與 `StreamEntry.sha256` 一致。
- 轉接器的建議用法：寫暫存時增量計算，改名進目的地之前比對，不符就不取代、刪暫存、回 `false`——協調器把它當成前置條件不符，之後重新讀取／重送
  （與目的地變了的處理相同；沒有新的錯誤路徑）。
- 選配而不是必填：這個型別也被應用自己建立（測試、其他轉接器），必填會讓它們編譯失敗；協調器這一側一律帶。

## Alternatives Considered

- **`writeStream` 多一個參數 `contentHash`**：改簽章、所有實作都要跟著改；放在來源上與 `StreamEntry` 的形狀一致。
- **SDK 自己在交給轉接器前再讀一次算雜湊**：多讀一整次大檔（行動版很慢）；轉接器寫入時本來就逐段讀，順便算就好。
- **叫 `hash`（與 `VaultVersion.hash` 同名）**：`sha256` 寫明演算法，與串流層、`hashSource` 的回傳一致；外掛 ADR 0027 也已經讀 `sha256`。

## Consequences

- ＋ 轉接器能在改名前自己確認寫進暫存檔的內容，暫存讀取出錯不會把錯的內容放進 Vault。CinderSync 不必改程式（已讀選配的 `sha256`），升級就生效。
- ＋ 不改協定、不多送任何東西；預設行為不變（沒有比對的轉接器照舊）。
- － 轉接器回 `false` 時協調器會重新讀取；如果暫存本身壞了，會在下一次直送時重收（暫存 id 就是內容雜湊，壞的暫存會在收方的整檔校驗被刪掉）。

## 同版的修正：`parseConflictCopyName`（ADR 0053 §G18）

CinderSync 改用 `parseConflictCopyName` 時發現：原檔**沒有副檔名**、裝置名稱**含點**（`README`＋「Joe.Mac」→ `README (衝突-Joe.Mac-…)`）的副本拆不回來——
拆副檔名的規則把裝置名稱的後半當成副檔名。改成拆不回來時再以「沒有副檔名」試一次（仍要以 `conflictCopyName` 組回去完全相同）。
加了編號的這種名稱（`README (衝突-Joe 2.Mac-…)`）同時也是裝置「Joe 2.Mac」的副本，兩種讀法的原檔相同，回傳不帶編號的那一種。
`tests/sync/merge3.test.ts` 加了這個情境。

## 同版的修正：只讀中繼進入寫入集合時通知（ADR 0054）

`readUrls` 的中繼被 `durability.standby` 拿來補發時進入寫入集合（`writeSet()`），閒置後離開；離開會發健康狀態通知，**進入卻沒有**。
`watchRelayFileLimits` 只在健康狀態通知時重算，所以主中繼被標成已滿、改寫到備援之後，單檔門檻仍停在「沒有中繼可寫」時算出的保守預設，
不是備援宣告的值（CinderSync 的端到端〈主中繼滿了 → 補發到備援 → 單檔門檻跟著實際寫入的那組重算〉改用 `readUrls` 後抓到）。
改成進入寫入集合時也通知一次。`tests/relay-pool-read-relays.test.ts` 加了這個情境。

## 同版的修正：`retryPeers(device)` 在通道上掛收方（ADR 0053 §G15）

ADR 0053 §G15 建議外掛在自己的探測（開通道＋握手）打通之後呼叫 `retryPeers(device)`，取代「把自己開的通道當成對方找上門交給協調器」。
但**收方**（這台沒有要送給對方的東西、只是等對方的大檔）探測時：對方看到有人找上門就經那條通道送過來，這台的協調器卻沒有在那條通道上掛收方
（它沒有工作就不開通道），對方的串流沒人接，大檔永遠送不到（CinderSync 的端到端〈對方也按立即同步 → 直連送完大檔〉改用 `retryPeers` 後抓到）。
改成**指定裝置**時也開（或沿用已經開著的）到它的通道並掛上收方；不帶裝置的 `retryPeers()` 不開通道（只重設退避，避免對每一台都開直連）。
`tests/sync/vault/peer-controls.test.ts` 加了這個情境。

## 測試

`tests/sync/vault/p2p.test.ts`：P2P 收到的大檔交給 `writeStream` 的來源帶 `sha256`＝內容的 SHA-256（64 字元小寫 hex）；
轉接器回 `false`（模擬比對不符）時不寫入、之後重送成功、最後內容正確。
