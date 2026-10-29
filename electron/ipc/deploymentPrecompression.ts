import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';
import { containsAsciiControlCharactersOr } from '../shared/asciiControlCharacters.ts';
import { resolveDeploymentDestination, scanSafeSourceRoot, throwIfDeploymentExportAborted, toLocalPathKey, type SafeSourceFile } from './deploymentExportFileSystem.js';
import type { DeploymentReleaseCacheManifest } from './deploymentReleaseCacheManifest.js';

const RECEIVER_MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
const RECEIVER_MAX_FILES = 100_000;
const CONTROL_FILES = new Set(['runtime-config.json', 'release-cache-manifest.json', 'published-cache-worker.js']);
type Encoding = 'br' | 'gzip';
type SkipReason = 'not-smaller' | 'file-budget' | 'byte-budget' | 'original-over-budget' | 'existing-path' | 'path-too-long';
type Progress = { phase: 'compressing' | 'committing'; completed: number; total: number };
export type DeploymentPrecompressionOptions = {
  /** 内部验收可缩小预算；生产默认与中台接收端既有上限一致，不为原资源增加新硬失败。 */
  maxUnpackedBytes?: number;
  /** 与接收端ZIP条目上限一致，包含目录；名称仅保留内部测试兼容。 */
  maxFiles?: number;
  concurrency?: number;
  onProgress?: (progress: Progress) => void;
};
export type DeploymentPrecompressionResult = {
  files: Array<{ path: string; sourcePath: string; encoding: Encoding; size: number }>;
  skipped: Array<{ path: string; reason: SkipReason }>;
  diagnostics: string[];
  budget: { maxUnpackedBytes: number; maxFiles: number; originalBytes: number; originalFiles: number;
    originalDirectories: number; originalEntries: number; originalExceedsLimit: boolean; finalBytes: number; finalFiles: number; finalEntries: number };
};
type Work = { file: SafeSourceFile; sourcePath: string; destination: string; relativePath: string; encoding: Encoding; sha256: string };
type Candidate = { work: Work; temporary: string; size: number };

function decodeManifestPath(value: string): string {
  const segments = value.split('/').map(segment => {
    try { return decodeURIComponent(segment); } catch { throw new Error('预压缩清单路径编码无效。'); }
  });
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || containsAsciiControlCharactersOr(segment, '\\/:'))) {
    throw new Error('预压缩清单路径越界。');
  }
  return segments.join('/');
}
/**
 * 侧车必须小于原文件该比例才保留。GLB 多为已压缩二进制（Draco/KTX2），收益不足 10% 的侧车只会
 * 额外占用 ZIP 与 2 GiB 解压预算，因此跳过；其它文本/二进制类型保持“更小即保留”的原规则。
 */
const GLB_MINIMUM_SIZE_RATIO = 0.9;
function minimumRatio(relativePath: string): number {
  return /\.glb$/i.test(relativePath) ? GLB_MINIMUM_SIZE_RATIO : 1;
}
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('预压缩预算参数无效。');
  return result;
}

/** 为已签名的原文件流式生成可选传输表示；清单先写入，侧车永不加入原文件清单。 */
export async function precompressDeploymentFiles(stagingRoot: string, manifest: DeploymentReleaseCacheManifest,
  signal: AbortSignal, options: DeploymentPrecompressionOptions = {}): Promise<DeploymentPrecompressionResult> {
  throwIfDeploymentExportAborted(signal);
  const maxUnpackedBytes = Math.min(RECEIVER_MAX_UNPACKED_BYTES, limit(options.maxUnpackedBytes, RECEIVER_MAX_UNPACKED_BYTES));
  const maxFiles = Math.min(RECEIVER_MAX_FILES, limit(options.maxFiles, RECEIVER_MAX_FILES));
  const concurrency = Math.max(1, Math.min(4, limit(options.concurrency, 2)));
  // 原清单写入会增加一个文件；这里仅盘点预算，不叠加扫描器默认数量硬限制。
  const sources = await scanSafeSourceRoot(stagingRoot, null, [], signal, Number.MAX_SAFE_INTEGER);
  const originalBytes = sources.reduce((total, file) => total + file.size, 0), originalFiles = sources.length;
  const originalDirectories = await countStagedDirectories(stagingRoot, signal);
  const originalEntries = originalFiles + originalDirectories;
  const budget = { maxUnpackedBytes, maxFiles, originalBytes, originalFiles, originalDirectories, originalEntries,
    originalExceedsLimit: originalBytes > maxUnpackedBytes || originalEntries > maxFiles,
    finalBytes: originalBytes, finalFiles: originalFiles, finalEntries: originalEntries };
  const result: DeploymentPrecompressionResult = { files: [], skipped: [], diagnostics: [], budget };
  // 清单使用暂存区逻辑路径；父目录别名不应改变同一文件的匹配结果。
  const byPath = new Map(sources.map(file => [toLocalPathKey(resolveDeploymentDestination(stagingRoot, file.relativePath)), file]));
  const seen = new Set<string>(), work: Work[] = [];
  for (const entry of manifest.files) {
    throwIfDeploymentExportAborted(signal);
    const relativePath = decodeManifestPath(entry.path), sourcePath = resolveDeploymentDestination(stagingRoot, relativePath);
    const key = toLocalPathKey(sourcePath);
    if (seen.has(key)) throw new Error('预压缩清单包含重复路径。');
    seen.add(key);
    const file = byPath.get(key);
    if (!file) throw new Error(`预压缩清单中的原文件不存在：${relativePath}。`);
    if (file.size !== entry.size) throw new Error(`预压缩原文件与清单大小不一致：${relativePath}（清单 ${entry.size} 字节，实际 ${file.size} 字节）。`);
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error(`预压缩清单校验信息无效：${relativePath}。`);
    // B7 的原精度 binary 几何也需要可选传输压缩；解压后的原文仍按原清单校验。
    // GLB 只改传输编码，浏览器解压后字节与原清单 SHA 相同；未压缩环境模型实测可省约 20%。
    if (CONTROL_FILES.has(relativePath.toLowerCase()) || !/\.(?:m?js|css|json|wasm|bin|glb)$/i.test(relativePath)) continue;
    for (const encoding of ['br', 'gzip'] as const) {
      const suffix = encoding === 'br' ? '.br' : '.gz', destination = resolveDeploymentDestination(stagingRoot, relativePath + suffix);
      work.push({ file, sourcePath: relativePath, destination, relativePath: relativePath + suffix, encoding, sha256: entry.sha256.toLowerCase() });
    }
  }
  if (budget.originalExceedsLimit) {
    result.skipped = work.map(item => ({ path: item.relativePath, reason: 'original-over-budget' }));
    result.diagnostics.push('原包已超过接收端既有解压或文件数量预算（' + originalBytes + ' 字节 / ' + originalFiles + ' 文件 / ' + originalDirectories + ' 目录；上限 ' + maxUnpackedBytes + ' 字节 / ' + maxFiles + ' ZIP条目）；仅跳过可选预压缩侧车，原发布流程继续。');
    return result;
  }
  const tasks: Work[] = [];
  for (const item of work) {
    throwIfDeploymentExportAborted(signal);
    // 原文件名合法也可能没有额外的.br/.gz组件余量；该表示必须保持可选。
    const basename = path.basename(item.destination);
    if ((process.platform === 'win32' ? basename.length : Buffer.byteLength(basename, 'utf8')) > 255) {
      result.skipped.push({ path: item.relativePath, reason: 'path-too-long' }); continue;
    }
    try {
      await fs.lstat(item.destination);
      result.skipped.push({ path: item.relativePath, reason: 'existing-path' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENAMETOOLONG') {
        result.skipped.push({ path: item.relativePath, reason: 'path-too-long' }); continue;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      tasks.push(item);
    }
  }
  const controller = new AbortController(), workerSignal = AbortSignal.any([signal, controller.signal]);
  const temporaryFiles = new Set<string>(), committedFiles = new Set<string>();
  const candidates: Array<Candidate | undefined> = new Array(tasks.length);
  let next = 0, completed = 0, failed = false, failure: unknown;
  try {
    const worker = async () => {
      while (!workerSignal.aborted && next < tasks.length) {
        const index = next++, item = tasks[index];
        try {
          const candidate = await compressCandidate(item, workerSignal, temporaryFiles);
          if (candidate.size >= item.file.size * minimumRatio(item.sourcePath)) {
            await fs.rm(candidate.temporary); temporaryFiles.delete(candidate.temporary);
            result.skipped.push({ path: item.relativePath, reason: 'not-smaller' });
          } else candidates[index] = candidate;
          options.onProgress?.({ phase: 'compressing', completed: ++completed, total: tasks.length });
        } catch (error) {
          if (!failed) { failed = true; failure = error; controller.abort(error); }
        }
      }
    };
    // 先停止派发并排空全部在途流，再统一回收；不能边失败返回边遗留写盘任务。
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    throwIfDeploymentExportAborted(signal);
    if (failed) throw failure;
    const retained = candidates.filter((candidate): candidate is Candidate => !!candidate);
    let committed = 0;
    // 按清单及br/gzip固定次序选择预算，不把并发完成顺序写进最终ZIP内容。
    for (const candidate of retained) {
      throwIfDeploymentExportAborted(signal);
      const reason: SkipReason | null = budget.finalEntries + 1 > maxFiles ? 'file-budget'
        : budget.finalBytes + candidate.size > maxUnpackedBytes ? 'byte-budget' : null;
      if (reason) {
        result.skipped.push({ path: candidate.work.relativePath, reason });
        await fs.rm(candidate.temporary); temporaryFiles.delete(candidate.temporary); continue;
      }
      // staging为本任务私有目录；wx先独占预留目标，rename只替换本次持有的空占位。
      const reserved = await fs.open(candidate.work.destination, 'wx');
      committedFiles.add(candidate.work.destination);
      await reserved.close();
      await fs.rename(candidate.temporary, candidate.work.destination);
      temporaryFiles.delete(candidate.temporary);
      result.files.push({ path: candidate.work.relativePath, sourcePath: candidate.work.sourcePath, encoding: candidate.work.encoding, size: candidate.size });
      budget.finalFiles++; budget.finalEntries++; budget.finalBytes += candidate.size;
      options.onProgress?.({ phase: 'committing', completed: ++committed, total: retained.length });
    }
    throwIfDeploymentExportAborted(signal);
    for (const reason of ['existing-path', 'file-budget', 'byte-budget', 'path-too-long'] as const) {
      const count = result.skipped.filter(item => item.reason === reason).length;
      if (count) result.diagnostics.push('可选预压缩侧车跳过 ' + count + ' 项（' + reason + '）；原文件未改动。');
    }
    return result;
  } catch (error) {
    controller.abort(error);
    const cleanup = await Promise.allSettled([...temporaryFiles, ...committedFiles].map(file => fs.rm(file, { force: true })));
    const errors = cleanup.flatMap(item => item.status === 'rejected' ? [item.reason] : []);
    if (errors.length) throw new AggregateError([error, ...errors], '预压缩失败且临时文件清理不完整。', { cause: error });
    throw error;
  }
}

async function compressCandidate(work: Work, signal: AbortSignal, owned: Set<string>): Promise<Candidate> {
  const before = await fs.lstat(work.file.sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== work.file.size || before.mtimeMs !== work.file.mtimeMs) {
    throw new Error('预压缩原文件在清单生成后发生变化。');
  }
  // 固定短组件不拼接原basename，避免合法长文件名因临时后缀而新增发布失败。
  const temporary = path.join(path.dirname(work.destination), '.dtpc-' + randomUUID()), hash = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.byteLength;
    if (bytes > work.file.size) { done(new Error('预压缩原文件大小超过清单。')); return; }
    hash.update(chunk); done(null, chunk);
  } });
  const compressor = work.encoding === 'br'
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }) : createGzip({ level: 9 });
  const output = createWriteStream(temporary, { flags: 'wx' });
  output.once('open', () => owned.add(temporary));
  await pipeline(createReadStream(work.file.sourcePath), verify, compressor, output, { signal });
  const after = await fs.lstat(work.file.sourcePath);
  if (bytes !== work.file.size || hash.digest('hex') !== work.sha256 || !after.isFile() || after.isSymbolicLink()
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) {
    throw new Error('预压缩原文件SHA-256校验失败或读取期间发生变化。');
  }
  return { work, temporary, size: (await fs.stat(temporary)).size };
}

/** 与archive.directory(..., false)及接收端一致，根目录不入ZIP，子目录和空目录都占条目。 */
async function countStagedDirectories(root: string, signal: AbortSignal): Promise<number> {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    throwIfDeploymentExportAborted(signal);
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      throwIfDeploymentExportAborted(signal);
      if (entry.isSymbolicLink()) throw new Error('预压缩目录不能包含符号链接或Junction。');
      if (entry.isDirectory()) { count++; pending.push(path.join(directory, entry.name)); }
    }
  }
  return count;
}
