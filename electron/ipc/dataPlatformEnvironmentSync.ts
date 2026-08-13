import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DataPlatformEnvironmentSyncProgress } from '../types.js';
import {
  normalizeDataPlatformSourceUrl,
  normalizeEnvironmentManifestResponse,
  type DataPlatformEnvironmentRecord,
} from './dataPlatformEnvironmentContract.js';
import {
  assertTrustedEnvironmentPath,
  buildDataPlatformEnvironmentPlan,
  ensureTrustedEnvironmentDirectory,
  getDataPlatformEnvironmentIndexPath,
  hashFileSha256,
  readDataPlatformEnvironmentIndex,
  resolveEnvironmentIndexEntryPath,
  writeDataPlatformEnvironmentIndexFile,
  type DataPlatformEnvironmentDownloadPlan,
} from './dataPlatformEnvironmentIndex.js';
import { inspectGlbModelFile } from './modelPackageScanner.js';
import {
  assertPathInside,
  downloadRemoteFile,
  requestDataPlatformJson,
  type DownloadRemoteFileOptions,
  type DownloadRemoteFileResult,
} from './dataPlatformTransfer.js';

const ENVIRONMENT_MANIFEST_QUERY_PATH = 'api/v1/env-models/sync-manifest/query';
const MANIFEST_PAGE_SIZE = 200;
const MAX_MANIFEST_PAGES = 1_000;
const MAX_MANIFEST_RECORDS = 100_000;
const MAX_ENVIRONMENT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_SYNC_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;
const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 2;
const PARTIAL_TTL_MS = 24 * 60 * 60_000;
const QUERY_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_200, 1_600] as const;
const WINDOWS_RENAME_RETRY_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

type EnvironmentSyncContext = {
  baseUrl: string;
  editorRoot: string;
  contextKey: string;
  expectedSourceKey?: string;
};

type ActiveEnvironmentSync = {
  runId: string;
  contextKey: string;
  controller: AbortController;
  promise: Promise<void>;
};

type EnvironmentSyncDependencies = {
  requestJson: typeof requestDataPlatformJson;
  downloadFile: (options: DownloadRemoteFileOptions) => Promise<DownloadRemoteFileResult>;
  inspectFile: typeof inspectGlbModelFile;
  now: () => Date;
  randomId: () => string;
};

export type ExecuteDataPlatformEnvironmentSyncOptions = EnvironmentSyncContext & {
  runId?: string;
  signal?: AbortSignal;
  dependencies?: Partial<EnvironmentSyncDependencies>;
};

type StagedDownload = {
  plan: DataPlatformEnvironmentDownloadPlan;
  stagedPath: string;
};

type PromotionItem = {
  label: string;
  target: string;
  staged: string;
  backup: string;
};

const DEFAULT_DEPENDENCIES: EnvironmentSyncDependencies = {
  requestJson: requestDataPlatformJson,
  downloadFile: downloadRemoteFile,
  inspectFile: inspectGlbModelFile,
  now: () => new Date(),
  randomId: randomUUID,
};

let activeEnvironmentSync: ActiveEnvironmentSync | null = null;
let queuedEnvironmentSyncContext: EnvironmentSyncContext | null = null;
let latestEnvironmentSyncProgress: DataPlatformEnvironmentSyncProgress | null = null;
let lastEnvironmentSyncContext: EnvironmentSyncContext | null = null;
let environmentSyncShuttingDown = false;
let browserWindowLoader: (() => Promise<typeof import('electron').BrowserWindow>) | null = null;

export async function executeDataPlatformEnvironmentSync(
  options: ExecuteDataPlatformEnvironmentSyncOptions,
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const editorRoot = path.resolve(options.editorRoot);
  const baseUrl = normalizeDataPlatformSourceUrl(options.baseUrl);
  const sourceKey = createDataPlatformSourceKey(baseUrl);
  const expectedSourceKey = options.expectedSourceKey?.trim();
  if (expectedSourceKey && expectedSourceKey !== sourceKey) {
    throw new Error('当前数据中台地址与已打开场景的环境模型来源不一致，已拒绝同步。');
  }
  const contextKey = normalizeContextKey(options.contextKey);
  const runId = normalizeRunId(options.runId ?? dependencies.randomId());
  const signal = options.signal ?? new AbortController().signal;
  let stagingRoot: string | null = null;
  let completed = 0;
  let total = 0;

  updateEnvironmentSyncProgress({ runId, contextKey, phase: 'querying', completed: 0, total: 0, message: '正在读取环境模型同步清单…', error: null });
  try {
    const manifest = await queryEnvironmentManifestSnapshot(baseUrl, signal, dependencies.requestJson);
    assertNotAborted(signal);
    const environmentIndexPath = getDataPlatformEnvironmentIndexPath(editorRoot);
    await assertTrustedEnvironmentPath(editorRoot, environmentIndexPath, '环境模型 Sidecar 索引');
    const current = await readDataPlatformEnvironmentIndex(editorRoot);
    const existingPaths = await collectExistingPaths(editorRoot, current.entries.map((entry) => entry.relativePath));
    const syncedAt = dependencies.now().toISOString();
    const plan = buildDataPlatformEnvironmentPlan({
      sourceKey,
      protocolVersion: manifest.protocolVersion,
      manifestRevision: manifest.manifestRevision,
      records: manifest.records,
      current,
      existingPaths,
      syncedAt,
    });
    total = plan.downloads.length;
    await cleanupExpiredEnvironmentPartials(editorRoot);
    const requiredDownloadBytes = await calculateAdditionalDownloadBytes(editorRoot, baseUrl, sourceKey, plan.downloads);
    await assertCacheCapacity(editorRoot, requiredDownloadBytes);
    stagingRoot = path.join(editorRoot, '.babylon-editor', `data-platform-environment-sync-${runId}`);
    assertPathInside(editorRoot, stagingRoot, '环境模型同步暂存目录');
    await removeTrustedEnvironmentPath(editorRoot, stagingRoot, '环境模型同步暂存目录', true);
    await ensureTrustedEnvironmentDirectory(editorRoot, stagingRoot, '环境模型同步暂存目录');

    updateEnvironmentSyncProgress({
      runId, contextKey, phase: 'downloading', completed: 0, total,
      message: total === 0 ? '环境模型缓存无需下载。' : `正在下载 ${total} 个环境 GLB…`, error: null,
    });
    const stagedDownloads = createStagedDownloads(stagingRoot, plan.downloads);
    const successfulDownloads: StagedDownload[] = [];
    const failedDownloads = new Map<string, string>();
    let downloadedBytes = 0;
    await runWithConcurrency(stagedDownloads, MAX_CONCURRENT_DOWNLOADS, async (item) => {
      assertNotAborted(signal);
      try {
        const partialDirectoryPath = getEnvironmentPartialDirectory(editorRoot, sourceKey, item.plan.record.id, item.plan.record.fileRevision!);
        await ensureTrustedEnvironmentDirectory(editorRoot, partialDirectoryPath, '环境模型续传目录');
        await ensureTrustedEnvironmentDirectory(editorRoot, path.dirname(item.stagedPath), '环境模型 staging 目录');
        const result = await dependencies.downloadFile({
          baseUrl,
          remoteUrl: item.plan.record.fileUrl!,
          destinationPath: item.stagedPath,
          maxBytes: MAX_ENVIRONMENT_FILE_BYTES,
          signal,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          context: `下载环境模型“${item.plan.record.displayName}”`,
          resumeKey: 'model-glb',
          partialDirectoryPath,
          partialTtlMs: PARTIAL_TTL_MS,
          onBytes: (bytes) => {
            downloadedBytes += bytes;
            if (downloadedBytes > MAX_SYNC_DOWNLOAD_BYTES) throw new Error('环境模型本轮下载总量超过 8 GiB 上限。');
          },
        });
        downloadedBytes += result.resumedBytes;
        if (downloadedBytes > MAX_SYNC_DOWNLOAD_BYTES) throw new Error('环境模型本轮下载总量超过 8 GiB 上限。');
        await assertTrustedEnvironmentPath(editorRoot, item.stagedPath, '环境模型 staging 文件');
        const actualSha256 = await hashFileSha256(item.stagedPath);
        assertDownloadedMetadata(item.plan.record, result, actualSha256);
        await removeTrustedEnvironmentPath(editorRoot, partialDirectoryPath, '环境模型续传目录', true);
        updateEnvironmentSyncProgress({ runId, contextKey, phase: 'validating', completed, total, message: `正在校验环境模型“${item.plan.record.displayName}”…`, error: null });
        const inspection = await dependencies.inspectFile(item.stagedPath);
        if (inspection.fileSizeBytes !== item.plan.record.fileSizeBytes) throw new Error(`环境模型“${item.plan.record.displayName}”校验大小不一致。`);
        successfulDownloads.push(item);
      } catch (error) {
        if (signal.aborted) throw error;
        failedDownloads.set(item.plan.record.id, toErrorMessage(error));
        await removeTrustedEnvironmentPath(editorRoot, item.stagedPath, '失败的环境模型 staging 文件', false).catch(() => undefined);
      } finally {
        completed += 1;
        updateEnvironmentSyncProgress({ runId, contextKey, phase: 'validating', completed, total, message: `已处理 ${completed}/${total} 个环境模型。`, error: null });
      }
    });

    if (failedDownloads.size > 0) applyDownloadFailures(plan.nextIndex.entries, current.entries, failedDownloads, syncedAt);
    const stagedIndexPath = path.join(stagingRoot, 'index', 'data-platform-environment-index.json');
    await ensureTrustedEnvironmentDirectory(editorRoot, path.dirname(stagedIndexPath), '环境模型 staging 索引目录');
    await writeDataPlatformEnvironmentIndexFile(stagedIndexPath, plan.nextIndex);
    await assertTrustedEnvironmentPath(editorRoot, stagedIndexPath, '环境模型 staging 索引');
    updateEnvironmentSyncProgress({ runId, contextKey, phase: 'promoting', completed, total, message: '正在提交环境模型缓存和 Sidecar 索引…', error: null });
    await promoteEnvironmentBatch({ editorRoot, stagingRoot, stagedDownloads: successfulDownloads, stagedIndexPath, signal });
    await removeTrustedEnvironmentPath(editorRoot, stagingRoot, '环境模型同步暂存目录', true);
    stagingRoot = null;
    updateEnvironmentSyncProgress({
      runId, contextKey, phase: 'completed', completed: total, total,
      message: `环境模型同步完成：清单 ${manifest.records.length} 项，成功下载 ${successfulDownloads.length} 项，下载失败 ${failedDownloads.size} 项，异常缓存 ${plan.nextIndex.entries.filter((entry) => entry.status !== 'active').length} 项。`, error: null,
    });
  } catch (error) {
    if (stagingRoot) await removeTrustedEnvironmentPath(editorRoot, stagingRoot, '环境模型同步暂存目录', true).catch(() => undefined);
    const normalized = signal.aborted ? new Error('数据中台环境模型同步已取消。') : error;
    updateEnvironmentSyncProgress({ runId, contextKey, phase: 'failed', completed, total, message: '数据中台环境模型同步失败，已保留原缓存。', error: toErrorMessage(normalized) });
    throw normalized;
  }
}

export function startDataPlatformEnvironmentSync(
  baseUrl: string,
  editorRoot: string,
  contextKey: string,
  expectedSourceKey?: string,
): boolean {
  if (environmentSyncShuttingDown) return false;
  const context = {
    baseUrl: normalizeDataPlatformSourceUrl(baseUrl),
    editorRoot: path.resolve(editorRoot),
    contextKey: normalizeContextKey(contextKey),
    expectedSourceKey: expectedSourceKey?.trim() || undefined,
  };
  lastEnvironmentSyncContext = { ...context };
  if (activeEnvironmentSync) {
    if (activeEnvironmentSync.contextKey === context.contextKey) {
      queuedEnvironmentSyncContext = activeEnvironmentSync.controller.signal.aborted ? context : null;
      return true;
    }
    queuedEnvironmentSyncContext = context;
    activeEnvironmentSync.controller.abort();
    return true;
  }
  return launchEnvironmentSync(context);
}

export function retryDataPlatformEnvironmentSync(): boolean {
  if (activeEnvironmentSync || !lastEnvironmentSyncContext || environmentSyncShuttingDown) return false;
  return startDataPlatformEnvironmentSync(
    lastEnvironmentSyncContext.baseUrl,
    lastEnvironmentSyncContext.editorRoot,
    lastEnvironmentSyncContext.contextKey,
    lastEnvironmentSyncContext.expectedSourceKey,
  );
}

export function getLatestDataPlatformEnvironmentSyncProgress(): DataPlatformEnvironmentSyncProgress | null {
  return latestEnvironmentSyncProgress ? { ...latestEnvironmentSyncProgress } : null;
}

export function clearDataPlatformEnvironmentSyncRetryContext(): void {
  lastEnvironmentSyncContext = null;
  queuedEnvironmentSyncContext = null;
}

export async function disposeDataPlatformEnvironmentSync(): Promise<void> {
  environmentSyncShuttingDown = true;
  queuedEnvironmentSyncContext = null;
  const active = activeEnvironmentSync;
  if (!active) return;
  active.controller.abort();
  await active.promise;
}

export function createDataPlatformSourceKey(baseUrl: string): string {
  return createHash('sha256').update(normalizeDataPlatformSourceUrl(baseUrl), 'utf8').digest('hex');
}

async function queryEnvironmentManifestSnapshot(
  baseUrl: string,
  signal: AbortSignal,
  requestJson: EnvironmentSyncDependencies['requestJson'],
): Promise<{ protocolVersion: string; manifestRevision: string; records: DataPlatformEnvironmentRecord[] }> {
  let expectedRevision: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const records: DataPlatformEnvironmentRecord[] = [];
    let cursorId: string | null = null;
    let protocolVersion: string | null = null;
    let manifestRevision: string | null = expectedRevision;
    let restart = false;
    for (let pageIndex = 0; pageIndex < MAX_MANIFEST_PAGES; pageIndex += 1) {
      assertNotAborted(signal);
      const payload = await requestJson({
        baseUrl,
        endpointPath: ENVIRONMENT_MANIFEST_QUERY_PATH,
        body: { cursorId, pageSize: MANIFEST_PAGE_SIZE, manifestRevision },
        signal,
        timeoutMs: QUERY_TIMEOUT_MS,
        context: '查询数据中台环境模型同步清单',
      });
      const page = normalizeEnvironmentManifestResponse(payload);
      if (manifestRevision === null) manifestRevision = page.manifestRevision;
      if (page.manifestRevision !== manifestRevision) { expectedRevision = page.manifestRevision; restart = true; break; }
      if (protocolVersion === null) protocolVersion = page.protocolVersion;
      else if (page.protocolVersion !== protocolVersion) throw new Error('环境模型同步协议版本在分页过程中发生变化。');
      records.push(...page.records);
      if (records.length > MAX_MANIFEST_RECORDS) throw new Error('环境模型同步清单超过 100000 项上限。');
      if (!page.hasMore) return { protocolVersion, manifestRevision, records };
      cursorId = page.nextCursorId;
    }
    if (!restart) throw new Error(`环境模型同步清单超过 ${MAX_MANIFEST_PAGES} 页上限。`);
  }
  throw new Error('环境模型清单修订在同步期间持续变化，请稍后重试。');
}

function launchEnvironmentSync(context: EnvironmentSyncContext): boolean {
  if (environmentSyncShuttingDown || activeEnvironmentSync) return false;
  const runId = randomUUID();
  const controller = new AbortController();
  const promise = executeDataPlatformEnvironmentSync({ ...context, runId, signal: controller.signal })
    .catch(() => undefined)
    .finally(() => {
      if (activeEnvironmentSync?.runId === runId) activeEnvironmentSync = null;
      const queued = queuedEnvironmentSyncContext;
      queuedEnvironmentSyncContext = null;
      if (!environmentSyncShuttingDown && queued) launchEnvironmentSync(queued);
    });
  activeEnvironmentSync = { runId, contextKey: context.contextKey, controller, promise };
  return true;
}

async function calculateAdditionalDownloadBytes(
  editorRoot: string,
  baseUrl: string,
  sourceKey: string,
  downloads: readonly DataPlatformEnvironmentDownloadPlan[],
): Promise<number> {
  let total = 0;
  for (const download of downloads) {
    const fileSizeBytes = download.record.fileSizeBytes ?? 0;
    const partialDirectory = getEnvironmentPartialDirectory(
      editorRoot,
      sourceKey,
      download.record.id,
      download.record.fileRevision!,
    );
    const partialPath = path.join(partialDirectory, 'model-glb.partial');
    const metadataPath = `${partialPath}.json`;
    const expectedUrl = new URL(download.record.fileUrl!, `${baseUrl.replace(/\/+$/, '')}/`).toString();
    await assertTrustedEnvironmentPath(editorRoot, partialPath, '环境模型续传文件');
    await assertTrustedEnvironmentPath(editorRoot, metadataPath, '环境模型续传元数据');
    const existingPartialBytes = await readReusablePartialBytes(partialPath, metadataPath, fileSizeBytes, expectedUrl);
    total += Math.max(0, fileSizeBytes - existingPartialBytes);
    if (!Number.isSafeInteger(total)) throw new Error('环境模型待下载大小超出安全整数范围。');
  }
  return total;
}

async function readReusablePartialBytes(
  partialPath: string,
  metadataPath: string,
  expectedFileSize: number,
  expectedUrl: string,
): Promise<number> {
  try {
    const [stat, metadataText] = await Promise.all([fs.lstat(partialPath), fs.readFile(metadataPath, 'utf8')]);
    const metadata = JSON.parse(metadataText) as unknown;
    if (stat.isSymbolicLink() || !stat.isFile() || typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return 0;
    const record = metadata as Record<string, unknown>;
    const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : Number.NaN;
    const etag = typeof record.etag === 'string' ? record.etag.trim() : '';
    const reusable = record.url === expectedUrl
      && record.bytes === stat.size
      && Number.isFinite(updatedAt)
      && updatedAt <= Date.now()
      && Date.now() - updatedAt <= PARTIAL_TTL_MS
      && /^"[^"\r\n]+"$/.test(etag)
      && !/^W\//i.test(etag);
    return reusable ? Math.min(stat.size, expectedFileSize) : 0;
  } catch {
    return 0;
  }
}

async function assertCacheCapacity(editorRoot: string, requiredDownloadBytes: number): Promise<void> {
  if (!Number.isSafeInteger(requiredDownloadBytes) || requiredDownloadBytes < 0) throw new Error('环境模型待下载大小无效。');
  const cacheRoot = path.join(editorRoot, '.babylon-editor', 'data-platform-cache');
  await assertTrustedEnvironmentPath(editorRoot, cacheRoot, '环境模型缓存根目录');
  const cacheBytes = await calculateDirectoryBytes(editorRoot, cacheRoot);
  if (cacheBytes + requiredDownloadBytes > readCacheLimitBytes()) {
    throw new Error('环境模型缓存将超过 20 GiB 配额，请清理未使用资源或调整 ZENDING_ENV_CACHE_MAX_BYTES。');
  }
  const statfs = await fs.statfs(editorRoot);
  const availableBytes = statfs.bavail * statfs.bsize;
  if (availableBytes - requiredDownloadBytes < MIN_FREE_DISK_BYTES) {
    throw new Error('磁盘剩余空间将在下载后低于 2 GiB，已停止环境模型同步。');
  }
}

async function calculateDirectoryBytes(editorRoot: string, root: string): Promise<number> {
  if (!await pathExists(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    await assertTrustedEnvironmentPath(editorRoot, current, '环境模型缓存目录');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(candidate);
      else if (stat.isFile()) {
        total += stat.size;
        if (!Number.isSafeInteger(total)) throw new Error('环境模型缓存大小超出安全整数范围。');
      }
    }
  }
  return total;
}

function readCacheLimitBytes(): number {
  const configured = process.env.ZENDING_ENV_CACHE_MAX_BYTES?.trim();
  if (!configured) return DEFAULT_CACHE_LIMIT_BYTES;
  if (!/^\d+$/.test(configured)) throw new Error('ZENDING_ENV_CACHE_MAX_BYTES 必须是正整数字节数。');
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < MAX_ENVIRONMENT_FILE_BYTES) {
    throw new Error('ZENDING_ENV_CACHE_MAX_BYTES 不能小于 512 MiB。');
  }
  return parsed;
}

async function collectExistingPaths(editorRoot: string, relativePaths: readonly string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const relativePath of relativePaths) {
    try {
      const target = resolveEnvironmentIndexEntryPath(editorRoot, relativePath);
      await assertTrustedEnvironmentPath(editorRoot, target, '环境模型缓存文件');
      const stat = await fs.lstat(target);
      if (!stat.isSymbolicLink() && stat.isFile()) existing.add(relativePath);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    }
  }
  return existing;
}

function createStagedDownloads(stagingRoot: string, downloads: readonly DataPlatformEnvironmentDownloadPlan[]): StagedDownload[] {
  return downloads.map((plan) => {
    const stagedPath = path.join(stagingRoot, 'downloads', ...plan.relativePath.split('/'));
    assertPathInside(stagingRoot, stagedPath, '环境模型 staging 文件');
    return { plan, stagedPath };
  });
}

function getEnvironmentPartialDirectory(
  editorRoot: string,
  sourceKey: string,
  resourceId: string,
  fileRevision: string,
): string {
  const root = path.join(editorRoot, '.babylon-editor', 'data-platform-cache', 'partials');
  const target = path.join(root, sourceKey, resourceId, fileRevision);
  assertPathInside(root, target, '环境模型续传目录');
  return target;
}

async function cleanupExpiredEnvironmentPartials(editorRoot: string): Promise<void> {
  const partialRoot = path.join(editorRoot, '.babylon-editor', 'data-platform-cache', 'partials');
  await assertTrustedEnvironmentPath(editorRoot, partialRoot, '环境模型续传根目录');
  if (!await pathExists(partialRoot)) return;
  const expiresBefore = Date.now() - 24 * 60 * 60_000;
  const pending = [partialRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    await assertTrustedEnvironmentPath(editorRoot, current, '环境模型续传目录');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(candidate);
      if (stat.mtimeMs >= expiresBefore) continue;
      assertPathInside(partialRoot, candidate, '过期环境模型续传文件');
      await removeTrustedEnvironmentPath(editorRoot, candidate, '过期环境模型续传文件', false);
    }
  }
}

function assertDownloadedMetadata(record: DataPlatformEnvironmentRecord, result: DownloadRemoteFileResult, actualSha256: string): void {
  if (result.bytes !== record.fileSizeBytes) throw new Error(`环境模型“${record.displayName}”下载大小与清单不一致。`);
  if (actualSha256 !== record.fileSha256) throw new Error(`环境模型“${record.displayName}”SHA-256 与清单不一致。`);
}

function applyDownloadFailures(
  nextEntries: Array<import('./dataPlatformEnvironmentIndex.js').DataPlatformEnvironmentIndexEntry>,
  currentEntries: readonly import('./dataPlatformEnvironmentIndex.js').DataPlatformEnvironmentIndexEntry[],
  failures: ReadonlyMap<string, string>,
  syncedAt: string,
): void {
  const currentById = new Map(currentEntries.map((entry) => [entry.resourceId, entry]));
  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];
    const failure = failures.get(entry.resourceId);
    if (!failure) continue;
    const previous = currentById.get(entry.resourceId);
    if (previous) {
      nextEntries[index] = { ...previous, status: 'stale', syncedAt, warning: `本次同步失败：${failure}` };
    } else {
      nextEntries.splice(index, 1);
      index -= 1;
    }
  }
}

async function promoteEnvironmentBatch(options: {
  editorRoot: string;
  stagingRoot: string;
  stagedDownloads: readonly StagedDownload[];
  stagedIndexPath: string;
  signal: AbortSignal;
}): Promise<void> {
  const backupRoot = path.join(options.stagingRoot, 'backup');
  const items: PromotionItem[] = options.stagedDownloads.map((download) => ({
    label: `环境模型 ${download.plan.record.id}`,
    target: resolveEnvironmentIndexEntryPath(options.editorRoot, download.plan.relativePath),
    staged: download.stagedPath,
    backup: path.join(backupRoot, ...download.plan.relativePath.split('/')),
  }));
  items.push({
    label: '环境模型 Sidecar 索引',
    target: getDataPlatformEnvironmentIndexPath(options.editorRoot),
    staged: options.stagedIndexPath,
    backup: path.join(backupRoot, '.babylon-editor', 'data-platform-environment-index.json'),
  });
  const states = items.map((item) => ({ item, previousMoved: false, stagedMoved: false }));
  await ensureTrustedEnvironmentDirectory(options.editorRoot, backupRoot, '环境模型备份目录');
  try {
    for (const state of states) {
      assertNotAborted(options.signal);
      assertPathInside(options.editorRoot, state.item.target, `${state.item.label}目标`);
      await assertTrustedEnvironmentPath(options.editorRoot, state.item.staged, `${state.item.label} staging 文件`);
      await ensureTrustedEnvironmentDirectory(options.editorRoot, path.dirname(state.item.target), `${state.item.label}目标目录`);
      if (await pathExists(state.item.target)) {
        await assertTrustedEnvironmentPath(options.editorRoot, state.item.target, `${state.item.label}目标`);
        await ensureTrustedEnvironmentDirectory(options.editorRoot, path.dirname(state.item.backup), `${state.item.label}备份目录`);
        await assertTrustedEnvironmentPath(options.editorRoot, state.item.backup, `${state.item.label}备份`);
        await renameWithRetry(state.item.target, state.item.backup);
        state.previousMoved = true;
      }
      await assertTrustedEnvironmentPath(options.editorRoot, state.item.target, `${state.item.label}目标`);
      await renameWithRetry(state.item.staged, state.item.target);
      state.stagedMoved = true;
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const state of [...states].reverse()) {
      try {
        if (state.stagedMoved && await pathExists(state.item.target)) {
          await removeTrustedEnvironmentPath(options.editorRoot, state.item.target, `${state.item.label}回滚目标`, false);
        }
        if (state.previousMoved && await pathExists(state.item.backup)) {
          await assertTrustedEnvironmentPath(options.editorRoot, state.item.backup, `${state.item.label}回滚备份`);
          await ensureTrustedEnvironmentDirectory(options.editorRoot, path.dirname(state.item.target), `${state.item.label}回滚目标目录`);
          await assertTrustedEnvironmentPath(options.editorRoot, state.item.target, `${state.item.label}回滚目标`);
          await renameWithRetry(state.item.backup, state.item.target);
        }
      } catch (rollbackError) { rollbackErrors.push(`${state.item.label}：${toErrorMessage(rollbackError)}`); }
    }
    if (rollbackErrors.length > 0) throw new Error(`${toErrorMessage(error)}；环境模型回滚不完整：${rollbackErrors.join('；')}`);
    throw error;
  }
}


function updateEnvironmentSyncProgress(progress: DataPlatformEnvironmentSyncProgress): void {
  latestEnvironmentSyncProgress = { ...progress };
  const loadBrowserWindow = browserWindowLoader ??= async () => (await import('electron')).BrowserWindow;
  void loadBrowserWindow().then((ElectronBrowserWindow) => {
    for (const window of ElectronBrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('data-platform:environmentSyncProgress', { ...progress });
    }
  }).catch(() => undefined);
}
async function runWithConcurrency<T>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let next = 0; let firstError: unknown = null;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (firstError === null && next < values.length) {
      const index = next; next += 1;
      try { await worker(values[index]); } catch (error) { if (firstError === null) firstError = error; }
    }
  });
  await Promise.all(workers);
  if (firstError !== null) throw firstError;
}
async function removeTrustedEnvironmentPath(
  editorRoot: string,
  targetPath: string,
  label: string,
  recursive: boolean,
): Promise<void> {
  await assertTrustedEnvironmentPath(editorRoot, targetPath, label);
  await fs.rm(targetPath, { recursive, force: true });
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  let retry = 0;
  while (true) {
    try { await fs.rename(source, target); return; } catch (error) {
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[retry];
      if (process.platform !== 'win32' || delay === undefined || !isNodeError(error) || !WINDOWS_RENAME_RETRY_ERROR_CODES.has(error.code ?? '')) throw error;
      retry += 1; await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
function normalizeRunId(value: string): string { if (!RUN_ID_PATTERN.test(value)) throw new Error('环境模型同步 runId 无效。'); return value; }
function normalizeContextKey(value: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('环境模型同步 contextKey 无效。'); return value.trim(); }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error('数据中台环境模型同步已取消。'); }
async function pathExists(value: string): Promise<boolean> { try { await fs.access(value); return true; } catch { return false; } }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error; }
function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
