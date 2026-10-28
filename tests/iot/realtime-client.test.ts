// 手機端 IotClient 的 C′ 細節（SDK ADR 0120），以假的傳輸層測：外層加密給 relay、即時等級的 ttl、額度、只認 relay 簽且解得開的設備 ack。
import type { Event } from 'nostr-tools/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  deriveIotHome,
  generateIotHomeSecret,
  IOT_KIND_ACK,
  IOT_KIND_COMMAND,
  IotClient,
  IotKeyring,
  newIotMsgId,
  parseIotBody,
  sealIotEnvelope,
  type IotBody,
} from '../../src/iot/index.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { FakeTransport } from '../fake-transport.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = deriveIotHome(generateIotHomeSecret());
const gwSk = generateSecretKey();
const gwPub = getPublicKey(gwSk);
const member = Identity.generate();
const mallory = generateSecretKey();

const clients: IotClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

function client(net: FakeTransport): IotClient {
  const c = new IotClient({ pool: net, signer: member, home, gateway: gwPub, budget: new RelayEventBudget({ perMinute: 6000 }), readTimeoutMs: 50, realtime: { devices: { lamp: {} } } });
  clients.push(c);
  return c;
}

/** relay 看到的外層（以閘道私鑰解開） */
function outer(event: Event): IotBody | undefined {
  return parseIotBody(JSON.parse(decryptDM(event.content, gwSk, event.pubkey)));
}

/** relay（或冒充者）簽一則給全家的 25171 */
function ack(signer: Uint8Array, body: IotBody, cmd: Event): Event {
  return finalizeEvent(
    { kind: IOT_KIND_ACK, created_at: Math.floor(Date.now() / 1000), tags: [['h', home.homeTag], ['p', member.pubkey], ['e', cmd.id]], content: encryptDM(JSON.stringify(body), signer, home.homePub) },
    signer,
  ) as unknown as Event;
}

describe('外層與 ttl', () => {
  it('C′ 指令的外層加密給 relay 的閘道公鑰（全家的 homeKey 解不開）；內層是給設備的信封；即時等級 ttl 15、最多 60', async () => {
    const net = new FakeTransport();
    const c = client(net);
    void c.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', ackTimeoutMs: 30 });
    void c.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', ttlSec: 600, ackTimeoutMs: 30 });
    await sleep(10);
    const [a, b] = net.published.filter((e) => e.kind === IOT_KIND_COMMAND);
    expect(new IotKeyring(home, member).open(a!.content, a!.pubkey)).toBeUndefined();
    const body = outer(a!);
    expect(body).toMatchObject({ type: 'dev-cmd', device: 'lamp', env: { kid: 'lamp.0', dir: 'down' } });
    expect(a!.tags).toEqual(expect.arrayContaining([['p', gwPub], ['dv', home.blind('dev:lamp')], ['h', home.homeTag]]));
    expect(a!.tags.some((t) => t[0] === 't')).toBe(false); // relay 不需要、也不該看到 topic 的盲化 id
    const exp = (e: Event) => Number(e.tags.find((t) => t[0] === 'expiration')![1]) - e.created_at;
    expect(exp(a!)).toBe(15);
    expect(exp(b!)).toBe(60);
  });

  it('一般等級（沒給 urgency）的 C′ 指令：逾時照舊回 timeout，不自動查詢', async () => {
    const net = new FakeTransport();
    const r = await client(net).command('home/lamp/power', 'ON', { device: 'lamp', qos: 0, timeoutMs: 30 });
    expect(r.status).toBe('timeout');
    expect(r.after).toBeUndefined();
  });
});

describe('額度（ADR 0049 §10）', () => {
  it('中繼以 iot-quota 拒收 → quota（附重置時間）、不重送', async () => {
    const net = new FakeTransport();
    net.accepted = [];
    net.alsoRejected = [{ url: 'wss://r', reason: 'rate-limited: iot-quota:1767225600' }];
    const r = await client(net).command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', retries: 3, ackTimeoutMs: 30 });
    expect(r).toMatchObject({ status: 'quota', reset: 1767225600, attempts: 1 });
  });

  it('relay 回的 ack 是 quota → 照轉，帶 reset', async () => {
    const net = new FakeTransport();
    const c = client(net);
    const pending = c.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', ackTimeoutMs: 500 });
    await sleep(10);
    const cmd = net.published[0]!;
    net.deliver(ack(gwSk, { v: 1, type: 'ack', msgId: newIotMsgId(), ts: Date.now(), inReplyTo: outer(cmd)!.msgId, status: 'quota', reset: 1767225600 }, cmd));
    expect(await pending).toMatchObject({ status: 'quota', reset: 1767225600 });
  });
});

describe('設備 ack 的信任', () => {
  const upAck = (inReplyTo: string, epoch = 0, k = home.deviceKey('lamp', epoch)) =>
    sealIotEnvelope({ key: k, kid: `lamp.${epoch}`, dir: 'up', ctr: Math.floor(Math.random() * 1e9), ts: Math.floor(Date.now() / 1000), plaintext: JSON.stringify({ type: 'ack', inReplyTo, status: 'ok' }) });

  it('冒充者簽的 dev-ack、舊 epoch 的、解不開的都不算；relay 簽且以 deviceKey 解得開的才算', async () => {
    const net = new FakeTransport();
    const c = client(net);
    const pending = c.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', ackTimeoutMs: 800 });
    await sleep(10);
    const cmd = net.published[0]!;
    const msgId = outer(cmd)!.msgId;
    const report = (env: ReturnType<typeof upAck>): IotBody => ({ v: 1, type: 'dev-ack', msgId: newIotMsgId(), ts: Date.now(), device: 'lamp', env });
    net.deliver(ack(mallory, report(upAck(msgId)), cmd)); // 不是 relay 簽的
    net.deliver(ack(gwSk, report(upAck(msgId, 1)), cmd)); // 不是設定的 epoch
    net.deliver(ack(gwSk, report(upAck(msgId, 0, new Uint8Array(32))), cmd)); // 金鑰不對
    await sleep(20);
    let settled = false;
    void pending.then(() => (settled = true));
    await sleep(20);
    expect(settled).toBe(false);
    net.deliver(ack(gwSk, report(upAck(msgId)), cmd));
    expect((await pending).status).toBe('ok');
  });

  it('金鑰輪換（SDK ADR 0122）：previousEpoch 寬限內舊版本的 ack 算數；過了 until 就不算', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const run = async (until: number): Promise<string> => {
      const net = new FakeTransport();
      const c = new IotClient({ pool: net, signer: member, home, gateway: gwPub, budget: new RelayEventBudget({ perMinute: 6000 }), readTimeoutMs: 50, realtime: { devices: { lamp: { epoch: 1, previousEpoch: { epoch: 0, until } } } } });
      clients.push(c);
      const pending = c.command('home/lamp/power', 'ON', { device: 'lamp', ackTimeoutMs: 150 });
      await sleep(10);
      const cmd = net.published[0]!;
      net.deliver(ack(gwSk, { v: 1, type: 'dev-ack', msgId: newIotMsgId(), ts: Date.now(), device: 'lamp', env: upAck(outer(cmd)!.msgId, 0) }, cmd));
      return (await pending).status;
    };
    expect(await run(nowSec + 3600)).toBe('ok');
    expect(await run(nowSec - 1)).toBe('timeout');
  });

  it('previousEpoch 要比 epoch 小、until 要是整數', () => {
    const make = (lamp: object) => new IotClient({ pool: new FakeTransport(), signer: member, home, gateway: gwPub, realtime: { devices: { lamp } } });
    expect(() => make({ epoch: 1, previousEpoch: { epoch: 1, until: 1 } })).toThrow(RangeError);
    expect(() => make({ epoch: 1, previousEpoch: { epoch: 0, until: 1.5 } })).toThrow(RangeError);
  });
});
