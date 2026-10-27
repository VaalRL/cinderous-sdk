# 0015. 檔案傳輸與續傳：跑在任何位元組通道上，整檔校驗，另有「等 P2P 才送」的佇列

- Status: Accepted
- Date: 2026-09-27
- 相關：
  - SDK：ADR 0009（`PeerChannel`）、ADR 0010（`secureChannel`）、ADR 0011（三層分流）；PRD 2.3（中繼大檔提示）、2.4（第三層 P2P 直傳）
  - Cinderous：ADR-0345、0347、0349、0355（DataChannel 檔案、串流落盤、續傳與整檔校驗）

## Context

`connectPeer` 與 `secureChannel` 給的是「送一則位元組、收一則位元組」的通道，但送檔案還需要：

- 分塊；
- 斷線後從斷點接著送；
- 確認對方收到的內容完全正確。

PRD 2.4 的第三層（超過檔案塊層上限的資料）要「等兩台同時在線時直傳」，`classifyPayload` 只做了判斷，沒有東西真的去排隊。

Cinderous 已經出貨一套 DataChannel 檔案傳輸，但綁著 App 的訊息，而且直接寫在 RTCDataChannel 上。SDK 的通道多了一層 `PeerNode` 分框，線路上無法互通。

## Decision

### 1. `FileTransfer`：協定自訂，語意對齊 Cinderous ADR-0355

- **跑在任何 `ByteChannel` 上**，也就是有 `send`／`onMessage`／`onClose` 的物件。`PeerChannel`（P2P 或中繼）與 `SecureChannel`（雙棘輪）都符合；檔案要逐塊前向保密，就疊在 `secureChannel` 上。
- **流程**：
  1. 送方發邀請（名稱、類型、大小、分塊大小）。
  2. 收方回報「已經有多少位元組」。
  3. 送方從那裡接著送。
  4. 結尾送整檔 SHA-256。
  5. 收方校驗後回「完成」，**送方收到才算成功**。
- **線路格式**：第一個位元組 `0xCF` 標記檔案傳輸。控制訊息用 JSON；分塊是二進位（16 位元組 id、8 位元組位移、資料）。App 自己的訊息可用 `isFileTransferMessage` 略過。
- **續傳**：送方用同一個 id 重送。收方的暫存（`PartialFileStore`）裡已有多少就回報多少。
  - 暫存預設放記憶體；要跨 App 重開續傳，或把大檔寫硬碟，換成自己的實作。
  - 整檔雜湊是累加的：續傳時收方只重讀一次已存的部分，送方也只讀本機、不重送。
- **收方防護**（照 Cinderous 的經驗）：
  - 單檔上限預設 100 MB；
  - 同時接收最多 16 個檔案；
  - 亂序暫存最多 8 MB，超過就中止；
  - 超過宣告大小的分塊，中止；
  - 邀請要通過 `onOffer`（預設：在上限內就收）；
  - 記憶體暫存要真的收到分塊才配置。
- **校驗失敗**：收方清掉暫存、不交出檔案；送方丟 `FileIntegrityError`。
- **走中繼的大檔**（PRD 2.3）：通道是中繼、而且檔案超過 20 MB 時，預設丟 `LargeFileOverRelayError`、一則都不送。App 可以提示使用者連同一個 Wi-Fi，或以 `allowLargeOverRelay` 明確允許。
- **每條通道只用一個實例**（`FileTransfer.for(channel)`）：同一條通道掛兩個實例，對方的邀請會被回應兩次。

### 2. `P2PFileQueue`：第三層的「等 P2P 才送」

- `enqueue(peer, file)` 只排隊，不送。
- 觸發送出的時機有兩種：
  - App 呼叫 `flush(peer)`（例如看到對方上線），這會試著 `connectPeer`；
  - 對方主動連上來。
- **只有 P2P 通道才送**。只打得通中繼就繼續排著，這一層的檔案本來就大到不該走中繼。
- 沒給 id 時在排隊當下固定一個，斷線重試就從斷點續傳。
- 對方明確拒收（`FileRejectedError`）則移出佇列並回報，不無限重試。

## 還沒做

- 真正的串流落盤：暫存可以換成寫硬碟，但交給 App 時是 `read()` 讀出整個檔案，所以單檔仍受記憶體限制，預設 100 MB。要超過，App 的暫存實作要自己處理「收完就原地保存」。
- 佇列本身不持久化，App 重開後要自己重新排。

> **v0.23.0 更新（[ADR 0026](0026-p2p-batch-stream-and-large-file-streaming.md)）**：以上兩項由新的批次串流處理——`StreamTransfer` 分塊寫進 `StreamingFileStore`（續傳、校驗後原子提交、信用視窗背壓、記憶體恆定、單檔預設上限 64 GiB），`P2PStreamQueue` 可持久化。`FileTransfer`／`P2PFileQueue` 的線路格式與行為不變（舊收方只懂 0xCF），主入口的打包大小也不變；新程式要傳大檔請用 `./transfer` 的 `StreamTransfer`／`P2PStreamQueue`。

## Consequences

- ＋ 檔案可以走 P2P、中繼或雙棘輪通道，斷線能續傳，收到的內容保證與送出的一致。
- ＋ PRD 的第三層有了實作。
- － 與 Cinderous App 的檔案傳輸在線路上不互通。語意相同，但 SDK 多一層分框。
