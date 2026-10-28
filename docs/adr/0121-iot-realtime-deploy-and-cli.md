# 0121. IoT 即時通道 C′ R2b：部署設定、Workers 的 `IOT_HOME` 綁定與 v2 遷移、CLI、名單公告

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「繼續R2b」
- 日期：2026-10-28
- 對應：SDK ADR 0049（IoT 路線 §9.6、§9.7 R2）、0120（C′ R2 手機端與設備端；本 ADR 做掉它的〈後續〉）、0036／0037（站台參數）、0050（部署設定檔）、0118（Worker secret）

## Context

ADR 0120 把手機端和設備端接上了，但 relay 這一側只能手動設定：自己寫 `IOT_REALTIME` 的 JSON、自己算盲化 id 和權杖雜湊、自己放 `IOT_GATEWAY_KEYS`。四條部署路徑都不知道 C′，Workers 版連 `IOT_HOME` 這個 Durable Object 綁定都沒有，所以從 SDK 部署出去的 Worker 根本開不了 C′。

另外有三個問題是做這一段時才發現的：

1. **每個家庭只存得下 5 台設備的 retained。** 家庭 DO 沿用嚴格平面的可尋址上限（每個作者每個 kind 5 筆）。閘道公鑰替每台設備存一筆 31170，第 6 台以後的狀態會被悄悄拒收。
2. **只用一條連線的手機改不了名單。** 手機只連 C′ 站（`#rt === #main`）時，`updateAcl` 的 `$sys/acl` 指令照 A／B 的做法加密給 `homePub`。C′ relay 手上只有閘道私鑰，解不開，所以指令一律失敗。
3. **`myRole()`／`getAcl()` 在 C′ 永遠是 undefined。** relay 從來不公告名單（ADR 0120 §7 留到 R2b）。名單公告的 `d` 是 `blind("sys:acl")`，relay 沒有 `topicKey`，算不出來。

## Decision

### 1. 設定的驗證拆成共用模組（`src/relay/iot-realtime-config.ts`）

- 型別、常數和收集式檢查 `checkIotRealtimeConfig(raw, checkAcl)` 從 `iot-realtime.ts` 搬到這裡。這個模組只型別引用 `./iot`，部署設定器（`./deploy/config`，守門測試不准帶進 `./iot` 的程式）也能用。
- 名單的深度檢查由呼叫端注入：relay 傳 `parseIotAcl`；部署設定器傳 `checkIotRealtimeAclShape`，只看形狀，topic 樣式和到期時間由 relay 啟動時再驗一次。
- 閘道私鑰的比對只在 relay 和部署函式做。設定器手上沒有私鑰，也不該有。
- 這次補上的檢查：
  - `aclBlindId` 的形狀；
  - `heartbeatSec`、`realtimeTtlMaxSec` 必須是 5–300 的整數；
  - `class` 只能是 `lock` 或 `general`；
  - 一座 relay 最多 32 個家庭（每個家庭一顆 DO，防止設定錯誤時建出一大堆）。
- `IOT_REALTIME_BLIND_LENGTH` 不能引用 `./iot` 的 `IOT_BLIND_LENGTH`，改由測試比對兩者一致。

### 2. 每個家庭的可尋址上限：64＋1

`IOT_REALTIME_ADDRESSABLE_PER_AUTHOR = IOT_REALTIME_MAX_DEVICES + 1`，也就是每台設備一筆 retained，另加一筆名單公告。Node 版（`MessageStore`）和 Workers 版（`SqlMessageStore`）都改。

### 3. 名單公告（`aclBlindId`）

- 家庭設定新增選填的 `aclBlindId`＝`blind("sys:acl")`，由 CLI 預先算好。
- 給了 `aclBlindId`，relay 就以 31170 公告角色名單：`d`＝`aclBlindId`，`h`＝homeTag，內容 `{type:'acl', acl}` 以閘道私鑰加密給 `homePub`。公告的時機有兩個：
  - 每個 relay 實例第一次有手機連上時；
  - `$sys/acl` 改名單成功後，強制再發一次，而且排在 ack 之前，讓手機收到 ack 時已經讀得到新名單。
- 每則公告的 `created_at` 一定比上一則晚（至少多 1 秒）。可尋址事件同一個 `created_at` 時由 id 決勝（NIP-01）：手機一連上就改名單，兩則公告會落在同一秒，新名單大約一半的機率被舊的蓋掉。端到端測試因此時好時壞，才發現這個問題。
- 沒給 `aclBlindId` 就不公告，行為和 R1／R2 相同。

### 4. `updateAcl` 走 C′

手機只有一條連線時（`#rt === #main`），`$sys/acl` 指令加密給閘道公鑰（`realtime.gateway`），不加密給 `homePub`。手機另外連著 A／B 的閘道時，照舊走閘道。

### 5. 站台參數與秘密（四條部署路徑共用 `relaySiteVars`）

- `RelaySiteOptions.iotRealtime: { homes }` → `IOT_REALTIME`（JSON）。兩種主機都支援。
  - 驗證在 `collectRelaySiteIssues`：路徑加上 `iotRealtime.` 前綴，代碼加上 `iot-` 前綴，例如 `iot-home-tag`。
  - 有任何問題就整份不寫。relay 本身會略過有問題的家庭，但部署時應該當場拒絕，不要部署出一座半壞的站。
- `RelaySiteOptions.iotHomeDailyRequests` → `IOT_HOME_DAILY_REQUESTS`（1–10,000,000）。
  - 只有 Cloudflare 版，因為 Node 主機沒有請求計費。
  - 沒有 `iotRealtime` 時給這一項，部署會被拒絕。
- `RelayWorkerSecrets.iotGatewayKeys: { homeTag: hex }` → Worker secret `IOT_GATEWAY_KEYS`（JSON），由 `iotGatewayKeysSecret` 檢查：
  - 要有 `iotRealtime`；
  - 每個家庭都要有私鑰，而且不能多出設定裡沒有的家庭（secret 是整份換掉）；
  - 私鑰必須是 64 位 hex，而且要對得上 `gatewayPubkey`。
  - 🔴 例外訊息只會出現 homeTag，不會出現私鑰。
  - 沒有給私鑰就沿用線上已經有的 secret，和 TURN 的做法相同。
- 各條路徑怎麼放私鑰：

  | 路徑 | 做法 |
  | --- | --- |
  | REST | `secret_text` 綁定 |
  | wrangler | `wrangler secret put IOT_GATEWAY_KEYS` |
  | docker（程式化與部署包） | compose 以 `${IOT_GATEWAY_KEYS:?…}` 代入，沒設就不啟動；值只交給 `docker compose` 的環境，不寫檔 |
  | fly（程式化） | 不寫進 `fly.toml`，部署前以 `fly secrets import --stage` 從標準輸入上傳，不放在指令參數裡 |
  | fly（部署包） | 說明裡寫 `fly secrets set` |

- 部署設定檔：
  - 新增 `site.iotRealtime`（`record`，附 JSON Schema）、`site.iotHomeDailyRequests` 和 `secrets.iotGatewayKeys`（`defaultEnv: IOT_GATEWAY_KEYS`），題組都是 `iot`；
  - `.env.example`、`.dev.vars.example` 和部署說明都列出這個秘密；
  - 參考頁和 JSON Schema 已重新產生。

### 6. Workers：`IOT_HOME` 綁定一律帶，遷移 v2 新增 `IotHomeRoom`

- `RELAY_DO_BINDINGS = [RELAY_ROOM, IOT_HOME]`。REST 的 metadata、`wrangler.toml` 和兩種 Worker 入口都從這份產生。打包好的 Worker（`relay.mjs`）也轉出 `IotHomeRoom`。
- `RELAY_DO_MIGRATIONS` 加一筆 `{ tag: 'v2', newSqliteClasses: ['IotHomeRoom'] }`，v1 不動。已部署 v1 的站重新部署時只送 v2；新站一次送兩步。
- **沒有開 C′ 的站也帶這個綁定。** 沒設 `IOT_REALTIME` 時，整條 `/iot/` 回 404，類別不會被叫到，也不佔儲存。只在開了 C′ 時才帶，看起來比較省，但「開了又關」就得送 `deleted_classes` 遷移，還會刪掉資料，遷移序列也會隨設定分岔。一律帶，遷移就永遠只有一條直線。

### 7. CLI

- `cinderous iot realtime home --owner <npub> [--file iot-realtime.json]`：
  - 讀 `IOT_HOME_SECRET`，算出 `homeTag`、`homePub`、`aclBlindId`，產生新的閘道私鑰，把家庭寫進設定檔（設定檔只有公開值，可以提交）；
  - 以下秘密只印這一次：`IOT_GATEWAY_KEYS`（整份，含環境裡既有的家庭）和 `IOT_OPERATOR_SECRET`（只發給 operator／owner 的手機）；
  - 同一個家庭不會重複加。
- `cinderous iot realtime device <id> [--class lock --local-fallback key,… --min-role … --epoch n]`：
  - 把設備加進那個家庭，設定檔只存 `tokenHash` 和 `blindId`；
  - 以下只印這一次（燒進韌體）：權杖、`kid`、`deviceKey`，門鎖類再加以 `IOT_OPERATOR_SECRET` 衍生的 `deviceKeyDown`；
  - 門鎖類沒給 `--local-fallback` 或沒有 operator 秘密，就是用法錯誤。
- `cinderous relay start --iot-realtime <檔>`：
  - 讀設定，以同一份規則檢查，並比對環境裡的 `IOT_GATEWAY_KEYS`；
  - **有任何問題就不啟動。**
  - 閘道私鑰只從環境讀，不提供旗標，避免出現在 shell 歷史和程序列表裡。

## Alternatives Considered

- **開了 C′ 才帶 `IOT_HOME` 綁定、才送 v2 遷移**：理由見 §6。
- **CLI 把秘密寫進檔案（例如 `.env`）**：沿用 `iot keygen` 的做法，只印一次，讓使用者自己放。CLI 不知道使用者的 `.env` 在哪裡，也不該覆寫別人的檔案。
- **部署設定器直接呼叫 `parseIotAcl`**：會把 `./iot` 帶進 `./deploy/config`，違反 ADR 0050 的守門規則。改成注入只看形狀的檢查，細節由 relay 啟動時再驗一次。
- **Fly 以 `fly secrets set IOT_GATEWAY_KEYS=…` 上傳**：值會出現在本機的程序列表裡。`fly secrets import` 從標準輸入讀，和 TURN Token 用 `wrangler secret put` 的做法一致（ADR 0118）。

## Consequences

- 從 SDK 部署的 Worker 可以開 C′ 了。**下一次部署任何一座 Worker（包括兩座錨點）都會套用 v2 遷移**，新增一個沒有資料的 DO 類別；沒設 `IOT_REALTIME` 時行為不變。錨點照舊要使用者同意才部署。
- 已部署 v1 的站不能跳過 v2。如果有人自己的 Worker 不轉出 `IotHomeRoom`（例如手寫的入口），Cloudflare 會拒收遷移。SDK 產生的三種入口都已經轉出。
- 每個家庭最多 65 筆可尋址事件。這已經是每家天花板之內的量，不會增加最壞情況的儲存。
- 部署包和 CLI 都沒有寫入任何秘密：設定檔、`wrangler.toml`、`fly.toml`、compose 都只有變數名稱。

## 後續

- 連線池把 relay 的 close code（4429 `iot-quota:<reset>`）交給 `IotClient`，讓斷線時也能回 `quota`（ADR 0120〈後續〉第 3 點，這次沒做）。
- `iot realtime device --rotate`：換金鑰版本並設 `previousEpoch` 寬限；閘道私鑰的輪換。
- 還沒有部署到 Cloudflare，也還沒接過真的 ESP32／Tasmota 設備。

## 驗證

- `tests/deploy/iot-realtime-deploy.test.ts`（20 個）：
  - 站台參數 → `IOT_REALTIME`，收集式問題，名單形狀，門鎖要有 `localFallback`；
  - `iotHomeDailyRequests` 的宿主、相依和範圍；
  - 盲化 id 長度和 `./iot` 一致；
  - 秘密的五種錯誤，而且訊息都不含私鑰；
  - v1／v2 遷移計畫，REST／wrangler 的綁定，入口和 bundle 都轉出 `IotHomeRoom`；
  - docker 從環境代入、不寫檔，fly 從標準輸入 import 而且在部署之前，私鑰對不上時一個檔都不寫；
  - 部署包的 compose、fly、`.env.example`、`.dev.vars.example`，以及 `cloudflare-api` 從環境讀私鑰。
- `tests/cli/cli-iot-realtime.test.ts`（8 個）：
  - `home` 產生的設定 relay 和設定器都接受，設定檔不含秘密，`IOT_GATEWAY_KEYS` 是合併後的整份；
  - `device` 的權杖雜湊和設備金鑰，門鎖類的必要條件和 down 金鑰；
  - `relay start --iot-realtime` 在三種錯誤下都不啟動。
- `tests/iot/realtime.test.ts` 新增 3 個（真的 Node 中繼）：
  - 六台設備的 retained 都讀得到；
  - 給了 `aclBlindId`，`myRole()` 是 owner，`updateAcl` 走 C′ 成功、名單隨即更新，viewer 被拒；
  - 沒有 `aclBlindId` 時是 undefined。
- `tests/relay/iot-realtime.test.ts` 新增 1 個：同一秒內連發的公告，`created_at` 嚴格遞增（拿掉修正就失敗）。
- `tests/relay/iot-worker.test.ts` 新增 3 個（Workers 版）：
  - 名單公告由閘道簽名、加密給全家；
  - 沒有 `aclBlindId` 不公告；
  - 六台設備的 retained 都留下。
- 破壞測試：拿掉家庭的可尋址上限，Node 和 Workers 各有一個測試失敗；拿掉 `toGateway`，`updateAcl` 的測試失敗。
