# 0110. 公開方式：另開公開的 GitHub repo `VaalRL/cinderous-sdk`，不上 npm；套件名稱不改

- 狀態：**已接受（Accepted，2026-10-27）**——使用者 2026-10-27：「幫我檢查目前sdk repo要公開還有什麼不完備」→「那是否可以單純新增公開的github repo就好」→「改用 VaalRL/cinderous-sdk」
- 日期：2026-10-27
- 對應：SDK ADR 0001（`dist/` 進版控、git 相依）、0018、0050（部署包怎麼帶 SDK）、0064（NIP-11 `software`，開源時換網址）、0065（對外的用詞）、0094（部署時才下載中繼 Worker）

## Context

公開前的檢查（2026-10-27）：
- **程式本身沒有問題**：`npm run check` 全過（220 個測試檔、3,096 個測試），提交的 `dist/` 與原始碼一致；沒有找到 token、私鑰或本機路徑；授權是 AGPL-3.0-only 官方原文，相依的授權都相容（MIT、Unlicense）。
- **名稱被別人佔了**：
  - npm 上的 `cinderous` 是不相關的使用者，名下有別的套件。npm 的範圍就是帳號或組織名稱，所以 `@cinderous/client` 發不出去；對方也隨時可以發一個同名的套件。
  - GitHub 的 `cinderous` 也是別人的帳號。`VaalRL/cinderous` 不能用：GitHub 的 repo 名稱不分大小寫，已經有公開的 `VaalRL/Cinderous`（Cinderous App）。
- **文件裡有能連到使用者本人的資訊**：測試用 Cloudflare 帳號名稱與帳號 ID、Apple 的 Team ID 與 Key ID、帶 Propfolk 名稱的 Bundle ID、錨點的 workers.dev 子網域（其中一個和使用者的 email 相近）。金鑰都已撤銷，但公開後可以由這些資訊連到使用者的其他身分。
- **用詞**：PRD 有一句「堅不可摧的抗量子……防禦能力」，不符合 ADR 0065。
- **缺的檔案**：沒有回報漏洞的管道（`SECURITY.md`），中繼 Worker 打包裡的第三方程式碼只留了簡短的授權註解，`package.json` 沒有 repo 資訊。

## Decision

1. **公開的 repo 是 `VaalRL/cinderous-sdk`**，照「另開乾淨的公開 repo」的原則（不改寫 dev repo 的歷史）。實際建立、push 要使用者另外同意。
2. **不上 npm**：使用方一律以 git 相依安裝並釘住 tag，`github:VaalRL/cinderous-sdk#vX.Y.Z`。`dist/` 本來就進版控，安裝時不必建置（ADR 0001）。
3. **套件名稱 `@cinderous/client` 不改**：git 相依不查 registry，import 路徑與所有使用方都不必動。
   - 風險是名稱被冒用：寫成版號範圍（`"^0.76.0"`）或照 README 打 `npm install @cinderous/client`，就會裝到 registry 上別人的套件。
   - 對策：兩份 README 與 `SECURITY.md` 寫明「npm 上的 `@cinderous/*` 不是我們的」，安裝只寫 GitHub 網址加 tag。
   - 之後要上 npm 時改名成 `@vaalrl/cinderous`（那時 `vaalrl` 範圍還沒被註冊）。建議使用者先建立 npm 的 `vaalrl` 組織佔住名稱；這要使用者自己登入。
4. **這次在 dev repo 改的**：
   - NIP-11 `software` 預設值、`SDK_SOURCE_REPO`、CLI 與部署選項的說明：`VaalRL/cinderous-sdk-dev` → `VaalRL/cinderous-sdk`（中繼 Worker 打包與它的 SHA-256 跟著變）。測試與快照先改、確認失敗再改原始碼。
   - 兩份 README 的安裝方式與冒用警告；README 範例的中繼網址改成 `relay.example.com`。
   - `package.json`：`repository`、`homepage`、`bugs`；`files` 加上 `THIRD-PARTY-NOTICES.md`。
   - 新增 `SECURITY.md`（中英）：經 GitHub 的私下回報，只修最新 tag，寫明加密引擎沒有外部審計、後量子只保護加密、中繼看得到中繼資料。
   - 新增 `THIRD-PARTY-NOTICES.md`：中繼 Worker 打包進去的六個套件（@noble/ciphers、curves、hashes、post-quantum、@scure/base、nostr-tools）的版本與授權全文。
   - 個人資訊：ADR 0049、0061、0062、0078、0108 與 `docs/reports/iot-r0-poc.md` 的測試帳號名稱、Key ID、Team ID、Bundle ID、錨點子網域，改成「測試帳號」「錨點 1／2」或拿掉。配對 QR 的測試改用同長度的假網址（容量測試看長度）。
   - PRD 那句改成照實描述：防「今天側錄、將來解密」，只保護加密，不是「量子安全」。
   - companion-specs 裡 SDK repo 的名稱。
5. **ADR 全部照放進公開 repo**（使用者 2026-10-27：「全部照放」）：README 與程式碼註解有上百個連到 ADR 的連結，評估協定與安全取捨也要靠它們。
   - 照放的意思是內容不改：使用者原話的引用（約 55 份）、其他專案名稱（《辭職信》《元素使》《沒當好爸爸》、DocHost、CinderSync、Coffice）、測試裝置型號、已修好的安全審查細節都保留。
   - 個人資訊照第 4 項處理過（測試帳號、Apple 金鑰資訊、錨點子網域）。
6. **不放進公開 repo**（使用者 2026-10-27：「不放」「先不放」）：
   - `poc/`、`docs/reports/`、`RESEARCH-JOURNEY.md`；
   - `docs/companion-specs/`（指向私有的外掛 repo；外掛公開時再決定）。
   - 留在公開 repo 的檔案裡連到它們的連結（README 的 companion-specs、部分 ADR 連到 `docs/reports/` 與 `poc/`），建立公開 repo 時要改成純文字或拿掉。
7. **發成 v0.76.1**（使用者 2026-10-27：「commit 也發0.76.1」）：使用方升版後，NIP-11 `software` 與中繼 Worker 的雜湊跟著更新。沒有 API 變動。

## Alternatives Considered

- **現在就改名成 `@vaalrl/cinderous` 並上 npm**：要改 SDK 裡 85 個檔案、390 處，四款遊戲、兩個外掛與 PR #9 都要改 import；對目前的使用方沒有好處。
- **放進 `VaalRL/Cinderous` 當子資料夾**：git 相依很難只裝子資料夾，App 與 SDK 的版號、tag 會混在一起。
- **`VaalRL/cinderous-client`**：和套件名稱對得上，但容易被當成 App 的客戶端。

## Consequences

- ＋ 公開不必動任何使用方的 import；AGPL 要求的原始碼連結有了公開的去處。
- ＋ 部署包以 `github:…#版號` 安裝 SDK 時，不再需要 repo 權限。
- － 名稱冒用的風險要靠文件與使用方的寫法擋，不能靠 registry。
- － 搜尋不到、套件分析工具查不到；安裝比 npm 慢一點。
- － 在公開 repo 建立之前，NIP-11 `software` 的預設網址連不到（404）。
- 驗證：`npm run check` 全過；NIP-11、部署包快照、配對 QR 容量的測試照新的網址。

## 後續（未做）

**公開時要做：**
- 照第 6 項排除檔案，修掉連到被排除檔案的連結。
- 建立 `VaalRL/cinderous-sdk`（單一初始 commit），打上與 dev repo 相同的 tag；打開 GitHub 的 private vulnerability reporting（`SECURITY.md` 靠它）。
- ADR 0094：發布流程把 `relayWorkerSource` 上傳成 release asset，外掛改用 `fetchRelayWorker`。
- ADR 0050：部署包預設從內嵌 `sdk/` 改成 `github:VaalRL/cinderous-sdk#vX.Y.Z`；JSON Schema 的 `$id` 從 URN 改成可解析的網址。
- Docker 映像改名 `ghcr.io/vaalrl/cinderous-relay-lite`（`cinderous/relay-lite` 也被佔了）。
- 使用方（四款遊戲、CinderSync、Coffice、Cinderous PR #9）的相依網址從 dev repo 換成公開 repo。PR #9 照使用者的規則，要在 SDK 公開之後才合併。
- `THIRD-PARTY-NOTICES.md` 在相依升版時要重新產生；`relay build` 產出的部署包（內嵌 `sdk/` 或 `relay.mjs`）要附上它。
- 補 `CONTRIBUTING.md`（貢獻條款：DCO 或 CLA）與 `CHANGELOG.md`（版本紀錄目前散在 ADR 裡）。
