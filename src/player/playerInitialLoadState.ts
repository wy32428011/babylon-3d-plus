export type PlayerInitialLoadProgress = {
  loading: boolean;
  totalCount: number;
};

export type PlayerInitialLoadGateOptions = {
  onSettled?: () => void;
  schedule?: (callback: () => void) => unknown;
  cancel?: (handle: unknown) => void;
  verifyReady?: (signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
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
  private verification: AbortController | null = null;
  private readonly verifyReady: PlayerInitialLoadGateOptions['verifyReady'];
  private readonly onError: (error: unknown) => void;

  constructor(
    onComplete: () => void,
    options: PlayerInitialLoadGateOptions = {},
  ) {
    this.onComplete = onComplete;
    this.onSettled = options.onSettled ?? (() => undefined);
    this.schedule = options.schedule ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancel = options.cancel ?? ((handle) => globalThis.cancelAnimationFrame(handle as number));
    this.verifyReady = options.verifyReady;
    this.onError = options.onError ?? (() => undefined);
  }

  update(progress: PlayerInitialLoadProgress): void {
    if (this.disposed || this.settled) return;
    if (this.progress?.totalCount !== progress.totalCount) this.cancelScheduledCheck();
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
    if (this.scheduledHandle !== null || this.verification !== null) return;

    this.scheduledHandle = this.schedule(() => {
      this.scheduledHandle = null;
      if (this.disposed || this.settled || !this.tracking || !isPlayerInitialLoadSettled(this.progress)) return;
      if (!this.verifyReady) { this.finishSettled(); return; }
      const controller = new AbortController();
      this.verification = controller;
      void this.verifyReady(controller.signal).then(() => {
        if (controller.signal.aborted || this.disposed || this.verification !== controller) return;
        this.verification = null;
        if (isPlayerInitialLoadSettled(this.progress)) this.finishSettled();
      }).catch(error => {
        if (controller.signal.aborted || this.disposed || this.verification !== controller) return;
        this.verification = null;
        this.dispose();
        this.onError(error);
      });
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
    this.verification?.abort();
    this.verification = null;
    if (this.scheduledHandle === null) return;
    this.cancel(this.scheduledHandle);
    this.scheduledHandle = null;
  }
}
