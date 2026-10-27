// 推播介面（SDK ADR 0011 §6；PRD 2.5.2、2.5.3）：預設關閉，只准送空的喚醒訊號。
import { describe, expect, it } from 'vitest';

import { assertZeroKnowledgePush, DisabledPushAdapter, silentTicklePayload } from '../../src/sync/push.js';

describe('推播', () => {
  it('預設的 adapter 是關閉的，註冊與取消都什麼都不做', async () => {
    const adapter = new DisabledPushAdapter();
    expect(adapter.provider).toBe('disabled');
    await expect(adapter.registerDevice('token')).resolves.toBeUndefined();
    await expect(adapter.unregisterDevice()).resolves.toBeUndefined();
  });

  it('iOS 的喚醒訊號就是 content-available: 1，沒有別的欄位', () => {
    expect(silentTicklePayload('apns')).toEqual({ aps: { 'content-available': 1 } });
  });

  it('每一種廠商的喚醒訊號都通過零知識檢查', () => {
    for (const provider of ['apns', 'fcm', 'unifiedpush'] as const) {
      expect(() => assertZeroKnowledgePush(provider, silentTicklePayload(provider))).not.toThrow();
    }
  });

  it('🔴 多帶任何東西（標題、內文、寄件人）→ 丟例外', () => {
    expect(() => assertZeroKnowledgePush('apns', { aps: { 'content-available': 1, alert: '新訊息' } })).toThrow();
    expect(() => assertZeroKnowledgePush('apns', { aps: { 'content-available': 1 }, from: 'npub1…' })).toThrow();
    expect(() => assertZeroKnowledgePush('fcm', { data: { title: '會議記錄' } })).toThrow();
  });

  it('關閉的推播沒有喚醒訊號', () => {
    expect(() => silentTicklePayload('disabled')).toThrow();
  });
});
