// 檔案傳輸跑在真的通道上（SDK ADR 0015）：PeerNode 的中繼軌，以及疊在上面的 secureChannel。
import { afterEach, describe, expect, it } from 'vitest';

import { secureChannel } from '../../src/crypto/secure-channel.js';
import { Identity } from '../../src/identity.js';
import { PeerNode, type PeerChannel } from '../../src/peer/peer-node.js';
import { bytesSource, FileTransfer, type ReceivedFile } from '../../src/transfer/file-transfer.js';
import { FakeTransport } from '../fake-transport.js';

const nodes: PeerNode[] = [];
afterEach(() => {
  for (const node of nodes.splice(0)) node.close();
});

async function relayPair() {
  const transport = new FakeTransport();
  transport.relay = true;
  const alice = Identity.generate();
  const bob = Identity.generate();
  const a = new PeerNode({ identity: alice, transport, rtc: null });
  const b = new PeerNode({ identity: bob, transport, rtc: null });
  nodes.push(a, b);
  const incoming = new Promise<PeerChannel>((resolve) => b.onPeer(resolve));
  const toBob = await a.connectPeer(bob.pubkey);
  return { alice, bob, toBob, incoming, transport };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256);
const nextFile = (t: FileTransfer) =>
  new Promise<Uint8Array>((resolve) => t.onFile(async (file: ReceivedFile) => resolve(await file.read())));

describe('FileTransfer × 真的通道', () => {
  it('經 PeerNode 中繼軌（每框 NIP-59）送 200 KB', async () => {
    const { toBob, incoming } = await relayPair();
    const sender = new FileTransfer(toBob);
    // 中繼軌要有第一框送到，對方才知道有這條通道：offer 就是那一框
    const sending = sender.sendFile(bytesSource('a.bin', 'application/octet-stream', bytes(200_000)));
    const receiver = new FileTransfer(await incoming);
    const got = nextFile(receiver);
    await sending;
    expect(await got).toEqual(bytes(200_000));
  }, 30_000);

  it('經 secureChannel（雙棘輪）送檔：中繼上看不到檔案內容', async () => {
    const { alice, bob, toBob, incoming, transport } = await relayPair();
    const [aSide, bSide] = await Promise.all([secureChannel(toBob, alice), incoming.then((c) => secureChannel(c, bob))]);
    const receiver = new FileTransfer(bSide);
    const got = nextFile(receiver);
    const secret = new TextEncoder().encode('機密附件內容'.repeat(100));
    await new FileTransfer(aSide).sendFile(bytesSource('機密.txt', 'text/plain', secret));
    expect(await got).toEqual(secret);
    // 拆開每一框的 NIP-59 之後，也只看得到棘輪密文
    const needle = Buffer.from(secret.subarray(0, 24)).toString('base64');
    const leaked = transport.published.some((e) => {
      try {
        return bob.openWrap(e).rumor.content.includes(needle);
      } catch {
        return false;
      }
    });
    expect(leaked).toBe(false);
  }, 30_000);
});
