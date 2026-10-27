// 配對 QR 的內容（SDK ADR 0028 §2）：SDK 只產生與解析字串，QR 影像的產生與掃描由應用自己做。
//
//   cinderous-pair:1.<base64url(核心 53 bytes)>.<中繼>[,<中繼>]
//
// 核心：[旗標 1][顯示方的身分公鑰 32][一次性配對秘密 16][到期時間 u32 秒 4]
//   旗標 bit0：0＝invite（顯示方是 Vault 成員，邀請掃描方加入）、1＝join（顯示方是新裝置，請掃描方拉它進來）；
//   其他位元保留、必須是 0。
// 中繼：最多 2 座；`wss://` 省略不寫（其他協定照寫，例如本機測試的 `ws://`）。
//
// 字串是大小寫有別的（base64url），QR 要用位元組模式。以錯誤修正等級 M 計，整串 ≤ 213 bytes＝QR 版本 10
// （57×57 模組），手機相機在一般螢幕距離可以穩定掃到。
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import { PairingError } from './errors.js';

/** 協定版本（URI 裡的版本號） */
export const PAIRING_VERSION = 1;
export const PAIRING_URI_PREFIX = 'cinderous-pair:';
/** 一次性配對秘密的長度（bytes，128 位元） */
export const PAIRING_SECRET_BYTES = 16;
/** QR 裡最多放幾座中繼 */
export const PAIRING_MAX_RELAYS = 2;
/** 單座中繼網址（壓縮後）的長度上限 */
export const PAIRING_MAX_RELAY_CHARS = 120;
/** 預設有效期（毫秒）：5 分鐘 */
export const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
/** 整串的長度上限：QR 版本 10、錯誤修正等級 M 的位元組模式容量 */
export const MAX_PAIRING_URI_BYTES = 213;
/** 目標 QR 規格 */
export const PAIRING_QR_TARGET = { version: 10, level: 'M' } as const;

const CORE_BYTES = 1 + 32 + PAIRING_SECRET_BYTES + 4;
const CORE_CHARS = Math.ceil((CORE_BYTES * 8) / 6);
const FLAG_JOIN = 0x01;
/** 壓縮後的中繼網址只允許這些字元（逗號是分隔符號，不在裡面） */
const RELAY_TOKEN = /^[A-Za-z0-9._~:/%@[\]-]+$/;
const PK_HEX = /^[0-9a-f]{64}$/;

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
export function compactRelayUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^wss?:\/\//i.test(trimmed)) return null;
  const token = /^wss:\/\//i.test(trimmed) ? trimmed.slice(6) : trimmed;
  const stripped = token.endsWith('/') && !token.slice(0, -1).includes('/') ? token.slice(0, -1) : token;
  if (stripped.length === 0 || stripped.length > PAIRING_MAX_RELAY_CHARS || !RELAY_TOKEN.test(stripped)) return null;
  return stripped;
}

/** 把 QR 裡壓縮過的中繼寫法還原成完整網址；不合法回 null（也給 `./star` 的邀請用，SDK ADR 0030） */
export function expandRelayToken(token: string): string | null {
  if (!token || token.length > PAIRING_MAX_RELAY_CHARS || !RELAY_TOKEN.test(token)) return null;
  const url = token.includes('://') ? token : `wss://${token}`;
  if (!/^wss?:\/\/[^/]/i.test(url)) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

function expandRelay(token: string): string {
  const url = expandRelayToken(token);
  if (url === null) throw new PairingError('bad-uri', `中繼網址不合法：${token}`);
  return url;
}

function isValidPubkey(hex: string): boolean {
  if (!PK_HEX.test(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 產生 QR 字串。中繼依序放，放到 2 座或長度到上限為止；第一座就放不下（或全都不能壓縮）時丟例外。
 */
export function encodePairingUri(invite: PairingInvite, opts: { maxBytes?: number } = {}): string {
  const maxBytes = opts.maxBytes ?? MAX_PAIRING_URI_BYTES;
  if (invite.version !== PAIRING_VERSION) throw new PairingError('bad-uri', `不支援的配對協定版本 ${invite.version}`);
  if (!isValidPubkey(invite.pubkey)) throw new PairingError('bad-uri', '公鑰不合法');
  if (!(invite.secret instanceof Uint8Array) || invite.secret.length !== PAIRING_SECRET_BYTES) throw new PairingError('bad-uri', '配對秘密長度不對');
  if (!Number.isInteger(invite.expiresAt) || invite.expiresAt <= 0 || invite.expiresAt > 0xffffffff) throw new PairingError('bad-uri', '到期時間不合法');
  const core = new Uint8Array(CORE_BYTES);
  core[0] = invite.role === 'join' ? FLAG_JOIN : 0;
  core.set(hexToBytes(invite.pubkey), 1);
  core.set(invite.secret, 33);
  new DataView(core.buffer).setUint32(33 + PAIRING_SECRET_BYTES, invite.expiresAt, false);
  const head = `${PAIRING_URI_PREFIX}${PAIRING_VERSION}.${base64urlnopad.encode(core)}`;
  const relays: string[] = [];
  for (const url of invite.relays) {
    if (relays.length >= PAIRING_MAX_RELAYS) break;
    const token = compactRelayUrl(url);
    if (!token || relays.includes(token)) continue;
    const candidate = `${head}.${[...relays, token].join(',')}`;
    if (utf8Length(candidate) > maxBytes) continue;
    relays.push(token);
  }
  if (relays.length === 0) throw new PairingError('bad-uri', '沒有任何中繼放得進 QR（網址太長或含不支援的字元）');
  return `${head}.${relays.join(',')}`;
}

/** 解析 QR 字串；格式不對丟 `PairingError('bad-uri')`，版本不支援丟 `PairingError('unsupported-version')`。不檢查到期。 */
export function parsePairingUri(uri: string): PairingInvite {
  const s = uri.trim();
  if (s.length > 1024 || !s.toLowerCase().startsWith(PAIRING_URI_PREFIX)) throw new PairingError('bad-uri', '不是配對 QR');
  const rest = s.slice(PAIRING_URI_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 1) throw new PairingError('bad-uri', '配對 QR 格式不對');
  const version = rest.slice(0, dot);
  if (!/^\d{1,3}$/.test(version)) throw new PairingError('bad-uri', '配對 QR 格式不對');
  if (Number(version) !== PAIRING_VERSION) throw new PairingError('unsupported-version', `不支援的配對協定版本 ${version}，請更新`);
  const coreText = rest.slice(dot + 1, dot + 1 + CORE_CHARS);
  if (rest[dot + 1 + CORE_CHARS] !== '.') throw new PairingError('bad-uri', '配對 QR 格式不對');
  let core: Uint8Array;
  try {
    core = base64urlnopad.decode(coreText);
  } catch {
    throw new PairingError('bad-uri', '配對 QR 格式不對');
  }
  if (core.length !== CORE_BYTES || (core[0]! & ~FLAG_JOIN) !== 0) throw new PairingError('bad-uri', '配對 QR 格式不對');
  const pubkey = bytesToHex(core.subarray(1, 33));
  if (!isValidPubkey(pubkey)) throw new PairingError('bad-uri', '配對 QR 的公鑰不合法');
  const expiresAt = new DataView(core.buffer, core.byteOffset).getUint32(33 + PAIRING_SECRET_BYTES, false);
  const tokens = rest.slice(dot + 2 + CORE_CHARS).split(',');
  if (tokens.length < 1 || tokens.length > PAIRING_MAX_RELAYS) throw new PairingError('bad-uri', '配對 QR 的中繼數量不對');
  return {
    version: PAIRING_VERSION,
    role: core[0]! & FLAG_JOIN ? 'join' : 'invite',
    pubkey,
    secret: core.slice(33, 33 + PAIRING_SECRET_BYTES),
    expiresAt,
    relays: tokens.map(expandRelay),
  };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** QR 位元組模式的容量（ISO/IEC 18004 表 7），版本 1–15 */
const QR_BYTE_CAPACITY: Record<'L' | 'M' | 'Q' | 'H', readonly number[]> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220],
};

/** 這麼長的字串（位元組模式）在某個錯誤修正等級下最小要幾號 QR；超過 15 號回 null。 */
export function qrVersionFor(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): number | null {
  const bytes = utf8Length(text);
  const index = QR_BYTE_CAPACITY[level].findIndex((cap) => cap >= bytes);
  return index < 0 ? null : index + 1;
}
