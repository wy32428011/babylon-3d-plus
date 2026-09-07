import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { GlbModelInspection } from './modelPackageScanner.js';
import type { EnvironmentValidationWorkerInput } from './environmentFileValidation.worker.js';

type Result = GlbModelInspection & { fileSha256: string };
type Options = { expectedSize?: number; expectedSha256?: string; signal?: AbortSignal };
type Job = { filePath: string; options: Options; resolve: (result: Result) => void; reject: (error: Error) => void; abort: () => void };
type CacheEntry = { stamp: string; result: Result };
const MAX_QUEUED = 64;
const MAX_CACHE = 128;
const VALIDATION_TIMEOUT_MS = 30 * 60_000;
const cache = new Map<string, CacheEntry>();
const queue: Job[] = [];
let active: { job: Job; worker: Worker | null; cancel: (error: Error) => void; done: Promise<void> } | null = null;
let disposing: Promise<void> | null = null;

function canceled(): Error { const error = new Error('环境模型文件校验已取消。'); error.name = 'AbortError'; return error; }

async function fingerprint(filePath: string): Promise<{ stamp: string; size: number }> {
  const stat = await lstat(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('环境模型校验路径必须是普通文件。');
  return { stamp: [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].join(':'), size: Number(stat.size) };
}

function assertExpected(result: Result, options: Options): void {
  if (options.expectedSize !== undefined && result.fileSizeBytes !== options.expectedSize) throw new Error('环境模型文件大小与远端清单不一致。');
  if (options.expectedSha256 !== undefined && result.fileSha256 !== options.expectedSha256.toLowerCase()) throw new Error('环境模型文件 SHA-256 与远端清单不一致。');
}

/** 把结构解析与流式哈希放在独立线程，每次命中缓存前仍检查文件身份。 */
export function validateEnvironmentFile(filePath: string, options: Options = {}): Promise<Result> {
  if (options.signal?.aborted) return Promise.reject(canceled());
  if (disposing) return Promise.reject(new Error('环境模型校验器正在关闭。'));
  if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0)) return Promise.reject(new Error('环境模型预期文件大小无效。'));
  if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) return Promise.reject(new Error('环境模型预期 SHA-256 无效。'));
  if (queue.length >= MAX_QUEUED) return Promise.reject(new Error('环境模型校验队列已满，请等待当前资源处理完成后重试。'));
  return new Promise((resolve, reject) => {
    const job: Job = { filePath: path.resolve(filePath), options: { ...options }, resolve, reject, abort: () => {
      if (active?.job === job) active.cancel(canceled());
      else {
        const offset = queue.indexOf(job);
        if (offset !== -1) queue.splice(offset, 1);
        job.options.signal?.removeEventListener('abort', job.abort);
        reject(canceled());
      }
    } };
    queue.push(job);
    options.signal?.addEventListener('abort', job.abort, { once: true });
    pump();
  });
}

function pump(): void {
  if (active || disposing) return;
  const job = queue.shift();
  if (!job) return;
  let rejectCancellation: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const state = { job, worker: null as Worker | null, cancel: rejectCancellation, done: Promise.resolve() };
  active = state;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const work = async (): Promise<Result> => {
    const before = await fingerprint(job.filePath);
    if (active !== state || job.options.signal?.aborted) throw canceled();
    if (job.options.expectedSize !== undefined && before.size !== job.options.expectedSize) throw new Error('环境模型文件大小与远端清单不一致。');
    const cached = cache.get(job.filePath);
    if (cached?.stamp === before.stamp) {
      assertExpected(cached.result, job.options);
      cache.delete(job.filePath); cache.set(job.filePath, cached);
      return structuredClone(cached.result);
    }
    cache.delete(job.filePath);
    const workerData: EnvironmentValidationWorkerInput = { filePath: job.filePath };
    const worker = new Worker(new URL('./environmentFileValidation.worker.js', import.meta.url), {
      workerData, resourceLimits: { maxOldGenerationSizeMb: 384 },
    });
    state.worker = worker;
    const result = await new Promise<Result>((resolve, reject) => {
      worker.once('message', (message: { ok: boolean; result?: Result; error?: string }) => {
        if (message.ok && message.result) resolve(message.result);
        else reject(new Error(`环境模型文件校验失败：${message.error ?? '校验线程返回无效结果。'}`));
      });
      worker.once('error', (error: unknown) => reject(new Error(`环境模型校验线程失败：${error instanceof Error ? error.message : String(error)}`)));
      worker.once('exit', (code) => reject(new Error(`环境模型校验线程提前退出（退出码 ${code}）。`)));
    });
    const after = await fingerprint(job.filePath);
    if (active !== state || job.options.signal?.aborted) throw canceled();
    if (before.stamp !== after.stamp) throw new Error('环境模型在校验期间发生变化，请重新同步。');
    assertExpected(result, job.options);
    cache.set(job.filePath, { stamp: after.stamp, result: structuredClone(result) });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    return result;
  };
  timeout = setTimeout(() => state.cancel(new Error('环境模型文件校验超时，请检查磁盘性能或重新同步。')), VALIDATION_TIMEOUT_MS);
  state.done = Promise.race([work(), cancellation]).then(job.resolve, job.reject).finally(async () => {
    if (timeout) clearTimeout(timeout);
    job.options.signal?.removeEventListener('abort', job.abort);
    // 先等待终止，后调度下一项，确保活动校验线程始终不超过一个。
    if (state.worker) await state.worker.terminate();
    if (active === state) active = null;
    pump();
  });
}

export async function disposeEnvironmentFileValidation(): Promise<void> {
  if (disposing) return disposing;
  disposing = (async () => {
    for (const job of queue.splice(0)) {
      job.options.signal?.removeEventListener('abort', job.abort);
      job.reject(canceled());
    }
    const running = active;
    running?.cancel(canceled());
    if (running) await running.done;
    cache.clear();
  })();
  try { await disposing; } finally { disposing = null; }
}
