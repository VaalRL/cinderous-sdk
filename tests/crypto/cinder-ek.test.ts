// Cinder EK 金鑰環（SDK ADR 0010 §1）：Cinderous 的 EK 純函式之上，補輪替、保存、封裝與防降級。
import { describe, expect, it } from 'vitest';

import { CinderEkKeyring, PeerUpgradedError, SecurityDowngradeError } from '../../src/crypto/cinder-ek.js';
import { Identity } from '../../src/identity.js';
import { EK_ANNOUNCE_KIND, ekHintOf, PQ_CT_TAG, readEkAnnounce } from '../../src/protocol/index.js';

const DAY = 86_400_000;

function clock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function people(postQuantum = true) {
  const time = clock();
  const alice = Identity.generate();
  const bob = Identity.generate();
  return {
    time,
    alice,
    bob,
    aliceRing: CinderEkKeyring.create(alice, { now: time.now, postQuantum }),
    bobRing: CinderEkKeyring.create(bob, { now: time.now, postQuantum }),
  };
}

const rumor = (content: string) => ({ kind: 14, created_at: 1_800_000_000, tags: [], content });

describe('公告（kind 10040）', () => {
  it('由身分簽章，內容是目前的 EK；預設帶後量子公鑰', () => {
    const { bob, bobRing } = people();
    const announce = bobRing.buildAnnounce();
    expect(announce.kind).toBe(EK_ANNOUNCE_KIND);
    expect(announce.pubkey).toBe(bob.pubkey);
    const parsed = readEkAnnounce(announce);
    expect(parsed).toMatchObject({ kind: 'ok', ik: bob.pubkey, ek: bobRing.currentPublicKey });
    expect(parsed && parsed.kind === 'ok' && parsed.pq).toBeTruthy();
  });

  it('postQuantum: false → 發 v1，不帶後量子', () => {
    const { bobRing } = people(false);
    const parsed = readEkAnnounce(bobRing.buildAnnounce());
    expect(parsed && parsed.kind === 'ok' && parsed.pq).toBeFalsy();
  });
});

describe('封裝與解封', () => {
  it('封給對方的 EK：對方解得開、認得出寄件人；只有身分金鑰解不開（前向保密）', () => {
    const { alice, bob, aliceRing, bobRing } = people();
    const wrap = aliceRing.seal(rumor('嗨'), bob.pubkey, bobRing.buildAnnounce(), { kind: 1059, tags: [['p', bob.pubkey]] });
    expect(wrap.tags).toContainEqual(['p', bob.pubkey]);
    expect(wrap.tags.some((t) => t[0] === PQ_CT_TAG)).toBe(true); // 對方有後量子 → 走混合式

    const opened = bobRing.open(wrap);
    expect(opened.sender).toBe(alice.pubkey);
    expect(opened.rumor.content).toBe('嗨');
    expect(opened.via).toBe('ek');
    expect(ekHintOf(opened.rumor.tags)).toBe(aliceRing.currentPublicKey); // 順便告訴對方我的 EK
    expect(() => bob.openWrap(wrap)).toThrow();
  });

  it('對方沒有公告（還沒開 FS）→ 封給身分金鑰，對方以身分金鑰解開', () => {
    const { alice, bob, aliceRing, bobRing } = people();
    const wrap = aliceRing.seal(rumor('舊版'), bob.pubkey, undefined, { kind: 1059, tags: [['p', bob.pubkey]] });
    const opened = bobRing.open(wrap);
    expect(opened.via).toBe('identity');
    expect(opened.sender).toBe(alice.pubkey);
  });

  it('公告不是這個人簽的 → 拒絕（不能讓別人替 Bob 宣告 EK）', () => {
    const { bob, aliceRing } = people();
    const mallory = CinderEkKeyring.create(Identity.generate());
    expect(() => aliceRing.seal(rumor('x'), bob.pubkey, mallory.buildAnnounce(), { kind: 1059, tags: [] })).toThrow(/不是/);
  });

  it('不是給我的 → 丟例外', () => {
    const { bob, aliceRing, bobRing } = people();
    const wrap = aliceRing.seal(rumor('x'), bob.pubkey, bobRing.buildAnnounce(), { kind: 1059, tags: [] });
    expect(() => CinderEkKeyring.create(Identity.generate()).open(wrap)).toThrow();
  });
});

describe('輪替與寬限期', () => {
  it('滿 7 天才輪替；舊 EK 在寬限期內仍解得開，過了就刪', () => {
    const { time, bob, aliceRing, bobRing } = people();
    const oldAnnounce = bobRing.buildAnnounce();
    const oldPk = bobRing.currentPublicKey;
    const toOld = aliceRing.seal(rumor('舊'), bob.pubkey, oldAnnounce, { kind: 1059, tags: [] });

    time.advance(6 * DAY);
    expect(bobRing.rotateIfDue()).toBe(false);
    time.advance(DAY);
    expect(bobRing.rotateIfDue()).toBe(true);
    expect(bobRing.currentPublicKey).not.toBe(oldPk);
    expect(bobRing.open(toOld).rumor.content).toBe('舊'); // 寬限期內

    time.advance(8 * DAY);
    bobRing.rotateIfDue();
    expect(() => bobRing.open(toOld)).toThrow(); // 舊 EK 已刪：前向保密生效
  });
});

describe('保存', () => {
  it('匯出再載入：舊訊息照樣解得開；匯出內容不含身分私鑰', () => {
    const { alice, bob, aliceRing, bobRing } = people();
    const wrap = aliceRing.seal(rumor('存'), bob.pubkey, bobRing.buildAnnounce(), { kind: 1059, tags: [] });
    const state = bobRing.exportState();
    expect(state).not.toContain(bob.nsec());
    const restored = CinderEkKeyring.fromState(bob, state);
    expect(restored.currentPublicKey).toBe(bobRing.currentPublicKey);
    expect(restored.open(wrap).sender).toBe(alice.pubkey);
  });

  it('壞掉的狀態 → 丟例外（不默默變成空的金鑰環）', () => {
    expect(() => CinderEkKeyring.fromState(Identity.generate(), '{"v":1,"keys":[]}')).toThrow();
    expect(() => CinderEkKeyring.fromState(Identity.generate(), 'not json')).toThrow();
  });
});

describe('防降級（PRD 3.4）', () => {
  it('🔴 看過對方的後量子公告後，又收到不帶後量子的公告 → SecurityDowngradeError', () => {
    const time = clock();
    const bob = Identity.generate();
    const aliceRing = CinderEkKeyring.create(Identity.generate(), { now: time.now });
    const bobPq = CinderEkKeyring.create(bob, { now: time.now });
    const bobClassic = CinderEkKeyring.create(bob, { now: time.now, postQuantum: false });

    aliceRing.seal(rumor('1'), bob.pubkey, bobPq.buildAnnounce(), { kind: 1059, tags: [] });
    let error: unknown;
    try {
      aliceRing.seal(rumor('2'), bob.pubkey, bobClassic.buildAnnounce(), { kind: 1059, tags: [] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecurityDowngradeError);
    expect((error as SecurityDowngradeError).peer).toBe(bob.pubkey);
  });

  it('🔴 看過對方的 FS 公告後，公告整個不見 → 也算降級（中繼可能把它藏起來了）', () => {
    const { bob, aliceRing, bobRing } = people();
    aliceRing.seal(rumor('1'), bob.pubkey, bobRing.buildAnnounce(), { kind: 1059, tags: [] });
    expect(() => aliceRing.seal(rumor('2'), bob.pubkey, undefined, { kind: 1059, tags: [] })).toThrow(SecurityDowngradeError);
  });

  it('釘選會跟著狀態一起保存', () => {
    const time = clock();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const ring = CinderEkKeyring.create(alice, { now: time.now });
    ring.seal(rumor('1'), bob.pubkey, CinderEkKeyring.create(bob, { now: time.now }).buildAnnounce(), { kind: 1059, tags: [] });
    const restored = CinderEkKeyring.fromState(alice, ring.exportState(), { now: time.now });
    const classic = CinderEkKeyring.create(bob, { now: time.now, postQuantum: false }).buildAnnounce();
    expect(() => restored.seal(rumor('2'), bob.pubkey, classic, { kind: 1059, tags: [] })).toThrow(SecurityDowngradeError);
  });

  it('從來沒開過 FS 的對方：一直沒有公告不算降級', () => {
    const { bob, aliceRing } = people();
    aliceRing.seal(rumor('1'), bob.pubkey, undefined, { kind: 1059, tags: [] });
    expect(() => aliceRing.seal(rumor('2'), bob.pubkey, undefined, { kind: 1059, tags: [] })).not.toThrow();
  });
});

describe('安全審查修正（ADR 0010 §5）', () => {
  it('🔴 #9 釘選過的對方發了我們不認得的新版公告 → 不默默退回身分金鑰（會失去前向保密）', () => {
    const { bob, aliceRing, bobRing } = people();
    aliceRing.seal(rumor('1'), bob.pubkey, bobRing.buildAnnounce(), { kind: 1059, tags: [] });
    const newer = bob.sign({ kind: EK_ANNOUNCE_KIND, created_at: 1_800_000_100, tags: [], content: JSON.stringify({ v: 9, ek: 'x' }) });
    expect(() => aliceRing.seal(rumor('2'), bob.pubkey, newer, { kind: 1059, tags: [] })).toThrow(PeerUpgradedError);
  });

  it('#10 收件端也看得出「這個人本來會用 EK，這次卻封給身分金鑰」', () => {
    const { alice, bob, aliceRing, bobRing } = people();
    aliceRing.seal(rumor('1'), bob.pubkey, bobRing.buildAnnounce(), { kind: 1059, tags: [] }); // Alice 釘選了 Bob
    const toAliceIdentity = bobRing.seal(rumor('2'), alice.pubkey, undefined, { kind: 1059, tags: [] });
    const opened = aliceRing.open(toAliceIdentity);
    expect(opened.via).toBe('identity');
    expect(opened.senderPinned).toBe(true);
  });

  it('#12 還原時驗證：時間不是有限數、後量子種子壞掉 → 丟例外', () => {
    const { bob, bobRing } = people();
    const state = JSON.parse(bobRing.exportState()) as { keys: { at: number; pq?: string }[] };
    const withAt = JSON.stringify({ ...state, keys: [{ ...state.keys[0], at: null }] });
    expect(() => CinderEkKeyring.fromState(bob, withAt)).toThrow();
    const withBadSeed = JSON.stringify({ ...state, keys: [{ ...state.keys[0], pq: 'bad' }] });
    expect(() => CinderEkKeyring.fromState(bob, withBadSeed)).toThrow();
  });

  it('🔴 #12 比先前看過的還舊的公告（中繼重放）→ 拒絕，不把訊息封給已刪掉的舊 EK', () => {
    const time = clock();
    const alice = Identity.generate();
    const bob = Identity.generate();
    const ring = CinderEkKeyring.create(alice, { now: time.now });
    const bobRing = CinderEkKeyring.create(bob, { now: time.now });
    const old = bobRing.buildAnnounce();
    time.advance(8 * DAY);
    bobRing.rotateIfDue();
    const fresh = bobRing.buildAnnounce();
    ring.seal(rumor('1'), bob.pubkey, fresh, { kind: 1059, tags: [] });
    expect(() => ring.seal(rumor('2'), bob.pubkey, old, { kind: 1059, tags: [] })).toThrow(/舊/);
  });
});
