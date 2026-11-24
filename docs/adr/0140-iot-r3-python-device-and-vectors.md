# 0140. IoT 即時通道 C′ R3：Python 參考設備與跨語言測試向量

- 狀態：**已接受（Accepted，2026-11-18）**——Cinderous 使用者 2026-11-18 裁示範圍：「Python／Home Assistant 參考設備＋跨語言測試向量」；ESP-IDF／ESPHome 只寫規格與骨架
- 日期：2026-11-18
- 對應：SDK ADR 0049 §2.1、§2.6、§9（§9.7 R3）、§10.2、§10.5；ADR 0120、0121、0122

## Context

C′ 的 relay 端（R1）與手機端、`./iot/device`（R2，ADR 0120／0121）都做完了，但設備端只有 TypeScript 版。
§9.7 的 R3 原本要做 ESP-IDF／ESPHome 外部元件、HA／Python 參考實作與跨語言向量。

手邊沒有 ESP32、Tasmota、Shelly 實機。不經實機就寫完整的 C 元件，只能編譯檢查，最危險的部分——
TLS 憑證驗證、`esp_websocket_client` 的自動重連、NVS 計數器、SNTP——全都驗證不到，卻會給人「已有參考韌體」的錯覺。
使用者因此選了：**能完整驗證的部分做到底（Python 設備＋向量），韌體只給規格與骨架、明確標示未驗證**。

另一個缺口：§10.2 的「斷線分類」（額度用完／設定錯誤／relay 故障／網路斷）只寫在 ADR 的表格裡，TypeScript 設備只實作了
close 4429／4409 兩種，而且額度用完的隨機延遲是 0–60 秒（ADR 寫的是 0–20 分鐘）。韌體作者沒有可以對照的實作。

## Decision

1. **跨語言測試向量 `tests/fixtures/iot-device-v1.vectors.json`**，由 TypeScript 實作產生（`tests/iot/device-vectors.test.ts`）：
   - `keys`：家庭秘密 → `topicKey`、`homeTag`、盲化、`deviceKey`、`deviceKeyDown`；
   - `token`：權杖雜湊、格式、驗證；
   - `envelope`：封裝（down 固定 nonce、up 由 ctr 決定 nonce、超過 32 位元的 ctr、UTF-8）與 17 個解開情境（`format`／`nonce`／`auth` 三種錯誤）；
   - `frames`、`messages`：設備幀與 down／up 明文的解析，含各種不合法輸入；
   - `backoff`：§10.2 的 20 個觀察的分類，與固定亂數下的重連間隔；
   - `device`：18 個設備行為情境——把 relay 的幀餵給 SDK 的 `connectIotDevice`，記下它執行了什麼、**送出的每一個幀（逐位元組）**、計數器的終值。
   測試每次重新產生、與檔案逐欄比對：協定或實作改了，向量就對不上。有意改協定時以 `UPDATE_IOT_VECTORS=1` 重寫，並在 ADR 寫明。
   檔案在 `tests/fixtures/*.vectors.json -text` 之下，逐位元組保留。
2. **§10.2 的退讓做成純函式**（`src/iot/device-backoff.ts`，由 `./iot/device` 匯出）：
   - `classifyIotDeviceDisconnect(observation, nowSec)`：HTTP 被拒（看 `Cinder-Relay`、`Cinder-Quota`、`Retry-After`、本文的詞元與 1027）、
     close code、網路失敗、心跳逾時 → `quota-exhausted`／`config-error`／`relay-error`／`network-down`／`replaced`；
   - `iotDeviceRetryDelayMs(disconnect, { attempt, nowSec, clockSynced, random })`：額度 → 睡到 reset＋0–20 分鐘（時鐘沒同步或不知道 reset → 每 60 分鐘探測）；
     設定錯誤 → 60 分鐘；被擠掉 → 60 秒；relay 故障 → 5 秒起加倍到 10 分鐘 ±30%（`Retry-After` 是下限）；網路斷 → 1 秒起加倍到 60 秒 ±30%；任何情況 ≥ 1 秒。
     計算順序固定（先夾上限、再乘抖動、最後取整），JavaScript 與 Python 的倍精度結果逐位相同。
   - `connectIotDevice` 的額度退讓改用它（**行為改變**：重置後的隨機延遲由 0–60 秒改成 0–20 分鐘，符合 §10.2；不知道 reset 時由 60 秒改成 60 分鐘）。
     其他斷線維持原本的指數退避——瀏覽器與 Node 的 WebSocket 看不到升級被拒的 HTTP 狀態，分不出 401 與網路斷。
3. **Python 參考設備 `examples/iot-device-python`（MIT-0，與 `examples/iot-device` 相同：韌體與設備端可照抄）**：
   - `crypto`、`protocol`、`backoff` 與 TypeScript 逐條對應；`core.DeviceCore` 是 sans-IO 的協定核心，順序與 `connectIotDevice` 相同；
   - `device.DeviceRunner`（`websockets`）：`Authorization: Bearer`、`wss` 一律以系統 CA 驗證憑證（不釘 CA）、應用層心跳（不用協定 ping）、
     升級被拒時讀得到 HTTP 狀態與本文，所以 §10.2 **全部**分類都用得上；備援站在額度用完、relay 故障、設定錯誤時輪換；
   - `clock.ClockGuard`：SNTP，同步前與超過 24 小時沒同步都視為不同步（指令回 `clock-unsynced`）；
   - `counter.FileCounterStore`：暫存檔＋fsync＋原子換名，可一次預留一個區塊減少快閃寫入，重開機只會往上跳；
   - `python -m cinder_iot_device`：環境變數名稱與 `cinderous iot realtime device` 的輸出相同；
   - `homeassistant/custom_components/cinder_iot`：HA 自訂整合骨架（指令 → HA 服務、實體狀態 → 25172），**沒有在 HA 裡載入過**。
4. **測試**：
   - pytest 196 項：所有向量（設備幀逐位元組比對）＋執行期（計數器、SNTP 解析、時鐘守門，以及以本機 `websockets` 假 relay 測連線、心跳、401／503／4429／4409／連不上的分類與間隔）；
   - vitest `tests/iot/python-device-e2e.test.ts`（選用）：真的 Node 中繼＋TypeScript `IotClient`＋Python 設備子程序，指令往返與查詢。
     有 `examples/iot-device-python/.venv`（或 `CINDER_IOT_PYTHON`）才跑，否則略過——CI 不裝 Python 相依，逐位元組相容由向量保證。
5. **ESP-IDF／ESPHome：`examples/iot-device-firmware/README.md`** 只寫必須做到的事（對照向量的哪一節）與骨架：
   強制憑證包、關掉固定 10 秒自動重連、心跳字串逐位元組、NVS 計數器先存再送、SNTP fail-closed、門鎖類的本地開啟方式與失敗時維持現狀。
   ESPHome 沒有官方 WebSocket 客戶端，外部元件或長輪詢（R4）兩條路都標為未提供。
6. 套件內容不變：`package.json` 的 `files` 只有 `dist`、`schema` 等，`examples/` 與 `tests/fixtures/` 不會進安裝包。

## Consequences

- ＋ 韌體作者有一份可執行的規格：每一類向量都過，就和 SDK 的手機端、relay 互通；Python 設備已經在真的 Node 中繼上跑通。
- ＋ §10.2 從表格變成程式，`connectIotDevice` 的額度退讓也照它改正，不會在午夜重置的同一分鐘湧進。
- － 行為改變：`connectIotDevice` 收到 4429 時等更久（重置後最多再等 20 分鐘；不知道重置時間時 60 分鐘探測一次）。
- － 沒驗證的：
  - 沒有部署到 Cloudflare（Workers 的休眠、自動回覆在雲端的行為仍只在 R0 PoC 量過）；
  - 沒接過任何真的 ESP32／Tasmota／Shelly；ESP-IDF 與 ESPHome 只有骨架；
  - Home Assistant 整合沒在 HA 裡跑過；
  - Python 的 topic 長度以 UTF-16 碼元計（與 JavaScript 相同），但 `reason` 截斷是以碼位計——只有非 BMP 字元會差，設備自己的 reason 不該用到。
- R4（長輪詢）與 R5（Shelly 轉譯）不在這份 ADR。

## 程式碼審查修正（2026-11-18，v0.92.0）

- **等待時間有上限**：`iotDeviceRetryDelayMs` 任何類別最後夾在 [1 秒, `IOT_DEVICE_MAX_RETRY_MS`＝25 小時]；`relay-error` 的 `Retry-After` 最多算 60 分鐘。
  原本惡意或有 bug 的 relay 給一個很遠的 `reset`（或很大的 `Retry-After`）就能讓設備睡好幾年；JavaScript 的 `setTimeout` 超過 2^31−1 毫秒還會溢位成「立刻重連」。
  額度的 reset 先夾秒數再換毫秒（`reset` 接近 2^53 時兩種語言結果仍逐位相同）。向量新增 4 筆邊界案例，舊案例的期望值都沒變。
- `attempt`、`random` 不是有限數就當 0（原本會回 NaN）。
- Python 的 `\d` 預設認所有文字的數字（`int("٣٠") == 30`），TypeScript 不認：分類用的正規式一律加 `re.ASCII`。
- **Python 參考設備定期重新同步時鐘**：原本只在開機同步一次，`max_age_sec`（24 小時）後變成「不同步」、之後所有指令都回 `clock-unsynced`——設備等於壞掉。
  新增 `ClockGuard.keep_synced()`（每 5 分鐘檢查、超過 6 小時就重新同步、失敗下一輪再試；SNTP 放到執行緒，不卡事件迴圈），`python -m cinder_iot_device` 會在背景跑它。開機沒同步成功的也會一直重試。
- Python `DeviceRunner`：這一輪有連上過才斷的，下一次退避從頭算（原本每天斷一次的設備，幾天後每次都要等到上限）。
