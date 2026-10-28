# Deploy configuration reference

> Generated from `DEPLOY_OPTION_SPECS` (`src/deploy/config/specs.ts`) by `npm run docs:reference`. Do not edit by hand.

[繁體中文](deploy-options.zh-TW.md)

Every option of `cinderous.config.json`, the file that holds all choices for one deployment ([ADR 0050](../adr/0050-deploy-configurator.md)). The same rules are in the JSON Schema, [`schema/cinderous.config.schema.json`](../../schema/cinderous.config.schema.json), exported as `@cinderous/client/config.schema.json`.

```sh
npx cinderous config validate cinderous.config.json
npx cinderous relay build --config cinderous.config.json --out deploy/
npx cinderous relay deploy --config deploy/cinderous.config.json
```

- Options under `site.` are relay settings, the same as `RelaySiteOptions`.
- **Flag** is the matching `cinderous relay deploy` flag; options without one can only be set in the config file.
- **Environment variable** is what the relay itself reads, for when you run it without the CLI.
- Secrets are never written into the config file, only as a reference: `{ "$env": "NAME" }`.

## Overview

| Option | Flag | Environment variable |
| --- | --- | --- |
| `configVersion` | — | — |
| `sdk` | — | — |
| `target` | `--provider` | — |
| `service` | — | — |
| `name` | `--name` | — |
| `node.persist` | `--persist` | — |
| `node.port` | `--port` | — |
| `node.trustProxy` | — | — |
| `cloudflare.accountId` | `--account-id` | — |
| `cloudflare.compatibilityDate` | `--compatibility-date` | — |
| `cloudflare.workersDevSubdomain` | — | — |
| `fly.region` | `--region` | — |
| `tunnel.hostname` | — | — |
| `tunnel.cloudflaredImage` | — | — |
| `secrets.cloudflareApiToken` | `--api-token` | — |
| `secrets.flyApiToken` | `--api-token` | — |
| `secrets.tunnelToken` | — | — |
| `pushGateway.android` | — | `PUSH_ANDROID` |
| `pushGateway.ios` | — | `PUSH_IOS` |
| `pushGateway.iosLocKey` | — | `PUSH_IOS_LOC_KEY` |
| `pushGateway.apnsTopic` | — | `APNS_TOPIC` |
| `pushGateway.apnsKeyId` | — | `APNS_KEY_ID` |
| `pushGateway.apnsTeamId` | — | `APNS_TEAM_ID` |
| `pushGateway.apnsEnvironment` | — | `APNS_ENV` |
| `pushGateway.tokenPerHour` | — | `PUSH_TOKEN_PER_HOUR` |
| `pushGateway.tokenPerMinute` | — | `PUSH_TOKEN_PER_MINUTE` |
| `pushGateway.maxSkewSec` | — | `PUSH_MAX_SKEW_SEC` |
| `pushGateway.maxRegistrationDays` | — | `PUSH_MAX_REGISTRATION_DAYS` |
| `secrets.pushGatewayKey` | — | — |
| `secrets.fcmServiceAccount` | — | — |
| `secrets.apnsKey` | — | — |
| `site.allowedPubkeys` | `--allowed-pubkeys` | `ALLOWED_PUBKEYS` |
| `site.privateLane` | — | `LANES_ONLY` |
| `site.readOnlyLanes` | — | `READONLY_LANES` |
| `site.relayName` | `--relay-name` | `RELAY_NAME` |
| `site.relayDescription` | `--relay-description` | `RELAY_DESCRIPTION` |
| `site.relayContact` | `--relay-contact` | `RELAY_CONTACT` |
| `site.relayPubkey` | — | `RELAY_PUBKEY` |
| `site.donations` | — | `DONATE_*` |
| `site.relaySoftwareUrl` | `--relay-software-url` | `RELAY_SOFTWARE_URL` |
| `site.maxTtlDays` | `--max-ttl-days` | `MAX_TTL_DAYS` |
| `site.maxConnectionsPerPubkey` | `--max-connections-per-pubkey` | `MAX_CONNECTIONS_PER_PUBKEY` |
| `site.maxMessagesPerSecondPerIp` | `--max-messages-per-second-per-ip` | `MAX_MESSAGES_PER_SECOND_PER_IP` |
| `site.maxFileMb` | `--max-file-mb` | `MAX_FILE_MB` |
| `site.openFileRelay` | `--open-file-relay` | — |
| `site.appLanes` | `--app-lanes` | `APP_LANES` |
| `site.fileLanes` | `--file-lanes` | `FILE_LANES` |
| `site.appLanePow` | `--app-lane-pow` | `APP_LANE_POW` |
| `site.developerDocsUrl` | `--developer-docs-url` | `DEVELOPER_DOCS_URL` |
| `site.doCeilings` | — | `DO_CEILINGS_MIB` |
| `site.doGuaranteeKib` | — | `DO_GUARANTEE_KIB` |
| `site.doBorrowPercent` | — | `DO_BORROW_PERCENT` |
| `site.doNearFullPercent` | — | `DO_NEAR_FULL_PERCENT` |
| `site.doDropNotices` | — | `DO_DROP_NOTICES` |
| `site.maxConnections` | — | `MAX_CONNECTIONS` |
| `site.maxConnectionsPerIp` | — | `MAX_CONNECTIONS_PER_IP` |
| `site.monthlyTrafficGib` | — | `MONTHLY_TRAFFIC_GIB` |
| `site.trafficResetDay` | — | `TRAFFIC_RESET_DAY` |
| `site.trafficCount` | — | `TRAFFIC_COUNT` |
| `site.trafficNearFullPercent` | — | `TRAFFIC_NEAR_FULL_PERCENT` |
| `site.ceilingMode` | — | `CEILING_MODE` |
| `site.storageBudgetBytes` | — | — |

## Basics

### `configVersion`

Config file format version (currently 1).

- Type: integer, 1

### `sdk`

SDK version that produced this config (written by relay build).

- Type: string, at most 64 characters

### `target`

Deployment target: cloudflare (wrangler), cloudflare-api (REST, for plugins), docker, fly, home-tunnel (home server + Cloudflare Tunnel).

- Type: one of
- Values: `cloudflare`, `cloudflare-api`, `docker`, `fly`, `home-tunnel`
- Flag: `--provider`

### `service`

Which service to deploy: relay (the Cinderous relay, default) or push-gateway (the app developer's reference push gateway; Workers targets = Workers edition, docker / fly / home-tunnel = Node edition; both can reach APNs directly for iOS).

- Type: one of
- Values: `relay`, `push-gateway`
- Default: `relay`

### `name`

Worker / container / Fly app name: lowercase letters, digits and hyphens, not starting with a hyphen, at most 63 characters.

- Type: string
- Format: `^[a-z0-9][a-z0-9-]{0,62}$`
- Default: `cinderous-relay`
- Flag: `--name`

## Access

### `site.allowedPubkeys`

Allowlist: only these public keys (npub or 64-character hex) may write. Empty means an open relay that anyone can use on your quota. Any malformed entry stops the deployment.

- Type: list of public keys (npub or hex)
- Flag: `--allowed-pubkeys`
- Environment variable: `ALLOWED_PUBKEYS`
- Service: `relay`

### `site.privateLane`

Private path (SDK ADR 0051): open writes behind an unguessable random path. The value is a random lane id of at least 26 characters (e.g. `openssl rand -hex 16`), written only as { "$env": "NAME" }. The relay gets APP_LANES = it and LANES_ONLY=1 (plus FILE_LANES = it on Cloudflare with files on) and accepts only wss://&lt;host&gt;/app/&lt;id&gt;; the allowlist becomes optional. 🔴 The URL is a password: if it leaks, deploy again with a new one.

- Type: secret reference `{ "$env": "NAME" }`
- Environment variable: `LANES_ONLY`
- Service: `relay`

### `site.readOnlyLanes`

Read-only grace period (SDK ADR 0052): after the private path changes, the old path stays readable (other devices pick up the move notice there) but rejects writes until it expires, then behaves like an unknown path. The value is `<old lane id>@<expiry unix seconds>` (comma-separated, at most 8, at most 30 days), written only as { "$env": "NAME" } (the old id is a secret too). Expired entries are skipped; the one-click (REST) “new private path” computes it and keeps the live ones that have not expired.

- Type: secret reference `{ "$env": "NAME" }`
- Environment variable: `READONLY_LANES`
- Service: `relay`

## Vault sync

### `site.maxFileMb`

Accept file chunks (kind 1060): required for vault sync, 17 recommended. Without fileLanes it is a site-wide switch. An open relay additionally needs openFileRelay.

- Type: integer, 1–1024
- Flag: `--max-file-mb`
- Environment variable: `MAX_FILE_MB`
- Service: `relay`

### `site.openFileRelay`

Accept file chunks without an allowlist (not recommended: anyone can store data, with no storage limit).

- Type: boolean
- Flag: `--open-file-relay`
- Service: `relay`

⚠️ **Dangerous**: read the description above before you turn it on.

## NIP-11 relay information

### `site.relayName`

NIP-11 relay name. Defaults to the SDK's neutral name.

- Type: string, at most 100 characters
- Flag: `--relay-name`
- Environment variable: `RELAY_NAME`
- Service: `relay`

### `site.relayDescription`

NIP-11 description.

- Type: string, at most 500 characters
- Flag: `--relay-description`
- Environment variable: `RELAY_DESCRIPTION`
- Service: `relay`

### `site.relayContact`

NIP-11 contact (mailto:, a URL or Nostr).

- Type: string, at most 200 characters
- Flag: `--relay-contact`
- Environment variable: `RELAY_CONTACT`
- Service: `relay`

### `site.relayPubkey`

NIP-11 operator public key (npub or hex; stored as hex).

- Type: public key (npub or hex)
- Environment variable: `RELAY_PUBKEY`
- Service: `relay`

### `site.donations`

Donation links (githubSponsors, buyMeACoffee, liberapay, lightning; ≤ 200 characters each). None means no donation card.

- Type: object (see the JSON Schema)
- Environment variable: `DONATE_*`
- Service: `relay`

### `site.relaySoftwareUrl`

NIP-11 software: the source code URL of the program this relay runs (https). Defaults to the SDK repository. If you modified the relay and offer it to others, AGPL §13 requires pointing this at your modified source.

- Type: https URL, at most 200 characters
- Flag: `--relay-software-url`
- Environment variable: `RELAY_SOFTWARE_URL`
- Service: `relay`

### `site.developerDocsUrl`

Developer docs URL included when a connection is refused (https).

- Type: https URL, at most 200 characters
- Flag: `--developer-docs-url`
- Environment variable: `DEVELOPER_DOCS_URL`
- Relay host: Cloudflare (Worker)
- Service: `relay`

## Limits

### `site.maxTtlDays`

Offline message retention cap (days).

- Type: integer, 1–365
- Default: `7`
- Flag: `--max-ttl-days`
- Environment variable: `MAX_TTL_DAYS`
- Service: `relay`

### `site.maxConnectionsPerPubkey`

Maximum connections per public key.

- Type: integer, 1–100
- Default: `5`
- Flag: `--max-connections-per-pubkey`
- Environment variable: `MAX_CONNECTIONS_PER_PUBKEY`
- Service: `relay`

### `site.maxMessagesPerSecondPerIp`

Maximum messages per second per IP; the connection is closed beyond that. Clients that push many events at once must throttle.

- Type: integer, 1–1000
- Default: `20`
- Flag: `--max-messages-per-second-per-ip`
- Environment variable: `MAX_MESSAGES_PER_SECOND_PER_IP`
- Service: `relay`

### `site.maxConnections`

Maximum simultaneous connections for the whole relay; unset = unlimited. Node host only.

- Type: integer, 1–1000000
- Environment variable: `MAX_CONNECTIONS`
- Relay host: Node host
- Service: `relay`

### `site.maxConnectionsPerIp`

Maximum simultaneous connections per IP; unset = unlimited (mobile carriers and offices often share an IP). Node host only.

- Type: integer, 1–10000
- Environment variable: `MAX_CONNECTIONS_PER_IP`
- Relay host: Node host
- Service: `relay`

### `site.monthlyTrafficGib`

Monthly traffic budget (GiB); service pauses until the reset day once used up. Counts WebSocket data only, so set about 90% of your VPS plan. Node host only.

- Type: integer, 1–1048576
- Environment variable: `MONTHLY_TRAFFIC_GIB`
- Relay host: Node host
- Service: `relay`

### `site.trafficResetDay`

Day of month the budget resets at 00:00 UTC (1–28, default 1).

- Type: integer, 1–28
- Environment variable: `TRAFFIC_RESET_DAY`
- Relay host: Node host
- Service: `relay`

### `site.trafficCount`

What counts: total (default, both directions) or out (outbound only).

- Type: one of
- Values: `total`, `out`
- Environment variable: `TRAFFIC_COUNT`
- Relay host: Node host
- Service: `relay`

### `site.trafficNearFullPercent`

Percent of the budget at which OK messages start carrying a warning (50–99).

- Type: integer, 50–99
- Environment variable: `TRAFFIC_NEAR_FULL_PERCENT`
- Relay host: Node host
- Service: `relay`

## App lanes (Cloudflare)

### `site.appLanes`

Known app lanes (e.g. dochost): one Durable Object each. 🔴 Changing the list moves a lane to a new DO; old data is not moved and a rollback does not bring it back.

- Type: list of strings, at most 32 items
- Format: `^[a-z0-9][a-z0-9._-]{0,63}$`
- Flag: `--app-lanes`
- Environment variable: `APP_LANES`
- Relay host: Cloudflare (Worker)
- Service: `relay`

⚠️ **Dangerous**: read the description above before you turn it on.

### `site.fileLanes`

Accept file chunks only on these lanes (must be in appLanes and needs maxFileMb, which then becomes the per-file limit).

- Type: list of strings
- Format: `^[a-z0-9][a-z0-9._-]{0,63}$`
- Flag: `--file-lanes`
- Environment variable: `FILE_LANES`
- Relay host: Cloudflare (Worker)
- Service: `relay`

### `site.appLanePow`

Minimum NIP-13 PoW difficulty on lanes (0 = none). 🔴 Make sure the lane's clients mine first, or all their persistent events are rejected.

- Type: integer, 0–32
- Default: `0`
- Flag: `--app-lane-pow`
- Environment variable: `APP_LANE_POW`
- Relay host: Cloudflare (Worker)
- Service: `relay`

⚠️ **Dangerous**: read the description above before you turn it on.

## Storage capacity

### `site.doCeilings`

Per-DO capacity ceilings (MiB), keyed by strict / public / lane / file or a single DO name. Account total = ceiling × number of DOs; guard it with storageBudgetBytes. Cloudflare: 1–8192 each; Node host: strict only, 1–1048576 (1 TiB).

- Type: object (see the JSON Schema)
- Environment variable: `DO_CEILINGS_MIB`
- Service: `relay`

### `site.doGuaranteeKib`

Guaranteed share per author / recipient in shared DOs (KiB). Evicting classes only.

- Type: object (see the JSON Schema)
- Environment variable: `DO_GUARANTEE_KIB`
- Service: `relay`

### `site.doBorrowPercent`

Overflow band (percent borrowed above the ceiling); evicting classes also need a guarantee.

- Type: object (see the JSON Schema)
- Environment variable: `DO_BORROW_PERCENT`
- Service: `relay`

### `site.doNearFullPercent`

Coarse near-full warning threshold (%).

- Type: object (see the JSON Schema)
- Environment variable: `DO_NEAR_FULL_PERCENT`
- Service: `relay`

### `site.doDropNotices`

Targets with dropped-message counts enabled.

- Type: list of strings
- Environment variable: `DO_DROP_NOTICES`
- Service: `relay`

### `site.ceilingMode`

When full: reject (default) or evict (drop what expires soonest). Node host only.

- Type: one of
- Values: `reject`, `evict`
- Environment variable: `CEILING_MODE`
- Relay host: Node host
- Service: `relay`

### `site.storageBudgetBytes`

Account storage budget (bytes): deployment is refused if the worst case across all possible DOs exceeds it. Free plan: 4,000,000,000 (80% of 5 GB) recommended.

- Type: integer, at least 1
- Relay host: Cloudflare (Worker)
- Service: `relay`

## Hosting

### `node.persist`

Keep offline messages in SQLite on a volume; default is memory-only (cleared on restart).

- Type: boolean
- Default: `false`
- Flag: `--persist`
- Targets: `docker`, `fly`, `home-tunnel`
- Service: `relay`

### `node.port`

docker: host port.

- Type: integer, 1–65535
- Default: `8080`
- Flag: `--port`
- Targets: `docker`

### `node.trustProxy`

Trust X-Forwarded-For from a proxy in front (TRUST_PROXY=1). For docker only behind a reverse proxy; always on for fly and home-tunnel.

- Type: boolean
- Default: `false`
- Targets: `docker`, `fly`, `home-tunnel`
- Service: `relay`

⚠️ **Dangerous**: read the description above before you turn it on.

### `cloudflare.accountId`

Cloudflare Account ID (32 hex characters; not a secret). Set it when you have several accounts: wrangler reuses the last one you logged into.

- Type: string, or `{ "$env": "NAME" }`
- Format: `^[0-9a-f]{32}$`
- Flag: `--account-id`
- read from: `CLOUDFLARE_ACCOUNT_ID`
- Targets: `cloudflare`, `cloudflare-api`

### `cloudflare.compatibilityDate`

Workers compatibility_date (YYYY-MM-DD). Recorded in the config so it does not change with CLI upgrades.

- Type: string
- Format: `^\d{4}-\d{2}-\d{2}$`
- Default: `2026-09-01`
- Flag: `--compatibility-date`
- Targets: `cloudflare`, `cloudflare-api`

### `cloudflare.workersDevSubdomain`

workers.dev subdomain (the account part). The REST path registers it when the account has none; the deploy guide uses it to spell out the full URL.

- Type: string
- Format: `^[a-z0-9][a-z0-9-]{0,62}$`
- Targets: `cloudflare`, `cloudflare-api`

### `fly.region`

Fly region code (e.g. nrt, sin, iad).

- Type: string
- Format: `^[a-z]{3}$`
- Default: `nrt`
- Flag: `--region`
- Targets: `fly`

### `tunnel.hostname`

Public hostname (e.g. relay.example.com, under a domain on Cloudflare). Clients connect to wss://&lt;this name&gt;.

- Type: string
- Format: `^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`
- Targets: `home-tunnel`
- Required for: `home-tunnel`

### `tunnel.cloudflaredImage`

cloudflared image. Pin a version or digest for reproducible deployments (e.g. cloudflare/cloudflared:2026.9.0).

- Type: string
- Format: `^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$`
- Default: `cloudflare/cloudflared:latest`
- Targets: `home-tunnel`

## Secrets

### `secrets.cloudflareApiToken`

Environment variable holding the Cloudflare API token. Defaults to CLOUDFLARE_API_TOKEN; without one, wrangler's own login (wrangler login) is used.

- Type: secret reference `{ "$env": "NAME" }`
- Flag: `--api-token`
- Secret: only `{ "$env": "NAME" }` in the config file; read from `CLOUDFLARE_API_TOKEN`
- Targets: `cloudflare`, `cloudflare-api`

### `secrets.flyApiToken`

Environment variable holding the Fly API token. Defaults to FLY_API_TOKEN; without one, flyctl's own login (fly auth login) is used.

- Type: secret reference `{ "$env": "NAME" }`
- Flag: `--api-token`
- Secret: only `{ "$env": "NAME" }` in the config file; read from `FLY_API_TOKEN`
- Targets: `fly`

### `secrets.tunnelToken`

Environment variable holding the Cloudflare Tunnel token (used by cloudflared; put it in the package's .env and never commit it).

- Type: secret reference `{ "$env": "NAME" }`
- Secret: only `{ "$env": "NAME" }` in the config file; read from `TUNNEL_TOKEN`
- Targets: `home-tunnel`
- Required for: `home-tunnel`

### `secrets.pushGatewayKey`

Environment variable holding the push gateway's private key (generate with cinderous iot push-keygen). Rotating it invalidates every app's token envelope; apps must re-register.

- Type: secret reference `{ "$env": "NAME" }`
- Secret: only `{ "$env": "NAME" }` in the config file; read from `PUSH_GATEWAY_KEY`
- Service: `push-gateway`

### `secrets.fcmServiceAccount`

Environment variable holding the Firebase service account JSON (the whole JSON on one line). Required for Android or iOS via FCM.

- Type: secret reference `{ "$env": "NAME" }`
- Secret: only `{ "$env": "NAME" }` in the config file; read from `FCM_SERVICE_ACCOUNT`
- Service: `push-gateway`

### `secrets.apnsKey`

Environment variable holding the APNs .p8 key contents (newlines written as \n). Required for direct APNs (pushGateway.ios=apns, Workers and Node editions); on Workers you can also pipe the .p8 file straight into wrangler secret.

- Type: secret reference `{ "$env": "NAME" }`
- Secret: only `{ "$env": "NAME" }` in the config file; read from `APNS_KEY`
- Service: `push-gateway`

## Push gateway

### `pushGateway.android`

Android: high-priority empty data messages via FCM (needs a Firebase service account). When off, Android apps should use UnifiedPush instead (no push gateway needed).

- Type: boolean
- Default: `true`
- Environment variable: `PUSH_ANDROID`
- Service: `push-gateway`

### `pushGateway.ios`

iOS: apns = talk to APNs directly (the default since v0.48.0; both the Workers and Node editions, no Google, needs an APNs key); fcm = through Firebase to APNs (deprecated: Google also sees when iOS devices are woken); off = no iOS (use it for Android-only deployments; no Apple key needed).

- Type: one of
- Values: `apns`, `fcm`, `off`
- Default: `apns`
- Environment variable: `PUSH_IOS`
- Service: `push-gateway`

### `pushGateway.iosLocKey`

Localization key for the iOS alert (uppercase letters, digits, underscores): the push carries no text; the app's Localizable.strings supplies a generic phrase, which the NSE rewrites after decrypting.

- Type: string
- Format: `^[A-Z][A-Z0-9_]{0,63}$`
- Default: `CINDER_WAKE`
- Environment variable: `PUSH_IOS_LOC_KEY`
- Service: `push-gateway`

### `pushGateway.apnsTopic`

Direct APNs: the app's bundle id (apns-topic).

- Type: string
- Format: `^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`
- Environment variable: `APNS_TOPIC`
- Service: `push-gateway`

### `pushGateway.apnsKeyId`

Direct APNs: the Key ID of the .p8 key (10 characters; not a secret).

- Type: string
- Format: `^[A-Z0-9]{10}$`
- Environment variable: `APNS_KEY_ID`
- Service: `push-gateway`

### `pushGateway.apnsTeamId`

Direct APNs: the Apple Developer Team ID (10 characters).

- Type: string
- Format: `^[A-Z0-9]{10}$`
- Environment variable: `APNS_TEAM_ID`
- Service: `push-gateway`

### `pushGateway.apnsEnvironment`

Direct APNs: production (App Store / TestFlight) or sandbox (development builds installed from Xcode).

- Type: one of
- Values: `production`, `sandbox`
- Default: `production`
- Environment variable: `APNS_ENV`
- Service: `push-gateway`

### `pushGateway.tokenPerHour`

Maximum wakes per push token per hour (ruling 7, default 60), across all senders (devices, IoT gateways, relays).

- Type: integer, 1–3600
- Default: `60`
- Environment variable: `PUSH_TOKEN_PER_HOUR`
- Service: `push-gateway`

### `pushGateway.tokenPerMinute`

Maximum wakes per push token per minute (default 6 = the instant-mode limit; defence in depth, senders already coalesce and throttle).

- Type: integer, 1–60
- Default: `6`
- Environment variable: `PUSH_TOKEN_PER_MINUTE`
- Service: `push-gateway`

### `pushGateway.maxSkewSec`

Maximum clock difference (seconds) between a wake request's timestamp and the gateway (the replay window; devices need NTP).

- Type: integer, 30–3600
- Default: `300`
- Environment variable: `PUSH_MAX_SKEW_SEC`
- Service: `push-gateway`

### `pushGateway.maxRegistrationDays`

Maximum lifetime of a token envelope in days (ADR-0272: 30 days; apps renew on launch). Longer envelopes are refused.

- Type: integer, 1–30
- Default: `30`
- Environment variable: `PUSH_MAX_REGISTRATION_DAYS`
- Service: `push-gateway`
