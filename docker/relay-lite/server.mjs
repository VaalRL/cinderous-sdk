// SPDX-License-Identifier: AGPL-3.0-only
// ghcr.io/vaalrl/cinderous-relay-lite 的入口（SDK ADR 0143）。與 `relay build` 產生的 server.mjs 同一個產生器（renderServerEntry）；
// 改了產生器就要重新產生這個檔：tests/deploy/relay-image.test.ts 會擋。
import { setRelayVersion } from '@cinderous/client/relay';
import { startNodeRelay } from '@cinderous/client/relay/node';

setRelayVersion(process.env.RELAY_VERSION ?? '0.0.0');
// PERSIST=1 才寫 SQLite（DB_PATH 在掛好的 volume 上）；否則純記憶體，重啟即清空（SDK ADR 0008）
startNodeRelay(process.env, { memory: process.env.PERSIST !== '1' });
