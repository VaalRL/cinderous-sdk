// NIP-86 管理 API 的補強（SDK ADR 0133）：發版後的獨立審查找到的東西，一項一組測試。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHttpAuthEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  httpAuthHeader,
  httpAuthSigner,
  signOrgRoster,
  type OrgRosterDoc,
} from '../../src/protocol/index.js';
import {
  handleNip86Request,
  Nip86Admin,
  type Nip86Options,
  type Nip86State,
  NIP86_CONTENT_TYPE,
  nip86Precheck,
  parseNip86State,
} from '../../src/relay/nip86.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

const opsSk = generateSecretKey();
const ops = getPublicKey(opsSk);
const rosterSk = generateSecretKey();
const rosterAdmin = getPublicKey(rosterSk);
const aliceSk = generateSecretKey();
const alice = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const bob = getPublicKey(bobSk);
const NOW = 1_700_000_000;

function roster(members: OrgRosterDoc['members'], updatedAt: number, sk = rosterSk) {
  return signOrgRoster({ org: '測試公司', members, updatedAt }, sk);
}

function make(over: Partial<Nip86Options> = {}) {
  const applied: { allowed?: string[]; kinds?: number[] } = {};
  const saved: Nip86State[] = [];
  const admin = new Nip86Admin({
    admins: [ops],
    rosterAdmin,
    apply: { allowed: (list) => (applied.allowed = list), kinds: (list) => (applied.kinds = list) },
    save: (s) => saved.push(s),
    ...over,
  });
  return { admin, applied, saved };
}

describe('名冊的合理性檢查（中繼這一側）', () => {
  it('🔴 updatedAt 用了毫秒（或任何遠在未來的值）→ 拒絕，否則之後正常的名冊全都變成「舊的」', () => {
    const { admin, applied } = make();
    const r = admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], NOW * 1000)], NOW);
    expect(r).toHaveProperty('error');
    expect(applied.allowed).toBeUndefined();
    // 之後以秒為單位的正常名冊照常套用
    expect(admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], NOW)], NOW)).toHaveProperty('result');
  });

  it('稍微超前的 updatedAt 可以（客戶端為了遞增會 +1），一天以上不行', () => {
    expect(make().admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], NOW + 3600)], NOW)).toHaveProperty('result');
    expect(make().admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], NOW + 86_401)], NOW)).toHaveProperty('error');
  });

  it('updatedAt 不是非負整數 → 拒絕', () => {
    for (const bad of [-1, 1.5]) {
      expect(make().admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], bad)], NOW)).toHaveProperty('error');
    }
  });

  it('🔴 成員的 pubkey 不是 64 個小寫 hex（npub、大寫、亂字）→ 整份拒絕，不把整站鎖成沒人寫得進', () => {
    for (const bad of ['NOT-A-KEY', alice.toUpperCase(), `npub1${'q'.repeat(58)}`]) {
      const { admin, applied } = make();
      const r = admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: bad, name: 'X' }, { pubkey: alice, name: 'A' }], NOW)], NOW);
      expect(r).toHaveProperty('error');
      expect(applied.allowed).toBeUndefined();
    }
  });
});

describe('存檔失敗', () => {
  it('🔴 存不進去 → 回錯誤、記憶體裡的名單不變、之後還能重送同一份（不是「套用了卻沒存」）', () => {
    let fail = true;
    const applied: string[][] = [];
    const admin = new Nip86Admin({
      admins: [ops],
      rosterAdmin,
      apply: { allowed: (l) => applied.push(l), kinds: () => {} },
      save: () => {
        if (fail) throw new Error('disk full');
      },
    });
    const ev = roster([{ pubkey: alice, name: 'A' }], NOW);
    expect(admin.call(ops, 'cinder_applyroster', [ev], NOW)).toHaveProperty('error');
    expect(applied).toEqual([]);
    expect(admin.call(ops, 'listallowedpubkeys', [])).toEqual({ result: [] });
    fail = false;
    expect(admin.call(ops, 'cinder_applyroster', [ev], NOW)).toHaveProperty('result'); // 沒被記成「已套用」
    expect(applied).toEqual([[alice]]);
  });

  it('改站名、改事件類型也一樣：存不進去就不生效', () => {
    const kinds: number[][] = [];
    const admin = new Nip86Admin({
      admins: [ops],
      allowedKinds: [1, 2],
      apply: { allowed: () => {}, kinds: (l) => kinds.push(l) },
      save: () => {
        throw new Error('busy');
      },
    });
    expect(admin.call(ops, 'changerelayname', ['新名字'])).toHaveProperty('error');
    expect(admin.info()).toEqual({});
    expect(admin.call(ops, 'disallowkind', [2])).toHaveProperty('error');
    expect(kinds).toEqual([]);
    expect(admin.call(ops, 'listallowedkinds', [])).toEqual({ result: [1, 2] });
  });
});

describe('parseNip86State：讀回存檔時驗結構', () => {
  it('正常的存檔原樣回來', () => {
    const state: Nip86State = { roster: { updatedAt: 5, allowed: [alice], admin: rosterAdmin }, allowedKinds: [1], name: 'n', description: 'd' };
    expect(parseNip86State(JSON.stringify(state))).toEqual(state);
    expect(parseNip86State('{}')).toEqual({});
  });

  it('🔴 結構不對 → 整份不用（undefined），不讓壞資料變成政策', () => {
    for (const bad of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ roster: { allowed: 'abc' } }), // 字串會被逐字拆成「成員」
      JSON.stringify({ roster: { updatedAt: 1, allowed: [] } }), // 空名單＝整站鎖死
      JSON.stringify({ roster: { updatedAt: 1, allowed: ['NOT-A-KEY'] } }),
      JSON.stringify({ roster: { allowed: [alice] } }), // 少了 updatedAt＝舊名冊保護失效
      JSON.stringify({ allowedKinds: [] }), // 空清單＝整站拒收
      JSON.stringify({ allowedKinds: [1, 70000] }),
      JSON.stringify({ name: 5 }),
      JSON.stringify({ description: 'x'.repeat(2001) }),
    ]) {
      expect(parseNip86State(bad), bad).toBeUndefined();
    }
  });
});

describe('授權：先驗標頭、綁定對外網址', () => {
  const body = JSON.stringify({ method: 'supportedmethods', params: [] });
  const header = (url: string, sk = opsSk, at = NOW) => httpAuthHeader(buildHttpAuthEvent(url, 'POST', sk, at, { payload: body }));

  it('httpAuthSigner：只看簽章與時間窗，回簽署者；壞的回 null', () => {
    expect(httpAuthSigner(header('https://a.example/'), NOW)).toBe(ops);
    expect(httpAuthSigner(header('https://a.example/', opsSk, NOW - 120), NOW)).toBeNull();
    expect(httpAuthSigner('Nostr !!!', NOW)).toBeNull();
    expect(httpAuthSigner(null, NOW)).toBeNull();
    // kind 不對（拿別種事件冒充）
    const other = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: '' }, opsSk);
    expect(httpAuthSigner(httpAuthHeader(other), NOW)).toBeNull();
  });

  it('nip86Precheck：運維金鑰簽的、還在時間窗內才過——讀請求內容之前就能擋掉其他人', () => {
    const { admin } = make();
    expect(nip86Precheck(admin, header('https://a.example/'), NOW)).toBe(true);
    expect(nip86Precheck(admin, header('https://a.example/', generateSecretKey()), NOW)).toBe(false);
    expect(nip86Precheck(admin, header('https://a.example/', rosterSk), NOW)).toBe(false);
    expect(nip86Precheck(admin, undefined, NOW)).toBe(false);
  });

  it('🔴 設了對外網址：只認簽給那個網址的請求，Host 標頭寫什麼都沒用', () => {
    const { admin } = make();
    const base = { method: 'POST', contentType: NIP86_CONTENT_TYPE, body, path: '/' };
    const publicUrl = 'https://relay.example/';
    // 簽給別站、再用 Host 冒充別站：過去會過，現在不行
    expect(
      handleNip86Request(admin, { ...base, authorization: header('https://other.example/'), host: 'other.example', publicUrl }, NOW).status,
    ).toBe(401);
    // 簽給本站：Host 是內部位址（反向代理後面）也照樣過
    expect(
      handleNip86Request(admin, { ...base, authorization: header('https://relay.example/'), host: '10.0.0.5:8787', publicUrl }, NOW).status,
    ).toBe(200);
    // 有無結尾斜線都算同一個；協定不同不算
    expect(handleNip86Request(admin, { ...base, authorization: header('https://relay.example'), host: 'x', publicUrl }, NOW).status).toBe(200);
    expect(handleNip86Request(admin, { ...base, authorization: header('http://relay.example/'), host: 'x', publicUrl }, NOW).status).toBe(401);
  });
});

// ── 真的 Node 主機 ─────────────────────────────────────────────────────────────

const handles: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const baseEnv = (over: Record<string, string> = {}) => ({
  PORT: '0',
  REQUIRE_AUTH: '0',
  NIP86_ADMIN_PUBKEYS: ops,
  ROSTER_ADMIN_PUBKEY: rosterAdmin,
  ...over,
});

async function rpc(
  port: number,
  method: string,
  params: unknown[] = [],
  opts: { signFor?: string; headers?: Record<string, string>; sk?: Uint8Array } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${port}/`;
  const body = JSON.stringify({ method, params });
  const signed = buildHttpAuthEvent(opts.signFor ?? url, 'POST', opts.sk ?? opsSk, Math.floor(Date.now() / 1000), { payload: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': NIP86_CONTENT_TYPE, authorization: httpAuthHeader(signed), ...opts.headers },
    body,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json };
}

let seq = 0;
function publish(port: number, sk: Uint8Array): Promise<boolean> {
  const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: `hard-${seq++}` }, sk);
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

const nowSec = () => Math.floor(Date.now() / 1000);

describe('NIP-86 補強 × Node 主機', () => {
  it('🔴 X-Forwarded-Host 不再被信任：簽給別站的請求，帶這個標頭也是 401', async () => {
    const p = await opened(handles, startNodeRelay(baseEnv(), { memory: true }));
    const r = await rpc(p, 'supportedmethods', [], { signFor: 'https://other-relay.example/', headers: { 'x-forwarded-host': 'other-relay.example' } });
    expect(r.status).toBe(401);
    expect((await rpc(p, 'supportedmethods')).status).toBe(200); // 正常的照舊
  });

  it('🔴 設了 NIP86_PUBLIC_URL：只認簽給它的請求（簽給連線位址的也不行）', async () => {
    const p = await opened(handles, startNodeRelay(baseEnv({ NIP86_PUBLIC_URL: 'https://relay.example/' }), { memory: true }));
    expect((await rpc(p, 'supportedmethods', [], { signFor: 'https://relay.example/' })).status).toBe(200);
    expect((await rpc(p, 'supportedmethods')).status).toBe(401);
  });

  it('NIP86_PUBLIC_URL 寫錯 → 拒絕啟動', () => {
    expect(() => startNodeRelay(baseEnv({ NIP86_PUBLIC_URL: 'relay.example' }), { memory: true })).toThrow(/NIP86_PUBLIC_URL/);
    expect(() => startNodeRelay(baseEnv({ NIP86_PUBLIC_URL: 'wss://relay.example' }), { memory: true })).toThrow(/NIP86_PUBLIC_URL/);
  });

  it('🔴 沒授權的人送一大包內容 → 不讀完就回 401（宣稱的長度超過上限則 413）', async () => {
    const p = await opened(handles, startNodeRelay(baseEnv(), { memory: true }));
    const url = `http://127.0.0.1:${p}/`;
    const noAuth = await fetch(url, { method: 'POST', headers: { 'content-type': NIP86_CONTENT_TYPE }, body: 'x'.repeat(200_000) }).catch(() => undefined);
    // 伺服器回完 401 就切線；fetch 可能拿到 401，也可能因為連線被切而丟錯——兩者都代表沒有被讀完。
    if (noAuth) expect(noAuth.status).toBe(401);
    const stranger = await rpc(p, 'supportedmethods', [], { sk: generateSecretKey() });
    expect(stranger.status).toBe(401);
    const tooBig = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': NIP86_CONTENT_TYPE, authorization: httpAuthHeader(buildHttpAuthEvent(url, 'POST', opsSk, nowSec(), { payload: '' })) },
      body: 'x'.repeat((1 << 20) + 10),
    }).catch(() => undefined);
    if (tooBig) expect(tooBig.status).toBe(413);
    expect((await rpc(p, 'supportedmethods')).status).toBe(200); // 站還活著
  });

  it('🔴 拿掉 ROSTER_ADMIN_PUBKEY 重開：存過的名冊不再生效，回到環境變數的 ALLOWED_PUBKEYS（有出口）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nip86h-'));
    dirs.push(dir);
    const DB_PATH = join(dir, 'relay.db');
    const first = startNodeRelay(baseEnv({ DB_PATH }));
    const p1 = await first.ready;
    await rpc(p1, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], nowSec())]);
    expect(await publish(p1, bobSk)).toBe(false);
    first.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p2 = await opened(handles, startNodeRelay({ PORT: '0', REQUIRE_AUTH: '0', NIP86_ADMIN_PUBKEYS: ops, ALLOWED_PUBKEYS: bob, DB_PATH }));
    expect(await publish(p2, bobSk)).toBe(true);
    expect(await publish(p2, aliceSk)).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/ROSTER_ADMIN_PUBKEY/);
  });

  it('換了一把名冊金鑰重開：上一把簽的名冊不再生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nip86h-'));
    dirs.push(dir);
    const DB_PATH = join(dir, 'relay.db');
    const first = startNodeRelay(baseEnv({ DB_PATH }));
    await rpc(await first.ready, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], nowSec())]);
    first.close();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = getPublicKey(generateSecretKey());
    const p2 = await opened(handles, startNodeRelay(baseEnv({ DB_PATH, ROSTER_ADMIN_PUBKEY: other })));
    expect(await publish(p2, bobSk)).toBe(true); // 沒有 ALLOWED_PUBKEYS＝開放站
  });

  it('存過的名冊蓋過不一樣的 ALLOWED_PUBKEYS 時，啟動要說一聲', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nip86h-'));
    dirs.push(dir);
    const DB_PATH = join(dir, 'relay.db');
    const first = startNodeRelay(baseEnv({ DB_PATH }));
    await rpc(await first.ready, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], nowSec())]);
    first.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p2 = await opened(handles, startNodeRelay(baseEnv({ DB_PATH, ALLOWED_PUBKEYS: bob })));
    expect(await publish(p2, aliceSk)).toBe(true); // 名冊仍是權威
    expect(await publish(p2, bobSk)).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/ALLOWED_PUBKEYS/);
  });

  it('🔴 存檔被改壞（結構不對）→ 這次照環境變數開，不把壞資料當政策', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nip86h-'));
    dirs.push(dir);
    const DB_PATH = join(dir, 'relay.db');
    const first = startNodeRelay(baseEnv({ DB_PATH }));
    await rpc(await first.ready, 'changerelayname', ['先存一筆']);
    first.close();
    const db = new DatabaseSync(DB_PATH);
    db.prepare('UPDATE cinder_admin_state SET v = ? WHERE k = ?').run(JSON.stringify({ roster: { allowed: 'abc' }, allowedKinds: [] }), 'nip86');
    db.close();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p2 = await opened(handles, startNodeRelay(baseEnv({ DB_PATH })));
    expect(await publish(p2, bobSk)).toBe(true);
    expect((await rpc(p2, 'listallowedpubkeys')).json.result).toEqual([]);
  });
});
