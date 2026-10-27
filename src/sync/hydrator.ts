// 秒級水化與省電（SDK ADR 0011 §5；PRD 2.5）：手機回到前景時立刻拉增量，放到背景太久就斷線省電。
//
// 「樂觀就緒」（先顯示本機快取、不等網路）是 App 的事；這裡只負責網路那一半。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import { TIMESTAMP_JITTER_SECONDS } from '../protocol/nip59.js';
import type { RelayQueryOutcome, RelayQueryStatus } from '../relay-pool.js';

/** 放到背景超過這麼久就主動斷線（PRD：15 秒） */
export const DEFAULT_HIDDEN_DISCONNECT_MS = 15_000;

/** 只用到連線池的這幾個方法；RelayPool 直接符合 */
export interface HydratorPool {
  connect(): void;
  close(): void;
  query(filters: Filter[], timeoutMs?: number): Promise<Event[]>;
  /**
   * 選配（SDK ADR 0045，G12a；`RelayPool` 有）：回報幾座完整回完。有的話，**一座都沒回完**的那一頁不算「翻完了」，
   * 游標（`setLastSyncAt`、補拉起點）不會被推進。只有 `query` 的自訂池分不出來，沿用舊行為。
   */
  queryResult?(filters: Filter[], timeoutMs?: number, options?: { readonly waitForPrimary?: boolean }): Promise<RelayQueryOutcome>;
}

/**
 * 沒有任何一座中繼完成查詢（都沒開、逾時、被 CLOSED、查到一半全部斷線；SDK ADR 0045，G12a）。
 * 不是「查完但沒結果」：依查詢結果推進的游標此時不得推進。`events`＝在那之前已經拿到的（已交出去的頁）。
 */
export class RelayQueryIncompleteError extends Error {
  readonly relays: readonly RelayQueryStatus[];
  readonly events: readonly Event[];
  constructor(relays: readonly RelayQueryStatus[], events: readonly Event[] = []) {
    const detail = relays.map((r) => `${r.url} ${r.status}${r.reason ? `（${r.reason}）` : ''}`).join('；');
    super(`沒有任何中繼完成查詢${detail ? `：${detail}` : ''}`);
    this.name = 'RelayQueryIncompleteError';
    this.relays = relays;
    this.events = events;
  }
}

export function isRelayQueryIncompleteError(error: unknown): error is RelayQueryIncompleteError {
  return error instanceof RelayQueryIncompleteError || (error instanceof Error && error.name === 'RelayQueryIncompleteError');
}

export interface VisibilitySource {
  isHidden(): boolean;
  /** 回傳取消函式 */
  onChange(listener: (hidden: boolean) => void): () => void;
}

/** 瀏覽器預設：`document.visibilityState`；沒有 document（Node、React Native）回 null，請自行注入 */
export function documentVisibility(): VisibilitySource | null {
  const doc = (globalThis as { document?: { visibilityState: string; addEventListener: Function; removeEventListener: Function } }).document;
  if (!doc) return null;
  return {
    isHidden: () => doc.visibilityState === 'hidden',
    onChange(listener) {
      const handler = () => listener(doc.visibilityState === 'hidden');
      doc.addEventListener('visibilitychange', handler);
      return () => doc.removeEventListener('visibilitychange', handler);
    },
  };
}

/** 分頁取回最多翻幾頁（防惡意中繼無止盡地回更舊的事件）。每頁至多約 16 MB（中繼的 REQ 位元組預算） */
export const DEFAULT_MAX_PAGES = 64;

export interface PagedQueryOptions {
  /** 每一頁的逾時（毫秒；交給 `pool.query`） */
  timeoutMs?: number;
  /** 最多翻幾頁；預設 {@link DEFAULT_MAX_PAGES}。1＝不分頁（與 v0.24 相同） */
  maxPages?: number;
}

/** {@link forEachPage} 的結果 */
export interface PagedQueryResult {
  /** 總共拿到幾則（以 id 去重） */
  events: number;
  /**
   * 翻到一頁沒有新事件才停（true）；撞到 `maxPages` 就停下的、或某一頁沒有任何中繼回完（`unanswered`）的是 false——
   * 更舊的可能還沒拿，游標不要推進
   */
  complete: boolean;
  /** 某一頁沒有任何中繼完成查詢（SDK ADR 0045，G12a；只有池提供 `queryResult` 才分辨得出）。只在這種情況出現 */
  unanswered?: true;
  /** `unanswered` 時，那一頁每一座的狀態 */
  relays?: readonly RelayQueryStatus[];
}

/**
 * 分頁取回歷史事件（SDK ADR 0029；NIP-01 `until`）：每拿到一頁、把**這一頁新的事件**交給 `onPage`。
 *
 * 為什麼要分頁：中繼一次 REQ 回傳的量有上限（Cinderous ADR-0371：16 MB 位元組預算，約 120 顆檔案塊；
 * 另有 1024 筆的筆數上限），超過的**最舊**那些不會出現在這次回應裡——而且中繼**不會告訴你**被截斷了。
 * 所以這裡不猜：以這一頁最舊的 `created_at` 當下一頁的 `until`（含邊界，同一秒的不會漏）再查，
 * 直到一頁沒有任何新事件為止。代價是每次多一個（通常是空的）REQ。
 *
 * ⚠ `pool.query` 把多座中繼的結果合在一起：各座內容不一致、又各自被截斷時，以合併後最舊的時間往回翻，
 * 可能跳過較新那座被截斷的部分。Vault 同步由協調器的摘要／索取補回；要逐座精準分頁，每座給一個 pool。
 */
export async function forEachPage(
  pool: Pick<HydratorPool, 'query'> & Partial<Pick<HydratorPool, 'queryResult'>>,
  filters: Filter[],
  onPage: (events: Event[]) => void,
  opts: PagedQueryOptions = {},
): Promise<PagedQueryResult> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES));
  const seen = new Set<string>();
  let until: number | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const paged = until === undefined ? filters : filters.map((f) => ({ ...f, until: Math.min(f.until ?? until!, until!) }));
    let events: Event[];
    if (pool.queryResult) {
      const outcome = await pool.queryResult(paged, opts.timeoutMs);
      // 一座都沒回完（G12a）：不是「翻完了」。已經交出去的頁照樣算數，但整體不算完成
      if (outcome.answered === 0) return { events: seen.size, complete: false, unanswered: true, relays: outcome.relays };
      events = outcome.events;
    } else {
      events = await pool.query(paged, opts.timeoutMs);
    }
    const fresh = events.filter((e) => !seen.has(e.id));
    if (fresh.length === 0) return { events: seen.size, complete: true };
    for (const e of fresh) seen.add(e.id);
    onPage(fresh);
    let oldest = Infinity;
    for (const e of events) if (e.created_at < oldest) oldest = e.created_at;
    // 同一秒塞滿一整頁（極少見）：往前推一秒才會前進，那一秒剩下的只能放棄——總比無限迴圈好
    const next = until !== undefined && oldest >= until ? until - 1 : oldest;
    if (next < 0) return { events: seen.size, complete: true };
    until = next;
  }
  return { events: seen.size, complete: false };
}

/**
 * {@link forEachPage} 的收集版：回傳所有頁的事件（去重、由新到舊）。
 * 某一頁沒有任何中繼回完時丟 {@link RelayQueryIncompleteError}（v0.36 起；帶著已拿到的事件），不再回空陣列假裝查完。
 */
export async function queryPaged(
  pool: Pick<HydratorPool, 'query'> & Partial<Pick<HydratorPool, 'queryResult'>>,
  filters: Filter[],
  opts: PagedQueryOptions = {},
): Promise<Event[]> {
  const all: Event[] = [];
  const result = await forEachPage(pool, filters, (events) => all.push(...events), opts);
  all.sort((a, b) => b.created_at - a.created_at);
  if (result.unanswered) throw new RelayQueryIncompleteError(result.relays ?? [], all);
  return all;
}

export interface FastHydratorOptions {
  pool: HydratorPool;
  /** 喚醒時要拉的東西（不含 since，這裡會補上） */
  filters: Filter[];
  onEvents: (events: Event[]) => void;
  /** 上次同步成功的時間（秒）；沒同步過回 undefined */
  lastSyncAt: () => number | undefined;
  setLastSyncAt: (seconds: number) => void;
  visibility?: VisibilitySource | null;
  hiddenDisconnectMs?: number;
  /**
   * since 要往前退讓多少秒。預設是 NIP-59 的時間倒填窗（兩天）：禮物包的外層時間會被隨機往前推，
   * 不退讓的話，剛寄出、外層時間卻落在兩天前的訊息會被 since 濾掉——而且是靜默漏訊（Cinderous ADR-0109）。
   */
  sinceSlackSeconds?: number;
  queryTimeoutMs?: number;
  /**
   * 最多翻幾頁（SDK ADR 0029）：中繼一次回傳有上限、而且不告訴你被截斷了，所以預設以 `until` 往回翻到沒有新事件。
   * 預設 {@link DEFAULT_MAX_PAGES}；1＝不分頁（v0.24 的行為）。
   */
  maxPages?: number;
}

export class FastHydrator {
  readonly #opts: FastHydratorOptions;
  readonly #visibility: VisibilitySource | null;
  #offVisibility: (() => void) | undefined;
  #hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  #disconnected = false;

  constructor(opts: FastHydratorOptions) {
    this.#opts = opts;
    this.#visibility = opts.visibility === undefined ? documentVisibility() : opts.visibility;
  }

  /** 開始監看可見性，並立刻拉一次增量。 */
  async start(): Promise<void> {
    this.#offVisibility = this.#visibility?.onChange((hidden) => (hidden ? this.#onHidden() : void this.#onVisible()));
    await this.resume().catch(() => {});
  }

  stop(): void {
    this.#offVisibility?.();
    this.#offVisibility = undefined;
    clearTimeout(this.#hiddenTimer);
  }

  /**
   * 拉一次增量；回傳拿到幾則。失敗時不更新同步時間（下次重拉，不會漏）。
   * 沒有任何中繼回完（池有 `queryResult` 時才分辨得出；SDK ADR 0045）也是失敗：拿到的頁照樣交出去，
   * 但不更新同步時間，並丟 {@link RelayQueryIncompleteError}。
   */
  async resume(): Promise<number> {
    const startedAt = Math.floor(Date.now() / 1000);
    const last = this.#opts.lastSyncAt();
    const slack = this.#opts.sinceSlackSeconds ?? TIMESTAMP_JITTER_SECONDS;
    const filters = last === undefined ? this.#opts.filters : this.#opts.filters.map((f) => ({ ...f, since: Math.max(0, last - slack) }));
    // 分頁取回（SDK ADR 0029）：一頁一頁交出去，不必等全部翻完、也不必全部放在記憶體裡
    const opts: PagedQueryOptions = {};
    if (this.#opts.queryTimeoutMs !== undefined) opts.timeoutMs = this.#opts.queryTimeoutMs;
    if (this.#opts.maxPages !== undefined) opts.maxPages = this.#opts.maxPages;
    let first = true;
    const result = await forEachPage(this.#opts.pool, filters, (events) => {
      first = false;
      this.#opts.onEvents(events);
    }, opts);
    if (result.unanswered) throw new RelayQueryIncompleteError(result.relays ?? []);
    if (first) this.#opts.onEvents([]); // 與 v0.24 一致：沒有新事件也呼叫一次
    // 用「開始查詢」的時間：查詢途中到的訊息下次還會被拉到。
    // 撞到頁數上限（更舊的可能還沒拿）就不前進——前進了，下次的 since 會把沒拿到的那些永遠跳過
    if (result.complete) this.#opts.setLastSyncAt(startedAt);
    return result.events;
  }

  #onHidden(): void {
    clearTimeout(this.#hiddenTimer);
    this.#hiddenTimer = setTimeout(() => {
      this.#opts.pool.close();
      this.#disconnected = true;
    }, this.#opts.hiddenDisconnectMs ?? DEFAULT_HIDDEN_DISCONNECT_MS);
  }

  async #onVisible(): Promise<void> {
    clearTimeout(this.#hiddenTimer);
    if (this.#disconnected) {
      this.#disconnected = false;
      this.#opts.pool.connect();
    }
    await this.resume().catch(() => {});
  }
}
