import type { SceneModelEntranceSettings } from '../../editor/model/sceneModelEntrance';

type EntranceRuntime = {
  prepareModelEntrance(settings: SceneModelEntranceSettings): void;
  startModelEntrance(): void;
  cancelModelEntrance(): void;
  setModelEntranceVisible(visible: boolean): void;
};
type Options = {
  runtime: EntranceRuntime;
  settings: SceneModelEntranceSettings;
  container: HTMLElement;
  isHostVisible?: () => boolean;
  subscribeToHostVisibility?: (listener: () => void) => () => void;
  onError?: (error: unknown) => void;
  isReady?: () => boolean;
};

/** 模型先准备隐藏，再等遮罩撤去后的可见帧；Editor 和 Viewer 共用同一首播边界。 */
export class SceneModelEntrancePlayback {
  private readonly options: Options;
  private requested = false;
  private started = false;
  private disposed = false;
  private frame = 0;
  private readyWaitStarted: number | null = null;
  private inView = true;
  private resize: ResizeObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private unsubscribeHost: (() => void) | null = null;

  constructor(options: Options) {
    this.options = options;
    if (!options.settings.enabled) { this.disposed = true; return; }
    try {
      options.runtime.prepareModelEntrance(options.settings);
      document.addEventListener('visibilitychange', this.updateVisibility);
      this.unsubscribeHost = options.subscribeToHostVisibility?.(this.updateVisibility) ?? null;
      if (typeof ResizeObserver !== 'undefined') {
        this.resize = new ResizeObserver(this.updateVisibility);
        this.resize.observe(options.container);
      }
      if (typeof IntersectionObserver !== 'undefined') {
        this.intersection = new IntersectionObserver(entries => {
          this.inView = entries[0]?.isIntersecting ?? false;
          this.updateVisibility();
        });
        this.intersection.observe(options.container);
      }
      this.updateVisibility();
    } catch (error) { this.fail(error); }
  }

  start(): void {
    if (this.disposed || this.requested) return;
    this.requested = true;
    this.updateVisibility();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame); this.frame = 0;
    document.removeEventListener('visibilitychange', this.updateVisibility);
    this.unsubscribeHost?.(); this.unsubscribeHost = null;
    this.resize?.disconnect(); this.resize = null;
    this.intersection?.disconnect(); this.intersection = null;
    this.options.runtime.cancelModelEntrance();
  }

  private visible(): boolean {
    const rect = this.options.container.getBoundingClientRect();
    const style = getComputedStyle(this.options.container);
    return !document.hidden && this.inView && this.options.isHostVisible?.() !== false
      && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  private readonly updateVisibility = (): void => {
    if (this.disposed) return;
    const visible = this.visible();
    this.options.runtime.setModelEntranceVisible(visible);
    if (!visible) { cancelAnimationFrame(this.frame); this.frame = 0; this.readyWaitStarted = null; return; }
    if (!this.requested || this.started || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.disposed || !this.visible()) return;
        if (this.options.isReady?.() === false) {
          this.readyWaitStarted ??= performance.now();
          if (performance.now() - this.readyWaitStarted > 5000) this.fail(new Error('入场材质未就绪，已恢复正常模型。'));
          else this.updateVisibility();
          return;
        }
        try { this.options.runtime.startModelEntrance(); this.started = true; }
        catch (error) { this.fail(error); }
      });
    });
  };

  private fail(error: unknown): void {
    try { this.options.onError?.(error); }
    finally { this.dispose(); }
  }
}
