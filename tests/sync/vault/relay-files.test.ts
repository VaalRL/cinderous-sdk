// 中繼拒收檔案塊（kind 1060）（SDK ADR 0027）：分類、明確錯誤與狀態、NIP-11 預先偵測、部署選項。
import { describe, expect, it } from 'vitest';

import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../../src/protocol/index.js';
import { buildRelayInfo } from '../../../src/relay/nip11.js';
import { RelayCore } from '../../../src/relay/relay-core.js';
import { Identity } from '../../../src/identity.js';
import type { PublishResult } from '../../../src/relay-pool.js';
import {
  checkRelayAcceptsFiles,
  createNostrVaultTransport,
  isFileEventsDisabledReason,
  isRelayRejectsFilesError,
  RelayRejectsFilesError,
  relayHttpUrl,
  type RelayInfoFetch,
  type VaultRelayPool,
} from '../../../src/sync/vault/index.js';
import { type Device, Net } from './harness.js';

const alice = getPublicKey(generateSecretKey());

describe('分類：中繼的拒收原因', () => {
  it('🔴 契約：SDK 自己的中繼（RelayCore）沒開檔案事件時的拒收原因，分類成「檔案事件未啟用」', () => {
    const core = new RelayCore();
    core.connect('c1');
    const event: NostrEvent = finalizeEvent({ kind: 1060, created_at: 1_700_000_000, tags: [['p', alice]], content: 'x' }, generateSecretKey());
    const out = core.handle('c1', JSON.stringify(['EVENT', event]));
    const ok = out.find((o) => Array.isArray(o.message) && o.message[0] === 'OK')!.message as unknown[];
    expect(ok[2]).toBe(false);
    expect(isFileEventsDisabledReason(String(ok[3]))).toBe(true);
  });

  it('舊中繼（v0.32 以前、沒有詞元）的句子照樣認得', () => {
    expect(isFileEventsDisabledReason('blocked: 檔案事件未啟用（MAX_FILE_MB）')).toBe(true);
    expect(isFileEventsDisabledReason('blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）')).toBe(true);
  });

  it('其他拒收原因（白名單、太大、速率、天花板）不算', () => {
    expect(isFileEventsDisabledReason('blocked: ceiling: 本站離線留言空間已滿')).toBe(false);
    expect(isFileEventsDisabledReason('blocked: not-allowed: 非本企業成員（allowlist）')).toBe(false);
    for (const reason of ['blocked: 非本企業成員（allowlist）', 'blocked: 檔案塊過大', 'rate-limited: 發送過於頻繁', 'timeout', 'MAX_FILE_MB']) {
      expect(isFileEventsDisabledReason(reason), reason).toBe(false);
    }
  });
});

describe('傳輸層：所有中繼都拒收 → RelayRejectsFilesError', () => {
  function pool(result: PublishResult): VaultRelayPool {
    return { publish: async () => result, subscribe: () => ({ close() {} }) };
  }
  const signer = Identity.generate();
  const other = Identity.generate();

  it('🔴 每一座都說檔案事件未啟用 → 明確的錯誤（附中繼網址），不是一般的「沒有中繼接受」', async () => {
    const transport = createNostrVaultTransport({
      pool: pool({ accepted: [], rejected: [{ url: 'wss://a', reason: 'blocked: 檔案事件未啟用（MAX_FILE_MB）' }, { url: 'wss://b', reason: 'blocked: 檔案事件未啟用（MAX_FILE_MB）' }] }),
      signer,
      devices: [other.pubkey],
    });
    const error = await transport.send({ type: 'want', from: 'a', items: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRejectsFilesError);
    expect((error as RelayRejectsFilesError).relays).toEqual(['wss://a', 'wss://b']);
    expect(isRelayRejectsFilesError(error)).toBe(true);
    expect(isRelayRejectsFilesError({ code: 'relay-rejects-files' })).toBe(true); // 自訂傳輸層也可以這樣丟
  });

  it('原因混雜（有一座只是斷線）→ 一般錯誤，照常退避重試', async () => {
    const transport = createNostrVaultTransport({
      pool: pool({ accepted: [], rejected: [{ url: 'wss://a', reason: 'blocked: 檔案事件未啟用（MAX_FILE_MB）' }, { url: 'wss://b', reason: 'not connected' }] }),
      signer,
      devices: [other.pubkey],
    });
    const error = await transport.send({ type: 'want', from: 'a', items: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayRejectsFilesError);
  });
});

/** 假中繼拒收 1060：送出一律丟 RelayRejectsFilesError（像 NostrVaultTransport 對上沒開檔案事件的中繼） */
function rejectFiles(device: Device, net: Net, counter: { attempts: number[] }) {
  const send = device.transport.send.bind(device.transport);
  let rejecting = true;
  device.transport.send = async (message) => {
    counter.attempts.push(net.clock.now());
    if (rejecting) throw new RelayRejectsFilesError(['wss://my-relay']);
    return send(message);
  };
  return () => (rejecting = false);
}

describe('協調器：中繼拒收 1060 的情境（假中繼）', () => {
  it('🔴 狀態明確（blocked: relay-rejects-files）、只報一次錯、不會一直重試；站方開啟後自動恢復並同步', async () => {
    const net = new Net({ options: { retryMaxMs: 5 * 60_000 } });
    const a = await net.add('a');
    const b = await net.add('b');
    const counter = { attempts: [] as number[] };
    const fix = rejectFiles(a, net, counter);
    await a.edit('note.md', '寫不出去');
    await net.clock.advance(30 * 60_000); // 半小時
    const status = a.sync.status();
    expect(status).toMatchObject({ state: 'error', blocked: 'relay-rejects-files', queue: 1 });
    expect(a.errors.filter((e) => e.startsWith('relay-rejects-files'))).toHaveLength(1);
    // 半小時內只探了幾次（最長退避 5 分鐘），不是一直打
    expect(counter.attempts.length).toBeLessThanOrEqual(8);

    fix(); // 站方設了 MAX_FILE_MB
    await net.settle();
    expect(b.vault.get('note.md')).toBe('寫不出去');
    expect(a.sync.status().blocked).toBeUndefined();
    expect(a.sync.status().state).toBe('idle');
  });

  it('🔴 有 P2P 時：中繼拒收也不影響在線裝置之間的同步（全部改走 P2P 批次）', async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const fixA = rejectFiles(a, net, { attempts: [] });
    const fixB = rejectFiles(b, net, { attempts: [] });
    await a.edit('x.md', '經 P2P');
    await b.edit('y.md', '也經 P2P');
    await net.settle();
    expect(b.vault.get('x.md')).toBe('經 P2P');
    expect(a.vault.get('y.md')).toBe('也經 P2P');
    // 佇列全部經直連送完：沒有東西卡在中繼上，blocked 清掉（SDK ADR 0053 §G13）；下一則經中繼的會再驗證
    expect(a.sync.status()).toMatchObject({ queue: 0, state: 'idle' });
    expect(a.sync.status().blocked).toBeUndefined();
    fixA();
    fixB();
  });
});

describe('NIP-11 預先偵測：checkRelayAcceptsFiles', () => {
  const fetchInfo = (info: unknown, status = 200): { fetch: RelayInfoFetch; calls: Array<{ url: string; headers: Record<string, string> }> } => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return { status, text: async () => (typeof info === 'string' ? info : JSON.stringify(info)) };
      },
    };
  };

  it('🔴 讀中繼自己產生的 NIP-11（buildRelayInfo）：沒開 → false、開了 → true；以 Accept: application/nostr+json 要 JSON', async () => {
    const off = fetchInfo(buildRelayInfo({}));
    expect(await checkRelayAcceptsFiles('wss://relay.example.workers.dev', { fetch: off.fetch })).toMatchObject({ acceptsFiles: false, httpUrl: 'https://relay.example.workers.dev/' });
    expect(off.calls[0]!.headers.Accept).toBe('application/nostr+json');
    const on = fetchInfo(buildRelayInfo({ acceptsFiles: true }));
    expect((await checkRelayAcceptsFiles('wss://relay.example.workers.dev', { fetch: on.fetch })).acceptsFiles).toBe(true);
  });

  it('不是 Cinderous 中繼（沒有 cinder_accepts_files）→ null（未知）；HTTP 錯誤或不是 JSON → 丟例外', async () => {
    expect((await checkRelayAcceptsFiles('wss://nos.lol', { fetch: fetchInfo({ name: 'nos.lol', software: 'x' }).fetch })).acceptsFiles).toBeNull();
    await expect(checkRelayAcceptsFiles('wss://x', { fetch: fetchInfo({}, 404).fetch })).rejects.toThrow('HTTP 404');
    await expect(checkRelayAcceptsFiles('wss://x', { fetch: fetchInfo('<html>').fetch })).rejects.toThrow('NIP-11');
  });

  it('網址轉換：wss → https、ws → http；其他協定拒絕', () => {
    expect(relayHttpUrl('wss://a.b/path')).toBe('https://a.b/path');
    expect(relayHttpUrl('ws://localhost:8787')).toBe('http://localhost:8787/');
    expect(() => relayHttpUrl('ftp://x')).toThrow();
  });
});
