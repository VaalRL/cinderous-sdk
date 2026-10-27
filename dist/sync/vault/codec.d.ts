import type { VaultSyncMessage, VaultVersion } from './types.js';
/** 線上格式版本 */
export declare const VAULT_WIRE_VERSION = 1;
/** 一則 `bundle` 最多幾項（SDK ADR 0095；跟 `nodes` 的合成上限相同） */
export declare const MAX_BUNDLE_ITEMS = 200;
/** Vault 相對路徑是否安全：非空、`/` 分隔、非絕對、沒有 `.`／`..` 段、沒有控制字元與反斜線。 */
export declare function isSafeVaultPath(path: unknown): path is string;
export declare function isValidDeviceId(id: unknown): id is string;
/** 驗證一個版本；不合法回 null。 */
export declare function parseVersion(raw: unknown): VaultVersion | null;
/**
 * 訊息 → 位元組：`[4 bytes 大端序：標頭長度][標頭 UTF-8 JSON][內容原始位元組]`。
 * 內容不經 base64（中繼那一層會再 base64 一次，兩次就白白多 33%）。
 */
export declare function encodeVaultMessage(message: VaultSyncMessage): Uint8Array;
/**
 * `encodeVaultMessage(message).length`，但不複製內容（SDK ADR 0029：協調器要在送出前算出會佔幾顆檔案塊）。
 */
export declare function encodedVaultMessageLength(message: VaultSyncMessage): number;
/** 一則編碼後 `encodedLength` 位元組的訊息，經中繼要切成幾個訊框（＝每位收件人幾顆檔案塊） */
export declare function vaultFrameCount(encodedLength: number): number;
/** 位元組 → 訊息；任何欄位不合法回 null（內容雜湊不符也是）。 */
export declare function decodeVaultMessage(bytes: Uint8Array): VaultSyncMessage | null;
/**
 * 驗證一則（已經是物件的）訊息，回傳乾淨的複本；不合法回 null。
 * 協調器收到任何傳輸層交來的訊息都會再過一次（自訂的傳輸層不一定經過 `decodeVaultMessage`）。
 */
export declare function validateVaultMessage(input: unknown): VaultSyncMessage | null;
/** 摘要的 `seen` 最多幾台（SDK ADR 0074；協調器只放最近的這麼多台） */
export declare const MAX_SEEN = 256;
//# sourceMappingURL=codec.d.ts.map