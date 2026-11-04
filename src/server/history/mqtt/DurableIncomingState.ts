import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { InputCursor } from '../../../runtime/history/state/types.ts';
import type { CapturedReceipt, HistoryDurability, HistoryFencingPort, HistoryWriter, ArchiveScope } from '../storage/index.ts';
import { MqttCollectorError, type MqttCollectorLimits } from './types.ts';

export type IncomingStage = {
  kind: 'stage'; epoch: string; connection: string; id: number; qos: 1 | 2; fingerprint: string;
  transactionId: string; after: InputCursor; receivedAt: number; topic: string;
  payloadBase64: string; retain: boolean; duplicate: boolean; receipt: CapturedReceipt | null;
};
export type IncomingComplete = {
  kind: 'complete'; epoch: string; connection: string; id: number; qos: 1 | 2; fingerprint: string;
};
export type IncomingEntry = IncomingStage | IncomingComplete;
export type SessionState = {
  format: 'mqtt-session/1'; identity: string; epoch: string; hadSession: boolean; subscribed: boolean; online: boolean;
};
type Owner = { format: 'mqtt-owner/1'; id: string; scope: ArchiveScope; writer: HistoryWriter };
type Envelope<T> = { value: T; sha256: string };
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const idPattern = /^[0-9]{5}\.json$/u;
const tempPattern = /^tmp-[a-f0-9-]{36}\.json$/u;
function requireState(value: unknown, message: string): asserts value {
  if (!value) throw new MqttCollectorError('STATE_FAILURE', message);
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function encode(value: unknown): Buffer {
  const body = JSON.stringify(value);
  return Buffer.from(JSON.stringify({ value, sha256: hash(body) }), 'utf8');
}
function decode<T>(bytes: Buffer): T {
  let envelope: Envelope<T>;
  try { envelope = JSON.parse(bytes.toString('utf8')) as Envelope<T>; }
  catch { throw new MqttCollectorError('STATE_FAILURE', 'MQTT 接收状态无法解析。'); }
  requireState(envelope && typeof envelope === 'object' && typeof envelope.sha256 === 'string'
    && hash(JSON.stringify(envelope.value)) === envelope.sha256, 'MQTT 接收状态校验失败。');
  return envelope.value;
}
async function syncDirectory(dir: string, durability: HistoryDurability): Promise<void> {
  if (durability === 'file-fsync') return;
  const handle = await open(dir, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readRegular(file: string, maximum: number): Promise<Buffer> {
  const before = await lstat(file);
  requireState(before.isFile() && !before.isSymbolicLink() && before.size <= maximum, 'MQTT 状态文件类型或大小无效。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    requireState(after.isFile() && before.dev === after.dev && before.ino === after.ino && after.size <= maximum,
      'MQTT 状态文件在打开期间改变。');
    const bytes = await handle.readFile();
    requireState(bytes.length === after.size, 'MQTT 状态文件读取不完整。'); return bytes;
  } finally { await handle.close(); }
}
async function validateRoot(root: string): Promise<string> {
  requireState(typeof root === 'string' && root.length <= 4096 && path.isAbsolute(root), 'MQTT 状态根目录必须为服务端配置的绝对路径。');
  const resolved = path.resolve(root), parsed = path.parse(resolved); let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await lstat(current);
    requireState(stat.isDirectory() && !stat.isSymbolicLink(), 'MQTT 状态路径不得包含符号链接或 junction。');
  }
  const real = path.resolve(await realpath(resolved));
  requireState(process.platform === 'win32' ? real.toLowerCase() === resolved.toLowerCase() : real === resolved, 'MQTT 状态根目录解析不一致。');
  return resolved;
}
function validCursor(cursor: InputCursor, scope: ArchiveScope): boolean {
  return !!cursor && cursor.captureDomainId === scope.captureDomainId && cursor.captureEpoch === scope.captureEpoch
    && typeof cursor.offset === 'string' && /^(0|[1-9][0-9]{0,39})$/u.test(cursor.offset);
}
function validateEntry(entry: IncomingEntry, id: number, scope: ArchiveScope, limits: MqttCollectorLimits): void {
  requireState(entry && (entry.kind === 'stage' || entry.kind === 'complete') && entry.id === id
    && (entry.qos === 1 || entry.qos === 2) && uuidPattern.test(entry.epoch) && uuidPattern.test(entry.connection)
    && /^[a-f0-9]{64}$/u.test(entry.fingerprint), 'MQTT 接收记录头损坏。');
  if (entry.kind === 'stage') {
    requireState(uuidPattern.test(entry.transactionId) && validCursor(entry.after, scope)
      && Number.isSafeInteger(entry.receivedAt) && entry.receivedAt >= 0
      && typeof entry.topic === 'string' && Buffer.byteLength(entry.topic) <= 4096 && entry.topic.length > 0
      && typeof entry.payloadBase64 === 'string' && entry.payloadBase64.length <= Math.ceil(limits.maxPacketBytes / 3) * 4
      && typeof entry.retain === 'boolean' && typeof entry.duplicate === 'boolean', 'MQTT 暂存记录损坏。');
    const payload = Buffer.from(entry.payloadBase64, 'base64');
    requireState(payload.toString('base64') === entry.payloadBase64 && payload.length <= limits.maxPacketBytes
      && hash(JSON.stringify([entry.topic, entry.qos, entry.retain, entry.payloadBase64])) === entry.fingerprint,
      'MQTT 暂存载荷或指纹损坏。');
    if (entry.receipt !== null) requireState(entry.receipt.kind === 'captured' && validCursor(entry.receipt.inputCursor, scope)
      && entry.receipt.receivedAt === entry.receivedAt, 'MQTT 捕获回执损坏。');
  }
}

/** 独立、受 fencing 保护的接收状态。每个 messageId 的临时文件先 fsync，再原子换名。 */
export class DurableIncomingState {
  readonly #dir: string;
  readonly #scope: ArchiveScope;
  readonly #writer: HistoryWriter;
  readonly #fencing: HistoryFencingPort;
  readonly #durability: HistoryDurability;
  readonly #limits: MqttCollectorLimits;
  readonly #ownerDigest: string;
  readonly #entries = new Map<number, IncomingEntry>();
  readonly #sizes = new Map<string, number>();
  #session!: SessionState;
  #closed = false;
  #failed = false;
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(dir: string, scope: ArchiveScope, writer: HistoryWriter, fencing: HistoryFencingPort,
    durability: HistoryDurability, limits: MqttCollectorLimits, owner: Owner) {
    this.#dir = dir; this.#scope = structuredClone(scope); this.#writer = structuredClone(writer);
    this.#fencing = fencing; this.#durability = durability; this.#limits = limits;
    this.#ownerDigest = hash(encode(owner));
  }
  static async open(options: { root: string; scope: ArchiveScope; writer: HistoryWriter; fencing: HistoryFencingPort;
    durability: HistoryDurability; limits: MqttCollectorLimits; identity: string; directoryKey: string; reclaim?: HistoryWriter }): Promise<DurableIncomingState> {
    let runs = 0;
    return options.fencing.runExclusive(options.scope, options.writer, async () => {
      requireState(++runs === 1, 'MQTT fencing 端口不得重放写操作。');
      const root = await validateRoot(options.root), dir = path.join(root, `mqtt-${hash(options.directoryKey)}`);
      try { await mkdir(dir, { mode: 0o700 }); await syncDirectory(root, options.durability); }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      const stat = await lstat(dir);
      requireState(stat.isDirectory() && !stat.isSymbolicLink(), 'MQTT 状态子目录无效。');
      const ownerPath = path.join(dir, 'owner.json');
      try {
        const previousBytes = await readRegular(ownerPath, 8192), previous = decode<Owner>(previousBytes);
        requireState(options.reclaim && previous.format === 'mqtt-owner/1'
          && previous.scope.projectId === options.scope.projectId && previous.scope.captureDomainId === options.scope.captureDomainId
          && previous.writer.ownerId === options.reclaim.ownerId && previous.writer.fencingToken === options.reclaim.fencingToken
          && /^(0|[1-9][0-9]*)$/u.test(options.writer.fencingToken) && /^(0|[1-9][0-9]*)$/u.test(options.reclaim.fencingToken)
          && BigInt(options.writer.fencingToken) > BigInt(options.reclaim.fencingToken), 'MQTT 接收状态由其他写入者持有，禁止自动抢锁。');
        requireState(hash(await readRegular(ownerPath, 8192)) === hash(previousBytes), 'MQTT 所有权在换代时改变。');
        await unlink(ownerPath); await syncDirectory(dir, options.durability);
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      const owner: Owner = { format: 'mqtt-owner/1', id: randomUUID(), scope: structuredClone(options.scope), writer: structuredClone(options.writer) };
      const handle = await open(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(encode(owner)); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(dir, options.durability);
      const instance = new DurableIncomingState(dir, options.scope, options.writer, options.fencing, options.durability, options.limits, owner);
      try { await instance.#load(options.identity); return instance; }
      catch (error) {
        // 只释放刚刚取得且内容未变的锁；不删除未知状态文件。
        if (hash(await readRegular(ownerPath, 8192)) === instance.#ownerDigest) { await unlink(ownerPath); await syncDirectory(dir, options.durability); }
        throw error;
      }
    });
  }
  async #load(identity: string): Promise<void> {
    const files = await readdir(this.#dir, { withFileTypes: true });
    requireState(files.length <= this.#limits.maxStateEntries + this.#limits.maxOrphanFiles + 2, 'MQTT 状态文件数超限。');
    let orphans = 0, total = 0;
    for (const file of files) {
      requireState(file.isFile() && !file.isSymbolicLink(), 'MQTT 状态目录包含非普通文件。');
      const name = file.name;
      requireState(name === 'owner.json' || name === 'session.json' || idPattern.test(name) || tempPattern.test(name), 'MQTT 状态目录包含非本采集器文件。');
      if (tempPattern.test(name)) orphans += 1;
      const bytes = await readRegular(path.join(this.#dir, name), this.#limits.maxPacketBytes * 2 + 32768);
      this.#sizes.set(name, bytes.length); total += bytes.length;
      requireState(total <= this.#limits.maxStateBytes && orphans <= this.#limits.maxOrphanFiles, 'MQTT 状态目录达到预算上限。');
      if (idPattern.test(name)) {
        const id = Number(name.slice(0, 5)); requireState(id >= 1 && id <= 65535, 'MQTT 消息标识文件无效。');
        const entry = decode<IncomingEntry>(bytes); validateEntry(entry, id, this.#scope, this.#limits); this.#entries.set(id, entry);
      } else if (name === 'session.json') {
        const session = decode<SessionState>(bytes);
        requireState(session.format === 'mqtt-session/1' && session.identity === identity && uuidPattern.test(session.epoch)
          && typeof session.hadSession === 'boolean' && typeof session.subscribed === 'boolean' && typeof session.online === 'boolean',
        'MQTT 会话身份或冻结配置不匹配。'); this.#session = session;
      }
    }
    requireState(this.#entries.size <= this.#limits.maxStateEntries, 'MQTT 接收记录条数超过预算。');
    if (!this.#session) {
      requireState(this.#entries.size === 0 && orphans === 0, 'MQTT 状态缺少会话身份，不能当作新会话覆盖。');
      this.#session = { format: 'mqtt-session/1', identity, epoch: randomUUID(), hadSession: false, subscribed: false, online: false };
      await this.#replace('session.json', this.#session);
    }
  }
  get session(): SessionState { return structuredClone(this.#session); }
  entries(): IncomingEntry[] { return [...this.#entries.values()].map(entry => structuredClone(entry)); }
  entry(id: number): IncomingEntry | undefined { const entry = this.#entries.get(id); return entry ? structuredClone(entry) : undefined; }
  saveSession(next: SessionState): Promise<void> {
    return this.#write(async () => { await this.#replace('session.json', next); this.#session = structuredClone(next); });
  }
  saveEntry(entry: IncomingEntry): Promise<void> {
    validateEntry(entry, entry.id, this.#scope, this.#limits);
    return this.#write(async () => {
      requireState(this.#entries.has(entry.id) || this.#entries.size < this.#limits.maxStateEntries, 'MQTT 接收记录达到条数上限。');
      await this.#replace(`${String(entry.id).padStart(5, '0')}.json`, entry); this.#entries.set(entry.id, structuredClone(entry));
    });
  }
  #write<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(async () => {
      requireState(!this.#closed && !this.#failed, 'MQTT 接收状态已关闭或发生持久写入故障，必须重新恢复。');
      try {
        let calls = 0;
        const result = await this.#fencing.runExclusive(this.#scope, this.#writer, async () => {
          requireState(++calls === 1, 'MQTT fencing 端口不得重放写操作。');
          await this.#assertOwner(); return operation();
        });
        requireState(calls === 1, 'MQTT fencing 端口没有执行写操作。'); return result;
      } catch (error) {
        // rename 或目录 fsync 失败可能已经改变磁盘，不能继续使用旧内存状态写入。
        this.#failed = true;
        throw error;
      }
    });
    this.#tail = work.then(() => undefined, () => undefined); return work;
  }
  async #assertOwner(): Promise<void> {
    const stat = await lstat(this.#dir);
    requireState(stat.isDirectory() && !stat.isSymbolicLink() && hash(await readRegular(path.join(this.#dir, 'owner.json'), 8192)) === this.#ownerDigest,
      'MQTT 状态写入者所有权已经失效。');
  }
  async #replace(name: string, value: unknown): Promise<void> {
    const bytes = encode(value), temp = `tmp-${randomUUID()}.json`;
    requireState(bytes.length <= this.#limits.maxPacketBytes * 2 + 32768, 'MQTT 单条状态超过字节预算。');
    const currentBytes = [...this.#sizes.values()].reduce((sum, item) => sum + item, 0);
    const orphanCount = [...this.#sizes.keys()].filter(item => tempPattern.test(item)).length;
    requireState(currentBytes + bytes.length <= this.#limits.maxStateBytes && orphanCount < this.#limits.maxOrphanFiles,
      'MQTT 状态写入达到字节或临时文件预算。');
    const handle = await open(path.join(this.#dir, temp), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.#sizes.set(temp, 0);
    try { await handle.writeFile(bytes); this.#sizes.set(temp, bytes.length); await handle.sync(); }
    finally { await handle.close(); }
    const target = path.join(this.#dir, name);
    if (this.#sizes.has(name)) await readRegular(target, this.#limits.maxPacketBytes * 2 + 32768);
    await rename(path.join(this.#dir, temp), target); await syncDirectory(this.#dir, this.#durability);
    this.#sizes.delete(temp); this.#sizes.set(name, bytes.length);
  }
  async close(): Promise<void> {
    await this.#tail; if (this.#closed) return;
    let calls = 0;
    await this.#fencing.runExclusive(this.#scope, this.#writer, async () => {
      requireState(++calls === 1, 'MQTT fencing 端口不得重放释放操作。'); await this.#assertOwner();
      await unlink(path.join(this.#dir, 'owner.json')); await syncDirectory(this.#dir, this.#durability); this.#closed = true;
    });
    requireState(calls === 1, 'MQTT fencing 端口没有执行释放操作。');
  }
}
