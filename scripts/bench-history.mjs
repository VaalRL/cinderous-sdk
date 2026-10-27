// 版本歷史的啟動基準（SDK ADR 0063〈待決〉裁示 3）：合成一個 v0.49 格式的歸檔（預設 20,000 個檔案 × 每檔 50 版），
// 量協調器 start() 的時間與堆積記憶體增量：第一次啟動（v0.50：遷移）、第二次啟動（v0.50：只讀每檔摘要）。
// 不在 CI 裡跑（慢、數字依機器而定），也不做計時的斷言。
//
//   npm run build
//   node --expose-gc scripts/bench-history.mjs                      # 量這個 repo 的 dist（v0.50）
//   node --expose-gc scripts/bench-history.mjs --sdk <dist 路徑>    # 量別的版本，例如 v0.49.0 的 dist（見 ADR 0063〈實作 v0.50〉）
//
// 選項：--files 20000 --versions 50 --text 0.8（文字檔比例；文字檔每版有內容，二進位檔只有版本資訊）--content 120（每份內容的位元組）
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const FILES = Number(args.get('files') ?? 20_000);
const VERSIONS = Number(args.get('versions') ?? 50);
const TEXT = Number(args.get('text') ?? 0.8);
const CONTENT = Number(args.get('content') ?? 120);
const sdkDir = path.resolve(args.get('sdk') ?? path.join(import.meta.dirname, '..', 'dist'));
const sdk = await import(pathToFileURL(path.join(sdkDir, 'sync', 'vault', 'index.js')).href);

const enc = new TextEncoder();
const hex = (n, width) => n.toString(16).padStart(width, '0');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

/** v0.49 的狀態儲存：`ha:<fileId>`（每檔的歸檔）、`hc:<hash>`（只有內容）、`m`（沒有 hv） */
function buildStore() {
  const store = new sdk.MemorySyncStateStore();
  const data = new Map();
  let n = 0;
  for (let f = 0; f < FILES; f += 1) {
    const fileId = hex(f, 32);
    const text = f < FILES * TEXT;
    const entries = [];
    for (let v = 0; v < VERSIONS; v += 1) {
      n += 1;
      // 30 天裡均勻分布（越新越密），每檔的時間錯開
      const at = NOW - Math.floor(((VERSIONS - v) / VERSIONS) ** 2 * 29 * DAY) - (f % 1000);
      const body = enc.encode(`${fileId} v${v} `.padEnd(CONTENT, 'x'));
      const hash = sha(body);
      if (text) data.set(`hc:${hash}`, body);
      entries.push({
        versionId: hex(n, 32),
        path: `notes/folder-${Math.floor(f / 100)}/note-${f}.${text ? 'md' : 'png'}`,
        at,
        n,
        device: 'bench',
        label: 'Bench',
        hash,
        size: body.length,
        deleted: false,
        text,
        content: text,
      });
    }
    data.set(`ha:${fileId}`, enc.encode(JSON.stringify({ fileId, entries, born: entries[0].at })));
  }
  data.set('m', enc.encode(JSON.stringify({ hlc: NOW, seq: 0, conflicts: [], hs: n, lastSyncAt: NOW })));
  // 直接放進記憶體儲存（不經 set 的複製，省時間）
  for (const [k, v] of data) void store.set(k, v);
  return store;
}

const transport = { send: async () => {}, onMessage: () => () => {}, onStatusChange: () => () => {}, isOnline: () => false };
const adapter = {
  list: async () => [],
  read: async () => new Uint8Array(),
  write: async () => true,
  remove: async () => true,
  rename: async () => true,
  stat: async () => null,
};
const clock = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} };

async function heap() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.gc?.();
  }
  return process.memoryUsage().heapUsed;
}

async function startOnce(store, label) {
  const base = await heap();
  const t0 = performance.now();
  const sync = new sdk.VaultSyncCoordinator({ adapter, store, transport, deviceId: 'bench', clock, tickMs: 0, scanOnStart: false });
  await sync.start();
  const ms = performance.now() - t0;
  await sync.idle();
  const used = (await heap()) - base;
  const status = sync.historyStatus();
  // 讀一個檔案的歷史（v0.50：第一次才讀那個檔案）
  const t1 = performance.now();
  const h = await sync.history(hex(1, 32));
  const historyMs = performance.now() - t1;
  console.log(
    `${label}: start ${ms.toFixed(0)} ms, heap +${(used / 2 ** 20).toFixed(1)} MiB, files ${status.files}, versions ${status.versions}, ` +
      `history() ${historyMs.toFixed(1)} ms (${h.length} 版)`,
  );
  // 整庫：T 在每個檔案最新版本之後（v0.50 只看摘要）、7 天前（要逐檔讀有變動的檔案）。
  // 用 NOW - 1：啟動後的自動檢查點（合成資料沒有版本圖，清單是空的）在 NOW，T 在它之前才是逐檔推算
  const t2 = performance.now();
  const snap = await sync.vaultAt(NOW - 1);
  const t3 = performance.now();
  const plan = await sync.planRestoreVault(NOW - 7 * DAY);
  const t4 = performance.now();
  console.log(`  vaultAt(剛才) ${(t3 - t2).toFixed(0)} ms（${snap.files.length} 檔）；planRestoreVault(7 天前) ${(t4 - t3).toFixed(0)} ms（改回 ${plan.revert.length}、無法還原 ${plan.unrestorable.length}：合成資料沒有版本圖）`);
  await sync.stop();
}

console.log(`SDK ${sdkDir}；${FILES} 個檔案 × ${VERSIONS} 版（文字檔 ${Math.round(TEXT * 100)}%、每份內容 ${CONTENT} B）`);
const t0 = performance.now();
const store = buildStore();
console.log(`合成歸檔 ${(performance.now() - t0).toFixed(0)} ms，狀態儲存 ${store.size} 個鍵`);
await startOnce(store, '第一次啟動');
await startOnce(store, '第二次啟動');
