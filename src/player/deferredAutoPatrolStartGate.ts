/** 自动巡检启动门闩：加载完成前只保留最新请求，真实就绪后再执行。 */
export class DeferredAutoPatrolStartGate {
  private pendingStart: (() => void) | null = null;
  private ready = false;
  private disposed = false;

  request(start: () => void): void {
    if (this.disposed) return;
    if (this.ready) {
      start();
      return;
    }
    this.pendingStart = start;
  }

  markReady(): void {
    if (this.disposed || this.ready) return;
    this.ready = true;
    const pendingStart = this.pendingStart;
    this.pendingStart = null;
    pendingStart?.();
  }

  cancelPending(): void {
    if (this.disposed) return;
    this.pendingStart = null;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingStart = null;
  }
}
