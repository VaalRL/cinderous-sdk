// `cinderous relay build --config`（SDK ADR 0050 §5）：把 `renderDeployPackage` 的產出寫到磁碟，另外複製內嵌的 `sdk/`。
// 產生的內容本身是純函式（./config），這裡只負責讀 SDK、比對上一次產生的清單、寫檔。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sdkRootDir, sdkVersion } from './common.js';
import { copySdkRuntime } from './container.js';
import {
  DEPLOY_CONFIG_FILE,
  type DeployConfig,
  GENERATED_MANIFEST,
  type GeneratedManifest,
  modifiedGeneratedFiles,
  renderDeployPackage,
  validateDeployConfig,
} from './config/index.js';
import type { DeployIssue } from './shared.js';

export interface BuildRelayPackageOptions {
  /** 剛 `JSON.parse` 出來的設定（會先驗證） */
  config: unknown;
  /** 設定檔的路徑：輸出目錄裡的 `cinderous.config.json` 就是它時，允許以正規化後的內容覆寫 */
  configPath?: string;
  outDir: string;
  /** Workers：附預打包的中繼（`src/relay.mjs`），不需要安裝 SDK */
  selfContained?: boolean;
  /** SDK 改以套件相依安裝（例如 `github:VaalRL/cinderous-sdk#v0.81.0`），不內嵌 `sdk/` */
  sdkSpec?: string;
  /** 覆寫被手改過、或不是 relay build 產生的檔案 */
  force?: boolean;
  /** 以下供測試替換 */
  sdkRoot?: string;
  version?: string;
  relayWorkerSource?: string;
}

export interface RelayPackageBuild {
  outDir: string;
  /** 寫出的檔案（相對路徑；不含 `sdk/` 底下） */
  files: string[];
  /** 移除的舊檔（上一次產生、這次不再需要，而且沒被手改過） */
  removed: string[];
  copiedSdk: boolean;
  /** 驗證的提醒（例如開放中繼、疑似 Token） */
  warnings: DeployIssue[];
}

async function loadRelayWorkerSource(sdkRoot: string): Promise<string> {
  // 動態載入：打包好的 Worker（約 60KB）只屬於 ./deploy/cloudflare-api，不進 ./deploy 的模組圖（SDK ADR 0021 的守門）
  const url = pathToFileURL(join(sdkRoot, 'dist', 'deploy', 'cloudflare-api', 'relay-worker-bundle.js')).href;
  const mod = (await import(url)) as { relayWorkerSource: string };
  return mod.relayWorkerSource;
}

/**
 * 產生可攜的部署包（SDK ADR 0050 §5）。設定有錯就丟例外（列出全部錯誤），什麼都不寫。
 * 🔴 重新產生前比對上一次的清單（`.cinderous-generated`）：被手改過的產生檔案、或輸出目錄裡同名但不是產生的檔案，
 * 沒加 `force` 就拒絕——不默默蓋掉別人的修改。
 */
export async function buildRelayPackage(opts: BuildRelayPackageOptions): Promise<RelayPackageBuild> {
  const sdkRoot = opts.sdkRoot ?? sdkRootDir();
  const version = opts.version ?? sdkVersion(sdkRoot);
  const validation = validateDeployConfig(opts.config, { sdkVersion: version });
  if (!validation.ok) {
    const lines = validation.issues.filter((i) => i.severity === 'error').map((i) => `- ${i.path === '' ? '' : `${i.path}：`}${i.message['zh-TW']}`);
    throw new Error(`設定檔有 ${lines.length} 個錯誤，沒有產生任何檔案：\n${lines.join('\n')}`);
  }
  const config = opts.config as DeployConfig;
  const licensePath = join(sdkRoot, 'LICENSE');
  const licenseText = existsSync(licensePath) ? readFileSync(licensePath, 'utf8') : '';
  if (licenseText === '') throw new Error(`找不到 SDK 的 LICENSE（${licensePath}）：部署包必須附 AGPL 授權全文`);
  const pkg = renderDeployPackage(config, {
    sdkVersion: version,
    licenseText,
    ...(opts.sdkSpec !== undefined ? { sdkSource: { kind: 'spec' as const, spec: opts.sdkSpec } } : {}),
    ...(opts.selfContained ? { selfContained: true, relayWorkerSource: opts.relayWorkerSource ?? (await loadRelayWorkerSource(sdkRoot)) } : {}),
  });

  const outDir = resolve(opts.outDir);
  const read = (path: string): string | undefined => {
    const full = join(outDir, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  };
  const inputConfig = opts.configPath !== undefined ? resolve(opts.configPath) : undefined;
  const isInputConfig = (path: string): boolean => path === DEPLOY_CONFIG_FILE && inputConfig === join(outDir, DEPLOY_CONFIG_FILE);

  const previousText = read(GENERATED_MANIFEST);
  let previous: GeneratedManifest | undefined;
  const conflicts: string[] = [];
  if (previousText !== undefined) {
    try {
      previous = JSON.parse(previousText) as GeneratedManifest;
    } catch {
      previous = undefined;
    }
    conflicts.push(...modifiedGeneratedFiles(previousText, read).filter((path) => !isInputConfig(path)));
  }
  // 清單沒記錄、但輸出目錄裡已經有同名而且內容不同的檔案：不是我們產生的，不蓋
  for (const file of pkg.files) {
    if (previous?.files?.[file.path] !== undefined || isInputConfig(file.path)) continue;
    // 清單本身記不了自己的雜湊；它若格式壞掉，上面的 modifiedGeneratedFiles 已經報過
    if (file.path === GENERATED_MANIFEST && previousText !== undefined) continue;
    const current = read(file.path);
    if (current !== undefined && current !== file.content) conflicts.push(file.path);
  }
  if (conflicts.length > 0 && opts.force !== true) {
    throw new Error(
      `${outDir} 裡有被手改過、或不是 relay build 產生的檔案：${[...new Set(conflicts)].join('、')}。` +
        '先把修改搬回 cinderous.config.json（或另存），再重新產生；確定要覆寫就加 --force',
    );
  }

  mkdirSync(outDir, { recursive: true });
  for (const file of pkg.files) {
    const full = join(outDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
  // 上一次產生、這次不再需要的檔案（例如換了目標）：沒被手改過才刪
  const removed: string[] = [];
  const now = new Set(pkg.files.map((f) => f.path));
  for (const path of Object.keys(previous?.files ?? {})) {
    if (now.has(path) || conflicts.includes(path)) continue;
    const full = join(outDir, path);
    if (existsSync(full)) {
      rmSync(full);
      removed.push(path);
    }
  }
  if (pkg.copySdk) {
    copySdkRuntime(join(outDir, 'sdk'), sdkRoot);
  } else if (previous?.sdkDir !== undefined && existsSync(join(outDir, 'sdk'))) {
    rmSync(join(outDir, 'sdk'), { recursive: true, force: true });
    removed.push('sdk/');
  }
  return {
    outDir,
    files: pkg.files.map((f) => f.path),
    removed,
    copiedSdk: pkg.copySdk,
    warnings: validation.issues.filter((i) => i.severity === 'warning'),
  };
}
