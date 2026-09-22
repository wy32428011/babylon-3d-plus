import { Color3, DefaultRenderingPipeline, DirectionalLight, HemisphericLight, ImageProcessingConfiguration, Scene, Vector3, type Camera, type Observer } from '@babylonjs/core';
import type { SceneThemeSettings } from '../../editor/model/sceneTheme';
import type { SceneShadowSettings } from '../../editor/model/SceneDocument';

/** 一套主题只有一个主光，参数更新不创建实体或重复渲染管线。 */
export class SceneThemeRuntime {
  mainLight: DirectionalLight | null = null;
  private pipeline: DefaultRenderingPipeline | null = null;
  private pipelineCamera: Camera | null = null;
  private cameraObserver: Observer<Scene> | null = null;
  private baseline: ReturnType<SceneThemeRuntime['capture']> | null = null;
  constructor(private readonly scene: Scene) {}

  private capture() {
    const s = this.scene, i = s.imageProcessingConfiguration;
    const fill = s.getLightByName('EditorLight');
    return {
      background: s.clearColor.clone(), environmentIntensity: s.environmentIntensity,
      applyByPostProcess: i.applyByPostProcess,
      exposure: i.exposure, contrast: i.contrast, toneMappingEnabled: i.toneMappingEnabled, toneMappingType: i.toneMappingType,
      fill: fill instanceof HemisphericLight ? { light: fill, priority: fill.renderPriority, intensity: fill.intensity, diffuse: fill.diffuse.clone(), ground: fill.groundColor.clone(), specular: fill.specular.clone() } : null,
    };
  }

  sync(theme: SceneThemeSettings | null | undefined, shadows: Pick<SceneShadowSettings, 'sunAzimuthDegrees'|'sunElevationDegrees'|'sunIntensity'|'fillIntensity'>): void {
    if (!theme) { this.restore(); return; }
    this.baseline ??= this.capture();
    const s = this.scene;
    const color = Color3.FromHexString(theme.backgroundColor);
    s.clearColor.set(color.r, color.g, color.b, 1);
    s.environmentIntensity = theme.environmentIntensity;
    const fill = s.getLightByName('EditorLight');
    if (fill instanceof HemisphericLight) {
      fill.diffuse = Color3.FromHexString(theme.fillColor);
      fill.groundColor = Color3.FromHexString(theme.groundColor);
      fill.specular = Color3.Black(); fill.intensity = shadows.fillIntensity;
      fill.renderPriority = 90;
    }
    this.mainLight ??= new DirectionalLight('__SceneThemeMain', Vector3.Down(), s);
    this.mainLight.metadata = { sceneThemeOwned: true };
    // 限制单材质灯光数量时，主光和底光仍需保留，局部灯使用其余槽位。
    this.mainLight.renderPriority = 100;
    const az = shadows.sunAzimuthDegrees * Math.PI / 180, el = shadows.sunElevationDegrees * Math.PI / 180;
    this.mainLight.direction.set(-Math.sin(az)*Math.cos(el), -Math.sin(el), -Math.cos(az)*Math.cos(el));
    this.mainLight.position.copyFrom(this.mainLight.direction.scale(-100));
    this.mainLight.intensity = shadows.sunIntensity;
    this.mainLight.diffuse = Color3.FromHexString(theme.mainColor);
    this.mainLight.specular.copyFrom(this.mainLight.diffuse);
    const image = s.imageProcessingConfiguration;
    image.exposure = theme.exposure; image.contrast = theme.contrast;
    image.toneMappingEnabled = true; image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    if (theme.bloomEnabled) {
      if (!this.pipeline) {
        // 现有冻结材质在材质阶段处理曝光与色调；泛光使用最终颜色，避免再次曝光和伽马转换。
        this.pipeline = new DefaultRenderingPipeline('sceneThemeBloom', false, s, []);
        this.pipeline.bloomEnabled = true;
        this.pipeline.bloomThreshold = 0.85;
        this.pipeline.bloomKernel = 32;
        this.pipeline.fxaaEnabled = true;
        this.cameraObserver = s.onBeforeRenderObservable.add(() => this.syncCamera());
      }
      this.pipeline.bloomWeight = theme.bloomWeight;
      this.syncCamera();
    } else this.disposePipeline();
  }

  private syncCamera(): void {
    if (!this.pipeline || this.pipelineCamera === this.scene.activeCamera) return;
    if (this.pipelineCamera) this.pipeline.removeCamera(this.pipelineCamera);
    this.pipelineCamera = this.scene.activeCamera;
    if (this.pipelineCamera) this.pipeline.addCamera(this.pipelineCamera);
  }
  private disposePipeline(): void {
    if (this.cameraObserver) this.scene.onBeforeRenderObservable.remove(this.cameraObserver);
    this.cameraObserver = null;
    if (this.pipeline) {
      this.pipeline.dispose();
      this.scene.imageProcessingConfiguration.applyByPostProcess = this.baseline?.applyByPostProcess ?? false;
    }
    this.pipeline = null; this.pipelineCamera = null;
  }
  private restore(): void {
    this.disposePipeline();
    this.mainLight?.dispose(); this.mainLight = null;
    const b = this.baseline; if (!b) return;
    const s = this.scene, i = s.imageProcessingConfiguration;
    s.clearColor.copyFrom(b.background); s.environmentIntensity = b.environmentIntensity;
    i.exposure = b.exposure; i.contrast = b.contrast; i.toneMappingEnabled = b.toneMappingEnabled; i.toneMappingType = b.toneMappingType;
    if (b.fill && !b.fill.light.isDisposed()) {
      const f = b.fill; f.light.renderPriority = f.priority; f.light.intensity = f.intensity; f.light.diffuse = f.diffuse; f.light.groundColor = f.ground; f.light.specular = f.specular;
    }
    this.baseline = null;
  }
  dispose(): void { this.restore(); }
}
