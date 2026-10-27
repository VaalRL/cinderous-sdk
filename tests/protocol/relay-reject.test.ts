// 中繼拒收訊息的解析與分類（SDK ADR 0038 P0-C）：NIP-01 前綴＋Cinderous 英文詞元＋說明。
import { describe, expect, it } from 'vitest';

import {
  classifyRelayClose,
  classifyRelayMessage,
  RELAY_REJECT_TOKENS,
  relayRejectKindOf,
} from '../../src/protocol/relay-reject.js';

describe('classifyRelayMessage：前綴＋詞元＋說明', () => {
  it('拆出前綴、詞元與說明；詞元決定 blocked 底下的細類', () => {
    expect(classifyRelayMessage('blocked: ceiling: 本站離線留言空間已滿')).toMatchObject({
      prefix: 'blocked',
      token: 'ceiling',
      kind: 'ceiling',
      retryable: true,
      tryOtherRelays: true,
      detail: '本站離線留言空間已滿',
    });
    expect(classifyRelayMessage('blocked: quota: 可尋址位址已滿').kind).toBe('quota');
    expect(classifyRelayMessage('blocked: stale: 比現有的舊').kind).toBe('stale');
    expect(classifyRelayMessage('blocked: too-large: 事件過大').kind).toBe('too-large');
    expect(classifyRelayMessage('blocked: too-many-tags: tag 數超過上限').kind).toBe('too-large');
    expect(classifyRelayMessage('blocked: too-many-recipients: 收件人數超過上限').kind).toBe('too-large');
    expect(classifyRelayMessage('blocked: not-allowed: 非本企業成員').kind).toBe('policy');
    expect(classifyRelayMessage('blocked: kind-disabled: 此事件類型已被政策停用').kind).toBe('policy');
    expect(classifyRelayMessage('blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）').kind).toBe('policy');
  });

  it('其他前綴：invalid／pow／rate-limited／auth-required／restricted／duplicate／error', () => {
    expect(classifyRelayMessage('invalid: expired: 事件已過期')).toMatchObject({ kind: 'invalid', token: 'expired', retryable: false, tryOtherRelays: false });
    expect(classifyRelayMessage('invalid: too-large: 訊息過大').kind).toBe('too-large');
    expect(classifyRelayMessage('pow: difficulty: 需要難度 8')).toMatchObject({ kind: 'pow', token: 'difficulty' });
    expect(classifyRelayMessage('rate-limited: events: 發送過於頻繁')).toMatchObject({ kind: 'rate-limited', retryable: true });
    expect(classifyRelayMessage('auth-required: nip42: 請先認證（NIP-42）').kind).toBe('auth-required');
    expect(classifyRelayMessage('restricted: scope: 訂閱必須指定 #p')).toMatchObject({ kind: 'restricted', token: 'scope', retryable: false });
    expect(classifyRelayMessage('duplicate: seen: 事件重複')).toMatchObject({ kind: 'duplicate', retryable: false });
    expect(classifyRelayMessage('error: resubscribe: subscription was lost')).toMatchObject({ kind: 'error', token: 'resubscribe' });
    expect(classifyRelayMessage('auth-failed: relay-tag: relay tag 未指向本站').kind).toBe('restricted');
  });

  it('第三方中繼只有 NIP-01 前綴：退到前綴那一層', () => {
    expect(classifyRelayMessage('blocked: you are banned')).toMatchObject({ prefix: 'blocked', token: undefined, kind: 'policy' });
    expect(classifyRelayMessage('rate-limited: slow down')).toMatchObject({ kind: 'rate-limited', token: undefined });
    expect(classifyRelayMessage('invalid: event id does not match').kind).toBe('invalid');
    expect(classifyRelayMessage('mute: no one was listening').kind).toBe('policy');
    expect(classifyRelayMessage('unsupported: filter contains unknown elements').kind).toBe('policy');
    expect(classifyRelayMessage('error: could not connect to the database').kind).toBe('error');
    // 不認得的詞元照樣拆出來，但分類只看前綴
    expect(classifyRelayMessage('blocked: spam: 看起來像垃圾')).toMatchObject({ token: 'spam', kind: 'policy' });
  });

  it('沒有前綴、空字串、大小寫與空白', () => {
    expect(classifyRelayMessage('')).toMatchObject({ prefix: undefined, kind: 'unknown', retryable: true });
    expect(classifyRelayMessage('something went wrong').kind).toBe('unknown');
    expect(classifyRelayMessage('  Blocked: Ceiling: 滿了 ').kind).toBe('ceiling');
  });

  it('舊版中繼（沒有詞元）的訊息照樣認得：檔案未啟用、DO 重啟遺失訂閱、升級被拒', () => {
    expect(classifyRelayMessage('blocked: 檔案事件未啟用（MAX_FILE_MB）')).toMatchObject({ kind: 'policy', token: 'files-disabled' });
    expect(classifyRelayMessage('error: subscription was lost when the relay restarted; please resubscribe (ADR-0373)').token).toBe('resubscribe');
    expect(classifyRelayMessage('unknown relay path. Third-party apps connect to wss://x/app/<id>').kind).toBe('invalid');
    expect(classifyRelayMessage('invalid app lane: connect to wss://x/app/<id>').kind).toBe('invalid');
    // 舊的可尋址那一句不知道細類：當成政策拒收（換別座有用）
    expect(classifyRelayMessage('blocked: 取代事件遭拒（配額/大小/較舊）').kind).toBe('policy');
  });

  it('詞元表：每個詞元都是小寫英文與連字號，而且不重複', () => {
    const values = Object.values(RELAY_REJECT_TOKENS);
    expect(new Set(values).size).toBe(values.length);
    for (const token of values) expect(token).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('relayRejectKindOf 對每個分類給出一致的可重試、換座有用', () => {
    expect(relayRejectKindOf('ceiling')).toEqual({ retryable: true, tryOtherRelays: true });
    expect(relayRejectKindOf('invalid')).toEqual({ retryable: false, tryOtherRelays: false });
    expect(relayRejectKindOf('stale')).toEqual({ retryable: false, tryOtherRelays: false });
    expect(relayRejectKindOf('policy')).toEqual({ retryable: false, tryOtherRelays: true });
    expect(relayRejectKindOf('disconnected')).toEqual({ retryable: true, tryOtherRelays: true });
  });
});

describe('classifyRelayClose：WebSocket 關閉碼', () => {
  it('1008 rate-limited＝限速踢線；4003＝白名單外；1008 too-many-connections＝同一把公鑰連線過多', () => {
    expect(classifyRelayClose(1008, 'rate-limited')).toMatchObject({ kind: 'rate-limited', code: 1008, reason: 'rate-limited' });
    expect(classifyRelayClose(4003, 'restricted')).toMatchObject({ kind: 'restricted', retryable: false });
    expect(classifyRelayClose(1008, 'too-many-connections').kind).toBe('restricted');
  });

  it('升級被拒（路徑、車道名）是自己的設定錯；其他 1008 當政策', () => {
    expect(classifyRelayClose(1008, 'unknown relay path').kind).toBe('invalid');
    expect(classifyRelayClose(1008, 'invalid app lane; docs: https://x').kind).toBe('invalid');
    expect(classifyRelayClose(1008, 'go away').kind).toBe('policy');
  });

  it('其他關閉碼或沒有關閉碼（舊的注入實作）＝網路斷線', () => {
    expect(classifyRelayClose(1006, '')).toMatchObject({ kind: 'disconnected', retryable: true });
    expect(classifyRelayClose(1000)).toMatchObject({ kind: 'disconnected' });
    expect(classifyRelayClose(undefined, undefined)).toMatchObject({ kind: 'disconnected', code: undefined });
  });
});
