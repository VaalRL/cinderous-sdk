// 推播閘道的部署包（SDK ADR 0050 §5；ADR 0049 §11.1 裁示 5、7）：`service: 'push-gateway'` 時由 `renderDeployPackage` 呼叫。
// 純函式、不碰 Node、不引用 `./iot`（部署設定器不帶進 IoT 程式；綁定名稱與上限由測試比對 `./iot/push-gateway` 的常數）。
//
// - Workers 目標：`wrangler.toml`（DO `PUSH_STATE`＝`PushGatewayState`，SQLite 型；iOS 可直連 APNs，SDK ADR 0061）、`src/entry.mjs`、`package.json`、`.dev.vars.example`；
// - Node 目標（docker、fly、home-tunnel）：`Dockerfile`、`server.mjs`（`startNodePushGateway`）、`package.json`、compose／fly.toml。
// - 秘密（`PUSH_GATEWAY_KEY`、`FCM_SERVICE_ACCOUNT`、`APNS_KEY`）**只**以名稱出現：Workers 用 `wrangler secret put`，容器用 `.env`。
import { CONTAINER_PORT, DEFAULT_DOCKER_PORT, DEFAULT_FLY_REGION, renderCompose, renderDockerignore, renderFlyToml } from '../render.js';
import { DEFAULT_COMPATIBILITY_DATE, DEFAULT_WORKER_NAME } from '../shared.js';
import { DEFAULT_PUSH_GATEWAY_IOS, PUSH_GATEWAY_LIMIT_SPECS } from './specs.js';
import { hostOfTarget, isSecretRef } from './types.js';
/** Workers 版的 DO 綁定與遷移（＝ `@cinderous/client/iot/push-gateway/worker` 的 `PUSH_STATE_BINDING`／`PUSH_STATE_MIGRATIONS`） */
export const PUSH_GATEWAY_DO = { name: 'PUSH_STATE', className: 'PushGatewayState', migrationTag: 'push-v1' };
/** 推播閘道在執行期讀的秘密（固定名稱；設定檔的 `secrets.*` 只改「部署端從哪個環境變數取值」） */
export const PUSH_GATEWAY_RUNTIME_SECRETS = {
    pushGatewayKey: 'PUSH_GATEWAY_KEY',
    fcmServiceAccount: 'FCM_SERVICE_ACCOUNT',
    apnsKey: 'APNS_KEY',
};
/** 這份設定需要哪些執行期秘密 */
export function pushGatewaySecrets(config) {
    const push = config.pushGateway ?? {};
    const ios = push.ios ?? DEFAULT_PUSH_GATEWAY_IOS;
    const out = ['pushGatewayKey'];
    if (push.android !== false || ios === 'fcm')
        out.push('fcmServiceAccount');
    if (ios === 'apns')
        out.push('apnsKey');
    return out;
}
/** 部署端放這個秘密的環境變數名稱（設定檔 `$env`，沒有就用執行期的名稱） */
export function pushSecretEnvName(config, key) {
    const ref = config.secrets?.[key];
    return ref && isSecretRef(ref) ? ref.$env : PUSH_GATEWAY_RUNTIME_SECRETS[key];
}
/** 推播閘道的一般變數（非秘密）：上限與平台選項（Workers 的 `[vars]`、容器的環境變數） */
export function pushGatewayVars(config) {
    const push = config.pushGateway ?? {};
    const ios = push.ios ?? DEFAULT_PUSH_GATEWAY_IOS;
    const vars = {
        PUSH_ANDROID: push.android === false ? '0' : '1',
        PUSH_IOS: ios,
        PUSH_IOS_LOC_KEY: push.iosLocKey ?? 'CINDER_WAKE',
        PUSH_TOKEN_PER_HOUR: String(push.tokenPerHour ?? PUSH_GATEWAY_LIMIT_SPECS.tokenPerHour.default),
        PUSH_TOKEN_PER_MINUTE: String(push.tokenPerMinute ?? PUSH_GATEWAY_LIMIT_SPECS.tokenPerMinute.default),
        PUSH_MAX_SKEW_SEC: String(push.maxSkewSec ?? PUSH_GATEWAY_LIMIT_SPECS.maxSkewSec.default),
        PUSH_MAX_REGISTRATION_DAYS: String(push.maxRegistrationDays ?? PUSH_GATEWAY_LIMIT_SPECS.maxRegistrationDays.default),
    };
    if (ios === 'apns') {
        // 直連 APNs 的非秘密設定（Workers 版與 Node 版都要；SDK ADR 0061）
        vars.APNS_TOPIC = push.apnsTopic ?? '';
        vars.APNS_KEY_ID = push.apnsKeyId ?? '';
        vars.APNS_TEAM_ID = push.apnsTeamId ?? '';
        vars.APNS_ENV = push.apnsEnvironment ?? 'production';
    }
    return vars;
}
const toml = (value) => JSON.stringify(value);
function wranglerToml(config, header) {
    const account = config.cloudflare?.accountId;
    const lines = [
        ...header,
        `name = ${toml(config.name ?? DEFAULT_WORKER_NAME)}`,
        'main = "src/entry.mjs"',
        `compatibility_date = ${toml(config.cloudflare?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE)}`,
        ...(typeof account === 'string' ? [`account_id = ${toml(account)}`] : []),
        '',
        '# 每個推播 token 一顆 Durable Object：防重放、撤銷、每 token 上限（SDK ADR 0049 §11.1）',
        '[[durable_objects.bindings]]',
        `name = "${PUSH_GATEWAY_DO.name}"`,
        `class_name = "${PUSH_GATEWAY_DO.className}"`,
        '',
        '[[migrations]]',
        `tag = "${PUSH_GATEWAY_DO.migrationTag}"`,
        `new_sqlite_classes = ["${PUSH_GATEWAY_DO.className}"]`,
        '',
        '[observability]',
        'enabled = true',
        '',
        `# 秘密（${pushGatewaySecrets(config).map((k) => PUSH_GATEWAY_RUNTIME_SECRETS[k]).join('、')}）不在這裡：以 \`npx wrangler@4 secret put\` 設定（見 README-DEPLOY.md）`,
        '[vars]',
        ...Object.entries(pushGatewayVars(config)).map(([k, v]) => `${k} = ${toml(v)}`),
    ];
    return `${lines.join('\n')}\n`;
}
function workerEntry(header) {
    return [...header, "export { default, PushGatewayState } from '@cinderous/client/iot/push-gateway/worker';", ''].join('\n');
}
function devVars(config, header) {
    return [
        ...header,
        '#',
        '# `wrangler dev` 的本機秘密範本（複製成 .dev.vars，不要提交）。正式環境用 `npx wrangler@4 secret put <名稱>`。',
        '# Local secrets for `wrangler dev` (copy to .dev.vars, never commit). In production use `npx wrangler@4 secret put <NAME>`.',
        '',
        ...pushGatewaySecrets(config).map((key) => `${PUSH_GATEWAY_RUNTIME_SECRETS[key]}=`),
        '',
    ].join('\n');
}
function dockerfile(sdkVersion, embedSdk, header) {
    return [
        ...header,
        'FROM node:22-slim',
        'WORKDIR /app',
        'COPY package.json ./',
        ...(embedSdk ? ['COPY sdk ./sdk'] : []),
        'RUN npm install --omit=dev --no-audit --no-fund',
        'COPY server.mjs ./',
        `ENV NODE_ENV=production PORT=${CONTAINER_PORT} CINDEROUS_SDK_VERSION=${sdkVersion}`,
        `EXPOSE ${CONTAINER_PORT}`,
        '# 秘密（PUSH_GATEWAY_KEY、FCM_SERVICE_ACCOUNT、APNS_KEY）只從環境變數讀，不寫進映像、不寫檔',
        'USER node',
        'CMD ["node", "server.mjs"]',
        '',
    ].join('\n');
}
function serverEntry(header) {
    return [
        ...header,
        "import { startNodePushGateway } from '@cinderous/client/iot/push-gateway/node';",
        '',
        '// 設定錯誤在這裡就丟出（訊息只有變數名稱，不含值）',
        'const gateway = await startNodePushGateway(process.env);',
        'console.log(`push gateway listening on :${process.env.PORT ?? 8080}; pubkey ${gateway.pubkey}`);',
        'const stop = () => void gateway.close().finally(() => process.exit(0));',
        "process.once('SIGTERM', stop);",
        "process.once('SIGINT', stop);",
        '',
    ].join('\n');
}
/** 容器的環境：一般變數＋從 `.env` 代入的秘密（沒設就在啟動前報錯） */
function composeEnvironment(config) {
    const env = { ...pushGatewayVars(config) };
    for (const key of pushGatewaySecrets(config)) {
        const local = pushSecretEnvName(config, key);
        env[PUSH_GATEWAY_RUNTIME_SECRETS[key]] = `\${${local}:?請在 .env 設定 ${local}}`;
    }
    return env;
}
/** 推播閘道的目標專屬檔案（共同檔案——設定檔、說明、LICENSE、SOURCE.md、清單——由 `renderDeployPackage` 補上） */
export function renderPushGatewayFiles(config, ctx) {
    const files = [];
    const add = (path, content) => files.push({ path, content });
    const name = config.name ?? DEFAULT_WORKER_NAME;
    if (hostOfTarget(config.target) === 'worker') {
        add('wrangler.toml', wranglerToml(config, ctx.header('#')));
        add('src/entry.mjs', workerEntry(ctx.header('//')));
        add('package.json', ctx.packageJson(true));
        add('.dev.vars.example', devVars(config, ctx.header('#')));
        return files;
    }
    add('Dockerfile', dockerfile(ctx.sdkVersion, ctx.embedSdk, ctx.header('#')));
    add('server.mjs', serverEntry(ctx.header('//')));
    add('package.json', ctx.packageJson(false));
    add('.dockerignore', [...ctx.header('#'), renderDockerignore()].join('\n'));
    if (config.target === 'fly') {
        add('fly.toml', renderFlyToml({ name, region: config.fly?.region ?? DEFAULT_FLY_REGION, environment: pushGatewayVars(config), persist: false, header: ctx.header('#') }));
    }
    else {
        add('docker-compose.yml', renderCompose({
            name,
            port: config.node?.port ?? DEFAULT_DOCKER_PORT,
            environment: composeEnvironment(config),
            header: ctx.header('#'),
            ...(config.target === 'home-tunnel'
                ? {
                    tunnel: {
                        tokenEnv: config.secrets?.tunnelToken?.$env ?? 'TUNNEL_TOKEN',
                        ...(config.tunnel?.cloudflaredImage !== undefined ? { image: config.tunnel.cloudflaredImage } : {}),
                    },
                }
                : {}),
        }));
    }
    return files;
}
/** 推播閘道的 `.env.example`：部署憑證＋執行期秘密，值留空 */
export function renderPushGatewayEnvLines(config) {
    const notes = {
        pushGatewayKey: '推播閘道私鑰（npx cinderous iot push-keygen）／push gateway private key',
        fcmServiceAccount: "Firebase 服務帳號 JSON，整份一行並以單引號包住／Firebase service account JSON on one line, wrapped in single quotes",
        apnsKey: 'APNs .p8 金鑰內容，換行寫成 \\n／APNs .p8 key contents with newlines written as \\n',
    };
    const lines = [];
    for (const key of pushGatewaySecrets(config))
        lines.push(`# ${notes[key]}`, `${pushSecretEnvName(config, key)}=`, '');
    return lines;
}
//# sourceMappingURL=push-package.js.map