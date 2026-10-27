import type { VaultPathScope, VaultPeerScopes, VaultScopeErrorCode } from './types.js';
/** 輕量成員按需下載的快取上限預設：200 MiB（裁示 2） */
export declare const DEFAULT_SPARSE_CACHE_BYTES: number;
/** 輕量成員的錯誤（`fetch` 失敗、本機新增被擋下；SDK ADR 0058） */
export declare class VaultScopeError extends Error {
    readonly code: VaultScopeErrorCode;
    readonly path: string;
    constructor(code: VaultScopeErrorCode, path: string, message?: string);
}
export declare function isVaultScopeError(error: unknown): error is VaultScopeError;
/**
 * 把一個範圍編成判斷函式：規則清單（陣列，或一行一條的整段文字；不合法的行略過）、`{ includes }`，或函式。
 * 規則**符合＝在範圍內**；空清單＝什麼都不在範圍內。
 */
export declare function compilePathScope(scope: VaultPathScope): (path: string) => boolean;
/** 其他輕量成員的範圍：deviceId → 判斷函式 */
export declare function compilePeerScopes(scopes: VaultPeerScopes | null | undefined): Map<string, (path: string) => boolean>;
/** `sparsePeerScopes` 需要的名單介面（`VaultMembership` 符合；這個子路徑不匯入 `./pairing`） */
export interface SparseRosterSource {
    readonly self: string;
    sparseMembers(): ReadonlyArray<{
        readonly pubkey: string;
        readonly deviceId: string;
        readonly patterns: readonly string[];
    }>;
}
/**
 * 名單上宣告為輕量成員的**其他**裝置 → 協調器的 `peerScopes`（SDK ADR 0058）：
 * `sync.setPeerScopes(sparsePeerScopes(membership))`，名單 `change` 時再呼叫一次。
 */
export declare function sparsePeerScopes(membership: SparseRosterSource): Record<string, readonly string[]>;
//# sourceMappingURL=scope.d.ts.map