// 手機端（成員）的 IoT API（SDK ADR 0049 §3）：不需要知道對面是路線 A、B 還是 C。
//
// - `command`：kind 25170，等閘道的 25171 ack；QoS 1 逾時以指數退避重送——**每次重新簽章（新 id）、同一個 msgId**，
//   同一顆事件重送會被中繼回 `duplicate` 而不扇出（ADR 0040）；閘道以 msgId 去重、重送同樣的 ack（冪等）。
// - `query`：kind 25173，要求設備立刻回報；閘道節流時以 retained 回覆（`throttled`、`fromRetained`）。
// - `subscribeState`：kind 25172，MQTT 樣式萬用字元（`#`→`#tp`、`+`→較寬前綴＋客戶端比對）。
// - `getRetained`／`listDevices`：讀 31170，不經閘道、不打擾設備。`watchGateway`：31171 心跳。`myRole`：讀名單（`sys:acl`）。
// - **只收閘道簽的狀態類事件**（`authors=[閘道]`＋驗簽＋作者再比對一次；ADR 0049 §6 的主要防線）。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { PubkeyHex } from '../protocol/keys.js';
import { encryptWithKey } from '../protocol/nip44.js';
import type { NostrSigner } from '../protocol/signer.js';
import type { ClassifiedRejection } from '../publish-rejections.js';
import { RelayEventBudget, sharedRelayEventBudget } from '../relay-budget.js';
import type { Subscription } from '../relay-pool.js';
import { iotPubkeyOf, iotRoleOf, parseIotAcl, type IotAcl, type IotAclEntryInput, type IotRole } from './acl.js';
import {
  buildIotEvent,
  expirationOf,
  IotKeyring,
  newIotMsgId,
  tagValue,
  type IotAckBody,
  type IotAckStatus,
  type IotEncoding,
  type IotRetainedBody,
  type IotTopicValue,
} from './content.js';
import { iotBlindNames, type IotHome } from './keys.js';
import {
  iotPushEndpointId,
  parseIotPushEndpoint,
  parseIotPushSubscriptions,
  type IotPushEndpoint,
  type IotPushMode,
  type IotPushSpecial,
  type IotPushSubscription,
} from './push.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE, IOT_MAX_TTL_SEC } from './kinds.js';
import { clampIot, IotReplayGuard } from './replay.js';
import { mergeIotRetained } from './retained.js';
import { assertIotTopic, IOT_ACL_TOPIC, IOT_PUSH_TOPIC, isValidIotDeviceId, topicMatches, topicSubscriptionPlan } from './topic.js';
import { iotPublish, iotQuery, iotVerified, type IotTransport } from './transport.js';

export const IOT_DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
export const IOT_DEFAULT_COMMAND_RETRIES = 2;
export const IOT_DEFAULT_TTL_SEC = 30;
export const IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS = 8_000;
/** retained 多久沒更新就視為不可信（秒）：閘道每 6 小時刷新一次，留兩輪＋一小時 */
export const IOT_DEFAULT_STALE_AFTER_SEC = 13 * 3600;

export type IotCommandStatus = IotAckStatus | 'relay-rejected';

export interface IotCommandResult {
  readonly status: IotCommandStatus;
  readonly msgId: string;
  /** 送了幾次（QoS 1 的重送也算） */
  readonly attempts: number;
  readonly ackedAt?: number;
  readonly reason?: string;
  /** `relay-rejected`：每一座中繼的拒收（ADR 0040 詞元分類） */
  readonly rejected?: readonly ClassifiedRejection[];
}

export interface IotCommandOptions {
  /** 0＝送一次、等 ack 一次；1（預設）＝逾時以指數退避重送 */
  qos?: 0 | 1;
  /** 第一次等 ack 多久（毫秒），預設 3,000；之後每次加倍 */
  timeoutMs?: number;
  /** QoS 1 最多重送幾次（不含第一次），預設 2；超過指令存活時間就不再送 */
  retries?: number;
  /** 指令存活（秒），預設 30，夾 5–300（NIP-40 `expiration`） */
  ttlSec?: number;
  /** 設備 id（角色名單依設備細分時閘道會用；不給由閘道的 topic 對照表推出） */
  device?: string;
  enc?: IotEncoding;
  /** 標了 `confirm: true` 的 topic 需要明確確認 */
  confirmed?: boolean;
}

/** 推播訂閱（App 端以設備 id 表示；送出前換成盲化 id）。`mode` 預設 `standard`（ADR 0049 §11.1 裁示 2） */
export type IotPushSubscriptionInput = { readonly device: string; readonly mode?: IotPushMode } | { readonly special: IotPushSpecial; readonly mode?: IotPushMode };

export interface IotPushRegisterOptions extends Omit<IotCommandOptions, 'device' | 'enc' | 'confirmed'> {
  /** 登記的存活（秒），預設 30 天；App 啟動時再登記一次就是續期 */
  registrationTtlSec?: number;
}

export interface IotDeviceState {
  readonly topics: Readonly<Record<string, IotTopicValue>>;
  /** 毫秒 */
  readonly ts: number;
}

export interface IotQueryResult {
  readonly status: IotAckStatus;
  readonly state?: IotDeviceState;
  /** 狀態來自 retained（節流、逾時、設備不支援查詢），不是設備此刻的回報 */
  readonly fromRetained: boolean;
  readonly reason?: string;
}

export interface IotStateMessage {
  readonly topic: string;
  readonly payload: string;
  readonly enc: IotEncoding;
  readonly ts: number;
  readonly device?: string;
  readonly live: true;
  readonly will?: boolean;
  /** 查詢的回報：查詢的 msgId */
  readonly inReplyTo?: string;
}

export interface IotRetainedState {
  readonly device: string;
  readonly topics: Readonly<Record<string, IotTopicValue>>;
  readonly ts: number;
  readonly online?: boolean;
  /** 太久沒更新（超過 `staleAfterSec`），值可能已經不對 */
  readonly stale: boolean;
  readonly complete: boolean;
}

export interface IotDeviceInfo {
  readonly device: string;
  readonly online?: boolean;
  readonly lastSeen: number;
  readonly topicCount: number;
  readonly stale: boolean;
}

export interface IotGatewayStatus {
  readonly online: boolean;
  /** 最後一次心跳（毫秒）；沒有心跳＝undefined */
  readonly lastSeen?: number;
}

export interface IotClientOptions {
  pool: IotTransport;
  /** 成員自己的 Nostr 身分（ADR 0023） */
  signer: NostrSigner;
  home: IotHome;
  /** 閘道公鑰（npub 或 hex）；可從配對或 NIP-11 取得 */
  gateway: string;
  /** 事件預算；預設與同一身分的信令、名單、Vault 同步共用（ADR 0043） */
  budget?: RelayEventBudget;
  /** 狀態與 ack 的時間窗（秒），預設 30，夾 5–120 */
  maxSkewSec?: number;
  staleAfterSec?: number;
  /** 一次性查詢（retained、名單）等多久（毫秒），預設 5,000 */
  readTimeoutMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

interface AckWaiter {
  resolve(ack: IotAckBody): void;
}

export class IotClient {
  readonly #o: IotClientOptions;
  readonly #gateway: PubkeyHex;
  readonly #keyring: IotKeyring;
  readonly #budget: RelayEventBudget;
  readonly #now: () => number;
  readonly #ackGuard: IotReplayGuard<true>;
  readonly #waiters = new Map<string, Set<AckWaiter>>();
  #acks: Subscription | undefined;
  readonly #subs = new Set<Subscription>();
  readonly #wakers = new Set<() => void>();
  #closed = false;

  constructor(opts: IotClientOptions) {
    this.#o = opts;
    this.#gateway = iotPubkeyOf(opts.gateway);
    this.#keyring = new IotKeyring(opts.home, opts.signer);
    this.#budget = opts.budget ?? sharedRelayEventBudget(opts.signer.pubkey);
    this.#now = opts.now ?? Date.now;
    this.#ackGuard = new IotReplayGuard({ maxSkewSec: opts.maxSkewSec, now: this.#now });
  }

  get gateway(): PubkeyHex {
    return this.#gateway;
  }

  /** 關掉所有訂閱 */
  close(): void {
    this.#acks?.close();
    this.#acks = undefined;
    for (const sub of this.#subs) sub.close();
    this.#subs.clear();
    this.#closed = true;
    for (const wake of [...this.#wakers]) wake();
  }

  // ── 操作與查詢 ────────────────────────────────────────────────────

  /** 下一則操作（kind 25170），等 ack */
  async command(topic: string, payload: string, opts: IotCommandOptions = {}): Promise<IotCommandResult> {
    assertIotTopic(topic);
    if (opts.device !== undefined && !isValidIotDeviceId(opts.device)) throw new RangeError(`設備 id 不合法：${opts.device}`);
    const qos = opts.qos ?? 1;
    const timeoutMs = Math.max(1, opts.timeoutMs ?? IOT_DEFAULT_COMMAND_TIMEOUT_MS);
    const retries = qos === 1 ? Math.max(0, Math.floor(opts.retries ?? IOT_DEFAULT_COMMAND_RETRIES)) : 0;
    const ttlSec = clampIot(opts.ttlSec, IOT_DEFAULT_TTL_SEC, 5, IOT_MAX_TTL_SEC);
    const msgId = newIotMsgId();
    const ts = this.#now();
    const expiration = Math.floor(ts / 1000) + ttlSec;
    const body = {
      v: 1 as const,
      type: 'cmd' as const,
      msgId,
      ts,
      topic,
      ...(opts.device !== undefined ? { device: opts.device } : {}),
      payload,
      enc: opts.enc ?? 'utf8',
      qos,
      ...(opts.confirmed !== undefined ? { confirmed: opts.confirmed } : {}),
    };
    const tags = [
      ['h', this.#o.home.homeTag],
      ['t', this.#o.home.blind(topic)],
      ['p', this.#gateway],
      ['expiration', String(expiration)],
    ];
    // ack 原文只給 query() 用；command() 的結果不帶它
    const { ack: _ack, ...result } = await this.#sendAndWait(IOT_KIND_COMMAND, tags, body, { msgId, timeoutMs, retries, expiration });
    return result;
  }

  /** 要求設備立刻回報（kind 25173，`viewer` 以上）；閘道節流或逾時時回 retained */
  async query(device: string, opts: { timeoutMs?: number; ttlSec?: number } = {}): Promise<IotQueryResult> {
    if (!isValidIotDeviceId(device)) throw new RangeError(`設備 id 不合法：${device}`);
    const msgId = newIotMsgId();
    const ts = this.#now();
    const ttlSec = clampIot(opts.ttlSec, IOT_DEFAULT_TTL_SEC, 5, IOT_MAX_TTL_SEC);
    const expiration = Math.floor(ts / 1000) + ttlSec;
    const tags = [
      ['h', this.#o.home.homeTag],
      ['dv', this.#o.home.blind(iotBlindNames.device(device))],
      ['p', this.#gateway],
      ['expiration', String(expiration)],
    ];
    const timeoutMs = Math.max(1, opts.timeoutMs ?? IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS);
    const result = await this.#sendAndWait(IOT_KIND_QUERY, tags, { v: 1, type: 'query', msgId, ts, device }, { msgId, timeoutMs, retries: 0, expiration });
    if (result.ack) {
      const ack = result.ack;
      return {
        status: ack.status,
        ...(ack.topics !== undefined ? { state: { topics: ack.topics, ts: ack.ts } } : {}),
        fromRetained: ack.fromRetained === true || ack.status === 'throttled',
        ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
      };
    }
    // 閘道沒回（或中繼沒收）：退回 retained
    const retained = await this.getRetained(device).catch(() => undefined);
    return {
      status: 'timeout',
      ...(retained ? { state: { topics: retained.topics, ts: retained.ts } } : {}),
      fromRetained: true,
      ...(result.status === 'relay-rejected' ? { reason: 'relay-rejected' } : {}),
    };
  }

  /** 改角色名單（只有 owner 會成功；ADR 0049 §2.5） */
  updateAcl(op: { op: 'add'; entry: IotAclEntryInput } | { op: 'remove'; pubkey: string }, opts: Omit<IotCommandOptions, 'device' | 'enc'> = {}): Promise<IotCommandResult> {
    return this.command(IOT_ACL_TOPIC, JSON.stringify(op), opts);
  }

  /**
   * 登記（或更新）推播端點（ADR 0049 §11.1）：送到閘道的保留 topic `$sys/push`。端點本身再以 NIP-44 加密給閘道，其他成員讀不到；
   * 同一個端點再登記一次＝更新訂閱與續期。額度預警（`special: 'quota'`）只有 owner 能訂閱。
   * 端點怎麼來：UnifiedPush 網址由 App 的 distributor 給；推播閘道端點由 App 以 `sealIotPushToken` 封自己的 FCM／APNs token
   *（SDK 不做 FCM／APNs 註冊，ADR 0011 §6）。
   */
  async registerPush(endpoint: IotPushEndpoint, subscriptions: readonly IotPushSubscriptionInput[], opts: IotPushRegisterOptions = {}): Promise<IotCommandResult & { endpointId: string }> {
    const ep = parseIotPushEndpoint(endpoint, { allowPrivateHttp: true }); // 能不能用 http 由閘道決定
    const subs: IotPushSubscription[] = parseIotPushSubscriptions(
      subscriptions.map((s) => {
        if ('device' in s) {
          if (!isValidIotDeviceId(s.device)) throw new RangeError(`設備 id 不合法：${s.device}`);
          return { dv: this.#o.home.blind(iotBlindNames.device(s.device)), mode: s.mode ?? 'standard' };
        }
        return { special: s.special, mode: s.mode ?? 'standard' };
      }),
    );
    const sealedForGateway = encryptWithKey(JSON.stringify(ep), this.#o.signer.conversationKey(this.#gateway));
    const { registrationTtlSec, ...command } = opts;
    const payload = JSON.stringify({ op: 'register', endpoint: sealedForGateway, subscriptions: subs, ...(registrationTtlSec !== undefined ? { ttlSec: registrationTtlSec } : {}) });
    const result = await this.command(IOT_PUSH_TOPIC, payload, command);
    return { ...result, endpointId: iotPushEndpointId(ep) };
  }

  /** 更新推播訂閱或續期（＝再登記一次同一個端點） */
  updatePush(endpoint: IotPushEndpoint, subscriptions: readonly IotPushSubscriptionInput[], opts: IotPushRegisterOptions = {}): Promise<IotCommandResult & { endpointId: string }> {
    return this.registerPush(endpoint, subscriptions, opts);
  }

  /** 撤銷推播端點（自己的；owner 可以撤銷任何人的）。推播閘道那一側另以 `buildIotPushRevokeBody` 撤銷封包 */
  revokePush(endpointOrId: IotPushEndpoint | string, opts: Omit<IotCommandOptions, 'device' | 'enc' | 'confirmed'> = {}): Promise<IotCommandResult> {
    const id = typeof endpointOrId === 'string' ? endpointOrId : iotPushEndpointId(parseIotPushEndpoint(endpointOrId, { allowPrivateHttp: true }));
    return this.command(IOT_PUSH_TOPIC, JSON.stringify({ op: 'remove', id }), opts);
  }

  async #sendAndWait(
    kind: number,
    tags: string[][],
    body: Parameters<IotKeyring['seal']>[0],
    p: { msgId: string; timeoutMs: number; retries: number; expiration: number },
  ): Promise<IotCommandResult & { ack?: IotAckBody }> {
    this.#ensureAcks();
    let acked: IotAckBody | undefined;
    let wake: (() => void) | undefined;
    const waiter: AckWaiter = {
      resolve: (ack) => {
        acked ??= ack;
        wake?.();
      },
    };
    const set = this.#waiters.get(p.msgId) ?? new Set<AckWaiter>();
    set.add(waiter);
    this.#waiters.set(p.msgId, set);
    let attempts = 0;
    let lastRejected: readonly ClassifiedRejection[] | undefined;
    try {
      for (let attempt = 0; attempt <= p.retries && !this.#closed; attempt += 1) {
        if (attempt > 0 && Math.floor(this.#now() / 1000) >= p.expiration) break; // 指令已過期：不再送
        // 每次重新簽章（新的 created_at 與 NIP-44 nonce ⇒ 新 id），內容的 msgId 與 ts 不變
        const event = buildIotEvent(this.#keyring, this.#o.signer, kind, tags, body);
        attempts += 1;
        const outcome = await iotPublish(this.#o.pool, this.#budget, event);
        if (acked) break;
        lastRejected = outcome.ok ? undefined : outcome.rejected;
        await this.#pause(p.timeoutMs * 2 ** attempt, (w) => {
          wake = w;
        });
        wake = undefined;
        if (acked) break;
      }
    } finally {
      set.delete(waiter);
      if (set.size === 0) this.#waiters.delete(p.msgId);
    }
    const ack = acked as IotAckBody | undefined;
    if (ack) {
      return { status: ack.status, msgId: p.msgId, attempts, ackedAt: ack.ts, ...(ack.reason !== undefined ? { reason: ack.reason } : {}), ack };
    }
    if (lastRejected) return { status: 'relay-rejected', msgId: p.msgId, attempts, rejected: lastRejected };
    return { status: 'timeout', msgId: p.msgId, attempts };
  }

  /** 等 `ms` 毫秒，或被叫醒（收到 ack、`close()`） */
  #pause(ms: number, register: (wake: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.#wakers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#wakers.add(finish);
      register(finish);
    });
  }

  #ensureAcks(): void {
    if (this.#acks) return;
    const filter: Filter = { kinds: [IOT_KIND_ACK], authors: [this.#gateway], '#p': [this.#o.signer.pubkey], '#h': [this.#o.home.homeTag] };
    this.#acks = this.#o.pool.subscribe([filter], { onEvent: (event) => this.#onAck(event) });
  }

  #onAck(event: Event): void {
    if (event.kind !== IOT_KIND_ACK || event.pubkey !== this.#gateway || !iotVerified(event)) return;
    if (tagValue(event, 'h') !== this.#o.home.homeTag) return;
    const body = this.#keyring.open(event.content, event.pubkey);
    if (!body || body.type !== 'ack') return;
    const waiters = this.#waiters.get(body.inReplyTo);
    if (!waiters) return;
    const verdict = this.#ackGuard.check(body.msgId, body.ts);
    if (verdict.verdict !== 'fresh') return;
    for (const w of waiters) w.resolve(body);
  }

  // ── 狀態 ─────────────────────────────────────────────────────────

  /** 訂閱即時狀態（kind 25172）；`pattern` 是 MQTT 樣式（`+`、`#`） */
  subscribeState(pattern: string, onMessage: (message: IotStateMessage) => void): { close(): void } {
    const plan = topicSubscriptionPlan(pattern);
    const blind = this.#o.home.blind;
    const filter: Filter = { kinds: [IOT_KIND_STATE], authors: [this.#gateway], '#h': [this.#o.home.homeTag] };
    if (plan.by === 'exact') filter['#t'] = [blind(plan.value)];
    if (plan.by === 'prefix') filter['#tp'] = [blind(plan.value)];
    const guard = new IotReplayGuard<true>({ maxSkewSec: this.#o.maxSkewSec, now: this.#now });
    const sub = this.#o.pool.subscribe([filter], {
      onEvent: (event) => {
        if (event.kind !== IOT_KIND_STATE || event.pubkey !== this.#gateway || !iotVerified(event)) return;
        const body = this.#keyring.open(event.content, event.pubkey);
        if (!body || body.type !== 'state') return;
        if (tagValue(event, 't') !== blind(body.topic) || !topicMatches(pattern, body.topic)) return;
        if (guard.check(body.msgId, body.ts).verdict !== 'fresh') return;
        try {
          onMessage({
            topic: body.topic,
            payload: body.payload,
            enc: body.enc,
            ts: body.ts,
            ...(body.device !== undefined ? { device: body.device } : {}),
            live: true,
            ...(body.will !== undefined ? { will: body.will } : {}),
            ...(body.inReplyTo !== undefined ? { inReplyTo: body.inReplyTo } : {}),
          });
        } catch (error) {
          this.#o.onError?.(error);
        }
      },
    });
    this.#subs.add(sub);
    return {
      close: () => {
        sub.close();
        this.#subs.delete(sub);
      },
    };
  }

  async #readRetained(filter: Filter): Promise<{ event: Event; body: ReturnType<IotKeyring['open']> }[]> {
    const events = await iotQuery(this.#o.pool, [filter], this.#o.readTimeoutMs ?? 5_000);
    const out: { event: Event; body: ReturnType<IotKeyring['open']> }[] = [];
    for (const event of events) {
      if (event.kind !== IOT_KIND_RETAINED || event.pubkey !== this.#gateway || !iotVerified(event)) continue;
      if (tagValue(event, 'h') !== this.#o.home.homeTag) continue;
      const exp = expirationOf(event);
      if (exp !== undefined && exp <= Math.floor(this.#now() / 1000)) continue;
      out.push({ event, body: this.#keyring.open(event.content, event.pubkey) });
    }
    return out;
  }

  #stale(ts: number): boolean {
    return this.#now() - ts > (this.#o.staleAfterSec ?? IOT_DEFAULT_STALE_AFTER_SEC) * 1000;
  }

  /** 讀一台設備的 retained（31170），不打擾設備；沒有回 undefined */
  async getRetained(device: string): Promise<IotRetainedState | undefined> {
    if (!isValidIotDeviceId(device)) throw new RangeError(`設備 id 不合法：${device}`);
    const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [this.#gateway], '#dv': [this.#o.home.blind(iotBlindNames.device(device))] });
    const parts = rows.map((r) => r.body).filter((b): b is IotRetainedBody => b?.type === 'retained' && b.device === device);
    const merged = mergeIotRetained(parts);
    if (!merged) return undefined;
    return { ...merged, stale: this.#stale(merged.ts) };
  }

  /** 這個家所有有 retained 的設備 */
  async listDevices(): Promise<IotDeviceInfo[]> {
    const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [this.#gateway], '#h': [this.#o.home.homeTag] });
    const byDevice = new Map<string, IotRetainedBody[]>();
    for (const { body } of rows) {
      if (body?.type !== 'retained') continue;
      const list = byDevice.get(body.device) ?? [];
      list.push(body);
      byDevice.set(body.device, list);
    }
    const out: IotDeviceInfo[] = [];
    for (const [device, parts] of byDevice) {
      const merged = mergeIotRetained(parts)!;
      out.push({
        device,
        ...(merged.online !== undefined ? { online: merged.online } : {}),
        lastSeen: merged.ts,
        topicCount: Object.keys(merged.topics).length,
        stale: this.#stale(merged.ts),
      });
    }
    return out.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  }

  /** 閘道目前的角色名單（閘道發的 31170 `sys:acl`）；讀不到或格式不對回 undefined */
  async getAcl(): Promise<IotAcl | undefined> {
    const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [this.#gateway], '#d': [this.#o.home.blind(iotBlindNames.acl)] });
    const newest = rows
      .map((r) => r.body)
      .filter((b) => b?.type === 'acl')
      .sort((a, b) => b!.ts - a!.ts)[0];
    if (newest?.type !== 'acl') return undefined;
    try {
      return parseIotAcl(newest.acl);
    } catch {
      return undefined;
    }
  }

  /** 自己在閘道名單上的角色（讀 `sys:acl`）；不在名單或過期回 undefined */
  async myRole(): Promise<IotRole | undefined> {
    const acl = await this.getAcl();
    return acl ? iotRoleOf(acl, this.#o.signer.pubkey, Math.floor(this.#now() / 1000)) : undefined;
  }

  /** 看閘道死活（31171 心跳；過期＝離線）。回傳停止函式 */
  watchGateway(onStatus: (status: IotGatewayStatus) => void): () => void {
    let latest: { ts: number; online: boolean; expiresAt: number } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReported: string | undefined;
    const report = (): void => {
      const now = this.#now();
      const online = latest !== undefined && latest.online && latest.expiresAt * 1000 > now;
      const status: IotGatewayStatus = { online, ...(latest ? { lastSeen: latest.ts } : {}) };
      const key = JSON.stringify(status);
      if (key === lastReported) return;
      lastReported = key;
      try {
        onStatus(status);
      } catch (error) {
        this.#o.onError?.(error);
      }
    };
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (!latest?.online) return;
      const ms = latest.expiresAt * 1000 - this.#now();
      if (ms <= 0) return;
      timer = setTimeout(report, ms + 50);
    };
    const filter: Filter = { kinds: [IOT_KIND_HEARTBEAT], authors: [this.#gateway], '#d': [this.#o.home.blind(iotBlindNames.gateway)] };
    const sub = this.#o.pool.subscribe([filter], {
      onEvent: (event) => {
        if (event.kind !== IOT_KIND_HEARTBEAT || event.pubkey !== this.#gateway || !iotVerified(event)) return;
        if (tagValue(event, 'h') !== this.#o.home.homeTag) return;
        const body = this.#keyring.open(event.content, event.pubkey);
        const expiresAt = expirationOf(event);
        if (body?.type !== 'gw' || expiresAt === undefined) return;
        if (latest && body.ts <= latest.ts) return;
        latest = { ts: body.ts, online: body.online, expiresAt };
        report();
        arm();
      },
      onEose: () => report(),
    });
    this.#subs.add(sub);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      sub.close();
      this.#subs.delete(sub);
    };
  }
}
