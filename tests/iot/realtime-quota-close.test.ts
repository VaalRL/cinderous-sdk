// C′ 的額度用完（ADR 0049 §10.2；SDK ADR 0122）：relay 以 4429 `iot-quota:<重置 unix 秒>` 關掉手機的連線，不是回 ack。
// 連線池原本把 4429 當一般斷線：手機的指令回 `relay-rejected`（或空的拒收清單），連線池每分鐘重連一次、每次都再被拒。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../../src/identity.js';
import { deriveIotHome, generateIotHomeSecret, IotClient } from '../../src/iot/index.js';
import { classifyRelayClose, IOT_QUOTA_CLOSE_CODE } from '../../src/protocol/relay-reject.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { RelayEventBudget, rateLimitBackoffMs } from '../../src/relay-budget.js';
import { RelayPool, type RelayRejection } from '../../src/relay-pool.js';
import { SocketFactory } from '../fake-socket.js';

const R = 'wss://relay.example/iot/v1/home/h';
const HOUR = 3_600_000;
const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('classifyRelayClose：4429＝這個家今天的額度用完', () => {
  it('分類成 unavailable（稍後可重試、換座有用），詞元 iot-quota，帶重置時間', () => {
    expect(IOT_QUOTA_CLOSE_CODE).toBe(4429);
    expect(classifyRelayClose(4429, 'iot-quota:1767225600')).toMatchObject({ kind: 'unavailable', code: 4429, token: 'iot-quota', reset: 1767225600, retryable: true, tryOtherRelays: true });
    expect(classifyRelayClose(4429)).toMatchObject({ kind: 'unavailable', token: 'iot-quota' });
    expect(classifyRelayClose(4429).reset).toBeUndefined();
    // 別的關閉碼不帶詞元
    expect(classifyRelayClose(1013, 'over quota').token).toBeUndefined();
  });
});

describe('🔴 RelayPool：relay 以 4429 關閉', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let rejections: [string, RelayRejection][];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // 1013 的等待時間有抖動（SDK ADR 0130）；這裡驗的是精確時間
    factory = new SocketFactory();
    rejections = [];
    pool = new RelayPool({
      urls: [R],
      createSocket: factory.create,
      reconnectDelaysMs: [100, 200, 60_000],
      publishTimeoutMs: 1000,
      onRelayReject: (url, rejection) => rejections.push([url, rejection]),
    });
    pool.connect();
    factory.latest(R).open();
  });

  afterEach(() => {
    pool.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('回報詞元；整座標到重置時間（加最多 60 秒抖動），重連也等到那時——不是每分鐘撞一次', () => {
    const reset = nowSec() + 3 * 3600;
    factory.latest(R).serverClose(4429, `iot-quota:${reset}`);
    expect(rejections).toContainEqual([R, expect.objectContaining({ source: 'close', code: 4429, kind: 'unavailable', token: 'iot-quota', reason: `iot-quota:${reset}` })]);
    const [mark] = pool.relayHealth().get(R)!.marks;
    expect(mark).toMatchObject({ scope: '*', kind: 'unavailable', reason: `iot-quota:${reset}` });
    expect(mark!.until).toBeGreaterThanOrEqual(reset * 1000);
    expect(mark!.until).toBeLessThanOrEqual(reset * 1000 + 60_000);
    vi.advanceTimersByTime(mark!.until - Date.now() - 1);
    expect(factory.forUrl(R)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.forUrl(R)).toHaveLength(2);
  });

  it('重置時間離譜（超過一天後）最多等一天；沒帶重置時間＝照 1013 的 5 分鐘', () => {
    factory.latest(R).serverClose(4429, `iot-quota:${nowSec() + 30 * 86_400}`);
    expect(pool.relayHealth().get(R)!.marks[0]!.until - Date.now()).toBeLessThanOrEqual(24 * HOUR + 60_000);
    pool.reconnectNow(R);
    factory.latest(R).open();
    factory.latest(R).serverClose(4429, '');
    expect(pool.relayHealth().get(R)!.marks[0]!.until - Date.now()).toBe(5 * 60_000);
  });

  it('等 OK 的發布以 unavailable／iot-quota 結案，原因帶重置時間；不讓同一身分的事件預算退避', async () => {
    const reset = nowSec() + 3600;
    const event = Identity.generate().sign({ kind: 25170, created_at: nowSec(), tags: [], content: 'x' });
    const pending = pool.publish(event);
    factory.latest(R).serverClose(4429, `iot-quota:${reset}`);
    const result = await pending;
    expect(result.rejected).toEqual([expect.objectContaining({ url: R, kind: 'unavailable', token: 'iot-quota' })]);
    expect(result.rejected[0]!.reason).toContain(`iot-quota:${reset}`);
    expect(rateLimitBackoffMs(result)).toBeUndefined();
  });
});

describe('🔴 IotClient：C′ 連線被 4429 關掉時回 quota', () => {
  const home = deriveIotHome(generateIotHomeSecret());
  const gateway = getPublicKey(generateSecretKey());
  let factory: SocketFactory;
  let pool: RelayPool;
  let client: IotClient;

  beforeEach(() => {
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [R], createSocket: factory.create, reconnectDelaysMs: [HOUR], publishTimeoutMs: 1000 });
    pool.connect();
    factory.latest(R).open();
    client = new IotClient({ pool, signer: Identity.generate(), home, gateway, budget: new RelayEventBudget({ perMinute: 6000 }), readTimeoutMs: 50, realtime: { devices: { lamp: {} } } });
  });

  afterEach(() => {
    client.close();
    pool.close();
  });

  it('指令送出後連線被 4429 關掉：quota，附重置時間，不重送', async () => {
    const reset = nowSec() + 3600;
    const pending = client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', retries: 3, ackTimeoutMs: 30 });
    await vi.waitFor(() => expect(factory.latest(R).sentOfType('EVENT')).toHaveLength(1));
    factory.latest(R).serverClose(4429, `iot-quota:${reset}`);
    expect(await pending).toMatchObject({ status: 'quota', reset, attempts: 1 });
  });

  it('已經被 4429 關掉之後才下的指令：馬上回 quota，什麼都不送', async () => {
    const reset = nowSec() + 3600;
    factory.latest(R).serverClose(4429, `iot-quota:${reset}`);
    const started = Date.now();
    expect(await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', retries: 3, ackTimeoutMs: 200 })).toMatchObject({ status: 'quota', reset, attempts: 0 });
    expect(Date.now() - started).toBeLessThan(150);
    expect(factory.forUrl(R)).toHaveLength(1);
  });

  it('deviceLink 也回 quota', async () => {
    factory.latest(R).serverClose(4429, `iot-quota:${nowSec() + 3600}`);
    expect(await client.deviceLink('lamp', { timeoutMs: 100 })).toMatchObject({ status: 'quota' });
  });
});
