// TURN 憑證便利函式（SDK ADR 0017）：抓短期憑證、到期前刷新、給 CallManager／PeerNode 用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_STUN, TurnProvider } from '../../src/call/turn-provider.js';
import { Identity } from '../../src/identity.js';
import { PeerNode } from '../../src/peer/peer-node.js';
import { verifyHttpAuth, type TurnFetch } from '../../src/protocol/index.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeRtcNetwork } from '../peer/fake-rtc.js';

const turnBody = (user: string, ttl?: number) => ({
  iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'https://evil.example'], username: user, credential: 'pw' },
  ...(ttl !== undefined ? { ttl } : {}),
});

function fakeFetch(plan: Record<string, () => { status: number; body?: unknown }>) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fetchFn: TurnFetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const r: { status: number; body?: unknown } = (plan[url] ?? (() => ({ status: 204 })))();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fetchFn, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TurnProvider', () => {
  it('啟動就抓：用 Identity 簽 NIP-98（中繼驗得過）；iceServers = STUN ＋ TURN，不合法的 URL 被濾掉', async () => {
    const identity = Identity.generate();
    const { fetchFn, calls } = fakeFetch({ 'https://relay.example/turn': () => ({ status: 200, body: turnBody('u1', 600) }) });
    const turn = new TurnProvider({ signer: identity, home: 'wss://relay.example', fetch: fetchFn });
    await turn.start();
    expect(verifyHttpAuth(calls[0]!.auth ?? null, 'https://relay.example/turn', 'GET')).toBe(identity.pubkey);
    expect(turn.iceServers()).toEqual([
      ...DEFAULT_STUN,
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'pw' },
    ]);
    expect(turn.endpoint).toBe('https://relay.example/turn');
    turn.stop();
  });

  it('過了半個 TTL 自動刷新；拿到新憑證就換上並通知', async () => {
    let n = 0;
    const { fetchFn, calls } = fakeFetch({ 'https://relay.example/turn': () => ({ status: 200, body: turnBody(`u${++n}`, 600) }) });
    const turn = new TurnProvider({ signer: Identity.generate(), home: 'wss://relay.example', fetch: fetchFn });
    const changes: string[] = [];
    turn.onChange((servers) => changes.push(String(servers.at(-1)?.username)));
    await turn.start();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    expect(turn.iceServers().at(-1)?.username).toBe('u2');
    expect(changes).toEqual(['u1', 'u2']);
    turn.stop();
  });

  it('自架站沒配 TURN（204）→ 依序問錨點（Cinderous ADR-0356 §6）', async () => {
    const { fetchFn, calls } = fakeFetch({
      'https://anchor.example/turn': () => ({ status: 200, body: turnBody('anchor', 600) }),
    });
    const turn = new TurnProvider({ signer: Identity.generate(), home: 'wss://mine.example', anchors: ['wss://anchor.example'], fetch: fetchFn });
    await turn.start();
    expect(calls.map((c) => c.url)).toEqual(['https://mine.example/turn', 'https://anchor.example/turn']);
    expect(turn.endpoint).toBe('https://anchor.example/turn');
    turn.stop();
  });

  it('🔴 企業身分不問公共錨點（流量不出自己的基礎設施）', async () => {
    const { fetchFn, calls } = fakeFetch({});
    const turn = new TurnProvider({
      signer: Identity.generate(),
      home: 'wss://corp.example',
      anchors: ['wss://anchor.example'],
      enterprise: true,
      fetch: fetchFn,
    });
    await turn.start();
    expect(calls.map((c) => c.url)).toEqual(['https://corp.example/turn']);
    turn.stop();
  });

  it('全部給不出來 → 只剩 STUN（不報錯）；一小時後再試', async () => {
    const { fetchFn, calls } = fakeFetch({});
    const turn = new TurnProvider({ signer: Identity.generate(), home: 'wss://relay.example', fetch: fetchFn });
    await turn.start();
    expect(turn.iceServers()).toEqual([...DEFAULT_STUN]);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000); // 沒有 ttl ⇒ 以一小時的一半排程
    expect(calls).toHaveLength(2);
    turn.stop();
  });

  it('stop 之後不再刷新', async () => {
    const { fetchFn, calls } = fakeFetch({ 'https://relay.example/turn': () => ({ status: 200, body: turnBody('u', 120) }) });
    const turn = new TurnProvider({ signer: Identity.generate(), home: 'wss://relay.example', fetch: fetchFn });
    await turn.start();
    turn.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(1);
  });
});

describe('PeerNode 的 iceServers 可以是函式（每條新連線取當下的值）', () => {
  it('每次建立連線都重新取一次', async () => {
    vi.useRealTimers();
    const transport = new FakeTransport();
    transport.relay = true;
    const network = new FakeRtcNetwork();
    let version = 0;
    const node = new PeerNode({
      identity: Identity.generate(),
      transport,
      rtc: network.factory,
      connectTimeoutMs: 50,
      iceServers: () => [{ urls: [`turn:v${++version}`] }],
    });
    await node.connectPeer(Identity.generate().pubkey);
    await node.connectPeer(Identity.generate().pubkey);
    expect(network.created.map((pc) => pc.config.iceServers)).toEqual([[{ urls: ['turn:v1'] }], [{ urls: ['turn:v2'] }]]);
    node.close();
  });
});
