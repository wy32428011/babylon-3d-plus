import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const DEFAULT_MAX_SOURCE_FILES = 200_000;
const COPY_PROGRESS_INTERVAL_MS = 80;

/** 导出资产清单中的资源分类。 */
export type DeploymentAssetKind =
  | 'model'
  | 'environment'
  | 'cad'
  | 'script'
  | 'texture'
  | 'buffer'
  | 'metadata'
  | 'asset';

/** 安全预检后得到的源文件快照。 */
export type SafeSourceFile = {
  sourcePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
};

/** 需要复制到 staging 的单个文件。 */
export type DeploymentCopyFile = SafeSourceFile & {
  destinationRelativePath: string;
  kind: DeploymentAssetKind;
  logicalUrl?: string;
};

/** 单个已复制文件的哈希结果。 */
export type DeploymentCopiedFile = DeploymentCopyFile & {
  sha256: string;
};

/** 并发复制阶段的累计进度。 */
export type DeploymentCopyProgress = {
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
};

/** 创建统一的导出取消异常，便于 IPC 层收口取消结果。 */
export function createDeploymentExportAbortError(): Error {
  const error = new Error('导出已取消。');
  error.name = 'AbortError';
  return error;
}

/** 判断未知异常是否代表主动取消。 */
export function isDeploymentExportAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 在长耗时步骤之间检查取消信号。 */
export function throwIfDeploymentExportAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createDeploymentExportAbortError();
}

/** Windows 下按不区分大小写的方式生成本地路径比较键。 */
export function toLocalPathKey(filePath: string): string {
  const normalizedPath = path.resolve(filePath);
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

/** 判断 candidate 是否等于 root 或位于 root 内。 */
export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/** 判断两个路径是否存在包含关系，用于阻止导出输出递归进入源目录。 */
export function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left);
}

/** 将部署相对路径统一转换为正斜杠格式。 */
export function toDeploymentPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/** 将受控相对路径解析到 staging 内，并拒绝路径逃逸。 */
export function resolveDeploymentDestination(stagingRoot: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('导出目标相对路径格式不正确。');
  }

  const destinationPath = path.resolve(stagingRoot, relativePath);
  if (!isPathInsideOrEqual(stagingRoot, destinationPath) || destinationPath === path.resolve(stagingRoot)) {
    throw new Error('导出目标路径逃逸 staging 目录。');
  }

  return destinationPath;
}

/** 读取路径状态；路径不存在时返回 null。 */
export async function lstatIfExists(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** 校验目录存在、不是符号链接或 Junction，并返回 realpath。 */
export async function assertSafeDirectory(directoryPath: string, label: string): Promise<string> {
  const normalizedPath = path.resolve(directoryPath);
  const stat = await lstatIfExists(normalizedPath);

  if (!stat) throw new Error(`${label}不存在。`);
  if (stat.isSymbolicLink()) throw new Error(`${label}不能是符号链接或 Junction。`);
  if (!stat.isDirectory()) throw new Error(`${label}不是目录。`);

  return fs.realpath(normalizedPath);
}

/** 校验源根目录与输出路径不重叠，避免递归复制 staging 或正式结果。 */
export function assertNoSourceOutputOverlap(sourceRoot: string, forbiddenOutputPaths: string[]): void {
  for (const outputPath of forbiddenOutputPaths) {
    if (pathsOverlap(sourceRoot, outputPath)) {
      throw new Error('资源目录与导出输出位置重叠，已拒绝可能的递归导出。');
    }
  }
}

/**
 * 安全枚举一个资源根目录。
 * includeRelativePaths 为 null 时复制完整目录；否则只枚举明确文件，并逐级拒绝链接与路径逃逸。
 */
export async function scanSafeSourceRoot(
  sourceRoot: string,
  includeRelativePaths: ReadonlySet<string> | null,
  forbiddenOutputPaths: string[],
  signal: AbortSignal,
  maxFiles = DEFAULT_MAX_SOURCE_FILES,
): Promise<SafeSourceFile[]> {
  throwIfDeploymentExportAborted(signal);
  const normalizedRoot = path.resolve(sourceRoot);
  const realRoot = await assertSafeDirectory(normalizedRoot, '资源根目录');
  assertNoSourceOutputOverlap(realRoot, forbiddenOutputPaths);

  const files = includeRelativePaths === null
    ? await scanCompleteDirectory(normalizedRoot, realRoot, signal, maxFiles)
    : await scanExplicitFiles(normalizedRoot, realRoot, includeRelativePaths, signal, maxFiles);

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return files;
}

/** 递归枚举完整资源包，并拒绝目录树中的链接、特殊文件和 realpath 逃逸。 */
async function scanCompleteDirectory(
  normalizedRoot: string,
  realRoot: string,
  signal: AbortSignal,
  maxFiles: number,
): Promise<SafeSourceFile[]> {
  const files: SafeSourceFile[] = [];
  const pendingDirectories: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: normalizedRoot, relativePath: '', depth: 0 },
  ];

  while (pendingDirectories.length > 0) {
    throwIfDeploymentExportAborted(signal);
    const current = pendingDirectories.pop();
    if (!current) break;
    if (current.depth > 128) throw new Error('资源目录层级过深，已停止导出。');

    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const entry of entries) {
      throwIfDeploymentExportAborted(signal);
      const absolutePath = path.join(current.absolutePath, entry.name);
      const relativePath = path.join(current.relativePath, entry.name);
      const stat = await fs.lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        throw new Error(`资源包包含符号链接或 Junction：${toDeploymentPath(relativePath)}`);
      }

      const realPath = await fs.realpath(absolutePath);
      if (!isPathInsideOrEqual(realRoot, realPath)) {
        throw new Error(`资源路径逃逸资源根目录：${toDeploymentPath(relativePath)}`);
      }

      if (stat.isDirectory()) {
        pendingDirectories.push({ absolutePath, relativePath, depth: current.depth + 1 });
        continue;
      }

      if (!stat.isFile()) {
        throw new Error(`资源包包含不支持的特殊文件：${toDeploymentPath(relativePath)}`);
      }

      files.push(createSafeSourceFile(realPath, relativePath, stat.size, stat.mtimeMs));
      if (files.length > maxFiles) throw new Error(`资源文件数量超过安全上限 ${maxFiles}。`);
    }
  }

  return files;
}

/** 只枚举调用方明确列出的文件，并验证从根目录到文件的每一级路径都不是链接。 */
async function scanExplicitFiles(
  normalizedRoot: string,
  realRoot: string,
  includeRelativePaths: ReadonlySet<string>,
  signal: AbortSignal,
  maxFiles: number,
): Promise<SafeSourceFile[]> {
  if (includeRelativePaths.size > maxFiles) throw new Error(`资源文件数量超过安全上限 ${maxFiles}。`);
  const files: SafeSourceFile[] = [];
  const seenRealPaths = new Set<string>();

  for (const rawRelativePath of includeRelativePaths) {
    throwIfDeploymentExportAborted(signal);
    const relativePath = path.normalize(rawRelativePath);
    if (!relativePath || relativePath === '.' || path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`) || relativePath === '..') {
      throw new Error('明确资源文件路径逃逸资源根目录。');
    }

    const absolutePath = path.resolve(normalizedRoot, relativePath);
    if (!isPathInsideOrEqual(normalizedRoot, absolutePath)) {
      throw new Error('明确资源文件路径逃逸资源根目录。');
    }

    await assertPathChainHasNoLinks(normalizedRoot, relativePath);
    const stat = await lstatIfExists(absolutePath);
    if (!stat) throw new Error(`资源文件缺失：${toDeploymentPath(relativePath)}`);
    if (stat.isSymbolicLink()) throw new Error(`资源文件不能是符号链接或 Junction：${toDeploymentPath(relativePath)}`);
    if (!stat.isFile()) throw new Error(`资源引用不是普通文件：${toDeploymentPath(relativePath)}`);

    const realPath = await fs.realpath(absolutePath);
    if (!isPathInsideOrEqual(realRoot, realPath)) {
      throw new Error(`资源文件 realpath 逃逸资源根目录：${toDeploymentPath(relativePath)}`);
    }

    const realPathKey = toLocalPathKey(realPath);
    if (seenRealPaths.has(realPathKey)) continue;
    seenRealPaths.add(realPathKey);
    files.push(createSafeSourceFile(realPath, relativePath, stat.size, stat.mtimeMs));
  }

  return files;
}

/** 校验明确文件的每一级父目录，防止父目录通过 Junction 跳出资源根。 */
async function assertPathChainHasNoLinks(rootPath: string, relativePath: string): Promise<void> {
  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = rootPath;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatIfExists(currentPath);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`资源路径包含符号链接或 Junction：${toDeploymentPath(path.relative(rootPath, currentPath))}`);
    }
  }
}

/** 构造只包含复制校验所需字段的源文件快照。 */
function createSafeSourceFile(sourcePath: string, relativePath: string, size: number, mtimeMs: number): SafeSourceFile {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('资源文件大小超出安全范围。');

  return {
    sourcePath,
    relativePath: toDeploymentPath(relativePath),
    size,
    mtimeMs,
  };
}

/** 以固定并发数流式复制文件，同时计算 SHA-256 并汇报累计进度。 */
export async function copyDeploymentFiles(
  files: DeploymentCopyFile[],
  stagingRoot: string,
  concurrency: number,
  signal: AbortSignal,
  onProgress: (progress: DeploymentCopyProgress) => void,
): Promise<DeploymentCopiedFile[]> {
  const safeConcurrency = Math.max(1, Math.min(16, Math.floor(concurrency)));
  const totalBytes = files.reduce((sum, file) => addSafeByteCount(sum, file.size), 0);
  const copiedFiles: DeploymentCopiedFile[] = new Array(files.length);
  const destinationKeys = new Set<string>();
  let nextIndex = 0;
  let completedFiles = 0;
  let completedBytes = 0;
  let lastProgressAt = 0;

  for (const file of files) {
    const destinationPath = resolveDeploymentDestination(stagingRoot, file.destinationRelativePath);
    const destinationKey = toLocalPathKey(destinationPath);
    if (destinationKeys.has(destinationKey)) {
      throw new Error(`导出目标文件冲突：${file.destinationRelativePath}`);
    }
    destinationKeys.add(destinationKey);
  }

  let firstWorkerError: unknown;
  let workerFailed = false;
  const workerController = new AbortController();
  const abortWorkersFromParent = (): void => workerController.abort();
  if (signal.aborted) workerController.abort();
  else signal.addEventListener('abort', abortWorkersFromParent, { once: true });
  const workerSignal = workerController.signal;

  /** 汇总并限频发送复制进度，避免大文件产生过量 IPC 消息。 */
  const reportProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < COPY_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    onProgress({ completedFiles, totalFiles: files.length, completedBytes, totalBytes });
  };

  /** 单个并发 worker 按共享游标领取文件；任一失败会中止同组流并等待全部关闭。 */
  const runWorker = async (): Promise<void> => {
    try {
      while (true) {
        throwIfDeploymentExportAborted(workerSignal);
        const currentIndex = nextIndex;
        nextIndex += 1;
        const file = files[currentIndex];
        if (!file) return;

        const destinationPath = resolveDeploymentDestination(stagingRoot, file.destinationRelativePath);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        const copied = await copySingleFileWithHash(file, destinationPath, workerSignal, (chunkSize) => {
          completedBytes = addSafeByteCount(completedBytes, chunkSize);
          reportProgress(false);
        });

        copiedFiles[currentIndex] = copied;
        completedFiles += 1;
        reportProgress(true);
      }
    } catch (error) {
      if (!workerFailed) {
        workerFailed = true;
        firstWorkerError = error;
      }
      workerController.abort();
      throw error;
    }
  };

  try {
    reportProgress(true);
    const workerCount = Math.min(safeConcurrency, Math.max(files.length, 1));
    await Promise.allSettled(Array.from({ length: workerCount }, () => runWorker()));
    if (workerFailed) throw firstWorkerError;
    return copiedFiles;
  } finally {
    signal.removeEventListener('abort', abortWorkersFromParent);
    workerController.abort();
  }
}

/** 流式复制单个文件并在读取过程中计算哈希，复制前后校验文件快照未变化。 */
async function copySingleFileWithHash(
  file: DeploymentCopyFile,
  destinationPath: string,
  signal: AbortSignal,
  onChunk: (chunkSize: number) => void,
): Promise<DeploymentCopiedFile> {
  throwIfDeploymentExportAborted(signal);
  const beforeStat = await fs.lstat(file.sourcePath);
  if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
    throw new Error(`资源文件在复制前已变为不安全类型：${file.relativePath}`);
  }
  if (beforeStat.size !== file.size || beforeStat.mtimeMs !== file.mtimeMs) {
    throw new Error(`资源文件在预检后发生变化：${file.relativePath}`);
  }

  const hash = createHash('sha256');
  const input = createReadStream(file.sourcePath, { signal });
  const output = createWriteStream(destinationPath, { flags: 'wx' });
  let copiedBytes = 0;

  input.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    copiedBytes += chunk.byteLength;
    onChunk(chunk.byteLength);
  });

  try {
    await pipeline(input, output, { signal });
  } catch (error) {
    await fs.rm(destinationPath, { force: true }).catch(() => undefined);
    if (signal.aborted) throw createDeploymentExportAbortError();
    throw error;
  }

  if (copiedBytes !== file.size) {
    await fs.rm(destinationPath, { force: true }).catch(() => undefined);
    throw new Error(`资源文件复制字节数不一致：${file.relativePath}`);
  }

  return { ...file, sha256: hash.digest('hex') };
}

/** 累加文件字节数，并在超过 JavaScript 安全整数时立即失败。 */
function addSafeByteCount(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error('导出资源总大小超过安全范围。');
  return result;
}

/** 判断未知异常是否带有指定 Node.js 错误码。 */
function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
