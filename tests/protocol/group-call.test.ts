// 網狀小群組通話的信令（SDK ADR 0141）：信任邊界與相容性。
import { describe, expect, it } from 'vitest';

import {
  GROUP_CALL_DEFAULT_MAX,
  GROUP_CALL_HARD_MAX,
  groupCallOfferer,
  parseCallSignal,
  parseGroupCallSignal,
} from '../../src/protocol/index.js';

const pk = (c: string) => c.repeat(64);
const gid = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('群組通話信令', () => {
  it('上限：預設 4、硬上限 6', () => {
    expect(GROUP_CALL_DEFAULT_MAX).toBe(4);
    expect(GROUP_CALL_HARD_MAX).toBe(6);
  });

  it('誰發 offer：字典序較小的那位（兩邊算出同一個答案，不會 glare）', () => {
    expect(groupCallOfferer(pk('a'), pk('b'))).toBe(pk('a'));
    expect(groupCallOfferer(pk('b'), pk('a'))).toBe(pk('a'));
  });

  it('解析各種信令', () => {
    const members = [pk('a'), pk('b'), pk('c')];
    expect(parseGroupCallSignal(JSON.stringify({ v: 1, type: 'group-invite', groupId: gid, media: 'video', members }))).toEqual({
      v: 1,
      type: 'group-invite',
      groupId: gid,
      media: 'video',
      members,
    });
    expect(parseGroupCallSignal(JSON.stringify({ v: 1, type: 'group-join', groupId: gid, members, ack: true }))).toMatchObject({ ack: true });
    expect(parseGroupCallSignal(JSON.stringify({ v: 1, type: 'group-offer', groupId: gid, sdp: 'x', media: 'audio' }))).toMatchObject({ sdp: 'x' });
    expect(
      parseGroupCallSignal(JSON.stringify({ v: 1, type: 'group-candidate', groupId: gid, candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 })),
    ).toMatchObject({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
    expect(parseGroupCallSignal(JSON.stringify({ v: 1, type: 'group-decline', groupId: gid, reason: 'busy' }))).toMatchObject({ reason: 'busy' });
  });

  it('信任邊界：成員要是 64 個小寫 hex、不重複、不超過硬上限；groupId 要夠長', () => {
    const bad = [
      { v: 1, type: 'group-invite', groupId: gid, media: 'audio', members: ['ABC'] },
      { v: 1, type: 'group-invite', groupId: gid, media: 'audio', members: [pk('a'), pk('a')] },
      { v: 1, type: 'group-invite', groupId: gid, media: 'audio', members: 'abcdefg'.split('').map(pk) },
      { v: 1, type: 'group-invite', groupId: 'short', media: 'audio', members: [pk('a')] },
      { v: 1, type: 'group-invite', groupId: gid, media: 'screen', members: [pk('a')] },
      { v: 1, type: 'group-decline', groupId: gid, reason: 'whatever' },
      { v: 1, type: 'group-nope', groupId: gid },
      { v: 2, type: 'group-leave', groupId: gid },
    ];
    for (const b of bad) expect(() => parseGroupCallSignal(JSON.stringify(b)), JSON.stringify(b)).toThrow();
  });

  it('🔴 相容：舊版（只懂一對一）的 parseCallSignal 會拒收群組信令——舊版對端安全地忽略，不會當成一對一來電響鈴', () => {
    const invite = JSON.stringify({ v: 1, type: 'group-invite', groupId: gid, media: 'audio', members: [pk('a'), pk('b')] });
    expect(() => parseCallSignal(invite)).toThrow();
  });
});
