import { type IotAcl, type IotAclInput, type IotRole } from '../iot/acl.js';
import type { NostrEvent } from '../protocol/event.js';
import { type PubkeyHex, type SecretKey } from '../protocol/keys.js';
import type { Outbound } from './relay-core.js';
/** 門鎖類設備必填的本地開啟方式（ADR 0049 §10.5） */
export declare const IOT_LOCAL_FALLBACKS: readonly ["key", "keypad", "lan", "ble", "button"];
export type IotLocalFallback = (typeof IOT_LOCAL_FALLBACKS)[number];
/** 每個家庭最多幾台設備（§9.6 `maxDevicesPerHome`） */
export declare const IOT_REALTIME_MAX_DEVICES = 64;
export declare const IOT_REALTIME_DEFAULT_HEARTBEAT_SEC = 30;
export declare const IOT_REALTIME_DEFAULT_TTL_MAX_SEC = 60;
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
export interface IotRealtimeDeviceConfig {
    /** 設備 id（設定裡有；relay 以它核對信封的 kid） */
    readonly id: string;
    /** `blind("dev:" + id)`：URL 與事件的 `d`／`dv`（CLI 以家庭秘密預先算好） */
    readonly blindId: string;
    /** 目前的金鑰版本（kid 的 epoch） */
    readonly epoch: number;
    /** 設備權杖的 SHA-256 hex（relay 只存雜湊） */
    readonly tokenHash: string;
    readonly class?: 'lock' | 'general';
    /** 操作這台設備至少要哪個角色（門鎖常設 `owner`） */
    readonly minRole?: IotRole;
    /** 門鎖類必填：不依賴 relay 的開啟方式（§10.5） */
    readonly localFallback?: readonly IotLocalFallback[];
    /** 輪換寬限：舊 epoch 在 `until`（unix 秒）之前照收（§2.6 `keyGraceSec`） */
    readonly previousEpoch?: {
        readonly epoch: number;
        readonly until: number;
    };
}
export interface IotRealtimeHomeConfig {
    readonly homeTag: string;
    /** 全家的 NIP-44 收件者（公開值） */
    readonly homePub: PubkeyHex;
    /** 閘道公鑰（手機以它加密外層、以它過濾 ack／狀態的作者） */
    readonly gatewayPubkey: PubkeyHex;
    readonly acl: IotAclInput;
    readonly devices: readonly IotRealtimeDeviceConfig[];
    /** 設備心跳間隔提示（秒，預設 30）；超過 3 倍沒有心跳視為 `stale` */
    readonly heartbeatSec?: number;
    /** 即時等級的時間窗（秒，預設 60）：外層訊息與信封的 ts 都要在這之內 */
    readonly realtimeTtlMaxSec?: number;
}
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
     * 額度預警與狀態（ADR 0049 §10.3）：25172、topic `$sys/quota`，`p`＝名單上的 owner（只給 owner，§10.4），內容加密給全家。
     * `payload` 是 JSON `{ state, used, limit, reset }`（reset＝下一個 UTC 00:00 的 unix 秒）。
     */
    quotaNotice(state: 'warn' | 'shed' | 'exhausted', used: number, limit: number, reset: number): NostrEvent;
}
export interface IotRealtimeIssue {
    readonly path: string;
    readonly code: 'shape' | 'home-tag' | 'home-duplicate' | 'pubkey' | 'acl' | 'too-many-devices' | 'device-id' | 'blind-id' | 'device-duplicate' | 'epoch' | 'token-hash' | 'role' | 'lock-local-fallback' | 'gateway-key-missing' | 'gateway-key-mismatch';
    readonly message: string;
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
 * 收集式：一次列出所有問題，有問題的家庭不啟用（不默默套用一半）。
 */
export declare function parseIotRealtimeConfig(raw: unknown, gatewayKeys: Record<string, string>): ParsedIotRealtime;
/** 給 CLI 與測試：把閘道私鑰轉成 `IOT_GATEWAY_KEYS` 的值 */
export declare function iotGatewayKeysJson(entries: Record<string, SecretKey>): string;
//# sourceMappingURL=iot-realtime.d.ts.map