import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
} from "../../src/protocol/index.js";
import { getExpiration, MessageStore } from "../../src/relay/message-store.js";

const recipient = getPublicKey(generateSecretKey());

/** 製作一筆已簽章的離線留言（kind 1059 Gift Wrap），可帶 NIP-40 過期。 */
function giftWrap(opts: { to?: string; created_at?: number; expiration?: number } = {}): NostrEvent {
  const tags: string[][] = [["p", opts.to ?? recipient]];
  if (opts.expiration !== undefined) tags.push(["expiration", String(opts.expiration)]);
  return finalizeEvent(
    { kind: 1059, created_at: opts.created_at ?? 1000, tags, content: "x" },
    generateSecretKey(),
  );
}

describe("NIP-40 過期解析", () => {
  it("讀取 expiration 標籤為秒數", () => {
    expect(getExpiration(giftWrap({ expiration: 1234 }))).toBe(1234);
  });
  it("無 expiration 標籤回 undefined", () => {
    expect(getExpiration(giftWrap())).toBeUndefined();
  });
});

describe("MessageStore — 離線留言儲存與過期", () => {
  it("寫入後可依 #p 收件人查詢", () => {
    const store = new MessageStore();
    const e = giftWrap();
    expect(store.put(e, 100)).toBe(true);
    expect(store.query({ kinds: [1059], "#p": [recipient] }, 100)).toEqual([e]);
    expect(store.query({ "#p": ["ff".repeat(32)] }, 100)).toEqual([]);
  });

  it("已過期的事件不予寫入", () => {
    const store = new MessageStore();
    expect(store.put(giftWrap({ expiration: 50 }), 100)).toBe(false);
    expect(store.query({ "#p": [recipient] }, 100)).toEqual([]);
  });

  it("查詢時略過已過期、prune 會清除之", () => {
    const store = new MessageStore();
    const e = giftWrap({ expiration: 200 });
    store.put(e, 100);
    expect(store.query({ "#p": [recipient] }, 199)).toEqual([e]);
    expect(store.query({ "#p": [recipient] }, 201)).toEqual([]);
    store.prune(201);
    expect(store.query({ "#p": [recipient] }, 150)).toEqual([]);
  });

  it("不帶 #p 的查詢仍可依 kind 取得（含無收件人事件的全掃備援）", () => {
    const store = new MessageStore();
    const withRecipient = giftWrap();
    const noRecipient = finalizeEvent(
      { kind: 1, created_at: 1, tags: [], content: "hi" },
      generateSecretKey(),
    );
    store.put(withRecipient, 0);
    store.put(noRecipient, 0);
    expect(store.query({ kinds: [1] }, 0)).toEqual([noRecipient]);
    expect(store.query({ kinds: [1059] }, 0)).toEqual([withRecipient]);
  });

  it("超過每收件人上限時丟棄最舊", () => {
    const store = new MessageStore({ maxPerRecipient: 2 });
    const e1 = giftWrap({ created_at: 1 });
    const e2 = giftWrap({ created_at: 2 });
    const e3 = giftWrap({ created_at: 3 });
    store.put(e1, 0);
    store.put(e2, 0);
    store.put(e3, 0);
    const got = store.query({ "#p": [recipient] }, 0);
    expect(got).toHaveLength(2);
    expect(got.map((e) => e.created_at).sort()).toEqual([2, 3]);
  });
});

describe("壽命上限（ADR-0065：孤兒資料不可能）", () => {
  const WEEK = 7 * 86_400;

  it("無 expiration 的事件套預設 TTL：7 天後不返回且 prune 收走", () => {
    const store = new MessageStore();
    store.put(giftWrap(), 1000); // 無 expiration
    expect(store.query({ "#p": [recipient] }, 1000)).toHaveLength(1);
    expect(store.query({ "#p": [recipient] }, 1000 + WEEK + 1)).toHaveLength(0);
    store.prune(1000 + WEEK + 1);
    expect(store.query({ "#p": [recipient] }, 1000)).toHaveLength(0);
  });

  it("惡意超長 expiration 被截到上限（7 天）", () => {
    const store = new MessageStore();
    store.put(giftWrap({ expiration: 999_999_999 }), 1000);
    expect(store.query({ "#p": [recipient] }, 1000 + WEEK + 1)).toHaveLength(0);
  });
});

describe("可尋址事件（NIP-33，ADR-0071 快照）", () => {
  const authorSk = generateSecretKey();
  const author = getPublicKey(authorSk);
  const snap = (opts: { d?: string; content?: string; createdAt?: number; sk?: Uint8Array } = {}): NostrEvent =>
    finalizeEvent(
      {
        kind: 30078,
        created_at: opts.createdAt ?? 1000,
        tags: [["d", opts.d ?? "dev1"]],
        content: opts.content ?? "密文快照",
      },
      opts.sk ?? authorSk,
    );

  it("取代語意：同 (kind,pubkey,d) 只留最新；不同 d 並存；較舊 created_at 拒收", () => {
    const store = new MessageStore();
    expect(store.putAddressable(snap({ createdAt: 1000, content: "v1" }), 1000)).toBe(true);
    expect(store.putAddressable(snap({ createdAt: 2000, content: "v2" }), 2000)).toBe(true);
    expect(store.putAddressable(snap({ d: "dev2", createdAt: 1500 }), 1500)).toBe(true);
    const got = store.query({ kinds: [30078], authors: [author] }, 2000);
    expect(got).toHaveLength(2); // dev1 最新 + dev2
    expect(got.find((e) => e.tags.some((t) => t[1] === "dev1"))?.content).toBe("v2");
    // 較舊的回寫被拒（只留最新）
    expect(store.putAddressable(snap({ createdAt: 500, content: "stale" }), 2100)).toBe(false);
  });

  it("purge：content 空＝刪除既有快照", () => {
    const store = new MessageStore();
    store.putAddressable(snap({ createdAt: 1000 }), 1000);
    expect(store.putAddressable(snap({ createdAt: 2000, content: "" }), 2000)).toBe(true);
    expect(store.query({ kinds: [30078], authors: [author] }, 2000)).toHaveLength(0);
  });

  it("purge 只限快照（Cinderous ADR-0382 §7；SDK ADR 0083）：NIP-17 10050、NIP-65 10002、NIP-02 kind 3 依規格 content 本來就是空的，照常存、查得到、取代", () => {
    const store = new MessageStore();
    const list = (kind: number, createdAt: number, tags: string[][]): NostrEvent =>
      finalizeEvent({ kind, created_at: createdAt, tags, content: "" }, authorSk);
    for (const kind of [10050, 10002, 3]) {
      expect(store.putAddressable(list(kind, 1000, [["relay", "wss://a.example/s/1"]]), 1000)).toBe(true);
      expect(store.query({ kinds: [kind], authors: [author] }, 1000)).toHaveLength(1);
      // 較新的一顆（同樣空 content）取代舊的，不是把它刪掉
      expect(store.putAddressable(list(kind, 2000, [["relay", "wss://b.example/s/1"]]), 2000)).toBe(true);
      const got = store.query({ kinds: [kind], authors: [author] }, 2000);
      expect(got.map((e) => e.tags[0]?.[1])).toEqual(["wss://b.example/s/1"]);
    }
  });

  it("配額：每 (pubkey, kind) 至多 5 個 d；單顆超過 256KB 拒收", () => {
    const store = new MessageStore();
    for (let i = 1; i <= 5; i++) {
      expect(store.putAddressable(snap({ d: `dev${i}` }), 1000)).toBe(true);
    }
    expect(store.putAddressable(snap({ d: "dev6" }), 1000)).toBe(false); // 第 6 台拒收
    expect(store.putAddressable(snap({ d: "dev1", createdAt: 2000 }), 2000)).toBe(true); // 既有位址可更新
    expect(store.putAddressable(snap({ d: "dev1", createdAt: 3000, content: "x".repeat(300_000) }), 3000)).toBe(false);
  });

  it("壽命：30 天上限、每次備份刷新；到期後查不到且 prune 收走", () => {
    const MONTH = 30 * 86_400;
    const store = new MessageStore();
    store.putAddressable(snap({ createdAt: 1000 }), 1000);
    expect(store.query({ kinds: [30078], authors: [author] }, 1000 + MONTH + 1)).toHaveLength(0);
    // 刷新（重新備份）＝延壽
    store.putAddressable(snap({ createdAt: MONTH }), MONTH);
    expect(store.query({ kinds: [30078], authors: [author] }, MONTH + 100)).toHaveLength(1);
    store.prune(MONTH * 3);
    expect(store.query({ kinds: [30078], authors: [author] }, 1000)).toHaveLength(0);
  });
});

describe("可取代事件（NIP-01 10000–19999；ADR-0035）", () => {
  const maintainerSk = generateSecretKey();
  const maintainer = getPublicKey(maintainerSk);
  /** 簽章 relay 清單（kind 10037）——health-check cron 每小時發佈一次。 */
  const relayList = (createdAt: number, content = "list", sk = maintainerSk): NostrEvent =>
    finalizeEvent({ kind: 10037, created_at: createdAt, tags: [], content }, sk);

  it("取代語意：每 (kind, pubkey) 只留最新一顆——cron 連發不再累積", () => {
    const store = new MessageStore();
    // 模擬 cron 每小時發佈 24 次（過去這會囤 24 份重複）。
    for (let h = 0; h < 24; h += 1) {
      expect(store.putAddressable(relayList(1000 + h * 3600, `list-${h}`), 1000 + h * 3600)).toBe(true);
    }
    const got = store.query({ kinds: [10037], authors: [maintainer] }, 1000);
    expect(got.length).toBe(1); // ← 這正是修的東西：只剩最新一顆
    expect(got[0]?.content).toBe("list-23");
  });

  it("較舊的清單不覆蓋較新的（重放舊事件無效）", () => {
    const store = new MessageStore();
    expect(store.putAddressable(relayList(2000, "new"), 2000)).toBe(true);
    expect(store.putAddressable(relayList(1000, "old"), 2000)).toBe(false); // 拒收
    expect(store.query({ kinds: [10037] }, 2000)[0]?.content).toBe("new");
  });

  it("NIP-01 決勝：created_at 相同時保留 id 字典序較小者（各中繼站收斂到同一顆）", () => {
    const a = relayList(1000, "A");
    const b = relayList(1000, "B");
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    // 不論送入順序，最後留下的都是 id 較小者。
    const s1 = new MessageStore();
    s1.putAddressable(lo, 1000);
    s1.putAddressable(hi, 1000);
    expect(s1.query({ kinds: [10037] }, 1000)[0]?.id).toBe(lo.id);
    const s2 = new MessageStore();
    s2.putAddressable(hi, 1000);
    s2.putAddressable(lo, 1000);
    expect(s2.query({ kinds: [10037] }, 1000)[0]?.id).toBe(lo.id);
  });

  it("不同作者各留一顆（取代是 per-pubkey，不是全域）", () => {
    const store = new MessageStore();
    const otherSk = generateSecretKey();
    store.putAddressable(relayList(1000, "mine"), 1000);
    store.putAddressable(relayList(1000, "theirs", otherSk), 1000);
    expect(store.query({ kinds: [10037] }, 1000).length).toBe(2);
  });
});

describe("檔案塊獨立配額桶（ADR-0162）", () => {
  const mk = (id: string, kind: number, createdAt: number): NostrEvent =>
    ({ id, kind, created_at: createdAt, tags: [["p", "r1"], ["expiration", String(createdAt + 86_400)]], content: "", pubkey: "p", sig: "s" }) as NostrEvent;

  it("檔案塊（1060）灌爆自己的桶，不把聊天留言擠出 FIFO；聊天配額也不影響檔案塊", () => {
    const store = new MessageStore({ maxPerRecipient: 2, filePerRecipient: 3 });
    store.put(mk("c1", 1059, 1), 0);
    store.put(mk("c2", 1059, 2), 0);
    for (let i = 0; i < 5; i++) store.put(mk(`f${i}`, 1060, 10 + i), 0);
    const kept = store.query({ "#p": ["r1"] }, 5).map((e) => e.id).sort();
    // 聊天 2 則全留；檔案塊只留最新 3 顆（f2,f3,f4）。
    expect(kept).toEqual(["c1", "c2", "f2", "f3", "f4"]);
    // 再灌聊天：聊天桶 FIFO，檔案塊不受影響。
    store.put(mk("c3", 1059, 3), 0);
    const kept2 = store.query({ "#p": ["r1"] }, 5).map((e) => e.id).sort();
    expect(kept2).toEqual(["c2", "c3", "f2", "f3", "f4"]);
  });
});

describe("可尋址配額與 TTL 可設定（ADR-0366 P1 #7／#8）", () => {
  const addr = (pubkey: string, d: string, kind = 31081): NostrEvent =>
    ({ id: `${pubkey}-${d}`, pubkey, created_at: 1000, kind, tags: [["d", d]], content: "x", sig: "" }) as NostrEvent;

  it("預設仍是 5（ADR-0071 不受影響）", () => {
    const s = new MessageStore();
    for (let i = 0; i < 5; i++) expect(s.putAddressable(addr("a", `d${i}`), 1000)).toBe(true);
    expect(s.putAddressable(addr("a", "d5"), 1000)).toBe(false);
  });

  it("🔴 配額可放寬——第三方車道的牌組與快照不該在第 6 份被拒", () => {
    const s = new MessageStore({ addressablePerAuthor: 64 });
    for (let i = 0; i < 64; i++) expect(s.putAddressable(addr("a", `d${i}`), 1000), `第 ${i}`).toBe(true);
    expect(s.putAddressable(addr("a", "d64"), 1000)).toBe(false); // 仍然有界
  });

  it("TTL 可拉長——自架世界站的挑戰窗是營運參數，不是協定限制", () => {
    const s = new MessageStore({ addressableTtlSeconds: 90 * 86_400 });
    s.putAddressable(addr("a", "d"), 1000);
    // 預設 30 天會在此刻已過期；拉長到 90 天則仍查得到。
    expect(s.query({ authors: ["a"], kinds: [31081] } as never, 1000 + 60 * 86_400)).toHaveLength(1);
  });
});

describe("可尋址的兩道容量閘（ADR-0366 §容量二）", () => {
  /** 產一顆指定大小（序列化後約 bytes）的可尋址事件。 */
  const sized = (pubkey: string, d: string, bytes: number, kind = 31081): NostrEvent => {
    const shell = JSON.stringify({
      id: `${pubkey}-${kind}-${d}`,
      pubkey,
      created_at: 1000,
      kind,
      tags: [["d", d]],
      content: "",
      sig: "",
    }).length;
    return {
      id: `${pubkey}-${kind}-${d}`,
      pubkey,
      created_at: 1000,
      kind,
      tags: [["d", d]],
      content: "x".repeat(Math.max(0, bytes - shell)),
      sig: "",
    } as NostrEvent;
  };

  it("單顆上限可調小——車道的牌組只有幾 KB，沒有理由沿用加密快照的 256KB", () => {
    const s = new MessageStore({ addressableMaxBytes: 4_096, addressablePerAuthor: 64 });
    expect(s.putAddressable(sized("a", "ok", 4_000), 1000)).toBe(true);
    expect(s.putAddressable(sized("a", "toobig", 8_000), 1000)).toBe(false);
  });

  it("🔴 每作者總量上限：跨 kind 也算，因為 kind 是發送方自選的", () => {
    // 沒有這一條，「每 (pubkey, kind) 64 個」實際上等於「每人一萬 × 64 個」。
    const s = new MessageStore({
      addressableMaxBytes: 4_096,
      addressablePerAuthor: 64,
      addressableBytesPerAuthor: 10_000,
    });
    expect(s.putAddressable(sized("a", "d1", 4_000, 31081), 1000)).toBe(true);
    expect(s.putAddressable(sized("a", "d2", 4_000, 31082), 1000)).toBe(true); // 換一個 kind 也照算
    expect(s.putAddressable(sized("a", "d3", 4_000, 31083), 1000)).toBe(false); // 超過總量
    // 另一個作者不受影響
    expect(s.putAddressable(sized("b", "d1", 4_000, 31081), 1000)).toBe(true);
  });

  it("🔴 取代既有位址算的是**差額**，不是全額——否則更新到一半就再也更新不了", () => {
    const s = new MessageStore({ addressableMaxBytes: 8_192, addressableBytesPerAuthor: 10_000 });
    expect(s.putAddressable(sized("a", "d1", 8_000), 1000)).toBe(true);
    // 同一個位址更新成同樣大小：總量沒有變，必須收
    const again = { ...sized("a", "d1", 8_000), id: "a-31081-d1-v2", created_at: 2000 } as NostrEvent;
    expect(s.putAddressable(again, 1000)).toBe(true);
    // 但換一個新位址就會超過
    expect(s.putAddressable(sized("a", "d2", 8_000), 1000)).toBe(false);
  });

  it("未設定＝不限制（自架站與現有部署維持原行為）", () => {
    const s = new MessageStore();
    expect(s.putAddressable(sized("a", "d1", 200_000), 1000)).toBe(true);
  });
});

describe("整顆 DO 的可尋址容量天花板（ADR-0367 §決策 2）", () => {
  const sized2 = (pubkey: string, d: string, bytes: number, expiresAt?: number): NostrEvent =>
    ({
      id: `${pubkey}-${d}`,
      pubkey,
      created_at: 1000,
      kind: 31081,
      tags: expiresAt === undefined ? [["d", d]] : [["d", d], ["expiration", String(expiresAt)]],
      content: "x".repeat(bytes),
      sig: "",
    }) as NostrEvent;

  /**
   * 容量用**實際序列化長度**算，不要用猜的——猜錯會變成測試在測自己的算術。
   * 四顆事件的 `d` 長度不同 ⇒ 大小也不同，所以取「最大的 n 筆」當容量。
   */
  const roomFor = (n: number, events: readonly NostrEvent[]): number =>
    events
      .map((e) => JSON.stringify(e).length)
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((sum, len) => sum + len, 0);

  it("車道：超過天花板就淘汰**最快到期**的，新的寫得進去", () => {
    const four = [
      sized2("a", "soon", 200, 2000),
      sized2("a", "later", 200, 5000),
      sized2("a", "latest", 200, 9000),
      sized2("a", "new", 200, 9000),
    ];
    const s = new MessageStore({
      addressableMaxTotalBytes: roomFor(3, four),
      ceilingEvicts: true,
      addressablePerAuthor: 64,
    });
    // 到期時間一筆比一筆晚；第四筆放不下 → 淘汰最快到期的那筆（soon）
    for (const e of four) expect(s.putAddressable(e, 1000)).toBe(true);
    const left = s
      .query({ authors: ["a"], kinds: [31081] } as never, 1000)
      .map((e) => e.tags.find((t) => t[0] === "d")?.[1])
      .sort();
    expect(left).toEqual(["later", "latest", "new"]);
  });

  it("🔴 嚴格平面只拒收、不淘汰——刪別人的加密備份不可逆，拒收看得見", () => {
    const four = ["d1", "d2", "d3", "d4"].map((d) => sized2("a", d, 200));
    const s = new MessageStore({
      addressableMaxTotalBytes: roomFor(3, four),
      addressablePerAuthor: 64,
    });
    expect(s.putAddressable(four[0]!, 1000)).toBe(true);
    expect(s.putAddressable(four[1]!, 1000)).toBe(true);
    expect(s.putAddressable(four[2]!, 1000)).toBe(true);
    expect(s.putAddressable(four[3]!, 1000)).toBe(false); // 拒收
    // 先前的三筆一個都沒少
    expect(s.query({ authors: ["a"], kinds: [31081] } as never, 1000)).toHaveLength(3);
  });

  it("單顆就超過天花板：淘汰也救不了，直接拒收（不會把整顆 DO 清空）", () => {
    const s = new MessageStore({
      addressableMaxTotalBytes: roomFor(2, [sized2("a", "keep", 200, 2000)]),
      ceilingEvicts: true,
      addressablePerAuthor: 64,
    });
    expect(s.putAddressable(sized2("a", "keep", 200, 2000), 1000)).toBe(true);
    expect(s.putAddressable(sized2("b", "huge", 5_000, 9000), 1000)).toBe(false);
    expect(s.query({ authors: ["a"], kinds: [31081] } as never, 1000)).toHaveLength(1);
  });

  it("未設＝不限制（自架站與現有部署維持原行為）", () => {
    const s = new MessageStore({ addressablePerAuthor: 64 });
    for (let i = 0; i < 20; i++) expect(s.putAddressable(sized2("a", `d${i}`, 5_000), 1000)).toBe(true);
  });
});

describe("離線留言的 DO 天花板（ADR-0367 §決策 2）", () => {
  /** 沒有 `p` 標籤的事件——遊戲的房間／世界事件正是這個形狀。 */
  const roomEvent = (id: string, bytes: number, expiresAt: number): NostrEvent =>
    ({
      id,
      pubkey: "a",
      created_at: 1000,
      kind: 1078,
      tags: [["t", "lwd"], ["expiration", String(expiresAt)]],
      content: "x".repeat(bytes),
      sig: "",
    }) as NostrEvent;

  const four = [
    roomEvent("soon", 200, 2000),
    roomEvent("later", 200, 5000),
    roomEvent("latest", 200, 9000),
    roomEvent("fresh", 200, 9000),
  ];
  const roomFor = (n: number): number =>
    four
      .map((e) => JSON.stringify(e).length)
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((sum, len) => sum + len, 0);

  it("🔴 沒有 `p` 標籤的事件也受天花板約束——那個桶原本沒有任何上限", () => {
    // `enforceCap` 只對真正的收件人執行，而 `p`-less 事件落在 `recipient = ''`
    // ⇒ 它原本只被 TTL 壓著。遊戲的房間事件全都是這個形狀。
    const s = new MessageStore({ offlineMaxTotalBytes: roomFor(3), ceilingEvicts: true });
    for (const e of four) expect(s.put(e, 1000)).toBe(true);
    const kept = s
      .query({ kinds: [1078] } as never, 1000)
      .map((e) => e.id)
      .sort();
    expect(kept).toEqual(["fresh", "later", "latest"]); // soon 被淘汰
  });

  it("嚴格平面只拒收、不淘汰", () => {
    const s = new MessageStore({ offlineMaxTotalBytes: roomFor(3) });
    expect(s.put(four[0]!, 1000)).toBe(true);
    expect(s.put(four[1]!, 1000)).toBe(true);
    expect(s.put(four[2]!, 1000)).toBe(true);
    expect(s.put(four[3]!, 1000)).toBe(false);
    expect(s.query({ kinds: [1078] } as never, 1000)).toHaveLength(3);
  });

  it("未設＝不限制", () => {
    const s = new MessageStore();
    for (const e of four) expect(s.put(e, 1000)).toBe(true);
  });
});
