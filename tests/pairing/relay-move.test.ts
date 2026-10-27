// 中繼搬家通知（SDK ADR 0052）：換了私人路徑之後，把「舊網址 → 新網址」以名單加密送給目前有效的成員；
// 收方只接受名單成員寄的、只替換清單裡已經有的舊網址、新網址連得上才換。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event } from 'nostr-tools/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  announceRelayMove,
  buildRelayMoveEvents,
  claimDevice,
  defaultDeviceId,
  isRelayMoveUrl,
  NostrRosterSync,
  openRelayMoveEvent,
  planRelayMoves,
  probeRelayEndpoint,
  sameRelayUrl,
  VAULT_RELAY_MOVE_KIND,
  VaultMembership,
  type ReceivedRelayMove,
  type RelayMoveConnection,
} from '../../src/pairing/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { RelayPool, type PublishResult, type RelayStatus } from '../../src/relay-pool.js';
import { FakeRelay, settle } from './fake-relay.js';

const OLD = 'wss://relay.alice.workers.dev/app/k7q2mxz4ab3cd5ef6gh7ij2kl3';
const NEW = 'wss://relay.alice.workers.dev/app/z9y8x7w6v5u4t3s2r2q2p2o2n2';
const STANDBY = 'wss://standby.example';

function add(m: VaultMembership, id: Identity, label: string) {
  const deviceId = defaultDeviceId(id.pubkey);
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

/** A、B、C 三台；C 之後被移除 */
function trio() {
  const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
  const ma = VaultMembership.create({ signer: a, label: 'A' });
  add(ma, b, 'B');
  add(ma, c, 'C');
  const mb = VaultMembership.fromRoster(b, ma.roster());
  const mc = VaultMembership.fromRoster(c, ma.roster());
  return { a, b, c, ma, mb, mc };
}

describe('格式：與名單同一種封裝，內層 kind 4363', () => {
  it('來回：寄件人、欄位都在；外層預設 1060、帶 #p 與 expiration', () => {
    const { a, b } = trio();
    const [event] = buildRelayMoveEvents({ from: OLD, to: NEW, at: 1_000, device: 'dev-a' }, a, [b.pubkey]);
    expect(event!.kind).toBe(1060);
    expect(event!.tags).toContainEqual(['p', b.pubkey]);
    expect(event!.tags.some((t) => t[0] === 'expiration')).toBe(true);
    // 外層看不出內容（網址是秘密）
    expect(JSON.stringify(event)).not.toContain('k7q2mxz4');
    expect(openRelayMoveEvent(event!, b)).toEqual({ from: OLD, to: NEW, at: 1_000, device: 'dev-a', sender: a.pubkey });
    expect(VAULT_RELAY_MOVE_KIND).toBe(4363);
  });

  it('別人解不開；外層 kind 不同不認；不合法的網址不送', () => {
    const { a, b, c } = trio();
    const [event] = buildRelayMoveEvents({ from: OLD, to: NEW, at: 1 }, a, [b.pubkey]);
    expect(openRelayMoveEvent(event!, c)).toBeNull();
    expect(openRelayMoveEvent(event!, b, { outerKind: 1059 })).toBeNull();
    expect(() => buildRelayMoveEvents({ from: 'https://x', to: NEW, at: 1 }, a, [b.pubkey])).toThrow();
    expect(() => buildRelayMoveEvents({ from: OLD, to: `${OLD}/`, at: 1 }, a, [b.pubkey])).toThrow('相同');
    expect(isRelayMoveUrl('wss://user:pw@x.example')).toBe(false);
    expect(sameRelayUrl('WSS://Relay.Example/app/x/', 'wss://relay.example/app/x')).toBe(true);
    expect(sameRelayUrl('wss://relay.example/app/X', 'wss://relay.example/app/x')).toBe(false);
  });
});

describe('收到：NostrRosterSync 的 onRelayMove（同一個訂閱）', () => {
  it('名單成員寄的交出；🔴 非成員偽造的、已被移除的成員寄的都不交出', async () => {
    const relay = new FakeRelay();
    const { a, b, c, ma, mb } = trio();
    const outsider = Identity.generate();
    const got: ReceivedRelayMove[] = [];
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb, onRelayMove: (m) => got.push(m) });
    sb.start({ announce: false });
    // 非成員偽造
    for (const e of buildRelayMoveEvents({ from: OLD, to: 'wss://evil.example', at: 5 }, outsider, [b.pubkey])) relay.inject(e as unknown as Event);
    // C 被移除後（B 的名單也知道）寄的
    ma.revoke(c.pubkey);
    mb.merge(ma.roster(), a.pubkey);
    for (const e of buildRelayMoveEvents({ from: OLD, to: 'wss://evil.example', at: 6 }, c, [b.pubkey])) relay.inject(e as unknown as Event);
    // A 寄的
    for (const e of buildRelayMoveEvents({ from: OLD, to: NEW, at: 7 }, a, [b.pubkey])) relay.inject(e as unknown as Event);
    await settle();
    expect(got.map((m) => [m.to, m.sender])).toEqual([[NEW, a.pubkey]]);
    sb.stop();
  });

  it('名單事件照常合併（搬家通知不影響名單同步）', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = trio();
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb, onRelayMove: () => undefined });
    sa.start({ announce: false });
    sb.start({ announce: false });
    const d = Identity.generate();
    add(ma, d, 'D');
    await settle();
    expect(mb.isMember(d.pubkey)).toBe(true);
    sa.stop();
    sb.stop();
  });
});

/** 假的連線：記下送了什麼、每座回什麼；有狀態介面 */
function fakeConnection(answers: Record<string, boolean>, opts: { openAfterMs?: number } = {}) {
  const published: Event[] = [];
  const statuses = new Map<string, RelayStatus>(Object.keys(answers).map((u) => [u, opts.openAfterMs ? 'connecting' : 'open']));
  const listeners = new Set<(url: string, status: RelayStatus) => void>();
  let closed = false;
  if (opts.openAfterMs) {
    setTimeout(() => {
      for (const url of statuses.keys()) {
        statuses.set(url, 'open');
        for (const l of listeners) l(url, 'open');
      }
    }, opts.openAfterMs);
  }
  const connection: RelayMoveConnection = {
    publish: async (event: Event): Promise<PublishResult> => {
      published.push(event);
      const open = [...statuses].filter(([, s]) => s === 'open').map(([u]) => u);
      return {
        accepted: open.filter((u) => answers[u]),
        rejected: Object.keys(answers)
          .filter((u) => !open.includes(u) || !answers[u])
          .map((url) => ({ url, reason: 'blocked: x' })),
      };
    },
    subscribe: () => ({ close: () => undefined }),
    close: () => {
      closed = true;
    },
    status: () => statuses,
    onStatusChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { connection, published, closed: () => closed };
}

describe('送出：announceRelayMove', () => {
  it('收件人＝目前有效的每一台（含自己），🔴 被移除的不在裡面；回報哪幾座收下了全部；送完關閉', async () => {
    const { a, b, c, ma } = trio();
    ma.revoke(c.pubkey);
    const fake = fakeConnection({ [OLD]: true, [STANDBY]: false });
    const result = await announceRelayMove({ membership: ma, signer: a, move: { from: OLD, to: NEW }, relays: [OLD, STANDBY], connect: () => fake.connection });
    expect(result).toEqual({ accepted: [OLD], failed: [STANDBY], recipients: 2 });
    expect(fake.closed()).toBe(true);
    const opened = fake.published.map((e) => [openRelayMoveEvent(e, a), openRelayMoveEvent(e, b), openRelayMoveEvent(e, c)]);
    expect(opened.filter((o) => o[0] !== null)).toHaveLength(1); // 給自己的那一顆
    expect(opened.filter((o) => o[1] !== null)).toHaveLength(1);
    expect(opened.filter((o) => o[2] !== null)).toHaveLength(0);
    expect(opened.find((o) => o[1])?.[1]).toMatchObject({ from: OLD, to: NEW, device: ma.selfDevice!.deviceId });
  });

  it('先等連線開起來再送', async () => {
    const { a, ma } = trio();
    const fake = fakeConnection({ [OLD]: true }, { openAfterMs: 20 });
    const result = await announceRelayMove({ membership: ma, signer: a, move: { from: OLD, to: NEW }, relays: [OLD], connect: () => fake.connection });
    expect(result.accepted).toEqual([OLD]);
  });

  it('連不上（逾時）→ 沒有任何一座收下；這台被移除 → 例外', async () => {
    const { a, b, ma, mb } = trio();
    const fake = fakeConnection({ [OLD]: true }, { openAfterMs: 10_000 });
    const result = await announceRelayMove({ membership: ma, signer: a, move: { from: OLD, to: NEW }, relays: [OLD], connect: () => fake.connection, connectTimeoutMs: 20 });
    expect(result.accepted).toEqual([]);
    ma.revoke(b.pubkey);
    mb.merge(ma.roster(), a.pubkey);
    await expect(announceRelayMove({ membership: mb, signer: b, move: { from: OLD, to: NEW }, relays: [OLD], connect: () => fake.connection })).rejects.toThrow('名單');
  });
});

describe('採用：planRelayMoves（只替換、先測試、取最新）', () => {
  const ok = (urls: string[]) => async (url: string) => urls.includes(url);
  const move = (from: string, to: string, at: number) => ({ from, to, at });

  it('原地替換、保持順序；新網址已在清單就只拿掉舊的', async () => {
    const plan = await planRelayMoves({ primary: ['wss://x.example', OLD, 'wss://y.example'], moves: [move(OLD, NEW, 1)], probe: ok([NEW]) });
    expect(plan.primary).toEqual(['wss://x.example', NEW, 'wss://y.example']);
    expect(plan.applied).toEqual([{ from: OLD, to: NEW }]);
    const dup = await planRelayMoves({ primary: [NEW, OLD], moves: [move(OLD, NEW, 1)], probe: ok([NEW]) });
    expect(dup.primary).toEqual([NEW]);
  });

  it('🔴 不在清單裡的舊網址不採用（不新增）', async () => {
    const plan = await planRelayMoves({ primary: ['wss://x.example'], moves: [move(OLD, NEW, 1)], probe: ok([NEW]) });
    expect(plan.primary).toEqual(['wss://x.example']);
    expect(plan.applied).toEqual([]);
  });

  it('🔴 新網址連不上（部署失敗）→ 不換；同一個舊網址有較新的成功的 → 用它；較新的失敗就退到較舊的', async () => {
    const failed = 'wss://relay.alice.workers.dev/app/faileddeployxxxxxxxxxxxxxx';
    expect((await planRelayMoves({ primary: [OLD], moves: [move(OLD, failed, 1)], probe: ok([]) })).primary).toEqual([OLD]);
    expect((await planRelayMoves({ primary: [OLD], moves: [move(OLD, failed, 1), move(OLD, NEW, 2)], probe: ok([NEW]) })).primary).toEqual([NEW]);
    expect((await planRelayMoves({ primary: [OLD], moves: [move(OLD, NEW, 1), move(OLD, failed, 2)], probe: ok([NEW]) })).primary).toEqual([NEW]);
  });

  it('備援清單同理；新網址已在主清單就從備援拿掉', async () => {
    const plan = await planRelayMoves({ primary: [NEW], standby: [OLD, STANDBY], moves: [move(OLD, NEW, 1)], probe: ok([NEW]) });
    expect(plan.primary).toEqual([NEW]);
    expect(plan.standby).toEqual([STANDBY]);
    const moved = await planRelayMoves({ primary: ['wss://x.example'], standby: [OLD], moves: [move(OLD, NEW, 1)], probe: ok([NEW]) });
    expect(moved.standby).toEqual([NEW]);
  });

  it('連鎖搬家跟到底（有上限，不會繞圈）；每個網址只測一次', async () => {
    const third = 'wss://relay.alice.workers.dev/app/th1rdz4ab3cd5ef6gh7ij2kl3q';
    const probes: string[] = [];
    const plan = await planRelayMoves({
      primary: [OLD],
      moves: [move(OLD, NEW, 1), move(NEW, third, 2), move(third, OLD, 3)],
      probe: async (url) => {
        probes.push(url);
        return true;
      },
      maxHops: 3,
    });
    expect(plan.applied.length).toBe(3);
    expect(new Set(probes).size).toBe(probes.length);
  });
});

describe('probeRelayEndpoint：新網址真的連得上嗎（NIP-11）', () => {
  const reply = (status: number, body: string) => async () => ({ status, text: async () => body });

  it('200 的 JSON 物件才算；404、不是 JSON、唯讀寬限期中的路徑、錯誤都不算', async () => {
    const seen: string[] = [];
    expect(
      await probeRelayEndpoint(NEW, async (url, init) => {
        seen.push(`${url} ${init.headers.Accept}`);
        return { status: 200, text: async () => '{"name":"x"}' };
      }),
    ).toBe(true);
    expect(seen).toEqual([`${NEW.replace('wss:', 'https:')} application/nostr+json`]);
    expect(await probeRelayEndpoint(NEW, reply(404, 'unknown relay path'))).toBe(false);
    expect(await probeRelayEndpoint(NEW, reply(200, 'Cinderous relay'))).toBe(false);
    expect(await probeRelayEndpoint(NEW, reply(200, '{"cinder_read_only_until":1}'))).toBe(false);
    expect(await probeRelayEndpoint(NEW, async () => Promise.reject(new Error('offline')))).toBe(false);
    expect(await probeRelayEndpoint('https://x.example', reply(200, '{}'))).toBe(false);
  });
});

// ── 真的中繼：Node 主機＋SQLite，「換路徑重新部署」＝同一個資料庫、新的環境變數 ──────────────────
describe('端到端（Node 中繼）：A 部署前送到舊路徑 → 換路徑 → 晚上線的 B 從唯讀的舊路徑收到、測試新網址、換過去', () => {
  const handles: { close(): void }[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('被移除的 C 收不到；寬限期過後舊路徑 unknown-path', async () => {
    const OLD_LANE = 'k7q2mxz4ab3cd5ef6gh7ij2kl3';
    const NEW_LANE = 'z9y8x7w6v5u4t3s2r2q2p2o2n2';
    const port = 42_000 + Math.floor(Math.random() * 2_000);
    const dir = mkdtempSync(join(tmpdir(), 'relay-move-'));
    dirs.push(dir);
    const db = join(dir, 'relay.db');
    const base = { PORT: String(port), DB_PATH: db, LANES_ONLY: '1', MAX_FILE_MB: '17' };
    const host = `127.0.0.1:${port}`;
    const oldUrl = `ws://${host}/app/${OLD_LANE}`;
    const newUrl = `ws://${host}/app/${NEW_LANE}`;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const { a, b, c, ma, mb, mc } = trio();
    ma.revoke(c.pubkey); // C 先被移除（它還留著舊名單與舊網址）

    // 部署前：舊路徑可寫，A 送出
    let relay = startNodeRelay({ ...base, APP_LANES: OLD_LANE });
    handles.push(relay);
    await wait(100);
    const connect = (urls: readonly string[]) => {
      const pool = new RelayPool({ urls, identity: a });
      pool.connect();
      return pool;
    };
    const sent = await announceRelayMove({ membership: ma, signer: a, move: { from: oldUrl, to: newUrl }, relays: [oldUrl], connect });
    expect(sent.accepted).toEqual([oldUrl]);

    // 換路徑重新部署：同一個資料庫，舊路徑唯讀 3 秒
    relay.close();
    handles.splice(0);
    await wait(100);
    const until = Math.floor(Date.now() / 1000) + 3;
    relay = startNodeRelay({ ...base, APP_LANES: NEW_LANE, READONLY_LANES: `${OLD_LANE}@${until}` });
    handles.push(relay);
    await wait(100);

    // 晚上線的 B：只知道舊網址，從唯讀的舊路徑讀到通知
    const receive = async (signer: Identity, membership: VaultMembership): Promise<ReceivedRelayMove[]> => {
      const got: ReceivedRelayMove[] = [];
      const pool = new RelayPool({ urls: [oldUrl], identity: signer });
      const sync = new NostrRosterSync({ pool, signer, membership, onRelayMove: (m) => got.push(m) });
      pool.connect();
      sync.start({ announce: false });
      await wait(800);
      sync.stop();
      pool.close();
      return got;
    };
    mb.merge(ma.roster(), a.pubkey);
    const atB = await receive(b, mb);
    expect(atB.map((m) => m.to)).toEqual([newUrl]);
    const probe = (url: string) =>
      probeRelayEndpoint(url, async (u, init) => {
        const res = await fetch(u, init);
        return { status: res.status, text: () => res.text() };
      });
    const plan = await planRelayMoves({ primary: [oldUrl], moves: atB, probe });
    expect(plan.primary).toEqual([newUrl]);

    // 被移除的 C 收不到（不是收件人）
    expect(await receive(c, mc)).toEqual([]);

    // 寬限期過後：舊路徑與認不得的路徑相同
    await wait((until + 1) * 1000 - Date.now());
    expect(await probe(oldUrl)).toBe(false);
    const closed = await new Promise<{ code: number; notice: string }>((resolve) => {
      const ws = new WebSocket(oldUrl);
      let notice = '';
      ws.addEventListener('message', (e) => (notice = String(e.data)));
      ws.addEventListener('close', (e) => resolve({ code: e.code, notice }));
    });
    expect(closed.code).toBe(1008);
    expect(closed.notice).toContain('unknown relay path');
  }, 20_000);
});
