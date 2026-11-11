// NIP-86 管理 API × 真的 Node 主機（SDK ADR 0132）：預設關、運維金鑰≠名冊金鑰、名冊套用後寫入閘門真的換、重開還在。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHttpAuthEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  httpAuthHeader,
  signOrgRoster,
  type OrgRosterDoc,
} from '../../src/protocol/index.js';
import { NIP86_CONTENT_TYPE } from '../../src/relay/nip86.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

const opsSk = generateSecretKey();
const ops = getPublicKey(opsSk);
const rosterSk = generateSecretKey();
const rosterAdmin = getPublicKey(rosterSk);
const aliceSk = generateSecretKey();
const alice = getPublicKey(aliceSk);
const bobSk = generateSecretKey();

const handles: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const baseEnv = (over: Record<string, string> = {}) => ({
  PORT: '0',
  REQUIRE_AUTH: '0',
  NIP86_ADMIN_PUBKEYS: ops,
  ROSTER_ADMIN_PUBKEY: rosterAdmin,
  ...over,
});

async function rpc(port: number, method: string, params: unknown[] = [], sk = opsSk): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${port}/`;
  const body = JSON.stringify({ method, params });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': NIP86_CONTENT_TYPE,
      authorization: httpAuthHeader(buildHttpAuthEvent(url, 'POST', sk, Math.floor(Date.now() / 1000), { payload: body })),
    },
    body,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { text };
  }
  return { status: res.status, json };
}

async function info(port: number): Promise<Record<string, unknown>> {
  return (await (await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'application/nostr+json' } })).json()) as Record<string, unknown>;
}

let seq = 0;
/** 用 sk 發一則事件，回傳 OK 的接受與否 */
function publish(port: number, sk: Uint8Array): Promise<boolean> {
  const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: `nip86-${seq++}` }, sk);
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

function roster(members: OrgRosterDoc['members'], updatedAt: number) {
  return signOrgRoster({ org: '測試公司', members, updatedAt }, rosterSk);
}

describe('NIP-86 × Node 主機', () => {
  it('預設關：沒設 NIP86_ADMIN_PUBKEYS 就沒有這個端點、NIP-11 不宣告 86', async () => {
    const p = await opened(handles, startNodeRelay({ PORT: '0', REQUIRE_AUTH: '0' }, { memory: true }));
    const { json } = await rpc(p, 'supportedmethods');
    expect(json).not.toHaveProperty('result');
    expect(await info(p)).toMatchObject({ supported_nips: expect.not.arrayContaining([86]) });
  });

  it('🔴 名冊金鑰同時是運維金鑰 → 拒絕啟動', () => {
    expect(() => startNodeRelay(baseEnv({ NIP86_ADMIN_PUBKEYS: `${ops},${rosterAdmin}` }), { memory: true })).toThrow(/ROSTER_ADMIN_PUBKEY/);
  });

  it('開了：宣告 86；別人的金鑰 401；套用名冊後只有名冊成員寫得進', async () => {
    const p = await opened(handles, startNodeRelay(baseEnv(), { memory: true }));
    expect((await info(p)).supported_nips).toContain(86);
    expect((await rpc(p, 'supportedmethods', [], bobSk)).status).toBe(401);
    expect((await rpc(p, 'supportedmethods')).json.result).toContain('cinder_applyroster');

    expect(await publish(p, bobSk)).toBe(true); // 還是開放站
    const applied = await rpc(p, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], 100)]);
    expect(applied.json.result).toEqual({ allowed: 1, updatedAt: 100 });
    expect(await publish(p, aliceSk)).toBe(true);
    expect(await publish(p, bobSk)).toBe(false);
    expect((await info(p)).limitation).toMatchObject({ restricted_writes: true });
  });

  it('ALLOWED_KINDS：啟動即生效；disallowkind 之後那類事件被拒', async () => {
    const p = await opened(handles, startNodeRelay(baseEnv({ ALLOWED_KINDS: '1,20000' }), { memory: true }));
    expect((await rpc(p, 'listallowedkinds')).json.result).toEqual([1, 20000]);
    expect(await publish(p, aliceSk)).toBe(true);
    expect((await rpc(p, 'disallowkind', [1])).json.result).toBe(true);
    expect(await publish(p, aliceSk)).toBe(false);
  });

  it('有 SQLite 檔：名冊、站名重開後還在，且蓋過環境變數', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nip86-'));
    dirs.push(dir);
    const env = baseEnv({ DB_PATH: join(dir, 'relay.db'), RELAY_NAME: '環境變數的名字' });
    const first = startNodeRelay(env);
    const p1 = await first.ready;
    await rpc(p1, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], 100)]);
    await rpc(p1, 'changerelayname', ['管理 API 改的名字']);
    first.close();

    const p2 = await opened(handles, startNodeRelay(env));
    expect((await info(p2)).name).toBe('管理 API 改的名字');
    expect((await rpc(p2, 'listallowedpubkeys')).json.result).toEqual([{ pubkey: alice }]);
    expect(await publish(p2, bobSk)).toBe(false);
    // 舊名冊在重開後仍被拒
    expect((await rpc(p2, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], 90)])).json).toHaveProperty('error');
  });
});
