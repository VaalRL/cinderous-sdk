// 容器化部署共用的建置內容（SDK ADR 0018）：`--provider=docker` 與 `--provider=fly` 都用它。
//
// 映像裡跑的是 SDK 的 Node 中繼主機（`startNodeRelay`）。SDK 目前是私有 repo，映像裡的
// `npm install` 拿不到 git 相依，所以把 SDK 套件本身放進建置內容（`sdk/`），以 `file:./sdk` 安裝；
// SDK 自己的相依（@noble、nostr-tools、ws……）都在公開的 npm 上。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sdkRootDir, sdkVersion } from './common.js';
import { renderDockerfile, renderDockerignore, renderIotBridgeCompose, renderIotBridgeDockerfile, renderIotBridgeEnvExample, renderIotBridgePackageJson, renderServerEntry, } from './render.js';
// 產生器搬到不碰 Node 的 render.ts（SDK ADR 0050），這裡轉出以維持原本的匯出
export { CONTAINER_DB_PATH, CONTAINER_PORT, relayEnvironment, renderDockerfile, renderServerEntry } from './render.js';
/**
 * 把 SDK 的執行用內容複製到 `sdkDir`（`.cinderous/<名稱>/sdk/` 與 `relay build` 的部署包共用；SDK ADR 0018、0050）：
 * `dist`、精簡過的 package.json（不帶開發相依、不帶 scripts——映像裡不跑任何 script）與 LICENSE（AGPL §6）。
 * 先清掉舊的 `sdkDir`，換版時不會留下上一版的檔案。
 */
export function copySdkRuntime(sdkDir, sdkRoot = sdkRootDir()) {
    rmSync(sdkDir, { recursive: true, force: true });
    mkdirSync(sdkDir, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
    const runtimePkg = {};
    for (const key of ['name', 'version', 'license', 'type', 'exports', 'bin', 'dependencies', 'optionalDependencies']) {
        if (pkg[key] !== undefined)
            runtimePkg[key] = pkg[key];
    }
    writeFileSync(join(sdkDir, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
    cpSync(join(sdkRoot, 'dist'), join(sdkDir, 'dist'), { recursive: true });
    if (existsSync(join(sdkRoot, 'LICENSE')))
        cpSync(join(sdkRoot, 'LICENSE'), join(sdkDir, 'LICENSE'));
}
/** 寫出建置內容：sdk/、package.json、server.mjs、Dockerfile、.dockerignore */
export function prepareNodeRelayContext(opts) {
    const sdkRoot = opts.sdkRoot ?? sdkRootDir();
    const version = opts.version ?? sdkVersion(sdkRoot);
    mkdirSync(opts.workDir, { recursive: true });
    copySdkRuntime(join(opts.workDir, 'sdk'), sdkRoot);
    writeFileSync(join(opts.workDir, 'package.json'), `${JSON.stringify({ name: 'cinderous-relay-deploy', private: true, type: 'module', dependencies: { '@cinderous/client': 'file:./sdk' } }, null, 2)}\n`);
    writeFileSync(join(opts.workDir, 'server.mjs'), renderServerEntry());
    writeFileSync(join(opts.workDir, 'Dockerfile'), renderDockerfile(version));
    writeFileSync(join(opts.workDir, '.dockerignore'), renderDockerignore());
}
/**
 * IoT 家中橋接器的建置內容（SDK ADR 0049 P0；沿用 ADR 0018 的 `sdk/` 內嵌）：sdk/、package.json（多裝 mqtt.js）、
 * Dockerfile、compose.yaml、.dockerignore、.env.example；有給設定檔就複製成 `iot-bridge.json`（設定檔只有 `$env` 引用，不含秘密）。
 */
export function prepareIotBridgeContext(opts) {
    const sdkRoot = opts.sdkRoot ?? sdkRootDir();
    const version = opts.version ?? sdkVersion(sdkRoot);
    mkdirSync(opts.workDir, { recursive: true });
    copySdkRuntime(join(opts.workDir, 'sdk'), sdkRoot);
    const files = [
        ['package.json', renderIotBridgePackageJson()],
        ['Dockerfile', renderIotBridgeDockerfile(version)],
        ['compose.yaml', renderIotBridgeCompose()],
        ['.dockerignore', renderDockerignore()],
        ['.env.example', renderIotBridgeEnvExample()],
    ];
    if (opts.configPath !== undefined)
        files.push(['iot-bridge.json', readFileSync(opts.configPath, 'utf8')]);
    for (const [name, content] of files)
        writeFileSync(join(opts.workDir, name), content);
    return [...files.map(([name]) => name), 'sdk/'];
}
//# sourceMappingURL=container.js.map