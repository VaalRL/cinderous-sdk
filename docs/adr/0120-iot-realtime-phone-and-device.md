# 0120. IoT 即時通道 C′ R2：手機端 `IotClient`、設備端 `./iot/device`、門鎖的 `operatorSecret`、NIP-11

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「從 C′ R2 開始做」
- 日期：2026-10-28
- 對應：SDK ADR 0049（IoT 路線；本 ADR 做掉 §9.7 R2 的手機端、設備端與 NIP-11，部署設定與 CLI 留到 R2b）、0040（拒收詞元）、0043（事件預算）

## Context

ADR 0049 C′ R1（v0.59.0）做了 relay 那一半：家庭 DO、設備端點、轉送、`offline`／`stale`、額度。但兩端都還沒有能用的程式：

- 手機端的 `IotClient` 只會走 A／B 的閘道路線；要用 C′ 得自己組 `dev-cmd`、自己封信封、自己解 `dev-ack`。
- 設備端沒有參考實作，測試裡的「設備」是手寫的 WebSocket 加手封的信封。
- **信封裡面的明文長什麼樣，R1 沒有定**：測試用的是 `'ON'`、`'{"status":"ok"}'` 這種臨時字串。手機和設備不知道怎麼互相回覆。
- NIP-11 沒有宣告這座站有沒有 C′，客戶端只能連連看。

R2 的範圍（ADR 0049 §9.7）還包括 `RelaySiteOptions`、部署設定與 CLI。它們動到四條部署路徑、Workers 的 DO 綁定與遷移，另外還需要一個產生設備權杖與盲化 id 的工具。這次先把兩端接起來，那部分另外做（見〈後續〉）。

## Decision

### 1. 信封裡的明文（`src/iot/device-message.ts`，`./iot` 匯出）

- down（手機 → 設備）：
  - `{"type":"cmd","msgId","topic","payload","enc","confirmed"?,"exp"}`；
  - `{"type":"query","msgId","exp"}`。
- up（設備 → 手機）：
  - `{"type":"ack","inReplyTo","status","reason"?,"topics"?}`，`status` 只有 `ok`／`rejected`／`unknown-topic`。角色檢查在 relay，設備不回 `not-allowed`。
  - `{"type":"state","topics","will"?}`。
- `exp` 是指令到期時間（unix 秒，與外層 NIP-40 `expiration` 相同）。`topics` 與 retained 同一個形狀 `{ payload, enc?, ts }`。
- 解析都是收集式驗證，不丟例外：relay 與其他成員都不可信，壞的就當沒收到。

### 2. 門鎖類的金鑰分工

- `cmd` 幀：`class: 'lock'`（或設備另外選用 `operatorSecret`）時用 `deviceKeyDown = HKDF(operatorSecret, …)`（§9.5），其他設備用 `deviceKey`。
- `query` 幀**一律用 `deviceKey`**，門鎖也一樣。viewer 也能查詢門鎖的狀態；設備只執行「`cmd` 幀＋以 down 金鑰解開＋內容是 `type: 'cmd'`」的訊息，幀和內容的種類不一致就丟掉。
  - 理由：§9.5 的目的只是「viewer＋被攻破的 relay 也開不了門」。查詢不改變任何東西，要 viewer 拿 `operatorSecret` 才能看門鎖狀態，等於把秘密發給更多人。
- 手機端沒有 `operatorSecret` 時，門鎖指令**不送出**，直接回 `not-allowed`（`reason: 'operator-secret'`，`attempts: 0`）。送出去設備也解不開，只會變成五秒後的 `unknown`。

### 3. 手機端 `IotClient`

- 新選項 `realtime: { devices: { <id>: { epoch?, class?, operatorSecret? } }, operatorSecret?, pool?, gateway? }`：
  - 列在 `devices` 裡的設備走 C′，其他照 A／B；
  - `pool`／`gateway` 沒給，就與閘道路線相同（同一座 relay）；有給的話，ack 的訂閱按路線分開。
- C′ 指令的外層加密給 **relay 的閘道公鑰**，因為 relay 要剝掉外層才能轉送；內層是設備信封。
  - 標籤是 `h`／`p`／`dv`／`expiration`，**不帶 `t`**，relay 不需要也不該看到 topic 的盲化 id。
  - `IotKeyring`（加密給全家）這一路不動。
- `urgency: 'realtime'`（§9.4 裁示 5）：
  - ttl 預設 15 秒，夾在 5–60；等 ack 預設 5 秒（`ackTimeoutMs`），預設不重送；
  - 逾時回 **`unknown`**（結果未知，不是失敗），並自動送一次查詢，結果放在 `after`；
  - `offline`／`stale`／`not-allowed` 是 relay 當下就回的，不查詢。
  - 沒給 `urgency`＝`normal`，與之前相同：逾時回 `timeout`、不查詢。**C′ 設備也不自動變成即時等級**，由呼叫端依用途決定（燈不需要「結果未知」那一套）。
- 設備的 `dev-ack` 要通過以下檢查才算數：
  - relay（閘道）簽的；
  - `kid` 是這台設備、而且是設定的 epoch；
  - 以 `deviceKey` 解得開；
  - 信封時間在時間窗內，而且 `kid#ctr` 沒看過。

  通過之後，以信封裡的 `inReplyTo` 對上等待中的指令。ack 帶的狀態放在結果的 `state`。
- 手機端的重放保護是「看過沒」，不是「嚴格遞增」：ack 與狀態走不同的訂閱、可能亂序，嚴格遞增會把晚到的合法狀態擋掉。嚴格遞增留在 relay（看得到明文的 ctr）和設備的計數器上。
- `query(id)`：C′ 設備送 `dev-query`；逾時就退回 retained（與 A／B 相同）。
- `deviceLink(id)`：
  - C′：送 `dev-link`，relay 以當下的連線回答 `{ transport: 'ws', status, online, lastHeartbeat? }`，不打擾設備、不落庫；
  - 其他路線：retained 的 `online`／`lastSeen`，`transport: 'gateway'`。
- `subscribeState`：另外以 `#d`＝C′ 設備的盲化 id 訂閱 relay 的 25172，解開信封後才比對 topic。relay 看不到 topic，所以這一路的 `+`／`#` 只能在手機端過濾。
- `getRetained`：C′ 設備讀 `d`＝盲化 id 的 31170。relay 存的是最後一個狀態幀（每台至少隔 5 分鐘），只有那一幀帶到的 topic，所以 `complete: false`。
- 額度（§10）：
  - relay 回的 ack 是 `quota` 時照轉，附 `reset`；
  - 中繼以 `…iot-quota:` 拒收時回 `quota`（有數字就附 `reset`），**不重送**。

### 4. 事件預算不對 `iot-quota` 退避（`relay-budget.ts`）

- 實作時發現：`rate-limited: iot-quota:` 被 `publishPaced` 當成一般限速，結果整個身分的預算一起退避，同一則還重送兩次。
- 今日額度用完不是短暫限速，重送沒用，還會拖慢同一身分的信令、名單、Vault 同步（ADR 0043 共用預算）。
- 改成 `rateLimitBackoffMs` 跳過詞元 `iot-quota`；其他 `rate-limited:` 照舊。

### 5. 設備端 `@cinderous/client/iot/device`

- `connectIotDevice({ url, standbyUrls?, token, deviceKey, deviceKeyDown?, kid, heartbeat?, maxSkewSec?, counterStore, clockSynced?, onCommand, onQuery?, onLinkState?, webSocket? })` → `{ state, publishState(), close() }`。
- 中立、零 Node 內建模組（守門測試）。WebSocket 預設用全域的那個（Node 22 以上支援 `headers`，實測 Node 26 會送出 `Authorization`）；瀏覽器設不了標頭，Node 20 沒有全域 WebSocket，這兩種情況要自己給 `webSocket`（例如 `ws`）。
- 指令處理：
  - 解不開、`kid` 不是自己、幀與內容種類不一致 → **什麼都不回**，不給偽造者任何訊號；
  - 解得開但時鐘還沒同步（`clockSynced` 回 false）→ `rejected: clock-unsynced`（fail-closed，§9.4）；
  - 信封時間超出 `maxSkewSec`（預設 60，門類建議 15），或內容已過期 → `rejected: expired`；
  - msgId 去重：重送回同一個 ack、不再執行；
  - `onCommand` 丟例外 → `rejected: device-error`。
- up 計數器**先存再送**（`counterStore.save` 完成才封信封），所有送出排在同一條鏈上，嚴格遞增。重開機從存下的值接著往上，不會重用 nonce。`memoryIotDeviceCounterStore` 只給測試與開發用。
- 連線：
  - 應用層心跳 `{"t":"hb"}`（預設 30 秒），`timeoutSec`（預設 10 秒）內沒回 `{"t":"hb-ack"}` 就以 4000 關掉重連；
  - 指數退避加抖動，預設 1–60 秒；
  - 升級失敗（還沒打開就關了）→ `relay-error`，換下一站；
  - 4429 `iot-quota:<reset>` → `quota-exhausted`：有備援站就馬上換，沒有就睡到重置時間（加最多 60 秒抖動），不狂重連；
  - 4409（同一台設備的新連線把這條擠掉，權杖可能外洩）→ `replaced`，退到最長間隔再試，不跟對方搶。
- `publishState` 沒連線時回 false：即時通道不排隊（§9.4）。

### 6. NIP-11 `cinder_iot.realtime`

- 至少一個家庭有效時才宣告 `{ "ws": true, "longpoll": false, "heartbeat_sec": <各家庭最短的> }`。Workers 還要有 `IOT_HOME` 綁定，與 `routeIotRequest` 同一個條件。
- `longpoll` 還沒實作（R4），如實寫 false。
- **不列家庭**：`homeTag` 是路由標籤，列出來等於公開這座站服務哪些家。
- `iotRealtimeAnnouncement(env)` 與實際啟用的家庭用同一個解析函式，兩個宿主共用。

### 7. NIP-42 與 `$sys/acl` 公告：維持 R1 的做法

- **手機連線仍不要求 NIP-42**（R1 差異 2）：
  - 指令以簽章者公鑰授權，不看連線身分；
  - 訂閱得到的只有密文與盲化標籤，與 A／B 在公共中繼上相同；
  - 要求 AUTH 只多擋「知道 `homeTag` 的人看得到流量的時間點」，代價是 relay 要另外維護一份「誰能訂閱」，與 §2.5 的名單重複。
- **`$sys/acl` 的 31170 公告這次也不做**：relay 沒有 `topicKey`，算不出 `blind("sys:acl")`。
  - 要做，得由設定提供盲化 id，而產生設定的工具在 R2b。
  - 在那之前，C′ 家庭的 `myRole()`／`getAcl()` 讀不到名單（回 undefined）。指令照常以 relay 的名單授權，結果以 `not-allowed` 告知。

## Alternatives Considered

- **C′ 設備一律自動用即時等級**：門鎖之外的設備（燈、插座）會在 5 秒後顯示「結果未知」再多查一次，對一般控制是多餘的打擾。由呼叫端決定，與 §9.4 的分級表一致。
- **門鎖的查詢也用 `deviceKeyDown`**：viewer 就看不到門鎖狀態，除非拿到 `operatorSecret`。這違反「秘密只給需要的人」。
- **手機端 up 也做嚴格遞增**：ack 與狀態是兩條訂閱，亂序很常見，嚴格遞增會丟掉合法的狀態。改用「看過沒＋時間窗」，嚴格遞增留給 relay 與設備。
- **把 `iot-quota` 當限速、讓預算退避**：見 §4，會拖累同一身分的其他功能。
- **設備端 WebSocket 一律用 `ws` 套件**：`./iot/device` 就不再中立，瀏覽器型設備也用不了。改成預設用全域 WebSocket、可以注入。

## Consequences

- ＋ 手機只學一套 API：同一個 `IotClient` 可以同時管 A／B 的設備與 C′ 的設備，指令、查詢、狀態、retained 都是同一組方法。
- ＋ 門鎖類從手機到設備都照 §9.5 執行：沒有 `operatorSecret` 做不出設備解得開的指令；偽造的指令 relay 照轉，設備不執行、也不回應。
- ＋ 信封裡的明文有了固定格式，R3 的韌體（ESP-IDF、ESPHome、HA）照著做就能互通。
- ＋ 額度用完時，手機與設備都能分辨並退讓，不會重連風暴或拖慢其他功能。
- － `IotCommandStatus` 多了 `unknown`，`IotCommandResult` 多了 `state`／`after`／`reset`。窮舉 status 的呼叫端要補一個分支（只有用了 `urgency: 'realtime'` 才會出現）。
- － relay 在額度用完時是**關連線**（4429），不是回 ack。手機的連線池只看到斷線，這時指令回的是 `relay-rejected`，不是 `quota`；要等連線池能把 close code 交給呼叫端才分得出來。
- － `listDevices()` 不含 C′ 設備：它們的 retained 沒有 `h`＋設備 id 的明文對應，要逐台以盲化 id 查。C′ 設備的清單本來就在 `realtime.devices` 裡。
- － C′ 家庭的 `myRole()` 讀不到（§7）。

## 後續（R2b）

> 第 1、2 點已在 [SDK ADR 0121](0121-iot-realtime-deploy-and-cli.md) 做掉（2026-10-28）；第 3 點在 [SDK ADR 0122](0122-iot-realtime-quota-close-and-rotation.md) 做掉。

- `RelaySiteOptions.iotRealtime`、部署設定（`IOT_REALTIME`、`IOT_GATEWAY_KEYS` 是秘密）、四條部署路徑的 `IOT_HOME` DO 綁定與遷移、`relay start --iot-realtime`。
- 產生設備登錄的工具：權杖（只顯示一次）、雜湊、盲化 id、`kid`，順便提供 `$sys/acl` 的盲化 id，讓 relay 能發名單公告（§7）。
- 連線池把 relay 的 close code（4429 `iot-quota:<reset>`）交給 `IotClient`，讓斷線時也能回 `quota`。

## 驗證

- `tests/iot/realtime.test.ts`（9 個）：真的 Node 中繼（`IOT_REALTIME`）＋真的 `RelayPool`＋`connectIotDevice`（Node 內建 WebSocket）。
  - 指令往返，ack 帶回狀態；
  - 設備沒有連線時立刻回 `offline`、不查詢；
  - 設備卡住時 `unknown`＋`after`（查詢照答）；
  - viewer 能查詢、不能操作；
  - 門鎖：沒有 `operatorSecret` 不送，有的開得了；以 `deviceKey` 偽造的指令 relay 照轉、設備不執行，查詢照常；
  - `deviceLink` 連著是 true，設備斷線後變成 false；
  - `subscribeState`（topic 在手機端比對）與 `getRetained`；
  - NIP-11 有 `cinder_iot`、不含 `homeTag`。
- `tests/iot/device.test.ts`（15 個，假的 WebSocket）：標頭、格式檢查、去重、計數器先存再送與重開機接續、時間窗與過期、fail-closed、門鎖的金鑰分工、種類不一致與別台的 `kid`、`device-error`、`publishState`、心跳死線重連、4429（沒有備援時睡到重置、有備援時換站）、4409、升級失敗換站、`close()`。
- `tests/iot/realtime-client.test.ts`（5 個，假的傳輸層）：外層只有 relay 解得開、沒有 `t` 標籤、即時等級 ttl 15／夾 60；一般等級逾時照舊是 `timeout`；`iot-quota` 拒收回 `quota`＋`reset`、只送一次；`quota` ack 照轉；冒充者簽的、別的 epoch、金鑰不對的 `dev-ack` 都不算。
- NIP-11：`tests/relay/nip11.test.ts`（1 個）、`tests/relay/iot-worker.test.ts`（1 個：要有 `IOT_HOME`，家庭無效就不宣告）。守門：`tests/iot/subpath.test.ts` 加上 `./iot/device`（中立、零外部引用、只帶協定層），以及 dist 以套件名稱匯入。
- 刻意改壞：
  - 設備不分 `cmd`／`query` 一律用 `deviceKey` → 3 個失敗；
  - 不把逾時轉成 `unknown` → 2 個失敗；
  - 不跳過 `iot-quota` 的退避 → 額度測試逾時（就是 §4 發現的方式）。
  - 拿掉手機端的 epoch 檢查**沒有**測試失敗：金鑰本身依 epoch 導出，錯的 epoch 照樣解不開，這項檢查是多一層保險。
- `npm run typecheck`（三套設定）、`npm run build`（含 worker 內嵌包）、TypeDoc（API 參考多了 `iot/device`，沒有警告）通過。
- **沒有驗證**：沒有部署到 Cloudflare（Workers 的休眠與自動回覆時間戳仍未在雲端跑過）；沒有真的 ESP32 或其他韌體（R3）。
