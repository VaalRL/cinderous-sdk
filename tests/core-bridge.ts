// SDK 自己的 RelayCore 接成 RelayPool 看得懂的假 WebSocket（同步投遞）：不開連接埠、可注入時鐘與任何中繼設定
//（例如 `guardFor('app')`、`requireAuth`、`maxEventsPerMinute`）。
import { RelayCore, type Outbound, type RelayCoreOptions } from '../src/relay/relay-core.js';
import type { SocketLike, SocketListener } from '../src/relay-pool.js';

/** SDK 自己的 RelayCore，接成 RelayPool 看得懂的假 WebSocket（同步投遞，記下每條連線收到多少位元組） */
export class CoreBridge {
  readonly core: RelayCore;
  readonly #sockets = new Map<string, BridgeSocket>();
  #n = 0;
  constructor(options: RelayCoreOptions = {}) {
    this.core = new RelayCore(options);
  }
  create = (): SocketLike => {
    const id = `c${(this.#n += 1)}`;
    const socket = new BridgeSocket(this, id);
    this.#sockets.set(id, socket);
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.dispatch('open', {});
      this.deliver(this.core.connect(id));
    });
    return socket;
  };
  deliver(out: Outbound[]): void {
    for (const o of out) this.#sockets.get(o.to)?.receive(JSON.stringify(o.message));
  }
  drop(id: string): void {
    this.#sockets.delete(id);
    this.core.disconnect(id);
  }
}

export class BridgeSocket implements SocketLike {
  readyState = 0;
  bytesIn = 0;
  readonly #listeners = new Map<string, Set<SocketListener>>();
  constructor(
    readonly bridge: CoreBridge,
    readonly id: string,
  ) {}
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.bridge.deliver(this.bridge.core.handle(this.id, data));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.bridge.drop(this.id);
    this.dispatch('close', {});
  }
  addEventListener(type: string, listener: SocketListener): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  receive(data: string): void {
    if (this.readyState !== 1) return;
    this.bytesIn += data.length;
    this.dispatch('message', { data });
  }
  dispatch(type: string, event: { data?: string }): void {
    for (const l of this.#listeners.get(type) ?? []) l(event);
  }
}
