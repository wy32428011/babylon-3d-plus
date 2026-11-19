import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import type { Observable } from '@babylonjs/core/Misc/observable.js';
import { PerfCounter } from '@babylonjs/core/Misc/perfCounter.js';
import type { ObjectRenderer } from '@babylonjs/core/Rendering/objectRenderer.js';
import type { Scene } from '@babylonjs/core/scene.js';

const PHASES = ['animations', 'activeMeshes', 'renderTargets', 'draw', 'particles', 'camera'] as const;
type Phase = typeof PHASES[number];
type Measurement = { startedAt: number | null; current: number; total: number };
type ShadowMeasurement = {
  lightId: number;
  targetId: number;
  face: number;
  currentMs: number;
  currentDraws: number | null;
  currentPasses: number;
  totalMs: number;
  totalDraws: number | null;
  totalPasses: number;
};
type PendingShadowPass = {
  measure: ShadowMeasurement;
  passId: number;
  startedAt: number;
  startedDraws: number | null;
};
type DrawCounterGeneration = { counter: PerfCounter; generation: number };
type FrameDrawCounter = DrawCounterGeneration & { lastDraws: number };

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
  private readonly engine: AbstractEngine;
  private readonly targets = new Map<RenderTargetTexture, () => void>();
  private readonly pendingShadowPasses: PendingShadowPass[] = [];
  private readonly shadows = new Map<string, ShadowMeasurement>();
  private releases: Array<() => void> = [];
  private enabled = false;
  private frameId: number | null = null;
  private frameDrawCounter: FrameDrawCounter | null = null;
  private lastDrawCounterGeneration: DrawCounterGeneration | null = null;
  private completedFrames = 0;
  private discardedFrames = 0;
  private totalDraws: number | null = 0;
  private totalShadowDraws: number | null = 0;

  constructor(private readonly scene: Scene, private readonly readDrawCalls: () => number | null) {
    this.engine = scene.getEngine();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.resetWindow();
    this.lastDrawCounterGeneration = enabled ? this.getDrawCounterGeneration() : null;
    if (!enabled) {
      for (const release of this.releases) release();
      this.releases = [];
      for (const release of this.targets.values()) release();
      this.targets.clear();
      this.shadows.clear();
      this.pendingShadowPasses.length = 0;
      this.frameId = this.frameDrawCounter = null;
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
    this.syncShadowTargets();
  }

  /** 返回从上次采样以来完整帧的均值；未完成首帧时仍为不可用。 */
  sample(): SceneRenderPassSnapshot | null {
    if (!this.enabled || this.completedFrames === 0) return null;
    const frames = this.completedFrames;
    const passes = [...this.shadows.values()].filter(value => value.totalPasses > 0);
    const shadowDraws = this.totalShadowDraws === null ? null : this.totalShadowDraws / frames;
    const totalDraws = this.totalDraws === null ? null : this.totalDraws / frames;
    const snapshot: SceneRenderPassSnapshot = {
      timing: 'inclusive-cpu-wall-ms', completedFrames: frames, discardedFrames: this.discardedFrames,
      cpuMs: Object.fromEntries(PHASES.map(phase => [phase, this.phases[phase].total / frames])) as Record<Phase, number>,
      drawCallsPerFrame: totalDraws,
      shadowDrawCallsPerFrame: shadowDraws,
      // 其余绘制包括主通道和后处理，两类计数都有效时才相减。
      otherDrawCallsPerFrame: totalDraws !== null && shadowDraws !== null && totalDraws >= shadowDraws ? totalDraws - shadowDraws : null,
      shadowPasses: passes.map(value => ({ lightId: value.lightId, targetId: value.targetId, face: value.face,
        passes: value.totalPasses, cpuMsPerFrame: value.totalMs / frames,
        drawCallsPerFrame: value.totalDraws === null ? null : value.totalDraws / frames })),
    };
    this.resetWindow();
    return snapshot;
  }

  dispose(): void { this.setEnabled(false); }

  private watch<T>(
    observable: Observable<T>, callback: (value: T) => void, releases = this.releases, insertFirst = false,
  ): void {
    const observer = observable.add(callback, -1, insertFirst);
    releases.push(() => observable.remove(observer));
  }

  private watchPhase<T, U>(phase: Phase, before: Observable<T>, after: Observable<U>): void {
    const measure = this.phases[phase];
    this.watch(before, () => { if (this.isCurrentFrame()) measure.startedAt = performance.now(); });
    this.watch(after, () => {
      if (this.isCurrentFrame() && measure.startedAt !== null) {
        measure.current += Math.max(0, performance.now() - measure.startedAt);
      }
      measure.startedAt = null;
    });
  }

  private isCurrentFrame(): boolean {
    return this.frameId === this.scene.getFrameId();
  }

  private beginFrame(): void {
    if (this.frameId !== null) this.discardedFrames++;
    this.frameId = this.scene.getFrameId();
    this.pendingShadowPasses.length = 0;
    for (const phase of PHASES) { this.phases[phase].startedAt = null; this.phases[phase].current = 0; }
    for (const value of this.shadows.values()) value.currentMs = value.currentDraws = value.currentPasses = 0;

    // SceneInstrumentation 在同一个 beforeAnimations 事件中先重置原生计数器。
    const previous = this.lastDrawCounterGeneration;
    const current = this.getDrawCounterGeneration();
    this.lastDrawCounterGeneration = current;
    this.frameDrawCounter = current && current.generation > 0
      && (current.counter !== previous?.counter || current.generation > previous.generation)
      ? { ...current, lastDraws: 0 } : null;
    this.readFrameDraws();
  }

  private getDrawCounterGeneration(): DrawCounterGeneration | null {
    const counter = this.engine._drawCalls;
    const generation = counter?.count;
    return Number.isSafeInteger(generation) && generation >= 0 ? { counter, generation } : null;
  }

  private readFrameDraws(): number | null {
    const frame = this.frameDrawCounter;
    if (!frame) return null;
    const draws = this.readDrawCalls();
    if (!PerfCounter.Enabled || this.engine._drawCalls !== frame.counter || frame.counter.count !== frame.generation
      || draws === null || !Number.isSafeInteger(draws) || draws < frame.lastDraws) {
      this.frameDrawCounter = null;
      return null;
    }
    frame.lastDraws = draws;
    return draws;
  }

  private endFrame(): void {
    if (this.frameId === null) return;
    const paired = this.isCurrentFrame();
    const draws = paired ? this.readFrameDraws() : null;
    this.lastDrawCounterGeneration = this.getDrawCounterGeneration();
    this.frameId = this.frameDrawCounter = null;
    for (const { measure } of this.pendingShadowPasses) measure.currentDraws = null;
    this.pendingShadowPasses.length = 0;
    if (!paired) { this.discardedFrames++; return; }

    this.completedFrames++;
    for (const phase of PHASES) this.phases[phase].total += this.phases[phase].current;
    if (draws === null) this.totalDraws = this.totalShadowDraws = null;
    else if (this.totalDraws !== null) this.totalDraws += draws;
    for (const value of this.shadows.values()) {
      value.totalMs += value.currentMs;
      value.totalPasses += value.currentPasses;
      if (value.currentDraws === null || (draws === null && value.currentPasses > 0)) {
        value.totalDraws = this.totalShadowDraws = null;
      } else {
        if (value.totalDraws !== null) value.totalDraws += value.currentDraws;
        if (this.totalShadowDraws !== null) this.totalShadowDraws += value.currentDraws;
      }
    }
  }

  private resetWindow(): void {
    this.completedFrames = this.discardedFrames = this.totalDraws = this.totalShadowDraws = 0;
    for (const phase of PHASES) this.phases[phase].total = 0;
    const activeTargets = this.frameId === null ? new Set([...this.targets.keys()].map(target => target.uniqueId)) : null;
    for (const [key, value] of this.shadows) {
      value.totalMs = value.totalDraws = value.totalPasses = 0;
      if (activeTargets && !activeTargets.has(value.targetId)) this.shadows.delete(key);
    }
  }

  private syncShadowTargets(): void {
    const current = new Set<RenderTargetTexture>();
    // Babylon 9.12 的 RTT 与其 ObjectRenderer 返回同一份 renderPassIds 数组。
    const renderers = new Map(this.scene.objectRenderers.map(renderer => [renderer.renderPassIds, renderer]));
    for (const light of this.scene.lights) for (const generator of light.getShadowGenerators()?.values() ?? []) {
      const target = generator.getShadowMap();
      if (!target || current.has(target) || !target.renderPassIds.length) continue;
      const renderer = renderers.get(target.renderPassIds);
      if (!renderer) continue;
      current.add(target);
      if (!this.targets.has(target)) this.watchShadowTarget(target, renderer, light.uniqueId);
    }
    for (const [target, release] of this.targets) if (!current.has(target)) {
      release();
      this.targets.delete(target);
    }
  }

  private watchShadowTarget(target: RenderTargetTexture, renderer: ObjectRenderer, lightId: number): void {
    const releases: Array<() => void> = [];
    // 此处的 passIndex 是 RTT 的 face 或 layer。Readiness 只发普通渲染通知。
    this.watch(renderer.onBeforeRenderingManagerRenderObservable, face => {
      if (!this.isCurrentFrame()) return;
      const measure = this.getShadowMeasurement(lightId, target.uniqueId, face);
      const passId = renderer.renderPassIds[face];
      if (passId === undefined || passId !== this.engine.currentRenderPassId) {
        measure.currentDraws = null;
        return;
      }
      const enclosing = this.pendingShadowPasses.at(-1);
      if (enclosing) {
        // 嵌套区间的包含式差值会重复归属提交。
        enclosing.measure.currentDraws = measure.currentDraws = null;
      }
      const startedDraws = this.readFrameDraws();
      this.pendingShadowPasses.push({ measure, passId, startedAt: performance.now(), startedDraws });
    }, releases);
    // 优先于 RTT 的 after 回调，结束计数不包含目标后处理。
    this.watch(renderer.onAfterRenderingManagerRenderObservable, face => {
      if (!this.isCurrentFrame()) return;
      const measure = this.getShadowMeasurement(lightId, target.uniqueId, face);
      const pending = this.pendingShadowPasses.at(-1);
      const passId = renderer.renderPassIds[face];
      if (!pending || pending.measure !== measure || pending.passId !== passId || passId !== this.engine.currentRenderPassId) {
        if (pending) pending.measure.currentDraws = null;
        measure.currentDraws = null;
        return;
      }
      this.pendingShadowPasses.pop();
      measure.currentMs += Math.max(0, performance.now() - pending.startedAt);
      measure.currentPasses++;
      const draws = this.readFrameDraws();
      if (draws === null || pending.startedDraws === null) measure.currentDraws = null;
      else if (measure.currentDraws !== null) measure.currentDraws += draws - pending.startedDraws;
    }, releases, true);
    this.targets.set(target, () => { for (const release of releases) release(); });
  }

  private getShadowMeasurement(lightId: number, targetId: number, face: number): ShadowMeasurement {
    const key = `${lightId}:${targetId}:${face}`;
    let measure = this.shadows.get(key);
    if (!measure) {
      measure = { lightId, targetId, face, currentMs: 0, currentDraws: 0, currentPasses: 0,
        totalMs: 0, totalDraws: 0, totalPasses: 0 };
      this.shadows.set(key, measure);
    }
    return measure;
  }
}
