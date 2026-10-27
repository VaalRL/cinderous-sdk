export { assertRelayName, checkRelayName, type DeployProgress, type DeployProgressStatus, type DeployStep, type DeploySubstep, type RelayDeployment, waitForHealthy, } from './shared.js';
/** 執行外部指令；測試換成替身。 */
export type CommandRunner = (cmd: string, args: string[], env: Record<string, string | undefined>) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
/** 預設的指令執行器：輸出同時轉給終端機（首次登入要看得到提示）。 */
export declare const defaultRunner: CommandRunner;
/** 失敗時從指令輸出取最後幾行當錯誤訊息 */
export declare function commandFailure(tool: string, result: {
    code: number;
    stdout: string;
    stderr: string;
}): Error;
/** SDK 套件根目錄（編譯後本檔在 dist/deploy/） */
export declare function sdkRootDir(): string;
export declare function sdkVersion(root?: string): string;
//# sourceMappingURL=common.d.ts.map