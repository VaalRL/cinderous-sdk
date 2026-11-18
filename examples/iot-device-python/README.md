# Python 參考設備（Cinderous IoT C′ 即時通道）

> SDK ADR 0140。授權 MIT-0（與 `examples/iot-device` 相同：設備端照抄不受 AGPL 約束）。
> 協定：SDK ADR 0049 §2.1、§2.6、§9、§10.2；ADR 0120。

一個 Python 寫的 C′ 設備：常駐一條 `wss` 到 relay，收手機的指令、回 ack 與狀態。
用途有三：

1. **跨語言的參考實作**——和 TypeScript 的 `@cinderous/client/iot/device` 以同一份測試向量
   （[`tests/fixtures/iot-device-v1.vectors.json`](../../tests/fixtures/iot-device-v1.vectors.json)）驗證，輸出的設備幀逐位元組相同。
   寫韌體（ESP-IDF、ESPHome、Tasmota Berry）時拿它當對照。
2. **樹莓派、NAS、Home Assistant 主機**直接當設備用（`python -m cinder_iot_device`）。
3. Home Assistant 自訂整合的骨架（`homeassistant/custom_components/cinder_iot`，**未在 HA 裡實測**）。

## 結構

| 檔案 | 內容 |
|---|---|
| `cinder_iot_device/crypto.py` | HKDF、盲化、`deviceKey`／`deviceKeyDown`、設備權杖、信封（AES-256-GCM） |
| `cinder_iot_device/protocol.py` | 設備幀、down／up 明文、topic 規則 |
| `cinder_iot_device/core.py` | 協定核心（sans-IO）：收一則幀、回要送的幀；時間窗、fail-closed、去重、計數器先存再送 |
| `cinder_iot_device/backoff.py` | §10.2 斷線分類與重連間隔（額度用完／設定錯誤／relay 故障／網路斷） |
| `cinder_iot_device/clock.py` | SNTP 與 `ClockGuard`（同步前拒絕所有指令） |
| `cinder_iot_device/counter.py` | up 計數器存檔（暫存檔＋fsync＋原子換名；可預留區塊減少寫入） |
| `cinder_iot_device/device.py` | `websockets` 連線、應用層心跳、依分類退讓、備援站 |
| `cinder_iot_device/__main__.py` | 以環境變數設定的示範設備 |

## 使用

```sh
python -m venv .venv && . .venv/bin/activate      # Windows：.venv\Scripts\activate
pip install -r requirements-dev.txt

# 在 relay 端登錄設備（輸出 IOT_DEVICE_TOKEN／KID／KEY／BLIND_ID）
npx cinderous iot realtime device lamp

export IOT_DEVICE_URL=wss://relay.example/iot/v1/dev/<homeTag>/<IOT_DEVICE_BLIND_ID>
export IOT_DEVICE_TOKEN=cit1_…  IOT_DEVICE_KID=lamp.0  IOT_DEVICE_KEY=<64 位 hex>
python -m cinder_iot_device
```

環境變數的完整清單見 `cinder_iot_device/__main__.py` 開頭。

- **時鐘**：預設以 SNTP 同步，同步前所有指令回 `rejected`／`clock-unsynced`。主機已由作業系統做 NTP 時可設 `IOT_TRUST_SYSTEM_CLOCK=1`。
- **憑證**：`wss` 一律驗證伺服器憑證（系統 CA），不釘單一 CA。
- **計數器檔**：`IOT_DEVICE_COUNTER_FILE`。刪掉它等於讓 ctr 倒退——手機與 relay 會把之後的回報當成重放丟掉，直到超過舊值。

## 測試

```sh
python -m pytest            # 196 項：向量（金鑰、權杖、信封、幀、明文、§10.2、設備行為逐位元組）＋執行期（本機假 relay）
```

SDK 端還有一個選用的端對端測試（`tests/iot/python-device-e2e.test.ts`）：真的 Node 中繼＋TypeScript 手機端 `IotClient`＋這個 Python 設備，
指令往返與查詢。有 `.venv`（或設 `CINDER_IOT_PYTHON`）才會跑，否則略過。

## 沒驗證的

- 沒有部署到 Cloudflare 跑過（Workers 的休眠與自動回覆時間戳只在本機 Node relay 驗過）。
- Home Assistant 整合只是骨架，沒有在 HA 裡載入過；`cinder_iot_device` 要自己放進 HA 的 Python 環境。
- 長輪詢（R4）與 Shelly 轉譯（R5）不在這裡。
