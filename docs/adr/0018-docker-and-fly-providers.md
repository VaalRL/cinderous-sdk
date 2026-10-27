# 0018. `relay deploy --provider=docker|fly`：共用一份 Node 中繼建置內容，交給官方工具部署

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0008（`relay deploy --provider=cloudflare`）、ADR 0013（存取控制的預設值）；PRD 5.3（`--provider` 列了 `cloudflare`、`docker`、`fly`）

## Context

ADR 0008 只做了 Cloudflare，`--provider=docker|fly` 會回報「還不支援」。兩者都要跑 SDK 的 Node 中繼主機（`startNodeRelay`），差別只在交給誰去跑。

## Decision

### 1. 共用的建置內容（`container.ts`）

產生在 `.cinderous/<名稱>/`，內容如下：

| 檔案 | 內容 |
|---|---|
| `sdk/` | SDK 套件本身：`dist/` 與精簡過的 `package.json`，不帶開發相依、不帶 `scripts`，映像裡不跑任何 script |
| `package.json` | 以 `file:./sdk` 安裝 SDK |
| `server.mjs` | 注入版號後呼叫 `startNodeRelay`。`PERSIST=1` 才寫 SQLite，否則純記憶體（ADR 0008） |
| `Dockerfile` | `node:22-slim`；先裝相依再放程式；以 `--experimental-sqlite` 啟動 |
| `.dockerignore` | 排除 `node_modules` |

- **為什麼把 SDK 放進建置內容**：SDK 目前是私有 repo，映像裡的 `npm install` 拿不到 git 相依。SDK 自己的相依（@noble、nostr-tools、ws）都在公開的 npm 上。SDK 公開、上 npm 之後可以改成直接裝版本號。
- **環境變數**：預設套 PRD 3.3 的每把公鑰 5 條連線、每 IP 每秒 20 則（ADR 0013）；另有白名單與保存。

### 2. `--provider=docker`

- 寫出 `docker-compose.yml`：對外埠預設 8080；`restart: unless-stopped`；保存時掛 named volume。
- 執行 `docker compose -f … -p <名稱> up -d --build`，打 `http://localhost:<埠>/healthz` 確認，回傳 `ws://localhost:<埠>`。
- 對外公開要在前面放 TLS 反向代理，客戶端才連得到 `wss://`；代理後方加 `TRUST_PROXY=1`。

### 3. `--provider=fly`

- 寫出 `fly.toml`：
  - `auto_stop_machines = "off"`、`min_machines_running = 1`：WebSocket 長連線，停機就斷；
  - `/healthz` 健康檢查；
  - `TRUST_PROXY=1`：Fly 的邊緣會代理連線；
  - 保存時掛 volume。
- 執行順序：
  1. `fly apps create`：已經存在不算失敗；
  2. 保存模式先 `fly volumes list`，**不存在才建立**：重複建會多一顆、多付錢；清單無法解析時就停下來，不冒險建立；
  3. `fly deploy --remote-only --ha=false`：純記憶體或單一 SQLite 檔的中繼只能一台，不能多台共享狀態。
- 打 `https://<名稱>.fly.dev/healthz` 確認，回傳 `wss://<名稱>.fly.dev`。
- token 用 `--api-token` 或 `FLY_API_TOKEN`，經環境變數交給 flyctl。預設區域 `nrt`（東京）。

### 4. 共用模組與 CLI

- 外部指令執行器、名稱驗證、健康檢查、SDK 版本從 `cloudflare.ts` 抽到 `common.ts`；`cloudflare.ts` 原本的匯出不變。
- `@cinderous/client/deploy` 改為涵蓋三個目標。
- CLI 新增 `--region`、`--port`、`--persist`；token 依廠商讀各自的環境變數；不認得的 provider 會列出支援的三個。

### 5. 冒煙測試順帶修掉的舊 bug

- 以產生出來的建置內容實際 `npm install` 後啟動，發現 **Node 主機的 NIP-11 沒有 `version`**：Worker 有傳，Node 主機漏了。
- 這個 bug 是從 Cinderous 搬過來就存在的，所以 Cinderous 的自架 Docker 也一樣看不到版號，而一鍵更新節點（Cinderous ADR-0356）要靠它比對。
- 已補上，並加測試。

## 驗證的範圍

- 這台開發機沒有安裝 Docker 與 flyctl。已驗證的部分：
  - 產生的設定內容與下指令的順序（替身執行器）；
  - 產生的建置內容實際 `npm install` 後啟動：`/healthz` 回 `ok`，NIP-11 帶正確版號，保存模式真的寫出 SQLite 檔。
- **尚未驗證**：真正的 `docker compose up` 與 `fly deploy`，要在有這兩個工具的環境跑一次。

## Consequences

- ＋ PRD 5.2 場景 B（NAS／樹莓派）與 Fly.io 都有一行指令可部署。
- ＋ 三個目標共用健康檢查與名稱規則；Docker 與 Fly 跑同一份建置內容。
- － 建置內容帶著一份 SDK 的 `dist/`（約數 MB）：SDK 公開前只能這樣。
- － Docker 與 Fly 都是單一實例；要多台就得換成共享儲存的架構，這次不做。
