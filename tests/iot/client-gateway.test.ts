// IotClient × IotGateway 以假的傳輸層（不過濾、什麼都送）測安全邊界：客戶端只收閘道簽的狀態類事件（ADR 0049 §6），
// 閘道只收寄給自己、這個家的指令；中繼拒收時回 `relay-rejected`；QoS 0 不重送。
import type { Event } from 'nostr-tools/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  buildIotEvent,
  deriveIotHome,
  generateIotHomeSecret,
  IOT_KIND_ACK,
  IOT_KIND_COMMAND,
  IOT_KIND_RETAINED,
  IOT_KIND_STATE,
  IotClient,
  IotGateway,
  IotKeyring,
  newIotMsgId,
  type IotCommandRequest,
  type IotStateMessage,
} from '../../src/iot/index.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { FakeTransport } from '../fake-transport.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = deriveIotHome(generateIotHomeSecret());
const gw = Identity.generate();
const member = Identity.generate();
const mallory = Identity.generate(); // 也拿到了家庭秘密，但不是閘道

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

function setup(handled: IotCommandRequest[] = []) {
  const net = new FakeTransport();
  net.relay = true;
  const gateway = new IotGateway({
    pool: net,
    signer: gw,
    home,
    acl: [{ pubkey: member.pubkey, role: 'owner' }],
    handler: { command: (req) => (handled.push(req), { status: 'ok' }) },
    budget: new RelayEventBudget({ perMinute: 6000 }),
    retainedDebounceMs: 10,
  });
  const client = new IotClient({ pool: net, signer: member, home, gateway: gw.pubkey, budget: new RelayEventBudget({ perMinute: 6000 }), readTimeoutMs: 50 });
  stops.push(() => client.close(), () => gateway.stop({ announceOffline: false }));
  return { net, gateway, client, handled };
}

describe('客戶端只收閘道簽的狀態類事件', () => {
  it('別人（就算有家庭秘密）簽的 25172 不會被當成狀態；閘道簽的才會', async () => {
    const { net, gateway, client } = setup();
    await gateway.start();
    const got: IotStateMessage[] = [];
    client.subscribeState('home/#', (m) => got.push(m));
    const forged = buildIotEvent(new IotKeyring(home, mallory), mallory, IOT_KIND_STATE, [['h', home.homeTag], ['t', home.blind('home/door/lock')]], {
      v: 1, type: 'state', msgId: newIotMsgId(), ts: Date.now(), topic: 'home/door/lock', payload: 'UNLOCKED', enc: 'utf8',
    });
    net.deliver(forged as unknown as Event);
    // 偽造作者欄位（簽章不對）也不行
    net.deliver({ ...(forged as unknown as Event), pubkey: gw.pubkey });
    await gateway.reportState({ topic: 'home/door/lock', payload: 'LOCKED', device: 'door' });
    expect(got.map((m) => m.payload)).toEqual(['LOCKED']);
  });

  it('偽造的 ack 不會讓指令看起來成功', async () => {
    const net = new FakeTransport();
    net.relay = true;
    const client = new IotClient({ pool: net, signer: member, home, gateway: gw.pubkey, budget: new RelayEventBudget() });
    stops.push(() => client.close());
    const pending = client.command('home/plug/set', 'ON', { qos: 0, timeoutMs: 300 });
    await sleep(20);
    const cmd = net.published.find((e) => e.kind === IOT_KIND_COMMAND)!;
    const body = new IotKeyring(home, gw).open(cmd.content, cmd.pubkey)!;
    const fakeAck = buildIotEvent(new IotKeyring(home, mallory), mallory, IOT_KIND_ACK, [['h', home.homeTag], ['e', cmd.id], ['p', member.pubkey]], {
      v: 1, type: 'ack', msgId: newIotMsgId(), ts: Date.now(), inReplyTo: body.msgId, status: 'ok',
    });
    net.deliver(fakeAck as unknown as Event);
    expect((await pending).status).toBe('timeout');
  });

  it('getRetained 不採信別人簽的 31170', async () => {
    const net = new FakeTransport();
    const client = new IotClient({ pool: net, signer: member, home, gateway: gw.pubkey, readTimeoutMs: 50 });
    stops.push(() => client.close());
    const forged = buildIotEvent(new IotKeyring(home, mallory), mallory, IOT_KIND_RETAINED, [['d', home.blind('dev:door')], ['dv', home.blind('dev:door')], ['h', home.homeTag]], {
      v: 1, type: 'retained', msgId: newIotMsgId(), ts: Date.now(), device: 'door', topics: { 'home/door/lock': { payload: 'UNLOCKED', ts: 1 } }, part: 0, parts: 1,
    });
    const reading = client.getRetained('door');
    await sleep(5);
    net.subscriptions.at(-1)!.handlers.onEvent(forged as unknown as Event, 'wss://fake');
    net.subscriptions.at(-1)!.handlers.onEose?.();
    expect(await reading).toBeUndefined();
  });
});

describe('閘道只處理寄給自己、這個家的指令', () => {
  it('別的家（#h 不同）、沒有 p＝閘道、標籤與內容不一致：一律不執行、不回 ack', async () => {
    const handled: IotCommandRequest[] = [];
    const { net, gateway } = setup(handled);
    await gateway.start();
    const keyring = new IotKeyring(home, member);
    const ts = Date.now();
    const body = { v: 1 as const, type: 'cmd' as const, msgId: newIotMsgId(), ts, topic: 'home/plug/set', payload: 'ON', enc: 'utf8' as const, qos: 1 as const };
    const exp = ['expiration', String(Math.floor(ts / 1000) + 30)];
    const t = ['t', home.blind('home/plug/set')];
    const before = net.published.filter((e) => e.kind === IOT_KIND_ACK).length;
    net.deliver(buildIotEvent(keyring, member, IOT_KIND_COMMAND, [['h', 'otherhome0000000000000'], t, ['p', gw.pubkey], exp], { ...body, msgId: newIotMsgId() }) as unknown as Event);
    net.deliver(buildIotEvent(keyring, member, IOT_KIND_COMMAND, [['h', home.homeTag], t, ['p', member.pubkey], exp], { ...body, msgId: newIotMsgId() }) as unknown as Event);
    net.deliver(buildIotEvent(keyring, member, IOT_KIND_COMMAND, [['h', home.homeTag], ['t', home.blind('home/other')], ['p', gw.pubkey], exp], { ...body, msgId: newIotMsgId() }) as unknown as Event);
    await sleep(30);
    expect(handled).toEqual([]);
    expect(net.published.filter((e) => e.kind === IOT_KIND_ACK).length).toBe(before);
    // 對照組：正確的那一顆會執行
    net.deliver(buildIotEvent(keyring, member, IOT_KIND_COMMAND, [['h', home.homeTag], t, ['p', gw.pubkey], exp], body) as unknown as Event);
    await sleep(30);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ topic: 'home/plug/set', payload: 'ON', from: member.pubkey, role: 'owner' });
  });

  it('沒有 expiration、或 expiration 超過 300 秒：拒收', async () => {
    const handled: IotCommandRequest[] = [];
    const { net, gateway, client } = setup(handled);
    await gateway.start();
    const r = await client.command('home/plug/set', 'ON', { ttlSec: 9999, timeoutMs: 200 }); // 會被夾到 300，所以成功
    expect(r.status).toBe('ok');
    const keyring = new IotKeyring(home, member);
    const ts = Date.now();
    const msgId = newIotMsgId();
    net.deliver(buildIotEvent(keyring, member, IOT_KIND_COMMAND, [['h', home.homeTag], ['t', home.blind('home/plug/set')], ['p', gw.pubkey]], {
      v: 1, type: 'cmd', msgId, ts, topic: 'home/plug/set', payload: 'NOEXP', enc: 'utf8', qos: 1,
    }) as unknown as Event);
    await sleep(30);
    const acks = net.published.filter((e) => e.kind === IOT_KIND_ACK).map((e) => new IotKeyring(home, member).open(e.content, e.pubkey));
    expect(acks.find((a) => a?.type === 'ack' && a.inReplyTo === msgId)).toMatchObject({ status: 'rejected', reason: 'expiration-required' });
    expect(handled.map((h) => h.payload)).toEqual(['ON']);
  });
});

describe('可尋址事件的 created_at 嚴格遞增（中繼不取代同一秒的事件）', () => {
  it('同一秒內連改兩次名單、心跳後立刻關閉：每顆都比前一顆新', async () => {
    const { net, gateway, client } = setup();
    await gateway.start();
    for (const role of ['viewer', 'operator'] as const) {
      expect((await client.updateAcl({ op: 'add', entry: { pubkey: mallory.pubkey, role } }, { timeoutMs: 200 })).status).toBe('ok');
    }
    await gateway.stop();
    const byD = new Map<string, number[]>();
    for (const e of net.published.filter((x) => x.kind >= 30000)) {
      const d = e.tags.find((t) => t[0] === 'd')![1]!;
      byD.set(d, [...(byD.get(d) ?? []), e.created_at]);
    }
    expect(byD.get(home.blind('sys:acl'))).toHaveLength(3);
    expect(byD.get(home.blind('gw'))).toHaveLength(2);
    for (const times of byD.values()) for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });
});

describe('客戶端的發布結果', () => {
  it('沒有任何中繼收下 → relay-rejected（附詞元分類）；QoS 0 只送一次', async () => {
    const net = new FakeTransport();
    net.accepted = [];
    const client = new IotClient({ pool: net, signer: member, home, gateway: gw.pubkey, budget: new RelayEventBudget() });
    stops.push(() => client.close());
    const r = await client.command('home/plug/set', 'ON', { qos: 0, timeoutMs: 50 });
    expect(r.status).toBe('relay-rejected');
    expect(r.attempts).toBe(1);
    expect(r.rejected?.[0]?.url).toBe('wss://fake');
  });

  it('QoS 1：每次重送都重新簽章、內容的 msgId 不變；超過 retries 就停', async () => {
    const net = new FakeTransport();
    const client = new IotClient({ pool: net, signer: member, home, gateway: gw.pubkey, budget: new RelayEventBudget() });
    stops.push(() => client.close());
    const r = await client.command('home/plug/set', 'ON', { timeoutMs: 20, retries: 2 });
    expect(r).toMatchObject({ status: 'timeout', attempts: 3 });
    const sent = net.published.filter((e) => e.kind === IOT_KIND_COMMAND);
    expect(new Set(sent.map((e) => e.id)).size).toBe(3);
    const ids = sent.map((e) => new IotKeyring(home, gw).open(e.content, e.pubkey)?.msgId);
    expect(new Set(ids)).toEqual(new Set([r.msgId]));
  });

  it('close() 會叫醒還在等 ack 的指令', async () => {
    const net = new FakeTransport();
    const client = new IotClient({ pool: net, signer: member, home, gateway: gw.pubkey, budget: new RelayEventBudget() });
    const pending = client.command('home/plug/set', 'ON', { timeoutMs: 60_000 });
    await sleep(20);
    client.close();
    expect((await pending).status).toBe('timeout');
  });
});
