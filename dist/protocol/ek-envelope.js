// EK 的 per-device 分發（ADR-0322 S2）：**撤銷在這一步才成立**。
//
// ## 為什麼需要它
//
// 今天 EK 私鑰隨加密雲端快照流動，而快照加密到 **nsec 導出金鑰** ⇒ 任何持有 nsec 的裝置
// 都拿得到新的 EK ⇒ 把一台裝置移出目錄**毫無作用**。改成「對目錄內每台裝置的公鑰各加密一份」，
// 被移除的裝置就拿不到之後的 EK ⇒ 讀不到之後的訊息。
//
// ⚠ 身分層仍然**只有一把 EK**（不是 per-device session，ADR-0322 的關鍵發現），只是送法變點對點。
//
// ## 為什麼要補空槽
//
// 逐台加密會讓密文數量 ＝ 裝置數，**中繼直接數得出你有幾台**——那正是 S1 花力氣藏起來的東西
// （ADR-0322 §「§7 的分歧為何不約束撤銷」）。故補到 `EK_ENVELOPE_SLOTS` 的倍數，
// 空槽是「加密給隨機公鑰的等長垃圾」，與真槽在外觀上不可區分。
import { verifyEvent } from "./sign.js";
import { signWith } from "./key-ops.js";
import { generateSecretKey, getPublicKey } from "./keys.js";
import { decryptDM, encryptDM } from "./nip44.js";
/** EK 分發事件 kind（可取代；接續 10040 公告、10041 目錄）。 */
export const EK_ENVELOPE_KIND = 10042;
/** 槽位補齊粒度：密文數恆為此數的倍數，中繼因此數不出實際裝置數。 */
export const EK_ENVELOPE_SLOTS = 8;
/**
 * 打包 EK 分發事件：對每台裝置各加密一份**同樣的 EK 清單**，補空槽到固定倍數。
 *
 * `devicePks` 為裝置目錄內的裝置公鑰。空清單時回傳只有空槽的事件
 * （語意＝「沒有任何裝置拿得到」，而不是「不分發」——後者會讓呼叫端誤以為成功）。
 */
export function buildEkEnvelope(
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk, devicePks, keys, opts = {}) {
    const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
    const plain = JSON.stringify(keys);
    const slots = devicePks.map((pk) => encryptDM(plain, sk, pk));
    // 補到倍數：對隨機公鑰加密等長垃圾，外觀與真槽不可區分。
    const target = Math.max(EK_ENVELOPE_SLOTS, Math.ceil((slots.length + 1) / EK_ENVELOPE_SLOTS) * EK_ENVELOPE_SLOTS);
    while (slots.length < target) {
        const decoySk = generateSecretKey();
        slots.push(encryptDM(plain, decoySk, getPublicKey(generateSecretKey())));
    }
    return signWith({ kind: EK_ENVELOPE_KIND, created_at: nowSec, tags: [], content: JSON.stringify(slots) }, sk);
}
/**
 * 用**本機裝置私鑰**打開分發事件；不是給我的（每一槽都解不開）回 null。
 *
 * `identityPk` 為身分公鑰（＝事件作者）；NIP-44 對話金鑰對稱，故收端以
 * (deviceSk, identityPk) 導出同一把。非本 kind／非該身分所發／壞簽章一律 null——不信任網路來源。
 */
export function openEkEnvelope(event, deviceSk, identityPk) {
    if (event.kind !== EK_ENVELOPE_KIND)
        return null;
    if (event.pubkey !== identityPk)
        return null;
    if (!verifyEvent(event))
        return null;
    let slots;
    try {
        slots = JSON.parse(event.content);
    }
    catch {
        return null;
    }
    if (!Array.isArray(slots))
        return null;
    for (const ct of slots) {
        if (typeof ct !== "string")
            continue;
        try {
            const parsed = JSON.parse(decryptDM(ct, deviceSk, identityPk));
            const keys = parseKeys(parsed);
            if (keys)
                return keys;
        }
        catch {
            // 這一槽不是給我的（或是空槽）——繼續試下一槽。
        }
    }
    return null;
}
/** 逐欄位驗形狀；任一筆畸形即整份丟棄（不做「盡量修好」）。 */
function parseKeys(raw) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const k of raw) {
        if (!k || typeof k !== "object")
            return null;
        const { nsec, pk, at, pq } = k;
        if (typeof nsec !== "string" || typeof pk !== "string" || typeof at !== "number")
            return null;
        if (!/^[0-9a-f]{64}$/.test(pk) || !Number.isFinite(at))
            return null;
        // 後量子種子（Phase 3）：**缺席合法**（舊金鑰／舊裝置），但**在場就必須是非空字串**。
        // ⚠ 這裡刻意**不**驗 base64 或長度——那是使用端的事，而在這裡誤判會讓整份金鑰被丟掉。
        if (pq !== undefined) {
            if (typeof pq !== "string" || !pq)
                return null;
            out.push({ nsec, pk, at, pq });
            continue;
        }
        out.push({ nsec, pk, at });
    }
    return out;
}
//# sourceMappingURL=ek-envelope.js.map