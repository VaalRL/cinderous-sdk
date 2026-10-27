// 同步與協定 API 接受 `Identity`（`NostrSigner`），不需要原始私鑰（SDK ADR 0023 §2）。
//
// 每一項都釘兩個方向的互通：用 `Identity` 產生的，對方用舊路徑（原始私鑰）解得開；
// 用舊路徑產生的，`Identity` 解得開。線上格式不變——舊版客戶端看不出差別。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { AUTH_KIND, buildAuthEvent } from '../../src/protocol/nip42.js';
import { createCallSignal, readCallSignal, type CallSignal } from '../../src/protocol/call.js';
import { buildDeviceDirectory, readDeviceDirectory } from '../../src/protocol/device-directory.js';
import { buildEkEnvelope, openEkEnvelope } from '../../src/protocol/ek-envelope.js';
import { buildHttpAuthEvent, httpAuthHeader, verifyHttpAuth } from '../../src/protocol/http-auth.js';
import { generatePqSeed, pqKeyFromSeed } from '../../src/protocol/hybrid-kem.js';
import { generateSecretKey, getPublicKey, nsecEncode, type SecretKey } from '../../src/protocol/keys.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { openWrap, PQ_CT_TAG, sealAndWrap } from '../../src/protocol/nip59.js';
import { meetsPow, minePow } from '../../src/protocol/pow.js';
import { verifyEvent } from '../../src/protocol/sign.js';
import { isNostrSigner, type NostrSigner } from '../../src/protocol/signer.js';
import { createSignal, readSignal } from '../../src/protocol/signaling.js';
import { buildEkAnnounce, openWrapWithEks, readEkAnnounce } from '../../src/protocol/subkey.js';
import { buildVanishRequest } from '../../src/protocol/vanish.js';
import { FILE_WRAP_KIND, parseFileChunk, wrapFileChunk } from '../../src/sync/file-relay.js';
import { buildSnapshotEvent, buildSnapshotPurge, openSnapshotEvent, SNAPSHOT_KIND } from '../../src/sync/snapshot.js';

/** 同一把金鑰的兩種拿法：原始私鑰（舊路徑）與 `Identity`（新路徑） */
function party(): { sk: SecretKey; pk: string; identity: Identity } {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), identity: Identity.fromNsec(nsecEncode(sk)) };
}

/**
 * 只有介面三個成員的簽章者：沒有 `nsec()`、沒有任何私鑰欄位。
 * 函式如果偷偷去拿私鑰（或把它當 `Uint8Array` 用），在這裡就會壞掉。
 */
function strictSigner(identity: Identity): NostrSigner & { readonly calls: string[] } {
  const calls: string[] = [];
  return Object.freeze({
    calls,
    pubkey: identity.pubkey,
    sign: (template: Parameters<NostrSigner['sign']>[0]) => {
      calls.push('sign');
      return identity.sign(template);
    },
    conversationKey: (pubkey: string) => {
      calls.push('conversationKey');
      return identity.conversationKey(pubkey);
    },
  });
}

describe('NostrSigner：Identity 就是一個簽章者', () => {
  it('Identity 符合介面；原始私鑰與 RecipientKey 不會被誤認成簽章者', () => {
    const { sk, identity } = party();
    const signer: NostrSigner = identity; // 型別層面：Identity 可以直接當 NostrSigner
    expect(isNostrSigner(signer)).toBe(true);
    expect(isNostrSigner(sk)).toBe(false);
    expect(isNostrSigner({ sk })).toBe(false);
    expect(isNostrSigner(null)).toBe(false);
  });

  it('Identity 沒有新增任何方法——仍然只有既有的 nsec() 會交出私鑰', () => {
    const methods = Object.getOwnPropertyNames(Identity.prototype).sort();
    expect(methods).toEqual(
      ['constructor', 'conversationKey', 'decryptFrom', 'encryptTo', 'nsec', 'openWrap', 'sealAndWrap', 'sign'].sort(),
    );
    const { identity } = party();
    // 公開欄位只有公鑰
    expect(Object.keys(identity).sort()).toEqual(['npub', 'pubkey']);
  });
});

describe('./sync：快照（kind 30078）', () => {
  it('Identity 打包 ⇒ 原始私鑰解得開；原始私鑰打包 ⇒ Identity 解得開', () => {
    const me = party();
    const viaIdentity = buildSnapshotEvent('{"v":1}', me.identity, 'dev1', { now: 1000 });
    expect(viaIdentity.kind).toBe(SNAPSHOT_KIND);
    expect(viaIdentity.pubkey).toBe(me.pk);
    expect(verifyEvent(viaIdentity)).toBe(true);
    expect(viaIdentity.tags).toEqual(buildSnapshotEvent('x', me.sk, 'dev1', { now: 1000 }).tags);
    expect(openSnapshotEvent(viaIdentity, me.sk)).toBe('{"v":1}');

    const viaSk = buildSnapshotEvent('{"v":2}', me.sk, 'dev1', { now: 1000 });
    expect(openSnapshotEvent(viaSk, me.identity)).toBe('{"v":2}');
    expect(openSnapshotEvent(viaSk, party().identity)).toBeNull(); // 別人解不開
  });

  it('嚴格簽章者（沒有私鑰可拿）也能打包、解開、清除', () => {
    const me = party();
    const signer = strictSigner(me.identity);
    const evt = buildSnapshotEvent('祕密', signer, 'dev1');
    expect(openSnapshotEvent(evt, signer)).toBe('祕密');
    const purge = buildSnapshotPurge(signer, 'dev1', { now: 5 });
    // 線上看到的（JSON）除了簽章之外與舊路徑完全相同
    const onWire = JSON.parse(JSON.stringify(purge)) as typeof purge;
    expect(onWire).toEqual({ ...buildSnapshotPurge(me.sk, 'dev1', { now: 5 }), sig: purge.sig });
    expect(verifyEvent(purge)).toBe(true);
    expect(signer.calls).toContain('conversationKey');
  });
});

describe('./sync：檔案塊（kind 1060）', () => {
  it('Identity 寄 ⇒ 對方用原始私鑰拆；原始私鑰寄 ⇒ 對方用 Identity 拆', () => {
    const alice = party();
    const bob = party();
    const chunk = { tid: 't1', seq: 0, total: 1, name: 'a.md', mime: 'text/markdown', data: new Uint8Array([1, 2, 3]) };

    const fromIdentity = wrapFileChunk(chunk, alice.identity, bob.pk, { now: 1000 });
    expect(fromIdentity.kind).toBe(FILE_WRAP_KIND);
    const opened = openWrap(fromIdentity, bob.sk);
    expect(opened.sender).toBe(alice.pk);
    expect(parseFileChunk(opened.rumor)?.data).toEqual(chunk.data);

    const fromSk = wrapFileChunk(chunk, alice.sk, bob.pk, { now: 1000 });
    const openedByIdentity = openWrap(fromSk, bob.identity);
    expect(openedByIdentity.sender).toBe(alice.pk);
    expect(parseFileChunk(openedByIdentity.rumor)?.name).toBe('a.md');
    expect(() => openWrap(fromSk, party().identity)).toThrow(); // 第三者拆不開
  });

  it('嚴格簽章者寄出的塊，舊路徑拆得開', () => {
    const alice = party();
    const bob = party();
    const chunk = { tid: 't2', seq: 0, total: 1, name: 'b', mime: '', data: new Uint8Array([9]) };
    const evt = wrapFileChunk(chunk, strictSigner(alice.identity), bob.pk);
    expect(openWrap(evt, bob.sk).sender).toBe(alice.pk);
  });
});

describe('./protocol：NIP-59 與 NIP-44', () => {
  const rumor = { kind: 14, created_at: 1_700_000_000, tags: [['t', 'x']], content: 'hi' };
  const spec = { kind: 1059, tags: [['p', 'aa']] };

  it('sealAndWrap／openWrap 兩個方向都互通', () => {
    const a = party();
    const b = party();
    const w1 = sealAndWrap(rumor, a.identity, b.pk, spec);
    expect(openWrap(w1, b.sk)).toMatchObject({ sender: a.pk, rumor: { content: 'hi', pubkey: a.pk } });
    const w2 = sealAndWrap(rumor, a.sk, b.pk, spec);
    expect(openWrap(w2, b.identity)).toMatchObject({ sender: a.pk, rumor: { content: 'hi' } });
    // rumor id 由內容決定：兩條路徑相同
    expect(openWrap(w1, b.sk).rumor.id).toBe(openWrap(w2, b.sk).rumor.id);
  });

  it('後量子混合封裝：寄件人用 Identity 也行（收件人照舊用 EK＋ML-KEM 私鑰）', () => {
    const a = party();
    const ekSk = generateSecretKey();
    const pq = pqKeyFromSeed(generatePqSeed());
    const evt = sealAndWrap(rumor, strictSigner(a.identity), { pk: getPublicKey(ekSk), pq: pq.pk }, spec);
    expect(evt.tags.some((t) => t[0] === PQ_CT_TAG)).toBe(true);
    expect(openWrap(evt, { sk: ekSk, pqSk: pq.sk }).sender).toBe(a.pk);
  });

  it('🔴 收件人用 Identity 拆混合式封裝 ⇒ fail-closed 拋錯（Identity 沒有 ML-KEM 私鑰，不得退回純古典）', () => {
    const a = party();
    const b = party();
    const pq = pqKeyFromSeed(generatePqSeed());
    const evt = sealAndWrap(rumor, a.sk, { pk: b.pk, pq: pq.pk }, spec);
    expect(() => openWrap(evt, b.identity)).toThrow(/ML-KEM/);
  });

  it('openWrapWithEks 的候選可以混用原始私鑰與 Identity', () => {
    const a = party();
    const b = party();
    const evt = sealAndWrap(rumor, a.sk, b.pk, spec);
    expect(openWrapWithEks(evt, [generateSecretKey(), b.identity]).sender).toBe(a.pk);
  });

  it('encryptDM／decryptDM 接受 Identity，與 Identity.encryptTo／decryptFrom 互通', () => {
    const a = party();
    const b = party();
    expect(decryptDM(encryptDM('x', a.identity, b.pk), b.sk, a.pk)).toBe('x');
    expect(decryptDM(encryptDM('y', a.sk, b.pk), b.identity, a.pk)).toBe('y');
    expect(b.identity.decryptFrom(a.pk, encryptDM('z', strictSigner(a.identity), b.pk))).toBe('z');
  });
});

describe('./protocol：信令與通話信令', () => {
  it('createSignal／readSignal', () => {
    const a = party();
    const b = party();
    const signal = { type: 'offer' as const, sdp: 'v=0' };
    expect(readSignal(createSignal(signal, a.identity, b.pk), b.sk)).toEqual({ sender: a.pk, signal });
    expect(readSignal(createSignal(signal, a.sk, b.pk), b.identity)).toEqual({ sender: a.pk, signal });
  });

  it('createCallSignal／readCallSignal', () => {
    const a = party();
    const b = party();
    const signal: CallSignal = { type: 'call-hangup', callId: 'c1' };
    expect(readCallSignal(createCallSignal(signal, a.identity, b.pk), b.sk)).toEqual({ sender: a.pk, signal });
    expect(readCallSignal(createCallSignal(signal, a.sk, b.pk), b.identity)).toEqual({ sender: a.pk, signal });
  });
});

describe('./protocol：只需要簽章的事件', () => {
  it('NIP-42 AUTH、NIP-98、NIP-62：與原始私鑰簽出的事件除了簽章完全相同', () => {
    const me = party();
    const pairs = [
      [buildAuthEvent('ch', 'wss://r', me.identity, { created_at: 7 }), buildAuthEvent('ch', 'wss://r', me.sk, { created_at: 7 })],
      [buildHttpAuthEvent('https://r/turn', 'GET', me.identity, 7), buildHttpAuthEvent('https://r/turn', 'GET', me.sk, 7)],
      [buildVanishRequest('wss://r', me.identity, { created_at: 7 }), buildVanishRequest('wss://r', me.sk, { created_at: 7 })],
    ] as const;
    for (const [viaIdentity, viaSk] of pairs) {
      expect(verifyEvent(viaIdentity)).toBe(true);
      expect(viaIdentity.id).toBe(viaSk.id);
      expect(viaIdentity.pubkey).toBe(me.pk);
    }
    expect(pairs[0][0].kind).toBe(AUTH_KIND);
    expect(verifyHttpAuth(httpAuthHeader(pairs[1][0]), 'https://r/turn', 'GET', 7)).toBe(me.pk);
  });

  it('minePow：用 Identity 挖出的事件達標、驗章通過，而且只簽一次', () => {
    const me = party();
    const signer = strictSigner(me.identity);
    const evt = minePow({ kind: 1, created_at: 1, tags: [], content: 'x' }, signer, 8);
    expect(meetsPow(evt, 8)).toBe(true);
    expect(verifyEvent(evt)).toBe(true);
    expect(evt.pubkey).toBe(me.pk);
    expect(signer.calls.filter((c) => c === 'sign')).toHaveLength(1);
  });

  it('EK 公告（kind 10040）', () => {
    const me = party();
    const ekPk = getPublicKey(generateSecretKey());
    const evt = buildEkAnnounce(me.identity, ekPk, { now: 3 });
    expect(evt.id).toBe(buildEkAnnounce(me.sk, ekPk, { now: 3 }).id);
    expect(readEkAnnounce(evt)).toMatchObject({ kind: 'ok', ik: me.pk, ek: ekPk });
  });
});

describe('./protocol：裝置目錄與 EK 分發', () => {
  it('裝置目錄（kind 10041）兩個方向都互通', () => {
    const me = party();
    const dir = { v: 3, devices: [{ pk: getPublicKey(generateSecretKey()), at: 1, label: '筆電' }] };
    expect(readDeviceDirectory(buildDeviceDirectory(me.identity, dir), me.sk)).toEqual(dir);
    expect(readDeviceDirectory(buildDeviceDirectory(me.sk, dir), strictSigner(me.identity))).toEqual(dir);
    expect(readDeviceDirectory(buildDeviceDirectory(me.sk, dir), party().identity)).toBeNull();
  });

  it('EK 分發：身分用 Identity 打包、裝置用原始私鑰或 Identity 打開', () => {
    const me = party();
    const device = party();
    const keys = [{ nsec: nsecEncode(generateSecretKey()), pk: getPublicKey(generateSecretKey()), at: 1 }];
    const evt = buildEkEnvelope(me.identity, [device.pk], keys, { now: 1 });
    expect(evt.pubkey).toBe(me.pk);
    expect(openEkEnvelope(evt, device.sk, me.pk)).toEqual(keys);
    expect(openEkEnvelope(buildEkEnvelope(me.sk, [device.pk], keys), device.identity, me.pk)).toEqual(keys);
  });
});

describe('Identity 的對話金鑰快取有上限', () => {
  it('拆大量禮物包（每則一把一次性金鑰）之後，較早的對象仍算得出正確的對話金鑰', () => {
    const me = party();
    const peer = party();
    const first = me.identity.conversationKey(peer.pk);
    // 超過上限（256）的對象數：一次性金鑰與拆禮物包時的情形相同
    for (let i = 0; i < 260; i += 1) me.identity.conversationKey(getPublicKey(generateSecretKey()));
    const rumor = { kind: 14, created_at: 1, tags: [], content: 'x' };
    expect(openWrap(sealAndWrap(rumor, peer.sk, me.pk, { kind: 1059, tags: [] }), me.identity).sender).toBe(peer.pk);
    // 被擠出快取的那一把重新算，結果相同；而且之前交出去的副本沒有被清零
    expect(me.identity.conversationKey(peer.pk)).toEqual(first);
    expect(first.some((b) => b !== 0)).toBe(true);
    expect(me.identity.decryptFrom(peer.pk, encryptDM('仍然互通', peer.sk, me.pk))).toBe('仍然互通');
  }, 30_000);
});
