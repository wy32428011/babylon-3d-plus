import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

export const DATA_PLATFORM_MODEL_INDEX_VERSION = 1 as const;

const INDEX_FILE_NAME = 'data-platform-model-index.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const RESOURCE_ID_PATTERN = /^\d{1,64}$/;
const MODEL_PACKAGE_PATH_PATTERN = /^Assets\/Models\/Model-(\d{1,64})(?:-[^/]+)?$/;
const COMBO_PACKAGE_PATH_PATTERN = /^Assets\/Models\/ComboModels\/Combo-(\d{1,64})(?:-[^/]+)?$/;

export type DataPlatformModelKind = 'model' | 'combo';

export type DataPlatformModelSyncDescriptor = {
  kind: DataPlatformModelKind;
  resourceId: string;
  displayName: string;
  packageRelativePath: string;
  /** 远端为运行时资源提供的稳定版本指纹；null 表示旧接口，必须下载后比较内容哈希。 */
  contentFingerprint: string | null;
  /** 缩略图版本指纹；无缩略图时由调用方传入稳定的“无资源”指纹。 */
  thumbnailFingerprint: string | null;
};

export type DataPlatformModelIndexEntry = DataPlatformModelSyncDescriptor & {
  runtimeRevision: string;
  fileRevision: string;
  metadataRevision: string;
  scriptRevision: string;
  thumbnailRevision: string;
  syncedAt: string;
};

export type DataPlatformModelIndex = {
  version: typeof DATA_PLATFORM_MODEL_INDEX_VERSION;
  sourceKey: string;
  entries: DataPlatformModelIndexEntry[];
};

export type DataPlatformModelPlanReuse = {
  descriptor: DataPlatformModelSyncDescriptor;
  currentEntry: DataPlatformModelIndexEntry;
  nextEntry: DataPlatformModelIndexEntry;
};

export type DataPlatformModelPlan = {
  downloads: DataPlatformModelSyncDescriptor[];
  reused: DataPlatformModelPlanReuse[];
  removed: DataPlatformModelIndexEntry[];
  nextEntries: DataPlatformModelIndexEntry[];
  runtimeChangedResourceKeys: string[];
  metadataChangedResourceKeys: string[];
};

export type DataPlatformModelRuntimeRevision = {
  runtimeRevision: string;
  fileRevision: string;
  metadataRevision: string;
  scriptRevision: string;
  thumbnailRevision: string;
};

export function getDataPlatformModelIndexPath(editorRoot: string): string {
  return path.join(editorRoot, '.babylon-editor', INDEX_FILE_NAME);
}

export function createDataPlatformModelResourceKey(
  kind: DataPlatformModelKind,
  resourceId: string,
): string {
  return `${kind}:${normalizeResourceId(resourceId)}`;
}

export async function readDataPlatformModelIndex(editorRoot: string): Promise<DataPlatformModelIndex> {
  try {
    const content = await fs.readFile(getDataPlatformModelIndexPath(editorRoot), 'utf8');
    return normalizeDataPlatformModelIndex(JSON.parse(content) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: DATA_PLATFORM_MODEL_INDEX_VERSION, sourceKey: '', entries: [] };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`数据中台模型同步索引 JSON 已损坏：${error.message}`);
    }
    throw error;
  }
}

export async function writeDataPlatformModelIndexFile(
  targetPath: string,
  index: DataPlatformModelIndex,
): Promise<void> {
  const normalized = normalizeDataPlatformModelIndex(index);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

/**
 * 只把内容指纹变化、缓存缺失或资产索引缺失的包列入运行时变化。
 * 展示名称变化只更新 Sidecar，避免无意义地销毁 Babylon 模型和批次。
 */
export function buildDataPlatformModelPlan(options: {
  sourceKey: string;
  remote: readonly DataPlatformModelSyncDescriptor[];
  current: DataPlatformModelIndex;
  existingPackagePaths: ReadonlySet<string>;
  existingAssetKeys: ReadonlySet<string>;
  existingThumbnailKeys?: ReadonlySet<string>;
  syncedAt?: string;
}): DataPlatformModelPlan {
  const sourceKey = normalizeSourceKey(options.sourceKey);
  const syncedAt = normalizeTimestamp(options.syncedAt ?? new Date().toISOString());
  const current = normalizeDataPlatformModelIndex(options.current);
  const remote = options.remote.map(normalizeDescriptor);
  assertUniqueDescriptors(remote);

  const currentEntries = current.sourceKey === sourceKey ? current.entries : [];
  const currentByKey = new Map(currentEntries.map((entry) => [resourceKey(entry), entry]));
  const remoteKeys = new Set(remote.map(resourceKey));
  const downloads: DataPlatformModelSyncDescriptor[] = [];
  const reused: DataPlatformModelPlanReuse[] = [];
  const removed: DataPlatformModelIndexEntry[] = [];
  const nextEntries: DataPlatformModelIndexEntry[] = [];
  const runtimeChanged = new Set<string>();
  const metadataChanged = new Set<string>();

  for (const descriptor of remote) {
    const key = resourceKey(descriptor);
    const existing = currentByKey.get(key);
    const packageExists = existing !== undefined
      && options.existingPackagePaths.has(existing.packageRelativePath);
    const assetExists = options.existingAssetKeys.has(key);
    const thumbnailExists = options.existingThumbnailKeys?.has(key) ?? assetExists;
    const contentMatches = descriptor.contentFingerprint !== null
      && existing?.contentFingerprint === descriptor.contentFingerprint;
    const thumbnailMatches = descriptor.thumbnailFingerprint !== null
      && existing?.thumbnailFingerprint === descriptor.thumbnailFingerprint;
    const canReuseRuntime = Boolean(existing && packageExists && assetExists && contentMatches);
    const canReusePackage = canReuseRuntime && thumbnailMatches && thumbnailExists;

    if (!canReusePackage) downloads.push(descriptor);
    if (!canReuseRuntime) runtimeChanged.add(key);

    if (!existing) continue;
    if (existing.displayName !== descriptor.displayName || !thumbnailMatches) {
      metadataChanged.add(key);
    }
    if (!canReusePackage) continue;

    const descriptorChanged = existing.displayName !== descriptor.displayName
      || existing.contentFingerprint !== descriptor.contentFingerprint
      || existing.thumbnailFingerprint !== descriptor.thumbnailFingerprint;
    const nextEntry: DataPlatformModelIndexEntry = descriptorChanged
      ? {
          ...existing,
          displayName: descriptor.displayName,
          contentFingerprint: descriptor.contentFingerprint,
          thumbnailFingerprint: descriptor.thumbnailFingerprint,
          syncedAt,
        }
      : existing;
    reused.push({ descriptor, currentEntry: existing, nextEntry });
    nextEntries.push(nextEntry);
  }

  for (const entry of currentEntries) {
    const key = resourceKey(entry);
    if (remoteKeys.has(key)) continue;
    removed.push(entry);
    runtimeChanged.add(key);
  }

  downloads.sort(compareDescriptors);
  reused.sort((left, right) => compareDescriptors(left.descriptor, right.descriptor));
  removed.sort(compareDescriptors);
  nextEntries.sort(compareDescriptors);

  return {
    downloads,
    reused,
    removed,
    nextEntries,
    runtimeChangedResourceKeys: [...runtimeChanged].sort(compareResourceKeys),
    metadataChangedResourceKeys: [...metadataChanged].sort(compareResourceKeys),
  };
}

/** 流式计算模型运行时内容版本；缩略图不参与，meta 对象键顺序也不影响结果。 */
export async function createDataPlatformModelRuntimeRevision(options: {
  modelPath: string;
  metadataPath: string;
  scriptPaths: readonly string[];
  thumbnailPath?: string | null;
}): Promise<DataPlatformModelRuntimeRevision> {
  const fileRevision = await hashFile(options.modelPath);
  const metadataRevision = await hashRuntimeMetadata(options.metadataPath);
  const scriptHash = createHash('sha256');
  scriptHash.update('data-platform-model-scripts-v1\0');
  for (const scriptPath of options.scriptPaths) {
    scriptHash.update(path.basename(scriptPath));
    scriptHash.update('\0');
    scriptHash.update(await hashFile(scriptPath));
    scriptHash.update('\0');
  }
  const scriptRevision = scriptHash.digest('hex');
  const thumbnailRevision = options.thumbnailPath
    ? await hashFile(options.thumbnailPath)
    : hashText('data-platform-model-thumbnail:none');
  const runtimeRevision = hashText([
    'data-platform-model-runtime-v1',
    fileRevision,
    metadataRevision,
    scriptRevision,
  ].join('\0'));

  return { runtimeRevision, fileRevision, metadataRevision, scriptRevision, thumbnailRevision };
}

function normalizeDataPlatformModelIndex(value: unknown): DataPlatformModelIndex {
  if (!isPlainObject(value) || value.version !== DATA_PLATFORM_MODEL_INDEX_VERSION || !Array.isArray(value.entries)) {
    throw new Error('数据中台模型同步索引格式不正确。');
  }
  const entries = value.entries.map(normalizeIndexEntry);
  const sourceKey = value.sourceKey === '' ? '' : normalizeSourceKey(value.sourceKey);
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = resourceKey(entry);
    if (keys.has(key)) throw new Error(`数据中台模型同步索引存在重复资源：${key}`);
    keys.add(key);
  }
  entries.sort(compareDescriptors);
  return { version: DATA_PLATFORM_MODEL_INDEX_VERSION, sourceKey, entries };
}

function normalizeIndexEntry(value: unknown): DataPlatformModelIndexEntry {
  if (!isPlainObject(value)) throw new Error('数据中台模型同步索引条目格式不正确。');
  const descriptor = normalizeDescriptor(value);
  return {
    ...descriptor,
    runtimeRevision: normalizeSha256(value.runtimeRevision, 'runtimeRevision'),
    fileRevision: normalizeSha256(value.fileRevision, 'fileRevision'),
    metadataRevision: normalizeSha256(value.metadataRevision, 'metadataRevision'),
    scriptRevision: normalizeSha256(value.scriptRevision, 'scriptRevision'),
    thumbnailRevision: normalizeSha256(value.thumbnailRevision, 'thumbnailRevision'),
    syncedAt: normalizeTimestamp(value.syncedAt),
  };
}

function normalizeDescriptor(value: DataPlatformModelSyncDescriptor | Record<string, unknown>): DataPlatformModelSyncDescriptor {
  if (!isPlainObject(value)) throw new Error('数据中台模型同步描述格式不正确。');
  const kind = value.kind;
  if (kind !== 'model' && kind !== 'combo') throw new Error('数据中台模型 kind 仅支持 model 或 combo。');
  const resourceId = normalizeResourceId(value.resourceId);
  const displayName = normalizeRequiredString(value.displayName, 'displayName');
  const packageRelativePath = normalizePackageRelativePath(kind, resourceId, value.packageRelativePath);
  return {
    kind,
    resourceId,
    displayName,
    packageRelativePath,
    contentFingerprint: normalizeOptionalSha256(value.contentFingerprint, 'contentFingerprint'),
    thumbnailFingerprint: normalizeOptionalSha256(value.thumbnailFingerprint, 'thumbnailFingerprint'),
  };
}

function normalizePackageRelativePath(kind: DataPlatformModelKind, resourceId: string, value: unknown): string {
  const relativePath = normalizeRequiredString(value, 'packageRelativePath');
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
    throw new Error('数据中台模型 packageRelativePath 必须是规范相对路径。');
  }
  const pattern = kind === 'model' ? MODEL_PACKAGE_PATH_PATTERN : COMBO_PACKAGE_PATH_PATTERN;
  const match = pattern.exec(relativePath);
  if (!match || match[1] !== resourceId) {
    throw new Error('数据中台模型 packageRelativePath 与资源类型或 ID 不一致。');
  }
  return relativePath;
}

function normalizeResourceId(value: unknown): string {
  if (typeof value === 'string' && RESOURCE_ID_PATTERN.test(value.trim())) return value.trim();
  throw new Error('数据中台模型资源 ID 必须是最多 64 位非负十进制字符串。');
}

function normalizeSha256(value: unknown, label: string): string {
  if (typeof value === 'string' && SHA256_PATTERN.test(value.trim())) return value.trim();
  throw new Error(`数据中台模型 ${label} 必须是 64 位小写 SHA-256。`);
}

function normalizeOptionalSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  return normalizeSha256(value, label);
}

function normalizeSourceKey(value: unknown): string {
  if (typeof value === 'string' && SOURCE_KEY_PATTERN.test(value.trim())) return value.trim();
  throw new Error('数据中台模型 sourceKey 必须是 64 位小写 SHA-256。');
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`数据中台模型 ${label} 不能为空。`);
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error('数据中台模型 syncedAt 必须是有效时间。');
  }
  return value.trim();
}

function assertUniqueDescriptors(values: readonly DataPlatformModelSyncDescriptor[]): void {
  const keys = new Set<string>();
  for (const value of values) {
    const key = resourceKey(value);
    if (keys.has(key)) throw new Error(`数据中台模型同步清单存在重复资源：${key}`);
    keys.add(key);
  }
}

function resourceKey(value: Pick<DataPlatformModelSyncDescriptor, 'kind' | 'resourceId'>): string {
  return createDataPlatformModelResourceKey(value.kind, value.resourceId);
}

function compareDescriptors(
  left: Pick<DataPlatformModelSyncDescriptor, 'kind' | 'resourceId'>,
  right: Pick<DataPlatformModelSyncDescriptor, 'kind' | 'resourceId'>,
): number {
  return compareResourceKeys(resourceKey(left), resourceKey(right));
}

function compareResourceKeys(left: string, right: string): number {
  const [leftKind, leftId] = left.split(':');
  const [rightKind, rightId] = right.split(':');
  if (leftKind !== rightKind) return leftKind.localeCompare(rightKind);
  const leftNumber = BigInt(leftId);
  const rightNumber = BigInt(rightId);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

async function hashRuntimeMetadata(metadataPath: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as unknown;
  if (!isPlainObject(parsed)) throw new Error('数据中台模型 meta.json 根节点必须是对象。');
  const runtimeMetadata = { ...parsed };
  delete runtimeMetadata.thumbnail;
  return hashText(stableStringify(runtimeMetadata));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
