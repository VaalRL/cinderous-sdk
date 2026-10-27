/**
 * 主平面的反覆重連限速，DO 那一道（SDK ADR 0111；移植自 Cinderous ADR-0391）。
 *
 * 每顆 DO 在**記憶體**裡記每個 IP 最近的升級時間：窗口內超過上限，就擋那個 IP 一段時間。
 * 被擋的升級在 `acceptWebSocket` 之前回絕——只花這一次 DO 請求，不產生訊息與關閉事件。
 *
 * 🔴 刻意不寫儲存：中繼只轉發、不持久化線上狀態；DO 被回收時計數歸零是可以接受的漏洞
 * ——持續重連的來源本身就讓 DO 保持喚醒。
 *
 * Worker 那一道（`STRICT_UPGRADE_LIMIT`，Cloudflare 限速 binding）只支援 10／60 秒窗口，
 * 擋不住「每分鐘幾次、一直重連」；這一道補長窗口。
 */

export interface ReconnectGuardConfig {
  /** 窗口內最多幾次升級 */
  max: number;
  windowMs: number;
  /** 超過後擋多久 */
  blockMs: number;
}

/** 正常用戶端每個分片一條連線、連上就掛著；10 分鐘 20 次只有壞掉的用戶端才會碰到 */
export const DEFAULT_RECONNECT_GUARD: ReconnectGuardConfig = Object.freeze({ max: 20, windowMs: 600_000, blockMs: 600_000 });

/** 最多記幾個 IP（滿了先丟最舊的）：每個 IP 最多 max 個時間戳，記憶體有上限 */
export const RECONNECT_GUARD_MAX_KEYS = 2048;

/**
 * `RECONNECT_GUARD`：`次數/窗口秒/封鎖秒`（例如 `20/600/600`），`off`＝關掉。
 * 未設或格式不對都用預設值——打錯字不該讓防護靜默消失。
 */
export function reconnectGuardFrom(raw: string | undefined): ReconnectGuardConfig | null {
  const text = raw?.trim().toLowerCase();
  if (text === "off") return null;
  const parts = text?.split("/") ?? [];
  if (parts.length !== 3) return DEFAULT_RECONNECT_GUARD;
  const [max, windowSec, blockSec] = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p.trim()) : NaN));
  if (!max || !windowSec || !blockSec) return DEFAULT_RECONNECT_GUARD;
  return { max, windowMs: windowSec * 1000, blockMs: blockSec * 1000 };
}

interface Entry {
  times: number[];
  blockedUntil: number;
}

export class ReconnectGuard {
  readonly #config: ReconnectGuardConfig;
  readonly #maxKeys: number;
  readonly #now: () => number;
  /** Map 保留插入順序：重新插入＝移到最新，滿了刪第一個＝最舊 */
  readonly #entries = new Map<string, Entry>();

  constructor(opts: ReconnectGuardConfig & { maxKeys?: number; now?: () => number }) {
    this.#config = { max: opts.max, windowMs: opts.windowMs, blockMs: opts.blockMs };
    this.#maxKeys = opts.maxKeys ?? RECONNECT_GUARD_MAX_KEYS;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** 記一次升級；回傳要不要放行 */
  admit(key: string): boolean {
    const now = this.#now();
    const entry = this.#entries.get(key) ?? { times: [], blockedUntil: 0 };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxKeys) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    if (now < entry.blockedUntil) return false;
    const since = now - this.#config.windowMs;
    entry.times = entry.times.filter((t) => t > since);
    if (entry.times.length >= this.#config.max) {
      entry.blockedUntil = now + this.#config.blockMs;
      entry.times = [];
      return false;
    }
    entry.times.push(now);
    return true;
  }
}
