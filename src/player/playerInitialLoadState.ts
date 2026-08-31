export type PlayerInitialLoadProgress = {
  loading: boolean;
  totalCount: number;
};

export type PlayerInitialLoadGateOptions = {
  onSettled?: () => void;
  schedule?: (callback: () => void) => unknown;
  cancel?: (handle: unknown) => void;
};

export function isPlayerInitialLoadSettled(progress: PlayerInitialLoadProgress | null): boolean {
  return progress === null || progress.totalCount === 0 || !progress.loading;
}

/** 首次加载需稳定到下一帧，避免资产调度器切换队列任务时出现瞬时空档。 */
export class PlayerInitialLoadGate {
  private readonly onComplete: () => void;
  private readonly onSettled: () => void;
  private readonly schedule: (callback: () => void) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private progress: PlayerInitialLoadProgress | null = null;
  private scheduledHandle: unknown | null = null;
  private tracking = false;
  private completionNotified = false;
  private settled = false;
  private disposed = false;

  constructor(
    onComplete: () => void,
    options: PlayerInitialLoadGateOptions = {},
  ) {
    this.onComplete = onComplete;
    this.onSettled = options.onSettled ?? (() => undefined);
    this.schedule = options.schedule ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancel = options.cancel ?? ((handle) => globalThis.cancelAnimationFrame(handle as number));
  }

  update(progress: PlayerInitialLoadProgress): void {
    if (this.disposed || this.settled) return;
    this.progress = progress;
    this.refresh();
  }

  startTracking(): void {
    if (this.disposed || this.settled || this.tracking) return;
    this.tracking = true;
    this.refresh();
  }

  forceComplete(): void {
    if (this.disposed || this.completionNotified) return;
    this.notifyComplete();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledCheck();
  }

  private refresh(): void {
    if (!this.tracking || !isPlayerInitialLoadSettled(this.progress)) {
      this.cancelScheduledCheck();
      return;
    }
    if (this.scheduledHandle !== null) return;

    this.scheduledHandle = this.schedule(() => {
      this.scheduledHandle = null;
      if (this.disposed || this.settled || !this.tracking || !isPlayerInitialLoadSettled(this.progress)) return;
      this.finishSettled();
    });
  }

  private finishSettled(): void {
    this.cancelScheduledCheck();
    this.settled = true;
    this.notifyComplete();
    this.onSettled();
  }

  private notifyComplete(): void {
    if (this.completionNotified) return;
    this.completionNotified = true;
    this.onComplete();
  }

  private cancelScheduledCheck(): void {
    if (this.scheduledHandle === null) return;
    this.cancel(this.scheduledHandle);
    this.scheduledHandle = null;
  }
}
