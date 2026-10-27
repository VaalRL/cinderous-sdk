// 只發布給指定的幾座（SDK ADR 0067：收件確認只送給宣告了 `cinder_inbox_ack` 的中繼）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { RelayPool } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const A = 'wss://a.example';
const B = 'wss://b.example';
const signer = Identity.generate();
const event = () => signer.sign({ kind: 25190, created_at: 1_700_000_000, tags: [], content: 'ab'.repeat(32) });

describe('RelayPool.publish：relays 選項', () => {
  let factory: SocketFactory;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000 });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  it('只送給指定的那幾座；結果也只列那幾座', async () => {
    const e = event();
    const result = pool.publish(e, { relays: [B] });
    expect(factory.latest(A).sentOfType('EVENT')).toHaveLength(0);
    expect(factory.latest(B).sentOfType('EVENT')).toHaveLength(1);
    factory.latest(B).receive(['OK', e.id, true, '']);
    expect(await result).toEqual({ accepted: [B], rejected: [] });
  });

  it('不在池裡的網址忽略；一座都不剩就不送', async () => {
    const result = await pool.publish(event(), { relays: ['wss://other.example'] });
    expect(factory.latest(A).sentOfType('EVENT')).toHaveLength(0);
    expect(factory.latest(B).sentOfType('EVENT')).toHaveLength(0);
    expect(result).toEqual({ accepted: [], rejected: [] });
  });
});
