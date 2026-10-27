import type { Identity } from '../identity.js';
import { type PublishRejectionReport } from '../publish-rejections.js';
import { RelayEventBudget } from '../relay-budget.js';
import type { RelayTransport } from '../relay-pool.js';
import { type FrameAssemblerOptions } from './frames.js';
import { type RtcFactory } from './rtc.js';
/** 中繼軌的框（PRD 2.3）：ephemeral，中繼只轉發不存。 */
export declare const RELAY_FRAME_KIND = 20079;
/** 打洞逾時（PRD 2.3）：超過就改走中繼。 */
export declare const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
/**
 * 中繼軌每分鐘最多幾框（SDK ADR 0043）：SDK 中繼以認證身分計數、每把公鑰每分鐘 120 則事件（ephemeral 也算），
 * 而同一身分的信令、名單同步、Vault 同步都落在同一個桶——所以預設 100（每框 48,000 B ⇒ 約每秒 80 KB），
 * 而且沒指定 `relayFramesPerMinute` 時與同一身分的其他元件共用 {@link sharedRelayEventBudget}。v0.34 以前是 200，會撞上限。
 */
export declare const DEFAULT_RELAY_FRAMES_PER_MINUTE = 100;
/** 走中繼時，超過這個大小建議提示使用者（PRD 2.3）。 */
export declare const LARGE_PAYLOAD_WARNING_BYTES: number;
export type TransportMode = 'p2p-webrtc' | 'relayed-websocket';
/** PRD 2.3 的 `IDataChannelTransport`，外加關閉通知與大檔提示。 */
export interface PeerChannel {
    readonly mode: TransportMode;
    readonly peerPublicKey: string;
    /** 恆為 true：P2P 軌靠 DTLS，中繼軌靠 NIP-59 */
    readonly isEncrypted: true;
    readonly closed: boolean;
    send(data: Uint8Array): Promise<void>;
    /** 註冊前就到的訊息會在註冊當下交出 */
    onMessage(listener: (data: Uint8Array) => void): () => void;
    onClose(listener: () => void): () => void;
    close(): void;
    /** 走中繼且資料超過 20 MB：建議 App 提示使用者（連同一個 Wi-Fi 才能 P2P） */
    needsLargePayloadWarning(bytes: number): boolean;
}
export interface PeerNodeOptions {
    identity: Identity;
    transport: RelayTransport;
    /** 預設用全域 `RTCPeerConnection`；null＝不試 P2P，一律走中繼 */
    rtc?: RtcFactory | null;
    /** STUN／TURN；可以是函式，每條新連線取當下的值（例如 `TurnProvider.iceServers`，SDK ADR 0017） */
    iceServers?: unknown[] | (() => unknown[]);
    connectTimeoutMs?: number;
    /**
     * 中繼軌（框與信令）每分鐘最多幾則。指定了就用這個節點自己的預算（呼叫端自己負責與同一身分的其他元件分配）；
     * 省略＝與同一身分共用的 {@link sharedRelayEventBudget}（預設 {@link DEFAULT_RELAY_FRAMES_PER_MINUTE}）。
     */
    relayFramesPerMinute?: number;
    /** 直接指定預算（例如幾個元件共用一個自己建立的 `RelayEventBudget`）；優先於 `relayFramesPerMinute` */
    relayBudget?: RelayEventBudget;
    /**
     * 中繼的 NIP-11 文件（一份或多份）：有 `cinder_max_events_per_minute` 就自動取「宣告值 × 0.8」與目前速率的較小者
     *（SDK ADR 0043）。之後才拿到文件可以呼叫 `applyRelayInfo`。
     */
    relayInfo?: unknown;
    /** 誰可以找上門；預設所有人 */
    acceptFrom?: (pubkey: string) => boolean;
    assembler?: FrameAssemblerOptions;
    /**
     * 中繼軌的框有中繼拒收時回報（SDK ADR 0038 P0-C）。一框照舊以「至少一座收下」為送出；
     * 這裡讓應用看得到部分拒收（例如某一座限速或滿了）。
     */
    onPublishRejected?: (report: PublishRejectionReport) => void;
    /** 測試用 */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}
export declare class PeerNode {
    #private;
    constructor(opts: PeerNodeOptions);
    /** 有人找上門（對方呼叫 connectPeer）時通知；回傳取消函式 */
    onPeer(listener: (channel: PeerChannel) => void): () => void;
    /** 連到對方：先試 P2P，打不通就改走中繼。已經有開著的通道就直接回傳它。 */
    connectPeer(pubkey: string): Promise<PeerChannel>;
    /** 關掉節點：退訂、關掉所有通道 */
    close(): void;
    /** 依中繼的 NIP-11 調整中繼軌速率（SDK ADR 0043）；共用預算時同一身分的其他元件也跟著調。回傳新的每分鐘則數 */
    applyRelayInfo(nip11: unknown): number;
    /** 中繼軌目前每分鐘幾則 */
    get relayFramesPerMinute(): number;
}
//# sourceMappingURL=peer-node.d.ts.map