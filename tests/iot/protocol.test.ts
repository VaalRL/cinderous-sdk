// `./iot` 協定的純函式（SDK ADR 0049 §2.2–§2.5）：MQTT 樣式比對、前綴標籤、內容驗證、去重與重放、retained 打包、角色權限。
import { describe, expect, it } from 'vitest';

import {
  applyIotAclOp,
  authorizeIot,
  deviceMatches,
  IOT_ACL_TOPIC,
  IOT_KIND_ACK,
  IOT_KIND_COMMAND,
  IOT_KIND_HEARTBEAT,
  IOT_KIND_QUERY,
  IOT_KIND_RETAINED,
  IOT_KIND_STATE,
  IOT_RETAINED_PART_MAX_BYTES,
  IotReplayGuard,
  iotRoleOf,
  isValidIotTopic,
  isValidIotTopicPattern,
  mergeIotRetained,
  newIotMsgId,
  packIotRetained,
  parseIotAcl,
  parseIotAclOp,
  parseIotBody,
  topicMatches,
  topicPrefixes,
  topicSubscriptionPlan,
  type IotAcl,
} from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';

describe('kind（裁示第 11 項）', () => {
  it('25170–25173、31170／31171；ephemeral 與可尋址區間', () => {
    expect([IOT_KIND_COMMAND, IOT_KIND_ACK, IOT_KIND_STATE, IOT_KIND_QUERY]).toEqual([25170, 25171, 25172, 25173]);
    expect([IOT_KIND_RETAINED, IOT_KIND_HEARTBEAT]).toEqual([31170, 31171]);
    for (const k of [IOT_KIND_COMMAND, IOT_KIND_ACK, IOT_KIND_STATE, IOT_KIND_QUERY]) expect(k >= 20000 && k < 30000 && (k < 21000 || k > 21999)).toBe(true);
  });
});

describe('MQTT 樣式比對', () => {
  const cases: [string, string, boolean][] = [
    ['home/plug1/power', 'home/plug1/power', true],
    ['home/+/power', 'home/plug1/power', true],
    ['home/+/power', 'home/plug1/energy', false],
    ['home/#', 'home', true],
    ['home/#', 'home/plug1/power', true],
    ['home/+', 'home/plug1/power', false],
    ['#', 'home/plug1', true],
    ['+/+', 'home/plug1', true],
    ['+', 'home/plug1', false],
    ['#', '$sys/acl', false],
    ['+/acl', '$sys/acl', false],
    ['$sys/#', '$sys/acl', true],
    ['home/plug1', 'home/plug1/power', false],
  ];
  for (const [pattern, topic, expected] of cases) {
    it(`${pattern} ${expected ? '配到' : '配不到'} ${topic}`, () => expect(topicMatches(pattern, topic)).toBe(expected));
  }

  it('樣式與 topic 的合法性', () => {
    expect(isValidIotTopic('home/plug1/power')).toBe(true);
    expect(isValidIotTopic('home/+/power')).toBe(false);
    expect(isValidIotTopic('')).toBe(false);
    expect(isValidIotTopicPattern('home/#')).toBe(true);
    expect(isValidIotTopicPattern('home/#/x')).toBe(false);
    expect(isValidIotTopicPattern('home/a+')).toBe(false);
    expect(isValidIotTopicPattern('a/'.repeat(20) + 'b')).toBe(false);
  });

  it('前綴標籤與訂閱計畫', () => {
    expect(topicPrefixes('a/b/c')).toEqual(['a/#', 'a/b/#', 'a/b/c/#']);
    expect(topicSubscriptionPlan('a/b/c')).toEqual({ by: 'exact', value: 'a/b/c' });
    expect(topicSubscriptionPlan('a/b/#')).toEqual({ by: 'prefix', value: 'a/b/#' });
    expect(topicSubscriptionPlan('a/+/c')).toEqual({ by: 'prefix', value: 'a/#' });
    expect(topicSubscriptionPlan('+/b')).toEqual({ by: 'home' });
    expect(topicSubscriptionPlan('#')).toEqual({ by: 'home' });
  });

  it('設備樣式：完全相同或 * 結尾前綴', () => {
    expect(deviceMatches('light-*', 'light-kitchen')).toBe(true);
    expect(deviceMatches('light-*', 'plug1')).toBe(false);
    expect(deviceMatches('*', 'plug1')).toBe(true);
    expect(deviceMatches('plug1', 'plug10')).toBe(false);
  });
});

describe('內容驗證', () => {
  const base = { v: 1, msgId: newIotMsgId(), ts: Date.now() };
  it('合法的指令、查詢、ack、狀態、retained', () => {
    expect(parseIotBody({ ...base, type: 'cmd', topic: 'home/p/set', payload: 'ON', enc: 'utf8', qos: 1 })?.type).toBe('cmd');
    expect(parseIotBody({ ...base, type: 'query', device: 'p' })?.type).toBe('query');
    expect(parseIotBody({ ...base, type: 'ack', inReplyTo: newIotMsgId(), status: 'not-allowed' })?.type).toBe('ack');
    expect(parseIotBody({ ...base, type: 'state', topic: 'home/p/power', payload: 'ON', enc: 'utf8' })?.type).toBe('state');
    expect(parseIotBody({ ...base, type: 'retained', device: 'p', topics: { 'home/p/power': { payload: 'ON', ts: 1 } }, part: 0, parts: 1 })?.type).toBe('retained');
  });
  it('不合法的一律回 undefined（不丟例外）', () => {
    expect(parseIotBody(null)).toBeUndefined();
    expect(parseIotBody({ ...base, v: 2, type: 'query', device: 'p' })).toBeUndefined();
    expect(parseIotBody({ ...base, type: 'cmd', topic: 'home/+/set', payload: 'ON', enc: 'utf8', qos: 1 })).toBeUndefined();
    expect(parseIotBody({ ...base, type: 'cmd', topic: 'home/p/set', payload: 'x'.repeat(9000), enc: 'utf8', qos: 1 })).toBeUndefined();
    expect(parseIotBody({ ...base, type: 'cmd', topic: 'home/p/set', payload: 'ON', enc: 'utf8', qos: 2 })).toBeUndefined();
    expect(parseIotBody({ ...base, type: 'ack', inReplyTo: newIotMsgId(), status: 'great' })).toBeUndefined();
    expect(parseIotBody({ ...base, msgId: 'short', type: 'query', device: 'p' })).toBeUndefined();
    expect(parseIotBody({ ...base, type: 'query', device: 'bad device' })).toBeUndefined();
    expect(parseIotBody({ ...base, type: 'retained', device: 'p', topics: {}, part: 1, parts: 1 })).toBeUndefined();
  });
});

describe('去重與重放保護', () => {
  it('時間窗：早於 maxSkew 或晚於 5 秒拒收；同一 msgId 回傳第一次的結果', () => {
    let now = 1_000_000;
    const guard = new IotReplayGuard<string>({ maxSkewSec: 30, now: () => now });
    expect(guard.check('a', now - 31_000).verdict).toBe('too-old');
    expect(guard.check('a', now + 6_000).verdict).toBe('too-new');
    expect(guard.check('a', now).verdict).toBe('fresh');
    guard.settle('a', 'ok');
    expect(guard.check('a', now)).toEqual({ verdict: 'duplicate', result: 'ok' });
    now += 60_000;
    expect(guard.check('b', now).verdict).toBe('fresh');
    expect(guard.size).toBe(1); // a 已超出時間窗、被淘汰
  });

  it('maxSkewSec 夾在 5–120', () => {
    expect(new IotReplayGuard({ maxSkewSec: 1 }).maxSkewMs).toBe(5_000);
    expect(new IotReplayGuard({ maxSkewSec: 999 }).maxSkewMs).toBe(120_000);
  });

  it('滿了而且都還在時間窗內：拒收新的（fail-closed），不擠掉還有效的 msgId', () => {
    const now = 5_000_000;
    const guard = new IotReplayGuard({ size: 16, now: () => now });
    for (let i = 0; i < 16; i += 1) expect(guard.check(`k${i}`, now).verdict).toBe('fresh');
    expect(guard.check('k16', now).verdict).toBe('busy');
    expect(guard.check('k0', now).verdict).toBe('duplicate');
  });
});

describe('retained 打包', () => {
  it('小的一顆；大的拆成多顆，合併回來一樣', () => {
    const one = packIotRetained({ device: 'p', topics: { 'home/p/power': { payload: 'ON', ts: 1 } }, ts: 10 });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ part: 0, parts: 1 });
    const topics: Record<string, { payload: string; ts: number }> = {};
    for (let i = 0; i < 6; i += 1) topics[`home/big/t${i}`] = { payload: 'x'.repeat(6000), ts: i + 1 };
    const parts = packIotRetained({ device: 'big', topics, ts: 20, online: true });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThanOrEqual(IOT_RETAINED_PART_MAX_BYTES);
    const merged = mergeIotRetained([...parts].reverse());
    expect(merged).toMatchObject({ device: 'big', ts: 20, online: true, complete: true });
    expect(Object.keys(merged!.topics)).toHaveLength(6);
  });

  it('只合併最新一次打包；缺顆時 complete=false', () => {
    const old = packIotRetained({ device: 'p', topics: { 'home/p/a': { payload: '1', ts: 1 } }, ts: 1 });
    const topics: Record<string, { payload: string; ts: number }> = {};
    for (let i = 0; i < 4; i += 1) topics[`home/p/t${i}`] = { payload: 'y'.repeat(6000), ts: 2 };
    const fresh = packIotRetained({ device: 'p', topics, ts: 2 });
    const merged = mergeIotRetained([...old, fresh[0]!]);
    expect(merged?.ts).toBe(2);
    expect(merged?.complete).toBe(false);
    expect(merged?.topics['home/p/a']).toBeUndefined();
  });
});

describe('角色權限（ADR 0049 §2.5）', () => {
  const pk = () => getPublicKey(generateSecretKey());
  const owner = pk();
  const kid = pk();
  const nanny = pk();
  const guest = pk();
  const now = 1_759_000_000;
  const acl: IotAcl = parseIotAcl({
    entries: [
      { npub: npubEncode(owner), role: 'owner' },
      { pubkey: kid, role: 'operator', devices: ['light-*'], topics: ['home/+/light/#'] },
      { pubkey: nanny, role: 'viewer', devices: ['cam-door', 'thermo'] },
      { pubkey: guest, role: 'viewer', expiresAt: now - 1 },
    ],
    rules: [
      { topic: 'home/door/#', minRole: 'owner', confirm: true },
      { topic: 'home/gas/#', confirm: true },
    ],
  });

  it('npub 會被正規化成 hex', () => {
    expect(acl.entries[0]!.pubkey).toBe(owner);
  });

  it('viewer 能查詢、不能操作；operator 依設備與 topic 細分（交集）', () => {
    expect(authorizeIot(acl, { pubkey: nanny, action: 'query', device: 'thermo' }, now)).toEqual({ ok: true, role: 'viewer' });
    expect(authorizeIot(acl, { pubkey: nanny, action: 'query', device: 'plug1' }, now)).toMatchObject({ ok: false, status: 'not-allowed', reason: 'device' });
    expect(authorizeIot(acl, { pubkey: nanny, action: 'operate', device: 'thermo', topic: 'home/thermo/set' }, now)).toMatchObject({ ok: false, reason: 'role' });
    expect(authorizeIot(acl, { pubkey: kid, action: 'operate', device: 'light-kitchen', topic: 'home/kitchen/light/set' }, now).ok).toBe(true);
    expect(authorizeIot(acl, { pubkey: kid, action: 'operate', device: 'light-kitchen', topic: 'home/kitchen/plug/set' }, now)).toMatchObject({ ok: false, reason: 'topic' });
    expect(authorizeIot(acl, { pubkey: kid, action: 'operate', device: 'plug1', topic: 'home/kitchen/light/set' }, now)).toMatchObject({ ok: false, reason: 'device' });
    expect(authorizeIot(acl, { pubkey: kid, action: 'operate', topic: 'home/kitchen/light/set' }, now)).toMatchObject({ ok: false, reason: 'device' });
  });

  it('不在名單、過期 → not-allowed', () => {
    expect(authorizeIot(acl, { pubkey: pk(), action: 'query', device: 'x' }, now)).toMatchObject({ ok: false, reason: 'not-in-acl' });
    expect(authorizeIot(acl, { pubkey: guest, action: 'query', device: 'x' }, now)).toMatchObject({ ok: false, reason: 'expired' });
    expect(iotRoleOf(acl, guest, now)).toBeUndefined();
    expect(iotRoleOf(acl, owner, now)).toBe('owner');
  });

  it('minRole 與 confirm', () => {
    expect(authorizeIot(acl, { pubkey: owner, action: 'operate', topic: 'home/door/open' }, now)).toMatchObject({ ok: false, status: 'rejected', reason: 'confirm-required' });
    expect(authorizeIot(acl, { pubkey: owner, action: 'operate', topic: 'home/door/open', confirmed: true }, now).ok).toBe(true);
    const op = parseIotAcl({ entries: [{ pubkey: owner, role: 'owner' }, { pubkey: kid, role: 'operator' }], rules: acl.rules });
    expect(authorizeIot(op, { pubkey: kid, action: 'operate', topic: 'home/door/open', confirmed: true }, now)).toMatchObject({ ok: false, reason: 'min-role' });
  });

  it('$sys/acl 只有 owner；不能移除或降級最後一位 owner', () => {
    expect(authorizeIot(acl, { pubkey: kid, action: 'operate', topic: IOT_ACL_TOPIC }, now)).toMatchObject({ ok: false, reason: 'owner-only' });
    expect(authorizeIot(acl, { pubkey: owner, action: 'operate', topic: IOT_ACL_TOPIC }, now).ok).toBe(true);
    const added = applyIotAclOp(acl, parseIotAclOp(JSON.stringify({ op: 'add', entry: { pubkey: guest, role: 'operator' } })), now);
    expect(iotRoleOf(added, guest, now)).toBe('operator');
    expect(() => applyIotAclOp(acl, { op: 'remove', pubkey: owner }, now)).toThrow(/owner/);
    expect(() => applyIotAclOp(acl, { op: 'add', entry: { pubkey: owner, role: 'viewer' } }, now)).toThrow(/owner/);
    expect(() => parseIotAclOp('{"op":"chmod"}')).toThrow();
    expect(() => parseIotAcl([{ pubkey: owner, role: 'owner' }, { pubkey: owner, role: 'viewer' }])).toThrow(/重複/);
    expect(() => parseIotAcl([{ pubkey: owner, role: 'admin' }])).toThrow(/role/);
  });
});
