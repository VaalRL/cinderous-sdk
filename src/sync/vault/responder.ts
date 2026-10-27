// 只回應索取的輕量訂閱（SDK ADR 0058 §7）：完整成員（例如 CinderSync 的排程模式）在兩輪同步之間常駐，
// 只回應其他裝置（主要是輕量成員的 `fetch`）的 `want`，不跑整輪同步、不送摘要、不寫磁碟、不改任何狀態。
//
// 讀的是協調器存下的狀態（`f:<fileId>` 版本圖、`b:<fileId>:<雜湊>` 內容）與磁碟上的檔案（雜湊相符才算）：
// **不要和同一個 Vault 的協調器同時跑**（協調器在跑時它自己就會回應索取）。傳輸層請用另一個實例、不補拉歷史
// （`backfillPages: 0`、`since: 現在`）：其他訊息照樣留在中繼上，下一輪同步由協調器自己的起點補拉，這裡收到也只是略過。
import { ancestryOf, sha256Hex } from './graph.js';
import { compilePeerScopes } from './scope.js';
import { decodeJson } from './state-store.js';
import type { SyncStateStore, VaultAdapter, VaultPeerScopes, VaultSyncMessage, VaultSyncTransport, VaultVersion } from './types.js';

export interface VaultWantResponderOptions {
  /** 協調器用的狀態儲存（唯讀） */
  store: SyncStateStore;
  /** 讀磁碟上的內容（唯讀；只用 `read`） */
  adapter: Pick<VaultAdapter, 'read'>;
  /** 另一個傳輸層實例（建議 `backfillPages: 0`、`since` 設成現在；給 `deviceOf` 才能只回給索取的那台） */
  transport: VaultSyncTransport;
  /** 這台的 deviceId（與協調器相同） */
  deviceId: string;
  /** 其他輕量成員的內容範圍（同協調器的 `peerScopes`）：沒帶 `fetch` 的索取，範圍外的只回版本資訊 */
  peerScopes?: VaultPeerScopes;
  /** 一則索取最多處理幾項（防濫用）；預設 1,000 */
  maxItems?: number;
}

interface StoredRecord {
  nodes?: Record<string, VaultVersion>;
  disk?: { path: string; hash: string } | null;
}

/**
 * 只回應索取（`want`）的常駐訂閱（SDK ADR 0058 §7）。
 *
 * ```ts
 * const transport = new NostrVaultTransport({ pool, signer, devices, deviceOf, backfillPages: 0, since: Math.floor(Date.now() / 1000) });
 * const responder = new VaultWantResponder({ store, adapter, transport, deviceId, peerScopes: sparsePeerScopes(membership) });
 * transport.start();
 * responder.start();
 * // 下一輪同步開始前
 * responder.stop();
 * transport.stop();
 * ```
 */
export class VaultWantResponder {
  readonly #opts: VaultWantResponderOptions;
  #peerScopes: Map<string, (path: string) => boolean>;
  #off: (() => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #answered = 0;
  #skipped = 0;

  constructor(options: VaultWantResponderOptions) {
    this.#opts = options;
    this.#peerScopes = compilePeerScopes(options.peerScopes);
  }

  /** 回過幾個版本、略過幾個（不認得、內容不在手上） */
  get stats(): { answered: number; skipped: number } {
    return { answered: this.#answered, skipped: this.#skipped };
  }

  setPeerScopes(scopes: VaultPeerScopes | null): void {
    this.#peerScopes = compilePeerScopes(scopes);
  }

  start(): void {
    if (this.#off) return;
    this.#off = this.#opts.transport.onMessage((message) => {
      if (message.type !== 'want' || message.from === this.#opts.deviceId) return; // 其他訊息留給下一輪同步
      this.#queue = this.#queue.then(() => this.#answer(message)).catch(() => {});
    });
  }

  /** 停止接收；等手上的回應送完 */
  async stop(): Promise<void> {
    this.#off?.();
    this.#off = undefined;
    await this.#queue;
  }

  async #answer(message: Extract<VaultSyncMessage, { type: 'want' }>): Promise<void> {
    const fetch = message.fetch === true;
    const scope = this.#peerScopes.get(message.from);
    const records = new Map<string, StoredRecord | null>();
    // 連祖先一起要（SDK ADR 0088）：對方不認得這個檔案——要的那一個之後接著它的祖先（子版本在前，對方最後一個到了才一次併入）
    const items: Array<[string, string]> = [];
    for (const [fileId, nodeId] of message.items.slice(0, this.#opts.maxItems ?? 1000)) {
      if (!records.has(fileId)) records.set(fileId, decodeJson<StoredRecord>(await this.#opts.store.get(`f:${fileId}`)));
      if (message.deep !== true) {
        items.push([fileId, nodeId]);
        continue;
      }
      const nodes = records.get(fileId)?.nodes ?? {};
      const chain = nodes[nodeId] ? ancestryOf(nodes, [nodeId]).reverse() : [nodeId];
      for (const id of chain) items.push([fileId, id]);
    }
    for (const [fileId, nodeId] of items) {
      const node = records.get(fileId)?.nodes?.[nodeId];
      if (!node) {
        this.#skipped += 1;
        continue;
      }
      const wantContent = !node.deleted && !node.p2p && (fetch || !scope || scope(node.path));
      const content = wantContent ? await this.#content(fileId, records.get(fileId)!, node) : undefined;
      // 要內容卻不在手上：不回（回了也只是沒有內容的版本；其他裝置會回）
      if (fetch && !node.deleted && !content) {
        this.#skipped += 1;
        continue;
      }
      const reply: VaultSyncMessage = { type: 'node', from: this.#opts.deviceId, fileId, node, ...(content ? { content } : {}) };
      try {
        await this.#opts.transport.send(reply, { to: [message.from] });
        this.#answered += 1;
      } catch {
        this.#skipped += 1; // 送不出去：對方之後會再要
      }
    }
  }

  async #content(fileId: string, rec: StoredRecord, node: VaultVersion): Promise<Uint8Array | undefined> {
    const blob = await this.#opts.store.get(`b:${fileId}:${node.hash}`);
    if (blob && sha256Hex(blob) === node.hash) return blob;
    if (rec.disk && rec.disk.hash === node.hash) {
      try {
        const bytes = await this.#opts.adapter.read(rec.disk.path);
        if (sha256Hex(bytes) === node.hash) return bytes;
      } catch {
        // 讀不到就當作沒有
      }
    }
    return undefined;
  }
}
