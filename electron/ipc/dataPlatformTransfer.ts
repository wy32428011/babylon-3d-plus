import { net } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Readable } from 'node:stream';

const require = createRequire(import.meta.url);

const MAX_ERROR_RESPONSE_BYTES = 32 * 1024;
const MAX_JSON_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 100_000;
const MAX_ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024;

export type DownloadRemoteFileOptions = {
  baseUrl: string;
  remoteUrl: string;
  destinationPath: string;
  maxBytes: number;
  signal: AbortSignal;
  timeoutMs: number;
  context: string;
  onBytes?: (bytes: number) => void;
};

export type DownloadRemoteFileResult = {
  bytes: number;
  contentType: string;
  finalUrl: string;
};

type UnzipEntry = {
  path: string;
  type: 'Directory' | 'File';
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  externalFileAttributes: number;
  stream: () => Readable;
};

type UnzipDirectory = {
  files: UnzipEntry[];
};

type UnzipperModule = {
  Open: {
    file: (archivePath: string) => Promise<UnzipDirectory>;
  };
};

const unzipper = require('unzipper') as UnzipperModule;

/** 回滚不完整时要求调用方保留 staging/backup，避免清理掉唯一可恢复副本。 */
export class DataPlatformRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPlatformRollbackError';
  }
}

/** 按数据中台 Base URL 解析相对下载地址，并拒绝危险协议与内嵌凭据。 */
export function resolveDataPlatformRemoteUrl(baseUrl: string, value: string): URL {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('数据中台返回了空的文件地址。');
  }

  let resolved: URL;
  try {
    resolved = new URL(value.trim(), `${baseUrl.replace(/\/+$/, '')}/`);
  } catch {
    throw new Error(`数据中台文件地址格式不正确：${value}`);
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`数据中台文件地址仅支持 HTTP/HTTPS：${resolved.protocol}`);
  }
  if (resolved.username || resolved.password) {
    throw new Error('数据中台文件地址不能包含账号或密码。');
  }

  resolved.hash = '';
  return resolved;
}

/** 判断 candidate 是否严格位于 root 内部。 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 校验待操作路径位于预期根目录，防止计算路径越界。 */
export function assertPathInside(root: string, candidate: string, label: string): void {
  if (!isPathInside(root, candidate)) {
    throw new Error(`${label} 超出允许目录。`);
  }
}

/** 发起有大小上限和超时控制的 JSON POST 请求。 */
export async function requestDataPlatformJson(options: {
  baseUrl: string;
  endpointPath: string;
  body: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  context: string;
}): Promise<unknown> {
  const endpoint = resolveDataPlatformRemoteUrl(options.baseUrl, options.endpointPath);
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromParent = () => requestController.abort();
  options.signal.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, options.timeoutMs);

  try {
    if (options.signal.aborted) throw createCanceledError();

    const response = await net.fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.body),
      signal: requestController.signal,
    });
    const responseText = await readResponseTextWithLimit(response, MAX_JSON_RESPONSE_BYTES, options.context);

    if (!response.ok) {
      const detail = readResponseMessage(responseText);
      throw new Error(`${options.context}返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }

    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      throw new Error(`${options.context}响应不是有效 JSON。`);
    }
  } catch (error) {
    if (timedOut) throw new Error(`${options.context}超时，请稍后重试。`);
    if (options.signal.aborted) throw createCanceledError();
    if (error instanceof Error && error.message.startsWith(options.context)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${options.context}失败：${message}`);
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', abortFromParent);
  }
}

/** 以临时文件承接远程响应，完整写入并校验大小后再重命名到目标路径。 */
export async function downloadRemoteFile(options: DownloadRemoteFileOptions): Promise<DownloadRemoteFileResult> {
  const remoteUrl = resolveDataPlatformRemoteUrl(options.baseUrl, options.remoteUrl);
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromParent = () => requestController.abort();
  options.signal.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, options.timeoutMs);
  const partialPath = `${options.destinationPath}.partial-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  try {
    if (options.signal.aborted) throw createCanceledError();
    await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });

    const response = await net.fetch(remoteUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'Cache-Control': 'no-store',
      },
      signal: requestController.signal,
    });

    if (!response.ok) {
      const errorText = await readResponseTextWithLimit(response, MAX_ERROR_RESPONSE_BYTES, options.context);
      const detail = readResponseMessage(errorText);
      throw new Error(`${options.context}返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    if (!response.body) {
      throw new Error(`${options.context}响应没有文件内容。`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      throw new Error(`${options.context}超过允许大小。`);
    }

    handle = await fs.open(partialPath, 'wx');
    let totalBytes = 0;
    for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (options.signal.aborted) throw createCanceledError();
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxBytes) {
        throw new Error(`${options.context}超过允许大小。`);
      }
      await writeBufferFully(handle, chunk);
      options.onBytes?.(chunk.byteLength);
    }

    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(partialPath, options.destinationPath);

    return {
      bytes: totalBytes,
      contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '',
      finalUrl: response.url || remoteUrl.toString(),
    };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // 关闭失败由后续清理兜底，不覆盖原始错误。
      }
    }
    await fs.rm(partialPath, { force: true }).catch(() => undefined);

    if (timedOut) throw new Error(`${options.context}超时，请稍后重试。`);
    if (options.signal.aborted) throw createCanceledError();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', abortFromParent);
  }
}

/** 安全展开 ZIP：预检目录项、路径、符号链接及大小，再逐项流式写入。 */
export async function extractZipSecurely(archivePath: string, destinationRoot: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw createCanceledError();
  const archiveStat = await fs.stat(archivePath);
  if (!archiveStat.isFile()) throw new Error('下载的工程包不是文件。');
  if (archiveStat.size > MAX_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error('工程包压缩文件超过 2 GB 限制。');
  }

  let directory: UnzipDirectory;
  try {
    directory = await unzipper.Open.file(archivePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`工程包 ZIP 损坏或无法读取：${message}`);
  }

  if (directory.files.length > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new Error('工程包文件数量超过 100000 项限制。');
  }

  const normalizedEntries: Array<{ entry: UnzipEntry; relativePath: string }> = [];
  const seenPaths = new Set<string>();
  let declaredTotal = 0;

  for (const entry of directory.files) {
    const relativePath = normalizeArchiveEntryPath(entry.path);
    const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
    if (seenPaths.has(collisionKey)) {
      throw new Error(`工程包包含重复路径：${relativePath}`);
    }
    seenPaths.add(collisionKey);

    if (isZipSymbolicLink(entry.externalFileAttributes)) {
      throw new Error(`工程包不允许包含符号链接：${relativePath}`);
    }
    if ((entry.flags & 0x1) !== 0) {
      throw new Error(`工程包不支持加密文件：${relativePath}`);
    }
    if (entry.type !== 'Directory' && entry.type !== 'File') {
      throw new Error(`工程包包含不支持的条目类型：${relativePath}`);
    }
    if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new Error(`工程包条目大小无效：${relativePath}`);
    }
    if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`工程包单文件超过 100 MB 限制：${relativePath}`);
    }

    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > MAX_ARCHIVE_EXTRACTED_BYTES) {
      throw new Error('工程包展开后总大小超过 8 GB 限制。');
    }
    normalizedEntries.push({ entry, relativePath });
  }

  await fs.mkdir(destinationRoot, { recursive: true });
  let actualTotal = 0;

  for (const { entry, relativePath } of normalizedEntries) {
    if (signal.aborted) throw createCanceledError();
    const targetPath = path.resolve(destinationRoot, ...relativePath.split('/'));
    assertPathInside(destinationRoot, targetPath, '工程包条目路径');

    if (entry.type === 'Directory') {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    let entryBytes = 0;
    const stream = entry.stream();

    try {
      handle = await fs.open(targetPath, 'wx');
      for await (const rawChunk of stream as unknown as AsyncIterable<Uint8Array>) {
        if (signal.aborted) {
          stream.destroy(createCanceledError());
          throw createCanceledError();
        }
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        entryBytes += chunk.byteLength;
        actualTotal += chunk.byteLength;
        if (entryBytes > MAX_ARCHIVE_ENTRY_BYTES) {
          throw new Error(`工程包单文件超过 100 MB 限制：${relativePath}`);
        }
        if (actualTotal > MAX_ARCHIVE_EXTRACTED_BYTES) {
          throw new Error('工程包展开后总大小超过 8 GB 限制。');
        }
        await writeBufferFully(handle, chunk);
      }
      if (entryBytes !== entry.uncompressedSize) {
        throw new Error(`工程包条目实际大小与目录记录不一致：${relativePath}`);
      }
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      stream.destroy();
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function normalizeArchiveEntryPath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('工程包包含无效文件路径。');
  }

  const slashPath = value.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || slashPath.startsWith('//') || /^[a-zA-Z]:/.test(slashPath)) {
    throw new Error(`工程包包含绝对路径：${value}`);
  }

  const normalized = path.posix.normalize(slashPath).replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`工程包包含越界路径：${value}`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`工程包包含无效路径片段：${value}`);
  }

  return normalized;
}

function isZipSymbolicLink(externalFileAttributes: number): boolean {
  const unixMode = (externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function readResponseTextWithLimit(response: Response, maxBytes: number, context: string): Promise<string> {
  if (!response.body) return '';
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`${context}响应过大，已停止读取。`);
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

function readResponseMessage(responseText: string): string {
  if (!responseText.trim()) return '';
  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (isPlainObject(parsed) && typeof parsed.message === 'string') {
      return parsed.message.trim().slice(0, 300);
    }
  } catch {
    return responseText.trim().slice(0, 300);
  }
  return '';
}

async function writeBufferFully(handle: Awaited<ReturnType<typeof fs.open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error('写入文件时未产生进度。');
    offset += result.bytesWritten;
  }
}

function createCanceledError(): Error {
  return new Error('数据中台任务已取消。');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
