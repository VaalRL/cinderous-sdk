// C′ R5 Shelly 明文轉譯的兩個宿主（SDK ADR 0139）：`/iot/v1/shelly/<homeTag>/<blindId>?token=…`（Shelly 設不了標頭，權杖只能放 URL）。
// Workers 版：以假的 DurableObjectState 跑真的程式路徑（Node 版在 iot-shelly-node.test.ts）。
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeState, FakeWs, installWorkerFakes } from './iot-worker-fakes.js';
import { deriveIotHome } from '../../src/iot/keys.js';
import { generateIotDeviceToken, hashIotDeviceToken } from '../../src/iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_QUERY, IOT_KIND_STATE } from '../../src/iot/kinds.js';
import { newIotMsgId, parseIotBody } from '../../src/iot/content.js';
import { openIotEnvelope, sealIotEnvelope, type IotDeviceEnvelope } from '../../src/iot/envelope.js';
import { parseIotUpMessage } from '../../src/iot/device-message.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import worker, { IotHomeRoom, type Env } from '../../src/relay/worker.js';

beforeAll(installWorkerFakes);

const home = deriveIotHome('88'.repeat(32));
const gwSk = generateSecretKey();
const operator = generateSecretKey();
const plugToken = generateIotDeviceToken();
const lampToken = generateIotDeviceToken();
const plugBlind = home.blind('dev:plug');
const lampBlind = home.blind('dev:lamp');
const plugKey = home.deviceKey('plug', 0);

function iotEnv(over: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    IOT_REALTIME: JSON.stringify({
      homes: [
        {
          homeTag: home.homeTag,
          homePub: home.homePub,
          gatewayPubkey: getPublicKey(gwSk),
          acl: [{ pubkey: getPublicKey(operator), role: 'operator' }],
          devices: [
            { id: 'plug', blindId: plugBlind, epoch: 0, tokenHash: hashIotDeviceToken(plugToken), transport: 'shelly', shelly: { switches: [{ id: 0, topic: 'home/plug' }] } },
            { id: 'lamp', blindId: lampBlind, epoch: 0, tokenHash: hashIotDeviceToken(lampToken) },
          ],
        },
      ],
    }),
    IOT_GATEWAY_KEYS: JSON.stringify({ [home.homeTag]: bytesToHex(gwSk) }),
    IOT_PLAINTEXT_DEVICES: '1',
    ALLOWED_PUBKEYS: getPublicKey(operator),
    IOT_PLAINTEXT_DEVICE_KEYS: JSON.stringify({ [`${home.homeTag}/plug`]: bytesToHex(plugKey) }),
    ...over,
  };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function devEvent(type: 'dev-cmd' | 'dev-link', payload = 'ON'): NostrEvent {
  const now = Date.now();
  const body = { type: 'cmd', msgId: newIotMsgId(), topic: 'home/plug', payload, enc: 'utf8', exp: Math.floor(now / 1000) + 15 };
  const env = sealIotEnvelope({ key: plugKey, kid: 'plug.0', dir: 'down', ctr: 1, ts: Math.floor(now / 1000), plaintext: JSON.stringify(body) });
  return finalizeEvent(
    {
      kind: type === 'dev-cmd' ? IOT_KIND_COMMAND : IOT_KIND_QUERY,
      created_at: Math.floor(now / 1000),
      tags: [['h', home.homeTag], ['p', getPublicKey(gwSk)], ['dv', plugBlind]],
      content: encryptDM(JSON.stringify({ v: 1, type, msgId: newIotMsgId(), ts: now, device: 'plug', ...(type === 'dev-cmd' ? { env } : {}) }), operator, getPublicKey(gwSk)),
    },
    operator,
  );
}

type Body = { type: string; status?: string; transport?: string; online?: boolean; env?: IotDeviceEnvelope };
const openBody = (e: NostrEvent) => parseIotBody(JSON.parse(decryptDM(e.content, home.homeKey, e.pubkey))) as Body;
const openUp = (b: Body) => parseIotUpMessage(openIotEnvelope(b.env!, plugKey));
const shellyPath = (token = plugToken, blind = plugBlind) => `/iot/v1/shelly/${home.homeTag}/${blind}?token=${token}`;

describe('Workers：Shelly 明文轉譯', () => {
  function setup(over: Record<string, string | undefined> = {}) {
    const state = new FakeState();
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          await state.ready;
          return state.room!.fetch(req);
        },
      }),
    };
    const env = { ...iotEnv(over), IOT_HOME: ns } as unknown as Env;
    state.room = new IotHomeRoom(state as unknown as DurableObjectState, env);
    return { state, env, room: () => state.room! };
  }
  const upgrade = (path: string) => new Request(`https://relay.example${path}`, { headers: { Upgrade: 'websocket' } });

  async function phone(room: IotHomeRoom, state: FakeState): Promise<FakeWs> {
    const before = state.sockets.length;
    await room.fetch(upgrade(`/iot/v1/home/${home.homeTag}`));
    const ws = state.sockets[before]!;
    room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(['REQ', 'a', { kinds: [IOT_KIND_ACK, IOT_KIND_STATE], '#h': [home.homeTag] }]));
    ws.drain();
    return ws;
  }
  const bodies = (ws: FakeWs) =>
    ws
      .drain()
      .map((m) => JSON.parse(m) as unknown[])
      .filter((m) => m[0] === 'EVENT')
      .map((m) => openBody(m[2] as NostrEvent));

  it('權杖放 URL：錯 → 401；不是 Shelly 的設備 → 404；沒開危險旗標的站 → 404 iot-disabled；都沒有碰 DO', async () => {
    const { env } = setup();
    expect((await worker.fetch(upgrade(shellyPath('cit1_nope')), env)).status).toBe(401);
    expect((await worker.fetch(upgrade(shellyPath(lampToken, lampBlind)), env)).status).toBe(404);
    const off = setup({ IOT_PLAINTEXT_DEVICES: undefined });
    const r = await worker.fetch(upgrade(shellyPath()), off.env);
    expect(r.status).toBe(404);
    expect(JSON.parse(await r.text()).error).toMatch(/^blocked: iot-disabled:/);
  });

  it('手機指令 → Shelly 收到 Switch.Set；RPC 回覆 → 手機收到 25171，up 信封以這台的 deviceKey 解得開；NotifyStatus → 25172', async () => {
    const { state, env, room } = setup();
    const res = await worker.fetch(upgrade(shellyPath()), env);
    expect(res.status).toBe(101);
    const shelly = state.sockets.find((w) => w.tags.includes(`dev:${plugBlind}`))!;
    const ph = await phone(room(), state);
    room().webSocketMessage(ph as unknown as WebSocket, JSON.stringify(['EVENT', devEvent('dev-link')]));
    expect(bodies(ph)).toEqual([expect.objectContaining({ status: 'ok', online: true, transport: 'shelly' })]);
    room().webSocketMessage(ph as unknown as WebSocket, JSON.stringify(['EVENT', devEvent('dev-cmd')]));
    expect(bodies(ph)).toEqual([]);
    const rpc = JSON.parse(shelly.drain()[0]!) as { id: number; method: string; params: unknown };
    expect(rpc).toMatchObject({ method: 'Switch.Set', params: { id: 0, on: true } });
    room().webSocketMessage(shelly as unknown as WebSocket, JSON.stringify({ id: rpc.id, src: 'shelly', result: { was_on: false } }));
    const [ack] = bodies(ph);
    expect(ack?.type).toBe('dev-ack');
    expect(openUp(ack!)).toMatchObject({ type: 'ack', status: 'ok', topics: { 'home/plug': { payload: 'ON' } } });
    room().webSocketMessage(shelly as unknown as WebSocket, JSON.stringify({ method: 'NotifyStatus', params: { 'switch:0': { output: false } } }));
    const [st] = bodies(ph);
    expect(st?.type).toBe('dev-state');
    expect(openUp(st!)).toMatchObject({ type: 'state', topics: { 'home/plug': { payload: 'OFF' } } });
  });
});
