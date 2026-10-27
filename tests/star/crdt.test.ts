// Yjs 風格整合（SDK ADR 0030 §4）：多位成員經 Host 轉送 CRDT 更新，最後全部收斂（含 Host 的主文件）。
// 不引入 yjs：用一個最小的 CRDT（LWW 暫存器的 map，Lamport 時鐘＋副本 id 決勝），性質與 Yjs 更新相同——
// 可交換、可結合、冪等，所以只要每個副本最終收到全部更新就會收斂；Host 序號另外給出全體一致的套用順序。
import { afterEach, describe, expect, it } from 'vitest';

import { StarHost } from '../../src/star/host.js';
import { joinMember, makeHost, rng, sleep, text, until, type Joined } from './helpers.js';

type Entry = { v: string; clock: number; replica: string };

class LwwDoc {
  readonly state = new Map<string, Entry>();
  clock = 0;
  constructor(readonly replica: string) {}

  set(key: string, v: string): Uint8Array {
    this.clock += 1;
    const entry = { v, clock: this.clock, replica: this.replica };
    this.#merge(key, entry);
    return text(JSON.stringify([[key, entry]]));
  }

  apply(update: Uint8Array): void {
    for (const [key, entry] of JSON.parse(new TextDecoder().decode(update)) as [string, Entry][]) this.#merge(key, entry);
  }

  encodeState(): Uint8Array {
    return text(JSON.stringify([...this.state]));
  }

  #merge(key: string, entry: Entry): void {
    this.clock = Math.max(this.clock, entry.clock);
    const cur = this.state.get(key);
    if (!cur || entry.clock > cur.clock || (entry.clock === cur.clock && entry.replica > cur.replica)) this.state.set(key, entry);
  }

  snapshot(): string {
    return JSON.stringify([...this.state].sort(([a], [b]) => a.localeCompare(b)));
  }
}

const TOPIC_UPDATE = 0;
const TOPIC_STATE = 9;

const hosts: StarHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});

describe('多人共編經 Host 轉送後收斂', () => {
  it('5 位成員＋Host 同時改同一批鍵；中途加入的人用 Host 的單播快照補齊；全部收斂到同一份', async () => {
    const r = rng(2026);
    const h = makeHost({ relayEventsPerMinute: 600_000 });
    hosts.push(h);
    const master = new LwwDoc(h.hostPubkey);
    h.onMessage((m) => {
      if (m.topic === TOPIC_UPDATE) master.apply(m.payload);
    });
    // 有人加入：Host 把主文件的完整狀態單播給他（Host 序號在 joined 之後，之後的更新都比快照晚）
    h.onEvent((e) => {
      if (e.type === 'joined') h.send(master.encodeState(), { to: [e.pubkey], topic: TOPIC_STATE });
    });

    const replicas: { j: Joined; doc: LwwDoc }[] = [];
    const add = async (mode: 'p2p-webrtc' | 'relayed-websocket') => {
      // P2P 軌（DataChannel）本身有序：固定延遲；中繼軌會亂序：隨機延遲
      const delayMs = mode === 'p2p-webrtc' ? () => 1 : () => Math.floor(r() * 4);
      const j = await joinMember(h, { behaviour: { mode, delayMs }, member: { relayEventsPerMinute: 600_000 } });
      const doc = new LwwDoc(j.pubkey);
      j.member.onMessage((m) => doc.apply(m.payload)); // 更新與快照都是 CRDT 狀態，照套即可
      replicas.push({ j, doc });
    };
    for (let i = 0; i < 4; i += 1) await add(i % 2 === 0 ? 'p2p-webrtc' : 'relayed-websocket');

    const keys = ['title', 'p1', 'p2', 'p3'];
    for (let round = 0; round < 60; round += 1) {
      const who = Math.floor(r() * (replicas.length + 1));
      const key = keys[Math.floor(r() * keys.length)]!;
      if (who === replicas.length) h.send(master.set(key, `host-${round}`), { topic: TOPIC_UPDATE });
      else {
        const { j, doc } = replicas[who]!;
        j.member.send(doc.set(key, `${j.pubkey.slice(0, 4)}-${round}`), { topic: TOPIC_UPDATE });
      }
      if (round === 30) await add('p2p-webrtc'); // 中途加入
      if (r() < 0.3) await sleep(1);
    }

    await until(() => replicas.every(({ doc }) => doc.snapshot() === master.snapshot()), 5_000, '收斂');
    expect(new Set(replicas.map(({ doc }) => doc.snapshot())).size).toBe(1);
    expect(JSON.parse(master.snapshot())).toHaveLength(4);
  });
});
