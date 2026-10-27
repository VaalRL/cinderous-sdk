// 版本歷史（SDK ADR 0063）的純函式：稀疏化與保留、容量上限、整個 Vault 回到時間點的預覽。
//
// 協調器負責歸檔的儲存（狀態儲存的 `ha:`／`hc:`／`hk:`）與執行還原；這裡只做「留哪些」「要做什麼」的決定與檢查點清單的編碼，
// 全部可重現、可單獨測試。
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import type {
  VaultHistoryErrorCode,
  VaultRestoreItem,
  VaultRestorePlan,
  VaultRestoreSkipped,
} from './types.js';

/** 保留天數的預設（裁示 1） */
export const DEFAULT_HISTORY_KEEP_DAYS = 30;
/** 每個檔案最多幾版的預設（裁示 1） */
export const DEFAULT_HISTORY_MAX_VERSIONS = 100;
/** 歸檔內容總容量上限的預設：1 GiB（裁示 1） */
export const DEFAULT_HISTORY_MAX_BYTES = 1024 ** 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** `restore()`、`readHistory()` 的錯誤 */
export class VaultHistoryError extends Error {
  readonly code: VaultHistoryErrorCode;
  readonly versionId: string;
  constructor(code: VaultHistoryErrorCode, versionId: string, message?: string) {
    super(message ?? historyErrorMessage(code, versionId));
    this.name = 'VaultHistoryError';
    this.code = code;
    this.versionId = versionId;
  }
}

function historyErrorMessage(code: VaultHistoryErrorCode, versionId: string): string {
  switch (code) {
    case 'unknown':
      return `歸檔裡沒有版本 ${versionId}`;
    case 'deleted':
      return `版本 ${versionId} 是刪除，沒有內容可以還原`;
    case 'binary':
      return `版本 ${versionId} 是二進位檔：內容不在歸檔，和現在的也不同`;
    case 'content-missing':
      return `版本 ${versionId} 的內容不在歸檔，或要覆寫的現有內容不在歸檔`;
    case 'stopped':
      return '同步已停止';
    case 'checkpoint-limit':
      return `命名檢查點已經 ${MAX_NAMED_CHECKPOINTS} 個：請先刪掉不要的再建立`;
    case 'checkpoint-unknown':
      return `沒有檢查點 ${versionId}`;
    case 'checkpoint-expired':
      return `還原之前的檢查點 ${versionId} 已經過期（超過保留天數），不能再復原那次還原`;
    case 'checkpoint-name':
      return '檢查點名稱不合格（空的、超過 100 字）或已經有同名的檢查點';
  }
}

/** 命名檢查點最多幾個（裁示補充 3）：超過時拒絕建立，不自動清掉任何一個 */
export const MAX_NAMED_CHECKPOINTS = 50;
/** 自動檢查點最多多久一個（裁示補充 1） */
export const AUTO_CHECKPOINT_INTERVAL_MS = 3_600_000;

export function isVaultHistoryError(error: unknown): error is VaultHistoryError {
  return error instanceof VaultHistoryError;
}

/** 歸檔裡的先後：版本時間，平手時看這台歸檔的順序（合併版本的時間等於較晚的父版本，歸檔一定在父版本之後） */
export interface HistoryOrder {
  at: number;
  /** 這台的歸檔序號（單調遞增） */
  n: number;
}

export function compareHistory(a: HistoryOrder, b: HistoryOrder): number {
  return a.at - b.at || a.n - b.n;
}

export interface ThinOptions {
  /** 保留天數（`Infinity`＝永久） */
  keepDays: number;
  /** 稀疏化後每個檔案最多幾版 */
  maxVersions: number;
  /** 把時間換成「當地牆上時間」要加的毫秒（決定小時與日期的界線）；預設 0（UTC） */
  offset?: (at: number) => number;
}

export interface Thinnable extends HistoryOrder {
  deleted: boolean;
}

export interface ThinResult<T> {
  /** 留下的（由舊到新） */
  keep: T[];
  drop: T[];
  /**
   * 因保留天數或版本數上限從**前面**清掉的版本裡最新的時間（沒有就省略）。有它表示更早的狀態已經不在歸檔；
   * 稀疏化在中間清掉的不算（那一段由留下的最新一版代表）。
   */
  cut?: number;
}

/**
 * 一個檔案的歸檔稀疏化（裁示 3）：
 * - 最新的一版一律留下（檔案目前的狀態）；只有最新的一版是刪除、而且超過保留天數時，整個檔案的歷史清掉。
 * - 1 小時內的全留；1 天內每個（當地）小時留最新的一版；之後到保留天數為止每個（當地）日期留最新的一版；更舊的清掉。
 *   刪除不佔區段：區段裡刪除之前的最後一版（有內容的）照留，刪除本身也留（之後沒有再出現內容時）。
 * - 稀疏化後超過 `maxVersions` 就從最舊的清。
 *
 * 「最新的一版」以 `(at, n)` 比。每個區段留下的一定是那個區段（小時或日期）最新的一版，所以同一份歸檔隔一陣子再做一次，
 * 結果和一次做到那個時間相同（不含版本數上限）。
 */
export function thinHistory<T extends Thinnable>(entries: readonly T[], now: number, options: ThinOptions): ThinResult<T> {
  const sorted = [...entries].sort(compareHistory);
  if (sorted.length === 0) return { keep: [], drop: [] };
  const offset = options.offset ?? (() => 0);
  const keepMs = options.keepDays * DAY_MS;
  const latest = sorted[sorted.length - 1]!;
  if (latest.deleted && now - latest.at >= keepMs) return { keep: [], drop: sorted };
  const keep: T[] = [];
  const drop: T[] = [];
  let cut: number | undefined;
  const hours = new Set<number>();
  const days = new Set<number>();
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const e = sorted[i]!;
    const age = now - e.at;
    const local = e.at + offset(e.at);
    const hour = Math.floor(local / HOUR_MS);
    const day = Math.floor(local / DAY_MS);
    let kept: boolean;
    if (e === latest || age < HOUR_MS) kept = true;
    else if (age < DAY_MS) kept = !hours.has(hour);
    else if (age < keepMs) kept = !days.has(day);
    else {
      kept = false;
      cut = Math.max(cut ?? -Infinity, e.at);
    }
    if (kept) {
      keep.push(e);
      // 刪除沒有內容，不代表那個區段的內容狀態：同一個區段裡刪除之前的最後一版照留（「最近刪除的檔案」還原得回來）
      if (!e.deleted) {
        hours.add(hour);
        days.add(day);
      }
    } else drop.push(e);
  }
  keep.reverse();
  const max = Math.max(1, Math.floor(options.maxVersions));
  if (keep.length > max) {
    const over = keep.splice(0, keep.length - max);
    for (const e of over) cut = Math.max(cut ?? -Infinity, e.at);
    drop.push(...over);
  }
  return cut === undefined ? { keep, drop } : { keep, drop, cut };
}

export interface Budgeted extends HistoryOrder {
  hash: string;
  /** 這一版的內容存在歸檔裡（以雜湊去重） */
  content: boolean;
}

/**
 * 歸檔內容超過總容量上限時要清掉哪些版本：從最舊的開始，每個檔案至少留最新的一版；只清有內容的
 * （沒有內容的版本清了也不省空間）。內容以雜湊去重：同一份內容的最後一個版本清掉時才算省下。
 */
export function overByteBudget<T extends Budgeted>(
  files: ReadonlyMap<string, readonly T[]>,
  sizeOf: (hash: string) => number,
  maxBytes: number,
): Array<{ fileId: string; entry: T }> {
  const refs = new Map<string, number>();
  for (const entries of files.values()) for (const e of entries) if (e.content) refs.set(e.hash, (refs.get(e.hash) ?? 0) + 1);
  let total = 0;
  for (const hash of refs.keys()) total += sizeOf(hash);
  if (total <= maxBytes) return [];
  const candidates: Array<{ fileId: string; entry: T }> = [];
  for (const [fileId, entries] of files) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort(compareHistory);
    for (const entry of sorted.slice(0, -1)) if (entry.content) candidates.push({ fileId, entry });
  }
  candidates.sort((a, b) => compareHistory(a.entry, b.entry) || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  const out: Array<{ fileId: string; entry: T }> = [];
  for (const c of candidates) {
    if (total <= maxBytes) break;
    // 不計大小的內容（例如被其他東西留著）：清了也省不下
    if (sizeOf(c.entry.hash) === 0) continue;
    out.push(c);
    const left = refs.get(c.entry.hash)! - 1;
    if (left === 0) {
      refs.delete(c.entry.hash);
      total -= sizeOf(c.entry.hash);
    } else refs.set(c.entry.hash, left);
  }
  return out;
}

/** 歸檔裡的一個版本（協調器內部的形狀，`buildRestorePlan` 用） */
export interface ArchivedVersion extends Thinnable {
  versionId: string;
  path: string;
  device: string;
  label: string;
  hash: string;
  size: number;
  text: boolean;
  content: boolean;
  /** 內容拿不到時回報的原因（預設：文字檔 `content-missing`、二進位檔 `binary`）；例如輕量成員範圍外的檢查點項目是 `not-local` */
  unavailable?: VaultRestoreSkipped['reason'];
}

/** 一個檔案的歸檔 */
export interface ArchivedFile {
  fileId: string;
  /** 由舊到新 */
  entries: readonly ArchivedVersion[];
  /** 檔案建立的時間（歸檔收到了它的第一個版本才有）：比它早的時間點，檔案確定不存在 */
  born?: number;
}

/** 一個檔案現在的狀態（協調器從版本圖與磁碟判斷） */
export type CurrentFile =
  /** 在磁碟上（同步中）。`text`／`size`：現在這一版的（v0.50；沒給時從歸檔裡找那一版） */
  | { state: 'live'; path: string; hash: string; versionId: string; text?: boolean; size?: number }
  /** 還在（有沒刪除的版本頭），但內容不在這台：被排除、輕量成員範圍外、內容還沒到 */
  | { state: 'not-local'; path: string; reason: 'excluded' | 'not-local' }
  /** 刪除了，或這台已經不認得 */
  | { state: 'gone' };

/** 檔案在時間 T 的狀態：`known: false`＝歸檔沒涵蓋；`entry` 是 null＝那時不存在 */
export function fileStateAt(file: ArchivedFile, at: number): { known: false } | { known: true; entry: ArchivedVersion | null } {
  let found: ArchivedVersion | undefined;
  for (const e of file.entries) {
    if (e.at > at) break;
    found = e;
  }
  if (found) return { known: true, entry: found.deleted ? null : found };
  if (file.born !== undefined && at < file.born) return { known: true, entry: null };
  return { known: false };
}

export interface RestorePlanOptions {
  /** 刪掉 T 之後才建立的檔案；預設 false（不刪） */
  removeCreatedAfter?: boolean;
  /**
   * 連 T 之後建立的**二進位檔**也刪（預設 false；只在 `removeCreatedAfter` 打開時有效，v0.50 裁示 1 乙）：歸檔沒有二進位內容，
   * 這些刪除標 `irreversible: true`、救不回來，預覽附上總大小（`irreversibleBytes`）。
   */
  removeCreatedBinaries?: boolean;
  /** 只看這些路徑（T 時的路徑或現在的路徑符合其一就算）；省略＝全部 */
  include?: (path: string) => boolean;
  /** 同步排除範圍 */
  excluded?: (path: string) => boolean;
  /** 這份內容（雜湊）在歸檔裡 */
  archived: (hash: string) => boolean;
  /** 預覽產生的時間 */
  now: number;
  /** 檔案在 T 時的狀態；預設 `fileStateAt(file, at)`（只看歸檔）。協調器從檢查點開始推算時給 */
  stateOf?: (file: ArchivedFile) => ReturnType<typeof fileStateAt>;
}

function itemOf(fileId: string, e: ArchivedVersion, from?: string): VaultRestoreItem {
  return { fileId, path: e.path, ...(from !== undefined ? { from } : {}), versionId: e.versionId, hash: e.hash, size: e.size, text: e.text, at: e.at };
}

const byPath = (a: { path: string; fileId: string }, b: { path: string; fileId: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0;

/** 空的預覽（`addToRestorePlan` 逐檔加入、`finishRestorePlan` 收尾；協調器逐檔串流時用） */
export function emptyRestorePlan(at: number, now: number): VaultRestorePlan {
  return { at, createdAt: now, revert: [], undelete: [], remove: [], keep: [], unrestorable: [], irreversibleBytes: 0 };
}

/** 一個檔案加入預覽時需要的判斷（`buildRestorePlan` 從 `RestorePlanOptions` 與歸檔算；協調器逐檔算） */
export interface RestoreFileContext {
  removeCreatedAfter?: boolean;
  removeCreatedBinaries?: boolean;
  include?: (path: string) => boolean;
  excluded?: (path: string) => boolean;
  /** 現在的內容（`current` 的雜湊）在歸檔裡：覆寫或刪了找得回來 */
  curArchived: boolean;
  /** T 時那一版的內容在歸檔裡 */
  thenArchived: boolean;
  /** 現在這一版的大小、是不是文字檔、時間（`current` 沒給時） */
  curVersion?: { size: number; text: boolean; at: number };
}

/**
 * 一個檔案加入預覽（裁示 6）。每個檔案取 `at ≤ T` 的最後一版（`state`）：
 * - T 時存在、現在也在：內容或路徑不同 → 改回（內容要拿得到：歸檔裡有，或和現在相同；要覆寫的現有內容也要在歸檔裡，覆寫了才找得回來）。
 * - T 時存在、現在刪了 → 復原（內容要在歸檔裡）。
 * - T 時不存在（確定）、現在在 → `removeCreatedAfter` 才刪（現有內容要在歸檔裡，刪了才找得回來；二進位檔只有
 *   `removeCreatedBinaries` 打開時刪，標 `irreversible`）。
 * - 歸檔沒涵蓋 T 時的狀態、現在在 → 無法還原（`out-of-range`）。
 */
export function addToRestorePlan(plan: VaultRestorePlan, fileId: string, state: ReturnType<typeof fileStateAt>, cur: CurrentFile, ctx: RestoreFileContext): void {
  const excluded = ctx.excluded ?? (() => false);
  const skip = (path: string, reason: VaultRestoreSkipped['reason'], versionId?: string) =>
    plan.unrestorable.push({ fileId, path, reason, ...(versionId !== undefined ? { versionId } : {}) });
  const curPath = cur.state === 'gone' ? undefined : cur.path;
  const thenPath = state.known && state.entry ? state.entry.path : undefined;
  if (ctx.include && !(thenPath !== undefined && ctx.include(thenPath)) && !(curPath !== undefined && ctx.include(curPath))) return;
  if (!state.known) {
    if (cur.state !== 'gone') skip(cur.path, 'out-of-range');
    return;
  }
  const e = state.entry;
  if (!e) {
    // T 時不存在：現在在的是之後才建立（或刪了又回來）的
    if (cur.state !== 'live') return;
    const size = cur.size ?? ctx.curVersion?.size ?? 0;
    const text = cur.text ?? ctx.curVersion?.text ?? true;
    const item: VaultRestoreItem = { fileId, path: cur.path, from: cur.path, versionId: cur.versionId, hash: cur.hash, size, text, at: ctx.curVersion?.at ?? plan.at };
    if (!ctx.removeCreatedAfter) {
      // 留著（SDK ADR 0070）：只給預覽看得到；排除的不列
      if (!excluded(cur.path)) (plan.keep ??= []).push(item);
      return;
    }
    if (excluded(cur.path)) skip(cur.path, 'excluded');
    else if (ctx.curArchived) plan.remove.push(item);
    else if (text) skip(cur.path, 'content-missing', cur.versionId);
    else if (ctx.removeCreatedBinaries) {
      plan.remove.push({ ...item, irreversible: true });
      plan.irreversibleBytes += size;
    } else skip(cur.path, 'binary', cur.versionId);
    return;
  }
  if (excluded(e.path)) {
    skip(e.path, 'excluded', e.versionId);
    return;
  }
  if (cur.state === 'not-local') {
    skip(e.path, cur.reason, e.versionId);
    return;
  }
  const missing = (): VaultRestoreSkipped['reason'] => e.unavailable ?? (e.text ? 'content-missing' : 'binary');
  if (cur.state === 'live') {
    if (cur.path === e.path && cur.hash === e.hash) return;
    if (cur.hash !== e.hash) {
      if (!e.content || !ctx.thenArchived) {
        skip(e.path, missing(), e.versionId);
        return;
      }
      if (!ctx.curArchived) {
        skip(e.path, 'content-missing', e.versionId);
        return;
      }
    }
    plan.revert.push(itemOf(fileId, e, cur.path));
    return;
  }
  if (!e.content || !ctx.thenArchived) skip(e.path, missing(), e.versionId);
  else plan.undelete.push(itemOf(fileId, e));
}

/** 預覽收尾：每一類依路徑排序 */
export function finishRestorePlan(plan: VaultRestorePlan): VaultRestorePlan {
  plan.revert.sort(byPath);
  plan.undelete.sort(byPath);
  plan.remove.sort(byPath);
  plan.keep?.sort(byPath);
  plan.unrestorable.sort(byPath);
  return plan;
}

/**
 * 整個 Vault 回到時間 T 的預覽（裁示 6）：每個檔案照 `addToRestorePlan` 判斷（見那裡的規則）。
 */
export function buildRestorePlan(at: number, files: Iterable<ArchivedFile>, current: (fileId: string) => CurrentFile, options: RestorePlanOptions): VaultRestorePlan {
  const plan = emptyRestorePlan(at, options.now);
  const stateOf = options.stateOf ?? ((file: ArchivedFile) => fileStateAt(file, at));
  for (const file of files) {
    const state = stateOf(file);
    const cur = current(file.fileId);
    const now = cur.state === 'live' ? file.entries.find((x) => x.versionId === cur.versionId) : undefined;
    const e = state.known ? state.entry : null;
    addToRestorePlan(plan, file.fileId, state, cur, {
      ...(options.removeCreatedAfter !== undefined ? { removeCreatedAfter: options.removeCreatedAfter } : {}),
      ...(options.removeCreatedBinaries !== undefined ? { removeCreatedBinaries: options.removeCreatedBinaries } : {}),
      ...(options.include ? { include: options.include } : {}),
      ...(options.excluded ? { excluded: options.excluded } : {}),
      curArchived: cur.state === 'live' && options.archived(cur.hash),
      thenArchived: e !== null && options.archived(e.hash),
      ...(now ? { curVersion: { size: now.size, text: now.text, at: now.at } } : {}),
    });
  }
  return finishRestorePlan(plan);
}

// ───────────────────────────── 檢查點的清單（裁示補充 1，參考 git 的 tree） ─────────────────────────────

/** 檢查點清單裡的一個檔案（fileId → 這一筆） */
export interface CheckpointFile {
  path: string;
  versionId: string;
  hash: string;
  size: number;
  text: boolean;
  /** 內容在這台（輕量成員範圍外的是 false：只有版本資訊，不能從這個檢查點還原） */
  local: boolean;
}

/** fileId → 檔案 */
export type CheckpointManifest = ReadonlyMap<string, CheckpointFile>;

/** 編碼後的清單：完整的（沒有 `d`）或相對於前一個檢查點的差異（`s`＝新增或改了的、`d`＝不在了的 fileId） */
export interface EncodedManifest {
  /** `[fileId, 路徑或 [和前一列相同的前綴長度, 其餘], versionId, hash, size, flags]`，依路徑排序 */
  s: Array<[string, string | [number, string], string, string, number, number]>;
  d?: string[];
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/** 小寫 hex 的 id／雜湊改成 base64url（短 1/3）；不是 hex 的原樣、前面加 `~` */
function packId(id: string): string {
  return HEX.test(id) ? base64urlnopad.encode(hexToBytes(id)) : `~${id}`;
}

function unpackId(s: string): string {
  return s.startsWith('~') ? s.slice(1) : bytesToHex(base64urlnopad.decode(s));
}

function sharedPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  // 不要切在 UTF-16 代理對中間
  if (i > 0 && i < a.length && a.charCodeAt(i - 1) >= 0xd800 && a.charCodeAt(i - 1) <= 0xdbff) i -= 1;
  return i;
}

function encodeRows(files: Iterable<[string, CheckpointFile]>): EncodedManifest['s'] {
  const sorted = [...files].sort(([fa, a], [fb, b]) => (a.path < b.path ? -1 : a.path > b.path ? 1 : fa < fb ? -1 : fa > fb ? 1 : 0));
  const rows: EncodedManifest['s'] = [];
  let prev = '';
  for (const [fileId, f] of sorted) {
    const k = sharedPrefix(prev, f.path);
    rows.push([packId(fileId), k >= 3 ? [k, f.path.slice(k)] : f.path, packId(f.versionId), packId(f.hash), f.size, (f.text ? 1 : 0) | (f.local ? 0 : 2)]);
    prev = f.path;
  }
  return rows;
}

function decodeRows(rows: EncodedManifest['s'], into: Map<string, CheckpointFile>): void {
  let prev = '';
  for (const [fid, p, vid, hash, size, flags] of rows) {
    const path = typeof p === 'string' ? p : prev.slice(0, p[0]) + p[1];
    prev = path;
    into.set(unpackId(fid), { path, versionId: unpackId(vid), hash: unpackId(hash), size, text: (flags & 1) === 1, local: (flags & 2) === 0 });
  }
}

const sameFile = (a: CheckpointFile, b: CheckpointFile) =>
  a.path === b.path && a.versionId === b.versionId && a.hash === b.hash && a.size === b.size && a.text === b.text && a.local === b.local;

/** 完整的清單 */
export function encodeManifest(manifest: CheckpointManifest): EncodedManifest {
  return { s: encodeRows(manifest) };
}

/** `next` 相對於 `prev` 的差異（沒有差異時 `s`、`d` 都是空的） */
export function diffManifest(prev: CheckpointManifest, next: CheckpointManifest): EncodedManifest {
  const changed: Array<[string, CheckpointFile]> = [];
  for (const [id, f] of next) {
    const old = prev.get(id);
    if (!old || !sameFile(old, f)) changed.push([id, f]);
  }
  const removed = [...prev.keys()].filter((id) => !next.has(id)).sort();
  return { s: encodeRows(changed), d: removed.map(packId) };
}

/** 差異是空的（兩個清單相同） */
export function isEmptyDiff(diff: EncodedManifest): boolean {
  return diff.s.length === 0 && (diff.d?.length ?? 0) === 0;
}

/** 解出清單：完整的直接解；差異套在 `base` 上（`base` 不會被改） */
export function decodeManifest(encoded: EncodedManifest, base?: CheckpointManifest): Map<string, CheckpointFile> {
  const out = new Map<string, CheckpointFile>(encoded.d !== undefined && base ? base : []);
  for (const id of encoded.d ?? []) out.delete(unpackId(id));
  decodeRows(encoded.s, out);
  return out;
}
