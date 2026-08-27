import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_ENVIRONMENT_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_ENVIRONMENT_INDEX_ENTRIES = 100_000;
const LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
const STABLE_ENVIRONMENT_IDENTITY_FIELDS = [
  'source',
  'resourceType',
  'dataPlatformResourceId',
  'dataPlatformSourceKey',
  'dataPlatformRevision',
] as const;

type PlainObject = Record<string, unknown>;

type DataPlatformEnvironmentCachePath = {
  resourceId: string;
};

type SourceEnvironmentCacheEntry = {
  sourceKey: string;
  resourceId: string;
  runtimeRevision: string;
  relativePath: string;
  fileSizeBytes: number;
  fileSha256: string;
};

export type SourceEnvironmentCacheIndexes = {
  byIdentity: ReadonlyMap<string, SourceEnvironmentCacheEntry>;
  uniqueByResourceRevision: ReadonlyMap<string, SourceEnvironmentCacheEntry>;
  uniqueByResourceId: ReadonlyMap<string, SourceEnvironmentCacheEntry>;
};

export type SourceEnvironmentPackageIntegrity = {
  sourcePath: string;
  modelRelativePath: string;
  expectedModelSize: number;
  expectedModelSha256: string;
  integrityLabel: string;
};

/** 仅当场景确实引用数据中台环境时读取 Sidecar，避免无关损坏索引阻断普通项目打包。 */
export async function prepareSourceSceneEnvironments(
  sceneFiles: readonly PlainObject[],
  sharedResourcesRoot: string,
  signal: AbortSignal,
): Promise<readonly SourceEnvironmentPackageIntegrity[]> {
  const referencedScenes: PlainObject[] = [];
  for (const sceneFile of sceneFiles) {
    const environment = getSourceSceneEnvironment(sceneFile);
    if (!environment) continue;
    const references = collectSourceEnvironmentReferences(environment);
    const hasManagedCacheReference = references.some(
      (reference) => parseDataPlatformEnvironmentCacheReference(reference) !== null,
    );
    const hasManagedPortableReference = references.some(
      (reference) => parsePortableDataPlatformEnvironmentReference(reference) !== null,
    );
    if (hasManagedCacheReference || hasManagedPortableReference
      || hasAnySourceEnvironmentIdentity(environment)) {
      referencedScenes.push(sceneFile);
    }
  }
  if (referencedScenes.length === 0) return [];
  const indexes = await loadSourceEnvironmentCacheIndexes(sharedResourcesRoot, signal);
  const packages = new Map<string, SourceEnvironmentPackageIntegrity>();
  for (const sceneFile of referencedScenes) {
    const prepared = await prepareSourceSceneEnvironment(
      sceneFile,
      sharedResourcesRoot,
      indexes,
      signal,
    );
    if (!prepared) continue;
    const key = createPathKey(prepared.sourcePath);
    const existing = packages.get(key);
    if (existing && (
      existing.expectedModelSize !== prepared.expectedModelSize
      || existing.expectedModelSha256 !== prepared.expectedModelSha256
    )) {
      throw new Error(`数据中台环境模型完整性信息冲突：${prepared.sourcePath}`);
    }
    packages.set(key, prepared);
  }
  return [...packages.values()];
}

/** 读取当前共享缓存 Sidecar，仅把严格受管且处于 active 状态的环境记录加入重关联索引。 */
export async function loadSourceEnvironmentCacheIndexes(
  sharedResourcesRoot: string,
  signal: AbortSignal,
): Promise<SourceEnvironmentCacheIndexes> {
  const empty = createSourceEnvironmentCacheIndexes([]);
  const indexPath = path.join(
    sharedResourcesRoot,
    '.babylon-editor',
    'data-platform-environment-index.json',
  );
  const indexStat = await fs.lstat(indexPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!indexStat) return empty;

  throwIfAborted(signal);
  await assertTrustedPathWithinRoot(sharedResourcesRoot, indexPath, '环境模型 Sidecar 索引');
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
    throw new Error('环境模型 Sidecar 索引不是安全普通文件。');
  }
  if (indexStat.size <= 0 || indexStat.size > MAX_ENVIRONMENT_INDEX_BYTES) {
    throw new Error('环境模型 Sidecar 索引大小无效。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(indexPath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('环境模型 Sidecar 索引不是有效 JSON。');
    throw error;
  }
  throwIfAborted(signal);
  if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('环境模型 Sidecar 索引格式无效。');
  }
  if (parsed.entries.length > MAX_ENVIRONMENT_INDEX_ENTRIES) {
    throw new Error(`环境模型 Sidecar 索引超过 ${MAX_ENVIRONMENT_INDEX_ENTRIES} 项限制。`);
  }

  const rootSourceKey = parsed.sourceKey === '' ? '' : readSourceEnvironmentKey(parsed.sourceKey);
  const entries: SourceEnvironmentCacheEntry[] = [];
  const seenResourceIds = new Set<string>();
  for (const rawEntry of parsed.entries) {
    throwIfAborted(signal);
    const entry = normalizeSourceEnvironmentCacheEntry(rawEntry);
    if (rootSourceKey && entry.sourceKey !== rootSourceKey) {
      throw new Error('环境模型 Sidecar 索引项来源与根节点不一致。');
    }
    if (seenResourceIds.has(entry.resourceId)) {
      throw new Error(`环境模型 Sidecar 索引存在重复资源 ID：${entry.resourceId}`);
    }
    seenResourceIds.add(entry.resourceId);
    if (isPlainObject(rawEntry) && rawEntry.status === 'active') entries.push(entry);
  }
  return createSourceEnvironmentCacheIndexes(entries);
}

/** 在 SOURCE 扫描资源前，把数据中台环境引用临时指向当前共享缓存。 */
export async function prepareSourceSceneEnvironment(
  sceneFile: PlainObject,
  sharedResourcesRoot: string,
  indexes: SourceEnvironmentCacheIndexes,
  signal: AbortSignal,
): Promise<SourceEnvironmentPackageIntegrity | null> {
  const environment = getSourceSceneEnvironment(sceneFile);
  if (!environment) return null;
  for (const reference of collectSourceEnvironmentReferences(environment)) {
    parseDataPlatformEnvironmentCacheReference(reference);
    parsePortableDataPlatformEnvironmentReference(reference);
  }

  const entry = findSourceEnvironmentCacheEntry(environment, indexes);
  if (!entry) {
    throw new Error('场景引用的数据中台环境在当前共享缓存 Sidecar 中不存在或无法唯一匹配。');
  }
  const modelPath = path.resolve(sharedResourcesRoot, ...entry.relativePath.split('/'));
  await assertTrustedPathWithinRoot(
    sharedResourcesRoot,
    modelPath,
    `数据中台环境模型 ${entry.resourceId} 缓存文件`,
  );
  const modelStat = await fs.lstat(modelPath);
  if (modelStat.isSymbolicLink() || !modelStat.isFile()) {
    throw new Error(`数据中台环境模型 ${entry.resourceId} 缓存路径不是安全普通文件。`);
  }
  if (modelStat.size !== entry.fileSizeBytes) {
    throw new Error(`数据中台环境模型 ${entry.resourceId} 缓存文件大小与 Sidecar 索引不一致。`);
  }
  throwIfAborted(signal);

  const variantName = selectSourceEnvironmentVariantName(environment);
  const sourceUrl = `${LOCAL_ASSET_URL_PREFIX}${encodeURIComponent(modelPath)}?assetRevision=${entry.runtimeRevision}`;
  environment.packagePath = path.dirname(modelPath);
  environment.activeVariantUrl = sourceUrl;
  delete environment.thumbnailUrl;
  environment.variants = [{ name: variantName, sourcePath: modelPath, sourceUrl }];
  environment.source = 'data-platform';
  environment.resourceType = 'ENV_MODEL';
  environment.dataPlatformResourceId = entry.resourceId;
  environment.dataPlatformSourceKey = entry.sourceKey;
  environment.dataPlatformRevision = entry.runtimeRevision;
  return {
    sourcePath: path.dirname(modelPath),
    modelRelativePath: path.basename(modelPath),
    expectedModelSize: entry.fileSizeBytes,
    expectedModelSha256: entry.fileSha256,
    integrityLabel: `数据中台环境模型 ${entry.resourceId}`,
  };
}

function normalizeSourceEnvironmentCacheEntry(value: unknown): SourceEnvironmentCacheEntry {
  if (!isPlainObject(value)) throw new Error('环境模型 Sidecar 索引项格式无效。');
  const sourceKey = readSourceEnvironmentKey(value.sourceKey);
  const resourceId = readSourceEnvironmentRevision(value.resourceId, '资源 ID');
  const fileRevision = readSourceEnvironmentRevision(value.fileRevision, '文件修订');
  const runtimeRevision = readSourceEnvironmentRevision(value.runtimeRevision, '运行修订');
  const fileSizeBytes = value.fileSizeBytes;
  if (typeof fileSizeBytes !== 'number' || !Number.isSafeInteger(fileSizeBytes)
    || fileSizeBytes <= 0 || fileSizeBytes > 512 * 1024 * 1024) {
    throw new Error('环境模型 Sidecar 文件大小无效。');
  }
  const fileSha256 = typeof value.fileSha256 === 'string' ? value.fileSha256.trim() : '';
  if (!/^[0-9a-f]{64}$/.test(fileSha256)) throw new Error('环境模型 Sidecar SHA-256 无效。');
  const relativePath = typeof value.relativePath === 'string' ? value.relativePath.trim() : '';
  const expectedRelativePath = createManagedEnvironmentModelPath(sourceKey, resourceId, fileRevision);
  if (relativePath !== expectedRelativePath) {
    throw new Error('环境模型 Sidecar 索引路径与资源身份不一致。');
  }
  if (value.status !== 'active' && value.status !== 'stale' && value.status !== 'deleted') {
    throw new Error('环境模型 Sidecar 索引状态无效。');
  }
  return { sourceKey, resourceId, runtimeRevision, relativePath, fileSizeBytes, fileSha256 };
}

function createSourceEnvironmentCacheIndexes(
  entries: readonly SourceEnvironmentCacheEntry[],
): SourceEnvironmentCacheIndexes {
  return {
    byIdentity: createUniqueSourceEnvironmentIndex(entries, (entry) => (
      `${entry.sourceKey}:${entry.resourceId}`
    )),
    uniqueByResourceRevision: createUniqueSourceEnvironmentIndex(entries, (entry) => (
      `${entry.resourceId}:${entry.runtimeRevision}`
    )),
    uniqueByResourceId: createUniqueSourceEnvironmentIndex(entries, (entry) => entry.resourceId),
  };
}

function createUniqueSourceEnvironmentIndex(
  entries: readonly SourceEnvironmentCacheEntry[],
  getKey: (entry: SourceEnvironmentCacheEntry) => string,
): ReadonlyMap<string, SourceEnvironmentCacheEntry> {
  const candidates = new Map<string, SourceEnvironmentCacheEntry | null>();
  for (const entry of entries) {
    const key = getKey(entry);
    candidates.set(key, candidates.has(key) ? null : entry);
  }
  return new Map(
    [...candidates.entries()].filter(
      (candidate): candidate is [string, SourceEnvironmentCacheEntry] => candidate[1] !== null,
    ),
  );
}

function findSourceEnvironmentCacheEntry(
  environment: PlainObject,
  indexes: SourceEnvironmentCacheIndexes,
): SourceEnvironmentCacheEntry | null {
  const hasStableIdentity = hasAnySourceEnvironmentIdentity(environment);
  if (hasStableIdentity) {
    const sourceKey = normalizeSourceEnvironmentKey(environment.dataPlatformSourceKey);
    const resourceId = normalizeSourceEnvironmentRevision(environment.dataPlatformResourceId);
    const runtimeRevision = normalizeSourceEnvironmentRevision(environment.dataPlatformRevision);
    if (environment.source !== 'data-platform' || environment.resourceType !== 'ENV_MODEL'
      || !sourceKey || !resourceId || !runtimeRevision) {
      throw new Error('场景中的数据中台环境稳定身份不完整或无效。');
    }
    return indexes.byIdentity.get(`${sourceKey}:${resourceId}`)
      ?? indexes.uniqueByResourceRevision.get(`${resourceId}:${runtimeRevision}`)
      ?? null;
  }

  const cacheResourceIds = new Set<string>();
  for (const reference of collectSourceEnvironmentReferences(environment)) {
    const managedReference = parseDataPlatformEnvironmentCacheReference(reference)
      ?? parsePortableDataPlatformEnvironmentReference(reference);
    if (managedReference) cacheResourceIds.add(managedReference.resourceId);
  }
  if (cacheResourceIds.size !== 1) return null;
  return indexes.uniqueByResourceId.get([...cacheResourceIds][0]) ?? null;
}

function getSourceSceneEnvironment(sceneFile: PlainObject): PlainObject | null {
  const scene = isPlainObject(sceneFile.scene) ? sceneFile.scene : null;
  const sceneSettings = scene && isPlainObject(scene.sceneSettings) ? scene.sceneSettings : null;
  return sceneSettings && isPlainObject(sceneSettings.environment)
    ? sceneSettings.environment
    : null;
}

function collectSourceEnvironmentReferences(environment: PlainObject): string[] {
  const references: string[] = [];
  for (const value of [environment.packagePath, environment.activeVariantUrl, environment.thumbnailUrl]) {
    if (typeof value === 'string' && value.trim()) references.push(value);
  }
  if (Array.isArray(environment.variants)) {
    for (const variant of environment.variants) {
      if (!isPlainObject(variant)) continue;
      for (const value of [variant.sourcePath, variant.sourceUrl]) {
        if (typeof value === 'string' && value.trim()) references.push(value);
      }
    }
  }
  return references;
}

function parseDataPlatformEnvironmentCacheReference(
  value: string,
): DataPlatformEnvironmentCachePath | null {
  const normalized = normalizeSourceEnvironmentReference(value);
  const segments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  const cacheStartIndex = segments.findIndex((segment, index) => (
    segment.toLowerCase() === '.babylon-editor'
    && segments[index + 1]?.toLowerCase() === 'data-platform-cache'
    && segments[index + 2]?.toLowerCase() === 'environments'
  ));
  if (cacheStartIndex < 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('场景中的数据中台环境缓存引用包含不安全路径片段。');
  }

  const sourceKey = segments[cacheStartIndex + 3] ?? '';
  const resourceId = segments[cacheStartIndex + 4] ?? '';
  const fileRevision = segments[cacheStartIndex + 5] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(sourceKey)
    || !/^[1-9]\d{0,63}$/.test(resourceId)
    || !/^[1-9]\d{0,63}$/.test(fileRevision)) {
    throw new Error('场景中的数据中台环境缓存引用身份格式无效。');
  }
  return { resourceId };
}

function parsePortableDataPlatformEnvironmentReference(
  value: string,
): DataPlatformEnvironmentCachePath | null {
  const normalized = normalizeSourceEnvironmentReference(value);
  const segments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('场景中的便携环境引用包含不安全路径片段。');
  }
  const assetsIndex = segments.findIndex((segment, index) => (
    segment.toLowerCase() === 'assets'
    && segments[index + 1]?.toLowerCase() === 'environments'
  ));
  if (assetsIndex < 0) return null;
  const match = /^Env-([1-9]\d{0,63})$/i.exec(segments[assetsIndex + 2] ?? '');
  return match ? { resourceId: match[1] } : null;
}

function normalizeSourceEnvironmentReference(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith(LOCAL_ASSET_URL_PREFIX)) return normalized;
  try {
    return decodeURIComponent(new URL(normalized).pathname.slice(1));
  } catch {
    throw new Error('场景中的本地环境资源 URL 格式无效。');
  }
}

function selectSourceEnvironmentVariantName(environment: PlainObject): string {
  if (!Array.isArray(environment.variants)) return '环境模型';
  const activeVariantUrl = typeof environment.activeVariantUrl === 'string'
    ? environment.activeVariantUrl
    : '';
  const variants = environment.variants.filter(isPlainObject);
  const activeVariant = variants.find((variant) => (
    variant.sourceUrl === activeVariantUrl || variant.sourcePath === activeVariantUrl
  ));
  const name = (activeVariant ?? variants[0])?.name;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 128) : '环境模型';
}

function hasAnySourceEnvironmentIdentity(environment: PlainObject): boolean {
  return STABLE_ENVIRONMENT_IDENTITY_FIELDS.some((field) => (
    Object.prototype.hasOwnProperty.call(environment, field)
  ));
}

function createManagedEnvironmentModelPath(
  sourceKey: string,
  resourceId: string,
  fileRevision: string,
): string {
  return `.babylon-editor/data-platform-cache/environments/${sourceKey}/${resourceId}/${fileRevision}/model.glb`;
}

function readSourceEnvironmentKey(value: unknown): string {
  const normalized = normalizeSourceEnvironmentKey(value);
  if (!normalized) throw new Error('环境模型 Sidecar sourceKey 无效。');
  return normalized;
}

function normalizeSourceEnvironmentKey(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value.trim())
    ? value.trim()
    : null;
}

function readSourceEnvironmentRevision(value: unknown, label: string): string {
  const normalized = normalizeSourceEnvironmentRevision(value);
  if (!normalized) throw new Error(`环境模型 Sidecar ${label}无效。`);
  return normalized;
}

function normalizeSourceEnvironmentRevision(value: unknown): string | null {
  return typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value.trim())
    ? value.trim()
    : null;
}

/** 校验共享缓存根到目标文件的每一级真实路径，拒绝符号链接和 Junction。 */
export async function assertTrustedPathWithinRoot(
  sharedResourcesRoot: string,
  targetPath: string,
  label: string,
): Promise<void> {
  const root = path.resolve(sharedResourcesRoot);
  const target = path.resolve(targetPath);
  if (!isPathInsideOrEqual(root, target)) throw new Error(`${label}越过共享资源目录。`);

  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('共享资源根目录不是可信普通目录。');
  }
  const realRoot = await fs.realpath(root);
  const relative = path.relative(root, target);
  if (!relative) return;

  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}包含符号链接或 Junction：${current}`);
    }
    const realCurrent = await fs.realpath(current);
    if (!isPathInsideOrEqual(realRoot, realCurrent)) throw new Error(`${label}真实路径越界。`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label}的父路径不是目录：${current}`);
    }
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('数字孪生源工程打包已取消。');
  error.name = 'AbortError';
  throw error;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
