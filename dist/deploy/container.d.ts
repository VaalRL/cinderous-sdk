export { CONTAINER_DB_PATH, CONTAINER_PORT, relayEnvironment, renderDockerfile, renderServerEntry } from './render.js';
/**
 * 把 SDK 的執行用內容複製到 `sdkDir`（`.cinderous/<名稱>/sdk/` 與 `relay build` 的部署包共用；SDK ADR 0018、0050）：
 * `dist`、精簡過的 package.json（不帶開發相依、不帶 scripts——映像裡不跑任何 script）與 LICENSE（AGPL §6）。
 * 先清掉舊的 `sdkDir`，換版時不會留下上一版的檔案。
 */
export declare function copySdkRuntime(sdkDir: string, sdkRoot?: string): void;
/** 寫出建置內容：sdk/、package.json、server.mjs、Dockerfile、.dockerignore */
export declare function prepareNodeRelayContext(opts: {
    workDir: string;
    sdkRoot?: string;
    version?: string;
}): void;
/**
 * IoT 家中橋接器的建置內容（SDK ADR 0049 P0；沿用 ADR 0018 的 `sdk/` 內嵌）：sdk/、package.json（多裝 mqtt.js）、
 * Dockerfile、compose.yaml、.dockerignore、.env.example；有給設定檔就複製成 `iot-bridge.json`（設定檔只有 `$env` 引用，不含秘密）。
 */
export declare function prepareIotBridgeContext(opts: {
    workDir: string;
    configPath?: string;
    sdkRoot?: string;
    version?: string;
}): string[];
//# sourceMappingURL=container.d.ts.map