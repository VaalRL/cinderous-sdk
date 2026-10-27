// 輕量成員的路徑範圍（SDK ADR 0058）：內容範圍、允許新增的範圍、其他輕量成員宣告的範圍，一律編成 `(path) => boolean`。
//
// 規則語法沿用排除清單（SDK ADR 0047，gitignore 的子集、NFC、預設不分大小寫），只是意思相反：**符合＝在範圍內**。
import { compilePathFilter } from './path-filter.js';
/** 輕量成員按需下載的快取上限預設：200 MiB（裁示 2） */
export const DEFAULT_SPARSE_CACHE_BYTES = 200 * 1024 * 1024;
/** 輕量成員的錯誤（`fetch` 失敗、本機新增被擋下；SDK ADR 0058） */
export class VaultScopeError extends Error {
    code;
    path;
    constructor(code, path, message) {
        super(message ?? scopeErrorMessage(code, path));
        this.name = 'VaultScopeError';
        this.code = code;
        this.path = path;
    }
}
function scopeErrorMessage(code, path) {
    switch (code) {
        case 'base-missing':
            return `${path} 的內容不在這台：要先 fetch 才能修改（不產生版本）`;
        case 'create-outside':
            return `${path} 不在允許新增的範圍：這個檔案不會同步`;
        case 'deleted':
            return `${path} 已經被刪除`;
        case 'excluded':
            return `${path} 在同步排除範圍內`;
        case 'unknown':
            return `不認得 ${path}`;
        case 'timeout':
            return `${path} 還沒下載完（仍在背景進行）`;
        case 'stopped':
            return '同步已停止';
    }
}
export function isVaultScopeError(error) {
    return error instanceof VaultScopeError;
}
/**
 * 把一個範圍編成判斷函式：規則清單（陣列，或一行一條的整段文字；不合法的行略過）、`{ includes }`，或函式。
 * 規則**符合＝在範圍內**；空清單＝什麼都不在範圍內。
 */
export function compilePathScope(scope) {
    if (typeof scope === 'function')
        return scope;
    if (typeof scope === 'string' || Array.isArray(scope)) {
        const filter = compilePathFilter(scope, { invalid: 'skip' });
        return (path) => filter.isExcluded(path);
    }
    const object = scope;
    return (path) => object.includes(path);
}
/** 其他輕量成員的範圍：deviceId → 判斷函式 */
export function compilePeerScopes(scopes) {
    const out = new Map();
    for (const [device, scope] of Object.entries(scopes ?? {}))
        out.set(device, compilePathScope(scope));
    return out;
}
/**
 * 名單上宣告為輕量成員的**其他**裝置 → 協調器的 `peerScopes`（SDK ADR 0058）：
 * `sync.setPeerScopes(sparsePeerScopes(membership))`，名單 `change` 時再呼叫一次。
 */
export function sparsePeerScopes(membership) {
    const out = {};
    for (const m of membership.sparseMembers())
        if (m.pubkey !== membership.self)
            out[m.deviceId] = [...m.patterns];
    return out;
}
//# sourceMappingURL=scope.js.map