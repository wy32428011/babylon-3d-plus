export type AdaptiveResolutionEngine = {
  getHardwareScalingLevel(): number;
  /** Babylon 的原生 setter 自身负责 resize；控制器不再重复调用 resize。 */
  setHardwareScalingLevel(level: number): void;
};
export type AdaptiveResolutionOptions = {
  motionScale?: number;
  idleRestoreMs?: number;
  onError?: (error: unknown) => void;
};
export type AdaptiveResolutionUpdate = { enabled: boolean; moving: boolean; now: number };
export type AdaptiveResolutionSnapshot = {
  baselineLevel: number; motionLevel: number; enabled: boolean; reduced: boolean;
  suspended: boolean; disposed: boolean; restorationPending: boolean;
  status: 'baseline' | 'reduced' | 'waiting' | 'yielded' | 'faulted' | 'disposed';
  errorCount: number; diagnosticErrorCount: number; lastError: string | null;
};

/**
 * 显式启用的相机运动分辨率控制。只改 hardwareScalingLevel，不接管 render/脚本/MQTT 的更新频率。
 * 所有权由本控制器最后一次写入的等级确认；外部改值后让出，直到关→开且原初始等级已恢复。
 */
export class AdaptiveResolutionController {
  private readonly engine: AdaptiveResolutionEngine;
  private readonly options: AdaptiveResolutionOptions;
  private readonly baseline: number;
  private readonly motionLevel: number;
  private readonly idleRestoreMs: number;
  private enabled = false;
  private suspended = false;
  private disposed = false;
  private ownedLevel: number | null = null;
  private attemptedLevel: number | null = null;
  private restorationPending = false;
  private lastMotionAt: number | null = null;
  private lastNow: number | null = null;
  private status: AdaptiveResolutionSnapshot['status'] = 'baseline';
  private errorCount = 0;
  private diagnosticErrorCount = 0;
  private lastError: string | null = null;
  private cachedSnapshot: Readonly<AdaptiveResolutionSnapshot> | null = null;

  constructor(engine: AdaptiveResolutionEngine, options: AdaptiveResolutionOptions = {}) {
    const scale = options.motionScale ?? 1.5, idle = options.idleRestoreMs ?? 500;
    if (!Number.isFinite(scale) || scale < 1 || scale > 2) throw new RangeError('motionScale 必须为 1 至 2 的有限数。');
    if (!Number.isSafeInteger(idle) || idle < 0 || idle > 5000) throw new RangeError('idleRestoreMs 必须为 0 至 5000 的整数。');
    if (options.onError !== undefined && typeof options.onError !== 'function') throw new TypeError('onError 必须为函数。');
    this.engine = engine; this.options = options; this.idleRestoreMs = idle;
    this.baseline = this.readLevel(); this.motionLevel = this.baseline * scale;
    if (!Number.isFinite(this.motionLevel) || this.motionLevel <= 0) throw new RangeError('运动分辨率等级无效。');
  }

  update(input: AdaptiveResolutionUpdate): Readonly<AdaptiveResolutionSnapshot> {
    if (this.disposed) return this.getSnapshot();
    try {
      if (typeof input.enabled !== 'boolean' || typeof input.moving !== 'boolean'
        || !Number.isFinite(input.now) || input.now < 0 || (this.lastNow !== null && input.now < this.lastNow)) {
        throw new TypeError('分辨率更新需要布尔开关/运动状态和单调非负有限时钟。');
      }
      this.lastNow = input.now;
      if (this.restorationPending) this.restoreOwned();
      if (!input.enabled) {
        this.restoreOwned();
        if (this.enabled) { this.enabled = false; this.invalidateSnapshot(); }
        this.lastMotionAt = null;
        if (!this.restorationPending && !this.suspended) this.setStatus('baseline');
        return this.getSnapshot();
      }
      if (!this.enabled) {
        this.enabled = true; this.suspended = false; this.lastMotionAt = null; this.invalidateSnapshot();
      }
      if (this.suspended || this.restorationPending) return this.getSnapshot();
      const level = this.readLevel();
      if (level !== (this.ownedLevel ?? this.baseline)) { this.yieldOwnership(); return this.getSnapshot(); }
      if (input.moving) {
        this.lastMotionAt = input.now;
        if (level !== this.motionLevel) this.applyLevel(this.motionLevel);
        if (!this.suspended) this.setStatus(this.ownedLevel !== null ? 'reduced' : 'baseline');
      } else if (this.ownedLevel !== null) {
        if (this.lastMotionAt !== null && input.now - this.lastMotionAt >= this.idleRestoreMs) this.restoreOwned();
        else this.setStatus('waiting');
      } else this.setStatus('baseline');
    } catch (error) { this.handleFailure(error); }
    return this.getSnapshot();
  }

  /** 结束当前控制周期；重新关→开后才允许继续降低运动分辨率。 */
  restore(_reason = 'manual'): Readonly<AdaptiveResolutionSnapshot> {
    if (this.disposed) return this.getSnapshot();
    this.suspended = true; this.lastMotionAt = null; this.invalidateSnapshot();
    try { this.restoreOwned(); } catch (error) { this.handleFailure(error); }
    return this.getSnapshot();
  }

  /** 上下文恢复先回到原始等级，恢复期间不自动再次接管。 */
  onContextRestored(): Readonly<AdaptiveResolutionSnapshot> {
    this.lastNow = null;
    return this.restore('context-restored');
  }

  dispose(): void {
    if (this.disposed) return;
    try { this.restoreOwned(); } catch (error) { this.handleFailure(error); }
    this.disposed = true; this.enabled = false; this.suspended = true;
    this.setStatus('disposed'); this.invalidateSnapshot();
  }

  /** 重复状态复用快照，默认关闭时不逐帧创建诊断对象。 */
  getSnapshot(): Readonly<AdaptiveResolutionSnapshot> {
    return this.cachedSnapshot ??= Object.freeze({ baselineLevel: this.baseline, motionLevel: this.motionLevel,
      enabled: this.enabled, reduced: this.ownedLevel !== null && this.ownedLevel !== this.baseline,
      suspended: this.suspended, disposed: this.disposed, restorationPending: this.restorationPending,
      status: this.status, errorCount: this.errorCount, diagnosticErrorCount: this.diagnosticErrorCount, lastError: this.lastError });
  }

  private readLevel(): number {
    const level = this.engine.getHardwareScalingLevel();
    if (!Number.isFinite(level) || level <= 0) throw new RangeError('Engine 返回了无效的 hardwareScalingLevel。');
    return level;
  }

  private applyLevel(level: number): void {
    this.attemptedLevel = level; this.invalidateSnapshot();
    this.engine.setHardwareScalingLevel(level);
    const actual = this.readLevel();
    if (actual !== level) { this.yieldOwnership(); return; }
    this.ownedLevel = level; this.attemptedLevel = null; this.invalidateSnapshot();
  }

  private restoreOwned(): void {
    if (this.ownedLevel === null && this.attemptedLevel === null) return;
    const level = this.readLevel();
    if (level === this.baseline) { this.clearOwnership(); return; }
    if (level !== this.ownedLevel && level !== this.attemptedLevel) { this.yieldOwnership(); return; }
    // 原 setter 即使抛错也可能已经改值，因此保留旧/尝试等级，供错误路径验证后恢复。
    this.engine.setHardwareScalingLevel(this.baseline);
    const actual = this.readLevel();
    if (actual === this.baseline) this.clearOwnership();
    else this.yieldOwnership();
  }

  private clearOwnership(): void {
    this.ownedLevel = null; this.attemptedLevel = null; this.restorationPending = false;
    this.setStatus('baseline'); this.invalidateSnapshot();
  }

  private yieldOwnership(): void {
    this.ownedLevel = null; this.attemptedLevel = null; this.restorationPending = false; this.suspended = true;
    this.setStatus('yielded'); this.invalidateSnapshot();
  }

  private handleFailure(error: unknown): void {
    this.suspended = true; this.recordError(error);
    try { this.restoreOwned(); }
    catch (restoreError) {
      this.restorationPending = this.ownedLevel !== null || this.attemptedLevel !== null;
      this.recordError(restoreError);
    }
    this.setStatus('faulted'); this.invalidateSnapshot();
  }

  private recordError(error: unknown): void {
    this.errorCount++; this.lastError = error instanceof Error ? error.message : String(error); this.invalidateSnapshot();
    try { this.options.onError?.(error); } catch { this.diagnosticErrorCount++; this.invalidateSnapshot(); }
  }

  private setStatus(status: AdaptiveResolutionSnapshot['status']): void {
    if (this.status !== status) { this.status = status; this.invalidateSnapshot(); }
  }
  private invalidateSnapshot(): void { this.cachedSnapshot = null; }
}
