import { base64 } from "@scure/base";
import { getEventHash } from "./event.js";
import { hybridConversationKey, PQ_CIPHERTEXT_BYTES, pqDecapsulate, pqEncapsulate, } from "./hybrid-kem.js";
import { generateSecretKey } from "./keys.js";
import { conversationKeyOf, pubkeyOf, signWith } from "./key-ops.js";
import { decryptWithKey, encryptWithKey } from "./nip44.js";
import { finalizeEvent, verifyEvent } from "./sign.js";
import { isNostrSigner } from "./signer.js";
const KIND_SEAL = 13;
/**
 * NIP-59 外層時戳抖動窗（秒）：seal 與 wrap 的 `created_at` 會被隨機往前推最多這麼久，
 * 以免中繼從時戳關聯出社交圖譜。
 *
 * **匯出是必要的**：收件箱增量抓取（`since`，ADR-0109）必須退讓這麼多，否則剛發出、
 * 外層時戳卻落在兩天前的訊息會被濾掉而**靜默漏訊**。
 */
// 倒填上限與中繼共用（SDK ADR 0007）：中繼據此放寬過去時鐘窗，兩邊必須是同一個數字。
export const TIMESTAMP_JITTER_SECONDS = 2 * 86_400;
// ── 後量子混合式封裝（ADR-0365）──────────────────────────────────────────────
//
// ## 線路上多了什麼
//
// 外層 wrap 多一個 tag：`["pqct", base64(ML-KEM 密文)]`，1452 個字元。
// 有這個 tag ＝ 這則走混合式；沒有 ＝ 純古典（現況，對方還沒升級）。
//
// ## 為什麼 ct 只能放在**外層明文 tag**
//
// 收件端要先算出 wrap 那一層的金鑰才解得開內容，而算那把金鑰**就需要 ct** ⇒ 先有雞先有蛋。
// ct 只能放在加密之外的地方 ⇒ 中繼看得到「這則用了後量子」。
// ⚠ 這是一個**新的 metadata 洩漏**，但無法避免，也沒有隱藏的價值：多出來的 1452 bytes
// 本來就從體積上看得出來。
//
// ## 🔴 這**不是**「量子安全的訊息」
//
// 我們換掉的只有**加密**那一半。事件簽章（seal 的 `pubkey`/`sig`、wrap 的一次性金鑰）
// 仍然是 secp256k1 ⇒ 一個真的有量子電腦的攻擊者**照樣偽造得出訊息**。
// 換來的是唯一一件事：**今天被側錄下來的密文，未來解不開**（harvest-now-decrypt-later）。
// ⇒ 文案一律只能寫「實驗性、預設關閉、未經外部審計」，**不得**寫「量子安全」。
//   （`docs/research/post-quantum-ek-plan.md` §5 與 ADR-0306 D2.2 是同一條紅線。）
//
// ## 降級攻擊？——拔掉 tag 只會變成**斷訊**，不是降級
//
// 中繼若把 `pqct` 拔掉，收件端會用純古典金鑰去解 ⇒ NIP-44 的 MAC 驗證失敗 ⇒ 拋錯。
// 攻擊者無法「改成古典版重新加密」，因為那需要偽造 seal 的身分簽章。
// （——除非他已經能打破 secp256k1，而那時他本來就全部都做得到，見上一段。）
/** 外層 wrap 攜帶 ML-KEM 密文的 tag 名。多字元 tag 不被中繼索引，正合需求。 */
export const PQ_CT_TAG = "pqct";
/** 正規化收件目標。 */
export function toRecipient(r) {
    return typeof r === "string" ? { pk: r } : r;
}
/** 正規化解封金鑰。 */
export function toRecipientKey(k) {
    return k instanceof Uint8Array ? { sk: k } : k;
}
/** 讀出外層的 ML-KEM 密文；沒有這個 tag 回 `undefined`（＝純古典，正常路徑）。 */
function readPqCt(evt) {
    const raw = evt.tags.find((t) => t[0] === PQ_CT_TAG)?.[1];
    if (!raw)
        return undefined;
    let ct;
    try {
        ct = base64.decode(raw);
    }
    catch {
        throw new Error("NIP-59：pqct 不是合法的 base64");
    }
    if (ct.length !== PQ_CIPHERTEXT_BYTES)
        throw new Error("NIP-59：pqct 長度不正確");
    return ct;
}
function jitteredPast(nowSec) {
    return nowSec - Math.floor(Math.random() * TIMESTAMP_JITTER_SECONDS);
}
/**
 * NIP-59 通用封裝：rumor → seal(kind 13，寄件人簽) → 外層 wrap（一次性
 * 金鑰簽）。中繼站僅見「指向收件人臨時金鑰的密文」，無法還原寄件人。
 *
 * `recipient` 帶 `pq` 時自動走混合式（ADR-0365）；只傳字串＝維持純古典。
 */
export function sealAndWrap(rumorInput, 
/** 寄件人的原始私鑰，或不交出私鑰的 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
senderSk, recipient, wrap, 
/**
 * seal 層 tags（ADR-0326）：**只有收件人看得到**（seal 加密在 wrap 內），且不影響 `rumor.id`。
 * 預設空＝與 NIP-59 慣例一致。
 */
sealTags = []) {
    const to = toRecipient(recipient);
    const base = { ...rumorInput, pubkey: pubkeyOf(senderSk) };
    const rumor = { id: getEventHash(base), ...base };
    // 🔴 **一則訊息只封裝一次**：seal 與 wrap 共用同一份 `ss_pq`，靠 `layer` 標籤做域分離。
    //    兩層各封裝一次會多花 1452 bytes 換不到安全性——兩把 ct 都是對同一把公鑰封的。
    const kem = to.pq ? pqEncapsulate(to.pq) : undefined;
    /** 導出某一層的對話金鑰；沒有 KEM 就退回現行的純古典金鑰。 */
    const keyFor = (layer, mySk) => {
        const ssClassic = conversationKeyOf(mySk, to.pk);
        if (!kem)
            return ssClassic;
        return hybridConversationKey({ ssClassic, ssPq: kem.ss, ct: kem.ct, layer });
    };
    const seal = signWith({
        kind: KIND_SEAL,
        created_at: jitteredPast(rumorInput.created_at),
        tags: sealTags,
        content: encryptWithKey(JSON.stringify(rumor), keyFor("seal", senderSk)),
    }, senderSk);
    const wrapSk = generateSecretKey();
    return finalizeEvent({
        kind: wrap.kind,
        created_at: wrap.created_at ?? jitteredPast(rumorInput.created_at),
        tags: kem ? [...wrap.tags, [PQ_CT_TAG, base64.encode(kem.ct)]] : wrap.tags,
        content: encryptWithKey(JSON.stringify(seal), keyFor("wrap", wrapSk)),
    }, wrapSk);
}
/**
 * 解開 NIP-59 封裝並驗證寄件人真實性：
 * 1. 解外層 → seal，驗 seal 簽章。
 * 2. 解 seal → rumor。
 * 3. rumor 作者必須等於 seal 簽章者，否則視為偽造。
 *
 * 事件帶 `pqct` 時走混合式；此時 `recipientKey` **必須**附上對應的 `pqSk`，
 * 否則拋（`openWrapWithEks` 會接著試下一把候選金鑰）。
 */
export function openWrap(wrapEvent, 
/** 也可以是不交出私鑰的 `NostrSigner`（例如 `Identity`；只有古典那一半，SDK ADR 0023） */
recipientKey) {
    // `NostrSigner`（例如 `Identity`）只有古典那一半：遇到混合式封裝會在下面 fail-closed
    const { sk, pqSk } = isNostrSigner(recipientKey)
        ? { sk: recipientKey }
        : toRecipientKey(recipientKey);
    const ct = readPqCt(wrapEvent);
    // 🔴 fail-closed：對方用了混合式而我這把金鑰沒有後量子那一半 ⇒ 拋，**不退回純古典**。
    //    退回會靜默算出另一把金鑰，最後還是 MAC 失敗，只是錯誤訊息會變得無法診斷。
    if (ct && !pqSk)
        throw new Error("NIP-59：這則是混合式封裝，此候選金鑰缺少 ML-KEM 私鑰");
    const ssPq = ct && pqSk ? pqDecapsulate(pqSk, ct) : undefined;
    const keyFor = (layer, peerPk) => {
        const ssClassic = conversationKeyOf(sk, peerPk);
        if (!ct || !ssPq)
            return ssClassic;
        return hybridConversationKey({ ssClassic, ssPq, ct, layer });
    };
    const seal = JSON.parse(decryptWithKey(wrapEvent.content, keyFor("wrap", wrapEvent.pubkey)));
    if (!verifyEvent(seal)) {
        throw new Error("NIP-59：seal 簽章無效");
    }
    // NIP-59 規定 seal 是 kind 13（SDK ADR 0012：dm.ts 併入這份實作時，把它原本的這道檢查帶進來）
    if (seal.kind !== KIND_SEAL) {
        throw new Error("NIP-59：seal 的 kind 不是 13");
    }
    const rumor = JSON.parse(decryptWithKey(seal.content, keyFor("seal", seal.pubkey)));
    if (rumor.pubkey !== seal.pubkey) {
        throw new Error("NIP-59：寄件人不一致，可能為偽造");
    }
    // 核對 rumor.id 為其內容的正確雜湊（防偽造 id 污染去重鍵）。
    const { id, ...unsigned } = rumor;
    if (id !== getEventHash(unsigned)) {
        throw new Error("NIP-59：rumor id 與內容不符");
    }
    return { sender: seal.pubkey, rumor, sealTags: seal.tags };
}
//# sourceMappingURL=nip59.js.map