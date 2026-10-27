<!-- SPDX-License-Identifier: MIT-0 -->
# 設備端推播送出流程（規格＋Node 參考實作）／Device-side push sending (spec + Node reference)

> SDK ADR 0049 §11.1（使用者裁示 3：**誰知道端點誰就送**）。本資料夾以 **MIT-0** 授權（裁示 7）：韌體可以照抄、不必署名。
> SDK 本體（`@cinderous/client`）仍是 AGPL-3.0-only；這裡的程式**不引用** SDK。
> This folder is **MIT-0** licensed (copy freely into firmware, no attribution). It does not use the SDK, which stays AGPL-3.0-only.

- `push-sender.mjs`：Node 18+ 參考實作（零相依；`node:crypto`＋`fetch`）。SDK 的測試 `tests/iot/device-example.test.ts` 逐位元組比對它與 SDK 的喚醒請求，並讓它對 SDK 的參考推播閘道真的送一次。
- ESP32（ESP-IDF）與 Tasmota Berry 的版本屬於 C′ 階段，尚未提供；照本規格與下面的測試向量實作即可。

## 1. 角色

設備能力足夠（ESP32、Node／Home Assistant 類設備）時，**設備自己就是送出端**：不經 IoT 閘道與中繼，延遲最短、不吃中繼額度。
做不到的設備由路線 A 的 IoT 閘道（`IotGateway` 的 `push` 選項）或日後的中繼代送。三者送出的請求格式完全相同。

## 2. 設備保存什麼

手機以加密指令把登記送到保留 topic `$sys/push`（C′ 的設備信封裡，明文就是下面的 JSON），設備解開後保存（NVS／檔案，**權限只給自己**）：

```json
{ "id": "<22 字元端點 id>",
  "endpoint": { "type": "unifiedpush", "url": "https://ntfy.example/up…" },
  "subscriptions": [{ "dv": "<這台設備的盲化 id>", "mode": "standard" }],
  "expiresAt": 1762092000 }
```

或推播閘道端點：

```json
{ "type": "gateway", "url": "https://push.example", "sealed": "cp1.<64 hex>.<base64>", "key": "<64 hex，每次登記獨有的密鑰>" }
```

- `expiresAt`（Unix 秒）：TTL 預設 30 天；過期就刪（手機啟動時會重新登記＝續期）。
- 每台設備最多保存 32 個端點（`maxEndpoints`）。
- `dv`＝`blind("dev:" + 設備 id)`（ADR 0049 §2.1）；設定時由 CLI 算好寫入設備，設備不需要家庭秘密。
- 🔴 端點本身就是能力（知道 UnifiedPush 網址或「封包＋密鑰」就能喚醒那支手機）：**不要記進日誌、不要回報給任何人**。

## 3. 什麼時候喚醒

訂閱的設備（`dv`）**狀態有變化**時（重複回報同一個值不算）。喚醒請求**一律是空的**：不含設備、內容、類別——手機醒來後自己連中繼讀 retained（31170），在本機解密、自己判斷要不要通知。

## 4. 喚醒請求

### 4.1 UnifiedPush（`type: "unifiedpush"`）

```
POST <url>
TTL: 3600
Urgency: high
（本文空的；RFC 8030 §5 沒有內容的推播）
```

### 4.2 推播閘道（`type: "gateway"`）

```
POST <url>/v1/wake
Content-Type: application/json

{"v":1,"sealed":"<封包，原樣>","ts":<毫秒>,"sig":"<hex>"[,"ref":"<64 hex 事件 id>"]}
```

- `regId` ＝ base64url（無補齊）(SHA-256(`sealed` 的 UTF-8)) 的前 22 字元。
- 要簽的字串（換行是 `\n`）：`cinder-push/v1/wake` ⏎ `ts` ⏎ `ref`（沒有就空字串）⏎ `regId`。
- `sig` ＝ hex(HMAC-SHA256(hex 解碼後的 `key`, 上面的字串))。
- `ts`：毫秒，**同一個端點嚴格遞增**，而且與推播閘道的時鐘相差不超過 300 秒（設備要有 SNTP）。
- `ref`：只能是 64 位小寫 hex（Nostr 事件 id，給 iOS NSE 回中繼取）；設備送出時通常沒有，就省略。
- 本文**只能**有這五個欄位；多一個（設備、類別、標題）推播閘道就回 400。

### 4.3 回應

| 狀態 | 意思 | 設備要做的事 |
|---|---|---|
| 2xx | 送出了 | — |
| 404、410 | 端點失效（App 解除安裝、token 過期、已撤銷） | **刪掉這個端點** |
| 429、503 | 太頻繁或對方忙 | 在 `Retry-After` 秒內不送這個端點，這次的喚醒延後 |
| 其他 | 錯誤 | 照標準間隔重試，一次喚醒最多送 3 次 |

## 5. 合併＋抖動（每個端點各自計算）

| 模式 | 規則 |
|---|---|
| `standard`（預設） | 每 60 秒最多 1 次；排程時加 0–30 秒隨機延遲；等待中再來的事件**合併**（不另外送） |
| `instant` | 不合併；0–2 秒隨機延遲；但每分鐘最多 6 次（含標準），超過就等到視窗空出來 |

即時送出時，等待中的標準喚醒一併滿足。隨機數不必是密碼學等級，但不要每台設備都一樣（例如以 MAC 位址為種子）。

## 6. 測試向量

```
sealed = "cp1.1111111111111111111111111111111111111111111111111111111111111111.QUJD"
key    = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
ts     = 1759500000000
ref    = eeee…eeee（64 個 e）

regId            = C0v6M-ptLDss6WUUOFvMj-
sig（沒有 ref）   = 27e6d0280a3ecb9d30f77bf4cac256aac6940dcd8bdfb1ffd352da98bda5df0c
sig（有 ref）     = 786f8b9235325245e783eaf2e4af2515ab5a6a7b02f1f2d94a62cc0867bb38e7
```

## 7. ESP32（ESP-IDF）提示

- HMAC：`mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32, msg, len, out)`；SHA-256：`mbedtls_sha256`。
- HTTP：`esp_http_client`（https 要 `esp_crt_bundle_attach`）；時間：`esp_sntp`，**時間還沒同步就不要送**（推播閘道會以時間窗拒絕）。
- 失敗時維持設備目前的狀態——推播只是「通知手機」，與設備的動作無關。

## 8. 用法（Node）

```js
import { createPushSender } from './push-sender.mjs';

const sender = createPushSender({ registrations, onGone: (id) => removeFromStorage(id) });
// 門被打開了（這台設備的盲化 id）
sender.notifyDevice(myBlindId);
```
