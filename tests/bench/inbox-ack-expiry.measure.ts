// 收件確認的效益基準（ADR 0067 實作計畫第 4 項；2026-10-11 的模擬改成可重跑）：
// 1. 用協調器的測試環境跑 CinderSync 式的排程同步（每小時一輪、平常不連線），錄下協調器送出的每一則訊息。
// 2. 每一則經真正的 NostrVaultTransport 包成 kind 1060 禮物包（真實大小、created_at 倒填、expiration）。
// 3. 以 relay-replay.ts 的簡化中繼重放：基準（放滿保存期）對比收件人每輪處理完把自己的列降為「現在＋寬限」。
// 不在 CI 裡跑（14 天兩個情境約幾分鐘，數字依亂數種子而定、不依機器），也不做斷言；模型本身的測試在 relay-replay.test.ts。
//
//   npm run measure:inbox-ack
//   DAYS=7 GRACES=120,60,0 SCENARIOS=normal MEASURE_OUT=out.txt npm run measure:inbox-ack
//
// GRACES 單位是分鐘（預設 120＝PUBLIC_LANE_RETENTION_SECONDS、60、0）；基準一定會跑。
import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { TIMESTAMP_JITTER_SECONDS } from '../../src/protocol/nip59.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import type { PublishResult } from '../../src/relay-pool.js';
import { PUBLIC_LANE_RETENTION_SECONDS } from '../../src/relay/host-config.js';
import { createNostrVaultTransport, type VaultSendOptions, type VaultSyncMessage } from '../../src/sync/vault/index.js';
import { Net, rng } from '../sync/vault/harness.js';
import { replayRelay, type ReplayRound, type ReplayRow } from './relay-replay.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAYS = Number(process.env.DAYS ?? 14);
const GRACES = (process.env.GRACES ?? `${PUBLIC_LANE_RETENTION_SECONDS / 60},60,0`).split(',').map((m) => Number(m) * 60_000);
const SCENARIOS = (process.env.SCENARIOS ?? 'normal,phone-away').split(',');
const DEVICES = ['desk', 'lap', 'phone'] as const;
type Dev = (typeof DEVICES)[number];

function log(line: string): void {
  process.stdout.write(`${line}\n`); // 不經 console：vitest 會把通過的測試的 console 輸出吞掉
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
}

interface Captured { at: number; from: Dev; message: VaultSyncMessage; options?: VaultSendOptions }

/** 每天的上線輪次（當天第幾小時）。phone-away：手機第 2–6 天沒上線 */
function roundsOf(dev: Dev, scenario: string, day: number): number[] {
  if (dev === 'desk') return [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  if (dev === 'lap') return day % 7 >= 5 ? [10, 15, 21] : [20, 21, 22, 23];
  if (scenario === 'phone-away' && day >= 1 && day <= 5) return [];
  return [8, 12.5, 22.25];
}

/** 每輪之前一小時內的修改：桌機 3 篇、筆電 2 篇、手機日記＋中午兩張 1.5 MB 照片 */
function edits(dev: Dev, hour: number, day: number, random: () => number): Array<{ path: string; size: number; binary?: boolean }> {
  const out: Array<{ path: string; size: number; binary?: boolean }> = [];
  const pick = () => `notes/n${Math.floor(random() * 300)}.md`;
  if (dev === 'desk') for (let i = 0; i < 3; i += 1) out.push({ path: pick(), size: 2000 + Math.floor(random() * 4000) });
  if (dev === 'lap') for (let i = 0; i < 2; i += 1) out.push({ path: pick(), size: 2000 + Math.floor(random() * 4000) });
  if (dev === 'phone') {
    out.push({ path: `daily/d${day}.md`, size: 500 + Math.floor(random() * 1500) });
    if (hour === 12.5) for (let i = 0; i < 2; i += 1) out.push({ path: `attachments/p${day}-${i}.jpg`, size: 1_500_000, binary: true });
  }
  return out;
}

async function capture(scenario: string): Promise<{ captured: Captured[]; start: number; rounds: ReplayRound[] }> {
  // 和 CinderSync 相同的摘要規則（on-change、一天最多一份）
  const net = new Net({ seed: 7, options: { digestPolicy: 'on-change', digestMinIntervalMs: DAY, digestMaxIntervalMs: DAY } });
  const random = rng(42);
  const devs = {} as Record<Dev, Awaited<ReturnType<Net['add']>>>;
  for (const d of DEVICES) devs[d] = await net.add(d);
  // 起始：300 篇筆記，全部在線同步完（不計入）
  for (let i = 0; i < 300; i += 1) await devs.desk.edit(`notes/n${i}.md`, 'x'.repeat(2000));
  await net.settle();
  for (const d of DEVICES) devs[d].transport.setOnline(false);
  const captured: Captured[] = [];
  for (const d of DEVICES) {
    const t = devs[d].transport;
    const send = t.send.bind(t);
    t.send = async (message, options) => {
      await send(message, options);
      captured.push({ at: net.clock.now(), from: d, message, options });
    };
  }
  const start = Math.ceil(net.clock.now() / DAY) * DAY;
  await net.clock.advanceTo(start);
  const rounds: ReplayRound[] = [];
  for (let day = 0; day < DAYS; day += 1) for (const dev of DEVICES) for (const h of roundsOf(dev, scenario, day)) rounds.push({ at: start + day * DAY + h * HOUR, dev });
  rounds.sort((a, b) => a.at - b.at);
  let version = 0;
  for (const { at, dev: name } of rounds) {
    const dev = name as Dev;
    // 這一輪之前一小時內的修改（打字：每篇存 5 次）
    await net.clock.advanceTo(at - 30 * 60_000);
    const day = Math.floor((at - start) / DAY);
    const hour = (at - start - day * DAY) / HOUR;
    for (const e of edits(dev, hour, day, random)) {
      for (let s = 0; s < (e.binary ? 1 : 5); s += 1) {
        version += 1;
        const body = e.binary ? Uint8Array.from({ length: e.size }, (_, i) => (i * 31 + version) & 0xff) : `v${version} ` + 'y'.repeat(Math.floor((e.size * (s + 1)) / 5));
        await devs[dev].edit(e.path, body);
        await net.clock.advance(2000);
      }
    }
    await net.clock.advanceTo(at);
    devs[dev].transport.setOnline(true);
    for (let i = 0; i < 40; i += 1) {
      await net.clock.advance(15_000);
      if (devs[dev].sync.status().queue === 0 && net.hub.inflight === 0) break;
    }
    devs[dev].transport.setOnline(false);
  }
  return { captured, start, rounds };
}

/** 經真正的傳輸層包成禮物包，記下每顆的大小、收件人、created_at 與 expiration */
async function wrap(captured: Captured[]): Promise<ReplayRow[]> {
  const ids = Object.fromEntries(DEVICES.map((d) => [d, Identity.generate()])) as Record<Dev, Identity>;
  const devOf = (pk: string) => DEVICES.find((d) => ids[d].pubkey === pk);
  const rows: ReplayRow[] = [];
  let now = 0;
  const transports = Object.fromEntries(DEVICES.map((d) => {
    const pool = {
      publish: async (event: { tags: string[][]; created_at: number }): Promise<PublishResult> => {
        const p = event.tags.find((t) => t[0] === 'p')![1]!;
        const exp = Number(event.tags.find((t) => t[0] === 'expiration')![1]);
        rows.push({ recipient: devOf(p)!, bytes: JSON.stringify(event).length, createdAt: event.created_at * 1000, expiresAt: exp * 1000, receivedAt: now });
        return { accepted: ['wss://r'], rejected: [] } as unknown as PublishResult;
      },
      subscribe: () => ({ close() {} }),
    };
    return [d, createNostrVaultTransport({
      pool: pool as never,
      signer: ids[d],
      devices: DEVICES.filter((x) => x !== d).map((x) => ids[x].pubkey),
      deviceOf: (pk) => devOf(pk),
      now: () => now,
      relayBudget: new RelayEventBudget({ perMinute: 1e9 }),
    })];
  })) as Record<Dev, ReturnType<typeof createNostrVaultTransport>>;
  for (const c of captured) {
    now = c.at;
    await transports[c.from].send(c.message, c.options);
  }
  return rows;
}

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;

describe('收件確認的效益（基準，不進 CI）', () => {
  for (const scenario of SCENARIOS) {
    it(scenario, async () => {
      const { captured, start, rounds } = await capture(scenario);
      const rows = await wrap(captured);
      const types = new Map<string, number>();
      for (const c of captured) types.set(c.message.type, (types.get(c.message.type) ?? 0) + 1);
      log(`\n=== ${scenario}（${DAYS} 天）：協調器訊息 ${captured.length} 則 ${JSON.stringify(Object.fromEntries(types))}；禮物包 ${rows.length} 顆、${mb(rows.reduce((a, r) => a + r.bytes, 0))}`);
      for (const graceMs of [null, ...GRACES]) {
        const r = replayRelay(rows, rounds, { end: start + DAYS * DAY, graceMs, jitterMs: TIMESTAMP_JITTER_SECONDS * 1000 });
        const label = graceMs === null ? '基準（放滿保存期）' : `確認後寬限 ${graceMs / 60_000} 分`;
        const pct = ((100 * r.repeatedBytes) / Math.max(1, r.downloadedBytes)).toFixed(0);
        log(`${label}：中繼佔用 平均 ${mb(r.avgBytes)} 峰值 ${mb(r.peakBytes)}；每收件人峰值列數 ${JSON.stringify(r.peakRowsPer)}；補拉下載 ${mb(r.downloadedBytes)}（${r.downloadedRows} 顆），其中重複 ${mb(r.repeatedBytes)}（${r.repeatedRows} 顆，${pct}%）`);
      }
    }, 1_800_000);
  }
});
