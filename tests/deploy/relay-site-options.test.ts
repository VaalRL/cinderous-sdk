// 一鍵部署的站台參數（SDK ADR 0036、0037）：四條部署路徑（REST、wrangler、docker、fly）共用 relaySiteVars。
// 測：每個參數對到哪個環境變數、範圍與夾限、只有 Cloudflare 版支援的參數在 Node 主機上會丟例外、
// 產生的設定檔（wrangler.toml、compose、fly.toml）對自由文字有跳脫，以及中繼真的讀得懂部署寫進去的值。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deployCloudflareRelay, renderWranglerToml } from '../../src/deploy/cloudflare.js';
import { relayEnvironment } from '../../src/deploy/container.js';
import { deployDockerRelay, renderCompose } from '../../src/deploy/docker.js';
import { renderFlyToml } from '../../src/deploy/fly.js';
import {
  assertCompatibilityDate,
  laneListVar,
  RELAY_SITE_LIMITS,
  relaySiteVars,
  relayWorkerVars,
  sameLaneList,
} from '../../src/deploy/shared.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';
import {
  connectionsPerPubkeyFrom,
  fileLanes,
  filePolicyFor,
  knownLanes,
  messagesPerSecondPerIpFrom,
  powFrom,
  ttlSecondsFromDays,
} from '../../src/relay/host-config.js';
import { buildRelayInfo } from '../../src/relay/nip11.js';
import { LANE_ID_PATTERN, routeForPath } from '../../src/relay/shard.js';

const alice = getPublicKey(generateSecretKey());

describe('appLanes → APP_LANES（SDK ADR 0036）', () => {
  it('沒給就不設（ADR 0019：SDK 不替別人決定已知租戶）', () => {
    expect(relayWorkerVars({}).APP_LANES).toBeUndefined();
    expect(relayWorkerVars({ appLanes: [] }).APP_LANES).toBeUndefined();
  });

  it('給了就以逗號寫入；去重、保留順序、去掉前後空白', () => {
    expect(relayWorkerVars({ appLanes: ['dochost'] }).APP_LANES).toBe('dochost');
    expect(relayWorkerVars({ appLanes: [' dochost ', 'cindersync', 'dochost'] }).APP_LANES).toBe('dochost,cindersync');
  });

  it('🔴 沿用中繼的 LANE_ID 驗證：大寫、冒號、斜線、空字串、超過 64 字都在部署前擋下（不自動轉小寫）', () => {
    for (const bad of ['DocHost', 'doc:host', 'doc/host', '', '-dochost', '.x', 'a'.repeat(65), 'dö']) {
      expect(() => relayWorkerVars({ appLanes: [bad] }), bad).toThrow('車道 id');
    }
    for (const good of ['dochost', 'a', 'cinder-coffice', 'app.v2_beta', '0', 'a'.repeat(64)]) {
      expect(laneListVar('appLanes', [good])).toEqual([good]);
      expect(LANE_ID_PATTERN.test(good)).toBe(true);
    }
  });

  it('最多 32 條（每條一顆 DO）', () => {
    const lanes = Array.from({ length: RELAY_SITE_LIMITS.maxAppLanes + 1 }, (_, i) => `lane${i}`);
    expect(() => relayWorkerVars({ appLanes: lanes })).toThrow('最多 32 條');
    expect(relayWorkerVars({ appLanes: lanes.slice(0, 32) }).APP_LANES!.split(',')).toHaveLength(32);
  });

  it('🔴 中繼真的把它當已知租戶：/app/dochost 路由到自己的 DO，名單外的仍落公用分片', () => {
    const vars = relayWorkerVars({ appLanes: ['dochost'] });
    const lanes = knownLanes(vars.APP_LANES);
    expect(routeForPath('/app/dochost', lanes)).toMatchObject({ profile: 'app', known: true, laneId: 'dochost' });
    expect(routeForPath('/app/other', lanes)).toMatchObject({ profile: 'app', known: false });
    // NIP-11：已知租戶 64 個位址、30 天；公用車道 16 個、2 小時
    expect(buildRelayInfo({ profile: 'app', knownLane: true, maxTtlDays: vars.MAX_TTL_DAYS })).toMatchObject({
      cinder_addressable_per_author: 64,
      cinder_addressable_ttl_sec: 30 * 86_400,
    });
    expect(buildRelayInfo({ profile: 'app', knownLane: false })).toMatchObject({ cinder_addressable_per_author: 16 });
  });

  it('sameLaneList：順序、大小寫、空白不計（與中繼的 knownLanes 同一個正規化）', () => {
    expect(sameLaneList('dochost,cindersync', ' cindersync , dochost')).toBe(true);
    expect(sameLaneList(undefined, '')).toBe(true);
    expect(sameLaneList('dochost', undefined)).toBe(false);
    expect(sameLaneList('dochost', 'dochost,x')).toBe(false);
  });
});

describe('fileLanes → FILE_LANES（Cinderous ADR-0371）', () => {
  it('必須同時在 appLanes 上、而且要開 maxFileMb——中繼會默默忽略的設錯，部署端直接擋', () => {
    expect(() => relayWorkerVars({ allowedPubkeys: [alice], maxFileMb: 30, fileLanes: ['cindersync'] })).toThrow('同時在 appLanes 上');
    expect(() => relayWorkerVars({ appLanes: ['cindersync'], fileLanes: ['cindersync'] })).toThrow('需要 maxFileMb');
  });

  it('設對了：中繼只在那條車道收檔案，MAX_FILE_MB 變成單檔上限', () => {
    const vars = relayWorkerVars({ allowedPubkeys: [alice], appLanes: ['cindersync', 'dochost'], fileLanes: ['cindersync'], maxFileMb: 30 });
    expect(vars.FILE_LANES).toBe('cindersync');
    expect(fileLanes(vars)).toEqual({ active: new Set(['cindersync']), ignored: [] });
    expect(filePolicyFor(vars, 'cindersync')).toEqual({ accept: true, maxFileMb: 30 });
    expect(filePolicyFor(vars, 'dochost')).toEqual({ accept: false });
    expect(filePolicyFor(vars)).toEqual({ accept: false });
  });
});

describe('防濫用與保存期：可調，但不能關、不能無界', () => {
  it('預設仍是 PRD 3.3 的 5 與 20；不設 MAX_TTL_DAYS（中繼預設 7 天）', () => {
    const vars = relayWorkerVars({});
    expect(vars).toEqual({ MAX_CONNECTIONS_PER_PUBKEY: '5', MAX_MESSAGES_PER_SECOND_PER_IP: '20' });
  });

  it('給了就寫入，中繼讀得回同一個數字', () => {
    const vars = relayWorkerVars({ maxConnectionsPerPubkey: 10, maxMessagesPerSecondPerIp: 100, maxTtlDays: 30 });
    expect(connectionsPerPubkeyFrom(vars.MAX_CONNECTIONS_PER_PUBKEY)).toBe(10);
    expect(messagesPerSecondPerIpFrom(vars.MAX_MESSAGES_PER_SECOND_PER_IP)).toBe(100);
    expect(ttlSecondsFromDays(vars.MAX_TTL_DAYS)).toBe(30 * 86_400);
  });

  it('🔴 範圍外一律丟例外：0（等於關閉）、負數、小數、NaN、超過上限', () => {
    const cases: [string, Record<string, number>][] = [
      ['maxTtlDays', { min: 1, max: 365 }],
      ['maxConnectionsPerPubkey', { min: 1, max: 100 }],
      ['maxMessagesPerSecondPerIp', { min: 1, max: 1000 }],
    ];
    for (const [key, range] of cases) {
      for (const bad of [0, -1, 1.5, Number.NaN, range.max! + 1]) {
        expect(() => relayWorkerVars({ [key]: bad }), `${key}=${bad}`).toThrow(key);
      }
      expect(() => relayWorkerVars({ [key]: range.min! })).not.toThrow();
      expect(() => relayWorkerVars({ [key]: range.max! })).not.toThrow();
    }
  });

  it('appLanePow：0 不寫（＝不要求），1–32 寫入，超過或負數丟例外', () => {
    expect(relayWorkerVars({ appLanePow: 0 }).APP_LANE_POW).toBeUndefined();
    expect(powFrom(relayWorkerVars({ appLanePow: 16 }).APP_LANE_POW)).toBe(16);
    for (const bad of [-1, 33, 2.5]) expect(() => relayWorkerVars({ appLanePow: bad })).toThrow('appLanePow');
  });
});

describe('NIP-11 與文件網址', () => {
  it('站名／描述／聯絡／營運者公鑰／贊助管道：給了才寫；npub 轉 hex', () => {
    const vars = relayWorkerVars({
      relayName: '  My relay ',
      relayDescription: 'For "quotes" and \\ backslashes',
      relayContact: 'mailto:me@example.com',
      relayPubkey: npubEncode(alice),
      donations: { githubSponsors: 'https://github.com/sponsors/me', lightning: '' },
    });
    expect(vars).toMatchObject({
      RELAY_NAME: 'My relay',
      RELAY_DESCRIPTION: 'For "quotes" and \\ backslashes',
      RELAY_CONTACT: 'mailto:me@example.com',
      RELAY_PUBKEY: alice,
      DONATE_GITHUB_SPONSORS: 'https://github.com/sponsors/me',
    });
    expect(vars.DONATE_LIGHTNING).toBeUndefined();
    expect(Object.keys(relayWorkerVars({}))).not.toContain('RELAY_NAME');
  });

  it('🔴 換行與控制字元一律拒絕（這些值會進 TOML／YAML／NIP-11）；太長也拒絕', () => {
    expect(() => relayWorkerVars({ relayName: 'a\nb' })).toThrow('控制字元');
    expect(() => relayWorkerVars({ relayDescription: 'x\u0000' })).toThrow('控制字元');
    expect(() => relayWorkerVars({ relayName: 'x'.repeat(101) })).toThrow('最長 100');
    expect(() => relayWorkerVars({ donations: { liberapay: 'x'.repeat(201) } })).toThrow('最長 200');
  });

  it('relayPubkey 只能是一把合法公鑰', () => {
    expect(() => relayWorkerVars({ relayPubkey: 'nope' })).toThrow('relayPubkey');
    // 第二把一定要和第一把不同（alice 是隨機的：開頭剛好是 f 時，換成 f 會得到同一把而被去重）
    expect(() => relayWorkerVars({ relayPubkey: `${alice},${alice.replace(/^./, (c) => (c === 'f' ? 'e' : 'f'))}` })).toThrow('relayPubkey');
  });

  it('developerDocsUrl 必須是 https', () => {
    expect(relayWorkerVars({ developerDocsUrl: 'https://example.com/dev' }).DEVELOPER_DOCS_URL).toBe('https://example.com/dev');
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'not a url']) {
      expect(() => relayWorkerVars({ developerDocsUrl: bad }), bad).toThrow('https');
    }
  });

  it('compatibilityDate 必須是 YYYY-MM-DD', () => {
    expect(() => assertCompatibilityDate('2026-09-01')).not.toThrow();
    for (const bad of ['2026-9-1', '20260901', '2026-13-40x', '']) expect(() => assertCompatibilityDate(bad), bad).toThrow('YYYY-MM-DD');
  });
});

describe('四條路徑一致（SSOT）', () => {
  const site = { allowedPubkeys: [alice], relayName: 'Mine "relay"', maxTtlDays: 14, maxMessagesPerSecondPerIp: 50 };

  it('Node 主機（docker／fly）與 Worker 共用同一份：同樣的參數得到同樣的變數', () => {
    const worker = relayWorkerVars(site);
    const node = relayEnvironment({ ...site, persist: false, trustProxy: false });
    expect(node).toEqual(worker);
    expect(relaySiteVars(site, 'node')).toEqual(worker);
  });

  it('🔴 只有 Cloudflare 版支援的參數給 Node 主機會丟例外（沒有車道：設了卻不生效比失敗更難查）', () => {
    expect(() => relayEnvironment({ appLanes: ['dochost'], persist: false, trustProxy: false })).toThrow('appLanes 只有 Cloudflare');
    expect(() => relaySiteVars({ developerDocsUrl: 'https://x.example', appLanePow: 8 }, 'node')).toThrow('appLanePow、developerDocsUrl');
    expect(() => relaySiteVars({ appLanes: [] }, 'node')).not.toThrow();
  });

  it('wrangler.toml：自由文字以 JSON 字串寫成 TOML 基本字串（引號與反斜線跳脫）', () => {
    const toml = renderWranglerToml({ name: 'r', main: 'e.mjs', compatibilityDate: '2026-09-01', ...site, relayDescription: 'a\\b', appLanes: ['dochost'] });
    expect(toml).toContain('RELAY_NAME = "Mine \\"relay\\""');
    expect(toml).toContain('RELAY_DESCRIPTION = "a\\\\b"');
    expect(toml).toContain('APP_LANES = "dochost"');
    expect(toml).toContain('MAX_TTL_DAYS = "14"');
    expect(toml).toContain('MAX_MESSAGES_PER_SECOND_PER_IP = "50"');
  });

  it('compose 與 fly.toml 寫出同一份變數', () => {
    const environment = relayEnvironment({ ...site, persist: true, trustProxy: true });
    const compose = renderCompose({ name: 'r', port: 8080, environment });
    const fly = renderFlyToml({ name: 'r', region: 'nrt', environment, persist: true });
    for (const text of [compose, fly]) {
      expect(text).toContain('"Mine \\"relay\\""');
      expect(text).toContain('MAX_TTL_DAYS');
    }
  });

  it('wrangler 路徑：參數壞了就不寫檔、不跑 wrangler', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cinderous-site-'));
    try {
      let ran = false;
      const run = async () => {
        ran = true;
        return { code: 0, stdout: '', stderr: '' };
      };
      await expect(deployCloudflareRelay({ workDir, run, appLanes: ['Bad'], version: '0.0.0', sdkDistDir: workDir })).rejects.toThrow('車道 id');
      await expect(deployCloudflareRelay({ workDir, run, compatibilityDate: 'soon', version: '0.0.0', sdkDistDir: workDir })).rejects.toThrow('YYYY-MM-DD');
      expect(ran).toBe(false);
      await deployCloudflareRelay({ workDir, run, dryRun: true, appLanes: ['dochost'], version: '0.0.0', sdkDistDir: workDir });
      expect(readFileSync(join(workDir, 'wrangler.toml'), 'utf8')).toContain('APP_LANES = "dochost"');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('docker 路徑：給 appLanes 在寫任何檔案之前就丟例外', async () => {
    const workDir = join(tmpdir(), `cinderous-docker-${Date.now()}`);
    await expect(deployDockerRelay({ workDir, appLanes: ['dochost'], dryRun: true })).rejects.toThrow('只有 Cloudflare');
    expect(() => readFileSync(join(workDir, 'docker-compose.yml'))).toThrow();
  });
});

describe('容量設定（SDK ADR 0042；Cinderous ADR-0377 的 DO_CEILINGS_MIB）', () => {
  const lanes = { appLanes: ['dochost', 'lwd'] };
  it('寫成中繼讀的五個變數（對象依字母排序），中繼同一個解析器讀回來一項不漏', async () => {
    const vars = relaySiteVars(
      {
        ...lanes,
        doCeilings: { strict: { offlineMib: 24, addressableMib: 24 }, 'app:dochost': { offlineMib: 64, addressableMib: 512 } },
        doGuaranteeKib: { lane: 2048 },
        doBorrowPercent: { strict: 25, lane: 25 },
        doNearFullPercent: { lane: 80 },
        doDropNotices: ['strict', 'strict'],
      },
      'worker',
    );
    expect(vars.DO_CEILINGS_MIB).toBe('app:dochost=64/512,strict=24/24');
    expect(vars.DO_GUARANTEE_KIB).toBe('lane=2048');
    expect(vars.DO_BORROW_PERCENT).toBe('lane=25,strict=25');
    expect(vars.DO_NEAR_FULL_PERCENT).toBe('lane=80');
    expect(vars.DO_DROP_NOTICES).toBe('strict');
    const { doCapacitySettings } = await import('../../src/relay/host-config.js');
    expect(doCapacitySettings(vars).ignored).toEqual([]);
  });
  it('沒給＝不寫任何容量變數（中繼預設、v0.33 行為）', () => {
    const vars = relaySiteVars({}, 'worker');
    for (const k of ['DO_CEILINGS_MIB', 'DO_GUARANTEE_KIB', 'DO_BORROW_PERCENT', 'DO_NEAR_FULL_PERCENT', 'DO_DROP_NOTICES']) {
      expect(vars[k], k).toBeUndefined();
    }
  });
  it('範圍（一鍵部署比中繼緊）與對象都在部署前擋下', () => {
    expect(() => relaySiteVars({ doCeilings: { strict: { offlineMib: 0, addressableMib: 1 } } }, 'worker')).toThrow('1–8192');
    expect(() => relaySiteVars({ doBorrowPercent: { strict: 60 } }, 'worker')).toThrow('1–50');
    expect(() => relaySiteVars({ doGuaranteeKib: { lane: 32 } }, 'worker')).toThrow('64–16384');
    expect(() => relaySiteVars({ doCeilings: { 'app:nope': { offlineMib: 1, addressableMib: 1 } } }, 'worker')).toThrow('app:nope');
    expect(() => relaySiteVars({ doGuaranteeKib: { strict: 1024 } }, 'worker')).toThrow('淘汰制');
  });
  it('🔴 淘汰制設了溢位帶卻沒有保底（不會生效）：拒絕部署', () => {
    expect(() => relaySiteVars({ ...lanes, doBorrowPercent: { lane: 25 } }, 'worker')).toThrow('app:dochost');
    expect(() => relaySiteVars({ ...lanes, doBorrowPercent: { lane: 25 }, doGuaranteeKib: { lane: 2048 } }, 'worker')).not.toThrow();
  });
  it('storageBudgetBytes：最壞加總（含溢位帶）超過就拒絕部署；夠小就過', () => {
    expect(() => relaySiteVars({ storageBudgetBytes: 4_000_000_000 }, 'worker')).toThrow('超過預算');
    expect(() =>
      relaySiteVars({ storageBudgetBytes: 4_000_000_000, doCeilings: { strict: { offlineMib: 64, addressableMib: 64 }, public: { offlineMib: 16, addressableMib: 16 } } }, 'worker'),
    ).not.toThrow();
  });
  it('帳號儲存預算只有 Cloudflare 版', () => {
    expect(() => relaySiteVars({ storageBudgetBytes: 1 }, 'node')).toThrow('只有 Cloudflare');
  });
});

describe('Node 主機的容量設定（SDK ADR 0099）', () => {
  it('🔴 strict 的天花板、預警、丟棄計數寫成與 Cloudflare 版同名的變數；上限放寬到 1 TiB', () => {
    const vars = relaySiteVars(
      { doCeilings: { strict: { offlineMib: 20_000, addressableMib: 512 } }, doNearFullPercent: { strict: 80 }, doDropNotices: ['strict'] },
      'node',
    );
    expect(vars).toMatchObject({ DO_CEILINGS_MIB: 'strict=20000/512', DO_NEAR_FULL_PERCENT: 'strict=80', DO_DROP_NOTICES: 'strict' });
    expect(vars.CEILING_MODE).toBeUndefined();
    expect(() => relaySiteVars({ doCeilings: { strict: { offlineMib: 20_000, addressableMib: 512 } } }, 'worker')).toThrow();
  });

  it('ceilingMode：evict 寫成 CEILING_MODE；保底要 evict 才能設', () => {
    expect(relaySiteVars({ ceilingMode: 'evict', doGuaranteeKib: { strict: 1024 } }, 'node')).toMatchObject({
      CEILING_MODE: 'evict',
      DO_GUARANTEE_KIB: 'strict=1024',
    });
    expect(() => relaySiteVars({ doGuaranteeKib: { strict: 1024 } }, 'node')).toThrow('ceilingMode');
  });

  it('🔴 Node 主機沒有車道與分片：strict 以外的對象拒絕部署', () => {
    expect(() => relaySiteVars({ doCeilings: { lane: { offlineMib: 10, addressableMib: 10 } } }, 'node')).toThrow('只能是 strict');
  });

  it('evict 模式的溢位帶要同時有保底（與 Cloudflare 版相同）', () => {
    expect(() => relaySiteVars({ ceilingMode: 'evict', doBorrowPercent: { strict: 20 } }, 'node')).toThrow('doGuaranteeKib');
    // 拒收制的溢位帶本來就有作用
    expect(relaySiteVars({ doBorrowPercent: { strict: 20 } }, 'node').DO_BORROW_PERCENT).toBe('strict=20');
  });

  it('同時連線數（SDK ADR 0100）：寫成 MAX_CONNECTIONS／MAX_CONNECTIONS_PER_IP；只有 Node 主機；範圍外拒絕', () => {
    expect(relaySiteVars({ maxConnections: 2000, maxConnectionsPerIp: 20 }, 'node')).toMatchObject({
      MAX_CONNECTIONS: '2000',
      MAX_CONNECTIONS_PER_IP: '20',
    });
    expect(relaySiteVars({}, 'node').MAX_CONNECTIONS).toBeUndefined();
    expect(() => relaySiteVars({ maxConnections: 2000 }, 'worker')).toThrow('只有 Node 主機');
    expect(() => relaySiteVars({ maxConnectionsPerIp: 0 }, 'node')).toThrow();
  });

  it('每月流量預算（SDK ADR 0101）：四個變數；附屬項目沒有預算就擋；只有 Node 主機', () => {
    expect(
      relaySiteVars({ monthlyTrafficGib: 900, trafficResetDay: 15, trafficCount: 'out', trafficNearFullPercent: 90 }, 'node'),
    ).toMatchObject({ MONTHLY_TRAFFIC_GIB: '900', TRAFFIC_RESET_DAY: '15', TRAFFIC_COUNT: 'out', TRAFFIC_NEAR_FULL_PERCENT: '90' });
    expect(relaySiteVars({ monthlyTrafficGib: 900 }, 'node').TRAFFIC_COUNT).toBeUndefined();
    expect(() => relaySiteVars({ trafficResetDay: 15 }, 'node')).toThrow('monthlyTrafficGib');
    expect(() => relaySiteVars({ monthlyTrafficGib: 900, trafficResetDay: 31 }, 'node')).toThrow();
    expect(() => relaySiteVars({ monthlyTrafficGib: 900 }, 'worker')).toThrow('只有 Node 主機');
  });

  it('ceilingMode 只有 Node 主機；值只能是 reject／evict', () => {
    expect(() => relaySiteVars({ ceilingMode: 'evict' }, 'worker')).toThrow('只有 Node 主機');
    expect(() => relaySiteVars({ ceilingMode: 'drop' as 'evict' }, 'node')).toThrow('reject 或 evict');
  });
});
