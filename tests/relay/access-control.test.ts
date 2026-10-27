// 中繼存取控制（PRD 3.3；SDK ADR 0013）：白名單外斷線 4003、每把公鑰的連線數、每個 IP 的訊息速率。
import { describe, expect, it } from 'vitest';

import { buildAuthEvent, finalizeEvent, generateSecretKey, getPublicKey, type SecretKey } from '../../src/protocol/index.js';
import { connectionsPerPubkeyFrom, messagesPerSecondPerIpFrom } from '../../src/relay/host-config.js';
import { MessageStore } from '../../src/relay/message-store.js';
import { RelayCore, type Outbound, type RelayCoreOptions } from '../../src/relay/relay-core.js';

function core(opts: Partial<RelayCoreOptions> = {}, now = () => 1_800_000_000) {
  let n = 0;
  return new RelayCore({ store: new MessageStore(), requireAuth: true, authChallenge: () => `c${n++}`, now, ...opts });
}

function auth(relay: RelayCore, connId: string, sk: SecretKey, ip?: string): Outbound[] {
  const [challenge] = relay.connect(connId, undefined, ip);
  const event = buildAuthEvent((challenge!.message as [string, string])[1], 'wss://relay.example', sk);
  return relay.handle(connId, JSON.stringify(['AUTH', event]));
}

describe('白名單外的人：認證後立刻斷線（4003）', () => {
  it('名單外 → OK false（restricted:）並以 4003 關閉', () => {
    const member = generateSecretKey();
    const relay = core({ allowedAuthors: [getPublicKey(member)] });
    const out = auth(relay, 'c1', generateSecretKey());
    const ok = out.find((o) => o.message[0] === 'OK')!;
    expect(ok.message[2]).toBe(false);
    expect(String(ok.message[3])).toMatch(/^restricted:/);
    expect(ok.close).toEqual({ code: 4003, reason: 'restricted' });
  });

  it('名單上的人 → 認證成功、不關閉', () => {
    const member = generateSecretKey();
    const relay = core({ allowedAuthors: [getPublicKey(member)] });
    const ok = auth(relay, 'c1', member).find((o) => o.message[0] === 'OK')!;
    expect(ok.message[2]).toBe(true);
    expect(ok.close).toBeUndefined();
  });

  it('沒有白名單 → 誰都能認證（錨點行為不變）', () => {
    const ok = auth(core(), 'c1', generateSecretKey()).find((o) => o.message[0] === 'OK')!;
    expect(ok.message[2]).toBe(true);
  });
});

describe('每把公鑰的同時連線數', () => {
  it('超過上限的那一條：認證被拒並關閉；舊的斷掉之後就能再連', () => {
    const sk = generateSecretKey();
    const relay = core({ maxConnectionsPerPubkey: 2 });
    expect(auth(relay, 'a', sk).find((o) => o.message[0] === 'OK')!.message[2]).toBe(true);
    expect(auth(relay, 'b', sk).find((o) => o.message[0] === 'OK')!.message[2]).toBe(true);
    const third = auth(relay, 'c', sk).find((o) => o.message[0] === 'OK')!;
    expect(third.message[2]).toBe(false);
    expect(third.close).toEqual({ code: 1008, reason: 'too-many-connections' });

    relay.disconnect('a');
    expect(auth(relay, 'd', sk).find((o) => o.message[0] === 'OK')!.message[2]).toBe(true);
  });

  it('不同人各自計算；沒設上限就不限（錨點行為不變）', () => {
    const relay = core({ maxConnectionsPerPubkey: 1 });
    expect(auth(relay, 'a', generateSecretKey()).find((o) => o.message[0] === 'OK')!.message[2]).toBe(true);
    expect(auth(relay, 'b', generateSecretKey()).find((o) => o.message[0] === 'OK')!.message[2]).toBe(true);
    const open = core();
    const sk = generateSecretKey();
    for (const id of ['1', '2', '3', '4', '5', '6']) {
      expect(auth(open, id, sk).find((o) => o.message[0] === 'OK')!.message[2]).toBe(true);
    }
  });
});

describe('每個 IP 每秒的訊息數', () => {
  const req = (i: number) => JSON.stringify(['REQ', `s${i}`, { kinds: [1], limit: 1 }]);

  it('同一個 IP 的所有連線合計：超過就關閉送出那則的連線；別的 IP 不受影響', () => {
    let now = 1_800_000_000;
    const relay = core({ requireAuth: false, maxMessagesPerSecondPerIp: 3 }, () => now);
    relay.connect('a', undefined, '1.1.1.1');
    relay.connect('b', undefined, '1.1.1.1');
    relay.connect('c', undefined, '2.2.2.2');
    expect(relay.handle('a', req(1)).some((o) => o.close)).toBe(false);
    expect(relay.handle('b', req(2)).some((o) => o.close)).toBe(false);
    expect(relay.handle('a', req(3)).some((o) => o.close)).toBe(false);
    const over = relay.handle('b', req(4));
    expect(over.find((o) => o.close)?.close).toEqual({ code: 1008, reason: 'rate-limited' });
    expect(relay.handle('c', req(5)).some((o) => o.close)).toBe(false);

    now += 1; // 下一秒重新計算
    expect(relay.handle('a', req(6)).some((o) => o.close)).toBe(false);
  });

  it('宿主沒給 IP 的連線不受這條限制（本機測試、內嵌中繼）', () => {
    const relay = core({ requireAuth: false, maxMessagesPerSecondPerIp: 1 });
    relay.connect('a');
    for (let i = 0; i < 5; i += 1) expect(relay.handle('a', req(i)).some((o) => o.close)).toBe(false);
  });
});

describe('環境變數解析', () => {
  it('沒設或壞值 → undefined（不限）；正整數 → 採用', () => {
    for (const parse of [connectionsPerPubkeyFrom, messagesPerSecondPerIpFrom]) {
      expect(parse(undefined)).toBeUndefined();
      expect(parse('')).toBeUndefined();
      expect(parse('abc')).toBeUndefined();
      expect(parse('0')).toBeUndefined();
      expect(parse('5')).toBe(5);
    }
  });
});

describe('白名單站與禮物包（SDK ADR 0028 §7）', () => {
  // Gift Wrap 的外層作者是每則一把的一次性金鑰，永遠不在名單上；以名單上的身分認證過的連線要放行
  const wrapFrom = (kind: number) => finalizeEvent({ kind, created_at: 1_800_000_000, tags: [['p', getPublicKey(generateSecretKey())]], content: 'x' }, generateSecretKey());

  it('名單上的身分認證過的連線：外層作者不在名單上的禮物包（1060、21003）照收', () => {
    const member = generateSecretKey();
    const relay = core({ allowedAuthors: [getPublicKey(member)], acceptFileEvents: true });
    auth(relay, 'c1', member);
    for (const kind of [1060, 21003, 1059]) {
      const event = wrapFrom(kind);
      const ok = relay.handle('c1', JSON.stringify(['EVENT', event])).find((o) => o.message[0] === 'OK')!;
      expect(ok.message[2], `kind ${kind}：${String(ok.message[3])}`).toBe(true);
    }
  });

  it('例外只給禮物包類：名單上的成員不能替外人發布會被保存的一般事件（安全審查 #6）', () => {
    const member = generateSecretKey();
    const relay = core({ allowedAuthors: [getPublicKey(member)], acceptFileEvents: true });
    auth(relay, 'c1', member);
    for (const kind of [0, 1, 10002, 30078]) {
      const ok = relay.handle('c1', JSON.stringify(['EVENT', wrapFrom(kind)])).find((o) => o.message[0] === 'OK')!;
      expect(ok.message[2], `kind ${kind}`).toBe(false);
    }
  });

  it('沒認證的連線：外層作者不在名單上照樣拒收（原本的行為）', () => {
    const member = generateSecretKey();
    const relay = core({ allowedAuthors: [getPublicKey(member)], requireAuth: false, acceptFileEvents: true });
    relay.connect('c1');
    const ok = relay.handle('c1', JSON.stringify(['EVENT', wrapFrom(1060)])).find((o) => o.message[0] === 'OK')!;
    expect(ok.message[2]).toBe(false);
    expect(String(ok.message[3])).toMatch(/allowlist/);
  });

  it('名單外的人在認證時就被 4003 斷線，拿不到這個例外', () => {
    const relay = core({ allowedAuthors: [getPublicKey(generateSecretKey())] });
    const outsider = generateSecretKey();
    const out = auth(relay, 'c1', outsider);
    expect(out.find((o) => o.message[0] === 'OK')!.close).toEqual({ code: 4003, reason: 'restricted' });
    const ok = relay.handle('c1', JSON.stringify(['EVENT', wrapFrom(1060)])).find((o) => o.message[0] === 'OK')!;
    expect(ok.message[2]).toBe(false);
  });
});
