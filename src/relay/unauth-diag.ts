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

export function unauthDiagEnabled(raw: string | undefined): boolean {
  return raw?.trim() === "1";
}

interface Conn {
  openedAt: number;
  inbound: string[];
  kinds: Set<number>;
  outbound: string[];
  authed: boolean;
}

const MAX_VERBS = 16;

function verbOf(raw: string): { verb: string; kinds: number[] } {
  try {
    const msg = JSON.parse(raw) as unknown;
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return { verb: "?", kinds: [] };
    const verb = msg[0].slice(0, 12).toUpperCase().replace(/[^A-Z_-]/g, "");
    const kinds: number[] = [];
    if (verb === "REQ" || verb === "COUNT") {
      for (const filter of msg.slice(2)) {
        const ks = (filter as { kinds?: unknown } | null)?.kinds;
        if (Array.isArray(ks)) for (const k of ks) if (Number.isInteger(k)) kinds.push(k as number);
      }
    }
    return { verb: verb || "?", kinds };
  } catch {
    return { verb: "?", kinds: [] };
  }
}

/** 中繼的回覆：動詞，CLOSED／OK／NOTICE 再加原因的前綴（`auth-required:` 之類的機器可讀前綴） */
function replyOf(message: readonly unknown[]): string {
  const verb = typeof message[0] === "string" ? message[0] : "?";
  const reason = verb === "CLOSED" ? message[2] : verb === "OK" ? message[3] : verb === "NOTICE" ? message[1] : undefined;
  const prefix = typeof reason === "string" ? /^([a-z-]+):/.exec(reason)?.[1] : undefined;
  return prefix ? `${verb}:${prefix}` : verb;
}

export class UnauthDiag {
  readonly #now: () => number;
  readonly #maxConns: number;
  readonly #conns = new Map<string, Conn>();

  constructor(opts: { now?: () => number; maxConns?: number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#maxConns = opts.maxConns ?? 1024;
  }

  get size(): number {
    return this.#conns.size;
  }

  open(connId: string): void {
    this.#conns.set(connId, { openedAt: this.#now(), inbound: [], kinds: new Set(), outbound: [], authed: false });
    while (this.#conns.size > this.#maxConns) {
      const oldest = this.#conns.keys().next().value;
      if (oldest === undefined) break;
      this.#conns.delete(oldest);
    }
  }

  inbound(connId: string, raw: string): void {
    const conn = this.#conns.get(connId);
    if (!conn || conn.authed) return;
    const { verb, kinds } = verbOf(raw);
    if (conn.inbound.length < MAX_VERBS) conn.inbound.push(verb);
    for (const k of kinds) conn.kinds.add(k);
  }

  outbound(connId: string, message: readonly unknown[]): void {
    const conn = this.#conns.get(connId);
    if (!conn || conn.authed) return;
    if (conn.outbound.length < MAX_VERBS) conn.outbound.push(replyOf(message));
  }

  /** 認證成功：之後不再記，關閉時也不印 */
  authed(connId: string): void {
    const conn = this.#conns.get(connId);
    if (conn) {
      conn.authed = true;
      conn.inbound = [];
      conn.outbound = [];
      conn.kinds.clear();
    }
  }

  /** 連線結束：沒認證過就回一行摘要（呼叫端 console.log），否則 null */
  close(connId: string, code: number | undefined): string | null {
    const conn = this.#conns.get(connId);
    this.#conns.delete(connId);
    if (!conn || conn.authed) return null;
    const alive = ((this.#now() - conn.openedAt) / 1000).toFixed(1);
    const kinds = [...conn.kinds].sort((a, b) => a - b).join(",");
    return `unauth-diag in=${conn.inbound.join(",") || "-"} kinds=${kinds || "-"} out=${conn.outbound.join(",") || "-"} alive=${alive}s code=${code ?? "?"}`;
  }
}
