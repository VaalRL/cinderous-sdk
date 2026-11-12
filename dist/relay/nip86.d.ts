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
    /**
     * `admin`＝名冊金鑰（擁有者，SDK ADR 0133）：重開後名冊金鑰換了或拿掉，這份就不再生效。
     * `coAdmins`／`ownerUpdatedAt`＝擁有者最新一份名冊列的共同管理者與那份的時間（SDK ADR 0135）。
     */
    roster?: {
        updatedAt: number;
        allowed: string[];
        admin?: string;
        coAdmins?: string[];
        ownerUpdatedAt?: number;
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
    /**
     * 現在可以簽名冊的 pubkey（擁有者在前，再接共同管理者；SDK ADR 0135）。沒設名冊金鑰回空陣列。
     * 宿主據此決定收到的 kind 10038 要不要交給 `applyRosterEvent`。
     */
    rosterSigners(): string[];
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
    call(caller: string, method: string, params: unknown, nowSec?: number): Nip86Response;
    /**
     * 名冊金鑰簽的名冊事件**發到了這座中繼**：照 `cinder_applyroster` 同一套檢查套用（SDK ADR 0134）。
     *
     * 不需要運維金鑰：權威本來就是名冊的簽章（Cinderous ADR-0047），運維金鑰只是另一條送達管道。
     * 舊的、重送的名冊回 `stale:` 錯誤（客戶端重新發布同一份名冊是常態，宿主不必當成問題）。
     */
    applyRosterEvent(event: unknown, nowSec?: number): Nip86Response;
    /**
     * 先存檔、存成功才換掉記憶體裡的狀態（SDK ADR 0133）。回 `false`＝沒存成，呼叫端不得套用。
     *
     * 過去是先套用後存檔：存檔拋錯會變成「這次生效、重開就消失」，被移除的人重開後又寫得進。
     */
    private persist;
    private applyRoster;
    private allowKind;
    private disallowKind;
    private setKinds;
    private changeText;
}
/**
 * 讀回存檔時驗結構（SDK ADR 0133）。任何一格不對就**整份不用**（回 `undefined`）：
 * 壞掉的存檔不該變成政策——`allowed: "abc"` 會被逐字拆成三個「成員」、空的 `allowedKinds` 會讓整站拒收、
 * 少了 `updatedAt` 會讓舊名冊重新被接受。
 */
export declare function parseNip86State(json: string): Nip86State | undefined;
/** 這個 HTTP 請求是不是 NIP-86（POST＋`application/nostr+json+rpc`）。 */
export declare function isNip86Request(method: string | undefined, contentType: string | undefined): boolean;
/** 宿主交進來的 HTTP 請求。 */
export interface Nip86HttpRequest {
    method: string;
    contentType?: string | undefined;
    authorization?: string | undefined;
    body: string;
    /** 請求的 `Host` 標頭。⚠ 這是對方寫的——沒設 `publicUrl` 時簽章只綁到「對方自稱的主機」。 */
    host?: string | undefined;
    /**
     * 本站對外的網址（`NIP86_PUBLIC_URL`，SDK ADR 0133）。設了就**只認簽給它的請求**，不看 `host` 與 `path`：
     * 同一把運維金鑰管好幾座站時，簽給甲站的請求不能拿到乙站重送。
     */
    publicUrl?: string | undefined;
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
/**
 * 讀請求內容**之前**的檢查（SDK ADR 0133）：標頭是運維金鑰簽的、還在時間窗內。
 * 沒過就不必收內容——否則任何人都能讓伺服器替他緩衝 1 MiB。⚠ 這不是授權（沒綁網址與內容），
 * 通過之後仍要走 {@link handleNip86Request}。
 */
export declare function nip86Precheck(admin: Nip86Admin, authorization: string | null | undefined, nowSec?: number): boolean;
//# sourceMappingURL=nip86.d.ts.map