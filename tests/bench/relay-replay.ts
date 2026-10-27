// 收件確認基準測試的中繼重放模型（ADR 0067 實作計畫第 4 項）：簡化的中繼，只看每顆包的大小、收件人與到期。
// 每台上線一輪＝從「上一輪減時間戳抖動」補拉自己的包、處理完，若有確認就把自己已收到的列降為「這一輪＋寬限」。

export interface ReplayRow {
  recipient: string;
  bytes: number;
  /** 包的 created_at（毫秒；NIP-59 會往前倒填） */
  createdAt: number;
  /** 寄到中繼的時間 */
  receivedAt: number;
  /** 寄出時帶的 expiration */
  expiresAt: number;
}

export interface ReplayRound {
  at: number;
  dev: string;
}

export interface ReplayOptions {
  /** 取樣佔用到這個時間為止 */
  end: number;
  /** 確認後的寬限；null＝不確認（基準） */
  graceMs: number | null;
  /** 補拉起點往前退的時間（`TIMESTAMP_JITTER_SECONDS`） */
  jitterMs: number;
  /** 佔用取樣間隔（預設 10 分鐘） */
  sampleMs?: number;
}

export interface ReplayResult {
  downloadedBytes: number;
  downloadedRows: number;
  /** 下載到的包裡，上一輪已經處理過的 */
  repeatedBytes: number;
  repeatedRows: number;
  peakBytes: number;
  avgBytes: number;
  /** 每位收件人同時在中繼上的最多列數 */
  peakRowsPer: Record<string, number>;
}

/** `rounds` 須依時間排序；取樣從第一輪開始 */
export function replayRelay(rows: readonly ReplayRow[], rounds: readonly ReplayRound[], options: ReplayOptions): ReplayResult {
  const exp = rows.map((r) => r.expiresAt);
  const processedAt = new Map<string, number>();
  let downloadedBytes = 0, downloadedRows = 0, repeatedBytes = 0, repeatedRows = 0;
  for (const { at, dev } of rounds) {
    const prev = processedAt.get(dev);
    const since = prev === undefined ? -Infinity : prev - options.jitterMs;
    const done = prev ?? -Infinity;
    rows.forEach((r, i) => {
      if (r.recipient !== dev || r.receivedAt > at || exp[i]! <= at || r.createdAt < since) return;
      downloadedBytes += r.bytes;
      downloadedRows += 1;
      if (r.receivedAt <= done) {
        repeatedBytes += r.bytes;
        repeatedRows += 1;
      }
    });
    processedAt.set(dev, at);
    if (options.graceMs !== null) {
      const cut = at + options.graceMs;
      rows.forEach((r, i) => {
        if (r.recipient === dev && r.receivedAt <= at) exp[i] = Math.min(exp[i]!, cut);
      });
    }
  }
  let peakBytes = 0, sum = 0, samples = 0;
  const peakRowsPer: Record<string, number> = {};
  if (rounds.length > 0) {
    for (let t = rounds[0]!.at; t <= options.end; t += options.sampleMs ?? 600_000) {
      let bytes = 0;
      const per = new Map<string, number>();
      rows.forEach((r, i) => {
        if (r.receivedAt > t || exp[i]! <= t) return;
        bytes += r.bytes;
        per.set(r.recipient, (per.get(r.recipient) ?? 0) + 1);
      });
      peakBytes = Math.max(peakBytes, bytes);
      sum += bytes;
      samples += 1;
      for (const [d, c] of per) peakRowsPer[d] = Math.max(peakRowsPer[d] ?? 0, c);
    }
  }
  return { downloadedBytes, downloadedRows, repeatedBytes, repeatedRows, peakBytes, avgBytes: samples ? sum / samples : 0, peakRowsPer };
}
