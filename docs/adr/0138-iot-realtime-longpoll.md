# 0138. IoT 即時通道 C′ R4：長輪詢（Worker 掛住、DO 不掛）

- 狀態：**已接受（Accepted，2026-11-18）**——使用者 2026-11-18：「還沒做的功能 可以先做」
- 日期：2026-11-18
- 對應：SDK ADR 0049（IoT 路線 §9.3、§9.7 R4、§10 額度；裁示 8）、0120（C′ R2；NIP-11 的 `longpoll`）、0121（C′ R2b）、0126（DO 喚醒讀取列數）

## Context

C′ R1–R3 只有一種設備連線：常駐 WebSocket。這對 ESP-IDF、Home Assistant、Node 設備沒問題，可是有兩類設備做不到：

- **Tasmota Berry**：能發 HTTPS 請求，但沒辦法同時開著一條 wss 並按時送心跳。
- **ESPHome 的 `http_request`**：同樣只能一問一答。

ADR 0049 §9.3 與裁示 8 定了做法：長輪詢。**Worker 掛住 HTTP 請求，DO 不掛**——Worker 對 DO 開一條休眠式 WebSocket、自己用 `setTimeout` 計時。DO 裡不能有計時器，也不能掛住請求，否則失去休眠、開始按 duration 計費。R0 PoC（`poc/iot-realtime/src/worker.mjs` 的 `longPoll()`）已經驗過這條路能跑。

R4 沒做之前，NIP-11 照實宣告 `longpoll: false`（ADR 0120 §6）。

## Decision

### 1. 端點（兩個宿主相同）

| 方法與路徑 | 用途 | 回應 |
|---|---|---|
| `GET /iot/v1/dev/<homeTag>/<blindId>/next?wait=<秒>` | 等下一個 relay → 設備的幀（`cmd`／`query`） | `200`：本體就是那一個幀（JSON）<br>`204`：等到 `wait` 秒都沒有 |
| `POST …/ack`、`POST …/state` | 上行；本體＝一個設備幀，`t` 必須與路徑相同 | `204` |

- 驗證：標頭 `Authorization: Bearer <權杖>`，與 WebSocket 設備相同。Worker 在碰 DO 之前就驗，錯的不花 DO 請求。
- `wait`：夾在 10–50 秒，預設 45（§9.3）。上限低於 Cloudflare 與常見反向代理的 100 秒逾時。
- 錯誤一律是 relay 自己的結構化回應：帶 `Cinder-Relay: 1`，本體 JSON `{ error }`，錯誤字串用 ADR 0040 的詞元句。

  | 情況 | 回應 |
  |---|---|
  | 同一台設備又開了一輪，或連上了一條 WebSocket | 舊的那輪回 `409 restricted: iot-replaced:` |
  | 本體不是一個設備幀，或 `t` 與路徑不符 | `400 invalid: iot-frame:` |
  | 方法不對 | `405`，帶 `Allow` |
  | 本家今日預算用完 | `503`＋`Cinder-Quota: home-budget`＋`Retry-After`，本體帶 `reset` |
  | 掛著的那一輪被 4429 關掉 | 同上：Worker 轉成 503，`reset` 取自關閉原因 |
  | DO 異常關閉那一輪 | `503 error: iot-relay:`；設備指數退避 |

- 信封解不開時，relay 照樣回 `204`。這與 WebSocket 設備的「壞幀丟掉不回應」相同：不給 oracle。

### 2. Workers：Worker 掛住，DO 不掛

1. Worker 驗過權杖之後，對 DO 送一個 WebSocket 升級（路徑 `/next`）。
2. DO 接受這條連線：tag 仍是 `dev:<blindId>`，attachment 加 `transport: 'longpoll'`。DO 立即回 101，不等待。
3. Worker `accept()` 這條連線，`setTimeout(wait)` 等待：
   - 收到第一個訊息 → `200`；
   - 逾時 → 自己關掉連線並回 `204`；
   - 連線被關 → 依 close code 轉成上表的回應。
4. **DO 送出一個幀就立刻關掉那條連線。** 否則下一個指令可能送進一條 Worker 已經在收尾的連線，就此遺失。
5. 同一台設備短暫有兩條連線時，取 attachment 時間最新的那條，不靠 `getWebSockets()` 的順序。
6. 長輪詢沒有心跳：掛著的一輪本身就證明設備剛剛還在，不判 `stale`。

### 3. 兩輪之間的空檔：短暫保留，不是排隊

設備收到 `200` 之後，要先處理、回 `POST ack`，再發下一輪。這段空檔通常不到一秒，但不能被當成離線。

- `IotRealtimeHome` 記住每台設備上一輪結束的時間。
- 設備在 `IOT_LONGPOLL_HOLD_SEC`（10 秒）內結束過一輪，就仍當作在線。這段空檔裡來的指令：
  - 保留下來，每台最多 `IOT_LONGPOLL_HOLD_MAX`（8）則，到期＝當下＋10 秒；
  - 下一輪 `/next` 一開始就交出第一則：DO 直接回 `200`，不開 WebSocket，也省一次關閉事件。
- 超過上限，或設備超過 10 秒沒回來 → 照舊回 `offline`。過期的保留不送、不重送。
- 這**不是排隊**（§10.5-4）：
  - 保留只在記憶體裡、只有幾秒，不落庫；DO 休眠後就沒了，那時指令回 `offline`。
  - 設備端的信封時間窗（±60 秒，門類 15 秒）照樣把關。
- 沒有計時器：到期判斷在下一次查詢時順手做。

### 4. 額度（§10）

- 每一輪約花 1 個 Worker 請求，加 1–2 個 DO 請求（升級，加 Worker 關閉時的 `webSocketClose`）。兩個都計入本家預算。上行的 `POST` 各計 1 個。
- **95% 分流**（§10.3）：`POST state` 回 `503`＋`Cinder-Quota: home-shed`＋`Retry-After`，遙測先丟。
  - `/next` 與 `POST ack` 照常。指令與它的結果比遙測重要，這與 WebSocket 設備在分流時「丟 state、留 ack」一致。
  - **與 PoC 不同**：PoC 在 shed 時連 `/next` 一起拒絕。那樣長輪詢設備會整天收不到指令，和 §10.3「先丟遙測」的意思相反。
- 100% 用完：與既有行為相同。新的請求回 `503 home-budget`；掛著的那一輪被 4429 關掉，Worker 轉成 503。
- Worker 先擋掉壞幀（解析設備幀、比對 `t`），不花 DO 請求。
- `IOT_UPGRADE_LIMIT`（選配的每 IP 限速）也套在 `/next` 上，`POST` 不套。

### 5. 休眠喚醒後的扇出（順手修的既有錯誤）

DO 休眠喚醒後是新的實例，手機的訂閱要等 `ensureHydrated()` 才回到 `RelayCore`。原本只有手機送訊息時才還原。

- 若喚醒後是**設備先開口**（WebSocket 幀或長輪詢的 `POST`），`publishLocal` 找不到任何訂閱，25171／25172 就沒人收到。
- 現在設備的上行只要有事件要扇出，就先還原。
- 還原讀的是連線的 attachment 與 `ConnPersistence`，列數等於手機連線數，不掃訊息表（ADR 0126）。
- 新測試「既有的 WebSocket 設備：休眠喚醒後設備先送 ack」在修正前失敗、修正後通過。

### 6. Node 宿主

- 自架主機直接掛住 HTTP 回應：Node 沒有休眠與 duration 計費，可以用計時器。
- 端點、狀態碼與空檔保留都和 Workers 相同，共用同一個 `IotRealtimeHome`。
- 設備那頭斷線（`res` 的 `close`）時，開始計算空檔。
- Node 沒有本家預算，所以沒有 503 分流。
- `IotNodeHub.handleHttp` 改成 `(req, res) => boolean`。這是內部介面，套件沒有匯出 `iot-node`。

### 7. 對外介面

| 介面 | 變更 |
|---|---|
| NIP-11 | `cinder_iot.realtime.longpoll` 改為 `true`，兩個宿主都已實作 |
| `IotRealtimeSockets`（宿主介面） | 新增選用的 `transportOf(blindId)`；沒給＝一律 `ws` |
| `IotRealtimeHome` | 新增 `longPollStart(blindId)`、`longPollEnded(blindId)` |
| `./relay/iot-realtime` 匯出 | 新增：<br>• `IOT_LONGPOLL_HOLD_SEC`、`IOT_LONGPOLL_HOLD_MAX`<br>• `IOT_LONGPOLL_DEFAULT_WAIT_SEC`、`…_MIN_WAIT_SEC`、`…_MAX_WAIT_SEC`<br>• `iotLongPollWaitSec()`<br>• 型別 `IotRealtimeTransport` |
| `dev-link` 的 ack 本體（25171） | 新增選用欄位 `transport: 'ws' \| 'longpoll'` |
| `IotClient.deviceLink()` | 對長輪詢設備回 `transport: 'longpoll'` |
| `iot-home-room` | 匯出 `iotQuotaResponse()`；`IotPath` 的 `dev` 多一個選用的 `op` |

環境變數與部署設定都沒有改：長輪詢跟著 C′ 一起開，不需要另一個開關。

## Alternatives Considered

- **DO 掛住請求、自己用 alarm 或 `setTimeout` 計時**：會失去休眠、按 duration 計費，正是裁示 8 要避開的。
- **Worker 每秒輪詢 DO**：每輪會變成數十個 DO 請求。
- **空檔內的指令直接回 `offline`、不保留**：`ack` 到下一輪之間的指令（例如連按兩下）幾乎都會失敗，對長輪詢設備不可用。
- **保留到下一輪、沒有上限**：那就是排隊，違反 §10.5-4，DO 休眠後還會遺失。
- **95% 時連 `/next` 一起拒絕（PoC 的做法）**：理由見決策 4。

## Consequences

- 正面：
  - Tasmota Berry 與 ESPHome 這類只能一問一答的設備也能接 C′，端到端加密不變。
  - 修好了休眠喚醒後「設備先開口，手機收不到」的扇出錯誤。WebSocket 設備也受惠。
- 負面與已知殘餘風險：
  - 長輪詢設備比 WebSocket 設備貴：每 45 秒約 2 個 DO 請求，一天約 3,800 個，WebSocket 設備約 45–65 個（§9.7 R0 實測）。免費方案下，一個家只適合少數幾台長輪詢設備。
  - 空檔內保留的指令，在 DO 休眠後會遺失（手機那邊是 5 秒後的 `unknown`，再自動查詢）。
  - Worker 掛住請求的成本（Workers 請求數與 wall time）以 PoC 的數字估計，**還沒在正式錨點量過**。
  - 本 ADR 改了 `src/relay/` 的 Worker 原始碼，`src/deploy/cloudflare-api/relay-worker-bundle.ts` 要在發版時重建（`npm run build:worker-bundle`）。在那之前，`tests/deploy/relay-worker-bundle.test.ts` 的「與原始碼一致」會失敗。

## 驗證

- `tests/relay/iot-longpoll-core.test.ts`（7 個）：
  - 掛著的一輪直接交出指令，沒有心跳也不判 `stale`；
  - `dev-link` 回報 `transport: longpoll`；
  - 空檔內保留並在下一輪交出；
  - 超過 10 秒丟掉；
  - 每台上限 8 則；
  - 沒輪詢過的設備回 `offline`；
  - `wait` 夾值。
- `tests/relay/iot-longpoll-worker.test.ts`（11 個，假的 DurableObjectState 加成對的假 WebSocket）：
  - NIP-11 宣告 `longpoll: true`；
  - 權杖錯不碰 DO；
  - 等待中來指令回 200，DO 送完就關掉那條；
  - 逾時回 204，空檔指令在下一輪直接回 200，不開連線；
  - 又開一輪時舊的回 409；
  - 預算用完回 503，等待中被 4429 關掉也轉成 503；
  - `POST ack` 在休眠喚醒後仍扇出；
  - 400／405；
  - 95% 時 `state` 回 503 `home-shed`、ack 照轉；
  - WebSocket 設備在休眠喚醒後先送 ack，手機仍收得到。
- `tests/relay/iot-longpoll-node.test.ts`（4 個，真的 HTTP）：
  - 401／405／426；
  - 等待中來指令回 200，`dev-link` 回報 `longpoll`；
  - 斷線後的空檔保留；
  - 409、`POST ack` 回 204 並扇出、400。
- `tests/iot/realtime.test.ts`：`deviceLink` 對長輪詢設備回 `transport: 'longpoll'`。
- **沒有驗證**：
  - 沒有部署到 Cloudflare；
  - 沒有用真的 Tasmota Berry 或 ESPHome 設備跑過；
  - 長輪詢的實際 DO 請求數與 Worker wall time 沒有在 GraphQL Analytics 量過。
