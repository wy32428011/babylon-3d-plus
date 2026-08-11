import { BrowserWindow } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertUniqueSkyboxRecords,
  MAX_SKYBOX_FILE_BYTES,
  normalizeSkyboxQueryResponse,
  type DataPlatformSkyboxRecord,
} from './dataPlatformSkyboxContract.js';
import {
  buildDataPlatformSkyboxPlan,
  getDataPlatformSkyboxIndexPath,
  MAX_SKYBOX_SYNC_DOWNLOAD_BYTES,
  readDataPlatformSkyboxIndex,
  resolveSkyboxIndexEntryPath,
  writeDataPlatformSkyboxIndexFile,
  type DataPlatformSkyboxDownloadPlan,
} from './dataPlatformSkyboxIndex.js';
import {
  assertPathInside,
  DataPlatformRollbackError,
  downloadRemoteFile,
  requestDataPlatformJson,
  type DownloadRemoteFileOptions,
  type DownloadRemoteFileResult,
} from './dataPlatformTransfer.js';
import { validateSkyboxSourceFile } from './skyboxAssetStore.js';

export { DataPlatformRollbackError };

const SKYBOX_QUERY_PATH = 'api/v1/skyboxes/query';
const SKYBOX_QUERY_PAGE_SIZE = 100;
const MAX_SKYBOX_QUERY_PAGES = 1_000;
const MAX_SKYBOX_RECORDS = 100_000;
const MAX_CONCURRENT_DOWNLOADS = 2;
const QUERY_TIMEOUT_MS = 20_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
// 与现有模型同步保持相同的 Windows 文件占用退避策略。
const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_200, 1_600] as const;
const WINDOWS_RENAME_RETRY_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export type DataPlatformSkyboxSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

export type DataPlatformSkyboxSyncProgress = {
  runId: string;
  phase: DataPlatformSkyboxSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

export type DataPlatformSkyboxSyncContext = {
  baseUrl: string;
  editorRoot: string;
};

export type DataPlatformSkyboxSyncDependencies = {
  requestJson: typeof requestDataPlatformJson;
  downloadFile: (options: DownloadRemoteFileOptions) => Promise<DownloadRemoteFileResult>;
  validateFile: typeof validateSkyboxSourceFile;
  now: () => Date | string | number;
  randomId: () => string;
};

export type ExecuteDataPlatformSkyboxSyncOptions = DataPlatformSkyboxSyncContext & {
  signal?: AbortSignal;
  dependencies?: Partial<DataPlatformSkyboxSyncDependencies>;
  runId?: string;
};

type ActiveSkyboxSync = {
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
};

type StagedDownload = {
  plan: DataPlatformSkyboxDownloadPlan;
  stagedPath: string;
};

type PromotionItem = {
  label: string;
  target: string;
  staged: string;
  backup: string;
};

const DEFAULT_DEPENDENCIES: DataPlatformSkyboxSyncDependencies = {
  requestJson: requestDataPlatformJson,
  downloadFile: downloadRemoteFile,
  validateFile: validateSkyboxSourceFile,
  now: () => new Date(),
  randomId: randomUUID,
};

let activeSkyboxSync: ActiveSkyboxSync | null = null;
let latestSkyboxSyncProgress: DataPlatformSkyboxSyncProgress | null = null;
let lastSkyboxSyncContext: DataPlatformSkyboxSyncContext | null = null;
let skyboxSyncShuttingDown = false;

/** 执行一次完整的查询、下载、校验和原子推广。 */
export async function executeDataPlatformSkyboxSync(
  options: ExecuteDataPlatformSkyboxSyncOptions,
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const editorRoot = normalizeEditorRoot(options.editorRoot);
  const runId = normalizeRunId(options.runId ?? dependencies.randomId());
  const signal = options.signal ?? new AbortController().signal;
  let completedDownloads = 0;
  let totalDownloads = 0;
  let stagingRoot: string | null = null;
  let preserveStaging = false;

  updateSkyboxSyncProgress({
    runId,
    phase: 'querying',
    completed: 0,
    total: 0,
    message: '正在查询数据中台天空盒…',
    error: null,
  });

  try {
    assertNotAborted(signal);
    const records = await queryAllSkyboxes(options.baseUrl, signal, dependencies.requestJson);
    assertNotAborted(signal);

    const currentIndex = await readDataPlatformSkyboxIndex(editorRoot);
    const existingPaths = await collectExistingSkyboxPaths(editorRoot, currentIndex.entries);
    const syncedAt = normalizeNow(dependencies.now()).toISOString();
    const plan = buildDataPlatformSkyboxPlan(records, currentIndex, existingPaths, syncedAt);
    totalDownloads = plan.downloads.length;

    stagingRoot = path.join(editorRoot, '.babylon-editor', `data-platform-skybox-sync-${runId}`);
    assertPathInside(editorRoot, stagingRoot, '天空盒同步暂存目录');
    await ensureSafePathAncestors(editorRoot, stagingRoot, '天空盒同步暂存目录');
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.mkdir(stagingRoot, { recursive: true });

    updateSkyboxSyncProgress({
      runId,
      phase: 'downloading',
      completed: 0,
      total: totalDownloads,
      message: totalDownloads === 0 ? '天空盒内容无需下载。' : `正在下载 ${totalDownloads} 个天空盒文件…`,
      error: null,
    });

    const stagedDownloads = createStagedDownloads(stagingRoot, plan.downloads);
    let actualDownloadedBytes = 0;
    let validationStarted = false;
    await runWithConcurrency(stagedDownloads, MAX_CONCURRENT_DOWNLOADS, async (item) => {
      assertNotAborted(signal);
      const hash = createHash('sha256');
      let hashedBytes = 0;
      const result = await dependencies.downloadFile({
        baseUrl: options.baseUrl,
        remoteUrl: item.plan.record.fileUrl,
        destinationPath: item.stagedPath,
        maxBytes: MAX_SKYBOX_FILE_BYTES,
        signal,
        timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
        context: `下载天空盒 ${item.plan.record.displayName}`,
        onChunk: (chunk) => {
          hash.update(chunk);
          hashedBytes += chunk.byteLength;
        },
        onBytes: (bytes) => {
          if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new Error('天空盒下载字节计数无效。');
          }
          actualDownloadedBytes += bytes;
          if (actualDownloadedBytes > MAX_SKYBOX_SYNC_DOWNLOAD_BYTES) {
            throw new Error('数据中台天空盒本轮实际下载总量超过 8 GiB 上限。');
          }
        },
      });
      assertNotAborted(signal);
      assertDownloadedMetadata(item.plan.record, result, hashedBytes, hash.digest('hex'));

      if (!validationStarted) {
        validationStarted = true;
        updateSkyboxSyncProgress({
          runId,
          phase: 'validating',
          completed: completedDownloads,
          total: totalDownloads,
          message: '正在逐项完整校验 HDR/EXR 内容…',
          error: null,
        });
      }
      const validation = await dependencies.validateFile(item.stagedPath);
      if (validation.format !== item.plan.record.format) {
        throw new Error(`天空盒 ${item.plan.record.displayName} 实际格式与元数据不一致。`);
      }
      if (validation.fileSizeBytes !== item.plan.record.fileSizeBytes) {
        throw new Error(`天空盒 ${item.plan.record.displayName} 校验大小与元数据不一致。`);
      }

      completedDownloads += 1;
      updateSkyboxSyncProgress({
        runId,
        phase: 'validating',
        completed: completedDownloads,
        total: totalDownloads,
        message: `已下载并校验 ${completedDownloads}/${totalDownloads} 个天空盒文件。`,
        error: null,
      });
    });

    if (!validationStarted) {
      updateSkyboxSyncProgress({
        runId,
        phase: 'validating',
        completed: 0,
        total: 0,
        message: '正在校验下一版天空盒索引…',
        error: null,
      });
    }

    const stagedIndexPath = path.join(stagingRoot, 'index', 'data-platform-skybox-index.json');
    assertPathInside(stagingRoot, stagedIndexPath, '天空盒 staging 索引');
    await writeDataPlatformSkyboxIndexFile(stagedIndexPath, plan.nextIndex);
    assertNotAborted(signal);

    updateSkyboxSyncProgress({
      runId,
      phase: 'promoting',
      completed: completedDownloads,
      total: totalDownloads,
      message: '正在原子推广天空盒文件与索引…',
      error: null,
    });

    await promoteSkyboxBatch({
      editorRoot,
      stagingRoot,
      stagedDownloads,
      stagedIndexPath,
      signal,
    });

    const cleanupWarning = await cleanupCommittedStaging(editorRoot, stagingRoot);
    if (!cleanupWarning) stagingRoot = null;
    updateSkyboxSyncProgress({
      runId,
      phase: 'completed',
      completed: totalDownloads,
      total: totalDownloads,
      message: `天空盒同步完成：远端 ${records.length} 项，本次下载 ${totalDownloads} 项。${cleanupWarning ? `；${cleanupWarning}` : ''}`,
      error: null,
    });
  } catch (caughtError) {
    preserveStaging = caughtError instanceof DataPlatformRollbackError;
    let error = preserveStaging || !signal.aborted ? caughtError : createCanceledError();
    if (stagingRoot && !preserveStaging) {
      try {
        await removeStagingRoot(editorRoot, stagingRoot);
        stagingRoot = null;
      } catch (cleanupError) {
        error = new Error(`${toErrorMessage(error)}；清理天空盒 staging 失败：${toErrorMessage(cleanupError)}`);
      }
    }

    updateSkyboxSyncProgress({
      runId,
      phase: 'failed',
      completed: completedDownloads,
      total: totalDownloads,
      message: preserveStaging
        ? '数据中台天空盒同步失败，回滚不完整，恢复材料已保留。'
        : signal.aborted
          ? '数据中台天空盒同步已取消，原资源库保持不变或已完整恢复。'
          : '数据中台天空盒同步失败，原资源库保持不变或已完整恢复。',
      error: toSafeErrorMessage(error),
    });
    throw error;
  }
}

/** 启动全局天空盒同步；重复启动复用当前任务。 */
export function startDataPlatformSkyboxSync(baseUrl: string, editorRoot: string): boolean {
  if (skyboxSyncShuttingDown) return false;
  if (activeSkyboxSync) return true;

  const context = { baseUrl, editorRoot };
  lastSkyboxSyncContext = { ...context };
  const runId = randomUUID();
  const controller = new AbortController();
  const promise = executeDataPlatformSkyboxSync({ ...context, runId, signal: controller.signal })
    .catch(() => undefined)
    .finally(() => {
      if (activeSkyboxSync?.runId === runId) activeSkyboxSync = null;
    });
  activeSkyboxSync = { runId, controller, promise };
  return true;
}

/** 使用最近一次 context 重试。 */
export function retryDataPlatformSkyboxSync(): boolean {
  if (activeSkyboxSync || !lastSkyboxSyncContext || skyboxSyncShuttingDown) return false;
  return startDataPlatformSkyboxSync(lastSkyboxSyncContext.baseUrl, lastSkyboxSyncContext.editorRoot);
}

/** 返回最近进度快照。 */
export function getLatestDataPlatformSkyboxSyncProgress(): DataPlatformSkyboxSyncProgress | null {
  return latestSkyboxSyncProgress ? { ...latestSkyboxSyncProgress } : null;
}

/** 清除重试 context，不影响正在运行的任务。 */
export function clearDataPlatformSkyboxSyncRetryContext(): void {
  lastSkyboxSyncContext = null;
}

/** 取消并等待活动任务完全释放。 */
export async function disposeDataPlatformSkyboxSync(): Promise<void> {
  skyboxSyncShuttingDown = true;
  const active = activeSkyboxSync;
  if (!active) return;
  active.controller.abort();
  await active.promise;
}

async function queryAllSkyboxes(
  baseUrl: string,
  signal: AbortSignal,
  requestJson: DataPlatformSkyboxSyncDependencies['requestJson'],
): Promise<DataPlatformSkyboxRecord[]> {
  const records: DataPlatformSkyboxRecord[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const seenHashes = new Set<string>();
  let stableTotal: number | null = null;

  for (let pageNum = 1; pageNum <= MAX_SKYBOX_QUERY_PAGES; pageNum += 1) {
    assertNotAborted(signal);
    const payload = await requestJson({
      baseUrl,
      endpointPath: SKYBOX_QUERY_PATH,
      body: { pageNum, pageSize: SKYBOX_QUERY_PAGE_SIZE, skyboxName: '' },
      signal,
      timeoutMs: QUERY_TIMEOUT_MS,
      context: '查询数据中台天空盒',
    });
    const page = normalizeSkyboxQueryResponse(payload);
    if (page.pageNum !== pageNum) {
      throw new Error(`数据中台天空盒响应 pageNum 与请求不一致：请求 ${pageNum}，响应 ${page.pageNum}。`);
    }
    if (page.pageSize !== SKYBOX_QUERY_PAGE_SIZE) {
      throw new Error(`数据中台天空盒响应 pageSize 与请求不一致：请求 ${SKYBOX_QUERY_PAGE_SIZE}，响应 ${page.pageSize}。`);
    }
    if (stableTotal === null) stableTotal = page.total;
    else if (page.total !== stableTotal) throw new Error('数据中台天空盒分页 total 在查询过程中发生变化。');

    if (page.records.length === 0) {
      if (records.length === stableTotal) {
        assertUniqueSkyboxRecords(records);
        return records;
      }
      throw new Error(`数据中台天空盒分页在未取完 total=${stableTotal} 时返回空页。`);
    }

    for (const record of page.records) {
      const normalizedName = record.displayName.normalize('NFKC').trim().toLowerCase();
      if (seenIds.has(record.id)) throw new Error(`数据中台天空盒存在跨页重复 ID：${record.id}`);
      if (seenNames.has(normalizedName)) throw new Error(`数据中台天空盒存在跨页重复名称：${record.displayName}`);
      if (seenHashes.has(record.sha256)) throw new Error(`数据中台天空盒存在跨页重复 SHA-256：${record.sha256}`);
      seenIds.add(record.id);
      seenNames.add(normalizedName);
      seenHashes.add(record.sha256);
      records.push(record);
    }

    if (records.length > MAX_SKYBOX_RECORDS || records.length > stableTotal) {
      throw new Error(`数据中台天空盒累计记录数超过 total=${stableTotal} 或 ${MAX_SKYBOX_RECORDS} 项上限。`);
    }
    if (records.length === stableTotal) {
      assertUniqueSkyboxRecords(records);
      return records;
    }
  }

  throw new Error(`数据中台天空盒分页超过 ${MAX_SKYBOX_QUERY_PAGES} 页上限。`);
}

async function collectExistingSkyboxPaths(
  editorRoot: string,
  entries: readonly { relativePath: string }[],
): Promise<Set<string>> {
  const existingPaths = new Set<string>();
  for (const entry of entries) {
    const targetPath = resolveSkyboxIndexEntryPath(editorRoot, entry.relativePath);
    assertPathInside(editorRoot, targetPath, '天空盒索引目标');
    if (!await hasSafeExistingAncestors(editorRoot, targetPath)) continue;
    try {
      const stat = await fs.lstat(targetPath);
      if (!stat.isSymbolicLink() && stat.isFile()) existingPaths.add(entry.relativePath);
    } catch (error) {
      if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
  }
  return existingPaths;
}


async function hasSafeExistingAncestors(rootPath: string, targetPath: string): Promise<boolean> {
  const root = path.resolve(rootPath);
  const parent = path.dirname(path.resolve(targetPath));
  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }

  const relative = path.relative(root, parent);
  if (!relative) return true;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      throw error;
    }
  }
  return true;
}

function createStagedDownloads(
  stagingRoot: string,
  downloads: readonly DataPlatformSkyboxDownloadPlan[],
): StagedDownload[] {
  return downloads.map((plan) => {
    const stagedPath = path.join(stagingRoot, 'downloads', ...plan.relativePath.split('/'));
    assertPathInside(stagingRoot, stagedPath, '天空盒 staging 文件');
    return { plan, stagedPath };
  });
}

function assertDownloadedMetadata(
  record: DataPlatformSkyboxRecord,
  result: DownloadRemoteFileResult,
  hashedBytes: number,
  actualSha256: string,
): void {
  if (!Number.isSafeInteger(result.bytes) || result.bytes < 0) {
    throw new Error(`天空盒 ${record.displayName} 下载结果字节数无效。`);
  }
  if (result.bytes !== record.fileSizeBytes) {
    throw new Error(`天空盒 ${record.displayName} 下载大小与元数据不一致。`);
  }
  if (hashedBytes !== result.bytes) {
    throw new Error(`天空盒 ${record.displayName} 流式 SHA 字节数与下载结果不一致。`);
  }
  if (actualSha256 !== record.sha256) {
    throw new Error(`天空盒 ${record.displayName} SHA-256 与元数据不一致。`);
  }
}

async function promoteSkyboxBatch(options: {
  editorRoot: string;
  stagingRoot: string;
  stagedDownloads: readonly StagedDownload[];
  stagedIndexPath: string;
  signal: AbortSignal;
}): Promise<void> {
  const backupRoot = path.join(options.stagingRoot, 'backup');
  assertPathInside(options.stagingRoot, backupRoot, '天空盒恢复目录');
  const items: PromotionItem[] = options.stagedDownloads.map((download) => {
    const target = resolveSkyboxIndexEntryPath(options.editorRoot, download.plan.relativePath);
    const backup = path.join(backupRoot, ...download.plan.relativePath.split('/'));
    assertPathInside(options.editorRoot, target, '天空盒推广目标');
    assertPathInside(options.stagingRoot, download.stagedPath, '天空盒 staging 文件');
    assertPathInside(options.stagingRoot, backup, '天空盒备份文件');
    return {
      label: `天空盒 ${download.plan.record.id}`,
      target,
      staged: download.stagedPath,
      backup,
    };
  });
  const indexTarget = getDataPlatformSkyboxIndexPath(options.editorRoot);
  const indexBackup = path.join(backupRoot, '.babylon-editor', 'data-platform-skybox-index.json');
  assertPathInside(options.editorRoot, indexTarget, '天空盒索引推广目标');
  assertPathInside(options.stagingRoot, options.stagedIndexPath, '天空盒 staging 索引');
  assertPathInside(options.stagingRoot, indexBackup, '天空盒索引备份');
  items.push({
    label: '天空盒索引',
    target: indexTarget,
    staged: options.stagedIndexPath,
    backup: indexBackup,
  });

  const states = items.map((item) => ({ item, previousMoved: false, stagedMoved: false }));
  await fs.mkdir(backupRoot, { recursive: true });

  try {
    for (const state of states) {
      assertNotAborted(options.signal);
      await ensureSafePathAncestors(options.editorRoot, state.item.target, state.item.label);
      await fs.mkdir(path.dirname(state.item.target), { recursive: true });
      if (await pathExists(state.item.target)) {
        await fs.mkdir(path.dirname(state.item.backup), { recursive: true });
        await renamePathWithWindowsRetry(state.item.target, state.item.backup);
        state.previousMoved = true;
      }
      assertNotAborted(options.signal);
      await renamePathWithWindowsRetry(state.item.staged, state.item.target);
      state.stagedMoved = true;
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const state of [...states].reverse()) {
      try {
        if (state.stagedMoved && await pathExists(state.item.target)) {
          assertPathInside(options.editorRoot, state.item.target, `${state.item.label}回滚目标`);
          await ensureSafePathAncestors(options.editorRoot, state.item.target, `${state.item.label}回滚目标`);
          await fs.rm(state.item.target, { recursive: true, force: true });
        }
        if (state.previousMoved && await pathExists(state.item.backup)) {
          await ensureSafePathAncestors(options.editorRoot, state.item.target, `${state.item.label}恢复目标`);
          await fs.mkdir(path.dirname(state.item.target), { recursive: true });
          await renamePathWithWindowsRetry(state.item.backup, state.item.target);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${state.item.label}：${toErrorMessage(rollbackError)}`);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new DataPlatformRollbackError(
        `${toErrorMessage(error)}；天空盒库回滚不完整：${rollbackErrors.join('；')}；已保留恢复目录：${backupRoot}`,
      );
    }
    throw error;
  }
}

function updateSkyboxSyncProgress(progress: DataPlatformSkyboxSyncProgress): void {
  latestSkyboxSyncProgress = { ...progress };
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send('data-platform:skyboxSyncProgress', { ...progress });
    } catch {
      // 单个窗口已进入销毁竞态时，不应中断同步事务或阻止其他窗口收到进度。
    }
  }
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
        || !WINDOWS_RENAME_RETRY_ERROR_CODES.has(error.code ?? '')
      ) {
        throw error;
      }
      retryIndex += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}


async function cleanupCommittedStaging(editorRoot: string, stagingRoot: string): Promise<string | null> {
  try {
    await removeStagingRoot(editorRoot, stagingRoot);
    return null;
  } catch (error) {
    return `staging 清理失败，已保留待后续清理：${toSafeErrorMessage(error)}`;
  }
}

async function removeStagingRoot(editorRoot: string, stagingRoot: string): Promise<void> {
  assertPathInside(editorRoot, stagingRoot, '天空盒同步暂存目录');
  await ensureSafePathAncestors(editorRoot, stagingRoot, '天空盒同步暂存目录');
  await fs.rm(stagingRoot, { recursive: true, force: true });
}

async function ensureSafePathAncestors(rootPath: string, targetPath: string, label: string): Promise<void> {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  assertPathInside(root, target, label);

  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`${label} 的 editorRoot 不是安全普通目录。`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await fs.mkdir(root, { recursive: true });
    } else {
      throw error;
    }
  }

  const parent = path.dirname(target);
  const relative = path.relative(root, parent);
  if (!relative) return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} 的父目录包含符号链接。`);
      if (!stat.isDirectory()) throw new Error(`${label} 的父路径不是目录。`);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function normalizeEditorRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('editorRoot 不能为空。');
  return path.resolve(value);
}

function normalizeRunId(value: string): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new Error('天空盒同步 runId 格式不安全。');
  }
  return value;
}

function normalizeNow(value: Date | string | number): Date {
  const normalized = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(normalized.getTime())) throw new Error('天空盒同步 now 返回了无效时间。');
  return normalized;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createCanceledError();
}

function createCanceledError(): Error {
  return new Error('数据中台天空盒同步已取消。');
}

function toSafeErrorMessage(error: unknown): string {
  return toErrorMessage(error).replace(/\r?\n\s*at\s[\s\S]*/u, '').slice(0, 2_000);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
