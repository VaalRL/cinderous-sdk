# 0049. IoT：共用事件格式 `./iot`、家中橋接器，以及部署時選用的 relay 內建 MQTT（Node）與 HTTP 輪詢（Workers／Node，可設定的端到端加密）

- 狀態：**已接受（Accepted，2026-10-02）**——所有待決事項已由使用者逐項裁示（見〈使用者裁示（2026-10-02，C′）〉與〈使用者裁示（2026-10-02，其餘待決事項）〉）；**P0（路線 A）已實作（v0.39.0）**，見〈P0 實作（v0.39.0，路線 A）〉；**§11 IoT 推播的 SDK 側已實作（v0.40.0）**，見〈§11 實作（v0.40.0，IoT 推播的 SDK 側）〉；**R0 PoC 已完成（2026-10-07），完整實驗細節見 [`docs/reports/iot-r0-poc.md`](../reports/iot-r0-poc.md)**；**C′ 的 R1（relay 端即時通道）已實作（v0.59.0）**，見〈C′ R1 實作（v0.59.0，relay 端即時通道）〉；**C′ R2 的手機端、設備端 `./iot/device`、`operatorSecret`、NIP-11 已實作（SDK ADR 0120）**，見〈C′ R2 實作〉；**R2b（部署設定、Workers 的 `IOT_HOME` 綁定與 v2 遷移、CLI、名單公告）已實作（SDK ADR 0121）**；R3–R5、P2、P1 未做
- 日期：2026-10-02（同日補充：輪詢模式的端到端加密選項、查詢 kind 25173、閘道端角色權限、中繼端「狀態類 kind 只收閘道」保險；再補充：路線 C′ 即時通道、每個家庭一顆 DO、額度用完時的設備感知與降級）
- 對應：使用者的 IoT 研究需求（研究報告第三版，見〈參考〉）。相關：本 repo ADR 0006（kind 分配）、0007（中繼搬進 SDK）、0008（白名單與 CLI）、0013（存取控制）、
  0018（docker／fly 共用 Node 建置）、0019（中立預設）、0021（REST 部署）、0028（QR 配對與名單、§7 白名單與禮物包）、0036（`RelaySiteOptions`、Node 拒絕車道參數）、
  0037（一鍵部署參數與安全邊界）、0038／0041（容量訊號、備援中繼）、0040（拒收詞元）、0042（DO 天花板）、0043（同一身分的中繼事件預算）；
  Cinderous ADR-0002／0008（ephemeral 21000–21999 信令段）、ADR-0366（車道與嚴格平面）、ADR-0123（訂閱範圍）。

## Context

使用者想透過 Cinderous relay 遠端控制**現有** IoT 設備（Tasmota、Shelly、ESPHome、Zigbee2MQTT、Home Assistant）。研究結論（報告 §0）：

- 現成設備講的是 MQTT over TCP（或能寫 HTTP 腳本），不會簽 Nostr 事件、不會 NIP-44。
- 有三條可行路線，各自適合不同的部署：
  - **(A) 家中橋接器**：連本地 MQTT broker 與**任一** relay（含官方錨點），端到端加密，中繼只看到密文。
  - **(B) 自架 Node relay 內建 MQTT broker**：設備在區網直連 relay 主機；明文只在家中主機；Workers 做不到（沒有 inbound TCP）。
  - **(C) HTTP 輪詢**：relay 提供 `/iot/<device>/…` 端點，設備帶每台權杖輪詢；Workers 與 Node 都能做。**預設端到端加密**（每台設備一把對稱金鑰，relay 只轉送不透明密文，§2.6）；
    做不到加密的設備只能在自架白名單站、以危險旗標走明文，或改走 A。
  - **(C′) 即時通道**（後續研究，使用者已裁示）：設備常駐一條休眠式 WebSocket 到「每個家庭一顆」的 DO，relay 有命令就主動推送（開門類）；在 Workers 上比輪詢便宜一到兩個數量級（§9）。
- 使用者情境「家中主機跑 Node relay（內建 MQTT）＋Cloudflare Tunnel／自有網域」可行：手機經 `wss://relay.<網域>` 連回家，設備在區網用原生 MQTT；
  Cloudflare 只承載 WebSocket（Tunnel 的 TCP 類型要客戶端跑 `cloudflared`，Spectrum 任意 TCP 只有 Enterprise）。

需要 SDK 決定的是：三條路線**如何共用一份協定**，以及開發者**部署 relay 時如何自行選擇**要不要內建 MQTT、要不要內建輪詢、輪詢要不要（以及能不能）走明文，而且不破壞：

1. 中立預設（ADR 0019）——沒選就什麼都沒有；
2. 「不能關掉防線」（ADR 0037）——沒有任何組合能部署出匿名 MQTT、無權杖輪詢、在開放站上收明文、或在官方錨點收明文；
3. bundle 隔離——MQTT broker 不能進主入口、Workers bundle、或任何行動版會載入的子路徑（ADR 0021 守門測試的精神）；
4. 官方錨點行為逐則不變——沒開 IoT 的 relay，RelayCore 的每一則輸出都與 v0.37 相同。

## Decision（提議）

### 1. 分層：協定一份、閘道一份、宿主三種接法

```
                ┌──────────── @cinderous/client/iot（中立，無 node:*）────────────┐
                │ 協定層：kind、家庭金鑰衍生、topic 盲化、NIP-44 封裝、ack／去重 │
                │         設備金鑰衍生與 AES-256-GCM 信封（輪詢 E2EE，§2.6）     │
                │ 客戶端：IotClient（操作等 ack、查詢、訂閱狀態、讀 retained）    │
                │ 閘道核心：IotGateway（角色授權、去重、重放保護、retained、心跳）│
                └──────────┬───────────────────────┬──────────────────────┬────┘
                           │                       │                      │
     (A) ./iot/bridge（Node）       (B) ./relay/node/iot-mqtt（Node）   (C) ./relay 的 iot-polling（中立）
     mqtt.js 連本地 broker           Aedes 內嵌或外接 broker             HTTP 端點 ↔ 設備權杖
     RelayPool 外連任一 relay         程序內注入 RelayCore                程序內注入 RelayCore（Worker DO／Node）
                                                                         E2EE 時：relay 只轉送設備密文，
                                                                         解密在設備端（設備側參考實作）
```

- **閘道（`IotGateway`）只有一份**，三條路線都用它：A 把它放在橋接器程序、經 `RelayPool` 外連；B／C 把它放在 relay 程序內、直接注入 RelayCore。
- **C 的端到端加密模式把閘道核心拆成兩半**：「轉送半」在 relay（看外層 Nostr 事件的簽章者做角色授權、排佇列、以閘道簽章金鑰注入狀態事件——**不持有家庭秘密、不持有設備金鑰**）；
  「解密半」在設備（解密、防重放、執行、加密回報）。SDK 提供設備側參考實作（Tasmota Berry、ESPHome 外部元件、Home Assistant／Python），見 §2.6。
- **手機端永遠只用 `IotClient`**，不需要知道對面是 A、B 還是 C；C 的 E2EE 設備由 `IotClient` 依設備登錄自動以設備金鑰加解密。

### 2. IoT 事件格式（`./iot` 協定層，v1）

#### 2.1 金鑰

- **家庭秘密** `homeSecret`（32 bytes）：家中所有成員與閘道持有，經 ADR 0028 的 QR 配對發放；撤銷成員＝輪換家庭秘密（舊的 retained 由閘道以新秘密重發）。
- 以 HKDF-SHA256 衍生：
  - `homeKey = HKDF(homeSecret, "cinder-iot/v1/enc")` → 一把 secp256k1 私鑰；其公鑰 `homePub` 是所有 IoT 內容的 NIP-44 收件者。任何成員都能用 `homeKey × 寄件人公鑰` 解密，所以一則狀態只需加密一次（不必逐成員）。
    **加密給 `homePub` 只需要寄件人自己的私鑰與 `homePub`（公開值）**——C 的 relay 不持有家庭秘密也能把狀態加密給全家。
  - `topicKey = HKDF(homeSecret, "cinder-iot/v1/topic")` → 盲化用的 HMAC 金鑰。
  - `homeTag = base64url(HMAC(topicKey, "home"))[:22]` → 家的路由標籤。
  - `deviceKey(id, epoch) = HKDF(homeSecret, salt="", info="cinder-iot/v1/device-key|" + id + "|" + epoch, 32)` → C 的 E2EE 設備金鑰（§2.6）。
- 每個成員（手機）與閘道各自有自己的 Nostr 身分（`NostrSigner`，ADR 0023）；**授權看簽章者的 npub**（§2.5），家庭秘密只負責加密與盲化。

**盲化**：`blind(s) = base64url(HMAC-SHA256(topicKey, s))` 取前 22 字元（128 位元）。中繼只看得到隨機字串。

#### 2.2 kind（草案，定案前對 NIP 登記表查重）

| kind | 類別 | 方向 | 用途 | 會改變設備狀態？ | 主要標籤 |
|---|---|---|---|---|---|
| 25170 | ephemeral | 成員 → 閘道 | **操作**（開關、設定值；需 `operator`） | ✅ | `h`、`t`＝blind(topic)、`p`＝閘道、`expiration`；C 的 E2EE 另帶 `dv`＝blind("dev:"+device) |
| 25171 | ephemeral | 閘道 → 下指令／查詢的成員 | ack（`ok`／`rejected`／`not-allowed`…） | — | `h`、`e`＝指令或查詢 id、`p`＝該成員 |
| 25172 | ephemeral | 閘道 → 全家 | 即時狀態／遙測；查詢的回覆也用它（帶 `e`＝查詢 id） | — | `h`、`t`、每層前綴 `tp`、可選 `d`＝blind("dev:"+device)、可選 `e` |
| 25173 | ephemeral | 成員 → 閘道 | **查詢**：要求設備**立刻回報**目前狀態（需 `viewer` 以上） | ❌ | 同 25170（`h`、`t` 或 `dv`、`p`＝閘道、`expiration`） |
| 31170 | addressable | 閘道 → 全家 | retained 狀態，**以設備為單位打包** | — | `d`＝blind("dev:"+device)、`h`、`expiration`（可選，表示多久沒更新就不可信） |
| 31171 | addressable | 閘道 → 全家 | 閘道存活（心跳／LWT 模擬） | — | `d`＝blind("gw")、`h`、`expiration`＝now＋3×心跳間隔 |

- **查詢與操作分開**：25170 會改變設備狀態，只有 `operator` 能送；25173 只要求設備回報，不改變狀態，`viewer` 也能送。
  分開的好處：角色判斷只看 kind（中繼與閘道都不用解析內容就知道是不是「會動到設備」）；查詢可以被閘道節流（同一台設備 5 秒內只轉一次給設備，其餘直接以 retained 回覆）而不影響操作。
- **「查看最新狀態」不一定要打擾設備**：直接讀 31170 retained（`iot.getRetained()`，一次 REQ，不經閘道、不喚醒設備、不吃設備的輪詢額度）就拿得到最後一次回報的值與時間；
  只有在 retained 太舊（`stale`）或需要「此刻」的讀數時才送 25173。
- 查詢的處理：A／B 的閘道對設備送原生的狀態查詢（例如 Tasmota `cmnd/<dev>/STATUS`、空本文的 `cmnd/<dev>/POWER`），收到回報後發 25172（帶 `e`＝查詢 id）並更新 31170，同時回 25171 `ok`；
  C 的閘道把查詢排進設備佇列（`type: "query"`），設備下一次輪詢取到後 `POST state` 帶 `inReplyTo`。
- **查重結果（2026-10-02）**：
  - NIP 登記表（nostr-protocol/nips README 的 kind 表）：20000–29999 段只有 21059、22242、23194、23195、24133、24242、27235、28934–28936；30000–39999 段沒有 3117x。**25170–25173、31170–31171 都未被登記。**
  - 本 repo（`src/`、`docs/`）與 Cinderous、四款遊戲、CinderSync、Cinder Coffice 的原始碼：**沒有任何一處使用 25170–25173 或 31170–31171**。
  - ⚠ **但 25170–25173 落在 Cinderous 的「信令段」21000–21999 之內**（Cinderous ADR-0002／0008、`packages/core/src/constants.ts` 的 `SDP_KIND_RANGE`、本 repo ADR 0006）。
    該段的約定是「NIP-59 禮物包包封的信令」；IoT 的 2117x 不是禮物包（閘道直接簽章、帶 `h`／`t` 標籤）。目前**沒有任何程式以這個區間做判斷**（`SDP_KIND_RANGE` 只有宣告、沒有使用者；
    Cinderous ADR-0048 的企業政策以明確 kind 名單停用信令，不是以區間），所以不會出錯，但語意上混用。**建議改用 25170–25173**（NIP 登記表與所有本機 repo 都未使用、不在任何約定段內），31170／31171 不變；
    定案列在待決事項 11。本文其餘部分以 2117x 書寫，改號只是常數替換。

#### 2.3 內容

（A／B 與 C 的明文設備：NIP-44 v2，寄件人私鑰 × `homePub`）

```json
{ "v": 1, "type": "cmd|query|ack|state|retained|gw",
  "msgId": "<128 位元，ULID 或 hex>", "ts": 1759370000123,
  "topic": "home/plug1/set", "device": "plug1",
  "payload": "ON", "enc": "utf8|base64",
  "qos": 0, "retain": false, "inReplyTo": "<查詢的 msgId>",
  "status": "ok|rejected|timeout|unknown-topic|not-allowed|throttled",
  "topics": { "home/plug1/power": { "payload": "ON", "ts": 1759370000000 } },
  "online": true, "will": false, "reason": "…" }
```

（各 `type` 只帶用得到的欄位；`retained` 用 `topics` 打包、單顆 ≤ 32 KB——車道可尋址上限；超過時閘道拆成多顆、`d` 加序號。）
C 的 E2EE 設備，內容換成 §2.6 的設備信封。

#### 2.4 語意

- **萬用字元**：`#` ＝訂閱 `#tp`（前綴標籤）；`+` ＝訂閱較寬前綴後在客戶端比對（`./iot` 內建 MQTT 樣式比對器）。（C 的 E2EE 設備例外：relay 沒有 `topicKey`，只能以設備為單位路由，見 §2.6。）
- **QoS 0**：送一次。**QoS 1 模擬**：等 ack（預設 3 秒、指數退避、最多 3 次）；**每次重送重新簽章（新 id）、同一個 msgId**——同一顆事件重送會被中繼回 `OK true duplicate` 而不扇出（ADR 0040）。
- **去重與重放保護**（閘道與客戶端都做）：拒收 `ts` 早於現在 `maxSkewSec`（預設 30，夾 5–120）或晚於 5 秒的指令與查詢；msgId LRU 去重（預設 1,024 筆、視窗 ≥ `maxSkewSec`）；
  指令帶 NIP-40 `expiration = ts + ttl`（預設 30 秒），讓中繼與離線補收都不會送出過期指令。去重命中仍回 ack（冪等），讓重送的發送端收得到結果。
- **retained**：閘道以 31170 保存每台設備所有 topic 的最後值；變化時更新，且至少每 `retainedRefreshSec`（預設 6 小時）刷新一次以維持「活躍即保存」。
- **心跳／LWT**：閘道每 `heartbeatSec`（預設 60，夾 15–600）更新 31171；過期讀不到＝閘道離線。**設備層的 LWT**：A 轉譯設備在本地 broker 的 LWT（例如 Tasmota `tele/<dev>/LWT`）；
  **B 由內嵌 broker 的斷線事件直接產生 `will: true` 的狀態——真正的 LWT，不需要中繼新增協定行為**；C 以「超過 3 個輪詢週期沒來」判定離線。

#### 2.5 閘道端角色權限

授權在**閘道**執行，依外層事件的**簽章者公鑰**判斷（不是依內容自稱的身分）：

| 角色 | 讀狀態（25172、31170、31171） | 查詢 25173 | 操作 25170 | 管理角色名單 |
|---|---|---|---|---|
| `viewer`（檢視者） | ✅（見下方說明） | ✅ | ❌ 回 `not-allowed` | ❌ |
| `operator`（操作者） | ✅ | ✅ | ✅ | ❌ |
| `owner`（擁有者，新增建議） | ✅ | ✅ | ✅ | ✅ |

```ts
acl: [
  { npub: 'npub1媽媽…', role: 'owner' },
  { npub: 'npub1小孩…', role: 'operator', devices: ['light-*'], topics: ['home/+/light/#'] },  // 可依設備或 topic 細分
  { npub: 'npub1保母…', role: 'viewer',   devices: ['cam-door', 'thermo'] },
  { npub: 'npub1訪客…', role: 'viewer',   expiresAt: 1759900000 },                         // 到期自動失效
]
```

- **細分**：每筆可選 `devices`（設備 id，支援 `*` 尾萬用字元）與 `topics`（MQTT 樣式）；兩者都給時取交集；沒給＝全部。另可對單一 topic 標 `minRole: 'owner'`（門鎖、瓦斯）與 `confirm: true`
  （客戶端 API 要求呼叫端明確帶 `confirmed: true`）。不在名單、角色不足、或樣式不符都回 25171 `status: "not-allowed"`（不靜默丟棄，方便除錯）。
- **「能解密狀態」與「能下指令」是兩回事**：狀態以家庭共用收件者 `homePub` 加密（C 的 E2EE 設備以設備金鑰加密，而設備金鑰也由家庭秘密導出），**持有家庭秘密的人都讀得到所有狀態**——
  `viewer` 的「讀」不是被閘道允許出來的，而是因為他拿到了家庭秘密。因此角色名單**無法**限制「誰能讀哪台設備的狀態」；它只限制「誰能查詢、誰能操作」。
  若未來需要「某些設備的狀態只給部分成員看」，要改成逐成員加密（不在 v1 範圍，列入待決事項 13）。
- **指令權限由閘道核對、不靠加密**：持有家庭秘密的 `viewer` 也能做出格式正確、解得開的指令（甚至 C 的設備信封），但送出的 25170 外層簽章是他自己的公鑰，閘道（A／B）或 relay 的轉送半（C）核對角色後拒絕。
  C 的設備本身無法驗 Nostr 簽章，所以 **C 的指令授權完全由 relay 的轉送半執行**；角色名單只有公鑰、不是秘密，放在 relay 不違反「relay 不持有金鑰」。
- **名單的發放沿用 ADR 0028**：新成員以 QR 配對加入（交付家庭秘密與 relay 清單）；**配對的發起方必須是 `owner`，並在配對畫面選擇角色**，
  `owner` 的裝置把「角色名單更新」以 25170 送到閘道的保留 topic `$sys/acl`（只有 `owner` 能操作），閘道寫入本地名單並發 31170 `d`＝blind("sys:acl")（加密給全家，讓成員看得到名單）。
  ⚠ **角色不放進 ADR 0028 的可合併名單（`VaultMembership`）**：那份名單任何有效成員都能改、以聯集合併，`viewer` 可以把自己改成 `operator`。角色名單只以閘道本地為準，只有 `owner` 能改。
- 撤銷成員：`owner` 從角色名單移除（立即失去查詢／操作權）＋輪換家庭秘密（失去讀取能力，§2.6 說明對 C 設備金鑰的影響）。

#### 2.6 輪詢模式（C）的端到端加密——可設定選項

**設計**

- 輪詢端點的酬載是**不透明密文**：每台設備一把對稱金鑰 `deviceKey(id, epoch)`（§2.1，由家庭秘密以 HKDF 導出），**設定時寫入設備一次**（CLI 產生、顯示一次，貼進設備腳本／YAML／`persist`）。
  設備端**不需要**做 HKDF（Tasmota 的 HKDF 要自編 `USE_BERRY_CRYPTO_HKDF_SHA256`）。
- **演算法：v1 只支援 AES-256-GCM**（`alg: "A256GCM"`，96 位元 nonce、128 位元 tag）。不採 ChaCha20-Poly1305 為必選的理由：Tasmota Berry `crypto` 沒有 ChaCha20-Poly1305；
  ESP-IDF 的 mbedtls 預設 `MBEDTLS_GCM_C=y` 但 `MBEDTLS_CHACHAPOLY_C=n`（ESPHome 要自訂 sdkconfig 才有）。Home Assistant／Node 兩者都能做，但只有 AES-256-GCM 是所有可加密設備的共同交集。
  信封保留 `alg` 欄位，日後可加 `"C20P1305"`（只給 HA／Node 類設備，列入待決事項 14）。
- **信封**（設備 ↔ 手機之間的明文，relay 看得到的只有這些欄位）：

```json
{ "v": 1, "alg": "A256GCM", "kid": "plug1.0", "dir": "down|up",
  "ctr": 1842, "ts": 1759370000, "nonce": "<12 bytes base64>", "ct": "<base64，含 16 bytes tag>" }
```

  - AAD＝`"cinder-iot/v1|" + dir + "|" + kid + "|" + ctr + "|" + ts`——上述欄位被竄改就解不開。
  - 明文是 §2.3 的 JSON（`type`、`msgId`、`topic`、`payload`、`topics`…），**topic 名稱只在密文裡**。
  - nonce：`down`（手機 → 設備）以手機的 CSPRNG 產生，首位元組固定 `0x00`＋11 bytes 隨機；`up`（設備 → 手機）＝`0x01`＋3 bytes 零＋8 bytes 大端 `ctr`。兩方向的 nonce 空間不相交，同一把金鑰不會重用 nonce。
- **防重放**：
  - `up`：設備的 `ctr` 嚴格遞增並持久化（Tasmota `persist`、ESPHome `preferences`、HA 檔案）；為了不磨損快閃記憶體，每次開機先把持久化值「預約」加 1,000 再寫回、執行中只在跨過預約時寫入
    ——斷電最多跳號、不會重複。手機記住每台設備最後接受的 `ctr`，拒收不大於它的信封；relay 也可以（看得到明文的 `ctr`）先擋掉不遞增的，省一次扇出。
  - `down`：多支手機各自送指令，無法共用一個遞增計數器 ⇒ 設備以 `ts` 視窗（預設 ±60 秒，設備要有 NTP／SNTP——Tasmota、ESPHome、Shelly、HA 都有）＋最近 32 筆 `msgId` 去重；`ctr` 在 `down` 方向是發送端自己的序號，只進 AAD。
  - relay 可以重送舊密文、丟棄或延遲指令（可用性問題，不是機密性問題）；重送會被視窗與 msgId 擋掉。
- **流程（C、E2EE）**：
  1. 手機 `IotClient` 依設備登錄（`encryption: 'device-key'`）以設備金鑰做出 `down` 信封，再以 NIP-44（手機私鑰 × **閘道簽章公鑰**）包成 25170／25173 的內容，標籤 `h`、`dv`、`p`＝閘道。
  2. relay 的轉送半：驗簽 → 依簽章者公鑰與角色名單授權（25170 需 `operator`、25173 需 `viewer`）→ 以閘道私鑰解開**外層** NIP-44，取得設備信封（解不開內層）→ 依 `dv` 對應設備 → 排進佇列。
  3. 設備 `GET /iot/<device>/commands` 取到信封 → 解密 → 檢查視窗與 msgId → 執行 → `POST /iot/<device>/ack`（`up` 信封）與 `POST /iot/<device>/state`（`up` 信封，內含**整台設備所有 topic 的目前值**）。
  4. relay 把 `up` 信封以 NIP-44（閘道私鑰 × `homePub`）包成 25171／25172 並更新 31170（`d`＝該設備在設定裡預先算好的盲化 id），扇出給全家；手機剝兩層讀到明文。
- **E2EE 下 relay 看得到的元資料**：設備 id（設定裡有）、`kid`、`dir`、`ctr`、`ts`、密文長度、時間；**看不到** topic、payload、指令內容與狀態值。
  relay 沒有 `topicKey`，所以 E2EE 設備的事件只帶 `h` 與 `d`／`dv`（由 CLI 部署時以家庭秘密預先算好、只寫入盲化結果），**沒有 `t`／`tp`**——手機以設備為單位訂閱，topic 萬用字元在客戶端比對。
  retained 也以「設備最後一次回報的整份信封」為單位（relay 不能合併密文裡的 topic；由設備每次回報完整狀態）。
- **金鑰輪換與撤銷**：
  - **設備遺失／被拆走**（設備金鑰外洩）：只對那台把 `epoch` 加 1（`deviceKey(id, epoch+1)`），重新寫入新設備（或作廢該 id），並更換該台的輪詢權杖；其他設備不受影響。
  - **單獨換金鑰**（例如懷疑某支腳本外流）：同上，`epoch` 加 1；設備登錄的 `keyEpoch` 跟著改（relay 以 `kid` 拒收舊 epoch 的信封、回 `invalid: iot-e2ee: 金鑰版本已作廢`）。
  - **撤銷成員**（家庭秘密輪換）：所有 `deviceKey` 都會跟著變 ⇒ 每台 E2EE 設備都要重新寫入金鑰——這是為了讓被撤銷的人讀不到之後的流量所必須的。
    若想延後重寫，可暫時把舊設備金鑰以新家庭秘密包起來繼續用（`keyWrap`），但**被撤銷者仍能解讀那些設備直到重寫為止**；CLI 會列出「尚未換金鑰的設備」。
  - 輪換期間 relay 與手機同時接受 `epoch` 與 `epoch-1` 最多 24 小時（`keyGraceSec`，夾 0–604,800），讓設備陸續更新。

**設定層級**

| 層級 | 設定 | 值 | 預設 |
|---|---|---|---|
| 站方政策 | `iotPolling.e2ee` | `'required'`（所有設備必須 `device-key`）／`'optional'`（每台自選）／`'off'`（全部明文） | **`'required'`** |
| 每台設備 | 設備登錄的 `encryption` | `'device-key'`／`'none'`（明文） | `'device-key'` |

- 設備層級受站方政策約束：`required` 時出現 `none` ⇒ 部署失敗；`off` 時出現 `device-key` ⇒ 部署失敗（矛盾設定直接拒絕，不默默改寫）；`optional` 時逐台照設定。
- **明文（`'optional'`／`'off'`，或任何一台 `none`）的條件——三個都要成立，缺一就部署失敗**：
  1. 自架站（不是官方錨點）；
  2. 有白名單（`ALLOWED_PUBKEYS`）——**開放站上沒有任何旗標能開明文輪詢**（`dangerouslyAllowIotOnOpenRelay` 只允許 E2EE 輪詢）；
  3. 明確的危險旗標 `dangerouslyAllowPlaintextIotPolling: true`（CLI `--dangerously-allow-plaintext-iot-polling`、環境變數 `IOT_PLAINTEXT_POLLING=dangerously-allow`）。
- **官方錨點永遠不允許明文輪詢**：錨點是開放站（沒有 `ALLOWED_PUBKEYS`），條件 2 在結構上就不成立；另外 Cinderous 錨點設定不設 `IOT_POLLING`（是否連 E2EE 輪詢都開由 Cinderous ADR 決定），
  並在 Cinderous 的錨點設定測試加一條「`IOT_PLAINTEXT_POLLING` 不得出現」的守門。
- **relay 持有的秘密隨政策而變**：`required` 時 relay **只持有**閘道簽章金鑰與設備權杖雜湊——Workers 上設了 `IOT_HOME_SECRET` 反而部署失敗（「E2EE 輪詢不需要也不應把家庭秘密交給 relay」）；
  Node 上若同時開了 B（`iotMqtt` 需要家庭秘密）則允許，但輪詢模組仍把 E2EE 設備當不透明位元組處理。只有 `optional`／`off` 且確實有明文設備時，relay 才需要家庭秘密（為明文設備做 NIP-44 與盲化，＝原本的 C）。
- **NIP-11 宣告**：`cinder_iot.polling: { "e2ee": "required" | "optional" | "off", "alg": ["A256GCM"], "plaintext_devices": <bool> }`；
  `IotClient` 對 `e2ee` 不是 `required` 的站顯示提示，且對 `encryption: 'device-key'` 的設備**不會**因站方允許明文而降級。

**設備能力（2026-10-02 查證）**

| 平台 | 能做 AES-256-GCM？ | 細節與限制 | 建議 |
|---|---|---|---|
| **Home Assistant**（Python） | ✅ | HA core 相依 `cryptography`（`pyproject.toml` 釘 `cryptography==50.0.1`），有 `AESGCM` 與 `ChaCha20Poly1305`；以自訂整合（custom component）或 pyscript 實作 | 可做；但 HA 本身有 MQTT，通常 A／B 更合適 |
| **Tasmota ESP32**（Berry） | ✅ | Berry 只在 `tasmota32` 建置（「NOT supported on ESP82xx」）；`crypto` 模組**預設**有 AES GCM 256、AES CCM、AES CBC、HMAC SHA256、SHA256、MD5；AES CTR、HKDF、PBKDF2、EC C25519／P256 需自編 `USE_BERRY_CRYPTO_*`；**沒有 ChaCha20-Poly1305**。`AES_GCM.init(key, iv)`、`encrypt()`／`decrypt()`、`tag()`——解密後要自行比對 tag（文件未提供常數時間比較）；`persist` 可存計數器、`uuid.uuid4()` 可當亂數；HTTPS 由 Berry `webclient` | 可做（參考實作：Berry 腳本） |
| **ESPHome ESP32** | ✅（需自寫 C++） | ESPHome 沒有現成的 AES-GCM 元件；以外部元件（external component）呼叫 ESP-IDF 的 mbedtls `mbedtls_gcm_*`；ESP-IDF Kconfig `MBEDTLS_GCM_C` 預設開、`MBEDTLS_CHACHAPOLY_C` 預設關 | 可做（參考實作：外部元件，P2） |
| **ESPHome ESP8266** | 查不到可靠資料 | ESP8266 Arduino core 用 BearSSL，是否能以合理方式在 ESPHome lambda 內做 AES-GCM **未查證** | v1 不列支援 → 走 A／B |
| **Tasmota ESP8266** | ❌ | 沒有 Berry；Rules 沒有任何加密函式；預編版連讀 HTTP 回應都沒有（`USE_WEBSEND_RESPONSE`） | 走 A／B（本來就講 MQTT） |
| **Shelly Gen2** | ❌ | 腳本（Espruino／mJS 子集）的 `ArrayBuffer` 與 `AES` 「since version 1.6.0 for Gen 3 and Gen 4 devices only」——Gen2 沒有；官方腳本文件**查不到**任何 HMAC／SHA 函式 | 走 A（Shelly 的 MQTT 模式） |
| **Shelly Gen3／Gen4**（韌體 ≥ 1.6.0） | ❌（沒有 AEAD） | `AES.encrypt/decrypt(data, key, mode)`，模式只有 CBC、CFB、CTR、OFB、ECB，**沒有 GCM**；128／192／256 位元金鑰；文件沒寫 IV 的處理；**查不到** HMAC／SHA／亂數 API | v1 走 A；未來可評估以 ECB 原語自組 AES-CTR＋AES-CMAC 的設定檔（未驗證，待決事項 15） |

不支援加密的設備：建議走**路線 A（家中橋接器）**——它們本來就講 MQTT，橋接器在家做端到端加密；或在自架白名單站以危險旗標走明文。

### 3. 客戶端 API 草案（`@cinderous/client/iot`）

```ts
import { deriveIotHome, IotClient } from '@cinderous/client/iot';

const home = deriveIotHome(homeSecret);                // { homePub, topicKey, homeTag, deviceKey(id, epoch) }（純函式、可測向量）
const iot = new IotClient({
  pool,                                               // 既有 RelayPool；備援用 publish 的 durability（ADR 0041）
  signer,                                             // NostrSigner（ADR 0023）
  home,
  gateway: 'npub1…',                                  // 閘道公鑰；可從 NIP-11 cinder_iot.gateway 或配對取得
  budget: sharedRelayEventBudget(myPubkey),           // 與信令／名單／Vault 同步共用（ADR 0043）
  devices: [                                          // C 的設備登錄（A／B 不需要）；可從閘道的 31170 sys:devices 讀
    { id: 'shelly-door', encryption: 'none' },
    { id: 'plug1', encryption: 'device-key', keyEpoch: 0 },
  ],
  e2ee: { maxSkewSec: 60, acceptPreviousEpochSec: 86_400 },
});

const r = await iot.command('home/plug1/set', 'ON', { qos: 1, timeoutMs: 3000, retries: 3 });   // kind 25170
// r: { status: 'ok' | 'rejected' | 'not-allowed' | 'timeout' | 'relay-rejected', msgId, attempts, ackedAt?, rejected?: RelayRejectKind }

const q = await iot.query('plug1', { timeoutMs: 5000 });  // kind 25173：要求設備立刻回報
// q: { status: 'ok' | 'throttled' | 'not-allowed' | 'timeout', state?: { topics, ts }, fromRetained: boolean }

const sub = iot.subscribeState('home/#', (m) => { /* { topic, payload, ts, device, live: true, e2ee: boolean } */ });
sub.close();

const snap = await iot.getRetained('plug1');          // 讀 31170，不打擾設備：{ device, topics, ts, stale: boolean } | undefined
const devices = await iot.listDevices();              // [{ device, online, lastSeen, topicCount, e2ee }]
const stop = iot.watchGateway((s) => { /* { online, lastSeen } */ });
const me = await iot.myRole();                        // 'owner' | 'operator' | 'viewer' | undefined（讀 sys:acl）
```

閘道（A 的橋接器與 B／C 的內建閘道共用）：

```ts
import { IotGateway } from '@cinderous/client/iot';
import { startIotBridge } from '@cinderous/client/iot/bridge';   // (A)，Node，mqtt.js 為選用 peer 相依

await startIotBridge({
  mqtt: { url: 'mqtt://localhost:1883', username, password },
  relays: ['wss://…/app/iot'], standby: ['wss://…'],
  signer: gatewaySigner, home,
  acl,                                                // §2.5 的角色名單（初始值；之後以 $sys/acl 由 owner 更新）
  aclStore: fileAclStore('./iot-acl.json'),           // 角色名單的持久化
  topicMap: [{ mqtt: 'stat/plug1/POWER', topic: 'home/plug1/power', device: 'plug1', dir: 'up' },
             { topic: 'home/plug1/set', mqtt: 'cmnd/plug1/POWER', device: 'plug1', dir: 'down' }],
  queryMap: [{ device: 'plug1', mqtt: 'cmnd/plug1/STATUS', payload: '11' }],   // 25173 對應的原生查詢
  throttle: { minIntervalSec: 30, onChangeOnly: true, queryMinIntervalSec: 5 },
});
```

CLI：`cinderous iot bridge --config iot-bridge.json`（Docker 映像沿用 ADR 0018 的建置內容）；
`cinderous iot device-key <device> [--epoch N]`（從家庭秘密導出設備金鑰，以 hex 與 Berry／YAML 片段顯示一次）；`cinderous iot acl add|remove|list`（owner 用）。

### 4. relay 端：開發者部署時自行選擇（預設全部關閉）

**Node 主機**（`./relay/node`）：

```ts
startNodeRelay(env, {
  memory: false,
  iot: {
    gateway: { secretKey },           // 閘道簽章身分（也可用 IOT_GATEWAY_KEY 檔案路徑）
    home: { homeSecret },             // 家庭秘密：B 需要；C 只有明文設備才需要
    acl,                              // §2.5 角色名單
    stateAuthors: 'gateway',          // §6「中繼端保險」：狀態類 kind 只收閘道公鑰（開 IoT 時預設就是這個）
    mqtt: {                           // (B) 有給才載入 ./relay/node/iot-mqtt（動態 import）
      mode: 'embedded',               // 'embedded'（Aedes）| 'external'（連既有 Mosquitto，＝程序內的 A）
      port: 1883, host: '0.0.0.0',
      tls: { port: 8883, cert, key, ca?, requestClientCert? },
      ws: { path: '/mqtt' },          // MQTT over WebSocket，掛在 relay 的 HTTP 伺服器；預設不開
      devices: [{ id: 'plug1', username: 'plug1', passwordHash: 'scrypt$…',
                  publish: ['stat/plug1/#', 'tele/plug1/#'], subscribe: ['cmnd/plug1/#'] }],
      topicMap,
    },
    polling: {                        // (C)
      enabled: true,
      e2ee: 'required',               // 'required'（預設）| 'optional' | 'off'
      dangerouslyAllowPlaintext: false,
      devices: [
        { id: 'plug1', tokenHash: 'sha256:…', encryption: 'device-key', keyEpoch: 0, blindId: '…' },
        { id: 'shelly-door', tokenHash: 'sha256:…', encryption: 'none', topics: ['home/door/#'] },  // 需 optional＋白名單＋危險旗標
      ],
      intervalHintSec: 30, longPollSec: 25,           // longPoll 只在 Node
      keyGraceSec: 86_400,
    },
  },
});
```

`cinderous relay start` 新旗標：`--iot-config <檔案>`（設備、帳密雜湊、權杖雜湊、ACL、topicMap 只走設定檔，不走命令列）、`--iot-mqtt`、`--iot-mqtt-port`、
`--iot-mqtt-tls-cert/--iot-mqtt-tls-key`、`--iot-mqtt-ws`、`--iot-polling`、`--iot-e2ee=required|optional|off`、`--dangerously-allow-plaintext-iot-polling`。
另有 `cinderous iot hash-password`／`cinderous iot new-token`（產生雜湊，原文只印一次）。

**Workers 宿主**（`./relay/worker`）：**只有輪詢可選**。

- 路由：非升級的 `GET /iot/<device>/commands`、`POST /iot/<device>/state`、`POST /iot/<device>/ack` 送進 **`IOT_LANE` 指定車道的 DO**（必須在 `APP_LANES`）——
  手機連的是同一條車道（`/app/<IOT_LANE>`），閘道注入的事件才扇得到它們。沒設 `IOT_POLLING`＝這些路徑回 404，與今天相同。
  ⚠ **已由 §9.2 取代（使用者裁示 2）**：Workers 上的 IoT（輪詢與 C′）改為**每個家庭一顆 DO**（`iot:<homeTag>`），路徑改為 `/iot/v1/…`，手機改連 `/iot/v1/home/<homeTag>`，不再借用 `IOT_LANE` 車道。本段保留作為決策紀錄。
- 秘密走 Worker secret 綁定：`IOT_GATEWAY_KEY`、`IOT_DEVICE_TOKENS`（`<device>:<sha256>` 清單）；`IOT_HOME_SECRET` **只在有明文設備時**才允許設定。
  非秘密的設備登錄走一般變數 `IOT_DEVICES`（JSON：`id`、`encryption`、`keyEpoch`、`blindId`）；政策走 `IOT_POLLING_E2EE`、`IOT_PLAINTEXT_POLLING`。REST 部署以 `secret_text` 上傳（重新部署既有的 `keep_bindings` 會保留）。
- **DO 不掛住請求**：DO 的 duration 依官方是「shared across all requests active on an Object at once」——**每顆「一直有請求掛著」的 DO** 每日約 0.125 GB × 86,400 s ≈ 10,800 GB-s（免費 13,000 GB-s 的 83%），**與掛著的設備數無關**
  （原文「一台設備常駐掛住約吃掉 83%」是錯的，2026-10-02 更正）。在每個家庭一顆 DO 的分片下，等於第二個家庭就超過免費額度。
  長輪詢只做「**Worker 掛住、DO 不掛**」的版本（§9.3，使用者裁示 8），僅給沒有 WebSocket 客戶端的韌體作備援。

**一鍵部署參數**（`RelaySiteOptions` 擴充，ADR 0036／0037 的同一份 `relaySiteVars`）：

```ts
interface RelaySiteOptions {
  // …既有欄位
  iotPolling?: {
    lane?: string;
    e2ee?: 'required' | 'optional' | 'off';                 // 預設 'required' → IOT_POLLING_E2EE
    devices: { id: string; token: string; encryption?: 'device-key' | 'none'; keyEpoch?: number }[];
    gatewayKey?: string;
    homeSecret?: string;        // required 時給了就丟例外；有明文設備時才需要。E2EE 設備的 blindId 由部署端用它預先計算，但不上傳
    intervalHintSec?: number; maxStateBytes?: number; commandTtlSec?: number; queuePerDevice?: number; keyGraceSec?: number;
  };
  iotGatewayPubkeys?: string[];  // 自架站跑 A 時：狀態類 kind 只收這些作者（§6）→ IOT_GATEWAY_PUBKEYS
  iotMqtt?: { port?: number; tlsPort?: number; ws?: boolean };   // Node 限定 → 新增 NODE_ONLY_SITE_OPTIONS
  dangerouslyAllowIotOnOpenRelay?: boolean;        // 只允許 E2EE 輪詢上開放站
  dangerouslyAllowPlaintextIotPolling?: boolean;   // 明文輪詢；另需白名單 → IOT_PLAINTEXT_POLLING=dangerously-allow
}
```

- 新增 `NODE_ONLY_SITE_OPTIONS = ['iotMqtt']`：`relaySiteVars(opts, 'worker')` 給了它就丟例外（與 `WORKER_ONLY_SITE_OPTIONS` 對稱）。
- `relay deploy` 旗標：`--iot-polling`、`--iot-lane <id>`、`--iot-config <檔案>`（權杖原文與家庭秘密只在部署端出現，寫入 secret 或算完盲化 id 後不落地）、
  `--iot-e2ee`、`--dangerously-allow-plaintext-iot-polling`、`--iot-gateway <npub>`（可重複）；`--iot-mqtt*` 配 `--provider=cloudflare` 是用法錯誤。
- docker／fly：`iotMqtt` 會在 compose／fly 設定多開對應埠，並在建置內容的 `package.json` 加入 `aedes`（只有選了才加）。
- **錯誤訊息**（部署前，`relaySiteVars` 與 Node 啟動同一份驗證）：
  - `iotPolling.e2ee 只能是 required、optional 或 off（收到：…）`
  - `明文 IoT 輪詢只允許有白名單（ALLOWED_PUBKEYS）的自架站；開放站沒有開關可以打開`
  - `明文 IoT 輪詢需要 dangerouslyAllowPlaintextIotPolling: true（CLI：--dangerously-allow-plaintext-iot-polling）；relay 會看到這些設備的指令與狀態：shelly-door`
  - `站方政策 e2ee=required，但設備 shelly-door 設為 encryption: none`／`站方政策 e2ee=off，但設備 plug1 設為 encryption: device-key`
  - `e2ee=required 時不應把家庭秘密交給 relay（移除 homeSecret／IOT_HOME_SECRET）`
  - `開放站上的 IoT 輪詢需要 dangerouslyAllowIotOnOpenRelay: true（只允許 E2EE）`

### 5. 安全邊界（ADR 0037 風格）

| 項目 | 預設 | 範圍／夾限 | 需要危險旗標或直接拒絕 | 理由 |
|---|---|---|---|---|
| IoT 整體 | **全關**（ADR 0019） | — | — | 沒選就與 v0.37 逐則相同 |
| 輪詢 E2EE 政策 | **`required`** | `required`／`optional`／`off` | 其他值拒絕 | 預設 relay 只轉送密文 |
| 明文輪詢（`optional`／`off`／任一台 `none`） | 拒絕部署 | — | 需**同時**：自架＋白名單＋`dangerouslyAllowPlaintextIotPolling` | relay 看得到指令與狀態 |
| 明文輪詢在開放站 | 拒絕部署 | — | **不提供開關** | 等於替陌生人保管明文與權杖 |
| 明文輪詢在官方錨點 | 不可能 | — | 錨點是開放站（結構上不成立）＋Cinderous 設定守門 | 違反「中繼只轉發密文」 |
| E2EE 輪詢在開放站（沒有白名單） | 拒絕部署 | — | `dangerouslyAllowIotOnOpenRelay: true` | 元資料與額度暴露給任何人 |
| 政策與設備矛盾（`required`＋`none`、`off`＋`device-key`） | 拒絕部署 | — | 不提供開關 | 不默默改寫設定 |
| `required` 時 relay 持有家庭秘密 | 拒絕部署（Workers）；Node 只在開 B 時允許 | — | — | E2EE 輪詢不需要 |
| E2EE 演算法 | AES-256-GCM | v1 只有 `A256GCM` | 其他 `alg` 回 `invalid: iot-e2ee:` | 設備共同交集 |
| E2EE 時間視窗（`down`） | 60 秒 | 10–300 | — | 設備時鐘以 NTP 校正 |
| E2EE `up` 計數器 | 嚴格遞增 | — | 不遞增的信封 relay 與手機都拒收 | 防重放 |
| 舊金鑰版本寬限 `keyGraceSec` | 86,400 秒 | 0–604,800 | — | 輪換時設備陸續更新 |
| 設備權杖 | 必填 | ≥ 128 位元隨機；只存 SHA-256 | 短於 128 位元直接拒絕 | 權杖＝設備身分 |
| 輪詢週期提示 | 30 秒 | Workers 10–3600；Node 1–3600 | — | 免費額度（研究報告 §2(C)） |
| 狀態本文上限（含信封） | 8 KB | 1–32 KB | — | Shelly 請求上限 8 KB；車道可尋址 32 KB |
| 指令佇列（每台） | 32 | 1–256 | — | 設備離線時的上界；超過丟最舊並記 `dropped` |
| 指令存活 | 30 秒 | 5–300 | — | 重放與「回家後才開門」 |
| 查詢節流（每台） | 5 秒 1 次轉給設備 | 1–300 | — | 其餘直接以 retained 回覆（`throttled`） |
| 區網明文 HTTP（Node） | 只接受 RFC 1918／loopback 來源 | — | 公網來源的明文請求回 403 | ESP8266 只能 HTTP；公網明文會洩漏權杖 |
| 狀態類 kind（25171、25172、31170、31171）的作者 | 開 IoT 時只收設定的閘道公鑰 | — | 關掉要 `stateAuthors: 'any'`（只在 Node 設定檔，不提供部署參數） | 防止偽造設備狀態（§6） |
| 角色名單變更 | 只收 `owner` | — | — | 不放進可合併名單（§2.5） |
| MQTT 匿名 | 不允許 | — | **不提供開關** | 匿名 broker 是最常見的 IoT 事故 |
| MQTT 帳密 | 每台一組 | scrypt 雜湊 | 明文密碼出現在設定檔直接拒絕 | — |
| MQTT 埠 | 1883 | 1024–65535 或 1883／8883 | — | — |
| MQTT 最大封包 | 64 KB | 1–256 KB | — | 擋記憶體濫用 |
| MQTT 連線數 | 64 | 1–1024 | — | — |
| 每台設備發佈速率 | 10／秒 | 1–100 | — | 擋失控韌體 |
| MQTT over WebSocket `/mqtt` | 不開 | — | 開啟時 CLI 警告「反向代理會看到明文」 | Cloudflare 終止 TLS |
| 閘道程序內事件預算 | 600／分 | 60–6,000 | — | 取代每身分 120／分；仍有上界 |
| 閘道 retained 位址配額 | 256 | 16–1,024 | — | 嚴格平面每作者只有 5（`host-config.ts`）；只放寬給設定的閘道公鑰 |
| 心跳 | 60 秒 | 15–600 | — | Cloudflare WebSocket 閒置逾時（經驗值 100 秒） |

**不能做的事**：沒有任何組合能開匿名 MQTT、無權杖輪詢、在開放站或官方錨點收明文輪詢、或關掉閘道的事件預算；`iotMqtt` 在 Workers 上設了就部署前失敗。

### 6. 與既有機制的整合

- **車道（`/app/iot`）**：A 在官方錨點建議走名單上的 `iot` 車道（30 天 retained、64 位址）；不在名單上則落進公用分片（2 小時、16 位址）——`IotClient` 讀 NIP-11 的 `cinder_addressable_ttl_sec` 調整 retained 刷新週期。錨點是否開這條車道由 Cinderous ADR 決定。
- **Node 主機沒有車道、恆為嚴格**（ADR-0366 §決策 8）：IoT 事件走嚴格平面。成員要 NIP-42 AUTH；訂閱以 `authors=[閘道]`＋`#h`／`#t`、或 `#p` 自己表達——兩者都符合 ADR-0123 的範圍規則，不需要放寬。
- **白名單**（ADR 0008／0013）：B／C 的自架站建議只放家人 npub；閘道的程序內注入不經 WebSocket，不受白名單與 4003 影響。
- **中繼端保險：狀態類 kind 只收閘道（kind×作者白名單）**
  - 主要防線仍在客戶端：`IotClient` 只接受 `authors=[閘道]` 且簽章正確的 25171／25172／31170／31171，所以別人簽的「狀態」本來就不會被採信；31170／31171 的位址含作者公鑰，別人也蓋不掉閘道的 retained。
    中繼端保險是**縱深防禦**：擋掉在同一條車道上以 `#h` 灌入的假狀態（雜訊、扇出與儲存配額濫用、粗心的第三方客戶端被騙）。
  - 做法：RelayCore 新增通用選項 `kindAuthors?: Map<number, Set<string>>`——事件的 kind 在表中而作者不在對應集合 ⇒ `OK false "restricted: kind-author: …"`（ADR 0040 新詞元）。
    檢查位置在白名單（ADR 0013）之後、`allowedKinds`（ADR-0048）之前；**以 `event.pubkey` 判斷，不套用 ADR 0028 §7 的「已認證成員的 ephemeral 放行」**——
    這正好補上白名單站的一個縫：已認證的成員（例如 `viewer`）原本可以送任意作者的 ephemeral 25171／25172，開了保險後只有閘道能送。
  - 與 ADR 0013 白名單的關係：白名單是「整站誰能寫」；kind×作者是「某些 kind 只有誰能寫」，兩者**都要**通過，互不取代。沒設 `kindAuthors`＝不檢查（逐則相同的差異測試涵蓋）。
  - 設定來源：
    - B／C（閘道在 relay 程序內）：**開 IoT 就自動**以設定的閘道公鑰填入 25171、25172、31170、31171，不需要額外參數（Node 設定檔可用 `stateAuthors: 'any'` 關掉，只為除錯）。
    - 自架站跑 A（橋接器在外）：`IOT_GATEWAY_PUBKEYS`（`RelaySiteOptions.iotGatewayPubkeys`、CLI `--iot-gateway`）。Workers 上只套用在 `IOT_LANE` 那條車道的 DO（車道層級，`shard.ts` 路由後由該 DO 的 `RelayCore` 選項帶入）；Node 沒有車道，套用全站。
    - **官方錨點不適用**：錨點的 `iot` 車道會有許多家庭、各自的閘道，無法列舉；錨點上只靠客戶端的作者檢查（若日後要做，需要「閘道自我登記」之類的新機制，不在本 ADR 範圍）。
  - 需要的中繼改動：RelayCore 一個選項與一個檢查（約 20 行）、`host-config` 解析 `IOT_GATEWAY_PUBKEYS`（重用 `allowedPubkeysFrom` 的嚴格解析，寫錯一筆就拒絕部署）、Worker 依車道帶入、Node 啟動時由 `iot` 設定推導、`reject-messages` 新詞元與 `classifyRelayMessage`；列入 **P1**。
- **速率預算**（ADR 0043）：成員端 `IotClient` 使用 `sharedRelayEventBudget`；閘道在 A 裡也是一般身分（受 120／分，依 NIP-11 取較小值），在 B／C 裡用 §5 的程序內預算。
- **容量**（ADR 0042）：retained 計入所在 DO 的可尋址天花板；建議 `DO_CEILINGS_MIB` 給 `app:iot` 小天花板（例如 16/16）；Workers 輪詢的指令佇列存在同一顆 DO 的 SQLite（新表 `iot_queue`，計入天花板）。
- **拒收詞元**（ADR 0040）：新增 `blocked: iot-disabled:`（沒開輪詢）、`restricted: iot-token:`（權杖錯誤，HTTP 401）、`restricted: iot-role:`（角色不足；C 的轉送半在 relay 回）、
  `restricted: kind-author:`（狀態類 kind 的作者不是閘道）、`rate-limited: iot:`、`invalid: iot-expired:`（指令過期）、`invalid: iot-e2ee:`（E2EE 設備送明文、明文設備送信封、`alg` 不支援、`kid` 已作廢、`ctr` 不遞增）；
  HTTP 端點回 JSON `{ "error": "<詞元句>" }`，`classifyRelayMessage` 擴充對應分類。
- **NIP-11**：有開才出現 `cinder_iot: { "v": 1, "mqtt": true, "mqtt_ws": false, "polling": { "e2ee": "required", "alg": ["A256GCM"], "plaintext_devices": false }, "gateway": "<hex>", "state_authors_enforced": true, "poll_min_interval_sec": 10, "max_state_bytes": 8192 }`；**不列設備清單、不列埠號**。
- **備援**（ADR 0041）：A 與 B 的閘道可把 retained 與心跳以 `durability.standby` 同時發到第二座 relay（例如官方錨點，只有密文），家中斷網時手機至少看得到最後狀態。

### 7. RelayCore 的最小改動（B、C 需要；`kindAuthors` 也給自架 A 用）

- `core.injectLocal(event)`：程序內產生的事件（閘道已簽章）走與 `EVENT` 相同的驗證、儲存、扇出，但**不經連線的速率與白名單**，改由呼叫端傳入的 `IotBudget` 計數；回傳 `OK` 等價結果。
- `core.subscribeLocal(filters, onEvent)`：程序內訂閱（閘道收「給它的指令與查詢」），不佔 `MAX_SUBSCRIPTIONS`。
- `addressablePerAuthorOverride: Map<pubkey, n>`：只放寬設定的閘道公鑰。
- `kindAuthors: Map<kind, Set<pubkey>>`：§6 的中繼端保險。
- 🔴 契約：四者都沒用到時，RelayCore 對任何輸入的輸出**逐則相同**（以既有的整合測試語料做差異測試）。

### 8. bundle 隔離與守門測試

| 子路徑 | 可以有 | 不可以有 | 守門 |
|---|---|---|---|
| `.`（主入口）、`./protocol`、`./sync`… | — | `./iot` 的閘道、任何 MQTT 程式 | 既有 esbuild metafile 測試加入 `aedes`、`mqtt-packet`、`mqtt` 黑名單 |
| `./iot` | 協定、客戶端、閘道核心、AES-256-GCM 信封（WebCrypto `crypto.subtle`，不加相依） | `node:*`、`aedes`、`mqtt` | 新測試：platform neutral 打包、無外部引用（同 `cloudflare-api-guard`） |
| `./iot/bridge` | `mqtt`（選用 peer） | `aedes` | 新測試 |
| `./relay/worker` 與預打包 `relay-worker-bundle.ts` | `iot-polling`（中立模組；E2EE 模式不需解密內層，只用既有的 NIP-44） | `aedes`、`mqtt-packet`、`node:*` | 既有 `relay-worker-bundle.test.ts` 加黑名單；**bundle 增量上限 12 KB**（minified） |
| `./relay/node` | `iot-mqtt` 以動態 `import()` 載入 | 靜態 import `aedes` | 新測試：沒開 MQTT 時模組圖不含 `aedes`；`aedes` 沒安裝時給清楚錯誤 |
| 設備側參考實作（`examples/iot-devices/`，不進 npm 套件） | Berry 腳本、ESPHome 外部元件、HA 自訂整合 | — | 跨語言測試向量（同一組 key／nonce／AAD／明文 → 密文） |

- 相依策略：`aedes`、`mqtt` 列為 `peerDependencies` ＋ `peerDependenciesMeta.optional`（與 `ws` 為 optionalDependency 的精神一致）；選了 B 才需要安裝。授權：皆為 MIT，與 AGPL-3.0-only 相容。
- Aedes 現況：1.0.0（2026-02-09）～1.2.0（2026-09-16）持續維護、2.0.0-beta 進行中；只支援 MQTT 3.1／3.1.1（MQTT 5 尚未支援）；`engines.node >= 20`。版本以範圍 `^1.2.0` 宣告，2.0 正式後另評估。

### 9. 路線 C′：即時通道（使用者已裁示，2026-10-02）

#### 9.1 定位與理由

- C′ 是 C 的**推送版**：設備主動外連、常駐一條 `wss` 到 relay，relay 有命令就**立刻送下去**（開門、車庫門這類需要即時反應的操作）。
  與 C **共用**設備登錄、權杖、§2.6 設備信封、relay 轉送半、§2.5 角色授權、拒收詞元與 NIP-11；差別只在「命令怎麼到設備」。
- **為什麼在 Workers 上反而比輪詢便宜**（Cloudflare 官方文件，2026-10-02 查證）：
  - 休眠中的 DO 不計 duration（「An idle Durable Object that qualifies for hibernation does not incur duration charges」）；
  - 設備送的 WebSocket **協定層 ping 不收費**（「no charge for … incoming WebSocket protocol pings」），且「Ping/pong handling does not interrupt hibernation」；
  - relay → 設備的訊息是出站訊息，**不收費**；設備 → relay 的訊息以 20:1 折算請求；
  - 真正的成本是**重新連線**（1 Worker 請求＋1 DO 請求）。
  - 試算（研究報告，1 個家庭、每台每日開門 10 次、每 30 分鐘回報）：每台每日約 16.5 個 DO 請求（基準：協定 ping、每日重連 12 次）～198 個（悲觀：應用層心跳照 20:1 計、每日重連 48 次）；
    一般輪詢 30 秒是每台每日 2,880＋2,880。⇒ 免費額度約撐 **500～6,000 台**（C′）對上約 34 台（30 秒輪詢）。
- 傳輸：`ws`（首選）／`longpoll`（備援，§9.3）／`poll`（原 C）；每台設備在登錄中宣告 `transport`。宿主：Workers 與 Node 都可（Node 沒有額度問題）。
- 適用設備：ESP32（ESP-IDF `esp_websocket_client`：`wss`、自訂標頭、協定 ping、自動重連；ESPHome 以外部元件提供）、Node／HA 類設備；
  Shelly Gen2+ 的 Outbound WebSocket 只能走明文轉譯（§9.5）；Tasmota 與官方 ESPHome 沒有 WebSocket 客戶端 → 長輪詢備援；**市售門鎖（Nuki、Yale、SwitchBot 等）一律走路線 A**。

#### 9.2 路由與 DO 分片：每個家庭一顆 DO（裁示 2）

| 路徑 | 誰用 | 協定 | 進哪顆 DO |
|---|---|---|---|
| `GET /iot/v1/home/<homeTag>`（Upgrade） | 手機 | Nostr（NIP-01＋NIP-42），同一套 RelayCore | `iot:<homeTag>` |
| `GET /iot/v1/dev/<homeTag>/<blindId>`（Upgrade，`Authorization: Bearer <權杖>`） | 設備 | C′ 設備幀：JSON `{"t":"cmd"\|"query"\|"ack"\|"state"\|"hb","env":{…§2.6 信封}}` | `iot:<homeTag>` |
| `GET /iot/v1/dev/<homeTag>/<blindId>/next?wait=<秒>` | 沒有 WebSocket 客戶端的韌體 | 長輪詢（§9.3） | `iot:<homeTag>` |
| `POST /iot/v1/dev/<homeTag>/<blindId>/state`、`/ack`；`GET …/commands` | 輪詢／長輪詢設備 | 同 C | `iot:<homeTag>` |

- **為什麼每家一顆**：命令與設備連線在同一顆 DO，不需要 DO 間 RPC（RPC 每次算一個完整請求，不享 20:1）；一家出事不影響別家；休眠喚醒時只需還原自家少量連線。代價：手機每個家庭多一條 WebSocket。
- **防濫建 DO**：任何 `homeTag` 都能 `idFromName` 出一顆 DO ⇒ 自架站以 `IOT_HOMES`（`homeTag` 清單）白名單，Worker 在碰 DO 前就擋（`restricted: iot-home:`）；另套用每 IP 升級限速（與 `APP_LANE_LIMIT` 同型）。
  開放站／官方錨點需要「家庭登記」機制，**不在本 ADR 範圍**（裁示 9：C′ 先只給自架）。
- DO 內**不得**使用 `setTimeout`／`setInterval`、不得掛住任何請求（否則失去休眠）；沿用既有每小時清理 alarm。
- 同一設備 id 只留一條連線（新連線通過權杖驗證後關閉舊連線，並發告警狀態給 `owner`），避免外洩權杖「搶走」命令。

#### 9.3 心跳與長輪詢（裁示 3、8）

- **心跳預設用應用層心跳＋`setWebSocketAutoResponse`**（R0 實測後改定，2026-10-02）：設備每 30 秒送 `{"t":"hb"}`，DO 不被喚醒、由平台自動回 `{"t":"hb-ack"}`；10 秒沒回就判定死線重連。中繼以 `getWebSocketAutoResponseTimestamp` 得到每台設備的最後心跳時間（手機顯示「最後在線」、判斷 `stale`）。WebSocket 協定層 ping 同樣不計費，保留給不方便送應用層訊息的韌體。
  Cloudflare 會在一段時間沒有資料時關閉 WebSocket（官方未給秒數；社群與 Cloudflare `agents` 套件實測約 1–2 分鐘，且**可能不送 close frame**），所以「沒 pong 就重連」是必要條件，不是選項。
  R0 實測（§9.7 實測結果一）：協定 ping 與自動回覆**都不計請求、不喚醒 DO**；**沒有設定自動回覆**的應用層心跳每一則都喚醒 DO、Analytics 記 1 個請求——所以自動回覆字串必須與設備送的心跳**逐位元組相同**，否則會悄悄變成每則計費。
- **長輪詢只做「Worker 掛住、DO 不掛」**：Worker 收到 `…/next?wait=` 後，自己對 `iot:<homeTag>` 開一條休眠式 WebSocket 等命令（DO 以 `acceptWebSocket` 收、可休眠），有命令或到期（`wait` 夾 10–50 秒，預設 45）就回應。
  Workers 免費方案「No charge for duration」，DO 休眠不計 duration；每輪成本＝1 Worker 請求＋1 DO 請求（每台每日約 1,700＋1,700，約撐 55 台）。
  **只給沒有 WebSocket 客戶端的韌體（Tasmota ESP32 Berry、官方 ESPHome `http_request`）作備援**；這個組合未經實測，列入 R0 PoC。
- **DO 端掛住請求的長輪詢、與 DO 持有串流的 SSE 都不做**（§4 的 duration 說明）。SSE 也因 Shelly／ESPHome／Tasmota 讀不了串流而不做。

#### 9.4 與 kind 的對應、ack 與逾時、離線不延遲

| 事件 | C′ 的流向 |
|---|---|
| 25170 操作 | 手機 → DO（轉送半依角色授權、剝外層 NIP-44）→ `ws.send` 設備幀 `cmd`；**設備沒有連線 ⇒ 立刻回 25171 `offline`，即時等級不排隊** |
| 25171 ack | 設備幀 `ack`（`up` 信封）→ DO 包 NIP-44 給下命令的成員；新增 status：`offline`、`stale`（連線存在但心跳過期）、`delivered`（已寫進連線、尚未收到設備 ack，可選） |
| 25172 即時狀態 | 設備幀 `state` → 全家（ephemeral，不落庫）；查詢回覆帶 `e` |
| 25173 查詢 | 手機 → DO → 設備幀 `query`；節流同 §2.2 |
| 31170 retained | 只在設備回報的值**真的變了**且節流後寫入（每台預設 ≥ 5 分鐘一次）——SQLite 每日 10 萬列寫入是最可能先到頂的額度 |
| 31171 閘道心跳 | C′ 的閘道就是 DO 本身，不發 31171 |

- **設備在線與否不落庫**：那是線上狀態，依 Cinderous「中繼不持久化線上狀態」原則，relay 收到查詢時以 `getWebSockets()` 即時回答（`iot.deviceLink()`），不寫進 31170／SQLite。
- **即時等級命令（裁示 5）**：`ttlSec` 預設 **15**（夾 5–60）；手機等 ack 預設 5 秒，逾時顯示「**結果未知**」（不是「失敗」）並自動送一次 25173 查詢實際狀態；只在 ttl 內以同一 `msgId` 重送（設備去重、冪等），ttl 到就停。
- **離線命令不可延遲執行**：25170 是 ephemeral 不落庫；C′ 不為即時等級排隊；設備端以 `ts` 視窗（門類 ±15 秒、一般 ±60 秒）＋`expiration` 再擋一次——relay 即使惡意延遲轉送，超過視窗也會被丟棄。
  設備開機到 SNTP 同步前**拒絕所有命令**（fail-closed）。
- 分級：

| 等級 | 例子 | 通道 | ttl |
|---|---|---|---|
| 即時 | 門、車庫門、警報解除 | C′ `ws`；沒有 WS 客戶端的退回 `longpoll` | 15 秒，不排隊 |
| 一般 | 燈、插座、窗簾 | `ws` 或 30–60 秒 `poll` | 30–60 秒，可排隊 |
| 遙測 | 溫濕度、電表 | 只 `POST state`（變化觸發＋節流） | — |

#### 9.5 安全補充（裁示 6、7）

- **`operatorSecret`（門鎖類預設啟用，其他類型可選）**：C／C′ 的角色檢查在 relay，持有家庭秘密的 `viewer` 做得出解得開的內層信封，只是被 relay 拒絕——等於授權完全信任 relay。
  設備登錄標 `class: 'lock'`（門、門鎖、車庫門、門禁）時，`down` 方向金鑰改由**只發給 operator／owner** 的 `operatorSecret` 導出：
  `deviceKeyDown(id, epoch) = HKDF(operatorSecret, salt="", info="cinder-iot/v1/device-key-down|" + id + "|" + epoch, 32)`；`up` 方向仍用 `deviceKey`（全家可讀狀態）。
  ⇒ 「viewer＋被攻破的 relay」也開不了門。發放沿用 ADR 0028 配對（owner 選 operator／owner 角色時才交付）；撤銷 operator＝輪換 `operatorSecret`＝重寫該類設備的 `down` 金鑰。其他類型可在設備登錄以 `operatorSecret: true` 選用。
- **Shelly Outbound WebSocket 明文轉譯（只限自架＋白名單＋危險旗標）**：Shelly Gen2+ 可設定 `Ws.SetConfig { server: "wss://…" }` 外連，relay 可反向呼叫 RPC（`Switch.Set` 等）——是真正的推送，但 RPC 為明文 JSON。
  與明文輪詢同三條件：自架站、`ALLOWED_PUBKEYS` 白名單、`dangerouslyAllowPlaintextIotPolling: true`；開放站與官方錨點**不提供開關**。Shelly 的權杖只能放 URL（會進存取記錄）、是否自送 ping、`NotifyStatus` 頻率（吃 20:1 額度）均**待實機查證**。
- 連線層只靠權杖（relay 不持有設備金鑰，無法驗以設備金鑰做的挑戰）；真正的防線是 §2.6 信封：冒牌連線收得到密文但解不開，偽造的回報在手機端 GCM 驗證失敗。
- 設備參考實作必須驗證伺服器憑證（ESP-IDF 憑證包；`esp_websocket_client` 不給 `cert_pem` 時預設**不驗證**，參考實作要強制開）；不得釘單一 CA（Cloudflare 邊緣憑證可能來自多家 CA 並輪換）。

#### 9.6 SDK API 與設定草案

```ts
// 手機端（IotClient 擴充）
const r = await iot.command('home/door/open', 'PULSE', {
  urgency: 'realtime', ttlSec: 15, ackTimeoutMs: 5000, confirmed: true,
});
// r.status: 'ok' | 'rejected' | 'not-allowed' | 'offline' | 'stale' | 'unknown' | 'quota' | 'relay-rejected'
// 'unknown'＝逾時沒有 ack；SDK 自動送一次 query，結果放在 r.after。'quota' 見 §10。

const link = await iot.deviceLink('door');  // { transport, online, lastHeartbeat? }（relay 即時回答，不落庫）

// 設備端（新子路徑 ./iot/device，中立；Node／HA／瀏覽器型設備與測試用）
import { connectIotDevice } from '@cinderous/client/iot/device';
const dev = connectIotDevice({
  url: 'wss://relay.example/iot/v1/dev/<homeTag>/<blindId>', standbyUrls: [],   // §10.4
  token, deviceKey, deviceKeyDown, kid: 'door.0',
  heartbeat: { mode: 'protocol', intervalSec: 30, timeoutSec: 10 },
  maxSkewSec: 15, counterStore,
  onCommand: async (cmd) => ({ status: 'executed', state: { 'home/door/lock': 'UNLOCKED' } }),
  onLinkState: (s) => { /* 'connected' | 'reconnecting' | 'quota-exhausted' | 'relay-error' | 'network-down' */ },
});
```

relay 端（兩宿主共用驗證）：`iot.realtime: { enabled, homes, transports: ['ws','longpoll'], heartbeat: { mode: 'protocol'|'app'|'both', intervalHintSec: 30 }, longPollMaxSec: 45, realtimeTtlMaxSec: 60, maxDevicesPerHome: 64, singleConnectionPerDevice: true, quota: {…§10} }`；
`RelaySiteOptions.iotRealtime`、CLI `--iot-realtime`、NIP-11 `cinder_iot.realtime: { "ws": true, "longpoll": true, "heartbeat_sec": 30 }`；拒收詞元新增 `restricted: iot-home:`、`blocked: iot-device-offline:`、`rate-limited: iot-quota:`。

#### 9.7 C′ 分階段

| 階段 | 內容 | 工作量 |
|---|---|---|
| **R0 PoC（先做）** | 測試用 Cloudflare 帳號（部署帶 `CLOUDFLARE_ACCOUNT_ID`）：72 小時量測閒置切斷秒數、協定 ping 與應用層自動回覆在 GraphQL Analytics 的請求計數、平台重連頻率、「Worker 掛住＋休眠 WS」長輪詢的穩定性與 DO duration；**刻意耗盡一次免費額度**，記錄 §10 各情境的實際回應與既有連線行為 | 2–3 天 |
| R1 | 兩宿主路由 `iot:<homeTag>`、設備 WS 端點、權杖、單一連線、設備幀、轉送半接 §2.6、`offline`／`stale`、心跳、`IOT_HOMES`、拒收詞元、§10 結構化額度回應與預算計數；差異測試（沒開時逐則相同） | 4–6 天 |
| R2 | `IotClient` 的 `urgency`／`ttlSec`／`unknown→query`／`quota`、`deviceLink`；`./iot/device`；`operatorSecret`；NIP-11、`RelaySiteOptions`、CLI | 2.5–3.5 天 |
| R3 | 設備參考實作：ESP-IDF／ESPHome 外部元件（wss＋憑證包＋AES-GCM＋SNTP fail-closed＋計數器＋§10 退讓）、HA／Python；跨語言向量 | 3–5 天 |
| R4 | 長輪詢（Worker 掛住、DO 不掛）給 Tasmota Berry／ESPHome | 2–3 天 |
| R5 | Shelly Outbound WS 明文轉譯（自架＋白名單＋危險旗標） | 2–3 天 |
| **合計** | | **約 15.5–23.5 天**；若 P2（C 與 §2.6 信封）已完成，R1／R3 可省 2–3 天。建議 R0 → R1 與 P2 合併進行（C′ 在 Workers 上比 C 便宜） |

**R0 PoC 已備妥（尚未實測，2026-10-02）**：`poc/iot-realtime/`（獨立目錄，不進 `src/`／`dist`、不在套件 `exports`）。
內容：最小 Worker＋每個家庭一顆 DO（`iot:<homeTag>`，Hibernation API；設備／手機／長輪詢／除錯端點照 §9.2；協定 ping 與 `setWebSocketAutoResponse` 兩種心跳以 `HB_AUTO_RESPONSE` 切換；
DO 自己的近似用量計數與 80／95／100% 家庭預算；Worker 捕捉 DO 超量例外改回 503＋`Retry-After`＋`Cinder-Relay`／`Cinder-Quota`），
以及 `devices.mjs`（§10.2 分類與退讓）、`phone.mjs`、`exhaust.mjs`（需 `--i-understand-this-burns-quota` 與帳號二次確認）、`report.mjs`、`usage.mjs`（GraphQL Analytics）。
本機以 `wrangler dev` 驗證過程式路徑（命令往返、兩種心跳、模擬的 503、家庭預算 4429）；Q1–Q4 的計費與斷線數字待使用者提供測試帳號後依該目錄 README 實測，結果再回填本節。PoC 沒有端到端加密。


**R0 實測結果（一）：心跳計費與平台斷線（2026-10-02，測試帳號，Cloudflare 免費方案）**

三組各 2 小時、10 台設備、30 秒心跳、不送命令；DO 請求取自 GraphQL Analytics（`durableObjectsInvocationsAdaptiveGroups`），升級數與喚醒數取自 PoC 的 `/debug`。

| 組 | 心跳 | DO 請求 | 其中升級（10 台初次＋重連） | 進站 WS（DO 端計） | 平台斷線（每台每日） | DO GB-s |
|---|---|---|---|---|---|---|
| A | 協定 ping | 37 | 17 | 0 | 8.4 | 0.03 |
| B | 應用層＋`setWebSocketAutoResponse` | 53 | 30 | 0 | 24.0 | 0.05 |
| C（對照） | 應用層、不自動回覆 | **2,428** | 20 | 全部喚醒 DO | 12.0 | 0.61 |

結論：

1. **協定 ping 與應用層自動回覆都不計請求、不喚醒 DO**（A、B 扣掉升級與除錯呼叫後同樣只剩約 20 個背景請求，跟心跳數無關）。研究報告的「悲觀值（自動回覆照 20:1 計）」不成立。
2. **沒有自動回覆的應用層心跳，Analytics 每一則都記 1 個 DO 請求**（C：2,400 次心跳 → 約 2,400 個請求，不是 20:1 的 120）。20:1 是否只在帳單上折算、免費額度看哪個數字，官方仍未寫明；**容量試算一律以 Analytics 的原始數字保守計算**。
3. **平台斷線每台每日約 8–24 次，絕大多數沒有 close frame（1006）**；C 組有 4 次 1001（going away）。60 分鐘內斷的占多數，期間沒有任何一次 pong 逾時——斷線都是 TCP 層直接收到，設備端的重連邏輯必須存在，但這次沒有觀察到「靜默掛著」的情況。
4. **容量重估（保守）**：每台每日約 45–65 個 DO 請求（重連＋背景）＋每則設備上行訊息 1 個；每天 10 次開門、每 30 分鐘回報狀態約再加 60 ⇒ 每台每日約 105–125 ⇒ 免費 10 萬 DO 請求約可撐 **800–950 台**；不回報狀態只收命令約 **1,500 台**。Workers 請求每台每日約 22–32，不是瓶頸。
5. 延遲（冒煙測試，台灣→Cloudflare）：命令往返 p50 約 290 ms、p99 約 440 ms。

裁示 3 的後續（是否改預設心跳）見〈使用者裁示〉；實驗 2、4、3 的結果見下方〈R0 實測結果（二）〉〈（三）〉〈（四）〉。

**R0 實測結果（二）：72 小時平台斷線與閒置切斷（2026-10-02 23:25 → 10-05 23:25 台灣時間，測試帳號，Cloudflare 免費方案）**

- **2a**：家庭 1，10 台設備，**新預設心跳**（應用層 `{"t":"hb"}`＋`setWebSocketAutoResponse`，每 30 秒，10 秒沒回就判定死線重連），連續 72 小時，不送命令。
- **2b**：同時在家庭 2 跑 12 小時，6 台設備，探測閒置切斷：每輪停送心跳 30–900 秒，再用一次 ping 確認連線還活著。
- DO 請求與 Workers 請求取自 GraphQL Analytics。為了把 2b 的影響分開，分成兩段查詢：前 12 小時（2a＋2b 同時跑）與後 60 小時（只有 2a）。

| 項目 | 2a（10 台 × 72 小時） | 2b（6 台 × 12 小時） |
|---|---|---|
| 平台斷線 | 254 次＝**每台每日 8.47 次**；全部 1006（沒有 close frame） | 25 次＝每台每日 8.33 次；全部 1006 |
| 本端判死（pong 逾時） | **12 次＝每台每日 0.4 次**（靜默掛著，必須靠心跳逾時才發現） | 0 |
| 連線維持時間 | p50 53 分鐘、p90 6.2 小時、p99 27 小時、最長 27.5 小時（超過 24 小時的有 7 次） | （受閒置探測打斷，不具代表性） |
| 閒置切斷 | — | **15 分鐘內沒有閒置切斷**：閒置 900 秒的 84 次中 7 次被關（8.3%），全部是先收到 1006、沒有一次是「靜默不回 pong」；與每台每日 8.3 次的隨機斷線率換算出的機率（1−e^(−8.33×900/86400)≈8.3%）一致 |

| 用量（Analytics） | 前 12 小時（2a＋2b） | **後 60 小時（只有 2a）** | 72 小時合計 |
|---|---|---|---|
| DO 請求 | 2,049 | **408＝每台每日約 16** | 2,457（免費額度 2.46%） |
| Workers 請求 | 1,050 | 121＝每台每日約 5 | 1,171 |
| 進站 WS 訊息（喚醒 DO 的） | 0 | 0 | 0 |
| DO GB-s | 4.0 | 25.0 | 29.0（0.22%） |

前 12 小時的 2,049 個 DO 請求，絕大部分來自 2b 的閒置探測：它反覆停送心跳、改送需要喚醒 DO 的探測，再重新連線，不代表正常設備的用量。

結論：

1. **新預設心跳在 72 小時內維持零計費**：自動回覆的心跳一則都沒有喚醒 DO（進站 0）。結果（一）的結論在長時間下成立。
2. **平台斷線約每台每日 8.5 次，全部是 1006**：比結果（一）的 8–24 次範圍更低、更穩定。連線維持中位數約 1 小時，但長尾可以超過一天。
3. **確實存在「靜默掛著」**：每台每日約 0.4 次。這在結果（一）的 2 小時實驗裡沒看到，72 小時才出現。所以**設備端的心跳逾時判死（10 秒）是必要的**，不能只靠 TCP 斷線通知。
4. **沒有閒置切斷**：15 分鐘內看不到平台因閒置而切斷，被關的比例完全可以用隨機斷線率解釋。心跳 30 秒的目的是**及早發現**靜默掛著，不是防止閒置切斷。之後若要省電，可以評估把心跳拉長（例如 60–120 秒），代價是發現死線的時間變長。
5. **容量重估（取代結果（一）第 4 點的保守值）**：
   - 只連線不送訊息時，每台每日約 16 個 DO 請求，主要是重連時的升級。
   - 每天 10 次開門（每次 2 個：手機送出＋設備 ack，見結果（三）第 4 點）＋每 30 分鐘回報狀態（48），合計每台每日約 16＋20＋48＝84 ⇒ 免費 10 萬 DO 請求約可撐 **1,200 台**（2026-10-07 更正：原寫 76／1,300 台，漏算 ack）。
   - 不回報狀態、只收命令（每日約 10 則）時約 16＋20＝36 ⇒ 約 **2,800 台**（2026-10-07 更正：原寫 26／3,800 台）。
   - Workers 請求每台每日約 5，不是瓶頸。
6. Analytics 的 DO `errors`（72 小時 1,224）與 1006 斷線、升級後的連線關閉同時出現，屬於 WebSocket 連線結束時的計數方式，不是程式錯誤；沒有任何 Workers 錯誤。

原始紀錄（只在本機，`logs/` 不進版控）：`poc/iot-realtime/logs/exp2/`（`devices-72h.jsonl`、`idle.jsonl`、`usage.jsonl`、`usage-split.jsonl`、`debug.jsonl`），報告用 `node scripts/report.mjs` 產生。

**R0 實測結果（三）：命令延遲與 DO 休眠喚醒（2026-10-06 07:31 → 08:33 台灣時間，測試帳號，Cloudflare 免費方案）**

**設定**：
- 3 台設備，用新預設心跳（應用層＋自動回覆）。
- 手機每 2 分鐘送一發開門命令，**冷**：前一次活動後已閒置約 2 分鐘，DO 已休眠；1 秒後緊接著送第二發，**暖**：DO 醒著。共 1 小時、30 組。
- 手機與設備都是同一台電腦（台灣，家用網路）上的模擬程式，量的是「電腦 ↔ Cloudflare 邊緣 ↔ DO」的往返，**不含真實手機的行動網路**。

| 項目 | p50 | p90 | p99 | 最大 |
|---|---|---|---|---|
| 往返：冷（從休眠喚醒） | 394 ms | 442 ms | **483 ms** | 483 ms |
| 往返：暖 | 385 ms | 433 ms | **453 ms** | 453 ms |
| 手機 → DO 回 delivered | 192 ms | 246 ms | 280 ms | 280 ms |

- 60 個命令全部 `executed`，**`unknown`（5 秒沒有 ack）0 次**；1 小時內平台斷線 0 次。
- **確實有休眠**：`/debug` 的 `wakes` 在 UTC 午夜歸零後的 33 分鐘內是 18，約每組一次。也就是每 2 分鐘的第一發都是把 DO 從休眠喚醒，第二發沒有再喚醒一次。
- 用量：DO 請求 132，60 個命令 × 2（手機送出、設備回 ack）＋連線與除錯；Workers 請求 6；DO GB-s 0.06。

結論：

1. **達到「即時開門」**：冷 p99 483 ms（門檻 2 秒）、暖 p99 453 ms（門檻 1 秒），沒有任何結果未知的命令。
2. **從休眠喚醒的代價幾乎可以忽略**：冷、暖 p50 只差約 9 ms，p99 差約 30 ms。休眠的 DO 被 WebSocket 訊息喚醒時不需要重建連線，不必為了延遲而讓 DO 保持清醒，也不必加任何 keep-alive。
3. **往返約 0.4 秒，大部分是網路路徑**：手機 → DO 單程約 0.2 秒，與冒煙測試（p50 約 290 ms）同一量級。實際的手機加上行動網路會再多出行動網路的延遲，等 App 實作後再實機量測。
4. **每個命令 2 個 DO 請求**（手機上行＋設備 ack）。結果（二）第 5 點原本只算 1 個，已於 2026-10-07 更正為 1,200／2,800 台。

**R0 實測結果（四）：耗盡額度（2026-10-06 19:57 → 10-07 09:10 台灣時間，測試帳號，Cloudflare Workers 免費方案）**

**設定**：
- 測試帳號，**已確認是 Workers 免費方案**：儀表板 Observability 頁顯示「free plan with 200K events per day」。
- 長時間觀察：家庭 1，10 台設備（新預設心跳），手機每 60 秒送一個命令，從 20:14 連續跑到隔天 09:10，跨過 08:00（UTC 00:00）的額度重置。
- 另有一個程式每 5 分鐘以 HTTP 探測 `/poc/noop` 與 `/debug`。

| 階段 | 做法 | 結果 |
|---|---|---|
| **3a 家庭預算** | `HOME_DAILY_REQUESTS=300`，對家庭 1 灌 WS 訊息 | ✅ **照設計運作**：240／300 推 `warn`、285 推 `shed`、300 推 `exhausted`，並在同一秒以 **4429 `iot-quota:<重置時間>`** 關閉設備與手機的連線（帶 close frame） |
| 3b DO 請求 | 家庭預算關閉，對家庭 2 灌 WS 訊息共約 221 萬則（約 3 小時，到 23:05） | Analytics 的 DO 請求 **2,215,490**（每則 WS 訊息計 1，見結果（一）第 2 點），以官方 20:1 折算約 **110,800（110.8%）**；**HTTP 探測從頭到尾都是 200，沒有任何 DO 超量錯誤** |
| 3c Workers 請求 | 以每秒約 200 個請求打 `/poc/noop`，共 110,000 個 | Workers 請求 **110,968（111%）**，**全部 204、錯誤 0**，儀表板 Errors 也是 0；**沒有出現文件說的 1027** |

**長時間觀察的設備與命令**（家庭 1，不是被灌的家庭）：

| 時段（台灣） | 平台斷線（每台每日） | 命令 |
|---|---|---|
| 20:14–23:06（灌額度期間） | 31 | 174／174 executed |
| **23:00–05:00** | **約 70–150** | **大約四成失敗**：`unknown` 105、`offline` 114；pong 逾時 10 次 |
| 05:00–08:00 | 0–17 | 全部 executed |
| 08:00 之後（UTC 重置後） | 8.2（回到結果（二）的水準） | 69／69 executed |

**結論**（有兩點無法判定，照實記錄）：

1. **免費方案的每日上限沒有在當天被硬性執行**：Workers 到 111%、DO 依 20:1 折算到 111%，都**沒有回任何錯誤**（沒有 1027，也沒有 DO 超量例外），短 HTTP 請求一路正常。
   - **無法判定一**：是「當天不即時擋」，還是「有約 10–20% 的寬限、而我們剛好停在 111%」。兩邊剛好都停在 110% 左右，是因為腳本送到預設上限就停了。要分辨，需要再推到 150–200% 以上；那會影響同帳號的其他服務，需要使用者另外同意，這次不做。
2. **灌完之後，長時間連線的 WebSocket 出現約 6 小時的嚴重退化**（23:00–05:00），之後在 05:00 自行恢復，**早於** 08:00 的重置。
   - **無法判定二**：成因可能是 Cloudflare 對超量帳號的軟性限制，例如較積極地關閉 DO 的 WebSocket；也可能是這台電腦的網路問題。04 點那小時有 66 次 `ENOTFOUND`，是**本機 DNS 解析失敗**，至少那一段是本機網路的問題。缺少另一個網路或另一個帳號的對照組，無法區分。
   - 退化期間的 HTTP 探測（每 5 分鐘，共 80 次）全部正常，只有長時間連線的 WS 斷得兇；手機看到的現象是「設備離線」或「命令結果未知」。
3. **對設計的影響**：
   - **不能依賴 Cloudflare 在 100% 準時擋下**，也不能依賴它擋下時給出可辨識的錯誤。§10 的保護必須以**我們自己的家庭預算**為第一道防線：3a 已驗證會依序預警並以 4429 帶重置時間關閉，設備據此睡到重置時間，不會狂重連。
   - 帳號層級的超量，除了「回 503 `Cinder-Quota`」這條路（這次沒觸發到），還要能應付「沒有錯誤、只是連線變差」：手機以 `offline`、`unknown` 和設備最後心跳時間呈現，不能假設送出就一定送達。
   - DO 請求在 Analytics 是每則 WS 訊息計 1，但免費額度的執行看來不是照這個數字：2,215% 都沒被擋。容量試算維持結果（二）的保守值，實際上限可能更寬。
4. 3b 第一次執行時，腳本把一次普通的 1006 斷線當成「額度用完」而提早停止；之後改用 `--keep-burning` 補跑。報告時要注意這個誤判條件。

原始紀錄（只在本機）：`poc/iot-realtime/logs/exp3/`（`timeline.txt`、`3a-*`、`3b*-exhaust.jsonl`、`3c-exhaust.jsonl`、`devices-exhaust.jsonl`、`phone-exhaust.jsonl`、`probe.txt`、`usage*.jsonl`）。實驗後已把 `HOME_DAILY_REQUESTS` 部署回 20000。

### 10. 免費額度用完時：設備感知、預警、App 呈現與降級（使用者已裁示，2026-10-02）

#### 10.1 Cloudflare 的行為（2026-10-02 查證；「官方」＝官方文件原文，「觀察」＝社群／第三方回報）

| 情境 | 行為 | 依據 |
|---|---|---|
| Workers 免費每日 100,000 請求用完 | 回 **Error 1027**（「Worker exceeded free tier daily request limit」）；路由模式可選 **Fail open**（略過 Worker，當作沒有 Worker）或 **Fail closed**（回 1027 錯誤頁，「Use this for security-critical Workers」）；**UTC 午夜重置** | 官方：Workers Limits、Errors |
| 1027 的 HTTP 狀態碼 | 官方未寫。觀察：**HTTP 429**、本文 `error code: 1027`（rancher/rke2 #11326，2026-09-29） | 觀察 |
| Worker 額度用完時 Worker 程式 | **不會執行**——relay 無法自訂回應、無法捕捉 | 由上推得 |
| 既有 WebSocket 與 Worker 額度 | 「WebSocket messages routed through a Worker do not count as requests」——已建立的連線不再消耗 Worker 請求；**新連線（含重連）會被 1027 擋** | 官方：Workers Pricing |
| DO 免費額度（每日 100,000 請求、13,000 GB-s、SQLite 寫 100,000 列／讀 500 萬列）用完 | 「If you exceed any one of the free tier limits, further operations of that type will fail with an error」；「Daily free limits reset at 00:00 UTC」 | 官方：DO Pricing |
| DO 超量的錯誤文字 | 觀察：`Exceeded allowed volume of requests in Durable Objects free tier`、`Exceeded allowed duration in Durable Objects free tier`，在 Worker 端 `stub.fetch` 拋出，未捕捉時成為 HTTP 500 | 觀察（andtii/agentic PR #352 等） |
| SQLite 寫入列用完 | 只有寫入失敗（讀仍可）——retained 更新失敗，即時轉送不受影響 | 官方「operations of that type」推得 |
| **休眠中的既有 WebSocket 在 DO 超量時** | **官方未寫**。推論：連線留在邊緣（休眠時「WebSocket clients remain connected」），但設備送來的訊息與手機的命令都需要喚醒 DO（＝一個請求）而失敗 ⇒ **連線看起來還在，命令卻送不到**；會不會被關閉、以什麼 close code 關閉，**待 R0 PoC 實測** | 推論 |
| 重置延遲 | 觀察：有回報 DO 額度在 00:00 UTC 後仍被擋一段時間（Cloudflare Community，2026-09-28） | 觀察 |

⇒ **結論：設備「部分」感知得到。** Worker 額度用完時，**重連**會收到 429／1027（可辨識）；但**已連線的設備不會因此被斷**，DO 額度用完時甚至可能維持「看似在線、實則收不到命令」。所以設備端不能只靠 HTTP 狀態碼，必須搭配應用層存活檢查，而 relay 端要在耗盡前主動預警與分流。

#### 10.2 設備端：如何分辨「額度用完」與「中繼故障／網路斷」

relay 自己產生的回應**一律**帶標頭 `Cinder-Relay: 1` 與 JSON 本文 `{"error":"<詞元句>", …}`（ADR 0040 詞元），所以 Cloudflare 平台產生的錯誤與 relay 的錯誤可以分開。

| 觀察到的現象 | 判定 | 設備動作 |
|---|---|---|
| 升級或 HTTP 回 **429** 且本文含 `1027`（沒有 `Cinder-Relay`） | `quota-exhausted`（Workers 帳號額度） | 停止重連，**睡到下一個 UTC 00:00＋隨機 0–20 分鐘**；時鐘未同步時改為每 60 分鐘探測一次 |
| **503**＋`Cinder-Relay: 1`＋`Cinder-Quota: do-requests\|do-duration\|sqlite-writes\|home-budget`＋`Retry-After`＋`{"error":"rate-limited: iot-quota: …","reset":<unix 秒>}` | `quota-exhausted`（DO 額度或本家預算，§10.3） | 依 `Retry-After`／`reset`，加隨機 0–20 分鐘 |
| WebSocket close code **4429**，reason `iot-quota:<reset unix 秒>` | `quota-exhausted`（relay 預先分流） | 同上 |
| 已連線，但協定 ping 10 秒沒 pong，或連續 2 個命令／查詢窗口都沒有任何下行（應用層心跳模式下 `hb` 無回應） | 連線已死（可能是 DO 額度用完，也可能是靜默斷線） | 斷線重連；**重連的回應**才決定是哪一類（第一、二列 → 額度；其餘照下） |
| 401／403＋`restricted: iot-token:`、404＋`blocked: iot-disabled:`、`restricted: iot-home:` | `config-error` | 不再快速重試；每 60 分鐘探測一次；設備指示燈／狀態顯示「設定錯誤」 |
| 其他 5xx（500／502／503 無 `Cinder-Quota`、520–527、本文 `error code: 1101`／`1102`） | `relay-error` | 指數退避 5 秒 → 10 分鐘上限，±30% 抖動 |
| DNS、TCP、TLS 失敗；連不上預設閘道 | `network-down` | 指數退避 1 秒 → 60 秒上限，±30% 抖動 |

**避免重連風暴把隔天額度也燒掉**：

- 參考實作**關掉** `esp_websocket_client` 的固定 10 秒自動重連（`disable_auto_reconnect`），改用上表的排程器；任何狀態下兩次連線嘗試間隔不得小於 1 秒，且 `quota-exhausted` 期間每台每小時最多探測 1 次。
- 估算：100 台設備在額度用完的 16 小時內每小時探測一次＝1,600 次嘗試；若改用預設 10 秒重連＝576,000 次——後者在 DO 超量時每次都會先吃一個 Worker 請求，足以把 Worker 額度也燒光、並在午夜重置後的第一分鐘再造成尖峰。
- 重置時**分散重連**（0–20 分鐘隨機），並尊重 `Retry-After`；relay 也在午夜後的前 20 分鐘對每個家庭的新升級套用較嚴的每 IP 限速。
- 1027 擋下的請求是否仍計入額度官方未寫（推論不計，因為 Worker 沒執行）；DO 超量時 Worker 有執行、**會**計入 Worker 請求——這正是要退讓的理由。

#### 10.3 relay 端：耗盡前預警與結構化回應

1. **每個家庭 DO 自己計數（近似值）**：DO 在記憶體累計本 UTC 日的計費近似值（升級／HTTP＝1、進站 WS 訊息＝1/20、alarm＝1、SQLite 寫入列），每 64 次增量或在 alarm 時才寫回一次（避免計數本身吃寫入額度），跨 UTC 午夜歸零。
   設定 `iot.realtime.quota.homeDailyRequests`（自架預設：帳號每日 100,000 ÷ 預期家庭數 × 0.5，留一半給 relay 其他流量）：
   - **80%**：對該家 `owner` 發一則預警（ephemeral 25172，`d`＝blind("sys:quota")，加密給全家，內容 `{ state: 'warn', used, limit, reset }`）。
   - **95%（分流）**：拒絕新的 `poll`／`longpoll` 與遙測 `POST state`（回 503 結構化），**只保留即時等級設備與手機的命令路徑**。
   - **100%**：新升級回 503 結構化；既有連線送 close 4429 後關閉（讓設備進入額度退讓，而不是卡在「看似在線」）。
   這是每顆 DO 的局部近似，**不知道整個帳號的用量**；它保護的是「一個家庭不要燒光整個帳號」。
2. **Worker 捕捉 DO 超量例外**：`stub.fetch` 拋出的錯誤若符合 `/Exceeded allowed (volume|duration)/`（文字比對脆弱，另以「DO 呼叫失敗且非 4xx」為通用備援），Worker 改回
   **503**＋`Retry-After: <到下一個 UTC 00:00 的秒數>`＋`Cinder-Relay: 1`＋`Cinder-Quota: do-requests|do-duration`＋JSON `{"error":"rate-limited: iot-quota: …","reset":<unix>}`，升級請求同樣回 503（不回 101）。
3. **Workers 1027 無法攔截**（Worker 沒執行）：自訂網域路由建議設定 **Fail closed**（Fail open 會把請求送到不存在的源站，且對安全關鍵 Worker 官方建議 Fail closed）；workers.dev 子網域是否提供此選項官方未寫，待 PoC 確認。
4. **帳號層級預警（選用，只給自架）**：Cron Trigger（例如每 30 分鐘）以唯讀 Analytics API 權杖查 GraphQL Analytics（Workers 與 DO 的當日請求、duration），超過門檻時把狀態寫入一個小設定（例如 KV，每日寫入極少），Worker 以 isolate 內快取（60 秒）讀取並據以提前分流。
   Cron 的觸發是否計入每日請求、Analytics 的延遲，以官方為準並在 PoC 量測；權杖以 Worker secret 保存。
5. NIP-11 `cinder_iot.quota: { "state": "ok"|"warn"|"shed"|"exhausted", "reset": <unix> }`（只有開 C′ 才出現；NIP-11 本身也是一個 Worker 請求，App 不得高頻輪詢它）。

#### 10.4 手機 App 的呈現

- 三種狀態**分開顯示**，不可都寫成「連線失敗」：
  - 「中繼今日額度已用完，預計 **08:00（台灣時間）** 恢復」——由 `reset`（UTC 00:00）換算本地時間；
  - 「中繼暫時故障，重試中」（`relay-error`）；
  - 「設備離線」（`offline`／`stale`，中繼正常）。
- `IotClient.command()` 回 `status: 'quota'`（附 `reset`）；即時等級設備的按鈕在 `quota` 期間停用，並顯示該設備登錄的**本地開啟方式**（§10.5 的 `localFallback`，例如「請使用實體鑰匙或門邊密碼鍵盤」）。
- 80% 預警只給 `owner`（橫幅：「本日中繼額度已用 80%，接近上限時遙測與輪詢設備會先暫停」）。
- **備援中繼**（ADR 0041 `standby`）：若設定了**另一個 Cloudflare 帳號**或家中 Node relay 的備援站（同帳號的另一個 Worker 沒用——額度以帳號計），`IotClient` 與設備（`connectIotDevice({ standbyUrls })`）在 `quota-exhausted` 時自動切換；
  備援站須以同樣的 `homeTag`、權杖雜湊與設備登錄部署。E2EE 金鑰（`deviceKey`、`operatorSecret`）與 relay 無關，切換不影響加密。不得因為額度不足自動降級到明文或任何第三方通道。

#### 10.5 安全要求（門鎖類設備，強制）

1. **必須保留不依賴 relay、不依賴網際網路的開啟方式**（實體鑰匙、門內機械把手、密碼鍵盤、區網或藍牙控制、門邊按鈕擇一以上）。遠端開門只是**便利功能**，不是唯一手段。
   設備登錄 `class: 'lock'` 時 `localFallback`（`'key'|'keypad'|'lan'|'ble'|'button'` 清單）**必填**，缺少就部署失敗；文件與 CLI 明示此要求。
2. 門內逃生必須是機械式、不受電子控制影響（依當地建築與消防法規；fail-safe／fail-secure 的選擇依法規與門的用途，不由 relay 決定）。
3. 斷線、額度用完、時鐘未同步、解密或驗證失敗時，設備**維持目前狀態**，不得自動解鎖或改變狀態。
4. 額度恢復或重連後，**不得補執行**期間的任何命令（ephemeral 不落庫、即時等級不排隊、`ts` 視窗與 `expiration` 三道保證）。
5. 恢復時以隨機延遲分散重連（§10.2），避免午夜尖峰。


### 11. IoT 推播：App 關著也收得到警報（使用者已裁示，2026-10-03；SDK 側已實作 v0.40.0，見〈§11 實作〉）

**問題**：手機只有在 App 開著時才和中繼保持 WebSocket；App 關掉或被系統放到背景後，門被打開、警報、設備離線都收不到。
iOS 沒有前台服務，唯一的背景喚醒管道是 APNs；Android 可用前台服務或 FCM。

**沿用既有決策，不另起爐灶**：

- Cinderous ADR-0272（無內容喚醒＋明示同意）：payload 不含內容、寄件人或計數；App 被喚醒後自己連中繼取密文、本機解密後才產生**本機通知**；
  預設關、同意畫面逐條列出新增洩漏（第三方時序、中繼暫存推播 token、token 的長期連結性；iOS 另加密文大小級距）；token 帶 TTL（30 天）、啟動時續期、定期輪替；
  Android＝FCM 高優先**空**資料訊息，iOS＝一般推播＋Notification Service Extension（payload 只帶事件 id，NSE 連中繼取回並解密），避免靜默推播被節流。
- 本 repo ADR 0011 §6：SDK 不做 APNs／FCM 註冊（需要 App 自己的開發者帳號與原生程式碼），只提供 `silentTicklePayload` 與 `assertZeroKnowledgePush`。

**草案**：

1. **登記**：手機同意後，把推播 token 以 NIP-44 加密給「送推播的一方」，連同 `ttl`、要訂閱的事件類別、所屬家庭，登記在該家庭的推播登錄（C／C′：家庭 DO；A：見待決 3）。
   登錄只存「token 密文＋類別＋到期時間」，不存設備清單或事件內容。撤銷成員時，owner 一併清掉該成員的 token。
2. **觸發**：送推播的一方在下列事件發生時，對已登記且訂閱該類別的 token 送**無內容喚醒**（類別本身也不放進 payload）：
   - 安全類：門／門鎖被打開、門鎖卡住或被破壞、警報、門鎖類設備離線；
   - 營運類：額度 80%／95%／100%（§10）、閘道離線；
   - 一般類（預設不推）：一般設備狀態變化。
3. **App 端**：被喚醒後連中繼讀 retained（31170）與最近的 25172，本機解密，依本機設定產生通知（沿用 `notifyHidePreview`）。
4. **SDK 端**：`./iot` 提供推播登錄的事件格式、加密與類別過濾的純函式，以及送出端的「合併＋抖動」排程器；**不**內建 FCM／APNs 的 HTTP 送出（由宿主注入 `sendPush(token, payload)`），
   維持 ADR 0011 §6 的界線。
5. **時程**：Cinderous App 的行動端原生推播（ADR-0272）尚未實作，App 側要等它；SDK 側可先做純函式與登錄格式。

**待決事項**（逐項與使用者討論）：

1. 觸發事件的分類與預設（上面三類、哪些預設開）。
2. 安全類事件的時序模糊化：ADR-0272 是「每 60 秒最多 1 次＋0–30 秒隨機延遲」，警報晚 30 秒可能太慢——安全類要不要縮短或取消延遲（代價：Google／Apple 看得到精確事件時間）。
3. 誰持有推播憑證、誰負責送：C／C′ 的家庭 DO 可直接送；路線 A 沒有家庭 DO——由閘道送（閘道持有憑證）、還是閘道請中繼代送。
4. 推播憑證與官方錨點：憑證屬於某一個 App（開發者帳號），只能放在該 App 自己的中繼；官方錨點要不要提供（替哪個 App 送）。
5. Workers 能否直接送 APNs（要求 HTTP/2＋JWT）——需要實測；FCM HTTP v1 預期可行。
6. 不經 Google／Apple 的替代方案：Android 前台服務／UnifiedPush（含自架 ntfy）要不要列為一等選項。
7. 額度成本：每次推播是 1 個 Worker 子請求（免費方案每次呼叫上限 50 個），加上合併後的頻率上限；家庭 token 數上限。

#### 11.1 使用者裁示（2026-10-03）

裁示後的模型取代上面草案的第 1、2、4 點：**client 自帶推播端點、憑證只在 App 開發者的推播閘道、誰知道端點誰就送**。

| # | 事項 | 裁示 |
|---|---|---|
| 1 | 觸發事件與預設 | **由 client 端設定**：SDK 不定分類或預設值；每個成員各自登記要訂閱的設備（App 可有自己的建議預設，不進 SDK）。中繼／送出端**只依設備（盲化 id）過濾**，訂閱的設備有任何狀態更新就喚醒；細部條件（例如「只在門被打開時」）由 App 被喚醒後在本機解密判斷。額度預警是一個特殊的可訂閱項目，只有 `owner` 能訂閱 |
| 2 | 時序模糊化 | **每個訂閱由 client 選「標準」或「即時」**，SDK 預設「標準」。標準＝ADR-0272 原規則（60 秒合併＋0–30 秒抖動）；即時＝不合併、0–2 秒抖動，每個端點每分鐘最多 6 次。同意畫面須寫明「即時」的代價（Google／Apple 看得到精確時間點） |
| 3 | 憑證與送出者 | **FCM／APNs 憑證只放在 App 開發者的推播閘道**（設備、閘道、中繼都不持有）。手機登記的是**推播端點**：UnifiedPush／ntfy 網址，或「推播閘道網址＋以推播閘道公鑰加密的 token」。**誰知道端點誰就送**：設備能力足夠就自己送（不吃中繼額度、延遲最短）；路線 A 由閘道送；設備做不到、或事件來自中繼（設備離線、額度預警）時由中繼送。端點清單存在送出的一方（帶 TTL 30 天），手機以加密指令登記到設備／閘道（保留 topic `$sys/push`）或家庭 DO。喚醒請求一律是空的，不含設備、內容、類別 |
| 4 | 官方錨點 | 由第 3 項一併解決：中繼不持有憑證、只轉交空喚醒給 client 提供的端點，所以錨點可服務任何 App 的使用者 |
| 5 | 推播閘道的宿主 | （2026-10-06 更新：Workers 版也直連 APNs，見下方實測與 ADR 0061）**參考推播閘道兩種部署**：Workers 版（iOS 經 FCM 轉送給 APNs）與 Node 版（iOS 直連 APNs，不經 Google），由部署設定器（ADR 0050）選擇；兩版共用解密、payload、合併與抖動的純函式。「Workers 能否直接以 HTTP/2 送 APNs」列入 PoC 實測，可以的話 Workers 版也直連 |
| 6 | 不經 Google／Apple 的替代 | **UnifiedPush 與 FCM 地位相同**（登記格式、送出端、測試、文件同等支援）；Android 前台服務屬 App 的選擇，SDK 不做、文件註明 ADR-0272 的建議；部署設定器之後加選用目標「自架 ntfy」 |
| 7 | 額度與上限 | **上限可在部署設定器調整**，預設：每個家庭最多 32 個推播端點（對齊 `ROSTER_MAX_DEVICES`）；標準每端點每分鐘 1 次、即時 6 次；中繼代送在處理事件的同一次請求內送出，只在標準模式有待送時才排 alarm；推播閘道驗證「每次登記獨有密鑰」的簽章、每個 token 每小時最多 60 次、過期或撤銷一律拒絕 |

**時程**：SDK 側（端點登記格式、加密、過濾與合併排程、設備端送出參考實作、參考推播閘道）可先做；App 側要等 Cinderous 行動端原生推播（ADR-0272）。

**實測：Workers 能直接以 HTTP/2 送 APNs（2026-10-06，測試帳號，`poc/apns-http2/`）**

- **設定**：
  - Apple 開發者帳號另建一把測試專用的 APNs 金鑰，以及專用的 Bundle ID，不與其他 App 共用。
  - `.p8` 只以 `wrangler secret put` 從檔案導入，不經過對話也不進 repo。
  - 送往 APNs **sandbox**，收件 token 故意填隨機值；這個測試不需要 App 和 iPhone。
- **兩種傳輸都通**：

  | 傳輸 | 結果（6 次全部相同） | 耗時 |
  |---|---|---|
  | **一般 `fetch()`** | `400 {"reason":"BadDeviceToken"}`，帶 `apns-id` | 51–786 ms |
  | `connect()`（`cloudflare:sockets`）＋手寫最小 HTTP/2 | 同上；伺服器 SETTINGS 的 `MAX_CONCURRENT_STREAMS=1` | 65–390 ms |

  - 回 `BadDeviceToken` 而不是 `403 InvalidProviderToken`，代表 APNs 已經收下 HTTP/2 請求，**ES256 JWT 也通過驗證**，只是收件 token 是假的。
- **與預期不同的地方**：
  - 原本以為 Worker 子請求只講 HTTP/1.1，**實測在 Cloudflare 邊緣上，`fetch()` 到 APNs 是可行的**：回應帶 APNs 獨有的 `apns-id`，邊緣代為與 APNs 協商 HTTP/2。
  - 本機 `wrangler dev`（workerd）的 `fetch()` 則失敗（`Network connection lost`），**只能在部署後的邊緣上驗證**。
  - `connect()` 沒有 ALPN，APNs 仍接受直接講 HTTP/2 的連線，可以當作備案。
- **結論**：§11.1 第 5 項的 **Workers 版推播閘道也可以直連 APNs，iOS 不需要經 FCM 轉送給 APNs**。參考實作用一般 `fetch()`，手寫的 HTTP/2 不進 SDK。
  - 待辦：真的送到 iPhone，屬於選做的階段 2，需要一個帶推播權限的最小測試 App。
  - 測試金鑰在 PoC 刪除後撤銷。
- **後續（使用者 2026-10-06 裁示）**：Workers 版推播閘道的 iOS 也直連 APNs（一般 `fetch()`＋ES256 provider token，與 Node 版共用請求與回應對照），
  只設 FCM 的舊部署照舊經 FCM（相容、Workers 版已棄用）——見 **ADR 0061**（v0.47.0）。v0.48.0 起 `PUSH_IOS` 沒寫就是 `apns`（兩版）、
  `fcm` 兩版都棄用、從 `fcm` 改過來不設過渡期——見 **ADR 0062**。

## 分階段實作計畫

| 階段 | 內容 | 測試 | 工作量 |
|---|---|---|---|
| **P0** | `./iot` 協定（金鑰衍生、盲化、封裝、kind 含 **25173 查詢**、ack／去重／重放、retained 打包、MQTT 樣式比對）＋`IotClient`（含 `query`、`myRole`）＋`IotGateway`（**角色權限 viewer／operator／owner、依設備／topic 細分、`$sys/acl`**）；`./iot/bridge`（mqtt.js、`queryMap`）＋`cinderous iot bridge`／`iot acl`＋Docker；守門測試（`./iot` 中立、主入口不含） | 衍生與盲化的固定向量；以 Node relay（純記憶體）＋測試用 MQTT broker（devDependency Aedes）做端到端：指令→設備→ack、查詢→即時回報、查詢節流退回 retained、viewer 操作被拒、owner 改名單、QoS 1 重送重簽、去重、過期拒收、`+`／`#`、retained 讀回、心跳過期；速率預算整合 | 7–10.5 天（原 6–9；查詢＋角色 +1–1.5） |
| **P1** | RelayCore `injectLocal`／`subscribeLocal`／配額覆寫／**`kindAuthors`（中繼端保險）**＋差異測試；`IOT_GATEWAY_PUBKEYS` 解析與車道層級帶入；`./relay/node/iot-mqtt`（embedded／external、帳密與憑證、ACL、TLS、`/mqtt`、真 LWT、topicMap）；`relay start` 旗標與 `--iot-config`；docker／fly 選用 aedes；NIP-11 `cinder_iot`；Tunnel 情境實測（延遲、閒置逾時、斷線重連） | RelayCore 沒用到時的逐則差異測試；`kind-author` 拒收（含已認證成員送 ephemeral 25172 被擋）；真實 mqtt.js 客戶端連內嵌 broker；匿名被拒、ACL、封包上限、LWT；動態 import 守門 | 7–10.5 天（原 6–9；`kindAuthors` +1–1.5） |
| **P2** | `iot-polling` 中立模組；Node 路由（含長輪詢、私有網段明文規則）；Workers 路由進 `IOT_LANE` DO、`iot_queue` 表、secret 綁定與 REST `secret_text` 上傳；`RelaySiteOptions` 擴充、`NODE_ONLY_SITE_OPTIONS`、CLI；拒收詞元；設備食譜（Shelly 腳本、ESPHome YAML、Tasmota Berry／規則、HA `rest_command`）；試算器加輪詢額度；**E2EE**：設備信封（AES-256-GCM、AAD、nonce 分區、計數器預約）、`IotClient` 設備登錄與兩層解包、relay 轉送半（外層解包、角色授權、`dv` 路由、`ctr` 檢查、不持有家庭秘密）、政策與設備層級設定（`e2ee`、`encryption`、危險旗標、夾限、錯誤訊息、NIP-11）、金鑰輪換（`epoch`、寬限、`keyWrap`、CLI `iot device-key`）、設備側參考實作（Tasmota Berry、ESPHome 外部元件、HA 自訂整合）與跨語言測試向量 | 權杖雜湊與常數時間比較、佇列上限與過期、Workers `wrangler dev` 實測、worker bundle 增量上限、開放站沒有危險旗標時部署失敗；**E2EE**：固定測試向量（TS 與 Python 交叉）、竄改 AAD／密文／tag 被拒、nonce 不重用、重放（`ctr`、視窗、msgId）、舊 epoch 寬限與到期、`required` 下設 `homeSecret` 部署失敗、明文三條件逐一缺少時的錯誤訊息、relay 端狀態與指令內容不含明文（逐則檢查）、Tasmota ESP32 與 ESPHome ESP32 實機各一台 | 11–16 天（原 5–7；E2EE +6–9） |
| **合計** | | | **約 25–37 個工作天（單人、TDD；原 17–25）** |

P2 的 E2EE 增量拆分：協定信封與測試向量 1–1.5 天；`IotClient` 設備登錄與兩層解包 0.5–1 天；relay 轉送半與政策／夾限／NIP-11／CLI／部署參數 1.5–2 天；金鑰輪換與撤銷流程 1 天；
設備側參考實作（Berry 1–1.5、ESPHome 外部元件 1.5–2、HA 1）與實機驗證——合計約 6–9 天。Shelly 不在內（v1 不支援加密，走 A）。

C′（§9）另有 R0–R5 約 15.5–23.5 天（§9.7），建議 R0 PoC 先做、R1 與 P2 合併進行；兩者共用 §2.6 信封與轉送半，合併後可省 2–3 天。

每一階段各自發版（minor），README 在該階段實作時才更新。

**實際順序（使用者裁示 4）**：P0（A）→ C′ 的 R0 PoC（可與 P0 重疊）→ C′（R1–R5）與 P2（C 輪詢）合併 → P1（B）。P1 的 RelayCore `kindAuthors` 等 C′／C 需要的部分，提前併入 C′／P2 階段。

## 風險

1. **RelayCore 改動波及錨點**：以「沒用到時逐則相同」的差異測試控管；錨點要等 Cinderous PR #9（relay-on-sdk）合併才會吃到。
2. **明文**：C 的明文設備 relay 看得到、B 的閘道在 relay 程序內——以「預設 E2EE、明文只在自架＋白名單＋危險旗標、官方錨點結構上不可能」控管，文件明示。
3. **金鑰保管**：Workers 上的 C 在 E2EE 下只放閘道簽章金鑰（可偽造「狀態事件的外層」，但解不開、也做不出設備信封）；有明文設備時才放家庭秘密（帳號持有者可取得）。
4. **設備端加密的實作品質**：Berry 解密後的 tag 比對不是常數時間、ESP 的亂數與時鐘、計數器持久化的磨損——以參考實作、測試向量與「`up` nonce 用計數器、不依賴設備亂數」降低。
5. **家庭秘密輪換的成本**：撤銷成員要重寫所有 E2EE 設備的金鑰；`keyWrap` 可延後但期間被撤銷者仍可讀。
6. **1883 誤暴露**：無法偵測路由器設定；只能以「不允許匿名」＋文件與 CLI 警告降低後果。
7. **共用免費額度**（A 於官方錨點）與自架 Workers 的輪詢額度。
8. **相依供應鏈**：Aedes／mqtt.js 以選用 peer 相依隔離；不支援 MQTT 5。
9. **範圍膨脹**：三條路線＋兩種宿主＋設備食譜＋三種設備側參考實作，維護面大；以「閘道只有一份」「v1 只有一種 AEAD」壓住。
10. **C′ 的計費未明處**（應用層自動回覆是否計請求、平台重連頻率、閒置切斷秒數、DO 超量時休眠連線的行為）：差一個數量級（約 6,000 台 vs 500 台），以 R0 PoC 實測解決。
11. **靜默斷線與「看似在線」**：Cloudflare 可能丟線不送 close frame、DO 超量時連線可能仍在但命令送不到——設備必須做 pong 逾時偵測（§9.3、§10.2）。
12. **額度耗盡與午夜重連尖峰**：以 §10 的退讓、分流、預警與門鎖本地開啟方式的強制要求控管。

## 使用者裁示（原「待使用者決定的事項」）

**已決定**

- ✅ **輪詢模式的端到端加密是 SDK 的可設定選項**（使用者 2026-10-02 決定）：站方政策 `required`（預設）／`optional`／`off`＋每台設備 `device-key`／`none`；明文只在自架＋白名單＋危險旗標；官方錨點永遠不允許明文輪詢；v1 演算法 AES-256-GCM（§2.6）。

### 使用者裁示（2026-10-02，C′）

使用者裁示研究報告〈IoT 即時推送〉最後 10 項「都依建議寫入 ADR」；報告未給明確建議的 6、7、8 由使用者另行指定。C′ 部分視為已裁示，本 ADR 整體仍為提議中。

| # | 事項 | 裁示 | 落在 |
|---|---|---|---|
| 1 | 是否新增路線 C′「即時通道」 | **新增**；Workers 上比輪詢便宜，實作與 P2（C）合併進行 | §9.1、§9.7 |
| 2 | Workers 上的 IoT 是否改為每個家庭一顆 DO | **改**：`iot:<homeTag>`、手機連 `/iot/v1/home/<homeTag>`，取代 `IOT_LANE` 車道 DO | §4（已註記取代）、§9.2 |
| 3 | 心跳預設 | 原裁示：協定層 ping，PoC 後再定。**R0 實測後改定（2026-10-02，使用者裁示甲）：預設改為應用層心跳＋`setWebSocketAutoResponse`**（實測與協定 ping 一樣不計請求、不喚醒 DO，且中繼可讀最後心跳時間）；協定 ping 保留給不方便送應用層訊息的韌體 | §9.3 |
| 4 | 是否先做 R0 PoC | **是**（測試用 Cloudflare 帳號；含刻意耗盡一次免費額度） | §9.7 |
| 5 | 即時等級命令預設 ttl 與逾時 UX | **15 秒**（夾 5–60）；逾時顯示「結果未知」並自動查詢 | §9.4 |
| 6 | `operatorSecret` | **門鎖類設備（`class: 'lock'`）預設啟用**，其他類型可選 | §9.5 |
| 7 | Shelly Outbound WS 明文轉譯 | **只限自架＋白名單＋危險旗標**（與明文輪詢同三條件）；開放站與錨點不提供開關 | §9.5 |
| 8 | 長輪詢 | **只做「Worker 掛住、DO 不掛」**的版本，僅給沒有 WebSocket 客戶端的韌體（Tasmota／ESPHome）作備援；DO 掛住請求與 SSE 不做 | §4、§9.3 |
| 9 | 官方錨點是否開放 C′ | **先只給自架**；錨點需要「家庭登記」機制，另案 | §9.2 |
| 10 | 更正「長輪詢一台吃 83%」 | **更正**為「每顆一直掛著請求的 DO 吃 83%，與設備數無關」 | §4 |
| 追加 | 免費額度用完時的設備感知、預警、App 呈現與降級；門鎖必須保留本地／實體開啟方式 | **寫入安全要求** | §10 |

### 使用者裁示（2026-10-02，其餘待決事項）

使用者逐項討論後裁示（第 11 項 kind 編號先前已決定：25170–25173、31170／31171）。

| # | 事項 | 裁示 |
|---|---|---|
| 1 | 定位 | **只做「遠端低頻控制＋最新狀態」**。中繼只保留每台設備最新狀態（31170），不存歷史；高頻遙測只開放自架：部署設定加 `iot.telemetry`，Cloudflare 目標固定關閉，自架目標可開並設每台回報頻率上限，超過上限的回報丟棄並回警告 |
| 2 | 官方錨點 | **路線 A 開專屬 `iot` 車道、小天花板**（例如 32 MiB）；錨點的 E2EE 輪詢與 C′ 先不開，等「家庭登記」另案。實際加車道仍要等 Cinderous PR #9 合併、經使用者同意才部署 |
| 3 | topic 盲化與 Gift Wrap | **盲化預設開；不提供 Gift Wrap**，保留 §6 中繼端保險（kind×作者）；需要時於協定 v2 再議 |
| 4 | 實作順序 | **P0（A）→ R0 PoC（可重疊）→ C′＋C → B**（見〈分階段實作計畫〉）；橋接器形式 **Docker → HA add-on → 樹莓派腳本**；設備端參考實作 **ESP32（ESP-IDF，C′）→ Tasmota Berry（長輪詢備援）→ ESPHome → HA** |
| 5 | 家庭秘密發放與角色名單 | **沿用 ADR 0028 QR 配對**；配對只能由 `owner` 發起並當場選角色；角色名單**只以閘道本地（C／C′ 為家庭 DO）為準、只有 `owner` 能改**，不放進可合併名單；新增 `owner` 角色；`operatorSecret` 走同一套配對 |
| 6 | LWT | **不做中繼代發遺囑**：B 用真 LWT、A／C 用心跳過期、C′ 由家庭 DO 即時回答在線與否（不寫入資料庫） |
| 7 | 授權 | `./iot`、`./iot/bridge`、中繼端模組維持 AGPL-3.0-only；**設備端參考實作（例如 `examples/iot-device/`）以 MIT-0** 授權（與 ADR 0050 產生物一致），每檔加標頭；Aedes／mqtt.js 為 MIT（相容） |
| 8 | Workers 上的明文設備 | **允許把家庭秘密放進 Cloudflare secret**（`IOT_HOME_SECRET`），供明文設備與 Shelly 明文轉譯使用；條件不變：自架＋白名單＋危險旗標，官方錨點永遠不允許。部署錯誤訊息與 `README-DEPLOY` 必須明示：「Cloudflare secret 持有家庭秘密，理論上可解開全家所有事件（含 E2EE 設備）」 |
| 9 | 開放站與區網明文 HTTP | E2EE 輪詢在開放站**維持需要 `dangerouslyAllowIotOnOpenRelay`**；明文仍只限白名單站。Node 自架的非 TLS 輪詢**只接受私有網段來源**（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`fc00::/7`），外網一律 HTTPS；**Cloudflare Tunnel 入口必須與區網 HTTP 分在不同的埠**（Tunnel 轉入的連線來源可能是 `127.0.0.1`，同埠會被誤判為區網），部署設定器與啟動驗證要擋下同埠設定 |
| 10 | Aedes／mqtt.js | **選用 peer 相依**（`peerDependenciesMeta.optional`）、動態 `import()`，沒裝時給明確錯誤（例如「請執行 npm install aedes」）；部署設定器選了內建 MQTT 時自動寫入部署包的 `package.json`；守門測試確認主入口與 `./iot` 不帶進 MQTT 套件 |
| 12 | MQTT over WebSocket（`/mqtt`） | **提供、預設關**；開啟後只接受私有網段連線（與第 9 項同一套判斷），經 Tunnel 對外需再加危險旗標，說明明示「Cloudflare 看得到明文」；`/mqtt` 與 Tunnel 入口不同埠 |
| 13 | 逐成員可見的設備 | **v1 不做**；需要隔離時拆成多個「家庭」（各自家庭秘密，同一閘道可服務多個家庭），文件寫明此做法；協定版本欄位保留給 v2 |
| 14 | ChaCha20-Poly1305 | **v1 不加**，只用 AES-256-GCM；`alg` 欄位與 NIP-11 `alg` 保留給日後擴充 |
| 15 | Shelly Gen3／Gen4 自組加密 | **不自組**（不以 ECB 拼 AES-CTR＋CMAC）；Shelly 推薦走路線 A，明文轉譯（使用者裁示 C′-7、上表 8）作為備援 |

## P0 實作（v0.39.0，路線 A）

### 模組

| 位置 | 內容 | 碰 Node？ |
|---|---|---|
| `src/iot/`（新子路徑 `@cinderous/client/iot`） | `kinds`（25170–25173、31170／31171）、`keys`（`deriveIotHome`：HKDF 衍生 `homeKey`／`homePub`／`topicKey`／`homeTag`、`blind`、`deriveIotDeviceKey`）、`topic`（MQTT 樣式比對、每層前綴、訂閱計畫）、`content`（各 `type` 的內容驗證、`IotKeyring` 封裝、`buildIotEvent`）、`acl`（角色、細分、`minRole`／`confirm`、`$sys/acl` 操作）、`replay`（時間窗＋msgId 去重）、`retained`（打包與合併）、`transport`（只依賴 `RelayTransport` 型別；發布走 `publishPaced`）、`gateway`（`IotGateway`）、`client`（`IotClient`） | 否（守門測試） |
| `src/iot/bridge/`（新子路徑 `@cinderous/client/iot/bridge`） | `startIotBridge`、`startIotBridgeFromConfig`、`connectIotClient`、`fileIotAclStore`、`loadMqttConnect`（動態 `import('mqtt')`，沒裝時「請執行 npm install mqtt」）；`mapping`（topicMap／queryMap 編譯，萬用字元依序代入、`lwt`）；`config`（`iot-bridge.json`／`iot-client.json` 解析，秘密只收 `{ "$env" }`） | 是（`index.ts`；`mapping`／`config` 本身不碰） |
| `src/deploy/render.ts`、`container.ts` | 橋接器的 Dockerfile、compose（`network_mode: host`、不發布埠、`env_file: .env`、名單存在 named volume）、`.env.example`、`prepareIotBridgeContext`（沿用 ADR 0018 的 `sdk/` 內嵌） | `container.ts` 是 |
| `src/cli/` | `iot bridge`、`iot acl list|add|remove`、`iot keygen`、`iot build` | 是 |
| `package.json` | `exports` 加 `./iot`、`./iot/bridge`；`mqtt` 列 `peerDependencies`＋`peerDependenciesMeta.optional`；`mqtt`、`aedes` 只在 devDependencies | — |

### 指令

```bash
npm install mqtt                                            # 選用 peer 相依，只有橋接器需要
npx cinderous iot keygen                                    # IOT_HOME_SECRET、IOT_GATEWAY_KEY（只印一次）
npx cinderous iot bridge --config iot-bridge.json [--acl-file <檔>]
npx cinderous iot acl list|add <npub> --role <角色> [--devices a,b*] [--topics x/#] [--expires-at <秒>] [--label <名>]|remove <npub> [--config iot-client.json]
npx cinderous iot build --out iot-bridge/ [--config iot-bridge.json]   # Docker 建置內容
```

設定檔旁邊的 `.env` 會被讀（環境變數優先），與 `relay deploy --config`（ADR 0050）相同。

### 與本 ADR 的差異（及理由）

1. **查詢的回覆放在 25171 ack 裡**（`topics`、新增布林欄位 `fromRetained`），客戶端只等 ack；25172（帶 `e`＝查詢事件 id、內容 `inReplyTo`）照樣發給即時訂閱者。節流時是 ack `throttled`＋快取的 `topics`，不另發 25172。理由：一則事件就能回答，客戶端不必關聯兩種事件；逾時時客戶端退回 `getRetained()`。
2. **查詢與 retained 帶 `dv`**＝blind("dev:"+設備)：25173 以 `dv` 標設備（ADR 寫「同 25170，`t` 或 `dv`」）；31170 每一顆都帶 `dv`，`getRetained()` 一次 `#dv` 就拿到全部分片。分片 `d`：第 0 顆＝blind("dev:<id>")，其餘＝blind("dev:<id>|<n>")。
3. **沒有新增 ack 狀態值**：過期、時間窗外、缺 `expiration`、去重快取已滿，一律 `rejected` 加 `reason`（`expired`／`stale`／`clock-skew`／`expiration-required`／`busy`）。閘道另外要求 `expiration ≤ ts + 300 秒`（§5 指令存活上限）。
4. **去重快取滿了而且全都還在時間窗內：拒收新的（`busy`，fail-closed）**，不擠掉仍有效的 msgId（否則被擠掉的那一則可以重放）。去重鍵是「簽章者公鑰＋msgId」。
5. **`retries`＝重送次數（不含第一次），預設 2**：3＋6＋12＝21 秒，落在預設存活 30 秒內；超過 `expiration` 就不再送。§3 範例的 `retries: 3` 會送到過期之後。
6. **`IotGatewayHandler.query()` 回 `'sent' | 'unsupported' | 'unknown-device'`**：沒有原生查詢的設備以 retained 回覆（`ok`、`reason: no-native-query`、`fromRetained`）；不認得的設備回 `unknown-topic`（`reason: unknown-device`）。
7. **細分的套用範圍**：`topics` 只限制操作（查詢以設備為單位，看 `devices`）；`$sys/acl` 只看角色是不是 owner，不受 owner 自己的細分限制（否則 owner 可能把自己鎖在外面）；不能移除或降級最後一位有效的 owner。
8. **可尋址事件的 `created_at` 每個位址嚴格遞增**：同一秒內連改兩次名單、或心跳後立刻送 `online: false`，中繼會回 `blocked: stale:` 不取代（CLI 冒煙測試實際撞到）。閘道依位址記住最後一秒、必要時往後推一秒；沒送出去的名單、retained、心跳以 1／3／10／30 秒重試。
9. **topicMap 的擴充**：`mqtt` 與 `topic` 兩邊都可以有萬用字元（依序代入）；`lwt: true | { online, offline }` 把設備自己的遺囑轉成狀態並更新 retained 的 `online`（裁示 6：中繼不代發遺囑）。
10. **新增 CLI**：`iot keygen`（產生家庭秘密與閘道私鑰）與 `iot build`（橋接器的 Docker 建置內容；§3 只寫「Docker 映像沿用 ADR 0018 的建置內容」）。設定檔 `iot-bridge.json`／`iot-client.json` 的秘密只收 `{ "$env" }`（ADR 0050 §4）；`--acl-file` 讓容器把名單存在 volume。
11. **HKDF 的 salt**：ADR 只對 `deviceKey` 寫明 `salt=""`；`homeKey`／`topicKey` 沿用同一個約定（固定向量已釘住，並以 Node 內建 HKDF／HMAC 交叉驗證）。
12. **P0 沒做的**：`IotClient` 的 `devices`／`e2ee`（P2 設備信封）、`deviceLink`／`urgency`（C′）、橋接器的 `standby` 備援（§6；可以在 `relays` 列多座）、`cinderous iot device-key`（P2）。AES-256-GCM 設備信封沒有實作（P2），只有 `deriveIotDeviceKey` 純函式與向量。不做 Gift Wrap（裁示 3）、中繼不代發遺囑（裁示 6）、RelayCore 沒有任何改動。
13. **已知限制**：自架 Node 中繼的嚴格平面每個作者每個 kind 最多 5 個可尋址位址（`ADDRESSABLE_MAX_PER_AUTHOR`）；名單佔 1 顆 31170 ⇒ 一個閘道在自架站上最多 4 台設備的 retained（官方錨點車道 64、公用 16）。放寬給閘道公鑰（`addressablePerAuthorOverride`）在 P1。

### 驗證範圍

- 實際跑過：單元測試（向量、比對、內容驗證、去重、打包、角色權限）；以假傳輸層測安全邊界（只收閘道簽的 25171／25172／31170、閘道只收寄給自己與這個家、標籤與內容一致）；
  **端到端**：真的 Node 中繼（純記憶體、嚴格平面、NIP-42）＋Aedes（devDependency）＋mqtt.js＋`startIotBridge`＋`IotClient`／`RelayPool`，涵蓋指令→設備→ack、retained 讀回、`+`／`#`、查詢即時回報與節流退回 retained、viewer 與名單外的人被拒、owner 改名單（寫進本地檔、非 owner 改不了、不能移除最後 owner）、`minRole`＋`confirm`、QoS 1 弄丟第一顆後重送（新 id、同 msgId、設備只執行一次）、去重、過期與時間窗外拒收、事件預算（共用 `sharedRelayEventBudget`、預算用完就等）、心跳過期與關閉時 `online: false`、中繼上只看得到密文與盲化標籤；
  **CLI 冒煙**：本機 Node 中繼＋Aedes＋模擬設備，跑 `iot keygen`、`iot bridge`、`iot acl list|add|remove` 與一支 `IotClient` 腳本（指令、retained、查詢、`myRole`）。
- 沒跑過：Docker 映像建置與 compose（這台機器沒有 Docker）、真的 Tasmota／Zigbee2MQTT／Home Assistant、官方錨點的 `iot` 車道（要等 Cinderous PR #9 與使用者同意）、Cloudflare。

## §11 實作（v0.40.0，IoT 推播的 SDK 側）

依 §11.1 使用者裁示實作 SDK 側；App 側（FCM／APNs 註冊、NSE、同意畫面）要等 Cinderous 行動端原生推播（ADR-0272），中繼（家庭 DO）當送出端要等 C′。

### 模組

| 位置 | 內容 | 碰 Node？ |
|---|---|---|
| `src/iot/push.ts`（`./iot`） | 端點格式（`unifiedpush`／`gateway`）與 `parseIotPushEndpoint`、`iotPushEndpointId`；App 端 `sealIotPushToken`（ephemeral secp256k1 × 推播閘道公鑰 → NIP-44 v2，內含平台、token 種類、token、每次登記獨有密鑰、`iat`／`exp`）；喚醒請求 `buildIotPushWakeBody`／`buildIotPushRequest`（HMAC-SHA256，含時間戳）、`assertEmptyIotPushWake`、撤銷 `buildIotPushRevokeBody`；預設送出 `fetchIotPushSend`；上限 `IOT_PUSH_LIMITS`＋`iotPushLimits`；`$sys/push` 操作與訂閱 `parseIotPushOp`／`parseIotPushSubscriptions` | 否 |
| `src/iot/push-scheduler.ts`（`./iot`） | `IotPushScheduler`：合併＋抖動（標準 60 秒＋0–30 秒；即時 0–2 秒、每端點每分鐘 6 次、即時送出時滿足等待中的標準）、`gone`／`retry`（`Retry-After`）／`error`（最多 3 次），時鐘、亂數、計時器可注入 | 否 |
| `src/iot/push-registry.ts`（`./iot`） | `IotPushRegistry`（每家 32 端點、TTL 30 天、不能蓋掉別人的端點、owner 可移除任何人的、`removeByOwner`、依 `dv`／特殊項目選出目標）、`IotPushStore`／`memoryIotPushStore`、`parseIotPushRegistrations` | 否 |
| `src/iot/gateway.ts`、`client.ts`、`acl.ts`、`topic.ts` | `IotGateway` 的 `push` 選項、`notifyPushSpecial`、`pushRegistrations`；`IotClient.registerPush`／`updatePush`／`revokePush`；`$sys/push` 任何有效成員都能操作（`IOT_PUSH_TOPIC`） | 否 |
| `src/iot/bridge/` | `iot-bridge.json` 的 `push` 段（上限嚴格檢查）、`fileIotPushStore`、`startIotBridge({ push })`；CLI `--push-file`；容器 CMD 帶 `/data/iot-push.json` | 是 |
| `src/iot/push-gateway/`（新子路徑 `./iot/push-gateway`） | 核心 `createPushGatewayHandler`（`/v1/wake`、`/v1/revoke`、`/v1/info`、`/healthz`）、`pushGatewayConfigFromEnv`、`admitPushWake`／`revokePushRegistration`（純函式）、`memoryPushGatewayStore`；`FcmSender`（服務帳號 RS256 JWT → OAuth，WebCrypto）、`ApnsSender`（ES256 provider token）、`assertContentlessPushPayload`；`createPushGatewayFromEnv` | 否 |
| `./iot/push-gateway/worker` | Workers 版：`default.fetch`、`PushGatewayState`（每個 token 一顆 DO，SQLite 型）、`durableObjectPushStore` | 否 |
| `./iot/push-gateway/node` | Node 版：`startNodePushGateway`（`node:http`）、`http2ApnsTransport`（`node:http2`） | 是 |
| `src/deploy/config/`（`./deploy/config`） | `service: 'push-gateway'`、`pushGateway.*` 描述表項目、驗證規則、`push-package.ts`（部署包）、`push-guide.ts`（中英說明） | 否 |
| `src/cli/` | `iot push-keygen`；`relay deploy --config` 遇到推播閘道回用法錯誤 | 是 |
| `examples/iot-device/`（MIT-0，不進 npm 套件） | 設備端送出流程規格（README）與零相依 Node 參考實作 `push-sender.mjs`（附測試向量） | 是 |

### 與裁示（與 §11 草案）的差異及理由

1. **端點在 `$sys/push` 裡再加密一次給送出端**：指令的外層照常加密給全家（任何持有家庭秘密的成員都解得開），但端點是能力（知道 UnifiedPush 網址或「封包＋密鑰」就能喚醒那支手機），所以 `endpoint` 欄位另以 NIP-44（成員私鑰 × 送出端公鑰）加密；其他家人看得到「有人登記了推播」與訂閱的盲化 id，看不到端點。
2. **喚醒請求「一律空的」的例外：iOS 的不透明事件 id（`ref`）**：給推播閘道的本文只有 `v`、`sealed`、`ts`、`sig` 與選用的 `ref`（只能是 64 位小寫 hex）；Android 與 UnifiedPush 一律不帶 `ref`。理由：ADR-0272 §5.1 的 iOS NSE 形態要事件 id 回中繼取密文，而事件 id 本來就在中繼上、不是設備、內容或類別。閘道送出時 `ref`＝那一則 25172 的事件 id；設備自己送時通常沒有 `ref`，NSE 改讀訂閱設備的 retained（31170）。
3. **「以登記密鑰做的簽章」是 HMAC-SHA256**（對稱）：密鑰就在封包裡，推播閘道解封後即可驗；ESP32（mbedtls）與 Berry 都有 HMAC，不必在設備上做 ECDSA。比較用常數時間。
4. **防重放＝時間窗＋同一登記嚴格遞增的時間戳**（不用 nonce 快取）：狀態只有每個登記一個數字；Workers 版存在 DO。Node 版存在記憶體：重啟後沒見過的登記只收啟動之後的時間戳（重放不了重啟前的請求），但**撤銷紀錄會遺失**（封包仍會到期；部署說明的檢查清單寫明）。
5. **推播閘道每個 token 另有每分鐘上限**（預設 6＝即時模式的上限），與裁示 7 的每小時 60 次並列：縱深防禦，送出端本來就會合併與節流。同一個 token 的不同登記（不同送出端）合計。
6. **部署設定器接入的是推播閘道的上限**（`pushGateway.tokenPerHour`、`tokenPerMinute`、`maxSkewSec`、`maxRegistrationDays`）。送出端的上限（每家 32 端點、標準 1／分、即時 6／分、TTL 30 天）在送出端設定——橋接器的 `iot-bridge.json` `push` 段、程式的 `IotGateway` `push.limits`——因為目前送出端都不是由 `cinderous.config.json` 部署的（橋接器走 `iot build`，中繼送出要等 C′）。C′ 落地時，中繼送出端的上限再以描述表項目接入；兩邊的數字共用 `IOT_PUSH_LIMITS`（設定器那一份由測試比對一致，因為設定器不能引用 `./iot`）。
7. **觸發條件是「狀態有變化」**：同一個值重複回報不喚醒（週期性遙測不該每次叫醒手機）；`online` 改變、設備遺囑（LWT）也算。裁示 1 的「任何狀態更新」解讀為「任何狀態改變」。
8. **iOS 的推播內容**：一般推播＋`mutable-content`、高優先，`alert` 只放在地化鍵 `loc-key`（預設 `CINDER_WAKE`，文字由 App 的 Localizable.strings 提供），推播本身沒有任何文字。SDK ADR 0011 §6 的 `silentTicklePayload('apns')`（`content-available` 靜默推播）不適用（會被節流），所以新增 `assertContentlessPushPayload`；Android 部分直接沿用 `assertZeroKnowledgePush('fcm', …)`。ADR 0011 §6 的兩個函式不變（Vault 同步照用）。
9. **token 封包帶平台與 token 種類**（`android`／`ios` × `fcm`／`apns`）：iOS 經 FCM 時是 Firebase 的 token，直連 APNs 時是裝置 token；App 依推播閘道 `GET /v1/info` 的 `ios`（`fcm`／`apns`／`off`）決定封哪一種。新增的 `/v1/info` 與 `/v1/revoke`（App 停用推播時以同一把密鑰撤銷該封包）是裁示裡「撤銷一律拒絕」的實作方式。
10. **Workers 版不能直連 APNs**：設定器（部署前）與推播閘道（啟動時）都拒絕 `PUSH_IOS=apns`，等 PoC 確認 Workers 能以 HTTP/2 送 APNs（裁示 5）。部署說明寫明「Workers 版 iOS 經 Google，Google 也看得到 iOS 的喚醒時間點」。**v0.47.0 起取消**：PoC 確認可行，Workers 版以 `fetch()` 直連 APNs，iOS 經 FCM 改為相容並棄用（ADR 0061）。
11. **額度預警的觸發**：路線 A 的閘道看不到中繼額度，提供 `gateway.notifyPushSpecial('quota')` 給宿主（或日後的中繼送出端）呼叫；訂閱與送出時都檢查「目前仍是 owner」。
12. **角色在送出時再查一次**：成員被移除（`$sys/acl` remove）時端點立刻清掉；成員過期或降級時不送（降級者的額度預警訂閱不再喚醒）。viewer 的 `devices` 細分不限制推播訂閱——能解密≠能下指令，viewer 本來就讀得到全家的狀態（§2.5）。
13. **端點以 id 為鍵**（由端點內容導出）：同一端點再登記一次＝更新與續期；別人登記過的端點不能蓋掉（`not-yours`）；一個登記最多 64 個訂閱。
14. **`allowPrivateHttp`**（預設關）：家中橋接器可以送給家裡 `http://` 的 ntfy（只限 RFC 1918／loopback／`.local`／`.lan`／`.home.arpa`）；日後中繼當送出端時不得開（SSRF）。
15. **部署**：推播閘道以 `service: "push-gateway"` 接入既有目標（Workers 目標＝Workers 版；docker／fly／home-tunnel＝Node 版），不另開目標；`cloudflare-api`（REST）與 `--self-contained` 不支援；`relay deploy --config` 不部署推播閘道（回用法錯誤，改用 `relay build`＋wrangler／docker compose／fly）。執行期秘密（`PUSH_GATEWAY_KEY`、`FCM_SERVICE_ACCOUNT`、`APNS_KEY`）固定名稱，設定檔的 `secrets.*` 只改部署端從哪個環境變數取值。
16. **中繼（家庭 DO）當送出端：只預留介面**。`IotPushRegistry`、`IotPushScheduler`（計時器可換成 DO alarm）、`buildIotPushRequest`／`fetchIotPushSend` 都中立、可直接放進 DO；裁示 7 的「中繼代送在處理事件的同一次請求內送出，只在標準模式有待送時才排 alarm」在 C′ 以注入的計時器實作；中繼送出時 `allowPrivateHttp` 必須關。
17. **沒做（依任務範圍）**：設備韌體（ESP32、Tasmota）屬 C′；App 的 FCM／APNs 註冊與 NSE；部署設定器的「自架 ntfy」選用目標（裁示 6 的後續）。

### 驗證範圍

- 實際跑過：
  - 單元：端點與封包格式、簽章、空喚醒守門、上限、排程器（假時鐘：合併、抖動範圍、60 秒間隔、即時 6／分、即時滿足標準、`gone`／`retry`／`error`）、登記（TTL、上限、角色、`not-yours`）、推播閘道（解封、驗簽、重放、時間窗、到期、撤銷、每分鐘／每小時上限、平台開關、`/v1/info`、日誌與回應不含 token／封包／密鑰／私鑰、設定錯誤不含值）。
  - FCM：以 fetch mock 驗 OAuth 請求（JWT RS256 以 `node:crypto` 公鑰驗章）、Android 空資料訊息、iOS 經 FCM 的 `apns` 區塊、token 快取、401 換新、`UNREGISTERED` → 410、429 → 503＋`Retry-After`。
  - APNs：本機 `node:http2` h2c 測試伺服器，驗 ES256 provider token（`node:crypto` 驗章）、路徑與標頭、payload、`ExpiredProviderToken` 重簽、`Unregistered` → 送出端 `gone`。
  - Workers 版：以假 DO 命名空間跑 `worker.fetch`（DO 擋重放、Workers 上 `PUSH_IOS=apns` 回 503 且日誌不含私鑰）。
  - 端到端：真的 Node 中繼＋Aedes＋橋接器（`push` 開）＋`IotClient.registerPush` → 設備狀態變化 → 以真的 `fetch` POST 到本機 HTTP 伺服器（模擬 ntfy）：本文空的、`Urgency: high`；撤銷後不再送；存檔寫入／清空。
  - 設備端參考實作：與 SDK 的喚醒請求逐位元組相同、README 測試向量、對 SDK 推播閘道（FCM mock）真的送一次。
  - 冒煙（這台開發機，2026-10-03）：以真的 CLI（`dist/cli/index.js`）`config validate`＋`relay build` 產生 Node 版與 Workers 版部署包；Node 版 `npm install` 後跑 `server.mjs`，打 `/healthz`、`/v1/info`（公鑰相符）、錯簽章 401、撤銷 200、重放 409、撤銷後喚醒 410、日誌不含秘密；Workers 版 `npm install` 後 `wrangler deploy --dry-run`（wrangler 4.147.0，227 KiB、`PUSH_STATE` 綁定與 `[vars]` 正確）與 `wrangler dev`（本機 workerd）跑同一組請求，結果相同（DO 擋重放與撤銷）。⚠ Windows 上部署包放在很深的資料夾時，本機 DO 的 SQLite 路徑會超過 260 字元而回 `internal error`，要加 `--persist-to <短路徑>`（已寫進部署說明）。
- 沒跑過：真的 Google／Apple（沒有呼叫 FCM 或 APNs、沒有用任何憑證）、真的 App 與 NSE、真的 ESP32、Docker／compose／Fly（這台機器沒有 Docker 與 flyctl）、部署到 Cloudflare。

## C′ R1 實作（v0.59.0，relay 端即時通道）

2026-10-14 使用者指示「sdk 的部署設定器與 iot 可以繼續實作」。照〈實際順序〉做 C′ 的 R1：relay 端的即時通道。手機端 `IotClient` 的 C′ 支援（`urgency`、`unknown→query`、`deviceLink()`）、`./iot/device`、NIP-11 `cinder_iot.realtime`、`RelaySiteOptions`／CLI 在 R2。

### 模組

| 位置 | 內容 |
|---|---|
| `src/iot/envelope.ts`（新） | §2.6 設備信封：`sealIotEnvelope`／`openIotEnvelope`／`parseIotEnvelope`（AES-256-GCM，@noble/ciphers）、AAD `cinder-iot/v1\|dir\|kid\|ctr\|ts`、nonce 分區（down＝0x00＋11 bytes 隨機；up＝0x01＋3 個零＋8 bytes 大端 ctr，**解開時也檢查**）、`iotKid`／`parseIotKid`（`<id>.<epoch>`，以最後一個點切）、`IotUpCounterGuard`（每個 kid 嚴格遞增）、`deriveIotDeviceKeyDown`（§9.5 `operatorSecret`）。明文上限 16 KiB。測試以 Node 內建 crypto 交叉驗證逐位元組相同 |
| `src/iot/device-frame.ts`（新） | §9.2 設備幀：`encodeIotDeviceFrame`／`parseIotDeviceFrame`（relay → 設備只有 `cmd`／`query`＋down 信封；設備 → relay 只有 `ack`／`state`＋up 信封與 `hb`；單幀 32 KiB）；心跳字串 `{"t":"hb"}`／`{"t":"hb-ack"}` 逐位元組固定；設備權杖 `cit1_`＋32 bytes base64url（前綴讓秘密掃描認得）、relay 只存 SHA-256、常數時間比較 |
| `src/iot/content.ts` | ack 新增 `offline`／`stale`／`quota` 狀態與 `online`／`lastHeartbeat`／`reset` 欄位；新內容型別 `dev-cmd`／`dev-query`／`dev-link`（手機 → relay，外層 NIP-44 加密給**閘道公鑰**）與 `dev-ack`／`dev-state`（relay → 全家，外層加密給 `homePub`）。舊版客戶端不認得新型別就略過 |
| `src/relay/relay-core.ts` | §7 的最小改動：`intercept`（通過驗簽、白名單、kind 政策、時鐘窗、重放與速率限制之後由宿主接手；回陣列＝不寫庫、不扇出）與 `publishLocal`（宿主自己簽的事件照取代／離線語意寫庫再扇出）。沒有設定時行為逐則相同——既有 relay 測試全部原封不動通過 |
| `src/relay/iot-realtime.ts`（新） | `IotRealtimeHome`：平台無關、**不用計時器**的家庭核心。轉送半：`h`／`p`／`dv` 檢查 → 以閘道私鑰剝外層 → `authorizeIot`（設備層級；relay 看不到 topic，所以有 `topics` 限制的名單項目 fail-closed 拒絕）＋設備的 `minRole` → kid／epoch（含 `previousEpoch` 寬限）與信封時間 → `offline`／`stale`／送出。msgId 只有**真的送到設備**才記成已送（QoS 重送同 msgId 不再送；第一次撞到離線的重送照送）。設備 ack → 25171（`p`＝還在等這台設備的成員、`e`＝他們的指令）；state → 25172＋31170（每台至少隔 5 分鐘寫一次）。`$sys/acl`（owner）經 `aclStore` 持久化。`parseIotRealtimeConfig`：收集式驗證，有問題的家庭不啟用 |
| `src/relay/iot-quota.ts`（新） | §10.3 家庭預算 `IotHomeQuota`：本 UTC 日的近似用量，80% warn、95% shed、100% exhausted，每個門檻只回報一次；每 64 次或跨門檻才寫回；預設每家＝100,000 ÷ 家庭數 × 0.5（`IOT_HOME_DAILY_REQUESTS` 可覆寫） |
| `src/relay/iot-home-room.ts`（新） | Workers 宿主：Worker 端 `routeIotRequest`（沒開→404 `blocked: iot-disabled:`；不認得的家→403；設備權杖錯→401；非升級→426；選配 `IOT_UPGRADE_LIMIT` 每 IP 限速；**都在碰 DO 之前**；DO 超量例外→503＋`Cinder-Quota: do-requests\|do-duration`＋`Retry-After`）。家庭 DO `IotHomeRoom`：休眠式 WebSocket、`setWebSocketAutoResponse` 心跳、最後心跳＝`getWebSocketAutoResponseTimestamp`（還沒有就用連線時間）、同一台設備新連線把舊的以 4409 關掉、名單存 DO SQLite `iot_acl`、預算（warn／shed 發 `$sys/quota` 給 owner；exhausted 以 4429 `iot-quota:<reset>` 關掉所有連線、新升級回 503 `home-budget`） |
| `src/relay/iot-node.ts`（新） | Node 宿主：同一個 `IotRealtimeHome`；升級在**接受之前**就驗（錯的回 HTTP JSON＋`Cinder-Relay: 1`，不建立連線）；心跳由這裡回 `hb-ack`，協定層 ping 也算心跳；名單存主資料庫的 `iot_acl`（純記憶體模式只在記憶體）；`node-relay.ts` 的升級改成自己分流（`/iot/` 之外照舊） |

relay 的環境變數：`IOT_REALTIME`（JSON，非秘密：`{ homes: [{ homeTag, homePub, gatewayPubkey, acl, devices: [{ id, blindId, epoch, tokenHash, class?, minRole?, localFallback?, previousEpoch? }], heartbeatSec?, realtimeTtlMaxSec? }] }`）、
`IOT_GATEWAY_KEYS`（Worker secret，`{ "<homeTag>": "<64 位 hex>" }`）、`IOT_HOME_DAILY_REQUESTS`、Workers 綁定 `IOT_HOME`（DO 類別 `IotHomeRoom`）與選配 `IOT_UPGRADE_LIMIT`。

### 與本 ADR 的差異（及理由）

1. **家庭 DO 是獨立類別 `IotHomeRoom`**（綁定 `IOT_HOME`），不是 `RelayRoom` 的一種政策。§9.2 只說「進 `iot:<homeTag>` 那顆 DO」；RelayRoom 的政策釘選、容量、分片都與 IoT 無關，混在一起每加一條規則都要回頭確認不影響既有平面。代價：開 C′ 的部署要多一個 DO 綁定與遷移（設定器 P2 會產生）。
2. **手機端連線在 R1 不要求 NIP-42**：指令的授權看簽章者公鑰（§2.5），不依賴連線身分；知道 `homeTag` 的人能訂閱到密文與盲化標籤（與 A／B 在公共中繼上相同）。「只有名單上的人能訂閱」留到 R2 再評估。
3. **`p` 給「還在等的成員」靠記憶體**：DO 休眠後遺失只影響 ack 的 `p`（信封裡仍有 `inReplyTo`）；命令→ack 實測 p99 < 0.5 秒（R0 結果三），休眠通常發生在那之後。
4. **retained 每台至少隔 5 分鐘**，但 relay 看不到密文是否「真的變了」（§9.4 寫「值真的變了且節流後」）——改成只靠時間節流。
5. **用量計數以 R0 實測為準**：喚醒 DO 的訊息每則計 1（不是 §10.3 原寫的 1/20；R0 結果一第 2 點）。
6. **95% 分流**目前只丟設備的 `state` 幀（`poll`／`longpoll` 在 P2／R4 才有）；ack 照轉。
7. **Node 宿主的 retained 在記憶體**（與主資料庫的事件表分開，避免一般 REQ 讀到 IoT 事件），重啟後等設備下一次回報補回；名單照常持久化。
8. `$sys/acl` 的 31170 名單公告（`d`＝blind("sys:acl")）沒有做：relay 沒有 `topicKey` 算不出盲化 id。改由設定提供或 R2 再補。
9. 新增拒收詞元 `restricted: iot-token:`、`restricted: iot-device:`、`restricted: iot-gateway-only:`、`invalid: iot:`、`invalid: iot-e2ee:`、`duplicate: iot-msgid:`、`invalid: iot-path:`、`invalid: iot-upgrade:`、`rate-limited: iot-upgrade:`、`error: iot-relay:`；`blocked: iot-device-offline:` 沒用到（離線以 ack `offline` 表達，不是拒收）。
10. 守門測試放寬：Worker／Node 中繼的入口**只准**帶 `./iot` 的協定層（kinds、keys、topic、content、acl、envelope、device-frame），手機端、A／B 閘道（用計時器）、推播、橋接器與 MQTT 仍然不准。

### 驗證

- 單元：信封 11 項（Node crypto 交叉、竄改 AAD／密文／tag、nonce 分區、格式、上限）、設備幀與權杖 6 項、RelayCore 擴充點 5 項、家庭核心 16 項（轉送、離線、stale、角色與設備細分、門鎖 `minRole`、epoch 與寬限、外層錯誤、msgId 冪等、閘道專屬 kind、`dev-link`、狀態與 retained 節流、ctr、`$sys/acl`）、預算 4 項。
- 宿主：Workers 11 項（假的 DurableObjectState：路由與拒絕不碰 DO、自動回覆設定、指令往返、單一連線 4409、stale、休眠喚醒、預算三個門檻與 503、DO 超量 503）；Node 3 項（真的 HTTP／WebSocket：權杖錯 401＋`Cinder-Relay`、403、沒開 404、心跳、指令往返、一般路徑不受影響、4409）。
- 全套 206 檔、2,954 項通過；`npm run typecheck`（三套設定）通過；worker 內嵌包已重產。
- **沒有驗證**：沒有部署到 Cloudflare（`wrangler deploy` 與真的休眠、自動回覆時間戳、超量例外的實際文字都還沒在雲端跑過）；沒有真的 ESP32／Tasmota 設備（R3）。部署前要在測試帳號上跑一次 R0 那套腳本確認行為一致。

## C′ R2 實作（SDK ADR 0120）

2026-10-28 使用者：「從 C′ R2 開始做」。完整內容見 [SDK ADR 0120](0120-iot-realtime-phone-and-device.md)，這裡只列與本 ADR 的差異：

1. **信封明文的格式由 ADR 0120 §1 定**（本 ADR 沒有寫）：down `cmd`／`query`，up `ack`／`state`；設備的 ack 只有 `ok`／`rejected`／`unknown-topic`。
2. **門鎖類的 `query` 幀用 `deviceKey`**（§9.5 只說 down 方向改用 `operatorSecret`）：查詢不改變狀態，viewer 也要能看門鎖；設備只執行 `cmd` 幀＋down 金鑰＋`type: 'cmd'`。
3. **`urgency` 預設 `normal`**，C′ 設備不自動變成即時等級，由呼叫端依 §9.4 的分級表決定。
4. §9.6 的 `connectIotDevice` 的 `heartbeat.mode` 沒有做：中立的 WebSocket API 送不了協定層 ping，只做應用層心跳（R0 實測自動回覆同樣不計費）。`onLinkState` 多了 `connecting`、`replaced`（4409）、`closed`，沒有 `network-down`（WebSocket API 分不出網路斷線與站掛掉，都算 `reconnecting`／`relay-error`）。
5. NIP-11 照 §9.6 寫 `{ ws, longpoll, heartbeat_sec }`；`longpoll` 還沒實作，寫 false。
6. NIP-42 維持 R1 的決定（ADR 0120 §7）；`RelaySiteOptions`／部署設定／CLI 與 `$sys/acl` 公告在 R2b 做掉（[SDK ADR 0121](0121-iot-realtime-deploy-and-cli.md)：家庭設定加 `aclBlindId`，relay 以 31170 公告名單；每家的可尋址上限改成 64＋1）。
7. 實作時發現事件預算把 `rate-limited: iot-quota:` 當一般限速而整個身分退避，已修正（ADR 0120 §4）。

## Consequences（若依此提議實作）

- ＋ 開發者部署 relay 時以獨立選項決定 IoT 能力（`iotMqtt` 只在 Node、`iotPolling` 兩宿主都有、輪詢 E2EE 政策預設 `required`），預設全關，NIP-11 如實宣告。
- ＋ 手機端只學一套 API；A／B／C 可混用（同一個家可以有 A 的 Zigbee 設備與 C 的 Tasmota ESP32）；查詢與操作分開、角色權限一致地套用在三條路線。
- ＋ C 在預設設定下 relay 不持有家庭秘密、看不到指令與狀態內容；自架站的狀態類 kind 只有閘道能發。
- ＋ 官方錨點只需（可選）加一條車道，程式逐則不變；明文輪詢在錨點上結構上不可能。
- － SDK 多兩個子路徑（`./iot`、`./iot/bridge`）、relay 內兩個選用模組、RelayCore 多四個介面、三份設備側參考實作。
- ＋ C′ 讓開門類命令在 Workers 免費額度內即時送達（休眠 WebSocket，出站與協定 ping 不收費）；額度用完時設備與 App 能分辨並退讓，門鎖保有本地開啟方式（§10）。
- － C′ 依賴 Cloudflare 未完全文件化的行為（閒置切斷、休眠連線在超量時的狀態），需要 PoC 與長期監看；手機每個家庭多一條連線。
- － 不會 AES-GCM 的設備（Shelly 全系列、ESP8266）在 C 只能明文（受限）或改走 A；家庭秘密輪換要重寫 E2EE 設備金鑰。

## 參考

- 研究報告（第三版，2026-10-02）：三條路線比較、使用者情境「家中 Node relay＋Cloudflare Tunnel」可行性、設備能力表（含加密能力）、免費額度估算、來源網址。
- https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- https://developers.cloudflare.com/spectrum/protocols-per-plan/
- https://developers.cloudflare.com/network/websockets/
- https://developers.cloudflare.com/fundamentals/reference/connection-limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://github.com/moscajs/aedes
- Tasmota Berry（`crypto` 模組、Berry 只在 ESP32、`persist`、`uuid`）：https://tasmota.github.io/docs/Berry/ （原始檔 https://github.com/tasmota/docs/blob/master/docs/Berry.md ）
- Shelly 腳本語言（`ArrayBuffer` 與 `AES` 只在 Gen3／Gen4、韌體 1.6.0 起）：https://shelly-api-docs.shelly.cloud/gen2/Scripts/LanguageReference/
- Shelly 腳本 AES API（CBC、CFB、CTR、OFB、ECB，沒有 GCM）：https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/AES
- ESP-IDF mbedtls Kconfig（`MBEDTLS_GCM_C` 預設 y、`MBEDTLS_CHACHAPOLY_C` 預設 n）：https://github.com/espressif/esp-idf/blob/master/components/mbedtls/Kconfig
- ESPHome 外部元件：https://esphome.io/components/external_components/
- Home Assistant core 相依（`cryptography==50.0.1`）：https://github.com/home-assistant/core/blob/dev/pyproject.toml
- NIP kind 登記表：https://github.com/nostr-protocol/nips/blob/master/README.md
- **C′ 與 §10（2026-10-02 查證）**：
  - DO Pricing（休眠不計 duration、20:1、出站與協定 ping 不收費、自動回覆不計 wall-clock、duration 由同時進行的請求共用、免費額度超量「further operations of that type will fail」、00:00 UTC 重置；頁面 2026-09-30）：https://developers.cloudflare.com/durable-objects/platform/pricing/
  - DO WebSockets best practices（休眠、協定 ping 不中斷休眠、部署會斷所有連線；2026-09-30）：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
  - DO State API（每顆 32,768 條 WebSocket、`setWebSocketAutoResponse`、`getWebSocketAutoResponseTimestamp`）：https://developers.cloudflare.com/durable-objects/api/state/
  - DO Lifecycle（10 秒休眠、阻止休眠的條件）：https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
  - Workers Pricing（免費不計 duration、經 Worker 的 WS 訊息不計請求；2026-08-28）：https://developers.cloudflare.com/workers/platform/pricing/
  - Workers Limits（每日 100,000、UTC 午夜重置、Error 1027、Fail open／Fail closed；2026-09-05）：https://developers.cloudflare.com/workers/platform/limits/
  - Workers Errors（1027、1101、1102；2026-09-30）：https://developers.cloudflare.com/workers/observability/errors/
  - Cloudflare Network › WebSockets（閒置關閉、平台重啟；2026-08-14）：https://developers.cloudflare.com/network/websockets/
  - 觀察：1027 回 HTTP 429（https://github.com/rancher/rke2/issues/11326 ）；DO 超量錯誤文字（https://github.com/andtii/agentic/pull/352 ）；重置後仍被擋（https://community.cloudflare.com/t/durable-objects-quota-stays-blocked-after-00-00-utc-reset-dashboard-shows-0/963378 ）；
    WebSocket 靜默丟線與 30 秒心跳（https://github.com/cloudflare/agents/issues/2242 、https://github.com/cloudflare/agents/pull/2286 ）
  - ESP-IDF `esp_websocket_client`：https://docs.espressif.com/projects/esp-protocols/esp_websocket_client/docs/latest/index.html
  - Shelly Outbound WebSocket：https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Ws/ ；反向 RPC 範例：https://github.com/ALLTERCO/shelly-outbound-websockets
  - Nuki MQTT（broker 須在區網）：https://developer.nuki.io/uploads/short-url/zTooefdcnMjigD8ZoKx1bihrRJD.pdf
