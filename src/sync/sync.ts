/** 可變狀態的一筆值（last-writer-wins 以 updatedAt 比較）。 */
export interface MutableEntry {
  value: string;
  updatedAt: number;
}

/** 一次增量同步：新訊息（以 id 去重）與可變狀態變更（LWW）。 */
export interface SyncDelta {
  messages?: ReadonlyArray<{ id: string }>;
  state?: Record<string, MutableEntry>;
}

/** 多設備同步的資源上限（A5：防惡意/失控 delta 撐爆記憶體）。 */
export interface DeviceSyncLimits {
  /** 保留的訊息 id 數上限（超過即逐出最舊）。預設 100,000。 */
  maxMessages?: number;
  /** 可變狀態鍵數上限（超過即逐出 `updatedAt` 最舊者）。預設 10,000。 */
  maxStateKeys?: number;
}

const DEFAULT_MAX_MESSAGES = 100_000;
const DEFAULT_MAX_STATE_KEYS = 10_000;

/**
 * 多設備同步的本機收斂狀態：
 * - 訊息以 event id 去重（集合語意，順序無關）。
 * - 可變狀態（已讀位置、暱稱、封鎖等）採 last-writer-wins。
 *
 * 兩者皆為交換律（commutative）：不同設備以任意順序套用相同的 delta，
 * 最終會收斂到一致狀態。
 *
 * **A5 上限**：為防惡意或失控 delta 無限撐大記憶體，保留量有上限——訊息逐出最舊、
 * 可變狀態逐出最舊更新者。上限遠高於正常用量，故正常運作下不會逐出、收斂性不受影響；
 * 逐出僅作為濫用時的安全閥（此時已非正常收斂情境）。
 */
export class DeviceSyncState {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly state = new Map<string, MutableEntry>();
  private readonly maxMessages: number;
  private readonly maxStateKeys: number;

  constructor(limits: DeviceSyncLimits = {}) {
    this.maxMessages = limits.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxStateKeys = limits.maxStateKeys ?? DEFAULT_MAX_STATE_KEYS;
  }

  apply(delta: SyncDelta): void {
    for (const message of delta.messages ?? []) {
      if (!this.seen.has(message.id)) {
        this.seen.add(message.id);
        this.order.push(message.id);
      }
    }
    // 逐出最舊訊息 id 至上限內。
    while (this.order.length > this.maxMessages) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    for (const [key, entry] of Object.entries(delta.state ?? {})) {
      const current = this.state.get(key);
      if (current === undefined || entry.updatedAt > current.updatedAt) {
        if (current === undefined && this.state.size >= this.maxStateKeys) {
          this.evictOldestState();
        }
        this.state.set(key, entry);
      }
    }
  }

  /** 逐出 `updatedAt` 最舊的可變狀態鍵（狀態滿載時的安全閥）。 */
  private evictOldestState(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.state) {
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.state.delete(oldestKey);
  }

  /** 目前已知的所有訊息 id（依首次出現順序）。 */
  messageIds(): string[] {
    return [...this.order];
  }

  /** 取得某可變狀態鍵的當前值。 */
  get(key: string): string | undefined {
    return this.state.get(key)?.value;
  }
}
