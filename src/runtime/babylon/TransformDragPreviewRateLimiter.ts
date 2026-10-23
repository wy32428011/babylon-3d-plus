/** 合并单体拖拽的 Inspector 预览；运行时节点仍由 Babylon 在每个指针事件直接更新。 */
export class TransformDragPreviewRateLimiter {
  private lastPublishedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs = 1000 / 60) {}

  reset(): void {
    this.lastPublishedAt = Number.NEGATIVE_INFINITY;
  }

  shouldPublish(now = performance.now()): boolean {
    if (now - this.lastPublishedAt < this.intervalMs) return false;
    this.lastPublishedAt = now;
    return true;
  }
}
