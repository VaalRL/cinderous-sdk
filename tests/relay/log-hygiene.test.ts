// 中繼的日誌不帶使用者的資料（SDK ADR 0064）：Cloudflare 版開了 observability，日誌在站主的後台看得到。
// 站主本來就看得到自己的設定（車道、名單），但使用者的 IP、pubkey、事件內容不該因為除錯而被留在日誌裡。
// 這裡掃 `src/relay` 每一個 console 呼叫的參數。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const relayDir = fileURLToPath(new URL('../../src/relay', import.meta.url));

/** 參數裡出現就算帶了使用者資料的識別字 */
const FORBIDDEN = /\b(?:pubkey|pubkeys|clientIp|ip|CF-Connecting-IP|content|sig|tags|event|events|ev)\b/;

function consoleCalls(source: string): string[] {
  const calls: string[] = [];
  const start = /console\.(?:log|info|warn|error|debug)\(/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    // 找對應的右括號（略過字串與樣板字面值裡的括號已足夠粗略：日誌參數不含不成對的括號）
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    calls.push(source.slice(m.index, i));
  }
  return calls;
}

describe('中繼日誌（SDK ADR 0064）', () => {
  it('🔴 console 呼叫不帶 IP、pubkey 或事件內容', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(relayDir)) {
      if (!name.endsWith('.ts') || name === 'dev-server.ts') continue;
      const source = readFileSync(join(relayDir, name), 'utf8');
      for (const call of consoleCalls(source)) if (FORBIDDEN.test(call)) offenders.push(`${name}: ${call.slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('掃描本身有效：找得到現有的 console 呼叫，也抓得到帶 pubkey 的寫法', () => {
    const worker = readFileSync(join(relayDir, 'worker.ts'), 'utf8');
    expect(consoleCalls(worker).length).toBeGreaterThan(0);
    expect(consoleCalls('console.warn(`rate limited ${pubkey}`);').some((call) => FORBIDDEN.test(call))).toBe(true);
  });
});
