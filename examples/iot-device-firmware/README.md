# ESP-IDF／ESPHome 設備：規格與骨架（**未經實機驗證**）

> SDK ADR 0140。這裡**只有規格說明與程式骨架**，沒有完整、編譯過、燒過真機的韌體。
> 手邊沒有 ESP32／Tasmota／Shelly 實機（使用者 2026-11-18 裁示範圍：Python 參考設備＋跨語言測試向量）。
> 可以完整驗證的參考實作是 [`../iot-device-python`](../iot-device-python)；韌體作者請以
> [`tests/fixtures/iot-device-v1.vectors.json`](../../tests/fixtures/iot-device-v1.vectors.json) 為準，每一類向量都要過。

## 必須做到（ADR 0049 §9、§10.2、§10.5）

| 項目 | 要求 | 向量 |
|---|---|---|
| 連線 | `wss://<relay>/iot/v1/dev/<homeTag>/<blindId>`，標頭 `Authorization: Bearer cit1_…` | — |
| TLS | **必須驗證伺服器憑證**：ESP-IDF 用 `esp_crt_bundle_attach`（憑證包）；`esp_websocket_client` 沒給 `cert_pem`／`crt_bundle_attach` 時**預設不驗證**，參考實作要強制開。**不得釘單一 CA**（Cloudflare 邊緣憑證會換 CA） | — |
| 心跳 | 每 30 秒送 `{"t":"hb"}`（逐位元組相同，否則每則都計費）；10 秒內沒收到 `{"t":"hb-ack"}` 就斷線重連 | `frames.heartbeat`、`heartbeatAck` |
| 自動重連 | **關掉** `esp_websocket_client` 的固定 10 秒重連（`disable_auto_reconnect = true`），改用 §10.2 的排程器 | `backoff.classify`、`backoff.delay` |
| 信封 | AES-256-GCM；AAD＝`cinder-iot/v1|<dir>|<kid>|<ctr>|<ts>`；down nonce 首位元組 0x00，up nonce＝`01 00 00 00`＋8 bytes 大端 ctr；base64 標準字母有補齊 | `envelope.seal`、`envelope.open` |
| 計數器 | up 的 ctr 嚴格遞增、**先寫 NVS 再送**；建議一次預留一個區塊（例如 +64）減少快閃寫入，重開機從存的值往上跳 | `device.scenarios`（計數器） |
| 時鐘 | SNTP 同步前**拒絕所有指令**（回 `rejected`／`clock-unsynced`）；時間窗一般 ±60 秒、門類 ±15 秒；內容的 `exp` 已過也拒絕 | `device.scenarios` |
| 去重 | 同一個 msgId 不再執行，重送當時的 ack（新的 ctr）；至少記 256 筆 | `device.scenarios` |
| 門鎖類 | `cmd` 只用 `deviceKeyDown` 解；`query` 用 `deviceKey`；解不開不回任何東西。**必須保留不依賴網路的開啟方式**；斷線、額度用完、時鐘未同步、解密失敗時**維持目前狀態**，不得自動解鎖 | `device.scenarios`（門鎖） |
| 額度 | close 4429 `iot-quota:<reset>` 或 503＋`Cinder-Quota` ⇒ 睡到 reset＋0–20 分鐘隨機；時鐘沒同步時每 60 分鐘探測一次；權杖錯等設定錯誤每 60 分鐘探測一次 | `backoff.*` |

## ESP-IDF 骨架（未編譯、未燒錄）

```c
// 只示意結構與必要旗標；加解密、JSON、NVS 的細節照向量實作。
esp_websocket_client_config_t cfg = {
    .uri = CONFIG_CINDER_IOT_URL,                  // wss://…/iot/v1/dev/<homeTag>/<blindId>
    .headers = "Authorization: Bearer " CONFIG_CINDER_IOT_TOKEN "\r\n",
    .crt_bundle_attach = esp_crt_bundle_attach,    // 🔴 一定要驗證憑證
    .disable_auto_reconnect = true,                // 🔴 改用 §10.2 排程器
    .ping_interval_sec = 0,                        // 用應用層心跳字串（relay 設定了自動回覆）
    .network_timeout_ms = 10000,
};
// on WEBSOCKET_EVENT_DATA：
//   if (len == 14 && memcmp(data, "{\"t\":\"hb-ack\"}", 14) == 0) { hb_acked(); return; }
//   frame = parse_frame(data)                    // 只收 t=cmd|query、env.dir=down、kid 相符
//   key   = (t == CMD && is_lock) ? key_down : device_key
//   pt    = aes_gcm_open(key, nonce, aad(dir,kid,ctr,ts), ct)   // mbedtls_gcm_auth_decrypt；失敗就 return
//   msg   = parse_down(pt)                       // type 必須等於 t
//   if (seen(msg.msgId))       resend_ack(...)
//   else if (!sntp_synced())   ack_rejected("clock-unsynced")
//   else if (abs(ts-now)>skew || msg.exp<now) ack_rejected("expired")
//   else                       ack(execute(msg))
// send_up(msg)：ctr = nvs_reserve_next(); env = aes_gcm_seal(device_key, up_nonce(ctr), aad("up",kid,ctr,now), json(msg))
```

## ESPHome 外部元件骨架（未實作）

ESPHome 官方沒有 WebSocket 客戶端元件；可行的兩條路：

1. **外部元件**（`external_components`）包裝 ESP-IDF 的 `esp_websocket_client`，照上面的 C 骨架實作，
   對 ESPHome 暴露 `on_command`（topic、payload）與 `publish_state`。
2. **長輪詢**（ADR 0049 §9.3 R4，尚未實作）：用官方 `http_request` 元件輪詢
   `GET …/next?wait=45`——等 R4 完成後再補。

```yaml
# 示意：外部元件尚不存在
external_components:
  - source: github://VaalRL/cinderous-sdk/examples/iot-device-firmware/esphome   # 未提供
cinder_iot:
  url: !secret cinder_iot_url
  token: !secret cinder_iot_token
  kid: lamp.0
  device_key: !secret cinder_iot_key
  max_skew_sec: 60
  on_command:
    - lambda: 'if (topic == "home/lamp/power") id(relay1).publish_state(payload == "ON");'
```

## 驗收建議（有實機時）

1. 把向量檔的 `envelope.seal`、`envelope.open`、`device.scenarios` 做成設備上的自我測試（開機時跑一次）。
2. 對本機 Node relay（`cinderous iot realtime home|device` 產生設定）跑 `python -m cinder_iot_device` 與韌體並排，比對 relay 端看到的幀。
3. 斷網、拔 DNS、把 relay 設成 4429，確認退讓間隔符合 `backoff.delay`，且不會每 10 秒重連一次。
