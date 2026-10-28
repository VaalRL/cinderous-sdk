import { dangerConfirmWord, DEPLOY_OPTION_SPECS, isDangerousValue, specAppliesTo } from './specs.js';
import { DEPLOY_CONFIG_VERSION, hostOfTarget } from './types.js';
import { validateDeployConfig } from './validate.js';
/** 同一題最多問幾次（不互動模式每題都回空字串，必填題不能無限重問） */
export const WIZARD_MAX_TRIES = 3;
/** 不問的欄位：格式版號與 SDK 版號由精靈寫入；目標另外先問；精靈只產生中繼的設定 */
const NOT_ASKED = new Set(['configVersion', 'sdk', 'target', 'service']);
/** 不進「進階」時只問這些題組（ADR 0050 風險 5），再加上這個目標的必填欄位 */
const BASIC_GROUPS = new Set(['basic', 'access', 'vault']);
/**
 * 只跟這一題的值有關的錯誤：當場要求重答。其他錯誤（例如「開了檔案塊卻沒有白名單」）可能由後面的題目解決，
 * 先提醒、問完再回頭重問（{@link runInitWizard}）。
 */
const FIELD_ERROR_CODES = new Set([
    'type',
    'too-long',
    'pattern',
    'enum',
    'out-of-range',
    'required',
    'secret-ref',
    'secret-literal',
    'control-chars',
    'not-https',
    'invalid',
    'invalid-pubkey',
    'invalid-name',
    'invalid-date',
    'invalid-lane',
    'invalid-private-lane',
    'invalid-read-only-lane',
    'too-many-lanes',
    'read-only-too-long',
]);
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** 回傳設好（`value` 是 undefined 就拿掉）之後的新設定；空掉的區段一併拿掉 */
function withValue(config, path, value) {
    const [head, ...rest] = path.split('.');
    const out = { ...config };
    if (rest.length === 0) {
        if (value === undefined)
            delete out[head];
        else
            out[head] = value;
        return out;
    }
    const child = withValue(isPlainObject(out[head]) ? out[head] : {}, rest.join('.'), value);
    if (Object.keys(child).length === 0)
        delete out[head];
    else
        out[head] = child;
    return out;
}
/** 這個目標要問哪些題（依描述表的順序） */
export function wizardQuestions(target, advanced = false) {
    const host = hostOfTarget(target);
    return DEPLOY_OPTION_SPECS.filter((spec) => !NOT_ASKED.has(spec.path) &&
        (spec.services === undefined || spec.services.includes('relay')) &&
        specAppliesTo(spec, target, host) &&
        // 物件型別（容量設定、贊助管道）在一行裡寫不清楚：直接改設定檔
        spec.type !== 'record' &&
        (advanced || BASIC_GROUPS.has(spec.group) || spec.requiredFor?.includes(target) === true));
}
const YES = new Set(['y', 'yes', 'true', '1', '是', '開']);
const NO = new Set(['n', 'no', 'false', '0', '否', '關']);
/**
 * 把輸入的一行轉成這個欄位的值：空字串＝不設（用預設）。這裡只處理「看得懂嗎」，範圍與格式交給 `validateDeployConfig`。
 * 秘密欄位收的是**環境變數的名稱**，不是值（ADR 0050 §4）；`string-or-secret-ref` 用 `$env:NAME` 表示環境變數。
 */
export function parseWizardAnswer(spec, raw) {
    const text = raw.trim();
    if (text === '')
        return { ok: true, value: undefined };
    switch (spec.type) {
        case 'boolean': {
            const word = text.toLowerCase();
            if (YES.has(word))
                return { ok: true, value: true };
            if (NO.has(word))
                return { ok: true, value: false };
            return { ok: false, message: { 'zh-TW': '請回答 y 或 n', en: 'Answer y or n' } };
        }
        case 'integer':
            if (!/^-?\d+$/.test(text))
                return { ok: false, message: { 'zh-TW': `要是整數，收到「${text}」`, en: `Must be an integer; got "${text}"` } };
            return { ok: true, value: Number(text) };
        case 'enum':
            if (!(spec.enum ?? []).includes(text)) {
                return { ok: false, message: { 'zh-TW': `只能是 ${(spec.enum ?? []).join('、')}`, en: `Must be one of ${(spec.enum ?? []).join(', ')}` } };
            }
            return { ok: true, value: text };
        case 'string-list':
        case 'pubkey-list':
            return { ok: true, value: text.split(/[\s,，]+/).filter((item) => item !== '') };
        case 'secret-ref':
            return { ok: true, value: { $env: text } };
        case 'string-or-secret-ref': {
            const env = /^\$env:(.*)$/.exec(text);
            return { ok: true, value: env ? { $env: env[1].trim() } : text };
        }
        default:
            return { ok: true, value: text };
    }
}
function hint(spec, zh, required) {
    const t = (a, b) => (zh ? a : b);
    const parts = [];
    if (spec.type === 'boolean')
        parts.push('y/n');
    if (spec.enum)
        parts.push(spec.enum.join('/'));
    if (spec.type === 'string-list' || spec.type === 'pubkey-list')
        parts.push(t('逗號分隔', 'comma-separated'));
    if (spec.type === 'secret-ref')
        parts.push(t('環境變數名稱', 'environment variable name'));
    if (spec.type === 'string-or-secret-ref')
        parts.push(t('值，或 $env:變數名稱', 'value, or $env:NAME'));
    if (spec.range && spec.range.max !== Number.MAX_SAFE_INTEGER)
        parts.push(`${spec.range.min}–${spec.range.max}`);
    const fallback = spec.default !== undefined ? t(`預設 ${String(spec.default)}`, `default ${String(spec.default)}`) : required ? t('必填', 'required') : t('Enter＝不設', 'Enter = leave unset');
    parts.push(fallback);
    return parts.join(zh ? '，' : ', ');
}
/**
 * 逐題問完，回傳設定與驗證結果（不寫檔）。
 * - 看不懂或只跟這一題有關的錯誤：當場重問，最多 {@link WIZARD_MAX_TRIES} 次，之後丟錯。
 * - 跨欄位的錯誤：先提醒，問完一輪再回頭重問那些題（一次）。
 * - 危險選項（描述表的 `dangerous`）：印出說明，要打 {@link dangerConfirmWord} 才開；打錯或直接 Enter＝不開。
 */
export async function runInitWizard(io, opts = {}) {
    const locale = opts.locale ?? 'zh-TW';
    const zh = locale === 'zh-TW';
    const t = (a, b) => (zh ? a : b);
    const validationOptions = opts.sdkVersion !== undefined ? { sdkVersion: opts.sdkVersion } : {};
    let config = { configVersion: DEPLOY_CONFIG_VERSION, ...(opts.sdkVersion !== undefined ? { sdk: opts.sdkVersion } : {}) };
    io.say(t('建立 cinderous.config.json：每題直接 Enter 就用預設值。秘密只問環境變數的名稱，值放 .env。', 'Creating cinderous.config.json: press Enter to keep the default. Secrets ask only for the environment variable name; the value goes in .env.'));
    const errorsAt = (candidate, path) => validateDeployConfig(candidate, validationOptions).issues.filter((issue) => issue.path === path && issue.severity === 'error');
    const ask = async (spec, target) => {
        io.say('');
        io.say(`${spec.path}：${spec.description[locale]}`);
        // 還沒選目標時只會問目標本身，它一定要選
        const required = target === undefined || spec.requiredFor?.includes(target) === true;
        for (let tries = 0; tries < WIZARD_MAX_TRIES; tries += 1) {
            const answer = parseWizardAnswer(spec, await io.ask(`${spec.path}（${hint(spec, zh, required)}）> `));
            if (!answer.ok) {
                io.say(`✖ ${answer.message[locale]}`);
                continue;
            }
            if (spec.path === 'target' && answer.value === undefined) {
                io.say(t('✖ 一定要選一個部署目標', '✖ A deployment target is required'));
                continue;
            }
            const candidate = withValue(config, spec.path, answer.value);
            const errors = errorsAt(candidate, spec.path);
            const fieldErrors = errors.filter((issue) => FIELD_ERROR_CODES.has(issue.code));
            if (fieldErrors.length > 0) {
                for (const issue of fieldErrors)
                    io.say(`✖ ${issue.message[locale]}`);
                continue;
            }
            if (target !== undefined && isDangerousValue(spec, answer.value, target)) {
                const word = dangerConfirmWord(spec);
                io.say(t(`🔴 ${spec.path} 是危險選項，開之前先讀完上面的說明。`, `🔴 ${spec.path} is a dangerous option; read the description above before you turn it on.`));
                const typed = (await io.ask(t(`要開的話輸入「${word}」（其他＝不開）> `, `Type "${word}" to turn it on (anything else = leave it off) > `))).trim();
                if (typed !== word) {
                    io.say(t(`沒有開 ${spec.path}。`, `${spec.path} left off.`));
                    config = withValue(config, spec.path, undefined);
                    return;
                }
            }
            for (const issue of errors.filter((e) => !FIELD_ERROR_CODES.has(e.code))) {
                io.say(t(`⚠ ${issue.message[locale]}（後面的題目可能會解決，問完會再檢查）`, `⚠ ${issue.message[locale]} (a later question may fix this; checked again at the end)`));
            }
            config = candidate;
            return;
        }
        throw new Error(t(`${spec.path}：試了 ${WIZARD_MAX_TRIES} 次都不合法，精靈停止`, `${spec.path}: still invalid after ${WIZARD_MAX_TRIES} tries; the wizard stopped`));
    };
    let target = opts.target;
    if (target === undefined) {
        await ask(DEPLOY_OPTION_SPECS.find((spec) => spec.path === 'target'), undefined);
        target = config.target;
    }
    else {
        config = withValue(config, 'target', target);
    }
    const questions = wizardQuestions(target, opts.advanced === true);
    for (const spec of questions)
        await ask(spec, target);
    // 跨欄位的錯誤：回頭重問那些題（一次）
    const remaining = validateDeployConfig(config, validationOptions).issues.filter((issue) => issue.severity === 'error');
    const retry = questions.filter((spec) => remaining.some((issue) => issue.path === spec.path));
    if (retry.length > 0) {
        io.say('');
        io.say(t('還有問題，回頭重問這幾題：', 'Some answers conflict; asking these again:'));
        for (const issue of remaining)
            io.say(`✖ ${issue.path}：${issue.message[locale]}`);
        for (const spec of retry)
            await ask(spec, target);
    }
    const final = validateDeployConfig(config, validationOptions);
    return { config: config, issues: final.issues };
}
//# sourceMappingURL=wizard.js.map