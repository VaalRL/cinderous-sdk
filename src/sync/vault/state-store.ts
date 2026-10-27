// 狀態儲存（SDK ADR 0025 §持久化）：記憶體實作，以及協調器內部用的「每鍵序列化」包裝（ADR 0024 同一招）。
import type { SyncStateStore } from './types.js';

/** 記憶體實作：測試與範例用。`snapshot()`／`fromSnapshot` 可模擬「重新啟動、狀態還在」。 */
export class MemorySyncStateStore implements SyncStateStore {
  readonly #data: Map<string, Uint8Array>;

  constructor(initial?: ReadonlyMap<string, Uint8Array>) {
    this.#data = new Map([...(initial ?? [])].map(([k, v]) => [k, v.slice()]));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.#data.get(key);
    return value ? value.slice() : null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#data.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.#data.keys()].filter((k) => k.startsWith(prefix));
  }

  /** 目前內容的複本 */
  snapshot(): Map<string, Uint8Array> {
    return new Map([...this.#data].map(([k, v]) => [k, v.slice()]));
  }

  get size(): number {
    return this.#data.size;
  }
}

/**
 * 同一個鍵的寫入依序完成；讀取等排在前面的寫入完成。寫入失敗會往上拋給呼叫端，
 * 但鏈本身不會變成 rejected（之後的寫入照常執行）。
 */
export class SerializedStore {
  readonly #inner: SyncStateStore;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(inner: SyncStateStore) {
    this.#inner = inner;
  }

  #chain(key: string, op: () => Promise<void>): Promise<void> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const run = prev.then(op);
    const tail = run.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.#tails.get(key);
    return this.#inner.get(key);
  }

  set(key: string, value: Uint8Array): Promise<void> {
    const copy = value.slice();
    return this.#chain(key, () => this.#inner.set(key, copy));
  }

  delete(key: string): Promise<void> {
    return this.#chain(key, () => this.#inner.delete(key));
  }

  keys(prefix: string): Promise<string[]> {
    return this.#inner.keys(prefix);
  }

  /** 等所有排隊中的寫入完成 */
  async flush(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()]);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(bytes: Uint8Array | null): T | null {
  if (!bytes) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}
