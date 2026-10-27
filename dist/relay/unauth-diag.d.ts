/**
 * 診斷「從頭到尾沒認證就斷線」的連線（SDK ADR 0111；移植自 Cinderous ADR-0392）。
 *
 * 2026-10-20：Cinderous 錨點 2 的 `shard-b` 一天約 1.1 萬條這種連線（輪替 IP、送 2 則、1006 斷線），
 * 推測是 Nostr 爬蟲。要知道它要什麼，才知道能不能便宜地打發它。
 *
 * 🔴 只記：訊息動詞序列、REQ 的 kind（數字）、中繼回覆的動詞與原因前綴、存活秒數、關閉碼。
 * **不記**內容、公鑰、filter 的其他欄位、IP；只寫 console（`wrangler tail` 當下看得到），不寫儲存。
 * 認證過的連線一律不記。預設關閉（`DIAG_UNAUTH_LOG=1` 才開）。
 */
export declare function unauthDiagEnabled(raw: string | undefined): boolean;
export declare class UnauthDiag {
    #private;
    constructor(opts?: {
        now?: () => number;
        maxConns?: number;
    });
    get size(): number;
    open(connId: string): void;
    inbound(connId: string, raw: string): void;
    outbound(connId: string, message: readonly unknown[]): void;
    /** 認證成功：之後不再記，關閉時也不印 */
    authed(connId: string): void;
    /** 連線結束：沒認證過就回一行摘要（呼叫端 console.log），否則 null */
    close(connId: string, code: number | undefined): string | null;
}
//# sourceMappingURL=unauth-diag.d.ts.map