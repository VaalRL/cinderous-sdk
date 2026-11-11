/** NIP-86 請求的 Content-Type。 */
export declare const NIP86_CONTENT_TYPE = "application/nostr+json+rpc";
/** 請求內容上限（位元組）：一千人的名冊約 100 KiB，留十倍。 */
export declare const NIP86_MAX_BODY_BYTES: number;
/** 站名上限（字元）。 */
export declare const NIP86_NAME_MAX = 100;
/** 說明上限（字元）。 */
export declare const NIP86_DESCRIPTION_MAX = 2000;
/** 執行期改過、要存起來的東西；重開後蓋過環境變數（SDK ADR 0132 §8）。 */
export interface Nip86State {
    roster?: {
        updatedAt: number;
        allowed: string[];
    };
    allowedKinds?: number[];
    name?: string;
    description?: string;
}
/** 一次呼叫的結果：二選一。 */
export type Nip86Response = {
    result: unknown;
} | {
    error: string;
};
/** `Nip86Admin` 的設定。 */
export interface Nip86Options {
    /** 運維金鑰（hex）：可以呼叫管理 API 的人（`NIP86_ADMIN_PUBKEYS`）。 */
    admins: Iterable<string>;
    /** 名冊金鑰（hex，`ROSTER_ADMIN_PUBKEY`）：沒設＝不提供 `cinder_applyroster`。 */
    rosterAdmin?: string | undefined;
    /** 啟動時生效的白名單（環境變數，已被存檔蓋過的話是存檔的值）。 */
    allowed?: readonly string[] | undefined;
    /** 啟動時生效的事件類型清單；undefined＝全部接受。 */
    allowedKinds?: readonly number[] | undefined;
    /** 上次存的狀態（名冊的 `updatedAt` 用來擋舊名冊）。 */
    state?: Nip86State | undefined;
    /** 套用到中繼核心。 */
    apply: {
        allowed(list: string[]): void;
        kinds(list: number[]): void;
    };
    /** 存檔（純記憶體模式不給）。 */
    save?: ((state: Nip86State) => void) | undefined;
    /** 日誌（每次成功的寫入一行；不記參數內容）。 */
    log?: ((line: string) => void) | undefined;
}
/** 管理 API 的狀態與方法分派。 */
export declare class Nip86Admin {
    private readonly opts;
    private readonly admins;
    private readonly rosterAdmin;
    private allowed;
    private kinds;
    private state;
    constructor(opts: Nip86Options);
    /** 這個 pubkey 能不能呼叫管理 API。 */
    isAdmin(pubkey: string): boolean;
    /** 實際提供的方法（NIP-86 `supportedmethods`）。 */
    supportedMethods(): string[];
    /** 執行期改過的 NIP-11 欄位（宿主回應時蓋在原本的文件上）。 */
    info(): {
        name?: string;
        description?: string;
    };
    /** 呼叫一個方法。`caller` 是已通過 NIP-98 的運維金鑰（只用於日誌）。 */
    call(caller: string, method: string, params: unknown): Nip86Response;
    private commit;
    private applyRoster;
    private allowKind;
    private disallowKind;
    private setKinds;
    private changeText;
}
/** 這個 HTTP 請求是不是 NIP-86（POST＋`application/nostr+json+rpc`）。 */
export declare function isNip86Request(method: string | undefined, contentType: string | undefined): boolean;
/** 宿主交進來的 HTTP 請求。 */
export interface Nip86HttpRequest {
    method: string;
    contentType?: string | undefined;
    authorization?: string | undefined;
    body: string;
    /** 對外的主機（反向代理後方用 `X-Forwarded-Host`）。 */
    host?: string | undefined;
    /** 路徑（不含查詢字串）。 */
    path: string;
}
/**
 * 處理一個 NIP-86 HTTP 請求：大小 → NIP-98（綁 URL、method、內容、時間）→ 解析 → 分派。
 * 授權失敗一律 401、不說原因（同 `verifyHttpAuth`）。
 */
export declare function handleNip86Request(admin: Nip86Admin, req: Nip86HttpRequest, nowSec?: number): {
    status: number;
    body: Nip86Response;
};
//# sourceMappingURL=nip86.d.ts.map