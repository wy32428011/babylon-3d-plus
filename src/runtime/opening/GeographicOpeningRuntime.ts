import type { Scene } from '@babylonjs/core/scene';
import { normalizeSceneOpeningAnimation, type SceneOpeningAnimationSettings } from '../../editor/model/sceneOpeningAnimation';
import type { OpeningSnapshot } from './geographicOpeningMath';
import { createOpeningVisualPlan, type OpeningVisualPlan } from './createOpeningVisualPlan';
import type { OpeningControlledVisual } from './TimelineOpeningVisual';

export type { OpeningSnapshot } from './geographicOpeningMath';
type OpeningOptions = {
  /** 旧离线演示兼容入口，产品播放器只传独立容器。 */
  scene?: Scene;
  container?: HTMLElement;
  settings: SceneOpeningAnimationSettings;
  onComplete(): void;
  onSkip?(): void;
  onError?(error: unknown): void;
  onProgress?(snapshot: OpeningSnapshot): void;
};

/** 内置参考和导入开场包共用唯一播放时钟；真实相机、模型和遥测始终留在业务场景。 */
export class GeographicOpeningRuntime {
  private readonly options: OpeningOptions;
  private readonly settings: SceneOpeningAnimationSettings;
  private readonly reducedMotion: boolean;
  private readonly plan: OpeningVisualPlan;
  private visual: OpeningControlledVisual | null = null;
  private host: HTMLDivElement | null = null;
  private frame: number | null = null;
  private detachLegacyScene: (() => void) | null = null;
  private preparationTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private previousFocus: HTMLElement | null = null;
  private ready = false;
  private running = false;
  private disposed = false;
  private suspended = false;
  private userPaused = false;
  private elapsed = 0;
  private lastTime = 0;
  private lastProgressTime = -1;
  private skipElapsed: number | null = null;
  private skipOpacity = 1;
  private snapshot: OpeningSnapshot;

  constructor(options: OpeningOptions) {
    this.options = options;
    this.settings = normalizeSceneOpeningAnimation(options.settings);
    this.reducedMotion = this.settings.motionPreference === 'reduced'
      || (this.settings.motionPreference === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.plan = createOpeningVisualPlan(this.settings, this.reducedMotion);
    this.snapshot = this.frameAt(0);
  }

  start(): void {
    if (this.running || this.disposed) return;
    if (!this.settings.enabled) { this.finish(); return; }
    try {
      const container = this.options.container ?? this.options.scene?.getEngine().getRenderingCanvas()?.parentElement;
      if (!container) throw new Error('开场动画缺少可用的画面容器。');
      this.running = true;
      const legacyScene = this.options.scene;
      if (legacyScene) {
        const observer = legacyScene.onDisposeObservable.add(() => this.dispose());
        this.detachLegacyScene = () => { if (observer) legacyScene.onDisposeObservable.remove(observer); };
      }
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.host = document.createElement('div');
      this.host.className = 'geographic-opening-host';
      Object.assign(this.host.style, { position: 'absolute', inset: '0', zIndex: '79', overflow: 'hidden' });
      container.appendChild(this.host);
      this.visual = this.plan.createVisual(this.host, {
        onSkip: () => {
          if (!this.settings.allowSkip) return;
          if (this.options.onSkip) this.options.onSkip(); else this.skip();
        },
        onSeek: (seconds: number) => { if (this.settings.allowSkip) this.seek(seconds); },
        onPauseToggle: () => {
          if (this.skipElapsed !== null) return;
          if (this.suspended || this.userPaused) this.userPaused = false;
          else this.userPaused = true;
          this.lastTime = performance.now();
          this.draw();
          this.scheduleFrame();
        },
        onRestart: () => {
          if (this.skipElapsed !== null) return;
          this.userPaused = false; this.seek(0); this.scheduleFrame();
        },
      });
      // 减少动态直接展示到达画面，短停留后交接，不因系统设置永远卡在暂停状态。
      if (this.reducedMotion) this.elapsed = this.plan.reducedStartSeconds;
      this.snapshot = this.frameAt(this.elapsed);
      this.lastTime = performance.now();
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => { this.visual?.resize(); this.draw(); });
        this.resizeObserver.observe(this.host);
      }
      this.preparationTimer = setTimeout(() => this.fail(new Error('开场素材准备超时，已恢复场景。')), 30_000);
      void this.visual.ready.then(() => {
        if (this.disposed) return;
        this.clearPreparationTimer();
        this.ready = true;
        this.lastTime = performance.now();
        this.draw();
        this.scheduleFrame();
      }).catch(error => this.fail(error));
    } catch (error) { this.fail(error); }
  }

  skip(): void {
    if (!this.running || this.skipElapsed !== null) return;
    if (!this.ready || this.suspended) { this.finish(); return; }
    this.skipElapsed = 0;
    this.skipOpacity = this.frameAt(this.elapsed).opacity;
    this.userPaused = false;
    this.lastTime = performance.now();
    this.scheduleFrame();
  }

  /** 宿主可见性暂停独立于播放器主动暂停，页面重新可见不会覆盖用户选择。 */
  pause(): void { this.suspended = true; this.draw(); this.cancelFrame(); }
  resume(): void { this.suspended = false; this.lastTime = performance.now(); this.draw(); this.scheduleFrame(); }
  getSnapshot(): OpeningSnapshot { return { ...this.snapshot }; }

  seek(seconds: number): void {
    if (this.disposed || this.skipElapsed !== null) return;
    this.elapsed = Number.isFinite(seconds) ? Math.max(0, Math.min(this.frameAt(0).totalDurationSeconds, seconds)) : 0;
    this.lastTime = performance.now();
    this.draw();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.clearPreparationTimer();
    this.cancelFrame();
    this.detachLegacyScene?.(); this.detachLegacyScene = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const ownsFocus = !!this.host?.contains(document.activeElement);
    try { this.visual?.dispose(); }
    finally {
      this.visual = null;
      this.host?.remove(); this.host = null;
      if (ownsFocus && this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
      this.previousFocus = null;
    }
  }

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
  private scheduleFrame(): void {
    if (this.frame !== null || !this.running || !this.ready || this.disposed || this.suspended || this.userPaused) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); this.scheduleFrame(); });
  }
  private frameAt(seconds: number) { return this.plan.frameAt(seconds); }
  private clearPreparationTimer(): void {
    if (this.preparationTimer !== null) clearTimeout(this.preparationTimer);
    this.preparationTimer = null;
  }

  private render(): void {
    if (!this.running || !this.ready) return;
    try {
      const now = performance.now();
      const delta = Math.min(Math.max((now - this.lastTime) / 1000, 0), .1);
      this.lastTime = now;
      if (!this.suspended && !this.userPaused) {
        if (this.skipElapsed !== null) this.skipElapsed += delta;
        else this.elapsed += delta;
      }
      if (this.elapsed >= this.frameAt(0).totalDurationSeconds || (this.skipElapsed !== null && this.skipElapsed >= .45)) {
        this.finish(); return;
      }
      if (this.suspended || this.userPaused) return;
      this.draw();
    } catch (error) { this.fail(error); }
  }

  private draw(): void {
    try { this.drawFrame(); } catch (error) { this.fail(error); }
  }

  private drawFrame(): void {
    if (!this.ready || !this.visual || this.disposed) return;
    const frame = this.frameAt(this.elapsed);
    const isPaused = this.suspended || this.userPaused;
    const skip = this.skipElapsed === null ? 0 : Math.min(1, this.skipElapsed / .45);
    const opacity = this.skipElapsed === null ? frame.opacity : this.skipOpacity * (1 - skip * skip * (3 - 2 * skip));
    this.visual.renderAt(this.elapsed, {
      elapsedSeconds: frame.elapsedSeconds,
      totalDurationSeconds: frame.totalDurationSeconds,
      isPaused, opacity, stageIndex: frame.stageIndex,
    });
    this.snapshot = { ...frame, isPaused };
    if (this.skipElapsed !== null) this.snapshot = { ...this.snapshot, phase: 'handoff', label: '进入数字孪生' };
    const now = performance.now();
    if (now - this.lastProgressTime >= 50 || isPaused || this.snapshot.phase === 'complete') {
      this.options.onProgress?.(this.snapshot);
      this.lastProgressTime = now;
    }
  }

  private finish(): void {
    if (this.disposed) return;
    this.snapshot = { ...this.frameAt(this.frameAt(0).totalDurationSeconds), isPaused: false };
    try { this.dispose(); this.options.onProgress?.(this.snapshot); }
    catch (error) { this.notifyFailure(error); return; }
    this.options.onComplete();
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    try { this.dispose(); } catch (cleanupError) { console.warn('[GeographicOpeningRuntime] 开场释放异常', cleanupError); }
    this.notifyFailure(error);
  }

  private notifyFailure(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else { console.error('[GeographicOpeningRuntime] 开场动画失败，已恢复场景', error); this.options.onComplete(); }
  }
}
