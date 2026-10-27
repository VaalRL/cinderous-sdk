// NIP-13 工作量證明（ADR-0366 P2 #11）。
//
// ## 為什麼難度量測住在 core
//
// `relay-core.ts` 早就有 `leadingZeroBits`——中繼用它判「這顆事件夠不夠難」。
// 但只有中繼會量、沒有人會**挖**，`minPowDifficulty` 因此是一個打開就會讓所有人
// 發不出訊息的旋鈕（ARCHITECTURE §5 記的正是這件事）。
//
// 挖礦端與驗證端對「難度」的定義只要差一位元，結果就是「客戶端算得很辛苦、
// 中繼照樣拒收」，而且症狀是安靜的。⇒ 量測函式收斂到 core，中繼**轉引**它
// （與 `shard.ts` 對 `shardPrefix` 的處理同一個做法）。
//
// ## 這不是防濫用的萬靈丹
//
// PoW 擋的是**量**，不是身分——它讓「灌一萬顆事件」變貴，但擋不住一個有耐心的人。
// 它之所以在第三方車道上有價值，是因為那裡的其他手段都失效：金鑰免費（數人沒用）、
// 無 AUTH 時速率桶退回事件作者（自選）。詳見 `docs/research/game-layer-spec.md` §4.7。

import { getEventHash, type EventTemplate, type NostrEvent } from "./event.js";
import { pubkeyOf, signWith } from "./key-ops.js";
import type { SecretKeyOrSigner } from "./signer.js";

/** NIP-13：event id（hex）開頭的零位元數（工作量證明難度）。 */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const ch of hex) {
    const nibble = Number.parseInt(ch, 16);
    if (Number.isNaN(nibble)) break;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/**
 * 挖礦的嘗試次數上限。
 *
 * 期望嘗試次數是 `2^difficulty`，所以這個上限同時是「難度上限」的實質表達：
 * 2^24 ≈ 1,678 萬次，在 JS 裡是十幾秒等級。**超過就拋**而不是繼續轉——
 * 一個轉到天荒地老的迴圈在 UI 執行緒上等同當掉，而當掉比失敗難查得多。
 */
export const DEFAULT_MAX_ITERATIONS = 1 << 24;

/** 取得 `nonce` tag 以外的所有 tag（挖礦時每一輪都要換掉它，不是一直疊上去）。 */
function withoutNonce(tags: string[][]): string[][] {
  return tags.filter((t) => t[0] !== "nonce");
}

/**
 * 對事件挖到指定的 NIP-13 難度，然後**簽一次**。
 *
 * 只算雜湊、不逐輪簽章：Schnorr 簽章比 SHA-256 貴好幾個數量級，逐輪簽等於把成本
 * 花在錯的地方（而且那些簽章一顆都用不到）。
 *
 * `["nonce", <n>, <target>]` 的第三個元素是**自報的目標難度**（NIP-13）：它讓驗證方
 * 分得出「這顆剛好湊巧有幾個前導零」與「這顆是為了某個目標挖出來的」。
 *
 * @throws 達到 `maxIterations` 仍未達標時拋出——呼叫端應把難度調低或改用背景執行緒。
 */
export function minePow(
  template: EventTemplate,
  /** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
  sk: SecretKeyOrSigner,
  difficulty: number,
  opts: { maxIterations?: number } = {},
): NostrEvent {
  if (!Number.isInteger(difficulty) || difficulty < 0) {
    throw new Error(`難度必須是非負整數，收到 ${String(difficulty)}`);
  }
  if (difficulty === 0) return signWith(template, sk);

  const pubkey = pubkeyOf(sk);
  const baseTags = withoutNonce(template.tags);
  const limit = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const target = String(difficulty);

  for (let nonce = 0; nonce < limit; nonce++) {
    const tags = [...baseTags, ["nonce", String(nonce), target]];
    const candidate = { ...template, tags, pubkey };
    if (leadingZeroBits(getEventHash(candidate)) >= difficulty) {
      // 只有中獎的那一輪才簽章。
      const event = signWith({ ...template, tags }, sk);
      // 簽章者回報的 pubkey 與它實際簽的不一致時，id 會變、難度就不成立：寧可拋，不送出不及格的事件
      if (!meetsPow(event, difficulty)) throw new Error("挖礦：簽章者的 pubkey 與簽出的事件不一致");
      return event;
    }
  }
  throw new Error(`挖礦未達難度 ${difficulty}（已嘗試 ${limit} 次）`);
}

/**
 * 事件是否達到指定難度（中繼端的判定）。
 *
 * ⚠ **只看 id 的前導零，不看 `nonce` tag 自報的 target**：自報值是給人看的提示，
 * 不是證據——拿它當判準等於讓發送方自己決定及不及格。
 */
export function meetsPow(event: Pick<NostrEvent, "id">, difficulty: number): boolean {
  return leadingZeroBits(event.id) >= difficulty;
}
