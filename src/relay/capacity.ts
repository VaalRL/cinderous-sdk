/**
 * 共用 DO 的容量政策：保底份額、溢位帶（借用）、粗分級預警（SDK ADR 0042；ADR 0038 P2、ADR 0039 B1）。
 *
 * 這個檔案只放**決策**（純函式），記憶體版（`MessageStore`）與 SQL 版（`SqlMessageStore`）各自執行淘汰，
 * 但「該收、該借、該淘汰誰、該拒」由同一個函式決定——兩個 store 的行為因此不可能各長各的。
 *
 * ## 三層容量（ADR 0039 §決策 2）
 *
 * | 層 | 範圍 | 淘汰順序 | 被別人的寫入擠掉？ | 回應 |
 * |---|---|---|---|---|
 * | 保底 | 每個 key（可尋址＝作者；離線＝收件人，沒有收件人的列＝作者）`guaranteeBytes` 以內 | 最後 | **不會** | `OK true` |
 * | 份額外 | 天花板 C 以內、超出保底的部分 | 第二 | 會（最快到期優先） | `OK true`（快滿時帶 `warning: near-full:`） |
 * | 借用 | C 到 C × (1 + r)，保存 `borrowTtlSeconds`（2 小時） | **最先** | 會 | `OK true "warning: borrowed: 7200: …"` |
 * | 都滿 | — | — | — | `OK false "blocked: ceiling: …"` |
 *
 * ## 決策順序（{@link decideCapacity}）
 *
 * 用量一律是「整顆 DO 這張表的總量」（正常列＋借用列），天花板 C 對**正常寫入**生效、C × (1 + r) 對**借用**生效：
 *
 * 1. `used + need ≤ C` → 正常收下（`fit`）。
 * 2. 淘汰制（車道）而**沒有設保底** → 與 v0.33 逐位元相同的淘汰（`legacy`，最快到期優先、一批最多 256 列）。溢位帶不生效。
 * 3. 正常列本身還放得下（`normal + need ≤ C`），只是借用列佔著 → 刪借用列（最快到期優先）騰出空間，正常收下（`reclaim`）。
 *    這就是使用者原本的構想：「原訂用途開始使用時，借來的資料直接被覆蓋」。
 * 4. 淘汰制＋保底，寫的人（這一則的每個 key）在保底內 → 刪全部借用列＋別人的份額外資料（最快到期優先，每個 key 不低於保底），
 *    事先算好放得下才動手（`excess`）；放不下就拒收，不做半套淘汰。
 * 5. 其餘（拒收制，或寫的人超出保底）→ 溢位帶放得下、而且這個 key 的借用沒超過每 key 上限 → 借用（`borrow`）；否則拒收（`reject`）。
 *    **借用永遠不淘汰任何東西**：帶子滿了，新的借用不擠舊的借用、也不擠別人天花板內的資料（使用者決策，ADR 0039 待決事項 4）。
 *
 * 與既有兩種制度的關係：
 * - **拒收制（嚴格平面）**：永遠不刪別人的正常列；保底在這裡沒有作用（沒有東西會被擠掉），只有溢位帶與預警。
 *   嚴格平面的可尋址（雲端快照 30078、名單 10037…）**不借用**（`addressableBorrows: false`）：借用會把「活躍即永久」的備份變成 2 小時。
 * - **淘汰制（車道）**：沒設保底＝v0.33 原樣（溢位帶不生效——淘汰制本來就收下每一則，帶子只會讓先來的借用被後來的正常寫入覆蓋，沒有好處）；
 *   設了保底＝上面第 4、5 步：超出保底的新寫入只能借用閒置空間，不能擠掉別人天花板內的資料。
 */

/** 借用列的保存秒數（ADR 0039：使用者構想的 2 小時）。中繼不能改事件的 NIP-40 `expiration`（有簽章），只能把儲存欄位的到期時間設短。 */
export const BORROW_TTL_SECONDS = 2 * 60 * 60;

/** 溢位帶內每個 key 最多借多少：帶子的 1/16（ADR 0039 研究結果三 §4）。 */
export const BORROW_KEY_SHARE = 1 / 16;

/** 粗分級預警的最高一級（%）。低於它的那一級由站方設定（例如 80）。只有這兩級——不公開精確用量（ADR 0038 決策 5）。 */
export const NEAR_FULL_TOP_PERCENT = 95;

/** 丟棄計數的上限（每位收件人；超過就停在這裡）。 */
export const DROPPED_COUNT_MAX = 1_000_000;

/** 丟棄計數表最多幾位收件人（收件人可以亂編；超過就刪最久沒更新的）。 */
export const DROPPED_RECIPIENTS_MAX = 10_000;

/** 一次容量決策的結果。 */
export type CapacityDecision =
  | { readonly type: "fit" }
  | { readonly type: "reclaim" }
  | { readonly type: "excess" }
  | { readonly type: "legacy" }
  | { readonly type: "borrow" }
  | { readonly type: "reject" };

/** 決策要知道的事。會花成本的（掃表）一律是延遲取值的函式，只有走到那一步才算。 */
export interface CapacityInput {
  /** 天花板 C（位元組） */
  readonly max: number;
  /** 目前總用量（正常＋借用；取代既有位址時已扣掉被取代的那一列） */
  readonly used: number;
  /** 這次要放進去的位元組（多位收件人＝每人一列的總和） */
  readonly need: number;
  /** 淘汰制（車道）或拒收制（嚴格平面） */
  readonly evicts: boolean;
  /** 保底（位元組）；undefined＝沒有保底 */
  readonly guarantee: number | undefined;
  /** 溢位帶（位元組，C × r）；0＝沒有 */
  readonly band: number;
  /** 這個平面能不能借用（嚴格平面的可尋址不行） */
  readonly planeBorrows: boolean;
  /** 目前借用列的總量（延遲取值） */
  borrowed(): number;
  /** 這一則的每個 key 寫入後都還在保底內嗎（延遲取值） */
  withinGuarantee(): boolean;
  /** 刪掉別人的份額外資料最多騰得出多少（延遲取值；只在第 4 步用） */
  excessAvailable(): number;
  /** 這一則的每個 key 借用後都不超過每 key 上限嗎（延遲取值） */
  borrowFitsPerKey(): boolean;
}

/** 依 {@link CapacityInput} 決定這一則怎麼放（見檔頭的決策順序）。 */
export function decideCapacity(input: CapacityInput): CapacityDecision {
  const { max, used, need } = input;
  if (need > max) return { type: "reject" }; // 單則就超過：淘汰也救不了，別把整顆 DO 清空（v0.33 相同）
  if (used + need <= max) return { type: "fit" };
  // 淘汰制又沒有保底：v0.33 原樣（連借用量都不查——這條路徑的查詢與 v0.33 相同）
  if (input.evicts && input.guarantee === undefined) return { type: "legacy" };
  const borrowed = input.borrowed();
  if (used - borrowed + need <= max) return { type: "reclaim" };
  if (input.evicts && input.withinGuarantee()) {
    return used - borrowed + need - input.excessAvailable() <= max ? { type: "excess" } : { type: "reject" };
  }
  const canBorrow = input.band > 0 && input.planeBorrows && (!input.evicts || input.guarantee !== undefined);
  if (canBorrow && used + need <= max + input.band && input.borrowFitsPerKey()) return { type: "borrow" };
  return { type: "reject" };
}

/** 溢位帶大小（位元組）：C × r，無條件捨去。 */
export function overflowBand(max: number | undefined, ratio: number | undefined): number {
  if (max === undefined || ratio === undefined || !(ratio > 0)) return 0;
  return Math.floor(max * ratio);
}

/** 每個 key 在溢位帶內最多借多少（位元組）。 */
export function borrowPerKey(band: number, configured: number | undefined): number {
  return configured ?? Math.floor(band * BORROW_KEY_SHARE);
}

/**
 * 粗分級預警（ADR 0038 決策 5）：寫入後總用量達天花板的 `percent`％以上回那一級，達 {@link NEAR_FULL_TOP_PERCENT}％ 以上回 95；
 * 其他回 undefined。只有兩級，不回精確百分比——別讓人以寫入探測別人的用量。
 */
export function nearFullGrade(usedAfter: number, max: number | undefined, percent: number | undefined): number | undefined {
  if (max === undefined || percent === undefined || max <= 0) return undefined;
  const ratio = usedAfter / max;
  if (percent < NEAR_FULL_TOP_PERCENT && ratio >= NEAR_FULL_TOP_PERCENT / 100) return NEAR_FULL_TOP_PERCENT;
  return ratio >= percent / 100 ? percent : undefined;
}

/** 借用列的儲存到期時間：原本的有效到期時間與「現在＋借用秒數」取早的。 */
export function borrowedExpiration(effective: number, nowSec: number, ttlSeconds = BORROW_TTL_SECONDS): number {
  return Math.min(effective, nowSec + ttlSeconds);
}

/**
 * 從份額外資料挑出要淘汰的列（最快到期優先、每個 key 不低於保底）。純函式：兩個 store 共用，行為因此一致。
 *
 * @param candidates 已依到期時間由近而遠排好的候選列（只含份額外的 key、已排除這一則自己的 key）
 * @param usage 每個 key 目前的正常用量
 * @param guarantee 保底
 * @param target 要騰出的位元組
 * @returns 選中的列與騰出的總量（可能不足 `target`：呼叫端據此決定拒收、不動手）
 */
export function pickExcess<T extends { readonly owner: string; readonly bytes: number }>(
  candidates: readonly T[],
  usage: ReadonlyMap<string, number>,
  guarantee: number,
  target: number,
): { rows: T[]; freed: number } {
  const left = new Map(usage);
  const rows: T[] = [];
  let freed = 0;
  for (const row of candidates) {
    if (freed >= target) break;
    const current = left.get(row.owner) ?? 0;
    if (current - row.bytes < guarantee) continue; // 刪了就低於保底：跳過，看下一列小的
    left.set(row.owner, current - row.bytes);
    rows.push(row);
    freed += row.bytes;
  }
  return { rows, freed };
}

/** 寄給某位收件人的留言被刪掉的累計（丟棄計數，ADR 0038 M8）。只給收件人本人。 */
export interface DroppedSummary {
  /** 被刪掉幾則（上限 {@link DROPPED_COUNT_MAX}） */
  readonly count: number;
  /** 被刪掉的事件裡最早的 `created_at`（unix 秒） */
  readonly since: number;
  /** 被刪掉的事件裡最晚的 `created_at`（unix 秒） */
  readonly until: number;
}

/** 把一批被刪掉的列併進某位收件人的計數。 */
export function mergeDropped(
  prev: DroppedSummary | undefined,
  count: number,
  since: number,
  until: number,
): DroppedSummary {
  if (prev === undefined || prev.count === 0) return { count: Math.min(count, DROPPED_COUNT_MAX), since, until };
  return {
    count: Math.min(prev.count + count, DROPPED_COUNT_MAX),
    since: Math.min(prev.since, since),
    until: Math.max(prev.until, until),
  };
}
