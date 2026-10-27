import { finalizeEvent } from "../../src/protocol/sign.js";
import type { NostrEvent } from "../../src/protocol/event.js";
import { describe, expect, it } from "vitest";
import { getPublicKey, generateSecretKey } from "../../src/protocol/keys.js";
import { sealAndWrap } from "../../src/protocol/nip59.js";
import {
  EK_ANNOUNCE_KIND,
  EMPTY_FS_FAILURE_LOG,
  FS_CAPABILITY,
  FS_CAPABILITY_MAX_LEN,
  FS_GRACE_MS,
  FS_RETIRED,
  FS_ROTATE_INTERVAL_MS,
  buildEkAnnounce,
  compareFsStrength,
  ekHintOf,
  generateEncryptionKey,
  openWrapWithEks,
  pinAfterDeclare,
  pinIsDowngraded,
  pruneFsKeys,
  readEkAnnounce,
  readFsCapability,
  readPin,
  recordFsFailure,
  shouldRotateFs,
  withEkHint,
} from "../../src/protocol/subkey.js";

describe("EK 生成（ADR-0245 Phase 0）", () => {
  it("產生獨立隨機 secp256k1 金鑰對（pk＝getPublicKey(sk)）", () => {
    const ek = generateEncryptionKey();
    expect(ek.pk).toBe(getPublicKey(ek.sk));
    expect(ek.pk).toMatch(/^[0-9a-f]{64}$/);
    expect(generateEncryptionKey().pk).not.toBe(ek.pk); // 隨機、不重複
  });
});

describe("kind 10040 EK 公告（IK 簽章、可驗證）", () => {
  it("build → read 往返；帶當前＋下一把", () => {
    const ik = generateSecretKey();
    const cur = generateEncryptionKey();
    const nxt = generateEncryptionKey();
    const ev = buildEkAnnounce(ik, cur.pk, { next: nxt.pk, now: 1000 });
    expect(ev.kind).toBe(EK_ANNOUNCE_KIND);
    const read = readEkAnnounce(ev);
    // ADR-0302 §1：結果帶 `kind` 以區分「不認得的版本」與垃圾。
    expect(read).toEqual({ kind: "ok", ik: getPublicKey(ik), ek: cur.pk, next: nxt.pk });
  });

  it("只帶當前（無 next）", () => {
    const ik = generateSecretKey();
    const cur = generateEncryptionKey();
    const read = readEkAnnounce(buildEkAnnounce(ik, cur.pk, { now: 1 }));
    expect(read).toEqual({ kind: "ok", ik: getPublicKey(ik), ek: cur.pk });
  });

  it("竄改/錯 kind/壞簽章/畸形內容 → null（不信任網路來源）", () => {
    const ik = generateSecretKey();
    const cur = generateEncryptionKey();
    const ev = buildEkAnnounce(ik, cur.pk, { now: 1 });
    expect(readEkAnnounce({ ...ev, content: JSON.stringify({ v: 1, ek: "zz" }) })).toBeNull(); // 非法 pk（簽章也會不符）
    expect(readEkAnnounce({ ...ev, kind: 1 })).toBeNull(); // 錯 kind
    expect(readEkAnnounce({ ...ev, sig: "00".repeat(32) })).toBeNull(); // 壞簽章
    expect(readEkAnnounce({ ...ev, content: "not json" })).toBeNull();
  });
});

describe("rumor 內嵌 EK hint（對方即時學到我的 EK）", () => {
  it("withEkHint / ekHintOf 往返；重設不重複", () => {
    const ek = generateEncryptionKey();
    const tags = withEkHint([["p", "aa".repeat(32)]], ek.pk);
    expect(ekHintOf(tags)).toBe(ek.pk);
    // 再設一次 → 只留最新一個 ek tag
    const ek2 = generateEncryptionKey();
    const tags2 = withEkHint(tags, ek2.pk);
    expect(ekHintOf(tags2)).toBe(ek2.pk);
    expect(tags2.filter((t) => t[0] === "ek")).toHaveLength(1);
  });
  it("無 hint / 非法 hint → undefined", () => {
    expect(ekHintOf([["p", "x"]])).toBeUndefined();
    expect(ekHintOf([["ek", "zz"]])).toBeUndefined();
  });
});

describe("retarget Gift Wrap 到 EK＋多鑰解封（FS 核心，ADR-0245）", () => {
  it("以收件人 EK 加密：EK sk 解得開、驗證寄件人、學到寄件人 EK；#p 仍為收件人身分（路由）", () => {
    const senderIk = generateSecretKey();
    const recipIk = generateSecretKey();
    const recipEk = generateEncryptionKey();
    const senderEk = generateEncryptionKey();

    // A 送 B：rumor 夾 A 自己的 EK hint；加密到 B 的 EK；外層 #p 仍指 B 的身分（供中繼路由/收件匣）。
    const rumor = { kind: 14, created_at: 1000, tags: withEkHint([], senderEk.pk), content: "嗨 Bob" };
    const wrap = sealAndWrap(rumor, senderIk, recipEk.pk, { kind: 1059, tags: [["p", getPublicKey(recipIk)]] });

    const opened = openWrapWithEks(wrap, [recipEk.sk]);
    expect(opened.sender).toBe(getPublicKey(senderIk)); // 認證不變：seal 由 sender IK 簽
    expect(opened.rumor.content).toBe("嗨 Bob");
    expect(ekHintOf(opened.rumor.tags)).toBe(senderEk.pk); // B 學到 A 的 EK
    expect(wrap.tags).toContainEqual(["p", getPublicKey(recipIk)]); // #p＝身分、非 EK
  });

  it("🔴 FS 核心：EK 刪掉（不在候選）後，即使拿收件人 IK 也解不開被側錄的密文", () => {
    const senderIk = generateSecretKey();
    const recipIk = generateSecretKey();
    const recipEk = generateEncryptionKey();
    const wrap = sealAndWrap({ kind: 14, created_at: 1, tags: [], content: "秘密" }, senderIk, recipEk.pk, {
      kind: 1059,
      tags: [["p", getPublicKey(recipIk)]],
    });
    // EK sk 還在 → 解得開（訊息到達時解一次）。
    expect(openWrapWithEks(wrap, [recipEk.sk]).rumor.content).toBe("秘密");
    // grace 後刪掉 EK sk → 候選只剩 IK（身分永久金鑰）→ 仍解不開（前向保密）。
    expect(() => openWrapWithEks(wrap, [recipIk])).toThrow();
  });

  it("向後相容：非 FS 寄件人加密到收件人 IK → 候選含 IK 時解得開（EK 失敗自動退回 IK）", () => {
    const senderIk = generateSecretKey();
    const recipIk = generateSecretKey();
    const recipEk = generateEncryptionKey();
    const wrap = sealAndWrap({ kind: 14, created_at: 1, tags: [], content: "靜態訊息" }, senderIk, getPublicKey(recipIk), {
      kind: 1059,
      tags: [],
    });
    const opened = openWrapWithEks(wrap, [recipEk.sk, recipIk]); // 先試 EK（失敗）→ 退回 IK
    expect(opened.rumor.content).toBe("靜態訊息");
  });

  it("多把 EK 候選：用正確那把（grace 內舊 EK）解得開，順序無妨", () => {
    const senderIk = generateSecretKey();
    const recipIk = generateSecretKey();
    const oldEk = generateEncryptionKey();
    const curEk = generateEncryptionKey();
    // 對方還在用「上一把」EK 加密（尚未學到新的）。
    const wrap = sealAndWrap({ kind: 14, created_at: 1, tags: [], content: "用舊鑰" }, senderIk, oldEk.pk, {
      kind: 1059,
      tags: [["p", getPublicKey(recipIk)]],
    });
    expect(openWrapWithEks(wrap, [curEk.sk, oldEk.sk, recipIk]).rumor.content).toBe("用舊鑰");
  });

  it("全部候選皆錯 → 拋（呼叫端據此顯示未解、待同步重試）", () => {
    const senderIk = generateSecretKey();
    const recipEk = generateEncryptionKey();
    const wrap = sealAndWrap({ kind: 14, created_at: 1, tags: [], content: "x" }, senderIk, recipEk.pk, {
      kind: 1059,
      tags: [],
    });
    expect(() => openWrapWithEks(wrap, [generateSecretKey(), generateSecretKey()])).toThrow();
  });
});

describe("pruneFsKeys（grace 刪除紀律，ADR-0245）", () => {
  it("保留 current＋grace 內被取代者；逾 grace 的舊 EK 回收", () => {
    const g = FS_GRACE_MS;
    const now = 100 * g;
    const keys = [
      { at: now - 3 * g, id: "oldest" }, // 被 mid 取代（於 now-2g）→ 逾 grace → 刪
      { at: now - 2 * g, id: "mid" }, // 被 cur 取代（於 now-0.5g）→ 未逾 grace → 留
      { at: now - 0.5 * g, id: "cur" }, // current → 留
    ];
    expect(pruneFsKeys(keys, now).map((k) => k.id).sort()).toEqual(["cur", "mid"]);
  });
  it("只有一把（current）→ 永不刪", () => {
    expect(pruneFsKeys([{ at: 1 }], 1e15)).toEqual([{ at: 1 }]);
  });
  it("剛換（都在 grace 內）→ 全留", () => {
    const now = 1000;
    expect(pruneFsKeys([{ at: now - 10 }, { at: now }], now)).toHaveLength(2);
  });
});


describe("FS 能力宣告的解讀（ADR-0306 D3.3c）", () => {
  it("ek-v1 ＝正在做 FS", () => {
    expect(readFsCapability(FS_CAPABILITY)).toBe("fs");
  });

  it("缺席／空字串＝沒有宣告（＝今天絕大多數聯絡人）", () => {
    expect(readFsCapability(undefined)).toBe("absent");
    expect(readFsCapability("")).toBe("absent");
    expect(readFsCapability("   ")).toBe("absent");
  });

  it("明示退場值＝已停止，這是硬退用的（ADR-0306 D3.3）", () => {
    expect(readFsCapability(FS_RETIRED)).toBe("retired");
  });

  it("🔴 不認得的值＝unknown，不得與「缺席」混為一談", () => {
    // 這正是 ADR-0302 §2 指出的缺陷：舊碼把兩者都當成「沒有 FS」。
    expect(readFsCapability("ek-v2")).toBe("unknown");
    expect(readFsCapability("ratchet-v1")).toBe("unknown");
    expect(readFsCapability("subkey-only")).toBe("unknown");
  });

  it("非字串一律視為缺席（不信任網路來源）", () => {
    expect(readFsCapability(42)).toBe("absent");
    expect(readFsCapability(null)).toBe("absent");
    expect(readFsCapability({ fs: "ek-v1" })).toBe("absent");
  });

  it("前後空白不影響判定", () => {
    expect(readFsCapability(` ${FS_CAPABILITY} `)).toBe("fs");
    expect(readFsCapability(` ${FS_RETIRED} `)).toBe("retired");
  });

  it("退場值與能力值不得相同（否則硬退無法表達）", () => {
    expect(FS_RETIRED).not.toBe(FS_CAPABILITY);
  });
});

describe("能力字串的長度限制（審查發現：超長會靜默變成『沒有宣告』）", () => {
  it("🔴 現有能力值都必須在 parseProfile 的 16 字元上限內", () => {
    // `profile.ts` 只收 `fs.length <= 16`，超過即丟棄 ⇒ 對方會被當成 `absent`
    // 而不是 `unknown`——**靜默失效**，收件端完全看不出對方宣告過什麼。
    // 故新增能力值時必須先過這一關；這條測試就是那道門。
    expect(FS_CAPABILITY.length).toBeLessThanOrEqual(FS_CAPABILITY_MAX_LEN);
    expect(FS_RETIRED.length).toBeLessThanOrEqual(FS_CAPABILITY_MAX_LEN);
  });

  it("上限值必須與 profile.ts 的實際限制一致（改了一邊就會在這裡爆）", () => {
    expect(FS_CAPABILITY_MAX_LEN).toBe(16);
  });
});

describe("shouldRotateFs（ADR-0313 自動輪替）", () => {
  const t0 = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("尚未啟用（無金鑰）不輪替——生成第一把是 enableFs 的事", () => {
    expect(shouldRotateFs([], t0)).toBe(false);
  });

  it("剛生成不輪替；滿 7 天才輪替", () => {
    const keys = [{ at: t0 }];
    expect(shouldRotateFs(keys, t0)).toBe(false);
    expect(shouldRotateFs(keys, t0 + 6 * day)).toBe(false);
    expect(shouldRotateFs(keys, t0 + FS_ROTATE_INTERVAL_MS)).toBe(true);
  });

  it("看的是 current（最新那把）的年齡，不是最舊的", () => {
    // 舊把很老、current 剛生成 → 不該輪替（否則每次開機都換一把）
    const keys = [{ at: t0 - 30 * day }, { at: t0 }];
    expect(shouldRotateFs(keys, t0 + day)).toBe(false);
  });

  it("離線期間照算——年齡而非計時器（App 關著時間也累積）", () => {
    expect(shouldRotateFs([{ at: t0 }], t0 + 90 * day)).toBe(true);
  });

  it("穩態：每 7 天輪替 ＋ grace 7 天 ⇒ 手上 2–3 把，不會無限累積", () => {
    let keys = [{ at: t0 }];
    for (let week = 1; week <= 8; week++) {
      const now = t0 + week * FS_ROTATE_INTERVAL_MS;
      expect(shouldRotateFs(keys, now)).toBe(true);
      keys = pruneFsKeys([...keys, { at: now }], now);
      // 輪替**當下**是 3 把：grace 邊界是閉區間（`<=`），剛好滿 grace 的那把還留著。
      expect(keys).toHaveLength(week === 1 ? 2 : 3);
    }
    // 邊界過了就回到 2 把（current ＋ 一把 grace 內）。
    const later = t0 + 8 * FS_ROTATE_INTERVAL_MS + 1;
    expect(pruneFsKeys(keys, later)).toHaveLength(2);
  });
});

describe("recordFsFailure（ADR-0316 可觀測性）", () => {
  const t = 1_700_000_000_000;

  it("從未持有 EK → 記進 notFs（確定與 FS 無關），不動 maybeEkLoss", () => {
    const out = recordFsFailure(EMPTY_FS_FAILURE_LOG, t, false);
    expect(out).toEqual({ notFs: 1, maybeEkLoss: 0 });
    expect(out.lastEkLossAt).toBeUndefined();
  });

  it("有或曾有 EK → 記進 maybeEkLoss 並記時間", () => {
    const out = recordFsFailure(EMPTY_FS_FAILURE_LOG, t, true);
    expect(out.maybeEkLoss).toBe(1);
    expect(out.notFs).toBe(0);
    expect(out.lastEkLossAt).toBe(t);
  });

  it("累加並更新最後時間", () => {
    let log = recordFsFailure(EMPTY_FS_FAILURE_LOG, t, true);
    log = recordFsFailure(log, t + 1000, true);
    log = recordFsFailure(log, t + 2000, false);
    expect(log).toEqual({ notFs: 1, maybeEkLoss: 2, lastEkLossAt: t + 1000 });
  });

  it("純函式：不變更輸入", () => {
    const before = { ...EMPTY_FS_FAILURE_LOG };
    recordFsFailure(EMPTY_FS_FAILURE_LOG, t, true);
    expect(EMPTY_FS_FAILURE_LOG).toEqual(before);
  });
});

// ── ADR-0302 §3：釘選要記強度而非布林 ────────────────────────────────────────
//
// 舊的 `pinned: Record<string, boolean>` 只說得出「期望 FS / 不期望」。降級判定因此是
// 「釘過他、但現在沒有他的 EK」——一個**仍然有 EK、只是退回較弱機制**的對方完全看不出來。

describe("釘選的強度（ADR-0302 §3）", () => {
  /** 兩個機制的測試用序（生產環境目前只有 ek-v1；見 FS_SCHEME_RANK 的偏序警告）。 */
  const RANK = { "ek-v1": 1, "ek-pq-v1": 2 } as const;

  describe("readPin：吸收舊的布林形", () => {
    it("🔴 `true` 視為 ek-v1——舊存檔與舊版客戶端的快照會一直送這個過來", () => {
      expect(readPin(true)).toEqual({ scheme: "ek-v1", at: 0 });
    });
    it("`at: 0` 是刻意的：我們不知道它何時被釘上，假造「現在」會讓它看起來比實際新", () => {
      expect(readPin(true)!.at).toBe(0);
    });
    it("新形原樣通過；未釘選回 undefined", () => {
      expect(readPin({ scheme: "ek-pq-v1", at: 5 })).toEqual({ scheme: "ek-pq-v1", at: 5 });
      expect(readPin(undefined)).toBeUndefined();
    });
  });

  describe("compareFsStrength", () => {
    it("認得的照序比", () => {
      expect(compareFsStrength("ek-v1", "ek-pq-v1", RANK)).toBe("weaker");
      expect(compareFsStrength("ek-pq-v1", "ek-v1", RANK)).toBe("stronger");
      expect(compareFsStrength("ek-v1", "ek-v1", RANK)).toBe("same");
    });
    it("🔴 不認得的回 incomparable，**不是** weaker——那是安全側的預設", () => {
      // 把「我沒聽過這個機制」當成降級，就是把「你該更新」講成「對方可能正在被攻擊」
      // （ADR-0302 §4 的紅線）。那種情形走 markFsUnsupported 那條路。
      expect(compareFsStrength("ratchet-v9000", "ek-v1", RANK)).toBe("incomparable");
      expect(compareFsStrength("ek-v1", "ratchet-v9000", RANK)).toBe("incomparable");
    });
    it("生產的預設表有 ek-v1 與 ek-pq-v1 兩階（ADR-0365）", () => {
      expect(compareFsStrength("ek-v1", "ek-v1")).toBe("same");
      expect(compareFsStrength("ek-pq-v1", "ek-v1")).toBe("stronger");
      expect(compareFsStrength("ek-v1", "ek-pq-v1")).toBe("weaker");
    });

    it("仍然只有顯式加進表裡的機制比得了（沒聽過的一律 incomparable）", () => {
      // 這是安全側的預設：把「我沒聽過這個機制」當成降級，就是把「你該更新」
      // 講成「對方可能被攻擊」（ADR-0302 §4 的紅線）。
      expect(compareFsStrength("ratchet-v1", "ek-v1")).toBe("incomparable");
      expect(compareFsStrength("ek-pq-v1", "ratchet-v1")).toBe("incomparable");
    });
  });

  describe("pinAfterDeclare：scheme 只升不降", () => {
    it("首次宣告即釘上", () => {
      expect(pinAfterDeclare(undefined, "ek-v1", 100, RANK)).toEqual({ scheme: "ek-v1", at: 100 });
    });

    it("宣告更強 → 升級基準並清掉降級證據", () => {
      const prev = { scheme: "ek-v1", at: 100, declared: "ek-v1" };
      expect(pinAfterDeclare(prev, "ek-pq-v1", 200, RANK)).toEqual({ scheme: "ek-pq-v1", at: 200 });
    });

    it("🔴 宣告較弱 → **基準不動**，只記下對方現在說的（否則 TOFU 形同虛設）", () => {
      // 若允許較弱的宣告覆蓋釘選，攻擊者只要宣告弱的就能把基準拉低。
      const prev = { scheme: "ek-pq-v1", at: 100 };
      const next = pinAfterDeclare(prev, "ek-v1", 200, RANK);
      expect(next.scheme).toBe("ek-pq-v1"); // 基準沒被拉低
      expect(next.at).toBe(100); // 時間也不動
      expect(next.declared).toBe("ek-v1"); // 但留下證據
      expect(pinIsDowngraded(next)).toBe(true);
    });

    it("🔴 從舊的布林形起跳也擋得住降級（遷移期最容易漏的那一格）", () => {
      // 舊存檔是 `true`＝ek-v1。對方若宣告更強的再退回，一樣要擋。
      const up = pinAfterDeclare(true, "ek-pq-v1", 200, RANK);
      expect(up.scheme).toBe("ek-pq-v1");
      expect(pinAfterDeclare(up, "ek-v1", 300, RANK).scheme).toBe("ek-pq-v1");
    });

    it("宣告相同 → 回到正常，清掉降級證據（對方修好了／攻擊停了）", () => {
      const downgraded = { scheme: "ek-pq-v1", at: 100, declared: "ek-v1" };
      const back = pinAfterDeclare(downgraded, "ek-pq-v1", 300, RANK);
      expect(pinIsDowngraded(back)).toBe(false);
      expect(back.at).toBe(100); // 基準的時間是「何時升上來的」，不因複述而更新
    });

    it("不可比（含不認得）→ 釘選完全不動", () => {
      const prev = { scheme: "ek-v1", at: 100 };
      expect(pinAfterDeclare(prev, "ratchet-v9000", 200, RANK)).toEqual(prev);
      expect(pinIsDowngraded(pinAfterDeclare(prev, "ratchet-v9000", 200, RANK))).toBe(false);
    });
  });

  it("pinIsDowngraded 對未釘選與布林形都不誤報", () => {
    expect(pinIsDowngraded(undefined)).toBe(false);
    expect(pinIsDowngraded(true)).toBe(false);
  });
});

// ── ADR-0302 §1 的另一半：公告的未知版本 ────────────────────────────────────
//
// 個人檔那半由 ADR-0306 D3.3c 做掉了，**公告這半一直漏著**：`v !== 1` 與垃圾同樣回 null
// ⇒ 一個升級了的對方在我們眼中等於「沒有 EK」⇒ 送訊時跳「疑似降級（對方可能被攻擊）」。
// 而**後量子的公告正是 `v: 2`**——不修的話第一個升級的人就會被誤報。

describe("EK 公告的未知版本（ADR-0302 §1）", () => {
  const sk = generateSecretKey();
  const ik = getPublicKey(sk);
  /** 直接造一顆帶任意 content 的 10040（繞過 buildEkAnnounce 的 v 固定為 1）。 */
  const announce = (content: unknown): NostrEvent =>
    finalizeEvent({ kind: EK_ANNOUNCE_KIND, created_at: 1000, tags: [], content: JSON.stringify(content) }, sk);

  it("目前版本照常解析", () => {
    const ek = getPublicKey(generateSecretKey());
    const r = readEkAnnounce(announce({ v: 1, ek }));
    expect(r).toEqual({ kind: "ok", ik, ek });
  });

  it("🔴 比我們認得的更新的版本回「對方升級了」，**不是** null", () => {
    // ⚠ 2026-09-21：`v: 2` 已經是**我們認得的**版本（後量子公告），所以門檻上移到 3。
    // 這條測試的意圖沒變——不認得的版本必須與垃圾分開。
    const r = readEkAnnounce(announce({ v: 3, ek: "whatever-the-future-looks-like" }));
    expect(r).toEqual({ kind: "newer", ik, v: 3 });
  });

  it("🔴 未來版本**不驗其餘欄位**——拿今天的規則去驗它只會把合法的新版判成垃圾", () => {
    expect(readEkAnnounce(announce({ v: 99 }))?.kind).toBe("newer");
    expect(readEkAnnounce(announce({ v: 4, pq: { anything: true } }))?.kind).toBe("newer");
  });

  it("真正的壞東西仍然回 null（垃圾與「新版」必須分得開，但不能全部放行）", () => {
    expect(readEkAnnounce(announce({ v: 1, ek: "不是公鑰" }))).toBeNull(); // 認得的版本、欄位不合法
    expect(readEkAnnounce(announce({ v: 0, ek: "x" }))).toBeNull(); // 比目前還舊＝不合法
    expect(readEkAnnounce(announce({ v: "2", ek: "x" }))).toBeNull(); // v 不是數字
    expect(readEkAnnounce(announce({ v: 1.5 }))).toBeNull(); // 非整數
    expect(readEkAnnounce({ ...announce({ v: 1 }), kind: 1 })).toBeNull(); // kind 不符
  });

  it("🔴 簽章錯的一律丟棄——「新版」不是繞過驗證的後門", () => {
    const evt = announce({ v: 3 });
    expect(readEkAnnounce({ ...evt, content: JSON.stringify({ v: 3, tampered: true }) })).toBeNull();
  });
});

// ── 後量子公告 v2（Phase 2）──────────────────────────────────────────────────

describe("後量子 EK 公告（v2，Phase 2）", () => {
  const sk2 = generateSecretKey();
  const ik2 = getPublicKey(sk2);
  const ek = getPublicKey(generateSecretKey());
  const nextEk = getPublicKey(generateSecretKey());

  it("🔴 預設仍發 v1——讀端還沒普及之前不得開始發 v2（計畫 §5 的順序紅線）", () => {
    // 還沒更新的客戶端讀到 v2 會回 null ⇒ 在它眼中對方「沒有 EK」⇒ 跳「疑似降級」。
    // ⇒ 第一個升級的人會被所有舊版聯絡人誤報成被攻擊。
    const evt = buildEkAnnounce(sk2, ek);
    expect(JSON.parse(evt.content).v).toBe(1);
    expect(JSON.parse(evt.content).pq).toBeUndefined();
  });

  it("明確給了 pq 才發 v2", () => {
    const evt = buildEkAnnounce(sk2, ek, { pq: "cHE=" });
    const c = JSON.parse(evt.content);
    expect(c.v).toBe(2);
    expect(c.pq).toBe("cHE=");
  });

  it("🔴 v2 **必須保留 `ek` 欄位**——還沒升級的寄件人只讀得懂它", () => {
    // 拿掉 ek 等於讓所有舊版聯絡人完全送不出 FS 訊息（退回身分金鑰）。
    const c = JSON.parse(buildEkAnnounce(sk2, ek, { pq: "cHE=", next: nextEk, nextPq: "bnE=" }).content);
    expect(c.ek).toBe(ek);
    expect(c.next).toBe(nextEk);
    expect(c.nextPq).toBe("bnE=");
  });

  it("v2 往返：讀回 ek 與 pq", () => {
    const r = readEkAnnounce(buildEkAnnounce(sk2, ek, { pq: "cHE=", next: nextEk, nextPq: "bnE=" }));
    expect(r).toEqual({ kind: "ok", ik: ik2, ek, next: nextEk, pq: "cHE=", nextPq: "bnE=" });
  });

  it("v1 讀回來沒有 pq 欄位（不得無中生有）", () => {
    const r = readEkAnnounce(buildEkAnnounce(sk2, ek));
    expect(r).toEqual({ kind: "ok", ik: ik2, ek });
  });

  it("🔴 v2 但 `ek` 不合法 ⇒ null（v2 是**多**一個 pq，不是換掉 ek）", () => {
    const evt = finalizeEvent(
      {
        kind: EK_ANNOUNCE_KIND,
        created_at: 1000,
        tags: [],
        content: JSON.stringify({ v: 2, ek: "不是公鑰", pq: "cHE=" }),
      },
      sk2,
    );
    expect(readEkAnnounce(evt)).toBeNull();
  });

  it("⚠ `pq` 只做形狀檢查，不解 base64——誤判會把合法的新版整顆丟掉", () => {
    // 寧可帶著壞值往下走讓使用端自己失敗，也不要回 null（那又變成「升級的人沒有 EK」）。
    const evt = finalizeEvent(
      {
        kind: EK_ANNOUNCE_KIND,
        created_at: 1000,
        tags: [],
        content: JSON.stringify({ v: 2, ek, pq: "這不是合法的 base64!!!" }),
      },
      sk2,
    );
    const r = readEkAnnounce(evt);
    expect(r?.kind).toBe("ok");
    expect(r?.kind === "ok" && r.pq).toBe("這不是合法的 base64!!!");
  });

  it("v2 但 pq 是空字串 ⇒ 當成沒有（退回古典，而不是拋）", () => {
    const evt = finalizeEvent(
      { kind: EK_ANNOUNCE_KIND, created_at: 1000, tags: [], content: JSON.stringify({ v: 2, ek, pq: "" }) },
      sk2,
    );
    const r = readEkAnnounce(evt);
    expect(r?.kind).toBe("ok");
    expect(r?.kind === "ok" && r.pq).toBeUndefined();
  });
});
