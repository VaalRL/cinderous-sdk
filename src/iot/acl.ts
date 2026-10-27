// 閘道端角色權限（SDK ADR 0049 §2.5；使用者裁示第 5 項）。
//
// - 授權依**外層事件的簽章者公鑰**，不是內容自稱的身分；
// - `viewer` 可查詢、`operator` 可操作、`owner` 另可改名單（保留 topic `$sys/acl`）；
// - 每筆可選 `devices`（`*` 尾萬用字元）與 `topics`（MQTT 樣式）細分，兩者都給時取交集；
// - topic 規則可標 `minRole`（門鎖、瓦斯）與 `confirm`（呼叫端要明確帶 `confirmed: true`）；
// - 名單**只以閘道本地為準**（`IotAclStore`），不放進 ADR 0028 可合併的 `VaultMembership`——那份任何成員都能改、以聯集合併，
//   `viewer` 可以把自己升成 `operator`。
//
// ⚠ 能解密≠能下指令：持有家庭秘密的人讀得到所有狀態，名單只限制「誰能查詢、誰能操作」。
import { npubDecode, type PubkeyHex } from '../protocol/keys.js';
import { assertIotTopicPattern, deviceMatches, IOT_ACL_TOPIC, IOT_PUSH_TOPIC, isValidIotDeviceId, topicMatches } from './topic.js';

export type IotRole = 'viewer' | 'operator' | 'owner';
export const IOT_ROLES: readonly IotRole[] = ['viewer', 'operator', 'owner'];
const RANK: Record<IotRole, number> = { viewer: 1, operator: 2, owner: 3 };

/** 角色名單最多幾筆（防濫用；一個家庭用不到這麼多） */
export const IOT_ACL_MAX_ENTRIES = 256;
const LIST_MAX = 64;
const LABEL_MAX = 64;

export interface IotAclEntry {
  /** 64 位 hex 公鑰（輸入時也收 npub） */
  readonly pubkey: PubkeyHex;
  readonly role: IotRole;
  /** 只能碰這些設備（完全相同或 `*` 結尾的前綴）；省略＝全部 */
  readonly devices?: readonly string[];
  /** 只能操作這些 topic（MQTT 樣式）；省略＝全部。查詢不看這一欄（查詢以設備為單位） */
  readonly topics?: readonly string[];
  /** 到期時間（Unix 秒）；過了自動失效 */
  readonly expiresAt?: number;
  readonly label?: string;
}

export interface IotTopicRule {
  /** MQTT 樣式 */
  readonly topic: string;
  /** 操作這些 topic 至少要這個角色（例如門鎖 `owner`） */
  readonly minRole?: IotRole;
  /** 操作前要求呼叫端明確確認（`command(…, { confirmed: true })`） */
  readonly confirm?: boolean;
}

export interface IotAcl {
  readonly entries: readonly IotAclEntry[];
  readonly rules?: readonly IotTopicRule[];
}

export type IotAclOp =
  | { readonly op: 'add'; readonly entry: IotAclEntryInput }
  | { readonly op: 'remove'; readonly pubkey: string };

/** 輸入形狀：`pubkey` 或 `npub` 擇一 */
export type IotAclEntryInput = Omit<IotAclEntry, 'pubkey'> & { readonly pubkey?: string; readonly npub?: string };

/** 設定檔與選項收的名單：陣列（只有 entries）或 `{ entries, rules }`，公鑰可寫 npub */
export type IotAclInput = IotAcl | readonly IotAclEntryInput[] | { readonly entries: readonly IotAclEntryInput[]; readonly rules?: readonly IotTopicRule[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** npub 或 64 位 hex → hex；不合法丟例外 */
export function iotPubkeyOf(value: string): PubkeyHex {
  const v = value.trim();
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  if (/^[0-9A-F]{64}$/.test(v)) return v.toLowerCase();
  if (v.startsWith('npub1')) {
    const hex = npubDecode(v);
    if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  }
  throw new RangeError(`不是公鑰（npub 或 64 位 hex）：${value}`);
}

function stringList(raw: unknown, what: string, check: (s: string) => void): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIST_MAX || !raw.every((x) => typeof x === 'string')) {
    throw new RangeError(`${what} 必須是 1–${LIST_MAX} 個字串`);
  }
  for (const s of raw) check(s);
  return [...raw];
}

function checkDevicePattern(pattern: string): void {
  const body = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
  if (pattern !== '*' && !isValidIotDeviceId(body)) throw new RangeError(`設備樣式不合法：${pattern}`);
}

function role(raw: unknown, what: string): IotRole {
  if (!IOT_ROLES.includes(raw as IotRole)) throw new RangeError(`${what} 只能是 viewer、operator 或 owner（收到 ${String(raw)}）`);
  return raw as IotRole;
}

/** 驗證並正規化一筆（npub → hex）；不合法丟例外 */
export function normalizeIotAclEntry(raw: unknown): IotAclEntry {
  if (!isObject(raw)) throw new RangeError('角色名單的每一筆都要是物件');
  const key = raw.pubkey ?? raw.npub;
  if (typeof key !== 'string') throw new RangeError('角色名單的每一筆都要有 pubkey 或 npub');
  const entry: { -readonly [K in keyof IotAclEntry]: IotAclEntry[K] } = { pubkey: iotPubkeyOf(key), role: role(raw.role, 'role') };
  const devices = stringList(raw.devices, 'devices', checkDevicePattern);
  if (devices) entry.devices = devices;
  const topics = stringList(raw.topics, 'topics', assertIotTopicPattern);
  if (topics) entry.topics = topics;
  if (raw.expiresAt !== undefined) {
    if (!Number.isSafeInteger(raw.expiresAt) || (raw.expiresAt as number) <= 0) throw new RangeError('expiresAt 必須是 Unix 秒');
    entry.expiresAt = raw.expiresAt as number;
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string' || raw.label.length > LABEL_MAX) throw new RangeError(`label 最多 ${LABEL_MAX} 字`);
    entry.label = raw.label;
  }
  return entry;
}

function normalizeRule(raw: unknown): IotTopicRule {
  if (!isObject(raw) || typeof raw.topic !== 'string') throw new RangeError('topic 規則要有 topic');
  assertIotTopicPattern(raw.topic);
  const rule: { -readonly [K in keyof IotTopicRule]: IotTopicRule[K] } = { topic: raw.topic };
  if (raw.minRole !== undefined) rule.minRole = role(raw.minRole, 'minRole');
  if (raw.confirm !== undefined) {
    if (typeof raw.confirm !== 'boolean') throw new RangeError('confirm 只能是 true 或 false');
    rule.confirm = raw.confirm;
  }
  return rule;
}

/**
 * 驗證整份名單：每筆合法、公鑰不重複、筆數有上限。接受陣列（只有 entries）或 `{ entries, rules }`。
 * 不合法丟例外（設定檔寫錯就不啟動，不默默略過某一筆）。
 */
export function parseIotAcl(raw: unknown): IotAcl {
  const obj = Array.isArray(raw) ? { entries: raw } : raw;
  if (!isObject(obj) || !Array.isArray(obj.entries)) throw new RangeError('角色名單要是陣列，或 { entries, rules }');
  if (obj.entries.length > IOT_ACL_MAX_ENTRIES) throw new RangeError(`角色名單最多 ${IOT_ACL_MAX_ENTRIES} 筆`);
  const entries = obj.entries.map(normalizeIotAclEntry);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.pubkey)) throw new RangeError(`角色名單有重複的公鑰：${e.pubkey}`);
    seen.add(e.pubkey);
  }
  if (obj.rules !== undefined && !Array.isArray(obj.rules)) throw new RangeError('rules 要是陣列');
  const rules = (obj.rules as unknown[] | undefined)?.map(normalizeRule);
  return rules && rules.length > 0 ? { entries, rules } : { entries };
}

const active = (entry: IotAclEntry, nowSec: number): boolean => entry.expiresAt === undefined || entry.expiresAt > nowSec;

/** 某把公鑰目前的角色（過期＝沒有） */
export function iotRoleOf(acl: IotAcl, pubkey: PubkeyHex, nowSec: number): IotRole | undefined {
  const entry = acl.entries.find((e) => e.pubkey === pubkey);
  return entry && active(entry, nowSec) ? entry.role : undefined;
}

export const iotRoleAtLeast = (have: IotRole, need: IotRole): boolean => RANK[have] >= RANK[need];

export interface IotAuthorizeRequest {
  readonly pubkey: PubkeyHex;
  readonly action: 'operate' | 'query';
  readonly device?: string;
  readonly topic?: string;
  readonly confirmed?: boolean;
}

export type IotAuthorization =
  | { readonly ok: true; readonly role: IotRole }
  | { readonly ok: false; readonly status: 'not-allowed' | 'rejected'; readonly reason: string };

/** 授權一次操作或查詢（ADR 0049 §2.5）。不在名單、過期、角色不足、樣式不符→`not-allowed`；缺確認→`rejected` */
export function authorizeIot(acl: IotAcl, req: IotAuthorizeRequest, nowSec: number): IotAuthorization {
  const entry = acl.entries.find((e) => e.pubkey === req.pubkey);
  if (!entry) return { ok: false, status: 'not-allowed', reason: 'not-in-acl' };
  if (!active(entry, nowSec)) return { ok: false, status: 'not-allowed', reason: 'expired' };
  // 名單管理只看角色（owner 的細分不限制它，否則 owner 可能把自己鎖在外面）
  if (req.action === 'operate' && req.topic === IOT_ACL_TOPIC) {
    return entry.role === 'owner' ? { ok: true, role: entry.role } : { ok: false, status: 'not-allowed', reason: 'owner-only' };
  }
  // 推播登記（ADR 0049 §11.1）：任何有效成員都能登記自己的端點（viewer 也讀得到狀態）；不受設備／topic 細分限制，
  // 額度預警只有 owner 能訂閱——由送出端的推播登記檢查
  if (req.action === 'operate' && req.topic === IOT_PUSH_TOPIC) return { ok: true, role: entry.role };
  const need: IotRole = req.action === 'operate' ? 'operator' : 'viewer';
  if (!iotRoleAtLeast(entry.role, need)) return { ok: false, status: 'not-allowed', reason: 'role' };
  if (entry.devices) {
    if (req.device === undefined || !entry.devices.some((p) => deviceMatches(p, req.device!))) return { ok: false, status: 'not-allowed', reason: 'device' };
  }
  if (req.action === 'operate') {
    const topic = req.topic ?? '';
    if (entry.topics && !entry.topics.some((p) => topicMatches(p, topic))) return { ok: false, status: 'not-allowed', reason: 'topic' };
    let confirm = false;
    for (const rule of acl.rules ?? []) {
      if (!topicMatches(rule.topic, topic)) continue;
      if (rule.minRole && !iotRoleAtLeast(entry.role, rule.minRole)) return { ok: false, status: 'not-allowed', reason: 'min-role' };
      if (rule.confirm) confirm = true;
    }
    if (confirm && req.confirmed !== true) return { ok: false, status: 'rejected', reason: 'confirm-required' };
  }
  return { ok: true, role: entry.role };
}

/** 驗證 `$sys/acl` 的操作內容（JSON 字串） */
export function parseIotAclOp(payload: string): IotAclOp {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new RangeError('角色名單操作要是 JSON');
  }
  if (!isObject(raw)) throw new RangeError('角色名單操作要是物件');
  if (raw.op === 'add') return { op: 'add', entry: normalizeIotAclEntry(raw.entry) };
  if (raw.op === 'remove' && typeof raw.pubkey === 'string') return { op: 'remove', pubkey: iotPubkeyOf(raw.pubkey) };
  throw new RangeError('角色名單操作只有 add（帶 entry）與 remove（帶 pubkey）');
}

/**
 * 套用一次名單操作，回傳新名單（不改原本的）。`add` 以公鑰為鍵取代同一人的那一筆。
 * 🔴 不允許讓名單裡沒有任何有效的 owner（移除或降級最後一位 owner）——否則再也沒有人能改名單。
 */
export function applyIotAclOp(acl: IotAcl, op: IotAclOp, nowSec: number): IotAcl {
  let entries: IotAclEntry[];
  if (op.op === 'add') {
    const entry = normalizeIotAclEntry(op.entry);
    entries = acl.entries.filter((e) => e.pubkey !== entry.pubkey);
    if (entries.length >= IOT_ACL_MAX_ENTRIES) throw new RangeError(`角色名單最多 ${IOT_ACL_MAX_ENTRIES} 筆`);
    entries.push(entry);
  } else {
    const pubkey = iotPubkeyOf(op.pubkey);
    if (!acl.entries.some((e) => e.pubkey === pubkey)) throw new RangeError('名單上沒有這把公鑰');
    entries = acl.entries.filter((e) => e.pubkey !== pubkey);
  }
  if (!entries.some((e) => e.role === 'owner' && active(e, nowSec))) throw new RangeError('名單至少要留一位有效的 owner');
  return acl.rules ? { entries, rules: acl.rules } : { entries };
}

/** 角色名單的持久化（只在閘道本地；例如 `./iot/bridge` 的 `fileIotAclStore`） */
export interface IotAclStore {
  load(): IotAcl | undefined | Promise<IotAcl | undefined>;
  save(acl: IotAcl): void | Promise<void>;
}

/** 記憶體版（測試、或不需要跨重開保存時） */
export function memoryIotAclStore(initial?: IotAcl): IotAclStore & { current(): IotAcl | undefined } {
  let acl = initial;
  return {
    load: () => acl,
    save: (next) => {
      acl = next;
    },
    current: () => acl,
  };
}
