export type OpeningTerminal = 'disabled' | 'completed' | 'skipped' | 'failed' | 'cancelled';
export type OpeningRuntimeHandle = { start(): void; skip(): void; pause(): void; resume(): void; dispose(): void };
export type OpeningPlaybackOptions = {
  enabled: boolean;
  waitUntilVisible(signal: AbortSignal): Promise<boolean>;
  createRuntime(complete: () => void): OpeningRuntimeHandle;
  onActiveChange(active: boolean): void;
  onTerminal(result: OpeningTerminal): void;
  onError(error: unknown): void;
};

export class OpeningPlaybackCoordinator {
  private readonly options: OpeningPlaybackOptions;
  private readonly abort = new AbortController();
  private runtime: OpeningRuntimeHandle | null = null;
  private started = false;
  private ended = false;
  private active = false;
  private paused = false;
  private skipping = false;
  constructor(options: OpeningPlaybackOptions) { this.options = options; }

  /** 每个场景会话仅启动一次；迟到的宿主握手不能复活已取消的开场。 */
  async start(): Promise<void> {
    if (this.started || this.ended) return;
    this.started = true;
    if (!this.options.enabled) { this.finish('disabled'); return; }
    try {
      this.active = true;
      this.options.onActiveChange(true);
      const visible = await this.options.waitUntilVisible(this.abort.signal);
      if (this.ended) return;
      if (!visible) { this.finish('skipped'); return; }
      this.runtime = this.options.createRuntime(() => this.finish(this.skipping ? 'skipped' : 'completed'));
      if (this.ended) { this.runtime.dispose(); this.runtime = null; return; }
      this.runtime.start();
      if (this.paused) this.runtime?.pause();
    } catch (error) { this.fail(error); }
  }

  skip(): void {
    if (this.ended) return;
    this.skipping = true;
    try {
      if (this.runtime) this.runtime.skip();
      else this.finish('skipped');
    } catch (error) { this.fail(error); }
  }
  cancel(): void { this.finish('cancelled'); }
  pause(): void { this.paused = true; this.runtime?.pause(); }
  resume(): void { this.paused = false; this.runtime?.resume(); }
  dispose(): void { this.finish('cancelled'); }
  fail(error: unknown): void {
    if (this.ended) return;
    try { this.options.onError(error); } finally { this.finish('failed'); }
  }

  private finish(result: OpeningTerminal): void {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    const runtime = this.runtime;
    this.runtime = null;
    // 完成可在 Babylon 的帧末观察者内回调；帧结束后再销毁临时渲染场景。
    if (runtime) queueMicrotask(() => {
      try { runtime.dispose(); } catch (error) { this.options.onError(error); }
    });
    try {
      if (this.active) { this.active = false; this.options.onActiveChange(false); }
    } catch (error) { this.options.onError(error); }
    finally { if (this.started) this.options.onTerminal(result); }
  }
}
