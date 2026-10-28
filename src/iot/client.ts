// 手機端（成員）的 IoT API（SDK ADR 0049 §3）：不需要知道對面是路線 A、B 還是 C。
//
// - `command`：kind 25170，等閘道的 25171 ack；QoS 1 逾時以指數退避重送——**每次重新簽章（新 id）、同一個 msgId**，
//   同一顆事件重送會被中繼回 `duplicate` 而不扇出（ADR 0040）；閘道以 msgId 去重、重送同樣的 ack（冪等）。
// - `query`：kind 25173，要求設備立刻回報；閘道節流時以 retained 回覆（`throttled`、`fromRetained`）。
// - `subscribeState`：kind 25172，MQTT 樣式萬用字元（`#`→`#tp`、`+`→較寬前綴＋客戶端比對）。
// - `getRetained`／`listDevices`：讀 31170，不經閘道、不打擾設備。`watchGateway`：31171 心跳。`myRole`：讀名單（`sys:acl`）。
// - **只收閘道簽的狀態類事件**（`authors=[閘道]`＋驗簽＋作者再比對一次；ADR 0049 §6 的主要防線）。
// - C′ 即時通道（ADR 0049 §9、SDK ADR 0120）：`realtime.devices` 列出的設備走 relay 的家庭端點——指令外層加密給 relay 的閘道公鑰、
//   內層是設備信封（relay 看不到 topic 與內容）；`urgency: 'realtime'` 時 ttl 15 秒、等 ack 5 秒，逾時回 `unknown` 並自動查一次。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { NostrEvent } from '../protocol/event.js';
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
  type IotBody,
  type IotDeviceReportBody,
  type IotEncoding,
  type IotRetainedBody,
  type IotTopicValue,
} from './content.js';
import { parseIotUpMessage, type IotUpMessage } from './device-message.js';
import { deriveIotDeviceKeyDown, iotKid, openIotEnvelope, parseIotKid, sealIotEnvelope } from './envelope.js';
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
import { IOT_QUOTA_REJECTION as QUOTA_REJECTION, iotPublish, iotQuery, iotQuotaHold, iotVerified, type IotTransport } from './transport.js';

export const IOT_DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
export const IOT_DEFAULT_COMMAND_RETRIES = 2;
export const IOT_DEFAULT_TTL_SEC = 30;
export const IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS = 8_000;
/** retained 多久沒更新就視為不可信（秒）：閘道每 6 小時刷新一次，留兩輪＋一小時 */
export const IOT_DEFAULT_STALE_AFTER_SEC = 13 * 3600;

/** 即時等級（ADR 0049 §9.4 裁示 5）：ttl 預設 15 秒、夾 5–60；等 ack 預設 5 秒、不重送 */
export const IOT_REALTIME_DEFAULT_TTL_SEC = 15;
export const IOT_REALTIME_MAX_TTL_SEC = 60;
export const IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS = 5_000;

/**
 * `unknown`＝即時等級逾時沒有 ack：**結果未知，不是失敗**（設備可能已經執行、只是 ack 沒回來），SDK 已自動查一次、結果在 `after`。
 * `quota`＝中繼今日額度用完（ADR 0049 §10），有的話附 `reset`。
 */
export type IotCommandStatus = IotAckStatus | 'relay-rejected' | 'unknown';

export interface IotCommandResult {
  readonly status: IotCommandStatus;
  readonly msgId: string;
  /** 送了幾次（QoS 1 的重送也算） */
  readonly attempts: number;
  readonly ackedAt?: number;
  readonly reason?: string;
  /** `relay-rejected`：每一座中繼的拒收（ADR 0040 詞元分類） */
  readonly rejected?: readonly ClassifiedRejection[];
  /** C′ 設備的 ack 附帶的狀態（執行後的值） */
  readonly state?: IotDeviceState;
  /** `unknown`：自動查詢的結果 */
  readonly after?: IotQueryResult;
  /** `quota`：額度重置時間（unix 秒） */
  readonly reset?: number;
}

export interface IotCommandOptions {
  /** 0＝送一次、等 ack 一次；1（預設）＝逾時以指數退避重送 */
  qos?: 0 | 1;
  /** 第一次等 ack 多久（毫秒），預設 3,000（即時等級 5,000）；之後每次加倍 */
  timeoutMs?: number;
  /** QoS 1 最多重送幾次（不含第一次），預設 2（即時等級 0）；超過指令存活時間就不再送 */
  retries?: number;
  /** 指令存活（秒），預設 30，夾 5–300（NIP-40 `expiration`）；即時等級預設 15、夾 5–60 */
  ttlSec?: number;
  /**
   * `realtime`（門、車庫門、警報解除）：不排隊、等 ack `ackTimeoutMs`（預設 5 秒），逾時回 `unknown` 並自動查詢一次（ADR 0049 §9.4）。
   * 預設 `normal`。
   */
  urgency?: 'normal' | 'realtime';
  /** 即時等級等 ack 多久（毫秒）；與 `timeoutMs` 同義，兩個都給以這個為準 */
  ackTimeoutMs?: number;
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

/** C′ 設備（ADR 0049 §9）：手機端只需要知道它的金鑰版本與類別 */
export interface IotRealtimeDeviceRef {
  /** 金鑰版本（kid 的 epoch），預設 0；設備輪換金鑰後跟著改 */
  readonly epoch?: number;
  /**
   * 輪換寬限（與 relay 設定的同名欄位相同；`iot realtime device --rotate` 會印出來，SDK ADR 0122）：
   * `until`（unix 秒）之前，舊版本的設備回報照收，指令改用設備最近一次開口的版本，讓還沒更新的設備也收得到。
   */
  readonly previousEpoch?: { readonly epoch: number; readonly until: number };
  /** `lock`（門、門鎖、車庫門、門禁）：指令的 down 金鑰由 `operatorSecret` 導出（§9.5），viewer＋被攻破的 relay 也開不了 */
  readonly class?: 'lock' | 'general';
  /** 非門鎖類也選用 `operatorSecret`（§9.5） */
  readonly operatorSecret?: boolean;
}

export interface IotRealtimeClientOptions {
  /** 設備 id → 設定。不在這裡的設備照原本的閘道路線（A／B） */
  readonly devices: Readonly<Record<string, IotRealtimeDeviceRef>>;
  /** 只發給 operator／owner 的秘密（ADR 0028 配對時交付）；沒有它就送不出門鎖類的指令 */
  readonly operatorSecret?: Uint8Array | string;
  /** 連到 relay 家庭端點 `/iot/v1/home/<homeTag>` 的連線池；沒給＝與 `pool` 相同 */
  readonly pool?: IotTransport;
  /** relay 的閘道公鑰（`IOT_REALTIME` 的 `gatewayPubkey`）；沒給＝與 `gateway` 相同 */
  readonly gateway?: string;
}

/** `deviceLink()` 的結果：C′ 由 relay 即時回答（不落庫）；其他路線看 retained 的 `online` */
export interface IotDeviceLink {
  readonly transport: 'ws' | 'gateway';
  /** 問到了沒：`ok`，或 relay 的拒絕（`not-allowed`）、`unknown`（沒回）、`quota`… */
  readonly status: IotCommandStatus;
  readonly online?: boolean;
  /** C′：設備最後一次心跳（毫秒） */
  readonly lastHeartbeat?: number;
  /** 閘道路線：retained 的時間（毫秒） */
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
  /** C′ 即時通道的設備（ADR 0049 §9） */
  realtime?: IotRealtimeClientOptions;
  now?: () => number;
  onError?: (error: unknown) => void;
}

interface AckWaiter {
  resolve(ack: IotAckBody): void;
}

/** 一條「連線池＋閘道」：閘道路線與 C′ 可以是不同的中繼與公鑰 */
interface Route {
  readonly pool: IotTransport;
  readonly gateway: PubkeyHex;
  acks?: Subscription;
}

interface RealtimeDevice {
  readonly id: string;
  readonly epoch: number;
  readonly previous?: { readonly epoch: number; readonly until: number };
  readonly downByOperator: boolean;
  /** 設備最近一次開口（解得開的 up 信封）用的版本與時間（毫秒）：寬限期內指令跟著它（SDK ADR 0122） */
  heard?: { epoch: number; at: number };
}

export class IotClient {
  readonly #o: IotClientOptions;
  readonly #gateway: PubkeyHex;
  readonly #keyring: IotKeyring;
  readonly #budget: RelayEventBudget;
  readonly #now: () => number;
  readonly #ackGuard: IotReplayGuard<true>;
  /** C′ up 信封的重放保護（`kid#ctr` × 信封時間）：ack 與狀態走不同的訂閱、可能亂序，所以不用「嚴格遞增」 */
  readonly #upGuard: IotReplayGuard<true>;
  readonly #waiters = new Map<string, Set<AckWaiter>>();
  readonly #main: Route;
  readonly #rt: Route | undefined;
  readonly #rtDevices = new Map<string, RealtimeDevice>();
  readonly #operatorSecret: Uint8Array | string | undefined;
  /** down 信封的 ctr：發送端自己的序號（只進 AAD） */
  #downCtr = 0;
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
    this.#upGuard = new IotReplayGuard({ maxSkewSec: opts.maxSkewSec, now: this.#now });
    this.#main = { pool: opts.pool, gateway: this.#gateway };
    const rt = opts.realtime;
    if (rt) {
      const gateway = rt.gateway !== undefined ? iotPubkeyOf(rt.gateway) : this.#gateway;
      const pool = rt.pool ?? opts.pool;
      this.#rt = pool === opts.pool && gateway === this.#gateway ? this.#main : { pool, gateway };
      for (const [id, ref] of Object.entries(rt.devices)) {
        if (!isValidIotDeviceId(id)) throw new RangeError(`設備 id 不合法：${id}`);
        const epoch = ref.epoch ?? 0;
        iotKid(id, epoch); // 檢查 epoch
        const prev = ref.previousEpoch;
        if (prev !== undefined && (!Number.isSafeInteger(prev.epoch) || prev.epoch < 0 || prev.epoch >= epoch || !Number.isSafeInteger(prev.until))) {
          throw new RangeError(`設備 ${id} 的 previousEpoch 要是比 epoch 小的非負整數，until 要是整數（unix 秒）`);
        }
        this.#rtDevices.set(id, { id, epoch, ...(prev !== undefined ? { previous: { epoch: prev.epoch, until: prev.until } } : {}), downByOperator: ref.class === 'lock' || ref.operatorSecret === true });
      }
      this.#operatorSecret = rt.operatorSecret;
    }
  }

  get gateway(): PubkeyHex {
    return this.#gateway;
  }

  /** 關掉所有訂閱 */
  close(): void {
    for (const route of [this.#main, this.#rt]) {
      route?.acks?.close();
      if (route) route.acks = undefined;
    }
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
    const realtime = opts.urgency === 'realtime';
    const qos = opts.qos ?? 1;
    const timeoutMs = Math.max(1, opts.ackTimeoutMs ?? opts.timeoutMs ?? (realtime ? IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS : IOT_DEFAULT_COMMAND_TIMEOUT_MS));
    const retries = qos === 1 ? Math.max(0, Math.floor(opts.retries ?? (realtime ? 0 : IOT_DEFAULT_COMMAND_RETRIES))) : 0;
    const ttlSec = realtime
      ? clampIot(opts.ttlSec, IOT_REALTIME_DEFAULT_TTL_SEC, 5, IOT_REALTIME_MAX_TTL_SEC)
      : clampIot(opts.ttlSec, IOT_DEFAULT_TTL_SEC, 5, IOT_MAX_TTL_SEC);
    const msgId = newIotMsgId();
    const ts = this.#now();
    const expiration = Math.floor(ts / 1000) + ttlSec;
    const rtDevice = opts.device !== undefined ? this.#rtDevices.get(opts.device) : undefined;
    let sent: IotCommandResult & { ack?: IotAckBody };
    if (rtDevice) {
      // C′：門鎖類沒有 operatorSecret 就做不出設備解得開的指令——不送（relay 也擋不了偽造，設備會直接丟掉）
      if (rtDevice.downByOperator && this.#operatorSecret === undefined) return { status: 'not-allowed', msgId, attempts: 0, reason: 'operator-secret' };
      const inner = { type: 'cmd', msgId, topic, payload, enc: opts.enc ?? 'utf8', ...(opts.confirmed !== undefined ? { confirmed: opts.confirmed } : {}), exp: expiration };
      const env = this.#sealDown(rtDevice, rtDevice.downByOperator, ts, inner);
      const body: IotBody = { v: 1, type: 'dev-cmd', msgId, ts, device: rtDevice.id, env, ...(opts.confirmed !== undefined ? { confirmed: opts.confirmed } : {}) };
      sent = await this.#sendAndWait(this.#rt!, IOT_KIND_COMMAND, this.#rtTags(rtDevice, expiration), body, { msgId, timeoutMs, retries, expiration, toGateway: true });
    } else {
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
      // C′ 與閘道是同一條路線（relay 就是這個家的閘道）：`$sys/acl` 由 relay 處理，外層要加密給它（SDK ADR 0121）
      const toGateway = topic === IOT_ACL_TOPIC && this.#rt === this.#main;
      sent = await this.#sendAndWait(this.#main, IOT_KIND_COMMAND, tags, body, { msgId, timeoutMs, retries, expiration, toGateway });
    }
    // ack 原文只給 query() 用；command() 的結果不帶它
    const { ack, ...result } = sent;
    const out: IotCommandResult = {
      ...result,
      ...(ack?.topics !== undefined ? { state: { topics: ack.topics, ts: ack.ts } } : {}),
      ...(ack?.reset !== undefined ? { reset: ack.reset } : {}),
    };
    if (!realtime || out.status !== 'timeout') return out;
    // 即時等級逾時：結果未知（不是失敗）——查一次設備實際的狀態（ADR 0049 §9.4）
    const after = opts.device !== undefined ? await this.query(opts.device, { timeoutMs }).catch(() => undefined) : undefined;
    return { ...out, status: 'unknown', ...(after ? { after } : {}) };
  }

  /** 要求設備立刻回報（kind 25173，`viewer` 以上）；閘道節流或逾時時回 retained */
  async query(device: string, opts: { timeoutMs?: number; ttlSec?: number } = {}): Promise<IotQueryResult> {
    if (!isValidIotDeviceId(device)) throw new RangeError(`設備 id 不合法：${device}`);
    const msgId = newIotMsgId();
    const ts = this.#now();
    const rtDevice = this.#rtDevices.get(device);
    const ttlSec = clampIot(opts.ttlSec, rtDevice ? IOT_REALTIME_DEFAULT_TTL_SEC : IOT_DEFAULT_TTL_SEC, 5, rtDevice ? IOT_REALTIME_MAX_TTL_SEC : IOT_MAX_TTL_SEC);
    const expiration = Math.floor(ts / 1000) + ttlSec;
    const timeoutMs = Math.max(1, opts.timeoutMs ?? IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS);
    let result: IotCommandResult & { ack?: IotAckBody };
    if (rtDevice) {
      // 查詢一律用 deviceKey（門鎖類也是）：viewer 也能查；設備只執行 `cmd` 幀
      const env = this.#sealDown(rtDevice, false, ts, { type: 'query', msgId, exp: expiration });
      const body: IotBody = { v: 1, type: 'dev-query', msgId, ts, device, env };
      result = await this.#sendAndWait(this.#rt!, IOT_KIND_QUERY, this.#rtTags(rtDevice, expiration), body, { msgId, timeoutMs, retries: 0, expiration, toGateway: true });
    } else {
      const tags = [
        ['h', this.#o.home.homeTag],
        ['dv', this.#o.home.blind(iotBlindNames.device(device))],
        ['p', this.#gateway],
        ['expiration', String(expiration)],
      ];
      result = await this.#sendAndWait(this.#main, IOT_KIND_QUERY, tags, { v: 1, type: 'query', msgId, ts, device }, { msgId, timeoutMs, retries: 0, expiration });
    }
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
      status: result.status === 'quota' ? 'quota' : 'timeout',
      ...(retained ? { state: { topics: retained.topics, ts: retained.ts } } : {}),
      fromRetained: true,
      ...(result.status === 'relay-rejected' ? { reason: 'relay-rejected' } : {}),
    };
  }

  /**
   * 設備現在連著嗎（ADR 0049 §9.4）。C′：relay 以當下的連線即時回答（`dev-link`，不打擾設備、不落庫），`viewer` 以上；
   * 其他路線：retained 的 `online`（閘道最後一次知道的）。
   */
  async deviceLink(device: string, opts: { timeoutMs?: number } = {}): Promise<IotDeviceLink> {
    if (!isValidIotDeviceId(device)) throw new RangeError(`設備 id 不合法：${device}`);
    const rtDevice = this.#rtDevices.get(device);
    if (!rtDevice) {
      const retained = await this.getRetained(device).catch(() => undefined);
      return { transport: 'gateway', status: 'ok', ...(retained?.online !== undefined ? { online: retained.online } : {}), ...(retained ? { lastSeen: retained.ts } : {}) };
    }
    const msgId = newIotMsgId();
    const ts = this.#now();
    const expiration = Math.floor(ts / 1000) + IOT_REALTIME_DEFAULT_TTL_SEC;
    const timeoutMs = Math.max(1, opts.timeoutMs ?? IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS);
    const r = await this.#sendAndWait(this.#rt!, IOT_KIND_QUERY, this.#rtTags(rtDevice, expiration), { v: 1, type: 'dev-link', msgId, ts, device }, { msgId, timeoutMs, retries: 0, expiration, toGateway: true });
    const ack = r.ack;
    if (!ack) return { transport: 'ws', status: r.status === 'timeout' ? 'unknown' : r.status };
    return {
      transport: 'ws',
      status: ack.status,
      ...(ack.status === 'ok' ? { online: ack.online === true } : {}),
      ...(ack.lastHeartbeat !== undefined ? { lastHeartbeat: ack.lastHeartbeat } : {}),
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

  /**
   * 下行用哪個版本（SDK ADR 0122）：寬限期內、設備最近一次開口用的是舊版本 → 舊版本（還沒更新的設備才解得開）；
   * 其他情況（含還沒聽過設備開口）用目前的版本。
   */
  #downEpoch(device: RealtimeDevice): number {
    const prev = device.previous;
    return prev !== undefined && device.heard?.epoch === prev.epoch && Math.floor(this.#now() / 1000) <= prev.until ? prev.epoch : device.epoch;
  }

  /** 封下行信封：`operatorKey`＝門鎖類的指令（down 金鑰由 operatorSecret 導出，§9.5），否則用 deviceKey */
  #sealDown(device: RealtimeDevice, operatorKey: boolean, tsMs: number, inner: Record<string, unknown>): ReturnType<typeof sealIotEnvelope> {
    const epoch = this.#downEpoch(device);
    const key = operatorKey ? deriveIotDeviceKeyDown(this.#operatorSecret!, device.id, epoch) : this.#o.home.deviceKey(device.id, epoch);
    this.#downCtr += 1;
    return sealIotEnvelope({ key, kid: iotKid(device.id, epoch), dir: 'down', ctr: this.#downCtr, ts: Math.floor(tsMs / 1000), plaintext: JSON.stringify(inner) });
  }

  #rtTags(device: RealtimeDevice, expiration: number): string[][] {
    return [
      ['h', this.#o.home.homeTag],
      ['p', this.#rt!.gateway],
      ['dv', this.#o.home.blind(iotBlindNames.device(device.id))],
      ['expiration', String(expiration)],
    ];
  }

  /** 包成事件：閘道路線加密給全家（homePub）；C′ 的外層加密給 relay 的閘道公鑰（relay 要剝掉外層才能轉給設備） */
  #build(route: Route, kind: number, tags: string[][], body: IotBody, toGateway: boolean): NostrEvent {
    if (!toGateway) return buildIotEvent(this.#keyring, this.#o.signer, kind, tags, body);
    const content = encryptWithKey(JSON.stringify(body), this.#o.signer.conversationKey(route.gateway));
    return this.#o.signer.sign({ kind, created_at: Math.floor(body.ts / 1000), tags, content });
  }

  async #sendAndWait(
    route: Route,
    kind: number,
    tags: string[][],
    body: IotBody,
    p: { msgId: string; timeoutMs: number; retries: number; expiration: number; toGateway?: boolean },
  ): Promise<IotCommandResult & { ack?: IotAckBody }> {
    this.#ensureAcks(route);
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
    // relay 已經以 4429 關掉這條路線、還沒到重置時間（SDK ADR 0122）：送了也沒有一座收，不必送、不必等
    let held: { readonly reset?: number } | undefined;
    try {
      for (let attempt = 0; attempt <= p.retries && !this.#closed; attempt += 1) {
        if (attempt > 0 && Math.floor(this.#now() / 1000) >= p.expiration) break; // 指令已過期：不再送
        held = iotQuotaHold(route.pool);
        if (held) break;
        // 每次重新簽章（新的 created_at 與 NIP-44 nonce ⇒ 新 id），內容的 msgId 與 ts 不變
        const event = this.#build(route, kind, tags, body, p.toGateway === true);
        attempts += 1;
        const outcome = await iotPublish(route.pool, this.#budget, event);
        if (acked) break;
        lastRejected = outcome.ok ? undefined : outcome.rejected;
        // 中繼說今日額度用完（ADR 0049 §10；拒收或 4429 斷線）：重送也一樣，不必等
        if (lastRejected?.some((r) => QUOTA_REJECTION.test(r.reason))) break;
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
    if (lastRejected) {
      const quota = lastRejected.map((r) => QUOTA_REJECTION.exec(r.reason)).find((m) => m !== null);
      if (quota) return { status: 'quota', msgId: p.msgId, attempts, rejected: lastRejected, ...(quota[1] !== undefined ? { reset: Number(quota[1]) } : {}) };
    }
    held ??= iotQuotaHold(route.pool);
    if (held) return { status: 'quota', msgId: p.msgId, attempts, ...(held.reset !== undefined ? { reset: held.reset } : {}) };
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

  #ensureAcks(route: Route): void {
    if (route.acks) return;
    const filter: Filter = { kinds: [IOT_KIND_ACK], authors: [route.gateway], '#p': [this.#o.signer.pubkey], '#h': [this.#o.home.homeTag] };
    route.acks = route.pool.subscribe([filter], { onEvent: (event) => this.#onAck(route, event) });
  }

  #onAck(route: Route, event: Event): void {
    if (event.kind !== IOT_KIND_ACK || event.pubkey !== route.gateway || !iotVerified(event)) return;
    if (tagValue(event, 'h') !== this.#o.home.homeTag) return;
    const opened = this.#keyring.open(event.content, event.pubkey);
    let body: IotAckBody;
    if (opened?.type === 'ack') body = opened;
    else if (opened?.type === 'dev-ack' && route === this.#rt) {
      // C′ 設備的 ack：回覆哪一則指令寫在信封裡面（relay 看不到）
      const up = this.#openUp(opened, true);
      if (up?.type !== 'ack') return;
      body = {
        v: 1,
        type: 'ack',
        msgId: opened.msgId,
        ts: opened.ts,
        inReplyTo: up.inReplyTo,
        status: up.status,
        device: opened.device,
        ...(up.reason !== undefined ? { reason: up.reason } : {}),
        ...(up.topics !== undefined ? { topics: up.topics } : {}),
      };
    } else return;
    const waiters = this.#waiters.get(body.inReplyTo);
    if (!waiters) return;
    const verdict = this.#ackGuard.check(body.msgId, body.ts);
    if (verdict.verdict !== 'fresh') return;
    for (const w of waiters) w.resolve(body);
  }

  /**
   * 解開 C′ 設備的 up 信封（以 `deviceKey`；只認設定的 epoch，寬限期內加上 `previousEpoch`）。
   * `live`：即時的 ack／狀態要在時間窗內、沒看過（`kid#ctr`）；retained 是舊值，不做這兩項檢查。
   * 解得開就記下設備用的版本（取信封時間最新的），下行跟著它（SDK ADR 0122）。
   */
  #openUp(body: IotDeviceReportBody, live: boolean): IotUpMessage | undefined {
    const device = this.#rtDevices.get(body.device);
    const kid = parseIotKid(body.env.kid);
    if (!device || !kid || kid.deviceId !== device.id) return undefined;
    const prev = device.previous;
    const inGrace = prev !== undefined && kid.epoch === prev.epoch && Math.floor(this.#now() / 1000) <= prev.until;
    if (kid.epoch !== device.epoch && !inGrace) return undefined;
    let plaintext: Uint8Array;
    try {
      plaintext = openIotEnvelope(body.env, this.#o.home.deviceKey(device.id, kid.epoch));
    } catch {
      return undefined;
    }
    if (live && this.#upGuard.check(`${body.env.kid}#${body.env.ctr}`, body.env.ts * 1000).verdict !== 'fresh') return undefined;
    const at = body.env.ts * 1000;
    if (device.heard === undefined || at >= device.heard.at) device.heard = { epoch: kid.epoch, at };
    return parseIotUpMessage(plaintext);
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
    const subs = [sub];
    // C′ 設備的狀態：relay 看不到 topic，事件只以 `d`＝盲化設備 id 標記；topic 在信封裡，解開後才比對
    const rt = this.#rt;
    if (rt && this.#rtDevices.size > 0) {
      const blinds = [...this.#rtDevices.keys()].map((id) => blind(iotBlindNames.device(id)));
      const rtSub = rt.pool.subscribe([{ kinds: [IOT_KIND_STATE], authors: [rt.gateway], '#h': [this.#o.home.homeTag], '#d': blinds }], {
        onEvent: (event) => {
          if (event.kind !== IOT_KIND_STATE || event.pubkey !== rt.gateway || !iotVerified(event)) return;
          const body = this.#keyring.open(event.content, event.pubkey);
          if (body?.type !== 'dev-state' || tagValue(event, 'd') !== blind(iotBlindNames.device(body.device))) return;
          const up = this.#openUp(body, true);
          if (up?.type !== 'state') return;
          for (const [topic, value] of Object.entries(up.topics)) {
            if (!topicMatches(pattern, topic)) continue;
            try {
              onMessage({ topic, payload: value.payload, enc: value.enc ?? 'utf8', ts: value.ts, device: body.device, live: true, ...(up.will !== undefined ? { will: up.will } : {}) });
            } catch (error) {
              this.#o.onError?.(error);
            }
          }
        },
      });
      subs.push(rtSub);
    }
    for (const s of subs) this.#subs.add(s);
    return {
      close: () => {
        for (const s of subs) {
          s.close();
          this.#subs.delete(s);
        }
      },
    };
  }

  async #readRetained(filter: Filter, route: Route = this.#main): Promise<{ event: Event; body: ReturnType<IotKeyring['open']> }[]> {
    const events = await iotQuery(route.pool, [filter], this.#o.readTimeoutMs ?? 5_000);
    const out: { event: Event; body: ReturnType<IotKeyring['open']> }[] = [];
    for (const event of events) {
      if (event.kind !== IOT_KIND_RETAINED || event.pubkey !== route.gateway || !iotVerified(event)) continue;
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
    const rt = this.#rt;
    if (rt && this.#rtDevices.has(device)) {
      // C′：relay 保存的是最後一個狀態幀（每台至少隔 5 分鐘寫一次），只有那一幀帶到的 topic
      const blindId = this.#o.home.blind(iotBlindNames.device(device));
      const rows = await this.#readRetained({ kinds: [IOT_KIND_RETAINED], authors: [rt.gateway], '#d': [blindId] }, rt);
      const newest = rows
        .map((r) => r.body)
        .filter((b): b is IotDeviceReportBody => b?.type === 'dev-state' && b.device === device)
        .sort((a, b) => b.env.ts - a.env.ts)[0];
      const up = newest ? this.#openUp(newest, false) : undefined;
      if (up?.type !== 'state') return undefined;
      const ts = newest!.env.ts * 1000;
      return { device, topics: up.topics, ts, stale: this.#stale(ts), complete: false };
    }
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
