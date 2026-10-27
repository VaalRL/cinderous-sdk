# 0064. 中繼站主不可信任：程式碼不保密，安全只靠端對端加密；bundle 不含秘密、日誌不帶使用者資料

- 狀態：**已接受（Accepted，2026-10-10）**。使用者 2026-10-10 提問：「部署到 Cloudflare Worker 上時，若 Worker 帳號主人是第三方，他是否可以逆向取得原始碼？我想降低這種可能性」；研究結論與建議經使用者同意寫成本 ADR。
- 日期：2026-10-10
- 對應：
  - ADR **0021**（以 REST API 部署、打包好的中繼 Worker）、**0042**（容量設定）、**0051／0052**（車道）。
  - CinderSync 的部署區塊（使用者把中繼部署到自己的 Cloudflare 帳號）。

## Context

使用者希望在每個面向都做好，即使專案之後會公開、開源。問題是：中繼部署在第三方（帳號主人）的 Cloudflare 帳號時，對方能不能拿到程式碼。

2026-10-10 的研究結果：

1. **一定拿得到，無法防止。**
   - Cloudflare 執行時需要明文 JS，Workers 沒有加密程式碼的機制。
   - 帳號主人可以在後台看程式碼並編輯，也可以用 REST API `GET /accounts/{id}/workers/scripts/{name}` 下載。
2. **在我們的架構裡，連部署都不需要。**
   - `relayWorkerSource` 是 SDK 的一部分，會打包進外掛的 `main.js`。
   - 任何安裝外掛的人都能從自己的 vault 讀到這份程式碼。
   - 只要外掛能替使用者部署，程式碼就必然跟著外掛一起發出去。
3. **混淆或改寫成 WASM 只能增加閱讀難度。**
   - 這兩種做法都有成熟的逆向工具，擋不住人。
   - 混淆還會吃掉 CPU 時間：Workers 免費方案每次請求只有 10 ms CPU。
4. **目前的 bundle 狀態（實際檢查過）：**
   - 已經 minify，沒有註解，也沒有附 source map。
   - 64 位十六進位字串只有 secp256k1 的公開常數。
   - 沒有 nsec、Token 或憑證。
   - TURN 等秘密走 Cloudflare 的 secret 綁定（`keep_bindings` 只是保留它們）。
5. **日誌：**
   - Cloudflare 版開了 `observability`，日誌在帳號主人的後台看得到。
   - 現有的 `console.*` 只帶連線和訂閱的編號（connId、subId）、站主自己的設定錯誤，以及錯誤物件。
   - 沒有 IP、pubkey 或事件內容。
6. **小洩漏：** NIP-11 的 `software` 預設是私有 SDK repo 的網址（當時是 dev repo；ADR 0110 已改成公開 repo `https://github.com/VaalRL/cinderous-sdk`）。任何連上中繼的人都看得到這個 repo 名稱，但 repo 本身仍是私有的。

## Decision

### 一、威脅模型：中繼站主不可信任

- **中繼的程式碼不是秘密**，任何安全性都不能建立在「別人看不到程式碼」上。這是密碼學的 Kerckhoffs 原則：系統的安全只靠金鑰。
- **站主可以讀，也可以改寫**自己帳號裡的 Worker。客戶端一律把中繼當成可能被改寫過的站。
- **站主看不到的：** 內容。內容以端對端加密（NIP-44／NIP-59）傳送，中繼只轉送密文。
- **站主看得到的：**
  - 中繼資料：IP、連線時間、流量大小、收件人 pubkey（`p` tag）。
  - 這是 Nostr 中繼的本質。要縮小這部分，屬於另案（例如 NIP-59 的收件人隱藏程度），不在本 ADR 範圍。
- **站主做得到的破壞：** 丟掉、延遲、重複、重放事件。現有對策維持不變：
  - 簽章驗證；
  - 多座中繼互為備援；
  - `dropped` 補送；
  - 版本圖去重。
- 中繼回報的 NIP-11 `version`、`software` **只當參考**，不能當成「跑的是哪份程式碼」的證明。

### 二、不做混淆，也不改寫成 WASM

- bundle 照舊 `minify: true`、`legalComments: 'eof'`、不附 source map。這是為了檔案小、執行快，**不是**安全措施。
- 不加 javascript-obfuscator 一類的工具：
  - 擋不住人；
  - 浪費 Worker CPU，也讓線上錯誤難查；
  - 開源以後毫無意義（AGPL 本來就要求提供原始碼）。

### 三、bundle 不含秘密（守門測試）

- `tests/deploy/relay-worker-secrets.test.ts` 檢查 `relayWorkerSource`，有下列任何一項就失敗：
  - nsec、PEM 私鑰、Apple `.p8` 檔名、GitHub token、Google API key、Stripe 類金鑰、`Bearer` 字面值。
  - 不在白名單裡的 64 位十六進位常數。白名單目前只有 secp256k1 的 Gx、Gy、n、p、beta；新出現的常數要先有人看過才能加。
  - `sourceMappingURL` 或本機路徑。
- 秘密只能走 Cloudflare 的 secret 綁定：由站主以 `wrangler secret put` 或後台設定，**不能**寫進程式碼、`[vars]` 或 `plain_text` 綁定（`plain_text` 也能從後台與 API 讀回）。

### 四、日誌不帶使用者資料（守門測試）

- `tests/relay/log-hygiene.test.ts` 掃 `src/relay` 每一個 `console.*` 呼叫的參數。下列識別字一出現就失敗：`pubkey`、`clientIp`、`ip`、`CF-Connecting-IP`、`content`、`sig`、`tags`、`event`。
- `dev-server.ts` 是本機開發用，不納入掃描。
- 站主自己的設定（車道名稱、容量設定錯誤）可以記在日誌：那是站主本來就知道的東西。

### 五、`software` 欄位（待開源時處理）

- 開源時把 NIP-11 的 `software` 預設值改成公開 repo 的網址。
- 在那之前維持現狀：私有 repo 名稱外露的影響很小，而改了又得在開源時再改一次。

## Alternatives Considered

- **混淆 bundle**：見 Decision 二。
- **改寫成 Rust／WASM**：成本極高，一樣可以反編譯，也沒辦法擋站主改寫。
- **在客戶端驗證中繼跑的程式碼**（遠端證明）：Cloudflare Workers 沒有 attestation 機制，客戶端無從確認對方跑的是哪份程式碼。這也是為什麼客戶端必須假設中繼不可信任。
- **不讓使用者自己部署，只用官方錨點**：違背「資料走你自己的中繼」的產品原則，而且錨點的程式碼一樣會隨外掛公開。

## Consequences

- ＋ 威脅模型寫明之後，評估新功能有一致的標準：任何需要「中繼看不到程式碼」或「中繼一定照程式碼跑」的設計都不成立。
- ＋ 兩個守門測試防止之後不小心把秘密打包進 bundle，或把使用者資料寫進日誌。
- － 64 位十六進位白名單在升級加密函式庫時可能要更新（新增的常數要人工確認是公開參數）。
- － 日誌掃描是依識別字名稱判斷，換個變數名稱就能繞過。它防的是不小心，不是惡意。
- － **已知的元資料面（2026-10-14 補記，ADR 0085）**：同一次送出的所有檔案塊（kind 1060）共用同一個 `expiration` 標籤（外層 `created_at` 有隨機往前推，`expiration` 沒有），
  所以中繼能把同一批歸在一起、推出每批的塊數與大小——也就是每則同步訊息的大概大小。ADR 0085 的整批淘汰正是利用這個值；若將來要消除這個外洩
  （例如每塊的 `expiration` 加幾秒隨機抖動），整批淘汰就做不到，兩者要取捨。
- 驗證：`tests/deploy/relay-worker-secrets.test.ts`、`tests/relay/log-hygiene.test.ts`。
