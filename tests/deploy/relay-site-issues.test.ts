// 收集式驗證（SDK ADR 0050 §3）：`collectRelaySiteIssues` 一次列出所有問題、不丟例外；
// `relaySiteVars` 改成「有錯就丟第一個」——對外行為與訊息不變（既有的 relay-site-options 測試就是回歸測試），
// 這裡另外逐項確認：丟出來的訊息＝收集到的第一個錯誤。
import { describe, expect, it } from 'vitest';

import { collectRelaySiteIssues, type RelaySiteOptions, relaySiteVars } from '../../src/deploy/shared.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { buildRelayInfo } from '../../src/relay/nip11.js';

const alice = getPublicKey(generateSecretKey());

/** 各種壞參數（每個都是 relaySiteVars 原本就會拒絕的） */
const BAD: [string, RelaySiteOptions, 'worker' | 'node'][] = [
  ['連線數 0', { maxConnectionsPerPubkey: 0 }, 'worker'],
  ['每秒訊息 1001', { maxMessagesPerSecondPerIp: 1001 }, 'worker'],
  ['白名單寫錯', { allowedPubkeys: ['npub1nope'] }, 'worker'],
  ['站名換行', { relayName: 'a\nb' }, 'worker'],
  ['描述太長', { relayDescription: 'x'.repeat(501) }, 'node'],
  ['聯絡方式控制字元', { relayContact: 'x\u0007' }, 'node'],
  ['營運者公鑰壞', { relayPubkey: 'nope' }, 'worker'],
  ['贊助太長', { donations: { lightning: 'x'.repeat(201) } }, 'worker'],
  ['保存期 0', { maxTtlDays: 0 }, 'node'],
  ['檔案塊 0 MB', { maxFileMb: 0, allowedPubkeys: [alice] }, 'worker'],
  ['開放中繼收檔案塊', { maxFileMb: 17 }, 'node'],
  ['車道 id 大寫', { appLanes: ['DocHost'] }, 'worker'],
  ['車道太多', { appLanes: Array.from({ length: 33 }, (_, i) => `l${i}`) }, 'worker'],
  ['檔案車道不在名單', { appLanes: ['a'], fileLanes: ['b'], maxFileMb: 17, allowedPubkeys: [alice] }, 'worker'],
  ['檔案車道沒有 maxFileMb', { appLanes: ['a'], fileLanes: ['a'] }, 'worker'],
  ['PoW 33', { appLanePow: 33 }, 'worker'],
  ['天花板 0', { doCeilings: { global: { offlineMib: 0, addressableMib: 1 } } }, 'worker'],
  ['保底在 strict', { doGuaranteeKib: { strict: 128 } }, 'worker'],
  ['溢位帶沒有保底', { doBorrowPercent: { public: 10 } }, 'worker'],
  ['超過預算', { doCeilings: { public: { offlineMib: 8192, addressableMib: 8192 } }, storageBudgetBytes: 1024 }, 'worker'],
  ['文件網址 http', { developerDocsUrl: 'http://example.com' }, 'worker'],
  ['軟體來源 http', { relaySoftwareUrl: 'http://example.com/src' }, 'worker'],
  ['Node 收到車道', { appLanes: ['dochost'] }, 'node'],
  ['Node 收到兩個 Worker 限定', { developerDocsUrl: 'https://x.example', appLanePow: 8 }, 'node'],
];

function thrown(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('collectRelaySiteIssues（SDK ADR 0050 §3）', () => {
  it('合法的參數 → 沒有問題（兩種主機）', () => {
    const site: RelaySiteOptions = { allowedPubkeys: [alice], relayName: 'Mine', maxTtlDays: 14, maxFileMb: 17 };
    expect(collectRelaySiteIssues(site, 'worker')).toEqual([]);
    expect(collectRelaySiteIssues(site, 'node')).toEqual([]);
    expect(collectRelaySiteIssues({}, 'worker')).toEqual([]);
  });

  for (const [label, opts, host] of BAD) {
    it(`🔴 行為不變：${label}——relaySiteVars 丟出的訊息＝收集到的第一個錯誤（Node 多個 Worker 限定時合併成一句）`, () => {
      const message = thrown(() => relaySiteVars(opts, host));
      expect(message, '原本就應該被拒').toBeDefined();
      const issues = collectRelaySiteIssues(opts, host);
      const errors = issues.filter((i) => i.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
      const workerOnly = errors.filter((i) => i.code === 'worker-only');
      if (workerOnly.length > 1) {
        for (const issue of workerOnly) expect(message).toContain(issue.path);
      } else {
        expect(errors[0]!.message['zh-TW']).toBe(message);
      }
      for (const issue of issues) {
        expect(issue.message.en.length, `${issue.path} 缺英文訊息`).toBeGreaterThan(0);
        expect(issue.code).toMatch(/^[a-z][a-z-]+$/);
      }
    });
  }

  it('一次列出全部，不在第一個就停', () => {
    const issues = collectRelaySiteIssues(
      { maxTtlDays: 0, relayName: 'a\nb', appLanes: ['BAD', 'ok', 'Also-Bad'], developerDocsUrl: 'http://x' },
      'worker',
    );
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['relayName', 'control-chars'],
      ['maxTtlDays', 'out-of-range'],
      ['appLanes', 'invalid-lane'],
      ['appLanes', 'invalid-lane'],
      ['developerDocsUrl', 'not-https'],
    ]);
  });

  it('Node 主機：每個 Worker 限定的參數各一則（worker-only）', () => {
    const issues = collectRelaySiteIssues({ appLanes: ['dochost'], appLanePow: 4 }, 'node');
    expect(issues.filter((i) => i.code === 'worker-only').map((i) => i.path)).toEqual(['appLanes', 'appLanePow']);
  });

  it('壞型別（來自 JSON 設定檔）也不丟例外，列成問題', () => {
    const weird = { relayName: 42, allowedPubkeys: 'npub1x', appLanes: 'dochost', maxTtlDays: '7' } as unknown as RelaySiteOptions;
    expect(() => collectRelaySiteIssues(weird, 'worker')).not.toThrow();
    expect(collectRelaySiteIssues(weird, 'worker').length).toBeGreaterThanOrEqual(3);
  });

  it('容量的範圍錯誤之後不再追加衍生的錯誤（例如預算），避免一個錯被報很多次', () => {
    const issues = collectRelaySiteIssues({ doCeilings: { global: { offlineMib: 0, addressableMib: 0 } }, storageBudgetBytes: 1 }, 'worker');
    expect(issues.map((i) => i.path)).toEqual(['doCeilings.global.offlineMib', 'doCeilings.global.addressableMib']);
  });
});

describe('relaySoftwareUrl → RELAY_SOFTWARE_URL（NIP-11 software；ADR 0050 使用者裁示 10）', () => {
  it('沒給就不設：NIP-11 仍是 SDK 的中立預設（ADR 0019）', () => {
    expect(relaySiteVars({}, 'worker').RELAY_SOFTWARE_URL).toBeUndefined();
    expect(buildRelayInfo({}).software).toBe('https://github.com/VaalRL/cinderous-sdk');
  });

  it('給了就寫入（兩種主機都支援）；必須是 https、最長 200 字', () => {
    const url = 'https://git.example.com/me/my-modified-relay';
    expect(relaySiteVars({ relaySoftwareUrl: url }, 'worker').RELAY_SOFTWARE_URL).toBe(url);
    expect(relaySiteVars({ relaySoftwareUrl: url }, 'node').RELAY_SOFTWARE_URL).toBe(url);
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'nope', `https://x.example/${'a'.repeat(200)}`]) {
      expect(() => relaySiteVars({ relaySoftwareUrl: bad }, 'worker'), bad).toThrow('relaySoftwareUrl');
    }
  });

  it('NIP-11 文件用它當 software', () => {
    expect(buildRelayInfo({ software: 'https://git.example.com/fork' }).software).toBe('https://git.example.com/fork');
  });
});
