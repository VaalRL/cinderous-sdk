**English** | [繁體中文](README.zh-TW.md)

# Cinderous (`@cinderous/client` + `cinderous-relay`)

> **Private, local-first sync and collaboration over Nostr — between your own devices and small teams.**  
> Same wire format as Nostr. On top of it: one key per device, a Git-like sync layer, WebRTC P2P with relay fallback, and a relay you deploy to your own account in one click.

---

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Nostr NIP-59 | NIP-42](https://img.shields.io/badge/Nostr-NIP--59%20%7C%20NIP--42-8B5CF6?style=flat-square)](https://github.com/nostr-protocol/nips)
[![WebRTC P2P](https://img.shields.io/badge/WebRTC-P2P%20DataChannel-339933?style=flat-square&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![Cloudflare Workers & DO](https://img.shields.io/badge/Cloudflare-Workers%20%26%20DO-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-whoami885-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/whoami885)

---

## 💡 Why Cinderous?

Nostr was designed for **public broadcast**: posts, follows, censorship resistance, and general-purpose relays that keep as much as they can. Local-first apps such as CinderSync and Cinder Coffice need the opposite: **private** data that moves only between devices you own, through a relay nobody has to trust.

Cinderous is **not a fork of Nostr**. Events are plain NIP-01; the client uses NIP-17 / 42 / 44 / 59 / 98 and the relay advertises NIP-01 / 11 / 13 / 40 / 42 / 62. What changes is the purpose, and the layers added on top ([ADR 0065](docs/adr/0065-positioning-private-sync-over-nostr.md)):

| | Typical Nostr | Cinderous |
| :--- | :--- | :--- |
| **Purpose** | Public broadcast | Private sync and collaboration between your devices and small teams |
| **Relay** | General-purpose public store | Your own relay (one-click deploy to your Cloudflare free tier, or Docker / Fly / home tunnel): private path, allowlist, app lanes, retention cap, quotas — and **treated as untrusted** ([ADR 0064](docs/adr/0064-relay-operator-threat-model-and-bundle-hygiene.md)) |
| **Identity** | One key = one public person | One key **per device**, paired into a roster (SAS check); a single device can be removed |
| **Data model** | Immutable event stream | Git-like sync: version graph, three-way merge, conflict callouts, tombstones, offline queue, local history and checkpoints |
| **Transport** | Relay only | Relay + WebRTC P2P (large files, TURN, resumable), falls back to the relay automatically |
| **Encryption** | NIP-44 / NIP-59 per event | The same NIP-44 / NIP-59, plus two optional engines: Cinder EK (epoch keys rotated weekly) and Double Ratchet for live channels, both with an ML-KEM-768 hybrid key exchange |

### What the relay can and cannot see

- **Cannot see:** message and file contents, file names (end-to-end encrypted on the device).
- **Can see:** IP addresses, connection times, message sizes, and recipient pubkeys. Encryption hides content, not metadata.
- **Stores:** encrypted offline messages and file chunks, until the retention cap (`--max-ttl-days`, default 7; file lanes have their own). On Cloudflare they live in Durable Object SQLite; the Node host keeps them in memory unless `--persist`. Once the recipient device has processed and saved a sync message, it tells the relay (inbox ack, `cinder_inbox_ack` in NIP-11) and those copies expire 2 hours later instead ([ADR 0067](docs/adr/0067-inbox-ack-early-expiry.md)).

### Precise security wording

- **Post-quantum hybrid key exchange**, not "quantum-safe": signatures are still secp256k1 (Schnorr), so authentication is not post-quantum.
- **Forward secrecy depends on the engine:** Cinder EK limits exposure to one key epoch (rotated weekly); per-message forward secrecy and post-compromise security come only from the Double Ratchet engine. Neither has had an external audit yet.

---

## 🏛️ Where the Relay Runs

| | Cloudflare edge (Workers + Durable Objects) | Self-hosted (Docker / Fly / home tunnel) | Any public Nostr relay |
| :--- | :--- | :--- | :--- |
| **Setup** | One click from the app (REST API, no Node or wrangler) or `cinderous relay deploy` | `cinderous relay deploy --provider docker` / `fly`, or a `relay build` package | Paste a `wss://` URL |
| **Cost** | $0 within the free tier | Your own hardware | $0 |
| **Allowlist, lanes, quotas** | Yes | Allowlist and quotas (no lanes) | No — the operator decides what is kept |
| **Stored data** | Encrypted, up to the retention cap | In memory, or SQLite with `--persist` | Whatever the operator keeps |

Apps choose; the SDK has no built-in default relay (CinderSync asks you to deploy or paste one).

## 🔐 Dual Pluggable Crypto Engines (Double Ratchet vs Cinder EK)

The Cinderous SDK (`@cinderous/client`) rejects one-size-fits-all cryptography, providing a unified `ICryptoEngine` abstraction for declarative engine selection and adaptive session negotiation:

```
                    ┌──────────────────────────────────────────────┐
                    │     ICryptoEngine Unified Cryptographic API  │
                    └──────────────────────┬───────────────────────┘
                                           │
             ┌─────────────────────────────┴─────────────────────────────┐
             ▼                                                           ▼
┌─────────────────────────────────────────┐ ┌─────────────────────────────────────────┐
│  【Engine A】Cinder Ephemeral Key (EK)  │ │      【Engine B】PQ-Double Ratchet      │
│             (`cinder-ek`)               │ │           (`double-ratchet`)            │
├─────────────────────────────────────────┤ ├─────────────────────────────────────────┤
│ • Primary: CinderSync Vault & Mailbox   │ │ • Primary: Cinder Coffice Live Workspace│
│ • State: Epoch-based / Stateless        │ │ • State: Strictly stateful chained keys │
│ • Superpower: Zero desync, out-of-order │ │ • Superpower: Per-msg FS + PCS Break-in │
│ • Multi-device: O(1) payload + O(N) slot│ │ • Channel: Point-to-point WebRTC Data   │
│ • Crypto: NIP-44 + ML-KEM-768 envelope  │ │ • Crypto: X25519 + ML-KEM hybrid step   │
└─────────────────────────────────────────┘ └─────────────────────────────────────────┘
```

---

## ✅ What Is Implemented

One package, several entry points — import only what you use:

| Entry point | What it gives you |
|---|---|
| `@cinderous/client` | `RelayPool` (many relays at once, NIP-42, reconnect with backoff, durable publish), `Identity`, NIP-17 `DirectMessages`, P2P `connectPeer` / `PeerNode` with relay fallback, Double Ratchet `secureChannel` and Cinder EK, audio / video calls (`CallManager`, mesh group calls) |
| `./sync`, `./sync/vault` | Git-like sync layer and `VaultSyncCoordinator` (snapshots, three-way merge, tombstones, sparse members, version history) |
| `./transfer`, `./pairing`, `./star`, `./durability` | resumable file and stream transfer, QR pairing and vault roster, star (host) groups, relay health and read-back audit |
| `./relay`, `./relay/worker`, `./relay/node` | the Cinderous relay for Cloudflare Workers + Durable Objects or for your own Node host |
| `./deploy`, `./deploy/config`, `./deploy/cloudflare-api` | one-click and config-file deployment (CLI `cinderous`, [web configurator](https://vaalrl.github.io/cinderous-sdk/configurator)) |
| `./iot`, `./iot/device`, `./iot/bridge`, `./iot/push-gateway` | end-to-end encrypted remote control for home devices, plus a push gateway |
| `./protocol`, `./estimator` | shared wire formats, and a cost / quota estimator |

**Every feature, version by version, with its upgrade notes:** [docs/guides/features.md](docs/guides/features.md). What changed in each release: [CHANGELOG.md](CHANGELOG.md).

## 📦 Install

> ⚠ The crypto engines are **experimental**. The Double Ratchet is newly written code that has had one internal independent review but **no external audit**. The post-quantum hybrid protects encryption only — signatures are still secp256k1 — so it defends against "harvest now, decrypt later", and **this is not "quantum-safe"**.

Install from the public GitHub repository, pinned to a tag: `npm install github:VaalRL/cinderous-sdk#v0.92.0` ([ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)).

> ⚠ **Not published on npm.** The `@cinderous` scope on npm belongs to an unrelated account, so any `@cinderous/*` package on the npm registry is **not ours**. Always depend on the GitHub URL with a tag and keep your lockfile. Never write a version range such as `"@cinderous/client": "^0.76.1"`: npm would resolve it from the registry.

### Dependency overrides (recommended): one copy of @noble

nostr-tools (a dependency of this SDK) pins `@noble/curves` / `@noble/hashes` 2.0.1, `@noble/ciphers` 2.1.1 and `@scure/base` 2.0.0, while the SDK uses **2.4.0** for the security fixes ([ADR 0034](docs/adr/0034-noble-2-4-and-consumer-overrides.md)). A library cannot choose its consumers' transitive versions, so **add overrides in your own project** (game, plugin, app). Without them everything still works, but the bundle carries two copies (the game entry grows from 92 KB to 126 KB minified, 34 KB to 47 KB gzip) and nostr-tools keeps using 2.0.1.

Always override the **six** packages together. In particular, do not override `@scure/base` alone: `@scure/bip39` 2.0.1 imports an internal `utils` that `@scure/base` 2.3+ removed, and `nostr-tools/nip06` then fails to load with `SyntaxError: ... does not provide an export named 'utils'`.

npm (`package.json`):
```json
{
  "overrides": {
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "@noble/ciphers": "2.4.0",
    "@scure/base": "2.4.0",
    "@scure/bip32": "2.4.0",
    "@scure/bip39": "2.4.0"
  }
}
```

pnpm 10 (`pnpm-workspace.yaml` at the repo root; pnpm 10.33 ignores `pnpm.overrides` in `package.json` with a warning — on pnpm 9 and earlier put the same map under `"pnpm": { "overrides": { ... } }` in `package.json`):
```yaml
overrides:
  '@noble/curves': 2.4.0
  '@noble/hashes': 2.4.0
  '@noble/ciphers': 2.4.0
  '@scure/base': 2.4.0
  '@scure/bip32': 2.4.0
  '@scure/bip39': 2.4.0
```

Yarn: the same map under `"resolutions"` in `package.json`.

**If anything else in your tree still depends on @noble 1.x** (for example a dev server pulling in `pkijs`, which pins `@noble/hashes` 1.8.0), a top-level override forces that package onto 2.x and it breaks at import time. In that case scope the overrides to nostr-tools instead (npm):
```json
"overrides": {
  "nostr-tools": {
    "@noble/curves": "2.4.0", "@noble/hashes": "2.4.0", "@noble/ciphers": "2.4.0",
    "@scure/base": "2.4.0", "@scure/bip32": "2.4.0", "@scure/bip39": "2.4.0"
  }
}
```
Check first with `npm ls @noble/hashes --all`: if every copy other than nostr-tools' is already 2.x, the top-level form above is fine.

**npm lockfile gotcha**: adding overrides to a project that already has a `package-lock.json` may leave `@scure/bip32` / `@scure/bip39` unresolved (`npm ls` shows them as invalid). Remove the `node_modules/nostr-tools`, `node_modules/@scure/bip32` and `node_modules/@scure/bip39` entries from `package-lock.json` (or delete the lockfile) and run `npm install` again.

Check (each package must list exactly one version, 2.4.0):
```bash
npm ls @noble/curves @noble/hashes @noble/ciphers @scure/base --all   # npm: every entry "deduped" or "overridden"
pnpm why @noble/curves                                                  # pnpm: "Found 1 version of @noble/curves"
```

Optional CI check (npm; fails when a second copy appears):
```js
// scripts/check-noble.mjs — run with: node scripts/check-noble.mjs
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
let failed = false;
for (const name of ['@noble/curves', '@noble/hashes', '@noble/ciphers', '@scure/base']) {
  const copies = Object.entries(lock.packages).filter(([p]) => p.endsWith(`node_modules/${name}`));
  const versions = [...new Set(copies.map(([, m]) => m.version))];
  if (versions.length !== 1) { console.error(`${name}: ${versions.join(', ')}`); failed = true; }
}
process.exit(failed ? 1 : 0);
```

**Performance note**: noble 2.3+ made `getPublicKey` / `sign` slower on purpose (smaller precomputed window, constant-time hardening); verification and ECDH got faster. The SDK does **not** call `secp256k1.Point.BASE.precompute(8)`: it mutates a shared module singleton, costs about 600 KB of heap and 25 ms on the first key operation, and only speeds up `getPublicKey` / `sign` by about 20%. Long-running processes that sign a lot (a relay, a server) can opt in with one line at startup — with a single copy of noble it applies to the SDK and nostr-tools alike:
```ts
import { secp256k1 } from '@noble/curves/secp256k1.js';
secp256k1.Point.BASE.precompute(8);
```

---

## 🚀 Quickstart & Usage

### 1. Zero-Config Mode (Tier 0 Default)
```typescript
import { Identity, PeerNode, RelayPool, secureChannel } from '@cinderous/client';

// Signaling rides public relays inside NIP-59 gift wraps: relays can't tell who is calling whom
const identity = Identity.generate();
const pool = new RelayPool({ urls: ['wss://nos.lol', 'wss://relay.damus.io'], identity });
pool.connect();
const node = new PeerNode({ identity, transport: pool, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

// Tries WebRTC first; after 8 s without a connection it falls back to the relay (kind 20079, 48,000 B frames)
const channel = await node.connectPeer(targetPublicKey);
console.log(channel.mode); // 'p2p-webrtc' or 'relayed-websocket'
await channel.send(new TextEncoder().encode('hello'));

// Per-message forward secrecy on top of the channel (the peer calls secureChannel too)
const secure = await secureChannel(channel, identity);
```
The relay track runs at roughly 160 KB/s; `channel.needsLargePayloadWarning(size)` tells you when to suggest joining the same Wi-Fi.

### 2. Self-Hosted Mode (Tier 1)
Run a relay on your Raspberry Pi, NAS, or Linux server (Node 22+):
```bash
# Memory-only by default (cleared on restart); only listed pubkeys may write
npx cinderous relay start --port 8080 --allowed-pubkeys="npub1alice...,npub1bob..."

# Keep offline messages across restarts with SQLite
npx cinderous relay start --persist --db-path /data/relay.db
```
A malformed allowlist entry stops the relay from starting instead of silently opening it up. Non-allowlisted keys are disconnected with close code 4003 right after AUTH; by default each pubkey may hold 5 connections and each IP may send 20 messages per second (tune with `MAX_CONNECTIONS_PER_PUBKEY` / `MAX_MESSAGES_PER_SECOND_PER_IP`; set `TRUST_PROXY=1` behind a reverse proxy). By default each pubkey may send 120 events per minute and each connection 240 messages per minute (`MAX_EVENTS_PER_MINUTE` / `MAX_MESSAGES_PER_MINUTE`; NIP-11 reports the value in effect as `cinder_max_events_per_minute`). On Node, `0` turns the limit off; on Cloudflare they can only be raised, up to 600 / 1200, because each message is billed. From v0.92.0 a prebuilt multi-arch (amd64 + arm64) image is published at `ghcr.io/vaalrl/cinderous-relay-lite:v<version>` (and `:latest`) by the public repo's release workflow ([ADR 0143](docs/adr/0143-ghcr-relay-image.md)); `cinderous relay build --image` makes the Docker / Fly / home-tunnel package pull it instead of building. Building it yourself (the default) still works.

**Serving `wss://` from a VPS** (domain, automatic HTTPS with Caddy, localhost-only binding, firewall, systemd, maintenance): follow **[docs/guides/self-host-vps.md](docs/guides/self-host-vps.md)** ([ADR 0109](docs/adr/0109-vps-self-host-guide.md)).

**Storage ceiling (SDK ADR 0099).** The Node relay reads the same capacity variables as the Cloudflare relay, with `strict` as the only target: `DO_CEILINGS_MIB=strict=4096/512` caps offline messages at 4 GiB and snapshots at 512 MiB (up to 1 TiB each; default 128/128 MiB). `CEILING_MODE=reject` (default) refuses new messages when full (senders get `blocked: ceiling` and can switch relays); `CEILING_MODE=evict` keeps accepting and drops what expires soonest. `DO_NEAR_FULL_PERCENT`, `DO_DROP_NOTICES`, `DO_BORROW_PERCENT` and (evict only) `DO_GUARANTEE_KIB` work as on Cloudflare. Entries the relay cannot apply are logged at startup and ignored.

**Connection caps (SDK ADR 0100).** `MAX_CONNECTIONS` limits simultaneous connections for the whole relay and `MAX_CONNECTIONS_PER_IP` per source IP (behind a reverse proxy, set `TRUST_PROXY=1`). Both are unlimited when unset, since mobile carriers and offices often share one IP. A connection over the cap gets a `too many connections:` NOTICE and is closed with 1013 (Try Again Later).

**Behind a reverse proxy (SDK ADR 0119).** `TRUST_PROXY=<n>` trusts `n` proxy layers (`1` for Caddy, nginx, Fly or cloudflared) and takes the `n`-th `X-Forwarded-For` entry **from the right**, so a client cannot dodge per-IP limits by prepending its own value. `HOST=127.0.0.1` (or `relay start --host 127.0.0.1`) listens on that address only; unset means all interfaces, as before. Docker: with `node.trustProxy`, the generated `docker-compose.yml` publishes the port on `127.0.0.1` only (Docker-published ports bypass ufw); set `node.bindAddress` to publish elsewhere. See the [VPS guide](docs/guides/self-host-vps.md).

**Monthly traffic budget (SDK ADR 0101).** `MONTHLY_TRAFFIC_GIB=900` caps WebSocket traffic per billing period; `TRAFFIC_RESET_DAY` (1–28, default 1) sets the day it resets at 00:00 UTC and `TRAFFIC_COUNT` chooses `total` (default, both directions) or `out`. Usage is kept in SQLite, so restarts do not reset it. From `TRAFFIC_NEAR_FULL_PERCENT` on, accepted `OK` messages carry a `warning: near-full:` and NIP-11 shows `cinder_traffic.used_percent`. Once the budget is used up, every connection gets an `over quota:` NOTICE and is closed with 1013 until the reset day. The relay only sees WebSocket payloads (TLS and HTTP overhead happen at your reverse proxy), so set the budget to about 90% of your VPS plan.

### 3. Serverless Edge Mode (Tier 2: 1-Click Cloudflare Workers Deployment)

While Cinderous Relay does not lock you into any vendor, the SDK provides **first-class, turnkey 1-click Cloudflare Workers + Durable Objects deployment** for users seeking sub-30ms global edge latency with zero server maintenance.

#### Interactive 1-Click CLI:
```bash
# Signing in to Cloudflare is wrangler's own login (run `npx wrangler@4 login` first, or set CLOUDFLARE_API_TOKEN);
# the Cinderous CLI never runs an OAuth flow or handles your credentials. It then deploys and prints your relay URL.
npx cinderous relay deploy --provider=cloudflare
```

#### Automated / CI/CD Headless CLI:
```bash
npx cinderous relay deploy \
  --provider=cloudflare \
  --name=my-vault-sync-relay \
  --allowed-pubkeys="npub1alice...,npub1bob..." \
  --api-token="$CLOUDFLARE_API_TOKEN" \
  --account-id="$CLOUDFLARE_ACCOUNT_ID" \
  --non-interactive
```

#### Supported CLI Options:
| Flag | Short | Default | Description |
| :--- | :--- | :--- | :--- |
| `--provider` | `-p` | `cloudflare` | `cloudflare`, `docker` (this machine, docker compose), or `fly` (Fly.io) ([ADR 0018](docs/adr/0018-docker-and-fly-providers.md)). |
| `--name` | `-n` | `cinderous-relay` | Cloudflare Worker script and route name. |
| `--allowed-pubkeys`| `-k` | none (warns) | Comma-separated NIP-42 whitelist public keys. |
| `--api-token` | `-t` | env var | Cloudflare API Token with Workers permissions. |
| `--account-id` | `-a` | env var | Cloudflare Account ID. Set it when you have several accounts: wrangler reuses the last one you logged into. |
| `--non-interactive`| `-y` | `false` | Run headlessly without terminal prompts. |
| `--output-env` | `-o` | `.env.cinderous` | Writes the resulting `WSS` endpoint to an env file. |
| `--compatibility-date` | | `2026-09-01` | Cloudflare compatibility date. |
| `--dry-run` | | `false` | Generate config only, don't deploy (cloudflare also test-bundles). |
| `--region` | `-r` | `nrt` | fly: deployment region. |
| `--port` | | `8080` | docker: host port. |
| `--persist` | | `false` | docker / fly: keep offline messages in SQLite on a volume. |
| `--app-lanes` | | none | cloudflare: known app lanes (comma-separated, e.g. `dochost`); changing the list moves the lane to another DO ([ADR 0036](docs/adr/0036-deploy-app-lanes-and-dochost-on-self-hosted-relays.md)). |
| `--file-lanes` | | none | cloudflare: accept file chunks only on these lanes (must be in `--app-lanes`, needs `--max-file-mb`). |
| `--relay-name` / `--relay-description` / `--relay-contact` | | none | NIP-11 name / description / contact. |
| `--max-ttl-days` | | `7` | Offline message retention cap, 1–365. |
| `--max-connections-per-pubkey` | | `5` | Connections per pubkey, 1–100. |
| `--max-messages-per-second-per-ip` | | `20` | Messages per second per IP, 1–1000. |
| `--app-lane-pow` | | `0` | cloudflare: minimum PoW difficulty on lanes, 0–32. |
| `--developer-docs-url` | | none | cloudflare: developer docs URL shown when a connection is refused (https). |
| `--relay-software-url` | | SDK repository | NIP-11 `software` (https): point it at your modified source if you changed the relay (AGPL §13). |
| `--config` | `-c` | none | Deploy from `cinderous.config.json` instead of flags (only `--output-env` / `--dry-run` may be added). |

**NIP-86 admin API on the Node host (SDK ADR 0132).** Off by default. Set `NIP86_ADMIN_PUBKEYS` (operator keys, npub or hex) to accept `POST` requests with `Content-Type: application/nostr+json+rpc` on the relay URL, authorized by NIP-98 with a `payload` tag. Members can only change through `cinder_applyroster`, which takes an organization roster signed by `ROSTER_ADMIN_PUBKEY` and applies it only if it is newer; `allowpubkey`/`banpubkey` are refused. The roster key must not be one of the operator keys, or the relay refuses to start. `ALLOWED_KINDS` (new) sets the kind policy; `allowkind`/`disallowkind` only edit an existing list and never remove the last kind. `changerelayname`/`changerelaydescription` edit NIP-11. With a SQLite file, changes survive restarts and override the environment. The Cloudflare Worker does not offer this API. Set `NIP86_PUBLIC_URL` to the relay's public `https://` URL so that requests must be signed for exactly that URL; it is required behind a reverse proxy, because `X-Forwarded-Host` is not trusted, and without it the signature is only bound to the `Host` header the caller sent (the relay warns at startup). Requests not signed by an operator key are refused before any body is read. A stored roster stops applying if `ROSTER_ADMIN_PUBKEY` is removed or changed, and the relay falls back to `ALLOWED_PUBKEYS` (SDK ADR 0133). A roster event signed by `ROSTER_ADMIN_PUBKEY` and published to the relay is applied the same way as `cinder_applyroster`, so the roster admin does not need an operator key; this works with only `ROSTER_ADMIN_PUBKEY` set, in which case the HTTP admin endpoint stays closed. The roster key can always write to the relay. If `ALLOWED_KINDS` is set, include kind 10038 (SDK ADR 0134). A roster signed by `ROSTER_ADMIN_PUBKEY` can list co-admins (`admins`, live members only): rosters they sign are applied too, but only the roster key can change who the co-admins are, and a co-admin roster that drops any admin from the members is refused (SDK ADR 0135).

**Reconnect guard (SDK ADR 0111, 0131).** On the main plane (`/`, `/s/<n>`, `/presence`; lanes are not affected), each Durable Object counts, per source IP and in memory, connections that close without authenticating: 20 of them in 10 minutes block that IP for 10 minutes. Authenticated connections only count toward a total cap on upgrades (60 in 10 minutes by default, three times the first number), so many people behind one shared IP reconnecting at once are not blocked. Tune with `RECONNECT_GUARD=<max>/<window seconds>/<block seconds>[/<total>]` or turn it off with `off`. A blocked upgrade gets a `rate-limited: too many reconnects…` NOTICE and is closed with 1013, so clients back off. If you add a Cloudflare rate-limit binding named `STRICT_UPGRADE_LIMIT` to your `wrangler.toml`, the Worker also limits upgrades per IP and shard before they reach the Durable Object. The deploy tools do not add it. `DIAG_UNAUTH_LOG=1` logs one line per main-plane connection that closes without authenticating: message verbs, subscribed kinds, the relay's replies, lifetime and close code. It never logs content, pubkeys or IPs. It is off by default.

#### Config file (repeatable deployments, [ADR 0050](docs/adr/0050-deploy-configurator.md)):
Keep every choice in `cinderous.config.json` (validated against `schema/cinderous.config.schema.json`) and deploy the same file every time — a redeploy no longer resets a parameter to its default because a flag was forgotten. Secrets are referenced by environment-variable name only.
```bash
npx cinderous init                                                       # question by question; dangerous options need the option name typed (SDK ADR 0117)
npx cinderous config validate cinderous.config.json
npx cinderous relay build --config cinderous.config.json --out deploy/   # portable package + README-DEPLOY.md / README-DEPLOY.en.md
npx cinderous relay deploy --config deploy/cinderous.config.json
npx cinderous config migrate cinderous.config.json                       # after upgrading the SDK: bump `sdk`, list the changes in between (SDK ADR 0118)
```

`relay deploy --config` also handles the `cloudflare-api` target over REST (it needs `CLOUDFLARE_API_TOKEN`; there is no `--dry-run`). TURN is set with `site.turnKeyId` (and optionally `site.turnTtlSeconds`); the token goes in `.env` as `TURN_API_TOKEN` (or `secrets.turnApiToken: { "$env": "NAME" }`) and is uploaded as a Worker secret — a `secret_text` binding over REST, `wrangler secret put` with the value on stdin otherwise. TURN traffic is billed separately by Cloudflare Realtime. Plugins get the same mapping from `cloudflareApiOptionsFromConfig(config, env)` in `@cinderous/client/deploy/config` ([ADR 0118](docs/adr/0118-turn-secrets-rest-config-deploy-and-migrate.md)).

#### Programmatic SDK Deployment (e.g. from Obsidian Plugins, desktop and mobile):

Use `@cinderous/client/deploy/cloudflare-api` ([ADR 0021](docs/adr/0021-cloudflare-rest-api-deploy.md)). It talks to the Cloudflare REST API directly, needs no Node.js and no wrangler, and ships the relay Worker pre-bundled. `@cinderous/client/deploy` (above) is the Node/CLI path: it imports `node:fs` and `node:child_process` and runs `npx wrangler`, so **do not import it from a plugin**.

Authorization, default flow (no registration needed): open a pre-filled API-token page in the browser, the user clicks **Create Token** in their own dashboard and pastes the token back. Your app stores the token (for example in its `SecretStore`); the SDK never persists it.

Step-by-step instructions for end users (both languages, with troubleshooting per error kind) are in **[docs/guides/cloudflare-api-token.md](docs/guides/cloudflare-api-token.md)**. Render the same text in your UI from `CLOUDFLARE_TOKEN_SETUP_GUIDE` (`'zh-TW'` / `'en'`: `prerequisites`, `steps`, `troubleshooting[error.kind]`) instead of copying it ([ADR 0022](docs/adr/0022-token-setup-guide-as-sdk-data.md)).

Alternatively, if your app registers its own **public Cloudflare OAuth client** (available since 2026-06; requires domain verification), use the PKCE helpers `createPkcePair` / `buildOAuthAuthorizationUrl` / `exchangeOAuthCode` / `refreshOAuthToken` and deploy with `credential: 'oauth'`. The SDK ships no client id of its own.

The Cloudflare API does not send CORS headers, so browser-like runtimes must inject an HTTP function. In Obsidian, wrap `requestUrl`:

```typescript
import { requestUrl } from 'obsidian';
import {
  buildTokenCreationUrl,
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  CloudflareApiError,
  deployCloudflareRelayViaApi,
  verifyToken,
  type HttpFetch,
} from '@cinderous/client/deploy/cloudflare-api';

// requestUrl bypasses CORS; the SDK only needs { status, text() }
const obsidianFetch: HttpFetch = async (url, init) => {
  const body = init.body instanceof Uint8Array ? init.body.slice().buffer : init.body;
  const res = await requestUrl({ url, method: init.method, headers: init.headers, body, throw: false });
  return { status: res.status, text: async () => res.text };
};

// 1. Send the user to a token page with the minimal permissions pre-filled
//    (Workers Scripts: Edit, Account Settings: Read)
window.open(buildTokenCreationUrl()); // token name: DEFAULT_TOKEN_NAME, matching CLOUDFLARE_TOKEN_SETUP_GUIDE

// 2. After the user pastes the token
await verifyToken({ apiToken: token, fetch: obsidianFetch });

// 3. Deploy (re-running it is safe: already-applied Durable Object migrations are not re-sent)
try {
  const { relayEndpoint } = await deployCloudflareRelayViaApi({
    apiToken: token,
    fetch: obsidianFetch,
    workerName: 'my-vault-relay',
    allowedPubkeys: [userPubkey],
    onProgress: (s) => console.log(s.step, s.message),
  });
  console.log('Relay live at:', relayEndpoint); // wss://my-vault-relay.<subdomain>.workers.dev
} catch (e) {
  if (e instanceof CloudflareApiError) {
    const help = CLOUDFLARE_TOKEN_SETUP_GUIDE.en.troubleshooting[e.kind]; // { symptom, cause, fix }
    // e.kind: 'token-invalid' | 'permission' | 'account-ambiguous' (see e.accounts) | 'subdomain-missing'
    //       | 'name-conflict' | 'quota' | 'network' | 'lane-change' (redeploy changed appLanes) | 'health' | 'api'
  }
  throw e;
}
```

If the token can see several accounts, pass `accountId` (the error carries `accounts` to choose from). If the account has no `workers.dev` subdomain yet, pass `workersDevSubdomain` to register one. Site parameters — name, known app lanes (`appLanes`), retention, rate limits — are in `RelaySiteOptions` ([ADR 0037](docs/adr/0037-one-click-deploy-parameters.md)); a REST redeploy replaces the whole configuration, so pass the same values every time.

### 4. Resource Consumption & Cost Estimator (CLI Estimator)
Before deciding on crypto modes (Cinder EK vs Double Ratchet) or cloud deployment, run the actuarial estimator to calculate daily events, bandwidth, and Cloudflare free tier usage:
```bash
# Estimate fan-out multiplier and quota usage for 15 collaborators in PQ-Double Ratchet mode
npx cinderous estimate --mode=double-ratchet --pq --devices=5 --collaborators=15 --daily-actions=500 --payload-kb=20

# Add --json for machine-readable output
```

---

## 📊 Technical Benchmark vs Traditional Nostr Relays

| Dimension | `strfry` | `nostr-rs-relay` | `khatru` | **`cinderous-relay`** |
| :--- | :--- | :--- | :--- | :--- |
| **Architecture** | Stateful Linux Daemon | Stateful Linux Daemon | Go Service Framework | **Serverless Edge + Lite Daemon** |
| **Storage Engine** | Heavy LMDB Disk Storage | SQLite / PostgreSQL | Customizable Storage | **Signals in memory; encrypted offline messages and file chunks kept until the retention cap** |
| **RAM Footprint** | ~100 MB | ~50 MB | ~30 MB | **< 15 MB (Docker) / 0 MB (Edge)** |
| **P2P Signaling** | Unoptimized Generic | Unoptimized Generic | Unoptimized Generic | **Native Ephemeral Rendezvous** |
| **Access Gate** | Open / Paid / PoW | Open / Whitelist | Custom Go Logic | **NIP-42 Auth Challenge Whitelist** |
| **Monthly Cost** | $5 ~ $20 / mo (VPS) | $5 ~ $20 / mo (VPS) | $5 ~ $20 / mo (VPS) | **$0 (within the Cloudflare free tier)** |

---

## 📖 Specifications & Architecture Documents

- [Product Requirements & Architecture Specification (PRD.md)](PRD.md)
- CinderSync (Obsidian vault sync) and Cinder Coffice (Obsidian real-time collaboration) are built on this SDK. Their specifications live in their own repositories, which are not public yet.

---

## ☕ Support & Sponsor

If you find this open-source architecture helpful, please consider starring the repository and supporting our independent research:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-whoami885-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/whoami885)

---

## 📄 License

This project is licensed under the [GNU AGPL-3.0](LICENSE) (changed from MIT on 2026-09-27; see [ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)). Applications that use this SDK must provide corresponding source under the AGPL when distributed or offered over a network.

Documentation site: <https://vaalrl.github.io/cinderous-sdk/>. Contributions are welcome under the DCO; see [CONTRIBUTING.md](CONTRIBUTING.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).
