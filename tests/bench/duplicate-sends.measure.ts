// 同一個版本送給同一台不只一次：各自是什麼原因（CinderSync 待辦「調查同一版本重複送出」）。
// 每則送出的版本訊息（`node`、`nodes`）記下收件人；同一台第二次以後收到同一個版本算一次「重送」，依送出前發生的事分類：
// - want：收件人送出前一份之後，又來要這個版本（例如收到摘要時版本還在路上、缺父版本）；
// - stale-digest：前一份送出之後，寄件人才處理到收件人**在那之前**產生的摘要（摘要說對方沒有，其實已經在路上）；
// - digest：收件人在前一份之後送了摘要，摘要裡沒有這個版本；
// - in-flight：前一份還沒送到收件人（中繼延遲）；
// - other：以上皆非。
// 不在 CI 裡跑、不做斷言；虛擬時鐘、固定種子。
//
//   npm run measure:duplicate-sends
//
// 結果記在 SDK ADR 0074（修掉過時的摘要之前與之後）。
import { describe, it } from 'vitest';

import type { VaultSyncMessage, VaultSendOptions } from '../../src/sync/vault/types.js';
import { type Device, Net, type NetOptions } from '../sync/vault/harness.js';

const HOUR = 3_600_000;

function log(line: string): void {
  process.stdout.write(`${line}\n`); // 不經 console：vitest 會把通過的測試的 console 輸出吞掉
}

type Cause = 'want' | 'stale-digest' | 'digest' | 'in-flight' | 'other';

/** 記錄每一則送出的訊息與收件人，最後統計重送 */
class Recorder {
  readonly #net: Net;
  readonly #log: Array<{ index: number; from: string; message: VaultSyncMessage; to: string[] }> = [];
  /** `寄件人|收件人|版本` → 已送出的 hub index */
  readonly #copies = new Map<string, number[]>();
  readonly counts: Record<Cause, number> = { want: 0, 'stale-digest': 0, digest: 0, 'in-flight': 0, other: 0 };
  sends = 0;
  readonly samples: string[] = [];
  /** 每台收到（處理）每則訊息的時候，中繼上已經有幾則（`hub index` → 那時的 log 長度） */
  readonly #deliveredAt = new Map<string, Map<number, number>>();

  constructor(net: Net) {
    this.#net = net;
  }

  watch(device: Device): void {
    const t = device.transport;
    const at = new Map<number, number>();
    this.#deliveredAt.set(device.name, at);
    const deliver = t.deliver.bind(t);
    t.deliver = (message: VaultSyncMessage) => {
      const index = this.#net.hub.messages.indexOf(message);
      if (index >= 0) at.set(index, this.#net.hub.messages.length);
      deliver(message);
    };
    const send = t.send.bind(t);
    t.send = async (message: VaultSyncMessage, options?: VaultSendOptions) => {
      const index = this.#net.hub.messages.length;
      const to = [...(options?.to ?? this.#net.hub.others(device.name))];
      await send(message, options);
      this.#record(index, device.name, message, to);
    };
  }

  #record(index: number, from: string, message: VaultSyncMessage, to: string[]): void {
    const versions = message.type === 'node' ? [message.node.id] : message.type === 'nodes' ? message.items.map(([, v]) => v.id) : [];
    for (const version of versions) {
      for (const r of to) {
        this.sends += 1;
        const key = `${from}|${r}|${version}`;
        const prev = this.#copies.get(key);
        if (prev && prev.length > 0) {
          const cause = this.#cause(from, r, version, prev[prev.length - 1]!);
          this.counts[cause] += 1;
          if (this.samples.length < 6) this.samples.push(`${cause}: ${from}→${r} ${version.slice(0, 8)}（第 ${prev.length + 1} 份）`);
        }
        this.#copies.set(key, [...(prev ?? []), index]);
      }
    }
    this.#log.push({ index, from, message, to });
  }

  #cause(from: string, r: string, version: string, prevIndex: number): Cause {
    const device = this.#net.devices.find((d) => d.name === r);
    // 收件人在前一份之後送出的訊息
    const after = this.#log.filter((e) => e.index > prevIndex && e.from === r && e.to.includes(from));
    if (after.some((e) => e.message.type === 'want' && e.message.items.some(([, n]) => n === version))) return 'want';
    // 收件人在前一份之前送出的摘要，寄件人在前一份之後才處理到
    const at = this.#deliveredAt.get(from);
    const stale = this.#log.some((e) => e.index < prevIndex && e.from === r && e.message.type === 'digest' && (at?.get(e.index) ?? -1) > prevIndex);
    if (stale) return 'stale-digest';
    if (device && !device.transport.delivered.has(prevIndex)) return 'in-flight';
    if (after.some((e) => e.message.type === 'digest')) return 'digest';
    return 'other';
  }

  report(name: string): void {
    const dup = Object.values(this.counts).reduce((a, b) => a + b, 0);
    const parts = (Object.keys(this.counts) as Cause[]).map((c) => `${c} ${this.counts[c]}`).join('、');
    log(`${name}：版本送出 ${this.sends} 份（每位收件人算一份），重送 ${dup}（${((dup / Math.max(1, this.sends)) * 100).toFixed(1)}%）：${parts}`);
    for (const s of this.samples) log(`    ${s}`);
  }
}

async function scenario(name: string, opts: NetOptions, body: (net: Net, add: (n: string, o?: Parameters<Net['add']>[1]) => Promise<Device>) => Promise<void>): Promise<void> {
  const net = new Net(opts);
  const rec = new Recorder(net);
  const add = async (n: string, o?: Parameters<Net['add']>[1]) => {
    const d = await net.add(n, o);
    rec.watch(d);
    return d;
  };
  await body(net, add);
  rec.report(name);
}

describe('同一版本重複送出的原因', () => {
  it('各情境', { timeout: 600_000 }, async () => {
    for (const maxDelayMs of [0, 2_000]) {
      const tag = `延遲 0–${maxDelayMs / 1000} 秒`;

      await scenario(`A. 新裝置加入（200 篇筆記，${tag}）`, { maxDelayMs, seed: 3 }, async (net, add) => {
        const desk = await add('desk', { online: false });
        for (let i = 0; i < 200; i += 1) desk.vault.userWrite(`n/${i}.md`, `# ${i}`);
        await desk.sync.scan();
        await add('phone');
        desk.transport.setOnline(true);
        await net.settle();
      });

      await scenario(`B. 三台都在線、輪流編輯（${tag}）`, { maxDelayMs, seed: 5 }, async (net, add) => {
        const ds = [await add('a'), await add('b'), await add('c')];
        await net.settle();
        for (let round = 0; round < 60; round += 1) {
          const d = ds[round % 3]!;
          await d.edit(`n/${round % 10}.md`, `round ${round}`);
          await net.clock.advance(1_000);
        }
        await net.settle();
      });

      await scenario(`C. 一台離線期間其他台編輯、回來後補齊（${tag}）`, { maxDelayMs, seed: 7 }, async (net, add) => {
        const a = await add('a');
        const b = await add('b');
        const c = await add('c');
        for (let i = 0; i < 20; i += 1) await a.edit(`n/${i}.md`, `v0 ${i}`);
        await net.settle();
        c.transport.setOnline(false);
        for (let i = 0; i < 40; i += 1) await (i % 2 ? a : b).edit(`n/${i % 20}.md`, `v1 ${i}`);
        await net.settle();
        c.transport.setOnline(true);
        await net.settle();
      });

      await scenario(`D. 同時編輯同一篇（分岔、合併，${tag}）`, { maxDelayMs, seed: 11 }, async (net, add) => {
        const a = await add('a');
        const b = await add('b');
        await a.edit('x.md', 'base');
        await net.settle();
        for (let i = 0; i < 20; i += 1) {
          await a.edit('x.md', `a ${i}`);
          await b.edit('x.md', `b ${i}`);
          await net.clock.advance(500);
        }
        await net.settle();
      });

      await scenario(`E. 重新啟動（${tag}）`, { maxDelayMs, seed: 13 }, async (net, add) => {
        const a = await add('a');
        const b = await add('b');
        for (let i = 0; i < 30; i += 1) await a.edit(`n/${i}.md`, `v ${i}`);
        await net.settle();
        await b.restart();
        await a.restart();
        await net.clock.advance(HOUR);
        await net.settle();
      });
    }
  });
});
