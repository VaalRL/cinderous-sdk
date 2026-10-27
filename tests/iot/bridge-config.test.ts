// 橋接器的 topic 對照表、設定檔解析、mqtt.js 沒安裝時的錯誤訊息、角色名單檔（SDK ADR 0049 §3；使用者裁示 10）。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileIotTopicMap, fileIotAclStore, fileIotPushStore, loadMqttConnect, resolveIotBridgeConfig, resolveIotClientConfig } from '../../src/iot/bridge/index.js';
import { Identity } from '../../src/identity.js';
import { generateIotHomeSecret, iotPushEndpointId } from '../../src/iot/index.js';

describe('topic 對照表', () => {
  const map = compileIotTopicMap(
    [
      { mqtt: 'stat/plug1/+', topic: 'home/plug1/+', device: 'plug1', dir: 'up' },
      { mqtt: 'tele/plug1/LWT', topic: 'home/plug1/online', device: 'plug1', dir: 'up', lwt: true },
      { mqtt: 'zigbee2mqtt/#', topic: 'home/zb/#', device: 'zb', dir: 'up' },
      { topic: 'home/plug1/set', mqtt: 'cmnd/plug1/POWER', device: 'plug1', dir: 'down' },
      { topic: 'home/zb/+/set', mqtt: 'zigbee2mqtt/+/set', device: 'zb', dir: 'down' },
    ],
    [{ device: 'plug1', mqtt: 'cmnd/plug1/STATUS', payload: '11' }],
  );

  it('up：萬用字元依序代入', () => {
    expect(map.up('stat/plug1/POWER')).toEqual({ topic: 'home/plug1/POWER', device: 'plug1' });
    expect(map.up('zigbee2mqtt/kitchen/temp')).toEqual({ topic: 'home/zb/kitchen/temp', device: 'zb' });
    expect(map.up('zigbee2mqtt')).toEqual({ topic: 'home/zb', device: 'zb' });
    expect(map.up('tele/plug1/LWT')).toEqual({ topic: 'home/plug1/online', device: 'plug1', lwt: { online: 'Online', offline: 'Offline' } });
    expect(map.up('stat/plug2/POWER')).toBeUndefined();
  });

  it('down 與 deviceOf、queries、訂閱清單', () => {
    expect(map.down('home/plug1/set')).toEqual({ mqtt: 'cmnd/plug1/POWER', device: 'plug1' });
    expect(map.down('home/zb/lamp/set')).toEqual({ mqtt: 'zigbee2mqtt/lamp/set', device: 'zb' });
    expect(map.down('home/plug9/set')).toBeUndefined();
    expect(map.deviceOf('home/zb/lamp/set')).toBe('zb');
    expect(map.queries('plug1')).toHaveLength(1);
    expect(map.subscriptions).toEqual(['stat/plug1/+', 'tele/plug1/LWT', 'zigbee2mqtt/#']);
  });

  it('寫錯就拒絕', () => {
    expect(() => compileIotTopicMap([])).toThrow(/至少/);
    expect(() => compileIotTopicMap([{ mqtt: 'a/+', topic: 'home/a', device: 'a', dir: 'up' }])).toThrow(/萬用字元/);
    expect(() => compileIotTopicMap([{ mqtt: 'a', topic: '$sys/acl', device: 'a', dir: 'down' }])).toThrow(/\$/);
    expect(() => compileIotTopicMap([{ mqtt: 'a', topic: 'home/a', device: 'bad id', dir: 'up' }])).toThrow(/device/);
    expect(() => compileIotTopicMap([{ mqtt: 'a', topic: 'home/a', device: 'a', dir: 'sideways' as 'up' }])).toThrow(/dir/);
    expect(() => compileIotTopicMap([{ mqtt: 'a', topic: 'home/a', device: 'a', dir: 'up' }], [{ device: 'a', mqtt: 'cmnd/+/x' }])).toThrow(/queryMap/);
  });
});

describe('設定檔（秘密只寫 $env）', () => {
  const gwKey = Identity.generate();
  const env = { IOT_HOME_SECRET: generateIotHomeSecret(), IOT_GATEWAY_KEY: gwKey.nsec(), MQTT_PASSWORD: 'pw' };
  const base = {
    mqtt: { url: 'mqtt://localhost:1883', username: 'bridge', password: { $env: 'MQTT_PASSWORD' } },
    relays: ['wss://relay.example/app/iot'],
    topicMap: [{ mqtt: 'stat/p/POWER', topic: 'home/p/power', device: 'p', dir: 'up' }],
    acl: [{ npub: Identity.generate().npub, role: 'owner' }],
  };

  it('解析成功：預設環境變數、aclFile 預設 iot-acl.json', () => {
    const c = resolveIotBridgeConfig(base, env);
    expect(c.mqtt).toEqual({ url: 'mqtt://localhost:1883', username: 'bridge', password: 'pw' });
    expect(c.gatewayNsec).toBe(gwKey.nsec());
    expect(c.homeSecret).toHaveLength(32);
    expect(c.aclFile).toBe('iot-acl.json');
    expect(c.acl?.entries).toHaveLength(1);
  });

  it('秘密直接寫進檔案、缺少秘密、網址不對：拒絕', () => {
    expect(() => resolveIotBridgeConfig({ ...base, homeSecret: env.IOT_HOME_SECRET }, env)).toThrow(/\$env/);
    expect(() => resolveIotBridgeConfig({ ...base, mqtt: { ...base.mqtt, password: 'pw' } }, env)).toThrow(/\$env/);
    expect(() => resolveIotBridgeConfig(base, { ...env, IOT_GATEWAY_KEY: undefined })).toThrow(/IOT_GATEWAY_KEY/);
    expect(() => resolveIotBridgeConfig({ ...base, relays: ['https://x'] }, env)).toThrow(/relays/);
    expect(() => resolveIotBridgeConfig({ ...base, mqtt: { url: 'http://x' } }, env)).toThrow(/mqtt\.url/);
  });

  it('push 段：有才開；上限有預設值、可調、超出範圍拒絕；enabled: false 等於沒有', () => {
    expect(resolveIotBridgeConfig(base, env).push).toBeUndefined();
    expect(resolveIotBridgeConfig({ ...base, push: {} }, env).push).toEqual({
      storeFile: 'iot-push.json',
      limits: { maxEndpoints: 32, standardPerMinute: 1, instantPerMinute: 6, registrationTtlSec: 30 * 86_400 },
      allowPrivateHttp: false,
    });
    const tuned = resolveIotBridgeConfig({ ...base, push: { storeFile: 'p.json', maxEndpoints: 8, instantPerMinute: 3, allowPrivateHttp: true } }, env).push!;
    expect(tuned).toMatchObject({ storeFile: 'p.json', limits: { maxEndpoints: 8, instantPerMinute: 3 }, allowPrivateHttp: true });
    expect(resolveIotBridgeConfig({ ...base, push: { enabled: false } }, env).push).toBeUndefined();
    expect(() => resolveIotBridgeConfig({ ...base, push: { maxEndpoints: 0 } }, env)).toThrow(/push\.maxEndpoints/);
    expect(() => resolveIotBridgeConfig({ ...base, push: { instantPerMinute: 99 } }, env)).toThrow(/instantPerMinute/);
    expect(() => resolveIotBridgeConfig({ ...base, push: { maxEndpoint: 3 } }, env)).toThrow(/不認得/);
    expect(() => resolveIotBridgeConfig({ ...base, push: true }, env)).toThrow(/push/);
  });

  it('hex 私鑰也收（轉成 nsec）；客戶端設定檔', () => {
    const c = resolveIotClientConfig({ relays: ['ws://127.0.0.1:8787'], gateway: gwKey.npub }, { ...env, IOT_MEMBER_KEY: 'ab'.repeat(32) });
    expect(c.gateway).toBe(gwKey.pubkey);
    expect(c.memberNsec.startsWith('nsec1')).toBe(true);
    expect(() => resolveIotClientConfig({ relays: ['ws://x'], gateway: 'nope' }, env)).toThrow();
  });
});

describe('mqtt.js 是選用相依', () => {
  it('沒安裝：錯誤訊息明確告訴使用者 npm install mqtt', async () => {
    const missing = Object.assign(new Error("Cannot find package 'mqtt'"), { code: 'ERR_MODULE_NOT_FOUND' });
    await expect(loadMqttConnect(() => Promise.reject(missing))).rejects.toThrow('請執行 npm install mqtt');
  });

  it('有安裝：取得 connect()', async () => {
    expect(typeof (await loadMqttConnect())).toBe('function');
  });
});

describe('推播端點檔', () => {
  it('寫入後讀回一樣；不存在回 undefined；壞掉的存檔丟例外', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cinder-push-')), 'push.json');
    const store = fileIotPushStore(path);
    expect(store.load()).toBeUndefined();
    const endpoint = { type: 'unifiedpush' as const, url: 'https://ntfy.example/x' };
    const list = [{ id: iotPushEndpointId(endpoint), owner: Identity.generate().pubkey, endpoint, subscriptions: [{ dv: 'A'.repeat(22), mode: 'standard' as const }], createdAt: 1, expiresAt: 2 }];
    store.save(list);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(store.load()).toEqual(list);
    writeFileSync(path, JSON.stringify([{ ...list[0], id: 'B'.repeat(22) }]));
    expect(() => store.load()).toThrow(/id/);
  });
});

describe('角色名單檔', () => {
  it('寫入後讀回一樣；不存在回 undefined', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cinder-acl-')), 'acl.json');
    const store = fileIotAclStore(path);
    expect(store.load()).toBeUndefined();
    const acl = { entries: [{ pubkey: Identity.generate().pubkey, role: 'owner' as const }] };
    store.save(acl);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(store.load()).toEqual(acl);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(acl);
  });
});
