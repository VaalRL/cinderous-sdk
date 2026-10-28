import type { BuildRelayPackageOptions, RelayPackageBuild } from '../deploy/build.js';
import type { CloudflareDeployment, CloudflareDeployOptions } from '../deploy/cloudflare.js';
import type { CloudflareApiDeployment, CloudflareApiDeployOptions } from '../deploy/cloudflare-api/deploy.js';
import type { RelayDeployment } from '../deploy/common.js';
import type { DockerDeployOptions } from '../deploy/docker.js';
import type { FlyDeployOptions } from '../deploy/fly.js';
import { type ConsumptionSimulationInput } from '../estimator.js';
import { type IotAcl, type IotAclEntryInput } from '../iot/acl.js';
import { type ResolvedIotBridgeConfig, type ResolvedIotClientConfig } from '../iot/bridge/config.js';
import type { IotCommandResult } from '../iot/client.js';
import type { IotGatewayLogEntry } from '../iot/gateway.js';
import type { NodeRelayEnv, NodeRelayOptions } from '../relay/node-relay.js';
export interface CliDeps {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    env: NodeRelayEnv;
    cwd: string;
    startNodeRelay: (env: NodeRelayEnv, options?: NodeRelayOptions) => {
        close(): void;
    };
    deployCloudflareRelay: (options: CloudflareDeployOptions) => Promise<CloudflareDeployment>;
    /** `cloudflare-api` 目標的 `relay deploy --config`：REST 一鍵部署（SDK ADR 0118）；沒有＝這個環境不支援 */
    deployCloudflareRelayViaApi?: (options: CloudflareApiDeployOptions) => Promise<CloudflareApiDeployment>;
    deployDockerRelay: (options: DockerDeployOptions) => Promise<RelayDeployment>;
    deployFlyRelay: (options: FlyDeployOptions) => Promise<RelayDeployment>;
    writeFile: (path: string, content: string) => void;
    /** 讀文字檔；不存在回 undefined（`--config`、`.env`；SDK ADR 0050） */
    readFile?: (path: string) => string | undefined;
    /** `relay build`：把部署包寫到磁碟（SDK ADR 0050） */
    buildRelayPackage?: (options: BuildRelayPackageOptions) => Promise<RelayPackageBuild>;
    /** 執行中的 SDK 版號：與設定檔的 `sdk` 比對（ADR 0050 §6） */
    sdkVersion?: string;
    /** `init` 精靈：問一題、回傳輸入的一行（SDK ADR 0117）；沒有＝這個環境不能互動，只能用 --yes */
    prompt?: (question: string) => Promise<string>;
    /** `iot bridge`：啟動家中橋接器（SDK ADR 0049） */
    startIotBridge?: (config: ResolvedIotBridgeConfig, extra: {
        aclPath: string;
        pushPath?: string;
        onLog?: (entry: IotGatewayLogEntry) => void;
        onError?: (error: unknown) => void;
    }) => Promise<{
        gatewayNpub: string;
        homeTag: string;
        close(): Promise<void>;
    }>;
    /** `iot acl`：以成員（owner）身分連上 relay */
    connectIotClient?: (config: ResolvedIotClientConfig) => Promise<{
        client: IotAclClient;
        close(): void;
    }>;
    /** `iot build`：寫出橋接器的 Docker 建置內容，回傳寫了哪些檔 */
    prepareIotBridgeContext?: (opts: {
        workDir: string;
        configPath?: string;
    }) => string[];
}
/** `iot acl` 用到的 `IotClient` 子集 */
export interface IotAclClient {
    updateAcl(op: {
        op: 'add';
        entry: IotAclEntryInput;
    } | {
        op: 'remove';
        pubkey: string;
    }): Promise<IotCommandResult>;
    getAcl(): Promise<IotAcl | undefined>;
}
export declare const USAGE = "\u7528\u6CD5\uFF1Acinderous <\u6307\u4EE4> [\u9078\u9805]\n\n  cinderous relay start    \u5728\u9019\u53F0\u6A5F\u5668\u8D77\u4E00\u5EA7\u4E2D\u7E7C\uFF08\u9810\u8A2D\u7D14\u8A18\u61B6\u9AD4\uFF09\n      --port, -p <\u57E0>             \u9810\u8A2D 8787\uFF08\u6216\u74B0\u5883\u8B8A\u6578 PORT\uFF09\n      --host <\u4F4D\u5740>               \u53EA\u807D\u9019\u500B\u4F4D\u5740\uFF08\u4F8B\u5982 127.0.0.1\uFF0C\u53CD\u5411\u4EE3\u7406\u5728\u540C\u4E00\u53F0\u6642\uFF1B\u6216\u74B0\u5883\u8B8A\u6578 HOST\uFF09\uFF1B\u9810\u8A2D\u6240\u6709\u4F4D\u5740\n      --persist                   \u6539\u7528 SQLite \u4FDD\u5B58\u96E2\u7DDA\u7559\u8A00\uFF0C\u91CD\u555F\u4E0D\u6703\u6E05\u7A7A\n      --db-path <\u8DEF\u5F91>            \u642D\u914D --persist\uFF0C\u9810\u8A2D cinderous-relay.db\n      --allowed-pubkeys, -k <\u540D\u55AE> \u53EA\u8B93\u9019\u4E9B\u4EBA\u5BEB\u5165\uFF08\u9017\u865F\u5206\u9694\u7684 npub \u6216 hex\uFF09\n      --no-auth                   \u4E0D\u8981\u6C42 NIP-42 \u767B\u5165\n      --name <\u7AD9\u540D>               NIP-11 \u986F\u793A\u7684\u7AD9\u540D\n      --max-file-mb <MB>          \u63A5\u53D7\u6A94\u6848\u584A\uFF08kind 1060\uFF1B\u5168\u7AD9\u958B\u95DC\uFF09\uFF1BVault \u540C\u6B65\u5FC5\u9808\u958B\uFF0C\u5EFA\u8B70 17\uFF08\u9700\u8981\u767D\u540D\u55AE\uFF09\n      --open-file-relay           \u6C92\u6709\u767D\u540D\u55AE\u4E5F\u63A5\u53D7\u6A94\u6848\u584A\uFF08\u4E0D\u5EFA\u8B70\uFF09\n\n  cinderous relay deploy   \u90E8\u7F72\u4E00\u5EA7\u4E2D\u7E7C\n      --config, -c <\u6A94>           \u6539\u7528\u8A2D\u5B9A\u6A94\uFF08cinderous.config.json\uFF0CSDK ADR 0050\uFF09\uFF1B\u53EA\u80FD\u518D\u52A0 --output-env\u3001--dry-run\n      --provider, -p <\u5EE0\u5546>       cloudflare\uFF08\u9810\u8A2D\uFF09\u3001docker\uFF08\u9019\u53F0\u6A5F\u5668\uFF09\u3001fly\uFF08Fly.io\uFF09\n      --name, -n <\u540D\u7A31>           Worker\uFF0F\u5BB9\u5668\uFF0FFly app \u540D\u7A31\uFF0C\u9810\u8A2D cinderous-relay\n      --allowed-pubkeys, -k <\u540D\u55AE> \u767D\u540D\u55AE\uFF1B\u6C92\u7D66\uFF1D\u958B\u653E\u4E2D\u7E7C\n      --api-token, -t <token>     cloudflare \u9810\u8A2D\u8B80 CLOUDFLARE_API_TOKEN\u3001fly \u9810\u8A2D\u8B80 FLY_API_TOKEN\n      --account-id, -a <id>       cloudflare\uFF1A\u9810\u8A2D\u8B80 CLOUDFLARE_ACCOUNT_ID\n      --compatibility-date <\u65E5\u671F>  cloudflare\uFF1A\u9810\u8A2D 2026-09-01\n      --region, -r <\u5340\u57DF>          fly\uFF1A\u9810\u8A2D nrt\uFF08\u6771\u4EAC\uFF09\n      --port <\u57E0>                 docker\uFF1A\u5C0D\u5916\u7684\u57E0\uFF0C\u9810\u8A2D 8080\n      --persist                   docker\uFF0Ffly\uFF1A\u4EE5 SQLite \u4FDD\u5B58\u96E2\u7DDA\u7559\u8A00\uFF08\u639B volume\uFF09\n      --max-file-mb <MB>          \u63A5\u53D7\u6A94\u6848\u584A\uFF08kind 1060\uFF1B\u5168\u7AD9\u958B\u95DC\uFF09\uFF1BVault \u540C\u6B65\u5FC5\u9808\u958B\uFF0C\u5EFA\u8B70 17\uFF08\u9700\u8981\u767D\u540D\u55AE\uFF09\n      --open-file-relay           \u6C92\u6709\u767D\u540D\u55AE\u4E5F\u63A5\u53D7\u6A94\u6848\u584A\uFF08\u4E0D\u5EFA\u8B70\uFF1A\u5132\u5B58\u6C92\u6709\u4E0A\u9650\uFF09\n      --relay-name <\u7AD9\u540D>          NIP-11 \u7AD9\u540D\uFF08\u6700\u9577 100 \u5B57\uFF09\n      --relay-description <\u6587\u5B57>   NIP-11 \u63CF\u8FF0\uFF08\u6700\u9577 500 \u5B57\uFF09\n      --relay-contact <\u806F\u7D61\u65B9\u5F0F>   NIP-11 \u806F\u7D61\u65B9\u5F0F\uFF08\u6700\u9577 200 \u5B57\uFF09\n      --relay-software-url <\u7DB2\u5740>  NIP-11 software\uFF08https\uFF09\uFF1A\u6539\u904E\u4E2D\u7E7C\u7A0B\u5F0F\u6642\u6307\u5411\u4FEE\u6539\u5F8C\u7684\u539F\u59CB\u78BC\uFF08AGPL \u00A713\uFF09\n      --max-ttl-days <\u5929>          \u96E2\u7DDA\u7559\u8A00\u4FDD\u5B58\u4E0A\u9650\uFF0C1\u2013365\uFF0C\u9810\u8A2D 7\n      --max-connections-per-pubkey <n>      \u540C\u4E00\u628A\u516C\u9470\u6700\u591A\u5E7E\u689D\u9023\u7DDA\uFF0C1\u2013100\uFF0C\u9810\u8A2D 5\n      --max-messages-per-second-per-ip <n>  \u540C\u4E00\u500B IP \u6BCF\u79D2\u6700\u591A\u5E7E\u5247\uFF0C1\u20131000\uFF0C\u9810\u8A2D 20\n      --app-lanes <\u540D\u55AE>           cloudflare\uFF1A\u5DF2\u77E5\u79DF\u6236\u8ECA\u9053\uFF08\u9017\u865F\u5206\u9694\uFF0C\u4F8B\u5982 dochost\uFF09\uFF1B\u6539\u540D\u55AE\uFF1D\u63DB DO\n      --file-lanes <\u540D\u55AE>          cloudflare\uFF1A\u53EA\u5728\u9019\u4E9B\u8ECA\u9053\u6536\u6A94\u6848\u584A\uFF08\u9808\u5728 --app-lanes \u4E0A\uFF0C\u4E26\u7D66 --max-file-mb\uFF09\n      --app-lane-pow <\u96E3\u5EA6>        cloudflare\uFF1A\u8ECA\u9053\u7684 PoW \u6700\u4F4E\u96E3\u5EA6\uFF0C0\u201332\uFF0C\u9810\u8A2D 0\n      --developer-docs-url <\u7DB2\u5740>  cloudflare\uFF1A\u9023\u7DDA\u88AB\u62D2\u6642\u9644\u4E0A\u7684\u958B\u767C\u6587\u4EF6\u7DB2\u5740\uFF08https\uFF09\n      --output-env, -o <\u6A94\u6848>      \u7AEF\u9EDE\u5BEB\u5230\u9019\u500B\u6A94\uFF0C\u9810\u8A2D .env.cinderous\n      --dry-run                   \u53EA\u7522\u751F\u8A2D\u5B9A\uFF08cloudflare \u53E6\u5916\u8A66\u6253\u5305\uFF09\uFF0C\u4E0D\u90E8\u7F72\n      --non-interactive, -y       \u4E0D\u8A62\u554F\uFF08\u76EE\u524D\u672C\u4F86\u5C31\u4E0D\u8A62\u554F\uFF0C\u4FDD\u7559\u7D66\u8173\u672C\u7528\uFF09\n\n  cinderous relay build    \u4F9D\u8A2D\u5B9A\u6A94\u7522\u751F\u53EF\u651C\u7684\u90E8\u7F72\u5305\u8207\u90E8\u7F72\u8AAA\u660E\uFF08SDK ADR 0050\uFF09\n      --config, -c <\u6A94>           \u9810\u8A2D cinderous.config.json\n      --out, -o <\u76EE\u9304>            \u9810\u8A2D\u8A2D\u5B9A\u6A94\u6240\u5728\u7684\u8CC7\u6599\u593E\n      --self-contained            Workers\uFF1A\u9644\u9810\u6253\u5305\u7684\u4E2D\u7E7C\uFF08src/relay.mjs\uFF09\uFF0C\u4E0D\u9700\u8981\u5B89\u88DD SDK\n      --sdk-spec <\u76F8\u4F9D>           SDK \u6539\u4EE5\u5957\u4EF6\u76F8\u4F9D\u5B89\u88DD\uFF08\u4F8B\u5982 github:VaalRL/cinderous-sdk#v0.80.0\uFF09\uFF0C\u4E0D\u5167\u5D4C sdk/\n      --force                     \u8986\u5BEB\u88AB\u624B\u6539\u904E\u3001\u6216\u4E0D\u662F relay build \u7522\u751F\u7684\u6A94\u6848\n\n  cinderous init           \u9010\u984C\u7522\u751F\u8A2D\u5B9A\u6A94 cinderous.config.json\uFF08SDK ADR 0117\uFF09\uFF1B\u5371\u96AA\u9078\u9805\u8981\u6253\u5B57\u78BA\u8A8D\u624D\u6703\u958B\n      --out, -o <\u6A94>              \u9810\u8A2D cinderous.config.json\n      --provider, -p <\u76EE\u6A19>       cloudflare\u3001cloudflare-api\u3001docker\u3001fly\u3001home-tunnel\uFF1B\u6C92\u7D66\u5C31\u554F\n      --advanced                  \u4E5F\u554F\u9032\u968E\u984C\u7D44\uFF08NIP-11\u3001\u4E0A\u9650\u3001\u8ECA\u9053\u3001\u5BB9\u91CF\u3001\u5BBF\u4E3B\u3001\u79D8\u5BC6\uFF09\n      --yes, -y                   \u4E0D\u8A62\u554F\u3001\u5168\u90E8\u7528\u9810\u8A2D\u503C\uFF08\u8981\u642D\u914D --provider\uFF1B\u5371\u96AA\u9078\u9805\u4E00\u5F8B\u4E0D\u958B\uFF09\n      --force                     \u8986\u5BEB\u5DF2\u7D93\u5B58\u5728\u7684\u8A2D\u5B9A\u6A94\n      --locale <zh-TW|en>         \u984C\u76EE\u8207\u8AAA\u660E\u7684\u8A9E\u8A00\uFF0C\u9810\u8A2D zh-TW\n\n  cinderous iot bridge     \u5BB6\u4E2D IoT \u6A4B\u63A5\u5668\uFF1A\u672C\u5730 MQTT broker \u2194 relay\uFF0C\u7AEF\u5230\u7AEF\u52A0\u5BC6\uFF08SDK ADR 0049\uFF1B\u9700\u8981 npm install mqtt\uFF09\n      --config, -c <\u6A94>           \u9810\u8A2D iot-bridge.json\uFF08\u79D8\u5BC6\u53EA\u5BEB { \"$env\": \"NAME\" }\uFF1B\u8A2D\u5B9A\u6A94\u65C1\u908A\u7684 .env \u6703\u88AB\u8B80\uFF09\n      --acl-file <\u6A94>             \u89D2\u8272\u540D\u55AE\u5B58\u6A94\uFF08\u8986\u5BEB\u8A2D\u5B9A\u6A94\u7684 aclFile\uFF09\n      --push-file <\u6A94>            \u63A8\u64AD\u7AEF\u9EDE\u5B58\u6A94\uFF08\u8A2D\u5B9A\u6A94\u6709 push \u6BB5\u6642\uFF1B\u8986\u5BEB push.storeFile\uFF09\n  cinderous iot acl list|add|remove   \u4EE5 owner \u8EAB\u5206\u7BA1\u7406\u9598\u9053\u7684\u89D2\u8272\u540D\u55AE\uFF08\u7D93 $sys/acl\uFF09\n      --config, -c <\u6A94>           \u9810\u8A2D iot-client.json\uFF08relays\u3001gateway\u3001homeSecret\u3001memberKey\uFF09\n      add <npub> --role <viewer|operator|owner> [--devices a,b*] [--topics home/+/light/#] [--expires-at <Unix \u79D2>] [--label <\u540D\u7A31>]\n      remove <npub>\n  cinderous iot keygen     \u7522\u751F\u65B0\u7684\u5BB6\u5EAD\u79D8\u5BC6\u8207\u9598\u9053\u79C1\u9470\uFF08\u53EA\u5370\u9019\u4E00\u6B21\uFF1B\u653E\u9032 .env\uFF09\n  cinderous iot push-keygen  \u7522\u751F\u63A8\u64AD\u9598\u9053\u7684\u79C1\u9470 PUSH_GATEWAY_KEY\uFF08\u53EA\u5370\u9019\u4E00\u6B21\uFF09\u8207\u516C\u9470\uFF08App \u7528\u5B83\u5C01 token\uFF1BADR 0049 \u00A711.1\uFF09\n  cinderous iot build      \u5BEB\u51FA\u6A4B\u63A5\u5668\u7684 Docker \u5EFA\u7F6E\u5167\u5BB9\uFF08Dockerfile\u3001compose.yaml\u3001.env.example\u3001sdk/\uFF09\n      --out, -o <\u76EE\u9304>            \u9810\u8A2D iot-bridge\n      --config, -c <\u6A94>           \u4E00\u4F75\u8907\u88FD\u9019\u4EFD iot-bridge.json\n\n  cinderous config validate [\u6A94]  \u9A57\u8B49\u8A2D\u5B9A\u6A94\uFF0C\u4E00\u6B21\u5217\u51FA\u6240\u6709\u554F\u984C\uFF08\u9810\u8A2D cinderous.config.json\uFF09\n  cinderous config schema          \u5370\u51FA\u8A2D\u5B9A\u6A94\u7684 JSON Schema\n  cinderous config migrate [\u6A94]   \u628A\u820A\u7248 SDK \u7522\u751F\u7684\u8A2D\u5B9A\u6A94\u5E36\u5230\u9019\u4E00\u7248\uFF08sdk \u6B04\u4F4D\u3001\u683C\u5F0F\uFF09\uFF0C\u5217\u51FA\u4E2D\u9593\u5F71\u97FF\u90E8\u7F72\u7684\u8B8A\u66F4\n      --dry-run                   \u53EA\u5370\u51FA\u7D50\u679C\uFF0C\u4E0D\u5BEB\u6A94\n\n  cinderous estimate       \u8A66\u7B97\u8CC7\u6E90\u6D88\u8017\u8207\u71DF\u904B\u6210\u672C\n      --mode <cinder-ek|double-ratchet>  \u9810\u8A2D cinder-ek\n      --pq[=true|false]           \u5F8C\u91CF\u5B50\u6DF7\u5408\u52A0\u5BC6\uFF0C\u9810\u8A2D\u95DC\n      --devices <n>               \u6BCF\u4EBA\u88DD\u7F6E\u6578\uFF0C\u9810\u8A2D 3\n      --collaborators <n>         \u7FA4\u7D44\u4EBA\u6578\uFF0C\u9810\u8A2D 1\n      --daily-actions <n>         \u6BCF\u4EBA\u6BCF\u65E5\u52D5\u4F5C\u6578\uFF0C\u9810\u8A2D 300\n      --payload-kb <n>            \u6BCF\u6B21\u52D5\u4F5C\u7684\u8CC7\u6599\u91CF\uFF08KB\uFF09\uFF0C\u9810\u8A2D 15\n      --p2p-rate <0~1>            P2P \u6253\u6D1E\u6210\u529F\u7387\uFF0C\u9810\u8A2D 0.85\n      --tier <tier-0-public|tier-1-selfhosted|tier-2-serverless>\n      --json                      \u8F38\u51FA JSON";
/** `cinderous estimate` 的旗標 → 試算器輸入。壞值直接報錯，不默默換成預設。 */
export declare function parseEstimateArgs(argv: string[]): ConsumptionSimulationInput & {
    json: boolean;
};
/**
 * `cinderous relay start` 的旗標 → Node 主機的環境變數與選項。
 * 以既有環境變數為底：Docker 用 `-e` 設的值照樣生效，旗標只覆寫有給的那幾個。
 */
export declare function parseRelayStartArgs(argv: string[], baseEnv: NodeRelayEnv): {
    env: NodeRelayEnv;
    options: NodeRelayOptions;
};
/** 很小的 `.env` 解析：`KEY=VALUE`、`#` 註解、去掉成對的引號。只讀、不寫（秘密不經過 CLI 的輸出）。 */
export declare function parseDotEnv(text: string): Record<string, string>;
/** 執行一次命令列；回傳結束碼（0 成功、1 執行失敗、2 用法錯誤）。 */
export declare function runCli(argv: string[], deps: CliDeps): Promise<number>;
//# sourceMappingURL=commands.d.ts.map