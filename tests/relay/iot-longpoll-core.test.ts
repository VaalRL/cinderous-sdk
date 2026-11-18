// C′ R4 長輪詢（SDK ADR 0138）：家庭核心 `IotRealtimeHome` 對長輪詢設備的處理——平台無關，Workers 與 Node 宿主共用。
// - 長輪詢的「連線」只在一輪 `/next` 掛著時存在；兩輪之間的短暫空檔（設備處理完回 ack、再發下一輪）不能被當成離線。
// - 空檔內來的指令短暫保留（≤ IOT_LONGPOLL_HOLD_SEC），下一輪一開始就交出去；設備沒有回來就丟掉、照舊回 offline。
import { describe, expect, it } from 'vitest';
import {
  deriveIotHome,
  generateIotDeviceToken,
  hashIotDeviceToken,
  IOT_KIND_ACK,
  IOT_KIND_COMMAND,
  IOT_KIND_QUERY,
  newIotMsgId,
  parseIotBody,
  parseIotDeviceFrame,
  sealIotEnvelope,
} from '../../src/iot/index.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { MessageStore } from '../../src/relay/message-store.js';
import { RelayCore, type Outbound } from '../../src/relay/relay-core.js';
import {
  IOT_LONGPOLL_HOLD_MAX,
  IOT_LONGPOLL_HOLD_SEC,
  iotLongPollWaitSec,
  IotRealtimeHome,
  type IotRealtimeHomeConfig,
  type IotRealtimeSockets,
} from '../../src/relay/iot-realtime.js';

const home = deriveIotHome('44'.repeat(32));
const gwSk = generateSecretKey();
const gwPk = getPublicKey(gwSk);
const operator = generateSecretKey();
const T0 = 1_760_000_000_000;
const lamp = home.blind('dev:lamp');
const keyLamp = home.deviceKey('lamp', 0);

function config(): IotRealtimeHomeConfig {
  return {
    homeTag: home.homeTag,
    homePub: home.homePub,
    gatewayPubkey: gwPk,
    acl: [{ pubkey: getPublicKey(operator), role: 'operator' }],
    devices: [{ id: 'lamp', blindId: lamp, epoch: 0, tokenHash: hashIotDeviceToken(generateIotDeviceToken()) }],
    // 心跳間隔設最短：長輪詢沒有心跳，不能因此被判成 stale
    heartbeatSec: 5,
  };
}

/** 假的長輪詢連線：`open` 時這台設備有一輪 `/next` 掛著；送出一個幀就結束這一輪（與兩個宿主相同） */
function setup() {
  let now = T0;
  const sent: string[] = [];
  let open = false;
  let rt!: IotRealtimeHome;
  const sockets: IotRealtimeSockets = {
    isConnected: () => open,
    lastHeartbeatMs: () => undefined,
    transportOf: () => (open ? 'longpoll' : undefined),
    send: (_b, text) => {
      if (!open) return false;
      sent.push(text);
      open = false; // 一輪只回一個幀
      return true;
    },
  };
  rt = new IotRealtimeHome(config(), gwSk, { sockets, now: () => now });
  const core: RelayCore = new RelayCore({
    now: () => Math.floor(now / 1000),
    store: new MessageStore(),
    intercept: (connId, event, authed): Outbound[] | undefined => {
      const r = rt.interceptPhoneEvent(connId, event, authed);
      return r ? [...r.outbound, ...r.publish.flatMap((e) => core.publishLocal(e))] : undefined;
    },
  });
  core.connect('op');
  core.handle('op', JSON.stringify(['REQ', 'a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }]));
  return {
    rt,
    core,
    sent,
    nowMs: () => now,
    advance: (ms: number) => void (now += ms),
    /** 設備發起新的一輪：先拿保留的幀；沒有才掛著等 */
    poll: (): string | undefined => {
      const held = rt.longPollStart(lamp);
      if (held === undefined) open = true;
      return held;
    },
    /** 這一輪逾時（204）或設備斷了 */
    pollEnds: () => {
      open = false;
      rt.longPollEnded(lamp);
    },
  };
}

function command(nowMs: number, type: 'dev-cmd' | 'dev-query' | 'dev-link' = 'dev-cmd'): NostrEvent {
  const env = sealIotEnvelope({ key: keyLamp, kid: 'lamp.0', dir: 'down', ctr: 1, ts: Math.floor(nowMs / 1000), plaintext: 'ON' });
  return finalizeEvent(
    {
      kind: type === 'dev-cmd' ? IOT_KIND_COMMAND : IOT_KIND_QUERY,
      created_at: Math.floor(nowMs / 1000),
      tags: [['h', home.homeTag], ['p', gwPk], ['dv', lamp]],
      content: encryptDM(JSON.stringify({ v: 1, ts: nowMs, msgId: newIotMsgId(), type, device: 'lamp', ...(type === 'dev-link' ? {} : { env }) }), operator, gwPk),
    },
    operator,
  );
}

const acksOf = (out: Outbound[]) =>
  out
    .filter((o) => o.to === 'op' && o.message[0] === 'EVENT')
    .map((o) => o.message[2] as NostrEvent)
    .map((e) => parseIotBody(JSON.parse(decryptDM(e.content, home.homeKey, e.pubkey))) as { status?: string; online?: boolean; transport?: string });

describe('長輪詢：掛著的一輪（SDK ADR 0138）', () => {
  it('有一輪掛著 → 指令直接交給它；沒有心跳也不算 stale', () => {
    const { core, sent, poll, nowMs } = setup();
    expect(poll()).toBeUndefined();
    const out = core.handle('op', JSON.stringify(['EVENT', command(nowMs())]));
    expect(acksOf(out)).toEqual([]); // 沒有 offline／stale
    expect(sent.map((f) => parseIotDeviceFrame(f, 'relay')?.t)).toEqual(['cmd']);
  });

  it('dev-link：掛著＝online，回報 transport: longpoll', () => {
    const { core, poll, nowMs } = setup();
    poll();
    const [ack] = acksOf(core.handle('op', JSON.stringify(['EVENT', command(nowMs(), 'dev-link')])));
    expect(ack).toMatchObject({ status: 'ok', online: true, transport: 'longpoll' });
  });
});

describe('長輪詢：兩輪之間的空檔', () => {
  it('空檔內的指令先保留，下一輪一開始就交出去（不回 offline）', () => {
    const { core, sent, poll, pollEnds, advance, nowMs } = setup();
    poll();
    pollEnds();
    advance(1_000);
    const out = core.handle('op', JSON.stringify(['EVENT', command(nowMs())]));
    expect(acksOf(out)).toEqual([]);
    expect(sent).toEqual([]);
    const held = poll();
    expect(parseIotDeviceFrame(held!, 'relay')?.t).toBe('cmd');
    // 交出去之後這一輪就結束了：下一輪沒有東西
    expect(poll()).toBeUndefined();
  });

  it(`設備超過 ${IOT_LONGPOLL_HOLD_SEC} 秒沒回來 → 保留的丟掉；新指令照舊回 offline（不排隊，§9.4）`, () => {
    const { core, poll, pollEnds, advance, nowMs } = setup();
    poll();
    pollEnds();
    core.handle('op', JSON.stringify(['EVENT', command(nowMs())]));
    advance((IOT_LONGPOLL_HOLD_SEC + 1) * 1000);
    expect(poll()).toBeUndefined(); // 過期的不交
    // 這一輪又斷了，而且很久之後才來指令
    const { core: c2, poll: p2, pollEnds: e2, advance: a2, nowMs: n2 } = setup();
    p2();
    e2();
    a2((IOT_LONGPOLL_HOLD_SEC + 1) * 1000);
    const [ack] = acksOf(c2.handle('op', JSON.stringify(['EVENT', command(n2())])));
    expect(ack).toMatchObject({ status: 'offline' });
  });

  it(`每台最多保留 ${IOT_LONGPOLL_HOLD_MAX} 則；再多回 offline`, () => {
    const { core, poll, pollEnds, nowMs } = setup();
    poll();
    pollEnds();
    const statuses: (string | undefined)[] = [];
    for (let i = 0; i <= IOT_LONGPOLL_HOLD_MAX; i++) statuses.push(acksOf(core.handle('op', JSON.stringify(['EVENT', command(nowMs())])))[0]?.status);
    expect(statuses.slice(0, IOT_LONGPOLL_HOLD_MAX)).toEqual(Array(IOT_LONGPOLL_HOLD_MAX).fill(undefined));
    expect(statuses[IOT_LONGPOLL_HOLD_MAX]).toBe('offline');
  });

  it('從來沒有輪詢過的設備不算在空檔裡 → offline', () => {
    const { core, nowMs } = setup();
    const [ack] = acksOf(core.handle('op', JSON.stringify(['EVENT', command(nowMs())])));
    expect(ack).toMatchObject({ status: 'offline' });
  });
});

describe('等待秒數', () => {
  it('夾在 10–50，預設 45（ADR 0049 §9.3）', () => {
    expect(iotLongPollWaitSec(null)).toBe(45);
    expect(iotLongPollWaitSec('abc')).toBe(45);
    expect(iotLongPollWaitSec('3')).toBe(10);
    expect(iotLongPollWaitSec('120')).toBe(50);
    expect(iotLongPollWaitSec('20')).toBe(20);
  });
});
