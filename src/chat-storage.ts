/**
 * 聊天資料的儲存（SDK ADR 0024）：私訊對話與封鎖名單存在哪裡由應用決定。
 *
 * - `ChatStorage`（在 `dm.ts`，既有）：同步，`localStorage` 的子集。
 * - `AsyncChatStorage`（新增）：非同步，給 IndexedDB 之類的儲存。
 *
 * `DirectMessages` 與 `Blocklist` 兩種都收。同步儲存的行為與以前完全相同；
 * 非同步儲存時，讀取在背景進行（`ready()` 等它），寫入一律排隊、一次一個（`flush()` 等它們寫完）。
 */

import type { ChatStorage } from './dm.js';

/** 非同步版的 `ChatStorage`：IndexedDB、檔案系統、外掛的資料 API 等 */
export interface AsyncChatStorage {
  /** 讀回存著的值；沒有回 `null`。失敗就 reject（SDK 會改成只留在記憶體，不會拿空白蓋掉舊資料） */
  getItem(key: string): Promise<string | null>;
  /** 存起這個值（覆蓋舊的） */
  setItem(key: string, value: string): Promise<void>;
}

/** 同步或非同步的聊天儲存 */
export type ChatStorageLike = ChatStorage | AsyncChatStorage;

/** 記憶體版的非同步儲存：測試與範例用。每次讀寫都真的經過一次 Promise。 */
export class MemoryAsyncChatStorage implements AsyncChatStorage {
  readonly #data: Map<string, string>;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.#data = new Map(Object.entries(initial));
  }

  async getItem(key: string): Promise<string | null> {
    return this.#data.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.#data.set(key, value);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * 一個鍵的讀寫（內部用，不轉出）。
 *
 * 同步儲存：`load` 在建構時同步完成，`save` 直接寫——與以前的程式碼路徑相同。
 *
 * 非同步儲存要守住三件事：
 * 1. **寫入排在讀取之後**：讀取還沒回來就寫，會拿只有新資料的狀態把舊紀錄整份蓋掉。
 * 2. **寫入一次一個、依序完成**：兩個寫入同時進行時，較舊的狀態可能晚一步寫完，蓋掉較新的。
 *    排隊中的寫入在**輪到它時**才序列化目前的狀態，所以多次變更會合併成一次寫入，最後寫下的一定是最新的。
 * 3. **讀取失敗就不寫**：一次 I/O 錯誤不該讓整份紀錄被清空；這次執行只留在記憶體。
 */
export class StorageSlot {
  readonly #storage: ChatStorageLike | undefined;
  readonly #key: string;
  #async = false;
  /** 讀取失敗（非同步）：這次執行不寫回 */
  #readFailed = false;
  /** 所有讀寫的佇列尾端；`ready`／`flush` 都等它 */
  #tail: Promise<void> = Promise.resolve();
  #ready: Promise<void> = Promise.resolve();
  /** 已經有一個還沒開始的寫入在排隊（它開始時會序列化最新狀態，不必再排一個） */
  #writeQueued = false;

  constructor(storage: ChatStorageLike | undefined, key: string) {
    this.#storage = storage;
    this.#key = key;
  }

  /**
   * 讀取並交給 `onLoaded`（原始字串；沒有、讀不到為 `null`）。
   * 同步儲存會在這個呼叫裡直接回呼；非同步儲存在讀回之後回呼，之前排的寫入都等它。
   */
  load(onLoaded: (raw: string | null) => void): void {
    let raw: unknown;
    try {
      raw = this.#storage?.getItem(this.#key) ?? null;
    } catch {
      raw = null; // 同步儲存讀取失敗：維持既有行為（當作沒有）
    }
    if (!isThenable(raw)) {
      onLoaded(typeof raw === 'string' ? raw : null);
      return;
    }
    this.#async = true;
    this.#ready = this.#tail = Promise.resolve(raw).then(
      (value) => {
        try {
          onLoaded(typeof value === 'string' ? value : null);
        } catch {
          // 讀回的內容合併失敗（例如被外部改壞）：當作讀取失敗，不寫回，鏈也不能變成 rejected
          this.#readFailed = true;
        }
      },
      () => {
        this.#readFailed = true;
        onLoaded(null);
      },
    );
  }

  /** 存起 `serialize()` 的結果。非同步時排隊，輪到它才呼叫 `serialize`（拿到的是當下最新狀態）。 */
  save(serialize: () => string): void {
    const storage = this.#storage;
    if (storage === undefined) return;
    if (!this.#async) {
      try {
        const result: unknown = storage.setItem(this.#key, serialize());
        // 讀是同步、寫卻回傳 Promise 的儲存：吞掉失敗，避免未處理的 rejection
        if (isThenable(result)) result.then(undefined, () => {});
      } catch {
        // 存不進去（配額、隱私模式）就只留在記憶體
      }
      return;
    }
    if (this.#writeQueued) return;
    this.#writeQueued = true;
    this.#tail = this.#tail.then(async () => {
      this.#writeQueued = false; // 從這裡開始的變更要再排一次
      if (this.#readFailed) return;
      try {
        await storage.setItem(this.#key, serialize());
      } catch {
        // 存不進去就只留在記憶體；下一次變更會再試
      }
    });
  }

  /** 讀取完成（同步儲存：立刻完成） */
  ready(): Promise<void> {
    return this.#ready;
  }

  /** 目前排著的寫入都完成（同步儲存：立刻完成） */
  flush(): Promise<void> {
    return this.#tail;
  }
}
