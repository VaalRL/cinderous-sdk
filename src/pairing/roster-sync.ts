// 名單同步（SDK ADR 0028 §4）：名單一有變動（加入、撤銷、輪換、合併出新內容），就把完整名單以 NIP-59 送給
// 每一台**目前有效**的其他成員。外層預設 kind 1060（與協調器相同，中繼要開 `MAX_FILE_MB`），內層 rumor kind 4361；
// 舊客戶端（`parseFileChunk` 只認 43）與協調器的傳輸層（只認 4360）都會略過。
// `outerKind: 1059`（SDK ADR 0043）：外層改用標準 NIP-59 禮物包——不收 1060 的中繼（官方錨點與預設自架站的非檔案車道回
// `blocked: files-disabled:`）也能同步。滿載 32 台實測約 110 KB（109,769 bytes），在所有 kind 共用的單顆上限 262,144 bytes 內。
// 兩端要用同一個外層：1060 的一端收不到 1059 的、反之亦然。NIP-17 私訊的收件匣也會看到這些 1059，但內層不是 kind 14，會被略過。
//
// 收到的名單：寄件人（seal 簽章者）必須是本機名單上的有效成員，再交給 `VaultMembership.merge`（逐欄驗證、聯集、撤銷永遠贏）。
// 合併出新內容 → 本機名單發 `change` → 再送給所有成員；沒有新內容就停，所以會收斂。
//
// 撤銷通知（SDK ADR 0105）：撤銷之後的名單不送給被撤銷的裝置，它就永遠不知道自己出局。撤銷的那台另外送它一份
// 精簡名單——只有它自己的撤銷紀錄與它本來就有的舊金鑰（沒有裝置清單、沒有新金鑰）。格式就是一般名單，
// 舊版的被撤銷裝置照樣 `merge` 出 `selfRevoked`。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { NostrEvent } from '../protocol/event.js';
import { openWrap, sealAndWrap, TIMESTAMP_JITTER_SECONDS } from '../protocol/nip59.js';
import type { NostrSigner } from '../protocol/signer.js';
import { meetsDurability, reportPublishRejections, type PublishRejectionReport } from '../publish-rejections.js';
import { publishPaced, RelayEventBudget, sharedRelayEventBudget } from '../relay-budget.js';
import type { PublishDurability, RelayStatus, RelayTransport, Subscription } from '../relay-pool.js';
import { openRelayMoveEvent, type ReceivedRelayMove } from './relay-move.js';
import type { MembershipChange, VaultMembership, VaultRosterData } from './roster.js';

/** 名單同步的內層 rumor kind（外層 1060 或 1059） */
export const VAULT_ROSTER_KIND = 4361;
/** 與檔案塊相同的外層 kind（不從 `./sync` 匯入，免得把同步零件拉進這個子路徑） */
const FILE_WRAP_KIND = 1060;
/** NIP-59 禮物包 */
const GIFT_WRAP_KIND = 1059;
/** 名單事件的外層 kind（SDK ADR 0043）：1060＝與檔案塊相同（預設，CinderSync 相容）；1059＝標準禮物包，不需要中繼開檔案事件 */
export type RosterOuterKind = typeof GIFT_WRAP_KIND | typeof FILE_WRAP_KIND;
export const DEFAULT_ROSTER_OUTER_KIND: RosterOuterKind = FILE_WRAP_KIND;

function outerKindOf(kind: RosterOuterKind | undefined): RosterOuterKind {
  if (kind === undefined) return DEFAULT_ROSTER_OUTER_KIND;
  if (kind !== GIFT_WRAP_KIND && kind !== FILE_WRAP_KIND) throw new RangeError(`名單的外層 kind 只能是 1059 或 1060（收到 ${String(kind)}）`);
  return kind;
}
export const DEFAULT_ROSTER_TTL_SECONDS = 7 * 86_400;
const SEEN = 1024;

/**
 * 「有未送出的名單變動」標記的持久化（SDK ADR 0045，G12d）。存一個布林值就好（例如 IndexedDB、`localStorage`）；
 * 不要存進會被同步出去的設定檔。
 */
export interface RosterPendingStore {
  load(): boolean | Promise<boolean>;
  save(pending: boolean): void | Promise<void>;
}

export interface NostrRosterSyncOptions {
  /** `RelayPool` 直接符合；有 `onStatusChange` 時 `retryOnReconnect` 才有作用 */
  pool: RelayTransport & { onStatusChange?(listener: (url: string, status: RelayStatus) => void): () => void };
  signer: NostrSigner;
  membership: VaultMembership;
  ttlSeconds?: number;
  /** 訂閱起點（秒）；自動往前退讓 NIP-59 的兩天倒填窗 */
  since?: number;
  now?: () => number;
  /** 送出失敗等錯誤 */
  onError?: (error: unknown) => void;
  /**
   * 有中繼拒收時回報（SDK ADR 0038 P0-C），每位收件人的事件一次。成功照舊以「每位收件人至少一座收下」判斷。
   */
  onPublishRejected?: (report: PublishRejectionReport) => void;
  /**
   * 耐久度要求（SDK ADR 0041）：每位收件人的名單事件要至少 `minAccepted` 座耐久收下（借用不算）才算送出；
   * 不足時只有給了 `standby` 才會延遲連上備援補發。省略＝v0.32 的判斷（至少一座收下）。
   */
  durability?: PublishDurability;
  /**
   * 外層 kind（SDK ADR 0043）：預設 1060（v0.34 以前的唯一選擇，CinderSync 相容）。1059＝標準 NIP-59 禮物包，
   * 給不收 1060 的中繼（`blocked: files-disabled:`）。**同一份名單的每一台都要用同一個值**。
   */
  outerKind?: RosterOuterKind;
  /**
   * 每分鐘最多發幾顆（SDK ADR 0043）。指定了就用自己的預算；省略＝與同一身分的 PeerNode、Vault 同步共用
   * `sharedRelayEventBudget(signer.pubkey)`（預設每分鐘 100）。滿載一次是 31 顆。
   */
  eventsPerMinute?: number;
  /** 直接指定預算；優先於 `eventsPerMinute` */
  relayBudget?: RelayEventBudget;
  /**
   * 送不出去的名單變動（SDK ADR 0045，G12d）：任何一次送給全部成員的 `announce()`（名單變動自動觸發、`start()` 的宣告）
   * 有收件人沒送到，就記成 `pending`；之後一次完整送達才清掉。給了 `pendingStore` 時標記跨重開。
   * `retryOnReconnect: true`：連線池回報任何一座變回 `open` 時自動重送整份名單（預設 false＝v0.35 的行為，只記不送；
   * 應用可以在自己的時機呼叫 `retryPending()`）。
   */
  pendingStore?: RosterPendingStore;
  retryOnReconnect?: boolean;
  /**
   * 開自己的訂閱（預設 true）。`false`：不訂閱，事件由應用以 `ingestEvents` 餵進來（SDK ADR 0082）——
   * 外層同為 1060 時接 Vault 傳輸層的 `onOtherEvent`，中繼就不會把同一批檔案塊回兩次。收送名單變動、宣告照舊。
   */
  subscribe?: boolean;
  /**
   * 收到中繼搬家通知（SDK ADR 0052；內層 kind 4363，與名單同一個訂閱、同一個外層）。只交出寄件人是本機名單上**有效成員**的；
   * 要不要採用（替換清單裡的舊網址、先測試新網址）由應用決定，見 `planRelayMoves`。同一顆事件只交一次。
   */
  onRelayMove?: (move: ReceivedRelayMove) => void;
  /**
   * 收到本機名單上**有效成員**寄的名單或搬家通知（SDK ADR 0053 §G17）：交出寄件人與寄出時間（毫秒），例如交給
   * 協調器的 `notePeerActivity(deviceId, at)`，「最後一次看到它」就含名單訊息。補拉到的舊事件交出的是當時的寄出時間。
   * 同一顆事件只交一次。
   */
  onMemberActivity?: (activity: RosterMemberActivity) => void;
}

/** `onMemberActivity` 交出的動靜 */
export interface RosterMemberActivity {
  /** 寄件人（seal 簽章者）的公鑰 */
  readonly pubkey: string;
  /** 名單上它的 deviceId（找不到時沒有） */
  readonly deviceId?: string;
  /** 寄出的時間（毫秒） */
  readonly at: number;
}

/** 把完整名單包成給每位收件人的事件 */
export function buildRosterEvents(
  membership: VaultMembership,
  signer: NostrSigner,
  recipients: readonly string[],
  opts: { now?: number; ttlSeconds?: number; outerKind?: RosterOuterKind } = {},
): NostrEvent[] {
  const kind = outerKindOf(opts.outerKind);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const content = JSON.stringify({ v: 1, roster: membership.roster() });
  const expiration = String(nowSec + (opts.ttlSeconds ?? DEFAULT_ROSTER_TTL_SECONDS));
  return recipients.map((to) =>
    sealAndWrap({ kind: VAULT_ROSTER_KIND, created_at: nowSec, tags: [], content }, signer, to, {
      kind,
      tags: [
        ['p', to],
        ['expiration', expiration],
      ],
    }),
  );
}

/**
 * 給被撤銷的裝置的通知（SDK ADR 0105）：一份精簡名單，只有它自己的撤銷紀錄與舊金鑰。
 * `excludeKeyIds`：它拿不到的金鑰（撤銷時輪換出來的新金鑰）。它不在撤銷紀錄裡、或扣掉之後沒有金鑰可放（名單格式至少要一把）時回 null。
 */
export function buildRevocationNotice(
  membership: VaultMembership,
  signer: NostrSigner,
  revoked: string,
  opts: { excludeKeyIds: readonly string[]; now?: number; ttlSeconds?: number; outerKind?: RosterOuterKind },
): NostrEvent | null {
  const full = membership.roster();
  const record = full.revoked.find((r) => r.pubkey === revoked);
  if (!record) return null;
  const exclude = new Set(opts.excludeKeyIds);
  const keys = full.keys.filter((k) => !exclude.has(k.id));
  if (keys.length === 0) return null;
  const roster: VaultRosterData = { v: full.v, vaultId: full.vaultId, devices: [], revoked: [record], keys };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const expiration = String(nowSec + (opts.ttlSeconds ?? DEFAULT_ROSTER_TTL_SECONDS));
  return sealAndWrap({ kind: VAULT_ROSTER_KIND, created_at: nowSec, tags: [], content: JSON.stringify({ v: 1, roster }) }, signer, revoked, {
    kind: outerKindOf(opts.outerKind),
    tags: [
      ['p', revoked],
      ['expiration', expiration],
    ],
  });
}

/**
 * 解開名單事件；不是名單、解不開、格式不對、外層不是 `outerKind`（預設 1060）回 null
 *（不驗寄件人是否為成員，那是 `merge` 的事）
 */
export function openRosterEvent(
  event: Event | NostrEvent,
  signer: NostrSigner,
  opts: { outerKind?: RosterOuterKind } = {},
): { sender: string; roster: unknown; sentAt: number } | null {
  if (event.kind !== outerKindOf(opts.outerKind)) return null;
  try {
    const opened = openWrap(event as NostrEvent, signer);
    if (opened.rumor.kind !== VAULT_ROSTER_KIND) return null;
    const body = JSON.parse(opened.rumor.content) as { v?: unknown; roster?: unknown };
    if (body.v !== 1) return null;
    // 寄出時間：內層 rumor 的時間（外層被 NIP-59 往前推過）；SDK ADR 0053 §G17
    return { sender: opened.sender, roster: body.roster, sentAt: opened.rumor.created_at * 1000 };
  } catch {
    return null;
  }
}

/** 名單的收送。`start()` 後，名單變動會自動送出；收到其他成員的名單會自動合併。 */
export class NostrRosterSync {
  readonly #opts: NostrRosterSyncOptions;
  readonly #outerKind: RosterOuterKind;
  readonly #budget: RelayEventBudget;
  readonly #seen = new Set<string>();
  #sub: Subscription | undefined;
  #started = false;
  #offChange: (() => void) | undefined;
  #offStatus: (() => void) | undefined;
  #sending: Promise<void> = Promise.resolve();
  #pending = false;
  #retrying: Promise<boolean> | undefined;

  constructor(opts: NostrRosterSyncOptions) {
    this.#opts = opts;
    this.#outerKind = outerKindOf(opts.outerKind);
    this.#budget =
      opts.relayBudget ??
      (opts.eventsPerMinute !== undefined ? new RelayEventBudget({ perMinute: opts.eventsPerMinute }) : sharedRelayEventBudget(opts.signer.pubkey));
  }

  /** 這個同步器用的外層 kind */
  get outerKind(): RosterOuterKind {
    return this.#outerKind;
  }

  /** 有沒有送不出去、還沒完整送達的名單變動（SDK ADR 0045，G12d） */
  get pending(): boolean {
    return this.#pending;
  }

  /** 訂閱、開始監聽名單變動；`announce` 為 true（預設）時先把目前的名單送一次（給離線超過中繼保留期的成員補齊） */
  start(opts: { announce?: boolean } = {}): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#opts.subscribe !== false) this.#sub = this.#opts.pool.subscribe(this.filters(), { onEvent: (event) => this.#ingest(event) });
    this.#offChange = this.#opts.membership.onChange((change) => this.#onChange(change));
    if (this.#opts.retryOnReconnect) {
      this.#offStatus = this.#opts.pool.onStatusChange?.((_url, status) => {
        if (status === 'open' && this.#pending) void this.retryPending().catch(() => {});
      });
    }
    const store = this.#opts.pendingStore;
    if (store) {
      // 上次沒送到的標記：讀回來（讀到之前本次已經記下的不會被蓋掉）
      void Promise.resolve()
        .then(() => store.load())
        .then((pending) => {
          if (pending === true && this.#started) this.#pending = true;
        })
        .catch((error: unknown) => this.#opts.onError?.(error));
    }
    if (opts.announce !== false) void this.announce().catch(() => {});
  }

  stop(): void {
    this.#started = false;
    this.#sub?.close();
    this.#sub = undefined;
    this.#offChange?.();
    this.#offChange = undefined;
    this.#offStatus?.();
    this.#offStatus = undefined;
  }

  /**
   * 有未送出的名單變動就重送整份名單（SDK ADR 0045，G12d）；回傳有沒有送。送不出去時 reject（標記留著）。
   * 同時呼叫共用同一次。
   */
  retryPending(): Promise<boolean> {
    if (!this.#pending) return Promise.resolve(false);
    if (this.#retrying) return this.#retrying;
    const run = this.announce()
      .then(() => true)
      .finally(() => {
        this.#retrying = undefined;
      });
    this.#retrying = run;
    return run;
  }

  #setPending(pending: boolean): void {
    if (this.#pending === pending) return;
    this.#pending = pending;
    const store = this.#opts.pendingStore;
    if (store) {
      void Promise.resolve()
        .then(() => store.save(pending))
        .catch((error: unknown) => this.#opts.onError?.(error));
    }
  }

  /** 1059、1060 都是會被倒填時間的 kind：`since` 往前退讓兩天，連線池補訂閱時也會（G8，SDK ADR 0035） */
  filters(): Filter[] {
    const filter: Filter = { kinds: [this.#outerKind], '#p': [this.#opts.signer.pubkey] };
    if (this.#opts.since !== undefined) filter.since = Math.max(0, this.#opts.since - TIMESTAMP_JITTER_SECONDS);
    return [filter];
  }

  /** 補拉到的事件（例如 `FastHydrator`）走同一條路 */
  ingestEvents(events: readonly Event[]): void {
    for (const event of events) this.#ingest(event);
  }

  /** 把目前的名單送給所有有效的其他成員（或指定的收件人）。依序送出；每位收件人至少一座中繼接受才算成功。 */
  announce(recipients?: readonly string[]): Promise<void> {
    const toAll = recipients === undefined;
    const run = this.#sending.then(async () => {
      const m = this.#opts.membership;
      if (!m.active) return;
      const to = (recipients ?? m.peerPubkeys()).filter((pk) => m.isMember(pk) && pk !== m.self);
      if (to.length === 0) return;
      const events = buildRosterEvents(m, this.#opts.signer, to, {
        now: (this.#opts.now ?? Date.now)(),
        ttlSeconds: this.#opts.ttlSeconds,
        outerKind: this.#outerKind,
      });
      const failed: string[] = [];
      for (const [i, event] of events.entries()) {
        const durability = this.#opts.durability;
        const signed = event as unknown as Event;
        // 同一身分的事件預算；限速就退避再重送（SDK ADR 0043）。沒設定耐久度時照舊只傳一個參數（v0.32 的呼叫形狀）
        const result = await publishPaced(
          this.#budget,
          () => (durability === undefined ? this.#opts.pool.publish(signed) : this.#opts.pool.publish(signed, { durability })),
          // 部分拒收也回報（SDK ADR 0038 P0-C）；每一次嘗試都報（含之後重送成功的限速拒收）
          { done: (r) => meetsDurability(r, durability), onAttempt: (r) => reportPublishRejections(event.id, r, this.#opts.onPublishRejected) },
        );
        if (!meetsDurability(result, durability)) failed.push(to[i]!);
      }
      if (failed.length > 0) throw new Error(`名單送不出去（${failed.length} 台）`);
    });
    this.#sending = run.then(
      // 完整送給全部成員才清掉「未送出」標記；只送給指定收件人的不算（G12d）
      () => {
        if (toAll) this.#setPending(false);
      },
      (error: unknown) => {
        this.#setPending(true);
        this.#opts.onError?.(error);
      },
    );
    return run;
  }

  #onChange(change: MembershipChange): void {
    if (change.selfRevoked) return; // 被撤銷了：不再送任何東西
    // 這台撤銷的：通知被撤銷的裝置（SDK ADR 0105）。當下就包好——撤銷時輪換出來的新金鑰是現在的金鑰，不能放進去。
    // 從別台合併得知的撤銷不送（撤銷的那台送過了）
    if (change.reason === 'revoke' && change.revoked.length > 0) this.#notifyRevoked(change.revoked);
    void this.announce().catch(() => {});
  }

  #notifyRevoked(revoked: readonly string[]): void {
    const m = this.#opts.membership;
    const exclude = [m.currentKey().id];
    const now = (this.#opts.now ?? Date.now)();
    for (const pk of revoked) {
      const event = buildRevocationNotice(m, this.#opts.signer, pk, { excludeKeyIds: exclude, now, ttlSeconds: this.#opts.ttlSeconds, outerKind: this.#outerKind });
      if (!event) continue;
      const signed = event as unknown as Event;
      const durability = this.#opts.durability;
      // 盡力而為：送不到只回報，不記成「有未送出的名單變動」（那是給還是成員的裝置的）
      void publishPaced(
        this.#budget,
        () => (durability === undefined ? this.#opts.pool.publish(signed) : this.#opts.pool.publish(signed, { durability })),
        { done: (r) => meetsDurability(r, durability), onAttempt: (r) => reportPublishRejections(event.id, r, this.#opts.onPublishRejected) },
      ).catch((error: unknown) => this.#opts.onError?.(error));
    }
  }

  #ingest(event: Event): void {
    if (event.kind !== this.#outerKind || this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    if (this.#seen.size > SEEN) this.#seen.delete(this.#seen.values().next().value!);
    const opened = openRosterEvent(event, this.#opts.signer, { outerKind: this.#outerKind });
    if (!opened) {
      // 中繼搬家通知（SDK ADR 0052）：寄件人必須是本機名單上的有效成員（非成員偽造的不交出）
      const onMove = this.#opts.onRelayMove;
      if (!onMove && !this.#opts.onMemberActivity) return;
      const move = openRelayMoveEvent(event, this.#opts.signer, { outerKind: this.#outerKind });
      if (move && this.#opts.membership.isMember(move.sender)) {
        this.#activity(move.sender, move.at);
        onMove?.(move);
      }
      return;
    }
    // 合併之前先看：這則可能正好撤銷了寄件人以外的人，寄件人本身要是收到時的有效成員
    const member = this.#opts.membership.isMember(opened.sender);
    this.#opts.membership.merge(opened.roster, opened.sender);
    if (member) this.#activity(opened.sender, opened.sentAt);
  }

  #activity(pubkey: string, at: number): void {
    const listener = this.#opts.onMemberActivity;
    if (!listener) return;
    const deviceId = this.#opts.membership.deviceIdOf(pubkey);
    try {
      listener({ pubkey, ...(deviceId !== undefined ? { deviceId } : {}), at });
    } catch (error) {
      this.#opts.onError?.(error);
    }
  }
}
