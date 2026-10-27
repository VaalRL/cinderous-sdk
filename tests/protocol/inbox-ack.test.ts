import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { finalizeEvent, verifyEvent } from "../../src/protocol/sign.js";
import {
  buildInboxAck,
  INBOX_ACK_KIND,
  INBOX_ACK_MAX_IDS,
  inboxAckIdsOf,
} from "../../src/protocol/inbox-ack.js";

const sk = generateSecretKey();
const id = (n: number): string => n.toString(16).padStart(64, "0");

describe("收件確認事件（SDK ADR 0067 §1）", () => {
  it("建構：瞬時 kind、本人簽章、content 是逗號分隔的外層 id、不帶任何標籤", () => {
    const evt = buildInboxAck([id(1), id(2)], sk, { created_at: 1000 });
    expect(evt.kind).toBe(INBOX_ACK_KIND);
    expect(INBOX_ACK_KIND).toBeGreaterThanOrEqual(20000);
    expect(INBOX_ACK_KIND).toBeLessThan(30000);
    expect(evt.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(evt)).toBe(true);
    expect(evt.content).toBe(`${id(1)},${id(2)}`);
    expect(evt.tags).toEqual([]);
    expect(inboxAckIdsOf(evt)).toEqual([id(1), id(2)]);
  });

  it("重複的 id 只留一個", () => {
    expect(inboxAckIdsOf(buildInboxAck([id(1), id(1), id(2)], sk))).toEqual([id(1), id(2)]);
  });

  it("一則最多 500 個；空的或超過都不建", () => {
    expect(INBOX_ACK_MAX_IDS).toBe(500);
    const many = Array.from({ length: INBOX_ACK_MAX_IDS }, (_, i) => id(i));
    expect(inboxAckIdsOf(buildInboxAck(many, sk))).toHaveLength(INBOX_ACK_MAX_IDS);
    expect(() => buildInboxAck([...many, id(9999)], sk)).toThrow();
    expect(() => buildInboxAck([], sk)).toThrow();
  });

  it("建構時拒絕不是 64 位小寫 hex 的 id", () => {
    expect(() => buildInboxAck(["abc"], sk)).toThrow();
    expect(() => buildInboxAck(["AB".repeat(32)], sk)).toThrow();
  });

  describe("解析（中繼端用）：格式不對一律回 null", () => {
    const signed = (content: string, kind = INBOX_ACK_KIND) =>
      finalizeEvent({ kind, created_at: 1000, tags: [], content }, sk);

    it("kind 不對", () => {
      expect(inboxAckIdsOf(signed(id(1), 25191))).toBeNull();
    });

    it("空的 content", () => {
      expect(inboxAckIdsOf(signed(""))).toBeNull();
    });

    it("有一個 id 格式不對（含大寫、長度、空段）", () => {
      expect(inboxAckIdsOf(signed(`${id(1)},xyz`))).toBeNull();
      expect(inboxAckIdsOf(signed("AB".repeat(32)))).toBeNull();
      expect(inboxAckIdsOf(signed(`${id(1)},,${id(2)}`))).toBeNull();
      expect(inboxAckIdsOf(signed(` ${id(1)}`))).toBeNull();
    });

    it("超過 500 個", () => {
      const ids = Array.from({ length: INBOX_ACK_MAX_IDS + 1 }, (_, i) => id(i));
      expect(inboxAckIdsOf(signed(ids.join(",")))).toBeNull();
    });
  });
});
