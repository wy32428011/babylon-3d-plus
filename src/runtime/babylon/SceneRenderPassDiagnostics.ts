import type { Observable } from '@babylonjs/core/Misc/observable.js';
import type { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import type { Scene } from '@babylonjs/core/scene.js';

const PHASES = ['animations', 'activeMeshes', 'renderTargets', 'draw', 'particles', 'camera'] as const;
type Phase = typeof PHASES[number];
type Measurement = { startedAt: number | null; current: number; total: number };
type ShadowMeasurement = {
  lightId: number;
  targetId: number;
  face: number;
  startedAt: number | null;
  startedDraws: number | null;
  currentMs: number;
  currentDraws: number;
  currentPasses: number;
  totalMs: number;
  totalDraws: number;
  totalPasses: number;
  drawsAvailable: boolean;
};

export type SceneRenderPassSnapshot = {
  /** 各阶段为包含式 CPU 墙钟时间，不能相加，也不是 GPU 执行时间。 */
  timing: 'inclusive-cpu-wall-ms';
  completedFrames: number;
  discardedFrames: number;
  cpuMs: Record<Phase, number>;
  drawCallsPerFrame: number | null;
  shadowDrawCallsPerFrame: number | null;
  otherDrawCallsPerFrame: number | null;
  shadowPasses: Array<{
    lightId: number;
    targetId: number;
    face: number;
    passes: number;
    cpuMsPerFrame: number;
    drawCallsPerFrame: number | null;
  }>;
};

/** 只拷贝诊断数值，不把灯光、纹理名称或业务配置带进可复制报告。 */
export function copySceneRenderPassSnapshot(snapshot: SceneRenderPassSnapshot | null | undefined): SceneRenderPassSnapshot | null {
  if (!snapshot) return null;
  return {
    timing: 'inclusive-cpu-wall-ms',
    completedFrames: snapshot.completedFrames,
    discardedFrames: snapshot.discardedFrames,
    cpuMs: Object.fromEntries(PHASES.map(phase => [phase, snapshot.cpuMs[phase]])) as Record<Phase, number>,
    drawCallsPerFrame: snapshot.drawCallsPerFrame,
    shadowDrawCallsPerFrame: snapshot.shadowDrawCallsPerFrame,
    otherDrawCallsPerFrame: snapshot.otherDrawCallsPerFrame,
    shadowPasses: snapshot.shadowPasses.map(pass => ({
      lightId: pass.lightId, targetId: pass.targetId, face: pass.face, passes: pass.passes,
      cpuMsPerFrame: pass.cpuMsPerFrame, drawCallsPerFrame: pass.drawCallsPerFrame,
    })),
  };
}

/** 诊断窗口内观察原生阶段，不包装 draw、不读回 GPU、不改投射集合或渲染顺序。 */
export class SceneRenderPassDiagnostics {
  private readonly phases = Object.fromEntries(PHASES.map(phase => [phase, {
    startedAt: null, current: 0, total: 0,
  }])) as Record<Phase, Measurement>;
  private readonly targets = new Map<RenderTargetTexture, { reset: () => void; release: () => void }>();
  private readonly shadows = new Map<string, ShadowMeasurement>();
  private releases: Array<() => void> = [];
  private enabled = false;
  private frameActive = false;
  private completedFrames = 0;
  private discardedFrames = 0;
  private totalDraws = 0;
  private drawsAvailable = true;

  constructor(private readonly scene: Scene, private readonly readDrawCalls: () => number | null) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.resetWindow();
    if (!enabled) {
      for (const release of this.releases) release();
      this.releases = [];
      for (const target of this.targets.values()) target.release();
      this.targets.clear(); this.shadows.clear(); this.frameActive = false;
      return;
    }
    this.watch(this.scene.onBeforeAnimationsObservable, () => this.beginFrame());
    this.watchPhase('animations', this.scene.onBeforeAnimationsObservable, this.scene.onAfterAnimationsObservable);
    this.watchPhase('activeMeshes', this.scene.onBeforeActiveMeshesEvaluationObservable, this.scene.onAfterActiveMeshesEvaluationObservable);
    this.watch(this.scene.onBeforeRenderTargetsRenderObservable, () => this.syncShadowTargets());
    this.watchPhase('renderTargets', this.scene.onBeforeRenderTargetsRenderObservable, this.scene.onAfterRenderTargetsRenderObservable);
    this.watchPhase('draw', this.scene.onBeforeDrawPhaseObservable, this.scene.onAfterDrawPhaseObservable);
    this.watchPhase('particles', this.scene.onBeforeParticlesRenderingObservable, this.scene.onAfterParticlesRenderingObservable);
    this.watchPhase('camera', this.scene.onBeforeCameraRenderObservable, this.scene.onAfterCameraRenderObservable);
    this.watch(this.scene.onAfterRenderObservable, () => this.endFrame());
  }

  /** 返回从上次采样以来完整帧的均值；未完成首帧时仍为不可用。 */
  sample(): SceneRenderPassSnapshot | null {
    if (!this.enabled || this.completedFrames === 0) return null;
    const frames = this.completedFrames;
    const passes = [...this.shadows.values()].filter(value => value.totalPasses > 0);
    const shadowDraws = passes.every(value => value.drawsAvailable)
      ? passes.reduce((sum, value) => sum + value.totalDraws, 0) / frames : null;
    const totalDraws = this.drawsAvailable ? this.totalDraws / frames : null;
    const snapshot: SceneRenderPassSnapshot = {
      timing: 'inclusive-cpu-wall-ms', completedFrames: frames, discardedFrames: this.discardedFrames,
      cpuMs: Object.fromEntries(PHASES.map(phase => [phase, this.phases[phase].total / frames])) as Record<Phase, number>,
      drawCallsPerFrame: totalDraws,
      shadowDrawCallsPerFrame: shadowDraws,
      // 嵌套或外部重置计数器时不把负差伪装为零；其余绘制包括主通道和后处理。
      otherDrawCallsPerFrame: totalDraws !== null && shadowDraws !== null && totalDraws >= shadowDraws ? totalDraws - shadowDraws : null,
      shadowPasses: passes.map(value => ({ lightId: value.lightId, targetId: value.targetId, face: value.face,
        passes: value.totalPasses, cpuMsPerFrame: value.totalMs / frames,
        drawCallsPerFrame: value.drawsAvailable ? value.totalDraws / frames : null })),
    };
    this.resetWindow();
    return snapshot;
  }

  dispose(): void { this.setEnabled(false); }

  private watch<T>(observable: Observable<T>, callback: (value: T) => void, releases = this.releases): void {
    const observer = observable.add(callback);
    releases.push(() => observable.remove(observer));
  }

  private watchPhase<T, U>(phase: Phase, before: Observable<T>, after: Observable<U>): void {
    const measure = this.phases[phase];
    this.watch(before, () => { if (this.frameActive) measure.startedAt = performance.now(); });
    this.watch(after, () => {
      if (this.frameActive && measure.startedAt !== null) measure.current += Math.max(0, performance.now() - measure.startedAt);
      measure.startedAt = null;
    });
  }

  private beginFrame(): void {
    if (this.frameActive) this.discardedFrames++;
    this.frameActive = true;
    for (const target of this.targets.values()) target.reset();
    for (const phase of PHASES) { this.phases[phase].startedAt = null; this.phases[phase].current = 0; }
    for (const value of this.shadows.values()) {
      value.startedAt = null; value.startedDraws = null;
      value.currentMs = value.currentDraws = value.currentPasses = 0;
    }
  }

  private endFrame(): void {
    if (!this.frameActive) return;
    this.frameActive = false;
    this.completedFrames++;
    for (const phase of PHASES) this.phases[phase].total += this.phases[phase].current;
    const draws = this.readDrawCalls();
    if (draws === null) this.drawsAvailable = false; else this.totalDraws += draws;
    for (const value of this.shadows.values()) {
      value.totalMs += value.currentMs; value.totalDraws += value.currentDraws; value.totalPasses += value.currentPasses;
    }
  }

  private resetWindow(): void {
    this.completedFrames = this.discardedFrames = this.totalDraws = 0;
    this.drawsAvailable = true;
    for (const phase of PHASES) this.phases[phase].total = 0;
    const activeTargets = new Set([...this.targets.keys()].map(target => target.uniqueId));
    for (const [key, value] of this.shadows) {
      value.totalMs = value.totalDraws = value.totalPasses = 0; value.drawsAvailable = true;
      if (!activeTargets.has(value.targetId)) this.shadows.delete(key);
    }
  }

  private syncShadowTargets(): void {
    const current = new Set<RenderTargetTexture>();
    for (const light of this.scene.lights) for (const generator of light.getShadowGenerators()?.values() ?? []) {
      const target = generator.getShadowMap();
      if (!target || current.has(target)) continue;
      current.add(target);
      if (this.targets.has(target)) continue;
      const releases: Array<() => void> = [];
      let bound = false;
      let activePass: ShadowMeasurement | null = null;
      const reset = () => { bound = false; activePass = null; };
      this.watch(target.onBeforeBindObservable, () => { bound = true; }, releases);
      this.watch(target.onAfterUnbindObservable, reset, releases);
      this.watch(target.onBeforeRenderObservable, face => {
        // 原生 readiness 检查也发出 before/after，但没有实际绑定和绘制，不计入渲染 pass。
        if (!this.frameActive || !bound) return;
        const key = `${target.uniqueId}:${face}`;
        let value = this.shadows.get(key);
        if (!value) {
          value = { lightId: light.uniqueId, targetId: target.uniqueId, face, startedAt: null, startedDraws: null,
            currentMs: 0, currentDraws: 0, currentPasses: 0, totalMs: 0, totalDraws: 0, totalPasses: 0, drawsAvailable: true };
          this.shadows.set(key, value);
        }
        activePass = value;
        value.startedAt = performance.now(); value.startedDraws = this.readDrawCalls();
      }, releases);
      this.watch(target.onAfterRenderObservable, () => {
        // Babylon 9.12 的 CSM before 携带 layer，而 unbind 后的 after 仍携带 faceIndex=0。
        const value = activePass;
        activePass = null;
        if (!this.frameActive || !bound || !value || value.startedAt === null) return;
        value.currentMs += Math.max(0, performance.now() - value.startedAt); value.currentPasses++;
        const draws = this.readDrawCalls();
        if (draws === null || value.startedDraws === null || draws < value.startedDraws) value.drawsAvailable = false;
        else value.currentDraws += draws - value.startedDraws;
        value.startedAt = value.startedDraws = null;
      }, releases);
      this.targets.set(target, { reset, release: () => { for (const release of releases) release(); } });
    }
    for (const [target, value] of this.targets) if (!current.has(target)) {
      value.release(); this.targets.delete(target);
    }
  }
}
