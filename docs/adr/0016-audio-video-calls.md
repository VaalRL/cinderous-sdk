# 0016. 音訊／視訊通話：協定照搬 Cinderous，執行期改寫成可注入的 CallManager

- Status: Accepted
- Date: 2026-09-27
- 相關：
  - SDK：ADR 0006（kind 21002 是通話信令）、ADR 0007（Cinderous 已有的協定搬進 SDK）、ADR 0009（`PeerNode`）
  - Cinderous：M8 通話、ADR-0243（失敗分類）、ADR-0337（畫質）、ADR-0338（通話中切換型態）

## Context

Cinderous 已經出貨一對一的音訊與視訊通話，分兩層：

- `core/call.ts`：`CallSession` 狀態機，加上 kind 21002 的 NIP-59 信令（邀請、接聽、拒接、掛斷、候選、切換型態），純邏輯、沒有 I/O；
- `engine/webrtc-call.ts`：接上 `RTCPeerConnection` 與 `getUserMedia` 的執行期。它綁著 App 的相機選擇、ICE 路徑觀測，也直接拿私鑰簽信令。

## Decision

1. **協定照搬**：`call.ts` 與 `video-quality.ts`（畫質檔位）原樣搬進 `@cinderous/client/protocol`，測試一起搬，Cinderous 改成轉出。
   - SDK 與 Cinderous App 的通話信令是同一種格式：SDK 撥給 App、App 撥給 SDK，信令都讀得懂。
2. **執行期改寫成 `CallManager`**，做法照 `WebRtcCall`，差別在：
   - 自己訂閱 kind 21002（`#p` 是自己）；
   - 信令由 `Identity.sealAndWrap` 封裝，私鑰不離開 `Identity`；
   - `RTCPeerConnection` 與 `getUserMedia` 都可注入，瀏覽器預設取全域，測試與其他環境自己接；
   - 事件用 `onIncoming`／`onState`／`onRemoteStream`／`onMedia`／`onEnded`／`onFailed`／`onError` 註冊。
3. **Cinderous 的經驗全部帶過來**：
   - 一律預先協商視訊 transceiver，語音通話也一樣。通話中切換語音或視訊只要 `replaceTrack`，不重新協商，所以沒有 glare（ADR-0338）。
   - 答方要把瀏覽器自動建立的 `recvonly` 視訊 transceiver 改成 `sendrecv`，否則永遠送不出視訊。
   - 升級成視訊：先取相機、換好軌道，成功了才通知對方。失敗就把型態改回去，不送任何信令，對方不會等一個永遠不來的畫面。
   - 視訊用畫質檔位的限制，不是裸 `true`（ADR-0337）。
   - 降級與掛斷都真的 `stop()` 相機，不只是送黑畫面。
   - 連線失敗分 `unreachable`（從未打通，多為需要 TURN）與 `lost`（連上後斷線），並經中繼送出掛斷，讓對方也乾淨結束（ADR-0243）。
   - 忙線回 `busy`；封鎖的人打來不響鈴、不回應。

## 還沒做

- 多人通話：Cinderous 也只有一對一。
- TURN 憑證的便利函式：Cinderous 中繼的 `/turn` 要 NIP-98 授權。目前 `iceServers` 由 App 傳入；`unreachable` 的通話要靠 TURN 才打得通。
- ICE 路徑觀測（Cinderous ADR-0344：直連或經 TURN）與鏡頭切換（ADR-0339）。

## Consequences

- ＋ 一行 `startCall(對方, 'video')` 就能打，與 Cinderous App 互通。
- ＋ 用假的 WebRTC 就能完整測試狀態機與執行期；另有經真的中繼的整合測試。
- － 媒體走 WebRTC 的 DTLS-SRTP。它不經過 `secureChannel`，所以沒有雙棘輪、也沒有後量子；信令本身是 NIP-59。
