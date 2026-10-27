// 產生 `noble-2.0.1-artifacts.json`（SDK ADR 0034）：v0.28.0 在 @noble/curves 2.0.1、@noble/hashes 2.0.1、
// @noble/ciphers 2.1.1（nostr-tools）／2.4.0（SDK）、@scure/base 2.0.0 下產出的事件、簽章、密文與編碼。
//
// 只在「舊版相依」的樹上跑才有意義：checkout v0.28.0 → npm ci → npm run build → node tests/fixtures/gen-noble-2.0.1-artifacts.mjs。
// 升到 noble 2.4 之後，`tests/noble-compat.test.ts` 會用新版去驗這些舊產物（互解、驗章、逐位元組相等）。
import { readFileSync, writeFileSync } from 'node:fs';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey as ntGetPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import * as nip49 from 'nostr-tools/nip49';
import * as nip06 from 'nostr-tools/nip06';
import * as sdk from '../../dist/protocol/index.js';

// 這些套件的 exports 沒有 ./package.json，直接讀安裝位置；nostr-tools 若另有一份也一起記下
const versionAt = (dir) => {
  try {
    return JSON.parse(readFileSync(new URL(`${dir}/package.json`, import.meta.url), 'utf8')).version;
  } catch {
    return undefined;
  }
};
const versions = Object.fromEntries(
  ['@noble/curves', '@noble/hashes', '@noble/ciphers', '@scure/base'].map((n) => [
    n,
    { sdk: versionAt(`../../node_modules/${n}`), nostrTools: versionAt(`../../node_modules/nostr-tools/node_modules/${n}`) ?? 'deduped' },
  ]),
);

const sk1Hex = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const sk2Hex = 'c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add';
const sk1 = hexToBytes(sk1Hex);
const sk2 = hexToBytes(sk2Hex);
const pk1 = ntGetPublicKey(sk1);
const pk2 = ntGetPublicKey(sk2);

const template = { kind: 1, created_at: 1_790_000_000, tags: [['t', 'cinderous']], content: 'noble 2.0.1 → 2.4 相容性 🔥' };
const ntEvent = finalizeEvent({ ...template }, sk1);
const sdkEvent = sdk.finalizeEvent({ ...template }, sk1);
if (!verifyEvent(ntEvent) || !sdk.verifyEvent(sdkEvent)) throw new Error('自驗失敗');

// BIP-340 以固定 auxRand 簽章是確定性的：新版必須逐位元組產出同一個簽章
const msg = hexToBytes(ntEvent.id);
const aux = new Uint8Array(32).fill(7);
const deterministicSig = bytesToHex(schnorr.sign(msg, sk1, aux));

const ecdh = bytesToHex(secp256k1.getSharedSecret(sk1, hexToBytes(`02${pk2}`)));
const convKey = nip44.v2.utils.getConversationKey(sk1, pk2);
const nonce = hexToBytes('b0'.repeat(32));
const nip44Payload = nip44.v2.encrypt('跨版本 NIP-44：固定 nonce', convKey, nonce);

const relays = ['wss://relay.example.com', 'wss://cinder-relay.example.workers.dev', 'wss://another.relay.example.org'];
const nprofile = nip19.nprofileEncode({ pubkey: pk1, relays });
const nevent = nip19.neventEncode({ id: ntEvent.id, relays, author: pk1, kind: 1 });
const naddr = nip19.naddrEncode({ identifier: 'cinderous-noble-24', pubkey: pk1, kind: 30023, relays });

const giftWrap = nip59.wrapEvent({ kind: 14, created_at: template.created_at, tags: [['p', pk2]], content: 'nostr-tools gift wrap（2.0.1）' }, sk1, pk2);
const sdkWrap = sdk.sealAndWrap(
  { kind: 14, created_at: template.created_at, tags: [['p', pk2]], content: 'SDK sealAndWrap（2.0.1）' },
  sk1,
  pk2,
  { kind: 1059, tags: [['p', pk2]] },
);

const ncryptsec = nip49.encrypt(sk1, 'cinderous-密碼', 4, 0x02);
const mnemonic = 'leader monkey parrot ring guide accident before fence cannon height naive bean';

const out = {
  _meta: {
    note: 'SDK v0.28.0 產出；由 tests/fixtures/gen-noble-2.0.1-artifacts.mjs 產生，SDK ADR 0034',
    versions,
  },
  keys: { sk1: sk1Hex, sk2: sk2Hex, pk1, pk2, sdkPk1: sdk.getPublicKey(sk1) },
  npub1: nip19.npubEncode(pk1),
  nsec1: nip19.nsecEncode(sk1),
  sdkNpub1: sdk.npubEncode(pk1),
  sdkNsec1: sdk.nsecEncode(sk1),
  nprofile,
  nevent,
  naddr,
  ntEvent,
  sdkEvent,
  deterministic: { msg: ntEvent.id, aux: bytesToHex(aux), sig: deterministicSig },
  ecdh,
  nip44: { conversationKey: bytesToHex(convKey), nonce: bytesToHex(nonce), payload: nip44Payload, sdkConversationKey: bytesToHex(sdk.conversationKey(sk1, pk2)) },
  giftWrap,
  sdkWrap,
  nip49: { password: 'cinderous-密碼', ncryptsec },
  nip06: { mnemonic, sk0: bytesToHex(nip06.privateKeyFromSeedWords(mnemonic, undefined, 0)) },
};

writeFileSync(new URL('./noble-2.0.1-artifacts.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log('寫出 noble-2.0.1-artifacts.json', versions);
