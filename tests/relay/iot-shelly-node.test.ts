// C′ R5 Shelly 明文轉譯的兩個宿主（SDK ADR 0139）：`/iot/v1/shelly/<homeTag>/<blindId>?token=…`（Shelly 設不了標頭，權杖只能放 URL）。
// Node 版：真的 HTTP／WebSocket（Workers 版在 iot-shelly-worker.test.ts）。
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { deriveIotHome } from '../../src/iot/keys.js';
import { generateIotDeviceToken, hashIotDeviceToken } from '../../src/iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_QUERY } from '../../src/iot/kinds.js';
import { newIotMsgId, parseIotBody } from '../../src/iot/content.js';
import { openIotEnvelope, sealIotEnvelope, type IotDeviceEnvelope } from '../../src/iot/envelope.js';
import { parseIotUpMessage } from '../../src/iot/device-message.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';

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

describe('Node：Shelly 明文轉譯', () => {
  const handles: { close(): void }[] = [];
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.terminate();
    for (const h of handles.splice(0)) h.close();
  });
  const start = (over: Record<string, string | undefined> = {}) => opened(handles, startNodeRelay({ ...iotEnv(over), DB_PATH: ':memory:', PORT: '0' }));
  const connect = (url: string) =>
    new Promise<{ ws: WebSocket; messages: string[] }>((resolve, reject) => {
      const ws = new WebSocket(url);
      sockets.push(ws);
      const messages: string[] = [];
      ws.on('message', (d) => messages.push(d.toString()));
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('unexpected-response', (_q, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.on('error', reject);
    });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 60 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  it('沒開危險旗標 → 404；開了：指令 → Switch.Set → 回覆 → 手機收到 ack', async () => {
    const off = await start({ IOT_PLAINTEXT_DEVICES: undefined });
    await expect(connect(`ws://127.0.0.1:${off}${shellyPath()}`)).rejects.toMatchObject({ status: 404 });
    const p = await start();
    await expect(connect(`ws://127.0.0.1:${p}${shellyPath('cit1_nope')}`)).rejects.toMatchObject({ status: 401 });
    const shelly = await connect(`ws://127.0.0.1:${p}${shellyPath()}`);
    const ph = await connect(`ws://127.0.0.1:${p}/iot/v1/home/${home.homeTag}`);
    ph.ws.send(JSON.stringify(['REQ', 'a', { kinds: [IOT_KIND_ACK], '#h': [home.homeTag] }]));
    await until(() => ph.messages.some((m) => JSON.parse(m)[0] === 'EOSE'));
    ph.ws.send(JSON.stringify(['EVENT', devEvent('dev-cmd', 'OFF')]));
    await until(() => shelly.messages.length > 0);
    const rpc = JSON.parse(shelly.messages[0]!) as { id: number; method: string; params: unknown };
    expect(rpc).toMatchObject({ method: 'Switch.Set', params: { id: 0, on: false } });
    shelly.ws.send(JSON.stringify({ id: rpc.id, result: { was_on: true } }));
    const events = () => ph.messages.map((m) => JSON.parse(m) as unknown[]).filter((m) => m[0] === 'EVENT').map((m) => openBody(m[2] as NostrEvent));
    await until(() => events().some((b) => b.type === 'dev-ack'));
    expect(openUp(events().find((b) => b.type === 'dev-ack')!)).toMatchObject({ status: 'ok', topics: { 'home/plug': { payload: 'OFF' } } });
  });
});
