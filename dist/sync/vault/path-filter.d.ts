/** 判斷一個 Vault 相對路徑（以 `/` 分隔）是否不同步 */
export interface PathFilter {
    isExcluded(path: string): boolean;
}
export interface PathFilterOptions {
    /** 不分大小寫；預設 true（Windows、macOS 的檔案系統大小寫不分，與協調器預設的 `pathKey` 一致） */
    caseInsensitive?: boolean;
    /** 遇到不合法的規則：`'throw'`（預設）丟 `RangeError`；`'skip'` 略過那一行（例如舊設定在新版變成不合法） */
    invalid?: 'throw' | 'skip';
}
/** `explain()` 的結果：被哪一條規則決定（設定頁顯示「被 `*.tmp` 排除」用） */
export interface PathFilterMatch {
    excluded: boolean;
    /** 決定結果的那一條規則（原文）；沒有任何規則符合時省略 */
    pattern?: string;
    /** 那一條規則是被排除的上層資料夾比對到的（例如 `build/` 排除了 `build/a/b.js`） */
    via?: string;
}
export interface CompiledPathFilter extends PathFilter {
    /** 實際生效的規則（去掉空行、註解、`skip` 掉的不合法規則） */
    readonly patterns: readonly string[];
    readonly caseInsensitive: boolean;
    explain(path: string): PathFilterMatch;
}
export type PathPatternErrorCode = 'too-long' | 'control-char' | 'backslash' | 'absolute' | 'dot-segment' | 'empty-segment' | 'unclosed-bracket' | 'invalid-class' | 'empty';
export interface PathPatternCheck {
    ok: boolean;
    /** `rule`：排除規則；`negation`：`!` 反向；`comment`、`blank`：不影響結果 */
    kind: 'rule' | 'negation' | 'comment' | 'blank';
    error?: {
        code: PathPatternErrorCode;
        message: string;
    };
    /** 合法但多半不是想要的（例如 `*` 會排除整個 Vault） */
    warning?: {
        code: 'matches-everything';
        message: string;
    };
}
/**
 * 使用者排除清單的預設值：各平台自動產生、從來不是使用者內容的檔案。
 * 每一條的來源見 ADR 0047 §預設清單；刻意不放 `*~`、`*.part`、`*.bak` 這類可能是使用者自己留的檔案。
 */
export declare const DEFAULT_USER_EXCLUDES: readonly string[];
/** 單一規則的長度上限（字元） */
export declare const MAX_PATH_PATTERN_LENGTH = 512;
/**
 * 驗證一條規則（設定頁每打一個字就呼叫）。空行、註解也算合法（`kind` 告訴你是哪一種）。
 *
 * ```ts
 * validatePattern('*.tmp');      // { ok: true, kind: 'rule' }
 * validatePattern('a\\b');       // { ok: false, kind: 'rule', error: { code: 'backslash', message: '路徑請用 / 分隔…' } }
 * validatePattern('*');          // { ok: true, kind: 'rule', warning: { code: 'matches-everything', … } }
 * ```
 */
export declare function validatePattern(pattern: string): PathPatternCheck;
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
export declare function compilePathFilter(patterns: readonly string[] | string, options?: PathFilterOptions): CompiledPathFilter;
/** 把一個確切的路徑變成「只比對它」的規則（從 Vault 根目錄算起、特殊字元跳脫）：固定排除 `vault.configDir` 用 */
export declare function literalPathPattern(path: string, options?: {
    dirOnly?: boolean;
}): string;
/** 任何一個濾網排除就排除（OR）。`null`／`undefined` 略過。 */
export declare function combinePathFilters(...filters: Array<PathFilter | ((path: string) => boolean) | null | undefined>): PathFilter;
/** 函式或濾網 → 濾網 */
export declare function asPathFilter(filter: PathFilter | ((path: string) => boolean)): PathFilter;
export interface SyncExcludesOptions extends Pick<PathFilterOptions, 'caseInsensitive'> {
    /** 固定排除（應用提供，使用者不能移除；使用者的 `!` 也不能把它們重新納入） */
    fixed?: readonly string[] | string;
    /** 使用者排除清單；省略＝`DEFAULT_USER_EXCLUDES`。使用者存下的設定請照原樣傳入（含空清單） */
    user?: readonly string[] | string;
    /** 使用者清單裡不合法的規則：預設 `'skip'`（設定檔不該讓同步起不來）；固定排除一律 `'throw'` */
    invalid?: 'throw' | 'skip';
}
export interface SyncExcludes extends PathFilter {
    readonly fixed: CompiledPathFilter;
    readonly user: CompiledPathFilter;
    /** 哪一層、哪一條規則排除了這個路徑（設定頁預覽用） */
    explain(path: string): PathFilterMatch & {
        layer?: 'fixed' | 'user';
    };
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
export declare function compileSyncExcludes(options?: SyncExcludesOptions): SyncExcludes;
//# sourceMappingURL=path-filter.d.ts.map