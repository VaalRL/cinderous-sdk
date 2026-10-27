// 協調器訊息的線上格式（SDK ADR 0025 §5）：UTF-8 JSON 標頭，後面接內容的原始位元組。
//
// 收端**逐欄驗證**：路徑不得是絕對路徑、不得有 `..`、不得有控制字元；內容必須與宣告的雜湊相符。
// 任何一項不符整則丟掉（回 null），不讓壞資料進版本圖。
import { FILE_CHUNK_BYTES, RELAY_FILE_MAX_BYTES_CAP } from '../file-relay.js';
import { sha256Hex } from './graph.js';
import type { VaultBundleItem, VaultSyncMessage, VaultVersion } from './types.js';

/** 線上格式版本 */
export const VAULT_WIRE_VERSION = 1;
const MAX_PATH = 1024;
const MAX_LABEL = 64;
const MAX_PARENTS = 64;
const MAX_ITEMS = 2000;
/** 一則 `bundle` 最多幾項（SDK ADR 0095；跟 `nodes` 的合成上限相同） */
export const MAX_BUNDLE_ITEMS = 200;
const MAX_HEADER_BYTES = 1024 * 1024;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEVICE = /^[A-Za-z0-9_.:-]{1,64}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Vault 相對路徑是否安全：非空、`/` 分隔、非絕對、沒有 `.`／`..` 段、沒有控制字元與反斜線。 */
export function isSafeVaultPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export function isValidDeviceId(id: unknown): id is string {
  return typeof id === 'string' && DEVICE.test(id);
}

const isInt = (x: unknown, min = 0): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min;

/** 驗證一個版本；不合法回 null。 */
export function parseVersion(raw: unknown): VaultVersion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !HEX32.test(v.id)) return null;
  if (!Array.isArray(v.parents) || v.parents.length > MAX_PARENTS) return null;
  if (!v.parents.every((p) => typeof p === 'string' && HEX32.test(p) && p !== v.id)) return null;
  if (new Set(v.parents).size !== v.parents.length) return null;
  if (!isSafeVaultPath(v.path)) return null;
  if (!isInt(v.pathAt) || !isInt(v.at) || !isInt(v.size)) return null;
  if (typeof v.deleted !== 'boolean' || typeof v.text !== 'boolean' || typeof v.p2p !== 'boolean') return null;
  if (v.deleted ? v.hash !== '' || v.size !== 0 : typeof v.hash !== 'string' || !HEX64.test(v.hash)) return null;
  if (!isValidDeviceId(v.device)) return null;
  if (typeof v.label !== 'string' || v.label.length > MAX_LABEL) return null;
  return {
    id: v.id,
    parents: [...(v.parents as string[])],
    path: v.path,
    pathAt: v.pathAt,
    deleted: v.deleted,
    hash: v.hash as string,
    size: v.size,
    text: v.text,
    at: v.at,
    device: v.device,
    label: v.label,
    p2p: v.p2p,
  };
}

/**
 * 標頭（JSON）與標頭後面要接的內容。`bundle`（SDK ADR 0095）的每一項在標頭裡是 `[fileId, 版本, 內容長度｜-1]`，
 * 內容依序接在標頭後面；其他訊息最多一段內容（`contentLength`）。
 */
function wireParts(message: VaultSyncMessage): { header: Uint8Array; parts: Uint8Array[] } {
  if (message.type === 'bundle') {
    const { items, ...rest } = message;
    const parts = items.flatMap((item) => (item.content ? [item.content] : []));
    const wire = items.map((item) => [item.fileId, item.node, item.content ? item.content.length : -1]);
    return { header: encoder.encode(JSON.stringify({ v: VAULT_WIRE_VERSION, ...rest, items: wire })), parts };
  }
  const { content, ...rest } = message as VaultSyncMessage & { content?: Uint8Array };
  const header = encoder.encode(JSON.stringify({ v: VAULT_WIRE_VERSION, ...rest, ...(content ? { contentLength: content.length } : {}) }));
  return { header, parts: content ? [content] : [] };
}

/**
 * 訊息 → 位元組：`[4 bytes 大端序：標頭長度][標頭 UTF-8 JSON][內容原始位元組]`。
 * 內容不經 base64（中繼那一層會再 base64 一次，兩次就白白多 33%）。
 */
export function encodeVaultMessage(message: VaultSyncMessage): Uint8Array {
  const { header, parts } = wireParts(message);
  const out = new Uint8Array(4 + header.length + parts.reduce((n, part) => n + part.length, 0));
  new DataView(out.buffer).setUint32(0, header.length, false);
  out.set(header, 4);
  let offset = 4 + header.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * `encodeVaultMessage(message).length`，但不複製內容（SDK ADR 0029：協調器要在送出前算出會佔幾顆檔案塊）。
 */
export function encodedVaultMessageLength(message: VaultSyncMessage): number {
  const { header, parts } = wireParts(message);
  return 4 + header.length + parts.reduce((n, part) => n + part.length, 0);
}

/** 一則編碼後 `encodedLength` 位元組的訊息，經中繼要切成幾個訊框（＝每位收件人幾顆檔案塊） */
export function vaultFrameCount(encodedLength: number): number {
  return Math.max(1, Math.ceil(encodedLength / FILE_CHUNK_BYTES));
}

/** 位元組 → 訊息；任何欄位不合法回 null（內容雜湊不符也是）。 */
export function decodeVaultMessage(bytes: Uint8Array): VaultSyncMessage | null {
  if (bytes.length < 4) return null;
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (headerLength > MAX_HEADER_BYTES || 4 + headerLength > bytes.length) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headerLength))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || raw.v !== VAULT_WIRE_VERSION) return null;
  const rest = bytes.subarray(4 + headerLength);
  const { v: _v, contentLength, ...message } = raw;
  if (message.type === 'bundle') {
    // 每一項 `[fileId, 版本, 內容長度｜-1]`，內容依序接在標頭後面，要剛好用完（SDK ADR 0095）
    if (contentLength !== undefined || !Array.isArray(message.items) || message.items.length > MAX_BUNDLE_ITEMS) return null;
    let offset = 0;
    const items: Array<Record<string, unknown>> = [];
    for (const entry of message.items as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 3) return null;
      const [fileId, node, length] = entry as [unknown, unknown, unknown];
      if (length === -1) {
        items.push({ fileId, node });
        continue;
      }
      if (!isInt(length) || offset + length > rest.length) return null;
      items.push({ fileId, node, content: rest.slice(offset, offset + length) });
      offset += length;
    }
    if (offset !== rest.length) return null;
    return validateVaultMessage({ ...message, items });
  }
  if (contentLength === undefined) {
    if (rest.length > 0) return null;
  } else {
    if (!isInt(contentLength) || contentLength !== rest.length) return null;
    message.content = rest.slice();
  }
  return validateVaultMessage(message);
}

/**
 * 驗證一則（已經是物件的）訊息，回傳乾淨的複本；不合法回 null。
 * 協調器收到任何傳輸層交來的訊息都會再過一次（自訂的傳輸層不一定經過 `decodeVaultMessage`）。
 */
export function validateVaultMessage(input: unknown): VaultSyncMessage | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  // 寄件序號（SDK ADR 0068）：正整數；簽收單不帶
  if (raw.rs !== undefined && (!isInt(raw.rs, 1) || raw.type === 'receipt')) return null;
  const message = validateBody(raw);
  return message && raw.rs !== undefined ? { ...message, rs: raw.rs as number } : message;
}

/** 一份簽收單最多幾段序號區間（SDK ADR 0068） */
const MAX_RECEIPT_RANGES = 1000;
/** 摘要的 `seen` 最多幾台（SDK ADR 0074；協調器只放最近的這麼多台） */
export const MAX_SEEN = 256;

function validateBody(raw: Record<string, unknown>): VaultSyncMessage | null {
  if (!isValidDeviceId(raw.from)) return null;
  const from = raw.from;
  if (raw.type !== 'node' && raw.content !== undefined) return null;
  switch (raw.type) {
    case 'node': {
      if (typeof raw.fileId !== 'string' || !HEX32.test(raw.fileId)) return null;
      const node = parseVersion(raw.node);
      if (!node) return null;
      if (raw.content === undefined) return { type: 'node', from, fileId: raw.fileId, node };
      const content = raw.content;
      // 收端只擋絕對上限（SDK ADR 0029）：送端依它的中繼宣告決定多大的檔案走中繼，收端不知道是哪一座、宣告多少
      if (!(content instanceof Uint8Array) || node.deleted || content.length > RELAY_FILE_MAX_BYTES_CAP) return null;
      if (content.length !== node.size || sha256Hex(content) !== node.hash) return null;
      return { type: 'node', from, fileId: raw.fileId, node, content };
    }
    case 'digest': {
      if (typeof raw.digestId !== 'string' || !HEX32.test(raw.digestId)) return null;
      if (!isInt(raw.part) || !isInt(raw.parts, 1) || raw.part >= raw.parts || raw.parts > 10_000) return null;
      if (!Array.isArray(raw.files) || raw.files.length > MAX_ITEMS) return null;
      const files: Array<[string, string[]]> = [];
      for (const entry of raw.files) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [fileId, heads] = entry as [unknown, unknown];
        if (typeof fileId !== 'string' || !HEX32.test(fileId)) return null;
        if (!Array.isArray(heads) || heads.length > MAX_PARENTS || !heads.every((h) => typeof h === 'string' && HEX32.test(h))) return null;
        files.push([fileId, [...(heads as string[])]]);
      }
      // 已處理到各寄件人的序號、狀態識別碼（SDK ADR 0074）；舊版略過這兩欄
      let seen: Array<[string, number]> | undefined;
      if (raw.seen !== undefined) {
        if (!Array.isArray(raw.seen) || raw.seen.length > MAX_SEEN) return null;
        seen = [];
        for (const entry of raw.seen) {
          if (!Array.isArray(entry) || entry.length !== 2 || !isValidDeviceId(entry[0]) || !isInt(entry[1], 1)) return null;
          seen.push([entry[0], entry[1]]);
        }
      }
      if (raw.sid !== undefined && (typeof raw.sid !== 'string' || !HEX32.test(raw.sid))) return null;
      return {
        type: 'digest',
        from,
        digestId: raw.digestId,
        part: raw.part,
        parts: raw.parts,
        files,
        ...(seen ? { seen } : {}),
        ...(raw.sid !== undefined ? { sid: raw.sid as string } : {}),
      };
    }
    case 'want': {
      if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) return null;
      const items: Array<[string, string]> = [];
      for (const entry of raw.items) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [fileId, nodeId] = entry as [unknown, unknown];
        if (typeof fileId !== 'string' || !HEX32.test(fileId) || typeof nodeId !== 'string' || !HEX32.test(nodeId)) return null;
        items.push([fileId, nodeId]);
      }
      // `fetch`：要的是內容（SDK ADR 0058）；舊版略過這一欄
      // `deep`：連祖先一起要（SDK ADR 0088）；舊版略過這一欄
      return { type: 'want', from, items, ...(raw.fetch === true ? { fetch: true } : {}), ...(raw.deep === true ? { deep: true } : {}) };
    }
    case 'nodes': {
      // 好幾個只有版本資訊的版本（SDK ADR 0058，只送給宣告為輕量的收件人）
      if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_ITEMS) return null;
      const items: Array<[string, VaultVersion]> = [];
      for (const entry of raw.items) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [fileId, rawNode] = entry as [unknown, unknown];
        if (typeof fileId !== 'string' || !HEX32.test(fileId)) return null;
        const node = parseVersion(rawNode);
        if (!node) return null;
        items.push([fileId, node]);
      }
      return { type: 'nodes', from, items };
    }
    case 'bundle': {
      // 好幾個小版本連同內容（SDK ADR 0095）：每一項照 `node` 的規則驗證，任何一項不合法整則丟掉
      if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_BUNDLE_ITEMS) return null;
      const items: VaultBundleItem[] = [];
      for (const entry of raw.items as unknown[]) {
        if (typeof entry !== 'object' || entry === null) return null;
        const item = entry as Record<string, unknown>;
        if (typeof item.fileId !== 'string' || !HEX32.test(item.fileId)) return null;
        const node = parseVersion(item.node);
        if (!node) return null;
        if (item.content === undefined) {
          items.push({ fileId: item.fileId, node });
          continue;
        }
        const content = item.content;
        if (!(content instanceof Uint8Array) || node.deleted || node.p2p || content.length > RELAY_FILE_MAX_BYTES_CAP) return null;
        if (content.length !== node.size || sha256Hex(content) !== node.hash) return null;
        items.push({ fileId: item.fileId, node, content });
      }
      return { type: 'bundle', from, items };
    }
    case 'receipt': {
      // 簽收單（SDK ADR 0068）
      if (!isValidDeviceId(raw.for) || !Array.isArray(raw.ranges) || raw.ranges.length === 0 || raw.ranges.length > MAX_RECEIPT_RANGES) return null;
      const ranges: Array<[number, number]> = [];
      // 不重疊、不相鄰（相鄰的要合併成一段）
      let last = -1;
      for (const r of raw.ranges) {
        if (!Array.isArray(r) || r.length !== 2 || !isInt(r[0], 1) || !isInt(r[1], 1) || r[0] > r[1] || r[0] <= last + 1) return null;
        ranges.push([r[0], r[1]]);
        last = r[1];
      }
      return { type: 'receipt', from, for: raw.for, ranges };
    }
    default:
      return null;
  }
}
