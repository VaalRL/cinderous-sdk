// 規模（SDK ADR 0025 §效能）：5,000 個檔案的全量掃描與同步，索引與比對都是 O(n)。
// 擋的是 O(n²) 那種「多幾倍檔案就慢幾十倍」的退化，以 1,000 個檔案為基準比倍數（SDK ADR 0073）：
// - 同步：比**寫進狀態儲存的位元組數**（每次跑都一樣、不受機器負載影響；v0.54 每做完一件工作就把整份中繼帳重寫一次，就是這種平方級）；
// - 掃描：比時間（很快、雜訊小）；
// - 牆鐘時間只留很寬的絕對防呆（其他測試平行跑時，同一段程式可以從 8 秒變 37 秒）。
import { describe, expect, it } from 'vitest';

import { type Device, MemoryVault, Net } from './harness.js';

function fill(vault: MemoryVault, n: number): void {
  for (let i = 0; i < n; i += 1) vault.userWrite(`folder-${i % 50}/note-${i}.md`, `# ${i}\n內容 ${i}\n`);
}

/** 這台的狀態儲存寫了多少位元組（包住 `set`） */
function countWrites(device: Device): { bytes: number } {
  const counter = { bytes: 0 };
  const store = device.store as unknown as { set(key: string, value: Uint8Array): Promise<void> };
  const set = store.set.bind(store);
  store.set = (key, value) => {
    counter.bytes += key.length + value.length;
    return set(key, value);
  };
  return counter;
}

async function timeScan(n: number) {
  const net = new Net();
  const vault = new MemoryVault();
  fill(vault, n);
  const a = await net.add('a', { online: false, vault, options: { scanOnStart: false } });
  let t = performance.now();
  await a.sync.scan();
  const first = performance.now() - t;
  t = performance.now();
  await a.sync.scan();
  const again = performance.now() - t;
  return { net, a, first, again };
}

/** 把 `a` 的檔案同步到一台新裝置：花多久、兩台的狀態儲存一共寫了多少位元組 */
async function measureSync(net: Net, a: Device): Promise<{ ms: number; bytes: number; b: Device }> {
  const b = await net.add('b');
  const wa = countWrites(a);
  const wb = countWrites(b);
  const t = performance.now();
  a.transport.setOnline(true);
  await net.settle();
  const ms = performance.now() - t;
  expect(b.sync.index().length).toBe(a.sync.index().length);
  return { ms, bytes: wa.bytes + wb.bytes, b };
}

describe('規模', () => {
  it('5,000 個檔案：首次掃描、無變更重掃、少量變更重掃、同步到另一台', { timeout: 600_000 }, async () => {
    const small = await timeScan(1000);
    const smallSync = await measureSync(small.net, small.a);
    const { net, a, first, again } = await timeScan(5000);
    expect(a.sync.index()).toHaveLength(5000);
    expect(a.sync.status().queue).toBe(5000);

    // 少量變更：只讀有變的檔案
    a.vault.userWrite('folder-3/note-3.md', '改了');
    a.vault.userRename('folder-4/note-4.md', 'folder-4/renamed.md');
    const reads: string[] = [];
    const read = a.vault.read.bind(a.vault);
    a.vault.read = async (path) => {
      reads.push(path);
      return read(path);
    };
    const t = performance.now();
    await a.sync.scan();
    const incremental = performance.now() - t;
    expect(reads.sort()).toEqual(['folder-3/note-3.md', 'folder-4/renamed.md']);

    // 同步到新裝置
    const sync = await measureSync(net, a);
    expect(Object.keys(sync.b.vault.tree())).toHaveLength(5000);
    expect(sync.b.vault.get('folder-4/renamed.md')).toBe('# 4\n內容 4\n');

    // 不經 console：vitest 會把通過的測試的 console 輸出吞掉
    process.stdout.write(
      `[scale] 1,000 首次掃描 ${small.first.toFixed(0)}ms、同步 ${smallSync.ms.toFixed(0)}ms／寫入 ${(smallSync.bytes / 1e6).toFixed(1)} MB；` +
        `5,000 首次掃描 ${first.toFixed(0)}ms、無變更重掃 ${again.toFixed(0)}ms、兩個變更重掃 ${incremental.toFixed(0)}ms、` +
        `同步 ${sync.ms.toFixed(0)}ms／寫入 ${(sync.bytes / 1e6).toFixed(1)} MB` +
        String.fromCharCode(10),
    );
    // 同步寫進狀態儲存的量：線性約 5 倍、平方級約 25 倍。v0.53 是 7.6 倍（46 MB）、v0.54 的退化是 24.5 倍（4.6 GB）
    expect(sync.bytes).toBeLessThan(smallSync.bytes * 12);
    // 掃描：線性的話 5 倍檔案約 5 倍時間；O(n²) 會是 25 倍。下限照顧量太小時的雜訊
    expect(first).toBeLessThan(Math.max(small.first * 15, 3000));
    // 無變更／少量變更重掃：只比大小與時間，不該隨檔案數讀內容；以首次掃描為基準
    expect(again).toBeLessThan(Math.max(first / 2, 2_000));
    expect(incremental).toBeLessThan(Math.max(first / 2, 2_000));
    // 很寬的絕對防呆（機器再忙也不該到這裡）
    expect(sync.ms).toBeLessThan(300_000);
  });
});
