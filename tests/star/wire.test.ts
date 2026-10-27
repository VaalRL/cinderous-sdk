// 星狀會話的線路格式與邀請字串（SDK ADR 0030 §2、§3）。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { InviteBook, encodeStarInvite, isStarInviteExpired, parseStarInvite, StarInviteError } from '../../src/star/invite.js';
import {
  decodeDeliver,
  decodeJoin,
  decodePacket,
  decodeRoster,
  decodeSend,
  decodeWelcome,
  encodeDeliver,
  encodeJoin,
  encodeJson,
  encodePacket,
  encodeRoster,
  encodeSend,
  RecordType,
  sanitizeStarLabel,
  STAR_LABEL_MAX_BYTES,
  STAR_MAGIC,
} from '../../src/star/wire.js';
import { rng } from './helpers.js';

const pk = () => Identity.generate().pubkey;

describe('封包', () => {
  it('來回編解碼；標記 0xC5 與 StreamTransfer（0xCB）、FileTransfer（0xCF）不同', () => {
    const records = [encodeJoin(new Uint8Array(16).fill(7), '小明'), { type: RecordType.Leave, body: new Uint8Array(0) }];
    const bytes = encodePacket(true, 42, 41, records);
    expect(bytes[0]).toBe(STAR_MAGIC);
    expect([0xcb, 0xcf]).not.toContain(STAR_MAGIC);
    const p = decodePacket(bytes)!;
    expect(p).toMatchObject({ sequenced: true, lseq: 42, ack: 41 });
    expect(p.records.map((r) => r.type)).toEqual([RecordType.Join, RecordType.Leave]);
    expect(decodeJoin(p.records[0]!.body)).toEqual({ secret: new Uint8Array(16).fill(7), label: '小明' });
  });

  it('格式不對一律回 null：旗標、序號與旗標不一致、長度越界', () => {
    const good = encodePacket(true, 1, 0, [{ type: 6, body: new Uint8Array(3) }]);
    const badFlag = good.slice();
    badFlag[2] = 0x82;
    expect(decodePacket(badFlag)).toBeNull();
    expect(decodePacket(encodePacket(false, 5, 0, []))).toBeNull(); // 無序號卻帶 lseq
    const truncated = good.slice(0, good.length - 1);
    expect(decodePacket(truncated)).toBeNull();
    expect(decodePacket(new Uint8Array([STAR_MAGIC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // 版本
  });

  it('隨機位元組（固定種子）：解碼從不拋例外', () => {
    const r = rng(7);
    for (let i = 0; i < 3_000; i += 1) {
      const len = Math.floor(r() * 80);
      const bytes = new Uint8Array(len).map(() => Math.floor(r() * 256));
      if (len > 1 && r() < 0.5) {
        bytes[0] = STAR_MAGIC;
        bytes[1] = 1;
      }
      expect(() => {
        const p = decodePacket(bytes);
        for (const rec of p?.records ?? []) {
          decodeJoin(rec.body);
          decodeSend(rec.body);
          decodeDeliver(rec.body);
          decodeRoster(rec.body);
          decodeWelcome(rec.body);
        }
      }).not.toThrow();
    }
  });
});

describe('紀錄', () => {
  it('SEND：廣播不帶收件人；單播帶；沒有寄件人欄位', () => {
    const to = [pk(), pk()];
    const s = decodeSend(encodeSend({ payload: new Uint8Array([1, 2]), topic: 3, volatile: true, echo: true, to }).body)!;
    expect(s).toMatchObject({ topic: 3, volatile: true, echo: true, to });
    expect(decodeSend(encodeSend({ payload: new Uint8Array(0), topic: 0, volatile: false, echo: false, to: undefined }).body)!.to).toBeUndefined();
    expect(Object.keys(s)).not.toContain('from');
  });

  it('DELIVER／ROSTER：序號可到 2^53', () => {
    const from = pk();
    const seq = Number.MAX_SAFE_INTEGER;
    expect(decodeDeliver(encodeDeliver({ seq, from, unicast: true, volatile: false, topic: 9, payload: new Uint8Array([5]) }).body)).toMatchObject({ seq, from, unicast: true, topic: 9 });
    expect(decodeRoster(encodeRoster({ seq: 3, event: 'left', pubkey: from, reason: 'kicked', label: undefined }).body)).toMatchObject({ seq: 3, event: 'left', reason: 'kicked' });
    expect(decodeDeliver(encodeDeliver({ seq: 0 as number, from, unicast: false, volatile: false, topic: 0, payload: new Uint8Array() }).body)).toBeNull();
  });

  it('WELCOME 驗證每個欄位', () => {
    const w = { session: 'a'.repeat(32), host: pk(), you: pk(), next: 2, members: [{ pubkey: pk(), label: 'x' }], maxPayloadBytes: 100 };
    expect(decodeWelcome(encodeJson(RecordType.Welcome, w).body)).toEqual(w);
    expect(decodeWelcome(encodeJson(RecordType.Welcome, { ...w, next: 0 }).body)).toBeNull();
    expect(decodeWelcome(encodeJson(RecordType.Welcome, { ...w, host: 'zz' }).body)).toBeNull();
    expect(decodeWelcome(encodeJson(RecordType.Welcome, { ...w, members: [{ pubkey: 1 }] }).body)).toBeNull();
  });

  it('名稱：去掉控制字元與方向覆寫字元，截到 64 位元組', () => {
    expect(sanitizeStarLabel('a‮b\u0000c')).toBe('abc');
    const long = sanitizeStarLabel('咖'.repeat(40))!;
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(STAR_LABEL_MAX_BYTES);
    expect(sanitizeStarLabel('   ')).toBeUndefined();
  });
});

describe('邀請字串', () => {
  const host = pk();
  it('來回；中繼最多 3 座、wss:// 省略', () => {
    const secret = new Uint8Array(16).fill(1);
    const uri = encodeStarInvite({ host, secret, expiresAt: 2_000_000_000, relays: ['wss://a.example', 'wss://b.example/app/coffice', 'ws://127.0.0.1:7777', 'wss://d.example'] });
    expect(uri.startsWith('cinderous-star:1.')).toBe(true);
    const parsed = parseStarInvite(uri);
    expect(parsed).toEqual({ host, secret, expiresAt: 2_000_000_000, relays: ['wss://a.example', 'wss://b.example/app/coffice', 'ws://127.0.0.1:7777'] });
  });

  it('格式不對丟 StarInviteError；配對 QR 不會被誤認', () => {
    for (const bad of ['', 'cinderous-pair:1.xxx.relay', 'cinderous-star:2.abc.relay', 'cinderous-star:1.!!!.relay', `cinderous-star:1.${'A'.repeat(71)}.relay`]) {
      expect(() => parseStarInvite(bad), bad).toThrow(StarInviteError);
    }
  });

  it('到期判斷', () => {
    expect(isStarInviteExpired({ expiresAt: 100 }, 99_999)).toBe(false);
    expect(isStarInviteExpired({ expiresAt: 100 }, 100_000)).toBe(true);
  });
});

describe('InviteBook', () => {
  it('一次性、可用多次、撤銷、過期、綁定公鑰、只存雜湊', () => {
    let now = 1_000_000;
    const book = new InviteBook(pk(), () => now);
    const secretOf = (uri: string) => parseStarInvite(uri).secret;
    const once = book.create({ relays: ['wss://r.example'] }, 16);
    const me = pk();
    expect(book.redeem(secretOf(once.uri), me)).toMatchObject({ ok: true });
    expect(book.redeem(secretOf(once.uri), me)).toEqual({ ok: false, reason: 'used' });

    const twice = book.create({ relays: ['wss://r.example'], maxUses: 2 }, 16);
    expect(book.redeem(secretOf(twice.uri), pk()).ok).toBe(true);
    book.revoke(twice.id);
    expect(book.redeem(secretOf(twice.uri), pk())).toEqual({ ok: false, reason: 'revoked' });

    const short = book.create({ relays: ['wss://r.example'], ttlMs: 1_000 }, 16);
    now += 1_000;
    expect(book.redeem(secretOf(short.uri), pk())).toEqual({ ok: false, reason: 'expired' });

    const bound = pk();
    const forOne = book.create({ relays: ['wss://r.example'], forPubkey: bound }, 16);
    expect(book.redeem(secretOf(forOne.uri), pk())).toEqual({ ok: false, reason: 'invalid-invite' });
    expect(book.redeem(secretOf(forOne.uri), bound).ok).toBe(true);

    expect(JSON.stringify(book.list())).not.toContain(Buffer.from(secretOf(forOne.uri)).toString('hex'));
  });

  it('參數檢查：有效期上限 24 小時、次數上限＝成員上限', () => {
    const book = new InviteBook(pk(), () => 0);
    expect(() => book.create({ relays: ['wss://r.example'], ttlMs: 25 * 3_600_000 }, 16)).toThrow(StarInviteError);
    expect(() => book.create({ relays: ['wss://r.example'], maxUses: 17 }, 16)).toThrow(StarInviteError);
    expect(() => book.create({ relays: ['wss://r.example'], forPubkey: 'nope' }, 16)).toThrow(StarInviteError);
    expect(() => book.create({ relays: ['https://not-a-relay'] }, 16)).toThrow(StarInviteError);
  });
});
