import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DataPlatformImageSyncProgress,
  SyncedImageAssetEntry,
  SyncedImageIndex,
} from '../types.js';
import { authorizeAssetFile, encodeAssetUrl } from './assetRegistry.js';
import { getProjectImagesRoot } from './projectAssetStore.js';
import {
  assertPathInside,
  downloadRemoteFile,
  requestDataPlatformJson,
} from './dataPlatformTransfer.js';

const IMAGE_QUERY_PATH = 'api/v1/bigscreen-icons/query';
const IMAGE_QUERY_PAGE_SIZE = 200;
const MAX_IMAGE_QUERY_PAGES = 100;
const MAX_IMAGE_RECORDS = 20_000;
const MAX_CONCURRENT_DOWNLOADS = 4;
const QUERY_TIMEOUT_MS = 20_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SYNC_IMAGE_BYTES = 1024 * 1024 * 1024;
const IMAGE_INDEX_FILE = 'synced-images.json';
const PLATFORM_IMAGE_REFERENCE_PREFIX = 'editor-image://platform/';
const ICON_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif|svg)$/i;
const SVG_SNIPPET_PATTERN = /<svg[\s>]/i;
const MAX_SVG_PROBE_BYTES = 4096;

type ImageSyncContext = {
  baseUrl: string;
  editorRoot: string;
};

type ActiveImageSync = {
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
};

/** 数据中台图标记录，仅保留图片同步关心的字段。 */
type IconRecord = {
  id: string;
  iconKey: string;
  name: string;
  category?: string;
  sortOrder?: number;
  updatedAt: string;
  iconUrl: string;
};

type ImageDownloadJob = {
  record: IconRecord;
  stagedPath: string;
  destinationPath: string;
  plannedFileName: string | null;
};

let activeImageSync: ActiveImageSync | null = null;
let latestImageSyncProgress: DataPlatformImageSyncProgress | null = null;
let lastImageSyncContext: ImageSyncContext | null = null;
let imageSyncShuttingDown = false;

/** 启动数据中台图标图片同步；已有任务运行时直接复用，不创建并发覆盖任务。 */
export function startDataPlatformImageSync(baseUrl: string, editorRoot: string): boolean {
  if (imageSyncShuttingDown || activeImageSync) return false;

  const context = { baseUrl, editorRoot };
  lastImageSyncContext = context;
  const runId = randomUUID();
  const controller = new AbortController();
  const promise = runDataPlatformImageSync(runId, context, controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted && imageSyncShuttingDown) return;
      const message = toErrorMessage(error);
      updateImageSyncProgress({
        runId,
        phase: 'failed',
        completed: latestImageSyncProgress?.runId === runId ? latestImageSyncProgress.completed : 0,
        total: latestImageSyncProgress?.runId === runId ? latestImageSyncProgress.total : 0,
        message: '数据中台图片同步失败，已保留原图片库。',
        error: message,
      });
    })
    .finally(() => {
      if (activeImageSync?.runId === runId) activeImageSync = null;
    });

  activeImageSync = { runId, controller, promise };
  return true;
}

/** 失败后按最近一次 Base URL 与编辑器目录重新发起同步。 */
export function retryDataPlatformImageSync(): boolean {
  if (activeImageSync || !lastImageSyncContext || imageSyncShuttingDown) return false;
  return startDataPlatformImageSync(lastImageSyncContext.baseUrl, lastImageSyncContext.editorRoot);
}

/** 返回最近图片同步进度快照，供晚于任务启动挂载的 renderer 补读。 */
export function getLatestDataPlatformImageSyncProgress(): DataPlatformImageSyncProgress | null {
  return latestImageSyncProgress ? { ...latestImageSyncProgress } : null;
}

/** 配置地址变化后清除失败任务的重试上下文，运行中的任务不受影响。 */
export function clearDataPlatformImageSyncRetryContext(): void {
  lastImageSyncContext = null;
}

/** 应用退出时取消并等待当前图片同步任务，避免 staging 残留或索引写入中断。 */
export async function disposeDataPlatformImageSync(): Promise<void> {
  imageSyncShuttingDown = true;
  const active = activeImageSync;
  if (!active) return;
  active.controller.abort();
  await active.promise.catch(() => undefined);
}

/** 读取本地同步图片索引；索引缺失或损坏时返回空列表，不影响同步重建。 */
export async function listSyncedImages(editorRoot: string): Promise<SyncedImageAssetEntry[]> {
  const index = await readImageIndex(editorRoot);
  return index.images;
}

/** 按稳定引用在候选根目录中查找已同步图片，用于发布打包与运行时引用解析。 */
export async function findSyncedImageForReference(
  editorRoots: readonly string[],
  reference: string,
): Promise<SyncedImageAssetEntry | null> {
  const normalizedReference = reference.trim();
  for (const editorRoot of editorRoots) {
    const index = await readImageIndex(editorRoot);
    const matched = index.images.find((entry) => entry.reference === normalizedReference);
    if (matched) return matched;
  }
  return null;
}

/** 判断字符串是否为合法格式的数据中台图片引用，不校验本地登记状态。 */
export function isPlatformImageReference(value: string): boolean {
  if (!value.startsWith(PLATFORM_IMAGE_REFERENCE_PREFIX)) return false;
  const iconKey = value.slice(PLATFORM_IMAGE_REFERENCE_PREFIX.length);
  return ICON_KEY_PATTERN.test(iconKey);
}

function updateImageSyncProgress(progress: DataPlatformImageSyncProgress): void {
  latestImageSyncProgress = { ...progress };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('data-platform:imageSyncProgress', progress);
    }
  }
}

function getImageIndexPath(editorRoot: string): string {
  return path.join(editorRoot, '.babylon-editor', IMAGE_INDEX_FILE);
}

async function readImageIndex(editorRoot: string): Promise<SyncedImageIndex> {
  try {
    const content = await fs.readFile(getImageIndexPath(editorRoot), 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.images)) {
      throw new Error('本地图片同步索引格式不正确。');
    }
    const images = parsed.images.filter((value): value is SyncedImageAssetEntry => {
      if (!isPlainObject(value)) return false;
      return typeof value.id === 'string'
        && typeof value.iconKey === 'string'
        && ICON_KEY_PATTERN.test(value.iconKey)
        && typeof value.name === 'string'
        && typeof value.updatedAt === 'string'
        && typeof value.fileName === 'string'
        && typeof value.filePath === 'string'
        && typeof value.sourceUrl === 'string'
        && typeof value.reference === 'string'
        && value.reference === `${PLATFORM_IMAGE_REFERENCE_PREFIX}${value.iconKey}`;
    });
    return { version: 1, images };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, images: [] };
    return { version: 1, images: [] };
  }
}

async function writeImageIndex(editorRoot: string, index: SyncedImageIndex): Promise<void> {
  const indexPath = getImageIndexPath(editorRoot);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const partialPath = `${indexPath}.partial-${randomUUID()}`;
  await fs.writeFile(partialPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  await fs.rename(partialPath, indexPath);
}

async function runDataPlatformImageSync(
  runId: string,
  context: ImageSyncContext,
  signal: AbortSignal,
): Promise<void> {
  updateImageSyncProgress({
    runId,
    phase: 'querying',
    completed: 0,
    total: 0,
    message: '正在查询数据中台图标库…',
    error: null,
  });
  const records = await queryAllIcons(context.baseUrl, signal);

  const currentIndex = await readImageIndex(context.editorRoot);
  const knownByIconKey = new Map(currentIndex.images.map((entry) => [entry.iconKey, entry]));
  const imagesRoot = getProjectImagesRoot(context.editorRoot);
  const stagingRoot = path.join(
    context.editorRoot,
    '.babylon-editor',
    `data-platform-image-sync-${runId}`,
  );
  assertPathInside(context.editorRoot, stagingRoot, '图片同步暂存目录');
  await fs.rm(stagingRoot, { recursive: true, force: true });
  const stagingImagesRoot = path.join(stagingRoot, 'Assets', 'Images');
  await fs.mkdir(stagingImagesRoot, { recursive: true });

  const jobs: ImageDownloadJob[] = [];
  for (const record of records) {
    const existing = knownByIconKey.get(record.iconKey);
    if (existing && existing.updatedAt === record.updatedAt) continue;

    // 中台 iconUrl 可能不带图片扩展名（下载接口或相对路径），先统一暂存，
    // 下载后按 Content-Type 与文件头校验得出真实扩展名，避免误跳过。
    const plannedExtension = resolveImageExtension(record.iconUrl);
    const plannedFileName = plannedExtension ? `${record.iconKey}${plannedExtension}` : null;
    const stagedPath = path.join(stagingImagesRoot, `${record.iconKey}.part`);
    assertPathInside(stagingRoot, stagedPath, '图片暂存路径');
    jobs.push({
      record,
      stagedPath,
      destinationPath: plannedFileName ? path.join(imagesRoot, plannedFileName) : stagedPath,
      plannedFileName,
    });
  }

  let completedJobs = 0;
  const failedIconKeys: string[] = [];
  const verifiedFileNames = new Map<string, string>();

  if (jobs.length > 0) {
    updateImageSyncProgress({
      runId,
      phase: 'downloading',
      completed: 0,
      total: jobs.length,
      message: `正在下载 ${jobs.length} 张中台图标…`,
      error: null,
    });

    await runWithConcurrency(jobs, MAX_CONCURRENT_DOWNLOADS, async (job) => {
      // 单张失败不中断整批同步：记录失败项并继续其余下载。
      try {
        const result = await downloadRemoteFile({
          baseUrl: context.baseUrl,
          remoteUrl: job.record.iconUrl,
          destinationPath: job.stagedPath,
          maxBytes: MAX_IMAGE_FILE_BYTES,
          signal,
          timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
          context: `下载图标 ${job.record.iconKey}`,
        });
        const verifiedExtension = verifyImageFile(job.stagedPath, result.contentType);
        if (!verifiedExtension) {
          throw new Error(`图标 ${job.record.iconKey} 不是可识别的图片或 SVG 文件。`);
        }
        verifiedFileNames.set(job.record.iconKey, `${job.record.iconKey}${verifiedExtension}`);
      } catch {
        failedIconKeys.push(job.record.iconKey);
      }
    });
    completedJobs = jobs.length;
  }

  updateImageSyncProgress({
    runId,
    phase: 'validating',
    completed: completedJobs,
    total: jobs.length,
    message: '正在校验图片文件并写入图片库…',
    error: null,
  });

  updateImageSyncProgress({
    runId,
    phase: 'promoting',
    completed: completedJobs,
    total: jobs.length,
    message: '正在更新本地图片库索引…',
    error: null,
  });

  let downloadedBytes = 0;
  for (const job of jobs) {
    if (failedIconKeys.includes(job.record.iconKey)) continue;
    const stat = await fs.stat(job.stagedPath);
    downloadedBytes += stat.size;
    if (downloadedBytes > MAX_SYNC_IMAGE_BYTES) {
      throw new Error('图片同步下载总量超过 1 GB 限制。');
    }
    const finalFileName = verifiedFileNames.get(job.record.iconKey) ?? job.plannedFileName;
    if (!finalFileName) continue;
    const finalDestination = path.join(imagesRoot, finalFileName);
    await fs.mkdir(path.dirname(finalDestination), { recursive: true });
    await fs.copyFile(job.stagedPath, finalDestination);
    authorizeAssetFile(finalDestination);
  }

  const nextEntries = buildMergedIndex(records, knownByIconKey, imagesRoot, failedIconKeys, verifiedFileNames);
  await writeImageIndex(context.editorRoot, { version: 1, images: nextEntries });

  const failureDetail = failedIconKeys.length > 0
    ? `；${failedIconKeys.length} 个图标下载或校验失败，已保留其旧登记`
    : '';
  updateImageSyncProgress({
    runId,
    phase: 'completed',
    completed: completedJobs,
    total: jobs.length,
    message: `图片同步完成：共 ${nextEntries.length} 张可用图片${failureDetail}。`,
    error: null,
  });

  // 清理本次暂存目录，避免同步多次后残留 staging 文件。
  await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
}

/** 合并中台记录与本地登记：保留软删除图标的旧条目，失败项沿用旧登记，避免破坏已有场景引用。 */
function buildMergedIndex(
  records: IconRecord[],
  knownByIconKey: Map<string, SyncedImageAssetEntry>,
  imagesRoot: string,
  failedIconKeys: string[],
  verifiedFileNames: ReadonlyMap<string, string>,
): SyncedImageAssetEntry[] {
  const remoteKeys = new Set(records.map((record) => record.iconKey));
  const entries: SyncedImageAssetEntry[] = [];

  for (const record of records) {
    const existing = knownByIconKey.get(record.iconKey);
    if (failedIconKeys.includes(record.iconKey)) {
      if (existing) entries.push(existing);
      continue;
    }
    const fileName = verifiedFileNames.get(record.iconKey);
    if (!fileName) {
      if (existing) entries.push(existing);
      continue;
    }
    const filePath = path.join(imagesRoot, fileName);
    entries.push({
      id: record.id,
      iconKey: record.iconKey,
      name: record.name,
      category: record.category,
      sortOrder: record.sortOrder,
      updatedAt: record.updatedAt,
      fileName,
      filePath,
      sourceUrl: encodeAssetUrl(filePath),
      reference: `${PLATFORM_IMAGE_REFERENCE_PREFIX}${record.iconKey}`,
    });
  }

  // 中台已软删除的图标：保留本地条目与文件，图片库渲染时按 remoteKeys 过滤隐藏。
  for (const existing of knownByIconKey.values()) {
    if (!remoteKeys.has(existing.iconKey)) entries.push(existing);
  }

  entries.sort((left, right) => {
    const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });
  return entries;
}

async function queryAllIcons(baseUrl: string, signal: AbortSignal): Promise<IconRecord[]> {
  const records: IconRecord[] = [];

  for (let pageNum = 1; pageNum <= MAX_IMAGE_QUERY_PAGES; pageNum += 1) {
    const payload = await requestDataPlatformJson({
      baseUrl,
      endpointPath: IMAGE_QUERY_PATH,
      body: {
        pageNum,
        pageSize: IMAGE_QUERY_PAGE_SIZE,
        iconSource: 'CUSTOM',
      },
      signal,
      timeoutMs: QUERY_TIMEOUT_MS,
      context: '查询数据中台图标库',
    });
    const page = normalizePagedResponse(payload);
    records.push(...page.records);

    if (records.length > MAX_IMAGE_RECORDS) {
      throw new Error(`数据中台图标数量超过 ${MAX_IMAGE_RECORDS} 项限制。`);
    }
    if (page.records.length === 0 || page.records.length < IMAGE_QUERY_PAGE_SIZE || records.length >= page.total) {
      return records;
    }
  }

  throw new Error(`数据中台图标分页超过 ${MAX_IMAGE_QUERY_PAGES} 页限制。`);
}

function normalizePagedResponse(value: unknown): { records: IconRecord[]; total: number } {
  if (!isPlainObject(value)) throw new Error('数据中台图标库响应结构不正确。');
  if (value.success !== true) {
    const message = normalizeOptionalString(value.message) ?? '数据中台图标库查询失败。';
    throw new Error(message);
  }
  if (!isPlainObject(value.data) || !Array.isArray(value.data.records)) {
    throw new Error('数据中台图标库响应缺少 data.records。');
  }
  const records: IconRecord[] = [];
  value.data.records.forEach((raw, index) => {
    const record = normalizeIconRecord(raw, index);
    if (record) records.push(record);
  });
  return {
    records,
    total: normalizeNonNegativeInteger(value.data.total, records.length),
  };
}

/** 收窄图标记录：仅接受 CUSTOM 来源、IMAGE/SVG 类型、ACTIVE 状态且带 iconUrl 的合法图标。 */
function normalizeIconRecord(value: unknown, index: number): IconRecord | null {
  if (!isPlainObject(value)) {
    throw new Error(`数据中台图标第 ${index + 1} 项不是对象。`);
  }
  const id = normalizeRequiredId(value.id, index);
  const iconKey = normalizeOptionalString(value.iconKey);
  const name = normalizeOptionalString(value.iconName);
  const iconUrl = normalizeOptionalString(value.iconUrl);
  if (!iconKey || !ICON_KEY_PATTERN.test(iconKey)) return null;
  if (!name) return null;
  if (!iconUrl) return null;
  const iconType = normalizeOptionalString(value.iconType)?.toUpperCase();
  if (iconType !== 'IMAGE' && iconType !== 'SVG') return null;
  const iconSource = normalizeOptionalString(value.iconSource)?.toUpperCase();
  if (iconSource !== 'CUSTOM') return null;
  const status = normalizeOptionalString(value.status)?.toUpperCase();
  if (status === 'DELETED') return null;
  const updatedAt = normalizeOptionalString(value.updatedAt);
  if (!updatedAt) return null;

  return {
    id,
    iconKey,
    name,
    category: normalizeOptionalString(value.category) ?? undefined,
    sortOrder: normalizeNonNegativeInteger(value.sortOrder, 1000),
    updatedAt,
    iconUrl,
  };
}

/** 从图标 URL 推导允许的图片扩展名，拒绝未知格式。 */
function resolveImageExtension(iconUrl: string): string | null {
  try {
    const parsed = new URL(iconUrl);
    const match = IMAGE_EXTENSION_PATTERN.exec(parsed.pathname);
    if (!match) return null;
    const extension = match[1].toLowerCase();
    if (extension === 'jpeg') return '.jpg';
    return `.${extension}`;
  } catch {
    return null;
  }
}

/** 通过文件头校验图片内容可解码，SVG 按文本片段探测。 */
function verifyImageFile(filePath: string, contentType: string): string | null {
  const normalizedContentType = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const declaredExtension = IMAGE_EXTENSION_BY_CONTENT_TYPE[normalizedContentType];
  if (declaredExtension && declaredExtension !== '.svg') {
    return declaredExtension;
  }

  let fd: number | null = null;
  try {
    const buffer = Buffer.alloc(32);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);

    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return '.png';
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
    if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    if (head.length >= 6 && (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a')) return '.gif';

    const probe = Buffer.alloc(MAX_SVG_PROBE_BYTES);
    readSync(fd, probe, 0, probe.length, 0);
    const probeText = probe.toString('utf8');
    if (SVG_SNIPPET_PATTERN.test(probeText)) return '.svg';
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不影响校验结果。
      }
    }
  }
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners: Promise<void>[] = [];
  const limitedConcurrency = Math.max(1, concurrency);
  for (let i = 0; i < Math.min(limitedConcurrency, values.length); i += 1) {
    runners.push((async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(values[currentIndex]);
      }
    })());
  }
  await Promise.all(runners);
}

function normalizeRequiredId(value: unknown, index: number): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^\d{1,64}$/.test(normalized)) return normalized;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new Error(`数据中台图标第 ${index + 1} 项 id 无效。`);
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
  return Number.isFinite(normalized) && normalized >= 0 ? Math.trunc(normalized) : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
