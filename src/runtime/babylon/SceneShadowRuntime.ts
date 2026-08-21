import {
  type AbstractMesh,
  CascadedShadowGenerator,
  Color3,
  DirectionalLight,
  HemisphericLight,
  type Light,
  LinesMesh,
  Mesh,
  MeshBuilder,
  type Nullable,
  type Observer,
  type Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import type { SceneShadowQuality, SceneShadowSettings } from '../../editor/model/SceneDocument';

export const SCENE_SHADOW_SUN_NAME = '__SceneShadowSun';
export const SCENE_SHADOW_CATCHER_NAME = '__SceneShadowCatcher';
export const EDITOR_FILL_LIGHT_NAME = 'EditorLight';
export const EDITOR_FILL_LIGHT_INTENSITY = 0.8;
export const EDITOR_FILL_LIGHT_SHADOW_INTENSITY = 0.2;

const SHADOW_BIAS = 0.002;
const SHADOW_NORMAL_BIAS = 0.03;
const IBL_SHADOW_INTENSITY_MAX = 0.45;
const AUTO_SUN_INTENSITY = 1.05;
const CATCHER_MIN_SIZE_METERS = 60;
const CATCHER_MAX_SIZE_METERS = 600;
const CATCHER_PADDING_METERS = 12;
const CATCHER_Y_OFFSET_METERS = -0.03;
const AUTO_SUN_DIRECTION = new Vector3(-0.42, -1, -0.28).normalize();
const DEFAULT_SHADOW_SETTINGS: SceneShadowSettings = {
  enabled: true,
  quality: 'balanced',
  darkness: 0.32,
  catcherEnabled: true,
};
const SHADOW_QUALITY_CONFIG: Record<SceneShadowQuality, {
  mapSize: number;
  cascadeCount: number;
  filteringQuality: number;
}> = {
  performance: {
    mapSize: 1024,
    cascadeCount: 3,
    filteringQuality: ShadowGenerator.QUALITY_LOW,
  },
  balanced: {
    mapSize: 1024,
    cascadeCount: 4,
    filteringQuality: ShadowGenerator.QUALITY_MEDIUM,
  },
  quality: {
    mapSize: 2048,
    cascadeCount: 4,
    filteringQuality: ShadowGenerator.QUALITY_HIGH,
  },
};
const NON_SHADOW_PARENT_SUFFIXES = [
  '_locatorRoot',
  '_modelGeneratorMarkerRoot',
  '_lightMarkerRoot',
  '_poiEffectRoot',
];

/** 根据稳定运行时根节点识别只用于编辑提示、不应参与物理光照的辅助 Mesh。 */
function hasNonShadowAncestor(mesh: AbstractMesh): boolean {
  let parent = mesh.parent;
  while (parent) {
    const parentName = parent.name;
    if (NON_SHADOW_PARENT_SUFFIXES.some((suffix) => parentName.endsWith(suffix))) return true;
    parent = parent.parent;
  }
  return false;
}

/** 编辑器辅助网格、天空盒和阴影接收地面不应写入阴影贴图。 */
function isShadowCaster(mesh: AbstractMesh): boolean {
  if (mesh.name === SCENE_SHADOW_CATCHER_NAME) return false;
  return isShadowSurface(mesh);
}

/** 阴影接收地面只收光，不作为投射体。 */
function isShadowReceiver(mesh: AbstractMesh): boolean {
  if (mesh.name === SCENE_SHADOW_CATCHER_NAME) return true;
  return isShadowSurface(mesh);
}

/** 编辑器辅助网格和天空盒不应写入阴影贴图，否则会遮蔽整个数字孪生场景。 */
function isShadowSurface(mesh: AbstractMesh): boolean {
  if (mesh instanceof LinesMesh || mesh.name === 'EditorGroundGrid' || hasNonShadowAncestor(mesh)) return false;
  if (mesh.name === SCENE_SHADOW_CATCHER_NAME) return false;
  if (mesh.name === 'LegacySceneSkyboxSphere' || mesh.name.endsWith('_skyboxSphere')) return false;

  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  return metadata?.editorSkyboxSphere !== true
    && metadata?.editorAutoPatrolMarker !== true
    && metadata?.editorShadowCatcher !== true;
}

function engineSupportsCascadedShadows(scene: Scene): boolean {
  const engine = scene.getEngine() as { _features?: { supportCSM?: boolean } };
  return engine._features?.supportCSM === true;
}

/** 集中管理数字孪生场景的主方向光级联阴影、接收地面和补光压制。 */
export class SceneShadowRuntime {
  private readonly scene: Scene;
  private readonly entityDirectionals = new Map<string, DirectionalLight>();
  private readonly knownMeshes = new Set<AbstractMesh>();
  private readonly meshSyncObserver: Nullable<Observer<Scene>>;
  private readonly catcher: Mesh;
  private autoSun: DirectionalLight | null = null;
  private primaryLight: DirectionalLight | null = null;
  private primaryGenerator: ShadowGenerator | null = null;
  private meshCollectionSignature = '';
  private originalEditorLightIntensity: number | null = null;
  private originalEnvironmentIntensity: number | null = null;
  private settings: SceneShadowSettings = { ...DEFAULT_SHADOW_SETTINGS };
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.catcher = this.createCatcher();
    this.refreshPrimary();
    this.applyFillLightPolicy();
    this.syncSceneMeshes(true);
    this.meshSyncObserver = scene.onBeforeRenderObservable.add(() => {
      this.syncSceneMeshes();
      this.updateCascadeDistance();
      this.applyFillLightPolicy();
    });
  }

  /** 仅把可见方向光作为主阴影光；点光/半球光不建立方阴影，避免厂房尺度下阴影不可见。 */
  syncLight(entityId: string, light: Light): void {
    if (this.disposed) return;

    if (light instanceof DirectionalLight && light.isEnabled() && light.intensity > 0) {
      this.entityDirectionals.set(entityId, light);
    } else {
      this.entityDirectionals.delete(entityId);
      const leftover = light.getShadowGenerator();
      if (leftover && leftover !== this.primaryGenerator) leftover.dispose();
    }

    this.refreshPrimary();
  }

  /** 应用场景级阴影设置；只有质量档变化需要重建 GPU 阴影贴图。 */
  applySettings(settings: SceneShadowSettings): void {
    if (this.disposed) return;
    const qualityChanged = settings.quality !== this.settings.quality;
    const enabledChanged = settings.enabled !== this.settings.enabled;
    this.settings = { ...settings };
    this.catcher.setEnabled(settings.enabled && settings.catcherEnabled);

    if (!settings.enabled) {
      this.disposePrimaryGenerator();
      this.disposeAutoSun();
      this.restoreFillLightPolicy();
      return;
    }

    if (enabledChanged) {
      this.refreshPrimary();
    } else if (qualityChanged && this.primaryLight) {
      const light = this.primaryLight;
      this.disposePrimaryGenerator();
      this.bindPrimaryLight(light);
    } else if (!this.primaryGenerator) {
      this.refreshPrimary();
    }

    if (this.primaryGenerator) this.primaryGenerator.darkness = settings.darkness;
    this.syncSceneMeshes(true);
    this.applyFillLightPolicy();
  }

  /** 方向光实体删除后回退到自动太阳光，保持场景始终有一盏主阴影光。 */
  removeLight(entityId: string): void {
    if (this.disposed) return;
    this.entityDirectionals.delete(entityId);
    this.refreshPrimary();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.meshSyncObserver) {
      this.scene.onBeforeRenderObservable.remove(this.meshSyncObserver);
    }
    this.disposePrimaryGenerator();
    this.disposeAutoSun();
    this.restoreFillLightPolicy();
    this.catcher.material?.dispose();
    this.catcher.dispose();
    this.entityDirectionals.clear();
    this.knownMeshes.clear();
  }

  /**
   * Babylon 不会为 MeshBuilder/容器加载稳定触发新增 Mesh observable，因此在渲染前用
   * “数量 + 最后一个 uniqueId”做 O(1) 变更检测，仅在集合变化时扫描并增量注册。
   */
  private syncSceneMeshes(force = false): void {
    if (this.disposed) return;
    const meshes = this.scene.meshes;
    const lastMeshId = meshes.length > 0 ? meshes[meshes.length - 1].uniqueId : 0;
    const signature = String(meshes.length) + ':' + lastMeshId;
    if (!force && signature === this.meshCollectionSignature) return;
    this.meshCollectionSignature = signature;

    const currentMeshes = new Set(meshes);
    for (const knownMesh of this.knownMeshes) {
      if (currentMeshes.has(knownMesh)) continue;
      this.primaryGenerator?.removeShadowCaster(knownMesh, false);
      this.knownMeshes.delete(knownMesh);
    }

    for (const mesh of meshes) {
      this.knownMeshes.add(mesh);
      this.registerMesh(mesh);
    }

    this.updateCatcherBounds();
    this.updateAutoSunPose();
  }

  /** 新增和异步加载 Mesh 共用该入口；接收地面只收阴影，不投射。 */
  private registerMesh(mesh: AbstractMesh): void {
    mesh.receiveShadows = isShadowReceiver(mesh);
    if (!this.primaryGenerator) return;

    if (isShadowCaster(mesh)) {
      const renderList = this.primaryGenerator.getShadowMap()?.renderList;
      if (!renderList?.includes(mesh)) this.primaryGenerator.addShadowCaster(mesh, false);
      return;
    }

    this.primaryGenerator.removeShadowCaster(mesh, false);
  }

  private refreshPrimary(): void {
    if (this.disposed) return;
    if (!this.settings.enabled) return;
    const entityLight = this.firstEnabledDirectional();
    if (entityLight) {
      if (this.autoSun && this.autoSun !== entityLight) this.disposeAutoSun();
      this.bindPrimaryLight(entityLight);
      this.applyFillLightPolicy();
      return;
    }

    this.bindPrimaryLight(this.ensureAutoSun());
    this.applyFillLightPolicy();
  }

  private firstEnabledDirectional(): DirectionalLight | null {
    for (const light of this.entityDirectionals.values()) {
      if (!light.isDisposed() && light.isEnabled() && light.intensity > 0) return light;
    }
    return null;
  }

  private bindPrimaryLight(light: DirectionalLight): void {
    if (this.primaryLight === light && this.primaryGenerator?.getLight() === light) return;

    this.disposePrimaryGenerator();
    this.primaryLight = light;
    this.primaryGenerator = this.createPrimaryGenerator(light);
    this.syncSceneMeshes(true);
  }

  /** WebGL 引擎优先使用级联阴影；NullEngine 等不支持 CSM 的环境回退到单张阴影贴图。 */
  private createPrimaryGenerator(light: DirectionalLight): ShadowGenerator {
    if (engineSupportsCascadedShadows(this.scene)) return this.createCascadeGenerator(light);
    return this.createBasicGenerator(light);
  }

  private createCascadeGenerator(light: DirectionalLight): CascadedShadowGenerator {
    const quality = SHADOW_QUALITY_CONFIG[this.settings.quality];
    const generator = new CascadedShadowGenerator(
      quality.mapSize,
      light,
      true,
      this.scene.activeCamera,
    );
    generator.numCascades = quality.cascadeCount;
    generator.lambda = 0.72;
    generator.cascadeBlendPercentage = 0.12;
    generator.stabilizeCascades = true;
    generator.autoCalcDepthBounds = true;
    generator.depthClamp = true;
    generator.bias = SHADOW_BIAS;
    generator.normalBias = SHADOW_NORMAL_BIAS;
    generator.darkness = this.settings.darkness;
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = quality.filteringQuality;
    generator.shadowMaxZ = this.resolveShadowDistance();
    return generator;
  }

  /** 在不支持 CSM 时仍使用方向光阴影，并限制 shadowMaxZ 以避免厂房尺度下贴图分辨率不足。 */
  private createBasicGenerator(light: DirectionalLight): ShadowGenerator {
    const quality = SHADOW_QUALITY_CONFIG[this.settings.quality];
    light.autoUpdateExtends = true;
    light.autoCalcShadowZBounds = true;
    const generator = new ShadowGenerator(quality.mapSize, light);
    generator.bias = SHADOW_BIAS;
    generator.normalBias = SHADOW_NORMAL_BIAS;
    generator.darkness = this.settings.darkness;
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = quality.filteringQuality;
    light.shadowMaxZ = this.resolveShadowDistance();
    return generator;
  }

  private ensureAutoSun(): DirectionalLight {
    if (this.autoSun && !this.autoSun.isDisposed()) return this.autoSun;

    const light = new DirectionalLight(SCENE_SHADOW_SUN_NAME, AUTO_SUN_DIRECTION.clone(), this.scene);
    light.intensity = AUTO_SUN_INTENSITY;
    light.diffuse = Color3.FromHexString('#fff4e5');
    light.specular = Color3.FromHexString('#efe4d2');
    this.autoSun = light;
    this.updateAutoSunPose();
    return light;
  }

  private createCatcher(): Mesh {
    const mesh = MeshBuilder.CreateGround(
      SCENE_SHADOW_CATCHER_NAME,
      { width: 1, height: 1, subdivisions: 1 },
      this.scene,
    );
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = true;
    mesh.metadata = { editorShadowCatcher: true };

    const material = new StandardMaterial(`${SCENE_SHADOW_CATCHER_NAME}Material`, this.scene);
    material.diffuseColor = new Color3(0.08, 0.08, 0.09);
    material.specularColor = Color3.Black();
    material.emissiveColor = Color3.Black();
    material.ambientColor = Color3.Black();
    mesh.material = material;
    mesh.position.y = CATCHER_Y_OFFSET_METERS;
    mesh.scaling.set(CATCHER_MIN_SIZE_METERS, 1, CATCHER_MIN_SIZE_METERS);
    mesh.setEnabled(this.settings.enabled && this.settings.catcherEnabled);
    return mesh;
  }

  private updateCatcherBounds(): void {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let found = false;

    for (const mesh of this.knownMeshes) {
      if (mesh === this.catcher || mesh.isDisposed() || !mesh.isEnabled()) continue;
      if (!isShadowCaster(mesh) && !isShadowReceiver(mesh)) continue;
      mesh.computeWorldMatrix(true);
      const boundingBox = mesh.getBoundingInfo().boundingBox;
      const minimum = boundingBox.minimumWorld;
      const maximum = boundingBox.maximumWorld;
      minX = Math.min(minX, minimum.x);
      minY = Math.min(minY, minimum.y);
      minZ = Math.min(minZ, minimum.z);
      maxX = Math.max(maxX, maximum.x);
      maxZ = Math.max(maxZ, maximum.z);
      found = true;
    }

    if (!found) {
      this.catcher.position.set(0, CATCHER_Y_OFFSET_METERS, 0);
      this.catcher.scaling.set(CATCHER_MIN_SIZE_METERS, 1, CATCHER_MIN_SIZE_METERS);
      return;
    }

    const size = Math.min(
      CATCHER_MAX_SIZE_METERS,
      Math.max(CATCHER_MIN_SIZE_METERS, Math.max(maxX - minX, maxZ - minZ) + CATCHER_PADDING_METERS * 2),
    );
    this.catcher.position.set((minX + maxX) / 2, minY + CATCHER_Y_OFFSET_METERS, (minZ + maxZ) / 2);
    this.catcher.scaling.set(size, 1, size);
  }

  private updateAutoSunPose(): void {
    if (!this.autoSun || this.autoSun.isDisposed()) return;
    const center = this.catcher.position;
    const radius = Math.max(this.catcher.scaling.x, this.catcher.scaling.z, CATCHER_MIN_SIZE_METERS) * 0.6;
    this.autoSun.direction.copyFrom(AUTO_SUN_DIRECTION);
    this.autoSun.position.set(
      center.x - AUTO_SUN_DIRECTION.x * radius,
      Math.max(center.y - AUTO_SUN_DIRECTION.y * radius, 20),
      center.z - AUTO_SUN_DIRECTION.z * radius,
    );
  }

  private resolveShadowDistance(): number {
    const camera = this.scene.activeCamera;
    let distance = 140;
    const radius = camera ? (camera as { radius?: number }).radius : undefined;
    if (typeof radius === 'number' && Number.isFinite(radius) && radius > 0) {
      distance = radius * 3.2;
    } else if (camera) {
      distance = Math.max(camera.globalPosition.length() * 2, 60);
    }
    return Math.min(400, Math.max(50, distance));
  }

  private updateCascadeDistance(): void {
    const distance = this.resolveShadowDistance();
    if (this.primaryGenerator instanceof CascadedShadowGenerator) {
      this.primaryGenerator.shadowMaxZ = distance;
      return;
    }
    if (this.primaryLight) this.primaryLight.shadowMaxZ = distance;
  }

  /** 压低不投影的半球补光和过强 IBL，让方向光阴影有足够对比。 */
  private applyFillLightPolicy(): void {
    if (this.disposed) return;
    if (!this.settings.enabled) {
      this.restoreFillLightPolicy();
      return;
    }
    const editorLight = this.scene.getLightByName(EDITOR_FILL_LIGHT_NAME);
    if (editorLight instanceof HemisphericLight) {
      if (this.originalEditorLightIntensity == null) {
        this.originalEditorLightIntensity = editorLight.intensity;
      }
      editorLight.intensity = EDITOR_FILL_LIGHT_SHADOW_INTENSITY;
    }

    if (this.scene.environmentTexture && this.scene.environmentIntensity > IBL_SHADOW_INTENSITY_MAX) {
      this.originalEnvironmentIntensity = this.scene.environmentIntensity;
      this.scene.environmentIntensity = IBL_SHADOW_INTENSITY_MAX;
    } else if (this.scene.environmentIntensity !== IBL_SHADOW_INTENSITY_MAX) {
      this.originalEnvironmentIntensity = null;
    }
  }

  private restoreFillLightPolicy(): void {
    this.restoreEditorLightIntensity();
    if (this.originalEnvironmentIntensity != null) {
      this.scene.environmentIntensity = this.originalEnvironmentIntensity;
    }
    this.originalEnvironmentIntensity = null;
  }

  private restoreEditorLightIntensity(): void {
    const editorLight = this.scene.getLightByName(EDITOR_FILL_LIGHT_NAME);
    if (editorLight instanceof HemisphericLight && this.originalEditorLightIntensity != null) {
      editorLight.intensity = this.originalEditorLightIntensity;
    }
    this.originalEditorLightIntensity = null;
  }

  private disposePrimaryGenerator(): void {
    if (!this.primaryGenerator) {
      this.primaryLight = null;
      return;
    }
    this.primaryGenerator.dispose();
    this.primaryGenerator = null;
    this.primaryLight = null;
  }

  private disposeAutoSun(): void {
    if (!this.autoSun) return;
    if (this.primaryLight === this.autoSun) this.disposePrimaryGenerator();
    if (!this.autoSun.isDisposed()) this.autoSun.dispose();
    this.autoSun = null;
  }
}
