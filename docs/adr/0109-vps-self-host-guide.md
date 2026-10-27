# 0109. VPS 自架指南：在開發機產生部署包、Docker 只聽本機、Caddy 終止 TLS

- 狀態：**已接受（Accepted，2026-10-27）**——使用者 2026-10-27：「幫我檢查 目前cinderous sdk之中是否有記載 要讓別人部署在自己vps的選項」，接著「補上指南」
- 日期：2026-10-27
- 對應：SDK ADR 0008（`relay start`、白名單）、0013（存取控制、`TRUST_PROXY`）、0018（docker／fly）、0050（部署設定器、`relay build`）、0099–0101（Node 版的空間、連線數、每月流量上限）

## Context

自架需要的東西 SDK 都記載了：

- README 的「自託管模式（階梯 1）」（樹莓派、NAS、VPS）；
- `relay deploy --provider docker`；
- `relay build` 產生的部署包；
- 專為 VPS 站主寫的 Node 版上限（ADR 0099–0101）。

缺的是一條從頭到尾的路：

- TLS 只有一句「前面要放 TLS 反向代理（例如 Caddy）」；
- 沒說 SDK 公開前怎麼把 SDK 帶到 VPS 上；
- 沒有 systemd、防火牆、反向代理的範例。

對照原始碼時另外發現兩個安全上的坑：

1. **產生的 `docker-compose.yml` 是 `"8080:8080"`，對所有網卡發布。**
   - Docker 發布的埠會繞過 ufw；
   - 設了 `trustProxy` 時，直接連 8080 的人可以自己帶 `X-Forwarded-For` 假裝成任何 IP，躲過每個 IP 的限速與連線數上限。
2. **中繼取 `X-Forwarded-For` 的第一段**（`node-relay.ts`）。下面兩種常見設定，第一段都是客戶端自己帶的：
   - nginx 常見的 `$proxy_add_x_forwarded_for`；
   - Cloudflare 的橘色雲代理。

## Decision

1. 新增 **`docs/guides/self-host-vps.md`**（繁中＋英文），路線是：
   - DNS（DNS only）；
   - 在有 SDK 的開發機用 `cinderous.config.json`（`target: "docker"`、`persist`、`trustProxy`、白名單、流量／空間／連線數上限）`relay build`；
   - compose 的埠改成 `127.0.0.1:8080:8080`；
   - ufw 只開 22、80、443；
   - scp 到 VPS、`docker compose up -d --build`；
   - Caddy（附 nginx 版，`X-Forwarded-For` 必須是 `$remote_addr`）；
   - 用 `/healthz` 與 NIP-11 確認；
   - 不用 Docker 的 systemd 路線（同一份部署包直接用 Node 跑）；
   - 日常維護、回滾、已知限制。
2. 指南的事實以原始碼為準：
   - CLI 預設埠是 8787，容器是 8080；
   - Node 22.13 以前的保存模式要 `--experimental-sqlite`；
   - Node 直跑時中繼聽 `0.0.0.0`，沒有只聽本機的選項。
3. 兩份 README 的「自託管模式」段落連到這份指南。

## Alternatives Considered

- **只寫 systemd 路線**：不用 Docker 的話，使用者要自己裝 Node 與相依。兩條路線共用同一份部署包，寫兩條的成本很低。
- **先改 compose 只聽本機，再寫指南**：這是行為變更——樹莓派在區網裡直接用 `ws://` 連的用法靠的就是現在的發布方式，要另外決定（見〈後續〉）。在那之前，指南請使用者手改那一行；手改過的檔案，`relay build` 沒加 `--force` 不會覆寫。

## Consequences

- ＋ 有 SDK 的開發機加一台 VPS，照一頁做完就有 `wss://relay.<網域>`。
- ＋ 兩個坑（compose 的發布方式、`X-Forwarded-For`）都寫明了。
- － 指南要跟著 CLI 與環境變數的原始碼更新；頁首寫了以哪些檔案為準。
- 驗證（2026-10-27，Windows、Node 26）：
  - **已跑：**
    - 指南的範例設定通過 `config validate`；
    - `relay build` 產生 13 個檔案另含 `sdk/`；compose 檔名是 `docker-compose.yml`、內容是 `"8080:8080"`（證實坑 1）；
    - systemd 路線：`npm install --omit=dev` 之後，`node --experimental-sqlite server.mjs` 起得來；
    - `/healthz` 回 `ok`；
    - NIP-11 有站名、版號、`auth_required`、`cinder_traffic`、`cinder_accepts_files`；
    - SQLite 檔建立了；
    - WebSocket 收到 `AUTH`，認證前的查詢回 `CLOSED auth-required`。
  - **沒跑**（這台機器沒有這些工具，也沒有 VPS）：`docker compose up`、Caddy、ufw、systemd、真的 VPS。指南頁首寫明了。

## 後續（未做，要使用者決定）

- **`node.bindAddress`**（或「`trustProxy: true` 時預設只發布在 `127.0.0.1`」）：不要再產生「對外開放、又信任 `X-Forwarded-For`」的 compose。產生的 `README-DEPLOY.md` 安全檢查清單也要補一條「Docker 會繞過 ufw」。
- **Node 中繼的監聽位址選項**（例如 `HOST`），讓 systemd 路線不必只靠防火牆。
- **`X-Forwarded-For` 改取最後一段**，或可設定信任幾層代理，讓會附加的代理不再讓客戶端偽造 IP。
