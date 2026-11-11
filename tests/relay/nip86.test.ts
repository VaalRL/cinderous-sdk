// NIP-86 管理 API（SDK ADR 0132）：成員只能用簽章名冊改、事件類型只改既有清單、運維金鑰≠名冊金鑰。
import { describe, expect, it } from 'vitest';

import {
  buildHttpAuthEvent,
  generateSecretKey,
  getPublicKey,
  httpAuthHeader,
  signOrgRoster,
  type OrgRosterDoc,
} from '../../src/protocol/index.js';
import {
  handleNip86Request,
  isNip86Request,
  Nip86Admin,
  type Nip86Options,
  type Nip86State,
  NIP86_CONTENT_TYPE,
  NIP86_MAX_BODY_BYTES,
} from '../../src/relay/nip86.js';

const opsSk = generateSecretKey();
const ops = getPublicKey(opsSk);
const rosterSk = generateSecretKey();
const rosterAdmin = getPublicKey(rosterSk);
const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());
const carol = getPublicKey(generateSecretKey());

function roster(members: OrgRosterDoc['members'], updatedAt: number, sk = rosterSk) {
  return signOrgRoster({ org: '測試公司', members, updatedAt }, sk);
}

function make(over: Partial<Nip86Options> = {}) {
  const applied: { allowed?: string[]; kinds?: number[] } = {};
  const saved: Nip86State[] = [];
  const logs: string[] = [];
  const admin = new Nip86Admin({
    admins: [ops],
    rosterAdmin,
    apply: {
      allowed: (list) => (applied.allowed = list),
      kinds: (list) => (applied.kinds = list),
    },
    save: (s) => saved.push(s),
    log: (line) => logs.push(line),
    ...over,
  });
  return { admin, applied, saved, logs };
}

describe('Nip86Admin：建構', () => {
  it('🔴 名冊金鑰出現在運維金鑰裡 → 拒絕（不能把成員權威交給運維）', () => {
    expect(() => make({ admins: [ops, rosterAdmin] })).toThrow(/ROSTER_ADMIN_PUBKEY/);
  });

  it('沒有任何運維金鑰 → 拒絕（沒人能用的端點不該存在）', () => {
    expect(() => make({ admins: [] })).toThrow(/NIP86_ADMIN_PUBKEYS/);
  });
});

describe('supportedmethods', () => {
  it('只列實際提供的方法；有名冊金鑰才列 cinder_applyroster', () => {
    const withRoster = make().admin.call(ops, 'supportedmethods', []);
    expect(withRoster).toEqual({ result: expect.arrayContaining(['cinder_applyroster', 'listallowedpubkeys', 'allowkind']) });
    const noRoster = make({ rosterAdmin: undefined }).admin.call(ops, 'supportedmethods', []);
    expect((noRoster as { result: string[] }).result).not.toContain('cinder_applyroster');
    expect((noRoster as { result: string[] }).result).not.toContain('allowpubkey');
  });
});

describe('成員：只能用簽章名冊改', () => {
  it('合法名冊 → 套用在世成員（不含已輪替作廢的舊金鑰）、存檔、記一行日誌', () => {
    const { admin, applied, saved, logs } = make();
    const ev = roster([{ pubkey: alice, name: 'A' }, { pubkey: bob, name: 'B', supersededBy: carol }, { pubkey: carol, name: 'C' }], 100);
    expect(admin.call(ops, 'cinder_applyroster', [ev])).toEqual({ result: { allowed: 2, updatedAt: 100 } });
    expect([...(applied.allowed ?? [])].sort()).toEqual([alice, carol].sort());
    expect(saved.at(-1)?.roster).toEqual({ updatedAt: 100, allowed: applied.allowed, admin: rosterAdmin }); // admin：SDK ADR 0133
    expect(logs.at(-1)).toContain(ops.slice(0, 8));
    expect(logs.at(-1)).toContain('cinder_applyroster');
    expect(admin.call(ops, 'listallowedpubkeys', [])).toEqual({
      result: expect.arrayContaining([{ pubkey: alice }, { pubkey: carol }]),
    });
  });

  it('不是名冊金鑰簽的、被竄改的 → 拒絕，名單不動', () => {
    const { admin, applied } = make();
    expect(admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], 100, opsSk)])).toHaveProperty('error');
    const tampered = { ...roster([{ pubkey: alice, name: 'A' }], 100), content: '{"org":"x","members":[{"pubkey":"' + bob + '","name":"B"}],"updatedAt":100}' };
    expect(admin.call(ops, 'cinder_applyroster', [tampered])).toHaveProperty('error');
    expect(admin.call(ops, 'cinder_applyroster', ['not an event'])).toHaveProperty('error');
    expect(applied.allowed).toBeUndefined();
  });

  it('沒有比上次新的名冊 → 拒絕（擋重送舊名冊把離職的人加回來）', () => {
    const { admin, applied } = make();
    admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], 200)]);
    const res = admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }, { pubkey: bob, name: 'B' }], 200)]);
    expect(res).toHaveProperty('error');
    expect(applied.allowed).toEqual([alice]);
  });

  it('重開後從存檔還原：舊於存檔的名冊仍被拒', () => {
    const { admin } = make({ state: { roster: { updatedAt: 300, allowed: [alice] } } });
    expect(admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: bob, name: 'B' }], 250)])).toHaveProperty('error');
  });

  it('🔴 名冊裡沒有在世成員（全都輪替作廢）→ 拒絕，不把整站關掉', () => {
    const { admin, applied } = make();
    const res = admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A', supersededBy: bob }], 100)]);
    expect(res).toHaveProperty('error');
    expect(applied.allowed).toBeUndefined();
  });

  it('沒設名冊金鑰 → cinder_applyroster 回錯誤', () => {
    const { admin } = make({ rosterAdmin: undefined });
    expect(admin.call(ops, 'cinder_applyroster', [roster([{ pubkey: alice, name: 'A' }], 100)])).toHaveProperty('error');
  });

  it.each(['allowpubkey', 'unallowpubkey', 'banpubkey', 'unbanpubkey'])('%s → 錯誤並指向名冊流程', (method) => {
    const res = make().admin.call(ops, method, [alice, '理由']);
    expect((res as { error: string }).error).toMatch(/cinder_applyroster/);
  });

  it('listbannedpubkeys 恆空；沒設白名單時 listallowedpubkeys 也是空', () => {
    const { admin } = make();
    expect(admin.call(ops, 'listbannedpubkeys', [])).toEqual({ result: [] });
    expect(admin.call(ops, 'listallowedpubkeys', [])).toEqual({ result: [] });
  });
});

describe('事件類型：只改既有清單', () => {
  it('沒設清單（全部接受）：allowkind 回 true 不做事；disallowkind 回錯誤', () => {
    const { admin, applied } = make();
    expect(admin.call(ops, 'allowkind', [1])).toEqual({ result: true });
    expect(admin.call(ops, 'disallowkind', [1])).toHaveProperty('error');
    expect(applied.kinds).toBeUndefined();
    expect(admin.call(ops, 'listallowedkinds', [])).toEqual({ result: [] });
  });

  it('有清單：加、刪、列出，並存檔', () => {
    const { admin, applied, saved } = make({ allowedKinds: [1059, 20000] });
    expect(admin.call(ops, 'allowkind', [21000])).toEqual({ result: true });
    expect(admin.call(ops, 'disallowkind', [20000])).toEqual({ result: true });
    expect(applied.kinds).toEqual([1059, 21000]);
    expect(admin.call(ops, 'listallowedkinds', [])).toEqual({ result: [1059, 21000] });
    expect(saved.at(-1)?.allowedKinds).toEqual([1059, 21000]);
  });

  it('🔴 不能刪掉最後一個 kind（等於整站拒收）', () => {
    const { admin } = make({ allowedKinds: [1059] });
    expect(admin.call(ops, 'disallowkind', [1059])).toHaveProperty('error');
  });

  it('kind 不是非負整數 → 錯誤', () => {
    const { admin } = make({ allowedKinds: [1059] });
    for (const bad of [-1, 1.5, '1', null, 70000]) expect(admin.call(ops, 'allowkind', [bad])).toHaveProperty('error');
  });
});

describe('站名與說明', () => {
  it('改了就反映在 info()，並存檔', () => {
    const { admin, saved } = make();
    expect(admin.call(ops, 'changerelayname', ['公司站'])).toEqual({ result: true });
    expect(admin.call(ops, 'changerelaydescription', ['內部用'])).toEqual({ result: true });
    expect(admin.info()).toEqual({ name: '公司站', description: '內部用' });
    expect(saved.at(-1)).toMatchObject({ name: '公司站', description: '內部用' });
  });

  it('太長或不是字串 → 錯誤', () => {
    const { admin } = make();
    expect(admin.call(ops, 'changerelayname', ['x'.repeat(101)])).toHaveProperty('error');
    expect(admin.call(ops, 'changerelaydescription', ['x'.repeat(2001)])).toHaveProperty('error');
    expect(admin.call(ops, 'changerelayname', [42])).toHaveProperty('error');
  });
});

it('不認得的方法 → 錯誤', () => {
  expect(make().admin.call(ops, 'createrole', [])).toHaveProperty('error');
});

describe('handleNip86Request：HTTP 外殼', () => {
  const now = 1_700_000_000;
  const host = 'relay.example';
  const body = JSON.stringify({ method: 'supportedmethods', params: [] });
  const auth = (opts: { sk?: Uint8Array; url?: string; payload?: string; at?: number } = {}) =>
    httpAuthHeader(
      buildHttpAuthEvent(opts.url ?? `https://${host}/`, 'POST', opts.sk ?? opsSk, opts.at ?? now, { payload: opts.payload ?? body }),
    );
  const req = (over: Partial<Parameters<typeof handleNip86Request>[1]> = {}) => ({
    method: 'POST',
    contentType: NIP86_CONTENT_TYPE,
    authorization: auth(),
    body,
    host,
    path: '/',
    ...over,
  });

  it('isNip86Request：只認 POST＋application/nostr+json+rpc', () => {
    expect(isNip86Request('POST', 'application/nostr+json+rpc')).toBe(true);
    expect(isNip86Request('POST', 'application/nostr+json+rpc; charset=utf-8')).toBe(true);
    expect(isNip86Request('GET', 'application/nostr+json+rpc')).toBe(false);
    expect(isNip86Request('POST', 'application/json')).toBe(false);
  });

  it('合法請求 → 200 與結果；http 與 https 的 u 都接受', () => {
    const { admin } = make();
    expect(handleNip86Request(admin, req(), now).status).toBe(200);
    expect(handleNip86Request(admin, req({ authorization: auth({ url: `http://${host}` }) }), now).status).toBe(200);
    expect(handleNip86Request(admin, req(), now).body).toHaveProperty('result');
  });

  it('🔴 沒授權、別人的金鑰、換了內容、過期、打錯主機 → 一律 401', () => {
    const { admin } = make();
    const stranger = generateSecretKey();
    for (const r of [
      req({ authorization: undefined }),
      req({ authorization: auth({ sk: stranger }) }),
      req({ authorization: auth({ sk: rosterSk }) }),
      req({ body: JSON.stringify({ method: 'changerelayname', params: ['x'] }) }),
      req({ authorization: auth({ at: now - 120 }) }),
      req({ authorization: auth({ url: 'https://other.example/' }) }),
    ]) {
      expect(handleNip86Request(admin, r, now).status).toBe(401);
    }
  });

  it('內容超過上限 → 413；不是 JSON 或少了 method → 400', () => {
    const { admin } = make();
    const big = 'x'.repeat(NIP86_MAX_BODY_BYTES + 1);
    expect(handleNip86Request(admin, req({ body: big, authorization: auth({ payload: big }) }), now).status).toBe(413);
    expect(handleNip86Request(admin, req({ body: 'nope', authorization: auth({ payload: 'nope' }) }), now).status).toBe(400);
    const noMethod = JSON.stringify({ params: [] });
    expect(handleNip86Request(admin, req({ body: noMethod, authorization: auth({ payload: noMethod }) }), now).status).toBe(400);
  });
});
