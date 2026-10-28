// 各部署目標共用、需要 Node 的部分（SDK ADR 0008、0018）：外部指令執行器、SDK 版本與位置。
// 不碰 Node 的共用部分（名稱驗證、健康檢查、預設值）在 shared.ts（SDK ADR 0021），這裡轉出以維持原本的匯出。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export {
  assertRelayName,
  checkRelayName,
  type DeployProgress,
  type DeployProgressStatus,
  type DeployStep,
  type DeploySubstep,
  type RelayDeployment,
  waitForHealthy,
} from './shared.js';

/** 執行外部指令；測試換成替身。 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
  /** 交給指令的標準輸入（秘密走這裡，不進參數；SDK ADR 0118）。沒給＝繼承終端機（首次登入要能互動）。 */
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 預設的指令執行器：輸出同時轉給終端機（首次登入要看得到提示）。 */
export const defaultRunner: CommandRunner = (cmd, args, env, input) =>
  new Promise((resolve, reject) => {
    // Windows 的 npx 是 .cmd，Node 不允許不經 shell 執行；經 shell 就要自己加引號。
    const windows = process.platform === 'win32';
    // 經 shell 時把整行組好再交出去（Node 22 起，shell 模式傳參數陣列會發棄用警告）。
    const options = { env: { ...process.env, ...env }, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'] as ['inherit' | 'pipe', 'pipe', 'pipe'] };
    const child = windows
      ? spawn([cmd, ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))].join(' '), { ...options, shell: true })
      : spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    // stdin 可能是 pipe 或 inherit，型別因此退回一般的 ChildProcess；stdout／stderr 一定是 pipe
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
  });

/** 失敗時從指令輸出取最後幾行當錯誤訊息 */
export function commandFailure(tool: string, result: { code: number; stdout: string; stderr: string }): Error {
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(-10).join('\n');
  return new Error(`${tool} 失敗（結束碼 ${result.code}）：\n${detail}`);
}

/** SDK 套件根目錄（編譯後本檔在 dist/deploy/） */
export function sdkRootDir(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

export function sdkVersion(root: string = sdkRootDir()): string {
  const pkg = JSON.parse(readFileSync(`${root.replace(/[\\/]$/, '')}/package.json`, 'utf8')) as { version: string };
  return pkg.version;
}
