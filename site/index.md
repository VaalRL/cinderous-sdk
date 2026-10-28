---
layout: home
title: Cinderous SDK
hero:
  name: Cinderous SDK
  text: Private, local-first sync over Nostr
  tagline: An AGPL-3.0 TypeScript client and a relay you deploy yourself — between your own devices and small teams.
  image:
    src: /logo.svg
    alt: Cinderous
  actions:
    - theme: brand
      text: Read the overview
      link: /README
    - theme: alt
      text: Self-host a relay
      link: /docs/guides/self-host-vps
    - theme: alt
      text: API reference
      link: /api/
      target: _self
    - theme: alt
      text: GitHub
      link: https://github.com/VaalRL/cinderous-sdk
features:
  - title: Plain Nostr on the wire
    details: Events are ordinary NIP-01. The client uses NIP-17, 42, 44, 59 and 98; the relay advertises NIP-01, 11, 13, 40, 42 and 62.
  - title: One key per device
    details: Devices are paired into a roster with a SAS check, and a single device can be removed.
  - title: Git-like sync
    details: Version graph, three-way merge, conflict callouts, tombstones, an offline queue, and local history with checkpoints.
  - title: WebRTC with relay fallback
    details: Large files go peer-to-peer (TURN, resumable) and fall back to the relay automatically.
  - title: Your own relay
    details: One-click deploy to your Cloudflare free tier, or Docker, Fly, a home tunnel or a VPS. The relay is treated as untrusted.
  - title: Encryption, worded precisely
    details: NIP-44 / NIP-59, plus two optional engines with an ML-KEM-768 hybrid key exchange. Signatures are still secp256k1, so this is not "quantum-safe". Experimental, with no external audit yet.
---

## Install

The SDK is not on npm. Install it from GitHub, pinned to a tag — the latest one is at the top of the [Changelog](/CHANGELOG):

```sh
npm install github:VaalRL/cinderous-sdk#vX.Y.Z
```

The `@cinderous` scope on npm belongs to an unrelated account ([ADR 0110](/docs/adr/0110-public-github-repo-not-npm)).

## Before you rely on it

- Relays see metadata — IP addresses, timing, sizes and recipient public keys. Content is end-to-end encrypted; metadata is not hidden.
- Report security problems privately, as described in the [security policy](/SECURITY).
- Contributions are welcome under the DCO; see [Contributing](/CONTRIBUTING).
