// 部署設定檔的產生器——**純函式、不碰 Node**（SDK ADR 0050 §2；原本分散在 cloudflare.ts、container.ts、docker.ts、fly.ts）。
//
// wrangler／docker／fly 一鍵部署（`.cinderous/<名稱>/`）與可攜的部署包（`relay build`、`renderDeployPackage`）
// 都用這裡的同一份產生器，原本的模組照舊轉出這些名字。環境變數一律經過 `relaySiteVars` 驗證。
// 🔴 本檔不得出現 `node:*`：部署包的產生器要能在瀏覽器（網頁設定器，P3）與外掛的行動版執行。
// 守門測試：tests/deploy/deploy-config-guard.test.ts。
import { RELAY_DO_BINDINGS, RELAY_DO_MIGRATIONS, relaySiteVars } from './shared.js';
/** 容器內中繼聽的埠 */
export const CONTAINER_PORT = 8080;
/** 保存模式的 SQLite 檔（掛 volume 的目錄） */
export const CONTAINER_DB_PATH = '/data/relay.db';
/** docker 目標預設對外的埠 */
export const DEFAULT_DOCKER_PORT = 8080;
/** Fly 預設區域：東京（對台灣最近） */
export const DEFAULT_FLY_REGION = 'nrt';
/** Fly 保存模式的 volume 名稱 */
export const FLY_VOLUME_NAME = 'relay_data';
/** 家中主機＋Cloudflare Tunnel 目標預設的 cloudflared 映像（SDK ADR 0050 §5） */
export const DEFAULT_CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:latest';
/** compose 發布位址的形狀（`node.bindAddress`；SDK ADR 0119）：IPv4 的四段，或只有十六進位與冒號的 IPv6（不加方括號） */
export const BIND_ADDRESS_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|(?=[0-9A-Fa-f:]{2,39}$)[0-9A-Fa-f]*:[0-9A-Fa-f:]*)$/;
/** 對所有網卡發布的位址 */
export const WILDCARD_BIND_ADDRESSES = ['0.0.0.0', '::'];
/**
 * docker 目標的發布位址（SDK ADR 0119）。Docker 發布的埠會繞過 ufw；開了 `trustProxy` 又對所有網卡發布，
 * 直接連埠的人就能自己帶 `X-Forwarded-For` 假裝成任何 IP——所以 `trustProxy` 時沒指定就只發布在 `127.0.0.1`
 * （反向代理在同一台）。沒開 `trustProxy`：照舊對所有網卡（區網裡直接用 `ws://` 連的樹莓派）。回 undefined＝不加前綴。
 */
export function composeBindAddress(bindAddress, trustProxy) {
    if (bindAddress !== undefined)
        return bindAddress;
    return trustProxy ? '127.0.0.1' : undefined;
}
/** 產生 wrangler 設定（PRD 5.3.3）。環境變數的值都經過 `relaySiteVars` 驗證。`header` 換掉第一行的註解（部署包用）。 */
export function renderWranglerToml(opts) {
    const lines = [
        ...(opts.header ?? ['# 由 `cinderous relay deploy` 產生（SDK ADR 0008）；重新部署會覆寫。']),
        `name = "${opts.name}"`,
        `main = "${opts.main}"`,
        `compatibility_date = "${opts.compatibilityDate}"`,
        // Account ID 不是秘密（部署包可以寫死它，wrangler 就不會用錯帳號）；沒給＝交給 CLOUDFLARE_ACCOUNT_ID 或登入狀態
        ...(opts.pinAccountId !== undefined ? [`account_id = ${JSON.stringify(opts.pinAccountId)}`] : []),
    ];
    for (const binding of RELAY_DO_BINDINGS) {
        lines.push('', '[[durable_objects.bindings]]', `name = "${binding.name}"`, `class_name = "${binding.className}"`);
    }
    for (const migration of RELAY_DO_MIGRATIONS) {
        const classes = migration.newSqliteClasses.map((c) => `"${c}"`).join(', ');
        lines.push('', '[[migrations]]', `tag = "${migration.tag}"`, `new_sqlite_classes = [${classes}]`);
    }
    lines.push('', '[observability]', 'enabled = true');
    // 環境變數與 REST 上傳共用同一份（relaySiteVars）：防濫用預設（ADR 0013）與白名單（ADR 0008）
    lines.push('', '[vars]');
    const vars = relaySiteVars(opts, 'worker');
    const secret = new Set(opts.secretVars ?? []);
    // 站名、描述等是自由文字：以 JSON 字串寫成 TOML 基本字串（控制字元已在 relaySiteVars 擋掉，引號與反斜線會被跳脫）
    for (const [key, value] of Object.entries(vars)) {
        if (secret.has(key))
            lines.push(`# ${key}：秘密，以 \`npx wrangler@4 secret put ${key}\` 設定（見 README-DEPLOY.md）／secret, set with \`wrangler secret put ${key}\``);
        else
            lines.push(`${key} = ${JSON.stringify(value)}`);
    }
    return `${lines.join('\n')}\n`;
}
const forwardSlashes = (path) => path.split('\\').join('/');
/** Worker 入口：注入部署者的版號（NIP-11 `version`），轉出 SDK 的 Worker 與 Durable Object 類別（`RelayRoom`、`IotHomeRoom`）。 */
export function renderWorkerEntry(opts) {
    const dist = forwardSlashes(opts.sdkDistDir).replace(/\/$/, '');
    const worker = JSON.stringify(`${dist}/relay/worker.js`);
    return [
        '// 由 `cinderous relay deploy` 產生（SDK ADR 0008）。',
        `import { setRelayVersion } from ${JSON.stringify(`${dist}/relay/version.js`)};`,
        `setRelayVersion(${JSON.stringify(opts.version)});`,
        `export { default } from ${worker};`,
        `export * from ${worker};`,
        '',
    ].join('\n');
}
/**
 * 容器的 Dockerfile（SDK ADR 0018）。`embedSdk: false`＝SDK 以套件相依安裝（公開後、或 `--sdk-spec`），不複製 `sdk/`。
 */
export function renderDockerfile(version, opts = {}) {
    const header = opts.header ?? ['# 由 `cinderous relay deploy` 產生（SDK ADR 0018）；重新部署會覆寫。'];
    const lines = [
        ...header,
        'FROM node:22-slim',
        'WORKDIR /app',
        '# 先裝相依再放程式：程式改了不必重裝相依',
        'COPY package.json ./',
        ...(opts.embedSdk === false ? [] : ['COPY sdk ./sdk']),
        'RUN npm install --omit=dev --no-audit --no-fund',
        'COPY server.mjs ./',
        `ENV PORT=${CONTAINER_PORT} RELAY_VERSION=${version}`,
        `EXPOSE ${CONTAINER_PORT}`,
        '# node:22 的 node:sqlite 需要這個旗標（保存模式用；純記憶體模式不會載入它）',
        'CMD ["node", "--experimental-sqlite", "server.mjs"]',
        '',
    ];
    return lines.join('\n');
}
export function renderServerEntry(opts = {}) {
    return [
        ...(opts.header ?? ['// 由 `cinderous relay deploy` 產生（SDK ADR 0018）。']),
        "import { setRelayVersion } from '@cinderous/client/relay';",
        "import { startNodeRelay } from '@cinderous/client/relay/node';",
        '',
        "setRelayVersion(process.env.RELAY_VERSION ?? '0.0.0');",
        '// PERSIST=1 才寫 SQLite（DB_PATH 在掛好的 volume 上）；否則純記憶體，重啟即清空（SDK ADR 0008）',
        "startNodeRelay(process.env, { memory: process.env.PERSIST !== '1' });",
        '',
    ].join('\n');
}
/**
 * 容器的環境變數：站台參數（白名單、站名、防濫用、保存期、檔案塊……）與 Worker 共用 `relaySiteVars`（SDK ADR 0036、0037），
 * 另外加上容器才有的保存模式與是否信任前面的代理。只有 Cloudflare 版支援的參數（車道等）在這裡會丟例外。
 */
export function relayEnvironment(opts) {
    const env = relaySiteVars(opts, 'node');
    if (opts.persist) {
        env.PERSIST = '1';
        env.DB_PATH = CONTAINER_DB_PATH;
    }
    // 前面有代理（Fly 的邊緣、Cloudflare Tunnel）才信 X-Forwarded-For；直接對外時那個標頭任何人都能偽造（SDK ADR 0013）
    if (opts.trustProxy)
        env.TRUST_PROXY = '1';
    return env;
}
/** 建置內容的 .dockerignore：不把相依、秘密與資料庫送進建置內容（部署包的 `.env` 也在同一個資料夾）。 */
export function renderDockerignore() {
    return ['node_modules', '.env', '.env.*', '!.env.example', '.secrets', '.dev.vars', '*.db', ''].join('\n');
}
const yamlString = (value) => JSON.stringify(value); // JSON 字串就是合法的 YAML 雙引號字串
/** C′ 閘道私鑰的環境變數（relay 讀的名字；SDK ADR 0121） */
export const IOT_GATEWAY_KEYS_ENV = 'IOT_GATEWAY_KEYS';
/** compose 的必填代入：`${NAME:?…}`——沒設就拒絕啟動，而不是帶著空值跑起來 */
export function composeRequiredEnv(name, why) {
    return `\${${name}:?set ${name} in .env (${why})}`;
}
export function renderCompose(opts) {
    const persist = opts.environment.PERSIST === '1';
    const bind = opts.bindAddress === undefined ? '' : opts.bindAddress.includes(':') ? `[${opts.bindAddress}]:` : `${opts.bindAddress}:`;
    const env = Object.entries(opts.environment).map(([key, value]) => `      ${key}: ${yamlString(value)}`);
    const tunnel = opts.tunnel;
    return [
        ...(opts.header ?? ['# 由 `cinderous relay deploy --provider=docker` 產生（SDK ADR 0018）；重新部署會覆寫。']),
        'services:',
        '  relay:',
        '    build: .',
        `    container_name: ${opts.name}`,
        '    restart: unless-stopped',
        // Tunnel 模式不發布埠：只有同一個 compose 網路裡的 cloudflared 連得到（不對區網或網際網路開放）
        ...(tunnel ? ['    expose:', `      - ${yamlString(String(CONTAINER_PORT))}`] : ['    ports:', `      - ${yamlString(`${bind}${opts.port}:${CONTAINER_PORT}`)}`]),
        '    environment:',
        ...env,
        ...(persist ? ['    volumes:', '      - relay-data:/data'] : []),
        ...(tunnel
            ? [
                '  cloudflared:',
                `    image: ${yamlString(tunnel.image ?? DEFAULT_CLOUDFLARED_IMAGE)}`,
                `    container_name: ${opts.name}-tunnel`,
                '    restart: unless-stopped',
                '    command: ["tunnel", "--no-autoupdate", "run"]',
                '    environment:',
                // compose 會讀同一個資料夾的 .env 代入；沒設就在啟動前報錯，不會起一個連不上的 tunnel
                `      TUNNEL_TOKEN: ${yamlString(`\${${tunnel.tokenEnv}:?請在 .env 設定 ${tunnel.tokenEnv}（Cloudflare Tunnel Token）}`)}`,
                '    depends_on:',
                '      - relay',
            ]
            : []),
        ...(persist ? ['volumes:', '  relay-data: {}'] : []),
        '',
    ].join('\n');
}
const tomlString = (value) => JSON.stringify(value); // 只含可列印字元時，JSON 字串就是合法的 TOML 基本字串
export function renderFlyToml(opts) {
    const env = Object.entries({ PORT: String(CONTAINER_PORT), ...opts.environment }).map(([key, value]) => `  ${key} = ${tomlString(value)}`);
    return [
        ...(opts.header ?? ['# 由 `cinderous relay deploy --provider=fly` 產生（SDK ADR 0018）；重新部署會覆寫。']),
        `app = ${tomlString(opts.name)}`,
        `primary_region = ${tomlString(opts.region)}`,
        '',
        '[build]',
        '  dockerfile = "Dockerfile"',
        '',
        '[env]',
        ...env,
        '',
        '[http_service]',
        `  internal_port = ${CONTAINER_PORT}`,
        '  force_https = true',
        '  auto_stop_machines = "off"',
        '  auto_start_machines = true',
        '  min_machines_running = 1',
        '',
        '  [[http_service.checks]]',
        '    grace_period = "10s"',
        '    interval = "30s"',
        '    method = "GET"',
        '    path = "/healthz"',
        '    timeout = "5s"',
        ...(opts.persist ? ['', '[[mounts]]', `  source = ${tomlString(FLY_VOLUME_NAME)}`, '  destination = "/data"'] : []),
        '',
    ].join('\n');
}
// ── IoT 家中橋接器的容器（SDK ADR 0049 P0；使用者裁示 4：橋接器先做 Docker）────────────────────────
/** 橋接器容器裡設定檔的位置（唯讀掛載） */
export const IOT_BRIDGE_CONFIG_PATH = '/config/iot-bridge.json';
/** 橋接器容器裡角色名單存檔的位置（named volume，owner 經 `$sys/acl` 的修改要留得住） */
export const IOT_BRIDGE_ACL_PATH = '/data/iot-acl.json';
/** 橋接器容器裡推播端點存檔的位置（設定檔有 `push` 段時才用；ADR 0049 §11.1） */
export const IOT_BRIDGE_PUSH_PATH = '/data/iot-push.json';
/** 建置內容安裝的 mqtt.js 版本範圍（選用 peer 相依，橋接器才需要） */
export const IOT_BRIDGE_MQTT_RANGE = '^5.16.0';
/** 橋接器的 Dockerfile：裝 SDK（`sdk/`）與 mqtt.js，跑 `cinderous iot bridge` */
export function renderIotBridgeDockerfile(version, opts = {}) {
    return [
        ...(opts.header ?? ['# 由 `cinderous iot build` 產生（SDK ADR 0049）；重新產生會覆寫。']),
        'FROM node:22-slim',
        'WORKDIR /app',
        'COPY package.json ./',
        'COPY sdk ./sdk',
        'RUN npm install --omit=dev --no-audit --no-fund',
        `ENV NODE_ENV=production CINDEROUS_SDK_VERSION=${version}`,
        '# 角色名單與推播端點存在 /data（named volume）；設定檔唯讀掛在 /config。秘密（家庭秘密、閘道私鑰、MQTT 密碼）只從環境變數（.env）讀',
        'RUN mkdir -p /data && chown node:node /data',
        'USER node',
        `CMD ["node", "node_modules/@cinderous/client/dist/cli/index.js", "iot", "bridge", "--config", "${IOT_BRIDGE_CONFIG_PATH}", "--acl-file", "${IOT_BRIDGE_ACL_PATH}", "--push-file", "${IOT_BRIDGE_PUSH_PATH}"]`,
        '',
    ].join('\n');
}
/** 橋接器建置內容的 package.json */
export function renderIotBridgePackageJson() {
    return `${JSON.stringify({ name: 'cinderous-iot-bridge', private: true, type: 'module', dependencies: { '@cinderous/client': 'file:./sdk', mqtt: IOT_BRIDGE_MQTT_RANGE } }, null, 2)}\n`;
}
/**
 * 橋接器的 compose：`network_mode: host`（只有 Linux 有效）讓容器以 `mqtt://localhost:1883` 連到家中既有的 broker；
 * 橋接器只**往外**連 relay 與 broker，不發布任何埠。
 */
export function renderIotBridgeCompose(opts = {}) {
    const name = opts.name ?? 'cinderous-iot-bridge';
    return [
        ...(opts.header ?? ['# 由 `cinderous iot build` 產生（SDK ADR 0049）；重新產生會覆寫。']),
        'services:',
        '  iot-bridge:',
        '    build: .',
        `    container_name: ${yamlString(name)}`,
        '    restart: unless-stopped',
        '    # 連區網的 MQTT broker（Linux）；Docker Desktop（macOS／Windows）請改掉這一行，並把 mqtt.url 設成 host.docker.internal',
        '    network_mode: host',
        '    env_file: .env',
        '    volumes:',
        `      - ./iot-bridge.json:${IOT_BRIDGE_CONFIG_PATH}:ro`,
        '      - iot-data:/data',
        'volumes:',
        '  iot-data: {}',
        '',
    ].join('\n');
}
/** 橋接器的 `.env.example`：只列名稱，不含任何值 */
export function renderIotBridgeEnvExample() {
    return [
        '# 複製成 .env 再填值；.env 不要提交（SDK ADR 0049、0050 §4）。',
        '# 家庭秘密（64 位 hex；`cinderous iot keygen` 產生）：所有成員與閘道共用，經 QR 配對發給家人',
        'IOT_HOME_SECRET=',
        '# 閘道自己的 Nostr 私鑰（nsec 或 64 位 hex）',
        'IOT_GATEWAY_KEY=',
        '# 本地 MQTT broker 的密碼（設定檔 mqtt.password 寫 { "$env": "MQTT_PASSWORD" } 時）',
        'MQTT_PASSWORD=',
        '',
    ].join('\n');
}
//# sourceMappingURL=render.js.map