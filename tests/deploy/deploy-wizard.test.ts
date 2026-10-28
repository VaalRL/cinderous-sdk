// `cinderous init` 精靈（SDK ADR 0117）：題目從描述表推出、當場重問、跨欄位錯誤回頭重問、危險選項打字確認；
// 部署說明的安全檢查清單列出每個開了的危險選項。
import { describe, expect, it } from 'vitest';

import {
  dangerConfirmWord,
  dangerousChoices,
  DEPLOY_OPTION_SPECS,
  type DeployConfig,
  deployOptionSpec,
  isDangerousValue,
  parseWizardAnswer,
  renderDeployGuide,
  runInitWizard,
  type WizardIo,
  WIZARD_MAX_TRIES,
  wizardQuestions,
} from '../../src/deploy/config/index.js';

const ALICE = 'a'.repeat(63) + '1';

/** 依欄位回答：問題開頭是欄位路徑；危險選項的確認題另外排隊。沒排到的題目一律 Enter。 */
function scripted(answers: Record<string, string[]>, confirms: string[] = []) {
  const asked: string[] = [];
  const said: string[] = [];
  const io: WizardIo = {
    ask: async (question) => {
      asked.push(question);
      if (question.startsWith('要開的話') || question.startsWith('Type "')) return confirms.shift() ?? '';
      const path = question.split(/[（(]/)[0]!;
      return answers[path]?.shift() ?? '';
    },
    say: (line) => said.push(line),
  };
  return { io, asked, said, paths: () => asked.map((q) => q.split(/[（(]/)[0]) };
}

const spec = (path: string) => deployOptionSpec(path)!;

describe('wizardQuestions：題目從描述表推出', () => {
  it('不進進階：只問基本、存取、Vault 同步與這個目標的必填；不問版號、目標、服務與物件型別', () => {
    const paths = wizardQuestions('cloudflare').map((s) => s.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'site.allowedPubkeys', 'site.maxFileMb', 'site.openFileRelay']));
    for (const no of ['configVersion', 'sdk', 'target', 'service', 'site.appLanes', 'site.maxTtlDays', 'node.persist', 'pushGateway.ios', 'site.donations']) {
      expect(paths).not.toContain(no);
    }
  });

  it('必填欄位一定會問（home-tunnel 的 tunnel.hostname 與 Tunnel Token）', () => {
    const paths = wizardQuestions('home-tunnel').map((s) => s.path);
    expect(paths).toEqual(expect.arrayContaining(['tunnel.hostname', 'secrets.tunnelToken']));
  });

  it('進階：其他題組也問，但只問適用這個目標與宿主的；物件型別仍然不問', () => {
    const cloudflare = wizardQuestions('cloudflare', true).map((s) => s.path);
    expect(cloudflare).toEqual(expect.arrayContaining(['site.appLanes', 'site.appLanePow', 'site.maxTtlDays', 'cloudflare.accountId']));
    expect(cloudflare).not.toContain('node.persist');
    expect(cloudflare).not.toContain('site.maxConnections');
    expect(cloudflare).not.toContain('site.doCeilings');
    const docker = wizardQuestions('docker', true).map((s) => s.path);
    expect(docker).toEqual(expect.arrayContaining(['node.persist', 'node.trustProxy', 'site.maxConnections']));
    expect(docker).not.toContain('site.appLanes');
  });
});

describe('parseWizardAnswer', () => {
  it('Enter＝不設；布林接受 y／n／是／否', () => {
    expect(parseWizardAnswer(spec('site.openFileRelay'), '  ')).toEqual({ ok: true, value: undefined });
    expect(parseWizardAnswer(spec('site.openFileRelay'), 'Y')).toEqual({ ok: true, value: true });
    expect(parseWizardAnswer(spec('site.openFileRelay'), '否')).toEqual({ ok: true, value: false });
    expect(parseWizardAnswer(spec('site.openFileRelay'), 'maybe').ok).toBe(false);
  });

  it('整數、列舉、清單（半形或全形逗號、空白）', () => {
    expect(parseWizardAnswer(spec('site.maxFileMb'), '17')).toEqual({ ok: true, value: 17 });
    expect(parseWizardAnswer(spec('site.maxFileMb'), '17.5').ok).toBe(false);
    expect(parseWizardAnswer(spec('target'), 'fly')).toEqual({ ok: true, value: 'fly' });
    expect(parseWizardAnswer(spec('target'), 'heroku').ok).toBe(false);
    expect(parseWizardAnswer(spec('site.allowedPubkeys'), 'a, b，c  d')).toEqual({ ok: true, value: ['a', 'b', 'c', 'd'] });
  });

  it('🔴 秘密只收環境變數名稱；可以是秘密的欄位用 $env:NAME', () => {
    expect(parseWizardAnswer(spec('secrets.tunnelToken'), 'MY_TUNNEL')).toEqual({ ok: true, value: { $env: 'MY_TUNNEL' } });
    expect(parseWizardAnswer(spec('cloudflare.accountId'), '$env:CF_ACCOUNT')).toEqual({ ok: true, value: { $env: 'CF_ACCOUNT' } });
    expect(parseWizardAnswer(spec('cloudflare.accountId'), '0123456789abcdef0123456789abcdef')).toEqual({ ok: true, value: '0123456789abcdef0123456789abcdef' });
  });
});

describe('危險選項', () => {
  it('描述表裡標了 dangerous 的就是這四個', () => {
    expect(DEPLOY_OPTION_SPECS.filter((s) => s.dangerous).map((s) => s.path)).toEqual(['node.trustProxy', 'site.openFileRelay', 'site.appLanes', 'site.appLanePow']);
  });

  it('開了才算：布林 true、數字大於預設、清單不是空的；fly 與 home-tunnel 強制開 trustProxy 不算', () => {
    expect(isDangerousValue(spec('site.openFileRelay'), true, 'cloudflare')).toBe(true);
    expect(isDangerousValue(spec('site.openFileRelay'), false, 'cloudflare')).toBe(false);
    expect(isDangerousValue(spec('site.appLanePow'), 0, 'cloudflare')).toBe(false);
    expect(isDangerousValue(spec('site.appLanePow'), 8, 'cloudflare')).toBe(true);
    expect(isDangerousValue(spec('site.appLanes'), [], 'cloudflare')).toBe(false);
    expect(isDangerousValue(spec('site.appLanes'), ['dochost'], 'cloudflare')).toBe(true);
    expect(isDangerousValue(spec('node.trustProxy'), true, 'docker')).toBe(true);
    expect(isDangerousValue(spec('node.trustProxy'), true, 'fly')).toBe(false);
    expect(isDangerousValue(spec('node.trustProxy'), true, 'home-tunnel')).toBe(false);
    expect(isDangerousValue(spec('site.maxFileMb'), 17, 'cloudflare')).toBe(false);
  });

  it('dangerousChoices 從設定裡找出開了的；確認字是欄位名稱的最後一段', () => {
    const config: DeployConfig = { configVersion: 1, target: 'cloudflare', site: { appLanes: ['dochost'], appLanePow: 0, openFileRelay: false } };
    expect(dangerousChoices(config).map((s) => s.path)).toEqual(['site.appLanes']);
    expect(dangerConfirmWord(spec('site.openFileRelay'))).toBe('openFileRelay');
    expect(dangerConfirmWord(spec('node.trustProxy'))).toBe('trustProxy');
  });
});

describe('runInitWizard', () => {
  it('全部 Enter：只有格式版號、SDK 版號與目標；開放中繼的提醒留在 issues', async () => {
    const { io } = scripted({});
    const { config, issues } = await runInitWizard(io, { target: 'cloudflare', sdkVersion: '0.0.0-test' });
    expect(config).toEqual({ configVersion: 1, sdk: '0.0.0-test', target: 'cloudflare' });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.map((i) => i.path)).toContain('site.allowedPubkeys');
  });

  it('沒給目標就先問；不認得的目標當場重問', async () => {
    const { io, paths } = scripted({ target: ['heroku', 'docker'], 'site.allowedPubkeys': [ALICE] });
    const { config } = await runInitWizard(io);
    expect(config.target).toBe('docker');
    expect(config.site?.allowedPubkeys).toEqual([ALICE]);
    expect(paths().slice(0, 2)).toEqual(['target', 'target']);
  });

  it('只跟這一題有關的錯誤當場重問（壞的公鑰）', async () => {
    const { io, said } = scripted({ 'site.allowedPubkeys': ['npub1a', ALICE] });
    const { config } = await runInitWizard(io, { target: 'cloudflare' });
    expect(config.site?.allowedPubkeys).toEqual([ALICE]);
    expect(said.some((line) => line.startsWith('✖') && line.includes('npub1a'))).toBe(true);
  });

  it(`同一題錯 ${WIZARD_MAX_TRIES} 次就停止（不互動模式的必填題不會無限重問）`, async () => {
    const { io } = scripted({});
    await expect(runInitWizard(io, { target: 'home-tunnel' })).rejects.toThrow(/tunnel\.hostname/);
  });

  it('🔴 危險選項要打確認字才開；跨欄位的提醒等後面的題目解決', async () => {
    const { io, said } = scripted({ 'site.maxFileMb': ['17'], 'site.openFileRelay': ['y'] }, ['openFileRelay']);
    const { config, issues } = await runInitWizard(io, { target: 'cloudflare' });
    expect(config.site).toEqual({ maxFileMb: 17, openFileRelay: true });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(said.some((line) => line.startsWith('🔴 site.openFileRelay'))).toBe(true);
    expect(said.some((line) => line.startsWith('⚠') && line.includes('後面的題目'))).toBe(true);
  });

  it('🔴 確認字打錯＝不開；留下的跨欄位錯誤回頭重問那一題', async () => {
    const { io, paths } = scripted({ 'site.maxFileMb': ['17', ''], 'site.openFileRelay': ['y'] }, ['yes']);
    const { config, issues } = await runInitWizard(io, { target: 'cloudflare' });
    expect(config.site).toBeUndefined();
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(paths().filter((p) => p === 'site.maxFileMb')).toHaveLength(2);
  });

  it('進階題組的危險選項同樣要確認（appLanes）', async () => {
    const { io } = scripted({ 'site.allowedPubkeys': [ALICE], 'site.appLanes': ['dochost'] }, ['appLanes']);
    const { config } = await runInitWizard(io, { target: 'cloudflare', advanced: true });
    expect(config.site?.appLanes).toEqual(['dochost']);
  });

  it('英文：題目與說明都是英文', async () => {
    const { io, asked, said } = scripted({ 'site.openFileRelay': ['y'] }, ['no']);
    await runInitWizard(io, { target: 'cloudflare', locale: 'en' });
    expect(said[0]).toMatch(/^Creating cinderous\.config\.json/);
    expect(said).toContain(`site.openFileRelay：${spec('site.openFileRelay').description.en}`);
    expect(asked.some((q) => q.startsWith('Type "openFileRelay"'))).toBe(true);
    expect(said).toContain('site.openFileRelay left off.');
  });
});

describe('部署說明的安全檢查清單（SDK ADR 0117）', () => {
  const ctx = { sdkVersion: '0.0.0-test' };
  const checklist = (config: DeployConfig, locale: 'zh-TW' | 'en' = 'zh-TW') => {
    const guide = renderDeployGuide(config, locale, ctx);
    const start = guide.indexOf(locale === 'zh-TW' ? '## 9. 安全檢查清單' : '## 9. Security checklist');
    return guide.slice(start, guide.indexOf('## 10.', start));
  };

  it('每個開了的危險選項都列出來，說明用描述表的', () => {
    const config: DeployConfig = {
      configVersion: 1,
      target: 'cloudflare',
      site: { allowedPubkeys: [ALICE], maxFileMb: 17, openFileRelay: true, appLanes: ['dochost'], appLanePow: 8 },
    };
    const zh = checklist(config);
    const en = checklist(config, 'en');
    for (const path of ['site.openFileRelay', 'site.appLanes', 'site.appLanePow']) {
      expect(zh).toContain(`- [ ] 🔴 \`${path}\`：${spec(path).description['zh-TW']}`);
      expect(en).toContain(`- [ ] 🔴 \`${path}\`: ${spec(path).description.en}`);
    }
  });

  it('docker 開了 trustProxy 才列；fly 一定開，不列', () => {
    expect(checklist({ configVersion: 1, target: 'docker', site: { allowedPubkeys: [ALICE] }, node: { trustProxy: true } })).toContain('`node.trustProxy`');
    expect(checklist({ configVersion: 1, target: 'docker', site: { allowedPubkeys: [ALICE] } })).not.toContain('`node.trustProxy`');
    expect(checklist({ configVersion: 1, target: 'fly', site: { allowedPubkeys: [ALICE] }, node: { trustProxy: true } })).not.toContain('`node.trustProxy`');
  });

  it('沒開危險選項：清單裡沒有危險選項那一類的項目', () => {
    expect(checklist({ configVersion: 1, target: 'cloudflare', site: { allowedPubkeys: [ALICE], appLanePow: 0 } })).not.toMatch(/🔴 `site\./);
  });
});
