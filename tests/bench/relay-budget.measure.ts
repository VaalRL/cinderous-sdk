// 送出端中繼預算的效益基準（ADR 0068 實作計畫第 5 項）：同一份工作量，比較
// - 舊（v0.53 以前）：一本帳、收件人不簽收——每一塊都假設在中繼上放滿保存期；
// - 新（v0.54 起）：每位收件人一本帳、收件人處理完回加密簽收單就劃掉。
// 情境（P2P 打不通，全部經中繼；中繼每位收件人 1,440 塊、保存 7 天，預算 0.75；CinderSync 的每小時 120 則）：
// A. 新裝置加入一個有 FILES 個 SIZE_KB 的附件的 Vault：它要多久才收齊。
// B. 三台、其中一台整段時間離線：另一台要多久才收齊桌機新加的附件（舊版一本帳會被離線那台拖住嗎）。
// 不在 CI 裡跑、不做斷言；數字依參數而定、不依機器（虛擬時鐘）。
//
//   npm run measure:relay-budget
//   FILES=400 SIZE_KB=200 MEASURE_OUT=out.txt npm run measure:relay-budget
import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { type Device, MemoryVault, Net } from '../sync/vault/harness.js';

const HOUR = 3_600_000;
const FILES = Number(process.env.FILES ?? 400);
const SIZE_KB = Number(process.env.SIZE_KB ?? 200);
const QUOTA = 1440;
const RETENTION_MS = 7 * 24 * HOUR;

function log(line: string): void {
  process.stdout.write(`${line}\n`); // 不經 console：vitest 會把通過的測試的 console 輸出吞掉
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
}

type Mode = 'old' | 'new';

function network(mode: Mode): Net {
  const net = new Net({
    p2p: true,
    roundTrip: false,
    options: { relayLimits: { chunksPerRecipient: QUOTA, retentionSeconds: RETENTION_MS / 1000 }, relayBulkPerHour: 120, ...(mode === 'old' ? { receipts: false } : {}) },
  });
  net.mesh!.reachable = () => false;
  return net;
}

/** 舊版：傳輸層不告訴協調器收件人（＝一本帳） */
function legacy(device: Device, mode: Mode): void {
  if (mode === 'old') (device.transport as unknown as { recipients?: unknown }).recipients = undefined;
}

function attachments(vault: MemoryVault): void {
  for (let i = 0; i < FILES; i += 1) vault.userWrite(`att/${i}.bin`, new Uint8Array(SIZE_KB * 1024).fill(i & 0xff));
}

const complete = (d: Device) => Object.keys(d.vault.tree()).filter((p) => p.startsWith('att/')).length === FILES;

/** 推進虛擬時間直到 `done()`，回傳花了多久（毫秒）；上限 `maxMs` */
async function until(net: Net, done: () => boolean, maxMs: number): Promise<number | null> {
  const start = net.clock.now();
  while (!done()) {
    if (net.clock.now() - start > maxMs) return null;
    await net.clock.advance(HOUR);
    for (let i = 0; i < 5; i += 1) await net.clock.advance(1);
  }
  return net.clock.now() - start;
}

const days = (ms: number | null) => (ms === null ? '> 上限' : `${(ms / (24 * HOUR)).toFixed(1)} 天（${(ms / HOUR).toFixed(0)} 小時）`);

describe(`送出端中繼預算（${FILES} 個 × ${SIZE_KB} KB＝${((FILES * SIZE_KB) / 1024).toFixed(0)} MB，P2P 打不通）`, () => {
  it('A. 新裝置加入：收齊要多久', { timeout: 3_600_000 }, async () => {
    for (const mode of ['old', 'new'] as const) {
      const net = network(mode);
      const vault = new MemoryVault();
      attachments(vault);
      const desk = await net.add('desk', { vault, online: false });
      legacy(desk, mode);
      const phone = await net.add('phone');
      legacy(phone, mode);
      desk.transport.setOnline(true);
      const ms = await until(net, () => complete(phone), 60 * 24 * HOUR);
      log(`A ${mode === 'old' ? '舊（一本帳、不簽收）' : '新（每台一本帳＋簽收單）'}：${days(ms)}`);
    }
  });

  it('B. 一台整段時間離線：其他台收齊要多久', { timeout: 3_600_000 }, async () => {
    for (const mode of ['old', 'new'] as const) {
      const net = network(mode);
      const desk = await net.add('desk');
      legacy(desk, mode);
      const phone = await net.add('phone');
      legacy(phone, mode);
      const lap = await net.add('lap');
      legacy(lap, mode);
      lap.transport.setOnline(false);
      attachments(desk.vault);
      await desk.sync.scan();
      const ms = await until(net, () => complete(phone), 60 * 24 * HOUR);
      log(`B ${mode === 'old' ? '舊（一本帳、不簽收）' : '新（每台一本帳＋簽收單）'}：手機收齊 ${days(ms)}（筆電一直離線）`);
    }
  });
});
