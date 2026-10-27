// 秘密的處理（SDK ADR 0050 §4）：設定檔與部署包**不含任何秘密值**，只寫 `{ "$env": "NAME" }`。
// 這裡負責兩件事：部署時把引用解析成值，以及找出「看起來像秘密、卻直接寫在設定檔裡」的字串。
import { readOnlyLanesFrom } from '../../relay/host-config.js';
import { IssueList, PRIVATE_LANE_MIN_LENGTH } from '../shared.js';
import { isSecretRef } from './types.js';
/** 環境變數名稱的形狀（POSIX 慣例；compose 的 `${NAME}` 代入也吃這個形狀） */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 從環境讀出秘密；沒有引用時讀 `defaultEnv`。都沒有回 undefined（由呼叫端決定要不要交給工具自己的登入）。 */
export function resolveSecret(ref, env, defaultEnv) {
    const name = ref?.$env ?? defaultEnv;
    if (name === undefined)
        return undefined;
    const value = env[name];
    return value === undefined || value === '' ? undefined : value;
}
/** 字串或引用（例如 Account ID）：字串原樣、引用從環境讀。 */
export function resolveStringOrSecret(value, env, defaultEnv) {
    if (typeof value === 'string')
        return value;
    return resolveSecret(value, env, defaultEnv);
}
/**
 * 私人路徑（SDK ADR 0051）的佔位值：驗證設定檔與產生部署包時用它代替真正的值（部署包不含秘密）。
 * 一個合法的車道 id，產生器會把用到它的變數改寫成從環境讀。
 */
export const PRIVATE_LANE_PLACEHOLDER = 'p'.repeat(PRIVATE_LANE_MIN_LENGTH);
/** 唯讀寬限期（SDK ADR 0052）的佔位車道 id：與私人路徑的佔位值不同（同一條不能又可寫又唯讀） */
export const READ_ONLY_LANE_PLACEHOLDER = 'r'.repeat(PRIVATE_LANE_MIN_LENGTH);
/** 設定檔的 `site` → 站台參數，秘密換成佔位值（驗證規則與部署路徑相同、但不需要真的值）。 */
export function siteWithPlaceholders(site) {
    const { privateLane, readOnlyLanes, ...rest } = site ?? {};
    return {
        ...rest,
        ...(isSecretRef(privateLane) ? { privateLane: PRIVATE_LANE_PLACEHOLDER } : {}),
        // 佔位的到期時間：一天後（驗證只看形狀；部署包會把用到它的變數改寫成從環境讀）
        ...(isSecretRef(readOnlyLanes)
            ? { readOnlyLanes: [{ id: READ_ONLY_LANE_PLACEHOLDER, expiresAt: Math.floor(Date.now() / 1000) + 86_400 }] }
            : {}),
    };
}
/**
 * 設定檔的 `site` → 站台參數，秘密從環境讀出（`relay deploy --config`）。私人路徑引用了卻沒有值就丟例外（訊息只有變數名稱、沒有值）；
 * 唯讀寬限期沒有值＝沒有唯讀車道，有值但格式不對就丟例外（訊息只有第幾項，不含車道 id）。
 */
export function resolveSiteSecrets(site, env) {
    const { privateLane, readOnlyLanes, ...rest } = site ?? {};
    const out = { ...rest };
    if (isSecretRef(privateLane)) {
        const value = resolveSecret(privateLane, env)?.trim();
        if (value === undefined || value === '') {
            throw new Error(`site.privateLane 引用的環境變數 ${privateLane.$env} 沒有值：把私人路徑（至少 ${PRIVATE_LANE_MIN_LENGTH} 字的隨機車道 id）放進 .env 或環境變數`);
        }
        out.privateLane = value;
    }
    if (isSecretRef(readOnlyLanes)) {
        const raw = resolveSecret(readOnlyLanes, env)?.trim();
        if (raw !== undefined && raw !== '') {
            const parsed = readOnlyLanesFrom(raw);
            if (parsed.ignored.length > 0) {
                throw new Error(`site.readOnlyLanes 引用的環境變數 ${readOnlyLanes.$env} 格式不對（${parsed.ignored.join('；')}）：應為 <舊車道 id>@<到期 unix 秒>，逗號分隔`);
            }
            out.readOnlyLanes = [...parsed.lanes].map(([id, expiresAt]) => ({ id, expiresAt }));
        }
    }
    return out;
}
/**
 * 一定是秘密的形狀（直接拒絕）：Nostr 私鑰、Fly Token、cloudflared 的 Tunnel Token（base64 的 JSON）、PEM 私鑰。
 * 這些在設定檔的任何欄位都不該出現。
 */
const CERTAIN_SECRETS = [
    { pattern: /^nsec1[02-9ac-hj-np-z]{20,}$/, zh: 'Nostr 私鑰（nsec）', en: 'a Nostr private key (nsec)' },
    { pattern: /^FlyV1\s/, zh: 'Fly API Token', en: 'a Fly API token' },
    { pattern: /^f[mo][12]_[A-Za-z0-9_+/=-]{20,}/, zh: 'Fly API Token', en: 'a Fly API token' },
    { pattern: /^eyJ[A-Za-z0-9_-]{40,}={0,2}$/, zh: 'Cloudflare Tunnel Token（base64 的 JSON）', en: 'a Cloudflare Tunnel token (base64 JSON)' },
    { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, zh: 'PEM 私鑰', en: 'a PEM private key' },
];
/**
 * 疑似 Token（只警告）：≥ 32 字、沒有空白、不是網址、不是純 hex（公鑰、Account ID 是 hex）、不是 npub，
 * 而且同時有大寫、小寫與數字——Cloudflare API Token 就是這個形狀。
 */
function looksLikeToken(text) {
    if (text.length < 32 || /\s/.test(text))
        return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(text))
        return false; // https:、mailto:、lnurl: 之類
    if (/^[0-9a-fA-F]+$/.test(text))
        return false;
    if (/^npub1/.test(text))
        return false;
    return /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);
}
/**
 * 掃描設定檔裡所有的字串（`$env` 引用除外），找出直接寫進去的秘密（SDK ADR 0050 §4）。
 * 確定是秘密的 → `error`（build 拒絕）；疑似 Token → `warning`（build 照做但提醒）。
 */
export function findSecretLiterals(config) {
    const issues = new IssueList();
    const walk = (value, path) => {
        if (typeof value === 'string') {
            const certain = CERTAIN_SECRETS.find((s) => s.pattern.test(value.trim()));
            if (certain) {
                issues.error(path, 'secret-literal', `${path} 看起來是${certain.zh}：秘密不能寫進設定檔（會被提交、被分享）。請改成 { "$env": "變數名稱" }，值放在 .env 或環境變數`, `${path} looks like ${certain.en}: secrets must not be written into the config (it gets committed and shared). Use { "$env": "NAME" } and keep the value in .env or the environment`);
            }
            else if (looksLikeToken(value.trim())) {
                issues.warn(path, 'secret-like', `${path} 看起來像 Token：如果它是秘密，請改成 { "$env": "變數名稱" }`, `${path} looks like a token: if it is a secret, use { "$env": "NAME" } instead`);
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${path}[${index}]`));
            return;
        }
        if (typeof value === 'object' && value !== null) {
            if (isSecretRef(value))
                return;
            for (const [key, child] of Object.entries(value))
                walk(child, path === '' ? key : `${path}.${key}`);
        }
    };
    walk(config, '');
    return issues.issues;
}
//# sourceMappingURL=secrets.js.map