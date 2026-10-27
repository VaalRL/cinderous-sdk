// 三層分流（SDK ADR 0011 §2；PRD 2.4）：一筆要同步的資料該走哪一層。
import { FILE_CHUNK_BYTES, RELAY_FILE_MAX_BYTES_CAP } from './file-relay.js';

export type IngestTier = 'snapshot' | 'file' | 'p2p';

/**
 * 快照層（kind 30078）可放的明文上限：160 KB。
 *
 * 中繼的可尋址事件上限是 262,144 B（`ADDRESSABLE_MAX_BYTES`），但那是**加密後整顆事件**的大小：
 * NIP-44 會把明文補齊到 32 KB 的倍數（這個量級），再 base64 膨脹 4/3。實測：160 KB 的明文包好後
 * 218,931 B；只要再多一點（例如 176 KB）就會補齊到 192 KB，包好後 262,623 B，超過上限。
 * `ingest.test.ts` 真的包一顆最大的快照來驗證這個數字。
 */
export const SNAPSHOT_TIER_MAX_BYTES = 160 * 1024;

/**
 * 檔案塊層（kind 1060）的**預設**上限：每塊 48,000 B × 360 塊 ≈ 16.5 MB（Cinderous ADR-0162）。
 *
 * 沒有中繼宣告單檔上限時（NIP-11 讀不到、或中繼沒有 `cinder_max_file_mb`）用它——也是 v0.24 以前的固定值，
 * 舊版收端只收得下這麼大，所以預設不變（SDK ADR 0029）。中繼有宣告時由 {@link relayTierMaxBytes} 換算。
 */
export const FILE_TIER_MAX_BYTES = FILE_CHUNK_BYTES * 360;

/**
 * 中繼宣告的單檔上限（`cinder_max_file_mb`，MB＝MiB，與中繼的 `fileChunksFor` 同一個換算）→ 位元組。
 * 夾在 [{@link SNAPSHOT_TIER_MAX_BYTES}＋1, {@link RELAY_FILE_MAX_BYTES_CAP}] 之間；壞值回預設 {@link FILE_TIER_MAX_BYTES}。
 * 例：30 → 31,457,280 B（656 塊）。
 */
export function relayTierMaxBytes(maxFileMb: number): number {
  if (typeof maxFileMb !== 'number' || !Number.isFinite(maxFileMb) || maxFileMb <= 0) return FILE_TIER_MAX_BYTES;
  const bytes = Math.floor(maxFileMb * 1024 * 1024);
  return Math.min(RELAY_FILE_MAX_BYTES_CAP, Math.max(SNAPSHOT_TIER_MAX_BYTES + 1, bytes));
}

/**
 * 依大小決定走哪一層：快照、檔案塊，或等兩台同時在線時用 P2P 直傳。
 *
 * `fileTierMaxBytes`：檔案塊層的上限（預設 {@link FILE_TIER_MAX_BYTES}）；依目標中繼的宣告調大時用
 * {@link relayTierMaxBytes} 算（SDK ADR 0029）。
 */
export function classifyPayload(sizeBytes: number, fileTierMaxBytes: number = FILE_TIER_MAX_BYTES): IngestTier {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw new RangeError('classifyPayload：大小必須是非負整數');
  if (sizeBytes <= SNAPSHOT_TIER_MAX_BYTES) return 'snapshot';
  if (sizeBytes <= fileTierMaxBytes) return 'file';
  return 'p2p';
}
