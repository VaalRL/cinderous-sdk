/** 協定版本（URI 裡的版本號） */
export declare const PAIRING_VERSION = 1;
export declare const PAIRING_URI_PREFIX = "cinderous-pair:";
/** 一次性配對秘密的長度（bytes，128 位元） */
export declare const PAIRING_SECRET_BYTES = 16;
/** QR 裡最多放幾座中繼 */
export declare const PAIRING_MAX_RELAYS = 2;
/** 單座中繼網址（壓縮後）的長度上限 */
export declare const PAIRING_MAX_RELAY_CHARS = 120;
/** 預設有效期（毫秒）：5 分鐘 */
export declare const DEFAULT_PAIRING_TTL_MS: number;
/** 整串的長度上限：QR 版本 10、錯誤修正等級 M 的位元組模式容量 */
export declare const MAX_PAIRING_URI_BYTES = 213;
/** 目標 QR 規格 */
export declare const PAIRING_QR_TARGET: {
    readonly version: 10;
    readonly level: "M";
};
/**
 * - `invite`：顯示 QR 的是 Vault 裡的既有裝置，掃描的是要加入的新裝置（新手機掃桌機）。
 * - `join`：顯示 QR 的是新裝置，掃描的是既有裝置（新桌機沒有相機，由既有的手機來掃）。
 */
export type PairingRole = 'invite' | 'join';
/** QR 承載的配對資訊 */
export interface PairingInvite {
    version: number;
    role: PairingRole;
    /** 顯示方的身分公鑰（hex） */
    pubkey: string;
    /** 一次性配對秘密 */
    secret: Uint8Array;
    /** 到期時間（unix 秒，顯示方的時鐘） */
    expiresAt: number;
    /** 兩台都能連到的中繼（完整網址） */
    relays: string[];
}
/** 把中繼網址壓成 QR 用的寫法；放不進 QR 的（含逗號、空白等）回 null。 */
export declare function compactRelayUrl(url: string): string | null;
/** 把 QR 裡壓縮過的中繼寫法還原成完整網址；不合法回 null（也給 `./star` 的邀請用，SDK ADR 0030） */
export declare function expandRelayToken(token: string): string | null;
/**
 * 產生 QR 字串。中繼依序放，放到 2 座或長度到上限為止；第一座就放不下（或全都不能壓縮）時丟例外。
 */
export declare function encodePairingUri(invite: PairingInvite, opts?: {
    maxBytes?: number;
}): string;
/** 解析 QR 字串；格式不對丟 `PairingError('bad-uri')`，版本不支援丟 `PairingError('unsupported-version')`。不檢查到期。 */
export declare function parsePairingUri(uri: string): PairingInvite;
/** 這麼長的字串（位元組模式）在某個錯誤修正等級下最小要幾號 QR；超過 15 號回 null。 */
export declare function qrVersionFor(text: string, level?: 'L' | 'M' | 'Q' | 'H'): number | null;
//# sourceMappingURL=uri.d.ts.map