[English](README.md) | **繁體中文**

# Cinderous（`@cinderous/client` ＋ `cinderous-relay`）

> **以 Nostr 為傳輸、在自己的裝置與小團隊之間做私有、本機優先的同步與協作。**  
> 線路格式就是 Nostr；上面加了：每台裝置一把金鑰、像 Git 的同步層、WebRTC P2P（連不上自動退回中繼），以及一鍵部署到你自己帳號的中繼。

---

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Nostr NIP-59 | NIP-42](https://img.shields.io/badge/Nostr-NIP--59%20%7C%20NIP--42-8B5CF6?style=flat-square)](https://github.com/nostr-protocol/nips)
[![WebRTC P2P](https://img.shields.io/badge/WebRTC-P2P%20DataChannel-339933?style=flat-square&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![Cloudflare Workers & DO](https://img.shields.io/badge/Cloudflare-Workers%20%26%20DO-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-whoami885-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/whoami885)

---

## 💡 為什麼是 Cinderous？

Nostr 是為**公開廣播**設計的：貼文、追蹤、抗審查，中繼盡量什麼都存。本機優先的應用（例如 CinderSync 與 Cinder Coffice）需要的正好相反：**私有**的資料只在你自己的裝置之間流動，經過一座不需要信任的中繼。

Cinderous **不是 Nostr 的分支**。事件就是一般的 NIP-01；客戶端用 NIP-17／42／44／59／98，中繼宣告 NIP-01／11／13／40／42／62。改變的是用途，以及上面加的幾層（[ADR 0065](docs/adr/0065-positioning-private-sync-over-nostr.md)）：

| | 一般 Nostr | Cinderous |
| :--- | :--- | :--- |
| **用途** | 公開廣播 | 自己的多台裝置、小團隊之間的私有同步與協作 |
| **中繼** | 通用的公開倉庫 | 你自己的中繼（一鍵部署到自己的 Cloudflare 免費額度，或 Docker／Fly／家用通道）：私人路徑、白名單、應用車道、保存期限、容量配額，而且**預設當成不可信任**（[ADR 0064](docs/adr/0064-relay-operator-threat-model-and-bundle-hygiene.md)） |
| **身分** | 一把金鑰＝一個公開的人 | **每台裝置一把金鑰**，經配對（SAS 比對）加入同一份名單，可以單獨移除一台 |
| **資料模型** | 不可修改的事件流 | 像 Git 的同步：版本圖、三方合併、衝突標註、刪除紀錄、離線佇列、本機版本歷史與檢查點 |
| **傳輸** | 只經中繼 | 中繼＋WebRTC P2P（大檔、TURN、斷點續傳），連不上自動退回中繼 |
| **加密** | 每則事件 NIP-44／NIP-59 | 同樣的 NIP-44／NIP-59，另有兩個選用引擎：Cinder EK（金鑰每週輪替）與給即時通道的 Double Ratchet，都採 ML-KEM-768 混合金鑰交換 |

### 中繼看得到、看不到什麼

- **看不到：** 訊息與檔案內容、檔名（在裝置上就端對端加密）。
- **看得到：** IP、連線時間、訊息大小、收件人 pubkey。加密藏的是內容，不是中繼資料。
- **會保存：** 加密的離線訊息與檔案塊，到保存期限為止（`--max-ttl-days`，預設 7 天；檔案車道另有期限）。Cloudflare 上存在 Durable Object 的 SQLite；Node 版不加 `--persist` 時只放記憶體。收件裝置處理完、存好一則同步訊息後會告訴中繼（收件確認，NIP-11 的 `cinder_inbox_ack`），那幾份改為 2 小時後到期（[ADR 0067](docs/adr/0067-inbox-ack-early-expiry.md)）。

### 安全性的精確說法

- 是**後量子混合金鑰交換**，不是「量子安全」：簽章仍是 secp256k1（Schnorr），驗證身分的部分不是後量子。
- **前向保密看引擎：** Cinder EK 把外洩範圍限制在一個金鑰週期（每週輪替）；逐則的前向保密與入侵後復原只有 Double Ratchet 引擎才有。兩者都還沒經過外部審計。

---

## 🏛️ 中繼可以放在哪裡

| | Cloudflare 邊緣（Workers＋Durable Objects） | 自架（Docker／Fly／家用通道） | 任何公開 Nostr 中繼 |
| :--- | :--- | :--- | :--- |
| **設定** | 在應用裡一鍵部署（REST API，不需要 Node 或 wrangler），或 `cinderous relay deploy` | `cinderous relay deploy --provider docker`／`fly`，或 `relay build` 產生的部署包 | 貼上 `wss://` 網址 |
| **費用** | 免費額度內 $0 | 自備硬體 | $0 |
| **白名單、車道、配額** | 有 | 白名單與配額（沒有車道） | 沒有，存什麼由對方決定 |
| **保存的資料** | 加密，到保存期限為止 | 記憶體，或 `--persist` 時用 SQLite | 看對方 |

由應用決定用哪座；SDK 沒有內建預設中繼（CinderSync 會請你部署或貼上一座）。

## 🔐 雙密碼引擎取捨架構 (Dual Pluggable Crypto Engines)

Cinderous SDK 核心密碼層（`@cinderous/client`）揚棄單一加密協議綁定，透過 `ICryptoEngine` 提供雙引擎宣告式取捨與自適應協商：

```
                    ┌──────────────────────────────────────────────┐
                    │      ICryptoEngine 密碼引擎統一抽象介面       │
                    └──────────────────────┬───────────────────────┘
                                           │
             ┌─────────────────────────────┴─────────────────────────────┐
             ▼                                                           ▼
┌─────────────────────────────────────────┐ ┌─────────────────────────────────────────┐
│     【引擎 A】Cinder EK 暫態金鑰封裝     │ │       【引擎 B】後量子雙棘輪演算法      │
│            (`cinder-ek`)                │ │           (`double-ratchet`)            │
├─────────────────────────────────────────┤ ├─────────────────────────────────────────┤
│ • 適用場景：CinderSync 離線快照與盲信箱  │ │ • 適用場景：Cinder Coffice 即時多人共編 │
│ • 狀態模型：時代輪替 (Epoch-based) 無狀態 │ │ • 狀態模型：嚴格有狀態連續推進金鑰鏈    │
│ • 核心優勢：0 會話脫節、容忍任意亂序丟包 │ │ • 核心優勢：逐訊前向安全 (FS) ＋ 破局自癒│
│ • 多端分發：$O(1)$ 負載 ＋ $O(N)$ 槽位包裝 │ │ • 通訊模式：點對點 WebRTC DataChannel  │
│ • 密碼規格：NIP-44 ＋ ML-KEM-768 混合封裝│ │ • 密碼規格：X25519 ＋ ML-KEM 混合棘輪步進│
└─────────────────────────────────────────┘ └─────────────────────────────────────────┘
```

---

## ✅ 目前已實作

一個套件、多個入口，用到哪個匯入哪個：

| 入口 | 內容 |
|---|---|
| `@cinderous/client` | `RelayPool`（同時連多座中繼、NIP-42、退避重連、耐久發布）、`Identity`、NIP-17 `DirectMessages`、P2P `connectPeer`／`PeerNode`（連不上退回中繼）、雙棘輪 `secureChannel` 與 Cinder EK、語音／視訊通話（`CallManager`、網狀群組通話） |
| `./sync`、`./sync/vault` | 類 Git 的同步層與 `VaultSyncCoordinator`（快照、三方合併、墓碑、輕量成員、版本歷史） |
| `./transfer`、`./pairing`、`./star`、`./durability` | 可續傳的檔案與串流傳輸、QR 配對與筆記庫名單、星狀（主持人）群組、中繼健康與讀回稽核 |
| `./relay`、`./relay/worker`、`./relay/node` | Cinderous 中繼：Cloudflare Workers＋Durable Objects，或自己的 Node 主機 |
| `./deploy`、`./deploy/config`、`./deploy/cloudflare-api` | 一鍵與設定檔部署（CLI `cinderous`、[網頁設定器](https://vaalrl.github.io/cinderous-sdk/zh-TW/configurator)） |
| `./iot`、`./iot/device`、`./iot/bridge`、`./iot/push-gateway` | 端對端加密的家電遠端控制，與推播閘道 |
| `./protocol`、`./estimator` | 共用的線上格式，與成本／額度試算 |

**每一項功能（依版本）與升級須知：**[docs/guides/features.zh-TW.md](docs/guides/features.zh-TW.md)。每一版改了什麼：[CHANGELOG.md](CHANGELOG.md)。

## 📦 安裝

安裝：從公開的 GitHub repo 以 git 相依安裝，釘住 tag：`npm install github:VaalRL/cinderous-sdk#v0.92.0`（[ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)）。

> ⚠ **沒有發布到 npm。** npm 上的 `@cinderous` 範圍是不相關的帳號，npm 上任何 `@cinderous/*` 套件都**不是我們發布的**。一律用 GitHub 網址加 tag，並保留 lockfile；不要寫成 `"@cinderous/client": "^0.76.1"` 這種版號範圍，npm 會去 registry 找。

### 相依 overrides（建議）：讓 @noble 只剩一份

SDK 相依的 nostr-tools 釘 `@noble/curves`／`@noble/hashes` 2.0.1、`@noble/ciphers` 2.1.1、`@scure/base` 2.0.0；SDK 為了安全修正改用 **2.4.0**（[ADR 0034](docs/adr/0034-noble-2-4-and-consumer-overrides.md)）。函式庫無法替使用方決定間接相依的版本，所以**請在你自己的專案**（遊戲、外掛、App）加 overrides。不加也能運作，只是打包裡有兩份（遊戲入口壓縮後 92 KB → 126 KB、gzip 34 KB → 47 KB），且 nostr-tools 那份停在 2.0.1。

**六個套件一起導**。特別是不要只導 `@scure/base`：`@scure/bip39` 2.0.1 會匯入 `@scure/base` 2.3 起已移除的內部 `utils`，`nostr-tools/nip06` 會在載入時丟 `SyntaxError: ... does not provide an export named 'utils'`。

npm（`package.json`）：
```json
{
  "overrides": {
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "@noble/ciphers": "2.4.0",
    "@scure/base": "2.4.0",
    "@scure/bip32": "2.4.0",
    "@scure/bip39": "2.4.0"
  }
}
```

pnpm 10（repo 根目錄的 `pnpm-workspace.yaml`；實測 pnpm 10.33 會忽略 `package.json` 的 `pnpm.overrides` 並警告——pnpm 9 以前則把同一份對照寫在 `package.json` 的 `"pnpm": { "overrides": { ... } }`）：
```yaml
overrides:
  '@noble/curves': 2.4.0
  '@noble/hashes': 2.4.0
  '@noble/ciphers': 2.4.0
  '@scure/base': 2.4.0
  '@scure/bip32': 2.4.0
  '@scure/bip39': 2.4.0
```

Yarn：同一份對照寫在 `package.json` 的 `"resolutions"`。

**如果相依樹裡還有別的套件依賴 @noble 1.x**（例如開發伺服器帶進來的 `pkijs` 釘 `@noble/hashes` 1.8.0），最上層的 overrides 會把它強制改成 2.x，匯入時就壞掉。這時改成只對 nostr-tools 生效的巢狀寫法（npm）：
```json
"overrides": {
  "nostr-tools": {
    "@noble/curves": "2.4.0", "@noble/hashes": "2.4.0", "@noble/ciphers": "2.4.0",
    "@scure/base": "2.4.0", "@scure/bip32": "2.4.0", "@scure/bip39": "2.4.0"
  }
}
```
先用 `npm ls @noble/hashes --all` 確認：除了 nostr-tools 那份以外都已經是 2.x，就可以用上面的最上層寫法。

**npm lockfile 的陷阱**：已經有 `package-lock.json` 的專案加上 overrides 後，`@scure/bip32`／`@scure/bip39` 可能不會重新解析（`npm ls` 顯示 invalid）。把 `package-lock.json` 裡 `node_modules/nostr-tools`、`node_modules/@scure/bip32`、`node_modules/@scure/bip39` 三筆刪掉（或整個刪掉 lockfile），再 `npm install` 一次。

檢查（每個套件只能有一個版本，2.4.0）：
```bash
npm ls @noble/curves @noble/hashes @noble/ciphers @scure/base --all   # npm：每一行都是 deduped 或 overridden
pnpm why @noble/curves                                                  # pnpm：「Found 1 version of @noble/curves」
```

選用的 CI 檢查（npm；出現第二份就失敗）：
```js
// scripts/check-noble.mjs —— 執行：node scripts/check-noble.mjs
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
let failed = false;
for (const name of ['@noble/curves', '@noble/hashes', '@noble/ciphers', '@scure/base']) {
  const copies = Object.entries(lock.packages).filter(([p]) => p.endsWith(`node_modules/${name}`));
  const versions = [...new Set(copies.map(([, m]) => m.version))];
  if (versions.length !== 1) { console.error(`${name}: ${versions.join(', ')}`); failed = true; }
}
process.exit(failed ? 1 : 0);
```

**效能說明**：noble 2.3 起刻意讓 `getPublicKey`／`sign` 變慢（預算視窗縮小、常數時間強化），驗章與 ECDH 反而變快。SDK **不會**呼叫 `secp256k1.Point.BASE.precompute(8)`：它會修改共用的模組單例、多佔約 600 KB 記憶體、第一次金鑰運算多約 25 ms，只換到 `getPublicKey`／`sign` 約 20% 的速度。大量簽章的長時間程式（中繼、伺服器）可在啟動時自己加一行——整棵樹只有一份 noble 時，SDK 與 nostr-tools 都會一起生效：
```ts
import { secp256k1 } from '@noble/curves/secp256k1.js';
secp256k1.Point.BASE.precompute(8);
```

## 🚀 快速上手與使用指南

### 1. 預設模式（階梯 0：零設定直接使用）
```typescript
import { Identity, PeerNode, RelayPool } from '@cinderous/client';

// 信令走公共節點，並透過 NIP-59 雙重包裝：中繼看不出是誰在找誰
const identity = Identity.generate();
const pool = new RelayPool({ urls: ['wss://nos.lol', 'wss://relay.damus.io'], identity });
pool.connect();
const node = new PeerNode({ identity, transport: pool, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

// 先試 WebRTC P2P；8 秒打不通就自動改走中繼（kind 20079，每框 48,000 B、各包一次 NIP-59）
const channel = await node.connectPeer(targetPublicKey);
console.log(channel.mode); // 'p2p-webrtc' 或 'relayed-websocket'
channel.onMessage((bytes) => console.log('收到', bytes.length));
await channel.send(new TextEncoder().encode('哈囉'));

// 對方找上門
node.onPeer((incoming) => incoming.onMessage((bytes) => console.log(bytes)));
```
走中繼時約每秒 160 KB；`channel.needsLargePayloadWarning(size)` 為 true（走中繼且超過 20 MB）時，建議提示使用者連同一個 Wi-Fi。

### 2. 自託管模式（階梯 1：在自己的機器起一座中繼）
在個人的樹莓派、NAS 或平價 VPS 上執行（Node 22 以上）：
```bash
# 預設純記憶體，重啟即清空；只讓名單上的人寫入
npx cinderous relay start --port 8080 --allowed-pubkeys="npub1alice...,npub1bob..."

# 要保存離線留言就加 --persist（SQLite，預設 cinderous-relay.db）
npx cinderous relay start --persist --db-path /data/relay.db
```
白名單寫錯任何一筆，中繼會拒絕啟動，不會默默變成開放中繼。
白名單外的人認證後立刻以 4003 斷線；預設每把公鑰最多 5 條連線、每個 IP 每秒最多 20 則訊息（`MAX_CONNECTIONS_PER_PUBKEY`、`MAX_MESSAGES_PER_SECOND_PER_IP` 可調；反向代理後方請設 `TRUST_PROXY=1`）。預設每把公鑰每分鐘最多 120 則事件、每條連線每分鐘最多 240 則訊息（`MAX_EVENTS_PER_MINUTE`、`MAX_MESSAGES_PER_MINUTE`；NIP-11 的 `cinder_max_events_per_minute` 宣告實際生效的值）。Node 版設 `0` 可以關掉；Cloudflare 版每則訊息都計費，只能調高、最多 600／1200。

**反向代理後方（SDK ADR 0119）。** `TRUST_PROXY=<n>` 信任 `n` 層代理（Caddy、nginx、Fly、cloudflared 都是 `1`），取 `X-Forwarded-For` **從右邊數**第 `n` 段，客戶端在前面自己加一段也換不到新的 IP。`HOST=127.0.0.1`（或 `relay start --host 127.0.0.1`）只聽那個位址；沒設＝所有位址，與之前相同。Docker：開了 `node.trustProxy` 時，產生的 `docker-compose.yml` 只把埠發布在 `127.0.0.1`（Docker 發布的埠會繞過 ufw）；要發布在別處就設 `node.bindAddress`。見 [VPS 自架指南](docs/guides/self-host-vps.md)。
從 v0.92.0 起，公開 repo 發版時會發布預建的多架構（amd64＋arm64）映像 `ghcr.io/vaalrl/cinderous-relay-lite:v<版號>`（另有 `:latest`）（[ADR 0143](docs/adr/0143-ghcr-relay-image.md)）；`cinderous relay build --image` 讓 Docker／Fly／home-tunnel 部署包直接拉映像、不建置。自己建置（預設）照常可用。

**在 VPS 上對外提供 `wss://`**（網域、Caddy 自動 HTTPS、只聽本機、防火牆、systemd、日常維護）：照 **[docs/guides/self-host-vps.md](docs/guides/self-host-vps.md)**（[ADR 0109](docs/adr/0109-vps-self-host-guide.md)）。

### 3. 無伺服器邊緣模式（階梯 2：一鍵部署至 Cloudflare Workers）

雖然 Cinderous Relay 不強制綁定任何特定廠商，但 SDK 原生將 **Cloudflare Workers ＋ Durable Objects 作為第一梯隊的高效開箱即用方案（First-Class Turnkey Recipe）**，專為追求全球邊緣 $<30\text{ms}$ 極致延遲且不想維護伺服器的開發者提供一鍵部署。

#### 互動式引導部署（推薦個人/桌面端）：
```bash
# 登入 Cloudflare 用的是 wrangler 自己的登入流程（先執行 `npx wrangler@4 login`，或設定 CLOUDFLARE_API_TOKEN）；
# Cinderous CLI 本身不跑 OAuth、也不經手任何憑證。之後建立 Durable Objects、部署並印出中繼網址
npx cinderous relay deploy --provider=cloudflare
```

#### 自動化 / CI/CD 無頭模式部署（團隊/流水線）：
```bash
npx cinderous relay deploy \
  --provider=cloudflare \
  --name=my-vault-sync-relay \
  --allowed-pubkeys="npub1alice...,npub1bob..." \
  --api-token="$CLOUDFLARE_API_TOKEN" \
  --account-id="$CLOUDFLARE_ACCOUNT_ID" \
  --non-interactive
```

#### CLI 支援參數對照表：
| 參數 Flag | 縮寫 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `--provider` | `-p` | `cloudflare` | `cloudflare`、`docker`（這台機器，docker compose）、`fly`（Fly.io）（[ADR 0018](docs/adr/0018-docker-and-fly-providers.md)）。 |
| `--name` | `-n` | `cinderous-relay` | Cloudflare Worker 實例與子域路由名稱。 |
| `--allowed-pubkeys`| `-k` | 無（開放前警示）| 逗號分隔之 NIP-42 白名單公鑰（支援 `npub` 或 hex）。 |
| `--api-token` | `-t` | 讀取環境變數 | 具備 Workers Script 編輯權限之 Cloudflare API Token。 |
| `--account-id` | `-a` | 讀取環境變數 | Cloudflare Account ID。有多個帳號時務必指定：wrangler 會沿用上次登入的帳號。 |
| `--non-interactive`| `-y` | `false` | 無頭模式，跳過所有確認提示全自動執行。 |
| `--output-env` | `-o` | `.env.cinderous` | 自動將部署成功之 `WSS` 端點寫入環境設定檔。 |
| `--compatibility-date` | | `2026-09-01` | Cloudflare 相容性日期。 |
| `--dry-run` | | `false` | 只產生設定，不部署（cloudflare 另外試打包）。 |
| `--region` | `-r` | `nrt` | fly：部署區域。 |
| `--port` | | `8080` | docker：對外的埠。 |
| `--persist` | | `false` | docker／fly：以 SQLite 保存離線留言（掛 volume）。 |
| `--app-lanes` | | 無 | cloudflare：已知租戶車道（逗號分隔，例如 `dochost`）；改名單＝換 DO（[ADR 0036](docs/adr/0036-deploy-app-lanes-and-dochost-on-self-hosted-relays.md)）。 |
| `--file-lanes` | | 無 | cloudflare：只在這些車道收檔案塊（須在 `--app-lanes` 上，並給 `--max-file-mb`）。 |
| `--relay-name`／`--relay-description`／`--relay-contact` | | 無 | NIP-11 站名／描述／聯絡方式。 |
| `--max-ttl-days` | | `7` | 離線留言保存上限，1–365。 |
| `--max-connections-per-pubkey` | | `5` | 同一把公鑰最多幾條連線，1–100。 |
| `--max-messages-per-second-per-ip` | | `20` | 同一個 IP 每秒最多幾則，1–1000。 |
| `--app-lane-pow` | | `0` | cloudflare：車道的 PoW 最低難度，0–32。 |
| `--developer-docs-url` | | 無 | cloudflare：連線被拒時附上的開發文件網址（https）。 |
| `--relay-software-url` | | SDK 的 repo | NIP-11 `software`（https）：改過中繼程式時指向修改後的原始碼（AGPL §13）。 |
| `--config` | `-c` | 無 | 改用 `cinderous.config.json` 部署（只能再加 `--output-env`、`--dry-run`）。 |

**Node 主機的 NIP-86 管理 API（SDK ADR 0132）。** 預設關。設了 `NIP86_ADMIN_PUBKEYS`（運維金鑰，npub 或 hex）才在中繼網址收 `Content-Type: application/nostr+json+rpc` 的 `POST`，以 NIP-98 授權、必須帶 `payload` tag。成員只能用 `cinder_applyroster` 改：送入 `ROSTER_ADMIN_PUBKEY` 簽的組織名冊，比上次新才套用；`allowpubkey`／`banpubkey` 一律拒絕。名冊金鑰不能是運維金鑰之一，否則拒絕啟動。新的 `ALLOWED_KINDS` 設事件類型清單；`allowkind`／`disallowkind` 只改既有清單、不刪最後一個。`changerelayname`／`changerelaydescription` 改 NIP-11。有 SQLite 檔時改過的設定重開後還在、蓋過環境變數。Cloudflare Worker 不提供。請把 `NIP86_PUBLIC_URL` 設成本站對外的 `https://` 網址，請求就必須簽給那個網址；在反向代理後面一定要設（不信任 `X-Forwarded-Host`），沒設時簽章只綁到對方送來的 `Host` 標頭（啟動時會警告）。不是運維金鑰簽的請求，內容還沒收就被拒絕。`ROSTER_ADMIN_PUBKEY` 拿掉或換掉之後，存過的名冊不再生效，成員回到 `ALLOWED_PUBKEYS`（SDK ADR 0133）。`ROSTER_ADMIN_PUBKEY` 簽的名冊事件發到這座中繼，就照 `cinder_applyroster` 同一套檢查直接套用，名冊管理者不必經手運維金鑰；只設 `ROSTER_ADMIN_PUBKEY` 也能用，這時管理 API 的 HTTP 端點不開。名冊金鑰一定寫得進這座站。設了 `ALLOWED_KINDS` 的話要包含 10038（SDK ADR 0134）。`ROSTER_ADMIN_PUBKEY` 簽的名冊可以列共同管理者（`admins`，必須是在世成員）：它們簽的名冊也會套用，但只有名冊金鑰能改共同管理者名單，共同管理者簽的名冊若把任何一位管理者移出成員就拒絕（SDK ADR 0135）。

**反覆重連限速（SDK ADR 0111、0131）。** 主平面（`/`、`/s/<n>`、`/presence`；車道不套）的每顆 Durable Object 在記憶體裡以來源 IP 計算「沒認證就斷線」的連線：10 分鐘內滿 20 條，就擋那個 IP 10 分鐘。認證過的連線只算進所有升級的總上限（預設 10 分鐘 60 次，第一個數字的 3 倍），所以共用 IP 後面很多人一起重連不會被擋。用 `RECONNECT_GUARD=<次數>/<窗口秒>/<封鎖秒>[/<總上限>]` 調整，`off` 關掉。被擋的升級收到 `rate-limited: too many reconnects…` 的 NOTICE，以 1013 關閉，用戶端會退避。在 `wrangler.toml` 加一個名為 `STRICT_UPGRADE_LIMIT` 的 Cloudflare 限速 binding，Worker 會在碰到 Durable Object 之前再以「IP＋分片」限速；部署工具不會幫你加。`DIAG_UNAUTH_LOG=1` 會替每條沒認證就斷線的主平面連線印一行：訊息動詞、訂閱的 kind、中繼的回覆、存活秒數、關閉碼。不記內容、公鑰、IP；預設關閉。

#### 設定檔（可重複的部署，[ADR 0050](docs/adr/0050-deploy-configurator.md)）：
把所有選擇放在 `cinderous.config.json`（以 `schema/cinderous.config.schema.json` 驗證），每次部署都帶同一份——不會因為少給一個旗標就讓重新部署把參數換回預設值。秘密只寫環境變數的名稱。
```bash
npx cinderous init                                                       # 逐題產生；危險選項要打出選項名稱才會開（SDK ADR 0117）
npx cinderous config validate cinderous.config.json
npx cinderous relay build --config cinderous.config.json --out deploy/   # 可攜的部署包＋README-DEPLOY.md／README-DEPLOY.en.md
npx cinderous relay deploy --config deploy/cinderous.config.json
npx cinderous config migrate cinderous.config.json                       # 升級 SDK 之後：更新 `sdk`、列出中間的變更（SDK ADR 0118）
```

`relay deploy --config` 也能部署 `cloudflare-api` 目標（走 REST，要有 `CLOUDFLARE_API_TOKEN`；沒有 `--dry-run`）。TURN 用 `site.turnKeyId` 設定（可再加 `site.turnTtlSeconds`）；Token 放在 `.env` 的 `TURN_API_TOKEN`（或 `secrets.turnApiToken: { "$env": "NAME" }`），部署時以 Worker secret 上傳——REST 是 `secret_text` 綁定，wrangler 是 `wrangler secret put`、值走 stdin。TURN 流量由 Cloudflare Realtime 另外計費。外掛用 `@cinderous/client/deploy/config` 的 `cloudflareApiOptionsFromConfig(config, env)` 得到同一份對應（[ADR 0118](docs/adr/0118-turn-secrets-rest-config-deploy-and-migrate.md)）。

#### 程式化 SDK 調用（例如於 Obsidian 設定頁面點擊按鈕直接開通，桌面與行動版皆可）：

請用 `@cinderous/client/deploy/cloudflare-api`（[ADR 0021](docs/adr/0021-cloudflare-rest-api-deploy.md)）：直接呼叫 Cloudflare REST API，不需要 Node 與 wrangler，中繼 Worker 已預先打包。上面的 `@cinderous/client/deploy` 是 Node／CLI 用的路徑（引用 `node:fs`、`node:child_process` 並執行 `npx wrangler`），**外掛不要匯入它**。

授權的預設做法（不需要任何註冊）：開瀏覽器到預填權限的 API Token 建立頁，使用者在自己的儀表板按「Create Token」，再把 Token 貼回來。Token 由應用自己保存（例如交給 `SecretStore`），SDK 不碰儲存。

給終端使用者的完整步驟（中英兩版，含依錯誤分類的常見問題）在 **[docs/guides/cloudflare-api-token.md](docs/guides/cloudflare-api-token.md)**。UI 請直接渲染 `CLOUDFLARE_TOKEN_SETUP_GUIDE`（`'zh-TW'`／`'en'`：`prerequisites`、`steps`、`troubleshooting[error.kind]`），不要自己抄一份（[ADR 0022](docs/adr/0022-token-setup-guide-as-sdk-data.md)）。

另一種做法：應用自己在 Cloudflare 註冊 **public OAuth client**（2026-06 起開放，須驗證網域），改用 PKCE 輔助函式 `createPkcePair`／`buildOAuthAuthorizationUrl`／`exchangeOAuthCode`／`refreshOAuthToken`，部署時帶 `credential: 'oauth'`。SDK 本身不附 client id。

Cloudflare API 不回 CORS 標頭，瀏覽器類的執行環境必須注入 HTTP 函式。Obsidian 用 `requestUrl` 轉接：

```typescript
import { requestUrl } from 'obsidian';
import {
  buildTokenCreationUrl,
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  CloudflareApiError,
  deployCloudflareRelayViaApi,
  verifyToken,
  type HttpFetch,
} from '@cinderous/client/deploy/cloudflare-api';

// requestUrl 不受 CORS 限制；SDK 只需要 { status, text() }
const obsidianFetch: HttpFetch = async (url, init) => {
  const body = init.body instanceof Uint8Array ? init.body.slice().buffer : init.body;
  const res = await requestUrl({ url, method: init.method, headers: init.headers, body, throw: false });
  return { status: res.status, text: async () => res.text };
};

// 1. 開瀏覽器到預填最小權限的 Token 建立頁（Workers Scripts: Edit、Account Settings: Read）
window.open(buildTokenCreationUrl()); // Token 名稱為 DEFAULT_TOKEN_NAME，與 CLOUDFLARE_TOKEN_SETUP_GUIDE 一致

// 2. 使用者貼回 Token 後
await verifyToken({ apiToken: token, fetch: obsidianFetch });

// 3. 部署（重跑是安全的：已套用的 Durable Object 遷移不會重送）
try {
  const { relayEndpoint } = await deployCloudflareRelayViaApi({
    apiToken: token,
    fetch: obsidianFetch,
    workerName: 'my-vault-relay',
    allowedPubkeys: [userPubkey],
    onProgress: (s) => console.log(s.step, s.message),
  });
  console.log('專屬中繼站開通完畢：', relayEndpoint); // wss://my-vault-relay.<subdomain>.workers.dev
} catch (e) {
  if (e instanceof CloudflareApiError) {
    const help = CLOUDFLARE_TOKEN_SETUP_GUIDE['zh-TW'].troubleshooting[e.kind]; // { symptom, cause, fix }
    // e.kind：'token-invalid' | 'permission' | 'account-ambiguous'（可選帳號在 e.accounts）| 'subdomain-missing'
    //       | 'name-conflict' | 'quota' | 'network' | 'lane-change'（重新部署改了 appLanes）| 'health' | 'api'
  }
  throw e;
}
```

Token 能用多個帳號時請帶 `accountId`（錯誤物件附有可選的 `accounts`）；帳號還沒有 `workers.dev` 子網域時，帶 `workersDevSubdomain` 註冊一個。站名、已知租戶車道（`appLanes`）、保存期、限速等站台參數見 `RelaySiteOptions`（[ADR 0037](docs/adr/0037-one-click-deploy-parameters.md)）；REST 重新部署會整份替換設定，請每次帶同一份。

### 4. 資源消耗與營運成本試算（CLI Estimator）
在決定密碼模式（Cinder EK vs 雙棘輪）或上雲部署前，可透過內建試算引擎精算每日事件數、頻寬與 Cloudflare 免費額度佔用比：
```bash
# 試算 15 人協同在雙棘輪與後量子模式下的扇出與額度消耗
npx cinderous estimate --mode=double-ratchet --pq --devices=5 --collaborators=15 --daily-actions=500 --payload-kb=20

# 要給程式讀就加 --json
```

---

## 📊 與傳統 Nostr Relay 技術對照

| 比較維度 | `strfry` | `nostr-rs-relay` | `khatru` | **`cinderous-relay`** |
| :--- | :--- | :--- | :--- | :--- |
| **底層架構** | Linux 常駐守護進程 | Linux 常駐守護進程 | Go 服務框架 | **邊緣無伺服器 ＋ 輕量本機雙模** |
| **儲存機制** | LMDB 重度磁碟寫入 | SQLite / PostgreSQL | 可自訂儲存 | **信令只在記憶體；加密的離線訊息與檔案塊存到保存期限** |
| **閒置記憶體** | ~100 MB | ~50 MB | ~30 MB | **< 15 MB (Docker) / 0 MB (Edge)** |
| **P2P 打洞支援**| 無特殊最佳化 | 無特殊最佳化 | 無特殊最佳化 | **原生瞬時撮合（Ephemeral Signaling）** |
| **存取門禁** | 開放 / 付費 / PoW | 開放 / 白名單 | 自行寫 Go 代碼擴充 | **NIP-42 雙向簽名白名單硬性隔離** |
| **主機月費** | $5 ~ $20/月 (VPS) | $5 ~ $20/月 (VPS) | $5 ~ $20/月 (VPS) | **$0（在 Cloudflare 免費額度內）** |

---

## 📖 規格與研究文件導覽

- [生產級產品需求與架構規格書 (PRD.md)](PRD.md)
- CinderSync（Obsidian 筆記庫同步）與 Cinder Coffice（Obsidian 即時協同）以這個 SDK 開發，規格書在它們自己的 repo，目前還沒公開。

---

## ☕ 贊助與支持 (Sponsor)

若這套開源架構與研究成果對您的去中心化應用開發有所啟發，歡迎為本專案點亮 Star，或請我們喝杯咖啡：

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-whoami885-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/whoami885)

---

## 📄 開源授權

本專案以 [GNU AGPL-3.0](LICENSE) 授權（2026-09-27 由 MIT 改為 AGPL，見 [ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)）。使用本 SDK 的應用在散布或以網路提供服務時，須依 AGPL 提供對應原始碼。

說明網站：<https://vaalrl.github.io/cinderous-sdk/>。歡迎貢獻（DCO 簽署），見 [CONTRIBUTING.md](CONTRIBUTING.md)；版本紀錄見 [CHANGELOG.md](CHANGELOG.md)。
