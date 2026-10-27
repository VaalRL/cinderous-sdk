import { type SecretRef } from '../../deploy/config/types.js';
import { type IotAcl } from '../acl.js';
import { type IotPushLimits } from '../push.js';
import type { IotQueryMapEntry, IotTopicMapEntry } from './mapping.js';
/** 預設的環境變數名稱 */
export declare const IOT_ENV: {
    readonly homeSecret: "IOT_HOME_SECRET";
    readonly gatewayKey: "IOT_GATEWAY_KEY";
    readonly memberKey: "IOT_MEMBER_KEY";
    readonly mqttPassword: "MQTT_PASSWORD";
};
/** `iot-bridge.json` */
export interface IotBridgeConfigFile {
    mqtt: {
        url: string;
        username?: string;
        password?: SecretRef;
        clientId?: string;
    };
    relays: string[];
    gatewayKey?: SecretRef;
    homeSecret?: SecretRef;
    /** 初始角色名單（之後以 `$sys/acl` 由 owner 更新，存在 `aclFile`） */
    acl?: unknown;
    /** 角色名單的存檔（相對於設定檔）；預設 `iot-acl.json` */
    aclFile?: string;
    topicMap: IotTopicMapEntry[];
    queryMap?: IotQueryMapEntry[];
    throttle?: {
        minIntervalSec?: number;
        onChangeOnly?: boolean;
        queryMinIntervalSec?: number;
    };
    heartbeatSec?: number;
    maxSkewSec?: number;
    /**
     * 推播（ADR 0049 §11.1；路線 A 由閘道送）：有這一段才開。`storeFile`＝端點清單的存檔（相對於設定檔，預設 `iot-push.json`）；
     * 上限可調（預設每家 32 端點、標準 1／分、即時 6／分、TTL 30 天）；`allowPrivateHttp`＝允許家裡 `http://` 的 ntfy。
     */
    push?: IotBridgePushConfig;
}
export interface IotBridgePushConfig {
    enabled?: boolean;
    storeFile?: string;
    maxEndpoints?: number;
    standardPerMinute?: number;
    instantPerMinute?: number;
    registrationTtlSec?: number;
    allowPrivateHttp?: boolean;
}
/** `iot-client.json`（`cinderous iot acl` 用：owner 自己的身分、家庭秘密、閘道、中繼） */
export interface IotClientConfigFile {
    relays: string[];
    gateway: string;
    homeSecret?: SecretRef;
    memberKey?: SecretRef;
}
export interface ResolvedIotBridgeConfig {
    mqtt: {
        url: string;
        username?: string;
        password?: string;
        clientId?: string;
    };
    relays: string[];
    /** nsec */
    gatewayNsec: string;
    homeSecret: Uint8Array;
    acl?: IotAcl;
    aclFile: string;
    topicMap: IotTopicMapEntry[];
    queryMap: IotQueryMapEntry[];
    throttle: {
        minIntervalSec?: number;
        onChangeOnly?: boolean;
    };
    queryMinIntervalSec?: number;
    heartbeatSec?: number;
    maxSkewSec?: number;
    /** 推播：沒開＝undefined */
    push?: {
        storeFile: string;
        limits: Pick<IotPushLimits, 'maxEndpoints' | 'standardPerMinute' | 'instantPerMinute' | 'registrationTtlSec'>;
        allowPrivateHttp: boolean;
    };
}
export interface ResolvedIotClientConfig {
    relays: string[];
    gateway: string;
    homeSecret: Uint8Array;
    memberNsec: string;
}
/** nsec 或 64 位 hex 私鑰 → nsec */
export declare function iotNsecOf(value: string, where: string): string;
/** 驗證並解析 `iot-bridge.json`；秘密從 `env` 讀。寫錯就丟例外 */
export declare function resolveIotBridgeConfig(raw: unknown, env: Readonly<Record<string, string | undefined>>): ResolvedIotBridgeConfig;
/** 驗證並解析 `iot-client.json` */
export declare function resolveIotClientConfig(raw: unknown, env: Readonly<Record<string, string | undefined>>): ResolvedIotClientConfig;
//# sourceMappingURL=config.d.ts.map