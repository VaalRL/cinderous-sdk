// TURN 憑證便利函式（SDK ADR 0017）：向中繼的 `/turn` 端點抓短期 TURN 憑證、到期前刷新，
// 並以 `iceServers()` 交給 `CallManager` 與 `PeerNode`（兩者都接受函式、每條新連線取當下的值）。
//
// 抓取與排程的規則全部照 Cinderous 的 `turn-fetch`（已搬進 `protocol/turn-fetch`）：
// - 半個 TTL 刷新，夾在 1 分鐘～6 小時；沒有 ttl 就以 1 小時估（ADR-0342 §2）；
// - home 給不出來才依序問錨點；企業身分不問公共錨點（ADR-0356 §6）；
// - 任何失敗都退回純 STUN、不報錯——TURN 是保底，拿不到不能拖垮通話建立。
import type { Identity } from '../identity.js';
import {
  fetchTurnWithFallback,
  type IceServer,
  type TurnFetch,
  turnEndpointCandidates,
  turnRefreshDelayMs,
  type TurnSigner,
} from '../protocol/turn-fetch.js';

/** 預設 STUN：與 Cinderous 相同（`rtc-config.ts` 的 `DEFAULT_STUN`） */
export const DEFAULT_STUN: readonly IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

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

export class TurnProvider {
  readonly #signer: TurnSigner;
  readonly #endpoints: string[];
  readonly #stun: readonly IceServer[];
  readonly #fetch: TurnFetch | undefined;
  readonly #listeners = new Set<(servers: IceServer[]) => void>();
  #turn: IceServer[] = [];
  #endpoint: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(opts: TurnProviderOptions) {
    this.#signer = opts.signer as TurnSigner;
    this.#endpoints = turnEndpointCandidates(opts.home, opts.anchors ?? [], opts.endpoint, { enterprise: opts.enterprise === true });
    this.#stun = opts.stun ?? DEFAULT_STUN;
    this.#fetch = opts.fetch;
  }

  /** 立刻抓一次，並排好之後的刷新。 */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.refresh();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  /** 現在該用的 ICE 伺服器：STUN ＋ 目前的 TURN 憑證。傳給 CallManager／PeerNode 時請傳函式本身。 */
  iceServers = (): IceServer[] => [...this.#stun, ...this.#turn];

  /** 真正給出憑證的端點（診斷用）；還沒拿到就是 undefined */
  get endpoint(): string | undefined {
    return this.#endpoint;
  }

  /** 憑證換新時通知（值是完整的 iceServers） */
  onChange(listener: (servers: IceServer[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 手動再抓一次（例如通話回報 unreachable 時）。 */
  async refresh(): Promise<void> {
    clearTimeout(this.#timer);
    const got = await fetchTurnWithFallback(this.#endpoints, this.#signer, ...(this.#fetch ? [this.#fetch] : []));
    if (this.#stopped) return;
    if (got.servers.length > 0) {
      this.#turn = got.servers;
      this.#endpoint = got.endpoint;
      const servers = this.iceServers();
      for (const listener of this.#listeners) listener(servers);
    }
    // 拿不到也要排下一次：站方可能只是暫時故障
    this.#timer = setTimeout(() => void this.refresh(), turnRefreshDelayMs(got.ttlSeconds));
  }
}
