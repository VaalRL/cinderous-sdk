// Node 版中繼的同時連線數上限（SDK ADR 0100）：`MAX_CONNECTIONS`（全站）與 `MAX_CONNECTIONS_PER_IP`，沒設＝不限。
// 超過時與 ADR-0368／SDK ADR 0097 同一個形狀：接受升級、送一則 NOTICE、以 1013 Try Again Later 關閉。
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { maxConnectionsFrom, maxConnectionsPerIpFrom } from '../../src/relay/host-config.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';
import { upgradeRejection, upgradeCloseCode } from '../../src/relay/reject-messages.js';

const handles: { close(): void }[] = [];
const sockets: WsClient[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const handle of handles.splice(0)) handle.close();
});

type Outcome = { kind: 'open'; first: unknown[] } | { kind: 'closed'; code: number; reason: string; notice?: string };

/** 連上之後第一件事：收到 AUTH 挑戰＝進來了；收到 NOTICE 然後被關＝被擋 */
function connect(url: string, headers: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, { headers });
    sockets.push(ws);
    let notice: string | undefined;
    const timer = setTimeout(() => reject(new Error('沒有任何回應')), 3_000);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as unknown[];
      if (msg[0] === 'NOTICE') {
        notice = String(msg[1]);
        return;
      }
      clearTimeout(timer);
      resolve({ kind: 'open', first: msg });
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ kind: 'closed', code, reason: reason.toString(), ...(notice !== undefined ? { notice } : {}) });
    });
    ws.on('error', () => {});
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('連線數設定的解析（SDK ADR 0100）', () => {
  it('沒設或壞值＝不限；正整數照用', () => {
    expect(maxConnectionsFrom(undefined)).toBeUndefined();
    expect(maxConnectionsFrom('abc')).toBeUndefined();
    expect(maxConnectionsFrom('0')).toBeUndefined();
    expect(maxConnectionsFrom('2000')).toBe(2000);
    expect(maxConnectionsPerIpFrom('20')).toBe(20);
    expect(maxConnectionsPerIpFrom('')).toBeUndefined();
  });

  it('拒絕的句子：說得出原因、不附開發文件、以 1013 關閉', () => {
    const full = upgradeRejection('too-many-connections', 'relay.example', 'https://docs.example');
    expect(full.notice).toMatch(/^too many connections: /);
    expect(full.notice).not.toContain('docs.example');
    expect(full.reason).toBe('too many connections');
    const ip = upgradeRejection('too-many-connections-ip', 'relay.example', undefined);
    expect(ip.notice).toMatch(/^too many connections: .*your IP/);
    expect(upgradeCloseCode('too-many-connections')).toBe(1013);
    expect(upgradeCloseCode('too-many-connections-ip')).toBe(1013);
    expect(upgradeCloseCode('unknown-path')).toBe(1008);
  });
});

describe('startNodeRelay：同時連線數（SDK ADR 0100）', () => {
  it('🔴 MAX_CONNECTIONS：滿了的下一條收到說明並以 1013 關閉；有人離開後又進得來', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', MAX_CONNECTIONS: '2' }, { memory: true }));
    await wait(100);
    const url = `ws://127.0.0.1:${p}`;
    expect((await connect(url)).kind).toBe('open');
    expect((await connect(url)).kind).toBe('open');
    const third = await connect(url);
    expect(third).toMatchObject({ kind: 'closed', code: 1013, reason: 'too many connections' });
    expect((third as { notice?: string }).notice).toMatch(/^too many connections: /);
    sockets[0]!.close();
    await wait(200);
    expect((await connect(url)).kind).toBe('open');
  });

  it('🔴 MAX_CONNECTIONS_PER_IP：同一個 IP 超過就擋，別的 IP 照常（TRUST_PROXY 時看 X-Forwarded-For）', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', MAX_CONNECTIONS_PER_IP: '1', TRUST_PROXY: '1' }, { memory: true }));
    await wait(100);
    const url = `ws://127.0.0.1:${p}`;
    expect((await connect(url, { 'x-forwarded-for': '203.0.113.1' })).kind).toBe('open');
    const again = await connect(url, { 'x-forwarded-for': '203.0.113.1' });
    expect(again).toMatchObject({ kind: 'closed', code: 1013 });
    expect((again as { notice?: string }).notice).toMatch(/your IP/);
    expect((await connect(url, { 'x-forwarded-for': '203.0.113.2' })).kind).toBe('open');
  });

  it('被擋的連線不佔名額（不會因為一直被擋而永遠進不來）', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0', MAX_CONNECTIONS: '1' }, { memory: true }));
    await wait(100);
    const url = `ws://127.0.0.1:${p}`;
    expect((await connect(url)).kind).toBe('open');
    for (let i = 0; i < 3; i += 1) expect((await connect(url)).kind).toBe('closed');
    sockets[0]!.close();
    await wait(200);
    expect((await connect(url)).kind).toBe('open');
  });

  it('沒設＝不限（與之前相同）', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0' }, { memory: true }));
    await wait(100);
    const url = `ws://127.0.0.1:${p}`;
    for (let i = 0; i < 5; i += 1) expect((await connect(url)).kind).toBe('open');
  });
});
