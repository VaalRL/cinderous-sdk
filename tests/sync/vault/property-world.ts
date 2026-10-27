// 隨機化性質測試的世界（SDK ADR 0025 §測試）：多台裝置隨機操作＋隨機網路延遲、斷線、重送、重啟，
// 最後所有裝置的檔案樹一致，而且任何一次本機寫入的內容，除非是使用者自己刪掉的，都還找得到
// （在原檔或衝突副本裡）。每個種子可重現：失敗時訊息裡有種子與操作紀錄。
import { Identity } from '../../../src/identity.js';
import { acceptPairingUri, claimDevice, createPairingOffer, NostrRosterSync, VaultMembership } from '../../../src/pairing/index.js';
import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import { compilePathFilter, isVaultScopeError, type VaultSyncOptions, type VaultVersion } from '../../../src/sync/vault/index.js';
import { decodeJson } from '../../../src/sync/vault/state-store.js';
import { FakeRelay, settle as settleRelay } from '../../pairing/fake-relay.js';
import { type Device, MemoryVault, Net, rng, str, text } from './harness.js';

export const OPS = Number(process.env.VAULT_PROPERTY_OPS ?? 150);
const TOKEN = /tok-[a-z0-9]+-\d+/g;

const DIRS = ['', 'd1/', 'd2/sub/'];
const NAMES = ['a', 'b', 'c', 'Note', 'note', 'x y'];

export function tokensOf(bytes: Uint8Array): string[] {
  // 大檔（P2P 情境）的 token 在開頭，後面都是零：只看前面一段
  if (bytes.length > 1 << 20) bytes = bytes.subarray(0, 4096);
  const s = str(bytes[0] === 0xff ? bytes.subarray(1) : bytes);
  return s.match(TOKEN) ?? [];
}

export interface WorldOptions {
  /** 裝置之間有 P2P（SDK ADR 0026）：大量變更走批次串流、大檔經 P2P 直送 */
  p2p?: boolean;
  /** 跑到一半加入一台全新的裝置（空的 Vault） */
  lateJoin?: boolean;
  /** 偶爾寫超過檔案塊層的大檔（只走 P2P） */
  bigFiles?: boolean;
  /**
   * 新裝置以真的 QR 配對加入（SDK ADR 0028）：每台裝置一把身分、一份 `VaultMembership`，名單經 `NostrRosterSync`
   * 同步；假中繼只投遞「收件裝置名單上有寄件裝置」的訊息（像 `NostrVaultTransport` 的信任名單）；
   * 名單加入新裝置後呼叫協調器的 `resync()`。需要 `lateJoin`。
   */
  pairing?: boolean;
  /**
   * 衝突 callout（SDK ADR 0046）：`true`＝每台都開 `conflictCallouts`（Markdown 同行衝突就地放進 callout）；
   * `'mixed'`＝第二台（d1）沒開，含它的版本頭的合併照舊產生衝突副本。
   */
  callouts?: boolean | 'mixed';
  /**
   * 同步排除範圍（SDK ADR 0047）：每台裝置一組隨機的排除規則（各台不同），跑到一半隨機加入／移除。
   * 每次 `setExcludes` 都檢查：本機的內容一個都沒少、沒有產生任何「真的刪除」的版本。
   */
  excludes?: boolean;
  /**
   * 配對前各台就有檔案（像複製資料夾，SDK ADR 0048）：同路徑、沒有共同祖先，有的內容不同、有的相同、有的一方是空檔、有的兩方都空；
   * 各台**同時**啟動、都在線。啟動後跑到靜止時檢查（`initialMaxWrites` ≤ 1 表示都在界內）：每台對每個衝突副本最多寫一次、
   * 對原路徑最多（裝置數 − 1）次（每知道一個更早佔用的檔案就換一次留下的）。
   */
  prepaired?: boolean;
  /** 協調器自己的寫入、刪除、改名也觸發事件，防抖 500 ms 後通知（像 Obsidian＋CinderSync；SDK ADR 0048） */
  echo?: boolean;
  /** Markdown 合併規則（SDK ADR 0059）：每台都開 `mergeRules`（同路徑新建的文字檔收成一個、勾選框自動合併） */
  mergeRules?: boolean;
  /**
   * 輕量成員（SDK ADR 0058）：d1 只保存 {@link SPARSE_SCOPE} 的內容，其他台宣告它是輕量的（`peerScopes`）。
   * d1 在「內容不在這台的檔案路徑」上新增的檔案會被擋下（不同步，留在 d1）：記在 `world.blocked`。
   */
  sparse?: boolean;
}

/** `sparse` 世界裡 d1 的內容範圍 */
export const SPARSE_SCOPE = ['d1/'];

/** 排除規則的候選（目錄、副檔名、名稱前綴、確切名稱；衝突副本的名稱保留目錄、名稱開頭與副檔名，與主檔同一邊） */
export const EXCLUDE_POOL = ['d1/', '/d2/sub/', '*.bin', 'Note*', 'x y.md'];

interface Member {
  identity: Identity;
  membership: VaultMembership;
  sync: NostrRosterSync;
}

export interface World {
  opts: WorldOptions;
  bigCount: number;
  net: Net;
  devices: Device[];
  random: () => number;
  written: Set<string>;
  removed: Set<string>;
  log: string[];
  counter: number;
  members: Map<string, Member>;
  relay: FakeRelay;
  /** 配對時名單同步暫停中的裝置（之後才收到新裝置的名單） */
  rosterPaused: string[];
  /** 每台裝置目前的排除規則（`excludes`） */
  excl: Map<string, string[]>;
  /** `setExcludes` 次數 */
  exclChanges: number;
  /** 每台裝置建立協調器用的選項（重啟時重用；改排除規則時一起改，像應用每次都用目前的設定） */
  devOpts: Map<string, { options: Partial<VaultSyncOptions> }>;
  /** 跑到一半時的時間（版本歷史的性質測試回到這個時間點；SDK ADR 0063） */
  midAt?: number;
}

function pick<T>(random: () => number, xs: readonly T[]): T {
  return xs[Math.floor(random() * xs.length)]!;
}

function randomExcludes(random: () => number): string[] {
  return EXCLUDE_POOL.filter(() => random() < 0.3);
}

/** 這台裝置送出佇列裡的刪除版本（不含合併版本）：版本 id → 檔案與路徑 */
async function queuedDeletes(device: Device): Promise<Map<string, { fileId: string; path: string }>> {
  await device.sync.idle();
  const out = new Map<string, { fileId: string; path: string }>();
  for (const key of await device.store.keys('q:')) {
    const entry = decodeJson<{ fileId: string; nodeId: string }>(await device.store.get(key));
    if (!entry) continue;
    const rec = decodeJson<{ nodes: Record<string, VaultVersion> }>(await device.store.get(`f:${entry.fileId}`));
    const node = rec?.nodes[entry.nodeId];
    if (node?.deleted && node.parents.length <= 1) out.set(node.id, { fileId: entry.fileId, path: node.path });
  }
  return out;
}

function deviceTokens(device: Device): Set<string> {
  const out = new Set<string>();
  for (const f of device.vault.files.values()) for (const t of tokensOf(f.bytes)) out.add(t);
  return out;
}

/**
 * 隨機改一台裝置的排除規則。改之前先離線（中途不送出任何東西）並掃描一次（把沒通知的本機變更先收進來），
 * 然後檢查 `setExcludes` 本身：本機的 token 一個都沒少（除了使用者在別台刪掉的）；排進的每一個刪除版本都是
 * - 使用者在排除期間自己刪掉的檔案（呼叫前磁碟上就沒有），或
 * - G10 同內容收斂（磁碟上那一份由另一個檔案接手）。
 * 絕不是「因為排除而刪掉一個還在的檔案」。
 */
async function changeExcludes(world: World, device: Device): Promise<void> {
  const patterns = randomExcludes(world.random);
  world.log.push(`${device.name} excludes [${patterns.join(', ')}]`);
  const wasOnline = device.transport.online;
  device.transport.setOnline(false);
  world.net.mesh?.drop(device.name);
  const hook = device.vault.beforeGuardedOp;
  device.vault.beforeGuardedOp = undefined;
  await device.sync.scan();
  const filesBefore = new Set(device.vault.files.keys());
  const tokensBefore = deviceTokens(device);
  const deletesBefore = await queuedDeletes(device);
  await device.sync.setExcludes(compilePathFilter(patterns));
  world.excl.set(device.name, patterns);
  world.exclChanges += 1;
  const opts = world.devOpts.get(device.name);
  if (opts) opts.options.excludes = compilePathFilter(patterns);
  const tokensAfter = deviceTokens(device);
  const lost = [...tokensBefore].filter((t) => !tokensAfter.has(t) && !world.removed.has(t));
  if (lost.length > 0) throw new Error(`setExcludes 讓 ${device.name} 少了內容 ${lost.join(', ')}\n${world.log.join('\n')}`);
  const index = new Map(device.sync.index().map((e) => [e.path, e]));
  for (const [id, { fileId, path }] of await queuedDeletes(device)) {
    if (deletesBefore.has(id)) continue;
    const owner = index.get(path);
    const handedOver = owner !== undefined && owner.fileId !== fileId && device.vault.files.has(path);
    // 呼叫前就不在磁碟上：使用者在排除期間刪的（與別台的修改合併後可能又寫回來——一刪一改保留修改）
    const userDeleted = !filesBefore.has(path);
    if (!handedOver && !userDeleted) {
      const detail = `owner=${JSON.stringify(owner)} fileId=${fileId} before=${filesBefore.has(path)} now=${device.vault.files.has(path)}`;
      throw new Error(`setExcludes 讓 ${device.name} 刪除了 ${path}（${detail}）\n${world.log.join('\n')}`);
    }
  }
  device.vault.beforeGuardedOp = hook;
  if (wasOnline) device.transport.setOnline(true);
}

/** 某台裝置是否排除這個路徑 */
export function excludedOn(world: World, device: string, path: string): boolean {
  return compilePathFilter(world.excl.get(device) ?? []).isExcluded(path);
}

/**
 * 「共同範圍」的檔案樹：每一台都沒排除、也不是任何一台因排除而留著的副本（`detached()`）、也沒有任何一台還在等內容的路徑。
 * 各裝置的這一部分必須一致。
 */
export function sharedView(world: World): Record<string, string>[] {
  const skip = new Set<string>();
  const detachedIds = new Set<string>();
  for (const d of world.devices) {
    for (const x of d.sync.detached()) {
      skip.add(x.path.toLowerCase());
      detachedIds.add(x.fileId);
    }
    for (const p of d.sync.status().pending) skip.add(p.path.toLowerCase());
  }
  // 某台停止追蹤的檔案（例如被那台搬進自己排除的範圍，SDK ADR 0071）：其他裝置照常保留在它們的路徑上，那些路徑也不比
  for (const d of world.devices) for (const e of d.sync.remoteIndex()) if (detachedIds.has(e.fileId)) skip.add(e.path.toLowerCase());
  return world.devices.map((d) =>
    Object.fromEntries(
      Object.entries(d.vault.tree()).filter(([path]) => !skip.has(path.toLowerCase()) && !world.devices.some((o) => excludedOn(world, o.name, path))),
    ),
  );
}

/** 收尾：每一台都移除排除規則（重新納入全部），跑到靜止 */
export async function releaseExcludes(world: World): Promise<void> {
  for (const device of world.devices) {
    world.log.push(`${device.name} excludes []`);
    await device.sync.setExcludes(null);
    world.excl.set(device.name, []);
    const opts = world.devOpts.get(device.name);
    if (opts) delete opts.options.excludes;
  }
  await settleAll(world);
}

export async function settleAll(world: World): Promise<void> {
  const { net } = world;
  await net.settle();
  for (const device of world.devices) await device.sync.scan();
  await net.settle();
  for (const device of world.devices) await device.sync.tick();
  await net.settle();
  // P2P 的重試靠觸發（對方上線、背景維護）：讓退避過去，再維護幾輪
  const busy = () => world.devices.some((d) => d.sync.status().pending.length > 0 || (d.sync.status().pushes ?? 0) > 0 || d.sync.status().queue > 0);
  for (let round = 0; round < 6 && busy(); round += 1) {
    await net.clock.advance(31 * 60_000);
    for (const device of world.devices) await device.sync.tick();
    await net.settle();
  }
}

function token(world: World, device: Device): string {
  world.counter += 1;
  const t = `tok-${device.name}-${world.counter}`;
  world.written.add(t);
  return t;
}

/** 使用者對一個文字檔做一次隨機編輯（附加、插入或刪一行），回傳新內容 */
function editText(world: World, device: Device, current: string): string {
  const lines = current.split('\n');
  const r = world.random();
  if (r < 0.2 && lines.length > 1) {
    const i = Math.floor(world.random() * lines.length);
    for (const t of lines[i]!.match(TOKEN) ?? []) world.removed.add(t);
    lines.splice(i, 1);
  } else if (r < 0.6) {
    lines.splice(Math.floor(world.random() * (lines.length + 1)), 0, token(world, device));
  } else {
    lines.push(token(world, device));
  }
  return lines.join('\n');
}

async function notifyMaybe(world: World, device: Device, path: string, kind: 'create' | 'modify' | 'delete' | 'rename', oldPath?: string) {
  // 八成立刻通知；兩成不通知，靠之後的全量掃描找出來
  if (world.random() < 0.8) {
    try {
      await device.sync.notifyLocalChange(path, kind, oldPath);
    } catch (error) {
      // 輕量成員：在內容不在這台的檔案路徑上新增 → 被擋下（SDK ADR 0058），這個檔案不同步
      if (!world.opts.sparse || !isVaultScopeError(error)) throw error;
      world.log.push(`${device.name} blocked ${path} (${error.code})`);
    }
  }
}

async function randomOp(world: World): Promise<void> {
  const { random } = world;
  const device = pick(random, world.devices);
  const vault = device.vault;
  const files = [...vault.files.keys()];
  const textFiles = files.filter((p) => p.endsWith('.md'));
  const r = random();
  if (r < 0.3 && textFiles.length > 0) {
    const path = pick(random, textFiles);
    const next = editText(world, device, vault.get(path)!);
    world.log.push(`${device.name} edit ${path}`);
    vault.userWrite(path, next);
    await notifyMaybe(world, device, path, 'modify');
  } else if (r < 0.42) {
    const path = `${pick(random, DIRS)}${pick(random, NAMES)}.md`;
    if (vault.files.has(path)) return;
    world.log.push(`${device.name} create ${path}`);
    vault.userWrite(path, token(world, device));
    await notifyMaybe(world, device, path, 'create');
  } else if (r < 0.47) {
    const path = `${pick(random, DIRS)}${pick(random, NAMES)}.bin`;
    const old = vault.files.get(path);
    if (old) for (const t of tokensOf(old.bytes)) world.removed.add(t);
    world.log.push(`${device.name} binary ${path}`);
    vault.userWrite(path, new Uint8Array([0xff, ...text(token(world, device))]));
    await notifyMaybe(world, device, path, old ? 'modify' : 'create');
  } else if (r < 0.55 && files.length > 0) {
    const from = pick(random, files);
    const ext = from.slice(from.lastIndexOf('.'));
    const to = `${pick(random, DIRS)}${pick(random, NAMES)}${ext}`;
    if (vault.files.has(to) || [...vault.files.keys()].some((p) => p.toLowerCase() === to.toLowerCase())) return;
    world.log.push(`${device.name} rename ${from} -> ${to}`);
    vault.userRename(from, to);
    await notifyMaybe(world, device, to, 'rename', from);
  } else if (world.opts.bigFiles && world.bigCount < 2 && r < 0.555) {
    // 大檔（超過檔案塊層，只走 P2P）：開頭是 token，後面補零
    world.bigCount += 1;
    const path = `media/big-${world.bigCount}.bin`;
    const t = token(world, device);
    const bytes = new Uint8Array(FILE_TIER_MAX_BYTES + 1 + Math.floor(random() * 1000));
    bytes[0] = 0xff;
    bytes.set(text(t), 1);
    const old = vault.files.get(path);
    if (old) for (const x of tokensOf(old.bytes)) world.removed.add(x);
    world.log.push(`${device.name} big ${path}`);
    vault.userWrite(path, bytes);
    await notifyMaybe(world, device, path, old ? 'modify' : 'create');
  } else if (r < 0.61 && files.length > 0) {
    const path = pick(random, files);
    for (const t of tokensOf(vault.files.get(path)!.bytes)) world.removed.add(t);
    world.log.push(`${device.name} delete ${path}`);
    vault.userRemove(path);
    await notifyMaybe(world, device, path, 'delete');
  } else if (r < 0.71) {
    world.log.push(`${device.name} ${device.transport.online ? 'offline' : 'online'}`);
    device.transport.setOnline(!device.transport.online);
    if (!device.transport.online) world.net.mesh?.drop(device.name); // 離線：P2P 通道也斷了
  } else if (r < 0.75) {
    world.log.push(`${device.name} restart`);
    await device.restart();
  } else if (r < 0.79) {
    world.log.push(`${device.name} scan`);
    await device.sync.scan();
  } else if (world.opts.excludes && r < 0.84) {
    await changeExcludes(world, device);
  } else {
    await world.net.clock.advance(Math.floor(random() * 300));
  }
}

/** 起始的幾台裝置：d0 建立 Vault，其他台（之前配對過的）直接拿到同一份名單 */
function setupMembers(world: World, count: number): void {
  const first = Identity.generate();
  const root = VaultMembership.create({ signer: first, deviceId: 'd0', label: 'D0' });
  const identities = [first];
  for (let i = 1; i < count; i += 1) {
    const id = Identity.generate();
    identities.push(id);
    root.addDevice({ pubkey: id.pubkey, deviceId: `d${i}`, label: `D${i}`, claim: claimDevice(id, { deviceId: `d${i}`, label: `D${i}` }) });
  }
  identities.forEach((identity, i) => {
    const membership = i === 0 ? root : VaultMembership.fromRoster(identity, root.roster());
    addMember(world, `d${i}`, identity, membership);
  });
  world.net.hub.trust = (receiver, sender) => {
    const r = world.members.get(receiver);
    const s = world.members.get(sender);
    return !!r && !!s && r.membership.isMember(s.identity.pubkey);
  };
}

function addMember(world: World, name: string, identity: Identity, membership: VaultMembership): void {
  const sync = new NostrRosterSync({ pool: world.relay.pool(name), signer: identity, membership });
  world.members.set(name, { identity, membership, sync });
  // 名單加入新裝置 → 送一次摘要（新裝置在名單更新前送來、被擋掉的摘要由此補上）
  membership.onChange((change) => {
    if (change.added.length > 0) world.devices.find((d) => d.name === name)?.sync.resync();
  });
  sync.start({ announce: false });
}

/** 暫停的名單同步重新連上：中繼保存的名單事件（kind 1060）這時才送到 */
function resumeRoster(world: World): void {
  for (const name of world.rosterPaused.splice(0)) {
    world.log.push(`${name} roster resume`);
    world.members.get(name)!.sync.start({ announce: false });
  }
}

/**
 * 新裝置掃 d0 的 QR（invite），兩邊確認 SAS。其他裝置的名單同步這時是斷的（之後才收到），
 * 所以新裝置一開始送的訊息會被它們的信任名單擋掉，要靠名單更新後的 `resync()` 補上。
 */
async function pairLate(world: World): Promise<void> {
  const d0 = world.members.get('d0')!;
  for (const [name, m] of world.members) {
    if (name === 'd0') continue;
    m.sync.stop();
    world.rosterPaused.push(name);
  }
  const late = Identity.generate();
  const clock = world.net.clock;
  const offer = createPairingOffer({ role: 'invite', signer: d0.identity, pool: world.relay.pool('d0-pair'), membership: d0.membership, relays: ['wss://relay.example'], clock });
  const scan = acceptPairingUri(offer.uri!, { signer: late, pool: world.relay.pool('late-pair'), clock, device: { deviceId: 'late', label: 'LATE' } });
  await settleRelay();
  if (!offer.sas || offer.sas !== scan.sas) throw new Error('配對：SAS 不一致');
  scan.confirm();
  offer.confirm();
  await settleRelay();
  const joined = await scan.result;
  await offer.result;
  addMember(world, 'late', late, joined.membership);
  await settleRelay();
  if (!d0.membership.isMember(late.pubkey) || !joined.membership.active) throw new Error('配對：名單沒有新裝置');
}

export async function runSeed(seed: number, opts: WorldOptions = {}): Promise<{ world: World; conflicts: number; initialMaxWrites: number }> {
  const random = rng(seed);
  const net = new Net({ seed, maxDelayMs: 250, duplicateRate: 0.15, p2p: opts.p2p ?? false, streaming: seed % 2 === 0, ...(opts.echo ? { echoMs: 500 } : {}) });
  const world: World = {
    opts,
    bigCount: 0,
    net,
    devices: [],
    random,
    written: new Set(),
    removed: new Set(),
    log: [],
    counter: 0,
    members: new Map(),
    relay: new FakeRelay(),
    rosterPaused: [],
    excl: new Map(),
    exclChanges: 0,
    devOpts: new Map(),
  };
  if (opts.excludes) world.log.push(`seed ${seed}`);
  const count = 2 + (seed % 2); // 2 或 3 台
  if (opts.pairing) setupMembers(world, count);
  const calloutOptions = (i: number): { options?: Partial<VaultSyncOptions> } => {
    const callouts = opts.callouts === true || (opts.callouts === 'mixed' && i !== 1);
    if (!callouts && !opts.mergeRules) return {};
    return { options: { ...(callouts ? { conflictCallouts: true } : {}), ...(opts.mergeRules ? { mergeRules: true } : {}) } };
  };
  const deviceOptions = (name: string, i: number) => {
    const base = calloutOptions(i);
    if (opts.sparse) {
      const extra: Partial<VaultSyncOptions> = name === 'd1' ? { scope: { content: SPARSE_SCOPE } } : { peerScopes: { d1: SPARSE_SCOPE } };
      return { options: { ...base.options, ...extra } };
    }
    if (!opts.excludes) return base;
    const patterns = randomExcludes(random);
    world.excl.set(name, patterns);
    world.log.push(`${name} starts with excludes [${patterns.join(', ')}]`);
    const options: { options: Partial<VaultSyncOptions> } = { options: { ...base.options, excludes: compilePathFilter(patterns) } };
    world.devOpts.set(name, options);
    return options;
  };
  let initialMaxWrites = 0;
  if (opts.prepaired) {
    const vaults = Array.from({ length: count }, () => new MemoryVault({ streaming: seed % 2 === 0 }));
    prepopulate(world, vaults);
    world.log.push(`prepaired ${vaults.map((v, i) => `d${i}:[${[...v.files.keys()].join(', ')}]`).join(' ')}`);
    const added = await Promise.all(vaults.map((vault, i) => net.add(`d${i}`, { ...deviceOptions(`d${i}`, i), vault })));
    world.devices.push(...added);
    await settleAll(world);
    for (const device of world.devices) {
      for (const [path, n] of writesPerPath(device.vault.log)) {
        // 衝突副本：最多一次。原路徑：每知道一個更早佔用的檔案就換一次留下的，最多（裝置數 − 1）次
        const bound = path.includes('(衝突-') ? 1 : count - 1;
        initialMaxWrites = Math.max(initialMaxWrites, n - bound + 1);
        if (n > bound) world.log.push(`${device.name} 啟動時寫了 ${path} ${n} 次：${device.vault.log.join(' | ')}`);
      }
    }
  } else {
    for (let i = 0; i < count; i += 1) world.devices.push(await net.add(`d${i}`, deviceOptions(`d${i}`, i)));
  }

  // 讀與寫之間偶爾插進使用者的編輯（驗證前置條件：不無聲覆蓋）
  const raceHook = (device: Device) => {
    device.vault.beforeGuardedOp = (path) => {
      if (!path.endsWith('.md') || random() > 0.05) return;
      const current = device.vault.get(path);
      if (current === undefined) return;
      world.log.push(`${device.name} race-edit ${path}`);
      device.vault.userWrite(path, editText(world, device, current));
      void device.sync.notifyLocalChange(path, 'modify');
    };
  };
  for (const device of world.devices) raceHook(device);

  for (let i = 0; i < OPS; i += 1) {
    if (i === Math.floor(OPS / 2)) world.midAt = net.clock.now();
    if (opts.lateJoin && i === Math.floor(OPS / 2)) {
      // 新裝置加入：空的 Vault，靠摘要＋（有 P2P 時）批次串流補齊
      world.log.push('late join');
      if (opts.pairing) await pairLate(world);
      const late = await net.add('late', deviceOptions('late', 0));
      raceHook(late);
      world.devices.push(late);
    }
    if (opts.pairing && i === Math.floor(OPS / 2) + 25) resumeRoster(world);
    await randomOp(world);
  }
  resumeRoster(world);

  // 收尾：全部上線、全量掃描（找出沒通知的變更）、跑到靜止
  for (const device of world.devices) device.vault.beforeGuardedOp = undefined;
  for (const device of world.devices) device.transport.setOnline(true);
  await settleAll(world);
  const conflicts = world.devices.reduce((n, d) => n + d.sync.status().conflicts.length, 0);
  return { world, conflicts, initialMaxWrites };
}

/** 每個路徑被協調器當成目的地（寫入、改名到、串流寫入）幾次 */
export function writesPerPath(log: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of log) {
    const m = /^(?:write|write-stream) (.+)$/.exec(line) ?? /^rename .+ -> (.+)$/.exec(line);
    if (m) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
  }
  return out;
}

/**
 * 配對前各台就有的檔案（`prepaired`）：每個路徑隨機一種情形——只有某幾台有、內容各不相同、內容相同、一方是空檔、全部是空檔；
 * 文字檔與二進位檔都有。各台的修改時間不同步（像兩個各自用過的 Vault）。
 */
function prepopulate(world: World, vaults: MemoryVault[]): void {
  const { random } = world;
  const paths = new Set<string>();
  while (paths.size < 8) paths.add(`${pick(random, DIRS)}${pick(random, NAMES)}${random() < 0.8 ? '.md' : '.bin'}`);
  // 只差大小寫的兩個路徑在大小寫不分的檔案系統上是同一個：每台只放其中一個
  for (const path of paths) {
    const kind = random();
    const shared = `tok-pre-${world.counter++}`;
    const encode = (s: string) => (path.endsWith('.bin') ? new Uint8Array([0xff, ...text(s)]) : s);
    vaults.forEach((vault, i) => {
      if (random() < 0.15) return; // 這台沒有這個檔案
      if ([...vault.files.keys()].some((p) => p.toLowerCase() === path.toLowerCase())) return;
      let content: string;
      if (kind < 0.35) content = `tok-pre${i}-${world.counter++}`; // 內容各不相同
      else if (kind < 0.55) content = shared; // 相同
      else if (kind < 0.8) content = i === 0 ? '' : `tok-pre${i}-${world.counter++}`; // 一方是空檔
      else content = ''; // 全部是空檔
      for (const t of content.match(TOKEN) ?? []) world.written.add(t);
      if (content === shared) world.written.add(shared);
      vault.userWrite(path, content === '' ? '' : encode(content));
    });
  }
}
