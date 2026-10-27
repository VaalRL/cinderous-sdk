// 協調器的裝置名稱可以在執行中更新（SDK ADR 0069）：之後產生的版本帶新名稱，已經產生的不回溯改。
import { describe, expect, it } from 'vitest';

import { Net } from './harness.js';

describe('setDeviceLabel：改名後的版本帶新名稱', () => {
  it('之後的版本（本機與別台看到的）帶新名稱；之前的不變；清理後最長 64 字、空的退回 deviceId', async () => {
    const net = new Net();
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', '1');
    await net.settle();
    a.sync.setDeviceLabel('Pixel 8');
    await a.edit('x.md', '2');
    await net.settle();
    expect((await a.sync.history('x.md')).map((e) => e.label)).toEqual(['Pixel 8', 'A']);
    expect((await b.sync.history('x.md')).map((e) => e.label)).toEqual(['Pixel 8', 'A']);
    a.sync.setDeviceLabel('名'.repeat(80));
    await a.edit('x.md', '3');
    a.sync.setDeviceLabel('');
    await a.edit('x.md', '4');
    await net.settle();
    expect((await b.sync.history('x.md')).map((e) => e.label).slice(0, 2)).toEqual(['a', '名'.repeat(64)]);
  });
});
