import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MODEL_SCRIPT_CACHE_MAX_BYTES, normalizePrecompiledModelScript, serializePrecompiledModelScript, type PrecompiledModelScript } from '../shared/modelScriptCompilation.ts';

const CACHE_FORMAT = 'babylon-model-script-local-v1';
const MAX_ENTRY_BYTES = MODEL_SCRIPT_CACHE_MAX_BYTES + 2048;
const ENTRY_PATTERN = /^[a-f0-9]{64}\.json$/;
const TEMP_PATTERN = /^[a-f0-9]{64}\.[a-f0-9]{32}\.tmp$/;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export type ModelScriptCacheKey = { sourceSha256: string; compilerVersion: string; compilationVersion: string };
export type ModelScriptCacheKeyProtection = { protect: (key: Buffer) => Buffer; unprotect: (encrypted: Buffer) => Buffer };

/**
 * 仅用于本机应用的可丢弃派生缓存。摘要标识内容，独立 HMAC 密钥证明产物来自本机编译；
 * 调用方仍必须先读取已授权 TS，不能拿 scene/远端 sidecar 的自报摘要代替来源授权。
 */
export class ModelScriptPersistentCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private maintenance: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly metrics = { hits: 0, misses: 0, invalid: 0, writes: 0, failures: 0, evictions: 0 };

  constructor(private readonly root: string, private readonly key: Buffer, options: {
    maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number;
  } = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    if (!path.isAbsolute(root) || key.length !== 32 || !Number.isInteger(this.maxEntries) || this.maxEntries < 0
      || !Number.isFinite(this.maxBytes) || this.maxBytes < 0 || !Number.isFinite(this.ttlMs) || this.ttlMs < 0) {
      throw new RangeError('模型脚本持久缓存路径、密钥或预算无效。');
    }
    this.key = Buffer.from(key);
  }

  getMetrics() { return { ...this.metrics }; }

  async read(identity: ModelScriptCacheKey): Promise<PrecompiledModelScript | undefined> {
    const filename = this.filename(identity);
    let hit = false;
    try {
      const handle = await fs.open(filename, 'r');
      let content: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES || this.now() - stat.mtimeMs > this.ttlMs) {
          this.metrics.invalid++;
          return undefined;
        }
        const buffer = Buffer.allocUnsafe(stat.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) throw new Error('缓存读取期间大小已变化。');
        content = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      // 打开后的内容仍检查字节数，避免并发替换/增长越过读取合同。
      if (Buffer.byteLength(content) > MAX_ENTRY_BYTES) throw new Error('缓存大小无效。');
      const envelope = JSON.parse(content) as Record<string, unknown>;
      if (envelope.format !== CACHE_FORMAT || typeof envelope.artifact !== 'object' || typeof envelope.mac !== 'string'
        || !/^[a-f0-9]{64}$/.test(envelope.mac)) throw new Error('缓存格式无效。');
      const payload = serializePrecompiledModelScript(envelope.artifact as PrecompiledModelScript);
      const expected = this.sign(identity, payload);
      if (!timingSafeEqual(Buffer.from(envelope.mac, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('缓存认证失败。');
      const artifact = normalizePrecompiledModelScript(envelope.artifact);
      if (!artifact || artifact.sourceSha256 !== identity.sourceSha256 || artifact.compilerVersion !== identity.compilerVersion
        || artifact.codeSha256 !== sha256(artifact.code)) throw new Error('缓存内容身份无效。');
      serializePrecompiledModelScript(artifact);
      this.metrics.hits++;
      hit = true;
      const touched = new Date(this.now());
      await fs.utimes(filename, touched, touched).catch(() => undefined);
      return Object.freeze(artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.metrics.invalid++;
      return undefined;
    } finally { if (!hit) this.metrics.misses++; }
  }

  async write(identity: ModelScriptCacheKey, artifact: PrecompiledModelScript): Promise<void> {
    const generation = this.generation;
    const filename = this.filename(identity);
    const temporary = filename.slice(0, -5) + '.' + randomBytes(16).toString('hex') + '.tmp';
    try {
      if (artifact.sourceSha256 !== identity.sourceSha256 || artifact.compilerVersion !== identity.compilerVersion
        || artifact.codeSha256 !== sha256(artifact.code)) throw new Error('缓存内容身份无效。');
      const payload = serializePrecompiledModelScript(artifact);
      const content = JSON.stringify({ format: CACHE_FORMAT, artifact, mac: this.sign(identity, payload) });
      if (Buffer.byteLength(content) > MAX_ENTRY_BYTES || Buffer.byteLength(content) > this.maxBytes || this.maxEntries === 0) return;
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await this.enqueue(async () => {
        if (generation !== this.generation) return;
        // 与本进程 clear 串行提交；跨进程竞争最后一个完整且认证有效的同内容产物即可。
        await fs.rename(temporary, filename);
        const touched = new Date(this.now());
        await fs.utimes(filename, touched, touched).catch(() => undefined);
        this.metrics.writes++;
      });
      await this.trim();
    } catch { this.metrics.failures++; }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }

  /** 仅删除本缓存约定的文件；不删除目录、密钥或其它应用文件。 */
  clear(): Promise<void> {
    this.generation++;
    return this.enqueue(async () => {
      const files = await fs.readdir(this.root).catch(() => []);
      await Promise.all(files.filter(name => ENTRY_PATTERN.test(name) || TEMP_PATTERN.test(name))
        .map(name => fs.rm(path.join(this.root, name), { force: true }).catch(() => undefined)));
    });
  }

  /** 数量、磁盘字节与空闲 TTL 共同受限；进程中断遗留的 temp 一小时后回收。 */
  trim(): Promise<void> {
    return this.enqueue(async () => {
      const names = await fs.readdir(this.root).catch(() => []);
      const entries: { name: string; size: number; mtimeMs: number }[] = [];
      for (const name of names) {
        if (!ENTRY_PATTERN.test(name) && !TEMP_PATTERN.test(name)) continue;
        const stat = await fs.lstat(path.join(this.root, name)).catch(() => undefined);
        if (!stat?.isFile()) continue;
        const age = this.now() - stat.mtimeMs;
        if (TEMP_PATTERN.test(name)) {
          if (age > 60 * 60 * 1000) await fs.rm(path.join(this.root, name), { force: true }).catch(() => undefined);
        } else if (age > this.ttlMs || stat.size > MAX_ENTRY_BYTES) {
          await fs.rm(path.join(this.root, name), { force: true }).catch(() => undefined);
          this.metrics.evictions++;
        } else entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
      let bytes = entries.reduce((total, entry) => total + entry.size, 0), count = entries.length;
      for (const entry of entries) {
        if (count <= this.maxEntries && bytes <= this.maxBytes) break;
        await fs.rm(path.join(this.root, entry.name), { force: true }).catch(() => undefined);
        bytes -= entry.size; count--; this.metrics.evictions++;
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.maintenance.then(task).catch(() => { this.metrics.failures++; });
    this.maintenance = result;
    return result;
  }

  private filename(identity: ModelScriptCacheKey): string {
    if (!/^[a-f0-9]{64}$/.test(identity.sourceSha256) || !identity.compilerVersion || !identity.compilationVersion) {
      throw new Error('模型脚本缓存身份无效。');
    }
    return path.join(this.root, sha256(this.identityText(identity)) + '.json');
  }

  private sign(identity: ModelScriptCacheKey, payload: string): string {
    return createHmac('sha256', this.key).update(this.identityText(identity)).update('\0').update(payload).digest('hex');
  }

  private identityText(identity: ModelScriptCacheKey): string {
    return JSON.stringify([identity.sourceSha256, identity.compilerVersion, identity.compilationVersion]);
  }
}

/** 密钥由 Electron safeStorage 保护；不可用/损坏时调用方关闭持久缓存并继续原源码路径。 */
export async function openModelScriptPersistentCache(root: string, protection: ModelScriptCacheKeyProtection): Promise<ModelScriptPersistentCache> {
  await fs.mkdir(root, { recursive: true });
  const keyPath = path.join(root, 'authentication.key');
  let encrypted: Buffer;
  try {
    const stat = await fs.stat(keyPath);
    if (stat.size > 8192) throw new Error('模型脚本缓存密钥无效。');
    encrypted = await fs.readFile(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const candidate = protection.protect(randomBytes(32));
    if (candidate.byteLength > 8192) throw new Error('模型脚本缓存密钥无效。', { cause: error });
    const temporary = path.join(root, '0'.repeat(64) + '.' + randomBytes(16).toString('hex') + '.tmp');
    try {
      await fs.writeFile(temporary, candidate, { flag: 'wx', mode: 0o600 });
      // 先写完整密文再原子建立名称，防止其它进程读取到创建了一半的密钥。
      try { await fs.link(temporary, keyPath); }
      catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    encrypted = await fs.readFile(keyPath);
  }
  const cache = new ModelScriptPersistentCache(root, protection.unprotect(encrypted));
  await cache.trim();
  return cache;
}
