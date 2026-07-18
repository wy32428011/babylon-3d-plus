/** 默认资产加载并发数，避免首屏或批量导入时同时发起过多加载请求。 */
export const DEFAULT_ASSET_LOAD_CONCURRENCY = 4;

/** 排队等待执行的资产加载任务。 */
type QueuedAssetLoadTask<T> = {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
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
   * 任务会在并发窗口可用时按 FIFO 顺序启动；调度器释放后会直接拒绝新任务。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(this.createDisposedError());
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as QueuedAssetLoadTask<unknown>);
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
      queuedTask?.reject(error);
    }
  }

  /** 在并发窗口允许时按提交顺序启动排队任务。 */
  private drainQueue(): void {
    while (!this.disposed && this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const queuedTask = this.queue.shift();
      if (!queuedTask) return;
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

  /** 创建统一的释放态错误，便于调用方识别调度器生命周期问题。 */
  private createDisposedError(): Error {
    return new Error('资产加载调度器已释放，无法接受新的加载任务。');
  }
}
