import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ProjectModelAssetEntry } from '../types.js';
import { DEFAULT_ENVIRONMENT_MODEL_LENGTH_UNIT_INFO } from '../modelUnits.js';
import type { DataPlatformEnvironmentRecord } from './dataPlatformEnvironmentContract.js';

const require = createRequire(import.meta.url);
type AssetRegistryModule = typeof import('./assetRegistry.js');
type ModelPackageScannerModule = typeof import('./modelPackageScanner.js');
const runtimeExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const { encodeAssetUrl } = require(`./assetRegistry${runtimeExtension}`) as AssetRegistryModule;
const { inspectGlbModelFile } = require(`./modelPackageScanner${runtimeExtension}`) as ModelPackageScannerModule;

export const DATA_PLATFORM_ENVIRONMENT_INDEX_VERSION = 1 as const;
const INDEX_FILE_NAME = 'data-platform-environment-index.json';
const MANAGED_CACHE_PREFIX = '.babylon-editor/data-platform-cache/environments/';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^[1-9]\d{0,63}$/;
const SOURCE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

export type DataPlatformEnvironmentIndexEntry = {
  sourceKey: string;
  resourceId: string;
  displayName: string;
  relativePath: string;
  fileName: string;
  fileSizeBytes: number;
  fileSha256: string;
  fileRevision: string;
  runtimeRevision: string;
  lengthUnit: DataPlatformEnvironmentRecord['lengthUnit'];
  status: 'active' | 'stale' | 'deleted';
  syncedAt: string;
  lastUsedAt: string;
  warning: string | null;
};

export type DataPlatformEnvironmentIndex = {
  version: typeof DATA_PLATFORM_ENVIRONMENT_INDEX_VERSION;
  protocolVersion: string;
  sourceKey: string;
  manifestRevision: string;
  entries: DataPlatformEnvironmentIndexEntry[];
};

export type DataPlatformEnvironmentDownloadPlan = {
  record: DataPlatformEnvironmentRecord;
  relativePath: string;
};

export type DataPlatformEnvironmentPlan = {
  downloads: DataPlatformEnvironmentDownloadPlan[];
  nextIndex: DataPlatformEnvironmentIndex;
  changedResourceIds: string[];
  deletedResourceIds: string[];
};

export type IndexedDataPlatformEnvironmentsResult = {
  sourceKey: string | null;
  assets: ProjectModelAssetEntry[];
  staleAssets: ProjectModelAssetEntry[];
  errors: string[];
};

export function getDataPlatformEnvironmentIndexPath(editorRoot: string): string {
  return path.join(path.resolve(editorRoot), '.babylon-editor', INDEX_FILE_NAME);
}

export function getDataPlatformEnvironmentRelativePath(
  sourceKey: string,
  resourceId: string,
  fileRevision: string,
): string {
  assertSourceKey(sourceKey);
  assertDecimal(resourceId, '环境模型资源 ID');
  assertDecimal(fileRevision, '环境模型文件修订');
  return `${MANAGED_CACHE_PREFIX}${sourceKey}/${resourceId}/${fileRevision}/model.glb`;
}

export function resolveEnvironmentIndexEntryPath(editorRoot: string, relativePath: string): string {
  if (!isManagedRelativePath(relativePath)) throw new Error('环境模型缓存相对路径不受管理。');
  const root = path.resolve(editorRoot);
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('环境模型缓存路径越界。');
  return target;
}

/**
 * 校验环境模型受管路径的所有已存在父级，拒绝符号链接、Windows junction 和越界 realpath。
 */
export async function assertTrustedEnvironmentPath(
  editorRoot: string,
  targetPath: string,
  label: string,
): Promise<void> {
  const root = path.resolve(editorRoot);
  const target = path.resolve(targetPath);
  assertPathInsideOrEqual(root, target, label);
  const realRoot = await fs.realpath(root);
  const relative = path.relative(root, target);
  if (!relative) return;

  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}包含符号链接、junction 或 reparse point：${current}`);
    }
    const realCurrent = await fs.realpath(current);
    assertPathInsideOrEqual(realRoot, realCurrent, label);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label}的父路径不是目录：${current}`);
    }
  }
}

/** 创建环境模型受管目录，并在创建前后复核真实路径。 */
export async function ensureTrustedEnvironmentDirectory(
  editorRoot: string,
  directoryPath: string,
  label: string,
): Promise<void> {
  await assertTrustedEnvironmentPath(editorRoot, directoryPath, label);
  await fs.mkdir(directoryPath, { recursive: true });
  await assertTrustedEnvironmentPath(editorRoot, directoryPath, label);
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label}不是可信目录，可能包含符号链接、junction 或 reparse point。`);
  }
}

export async function readDataPlatformEnvironmentIndex(editorRoot: string): Promise<DataPlatformEnvironmentIndex> {
  const indexPath = getDataPlatformEnvironmentIndexPath(editorRoot);
  await assertTrustedEnvironmentPath(editorRoot, indexPath, '环境模型 Sidecar 索引');
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8')) as unknown;
    return normalizeDataPlatformEnvironmentIndex(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: DATA_PLATFORM_ENVIRONMENT_INDEX_VERSION, protocolVersion: '1', sourceKey: '', manifestRevision: '0', entries: [] };
    }
    throw error;
  }
}

export async function writeDataPlatformEnvironmentIndexFile(
  targetPath: string,
  index: DataPlatformEnvironmentIndex,
): Promise<void> {
  const normalized = normalizeDataPlatformEnvironmentIndex(index);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

export async function listIndexedDataPlatformEnvironments(
  editorRoot: string,
  index?: DataPlatformEnvironmentIndex,
): Promise<IndexedDataPlatformEnvironmentsResult> {
  const normalized = index ?? await readDataPlatformEnvironmentIndex(editorRoot);
  const assets: ProjectModelAssetEntry[] = [];
  const staleAssets: ProjectModelAssetEntry[] = [];
  const errors: string[] = [];
  for (const entry of normalized.entries) {
    if (entry.status === 'deleted') continue;
    const filePath = resolveEnvironmentIndexEntryPath(editorRoot, entry.relativePath);
    try {
      await assertTrustedEnvironmentPath(editorRoot, filePath, `数据中台环境模型 ${entry.resourceId} 缓存文件`);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('缓存路径不是普通文件。');
      if (stat.size !== entry.fileSizeBytes) throw new Error('缓存文件大小与索引不一致。');
      const [inspection, actualSha256] = await Promise.all([inspectGlbModelFile(filePath), hashFileSha256(filePath)]);
      if (inspection.fileSizeBytes !== entry.fileSizeBytes) throw new Error('GLB 校验大小与索引不一致。');
      if (actualSha256 !== entry.fileSha256) throw new Error('缓存文件 SHA-256 与索引不一致。');
      const asset = createEnvironmentAsset(entry, filePath);
      if (entry.status === 'active') assets.push(asset);
      else staleAssets.push(asset);
    } catch (error) {
      errors.push(`数据中台环境模型 ${entry.resourceId}：${toErrorMessage(error)}`);
    }
  }
  assets.sort(compareEnvironmentAssets);
  staleAssets.sort(compareEnvironmentAssets);
  return { sourceKey: normalized.sourceKey || null, assets, staleAssets, errors };
}

export function buildDataPlatformEnvironmentPlan(options: {
  sourceKey: string;
  protocolVersion: string;
  manifestRevision: string;
  records: readonly DataPlatformEnvironmentRecord[];
  current: DataPlatformEnvironmentIndex;
  existingPaths: ReadonlySet<string>;
  syncedAt?: string;
}): DataPlatformEnvironmentPlan {
  const sourceKey = options.sourceKey;
  assertSourceKey(sourceKey);
  const syncedAt = normalizeTimestamp(options.syncedAt ?? new Date().toISOString());
  const current = normalizeDataPlatformEnvironmentIndex(options.current);
  const currentEntries = current.sourceKey === sourceKey ? current.entries : [];
  const currentById = new Map(currentEntries.map((entry) => [entry.resourceId, entry]));
  const remoteIds = new Set(options.records.map((record) => record.id));
  const downloads: DataPlatformEnvironmentDownloadPlan[] = [];
  const entries: DataPlatformEnvironmentIndexEntry[] = [];
  const changedResourceIds: string[] = [];
  const deletedResourceIds: string[] = [];

  for (const record of [...options.records].sort((a, b) => compareDecimalStrings(a.id, b.id))) {
    const previous = currentById.get(record.id);
    if (record.fileStatus !== 'GLB_READY') {
      if (previous) {
        entries.push({ ...previous, status: 'stale', syncedAt, warning: record.warning ?? `远端状态：${record.fileStatus}` });
        if (previous.status !== 'stale' || previous.warning !== record.warning) changedResourceIds.push(record.id);
      }
      continue;
    }
    const relativePath = getDataPlatformEnvironmentRelativePath(sourceKey, record.id, record.fileRevision!);
    const next = createActiveEntry(sourceKey, record, relativePath, syncedAt, previous?.lastUsedAt ?? syncedAt);
    const hasContent = previous
      && previous.fileSha256 === next.fileSha256
      && previous.fileSizeBytes === next.fileSizeBytes
      && previous.relativePath === relativePath
      && options.existingPaths.has(relativePath);
    if (!hasContent) downloads.push({ record: { ...record }, relativePath });
    if (!previous || !hasSameSemanticState(previous, next)) changedResourceIds.push(record.id);
    entries.push(next);
  }

  for (const previous of currentEntries) {
    if (remoteIds.has(previous.resourceId)) continue;
    entries.push({ ...previous, status: 'deleted', syncedAt, warning: '远端资源已删除。' });
    deletedResourceIds.push(previous.resourceId);
    if (previous.status !== 'deleted') changedResourceIds.push(previous.resourceId);
  }
  entries.sort((a, b) => compareDecimalStrings(a.resourceId, b.resourceId));
  changedResourceIds.sort(compareDecimalStrings);
  deletedResourceIds.sort(compareDecimalStrings);
  return {
    downloads,
    nextIndex: normalizeDataPlatformEnvironmentIndex({
      version: DATA_PLATFORM_ENVIRONMENT_INDEX_VERSION,
      protocolVersion: options.protocolVersion,
      sourceKey,
      manifestRevision: options.manifestRevision,
      entries,
    }),
    changedResourceIds,
    deletedResourceIds,
  };
}

function createActiveEntry(
  sourceKey: string,
  record: DataPlatformEnvironmentRecord,
  relativePath: string,
  syncedAt: string,
  lastUsedAt: string,
): DataPlatformEnvironmentIndexEntry {
  return {
    sourceKey,
    resourceId: record.id,
    displayName: record.displayName,
    relativePath,
    fileName: record.fileName!,
    fileSizeBytes: record.fileSizeBytes!,
    fileSha256: record.fileSha256!,
    fileRevision: record.fileRevision!,
    runtimeRevision: record.runtimeRevision!,
    lengthUnit: record.lengthUnit,
    status: 'active',
    syncedAt,
    lastUsedAt,
    warning: record.warning,
  };
}


export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function createEnvironmentAsset(entry: DataPlatformEnvironmentIndexEntry, filePath: string): ProjectModelAssetEntry {
  const unitScaleToMeters = entry.lengthUnit === 'meter' ? 1 : entry.lengthUnit === 'centimeter' ? 0.01 : 0.001;
  return {
    id: `data-platform-environment:${entry.sourceKey}:${entry.resourceId}`,
    name: entry.fileName,
    displayName: entry.displayName,
    path: filePath,
    sourceUrl: encodeAssetUrl(filePath),
    assetRevision: entry.runtimeRevision,
    packagePath: path.dirname(filePath),
    kind: 'model',
    libraryKind: 'environment',
    lengthUnit: entry.lengthUnit ?? DEFAULT_ENVIRONMENT_MODEL_LENGTH_UNIT_INFO.lengthUnit,
    unitScaleToMeters,
    fileSizeBytes: entry.fileSizeBytes,
    source: 'data-platform',
    availability: entry.status === 'active' ? 'active' : 'stale',
    dataPlatformResourceId: entry.resourceId,
    dataPlatformResourceType: 'ENV_MODEL',
    dataPlatformSourceKey: entry.sourceKey,
    dataPlatformRevision: entry.runtimeRevision,
    dataPlatformFileRevision: entry.fileRevision,
    fileSha256: entry.fileSha256,
  };
}

function normalizeDataPlatformEnvironmentIndex(value: unknown): DataPlatformEnvironmentIndex {
  if (!isPlainObject(value) || value.version !== DATA_PLATFORM_ENVIRONMENT_INDEX_VERSION || !Array.isArray(value.entries)) {
    throw new Error('数据中台环境模型索引格式无效。');
  }
  const sourceKey = value.sourceKey === '' ? '' : readSourceKey(value.sourceKey);
  const protocolVersion = readNonEmptyString(value.protocolVersion, 'protocolVersion');
  const manifestRevision = readNonNegativeDecimal(value.manifestRevision, 'manifestRevision');
  const entries = value.entries.map(normalizeIndexEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (sourceKey && entry.sourceKey !== sourceKey) throw new Error('环境模型索引 entry sourceKey 与根节点不一致。');
    if (seen.has(entry.resourceId)) throw new Error(`环境模型索引存在重复资源 ID：${entry.resourceId}`);
    seen.add(entry.resourceId);
  }
  entries.sort((a, b) => compareDecimalStrings(a.resourceId, b.resourceId));
  return { version: DATA_PLATFORM_ENVIRONMENT_INDEX_VERSION, protocolVersion, sourceKey, manifestRevision, entries };
}

function normalizeIndexEntry(value: unknown): DataPlatformEnvironmentIndexEntry {
  if (!isPlainObject(value)) throw new Error('环境模型索引项格式无效。');
  const sourceKey = readSourceKey(value.sourceKey);
  const resourceId = readDecimal(value.resourceId, 'resourceId');
  const fileRevision = readDecimal(value.fileRevision, 'fileRevision');
  const relativePath = readNonEmptyString(value.relativePath, 'relativePath');
  if (relativePath !== getDataPlatformEnvironmentRelativePath(sourceKey, resourceId, fileRevision)) {
    throw new Error('环境模型索引 relativePath 与资源身份不一致。');
  }
  const status = value.status;
  if (status !== 'active' && status !== 'stale' && status !== 'deleted') throw new Error('环境模型索引 status 无效。');
  const fileSizeValue = value.fileSizeBytes;
  if (typeof fileSizeValue !== 'number' || !Number.isSafeInteger(fileSizeValue) || fileSizeValue <= 0 || fileSizeValue > 512 * 1024 * 1024) throw new Error('环境模型索引文件大小无效。');
  const fileSizeBytes = fileSizeValue;
  if (typeof value.fileSha256 !== 'string' || !SHA256_PATTERN.test(value.fileSha256)) throw new Error('环境模型索引 SHA-256 无效。');
  const lengthUnit = value.lengthUnit;
  if (lengthUnit !== 'meter' && lengthUnit !== 'centimeter' && lengthUnit !== 'millimeter') throw new Error('环境模型索引单位无效。');
  return {
    sourceKey,
    resourceId,
    displayName: readNonEmptyString(value.displayName, 'displayName'),
    relativePath,
    fileName: readNonEmptyString(value.fileName, 'fileName'),
    fileSizeBytes,
    fileSha256: value.fileSha256,
    fileRevision,
    runtimeRevision: readDecimal(value.runtimeRevision, 'runtimeRevision'),
    lengthUnit,
    status,
    syncedAt: normalizeTimestamp(value.syncedAt),
    lastUsedAt: normalizeTimestamp(value.lastUsedAt),
    warning: value.warning === null ? null : readNonEmptyString(value.warning, 'warning'),
  };
}

function hasSameSemanticState(a: DataPlatformEnvironmentIndexEntry, b: DataPlatformEnvironmentIndexEntry): boolean {
  return a.displayName === b.displayName && a.relativePath === b.relativePath && a.fileName === b.fileName
    && a.fileSizeBytes === b.fileSizeBytes && a.fileSha256 === b.fileSha256
    && a.fileRevision === b.fileRevision && a.runtimeRevision === b.runtimeRevision
    && a.lengthUnit === b.lengthUnit && a.status === b.status && a.warning === b.warning;
}

function assertPathInsideOrEqual(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}越过可信环境模型根目录。`);
  }
}

function isManagedRelativePath(value: string): boolean {
  return typeof value === 'string' && value.startsWith(MANAGED_CACHE_PREFIX) && !value.includes('\\')
    && !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}
function assertSourceKey(value: string): void { if (!SOURCE_KEY_PATTERN.test(value)) throw new Error('数据中台 sourceKey 必须是 SHA-256。'); }
function readSourceKey(value: unknown): string { if (typeof value !== 'string') throw new Error('sourceKey 无效。'); assertSourceKey(value); return value; }
function assertDecimal(value: string, label: string): void { if (!DECIMAL_PATTERN.test(value)) throw new Error(`${label}必须是正十进制字符串。`); }
function readDecimal(value: unknown, label: string): string { if (typeof value !== 'string') throw new Error(`${label}无效。`); assertDecimal(value, label); return value; }
function readNonNegativeDecimal(value: unknown, label: string): string { if (typeof value !== 'string' || !/^\d{1,64}$/.test(value)) throw new Error(`${label}无效。`); return value.replace(/^0+(?=\d)/, ''); }
function readNonEmptyString(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`); return value.trim(); }
function normalizeTimestamp(value: unknown): string { if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('环境模型索引时间无效。'); return new Date(value).toISOString(); }
function compareDecimalStrings(a: string, b: string): number { return a.length - b.length || a.localeCompare(b, 'en'); }
function compareEnvironmentAssets(a: ProjectModelAssetEntry, b: ProjectModelAssetEntry): number { return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, 'zh-CN'); }
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error; }
function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
