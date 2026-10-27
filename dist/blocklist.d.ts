/**
 * 本機封鎖名單（SDK ADR 0001）：聊天與私訊共用。只在這台裝置生效，不上 Relay。
 */
import { type ChatStorageLike } from './chat-storage.js';
/** 封鎖名單在儲存裡的預設鍵；各應用可沿用自己既有的鍵 */
export declare const DEFAULT_BLOCKLIST_STORAGE_KEY = "cinderous:chat:blocked";
export declare class Blocklist {
    #private;
    /**
     * @param storage 存哪裡；省略就只在這次執行有效。可以是同步的 `ChatStorage`，
     *   也可以是非同步的 `AsyncChatStorage`（SDK ADR 0024）——後者在 `await ready()` 之前 `has()` 只看得到這次加的，
     *   所以請先等它再開收件匣。
     * @param key 存在哪個鍵；已上線的應用填自己原本的鍵，舊名單才讀得回來
     */
    constructor(storage?: ChatStorageLike, key?: string);
    has(pubkey: string): boolean;
    list(): readonly string[];
    add(pubkey: string): void;
    remove(pubkey: string): void;
    /** 舊名單讀回來之後完成。同步儲存（或沒有儲存）立刻完成。 */
    ready(): Promise<void>;
    /** 到目前為止的變更都寫進儲存之後完成。同步儲存（或沒有儲存）立刻完成。 */
    flush(): Promise<void>;
}
//# sourceMappingURL=blocklist.d.ts.map