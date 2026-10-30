/**
 * 主平面的反覆重連限速，DO 那一道（SDK ADR 0111；移植自 Cinderous ADR-0391；SDK ADR 0131 改成主要只計沒認證的）。
 *
 * 每顆 DO 在**記憶體**裡記每個 IP 兩種時間：
 * - **沒認證就斷線的連線**（`unauthenticated`）：窗口內滿 `max` 條就擋那個 IP `blockMs`。
 *   ADR 0111 要擋的來源就是這樣：只連線、不認證、每 8 秒重來一次。
 * - **所有升級**（`admit`）：窗口內滿 `maxTotal` 次也擋。拋棄式金鑰認證很便宜，只靠第一種會被繞過。
 *
 * 認證過的連線只算進總上限（預設是 `max` 的 3 倍）：同一個共用 IP 後面很多人一起重連（公司網路閃斷），
 * 原本 10 分鐘第 21 次就把整個 IP 擋 10 分鐘（SDK ADR 0131）。
 *
 * 被擋的升級在 `acceptWebSocket` 之前回絕——只花這一次 DO 請求，不產生訊息與關閉事件；被擋的那次不計數。
 *
 * 🔴 刻意不寫儲存：中繼只轉發、不持久化線上狀態；DO 被回收時計數歸零是可以接受的漏洞
 * ——持續重連的來源本身就讓 DO 保持喚醒。
 *
 * Worker 那一道（`STRICT_UPGRADE_LIMIT`，Cloudflare 限速 binding）只支援 10／60 秒窗口，
 * 擋不住「每分鐘幾次、一直重連」；這一道補長窗口。
 */
/**
 * 正常用戶端每個分片一條連線、連上就認證、一直掛著：10 分鐘 20 條沒認證就斷線只有壞掉的用戶端才會碰到；
 * 總上限 60＝同一個 IP 後面 60 個人在 10 分鐘內各重連一次
 */
export const DEFAULT_RECONNECT_GUARD = Object.freeze({ max: 20, windowMs: 600_000, blockMs: 600_000, maxTotal: 60 });
/** 沒給總上限時用 `max` 的幾倍 */
const TOTAL_PER_UNAUTH = 3;
/** 最多記幾個 IP（滿了先丟最舊的）：每個 IP 最多 maxTotal＋max 個時間戳，記憶體有上限 */
export const RECONNECT_GUARD_MAX_KEYS = 2048;
/**
 * `RECONNECT_GUARD`：`次數/窗口秒/封鎖秒[/總上限]`（例如 `20/600/600` 或 `20/600/600/60`），`off`＝關掉。
 * 次數＝沒認證就斷線的連線；總上限＝所有升級，沒給就是次數的 3 倍、不能比次數小（SDK ADR 0131）。
 * 未設或格式不對都用預設值——打錯字不該讓防護靜默消失。
 */
export function reconnectGuardFrom(raw) {
    const text = raw?.trim().toLowerCase();
    if (text === "off")
        return null;
    const parts = text?.split("/") ?? [];
    if (parts.length !== 3 && parts.length !== 4)
        return DEFAULT_RECONNECT_GUARD;
    const [max, windowSec, blockSec, total] = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p.trim()) : NaN));
    if (!max || !windowSec || !blockSec)
        return DEFAULT_RECONNECT_GUARD;
    const maxTotal = total === undefined ? max * TOTAL_PER_UNAUTH : total;
    if (!(maxTotal >= max))
        return DEFAULT_RECONNECT_GUARD;
    return { max, windowMs: windowSec * 1000, blockMs: blockSec * 1000, maxTotal };
}
export class ReconnectGuard {
    #config;
    #maxKeys;
    #now;
    /** Map 保留插入順序：重新插入＝移到最新，滿了刪第一個＝最舊 */
    #entries = new Map();
    constructor(opts) {
        this.#config = {
            max: opts.max,
            windowMs: opts.windowMs,
            blockMs: opts.blockMs,
            maxTotal: Math.max(opts.maxTotal ?? opts.max * TOTAL_PER_UNAUTH, opts.max),
        };
        this.#maxKeys = opts.maxKeys ?? RECONNECT_GUARD_MAX_KEYS;
        this.#now = opts.now ?? Date.now;
    }
    get size() {
        return this.#entries.size;
    }
    has(key) {
        return this.#entries.has(key);
    }
    #touch(key) {
        const entry = this.#entries.get(key) ?? { times: [], unauth: [], blockedUntil: 0 };
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        while (this.#entries.size > this.#maxKeys) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.#entries.delete(oldest);
        }
        return entry;
    }
    #block(entry, now) {
        entry.blockedUntil = now + this.#config.blockMs;
        entry.times = [];
        entry.unauth = [];
    }
    /** 記一次升級；回傳要不要放行（被擋的那次不計數） */
    admit(key) {
        const now = this.#now();
        const entry = this.#touch(key);
        if (now < entry.blockedUntil)
            return false;
        const since = now - this.#config.windowMs;
        entry.times = entry.times.filter((t) => t > since);
        if (entry.times.length >= this.#config.maxTotal) {
            this.#block(entry, now);
            return false;
        }
        entry.times.push(now);
        return true;
    }
    /** 一條連線沒認證就斷了（SDK ADR 0131）：窗口內滿 `max` 條就擋那個 IP */
    unauthenticated(key) {
        const now = this.#now();
        const entry = this.#touch(key);
        if (now < entry.blockedUntil)
            return;
        const since = now - this.#config.windowMs;
        entry.unauth = entry.unauth.filter((t) => t > since);
        entry.unauth.push(now);
        if (entry.unauth.length >= this.#config.max)
            this.#block(entry, now);
    }
}
//# sourceMappingURL=reconnect-guard.js.map