// SPDX-License-Identifier: AGPL-3.0-only
// 推映像時決定要不要一起移動 `latest`（SDK ADR 0143）：只有這個版號是目前最大的正式版才移。
// 補舊版（例如 v0.92.0 之後才推 v0.91.1）或預發布版都不能讓 latest 倒退或指向測試版。
//
// 用法（.github/workflows/image.yml）：node scripts/image-latest.mjs <版號>
//   讀 `git ls-remote --tags --refs origin 'v*'`，把 LATEST=true|false 寫進 $GITHUB_ENV（沒有就印出來）。
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** 正式版（沒有預發布後綴）才回 [major, minor, patch]，否則 undefined */
function parseRelease(version) {
  const m = RELEASE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * `version` 是正式版，而且不小於 `tags` 裡任何一個正式版 ⇒ true。
 * @param {string} version 例如 "0.92.0"
 * @param {readonly string[]} tags 例如 ["v0.91.0", "v0.92.0"]；看不懂的 tag 略過
 */
export function isLatestRelease(version, tags) {
  const mine = parseRelease(version);
  if (!mine) return false;
  for (const tag of tags) {
    const other = parseRelease(tag);
    if (other && compare(other, mine) > 0) return false;
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const version = process.argv[2];
  if (!version) {
    console.error('用法：node scripts/image-latest.mjs <版號>');
    process.exit(2);
  }
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', 'origin', 'v*'], { encoding: 'utf8' });
  const tags = out
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .filter((ref) => ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length));
  const line = `LATEST=${isLatestRelease(version, tags)}`;
  console.log(line);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
}
