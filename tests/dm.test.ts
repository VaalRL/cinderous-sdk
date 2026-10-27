import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import * as nip59 from 'nostr-tools/nip59';
import { describe, expect, it } from 'vitest';

import {
  DirectMessages,
  DM_MAX_CHARS,
  DM_WRAP_KIND,
  unwrapDm,
  wrapDm,
  type ChatStorage,
  type DmThread,
  DEFAULT_DM_STORAGE_KEY,
} from '../src/dm.js';
import { Blocklist, DEFAULT_BLOCKLIST_STORAGE_KEY } from '../src/blocklist.js';
import { Identity } from '../src/identity.js';
import { FakeTransport } from './fake-transport.js';

const NOW_SEC = 1_790_000_000;
const TWO_DAYS = 2 * 24 * 60 * 60;

function withKey(): { identity: Identity; secretKey: Uint8Array } {
  const secretKey = generateSecretKey();
  return { identity: Identity.fromNsec(nip19.nsecEncode(secretKey)), secretKey };
}

function memoryStorage(): ChatStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('NIP-17 私訊封裝（ADR 0025）', () => {
  it('一份 rumor 封兩次：給對方一份、給自己一份；外層只有 p 標籤、一次性金鑰、時間往前倒填不超過 2 天', () => {
    const alice = Identity.generate();
    const bob = Identity.generate();
    const wraps = wrapDm({
      identity: alice,
      to: bob.pubkey,
      text: '晚點下一盤？',
      nowSec: NOW_SEC,
    });
    expect(wraps).toHaveLength(2);
    expect(wraps.map((wrap) => wrap.tags)).toEqual([[['p', bob.pubkey]], [['p', alice.pubkey]]]);
    for (const wrap of wraps) {
      expect(wrap.kind).toBe(DM_WRAP_KIND);
      expect([alice.pubkey, bob.pubkey]).not.toContain(wrap.pubkey);
      expect(wrap.created_at).toBeLessThanOrEqual(NOW_SEC);
      expect(wrap.created_at).toBeGreaterThanOrEqual(NOW_SEC - TWO_DAYS);
    }
    const received = unwrapDm(bob, wraps[0]!);
    const own = unwrapDm(alice, wraps[1]!);
    expect(received).toEqual({
      id: own?.id,
      peer: alice.pubkey,
      text: '晚點下一盤？',
      at: NOW_SEC,
      mine: false,
    });
    expect(own).toMatchObject({ peer: bob.pubkey, text: '晚點下一盤？', mine: true });
    // 不是給自己的那份解不開
    expect(unwrapDm(bob, wraps[1]!)).toBeNull();
    expect(unwrapDm(Identity.generate(), wraps[0]!)).toBeNull();
  });

  it('跟 nostr-tools 的 NIP-17 雙向互通', () => {
    const alice = withKey();
    const bob = withKey();
    const ours = wrapDm({
      identity: alice.identity,
      to: bob.identity.pubkey,
      text: '互通',
      nowSec: NOW_SEC,
    });
    expect(nip17.unwrapEvent(ours[0]!, bob.secretKey)).toMatchObject({
      kind: 14,
      pubkey: alice.identity.pubkey,
      content: '互通',
    });
    const theirs = nip17.wrapEvent(alice.secretKey, { publicKey: bob.identity.pubkey }, '反向');
    expect(unwrapDm(bob.identity, theirs)).toMatchObject({
      peer: getPublicKey(alice.secretKey),
      text: '反向',
      mine: false,
    });
  });

  it('空白與超過字數不封', () => {
    const alice = Identity.generate();
    expect(() =>
      wrapDm({ identity: alice, to: alice.pubkey, text: '  ', nowSec: NOW_SEC }),
    ).toThrow();
    expect(() =>
      wrapDm({
        identity: alice,
        to: alice.pubkey,
        text: 'x'.repeat(DM_MAX_CHARS + 1),
        nowSec: NOW_SEC,
      }),
    ).toThrow();
  });

  it('seal 的簽章者跟 rumor 作者不同（冒名）就丟掉', () => {
    const alice = withKey();
    const bob = Identity.generate();
    const mallory = generateSecretKey();
    // rumor 寫 alice，seal 卻是 mallory 簽的
    const rumor = nip59.createRumor(
      { kind: 14, content: '我是 alice', tags: [['p', bob.pubkey]], created_at: NOW_SEC },
      alice.secretKey,
    );
    const forged = nip59.createWrap(nip59.createSeal(rumor, mallory, bob.pubkey), bob.pubkey);
    expect(unwrapDm(bob, forged!)).toBeNull();
  });
});

describe('DirectMessages', () => {
  function setup(storage = memoryStorage()) {
    const transport = new FakeTransport();
    const me = Identity.generate();
    const blocked = new Set<string>();
    const dms = new DirectMessages({
      transport,
      identity: me,
      now: () => NOW_SEC * 1000,
      storage,
      isBlocked: (pubkey) => blocked.has(pubkey),
    });
    return { transport, me, dms, storage, blocked };
  }

  it('收件匣只訂 kind 1059 的 #p 自己，往回看 7 天（Relay 保存期）', () => {
    const { transport, me, dms } = setup();
    const stop = dms.watch(() => undefined);
    expect(transport.subscriptions[0]?.filters).toEqual([
      { kinds: [DM_WRAP_KIND], '#p': [me.pubkey], since: NOW_SEC - 7 * 24 * 60 * 60 },
    ]);
    stop();
    expect(transport.subscriptions[0]?.closed).toBe(true);
  });

  it('送出：發兩份封裝、本機立刻記一則；自己那份回來不重複；對方回信併進同一段對話並存起來', async () => {
    const { transport, me, dms, storage } = setup();
    const bob = Identity.generate();
    const seen: (readonly DmThread[])[] = [];
    dms.watch((threads) => seen.push(threads));
    expect(await dms.send(bob.pubkey, '嗨')).toEqual({ ok: true, message: '', accepted: ['wss://fake'], rejected: [] });
    expect(transport.published).toHaveLength(2);
    for (const wrap of transport.published) transport.deliver(wrap);
    const [reply] = wrapDm({ identity: bob, to: me.pubkey, text: '嗨嗨', nowSec: NOW_SEC + 1 });
    transport.deliver(reply!);
    transport.deliver(reply!);
    const threads = dms.threads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.peer).toBe(bob.pubkey);
    expect(threads[0]?.lines.map((line) => [line.text, line.mine])).toEqual([
      ['嗨', true],
      ['嗨嗨', false],
    ]);
    expect(seen.at(-1)).toEqual(threads);
    // 重開（同一個 storage）還在
    const again = new DirectMessages({ transport, identity: me, storage });
    expect(again.threads()).toEqual(threads);
  });

  it('全部 Relay 拒收就回失敗；封鎖的人的私訊不收', async () => {
    const { transport, me, dms, blocked } = setup();
    const bob = Identity.generate();
    dms.watch(() => undefined);
    transport.accepted = [];
    expect((await dms.send(bob.pubkey, '嗨')).ok).toBe(false);
    blocked.add(bob.pubkey);
    dms.forget(bob.pubkey);
    const [wrap] = wrapDm({ identity: bob, to: me.pubkey, text: '廣告', nowSec: NOW_SEC });
    transport.deliver(wrap!);
    expect(dms.threads()).toEqual([]);
  });
});

describe('儲存鍵（SDK ADR 0001）', () => {
  it('預設鍵是 cinderous:dm:threads；已上線的應用可以沿用自己原本的鍵', async () => {
    const storage = memoryStorage();
    const transport = new FakeTransport();
    const me = Identity.generate();
    const bob = Identity.generate();
    const dms = new DirectMessages({ transport, identity: me, storage, now: () => NOW_SEC * 1000 });
    await dms.send(bob.pubkey, '嗨');
    expect([...storage.data.keys()]).toEqual([DEFAULT_DM_STORAGE_KEY]);

    const legacy = memoryStorage();
    legacy.setItem('nagd:dm:threads', storage.data.get(DEFAULT_DM_STORAGE_KEY)!);
    const reopened = new DirectMessages({ transport, identity: me, storage: legacy, storageKey: 'nagd:dm:threads' });
    expect(reopened.threads()).toHaveLength(1);
  });

  it('封鎖名單同樣可指定鍵', () => {
    const storage = memoryStorage();
    new Blocklist(storage).add('a'.repeat(64));
    expect([...storage.data.keys()]).toEqual([DEFAULT_BLOCKLIST_STORAGE_KEY]);
    const legacy = memoryStorage();
    legacy.setItem('soleague.chat.blocked', JSON.stringify(['b'.repeat(64)]));
    expect(new Blocklist(legacy, 'soleague.chat.blocked').has('b'.repeat(64))).toBe(true);
  });
});
