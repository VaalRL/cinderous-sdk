import type { PubkeyHex } from '../protocol/keys.js';
import type { NostrSigner } from '../protocol/signer.js';
import type { ClassifiedRejection } from '../publish-rejections.js';
import { RelayEventBudget } from '../relay-budget.js';
import { type IotAcl, type IotAclEntryInput, type IotRole } from './acl.js';
import { type IotAckStatus, type IotEncoding, type IotTopicValue } from './content.js';
import { type IotHome } from './keys.js';
import { type IotPushEndpoint, type IotPushMode, type IotPushSpecial } from './push.js';
import { type IotTransport } from './transport.js';
export declare const IOT_DEFAULT_COMMAND_TIMEOUT_MS = 3000;
export declare const IOT_DEFAULT_COMMAND_RETRIES = 2;
export declare const IOT_DEFAULT_TTL_SEC = 30;
export declare const IOT_DEFAULT_CLIENT_QUERY_TIMEOUT_MS = 8000;
/** retained 多久沒更新就視為不可信（秒）：閘道每 6 小時刷新一次，留兩輪＋一小時 */
export declare const IOT_DEFAULT_STALE_AFTER_SEC: number;
/** 即時等級（ADR 0049 §9.4 裁示 5）：ttl 預設 15 秒、夾 5–60；等 ack 預設 5 秒、不重送 */
export declare const IOT_REALTIME_DEFAULT_TTL_SEC = 15;
export declare const IOT_REALTIME_MAX_TTL_SEC = 60;
export declare const IOT_REALTIME_DEFAULT_ACK_TIMEOUT_MS = 5000;
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
export type IotPushSubscriptionInput = {
    readonly device: string;
    readonly mode?: IotPushMode;
} | {
    readonly special: IotPushSpecial;
    readonly mode?: IotPushMode;
};
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
    readonly previousEpoch?: {
        readonly epoch: number;
        readonly until: number;
    };
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
export declare class IotClient {
    #private;
    constructor(opts: IotClientOptions);
    get gateway(): PubkeyHex;
    /** 關掉所有訂閱 */
    close(): void;
    /** 下一則操作（kind 25170），等 ack */
    command(topic: string, payload: string, opts?: IotCommandOptions): Promise<IotCommandResult>;
    /** 要求設備立刻回報（kind 25173，`viewer` 以上）；閘道節流或逾時時回 retained */
    query(device: string, opts?: {
        timeoutMs?: number;
        ttlSec?: number;
    }): Promise<IotQueryResult>;
    /**
     * 設備現在連著嗎（ADR 0049 §9.4）。C′：relay 以當下的連線即時回答（`dev-link`，不打擾設備、不落庫），`viewer` 以上；
     * 其他路線：retained 的 `online`（閘道最後一次知道的）。
     */
    deviceLink(device: string, opts?: {
        timeoutMs?: number;
    }): Promise<IotDeviceLink>;
    /** 改角色名單（只有 owner 會成功；ADR 0049 §2.5） */
    updateAcl(op: {
        op: 'add';
        entry: IotAclEntryInput;
    } | {
        op: 'remove';
        pubkey: string;
    }, opts?: Omit<IotCommandOptions, 'device' | 'enc'>): Promise<IotCommandResult>;
    /**
     * 登記（或更新）推播端點（ADR 0049 §11.1）：送到閘道的保留 topic `$sys/push`。端點本身再以 NIP-44 加密給閘道，其他成員讀不到；
     * 同一個端點再登記一次＝更新訂閱與續期。額度預警（`special: 'quota'`）只有 owner 能訂閱。
     * 端點怎麼來：UnifiedPush 網址由 App 的 distributor 給；推播閘道端點由 App 以 `sealIotPushToken` 封自己的 FCM／APNs token
     *（SDK 不做 FCM／APNs 註冊，ADR 0011 §6）。
     */
    registerPush(endpoint: IotPushEndpoint, subscriptions: readonly IotPushSubscriptionInput[], opts?: IotPushRegisterOptions): Promise<IotCommandResult & {
        endpointId: string;
    }>;
    /** 更新推播訂閱或續期（＝再登記一次同一個端點） */
    updatePush(endpoint: IotPushEndpoint, subscriptions: readonly IotPushSubscriptionInput[], opts?: IotPushRegisterOptions): Promise<IotCommandResult & {
        endpointId: string;
    }>;
    /** 撤銷推播端點（自己的；owner 可以撤銷任何人的）。推播閘道那一側另以 `buildIotPushRevokeBody` 撤銷封包 */
    revokePush(endpointOrId: IotPushEndpoint | string, opts?: Omit<IotCommandOptions, 'device' | 'enc' | 'confirmed'>): Promise<IotCommandResult>;
    /** 訂閱即時狀態（kind 25172）；`pattern` 是 MQTT 樣式（`+`、`#`） */
    subscribeState(pattern: string, onMessage: (message: IotStateMessage) => void): {
        close(): void;
    };
    /** 讀一台設備的 retained（31170），不打擾設備；沒有回 undefined */
    getRetained(device: string): Promise<IotRetainedState | undefined>;
    /** 這個家所有有 retained 的設備 */
    listDevices(): Promise<IotDeviceInfo[]>;
    /** 閘道目前的角色名單（閘道發的 31170 `sys:acl`）；讀不到或格式不對回 undefined */
    getAcl(): Promise<IotAcl | undefined>;
    /** 自己在閘道名單上的角色（讀 `sys:acl`）；不在名單或過期回 undefined */
    myRole(): Promise<IotRole | undefined>;
    /** 看閘道死活（31171 心跳；過期＝離線）。回傳停止函式 */
    watchGateway(onStatus: (status: IotGatewayStatus) => void): () => void;
}
//# sourceMappingURL=client.d.ts.map