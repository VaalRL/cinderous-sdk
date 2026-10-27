// 重現（SDK ADR 0035 §G8）：RelayPool 斷線重連後，以「看過的最新 created_at」當 since 補訂閱；
// 而 NIP-59 禮物包（NIP-17 私訊 kind 1059）的外層 created_at 會被隨機往前推最多兩天，
// 中繼對**即時**轉發的事件也套用 since（NIP-01；relay/filters.ts 的 matchFilter）——重連後別人寄來的私訊被中繼濾掉。
// 用真的 Node 中繼（嚴格平面、要求 NIP-42）＋ 真的 DirectMessages，只控制外層時戳往前推多少（Math.random）。
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectMessages } from '../src/dm.js';
import { Identity } from '../src/identity.js';
import { startNodeRelay } from '../src/relay/node-relay.js';
import { RelayPool, type SocketLike } from '../src/relay-pool.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) c();
});

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DirectMessages × RelayPool × 真的中繼：重連後不漏收外層時戳被往前推的私訊', () => {
  it('🔴 斷線重連之後，別人寄來、外層時間被往前推一天的私訊仍收得到', async () => {
    const port = 44_000 + Math.floor(Math.random() * 2_000);
    const relay = startNodeRelay({ PORT: String(port) }, { memory: true });
    cleanups.push(() => relay.close());
    await sleep(100);
    const url = `ws://127.0.0.1:${port}`;

    const alice = Identity.generate();
    const bob = Identity.generate();
    const alicePool = new RelayPool({ urls: [url], identity: alice });
    const bobSockets: SocketLike[] = [];
    const bobPool = new RelayPool({
      urls: [url],
      identity: bob,
      reconnectDelaysMs: [50],
      createSocket: (u) => {
        const socket = new WebSocket(u) as unknown as SocketLike;
        bobSockets.push(socket);
        return socket;
      },
    });
    alicePool.connect();
    bobPool.connect();
    cleanups.push(() => {
      alicePool.close();
      bobPool.close();
    });
    const aliceDm = new DirectMessages({ transport: alicePool, identity: alice });
    const bobDm = new DirectMessages({ transport: bobPool, identity: bob });
    const received = (): string[] => bobDm.threads().flatMap((t) => t.lines.map((l) => l.text));
    cleanups.push(bobDm.watch(() => undefined));
    await sleep(500); // 等 AUTH 與訂閱就緒

    // 第一則：外層時間＝現在（不往前推）→ Bob 的訂閱游標前進到「現在」
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect((await aliceDm.send(bob.pubkey, '第一則')).ok).toBe(true);
    expect(await until(() => received().includes('第一則'))).toBe(true);

    // 網路閃斷：Bob 的連線掉了，連線池照退避重連、補訂閱
    bobSockets.at(-1)!.close();
    expect(await until(() => bobSockets.length >= 2 && bobPool.status().get(url) === 'open')).toBe(true);
    await sleep(300); // 重新 AUTH、補送 REQ

    // 第二則：外層時間被往前推一天（NIP-59 的正常行為）
    random.mockReturnValue(0.5);
    expect((await aliceDm.send(bob.pubkey, '第二則')).ok).toBe(true);
    expect(await until(() => received().includes('第二則'), 2_000)).toBe(true);
  }, 20_000);

  it('🔴 kind 1060（Vault 同步／名單外層；CinderSync ADR 0013 釘住的情境）：重連之後、外層時間被往前推一天的也收得到', async () => {
    const port = 46_000 + Math.floor(Math.random() * 2_000);
    const relay = startNodeRelay({ PORT: String(port), MAX_FILE_MB: '17' }, { memory: true });
    cleanups.push(() => relay.close());
    await sleep(100);
    const url = `ws://127.0.0.1:${port}`;
    const sender = Identity.generate();
    const recipient = Identity.generate();
    const senderPool = new RelayPool({ urls: [url], identity: sender });
    const sockets: SocketLike[] = [];
    const recipientPool = new RelayPool({
      urls: [url],
      identity: recipient,
      reconnectDelaysMs: [50],
      createSocket: (u) => {
        const socket = new WebSocket(u) as unknown as SocketLike;
        sockets.push(socket);
        return socket;
      },
    });
    senderPool.connect();
    recipientPool.connect();
    cleanups.push(() => {
      senderPool.close();
      recipientPool.close();
    });
    const got: string[] = [];
    const sub = recipientPool.subscribe([{ kinds: [1060], '#p': [recipient.pubkey] }], { onEvent: (event) => got.push(event.content) });
    cleanups.push(() => sub.close());
    await sleep(500);
    const now = Math.floor(Date.now() / 1000);
    const wrap = (createdAt: number, content: string) =>
      sender.sign({ kind: 1060, created_at: createdAt, tags: [['p', recipient.pubkey], ['expiration', String(now + 86_400)]], content });

    expect((await senderPool.publish(wrap(now, 'before'))).accepted).toEqual([url]);
    expect(await until(() => got.includes('before'))).toBe(true);
    sockets.at(-1)!.close();
    expect(await until(() => sockets.length >= 2 && recipientPool.status().get(url) === 'open')).toBe(true);
    await sleep(300);
    expect((await senderPool.publish(wrap(now - 86_400, 'after reconnect'))).accepted).toEqual([url]);
    expect(await until(() => got.includes('after reconnect'), 2_000)).toBe(true);
    // 重連時重拉回來的 'before' 不會交第二次（訂閱內以 id 去重）
    expect(got.filter((c) => c === 'before')).toHaveLength(1);
  }, 20_000);
});
