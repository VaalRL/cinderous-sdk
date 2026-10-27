// IotClient 登記推播 × IotGateway 送出（SDK ADR 0049 §11.1）：`$sys/push` 加密登記、依訂閱設備過濾、角色與上限、
// 撤銷成員一併清掉端點、空的喚醒（UnifiedPush 本文空、推播閘道只有封包／時間戳／簽章／ref）。
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  deriveIotHome,
  generateIotHomeSecret,
  IOT_KIND_COMMAND,
  IOT_KIND_STATE,
  IotClient,
  IotGateway,
  IotKeyring,
  IotPushRegistry,
  iotPushEndpointId,
  iotPushRegId,
  iotPushSign,
  iotPushWakeMessage,
  memoryIotPushStore,
  sealIotPushToken,
  type IotPushEndpoint,
  type IotPushSendResult,
} from '../../src/iot/index.js';
import { buildIotPushRequest } from '../../src/iot/push.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { FakeTransport } from '../fake-transport.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = deriveIotHome(generateIotHomeSecret());
const gw = Identity.generate();
const owner = Identity.generate();
const viewer = Identity.generate();
const outsider = Identity.generate();
const UP: IotPushEndpoint = { type: 'unifiedpush', url: 'https://ntfy.example/up-secret-topic' };

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

function setup(opts: { push?: boolean; maxEndpoints?: number; results?: IotPushSendResult[] } = {}) {
  const net = new FakeTransport();
  net.relay = true;
  const store = memoryIotPushStore();
  const sent: { endpoint: IotPushEndpoint; ts: number; ref?: string }[] = [];
  const results = [...(opts.results ?? [])];
  const gateway = new IotGateway({
    pool: net,
    signer: gw,
    home,
    acl: [
      { pubkey: owner.pubkey, role: 'owner' },
      { pubkey: viewer.pubkey, role: 'viewer', devices: ['cam'] },
    ],
    handler: { command: () => ({ status: 'ok' }) },
    budget: new RelayEventBudget({ perMinute: 6000 }),
    retainedDebounceMs: 10,
    ...(opts.push === false
      ? {}
      : {
          push: {
            store,
            random: () => 0, // 抖動 0：立刻送，測試不必等
            ...(opts.maxEndpoints !== undefined ? { limits: { maxEndpoints: opts.maxEndpoints } } : {}),
            send: async (endpoint, wake) => {
              sent.push({ endpoint, ts: wake.ts, ...(wake.ref !== undefined ? { ref: wake.ref } : {}) });
              return results.shift() ?? { status: 'ok' };
            },
          },
        }),
  });
  const client = (who: Identity) => {
    const c = new IotClient({ pool: net, signer: who, home, gateway: gw.pubkey, budget: new RelayEventBudget({ perMinute: 6000 }), readTimeoutMs: 50 });
    stops.push(() => c.close());
    return c;
  };
  stops.push(() => gateway.stop({ announceOffline: false }));
  return { net, gateway, client, store, sent };
}

describe('$sys/push 登記', () => {
  it('成員登記 UnifiedPush 端點；訂閱的設備有變化就喚醒（帶 25172 的事件 id），重複同一個值不喚醒', async () => {
    const { gateway, client, sent, store } = setup();
    await gateway.start();
    const r = await client(owner).registerPush(UP, [{ device: 'door', mode: 'instant' }]);
    expect(r).toMatchObject({ status: 'ok', endpointId: iotPushEndpointId(UP) });
    expect(store.current()).toHaveLength(1);
    expect(store.current()![0]).toMatchObject({ owner: owner.pubkey, endpoint: UP, subscriptions: [{ dv: home.blind('dev:door'), mode: 'instant' }] });

    await gateway.reportState({ topic: 'home/door/contact', payload: 'open', device: 'door' });
    await sleep(20);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.endpoint).toEqual(UP);
    expect(sent[0]!.ref).toMatch(/^[0-9a-f]{64}$/);
    await gateway.reportState({ topic: 'home/door/contact', payload: 'open', device: 'door' }); // 沒變
    await gateway.reportState({ topic: 'home/plug/power', payload: 'ON', device: 'plug' }); // 沒訂閱
    await sleep(20);
    expect(sent).toHaveLength(1);
  });

  it('端點另外加密給閘道：持有家庭秘密的其他成員解開指令也看不到網址', async () => {
    const { net, gateway, client } = setup();
    await gateway.start();
    await client(owner).registerPush(UP, [{ device: 'door' }]);
    const cmd = net.published.find((e) => e.kind === IOT_KIND_COMMAND)!;
    const body = new IotKeyring(home, viewer).open(cmd.content, cmd.pubkey);
    expect(body?.type).toBe('cmd');
    expect(JSON.stringify(body)).not.toContain('ntfy.example');
    expect(JSON.stringify(body)).not.toContain('up-secret-topic');
  });

  it('viewer 也能登記；額度預警只有 owner 能訂閱，也只喚醒 owner', async () => {
    const { gateway, client, sent } = setup();
    await gateway.start();
    const viewerUp: IotPushEndpoint = { type: 'unifiedpush', url: 'https://ntfy.example/viewer' };
    expect((await client(viewer).registerPush(viewerUp, [{ device: 'door' }])).status).toBe('ok'); // 細分只限制查詢與操作
    expect(await client(viewer).registerPush(viewerUp, [{ special: 'quota' }])).toMatchObject({ status: 'rejected', reason: 'owner-only' });
    expect((await client(owner).registerPush(UP, [{ special: 'quota' }])).status).toBe('ok');
    gateway.notifyPushSpecial('quota');
    await sleep(20);
    expect(sent.map((s) => s.endpoint)).toEqual([UP]);
  });

  it('名單外的人登記不了', async () => {
    const { gateway, client } = setup();
    await gateway.start();
    expect(await client(outsider).registerPush(UP, [{ device: 'door' }])).toMatchObject({ status: 'not-allowed' });
  });

  it('每家端點上限（可設定）', async () => {
    const { gateway, client } = setup({ maxEndpoints: 1 });
    await gateway.start();
    expect((await client(owner).registerPush(UP, [{ device: 'door' }])).status).toBe('ok');
    expect((await client(owner).updatePush(UP, [{ device: 'door' }, { device: 'plug' }])).status).toBe('ok'); // 更新不算新的
    expect(await client(owner).registerPush({ type: 'unifiedpush', url: 'https://ntfy.example/2' }, [{ device: 'door' }])).toMatchObject({ status: 'rejected', reason: 'push-limit' });
  });

  it('撤銷：本人可以；別人的不行；owner 可以撤銷任何人的', async () => {
    const { gateway, client, store } = setup();
    await gateway.start();
    const viewerUp: IotPushEndpoint = { type: 'unifiedpush', url: 'https://ntfy.example/viewer' };
    await client(viewer).registerPush(viewerUp, [{ device: 'door' }]);
    await client(owner).registerPush(UP, [{ device: 'door' }]);
    expect(await client(viewer).revokePush(UP)).toMatchObject({ status: 'rejected', reason: 'not-yours' });
    expect(await client(viewer).registerPush(UP, [{ device: 'cam' }])).toMatchObject({ status: 'rejected', reason: 'not-yours' });
    expect((await client(owner).revokePush(iotPushEndpointId(viewerUp))).status).toBe('ok');
    expect((await client(owner).revokePush(UP)).status).toBe('ok');
    expect(store.current()).toEqual([]);
  });

  it('owner 撤銷成員：一併清掉該成員的端點，之後不再喚醒', async () => {
    const { gateway, client, sent, store } = setup();
    await gateway.start();
    await client(viewer).registerPush({ type: 'unifiedpush', url: 'https://ntfy.example/viewer' }, [{ device: 'door', mode: 'instant' }]);
    expect(store.current()).toHaveLength(1);
    expect((await client(owner).updateAcl({ op: 'remove', pubkey: viewer.pubkey })).status).toBe('ok');
    expect(store.current()).toEqual([]);
    await gateway.reportState({ topic: 'home/door/contact', payload: 'open', device: 'door' });
    await sleep(20);
    expect(sent).toEqual([]);
  });

  it('沒開推播：$sys/push 回 rejected（push-disabled）', async () => {
    const { gateway, client } = setup({ push: false });
    await gateway.start();
    expect(await client(owner).registerPush(UP, [{ device: 'door' }])).toMatchObject({ status: 'rejected', reason: 'push-disabled' });
  });

  it('對方回 gone：端點從清單刪掉', async () => {
    const { gateway, client, store, sent } = setup({ results: [{ status: 'gone' }] });
    await gateway.start();
    await client(owner).registerPush(UP, [{ device: 'door', mode: 'instant' }]);
    await gateway.reportState({ topic: 'home/door/contact', payload: 'open', device: 'door' });
    await sleep(30);
    expect(sent).toHaveLength(1);
    expect(store.current()).toEqual([]);
  });

  it('存檔：重開後讀回登記照樣送', async () => {
    const first = setup();
    await first.gateway.start();
    await first.client(owner).registerPush(UP, [{ device: 'door', mode: 'instant' }]);
    await first.gateway.stop({ announceOffline: false });
    const sent: IotPushEndpoint[] = [];
    const gateway = new IotGateway({
      pool: new FakeTransport(),
      signer: gw,
      home,
      acl: [{ pubkey: owner.pubkey, role: 'owner' }],
      handler: { command: () => ({ status: 'ok' }) },
      budget: new RelayEventBudget({ perMinute: 6000 }),
      push: { store: first.store, random: () => 0, send: async (ep) => (sent.push(ep), { status: 'ok' }) },
    });
    stops.push(() => gateway.stop({ announceOffline: false }));
    await gateway.start();
    expect(gateway.pushRegistrations()).toHaveLength(1);
    gateway.setDeviceOnline('door', false);
    await sleep(20);
    expect(sent).toEqual([UP]);
  });
});

describe('推播閘道端點：空的喚醒、簽章、時間戳遞增', () => {
  it('送給推播閘道的本文只有封包、時間戳、簽章、ref；同一端點的時間戳嚴格遞增', async () => {
    const pushKey = Identity.generate();
    const { sealed, key } = sealIotPushToken(pushKey.pubkey, { platform: 'ios', token: 'fcm_token-0123456789abcdefghij' });
    const endpoint: IotPushEndpoint = { type: 'gateway', url: 'https://push.example', sealed, key };
    const { gateway, client, sent } = setup();
    await gateway.start();
    expect((await client(owner).registerPush(endpoint, [{ device: 'door', mode: 'instant' }])).status).toBe('ok');
    await gateway.reportState({ topic: 'home/door/contact', payload: 'open', device: 'door' });
    await sleep(30);
    await gateway.reportState({ topic: 'home/door/contact', payload: 'closed', device: 'door' });
    await sleep(30);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.ts).toBeGreaterThan(sent[0]!.ts);
    for (const s of sent) {
      const req = buildIotPushRequest(s.endpoint, { ts: s.ts, ...(s.ref ? { ref: s.ref } : {}) });
      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['ref', 'sealed', 'sig', 'ts', 'v']);
      expect(body.sig).toBe(iotPushSign(key, iotPushWakeMessage(iotPushRegId(sealed), s.ts, s.ref)));
      expect(req.body).not.toContain('door');
    }
  });

  it('25172 的事件 id 就是 ref（給 iOS NSE 回中繼取）', async () => {
    const { net, gateway, client, sent } = setup();
    await gateway.start();
    await client(owner).registerPush(UP, [{ device: 'door', mode: 'instant' }]);
    await gateway.reportState({ topic: 'home/door/contact', payload: 'open', device: 'door' });
    await sleep(20);
    const state = net.published.filter((e) => e.kind === IOT_KIND_STATE).at(-1)!;
    expect(sent[0]!.ref).toBe(state.id);
  });
});

describe('IotPushRegistry（TTL、角色過濾）', () => {
  const endpoint = UP;
  const dv = home.blind('dev:door');

  it('預設 TTL 30 天；過期的不送、prune 會清掉', () => {
    const registry = new IotPushRegistry();
    const r = registry.register({ owner: owner.pubkey, endpoint, subscriptions: [{ dv, mode: 'standard' }], isOwner: true }, 1_000);
    expect(r).toMatchObject({ ok: true, created: true });
    expect(registry.get(iotPushEndpointId(endpoint))!.expiresAt).toBe(1_000 + 30 * 86_400);
    expect(registry.targets({ dv }, 1_000 + 30 * 86_400, () => true)).toEqual([]);
    expect(registry.prune(1_000 + 30 * 86_400)).toEqual([iotPushEndpointId(endpoint)]);
  });

  it('TTL 可以更短（至少 1 小時），不能超過上限', () => {
    const registry = new IotPushRegistry({ limits: { registrationTtlSec: 7 * 86_400 } });
    registry.register({ owner: owner.pubkey, endpoint, subscriptions: [{ dv, mode: 'standard' }], ttlSec: 60, isOwner: true }, 0);
    expect(registry.get(iotPushEndpointId(endpoint))!.expiresAt).toBe(3_600);
    registry.register({ owner: owner.pubkey, endpoint, subscriptions: [{ dv, mode: 'standard' }], ttlSec: 99 * 86_400, isOwner: true }, 0);
    expect(registry.get(iotPushEndpointId(endpoint))!.expiresAt).toBe(7 * 86_400);
  });

  it('同一個端點有多個符合的訂閱：取即時；allowed 擋掉的不送', () => {
    const registry = new IotPushRegistry();
    registry.register({ owner: owner.pubkey, endpoint, subscriptions: [{ dv, mode: 'standard' }, { special: 'quota', mode: 'instant' }], isOwner: true }, 0);
    expect(registry.targets({ special: 'quota' }, 1, () => true)).toEqual([{ id: iotPushEndpointId(endpoint), mode: 'instant' }]);
    expect(registry.targets({ special: 'quota' }, 1, (_o, special) => !special)).toEqual([]);
  });
});
