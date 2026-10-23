import { refreshSceneLightingMaterialDrawCaches } from './refreshDetachedInstanceSourceMaterials.ts';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Light, Scene } from '@babylonjs/core';
import type { SceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';

/** 只拥有统一配置创建的灯和补光；投影资源由 SceneShadowRuntime 独立管理。 */
export class SceneLightRigRuntime {
  mainLight: DirectionalLight | null = null;
  private fill: HemisphericLight | null = null;
  private ownsFill = false;
  private fillBaseline: { intensity: number; diffuse: Color3; ground: Color3; specular: Color3; priority: number; enabled: boolean } | null = null;
  private environmentBaseline: number | null = null;
  private signature = '';
  private disabledIds = new Set<string>();

  constructor(private readonly scene: Scene) {}

  sync(config: SceneLightingConfig): void {
    const disabledChanged = config.disabledLightIds.length !== this.disabledIds.size
      || config.disabledLightIds.some(id => !this.disabledIds.has(id));
    this.disabledIds = new Set(config.disabledLightIds);
    const signature = JSON.stringify([config.main, config.fill, config.environmentIntensity]);
    if (signature === this.signature) {
      if (disabledChanged) refreshSceneLightingMaterialDrawCaches(this.scene);
      return;
    }
    this.signature = signature;
    this.environmentBaseline ??= this.scene.environmentIntensity;
    this.scene.environmentIntensity = config.environmentIntensity;
    if (!this.fill || this.fill.isDisposed()) {
      const existing = this.scene.getLightByName('EditorLight');
      this.fill = existing instanceof HemisphericLight ? existing : new HemisphericLight('EditorLight', Vector3.Up(), this.scene);
      this.ownsFill = this.fill !== existing;
      this.fillBaseline = { intensity: this.fill.intensity, diffuse: this.fill.diffuse.clone(), ground: this.fill.groundColor.clone(),
        specular: this.fill.specular.clone(), priority: this.fill.renderPriority, enabled: this.fill.isEnabled() };
    }
    this.fill.intensity = config.fill.intensity;
    this.fill.diffuse = Color3.FromHexString(config.fill.color);
    this.fill.groundColor = Color3.FromHexString(config.fill.groundColor);
    this.fill.specular = Color3.Black(); this.fill.renderPriority = 90; this.fill.setEnabled(true);
    if (config.main.source !== 'managed' || !config.main.enabled) {
      this.mainLight?.dispose(); this.mainLight = null;
      refreshSceneLightingMaterialDrawCaches(this.scene); return;
    }
    this.mainLight ??= new DirectionalLight('__SceneLightingMain', Vector3.Down(), this.scene);
    const light = this.mainLight, azimuth = config.main.azimuthDegrees * Math.PI / 180, elevation = config.main.elevationDegrees * Math.PI / 180;
    light.metadata = { sceneLightingOwned: true };
    light.direction.set(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    light.position.copyFrom(light.direction.scale(-100));
    light.intensity = config.main.intensity; light.diffuse = Color3.FromHexString(config.main.color);
    light.specular.copyFrom(light.diffuse); light.renderPriority = 100; light.setEnabled(true);
    refreshSceneLightingMaterialDrawCaches(this.scene);
  }

  /** 迁移抑制清单只作用于运行时有效状态，保留实体自身显隐和灯光参数。 */
  syncEntityLight(entityId: string, light: Light, visible: boolean): void {
    const enabled = visible && !this.disabledIds.has(entityId), changed = light.isEnabled() !== enabled;
    light.setEnabled(enabled);
    if (changed) refreshSceneLightingMaterialDrawCaches(this.scene);
  }

  dispose(): void {
    const changed = Boolean(this.mainLight || this.fill || this.environmentBaseline !== null);
    this.mainLight?.dispose(); this.mainLight = null;
    if (this.fill && !this.fill.isDisposed()) {
      if (this.ownsFill) this.fill.dispose();
      else if (this.fillBaseline) {
        const baseline = this.fillBaseline;
        this.fill.intensity = baseline.intensity; this.fill.diffuse = baseline.diffuse; this.fill.groundColor = baseline.ground;
        this.fill.specular = baseline.specular; this.fill.renderPriority = baseline.priority; this.fill.setEnabled(baseline.enabled);
      }
    }
    if (this.environmentBaseline !== null) this.scene.environmentIntensity = this.environmentBaseline;
    this.fill = null; this.fillBaseline = null; this.environmentBaseline = null; this.signature = '';
    if (changed) refreshSceneLightingMaterialDrawCaches(this.scene);
  }
}
