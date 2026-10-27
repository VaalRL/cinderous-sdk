// 星狀會話的邀請（SDK ADR 0030 §2）。
//
//   cinderous-star:1.<base64url(核心 53 bytes)>.<中繼>[,<中繼>…]
//   核心：[旗標 1（保留，必須 0）][Host 身分公鑰 32][邀請秘密 16][到期時間 u32 秒 4]
//
// 為什麼不沿用 NIP-59 信令直接「邀請某人」：加入者必須先知道 Host 是誰、到哪座中繼找它，本來就要一段帶外資訊
//（QR、私訊、複製連結）。所以沿用配對 URI 的風格（ADR 0028）：一段字串帶齊 Host 公鑰、秘密、到期與中繼。
// 秘密**不上線**：加入者連上 Host、雙棘輪握手完成後，才在加密通道裡送出（JOIN 紀錄），中繼只看得到密文。
//
// Host 只存秘密的 SHA-256；邀請有到期時間、可用次數（預設一次）、可撤銷，也可以綁定只給某把公鑰用。
// Host 是唯一的判斷者（到期以 Host 的時鐘為準）；加入者這邊的到期檢查只是提早失敗。
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import { compactRelayUrl, expandRelayToken } from '../pairing/uri.js';
import { STAR_INVITE_SECRET_BYTES } from './wire.js';

export const STAR_INVITE_PREFIX = 'cinderous-star:';
export const STAR_INVITE_VERSION = 1;
/** 預設有效期：10 分鐘 */
export const DEFAULT_STAR_INVITE_TTL_MS = 10 * 60_000;
/** 有效期上限：24 小時（長期有效的邀請等於一把長期門鑰匙） */
export const MAX_STAR_INVITE_TTL_MS = 24 * 60 * 60_000;
/** 一個 Host 同時最多幾張有效邀請 */
export const MAX_STAR_INVITES = 256;
export const STAR_INVITE_MAX_RELAYS = 3;
const CORE_BYTES = 1 + 32 + STAR_INVITE_SECRET_BYTES + 4;
const CORE_CHARS = Math.ceil((CORE_BYTES * 8) / 6);
const PK_HEX = /^[0-9a-f]{64}$/;

export class StarInviteError extends Error {
  override readonly name = 'StarInviteError';
}

/** 邀請字串承載的內容 */
export interface StarInvitePayload {
  /** Host 的身分公鑰（hex）：加入者連的就是它，通道認證的對方必須是它 */
  host: string;
  secret: Uint8Array;
  /** 到期時間（unix 秒，Host 的時鐘） */
  expiresAt: number;
  relays: string[];
}

/**
 * 邀請裡的中繼只收 `wss://`（本機測試可用 `ws://localhost`／`ws://127.0.0.1`），網址不得帶帳號（`@`）：
 * 偽造的邀請最多只能把人導到別的中繼（看到後設資料、擋掉連線），不必再給它更多花樣（安全審查 Info）。
 */
function acceptableRelay(url: string): boolean {
  if (url.includes('@')) return false;
  if (/^wss:\/\//i.test(url)) return true;
  return /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url);
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

export function encodeStarInvite(invite: StarInvitePayload): string {
  if (!isValidPubkey(invite.host)) throw new StarInviteError('Host 公鑰不合法');
  if (!(invite.secret instanceof Uint8Array) || invite.secret.length !== STAR_INVITE_SECRET_BYTES) throw new StarInviteError('邀請秘密長度不對');
  if (!Number.isInteger(invite.expiresAt) || invite.expiresAt <= 0 || invite.expiresAt > 0xffffffff) throw new StarInviteError('到期時間不合法');
  const core = new Uint8Array(CORE_BYTES);
  core.set(hexToBytes(invite.host), 1);
  core.set(invite.secret, 33);
  new DataView(core.buffer).setUint32(33 + STAR_INVITE_SECRET_BYTES, invite.expiresAt, false);
  const relays: string[] = [];
  for (const url of invite.relays) {
    const token = acceptableRelay(url.trim()) ? compactRelayUrl(url) : null;
    if (token && !relays.includes(token) && relays.length < STAR_INVITE_MAX_RELAYS) relays.push(token);
  }
  if (relays.length === 0) throw new StarInviteError('至少要一座合法的中繼（wss://…）');
  return `${STAR_INVITE_PREFIX}${STAR_INVITE_VERSION}.${base64urlnopad.encode(core)}.${relays.join(',')}`;
}

/** 解析邀請字串；格式不對丟 `StarInviteError`。不檢查到期（見 {@link isStarInviteExpired}）。 */
export function parseStarInvite(uri: string): StarInvitePayload {
  const s = uri.trim();
  if (s.length > 1024 || !s.toLowerCase().startsWith(STAR_INVITE_PREFIX)) throw new StarInviteError('不是星狀會話邀請');
  const rest = s.slice(STAR_INVITE_PREFIX.length);
  if (!rest.startsWith(`${STAR_INVITE_VERSION}.`)) throw new StarInviteError('不支援的邀請版本，請更新');
  const coreText = rest.slice(2, 2 + CORE_CHARS);
  if (rest[2 + CORE_CHARS] !== '.') throw new StarInviteError('邀請格式不對');
  let core: Uint8Array;
  try {
    core = base64urlnopad.decode(coreText);
  } catch {
    throw new StarInviteError('邀請格式不對');
  }
  if (core.length !== CORE_BYTES || core[0] !== 0) throw new StarInviteError('邀請格式不對');
  const host = bytesToHex(core.subarray(1, 33));
  if (!isValidPubkey(host)) throw new StarInviteError('邀請裡的 Host 公鑰不合法');
  const expiresAt = new DataView(core.buffer, core.byteOffset).getUint32(33 + STAR_INVITE_SECRET_BYTES, false);
  const tokens = rest.slice(3 + CORE_CHARS).split(',');
  if (tokens.length < 1 || tokens.length > STAR_INVITE_MAX_RELAYS) throw new StarInviteError('邀請的中繼數量不對');
  const relays = tokens.map((t) => {
    const url = expandRelayToken(t);
    if (url === null || !acceptableRelay(url)) throw new StarInviteError(`邀請裡的中繼網址不合法：${t}`);
    return url;
  });
  return { host, secret: core.slice(33, 33 + STAR_INVITE_SECRET_BYTES), expiresAt, relays };
}

export function isStarInviteExpired(invite: Pick<StarInvitePayload, 'expiresAt'>, nowMs: number = Date.now()): boolean {
  return nowMs >= invite.expiresAt * 1000;
}

// ── Host 端的邀請簿 ──────────────────────────────────────

export interface CreateStarInviteOptions {
  /** 放進邀請字串的中繼（加入者用它們找 Host），最多 3 座 */
  relays: string[];
  /** 有效期（預設 10 分鐘，上限 24 小時） */
  ttlMs?: number;
  /** 可用幾次（預設 1＝一次性；上限 = 成員上限） */
  maxUses?: number;
  /** 只給這把公鑰用（例如經私訊送給特定的人）；其他人拿到字串也進不來 */
  forPubkey?: string;
}

export interface StarInvite {
  /** 撤銷用的 id（不是秘密） */
  readonly id: string;
  readonly uri: string;
  readonly expiresAt: number;
  readonly maxUses: number;
  readonly forPubkey?: string;
}

/** 邀請簿裡看得到的資訊：**不含邀請字串**（字串裡有秘密；只在 `createInvite` 回傳一次，安全審查 M3） */
export interface StarInviteInfo {
  readonly id: string;
  readonly expiresAt: number;
  readonly maxUses: number;
  readonly forPubkey?: string;
  readonly uses: number;
  readonly revoked: boolean;
}

interface InviteRecord {
  id: string;
  expiresAt: number;
  maxUses: number;
  forPubkey?: string;
  uses: number;
  revoked: boolean;
}

export type RedeemResult = { ok: true; inviteId: string } | { ok: false; reason: 'invalid-invite' | 'expired' | 'revoked' | 'used' };

export class InviteBook {
  /** 以秘密的 SHA-256 為鍵：記憶體傾印不會洩漏可用的秘密 */
  readonly #byHash = new Map<string, InviteRecord>();
  readonly #byId = new Map<string, string>();

  constructor(
    private readonly host: string,
    private readonly now: () => number,
  ) {}

  create(opts: CreateStarInviteOptions, maxUsesCap: number): StarInvite {
    this.#prune();
    if (this.#byHash.size >= MAX_STAR_INVITES) this.#prune(true);
    if (this.#byHash.size >= MAX_STAR_INVITES) throw new StarInviteError(`有效邀請太多（上限 ${MAX_STAR_INVITES}），請先撤銷用不到的`);
    const ttl = opts.ttlMs ?? DEFAULT_STAR_INVITE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_STAR_INVITE_TTL_MS) throw new StarInviteError('有效期要在 0 到 24 小時之間');
    const maxUses = opts.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > maxUsesCap) throw new StarInviteError(`可用次數要在 1 到 ${maxUsesCap} 之間`);
    const forPubkey = opts.forPubkey?.toLowerCase();
    if (forPubkey !== undefined && !PK_HEX.test(forPubkey)) throw new StarInviteError('forPubkey 格式不對');
    const secret = randomBytes(STAR_INVITE_SECRET_BYTES);
    const expiresAt = Math.ceil((this.now() + ttl) / 1000);
    const uri = encodeStarInvite({ host: this.host, secret, expiresAt, relays: opts.relays });
    const hash = bytesToHex(sha256(secret));
    secret.fill(0);
    const id = bytesToHex(randomBytes(8));
    const record: InviteRecord = { id, expiresAt, maxUses, uses: 0, revoked: false, ...(forPubkey ? { forPubkey } : {}) };
    this.#byHash.set(hash, record);
    this.#byId.set(id, hash);
    return { id, uri, expiresAt, maxUses, ...(forPubkey ? { forPubkey } : {}) };
  }

  revoke(id: string): boolean {
    const hash = this.#byId.get(id);
    const record = hash ? this.#byHash.get(hash) : undefined;
    if (!record || record.revoked) return false;
    record.revoked = true;
    return true;
  }

  revokeAll(): void {
    for (const record of this.#byHash.values()) record.revoked = true;
  }

  list(): StarInviteInfo[] {
    this.#prune();
    return [...this.#byHash.values()].map((r) => ({ ...r }));
  }

  /** 只驗證、不扣次數 */
  check(secret: Uint8Array, pubkey: string): RedeemResult {
    const result = this.#find(secret, pubkey);
    return result.ok ? { ok: true, inviteId: result.record.id } : result;
  }

  /** 驗證並**用掉一次**。先扣次數再做其他（非同步的）核准，兩個人同時拿一次性邀請也只有一個進得來。 */
  redeem(secret: Uint8Array, pubkey: string): RedeemResult {
    const result = this.#find(secret, pubkey);
    if (!result.ok) return result;
    result.record.uses += 1;
    return { ok: true, inviteId: result.record.id };
  }

  #find(secret: Uint8Array, pubkey: string): { ok: true; record: InviteRecord } | { ok: false; reason: 'invalid-invite' | 'expired' | 'revoked' | 'used' } {
    const record = this.#byHash.get(bytesToHex(sha256(secret)));
    if (!record) return { ok: false, reason: 'invalid-invite' };
    if (record.forPubkey !== undefined && record.forPubkey !== pubkey) return { ok: false, reason: 'invalid-invite' };
    if (record.revoked) return { ok: false, reason: 'revoked' };
    if (this.now() >= record.expiresAt * 1000) return { ok: false, reason: 'expired' };
    if (record.uses >= record.maxUses) return { ok: false, reason: 'used' };
    return { ok: true, record };
  }

  /**
   * 過期超過一小時的從簿子拿掉（之前留著，才能回報正確的拒絕原因）；
   * `force`：簿子滿了，撤銷或用完的也立刻拿掉。
   */
  #prune(force = false): void {
    const now = this.now();
    const cutoff = now - 60 * 60_000;
    for (const [hash, r] of this.#byHash) {
      const spent = r.revoked || r.uses >= r.maxUses;
      if (r.expiresAt * 1000 <= cutoff || (force && (spent || r.expiresAt * 1000 <= now))) {
        this.#byHash.delete(hash);
        this.#byId.delete(r.id);
      }
    }
  }
}
