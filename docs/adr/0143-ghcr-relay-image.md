# 0143. 發布 Node 中繼的容器映像 `ghcr.io/vaalrl/cinderous-relay-lite`；`relay build --image`

- 狀態：**已接受（Accepted，2026-11-18）**
- 日期：2026-11-18
- 對應：ADR 0050（部署設定器，P3 的 (d)「GHCR 映像」）、0110（公開 GitHub repo、不上 npm；映像改名）、0112（「映像還沒發布、目前自己建」）、0018（容器部署）、0119（反向代理）

## Context

ADR 0110／0112 把映像名稱定為 `ghcr.io/vaalrl/cinderous-relay-lite`，但一直沒發布：`relay build` 產生的 Docker／Fly／home-tunnel 部署包都附 `Dockerfile`＋`server.mjs`＋`package.json`＋內嵌的 `sdk/`，使用者在自己的機器（樹莓派、VPS）上 `docker compose up -d --build`。這在小機器上慢（arm64 上 `npm install` 數分鐘），部署包也比較大。SDK 已公開（ADR 0110），ADR 0050 P3 (d) 的前提成立。

## Decision

### 1. 映像本身（`docker/relay-lite/Dockerfile`）

- **從 tag 的 SDK 原始碼建**：建置內容是 repo 根目錄，只放 `package.json`、`package-lock.json`、`LICENSE`、`dist/`、入口檔（`Dockerfile.dockerignore` 先排除全部再列白名單）。`dist/` 本來就提交在 repo（ADR 0110），所以不需要 TypeScript 建置；相依用 `npm ci --omit=dev --ignore-scripts`（照 lockfile、不跑安裝 script），在獨立的 `deps` 階段裝完再複製。
- **基底釘版號＋digest**：`node:22.23.3-bookworm-slim@sha256:3ed9…dbe9`（多架構清單的 digest，2026-10-21 發布）。釘 digest 才能讓同一個 tag 重建出同樣的基底；代價是要手動升級（改那一行的版號與 digest）。選 Debian slim 而不是 alpine：`node:sqlite` 與 glibc 的組合是我們測過的，alpine 沒測過。
- **非 root**：中繼本身以 `node`（基底內建 uid 1000）跑；`/data` 先 `chown node:node` 再宣告 `VOLUME ["/data"]`。
  - **修訂（2026-11-18，程式碼審查）**：原本是映像層級的 `USER node`。但既有 volume 可能屬於 root（`relay build` 自建的映像以 root 跑過；Fly 掛上來的 volume 也屬於 root），入口沒有 root 就修不了擁有者，換成映像後保存模式會寫不進資料庫。改成入口 `entrypoint.mjs` 以 root 啟動：把資料目錄（`DB_PATH` 所在目錄）裡擁有者不對的項目 `lchown` 給 node（不跟符號連結），清附加群組、`setgid`、`setuid` 降成 node，**之後**才載入 `server.mjs`；降權失敗就丟錯，絕不以 root 跑中繼。以 `--user`／Kubernetes `runAsUser` 非 root 啟動時入口不做任何事。與官方 postgres 映像的做法相同。
- **設定全走環境變數**，與 `relay build` 產生的 compose／fly.toml 相同：映像預設 `PORT=8080`、`DB_PATH=/data/relay.db`、`RELAY_VERSION=<建置時的版號>`；`PERSIST=1` 才寫 SQLite（否則純記憶體，ADR 0008）；其餘（`ALLOWED_PUBKEYS`、`TRUST_PROXY`、上限……）照 `startNodeRelay` 讀的那些。入口 `docker/relay-lite/server.mjs` 就是 `renderServerEntry()` 的輸出加上固定標頭，**測試逐位元組比對**，產生器改了映像入口一定跟著改。
- **健康檢查**：基底沒有 curl，不為了它多裝套件；`HEALTHCHECK` 用 `node -e "fetch(.../healthz)"`。
- OCI 標籤：`source=https://github.com/VaalRL/cinderous-sdk`、`licenses=AGPL-3.0-only`、`version`。

### 2. 發布（`.github/workflows/image.yml`，只在公開 repo）

- 觸發：推 `v*` tag；`if: github.repository == 'VaalRL/cinderous-sdk'`（dev repo 的 Actions 因帳單不跑，也不該推）。由 `scripts/export-public.py` 一起匯出（`.github/`、`docker/` 不在 `public-exclude.json`）。
- 權限最小：頂層 `contents: read`，job 多 `packages: write`；以 `GITHUB_TOKEN` 登入 GHCR，不需要另外的秘密。
- 步驟：tag 與 `package.json` 版號不一致就失敗 → 建 amd64（`load`、不推）→ **冒煙測試**（`/healthz` 回 `ok`、NIP-11 `version` 等於版號、中繼行程的 uid 是 1000；另外把一個屬於 root 的舊 volume 掛上、`PERSIST=1` 啟動，`/healthz` 要 `ok`、`relay.db` 要改屬 uid 1000）→ 登入 → 建 `linux/amd64,linux/arm64` 推送，標籤 `v<版號>`，以及（只在這是目前最大的正式版時，`scripts/image-latest.mjs` 依公開 repo 的 tag 判斷）`latest`，`provenance: mode=max`、`sbom: true`（BuildKit 產生的 attestation，跟映像一起推）。
- 所有 action 釘 40 字元 commit SHA，註解寫版號（checkout、setup-node 沿用 pages.yml 的釘法；docker/* 取發布至少兩週的版本：setup-qemu v4.4.0、setup-buildx v4.4.1、login v4.7.0、build-push v7.4.0）。

### 3. `relay build --image`（預設不變）

- 新旗標 `--image`：Node 目標（docker、home-tunnel、fly）直接用 `ghcr.io/vaalrl/cinderous-relay-lite:v<SDK 版號>`——compose 的 `build: .` 換成 `image: "…"`、fly.toml 的 `[build] dockerfile` 換成 `image = "…"`；部署包**不再有** `Dockerfile`、`server.mjs`、`package.json`、`.dockerignore`、`sdk/`（從自建版重新產生時，這些沒手改過的舊檔會被移除）。部署說明改成 `docker compose pull` → `docker compose up -d`，回滾是 `git checkout` 回上一版的部署包（映像標籤跟著回去）再拉。`SOURCE.md` 與授權段寫明映像內含 SDK 目的碼、Dockerfile 在原始碼的 `docker/relay-lite/`。
- `--image-ref <映像>`：同上但用指定的映像（自己的鏡像站）。
- 與 `--sdk-spec`、`--self-contained` 互斥（用法錯誤，結束碼 2）；Workers 與推播閘道目標用映像會丟錯（沒有對應的映像）。
- 程式介面：`DeployPackageContext.sdkSource` 多一種 `{ kind: 'image'; image? }`；`renderCompose`／`renderFlyToml` 多 `image?`；`BuildRelayPackageOptions.image?: true | string`；`RELAY_IMAGE_REPOSITORY`、`relayImageRef(version)`。設定檔（`cinderous.config.json`／`DEPLOY_OPTION_SPECS`／schema）**不變**——要不要用映像是「怎麼建置」，不是部署選擇，與 `--sdk-spec` 同一層。
- **為什麼預設不改成映像**：第一個映像要等下一次發版（v0.92.0）才真的建出來，在那之前預設改映像會讓所有人拉不到；而且本機沒有 Docker，Dockerfile 只驗了內容。等第一次發布、實際拉下來跑過，再另開 ADR 討論把預設改成映像（部署包會小很多）。

### 4. 驗證方式與沒驗證的

本機沒有 Docker。`tests/deploy/relay-image.test.ts` 驗內容與一致性：Dockerfile 的基底釘法、非 root、volume、埠／`DB_PATH` 等於 `CONTAINER_PORT`／`CONTAINER_DB_PATH`、COPY 的來源存在、入口與 `renderServerEntry` 相同、入口讀的環境變數 Node 中繼真的會讀、`.dockerignore` 白名單；workflow 能解析成 YAML、觸發／guard／權限、action 全釘 SHA、冒煙在推送之前、兩個標籤、provenance／SBOM、匯出清單不排除這些檔；`--image` 產生的部署包。另外在本機以 repo 結構直接跑 `node --experimental-sqlite docker/relay-lite/server.mjs`（與映像內 `/app` 相同：套件自我參照 `@cinderous/client/...` 解析到 `/app` 本身）：`/healthz` 回 `ok`、NIP-11 版號照 `RELAY_VERSION`。

🔴 **真正的映像建置、多架構、推送、冒煙測試，只會在下一次發版（推 `v0.92.0` tag）時由公開 repo 的 CI 第一次跑。** 第一次推送後，GHCR 套件預設是**私有**，維護者要到 GitHub 的套件設定把可見度改成 Public，並確認套件連到 `VaalRL/cinderous-sdk`（OCI `source` 標籤會自動連）。

## Consequences

- 樹莓派／VPS 不用再建置；部署包少了 `sdk/`（約數 MB）。自建路徑完全照舊。
- 映像只跟 SDK 版號走：只改設定不需要新映像；改中繼程式（AGPL §13）的人仍用自建路徑或自己的映像（`--image-ref`），並設 `relaySoftwareUrl`。
- 基底映像的安全更新要手動改 digest；之後若要自動化，可以加 Dependabot 的 docker 生態（另議）。
- `latest` 指向最大的正式版（補舊版、預發布版都不移動它）；部署包一律釘 `v<版號>`，不用 `latest`。
- **供應鏈（2026-11-18，程式碼審查）**：推送 job 有 `packages: write`。除了 action 釘 commit SHA，action 以特權模式拉的容器映像也釘 digest（`setup-qemu-action` 的 `tonistiigi/binfmt`、`setup-buildx-action` 的 `moby/buildkit`），QEMU 只裝 arm64；checkout 設 `persist-credentials: false`，權杖不留在磁碟上。升級這兩個映像＝改 workflow 裡的 tag 與 digest。
- `relay build` 讀上一次的清單（`.cinderous-generated`）時，路徑必須留在輸出目錄裡（與 zip 檔名同一條規則 `isSafeRelativePath`）；別人給的部署包若在清單裡寫 `../x`，build 會拒絕，不會刪到目錄外的檔案。
- 從自建換成映像時，部署包裡的 `sdk/` 整個移除：它一律是從 SDK 複製的產物（自建時每次也是先清空再複製），手改不會被保留，這點沒變。

## 還沒做

- 第一次發布後的實測（拉映像、arm64 樹莓派、Fly 用 `image` 部署），結果寫回本 ADR。
- 預設改成映像（另開 ADR）。
- 舊的一鍵部署 `relay deploy --provider docker|fly` 仍是自建（`--build`）。
