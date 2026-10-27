/**
 * 多 Relay 連接池（SDK ADR 0001；源自《沒當好爸爸》ADR 0007／0024）：對設定裡的每個 Relay 同時保持一條 WebSocket，
 * 發布送給全部、訂閱對全部下同一個 REQ、事件以 id 去重；哪一個斷了就按退避時間重連並補送訂閱，
 * 其他 Relay 照常服務，所以主力斷線時使用者無感。
 *
 * NIP-42：有給身分時，Relay 送 AUTH 挑戰就簽 kind 22242 回覆；認證成功後補送所有訂閱，
 * 認證前被「auth-required」擋下的發布重送一次。沒給身分就當匿名，要求認證的 Relay 會拒絕我們。
 *
 * 所有進站事件先驗簽章（Relay 不可信，ARCHITECTURE 伍節）。WebSocket 以介面注入，Node 測試用假的。
 */

import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';

import type { Identity } from './identity.js';
import {
  classifyRelayClose,
  classifyRelayMessage,
  parseDroppedNotice,
  parseNearFullWarning,
  type RelayDroppedNotice,
  type RelayRejectKind,
  type RelayRejectTraits,
} from './protocol/relay-reject.js';
import { localKind, rejectedEntry } from './publish-rejections.js';
import {
  RelayHealthTracker,
  type RelayHealthCooldowns,
  type RelayHealthMark,
  type RelayHealthResetFilter,
  type RelayHealthSnapshot,
} from './relay-health.js';

export {
  DEFAULT_RELAY_HEALTH_COOLDOWNS,
  relayDataPlaneOf,
  type RelayDataPlane,
  type RelayHealthCooldowns,
  type RelayHealthMark,
  type RelayHealthResetFilter,
  type RelayHealthScope,
  type RelayHealthSnapshot,
  type RelayHealthState,
  type RelayNearFull,
} from './relay-health.js';

export {
  classifyPublishRejection,
  durabilityShortfall,
  meetsDurability,
  publishRejections,
  reportPublishRejections,
  type ClassifiedRejection,
  type PublishRejectionReport,
} from './publish-rejections.js';

/**
 * `code`／`reason` 只有 `close` 事件才有（瀏覽器與 `ws` 都給；SDK ADR 0038 P0-C）。
 * 舊的注入實作不給也行：沒有關閉碼就當成一般的網路斷線。
 */
export type SocketListener = (event: { readonly data?: string; readonly code?: number; readonly reason?: string }) => void;

/** 只用到的 WebSocket 子集 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: SocketListener): void;
}

export type RelayStatus = 'connecting' | 'open' | 'closed';

/**
 * 某一座沒收下這次發布（SDK ADR 0038 P0-C）。`kind` 以後的欄位是 v0.32 加的：
 * `RelayPool` 一定會填；自訂的 `RelayTransport` 可能沒有，用 {@link classifyPublishRejection} 補回。
 */
export interface RejectedRelay {
  readonly url: string;
  /** 中繼給的原文（`OK false` 的第 4 欄），或 `timeout`／`not connected`／`disconnected…` */
  readonly reason: string;
  readonly kind?: RelayRejectKind;
  readonly retryable?: boolean;
  readonly tryOtherRelays?: boolean;
  /** 前綴後的英文詞元（只有 Cinderous／SDK 中繼會帶） */
  readonly token?: string;
}

export interface PublishResult {
  /** 收下的 Relay：回 OK true 的（含 `warning: borrowed:`），加上回 `duplicate:` 的（本來就有這顆，NIP-01） */
  readonly accepted: string[];
  /** 拒絕、逾時或沒連上的 Relay 與原因 */
  readonly rejected: RejectedRelay[];
  /**
   * `accepted` 裡只是「借用」收下的（`OK true "warning: borrowed:"`：溢位帶、短保存、最先淘汰；SDK ADR 0039／0041）。
   * 沒有借用時**沒有這個欄位**（v0.32 的結果形狀不變）。
   */
  readonly borrowed?: string[];
  /** 發布時帶了 `durability` 才有（SDK ADR 0041） */
  readonly durability?: DurabilityResult;
}

/**
 * 耐久度要求（SDK ADR 0038 研究結果四、ADR 0041）。不給＝v0.32 的行為（送給每一座開著的、至少一座收下算成功）。
 */
export interface PublishDurability {
  /**
   * 至少幾座**耐久收下**才算滿足：`OK true`、`duplicate` 算；`warning: borrowed:` 不算。預設 1（決策 6）。
   */
  readonly minAccepted?: number;
  /**
   * 備援中繼（不在 `urls` 裡）。收下數不足、而且拒收是「換別座有用」的分類時，依序**延遲連上**下一座、只補發這一則；
   * 閒置 `standbyIdleMs` 後斷線，不加進常駐訂閱（除非 `standbySubscribe`）。省略＝不自動連備援（決策 6）。
   */
  readonly standby?: readonly string[];
  /**
   * 主要中繼**一座都沒開**（只是沒連線，不是拒收或已滿）時要不要改用備援（SDK ADR 0078）。預設 true（之前的行為）。
   * 排程連線的應用（例如兩輪之間刻意斷線）請設 false：照實回報沒送到、讓呼叫端記成待送，下次連上主要中繼再送——
   * 否則兩輪之間的發布全部只落在備援上，沒設同一座備援的裝置永遠收不到。主要中繼開著但拒收、已滿時照舊改用備援。
   */
  readonly standbyWhenDisconnected?: boolean;
}

export interface PublishOptions {
  readonly durability?: PublishDurability;
  /**
   * 只送給這幾座（SDK ADR 0067：收件確認只送給宣告了 `cinder_inbox_ack` 的中繼）。不在池裡的忽略；結果只列這幾座。
   * 給了就不走 `durability` 的路徑（不看健康狀態、不用備援）。只收兩個參數的自訂傳輸層會忽略它、照舊送給全部。
   */
  readonly relays?: readonly string[];
}

/**
 * 一座中繼對這次發布的結果（`durability.relays`）：`skipped`＝健康狀態標記了（已滿、不適用、退避中），這次沒送；
 * `not-connected`＝沒連上（備援連不上也是）。
 */
export type RelayPublishOutcome = 'accepted' | 'duplicate' | 'borrowed' | 'rejected' | 'timeout' | 'skipped' | 'not-connected';

export interface RelayPublishState {
  readonly url: string;
  readonly standby: boolean;
  readonly outcome: RelayPublishOutcome;
  readonly kind?: RelayRejectKind;
  readonly reason?: string;
  /** `skipped`：標記到什麼時候（毫秒） */
  readonly until?: number;
}

export interface DurabilityResult {
  readonly minAccepted: number;
  /** 耐久收下的中繼（不含借用） */
  readonly durable: readonly string[];
  readonly satisfied: boolean;
  /** 這次延遲連上、送了這一則的備援 */
  readonly standbyUsed: readonly string[];
  /**
   * 沒滿足，而且其餘每一座都是「滿了」（`ceiling`／`quota`、因此被略過、或只借用）：
   * 應用該回報一次、長退避，不要一直重試（ADR 0038 §4，比照 ADR 0027）。
   */
  readonly relaysFull: boolean;
  /** 每一座的結果（主要中繼依 `urls` 順序，接著是用到的備援） */
  readonly relays: readonly RelayPublishState[];
}

/** `queryEach` 每一座的結果（SDK ADR 0041） */
export interface RelayQueryResult {
  readonly url: string;
  /** `eose`＝完整回完；`closed`＝被中繼 `CLOSED`；`timeout`／`disconnected`／`not-connected`＝不知道這座有沒有 */
  readonly status: 'eose' | 'closed' | 'timeout' | 'disconnected' | 'not-connected';
  readonly reason?: string;
  /** 這一座回的事件（已驗簽、這一座內去重） */
  readonly events: readonly Event[];
}

/** `queryResult` 的一座（SDK ADR 0045）：狀態同 {@link RelayQueryResult}，不含那一座的事件 */
export interface RelayQueryStatus {
  readonly url: string;
  readonly status: RelayQueryResult['status'];
  readonly reason?: string;
  /** 只讀的中繼（`readUrls`，SDK ADR 0054）：不算進 `answered` */
  readonly read?: true;
}

/**
 * `queryResult` 的結果（SDK ADR 0045，G12a）：`answered`＝完整回了 EOSE 的中繼數。
 * `answered === 0`＝**沒有任何一座查完**（都沒開、逾時、被 CLOSED、查到一半斷線）——不是「查完但沒結果」，
 * 依查詢結果推進游標或水位的程式碼此時不得推進。
 */
export interface RelayQueryOutcome {
  /** 去重、驗過簽、依 `created_at` 由新到舊（與 `query` 相同） */
  readonly events: Event[];
  readonly answered: number;
  /** 每一座的狀態（依 `urls` 順序） */
  readonly relays: readonly RelayQueryStatus[];
}

export interface QueryEachOptions {
  readonly timeoutMs?: number;
  /** 要查哪幾座；預設 `urls`。不在 `urls` 裡的當備援延遲連上（查完閒置斷線） */
  readonly relays?: readonly string[];
}

/** `onRelayDropped` 的內容（SDK ADR 0042） */
export interface RelayDroppedReport extends RelayDroppedNotice {
  readonly url: string;
}

/** 中繼的一次拒收（`onRelayReject`；SDK ADR 0038 P0-C） */
export interface RelayRejection extends RelayRejectTraits {
  /** `ok`＝某次發布的 `OK false`；`closed`＝訂閱被 `CLOSED`；`notice`＝帶前綴的 `NOTICE`；`close`＝中繼以關閉碼斷線 */
  readonly source: 'ok' | 'closed' | 'notice' | 'close';
  readonly kind: RelayRejectKind;
  readonly reason: string;
  readonly token?: string;
  readonly eventId?: string;
  readonly subId?: string;
  /** WebSocket 關閉碼（`source: 'close'`） */
  readonly code?: number;
}

export interface SubscriptionHandlers {
  onEvent(event: Event, relayUrl: string): void;
  /** 第一個 Relay 送 EOSE 時叫一次 */
  onEose?(): void;
}

export interface Subscription {
  close(): void;
}

/**
 * NIP-59 外層時戳最多被往前推多久（秒）：兩天。與 `protocol/nip59` 的 `TIMESTAMP_JITTER_SECONDS` 是同一個數字
 * （測試釘住兩者相等；這裡不直接匯入，免得只用連線池的應用把封裝程式也拉進來）。
 * 規範：NIP-59「created_at … should be tweaked … up to two days in the past」。
 */
export const NIP59_MAX_BACKDATE_SEC = 2 * 86_400;

/**
 * 外層時戳可能被往前推的 kind（SDK ADR 0035）：1059＝NIP-59／NIP-17 禮物包，1060＝SDK 的檔案塊、Vault 同步訊息、
 * 裝置名單的外層。另外所有帶 `#p` 的 filter（收件匣類：通話信令 21002、SDP 21000 等也是禮物包）一律視為可能被回溯。
 */
export const BACKDATED_KINDS: readonly number[] = [1059, 1060];

export interface SubscribeOptions {
  /**
   * 重新連上時補訂閱的 `since` 要比游標再往前退讓多少秒（SDK ADR 0035）。
   * 省略＝自動判斷：kinds 含 {@link BACKDATED_KINDS} 或帶 `#p` 的 filter 退讓 {@link NIP59_MAX_BACKDATE_SEC}，其他照原游標。
   * 給數字＝這個訂閱的每一個 filter 都退讓這麼多；0＝完全不退讓（呼叫端自己處理）。
   */
  readonly backdateWindowSec?: number;
}

/** 這個 filter 收的事件，外層時間可能被往前推（NIP-59）嗎 */
export function isBackdatableFilter(filter: Filter): boolean {
  if (filter['#p'] !== undefined) return true;
  return filter.kinds?.some((kind) => BACKDATED_KINDS.includes(kind)) ?? false;
}

/**
 * 補訂閱時某個 filter 的 `since`：游標（看過最新的 created_at）減去回溯窗，但不比 filter 原本的 `since` 早。
 * 回溯窗：呼叫端宣告的優先，否則依 {@link isBackdatableFilter} 自動判斷。
 */
export function resumeSince(filter: Filter, cursor: number, backdateWindowSec?: number): number {
  const slack = backdateWindowSec ?? (isBackdatableFilter(filter) ? NIP59_MAX_BACKDATE_SEC : 0);
  return Math.max(filter.since ?? 0, cursor - Math.max(0, slack));
}

/** 上層（大廳、聊天、私訊）只依賴這兩個方法；測試用假的傳輸層取代整個池 */
export interface RelayTransport {
  /** `options` 是 v0.33 新增的（SDK ADR 0041）；只收一個參數的自訂傳輸層照樣符合這個介面（會忽略耐久度要求） */
  publish(event: Event, options?: PublishOptions): Promise<PublishResult>;
  /** `options` 是 v0.30 新增的（SDK ADR 0035）；只收兩個參數的自訂傳輸層照樣符合這個介面 */
  subscribe(filters: Filter[], handlers: SubscriptionHandlers, options?: SubscribeOptions): Subscription;
}

export interface RelayPoolOptions {
  /** 依優先順序列出的 Relay（主力在前） */
  readonly urls: readonly string[];
  /** 回應 NIP-42 AUTH 挑戰用的身分；省略就不認證 */
  readonly identity?: Pick<Identity, 'sign'>;
  /** 預設 `new WebSocket(url)` */
  readonly createSocket?: (url: string) => SocketLike;
  /** 重連退避（毫秒），用完就一直用最後一段 */
  readonly reconnectDelaysMs?: readonly number[];
  /**
   * 連線撐過這段時間（毫秒）才斷，退避才歸零。Relay 對限速或錯誤路徑是
   * 「接受連線、送 NOTICE、立刻關閉」（Cinderous ADR-0368）；一開啟就歸零的話，那會變成
   * 每 0.5 秒一次的迴圈，很快撞上車道每個 IP 每分鐘 30 條新連線的限速。預設 30 秒。
   */
  readonly reconnectStableMs?: number;
  /**
   * Relay 回報的問題：非 auth-required 的 CLOSED（例如 restricted）與 NOTICE。
   * auth-required 不回報——認證成功後會自動補送。用途是記錄，讓「這個 Relay 不回這個訂閱」
   * 查得到原因，不影響其他 Relay。
   */
  readonly onRelayProblem?: (url: string, reason: string) => void;
  /**
   * 結構化的拒收回報（SDK ADR 0038 P0-C）：每一座的 `OK false`（不含 `duplicate`）、訂閱被 `CLOSED`、
   * 帶 NIP-01 前綴的 `NOTICE`、以及中繼以關閉碼斷線（1008 限速、4003 白名單外…）。
   * **部分拒收**（有的中繼收、有的拒）也從這裡看得到——`publish` 的結果只要有一座收下，上層通常就當成功。
   * 一般的網路斷線（沒有關閉碼）不算拒收，不回報。
   */
  readonly onRelayReject?: (url: string, rejection: RelayRejection) => void;
  /**
   * 中繼說有幾則寄給你、還沒送到的留言在它那裡被刪掉了（FIFO、天花板淘汰、借用到期；SDK ADR 0042）。
   * 在你讀自己的收件匣（`#p` 是自己的訂閱）時、那一座的 EOSE 之前來一次；中繼送出後就歸零。只有數量與時間範圍（寄件時間，
   * 禮物包的外層時間被往前推過，找回時要放寬兩天）。應用可以提示「有 N 則在這座中繼上遺失」，或向其他裝置索取。
   */
  readonly onRelayDropped?: (report: RelayDroppedReport) => void;
  readonly publishTimeoutMs?: number;
  /** 訂閱 id 的前綴（除錯時分得出是哪個應用開的）；預設 `cdr` */
  readonly subscriptionPrefix?: string;
  /** 進站訊框的位元組上限：超過就整框丟掉（擋惡意中繼塞爆記憶體）。省略＝不限 */
  readonly maxFrameBytes?: number;
  /** 連線多久沒開起來就放棄、照退避重連（毫秒）。省略＝一直等（交給瀏覽器） */
  readonly connectTimeoutMs?: number;
  /** 健康狀態的冷卻時間（SDK ADR 0041）；預設見 `DEFAULT_RELAY_HEALTH_COOLDOWNS` */
  readonly healthCooldowns?: RelayHealthCooldowns;
  /** 備援連線閒置多久斷線（毫秒）；預設 60 秒 */
  readonly standbyIdleMs?: number;
  /** 用到的備援也收常駐訂閱、不閒置斷線（預設 false：備援只用來補發） */
  readonly standbySubscribe?: boolean;
  /**
   * 「只訂閱、不寫入」的中繼（SDK ADR 0054；CinderSync G11）：與主要中繼一起 `connect()`、斷線照退避重連、收常駐訂閱，
   * `query`／`queryResult` 也查（`answered` 只算主要中繼）；**一般發布不寫給它們**，只有發布的 `durability.standby`
   * 列了它、而且主要中繼不夠時才補發（沿用這條連線）。用法：把備援中繼同時列在這裡與 `durability.standby`，
   * 別台補發到備援的訊息這台就讀得到。不經 `status()`／`onStatusChange`（「在線」只看主要中繼），狀態見 `relayHealth()`。
   * 已經在 `urls` 裡的忽略。
   */
  readonly readUrls?: readonly string[];
}

export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000];
export const DEFAULT_RECONNECT_STABLE_MS = 30_000;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;
export const DEFAULT_STANDBY_IDLE_MS = 60_000;

const OPEN = 1;
/** NIP-42 的認證事件 kind */
const AUTH_KIND = 22242;
/** NIP-42 規定 Relay 拒絕未認證請求時的理由前綴 */
const AUTH_REQUIRED_PREFIX = 'auth-required:';
const RESTRICTED_PREFIX = 'restricted:';
/** 一次性查詢的逾時以「多久沒有新資料」計，最長延到逾時的幾倍（SDK ADR 0077） */
export const QUERY_MAX_EXTENSION = 12;
/**
 * 同一個訂閱在同一座被 `CLOSED …resubscribe` 之後，多久內不再自動重訂（毫秒）。
 * 中繼存不住這個訂閱時會一直回同一句，沒有冷卻就是迴圈。
 */
const RESUBSCRIBE_COOLDOWN_MS = 30_000;

interface Connection {
  socket: SocketLike | null;
  status: RelayStatus;
  attempts: number;
  /** 這條 socket 開啟的時間；撐過穩定門檻才斷，退避才歸零 */
  openedAt: number | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** 這條連線已通過 NIP-42 認證 */
  authenticated: boolean;
  /** 正在等 OK 的 AUTH 事件 id */
  authEventId: string | null;
  /** 這條連線最近一次收到的 AUTH 挑戰（還沒有身分時先記著，給了身分再回） */
  challenge: string | null;
  /** 最近一次從這一座收到任何訊息的時間（毫秒）；沒收過是 null */
  lastActivityAt: number | null;
  /** 認證前被 auth-required 擋下的發布（事件 id），認證成功後重送一次 */
  authQueue: Set<string>;
  /** 延遲連上的備援（SDK ADR 0041）：不自動重連、不回報 `onStatusChange`、預設不收常駐訂閱 */
  readonly standby: boolean;
  /** 只訂閱、不寫入的中繼（`readUrls`，SDK ADR 0054）：也是 `standby`，但常駐連線、照退避重連、收常駐訂閱 */
  readonly read: boolean;
  /** `read` 的連線最近被拿來補發（`durability.standby`）：閒置 `standbyIdleMs` 前算在寫入集合裡 */
  writing: boolean;
  /** 等這條連線開起來的人（`true`＝開了、`false`＝斷了） */
  readonly waiters: Set<(open: boolean) => void>;
  /** 備援閒置斷線的計時器 */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface EachState {
  status: RelayQueryResult['status'];
  reason?: string;
  readonly events: Event[];
  readonly ids: Set<string>;
}

interface QueryState {
  /** 還沒回 EOSE 的站 */
  readonly waiting: Set<string>;
  /** 送出去的 REQ（認證後重送用） */
  readonly request: string;
  /** 被 auth-required 擋下、等認證完再重送的站 */
  readonly awaitingAuth: Set<string>;
  readonly events: Map<string, Event>;
  /** `queryEach`：每一座各自的結果 */
  readonly each: Map<string, EachState> | undefined;
  /** `queryResult`：每一座的狀態（不另存事件） */
  readonly statuses: Map<string, { status: RelayQueryResult['status']; reason?: string }> | undefined;
  finish(): void;
  /** 收到這個查詢的事件：逾時從現在重新起算（不超過上限；SDK ADR 0077） */
  touch(): void;
}

/** 一座對一次發布的回覆（`undefined`＝沒回，逾時） */
interface Answer {
  readonly ok: boolean;
  readonly reason: string;
  readonly kind: RelayRejectKind | undefined;
}

interface PingWaiter {
  readonly url: string;
  readonly started: number;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(rttMs: number): void;
  reject(error: Error): void;
}

interface ActiveSubscription {
  readonly filters: Filter[];
  readonly handlers: SubscriptionHandlers;
  readonly seen: Set<string>;
  eoseNotified: boolean;
  /** 看過最新的 created_at（秒，以本機時鐘為上限）；補訂閱時從這裡接續，少重播 */
  cursor: number | undefined;
  /** 呼叫端宣告的回溯窗（秒）；省略＝依 filter 自動判斷（SDK ADR 0035） */
  readonly backdateWindowSec: number | undefined;
  /** relay url → 上次因 `CLOSED …resubscribe` 自動重訂的時間（毫秒；SDK ADR 0038 P0-C） */
  readonly resubscribedAt: Map<string, number>;
}

/** `kind` 給了就用它（例如中繼以關閉碼斷線），否則從 `reason` 分類 */
type OkListener = (ok: boolean, reason: string, kind?: RelayRejectKind) => void;

interface PendingPublish {
  /** 送出去的 `["EVENT", …]`，認證後重送用 */
  readonly payload: string;
  /** relay url → OK 回呼 */
  readonly listeners: Map<string, OkListener>;
}

function defaultCreateSocket(url: string): SocketLike {
  return new WebSocket(url);
}

function newConnection(standby: boolean, read = false): Connection {
  return {
    socket: null,
    status: 'closed',
    attempts: 0,
    openedAt: null,
    reconnectTimer: null,
    authenticated: false,
    authEventId: null,
    challenge: null,
    lastActivityAt: null,
    authQueue: new Set(),
    standby,
    read,
    writing: false,
    waiters: new Set(),
    idleTimer: null,
  };
}

/** 耐久收下（`durability.minAccepted` 計數的那些） */
const isDurable = (state: RelayPublishState): boolean => state.outcome === 'accepted' || state.outcome === 'duplicate';

/** 「滿了」：`ceiling`／`quota`（拒收或因此被略過），或只借用 */
const skippedState = (url: string, standby: boolean, mark: RelayHealthMark): RelayPublishState => ({
  url,
  standby,
  outcome: 'skipped',
  kind: mark.kind,
  reason: mark.reason,
  until: mark.until,
});

const isFullish = (state: RelayPublishState): boolean =>
  state.outcome === 'borrowed' || ((state.outcome === 'rejected' || state.outcome === 'skipped') && (state.kind === 'ceiling' || state.kind === 'quota'));

export class RelayPool implements RelayTransport {
  readonly #urls: readonly string[];
  #identity: Pick<Identity, 'sign'> | undefined;
  readonly #createSocket: (url: string) => SocketLike;
  readonly #reconnectDelays: readonly number[];
  readonly #subscriptionPrefix: string;
  readonly #maxFrameBytes: number | undefined;
  readonly #connectTimeoutMs: number | undefined;
  readonly #reconnectStableMs: number;
  readonly #onRelayProblem: ((url: string, reason: string) => void) | undefined;
  readonly #onRelayReject: ((url: string, rejection: RelayRejection) => void) | undefined;
  readonly #onRelayDropped: ((report: RelayDroppedReport) => void) | undefined;
  readonly #publishTimeoutMs: number;
  readonly #connections = new Map<string, Connection>();
  /** 進行中的一次性查詢（訂閱 id → 狀態） */
  readonly #queries = new Map<string, QueryState>();
  /** 正在等 EOSE 的逐座探針（訂閱 id → 等待者） */
  readonly #pings = new Map<string, PingWaiter>();
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  /** event id → 等 OK 中的發布 */
  readonly #pending = new Map<string, PendingPublish>();
  readonly #statusListeners = new Set<(url: string, status: RelayStatus) => void>();
  /** 延遲連上的備援（SDK ADR 0041） */
  readonly #standby = new Map<string, Connection>();
  readonly #standbyIdleMs: number;
  readonly #standbySubscribe: boolean;
  readonly #health: RelayHealthTracker;
  readonly #healthListeners = new Set<(url: string, health: RelayHealthSnapshot) => void>();
  #subscriptionCounter = 0;
  #closed = false;

  constructor(options: RelayPoolOptions) {
    this.#urls = [...options.urls];
    this.#identity = options.identity;
    this.#createSocket = options.createSocket ?? defaultCreateSocket;
    this.#reconnectDelays =
      options.reconnectDelaysMs === undefined || options.reconnectDelaysMs.length === 0
        ? DEFAULT_RECONNECT_DELAYS_MS
        : options.reconnectDelaysMs;
    this.#publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.#subscriptionPrefix = options.subscriptionPrefix ?? 'cdr';
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#connectTimeoutMs = options.connectTimeoutMs;
    this.#reconnectStableMs = options.reconnectStableMs ?? DEFAULT_RECONNECT_STABLE_MS;
    this.#onRelayProblem = options.onRelayProblem;
    this.#onRelayReject = options.onRelayReject;
    this.#onRelayDropped = options.onRelayDropped;
    this.#standbyIdleMs = options.standbyIdleMs ?? DEFAULT_STANDBY_IDLE_MS;
    this.#standbySubscribe = options.standbySubscribe === true;
    this.#health = new RelayHealthTracker({
      ...(options.healthCooldowns !== undefined ? { cooldowns: options.healthCooldowns } : {}),
      onChange: (url) => this.#emitHealth(url),
    });
    for (const url of this.#urls) this.#connections.set(url, newConnection(false));
    for (const url of new Set(options.readUrls ?? [])) {
      if (!this.#connections.has(url)) this.#standby.set(url, newConnection(true, true));
    }
  }

  /** 只訂閱、不寫入的中繼（`readUrls`） */
  #readUrls(): string[] {
    return [...this.#standby].filter(([, connection]) => connection.read).map(([url]) => url);
  }

  /** 主要中繼與用過的備援 */
  #all(): [string, Connection][] {
    return [...this.#connections, ...this.#standby];
  }

  #conn(url: string): Connection | undefined {
    return this.#connections.get(url) ?? this.#standby.get(url);
  }

  /** 對每個 Relay 開連線；之後斷線會自動重連，直到 `close()`。 */
  connect(): void {
    this.#closed = false;
    for (const url of this.#urls) {
      const connection = this.#connections.get(url);
      if (connection !== undefined && connection.socket === null) {
        this.#open(url, connection);
      }
    }
    for (const url of this.#readUrls()) {
      const connection = this.#standby.get(url)!;
      if (connection.socket === null) this.#open(url, connection);
    }
  }

  /** 關掉全部連線並停止重連。 */
  close(): void {
    this.#closed = true;
    for (const [url, connection] of this.#all()) {
      if (connection.reconnectTimer !== null) {
        clearTimeout(connection.reconnectTimer);
        connection.reconnectTimer = null;
      }
      if (connection.idleTimer !== null) {
        clearTimeout(connection.idleTimer);
        connection.idleTimer = null;
      }
      const socket = connection.socket;
      connection.socket = null;
      socket?.close();
      this.#setStatus(url, connection, 'closed');
    }
  }

  status(): ReadonlyMap<string, RelayStatus> {
    return new Map([...this.#connections].map(([url, connection]) => [url, connection.status]));
  }

  /**
   * 換掉（或拿掉）回應 NIP-42 的身分。給應用「先開連線池、之後才知道玩家金鑰」用：
   * 已經收過挑戰、還沒認證的連線會立刻補回覆。傳 null 之後就當匿名，不再回應新的挑戰。
   */
  setAuthIdentity(identity: Pick<Identity, 'sign'> | null): void {
    this.#identity = identity ?? undefined;
    if (identity === null) return;
    for (const [url, connection] of this.#all()) {
      if (connection.socket !== null && connection.status === 'open' && connection.challenge !== null) {
        this.#answerChallenge(url, connection, connection.socket, connection.challenge);
      }
    }
  }

  onStatusChange(listener: (url: string, status: RelayStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /**
   * 送給所有開著的 Relay；每個 Relay 的 OK／拒絕／逾時都整理進結果。
   *
   * 帶 `durability`（SDK ADR 0041）時：略過健康狀態標記的中繼（已滿、不適用、退避中）；耐久收下數（不含借用）
   * 不足 `minAccepted`、拒收又是「換別座有用」的分類時，依序延遲連上 `standby` 並只補發這一則。
   * 不帶就是 v0.32 的行為，結果形狀也相同。
   */
  publish(event: Event, options: PublishOptions = {}): Promise<PublishResult> {
    const payload = JSON.stringify(['EVENT', event]);
    const only = options.relays;
    if (options.durability !== undefined && only === undefined) return this.#publishDurable(event, payload, options.durability);
    const scope = only === undefined ? this.#urls : this.#urls.filter((url) => only.includes(url));
    const openUrls = scope.filter((url) => this.#isOpen(url));
    return this.#sendTo(event, payload, openUrls).then((answers) => {
      const result: PublishResult = { accepted: [], rejected: [] };
      for (const url of scope) this.#tally(result, url, answers.get(url), openUrls.includes(url), false);
      return result;
    });
  }

  async #publishDurable(event: Event, payload: string, durability: PublishDurability): Promise<PublishResult> {
    const min = Math.max(0, Math.floor(durability.minAccepted ?? 1));
    const bytes = payload.length;
    const result: PublishResult = { accepted: [], rejected: [] };
    const skipped = new Map<string, RelayHealthMark>();
    const targets: string[] = [];
    for (const url of this.#urls) {
      const mark = this.#health.blocking(url, event.kind, bytes);
      if (mark !== undefined) skipped.set(url, mark);
      else if (this.#isOpen(url)) targets.push(url);
    }
    const answers = await this.#sendTo(event, payload, targets);
    const relays: RelayPublishState[] = this.#urls.map((url) => {
      const mark = skipped.get(url);
      return mark !== undefined ? skippedState(url, false, mark) : this.#tally(result, url, answers.get(url), targets.includes(url), false);
    });
    const standbyUsed: string[] = [];
    // 主要中繼只是沒連線（沒有一座開著、也沒有被健康狀態擋下的）：設了 standbyWhenDisconnected: false 就不改用備援（SDK ADR 0078）
    const merelyDisconnected = targets.length === 0 && skipped.size === 0 && this.#urls.length > 0;
    const standbyList = durability.standbyWhenDisconnected === false && merelyDisconnected ? [] : (durability.standby ?? []);
    for (const url of new Set(standbyList)) {
      // 自己的錯（`invalid`）或本來就不會變（`stale`）：換哪座都一樣，不改用
      if (relays.filter(isDurable).length >= min || relays.some((r) => r.kind === 'invalid' || r.kind === 'stale')) break;
      if (this.#connections.has(url)) continue;
      const mark = this.#health.blocking(url, event.kind, bytes);
      if (mark !== undefined) {
        relays.push(skippedState(url, true, mark));
        continue;
      }
      const open = await this.#ensureStandby(url);
      this.#touchStandby(url);
      if (!open) {
        relays.push(this.#tally(result, url, undefined, false, true));
        continue;
      }
      standbyUsed.push(url);
      const answer = (await this.#sendTo(event, payload, [url])).get(url);
      relays.push(this.#tally(result, url, answer, true, true));
      this.#touchStandby(url);
    }
    const durable = relays.filter(isDurable).map((r) => r.url);
    const satisfied = durable.length >= min;
    const others = relays.filter((r) => !isDurable(r) && r.outcome !== 'not-connected');
    return {
      ...result,
      durability: {
        minAccepted: min,
        durable,
        satisfied,
        standbyUsed,
        relaysFull: !satisfied && others.length > 0 && others.every(isFullish),
        relays,
      },
    };
  }

  /** 送出並等每一座的 OK（逾時的不在結果裡）；順便把結果餵給健康狀態 */
  #sendTo(event: Event, payload: string, urls: readonly string[]): Promise<Map<string, Answer>> {
    return new Promise((resolve) => {
      const answers = new Map<string, Answer>();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.#pending.delete(event.id);
        for (const [, connection] of this.#all()) connection.authQueue.delete(event.id);
        for (const [url, answer] of answers) this.#observe(url, event.kind, payload.length, answer);
        resolve(answers);
      };
      if (urls.length === 0) {
        finish();
        return;
      }
      const listeners = new Map<string, OkListener>();
      for (const url of urls) {
        listeners.set(url, (ok, reason, kind) => {
          answers.set(url, { ok, reason, kind });
          if (answers.size === urls.length) finish();
        });
      }
      this.#pending.set(event.id, { payload, listeners });
      timer = setTimeout(finish, this.#publishTimeoutMs);
      for (const url of urls) this.#conn(url)?.socket?.send(payload);
    });
  }

  /** 一座的回覆整理進結果（`accepted`／`rejected`／`borrowed`），回傳這一座的狀態 */
  #tally(result: PublishResult, url: string, answer: Answer | undefined, sent: boolean, standby: boolean): RelayPublishState {
    if (answer === undefined) {
      const reason = sent ? 'timeout' : 'not connected';
      const entry = rejectedEntry(url, reason, localKind(reason)!);
      result.rejected.push(entry);
      return { url, standby, outcome: sent ? 'timeout' : 'not-connected', kind: entry.kind, reason };
    }
    if (answer.ok) {
      result.accepted.push(url);
      // `OK true "warning: borrowed:"`：收下了，但只是借用（SDK ADR 0039）。只有這時才加 `borrowed` 欄位
      if (answer.reason !== '' && classifyRelayMessage(answer.reason).kind === 'borrowed') {
        ((result as { borrowed?: string[] }).borrowed ??= []).push(url);
        return { url, standby, outcome: 'borrowed', kind: 'borrowed', reason: answer.reason };
      }
      return { url, standby, outcome: 'accepted' };
    }
    const klass = answer.kind !== undefined ? { kind: answer.kind } : classifyRelayMessage(answer.reason);
    // `duplicate` 是「本來就有這顆」：舊中繼回 `OK false "duplicate:"`，NIP-01 的範例是 `OK true`，兩種都算收下
    if (klass.kind === 'duplicate') {
      result.accepted.push(url);
      return { url, standby, outcome: 'duplicate' };
    }
    const entry = rejectedEntry(url, answer.reason, klass);
    result.rejected.push(entry);
    return { url, standby, outcome: 'rejected', kind: entry.kind, reason: answer.reason };
  }

  /** 一次發布的回覆餵給健康狀態（斷線的另外在 `#dropSocket` 以關閉碼記） */
  #observe(url: string, eventKind: number, bytes: number, answer: Answer): void {
    if (answer.ok) {
      const kind = answer.reason === '' ? undefined : classifyRelayMessage(answer.reason).kind;
      this.#health.accepted(url, eventKind, kind === 'borrowed');
      // 粗分級預警（SDK ADR 0042）：軟標記，不影響發布；借用不動它（借用本來就在天花板上）
      if (kind !== 'borrowed') this.#health.nearFull(url, eventKind, kind === 'near-full' ? parseNearFullWarning(answer.reason)?.percent : undefined);
      return;
    }
    if (answer.kind !== undefined) return;
    const klass = classifyRelayMessage(answer.reason);
    if (klass.kind === 'duplicate') this.#health.accepted(url, eventKind);
    else this.#health.observe(url, { kind: klass.kind, reason: answer.reason, token: klass.token, eventKind, bytes, source: 'ok' });
  }

  /** 延遲連上一座備援，等到開起來（或放棄） */
  #ensureStandby(url: string, timeoutMs: number = this.#connectTimeoutMs ?? this.#publishTimeoutMs): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    let connection = this.#standby.get(url);
    if (connection === undefined) {
      connection = newConnection(true);
      this.#standby.set(url, connection);
    }
    if (this.#isOpen(url)) return Promise.resolve(true);
    if (connection.socket === null) this.#open(url, connection);
    return this.#waitOpen(connection, timeoutMs, true);
  }

  /** 等一條連線開起來；`failOnClose`＝斷了就不等（備援），否則等到逾時（主要中繼會自己重連） */
  #waitOpen(connection: Connection, timeoutMs: number, failOnClose: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (open: boolean): void => {
        clearTimeout(timer);
        connection.waiters.delete(waiter);
        resolve(open);
      };
      const waiter = (open: boolean): void => {
        if (open || failOnClose) done(open);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      connection.waiters.add(waiter);
    });
  }

  /** 備援用過了：閒置 `standbyIdleMs` 後斷線（`standbySubscribe` 時不斷） */
  #touchStandby(url: string): void {
    const connection = this.#standby.get(url);
    if (connection === undefined) return;
    if (connection.read) {
      // 只讀的中繼不斷線：閒置後只是不再算在寫入集合裡（SDK ADR 0054）。進入與離開寫入集合都經健康狀態通知，
      // 依寫入集合重算的（watchRelayFileLimits）才跟得上（v0.44.0 修正）
      const entering = !connection.writing;
      connection.writing = true;
      if (entering) this.#emitHealth(url);
      if (connection.idleTimer !== null) clearTimeout(connection.idleTimer);
      connection.idleTimer = setTimeout(() => {
        connection.idleTimer = null;
        connection.writing = false;
        this.#emitHealth(url);
      }, this.#standbyIdleMs);
      return;
    }
    if (this.#standbySubscribe) return;
    if (connection.idleTimer !== null) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => {
      connection.idleTimer = null;
      if (connection.socket !== null) this.#dropSocket(url, connection, connection.socket);
    }, this.#standbyIdleMs);
  }

  /**
   * 每座中繼（主要與用過的備援）的健康狀態（SDK ADR 0041）：依拒收分類記下的標記、最近一次拒收／收下／借用。
   * 只存在記憶體（不持久化）；過期的標記不列出。
   */
  relayHealth(): ReadonlyMap<string, RelayHealthSnapshot> {
    return new Map(this.#all().map(([url]) => [url, this.#healthOf(url)]));
  }

  /** 健康狀態變了（新標記、標記清掉、備援連上或斷線）；同一個標記只是延長不通知。回傳取消函式 */
  onRelayHealthChange(listener: (url: string, health: RelayHealthSnapshot) => void): () => void {
    this.#healthListeners.add(listener);
    return () => {
      this.#healthListeners.delete(listener);
    };
  }

  /**
   * 清掉某座（或全部）的標記：站方改了設定之後。`filter` 只清某個範圍或某種狀態（例如 `{ scope: 'kind:1060' }`；SDK ADR 0044）。
   * 手上有新讀到的 NIP-11 時，優先用 {@link revalidateRelay}——它只清文件看得出已不成立的那些。
   */
  resetRelayHealth(url?: string, filter?: RelayHealthResetFilter): void {
    this.#health.reset(url, filter);
  }

  /**
   * 重新讀到某座的 NIP-11 之後重新驗證它的「不適用」標記（SDK ADR 0044）：文件表示原因已不成立的立刻清掉、
   * 經 `onRelayHealthChange` 通知（有清才通知），回傳清掉的標記。`info` 收原始 NIP-11 文件或 `fetchRelayFilePolicy` 的結果。
   *
   * 看得出來的：`files-disabled` ＋ `cinder_accepts_files: true`；`too-large`（檔案塊除外）＋ 宣告的上限不小於被拒的那顆；
   * `not-allowed` ＋ `limitation.restricted_writes: false`。其餘（kind 停用、已滿、限速、整座被拒）不動。
   * `observedAt`（預設現在）是讀到文件的時間：之後才出現的標記不清（文件與實際不符時不會每則都清掉重試）。
   * `watchRelayFileLimits` 每次讀 NIP-11 都會呼叫它（預設每 30 分鐘重讀一次）。
   */
  revalidateRelay(url: string, info: unknown, options: { observedAt?: number } = {}): RelayHealthMark[] {
    return this.#health.revalidate(url, info, options.observedAt);
  }

  /** 讀回稽核發現某座弄丟了自己的事件：把那一類資料標成已滿一段時間（ADR 0038 M4） */
  markEvicted(url: string, eventKind: number): void {
    this.#health.markEvicted(url, eventKind);
  }

  /**
   * 這一類事件實際會寫到哪幾座（SDK ADR 0038 §6）：沒被標記的主要中繼（不論現在連線與否），加上連著的備援。
   * `loadRelayFileLimits(pool.writeSet(1060))` 就是對實際寫入的那組取最小值。
   */
  writeSet(eventKind: number, bytes = 0): string[] {
    return this.#all()
      .filter(
        ([url, connection]) =>
          (!connection.standby || (connection.status !== 'closed' && (!connection.read || connection.writing))) && this.#health.blocking(url, eventKind, bytes) === undefined,
      )
      .map(([url]) => url);
  }

  #healthOf(url: string): RelayHealthSnapshot {
    const connection = this.#conn(url);
    return { url, standby: connection?.standby ?? false, status: connection?.status ?? 'closed', ...this.#health.snapshot(url) };
  }

  #emitHealth(url: string): void {
    if (this.#healthListeners.size === 0) return;
    const snapshot = this.#healthOf(url);
    for (const listener of this.#healthListeners) listener(url, snapshot);
  }

  /** 對每個 Relay 下同一個 REQ（之後才連上的也會補），事件以 id 去重、先驗簽。 */
  subscribe(filters: Filter[], handlers: SubscriptionHandlers, options: SubscribeOptions = {}): Subscription {
    this.#subscriptionCounter += 1;
    const id = `${this.#subscriptionPrefix}-${this.#subscriptionCounter}`;
    const subscription: ActiveSubscription = {
      filters,
      handlers,
      seen: new Set(),
      eoseNotified: false,
      cursor: undefined,
      backdateWindowSec: options.backdateWindowSec,
      resubscribedAt: new Map(),
    };
    this.#subscriptions.set(id, subscription);
    const request = JSON.stringify(['REQ', id, ...filters]);
    for (const url of this.#subscribedUrls()) {
      if (this.#isOpen(url)) {
        this.#conn(url)?.socket?.send(request);
      }
    }
    return {
      close: () => {
        if (!this.#subscriptions.delete(id)) {
          return;
        }
        const message = JSON.stringify(['CLOSE', id]);
        for (const url of this.#subscribedUrls()) {
          if (this.#isOpen(url)) {
            this.#conn(url)?.socket?.send(message);
          }
        }
      },
    };
  }

  /**
   * 逐座探針（SDK ADR 0003）：只對 `url` 那一座送一個小查詢，量到 EOSE 的往返時間（毫秒）。
   * 用來判斷「連得上但不轉發」的站。filter 要帶範圍（例如 `#t`），否則車道會 `CLOSED restricted`。
   * 沒連上、被 CLOSED、逾時或中途斷線都 reject。
   */
  ping(url: string, filters: Filter[], timeoutMs: number = this.#publishTimeoutMs): Promise<number> {
    if (!this.#isOpen(url)) return Promise.reject(new Error(`${url} 沒有連上`));
    this.#subscriptionCounter += 1;
    const id = `${this.#subscriptionPrefix}-ping-${this.#subscriptionCounter}`;
    const socket = this.#connections.get(url)!.socket!;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pings.delete(id);
        if (this.#isOpen(url)) socket.send(JSON.stringify(['CLOSE', id]));
        reject(new Error(`${url} 探針逾時`));
      }, timeoutMs);
      this.#pings.set(id, { url, started: Date.now(), timer, resolve, reject });
      socket.send(JSON.stringify(['REQ', id, ...filters]));
    });
  }

  /**
   * 跳過退避，立刻重連這一座（已經開著或正在連就不動）。給應用的健康探針用：
   * 探針本身是定期的，不該被退避擋住（SDK ADR 0004）。
   */
  reconnectNow(url: string): void {
    const connection = this.#connections.get(url) ?? (this.#standby.get(url)?.read ? this.#standby.get(url) : undefined);
    if (connection === undefined || this.#closed || connection.socket !== null) return;
    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    this.#open(url, connection);
  }

  /** 最近一次從這一座收到任何訊息的時間（毫秒）；沒收過是 null。有流量的站就不必探 */
  lastActivityAt(url: string): number | null {
    return this.#conn(url)?.lastActivityAt ?? null;
  }

  /**
   * 一次性查詢（SDK ADR 0005）：對每一座開著的站送同一個 REQ，**全部**回 EOSE（或被 CLOSED、斷線）
   * 才回；逾時就帶著已收到的回。結果以 id 去重、先驗簽，依 `created_at` 由新到舊。
   * 還沒有任何一座開起來時，先等第一座開起來（同一個逾時內）。
   */
  async query(filters: Filter[], timeoutMs: number = this.#publishTimeoutMs): Promise<Event[]> {
    return (await this.queryResult(filters, timeoutMs)).events;
  }

  /**
   * 與 `query` 相同的一次性查詢，另外回報每一座的狀態與「幾座完整回完」（SDK ADR 0045，G12a）。
   * `query` 在一座都沒開、或查到一半全部斷線時也回空陣列，分不出「查完了、沒有」與「根本沒查到」；
   * 依結果推進游標的程式碼（分頁補拉、喚醒時的增量）請用這個，`answered === 0` 時不推進。
   */
  async queryResult(
    filters: Filter[],
    timeoutMs: number = this.#publishTimeoutMs,
    options: { readonly waitForPrimary?: boolean } = {},
  ): Promise<RelayQueryOutcome> {
    const deadline = Date.now() + timeoutMs;
    // 主要中繼一座都沒開：平常等它開（同一個逾時內）；`waitForPrimary: false` 時不等，直接查開著的備援——
    // 主要中繼連不上、改用備援的那一輪用（SDK ADR 0093），否則逾時全花在等主要中繼，備援也跟著被算成逾時
    if (options.waitForPrimary !== false && !this.#urls.some((url) => this.#isOpen(url))) {
      await this.#waitForAnyOpen(timeoutMs);
    }
    // 只讀的中繼（SDK ADR 0054）也查：備援上的補發要讀得到；`answered` 只算主要中繼（備援平常只有少數補發，
    // 只有它回完不代表「翻完了」）
    const all = [...this.#urls, ...this.#readUrls()];
    const open = all.filter((url) => this.#isOpen(url));
    const statuses = new Map<string, { status: RelayQueryResult['status']; reason?: string }>(
      all.map((url) => [url, { status: open.includes(url) ? 'timeout' : 'not-connected' }]),
    );
    const events = open.length === 0 ? [] : await this.#runQuery(filters, open, deadline, undefined, statuses);
    const relays = all.map((url): RelayQueryStatus => {
      const state = statuses.get(url)!;
      return { url, status: state.status, ...(state.reason !== undefined ? { reason: state.reason } : {}), ...(this.#connections.has(url) ? {} : { read: true }) };
    });
    return { events, answered: relays.filter((r) => r.status === 'eose' && r.read !== true).length, relays };
  }

  /**
   * 逐座查詢（SDK ADR 0041，讀回稽核用）：與 `query` 相同的 REQ，但每一座的結果分開回，
   * 看得出「哪一座少了哪些」，也分得出「這座回完了、沒有」（`eose`）與「不知道」（`timeout`、`closed`…）。
   * 還沒開的主要中繼等到開（同一個逾時內）；`relays` 裡不在 `urls` 的當備援延遲連上，查完閒置斷線。
   */
  async queryEach(filters: Filter[], options: QueryEachOptions = {}): Promise<RelayQueryResult[]> {
    const timeoutMs = options.timeoutMs ?? this.#publishTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const relays = [...new Set(options.relays ?? this.#urls)];
    await Promise.all(
      relays.map((url) => {
        const connection = this.#connections.get(url);
        if (connection === undefined) return this.#ensureStandby(url, timeoutMs);
        return this.#isOpen(url) ? true : this.#waitOpen(connection, timeoutMs, false);
      }),
    );
    const open = relays.filter((url) => this.#isOpen(url));
    const each = new Map<string, EachState>(
      relays.map((url) => [url, { status: open.includes(url) ? 'timeout' : 'not-connected', events: [], ids: new Set() }]),
    );
    if (open.length > 0) await this.#runQuery(filters, open, deadline, each);
    for (const url of relays) if (!this.#connections.has(url)) this.#touchStandby(url);
    return relays.map((url) => {
      const state = each.get(url)!;
      return { url, status: state.status, events: state.events, ...(state.reason !== undefined ? { reason: state.reason } : {}) };
    });
  }

  #runQuery(
    filters: Filter[],
    open: readonly string[],
    deadline: number,
    each: Map<string, EachState> | undefined,
    statuses?: QueryState['statuses'],
  ): Promise<Event[]> {
    this.#subscriptionCounter += 1;
    const id = `${this.#subscriptionPrefix}-q-${this.#subscriptionCounter}`;
    // 逾時以「多久沒有新資料」計（SDK ADR 0077）：中繼一次可以回到約 16 MB，網路慢時固定的逾時會在傳到一半切斷、
    // 每次都算沒回完。每收到一則就從現在重新起算；最長延到逾時的 QUERY_MAX_EXTENSION 倍
    const idleMs = Math.max(0, deadline - Date.now());
    const capAt = Date.now() + idleMs * QUERY_MAX_EXTENSION;
    return new Promise<Event[]>((resolve) => {
      const request = JSON.stringify(['REQ', id, ...filters]);
      const state: QueryState = {
        waiting: new Set(open),
        request,
        awaitingAuth: new Set(),
        events: new Map(),
        each,
        statuses,
        finish: () => {
          if (!this.#queries.delete(id)) return;
          clearTimeout(timer);
          const close = JSON.stringify(['CLOSE', id]);
          for (const url of open) {
            if (this.#isOpen(url)) this.#conn(url)?.socket?.send(close);
          }
          resolve([...state.events.values()].sort((a, b) => b.created_at - a.created_at));
        },
        touch: () => {
          clearTimeout(timer);
          timer = setTimeout(() => state.finish(), Math.max(0, Math.min(idleMs, capAt - Date.now())));
        },
      };
      let timer = setTimeout(() => state.finish(), idleMs);
      this.#queries.set(id, state);
      for (const url of open) this.#conn(url)?.socket?.send(request);
    });
  }

  /** 收常駐訂閱的中繼：主要中繼與只讀的中繼，加上 `standbySubscribe` 時用過的備援 */
  #subscribedUrls(): string[] {
    return this.#standbySubscribe ? [...this.#urls, ...this.#standby.keys()] : [...this.#urls, ...this.#readUrls()];
  }

  /** 等任何一座開起來，最多等 `timeoutMs` */
  #waitForAnyOpen(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const stop = this.onStatusChange((_, status) => {
        if (status === 'open') done();
      });
      const timer = setTimeout(() => done(), timeoutMs);
      function done() {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  }

  /** 這一座不會再回這個查詢了（EOSE、CLOSED 或斷線） */
  #queryDone(id: string, url: string, status: RelayQueryResult['status'] = 'disconnected', reason?: string): boolean {
    const state = this.#queries.get(id);
    if (state === undefined) return false;
    const each = state.each?.get(url) ?? state.statuses?.get(url);
    if (each !== undefined && state.waiting.has(url)) {
      each.status = status;
      if (reason !== undefined) each.reason = reason;
    }
    state.waiting.delete(url);
    if (state.waiting.size === 0) state.finish();
    return true;
  }

  /** 這一座是否已通過 NIP-42 認證 */
  isAuthenticated(url: string): boolean {
    return this.#connections.get(url)?.authenticated === true;
  }

  #settlePing(id: string, error?: Error): boolean {
    const waiter = this.#pings.get(id);
    if (waiter === undefined) return false;
    this.#pings.delete(id);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(Date.now() - waiter.started);
    return true;
  }

  #isOpen(url: string): boolean {
    const connection = this.#conn(url);
    return (
      connection !== undefined &&
      connection.status === 'open' &&
      connection.socket !== null &&
      connection.socket.readyState === OPEN
    );
  }

  #setStatus(url: string, connection: Connection, status: RelayStatus): void {
    if (connection.status === status) {
      return;
    }
    connection.status = status;
    if (status !== 'connecting') for (const waiter of [...connection.waiters]) waiter(status === 'open');
    // 備援不在 `urls` 裡：不經 onStatusChange（應用的「在線」判斷只看主要中繼），改經健康狀態通知（寫入集合變了）
    if (connection.standby) {
      if (status !== 'connecting') this.#emitHealth(url);
      return;
    }
    for (const listener of this.#statusListeners) {
      listener(url, status);
    }
  }

  #open(url: string, connection: Connection): void {
    const socket = this.#createSocket(url);
    connection.socket = socket;
    this.#setStatus(url, connection, 'connecting');
    // 卡在連線中不會自己結束（不回應的站、被丟包的 SYN）：逾時就當作斷線，走一般的重連
    const connectTimer =
      this.#connectTimeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (connection.socket === socket && connection.status === 'connecting') {
              this.#dropSocket(url, connection, socket);
            }
          }, this.#connectTimeoutMs);
    socket.addEventListener('open', () => {
      if (connection.socket !== socket) {
        return;
      }
      if (connectTimer !== null) clearTimeout(connectTimer);
      // 退避不在這裡歸零：連上就被關的話，歸零就是迴圈（見 reconnectStableMs）
      connection.openedAt = Date.now();
      // 每條新連線都要重新認證
      connection.authenticated = false;
      connection.authEventId = null;
      connection.authQueue.clear();
      this.#setStatus(url, connection, 'open');
      this.#sendSubscriptions(socket, connection);
    });
    socket.addEventListener('message', (event) => {
      if (connection.socket !== socket || typeof event.data !== 'string') {
        return;
      }
      connection.lastActivityAt = Date.now();
      // 字元數 ≤ 位元組數：先用長度擋掉大多數，真的接近上限才算 UTF-8 位元組
      if (
        this.#maxFrameBytes !== undefined &&
        event.data.length > this.#maxFrameBytes / 4 &&
        new TextEncoder().encode(event.data).length > this.#maxFrameBytes
      ) {
        return;
      }
      this.#handleMessage(url, connection, socket, event.data);
    });
    socket.addEventListener('error', () => {
      // 瀏覽器在 error 之後一定會跟一個 close；重連在 close 處理
    });
    socket.addEventListener('close', (event) => {
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (connection.socket !== socket) {
        return;
      }
      this.#dropSocket(url, connection, socket, event?.code, event?.reason);
    });
  }

  /**
   * 這條 socket 不要了（斷線或連線逾時）：清狀態、讓等回覆的發布失敗、排重連。
   * 中繼帶關閉碼斷線（1008 限速、4003 白名單外…；SDK ADR 0038 P0-C）時：回報、進行中的發布以那個分類結案、
   * 重連直接用最長的退避——馬上重連只會再被踢一次。
   */
  #dropSocket(url: string, connection: Connection, socket: SocketLike, code?: number, reason?: string): void {
    if (connection.socket !== socket) {
      return;
    }
    const closed = code === undefined ? undefined : classifyRelayClose(code, reason);
    const kicked = closed !== undefined && closed.kind !== 'disconnected' ? closed : undefined;
    connection.socket = null;
    if (
      connection.openedAt !== null &&
      Date.now() - connection.openedAt >= this.#reconnectStableMs
    ) {
      connection.attempts = 0;
    }
    connection.openedAt = null;
    connection.authQueue.clear();
    for (const [id, waiter] of this.#pings) {
      if (waiter.url === url) this.#settlePing(id, new Error(`${url} 探針中途斷線`));
    }
    for (const id of [...this.#queries.keys()]) this.#queryDone(id, url);
    this.#setStatus(url, connection, 'closed');
    if (kicked !== undefined) {
      this.#health.observe(url, { kind: kicked.kind, reason: kicked.reason, source: 'close' });
      this.#onRelayReject?.(url, {
        source: 'close',
        kind: kicked.kind,
        retryable: kicked.retryable,
        tryOtherRelays: kicked.tryOtherRelays,
        reason: kicked.reason,
        ...(code !== undefined ? { code } : {}),
      });
      this.#failPending(url, `disconnected (${code}${kicked.reason ? ` ${kicked.reason}` : ''})`, kicked.kind);
    } else {
      this.#failPending(url);
    }
    // 備援不自動重連：下次要用時才再連（延遲連線，ADR 0031）；只讀的中繼照退避重連（SDK ADR 0054）
    if (!this.#closed && (!connection.standby || connection.read)) {
      // 暫時不能用（1013，SDK ADR 0108）：等到標記過期才重連——每 10 秒重連只會再被關一次（額度用完要等到隔天）
      const until = kicked?.kind === 'unavailable' ? this.#health.marks(url).find((mark) => mark.kind === 'unavailable')?.until : undefined;
      this.#scheduleReconnect(url, connection, kicked !== undefined, until === undefined ? undefined : until - Date.now());
    }
    try {
      socket.close();
    } catch {
      // 已經關了
    }
  }

  #scheduleReconnect(url: string, connection: Connection, longest = false, atLeastMs = 0): void {
    const last = this.#reconnectDelays.length - 1;
    const index = longest ? last : Math.min(connection.attempts, last);
    const delay = Math.max(this.#reconnectDelays[index] ?? DEFAULT_PUBLISH_TIMEOUT_MS, atLeastMs);
    connection.attempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      if (!this.#closed && connection.socket === null) {
        this.#open(url, connection);
      }
    }, delay);
  }

  /** 連線斷了：等這個 Relay 回 OK 的發布都當作沒送到 */
  #failPending(url: string, reason = 'disconnected', kind: RelayRejectKind = 'disconnected'): void {
    for (const pending of this.#pending.values()) {
      pending.listeners.get(url)?.(false, reason, kind);
    }
  }

  /**
   * 補送所有還活著的訂閱（剛連上、或剛認證成功）。看過事件的訂閱帶 `since`＝游標，
   * 不必把歷史整份重播一次（重播的也會被去重，只是白花流量）。
   *
   * 🔴 可能被回溯時間戳的 filter（禮物包、收件匣）再往前退讓兩天（SDK ADR 0035）：NIP-59 的外層時間被隨機往前推，
   * 而中繼對**即時轉發**也套用 since——只用游標的話，重連之後別人寄來的禮物包大多被中繼濾掉，直到下次重連。
   */
  #sendSubscriptions(socket: SocketLike, connection: Connection): void {
    if (connection.standby && !connection.read && !this.#standbySubscribe) return;
    for (const [id, subscription] of this.#subscriptions) {
      socket.send(this.#resumeRequest(id, subscription));
    }
  }

  /** 某個訂閱接續游標的 REQ（補訂閱、重訂共用） */
  #resumeRequest(id: string, subscription: ActiveSubscription): string {
    const cursor = subscription.cursor;
    const filters =
      cursor === undefined
        ? subscription.filters
        : subscription.filters.map((filter) => ({
            ...filter,
            since: resumeSince(filter, cursor, subscription.backdateWindowSec),
          }));
    return JSON.stringify(['REQ', id, ...filters]);
  }

  /** 以中繼的訊息回報一次拒收（分類在這裡做） */
  #reportRejection(url: string, source: RelayRejection['source'], reason: string, ids: { eventId?: string; subId?: string } = {}): void {
    if (this.#onRelayReject === undefined) return;
    const klass = classifyRelayMessage(reason);
    this.#onRelayReject(url, {
      source,
      kind: klass.kind,
      retryable: klass.retryable,
      tryOtherRelays: klass.tryOtherRelays,
      reason,
      ...(klass.token !== undefined ? { token: klass.token } : {}),
      ...ids,
    });
  }

  /** Relay 送來 NIP-42 挑戰：簽 22242 回覆。已認證或正在等 OK 就不重複回。 */
  #answerChallenge(
    url: string,
    connection: Connection,
    socket: SocketLike,
    challenge: string,
  ): void {
    if (
      this.#identity === undefined ||
      connection.authenticated ||
      connection.authEventId !== null
    ) {
      return;
    }
    const event = this.#identity.sign({
      kind: AUTH_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['relay', url],
        ['challenge', challenge],
      ],
      content: '',
    });
    connection.authEventId = event.id;
    socket.send(JSON.stringify(['AUTH', event]));
  }

  /** AUTH 的 OK：成功就補送訂閱、重送被擋的發布；失敗就把排隊的發布以 Relay 的理由結案。 */
  #finishAuth(
    url: string,
    connection: Connection,
    socket: SocketLike,
    ok: boolean,
    reason: string,
  ): void {
    connection.authEventId = null;
    if (ok) {
      connection.authenticated = true;
      this.#sendSubscriptions(socket, connection);
      for (const query of this.#queries.values()) {
        if (query.awaitingAuth.delete(url)) socket.send(query.request);
      }
      for (const eventId of connection.authQueue) {
        const pending = this.#pending.get(eventId);
        if (pending !== undefined) {
          socket.send(pending.payload);
        }
      }
    } else {
      for (const eventId of connection.authQueue) {
        const listener = this.#pending.get(eventId)?.listeners.get(url);
        if (listener === undefined) continue;
        this.#reportRejection(url, 'ok', reason, { eventId });
        listener(false, reason);
      }
      for (const [id, query] of [...this.#queries]) {
        if (query.awaitingAuth.delete(url)) this.#queryDone(id, url, 'closed', reason);
      }
    }
    connection.authQueue.clear();
  }

  #handleMessage(url: string, connection: Connection, socket: SocketLike, data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(message)) {
      return;
    }
    // 這座還在傳東西（例如剛連上時常駐訂閱往回拉的一大段）就不算閒置（SDK ADR 0080）：中繼依序處理同一條連線，
    // 查詢排在後面時，只看查詢自己的事件會在輪到它之前就逾時。上限照舊是逾時的 QUERY_MAX_EXTENSION 倍
    for (const query of this.#queries.values()) if (query.waiting.has(url)) query.touch();
    switch (message[0]) {
      case 'EVENT': {
        const query = this.#queries.get(String(message[1]));
        if (query !== undefined) {
          const found = message[2] as Event | undefined;
          if (found === undefined) return;
          query.touch();
          const each = query.each?.get(url);
          if (each !== undefined) {
            // 逐座：每一座回的都要自己驗過才算「這座有」（別座驗過的 id 不能替它作證）
            if (!each.ids.has(found.id) && verifyEvent(found)) {
              each.ids.add(found.id);
              each.events.push(found);
              query.events.set(found.id, found);
            }
          } else if (!query.events.has(found.id) && verifyEvent(found)) {
            query.events.set(found.id, found);
          }
          return;
        }
        const subscription = this.#subscriptions.get(String(message[1]));
        const event = message[2] as Event | undefined;
        if (subscription === undefined || event === undefined || !verifyEvent(event)) {
          return;
        }
        // 游標以本機時鐘為上限：一則 created_at 在遠未來的事件不能讓補訂閱的 since 把整條訂閱靜音
        subscription.cursor = Math.min(
          Math.max(subscription.cursor ?? 0, event.created_at),
          Math.floor(Date.now() / 1000),
        );
        if (subscription.seen.has(event.id)) {
          return;
        }
        subscription.seen.add(event.id);
        subscription.handlers.onEvent(event, url);
        return;
      }
      case 'EOSE': {
        // 回了 EOSE＝這座能正常服務：清掉「暫時不能用」（SDK ADR 0108）
        this.#health.served(url);
        if (this.#queryDone(String(message[1]), url, 'eose')) return;
        if (this.#settlePing(String(message[1]))) {
          socket.send(JSON.stringify(['CLOSE', String(message[1])]));
          return;
        }
        const subscription = this.#subscriptions.get(String(message[1]));
        // 只讀的中繼（SDK ADR 0054）的 EOSE 不算：「歷史送完了」只看主要中繼
        if (connection.read) return;
        if (subscription !== undefined && !subscription.eoseNotified) {
          subscription.eoseNotified = true;
          subscription.handlers.onEose?.();
        }
        return;
      }
      case 'OK': {
        const id = String(message[1]);
        const ok = message[2] === true;
        const reason = typeof message[3] === 'string' ? message[3] : '';
        if (id === connection.authEventId) {
          this.#finishAuth(url, connection, socket, ok, reason);
          return;
        }
        const pending = this.#pending.get(id);
        if (pending === undefined) {
          return;
        }
        if (
          !ok &&
          reason.startsWith(AUTH_REQUIRED_PREFIX) &&
          this.#identity !== undefined &&
          !connection.authenticated
        ) {
          // 認證中：等認證成功再重送；認證失敗、斷線或逾時時另行結案
          connection.authQueue.add(id);
          return;
        }
        const listener = pending.listeners.get(url);
        if (listener === undefined) return;
        if (!ok && classifyRelayMessage(reason).kind !== 'duplicate') this.#reportRejection(url, 'ok', reason, { eventId: id });
        listener(ok, reason);
        return;
      }
      case 'AUTH': {
        if (typeof message[1] === 'string') {
          connection.challenge = message[1];
          this.#answerChallenge(url, connection, socket, message[1]);
        }
        return;
      }
      case 'CLOSED': {
        // Relay 主動關掉訂閱：auth-required 的會在認證成功後補送；其他理由（例如 restricted）
        // 就讓這個 Relay 不回這個訂閱，其他 Relay 照常——但要記下原因
        const reason = typeof message[2] === 'string' ? message[2] : '';
        if (this.#settlePing(String(message[1]), new Error(`${url} 探針被拒：${reason}`))) return;
        // 認證中被擋（SDK ADR 0076）：auth-required，或收過挑戰、還沒認證完時的 restricted——應用車道一連上就發挑戰但不強制，
        // `#p` 只能是自己、「自己」要認證後才算數，認證完成前到的 REQ 回 restricted。認證成功後重送；認證後仍被擋才算拒絕
        const pendingAuth =
          this.#identity !== undefined &&
          !connection.authenticated &&
          (reason.startsWith(AUTH_REQUIRED_PREFIX) || (reason.startsWith(RESTRICTED_PREFIX) && connection.challenge !== null));
        const query = this.#queries.get(String(message[1]));
        if (query !== undefined) {
          // 認證中：等認證成功再對這一座重送（與常駐訂閱、發布同一套）
          if (pendingAuth) {
            query.awaitingAuth.add(url);
            return;
          }
          this.#onRelayProblem?.(url, reason);
          this.#reportRejection(url, 'closed', reason, { subId: String(message[1]) });
          this.#queryDone(String(message[1]), url, 'closed', reason);
          return;
        }
        if (pendingAuth || reason.startsWith(AUTH_REQUIRED_PREFIX)) return; // 認證成功後 #sendSubscriptions 會補送
        this.#onRelayProblem?.(url, reason);
        const subId = String(message[1]);
        const subscription = this.#subscriptions.get(subId);
        if (subscription === undefined) return; // 自己關掉的訂閱（CLOSE 的回覆）或不認得的
        this.#reportRejection(url, 'closed', reason, { subId });
        // 依詞元決定要不要重訂（SDK ADR 0038 P0-C；修改 ADR 0032）：只有中繼明說「請重訂」（`resubscribe`：
        // DO 重啟後遺失、或一時存不住）才重訂，而且同一座 30 秒內只一次；`restricted: scope:`、`invalid: too-large:`、
        // `rate-limited: subscriptions:` 重訂也一樣，不重訂。`auth-required` 在上面、認證後補送。
        if (classifyRelayMessage(reason).token === 'resubscribe') {
          const now = Date.now();
          const last = subscription.resubscribedAt.get(url);
          if (last === undefined || now - last >= RESUBSCRIBE_COOLDOWN_MS) {
            subscription.resubscribedAt.set(url, now);
            socket.send(this.#resumeRequest(subId, subscription));
          }
        }
        return;
      }
      case 'NOTICE':
        if (typeof message[1] === 'string') {
          // 丟棄計數（SDK ADR 0042）：`warning: dropped:` 不是問題也不是拒收，是給收件人的通知
          const dropped = parseDroppedNotice(message[1]);
          if (dropped !== undefined) {
            this.#health.dropped(url, dropped);
            this.#onRelayDropped?.({ url, ...dropped });
            return;
          }
          this.#onRelayProblem?.(url, message[1]);
          // 帶 NIP-01 前綴的 NOTICE 才算拒收（例如 `invalid: too-large: 訊息過大`、`rate-limited: …`）；`warning:` 不是
          const notice = classifyRelayMessage(message[1]);
          if (notice.kind !== 'unknown' && notice.prefix !== 'warning') this.#reportRejection(url, 'notice', message[1]);
        }
        return;
      default:
        return;
    }
  }
}
