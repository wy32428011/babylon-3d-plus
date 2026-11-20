import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DataPlatformEnvironmentRecord } from './dataPlatformEnvironmentContract.js';
import {
  assertTrustedEnvironmentPath,
  ensureTrustedEnvironmentDirectory,
  getCachedEnvironmentThumbnailPath,
  hashFileSha256,
  type DataPlatformEnvironmentIndexEntry,
  type EnvironmentThumbnail,
} from './dataPlatformEnvironmentIndex.js';
import { queryDataPlatformModelPages } from './dataPlatformModelCatalog.js';
import { getDataPlatformThumbnailExtension, MAX_THUMBNAIL_FILE_BYTES } from './dataPlatformModelThumbnail.js';
import {
  assertPathInside,
  resolveDataPlatformRemoteUrl,
  type downloadRemoteFile,
  type requestDataPlatformJson,
} from './dataPlatformTransfer.js';

export type EnvironmentThumbnailChange = {
  thumbnail: EnvironmentThumbnail;
  stagedPath?: string;
};

export type EnvironmentThumbnailSyncContext = {
  baseUrl: string;
  editorRoot: string;
  stagingRoot: string;
  signal: AbortSignal;
  requestJson: typeof requestDataPlatformJson;
  downloadFile: typeof downloadRemoteFile;
  remainingBytes: () => number;
  consumeBytes: (bytes: number) => void;
};

export async function queryEnvironmentThumbnailCatalog(
  context: EnvironmentThumbnailSyncContext,
  selectedIds: ReadonlySet<string>,
): Promise<Map<string, unknown>> {
  const rows = await queryDataPlatformModelPages(context.baseUrl, 'api/v1/env-models/query',
    '环境模型目录', 'modelName', context.signal, context.requestJson);
  const byId = new Map<string, unknown>();
  for (const row of rows) {
    const id = isRecord(row) ? decimalToken(row.id) : null;
    if (id && selectedIds.has(id)) byId.set(id, byId.has(id) ? null : row);
  }
  return byId;
}

export async function needsEnvironmentThumbnailSync(
  editorRoot: string,
  record: DataPlatformEnvironmentRecord,
  entry: DataPlatformEnvironmentIndexEntry,
): Promise<boolean> {
  const previous = entry.thumbnail;
  if (!previous || record.updatedAt === null || previous.updatedAt !== record.updatedAt) return true;
  return previous.file !== null && !await getCachedEnvironmentThumbnailPath(editorRoot, entry, previous.file);
}

export async function stageEnvironmentThumbnail(
  context: EnvironmentThumbnailSyncContext,
  record: DataPlatformEnvironmentRecord,
  entry: DataPlatformEnvironmentIndexEntry,
  catalog?: ReadonlyMap<string, unknown>,
): Promise<EnvironmentThumbnailChange> {
  const { baseUrl, editorRoot, stagingRoot, signal } = context;
  signal.throwIfAborted();
  const updatedAt = record.updatedAt;

  const row = catalog ? catalog.get(record.id) : await queryEnvironmentDetail(context, record.id);
  if (!isRecord(row) || decimalToken(row.id) !== record.id || decimalToken(row.fileRevision) !== record.fileRevision
    || (row.updatedAt ?? null) !== updatedAt) {
    throw new Error('目录或详情未返回与同步清单 ID、文件修订和更新时间匹配的唯一记录。');
  }
  const url = row.thumbnailUrl;
  if (url != null && typeof url !== 'string') throw new Error('缩略图地址格式无效。');
  const remoteUrl = url?.trim();
  if (!remoteUrl) return { thumbnail: { updatedAt, file: null } };

  const resolved = resolveDataPlatformRemoteUrl(baseUrl, remoteUrl);

  const stagedPath = path.join(stagingRoot, 'thumbnails', record.id, 'image.download');
  assertPathInside(stagingRoot, stagedPath, '环境缩略图 staging 文件');
  await ensureTrustedEnvironmentDirectory(editorRoot, path.dirname(stagedPath), '环境缩略图 staging 目录');
  await assertTrustedEnvironmentPath(editorRoot, stagedPath, '环境缩略图 staging 文件');
  const maxBytes = Math.min(MAX_THUMBNAIL_FILE_BYTES, context.remainingBytes());
  if (maxBytes <= 0) throw new Error('本轮下载或缓存空间已达上限。');
  let reportedBytes = 0;
  const result = await context.downloadFile({
    baseUrl, remoteUrl, destinationPath: stagedPath, maxBytes, signal, timeoutMs: 60_000,
    context: `下载环境模型“${entry.displayName}”缩略图`,
    onBytes(bytes) {
      reportedBytes += bytes;
      context.consumeBytes(bytes);
    },
  });
  signal.throwIfAborted();
  const extension = getDataPlatformThumbnailExtension(resolved.href, result.contentType);
  if (!extension) throw new Error('缩略图文件类型不受支持。');
  await assertTrustedEnvironmentPath(editorRoot, stagedPath, '环境缩略图 staging 文件');
  const stat = await fs.lstat(stagedPath);
  if (!stat.isFile() || !stat.size || stat.size > maxBytes || stat.size !== result.bytes) {
    throw new Error('缩略图文件为空或大小与下载结果不一致。');
  }
  if (stat.size > reportedBytes) context.consumeBytes(stat.size - reportedBytes);
  const sha256 = await hashFileSha256(stagedPath);
  return { stagedPath, thumbnail: { updatedAt, file: { sha256, extension, sizeBytes: stat.size } } };
}

async function queryEnvironmentDetail(context: EnvironmentThumbnailSyncContext, id: string): Promise<unknown> {
  const response = await context.requestJson({
    baseUrl: context.baseUrl, endpointPath: 'api/v1/env-models/detail', body: { id },
    signal: context.signal, timeoutMs: 20_000, context: `查询环境模型 ${id} 缩略图`,
  });
  if (!isRecord(response) || response.success !== true || !isRecord(response.data)) {
    throw new Error('环境模型详情不可用。');
  }
  return response.data;
}

function decimalToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value.trim()) ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
