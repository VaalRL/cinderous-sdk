// 版本圖與確定性合併（SDK ADR 0025 §2、§4）：純函式，不碰 I/O。
//
// 每個檔案有一張版本圖（DAG）。目前的「版本頭」超過一個＝有並發修改，要合併。
// 合併是**確定性**的：同一組版本頭，每台裝置算出同一個結果、同一個 id——
// 兩台各自合併也不會越合越多，收到對方的合併版本時就是「已經有了」。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { commonLinesBase, merge3, resolveTaskCheckboxConflict } from '../merge3.js';
import { isMarkdownPath, mergeWithConflictCallouts } from './conflict-callout.js';
import type { VaultConflictKind, VaultVersion } from './types.js';

const encoder = new TextEncoder();

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** 由內容決定的 id（32 位 hex）：兩台裝置算同一件事會得到同一個 id。 */
export function deterministicId(...parts: string[]): string {
  return sha256Hex(encoder.encode(parts.join('\u0000'))).slice(0, 32);
}

const CALLOUT_ID_TAG = 'cinder-callout-v1';

/**
 * 支援衝突 callout 的寫入端產生的版本 id（SDK ADR 0046）：前 24 位隨機，後 8 位是前 24 位的雜湊。
 * 能力記在**版本資料本身**（id 會原樣經過舊版裝置的儲存與轉送，新增欄位則會被舊版的 `parseVersion` 丟掉），
 * 每台裝置看同一個版本得到同一個答案。舊版的隨機 id 巧合符合的機率是 2^-32。
 */
export function markCalloutCapableId(id: string): string {
  const head = id.slice(0, 24);
  return head + deterministicId(CALLOUT_ID_TAG, head).slice(0, 8);
}

/** 這個 id 是不是支援衝突 callout 的寫入端產生的（只看 id；合併版本請用 {@link supportsConflictCallouts}） */
export function isCalloutCapableId(id: string): boolean {
  return id.length === 32 && id.slice(24) === deterministicId(CALLOUT_ID_TAG, id.slice(0, 24)).slice(0, 8);
}

/**
 * 這個版本能不能參與 callout 模式的合併（SDK ADR 0046）：非合併版本看 id 的標記；合併版本（兩個以上父版本）
 * ＝所有父版本都支援。`cache` 存已算過的結果（協調器在加入版本時就算好、持久化，之後修剪祖先也不會改變答案）。
 * 找不到的版本當作不支援（保守：退回衝突副本，不會遺失資料）。
 */
export function supportsConflictCallouts(nodes: NodeMap, id: string, cache: Record<string, boolean> = {}): boolean {
  const known = cache[id];
  if (known !== undefined) return known;
  const node = nodes[id];
  if (!node) return false;
  let result: boolean;
  if (!isMergeVersion(node)) result = isCalloutCapableId(id);
  else {
    cache[id] = false; // 防環（正常的版本圖沒有環）
    result = node.parents.every((p) => supportsConflictCallouts(nodes, p, cache));
  }
  cache[id] = result;
  return result;
}

const MERGE_RULES_ID_TAG = 'cinder-md-rules-v1';

/**
 * 名單能力宣告（SDK ADR 0035 §G9）裡表示「這台支援 Markdown 合併規則」的鍵（SDK ADR 0059）。應用在**名單上所有成員**都宣告了
 * 之後才打開協調器的 `mergeRules`（`membership.allDeclare(MERGE_RULES_CAPABILITY)`）；合併時再由版本資料（id 的標記）決定，每台一致。
 */
export const MERGE_RULES_CAPABILITY = 'mdMergeRules';

/**
 * 支援 Markdown 合併規則（SDK ADR 0059：同路徑新建的文字檔以空檔為祖先合併、任務勾選框自動合併）的寫入端產生的版本 id：
 * 第 17–24 位是前 16 位的雜湊。與 callout 的標記（最後 8 位，{@link markCalloutCapableId}）各佔不同位置，可以同時帶；
 * 兩個都要時先標這個、再標 callout（callout 的標記涵蓋前 24 位）。舊版的隨機 id 巧合符合的機率是 2^-32。
 */
export function markMergeRulesId(id: string): string {
  const head = id.slice(0, 16);
  return head + deterministicId(MERGE_RULES_ID_TAG, head).slice(0, 8) + id.slice(24, 32);
}

/** 這個 id 是不是支援 Markdown 合併規則的寫入端產生的（只看 id；合併版本請用 {@link supportsMergeRules}） */
export function isMergeRulesId(id: string): boolean {
  return id.length === 32 && id.slice(16, 24) === deterministicId(MERGE_RULES_ID_TAG, id.slice(0, 16)).slice(0, 8);
}

/**
 * 這個版本能不能參與「Markdown 合併規則」模式的合併（SDK ADR 0059）：與 {@link supportsConflictCallouts} 同一個推導——
 * 非合併版本看 id 的標記；合併版本＝所有父版本都支援；找不到的版本當作不支援（退回舊規則）。
 */
export function supportsMergeRules(nodes: NodeMap, id: string, cache: Record<string, boolean> = {}): boolean {
  const known = cache[id];
  if (known !== undefined) return known;
  const node = nodes[id];
  if (!node) return false;
  let result: boolean;
  if (!isMergeVersion(node)) result = isMergeRulesId(id);
  else {
    cache[id] = false;
    result = node.parents.every((p) => supportsMergeRules(nodes, p, cache));
  }
  cache[id] = result;
  return result;
}

const CALLOUT_BREAK_ID_TAG = 'cinder-callout-break-v1';

/**
 * 名單能力宣告（SDK ADR 0035 §G9）裡表示「這台支援衝突 callout 後空一行的格式」的鍵（SDK ADR 0087）。應用在**名單上所有成員**都宣告了
 * 之後才打開協調器的 `calloutBreak`（`membership.allDeclare(CALLOUT_BREAK_CAPABILITY)`）；合併時再由版本資料（id 的標記）決定，每台一致。
 */
export const CALLOUT_BREAK_CAPABILITY = 'calloutBreak';

/**
 * 支援「衝突 callout 後空一行」（SDK ADR 0087）的寫入端產生的版本 id：第 9–16 位是前 8 位的雜湊。與合併規則（第 17–24 位）、
 * callout（最後 8 位）的標記各佔不同位置，可以同時帶；三個都要時依序標這個、合併規則、callout（後者涵蓋前者的位置）。
 * 舊版的隨機 id 巧合符合的機率是 2^-32。
 */
export function markCalloutBreakId(id: string): string {
  const head = id.slice(0, 8);
  return head + deterministicId(CALLOUT_BREAK_ID_TAG, head).slice(0, 8) + id.slice(16, 32);
}

/** 這個 id 是不是支援「衝突 callout 後空一行」的寫入端產生的（只看 id；合併版本請用 {@link supportsCalloutBreak}） */
export function isCalloutBreakId(id: string): boolean {
  return id.length === 32 && id.slice(8, 16) === deterministicId(CALLOUT_BREAK_ID_TAG, id.slice(0, 8)).slice(0, 8);
}

/**
 * 這個版本能不能參與「callout 後空一行」格式的合併（SDK ADR 0087）：與 {@link supportsConflictCallouts} 同一個推導——
 * 非合併版本看 id 的標記；合併版本＝所有父版本都支援；找不到的版本當作不支援（舊格式）。
 */
export function supportsCalloutBreak(nodes: NodeMap, id: string, cache: Record<string, boolean> = {}): boolean {
  const known = cache[id];
  if (known !== undefined) return known;
  const node = nodes[id];
  if (!node) return false;
  let result: boolean;
  if (!isMergeVersion(node)) result = isCalloutBreakId(id);
  else {
    cache[id] = false;
    result = node.parents.every((p) => supportsCalloutBreak(nodes, p, cache));
  }
  cache[id] = result;
  return result;
}

/**
 * 這些版本與它們在 `nodes` 裡的所有祖先，父版本在前（SDK ADR 0088：補送給不認得這個檔案的裝置，對方依序併入、不必等）。
 * 不在 `nodes` 裡的（修剪掉的）略過。
 */
export function ancestryOf(nodes: NodeMap, ids: readonly string[]): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const visit = (start: string) => {
    const stack: Array<[string, boolean]> = [[start, false]];
    while (stack.length > 0) {
      const [id, expanded] = stack.pop()!;
      if (done.has(id)) continue;
      const node = nodes[id];
      if (!node) continue;
      if (expanded) {
        done.add(id);
        out.push(id);
        continue;
      }
      stack.push([id, true]);
      for (const p of node.parents) if (!done.has(p)) stack.push([p, false]);
    }
  };
  for (const id of ids) visit(id);
  return out;
}

/** 版本先後：`(at, device, id)`，全序且每台裝置一致。 */
export function compareVersions(a: Pick<VaultVersion, 'at' | 'device' | 'id'>, b: Pick<VaultVersion, 'at' | 'device' | 'id'>): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type NodeMap = Readonly<Record<string, VaultVersion>>;

/** `id` 與它所有已知的祖先（含自己）。缺少的祖先（被修剪或還沒收到）就停在那裡。 */
export function ancestorsOf(nodes: NodeMap, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    const node = nodes[cur];
    if (!node) continue;
    seen.add(cur);
    for (const p of node.parents) if (!seen.has(p)) stack.push(p);
  }
  return seen;
}

/** `a` 是不是 `b` 的祖先（或就是 `b`）。 */
export function isAncestor(nodes: NodeMap, a: string, b: string): boolean {
  if (a === b) return true;
  return ancestorsOf(nodes, b).has(a);
}

/** 合併版本：有兩個以上父版本的版本（本機編輯、改名、衝突副本最多只有一個父版本）。 */
export function isMergeVersion(node: VaultVersion): boolean {
  return node.parents.length > 1;
}

/** 合併版本底下真正的修改（把合併版本一路攤平到非合併版本，取最新的那些）。 */
function leavesOf(nodes: NodeMap, id: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(id);
  if (cached) return cached;
  const node = nodes[id];
  let out: Set<string>;
  if (!node || !isMergeVersion(node)) out = new Set([id]);
  else {
    out = new Set();
    for (const p of node.parents) for (const leaf of leavesOf(nodes, p, cache)) out.add(leaf);
  }
  cache.set(id, out);
  return out;
}

/**
 * 版本頭：沒有被任何已知版本當成父版本的版本，依 `(at, device, id)` 排序。
 *
 * 另加一條「涵蓋」規則，避免合併越合越多：幾台裝置在訊息還在路上時，會各自合併手上不同的版本頭組合
 * （例如 {a,b}、{a,c}），合併版本之間彼此不是祖先，不處理的話會一直「合併的合併」下去。
 * 所以：一個合併版本 X，若另一個版本頭 Y 已經包含 X 底下所有真正的修改（X 的葉子都是 Y 的祖先），
 * X 就不算版本頭。兩個合併版本互相涵蓋（同一組修改、不同的合併順序）時，留 id 較小的那個——
 * 兩者都保留了全部修改（衝突內容各自在副本裡），所以選哪一個都不會遺失資料，重要的是每台選得一樣。
 */
export function computeHeads(nodes: NodeMap): string[] {
  const referenced = new Set<string>();
  for (const node of Object.values(nodes)) for (const p of node.parents) referenced.add(p);
  const candidates = Object.values(nodes).filter((n) => !referenced.has(n.id));
  let heads = candidates;
  if (candidates.length > 1 && candidates.some(isMergeVersion)) {
    const leafCache = new Map<string, Set<string>>();
    const ancCache = new Map<string, Set<string>>();
    const anc = (id: string) => {
      let set = ancCache.get(id);
      if (!set) ancCache.set(id, (set = ancestorsOf(nodes, id)));
      return set;
    };
    const covers = (y: string, x: string) => {
      const ay = anc(y);
      for (const leaf of leavesOf(nodes, x, leafCache)) if (!ay.has(leaf)) return false;
      return true;
    };
    heads = candidates.filter((x) => {
      if (!isMergeVersion(x)) return true;
      for (const y of candidates) {
        if (y.id === x.id || !covers(y.id, x.id)) continue;
        if (!covers(x.id, y.id) || y.id < x.id) return false;
      }
      return true;
    });
  }
  return heads.sort(compareVersions).map((n) => n.id);
}

/**
 * 最佳共同祖先：兩邊祖先的交集裡，不是其他共同祖先之祖先的那些；有好幾個時取 `(at, device, id)` 最大的。
 * 沒有共同祖先回 `null`（例如祖先被修剪了）。
 */
export function bestCommonAncestor(nodes: NodeMap, a: ReadonlySet<string>, b: ReadonlySet<string>): string | null {
  const common: string[] = [];
  for (const id of a) if (b.has(id)) common.push(id);
  if (common.length === 0) return null;
  const dominated = new Set<string>();
  for (const id of common) {
    for (const p of nodes[id]?.parents ?? []) for (const anc of ancestorsOf(nodes, p)) dominated.add(anc);
  }
  const maximal = common.filter((id) => !dominated.has(id)).map((id) => nodes[id]!);
  maximal.sort(compareVersions);
  return maximal[maximal.length - 1]?.id ?? null;
}

/** 合併的一邊是由哪些版本頭組成的（衝突 callout 標示作者用） */
interface Origin {
  key: string;
  label: string;
  device: string;
  at: number;
  bytes: Uint8Array | undefined;
}

/** 合併時的一邊：一個版本頭，或幾個版本頭合併到一半的結果。 */
interface Side {
  origins: Origin[];
  key: string;
  path: string;
  pathAt: number;
  deleted: boolean;
  hash: string;
  size: number;
  text: boolean;
  p2p: boolean;
  at: number;
  device: string;
  label: string;
  bytes: Uint8Array | undefined;
}

function sideOf(node: VaultVersion, bytes: Uint8Array | undefined): Side {
  return {
    origins: [{ key: node.id, label: node.label, device: node.device, at: node.at, bytes }],
    key: node.id,
    path: node.path,
    pathAt: node.pathAt,
    deleted: node.deleted,
    hash: node.hash,
    size: node.size,
    text: node.text,
    p2p: node.p2p,
    at: node.at,
    device: node.device,
    label: node.label,
    bytes,
  };
}

function laterOf(a: Side, b: Side): [winner: Side, loser: Side] {
  const cmp = compareVersions({ at: a.at, device: a.device, id: a.key }, { at: b.at, device: b.device, id: b.key });
  return cmp >= 0 ? [a, b] : [b, a];
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

function asText(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** 合併產生的衝突副本：另一方的**完整**內容，存成新檔案。 */
export interface ConflictCopy {
  /** 被放進副本的那一方是哪些版本（排序後以 + 連接）；同一方在不同的合併裡產生的副本以它去重 */
  source: string;
  bytes: Uint8Array;
  hash: string;
  size: number;
  text: boolean;
  label: string;
  device: string;
  at: number;
}

export interface MergeNote {
  kind: VaultConflictKind;
  otherPath?: string;
  copyIndex?: number;
  /** 衝突就地放進了這些 callout（SDK ADR 0046；沒有衝突副本） */
  callouts?: string[];
}

export interface PlanMergeOptions {
  /**
   * Markdown 的同行衝突改用就地 callout（SDK ADR 0046）。協調器只在**所有**版本頭都支援時打開
   * （{@link supportsConflictCallouts}）——由版本資料決定，每台裝置一致。
   */
  callouts?: boolean;
  /**
   * Markdown 合併規則（SDK ADR 0059）。協調器只在**所有**版本頭都支援時打開（{@link supportsMergeRules}）：
   * - 兩邊都是文字檔、找不到共同祖先（例如兩台各自新建的同路徑檔案被收成同一個檔案）：以空檔為祖先三方合併
   *   （{@link commonLinesBase} 精簡衝突），合不了才退回 callout／衝突副本；
   * - 衝突區塊兩邊只差在任務勾選狀態：自動合併（{@link resolveTaskCheckboxConflict}）。
   */
  mergeRules?: boolean;
  /**
   * 衝突 callout 後空一行的格式（SDK ADR 0087）。協調器只在**所有**版本頭都支援時打開（{@link supportsCalloutBreak}）；
   * 沒開時 callout 與 v0.60 位元組相同。只在 `callouts` 打開時有作用。
   */
  calloutBreak?: boolean;
}

export interface MergePlan {
  /** 合併後的版本（尚未指定 id 與 parents 以外的欄位都已確定） */
  version: VaultVersion;
  /** 合併後的內容（刪除時為 undefined） */
  bytes: Uint8Array | undefined;
  copies: ConflictCopy[];
  notes: MergeNote[];
}

/**
 * 合併需要哪些內容：每個（未刪除的）版本頭，以及每一步的共同祖先（只有文字檔需要祖先的內容）。
 * 版本頭的順序就是合併的順序（`computeHeads` 已排好）。
 */
export function mergeInputs(nodes: NodeMap, heads: readonly string[]): { bases: (string | null)[] } {
  const bases: (string | null)[] = [];
  let acc = ancestorsOf(nodes, heads[0]!);
  for (let i = 1; i < heads.length; i += 1) {
    const anc = ancestorsOf(nodes, heads[i]!);
    bases.push(bestCommonAncestor(nodes, acc, anc));
    acc = new Set([...acc, ...anc]);
  }
  return { bases };
}

/**
 * 把多個版本頭確定性地合併成一個版本。`content(hash)` 回傳已知的內容（找不到回 undefined）。
 *
 * 規則（每兩邊一次，以共同祖先 O 為準；逐項三方）：
 * - 刪除：兩邊都刪 → 刪；一邊刪、另一邊相對 O 內容沒動（只改名也算沒動）→ 刪；
 *   另一邊改了內容 → **保留修改**，記 `delete-modify`。
 * - 路徑：只有一邊改 → 取改的；兩邊改得不同 → 取較晚的，記 `rename-rename`（內容不受影響）。
 * - 內容：只有一邊改 → 取改的；兩邊都改 → 文字檔且有 O 的內容就 `merge3`；
 *   合不起來（或二進位、缺 O）→ 較晚的一方留在主檔，另一方的完整內容成為衝突副本。
 *
 * 內容只在真的用到時才需要（文字合併、衝突副本、被選為結果的那一方）；需要卻拿不到時丟 `MissingContentError`。
 * 只貢獻路徑（內容沒變）的一方不需要內容。
 */
export function planMerge(
  nodes: NodeMap,
  heads: readonly string[],
  content: (hash: string) => Uint8Array | undefined,
  options: PlanMergeOptions = {},
): MergePlan {
  if (heads.length < 2) throw new Error('planMerge：至少要兩個版本頭');
  const { bases } = mergeInputs(nodes, heads);
  const copies: ConflictCopy[] = [];
  const notes: MergeNote[] = [];
  const headNode = (id: string) => {
    const node = nodes[id];
    if (!node) throw new Error(`planMerge：未知的版本 ${id}`);
    const bytes = node.deleted ? undefined : content(node.hash);
    return sideOf(node, bytes);
  };

  let acc = headNode(heads[0]!);
  for (let i = 1; i < heads.length; i += 1) {
    const next = headNode(heads[i]!);
    const baseId = bases[i - 1] ?? null;
    const base = baseId ? nodes[baseId]! : null;
    acc = mergeTwo(acc, next, base, base && !base.deleted && base.text ? content(base.hash) : undefined, copies, notes, options.callouts === true, options.mergeRules === true, options.calloutBreak === true);
  }

  // 合併結果的內容必須拿得到：否則會產生一個沒有任何裝置有內容的版本（例如收到的舊版本沒帶內容、
  // 它的後續版本還在路上）。等內容或後續版本到了再合併。
  if (!acc.deleted && !acc.bytes) throw new MissingContentError(acc.hash);
  const sortedHeads = [...heads].sort();
  const maxAt = Math.max(...heads.map((h) => nodes[h]!.at));
  const version: VaultVersion = {
    id: deterministicId('merge', ...sortedHeads, acc.deleted ? 'deleted' : acc.hash, acc.path),
    parents: sortedHeads,
    path: acc.path,
    pathAt: acc.pathAt,
    deleted: acc.deleted,
    hash: acc.deleted ? '' : acc.hash,
    size: acc.deleted ? 0 : acc.size,
    text: acc.text,
    at: maxAt,
    device: acc.device,
    label: acc.label,
    p2p: acc.deleted ? false : acc.p2p,
  };
  return { version, bytes: acc.deleted ? undefined : acc.bytes, copies, notes };
}

function mergeTwo(
  a: Side,
  b: Side,
  base: VaultVersion | null,
  baseBytes: Uint8Array | undefined,
  copies: ConflictCopy[],
  notes: MergeNote[],
  callouts: boolean,
  rules = false,
  calloutBreak = false,
): Side {
  const [winner] = laterOf(a, b);
  const key = [a.key, b.key].sort().join('+');
  const liveBase = base && !base.deleted ? base : null;

  if (a.deleted && b.deleted) return { ...winner, key };
  if (a.deleted !== b.deleted) {
    const del = a.deleted ? a : b;
    const live = a.deleted ? b : a;
    // 只改名（內容沒動）不算修改：刪除的人看過這份內容，刪掉不會遺失任何資料
    const untouched = liveBase !== null && live.hash === liveBase.hash;
    if (untouched) return { ...del, key };
    // 刪除的那邊沒看過這些內容修改：保留修改（絕不無聲丟掉別人的編輯）
    if (liveBase) notes.push({ kind: 'delete-modify' });
    return { ...live, key };
  }

  // 兩邊都活著：路徑與內容分開三方
  let path: Pick<Side, 'path' | 'pathAt'>;
  if (a.path === b.path) path = a.pathAt <= b.pathAt ? a : b;
  else if (liveBase && a.path === liveBase.path) path = b;
  else if (liveBase && b.path === liveBase.path) path = a;
  else {
    const [pw, pl] = laterOf(a, b);
    path = pw;
    notes.push({ kind: 'rename-rename', otherPath: pl.path });
  }

  let body: Pick<Side, 'hash' | 'size' | 'text' | 'p2p' | 'bytes' | 'at' | 'device' | 'label'>;
  if (a.hash === b.hash) body = winner;
  else if (liveBase && a.hash === liveBase.hash) body = b;
  else if (liveBase && b.hash === liveBase.hash) body = a;
  else {
    // Markdown 合併規則（SDK ADR 0059）：沒有共同祖先的兩個文字版本以「空檔」為祖先（精簡成兩邊共同的行）；
    // 只有在完全找不到共同祖先時才這樣做（祖先是刪除版本、或內容拿不到時不算，照舊）
    const virtual = rules && base === null && a.text && b.text ? virtualBase(a, b) : undefined;
    const mergeBase = virtual ? virtual.node : liveBase;
    const mergeBaseBytes = virtual ? virtual.bytes : baseBytes;
    const merged = tryTextMerge(a, b, mergeBase, mergeBaseBytes, rules);
    // 合不起來、其中一方是空檔（0 位元組）：採用有內容的一方，不產生衝突副本也不放 callout（SDK ADR 0048；空檔沒有內容會遺失）。
    // 只看內容大小，每台裝置一致
    const nonEmpty = merged ? null : a.size === 0 ? b : b.size === 0 ? a : null;
    const callout = merged || nonEmpty || !callouts || !isMarkdownPath(path.path) ? null : tryCalloutMerge(a, b, mergeBase, mergeBaseBytes, rules, calloutBreak);
    if (merged) {
      body = { ...winner, ...merged };
    } else if (nonEmpty) {
      body = nonEmpty;
    } else if (callout) {
      // 同一行衝突就地放進 callout（SDK ADR 0046）：每一個版本都在裡面，不另存衝突副本
      body = { ...winner, ...callout.body };
      notes.push({ kind: 'text', callouts: callout.ids });
    } else {
      const [w, l] = laterOf(a, b);
      body = w;
      if (!l.bytes) throw new MissingContentError(l.hash);
      copies.push({ source: l.key, bytes: l.bytes, hash: l.hash, size: l.size, text: l.text, label: l.label, device: l.device, at: l.at });
      notes.push({ kind: a.text && b.text ? 'text' : 'binary', copyIndex: copies.length - 1 });
    }
  }
  return { ...winner, ...body, path: path.path, pathAt: path.pathAt, deleted: false, key, origins: [...a.origins, ...b.origins] };
}

/** 合併需要某個版本頭的內容，但拿不到（大檔等 P2P、或內容還沒到） */
export class MissingContentError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super(`合併需要的內容還沒到：${hash}`);
    this.name = 'MissingContentError';
    this.hash = hash;
  }
}

function textOf(origin: Origin, cache: Map<Origin, string | null>): string | null {
  let text = cache.get(origin);
  if (text === undefined) {
    text = asText(origin.bytes);
    if (text !== null) text = text.replace(/\r\n/g, '\n');
    cache.set(origin, text);
  }
  return text;
}

/**
 * 衝突的這幾行是誰寫的：一邊只有一個版本頭就是它；好幾個版本頭合起來的，取內容裡含有這幾行（連續）的版本頭中最新的，
 * 都沒有就取這一邊最新的。只看版本資料與內容，每台裝置一致。
 */
function authorOf(side: Side, lines: readonly string[], cache: Map<Origin, string | null>): Pick<Origin, 'label' | 'device' | 'at'> {
  const latest = (list: Origin[]) =>
    list.reduce((best, o) => (compareVersions({ at: o.at, device: o.device, id: o.key }, { at: best.at, device: best.device, id: best.key }) > 0 ? o : best));
  let pool = side.origins;
  if (pool.length > 1) {
    const needle = `\n${lines.join('\n')}\n`;
    const containing = pool.filter((o) => {
      const text = textOf(o, cache);
      return text !== null && `\n${text}\n`.includes(needle);
    });
    if (containing.length > 0) pool = containing;
  }
  const o = latest(pool);
  return { label: o.label, device: o.device, at: o.at };
}

/** 文字合併有衝突時，改成就地 callout（SDK ADR 0046）；做不到回 null（退回衝突副本） */
function tryCalloutMerge(
  a: Side,
  b: Side,
  base: VaultVersion | null,
  baseBytes: Uint8Array | undefined,
  rules = false,
  calloutBreak = false,
): { body: Pick<Side, 'hash' | 'size' | 'text' | 'p2p' | 'bytes'>; ids: string[] } | null {
  if (!a.text || !b.text || !base || !base.text || !baseBytes || !a.bytes || !b.bytes) return null;
  const o = asText(baseBytes);
  const x = asText(a.bytes);
  const y = asText(b.bytes);
  if (o === null || x === null || y === null) return null;
  const cache = new Map<Origin, string | null>();
  const result = mergeWithConflictCallouts(
    o,
    x,
    y,
    (side, lines) => authorOf(side === 'local' ? a : b, lines, cache),
    { ...(rules ? { resolve: resolveTaskCheckboxConflict } : {}), ...(calloutBreak ? { calloutBreak: true } : {}) },
  );
  if (!result || result.callouts.length === 0) return null;
  const bytes = encoder.encode(result.text);
  return { body: { hash: sha256Hex(bytes), size: bytes.length, text: true, p2p: false, bytes }, ids: result.callouts };
}

/**
 * 沒有共同祖先的兩個文字版本的「空檔祖先」（SDK ADR 0059）：兩邊共同的行（{@link commonLinesBase}）。
 * 兩邊的內容都要在手上（否則丟 `MissingContentError`，等內容到）；不是合法 UTF-8 回 undefined（照舊）。
 */
function virtualBase(a: Side, b: Side): { node: VaultVersion; bytes: Uint8Array } | undefined {
  if (!a.bytes) throw new MissingContentError(a.hash);
  if (!b.bytes) throw new MissingContentError(b.hash);
  const x = asText(a.bytes);
  const y = asText(b.bytes);
  if (x === null || y === null) return undefined;
  const bytes = encoder.encode(commonLinesBase(x, y));
  const node: VaultVersion = { id: '', parents: [], path: a.path, pathAt: 0, deleted: false, hash: sha256Hex(bytes), size: bytes.length, text: true, at: 0, device: '', label: '', p2p: false };
  return { node, bytes };
}

function tryTextMerge(
  a: Side,
  b: Side,
  base: VaultVersion | null,
  baseBytes: Uint8Array | undefined,
  rules = false,
): Pick<Side, 'hash' | 'size' | 'text' | 'p2p' | 'bytes'> | null {
  if (!a.text || !b.text || !base || !base.text || !baseBytes) return null;
  if (!a.bytes) throw new MissingContentError(a.hash);
  if (!b.bytes) throw new MissingContentError(b.hash);
  const o = asText(baseBytes);
  const x = asText(a.bytes);
  const y = asText(b.bytes);
  if (o === null || x === null || y === null) return null;
  const result = merge3(o, x, y, rules ? { resolve: resolveTaskCheckboxConflict } : {});
  if (!result.clean) return null;
  const bytes = encoder.encode(result.merged);
  return { hash: sha256Hex(bytes), size: bytes.length, text: true, p2p: false, bytes };
}
