// 混合式金鑰封裝：古典 ECDH ＋ ML-KEM-768（後量子 EK，Phase 2）。
//
// ## 為什麼需要它
//
// NIP-44 的對話金鑰是 `ECDH(寄件者私鑰, 收件者公鑰)`，而收件者公鑰**就是 npub**——
// 公開在每一個中繼站上。一個有量子電腦的攻擊者要解開側錄的密文，只需要**密文與 npub**，
// 不需要偷任何私鑰。
//
// ⚠ **而 ADR-0238 的前向保密對這種攻擊完全不生效**：它靠的是收件人**刪掉** `priv(EK_e)`，
// 那防的是「失竊」；量子攻擊者不需要你那一份，他從公開的 `pub(EK_e)`（kind 10040 明文公告）
// **算出來**。⇒ 我們二十多份 FS 的 ADR 在這個威脅模型下價值是零。
//
// 詳見 `docs/research/post-quantum-ek-plan.md` 與 `signal-triple-ratchet-applicability.md`。
//
// ## 🔴 這個檔案是整個計畫風險最高的地方
//
// 混合式 KDF 若把**古典那一半接錯**（域分離寫錯、某條路徑漏掉 `ssClassic`），
// 結果是**降低了古典安全性**去換一個還沒人需要的後量子性質——
// 而且**不會有任何測試會紅**：兩邊照樣算得出同一把金鑰，訊息一切正常。
//
// ⇒ 本檔的每一個決定都寫出理由，並以測試釘住「少任何一半就導不出同一把金鑰」。
// ⚠ 但測試擋不住設計層的錯誤，**外部密碼學審計仍是唯一的解**（ADR-0306）。
//
// ## 這一層**不**做什麼
//
// - 不碰 NIP-44 的線路格式：`nip44.encrypt(明文, 對話金鑰)` 的第二個參數是**參數**，
//   我們只改「怎麼算出那把金鑰」，payload 仍是 NIP-44 v2。
// - 不做棘輪、不持有狀態：每則訊息各自封裝一次（見計畫 §2.3 為何無狀態）。

import { base64 } from "@scure/base";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** ML-KEM-768 封裝金鑰（公鑰）長度。 */
export const PQ_PUBLIC_KEY_BYTES = 1184;
/** ML-KEM-768 解封裝金鑰（私鑰）長度。 */
export const PQ_SECRET_KEY_BYTES = 2400;
/** ML-KEM-768 密文長度。**每則訊息要多帶這麼多**（base64 後 1452）。 */
export const PQ_CIPHERTEXT_BYTES = 1088;

/**
 * 混合式金鑰導出的域分離字串。
 *
 * 版本字串寫死在這裡是刻意的：日後若換 KEM 參數集或改組合方式，**必須**同時改這個字串，
 * 否則新舊兩版會導出同一把金鑰而沒有人發現。
 */
const HYBRID_LABEL = "cinder-ek-pq-v1";

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
export const PQ_SEED_BYTES = 64;

/** 一對 ML-KEM-768 金鑰（由種子導出，不持久化）。 */
export interface PqKeyPair {
  /** 解封裝金鑰（私鑰），2400 bytes。 */
  sk: Uint8Array;
  /** 封裝金鑰（公鑰），1184 bytes。公告在 kind 10040 的 `pq` 欄位。 */
  pk: Uint8Array;
}

/** 產生一顆新的種子（與古典 EK 同壽命：每週一把、grace 7 天）。 */
export function generatePqSeed(): Uint8Array {
  return randomBytes(PQ_SEED_BYTES);
}

/**
 * 由種子決定性導出金鑰對（FIPS 203 的 KeyGen(d, z)）。
 *
 * ⚠ **這個導出必須跨版本穩定**，否則舊種子會導出不同的金鑰 ⇒ 所有既有訊息解不開。
 * FIPS 203 把它標準化了，任何合規實作結果相同；但我們用的 `@noble/post-quantum`
 * 是 **pre-1.0**，所以 `hybrid-kem.test.ts` 用一組**釘死的測試向量**把它鎖住——
 * 函式庫若改了導出方式，那條測試會紅。
 */
export function pqKeyFromSeed(seed: Uint8Array): PqKeyPair {
  if (seed.length !== PQ_SEED_BYTES) throw new Error("hybrid-kem：種子長度必須是 64 bytes");
  const kp = ml_kem768.keygen(seed);
  return { sk: kp.secretKey, pk: kp.publicKey };
}

/**
 * 封裝（寄件端）：對收件人的 `pk` 產生一份密文與共享祕密。
 *
 * 長度先自己擋一次，錯誤訊息才指得出是「對方公告的 `pq` 欄位壞了」，
 * 而不是從相依函式庫冒出一句看不懂的話。
 */
export function pqEncapsulate(pk: Uint8Array): { ct: Uint8Array; ss: Uint8Array } {
  if (pk.length !== PQ_PUBLIC_KEY_BYTES) throw new Error("hybrid-kem：ML-KEM 公鑰長度不正確");
  const r = ml_kem768.encapsulate(pk);
  return { ct: r.cipherText, ss: r.sharedSecret };
}

/**
 * 解封裝（收件端）。
 *
 * ⚠ **ML-KEM 用的是隱式拒絕**：密文被竄改或金鑰不對時**不會拋錯**，而是回一把
 * 偽隨機的共享祕密 ⇒ 最終在 NIP-44 那層以 MAC 驗證失敗呈現（落進 ADR-0316 的
 * `maybeEkLoss` 桶）。這是**期望行為**，不是缺陷——但讀這段程式的人要知道
 * 「`pqDecapsulate` 成功回傳」**不代表**密文是好的。
 */
export function pqDecapsulate(sk: Uint8Array, ct: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(ct, sk);
}

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
export function hybridConversationKey(args: {
  /** 古典 ECDH 的共享祕密（32 bytes）。 */
  ssClassic: Uint8Array;
  /** ML-KEM 的共享祕密（32 bytes）。 */
  ssPq: Uint8Array;
  /** 這則訊息的 KEM 密文（綁定用）。 */
  ct: Uint8Array;
  /** 層別標籤：`"seal"` 或 `"wrap"`（NIP-59 的兩層各自導出不同金鑰）。 */
  layer: "seal" | "wrap";
}): Uint8Array {
  const { ssClassic, ssPq, ct, layer } = args;
  // 🔴 fail-closed：任一半缺席就拋。靜默退回單邊＝本檔頭警告的那個失敗模式，
  //    而它在測試裡看起來一切正常（兩端照樣算得出同一把金鑰）。
  if (ssClassic.length === 0) throw new Error("hybrid-kem：缺少古典共享祕密（拒絕只用後量子）");
  if (ssPq.length === 0) throw new Error("hybrid-kem：缺少後量子共享祕密（拒絕只用古典）");
  if (ct.length !== PQ_CIPHERTEXT_BYTES) throw new Error("hybrid-kem：KEM 密文長度不正確");

  const ikm = new Uint8Array(ssClassic.length + ssPq.length);
  ikm.set(ssClassic, 0);
  ikm.set(ssPq, ssClassic.length);

  const label = utf8ToBytes(`${HYBRID_LABEL}:${layer}`);
  const info = new Uint8Array(label.length + ct.length);
  info.set(label, 0);
  info.set(ct, label.length);

  return hkdf(sha256, ikm, sha256(utf8ToBytes(HYBRID_LABEL)), info, 32);
}

// ── 儲存與線路上的字串形態 ──────────────────────────────────────────────────
//
// 種子與公鑰在儲存（`StoredFsKey.pq`）與公告（kind 10040 的 `pq`）裡都是 base64 字串。
// 編解碼與長度驗證**只在這裡做一次**，使用端拿到的一律是已經驗過的位元組
// ——不然每個呼叫端都得各自記得驗一次，而漏掉的那個會在別人的裝置上才炸開。

/** 把種子編成可存進 `StoredFsKey.pq` 的字串。 */
export function encodePqSeed(seed: Uint8Array): string {
  return base64.encode(seed);
}

/**
 * 從儲存的字串展開金鑰對。
 *
 * ⚠ **壞值回 `undefined` 而不拋**：這是解封候選清單的來源，一把壞掉的種子
 * （舊版客戶端往返時截斷、手改存檔）不該讓其餘還好的金鑰一起失效。
 */
export function pqKeyFromStored(seed: string): PqKeyPair | undefined {
  try {
    const bytes = base64.decode(seed);
    if (bytes.length !== PQ_SEED_BYTES) return undefined;
    return pqKeyFromSeed(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 讀公告（kind 10040 的 `pq`）帶來的 ML-KEM 公鑰。
 *
 * ⚠ 同樣**回 `undefined` 而不拋**：壞掉的公告只該讓這則訊息退回純古典（今天的基準線），
 * 不該讓訊息送不出去。`readEkAnnounce` 刻意不驗這個欄位，驗在這裡。
 */
export function decodePqPublicKey(b64: string): Uint8Array | undefined {
  try {
    const bytes = base64.decode(b64);
    return bytes.length === PQ_PUBLIC_KEY_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** 把 ML-KEM 公鑰編成公告用的字串。 */
export function encodePqPublicKey(pk: Uint8Array): string {
  return base64.encode(pk);
}
