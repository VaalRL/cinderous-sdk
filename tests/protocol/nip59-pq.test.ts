// NIP-59 的混合式（後量子）封裝（ADR-0365）。
//
// 這一組測試要釘住三件會靜默出錯的事：
//   1. **向後相容**：任一端還沒升級時，訊息照樣通。漸進升級期間不能斷訊。
//   2. **fail-closed**：對方用了混合式而我缺後量子私鑰時要**拋**，不得退回純古典。
//   3. **拔掉 pqct 只會斷訊，不會降級**——這是「有沒有真的接上」的分界線。

import { describe, expect, it } from "vitest";
import { generatePqSeed, pqKeyFromSeed } from "../../src/protocol/hybrid-kem.js";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { openWrap, PQ_CT_TAG, sealAndWrap } from "../../src/protocol/nip59.js";
import { openWrapWithEks } from "../../src/protocol/subkey.js";
import { verifyEvent } from "../../src/protocol/sign.js";

const nowSec = Math.floor(Date.now() / 1000);
const rumor = (content: string) => ({ kind: 14, created_at: nowSec, tags: [["t", "x"]], content });
const wrapSpec = { kind: 1059, tags: [["p", "aa"], ["expiration", "123"]] };

/** 一位收件人：古典 EK ＋（可選）同一把 EK 的 ML-KEM 金鑰。 */
function recipient() {
  const sk = generateSecretKey();
  const seed = generatePqSeed();
  const pq = pqKeyFromSeed(seed);
  return { sk, pk: getPublicKey(sk), pqPk: pq.pk, pqSk: pq.sk, seed };
}

describe("混合式封裝：向後相容", () => {
  it("不帶 pq ⇒ 行為與現況完全相同（無 pqct tag、裸私鑰解得開）", () => {
    const a = generateSecretKey();
    const b = recipient();
    const evt = sealAndWrap(rumor("hello"), a, b.pk, wrapSpec);
    expect(evt.tags.some((t) => t[0] === PQ_CT_TAG)).toBe(false);
    const opened = openWrap(evt, b.sk);
    expect(opened.rumor.content).toBe("hello");
    expect(opened.sender).toBe(getPublicKey(a));
  });

  it("🔴 寄件人還沒升級、收件人已升級 ⇒ 照樣解得開（不能因為我有 pqSk 就要求對方一定要用）", () => {
    // 這條是漸進升級能不能走的關鍵。壞掉的話，先升級的人會收不到還沒升級的人的訊息。
    const a = generateSecretKey();
    const b = recipient();
    const evt = sealAndWrap(rumor("legacy sender"), a, b.pk, wrapSpec); // 純古典
    expect(openWrap(evt, { sk: b.sk, pqSk: b.pqSk }).rumor.content).toBe("legacy sender");
  });

  it("傳字串與傳 { pk } 等價（寬鬆型別不得改變語意）", () => {
    const a = generateSecretKey();
    const b = recipient();
    const evt = sealAndWrap(rumor("same"), a, { pk: b.pk }, wrapSpec);
    expect(evt.tags.some((t) => t[0] === PQ_CT_TAG)).toBe(false);
    expect(openWrap(evt, b.sk).rumor.content).toBe("same");
  });
});

describe("混合式封裝：兩端都升級", () => {
  it("往返成功，且寄件人身分仍經簽章驗證", () => {
    const a = generateSecretKey();
    const b = recipient();
    const evt = sealAndWrap(rumor("pq hello"), a, { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const opened = openWrap(evt, { sk: b.sk, pqSk: b.pqSk });
    expect(opened.rumor.content).toBe("pq hello");
    expect(opened.sender).toBe(getPublicKey(a));
  });

  it("外層多一個 pqct tag，其餘 tags 原封不動（#p 路由與 expiration 不能被動到）", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    expect(evt.tags.filter((t) => t[0] === "p")).toEqual([["p", "aa"]]);
    expect(evt.tags.filter((t) => t[0] === "expiration")).toEqual([["expiration", "123"]]);
    const ct = evt.tags.find((t) => t[0] === PQ_CT_TAG);
    expect(ct?.[1]).toHaveLength(1452); // base64(1088 bytes)
  });

  it("外層事件本身仍是合法簽章事件（pqct 進 id ⇒ 被簽章覆蓋）", () => {
    // 🔵 這一點很重要：tag 進了事件 id，所以中繼**拔不掉**——拔掉簽章就不對了。
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    expect(verifyEvent(evt)).toBe(true);
  });

  it("只多出 KEM 密文那些位元組（體積成本是可預期的）", () => {
    const a = generateSecretKey();
    const b = recipient();
    const plain = sealAndWrap(rumor("y"), a, b.pk, wrapSpec);
    const pq = sealAndWrap(rumor("y"), a, { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const grew = JSON.stringify(pq).length - JSON.stringify(plain).length;
    expect(grew).toBeGreaterThan(1452);
    expect(grew).toBeLessThan(1452 + 100); // tag 名與 JSON 標點
  });

  it("每則訊息各自封裝一次（同樣的收件人送兩則 ⇒ ct 不同）", () => {
    const a = generateSecretKey();
    const b = recipient();
    const one = sealAndWrap(rumor("1"), a, { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const two = sealAndWrap(rumor("2"), a, { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const ctOf = (e: typeof one) => e.tags.find((t) => t[0] === PQ_CT_TAG)?.[1];
    expect(ctOf(one)).not.toBe(ctOf(two));
  });

  it("種子可以重新展開成同一把私鑰（儲存層只留 64 bytes 的前提）", () => {
    const a = generateSecretKey();
    const b = recipient();
    const evt = sealAndWrap(rumor("from seed"), a, { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const reopened = pqKeyFromSeed(b.seed); // 模擬重開 app 後從儲存的種子展開
    expect(openWrap(evt, { sk: b.sk, pqSk: reopened.sk }).rumor.content).toBe("from seed");
  });
});

describe("🔴 fail-closed 與降級", () => {
  it("對方用了混合式、我只帶古典私鑰 ⇒ **拋**，不得靜默退回", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    expect(() => openWrap(evt, b.sk)).toThrow(/ML-KEM/);
  });

  it("拔掉 pqct ⇒ 拋（斷訊），**不會**變成解得開的古典訊息", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const stripped = { ...evt, tags: evt.tags.filter((t) => t[0] !== PQ_CT_TAG) };
    expect(() => openWrap(stripped, { sk: b.sk, pqSk: b.pqSk })).toThrow();
    expect(() => openWrap(stripped, b.sk)).toThrow();
  });

  it("換成另一份合法的 ct ⇒ 拋（ML-KEM 隱式拒絕，最後由 NIP-44 的 MAC 擋下）", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const other = sealAndWrap(rumor("z"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const swapped = {
      ...evt,
      tags: evt.tags.map((t) => (t[0] === PQ_CT_TAG ? other.tags.find((o) => o[0] === PQ_CT_TAG)! : t)),
    };
    expect(() => openWrap(swapped, { sk: b.sk, pqSk: b.pqSk })).toThrow();
  });

  it("用別人的 ML-KEM 私鑰 ⇒ 拋（解封裝不拋，但導出的金鑰不同）", () => {
    const b = recipient();
    const c = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    expect(() => openWrap(evt, { sk: b.sk, pqSk: c.pqSk })).toThrow();
  });

  it("壞掉的 pqct（非 base64／長度不對）⇒ 拋且訊息指得出問題", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const bad = (v: string) => ({ ...evt, tags: evt.tags.map((t) => (t[0] === PQ_CT_TAG ? [PQ_CT_TAG, v] : t)) });
    expect(() => openWrap(bad("!!!not base64!!!"), { sk: b.sk, pqSk: b.pqSk })).toThrow(/pqct/);
    expect(() => openWrap(bad("AAAA"), { sk: b.sk, pqSk: b.pqSk })).toThrow(/pqct/);
  });

  it("公告的 pq 公鑰長度不對 ⇒ 寄件端就拋（不會送出一則沒人解得開的訊息）", () => {
    const b = recipient();
    expect(() =>
      sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk.slice(0, 100) }, wrapSpec),
    ).toThrow(/公鑰長度/);
  });
});

describe("openWrapWithEks 的候選清單可以混用", () => {
  it("古典候選先失敗、混合式候選命中", () => {
    const b = recipient();
    const stale = generateSecretKey(); // 過期的舊 EK
    const evt = sealAndWrap(rumor("mixed"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    const opened = openWrapWithEks(evt, [stale, { sk: b.sk, pqSk: b.pqSk }]);
    expect(opened.rumor.content).toBe("mixed");
  });

  it("純古典訊息命中帶 pqSk 的候選（升級後仍收得到舊訊息）", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("old"), generateSecretKey(), b.pk, wrapSpec);
    expect(openWrapWithEks(evt, [{ sk: b.sk, pqSk: b.pqSk }]).rumor.content).toBe("old");
  });

  it("全部候選都缺後量子私鑰 ⇒ 拋（呼叫端會落進 ADR-0316 的待解桶）", () => {
    const b = recipient();
    const evt = sealAndWrap(rumor("x"), generateSecretKey(), { pk: b.pk, pq: b.pqPk }, wrapSpec);
    expect(() => openWrapWithEks(evt, [generateSecretKey(), b.sk])).toThrow();
  });
});
