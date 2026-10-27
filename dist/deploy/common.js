// 各部署目標共用、需要 Node 的部分（SDK ADR 0008、0018）：外部指令執行器、SDK 版本與位置。
// 不碰 Node 的共用部分（名稱驗證、健康檢查、預設值）在 shared.ts（SDK ADR 0021），這裡轉出以維持原本的匯出。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export { assertRelayName, checkRelayName, waitForHealthy, } from './shared.js';
/** 預設的指令執行器：輸出同時轉給終端機（首次登入要看得到提示）。 */
export const defaultRunner = (cmd, args, env) => new Promise((resolve, reject) => {
    // Windows 的 npx 是 .cmd，Node 不允許不經 shell 執行；經 shell 就要自己加引號。
    const windows = process.platform === 'win32';
    // 經 shell 時把整行組好再交出去（Node 22 起，shell 模式傳參數陣列會發棄用警告）。
    const options = { env: { ...process.env, ...env }, stdio: ['inherit', 'pipe', 'pipe'] };
    const child = windows
        ? spawn([cmd, ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))].join(' '), { ...options, shell: true })
        : spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
});
/** 失敗時從指令輸出取最後幾行當錯誤訊息 */
export function commandFailure(tool, result) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-10).join('\n');
    return new Error(`${tool} 失敗（結束碼 ${result.code}）：\n${detail}`);
}
/** SDK 套件根目錄（編譯後本檔在 dist/deploy/） */
export function sdkRootDir() {
    return fileURLToPath(new URL('../..', import.meta.url));
}
export function sdkVersion(root = sdkRootDir()) {
    const pkg = JSON.parse(readFileSync(`${root.replace(/[\\/]$/, '')}/package.json`, 'utf8'));
    return pkg.version;
}
//# sourceMappingURL=common.js.map