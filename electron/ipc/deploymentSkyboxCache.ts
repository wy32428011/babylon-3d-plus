import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DataPlatformSkyboxIndex, DataPlatformSkyboxIndexEntry } from './dataPlatformSkyboxIndex.js';

const require = createRequire(import.meta.url);
const runtimeExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
type ProjectAssetStoreModule = typeof import('./projectAssetStore.js');
type DeploymentExportFileSystemModule = typeof import('./deploymentExportFileSystem.js');
type DataPlatformSkyboxIndexModule = typeof import('./dataPlatformSkyboxIndex.js');
type SkyboxAssetStoreModule = typeof import('./skyboxAssetStore.js');
const {
  assertSafeDirectory,
  isPathInsideOrEqual,
  throwIfDeploymentExportAborted,
} = require(`./deploymentExportFileSystem${runtimeExtension}`) as DeploymentExportFileSystemModule;
const {
  readDataPlatformSkyboxIndex,
  resolveSkyboxIndexEntryPath,
} = require(`./dataPlatformSkyboxIndex${runtimeExtension}`) as DataPlatformSkyboxIndexModule;
const { validateSkyboxSourceFile } = require(`./skyboxAssetStore${runtimeExtension}`) as SkyboxAssetStoreModule;

const STABLE_RESOURCE_ID_PATTERN = /^[1-9]\d{0,63}$/;

type PlainObject = Record<string, unknown>;
type SkyboxFileStat = Pick<Stats, 'size' | 'mtimeMs' | 'isSymbolicLink' | 'isFile'>;

export type DeploymentSkyboxCacheContext = {
  dataPlatformSkyboxRoot: string | null;
  dataPlatformSkyboxesById: ReadonlyMap<string, DataPlatformSkyboxIndexEntry>;
};

export type ResolvedDeploymentSkyboxReference = {
  entry: DataPlatformSkyboxIndexEntry;
  sourcePath: string;
  packageRoot: string;
  sourceFile: {
    sourcePath: string;
    relativePath: string;
    size: number;
    mtimeMs: number;
  };
};

export type DeploymentSkyboxValidationCache = Map<string, Promise<ResolvedDeploymentSkyboxReference>>;

export type DeploymentSkyboxCacheDependencies = {
  getSharedProjectSkyboxRoot: () => string | null;
  assertSafeDirectory: (directoryPath: string, label: string) => Promise<string>;
  readDataPlatformSkyboxIndex: (editorRoot: string) => Promise<DataPlatformSkyboxIndex>;
  resolveSkyboxIndexEntryPath: (editorRoot: string, relativePath: string) => string;
  validateSkyboxSourceFile: typeof validateSkyboxSourceFile;
  realpath: (filePath: string) => Promise<string>;
  lstat: (filePath: string) => Promise<SkyboxFileStat>;
  sha256File: (filePath: string, signal: AbortSignal) => Promise<string>;
};

const DEFAULT_DEPENDENCIES: DeploymentSkyboxCacheDependencies = {
  getSharedProjectSkyboxRoot: getDefaultSharedProjectSkyboxRoot,
  assertSafeDirectory,
  readDataPlatformSkyboxIndex,
  resolveSkyboxIndexEntryPath,
  validateSkyboxSourceFile,
  realpath: fs.realpath,
  lstat: fs.lstat,
  sha256File: sha256DeploymentSkyboxFile,
};


function getDefaultSharedProjectSkyboxRoot(): string | null {
  const store = require(`./projectAssetStore${runtimeExtension}`) as ProjectAssetStoreModule;
  return store.getSharedProjectSkyboxRoot();
}

export function createDeploymentSkyboxValidationCache(): DeploymentSkyboxValidationCache {
  return new Map();
}

/** 加载 Task4 挂载的共享天空盒根，并严格读取 Task2 索引。 */
export async function loadDeploymentSkyboxCacheContext(
  signal: AbortSignal,
  dependencyOverrides: Partial<DeploymentSkyboxCacheDependencies> = {},
): Promise<DeploymentSkyboxCacheContext> {
  throwIfDeploymentExportAborted(signal);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  let configuredRoot: string | null;
  try {
    configuredRoot = dependencies.getSharedProjectSkyboxRoot();
  } catch (error) {
    throw sanitizeStorageBoundaryError('缓存根目录', error);
  }
  if (!configuredRoot) return emptyDeploymentSkyboxCacheContext();

  let safeRoot: string;
  try {
    safeRoot = await dependencies.assertSafeDirectory(configuredRoot, '数据中台天空盒缓存根目录');
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    if (isNodeFileSystemError(error)) throw sanitizeStorageBoundaryError('缓存根目录', error);
    throw preserveSafeBusinessError(error, '数据中台天空盒缓存根目录不可用。');
  }

  let index: DataPlatformSkyboxIndex;
  try {
    index = await dependencies.readDataPlatformSkyboxIndex(safeRoot);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    if (isNodeFileSystemError(error)) throw sanitizeStorageBoundaryError('索引', error);
    throw preserveSafeBusinessError(error, '数据中台天空盒索引格式无效。');
  }

  return {
    dataPlatformSkyboxRoot: safeRoot,
    dataPlatformSkyboxesById: new Map(index.entries.map((entry) => [entry.resourceId, entry])),
  };
}

export function emptyDeploymentSkyboxCacheContext(): DeploymentSkyboxCacheContext {
  return { dataPlatformSkyboxRoot: null, dataPlatformSkyboxesById: new Map() };
}

/** 仅接受场景天空盒自身的数据属性，禁止继承值和 accessor。 */
export function readSceneSkyboxDataPlatformResourceId(skybox: PlainObject): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(skybox, 'dataPlatformResourceId');
  if (!descriptor) {
    if ('dataPlatformResourceId' in skybox) {
      throw new Error('天空盒 dataPlatformResourceId 必须是自有 data property。');
    }
    return null;
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('天空盒 dataPlatformResourceId 必须是自有 data property。');
  }
  if (typeof descriptor.value !== 'string' || !STABLE_RESOURCE_ID_PATTERN.test(descriptor.value)) {
    throw new Error('天空盒 dataPlatformResourceId 必须是 1-64 位规范正十进制字符串。');
  }
  return descriptor.value;
}

/** 按 stableID 解析并完整校验缓存；单次导出对同一 resourceId 复用同一个 Promise。 */
export async function resolveDeploymentSkyboxReference(
  skybox: PlainObject,
  context: DeploymentSkyboxCacheContext | null,
  validationCache: DeploymentSkyboxValidationCache,
  signal: AbortSignal,
  dependencyOverrides: Partial<DeploymentSkyboxCacheDependencies> = {},
): Promise<ResolvedDeploymentSkyboxReference | null> {
  throwIfDeploymentExportAborted(signal);
  const resourceId = readSceneSkyboxDataPlatformResourceId(skybox);
  if (!resourceId) return null;
  const entry = context?.dataPlatformSkyboxesById.get(resourceId) ?? null;
  if (!entry || !context?.dataPlatformSkyboxRoot) {
    throw new Error(`数据中台天空盒（ID ${resourceId}）未在当前项目缓存索引中找到。`);
  }
  if (skybox.format !== entry.format) {
    throw createDataPlatformSkyboxCacheError(entry, new Error('缓存格式与场景天空盒格式不一致。'));
  }

  const cacheKey = `resource:${resourceId}`;
  let validation = validationCache.get(cacheKey);
  if (!validation) {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
    validation = validateIndexedSkybox(entry, context.dataPlatformSkyboxRoot, signal, dependencies)
      .catch((error: unknown) => {
        if (isAbortError(error, signal)) throw error;
        throw createDataPlatformSkyboxCacheError(entry, error);
      });
    validationCache.set(cacheKey, validation);
  }
  return validation;
}

async function validateIndexedSkybox(
  entry: DataPlatformSkyboxIndexEntry,
  cacheRoot: string,
  signal: AbortSignal,
  dependencies: DeploymentSkyboxCacheDependencies,
): Promise<ResolvedDeploymentSkyboxReference> {
  throwIfDeploymentExportAborted(signal);
  const sourcePath = dependencies.resolveSkyboxIndexEntryPath(cacheRoot, entry.relativePath);
  const packageRoot = path.dirname(sourcePath);
  if (!isPathInsideOrEqual(cacheRoot, packageRoot)) throw new Error('缓存路径逃逸数据中台天空盒根目录。');
  const packageRealPath = await dependencies.assertSafeDirectory(packageRoot, '数据中台天空盒兼容缓存目录');
  if (!isPathInsideOrEqual(cacheRoot, packageRealPath)) {
    throw new Error('缓存目录通过符号链接或 Junction 逃逸数据中台天空盒根目录。');
  }

  const beforeStat = await dependencies.lstat(sourcePath);
  assertSafeIndexedSkyboxFile(beforeStat);
  if (beforeStat.size !== entry.fileSizeBytes) throw new Error('缓存文件大小与索引不一致。');
  const sourceRealPath = await dependencies.realpath(sourcePath);
  if (!isPathInsideOrEqual(packageRealPath, sourceRealPath)) {
    throw new Error('缓存文件 realpath 逃逸数据中台天空盒目录。');
  }

  const validation = await dependencies.validateSkyboxSourceFile(sourceRealPath);
  if (validation.format !== entry.format) throw new Error('缓存文件格式与索引不一致。');
  if (validation.fileSizeBytes !== entry.fileSizeBytes) throw new Error('缓存文件大小与索引不一致。');
  const actualSha256 = await dependencies.sha256File(sourceRealPath, signal);
  if (actualSha256 !== entry.sha256) throw new Error('缓存文件 SHA-256 与索引不一致。');

  const afterStat = await dependencies.lstat(sourcePath);
  assertSafeIndexedSkyboxFile(afterStat);
  if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs) {
    throw new Error('缓存文件在完整校验期间发生变化。');
  }

  return {
    entry,
    sourcePath: sourceRealPath,
    packageRoot: packageRealPath,
    sourceFile: {
      sourcePath: sourceRealPath,
      relativePath: path.basename(sourceRealPath),
      size: afterStat.size,
      mtimeMs: afterStat.mtimeMs,
    },
  };
}

function assertSafeIndexedSkyboxFile(stat: SkyboxFileStat): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('缓存文件不是安全普通文件。');
}

async function sha256DeploymentSkyboxFile(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      throwIfDeploymentExportAborted(signal);
      hash.update(chunk as Buffer);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

export function createDataPlatformSkyboxOrphanedWarning(entry: DataPlatformSkyboxIndexEntry): string {
  return `数据中台天空盒“${entry.displayName}”（ID ${entry.resourceId}）已删除，发布包将使用本地兼容缓存。`;
}

export function createDataPlatformSkyboxIntegrityLabel(entry: DataPlatformSkyboxIndexEntry): string {
  return `数据中台天空盒“${entry.displayName}”（ID ${entry.resourceId}）兼容缓存`;
}

export function createDataPlatformSkyboxCacheError(entry: DataPlatformSkyboxIndexEntry, error: unknown): Error {
  return new Error(`${createDataPlatformSkyboxIntegrityLabel(entry)}缺失：${toSafeSkyboxCacheFailureReason(error)}`);
}

function sanitizeStorageBoundaryError(boundary: '缓存根目录' | '索引', error: unknown): Error {
  const code = isNodeFileSystemError(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? `（${error.code}）`
    : '';
  return new Error(`数据中台天空盒${boundary}不可访问${code}。`);
}

function preserveSafeBusinessError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message && message.length <= 2_000 && !containsAbsoluteLocalPath(message)) return new Error(message);
  return new Error(fallback);
}

function toSafeSkyboxCacheFailureReason(error: unknown): string {
  if (isNodeFileSystemError(error)) {
    if (error.code === 'ENOENT') return '缓存文件不存在。';
    if (error.code === 'EACCES' || error.code === 'EPERM') return '缓存文件不可读或无权限访问。';
    const safeCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'IO_ERROR';
    return `缓存文件读取失败（${safeCode}）。`;
  }
  const message = error instanceof Error ? error.message.trim() : '';
  if (message && /^(?:天空盒|HDR|EXR|缓存|数据中台)/.test(message) && !containsAbsoluteLocalPath(message)) {
    return /[。！？]$/.test(message) ? message : `${message}。`;
  }
  return '缓存文件不可用或校验失败。';
}

function containsAbsoluteLocalPath(value: string): boolean {
  return /[A-Za-z]:[\/]|\\|file:\/\/|(?:^|[\s：])\/(?:[^/\s]+\/)+[^/\s]*/i.test(value);
}

function isNodeFileSystemError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}
