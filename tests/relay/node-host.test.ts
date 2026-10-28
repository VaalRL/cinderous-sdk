// Node 版中繼主機（SDK ADR 0007）：原本是一載入就開 server 的腳本，改成 `startNodeRelay`／`startDevRelay`。
// 真的開一台起來：連得上、會送 NIP-42 挑戰、/healthz 回 ok、關得掉。
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildAuthEvent, buildInboxAck, finalizeEvent, generateSecretKey, getPublicKey, npubEncode, type NostrEvent } from '../../src/protocol/index.js';
import { startDevRelay } from '../../src/relay/dev-server.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

function firstMessage(url: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('沒有收到訊息')), 3_000);
    ws.addEventListener('message', (event) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(event.data)) as unknown[]);
    });
    ws.addEventListener('error', () => reject(new Error('連不上')));
  });
}

const handles: { close(): void }[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

describe('startNodeRelay', () => {
  it('開起來：連上就送 NIP-42 挑戰；/healthz 回 ok；NIP-11 回 JSON', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', DB_PATH: ':memory:', RELAY_NAME: '測試站' }));
    const [type, challenge] = await firstMessage(`ws://127.0.0.1:${p}`);
    expect(type).toBe('AUTH');
    expect(typeof challenge).toBe('string');
    expect(await (await fetch(`http://127.0.0.1:${p}/healthz`)).text()).toBe('ok');
    const info = (await (
      await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })
    ).json()) as { name?: string; software?: string };
    expect(info.name).toBe('測試站');
    expect(info.software).toBe('https://github.com/VaalRL/cinderous-sdk');
  });

  it('RELAY_SOFTWARE_URL → NIP-11 software（SDK ADR 0050；改過中繼的人履行 AGPL §13）', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', DB_PATH: ':memory:', RELAY_SOFTWARE_URL: 'https://git.example.com/fork' }));
    const info = (await (
      await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })
    ).json()) as { software?: string };
    expect(info.software).toBe('https://git.example.com/fork');
  });
});

describe('startNodeRelay：ready（SDK ADR 0114）', () => {
  it('PORT=0：由系統分配埠，ready 給出實際的埠，連得上', async () => {
    const relay = startNodeRelay({ PORT: '0' }, { memory: true });
    handles.push(relay);
    const p = await relay.ready;
    expect(p).toBeGreaterThan(0);
    expect((await firstMessage(`ws://127.0.0.1:${p}`))[0]).toBe('AUTH');
  });

  it('🔴 埠被佔用：ready 以 EADDRINUSE 失敗，不會默默沒開', async () => {
    const first = startNodeRelay({ PORT: '0' }, { memory: true });
    handles.push(first);
    const p = await first.ready;
    const second = startNodeRelay({ PORT: String(p) }, { memory: true });
    handles.push(second);
    await expect(second.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('startDevRelay', () => {
  it('純記憶體開發站：連得上、回得了查詢、關得掉', async () => {
    const p = await opened(handles, startDevRelay(0));
    // 開發站不要求認證（RelayCore 預設），所以不會先送挑戰：送一個 REQ，看得到 EOSE 就是活的
    const reply = await new Promise<unknown[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}`);
      const timer = setTimeout(() => reject(new Error('沒有收到 EOSE')), 3_000);
      ws.addEventListener('open', () => ws.send(JSON.stringify(['REQ', 's', { kinds: [1], limit: 1 }])));
      ws.addEventListener('message', (event) => {
        clearTimeout(timer);
        ws.close();
        resolve(JSON.parse(String(event.data)) as unknown[]);
      });
    });
    expect(reply).toEqual(['EOSE', 's']);
  });
});

/** 開一條連線、送一則訊息，回傳第一則 OK。 */
function publishOnce(url: string, event: NostrEvent): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('沒有收到 OK')), 3_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.addEventListener('message', (message) => {
      const parsed = JSON.parse(String(message.data)) as unknown[];
      if (parsed[0] !== 'OK') return;
      clearTimeout(timer);
      ws.close();
      resolve(parsed);
    });
  });
}

const beat = (sk: Uint8Array): NostrEvent =>
  finalizeEvent({ kind: 20000, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' }, sk);

describe('startNodeRelay：白名單與純記憶體（SDK ADR 0008）', () => {
  it('ALLOWED_PUBKEYS：名單上的人收下、名單外的人 blocked', async () => {
    const member = generateSecretKey();
    const p = await opened(handles,
      startNodeRelay({ PORT: '0', DB_PATH: ':memory:', REQUIRE_AUTH: '0', ALLOWED_PUBKEYS: npubEncode(getPublicKey(member)) }),
    );
    expect((await publishOnce(`ws://127.0.0.1:${p}`, beat(member)))[2]).toBe(true);
    const outsider = await publishOnce(`ws://127.0.0.1:${p}`, beat(generateSecretKey()));
    expect(outsider[2]).toBe(false);
    expect(String(outsider[3])).toMatch(/^blocked:/);
  });

  it('🔴 ALLOWED_PUBKEYS 寫錯 → 直接拒絕啟動，不會默默變成開放中繼', () => {
    expect(() => startNodeRelay({ PORT: '0', DB_PATH: ':memory:', ALLOWED_PUBKEYS: 'npub1壞掉' })).toThrow();
  });

  it('memory: true → 不碰 SQLite 檔（就算環境裡有 DB_PATH）', async () => {
    const dbPath = join(tmpdir(), `cinderous-mem-${process.pid}-${Date.now()}.db`);
    const p = await opened(handles,startNodeRelay({ PORT: '0', DB_PATH: dbPath, REQUIRE_AUTH: '0' }, { memory: true }));
    expect((await publishOnce(`ws://127.0.0.1:${p}`, beat(generateSecretKey())))[2]).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe('startNodeRelay：存取控制（PRD 3.3；SDK ADR 0013）', () => {
  it('🔴 名單外的人認證後，連線以 4003 關閉', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', ALLOWED_PUBKEYS: getPublicKey(generateSecretKey()) }, { memory: true }));
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}`);
      const timer = setTimeout(() => reject(new Error('沒有被關閉')), 3_000);
      ws.addEventListener('message', (message) => {
        const [type, challenge] = JSON.parse(String(message.data)) as [string, string];
        if (type === 'AUTH') ws.send(JSON.stringify(['AUTH', buildAuthEvent(challenge, `ws://127.0.0.1:${p}`, generateSecretKey())]));
      });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
    expect(code).toBe(4003);
  });
});

describe('startNodeRelay：NIP-11 的 version（SDK ADR 0018 冒煙測試抓到）', () => {
  it('宿主注入的版號出現在 NIP-11（與 Worker 一致；Cinderous 的一鍵更新節點靠它比對）', async () => {
    const { setRelayVersion } = await import('../../src/relay/version.js');
    setRelayVersion('9.8.7');
    const p = await opened(handles,startNodeRelay({ PORT: '0' }, { memory: true }));
    const info = (await (await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })).json()) as { version?: string };
    expect(info.version).toBe('9.8.7');
    setRelayVersion('0.0.0');
  });
});

describe('startNodeRelay：收件確認（SDK ADR 0067）', () => {
  it('NIP-11 宣告、本人送確認回 OK true（記憶體與 SQLite 兩種儲存）', async () => {
    for (const memory of [true, false]) {
      const p = await opened(handles,startNodeRelay({ PORT: '0', DB_PATH: ':memory:' }, { memory }));
      const info = (await (
        await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })
      ).json()) as { cinder_inbox_ack?: unknown };
      expect(info.cinder_inbox_ack).toEqual({ kind: 25190, grace_sec: 7_200 });
      const sk = generateSecretKey();
      const ok = await new Promise<unknown[]>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p}`);
        const timer = setTimeout(() => reject(new Error('沒有收到 OK')), 3_000);
        ws.addEventListener('message', (message) => {
          const msg = JSON.parse(String(message.data)) as unknown[];
          if (msg[0] === 'AUTH') ws.send(JSON.stringify(['AUTH', buildAuthEvent(String(msg[1]), `ws://127.0.0.1:${p}`, sk)]));
          else if (msg[0] === 'OK' && msg[2] === true && !('acked' in ws)) {
            Object.assign(ws, { acked: true });
            ws.send(JSON.stringify(['EVENT', buildInboxAck(['ab'.repeat(32)], sk)]));
          } else if (msg[0] === 'OK') {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
      });
      expect(ok[2]).toBe(true);
    }
  });

  it('REQUIRE_AUTH=0：不發挑戰，就不宣告', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', REQUIRE_AUTH: '0' }, { memory: true }));
    const info = (await (
      await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })
    ).json()) as Record<string, unknown>;
    expect('cinder_inbox_ack' in info).toBe(false);
  });
});
