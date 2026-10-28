// Node 版中繼的空間上限（SDK ADR 0099）：沿用 Cloudflare 版的 `DO_CEILINGS_MIB` 等容量設定，只認 `strict`；
// `CEILING_MODE=reject|evict` 決定滿了之後的行為（預設 reject＝原本的行為）。
import { afterEach, describe, expect, it } from 'vitest';

import { finalizeEvent, generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { DO_ADDRESSABLE_MAX_BYTES, DO_OFFLINE_MAX_BYTES, nodeCapacityFrom, NODE_CEILING_MAX_MIB } from '../../src/relay/host-config.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

const MIB = 1024 * 1024;

describe('nodeCapacityFrom（SDK ADR 0099）', () => {
  it('什麼都沒設＝沒有容量政策（行為與之前完全相同）', () => {
    expect(nodeCapacityFrom({})).toEqual({ ignored: [] });
  });

  it('DO_CEILINGS_MIB 的 strict 項目＝這座站的天花板；預設 reject', () => {
    const { capacity, ignored } = nodeCapacityFrom({ DO_CEILINGS_MIB: 'strict=4096/512' });
    expect(ignored).toEqual([]);
    expect(capacity).toEqual({ offlineMaxBytes: 4096 * MIB, addressableMaxBytes: 512 * MIB });
  });

  it('🔴 Node 版的上限可以超過 Cloudflare 的 10 GB（到 NODE_CEILING_MAX_MIB）', () => {
    const { capacity, ignored } = nodeCapacityFrom({ DO_CEILINGS_MIB: `strict=${NODE_CEILING_MAX_MIB}/20000` });
    expect(ignored).toEqual([]);
    expect(capacity?.offlineMaxBytes).toBe(NODE_CEILING_MAX_MIB * MIB);
    expect(nodeCapacityFrom({ DO_CEILINGS_MIB: `strict=${NODE_CEILING_MAX_MIB + 1}/1` }).ignored).toHaveLength(1);
  });

  it('🔴 Node 版沒有車道與分片：strict 以外的對象不生效、列進 ignored', () => {
    const { capacity, ignored } = nodeCapacityFrom({ DO_CEILINGS_MIB: 'lane=100/10,global=5/5,strict=64/8' });
    expect(capacity).toEqual({ offlineMaxBytes: 64 * MIB, addressableMaxBytes: 8 * MIB });
    expect(ignored).toEqual(['DO_CEILINGS_MIB: lane=100/10', 'DO_CEILINGS_MIB: global=5/5']);
  });

  it('只設模式或預警時，天花板沿用預設值', () => {
    const { capacity } = nodeCapacityFrom({ CEILING_MODE: 'evict', DO_NEAR_FULL_PERCENT: 'strict=80' });
    expect(capacity).toEqual({
      offlineMaxBytes: DO_OFFLINE_MAX_BYTES,
      addressableMaxBytes: DO_ADDRESSABLE_MAX_BYTES,
      evicts: true,
      nearFullPercent: 80,
    });
  });

  it('CEILING_MODE：evict＝淘汰；reject 或沒設＝拒收；寫錯的值當 reject、列進 ignored', () => {
    expect(nodeCapacityFrom({ CEILING_MODE: 'evict' }).capacity?.evicts).toBe(true);
    expect(nodeCapacityFrom({ CEILING_MODE: 'reject' }).capacity?.evicts).toBeUndefined();
    const bad = nodeCapacityFrom({ CEILING_MODE: 'delete-old' });
    expect(bad.capacity?.evicts).toBeUndefined();
    expect(bad.ignored).toEqual(['CEILING_MODE: delete-old']);
  });

  it('evict 模式：保底、溢位帶、預警、丟棄計數都生效', () => {
    const { capacity, ignored } = nodeCapacityFrom({
      CEILING_MODE: 'evict',
      DO_CEILINGS_MIB: 'strict=1024/64',
      DO_GUARANTEE_KIB: 'strict=2048',
      DO_BORROW_PERCENT: 'strict=20',
      DO_NEAR_FULL_PERCENT: 'strict=85',
      DO_DROP_NOTICES: 'strict',
    });
    expect(ignored).toEqual([]);
    expect(capacity).toEqual({
      offlineMaxBytes: 1024 * MIB,
      addressableMaxBytes: 64 * MIB,
      evicts: true,
      guaranteeBytes: 2048 * 1024,
      overflowRatio: 0.2,
      nearFullPercent: 85,
      countDrops: true,
    });
  });

  it('🔴 reject 模式設保底：不生效、列進 ignored（拒收制不刪別人的資料，保底沒有意義）', () => {
    const { capacity, ignored } = nodeCapacityFrom({ DO_GUARANTEE_KIB: 'strict=2048', DO_BORROW_PERCENT: 'strict=20' });
    expect(capacity?.guaranteeBytes).toBeUndefined();
    // 溢位帶在拒收制本來就有作用（與 Cloudflare 版的主訊息平面相同）
    expect(capacity?.overflowRatio).toBe(0.2);
    expect(ignored).toEqual(['DO_GUARANTEE_KIB: strict=2048']);
  });
});

const handles: { close(): void }[] = [];

/** 由系統分配埠（SDK ADR 0114），回傳實際的埠 */
function start(env: Record<string, string>): Promise<number> {
  return opened(handles, startNodeRelay({ ...env, PORT: '0' }, { memory: true }));
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

async function relayInfo(p: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } });
  return (await res.json()) as Record<string, unknown>;
}

/** 開一條連線、依序送出事件，回傳每一則的 OK。 */
function publishAll(url: string, events: ReturnType<typeof finalizeEvent>[]): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const oks: unknown[][] = [];
    const timer = setTimeout(() => reject(new Error(`只收到 ${oks.length} 則 OK`)), 5_000);
    ws.addEventListener('open', () => {
      for (const event of events) ws.send(JSON.stringify(['EVENT', event]));
    });
    ws.addEventListener('message', (message) => {
      const parsed = JSON.parse(String(message.data)) as unknown[];
      if (parsed[0] !== 'OK') return;
      oks.push(parsed);
      if (oks.length === events.length) {
        clearTimeout(timer);
        ws.close();
        resolve(oks);
      }
    });
  });
}

/** 約 200 KB 的離線留言：五則就超過 1 MiB 的天花板 */
function bigNote(sk: Uint8Array, to: string, n: number): ReturnType<typeof finalizeEvent> {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent({ kind: 1059, created_at: now - n, tags: [['p', to]], content: 'x'.repeat(200_000) }, sk);
}

describe('startNodeRelay：空間上限（SDK ADR 0099）', () => {
  it('NIP-11 照實公告天花板與 evict', async () => {
    const p = await start({ REQUIRE_AUTH: '0', DO_CEILINGS_MIB: 'strict=2048/256', CEILING_MODE: 'evict' });
    const info = await relayInfo(p);
    expect(info.cinder_ceiling_policy).toBe('evict');
    expect(info.cinder_ceiling_bytes).toEqual({ offline: 2048 * MIB, addressable: 256 * MIB });
  });

  it('🔴 reject（預設）：滿了回 blocked: ceiling', async () => {
    const p = await start({ REQUIRE_AUTH: '0', MAX_EVENTS_PER_MINUTE: '0', DO_CEILINGS_MIB: 'strict=1/1' });
    const sk = generateSecretKey();
    const to = getPublicKey(generateSecretKey());
    const oks = await publishAll(`ws://127.0.0.1:${p}`, [0, 1, 2, 3, 4, 5].map((n) => bigNote(sk, to, n)));
    expect(oks.slice(0, 5).every((ok) => ok[2] === true)).toBe(true);
    expect(oks[5]![2]).toBe(false);
    expect(String(oks[5]![3])).toMatch(/^blocked: ceiling/);
  });

  it('🔴 evict：滿了照收，淘汰最舊的', async () => {
    const p = await start({ REQUIRE_AUTH: '0', MAX_EVENTS_PER_MINUTE: '0', DO_CEILINGS_MIB: 'strict=1/1', CEILING_MODE: 'evict' });
    const sk = generateSecretKey();
    const to = getPublicKey(generateSecretKey());
    const oks = await publishAll(`ws://127.0.0.1:${p}`, [0, 1, 2, 3, 4, 5].map((n) => bigNote(sk, to, n)));
    expect(oks.every((ok) => ok[2] === true)).toBe(true);
  });
});
