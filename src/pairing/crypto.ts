// 配對握手的密碼學（SDK ADR 0028 §3）。
//
//   pid  = HKDF(s, salt=LABEL, info="pid")[0..16]          一次配對的識別碼（只有看過 QR 的人算得出來）
//   th   = SHA-256(JSON[LABEL, role, 顯示方公鑰, 掃描方公鑰, pid, e掃, e顯, 雙方 deviceId 與名稱])
//   ikm  = ECDH(臨時, 臨時) ‖ NIP-44 對話金鑰(身分, 身分) ‖ s
//   okm  = HKDF-SHA256(ikm, salt=th, info=LABEL/keys, 128)
//        = kc（確認 MAC）‖ kMJ（成員→新裝置的加密）‖ kJM（保留）‖ ksas（短驗證碼）
//
// s 只經過 QR 的光學通道，不上網路；ikm 同時綁了臨時金鑰（前向保密）、雙方身分金鑰（隱含認證）與 s（證明看過 QR）。
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64 } from '@scure/base';

import type { NostrSigner } from '../protocol/signer.js';

export const PAIRING_LABEL = 'cinderous/pair/v1';
const SALT = utf8ToBytes(PAIRING_LABEL);
const INFO_PID = utf8ToBytes('pid');
const INFO_KEYS = utf8ToBytes(`${PAIRING_LABEL}/keys`);
const NONCE_BYTES = 24;

export interface PairingKeys {
  confirm: Uint8Array;
  memberToJoiner: Uint8Array;
  sas: Uint8Array;
}

/** 一次配對的識別碼（32 位 hex）。 */
export function pairingId(secret: Uint8Array): string {
  return bytesToHex(hkdf(sha256, secret, SALT, INFO_PID, 16));
}

export interface EphemeralKeyPair {
  secretKey: Uint8Array;
  /** x-only（32 bytes）hex */
  publicKey: string;
}

export function generateEphemeral(): EphemeralKeyPair {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, publicKey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

/** 合法的 x-only 公鑰（在曲線上） */
export function isPoint(hex: unknown): hex is string {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

export interface TranscriptInput {
  role: 'invite' | 'join';
  displayer: string;
  scanner: string;
  pid: string;
  scannerEphemeral: string;
  displayerEphemeral: string;
  scannerDevice: { deviceId: string; label: string };
  displayerDevice: { deviceId: string; label: string };
}

export function transcriptHash(t: TranscriptInput): Uint8Array {
  return sha256(
    utf8ToBytes(
      JSON.stringify([
        PAIRING_LABEL,
        t.role,
        t.displayer,
        t.scanner,
        t.pid,
        t.scannerEphemeral,
        t.displayerEphemeral,
        t.scannerDevice.deviceId,
        t.scannerDevice.label,
        t.displayerDevice.deviceId,
        t.displayerDevice.label,
      ]),
    ),
  );
}

export function deriveKeys(opts: {
  ephemeral: EphemeralKeyPair;
  peerEphemeral: string;
  signer: NostrSigner;
  peer: string;
  secret: Uint8Array;
  transcript: Uint8Array;
}): PairingKeys {
  const dh = secp256k1.getSharedSecret(opts.ephemeral.secretKey, concatBytes(new Uint8Array([2]), hexToBytes(opts.peerEphemeral))).subarray(1, 33);
  const identity = opts.signer.conversationKey(opts.peer);
  const ikm = concatBytes(dh, identity, opts.secret);
  const okm = hkdf(sha256, ikm, opts.transcript, INFO_KEYS, 128);
  const keys = { confirm: okm.slice(0, 32), memberToJoiner: okm.slice(32, 64), sas: okm.slice(96, 128) };
  // 清掉中間值（審查 #8）。身分對話金鑰不清：`NostrSigner` 的實作可能回傳快取本身
  dh.fill(0);
  ikm.fill(0);
  okm.fill(0);
  return keys;
}

/** 確認 MAC（hex） */
export function confirmMac(keys: PairingKeys, label: string, transcript: Uint8Array): string {
  return bytesToHex(hmac(sha256, keys.confirm, concatBytes(utf8ToBytes(label), transcript)));
}

/** 定時比較兩個 hex 字串 */
export function macEquals(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 6 位數短驗證碼（兩台螢幕比對用） */
export function sasCode(keys: PairingKeys): string {
  const v = new DataView(keys.sas.buffer, keys.sas.byteOffset).getUint32(0, false);
  return String(v % 1_000_000).padStart(6, '0');
}

/** XChaCha20-Poly1305；輸出 base64(nonce ‖ 密文) */
export function sealPayload(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): string {
  const nonce = randomBytes(NONCE_BYTES);
  return base64.encode(concatBytes(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext)));
}

export function openPayload(key: Uint8Array, sealed: unknown, aad: Uint8Array): Uint8Array | null {
  if (typeof sealed !== 'string') return null;
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(sealed);
  } catch {
    return null;
  }
  if (bytes.length < NONCE_BYTES + 16) return null;
  try {
    return xchacha20poly1305(key, bytes.subarray(0, NONCE_BYTES), aad).decrypt(bytes.subarray(NONCE_BYTES));
  } catch {
    return null;
  }
}
