# 0119. Node 中繼在反向代理後方：`X-Forwarded-For` 從右邊數、`HOST`、docker 的 `node.bindAddress`

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「先做 ADR 0109 的安全補強」
- 日期：2026-10-28
- 對應：SDK ADR 0109（VPS 自架指南；本 ADR 做掉它〈後續〉的三項）、0013（存取控制、`TRUST_PROXY`）、0018（docker／fly）、0050（部署設定器）、0100（每個 IP 的連線數上限）

## Context

ADR 0109 寫指南時對照原始碼，發現 Node 中繼在反向代理後方有三個坑，當時列為〈後續〉、要使用者決定：

1. **產生的 `docker-compose.yml` 是 `"8080:8080"`，對所有網卡發布。**
   - Docker 自己改 iptables，發布的埠會**繞過 ufw**。
   - 設了 `trustProxy` 時，直接連 8080 的人可以自己帶 `X-Forwarded-For` 假裝成任何 IP，躲過每個 IP 的限速與連線數上限（ADR 0013、0100）。
2. **中繼取 `X-Forwarded-For` 的第一段**（`node-relay.ts`）。會「附加」的代理把客戶端自己帶的值留在最左邊：
   - nginx 的 `$proxy_add_x_forwarded_for`；
   - Cloudflare 的邊緣；
   - Fly 的代理。

   所以就算前面有代理，客戶端在前面加一段也能換一個 IP。
3. **Node 直跑（systemd）時中繼一定聽 `0.0.0.0`**，沒有只聽本機的選項，只能靠防火牆。

## Decision

### 1. `X-Forwarded-For` 從右邊數；`TRUST_PROXY` 是層數

- `trustedProxyHopsFrom(TRUST_PROXY)`：
  - `1`＝一層代理（Caddy、nginx、Fly 的邊緣、cloudflared），與之前的開關相同；
  - `2`–`10`＝幾層（例如 Cloudflare 橘色雲＋自己的 Caddy）；
  - 沒設、`0`、其他值＝不信任。`true`、`yes` 照舊不算，與之前相同。
- `clientIpFrom(xff, remoteAddress, hops)` 取**從右邊數第 `hops` 段**：
  - 最右邊那幾段是信任的代理寫的，客戶端自己帶的值都在左邊；
  - 段數比層數少時取最左邊，因為每一段都是信任的代理寫的；
  - 沒有標頭或是空的，就用連線的來源位址。
- 兩個函式都在 `host-config.ts`，Node 中繼用它們。Workers 版用 Cloudflare 給的連線來源，不讀這個標頭，不受影響。
- **行為變更**：一層代理、而且代理會附加時，算出來的 IP 從「客戶端自己帶的」變成「代理看到的」。
  - 會覆寫標頭的代理（Caddy 預設、nginx 的 `$remote_addr`）只有一段，結果相同。
  - Fly、home-tunnel、會附加的 nginx：限速從「可以被繞過」變成算在真正的來源上。

### 2. `HOST`：Node 中繼的監聽位址

- `startNodeRelay` 讀 `HOST`。沒設就是所有位址，與之前相同；設了就 `listen(port, host)`。位址不是這台機器的，`ready` 以錯誤結束，不會默默聽在別處。啟動訊息印出實際的位址。
- `cinderous relay start --host <位址>` 寫進 `HOST`。
- 容器裡**不設**：容器內要聽所有位址，Docker 的埠轉送才進得來。限制改由 compose 的發布位址負責（§3）。
- VPS 指南的 systemd 路線改成 `HOST=127.0.0.1`，ufw 照樣不開 8080，多一層保護。

### 3. docker 目標：`node.bindAddress`，`trustProxy` 時預設 `127.0.0.1`

- 新欄位 `node.bindAddress`：
  - 只適用 docker 目標。home-tunnel 本來就不發布埠；fly 的埠由 Fly 的邊緣處理。
  - 格式是 IPv4，或不加方括號的 IPv6；compose 產生時會自動加上方括號。
  - 寫進描述表，JSON Schema、參考頁、精靈（進階）都跟著變。
- 發布位址由 `composeBindAddress(bindAddress, trustProxy)` 決定：
  - 有給 `bindAddress` 就照給的；
  - 沒給、但開了 `trustProxy` → **`127.0.0.1`**（反向代理在同一台，例如 VPS 上的 Caddy）；
  - 沒給、也沒開 `trustProxy` → 照舊對所有網卡發布。區網裡直接用 `ws://` 連的樹莓派靠的就是這個，ADR 0109 指出這是「要另外決定的行為變更」，所以只在開了 `trustProxy` 時改。
- `config validate`：docker 開了 `trustProxy`，又明確設 `0.0.0.0` 或 `::` → 警告 `public-bind-trust-proxy`。不是錯誤：也許前面還有一層網路防火牆或安全群組。
- `relay build` 與 `relay deploy --provider docker`（`deployDockerRelay`）用同一個 `composeBindAddress`：
  - `deployDockerRelay` 收 `bindAddress`，不是 IP 就在寫任何檔案之前拒絕；
  - 發布在某個特定位址時，健康檢查與回傳的端點改用那個位址，因為 localhost 不一定連得到。
- 部署說明：
  - 第 4 節寫出「compose 只把埠發布在 `<位址>:<埠>`」；
  - 第 9 節（安全檢查清單）在 docker 目標加一條「Docker 發布的埠會繞過 ufw」。有限制發布位址時，附「從另一台機器 curl 應該連不上」；沒有限制時說明「目前對所有網卡發布，只適合區網直連」。
- `DEPLOY_AFFECTING_CHANGES` 加一筆 0.80.0，舊設定檔 `config migrate`、`config validate` 時列出。

## Alternatives Considered

- **`bindAddress` 一律預設 `127.0.0.1`**：最安全，但會讓區網直連的樹莓派升級後連不上。只在開了 `trustProxy` 時改，能保住「對外開放＋信任 X-Forwarded-For」不再出現，又不動那個用法。
- **另外加 `TRUST_PROXY_HOPS`**：多一個變數要記。`TRUST_PROXY` 本來就是「信任前面的代理」，改成層數後，`1` 的意思不變。
- **讀 `Forwarded`（RFC 7239）或 `CF-Connecting-IP`**：常見的代理（Caddy、nginx、Fly、cloudflared）都送 `X-Forwarded-For`；只認 Cloudflare 的標頭，等於假設前面一定是 Cloudflare，而 Node 中繼直接對外時，這個標頭也能偽造。

## Consequences

- ＋ 「對外開放、又信任 `X-Forwarded-For`」的 compose 不會再被產生出來；要那樣得明確設 `0.0.0.0`，而且會被警告。
- ＋ 會附加的代理後方，客戶端不能再靠自己帶的 `X-Forwarded-For` 換 IP。
- ＋ systemd 路線可以只聽本機，不必只靠 ufw。
- － 行為變更（§1、§3），寫進 CHANGELOG 與 `DEPLOY_AFFECTING_CHANGES`：
  - 開了 `trustProxy` 的 docker 部署包重新產生後，只有同一台的程式連得到 8080。反向代理在別台的要設 `node.bindAddress`。
  - 兩層代理卻只設 `TRUST_PROXY=1` 的站，算到的會是內層代理的 IP（原本是客戶端自己帶的那段），要改設 `2`。
- － 橘色雲（Cloudflare 代理）＋Caddy 時，Caddy 預設不信任 Cloudflare 帶來的標頭，中繼看到的是 Cloudflare 的 IP。指南寫明要 `trusted_proxies`＋`TRUST_PROXY=2`；這個組合沒驗證過，仍建議 DNS only。

## 驗證

- `tests/relay/node-proxy-and-host.test.ts`（9 個）：
  - `trustedProxyHopsFrom` 的各種值；
  - `clientIpFrom`：不信任、一層取最右邊、兩層、段數不足、空標頭；
  - 真的 Node 中繼：`TRUST_PROXY=1`＋`MAX_CONNECTIONS_PER_IP=1` 時，前面加一段換不到新名額；
  - `HOST=127.0.0.1` 時區網位址連不到；沒設時連得到；不是本機的位址 → `ready` 以錯誤結束。
  - 把 `clientIpFrom` 改回取第一段，3 個測試失敗；把 `listen` 改回不帶 `host`，2 個失敗；改回後通過。
- `tests/deploy/deploy-bind-address.test.ts`（13 個）：
  - `composeBindAddress`；`renderCompose` 的 IPv4／IPv6／沒給；
  - 部署包（`trustProxy` → `127.0.0.1`、沒開照舊、指定照寫、home-tunnel 不發布）；
  - 說明（兩種語言的 ufw 與 `127.0.0.1:8080`）；
  - 驗證（合法與不合法的位址、`0.0.0.0`／`::`＋`trustProxy` 的警告、fly 不適用）；
  - `deployDockerRelay`（預設 `127.0.0.1`、區網位址的健康檢查與端點、不是 IP 就拒絕）。
- `tests/cli/cli.test.ts`（新增 1 個）：`--host` → `HOST`，沒給不設、沿用環境變數。
- `tests/deploy/deploy-package.test.ts` 的快照：docker（沒開 `trustProxy`）的兩份說明多了 ufw 那一條，其餘不變。
- 真的程序（Windows，`dist/cli/index.js`）：`relay start --host 127.0.0.1` 印出 `ws://127.0.0.1:<埠>`，`/healthz` 從 127.0.0.1 回 `ok`、從區網位址連不到；`trustProxy` 的 docker 設定 `relay build` 產生 `"127.0.0.1:8080:8080"`、說明有 ufw 那一條；加上 `bindAddress: "0.0.0.0"` 時 `config validate` 提醒。
- 全部測試 3227 個：1 個 Vault 同步的測試在全套負載下逾時，單獨重跑 52 個全過，與本 ADR 無關。
- **沒有在真的 VPS、Docker、Caddy 上跑過**（這台機器沒有 Docker）。
