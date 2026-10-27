#!/usr/bin/env node
// `cinderous` 命令列進入點（SDK ADR 0008、0050、0049）：把真的實作接上 `runCli`。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildRelayPackage } from '../deploy/build.js';
import { deployCloudflareRelay } from '../deploy/cloudflare.js';
import { sdkVersion } from '../deploy/common.js';
import { prepareIotBridgeContext } from '../deploy/container.js';
import { deployDockerRelay } from '../deploy/docker.js';
import { deployFlyRelay } from '../deploy/fly.js';
import { connectIotClient, startIotBridgeFromConfig } from '../iot/bridge/index.js';
import { startNodeRelay } from '../relay/node-relay.js';
import { runCli } from './commands.js';
const code = await runCli(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    env: process.env,
    cwd: process.cwd(),
    startNodeRelay,
    deployCloudflareRelay,
    deployDockerRelay,
    deployFlyRelay,
    writeFile: (path, content) => writeFileSync(path, content),
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    buildRelayPackage,
    sdkVersion: sdkVersion(),
    startIotBridge: async (config, extra) => {
        const bridge = await startIotBridgeFromConfig(config, extra);
        // 收到停止訊號：先發 online: false 的心跳、關掉 MQTT 與 relay 連線再離開（docker stop 送的是 SIGTERM）
        const stop = () => {
            void bridge.close().finally(() => process.exit(0));
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        return bridge;
    },
    connectIotClient,
    prepareIotBridgeContext: (opts) => prepareIotBridgeContext(opts),
});
// `relay start`、`iot bridge` 成功時服務還開著，不能結束程序；其他指令做完就照結束碼離開。
const longRunning = (process.argv[2] === 'relay' && process.argv[3] === 'start') || (process.argv[2] === 'iot' && process.argv[3] === 'bridge');
if (code !== 0 || !longRunning)
    process.exit(code);
//# sourceMappingURL=index.js.map