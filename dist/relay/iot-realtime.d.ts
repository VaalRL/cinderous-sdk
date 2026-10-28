import { type IotAcl } from '../iot/acl.js';
import type { NostrEvent } from '../protocol/event.js';
import { type SecretKey } from '../protocol/keys.js';
import type { Outbound } from './relay-core.js';
import { type IotRealtimeDeviceConfig, type IotRealtimeHomeConfig, type IotRealtimeIssue } from './iot-realtime-config.js';
export { checkIotRealtimeAclShape, checkIotRealtimeConfig, IOT_LOCAL_FALLBACKS, IOT_REALTIME_BLIND_LENGTH, IOT_REALTIME_DEFAULT_HEARTBEAT_SEC, IOT_REALTIME_DEFAULT_TTL_MAX_SEC, IOT_REALTIME_MAX_DEVICES, IOT_REALTIME_MAX_HOMES, type IotLocalFallback, type IotRealtimeDeviceConfig, type IotRealtimeHomeConfig, type IotRealtimeIssue, } from './iot-realtime-config.js';
/** retained 每台最少隔多久寫一次（SQLite 每日寫入列是最可能先到頂的額度，§9.4） */
export declare const IOT_REALTIME_RETAINED_MIN_INTERVAL_SEC = 300;
/** 拒收訊息（ADR 0040 詞元句：「前綴: 詞元: 說明」） */
export declare const IOT_REALTIME_REJECT: {
    readonly home: "restricted: iot-home: this relay does not serve that home";
    readonly token: "restricted: iot-token: device token missing or wrong";
    readonly device: "restricted: iot-device: unknown device";
    readonly gatewayOnly: "restricted: iot-gateway-only: only the relay gateway publishes this kind here";
    readonly notGateway: "invalid: iot: the p tag must be this home gateway";
    readonly undecryptable: "invalid: iot: cannot open the outer layer (encrypt to the gateway pubkey)";
    readonly body: "invalid: iot: unknown or malformed body for this kind";
    readonly dv: "invalid: iot: dv tag does not match the device";
    readonly kid: "invalid: iot-e2ee: kid is not this device or its key epoch is retired";
    readonly envTime: "invalid: iot-e2ee: envelope timestamp outside the realtime window";
    readonly msgTime: "invalid: iot: message timestamp outside the realtime window";
    readonly duplicate: "duplicate: iot-msgid: already delivered to the device";
};
/** 宿主提供的設備連線（Workers：`getWebSockets(tag)`＋`getWebSocketAutoResponseTimestamp`；Node：記憶體） */
export interface IotRealtimeSockets {
    isConnected(blindId: string): boolean;
    /** 最後一次心跳（毫秒）；還沒有心跳回 undefined（視為剛連上、仍新鮮） */
    lastHeartbeatMs(blindId: string): number | undefined;
    /** 送一個幀給設備；沒有連線或送不出去回 false */
    send(blindId: string, text: string): boolean;
}
/** 角色名單的持久化（Workers：DO storage；Node：檔案或記憶體）；沒給＝只用設定裡的名單 */
export interface IotRealtimeAclStore {
    load(): IotAcl | undefined;
    save(acl: IotAcl): void;
}
export interface IotRealtimeHomeOptions {
    sockets: IotRealtimeSockets;
    aclStore?: IotRealtimeAclStore;
    /** 毫秒 */
    now?: () => number;
}
/** 攔截結果：`outbound`＝回給寄件人的訊息；`publish`＝relay 以閘道金鑰簽的事件，交給 `RelayCore.publishLocal` 扇出 */
export interface IotRealtimeInterceptResult {
    readonly outbound: Outbound[];
    readonly publish: NostrEvent[];
}
export type IotDeviceAuthResult = {
    readonly ok: true;
    readonly device: IotRealtimeDeviceConfig;
} | {
    readonly ok: false;
    readonly status: 401 | 404;
    readonly error: string;
};
export declare class IotRealtimeHome {
    #private;
    readonly config: IotRealtimeHomeConfig;
    constructor(config: IotRealtimeHomeConfig, gatewaySecret: SecretKey | string, opts: IotRealtimeHomeOptions);
    get homeTag(): string;
    /** 目前的角色名單 */
    acl(): IotAcl;
    device(blindId: string): IotRealtimeDeviceConfig | undefined;
    /** 設備連線的權杖（`Authorization: Bearer <權杖>`）：Worker 在碰 DO 之前就驗，錯的不花 DO 請求 */
    authenticateDevice(blindId: string, authorization: string | null | undefined): IotDeviceAuthResult;
    /** 設備是 `online`、`stale` 還是 `offline` */
    linkState(blindId: string): {
        state: 'online' | 'stale' | 'offline';
        lastHeartbeat?: number;
    };
    /**
     * 給 `RelayCore` 的 `intercept`：這個家的 IoT 指令由轉送半處理；閘道專屬 kind 一律拒收；其他 kind 回 undefined（照一般流程）。
     * 呼叫時事件已經驗過簽章、kind 政策、時鐘窗與速率限制。
     */
    interceptPhoneEvent(connId: string, event: NostrEvent, _authedPubkey: string | undefined): IotRealtimeInterceptResult | undefined;
    /**
     * 設備送來的幀：心跳回 `reply`（Workers 的自動回覆不會走到這裡；Node 宿主照回）；ack／state 包成給全家的事件。
     * 壞幀、kid 不是這台設備或已作廢的 epoch、ctr 沒有遞增 → 丟掉（不關連線，免得一個壞幀讓設備重連風暴）。
     */
    onDeviceFrame(blindId: string, data: string | Uint8Array, opts?: {
        shed?: boolean;
    }): {
        publish: NostrEvent[];
        reply?: string;
    };
    /**
     * 角色名單公告（SDK ADR 0121）：31170、`d`＝設定的 `aclBlindId`（＝blind("sys:acl")）、內容加密給全家，手機的 `getAcl()`／`myRole()` 讀它。
     * 設定沒有 `aclBlindId` 回 undefined。宿主在手機連上時呼叫（這個實例只公告一次；名單一改另外重發）。
     */
    aclAnnouncement(opts?: {
        force?: boolean;
    }): NostrEvent | undefined;
    /**
     * 額度預警與狀態（ADR 0049 §10.3）：25172、topic `$sys/quota`，`p`＝名單上的 owner（只給 owner，§10.4），內容加密給全家。
     * `payload` 是 JSON `{ state, used, limit, reset }`（reset＝下一個 UTC 00:00 的 unix 秒）。
     */
    quotaNotice(state: 'warn' | 'shed' | 'exhausted', used: number, limit: number, reset: number): NostrEvent;
}
export interface ParsedIotRealtime {
    readonly homes: Map<string, {
        readonly config: IotRealtimeHomeConfig;
        readonly gatewaySecret: SecretKey;
    }>;
    readonly issues: IotRealtimeIssue[];
}
/**
 * 解析 C′ 的設定（`IOT_REALTIME`，JSON；非秘密）與閘道金鑰（`IOT_GATEWAY_KEYS`，JSON `{homeTag: 64 位 hex}`；Worker secret）。
 * 收集式：一次列出所有問題，有問題的家庭不啟用（不默默套用一半）。形狀的檢查與部署設定器共用（`checkIotRealtimeConfig`）。
 */
export declare function parseIotRealtimeConfig(raw: unknown, gatewayKeys: Record<string, string>): ParsedIotRealtime;
/**
 * NIP-11 `cinder_iot.realtime` 要宣告的內容（SDK ADR 0120）：至少一個家庭有效才有；心跳取各家庭最短的那個。
 * 兩個宿主都從環境變數算（與實際啟用的家庭同一個解析函式），壞 JSON＝沒開。
 */
export declare function iotRealtimeAnnouncement(env: {
    IOT_REALTIME?: string | undefined;
    IOT_GATEWAY_KEYS?: string | undefined;
}): {
    heartbeatSec: number;
} | undefined;
/** 給 CLI 與測試：把閘道私鑰轉成 `IOT_GATEWAY_KEYS` 的值 */
export declare function iotGatewayKeysJson(entries: Record<string, SecretKey>): string;
//# sourceMappingURL=iot-realtime.d.ts.map