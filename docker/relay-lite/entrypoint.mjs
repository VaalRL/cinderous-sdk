// SPDX-License-Identifier: AGPL-3.0-only
// ghcr.io/vaalrl/cinderous-relay-lite 的入口（SDK ADR 0143）：以 root 啟動時，先把資料目錄改給 node 使用者，再降權，
// 最後才載入中繼（server.mjs）。中繼本身一律以 node（uid 1000）跑。
//
// 為什麼不在映像寫 `USER node`：既有的 volume 可能屬於 root——`relay build` 自建的映像以 root 跑過、
// Fly 掛上來的 volume 也屬於 root；入口沒有 root 就修不了，保存模式會寫不進資料庫。
// 以 `--user`／Kubernetes runAsUser 非 root 啟動時不做任何事（擁有者由部署方負責）。
// 🔴 符號連結一律不跟（lstat／lchown）；降權失敗就丟錯，絕不以 root 繼續跑。
import * as nodeFs from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只在 Linux 容器裡跑：一律用 POSIX 路徑
const { dirname, join } = posix;

/** node 映像內建的 node 使用者 */
export const NODE_UID = 1000;
export const NODE_GID = 1000;

function chownTree(fs, path, uid, gid) {
  const st = fs.lstatSync(path);
  if (st.uid !== uid || st.gid !== gid) fs.lchownSync(path, uid, gid);
  if (st.isDirectory()) for (const name of fs.readdirSync(path)) chownTree(fs, join(path, name), uid, gid);
}

/**
 * root 啟動 ⇒ 修好 `dataDir` 的擁有者，清掉附加群組，setgid、setuid 降成 node；回 'dropped'。
 * 非 root 啟動 ⇒ 什麼都不做，回 'unprivileged'。
 */
export function dropPrivileges({ proc = process, fs = nodeFs, dataDir, uid = NODE_UID, gid = NODE_GID }) {
  if (proc.getuid() !== 0) return 'unprivileged';
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  chownTree(fs, dataDir, uid, gid);
  // 順序固定：先清附加群組與 gid（降了 uid 之後就沒權限改了），最後才 setuid
  proc.setgroups([]);
  proc.setgid(gid);
  proc.setuid(uid);
  return 'dropped';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  dropPrivileges({ dataDir: dirname(process.env.DB_PATH ?? '/data/relay.db') });
  await import('./server.mjs');
}
