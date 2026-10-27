# 0061. Workers 版推播閘道的 iOS 也直連 APNs：一般 `fetch()`＋ES256 provider token，iOS 經 FCM 改為相容並棄用

- 狀態：**已接受（Accepted，2026-10-06）**——使用者 2026-10-06 裁示「Workers 版也直連 APNs」；實作於 v0.47.0。
  **部分由 ADR 0062 取代（v0.48.0）**：第 7 項的「沒寫 `ios` 仍是 `fcm`」改為預設 `apns`（兩版，breaking）、「Node 版的 `ios: fcm` 不警告」改為兩版都棄用；
  「從 `fcm` 改成 `apns` 不改走 Google」定為最終行為（不設過渡期）。Open 前兩題已由 ADR 0062 了結。
- 日期：2026-10-06
- 對應：本 repo ADR **0049 §11.1 第 5 項**（推播閘道的宿主：「Workers 能否直接以 HTTP/2 送 APNs」列入 PoC，可以的話 Workers 版也直連）與
  §11〈實測：Workers 能直接以 HTTP/2 送 APNs〉（2026-10-06，`poc/apns-http2/`）；ADR **0050**（部署設定器）。

## Context

ADR 0049 §11.1 第 5 項定了參考推播閘道的兩種部署：Workers 版的 iOS 經 FCM 轉給 APNs（Google 也看得到 iOS 的喚醒時間點），
Node 版的 iOS 直連 APNs（`node:http2`）。理由是當時不確定 Worker 的子請求能不能講 HTTP/2——APNs 只收 HTTP/2。

2026-10-06 的實測結果是正面的：在 Cloudflare 邊緣上，Worker 用一般 `fetch()` 打
`https://api.sandbox.push.apple.com/3/device/<token>`、帶 ES256 JWT 的 `authorization: bearer`，6 次都拿到 APNs 真正的回應
（`400 BadDeviceToken`＋`apns-id`）——邊緣代為與 APNs 協商 HTTP/2，JWT 也驗過了。本機 `wrangler dev`（workerd）則是
`Network connection lost`，所以只能在部署後的邊緣上驗證。使用者據此裁示：Workers 版也直連 APNs。

v0.46 的程式已經把 APNs 送出層寫成中立的 `ApnsSender`（JWT、請求內容、回應對照）＋可注入的 `ApnsTransport`，只是
`pushGatewayConfigFromEnv`（啟動時）與部署設定器（部署前）都擋下 Workers 版的 `PUSH_IOS=apns`，Workers 也沒有傳輸可用。

## Decision

1. **共用純函式、只換傳輸**（Fix-First：延伸 `src/iot/push-gateway/apns.ts`，不另開模組）：
   - `buildApnsRequest`（主機、`/3/device/<token>`、`authorization`、`apns-topic`、`apns-push-type: alert`、`apns-priority: 10`、
     `apns-expiration`、本文經 `iosWakePayload` 守門）、`signApnsProviderToken`（沿用 `jwt.ts` 的 `importEs256Key`／`signJwt`）、
     `apnsReasonOf`／`apnsResultOf`（回應對照）、`ApnsSender`（快取、重簽、送出）兩版共用。
   - 傳輸：Node 版照舊 `http2ApnsTransport`（`node:http2`）；**Workers 版新增 `fetchApnsTransport`**（一般 `fetch()`，逾時 10 秒，
     回應本文最多留 4096 字元、只用來取 `reason`；連不上一律丟 `network`）。手寫 HTTP/2（PoC 的 `connect()` 路線）不進 SDK。
   - `createPushGatewayFromEnv(env, 'worker', …)` 在 `PUSH_IOS=apns` 時預設用 `fetchApnsTransport(opts.fetch)`；Node 版沒給傳輸仍拒絕
     （Node 的 `fetch`／undici 預設不講 HTTP/2，APNs 不收）。
2. **provider token 的快取與重簽**：
   - 同一顆 token 用 `APNS_JWT_REFRESH_SEC`＝50 分鐘（Apple：最多 60 分鐘、換新不要比 20 分鐘更頻繁；留 10 分鐘給時鐘誤差）。
   - 同時要 token 的請求只簽一次（pending promise）。
   - `403 ExpiredProviderToken`：**重簽一次再送**；若快取裡已經不是這次用的那顆（別的請求剛換過），直接用新的、不重簽——避免同時一批請求各自重簽而觸發
     `TooManyProviderTokenUpdates`。再過期就回 `error/auth`，不無限重試。
3. **回應對照**（沿用 `apnsResultOf`，測試逐項釘住）：`200`→`ok`；`410`（`Unregistered`、`ExpiredToken`）、`BadDeviceToken`、`DeviceTokenNotForTopic`
   →`gone`（推播閘道回 410，送出端刪掉端點）；`429`（含 `TooManyProviderTokenUpdates`）、`500`、`503`→`retry`（60 秒，推播閘道回 503＋`Retry-After`）；
   其他 `403`→`error/auth`；其餘→`error/<reason 小寫>`（推播閘道回 502）。日誌只有結果代碼。
4. **主機**：`APNS_ENV`＝`production`（預設，`api.push.apple.com`）或 `sandbox`（`api.sandbox.push.apple.com`），與 Node 版相同。
5. **上限不變**：每個 token 的每分鐘／每小時上限、防重放、撤銷照舊在送出之前（Workers 版在 DO），直連 APNs 不繞過它們。
6. **設定**：
   - 執行期：Workers 版接受 `PUSH_IOS=apns`，要 `APNS_KEY`（Worker secret）與 `APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC`、`APNS_ENV`（`[vars]`）。
     `FCM_SERVICE_ACCOUNT` 只在 Android 開著（或 iOS 仍經 FCM）時需要。
   - 部署設定器（ADR 0050）：`pushGateway.apns*` 與 `secrets.apnsKey` 不再限 Node 目標；Workers 版的 `wrangler.toml` `[vars]` 寫出 APNs 的非秘密設定，
     `.dev.vars.example`／`.env.example` 列出 `APNS_KEY`；說明建議 `npx wrangler@4 secret put APNS_KEY < AuthKey_<KeyID>.p8`（.p8 不經 `.env`、不寫進部署包），
     並寫明本機 `wrangler dev` 連不上 APNs。秘密照舊只以名稱出現，錯誤與日誌不含值。
7. **相容（iOS 經 FCM 保留、Workers 版棄用）**：
   - 沒寫 `PUSH_IOS`／`pushGateway.ios` 時仍是 `fcm`——只設 FCM 的既有 Workers 部署重新部署後行為完全不變，`/v1/info` 仍回 `ios: "fcm"`。
   - Workers 版 `ios: fcm`：設定器給**警告** `push-ios-fcm-deprecated`（不是錯誤），推播閘道啟動時記一筆 `{ event: 'config', result: 'ios-via-fcm-deprecated' }`，
     部署說明寫明「已棄用」與改法。Node 版的 `ios: fcm` 不警告（見 Open）。
   - 從 `fcm` 改成 `apns`：App 從 `/v1/info` 看到 `ios: "apns"` 後改封 APNs 裝置 token；**舊的（封 FCM token 的）iOS 登記回 501 `platform-disabled`，
     要等 App 下次開啟重新登記**——推播閘道不會偷偷把它們改走 Google（說明寫明）。

## Alternatives Considered

- **以 `connect()`（`cloudflare:sockets`）＋手寫 HTTP/2**：PoC 也通，但要在 SDK 裡維護 HPACK 與 HTTP/2 框架；`fetch()` 已經可行、最簡單，留作備案、不進 SDK。
- **沒寫 `PUSH_IOS` 時，有 APNs 設定就自動用 `apns`**：隱式切換會改變 `/v1/info` 的 `ios`，App 封的 token 種類跟著變，舊登記失效；改成明寫最可預期。
- **預設改成 `apns`**：沒寫 `ios` 的既有設定檔會因缺 `apnsTopic` 等欄位而驗證失敗，違反「只設 FCM 的部署照舊」的要求；先以警告引導，預設值的翻轉列為 Open。
- **`ios: apns` 時 iOS 的 FCM token 仍改走 FCM（過渡期）**：遷移較平順，但等於在使用者明說「不經 Google」時仍讓 Google 看到 iOS 時間點；不做，改在說明寫明遷移代價。
- **`ExpiredProviderToken` 時無條件重簽**：一批同時被判過期的請求會各自重簽，可能觸發 `TooManyProviderTokenUpdates`；改為「快取已換過就直接用新的」。
- **以時間分段對齊 `iat`（讓各 isolate 用同一個 `iat`）**：可能減少多個 isolate 各自換 token 的頻率，但效果要在 Apple 端實測、且讓「強制重簽」變複雜；先不做，列為待實測。

## 相容

- 只放寬：Workers 版的 `PUSH_IOS=apns` 從「拒絕」變成「可用」；沒寫 `PUSH_IOS` 的部署行為、`/v1/info`、線上格式（token 封包、喚醒請求）都不變。
- 公開 API 只增加：`fetchApnsTransport`、`buildApnsRequest`、`ApnsRequest`、`signApnsProviderToken`、`APNS_JWT_REFRESH_SEC`；`PushGatewayWorkerEnv` 多幾個選用欄位。
  `pushGatewayConfigFromEnv(env, host)` 的簽名不變（`host` 目前不影響結果）。
- 設定檔：`pushGateway.ios: "apns"` 在 Workers 目標從錯誤變成合法；Workers 版 `ios: fcm` 多一個警告（`ok` 仍是 true）。

## 測試（TDD）

- `tests/iot/push-gateway-apns.test.ts`：`buildApnsRequest` 的路徑、標頭、payload、sandbox／production 主機與守門；重簽間隔在 20–60 分鐘之間；
  `apnsResultOf` 的 reason 對照表（18 列）；`fetchApnsTransport` 的請求形狀、截斷、連不上；Workers 傳輸下的 JWT 形狀與以公鑰驗章、快取與到期換新、
  同時送出只簽一次、`ExpiredProviderToken` 重簽一次且不無限重試、同時兩個過期只重簽一次；Workers 版經推播閘道的 410／503／502 對照、production 主機、
  每 token 上限（不呼叫 APNs）、Worker 入口（DO 防重放、日誌不含 token／金鑰／JWT）、缺 `APNS_KEY` 回 503 且只寫變數名稱、Node 版沒有 HTTP/2 傳輸仍拒絕；
  相容（只設 FCM 照舊、棄用日誌只在 Workers 版、`apns` 時 iOS 的 FCM token 不改走 Google）。都不呼叫真的 APNs（`fetch` mock）。
- `tests/iot/push-gateway.test.ts`：Node 版 `node:http2` 直連的既有測試照舊通過；設定測試改為兩版都接受 `apns`、沒寫時仍是 `fcm`。
- `tests/deploy/push-gateway-package.test.ts`：Workers 版直連的設定合法且無警告、缺欄位的錯誤、`fcm` 的棄用警告（Node 版與 `off` 不警告）、
  `wrangler.toml` `[vars]`、秘密範本、中英說明（`wrangler secret put APNS_KEY < AuthKey_….p8`、本機 `wrangler dev` 的限制、已棄用的改法）。

## 實測：v0.47.0 的 Workers 版推播閘道在 Cloudflare 邊緣（2026-10-06）

**設定**

- 日期與帳號：2026-10-06，PoC 測試帳號。
- 部署物：SDK **v0.47.0** 的 Workers 版推播閘道，由 SDK 自己的部署設定器產生（`cinderous relay build`；`service: "push-gateway"`、`target: "cloudflare"`）。
- 設定：`pushGateway.android: false`、`pushGateway.ios: "apns"`（只有 iOS、直連 APNs）；送出端以假的 APNs 裝置 token 送喚醒。

**結果**

| 主機（`apnsEnvironment`） | 次數 | 推播閘道的回應 | 解讀 |
|---|---|---|---|
| sandbox（`api.sandbox.push.apple.com`） | 2／2 通過 | `410 {"error":"unregistered"}`，710–842 ms | 到得了 APNs、provider token（ES256 JWT）被接受，假 token 被判 `BadDeviceToken`，推播閘道照第 3 項對成 `gone`（送出端刪掉端點） |
| production（`api.push.apple.com`） | 2／2 | `502 {"error":"upstream"}`，日誌 `error-auth`（APNs 403） | 使用者確認這把 APNs 金鑰建立時 Environment 只選了 **Sandbox**，production 拒絕是預期的；原因很可能是 `BadEnvironmentKeyInToken`，但 v0.47 的日誌把所有 403 都記成 `auth`、沒有 `reason`，看不出來 |

**結論**

- SDK 的 Workers 版推播閘道直連 APNs 的路徑（設定器產生的部署包、`fetchApnsTransport`、ES256 provider token、回應對照）在邊緣上對 **sandbox 驗證通過**。
- 用限定 Sandbox 的金鑰送 production 會失敗，符合預期。
- **用可送 Production 的金鑰從邊緣送 production 主機仍未驗證**（列入下方 Open 的待實測）。
- 「看不出 403 的原因」促成 ADR 0062 §6：v0.48.0 起日誌帶白名單內的 `apnsReason`，`BadEnvironmentKeyInToken` 單獨分類為 `key-environment`，部署說明寫明改法。

**複測：v0.48.0（同日）**：以 v0.48.0 的設定器重新產生部署包、部署到同一個 Worker（秘密沿用）。
- production：2／2 仍是 `502 upstream`，但日誌現在是 `"result":"error-key-environment","apnsReason":"BadEnvironmentKeyInToken"`，**確認了**上面的推論：金鑰限定 Sandbox。
- sandbox：2／2 通過，與 v0.47.0 相同。
- 測試 Worker 在複測後刪除。

## Open

> 2026-10-06 使用者裁示，前兩題由 **ADR 0062**（v0.48.0）了結：Node 版也棄用、預設值現在就改成 `apns`、從 `fcm` 改過來不設過渡期。

- ~~**Node 版的 `ios: fcm` 要不要也標為棄用**~~（ADR 0062：兩版都棄用）：§11.1 第 5 項的 Node 版本來就是「iOS 直連」，`fcm` 只是選項；本 ADR 只棄用 Workers 版的。
- ~~**`pushGateway.ios` 的預設值何時從 `fcm` 改成 `apns`**~~（ADR 0062：v0.48.0 起就是 `apns`，沒有過渡版本）。
- **待實測**：~~production 主機從邊緣送出~~ 部分完成（見上方〈實測〉：sandbox 2／2 通過；production 只測過限定 Sandbox 的金鑰、如預期失敗）——
  **仍待：用可送 Production 的金鑰（Environment＝Production 或 Sandbox & Production）從邊緣送 production 主機**（v0.48.0 的日誌會寫出 `apnsReason`）；
  真的送到 iPhone（帶推播權限的最小測試 App，ADR 0049 §11 的階段 2）；多個 isolate 各自持有 provider token 時 Apple 是否回 `TooManyProviderTokenUpdates`。
