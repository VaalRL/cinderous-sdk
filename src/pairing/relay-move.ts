// 中繼搬家通知（SDK ADR 0052）：個人專屬中繼換了私人路徑（SDK ADR 0051）之後，把「舊網址 → 新網址」交給名單上的其他裝置。
//
// - 格式：與名單同步相同的 NIP-59 封裝（外層預設 kind 1060，`outerKind: 1059` 可選；內層 rumor kind 4363），每位**目前有效**的成員
//   各一顆（含自己——部署回報失敗但其實已上線時，這台也能從通知自我修正）。被移除的裝置不在收件人裡，收不到新網址。
// - 送出（`announceRelayMove`）：換路徑的裝置在**部署之前**送到舊路徑（還能寫）與其他共同的中繼，至少一座收下才部署；
//   部署成功後再送到新路徑與其他中繼。舊路徑在唯讀寬限期內讀得到，晚上線的裝置也收得到。
// - 收到（`NostrRosterSync` 的 `onRelayMove`）：寄件人必須是本機名單上的有效成員。
// - 採用（`planRelayMoves`）：只**替換**自己清單裡已經有的舊網址（不新增）；同一個舊網址取最新、而且新網址**真的連得上**
//   （`probe`，預設讀 NIP-11：部署失敗的新路徑在僅限車道的中繼上回 404）的那一則。所以部署失敗＝沒有任何裝置切換，
//   之後的新通知（重試或另一個新路徑）自然取代舊的；不需要另外的「取消」或「已生效」訊息。
// 本模組不碰連線池的執行期（`./pairing` 子路徑零執行期相依）：送出時由呼叫端給 `connect`（例如 `new RelayPool(...)`）。
import type { Event } from 'nostr-tools/core';

import type { NostrEvent } from '../protocol/event.js';
import { openWrap, sealAndWrap } from '../protocol/nip59.js';
import type { NostrSigner } from '../protocol/signer.js';
import type { PublishResult, RelayStatus, RelayTransport } from '../relay-pool.js';
import type { VaultMembership } from './roster.js';
import type { RosterOuterKind } from './roster-sync.js';

/** 中繼搬家通知的內層 rumor kind（名單 4361、裝置宣告簽章 4362 之後） */
export const VAULT_RELAY_MOVE_KIND = 4363;
/** 通知的 NIP-40 保存期：最長唯讀寬限期（30 天）多一天。中繼會再以自己的上限截短 */
export const DEFAULT_RELAY_MOVE_TTL_SECONDS = 31 * 86_400;
/** 網址最長幾個字（中繼網址＋26 字私人路徑約 80 字） */
export const RELAY_MOVE_MAX_URL_LENGTH = 512;
/** 送出前等連線開起來最多多久（毫秒） */
export const DEFAULT_RELAY_MOVE_CONNECT_MS = 10_000;

const FILE_WRAP_KIND = 1060;
const GIFT_WRAP_KIND = 1059;

/** 一則搬家通知 */
export interface RelayMove {
  /** 舊網址（收方清單裡要有它才會替換） */
  readonly from: string;
  /** 新網址 */
  readonly to: string;
  /** 送出的時間（毫秒）：同一個舊網址取最新的 */
  readonly at: number;
  /** 送出的裝置（名單上的 deviceId）；只用來顯示 */
  readonly device?: string;
}

/** 收到、而且寄件人已驗證是名單成員的通知 */
export interface ReceivedRelayMove extends RelayMove {
  /** 寄件人（seal 簽章者）的公鑰 */
  readonly sender: string;
}

/** `wss://`／`ws://`、有主機、不含帳密與 fragment、不超過長度上限 */
export function isRelayMoveUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > RELAY_MOVE_MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'wss:' || url.protocol === 'ws:') && url.host !== '' && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** 比對用的正規化：協定與主機小寫（`URL` 已經做了）、去掉結尾斜線 */
function normalized(url: string): string {
  try {
    return new URL(url).toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/** 兩個中繼網址是不是同一座（協定與主機不分大小寫、結尾斜線不計；路徑分大小寫） */
export function sameRelayUrl(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}

function outerKindOf(kind: RosterOuterKind | undefined): RosterOuterKind {
  if (kind === undefined) return FILE_WRAP_KIND;
  if (kind !== GIFT_WRAP_KIND && kind !== FILE_WRAP_KIND) throw new RangeError(`搬家通知的外層 kind 只能是 1059 或 1060（收到 ${String(kind)}）`);
  return kind;
}

/** 把一則搬家通知包成給每位收件人的事件（與名單同步同一種封裝） */
export function buildRelayMoveEvents(
  move: RelayMove,
  signer: NostrSigner,
  recipients: readonly string[],
  opts: { now?: number; ttlSeconds?: number; outerKind?: RosterOuterKind } = {},
): NostrEvent[] {
  if (!isRelayMoveUrl(move.from) || !isRelayMoveUrl(move.to)) throw new Error('搬家通知的網址必須是 wss:// 或 ws:// 的中繼網址');
  if (sameRelayUrl(move.from, move.to)) throw new Error('搬家通知的新舊網址相同');
  if (!Number.isFinite(move.at) || move.at <= 0) throw new Error('搬家通知的時間不對');
  const kind = outerKindOf(opts.outerKind);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const content = JSON.stringify({ v: 1, from: move.from, to: move.to, at: Math.floor(move.at), ...(move.device ? { device: move.device } : {}) });
  const expiration = String(nowSec + (opts.ttlSeconds ?? DEFAULT_RELAY_MOVE_TTL_SECONDS));
  return recipients.map((to) =>
    sealAndWrap({ kind: VAULT_RELAY_MOVE_KIND, created_at: nowSec, tags: [], content }, signer, to, {
      kind,
      tags: [
        ['p', to],
        ['expiration', expiration],
      ],
    }),
  );
}

/**
 * 解開搬家通知；不是搬家通知、解不開、格式不對、外層不是 `outerKind`（預設 1060）回 null。
 * 不驗寄件人是否為成員——那是收方的事（`NostrRosterSync` 會驗）。
 */
export function openRelayMoveEvent(
  event: Event | NostrEvent,
  signer: NostrSigner,
  opts: { outerKind?: RosterOuterKind } = {},
): ReceivedRelayMove | null {
  if (event.kind !== outerKindOf(opts.outerKind)) return null;
  try {
    const opened = openWrap(event as NostrEvent, signer);
    if (opened.rumor.kind !== VAULT_RELAY_MOVE_KIND) return null;
    const body = JSON.parse(opened.rumor.content) as { v?: unknown; from?: unknown; to?: unknown; at?: unknown; device?: unknown };
    if (body.v !== 1 || !isRelayMoveUrl(body.from) || !isRelayMoveUrl(body.to) || sameRelayUrl(body.from, body.to)) return null;
    if (typeof body.at !== 'number' || !Number.isFinite(body.at) || body.at <= 0) return null;
    const device = typeof body.device === 'string' && body.device.length <= 64 ? body.device : undefined;
    return { from: body.from, to: body.to, at: body.at, ...(device ? { device } : {}), sender: opened.sender };
  } catch {
    return null;
  }
}

/** 送出用的連線：`RelayPool` 直接符合。有 `status`／`onStatusChange` 時會先等連線開起來 */
export interface RelayMoveConnection extends RelayTransport {
  close(): void;
  status?(): ReadonlyMap<string, RelayStatus>;
  onStatusChange?(listener: (url: string, status: RelayStatus) => void): () => void;
}

export interface AnnounceRelayMoveOptions {
  membership: VaultMembership;
  signer: NostrSigner;
  /** 要送的通知；`at` 省略＝現在、`device` 省略＝這台的 deviceId */
  move: Omit<RelayMove, 'at' | 'device'> & { at?: number; device?: string };
  /** 送到哪些中繼（部署前：舊網址與其他共同的中繼；部署後：新網址與其他中繼） */
  relays: readonly string[];
  /** 開一個連到 `relays` 的連線（例如 `(urls) => { const p = new RelayPool({ urls, identity }); p.connect(); return p; }`）；送完會 `close()` */
  connect: (urls: readonly string[]) => RelayMoveConnection;
  outerKind?: RosterOuterKind;
  ttlSeconds?: number;
  /** 等連線開起來最多多久（毫秒）；預設 10 秒 */
  connectTimeoutMs?: number;
  now?: () => number;
}

export interface AnnounceRelayMoveResult {
  /** 收下了**每一位**收件人那一顆的中繼 */
  accepted: string[];
  /** 其他（拒收、逾時、沒連上） */
  failed: string[];
  /** 收件人數（有效成員，含自己） */
  recipients: number;
}

/**
 * 把搬家通知送到指定的中繼（SDK ADR 0052）。收件人是名單上**目前有效**的每一台（含自己）；被撤銷的不在裡面。
 * 回傳哪幾座收下了全部收件人的那一顆——呼叫端據此決定要不要部署（「至少一座收下才部署」）。
 * 這台已經不在名單上（被撤銷）時丟例外。
 */
export async function announceRelayMove(opts: AnnounceRelayMoveOptions): Promise<AnnounceRelayMoveResult> {
  const { membership } = opts;
  if (!membership.active) throw new Error('這台裝置已不在名單上，不能送搬家通知');
  const relays = [...new Set(opts.relays)];
  const recipients = membership.devices().map((device) => device.pubkey);
  const now = (opts.now ?? Date.now)();
  const move: RelayMove = {
    from: opts.move.from,
    to: opts.move.to,
    at: opts.move.at ?? now,
    ...((opts.move.device ?? membership.selfDevice?.deviceId) ? { device: opts.move.device ?? membership.selfDevice!.deviceId } : {}),
  };
  const events = buildRelayMoveEvents(move, opts.signer, recipients, {
    now,
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    ...(opts.outerKind !== undefined ? { outerKind: opts.outerKind } : {}),
  });
  if (relays.length === 0) return { accepted: [], failed: [], recipients: recipients.length };
  const connection = opts.connect(relays);
  try {
    await waitOpen(connection, relays, opts.connectTimeoutMs ?? DEFAULT_RELAY_MOVE_CONNECT_MS);
    const results: PublishResult[] = [];
    for (const event of events) results.push(await connection.publish(event as unknown as Event));
    const accepted = relays.filter((url) => results.every((result) => result.accepted.some((u) => sameRelayUrl(u, url))));
    return { accepted, failed: relays.filter((url) => !accepted.includes(url)), recipients: recipients.length };
  } finally {
    connection.close();
  }
}

/** 等每一座都開起來（或逾時）。沒有狀態介面的連線不等 */
function waitOpen(connection: RelayMoveConnection, relays: readonly string[], timeoutMs: number): Promise<void> {
  const status = connection.status?.bind(connection);
  const onChange = connection.onStatusChange?.bind(connection);
  if (!status || !onChange) return Promise.resolve();
  const allOpen = () => relays.every((url) => status().get(url) === 'open');
  if (allOpen()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let off: () => void = () => undefined;
    const timer = setTimeout(done, timeoutMs);
    function done(): void {
      clearTimeout(timer);
      off();
      resolve();
    }
    off = onChange(() => {
      if (allOpen()) done();
    });
  });
}

/** 讀中繼 NIP-11 用的 HTTP（與 `./sync/vault` 的 `RelayInfoFetch` 同一個形狀；外掛注入 requestUrl 版本） */
export type RelayMoveProbeFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * 新網址真的連得上嗎（SDK ADR 0052 的「切換前先測試」）：讀它的 NIP-11（`Accept: application/nostr+json`），
 * 回 200 的 JSON 物件、而且不是唯讀寬限期中的路徑才算。僅限車道的中繼對還沒部署上去的路徑回 404——部署失敗時不會有人切換。
 * 任何錯誤都回 false（下一輪再試）。
 */
export async function probeRelayEndpoint(url: string, fetch: RelayMoveProbeFetch): Promise<boolean> {
  try {
    const http = new URL(url);
    if (http.protocol === 'wss:') http.protocol = 'https:';
    else if (http.protocol === 'ws:') http.protocol = 'http:';
    else return false;
    const response = await fetch(http.toString(), { method: 'GET', headers: { Accept: 'application/nostr+json' } });
    if (response.status !== 200) return false;
    const doc = JSON.parse(await response.text()) as unknown;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false;
    return (doc as Record<string, unknown>).cinder_read_only_until === undefined;
  } catch {
    return false;
  }
}

export interface PlanRelayMovesOptions {
  /** 這台的主中繼清單 */
  primary: readonly string[];
  /** 這台的備援中繼清單（與主清單不重複） */
  standby?: readonly string[];
  /** 收到的通知（寄件人已驗證） */
  moves: readonly RelayMove[];
  /** 新網址連得上嗎（`probeRelayEndpoint`） */
  probe: (url: string) => Promise<boolean>;
  /** 連鎖搬家（A→B、B→C）最多跟幾層；預設 4 */
  maxHops?: number;
}

export interface RelayMovePlan {
  primary: string[];
  standby: string[];
  /** 這次替換了哪些（依序） */
  applied: { from: string; to: string }[];
}

/**
 * 依收到的搬家通知決定新的中繼清單（SDK ADR 0052）。純邏輯＋`probe`，不改任何狀態：
 * - 只**替換**清單裡已經有的舊網址（原地、保持順序），不新增；新網址已經在清單裡就只拿掉舊的（去重）。
 * - 同一個舊網址有好幾則：從最新的開始試，第一個 `probe` 成功的採用；都不成功就不動（部署失敗、還沒上線）。
 * - 備援清單同理；新網址已經在主清單時從備援拿掉（兩份不重複）。
 * - 連鎖（A→B 之後 B→C）最多跟 `maxHops` 層。
 */
export async function planRelayMoves(opts: PlanRelayMovesOptions): Promise<RelayMovePlan> {
  let primary = [...opts.primary];
  let standby = [...(opts.standby ?? [])];
  const applied: { from: string; to: string }[] = [];
  const probed = new Map<string, Promise<boolean>>();
  const probe = (url: string): Promise<boolean> => {
    const key = normalized(url);
    let result = probed.get(key);
    if (!result) {
      result = opts.probe(url).catch(() => false);
      probed.set(key, result);
    }
    return result;
  };
  const maxHops = opts.maxHops ?? 4;
  for (let hop = 0; hop < maxHops; hop += 1) {
    let changed = false;
    for (const current of [...primary, ...standby]) {
      const candidates = opts.moves
        .filter((move) => sameRelayUrl(move.from, current) && !sameRelayUrl(move.to, current))
        .sort((a, b) => b.at - a.at);
      for (const move of candidates) {
        if (!(await probe(move.to))) continue;
        const replace = (list: string[]) => dedupe(list.map((url) => (sameRelayUrl(url, current) ? move.to : url)));
        primary = replace(primary);
        standby = replace(standby).filter((url) => !primary.some((p) => sameRelayUrl(p, url)));
        applied.push({ from: current, to: move.to });
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return { primary, standby, applied };
}

function dedupe(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const url of list) if (!out.some((u) => sameRelayUrl(u, url))) out.push(url);
  return out;
}
