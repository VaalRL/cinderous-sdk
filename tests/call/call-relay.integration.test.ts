// 整合（SDK ADR 0016）：通話信令（kind 21002）經真的 Node 中繼（嚴格平面、要求 NIP-42）。
import { afterEach, describe, expect, it } from 'vitest';

import { CallManager } from '../../src/call/call-manager.js';
import { Identity } from '../../src/identity.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { RelayPool } from '../../src/relay-pool.js';
import { FakeCallNetwork } from './fake-call-rtc.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function until(check: () => boolean, ms = 8_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等不到條件成立');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('CallManager × 真的中繼', () => {
  it('撥號、響鈴、接聽、通話中、掛斷，信令全程經嚴格平面', async () => {
    const relay = startNodeRelay({ PORT: '0' }, { memory: true }); // 由系統分配埠（SDK ADR 0114）
    cleanups.push(() => relay.close());
    const port = await relay.ready;
    const network = new FakeCallNetwork();
    const make = (identity: Identity) => {
      const pool = new RelayPool({ urls: [`ws://127.0.0.1:${port}`], identity });
      pool.connect();
      const manager = new CallManager({ identity, transport: pool, rtc: network.factory, getUserMedia: network.getUserMedia });
      cleanups.push(() => {
        manager.close();
        pool.close();
      });
      return manager;
    };
    const bob = Identity.generate();
    const a = make(Identity.generate());
    const b = make(bob);
    await new Promise((resolve) => setTimeout(resolve, 500)); // 等 AUTH 與訂閱就緒

    const ringing = new Promise<void>((resolve) => b.onIncoming(() => resolve()));
    await a.startCall(bob.pubkey, 'video');
    await ringing;
    await b.accept();
    await until(() => a.state === 'active' && b.state === 'active');
    await a.hangup();
    await until(() => b.state === 'ended' || b.state === 'idle');
    expect(['ended', 'idle']).toContain(a.state);
  }, 20_000);
});
