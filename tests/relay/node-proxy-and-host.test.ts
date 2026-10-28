// Node 版中繼在反向代理後方（SDK ADR 0119，ADR 0109〈後續〉）：
// - `X-Forwarded-For` 從右邊數：會「附加」的代理（nginx 的 $proxy_add_x_forwarded_for、Cloudflare、Fly）前面那段是客戶端自己帶的；
// - `HOST`：只聽某個位址（systemd 路線不必只靠防火牆）。
import { networkInterfaces } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { clientIpFrom, trustedProxyHopsFrom } from '../../src/relay/host-config.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

const handles: { close(): void }[] = [];
const sockets: WsClient[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const handle of handles.splice(0)) handle.close();
});

/** 'open'：收到 AUTH 挑戰；'blocked'：收到 NOTICE 後被關；'refused'：連不上 */
function connect(url: string, headers: Record<string, string> = {}): Promise<'open' | 'blocked' | 'refused'> {
  return new Promise((resolve) => {
    const ws = new WsClient(url, { headers });
    sockets.push(ws);
    let opened = false;
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as unknown[])[0] === 'AUTH') {
        opened = true;
        resolve('open');
      }
    });
    ws.on('close', () => {
      if (!opened) resolve('blocked');
    });
    ws.on('error', () => resolve('refused'));
  });
}

describe('trustedProxyHopsFrom（TRUST_PROXY）', () => {
  it('1＝一層代理（與之前的 TRUST_PROXY=1 相同的開關）；2–10＝幾層；其他＝不信任', () => {
    expect(trustedProxyHopsFrom('1')).toBe(1);
    expect(trustedProxyHopsFrom('2')).toBe(2);
    expect(trustedProxyHopsFrom('10')).toBe(10);
    for (const raw of [undefined, '', '0', 'true', 'yes', '-1', '1.5', '11', ' 1x']) expect(trustedProxyHopsFrom(raw), String(raw)).toBe(0);
  });
});

describe('clientIpFrom', () => {
  it('不信任代理：一律用連線的來源位址', () => {
    expect(clientIpFrom('203.0.113.9', '10.0.0.2', 0)).toBe('10.0.0.2');
  });

  it('🔴 一層代理：取最右邊那段（前面的是客戶端自己帶的）', () => {
    expect(clientIpFrom('203.0.113.9', '10.0.0.2', 1)).toBe('203.0.113.9');
    expect(clientIpFrom('6.6.6.6, 203.0.113.9', '10.0.0.2', 1)).toBe('203.0.113.9');
    expect(clientIpFrom(' 6.6.6.6 ,203.0.113.9 ', '10.0.0.2', 1)).toBe('203.0.113.9');
  });

  it('兩層代理：從右邊數第二段；段數比層數少時取最左邊（都是信任的代理寫的）', () => {
    expect(clientIpFrom('6.6.6.6, 203.0.113.9, 198.51.100.1', '10.0.0.2', 2)).toBe('203.0.113.9');
    expect(clientIpFrom('203.0.113.9', '10.0.0.2', 2)).toBe('203.0.113.9');
  });

  it('沒有標頭或是空的：退回連線的來源位址', () => {
    expect(clientIpFrom(undefined, '10.0.0.2', 1)).toBe('10.0.0.2');
    expect(clientIpFrom(' , ', '10.0.0.2', 1)).toBe('10.0.0.2');
    expect(clientIpFrom(undefined, undefined, 1)).toBeUndefined();
  });
});

describe('startNodeRelay：反向代理後方的 IP', () => {
  it('🔴 客戶端在 X-Forwarded-For 前面自己加一段，換不到新的 IP 名額', async () => {
    const p = await opened(handles, startNodeRelay({ PORT: '0', MAX_CONNECTIONS_PER_IP: '1', TRUST_PROXY: '1' }, { memory: true }));
    const url = `ws://127.0.0.1:${p}`;
    expect(await connect(url, { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })).toBe('open');
    expect(await connect(url, { 'x-forwarded-for': '2.2.2.2, 203.0.113.9' })).toBe('blocked');
    expect(await connect(url, { 'x-forwarded-for': '203.0.113.10' })).toBe('open');
  });
});

describe('startNodeRelay：HOST', () => {
  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((info) => info !== undefined && info.family === 'IPv4' && !info.internal)?.address;

  it('HOST=127.0.0.1：本機連得到；（有區網位址時）從區網位址連不到', async () => {
    const p = await opened(handles, startNodeRelay({ PORT: '0', HOST: '127.0.0.1' }, { memory: true }));
    expect(await connect(`ws://127.0.0.1:${p}`)).toBe('open');
    if (lanIp !== undefined) expect(await connect(`ws://${lanIp}:${p}`)).toBe('refused');
  });

  it('沒設 HOST：照舊聽所有位址', async () => {
    const p = await opened(handles, startNodeRelay({ PORT: '0' }, { memory: true }));
    expect(await connect(`ws://127.0.0.1:${p}`)).toBe('open');
    if (lanIp !== undefined) expect(await connect(`ws://${lanIp}:${p}`)).toBe('open');
  });

  it('HOST 不是這台機器的位址 → ready 以錯誤結束（不會默默聽在別處）', async () => {
    await expect(opened(handles, startNodeRelay({ PORT: '0', HOST: '192.0.2.123' }, { memory: true }))).rejects.toThrow();
  });
});
