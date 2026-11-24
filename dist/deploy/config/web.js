// 網頁部署設定器的模型（SDK ADR 0142；ADR 0050 P3 的 (b)）：說明網站上的頁面只是這裡的薄殼。
// 題目、解析、驗證、危險選項確認都與 `cinderous init` 精靈同一份（描述表 `DEPLOY_OPTION_SPECS`＋`validateDeployConfig`），
// 產出的設定檔與部署包與 `relay build --sdk-spec github:VaalRL/cinderous-sdk#v版號` 相同。
// 🔴 純函式、不碰 Node、不發任何網路請求：瀏覽器裡跑完；秘密只收環境變數名稱（`{ "$env": … }`）。
import { DEFAULT_WORKER_NAME } from '../shared.js';
import { createStoreZip } from '../zip.js';
import { estimateResourceConsumption } from '../../estimator.js';
import { SDK_SOURCE_REPO } from './guide.js';
import { DEPLOY_CONFIG_FILE, renderDeployConfigFile, renderDeployPackage } from './package.js';
import { dangerConfirmWord, DEPLOY_OPTION_SPECS, isDangerousValue, specAppliesTo } from './specs.js';
import { DEPLOY_CONFIG_VERSION, hostOfTarget, isSecretRef } from './types.js';
import { validateDeployConfig } from './validate.js';
import { FIELD_ERROR_CODES, parseWizardAnswer, withValue, wizardQuestions } from './wizard.js';
/** 題組的顯示名稱（順序＝表單上的順序） */
export const WEB_GROUP_LABELS = Object.freeze({
    basic: { 'zh-TW': '基本', en: 'Basics' },
    access: { 'zh-TW': '誰能使用', en: 'Access' },
    vault: { 'zh-TW': 'Vault 同步與檔案', en: 'Vault sync and files' },
    nip11: { 'zh-TW': '中繼資訊（NIP-11）', en: 'Relay information (NIP-11)' },
    limits: { 'zh-TW': '上限', en: 'Limits' },
    lanes: { 'zh-TW': '車道', en: 'Lanes' },
    capacity: { 'zh-TW': '容量', en: 'Capacity' },
    turn: { 'zh-TW': 'TURN（通話）', en: 'TURN (calls)' },
    iot: { 'zh-TW': 'IoT', en: 'IoT' },
    host: { 'zh-TW': '宿主', en: 'Host' },
    secrets: { 'zh-TW': '秘密（只填環境變數名稱）', en: 'Secrets (environment variable names only)' },
    push: { 'zh-TW': '推播閘道', en: 'Push gateway' },
});
/** 不進「進階」也會顯示的題組（同精靈） */
const BASIC_GROUPS = new Set(['basic', 'access', 'vault']);
/** 欄位用什麼表單元件 */
export function webFieldKind(spec) {
    switch (spec.type) {
        case 'boolean':
            return 'checkbox';
        case 'integer':
            return 'number';
        case 'enum':
            return 'select';
        case 'string-list':
        case 'pubkey-list':
            return 'list';
        case 'secret-ref':
            return 'env-name';
        case 'string-or-secret-ref':
            return 'text-or-env';
        default:
            return 'text';
    }
}
/** 這個目標的表單：精靈的題目（`advanced` 時連進階題組），依題組分好；目標本身另外選，不在這裡 */
export function webFormGroups(target, advanced) {
    const fields = wizardQuestions(target, advanced);
    const groups = [];
    for (const group of Object.keys(WEB_GROUP_LABELS)) {
        const inGroup = fields.filter((spec) => spec.group === group);
        if (inGroup.length === 0)
            continue;
        groups.push({
            group,
            label: WEB_GROUP_LABELS[group],
            advanced: !BASIC_GROUPS.has(group),
            fields: inGroup.map((spec) => ({
                spec,
                kind: webFieldKind(spec),
                required: spec.requiredFor?.includes(target) === true,
                dangerous: spec.dangerous === true,
            })),
        });
    }
    return groups;
}
/** 表單不提供的欄位（物件型別：容量設定、贊助管道、IoT 家庭等），要直接改設定檔；頁面照實列出 */
export function webUnsupportedFields(target) {
    const host = hostOfTarget(target);
    return DEPLOY_OPTION_SPECS.filter((spec) => spec.type === 'record' && (spec.services === undefined || spec.services.includes('relay')) && specAppliesTo(spec, target, host));
}
/** 新設定的起點：格式版號、SDK 版號、目標 */
export function webInitialConfig(target, sdkVersion) {
    return { configVersion: DEPLOY_CONFIG_VERSION, sdk: sdkVersion, target };
}
/**
 * 換部署目標（SDK ADR 0142）：新目標也有的欄位照原值重新套用，新目標沒有的丟掉並回報。
 * 實測發現原本換目標就整份重來，已填的名稱、白名單全清掉。
 * 🔴 危險選項照樣要過確認：`confirmed` 沒有對的確認字就不帶過去（不能藉換目標繞過）。
 */
export function webSwitchTarget(config, target, confirmed) {
    const sdkVersion = typeof config.sdk === 'string' ? config.sdk : '';
    let next = webInitialConfig(target, sdkVersion);
    const dropped = [];
    const nextFields = new Map(wizardQuestions(target, true).map((spec) => [spec.path, spec]));
    for (const spec of DEPLOY_OPTION_SPECS) {
        // 設定檔自己的欄位（格式版號、SDK 版號、目標）由 webInitialConfig 帶，不是使用者填的
        if (spec.path in next || spec.type === 'record')
            continue;
        const text = webFieldText(config, spec);
        if (text === '')
            continue;
        const nextSpec = nextFields.get(spec.path);
        const r = nextSpec ? setWebField(next, nextSpec, text, confirmed[spec.path]) : undefined;
        if (r?.ok)
            next = r.config;
        else
            dropped.push(spec.path);
    }
    return { config: next, dropped };
}
function valueAt(config, path) {
    let node = config;
    for (const part of path.split('.')) {
        if (typeof node !== 'object' || node === null || Array.isArray(node))
            return undefined;
        node = node[part];
    }
    return node;
}
/** 欄位目前的值，轉成表單上顯示的文字（與 {@link setWebField} 收的格式相同）；沒設＝空字串 */
export function webFieldText(config, spec) {
    const value = valueAt(config, spec.path);
    if (value === undefined || value === null)
        return '';
    if (isSecretRef(value))
        return spec.type === 'string-or-secret-ref' ? `$env:${value.$env}` : value.$env;
    if (Array.isArray(value))
        return value.map(String).join(', ');
    return String(value);
}
/**
 * 改一個欄位：與精靈同一套——空字串＝不設、看不懂或只跟這一欄有關的錯誤當場擋下（不改設定）；
 * 危險選項要 `confirm` 等於 {@link dangerConfirmWord} 才開。跨欄位的錯誤不在這裡擋（由 `validateDeployConfig` 整體列出）。
 */
export function setWebField(config, spec, raw, confirm) {
    const answer = parseWizardAnswer(spec, raw);
    if (!answer.ok)
        return { ok: false, message: answer.message };
    const candidate = withValue(config, spec.path, answer.value);
    const sdkVersion = typeof config.sdk === 'string' ? config.sdk : undefined;
    const fieldErrors = validateDeployConfig(candidate, sdkVersion !== undefined ? { sdkVersion } : {}).issues.filter((issue) => issue.path === spec.path && issue.severity === 'error' && FIELD_ERROR_CODES.has(issue.code));
    if (fieldErrors.length > 0) {
        return {
            ok: false,
            message: { 'zh-TW': fieldErrors.map((i) => i.message['zh-TW']).join('；'), en: fieldErrors.map((i) => i.message.en).join('; ') },
        };
    }
    const target = typeof candidate.target === 'string' ? candidate.target : undefined;
    if (target !== undefined && isDangerousValue(spec, answer.value, target)) {
        const word = dangerConfirmWord(spec);
        if (confirm?.trim() !== word) {
            return {
                ok: false,
                confirmWord: word,
                message: {
                    'zh-TW': `${spec.path} 是危險選項：讀完說明後輸入「${word}」才會開`,
                    en: `${spec.path} is a dangerous option: read the description, then type "${word}" to turn it on`,
                },
            };
        }
    }
    return { ok: true, config: candidate };
}
/** 部署包以這個相依引用 SDK（公開 repo 的 tag；不上 npm，SDK ADR 0110） */
export function webSdkSpec(sdkVersion) {
    const repo = SDK_SOURCE_REPO.replace(/^https:\/\/github\.com\//, '');
    return `github:${repo}#v${sdkVersion}`;
}
/** 在自己電腦上產生同一份部署包的一行指令（設定檔放在目前目錄、輸出到 deploy/） */
export function webBuildCommand(sdkVersion, opts = {}) {
    const spec = webSdkSpec(sdkVersion);
    const source = opts.selfContained === true ? '--self-contained' : `--sdk-spec ${spec}`;
    return `npx --yes ${spec} relay build --config ${DEPLOY_CONFIG_FILE} --out deploy ${source}`;
}
/** 產出設定檔、部署包與 zip。設定有錯就丟例外（列出全部錯誤）——頁面只在沒有錯誤時讓人下載。 */
export function webOutputs(config, ctx) {
    const selfContained = ctx.selfContained === true;
    const pkg = renderDeployPackage(config, {
        sdkVersion: ctx.sdkVersion,
        licenseText: ctx.licenseText,
        sdkSource: { kind: 'spec', spec: webSdkSpec(ctx.sdkVersion) },
        ...(selfContained ? { selfContained: true } : {}),
        ...(ctx.relayWorkerSource !== undefined ? { relayWorkerSource: ctx.relayWorkerSource } : {}),
    });
    const name = config.name ?? DEFAULT_WORKER_NAME;
    return {
        configText: renderDeployConfigFile(config, ctx.sdkVersion),
        files: pkg.files,
        zip: createStoreZip(pkg.files.map((f) => ({ path: f.path, content: f.content })), { root: name, ...(ctx.date !== undefined ? { date: ctx.date } : {}) }),
        zipName: `${name}.zip`,
        command: webBuildCommand(ctx.sdkVersion, { selfContained }),
    };
}
/** 依部署目標試算（SDK `./estimator`，只在本機算）。輸入不合法回 `error`，不丟例外——表單一邊打一邊算。 */
export function webEstimate(target, input) {
    const tier = hostOfTarget(target) === 'worker' ? 'tier-2-serverless' : 'tier-1-selfhosted';
    try {
        const report = estimateResourceConsumption({ cryptoMode: 'cinder-ek', postQuantum: false, ...input, targetTier: tier });
        return { tier, report };
    }
    catch (error) {
        return { tier, error: error instanceof Error ? error.message : String(error) };
    }
}
//# sourceMappingURL=web.js.map