import { type RelaySiteOptions } from './shared.js';
/** 容器內中繼聽的埠 */
export declare const CONTAINER_PORT = 8080;
/** 保存模式的 SQLite 檔（掛 volume 的目錄） */
export declare const CONTAINER_DB_PATH = "/data/relay.db";
/** docker 目標預設對外的埠 */
export declare const DEFAULT_DOCKER_PORT = 8080;
/** Fly 預設區域：東京（對台灣最近） */
export declare const DEFAULT_FLY_REGION = "nrt";
/** Fly 保存模式的 volume 名稱 */
export declare const FLY_VOLUME_NAME = "relay_data";
/** 家中主機＋Cloudflare Tunnel 目標預設的 cloudflared 映像（SDK ADR 0050 §5） */
export declare const DEFAULT_CLOUDFLARED_IMAGE = "cloudflare/cloudflared:latest";
/** 產生 wrangler 設定（PRD 5.3.3）。環境變數的值都經過 `relaySiteVars` 驗證。`header` 換掉第一行的註解（部署包用）。 */
export declare function renderWranglerToml(opts: {
    name: string;
    main: string;
    compatibilityDate: string;
    pinAccountId?: string;
    header?: readonly string[];
    /**
     * 不寫進 `[vars]` 的變數（SDK ADR 0051）：它們是秘密，改用 `wrangler secret put` 設定——部署包可以提交、不能含秘密。
     * 每一個都會在 `[vars]` 下留一行註解說明。
     */
    secretVars?: readonly string[];
} & RelaySiteOptions): string;
/** Worker 入口：注入部署者的版號（NIP-11 `version`），轉出 SDK 的 Worker 與 `RelayRoom`。 */
export declare function renderWorkerEntry(opts: {
    sdkDistDir: string;
    version: string;
}): string;
/**
 * 容器的 Dockerfile（SDK ADR 0018）。`embedSdk: false`＝SDK 以套件相依安裝（公開後、或 `--sdk-spec`），不複製 `sdk/`。
 */
export declare function renderDockerfile(version: string, opts?: {
    embedSdk?: boolean;
    header?: readonly string[];
}): string;
export declare function renderServerEntry(opts?: {
    header?: readonly string[];
}): string;
/**
 * 容器的環境變數：站台參數（白名單、站名、防濫用、保存期、檔案塊……）與 Worker 共用 `relaySiteVars`（SDK ADR 0036、0037），
 * 另外加上容器才有的保存模式與是否信任前面的代理。只有 Cloudflare 版支援的參數（車道等）在這裡會丟例外。
 */
export declare function relayEnvironment(opts: RelaySiteOptions & {
    persist: boolean;
    trustProxy: boolean;
}): Record<string, string>;
/** 建置內容的 .dockerignore：不把相依、秘密與資料庫送進建置內容（部署包的 `.env` 也在同一個資料夾）。 */
export declare function renderDockerignore(): string;
/** 家中主機＋Cloudflare Tunnel（SDK ADR 0050 §5）：relay 不發布埠，`cloudflared` 從環境變數（`.env`）讀 Token。 */
export interface ComposeTunnelOptions {
    /** 放 Tunnel Token 的環境變數名稱（設定檔 `secrets.tunnelToken.$env`），例如 `TUNNEL_TOKEN` */
    tokenEnv: string;
    /** cloudflared 映像，預設 {@link DEFAULT_CLOUDFLARED_IMAGE} */
    image?: string;
}
export declare function renderCompose(opts: {
    name: string;
    port: number;
    environment: Record<string, string>;
    header?: readonly string[];
    tunnel?: ComposeTunnelOptions;
}): string;
export declare function renderFlyToml(opts: {
    name: string;
    region: string;
    environment: Record<string, string>;
    persist: boolean;
    header?: readonly string[];
}): string;
/** 橋接器容器裡設定檔的位置（唯讀掛載） */
export declare const IOT_BRIDGE_CONFIG_PATH = "/config/iot-bridge.json";
/** 橋接器容器裡角色名單存檔的位置（named volume，owner 經 `$sys/acl` 的修改要留得住） */
export declare const IOT_BRIDGE_ACL_PATH = "/data/iot-acl.json";
/** 橋接器容器裡推播端點存檔的位置（設定檔有 `push` 段時才用；ADR 0049 §11.1） */
export declare const IOT_BRIDGE_PUSH_PATH = "/data/iot-push.json";
/** 建置內容安裝的 mqtt.js 版本範圍（選用 peer 相依，橋接器才需要） */
export declare const IOT_BRIDGE_MQTT_RANGE = "^5.16.0";
/** 橋接器的 Dockerfile：裝 SDK（`sdk/`）與 mqtt.js，跑 `cinderous iot bridge` */
export declare function renderIotBridgeDockerfile(version: string, opts?: {
    header?: readonly string[];
}): string;
/** 橋接器建置內容的 package.json */
export declare function renderIotBridgePackageJson(): string;
/**
 * 橋接器的 compose：`network_mode: host`（只有 Linux 有效）讓容器以 `mqtt://localhost:1883` 連到家中既有的 broker；
 * 橋接器只**往外**連 relay 與 broker，不發布任何埠。
 */
export declare function renderIotBridgeCompose(opts?: {
    name?: string;
    header?: readonly string[];
}): string;
/** 橋接器的 `.env.example`：只列名稱，不含任何值 */
export declare function renderIotBridgeEnvExample(): string;
//# sourceMappingURL=render.d.ts.map