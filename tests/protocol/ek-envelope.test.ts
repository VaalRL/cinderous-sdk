import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, nsecEncode } from "../../src/protocol/keys.js";
import { buildEkEnvelope, EK_ENVELOPE_KIND, EK_ENVELOPE_SLOTS, openEkEnvelope, type EkKey } from "../../src/protocol/ek-envelope.js";
import { finalizeEvent } from "../../src/protocol/sign.js";
import { encryptDM } from "../../src/protocol/nip44.js";

const idSk = generateSecretKey();
const idPk = getPublicKey(idSk);
const mkKey = (at: number) => {
  const sk = generateSecretKey();
  return { nsec: nsecEncode(sk), pk: getPublicKey(sk), at };
};
const keys = [mkKey(1), mkKey(2)];

describe("EK per-device 分發（ADR-0322 S2）", () => {
  it("目錄內的裝置解得開；不在目錄內的解不開——**撤銷在此成立**", () => {
    const inDir = generateSecretKey();
    const removed = generateSecretKey();
    const ev = buildEkEnvelope(idSk, [getPublicKey(inDir)], keys, { now: 1 });
    expect(ev.kind).toBe(EK_ENVELOPE_KIND);
    expect(openEkEnvelope(ev, inDir, idPk)).toEqual(keys);
    expect(openEkEnvelope(ev, removed, idPk)).toBeNull(); // 🔴 被移除的裝置拿不到新 EK
  });

  it("多台裝置各自解得開同一份", () => {
    const a = generateSecretKey();
    const b = generateSecretKey();
    const ev = buildEkEnvelope(idSk, [getPublicKey(a), getPublicKey(b)], keys, { now: 1 });
    expect(openEkEnvelope(ev, a, idPk)).toEqual(keys);
    expect(openEkEnvelope(ev, b, idPk)).toEqual(keys);
  });

  it("🔴 密文數不洩漏裝置數：1 台與 5 台的槽數相同", () => {
    const one = buildEkEnvelope(idSk, [getPublicKey(generateSecretKey())], keys, { now: 1 });
    const five = buildEkEnvelope(
      idSk,
      Array.from({ length: 5 }, () => getPublicKey(generateSecretKey())),
      keys,
      { now: 1 },
    );
    expect(JSON.parse(one.content)).toHaveLength(EK_ENVELOPE_SLOTS);
    expect(JSON.parse(five.content)).toHaveLength(EK_ENVELOPE_SLOTS);
  });

  it("超過一組槽位時補到下一個倍數（仍不精確洩漏）", () => {
    const many = buildEkEnvelope(
      idSk,
      Array.from({ length: EK_ENVELOPE_SLOTS }, () => getPublicKey(generateSecretKey())),
      keys,
      { now: 1 },
    );
    expect(JSON.parse(many.content)).toHaveLength(EK_ENVELOPE_SLOTS * 2);
  });

  it("空目錄＝沒有人拿得到（不是「不分發」）", () => {
    const ev = buildEkEnvelope(idSk, [], keys, { now: 1 });
    expect(JSON.parse(ev.content)).toHaveLength(EK_ENVELOPE_SLOTS);
    expect(openEkEnvelope(ev, generateSecretKey(), idPk)).toBeNull();
  });

  it("不信任網路來源：壞簽章／錯 kind／別人簽的一律 null", () => {
    const d = generateSecretKey();
    const ev = buildEkEnvelope(idSk, [getPublicKey(d)], keys, { now: 1 });
    expect(openEkEnvelope({ ...ev, sig: "00".repeat(32) }, d, idPk)).toBeNull();
    expect(openEkEnvelope({ ...ev, kind: 1 }, d, idPk)).toBeNull();
    const other = buildEkEnvelope(generateSecretKey(), [getPublicKey(d)], keys, { now: 1 });
    expect(openEkEnvelope(other, d, idPk)).toBeNull(); // 非該身分所發
  });

  it("畸形內容整份丟棄", () => {
    const d = generateSecretKey();
    const bad = buildEkEnvelope(idSk, [getPublicKey(d)], [{ nsec: "x", pk: "zz", at: 1 }] as never, { now: 1 });
    expect(openEkEnvelope(bad, d, idPk)).toBeNull();
  });
});

// ── 後量子那一半必須通過分發（Phase 3）────────────────────────────────────────
//
// 🔴 `parseKeys` 是**逐欄位重建**的。Phase 3 加 `pq` 之前它是 `out.push({ nsec, pk, at })`
// ⇒ 任何新欄位都會被**靜默丟掉**。後果不是「少一個欄位」，是：從分發事件拿到金鑰的
// 那台裝置只有古典那一半、解不開後量子訊息，而畫面上看起來像「金鑰還沒同步」
// （掉進 ADR-0316 的 maybeEkLoss 桶）。

describe("EK 分發帶得動後量子金鑰（Phase 3）", () => {
  const devSk = generateSecretKey();
  const devPk = getPublicKey(devSk);

  const pqKey = (n: string): EkKey => ({
    nsec: nsecEncode(generateSecretKey()),
    pk: getPublicKey(generateSecretKey()),
    at: 1000,
    pq: `seed-${n}`,
  });

  it("🔴 pq 原樣往返——少了它，收到金鑰的裝置解不開後量子訊息", () => {
    const k = pqKey("a");
    const evt = buildEkEnvelope(idSk, [devPk], [k]);
    const got = openEkEnvelope(evt, devSk, idPk);
    expect(got).toEqual([k]);
    expect(got?.[0]?.pq).toBe("seed-a");
  });

  it("古典與後量子金鑰混在同一份清單裡都過得去（遷移期的常態）", () => {
    const classic: EkKey = { nsec: nsecEncode(generateSecretKey()), pk: getPublicKey(generateSecretKey()), at: 1 };
    const hybrid = pqKey("b");
    const got = openEkEnvelope(buildEkEnvelope(idSk, [devPk], [classic, hybrid]), devSk, idPk);
    expect(got).toEqual([classic, hybrid]);
    expect(got?.[0]?.pq).toBeUndefined();
    expect(got?.[1]?.pq).toBeDefined();
  });

  it("沒有 pq 的舊金鑰照舊（向後相容，不得無中生有）", () => {
    const classic: EkKey = { nsec: nsecEncode(generateSecretKey()), pk: getPublicKey(generateSecretKey()), at: 1 };
    const got = openEkEnvelope(buildEkEnvelope(idSk, [devPk], [classic]), devSk, idPk);
    expect(got?.[0]).not.toHaveProperty("pq");
  });

  it("🔴 pq 型別不對 ⇒ 整份丟棄（壞資料會在使用時才爆，留著只是把錯誤往後推）", () => {
    const broken = [{ nsec: nsecEncode(generateSecretKey()), pk: getPublicKey(generateSecretKey()), at: 1, pq: { 不是: "字串" } }];
    const evt = finalizeEvent(
      { kind: EK_ENVELOPE_KIND, created_at: 1, tags: [], content: JSON.stringify([encryptDM(JSON.stringify(broken), idSk, devPk)]) },
      idSk,
    );
    expect(openEkEnvelope(evt, devSk, idPk)).toBeNull();
  });
});
