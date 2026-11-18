// C′ Workers 宿主測試共用的替身（SDK ADR 0138、0139）：假的 DurableObjectState、成對的假 WebSocket、支援 webSocket 的 Response。
// `installWorkerFakes()` 在 beforeAll 呼叫；`state.room` 指向目前的 DO 實例（對端關閉時平台會呼叫它的 webSocketClose）。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { IotHomeRoom } from '../../src/relay/worker.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

type Listener = (ev: { data?: unknown; code?: number; reason?: string }) => void;

/** 成對的假 WebSocket：一端 send → 另一端的 message 事件；一端 close → 另一端的 close 事件 */
export class FakeWs {
  attachment: unknown = null;
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  tags: string[] = [];
  peer: FakeWs | undefined;
  /** 伺服器端（DO 接受的那一端）被對端關掉時，平台會呼叫 DO 的 webSocketClose */
  onPeerClose: (() => void) | undefined;
  readonly #listeners = new Map<string, Listener[]>();
  readonly #queued = new Map<string, Parameters<Listener>[0][]>();
  serializeAttachment(o: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(o));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  accept(): void {}
  addEventListener(type: string, fn: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
    for (const ev of this.#queued.get(type) ?? []) fn(ev);
    this.#queued.delete(type);
  }
  emit(type: string, ev: Parameters<Listener>[0]): void {
    const ls = this.#listeners.get(type);
    if (ls && ls.length > 0) for (const l of ls) l(ev);
    else this.#queued.set(type, [...(this.#queued.get(type) ?? []), ev]);
  }
  send(s: string): void {
    if (this.closed) throw new Error('closed');
    this.sent.push(s);
    this.peer?.emit('message', { data: s });
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    const peer = this.peer;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.closeCode = code;
      peer.closeReason = reason;
      peer.emit('close', { code: code ?? 1005, reason: reason ?? '' });
      peer.onPeerClose?.();
    }
  }
  drain(): string[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}

export class FakePair {
  0 = new FakeWs();
  1 = new FakeWs();
  constructor() {
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

export class FakeAutoResponse {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

export class FakeState {
  sockets: FakeWs[] = [];
  room: IotHomeRoom | undefined;
  kv = new Map<string, unknown>();
  private readonly db = new DatabaseSync(':memory:');
  storage = {
    sql: {
      exec: (query: string, ...bindings: (string | number | null)[]) => ({
        toArray: () => {
          const stmt = this.db.prepare(query);
          if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
          stmt.run(...bindings);
          return [];
        },
      }),
    },
    getAlarm: async () => 1,
    setAlarm: async () => undefined,
    get: async <T>(k: string) => this.kv.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void this.kv.set(k, v),
  };
  /** 平台在 blockConcurrencyWhile 跑完前不送任何事件進來 */
  ready: Promise<void> = Promise.resolve();
  blockConcurrencyWhile = (fn: () => Promise<void>) => (this.ready = fn());
  acceptWebSocket(ws: FakeWs, tags: string[]): void {
    ws.tags = tags;
    ws.onPeerClose = () => this.room?.webSocketClose(ws as unknown as WebSocket);
    this.sockets.push(ws);
  }
  getWebSockets(tag?: string): FakeWs[] {
    const live = this.sockets.filter((w) => !w.closed);
    return tag === undefined ? live : live.filter((w) => w.tags.includes(tag));
  }
  setWebSocketAutoResponse(): void {}
  getWebSocketAutoResponseTimestamp(): Date | null {
    return null;
  }
}

/** 換掉 Workers 專有的全域（Node 的 Response 不收 101、沒有 webSocket） */
export function installWorkerFakes(): void {
  const g = globalThis as Record<string, unknown>;
  g.WebSocketPair = FakePair;
  g.WebSocketRequestResponsePair = FakeAutoResponse;
  g.Response = class {
    readonly status: number;
    readonly headers: Headers;
    readonly webSocket: unknown;
    constructor(
      readonly body: unknown,
      init?: { status?: number; headers?: Record<string, string>; webSocket?: unknown },
    ) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
      this.webSocket = init?.webSocket ?? null;
    }
    async text(): Promise<string> {
      return typeof this.body === 'string' ? this.body : '';
    }
  };
}
