// 配對用的中繼暫時不能用（SDK ADR 0108；2026-10-22 實機）：錨點額度用完、每條連線都被 1013 關閉，
// 新裝置等滿握手時間後只說「另一台沒有回應」——使用者會去檢查另一台，而不是知道中繼今天不能用。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { acceptPairingUri, createPairingOffer, VaultMembership } from '../../src/pairing/index.js';
import type { RelayHealthSnapshot } from '../../src/relay-health.js';
import { ManualClock } from '../sync/vault/harness.js';
import { FakeRelay, settle } from './fake-relay.js';

const RELAYS = ['wss://r1.example', 'wss://r2.example'];

function snapshot(url: string, unavailable: boolean, standby = false): RelayHealthSnapshot {
  return {
    url,
    standby,
    status: 'closed',
    marks: unavailable ? [{ scope: '*', state: 'backoff', kind: 'unavailable', reason: 'over quota', since: 0, until: Number.MAX_SAFE_INTEGER }] : [],
  };
}

async function failure(session: { result: Promise<unknown> }): Promise<{ reason: string; message: string }> {
  try {
    await session.result;
  } catch (error) {
    return error as { reason: string; message: string };
  }
  return { reason: 'ok', message: '' };
}

function scenario(health: RelayHealthSnapshot[]) {
  const relay = new FakeRelay();
  const clock = new ManualClock();
  const member = Identity.generate();
  const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
  const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
  relay.offline.add('J'); // 掃描方送不出去（中繼不能用）
  const pool = Object.assign(relay.pool('J'), { relayHealth: () => new Map(health.map((h) => [h.url, h])) });
  const scan = acceptPairingUri(offer.uri!, { signer: Identity.generate(), pool, clock });
  return { clock, scan, offer };
}

describe('🔴 配對逾時時，配對用的中繼都暫時不能用：說是中繼的問題（SDK ADR 0108）', () => {
  it('每一座主要中繼都被標成暫時不能用 → relay-unavailable（帶中繼給的原因）', async () => {
    const { clock, scan } = scenario([snapshot(RELAYS[0]!, true), snapshot(RELAYS[1]!, true)]);
    await settle();
    await clock.advance(60_000);
    const error = await failure(scan);
    expect(error.reason).toBe('relay-unavailable');
    expect(error.message).toContain('over quota');
  });

  it('還有一座沒被標記 → 照舊 timeout；備援不算', async () => {
    const one = scenario([snapshot(RELAYS[0]!, true), snapshot(RELAYS[1]!, false)]);
    await settle();
    await one.clock.advance(60_000);
    expect((await failure(one.scan)).reason).toBe('timeout');
    const standby = scenario([snapshot(RELAYS[0]!, false), snapshot('wss://standby.example', true, true)]);
    await settle();
    await standby.clock.advance(60_000);
    expect((await failure(standby.scan)).reason).toBe('timeout');
  });

  it('連線池沒有健康狀態（自訂傳輸層）→ 照舊 timeout', async () => {
    const relay = new FakeRelay();
    const clock = new ManualClock();
    const member = Identity.generate();
    const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    relay.offline.add('J');
    const scan = acceptPairingUri(offer.uri!, { signer: Identity.generate(), pool: relay.pool('J'), clock });
    await settle();
    await clock.advance(60_000);
    expect((await failure(scan)).reason).toBe('timeout');
  });
});
