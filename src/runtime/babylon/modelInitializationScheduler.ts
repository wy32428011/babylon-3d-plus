/** 前台跨帧后让出绘制机会；后台 rAF 暂停时由计时器保证初始化继续结算。 */
export function yieldModelInitializationFrame(): Promise<void> {
  return new Promise(resolve => {
    let frame: number | undefined;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame);
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, typeof document === 'undefined' || document.hidden ? 0 : 50);
    if (typeof globalThis.requestAnimationFrame === 'function' && (typeof document === 'undefined' || !document.hidden)) {
      frame = globalThis.requestAnimationFrame(() => { setTimeout(finish, 0); });
    }
  });
}

/** 将并发模型初始化分摊到任务轮次，让文件、贴图和界面回调有机会继续执行。 */
export class ModelInitializationScheduler {
  private tasks: Array<(() => boolean) | undefined> = [];
  private head = 0;
  private running = false;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly yieldTask: () => Promise<void>;
  private readonly maxTasksPerSlice: number;
  private readonly deferFirstSlice: boolean;
  private readonly metrics = { completedTasks: 0, cancelledTasks: 0, slices: 0, maxTaskMs: 0, maxSliceMs: 0 };

  constructor(
    budgetMs = 6,
    now = () => performance.now(),
    yieldTask = yieldModelInitializationFrame,
    options: { maxTasksPerSlice?: number; deferFirstSlice?: boolean } = {},
  ) {
    this.budgetMs = budgetMs; this.now = now; this.yieldTask = yieldTask;
    this.maxTasksPerSlice = options.maxTasksPerSlice ?? 4;
    this.deferFirstSlice = options.deferFirstSlice ?? yieldTask === yieldModelInitializationFrame;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isInteger(this.maxTasksPerSlice) || this.maxTasksPerSlice <= 0) {
      throw new RangeError('模型初始化时间片和每片任务数必须为有限正数。');
    }
  }

  getMetrics() { return { ...this.metrics, pendingTasks: this.tasks.length - this.head }; }

  run<T>(task: () => T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('模型初始化已取消。', 'AbortError'));
    const result = new Promise<T>((resolve, reject) => {
      let queuedTask: (() => T) | undefined = task;
      const abort = () => {
        if (!queuedTask) return;
        queuedTask = undefined;
        this.metrics.cancelledTasks++;
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('模型初始化已取消。', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.tasks.push(() => {
        signal?.removeEventListener('abort', abort);
        const current = queuedTask;
        queuedTask = undefined;
        if (!current) return false;
        const started = this.now();
        try { resolve(current()); } catch (error) { reject(error); }
        finally {
          this.metrics.completedTasks++;
          this.metrics.maxTaskMs = Math.max(this.metrics.maxTaskMs, this.now() - started);
        }
        return true;
      });
      if (signal?.aborted) abort();
    });
    if (!this.running) {
      this.running = true;
      queueMicrotask(() => { void this.drain(); });
    }
    return result;
  }

  private async drain(): Promise<void> {
    if (this.deferFirstSlice) await this.yieldSafely();
    while (this.head < this.tasks.length) {
      const started = this.now();
      let count = 0;
      do {
        const task = this.tasks[this.head];
        this.tasks[this.head++] = undefined;
        if (task?.()) count++;
      } while (this.head < this.tasks.length && count < this.maxTasksPerSlice && this.now() - started < this.budgetMs);
      this.metrics.slices++;
      this.metrics.maxSliceMs = Math.max(this.metrics.maxSliceMs, this.now() - started);
      if (this.head < this.tasks.length) {
        // 释放已消费的闭包，避免大批模型使队列长期保留场景对象。
        if (this.head >= 256) { this.tasks = this.tasks.slice(this.head); this.head = 0; }
        await this.yieldSafely();
      }
    }
    this.tasks = [];
    this.head = 0;
    this.running = false;
  }

  private async yieldSafely(): Promise<void> {
    try { await this.yieldTask(); }
    catch (error) {
      console.warn('模型初始化调度让出失败，改用计时器继续。', error);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
}

export const modelInitializationScheduler = new ModelInitializationScheduler();
