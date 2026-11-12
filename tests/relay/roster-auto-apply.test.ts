// 名冊事件自動套用（SDK ADR 0134；Cinderous ADR-0414）：名冊金鑰把名冊發到自架站，站就換成員——
// 不必經手運維金鑰，也不必開 NIP-86 管理 API。檢查與 `cinder_applyroster` 完全相同。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
  ORG_ROSTER_KIND,
  signOrgRoster,
  type OrgRosterDoc,
} from '../../src/protocol/index.js';
import { Nip86Admin, type Nip86State } from '../../src/relay/nip86.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

const rosterSk = generateSecretKey();
const rosterAdmin = getPublicKey(rosterSk);
const aliceSk = generateSecretKey();
const alice = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const bob = getPublicKey(bobSk);
const nowSec = () => Math.floor(Date.now() / 1000);

function roster(members: OrgRosterDoc['members'], updatedAt: number, sk = rosterSk) {
  return signOrgRoster({ org: '測試公司', members, updatedAt }, sk);
}

describe('Nip86Admin.applyRosterEvent', () => {
  function make(state?: Nip86State) {
    const applied: { allowed?: string[] } = {};
    const saved: Nip86State[] = [];
    const admin = new Nip86Admin({
      admins: [],
      rosterAdmin,
      state,
      apply: { allowed: (list) => (applied.allowed = list), kinds: () => {} },
      save: (s) => saved.push(s),
    });
    return { admin, applied, saved };
  }

  it('沒有運維金鑰、只有名冊金鑰也能建（只剩名冊自動套用這條路）', () => {
    expect(() => make()).not.toThrow();
  });

  it('名冊金鑰簽的、比較新的 → 套用並存檔，記下是哪一把名冊金鑰簽的', () => {
    const { admin, applied, saved } = make();
    const t = nowSec();
    expect(admin.applyRosterEvent(roster([{ pubkey: alice, name: 'A' }], t))).toEqual({ result: { allowed: 1, updatedAt: t } });
    expect(applied.allowed).toEqual([alice]);
    expect(saved.at(-1)?.roster).toEqual({ updatedAt: t, allowed: [alice], admin: rosterAdmin });
  });

  it('重送同一份或更舊的 → stale，不動', () => {
    const t = nowSec();
    const { admin, applied } = make({ roster: { updatedAt: t, allowed: [alice], admin: rosterAdmin } });
    const r = admin.applyRosterEvent(roster([{ pubkey: bob, name: 'B' }], t));
    expect('error' in r && r.error.startsWith('stale:')).toBe(true);
    expect(applied.allowed).toBeUndefined();
  });

  it('🔴 別的金鑰簽的名冊 → 拒絕（權威是名冊金鑰的簽章，不是「發到這座站」）', () => {
    const { admin, applied } = make();
    expect(admin.applyRosterEvent(roster([{ pubkey: alice, name: 'A' }], nowSec(), aliceSk))).toHaveProperty('error');
    expect(applied.allowed).toBeUndefined();
  });

  it('與 cinder_applyroster 同一套檢查：毫秒的 updatedAt、格式不對的 pubkey 都拒絕', () => {
    expect(make().admin.applyRosterEvent(roster([{ pubkey: alice, name: 'A' }], nowSec() * 1000))).toHaveProperty('error');
    expect(make().admin.applyRosterEvent(roster([{ pubkey: alice.toUpperCase(), name: 'A' }], nowSec()))).toHaveProperty('error');
  });
});

describe('名冊事件自動套用 × Node 主機', () => {
  const handles: { close(): void }[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function send(port: number, ev: NostrEvent): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error('沒有收到 OK')), 3_000);
      ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', ev])));
      ws.addEventListener('message', (m) => {
        const msg = JSON.parse(String(m.data)) as unknown[];
        if (msg[0] !== 'OK') return;
        clearTimeout(timer);
        ws.close();
        resolve(msg[2] === true);
      });
      ws.addEventListener('error', () => reject(new Error('連不上')));
    });
  }

  let n = 0;
  const note = (sk: Uint8Array) => finalizeEvent({ kind: 1, created_at: nowSec(), tags: [], content: `auto-${n++}` }, sk);

  function env(over: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'roster-auto-'));
    dirs.push(dir);
    return { PORT: '0', REQUIRE_AUTH: '0', ROSTER_ADMIN_PUBKEY: rosterAdmin, ALLOWED_PUBKEYS: alice, DB_PATH: join(dir, 'relay.db'), ...over };
  }

  it('🔴 只設 ROSTER_ADMIN_PUBKEY：名冊發到站上就換成員；名冊金鑰自己永遠寫得進', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await opened(handles, startNodeRelay(env()));
    expect(await send(port, note(rosterSk))).toBe(true); // 不在 ALLOWED_PUBKEYS 也寫得進
    expect(await send(port, note(bobSk))).toBe(false);

    expect(await send(port, roster([{ pubkey: bob, name: 'B' }], nowSec()))).toBe(true);
    expect(await send(port, note(bobSk))).toBe(true);
    expect(await send(port, note(aliceSk))).toBe(false); // 名冊沒有 alice＝移除
    // 套用之後，名冊金鑰仍寫得進下一份名冊
    expect(await send(port, roster([{ pubkey: alice, name: 'A' }], nowSec() + 1))).toBe(true);
    expect(await send(port, note(aliceSk))).toBe(true);
    expect(await send(port, note(bobSk))).toBe(false);
  });

  it('🔴 別人簽的名冊（成員也能發 kind 10038）存得進，但不改成員', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await opened(handles, startNodeRelay(env()));
    const forged = roster([{ pubkey: bob, name: 'B' }], nowSec(), aliceSk);
    expect(forged.kind).toBe(ORG_ROSTER_KIND);
    await send(port, forged);
    expect(await send(port, note(bobSk))).toBe(false);
  });

  it('重開後名冊還在（有 DB_PATH）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = env();
    const first = startNodeRelay(e);
    const p1 = await first.ready;
    expect(await send(p1, roster([{ pubkey: bob, name: 'B' }], nowSec()))).toBe(true);
    first.close();
    const p2 = await opened(handles, startNodeRelay(e));
    expect(await send(p2, note(bobSk))).toBe(true);
    expect(await send(p2, note(aliceSk))).toBe(false);
  });

  it('沒開管理 API（沒設 NIP86_ADMIN_PUBKEYS）→ 沒有 HTTP 端點，NIP-11 也不宣告 86', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await opened(handles, startNodeRelay(env()));
    const info = (await (await fetch(`http://127.0.0.1:${port}`, { headers: { accept: 'application/nostr+json' } })).json()) as {
      supported_nips?: number[];
    };
    expect(info.supported_nips ?? []).not.toContain(86);
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/nostr+json+rpc' },
      body: JSON.stringify({ method: 'supportedmethods', params: [] }),
    });
    expect(res.headers.get('content-type') ?? '').not.toMatch(/application\/json/);
  });

  it('沒設 ROSTER_ADMIN_PUBKEY：名冊事件照舊只是一則事件，不改成員', async () => {
    const e = env();
    delete (e as Record<string, string>).ROSTER_ADMIN_PUBKEY;
    const port = await opened(handles, startNodeRelay({ ...e, ALLOWED_PUBKEYS: `${alice},${rosterAdmin}` }));
    expect(await send(port, roster([{ pubkey: bob, name: 'B' }], nowSec()))).toBe(true);
    expect(await send(port, note(bobSk))).toBe(false);
  });
});
