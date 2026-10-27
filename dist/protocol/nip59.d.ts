import { type NostrEvent } from "./event.js";
import { type PubkeyHex, type SecretKey } from "./keys.js";
import { type NostrSigner, type SecretKeyOrSigner } from "./signer.js";
/**
 * NIP-59 外層時戳抖動窗（秒）：seal 與 wrap 的 `created_at` 會被隨機往前推最多這麼久，
 * 以免中繼從時戳關聯出社交圖譜。
 *
 * **匯出是必要的**：收件箱增量抓取（`since`，ADR-0109）必須退讓這麼多，否則剛發出、
 * 外層時戳卻落在兩天前的訊息會被濾掉而**靜默漏訊**。
 */
export declare const TIMESTAMP_JITTER_SECONDS: number;
/** 外層 wrap 攜帶 ML-KEM 密文的 tag 名。多字元 tag 不被中繼索引，正合需求。 */
export declare const PQ_CT_TAG = "pqct";
/** 收件目標：古典公鑰，外加（可選）該金鑰的 ML-KEM 封裝金鑰。 */
export interface Recipient {
    /** NIP-44 ECDH 用的公鑰（FS 開啟時是對方的 EK，否則是身分 pk）。 */
    pk: PubkeyHex;
    /**
     * 對應同一把 EK 的 ML-KEM-768 公鑰（1184 bytes，來自 kind 10040 的 `pq` 欄位）。
     * **省略＝純古典**（對方還沒升級，或我方還沒學到）。
     */
    pq?: Uint8Array;
}
/** 收件目標的寬鬆型別：既有呼叫端傳字串即可，**無需改動**。 */
export type RecipientLike = PubkeyHex | Recipient;
/** 正規化收件目標。 */
export declare function toRecipient(r: RecipientLike): Recipient;
/** 解封用的一組金鑰：古典私鑰，外加（可選）同一把 EK 的 ML-KEM 私鑰。 */
export interface RecipientKey {
    sk: SecretKey;
    /**
     * 展開後的 ML-KEM 私鑰（2400 bytes）。
     *
     * ⚠ 儲存層只放 64-byte 種子（見 `hybrid-kem.ts` 的 `PQ_SEED_BYTES`——展開後的金鑰
     * 會讓分發事件從 4.5 KB 漲到 110 KB）。展開由呼叫端負責並快取，**不在這一層做**：
     * `openWrapWithEks` 會逐把候選金鑰重試，在這裡展開等於每次失敗都多跑一次 keygen。
     */
    pqSk?: Uint8Array;
}
/** 解封金鑰的寬鬆型別：既有呼叫端傳 `SecretKey` 即可。 */
export type RecipientKeyLike = SecretKey | RecipientKey;
/** 正規化解封金鑰。 */
export declare function toRecipientKey(k: RecipientKeyLike): RecipientKey;
/** 要被封裝的內層事件（未簽章）。 */
export interface RumorInput {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
}
/** 內層事件加上 id 與作者後的形態。 */
export interface Rumor extends RumorInput {
    id: string;
    pubkey: PubkeyHex;
}
export interface Opened {
    /** 經身分驗證的寄件人公鑰。 */
    sender: PubkeyHex;
    rumor: Rumor;
    /**
     * seal（kind 13）層的 tags（ADR-0326）。
     *
     * **只有解得開 wrap 的收件人看得到**——seal 被加密在 wrap 內層，中繼與其他人都讀不到。
     * 用途：夾帶「不能進 rumor」的逐收件人資訊（如寄件人當前 EK），
     * 因為 `rumor.id` 是跨成員一致的識別碼，放進去會讓每次輪替都產生不同的 id（ADR-0318）。
     */
    sealTags: string[][];
}
/** 外層 Gift Wrap 的設定。 */
export interface WrapSpec {
    /** 外層事件 kind（如 1059 離線私訊、21000-21999 信令）。 */
    kind: number;
    tags: string[][];
    /** 外層時間戳；省略時隨機提前最多兩天以抗時間相關性分析。 */
    created_at?: number;
}
/**
 * NIP-59 通用封裝：rumor → seal(kind 13，寄件人簽) → 外層 wrap（一次性
 * 金鑰簽）。中繼站僅見「指向收件人臨時金鑰的密文」，無法還原寄件人。
 *
 * `recipient` 帶 `pq` 時自動走混合式（ADR-0365）；只傳字串＝維持純古典。
 */
export declare function sealAndWrap(rumorInput: RumorInput, 
/** 寄件人的原始私鑰，或不交出私鑰的 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
senderSk: SecretKeyOrSigner, recipient: RecipientLike, wrap: WrapSpec, 
/**
 * seal 層 tags（ADR-0326）：**只有收件人看得到**（seal 加密在 wrap 內），且不影響 `rumor.id`。
 * 預設空＝與 NIP-59 慣例一致。
 */
sealTags?: string[][]): NostrEvent;
/**
 * 解開 NIP-59 封裝並驗證寄件人真實性：
 * 1. 解外層 → seal，驗 seal 簽章。
 * 2. 解 seal → rumor。
 * 3. rumor 作者必須等於 seal 簽章者，否則視為偽造。
 *
 * 事件帶 `pqct` 時走混合式；此時 `recipientKey` **必須**附上對應的 `pqSk`，
 * 否則拋（`openWrapWithEks` 會接著試下一把候選金鑰）。
 */
export declare function openWrap(wrapEvent: NostrEvent, 
/** 也可以是不交出私鑰的 `NostrSigner`（例如 `Identity`；只有古典那一半，SDK ADR 0023） */
recipientKey: RecipientKeyLike | NostrSigner): Opened;
//# sourceMappingURL=nip59.d.ts.map