import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import type { AbstractEngine, Camera, Observer, Scene } from '@babylonjs/core';
import type { SceneSsaoMode } from '../../../electron/shared/sceneLightingConfig.ts';

export type SceneSsaoState = {
  readonly requested: boolean;
  readonly active: boolean;
  readonly mode: SceneSsaoMode;
  readonly reason: 'disabled' | 'active' | 'unsupported-hardware';
};

const SSAO_PIPELINE_NAME = 'sceneAppearanceSsao2';

type SsaoProfile = {
  ssaoRatio: number;
  blurRatio: number;
  samples: number;
  radius: number;
  totalStrength: number;
  maxZ: number;
  minZAspect: number;
  epsilon: number;
  base: number;
  expensiveBlur: boolean;
  bilateralSamples: number;
  bilateralSoften: number;
  bilateralTolerance: number;
};

const SSAO_PROFILES: Record<Exclude<SceneSsaoMode, 'off'>, SsaoProfile> = {
  balanced: {
    ssaoRatio: 0.5,
    blurRatio: 0.5,
    samples: 16,
    radius: 1.1,
    totalStrength: 0.85,
    maxZ: 150,
    minZAspect: 0.2,
    epsilon: 0.02,
    base: 0.05,
    expensiveBlur: true,
    bilateralSamples: 12,
    bilateralSoften: 0.8,
    bilateralTolerance: 0.8,
  },
  high: {
    ssaoRatio: 0.75,
    blurRatio: 0.75,
    samples: 24,
    radius: 1.25,
    totalStrength: 0.95,
    maxZ: 200,
    minZAspect: 0.2,
    epsilon: 0.015,
    base: 0.03,
    expensiveBlur: true,
    bilateralSamples: 16,
    bilateralSoften: 0.85,
    bilateralTolerance: 0.85,
  },
};

function isSsaoHardwareSupported(scene: Scene): boolean {
  const engine = scene.getEngine() as AbstractEngine & {
    _features?: { supportSSAO2?: boolean };
    webGLVersion?: number;
  };
  if (engine._features?.supportSSAO2 !== true) return false;
  if (typeof engine.webGLVersion === 'number' && engine.webGLVersion < 2) return false;
  return SSAO2RenderingPipeline.IsSupported;
}

/**
 * 管理仓储与数字孪生场景的实时屏幕空间接触暗影（SSAO2）。
 * 仅在显式开启且硬件支持时注册管线与相机监听，关闭时彻底卸载，不额外创建光源。
 */
export class SceneSsaoRuntime {
  private readonly scene: Scene;
  private pipeline: SSAO2RenderingPipeline | null = null;
  private pipelineMode: Exclude<SceneSsaoMode, 'off'> | null = null;
  private attachedCamera: Camera | null = null;
  private cameraObserver: Observer<Scene> | null = null;
  private contextObserver: Observer<AbstractEngine> | null = null;
  private requestedMode: SceneSsaoMode = 'off';
  private reason: SceneSsaoState['reason'] = 'disabled';
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  sync(mode: SceneSsaoMode): void {
    if (this.disposed) return;
    this.requestedMode = mode;
    if (mode === 'off') {
      this.disposePipeline();
      this.reason = 'disabled';
      return;
    }
    if (!isSsaoHardwareSupported(this.scene)) {
      this.disposePipeline();
      this.reason = 'unsupported-hardware';
      return;
    }
    if (this.pipeline && this.pipelineMode === mode) {
      this.syncCamera();
      this.reason = 'active';
      return;
    }
    this.disposePipeline();
    this.createPipeline(mode);
  }

  getState(): SceneSsaoState {
    return Object.freeze({
      requested: this.requestedMode !== 'off',
      active: Boolean(this.pipeline),
      mode: this.requestedMode,
      reason: this.reason,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestedMode = 'off';
    this.reason = 'disabled';
    this.disposePipeline();
  }

  private createPipeline(mode: Exclude<SceneSsaoMode, 'off'>): void {
    const profile = SSAO_PROFILES[mode];
    const activeCamera = this.scene.activeCamera;
    const cameras = activeCamera ? [activeCamera] : [];
    const pipeline = new SSAO2RenderingPipeline(
      SSAO_PIPELINE_NAME,
      this.scene,
      { ssaoRatio: profile.ssaoRatio, blurRatio: profile.blurRatio },
      cameras,
    );
    pipeline.samples = profile.samples;
    pipeline.radius = profile.radius;
    pipeline.totalStrength = profile.totalStrength;
    pipeline.maxZ = profile.maxZ;
    pipeline.minZAspect = profile.minZAspect;
    pipeline.epsilon = profile.epsilon;
    pipeline.base = profile.base;
    pipeline.expensiveBlur = profile.expensiveBlur;
    pipeline.bilateralSamples = profile.bilateralSamples;
    pipeline.bilateralSoften = profile.bilateralSoften;
    pipeline.bilateralTolerance = profile.bilateralTolerance;

    this.pipeline = pipeline;
    this.pipelineMode = mode;
    this.attachedCamera = activeCamera;
    this.reason = 'active';

    this.cameraObserver = this.scene.onBeforeRenderObservable.add(() => this.syncCamera());
    const engine = this.scene.getEngine();
    this.contextObserver = engine.onContextRestoredObservable.add(() => {
      if (this.disposed || this.requestedMode === 'off') return;
      const targetMode = this.requestedMode;
      this.disposePipeline();
      if (isSsaoHardwareSupported(this.scene)) {
        this.createPipeline(targetMode);
      } else {
        this.reason = 'unsupported-hardware';
      }
    });
  }

  private syncCamera(): void {
    if (!this.pipeline) return;
    const nextCamera = this.scene.activeCamera;
    if (this.attachedCamera === nextCamera) return;
    const manager = this.scene.postProcessRenderPipelineManager;
    if (this.attachedCamera) {
      manager.detachCamerasFromRenderPipeline(SSAO_PIPELINE_NAME, this.attachedCamera);
    }
    this.attachedCamera = nextCamera;
    if (nextCamera) {
      manager.attachCamerasToRenderPipeline(SSAO_PIPELINE_NAME, nextCamera);
    }
  }

  private disposePipeline(): void {
    if (this.contextObserver) {
      this.scene.getEngine().onContextRestoredObservable.remove(this.contextObserver);
      this.contextObserver = null;
    }
    if (this.cameraObserver) {
      this.scene.onBeforeRenderObservable.remove(this.cameraObserver);
      this.cameraObserver = null;
    }
    if (this.pipeline) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
    this.pipelineMode = null;
    this.attachedCamera = null;
  }
}
