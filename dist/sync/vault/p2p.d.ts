import type { ByteChannel } from '../../transfer/file-transfer.js';
import type { VaultPeerLink, VaultSyncMessage, VaultVersion } from './types.js';
/** 協調器批次串流的用途名稱（收方依此找處理器） */
export declare const VAULT_STREAM_PURPOSE = "cinderous/vault/1";
/** 空內容的 SHA-256 */
export declare const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export interface VaultEntryMeta {
    v: number;
    from: string;
    fileId: string;
    node: VaultVersion;
    /** 1＝附內容 */
    c: 0 | 1;
}
/** 解析並驗證批次串流裡一個版本的中繼資料；`device` 是通道認證的寄件裝置。不合法回 null。 */
export declare function parseVaultEntryMeta(meta: Record<string, unknown>, device: string, entry: {
    size: number;
    sha256: string;
}): (Extract<VaultSyncMessage, {
    type: 'node';
}> & {
    withContent: boolean;
}) | null;
/** `PeerNode` 符合（只用到這兩個方法） */
export interface VaultPeerNode {
    connectPeer(pubkey: string): Promise<ByteChannel & {
        close?(): void;
    }>;
    onPeer(listener: (channel: ByteChannel) => void): () => void;
}
export interface PeerNodeLinkOptions {
    node: VaultPeerNode;
    /**
     * 同一個 Vault 的其他裝置：協調器的 deviceId → 那台裝置的公鑰（hex）。
     * 也可以給函式，每次都重新讀（SDK ADR 0028：例如 `() => membership.peerDevices()`，配對或撤銷後立即生效）。
     */
    devices: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
    /**
     * P2P 打不通時，小檔批次可不可以走中繼軌（kind 20079，ephemeral、不佔中繼的儲存配額，每分鐘最多 200 框）。
     * 預設可以。大檔內容一律只走 P2P。
     */
    relayTrack?: boolean;
    /** 在通道上再包一層應用層加密（例如 `secureChannel` 的雙棘輪）；同一條通道只包一次 */
    wrap?(channel: ByteChannel, deviceId: string): Promise<ByteChannel>;
}
/**
 * 用 `PeerNode` 實作 `VaultPeerLink`。通道的身分由 `PeerNode` 認證（對方公鑰），這裡再對應回 deviceId；
 * 不在 `devices` 裡的公鑰一律不理。
 *
 * ```ts
 * const node = new PeerNode({ identity, transport: pool, acceptFrom: (pk) => Object.values(devices).includes(pk) });
 * const sync = new VaultSyncCoordinator({ ..., peers: peerNodeLink({ node, devices }) });
 * ```
 */
export declare function peerNodeLink(opts: PeerNodeLinkOptions): VaultPeerLink;
//# sourceMappingURL=p2p.d.ts.map