// 新裝置加入時的索取（SDK ADR 0104；2026-10-22 motorola edge 20 pro 實機發現）：
// 每收到一個缺父版本或缺內容的版本就各送一則 `want`、而且廣播給名單上每一台（含離線的）——
// 實機 40 秒送了 363 則、乘上 7 台收件人約 2,500 個事件，同一身分每分鐘 100 則的預算要排 20 多分鐘，
// 這台自己的修改與直連信令都卡在後面。
import { describe, expect, it } from 'vitest';

import type { Device } from './harness.js';
import { Net } from './harness.js';

/** 真的中繼上，新身分的收件匣是空的：加入之前的廣播不會補送給它 */
function freshInbox(net: Net, d: Device): void {
  for (let i = 0; i < net.hub.messages.length; i += 1) d.transport.delivered.add(i);
}

async function vaultWithHistory(files: number, versions: number) {
  const net = new Net({ seed: 11 });
  const a = await net.add('a');
  // 名單上另外兩台，之後一直離線（像舊手機、沒在用的測試機）
  const c = await net.add('c');
  const d = await net.add('d');
  for (let v = 1; v <= versions; v += 1) {
    for (let i = 0; i < files; i += 1) await a.edit(`notes/n${i}.md`, `第 ${i} 篇的第 ${v} 版`);
    await net.settle();
    await net.clock.advance(60_000);
  }
  c.transport.setOnline(false);
  d.transport.setOnline(false);
  await net.settle();
  return { net, a };
}

describe('🔴 新裝置加入時的索取：合併成幾則、只問答得出來的裝置（SDK ADR 0104）', () => {
  it('40 個檔、每個 3 版：新裝置的索取不超過幾則，而且只送給在線、送版本來的那台', async () => {
    const { net, a } = await vaultWithHistory(40, 3);
    const n = await net.add('n', { online: false });
    freshInbox(net, n);
    const before = net.hub.sends.length;
    n.transport.setOnline(true);
    await net.settle();
    const wants = net.hub.sends.slice(before).filter((s) => s.from === 'n' && s.message.type === 'want');
    expect(n.vault.tree()).toEqual(a.vault.tree());
    expect(wants.length).toBeLessThanOrEqual(4);
    for (const w of wants) expect(w.to).toEqual(['a']);
    expect([...a.errors, ...n.errors]).toEqual([]);
  });

  it('同一批裡的索取依「要不要內容」分開送，項目不重複', async () => {
    const { net } = await vaultWithHistory(10, 2);
    const n = await net.add('n', { online: false });
    freshInbox(net, n);
    const before = net.hub.sends.length;
    n.transport.setOnline(true);
    await net.settle();
    const wants = net.hub.sends.slice(before).filter((s) => s.from === 'n' && s.message.type === 'want');
    for (const w of wants) {
      if (w.message.type !== 'want') continue;
      const ids = w.message.items.map(([, id]) => id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
