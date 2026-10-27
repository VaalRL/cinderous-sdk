import type { Identity } from '../identity.js';
import { type IceServer, type TurnFetch, type TurnSigner } from '../protocol/turn-fetch.js';
/** 預設 STUN：與 Cinderous 相同（`rtc-config.ts` 的 `DEFAULT_STUN`） */
export declare const DEFAULT_STUN: readonly IceServer[];
export interface TurnProviderOptions {
    /** 簽 NIP-98 授權：`Identity`，或私鑰 */
    signer: Pick<Identity, 'sign'> | TurnSigner;
    /** 自己的中繼（`wss://…`）；`/turn` 由它推導 */
    home?: string;
    /** home 給不出憑證時依序問的錨點 */
    anchors?: readonly string[];
    /** 明確指定的 `/turn` 端點（企業）：只用它，不後備 */
    endpoint?: string;
    /** 企業身分：不問公共錨點 */
    enterprise?: boolean;
    stun?: readonly IceServer[];
    fetch?: TurnFetch;
}
export declare class TurnProvider {
    #private;
    constructor(opts: TurnProviderOptions);
    /** 立刻抓一次，並排好之後的刷新。 */
    start(): Promise<void>;
    stop(): void;
    /** 現在該用的 ICE 伺服器：STUN ＋ 目前的 TURN 憑證。傳給 CallManager／PeerNode 時請傳函式本身。 */
    iceServers: () => IceServer[];
    /** 真正給出憑證的端點（診斷用）；還沒拿到就是 undefined */
    get endpoint(): string | undefined;
    /** 憑證換新時通知（值是完整的 iceServers） */
    onChange(listener: (servers: IceServer[]) => void): () => void;
    /** 手動再抓一次（例如通話回報 unreachable 時）。 */
    refresh(): Promise<void>;
}
//# sourceMappingURL=turn-provider.d.ts.map