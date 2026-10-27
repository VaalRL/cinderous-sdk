import type { NostrEvent } from "./event.js";
import { type PubkeyHex } from "./keys.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** EK 分發事件 kind（可取代；接續 10040 公告、10041 目錄）。 */
export declare const EK_ENVELOPE_KIND = 10042;
/** 槽位補齊粒度：密文數恆為此數的倍數，中繼因此數不出實際裝置數。 */
export declare const EK_ENVELOPE_SLOTS = 8;
/** 一把 EK（形狀與引擎的 `StoredFsKey` 一致，避免兩處各定義一份）。 */
export interface EkKey {
    /** EK 私鑰（nsec 編碼）。 */
    nsec: string;
    /** EK 公鑰。 */
    pk: PubkeyHex;
    /** 生成時間（毫秒）。 */
    at: number;
    /**
     * 後量子那一半的**種子**（64 bytes，base64；Phase 3）。**可選**＝舊金鑰與舊裝置沒有。
     *
     * 🔵 **存種子而非展開後的 2400-byte 私鑰**，是實測驅動的：分發會對每台裝置各加密一份、
     * 還要補空槽到 8 的倍數（藏裝置數，ADR-0322）⇒ 實測這顆事件會從 **4.5 KB 漲到 110 KB**
     * （中繼 256 KiB 上限的 42%）。換成種子之後那個乘數就無害了。
     *
     * 🔴 **這個欄位非加不可，不是「順便」。** `parseKeys` 是**逐欄位重建**的
     * （`out.push({ nsec, pk, at })`）⇒ 不列進來就會被**靜默丟掉**，
     * 而後果是：從分發事件拿到金鑰的那台裝置只有古典那一半，
     * 解不開後量子訊息 ⇒ 掉進 ADR-0316 的 `maybeEkLoss` 桶，看起來像「金鑰還沒同步」。
     */
    pq?: string;
}
/**
 * 打包 EK 分發事件：對每台裝置各加密一份**同樣的 EK 清單**，補空槽到固定倍數。
 *
 * `devicePks` 為裝置目錄內的裝置公鑰。空清單時回傳只有空槽的事件
 * （語意＝「沒有任何裝置拿得到」，而不是「不分發」——後者會讓呼叫端誤以為成功）。
 */
export declare function buildEkEnvelope(
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk: SecretKeyOrSigner, devicePks: PubkeyHex[], keys: EkKey[], opts?: {
    now?: number;
}): NostrEvent;
/**
 * 用**本機裝置私鑰**打開分發事件；不是給我的（每一槽都解不開）回 null。
 *
 * `identityPk` 為身分公鑰（＝事件作者）；NIP-44 對話金鑰對稱，故收端以
 * (deviceSk, identityPk) 導出同一把。非本 kind／非該身分所發／壞簽章一律 null——不信任網路來源。
 */
export declare function openEkEnvelope(event: NostrEvent, deviceSk: SecretKeyOrSigner, identityPk: PubkeyHex): EkKey[] | null;
//# sourceMappingURL=ek-envelope.d.ts.map