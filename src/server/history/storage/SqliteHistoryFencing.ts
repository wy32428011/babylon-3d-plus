import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import { ArchiveFiles } from './files.ts';
import { decimal, errorCode, need, sha256, text, validateScope } from './primitives.ts';
import type { ArchiveScope, HistoryDurability, HistoryFencingPort, HistoryWriter } from './types.ts';
import { HistoryStorageError } from './types.ts';

const activeFence = new AsyncLocalStorage<{ active: boolean }>();
type FenceRow = { project_id: unknown; domain_id: unknown; owner_id: unknown; token: unknown };
type FileIdentity = { dev: bigint; ino: bigint };
type QueuedFenceOperation = { run(): Promise<void> };

/** 数据库及其目录须位于所有 worker 共用的私有本地文件系统，不支持 NFS/SMB。 */
export type SqliteHistoryFencingOptions = {
  rootDirectory: string;
  scope: ArchiveScope;
  /** 仅首次部署空关联域时显式为 true；缺库恢复不能重新初始化代次。 */
  initialize?: boolean;
  durability?: HistoryDurability;
  acquireTimeoutMs?: number;
  maxPending?: number;
};

async function directory(parent: string, name: string, durability: HistoryDurability): Promise<string> {
  const child = path.join(parent, name);
  try { await mkdir(child, { mode: 0o700 }); await ArchiveFiles.syncDirectory(parent, durability); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  const stat = await lstat(child);
  need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', 'fencing 目录不是受控的普通目录。');
  return child;
}

async function prepareDatabase(options: SqliteHistoryFencingOptions, durability: HistoryDurability): Promise<{
  file: string; finalFile: string; identity: FileIdentity; root: string; rootIdentity: FileIdentity; created: boolean;
}> {
  const root = options.rootDirectory;
  need(typeof root === 'string' && root.length <= 4096 && path.isAbsolute(root), 'PATH', 'fencing 根目录必须是有界绝对路径。');
  const normalized = path.resolve(root), parsed = path.parse(normalized);
  need(process.platform !== 'win32' || !parsed.root.startsWith('\\\\'), 'PATH', 'fencing 不支持网络共享目录。');
  let current = parsed.root;
  for (const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', 'fencing 根目录及祖先不得为符号链接或 junction。');
  }
  const resolved = path.resolve(await realpath(normalized));
  need(process.platform === 'win32' ? resolved.toLowerCase() === normalized.toLowerCase() : resolved === normalized,
    'PATH', 'fencing 根目录解析结果不一致。');
  const rootStat = await lstat(normalized, { bigint: true });
  need(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.ino !== 0n, 'PATH', 'fencing 根目录缺少可验证的物理身份。');
  const project = await directory(normalized, `p-${sha256(options.scope.projectId)}`, durability);
  const domain = await directory(project, `d-${sha256(options.scope.captureDomainId)}`, durability);
  const finalFile = path.join(domain, '.history-fencing.sqlite');
  const initName = /^\.f-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:-journal)?$/u;
  let file = finalFile, created = false;
  try {
    await lstat(finalFile);
    need(options.initialize !== true, 'FENCING_ALREADY_INITIALIZED', 'fencing 数据库已存在，不能重新初始化。');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    need(options.initialize === true, 'FENCING_MISSING', '持久 fencing 数据库缺失，不能自动重置代次。');
    const entries = await readdir(domain, { withFileTypes: true });
    need(entries.length <= 64 && entries.every(entry => entry.isFile() && !entry.isSymbolicLink() && initName.test(entry.name)),
      'FENCING_INITIALIZATION_BLOCKED', '关联域已有归档或未知文件，不能将缺失的 fencing 数据库当作新部署。');
    file = path.join(domain, `.f-${randomUUID()}`);
    const handle = await open(file, 'wx', 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    created = true;
    await ArchiveFiles.syncDirectory(domain, durability);
  }
  let stat = await lstat(file, { bigint: true });
  if (!created && stat.nlink === 2n) {
    const entries = await readdir(domain, { withFileTypes: true });
    need(entries.length <= 64, 'FENCING_DATABASE_INVALID', 'fencing 目录待核对文件过多。');
    const original = { dev: stat.dev, ino: stat.ino }, links: string[] = [];
    for (const entry of entries) if (entry.isFile() && !entry.isSymbolicLink() && initName.test(entry.name) && !entry.name.endsWith('-journal')) {
      const candidate = path.join(domain, entry.name);
      try {
        const other = await lstat(candidate, { bigint: true });
        if (other.dev === original.dev && other.ino === original.ino) links.push(candidate);
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    if (links.length === 1) {
      const deadline = performance.now() + Math.min(options.acquireTimeoutMs ?? 30_000, 1000);
      for (;;) {
        try { await unlink(links[0]); break; }
        catch (error) {
          if (errorCode(error) === 'ENOENT') break;
          if (!['EPERM', 'EBUSY'].includes(errorCode(error) ?? '')) throw error;
          const current = await lstat(file, { bigint: true });
          need(current.dev === original.dev && current.ino === original.ino, 'FENCING_DATABASE_INVALID', 'fencing 数据库在恢复时被替换。');
          if (current.nlink === 1n) break;
          if (performance.now() >= deadline) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, 20));
        }
      }
      await ArchiveFiles.syncDirectory(domain, durability);
    }
    stat = await lstat(file, { bigint: true });
    need(stat.dev === original.dev && stat.ino === original.ino && stat.nlink === 1n,
      'FENCING_DATABASE_INVALID', 'fencing 数据库存在无法确认来源的硬链接或已被替换。');
  }
  need(stat.isFile() && !stat.isSymbolicLink() && stat.ino !== 0n && stat.nlink === 1n
    && (created || stat.size > 0n), 'FENCING_DATABASE_INVALID', 'fencing 数据库缺失、为空或不是唯一的普通文件。');
  return { file, finalFile, identity: { dev: stat.dev, ino: stat.ino }, root: normalized,
    rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, created };
}

function isBusy(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SQLITE_ERROR'
    && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === 5;
}

/**
 * 每个项目/关联域持有独立 SQLite 排他事务，跨 captureEpoch 共用持久代次。
 * SQLite 锁必须覆盖整个异步磁盘回调；只在取得事务前重试，不重跑回调。
 */
export class SqliteHistoryFencing implements HistoryFencingPort {
  readonly #database: DatabaseSync;
  readonly #file: string;
  readonly #identity: FileIdentity;
  readonly #root: string;
  readonly #rootIdentity: FileIdentity;
  readonly #projectId: string;
  readonly #captureDomainId: string;
  readonly #timeout: number;
  readonly #maxPending: number;
  readonly #queue: QueuedFenceOperation[] = [];
  #running = false;
  #pending = 0;
  #closing = false;
  #closed = false;
  #failure: unknown = null;
  #closePromise: Promise<void> | null = null;

  private constructor(database: DatabaseSync, location: { file: string; identity: FileIdentity; root: string; rootIdentity: FileIdentity }, options: SqliteHistoryFencingOptions) {
    this.#database = database; this.#file = location.file; this.#identity = location.identity;
    this.#root = location.root; this.#rootIdentity = location.rootIdentity;
    this.#projectId = options.scope.projectId; this.#captureDomainId = options.scope.captureDomainId;
    this.#timeout = options.acquireTimeoutMs ?? 30_000; this.#maxPending = options.maxPending ?? 4096;
  }

  static async open(options: SqliteHistoryFencingOptions): Promise<SqliteHistoryFencing> {
    need(activeFence.getStore()?.active !== true, 'FENCING_REENTRANT', 'fencing 回调不能嵌套打开其他 fencing。');
    const owned = structuredClone(options);
    const durability = owned.durability ?? 'file-and-directory-fsync';
    const timeout = owned.acquireTimeoutMs ?? 30_000, maximum = owned.maxPending ?? 4096;
    validateScope(owned.scope, { ownerId: 'fencing-initialization', fencingToken: '1' });
    need(['file-and-directory-fsync', 'file-fsync'].includes(durability)
      && (owned.initialize === undefined || typeof owned.initialize === 'boolean')
      && Number.isSafeInteger(timeout) && timeout >= 100 && timeout <= 600_000
      && Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 100_000,
    'FENCING_CONFIG', 'fencing 持久性或并发预算无效。');
    let Database: typeof import('node:sqlite').DatabaseSync;
    try { ({ DatabaseSync: Database } = await import('node:sqlite')); }
    catch { throw new HistoryStorageError('FENCING_UNAVAILABLE', '当前 Node 未提供内置 SQLite，不能启动持久 fencing。'); }
    const location = await prepareDatabase(owned, durability);
    const database = new Database(location.file);
    const fence = new SqliteHistoryFencing(database, location, owned);
    let databaseClosed = false;
    try {
      database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF;');
      await fence.#enqueue(() => fence.#transaction(async () => {
        const mode = database.prepare('PRAGMA journal_mode').get()?.journal_mode;
        need(mode === 'delete', 'FENCING_CONFIG', 'fencing 数据库必须使用 SQLite 回滚日志模式。');
        if (location.created) {
          database.exec('CREATE TABLE history_fencing (id INTEGER PRIMARY KEY CHECK (id = 1), project_id TEXT NOT NULL, domain_id TEXT NOT NULL, owner_id TEXT, token TEXT NOT NULL)');
          database.prepare('INSERT INTO history_fencing (id, project_id, domain_id, owner_id, token) VALUES (1, ?, ?, NULL, ?)')
            .run(owned.scope.projectId, owned.scope.captureDomainId, '0');
        }
        fence.#read();
      }));
      if (!location.created) return fence;
      await fence.close(); databaseClosed = true;
      try { await link(location.file, location.finalFile); }
      catch (error) {
        if (errorCode(error) === 'EEXIST') throw new HistoryStorageError('FENCING_ALREADY_INITIALIZED', '另一进程已完成 fencing 初始化。');
        throw error;
      }
      await ArchiveFiles.syncDirectory(path.dirname(location.finalFile), durability);
      try { await unlink(location.file); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      await ArchiveFiles.syncDirectory(path.dirname(location.finalFile), durability);
      return await SqliteHistoryFencing.open({ ...owned, initialize: false });
    } catch (error) {
      if (!databaseClosed) { try { database.close(); } catch { /* 保留初始化失败的原始原因。 */ } }
      if (location.created && databaseClosed) {
        try { await unlink(location.file); } catch { /* 只清理本次未发布的临时名称。 */ }
      }
      throw error;
    }
  }

  #checkReentrant(): void {
    need(activeFence.getStore()?.active !== true, 'FENCING_REENTRANT', 'fencing 回调不能嵌套进入其他 fencing。');
  }
  #enqueue<T>(operation: () => Promise<T>, closing = false): Promise<T> {
    this.#checkReentrant();
    need(!this.#closed && (closing || !this.#closing), 'FENCING_CLOSED', 'fencing 正在关闭或已经关闭。');
    need(closing || this.#failure === null, 'FENCING_RECOVERY_REQUIRED', 'fencing 数据库发生不确定错误，必须重新打开并核对代次。');
    need(closing || this.#pending < this.#maxPending, 'FENCING_BACKPRESSURE', 'fencing 待处理操作超过预算。');
    this.#pending += 1;
    return new Promise<T>((resolve, reject) => {
      let waiting = true;
      const entry: QueuedFenceOperation = { run: async () => {
        if (!waiting) return;
        waiting = false; clearTimeout(timer);
        try {
          need(closing || this.#failure === null, 'FENCING_RECOVERY_REQUIRED', 'fencing 已冻结，排队操作不能继续。');
          resolve(await operation());
        } catch (error) { reject(error); }
        finally { this.#pending -= 1; }
      } };
      const timer = setTimeout(() => {
        if (!waiting) return;
        waiting = false;
        const at = this.#queue.indexOf(entry);
        if (at >= 0) this.#queue.splice(at, 1);
        this.#pending -= 1;
        reject(new HistoryStorageError('FENCING_BUSY', '等待本地 fencing 队列超时，回调不会迟到执行。'));
      }, this.#timeout);
      this.#queue.push(entry); this.#pump();
    });
  }
  #pump(): void {
    if (this.#running) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    this.#running = true;
    void entry.run().finally(() => { this.#running = false; this.#pump(); });
  }
  async #checkFile(): Promise<void> {
    try {
      const [root, stat] = await Promise.all([lstat(this.#root, { bigint: true }), lstat(this.#file, { bigint: true })]);
      need(root.isDirectory() && !root.isSymbolicLink() && root.dev === this.#rootIdentity.dev && root.ino === this.#rootIdentity.ino
        && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
        && stat.dev === this.#identity.dev && stat.ino === this.#identity.ino,
      'FENCING_DATABASE_REPLACED', 'fencing 根目录或数据库身份已改变，必须停止并核对所有权。');
    } catch (error) {
      const failure = error instanceof HistoryStorageError ? error
        : new HistoryStorageError('FENCING_DATABASE_REPLACED', 'fencing 根目录或数据库无法验证，必须停止并核对所有权。');
      this.#failure = failure;
      throw failure;
    }
  }

  async assertArchiveRoot(rootDirectory: string, scope: Readonly<ArchiveScope>): Promise<void> {
    this.#checkReentrant();
    const checkedScope = structuredClone(scope);
    validateScope(checkedScope, { ownerId: 'fencing-root-check', fencingToken: '1' });
    need(checkedScope.projectId === this.#projectId && checkedScope.captureDomainId === this.#captureDomainId
      && typeof rootDirectory === 'string' && path.isAbsolute(rootDirectory), 'FENCING_ROOT_MISMATCH', '归档与 fencing 的项目或关联域不一致。');
    await this.#enqueue(async () => {
      await this.#checkFile();
      const root = await lstat(path.resolve(rootDirectory), { bigint: true });
      need(root.isDirectory() && !root.isSymbolicLink() && root.dev === this.#rootIdentity.dev && root.ino === this.#rootIdentity.ino,
        'FENCING_ROOT_MISMATCH', '归档必须使用与 fencing 相同的物理根目录。');
    });
  }
  async #transaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.#checkFile();
    const deadline = performance.now() + this.#timeout;
    let delay = 5;
    for (;;) {
      try { this.#database.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (!isBusy(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new HistoryStorageError('FENCING_BUSY', '无法在期限内取得持久 fencing 排他锁。');
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(delay, remaining)));
        delay = Math.min(delay * 2, 100);
      }
    }
    const context = { active: true };
    try {
      await this.#checkFile();
      const result = await activeFence.run(context, operation);
      await this.#checkFile();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); }
      catch (rollbackError) {
        this.#failure = rollbackError;
        throw new HistoryStorageError('FENCING_RECOVERY_REQUIRED', 'fencing 事务结果不确定，必须重新打开并核对代次。');
      }
      throw error;
    } finally { context.active = false; }
  }
  #read(): HistoryWriter | null {
    const row = this.#database.prepare('SELECT project_id, domain_id, owner_id, token FROM history_fencing WHERE id = 1').get() as FenceRow | undefined;
    need(row && row.project_id === this.#projectId && row.domain_id === this.#captureDomainId, 'FENCING_IDENTITY', 'fencing 数据库与项目或关联域不匹配。');
    decimal(row.token, 'fencingToken');
    if (row.owner_id === null) { need(row.token === '0', 'FENCING_IDENTITY', '未分配的 fencing 代次无效。'); return null; }
    text(row.owner_id, 'ownerId');
    need(row.token !== '0', 'FENCING_IDENTITY', '已分配的 fencing 代次必须大于零。');
    return { ownerId: row.owner_id, fencingToken: row.token };
  }

  /** 仅读取已提交所有权；不能把读取结果当作外部操作的授权。 */
  current(): Promise<HistoryWriter | null> {
    return this.#enqueue(() => this.#transaction(async () => this.#read()));
  }

  /** 持久换代必须显式匹配原所有者；unknown 结果须重新读取对账，不自动重试。 */
  claim(ownerId: string, expected: HistoryWriter | null): Promise<HistoryWriter> {
    text(ownerId, 'ownerId');
    const previous = expected === null ? null : structuredClone(expected);
    if (previous) { text(previous.ownerId, 'ownerId'); decimal(previous.fencingToken, 'fencingToken'); }
    return this.#enqueue(() => this.#transaction(async () => {
      const current = this.#read();
      need(current === null ? previous === null : previous !== null && current.ownerId === previous.ownerId
        && current.fencingToken === previous.fencingToken, 'FENCED', '持久所有者已改变，不能依据旧代次换代。');
      const writer = { ownerId, fencingToken: nextDecimal(current?.fencingToken ?? '0') };
      const result = this.#database.prepare('UPDATE history_fencing SET owner_id = ?, token = ? WHERE id = 1').run(writer.ownerId, writer.fencingToken);
      need(Number(result.changes) === 1, 'FENCING_IDENTITY', '持久所有者记录无法更新。');
      return writer;
    }));
  }

  runExclusive<T>(scope: Readonly<ArchiveScope>, writer: Readonly<HistoryWriter>, operation: () => Promise<T>): Promise<T> {
    const checkedScope = structuredClone(scope), checkedWriter = structuredClone(writer);
    validateScope(checkedScope, checkedWriter);
    need(checkedScope.projectId === this.#projectId && checkedScope.captureDomainId === this.#captureDomainId
      && typeof operation === 'function', 'FENCED', '写入不属于当前持久 fencing 关联域。');
    return this.#enqueue(() => this.#transaction(async () => {
      const current = this.#read();
      need(current && current.ownerId === checkedWriter.ownerId && current.fencingToken === checkedWriter.fencingToken,
        'FENCED', '写入者已被持久换代。');
      return operation();
    }));
  }

  close(): Promise<void> {
    this.#checkReentrant();
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    try {
      this.#closePromise = this.#enqueue(async () => { this.#database.close(); this.#closed = true; }, true).catch(error => {
        this.#closing = false; this.#closePromise = null; throw error;
      });
      return this.#closePromise;
    } catch (error) { this.#closing = false; throw error; }
  }
}
