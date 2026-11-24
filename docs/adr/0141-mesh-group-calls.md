# 0141. 網狀（mesh）小群組通話；一對一通話補上 Cinderous 真機驗收發現的四個問題

- 狀態：**已接受（Accepted，2026-11-18）**——Cinderous 使用者 2026-11-18 選了「網狀小群組（約 4 人，不需伺服器、維持端到端加密）」
- 日期：2026-11-18
- 對應：SDK ADR 0016（音訊／視訊通話，〈還沒做〉的「多人通話」）、0017（TurnProvider）、0009（`PeerNode`）；
  Cinderous ADR-0337（畫質）、ADR-0338（通話中切換型態）、ADR-0339（換鏡頭）、**ADR-0424（2026-11-17 真機驗收發現）**

## Context

SDK 的通話只有一對一（ADR 0016）。使用者要多人通話，從三個做法裡選了**網狀小群組**：

| 做法 | 人數 | 伺服器 | 端到端加密 | 工作量 |
| --- | --- | --- | --- | --- |
| **網狀（選這個）** | 約 4 人 | 不需要（只有既有的中繼轉信令、必要時 TURN） | 是（每一對都是 DTLS-SRTP） | 3–5 天 |
| SFU 轉發 | 十幾人 | 要一台轉發伺服器（雲端成本） | 要另加 Insertable Streams 的 E2EE 層 | 大，要另開研究 |
| 先不做 | — | — | — | — |

同一天（2026-11-17）Cinderous 第一次用兩台真機驗收一對一通話，發現四個「我們的測試替身照自己對規格的理解寫、所以全過」的問題（Cinderous ADR-0424）。SDK 的 `CallManager` 是照 Cinderous 的 `WebRtcCall` 寫的，**四個問題裡有三個 SDK 也有**（第四個「手機換鏡頭」SDK 一對一沒有換鏡頭功能，所以沒有）。多人通話建在同一套做法上，不先修就會把問題乘上 N−1。

## Decision

### 一、一對一 `CallManager` 先修（線上格式不變）

照瀏覽器真實行為重寫一份測試替身（`tests/call/realistic-rtc.ts`），先證實 SDK 也中（四個測試全紅），再修：

1. **遠端軌沒帶 stream**：預鋪的視訊 transceiver 沒綁 stream，對端 `ontrack` 的 `streams` 是空陣列；原本只看 `streams[0]`，視訊軌被丟掉。
   現在每條軌（`event.track` 與 `streams[0]` 的軌）都併進這一通的遠端串流，送**新的**串流物件。
   ⇒ 新版能看到舊版（含已出貨的 Cinderous App）通話中開的視訊。
2. **答方的鏡頭放錯條**：答方 `ensurePc` 自己鋪的視訊 transceiver 不會被遠端 offer 採用（JSEP 只重用 `addTrack` 建的），`mid` 恆為 `null`。
   原本 `videoSender()` 挑第一條、`acquireMedia` 的 `addTrack` 也重用它 ⇒ 相機亮著、對方收到 0 畫格。
   現在 `videoSender()` 先挑協商過（`mid != null`）的；答方開機時視訊軌直接 `replaceTrack` 到協商過、還沒上軌的那條並 `setStreams`；
   自己鋪的那條**不停**（Chrome 的 `addTrack` 會挑到已停的並丟 `InvalidAccessError`），只有 offer 根本沒有視訊（舊版）時才停，`canChangeMedia` 才照實回 false。
3. **本地串流就地改**：開／關視訊原本在同一個串流物件上 `addTrack`／`removeTrack`，UI 只在物件變了才重綁 `srcObject` ⇒ 黑框。現在一律送新物件。
4. 新選項：`createStream`（預設 `new MediaStream(tracks)`，沒有就用最小實作）、`isBusy`（另一個通話進行中就回忙線，給群組通話用）。

### 二、網狀小群組通話：`GroupCallManager`

1. **拓撲**：N 人 ⇒ 每人 N−1 條 `RTCPeerConnection`，每一對直連，媒體一樣是端到端的 DTLS-SRTP，不經任何媒體伺服器。
2. **上限**：預設 4 人（含自己）、`maxParticipants` 可設 2～6，**硬上限 6**，設超過建構時就丟例外。理由見下方頻寬估算。
3. **信令**（`@cinderous/client/protocol` 的 `group-call`）：跟一對一同樣是 kind 21002 的 NIP-59 ephemeral Gift Wrap，逐人封裝。
   內容帶 `v: 1`、`groupId`（16 位元組隨機 hex）：

   | type | 用途 |
   | --- | --- |
   | `group-invite` | 邀請；帶 `media`、`members`（含邀請者） |
   | `group-join` | 我加入了（廣播給所有成員）；`ack: true` 是回覆別人的加入，收到 ack 不再回 |
   | `group-decline` | `declined`／`busy`／`full` |
   | `group-leave` | 我離開 |
   | `group-members` | 有人通話中再邀一位：名單變了 |
   | `group-offer`／`group-answer`／`group-candidate` | 某一對的 SDP 與 ICE |
   | `group-media` | 我改送語音或視訊 |

4. **誰發 offer**：每一對由 pubkey 字典序較小的那位發（`groupCallOfferer`），兩邊算出同一個答案，**沒有 glare**。
   加入的人廣播 `group-join`；已在通話裡的人收到後，自己較小就發 offer，較大就回 `ack` 讓對方發。
   名單更新可能比加入晚到：不在名單上的人送來的加入先暫存，名單補上他之後重放。
5. **某一對打不通只影響那一對**：那條連線關掉、那個人標 `failed`、`onPeerFailed(peer, 'unreachable' | 'lost')`，其他人照常。
   所有其他人都不在了（拒接、忙線、沒接、離開、失敗）才結束（`empty`）。
6. **本地媒體只取一次**：一支麥克風、一顆鏡頭分送給每一條連線（每條各自的 sender）。
   `setMuted` 設麥克風軌 `enabled`（裝置不關）；`setLocalMedia` 開關鏡頭對所有連線生效，關的時候真的 `stop()` 相機。
7. **吸收 ADR-0424**：
   - 發 offer 的那方 `addTransceiver('video', { streams: [本地串流] })` 預鋪視訊並**綁 stream**，通話中開關鏡頭只要 `replaceTrack`、不重新協商；
   - 接 offer 的那方**不自己鋪**，套用 offer 後把麥克風、鏡頭 `replaceTrack` 到協商過的 transceiver 並 `setStreams`；
   - 收端每條軌都併進那個人的遠端串流，送新物件；
   - `setCamera` 換鏡頭：先試直接開新的（桌面可同時開兩顆，沒有空窗）；遇到「鏡頭忙碌」（`NotReadableError` 等，多數手機同時只能開一顆）
     先停舊的再開；新的開不了就重開原本那顆；連原本的都開不了就降成語音並通知大家。
8. **相容**：群組信令沒有 `callId`、type 全是 `group-*`。只懂一對一的對端（舊版 SDK、Cinderous App）的 `parseCallSignal` 會丟例外而忽略——
   **不會把群組邀請當成一對一來電響鈴**。邀請舊版的人不會有任何回應，邀請方等響鈴逾時（`ringTimeoutMs`，預設 45 秒）標 `no-answer`。
   一對一的線上格式完全沒變。
9. **忙線**：`GroupCallManager` 與 `CallManager` 都可以給 `isBusy`，互相查對方在不在通話中，另一邊來電一律回忙線。

### 頻寬估算（每人，含 Opus 音訊約 32 kbps；上傳與下載大致相同）

網狀拓撲每人上傳 N−1 份。數字是編碼上限（`videoProfile().maxBitrate`），網路差時實際更低。

| 人數 N | 省流量（150 kbps） | 標準（600 kbps） | 高畫質（1.5 Mbps） | 只有語音 |
| --- | --- | --- | --- | --- |
| 2 | 0.18 Mbps | 0.63 Mbps | 1.5 Mbps | 32 kbps |
| 3 | 0.36 Mbps | 1.3 Mbps | 3.1 Mbps | 64 kbps |
| **4（預設上限）** | **0.55 Mbps** | **1.9 Mbps** | **4.6 Mbps** | 96 kbps |
| 5 | 0.73 Mbps | 2.5 Mbps | 6.1 Mbps | 128 kbps |
| **6（硬上限）** | **0.91 Mbps** | **3.2 Mbps** | **7.7 Mbps** | 160 kbps |

- 4 人標準畫質約 1.9 Mbps 上傳：一般家用寬頻與 4G／5G 撐得住；6 人標準要 3.2 Mbps，行動網路的上傳常常不夠，所以預設 4。
- 經 TURN 中繼的那幾對，中繼站的 egress 也乘上同樣的倍數（站方付費）。人多時建議 App 預設省流量。
- 編碼也乘 N−1：手機同時編 5 路 720p 會發燙降頻，硬上限 6 也是為此。

## 公開 API

- `@cinderous/client`：`GroupCallManager`（`start`、`accept`、`reject`、`leave`、`invite`、`setLocalMedia`、`setMuted`、`setCamera`、`setVideoQuality`、`participants()`、
  `onIncoming`／`onState`／`onParticipants`／`onLocalStream`／`onRemoteStream(peer, stream)`／`onPeerFailed`／`onEnded`／`onError`）、
  `isCameraBusy`、`defaultCreateMediaStream`、型別 `CreateMediaStream` 等。
- `@cinderous/client/protocol`：`parseGroupCallSignal`、`groupCallOfferer`、`GROUP_CALL_DEFAULT_MAX`、`GROUP_CALL_HARD_MAX`、`GROUP_CALL_VERSION` 與信令型別。
- 媒體介面（`media.ts`）加了選用欄位：`MediaTrackLike.enabled`、`RtpSenderLike.setStreams`、`RtpTransceiverLike.mid`／`stop`、
  `addTransceiver` 的 `streams`、`ontrack` 事件的 `track`。都是選用，舊的注入實作照樣能用（沒有 `mid` 當作都協商過）。

## Consequences

- ＋ 2～6 人的群組通話，不加任何伺服器，媒體仍端到端加密；某一對網路不通不拖垮整通。
- ＋ 一對一通話在兩種角色下的視訊都真的送得出去、收得到；新版也看得到舊版通話中開的視訊。
- ＋ 測試替身照瀏覽器真實行為寫，並做過變異測試（把修正改回舊寫法，對應的測試會紅）。
- － 人數上不去：每人上傳 N−1 份。十幾人要 SFU，屆時另開 ADR。
- － 沒有「主持人」：任何已加入的人都能再邀人，沒有踢人功能（離開或封鎖由各人自己決定）。
- － 舊版對端收到群組邀請沒有任何回應，只能等逾時。
- － 一對一 `onRemoteStream`／`onLocalStream` 給的是 SDK 建的新串流物件，不再是 `ontrack` 給的那個；比對物件身分的 App 要改看內容。
- 未驗證：**沒有用真機或真的瀏覽器跑過群組通話**。替身已照 Cinderous ADR-0424 的真機行為寫，但多條連線同時協商、
  手機同時編多路、TURN 下 N−1 倍流量，都要真機驗收（建議比照 Cinderous OPERATOR-TODO §B-Call，三台裝置、每人各當一次邀請者）。

## 程式碼審查修正（2026-11-18，v0.92.0）

審查找到的問題都屬於「替身沒模擬到」：舊的 `realistic-rtc.ts` 不檢查連線狀態、ICE 一定在 5 ms 內有結果、`getUserMedia` 立刻回來。替身先補上（已關閉的連線不能 `setRemoteDescription`、沒有 remote description 不能加 candidate、可以讓某一對「永遠停在 new」、可以讓某人收到 offer 就丟例外、`getUserMedia` 可以卡在權限提示、記下每一條軌含麥克風），再照下面修。

- **H1 非同步操作晚回來讓通話復活**：每一通（以及 `close()`）遞增 `#epoch`；取麥克風／鏡頭、換鏡頭、建連線在 `await` 前記下，回來時不同就關掉剛取得的裝置、不改狀態、不送信令。
  `start()` 取裝置期間算忙線（`#starting`）。換鏡頭排隊（連按兩次不會漏關一顆）。開／關視訊以最後一次為準（`#wantedMedia`）；開視訊時先記下 `#video` 再換到各連線（M9：期間新建的連線拿得到）。
- **H2 建連線失敗永遠卡在 connecting**：`#offerTo`／`#answer`／套用 answer 任何一步失敗 ⇒ 關掉這一對、標 `failed`、`onPeerFailed(unreachable)`、檢查是否只剩自己。
- **H3 沒有連線逾時**：新選項 `connectTimeoutMs`（預設 30 秒）。某一對加入（或建了連線）之後在期限內沒連上 ⇒ 標 `failed`（`unreachable`；連過又斷是 `lost`）。只影響那一對。
- **M1 offer 規則在收端強制**：我是字典序較小（該由我發）就不收對方的 offer；已拒接、離開、失敗的人送 offer 不能復活。中途加入的人眼中，已在通話裡的人是名單上的 `invited`（他們直接發 offer、不另送 join），所以 `invited` 要收。
- **M2**：已連上的那一對不讓對方重送 offer 重建；同一個人重建上限 3 次。
- **M4 收到邀請一直不接**：`ringTimeoutMs` 後自己結束，新的結束原因 `no-answer`（不再永遠佔著忙線）。
- **M7**：連線建立前暫存的 candidate 每人最多 `GROUP_CALL_MAX_PENDING_CANDIDATES`（32）則；名單外的人送來的 join 最多暫存 `maxParticipants` 則。
- 拒接、離開時先結束（關裝置）再通知其他人：publish 慢也不會讓相機晚關。
- **一對一 `CallManager`** 有同一類問題（與 Cinderous 的實作平行）：接聽時等權限期間對方掛斷、開視訊時等鏡頭期間通話結束或又按了關、答方把鏡頭放上連線失敗——都改成關掉剛取得的裝置、不通知對方。

尚未處理（低風險，記錄）：邀請名單裡的其他成員不經驗證（可被偽造成任意 pubkey，受害者接聽時會對他們送 `group-join`）；`invite()` 不能重新邀請已 `no-answer`／`declined`／`left` 的人，這些人也一直佔名額；`start()`／`invite()` 送邀請時 publish 失敗不回滾。
