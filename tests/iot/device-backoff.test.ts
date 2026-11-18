// 設備端的斷線分類與重連間隔（SDK ADR 0049 §10.2；SDK ADR 0140）。純函式——韌體照同一份測試向量實作。
import { describe, expect, it } from 'vitest';

import { classifyIotDeviceDisconnect, iotDeviceRetryDelayMs, IOT_DEVICE_QUOTA_JITTER_MS } from '../../src/iot/device-backoff.js';

const NOW = 1_800_000_000;
const relayHeaders = (extra: Record<string, string> = {}) => ({ 'Cinder-Relay': '1', ...extra });

describe('classifyIotDeviceDisconnect', () => {
  it('relay 的 503＋Cinder-Quota＋reset → quota-exhausted，帶 reset 與 Retry-After', () => {
    const d = classifyIotDeviceDisconnect(
      { kind: 'http', status: 503, headers: relayHeaders({ 'Cinder-Quota': 'home-budget', 'Retry-After': '3600' }), body: JSON.stringify({ error: 'rate-limited: iot-quota: x', reset: NOW + 3600 }) },
      NOW,
    );
    expect(d).toEqual({ class: 'quota-exhausted', reset: NOW + 3600, retryAfterSec: 3600 });
  });

  it('標頭不分大小寫；沒有 reset 時由 Retry-After 推算', () => {
    const d = classifyIotDeviceDisconnect({ kind: 'http', status: 503, headers: { 'cinder-relay': '1', 'cinder-quota': 'do-requests', 'retry-after': '120' }, body: '{"error":"rate-limited: iot-quota: x"}' }, NOW);
    expect(d).toEqual({ class: 'quota-exhausted', reset: NOW + 120, retryAfterSec: 120 });
  });

  it('沒有 Cinder-Relay 的 429＋1027＝Workers 帳號額度 → 睡到下一個 UTC 午夜', () => {
    const d = classifyIotDeviceDisconnect({ kind: 'http', status: 429, headers: {}, body: 'error code: 1027' }, NOW);
    expect(d.class).toBe('quota-exhausted');
    expect(d.reset! % 86400).toBe(0);
    expect(d.reset! > NOW && d.reset! <= NOW + 86400).toBe(true);
  });

  it('權杖錯、家不對、站沒開 → config-error', () => {
    for (const [status, error] of [
      [401, 'restricted: iot-token: device token missing or wrong'],
      [403, 'restricted: iot-home: this relay does not serve that home'],
      [404, 'restricted: iot-device: unknown device'],
      [404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel'],
    ] as const) {
      expect(classifyIotDeviceDisconnect({ kind: 'http', status, headers: relayHeaders(), body: JSON.stringify({ error }) }, NOW).class).toBe('config-error');
    }
  });

  it('relay 的 503 沒有 Cinder-Quota、平台的 5xx／1101 → relay-error；限速的 429 帶 Retry-After', () => {
    expect(classifyIotDeviceDisconnect({ kind: 'http', status: 503, headers: relayHeaders(), body: '{"error":"error: iot-relay: x"}' }, NOW)).toEqual({ class: 'relay-error' });
    expect(classifyIotDeviceDisconnect({ kind: 'http', status: 522, headers: {}, body: '' }, NOW)).toEqual({ class: 'relay-error' });
    expect(classifyIotDeviceDisconnect({ kind: 'http', status: 500, headers: {}, body: 'error code: 1101' }, NOW)).toEqual({ class: 'relay-error' });
    expect(classifyIotDeviceDisconnect({ kind: 'http', status: 429, headers: relayHeaders({ 'Retry-After': '60' }), body: '{"error":"rate-limited: iot-upgrade: x"}' }, NOW)).toEqual({ class: 'relay-error', retryAfterSec: 60 });
  });

  it('close 4429 iot-quota:<reset> → quota；4409 → replaced；其他關閉、網路失敗、心跳逾時 → network-down', () => {
    expect(classifyIotDeviceDisconnect({ kind: 'close', code: 4429, reason: `iot-quota:${NOW + 10}` }, NOW)).toEqual({ class: 'quota-exhausted', reset: NOW + 10 });
    expect(classifyIotDeviceDisconnect({ kind: 'close', code: 4429, reason: '' }, NOW)).toEqual({ class: 'quota-exhausted' });
    expect(classifyIotDeviceDisconnect({ kind: 'close', code: 4409, reason: 'replaced' }, NOW)).toEqual({ class: 'replaced' });
    expect(classifyIotDeviceDisconnect({ kind: 'close', code: 1006 }, NOW)).toEqual({ class: 'network-down' });
    expect(classifyIotDeviceDisconnect({ kind: 'network' }, NOW)).toEqual({ class: 'network-down' });
    expect(classifyIotDeviceDisconnect({ kind: 'heartbeat-timeout' }, NOW)).toEqual({ class: 'network-down' });
  });
});

describe('iotDeviceRetryDelayMs', () => {
  const base = { nowSec: NOW, clockSynced: true, attempt: 0 };
  it('額度：睡到 reset，再加 0–20 分鐘隨機（重置時分散）', () => {
    expect(iotDeviceRetryDelayMs({ class: 'quota-exhausted', reset: NOW + 100 }, { ...base, random: 0 })).toBe(100_000);
    expect(iotDeviceRetryDelayMs({ class: 'quota-exhausted', reset: NOW + 100 }, { ...base, random: 0.5 })).toBe(100_000 + IOT_DEVICE_QUOTA_JITTER_MS / 2);
  });
  it('額度但時鐘沒同步，或不知道 reset → 每 60 分鐘探測一次', () => {
    expect(iotDeviceRetryDelayMs({ class: 'quota-exhausted', reset: NOW + 100 }, { ...base, clockSynced: false, random: 0.9 })).toBe(3_600_000);
    expect(iotDeviceRetryDelayMs({ class: 'quota-exhausted' }, { ...base, random: 0.9 })).toBe(3_600_000);
  });
  it('設定錯誤 → 60 分鐘；被擠掉 → 60 秒', () => {
    expect(iotDeviceRetryDelayMs({ class: 'config-error' }, { ...base, random: 0.3 })).toBe(3_600_000);
    expect(iotDeviceRetryDelayMs({ class: 'replaced' }, { ...base, random: 0.3 })).toBe(60_000);
  });
  it('relay-error：5 秒起加倍到 10 分鐘，±30% 抖動；Retry-After 是下限', () => {
    expect(iotDeviceRetryDelayMs({ class: 'relay-error' }, { ...base, random: 0.5 })).toBe(5_000);
    expect(iotDeviceRetryDelayMs({ class: 'relay-error' }, { ...base, attempt: 3, random: 0 })).toBe(28_000);
    expect(iotDeviceRetryDelayMs({ class: 'relay-error' }, { ...base, attempt: 20, random: 0.5 })).toBe(600_000);
    expect(iotDeviceRetryDelayMs({ class: 'relay-error', retryAfterSec: 60 }, { ...base, random: 0.5 })).toBe(60_000);
  });
  it('network-down：1 秒起加倍到 60 秒，±30%；任何情況不小於 1 秒', () => {
    expect(iotDeviceRetryDelayMs({ class: 'network-down' }, { ...base, random: 0 })).toBe(1_000);
    expect(iotDeviceRetryDelayMs({ class: 'network-down' }, { ...base, attempt: 2, random: 0.999 })).toBe(5_197);
    expect(iotDeviceRetryDelayMs({ class: 'network-down' }, { ...base, attempt: 30, random: 0.5 })).toBe(60_000);
  });
});
