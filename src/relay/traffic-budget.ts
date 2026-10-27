// Node 版中繼的每月流量預算（SDK ADR 0101）。
//
// VPS 的流量方案多半按月計：超過可能加收費用或降速。中繼只看得到 WebSocket 裡的資料量——TLS 與 HTTP 的開銷
// 算在前面的反向代理上——所以站主應該把預算設成方案的九成左右（README 與 ADR 都這樣寫）。
//
// 🔴 本檔不得出現 `node:*`：SqlExec 由宿主注入，計數本身是純運算（測試也直接用）。
import type { SqlExec } from "./sql-message-store.js";

const GIB = 1024 ** 3;

/** 每月流量預算（SDK ADR 0101）。 */
export interface TrafficBudget {
  /** 一個計費週期最多多少位元組 */
  budgetBytes: number;
  /** 每月幾號 00:00 UTC 歸零（1–28，對齊 VPS 的帳單日） */
  resetDay: number;
  /** `total`＝進出合計（預設，不會少算）；`out`＝只算出去的 */
  count: "total" | "out";
  /** 用到這個百分比以上，`OK true` 帶 `warning: near-full:`（另一級固定是 95） */
  nearFullPercent?: number;
}

/** 預算的合法範圍（SDK ADR 0101）。 */
export const TRAFFIC_LIMITS = {
  /** 每月預算（GiB）：1 GiB–1 PiB */
  monthlyGib: { min: 1, max: 1_048_576 },
  /** 重置日：1–28（每個月都有） */
  resetDay: { min: 1, max: 28 },
  /** 預警門檻（%）：與空間預警相同 */
  nearFullPercent: { min: 50, max: 99 },
} as const;

/** 預警的最高一級（與空間預警相同，SDK ADR 0042）。 */
const TOP_LEVEL = 95;

/** Node 版中繼讀的流量設定。 */
export interface TrafficEnv {
  MONTHLY_TRAFFIC_GIB?: string | undefined;
  TRAFFIC_RESET_DAY?: string | undefined;
  TRAFFIC_COUNT?: string | undefined;
  TRAFFIC_NEAR_FULL_PERCENT?: string | undefined;
}

function intIn(raw: string | undefined, range: { min: number; max: number }): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : Number.NaN;
}

/**
 * 解析流量設定（SDK ADR 0101）。沒設 `MONTHLY_TRAFFIC_GIB`＝不限（與之前相同）。
 * 設錯的項目不生效、列進 `ignored`（宿主啟動時 `console.warn`）：壞掉的預算等於沒有預算，一定要看得見。
 */
export function trafficBudgetFrom(env: TrafficEnv): { budget?: TrafficBudget; ignored: string[] } {
  const ignored: string[] = [];
  const pick = (name: keyof TrafficEnv, range: { min: number; max: number }): number | undefined => {
    const n = intIn(env[name], range);
    if (Number.isNaN(n)) {
      ignored.push(`${name}: ${env[name]}`);
      return undefined;
    }
    return n;
  };
  const gib = pick("MONTHLY_TRAFFIC_GIB", TRAFFIC_LIMITS.monthlyGib);
  if (gib === undefined) return { ignored };
  const resetDay = pick("TRAFFIC_RESET_DAY", TRAFFIC_LIMITS.resetDay) ?? 1;
  const rawCount = (env.TRAFFIC_COUNT ?? "").trim().toLowerCase();
  if (rawCount !== "" && rawCount !== "total" && rawCount !== "out") ignored.push(`TRAFFIC_COUNT: ${env.TRAFFIC_COUNT}`);
  const nearFullPercent = pick("TRAFFIC_NEAR_FULL_PERCENT", TRAFFIC_LIMITS.nearFullPercent);
  return {
    budget: {
      budgetBytes: gib * GIB,
      resetDay,
      count: rawCount === "out" ? "out" : "total",
      ...(nearFullPercent !== undefined ? { nearFullPercent } : {}),
    },
    ignored,
  };
}

/** 這個時間點落在哪個計費週期（UTC）：重置日當天 00:00 起算，到下個月同一天。`key` 是起始日（YYYY-MM-DD）。 */
export function trafficPeriod(nowMs: number, resetDay: number): { start: number; end: number; key: string } {
  const now = new Date(nowMs);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (nowMs < Date.UTC(y, m, resetDay)) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  const start = Date.UTC(y, m, resetDay);
  const end = Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, resetDay);
  const key = new Date(start).toISOString().slice(0, 10);
  return { start, end, key };
}

/** 寫回 SQLite 的間隔：每則訊息都寫會多一次磁碟寫入；當機最多少算這段時間的量 */
export const TRAFFIC_FLUSH_MS = 30_000;

/**
 * 流量計數（SDK ADR 0101）。給了 `exec` 就把用量存進 SQLite 的 `traffic_usage`（每個週期一列），重開不會歸零；
 * 純記憶體模式不給，重開就從零開始（宿主啟動時提醒）。
 */
export class TrafficMeter {
  readonly #budget: TrafficBudget;
  readonly #exec: SqlExec | undefined;
  readonly #now: () => number;
  #period: { start: number; end: number; key: string };
  #used = 0;
  #dirty = false;

  constructor(budget: TrafficBudget, opts: { exec?: SqlExec; now?: () => number } = {}) {
    this.#budget = budget;
    this.#exec = opts.exec;
    this.#now = opts.now ?? Date.now;
    this.#exec?.(`CREATE TABLE IF NOT EXISTS traffic_usage (period TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`);
    this.#period = trafficPeriod(this.#now(), budget.resetDay);
    this.#used = this.#load(this.#period.key);
  }

  #load(key: string): number {
    const row = this.#exec?.(`SELECT bytes FROM traffic_usage WHERE period = ?`, key)[0];
    return row === undefined ? 0 : Number(row.bytes ?? 0);
  }

  /** 換了週期就從零開始（先把上一期的寫回去） */
  #roll(): void {
    if (this.#now() < this.#period.end) return;
    this.flush();
    this.#period = trafficPeriod(this.#now(), this.#budget.resetDay);
    this.#used = this.#load(this.#period.key);
  }

  /** 記一筆：`in`＝客戶端送來的，`out`＝中繼送出去的（位元組）。`count: out` 時不算進來的 */
  record(direction: "in" | "out", bytes: number): void {
    this.#roll();
    if (direction === "in" && this.#budget.count === "out") return;
    this.#used += bytes;
    this.#dirty = true;
  }

  /** 這一期的用量 */
  snapshot(): { usedBytes: number; budgetBytes: number; percent: number; exhausted: boolean; resetsAt: number } {
    this.#roll();
    const percent = Math.min(100, Math.floor((this.#used / this.#budget.budgetBytes) * 100));
    return {
      usedBytes: this.#used,
      budgetBytes: this.#budget.budgetBytes,
      percent,
      exhausted: this.#used >= this.#budget.budgetBytes,
      resetsAt: Math.floor(this.#period.end / 1000),
    };
  }

  /** 粗分級預警（與空間預警相同的兩級）：達到站方設定的一級或 95 時回那一級；沒設預警或還沒到回 undefined */
  nearFullLevel(): number | undefined {
    const level = this.#budget.nearFullPercent;
    if (level === undefined) return undefined;
    const { percent } = this.snapshot();
    if (percent >= TOP_LEVEL) return TOP_LEVEL;
    return percent >= level ? level : undefined;
  }

  /** 寫回 SQLite（宿主每 {@link TRAFFIC_FLUSH_MS} 與關閉時呼叫） */
  flush(): void {
    if (!this.#dirty || this.#exec === undefined) return;
    this.#exec(
      `INSERT INTO traffic_usage (period, bytes) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET bytes = excluded.bytes`,
      this.#period.key,
      this.#used,
    );
    this.#dirty = false;
  }
}
