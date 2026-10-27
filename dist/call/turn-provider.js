import { fetchTurnWithFallback, turnEndpointCandidates, turnRefreshDelayMs, } from '../protocol/turn-fetch.js';
/** 預設 STUN：與 Cinderous 相同（`rtc-config.ts` 的 `DEFAULT_STUN`） */
export const DEFAULT_STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
export class TurnProvider {
    #signer;
    #endpoints;
    #stun;
    #fetch;
    #listeners = new Set();
    #turn = [];
    #endpoint;
    #timer;
    #stopped = false;
    constructor(opts) {
        this.#signer = opts.signer;
        this.#endpoints = turnEndpointCandidates(opts.home, opts.anchors ?? [], opts.endpoint, { enterprise: opts.enterprise === true });
        this.#stun = opts.stun ?? DEFAULT_STUN;
        this.#fetch = opts.fetch;
    }
    /** 立刻抓一次，並排好之後的刷新。 */
    async start() {
        this.#stopped = false;
        await this.refresh();
    }
    stop() {
        this.#stopped = true;
        clearTimeout(this.#timer);
    }
    /** 現在該用的 ICE 伺服器：STUN ＋ 目前的 TURN 憑證。傳給 CallManager／PeerNode 時請傳函式本身。 */
    iceServers = () => [...this.#stun, ...this.#turn];
    /** 真正給出憑證的端點（診斷用）；還沒拿到就是 undefined */
    get endpoint() {
        return this.#endpoint;
    }
    /** 憑證換新時通知（值是完整的 iceServers） */
    onChange(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /** 手動再抓一次（例如通話回報 unreachable 時）。 */
    async refresh() {
        clearTimeout(this.#timer);
        const got = await fetchTurnWithFallback(this.#endpoints, this.#signer, ...(this.#fetch ? [this.#fetch] : []));
        if (this.#stopped)
            return;
        if (got.servers.length > 0) {
            this.#turn = got.servers;
            this.#endpoint = got.endpoint;
            const servers = this.iceServers();
            for (const listener of this.#listeners)
                listener(servers);
        }
        // 拿不到也要排下一次：站方可能只是暫時故障
        this.#timer = setTimeout(() => void this.refresh(), turnRefreshDelayMs(got.ttlSeconds));
    }
}
//# sourceMappingURL=turn-provider.js.map