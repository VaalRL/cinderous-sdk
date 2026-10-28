# 0122. IoT 即時通道 C′：4429 斷線時回 `quota`、設備換金鑰與權杖、閘道私鑰輪換

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「繼續實作剩餘的」
- 日期：2026-10-28
- 對應：SDK ADR 0049（§2.6 `keyGraceSec`、§10.2 家庭額度）、0108（1013 暫時不能用）、0120（〈後續〉第 3 點）、0121（〈後續〉的 `--rotate` 與閘道私鑰輪換）

## Context

ADR 0121 發版後，C′ 還剩兩件事沒做。

1. **額度用完時，手機分不出來。** 家庭的額度用完時，relay 以 4429 `iot-quota:<重置 unix 秒>` 關掉這個家的所有連線，不是回 ack。
   - 連線池只把 1008、4003、1013 當成有意義的關閉碼，4429 被當成一般斷線，原因也被丟掉。
   - 指令在等 OK 時被關：結果是 `relay-rejected`（原因只有 `disconnected`）。
   - 斷線之後才下的指令：`not connected` 不算拒收，結果是**空的** `relay-rejected`。重試間隔一路加倍，最後才放棄。
   - 連線池照最長退避每分鐘重連一次，每次都被 503 擋下，到隔天 UTC 午夜才停。
2. **換不了金鑰。** relay 和設定檢查早就支援 `previousEpoch` 寬限期，但只能手動改：
   - CLI 不會產生新版本的金鑰；
   - 手機端只認目前的 `epoch`。寬限期內，還沒更新的設備送來的狀態和 ack 會被手機丟掉，手機用新版本封的指令舊設備也解不開；
   - 權杖外洩、閘道私鑰外洩時，也沒有工具可以換。

## Decision

### 1. 4429 是「這座暫時不能用」，帶詞元與重置時間

- 新增 `IOT_QUOTA_CLOSE_CODE = 4429`（`./protocol`）。relay 的 `IOT_QUOTA_CLOSE` 與設備端都改用它。
- `classifyRelayClose(4429, reason)` 回傳以下內容：
  - `kind: 'unavailable'`：和 1013 同一類，可以重試，換別座有用；
  - `token: 'iot-quota'`：新增到詞元表 `RELAY_REJECT_TOKENS.iotQuota`；
  - `reset`：從 `iot-quota:<reset>` 讀出的重置時間。
- 為什麼是 `unavailable`，不是 `rate-limited`：
  - 這不是計數窗結束就恢復的限速，要等到重置時間；
  - `rate-limited` 會讓同一身分的事件預算退避一分鐘（ADR 0043），拖慢別的功能。這個問題 ADR 0120 §4 已經處理過一次。
- 連線池收到 4429 時這樣處理：
  - 健康標記一直維持到 `reset`。加最多 60 秒抖動，免得一家的手機在午夜同一秒一起重連。重置時間離譜時最多等一天；
  - 重連也等到那時（沿用 1013 的做法，ADR 0108）；
  - `onRelayReject` 帶出 `token`；
  - 在等 OK 的發布以 `unavailable`／`iot-quota` 結案，原因帶著重置時間；
  - 沒帶重置時間時，照 1013 等 5 分鐘。
- `IotClient` 這樣判斷：
  - 拒收原因裡有 `iot-quota:` → `quota`，不重送。這是原本的邏輯，現在連斷線結案也涵蓋了；
  - 每次送出前，以及沒有結果時，看連線池的健康標記（`IotTransport.relayHealth`，選用）。這條路線的每一座主要中繼都掛著 `iot-quota` 標記 → 不送、馬上回 `quota`（`attempts: 0`，附 `reset`）。`deviceLink()` 也走這條；
  - 判斷用的正規式只留一份：`IOT_QUOTA_REJECTION`（`iot/transport.ts`）。

### 2. 換金鑰：`iot realtime device <id> --rotate`

- 金鑰版本加 1，舊版本寫進 `previousEpoch: { epoch, until }`：
  - `--grace-sec` 預設 86,400，上限 604,800（ADR 0049 §2.6 的 `keyGraceSec`；常數 `IOT_KEY_GRACE_DEFAULT_SEC`／`IOT_KEY_GRACE_MAX_SEC`）；
  - `0`＝不寬限；
  - 權杖不變。
- 印出新版本的 `IOT_DEVICE_KID`、`IOT_DEVICE_KEY`（門鎖類再加 `IOT_DEVICE_KEY_DOWN`，要 `IOT_OPERATOR_SECRET`），以及手機端的 `IOT_PHONE_DEVICE`。`IOT_PHONE_DEVICE` 是 `realtime.devices` 的公開值，可以隨 App 設定發給家人。
- 舊版本的寬限還沒到期又換一次：舊的寬限被取代，CLI 在 stderr 提醒。
- 設定檢查補一條：`previousEpoch.epoch` 必須比 `epoch` 小。
- **手機端 `IotRealtimeDeviceRef.previousEpoch`**，格式和 relay 設定相同：
  - 寬限期內，舊版本的 up 信封（ack、狀態、retained）照收；
  - 每台設備記下「最近一次開口用的版本」（取信封時間最新的）；
  - 寬限期內，如果設備最近一次用的是舊版本，指令和查詢就用舊版本封，還沒更新的設備才解得開；其他情況用新版本；
  - 過了 `until` 只認新版本，與 relay 的 `#kidOk` 同一條規則。
- 換金鑰的順序（設備和手機的更新可以穿插）：
  1. 跑 `--rotate`，重新部署 relay；
  2. 把 `IOT_PHONE_DEVICE` 發給手機；
  3. 寬限期內把新金鑰燒進設備。

### 3. 換權杖：`--new-token`

- 換掉 `tokenHash`，新權杖只印一次，`epoch` 不變。可以和 `--rotate` 一起用。
- **沒有寬限**：換權杖就是因為外洩了，重新部署之後舊權杖立刻連不上。

### 4. 換閘道私鑰：`iot realtime home --rotate-gateway`

- 新的閘道公鑰寫進設定。印出整份 `IOT_GATEWAY_KEYS`（換掉這一家），以及手機端新的 `realtime.gateway`。
- `IOT_GATEWAY_KEYS` 是整份換掉的 secret。設定裡有別的家庭時，環境變數一定要放既有的整份，否則拒絕（用法錯誤），免得印出少了別家的私鑰。
- **沒有寬限**：
  - 換閘道私鑰的理由是 relay 主機或 secret 外洩，舊私鑰多留一天，拿到它的人就多解一天的外層；
  - 重新部署之後，拿著舊公鑰的手機送的指令被 relay 拒收（`invalid: iot: the p tag must be this home gateway`）；
  - 家庭秘密、設備金鑰、權杖都不變，設備不必重燒。

## Alternatives Considered

- **4429 分成 `rate-limited`**：拒收訊息的前綴就是 `rate-limited: iot-quota:`，看起來一致。但健康狀態只會標 60 秒，事件預算也會退避。改成 `unavailable` 加詞元，語意和 1013 的「額度用完、等到重置」相同。
- **`IotClient` 自己訂閱連線池的 `onRelayReject`**：那是建構連線池時給的單一回呼，屬於應用，`IotClient` 拿不到。健康快照本來就是公開的唯讀介面。
- **閘道私鑰也給寬限（relay 同時持有新舊兩把）**：`IOT_GATEWAY_KEYS` 的格式要改成每家兩把，relay 要試兩次解密。外洩的情境下寬限正是要避免的，所以不做。
- **手機在寬限期內兩個版本都試著送**：每則指令要送兩份（msgId 相同，設備的去重擋得住重複執行，但流量和額度加倍）。改成「跟著設備最近開口的版本」，代價是寬限期內還沒聽過設備開口時的第一則指令可能送不到（回 `unknown`，自動查詢會帶回設備的回應，之後就對了）。

## Consequences

- ＋ 額度用完時，手機一定看得到 `quota` 和重置時間，不會每分鐘重連到隔天。
- ＋ 換金鑰不必讓所有東西同時更新：relay、手機、設備在寬限期內誰先誰後都通。
- ＋ 權杖或閘道私鑰外洩時，有一行指令可以處理，而且立刻生效。
- － 連線池的 4429 是寫死的關閉碼。第三方中繼如果拿 4429 做別的事，也會被當成「暫時不能用」，處理方式和 1013 相同：等到標記過期再重連。
- － 寬限期內，還沒聽過設備開口時，手機用新版本封指令。舊設備解不開，第一則會是 `unknown`。
- － 換閘道私鑰沒有寬限：舊版手機在拿到新公鑰之前送不了指令。

## 驗證

- `tests/iot/realtime-quota-close.test.ts`（7 個）：
  - 4429 的分類；
  - 連線池的詞元、標記到重置時間、重連時間、一天上限、沒帶時間的 5 分鐘；
  - 在等的發布以詞元結案、預算不退避；
  - `IotClient` 在等時被關、已經被關之後、`deviceLink` 都回 `quota`。
- `tests/relay/iot-worker.test.ts`：relay 實際送出的關閉原因，`classifyRelayClose` 讀得出重置時間（契約）。
- `tests/iot/realtime.test.ts`（真的 Node 中繼、連線池、設備）：
  - 換了版本、設備還沒更新：手機收到舊版本的狀態，指令改用舊版本，燈照樣開；
  - 設備已經更新：手機用新版本。
- `tests/iot/realtime-client.test.ts`：寬限內舊版本的 ack 算數，過了 `until` 不算；`previousEpoch` 格式錯誤丟 `RangeError`。
- `tests/cli/cli-iot-realtime.test.ts`（7 個）：
  - `--rotate`：版本、寬限、權杖不變、輸出、relay 接受；
  - `--grace-sec` 的範圍與取代提醒；
  - 門鎖類；
  - `--new-token`；
  - 旗標互斥；
  - `--rotate-gateway`：整份私鑰、舊私鑰失效、要求既有的整份；
  - 家庭不在設定裡。
- `tests/deploy/iot-realtime-deploy.test.ts`：`previousEpoch.epoch` 必須比 `epoch` 小。
- 破壞測試做過兩個：
  - 拿掉「跟著設備的版本」，換金鑰的端到端測試失敗；
  - 拿掉送出前的健康檢查，「已經被關之後」的測試失敗。

## 後續

- 還沒有部署到 Cloudflare，也還沒接過真的 ESP32／Tasmota 設備。
- 家庭秘密輪換（撤銷成員）會讓所有設備金鑰一起變，還沒有 CLI（ADR 0049 §2.6 的 `keyWrap`）。
