import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import {
  applyRosterRotations,
  diffRoster,
  inWorkHours,
  policyNotices,
  policyTtlSeconds,
  type OrgRosterDoc,
  rosterAllowlist,
  rosterRemap,
  rosterSigners,
  ROSTER_MAX_ADMINS,
  shouldAdoptRoster,
  signOrgRoster,
  verifyOrgRoster,
  WELCOME_MAX_CHARS,
} from "../../src/protocol/org-roster.js";

const adminSk = generateSecretKey();
const admin = getPublicKey(adminSk);
const a = getPublicKey(generateSecretKey());
const b = getPublicKey(generateSecretKey());
const c = getPublicKey(generateSecretKey());
const d = getPublicKey(generateSecretKey());

const doc = (members: OrgRosterDoc["members"], updatedAt = 1000): OrgRosterDoc => ({ org: "Acme", members, updatedAt });

describe("org-roster 簽章名冊（ADR-0047）", () => {
  it("sign/verify round-trip", () => {
    const ev = signOrgRoster(doc([{ pubkey: a, name: "Alice" }, { pubkey: b, name: "Bob", relayUrl: "wss://r" }]), adminSk);
    const out = verifyOrgRoster(ev, admin);
    expect(out?.org).toBe("Acme");
    expect(out?.members.map((m) => m.pubkey)).toEqual([a, b]);
    expect(out?.members[1]?.relayUrl).toBe("wss://r");
  });

  it("以 pubkey 去重", () => {
    const ev = signOrgRoster(doc([{ pubkey: a, name: "A1" }, { pubkey: a, name: "A2" }]), adminSk);
    expect(verifyOrgRoster(ev, admin)?.members.length).toBe(1);
  });

  it("作者非指定管理者 → null", () => {
    const ev = signOrgRoster(doc([{ pubkey: a, name: "Alice" }]), adminSk);
    expect(verifyOrgRoster(ev, a)).toBeNull();
  });

  it("內容被竄改（簽章失效）→ null", () => {
    const ev = signOrgRoster(doc([{ pubkey: a, name: "Alice" }]), adminSk);
    const tampered = { ...ev, content: ev.content.replace("Alice", "Eve") };
    expect(verifyOrgRoster(tampered, admin)).toBeNull();
  });

  it("空成員（防清空）→ null", () => {
    const ev = signOrgRoster(doc([]), adminSk);
    expect(verifyOrgRoster(ev, admin)).toBeNull();
  });

  it("shouldAdopt：較新才取代、無現值即採用、較舊/相等不取代", () => {
    const cur = doc([{ pubkey: a, name: "A" }], 1000);
    expect(shouldAdoptRoster(null, cur)).toBe(true);
    expect(shouldAdoptRoster(cur, doc([{ pubkey: a, name: "A" }], 1001))).toBe(true);
    expect(shouldAdoptRoster(cur, doc([{ pubkey: a, name: "A" }], 1000))).toBe(false);
    expect(shouldAdoptRoster(cur, doc([{ pubkey: a, name: "A" }], 999))).toBe(false);
  });

  it("rosterAllowlist 取出 pubkey 供 relay 佈建", () => {
    expect(rosterAllowlist(doc([{ pubkey: a, name: "A" }, { pubkey: b, name: "B" }]))).toEqual([a, b]);
  });

  it("diffRoster：算出新增/移除、排除自己", () => {
    const prev = doc([{ pubkey: admin, name: "Me" }, { pubkey: a, name: "Alice" }]);
    const next = doc([{ pubkey: admin, name: "Me" }, { pubkey: b, name: "Bob" }]); // a 離職、b 新增
    const { toAdd, toRemove } = diffRoster(prev, next, admin);
    expect(toAdd.map((m) => m.pubkey)).toEqual([b]);
    expect(toRemove).toEqual([a]);
  });

  it("diffRoster：無前值時全部為新增（除自己）", () => {
    const { toAdd, toRemove } = diffRoster(null, doc([{ pubkey: admin, name: "Me" }, { pubkey: a, name: "Alice" }]), admin);
    expect(toAdd.map((m) => m.pubkey)).toEqual([a]);
    expect(toRemove).toEqual([]);
  });
  it("政策（ADR-0048）：round-trip 保留、僅接受布林旗標", () => {
    const ev = signOrgRoster(
      { org: "Acme", members: [{ pubkey: a, name: "Alice" }], policy: { disableFiles: true, forceTurn: true }, updatedAt: 1000 },
      adminSk,
    );
    const out = verifyOrgRoster(ev, admin);
    expect(out?.policy).toEqual({ disableFiles: true, forceTurn: true });
  });

  it("政策：無旗標時省略 policy", () => {
    const ev = signOrgRoster({ org: "Acme", members: [{ pubkey: a, name: "Alice" }], updatedAt: 1000 }, adminSk);
    expect(verifyOrgRoster(ev, admin)?.policy).toBeUndefined();
  });
  it("groups（ADR-0049）：round-trip 保留部門群與公告旗標", () => {
    const ev = signOrgRoster(
      {
        org: "Acme",
        members: [{ pubkey: a, name: "Alice" }],
        groups: [
          { id: "dev", name: "研發", members: [a, b] },
          { id: "notice", name: "公告", members: [a, b], announce: true },
        ],
        updatedAt: 1000,
      },
      adminSk,
    );
    const out = verifyOrgRoster(ev, admin);
    expect(out?.groups?.map((g) => g.id)).toEqual(["dev", "notice"]);
    expect(out?.groups?.find((g) => g.id === "notice")?.announce).toBe(true);
    expect(out?.groups?.find((g) => g.id === "dev")?.announce).toBeUndefined();
  });
});

describe("身分輪替（ADR-0052）", () => {
  it("supersededBy round-trip 保留於簽章名冊", () => {
    const ev = signOrgRoster(
      doc([{ pubkey: a, name: "Alice", supersededBy: b }, { pubkey: b, name: "Alice" }]),
      adminSk,
    );
    const out = verifyOrgRoster(ev, admin);
    expect(out?.members.find((m) => m.pubkey === a)?.supersededBy).toBe(b);
    expect(out?.members.find((m) => m.pubkey === b)?.supersededBy).toBeUndefined();
  });

  it("rosterAllowlist 排除已輪替的舊 npub、保留在世者", () => {
    const d0 = doc([{ pubkey: a, name: "Alice", supersededBy: b }, { pubkey: b, name: "Alice" }, { pubkey: c, name: "Cara" }]);
    expect(rosterAllowlist(d0)).toEqual([b, c]);
  });

  it("rosterAllowlist 無輪替時行為不變（相容 ADR-0047）", () => {
    expect(rosterAllowlist(doc([{ pubkey: a, name: "A" }, { pubkey: b, name: "B" }]))).toEqual([a, b]);
  });

  it("rosterRemap：單次輪替 舊→新", () => {
    const d0 = doc([{ pubkey: a, name: "Alice", supersededBy: b }, { pubkey: b, name: "Alice" }]);
    expect(rosterRemap(d0)).toEqual([{ from: a, to: b }]);
  });

  it("rosterRemap：連鎖輪替 A→B→C，A 與 B 皆對映到最終在世者 C", () => {
    const d0 = doc([
      { pubkey: a, name: "Alice", supersededBy: b },
      { pubkey: b, name: "Alice", supersededBy: c },
      { pubkey: c, name: "Alice" },
    ]);
    const remap = rosterRemap(d0);
    expect(remap).toContainEqual({ from: a, to: c });
    expect(remap).toContainEqual({ from: b, to: c });
    expect(remap).toHaveLength(2);
  });

  it("rosterRemap：環（A→B→A）與自我指向不產生對映、不丟例外", () => {
    const cycle = doc([{ pubkey: a, name: "A", supersededBy: b }, { pubkey: b, name: "B", supersededBy: a }]);
    expect(rosterRemap(cycle)).toEqual([]);
    const self = doc([{ pubkey: a, name: "A", supersededBy: a }]);
    expect(rosterRemap(self)).toEqual([]);
  });

  it("diffRoster：本機認得的舊 npub 產生 remap，且不重複列入 add/remove", () => {
    const prev = doc([{ pubkey: admin, name: "Me" }, { pubkey: a, name: "Alice" }]);
    const next = doc([
      { pubkey: admin, name: "Me" },
      { pubkey: a, name: "Alice", supersededBy: b },
      { pubkey: b, name: "Alice" },
    ]);
    const { toAdd, toRemove, toRemap } = diffRoster(prev, next, admin);
    expect(toRemap).toEqual([{ from: a, to: b }]);
    expect(toAdd.map((m) => m.pubkey)).toEqual([]); // b 由 remap 接續，不另外新增
    expect(toRemove).toEqual([]); // a 由 remap 消化，非離職
  });

  it("diffRoster：本機未曾認得舊 npub 時不 remap，新 npub 走一般新增", () => {
    const prev = doc([{ pubkey: admin, name: "Me" }]);
    const next = doc([
      { pubkey: admin, name: "Me" },
      { pubkey: a, name: "Alice", supersededBy: b },
      { pubkey: b, name: "Alice" },
    ]);
    const { toAdd, toRemap } = diffRoster(prev, next, admin);
    expect(toRemap).toEqual([]);
    expect(toAdd.map((m) => m.pubkey)).toEqual([b]);
  });

  it("diffRoster：輪替與離職並存——remap 老員、移除離職者、新增新人", () => {
    const prev = doc([{ pubkey: admin, name: "Me" }, { pubkey: a, name: "Alice" }, { pubkey: c, name: "Cara" }]);
    const next = doc([
      { pubkey: admin, name: "Me" },
      { pubkey: a, name: "Alice", supersededBy: b }, // Alice 換金鑰
      { pubkey: b, name: "Alice" },
      { pubkey: d, name: "Dan" }, // 新人
    ]); // Cara 離職（不在 next）
    const { toAdd, toRemove, toRemap } = diffRoster(prev, next, admin);
    expect(toRemap).toEqual([{ from: a, to: b }]);
    expect(toAdd.map((m) => m.pubkey)).toEqual([d]);
    expect(toRemove).toEqual([c]);
  });

  it("applyRosterRotations：既有舊成員標 supersededBy、自動補入新成員", () => {
    const members = [{ pubkey: admin, name: "Me" }, { pubkey: a, name: "Alice" }];
    const out = applyRosterRotations(members, [{ from: a, to: b }]);
    expect(out.find((m) => m.pubkey === a)?.supersededBy).toBe(b);
    expect(out.find((m) => m.pubkey === b)).toEqual({ pubkey: b, name: "Alice" }); // 沿用舊名補入
    // allowlist 只留在世者、rosterRemap 解出 a→b
    expect(rosterAllowlist({ org: "X", members: out, updatedAt: 1 })).toEqual([admin, b]);
    expect(rosterRemap({ org: "X", members: out, updatedAt: 1 })).toEqual([{ from: a, to: b }]);
  });

  it("applyRosterRotations：舊 npub 不在原清單時補一筆已作廢舊條目；不改動輸入", () => {
    const members = [{ pubkey: admin, name: "Me" }];
    const frozen = JSON.parse(JSON.stringify(members));
    const out = applyRosterRotations(members, [{ from: a, to: b, name: "Alice" }]);
    expect(out.find((m) => m.pubkey === a)).toEqual({ pubkey: a, name: "Alice", supersededBy: b });
    expect(out.find((m) => m.pubkey === b)).toEqual({ pubkey: b, name: "Alice" });
    expect(members).toEqual(frozen); // 純函式：輸入未被改動
  });

  it("applyRosterRotations：from===to 略過（不自我作廢）", () => {
    const members = [{ pubkey: a, name: "Alice" }];
    expect(applyRosterRotations(members, [{ from: a, to: a }])).toEqual([{ pubkey: a, name: "Alice" }]);
  });
});

describe("公司設定隨名冊分發（ADR-0157）", () => {
  const base = { org: "小公司", members: [{ pubkey: admin, name: "老闆" }], updatedAt: 100 };

  it("welcome/workHours round-trip：簽章→驗證原樣還原；舊格式（無欄位）照常", () => {
    const doc: OrgRosterDoc = { ...base, welcome: "  歡迎加入！請詳讀規範。 ", workHours: { start: "09:00", end: "18:00" } };
    const out = verifyOrgRoster(signOrgRoster(doc, adminSk), admin);
    expect(out?.welcome).toBe("歡迎加入！請詳讀規範。"); // 修剪
    expect(out?.workHours).toEqual({ start: "09:00", end: "18:00" });
    // 舊格式：無欄位 → undefined（不炸）
    const legacy = verifyOrgRoster(signOrgRoster(base, adminSk), admin);
    expect(legacy?.welcome).toBeUndefined();
    expect(legacy?.workHours).toBeUndefined();
  });

  it("防禦：超長 welcome 截斷；壞 workHours（格式錯/相等）視為未設", () => {
    const long = "規".repeat(WELCOME_MAX_CHARS + 500);
    const out = verifyOrgRoster(signOrgRoster({ ...base, welcome: long }, adminSk), admin);
    expect(out?.welcome?.length).toBe(WELCOME_MAX_CHARS);
    for (const bad of [{ start: "9:00", end: "18:00" }, { start: "09:00", end: "24:00" }, { start: "09:00", end: "09:00" }]) {
      const o = verifyOrgRoster(signOrgRoster({ ...base, workHours: bad as { start: string; end: string } }, adminSk), admin);
      expect(o?.workHours).toBeUndefined();
    }
  });

  it("inWorkHours：日班（09:00–18:00）邊界含起不含迄", () => {
    const wh = { start: "09:00", end: "18:00" };
    expect(inWorkHours(wh, 9 * 60)).toBe(true); // 09:00 上班
    expect(inWorkHours(wh, 17 * 60 + 59)).toBe(true);
    expect(inWorkHours(wh, 18 * 60)).toBe(false); // 18:00 下班
    expect(inWorkHours(wh, 8 * 60 + 59)).toBe(false);
  });

  it("inWorkHours：跨夜班（22:00–06:00）", () => {
    const wh = { start: "22:00", end: "06:00" };
    expect(inWorkHours(wh, 23 * 60)).toBe(true);
    expect(inWorkHours(wh, 2 * 60)).toBe(true);
    expect(inWorkHours(wh, 6 * 60)).toBe(false);
    expect(inWorkHours(wh, 12 * 60)).toBe(false);
  });
});

describe("訊息保留政策（ADR-0160）", () => {
  const base = { org: "小公司", members: [{ pubkey: admin, name: "老闆" }], updatedAt: 100 };

  it("messageTtlDays round-trip：1–365 整數原樣還原；壞值（0/負/超上限/小數/字串）視為未設", () => {
    const ok = verifyOrgRoster(signOrgRoster({ ...base, policy: { messageTtlDays: 90 } }, adminSk), admin);
    expect(ok?.policy?.messageTtlDays).toBe(90);
    for (const bad of [0, -1, 366, 1.5, "30" as unknown as number]) {
      const out = verifyOrgRoster(signOrgRoster({ ...base, policy: { messageTtlDays: bad, forceTurn: true } }, adminSk), admin);
      expect(out?.policy?.messageTtlDays).toBeUndefined();
      expect(out?.policy?.forceTurn).toBe(true); // 其餘政策不受影響
    }
  });

  it("relayFilesMaxMb（ADR-0162）：1–16 整數原樣還原；壞值視為未設", () => {
    const ok = verifyOrgRoster(signOrgRoster({ ...base, policy: { relayFilesMaxMb: 8 } }, adminSk), admin);
    expect(ok?.policy?.relayFilesMaxMb).toBe(8);
    for (const bad of [0, 17, 2.5]) {
      const out = verifyOrgRoster(signOrgRoster({ ...base, policy: { relayFilesMaxMb: bad, forceTurn: true } }, adminSk), admin);
      expect(out?.policy?.relayFilesMaxMb).toBeUndefined();
      expect(out?.policy?.forceTurn).toBe(true);
    }
  });

  it("policyTtlSeconds：換算天→秒；未設回 undefined", () => {
    expect(policyTtlSeconds({ messageTtlDays: 30 })).toBe(30 * 86_400);
    expect(policyTtlSeconds({ forceTurn: true })).toBeUndefined();
    expect(policyTtlSeconds(undefined)).toBeUndefined();
  });
});

describe("policyNotices（ADR-0312）：政策攤平成設定頁的條列", () => {
  it("無政策／空政策＝空清單（呼叫端據此整段不顯示）", () => {
    expect(policyNotices(undefined)).toEqual([]);
    expect(policyNotices({})).toEqual([]);
  });

  it("停用旗標在前、生效中的規則在後", () => {
    const out = policyNotices({
      messageTtlDays: 30,
      disableCalls: true,
      forceTurn: true,
      disableFiles: true,
    });
    expect(out.map((n) => n.id)).toEqual(["files", "calls", "forceTurn", "ttlDays"]);
    expect(out.filter((n) => n.kind === "disabled").map((n) => n.id)).toEqual(["files", "calls"]);
  });

  it("帶數值的規則保留數值供文案內插", () => {
    const out = policyNotices({ messageTtlDays: 14, relayFilesMaxMb: 8 });
    expect(out).toEqual([
      { id: "ttlDays", kind: "rule", value: 14 },
      { id: "relayFilesMb", kind: "rule", value: 8 },
    ]);
  });

  it("false 的旗標不列（只列真正生效的）", () => {
    expect(policyNotices({ disableFiles: false, disableCalls: false })).toEqual([]);
  });

  it("涵蓋全部七個欄位——新增政策旗標時本測試會提醒補上", () => {
    const out = policyNotices({
      disableFiles: true,
      disableCalls: true,
      disableStickers: true,
      disableCloudBackup: true,
      forceTurn: true,
      messageTtlDays: 7,
      relayFilesMaxMb: 16,
    });
    expect(out.map((n) => n.id)).toEqual([
      "files",
      "calls",
      "stickers",
      "cloudBackup",
      "forceTurn",
      "ttlDays",
      "relayFilesMb",
    ]);
  });
});

describe("共同管理者（SDK ADR 0135；Cinderous ADR-0418）", () => {
  const coSk = generateSecretKey();
  const co = getPublicKey(coSk);
  const otherSk = generateSecretKey();
  const members = [
    { pubkey: a, name: "Alice" },
    { pubkey: co, name: "Co" },
  ];

  it("擁有者簽的名冊帶 admins：round-trip 保留；不是在世成員、是擁有者自己、重複的都濾掉", () => {
    const ev = signOrgRoster({ ...doc([...members, { pubkey: b, name: "Old", supersededBy: c }, { pubkey: c, name: "New" }]), admins: [co, co, b, admin, d] }, adminSk);
    expect(verifyOrgRoster(ev, admin)?.admins).toEqual([co]);
  });

  it("沒有 admins＝欄位省略（舊格式照常）", () => {
    const ev = signOrgRoster(doc(members), adminSk);
    expect(JSON.parse(ev.content)).not.toHaveProperty("admins");
    expect(verifyOrgRoster(ev, admin)).not.toHaveProperty("admins");
  });

  it("信任設定 {owner, coAdmins}：共同管理者簽的有效；名單外的人簽的無效", () => {
    const trust = { owner: admin, coAdmins: [co] };
    expect(verifyOrgRoster(signOrgRoster(doc(members, 2000), coSk), trust)?.updatedAt).toBe(2000);
    expect(verifyOrgRoster(signOrgRoster(doc(members, 2000), otherSk), trust)).toBeNull();
    expect(verifyOrgRoster(signOrgRoster(doc(members, 2000), adminSk), trust)?.updatedAt).toBe(2000);
  });

  it("🔴 共同管理者不能改管理者名單：它簽的 admins 一律忽略，換成信任設定裡的名單", () => {
    const trust = { owner: admin, coAdmins: [co] };
    const ev = signOrgRoster({ ...doc([...members, { pubkey: b, name: "B" }], 2000), admins: [co, b] }, coSk);
    expect(verifyOrgRoster(ev, trust)?.admins).toEqual([co]);
  });

  it("🔴 共同管理者簽的名冊若把任何一位管理者移出在世成員 → 整份無效", () => {
    const co2Sk = generateSecretKey();
    const co2 = getPublicKey(co2Sk);
    const trust = { owner: admin, coAdmins: [co, co2] };
    // co 把 co2 踢掉
    expect(verifyOrgRoster(signOrgRoster(doc(members, 2000), coSk), trust)).toBeNull();
    // co 把 co2 標成已輪替作廢也一樣
    const rotated = [...members, { pubkey: co2, name: "Co2", supersededBy: d }, { pubkey: d, name: "D" }];
    expect(verifyOrgRoster(signOrgRoster(doc(rotated, 2000), coSk), trust)).toBeNull();
    // 兩位都在 → 有效
    expect(verifyOrgRoster(signOrgRoster(doc([...members, { pubkey: co2, name: "Co2" }], 2000), coSk), trust)).not.toBeNull();
  });

  it("擁有者簽的名冊不受「不能移除管理者」限制（擁有者本來就能改名單）", () => {
    const trust = { owner: admin, coAdmins: [co] };
    const ev = signOrgRoster(doc([{ pubkey: a, name: "Alice" }], 2000), adminSk);
    expect(verifyOrgRoster(ev, trust)?.admins).toBeUndefined();
  });

  it("rosterSigners：擁有者在前，再接共同管理者（供訂閱 authors）", () => {
    expect(rosterSigners(admin, [co, b])).toEqual([admin, co, b]);
    expect(rosterSigners(admin, undefined)).toEqual([admin]);
    expect(rosterSigners(admin, [admin, co])).toEqual([admin, co]);
  });

  it("共同管理者上限 ROSTER_MAX_ADMINS：多的截掉", () => {
    const many = Array.from({ length: ROSTER_MAX_ADMINS + 5 }, (_, i) => ({ pubkey: getPublicKey(generateSecretKey()), name: `M${i}` }));
    const ev = signOrgRoster({ ...doc(many), admins: many.map((m) => m.pubkey) }, adminSk);
    expect(verifyOrgRoster(ev, admin)?.admins).toHaveLength(ROSTER_MAX_ADMINS);
  });
});
