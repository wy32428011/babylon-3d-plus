import { resolveSkyboxLocalPath, verifySkyboxEnvironmentFile } from './skyboxEnvironmentResources.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { assertRecoveryPathInsideRoot } from '../shared/recoveryPathBoundary.ts';
import {
  inspectSkyboxEnvironmentBytes, isSkyboxEnvironmentFaceSize, normalizeSkyboxEnvironmentResource,
  SKYBOX_ENVIRONMENT_RECIPE, MAX_SKYBOX_ENVIRONMENT_BYTES,
  type SkyboxEnvironmentResource, type SkyboxPreparationSource, type SkyboxPreparationTicket,
} from '../shared/sceneSkyboxContract.ts';
import { validateSkyboxSourceFile } from './skyboxAssetStore.ts';

const MAX_PENDING_JOBS = 32;
const JOB_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
type Options = {
  rootDirectory: string;
  cacheRoot: string;
  isAuthorizedFile: (file: string) => boolean;
  encodeUrl: (file: string) => string;
  decodeUrl: (url: string) => string;
  authorizeFile: (file: string) => void;
  findBundledEnvironment?: (sourceSha256: string, faceSize: 256 | 512 | 1024) => Promise<SkyboxEnvironmentResource | null>;
  isCurrent?: () => boolean;
  cacheBudgetBytes?: number;
};
type Job = { owner: number; startedAt: number; source: SkyboxPreparationSource; sourcePath: string; sourceSha256: string; directory: string };

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function sameStat(a: { size: number; mtimeMs: number; ino: number }, b: { size: number; mtimeMs: number; ino: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** 只在受控派生目录写入 ENV，源文件永不覆盖；token 同时绑定发起窗口和项目代次。 */
export class SkyboxDerivedAssetStore {
  private readonly jobs = new Map<string, Job>();
  // 本工程会话已交给渲染器/发布器的产物统一持有租约；只回收未借出的历史缓存。
  private readonly leasedFiles = new Set<string>();
  private commitQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  async prepare(source: SkyboxPreparationSource, owner: number): Promise<SkyboxPreparationTicket> {
    this.assertCurrent();
    this.expireJobs();
    if (!source || typeof source !== 'object' || !isSkyboxEnvironmentFaceSize(source.resolution)
      || !['hdr', 'exr'].includes(source.format) || typeof source.sourcePath !== 'string' || typeof source.sourceUrl !== 'string'
      || (source.assetRevision !== undefined && (typeof source.assetRevision !== 'string' || source.assetRevision.length > 256))) {
      throw new Error('天空资源准备参数无效。');
    }
    if (source.sourceAvailable === false) {
      const verified = await verifySkyboxEnvironmentFile(source, new AbortController().signal, this.options.isAuthorizedFile);
      this.assertCurrent();
      this.leasedFiles.add(verified.sourcePath);
      return { token: null, sourceUrl: '', sourceSha256: verified.resource.sourceSha256, sourceRevision: verified.resource.sourceRevision,
        faceSize: source.resolution, recipeKey: SKYBOX_ENVIRONMENT_RECIPE,
        environment: { ...verified.resource, sourcePath: verified.sourcePath, sourceUrl: this.options.encodeUrl(verified.sourcePath) } };
    }
    const sourcePath = resolveSkyboxLocalPath(source.sourcePath, source.sourceUrl, this.options.decodeUrl);
    if (!path.isAbsolute(sourcePath)) throw new Error('天空源文件必须是已授权的绝对路径。');
    const sourceSha256 = await this.inspectSource(sourcePath, source);
    this.assertCurrent();
    if (source.environment) {
      try {
        const verified = await verifySkyboxEnvironmentFile({ ...source, sourcePath }, new AbortController().signal, this.options.isAuthorizedFile);
        if (verified.resource.sourceSha256 !== sourceSha256) throw new Error('ENV 与当前源内容不一致。');
        this.assertCurrent();
        this.leasedFiles.add(verified.sourcePath);
        return { token: null, sourceUrl: this.options.encodeUrl(sourcePath), sourceSha256, sourceRevision: source.assetRevision ?? '',
          faceSize: source.resolution, recipeKey: SKYBOX_ENVIRONMENT_RECIPE,
          environment: { ...verified.resource, sourcePath: verified.sourcePath, packagePath: path.dirname(verified.sourcePath), sourceUrl: this.options.encodeUrl(verified.sourcePath) } };
      } catch (error) {
        this.assertCurrent();
        console.warn('场景携带的 ENV 不可复用，将检查生成缓存：', error instanceof Error ? error.message : String(error));
      }
    }
    const bundled = await this.options.findBundledEnvironment?.(sourceSha256, source.resolution);
    if (bundled) {
      const environment = normalizeSkyboxEnvironmentResource(bundled);
      if (environment.sourceSha256 !== sourceSha256 || environment.faceSize !== source.resolution) throw new Error('内置 ENV 规格与源身份不一致。');
      this.assertCurrent();
      return { token: null, sourceUrl: this.options.encodeUrl(sourcePath), sourceSha256, sourceRevision: source.assetRevision ?? '',
        faceSize: source.resolution, recipeKey: SKYBOX_ENVIRONMENT_RECIPE, environment: { ...environment, sourceRevision: source.assetRevision ?? '' } };
    }
    const recipeHash = createHash('sha256').update(`${SKYBOX_ENVIRONMENT_RECIPE}:${source.resolution}`).digest('hex').slice(0, 24);
    await this.assertCachePath(this.options.cacheRoot);
    await fs.mkdir(this.options.cacheRoot, { recursive: true });
    await this.assertCachePath(this.options.cacheRoot);
    const directory = path.join(this.options.cacheRoot, sourceSha256, recipeHash);
    await assertRecoveryPathInsideRoot(this.options.cacheRoot, directory);
    const environment = await this.readCached(directory, sourceSha256, source.assetRevision ?? '', source.resolution);
    this.assertCurrent();
    const result = { token: null as string | null, sourceUrl: this.options.encodeUrl(sourcePath), sourceSha256,
      sourceRevision: source.assetRevision ?? '', faceSize: source.resolution, recipeKey: SKYBOX_ENVIRONMENT_RECIPE, environment };
    if (environment) return result;
    if (this.jobs.size >= MAX_PENDING_JOBS) throw new Error('天空资源准备队列已满，请等待或取消旧任务。');
    const token = randomUUID();
    this.jobs.set(token, { owner, startedAt: Date.now(), source: { ...source }, sourcePath, sourceSha256, directory });
    return { ...result, token };
  }

  commit(token: string, owner: number, value: Uint8Array | ArrayBuffer): Promise<SkyboxEnvironmentResource> {
    const pending = this.commitQueue.then(() => this.commitExclusive(token, owner, value));
    this.commitQueue = pending.catch(() => undefined);
    return pending;
  }

  private async commitExclusive(token: string, owner: number, value: Uint8Array | ArrayBuffer): Promise<SkyboxEnvironmentResource> {
    this.assertCurrent();
    this.expireJobs();
    const job = this.jobs.get(token);
    if (!job || job.owner !== owner) throw new Error('天空资源准备任务已失效或不属于当前窗口。');
    const check = () => {
      this.assertCurrent();
      if (this.jobs.get(token) !== job) throw new Error('天空资源准备已取消。');
    };
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error('天空 ENV 提交必须是二进制数据。');
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (bytes.byteLength > MAX_SKYBOX_ENVIRONMENT_BYTES) throw new Error('天空 ENV 产物超过大小上限。');
    inspectSkyboxEnvironmentBytes(bytes, job.source.resolution);
    if (await this.inspectSource(job.sourcePath, job.source) !== job.sourceSha256) throw new Error('天空源文件在转换期间发生变化，请重试。');
    check();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.assertCachePath(job.directory);
    await fs.mkdir(job.directory, { recursive: true });
    await this.assertCachePath(job.directory);
    const target = path.join(job.directory, `${sha256}.env`);
    const temporary = path.join(job.directory, `.env-${token}.tmp`);
    const manifestTemporary = path.join(job.directory, `.manifest-${token}.tmp`);
    const environment: SkyboxEnvironmentResource = {
      version: 1, format: 'env', sourceSha256: job.sourceSha256, sourceRevision: job.source.assetRevision ?? '',
      recipeKey: SKYBOX_ENVIRONMENT_RECIPE, sha256, byteLength: bytes.byteLength, faceSize: job.source.resolution,
      sourcePath: target, packagePath: job.directory, sourceUrl: this.options.encodeUrl(target),
    };
    try {
      await this.assertCacheBudget(bytes.byteLength, target);
      check();
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      if (await hashFile(temporary) !== sha256) throw new Error('天空 ENV 暂存文件完整性校验失败。');
      check();
      // 内容寻址文件只创建一次；其他消费者的有效文件绝不被覆盖。
      try { await fs.copyFile(temporary, target, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('天空 ENV 缓存目标不是安全普通文件。');
      if (stat.size !== bytes.byteLength || await hashFile(target) !== sha256) {
        // 同内容地址上的损坏副本可原子修复；不覆盖任何校验通过的有效产物。
        check();
        await fs.rename(temporary, target);
        if (await hashFile(target) !== sha256) throw new Error('天空 ENV 缓存修复失败。');
      }
      check();
      await fs.writeFile(manifestTemporary, JSON.stringify(environment), { flag: 'wx' });
      await this.assertCachePath(job.directory);
      check();
      await fs.rename(manifestTemporary, path.join(job.directory, 'manifest.json'));
      this.options.authorizeFile(target);
      this.leasedFiles.add(target);
      this.jobs.delete(token);
      return environment;
    } finally {
      // 仅清理本 token 创建的暂存文件，保留已提交产物及其它任务。
      await fs.rm(temporary, { force: true });
      await fs.rm(manifestTemporary, { force: true });
    }
  }

  cancel(token: string, owner: number): boolean {
    if (this.jobs.get(token)?.owner !== owner) return false;
    return this.jobs.delete(token);
  }
  cancelOwner(owner: number): void { for (const [token, job] of this.jobs) if (job.owner === owner) this.jobs.delete(token); }
  dispose(): void { this.disposed = true; this.jobs.clear(); this.leasedFiles.clear(); }

  private assertCurrent(): void {
    if (this.disposed || this.options.isCurrent?.() === false) throw new Error('工程或窗口已切换，天空资源准备已停止。');
  }
  private expireJobs(): void {
    for (const [token, job] of this.jobs) if (Date.now() - job.startedAt > JOB_LIFETIME_MS) this.jobs.delete(token);
  }
  private async inspectSource(file: string, source: SkyboxPreparationSource): Promise<string> {
    if (!this.options.isAuthorizedFile(file)) throw new Error('天空源文件未经过当前会话授权。');
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || !this.options.isAuthorizedFile(await fs.realpath(file))) throw new Error('天空源文件不是已授权的安全普通文件。');
    const inspection = await validateSkyboxSourceFile(file);
    if (inspection.format !== source.format) throw new Error('天空源文件与声明格式不一致。');
    const sha256 = await hashFile(file);
    const after = await fs.lstat(file);
    if (!sameStat(before, after)) throw new Error('天空源文件读取期间发生变化。');
    if (source.assetRevision && /^[a-f\d]{64}$/i.test(source.assetRevision) && sha256 !== source.assetRevision.toLowerCase()) throw new Error('天空源文件内容与场景修订不一致。');
    return sha256;
  }
  private async readCached(directory: string, sourceSha256: string, sourceRevision: string, faceSize: 256 | 512 | 1024): Promise<SkyboxEnvironmentResource | null> {
    try {
      const manifest = path.join(directory, 'manifest.json');
      await assertRecoveryPathInsideRoot(this.options.cacheRoot, manifest);
      const stat = await fs.lstat(manifest);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
      const resource = normalizeSkyboxEnvironmentResource(JSON.parse(await fs.readFile(manifest, 'utf8')));
      if (resource.sourceSha256 !== sourceSha256 || resource.faceSize !== faceSize) return null;
      // manifest 中的路径不授予访问权限，只读取由内容哈希计算出的固定位置。
      const file = path.join(directory, `${resource.sha256}.env`);
      await assertRecoveryPathInsideRoot(this.options.cacheRoot, file);
      const fileStat = await fs.lstat(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== resource.byteLength) return null;
      const data = await fs.readFile(file);
      if (createHash('sha256').update(data).digest('hex') !== resource.sha256) return null;
      inspectSkyboxEnvironmentBytes(data, faceSize);
      this.options.authorizeFile(file);
      this.leasedFiles.add(file);
      return { ...resource, sourceRevision, sourcePath: file, packagePath: directory, sourceUrl: this.options.encodeUrl(file) };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      // 可重建的派生缓存损坏不影响源文件；保留诊断，重新生成时仍执行完整校验。
      console.warn('天空 ENV 缓存不可用，将从原图重新生成：', error instanceof Error ? error.message : String(error));
      return null;
    }
  }
  private async assertCachePath(target: string): Promise<void> {
    await assertRecoveryPathInsideRoot(this.options.rootDirectory, target);
    let current = path.resolve(target);
    const root = path.resolve(this.options.rootDirectory);
    while (current !== root) {
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('天空派生目录不能包含符号链接或 Junction。');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      current = path.dirname(current);
    }
  }

  private async assertCacheBudget(incoming: number, target: string): Promise<void> {
    await this.assertCachePath(this.options.cacheRoot);
    const budget = this.options.cacheBudgetBytes ?? MAX_CACHE_BYTES;
    if (incoming > budget) throw new Error('天空 ENV 超过当前派生缓存预算。');
    let used = 0;
    const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
    for (const source of await fs.readdir(this.options.cacheRoot, { withFileTypes: true })) {
      if (!source.isDirectory() || source.isSymbolicLink() || !/^[a-f\d]{64}$/.test(source.name)) continue;
      for (const recipe of await fs.readdir(path.join(this.options.cacheRoot, source.name), { withFileTypes: true })) {
        if (!recipe.isDirectory() || recipe.isSymbolicLink() || !/^[a-f\d]{24}$/.test(recipe.name)) continue;
        const folder = path.join(this.options.cacheRoot, source.name, recipe.name);
        await this.assertCachePath(folder);
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[a-f\d]{64}\.env$/.test(entry.name)) continue;
          const file = path.join(folder, entry.name), stat = await fs.lstat(file);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('天空派生文件被链接替换。');
          if (file !== target) used += stat.size;
          files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
    for (const candidate of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (used + incoming <= budget) return;
      if (candidate.file === target || this.leasedFiles.has(candidate.file)
        || [...this.jobs.values()].some(job => job.directory === path.dirname(candidate.file))) continue;
      await this.assertCachePath(candidate.file);
      this.assertCurrent();
      const stat = await fs.lstat(candidate.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs) continue;
      // 只删除本派生根中内容寻址的历史 ENV，保留原图、SOURCE 副本和当前会话已借出的文件。
      await fs.unlink(candidate.file);
      used -= candidate.size;
    }
    if (used + incoming > budget) throw new Error('当前会话使用中的天空产物超过缓存预算。请先完成保存或发布，再重新打开工程释放租约；原图和使用中的产物未被删除。');
  }
}
