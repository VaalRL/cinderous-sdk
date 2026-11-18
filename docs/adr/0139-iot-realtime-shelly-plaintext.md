# 0139. IoT 即時通道 C′ R5：Shelly Outbound WebSocket 明文轉譯（只限自架＋白名單＋危險旗標）

- 狀態：**已接受（Accepted，2026-11-18）**——使用者 2026-11-18：「還沒做的功能 可以先做」
- 日期：2026-11-18
- 對應：SDK ADR 0049（§9.5 安全補充、§9.7 R5；裁示 7、8）、0117（`dangerous` 機制：精靈打字確認、部署說明的安全檢查清單）、0120／0121（C′ R2／R2b）、0122（金鑰輪換）、0126（DO 喚醒讀取列數）、0138（R4 長輪詢）

## Context

Shelly Gen2+ 可以用 `Ws.SetConfig { server: "wss://…" }` 主動外連，relay 再反向呼叫 RPC（`Switch.Set` 等）。這是真正的推送，可是 RPC 是明文 JSON，而且 Shelly 腳本做不出 AES-GCM（0049 §2 的韌體表：Gen2 沒有 AES，Gen3／Gen4 沒有 AEAD）。所以 Shelly 封不了 §2.6 的設備信封。

0049 §9.5（裁示 7）定了邊界：只限**自架站＋`ALLOWED_PUBKEYS` 白名單＋危險旗標**，與明文輪詢同三條件；開放站與官方錨點**不提供開關**。R1–R4 都只服務自己封信封的設備，R5 是 C′ 唯一一條「relay 看得到內容」的路。

## Decision

### 1. relay 替 Shelly 扮演「會封信封的設備」

`src/relay/iot-shelly.ts` 的 `IotShellyTranslator`（平台無關，兩個宿主共用）：

- **relay → Shelly**：解開 down 信封（`cmd`／`query`），轉成 RPC。
  - `cmd` 的 payload 接受 `on`／`off`／`1`／`0`／`true`／`false`／`toggle`，分別對應 `Switch.Set {id, on}` 或 `Switch.Toggle {id}`。
  - `query` 對應 `Shelly.GetStatus`。
- **Shelly → relay**：
  - RPC 回覆轉成 up `ack`：
    - `Switch.Set` 回 `topics` ON／OFF；
    - `Switch.Toggle` 依 `was_on` 算出 `topics`；
    - `GetStatus` 回各開關的 `topics`；
    - Shelly 回錯誤時是 `rejected`，`reason` 為 `shelly:<code>`。
  - `NotifyStatus`／`NotifyFullStatus` 的 `switch:<id>.output` 轉成 up `state`。
- **與 E2EE 設備（`./iot/device`）同一套檢查**：
  - 信封時間 ±60 秒，指令沒過期；
  - `msgId` 去重：重送回同一個 ack，不再送 RPC；
  - 不認得的 topic 回 `unknown-topic`；
  - 壞 payload 回 `rejected: bad-payload`；
  - 解不開的信封什麼都不回。
- **轉出來的 up 幀交給 `IotRealtimeHome.onDeviceFrame`**，與 E2EE 設備走同一條路：kid、計數器、分流、扇出都一樣。手機看到的與一般設備沒有差別，只有 `dev-link` 的 `transport` 是 `shelly`。
- **up 計數器以時間為底**（`max(上一個 + 1, 毫秒 × 1024)`）：DO 休眠或主機重開後不必存檔，也不會重用 GCM nonce。前提是主機時鐘不倒退超過重開的間隔。待回覆的 RPC 最多 32 筆、30 秒；去重表 256 筆。兩者都在記憶體裡，休眠後就沒了，影響只是那一輪的回覆變成手機端的 `unknown`（手機會自動送 `query`）。

### 2. 最小權限：relay 只拿那幾台的 deviceKey，不拿家庭秘密

0049 原本寫「有明文設備時才允許設定 `IOT_HOME_SECRET`」。這次改成**每台 Shelly 一把 deviceKey**：

- 秘密名稱：`IOT_PLAINTEXT_DEVICE_KEYS`，內容是 JSON `{ "<homeTag>/<設備 id>": "<64 位 hex>" }`。
- relay 被攻破時，只賠這幾台明文設備，不賠全家：它解不開其他設備的信封，也算不出 `topicKey` 與盲化 id。
- 部署端（`iotPlaintextDeviceKeysSecret`）的檢查：
  - 鍵只能是 `transport: 'shelly'` 的設備，而且每一台都要有；
  - 金鑰必須是 64 位 hex。
- 金鑰對不對（是不是那台的 deviceKey），部署端驗不了；給錯的結果是手機解不開回覆。

### 3. 設定與三道閘

設備設定（`IOT_REALTIME`）新增兩個欄位：

- `transport: 'shelly'`；
- `shelly: { switches: [{ id, topic }] }`，最多 16 個開關，topic 必須是具體的 topic（不能有 `+`、`#`）。

**門鎖類（`class: 'lock'`）不能走 Shelly**：relay 要拿到 `operatorSecret` 才能替它解指令，那就等於放棄 §9.5。

relay 啟動時（`parseIotRealtimeConfig` 的第三個參數，由 `iotPlaintextFrom(env)` 讀出），三道閘都要過：

1. `IOT_PLAINTEXT_DEVICES=1`（危險旗標）；
2. `ALLOWED_PUBKEYS` 白名單不是空的；
3. 這台設備的金鑰在 `IOT_PLAINTEXT_DEVICE_KEYS` 裡。

缺任何一道，**整個家不啟用**（issue `plaintext-disabled`／`plaintext-key-missing`），與其他設定錯誤一樣，不默默套用一半。

部署設定器另外做三項檢查：

- 站台參數 `site.iotPlaintextDevices` 要有 `allowedPubkeys`（`iot-plaintext-needs-allowlist`），也要有 `iotRealtime`（`iot-needs-realtime`）。
- 有 Shelly 設備卻沒開旗標，在部署時就擋下（`iot-plaintext-disabled`），不等 relay 啟動才整個家不啟用。
- 官方錨點是開放站（沒有白名單），所以結構上開不了。

### 4. 危險旗標接上 ADR 0117 的 `dangerous` 機制

`DEPLOY_OPTION_SPECS` 新增兩項：

- `site.iotPlaintextDevices`：布林，`dangerous: true`，環境變數 `IOT_PLAINTEXT_DEVICES`，群組 `iot`。
  - 精靈要打字 `iotPlaintextDevices` 才會開。
  - 部署說明會把它列進「🔴 安全檢查清單」。
  - 加上它之後，標了 `dangerous` 的欄位共五個。
- `secrets.iotPlaintextDeviceKeys`：預設環境變數 `IOT_PLAINTEXT_DEVICE_KEYS`。

秘密的上傳方式與 `iotGatewayKeys` 相同：

| 部署方式 | 怎麼上傳 |
|---|---|
| Cloudflare REST | `secret_text` |
| wrangler | `wrangler secret put` |
| docker／home-tunnel | compose 從 `.env` 代入；沒設就不啟動 |
| Fly | `fly secrets import`，從標準輸入傳 |

部署包的 `.env.example`、`.dev.vars.example` 與說明都列出它。

旗標名稱沒有沿用 0049 為路線 C 明文輪詢定的 `dangerouslyAllowPlaintextIotPolling`。那是另一條路線（輪詢模組），R5 是 C′ 的一個設備型態，而且危險標記現在由描述表的 `dangerous` 統一表達（ADR 0117），不再靠名稱前綴。

### 5. 端點與兩個宿主

- 路徑：`wss://<relay>/iot/v1/shelly/<homeTag>/<blindId>?token=<權杖>`。
  - Shelly 設不了標頭，所以權杖放在網址裡；有 `Authorization` 標頭時仍以標頭為準。
  - Workers 版由 Worker 先驗權杖，錯的不花 DO 請求。
  - Shelly 設備不能走 `/dev/`（WebSocket 或長輪詢），非 Shelly 設備也不能走 `/shelly/`，兩種情況都回 404 `iot-device`。
- Workers（`IotHomeRoom`）：
  - 用可休眠的 WebSocket，attachment 是 `transport: 'shelly'`；
  - 轉譯器依 blindId 建在記憶體裡，金鑰在綁定家庭時取得；
  - 同一台設備的新連線以 4409 取代舊的；
  - Shelly 送來的每一則訊息都經過家庭額度計數（`count()`），95% 分流照 `onDeviceFrame` 的規則處理（ADR 0122）；
  - 喚醒時不掃表（ADR 0126）：轉譯器只需要設定與金鑰。
- Node（`iot-node.ts`）：`DeviceSlot` 新增 `shelly` 型態，取代、關閉、離線的處理與 WebSocket 設備相同。
- relay 要轉給 Shelly 時，如果馬上就能回答（不認得的 topic、已過期），會**晚一拍**（microtask）才把 up 交給核心，因為這時還在核心處理手機訊息的途中。
- 連線狀態：Shelly 不送我們的應用層心跳，所以連線在就算在線。斷線靠 TCP 或平台偵測。
- NIP-11 **不宣告** Shelly：這是站方的私人設定，不是對外能力。

### 6. CLI

`cinderous iot realtime device <id> --shelly-switch 0=home/plug [--shelly-switch 1=…]`：

- 寫入 `transport: 'shelly'` 與開關對應。
- 另外印出兩行：
  - `IOT_PLAINTEXT_DEVICE_KEYS_ENTRY="<homeTag>/<id>":"<hex>"`，要併進秘密；
  - `SHELLY_WS_SERVER=wss://<relay>/iot/v1/shelly/…?token=…`，給 `Ws.SetConfig` 用。
- 門鎖類加 `--shelly-switch` 是用法錯誤。
- `--rotate` 會印出新版本那一筆；`--new-token` 會印出新網址。
- Shelly 的金鑰在 relay 手上，重新部署後 relay **立刻**換用新版本。`previousEpoch` 寬限對 Shelly 沒有作用：relay 只認新的 kid，寬限期內還用舊 kid 的手機會拿到 `unknown`。

## Alternatives Considered

- **把整個家庭秘密交給 relay（0049 的原寫法、裁示 8）**：做起來比較簡單（relay 可以自己算每台的金鑰），但 relay 被攻破就賠全家。改為每台一把 deviceKey，只多了 CLI 印一行。
- **Shelly 用常駐 WebSocket 加我們的心跳**：Shelly 不會送我們的 `hb` 幀；relay 自己發 RPC 探測又會吃訊息額度。所以改成「連線在就算在線」。
- **把轉譯器狀態（待回覆、去重）寫進 DO storage**：每個指令要多寫兩列。現在休眠後遺失的，只是那一輪回覆，手機有 `query` 補救。
- **NIP-11 宣告 `shelly: true`**：會讓開放站的客戶端以為可以用。這是自架站的私人設定，不該對外宣告。

## Consequences

- 開了旗標的自架站，relay **看得到** Shelly 設備的指令與狀態。部署說明的安全檢查清單與精靈的打字確認都會提醒。
- 權杖在網址裡，會進反向代理與 Cloudflare 的存取記錄。權杖外洩的影響是有人能冒充這台 Shelly 連線並把真的那台擠掉（4409），但解不開手機的指令：解封在 relay 這端，冒牌連線拿到的是明文 RPC。也能送假的 `NotifyStatus` 讓手機看到假狀態。所以**權杖外洩＝那台設備的指令外洩、狀態可偽造**，要用 `--new-token` 換掉。
- `src/iot/device-message.ts` 進了 Worker 與 Node 中繼的入口：它是協定層（只依賴 `topic.ts` 與 `content.ts` 的型別），`tests/iot/subpath.test.ts` 的允許清單已加上。
- Worker 原始碼變了，打包好的 `src/deploy/cloudflare-api/relay-worker-bundle.ts` 要在發版時以 `npm run build:worker-bundle` 重建；這次依指示沒有重建，所以 `relay-worker-bundle.test.ts` 的「與原始碼一致」會失敗，與 ADR 0138 相同。

## 驗證

- `tests/relay/iot-shelly.test.ts`（11 項）：
  - RPC 對應：Set、Toggle、GetStatus；
  - 錯誤回覆、去重、過期、不認得的 topic、壞 payload；
  - NotifyStatus 轉 state；
  - 計數器遞增；
  - 解不開的信封不回。
- `tests/relay/iot-shelly-worker.test.ts`（2 項，用假 DurableObjectState）：
  - 旗標關閉時回 404 `iot-disabled`；
  - 權杖錯誤回 401；
  - 非 Shelly 設備走 `/shelly/` 回 404；
  - 完整流程：`dev-link` 回 `transport: 'shelly'`，`cmd` 轉成 `Switch.Set`，回覆後手機收到 `dev-ack`，`NotifyStatus` 轉成 `dev-state`。
- `tests/relay/iot-shelly-node.test.ts`（1 項，真的 Node HTTP／WS）：旗標、權杖，以及 `Switch.Set {on:false}` 到手機的 `dev-ack OFF`。
- `tests/deploy/iot-plaintext-deploy.test.ts`（7 項）：
  - 站台參數與三道閘；
  - 描述表的 `dangerous` 與打字確認詞；
  - 秘密驗證，且訊息不含金鑰；
  - CLI 的 `--shelly-switch`、輪換、門鎖類拒絕。
- **沒有驗證**：
  - 沒有接過真的 Shelly；
  - Shelly 自送 ping 的行為與 `NotifyStatus` 的頻率（會吃 20:1 訊息額度）仍待實機查證；
  - 沒有部署到 Cloudflare。
