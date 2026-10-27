// 組織檔案經 relay 暫存（ADR-0162）：位元組加密分塊成 FILE_WRAP(1060) 事件走離線信箱。
//
// 中繼只見密文；獨立外層 kind 讓站方能整類拒收（企業限定的執行點）與獨立配額桶。
// 每塊明文 ≤ FILE_CHUNK_BYTES（NIP-44 單則 64KB 上限之內留餘裕）；塊自帶 name/mime，
// 重組不依賴 metadata 訊息的到達順序。

import type { NostrEvent } from "../protocol/event.js";
import type { PubkeyHex } from "../protocol/keys.js";
import type { Rumor } from "../protocol/nip59.js";
import { sealAndWrap } from "../protocol/nip59.js";
import type { SecretKeyOrSigner } from "../protocol/signer.js";

/** 檔案塊的外層 kind（ADR-0162；與 Cinderous `KIND.FILE_WRAP` 相同，由 Cinderous 的測試釘住）。 */
export const FILE_WRAP_KIND = 1060;
/** 檔案塊的內層 rumor kind（與 Cinderous `KIND.FILE_CHUNK` 相同）。 */
export const FILE_CHUNK_KIND = 43;
const KIND = { FILE_WRAP: FILE_WRAP_KIND, FILE_CHUNK: FILE_CHUNK_KIND } as const;

const DAY_SECONDS = 86_400;
const DEFAULT_TTL_SECONDS = 7 * DAY_SECONDS;

/** 單塊位元組上限（明文）；base64 後約 64KB，仍在 NIP-44 單則上限內。 */
export const FILE_CHUNK_BYTES = 48_000;
/**
 * 經中繼的單檔**絕對**上限：64 MiB（收端防 DoS；SDK ADR 0029）。
 *
 * 中繼（例如 Cinderous ADR-0371 的檔案車道）在 NIP-11 以 `cinder_max_file_mb` 宣告自己的單檔上限，
 * 送端依它決定多大的檔案走中繼；收端不知道送端用的是哪一座、宣告多少，所以一律只擋這個絕對上限。
 * 中繼宣告得再大，客戶端也夾在這裡。
 */
export const RELAY_FILE_MAX_BYTES_CAP = 64 * 1024 * 1024;
/**
 * 單檔塊數上限（收端防禦）：{@link RELAY_FILE_MAX_BYTES_CAP} ÷ {@link FILE_CHUNK_BYTES}＝1,399 塊。
 * v0.24 以前是 360 塊（≈16.5 MB）；30 MB 的檔案要 656 塊（SDK ADR 0029）。
 */
export const FILE_CHUNK_MAX_TOTAL = Math.ceil(RELAY_FILE_MAX_BYTES_CAP / FILE_CHUNK_BYTES);

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

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 把檔案位元組切塊（最後一塊可短）。 */
export function splitFileChunks(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += FILE_CHUNK_BYTES) {
    out.push(bytes.subarray(off, Math.min(off + FILE_CHUNK_BYTES, bytes.length)));
  }
  return out.length > 0 ? out : [new Uint8Array(0)];
}

/** 包一塊：rumor kind FILE_CHUNK，外層 kind FILE_WRAP（帶 #p 與過期章）。 */
export function wrapFileChunk(
  chunk: FileChunk,
  /** 寄件人的原始私鑰，或不交出私鑰的 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
  senderSk: SecretKeyOrSigner,
  recipientPk: PubkeyHex,
  opts: { now?: number; expiration?: number } = {},
): NostrEvent {
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const expiration = opts.expiration ?? nowSec + DEFAULT_TTL_SECONDS;
  return sealAndWrap(
    {
      kind: KIND.FILE_CHUNK,
      created_at: nowSec,
      tags: [],
      content: JSON.stringify({
        tid: chunk.tid,
        seq: chunk.seq,
        total: chunk.total,
        name: chunk.name,
        mime: chunk.mime,
        data: b64encode(chunk.data),
      }),
    },
    senderSk,
    recipientPk,
    {
      kind: KIND.FILE_WRAP,
      tags: [
        ["p", recipientPk],
        ["expiration", String(expiration)],
      ],
    },
  );
}

/** 解析檔案分塊 rumor；kind 不符、欄位非法、超過防禦上限一律回 null。 */
export function parseFileChunk(rumor: Rumor): FileChunk | null {
  if (rumor.kind !== KIND.FILE_CHUNK) return null;
  try {
    const p = JSON.parse(rumor.content) as {
      tid?: unknown;
      seq?: unknown;
      total?: unknown;
      name?: unknown;
      mime?: unknown;
      data?: unknown;
    };
    if (typeof p.tid !== "string" || !p.tid || p.tid.length > 64) return null;
    if (!Number.isInteger(p.seq) || !Number.isInteger(p.total)) return null;
    const seq = p.seq as number;
    const total = p.total as number;
    if (total < 1 || total > FILE_CHUNK_MAX_TOTAL || seq < 0 || seq >= total) return null;
    if (typeof p.name !== "string" || !p.name || p.name.length > 255) return null;
    if (typeof p.mime !== "string" || p.mime.length > 100) return null;
    if (typeof p.data !== "string") return null;
    // 審查修正：**解碼前**先界定 base64 字串長度——避免寬鬆/非 Cinderous relay 轉發的超大
    // `data` 被完整 atob 解碼才拒絕（CPU/記憶體壓力面）。base64 每 4 字元 ≤3 位元組。
    if (p.data.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4 + 4) return null;
    const data = b64decode(p.data);
    if (!data || data.length > FILE_CHUNK_BYTES) return null;
    return { tid: p.tid, seq, total, name: p.name, mime: p.mime || "application/octet-stream", data };
  } catch {
    return null;
  }
}
