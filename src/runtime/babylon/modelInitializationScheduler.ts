type YieldScheduler = { yield?: () => Promise<void> };

/** 将并发模型初始化分摊到任务轮次，让文件、贴图和界面回调有机会继续执行。 */
export class ModelInitializationScheduler {
  private tasks: Array<(() => void) | undefined> = [];
  private head = 0;
  private running = false;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly yieldTask: () => Promise<void>;

  constructor(
    budgetMs = 6,
    now = () => performance.now(),
    yieldTask = async (): Promise<void> => {
      const scheduler = (globalThis as { scheduler?: YieldScheduler }).scheduler;
      if (scheduler?.yield) await scheduler.yield();
      else await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
  ) { this.budgetMs = budgetMs; this.now = now; this.yieldTask = yieldTask; }

  run<T>(task: () => T): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.tasks.push(() => {
        try { resolve(task()); } catch (error) { reject(error); }
      });
    });
    if (!this.running) {
      this.running = true;
      queueMicrotask(() => { void this.drain(); });
    }
    return result;
  }

  private async drain(): Promise<void> {
    while (this.head < this.tasks.length) {
      const started = this.now();
      do {
        const task = this.tasks[this.head];
        this.tasks[this.head++] = undefined;
        task?.();
      } while (this.head < this.tasks.length && this.now() - started < this.budgetMs);
      if (this.head < this.tasks.length) {
        // 释放已消费的闭包，避免大批模型使队列长期保留场景对象。
        if (this.head >= 256) { this.tasks = this.tasks.slice(this.head); this.head = 0; }
        try { await this.yieldTask(); }
        catch (error) {
          console.warn('模型初始化调度让出失败，改用计时器继续。', error);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    }
    this.tasks = [];
    this.head = 0;
    this.running = false;
  }
}

export const modelInitializationScheduler = new ModelInitializationScheduler();
