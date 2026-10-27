// 非同步 ChatStorage（SDK ADR 0024）：外掛用 IndexedDB 之類的非同步儲存存私訊與封鎖名單。
//
// 要釘住的是非同步帶來的三種靜默錯誤：
//   1. **讀取還沒回來就寫**：新訊息把舊紀錄整份蓋掉（遺失歷史）。
//   2. **寫入交錯**：較舊的狀態晚一步寫完，蓋掉較新的狀態（狀態回退）。
//   3. **讀取失敗還照寫**：一次 I/O 錯誤就把整份紀錄清空。
import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import { Blocklist } from '../src/blocklist.js';
import { MemoryAsyncChatStorage, type AsyncChatStorage } from '../src/chat-storage.js';
import { DEFAULT_DM_STORAGE_KEY, DirectMessages, wrapDm, type DmThread } from '../src/dm.js';
import { Identity } from '../src/identity.js';
import { FakeTransport } from './fake-transport.js';

const NOW_SEC = 1_790_000_000;

/** 每次讀寫都隨機延遲的儲存：記下寫入的完成順序與同時進行中的寫入數 */
class SlowStorage implements AsyncChatStorage {
  readonly data = new Map<string, string>();
  readonly writes: { key: string; value: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  failReads = false;
  #seed = 7;

  #delay(): Promise<void> {
    // 可重現的偽隨機延遲（0～7 個 macrotask）
    this.#seed = (this.#seed * 1103515245 + 12345) % 2 ** 31;
    const ticks = this.#seed % 8;
    return new Promise((resolve) => {
      let left = ticks;
      const step = () => (left-- <= 0 ? resolve() : setTimeout(step, 0));
      step();
    });
  }

  async getItem(key: string): Promise<string | null> {
    await this.#delay();
    if (this.failReads) throw new Error('I/O 錯誤');
    return this.data.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await this.#delay();
    this.data.set(key, value);
    this.writes.push({ key, value });
    this.inFlight -= 1;
  }
}

function dmTo(from: Identity, to: Identity, text: string, at: number) {
  return wrapDm({ identity: from, to: to.pubkey, text, nowSec: at })[0]!;
}

const lineCount = (json: string) => (JSON.parse(json) as DmThread[]).reduce((n, t) => n + t.lines.length, 0);

describe('MemoryAsyncChatStorage', () => {
  it('讀寫都回傳 Promise；沒有的鍵回 null', async () => {
    const storage = new MemoryAsyncChatStorage();
    const pending = storage.getItem('k');
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBeNull();
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
  });

  it('可以帶初始內容', async () => {
    expect(await new MemoryAsyncChatStorage({ a: '1' }).getItem('a')).toBe('1');
  });
});

describe('DirectMessages＋非同步儲存', () => {
  it('ready() 之後讀回舊對話；watch 的回呼在載入後再收到一次', async () => {
    const me = Identity.generate();
    const peer = Identity.generate();
    const storage = new SlowStorage();
    const first = new DirectMessages({ transport: new FakeTransport(), identity: me, storage, now: () => NOW_SEC * 1000 });
    await first.ready();
    const transport = new FakeTransport();
    first.watch(() => {});
    await first.send(peer.pubkey, '存起來');
    await first.flush();

    const second = new DirectMessages({ transport, identity: me, storage, now: () => NOW_SEC * 1000 });
    const seen: number[] = [];
    second.watch((threads) => seen.push(threads.length));
    expect(second.threads()).toEqual([]); // 還沒讀回來
    await second.ready();
    expect(second.threads()[0]?.lines.map((l) => l.text)).toEqual(['存起來']);
    expect(seen).toEqual([0, 1]);
  });

  it('🔴 讀取還沒回來就收到新訊息：與舊紀錄合併，不會把歷史整份蓋掉', async () => {
    const me = Identity.generate();
    const peer = Identity.generate();
    const storage = new SlowStorage();
    const history = new DirectMessages({ transport: new FakeTransport(), identity: me, storage, now: () => NOW_SEC * 1000 });
    await history.ready();
    await history.send(peer.pubkey, '舊的一則');
    await history.flush();

    const transport = new FakeTransport();
    const dm = new DirectMessages({ transport, identity: me, storage, now: () => NOW_SEC * 1000 });
    dm.watch(() => {});
    transport.deliver(dmTo(peer, me, '載入前到的', NOW_SEC + 5)); // 讀取還在路上
    await dm.ready();
    await dm.flush();
    const texts = dm.threads()[0]?.lines.map((l) => l.text);
    expect(texts).toEqual(['舊的一則', '載入前到的']);
    expect(JSON.parse(storage.data.get(DEFAULT_DM_STORAGE_KEY)!)).toEqual(dm.threads());
  });

  it('🔴 同時湧入大量訊息：寫入一次只跑一個、不回退，最後存下的就是最新狀態', async () => {
    const me = Identity.generate();
    const peers = [Identity.generate(), Identity.generate(), Identity.generate()];
    const storage = new SlowStorage();
    const transport = new FakeTransport();
    const dm = new DirectMessages({ transport, identity: me, storage, now: () => NOW_SEC * 1000 });
    dm.watch(() => {});
    await dm.ready();
    const wraps = Array.from({ length: 30 }, (_, i) => dmTo(peers[i % 3]!, me, `第 ${i} 則`, NOW_SEC + i));
    for (let i = 0; i < wraps.length; i += 1) {
      transport.deliver(wraps[i]!);
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // 讓部分寫入在訊息之間開始跑
    }
    await dm.flush();

    expect(storage.maxInFlight).toBe(1); // 同一時間只有一個寫入
    const counts = storage.writes.map((w) => lineCount(w.value));
    expect(counts).toEqual([...counts].sort((a, b) => a - b)); // 依序寫入，從不回退
    expect(counts.at(-1)).toBe(30);
    expect(storage.writes.length).toBeLessThan(30); // 排隊中的寫入會合併
    expect(JSON.parse(storage.data.get(DEFAULT_DM_STORAGE_KEY)!)).toEqual(dm.threads());
  }, 30_000); // 30 則私訊的封裝與拆封在整套測試並行時較慢

  it('forget() 在載入前呼叫：載入後那段對話仍然是刪掉的', async () => {
    const me = Identity.generate();
    const peer = Identity.generate();
    const storage = new SlowStorage();
    const history = new DirectMessages({ transport: new FakeTransport(), identity: me, storage, now: () => NOW_SEC * 1000 });
    await history.ready();
    await history.send(peer.pubkey, '要刪掉的');
    await history.flush();

    const dm = new DirectMessages({ transport: new FakeTransport(), identity: me, storage });
    dm.forget(peer.pubkey);
    await dm.ready();
    await dm.flush();
    expect(dm.threads()).toEqual([]);
    expect(JSON.parse(storage.data.get(DEFAULT_DM_STORAGE_KEY)!)).toEqual([]);
  });

  it('🔴 讀取失敗：只留在記憶體，不寫回（避免一次 I/O 錯誤就清空整份紀錄）', async () => {
    const me = Identity.generate();
    const peer = Identity.generate();
    const storage = new SlowStorage();
    storage.data.set(DEFAULT_DM_STORAGE_KEY, '[{"peer":"x","lines":[],"lastAt":1}]');
    storage.failReads = true;
    const transport = new FakeTransport();
    const dm = new DirectMessages({ transport, identity: me, storage, now: () => NOW_SEC * 1000 });
    dm.watch(() => {});
    await dm.ready();
    transport.deliver(dmTo(peer, me, '收到了', NOW_SEC));
    await dm.flush();
    expect(dm.threads()).toHaveLength(1);
    expect(storage.writes).toEqual([]);
    expect(storage.data.get(DEFAULT_DM_STORAGE_KEY)).toBe('[{"peer":"x","lines":[],"lastAt":1}]');
  });

  it('同步儲存的行為不變：建構時就讀回、ready()/flush() 立刻完成', async () => {
    const me = Identity.fromNsec(nip19.nsecEncode(generateSecretKey()));
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const first = new DirectMessages({ transport: new FakeTransport(), identity: me, storage, now: () => NOW_SEC * 1000 });
    await first.send(Identity.generate().pubkey, '同步');
    const second = new DirectMessages({ transport: new FakeTransport(), identity: me, storage });
    expect(second.threads()).toHaveLength(1); // 不必等
    await expect(second.ready()).resolves.toBeUndefined();
    await expect(second.flush()).resolves.toBeUndefined();
  });
});

describe('Blocklist＋非同步儲存', () => {
  it('ready() 之後讀回；載入前的 add/remove 依序套用在讀回的名單上，並寫回', async () => {
    const storage = new SlowStorage();
    storage.data.set('cinderous:chat:blocked', JSON.stringify(['a', 'b']));
    const list = new Blocklist(storage);
    expect(list.has('a')).toBe(false); // 還沒讀回來
    list.add('c');
    list.remove('a');
    await list.ready();
    expect([...list.list()].sort()).toEqual(['b', 'c']);
    await list.flush();
    expect(JSON.parse(storage.data.get('cinderous:chat:blocked')!).sort()).toEqual(['b', 'c']);
  });

  it('🔴 連續快速變更：寫入序列化，最後存下的等於目前名單', async () => {
    const storage = new SlowStorage();
    const list = new Blocklist(storage, 'k');
    await list.ready();
    for (let i = 0; i < 20; i += 1) {
      list.add(`p${i}`);
      if (i % 3 === 0) list.remove(`p${i - 1}`);
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await list.flush();
    expect(storage.maxInFlight).toBe(1);
    expect(JSON.parse(storage.data.get('k')!)).toEqual([...list.list()]);
  });

  it('讀取失敗：不寫回', async () => {
    const storage = new SlowStorage();
    storage.data.set('k', '["keep"]');
    storage.failReads = true;
    const list = new Blocklist(storage, 'k');
    await list.ready();
    list.add('x');
    await list.flush();
    expect(list.has('x')).toBe(true);
    expect(storage.data.get('k')).toBe('["keep"]');
  });
});
