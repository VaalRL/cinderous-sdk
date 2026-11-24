// 網頁部署設定器的模型（SDK ADR 0142）：題目、驗證、危險選項確認都與 `cinderous init` 精靈同一份規則；
// 產出的設定檔與部署包與 `relay build --sdk-spec` 相同；不收秘密值；成本試算只在本機算。
import { describe, expect, it } from 'vitest';

import {
  dangerConfirmWord,
  deployOptionSpec,
  type DeployConfig,
  type DeployOptionSpec,
  renderDeployConfigFile,
  renderDeployPackage,
  validateDeployConfig,
  WEB_GROUP_LABELS,
  webBuildCommand,
  webEstimate,
  webFieldKind,
  webFieldText,
  webFormGroups,
  webInitialConfig,
  webOutputs,
  webSdkSpec,
  webSwitchTarget,
  webUnsupportedFields,
  setWebField,
  wizardQuestions,
} from '../../src/deploy/config/index.js';
import { crc32 } from '../../src/deploy/zip.js';

const V = '0.91.0';
const ALICE = 'a'.repeat(63) + '1';
const LICENSE = 'GNU AFFERO GENERAL PUBLIC LICENSE\n';
const spec = (path: string): DeployOptionSpec => deployOptionSpec(path)!;

function apply(config: Record<string, unknown>, path: string, raw: string, confirm?: string): Record<string, unknown> {
  const r = setWebField(config, spec(path), raw, confirm);
  if (!r.ok) throw new Error(`${path}: ${r.message.en}`);
  return r.config;
}

describe('題目：與 init 精靈同一份描述表', () => {
  it('每個目標的欄位＝精靈的題目（含進階），依題組分好、題組都有中英標籤', () => {
    for (const target of ['cloudflare', 'cloudflare-api', 'docker', 'fly', 'home-tunnel'] as const) {
      for (const advanced of [false, true]) {
        const groups = webFormGroups(target, advanced);
        const fields = groups.flatMap((g) => g.fields.map((f) => f.spec.path));
        expect(fields.sort()).toEqual(wizardQuestions(target, advanced).map((s) => s.path).sort());
        for (const g of groups) {
          expect(g.fields.length).toBeGreaterThan(0);
          expect(WEB_GROUP_LABELS[g.group]['zh-TW']).not.toBe('');
          expect(WEB_GROUP_LABELS[g.group].en).not.toBe('');
          expect(g.advanced).toBe(!['basic', 'access', 'vault'].includes(g.group));
        }
      }
    }
  });

  it('精靈不問、網頁也不給的欄位（物件型別）照實列出，指向直接改設定檔', () => {
    const unsupported = webUnsupportedFields('cloudflare');
    expect(unsupported.length).toBeGreaterThan(0);
    for (const s of unsupported) expect(s.type).toBe('record');
  });

  it('欄位元件：布林＝勾選、列舉＝下拉、整數＝數字、秘密＝只收環境變數名稱', () => {
    expect(webFieldKind(spec('target'))).toBe('select');
    expect(webFieldKind(spec('site.openFileRelay'))).toBe('checkbox');
    expect(webFieldKind(spec('site.maxTtlDays'))).toBe('number');
    expect(webFieldKind(spec('site.allowedPubkeys'))).toBe('list');
    const secret = wizardQuestions('cloudflare', true).find((s) => s.type === 'secret-ref')!;
    expect(webFieldKind(secret)).toBe('env-name');
  });
});

describe('填欄位：解析、當場驗證、危險選項確認', () => {
  it('初始設定只有格式版號、SDK 版號與目標', () => {
    expect(webInitialConfig('docker', V)).toEqual({ configVersion: 1, sdk: V, target: 'docker' });
  });

  it('看不懂的值與只跟這一欄有關的錯誤：不改設定、回中英訊息', () => {
    const base = webInitialConfig('docker', V);
    const notInt = setWebField(base, spec('site.maxTtlDays'), 'abc');
    expect(notInt.ok).toBe(false);
    const outOfRange = setWebField(base, spec('site.maxTtlDays'), '999999');
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.message['zh-TW']).not.toBe('');
  });

  it('空字串＝拿掉這一欄（回到預設），不留空物件', () => {
    const c = apply(webInitialConfig('docker', V), 'site.maxTtlDays', '30');
    expect((c.site as Record<string, unknown>).maxTtlDays).toBe(30);
    expect(apply(c, 'site.maxTtlDays', '').site).toBeUndefined();
  });

  it('🔴 危險選項：沒打對確認字就不開，回傳要打的字；打對才開', () => {
    const base = apply(webInitialConfig('cloudflare', V), 'site.allowedPubkeys', ALICE);
    const s = spec('site.openFileRelay');
    const refused = setWebField(base, s, 'true');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.confirmWord).toBe(dangerConfirmWord(s));
    expect(setWebField(base, s, 'true', 'wrong').ok).toBe(false);
    const ok = setWebField(base, s, 'true', dangerConfirmWord(s));
    expect(ok.ok).toBe(true);
    // 關掉危險選項不用確認
    if (ok.ok) expect(setWebField(ok.config, s, 'false').ok).toBe(true);
  });

  it('🔴 秘密欄位只收環境變數名稱，存成 { $env }；不會把值寫進設定檔', () => {
    const secret = wizardQuestions('cloudflare', true).find((s) => s.type === 'secret-ref')!;
    const r = setWebField(webInitialConfig('cloudflare', V), secret, 'MY_SECRET_ENV');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.config)).toContain('{"$env":"MY_SECRET_ENV"}');
  });

  it('換部署目標：新目標也有的欄位保留（實測時填好的名稱被清掉），沒有的才丟、並回報丟了哪些', () => {
    let c = apply(webInitialConfig('cloudflare', V), 'name', 'keep-me');
    c = apply(c, 'site.allowedPubkeys', ALICE);
    const workerOnly = wizardQuestions('cloudflare', true).find(
      (s) => s.type !== 'record' && !wizardQuestions('docker', true).some((d) => d.path === s.path),
    );
    if (workerOnly && workerOnly.type === 'boolean' && workerOnly.dangerous !== true) c = apply(c, workerOnly.path, 'true');
    const moved = webSwitchTarget(c, 'docker', {});
    expect(moved.config.target).toBe('docker');
    expect(moved.config.name).toBe('keep-me');
    expect((moved.config.site as Record<string, unknown>).allowedPubkeys).toEqual([ALICE]);
    if (workerOnly && workerOnly.type === 'boolean' && workerOnly.dangerous !== true) expect(moved.dropped).toContain(workerOnly.path);
    // 設定檔自己的欄位（格式版號、SDK 版號、目標）不是使用者填的，不能列成「拿掉了」（實測頁面上出現 configVersion、sdk）
    for (const own of ['configVersion', 'sdk', 'target']) expect(moved.dropped).not.toContain(own);
    expect(moved.config.configVersion).toBe(1);
    expect(moved.config.sdk).toBe(V);
    // 只填共用欄位、換目標：什麼都沒拿掉
    expect(webSwitchTarget(apply(webInitialConfig('cloudflare', V), 'name', 'keep-me'), 'docker', {}).dropped).toEqual([]);
  });

  it('🔴 換目標時危險選項要已確認過才帶過去，不能藉換目標繞過確認', () => {
    const s = spec('site.openFileRelay');
    const base = apply(webInitialConfig('cloudflare', V), 'site.allowedPubkeys', ALICE);
    const r = setWebField(base, s, 'true', dangerConfirmWord(s));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const confirmed = webSwitchTarget(r.config, 'docker', { [s.path]: dangerConfirmWord(s) });
    expect((confirmed.config.site as Record<string, unknown>).openFileRelay).toBe(true);
    const unconfirmed = webSwitchTarget(r.config, 'docker', {});
    expect((unconfirmed.config.site as Record<string, unknown> | undefined)?.openFileRelay).toBeUndefined();
    expect(unconfirmed.dropped).toContain(s.path);
  });

  it('欄位的顯示文字：清單以逗號分隔、$env 顯示名稱、沒設＝空字串', () => {
    const c = apply(webInitialConfig('cloudflare', V), 'site.allowedPubkeys', `${ALICE}, ${'b'.repeat(64)}`);
    expect(webFieldText(c, spec('site.allowedPubkeys'))).toBe(`${ALICE}, ${'b'.repeat(64)}`);
    expect(webFieldText(c, spec('site.maxTtlDays'))).toBe('');
  });
});

describe('產出：設定檔、zip 部署包、一行指令', () => {
  const config = apply(apply(webInitialConfig('docker', V), 'name', 'my-relay'), 'site.allowedPubkeys', ALICE) as unknown as DeployConfig;

  it('設定檔＝relay build 寫的那份；部署包＝relay build --sdk-spec github:…#v版號 的檔案', () => {
    const out = webOutputs(config, { sdkVersion: V, licenseText: LICENSE });
    expect(out.configText).toBe(renderDeployConfigFile(config, V));
    const expected = renderDeployPackage(config, { sdkVersion: V, licenseText: LICENSE, sdkSource: { kind: 'spec', spec: webSdkSpec(V) } });
    expect(out.files.map((f) => [f.path, f.content])).toEqual(expected.files.map((f) => [f.path, f.content]));
    expect(out.zipName).toBe('my-relay.zip');
    expect(webSdkSpec(V)).toBe(`github:VaalRL/cinderous-sdk#v${V}`);
  });

  it('zip 的每個檔案都在名稱資料夾底下、CRC 正確', () => {
    const out = webOutputs(config, { sdkVersion: V, licenseText: LICENSE, date: new Date(Date.UTC(2026, 10, 18)) });
    const view = new DataView(out.zip.buffer, out.zip.byteOffset, out.zip.byteLength);
    const eocd = out.zip.length - 22;
    expect(view.getUint16(eocd + 10, true)).toBe(out.files.length);
    const first = out.files[0]!;
    const nameLen = view.getUint16(26, true);
    expect(new TextDecoder().decode(out.zip.subarray(30, 30 + nameLen))).toBe(`my-relay/${first.path}`);
    expect(view.getUint32(14, true)).toBe(crc32(new TextEncoder().encode(first.content)));
  });

  it('設定還有錯誤時不產出（丟錯，列出全部錯誤）', () => {
    const bad = { ...config, site: { maxTtlDays: -1 } } as unknown as DeployConfig;
    expect(validateDeployConfig(bad).issues.some((i) => i.severity === 'error')).toBe(true);
    expect(() => webOutputs(bad, { sdkVersion: V, licenseText: LICENSE })).toThrow();
  });

  it('Workers 可選自帶中繼（self-contained）：需要預打包的中繼原始碼', () => {
    const cf = apply(webInitialConfig('cloudflare', V), 'site.allowedPubkeys', ALICE) as unknown as DeployConfig;
    expect(() => webOutputs(cf, { sdkVersion: V, licenseText: LICENSE, selfContained: true })).toThrow();
    const out = webOutputs(cf, { sdkVersion: V, licenseText: LICENSE, selfContained: true, relayWorkerSource: 'export default {};' });
    expect(out.files.some((f) => f.path === 'src/relay.mjs')).toBe(true);
  });

  it('一行指令：以 github tag 執行 CLI，產生同一份部署包', () => {
    expect(webBuildCommand(V)).toBe(
      `npx --yes github:VaalRL/cinderous-sdk#v${V} relay build --config cinderous.config.json --out deploy --sdk-spec github:VaalRL/cinderous-sdk#v${V}`,
    );
    expect(webBuildCommand(V, { selfContained: true })).toBe(
      `npx --yes github:VaalRL/cinderous-sdk#v${V} relay build --config cinderous.config.json --out deploy --self-contained`,
    );
  });
});

describe('成本試算（只在本機算）', () => {
  const input = { devicesCount: 2, collaboratorsCount: 3, dailyActionsCount: 200, averagePayloadBytes: 2_000 };

  it('Workers 目標用 serverless 級距，其他用自架級距', () => {
    expect(webEstimate('cloudflare', input).tier).toBe('tier-2-serverless');
    expect(webEstimate('cloudflare-api', input).tier).toBe('tier-2-serverless');
    for (const t of ['docker', 'fly', 'home-tunnel'] as const) expect(webEstimate(t, input).tier).toBe('tier-1-selfhosted');
  });

  it('回傳試算報告；輸入不合法回錯誤而不是丟例外（表單一邊打一邊算）', () => {
    const ok = webEstimate('cloudflare', input);
    expect(ok.report?.infrastructure.cloudflareDailyRequests).toBeGreaterThan(0);
    const bad = webEstimate('cloudflare', { ...input, devicesCount: 0 });
    expect(bad.report).toBeUndefined();
    expect(bad.error).toBeTruthy();
  });
});
