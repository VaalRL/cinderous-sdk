// 設備端參考實作（examples/iot-device/push-sender.mjs，MIT-0）與 SDK 相容：喚醒請求逐位元組相同、README 的測試向量正確、
// 真的對 SDK 的參考推播閘道送一次（FCM 以 fetch mock）；合併＋抖動與 SDK 的排程器同一套規則。
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { Identity } from '../../src/identity.js';
import { buildIotPushRequest, iotPushRegId, iotPushSign, iotPushWakeMessage, sealIotPushToken, type IotPushEndpoint } from '../../src/iot/push.js';
import { createPushGatewayFromEnv, memoryPushGatewayStore } from '../../src/iot/push-gateway/index.js';

interface DeviceModule {
  regIdOf(sealed: string): string;
  wakeMessage(regId: string, ts: number, ref?: string): string;
  sign(keyHex: string, message: string): string;
  buildRequest(endpoint: IotPushEndpoint, ts: number, ref?: string): { url: string; method: string; headers: Record<string, string>; body: string };
  createPushSender(opts: Record<string, unknown>): { notifyDevice(dv: string, ref?: string): void; pending(id: string): { at: number } | undefined; stop(): void };
}

const examplePath = fileURLToPath(new URL('../../examples/iot-device/push-sender.mjs', import.meta.url));
const device = (await import(examplePath)) as DeviceModule;
const readme = readFileSync(fileURLToPath(new URL('../../examples/iot-device/README.md', import.meta.url)), 'utf8');

describe('與 SDK 逐位元組相同', () => {
  it('README 的測試向量', () => {
    const sealed = `cp1.${'1'.repeat(64)}.QUJD`;
    const key = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const ts = 1_759_500_000_000;
    const regId = device.regIdOf(sealed);
    expect(regId).toBe(iotPushRegId(sealed));
    expect(readme).toContain(`regId            = ${regId}`);
    const noRef = device.sign(key, device.wakeMessage(regId, ts));
    const withRef = device.sign(key, device.wakeMessage(regId, ts, 'e'.repeat(64)));
    expect(noRef).toBe(iotPushSign(key, iotPushWakeMessage(regId, ts)));
    expect(withRef).toBe(iotPushSign(key, iotPushWakeMessage(regId, ts, 'e'.repeat(64))));
    expect(readme).toContain(noRef);
    expect(readme).toContain(withRef);
  });

  it('UnifiedPush 與推播閘道的請求與 buildIotPushRequest 相同', () => {
    const push = Identity.generate();
    const { sealed, key } = sealIotPushToken(push.pubkey, { platform: 'android', token: 'fcm_token-0123456789abcdefghij' });
    const gw: IotPushEndpoint = { type: 'gateway', url: 'https://push.example/', sealed, key };
    const up: IotPushEndpoint = { type: 'unifiedpush', url: 'https://ntfy.example/x' };
    for (const [ep, ref] of [[gw, undefined], [gw, 'a'.repeat(64)], [up, 'a'.repeat(64)]] as const) {
      expect(device.buildRequest(ep, 123, ref)).toEqual(buildIotPushRequest(ep, { ts: 123, ...(ref ? { ref } : {}) }));
    }
  });

  it('授權標頭：每個檔案都是 MIT-0', () => {
    expect(readFileSync(examplePath, 'utf8').startsWith('// SPDX-License-Identifier: MIT-0')).toBe(true);
    expect(readme.startsWith('<!-- SPDX-License-Identifier: MIT-0 -->')).toBe(true);
  });
});

describe('對 SDK 的參考推播閘道真的送', () => {
  it('設備狀態變化 → 推播閘道驗簽通過 → FCM（mock）收到空的資料訊息；重複事件在標準模式合併', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const pushKey = Identity.generate();
    const fcm: string[] = [];
    const google = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2')) return Response.json({ access_token: 'ya29.t', expires_in: 3600 });
      fcm.push(String(init?.body));
      return Response.json({ name: 'ok' });
    }) as typeof fetch;
    const gateway = await createPushGatewayFromEnv(
      {
        PUSH_GATEWAY_KEY: pushKey.nsec(),
        PUSH_IOS: 'off', // 只送 Android（v0.48.0 起沒寫就是 apns，要 Apple 金鑰；SDK ADR 0062）
        FCM_SERVICE_ACCOUNT: JSON.stringify({ type: 'service_account', project_id: 'cinder-test-123', client_email: 'a@b.iam.gserviceaccount.com', private_key: rsa.privateKey }),
      },
      'node',
      { store: memoryPushGatewayStore({ now: () => 0 }), fetch: google, onLog: () => {} },
    );
    const { sealed, key, expiresAt } = sealIotPushToken(pushKey.pubkey, { platform: 'android', token: 'fcm_token-0123456789abcdefghij' });
    const endpoint: IotPushEndpoint = { type: 'gateway', url: 'https://push.example', sealed, key };
    const dv = 'D'.repeat(22);
    const timers: { at: number; fn: () => void }[] = [];
    let clock = Date.now();
    const statuses: number[] = [];
    const sender = device.createPushSender({
      registrations: [{ id: 'ep1', endpoint, subscriptions: [{ dv, mode: 'standard' }], expiresAt }],
      now: () => clock,
      random: () => 0.5,
      setTimer: (fn: () => void, ms: number) => timers.push({ at: clock + ms, fn }),
      clearTimer: () => {},
      fetch: async (url: string, init: RequestInit) => {
        const res = await gateway.handle(new Request(url, init));
        statuses.push(res.status);
        return res;
      },
    });
    sender.notifyDevice(dv);
    sender.notifyDevice(dv); // 合併
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at - clock).toBe(15_000); // 0.5 × 30 秒
    clock = timers[0]!.at;
    timers.shift()!.fn();
    // 送出是非同步的（簽 JWT、驗簽、解密）；等到真的送到，不用寫死的時間（機器忙時 50 ms 不夠）
    await vi.waitFor(() => expect(statuses).toEqual([202]), { timeout: 4000 });
    expect(JSON.parse(fcm[0]!)).toEqual({ message: { token: 'fcm_token-0123456789abcdefghij', data: {}, android: { priority: 'HIGH', ttl: '3600s' } } });
    sender.stop();
  });
});
