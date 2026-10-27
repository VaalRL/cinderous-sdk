import type { SyncStateStore, VaultAdapter, VaultPeerScopes, VaultSyncTransport } from './types.js';
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
export declare class VaultWantResponder {
    #private;
    constructor(options: VaultWantResponderOptions);
    /** 回過幾個版本、略過幾個（不認得、內容不在手上） */
    get stats(): {
        answered: number;
        skipped: number;
    };
    setPeerScopes(scopes: VaultPeerScopes | null): void;
    start(): void;
    /** 停止接收；等手上的回應送完 */
    stop(): Promise<void>;
}
//# sourceMappingURL=responder.d.ts.map