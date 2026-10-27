/**
 * 讀回稽核（SDK ADR 0038 M4；ADR 0041 §4）：對自己寫過的事件，逐座以 `#d`／`ids` 查回，確認還在。
 * 這是唯一只改客戶端就能發現「寫入成功之後才被淘汰」（天花板淘汰、FIFO）的辦法。
 *
 * 能稽核的（受中繼的訂閱範圍限制，ADR-0123、0366）：
 * - **可尋址事件**（DocHost 的桶、牌組、雲端快照 30078…）：`{kinds, authors, #d}`；
 * - **作者是自己的一般事件**：`{ids, authors:[自己]}`；
 * - **自己收件匣裡的事件**（含私訊寄給自己的那一份）：`{ids, #p:[自己]}`（嚴格平面要先 AUTH；連線池帶身分時自動處理）。
 *
 * ❌ **查不到寄給別人的禮物包**（私訊、Vault 訊息、檔案塊）：外層作者是一次性金鑰、收件人不是自己，
 * 寄件人既不能以 `authors` 也不能以 `#p` 查它。這一類只能靠收件人端到端回報（Vault 協調器的摘要／索取；私訊目前沒有）。
 * 這種目標放進來會列在 `unauditable`，不會被當成遺失。
 *
 * 什麼時候跑由應用決定：寫入後立刻查沒有用（淘汰發生在「別人之後寫入」時），建議啟動、回到前景、以及每 6–24 小時。
 * 成本：每批每座一個 REQ（計費一則進站訊息）＋讀 N 列（`#d`／`ids` 有索引）。
 */
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { QueryEachOptions, RelayQueryResult } from '../relay-pool.js';

/** `RelayPool` 直接符合；`markEvicted` 有的話，發現遺失時把那一座那一類資料標成已滿（ADR 0038 M4） */
export interface AuditPool {
  queryEach(filters: Filter[], options?: QueryEachOptions): Promise<RelayQueryResult[]>;
  markEvicted?(url: string, eventKind: number): void;
}

export type AuditTarget =
  | {
      readonly type: 'addressable';
      readonly kind: number;
      readonly pubkey: string;
      readonly d: string;
      /** 最新一版的 id 與時間：查回來的比它舊＝最新那一版在那一座不見了（`outdated`） */
      readonly id?: string;
      readonly createdAt?: number;
      /** 最後更新時間（秒）；抽樣時最久沒更新的優先（它們最先被「最快到期優先」淘汰） */
      readonly updatedAt?: number;
    }
  | {
      readonly type: 'event';
      readonly id: string;
      readonly kind?: number;
      /** 作者（預設自己；沒有 `recipient` 時才用） */
      readonly author?: string;
      /** 收件人（`#p`）；必須是自己才查得到 */
      readonly recipient?: string;
      readonly updatedAt?: number;
    };

export interface AuditOptions {
  /** 自己的公鑰：決定哪些目標查得到 */
  readonly self: string;
  /** 要查哪幾座；預設連線池的 `urls`（不在裡面的當備援延遲連上） */
  readonly relays?: readonly string[];
  /** 這一輪最多查幾個目標（抽樣）；預設全部 */
  readonly sample?: number;
  /** 每個 REQ 放幾個目標；預設 64 */
  readonly batchSize?: number;
  /** 每批的逾時（毫秒） */
  readonly timeoutMs?: number;
  /** 發現遺失時呼叫 `pool.markEvicted`（有的話）；預設 true */
  readonly markEvicted?: boolean;
}

export interface AuditFinding {
  readonly target: AuditTarget;
  /** 確認不在（那一座回了 EOSE 而且沒有）的中繼 */
  readonly relays: readonly string[];
}

export interface AuditOutdated {
  readonly target: AuditTarget;
  readonly relay: string;
  /** 那一座現有的（比目標舊） */
  readonly found: { readonly id: string; readonly created_at: number };
}

export interface AuditReport {
  /** 這一輪查了哪些目標 */
  readonly checked: readonly AuditTarget[];
  /**
   * `checked` 裡至少有一座中繼完整回了 EOSE 的目標（SDK ADR 0045，G12a）。不在這裡的＝每一座都是「不知道」，
   * 不能當成「查過、沒事」（`OwnEventAuditor` 不會把它們往後排）。
   */
  readonly verified: readonly AuditTarget[];
  /** 抽樣時這一輪沒查的數量 */
  readonly deferred: number;
  /** 查不到的目標（寄給別人的禮物包等） */
  readonly unauditable: readonly AuditTarget[];
  /** 確認遺失：目標 → 哪幾座沒有 */
  readonly missing: readonly AuditFinding[];
  /** 可尋址：那一座只剩比較舊的版本 */
  readonly outdated: readonly AuditOutdated[];
  /** 沒有完整回覆的中繼（逾時、被 CLOSED、斷線、沒連上）：在那裡的結果是「不知道」，不算遺失 */
  readonly inconclusive: readonly { readonly url: string; readonly status: RelayQueryResult['status']; readonly reason?: string }[];
}

const DEFAULT_BATCH = 64;

/** 依「最久沒更新」排序（沒給時間的最優先） */
function byStaleness(a: AuditTarget, b: AuditTarget): number {
  return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
}

function isAuditable(target: AuditTarget, self: string): boolean {
  if (target.type === 'addressable') return true;
  if (target.recipient !== undefined) return target.recipient === self;
  return (target.author ?? self) === self;
}

/** 一批目標 → filters（可尋址依 (kind, pubkey) 合併 `#d`；一般事件依 `authors`／`#p` 合併 `ids`） */
function filtersFor(batch: readonly AuditTarget[], self: string): Filter[] {
  const addressable = new Map<string, { kind: number; pubkey: string; d: Set<string> }>();
  const byAuthor: string[] = [];
  const byRecipient: string[] = [];
  for (const target of batch) {
    if (target.type === 'addressable') {
      const key = `${target.kind}:${target.pubkey}`;
      const group = addressable.get(key) ?? { kind: target.kind, pubkey: target.pubkey, d: new Set<string>() };
      group.d.add(target.d);
      addressable.set(key, group);
    } else if (target.recipient !== undefined) byRecipient.push(target.id);
    else byAuthor.push(target.id);
  }
  const filters: Filter[] = [...addressable.values()].map((g) => ({ kinds: [g.kind], authors: [g.pubkey], '#d': [...g.d], limit: g.d.size }));
  if (byAuthor.length > 0) filters.push({ ids: byAuthor, authors: [self], limit: byAuthor.length });
  if (byRecipient.length > 0) filters.push({ ids: byRecipient, '#p': [self], limit: byRecipient.length });
  return filters;
}

function dOf(event: Event): string {
  return event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
}

/**
 * 一次讀回稽核：抽樣（最久沒更新的優先）、分批、逐座查。只把「那一座完整回了 EOSE 而且沒有」算成遺失；
 * 逾時、被 CLOSED、斷線的中繼列在 `inconclusive`。
 */
export function auditOwnEvents(pool: AuditPool, targets: readonly AuditTarget[], options: AuditOptions): Promise<AuditReport> {
  return auditInOrder(pool, [...targets].sort(byStaleness), options);
}

/** 依給定順序抽樣（`auditOwnEvents` 先依最久沒更新排好；`OwnEventAuditor` 另外把剛查過的往後排） */
async function auditInOrder(pool: AuditPool, targets: readonly AuditTarget[], options: AuditOptions): Promise<AuditReport> {
  const { self } = options;
  const unauditable = targets.filter((t) => !isAuditable(t, self));
  const auditable = targets.filter((t) => isAuditable(t, self));
  const limit = options.sample === undefined ? auditable.length : Math.max(0, Math.floor(options.sample));
  const checked = auditable.slice(0, limit);
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH));
  const missing = new Map<AuditTarget, string[]>();
  const outdated: AuditOutdated[] = [];
  const inconclusive = new Map<string, AuditReport['inconclusive'][number]>();
  const verified: AuditTarget[] = [];

  for (let i = 0; i < checked.length; i += batchSize) {
    const batch = checked.slice(i, i + batchSize);
    const queryOptions: QueryEachOptions = {
      ...(options.relays !== undefined ? { relays: options.relays } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
    const results = await pool.queryEach(filtersFor(batch, self), queryOptions);
    if (results.some((result) => result.status === 'eose')) verified.push(...batch);
    for (const result of results) {
      if (result.status !== 'eose') {
        if (!inconclusive.has(result.url)) {
          inconclusive.set(result.url, { url: result.url, status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
        }
        continue;
      }
      const ids = new Set(result.events.map((e) => e.id));
      for (const target of batch) {
        if (target.type === 'event') {
          if (!ids.has(target.id)) addMissing(missing, target, result.url);
          continue;
        }
        const found = result.events
          .filter((e) => e.kind === target.kind && e.pubkey === target.pubkey && dOf(e) === target.d)
          .sort((a, b) => b.created_at - a.created_at)[0];
        if (found === undefined) addMissing(missing, target, result.url);
        else if (target.createdAt !== undefined && found.created_at < target.createdAt && found.id !== target.id) {
          outdated.push({ target, relay: result.url, found: { id: found.id, created_at: found.created_at } });
        }
      }
    }
  }

  const findings = [...missing].map(([target, relays]) => ({ target, relays }));
  if (options.markEvicted !== false && pool.markEvicted !== undefined) {
    for (const { target, relays } of findings) {
      const kind = target.kind;
      if (kind !== undefined) for (const url of relays) pool.markEvicted(url, kind);
    }
    for (const { target, relay } of outdated) if (target.kind !== undefined) pool.markEvicted(relay, target.kind);
  }
  return {
    checked,
    verified,
    deferred: auditable.length - checked.length,
    unauditable,
    missing: findings,
    outdated,
    inconclusive: [...inconclusive.values()],
  };
}

function addMissing(map: Map<AuditTarget, string[]>, target: AuditTarget, url: string): void {
  const list = map.get(target);
  if (list === undefined) map.set(target, [url]);
  else list.push(url);
}

export interface OwnEventAuditorOptions extends Omit<AuditOptions, 'sample'> {
  readonly pool: AuditPool;
  /** 兩輪之間至少隔多久（毫秒）；預設 10 分鐘。太快的 `run()` 直接回 `{ skipped: 'rate-limited' }` */
  readonly minIntervalMs?: number;
  /** 每輪最多查幾個；預設 64 */
  readonly sample?: number;
  /** 查過的目標多久內往後排（毫秒），讓抽樣輪流查到每一個；預設 6 小時 */
  readonly recheckAfterMs?: number;
  /** 毫秒 */
  readonly now?: () => number;
}

/**
 * 有速率限制、會輪流的稽核器：每輪抽樣 `sample` 個，最久沒更新的優先，但剛查過的往後排；
 * 兩輪之間至少隔 `minIntervalMs`。同時只跑一輪（重複呼叫拿到同一個結果）。
 */
export class OwnEventAuditor {
  readonly #opts: OwnEventAuditorOptions;
  readonly #now: () => number;
  readonly #checkedAt = new Map<string, number>();
  #lastRunAt: number | undefined;
  #running: Promise<AuditReport> | undefined;

  constructor(opts: OwnEventAuditorOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  /** 下一輪最早什麼時候可以跑（毫秒） */
  nextRunAt(): number {
    return this.#lastRunAt === undefined ? 0 : this.#lastRunAt + (this.#opts.minIntervalMs ?? 10 * 60_000);
  }

  run(targets: readonly AuditTarget[]): Promise<AuditReport | { readonly skipped: 'rate-limited'; readonly nextRunAt: number }> {
    if (this.#running !== undefined) return this.#running;
    const now = this.#now();
    if (now < this.nextRunAt()) return Promise.resolve({ skipped: 'rate-limited', nextRunAt: this.nextRunAt() });
    const previousRunAt = this.#lastRunAt;
    this.#lastRunAt = now;
    const recheck = this.#opts.recheckAfterMs ?? 6 * 60 * 60_000;
    const recent = (t: AuditTarget): number => {
      const at = this.#checkedAt.get(keyOf(t));
      return at !== undefined && now - at < recheck ? 1 : 0;
    };
    // 先排「最近沒查過」的，同一組內最久沒更新的優先
    const ordered = [...targets].sort((a, b) => recent(a) - recent(b) || byStaleness(a, b));
    const { pool, minIntervalMs: _i, recheckAfterMs: _r, now: _n, sample, ...rest } = this.#opts;
    const run = auditInOrder(pool, ordered, { ...rest, sample: sample ?? DEFAULT_BATCH })
      .then((report) => {
        // 只有真的有中繼回完的才算查過（G12a）；一個都沒查到時不佔速率限制，連上之後可以馬上再跑
        for (const target of report.verified) this.#checkedAt.set(keyOf(target), now);
        if (report.checked.length > 0 && report.verified.length === 0 && this.#lastRunAt === now) this.#lastRunAt = previousRunAt;
        return report;
      })
      .finally(() => {
        this.#running = undefined;
      });
    this.#running = run;
    return run;
  }
}

function keyOf(target: AuditTarget): string {
  return target.type === 'addressable' ? `a:${target.kind}:${target.pubkey}:${target.d}` : `e:${target.id}`;
}
