# 在自己的 VPS 上架 Cinderous 中繼 / Self-host a Cinderous relay on a VPS

> 對應 [SDK ADR 0109](../adr/0109-vps-self-host-guide.md)、[0119](../adr/0119-node-relay-proxy-hardening.md)。旗標、環境變數與預設值以原始碼為準（`src/cli/commands.ts`、`src/relay/node-relay.ts`、`src/deploy/render.ts`、`schema/cinderous.config.schema.json`）；改了那些地方請同步這份文件。
>
> 🔴 **尚未在真的 VPS 上從頭到尾跑過。** 已在本機驗證：範例設定通過 `config validate`、`relay build` 的產出、Node 直跑時 `/healthz`、NIP-11、SQLite 與 NIP-42 認證（ADR 0109）。沒驗證：`docker compose up`、Caddy、ufw、systemd。第一次照做時請把結果回報，好補上實測。
>
> Matches [SDK ADR 0109](../adr/0109-vps-self-host-guide.md) and [0119](../adr/0119-node-relay-proxy-hardening.md). Flags, variables and defaults follow the source; update this page when they change. 🔴 **Not yet run end to end on a real VPS.** Verified locally: the sample config, the `relay build` output, and the Node path (`/healthz`, NIP-11, SQLite, NIP-42). Not verified: `docker compose up`, Caddy, ufw, systemd.

- [繁體中文](#繁體中文)
- [English](#english)

---

## 繁體中文

### 會得到什麼

一座只有你（和你名單上的人）能寫入的中繼，網址是 `wss://relay.你的網域`：

```
手機／電腦 ──wss://（TLS）──▶ Caddy（443，自動憑證）──ws://127.0.0.1:8080──▶ Cinderous 中繼（Node 22）──▶ SQLite（離線留言）
```

中繼只存加密過的離線訊息與檔案塊，到保存期限為止（預設 7 天）。明文與私鑰不會到中繼上。

### 事前準備

- 一台 Linux VPS（以下以 Ubuntu 24.04／Debian 12 為例），1 vCPU、1 GB RAM 就夠個人與小團隊用；可以 SSH 登入、可以 `sudo`。
- 一個網域，能新增一筆 DNS 記錄（例如 `relay.example.com`）。
- 你的開發機上有 SDK（`git clone https://github.com/VaalRL/cinderous-sdk`，再 `npm ci`）——部署包在有 SDK 的機器上產生，再複製到 VPS。
- 要寫入的人的公鑰（npub 或 64 字元 hex）。**強烈建議設白名單**：沒有白名單＝開放中繼，任何人都能用你的流量與硬碟。

### 步驟 1：DNS

新增一筆 `A`（與 `AAAA`，若 VPS 有 IPv6）記錄：`relay.example.com` → VPS 的 IP。

- DNS 在 Cloudflare 時請設成 **DNS only（灰色雲）**。經 Cloudflare 代理（橘色雲）時，Caddy 看到的來源是 Cloudflare 的機器，每個 IP 的限速會把很多人算成同一個來源（見[已知限制](#已知限制)）。

### 步驟 2：在開發機產生部署包

在開發機建立 `cinderous.config.json`（放在一個新的資料夾，例如 `relay-vps/`）：

```json
{
  "configVersion": 1,
  "target": "docker",
  "name": "cinderous-relay",
  "node": { "persist": true, "port": 8080, "trustProxy": true },
  "site": {
    "allowedPubkeys": ["npub1你的公鑰...", "npub1另一位..."],
    "relayName": "我的中繼",
    "relayContact": "mailto:you@example.com",
    "maxTtlDays": 7,
    "maxFileMb": 17,
    "monthlyTrafficGib": 900,
    "trafficResetDay": 1,
    "maxConnections": 500,
    "doCeilings": { "strict": { "offlineMib": 4096, "addressableMib": 512 } }
  }
}
```

依你的 VPS 調整：

| 欄位 | 怎麼設 |
|---|---|
| `monthlyTrafficGib` | VPS 方案每月流量的**九成**（中繼只算得到 WebSocket 的資料量，TLS 與 HTTP 的開銷不算在裡面）。用完會暫停服務到重置日。 |
| `trafficResetDay` | VPS 的帳單日（1–28），每月那天 00:00 UTC 歸零。 |
| `doCeilings.strict` | 離線留言／可尋址事件各最多幾 MiB。依硬碟大小設，最多各 1 TiB；沒設是各 128 MiB。滿了預設拒收（`ceilingMode: "reject"`），可改 `"evict"` 淘汰最快到期的。 |
| `maxConnections` | 全站同時連線上限，依記憶體設；沒設＝不限。 |
| `maxFileMb` | 要做 Vault 同步（CinderSync、Cinder Coffice）就設 17；只傳訊息可以拿掉。需要白名單。 |
| `trustProxy` | 前面有 Caddy 才設 `true`。設了之後，`docker-compose.yml` 只把埠發布在 `127.0.0.1`（見步驟 3）。 |

檢查並產生部署包：

```bash
npx cinderous config validate --config relay-vps/cinderous.config.json
npx cinderous relay build --config relay-vps/cinderous.config.json --out relay-vps/deploy
```

`relay-vps/deploy/` 裡會有 `Dockerfile`、`docker-compose.yml`、`server.mjs`、`package.json`、`sdk/`（SDK 本身）、`README-DEPLOY.md`、`.env.example` 等（13 個檔案另含 `sdk/`）。

### 步驟 3：確認中繼只聽本機（重要）

設了 `trustProxy: true` 時，產生的 `relay-vps/deploy/docker-compose.yml` 已經只發布在本機（SDK v0.80.0 起，ADR 0119）：

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

打開確認一下。看到的是 `"8080:8080"`（較舊的 SDK 產生的），請改成上面那樣，或升級 SDK 重新 `relay build`。為什麼重要：

- 對所有網卡發布的話，`8080` 對整個網際網路開放，別人可以繞過 Caddy、不經 TLS 直接連；
- 而且 **Docker 發布的埠會繞過 ufw**，防火牆擋不住；
- 又因為設了 `trustProxy`，直接連的人可以自己帶 `X-Forwarded-For` 假裝成任何 IP，躲過每個 IP 的限速。

Caddy 在另一台機器時，用 `node.bindAddress` 指定要發布的內網 IP（例如 `"bindAddress": "10.0.0.5"`）。`config validate` 看到 `trustProxy` 又設 `"0.0.0.0"` 會提醒。

### 步驟 4：VPS 上安裝 Docker、防火牆

```bash
# Docker（官方安裝腳本；也可以照 https://docs.docker.com/engine/install/ 的步驟）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # 重新登入後生效

# 防火牆：只開 SSH、HTTP、HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

雲端商另外有安全群組（security group）的話，也只開 22、80、443。

### 步驟 5：把部署包複製到 VPS 並啟動

```bash
# 在開發機
scp -r relay-vps/deploy you@vps:/opt/cinderous-relay

# 在 VPS
cd /opt/cinderous-relay
docker compose up -d --build
docker compose logs -f relay       # 看到 Cinderous node-relay：ws://0.0.0.0:8080（sqlite…）就是起來了（容器裡聽所有位址，對外只發布在 127.0.0.1）
curl http://127.0.0.1:8080/healthz # 應該回 ok
```

`restart: unless-stopped` 已經寫在 `docker-compose.yml` 裡：VPS 重開機後會自己起來。離線留言存在 Docker volume `relay-data`（容器裡的 `/data`）。

### 步驟 6：Caddy（自動 HTTPS）

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`：

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

Caddy 會自動申請並續期 Let's Encrypt 憑證，WebSocket 不需要額外設定，而且會**覆寫**客戶端自己帶的 `X-Forwarded-For`。

中繼取 `X-Forwarded-For` **最右邊**那段當客戶端 IP（`TRUST_PROXY=1`，一層代理；SDK ADR 0119），所以會「附加」的代理也安全：客戶端自己帶的值留在左邊，換不到新的 IP。已經在用 nginx 的話，用這段（`$remote_addr` 最單純；`$proxy_add_x_forwarded_for` 也可以）：

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate／ssl_certificate_key：用 certbot 取得
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1h;
    }
}
```

### 步驟 7：確認

```bash
curl https://relay.example.com/healthz                                     # ok
curl -H 'Accept: application/nostr+json' https://relay.example.com/        # NIP-11：站名、限制、cinder_traffic
```

在應用（CinderSync、Cinder Coffice、遊戲……）的中繼欄位填 `wss://relay.example.com`。白名單外的人認證後會以 4003 斷線——這是預期的。

### 不用 Docker：systemd

同一份部署包也能直接用 Node 跑（Node **22.13 以上**；更早的 22.x 要加 `--experimental-sqlite`，下面已經加上）：

```bash
# 安裝 Node 22（例如 NodeSource 或 nvm），然後
sudo useradd --system --home /opt/cinderous-relay --shell /usr/sbin/nologin cinderous
sudo mkdir -p /var/lib/cinderous-relay && sudo chown cinderous: /var/lib/cinderous-relay
cd /opt/cinderous-relay && sudo npm install --omit=dev --no-audit --no-fund
```

把 `docker-compose.yml` 裡 `environment:` 底下的每一行抄成 `/etc/cinderous-relay.env`（`KEY=value`，去掉引號，一行一個；`PERSIST=1`、`TRUST_PROXY=1` 已經在裡面），然後把 `DB_PATH` 改成 VPS 上的路徑、再加上埠與監聽位址：

```
DB_PATH=/var/lib/cinderous-relay/relay.db
PORT=8080
HOST=127.0.0.1
```

`HOST=127.0.0.1`：只有同一台的 Caddy 連得到（SDK ADR 0119）。

`/etc/systemd/system/cinderous-relay.service`：

```ini
[Unit]
Description=Cinderous relay
After=network-online.target
Wants=network-online.target

[Service]
User=cinderous
WorkingDirectory=/opt/cinderous-relay
EnvironmentFile=/etc/cinderous-relay.env
ExecStart=/usr/bin/node --experimental-sqlite server.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/cinderous-relay

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now cinderous-relay
journalctl -u cinderous-relay -f
```

🔴 沒設 `HOST` 時，Node 直跑的中繼聽**所有網卡**（`0.0.0.0`），只剩 ufw 擋著 8080。請保留 `HOST=127.0.0.1`；ufw 照樣不開 8080，多一層保護。Docker 那條路線則是第 3 步的 `127.0.0.1:`。

### 日常維護

| 要做的事 | 怎麼做 |
|---|---|
| 升級 SDK | 開發機拉新版 SDK → `cinderous config migrate`（列出中間影響部署的變更）→ 重新 `relay build`（手改過的檔案沒加 `--force` 不會被覆寫）→ 複製到 VPS → `docker compose up -d --build`。保存模式升級不會清掉離線留言。 |
| 改白名單或上限 | 改 `cinderous.config.json` → 重新 `relay build` → 同上。白名單寫錯任何一筆，中繼會拒絕啟動，不會默默變成開放中繼。 |
| 備份 | 離線留言最多保存 `maxTtlDays` 天、而且是密文，通常不需要備份；要的話停掉容器後複製 volume `relay-data`。 |
| 看流量 | NIP-11 的 `cinder_traffic.used_percent`；用到 `trafficNearFullPercent` 起，送出的 `OK` 會帶 `warning: near-full:`。 |
| 回滾 | 留著上一版的部署包資料夾，切回去 `docker compose up -d --build`。 |

### 已知限制

- **沒有在真的 VPS 上跑過**（見頁首）。
- 沒開 `trustProxy`、也沒設 `node.bindAddress` 時，產生的 `docker-compose.yml` 照舊對所有網卡發布（給區網直連的樹莓派）。VPS 上一定要開 `trustProxy`，前面放 Caddy。
- Docker 映像還沒發布（之後的名稱是 `ghcr.io/vaalrl/cinderous-relay-lite`，SDK ADR 0112）；目前都是在 VPS 上自己建（`--build`）。
- Node 主機沒有車道（`appLanes`、`fileLanes` 只有 Cloudflare 版）。
- 經 Cloudflare 代理（橘色雲）時，Caddy 預設不信任 Cloudflare 帶來的 `X-Forwarded-For`，中繼看到的會是 Cloudflare 的 IP，每個 IP 的限速把很多人算成同一個來源。要用橘色雲，得在 Caddy 設 `trusted_proxies`（Cloudflare 的 IP 範圍）並設 `TRUST_PROXY=2`（兩層代理）；沒驗證過，建議用 DNS only。白名單照樣有效（寫入要認證）。
- 純記憶體模式（`persist: false`）重啟就清空，每月流量的用量也會歸零；VPS 上建議一律 `persist: true`。

---

## English

### What you get

A relay only you (and your allowlist) can write to, at `wss://relay.your-domain`:

```
phone/desktop ──wss:// (TLS)──▶ Caddy (443, automatic certs) ──ws://127.0.0.1:8080──▶ Cinderous relay (Node 22) ──▶ SQLite (offline messages)
```

The relay stores encrypted offline messages and file chunks until they expire (7 days by default). Plaintext and private keys never reach it.

### Before you start

- A Linux VPS (Ubuntu 24.04 / Debian 12 below), 1 vCPU and 1 GB RAM is enough for a person or a small team, with SSH and `sudo`.
- A domain where you can add a DNS record (e.g. `relay.example.com`).
- The SDK on your workstation (`git clone https://github.com/VaalRL/cinderous-sdk`, then `npm ci`). The deploy package is built where the SDK is and copied to the VPS.
- The writers' public keys (npub or 64-char hex). **Use an allowlist**: without one the relay is open and anyone can use your bandwidth and disk.

### Step 1: DNS

Add an `A` record (and `AAAA` if the VPS has IPv6): `relay.example.com` → the VPS IP. On Cloudflare DNS, use **DNS only (grey cloud)**: behind the orange-cloud proxy Caddy sees Cloudflare's machines as the source, so per-IP rate limits lump many people together (see [Known limitations](#known-limitations)).

### Step 2: Build the deploy package on your workstation

Create `relay-vps/cinderous.config.json` with the same JSON as in the Chinese section above (`target: "docker"`, `node: { persist: true, port: 8080, trustProxy: true }`, and your `site` options). Tune:

| Field | How to set it |
|---|---|
| `monthlyTrafficGib` | About **90%** of your VPS plan's monthly traffic (the relay only counts WebSocket payloads). Service pauses until the reset day once used up. |
| `trafficResetDay` | Your billing day (1–28); resets at 00:00 UTC. |
| `doCeilings.strict` | MiB for offline messages / addressable events, up to 1 TiB each; default 128 each. Full means reject (`ceilingMode: "reject"`), or `"evict"` to drop what expires soonest. |
| `maxConnections` | Whole-relay connection cap, sized to RAM; unset means unlimited. |
| `maxFileMb` | 17 for Vault sync (CinderSync, Cinder Coffice); drop it for messaging only. Needs the allowlist. |
| `trustProxy` | `true` only with Caddy in front. With it, `docker-compose.yml` publishes the port on `127.0.0.1` only (step 3). |

```bash
npx cinderous config validate --config relay-vps/cinderous.config.json
npx cinderous relay build --config relay-vps/cinderous.config.json --out relay-vps/deploy
```

### Step 3: Check it listens on localhost only (important)

With `trustProxy: true`, the generated `relay-vps/deploy/docker-compose.yml` already publishes on localhost only (from SDK v0.80.0, ADR 0119): `- "127.0.0.1:8080:8080"`. Check it. If you see `- "8080:8080"` (made by an older SDK), change it or upgrade the SDK and rebuild. Otherwise port 8080 is open to the internet, **Docker-published ports bypass ufw**, and since `trustProxy` is on, anyone connecting directly can send their own `X-Forwarded-For` and dodge per-IP limits. If Caddy runs on another machine, set `node.bindAddress` to the private IP to publish on (e.g. `"bindAddress": "10.0.0.5"`); `config validate` warns about `trustProxy` with `"0.0.0.0"`.

### Step 4: Docker and the firewall on the VPS

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

If your provider has security groups, open only 22, 80 and 443 there too.

### Step 5: Copy and start

```bash
scp -r relay-vps/deploy you@vps:/opt/cinderous-relay
# on the VPS
cd /opt/cinderous-relay && docker compose up -d --build
docker compose logs -f relay
curl http://127.0.0.1:8080/healthz   # ok
```

`restart: unless-stopped` brings it back after a reboot; offline messages live in the `relay-data` volume (`/data` in the container).

### Step 6: Caddy (automatic HTTPS)

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then `sudo systemctl reload caddy`. Caddy obtains and renews Let's Encrypt certificates, proxies WebSockets as is, and **replaces** a client-supplied `X-Forwarded-For`. The relay takes the **rightmost** `X-Forwarded-For` entry as the client IP (`TRUST_PROXY=1`, one proxy; SDK ADR 0119), so appending proxies are safe too: whatever the client sent stays on the left. With nginx, use the block from the Chinese section; `proxy_set_header X-Forwarded-For $remote_addr;` is simplest, `$proxy_add_x_forwarded_for` also works.

### Step 7: Check

```bash
curl https://relay.example.com/healthz
curl -H 'Accept: application/nostr+json' https://relay.example.com/
```

Put `wss://relay.example.com` in your app's relay field. Non-allowlisted keys are closed with 4003 after AUTH; that is expected.

### Without Docker: systemd

The same package runs on Node directly (Node **22.13+**; older 22.x needs `--experimental-sqlite`, included below). Create a `cinderous` system user and `/var/lib/cinderous-relay`, run `npm install --omit=dev` in `/opt/cinderous-relay`, and copy every `environment:` entry from `docker-compose.yml` into `/etc/cinderous-relay.env`, (`KEY=value`, no quotes; `PERSIST=1` and `TRUST_PROXY=1` are already there), then change `DB_PATH` to `/var/lib/cinderous-relay/relay.db` and add `PORT=8080` and `HOST=127.0.0.1` (only Caddy on the same host can reach it; SDK ADR 0119). Use the unit file from the Chinese section (`ExecStart=/usr/bin/node --experimental-sqlite server.mjs`, `EnvironmentFile=/etc/cinderous-relay.env`). 🔴 Without `HOST`, the relay listens on **all interfaces** (`0.0.0.0`) and only ufw stands in front of 8080; keep `HOST=127.0.0.1` and keep 8080 closed in ufw as well.

### Maintenance

- **Upgrade**: pull the new SDK, run `cinderous config migrate` (lists the changes in between), re-run `relay build`, copy, `docker compose up -d --build`. Persisted messages survive.
- **Change the allowlist or limits**: edit the config and do the same. A malformed allowlist entry stops the relay instead of opening it.
- **Backup**: usually unnecessary (ciphertext, kept at most `maxTtlDays`). Otherwise stop the container and copy the `relay-data` volume.
- **Traffic**: NIP-11 `cinder_traffic.used_percent`; from `trafficNearFullPercent` on, `OK` carries `warning: near-full:`.
- **Rollback**: keep the previous package folder and bring it back up.

### Known limitations

- Not yet run on a real VPS.
- Without `trustProxy` or `node.bindAddress`, the generated `docker-compose.yml` still publishes on all interfaces (for a Raspberry Pi reached directly on the LAN). On a VPS, always turn on `trustProxy` with Caddy in front.
- No Docker image is published yet (it will be `ghcr.io/vaalrl/cinderous-relay-lite`, SDK ADR 0112); for now you build it on the VPS.
- No lanes on the Node host (`appLanes` / `fileLanes` are Cloudflare-only).
- Behind Cloudflare's orange-cloud proxy, Caddy does not trust the `X-Forwarded-For` Cloudflare sends by default, so the relay sees Cloudflare's IPs and per-IP limits lump many people together. Using the orange cloud needs Caddy's `trusted_proxies` (Cloudflare's ranges) plus `TRUST_PROXY=2` (two proxies); this is untested, so use DNS only. The allowlist still holds (writes require AUTH).
- Memory-only mode (`persist: false`) loses everything on restart, including this month's traffic count. Use `persist: true` on a VPS.
