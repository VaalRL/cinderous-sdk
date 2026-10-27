// 協調器的 P2P 批次（SDK ADR 0026 §4）：`VaultPeerLink` 的 `PeerNode` 實作，以及批次串流裡每個版本的中繼資料格式。
//
// 批次串流（`StreamTransfer`，用途 `VAULT_STREAM_PURPOSE`）的每一個檔案＝一個版本：
//   id     ＝版本 id
//   meta   ＝{ v: VAULT_WIRE_VERSION, from, fileId, node, c }（c＝1 表示附內容）
//   內容   ＝版本的內容（c＝1）；刪除、或內容不在手上時是空的（c＝0，sha256 是空內容的雜湊）
// 收端逐欄驗證（與中繼收到的訊息同一套 `validateVaultMessage`），而且 `from` 必須是通道認證的那台裝置。
import type { ByteChannel } from '../../transfer/file-transfer.js';
import { VAULT_WIRE_VERSION, validateVaultMessage } from './codec.js';
import type { VaultPeerLink, VaultSyncMessage, VaultVersion } from './types.js';

/** 協調器批次串流的用途名稱（收方依此找處理器） */
export const VAULT_STREAM_PURPOSE = 'cinderous/vault/1';
/** 空內容的 SHA-256 */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface VaultEntryMeta {
  v: number;
  from: string;
  fileId: string;
  node: VaultVersion;
  /** 1＝附內容 */
  c: 0 | 1;
}

/** 解析並驗證批次串流裡一個版本的中繼資料；`device` 是通道認證的寄件裝置。不合法回 null。 */
export function parseVaultEntryMeta(
  meta: Record<string, unknown>,
  device: string,
  entry: { size: number; sha256: string },
): (Extract<VaultSyncMessage, { type: 'node' }> & { withContent: boolean }) | null {
  if (meta.v !== VAULT_WIRE_VERSION || (meta.c !== 0 && meta.c !== 1) || meta.from !== device) return null;
  const message = validateVaultMessage({ type: 'node', from: meta.from, fileId: meta.fileId, node: meta.node });
  if (!message || message.type !== 'node') return null;
  const node = message.node;
  if (meta.c === 1) {
    if (node.deleted || entry.size !== node.size || entry.sha256 !== node.hash) return null;
  } else if (entry.size !== 0 || entry.sha256 !== EMPTY_SHA256) return null;
  return { ...message, withContent: meta.c === 1 };
}

/** `PeerNode` 符合（只用到這兩個方法） */
export interface VaultPeerNode {
  connectPeer(pubkey: string): Promise<ByteChannel & { close?(): void }>;
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
export function peerNodeLink(opts: PeerNodeLinkOptions): VaultPeerLink {
  const current = (): Readonly<Record<string, string>> => (typeof opts.devices === 'function' ? opts.devices() : opts.devices);
  const deviceOf = (pubkey: string): string | undefined => {
    for (const [device, pk] of Object.entries(current())) if (pk === pubkey) return device;
    return undefined;
  };
  const wrapped = new WeakMap<ByteChannel, Promise<ByteChannel>>();
  const relayOk = opts.relayTrack !== false;
  const wrap = (channel: ByteChannel, device: string): Promise<ByteChannel> => {
    if (!opts.wrap) return Promise.resolve(channel);
    let w = wrapped.get(channel);
    if (!w) wrapped.set(channel, (w = opts.wrap(channel, device)));
    return w;
  };
  return {
    devices: () => Object.keys(current()),
    async open(device, openOpts) {
      const pubkey = current()[device];
      if (!pubkey) return null;
      let channel = await opts.node.connectPeer(pubkey);
      if (openOpts?.fresh && channel.close) {
        // 對方在舊通道上沒有處理器（例如它的協調器重開過）：關掉重連，對方會在新通道上收到 onPeer
        channel.close();
        channel = await opts.node.connectPeer(pubkey);
      }
      if (channel.mode === 'relayed-websocket' && !relayOk) return null;
      return wrap(channel, device);
    },
    onIncoming(listener) {
      return opts.node.onPeer((channel) => {
        const device = deviceOf(channel.peerPublicKey);
        if (!device || (channel.mode === 'relayed-websocket' && !relayOk)) return;
        void wrap(channel, device)
          .then((w) => listener(device, w))
          .catch(() => {});
      });
    },
  };
}
