# 0010. 加密引擎：Cinder EK 照搬 Cinderous，雙棘輪只用在即時通道

- Status: Accepted
- Date: 2026-09-27
- 相關：
  - SDK：ADR 0006（Cinder EK 照 Cinderous：7 天輪替、10040／10042；混合 KEM 的古典半邊用 secp256k1）、ADR 0007（Cinderous 已有的協定搬進 SDK，Cinderous 改轉出）、ADR 0009（`PeerNode`）；PRD 3.2、3.4、3.5
  - Cinderous：ADR-0238、ADR-0245、ADR-0322、ADR-0365、`docs/research/double-ratchet-on-current-design.md`

## Context

PRD 3.5 要兩個可插拔的加密引擎，外加後量子（PRD 3.2、3.4）。

- **Cinder EK**：以 7 天為一期輪替的加密子鑰。無狀態，適合離線投遞與多台裝置同步。
- **雙棘輪**：有狀態，每則訊息都有前向保密，外洩後能自癒。適合雙方都在線的即時通道。

Cinderous 已經出貨 Cinder EK 和後量子混合封裝，雙棘輪則刻意沒做。它的研究稿寫得很清楚：

- 棘輪的會話狀態不能在「多台裝置共用一個身分」之間共享。兩台同時送訊會重用訊息金鑰，DH 步進也會讓會話分岔。
- Signal 的解法是每一對裝置各開一條會話（扇出），那是另一種多裝置模型。

## Decision

### 1. Cinder EK：照搬 Cinderous，SDK 只補「金鑰環」

`subkey.ts`（EK 生成、kind 10040 公告、rumor 內的 EK 提示、多鑰解封）、`ek-envelope.ts`（kind 10042，分裝置發送 EK）、`device-directory.ts`（kind 10041）原樣搬進 `@cinderous/client/protocol`。它們的測試一起搬，Cinderous 改成從 SDK 轉出。

SDK 在上面加一層 `CinderEkKeyring`：

- 持有目前的 EK 與寬限期（7 天）內的舊 EK；到期自動輪替、自動清掉過期私鑰。
- 金鑰環的**狀態可以匯出**（`exportState`／`fromState`），由 App 自己加密保存。SDK 不碰儲存，這和 `Identity` 的做法相同。
- 寄件：讀對方的 kind 10040 公告，把 NIP-59 改封給對方目前的 EK。對方公告帶 `pq` 時，走後量子混合封裝。
- 收件：依序試目前的 EK、寬限期內的舊 EK，最後退回身分金鑰（相容還沒有 FS 的寄件人）。
- **後量子防降級**（PRD 3.4）照 Cinderous 的「釘選」：一旦看過對方宣告後量子，之後讀到的公告若不帶後量子，就丟 `SecurityDowngradeError`，不自動退回古典。

### 2. 雙棘輪：只用在即時通道，一對裝置一條會話

依照 Cinderous 研究稿的結論，SDK 的雙棘輪：

- **只包在 `PeerChannel` 上**（`secureChannel(channel, …)`），雙方都在線時使用；
- **不用於離線投遞**，也不在多台裝置之間同步會話狀態；
- 通道一斷，會話就結束；重新連線就重新握手。沒有「會話失步」這回事，也就不需要 PRD 說的 2,000 則跳過金鑰上限之外的補救機制。

**演算法**照 Signal 的 Double Ratchet 規格，各部件如下：

| 部件 | 內容 |
|---|---|
| DH | secp256k1 ECDH，取 x 座標（與 NIP-44 相同，ADR 0006） |
| KDF_RK | HKDF-SHA256，salt 是根金鑰，輸入是 DH 結果；後量子時再串接 ML-KEM 共享秘密（PRD 3.5.4 的公式） |
| KDF_CK | HMAC-SHA256，訊息金鑰常數 `0x01`，鏈金鑰常數 `0x02` |
| 加密 | XChaCha20-Poly1305，以 header 當附加資料 |
| 跳過的訊息金鑰 | 上限 2,000（PRD），超過就丟例外、關通道 |

**握手**在通道內做，因為這條通道已經驗證過對方身分：P2P 軌的 DTLS 指紋經 NIP-59 信令交換，中繼軌的每一框本身就是 NIP-59。

1. 雙方各送一個臨時 DH 公鑰；要後量子時，連同 ML-KEM 公鑰一起送。
2. 公鑰較小的一方當 Alice。
3. 初始根金鑰 = HKDF(雙方身分金鑰的 ECDH ‖ 雙方臨時金鑰的 ECDH ‖ ML-KEM 共享秘密)。

**後量子**：每次 DH 步進，新的棘輪公鑰都附一把 ML-KEM 公鑰；對方回覆時附上封裝密文，根金鑰推導時一併串接。對應 PRD 3.5.4 的 PQ-Double Ratchet。〔v0.28 起改為線路格式 v2：KEM 輪次與 DH 步進脫鉤、延後混入、每條鏈只附一次，每則 header 2,314 → 50 B；見 [ADR 0033](0033-pq-ratchet-header-cost.md)。本段描述 v0.27 以前的格式。〕

**防降級**：握手時任一方要求後量子、另一方沒有，就丟 `SecurityDowngradeError`。

### 1.1 實作時的兩處調整（4b-1）

- `subkey.ts` 裡 `buildEkAnnounce` 組 `content` 的那段抽成 `ekAnnounceContent`：SDK 的 `Identity` 不交出私鑰，要自己簽公告，但格式必須與 Cinderous 同一份。
- `pruneFsKeys` 裡一個沒用到的參數改名為 `_k`（SDK 的 `noUnusedParameters` 比 Cinderous 嚴；行為不變，比照 ADR 0007）。

### 3. `ICryptoEngine`：照 PRD 的形狀，但分兩種會話

PRD 的 `ICryptoSession.encrypt／decrypt` 對兩個引擎都適用。但兩個引擎的**會話建立方式**根本不同，所以不硬塞進同一個 `createSession`：

- Cinder EK 要讀對方公告；
- 雙棘輪要在通道上握手。

- **Cinder EK 以「事件」為單位**（`seal` 產出 NIP-59 事件、`open` 解開事件）。它的用途是離線投遞，本來就是一則一則 Nostr 事件；硬套成位元組的 `encrypt／decrypt`，還得另外發明 kind。
- **雙棘輪實作 PRD 的 `ICryptoSession`**（位元組進、`EncryptedEnvelope` 出），因為它跑在位元組通道上。

### 4. 文案紅線（照 Cinderous）

- 後量子只保護**加密**，事件簽章仍是 secp256k1。它能擋的是「今天側錄、將來用量子電腦解」，**不能說「量子安全」**。
- 雙棘輪是 SDK 新寫的密碼學程式，**沒有經過外部審計**。文件一律標「實驗性」。

### 5. 獨立安全審查與修正（4b-2，v0.9.0）

雙棘輪與握手是新寫的密碼學程式，發版前做了一次獨立審查。審查員寫了實際的攻擊測試，其中三項證實可重現：

| # | 問題 | 修正 |
|---|---|---|
| 1 | 還原一份舊的會話狀態後，同一把訊息金鑰加密不同明文，金鑰流重用（兩份密文的 XOR 等於明文的 XOR） | nonce 改為每則隨機（放在密文前 24 位元組）；`exportState` 改成「搬走」：匯出後原會話即銷毀 |
| 2 | App 的 `onMessage` 監聽丟一次例外，之後所有訊息被默默丟掉，通道看起來仍正常 | 處理佇列每一步自己接住錯誤；監聽的例外隔離，改由 `onListenerError` 通知 |
| 3 | `fromState` 不驗格式：缺 `maxSkip` 會變成 NaN，跳過上限失效，對方一個假序號就能讓我們算數十億次 HMAC | 嚴格驗證每個欄位的型別與長度；`maxSkippedKeys` 限 1～10,000 的整數；古典會話帶後量子欄位即拒絕（防止改檔降級） |

加固（沒有直接的攻擊，但補上）：

- **#4**：握手要**雙方各解開一則對方的訊息**才算完成（Bob 收到「開始」後回「確認」）。這樣對方中途放棄時，這邊逾時失敗，不會「成功」連到空氣。另外先把公鑰轉小寫、拒絕「通道的對方是自己」。
- **#5**：解密成功後，把新狀態不再引用的舊秘密清零（舊鏈金鑰、舊 DH 私鑰、舊 ML-KEM 私鑰、用過或被逐出的跳過金鑰）。失敗路徑不清零，因為快照與現行狀態共用同一批位元組。
- **#6**：同一條鏈已收過的序號、以及最近退役的舊鏈，直接拒絕，不必先做一次 DH 步進才失敗。
- **#7**：序號到 2³²−1 就要求重新握手，不讓它繞回 0。
- **#8**：握手前的暫存與未讀訊息都設上限；握手失敗時解除掛在通道上的監聽。
- **#9**：釘選過的對方改發我們讀不懂的新版公告時，丟 `PeerUpgradedError`，不默默退回沒有前向保密的身分金鑰。
- **#10**：`open()` 多回傳 `senderPinned`。釘選過的人這次卻封給身分金鑰時，App 看得出來。
- **#11**：輪替刪掉 EK 時，一併清掉快取裡展開過的 ML-KEM 私鑰。
- **#12**：`fromState` 驗證時間與後量子種子；比先前看過的更舊的公告（中繼重放）直接拒絕。

審查確認正確的部分：鏈 KDF 的常數與順序、`pn`／`ns`／`nr` 狀態機、失敗還原、KEM 的封裝對象、每一步都有 DH（不會只剩後量子）、拿掉後量子欄位會失敗、握手的 transcript 與身分綁定。

**已知限制（審查員同意是設計取捨）**：握手的根秘密只有古典的部分，後量子從第一次棘輪步進才混入。這擋得住「今天側錄、將來解密」，但擋不住握手當下就擁有量子電腦的主動攻擊者。

## 分兩次交付

- 4b-1：搬 Cinder EK 協定、`CinderEkKeyring`、`ICryptoEngine` 型別（v0.8.0）。
- 4b-2：雙棘輪、握手、`secureChannel`（v0.9.0）。

## Consequences

- ＋ SDK 與 Cinderous App 的 EK 公告、封裝格式完全相同，互相讀得懂。
- ＋ 雙棘輪避開了研究稿列的三種多裝置失敗模式，因為它根本不跨裝置、不跨離線。
- － 雙棘輪沒有外部審計；PRD 描述的「離線也能用雙棘輪」不會做。
- － 金鑰環的保存交給 App：App 忘了存，重開就只剩身分金鑰可解，已經送到舊 EK 的訊息會解不開。這與 Cinderous 的 FS 取捨相同。
