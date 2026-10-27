import { VAULT_WIRE_VERSION, validateVaultMessage } from './codec.js';
/** 協調器批次串流的用途名稱（收方依此找處理器） */
export const VAULT_STREAM_PURPOSE = 'cinderous/vault/1';
/** 空內容的 SHA-256 */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** 解析並驗證批次串流裡一個版本的中繼資料；`device` 是通道認證的寄件裝置。不合法回 null。 */
export function parseVaultEntryMeta(meta, device, entry) {
    if (meta.v !== VAULT_WIRE_VERSION || (meta.c !== 0 && meta.c !== 1) || meta.from !== device)
        return null;
    const message = validateVaultMessage({ type: 'node', from: meta.from, fileId: meta.fileId, node: meta.node });
    if (!message || message.type !== 'node')
        return null;
    const node = message.node;
    if (meta.c === 1) {
        if (node.deleted || entry.size !== node.size || entry.sha256 !== node.hash)
            return null;
    }
    else if (entry.size !== 0 || entry.sha256 !== EMPTY_SHA256)
        return null;
    return { ...message, withContent: meta.c === 1 };
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
export function peerNodeLink(opts) {
    const current = () => (typeof opts.devices === 'function' ? opts.devices() : opts.devices);
    const deviceOf = (pubkey) => {
        for (const [device, pk] of Object.entries(current()))
            if (pk === pubkey)
                return device;
        return undefined;
    };
    const wrapped = new WeakMap();
    const relayOk = opts.relayTrack !== false;
    const wrap = (channel, device) => {
        if (!opts.wrap)
            return Promise.resolve(channel);
        let w = wrapped.get(channel);
        if (!w)
            wrapped.set(channel, (w = opts.wrap(channel, device)));
        return w;
    };
    return {
        devices: () => Object.keys(current()),
        async open(device, openOpts) {
            const pubkey = current()[device];
            if (!pubkey)
                return null;
            let channel = await opts.node.connectPeer(pubkey);
            if (openOpts?.fresh && channel.close) {
                // 對方在舊通道上沒有處理器（例如它的協調器重開過）：關掉重連，對方會在新通道上收到 onPeer
                channel.close();
                channel = await opts.node.connectPeer(pubkey);
            }
            if (channel.mode === 'relayed-websocket' && !relayOk)
                return null;
            return wrap(channel, device);
        },
        onIncoming(listener) {
            return opts.node.onPeer((channel) => {
                const device = deviceOf(channel.peerPublicKey);
                if (!device || (channel.mode === 'relayed-websocket' && !relayOk))
                    return;
                void wrap(channel, device)
                    .then((w) => listener(device, w))
                    .catch(() => { });
            });
        },
    };
}
//# sourceMappingURL=p2p.js.map