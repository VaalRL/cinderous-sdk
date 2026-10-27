import type { Filter } from 'nostr-tools/filter';
import type { PubkeyHex } from '../protocol/keys.js';
import type { NostrSigner } from '../protocol/signer.js';
import { RelayEventBudget } from '../relay-budget.js';
import { type IotAcl, type IotAclInput, type IotAclStore, type IotRole } from './acl.js';
import { type IotAckStatus, type IotEncoding, type IotTopicValue } from './content.js';
import { type IotHome } from './keys.js';
import { type IotPushLimits, type IotPushRegistration, type IotPushSend, type IotPushSpecial } from './push.js';
import { type IotPushStore } from './push-registry.js';
import { type IotPushTimers } from './push-scheduler.js';
import { type IotTransport } from './transport.js';
export declare const IOT_DEFAULT_HEARTBEAT_SEC = 60;
export declare const IOT_DEFAULT_RETAINED_REFRESH_SEC: number;
export declare const IOT_DEFAULT_QUERY_MIN_INTERVAL_SEC = 5;
export declare const IOT_DEFAULT_QUERY_TIMEOUT_MS = 5000;
/** 交給設備的一則操作（已通過授權） */
export interface IotCommandRequest {
    readonly topic: string;
    readonly device?: string;
    readonly payload: string;
    readonly enc: IotEncoding;
    readonly msgId: string;
    /** 下指令的成員（外層事件的簽章者） */
    readonly from: PubkeyHex;
    readonly role: IotRole;
}
export interface IotCommandOutcome {
    readonly status: Extract<IotAckStatus, 'ok' | 'rejected' | 'unknown-topic' | 'timeout'>;
    readonly reason?: string;
}
export type IotQueryDispatch = 'sent' | 'unsupported' | 'unknown-device';
/** 設備那一側（橋接器實作；B／C 由 relay 內建模組實作） */
export interface IotGatewayHandler {
    /** 執行一則操作（例如轉成 MQTT publish） */
    command(request: IotCommandRequest): IotCommandOutcome | Promise<IotCommandOutcome>;
    /**
     * 要求設備立刻回報（例如 Tasmota `cmnd/<dev>/STATUS`）；回報到了請呼叫 `reportState`。
     * `sent`＝已送出原生查詢；`unsupported`＝這台設備沒有原生查詢（以 retained 回覆）；`unknown-device`＝不認得。
     * 沒有實作＝一律以 retained 回覆。
     */
    query?(device: string): IotQueryDispatch | Promise<IotQueryDispatch>;
    /** 由 topic 推出設備 id（topic 對照表）；角色名單依設備細分時用 */
    deviceOf?(topic: string): string | undefined;
}
/** 閘道的活動紀錄（給 CLI 印出、或應用自己的稽核） */
export interface IotGatewayLogEntry {
    readonly kind: 'command' | 'query' | 'acl' | 'drop' | 'push';
    readonly from?: PubkeyHex;
    readonly topic?: string;
    readonly device?: string;
    readonly status?: IotAckStatus;
    readonly reason?: string;
}
export interface IotGatewayOptions {
    /** 連線池（以閘道身分認證：要讀 `#p`＝自己的指令） */
    pool: IotTransport;
    /** 閘道自己的 Nostr 身分（ADR 0023） */
    signer: NostrSigner;
    home: IotHome;
    handler: IotGatewayHandler;
    /** 初始角色名單；`aclStore` 裡有存檔時以存檔為準（之後只能由 owner 經 `$sys/acl` 修改） */
    acl?: IotAclInput;
    aclStore?: IotAclStore;
    /** 事件預算；預設與同一身分共用 `sharedRelayEventBudget(signer.pubkey)`（路線 A 的閘道是一般身分，ADR 0049 §6） */
    budget?: RelayEventBudget;
    /** 時間窗（秒），預設 30，夾 5–120 */
    maxSkewSec?: number;
    /** msgId 去重筆數，預設 1,024 */
    dedupeSize?: number;
    /** 心跳間隔（秒），預設 60，夾 15–600 */
    heartbeatSec?: number;
    /** retained 至少多久重發一次（秒），預設 6 小時（維持「活躍即保存」），夾 600–86,400 */
    retainedRefreshSec?: number;
    /** 同一台設備多久才把查詢轉給設備一次（秒），預設 5，夾 1–300；其餘以 retained 回覆（`throttled`） */
    queryMinIntervalSec?: number;
    /** 等設備回報多久（毫秒），預設 5,000；逾時回 `timeout` 並附 retained */
    queryTimeoutMs?: number;
    /** 設備回報後再收集多久才回覆查詢（同一次回報可能分好幾個 topic），預設 300 毫秒 */
    queryCollectMs?: number;
    /** retained 的合併延遲（毫秒）：同一台設備短時間內多個 topic 變化只發一顆，預設 1,000 */
    retainedDebounceMs?: number;
    /**
     * 即時狀態的節流（ADR 0049 §3 的 `throttle`；使用者裁示 1：只做低頻控制＋最新狀態）：
     * `minIntervalSec`＝同一個 topic 兩則即時狀態至少隔多久（期間的最後一個值在時間到時補發），`onChangeOnly`＝值沒變就不發即時狀態。
     * 查詢的回報不受節流。retained 一律只在值變化時更新（加上定期刷新）。
     */
    throttle?: {
        minIntervalSec?: number;
        onChangeOnly?: boolean;
    };
    /**
     * 推播（ADR 0049 §11、§11.1；路線 A 由閘道送）：有給才開。收 `$sys/push` 登記（任何有效成員；額度預警只有 owner）、
     * 保存端點清單（帶 TTL）、設備狀態有變化時依訂閱的設備經「合併＋抖動」排程器送出**空的**喚醒。沒開時 `$sys/push` 回 `rejected`（`push-disabled`）。
     */
    push?: IotGatewayPushOptions;
    now?: () => number;
    onError?: (error: unknown) => void;
    onLog?: (entry: IotGatewayLogEntry) => void;
}
/** 閘道的推播選項（ADR 0049 §11.1） */
export interface IotGatewayPushOptions {
    /** 端點清單的持久化；預設只在記憶體（重開就沒了，App 啟動時會重新登記） */
    store?: IotPushStore;
    /** 送出一次喚醒；預設 `fetchIotPushSend()`（以 fetch 送 UnifiedPush 或推播閘道） */
    send?: IotPushSend;
    /** 上限（每家端點數、標準／即時每分鐘次數、TTL）；預設見 `IOT_PUSH_LIMITS` */
    limits?: Partial<IotPushLimits>;
    /** 允許 `http://` 的區網端點（例如家裡的 ntfy）；預設不允許 */
    allowPrivateHttp?: boolean;
    /** 排程器的亂數與計時器（測試注入） */
    random?: () => number;
    timers?: IotPushTimers;
}
export declare class IotGateway {
    #private;
    constructor(opts: IotGatewayOptions);
    get pubkey(): PubkeyHex;
    /** 目前的角色名單（閘道本地為準） */
    acl(): IotAcl;
    /** 閘道收指令與查詢的過濾條件 */
    filters(): Filter[];
    /** 讀回存檔的名單、訂閱、發出名單與第一次心跳、開始定期刷新 */
    start(): Promise<void>;
    /** 停止；`announceOffline`（預設 true）先發一顆 `online: false` 的心跳 */
    stop(opts?: {
        announceOffline?: boolean;
    }): Promise<void>;
    /**
     * 設備回報了一個 topic 的值（橋接器收到 MQTT 訊息時呼叫）：更新本機快取 → 回覆等待中的查詢 → 發即時狀態（節流）→
     * 值有變就（合併延遲後）更新 retained。
     */
    reportState(input: {
        topic: string;
        payload: string;
        device?: string;
        enc?: IotEncoding;
        will?: boolean;
        online?: boolean;
    }): Promise<void>;
    /** 設備上線／離線（例如橋接器看到設備的 LWT）；只更新 retained 的 `online` */
    setDeviceOnline(device: string, online: boolean): void;
    /**
     * 特殊項目的喚醒（裁示 1：額度預警只有 owner 能訂閱）。路線 A 的閘道本身看不到中繼額度，由宿主（或日後的中繼送出端）呼叫；
     * `ref`＝相關事件的 id（選用）。沒開推播＝什麼都不做。
     */
    notifyPushSpecial(special: IotPushSpecial, ref?: string): void;
    /** 目前保存的推播登記（不含已過期的；沒開推播＝空陣列）。內容含端點能力，只給本機管理介面用 */
    pushRegistrations(): IotPushRegistration[];
    /** 本機快取的一台設備（測試與橋接器用） */
    deviceSnapshot(device: string): {
        topics: Readonly<Record<string, IotTopicValue>>;
        online?: boolean;
    } | undefined;
}
//# sourceMappingURL=gateway.d.ts.map