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

## ✅ What Is Implemented (v0.55)

> ⚠️ **Upgrade note: v0.48.0 is breaking for the push gateway** ([ADR 0062](docs/adr/0062-push-gateway-ios-default-apns.md))
>
> - `pushGateway.ios` / `PUSH_IOS` **now defaults to `"apns"`** on both the Workers and Node editions (up to v0.47, unset meant `fcm`). A config that leaves `ios` unset and only has FCM gets `required` errors from `validateDeployConfig` and `relay build` writes no package; an already-deployed gateway redeployed on v0.48 answers 503 `not-configured` (Workers) or fails to start (Node). Pick one:
>   1. add `pushGateway.apnsTopic`, `apnsKeyId`, `apnsTeamId` and `secrets.apnsKey` (recommended: iOS talks to APNs directly, no Google);
>   2. Android only: set `pushGateway.ios: "off"` (no Apple key needed);
>   3. keep going through FCM: set `pushGateway.ios: "fcm"` explicitly — same behaviour as v0.47, but **deprecated on both editions** (warning `push-ios-fcm-deprecated`, startup log `ios-via-fcm-deprecated`).
> - Switching from `fcm` to `apns` (including through the new default) has **no transition period**: existing iOS registrations (sealed FCM tokens) get 501 `platform-disabled` and the gateway never falls back to Google; they resume once the app is opened, sees `ios: "apns"` in `/v1/info` and re-registers.
> - When APNs returns an error the gateway log now carries `apnsReason` (the codes Apple documents, anything else is `other`; never in the response); `403 BadEnvironmentKeyInToken` now yields the result code `key-environment` instead of `auth` (the APNs key is restricted to Sandbox or Production; match `apnsEnvironment` or create a key for both environments).
> - Wire formats (token envelope, wake request, `/v1/info` fields) are unchanged; devices need not upgrade together.

Everything below is shipped and tested. Design records live in [`docs/adr/`](docs/adr/README.md).

- **Client**: multi-relay pool, NIP-17 direct messages, blocklist, identity, cost estimator ([ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)).
- **Relay**: `@cinderous/client/relay` (core), `/relay/worker` (Cloudflare), `/relay/node` (Node host) — the same relay that runs Cinderous' anchors ([ADR 0007](docs/adr/0007-relay-and-shared-protocol-move-into-sdk.md)).
- **Allowlist, memory-only mode, `cinderous` CLI, one-click deploy** ([ADR 0008](docs/adr/0008-allowlist-memory-mode-and-cli.md)).
- **Peer connections `connectPeer`**: NIP-59 signaling, WebRTC DataChannel, automatic fallback to the relay ([ADR 0009](docs/adr/0009-peer-connection-and-relay-fallback.md)).
- **Crypto engines** ([ADR 0010](docs/adr/0010-crypto-engines-cinder-ek-and-double-ratchet.md)): `CinderEkKeyring` (weekly key rotation with forward secrecy, post-quantum hybrid, downgrade pinning) and `secureChannel` (Double Ratchet with a post-quantum hybrid step, for live channels only; since v0.28 the post-quantum wire format carries ML-KEM material only once per round, so a PQ message header is 50 bytes instead of 2,314 — [ADR 0033](docs/adr/0033-pq-ratchet-header-cost.md)).
- **Engine presets and negotiation** ([ADR 0014](docs/adr/0014-engine-presets-and-negotiation.md)): `chooseEngine({ preset: 'vault-sync' | 'live-collaboration' | 'auto-negotiate', … })`; peers declare support with a `crypto_engines` tag on their EK announce.
- **Audio/video calls `CallManager`** ([ADR 0016](docs/adr/0016-audio-video-calls.md)): same signaling as the Cinderous app (kind 21002, NIP-59); switch between audio and video mid-call without renegotiation; failures are reported as "unreachable" or "lost".
- **TURN credentials `TurnProvider`** ([ADR 0017](docs/adr/0017-turn-credentials.md)): fetches short-lived TURN credentials from a relay's `/turn` endpoint (NIP-98 signed), refreshes them before expiry, and plugs into `CallManager` / `PeerNode` via `iceServers: turn.iceServers`.
- **File transfer `FileTransfer`** ([ADR 0015](docs/adr/0015-file-transfer-and-resume.md)): runs over `connectPeer` or `secureChannel` channels; resumes after disconnects, verifies the whole file with SHA-256, and refuses files over 20 MB on the relay track unless you opt in. `P2PFileQueue` holds large files until a direct P2P connection is available. Also importable from the `@cinderous/client/transfer` subpath (v0.21, [ADR 0023](docs/adr/0023-transfer-subpath-and-nostr-signer.md)) — same implementation as the main entry.
- **Multi-device sync `@cinderous/client/sync`** ([ADR 0011](docs/adr/0011-multi-device-sync.md)): encrypted snapshots, file chunks, three-way line merge, file tombstones, fast hydration, zero-knowledge push guard.
- **No raw private key needed** (v0.21, [ADR 0023](docs/adr/0023-transfer-subpath-and-nostr-signer.md)): every sync/protocol API that took a raw `SecretKey` (`buildSnapshotEvent`, `openSnapshotEvent`, `wrapFileChunk`, `sealAndWrap`/`openWrap`, signaling, device directory, EK envelope, …) now also accepts an `Identity` — or any `NostrSigner` (`pubkey`, `sign`, `conversationKey`). The old call style is unchanged and both interoperate on the wire.
  ```typescript
  import { buildSnapshotEvent, openSnapshotEvent } from '@cinderous/client/sync';
  const event = buildSnapshotEvent(JSON.stringify(state), identity, deviceId);
  const restored = openSnapshotEvent(event, identity);
  ```
- **Async chat storage** (v0.21, [ADR 0024](docs/adr/0024-async-chat-storage.md)): `DirectMessages` and `Blocklist` accept an `AsyncChatStorage` (promise-returning `getItem`/`setItem`, e.g. IndexedDB) as well as the synchronous `ChatStorage` (`localStorage`). Loading happens in the background (`await ready()`), writes are queued one at a time and always persist the latest state (`await flush()`), and a failed read never overwrites stored history. `MemoryAsyncChatStorage` is provided for tests. Synchronous storage behaves exactly as before.
  ```typescript
  const blocklist = new Blocklist(indexedDbStore);
  await blocklist.ready(); // load the blocklist before opening the inbox
  const dms = new DirectMessages({ transport: pool, identity, storage: indexedDbStore, isBlocked: (pk) => blocklist.has(pk) });
  await dms.ready();
  ```
- **Vault sync coordinator `@cinderous/client/sync/vault`** (v0.22, [ADR 0025](docs/adr/0025-vault-sync-coordinator.md)): folder-level sync shared by CinderSync and Cinder Coffice. No Node built-ins; the file system (`VaultAdapter`), state storage (`SyncStateStore`), clock and network are injected, and the identity is any `NostrSigner`. It keeps a path → version index and a per-file version graph, stores the merge bases for `merge3`, queues outgoing changes persistently (offline edits are coalesced, resent after reconnect or restart, retried with backoff), applies remote changes with preconditions so a local edit is **never silently overwritten**, suppresses loopback by content hash, treats a rename as one operation (a concurrent edit follows the file to its new name), keeps a concurrent edit over a delete, and writes a conflict copy (`conflictCopyName`) when two edits can't be merged. Merges are deterministic, so every device converges on the same tree — checked by a seeded randomized property test (devices editing, renaming, deleting, going offline, restarting over a lossy, reordering relay). Files above the file-chunk tier are marked "pending P2P" and, with `peers`, delivered over P2P (v0.23, see below). On the wire it reuses the kind 1060 gift-wrap envelope with a new inner kind, which older clients ignore.
  ```typescript
  import { App, TFile, normalizePath } from 'obsidian';
  import { createNostrVaultTransport, VaultSyncCoordinator, type VaultAdapter, type SyncStateStore } from '@cinderous/client/sync/vault';

  // Obsidian Vault → VaultAdapter (paths are vault-relative, '/'-separated)
  function obsidianVault(app: App): VaultAdapter {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const get = (p: string) => {
      const f = app.vault.getAbstractFileByPath(normalizePath(p));
      return f instanceof TFile ? f : null;
    };
    const bytesOf = async (f: TFile | null) => (f ? new Uint8Array(await app.vault.readBinary(f)) : null);
    const ensureFolder = async (p: string) => {
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
    };
    return {
      list: async () => app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
      read: async (p) => (await bytesOf(get(p))) ?? Promise.reject(new Error(`missing ${p}`)),
      stat: async (p) => {
        const f = get(p);
        return f ? { path: f.path, size: f.stat.size, mtime: f.stat.mtime } : null;
      },
      async write(p, bytes, expect) {
        const f = get(p);
        if (!f) {
          if (expect && !expect(null)) return false;
          await ensureFolder(p);
          await app.vault.createBinary(normalizePath(p), bytes.slice().buffer);
          return true;
        }
        if (f.extension === 'md') {
          // vault.process = atomic read-check-write: a keystroke in between is never overwritten
          let ok = true;
          await app.vault.process(f, (data) => {
            if (expect && !expect(enc.encode(data))) {
              ok = false;
              return data;
            }
            return dec.decode(bytes);
          });
          return ok;
        }
        if (expect && !expect(await bytesOf(f))) return false;
        await app.vault.modifyBinary(f, bytes.slice().buffer);
        return true;
      },
      async remove(p, expect) {
        const f = get(p);
        if (!f) return true;
        if (expect && !expect(await bytesOf(f))) return false;
        await app.fileManager.trashFile(f); // honours the user's trash setting
        return true;
      },
      async rename(from, to, expect) {
        const f = get(from);
        if (!f || get(to)) return false;
        if (expect && !expect(await bytesOf(f))) return false;
        await ensureFolder(to);
        await app.vault.rename(f, normalizePath(to)); // not fileManager.renameFile: links were already updated on the other device
        return true;
      },
    };
  }

  const identity = await loadOrCreateIdentity(secretStore);
  const pool = new RelayPool({ urls: [relayUrl], identity });
  pool.connect();
  const transport = createNostrVaultTransport({ pool, signer: identity, devices: otherDevicePubkeys });
  const sync = new VaultSyncCoordinator({
    adapter: obsidianVault(this.app),
    store: myIndexedDbStore satisfies SyncStateStore, // get/set/delete/keys(prefix), Uint8Array values
    transport,
    deviceId: settings.deviceId, // stable per device
    deviceLabel: settings.deviceName, // shown in conflict-copy file names
    ignore: (p) => p.startsWith('.obsidian/') || p.startsWith('.trash/'),
  });
  sync.on('status', (s) => statusBar.setText(`CinderSync: ${s.state} (${s.queue})`));
  sync.on('conflict', (c) => new Notice(`Conflict in ${c.path}${c.copyPath ? ` → ${c.copyPath}` : ''}`));
  await sync.start(); // loads state, scans for offline changes, starts sending
  // Debounce these (e.g. 500 ms per path); writes the coordinator made itself are recognised by hash and ignored.
  this.registerEvent(this.app.vault.on('modify', (f) => sync.notifyLocalChange(f.path, 'modify')));
  this.registerEvent(this.app.vault.on('create', (f) => sync.notifyLocalChange(f.path, 'create')));
  this.registerEvent(this.app.vault.on('delete', (f) => sync.notifyLocalChange(f.path, 'delete')));
  this.registerEvent(this.app.vault.on('rename', (f, old) => sync.notifyLocalChange(f.path, 'rename', old)));
  // Waking up on mobile: new FastHydrator({ pool, filters: transport.filters(), onEvents: (e) => transport.ingestEvents(e), … })
  ```

- **P2P batch streaming and large-file streaming** (v0.23, [ADR 0026](docs/adr/0026-p2p-batch-stream-and-large-file-streaming.md)): `StreamTransfer` (in `@cinderous/client/transfer`, not in the main entry) sends many files as **one stream** over any `connectPeer` / `secureChannel` channel. Small files are coalesced into few messages; each file is SHA-256 verified; a credit window gives back-pressure so memory stays constant regardless of file size (measured: 16 MB and 128 MB files both peak at ~1 MB in flight). Files above the inline limit are written chunk by chunk into an injected `StreamingFileStore`, resume from the bytes already received (even after an app restart), and are committed atomically only after verification (`commit`, otherwise discarded). The wire format is new (marker `0xCB` plus a version byte), so older `FileTransfer` peers ignore it. `P2PStreamQueue` is the persistent "wait for P2P" queue: `restore()` after a restart and `open()` re-opens the files.
  - The vault coordinator uses it when you pass `peers` (`peerNodeLink({ node, devices })`): a new device joining or a bulk change (≥ 10 pending versions) goes over one P2P batch instead of one kind 1060 event per file per device (which could exceed the relay's 4,000-events-per-recipient quota); files above the file-chunk tier are pushed directly over P2P and written with `VaultAdapter.writeStream` when available. Fallback: WebRTC → relay track (kind 20079, ephemeral, small files only) → rate-limited kind 1060 (20/hour by default, under the quota). Everything received over P2P is validated exactly like relay messages (safe paths, sender bound to the authenticated channel, sizes and hashes).
  ```typescript
  import { peerNodeLink, VaultSyncCoordinator } from '@cinderous/client/sync/vault';
  const node = new PeerNode({ identity, transport: pool, acceptFrom: (pk) => Object.values(devices).includes(pk) });
  const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, peers: peerNodeLink({ node, devices }) });
  ```
- **Relays must accept file events for vault sync** (v0.23, [ADR 0027](docs/adr/0027-relay-file-events-for-vault-sync.md)): the coordinator's envelope is kind 1060, which a Cinderous relay rejects unless `MAX_FILE_MB` is set. All deploy paths (REST one-click, wrangler, Docker, Fly, `cinderous relay deploy|start --max-file-mb`) now take `maxFileMb` — use `VAULT_SYNC_MAX_FILE_MB` (17); an open relay (no allowlist) additionally requires `openFileRelay: true`. The default stays off. When every relay rejects with that reason the coordinator reports `status().blocked === 'relay-rejects-files'` (one `error` event, slow probing instead of retry storms; with `peers` it keeps syncing over P2P). `checkRelayAcceptsFiles(url)` reads NIP-11 `cinder_accepts_files` so plugins can warn before connecting.
- **QR device pairing and vault roster `@cinderous/client/pairing`** (v0.24, [ADR 0028](docs/adr/0028-qr-device-pairing-and-vault-roster.md)): adds a new device to a vault **without copying any private key** — every device keeps its own identity. The SDK only produces and parses the QR string (`cinderous-pair:1.…`, ≤ 213 bytes = QR version 10 at error-correction level M; typically version 8); rendering and scanning the image is up to the app. Either side can show the QR (`invite`: a member shows it, the new phone scans; `join`: the new device shows it, an existing phone scans). The handshake mixes the one-time 128-bit secret from the QR, an ephemeral ECDH and both identity keys, runs over NIP-59 gift wraps on a new ephemeral kind 21003, and ends with a **6-digit SAS that both screens show and both users must confirm**. The QR is one-time and short-lived (5 min); if a second device uses the same QR the session is voided (`contested`). The result is a `VaultMembership` (the first device starts one with `VaultMembership.create({ signer: identity })`; every roster entry is signed, and a device's own id and name are self-signed so other members cannot rewrite them): the trusted device list plus a shared vault key (the sync coordinator itself only needs the list; the key is for the app's own symmetric needs). It feeds `NostrVaultTransport` (`peerPubkeys()`, new `setDevices()` and `deviceOf`), `peerNodeLink` (`peerDevices()`, `devices` may now be a function) and your relay allowlist (`allowedPubkeys()`). `revoke()` removes a device and rotates the key; the revoked device gets nothing new, but **what it already synced cannot be taken back**. `NostrRosterSync` propagates roster changes (kind 1060 envelope by default, `outerKind: 1059` since v0.35; inner kind 4361); the coordinator's new `resync()` re-sends a digest when a device joins.
  - Relay fix (same release): allowlisted relays rejected every gift wrap (the outer author is a one-time key), including vault sync. A connection authenticated (NIP-42) as an allowlisted pubkey may now publish them. Redeploy your relay to pick this up.
  ```typescript
  import { acceptPairingUri, createPairingOffer, NostrRosterSync, parsePairingUri } from '@cinderous/client/pairing';
  // Existing device (member) shows the QR
  const offer = createPairingOffer({ role: 'invite', signer: identity, pool, membership, relays: settings.relayUrls, device: { label: 'Desktop' } });
  showQr(offer.uri);
  const { sas } = await offer.ready;   // show it, ask the user to compare with the phone
  offer.confirm();
  // New device scans it
  const scan = acceptPairingUri(scanned, { signer: identity, pool: new RelayPool({ urls: parsePairingUri(scanned).relays, identity }) });
  await scan.ready; scan.confirm();
  const { membership } = await scan.result; // store membership.toJSON() in secret storage, not data.json
  ```
- **Aligned with relay file lanes: 30 MB per file, limits and backfill budget from NIP-11, paginated fetch** (v0.25, [ADR 0029](docs/adr/0029-file-lanes-alignment.md); mirrors Cinderous ADR-0371)
  - **Client**: `fetchRelayFilePolicy(url)` (same result as `checkRelayAcceptsFiles`) reads NIP-11 **at the same path** (`wss://<host>/app/<lane>` → `GET https://<host>/app/<lane>`) and returns `maxFileMb` (`cinder_max_file_mb`), `fileChunksPerRecipient` (`cinder_file_chunks_per_recipient`) and `retentionSeconds`. `loadRelayFileLimits(urls)` combines every relay into the **strictest** limits (unreadable relays count as unknown and get conservative defaults: 16.5 MB / 848 chunks / 7 days); pass them as the coordinator's `relayLimits` option or to `setRelayLimits()`. The per-file relay ceiling follows the relay (the anchor's file lanes: 30 MB = 656 chunks; receivers cap at 64 MiB), and bulk backfill is now counted in **chunks**: within any retention window a device sends a recipient at most quota × 0.75 chunks (1,440 / 7 days → 1,080, about 6.4 per hour), so it never evicts chunks the recipient has not fetched yet; usage survives restarts and shows in `status().relayQuota`. 🔴 Before raising the per-file ceiling above 16.5 MB, every device in the vault must run v0.25 (older receivers only accept 16.5 MB).
  - **Pagination**: a relay caps each REQ by bytes (16 MB) and silently drops the oldest overflow. `forEachPage` / `queryPaged` (`./sync`) walk back with `until` = the oldest `created_at` of each page until a page brings nothing new; `FastHydrator` paginates by default and `NostrVaultTransport` backfills with pagination on start and on reconnect (`backfill()`; needs a pool with `query`).
  - **Relay** (`./relay`) ports Cinderous main's ADR-0371 item by item: `FILE_LANES` (lane mode: only lanes that are also in `APP_LANES` accept kind 1060 and `MAX_FILE_MB` becomes the per-file limit; unset = unchanged), `filePolicyFor`, persisted lane id, the two new NIP-11 fields, the file-lane quota (2 × max-file chunks + 128) and a 1 GiB ceiling per lane DO, the storage fixes (`bytes` column, covering index, cached usage, de-duplicated `p` tags, file bucket always trimmed) and a 16 MB byte budget per REQ. The DO SQLite schema is byte-for-byte identical to Cinderous main (switching the same DO from Cinderous' build to the SDK's is tested). No anchor-specific values in SDK defaults.
  - **One-click deploy `maxFileMb`**: deploys a self-hosted single-owner relay (allowlist, no lanes), where `MAX_FILE_MB` is a **site-wide switch** — the number is not enforced and NIP-11 declares no per-file limit. Set `FILE_LANES` yourself only for a multi-tenant Cloudflare relay.
  ```typescript
  import { loadRelayFileLimits, VaultSyncCoordinator } from '@cinderous/client/sync/vault';
  const limits = await loadRelayFileLimits(['wss://relay.example/app/cindersync']);
  sync.setRelayLimits(limits); // or new VaultSyncCoordinator({ …, relayLimits: limits })
  ```
- **Multi-party star sessions `@cinderous/client/star`** (v0.26, [ADR 0030](docs/adr/0030-star-session.md); Cinder Coffice G4): one Host and up to 64 members (16 by default), each member holding its own pairwise `secureChannel` (Double Ratchet) with the Host. ⚠ **This is not end-to-end group encryption**: the Host decrypts every member's message and re-encrypts it on every other member's channel — **the Host can read and alter everything that passes through it**, so only let someone you trust be the Host.
  - **Invites**: `host.createInvite({ relays })` returns `cinderous-star:1.…` (Host pubkey + 128-bit secret + expiry + relays), 10 minutes and single-use by default, with optional use count, binding to one pubkey, and `revokeInvite(id)`. The secret is only sent inside the encrypted channel after the handshake; the Host keeps only its hash. Optional `approveJoin` lets the user click "allow".
  - **Membership**: joiners get the current roster, everyone else gets `joined`; `leave()`, `kick(pubkey)` (bans by default; the kicked member's channel is closed and nothing more reaches or leaves it; with pairwise channels nobody else renegotiates), a reconnect from the same identity replaces the old link (`replaced`). Members get `ended(host-closed)` when the Host ends the session and `host-lost` when the Host disappears (channel closed, heartbeat timeout, desync). **No automatic Host failover.**
  - **Ordering**: every relayed message carries the Host sequence number and the sender, which the Host fills in from the **authenticated channel identity** (members cannot impersonate each other). The Host sequence is one total order shared by everyone, roster events included, and consistent with causality. Unicast (`to`), `echo`, `topic` (0–255) and `volatile` (cursors; dropped first under back-pressure).
  - **Back-pressure**: one queue per member (8 MiB / 4,096 records by default); when full, volatile records go first, then the member is asked to leave (`overflow`, it can rejoin and resync) so a slow member never stalls the others; whoever floods (over the inbound rate, or holding more than half of someone else's queue) is the one asked to leave (`rate-limit`), not the innocent slow member; on the member side `send` throws `backpressure`.
  - **Transport**: P2P first, relay track (kind 20079) as fallback with acknowledgements, retransmission and reordering, paced by a per-minute event budget (100 by default; `starRelayEventsPerMinute(nip11)` derives it from NIP-11 `cinder_max_events_per_minute`) that the Host splits across relayed members. `host.listen(node)` handshakes every incoming channel, so pass `accept` when the same `PeerNode` also serves something else (e.g. vault sync). The SDK does not connect to the relays in the invite by itself; make sure your pool covers them.
  - **Post-quantum overhead** (v0.28, [ADR 0033](docs/adr/0033-pq-ratchet-header-cost.md)): a 20-byte update is 131 B member→Host and 170 B Host→each member (v0.27: 2,395 / 2,434 B; classic: 122 / 161 B); everything queued within one batch window (16 ms P2P, 250 ms relay) goes out as one message, so 50 updates cost 1,503 B in total. Over the relay a 20-byte update is a 2,214-byte event and 50 batched updates are 5,970 B — the same as classic. About once every 50 messages per side, one message also carries an ML-KEM ciphertext or public key (1.1–1.2 KB).
  - Large files (wormhole projection attachments): `host.channelOf(pubkey)` / `member.channel` expose the pairwise channel for `StreamTransfer.for(channel)` (different marker byte, no interference; that is a direct Host↔member transfer, not relayed).
  ```typescript
  import { StarHost, StarMember } from '@cinderous/client/star';
  const host = new StarHost({ identity, relayEventsPerMinute: 96 });
  host.listen(node);
  const { uri } = host.createInvite({ relays: settings.relayUrls });
  host.onMessage((m) => Y.applyUpdate(ydoc, m.payload));
  const me = await StarMember.join({ identity, node, invite: uri, label: 'Alice' });
  me.onMessage((m) => Y.applyUpdate(ydoc, m.payload));
  me.send(update);
  ```
- **Relay fixes for two Cloudflare limits** (v0.27, [ADR 0032](docs/adr/0032-do-sql-bindings-and-ws-attachment-limits.md); mirrors Cinderous ADR-0372 / ADR-0373): Durable Object SQLite allows **100 bound parameters per query**, so a REQ with 99+ `authors` / `ids` / `kinds` / `#p` / tag values used to fail with a NOTICE and no EOSE; queries now pass each list as one `json_each(?)` parameter (same results, order, `limit` and 16 MB budget). A WebSocket attachment holds at most **16 KB**, so a connection subscribing to about 240+ `authors` got no reply at all and lost the subscription on hibernation; small subscriptions still live in the attachment and larger ones spill into a `ws_subs` table (written only when they change, 512 KiB per connection, anything that cannot be kept is answered with `CLOSED`). Allowlist, per-pubkey connection limits, per-IP rate limits and file lanes all keep working with both fixes; the DO schema matches Cinderous with both PRs applied. Redeploy an existing relay to pick them up (the REST one-click bundle includes them).
- **Post-quantum Double Ratchet wire format v2** (v0.28, [ADR 0033](docs/adr/0033-pq-ratchet-header-cost.md)): the ML-KEM exchange is decoupled from the DH ratchet. Each side starts a KEM round once every `pqRekeyInterval` messages it sends (50 by default, like iMessage PQ3); the ciphertext is attached once per sending chain and mixed into the root key at the peer's **next** DH step, so losing the message that carried it never makes any message undecryptable — it only delays post-quantum healing. A PQ header is now **50 bytes** (was 2,314): 1,142 B when a round starts, 1,238 B when a new public key is announced, and about 94 B on average for back-and-forth traffic. Post-quantum confidentiality still covers every message (Alice's first chain is bound to the handshake ML-KEM exactly as before) and forward secrecy is unchanged; post-quantum post-compromise healing becomes "up to about 2 × `pqRekeyInterval` messages plus a few round trips" instead of "next step" (set `pqRekeyInterval: 1` for close to the old behaviour). A watchdog closes the session with `SecurityDowngradeError` if an attacker selectively drops the KEM-carrying messages, and an authenticated peer that breaks the protocol (e.g. an invalid ML-KEM public key) closes it with `RatchetProtocolError`. The `secureChannel` hello negotiates the format (`pqf`): a v0.27 peer that wants post-quantum is refused with `UnsupportedRatchetVersionError` (upgrade both sides) — never silently downgraded; classic mode is byte-for-byte unchanged and still interoperates. Exported post-quantum session state from v0.27 cannot be restored (re-handshake).
- **@noble 2.4 and one copy of the crypto libraries** (v0.29, [ADR 0034](docs/adr/0034-noble-2-4-and-consumer-overrides.md)): `@noble/curves`, `@noble/hashes`, `@noble/ciphers` and `@scure/base` move from 2.0.x to **2.4.0** — constant-time execution is now guaranteed rather than best-effort (CSPRNG scalar blinding, constant-time fixed-window multiplication), plus the Trail of Bits review fixes, ECDH/ECDSA rejection of the identity point, and the hashes 2.4.0 security and correctness fixes. nostr-tools still pins 2.0.1, so **add the overrides below** to keep a single copy (without them everything still works, but your bundle carries two copies and nostr-tools' copy stays on 2.0.1). Verified against the official NIP-44 test vectors and against events, signatures, NIP-44 ciphertexts, NIP-19 strings and NIP-59 gift wraps produced by v0.28 (noble 2.0.1). `getPublicKey` is about 0.1 ms slower, verification and ECDH are faster; see the note on `precompute(8)` below.
- **One-click deploy can set known app lanes and site parameters** (v0.31, [ADR 0036](docs/adr/0036-deploy-app-lanes-and-dochost-on-self-hosted-relays.md), [ADR 0037](docs/adr/0037-one-click-deploy-parameters.md)): all four deploy paths (REST, wrangler, docker, fly) share `RelaySiteOptions`; validation and the mapping to relay environment variables live only in `relaySiteVars`. New: `appLanes` (`APP_LANES`, same lane-id pattern as the relay, up to 32), `fileLanes` (must be in `appLanes` and needs `maxFileMb`), `maxTtlDays` (1–365), `maxConnectionsPerPubkey` (1–100, default 5), `maxMessagesPerSecondPerIp` (1–1000, default 20), `appLanePow` (0–32), `developerDocsUrl` (https), `relayDescription` / `relayContact` / `relayPubkey` / `donations`. Out-of-range values throw before anything is deployed; no option can turn rate limits off or make retention unbounded. Lane options are Cloudflare-only and throw for docker / fly (the Node host has no lanes).
  - 🔴 **Changing the list moves the lane to another Durable Object**: each listed lane has its own DO, and data in the old one is not moved — it expires in place. On redeploy the REST path reads the live `APP_LANES` and throws `lane-change` (nothing is uploaded) if it differs; pass `allowLaneChange: true` only when you mean it. The wrangler path has no such check — redeploy with the same list.
  - NIP-11 (on the lane path) now also declares `cinder_addressable_per_author` (strict 5 / known lane 64 / public lane 16), `cinder_addressable_max_bytes` (256 KB / 32 KB), and `cinder_max_messages_per_second_per_ip` when set.
  - One-click deploys default to 20 messages per second per IP: clients that push many events at once must pace themselves, or deploy with a higher `maxMessagesPerSecondPerIp`.
  ```typescript
  import { deployCloudflareRelayViaApi } from '@cinderous/client/deploy/cloudflare-api';
  const { relayEndpoint } = await deployCloudflareRelayViaApi({
    apiToken, fetch: obsidianFetch,
    workerName: 'my-dochost-relay',
    allowedPubkeys: [pk],          // lanes do not require AUTH: the allowlist checks the event signer
    appLanes: ['dochost'],         // /app/dochost becomes a known lane: 64 addressable slots / 30 days
    maxMessagesPerSecondPerIp: 100,
    relayName: 'My DocHost relay',
  });
  // clients connect to `${relayEndpoint}/app/dochost`
  ```
  ```bash
  npx cinderous relay deploy --name my-dochost-relay --allowed-pubkeys npub1... --app-lanes dochost --max-messages-per-second-per-ip 100
  ```
- **The relay no longer says `OK true` for offline messages it could not store** (v0.31.1, [ADR 0038](docs/adr/0038-relay-capacity-signals-and-client-fallback.md) P0-R1): on the strict plane (no eviction) a full per-DO offline ceiling now answers `OK false "blocked: ceiling: …"` and the event is not fanned out; an event whose own NIP-40 `expiration` has already passed answers `OK false "invalid: expired: …"`. Rejected events are no longer remembered by the replay cache, so resending the same event later is accepted instead of being answered `duplicate`. Per-recipient FIFO and lane eviction (store the new one, drop old ones) still answer `OK true`.
- **Relay rejections carry a machine-readable token, and the client classifies them** (v0.32, [ADR 0038](docs/adr/0038-relay-capacity-signals-and-client-fallback.md) P0-R2 / P0-C, [ADR 0040](docs/adr/0040-relay-reject-tokens.md)): every `OK false`, `CLOSED` and key `NOTICE` from the SDK relay (and the Cinderous anchors) is now `<NIP-01 prefix>: <token>: <text>` — `blocked: quota: …`, `blocked: ceiling: …`, `blocked: stale: …`, `invalid: expired: …`, `rate-limited: events: …`, `restricted: scope: …`, `error: resubscribe: …` (full table in ADR 0040). The single addressable rejection `blocked: 取代事件遭拒（配額/大小/較舊）` is split by cause (older, too large, address quota, byte quota, expired, DO ceiling) through the new optional `OfflineStore.putAddressableResult()`; custom stores that only implement the boolean `putAddressable()` keep working and get the old sentence. A replayed event now answers `OK true "duplicate: …"` as in NIP-01, and an event whose store write throws is no longer left in the replay cache. The lane-upgrade NOTICEs (`unknown relay path`, `invalid app lane`, `rate-limited: too many new connections`) are unchanged because the Cinderous developer docs list them verbatim.
  - Client: `classifyRelayMessage(message)` → `{ prefix, token, kind, retryable, tryOtherRelays }` (third-party relays fall back to the prefix; old sentences are still recognised). `PublishResult.rejected[]` gains `kind` / `retryable` / `tryOtherRelays` / `token`, and `duplicate` (the new `OK true` or an old relay's `OK false`) counts as accepted. `SocketLike` close events may carry `code` / `reason`: a 1008 `rate-limited` kick ends in-flight publishes as `rate-limited` and reconnects with the longest backoff, 4003 is `restricted`, no code is a plain network drop as before.
  - Partial rejections are no longer lost: `onRelayReject(url, rejection)` reports every per-relay `OK false`, `CLOSED`, prefixed `NOTICE` and coded close; `DirectMessages.send` returns `accepted` / `rejected` for the recipient's copy; DMs, the vault transport, roster sync and `PeerNode` take `onPublishRejected(report)`. Success is still "at least one relay accepted" (`minAccepted` comes in P1).
  - A standing subscription closed with `error: resubscribe: …` (lost on relay restart) is re-sent to that relay, at most once per 30 s; `restricted: scope:`, `invalid: too-large:` and the like are not (amends ADR 0032).
  - ⚠ `PublishResult.rejected` entries have extra fields — tests comparing them with `toEqual({ url, reason })` need updating. Redeploy a relay to get the tokens; clients still classify old relays by prefix.
  ```typescript
  const pool = new RelayPool({
    urls, identity,
    onRelayReject: (url, r) => {
      if (r.kind === 'ceiling' || r.kind === 'quota') markFull(url);      // try another relay later
      else if (r.source === 'close' && r.kind === 'rate-limited') slowDown();
    },
  });
  const { accepted, rejected } = await pool.publish(event);
  for (const r of rejected) console.log(r.url, r.kind, r.retryable, r.token);
  ```
- **Per-relay health, durability requirements with standby relays, read-back audit, NIP-65 / NIP-17 relay lists** (v0.33, [ADR 0038](docs/adr/0038-relay-capacity-signals-and-client-fallback.md) P1, [ADR 0041](docs/adr/0041-relay-health-durability-and-read-back-audit.md)). **Nothing changes unless you opt in**: `publish(event)` without options behaves and returns exactly as in v0.32.
  - Health: `RelayPool` remembers what each relay's rejections mean — `ceiling` / `quota` mark that class of data (offline messages, addressable, …) *full* for 1 h; policy / not-allowed mark that kind *inapplicable* (24 h, or `resetRelayHealth()`; since v0.35.1 cleared by `revalidateRelay` when NIP-11 shows the cause is gone); `too-large` marks that kind at that size and above; `rate-limited` backs the whole relay off until the counting window ends (60 s, `ip` 1 s); close codes 1008 / 4003 back off / mark inapplicable; `invalid` is our own fault and marks nothing. Read it with `pool.relayHealth()`, watch it with `pool.onRelayHealthChange()` (a repeated rejection only extends the mark and does not notify again). Kept in memory only (cooldowns are short and relays recover; persisting stale marks would skip a relay that is fine again).
  - Durability: `pool.publish(event, { durability: { minAccepted, standby } })` (`minAccepted` defaults to 1) skips relays marked for this event and counts only durable accepts — `OK true` and `duplicate`, **not** `OK true "warning: borrowed: …"` (ADR 0039; the client already recognises it, `PublishResult.borrowed` lists them). When the count falls short, and only if you gave `standby` URLs, it lazily connects the next standby and sends **only that event**; standby connections get no standing subscriptions (unless `standbySubscribe: true`), are not reported by `status()`, never auto-reconnect and close after `standbyIdleMs` (60 s). `result.durability` carries every relay's outcome and `relaysFull`; while every relay is marked full a durable publish sends nothing at all, so a caller's retry loop cannot storm the relays.
  - `pool.queryEach(filters, { relays })` returns each relay's own events and whether it finished (`eose`) or is unknown (`timeout`, `closed`, …).
  - New subpath `@cinderous/client/durability` (5.4 KB minified, no Node built-ins): `auditOwnEvents()` / `OwnEventAuditor` query your own addressable events (`#d`) and your own inbox (`ids` + `#p` self) relay by relay and report which relay lost what (sampling, least-recently-updated first, rate limit; a relay that lost something is marked full so durable publishes avoid it). Gift wraps you sent **to someone else** cannot be audited by the sender — only the recipient can report them. NIP-65 (kind 10002) and NIP-17 (kind 10050) helpers build and parse relay lists (with read / write markers and your standby relays listed up front) and pick where to send DMs; you decide whether to publish them.
  - Integration: `DirectMessages`, `NostrVaultTransport` and `NostrRosterSync` take an optional `durability`; the vault coordinator turns `RelaysFullError` into `status().blocked = 'relays-full'`, reported once with the longest backoff (like `relay-rejects-files`). Give `loadRelayFileLimits` the relays you actually write to — `pool.writeSet(1060)` — or use `watchRelayFileLimits({ pool, onLimits })` to recompute when a standby joins or a relay is marked full.
  ```typescript
  const result = await pool.publish(event, { durability: { minAccepted: 2, standby: ['wss://my-backup.example'] } });
  if (!result.durability!.satisfied) showWarning(result.durability!.relaysFull ? 'relays are full' : 'not enough copies');

  import { OwnEventAuditor, relayListWithStandby } from '@cinderous/client/durability';
  const auditor = new OwnEventAuditor({ pool, self: identity.pubkey, sample: 64 });
  const report = await auditor.run(buckets.map((b) => ({ type: 'addressable', kind: 31438, pubkey: identity.pubkey, d: b.d, updatedAt: b.at })));
  if ('missing' in report) for (const { target } of report.missing) await republish(target);
  await pool.publish(identity.sign(relayListWithStandby(urls, ['wss://my-backup.example'])));  // only if you want it public
  ```
- **Capacity policy for shared DOs: per-DO ceilings, guaranteed shares, an overflow band, coarse near-full warnings, dropped-message counts** (v0.34, [ADR 0042](docs/adr/0042-relay-capacity-guarantee-borrowing-and-ceiling-config.md); ADR 0038 P2, ADR 0039 B1, port of Cinderous ADR-0377). **Everything is off by default**: without the new variables every relay result and every stored row is identical to v0.33 (tested against the v0.33.0 stores verbatim).
  - Configurable ceilings (`DO_CEILINGS_MIB`, same syntax as the Cinderous anchor): `<target>=<offline MiB>/<addressable MiB>`, target is a class (`strict` / `public` / `lane` / `file`) or a DO name (`shard-a`, `app:dochost`, …). Each DO remembers its name (storage key `cinder:do-name`). `computeCeilingBudget(vars)` sums the worst case over every DO the router can create (overflow band included) so deployers can guard Cloudflare's 5 GB free tier in their own tests.
  - Guaranteed share (`DO_GUARANTEE_KIB`, evicting lanes only): data within each author's (addressable) / recipient's (offline; rows without a recipient count for their author) guarantee is never evicted by someone else's write; when full, the part above guarantees goes first, otherwise `OK false "blocked: ceiling: …"`.
  - Overflow band (`DO_BORROW_PERCENT`): that much above the ceiling is lent out for 2 hours, always evicted first, answered with `OK true "warning: borrowed: 7200: …"` (delivered, not durable, for the client). Writes above a guarantee can only borrow, never evict others; a full band never evicts older loans; strict-plane addressable data (cloud snapshots) never borrows.
  - Near-full warnings (`DO_NEAR_FULL_PERCENT`): `OK true "warning: near-full: 80: …"` at that grade or 95%; `relayHealth()` keeps a soft `nearFull` marker that does not affect publishing.
  - Dropped counts (`DO_DROP_NOTICES`): messages to someone that are deleted *before delivery* (FIFO, ceiling eviction, loan expiry) are counted; when the recipient reads their own inbox they get `NOTICE "warning: dropped: <count>: <since>: <until>: …"` before EOSE, surfaced as `onRelayDropped({ url, count, since, until })`, then reset. Counts and time range only.
  - NIP-11 declares static values: `cinder_ceiling_policy` (`evict` / `reject`), `cinder_ceiling_bytes`, `cinder_guarantee_bytes`, `cinder_borrow_ttl_sec` / `cinder_borrow_percent` / `cinder_borrow_planes`, `cinder_near_full_percent`, `cinder_drop_notices`. One-click deploy (`RelaySiteOptions`) exposes `doCeilings`, `doGuaranteeKib`, `doBorrowPercent` (≤ 50), `doNearFullPercent`, `doDropNotices`, `storageBudgetBytes` (Cloudflare only).
  - Compatible DO SQLite migration: two `ADD COLUMN borrowed` (default 0), two partial indexes that only hold borrowed rows, an `inbox_drops` table. A Cinderous-main DB upgrades cleanly and idempotently; rolling back to v0.33 / Cinderous main keeps reading and writing.
  ```typescript
  import { computeCeilingBudget } from '@cinderous/client/deploy';
  const budget = computeCeilingBudget(vars);   // [vars] of wrangler.toml
  expect(budget.ignored).toEqual([]);
  expect(budget.withinBudget).toBe(true);
  const pool = new RelayPool({ urls, onRelayDropped: ({ url, count }) => toast(`${count} messages lost on ${url}`) });
  ```
- **Roster sync over NIP-59 gift wraps, and one relay event budget per identity** (v0.35, [ADR 0043](docs/adr/0043-roster-gift-wrap-outer-kind-and-relay-event-budget.md)):
  - `NostrRosterSync({ …, outerKind: 1059 })` sends the roster as a standard gift wrap (inner kind 4361 unchanged), so it syncs on relays that refuse kind 1060 (`blocked: files-disabled:`). The default stays **1060** (CinderSync-compatible). Every device on the same roster must use the same value — 1059 and 1060 ends do not see each other. A full roster (32 devices) is 109,769 bytes as a 1059, well under the 262,144-byte per-event cap.
  - The SDK relay counts **events per authenticated identity** (120/min, ephemeral included), and an identity's relay frames, signaling, roster and vault sync share that bucket. `PeerNode`'s relay track now defaults to **100 frames/min** (was 200, which the relay cut off at 120). Without an explicit rate, `PeerNode`, `NostrVaultTransport` and `NostrRosterSync` share `sharedRelayEventBudget(pubkey)`; pass the relay's NIP-11 (`relayInfo`, or `applyRelayInfo(docs)`) to take the lower of 100 and `cinder_max_events_per_minute` × 0.8 (same function as the star session's `starRelayEventsPerMinute`). A `rate-limited:` rejection backs the whole budget off for the counting window and resends that event. Vault sync over an authenticated relay is now paced (a 30 MB file takes ~7 min per device) instead of failing after 120 chunks. DMs and direct `pool.publish` calls are not paced (that is the 20-event headroom).
  ```typescript
  import { NostrRosterSync } from '@cinderous/client/pairing';
  import { sharedRelayEventBudget } from '@cinderous/client';
  const roster = new NostrRosterSync({ pool, signer: identity, membership, outerKind: 1059 });
  sharedRelayEventBudget(identity.pubkey).applyRelayInfo(nip11Docs); // PeerNode, vault, roster follow
  ```
- **Relays recover as soon as their NIP-11 says so** (v0.35.1, [ADR 0044](docs/adr/0044-revalidate-relay-health-on-nip11.md)): a `blocked: files-disabled:` rejection used to keep a relay marked *inapplicable* for 24 h even after the operator turned file events on, so a `durability` publish kept skipping it. `pool.revalidateRelay(url, nip11)` (raw NIP-11 or a `fetchRelayFilePolicy` result) clears only the marks the document shows are gone — `files-disabled` with `cinder_accepts_files: true`, `too-large` when every declared limit now covers that size (not file chunks), `not-allowed` with `restricted_writes: false` — and notifies `onRelayHealthChange` once. `kind-disabled`, *full* and rate-limit marks are untouched; a mark that appeared after the document was read is kept. `watchRelayFileLimits` now re-reads NIP-11 every 30 min (`refreshMs`, `0` = off; one GET per relay per round, marked relays included) and revalidates. `resetRelayHealth(url, { scope, state })` clears just part of a relay. The 24 h stays as the cap when nothing re-reads NIP-11; default behaviour is unchanged.
  ```typescript
  pool.revalidateRelay(url, await fetchRelayFilePolicy(url)); // or let watchRelayFileLimits do it
  pool.resetRelayHealth(url, { scope: 'kind:1060' });
  ```
- **🔴 A query that no relay answered no longer counts as "caught up"; scheduled-sync hooks** (v0.36, [ADR 0045](docs/adr/0045-scheduled-sync-gaps-g12.md)): `RelayPool.query()` returns an empty array when no relay is connected (or every relay times out / drops mid-query), and `forEachPage` took that as "no more pages" — so `NostrVaultTransport.backfill()` moved its starting point to *now* and `FastHydrator` called `setLastSyncAt(now)`, permanently skipping everything older. New `pool.queryResult(filters)` returns `{ events, answered, relays }` (`answered` = relays that sent EOSE; `query()` is unchanged). With it, a page that no relay answered stops paging with `{ complete: false, unanswered: true }`; `backfill()` and `FastHydrator.resume()` keep their cursor and reject with `RelayQueryIncompleteError`; `queryPaged()` throws it instead of returning `[]`; the read-back audit reports `verified` and `OwnEventAuditor` neither defers unverified targets nor spends its rate limit on a run that reached no relay. Custom pools with only `query()` behave as before (`NostrVaultTransport` falls back to `status()`). Also, all opt-in:
- **Large inbox pages and the first query after connecting** (v0.57, [ADR 0076](docs/adr/0076-restricted-before-auth-waits-for-auth.md), [ADR 0077](docs/adr/0077-query-timeout-is-idle-time.md)): a one-shot query's timeout (`query`/`queryResult`/`queryEach`) now counts *idle time* — each event received restarts it, up to `QUERY_MAX_EXTENSION` (12) × the timeout — so a ~16 MB page of file chunks on a slow link is no longer cut off at 5 s and reported as unanswered every round. App lanes send a NIP-42 challenge on connect but answer a `#p` REQ that arrives before AUTH with `restricted:`; `RelayPool` now treats a `restricted:` CLOSED as *waiting for auth* when it has an identity, has received a challenge on that connection and is not yet authenticated (queries are resent after AUTH, subscriptions are not reported as relay problems), and the SDK relay answers such a REQ with `auth-required:` instead. `PublishDurability.standbyWhenDisconnected: false` ([ADR 0078](docs/adr/0078-standby-when-disconnected.md)) keeps a durable publish off the standby relays when the main relays are merely not connected (scheduled-connection apps between rounds): it reports `not-connected` so the caller keeps it pending; full or refusing main relays still fall back to standby. Default `true` (unchanged).
  - `coordinator.whenSent({ timeoutMs })` resolves `sent` once the queue is empty and nothing (versions, digest, wants) is in flight, or reports why it cannot progress: `offline`, `paused`, `blocked` (with the reason), `stopped`, `timeout`.
  - `digestPolicy: 'on-connect' | 'on-change' | 'manual'` (default `'on-connect'`, as before) with `digestMinIntervalMs` / `digestMaxIntervalMs` (one day): with `'on-change'` a round with no local changes sends **no events at all**; `resync()` always sends. Since v0.56 ([ADR 0074](docs/adr/0074-stale-digest-no-resend.md)) a digest carries the highest sequence number it has processed from each sender (`seen`) and a state id (`sid`), so a sender no longer re-sends versions that are still on the relay on their way (stale digests sent on reconnect or startup); `resync()` still asks for everything missing, `resync({ lost: false })` is for plain reconciliation (e.g. once per startup). Also since v0.56 ([ADR 0075](docs/adr/0075-transport-holds-messages-until-listener.md)) `NostrVaultTransport` keeps messages that arrive before any listener is registered (up to 10,000 / 64 MiB) and hands them to the first listener, so the backlog fetched right after `createNostrVaultTransport()` is no longer dropped while the coordinator is still loading.
  - `NostrRosterSync`: a failed roster send is remembered (`pending`, persisted through `pendingStore`), `retryPending()` resends it, and `retryOnReconnect: true` does so when the pool reports a relay `open` (default: remember only).
  - `watchRelayFileLimits(...)` now returns a function you can still call to stop, plus `refresh()` (re-read NIP-11 now and restart the periodic timer).
  ```typescript
  const watch = watchRelayFileLimits({ pool, onLimits: (l) => sync.setRelayLimits(l), refreshMs: 0 });
  await watch.refresh();                        // start of a scheduled round
  await transport.backfill().catch(() => 0);    // RelayQueryIncompleteError: cursor kept
  await roster.retryPending().catch(() => false);
  await sync.idle();
  const { state } = await sync.whenSent({ timeoutMs: 15 * 60_000 }); // 'sent' | 'blocked' | …
  ```
- **Markdown conflicts in place, as a callout** (v0.36, [ADR 0046](docs/adr/0046-markdown-conflict-callouts.md)): with `conflictCallouts: true` on every device, two edits to the same lines of a `.md` file no longer produce a conflict copy. Only the conflicting lines are replaced by a folded Obsidian callout that lists **every** version — each labelled with the writing device's name and a UTC time, ordered by time — while the rest of the file merges as usual:
  ```
  > [!conflict]- 同步衝突（2 個版本） %% cinder-conflict:3fa1c2d4e5b6 %%
  > **MacBook · 2026-10-01 10:32 UTC** %% cinder-version:1790850725000:mac %%
  > my edit
  >
  > **iPhone · 2026-10-01 10:45 UTC** %% cinder-version:1790851500000:phone %%
  > their edit
  >
  ```
  The result is byte-identical on every device: nothing relative ("yours"), times in UTC, device names from the version itself, and the mode decided by the **version data** (a capability mark inside each version id; a merge uses callouts only when every head carries it), never by the roster. Older devices keep producing conflict copies and the two merges converge through the existing covering rule. Other text files, binaries, and anything that would break the callout (inside a code fence or front matter, next to a blockquote, unbalanced fences / `%%` / `<!--`, mixed line endings, more than 16 versions or 2,000 lines) fall back to a conflict copy; CRLF files stay CRLF. A callout that conflicts again is unfolded into one callout (never nested). `parseConflictCallouts(text)` returns each callout's `id`, `versions` (`label`, `device`, `at`, `lines`) and position; `resolveConflictCallout(text, id, choice)` with a version index, `'both-by-time'` or `{ text }` returns the new text to write back (a normal local edit). Deleting the callout by hand also resolves it. Off by default (byte-identical to v0.35).
- **User-defined sync excludes** (v0.37, [ADR 0047](docs/adr/0047-user-defined-sync-excludes.md)): gitignore-style rules shared by CinderSync and Cinder Coffice, in two layers — **fixed** excludes (supplied by the app; a user `!` cannot re-include them) plus the **user list** (default `DEFAULT_USER_EXCLUDES`: `.DS_Store`, `._*`, `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `~$*` (Office lock files), `.~lock.*#`, `*.tmp`, `*.swp`, `*.swo`, `*.crdownload`). Syntax: `*`, `?`, `[a-z]` / `[!a]`, `**/x`, `x/**`, `a/**/b`, a trailing `/` matches folders only, a leading or middle `/` anchors at the vault root, `!` negates (not inside an excluded folder, as in git), `\` escapes; paths are NFC-normalised and matched case-insensitively by default. `validatePattern(line)` drives live validation in a settings page (error code + message, a warning for things like `*`), and `explain(path)` tells you which rule (and layer) excluded a path. Pure functions, no Node; `path-filter` alone bundles to < 8 KB.
  On the coordinator, `excludes` / `setExcludes(filter)`: 🔴 **excluding is not deleting** — a tracked file that becomes excluded is only **detached** (no delete version, other devices keep their copies, the local file is untouched); versions from other devices for an excluded path go into the version graph but are **not written** (reconciliation does not keep asking for them and nothing shows up as `pending`); when another device moves a file into a folder this device excludes, the local copy at the old path is **kept, not deleted** (`detached()` reports it as `moved-out`). Removing an exclude rescans: a detached file merges with whatever other devices changed in the meantime, using the version it had when detached as the common ancestor (nothing is sent if neither side changed it); local files with no record become new files (same path and same content elsewhere fold into one); remote files this device never had are written. Rules are per-device and may differ between devices. Without `excludes` the behaviour is identical to v0.36; `ignore` is unchanged.
  ```typescript
  import { compileSyncExcludes, DEFAULT_USER_EXCLUDES, literalPathPattern, validatePattern } from '@cinderous/client/sync/vault';
  const FIXED = [literalPathPattern(app.vault.configDir), '/.trash', '/.git', '/node_modules', '.*'];
  const excludes = () => compileSyncExcludes({ fixed: FIXED, user: settings.syncExcludes ?? DEFAULT_USER_EXCLUDES });
  const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, excludes: excludes() });

  validatePattern('folder\\sub');   // { ok: false, error: { code: 'backslash', message: … } }
  const draft = compileSyncExcludes({ fixed: FIXED, user: textarea.value });          // live preview in settings
  const hidden = (await adapter.list()).filter((f) => draft.isExcluded(f.path)).length;
  await sync.setExcludes(excludes());  // on save: deletes nothing; sync.detached() lists the detached files
  ```
- **Conflict copies no longer flip-flop; empty files never make one** (v0.37.1, [ADR 0048](docs/adr/0048-echoed-rename-misread-and-empty-file-conflicts.md)): when two devices already had the same path with different content before pairing, the coordinator renames the loser to a conflict copy and writes the winner back to the original path. In v0.37.0 the plugin's echo of that rename (old path now taken by the winner) was mistaken for a user rename, so both devices kept rewriting the copy (and sometimes one side's content left the vault). Upgrade **every** device; no plugin change is needed. New rule: if one side of a path collision or an unmergeable concurrent edit is 0 bytes, the non-empty side wins — no conflict copy, no callout, no `conflict` event (deterministic; nothing is lost).
- **Config-driven relay deployment: `cinderous.config.json`, portable deploy packages, generated deploy guides** (v0.38, [ADR 0050](docs/adr/0050-deploy-configurator.md) P0): every deployment choice lives in one versioned JSON file with a JSON Schema (`schema/cinderous.config.schema.json`, exported as `@cinderous/client/config.schema.json`): the target (`cloudflare`, `cloudflare-api`, `docker`, `fly`, `home-tunnel` = home server + Cloudflare Tunnel), `site` (exactly `RelaySiteOptions`), host options, and secrets as **references only** (`{ "$env": "NAME" }`; a token-looking literal is refused or flagged). `cinderous relay build` writes a portable package — no absolute paths: Workers get `wrangler.toml` + `src/entry.mjs` importing the package name (or `--self-contained` with the pre-bundled relay); Docker / Fly / home-tunnel get the build context (relay + `cloudflared`, no published port, for home-tunnel); the SDK is embedded under `sdk/` until it is public (or `--sdk-spec <dependency>`) — plus `README-DEPLOY.md` (zh-TW) and `README-DEPLOY.en.md` assembled from your choices (credentials using the Cloudflare token guide data, secrets, deploy, health check, rollback, upgrade, cost, security checklist, license), `.env.example`, `.gitignore`, `LICENSE`, `SOURCE.md` and a `.cinderous-generated` manifest (regenerating refuses to overwrite generated files you edited unless `--force`). `relay deploy --config` deploys the same choices; the old flags still work and now go through the same config path (diff-tested). `config validate` lists every problem at once. New neutral subpath `@cinderous/client/deploy/config` (no Node built-ins, for plugins and a future web configurator): `DeployConfig`, `DEPLOY_OPTION_SPECS`, `validateDeployConfig`, `renderDeployPackage`, `renderDeployGuide`; `collectRelaySiteIssues(opts, host)` is the collecting form of `relaySiteVars` (same rules, same messages; `relaySiteVars` behaves exactly as before). Generated config and glue files are MIT-0; the SDK stays AGPL-3.0-only. NIP-11 `software` is now configurable (`relaySoftwareUrl` / `RELAY_SOFTWARE_URL` / `--relay-software-url`; the default is unchanged) so operators of a modified relay can meet AGPL §13. Behaviour change: `--persist` / `--port` with the Cloudflare target are now usage errors instead of being ignored.
  ```bash
  npx cinderous config validate                                   # every issue at once
  npx cinderous relay build --config cinderous.config.json --out deploy/
  npx cinderous relay deploy --config deploy/cinderous.config.json  # secrets from the environment or deploy/.env
  ```
  ```json
  {
    "configVersion": 1,
    "target": "home-tunnel",
    "name": "home-relay",
    "site": { "allowedPubkeys": ["npub1alice..."], "maxFileMb": 17 },
    "node": { "persist": true },
    "tunnel": { "hostname": "relay.example.com" },
    "secrets": { "tunnelToken": { "$env": "TUNNEL_TOKEN" } }
  }
  ```
- **IoT remote control: shared protocol `@cinderous/client/iot` and a home bridge `@cinderous/client/iot/bridge`** (v0.39, [ADR 0049](docs/adr/0049-iot-relay-modes.md) P0 = route A): scoped to "low-frequency remote control + latest state". The home bridge connects your local MQTT broker (Tasmota, Zigbee2MQTT, Home Assistant…) to **any** relay and encrypts end to end at home; relays only see ciphertext and blinded tags. A 32-byte home secret is expanded with HKDF into `homeKey`/`homePub` (the NIP-44 recipient of all IoT content — each message is encrypted once for the whole household), `topicKey` (topics are HMAC-blinded to 22 characters) and `homeTag`; fixed test vectors live in `tests/iot/keys.test.ts`. Kinds: 25170 operate, 25171 ack, 25172 live state, 25173 query (ask the device to report now), 31170 retained (packed per device), 31171 gateway heartbeat. `IotClient`: `command()` (QoS 1 resends with exponential backoff, re-signing every time with the same msgId; `confirmed` for topics marked `confirm`), `query()` (answered from retained when the gateway throttles or times out), `subscribeState()` (MQTT-style `+`/`#`), `getRetained()`/`listDevices()` (no device wake-up), `watchGateway()` (expired heartbeat = offline), `myRole()`/`getAcl()`/`updateAcl()`; it **only trusts state-class events signed by the gateway**, and by default shares `sharedRelayEventBudget` with the same identity. `IotGateway` (one implementation for all routes) authorizes by the **signer's pubkey**: viewers may query, operators may operate, owners may also edit the role list through the reserved topic `$sys/acl`; entries can be narrowed by device (`light-*`) and topic (MQTT patterns), and topic rules can require a `minRole` and `confirm`. The role list is **authoritative only on the gateway** (not in the mergeable ADR 0028 roster) and the last owner cannot be removed. Time window + msgId dedupe (a duplicate gets the same ack again), NIP-40 command lifetime (30 s by default, at most 300 s), no relay-side will messages (a device's own LWT is mapped to state). mqtt.js is an **optional peer dependency** (`npm install mqtt`; the error tells you if it is missing); neither `./iot` nor the main entry contains any MQTT code (guard tests). CLI: `cinderous iot bridge --config iot-bridge.json`, `cinderous iot acl list|add|remove` (for owners), `cinderous iot keygen`, `cinderous iot build` (Docker build context for the bridge: Dockerfile, compose.yaml, .env.example, sdk/). ⚠ The strict plane of a self-hosted Node relay allows 5 addressable addresses per author per kind; the role list takes one 31170, so one gateway can keep retained state for at most 4 devices on a self-hosted relay (16/64 on anchor lanes; raising it for gateway keys is P1). The Docker image has not been built on a real Docker host yet.
  ```bash
  npm install mqtt
  npx cinderous iot keygen > .env          # IOT_HOME_SECRET, IOT_GATEWAY_KEY (shown once)
  npx cinderous iot bridge --config iot-bridge.json
  npx cinderous iot acl add npub1nanny... --role viewer --devices cam-door,thermo --config iot-client.json
  ```
  ```ts
  import { deriveIotHome, IotClient } from '@cinderous/client/iot';
  const iot = new IotClient({ pool, signer: identity, home: deriveIotHome(homeSecret), gateway: 'npub1gateway...' });
  const r = await iot.command('home/plug1/set', 'ON');          // { status: 'ok' | 'not-allowed' | 'timeout' | 'relay-rejected' | … }
  const q = await iot.query('plug1');                            // { status, state: { topics, ts }, fromRetained }
  iot.subscribeState('home/+/POWER', (m) => console.log(m.topic, m.payload));
  ```
- **Private path mode for personal relays: open writes behind an unguessable random path** (v0.41, [ADR 0051](docs/adr/0051-private-path-relay.md), the user's option D). A one-click personal relay that enforces an allowlist cannot pair a new device through itself; an open one gets its quota abused because the default URL is guessable. Content is end-to-end encrypted anyway, so the URL becomes the ticket:
  - Relay: `LANES_ONLY=1` accepts only lanes in `APP_LANES` (the same variable and the same `routeForPath` on Cloudflare and the Node host). The root, shards and unlisted lanes get the ordinary "unknown relay path" refusal (NOTICE + 1008, never `bad-lane`) and NIP-11 returns 404 — neither reveals any lane; the account storage budget counts only the listed DOs.
  - Deploy: `privateLane` (`generatePrivateLaneId()`: 26 base32 characters, 130 bits, from WebCrypto) → `APP_LANES` = `FILE_LANES` = it and `LANES_ONLY=1`; the allowlist becomes optional (no `openFileRelay` needed); `relayEndpoint` is the full `wss://<host>/app/<id>`; redeploys reuse the id (`privateLaneFromUrl`), switching to a new one needs `allowLaneChange`. Errors and progress never echo the id.
  - Configurator: `site.privateLane` may only be `{ "$env": "NAME" }`; packages contain no secret (`wrangler secret put` on Workers, `fly secrets set` on Fly, compose reads `.env`).
  - 🔴 The URL is a password: if it leaks anyone can write (nobody can read), and the fix is to redeploy with a new id.
  ```ts
  import { deployCloudflareRelayViaApi, generatePrivateLaneId, privateLaneFromUrl, VAULT_SYNC_MAX_FILE_MB } from '@cinderous/client/deploy/cloudflare-api';
  const privateLane = privateLaneFromUrl(existingUrl ?? '') ?? generatePrivateLaneId();
  const { relayEndpoint } = await deployCloudflareRelayViaApi({ apiToken, fetch: http, privateLane, maxFileMb: VAULT_SYNC_MAX_FILE_MB });
  // relayEndpoint === `wss://cinderous-relay.<subdomain>.workers.dev/app/${privateLane}`
  ```
- **Changing the private path no longer strands your other devices: a read-only grace period plus a roster-encrypted relay move notice** (v0.42, [ADR 0052](docs/adr/0052-relay-move-read-only-grace.md), CinderSync gap G21). Before, a new private path made the old URL fail at once, and devices that sync every few hours had to paste the new URL by hand:
  - Relay: `READONLY_LANES=<old id>@<expiry unix seconds>` (both hosts). Until it expires the old path still routes to its own DO and stays readable (REQ, AUTH), but every `EVENT` gets `OK false "restricted: read-only: …"` (no new URL, no lane id; new token `read-only`); NIP-11 says `restricted_writes` and `cinder_read_only_until`. The relay decides expiry by itself — afterwards the old path is an ordinary unknown path (open connections are closed on their next message). The old DO keeps its data until then.
  - Deploy: `readOnlyLanes` in `RelaySiteOptions`; the REST one-click deploy takes `retireLane: { id, graceDays }` (1–30, default 7) and keeps unexpired live entries on every redeploy. Configurator: `site.readOnlyLanes` is `$env` only.
  - `./pairing`: `announceRelayMove()` sends "old URL → new URL" (inner kind 4363, same wrapping and subscription as the roster) to every **active** member — removed devices never learn the new URL. `NostrRosterSync({ onRelayMove })` only hands over moves signed by a member; `planRelayMoves()` only *replaces* URLs already in your list, takes the newest move whose new URL actually answers (`probeRelayEndpoint`: NIP-11 200, not read-only) — so a failed deployment switches nobody. `isUnknownRelayPathMessage()` tells the app the old relay is gone.
  ```ts
  // the device that rotates: notify first (the old path is still writable), deploy, then notify the new path too
  const sent = await announceRelayMove({ membership, signer, move: { from: oldUrl, to: newUrl }, relays: allRelays, connect });
  if (sent.accepted.length === 0) throw new Error('could not notify other devices');
  await deployCloudflareRelayViaApi({ apiToken, fetch: http, privateLane: newLane, allowLaneChange: true, retireLane: { id: oldLane, graceDays: 7 }, maxFileMb: VAULT_SYNC_MAX_FILE_MB });
  // other devices: new NostrRosterSync({ ..., onRelayMove: (m) => moves.push(m) }), then each round
  const plan = await planRelayMoves({ primary, standby, moves, probe: (url) => probeRelayEndpoint(url, http) });
  ```
- **CinderSync gaps: progress, receive status, read-only relays, conflict copy names, bilingual deploy** (v0.43, [ADR 0053](docs/adr/0053-cindersync-coordinator-gaps-g13-g18.md), [0054](docs/adr/0054-read-only-relays.md), [0055](docs/adr/0055-deploy-progress-substeps-and-bilingual-checks.md), CinderSync gaps G11, G13–G18, G20). Defaults are unchanged, except that `blocked` now clears once the queue is empty:
  - Coordinator: when the send queue empties (for example everything went over a direct channel) `blocked` and the send-failure state clear, and the next version that goes through a relay is validated as usual; `retryPeers(device?)` resets the P2P backoff; `setRelayBulkPerHour(n)` changes the relay resend rate at runtime (0 = pause, direct only).
  - Direct transfer progress: `transfers()`, `on('progress')` (files, bytes and the file in flight per transfer; at most every 250 ms by default, start and end always reported), `status().p2pBytes`; at the stream layer `StreamHandler.onProgress` / `onSessionEnd`.
  - Per-device receive status: `peerStatus(device)` (`lastSeenAt`, `reportedAt`, `missing`, `known`), `peerStatuses()`, `knownHeads(device)`, `notePeerActivity()`; direct-batch acknowledgements now count as heads the peer knows; `NostrRosterSync({ onMemberActivity })`. **Nothing extra is sent for reporting**; a faster "received" receipt was declined (user decision B0, ADR 0053 §G17(b)).
  - `parseConflictCopyName(path)`, `freePathCandidate(path, n)` (`./sync`): conflict copy names and numbering live in one place.
  - `RelayPool({ readUrls })`: subscribe-only relays (always connected, reconnect with backoff; written to only when `durability.standby` needs them, reusing the same connection; `queryResult` queries them but `answered` counts main relays only). Sharing standby lists through the roster (G11 part 1) shipped in v0.45 as user-confirmed suggestions ([ADR 0056](docs/adr/0056-roster-shared-relay-list.md), see below).
  - REST deploy: progress carries `substep` and `messages: { 'zh-TW', en }`; `checkRelayName` and `collectCloudflareApiDeployIssues` list bilingual issues up front.
  ```ts
  const pool = new RelayPool({ urls: primary, readUrls: standby, identity });
  sync.on('progress', (p) => bar.set(p.device, p.bytes.done, p.bytes.total, p.current?.path));
  const { missing, lastSeenAt } = sync.peerStatus(deviceId);
  if (directChannelOpen) sync.setRelayBulkPerHour(0); else sync.setRelayBulkPerHour(120);
  ```
- **`writeStream` sources carry the content SHA-256** (v0.44, [ADR 0057](docs/adr/0057-write-stream-source-sha256.md), CinderSync gap G22): the `VaultContentSource` the coordinator hands to `VaultAdapter.writeStream` now has `sha256` (64 lowercase hex chars, the same name and format as `VaultVersion.hash` and `StreamEntry.sha256`). It is the version's `node.hash`, already verified over the whole content when the P2P stream finished. Adapters can hash while writing their temp file and compare before replacing the destination; on a mismatch return `false` and the coordinator re-reads later. The field is optional in the type (for sources you build yourself); defaults are unchanged. Also fixed: `retryPeers(device)` now also opens (or reuses) the channel to that device and attaches the receiver, so a peer that only waits for incoming large files can call it after probing; a `readUrls` relay entering the write set (resending for `durability.standby`) now notifies health listeners, so `watchRelayFileLimits` recomputes; `parseConflictCopyName` now recognizes copies of files without an extension made on a device whose name contains a dot (`README (衝突-Joe.Mac-…)`).
- **Standby relay lists shared through the roster — as suggestions** (v0.45, [ADR 0056](docs/adr/0056-roster-shared-relay-list.md), user decision "甲", CinderSync gap G11 part 1): each device signs its own standby list into the roster (`membership.declareStandby(urls)`; a `standby` field next to `caps`, ignored by older versions). Receivers only get **suggestions to add**: `StandbySuggestions` (or the pure `planStandbyAdoption`) lists the standby relays other active members declared that this device does not have — never removals, never the main list — limited to public `wss://` URLs (no credentials, no localhost/private/reserved ranges or LAN domains, ≤ 200 chars, at most 4 per device), probes each new URL (`probe`, e.g. `probeRelayEndpoint`) and remembers ignored ones. **Adoption is the app's job, after the user confirms.** Pairing welcomes carry the inviter's standby list as a suggestion too (`PairingResult.standby`).
  ```ts
  membership.declareStandby(settings.standbyRelayUrls);
  const suggestions = new StandbySuggestions({ probe: (url) => probeRelayEndpoint(url, fetch), ignored: loadIgnored() });
  membership.onChange(() => suggestions.update({ own: [...relays, ...standby], declared: membership.declaredStandbys(), isMember: (pk) => membership.isMember(pk) }));
  suggestions.onChange(() => render(suggestions.list())); // { url, sources, probe: 'pending' | 'reachable' | 'unreachable' }
  ```
- **Sparse members: know the whole vault, keep only part of the content** (v0.46, [ADR 0058](docs/adr/0058-sparse-vault-members.md), user decisions of 2026-10-05). A device (e.g. a phone app) stays a full member of the vault (it holds every key) but sets a content scope: `new VaultSyncCoordinator({ ..., scope: { content: ['Daily/', 'Inbox/'], create: ['Daily/', 'Inbox/'], cacheBytes } })` (rules in the exclude syntax, `{ includes }` or a function; `setScope()` at runtime, `null` = full member). Out of scope it receives and merges **version info only** — no merging, nothing written to disk, **no content kept** — so `remoteIndex()` / `lookup(path)` list the whole tree (path, size, hash, time, deleted, local, pinned, cached), while digests and `peerStatus` stay consistent. On demand: `fetch(path, { timeoutMs })` (a `want` with `fetch: true`, never trimmed, written to disk and cached), `pin` / `unpin`, an LRU cache (`cacheBytes`, default 200 MiB) and `evict(path)`, which removes the local copy **without creating a delete version** — also the fix for ADR 0047's rolling-window risk (an app deleting an excluded copy turned into a deletion when re-included). Creating a file over a path whose content this device doesn't have produces no version (`VaultScopeError('base-missing')`), and `scope.create` / `canCreate()` limit where new files may be created. Members declare their scope in the roster (`membership.declareSparse(patterns)`, `scopeOf`, `sparseMembers`, `fullMembers`, a self-signed field ignored by older versions); full members then **trim per recipient** (`sync.setPeerScopes(sparsePeerScopes(membership))`): out-of-scope versions go without content over the relay (`VaultSendOptions` `to` / `omitContentFor`, needs `deviceOf`), over P2P, and in the initial catch-up, where version-only entries are batched into `nodes` messages — a sparse member joining a 5,000-file vault receives 84 messages / 1.6 MB instead of 5,000 / 8.0 MB. A sparse member is not a content source; a full member can stay resident between scheduled rounds answering only `want`s with `VaultWantResponder`. Content this device wrote is kept until a full member confirms it; content that arrives late is kept; pending content is re-requested after a restart. **Removals now say when they are evictions** (v0.46.1, [ADR 0060](docs/adr/0060-evict-reason-on-host-removal.md), CinderSync G23): the `remove` change handed to `applyRemote` carries `evict: 'scope' | 'lru' | 'evict'` (same value as the `evicted` event), and without `applyRemote` the adapter gets `remove(path, expect, { evict })` — so the host can delete the file directly instead of backing it up or moving it to the trash. Real deletions are unchanged (no `evict` field, two arguments).
  ```ts
  membership.declareSparse(['Daily/', 'Inbox/']);
  const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, scope: { content: ['Daily/', 'Inbox/'], create: ['Daily/', 'Inbox/'] } });
  const tree = sync.remoteIndex();                       // the whole vault, content or not
  const bytes = await sync.fetch('Projects/plan.md');   // open an out-of-scope note
  await sync.evict('Projects/plan.md');                  // "remove from this device" — not a delete
  // applyRemote: if (change.type === 'remove' && change.evict) → delete directly, no backup / trash (v0.46.1)
  // full members (CinderSync): sync.setPeerScopes(sparsePeerScopes(membership)); transport needs deviceOf
  ```
- **Markdown merge rules: same-path files created on two devices are merged; task checkboxes auto-merge** (v0.46, [ADR 0059](docs/adr/0059-markdown-merge-rules-same-path-creation-and-task-checkboxes.md), user decisions 5 and 7). Two devices that each create the same path (today's daily note) no longer produce a conflict copy: the later file is folded into the earlier one and the two are merged three-way **with an empty common ancestor** (refined to the lines both have, so the template appears once and only same-spot insertions conflict — those go into a callout or, without callouts, a conflict copy); the on-disk copy is handed over, not deleted and rewritten. Conflict blocks that differ only in task checkboxes (`- [ ]` / `- [x]`, including Tasks' `✅ YYYY-MM-DD`) merge automatically — **checked wins** (order-independent, needs no per-line time). Both change merge results, so they apply only when **every** head carries the new mark in its version id (like ADR 0046's callouts); turn the mark on with `mergeRules: true` / `setMergeRules()` once **all** roster members declare `MERGE_RULES_CAPABILITY` (`membership.allDeclare(...)`). Off by default. Pure helpers in `./sync`: `merge3(base, a, b, { resolve })`, `resolveTaskCheckboxConflict`, `commonLinesBase`.
- **Client-side version history: local archive, restore, whole-vault point in time, checkpoints** (v0.49, [ADR 0063](docs/adr/0063-client-side-version-history.md), user decisions 2026-10-08). **The relay and the wire format are unchanged**: history lives only in this device's state store and is never synced or sent anywhere. The coordinator archives every version (produced here or received), separately from the sync version graph (the graph is still pruned; the archive is not affected): text content is deduplicated by hash (`hc:`), **binary files keep metadata only, never content** (restorable only while the content equals the current file); excluded paths are not archived, and evicting a local copy is not a deletion. Option `history: { enabled, keepDays: 30, maxVersionsPerFile: 100, maxBytes: 1 GiB, dayBoundary: 'local' }`, on by default for full members and **off for lightweight members**; thinning keeps everything from the last hour, one per hour within a day, then one per (local) day. `history(path)` (deleted files included, follows renames), `readHistory(versionId)`, `restore(path, versionId)` (old content written back as a **new local change** on top of the current heads and synced as usual — history is never rewritten; deleted files come back with the same identity), `deletedFiles({ since })`, `clearHistory()`. Since v0.57.1 ([ADR 0079](docs/adr/0079-history-entry-absorbed.md)) a deletion that only folded this file into another one at the same path (same note created on two devices) carries `absorbed: true`, so apps can show it as merged rather than deleted. Whole vault: `vaultAt(T)`, `planRestoreVault(T, { paths, removeCreatedAfter })` (preview only: revert, undelete, files created after T, unrestorable) and `restoreVault(plan)` (new versions file by file; skips are reported, never thrown midway). Borrowed from git: **checkpoints** (whole-vault manifests stored as a delta chain, created automatically at quiescent points at most hourly), `restoreVault` first takes a "before restore" checkpoint and appends to an **operation log** (`operations()`; undo = restore to that checkpoint), and **named checkpoints** (`checkpoint({ name })`, up to 50, content kept regardless of age and size limits); point-in-time lookups start from the nearest checkpoint (`source: 'checkpoint' | 'reconstructed'`, `mixed`), or take one directly: `planRestoreVault({ checkpoint: id })`. Content that would be overwritten or removed must be in the archive first (so binary files created after T are never removed).
  ```ts
  const versions = await sync.history('notes/a.md');           // newest first (async since v0.50)
  await sync.restore('notes/a.md', versions[3]);                // a new local change, synced as usual; pass the entry (or a version id)
  const plan = await sync.planRestoreVault(yesterday9am, { paths: ['Projects/'] });
  await sync.restoreVault(plan);
  const [op] = sync.operations();                               // undo that restore (undoAvailable is false once its checkpoint expired)
  if (op.undoAvailable) await sync.restoreVault(await sync.planRestoreVault({ checkpoint: op.before!, removeCreatedAfter: true }));
  await sync.checkpoint({ name: 'before submission' });
  ```
- **Version history v0.50: lazy loading, opt-in removal of binaries created after T, "before restore" checkpoints follow the retention period** (v0.50, [ADR 0063](docs/adr/0063-client-side-version-history.md), "User decisions (2026-10-08, the three open items)" and "Implementation (v0.50)"). **The state-store layout changed and is migrated once at startup**; the wire format and the relay are unchanged.
  - **Lazy loading**: startup reads only a per-file summary (`hs:`, 256 shards: version count, newest/oldest time, bytes, has-deleted, the latest version and the paths used), so `historyStatus()` and `deletedFiles()` stay synchronous; a file's full records (`ha:<fileId>`, same format as before) are read the first time `history()`/`readHistory()` needs them and kept in an LRU cache (at most 256 files or 20,000 versions); whole-vault `vaultAt`/`planRestoreVault`, thinning and the byte budget go file by file (files whose summary suffices are not read). Archived content `hc:<hash>` now stores "referencing files + content", so startup no longer has to read every version to count references. Measured with 20,000 files × 50 versions: startup went from 4–10 s and +392 MiB heap to 0.15–0.5 s and +11 MiB (`scripts/bench-history.mjs`).
  - **Async API (breaking)**: `history()`, `vaultAt()` and `planRestoreVault()` return Promises; `readHistory`/`restore` also accept `{ fileId, versionId }` (e.g. an entry returned by `history()`, the fastest form).
  - **Binary files created after T**: `planRestoreVault(T, { removeCreatedAfter: true, removeCreatedBinaries: true })` lists them for removal with `irreversible: true` (the archive has no content, so undoing the restore cannot bring them back) and the total in `irreversibleBytes`; `restoreVault(plan, { beforeIrreversible })` is called right before each such removal so the app can back the file up — throwing or returning false skips that file (`backup-failed`).
  - **"Before restore" checkpoints expire with `keepDays`**: the operation log keeps the entry with `undoAvailable: false` and `undoUnavailable: 'before-expired'` (`before-deleted` when deleted, `before-evicted` when evicted by the byte budget, `no-checkpoint` for single-file restores); using it again throws `VaultHistoryError('checkpoint-expired')`.
- **Orphaned file chunks stop piling up** (v0.60, [ADR 0084](docs/adr/0084-whole-inbox-backfill-on-start.md), [ADR 0085](docs/adr/0085-batch-evict-file-chunks.md)). Client: each transport (each app start) reads the whole inbox once without `since` when at least one relay declares inbox acks, so frames of messages that can never be completed are acked (ADR 0081) even on devices that always resume from their last sync time; later backfills use `since` as before. Relay: when the relay itself evicts file chunks (per-recipient cap, ceiling, excess over guarantee, borrowed rows expiring after 2 h) it removes the **whole batch** — same recipient, kind 1060, same `expiration` tag — instead of leaving the rest of a message behind; batch mates count as dropped. No new metadata and no client update needed; SQLite stores gain a nullable `batch` column and a partial index (rows written by older code have NULL and are evicted row by row as before). Known trade-off: another message sent to the same person in the same second may be evicted together.
- **Early expiry after an inbox ack** (v0.51, [ADR 0067](docs/adr/0067-inbox-ack-early-expiry.md)): once the receiving device has processed and saved a sync message, it tells the relay with an ephemeral kind 25190 event, and the relay cuts the rows **addressed to that device alone** to "now + 2 hours" (the same retention as unregistered apps); the ack itself is neither stored nor forwarded. 14-day simulation: average relay storage 243.6 → 11.1 MB, repeated downloads 86% → 40%.
- **Renaming a device** (v0.52, [ADR 0069](docs/adr/0069-roster-device-rename.md)): a device re-signs its own name with a timestamp into the roster (`membership.declareLabel(name)`, a self-signed `labels` field next to `caps` / `standby` / `sparse`; the later one wins, older versions ignore it and keep showing the name from pairing). `devices()`, `selfDevice`, `declaredStandbys()` and `sparseMembers()` return the current name; the entry signed at pairing is untouched. Pairing welcomes carry only the inviter's own rename; the others follow with the next roster sync. `sync.setDeviceLabel(name)` switches the coordinator's name at runtime (new versions and conflict copies use it; existing ones keep theirs).
  ```ts
  membership.declareLabel(settings.deviceName); // on start and on rename; false when unchanged
  sync.setDeviceLabel(settings.deviceName);
  ```
  ```
- **Moving a file into this device's excluded range is not a delete** (v0.53, [ADR 0071](docs/adr/0071-move-into-excluded-is-not-delete.md)): a rename whose new path is excluded by `excludes` (not `ignore`) stops tracking the file instead of deleting it — other devices keep it, and their edits are not written back to the old path here. Removing the rule, or moving the file back into the synced range, sends it as a rename on top of the version it had when tracking stopped, merged with what others changed meanwhile. Apps that keep a trash folder in `excludes` must report moving to the trash as a **delete**. Only live rename events count; moves made while the app was closed still look like a delete.
- **Restore preview lists what stays** (v0.53, [ADR 0070](docs/adr/0070-restore-plan-keep-list.md)): without `removeCreatedAfter`, `planRestoreVault` returns `keep` — files created after T that this restore leaves in place (for display only; `restoreVault` ignores it).
  ```ts
  const plan = await sync.planRestoreVault(T);
  render(plan.revert, plan.undelete, plan.keep ?? []); // keep: created later, left as is
  ```
- **Relay budget per recipient, cleared by encrypted receipts** (v0.54, [ADR 0068](docs/adr/0068-per-recipient-relay-budget-with-encrypted-receipts.md)): every relayed sync message carries the sender's sequence number (`rs`); once the receiving device has processed and saved it, it sends back a small encrypted `receipt` (sequence ranges, to that sender only — the relay sees just another wrap). The sender keeps one ledger per recipient (`relay-ledger.ts`): a receipt clears that device's share, otherwise it expires after the retention period as before. In bulk mode a recipient whose ledger is full is left out (`to`) and the version stays owed to it; the others keep going. Receipts also tell the sender which versions that device now has, so `peerStatus(device).missing` updates without waiting for its digest. Needs `transport.recipients()` (`NostrVaultTransport` with `deviceOf`); without it there is one ledger as before. Older devices send no receipts, so their share only expires. `status.relayQuota.devices` lists every recipient (fullest first). No relay support needed.
  ```ts
  await sync.flushReceipts(); // scheduled sync: send pending receipts before disconnecting
  new VaultSyncCoordinator({ ..., receipts: false }); // behave like older versions
  ```
- **Apps can decide when automatic checkpoints are taken** (v0.55, [ADR 0072](docs/adr/0072-app-driven-auto-checkpoints.md)): with `autoCheckpoint: 'app'` the coordinator no longer takes them when sync goes idle; call `checkpoint({ auto: true, minIntervalMs })` at your own sync points — it returns `null` until `minIntervalMs` has passed since the last automatic checkpoint, or when nothing changed (which does not use up the interval). The default (`'idle'`, at most hourly when sync is idle) is unchanged, except that an attempt that created nothing no longer blocks the next hour.
  ```ts
  // CinderSync: after each completed sync round, at most one per sync interval
  await sync.checkpoint({ auto: true, minIntervalMs: intervalMs - 5 * 60_000 });
  - Relay: NIP-11 declares `cinder_inbox_ack: { kind, grace_sec }`; it acts only when the AUTH identity is the signer, and only ever shortens expiry. Read-only grace paths and the Node host with `REQUIRE_AUTH=0` neither declare nor handle it. **Takes effect after a redeploy**; relays that are not upgraded keep the full retention.
  - Client: `createNostrVaultTransport` sends acks by default (`inboxAck: false` turns it off), only to the relays in `inboxAckRelays` / `setInboxAckRelays`: call `transport.setInboxAckRelays(inboxAckRelays(policies))` from `watchRelayFileLimits`' `onLimits` (third argument `policies`). Messages from untrusted senders, incomplete ones and unsaved ones are never acked.
  - Also: `onMessage` listeners may return a Promise (resolved = processed and saved); `RelayPool.publish(e, { relays })` sends to the listed relays only. Wire format and roster unchanged; devices need not upgrade together.
- **IoT realtime channel, relay side (route C′ R1)** (v0.59, [ADR 0049](docs/adr/0049-iot-relay-modes.md) §9–§10): devices keep one `wss` to the relay and get commands pushed immediately (doors, garage doors). **Self-hosted only, off unless configured.** The relay *is* the gateway on this route: it holds the gateway signing key and device-token hashes, **never the home secret or device keys** — commands and state travel inside an AES-256-GCM device envelope (§2.6, `sealIotEnvelope`/`openIotEnvelope` in `./iot`; AAD binds direction, kid, counter and time; nonce spaces of the two directions never overlap; vectors cross-checked against Node crypto). Phones send `dev-cmd` (needs operator) / `dev-query` / `dev-link` encrypted to the gateway; the relay checks the signer's role per device (a per-device `minRole`, e.g. owner for locks; topic-scoped entries fail closed because the relay cannot see topics), the key epoch (with a grace window) and the envelope time, then pushes the frame or answers `offline` / `stale` at once (realtime commands are never queued). Device acks go back as kind 25171 to the members waiting on that device; state as 25172 plus a retained 31170 at most every 5 minutes. Endpoints `/iot/v1/home/<homeTag>` (phones, Nostr) and `/iot/v1/dev/<homeTag>/<blindId>` (devices, `Authorization: Bearer cit1_…`, one connection per device — a new one closes the old with 4409); heartbeats `{"t":"hb"}` are answered by the platform on Workers (`setWebSocketAutoResponse`, not billed). Per-home daily budget (§10.3): 80% warns owners (`$sys/quota`), 95% drops telemetry, 100% closes everything with 4429 `iot-quota:<reset>` and answers new upgrades `503` + `Retry-After` + `Cinder-Quota`; Durable Object overage errors become the same structured 503. Workers: DO class `IotHomeRoom` on binding `IOT_HOME`; Node: same core, checked before the upgrade is accepted. Env: `IOT_REALTIME` (JSON), `IOT_GATEWAY_KEYS` (secret), `IOT_HOME_DAILY_REQUESTS`, optional `IOT_UPGRADE_LIMIT`. Not yet: the phone-side API (`urgency`, `deviceLink()`, `unknown → query`), `./iot/device`, NIP-11 and CLI/config wiring (R2); never deployed to Cloudflare or run against real ESP32/Tasmota devices yet.
- **IoT push: alarms reach the phone while the app is closed** (v0.40, [ADR 0049](docs/adr/0049-iot-relay-modes.md) §11.1, building on Cinderous ADR-0272 and SDK ADR 0011 §6). The model ruled by the user: **the client brings its own push endpoint, FCM/APNs credentials live only in the app developer's push gateway, and whoever knows the endpoint sends**. Wakes are **always empty** — no device, content or category; the app wakes, reads retained state from the relay and decides locally whether to notify.
  - `./iot` (neutral): two endpoint kinds on equal footing — `unifiedpush` (a UnifiedPush/ntfy URL; the sender POSTs a contentless push, RFC 8030) and `gateway` (push gateway URL + the FCM/APNs token sealed to the gateway's public key with `sealIotPushToken` + a per-registration key; senders never see the token and sign each wake with HMAC over a strictly increasing timestamp). Subscriptions are blinded device ids plus a per-subscription `mode`: `standard` (default; 60 s coalescing + 0–30 s jitter) or `instant` (no coalescing, 0–2 s jitter, at most 6 per endpoint per minute — the consent screen must say Google/Apple then see exact times). The quota warning is a special item only owners may subscribe to. Registrations go as encrypted commands to the reserved topic `$sys/push` (the endpoint is additionally NIP-44-encrypted to the sender, so other household members cannot read it). `IotClient.registerPush()`/`updatePush()`/`revokePush()`; `IotPushScheduler` (clock, randomness and timers injectable); limits `IOT_PUSH_LIMITS` (32 endpoints per home, 1/min standard, 6/min instant, 30-day TTL — all configurable).
  - `IotGateway` (route A sends): `push: { store, send, limits }` — accepts `$sys/push` from any active member, keeps the endpoint list with a TTL, wakes subscribers when a device's state **changes** (iOS `ref` = the 25172 event id), `notifyPushSpecial('quota')`, drops a member's endpoints when the owner removes them, deletes endpoints that answer 404/410. The home bridge enables it with a `push` section in `iot-bridge.json` (`fileIotPushStore`, `--push-file`).
  - **Reference push gateway** `@cinderous/client/iot/push-gateway` (neutral core) + `./worker` (Workers: FCM HTTP v1 for Android with a service-account RS256 JWT via WebCrypto; replay/revocation/rate state in one Durable Object per token) + `./node` (Node: same FCM). **Both talk to APNs directly for iOS** (`PUSH_IOS=apns`, ES256 provider token, no Google): the APNs request, provider token and reason mapping are shared, only the transport differs — `fetch()` on Workers (`fetchApnsTransport`; the Cloudflare edge speaks HTTP/2 to APNs, measured in ADR 0049 §11; local `wrangler dev` cannot reach APNs) and `node:http2` on Node. Since v0.47 ([ADR 0061](docs/adr/0061-workers-push-gateway-direct-apns.md)); **since v0.48, unset `PUSH_IOS` means `apns`** ([ADR 0062](docs/adr/0062-push-gateway-ios-default-apns.md), breaking). Android-only deployments set `PUSH_IOS=off` (no Apple key); an explicit `PUSH_IOS=fcm` (iOS through FCM, so Google sees iOS wake times too) still works but is **deprecated on both editions**; switching from `fcm` to `apns` has no transition period (old iOS FCM registrations get 501 until the app re-registers). On APNs errors the log carries a whitelisted `apnsReason` (e.g. `BadEnvironmentKeyInToken` = the key's environment does not match `APNS_ENV`); the response does not. The provider token is cached for 50 minutes (Apple: 20–60), signed once for concurrent sends and re-signed once on `403 ExpiredProviderToken`; `Unregistered` / `BadDeviceToken` / `DeviceTokenNotForTopic` tell the sender to drop the endpoint. It unseals, verifies the HMAC in constant time, enforces the timestamp window and strict ordering, rejects expired/revoked envelopes and rate-limits per token (60/h, 6/min by default). Android gets an FCM high-priority **empty** data message; iOS gets an alert push with `mutable-content` whose payload is only a localization key plus the opaque event id for the Notification Service Extension (`assertContentlessPushPayload` guards both). Credentials are read only from environment variables / Worker secrets and never appear in responses, errors or logs (tested).
  - Deploy configurator: `service: "push-gateway"` in `cinderous.config.json` (Workers targets = Workers edition, docker/fly/home-tunnel = Node edition; `pushGateway.ios: "apns"` with `apnsTopic` / `apnsKeyId` / `apnsTeamId` / `apnsEnvironment` and `secrets.apnsKey` on both — on Workers the guide pipes the .p8 straight into `wrangler secret put APNS_KEY`; since v0.48 unset `ios` means `"apns"` and the missing-field errors name the default and the three ways out; `ios: "off"` is Android only; `ios: "fcm"` gets a `push-ios-fcm-deprecated` warning on both editions); the limits are `DEPLOY_OPTION_SPECS` entries (`pushGateway.tokenPerHour`, `tokenPerMinute`, `maxSkewSec`, `maxRegistrationDays`); `relay build` writes the package and a zh-TW/en `README-DEPLOY.md` with the Firebase service-account and APNs key steps and the privacy note. `cinderous iot push-keygen` creates the gateway key.
  - Device side: the spec and a zero-dependency Node reference sender (MIT-0) in `examples/iot-device/`, byte-compatible with the SDK (test vectors included). Not done here: the relay (family DO) as a sender (waits for C′; the interface is reserved), ESP32/Tasmota firmware, and the app's own FCM/APNs registration and NSE.
  ```ts
  import { sealIotPushToken } from '@cinderous/client/iot';
  const info = await (await fetch('https://push.example.com/v1/info')).json();
  const { sealed, key } = sealIotPushToken(info.pubkey, { platform: 'android', token: fcmToken });
  await iot.registerPush({ type: 'gateway', url: 'https://push.example.com', sealed, key }, [{ device: 'front-door', mode: 'instant' }, { device: 'thermo' }]);
  await iot.registerPush({ type: 'unifiedpush', url: upEndpoint }, [{ device: 'front-door' }]);   // UnifiedPush: no gateway needed
  ```
- **No more missed gift wraps after a reconnect** (v0.30, [ADR 0035](docs/adr/0035-backdated-resubscribe-capabilities-and-identical-collisions.md)): when a relay connection came back, `RelayPool` resubscribed with `since` = the newest `created_at` it had seen. NIP-59 pushes the outer `created_at` of every gift wrap up to two days into the past, and relays apply `since` to live events too, so after the first reconnect most incoming NIP-17 DMs (kind 1059), vault-sync / roster messages (kind 1060) and call / SDP signals were silently dropped until the next reconnect. Now filters that can carry back-dated events — kinds 1059 or 1060, or any `#p` (inbox) filter — resume from the cursor **minus two days** (`NIP59_MAX_BACKDATE_SEC`); other filters keep the exact cursor. A caller can declare its own window with `pool.subscribe(filters, handlers, { backdateWindowSec })` (0 turns it off). Re-fetched events are dropped by the subscription's id de-duplication. The extra traffic per reconnect is bounded by the relay's per-REQ byte budget (16 MB on Cinderous relays; for DMs it is usually a few KB); older events that the budget cuts off are still recovered by `NostrVaultTransport.backfill()` / `forEachPage` paging. `FastHydrator` and `backfill()` already stepped back two days and are unchanged. No API break: custom `RelayTransport`s that take two arguments still type-check.
- **Device capabilities on the vault roster** (v0.30, ADR 0035): `membership.declareCapabilities()` adds a self-signed `{ sdk, maxRelayFileBytes }` entry (plus room for future flags) to the roster; `membership.minCapability()` returns what every active member supports, treating members without an entry (≤ v0.29) as the old 16.5 MB. Wire it with `coordinator.setMemberCapabilities(membership.minCapability())` on every roster change — the relay file threshold becomes min(relay limit, members) — and only then raise `setRelayLimits` above 16.5 MB. Old rosters without `caps` still parse; old devices ignore and drop the field without breaking convergence. A member can only sign its own capabilities; overstating them only makes others send it files it cannot take.
- **Identical files no longer create conflict copies** (v0.30, ADR 0035): when two different files claim the same path with the **same content hash** (typically a new device joining with notes it already has), the coordinator folds the losing file into the winner (a deterministic delete version, disk ownership handed over, no disk writes) instead of renaming it to a conflict copy. Different content still produces a copy exactly as before. Mixed with ≤ v0.29 devices the result converges to the same single file.

> ⚠ The crypto engines are **experimental**. The Double Ratchet is newly written code that has had one internal independent review but **no external audit**. The post-quantum hybrid protects encryption only — signatures are still secp256k1 — so it defends against "harvest now, decrypt later", and **this is not "quantum-safe"**.

Install from the public GitHub repository, pinned to a tag: `npm install github:VaalRL/cinderous-sdk#v0.77.3` ([ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)).

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
A malformed allowlist entry stops the relay from starting instead of silently opening it up. Non-allowlisted keys are disconnected with close code 4003 right after AUTH; by default each pubkey may hold 5 connections and each IP may send 20 messages per second (tune with `MAX_CONNECTIONS_PER_PUBKEY` / `MAX_MESSAGES_PER_SECOND_PER_IP`; set `TRUST_PROXY=1` behind a reverse proxy). No Docker image is published yet; it will be `ghcr.io/vaalrl/cinderous-relay-lite`.

**Serving `wss://` from a VPS** (domain, automatic HTTPS with Caddy, localhost-only binding, firewall, systemd, maintenance): follow **[docs/guides/self-host-vps.md](docs/guides/self-host-vps.md)** ([ADR 0109](docs/adr/0109-vps-self-host-guide.md)).

**Storage ceiling (SDK ADR 0099).** The Node relay reads the same capacity variables as the Cloudflare relay, with `strict` as the only target: `DO_CEILINGS_MIB=strict=4096/512` caps offline messages at 4 GiB and snapshots at 512 MiB (up to 1 TiB each; default 128/128 MiB). `CEILING_MODE=reject` (default) refuses new messages when full (senders get `blocked: ceiling` and can switch relays); `CEILING_MODE=evict` keeps accepting and drops what expires soonest. `DO_NEAR_FULL_PERCENT`, `DO_DROP_NOTICES`, `DO_BORROW_PERCENT` and (evict only) `DO_GUARANTEE_KIB` work as on Cloudflare. Entries the relay cannot apply are logged at startup and ignored.

**Connection caps (SDK ADR 0100).** `MAX_CONNECTIONS` limits simultaneous connections for the whole relay and `MAX_CONNECTIONS_PER_IP` per source IP (behind a reverse proxy, set `TRUST_PROXY=1`). Both are unlimited when unset, since mobile carriers and offices often share one IP. A connection over the cap gets a `too many connections:` NOTICE and is closed with 1013 (Try Again Later).

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

**Reconnect guard (SDK ADR 0111).** On the main plane (`/`, `/s/<n>`, `/presence`; lanes are not affected), each Durable Object counts upgrades per source IP in memory: more than 20 in 10 minutes blocks that IP for 10 minutes. Tune with `RECONNECT_GUARD=<max>/<window seconds>/<block seconds>` or turn it off with `off`. A blocked upgrade gets a `rate-limited: too many reconnects…` NOTICE and is closed with 1013, so clients back off. If you add a Cloudflare rate-limit binding named `STRICT_UPGRADE_LIMIT` to your `wrangler.toml`, the Worker also limits upgrades per IP and shard before they reach the Durable Object. The deploy tools do not add it. `DIAG_UNAUTH_LOG=1` logs one line per main-plane connection that closes without authenticating: message verbs, subscribed kinds, the relay's replies, lifetime and close code. It never logs content, pubkeys or IPs. It is off by default.

#### Config file (repeatable deployments, [ADR 0050](docs/adr/0050-deploy-configurator.md)):
Keep every choice in `cinderous.config.json` (validated against `schema/cinderous.config.schema.json`) and deploy the same file every time — a redeploy no longer resets a parameter to its default because a flag was forgotten. Secrets are referenced by environment-variable name only.
```bash
npx cinderous config validate cinderous.config.json
npx cinderous relay build --config cinderous.config.json --out deploy/   # portable package + README-DEPLOY.md / README-DEPLOY.en.md
npx cinderous relay deploy --config deploy/cinderous.config.json
```

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
