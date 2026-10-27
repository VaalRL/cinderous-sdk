import { type DeployConfig } from './types.js';
/** Workers 版的 DO 綁定與遷移（＝ `@cinderous/client/iot/push-gateway/worker` 的 `PUSH_STATE_BINDING`／`PUSH_STATE_MIGRATIONS`） */
export declare const PUSH_GATEWAY_DO: {
    readonly name: "PUSH_STATE";
    readonly className: "PushGatewayState";
    readonly migrationTag: "push-v1";
};
/** 推播閘道在執行期讀的秘密（固定名稱；設定檔的 `secrets.*` 只改「部署端從哪個環境變數取值」） */
export declare const PUSH_GATEWAY_RUNTIME_SECRETS: Readonly<Record<'pushGatewayKey' | 'fcmServiceAccount' | 'apnsKey', string>>;
/** 這份設定需要哪些執行期秘密 */
export declare function pushGatewaySecrets(config: DeployConfig): ('pushGatewayKey' | 'fcmServiceAccount' | 'apnsKey')[];
/** 部署端放這個秘密的環境變數名稱（設定檔 `$env`，沒有就用執行期的名稱） */
export declare function pushSecretEnvName(config: DeployConfig, key: keyof typeof PUSH_GATEWAY_RUNTIME_SECRETS): string;
/** 推播閘道的一般變數（非秘密）：上限與平台選項（Workers 的 `[vars]`、容器的環境變數） */
export declare function pushGatewayVars(config: DeployConfig): Record<string, string>;
export interface PushGatewayPackageFile {
    path: string;
    content: string;
}
/** 推播閘道的目標專屬檔案（共同檔案——設定檔、說明、LICENSE、SOURCE.md、清單——由 `renderDeployPackage` 補上） */
export declare function renderPushGatewayFiles(config: DeployConfig, ctx: {
    sdkVersion: string;
    embedSdk: boolean;
    dependency: string | undefined;
    header: (prefix: string) => string[];
    packageJson: (worker: boolean) => string;
}): PushGatewayPackageFile[];
/** 推播閘道的 `.env.example`：部署憑證＋執行期秘密，值留空 */
export declare function renderPushGatewayEnvLines(config: DeployConfig): string[];
//# sourceMappingURL=push-package.d.ts.map