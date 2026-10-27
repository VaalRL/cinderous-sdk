// G8（SDK ADR 0035）× 中繼 REQ 位元組預算（v0.27；Cinderous ADR-0371）× 分頁補拉（v0.25；SDK ADR 0029）。
//
// 補訂閱把 since 往前退讓兩天之後：
// 1. 中繼對那一次 REQ 仍只回「最新、累計不超過預算」的那些——重拉的量有上限（不會因為兩天窗而無限放大）；
// 2. 重連之後即時送來、外層時間被往前推的事件照樣收到（這是修正的目的）；
// 3. 被預算截掉的較舊事件（離線期間寄來、時間又被往前推的）由分頁補拉（`forEachPage`，以 `until` 往回翻）補齊；
// 4. 重拉回來、已經交給上層的事件不重複交。
import { describe, expect, it } from 'vitest';

import { Identity } from '../src/identity.js';
import { MessageStore } from '../src/relay/message-store.js';
import { NIP59_MAX_BACKDATE_SEC, RelayPool } from '../src/relay-pool.js';
import { forEachPage } from '../src/sync/hydrator.js';
import { BridgeSocket, CoreBridge } from './core-bridge.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('G8 × REQ 位元組預算 × 分頁補拉', () => {
  it('🔴 重拉受預算限制；即時的往前推事件收得到；被預算截掉的由分頁補齊；不重複交', async () => {
    const BUDGET = 12_000;
    const bridge = new CoreBridge({ store: new MessageStore(), acceptFileEvents: true, maxQueryBytes: BUDGET });
    const sender = Identity.generate();
    const recipient = Identity.generate();
    const now = Math.floor(Date.now() / 1000);
    const wrap = (createdAt: number, label: string) =>
      sender.sign({ kind: 1060, created_at: createdAt, tags: [['p', recipient.pubkey], ['expiration', String(now + 86_400)]], content: `${label}:${'x'.repeat(900)}` });

    const sockets: BridgeSocket[] = [];
    const pool = new RelayPool({
      urls: ['wss://core'],
      identity: recipient,
      reconnectDelaysMs: [1],
      createSocket: () => {
        const s = bridge.create() as BridgeSocket;
        sockets.push(s);
        return s;
      },
    });
    const senderPool = new RelayPool({ urls: ['wss://core'], identity: sender, createSocket: bridge.create });
    pool.connect();
    senderPool.connect();
    await tick();

    // 兩天窗內已經有 40 顆（每顆約 1.2 KB，遠超過 12 KB 的預算）
    for (let i = 0; i < 40; i += 1) await senderPool.publish(wrap(now - 3600 - i * 60, `old${i}`));
    const delivered: string[] = [];
    const sub = pool.subscribe([{ kinds: [1060], '#p': [recipient.pubkey], since: now - 7 * 86_400 }], {
      onEvent: (event) => delivered.push(event.content.split(':')[0]!),
    });
    await tick();
    const firstBatch = delivered.length;
    expect(firstBatch).toBeGreaterThan(0);
    expect(firstBatch).toBeLessThan(40); // 預算截斷：只拿到最新的那一段
    await senderPool.publish(wrap(now, 'live-before'));
    await tick();
    expect(delivered).toContain('live-before'); // 游標＝現在

    // 斷線；離線期間寄來 5 顆、外層時間被往前推 1.5 天
    const before = sockets.at(-1)!;
    before.close();
    for (let i = 0; i < 5; i += 1) await senderPool.publish(wrap(now - 36 * 3600 - i, `offline${i}`));
    await new Promise((resolve) => setTimeout(resolve, 20)); // 退避 1 ms 後重連
    await tick();
    const after = sockets.at(-1)!;
    expect(after).not.toBe(before);

    // 1. 重拉的量受預算限制（加上 AUTH、EOSE 之類的小訊框）
    expect(after.bytesIn).toBeLessThanOrEqual(BUDGET + 2_000);

    // 2. 重連之後即時送來、外層時間被往前推一天的：收得到（修正前被中繼以 since 擋掉）
    await senderPool.publish(wrap(now - 86_400, 'live-after'));
    await tick();
    expect(delivered).toContain('live-after');

    // 3. 被預算截掉的離線事件：分頁補拉（since＝斷線時間 − 兩天）全部拿得到
    const paged: string[] = [];
    const result = await forEachPage(pool, [{ kinds: [1060], '#p': [recipient.pubkey], since: now - NIP59_MAX_BACKDATE_SEC }], (events) =>
      paged.push(...events.map((e) => e.content.split(':')[0]!)),
    );
    expect(result.complete).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(paged).toContain(`offline${i}`);
    expect(paged).toHaveLength(40 + 5 + 2);

    // 4. 訂閱內不重複交
    expect(new Set(delivered).size).toBe(delivered.length);
    sub.close();
    pool.close();
    senderPool.close();
  });
});
