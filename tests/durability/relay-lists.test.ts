// NIP-65（kind 10002）與 NIP-17（kind 10050）中繼清單（SDK ADR 0038 決策 7；ADR 0041 §5）。
import type { Event } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  DM_RELAY_LIST_KIND,
  dmRelayListTemplate,
  dmRelaysFor,
  latestRelayLists,
  normalizeRelayUrl,
  outboxRelaysFor,
  parseDmRelayList,
  parseRelayList,
  RELAY_LIST_KIND,
  relayListFilter,
  relayListTemplate,
  relayListWithStandby,
} from '../../src/durability/index.js';
import { Identity } from '../../src/identity.js';

const alice = Identity.generate();
const bob = Identity.generate();

describe('NIP-65：kind 10002', () => {
  it('建立：兩者皆是不帶標記、只讀／只寫帶標記；合併重複、丟掉不合法的網址；簽得起來', () => {
    const template = relayListTemplate(
      ['wss://A.example/', { url: 'wss://read.example', write: false }, { url: 'wss://write.example', read: false }, 'https://not-a-relay', 'wss://a.example'],
      { createdAt: 1_700_000_000 },
    );
    expect(template).toEqual({
      kind: RELAY_LIST_KIND,
      created_at: 1_700_000_000,
      tags: [
        ['r', 'wss://a.example'],
        ['r', 'wss://read.example', 'read'],
        ['r', 'wss://write.example', 'write'],
      ],
      content: '',
    });
    expect(verifyEvent(alice.sign(template) as Event)).toBe(true);
  });

  it('解析：read／write 清單；不是 10002 回 null', () => {
    const parsed = parseRelayList({
      kind: 10002,
      tags: [['r', 'wss://both.example'], ['r', 'wss://r.example', 'read'], ['r', 'wss://w.example', 'write'], ['r', 'nope'], ['p', 'x']],
    });
    expect(parsed).toEqual({
      entries: [
        { url: 'wss://both.example', read: true, write: true },
        { url: 'wss://r.example', read: true, write: false },
        { url: 'wss://w.example', read: false, write: true },
      ],
      read: ['wss://both.example', 'wss://r.example'],
      write: ['wss://both.example', 'wss://w.example'],
    });
    expect(parseRelayList({ kind: 1, tags: [] })).toBeNull();
  });

  it('把備援事先列進清單（都標 write，別的裝置讀你時會合併）', () => {
    const parsed = parseRelayList(relayListWithStandby(['wss://main.example'], ['wss://standby.example'], { standbyRead: false }))!;
    expect(parsed.write).toEqual(['wss://main.example', 'wss://standby.example']);
    expect(parsed.read).toEqual(['wss://main.example']);
  });

  it('網址正規化：保留車道路徑、去尾端斜線；拒絕非 ws(s) 與帶帳密的', () => {
    expect(normalizeRelayUrl('wss://Relay.Example/app/dochost/')).toBe('wss://relay.example/app/dochost');
    expect(normalizeRelayUrl('ws://localhost:8787')).toBe('ws://localhost:8787');
    expect(normalizeRelayUrl('https://relay.example')).toBeUndefined();
    expect(normalizeRelayUrl('wss://u:p@relay.example')).toBeUndefined();
    expect(normalizeRelayUrl('不是網址')).toBeUndefined();
  });
});

describe('NIP-17：kind 10050', () => {
  it('建立與解析', () => {
    const template = dmRelayListTemplate(['wss://inbox.example', 'wss://inbox.example/', 'bad'], { createdAt: 5 });
    expect(template).toEqual({ kind: DM_RELAY_LIST_KIND, created_at: 5, tags: [['relay', 'wss://inbox.example']], content: '' });
    expect(parseDmRelayList(template)).toEqual(['wss://inbox.example']);
    expect(parseDmRelayList({ kind: 10002, tags: [] })).toBeNull();
  });
});

describe('讀對方的清單，決定寄往哪裡', () => {
  it('每人每種只留最新的；私訊寄 10050，沒有就 none（可選退回 10002 read）；讀作者去 write', () => {
    const events = [
      alice.sign(relayListTemplate(['wss://old.example'], { createdAt: 1 })),
      alice.sign(relayListTemplate([{ url: 'wss://a-out.example', read: false }, { url: 'wss://a-in.example', write: false }], { createdAt: 2 })),
      alice.sign(dmRelayListTemplate(['wss://a-dm.example'], { createdAt: 3 })),
      bob.sign(relayListTemplate([{ url: 'wss://b-in.example', write: false }], { createdAt: 4 })),
    ] as Event[];
    const lists = latestRelayLists(events);
    expect(outboxRelaysFor(lists.get(alice.pubkey))).toEqual(['wss://a-out.example']);
    expect(dmRelaysFor(lists.get(alice.pubkey))).toEqual({ relays: ['wss://a-dm.example'], source: 'nip17' });
    expect(dmRelaysFor(lists.get(bob.pubkey))).toEqual({ relays: [], source: 'none' });
    expect(dmRelaysFor(lists.get(bob.pubkey), { fallbackToRead: true })).toEqual({ relays: ['wss://b-in.example'], source: 'nip65-read' });
    expect(dmRelaysFor(undefined)).toEqual({ relays: [], source: 'none' });
    expect(relayListFilter([alice.pubkey])).toEqual({ kinds: [10002, 10050], authors: [alice.pubkey] });
  });
});
