/** 默认资产加载并发数，避免首屏或批量导入时同时发起过多加载请求。 */
export const DEFAULT_ASSET_LOAD_CONCURRENCY = 4;

/** 排队等待执行的资产加载任务。 */
type QueuedAssetLoadTask<T> = {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
};

/**
 * 无依赖的资产加载并发调度器。
 * 调度器保证同一时刻最多只有 maxConcurrency 个任务处于运行态，并按提交顺序启动排队任务。
 */
export class AssetLoadScheduler {
  private readonly maxConcurrency: number;
  private readonly queue: Array<QueuedAssetLoadTask<unknown>> = [];
  private activeCount = 0;
  private disposed = false;

  /** 创建资产加载调度器，并校验并发上限必须是正整数。 */
  constructor(maxConcurrency = DEFAULT_ASSET_LOAD_CONCURRENCY) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('资产加载并发数必须是大于 0 的整数。');
    }
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * 提交一个异步资产加载任务。
   * 任务会在并发窗口可用时按 FIFO 顺序启动；调度器释放或排队期间 signal 取消后会直接拒绝。
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) {
      return Promise.reject(this.createDisposedError());
    }
    if (signal?.aborted) {
      return Promise.reject(this.createCanceledError());
    }

    return new Promise<T>((resolve, reject) => {
      const queuedTask: QueuedAssetLoadTask<T> = {
        task,
        resolve,
        reject,
        signal: signal ?? null,
        abortListener: null,
      };

      if (signal) {
        queuedTask.abortListener = () => this.cancelQueuedTask(queuedTask);
        signal.addEventListener('abort', queuedTask.abortListener, { once: true });
      }

      this.queue.push(queuedTask as QueuedAssetLoadTask<unknown>);
      this.drainQueue();
    });
  }

  /**
   * 释放调度器。
   * 已经运行的任务允许自然结束；尚未开始的排队任务会被拒绝，后续新任务也会被拒绝。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const error = this.createDisposedError();
    while (this.queue.length > 0) {
      const queuedTask = this.queue.shift();
      if (!queuedTask) continue;
      this.detachAbortListener(queuedTask);
      queuedTask.reject(error);
    }
  }

  /** 取消尚未启动的单个排队任务，并立即释放其队列位置。 */
  private cancelQueuedTask<T>(queuedTask: QueuedAssetLoadTask<T>): void {
    const queueIndex = this.queue.indexOf(queuedTask as QueuedAssetLoadTask<unknown>);
    if (queueIndex < 0) return;

    this.queue.splice(queueIndex, 1);
    this.detachAbortListener(queuedTask);
    queuedTask.reject(this.createCanceledError());
  }

  /** 在并发窗口允许时按提交顺序启动排队任务。 */
  private drainQueue(): void {
    while (!this.disposed && this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const queuedTask = this.queue.shift();
      if (!queuedTask) return;
      this.detachAbortListener(queuedTask);
      this.startTask(queuedTask);
    }
  }

  /** 启动单个任务，并在结束后释放并发窗口。 */
  private startTask<T>(queuedTask: QueuedAssetLoadTask<T>): void {
    this.activeCount += 1;

    Promise.resolve()
      .then(queuedTask.task)
      .then(queuedTask.resolve, queuedTask.reject)
      .finally(() => {
        this.activeCount -= 1;
        this.drainQueue();
      });
  }

  /** 移除排队任务的取消监听，避免任务完成后继续持有调度器和回调。 */
  private detachAbortListener<T>(queuedTask: QueuedAssetLoadTask<T>): void {
    if (queuedTask.signal && queuedTask.abortListener) {
      queuedTask.signal.removeEventListener('abort', queuedTask.abortListener);
    }
    queuedTask.abortListener = null;
  }

  /** 创建统一的释放态错误，便于调用方识别调度器生命周期问题。 */
  private createDisposedError(): Error {
    return new Error('资产加载调度器已释放，无法接受新的加载任务。');
  }

  /** 创建统一的排队取消错误；已运行任务仍由底层加载器决定是否可中止。 */
  private createCanceledError(): Error {
    const error = new Error('资产加载任务已取消。');
    error.name = 'AbortError';
    return error;
  }
}
