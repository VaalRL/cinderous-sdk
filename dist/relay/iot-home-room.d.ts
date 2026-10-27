import { type ParsedIotRealtime } from './iot-realtime.js';
/** C′ 需要的環境變數與綁定（併入 worker 的 Env） */
export interface IotHomeEnv {
    /** 家庭 DO 的命名空間；沒有綁定＝這座站沒開 C′（`/iot/v1/*` 一律 404 `blocked: iot-disabled:`） */
    IOT_HOME?: DurableObjectNamespace;
    /** C′ 設定（JSON，非秘密）：`{ "homes": [ { homeTag, homePub, gatewayPubkey, acl, devices: [...] } ] }` */
    IOT_REALTIME?: string;
    /** 閘道私鑰（JSON `{ "<homeTag>": "<64 位 hex>" }`；Worker secret） */
    IOT_GATEWAY_KEYS?: string;
    /** 設備與手機升級的每 IP 限速（選配，Rate Limiting 綁定） */
    IOT_UPGRADE_LIMIT?: {
        limit(opts: {
            key: string;
        }): Promise<{
            success: boolean;
        }>;
    };
    /** 每個家庭每日的 DO 請求預算（§10.3）；沒設＝帳號每日 100,000 ÷ 家庭數 × 0.5 */
    IOT_HOME_DAILY_REQUESTS?: string;
    MAX_TTL_DAYS?: string;
}
/** 設備連線被新連線取代時的關閉碼 */
export declare const IOT_DEVICE_REPLACED_CLOSE = 4409;
/** 本家預算用完（§10.2）：reason `iot-quota:<reset unix 秒>`，設備據此睡到重置時間，不狂重連 */
export declare const IOT_QUOTA_CLOSE = 4429;
export type IotPath = {
    kind: 'home';
    homeTag: string;
} | {
    kind: 'dev';
    homeTag: string;
    blindId: string;
};
/** 解析 `/iot/v1/home/<homeTag>`、`/iot/v1/dev/<homeTag>/<blindId>`；其他回 undefined */
export declare function iotPathOf(pathname: string): IotPath | undefined;
/** 從 env 解析 C′ 設定（同一個 isolate 內快取；設定有錯的家庭不啟用，錯誤印一次） */
export declare function iotRealtimeFrom(env: Pick<IotHomeEnv, 'IOT_REALTIME' | 'IOT_GATEWAY_KEYS'>): ParsedIotRealtime;
/** relay 自己產生的 HTTP 錯誤（ADR 0049 §10.2）：一律帶 `Cinder-Relay: 1` 與 JSON `{ error }`，與平台的錯誤分得開 */
export declare function iotErrorResponse(status: number, error: string, headers?: Record<string, string>): Response;
/**
 * Worker 端：`/iot/v1/*` 的路由。回 undefined＝不是 IoT 路徑（交給一般路由）。
 * 在碰 DO 之前擋掉：沒開、不認得的家、權杖錯、不是升級——這些都不花 DO 請求。
 */
export declare function routeIotRequest(request: Request, env: IotHomeEnv): Promise<Response | undefined>;
/** 家庭 DO（每個家庭一顆，`idFromName("iot:<homeTag>")`） */
export declare class IotHomeRoom {
    private readonly ctx;
    private readonly env;
    private readonly exec;
    private readonly store;
    private readonly conns;
    private readonly core;
    private rt;
    private hydrated;
    private quota;
    constructor(ctx: DurableObjectState, env: IotHomeEnv);
    /** 綁定這顆 DO 服務的家庭（設定裡沒有或有錯＝不綁，指令一律拒收） */
    private bind;
    private aclStore;
    private deviceSockets;
    /**
     * 計一次用量（§10.3）：跨過門檻時通知 owner；用完就關掉所有連線（4429 帶重置時間）。回傳現在是不是已經用完。
     * 寫回 storage 是 fire-and-forget（DO 的 put 會在輸出閘門前完成），每 64 次或跨門檻才寫一次。
     */
    private count;
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
    webSocketClose(ws: WebSocket): void;
    webSocketError(ws: WebSocket): void;
    private closed;
    private ensureHydrated;
    private dispatch;
}
//# sourceMappingURL=iot-home-room.d.ts.map