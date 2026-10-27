/**
 * 測試用的假 WebSocket：記下送出的訊息，讓測試決定何時開啟、收到什麼、何時斷線。
 */

import type { SocketLike, SocketListener } from '../src/relay-pool.js';

export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  readonly #listeners = new Map<string, Set<SocketListener>>();

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('socket not open');
    }
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.#dispatch('close', {});
  }

  addEventListener(type: string, listener: SocketListener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  /** 伺服器端接受連線 */
  open(): void {
    this.readyState = 1;
    this.#dispatch('open', {});
  }

  /** 伺服器送來一則 NIP-01 訊息 */
  receive(message: unknown): void {
    this.#dispatch('message', { data: JSON.stringify(message) });
  }

  /** 中繼主動以關閉碼與原因關掉連線（例如 1008 rate-limited、4003 restricted；SDK ADR 0038 P0-C） */
  serverClose(code: number, reason: string): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.#dispatch('close', { code, reason });
  }

  /** 連線出錯並斷掉（例如 Relay 掛了） */
  fail(): void {
    this.#dispatch('error', {});
    this.close();
  }

  /** 送出去的訊息裡，指定型別的那些（"EVENT"、"REQ"、"CLOSE"） */
  sentOfType(type: string): unknown[][] {
    return this.sent.filter(
      (message): message is unknown[] => Array.isArray(message) && message[0] === type,
    );
  }

  #dispatch(type: string, event: { data?: string; code?: number; reason?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** 記錄每個 URL 建立過的所有 socket（重連會多一個） */
export class SocketFactory {
  readonly sockets: FakeSocket[] = [];

  create = (url: string): SocketLike => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  latest(url: string): FakeSocket {
    const found = [...this.sockets].reverse().find((socket) => socket.url === url);
    if (found === undefined) {
      throw new Error(`no socket for ${url}`);
    }
    return found;
  }

  forUrl(url: string): FakeSocket[] {
    return this.sockets.filter((socket) => socket.url === url);
  }
}
