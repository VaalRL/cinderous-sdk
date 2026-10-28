import type { IotAclInput, IotRole } from '../iot/acl.js';
import type { PubkeyHex } from '../protocol/keys.js';
/** 門鎖類設備必填的本地開啟方式（ADR 0049 §10.5） */
export declare const IOT_LOCAL_FALLBACKS: readonly ["key", "keypad", "lan", "ble", "button"];
export type IotLocalFallback = (typeof IOT_LOCAL_FALLBACKS)[number];
/** 每個家庭最多幾台設備（§9.6 `maxDevicesPerHome`） */
export declare const IOT_REALTIME_MAX_DEVICES = 64;
/** 一座 relay 最多服務幾個家庭（每個家庭一顆 DO；自架站的上界，防止設定錯誤時建一大堆 DO） */
export declare const IOT_REALTIME_MAX_HOMES = 32;
/**
 * 家庭那顆儲存的可尋址上限（每個作者每個 kind）：閘道公鑰替每台設備存一顆 31170 retained，另加一顆名單公告。
 * 沿用嚴格平面的 5 會讓第 5 台以後的 retained 被悄悄拒掉（SDK ADR 0121 發現）。
 */
export declare const IOT_REALTIME_ADDRESSABLE_PER_AUTHOR: number;
export declare const IOT_REALTIME_DEFAULT_HEARTBEAT_SEC = 30;
export declare const IOT_REALTIME_DEFAULT_TTL_MAX_SEC = 60;
/** 換金鑰時舊版本的寬限（秒；ADR 0049 §2.6 `keyGraceSec`）：預設一天、最多七天（SDK ADR 0122） */
export declare const IOT_KEY_GRACE_DEFAULT_SEC = 86400;
export declare const IOT_KEY_GRACE_MAX_SEC = 604800;
/** 盲化 id 的長度（＝`./iot` 的 `IOT_BLIND_LENGTH`；這裡不能引用 `./iot`，測試比對兩者一致） */
export declare const IOT_REALTIME_BLIND_LENGTH = 22;
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
    /**
     * `blind("sys:acl")`（SDK ADR 0121）：給了，relay 就以 31170 公告角色名單（加密給全家），手機的 `myRole()`／`getAcl()` 讀得到。
     * relay 沒有 `topicKey` 算不出來，由 `cinderous iot realtime home` 預先算好。
     */
    readonly aclBlindId?: string;
}
export interface IotRealtimeIssue {
    readonly path: string;
    readonly code: 'shape' | 'too-many-homes' | 'home-tag' | 'home-duplicate' | 'pubkey' | 'acl' | 'too-many-devices' | 'device-id' | 'blind-id' | 'device-duplicate' | 'epoch' | 'token-hash' | 'role' | 'lock-local-fallback' | 'range' | 'gateway-key-missing' | 'gateway-key-mismatch';
    readonly message: string;
}
export declare const IOT_REALTIME_BLIND_PATTERN: RegExp;
/**
 * 檢查 C′ 的設定（收集式：一次列出所有問題）。回傳每個家庭（以 index 對應）各自的問題數，給 relay 決定哪些家庭不啟用。
 * `checkAcl` 丟例外＝名單不合法（訊息會放進問題）。
 */
export declare function checkIotRealtimeConfig(raw: unknown, checkAcl: (acl: unknown) => void): {
    readonly issues: IotRealtimeIssue[];
    readonly homes: {
        readonly index: number;
        readonly home: Record<string, unknown>;
        readonly ok: boolean;
    }[];
};
/**
 * 部署設定器用的名單形狀檢查（不帶進 `./iot`）：陣列、每項有 pubkey（npub 或 64 位 hex）與合法角色。
 * topic 樣式、到期時間等細節由 relay 啟動時的 `parseIotAcl` 再驗一次。
 */
export declare function checkIotRealtimeAclShape(acl: unknown): void;
//# sourceMappingURL=iot-realtime-config.d.ts.map