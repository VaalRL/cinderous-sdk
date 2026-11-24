// 預建的 Node 中繼映像 ghcr.io/vaalrl/cinderous-relay-lite（SDK ADR 0143）。
// 本機沒有 Docker：這裡驗的是 repo 裡的 Dockerfile／workflow 的**內容**與 SDK 程式的一致性；
// 真正的建置與冒煙測試在公開 repo 推 tag 時由 .github/workflows/image.yml 跑。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { type DeployConfig, type DeployPackageContext, renderDeployPackage } from '../../src/deploy/config/index.js';
import {
  CONTAINER_DB_PATH,
  CONTAINER_PORT,
  RELAY_IMAGE_REPOSITORY,
  RELAY_IMAGE_SERVER_HEADER,
  relayImageRef,
  renderServerEntry,
} from '../../src/deploy/render.js';

const ROOT = join(import.meta.dirname, '..', '..');
// Windows 上 git 可能把這些檔檢出成 CRLF（core.autocrlf）；比對內容前先正規化，免得本機假失敗
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DOCKERFILE = 'docker/relay-lite/Dockerfile';
const WORKFLOW = '.github/workflows/image.yml';

describe('映像名稱與版號', () => {
  it('倉庫名稱全小寫（GHCR 要求），版號標籤帶 v、跟 SDK 版號', () => {
    expect(RELAY_IMAGE_REPOSITORY).toBe('ghcr.io/vaalrl/cinderous-relay-lite');
    expect(relayImageRef('0.92.0')).toBe('ghcr.io/vaalrl/cinderous-relay-lite:v0.92.0');
  });
});

describe('docker/relay-lite/Dockerfile', () => {
  const df = read(DOCKERFILE);

  it('基底映像釘版號＋digest（多架構清單的 digest）', () => {
    expect(df).toMatch(/^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(df).toMatch(/^FROM \$\{NODE_IMAGE\} AS deps$/m);
    expect(df).toMatch(/^FROM \$\{NODE_IMAGE\}$/m);
  });

  it('只裝執行用相依、照 lockfile、不跑任何安裝 script', () => {
    expect(df).toContain('COPY package.json package-lock.json ./');
    expect(df).toMatch(/RUN npm ci --omit=dev --ignore-scripts/);
  });

  it('🔴 中繼以 node 使用者跑：入口先修好 /data 的擁有者再降權（舊的自建版 volume、Fly 的 volume 都屬於 root）', () => {
    // 不在映像層級寫 USER node：那樣入口沒有權限修既有 volume，保存模式會寫不進去（審查發現）
    expect(df).not.toMatch(/^USER /m);
    expect(df).toMatch(/chown node:node \/data/);
    expect(df).toMatch(/^VOLUME \["\/data"\]$/m);
    expect(df).toContain('COPY docker/relay-lite/entrypoint.mjs ./entrypoint.mjs');
    expect(df).toMatch(/^CMD \["node", "--experimental-sqlite", "entrypoint\.mjs"\]$/m);
  });

  it('埠、資料庫路徑與 relay build 產生的部署包相同（CONTAINER_PORT、CONTAINER_DB_PATH）', () => {
    expect(df).toContain(`EXPOSE ${CONTAINER_PORT}`);
    expect(df).toMatch(new RegExp(`PORT=${CONTAINER_PORT}\\b`));
    expect(df).toContain(`DB_PATH=${CONTAINER_DB_PATH}`);
  });

  it('健康檢查打 /healthz（Node 中繼的健康端點），不需要 curl', () => {
    expect(df).toMatch(/^HEALTHCHECK [^\n]*\\\n\s+CMD \["node", "-e", "[^\n]*\/healthz/m);
    // 不為了健康檢查多裝套件（基底沒有 curl）
    expect(df).not.toMatch(/apt-get|apk add/);
  });

  it('OCI 標籤：來源與授權 AGPL-3.0-only', () => {
    expect(df).toContain('org.opencontainers.image.source="https://github.com/VaalRL/cinderous-sdk"');
    expect(df).toContain('org.opencontainers.image.licenses="AGPL-3.0-only"');
  });

  it('COPY 的來源都存在於 repo（建置內容是 repo 根目錄）', () => {
    for (const m of df.matchAll(/^COPY (?!--from)(.+) \S+$/gm)) {
      for (const src of m[1]!.split(/\s+/)) expect(existsSync(join(ROOT, src)), src).toBe(true);
    }
  });

  it('映像的入口程式就是 relay build 產生的那一份（同一個產生器，只差標頭）', () => {
    expect(read('docker/relay-lite/server.mjs')).toBe(renderServerEntry({ header: RELAY_IMAGE_SERVER_HEADER }));
    expect(df).toContain('COPY docker/relay-lite/server.mjs ./server.mjs');
  });

  it('入口程式讀的環境變數，Node 中繼真的會讀（不會出現映像設了、中繼卻不認的名字）', () => {
    const node = read('src/relay/node-relay.ts');
    for (const name of ['PORT', 'DB_PATH']) expect(node).toContain(`env.${name}`);
    const entry = read('docker/relay-lite/server.mjs');
    expect(entry).toContain("process.env.PERSIST !== '1'");
    expect(entry).toContain('process.env.RELAY_VERSION');
  });

  it('建置內容只放執行需要的檔案（Dockerfile 旁的 .dockerignore 先排除全部再列白名單）', () => {
    const ignore = read('docker/relay-lite/Dockerfile.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    expect(ignore[0]).toBe('*');
    expect(ignore).toEqual(
      expect.arrayContaining(['!package.json', '!package-lock.json', '!LICENSE', '!dist', '!docker/relay-lite/server.mjs', '!docker/relay-lite/entrypoint.mjs']),
    );
    // 秘密與資料庫絕不進建置內容
    expect(ignore.some((l) => /^!.*(\.env|\.secrets|\.db)/.test(l))).toBe(false);
  });
});

describe('docker/relay-lite/entrypoint.mjs：修 /data 擁有者後降權', () => {
  type Call = [string, ...unknown[]];
  interface Entry { uid: number; gid: number; dir: boolean; children?: string[] }
  const NODE = { uid: 1000, gid: 1000 };
  const load = async () =>
    (await import(new URL('../../docker/relay-lite/entrypoint.mjs', import.meta.url).href)) as {
      dropPrivileges: (deps: unknown) => string;
    };
  function harness(uid: number, tree: Record<string, Entry>, failSetuid = false) {
    const calls: Call[] = [];
    const proc = {
      getuid: () => uid,
      setgroups: (g: number[]) => calls.push(['setgroups', g]),
      setgid: (g: number) => calls.push(['setgid', g]),
      setuid: (u: number) => {
        if (failSetuid) throw new Error('EPERM');
        calls.push(['setuid', u]);
      },
    };
    const fs = {
      existsSync: (p: string) => p in tree,
      mkdirSync: (p: string) => {
        calls.push(['mkdir', p]);
        tree[p] = { uid: 0, gid: 0, dir: true, children: [] };
      },
      lstatSync: (p: string) => ({ uid: tree[p]!.uid, gid: tree[p]!.gid, isDirectory: () => tree[p]!.dir }),
      readdirSync: (p: string) => tree[p]!.children ?? [],
      lchownSync: (p: string, u: number, g: number) => calls.push(['lchown', p, u, g]),
    };
    return { calls, deps: { proc, fs, dataDir: '/data', ...NODE } };
  }

  it('root 啟動、舊 volume 屬於 root：整個目錄（含資料庫檔）改給 node，再依序清群組、setgid、setuid', async () => {
    const { dropPrivileges } = await load();
    const { calls, deps } = harness(0, {
      '/data': { uid: 0, gid: 0, dir: true, children: ['relay.db', 'relay.db-wal'] },
      '/data/relay.db': { uid: 0, gid: 0, dir: false },
      '/data/relay.db-wal': { uid: 0, gid: 0, dir: false },
    });
    expect(dropPrivileges(deps)).toBe('dropped');
    expect(calls).toEqual([
      ['lchown', '/data', 1000, 1000],
      ['lchown', '/data/relay.db', 1000, 1000],
      ['lchown', '/data/relay.db-wal', 1000, 1000],
      ['setgroups', []],
      ['setgid', 1000],
      ['setuid', 1000],
    ]);
  });

  it('已經屬於 node 的不動；目錄不存在就建（Fly 第一次掛 volume 前）', async () => {
    const { dropPrivileges } = await load();
    const owned = harness(0, { '/data': { uid: 1000, gid: 1000, dir: true, children: [] } });
    dropPrivileges(owned.deps);
    expect(owned.calls.filter((c) => c[0] === 'lchown')).toEqual([]);
    const missing = harness(0, {});
    dropPrivileges(missing.deps);
    expect(missing.calls.slice(0, 2)).toEqual([['mkdir', '/data'], ['lchown', '/data', 1000, 1000]]);
  });

  it('不是 root 啟動（--user、Kubernetes runAsUser）：什麼都不做', async () => {
    const { dropPrivileges } = await load();
    const { calls, deps } = harness(1000, { '/data': { uid: 0, gid: 0, dir: true } });
    expect(dropPrivileges(deps)).toBe('unprivileged');
    expect(calls).toEqual([]);
  });

  it('🔴 降權失敗就丟錯，絕不以 root 繼續跑中繼', async () => {
    const { dropPrivileges } = await load();
    const { deps } = harness(0, { '/data': { uid: 1000, gid: 1000, dir: true, children: [] } }, true);
    expect(() => dropPrivileges(deps)).toThrow(/EPERM/);
  });

  it('符號連結不跟（lchown、lstat），不會被 volume 裡的連結騙去改別處的擁有者', async () => {
    const src = read('docker/relay-lite/entrypoint.mjs');
    expect(src).not.toMatch(/\bchownSync\b|\bstatSync\b/);
  });
});

describe('.github/workflows/image.yml', () => {
  const text = read(WORKFLOW);
  const wf = parseYaml(text) as {
    on: { push: { tags: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; permissions: Record<string, string>; steps: { uses?: string; with?: Record<string, unknown>; run?: string }[] }>;
  };
  const job = Object.values(wf.jobs)[0]!;

  it('只在推 v* tag 時跑，而且只在公開 repo（dev repo 的 CI 不跑）', () => {
    expect(wf.on.push.tags).toEqual(['v*']);
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(job.if).toBe("github.repository == 'VaalRL/cinderous-sdk'");
  });

  it('權限最小：頂層只讀，job 只多 packages: write；用 GITHUB_TOKEN 登入', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
    const login = job.steps.find((s) => s.uses?.startsWith('docker/login-action@'))!;
    expect(login.with).toMatchObject({ registry: 'ghcr.io', password: '${{ secrets.GITHUB_TOKEN }}' });
  });

  it('所有 action 釘 40 字元 commit SHA', () => {
    const uses = job.steps.map((s) => s.uses).filter((u): u is string => u !== undefined);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    // 註解寫版號，人看得懂
    for (const line of text.split('\n').filter((l) => /uses: /.test(l))) expect(line, line).toMatch(/# v\d+\.\d+\.\d+$/);
  });

  it('🔴 checkout 不把權杖留在磁碟上；QEMU 與 BuildKit 的容器映像釘 digest（它們以特權模式跑在有 packages: write 的 job 裡）', () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with).toMatchObject({ 'persist-credentials': false });
    const qemu = job.steps.find((s) => s.uses?.startsWith('docker/setup-qemu-action@'))!;
    expect(String(qemu.with?.image)).toMatch(/^tonistiigi\/binfmt:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(qemu.with?.platforms).toBe('arm64');
    const buildx = job.steps.find((s) => s.uses?.startsWith('docker/setup-buildx-action@'))!;
    expect(String(buildx.with?.['driver-opts'])).toMatch(/^image=moby\/buildkit:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('推送前先檢查 tag 與 package.json 版號一致、先建 amd64 並冒煙測試', () => {
    const runs = job.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain("require('./package.json').version");
    expect(runs).toContain('/healthz');
    const builds = job.steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'));
    expect(builds).toHaveLength(2);
    expect(builds[0]!.with).toMatchObject({ platforms: 'linux/amd64', load: true, push: false });
    // 冒煙測試在第一次建置之後、推送之前
    const idx = (pred: (s: (typeof job.steps)[number]) => boolean) => job.steps.findIndex(pred);
    const smoke = idx((s) => (s.run ?? '').includes('/healthz'));
    expect(smoke).toBeGreaterThan(job.steps.indexOf(builds[0]!));
    expect(smoke).toBeLessThan(job.steps.indexOf(builds[1]!));
    // 冒煙測試也驗：中繼本身以 uid 1000 跑；舊的 root volume＋PERSIST=1 寫得進去
    expect(runs).toContain('/proc/1/status');
    expect(runs).toContain('PERSIST=1');
  });

  it('推送：amd64＋arm64、版號與 latest 兩個標籤、provenance＋SBOM、同一份 Dockerfile', () => {
    const push = job.steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'))[1]!.with!;
    expect(push.platforms).toBe('linux/amd64,linux/arm64');
    expect(push.push).toBe(true);
    // 🔴 latest 只在這個版號是目前最大的正式版時才推（補舊版的 tag 不能讓 latest 倒退）
    expect(String(push.tags).split('\n').map((t) => t.trim()).filter(Boolean)).toEqual([
      `${RELAY_IMAGE_REPOSITORY}:v\${{ env.VERSION }}`,
      `\${{ env.LATEST == 'true' && '${RELAY_IMAGE_REPOSITORY}:latest' || '' }}`,
    ]);
    const decide = job.steps.findIndex((s) => (s.run ?? '').includes('scripts/image-latest.mjs'));
    expect(decide).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(job.steps.indexOf(job.steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'))[1]!));
    expect(push.provenance).toBe('mode=max');
    expect(push.sbom).toBe(true);
    for (const b of job.steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'))) {
      expect(b.with).toMatchObject({ context: '.', file: DOCKERFILE, 'build-args': 'RELAY_VERSION=${{ env.VERSION }}' });
    }
  });

  it('公開匯出會帶上 workflow 與 Dockerfile（不在不公開清單裡）', () => {
    const exclude = JSON.parse(read('scripts/public-exclude.json')) as string[];
    for (const p of [WORKFLOW, DOCKERFILE, 'docker/relay-lite/server.mjs']) {
      expect(exclude.some((e) => p === e || p.startsWith(`${e}/`)), p).toBe(false);
    }
  });
});

describe('scripts/image-latest.mjs：這個版號是不是目前最大的正式版', () => {
  it('比現有正式版都大（或相等）才是 latest；預發布版不是；照數字比不照字串', async () => {
    const { isLatestRelease } = (await import(new URL('../../scripts/image-latest.mjs', import.meta.url).href)) as {
      isLatestRelease: (version: string, tags: readonly string[]) => boolean;
    };
    const tags = ['v0.9.0', 'v0.10.0', 'v0.91.0', 'v0.92.0', 'v1.0.0-rc.1', 'not-a-tag'];
    expect(isLatestRelease('0.92.0', tags)).toBe(true);
    expect(isLatestRelease('0.93.0', tags)).toBe(true);
    expect(isLatestRelease('0.91.1', tags)).toBe(false); // 補舊版
    expect(isLatestRelease('0.100.0', ['v0.99.0'])).toBe(true); // 不是字串比較
    expect(isLatestRelease('1.0.0-rc.2', tags)).toBe(false); // 預發布版不動 latest
    expect(isLatestRelease('0.92.0', [])).toBe(true);
  });
});

describe('relay build 使用預建映像（sdkSource: image）', () => {
  const ALICE = 'a'.repeat(63) + '1';
  const ctx: DeployPackageContext = { sdkVersion: '0.92.0', licenseText: 'AGPL\n', sdkSource: { kind: 'image' } };
  const docker: DeployConfig = { configVersion: 1, target: 'docker', site: { allowedPubkeys: [ALICE] }, node: { persist: true } };
  const fly: DeployConfig = { configVersion: 1, target: 'fly', name: 'fly-relay', site: { allowedPubkeys: [ALICE] }, node: { persist: true } };
  const tunnel: DeployConfig = {
    configVersion: 1,
    target: 'home-tunnel',
    site: { allowedPubkeys: [ALICE] },
    tunnel: { hostname: 'relay.example.com' },
    secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } },
  };
  const files = (config: DeployConfig, c: DeployPackageContext = ctx) => Object.fromEntries(renderDeployPackage(config, c).files.map((f) => [f.path, f.content]));

  it('docker：compose 用映像、不建置；部署包沒有 Dockerfile／server.mjs／package.json，也不複製 sdk/', () => {
    const pkg = renderDeployPackage(docker, ctx);
    expect(pkg.copySdk).toBe(false);
    const f = Object.fromEntries(pkg.files.map((x) => [x.path, x.content]));
    expect(f['docker-compose.yml']).toContain('    image: "ghcr.io/vaalrl/cinderous-relay-lite:v0.92.0"');
    expect(f['docker-compose.yml']).not.toContain('build: .');
    for (const p of ['Dockerfile', 'server.mjs', 'package.json', '.dockerignore']) expect(f[p], p).toBeUndefined();
    // 保存模式的 volume 與環境變數照舊
    expect(f['docker-compose.yml']).toContain('relay-data:/data');
    expect(f['docker-compose.yml']).toContain('PERSIST: "1"');
  });

  it('home-tunnel：relay 用映像，cloudflared 照舊', () => {
    const compose = files(tunnel)['docker-compose.yml']!;
    expect(compose).toContain('image: "ghcr.io/vaalrl/cinderous-relay-lite:v0.92.0"');
    expect(compose).toContain('image: "cloudflare/cloudflared:latest"');
    expect(compose).not.toContain('build: .');
  });

  it('fly：[build] 改成 image，不用 Dockerfile', () => {
    const toml = files(fly)['fly.toml']!;
    expect(toml).toContain('[build]\n  image = "ghcr.io/vaalrl/cinderous-relay-lite:v0.92.0"');
    expect(toml).not.toContain('dockerfile');
    expect(files(fly).Dockerfile).toBeUndefined();
  });

  it('可以指定別的映像（自己的鏡像站）', () => {
    const c = { ...ctx, sdkSource: { kind: 'image' as const, image: 'registry.example.com/me/relay:v0.92.0' } };
    expect(files(docker, c)['docker-compose.yml']).toContain('image: "registry.example.com/me/relay:v0.92.0"');
  });

  it('說明改成 pull／up，不再 --build；回滾是換映像標籤；授權段寫明映像', () => {
    for (const p of ['README-DEPLOY.md', 'README-DEPLOY.en.md']) {
      const guide = files(docker)[p]!;
      expect(guide, p).toContain('docker compose pull');
      expect(guide, p).not.toContain('docker compose up -d --build');
      expect(guide, p).toContain('ghcr.io/vaalrl/cinderous-relay-lite:v0.92.0');
    }
  });

  it('Workers 目標與推播閘道不能用映像', () => {
    const cf: DeployConfig = { configVersion: 1, target: 'cloudflare', site: { allowedPubkeys: [ALICE] } };
    expect(() => renderDeployPackage(cf, ctx)).toThrow(/映像|image/);
  });

  it('預設不變：沒指定時照舊自建（build: .＋Dockerfile）', () => {
    const plain = files(docker, { sdkVersion: '0.92.0', licenseText: 'AGPL\n' });
    expect(plain['docker-compose.yml']).toContain('build: .');
    expect(plain.Dockerfile).toBeDefined();
  });

  it('確定性：同一份設定與 ctx → 同一組檔案', () => {
    expect(renderDeployPackage(docker, ctx)).toEqual(renderDeployPackage(docker, ctx));
  });
});
