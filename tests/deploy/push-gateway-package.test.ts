// 部署設定器的推播閘道（SDK ADR 0050；ADR 0049 §11.1 裁示 5、7）：`service: 'push-gateway'` 的驗證、部署包與中英部署說明。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli, type CliDeps } from '../../src/cli/commands.js';
import { buildRelayPackage } from '../../src/deploy/build.js';
import { type DeployConfig, type DeployPackageContext, renderDeployPackage, validateDeployConfig } from '../../src/deploy/config/index.js';

const ctx: DeployPackageContext = { sdkVersion: '0.40.0', licenseText: 'AGPL-3.0 LICENSE TEXT\n' };
const files = (config: DeployConfig, c: DeployPackageContext = ctx) => Object.fromEntries(renderDeployPackage(config, c).files.map((f) => [f.path, f.content]));
const errors = (config: unknown) => validateDeployConfig(config).issues.filter((i) => i.severity === 'error').map((i) => `${i.path}:${i.code}`);
const warnings = (config: unknown) => validateDeployConfig(config).issues.filter((i) => i.severity === 'warning').map((i) => `${i.path}:${i.code}`);

/** Workers 版、iOS 明寫經 FCM（v0.48.0 起已棄用但仍可用；SDK ADR 0062） */
const WORKERS: DeployConfig = {
  configVersion: 1,
  target: 'cloudflare',
  service: 'push-gateway',
  name: 'my-push',
  cloudflare: { workersDevSubdomain: 'me' },
  pushGateway: { tokenPerHour: 120, iosLocKey: 'HOME_ALERT', ios: 'fcm' },
};
/** Workers 版直連 APNs（SDK ADR 0061）：Android 關掉時完全不需要 Firebase */
const WORKERS_APNS: DeployConfig = {
  configVersion: 1,
  target: 'cloudflare',
  service: 'push-gateway',
  name: 'my-push',
  cloudflare: { workersDevSubdomain: 'me' },
  pushGateway: { android: false, ios: 'apns', apnsTopic: 'com.example.cinder', apnsKeyId: 'ABC123DEFG', apnsTeamId: 'TEAM123456', apnsEnvironment: 'sandbox' },
};
const NODE_APNS: DeployConfig = {
  configVersion: 1,
  target: 'docker',
  service: 'push-gateway',
  name: 'push',
  node: { port: 9443 },
  pushGateway: { ios: 'apns', apnsTopic: 'com.example.cinder', apnsKeyId: 'ABC123DEFG', apnsTeamId: 'TEAM123456', apnsEnvironment: 'sandbox' },
  secrets: { pushGatewayKey: { $env: 'MY_PUSH_KEY' } },
};

describe('驗證', () => {
  it('合法的 Workers 與 Node 設定沒有錯；沒寫 service 仍是中繼（行為不變）', () => {
    expect(errors(WORKERS)).toEqual([]);
    expect(errors(NODE_APNS)).toEqual([]);
    expect(validateDeployConfig({ configVersion: 1, target: 'docker', site: { allowedPubkeys: ['a'.repeat(64)] } }).ok).toBe(true);
  });

  it('Workers 版也能直連 APNs（SDK ADR 0061）；不支援 cloudflare-api；直連 APNs 要 bundle id、Key ID、Team ID', () => {
    expect(errors(WORKERS_APNS)).toEqual([]);
    expect(warnings(WORKERS_APNS)).toEqual([]);
    expect(errors({ ...WORKERS, pushGateway: { ios: 'apns' } })).toEqual(['pushGateway.apnsTopic:required', 'pushGateway.apnsKeyId:required', 'pushGateway.apnsTeamId:required']);
    expect(errors({ ...WORKERS, target: 'cloudflare-api' })).toContain('target:push-gateway-target');
    expect(errors({ ...NODE_APNS, pushGateway: { ios: 'apns' } })).toEqual(['pushGateway.apnsTopic:required', 'pushGateway.apnsKeyId:required', 'pushGateway.apnsTeamId:required']);
    expect(errors({ ...NODE_APNS, pushGateway: { android: false, ios: 'off' } })).toContain('pushGateway:push-nothing');
  });

  it('iOS 明寫 fcm：兩版都照常可用，但給同一個棄用警告（SDK ADR 0062）；apns、off 不警告', () => {
    const NODE_FCM = { configVersion: 1, target: 'docker', service: 'push-gateway', pushGateway: { ios: 'fcm' } };
    for (const config of [WORKERS, NODE_FCM]) {
      expect(errors(config)).toEqual([]);
      expect(warnings(config)).toContain('pushGateway.ios:push-ios-fcm-deprecated');
      const issue = validateDeployConfig(config).issues.find((i) => i.code === 'push-ios-fcm-deprecated')!;
      expect(issue.message['zh-TW']).toContain('pushGateway.ios: "apns"');
      expect(issue.message['zh-TW']).toContain('"off"');
      expect(issue.message['zh-TW']).not.toContain('Workers 版的 iOS');
      expect(issue.message.en).toContain('deprecated');
    }
    for (const config of [WORKERS_APNS, NODE_APNS, { ...WORKERS, pushGateway: { ios: 'off' } }, { ...NODE_APNS, pushGateway: { ios: 'off' } }]) {
      expect(warnings(config)).not.toContain('pushGateway.ios:push-ios-fcm-deprecated');
    }
  });

  it('沒寫 ios：兩版預設都是 apns（v0.48.0 起，breaking）——缺 APNs 欄位時的錯誤寫明預設值與三種改法（中英）', () => {
    for (const base of [WORKERS, NODE_APNS]) {
      const config = { ...base, pushGateway: { tokenPerHour: 120 } };
      expect(errors(config)).toEqual(['pushGateway.apnsTopic:required', 'pushGateway.apnsKeyId:required', 'pushGateway.apnsTeamId:required']);
      expect(warnings(config)).not.toContain('pushGateway.ios:push-ios-fcm-deprecated');
      const issue = validateDeployConfig(config).issues.find((i) => i.path === 'pushGateway.apnsTopic')!;
      expect(issue.message['zh-TW']).toContain('pushGateway.ios 沒寫時預設是 "apns"');
      expect(issue.message['zh-TW']).toContain('pushGateway.ios: "off"');
      expect(issue.message['zh-TW']).toContain('pushGateway.ios: "fcm"');
      expect(issue.message['zh-TW']).toContain('secrets.apnsKey');
      expect(issue.message.en).toContain('pushGateway.ios defaults to "apns"');
      expect(issue.message.en).toContain('pushGateway.ios: "off"');
    }
    // 明寫 apns 時只說缺什麼，不提預設值
    const explicit = validateDeployConfig({ ...WORKERS, pushGateway: { ios: 'apns' } }).issues.find((i) => i.path === 'pushGateway.apnsTopic')!;
    expect(explicit.message['zh-TW']).not.toContain('預設');
    // 只要 Android：ios: "off" 不需要任何 Apple 欄位
    expect(errors({ ...WORKERS, pushGateway: { ios: 'off' } })).toEqual([]);
    expect(errors({ configVersion: 1, target: 'docker', service: 'push-gateway', pushGateway: { ios: 'off' } })).toEqual([]);
  });

  it('從舊版設定升級：CLI 列出 v0.48.0 的預設值變更（ADR 0062）', () => {
    const older = validateDeployConfig({ ...WORKERS, sdk: '0.47.0' }, { sdkVersion: '0.48.0' }).issues.find((i) => i.code === 'sdk-older')!;
    expect(older.message['zh-TW']).toContain('v0.48.0（ADR 0062）');
    expect(older.message['zh-TW']).toContain('pushGateway.ios');
    expect(older.message.en).toContain('v0.48.0 (ADR 0062)');
  });

  it('上限有範圍（可在設定器調整）', () => {
    expect(errors({ ...WORKERS, pushGateway: { tokenPerHour: 0 } })).toContain('pushGateway.tokenPerHour:out-of-range');
    expect(errors({ ...WORKERS, pushGateway: { tokenPerMinute: 61 } })).toContain('pushGateway.tokenPerMinute:out-of-range');
    expect(errors({ ...WORKERS, pushGateway: { maxRegistrationDays: 31 } })).toContain('pushGateway.maxRegistrationDays:out-of-range');
    expect(errors({ ...WORKERS, pushGateway: { iosLocKey: '有新訊息' } })).toContain('pushGateway.iosLocKey:pattern');
  });

  it('服務不對的設定：拒絕（設了卻不生效）', () => {
    expect(errors({ ...WORKERS, site: { maxTtlDays: 3 } })).toContain('site:not-applicable-service');
    expect(errors({ ...NODE_APNS, node: { persist: true } })).toContain('node.persist:not-applicable-service');
    expect(errors({ configVersion: 1, target: 'docker', pushGateway: { tokenPerHour: 10 } })).toContain('pushGateway.tokenPerHour:not-applicable-service');
    expect(errors({ ...WORKERS, service: 'mail' })).toContain('service:enum');
  });

  it('秘密只能寫 $env', () => {
    expect(errors({ ...WORKERS, secrets: { pushGatewayKey: 'nsec1abc' } })).toContain('secrets.pushGatewayKey:secret-literal');
  });
});

describe('部署包：Workers 版（明寫 ios: "fcm"，已棄用）', () => {
  const f = files(WORKERS);

  it('wrangler.toml：每個 token 一顆 DO（SQLite 型）、上限與選項在 [vars]、沒有秘密', () => {
    const toml = f['wrangler.toml']!;
    expect(toml).toContain('name = "my-push"');
    expect(toml).toContain('[[durable_objects.bindings]]\nname = "PUSH_STATE"\nclass_name = "PushGatewayState"');
    expect(toml).toContain('new_sqlite_classes = ["PushGatewayState"]');
    expect(toml).toContain('PUSH_TOKEN_PER_HOUR = "120"');
    expect(toml).toContain('PUSH_IOS = "fcm"');
    expect(toml).toContain('PUSH_IOS_LOC_KEY = "HOME_ALERT"');
    expect(toml).not.toMatch(/PUSH_GATEWAY_KEY\s*=|FCM_SERVICE_ACCOUNT\s*=/);
    expect(toml).not.toContain('APNS_');
  });

  it('入口、package.json、.dev.vars.example、.env.example', () => {
    expect(f['src/entry.mjs']).toContain("export { default, PushGatewayState } from '@cinderous/client/iot/push-gateway/worker';");
    expect(JSON.parse(f['package.json']!)).toMatchObject({ dependencies: { '@cinderous/client': 'file:./sdk' }, devDependencies: { wrangler: '^4' } });
    expect(f['.dev.vars.example']).toMatch(/^PUSH_GATEWAY_KEY=$/m);
    expect(f['.dev.vars.example']).toMatch(/^FCM_SERVICE_ACCOUNT=$/m);
    expect(f['.env.example']).toMatch(/^CLOUDFLARE_API_TOKEN=$/m);
    expect(f['.env.example']).toMatch(/^PUSH_GATEWAY_KEY=$/m);
    expect(f['.env.example']).not.toContain('APNS_KEY');
  });

  it('沒有中繼的檔案；MIT-0 標頭；設定檔寫入 service 與 pushGateway', () => {
    expect(Object.keys(f)).not.toContain('src/relay.mjs');
    expect(f['wrangler.toml']).not.toContain('RELAY_ROOM');
    expect(f['src/entry.mjs']!.startsWith('// SPDX-License-Identifier: MIT-0')).toBe(true);
    const saved = JSON.parse(f['cinderous.config.json']!);
    expect(Object.keys(saved)).toEqual(['configVersion', 'sdk', 'target', 'service', 'name', 'cloudflare', 'pushGateway']);
  });

  it('--self-contained 不適用於推播閘道', () => {
    expect(() => renderDeployPackage(WORKERS, { ...ctx, selfContained: true, relayWorkerSource: 'x' })).toThrow(/中繼/);
  });

  it('說明（中英）：Firebase 服務帳號步驟、wrangler secret put、Workers 版 iOS 經 Google 的隱私說明、App 整合', () => {
    const zh = f['README-DEPLOY.md']!;
    const en = f['README-DEPLOY.en.md']!;
    expect(zh).toContain('推播閘道');
    expect(zh).toContain('產生新的私密金鑰');
    expect(zh).toContain('npx wrangler@4 secret put PUSH_GATEWAY_KEY');
    expect(zh).toContain('npx wrangler@4 secret put FCM_SERVICE_ACCOUNT');
    expect(zh).toContain('Google 也看得到 iOS 手機的喚醒時間點');
    expect(zh).toContain('上傳 APNs 驗證金鑰');
    expect(zh).toContain('sealIotPushToken');
    expect(zh).toContain('https://my-push.me.workers.dev/v1/info');
    expect(en).toContain('Google also sees when iOS phones are woken');
    expect(en).toContain('Generate new private key');
    expect(en).toContain('UnifiedPush');
  });
});

describe('部署包：Workers 版直連 APNs（SDK ADR 0061）', () => {
  const f = files(WORKERS_APNS);

  it('wrangler.toml：PUSH_IOS=apns 與 APNs 的非秘密設定在 [vars]；.p8 不在這裡', () => {
    const toml = f['wrangler.toml']!;
    expect(toml).toContain('PUSH_IOS = "apns"');
    expect(toml).toContain('PUSH_ANDROID = "0"');
    expect(toml).toContain('APNS_TOPIC = "com.example.cinder"');
    expect(toml).toContain('APNS_KEY_ID = "ABC123DEFG"');
    expect(toml).toContain('APNS_TEAM_ID = "TEAM123456"');
    expect(toml).toContain('APNS_ENV = "sandbox"');
    expect(toml).not.toMatch(/APNS_KEY\s*=|FCM_SERVICE_ACCOUNT\s*=|PUSH_GATEWAY_KEY\s*=/);
    expect(toml).toContain('APNS_KEY');
  });

  it('秘密：APNS_KEY 取代 FCM_SERVICE_ACCOUNT（Android 關掉時完全不需要 Firebase）', () => {
    expect(f['.dev.vars.example']).toMatch(/^APNS_KEY=$/m);
    expect(f['.dev.vars.example']).not.toContain('FCM_SERVICE_ACCOUNT');
    expect(f['.env.example']).toMatch(/^APNS_KEY=$/m);
    expect(f['.env.example']).not.toContain('FCM_SERVICE_ACCOUNT');
    const withAndroid = files({ ...WORKERS_APNS, pushGateway: { ...WORKERS_APNS.pushGateway, android: true } });
    expect(withAndroid['.dev.vars.example']).toMatch(/^FCM_SERVICE_ACCOUNT=$/m);
    expect(withAndroid['.dev.vars.example']).toMatch(/^APNS_KEY=$/m);
  });

  it('說明（中英）：wrangler secret put APNS_KEY（從 .p8 檔導入）、iOS 直連不經 Google、本機 wrangler dev 連不上 APNs', () => {
    const zh = f['README-DEPLOY.md']!;
    const en = f['README-DEPLOY.en.md']!;
    expect(zh).toContain('npx wrangler@4 secret put APNS_KEY');
    expect(zh).toContain('< AuthKey_ABC123DEFG.p8');
    expect(zh).not.toContain('secret put FCM_SERVICE_ACCOUNT');
    expect(zh).toContain('直連 APNs（一般推播＋mutable-content）');
    expect(zh).not.toContain('Google 也看得到 iOS 手機的喚醒時間點');
    expect(zh).not.toContain('Firebase 專案');
    expect(zh).toContain('Network connection lost');
    expect(zh).toContain('ios: "apns"');
    expect(en).toContain('direct APNs (alert push + mutable-content)');
    expect(en).toContain('npx wrangler@4 secret put APNS_KEY');
    expect(en).toContain('Network connection lost');
  });

  it('iOS 明寫 fcm 的說明（兩版）寫明 iOS 經 FCM 已棄用、怎麼改成直連、改了沒有過渡期', () => {
    for (const config of [WORKERS, { ...NODE_APNS, pushGateway: { ios: 'fcm' } } as DeployConfig]) {
      const zh = files(config)['README-DEPLOY.md']!;
      const en = files(config)['README-DEPLOY.en.md']!;
      expect(zh).toContain('已棄用');
      expect(zh).toContain('Google 也看得到 iOS 手機的喚醒時間點');
      expect(zh).toContain('pushGateway.ios: "apns"');
      expect(zh).toContain('沒有過渡期');
      expect(en).toContain('deprecated');
    }
  });
});

describe('部署包：沒寫 ios（預設 apns）與只要 Android（ios: "off"）', () => {
  it('沒寫 ios：wrangler.toml 寫 PUSH_IOS = "apns"、APNs 的 [vars]、秘密列 APNS_KEY；說明不提棄用', () => {
    const f = files({ ...WORKERS_APNS, pushGateway: { android: false, apnsTopic: 'com.example.cinder', apnsKeyId: 'ABC123DEFG', apnsTeamId: 'TEAM123456' } });
    expect(f['wrangler.toml']).toContain('PUSH_IOS = "apns"');
    expect(f['wrangler.toml']).toContain('APNS_TOPIC = "com.example.cinder"');
    expect(f['.dev.vars.example']).toMatch(/^APNS_KEY=$/m);
    expect(f['.dev.vars.example']).not.toContain('FCM_SERVICE_ACCOUNT');
    expect(f['README-DEPLOY.md']).toContain('wrangler@4 secret put APNS_KEY');
    expect(f['README-DEPLOY.md']).not.toContain('已棄用');
    // 日誌的 apnsReason 與改法（SDK ADR 0062 §6）：金鑰限定環境的 BadEnvironmentKeyInToken 要寫明怎麼改
    expect(f['README-DEPLOY.md']).toContain('BadEnvironmentKeyInToken');
    expect(f['README-DEPLOY.md']).toContain('Sandbox 或 Production');
    expect(f['README-DEPLOY.md']).toContain('`apnsEnvironment`');
    expect(f['README-DEPLOY.en.md']).toContain('the APNs key is restricted to Sandbox or Production; match `apnsEnvironment` or create a key for both environments');
    expect(f['README-DEPLOY.md']).toContain('"apnsReason"');
    // 從 fcm 改成 apns 沒有過渡期（SDK ADR 0062）：說明寫明舊的 iOS FCM 登記要等 App 重新登記
    expect(f['README-DEPLOY.md']).toContain('沒有過渡期');
    expect(f['README-DEPLOY.md']).toContain('platform-disabled');
    expect(f['README-DEPLOY.en.md']).toContain('no transition period');
  });

  it('ios: "off"：沒有任何 APNS_ 設定或秘密、說明不要 Apple Developer 帳號，也不提棄用', () => {
    for (const base of [WORKERS, NODE_APNS]) {
      const f = files({ ...base, pushGateway: { ios: 'off' } } as DeployConfig);
      const all = Object.entries(f).filter(([path]) => !path.endsWith('.json')).map(([, c]) => c).join('\n');
      expect(all).toContain('PUSH_IOS');
      expect(all).not.toMatch(/APNS_[A-Z_]+\s*[=:]/);
      expect(f['README-DEPLOY.md']).not.toContain('Apple Developer Program');
      expect(f['README-DEPLOY.md']).not.toContain('BadEnvironmentKeyInToken');
      expect(f['README-DEPLOY.md']).not.toContain('已棄用');
    }
  });
});

describe('部署包：Node 版（直連 APNs）', () => {
  const f = files(NODE_APNS);

  it('Dockerfile、server.mjs（startNodePushGateway）', () => {
    expect(f.Dockerfile).toContain('CMD ["node", "server.mjs"]');
    expect(f.Dockerfile).toContain('COPY sdk ./sdk');
    expect(f['server.mjs']).toContain("import { startNodePushGateway } from '@cinderous/client/iot/push-gateway/node';");
    expect(f['server.mjs']).toContain('await startNodePushGateway(process.env)');
  });

  it('compose：秘密從 .env 代入（改名的引用也照辦）、APNs 的非秘密設定在環境、沒有 volume', () => {
    const compose = f['docker-compose.yml']!;
    expect(compose).toContain('PUSH_GATEWAY_KEY: "${MY_PUSH_KEY:?請在 .env 設定 MY_PUSH_KEY}"');
    expect(compose).toContain('APNS_KEY: "${APNS_KEY:?請在 .env 設定 APNS_KEY}"');
    expect(compose).toContain('FCM_SERVICE_ACCOUNT: "${FCM_SERVICE_ACCOUNT:?'); // Android 預設開著，仍要 FCM
    expect(compose).toContain('APNS_TOPIC: "com.example.cinder"');
    expect(compose).toContain('APNS_ENV: "sandbox"');
    expect(compose).toContain('"9443:8080"');
    expect(compose).not.toContain('volumes:');
  });

  it('.env.example 列出秘密名稱（值留空）', () => {
    expect(f['.env.example']).toMatch(/^MY_PUSH_KEY=$/m);
    expect(f['.env.example']).toMatch(/^APNS_KEY=$/m);
  });

  it('說明：APNs 金鑰步驟、.p8 換行寫成 \\n、直連不經 Google', () => {
    const zh = f['README-DEPLOY.md']!;
    expect(zh).toContain('Apple Push Notifications service (APNs)');
    expect(zh).toContain('換行寫成 `\\n`');
    expect(zh).toContain('直連 APNs（一般推播＋mutable-content）');
    expect(zh).not.toContain('Google 也看得到 iOS 手機的喚醒時間點');
    expect(f['README-DEPLOY.en.md']).toContain('direct APNs (alert push + mutable-content)');
  });
});

it('Android 開著時 compose 也帶 FCM_SERVICE_ACCOUNT；fly 的秘密用 fly secrets set、不進 fly.toml；home-tunnel 有 cloudflared', () => {
  // 只要 Android（ios: "off"）：v0.48.0 起沒寫 ios 就是 apns、要 Apple 欄位（SDK ADR 0062）
  const ANDROID_ONLY = { ios: 'off' } as const;
  const docker = files({ configVersion: 1, target: 'docker', service: 'push-gateway', pushGateway: ANDROID_ONLY });
  expect(docker['docker-compose.yml']).toContain('FCM_SERVICE_ACCOUNT: "${FCM_SERVICE_ACCOUNT:?');
  const fly = files({ configVersion: 1, target: 'fly', service: 'push-gateway', name: 'push-fly', pushGateway: ANDROID_ONLY });
  expect(fly['fly.toml']).toContain('PUSH_IOS = "off"');
  expect(fly['fly.toml']).not.toContain('PUSH_GATEWAY_KEY');
  expect(fly['README-DEPLOY.md']).toContain('fly secrets set --app push-fly PUSH_GATEWAY_KEY=');
  const tunnel = files({ configVersion: 1, target: 'home-tunnel', service: 'push-gateway', pushGateway: ANDROID_ONLY, tunnel: { hostname: 'push.example.com' }, secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } } });
  expect(tunnel['docker-compose.yml']).toContain('cloudflared:');
  expect(tunnel['README-DEPLOY.md']).toContain('https://push.example.com/v1/info');
});

it('部署包可攜、確定、不含秘密值', () => {
  const a = renderDeployPackage(NODE_APNS, ctx).files;
  const b = renderDeployPackage(NODE_APNS, ctx).files;
  expect(a).toEqual(b);
  for (const file of a) {
    expect(file.content, file.path).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(file.content, file.path).not.toContain('BEGIN PRIVATE KEY-----M');
  }
});

describe('CLI', () => {
  it('relay deploy --config 不部署推播閘道（用法錯誤，指向 relay build）', async () => {
    const cwd = resolve('/work');
    const err: string[] = [];
    const deps: CliDeps = {
      stdout: () => {},
      stderr: (line) => err.push(line),
      env: {},
      cwd,
      startNodeRelay: () => ({ close() {} }),
      deployCloudflareRelay: async () => {
        throw new Error('不該部署');
      },
      deployDockerRelay: async () => {
        throw new Error('不該部署');
      },
      deployFlyRelay: async () => {
        throw new Error('不該部署');
      },
      writeFile: () => {},
      readFile: (path) => (resolve(path) === resolve(cwd, 'cinderous.config.json') ? JSON.stringify(WORKERS) : undefined),
      sdkVersion: '0.40.0',
    };
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], deps)).toBe(2);
    expect(err.join('\n')).toContain('relay build');
  });

  it('relay build 真的寫出推播閘道的部署包（內嵌 sdk/）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinder-push-build-'));
    const result = await buildRelayPackage({ config: NODE_APNS, configPath: join(dir, 'cinderous.config.json'), outDir: dir });
    expect(result.files).toContain('server.mjs');
    expect(result.copiedSdk).toBe(true);
    expect(readFileSync(join(dir, 'sdk', 'dist', 'iot', 'push-gateway', 'node.js'), 'utf8')).toContain('startNodePushGateway');
  }, 60_000);
});
