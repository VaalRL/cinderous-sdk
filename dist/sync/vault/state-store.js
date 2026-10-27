/** 記憶體實作：測試與範例用。`snapshot()`／`fromSnapshot` 可模擬「重新啟動、狀態還在」。 */
export class MemorySyncStateStore {
    #data;
    constructor(initial) {
        this.#data = new Map([...(initial ?? [])].map(([k, v]) => [k, v.slice()]));
    }
    async get(key) {
        const value = this.#data.get(key);
        return value ? value.slice() : null;
    }
    async set(key, value) {
        this.#data.set(key, value.slice());
    }
    async delete(key) {
        this.#data.delete(key);
    }
    async keys(prefix) {
        return [...this.#data.keys()].filter((k) => k.startsWith(prefix));
    }
    /** 目前內容的複本 */
    snapshot() {
        return new Map([...this.#data].map(([k, v]) => [k, v.slice()]));
    }
    get size() {
        return this.#data.size;
    }
}
/**
 * 同一個鍵的寫入依序完成；讀取等排在前面的寫入完成。寫入失敗會往上拋給呼叫端，
 * 但鏈本身不會變成 rejected（之後的寫入照常執行）。
 */
export class SerializedStore {
    #inner;
    #tails = new Map();
    constructor(inner) {
        this.#inner = inner;
    }
    #chain(key, op) {
        const prev = this.#tails.get(key) ?? Promise.resolve();
        const run = prev.then(op);
        const tail = run.catch(() => { });
        this.#tails.set(key, tail);
        void tail.then(() => {
            if (this.#tails.get(key) === tail)
                this.#tails.delete(key);
        });
        return run;
    }
    async get(key) {
        await this.#tails.get(key);
        return this.#inner.get(key);
    }
    set(key, value) {
        const copy = value.slice();
        return this.#chain(key, () => this.#inner.set(key, copy));
    }
    delete(key) {
        return this.#chain(key, () => this.#inner.delete(key));
    }
    keys(prefix) {
        return this.#inner.keys(prefix);
    }
    /** 等所有排隊中的寫入完成 */
    async flush() {
        while (this.#tails.size > 0)
            await Promise.all([...this.#tails.values()]);
    }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function encodeJson(value) {
    return encoder.encode(JSON.stringify(value));
}
export function decodeJson(bytes) {
    if (!bytes)
        return null;
    try {
        return JSON.parse(decoder.decode(bytes));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=state-store.js.map