import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ProjectSkyboxAssetEntry } from '../types.js';
import type { DataPlatformSkyboxRecord } from './dataPlatformSkyboxContract.js';

// 源码测试直接执行 .ts，Electron 构建产物执行 .js；按当前扩展名复用 Task1 契约，避免复制校验逻辑。
const require = createRequire(import.meta.url);
type DataPlatformSkyboxContractModule = typeof import('./dataPlatformSkyboxContract.js');
type AssetRegistryModule = typeof import('./assetRegistry.js');
type SkyboxAssetStoreModule = typeof import('./skyboxAssetStore.js');
const runtimeExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const {
  assertUniqueSkyboxRecords,
  MAX_SKYBOX_FILE_BYTES,
  normalizePositiveIdentifier,
} = require(`./dataPlatformSkyboxContract${runtimeExtension}`) as DataPlatformSkyboxContractModule;
const { encodeAssetUrl } = require(`./assetRegistry${runtimeExtension}`) as AssetRegistryModule;
const { inspectSkyboxAssetFile } = require(`./skyboxAssetStore${runtimeExtension}`) as SkyboxAssetStoreModule;

export const DATA_PLATFORM_SKYBOX_INDEX_VERSION = 1 as const;
export const MAX_SKYBOX_SYNC_DOWNLOAD_BYTES = 8 * 1024 ** 3;

const INDEX_FILE_NAME = 'data-platform-skybox-index.json';
const INDEX_ROOT_KEYS = new Set(['version', 'entries']);
const INDEX_ENTRY_KEYS = new Set([
  'resourceId',
  'displayName',
  'relativePath',
  'format',
  'fileSizeBytes',
  'sha256',
  'revision',
  'status',
  'syncedAt',
]);
const STABLE_RELATIVE_PATH_PATTERN = /^Assets\/Skyboxes\/DataPlatform\/Skybox-([1-9]\d{0,63})\/skybox\.(hdr|exr)$/;
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_REVISION_PATTERN = /^[1-9]\d*$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

export type DataPlatformSkyboxIndexEntry = {
  resourceId: string;
  displayName: string;
  relativePath: string;
  format: DataPlatformSkyboxRecord['format'];
  fileSizeBytes: number;
  sha256: string;
  revision: string;
  status: 'active' | 'orphaned';
  syncedAt: string;
};

export type DataPlatformSkyboxIndex = {
  version: typeof DATA_PLATFORM_SKYBOX_INDEX_VERSION;
  entries: DataPlatformSkyboxIndexEntry[];
};

export type DataPlatformSkyboxDownloadPlan = {
  record: DataPlatformSkyboxRecord;
  relativePath: string;
};

export type DataPlatformSkyboxPlan = {
  downloads: DataPlatformSkyboxDownloadPlan[];
  nextIndex: DataPlatformSkyboxIndex;
  changedResourceIds: string[];
  orphanedResourceIds: string[];
};

export type Index = DataPlatformSkyboxIndex;
export type DownloadPlan = DataPlatformSkyboxDownloadPlan;
export type Plan = DataPlatformSkyboxPlan;

export type DataPlatformSkyboxAssetDiagnosticCode =
  | 'missing'
  | 'symbolic-link'
  | 'not-file'
  | 'invalid-file'
  | 'format-mismatch'
  | 'size-mismatch'
  | 'io-error'
  | 'invalid-remote-entry'
  | 'duplicate-resource-id';

export type DataPlatformSkyboxAssetDiagnostic = {
  resourceId: string;
  availability: 'active' | 'orphaned';
  code: DataPlatformSkyboxAssetDiagnosticCode;
  message: string;
};

export type IndexedDataPlatformSkyboxesResult = {
  skyboxes: ProjectSkyboxAssetEntry[];
  orphanedSkyboxes: ProjectSkyboxAssetEntry[];
  errors: DataPlatformSkyboxAssetDiagnostic[];
};

export type SkyboxAssetDiagnosticReporter = (error: DataPlatformSkyboxAssetDiagnostic) => void;

export function getDataPlatformSkyboxIndexPath(editorRoot: string): string {
  return path.join(editorRoot, '.babylon-editor', INDEX_FILE_NAME);
}

export function getDataPlatformSkyboxRelativePath(
  id: string,
  format: DataPlatformSkyboxRecord['format'],
): string {
  const normalizedId = normalizePositiveIdentifier(id, '天空盒资源 ID');
  if (normalizedId !== id) throw new Error('天空盒资源 ID 必须是规范正十进制字符串。');
  if (format !== 'hdr' && format !== 'exr') throw new Error('天空盒 format 仅支持 hdr 或 exr。');
  return `Assets/Skyboxes/DataPlatform/Skybox-${id}/skybox.${format}`;
}

export function resolveSkyboxIndexEntryPath(editorRoot: string, relativePath: string): string {
  parseStableRelativePath(relativePath);
  const targetPath = path.resolve(editorRoot, ...relativePath.split('/'));
  if (!isPathInside(editorRoot, targetPath)) {
    throw new Error('天空盒索引 relativePath 超出 editorRoot 允许目录。');
  }
  return targetPath;
}

export async function readDataPlatformSkyboxIndex(editorRoot: string): Promise<DataPlatformSkyboxIndex> {
  const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`天空盒索引 JSON 已损坏：${message}`);
    }
    return normalizeDataPlatformSkyboxIndex(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: DATA_PLATFORM_SKYBOX_INDEX_VERSION, entries: [] };
    }
    throw error;
  }
}

/**
 * 将索引中的缓存文件转换为编辑器天空盒资产。索引整体损坏直接失败；单条缓存损坏只进入 errors。
 */
export async function listIndexedDataPlatformSkyboxes(
  editorRoot: string,
  index?: DataPlatformSkyboxIndex,
): Promise<IndexedDataPlatformSkyboxesResult> {
  const normalizedIndex = index === undefined
    ? await readDataPlatformSkyboxIndex(editorRoot)
    : normalizeDataPlatformSkyboxIndex(index);
  const skyboxes: ProjectSkyboxAssetEntry[] = [];
  const orphanedSkyboxes: ProjectSkyboxAssetEntry[] = [];
  const errors: DataPlatformSkyboxAssetDiagnostic[] = [];
  const entries = [...normalizedIndex.entries]
    .sort((left, right) => compareResourceIds(left.resourceId, right.resourceId));

  for (const entry of entries) {
    const filePath = resolveSkyboxIndexEntryPath(editorRoot, entry.relativePath);
    let stat;
    try {
      const ancestorIssue = await inspectIndexEntryAncestors(editorRoot, filePath);
      if (ancestorIssue) {
        errors.push(createAssetDiagnostic(entry, ancestorIssue));
        continue;
      }
      stat = await fs.lstat(filePath);
    } catch (error) {
      errors.push(createAssetDiagnostic(
        entry,
        isNodeError(error) && error.code === 'ENOENT' ? 'missing' : 'io-error',
      ));
      continue;
    }

    if (stat.isSymbolicLink()) {
      errors.push(createAssetDiagnostic(entry, 'symbolic-link'));
      continue;
    }
    if (!stat.isFile()) {
      errors.push(createAssetDiagnostic(entry, 'not-file'));
      continue;
    }

    let inspection;
    try {
      inspection = await inspectSkyboxAssetFile(filePath);
    } catch {
      errors.push(createAssetDiagnostic(entry, 'invalid-file'));
      continue;
    }
    if (inspection.format !== entry.format) {
      errors.push(createAssetDiagnostic(entry, 'format-mismatch'));
      continue;
    }
    if (inspection.fileSizeBytes !== entry.fileSizeBytes) {
      errors.push(createAssetDiagnostic(entry, 'size-mismatch'));
      continue;
    }

    const asset = createIndexedSkyboxAsset(entry, filePath);
    if (entry.status === 'active') skyboxes.push(asset);
    else orphanedSkyboxes.push(asset);
  }

  return { skyboxes, orphanedSkyboxes, errors };
}

/**
 * 合并项目本地与 active 数据中台天空盒。重复远端 resourceId 的全部候选都会被剔除并报告诊断。
 */
export function mergeSkyboxAssets(
  local: readonly ProjectSkyboxAssetEntry[],
  remoteActive: readonly ProjectSkyboxAssetEntry[],
  reportError: SkyboxAssetDiagnosticReporter = () => undefined,
): ProjectSkyboxAssetEntry[] {
  const remoteByResourceId = new Map<string, ProjectSkyboxAssetEntry[]>();
  for (const asset of remoteActive) {
    const resourceId = asset.dataPlatformResourceId;
    if (typeof resourceId !== 'string' || !/^[1-9]\d{0,63}$/.test(resourceId)) {
      reportError(createMergeDiagnostic('unknown', 'invalid-remote-entry'));
      continue;
    }
    const candidates = remoteByResourceId.get(resourceId) ?? [];
    candidates.push(asset);
    remoteByResourceId.set(resourceId, candidates);
  }

  const uniqueRemote: ProjectSkyboxAssetEntry[] = [];
  for (const [resourceId, candidates] of remoteByResourceId) {
    if (candidates.length !== 1) {
      reportError(createMergeDiagnostic(resourceId, 'duplicate-resource-id'));
      continue;
    }
    const candidate = candidates[0];
    if (!isTrustedRemoteSkyboxCandidate(candidate, resourceId)) {
      reportError(createMergeDiagnostic(resourceId, 'invalid-remote-entry'));
      continue;
    }
    uniqueRemote.push(candidate);
  }

  return [...local, ...uniqueRemote].sort(compareSkyboxAssets);
}

export async function writeDataPlatformSkyboxIndexFile(
  targetPath: string,
  index: DataPlatformSkyboxIndex,
): Promise<void> {
  const normalized = normalizeDataPlatformSkyboxIndex(index);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

export function buildDataPlatformSkyboxPlan(
  remote: readonly DataPlatformSkyboxRecord[],
  current: DataPlatformSkyboxIndex,
  existingPaths: ReadonlySet<string>,
  syncedAt = new Date().toISOString(),
): DataPlatformSkyboxPlan {
  const normalizedSyncedAt = normalizeIsoTimestamp(syncedAt, 'syncedAt');
  assertUniqueSkyboxRecords(remote);
  const normalizedCurrent = normalizeDataPlatformSkyboxIndex(current);
  const currentById = new Map(normalizedCurrent.entries.map((entry) => [entry.resourceId, entry]));
  const remoteIds = new Set(remote.map((record) => record.id));
  const sortedRemote = [...remote].sort((left, right) => compareResourceIds(left.id, right.id));
  const downloads: DataPlatformSkyboxDownloadPlan[] = [];
  const nextEntries: DataPlatformSkyboxIndexEntry[] = [];
  const changedResourceIds: string[] = [];
  const orphanedResourceIds: string[] = [];

  for (const record of sortedRemote) {
    const relativePath = getDataPlatformSkyboxRelativePath(record.id, record.format);
    const existing = currentById.get(record.id);
    const nextEntry = createActiveIndexEntry(record, relativePath, normalizedSyncedAt);
    const contentMatches = existing !== undefined
      && existing.sha256 === record.sha256
      && existing.format === record.format
      && existing.fileSizeBytes === record.fileSizeBytes;
    const physicalFileExists = existing !== undefined && existingPaths.has(existing.relativePath);

    if (!existing || !contentMatches || !physicalFileExists) {
      downloads.push({ record: cloneSkyboxRecord(record), relativePath });
    }
    if (!existing || !hasSameSemanticState(existing, nextEntry)) {
      changedResourceIds.push(record.id);
    }
    nextEntries.push(nextEntry);
  }

  for (const entry of normalizedCurrent.entries) {
    if (remoteIds.has(entry.resourceId)) continue;
    const orphanedEntry: DataPlatformSkyboxIndexEntry = {
      ...entry,
      status: 'orphaned',
      syncedAt: normalizedSyncedAt,
    };
    if (!hasSameSemanticState(entry, orphanedEntry)) {
      changedResourceIds.push(entry.resourceId);
    }
    orphanedResourceIds.push(entry.resourceId);
    nextEntries.push(orphanedEntry);
  }

  nextEntries.sort((left, right) => compareResourceIds(left.resourceId, right.resourceId));
  changedResourceIds.sort(compareResourceIds);
  orphanedResourceIds.sort(compareResourceIds);

  const nextIndex = normalizeDataPlatformSkyboxIndex({
    version: DATA_PLATFORM_SKYBOX_INDEX_VERSION,
    entries: nextEntries,
  });
  assertDownloadLimit(downloads);

  return {
    downloads,
    nextIndex,
    changedResourceIds,
    orphanedResourceIds,
  };
}

async function inspectIndexEntryAncestors(
  editorRoot: string,
  filePath: string,
): Promise<'symbolic-link' | 'not-file' | null> {
  const root = path.resolve(editorRoot);
  const parentRelativePath = path.relative(root, path.dirname(filePath));
  let currentPath = root;
  for (const segment of parentRelativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stat = await fs.lstat(currentPath);
    if (stat.isSymbolicLink()) return 'symbolic-link';
    if (!stat.isDirectory()) return 'not-file';
  }
  return null;
}

function createIndexedSkyboxAsset(
  entry: DataPlatformSkyboxIndexEntry,
  filePath: string,
): ProjectSkyboxAssetEntry {
  return {
    id: `data-platform-skybox:${entry.resourceId}`,
    name: path.basename(filePath),
    displayName: entry.displayName,
    path: filePath,
    sourceUrl: encodeAssetUrl(filePath),
    assetRevision: entry.sha256,
    packagePath: path.dirname(filePath),
    kind: 'skybox',
    libraryKind: 'skybox',
    format: entry.format,
    fileSizeBytes: entry.fileSizeBytes,
    source: 'data-platform',
    availability: entry.status,
    dataPlatformResourceId: entry.resourceId,
    dataPlatformRevision: entry.revision,
    fileSha256: entry.sha256,
  };
}

function createAssetDiagnostic(
  entry: DataPlatformSkyboxIndexEntry,
  code: DataPlatformSkyboxAssetDiagnosticCode,
): DataPlatformSkyboxAssetDiagnostic {
  const reasonByCode: Record<DataPlatformSkyboxAssetDiagnosticCode, string> = {
    missing: '缓存文件缺失',
    'symbolic-link': '缓存路径是 symbolic link',
    'not-file': '缓存路径不是普通文件',
    'invalid-file': '缓存文件格式校验失败',
    'format-mismatch': '缓存文件格式与索引不一致',
    'size-mismatch': '缓存文件大小与索引不一致',
    'io-error': '缓存文件读取失败',
    'invalid-remote-entry': '远端候选元数据无效',
    'duplicate-resource-id': '远端候选 resourceId 重复',
  };
  return {
    resourceId: entry.resourceId,
    availability: entry.status,
    code,
    message: `数据中台天空盒 ${entry.resourceId}：${reasonByCode[code]}。`,
  };
}

function isTrustedRemoteSkyboxCandidate(
  asset: ProjectSkyboxAssetEntry,
  resourceId: string,
): boolean {
  return asset.source === 'data-platform'
    && asset.availability === 'active'
    && asset.id === `data-platform-skybox:${resourceId}`
    && typeof asset.dataPlatformRevision === 'string'
    && POSITIVE_REVISION_PATTERN.test(asset.dataPlatformRevision)
    && typeof asset.fileSha256 === 'string'
    && LOWERCASE_SHA256_PATTERN.test(asset.fileSha256)
    && asset.assetRevision === asset.fileSha256;
}

function createMergeDiagnostic(
  resourceId: string,
  code: 'invalid-remote-entry' | 'duplicate-resource-id',
): DataPlatformSkyboxAssetDiagnostic {
  const message = code === 'duplicate-resource-id'
    ? '远端候选 resourceId 重复，已保守剔除全部重复候选。'
    : '远端候选缺少可信的 active 数据中台来源元数据，已剔除。';
  return {
    resourceId,
    availability: 'active',
    code,
    message: `数据中台天空盒 ${resourceId}：${message}`,
  };
}

const SKYBOX_ASSET_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
  usage: 'sort',
});

function compareSkyboxAssets(left: ProjectSkyboxAssetEntry, right: ProjectSkyboxAssetEntry): number {
  const displayNameOrder = SKYBOX_ASSET_COLLATOR.compare(
    normalizeSkyboxSortText(left.displayName),
    normalizeSkyboxSortText(right.displayName),
  );
  if (displayNameOrder !== 0) return displayNameOrder;

  const sourceOrder = getSkyboxSourceOrder(left.source) - getSkyboxSourceOrder(right.source);
  if (sourceOrder !== 0) return sourceOrder;

  const idOrder = SKYBOX_ASSET_COLLATOR.compare(
    normalizeSkyboxSortText(left.id),
    normalizeSkyboxSortText(right.id),
  );
  if (idOrder !== 0) return idOrder;
  return SKYBOX_ASSET_COLLATOR.compare(
    normalizeSkyboxSortText(left.path),
    normalizeSkyboxSortText(right.path),
  );
}

function normalizeSkyboxSortText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function getSkyboxSourceOrder(source: ProjectSkyboxAssetEntry['source']): number {
  return source === 'project' ? 0 : 1;
}

function normalizeDataPlatformSkyboxIndex(value: unknown): DataPlatformSkyboxIndex {
  if (!isPlainObject(value)) throw new Error('数据中台天空盒索引必须是普通对象。');
  assertExactOwnKeys(value, INDEX_ROOT_KEYS, '数据中台天空盒索引');

  const version = readOwnDataField(value, 'version', '数据中台天空盒索引');
  if (version !== DATA_PLATFORM_SKYBOX_INDEX_VERSION) {
    throw new Error('数据中台天空盒索引版本不受支持。');
  }

  const rawEntries = readOwnDataField(value, 'entries', '数据中台天空盒索引');
  if (!isPlainArray(rawEntries)) throw new Error('数据中台天空盒索引 entries 必须是普通数组。');

  const entries: DataPlatformSkyboxIndexEntry[] = [];
  const resourceIds = new Set<string>();
  const relativePaths = new Set<string>();
  for (let index = 0; index < rawEntries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawEntries, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`数据中台天空盒索引 entries 第 ${index + 1} 项必须是自有 data property。`);
    }
    const entry = normalizeIndexEntry(descriptor.value, index);
    if (resourceIds.has(entry.resourceId)) {
      throw new Error(`数据中台天空盒索引存在重复 resourceId：${entry.resourceId}`);
    }
    if (relativePaths.has(entry.relativePath)) {
      throw new Error(`数据中台天空盒索引存在重复 relativePath：${entry.relativePath}`);
    }
    resourceIds.add(entry.resourceId);
    relativePaths.add(entry.relativePath);

    const expectedPath = getDataPlatformSkyboxRelativePath(entry.resourceId, entry.format);
    if (entry.relativePath !== expectedPath) {
      throw new Error(`数据中台天空盒索引 relativePath 与 resourceId/format 不一致：${entry.relativePath}`);
    }
    entries.push(entry);
  }

  for (const key of Reflect.ownKeys(rawEntries)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key, rawEntries.length)) {
      throw new Error(`数据中台天空盒索引 entries 包含未知字段：${String(key)}`);
    }
  }

  return { version: DATA_PLATFORM_SKYBOX_INDEX_VERSION, entries };
}

function normalizeIndexEntry(value: unknown, index: number): DataPlatformSkyboxIndexEntry {
  const label = `数据中台天空盒索引第 ${index + 1} 个条目`;
  if (!isPlainObject(value)) throw new Error(`${label}必须是普通对象。`);
  assertExactOwnKeys(value, INDEX_ENTRY_KEYS, label);

  const resourceIdValue = readOwnDataField(value, 'resourceId', label);
  const resourceId = normalizePositiveIdentifier(resourceIdValue, `${label} resourceId`);
  if (resourceIdValue !== resourceId) throw new Error(`${label} resourceId 必须是规范正十进制字符串。`);

  const displayNameValue = readOwnDataField(value, 'displayName', label);
  if (typeof displayNameValue !== 'string' || !displayNameValue.trim() || displayNameValue.trim() !== displayNameValue) {
    throw new Error(`${label} displayName 必须是规范非空字符串。`);
  }

  const relativePathValue = readOwnDataField(value, 'relativePath', label);
  if (typeof relativePathValue !== 'string') throw new Error(`${label} relativePath 必须是字符串。`);
  parseStableRelativePath(relativePathValue);

  const formatValue = readOwnDataField(value, 'format', label);
  if (formatValue !== 'hdr' && formatValue !== 'exr') throw new Error(`${label} format 仅支持 hdr 或 exr。`);

  const fileSizeBytesValue = readOwnDataField(value, 'fileSizeBytes', label);
  if (!Number.isSafeInteger(fileSizeBytesValue)
    || (fileSizeBytesValue as number) < 1
    || (fileSizeBytesValue as number) > MAX_SKYBOX_FILE_BYTES) {
    throw new Error(`${label} fileSizeBytes 必须在 1 到 ${MAX_SKYBOX_FILE_BYTES} 之间。`);
  }

  const sha256Value = readOwnDataField(value, 'sha256', label);
  if (typeof sha256Value !== 'string' || !LOWERCASE_SHA256_PATTERN.test(sha256Value)) {
    throw new Error(`${label} sha256 必须是 64 位小写十六进制字符串。`);
  }

  const revisionValue = readOwnDataField(value, 'revision', label);
  if (typeof revisionValue !== 'string' || !POSITIVE_REVISION_PATTERN.test(revisionValue)) {
    throw new Error(`${label} revision 必须是正十进制字符串。`);
  }

  const statusValue = readOwnDataField(value, 'status', label);
  if (statusValue !== 'active' && statusValue !== 'orphaned') {
    throw new Error(`${label} status 仅支持 active 或 orphaned。`);
  }

  return {
    resourceId,
    displayName: displayNameValue,
    relativePath: relativePathValue,
    format: formatValue,
    fileSizeBytes: fileSizeBytesValue as number,
    sha256: sha256Value,
    revision: revisionValue,
    status: statusValue,
    syncedAt: normalizeIsoTimestamp(readOwnDataField(value, 'syncedAt', label), `${label} syncedAt`),
  };
}

function createActiveIndexEntry(
  record: DataPlatformSkyboxRecord,
  relativePath: string,
  syncedAt: string,
): DataPlatformSkyboxIndexEntry {
  return {
    resourceId: record.id,
    displayName: record.displayName,
    relativePath,
    format: record.format,
    fileSizeBytes: record.fileSizeBytes,
    sha256: record.sha256,
    revision: record.revision,
    status: 'active',
    syncedAt,
  };
}

function cloneSkyboxRecord(record: DataPlatformSkyboxRecord): DataPlatformSkyboxRecord {
  return {
    id: record.id,
    displayName: record.displayName,
    fileName: record.fileName,
    fileUrl: record.fileUrl,
    format: record.format,
    fileSizeBytes: record.fileSizeBytes,
    sha256: record.sha256,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

function hasSameSemanticState(
  left: DataPlatformSkyboxIndexEntry,
  right: DataPlatformSkyboxIndexEntry,
): boolean {
  return left.resourceId === right.resourceId
    && left.displayName === right.displayName
    && left.relativePath === right.relativePath
    && left.format === right.format
    && left.fileSizeBytes === right.fileSizeBytes
    && left.sha256 === right.sha256
    && left.revision === right.revision
    && left.status === right.status;
}

function assertDownloadLimit(downloads: readonly DataPlatformSkyboxDownloadPlan[]): void {
  const maximum = BigInt(MAX_SKYBOX_SYNC_DOWNLOAD_BYTES);
  let total = 0n;
  for (const download of downloads) {
    total += BigInt(download.record.fileSizeBytes);
    if (total > maximum) throw new Error('数据中台天空盒本轮下载总量超过 8 GiB 上限。');
  }
}

function parseStableRelativePath(relativePath: unknown): {
  resourceId: string;
  format: DataPlatformSkyboxRecord['format'];
} {
  if (typeof relativePath !== 'string'
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || relativePath.includes('\\')) {
    throw new Error('天空盒索引 relativePath 不是允许的稳定相对路径。');
  }

  const match = STABLE_RELATIVE_PATH_PATTERN.exec(relativePath);
  if (!match) throw new Error('天空盒索引 relativePath 不是允许的稳定相对路径。');
  const resourceId = match[1];
  const format = match[2] as DataPlatformSkyboxRecord['format'];
  if (relativePath !== getDataPlatformSkyboxRelativePath(resourceId, format)) {
    throw new Error('天空盒索引 relativePath 不是允许的稳定相对路径。');
  }
  return { resourceId, format };
}

function normalizeIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error(`${label} 必须是完整 ISO timestamp。`);
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw new Error(`${label} 必须是完整 ISO timestamp。`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);

  const invalidDate = month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month);
  const invalidTime = hour > 23 || minute > 59 || second > 59;
  const invalidOffset = offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0);
  if (invalidDate || invalidTime || invalidOffset) {
    throw new Error(`${label} 必须是完整且有效的 ISO timestamp。`);
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function compareResourceIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertExactOwnKeys(value: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}缺少字段：${key}`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label}包含未知字段：${String(key)}`);
    }
  }
}

function readOwnDataField(value: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label}字段必须是自有数据属性：${key}`);
  }
  return descriptor.value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

/** dataPlatformTransfer 依赖 Electron net；纯索引模块保留与其 isPathInside 一致的最小实现。 */
function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
