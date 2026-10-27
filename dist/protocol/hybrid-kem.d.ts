/** ML-KEM-768 封裝金鑰（公鑰）長度。 */
export declare const PQ_PUBLIC_KEY_BYTES = 1184;
/** ML-KEM-768 解封裝金鑰（私鑰）長度。 */
export declare const PQ_SECRET_KEY_BYTES = 2400;
/** ML-KEM-768 密文長度。**每則訊息要多帶這麼多**（base64 後 1452）。 */
export declare const PQ_CIPHERTEXT_BYTES = 1088;
/**
 * 種子長度（FIPS 203 的 `d ‖ z`，各 32 bytes）。
 *
 * 🔵 **我們只存種子，不存展開後的金鑰**——這是實測驅動的設計（Phase 3）。
 * 把 2400 bytes 的私鑰放進 ADR-0322 S2 的 per-device 分發事件，實測讓那顆事件
 * 從 4.5 KB 漲到 **110 KB（中繼 256 KiB 上限的 42%）**——因為分發會對每台裝置各加密一份，
 * 還要補空槽到 8 的倍數（藏裝置數，ADR-0322）。改存 64 bytes 的種子之後那個乘數就無害了。
 *
 * ⚠ 代價：每次用之前要重跑一次 keygen（實測 0.3 ms），在記憶體快取即可。
 */
export declare const PQ_SEED_BYTES = 64;
/** 一對 ML-KEM-768 金鑰（由種子導出，不持久化）。 */
export interface PqKeyPair {
    /** 解封裝金鑰（私鑰），2400 bytes。 */
    sk: Uint8Array;
    /** 封裝金鑰（公鑰），1184 bytes。公告在 kind 10040 的 `pq` 欄位。 */
    pk: Uint8Array;
}
/** 產生一顆新的種子（與古典 EK 同壽命：每週一把、grace 7 天）。 */
export declare function generatePqSeed(): Uint8Array;
/**
 * 由種子決定性導出金鑰對（FIPS 203 的 KeyGen(d, z)）。
 *
 * ⚠ **這個導出必須跨版本穩定**，否則舊種子會導出不同的金鑰 ⇒ 所有既有訊息解不開。
 * FIPS 203 把它標準化了，任何合規實作結果相同；但我們用的 `@noble/post-quantum`
 * 是 **pre-1.0**，所以 `hybrid-kem.test.ts` 用一組**釘死的測試向量**把它鎖住——
 * 函式庫若改了導出方式，那條測試會紅。
 */
export declare function pqKeyFromSeed(seed: Uint8Array): PqKeyPair;
/**
 * 封裝（寄件端）：對收件人的 `pk` 產生一份密文與共享祕密。
 *
 * 長度先自己擋一次，錯誤訊息才指得出是「對方公告的 `pq` 欄位壞了」，
 * 而不是從相依函式庫冒出一句看不懂的話。
 */
export declare function pqEncapsulate(pk: Uint8Array): {
    ct: Uint8Array;
    ss: Uint8Array;
};
/**
 * 解封裝（收件端）。
 *
 * ⚠ **ML-KEM 用的是隱式拒絕**：密文被竄改或金鑰不對時**不會拋錯**，而是回一把
 * 偽隨機的共享祕密 ⇒ 最終在 NIP-44 那層以 MAC 驗證失敗呈現（落進 ADR-0316 的
 * `maybeEkLoss` 桶）。這是**期望行為**，不是缺陷——但讀這段程式的人要知道
 * 「`pqDecapsulate` 成功回傳」**不代表**密文是好的。
 */
export declare function pqDecapsulate(sk: Uint8Array, ct: Uint8Array): Uint8Array;
/**
 * 由古典與後量子兩個共享祕密導出 NIP-44 的對話金鑰（32 bytes）。
 *
 * ```
 * K = HKDF-SHA256(
 *       ikm  = ssClassic ‖ ssPq,          // 🔴 兩半都要，少一半就導不出同一把
 *       salt = SHA256(HYBRID_LABEL),      // 固定域分離
 *       info = layer ‖ ct,                // 綁定「哪一層」與「這份 KEM 密文」
 *     )
 * ```
 *
 * ### 為什麼是這個形狀
 *
 * - **串接兩個祕密再過 KDF**：這是 Signal／Apple／OpenSSH／TLS 混合部署的共同做法。
 *   性質是「攻擊者要同時打破古典與後量子兩邊才有用」——只破一邊，`ikm` 仍有另一半的熵。
 * - **古典那半排在前面且永不省略**：`ssClassic` 是 `undefined` 時**直接拋**（見下），
 *   不是靜默退回純後量子。那個靜默正是本檔頭警告的失敗模式。
 * - **`ct` 進 `info`（綁定 transcript）**：ML-KEM 是 IND-CCA2，`ss` 本就綁著 `ct`，
 *   這一步是保守的額外綁定（同 X-Wing 等組合器的做法），成本為零。
 * - **`layer` 進 `info`**：seal 與 wrap 兩層共用同一份 `ssPq`（只帶一份 `ct` 省 1452 bytes），
 *   靠這個標籤做域分離 ⇒ 兩層導出的金鑰不同。
 *
 * ⚠ **我們沒有照搬任何一個已發表的組合器**（X-Wing 綁的是 X25519，我們是 secp256k1，
 * 且 NIP-44 要的是 HKDF 輸出）。這個構造是依標準做法組出來的，**尚未經過外部審計**。
 *
 * @throws 任一半缺少或長度為 0 時拋——**fail-closed，絕不靜默降級**。
 */
export declare function hybridConversationKey(args: {
    /** 古典 ECDH 的共享祕密（32 bytes）。 */
    ssClassic: Uint8Array;
    /** ML-KEM 的共享祕密（32 bytes）。 */
    ssPq: Uint8Array;
    /** 這則訊息的 KEM 密文（綁定用）。 */
    ct: Uint8Array;
    /** 層別標籤：`"seal"` 或 `"wrap"`（NIP-59 的兩層各自導出不同金鑰）。 */
    layer: "seal" | "wrap";
}): Uint8Array;
/** 把種子編成可存進 `StoredFsKey.pq` 的字串。 */
export declare function encodePqSeed(seed: Uint8Array): string;
/**
 * 從儲存的字串展開金鑰對。
 *
 * ⚠ **壞值回 `undefined` 而不拋**：這是解封候選清單的來源，一把壞掉的種子
 * （舊版客戶端往返時截斷、手改存檔）不該讓其餘還好的金鑰一起失效。
 */
export declare function pqKeyFromStored(seed: string): PqKeyPair | undefined;
/**
 * 讀公告（kind 10040 的 `pq`）帶來的 ML-KEM 公鑰。
 *
 * ⚠ 同樣**回 `undefined` 而不拋**：壞掉的公告只該讓這則訊息退回純古典（今天的基準線），
 * 不該讓訊息送不出去。`readEkAnnounce` 刻意不驗這個欄位，驗在這裡。
 */
export declare function decodePqPublicKey(b64: string): Uint8Array | undefined;
/** 把 ML-KEM 公鑰編成公告用的字串。 */
export declare function encodePqPublicKey(pk: Uint8Array): string;
//# sourceMappingURL=hybrid-kem.d.ts.map