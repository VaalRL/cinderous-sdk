# 0009. 點對點連線 `connectPeer`：NIP-59 信令、DataChannel 分塊、打不通就改走中繼

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0006（信令用 NIP-59 包 kind 21000；DataChannel 分塊 16KB）、ADR 0007（Cinderous 已有的協定原樣搬進 SDK，Cinderous 改轉出）；PRD 2.2、2.3、5.2 場景 A

## Context

PRD 5.2 場景 A 要的是一行 `connectPeer(對方公鑰)` 就拿到一條加密通道。PRD 2.3 另外要求：

- 打洞 8 秒沒成功，或 ICE 失敗，就無縫改走中繼（「雙軌降級」，備援 kind 20079）；
- 走中繼時，超過 20MB 的資料要提示使用者。

Cinderous 已經有 WebRTC 信令，SDK 不該再發明一套：

- `signaling.ts`：kind 21000，NIP-59 整包，批次 ICE；
- 它依賴的 `nip59.ts`、`nip44.ts`；
- `nip59.ts` 又依賴 `hybrid-kem.ts`（後量子混合封裝，Cinderous ADR-0365）。

Cinderous 的 `datachannel.ts` 則綁著 App 專用訊息（戳一下、正在輸入、在線狀態、檔案續傳），不適合當通用層。

## Decision

### 1. 協定層：原樣搬進 `@cinderous/client/protocol`

搬進 `nip44`、`hybrid-kem`、`nip59`、`signaling` 四個檔案，內容與 Cinderous 逐字相同，只有一處不同：

- `TIMESTAMP_JITTER_SECONDS` 本來就定義在 SDK，所以直接寫在 `nip59.ts` 裡。

新增相依 `@noble/post-quantum`。Cinderous 那邊比照 ADR 0007，在 PR #9 分支改成從 SDK 轉出。

`hybrid-kem` 隨 `nip59` 一起搬過來，但 4a 不打開它：信令與中繼降級都走純古典 NIP-59。後量子怎麼接進來，由第四步第二段（加密引擎）的 ADR 決定。

### 2. 分框：兩條軌道用同一種框

`send(data)` 的資料可以任意大小，切成框送出，另一端依 `(訊息 id, 序號)` 組回。

| 項目 | 內容 |
|---|---|
| 框頭 | 1 位元組版本、8 位元組隨機訊息 id、4 位元組序號、4 位元組總數 |
| 每框承載 | DataChannel **16 KB**；中繼軌 **48,000 B**（ADR 0006；見下方〈更正〉） |
| 重複的框 | 同時連多座中繼時會重複送達，依 `(id, 序號)` 去重 |
| 殘缺的訊息 | 組到一半的訊息逾時（預設 60 秒）就丟掉，避免記憶體被佔住 |

### 3. `PeerNode`：一個身分一個節點

```ts
const node = new PeerNode({ identity, transport: pool }); // transport：RelayPool 或任何實作 publish/subscribe 的物件
node.onPeer((channel) => { /* 對方找上門 */ });
const channel = await node.connectPeer(peerPubkey);
channel.mode; // 'p2p-webrtc' | 'relayed-websocket'
await channel.send(bytes);
channel.onMessage((bytes) => { ... });
```

- **信令**：kind 21000 的 NIP-59 事件，只訂閱 `#p` 是自己的，所以在 Cinderous 的嚴格平面也收得到。ICE 候選照 Cinderous 批次送。
- **WebRTC 由外部注入**：`RTCPeerConnection` 預設取全域，Node 或測試環境可以自己傳進來。SDK 不綁任何 WebRTC 套件。
- **降級時機**：8 秒內 DataChannel 沒開，或 ICE 變成 `failed`，就放棄 P2P、改走中繼。雙方各自計時。
- **降級不需要新增信令類型**：中繼軌的框（kind 20079）一到，接收端就把它交給對方的中繼通道；還沒有通道就建一條，交給 `onPeer`。
  - 好處：與 Cinderous 的信令格式完全相容，不必多一個 Cinderous 不認得的 `type`。
  - 代價：先開始送的一方，要到第一框送達，對方才知道已經降級。
- **中繼軌**：
  - kind 20079 屬 ephemeral，中繼只轉發不存。
  - 每框各包一次 NIP-59，中繼看不出是誰傳給誰。
  - 預設每分鐘最多 200 框。Cinderous 中繼每條連線每分鐘 240 則訊息，超過會被斷線。這表示中繼軌約每秒 160 KB。
    **加註（2026-10-01，v0.35.0，ADR 0043）：這個預設是錯的**——中繼另有較小的**事件**上限：以認證身分計數、每把公鑰每分鐘 120 則
    （ephemeral 也算），一分鐘連發 210 框只收下 120。預設改為 100、與同一身分的信令、名單同步、Vault 同步共用一個預算
    （`sharedRelayEventBudget`）、可依 NIP-11 `cinder_max_events_per_minute` 自動取較小值（`relayInfo`／`applyRelayInfo`）；
    收到 `rate-limited:` 就退避到計數窗結束再重送那一框。中繼軌約每秒 80 KB。
- **大檔提示**：`channel.mode === 'relayed-websocket'` 且資料大於 20 MB（20,971,520 B）時，`needsLargePayloadWarning()` 回 `true`。要不要擋、怎麼提示，由 App 決定；SDK 不自己跳 UI。
- **加密**：
  - P2P 軌：靠 WebRTC 的 DTLS。
  - 中繼軌：靠 NIP-59。
  - `isEncrypted` 恆為 `true`。
  - PRD 寫的「ML-KEM＋雙棘輪」等第二段的加密引擎做完後，改成可插拔的封裝器（`FrameSealer`）替換；本段先把介面留好。

## 還沒做

- 通話（音訊、視訊）：Cinderous 的 `call.ts`、`webrtc-call.ts` 綁著 App 的 UI 狀態，本段只做資料通道。
- 檔案續傳（Cinderous ADR-0355）。
- TURN 憑證：
  - `iceServers` 由呼叫端傳入；
  - Cinderous 中繼的 `/turn` 需要 NIP-98 授權，之後可以加一個便利函式。

## Consequences

- ＋ 一行 `connectPeer` 就有一條加密通道，打不通時仍然連得上。
- ＋ SDK 與 Cinderous 的信令是同一份程式、同一種格式。
- － 中繼軌很慢（約每秒 160 KB），而且每框都要做兩次 ECDH 和一次簽章。只適合文字與增量同步；大檔要靠 P2P，或由 App 提示使用者。
- － 降級靠「第一框送達」來告知對方，所以對方要到有資料進來才知道對方存在。只收不送的一方要自己呼叫 `connectPeer`，才會主動降級。

## 更正（2026-09-27，v0.9.0）

初版說中繼軌也用 16 KB，理由是「NIP-44 單次上限 65,535 位元組，48,000 B 放不進兩層 NIP-44」。**這個前提是錯的**：

- 實測：這裡用的 NIP-44 實作（nostr-tools）接受超過 65,535 位元組的明文。
- Cinderous 的檔案塊（kind 1060）每塊 48,000 B，本來就是經 NIP-59 包兩層送出，包好後約 131 KB，低於中繼單則上限 262,144 B。

改為：

- 中繼軌每框 48,000 B，DataChannel 維持 16 KB。
- 同樣每分鐘 200 框，中繼軌的吞吐由約每秒 53 KB 提高到約每秒 160 KB。

收端的防護一併改成：

- 單框承載上限 48,000 B；
- 整則大小改以**實際收到的位元組**累計，不再用「對方宣稱的框數 × 固定框大小」估。
