// 協調器 × P2P 批次串流（SDK ADR 0026）：新裝置加入、大量變更、大檔直送、退路、續傳、惡意對端。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import { EMPTY_SHA256, VAULT_STREAM_PURPOSE, VAULT_WIRE_VERSION, type VaultSyncMessage, type VaultVersion } from '../../../src/sync/vault/index.js';
import { bytesEntry, MemoryStreamingStore, type StreamEntry, StreamTransfer } from '../../../src/transfer/stream.js';
import { type Device, MemoryVault, Net } from './harness.js';

/** 記下某台裝置經中繼（kind 1060 那條）送出的訊息與時間 */
function spyRelay(device: Device, net: Net): Array<{ at: number; type: VaultSyncMessage['type'] }> {
  const log: Array<{ at: number; type: VaultSyncMessage['type'] }> = [];
  const send = device.transport.send.bind(device.transport);
  device.transport.send = async (message) => {
    await send(message);
    log.push({ at: net.clock.now(), type: message.type });
  };
  return log;
}

function fill(vault: MemoryVault, n: number, prefix = 'notes'): void {
  for (let i = 0; i < n; i += 1) vault.userWrite(`${prefix}/${i % 20}/n-${i}.md`, `# ${i}\n內容 ${i}\n`);
}

const big = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 4096) out[i] = (i * seed) & 0xff;
  out[0] = seed;
  return out;
};
const hex = (b: Uint8Array) => bytesToHex(sha256(b));

describe('新裝置加入與大量變更：改走 P2P 批次，中繼只送摘要與索取', () => {
  it('🔴 2,000 個檔案的 Vault 加入新裝置：內容全部經 P2P 批次送達，中繼上的版本訊息遠少於檔案數（不會撞到每收件人 4,000 顆的配額）', { timeout: 120_000 }, async () => {
    const net = new Net({ p2p: true });
    const vault = new MemoryVault();
    fill(vault, 2000);
    const a = await net.add('a', { vault });
    await net.settle();
    expect(a.sync.status().queue).toBe(0);

    const relay = spyRelay(a, net);
    const t0 = performance.now();
    const b = await net.add('b');
    await net.settle();
    const ms = performance.now() - t0;
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(Object.keys(b.vault.tree())).toHaveLength(2000);
    const nodesOverRelay = relay.filter((m) => m.type === 'node').length;
    expect(nodesOverRelay).toBeLessThan(100);
    for (const d of [a, b]) {
      expect(d.sync.status()).toMatchObject({ queue: 0, waiting: 0, pending: [], bulk: false, pushes: 0 });
      expect(d.errors).toEqual([]);
    }
    console.info(`[vault-p2p] 2,000 檔新裝置加入：${ms.toFixed(0)} ms；經中繼的版本訊息 ${nodesOverRelay} 則（其餘經 P2P），P2P 通道 ${net.mesh!.opened} 條、${(net.mesh!.bytes / 1024).toFixed(0)} KB`);
  });

  it('🔴 大量本機變更（一次改 300 個檔案）：兩台在線時經 P2P 批次送達', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    const relay = spyRelay(a, net);
    fill(a.vault, 300, 'bulk');
    await a.sync.scan();
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(relay.filter((m) => m.type === 'node').length).toBeLessThan(30);
  });

  it('少量變更（低於門檻）照舊即時走中繼', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const relay = spyRelay(a, net);
    await a.edit('x.md', 'x');
    await net.settle();
    expect(b.vault.get('x.md')).toBe('x');
    expect(relay.filter((m) => m.type === 'node')).toHaveLength(1);
    expect(net.mesh!.opened).toBe(0);
  });
});

describe('退路：P2P 打不通', () => {
  it('🔴 完全打不通（兩台從不同時上線、或網路擋掉）：中繼限速補送，每小時不超過上限，最後仍然收斂', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 20 } });
    net.mesh!.reachable = () => false;
    const vault = new MemoryVault();
    fill(vault, 120);
    const a = await net.add('a', { vault, online: false });
    const relay = spyRelay(a, net);
    const b = await net.add('b');
    a.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    const nodes = relay.filter((m) => m.type === 'node');
    // 任何一小時的窗內，經中繼的版本訊息不超過 20＋門檻以下的尾巴（批次模式在剩不到 10 則時結束）
    for (const m of nodes) {
      const inWindow = nodes.filter((x) => x.at >= m.at && x.at < m.at + 3_600_000).length;
      expect(inWindow).toBeLessThanOrEqual(20 + 10);
    }
    expect(net.clock.now() - nodes[0]!.at).toBeGreaterThan(3 * 3_600_000); // 真的被限速了（120 則要好幾個小時）
    expect(a.errors).toEqual([]);
  });

  it('🔴 只有一台積壓（新加入、P2P 打不通）：要給其他裝置的新修改照常即時經中繼送，不被那台的限速拖住（SDK ADR 0091）', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 20 } });
    const vault = new MemoryVault();
    fill(vault, 120);
    const a = await net.add('a', { vault });
    const b = await net.add('b');
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    // 換成誰都打不通；c 新加入，a、b 都要補 120 個檔案給它——只能經中繼限速補送
    net.mesh!.reachable = () => false;
    const c = await net.add('c');
    for (let i = 0; i < 60 && !a.sync.status().bulk; i += 1) await net.clock.advance(60_000);
    expect(a.sync.status().bulk).toBe(true);
    expect(b.sync.status().bulk).toBe(true);
    expect(Object.keys(c.vault.tree()).length).toBeLessThan(120);
    await a.edit('x.md', 'a 剛改的');
    for (let i = 0; i < 6; i += 1) await net.clock.advance(10_000); // 一分鐘內（分段前進：讓送出後才排的投遞也跑到）
    expect(b.vault.get('x.md')).toBe('a 剛改的');
    await b.edit('y.md', 'b 剛改的');
    for (let i = 0; i < 6; i += 1) await net.clock.advance(10_000);
    expect(a.vault.get('y.md')).toBe('b 剛改的');
    // 給 c 的照樣補完（連同這兩個新修改），而且照樣限速（120 個檔案、每台每小時 20 則，要好幾個小時）
    const t0 = net.clock.now();
    expect(c.vault.get('x.md')).toBeUndefined();
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
    expect(net.clock.now() - t0).toBeGreaterThan(2 * 3_600_000);
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(a.errors).toEqual([]);
  });

  it('🔴 對方是舊版（沒有 P2P 批次）：開不了批次 → 退避，改由中繼補送收斂', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 50 } });
    const vault = new MemoryVault();
    fill(vault, 60);
    const a = await net.add('a', { vault, online: false });
    // b 在 P2P 網路上，但協調器沒有 peers（舊版）：通道打得通，卻沒有人處理批次
    const b = await net.add('b', { options: { peers: undefined } });
    a.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(a.errors).toEqual([]);
  });

  it('🔴 只打得通中繼軌（kind 20079）：小檔批次照走；大檔內容等真的 P2P 打通才送', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true });
    net.mesh!.mode = 'relayed-websocket';
    const a = await net.add('a');
    const b = await net.add('b');
    fill(a.vault, 40, 'small');
    const video = big(FILE_TIER_MAX_BYTES + 1000, 3);
    a.vault.userWrite('video.mp4', video);
    await a.sync.scan();
    await net.settle();
    expect(Object.keys(b.vault.tree()).filter((p) => p.startsWith('small/'))).toHaveLength(40);
    expect(b.vault.files.has('video.mp4')).toBe(false);
    expect(b.sync.status().pending).toMatchObject([{ path: 'video.mp4', via: 'p2p' }]);

    // 換到同一個 Wi-Fi：P2P 打得通了，下一次觸發（對方上線送摘要）就直送
    net.mesh!.drop('a');
    net.mesh!.mode = 'p2p-webrtc';
    b.transport.setOnline(false);
    b.transport.setOnline(true);
    await net.settle();
    expect(hex(b.vault.files.get('video.mp4')!.bytes)).toBe(hex(video));
    expect(b.sync.status().pending).toEqual([]);
  });
});

describe('大檔：P2P 直送、串流寫入、續傳', () => {
  it('🔴 大檔經 P2P 直送，分段寫進 Vault（writeStream）；中繼上只有中繼資料', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const b = await net.add('b');
    const relay: VaultSyncMessage[] = [];
    const send = a.transport.send.bind(a.transport);
    a.transport.send = async (m) => {
      relay.push(m);
      return send(m);
    };
    const video = big(FILE_TIER_MAX_BYTES + 5_000_000, 5);
    a.vault.userWrite('media/video.mp4', video);
    await a.sync.notifyLocalChange('media/video.mp4', 'create');
    await net.settle();
    expect(hex(b.vault.files.get('media/video.mp4')!.bytes)).toBe(hex(video));
    expect(b.vault.streamWrites).toBe(1);
    expect(b.vault.maxStreamChunk).toBeLessThanOrEqual(1 << 20);
    const node = relay.find((m) => m.type === 'node');
    expect(node && 'content' in node ? node.content : undefined).toBeUndefined();
    expect(a.sync.status().pushes).toBe(0);
    expect(b.sync.status().pending).toEqual([]);
  });

  it('🔴 對方送來任何訊息＝它此刻在線：有要直送給它的就馬上排直連，不等退避（SDK ADR 0090）；同一台一分鐘最多觸發一次', { timeout: 60_000 }, async () => {
    // 不送摘要（只有摘要會觸發的話，這裡就要等退避）
    const net = new Net({ p2p: true, streaming: true, options: { digestPolicy: 'manual', p2pRetryInitialMs: 10 * 60_000 } });
    const a = await net.add('a');
    const b = await net.add('b', { online: false });
    const video = big(FILE_TIER_MAX_BYTES + 1_000_000, 17);
    a.vault.userWrite('v.mp4', video);
    await a.sync.notifyLocalChange('v.mp4', 'create');
    await net.settle();
    expect(a.sync.status().pushes).toBe(1);
    expect(b.vault.files.has('v.mp4')).toBe(false); // a 試過直連、失敗，退避 10 分鐘
    b.transport.setOnline(true);
    await net.settle();
    await b.edit('n.md', 'b 上線後改了一個小檔'); // 一則一般的版本訊息（不是摘要）
    await net.settle();
    expect(hex(b.vault.files.get('v.mp4')!.bytes)).toBe(hex(video));
    expect(a.sync.status().pushes).toBe(0);
  });

  it('收到訊息排直連有節流：同一台一分鐘內來很多則（例如中繼補送的舊訊息）最多試一次（SDK ADR 0090）', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, streaming: true, options: { digestPolicy: 'manual', p2pRetryInitialMs: 10 * 60_000 } });
    const a = await net.add('a');
    const b = await net.add('b', { online: false });
    a.vault.userWrite('v.mp4', big(FILE_TIER_MAX_BYTES + 1_000, 19));
    await a.sync.notifyLocalChange('v.mp4', 'create');
    await net.settle();
    // 直連一律打不通；數 a 試著連 b 的次數
    let tries = 0;
    net.mesh!.reachable = (from, to) => {
      if (from === 'a' && to === 'b') tries += 1;
      return false;
    };
    b.transport.setOnline(true);
    await net.settle();
    // 上線那一刻：b 索取大檔內容（既有行為）會排一次
    const online = tries;
    expect(online).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 4; i += 1) {
      await b.edit(`n${i}.md`, `第 ${i} 則`);
      await net.settle();
    }
    // 一分鐘內來 4 則：最多多試一次（第一則觸發，其餘節流）
    expect(tries - online).toBeLessThanOrEqual(1);
    const afterBurst = tries;
    await net.clock.advance(61_000);
    await b.edit('later.md', '一分鐘後');
    await net.settle();
    expect(tries).toBe(afterBurst + 1);
  });

  it('🔴 暫存區回報本機路徑（localPath）時，交給 writeStream 的來源帶 stagedPath：轉接器可以直接改名取用，不讀出再寫（SDK ADR 0089）', { timeout: 60_000 }, async () => {
    class PathStore extends MemoryStreamingStore {
      readonly asked: string[] = [];
      async localPath(id: string): Promise<string | undefined> {
        this.asked.push(id);
        return `.staging/${id}.part`;
      }
    }
    const staging = new PathStore();
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const b = await net.add('b', { options: { staging } });
    const seen: Array<string | undefined> = [];
    const write = b.vault.writeStream!.bind(b.vault);
    b.vault.writeStream = async (path, source, expectHash) => {
      seen.push(source.stagedPath);
      return write(path, source, expectHash);
    };
    const video = big(FILE_TIER_MAX_BYTES + 2_000_000, 13);
    a.vault.userWrite('media/v.mp4', video);
    await a.sync.notifyLocalChange('media/v.mp4', 'create');
    await net.settle();
    expect(hex(b.vault.files.get('media/v.mp4')!.bytes)).toBe(hex(video));
    expect(staging.asked).toEqual([hex(video)]);
    expect(seen).toEqual([`.staging/${hex(video)}.part`]);
  });

  it('🔴 writeStream 的來源帶內容的 SHA-256（收完時已校驗過的 node.hash，64 字元小寫 hex；SDK ADR 0057，CinderSync G22）', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const b = await net.add('b');
    const seen: Array<string | undefined> = [];
    const write = b.vault.writeStream!.bind(b.vault);
    b.vault.writeStream = async (path, source, expectHash) => {
      seen.push(source.sha256);
      return write(path, source, expectHash);
    };
    const video = big(FILE_TIER_MAX_BYTES + 3_000_000, 9);
    a.vault.userWrite('media/clip.mp4', video);
    await a.sync.notifyLocalChange('media/clip.mp4', 'create');
    await net.settle();
    expect(seen).toEqual([hex(video)]);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hex(b.vault.files.get('media/clip.mp4')!.bytes)).toBe(hex(video));
  });

  it('🔴 轉接器以來源的 SHA-256 發現內容不符而回 false：不寫入、不當作已套用（送方的直送留著）', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const b = await net.add('b');
    let rejected = 0;
    const write = b.vault.writeStream!.bind(b.vault);
    b.vault.writeStream = async (path, source, expectHash) => {
      if (rejected < 1) {
        // 模擬「暫存讀回來的內容與宣告的雜湊不符」：轉接器以 source.sha256 比對後拒絕
        rejected += 1;
        return false;
      }
      return write(path, source, expectHash);
    };
    const video = big(FILE_TIER_MAX_BYTES + 2_000_000, 11);
    a.vault.userWrite('m.mp4', video);
    await a.sync.notifyLocalChange('m.mp4', 'create');
    await net.settle();
    expect(rejected).toBe(1);
    // 第一次被拒、之後重新讀取／重送寫入成功：最後內容正確
    expect(hex(b.vault.files.get('m.mp4')!.bytes)).toBe(hex(video));
  });

  it('🔴 傳到一半斷線 → 收方暫存保留；重新連上後從斷點續傳，不重傳已收到的部分', { timeout: 60_000 }, async () => {
    const staging = new MemoryStreamingStore();
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const b = await net.add('b', { options: { staging } });
    const video = big(FILE_TIER_MAX_BYTES + 8_000_000, 7);
    let cut = true;
    let appended = 0;
    const append = staging.append.bind(staging);
    staging.append = async (id, bytes) => {
      await append(id, bytes);
      appended += bytes.length;
      if (cut && (await staging.size(id)) > 6_000_000) {
        cut = false;
        net.mesh!.drop('b'); // Wi-Fi 斷了一下
      }
    };
    a.vault.userWrite('v.mp4', video);
    await a.sync.notifyLocalChange('v.mp4', 'create');
    await net.settle();
    expect(cut).toBe(false);
    expect(net.mesh!.opened).toBeGreaterThanOrEqual(2); // 重新連上
    expect(hex(b.vault.files.get('v.mp4')!.bytes)).toBe(hex(video));
    expect(appended).toBe(video.length); // 斷點之前的沒有重傳
    expect(await staging.size(hex(video))).toBe(0); // 寫進 Vault 後暫存清掉
    expect(staging.committed.size).toBe(0);
    expect(a.sync.status().pushes).toBe(0);
  });

  it('🔴 收方在傳到一半時重開（暫存持久化）：重開、上線後從斷點續傳', { timeout: 60_000 }, async () => {
    const staging = new MemoryStreamingStore();
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const b = await net.add('b', { options: { staging } });
    const video = big(FILE_TIER_MAX_BYTES + 8_000_000, 11);
    let cut = true;
    let appended = 0;
    const append = staging.append.bind(staging);
    staging.append = async (id, bytes) => {
      await append(id, bytes);
      appended += bytes.length;
      if (cut && (await staging.size(id)) > 6_000_000) {
        cut = false;
        b.transport.setOnline(false); // 收方關掉（離線）
        net.mesh!.drop('b');
      }
    };
    a.vault.userWrite('v.mp4', video);
    await a.sync.notifyLocalChange('v.mp4', 'create');
    await net.settle();
    const kept = await staging.size(hex(video));
    expect(kept).toBeGreaterThan(6_000_000);
    expect(b.vault.files.has('v.mp4')).toBe(false);
    expect(a.sync.status().pushes).toBe(1);

    await b.restart(); // 同一份暫存、同一份狀態
    b.transport.setOnline(true); // 上線送摘要 → 送方立刻重試
    await net.settle();
    expect(hex(b.vault.files.get('v.mp4')!.bytes)).toBe(hex(video));
    expect(appended).toBe(video.length);
    expect(a.sync.status().pushes).toBe(0);
  });

  it('🔴 送方重開：待直送的大檔已持久化，重開後照樣送達', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b', { online: false });
    const video = big(FILE_TIER_MAX_BYTES + 100, 9);
    a.vault.userWrite('v.bin', video);
    await a.sync.notifyLocalChange('v.bin', 'create');
    await net.settle();
    expect(a.sync.status().pushes).toBe(1);
    expect((await a.store.keys('x:')).length).toBe(1);
    await a.restart();
    expect(a.sync.status().pushes).toBe(1);
    b.transport.setOnline(true);
    await net.settle();
    expect(hex(b.vault.files.get('v.bin')!.bytes)).toBe(hex(video));
    expect(a.sync.status().pushes).toBe(0);
    expect((await a.store.keys('x:')).length).toBe(0);
  });

  it('🔴 待直送的大檔在對方上線前就刪掉或被新版取代：馬上從待直送剔除（不等連上對方、不讓應用一直等 P2P）', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    await net.add('b', { online: false });
    a.vault.userWrite('v.bin', big(FILE_TIER_MAX_BYTES + 100, 21));
    await a.sync.notifyLocalChange('v.bin', 'create');
    a.vault.userWrite('w.bin', big(FILE_TIER_MAX_BYTES + 100, 22));
    await a.sync.notifyLocalChange('w.bin', 'create');
    await net.settle();
    expect(a.sync.status().pushes).toBe(2);

    a.vault.userRemove('v.bin');
    await a.sync.notifyLocalChange('v.bin', 'delete');
    await net.settle();
    expect(a.sync.status().pushes).toBe(1);

    // 被新版取代：舊版的直送剔除，只剩新版的那一筆
    a.vault.userWrite('w.bin', big(FILE_TIER_MAX_BYTES + 100, 23));
    await a.sync.notifyLocalChange('w.bin', 'modify');
    await net.settle();
    expect(a.sync.status().pushes).toBe(1);
    expect((await a.store.keys('x:')).length).toBe(1);
  });

  it('🔴 大檔經直送交出了版本、中繼還沒送出就在本機刪掉：刪除接在那個版本之後（不當成沒送出而取代它），兩台都刪掉、沒有卡住的待收', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    // a 經中繼送的前一則卡住（例如中繼很慢），後面的版本還排在佇列裡；直連照通
    const send = a.transport.send.bind(a.transport);
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    a.transport.send = async (message, options) => {
      await stuck;
      await send(message, options);
    };
    await a.edit('x.md', '卡在中繼的前一則');
    const video = big(FILE_TIER_MAX_BYTES + 100, 31);
    a.vault.userWrite('v.bin', video);
    await a.sync.notifyLocalChange('v.bin', 'create');
    for (let i = 0; i < 60 && !b.vault.files.has('v.bin'); i += 1) await net.clock.advance(1_000);
    expect(hex(b.vault.files.get('v.bin')!.bytes)).toBe(hex(video));
    a.vault.userRemove('v.bin');
    await a.sync.notifyLocalChange('v.bin', 'delete');
    release();
    await net.settle();
    expect(a.vault.files.has('v.bin')).toBe(false);
    expect(b.vault.files.has('v.bin')).toBe(false);
    for (const d of [a, b]) expect(d.sync.status()).toMatchObject({ pending: [], queue: 0, pushes: 0 });
  });
});

describe('惡意或壞掉的對端（經 P2P 通道）', () => {
  async function evilSetup() {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('ok.md', 'ok');
    await net.settle();
    // 「evil」是名單裡的一台裝置（可能被入侵），直接對 b 開串流
    net.mesh!.link('evil', () => true);
    const channel = await (net.mesh!.link('evil', () => true).open('b'));
    const stream = StreamTransfer.for(channel!, { timers: net.clock });
    const node = (over: Partial<VaultVersion>): VaultVersion => ({
      id: 'e'.repeat(32),
      parents: [],
      path: 'evil.md',
      pathAt: 1,
      deleted: false,
      hash: hex(new TextEncoder().encode('evil')),
      size: 4,
      text: true,
      at: 1,
      device: 'evil',
      label: 'EVIL',
      p2p: false,
      ...over,
    });
    const entry = (n: VaultVersion, content: Uint8Array | null, meta: Record<string, unknown> = {}): StreamEntry => {
      const e = content ? bytesEntry(n.id, content) : bytesEntry(n.id, new Uint8Array(0));
      e.meta = { v: VAULT_WIRE_VERSION, from: 'evil', fileId: 'f'.repeat(32), node: n, c: content ? 1 : 0, ...meta };
      return e;
    };
    const send = async (entries: StreamEntry[]) => {
      const done = stream.send(entries, { purpose: VAULT_STREAM_PURPOSE });
      await net.settle();
      return done;
    };
    return { net, a, b, node, entry, send };
  }

  it('🔴 越界路徑（../、絕對路徑、反斜線）、冒名的寄件裝置、雜湊不符、大小與大檔旗標矛盾：一律拒收，不碰 Vault', { timeout: 60_000 }, async () => {
    const { b, node, entry, send } = await evilSetup();
    const before = b.vault.tree();
    const evil = new TextEncoder().encode('evil');
    const result = await send([
      entry(node({ path: '../outside.md' }), evil),
      entry(node({ path: '/etc/passwd' }), evil),
      entry(node({ path: 'a\\b.md' }), evil),
      entry(node({}), evil, { from: 'a' }), // 冒充 a
      entry(node({ hash: 'a'.repeat(64) }), evil), // 中繼資料說的雜湊與內容不符
      entry(node({ size: 999 }), evil), // 大小不符
      entry(node({ p2p: true }), evil), // 小檔卻標成大檔
    ]);
    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
    expect(b.vault.tree()).toEqual(before);
    expect(b.sync.index().some((i) => i.path.includes('evil') || i.path.includes('outside'))).toBe(false);
  });

  it('🔴 串流層的假雜湊：內容與宣告的 SHA-256 不符 → 不交給協調器', { timeout: 60_000 }, async () => {
    const { b, node, entry, send } = await evilSetup();
    const before = b.vault.tree();
    const bad = entry(node({}), new TextEncoder().encode('evil'));
    bad.read = async () => new TextEncoder().encode('EVIL'); // 送出的內容與宣告不符
    const result = await send([bad]);
    expect(result.results[0]).toEqual({ status: 'failed', reason: '整檔校驗不符' });
    expect(b.vault.tree()).toEqual(before);
  });

  it('合法的版本（名單內裝置、自己的名義）照收：證明上面是驗證擋下的，不是通道不通', { timeout: 60_000 }, async () => {
    const { b, node, entry, send } = await evilSetup();
    const result = await send([entry(node({}), new TextEncoder().encode('evil'))]);
    expect(result.results[0]).toEqual({ status: 'ok' });
    expect(b.vault.get('evil.md')).toBe('evil');
    expect(EMPTY_SHA256).toBe(hex(new Uint8Array(0)));
  });
});
