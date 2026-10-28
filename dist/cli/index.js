#!/usr/bin/env node
// `cinderous` 命令列進入點（SDK ADR 0008、0050、0049）：把真的實作接上 `runCli`。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { buildRelayPackage } from '../deploy/build.js';
import { deployCloudflareRelay } from '../deploy/cloudflare.js';
import { deployCloudflareRelayViaApi } from '../deploy/cloudflare-api/index.js';
import { sdkVersion } from '../deploy/common.js';
import { prepareIotBridgeContext } from '../deploy/container.js';
import { deployDockerRelay } from '../deploy/docker.js';
import { deployFlyRelay } from '../deploy/fly.js';
import { connectIotClient, startIotBridgeFromConfig } from '../iot/bridge/index.js';
import { startNodeRelay } from '../relay/node-relay.js';
import { runCli } from './commands.js';
// `init` 精靈的輸入（SDK ADR 0117）：用到才開 readline。讀到的行先排隊——管線一次送進好幾行時，還沒問到的題目也拿得到；
// 輸入結束（Ctrl+D、管線讀完）時，等待中的題目以錯誤結束，不會卡住。
let rl;
const pendingLines = [];
let waiting;
let inputClosed = false;
const inputEnded = () => new Error('輸入已經結束，精靈停止');
function prompt(question) {
    if (rl === undefined) {
        rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on('line', (line) => {
            const w = waiting;
            waiting = undefined;
            if (w)
                w.resolve(line);
            else
                pendingLines.push(line);
        });
        rl.once('close', () => {
            inputClosed = true;
            waiting?.reject(inputEnded());
            waiting = undefined;
        });
    }
    rl.setPrompt(question);
    rl.prompt();
    // 管線輸入不會回顯：把答案印出來，畫面上才看得出每題回答了什麼
    const echo = (line) => {
        if (!process.stdin.isTTY)
            process.stdout.write(`${line}\n`);
        return line;
    };
    const queued = pendingLines.shift();
    if (queued !== undefined)
        return Promise.resolve(echo(queued));
    if (inputClosed)
        return Promise.reject(inputEnded());
    return new Promise((resolve, reject) => {
        waiting = { resolve: (line) => resolve(echo(line)), reject };
    });
}
const code = await runCli(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    env: process.env,
    cwd: process.cwd(),
    startNodeRelay,
    deployCloudflareRelay,
    deployCloudflareRelayViaApi,
    deployDockerRelay,
    deployFlyRelay,
    writeFile: (path, content) => writeFileSync(path, content),
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    buildRelayPackage,
    sdkVersion: sdkVersion(),
    prompt,
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
rl?.close();
// `relay start`、`iot bridge` 成功時服務還開著，不能結束程序；其他指令做完就照結束碼離開。
const longRunning = (process.argv[2] === 'relay' && process.argv[3] === 'start') || (process.argv[2] === 'iot' && process.argv[3] === 'bridge');
if (code !== 0 || !longRunning)
    process.exit(code);
//# sourceMappingURL=index.js.map