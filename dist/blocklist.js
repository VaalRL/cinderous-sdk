/**
 * 本機封鎖名單（SDK ADR 0001）：聊天與私訊共用。只在這台裝置生效，不上 Relay。
 */
var _a;
import { StorageSlot } from './chat-storage.js';
/** 封鎖名單在儲存裡的預設鍵；各應用可沿用自己既有的鍵 */
export const DEFAULT_BLOCKLIST_STORAGE_KEY = 'cinderous:chat:blocked';
export class Blocklist {
    #slot;
    #blocked = new Set();
    /** 讀回之前的變更（依序）：讀回之後疊在舊名單上 */
    #pending = [];
    /**
     * @param storage 存哪裡；省略就只在這次執行有效。可以是同步的 `ChatStorage`，
     *   也可以是非同步的 `AsyncChatStorage`（SDK ADR 0024）——後者在 `await ready()` 之前 `has()` 只看得到這次加的，
     *   所以請先等它再開收件匣。
     * @param key 存在哪個鍵；已上線的應用填自己原本的鍵，舊名單才讀得回來
     */
    constructor(storage, key = DEFAULT_BLOCKLIST_STORAGE_KEY) {
        this.#slot = new StorageSlot(storage, key);
        this.#slot.load((raw) => this.#onLoaded(raw));
    }
    has(pubkey) {
        return this.#blocked.has(pubkey);
    }
    list() {
        return [...this.#blocked];
    }
    add(pubkey) {
        this.#pending?.push({ add: true, pubkey });
        this.#save(new Set([...this.#blocked, pubkey]));
    }
    remove(pubkey) {
        this.#pending?.push({ add: false, pubkey });
        const next = new Set(this.#blocked);
        next.delete(pubkey);
        this.#save(next);
    }
    /** 舊名單讀回來之後完成。同步儲存（或沒有儲存）立刻完成。 */
    ready() {
        return this.#slot.ready();
    }
    /** 到目前為止的變更都寫進儲存之後完成。同步儲存（或沒有儲存）立刻完成。 */
    flush() {
        return this.#slot.flush();
    }
    #save(next) {
        this.#blocked = next;
        // 存不進去就只在這次啟動有效。非同步儲存：排隊，輪到時寫當下最新的名單
        this.#slot.save(() => JSON.stringify([...this.#blocked]));
    }
    /** 同步儲存在建構時就走到這裡（沒有待套用的變更，結果與以前相同、也不寫回） */
    #onLoaded(raw) {
        const pending = this.#pending ?? [];
        this.#pending = undefined;
        const next = new Set(_a.#parse(raw));
        for (const change of pending) {
            if (change.add)
                next.add(change.pubkey);
            else
                next.delete(change.pubkey);
        }
        if (pending.length > 0)
            this.#save(next);
        else
            this.#blocked = next;
    }
    static #parse(raw) {
        try {
            const parsed = JSON.parse(raw ?? '[]');
            return Array.isArray(parsed)
                ? parsed.filter((entry) => typeof entry === 'string')
                : [];
        }
        catch {
            return [];
        }
    }
}
_a = Blocklist;
//# sourceMappingURL=blocklist.js.map