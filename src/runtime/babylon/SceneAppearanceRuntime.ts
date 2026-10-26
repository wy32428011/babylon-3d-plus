import { refreshSceneLightingMaterialDrawCaches } from './refreshDetachedInstanceSourceMaterials.ts';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import type { AbstractEngine, Camera, Observer, Scene } from '@babylonjs/core';
import type { SceneAppearanceConfig } from '../../../electron/shared/sceneLightingConfig.ts';

/** 只请求硬件可支持的档位；未知能力保持原1采样，不能把配置值冒充已分配的物理RTT。 */
export function resolveBloomMsaaSamples(enabled: boolean, supportMSAA: boolean, maxSamples: number): 1 | 2 | 4 {
  if (!enabled || !supportMSAA || !Number.isFinite(maxSamples)) return 1;
  return maxSamples >= 4 ? 4 : maxSamples >= 2 ? 2 : 1;
}

/** 外观只调整显示与后处理，不创建光源，也不改写物理照明。 */
export class SceneAppearanceRuntime {
  private pipeline: DefaultRenderingPipeline | null = null;
  private pipelineCamera: Camera | null = null;
  private cameraObserver: Observer<Scene> | null = null;
  private baseline: ReturnType<SceneAppearanceRuntime['capture']> | null = null;
  private bloomMsaaOwnedSamples: number | null = null;
  private bloomMsaaContextObserver: Observer<AbstractEngine> | null = null;
  private bloomMsaaRequested = false;
  private bloomMsaaReason: 'inactive' | 'disabled' | 'configured' | 'unsupported-hardware' = 'inactive';
  constructor(private readonly scene: Scene) {}

  private capture() {
    const image = this.scene.imageProcessingConfiguration;
    return { background: this.scene.clearColor.clone(), applyByPostProcess: image.applyByPostProcess,
      exposure: image.exposure, contrast: image.contrast, toneMappingEnabled: image.toneMappingEnabled, toneMappingType: image.toneMappingType };
  }

  sync(appearance: SceneAppearanceConfig): void {
    const previousImage = this.imageSignature();
    this.baseline ??= this.capture();
    const color = Color3.FromHexString(appearance.backgroundColor);
    this.scene.clearColor.set(color.r, color.g, color.b, 1);
    const image = this.scene.imageProcessingConfiguration;
    image.exposure = appearance.exposure; image.contrast = appearance.contrast;
    image.toneMappingEnabled = appearance.toneMappingEnabled;
    image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    if (appearance.bloomEnabled) {
      if (!this.pipeline) {
        // 材质阶段已处理曝光和色调，泛光读取最终颜色，避免重复变换。
        this.pipeline = new DefaultRenderingPipeline('sceneAppearanceBloom', false, this.scene, []);
        this.pipeline.bloomEnabled = true; this.pipeline.bloomThreshold = 0.85;
        this.pipeline.bloomKernel = 32; this.pipeline.fxaaEnabled = true;
        this.cameraObserver = this.scene.onBeforeRenderObservable.add(() => this.syncCamera());
      }
      this.pipeline.bloomWeight = appearance.bloomWeight; this.syncCamera();
      this.syncBloomMsaa(appearance.bloomMsaaEnabled === true);
    } else this.disposePipeline();
    if (previousImage !== this.imageSignature()) refreshSceneLightingMaterialDrawCaches(this.scene);
  }

  /** 只作用于本模块拥有的Bloom管线，不改模型特效的GlowLayer或Engine默认帧缓冲。 */
  private syncBloomMsaa(enabled: boolean): void {
    if (!this.pipeline) return;
    this.bloomMsaaRequested = enabled;
    if (!enabled) {
      if (this.bloomMsaaOwnedSamples !== null && this.pipeline.samples === this.bloomMsaaOwnedSamples) this.pipeline.samples = 1;
      this.bloomMsaaContextObserver?.remove(); this.bloomMsaaContextObserver = null;
      this.bloomMsaaOwnedSamples = null; this.bloomMsaaReason = 'disabled';
      return;
    }
    const engine = this.scene.getEngine();
    this.bloomMsaaContextObserver ??= engine.onContextRestoredObservable.add(() => {
      if (this.pipeline && this.bloomMsaaRequested) this.syncBloomMsaa(true);
    });
    const samples = resolveBloomMsaaSamples(true, engine._features.supportMSAA === true, engine.getCaps().maxMSAASamples);
    if (this.pipeline.samples !== samples) this.pipeline.samples = samples;
    this.bloomMsaaOwnedSamples = samples;
    this.bloomMsaaReason = samples > 1 ? 'configured' : 'unsupported-hardware';
  }

  /** configuredSamples是SDK管线配置；物理多采样RTT仍由实际渲染验收确认。 */
  getBloomMsaaState() {
    return Object.freeze({ requested: this.bloomMsaaRequested, configuredSamples: this.pipeline?.samples ?? 1,
      active: Boolean(this.pipeline), reason: this.bloomMsaaReason });
  }

  private imageSignature(): string {
    const image = this.scene.imageProcessingConfiguration;
    return JSON.stringify([image.exposure, image.contrast, image.toneMappingEnabled, image.toneMappingType, image.applyByPostProcess]);
  }

  private syncCamera(): void {
    if (!this.pipeline || this.pipelineCamera === this.scene.activeCamera) return;
    if (this.pipelineCamera) this.pipeline.removeCamera(this.pipelineCamera);
    this.pipelineCamera = this.scene.activeCamera;
    if (this.pipelineCamera) this.pipeline.addCamera(this.pipelineCamera);
  }

  private disposePipeline(): void {
    this.bloomMsaaContextObserver?.remove(); this.bloomMsaaContextObserver = null;
    if (this.cameraObserver) this.scene.onBeforeRenderObservable.remove(this.cameraObserver);
    this.cameraObserver = null;
    if (this.pipeline) {
      this.pipeline.dispose();
      this.scene.imageProcessingConfiguration.applyByPostProcess = this.baseline?.applyByPostProcess ?? false;
    }
    this.pipeline = null; this.pipelineCamera = null;
    this.bloomMsaaOwnedSamples = null; this.bloomMsaaRequested = false; this.bloomMsaaReason = 'inactive';
  }

  dispose(): void {
    const previousImage = this.imageSignature();
    this.disposePipeline();
    const baseline = this.baseline;
    if (!baseline) return;
    this.scene.clearColor.copyFrom(baseline.background);
    const image = this.scene.imageProcessingConfiguration;
    image.exposure = baseline.exposure; image.contrast = baseline.contrast;
    image.toneMappingEnabled = baseline.toneMappingEnabled; image.toneMappingType = baseline.toneMappingType;
    this.baseline = null;
    if (previousImage !== this.imageSignature()) refreshSceneLightingMaterialDrawCaches(this.scene);
  }
}
