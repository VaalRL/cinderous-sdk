import type { NostrEvent } from "../protocol/event.js";
import type { PubkeyHex } from "../protocol/keys.js";
import type { Rumor } from "../protocol/nip59.js";
import type { SecretKeyOrSigner } from "../protocol/signer.js";
/** 檔案塊的外層 kind（ADR-0162；與 Cinderous `KIND.FILE_WRAP` 相同，由 Cinderous 的測試釘住）。 */
export declare const FILE_WRAP_KIND = 1060;
/** 檔案塊的內層 rumor kind（與 Cinderous `KIND.FILE_CHUNK` 相同）。 */
export declare const FILE_CHUNK_KIND = 43;
/** 單塊位元組上限（明文）；base64 後約 64KB，仍在 NIP-44 單則上限內。 */
export declare const FILE_CHUNK_BYTES = 48000;
/**
 * 經中繼的單檔**絕對**上限：64 MiB（收端防 DoS；SDK ADR 0029）。
 *
 * 中繼（例如 Cinderous ADR-0371 的檔案車道）在 NIP-11 以 `cinder_max_file_mb` 宣告自己的單檔上限，
 * 送端依它決定多大的檔案走中繼；收端不知道送端用的是哪一座、宣告多少，所以一律只擋這個絕對上限。
 * 中繼宣告得再大，客戶端也夾在這裡。
 */
export declare const RELAY_FILE_MAX_BYTES_CAP: number;
/**
 * 單檔塊數上限（收端防禦）：{@link RELAY_FILE_MAX_BYTES_CAP} ÷ {@link FILE_CHUNK_BYTES}＝1,399 塊。
 * v0.24 以前是 360 塊（≈16.5 MB）；30 MB 的檔案要 656 塊（SDK ADR 0029）。
 */
export declare const FILE_CHUNK_MAX_TOTAL: number;
/** 檔案分塊（解密後）。 */
export interface FileChunk {
    tid: string;
    /** 0-based 塊序。 */
    seq: number;
    total: number;
    name: string;
    mime: string;
    data: Uint8Array;
}
/** 把檔案位元組切塊（最後一塊可短）。 */
export declare function splitFileChunks(bytes: Uint8Array): Uint8Array[];
/** 包一塊：rumor kind FILE_CHUNK，外層 kind FILE_WRAP（帶 #p 與過期章）。 */
export declare function wrapFileChunk(chunk: FileChunk, 
/** 寄件人的原始私鑰，或不交出私鑰的 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
senderSk: SecretKeyOrSigner, recipientPk: PubkeyHex, opts?: {
    now?: number;
    expiration?: number;
}): NostrEvent;
/** 解析檔案分塊 rumor；kind 不符、欄位非法、超過防禦上限一律回 null。 */
export declare function parseFileChunk(rumor: Rumor): FileChunk | null;
//# sourceMappingURL=file-relay.d.ts.map