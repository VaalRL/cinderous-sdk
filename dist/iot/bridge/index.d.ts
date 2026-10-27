import type { NostrSigner } from '../../protocol/signer.js';
import type { RelayEventBudget } from '../../relay-budget.js';
import { type SocketLike } from '../../relay-pool.js';
import { type IotAclInput, type IotAclStore } from '../acl.js';
import { IotClient } from '../client.js';
import { IotGateway, type IotGatewayLogEntry, type IotGatewayPushOptions } from '../gateway.js';
import { type IotHome } from '../keys.js';
import { type IotPushStore } from '../push-registry.js';
import type { IotTransport } from '../transport.js';
import type { ResolvedIotBridgeConfig, ResolvedIotClientConfig } from './config.js';
import { type IotQueryMapEntry, type IotTopicMapEntry } from './mapping.js';
export * from './mapping.js';
export * from './config.js';
/** 只用到的 mqtt.js 客戶端子集（不把 mqtt 的型別寫進我們的 .d.ts：沒裝 mqtt 的使用者也能編譯） */
export interface IotMqttClientLike {
    on(event: 'connect', listener: () => void): unknown;
    on(event: 'message', listener: (topic: string, payload: Uint8Array) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close' | 'offline' | 'reconnect', listener: () => void): unknown;
    subscribe(topics: string[], opts: {
        qos: 0 | 1;
    }, callback: (error: Error | null | undefined) => void): unknown;
    publish(topic: string, payload: string | Uint8Array, opts: {
        qos: 0 | 1;
        retain?: boolean;
    }, callback: (error?: Error | null) => void): unknown;
    end(force?: boolean, opts?: object, callback?: () => void): unknown;
}
export interface IotMqttConnectOptions {
    username?: string;
    password?: string;
    clientId?: string;
    connectTimeout?: number;
    reconnectPeriod?: number;
}
export type IotMqttConnect = (url: string, opts: IotMqttConnectOptions) => IotMqttClientLike;
/** 載入 mqtt.js（選用 peer 相依）；沒安裝就丟出明確的錯誤 */
export declare function loadMqttConnect(importer?: () => Promise<unknown>): Promise<IotMqttConnect>;
/** 角色名單存成 JSON 檔（先寫暫存檔再換名，寫到一半斷電不會留下壞檔） */
export declare function fileIotAclStore(path: string): IotAclStore;
/**
 * 推播端點清單存成 JSON 檔（ADR 0049 §11.1；先寫暫存檔再換名）。⚠ 內含端點能力（UnifiedPush 網址、登記密鑰），權限 0600、不要提交。
 */
export declare function fileIotPushStore(path: string, opts?: {
    allowPrivateHttp?: boolean;
}): IotPushStore;
export interface IotBridgeOptions {
    mqtt: {
        url: string;
        username?: string;
        password?: string;
        clientId?: string;
    };
    /** 要連的 relay（例如自架站，或官方錨點的 `iot` 車道）；`pool` 有給就不用 */
    relays?: readonly string[];
    /** 自己建好的連線池（測試、或與其他元件共用）；要以閘道身分認證 */
    pool?: IotTransport & {
        close?(): void;
    };
    /** 閘道的身分 */
    signer: NostrSigner;
    home: IotHome;
    acl?: IotAclInput;
    aclStore?: IotAclStore;
    topicMap: readonly IotTopicMapEntry[];
    queryMap?: readonly IotQueryMapEntry[];
    throttle?: {
        minIntervalSec?: number;
        onChangeOnly?: boolean;
        queryMinIntervalSec?: number;
    };
    heartbeatSec?: number;
    maxSkewSec?: number;
    queryTimeoutMs?: number;
    queryCollectMs?: number;
    retainedDebounceMs?: number;
    budget?: RelayEventBudget;
    /** 推播（ADR 0049 §11.1）：有給才開，閘道收 `$sys/push` 登記並在設備狀態變化時送出空的喚醒 */
    push?: IotGatewayPushOptions;
    /** 測試或自訂：取代 `import('mqtt').connect` */
    mqttConnect?: IotMqttConnect;
    /** 測試或自訂：WebSocket 工廠（預設全域 `WebSocket`；Node 20 沒有時載入 `ws`） */
    createSocket?: (url: string) => SocketLike;
    /** 啟動時等 relay 連上多久（毫秒），預設 10,000；逾時照樣啟動（連線池會自己重連，沒送出的名單與心跳稍後重送） */
    connectTimeoutMs?: number;
    /** MQTT publish 等多久沒回覆算逾時（毫秒），預設 5,000 */
    mqttPublishTimeoutMs?: number;
    onLog?: (entry: IotGatewayLogEntry) => void;
    onError?: (error: unknown) => void;
}
export interface IotBridge {
    readonly gateway: IotGateway;
    readonly pool: IotTransport;
    close(): Promise<void>;
}
/** 啟動橋接器：連 relay 與本地 broker、訂閱對照表、啟動閘道 */
export declare function startIotBridge(opts: IotBridgeOptions): Promise<IotBridge>;
/** 從解析過的設定檔啟動（CLI `cinderous iot bridge` 用） */
export declare function startIotBridgeFromConfig(config: ResolvedIotBridgeConfig, extra: {
    aclPath: string;
    pushPath?: string;
    onLog?: IotBridgeOptions['onLog'];
    onError?: IotBridgeOptions['onError'];
}): Promise<IotBridge & {
    gatewayNpub: string;
    homeTag: string;
}>;
/** 以成員（owner）身分連上 relay，給 CLI `cinderous iot acl` 用；用完記得 `close()` */
export declare function connectIotClient(config: ResolvedIotClientConfig, opts?: {
    createSocket?: (url: string) => SocketLike;
}): Promise<{
    client: IotClient;
    close(): void;
}>;
//# sourceMappingURL=index.d.ts.map