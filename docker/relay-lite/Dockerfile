# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-only
# Cinderous SDK 的 Node 中繼映像 ghcr.io/vaalrl/cinderous-relay-lite（SDK ADR 0143）。
# 公開 repo 推 v* tag 時由 .github/workflows/image.yml 建置推送（amd64＋arm64）。自己建：在 repo 根目錄
#   docker build -f docker/relay-lite/Dockerfile --build-arg RELAY_VERSION=<版號> -t cinderous-relay-lite .
# 設定全部走環境變數（與 `cinderous relay build` 產生的 docker-compose.yml／fly.toml 相同）；保存模式設 PERSIST=1 並掛 /data。

# 基底釘版號＋多架構清單的 digest：同一個 tag 每次建出同樣的基底。升級＝改這一行（版號與 digest 一起改）。
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# 只裝執行用相依、照 lockfile；不跑任何安裝 script（SDK 的 dist/ 已經在 repo 裡，不需要建置）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ARG RELAY_VERSION=0.0.0
LABEL org.opencontainers.image.title="cinderous-relay-lite" \
      org.opencontainers.image.description="Cinderous SDK Node relay (Nostr)" \
      org.opencontainers.image.source="https://github.com/VaalRL/cinderous-sdk" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${RELAY_VERSION}"
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/relay.db RELAY_VERSION=${RELAY_VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY dist ./dist
# 入口與 `relay build` 產生的 server.mjs 同一個產生器；套件自我參照（@cinderous/client/...）解析到 /app 本身
COPY docker/relay-lite/server.mjs ./server.mjs
# 入口以 root 啟動：把 /data（含舊的 root volume）改給 node 後降權，中繼本身以 node 跑。
# 不寫 USER node——那樣入口修不了既有 volume 的擁有者，保存模式會寫不進去。--user 非 root 啟動時入口不做事。
COPY docker/relay-lite/entrypoint.mjs ./entrypoint.mjs
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
# 基底沒有 curl：用 node 自己的 fetch 打 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# node:22 的 node:sqlite 需要這個旗標（保存模式用；純記憶體模式不會載入它）
CMD ["node", "--experimental-sqlite", "entrypoint.mjs"]
