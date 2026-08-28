import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DataPlatformModelSyncProgress,
  ProjectAssetIndex,
  ProjectModelAssetEntry,
} from '../types.js';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO } from '../modelUnits.js';
import { encodeAssetUrl } from './assetRegistry.js';
import { normalizeDataPlatformSourceUrl } from './dataPlatformEnvironmentContract.js';
import {
  buildDataPlatformModelPlan,
  createDataPlatformModelResourceKey,
  createDataPlatformModelRuntimeRevision,
  DATA_PLATFORM_MODEL_INDEX_VERSION,
  getDataPlatformModelIndexPath,
  readDataPlatformModelIndex,
  writeDataPlatformModelIndexFile,
  type DataPlatformModelIndex,
  type DataPlatformModelIndexEntry,
  type DataPlatformModelSyncDescriptor,
} from './dataPlatformModelIndex.js';
import { scanModelPackage, validateGlbModelFile } from './modelPackageScanner.js';
import {
  assertPathInside,
  DataPlatformRollbackError,
  downloadRemoteFile,
  requestDataPlatformJson,
  type DownloadRemoteFileOptions,
  type DownloadRemoteFileResult,
} from './dataPlatformTransfer.js';

const MODEL_QUERY_PATH = 'api/v1/models/query';
const COMBO_MODEL_QUERY_PATH = 'api/v1/combo-models/query';
const MODEL_QUERY_PAGE_SIZE = 100;
const MAX_MODEL_QUERY_PAGES = 1_000;
const MAX_MODEL_RECORDS = 100_000;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_CONCURRENT_CACHE_CHECKS = 16;
const QUERY_TIMEOUT_MS = 20_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_MODEL_FILE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCRIPT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SYNC_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_200, 1_600] as const;
const WINDOWS_RENAME_RETRY_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const NO_THUMBNAIL_FINGERPRINT = createHash('sha256')
  .update('data-platform-model-thumbnail:none', 'utf8')
  .digest('hex');

const MIME_THUMBNAIL_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

type ModelSyncContext = {
  baseUrl: string;
  editorRoot: string;
  contextKey: string;
};

type ActiveModelSync = {
  runId: string;
  contextKey: string;
  controller: AbortController;
  promise: Promise<void>;
};

type ModelRemoteVersion = {
  package: string | null;
  file: string | null;
  metadata: string | null;
  scripts: string | null;
  thumbnail: string | null;
};

type NormalModelScript = {
  fileName: string | null;
  fileUrl: string;
  version: string | null;
};

type NormalModelRecord = {
  kind: 'model';
  id: string;
  name: string;
  fileName: string | null;
  fileUrl: string;
  metaFileUrl: string | null;
  thumbnailUrl: string | null;
  scripts: NormalModelScript[];
  remoteVersion: ModelRemoteVersion;
};

type ComboModelRecord = {
  kind: 'combo';
  id: string;
  name: string;
  fileName: string | null;
  fileUrl: string;
  thumbnailUrl: string | null;
  remoteVersion: ModelRemoteVersion;
};

type SyncModelRecord = NormalModelRecord | ComboModelRecord;

type PreparedPackage = {
  record: SyncModelRecord;
  descriptor: DataPlatformModelSyncDescriptor;
  packageRelativePath: string;
  packagePath: string;
  mainFilePath: string;
  metadataPath: string;
  thumbnailPath: string | null;
  scriptPaths: string[];
};

type ValidatedPackage = {
  prepared: PreparedPackage;
  stagedAsset: ProjectModelAssetEntry;
  indexEntry: DataPlatformModelIndexEntry;
};

type DownloadJob = {
  label: string;
  remoteUrl: string;
  destinationPath: string;
  kind: 'model' | 'metadata' | 'script' | 'thumbnail';
  preparedPackage: PreparedPackage;
};

type PromotionItem = {
  type: 'directory' | 'file';
  label: string;
  target: string;
  staged: string;
  backup: string;
};

type ModelSyncDependencies = {
  requestJson: typeof requestDataPlatformJson;
  downloadFile: (options: DownloadRemoteFileOptions) => Promise<DownloadRemoteFileResult>;
  readAssetIndex: (editorRoot: string) => Promise<ProjectAssetIndex>;
  now: () => Date;
  randomId: () => string;
};

export type ExecuteDataPlatformModelSyncOptions = {
  baseUrl: string;
  editorRoot: string;
  runId?: string;
  signal?: AbortSignal;
  dependencies?: Partial<ModelSyncDependencies>;
};

export type DataPlatformModelSyncSummary = {
  libraryChanged: boolean;
  runtimeChangedResourceKeys: string[];
  downloadedPackageCount: number;
  reusedPackageCount: number;
};

const DEFAULT_DEPENDENCIES: ModelSyncDependencies = {
  requestJson: requestDataPlatformJson,
  downloadFile: downloadRemoteFile,
  readAssetIndex: async (editorRoot) => {
    const { readProjectAssetIndex } = await import('./projectAssetStore.js');
    return readProjectAssetIndex(editorRoot);
  },
  now: () => new Date(),
  randomId: randomUUID,
};

let activeModelSync: ActiveModelSync | null = null;
let queuedModelSyncContext: ModelSyncContext | null = null;
let latestModelSyncProgress: DataPlatformModelSyncProgress | null = null;
let lastModelSyncContext: ModelSyncContext | null = null;
let modelSyncShuttingDown = false;
let browserWindowLoader: (() => Promise<typeof import('electron').BrowserWindow>) | null = null;

/** 启动普通/组合模型后台增量同步；切换工作区时取消旧任务并排队最新上下文。 */
export function startDataPlatformModelSync(baseUrl: string, editorRoot: string): boolean {
  if (modelSyncShuttingDown) return false;
  const context = createModelSyncContext(baseUrl, editorRoot);
  lastModelSyncContext = { ...context };
  if (activeModelSync) {
    if (
      activeModelSync.contextKey === context.contextKey
      && !activeModelSync.controller.signal.aborted
    ) return true;
    queuedModelSyncContext = context;
    if (!activeModelSync.controller.signal.aborted) activeModelSync.controller.abort();
    return true;
  }
  return launchModelSync(context);
}

export function retryDataPlatformModelSync(): boolean {
  if (activeModelSync || !lastModelSyncContext || modelSyncShuttingDown) return false;
  return launchModelSync(lastModelSyncContext);
}

export function getLatestDataPlatformModelSyncProgress(): DataPlatformModelSyncProgress | null {
  return latestModelSyncProgress
    ? {
        ...latestModelSyncProgress,
        runtimeChangedResourceKeys: [...(latestModelSyncProgress.runtimeChangedResourceKeys ?? [])],
      }
    : null;
}

export function clearDataPlatformModelSyncRetryContext(): void {
  lastModelSyncContext = null;
  queuedModelSyncContext = null;
}

export async function disposeDataPlatformModelSync(): Promise<void> {
  modelSyncShuttingDown = true;
  queuedModelSyncContext = null;
  const active = activeModelSync;
  if (!active) return;
  active.controller.abort();
  await active.promise;
}

function launchModelSync(context: ModelSyncContext): boolean {
  if (modelSyncShuttingDown || activeModelSync) return false;
  const runId = randomUUID();
  const controller = new AbortController();
  const promise = executeDataPlatformModelSync({
    baseUrl: context.baseUrl,
    editorRoot: context.editorRoot,
    runId,
    signal: controller.signal,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (activeModelSync?.runId === runId) activeModelSync = null;
      const queued = queuedModelSyncContext;
      queuedModelSyncContext = null;
      if (!modelSyncShuttingDown && queued) launchModelSync(queued);
    });
  activeModelSync = { runId, contextKey: context.contextKey, controller, promise };
  return true;
}

export async function executeDataPlatformModelSync(
  options: ExecuteDataPlatformModelSyncOptions,
): Promise<DataPlatformModelSyncSummary> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const baseUrl = normalizeDataPlatformSourceUrl(options.baseUrl);
  const editorRoot = path.resolve(options.editorRoot);
  const sourceKey = createDataPlatformModelSourceKey(baseUrl);
  const runId = normalizeRunId(options.runId ?? dependencies.randomId());
  const signal = options.signal ?? new AbortController().signal;
  let stagingRoot: string | null = null;
  let preserveStaging = false;
  let completedDownloads = 0;
  let totalDownloads = 0;

  updateModelSyncProgress({
    runId,
    phase: 'querying',
    completed: 0,
    total: 0,
    message: '正在查询数据中台普通模型…',
    error: null,
    libraryChanged: false,
    runtimeChangedResourceKeys: [],
  });

  try {
    const normalModels = await queryAllNormalModels(baseUrl, signal, dependencies.requestJson);
    updateModelSyncProgress({
      runId,
      phase: 'querying',
      completed: 0,
      total: 0,
      message: `已查询 ${normalModels.length} 个普通模型，正在查询组合模型…`,
      error: null,
      libraryChanged: false,
      runtimeChangedResourceKeys: [],
    });
    const comboModels = await queryAllComboModels(baseUrl, signal, dependencies.requestJson);
    const records: SyncModelRecord[] = [...normalModels, ...comboModels];
    assertUniqueModelRecords(records);
    assertNotAborted(signal);

    const [currentModelIndex, currentAssetIndex] = await Promise.all([
      readDataPlatformModelIndex(editorRoot),
      dependencies.readAssetIndex(editorRoot),
    ]);
    const currentEntries = currentModelIndex.sourceKey === sourceKey
      ? currentModelIndex.entries
      : [];
    const currentEntryByKey = new Map(currentEntries.map((entry) => [resourceKey(entry), entry]));
    const currentAssetByKey = createManagedAssetMap(currentAssetIndex.assets);
    const descriptors = records.map((record) => createSyncDescriptor(
      record,
      currentEntryByKey.get(resourceKey(record))?.packageRelativePath,
    ));
    const existingPackagePaths = await collectExistingPackagePaths(editorRoot, currentEntries);
    const existingAssetAvailability = await collectExistingAssetAvailability(
      editorRoot,
      currentAssetByKey,
      currentEntryByKey,
      existingPackagePaths,
    );
    const syncedAt = dependencies.now().toISOString();
    const plan = buildDataPlatformModelPlan({
      sourceKey,
      remote: descriptors,
      current: currentModelIndex,
      existingPackagePaths,
      existingAssetKeys: existingAssetAvailability.runtimeKeys,
      existingThumbnailKeys: existingAssetAvailability.thumbnailKeys,
      syncedAt,
    });
    const recordByKey = new Map(records.map((record) => [resourceKey(record), record]));

    stagingRoot = path.join(editorRoot, '.babylon-editor', `data-platform-model-sync-${runId}`);
    assertPathInside(editorRoot, stagingRoot, '模型同步暂存目录');
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.mkdir(stagingRoot, { recursive: true });

    const prepared = await prepareDownloadPlan(stagingRoot, plan.downloads, recordByKey);
    const jobs = createDownloadJobs(prepared);
    totalDownloads = jobs.length;
    let downloadedBytes = 0;
    const downloadProgressStep = Math.max(1, Math.ceil(Math.max(1, jobs.length) / 100));
    updateModelSyncProgress({
      runId,
      phase: 'downloading',
      completed: 0,
      total: jobs.length,
      message: jobs.length === 0
        ? `模型缓存已命中 ${plan.reused.length} 个资源包，无需下载。`
        : `正在下载 ${prepared.length} 个变化或待校验的模型资源包…`,
      error: null,
      libraryChanged: false,
      runtimeChangedResourceKeys: [],
    });

    await runWithConcurrency(jobs, MAX_CONCURRENT_DOWNLOADS, async (job) => {
      assertNotAborted(signal);
      const result = await dependencies.downloadFile({
        baseUrl,
        remoteUrl: job.remoteUrl,
        destinationPath: job.destinationPath,
        maxBytes: maxBytesForDownloadKind(job.kind),
        signal,
        timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
        context: `下载${job.label}`,
        onBytes: (bytes) => {
          downloadedBytes += bytes;
          if (downloadedBytes > MAX_SYNC_DOWNLOAD_BYTES) {
            throw new Error('模型同步下载总量超过 8 GB 限制。');
          }
        },
      });

      if (job.kind === 'thumbnail') {
        job.preparedPackage.thumbnailPath = await finalizeThumbnailPath(
          job.destinationPath,
          result.contentType,
          job.remoteUrl,
        );
      }

      completedDownloads += 1;
      if (completedDownloads === jobs.length || completedDownloads % downloadProgressStep === 0) {
        updateModelSyncProgress({
          runId,
          phase: 'downloading',
          completed: completedDownloads,
          total: jobs.length,
          message: `已下载 ${completedDownloads}/${jobs.length} 个模型文件。`,
          error: null,
          libraryChanged: false,
          runtimeChangedResourceKeys: [],
        });
      }
    });

    updateModelSyncProgress({
      runId,
      phase: 'validating',
      completed: completedDownloads,
      total: jobs.length,
      message: prepared.length === 0 ? '模型包无需重新校验。' : '正在校验变化模型包并计算稳定内容版本…',
      error: null,
      libraryChanged: false,
      runtimeChangedResourceKeys: [],
    });
    const validated = await validatePreparedPackages(prepared, syncedAt, signal);

    const finalEntries: DataPlatformModelIndexEntry[] = [];
    const finalManagedAssets: ProjectModelAssetEntry[] = [];
    const packagesToPromote: ValidatedPackage[] = [];
    const runtimeChangedKeys = new Set(plan.removed.map(resourceKey));
    let reusedAfterDownloadCount = 0;

    for (const reuse of plan.reused) {
      const key = resourceKey(reuse.descriptor);
      const currentAsset = currentAssetByKey.get(key);
      if (!currentAsset) throw new Error(`模型同步索引与资产索引不一致：缺少 ${key}`);
      finalEntries.push(reuse.nextEntry);
      finalManagedAssets.push(refreshIndexedAssetMetadata(currentAsset, reuse.nextEntry));
    }

    for (const item of validated) {
      const key = resourceKey(item.indexEntry);
      const previousEntry = currentEntryByKey.get(key);
      const currentAsset = currentAssetByKey.get(key);
      const cachedRuntimeAvailable = previousEntry !== undefined
        && currentAsset !== undefined
        && existingPackagePaths.has(previousEntry.packageRelativePath)
        && existingAssetAvailability.runtimeKeys.has(key);
      const runtimeChanged = !cachedRuntimeAvailable
        || previousEntry.runtimeRevision !== item.indexEntry.runtimeRevision
        || currentAsset.assetRevision !== item.indexEntry.runtimeRevision;
      const thumbnailChanged = !previousEntry
        || previousEntry.thumbnailRevision !== item.indexEntry.thumbnailRevision
        || !existingAssetAvailability.thumbnailKeys.has(key);
      const packageChanged = runtimeChanged || thumbnailChanged;
      const nextEntry = mergeStableIndexEntry(previousEntry, item.indexEntry);
      finalEntries.push(nextEntry);

      if (packageChanged) {
        packagesToPromote.push(item);
        const targetPackagePath = resolvePackageRelativePath(editorRoot, item.prepared.packageRelativePath);
        finalManagedAssets.push(relocateAssetEntry(
          item.stagedAsset,
          item.prepared.packagePath,
          targetPackagePath,
          nextEntry,
        ));
      } else if (currentAsset) {
        reusedAfterDownloadCount += 1;
        finalManagedAssets.push(refreshIndexedAssetMetadata(currentAsset, nextEntry));
      }

      if (runtimeChanged) runtimeChangedKeys.add(key);
    }

    finalEntries.sort(compareIndexEntries);
    finalManagedAssets.sort(compareProjectAssets);
    const unmanagedAssets = currentAssetIndex.assets
      .filter((asset) => getManagedAssetResourceKey(asset) === null)
      .sort(compareProjectAssets);
    const finalAssetIndex: ProjectAssetIndex = {
      version: 2,
      assets: [...unmanagedAssets, ...finalManagedAssets].sort(compareProjectAssets),
    };
    const finalModelIndex: DataPlatformModelIndex = {
      version: DATA_PLATFORM_MODEL_INDEX_VERSION,
      sourceKey,
      entries: finalEntries,
    };
    const assetIndexChanged = !areProjectAssetIndexesEqual(currentAssetIndex, finalAssetIndex);
    const sidecarChanged = !areModelIndexesEqual(currentModelIndex, finalModelIndex);
    const libraryChanged = assetIndexChanged || packagesToPromote.length > 0;
    const runtimeChangedResourceKeys = [...runtimeChangedKeys].sort(compareResourceKeys);

    const stagedAssetIndexPath = path.join(stagingRoot, 'indexes', 'asset-index.json');
    const stagedModelIndexPath = path.join(stagingRoot, 'indexes', 'data-platform-model-index.json');
    if (assetIndexChanged) {
      await fs.mkdir(path.dirname(stagedAssetIndexPath), { recursive: true });
      await fs.writeFile(stagedAssetIndexPath, `${JSON.stringify(finalAssetIndex, null, 2)}\n`, 'utf8');
    }
    if (sidecarChanged) {
      await writeDataPlatformModelIndexFile(stagedModelIndexPath, finalModelIndex);
    }

    updateModelSyncProgress({
      runId,
      phase: 'promoting',
      completed: completedDownloads,
      total: jobs.length,
      message: libraryChanged || sidecarChanged
        ? '正在原子提交变化模型包和索引…'
        : '模型文件和索引均无变化，无需提交。',
      error: null,
      libraryChanged: false,
      runtimeChangedResourceKeys: [],
    });
    if (libraryChanged || sidecarChanged) {
      await promoteModelChanges({
        editorRoot,
        stagingRoot,
        packages: packagesToPromote,
        stagedAssetIndexPath: assetIndexChanged ? stagedAssetIndexPath : null,
        stagedModelIndexPath: sidecarChanged ? stagedModelIndexPath : null,
        signal,
      });
    }

    await fs.rm(stagingRoot, { recursive: true, force: true });
    stagingRoot = null;
    const summary: DataPlatformModelSyncSummary = {
      libraryChanged,
      runtimeChangedResourceKeys,
      downloadedPackageCount: prepared.length,
      reusedPackageCount: plan.reused.length + reusedAfterDownloadCount,
    };
    updateModelSyncProgress({
      runId,
      phase: 'completed',
      completed: jobs.length,
      total: jobs.length,
      message: libraryChanged
        ? `模型增量同步完成：普通 ${normalModels.length}、组合 ${comboModels.length}，下载校验 ${prepared.length} 个包，复用 ${summary.reusedPackageCount} 个包。`
        : `模型缓存无变化：普通 ${normalModels.length}、组合 ${comboModels.length}，场景无需重新加载或合批。`,
      error: null,
      libraryChanged,
      runtimeChangedResourceKeys,
    });
    return summary;
  } catch (error) {
    preserveStaging = error instanceof DataPlatformRollbackError;
    if (stagingRoot && !preserveStaging) {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    const normalized = signal.aborted
      ? new Error('数据中台模型同步已取消。')
      : error;
    updateModelSyncProgress({
      runId,
      phase: 'failed',
      completed: completedDownloads,
      total: totalDownloads,
      message: '数据中台模型同步失败，已保留原模型库。',
      error: toErrorMessage(normalized),
      libraryChanged: false,
      runtimeChangedResourceKeys: [],
    });
    throw normalized;
  }
}

export function createDataPlatformModelSourceKey(baseUrl: string): string {
  return createHash('sha256')
    .update(normalizeDataPlatformSourceUrl(baseUrl), 'utf8')
    .digest('hex');
}

function createModelSyncContext(baseUrl: string, editorRoot: string): ModelSyncContext {
  const normalizedBaseUrl = normalizeDataPlatformSourceUrl(baseUrl);
  const normalizedEditorRoot = path.resolve(editorRoot);
  const comparableRoot = process.platform === 'win32'
    ? normalizedEditorRoot.toLowerCase()
    : normalizedEditorRoot;
  return {
    baseUrl: normalizedBaseUrl,
    editorRoot: normalizedEditorRoot,
    contextKey: `${createDataPlatformModelSourceKey(normalizedBaseUrl)}:${comparableRoot}`,
  };
}

async function queryAllNormalModels(
  baseUrl: string,
  signal: AbortSignal,
  requestJson: ModelSyncDependencies['requestJson'],
): Promise<NormalModelRecord[]> {
  const rawRecords = await queryAllPages(baseUrl, MODEL_QUERY_PATH, '普通模型', 'modelName', signal, requestJson);
  return rawRecords.map((value, index) => normalizeNormalModelRecord(value, index));
}

async function queryAllComboModels(
  baseUrl: string,
  signal: AbortSignal,
  requestJson: ModelSyncDependencies['requestJson'],
): Promise<ComboModelRecord[]> {
  const rawRecords = await queryAllPages(baseUrl, COMBO_MODEL_QUERY_PATH, '组合模型', 'comboModelName', signal, requestJson);
  return rawRecords.map((value, index) => normalizeComboModelRecord(value, index));
}

async function queryAllPages(
  baseUrl: string,
  endpointPath: string,
  label: string,
  nameField: 'modelName' | 'comboModelName',
  signal: AbortSignal,
  requestJson: ModelSyncDependencies['requestJson'],
): Promise<unknown[]> {
  const records: unknown[] = [];
  let stableTotal: number | null = null;
  for (let pageNum = 1; pageNum <= MAX_MODEL_QUERY_PAGES; pageNum += 1) {
    assertNotAborted(signal);
    const payload = await requestJson({
      baseUrl,
      endpointPath,
      body: {
        pageNum,
        pageSize: MODEL_QUERY_PAGE_SIZE,
        [nameField]: '',
        excludeIds: [],
      },
      signal,
      timeoutMs: QUERY_TIMEOUT_MS,
      context: `查询数据中台${label}`,
    });
    const page = normalizePagedResponse(payload, label);
    if (page.pageNum !== pageNum) {
      throw new Error(`数据中台${label}响应 pageNum 与请求不一致：请求 ${pageNum}，响应 ${page.pageNum}。`);
    }
    if (page.pageSize !== MODEL_QUERY_PAGE_SIZE) {
      throw new Error(`数据中台${label}响应 pageSize 与请求不一致：请求 ${MODEL_QUERY_PAGE_SIZE}，响应 ${page.pageSize}。`);
    }
    if (stableTotal === null) stableTotal = page.total;
    else if (page.total !== stableTotal) throw new Error(`数据中台${label}分页 total 在查询过程中发生变化。`);

    if (page.records.length === 0) {
      if (records.length === stableTotal) return records;
      throw new Error(`数据中台${label}分页在未取完 total=${stableTotal} 时返回空页。`);
    }
    records.push(...page.records);
    if (records.length > MAX_MODEL_RECORDS || records.length > stableTotal) {
      throw new Error(`数据中台${label}累计记录数超过 total=${stableTotal} 或 ${MAX_MODEL_RECORDS} 项上限。`);
    }
    if (records.length === stableTotal) {
      return records;
    }
  }
  throw new Error(`数据中台${label}分页超过 ${MAX_MODEL_QUERY_PAGES} 页限制。`);
}

function normalizePagedResponse(value: unknown, label: string): {
  records: unknown[];
  total: number;
  pageNum: number;
  pageSize: number;
} {
  if (!isPlainObject(value)) throw new Error(`数据中台${label}响应结构不正确。`);
  if (value.success !== true) {
    const message = normalizeOptionalString(value.message) ?? `数据中台${label}查询失败。`;
    throw new Error(message);
  }
  const data = value.data;
  if (!isPlainObject(data) || !Array.isArray(data.records)) {
    throw new Error(`数据中台${label}响应缺少 data.records。`);
  }
  const pageSize = normalizePageInteger(data.pageSize, `${label} pageSize`, 1, MODEL_QUERY_PAGE_SIZE);
  if (data.records.length > pageSize) {
    throw new Error(`数据中台${label}响应 records 数量超过 pageSize。`);
  }
  return {
    records: data.records,
    total: normalizePageInteger(data.total, `${label} total`, 0, MAX_MODEL_RECORDS),
    pageNum: normalizePageInteger(data.pageNum, `${label} pageNum`, 1, MAX_MODEL_QUERY_PAGES),
    pageSize,
  };
}

function normalizeNormalModelRecord(value: unknown, index: number): NormalModelRecord {
  const record = requireRecord(value, '普通模型', index);
  const id = normalizeRequiredId(record.id, '普通模型', index);
  const packageVersion = readRemoteVersionToken(record, [
    'packageRevision', 'modelRevision', 'resourceRevision', 'revision', 'updatedAt', 'updateTime',
  ]);
  const scriptsVersion = readRemoteVersionToken(record, [
    'scriptsRevision', 'scriptRevision', 'scriptsUpdatedAt', 'scriptUpdatedAt',
  ]);
  const scripts = normalizeModelScripts(record, index, scriptsVersion);
  return {
    kind: 'model',
    id,
    name: normalizeOptionalString(record.modelName) ?? `模型-${id}`,
    fileName: normalizeOptionalString(record.fileName),
    fileUrl: normalizeRequiredUrl(record.fileUrl, '普通模型', index),
    metaFileUrl: normalizeOptionalString(record.metaFileUrl),
    thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
    scripts,
    remoteVersion: {
      package: packageVersion,
      file: readRemoteVersionToken(record, [
        'fileSha256', 'fileHash', 'fileRevision', 'fileUpdatedAt', 'fileEtag',
      ]),
      metadata: readRemoteVersionToken(record, [
        'metaFileSha256', 'metaSha256', 'metaFileRevision', 'metaRevision', 'metaUpdatedAt',
      ]),
      scripts: scriptsVersion,
      thumbnail: readRemoteVersionToken(record, [
        'thumbnailSha256', 'thumbnailHash', 'thumbnailRevision', 'thumbnailUpdatedAt',
      ]),
    },
  };
}

function normalizeComboModelRecord(value: unknown, index: number): ComboModelRecord {
  const record = requireRecord(value, '组合模型', index);
  const id = normalizeRequiredId(record.id, '组合模型', index);
  const packageVersion = readRemoteVersionToken(record, [
    'packageRevision', 'comboModelRevision', 'resourceRevision', 'revision', 'updatedAt', 'updateTime',
  ]);
  return {
    kind: 'combo',
    id,
    name: normalizeOptionalString(record.comboModelName) ?? `组合-${id}`,
    fileName: normalizeOptionalString(record.fileName),
    fileUrl: normalizeRequiredUrl(record.fileUrl, '组合模型', index),
    thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
    remoteVersion: {
      package: packageVersion,
      file: readRemoteVersionToken(record, [
        'fileSha256', 'fileHash', 'fileRevision', 'fileUpdatedAt', 'fileEtag',
      ]),
      metadata: null,
      scripts: null,
      thumbnail: readRemoteVersionToken(record, [
        'thumbnailSha256', 'thumbnailHash', 'thumbnailRevision', 'thumbnailUpdatedAt',
      ]),
    },
  };
}

function normalizeModelScripts(
  record: Record<string, unknown>,
  index: number,
  collectionVersion: string | null,
): NormalModelScript[] {
  const scripts: NormalModelScript[] = [];
  const seenUrls = new Set<string>();
  const append = (fileName: unknown, fileUrl: unknown, version: string | null) => {
    const url = normalizeOptionalString(fileUrl);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    scripts.push({ fileName: normalizeOptionalString(fileName), fileUrl: url, version });
  };

  if (Array.isArray(record.scriptFiles)) {
    for (const item of record.scriptFiles) {
      if (!isPlainObject(item)) throw new Error(`数据中台普通模型第 ${index + 1} 项 scriptFiles 无效。`);
      append(
        item.fileName,
        item.fileUrl,
        readRemoteVersionToken(item, ['fileSha256', 'fileHash', 'revision', 'fileRevision', 'updatedAt'])
          ?? collectionVersion,
      );
    }
  }

  // 新接口列表为权威来源；只有列表没有有效项时才读取旧单脚本兼容字段。
  if (scripts.length === 0) {
    const legacyNames = splitLegacyScriptField(record.scriptFileName);
    const legacyUrls = splitLegacyScriptField(record.scriptFileUrl);
    if (legacyUrls.length > 1) {
      legacyUrls.forEach((url, legacyIndex) => append(legacyNames[legacyIndex] ?? null, url, collectionVersion));
    } else {
      append(legacyNames[0] ?? record.scriptFileName, legacyUrls[0] ?? record.scriptFileUrl, collectionVersion);
    }
  }
  return scripts;
}

function splitLegacyScriptField(value: unknown): string[] {
  const normalized = normalizeOptionalString(value);
  return normalized
    ? normalized.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];
}

function createSyncDescriptor(
  record: SyncModelRecord,
  existingPackageRelativePath?: string,
): DataPlatformModelSyncDescriptor {
  return {
    kind: record.kind,
    resourceId: record.id,
    displayName: record.name,
    packageRelativePath: existingPackageRelativePath ?? createPackageRelativePath(record),
    contentFingerprint: createRuntimeRemoteFingerprint(record),
    thumbnailFingerprint: createThumbnailRemoteFingerprint(record),
  };
}

function createRuntimeRemoteFingerprint(record: SyncModelRecord): string | null {
  const packageVersion = record.remoteVersion.package;
  const runtimeScripts = record.kind === 'model'
    ? createRuntimeScriptFingerprintEntries(record.scripts, record.remoteVersion.scripts)
    : [];
  const runtimeResourcesHaveVersions = packageVersion !== null || (
    record.remoteVersion.file !== null
    && (record.kind === 'combo' || record.metaFileUrl === null || record.remoteVersion.metadata !== null)
    && runtimeScripts.every((script) => script.version !== null)
  );
  if (!runtimeResourcesHaveVersions) return null;

  return hashFingerprint({
    kind: record.kind,
    packageVersion,
    file: {
      name: record.fileName,
      url: record.fileUrl,
      version: record.remoteVersion.file,
    },
    metadata: record.kind === 'model'
      ? { url: record.metaFileUrl, version: record.remoteVersion.metadata }
      : null,
    scripts: runtimeScripts,
  });
}

function createRuntimeScriptFingerprintEntries(
  scripts: readonly NormalModelScript[],
  collectionVersion: string | null,
): Array<{ name: string; url: string; version: string | null }> {
  const usedNames = new Set<string>();
  const result: Array<{ name: string; url: string; version: string | null }> = [];
  scripts.forEach((script, index) => {
    const name = normalizeOptionalTypeScriptFileName(script.fileName, script.fileUrl, index, usedNames);
    if (!name) return;
    result.push({ name, url: script.fileUrl, version: script.version ?? collectionVersion });
  });
  return result;
}

function createThumbnailRemoteFingerprint(record: SyncModelRecord): string | null {
  if (!record.thumbnailUrl) return NO_THUMBNAIL_FINGERPRINT;
  const version = record.remoteVersion.thumbnail ?? record.remoteVersion.package;
  // 旧接口没有缩略图版本时使用 URL 作为展示缓存身份；运行时资源仍按严格规则回退下载校验。
  return hashFingerprint({ url: record.thumbnailUrl, version });
}

function createPackageRelativePath(record: SyncModelRecord): string {
  const prefix = record.kind === 'model' ? 'Model' : 'Combo';
  const directoryName = `${prefix}-${record.id}-${sanitizePathSegment(record.name)}`;
  return record.kind === 'combo'
    ? `Assets/Models/ComboModels/${directoryName}`
    : `Assets/Models/${directoryName}`;
}

function readRemoteVersionToken(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const normalized = normalizeVersionToken(record[field]);
    if (normalized) return `${field}:${normalized}`;
  }
  return null;
}

function normalizeVersionToken(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized && normalized.length <= 2_048 ? normalized : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function hashFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

async function prepareDownloadPlan(
  stagingRoot: string,
  descriptors: readonly DataPlatformModelSyncDescriptor[],
  recordByKey: ReadonlyMap<string, SyncModelRecord>,
): Promise<PreparedPackage[]> {
  const packagesRoot = path.join(stagingRoot, 'packages');
  await fs.mkdir(packagesRoot, { recursive: true });
  return descriptors.map((descriptor) => {
    const record = recordByKey.get(resourceKey(descriptor));
    if (!record) throw new Error(`模型同步下载计划缺少远端记录：${resourceKey(descriptor)}`);
    const packagePath = path.join(packagesRoot, ...descriptor.packageRelativePath.split('/'));
    assertPathInside(stagingRoot, packagePath, '模型包暂存路径');
    const mainFileName = normalizeModelFileName(record.fileName, record.fileUrl, record.id);
    return {
      record,
      descriptor,
      packageRelativePath: descriptor.packageRelativePath,
      packagePath,
      mainFilePath: path.join(packagePath, mainFileName),
      metadataPath: path.join(packagePath, 'meta.json'),
      thumbnailPath: null,
      scriptPaths: [],
    };
  });
}

function createDownloadJobs(packages: PreparedPackage[]): DownloadJob[] {
  const jobs: DownloadJob[] = [];
  for (const prepared of packages) {
    const label = `${modelKindLabel(prepared.record.kind)}“${prepared.record.name}”`;
    jobs.push({
      label: `${label}主文件`,
      remoteUrl: prepared.record.fileUrl,
      destinationPath: prepared.mainFilePath,
      kind: 'model',
      preparedPackage: prepared,
    });

    if (prepared.record.kind === 'model' && prepared.record.metaFileUrl) {
      jobs.push({
        label: `${label} meta.json`,
        remoteUrl: prepared.record.metaFileUrl,
        destinationPath: prepared.metadataPath,
        kind: 'metadata',
        preparedPackage: prepared,
      });
    }

    if (prepared.record.kind === 'model') {
      const usedNames = new Set<string>();
      prepared.record.scripts.forEach((script, index) => {
        const fileName = normalizeOptionalTypeScriptFileName(script.fileName, script.fileUrl, index, usedNames);
        if (!fileName) return;
        const destinationPath = path.join(prepared.packagePath, fileName);
        prepared.scriptPaths.push(destinationPath);
        jobs.push({
          label: `${label}脚本 ${fileName}`,
          remoteUrl: script.fileUrl,
          destinationPath,
          kind: 'script',
          preparedPackage: prepared,
        });
      });
    }

    if (prepared.record.thumbnailUrl) {
      const extension = thumbnailExtensionFromUrl(prepared.record.thumbnailUrl);
      jobs.push({
        label: `${label}缩略图`,
        remoteUrl: prepared.record.thumbnailUrl,
        destinationPath: path.join(prepared.packagePath, `thumbnail${extension ?? '.download'}`),
        kind: 'thumbnail',
        preparedPackage: prepared,
      });
    }
  }
  return jobs;
}

async function finalizeThumbnailPath(
  destinationPath: string,
  contentType: string,
  remoteUrl: string,
): Promise<string> {
  const currentExtension = path.extname(destinationPath).toLowerCase();
  if (THUMBNAIL_EXTENSIONS.has(currentExtension)) return destinationPath;
  const inferredExtension = MIME_THUMBNAIL_EXTENSIONS[contentType] ?? thumbnailExtensionFromUrl(remoteUrl);
  if (!inferredExtension || !THUMBNAIL_EXTENSIONS.has(inferredExtension)) {
    throw new Error('数据中台缩略图扩展名或 Content-Type 不受支持。');
  }
  const finalPath = path.join(path.dirname(destinationPath), `thumbnail${inferredExtension}`);
  await fs.rename(destinationPath, finalPath);
  return finalPath;
}

async function validatePreparedPackages(
  packages: PreparedPackage[],
  syncedAt: string,
  signal: AbortSignal,
): Promise<ValidatedPackage[]> {
  const validated: ValidatedPackage[] = [];
  for (const prepared of packages) {
    assertNotAborted(signal);
    await normalizeLocalMetadata(prepared);
    await validateModelFile(prepared.mainFilePath);
    const scanResult = await scanModelPackage(prepared.packagePath);
    if (!scanResult.asset) {
      throw new Error(`${modelKindLabel(prepared.record.kind)}“${prepared.record.name}”校验失败：${scanResult.skipped?.reason ?? '无法扫描模型包。'}`);
    }
    const scriptPaths = [...new Set([
      ...prepared.scriptPaths,
      ...(scanResult.asset.scriptPaths ?? []),
    ])];
    const revision = await createDataPlatformModelRuntimeRevision({
      modelPath: prepared.mainFilePath,
      metadataPath: prepared.metadataPath,
      scriptPaths,
      thumbnailPath: prepared.thumbnailPath,
    });
    const stagedAsset: ProjectModelAssetEntry = {
      ...scanResult.asset,
      scriptPaths,
      scriptAssets: scriptPaths.map((scriptPath) => ({
        path: scriptPath,
        sourceUrl: encodeAssetUrl(scriptPath),
        name: path.basename(scriptPath),
      })),
      displayName: prepared.record.name,
      assetRevision: revision.runtimeRevision,
      kind: 'model',
      libraryKind: 'model',
    };
    validated.push({
      prepared,
      stagedAsset,
      indexEntry: {
        ...prepared.descriptor,
        runtimeRevision: revision.runtimeRevision,
        fileRevision: revision.fileRevision,
        metadataRevision: revision.metadataRevision,
        scriptRevision: revision.scriptRevision,
        thumbnailRevision: revision.thumbnailRevision,
        syncedAt,
      },
    });
  }
  return validated;
}

async function normalizeLocalMetadata(prepared: PreparedPackage): Promise<void> {
  let metadata: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(prepared.metadataPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) throw new Error('meta.json 根节点必须是对象。');
    metadata = parsed;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw new Error(`${modelKindLabel(prepared.record.kind)}“${prepared.record.name}” meta.json 无效：${toErrorMessage(error)}`);
    }
  }
  const metadataLengthUnit = metadata.lengthUnit;
  if (
    metadataLengthUnit === undefined
    || metadataLengthUnit === null
    || (typeof metadataLengthUnit === 'string' && !metadataLengthUnit.trim())
  ) {
    metadata.lengthUnit = DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit;
  }
  if (prepared.thumbnailPath) metadata.thumbnail = path.basename(prepared.thumbnailPath);
  await fs.mkdir(path.dirname(prepared.metadataPath), { recursive: true });
  await fs.writeFile(prepared.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function validateModelFile(filePath: string): Promise<void> {
  const extension = path.extname(filePath).toLowerCase();
  if (!MODEL_EXTENSIONS.has(extension)) throw new Error(`模型扩展名不受支持：${extension || '无扩展名'}`);
  if (extension === '.glb') {
    if (!await validateGlbModelFile(filePath)) {
      throw new Error(`GLB 文件结构无效或已损坏：${path.basename(filePath)}`);
    }
    return;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (!isPlainObject(parsed) || !isPlainObject(parsed.asset)) throw new Error('缺少 glTF asset 节点。');
  } catch (error) {
    throw new Error(`glTF 文件无效：${path.basename(filePath)}（${toErrorMessage(error)}）`);
  }
}

function relocateAssetEntry(
  asset: ProjectModelAssetEntry,
  stagedPackagePath: string,
  targetPackagePath: string,
  indexEntry: DataPlatformModelIndexEntry,
): ProjectModelAssetEntry {
  const relocate = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const relative = path.relative(stagedPackagePath, value);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`暂存资产路径无法迁移：${value}`);
    }
    return path.join(targetPackagePath, relative);
  };
  const finalPath = relocate(asset.path);
  if (!finalPath) throw new Error('暂存资产缺少主模型路径。');
  const finalScriptPaths = asset.scriptPaths
    ?.map((item) => relocate(item))
    .filter((item): item is string => Boolean(item));
  const finalThumbnailPath = relocate(asset.thumbnailPath);
  return {
    ...asset,
    id: finalPath,
    path: finalPath,
    sourceUrl: encodeAssetUrl(finalPath),
    assetRevision: indexEntry.runtimeRevision,
    displayName: indexEntry.displayName,
    packagePath: targetPackagePath,
    metadataPath: relocate(asset.metadataPath),
    thumbnailPath: finalThumbnailPath,
    thumbnailUrl: finalThumbnailPath ? encodeAssetUrl(finalThumbnailPath) : undefined,
    scriptPaths: finalScriptPaths,
    scriptAssets: finalScriptPaths?.map((scriptPath) => ({
      path: scriptPath,
      sourceUrl: encodeAssetUrl(scriptPath),
      name: path.basename(scriptPath),
    })),
  };
}

function refreshIndexedAssetMetadata(
  asset: ProjectModelAssetEntry,
  entry: DataPlatformModelIndexEntry,
): ProjectModelAssetEntry {
  return {
    ...asset,
    displayName: entry.displayName,
    assetRevision: entry.runtimeRevision,
  };
}

function mergeStableIndexEntry(
  previous: DataPlatformModelIndexEntry | undefined,
  next: DataPlatformModelIndexEntry,
): DataPlatformModelIndexEntry {
  return previous && areIndexEntriesSemanticallyEqual(previous, next) ? previous : next;
}

async function collectExistingPackagePaths(
  editorRoot: string,
  entries: readonly DataPlatformModelIndexEntry[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const entry of entries) {
    const packagePath = resolvePackageRelativePath(editorRoot, entry.packageRelativePath);
    try {
      const stat = await fs.lstat(packagePath);
      if (!stat.isSymbolicLink() && stat.isDirectory()) existing.add(entry.packageRelativePath);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    }
  }
  return existing;
}

function createManagedAssetMap(assets: readonly ProjectModelAssetEntry[]): Map<string, ProjectModelAssetEntry> {
  const result = new Map<string, ProjectModelAssetEntry>();
  for (const asset of assets) {
    const key = getManagedAssetResourceKey(asset);
    if (!key) continue;
    if (result.has(key)) throw new Error(`项目资产索引存在重复的数据中台模型：${key}`);
    result.set(key, asset);
  }
  return result;
}

async function collectExistingAssetAvailability(
  editorRoot: string,
  assets: ReadonlyMap<string, ProjectModelAssetEntry>,
  entries: ReadonlyMap<string, DataPlatformModelIndexEntry>,
  existingPackagePaths: ReadonlySet<string>,
): Promise<{ runtimeKeys: Set<string>; thumbnailKeys: Set<string> }> {
  const runtimeKeys = new Set<string>();
  const thumbnailKeys = new Set<string>();
  await runWithConcurrency([...assets.entries()], MAX_CONCURRENT_CACHE_CHECKS, async ([key, asset]) => {
    const entry = entries.get(key);
    if (!entry || asset.assetRevision !== entry.runtimeRevision || !existingPackagePaths.has(entry.packageRelativePath)) {
      return;
    }
    const expectedPackagePath = resolvePackageRelativePath(editorRoot, entry.packageRelativePath);
    if (!isSameLocalPath(asset.packagePath ?? path.dirname(asset.path), expectedPackagePath)) return;
    if (!asset.metadataPath) return;
    const runtimePaths = [...new Set([
      asset.path,
      asset.metadataPath,
      ...(asset.scriptPaths ?? []),
      ...(asset.scriptAssets?.map((script) => script.path) ?? []),
    ])];
    if (!await arePackageFilesAvailable(expectedPackagePath, runtimePaths)) return;
    runtimeKeys.add(key);

    if (entry.thumbnailFingerprint === NO_THUMBNAIL_FINGERPRINT) {
      thumbnailKeys.add(key);
      return;
    }
    if (
      asset.thumbnailPath
      && await arePackageFilesAvailable(expectedPackagePath, [asset.thumbnailPath])
    ) {
      thumbnailKeys.add(key);
    }
  });
  return { runtimeKeys, thumbnailKeys };
}

async function arePackageFilesAvailable(packagePath: string, filePaths: readonly string[]): Promise<boolean> {
  if (filePaths.length === 0 || filePaths.some((filePath) => !isPathInsideDirectory(packagePath, filePath))) {
    return false;
  }
  return (await Promise.all(filePaths.map(isFilePath))).every(Boolean);
}

function isPathInsideDirectory(directoryPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function getManagedAssetResourceKey(asset: ProjectModelAssetEntry): string | null {
  const packageName = path.basename(asset.packagePath ?? path.dirname(asset.path));
  const match = /^(Model|Combo)-(\d{1,64})(?:-|$)/i.exec(packageName);
  if (!match) return null;
  return createDataPlatformModelResourceKey(match[1].toLowerCase() === 'combo' ? 'combo' : 'model', match[2]);
}

function resolvePackageRelativePath(editorRoot: string, relativePath: string): string {
  const target = path.resolve(editorRoot, ...relativePath.split('/'));
  assertPathInside(editorRoot, target, '数据中台模型包路径');
  return target;
}

function getProjectAssetIndexPath(editorRoot: string): string {
  return path.join(path.resolve(editorRoot), '.babylon-editor', 'asset-index.json');
}

function areProjectAssetIndexesEqual(left: ProjectAssetIndex, right: ProjectAssetIndex): boolean {
  const normalize = (index: ProjectAssetIndex) => ({
    version: 2,
    assets: [...index.assets].sort(compareProjectAssets),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function areModelIndexesEqual(left: DataPlatformModelIndex, right: DataPlatformModelIndex): boolean {
  return JSON.stringify({ ...left, entries: [...left.entries].sort(compareIndexEntries) })
    === JSON.stringify({ ...right, entries: [...right.entries].sort(compareIndexEntries) });
}

function areIndexEntriesSemanticallyEqual(
  left: DataPlatformModelIndexEntry,
  right: DataPlatformModelIndexEntry,
): boolean {
  return left.kind === right.kind
    && left.resourceId === right.resourceId
    && left.displayName === right.displayName
    && left.packageRelativePath === right.packageRelativePath
    && left.contentFingerprint === right.contentFingerprint
    && left.thumbnailFingerprint === right.thumbnailFingerprint
    && left.runtimeRevision === right.runtimeRevision
    && left.fileRevision === right.fileRevision
    && left.metadataRevision === right.metadataRevision
    && left.scriptRevision === right.scriptRevision
    && left.thumbnailRevision === right.thumbnailRevision;
}

async function promoteModelChanges(options: {
  editorRoot: string;
  stagingRoot: string;
  packages: readonly ValidatedPackage[];
  stagedAssetIndexPath: string | null;
  stagedModelIndexPath: string | null;
  signal: AbortSignal;
}): Promise<void> {
  const backupRoot = path.join(options.stagingRoot, 'rollback');
  const items: PromotionItem[] = options.packages.map((item) => ({
    type: 'directory',
    label: `${modelKindLabel(item.prepared.record.kind)} ${item.prepared.record.id}`,
    target: resolvePackageRelativePath(options.editorRoot, item.prepared.packageRelativePath),
    staged: item.prepared.packagePath,
    backup: path.join(backupRoot, ...item.prepared.packageRelativePath.split('/')),
  }));
  if (options.stagedAssetIndexPath) {
    items.push({
      type: 'file',
      label: '模型资产索引',
      target: getProjectAssetIndexPath(options.editorRoot),
      staged: options.stagedAssetIndexPath,
      backup: path.join(backupRoot, '.babylon-editor', 'asset-index.json'),
    });
  }
  if (options.stagedModelIndexPath) {
    items.push({
      type: 'file',
      label: '模型 Sidecar 索引',
      target: getDataPlatformModelIndexPath(options.editorRoot),
      staged: options.stagedModelIndexPath,
      backup: path.join(backupRoot, '.babylon-editor', 'data-platform-model-index.json'),
    });
  }
  const states = items.map((item) => ({ item, previousMoved: false, stagedMoved: false }));
  await fs.mkdir(backupRoot, { recursive: true });
  try {
    for (const state of states) {
      assertNotAborted(options.signal);
      assertPathInside(options.editorRoot, state.item.target, `${state.item.label}目标`);
      await fs.mkdir(path.dirname(state.item.target), { recursive: true });
      if (await pathExists(state.item.target)) {
        await fs.mkdir(path.dirname(state.item.backup), { recursive: true });
        await renamePathWithWindowsRetry(state.item.target, state.item.backup);
        state.previousMoved = true;
      }
      await renamePathWithWindowsRetry(state.item.staged, state.item.target);
      state.stagedMoved = true;
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const state of [...states].reverse()) {
      try {
        if (state.stagedMoved && await pathExists(state.item.target)) {
          await fs.rm(state.item.target, { recursive: state.item.type === 'directory', force: true });
        }
        if (state.previousMoved && await pathExists(state.item.backup)) {
          await fs.mkdir(path.dirname(state.item.target), { recursive: true });
          await renamePathWithWindowsRetry(state.item.backup, state.item.target);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${state.item.label}：${toErrorMessage(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new DataPlatformRollbackError(
        `${toErrorMessage(error)}；模型增量同步回滚不完整：${rollbackErrors.join('；')}；已保留恢复目录：${backupRoot}`,
      );
    }
    throw error;
  }
}

function updateModelSyncProgress(progress: DataPlatformModelSyncProgress): void {
  latestModelSyncProgress = {
    ...progress,
    runtimeChangedResourceKeys: [...(progress.runtimeChangedResourceKeys ?? [])],
  };
  const loadBrowserWindow = browserWindowLoader ??= async () => (await import('electron')).BrowserWindow;
  void loadBrowserWindow().then((ElectronBrowserWindow) => {
    for (const window of ElectronBrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('data-platform:modelSyncProgress', latestModelSyncProgress);
      }
    }
  }).catch(() => undefined);
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown = null;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (firstError === null && nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        await worker(values[currentIndex]);
      } catch (error) {
        if (firstError === null) firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== null) throw firstError;
}

function normalizeModelFileName(fileName: string | null, fileUrl: string, id: string): string {
  const fromField = fileName ? sanitizeFileName(fileName) : '';
  const fromUrl = sanitizeFileName(fileNameFromUrl(fileUrl));
  const candidate = fromField || fromUrl || `model-${id}.glb`;
  const extension = path.extname(candidate).toLowerCase();
  if (!MODEL_EXTENSIONS.has(extension)) {
    throw new Error(`数据中台模型主文件扩展名不受支持：${candidate}`);
  }
  return candidate;
}

function isRuntimeTypeScriptFileName(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.endsWith('.ts') && !normalized.endsWith('.d.ts');
}

function normalizeOptionalTypeScriptFileName(
  fileName: string | null,
  fileUrl: string,
  index: number,
  usedNames: Set<string>,
): string | null {
  const fromField = fileName ? sanitizeFileName(fileName) : '';
  const fromUrl = sanitizeFileName(fileNameFromUrl(fileUrl));
  const candidate = [fromField, fromUrl].find(isRuntimeTypeScriptFileName);
  if (!candidate) return null;
  const base = path.parse(candidate).name || `script-${index + 1}`;
  let uniqueName = `${base}.ts`;
  let suffix = 2;
  while (usedNames.has(uniqueName.toLowerCase())) {
    uniqueName = `${base}-${suffix}.ts`;
    suffix += 1;
  }
  usedNames.add(uniqueName.toLowerCase());
  return uniqueName;
}

function thumbnailExtensionFromUrl(value: string): string | null {
  try {
    const extension = path.extname(new URL(value, 'http://placeholder.invalid/').pathname).toLowerCase();
    return THUMBNAIL_EXTENSIONS.has(extension) ? extension : null;
  } catch {
    return null;
  }
}

function fileNameFromUrl(value: string): string {
  try {
    return decodeURIComponent(path.posix.basename(new URL(value, 'http://placeholder.invalid/').pathname));
  } catch {
    return '';
  }
}

function sanitizeFileName(value: string): string {
  const baseName = path.posix.basename(value.replace(/\\/g, '/'));
  const normalized = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  return avoidWindowsReservedName(normalized);
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return avoidWindowsReservedName(normalized || '未命名');
}

function avoidWindowsReservedName(value: string): string {
  const stem = value.split('.', 1)[0]?.toUpperCase() ?? '';
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${value}` : value;
}

function maxBytesForDownloadKind(kind: DownloadJob['kind']): number {
  if (kind === 'model') return MAX_MODEL_FILE_BYTES;
  if (kind === 'metadata') return MAX_METADATA_FILE_BYTES;
  if (kind === 'script') return MAX_SCRIPT_FILE_BYTES;
  return MAX_THUMBNAIL_FILE_BYTES;
}

function modelKindLabel(kind: SyncModelRecord['kind']): string {
  return kind === 'model' ? '普通模型' : '组合模型';
}

function assertUniqueModelRecords(records: readonly SyncModelRecord[]): void {
  const keys = new Set<string>();
  for (const record of records) {
    const key = resourceKey(record);
    if (keys.has(key)) throw new Error(`数据中台${modelKindLabel(record.kind)}存在重复 ID：${record.id}`);
    keys.add(key);
  }
}

function resourceKey(value: Pick<SyncModelRecord, 'kind' | 'id'> | Pick<DataPlatformModelSyncDescriptor, 'kind' | 'resourceId'> | Pick<DataPlatformModelIndexEntry, 'kind' | 'resourceId'>): string {
  return 'id' in value
    ? createDataPlatformModelResourceKey(value.kind, value.id)
    : createDataPlatformModelResourceKey(value.kind, value.resourceId);
}

function compareIndexEntries(left: DataPlatformModelIndexEntry, right: DataPlatformModelIndexEntry): number {
  return compareResourceKeys(resourceKey(left), resourceKey(right));
}

function compareProjectAssets(left: ProjectModelAssetEntry, right: ProjectModelAssetEntry): number {
  const leftManagedKey = getManagedAssetResourceKey(left);
  const rightManagedKey = getManagedAssetResourceKey(right);
  if (leftManagedKey && rightManagedKey) return compareResourceKeys(leftManagedKey, rightManagedKey);

  const normalizeLocalPath = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const leftKey = leftManagedKey ?? `local:${normalizeLocalPath(left.path)}`;
  const rightKey = rightManagedKey ?? `local:${normalizeLocalPath(right.path)}`;
  return leftKey.localeCompare(rightKey, 'en');
}

function compareResourceKeys(left: string, right: string): number {
  const leftMatch = /^(model|combo):(\d+)$/.exec(left);
  const rightMatch = /^(model|combo):(\d+)$/.exec(right);
  if (!leftMatch || !rightMatch) return left.localeCompare(right, 'en');
  if (leftMatch[1] !== rightMatch[1]) return leftMatch[1].localeCompare(rightMatch[1], 'en');
  const leftId = BigInt(leftMatch[2]);
  const rightId = BigInt(rightMatch[2]);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function requireRecord(value: unknown, label: string, index: number): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`数据中台${label}第 ${index + 1} 项不是对象。`);
  return value;
}

function normalizeRequiredId(value: unknown, label: string, index: number): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^\d{1,64}$/.test(normalized)) return normalized;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`数据中台${label}第 ${index + 1} 项 id 无效。`);
}

function normalizeRequiredUrl(value: unknown, label: string, index: number): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`数据中台${label}第 ${index + 1} 项 fileUrl 为空。`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePageInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`数据中台${label}无效。`);
  }
  return normalized;
}

async function renamePathWithWindowsRetry(sourcePath: string, targetPath: string): Promise<void> {
  let retryIndex = 0;
  while (true) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const retryDelayMs = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
      if (
        process.platform !== 'win32'
        || retryDelayMs === undefined
        || !isNodeError(error)
        || typeof error.code !== 'string'
        || !WINDOWS_RENAME_RETRY_ERROR_CODES.has(error.code)
      ) {
        throw error;
      }
      retryIndex += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function isFilePath(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(targetPath);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isSameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizeRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) throw new Error('模型同步 runId 无效。');
  return value;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('数据中台模型同步已取消。');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
