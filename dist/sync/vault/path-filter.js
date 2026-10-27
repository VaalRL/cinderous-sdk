// 同步排除範圍（SDK ADR 0047）：gitignore 風格的路徑規則，平台無關、零 Node、純函式。
//
// 兩層：固定排除（應用提供、使用者不能移除）＋使用者排除清單（有預設值）。CinderSync 與 Cinder Coffice 共用這一份，
// 設定頁的即時驗證（`validatePattern`）、預覽（`explain`）、協調器（`excludes`／`setExcludes`）都看同一套語意。
//
// 語法（gitignore 的子集，差異見 ADR 0047 §語法）：
// - 一行一條；空行與 `#` 開頭的行略過；前後空白去掉。
// - `*` 不跨 `/`；`?` 一個字元（不含 `/`）；`[abc]`、`[a-z]`、`[!a]`／`[^a]` 字元集合；`\` 跳脫下一個字元。
// - `**/x`：任何深度；`x/**`：x 底下的全部；`a/**/b`：中間零到多層。其他位置的 `**` 等同 `*`。
// - 結尾 `/`：只比對資料夾（資料夾被排除，底下全部排除）。
// - 開頭或中間有 `/`：從 Vault 根目錄算起；否則比對任何一層的名稱。
// - `!` 開頭：反向（重新納入）。最後一條符合的規則決定；**上層資料夾被排除時，底下的檔案無法再被 `!` 納入**（同 git）。
// - 比對前路徑做 NFC 正規化；預設不分大小寫（與協調器預設的 `pathKey` 一致）。
/**
 * 使用者排除清單的預設值：各平台自動產生、從來不是使用者內容的檔案。
 * 每一條的來源見 ADR 0047 §預設清單；刻意不放 `*~`、`*.part`、`*.bak` 這類可能是使用者自己留的檔案。
 */
export const DEFAULT_USER_EXCLUDES = Object.freeze([
    '.DS_Store', // macOS Finder
    '._*', // macOS 在非 HFS 磁碟上的 AppleDouble 資源分支
    'Thumbs.db', // Windows 縮圖快取
    'ehthumbs.db', // Windows Media Center 縮圖快取
    'desktop.ini', // Windows 資料夾設定
    '~$*', // Microsoft Office 開啟中的鎖定檔（~$報告.docx）
    '.~lock.*#', // LibreOffice 開啟中的鎖定檔
    '*.tmp', // 各種程式的暫存檔
    '*.swp', // Vim 交換檔
    '*.swo', // Vim 交換檔（第二個）
    '*.crdownload', // Chrome 下載中
]);
/** 單一規則的長度上限（字元） */
export const MAX_PATH_PATTERN_LENGTH = 512;
const SPECIAL = new Set(['*', '?', '[', ']', '\\', '!', '#', ' ']);
const MESSAGES = {
    'too-long': `規則太長（上限 ${MAX_PATH_PATTERN_LENGTH} 個字元）`,
    'control-char': '規則不能含控制字元',
    backslash: '路徑請用 / 分隔（反斜線 \\ 只用來跳脫 * ? [ ] ! # 等特殊字元）',
    absolute: '請用 Vault 內的相對路徑（開頭的 / 代表 Vault 根目錄，不要寫磁碟代號）',
    'dot-segment': '不能用 . 或 .. 當路徑的一段',
    'empty-segment': '路徑中間不能有連續的 /',
    'unclosed-bracket': '字元集合的 [ 沒有對應的 ]',
    'invalid-class': '字元集合的範圍不正確（例如 [z-a]）',
    empty: '規則是空的（只有 ! 或 /）',
};
function problem(code, kind) {
    return { ok: false, kind, error: { code, message: MESSAGES[code] } };
}
/** 一行規則：去掉前後空白；空行、註解回 null（kind 另外判斷） */
function clean(line) {
    return line.replace(/\r$/, '').trim();
}
/** 解析並驗證一條（已 clean、非空、非註解）規則。不合法回錯誤碼。 */
function parse(text) {
    if (text.length > MAX_PATH_PATTERN_LENGTH)
        return 'too-long';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text))
        return 'control-char';
    let s = text;
    let negate = false;
    if (s.startsWith('!')) {
        negate = true;
        s = s.slice(1);
    }
    // 反斜線只能跳脫特殊字元；其他用法多半是 Windows 路徑分隔
    for (let i = 0; i < s.length; i += 1) {
        if (s[i] !== '\\')
            continue;
        const next = s[i + 1];
        if (next === undefined || !SPECIAL.has(next))
            return 'backslash';
        i += 1;
    }
    if (/^[A-Za-z]:/.test(s))
        return 'absolute';
    let dirOnly = false;
    if (s.endsWith('/')) {
        dirOnly = true;
        s = s.slice(0, -1);
    }
    const anchoredByLead = s.startsWith('/');
    if (anchoredByLead)
        s = s.slice(1);
    if (s.length === 0)
        return 'empty';
    const segments = s.split('/');
    if (segments.some((seg) => seg.length === 0))
        return 'empty-segment';
    if (segments.some((seg) => seg === '.' || seg === '..'))
        return 'dot-segment';
    // 字元集合要成對
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (c === '\\') {
            i += 1;
            continue;
        }
        if (c !== '[')
            continue;
        const end = classEnd(s, i);
        if (end < 0)
            return 'unclosed-bracket';
        i = end;
    }
    const parsed = { negate, dirOnly, anchored: anchoredByLead || segments.length > 1, body: s };
    try {
        toRegExp(parsed);
    }
    catch {
        return 'invalid-class';
    }
    return parsed;
}
/** `[` 在 i，回傳對應 `]` 的位置；沒有回 -1。`[]a]`、`[!]a]` 裡第一個 `]` 是字元本身（同 glob）。 */
function classEnd(s, i) {
    let j = i + 1;
    if (s[j] === '!' || s[j] === '^')
        j += 1;
    if (s[j] === ']')
        j += 1;
    for (; j < s.length; j += 1) {
        if (s[j] === '\\') {
            j += 1;
            continue;
        }
        if (s[j] === ']')
            return j;
    }
    return -1;
}
// `u` 旗標下只能跳脫語法字元；`-` 只在字元集合裡跳脫
const escapeRe = (c) => (/[\^$\\.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c);
const escapeClass = (c) => (c === '-' ? '\\-' : escapeRe(c));
/** 規則本體 → 正規表示式（比對整個候選路徑） */
function toRegExp(p, flags = 'u') {
    const s = p.body;
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (c === '\\') {
            out += escapeRe(s[i + 1]);
            i += 1;
        }
        else if (c === '*') {
            if (s[i + 1] === '*') {
                const atStart = i === 0;
                const prevSlash = i > 0 && s[i - 1] === '/';
                const after = s[i + 2];
                if ((atStart || prevSlash) && after === '/') {
                    // `**/`：零到多層資料夾
                    out += '(?:.*/)?';
                    i += 2;
                    continue;
                }
                if (prevSlash && after === undefined) {
                    // `/**`：底下的全部（不含資料夾本身）
                    out += '.+';
                    i += 1;
                    continue;
                }
                // 其他位置的 `**` 等同 `*`
                while (s[i + 1] === '*')
                    i += 1;
            }
            out += '[^/]*';
        }
        else if (c === '?') {
            out += '[^/]';
        }
        else if (c === '[') {
            const end = classEnd(s, i);
            let j = i + 1;
            let negated = false;
            if (s[j] === '!' || s[j] === '^') {
                negated = true;
                j += 1;
            }
            let cls = '';
            for (; j < end; j += 1) {
                const d = s[j];
                if (d === '\\') {
                    cls += escapeClass(s[j + 1]);
                    j += 1;
                }
                else if (d === '-' && cls.length > 0 && j + 1 < end)
                    cls += '-';
                else
                    cls += escapeClass(d);
            }
            out += negated ? `[^/${cls}]` : `(?!/)[${cls}]`;
            i = end;
        }
        else {
            out += escapeRe(c);
        }
    }
    return new RegExp(`^${p.anchored ? '' : '(?:.*/)?'}${out}$`, flags);
}
function prepare(text, caseInsensitive) {
    const s = text.normalize('NFC');
    return caseInsensitive ? s.toLowerCase() : s;
}
/**
 * 驗證一條規則（設定頁每打一個字就呼叫）。空行、註解也算合法（`kind` 告訴你是哪一種）。
 *
 * ```ts
 * validatePattern('*.tmp');      // { ok: true, kind: 'rule' }
 * validatePattern('a\\b');       // { ok: false, kind: 'rule', error: { code: 'backslash', message: '路徑請用 / 分隔…' } }
 * validatePattern('*');          // { ok: true, kind: 'rule', warning: { code: 'matches-everything', … } }
 * ```
 */
export function validatePattern(pattern) {
    const text = clean(pattern);
    if (text.length === 0)
        return { ok: true, kind: 'blank' };
    if (text.startsWith('#'))
        return { ok: true, kind: 'comment' };
    const kind = text.startsWith('!') ? 'negation' : 'rule';
    const parsed = parse(text);
    if (typeof parsed === 'string')
        return problem(parsed, kind);
    const result = { ok: true, kind };
    if (!parsed.negate && /^(?:\*+|\*\*\/\*+)$/.test(parsed.body)) {
        result.warning = { code: 'matches-everything', message: '這條規則會排除整個 Vault 的所有檔案' };
    }
    return result;
}
function toLines(patterns) {
    return typeof patterns === 'string' ? patterns.split('\n') : [...patterns];
}
/**
 * 編譯規則清單（陣列，或設定頁文字框的整段文字，一行一條）。
 *
 * ```ts
 * const f = compilePathFilter(['*.tmp', 'Archive/', '!Archive/keep.md']);
 * f.isExcluded('notes/a.tmp');        // true
 * f.isExcluded('archive/2024/x.md');  // true（不分大小寫）
 * f.explain('notes/a.tmp');           // { excluded: true, pattern: '*.tmp' }
 * ```
 */
export function compilePathFilter(patterns, options = {}) {
    const caseInsensitive = options.caseInsensitive ?? true;
    const rules = [];
    for (const line of toLines(patterns)) {
        const text = clean(line);
        if (text.length === 0 || text.startsWith('#'))
            continue;
        const parsed = parse(text);
        if (typeof parsed === 'string') {
            if (options.invalid === 'skip')
                continue;
            throw new RangeError(`同步排除規則「${text}」不合法：${MESSAGES[parsed]}`);
        }
        // 不分大小寫：規則與路徑都轉小寫比對（與 `defaultPathKey` 一致）。小寫化讓字元範圍顛倒時（`[Z-a]`）改用原規則加 i 旗標
        const prepared = caseInsensitive ? parse(prepare(text, true)) : parsed;
        const re = typeof prepared === 'string' ? toRegExp(parsed, 'iu') : toRegExp(prepared);
        rules.push({ source: text, negate: parsed.negate, dirOnly: parsed.dirOnly, re });
    }
    const hasNegation = rules.some((r) => r.negate);
    /** 對一個候選（資料夾或檔案本身）找最後一條符合的規則 */
    const decide = (candidate, isDir) => {
        for (let i = rules.length - 1; i >= 0; i -= 1) {
            const rule = rules[i];
            if (rule.dirOnly && !isDir)
                continue;
            if (rule.re.test(candidate))
                return rule;
        }
        return undefined;
    };
    const explain = (raw) => {
        if (rules.length === 0)
            return { excluded: false };
        const path = prepare(raw, caseInsensitive).replace(/^\/+/, '');
        const segments = path.split('/');
        let candidate = '';
        for (let i = 0; i < segments.length; i += 1) {
            candidate = i === 0 ? segments[0] : `${candidate}/${segments[i]}`;
            const isDir = i < segments.length - 1;
            const rule = decide(candidate, isDir);
            if (isDir) {
                // 上層資料夾被排除：底下全部排除，`!` 也救不回來（同 git）
                if (rule && !rule.negate)
                    return { excluded: true, pattern: rule.source, via: candidate };
                continue;
            }
            if (!rule)
                return { excluded: false };
            return rule.negate ? { excluded: false, pattern: rule.source } : { excluded: true, pattern: rule.source };
        }
        return { excluded: false };
    };
    const isExcluded = (raw) => {
        if (rules.length === 0)
            return false;
        if (hasNegation)
            return explain(raw).excluded;
        // 沒有反向規則：任何一層符合就是排除
        const path = prepare(raw, caseInsensitive).replace(/^\/+/, '');
        const segments = path.split('/');
        let candidate = '';
        for (let i = 0; i < segments.length; i += 1) {
            candidate = i === 0 ? segments[0] : `${candidate}/${segments[i]}`;
            if (decide(candidate, i < segments.length - 1))
                return true;
        }
        return false;
    };
    return Object.freeze({ patterns: Object.freeze(rules.map((r) => r.source)), caseInsensitive, isExcluded, explain });
}
/** 把一個確切的路徑變成「只比對它」的規則（從 Vault 根目錄算起、特殊字元跳脫）：固定排除 `vault.configDir` 用 */
export function literalPathPattern(path, options = {}) {
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    let out = '/';
    for (const c of trimmed)
        out += SPECIAL.has(c) ? `\\${c}` : c;
    return options.dirOnly ? `${out}/` : out;
}
/** 任何一個濾網排除就排除（OR）。`null`／`undefined` 略過。 */
export function combinePathFilters(...filters) {
    const list = filters.filter((f) => f !== null && f !== undefined).map(asPathFilter);
    return { isExcluded: (path) => list.some((f) => f.isExcluded(path)) };
}
/** 函式或濾網 → 濾網 */
export function asPathFilter(filter) {
    return typeof filter === 'function' ? { isExcluded: filter } : filter;
}
/**
 * 兩層排除：固定排除 OR 使用者清單。直接傳給協調器的 `excludes`／`setExcludes`。
 *
 * ```ts
 * const excludes = compileSyncExcludes({
 *   fixed: [literalPathPattern(app.vault.configDir, { dirOnly: true }), '.*'],
 *   user: settings.excludes ?? DEFAULT_USER_EXCLUDES,
 * });
 * await sync.setExcludes(excludes);
 * ```
 */
export function compileSyncExcludes(options = {}) {
    const ci = options.caseInsensitive === undefined ? {} : { caseInsensitive: options.caseInsensitive };
    const fixed = compilePathFilter(options.fixed ?? [], { ...ci, invalid: 'throw' });
    const user = compilePathFilter(options.user ?? DEFAULT_USER_EXCLUDES, { ...ci, invalid: options.invalid ?? 'skip' });
    return Object.freeze({
        fixed,
        user,
        isExcluded: (path) => fixed.isExcluded(path) || user.isExcluded(path),
        explain: (path) => {
            const f = fixed.explain(path);
            if (f.excluded)
                return { ...f, layer: 'fixed' };
            const u = user.explain(path);
            return u.excluded ? { ...u, layer: 'user' } : u;
        },
    });
}
//# sourceMappingURL=path-filter.js.map