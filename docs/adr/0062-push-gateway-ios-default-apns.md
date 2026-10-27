# 0062. 推播閘道的 iOS 預設改為直連 APNs（兩版）、iOS 經 FCM 在 Node 版也棄用、從 FCM 改過來不設過渡期

- 狀態：**已接受（Accepted，2026-10-06）**——使用者 2026-10-06 對 ADR 0061〈Open〉三題的裁示；§6（APNs `reason` 進日誌）依同日邊緣實測追加；實作於 v0.48.0（**breaking**）
- 日期：2026-10-06
- 對應：ADR **0061**（Workers 版直連 APNs；本 ADR 了結它的 Open 前兩題，並把第 7 項「從 `fcm` 改成 `apns`」的遷移代價定為最終行為）、
  ADR **0049 §11.1 第 5 項**（推播閘道的宿主）、ADR **0050**（部署設定器：§6 影響部署的變更）。

## Context

v0.47.0（ADR 0061）讓 Workers 版推播閘道的 iOS 也能直連 APNs，但為了「只設 FCM 的既有部署重新部署後行為不變」，保留了三件事：

1. `pushGateway.ios`／`PUSH_IOS` 沒寫時仍是 `fcm`；
2. 只有 Workers 版的 `ios: fcm` 標為棄用（Node 版的 `fcm` 不警告）；
3. 從 `fcm` 改成 `apns` 時，舊的（封 FCM token 的）iOS 登記回 501、要等 App 重新登記——推播閘道不會偷偷改走 Google。

ADR 0061 把前兩件列為 Open（「Node 版的 `ios: fcm` 要不要也棄用」「預設值何時改成 `apns`」）。使用者 2026-10-06 裁示：
**兩版都棄用、現在就改預設、不設過渡期**。理由是目前還沒有任何部署者，打破只設 FCM 的舊設定檔可以接受；
而「iOS 經 Google」與 SDK 的隱私預設（第三方看得到的越少越好）相反，不該是沒寫時的行為。

同日以設定器產生的 v0.47.0 Workers 版推播閘道在 Cloudflare 邊緣實測（測試帳號；完整紀錄見 ADR 0061〈實測〉）：sandbox 主機 2／2 通過
（`400 BadDeviceToken`→`gone`、送出端收到 410，710–842 ms）；同一把金鑰送 production 主機 2／2 是 502 `upstream`、日誌 `error-auth`。
使用者確認那把金鑰建立時只選了 Sandbox，所以失敗是預期的、原因很可能是 `BadEnvironmentKeyInToken`——但 `apnsResultOf` 把所有 403 都歸成 `auth`，
日誌與回應都沒有 APNs 的 `reason`，分不出它與 `InvalidProviderToken`／`ExpiredProviderToken`。

## Decision

1. **預設值改為 `apns`（兩版）**：
   - 執行期：`PUSH_IOS` 沒寫或空白＝`apns`。新增 `DEFAULT_PUSH_GATEWAY_IOS_MODE`（`'apns'`）與 `pushGatewayIosModeFromEnv(env)`（讀 `PUSH_IOS`、套預設、
     只接受 `apns`／`fcm`／`off`），`pushGatewayConfigFromEnv` 與 Node 版的 `startNodePushGateway`（決定要不要自動帶 `http2ApnsTransport`）都用它——
     預設值只寫一次（SSOT）。
   - 部署設定器：`pushGateway.ios` 的 `default` 改為 `"apns"`，常數 `DEFAULT_PUSH_GATEWAY_IOS` 在 `specs.ts`（部署設定器不引用 `./iot`，
     由測試比對 `DEFAULT_PUSH_GATEWAY_IOS_MODE`、描述表的 `default` 與 `pushGatewayVars` 寫出的 `PUSH_IOS` 三者一致）；`push-package.ts`、`push-guide.ts`、
     `validate.ts` 沒寫 `ios` 時都照 `apns` 處理（`[vars]` 寫 `PUSH_IOS = "apns"` 與 APNs 的非秘密設定、秘密列 `APNS_KEY`、說明寫 2.3 的 APNs 步驟）。schema 重新產生。
2. **缺 APNs 設定時的錯誤要能照著做**（沒寫 `ios` 是升級後最常見的失敗）：
   - 部署設定器（部署前，中英）：`secrets.apnsKey` 有預設名稱 `APNS_KEY`，不另報錯；沒寫 `ios` 而缺 `apnsTopic`／`apnsKeyId`／`apnsTeamId` 時，每一欄的 `required` 錯誤寫明
     「`pushGateway.ios` 沒寫時預設是 `"apns"`（v0.48.0 起）」與三種改法：補 APNs 欄位與 `secrets.apnsKey`；只支援 Android 設 `pushGateway.ios: "off"`（不需要 Apple 金鑰）；
     仍要經 FCM 就明寫 `pushGateway.ios: "fcm"`（已棄用）。明寫 `ios: "apns"` 時維持原本的簡短訊息（使用者已經選了 APNs，不需要再提預設值）。
   - 執行期（啟動時）：沒寫 `PUSH_IOS` 而 `apnsCredentialsFromEnv` 失敗時，在原訊息（例如「缺少 APNS_KEY」）後補上同樣的預設值與三種改法；
     Workers 版回 503 `not-configured`、Node 版啟動失敗（與既有行為相同）。訊息只有變數名稱、不含值。
   - `DEPLOY_AFFECTING_CHANGES` 加 0.48.0（標明 breaking）：設定檔是舊版 SDK 產生的，CLI 會列出這項變更。
3. **`ios: "off"` 已存在，不必新增**：參考推播閘道一推出（v0.40.0）`PUSH_IOS`／`pushGateway.ios` 就接受 `off`（`/v1/info` 回 `ios: "off"`、iOS 喚醒回 501、不需要任何 APNs 欄位或秘密；
   Android 與 iOS 都關掉才是錯誤 `push-nothing`）。只要 Android 的部署者設 `off` 即可，不會被迫申請 Apple 金鑰。本 ADR 只把它寫進錯誤訊息、選項說明與部署說明，
   並以測試釘住（兩版都不需要 Apple 欄位、不記棄用）。
4. **iOS 經 FCM 兩版都棄用**（仍可用、行為不變）：
   - 部署設定器：沿用同一個警告代碼 `push-ios-fcm-deprecated`，不再限 Workers 目標；訊息改為兩版通用。
   - 執行期：明寫 `PUSH_IOS=fcm` 時兩版都在啟動時記一筆 `{ event: 'config', result: 'ios-via-fcm-deprecated' }`。
   - 部署說明：兩版的 iOS 經 FCM 都標「已棄用」並寫明 Google 看得到 iOS 的喚醒時間點與怎麼改。
   - 移除時程不在本 ADR 決定（見 Open）。
5. **沒有過渡期（最終行為）**：`ios` 為 `apns`（明寫或沒寫）時，封 FCM token 的 iOS 登記一律回 501 `platform-disabled`，推播閘道**不會**把它們改走 Google；
   App 下次開啟、從 `/v1/info` 看到 `ios: "apns"` 後改封 APNs 裝置 token 重新登記，才恢復喚醒。這就是 v0.47 的行為，本 ADR 確認它是最終決定，
   並在部署說明（`apns` 的 App 整合一節、`fcm` 的隱私警告）與 README 寫明。

6. **APNs 的 `reason` 進結構化日誌（只進日誌、不進回應）**：
   - `APNS_REASONS`：Apple 文件〈Handling notification responses from APNs〉列出的 reason 白名單（含 `BadEnvironmentKeyInToken`、`UnrelatedKeyIdInToken`）；
     `apnsReasonCodeOf(reason)` 白名單內原樣、其他（含沒有本文、解析不了、不在清單上的字串）一律 `other`——APNs 的本文是外部輸入，不原樣寫進日誌。
   - `apnsResultOf` 對所有非 200 的結果帶 `apnsReason`（`PushDeliveryResult` 的 `gone`／`retry`／`error` 多一個選用欄位）；重簽一次後仍 `ExpiredProviderToken` 的結果也帶。
   - 推播閘道的喚醒日誌：`{ event: 'wake', result, platform, apnsReason }`（`PushGatewayLogEntry.apnsReason`）；核心再以 `^[A-Za-z]{1,40}$` 守一次門。
     日誌照舊不含 token、JWT 或金鑰。成功與送出前就擋下的（上限、重放、撤銷）沒有 `apnsReason`。
   - **`403 BadEnvironmentKeyInToken` 單獨分類**：結果代碼 `key-environment`（日誌 `error-key-environment`），其他 403 仍是 `auth`。
     部署說明（2.3 與第 5 節的對照表）寫明改法：「APNs 金鑰限定 Sandbox 或 Production：讓 `apnsEnvironment` 與金鑰一致，或建立兩個環境都能用的金鑰」；
     建立金鑰的步驟也提醒選 Sandbox & Production。對照表另列 `InvalidProviderToken`／`UnrelatedKeyIdInToken`、`ExpiredProviderToken`、
     `TopicDisallowed`／`BadTopic`、`BadDeviceToken`（裝置 token 與環境不符）。
   - 未知 reason 的結果代碼改為 `http-<狀態碼>`（原本是 reason 轉小寫，等於把外部字串放進代碼）；白名單內的照舊是 reason 轉小寫。
   - **不放進回應本文（`apnsReason`）**：回應的對象是送出端（IoT 閘道、設備、中繼），不是推播閘道的維運者。reason 本身只是 Apple 的錯誤代碼、不含 token 或金鑰，
     但 `BadEnvironmentKeyInToken`、`InvalidProviderToken` 這類代碼會把「推播閘道的憑證設定壞在哪裡」告訴每一個持有登記的送出端，而送出端拿到也做不了什麼
     （它只需要 ok／gone／retry／error 來決定刪端點或重試，這已由狀態碼表達）；再者加欄位等於擴充線上格式。維運者從日誌就能診斷。

## Alternatives Considered

- **沿用 ADR 0061 的建議：等下一次 major 或給一個過渡版本再改預設**：避免打破舊設定檔；但目前沒有部署者，等待只會讓「沒寫＝經 Google」的設定繼續被複製。不採用。
- **沒寫 `ios` 時，有 APNs 設定就用 `apns`、沒有就退回 `fcm`（隱式切換）**：舊設定不會壞，但 `/v1/info` 的 `ios` 隨著有沒有填 APNs 欄位而變，App 封的 token 種類也跟著變，
  ADR 0061 已因可預期性否決；且等於「沒寫＝可能經 Google」。不採用。
- **沒寫 `ios` 而缺 APNs 設定時自動降為 `off`**：Android-only 的部署者不必改設定，但 iOS 使用者會在沒有任何錯誤的情況下收不到喚醒；寧可部署前就失敗、訊息寫清楚。不採用。
- **新增一個 Android-only 的專用選項（例如 `ios: "none"`）**：`off` 已經就是這個意思，再加一個同義值只會讓設定檔與 App 端多一種狀態。不採用。
- **Node 版的 `fcm` 改用另一個警告代碼**：設定器與 UI 只需要知道「iOS 經 FCM 已棄用」，兩版的改法相同；沿用 `push-ios-fcm-deprecated`（訊息通用化）。
- **`fcm` 直接移除**：使用者裁示是「棄用」不是「移除」；仍有想讓 Firebase 統一管理兩個平台的部署者，先保留。
- **APNs 的 `reason` 原樣寫進日誌**：最省事，但本文是外部輸入（中間的代理或錯誤設定的測試端點可能回任何字串）；白名單＋`other` 一樣能診斷，Apple 新增 reason 時補進清單即可。
- **`apnsReason` 也放進回應本文**：見 Decision §6，不採用。

## 相容

- **breaking（pre-1.0，minor 版號 v0.48.0）**：沒寫 `pushGateway.ios`／`PUSH_IOS` 的設定檔與部署（v0.47 以前等於 `fcm`）——
  - 部署設定器：`validateDeployConfig` 回 3 個 `required` 錯誤（`ok: false`），`relay build` 不產生部署包；
  - 執行期：重新部署後 Workers 版回 503 `not-configured`、Node 版啟動失敗。
  改法三選一：補 APNs 設定（`apns`）、只要 Android 設 `off`、仍要經 FCM 明寫 `fcm`（已棄用、行為與 v0.47 相同）。
- 明寫 `ios: "fcm"`：行為不變，多一個警告（Node 目標也有）與一筆啟動日誌（Node 版也有）。
- 明寫 `ios: "apns"`／`"off"`：完全不變。
- 線上格式（token 封包、喚醒請求、`/v1/info` 的欄位）不變；`/v1/info` 的 `ios` 值只會隨設定改變。
- 公開 API 只增加：`DEFAULT_PUSH_GATEWAY_IOS_MODE`、`pushGatewayIosModeFromEnv`、`APNS_REASONS`、`ApnsReason`、`apnsReasonCodeOf`（`./iot/push-gateway`）、
  `DEFAULT_PUSH_GATEWAY_IOS`（`./deploy/config` 的 `specs.ts`）；`PushDeliveryResult` 的 `gone`／`retry`／`error` 與 `PushGatewayLogEntry` 多選用的 `apnsReason`。
  `PUSH_IOS` 不合法時的錯誤訊息順序改為「apns、fcm 或 off」。
- `apnsResultOf` 的回傳多 `apnsReason`；`403 BadEnvironmentKeyInToken` 的代碼從 `auth` 改為 `key-environment`；未知 reason 的代碼從「reason 轉小寫」改為 `http-<狀態碼>`。
  推播閘道對送出端的回應（狀態碼與本文）完全不變。

## 測試（TDD）

- `tests/iot/push-gateway.test.ts`：預設（只有 `PUSH_GATEWAY_KEY`）是 `apns`；兩版沒寫／空白都是 `apns`、明寫 `fcm`／`off` 照用、不合法值的錯誤；
  Node 版沒寫 `PUSH_IOS` 也自動帶 `node:http2` 傳輸直連（h2c 假 APNs）；FCM 送出層的既有測試改為明寫 `PUSH_IOS=fcm`（棄用日誌也不含秘密）。
- `tests/iot/push-gateway-apns.test.ts`：沒寫 `PUSH_IOS`＋APNs 設定→兩版直連、`/v1/info` 是 `apns`、不記棄用；只設 FCM 的舊設定→兩版啟動失敗、訊息含缺的變數、
  預設值與 `PUSH_IOS=off`／`PUSH_IOS=fcm`、不含秘密；Worker 回 503 且日誌可照做；明寫 `apns` 缺欄位時不提預設值；明寫 `fcm` 兩版都記棄用；
  `off` 兩版都不需要 Apple 金鑰、iOS 喚醒 501；沒有過渡期（明寫與沒寫 `apns` 時 iOS 的 FCM token 都回 501、不呼叫 Google）。
- `tests/iot/push-gateway-apns.test.ts`（§6）：`apnsResultOf` 對照表帶 `apnsReason`（含 `BadEnvironmentKeyInToken`→`key-environment`、白名單外→`other`／`http-<狀態碼>`）；
  `APNS_REASONS` 的形狀；經推播閘道時日誌帶 `apnsReason`、回應本文不帶、把 token 當 reason 回的本文記成 `other`、日誌不含 token／JWT／金鑰、成功與重放沒有 `apnsReason`；
  重簽後仍過期的結果帶 `ExpiredProviderToken`。
- `tests/iot/device-example.test.ts`：Android-only 的範例改設 `PUSH_IOS=off`。
- `tests/deploy/push-gateway-package.test.ts`：兩版明寫 `fcm` 的同一個棄用警告（訊息通用）、`apns`／`off` 不警告；沒寫 `ios` 的錯誤（中英，含三種改法）；
  `off` 不需要 Apple 欄位、部署包沒有 `APNS_*`、說明不要 Apple Developer 帳號；沒寫 `ios` 的部署包是 `apns`、說明寫「沒有過渡期」；
  兩版 `fcm` 的說明寫「已棄用」與改法；舊版設定升級時 CLI 列出 v0.48.0；`apns` 的說明有 `BadEnvironmentKeyInToken` 的改法（中英）與 `apnsReason` 的日誌範例，`off` 的沒有。
- `tests/deploy/deploy-config.test.ts`：`DEFAULT_PUSH_GATEWAY_IOS`、描述表的 `default`、`pushGatewayVars` 的 `PUSH_IOS` 與執行期 `DEFAULT_PUSH_GATEWAY_IOS_MODE` 一致；schema 與描述表一致。

## Open

- **`ios: "fcm"` 何時移除**（棄用之後）：建議在 1.0 之前、確認沒有部署者使用時移除；移除時 `fcm` 改為錯誤，`FcmSender` 只剩 Android。
- **待實測（真實環境）**：用可送 Production 的金鑰（Environment＝Production 或 Sandbox & Production）從邊緣送 production 主機——這條路還沒驗證過；
  另外可用 v0.48.0 以原本那把限定 Sandbox 的金鑰再送一次 production，確認日誌是 `error-key-environment`／`apnsReason: "BadEnvironmentKeyInToken"`。
  ADR 0061 其餘待實測照舊（真的送到 iPhone、多個 isolate 與 `TooManyProviderTokenUpdates`）。
- **FCM 的錯誤細節**：FCM 送出層目前也只回 `auth`／`http-<狀態碼>`，是否比照 §6 把 FCM 的錯誤代碼（`UNREGISTERED`、`SENDER_ID_MISMATCH`…）白名單進日誌，另案決定。
