import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { LIGHTING_UV_ATTRIBUTE } from './BakedLightingMaterialPlugin.ts';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh, Light, Nullable, Observer, Scene, TransformNode } from '@babylonjs/core';
import type { SceneShadowQuality, SceneShadowSettings } from '../../editor/model/SceneDocument';
import {
  HybridShadowCache, HybridShadowMeshState,
  type HybridShadowMeshRole, type HybridShadowOptions,
} from './HybridShadowCache.ts';
import type { LightingSamplerDiagnostic, LightingShadowLightCost, LightingShadowMetrics } from './lightingShadowCosts.ts';
import type { HybridShadowFallbackReason, HybridShadowInvalidationMode } from './hybridShadowInvalidation.ts';

export const SCENE_SHADOW_SUN_NAME = '__SceneShadowSun';
export const SCENE_SHADOW_CATCHER_NAME = '__SceneShadowCatcher';
export const EDITOR_FILL_LIGHT_NAME = 'EditorLight';
export const EDITOR_FILL_LIGHT_INTENSITY = 0.8;
export const EDITOR_FILL_LIGHT_SHADOW_INTENSITY = 0.2;

/** 与 SceneDocument.DEFAULT_SCENE_SHADOW_SETTINGS 保持同值，避免运行时单测加载场景文档模块。 */
const DEFAULT_SHADOW_SETTINGS: SceneShadowSettings = {
  enabled: true,
  mode: 'baked',
  quality: 'balanced',
  darkness: 0.32,
  catcherEnabled: true,
  sunAzimuthDegrees: 56,
  sunElevationDegrees: 63,
  sunIntensity: 1.05,
  distanceMeters: 0,
  bias: 0.002,
  normalBias: 0.03,
  fillIntensity: 0.2,
  iblIntensityMax: 0.45,
};
const CATCHER_MIN_SIZE_METERS = 60;
const CATCHER_MAX_SIZE_METERS = 600;
const CATCHER_PADDING_METERS = 12;
const CATCHER_Y_OFFSET_METERS = -0.03;
const SHADOW_QUALITY_CONFIG: Record<SceneShadowQuality, {
  mapSize: number;
  cascadeCount: number;
  filteringQuality: number;
  cached: boolean;
}> = {
  performance: {
    mapSize: 512,
    cascadeCount: 1,
    filteringQuality: ShadowGenerator.QUALITY_LOW,
    cached: true,
  },
  balanced: {
    mapSize: 1024,
    cascadeCount: 1,
    filteringQuality: ShadowGenerator.QUALITY_LOW,
    cached: true,
  },
  quality: {
    mapSize: 2048,
    cascadeCount: 3,
    filteringQuality: ShadowGenerator.QUALITY_HIGH,
    cached: false,
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
export function isShadowCaster(mesh: AbstractMesh): boolean {
  if (mesh.name === SCENE_SHADOW_CATCHER_NAME) return false;
  return isShadowSurface(mesh);
}

/** 环境底座 Mesh 由 SceneEnvironmentRuntime 标记，缓存档只让这些表面采样阴影。 */
function isEnvironmentShadowReceiver(mesh: AbstractMesh): boolean {
  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  if (metadata?.editorEnvironmentMesh === true || metadata?.editorShadowReceiver === true) return true;

  let parent = mesh.parent;
  while (parent) {
    const parentName = parent.name;
    if (parentName.startsWith('EnvironmentRoot_') || parentName.startsWith('EnvironmentContentRoot_')) return true;
    parent = parent.parent;
  }
  return false;
}

/**
 * 缓存档只让环境底座和专用地面接收阴影，避免全场 PBR 逐像素采样把 FPS 砍半。
 * 高质量实时档才让模型互相接收阴影。
 */
function isShadowReceiver(mesh: AbstractMesh, realtime: boolean): boolean {
  if (mesh.name === SCENE_SHADOW_CATCHER_NAME) return true;
  if (mesh.metadata?.editorChartMarker === true) return false;
  if (realtime) return isShadowSurface(mesh);
  return isEnvironmentShadowReceiver(mesh);
}

/** 收集 Mesh 自身及 MultiMaterial 子材质，供冻结材质短暂解冻后重编阴影采样。 */
function collectMeshMaterials(mesh: AbstractMesh): Material[] {
  const material = mesh.material;
  if (!material) return [];
  if (!(material instanceof MultiMaterial)) return [material];
  const materials: Material[] = [material];
  for (const subMaterial of material.subMaterials) {
    if (subMaterial) materials.push(subMaterial);
  }
  return materials;
}

/** 写入 receiveShadows；环境等冻结材质必须先解冻，否则不会重编阴影采样。 */
function applyReceiveShadows(mesh: AbstractMesh, enabled: boolean): void {
  // Babylon 实例只读继承 sourceMesh；规则冲突的可见实例由独立影子代理绘制。
  if (mesh instanceof InstancedMesh) return;
  if (mesh.receiveShadows === enabled) return;
  const frozenMaterials = collectMeshMaterials(mesh).filter((material) => material.isFrozen);
  for (const material of frozenMaterials) material.unfreeze();
  mesh.receiveShadows = enabled;
  for (const material of frozenMaterials) material.freeze();
}

/** 编辑器辅助网格和天空盒不应写入阴影贴图，否则会遮蔽整个数字孪生场景。 */
function isShadowSurface(mesh: AbstractMesh): boolean {
  if (mesh instanceof LinesMesh || mesh.name === 'EditorGroundGrid' || hasNonShadowAncestor(mesh)) return false;
  if (mesh.name === SCENE_SHADOW_CATCHER_NAME) return false;
  if (mesh.name === 'LegacySceneSkyboxSphere' || mesh.name.endsWith('_skyboxSphere')) return false;

  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  return metadata?.editorSkyboxSphere !== true
    && metadata?.runtimeSkybox !== true
    && metadata?.editorChartMarker !== true
    && metadata?.editorAutoPatrolMarker !== true
    && metadata?.editorShadowCatcher !== true;
}

function engineSupportsCascadedShadows(scene: Scene): boolean {
  const engine = scene.getEngine() as { _features?: { supportCSM?: boolean } };
  return engine._features?.supportCSM === true;
}

/** 集中管理数字孪生场景的缓存/级联阴影、接收地面和补光压制。 */
export class SceneShadowRuntime {
  private readonly scene: Scene;
  private readonly entityDirectionals = new Map<string, DirectionalLight>();
  private readonly localLights = new Map<string, PointLight | SpotLight>();
  private readonly localGenerators = new Map<string, ShadowGenerator>();
  private readonly secondaryDirectionalGenerators = new Map<DirectionalLight, ShadowGenerator>();
  private readonly hybridCaches = new Map<ShadowGenerator, HybridShadowCache>();
  private readonly hybridMeshState = new HybridShadowMeshState();
  private hybridMeshRoles = new Map<AbstractMesh, HybridShadowMeshRole>();
  private hybridOptions: Required<HybridShadowOptions> = { cacheStaticShadows: true, dynamicShadows: true };
  private cacheInvalidationMode: HybridShadowInvalidationMode = 'global';
  private readonly hybridMaterialLightLimits = new Map<PBRMaterial | StandardMaterial, number>();
  private hybridValidationErrors: string[] = [];
  private hybridValidationSignature = '';
  private hybridLightingSignature = '';
  private hybridMaterialsDirty = true;
  private readonly hybridMaterialObservers = new Map<AbstractMesh, Observer<AbstractMesh>>();
  private readonly retiredHybridMetrics = {
    staticRenders: 0, dynamicRenders: 0, cacheInvalidations: 0, cacheHits: 0,
    localInvalidations: 0, localCacheHits: 0, globalFallbacks: 0,
    globalFallbackReasons: {} as Partial<Record<HybridShadowFallbackReason, number>>,
  };
  private receiverLightBindings = new Map<Light, ShadowGenerator | null>();
  private readonly knownMeshes = new Set<AbstractMesh>();
  private renderSuppressedMeshes = new Set<AbstractMesh>();
  private readonly meshTransformObservers = new Map<AbstractMesh, Observer<TransformNode>>();
  private readonly meshSyncObserver: Nullable<Observer<Scene>>;
  private readonly catcher: Mesh;
  private managedLight: DirectionalLight | null = null;
  private primaryLight: DirectionalLight | null = null;
  private primaryGenerator: ShadowGenerator | null = null;
  private meshCollectionSignature = '';
  private settings: SceneShadowSettings = { ...DEFAULT_SHADOW_SETTINGS };
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.catcher = this.createCatcher();
    this.refreshPrimary();
    this.syncSceneMeshes(true);
    this.meshSyncObserver = scene.onBeforeRenderObservable.add(() => {
      if (!this.usesRealtimeShadows()) {
        this.updateHybridMaterialLights();
        return;
      }
      this.syncSceneMeshes();
      if (this.isHybrid()) this.syncSecondaryDirectionals();
      this.updateHybridMaterialLights();
      if (!this.isCachedProfile() || this.isHybrid()) this.updateShadowDistance();
    });
  }

  /** 独立运行期诊断开关，后续新建缓存继承；不写回场景配置。 */
  setCacheInvalidationMode(mode: HybridShadowInvalidationMode): void {
    if (this.disposed || this.cacheInvalidationMode === mode) return;
    this.cacheInvalidationMode = mode;
    for (const cache of this.hybridCaches.values()) cache.setInvalidationMode(mode);
  }

  /** 注入完整业务角色集合；未标注网格按动态处理，避免把未来运动姿态冻结。 */
  setHybridMeshRoles(
    roles: ReadonlyMap<AbstractMesh, HybridShadowMeshRole>,
    options: HybridShadowOptions = {},
  ): void {
    const nextOptions = { cacheStaticShadows: options.cacheStaticShadows ?? true, dynamicShadows: options.dynamicShadows ?? true };
    const changed = roles.size !== this.hybridMeshRoles.size || [...roles].some(([mesh, role]) => {
      const prior = this.hybridMeshRoles.get(mesh);
      return !prior || role.mobility !== prior.mobility || role.castShadows !== prior.castShadows
        || role.receiveShadows !== prior.receiveShadows;
    }) || nextOptions.cacheStaticShadows !== this.hybridOptions.cacheStaticShadows
      || nextOptions.dynamicShadows !== this.hybridOptions.dynamicShadows;
    if (!changed) {
      this.hybridMaterialsDirty = true;
      return;
    }
    this.hybridMeshRoles = new Map([...roles].map(([mesh, role]) => [mesh, { ...role }]));
    this.hybridOptions = nextOptions;
    for (const cache of this.hybridCaches.values()) cache.setEnabled(nextOptions.cacheStaticShadows);
    if (this.isHybrid() && this.settings.enabled) this.syncSceneMeshes(true);
  }

  /** 原件留在场景供业务脚本查询，但阴影仅绘制接管它的批次；不改原件受光标志。 */
  setRenderSuppressedMeshes(meshes: Iterable<AbstractMesh>): void {
    const next = new Set(meshes);
    if (next.size === this.renderSuppressedMeshes.size && [...next].every(mesh => this.renderSuppressedMeshes.has(mesh))) return;
    this.renderSuppressedMeshes = next;
    this.syncSceneMeshes(true);
    this.invalidateCachedShadow();
  }

  /** 只有本控制器拥有并维护 caster 列表的阴影目标可与渲染候选过滤共存。 */
  getManagedRenderTargets(): ReadonlySet<RenderTargetTexture> {
    const targets = new Set<RenderTargetTexture>();
    const generators = [...this.localGenerators.values(), ...this.secondaryDirectionalGenerators.values()];
    if (this.primaryGenerator) generators.push(this.primaryGenerator);
    for (const generator of generators) {
      const map = generator.getShadowMap(), rendered = generator.getShadowMapForRendering();
      if (map) targets.add(map);
      if (rendered) targets.add(rendered);
    }
    return targets;
  }

  /** 轻量读取已有验证结果；常驻错误轮询无需构建成本报表。 */
  getValidationErrors(): readonly string[] { return this.hybridValidationErrors; }

  /** 计数沿用现有监控；资源按实际面数估算，并区分阴影图和静态缓存。 */
  getHybridMetrics(): LightingShadowMetrics {
    const metrics: LightingShadowMetrics = {
      ...this.retiredHybridMetrics, staticCasterCount: 0, dynamicCasterCount: 0, textureBytes: 0,
      cachedFaces: 0, unsupportedCacheReason: null, validationErrors: [...this.hybridValidationErrors],
      shadowMapBytes: 0, cacheBytes: 0, lights: [], samplerDiagnostics: this.getSamplerDiagnostics(),
      invalidationMode: this.cacheInvalidationMode, globalFallbackReasons: { ...this.retiredHybridMetrics.globalFallbackReasons },
    };
    const generators = new Set([...this.localGenerators.values(), ...this.secondaryDirectionalGenerators.values()]);
    if (this.primaryGenerator) generators.add(this.primaryGenerator);
    for (const generator of generators) {
      const cache = this.hybridCaches.get(generator), cost = this.getLightCost(generator);
      metrics.lights.push(cost);
      metrics.shadowMapBytes += cost.shadowMapBytes; metrics.cacheBytes += cost.cacheBytes;
      if (!cache) continue;
      for (const key of ['staticRenders', 'dynamicRenders', 'cacheInvalidations', 'cacheHits', 'localInvalidations', 'localCacheHits', 'globalFallbacks'] as const) {
        metrics[key] = (metrics[key] ?? 0) + cache.metrics[key];
      }
      for (const reason of Object.keys(cache.metrics.globalFallbackReasons) as HybridShadowFallbackReason[]) {
        metrics.globalFallbackReasons![reason] = (metrics.globalFallbackReasons![reason] ?? 0) + cache.metrics.globalFallbackReasons[reason]!;
      }
      metrics.cachedFaces += cache.cachedFaces;
      metrics.unsupportedCacheReason ??= cache.metrics.unsupportedCacheReason;
    }
    metrics.textureBytes = metrics.shadowMapBytes + metrics.cacheBytes;
    metrics.lights.sort((a, b) => b.shadowMapBytes + b.cacheBytes - a.shadowMapBytes - a.cacheBytes);
    if (this.isHybrid() && this.settings.enabled) {
      metrics.staticCasterCount = this.hybridMeshState.staticMeshes.size;
      metrics.dynamicCasterCount = this.hybridOptions.dynamicShadows ? this.hybridMeshState.dynamicMeshes.size : 0;
    }
    return metrics;
  }

  private getLightCost(generator: ShadowGenerator): LightingShadowLightCost {
    const light = generator.getLight(), map = generator.getShadowMap(), cache = this.hybridCaches.get(generator);
    const cascades = generator instanceof CascadedShadowGenerator ? generator.numCascades : light instanceof DirectionalLight ? 1 : 0;
    const cubeFaces = light.needCube() ? 6 : 0, faces = cascades || cubeFaces || 1;
    let shadowMapBytes = 0;
    for (const target of new Set([map, generator.getShadowMapForRendering()])) {
      const texture = target?.getInternalTexture(); if (!target || !texture) continue;
      const components = texture.format === 6 ? 1 : 4;
      const componentBytes = texture.type === 1 ? 4 : texture.type === 2 ? 2 : 1;
      const size = target.getSize();
      shadowMapBytes += size.width * size.height * faces * (components * componentBytes + 4);
    }
    const entityId = [...this.localLights, ...this.entityDirectionals].find(([, value]) => value === light)?.[0];
    const size = map?.getSize();
    return {
      lightId: String(light.uniqueId), ...(entityId ? { entityId } : {}), name: light.name,
      type: light instanceof DirectionalLight ? 'directional' : light instanceof PointLight ? 'point' : 'spot',
      mapWidth: size?.width ?? 0, mapHeight: size?.height ?? 0, faces, cascades, cubeFaces,
      shadowMapBytes, cacheBytes: cache?.textureBytes ?? 0, cachedFaces: cache?.cachedFaces ?? 0,
      staticRenders: cache?.metrics.staticRenders ?? 0, dynamicRenders: cache?.metrics.dynamicRenders ?? 0, cacheHits: cache?.metrics.cacheHits ?? 0,
      invalidationMode: cache?.getInvalidationMode() ?? this.cacheInvalidationMode,
      localInvalidations: cache?.metrics.localInvalidations ?? 0, localCacheHits: cache?.metrics.localCacheHits ?? 0,
      globalFallbacks: cache?.metrics.globalFallbacks ?? 0, globalFallbackReasons: { ...cache?.metrics.globalFallbackReasons },
    };
  }

  private getRequiredSamplerCount(mesh: AbstractMesh, material: PBRMaterial | StandardMaterial, shadowSamplers: number): number {
    const textureSamplers = material.getActiveTextures().length
      + (material instanceof PBRMaterial && this.scene.environmentTexture && !material.reflectionTexture ? 1 : 0);
    const giSampler = material.pluginManager?.getPlugin('BakedIndirectLighting') && mesh.isVerticesDataPresent(LIGHTING_UV_ATTRIBUTE) ? 1 : 0;
    // 已完成编译的effect还包含原生BRDF和其他材质插件的采样器，避免只统计业务贴图而漏报。
    let compiledSamplers = 0;
    for (const subMesh of mesh.subMeshes ?? []) if (subMesh.getMaterial() === material && subMesh.effect?.isReady()) {
      compiledSamplers = Math.max(compiledSamplers, subMesh.effect.getSamplers().length);
    }
    return Math.max(shadowSamplers + textureSamplers + giSampler, compiledSamplers);
  }

  private getSamplerDiagnostics(): LightingSamplerDiagnostic[] {
    const limit = this.scene.getEngine().getCaps().maxTexturesImageUnits;
    if (limit <= 0 || this.disposed) return [];
    const diagnostics = new Map<Material, LightingSamplerDiagnostic>();
    for (const mesh of this.scene.meshes) {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0) continue;
      const shadowSamplers = mesh.receiveShadows ? mesh.lightSources.filter(light => light.isEnabled() && light.intensity > 0
        && (light.getShadowGenerator(this.scene.activeCamera) ?? light.getShadowGenerator())).length : 0;
      for (const material of collectMeshMaterials(mesh)) {
        if (!(material instanceof PBRMaterial || material instanceof StandardMaterial)) continue;
        const requiredSamplers = this.getRequiredSamplerCount(mesh, material, shadowSamplers);
        if (requiredSamplers < limit - 2) continue;
        const prior = diagnostics.get(material);
        const diag: LightingSamplerDiagnostic = prior ?? { materialId: String(material.uniqueId), materialName: material.name,
          requiredSamplers, limit, severity: requiredSamplers > limit ? 'over-limit' : 'near-limit', meshNames: [] };
        diag.requiredSamplers = Math.max(diag.requiredSamplers, requiredSamplers);
        diag.severity = diag.requiredSamplers > limit ? 'over-limit' : 'near-limit';
        if (!diag.meshNames.includes(mesh.name)) diag.meshNames.push(mesh.name);
        diagnostics.set(material, diag);
      }
    }
    return [...diagnostics.values()];
  }

  /** 主光由独立光照管理器持有；阴影开关只影响投影资源。 */
  setManagedLight(light: DirectionalLight | null): void {
    this.managedLight = light;
    this.refreshPrimary();
    this.syncSecondaryDirectionals();
    this.refreshReceiverLightDefines();
  }

  /** 主方向光沿用缓存/级联策略；点光和聚光灯在实时模式单独产生局部阴影。 */
  syncLight(entityId: string, light: Light): void {
    if (this.disposed) return;

    if (light instanceof DirectionalLight && light.isEnabled() && light.intensity > 0) {
      this.entityDirectionals.set(entityId, light);
    } else {
      this.entityDirectionals.delete(entityId);
    }

    if (light instanceof PointLight || light instanceof SpotLight) this.localLights.set(entityId, light);
    else this.localLights.delete(entityId);

    this.refreshPrimary();
    if (this.syncLocalGenerators()) this.syncSceneMeshes(true);
    this.syncSecondaryDirectionals();
    this.refreshReceiverLightDefines();
    this.invalidateCachedShadow();
  }

  /** 应用场景级阴影设置；只有质量档变化需要重建 GPU 阴影贴图。 */
  applySettings(settings: SceneShadowSettings): void {
    if (this.disposed) return;
    const qualityChanged = settings.quality !== this.settings.quality;
    const enabledChanged = settings.enabled !== this.settings.enabled;
    const modeChanged = settings.mode !== this.settings.mode;
    const nextSettings = { ...DEFAULT_SHADOW_SETTINGS, ...settings };
    const settingsUnchanged = (Object.keys(nextSettings) as (keyof SceneShadowSettings)[])
      .every(key => nextSettings[key] === this.settings[key]);
    this.settings = nextSettings;
    if (modeChanged) {
      this.disposePrimaryGenerator();
      this.disposeLocalGenerators();
      this.disposeSecondaryDirectionals();
      if (!this.isHybrid()) this.restoreHybridMaterialLights();
    }
    if (!this.usesRealtimeShadows()) {
      this.catcher.setEnabled(false);
      this.disposePrimaryGenerator();
      this.disposeLocalGenerators();
      this.disposeSecondaryDirectionals();
      if (this.isHybrid()) this.restoreHybridMaterialLights();
      this.refreshReceiverLightDefines();
      for (const [mesh, observer] of this.meshTransformObservers) mesh.onAfterWorldMatrixUpdateObservable.remove(observer);
      this.meshTransformObservers.clear();
      for (const mesh of this.knownMeshes) applyReceiveShadows(mesh, false);
      this.knownMeshes.clear();
      this.clearHybridMaterialObservers();
      this.hybridMaterialsDirty = true;
      this.meshCollectionSignature = '';
      this.updateHybridMaterialLights();
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

    if (qualityChanged) this.disposeLocalGenerators();
    if (qualityChanged) this.disposeSecondaryDirectionals();
    this.syncLocalGenerators();
    this.syncSecondaryDirectionals();
    this.applyGeneratorTuning();

    this.updateShadowDistance();
    // 设置未变且接收面未启用（无需按网格重算包围盒）时，网格集合变化由每帧的数量/末尾 uniqueId 检测登记，
    // 这里只标记缓存过期；否则强制同步网格（其末尾已执行 invalidateCachedShadow）。
    if (settingsUnchanged && !(this.settings.enabled && this.settings.catcherEnabled)) {
      this.syncSceneMeshes();
      this.invalidateCachedShadow();
    } else {
      this.syncSceneMeshes(true);
    }
    this.refreshReceiverLightDefines();
  }

  /** 方向光实体删除后选择剩余有效方向光，不创建替代光源。 */
  removeLight(entityId: string): void {
    if (this.disposed) return;
    this.entityDirectionals.delete(entityId);
    this.localLights.delete(entityId);
    const hadLocalGenerator = this.localGenerators.has(entityId);
    const localGenerator = this.localGenerators.get(entityId);
    if (localGenerator) this.disposeGenerator(localGenerator);
    this.localGenerators.delete(entityId);

    this.refreshPrimary();
    this.syncSecondaryDirectionals();
    if (hadLocalGenerator) this.syncSceneMeshes(true);
    this.refreshReceiverLightDefines();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.meshSyncObserver) {
      this.scene.onBeforeRenderObservable.remove(this.meshSyncObserver);
    }
    this.disposePrimaryGenerator();
    this.disposeLocalGenerators();
    this.disposeSecondaryDirectionals();
    this.restoreHybridMaterialLights();
    this.hybridMeshState.dispose();
    this.refreshReceiverLightDefines();
    this.catcher.material?.dispose();
    this.catcher.dispose();
    this.entityDirectionals.clear();
    this.localLights.clear();
    for (const [mesh, observer] of this.meshTransformObservers) {
      mesh.onAfterWorldMatrixUpdateObservable.remove(observer);
    }
    this.meshTransformObservers.clear();
    this.knownMeshes.clear();
    this.renderSuppressedMeshes.clear();
    this.clearHybridMaterialObservers();
  }

  /** 缓存档只在场景内容确实变化时重绘一帧阴影贴图。 */
  invalidateCachedShadow(): void {
    if (this.isHybrid()) {
      // 缓存在每次绑定阴影贴图前调用 refreshForFrame，因此这里只标记过期，避免每次失效都全量检查静态网格。
      this.hybridMeshState.markStale();
      return;
    }
    if (!this.isCachedProfile()) return;
    this.primaryGenerator?.getShadowMap()?.resetRefreshCounter();
    for (const generator of this.localGenerators.values()) generator.getShadowMap()?.resetRefreshCounter();
  }

  /**
   * Babylon 不会为 MeshBuilder/容器加载稳定触发新增 Mesh observable，因此在渲染前用
   * “数量 + 最后一个 uniqueId”做 O(1) 变更检测，仅在集合变化时扫描并增量注册。
   */
  private syncSceneMeshes(force = false): void {
    if (this.disposed) return;
    if (!this.usesRealtimeShadows()) return;
    const meshes = this.scene.meshes;
    const lastMeshId = meshes.length > 0 ? meshes[meshes.length - 1].uniqueId : 0;
    const signature = String(meshes.length) + ':' + lastMeshId;
    if (!force && signature === this.meshCollectionSignature) return;
    this.meshCollectionSignature = signature;

    const currentMeshes = new Set(meshes);
    for (const knownMesh of this.knownMeshes) {
      if (currentMeshes.has(knownMesh)) continue;
      this.primaryGenerator?.removeShadowCaster(knownMesh, false);
      for (const generator of this.localGenerators.values()) generator.removeShadowCaster(knownMesh, false);
      for (const generator of this.secondaryDirectionalGenerators.values()) generator.removeShadowCaster(knownMesh, false);
      const observer = this.meshTransformObservers.get(knownMesh);
      if (observer) knownMesh.onAfterWorldMatrixUpdateObservable.remove(observer);
      this.meshTransformObservers.delete(knownMesh);
      const materialObserver = this.hybridMaterialObservers.get(knownMesh);
      if (materialObserver) knownMesh.onMaterialChangedObservable.remove(materialObserver);
      this.hybridMaterialObservers.delete(knownMesh);
      this.knownMeshes.delete(knownMesh);
    }

    if (this.isHybrid()) {
      this.hybridMeshState.setMeshes(meshes.filter(mesh => !this.renderSuppressedMeshes.has(mesh) && isShadowCaster(mesh)), this.hybridMeshRoles);
    }
    for (const mesh of meshes) {
      this.knownMeshes.add(mesh);
      this.registerMesh(mesh);
    }

    this.updateCatcherBounds();
    this.invalidateCachedShadow();
    if (this.isHybrid()) { this.hybridMaterialsDirty = true; this.updateHybridMaterialLights(); }
  }

  /** 缓存主光只让环境/地面接收；存在局部投影时受光模型也必须采样局部阴影。 */
  private registerMesh(mesh: AbstractMesh): void {
    if (this.renderSuppressedMeshes.has(mesh)) {
      const generators = [...this.localGenerators.values(), ...this.secondaryDirectionalGenerators.values()];
      if (this.primaryGenerator) generators.push(this.primaryGenerator);
      for (const generator of generators) generator.removeShadowCaster(mesh, false);
      return;
    }
    if (this.isHybrid() && !this.hybridMaterialObservers.has(mesh)) {
      this.hybridMaterialObservers.set(mesh, mesh.onMaterialChangedObservable.add(() => { this.hybridMaterialsDirty = true; }));
    }
    const role = this.hybridMeshRoles.get(mesh);
    applyReceiveShadows(mesh, this.isHybrid()
      ? isShadowReceiver(mesh, true) && role?.receiveShadows !== false
      : isShadowReceiver(mesh, !this.isCachedProfile() || this.localGenerators.size > 0));
    if (!this.isCachedProfile() || this.isHybrid()) {
      const leftover = this.meshTransformObservers.get(mesh);
      if (leftover) {
        mesh.onAfterWorldMatrixUpdateObservable.remove(leftover);
        this.meshTransformObservers.delete(mesh);
      }
    } else if (
      !this.meshTransformObservers.has(mesh)
      && isShadowCaster(mesh)
      && (!isEnvironmentShadowReceiver(mesh) || this.localGenerators.size > 0)
    ) {
      const observer = mesh.onAfterWorldMatrixUpdateObservable.add(() => this.invalidateCachedShadow());
      this.meshTransformObservers.set(mesh, observer);
    }
    const generators = [...this.localGenerators.values(), ...this.secondaryDirectionalGenerators.values()];
    if (this.primaryGenerator) generators.push(this.primaryGenerator);
    for (const generator of generators) {
      const cast = isShadowCaster(mesh) && (!this.isHybrid()
        || (role?.castShadows !== false && (this.hybridOptions.dynamicShadows || this.hybridMeshState.isStatic(mesh))));
      if (cast) {
        const renderList = generator.getShadowMap()?.renderList;
        if (!renderList?.includes(mesh)) generator.addShadowCaster(mesh, false);
      } else {
        generator.removeShadowCaster(mesh, false);
      }
    }
  }

  /** 冻结材质会跳过灯光定义检查；只在灯光拓扑或生成器变更时重新开放一次编译。 */
  private refreshReceiverLightDefines(): void {
    const bindings = new Map<Light, ShadowGenerator | null>();
    if (!this.disposed && this.usesRealtimeShadows()) {
      if (this.primaryLight) bindings.set(this.primaryLight, this.primaryGenerator);
      for (const light of this.entityDirectionals.values()) {
        if (!light.isDisposed() && light.isEnabled() && light.intensity > 0) {
          bindings.set(light, light === this.primaryLight ? this.primaryGenerator : this.secondaryDirectionalGenerators.get(light) ?? null);
        }
      }
      for (const [id, light] of this.localLights) {
        if (!light.isDisposed() && light.isEnabled() && light.intensity > 0) {
          bindings.set(light, this.localGenerators.get(id) ?? null);
        }
      }
    }
    if (bindings.size === this.receiverLightBindings.size
      && [...bindings].every(([light, generator]) => this.receiverLightBindings.has(light)
        && this.receiverLightBindings.get(light) === generator)) return;
    this.receiverLightBindings = bindings;

    const materials = new Set<Material>();
    for (const mesh of this.scene.meshes) {
      if (!mesh.receiveShadows || mesh.isDisposed()) continue;
      for (const material of collectMeshMaterials(mesh)) materials.add(material);
    }
    for (const material of materials) {
      const wasFrozen = material.isFrozen;
      if (wasFrozen) material.unfreeze();
      material.markAsDirty(Material.LightDirtyFlag);
      if (wasFrozen) material.freeze();
    }
  }

  private syncLocalGenerators(): boolean {
    const enabled = this.usesRealtimeShadows();
    let changed = false;
    for (const [id, generator] of this.localGenerators) {
      const light = this.localLights.get(id);
      if (!enabled || !light || light.isDisposed() || !light.isEnabled() || light.intensity <= 0 || generator.getLight() !== light) {
        this.disposeGenerator(generator);
        this.localGenerators.delete(id);
        changed = true;
      }
    }
    if (!enabled) {

      return changed;
    }
    const quality = SHADOW_QUALITY_CONFIG[this.settings.quality];
    for (const [id, light] of this.localLights) {
      if (light.isDisposed() || !light.isEnabled() || light.intensity <= 0) continue;
      light.shadowMinZ = 0.05;
      light.shadowMaxZ = Math.max(0.1, Math.min(light.range, this.settings.distanceMeters > 0
        ? this.settings.distanceMeters : this.resolveShadowDistance()));
      if (this.localGenerators.has(id)) continue;
      const generator = new ShadowGenerator(quality.mapSize, light);
      generator.bias = this.resolveGeneratorBias(light);
      generator.normalBias = this.settings.normalBias;
      generator.darkness = this.settings.darkness;
      // 立方阴影不能使用二维 PCF 比较采样，使用 Babylon 支持的 Poisson 过滤。
      if (light instanceof PointLight) generator.usePoissonSampling = true;
      else {
        generator.usePercentageCloserFiltering = true;
        generator.filteringQuality = quality.filteringQuality;
      }
      this.configureShadowMapRefresh(generator);
      this.attachHybridCache(generator);
      this.localGenerators.set(id, generator);
      changed = true;
    }

    return changed;
  }


  private disposeLocalGenerators(): void {

    for (const generator of this.localGenerators.values()) this.disposeGenerator(generator);
    this.localGenerators.clear();
  }

  private refreshPrimary(): void {
    if (this.disposed) return;
    if (!this.usesRealtimeShadows()) return;
    const entityLight = this.managedLight && !this.managedLight.isDisposed() && this.managedLight.isEnabled() && this.managedLight.intensity > 0
      ? this.managedLight : this.firstEnabledDirectional();
    if (entityLight) {
      this.bindPrimaryLight(entityLight);
      return;
    }
    this.disposePrimaryGenerator();
  }

  private firstEnabledDirectional(): DirectionalLight | null {
    for (const light of this.entityDirectionals.values()) {
      if (!light.isDisposed() && light.isEnabled() && light.intensity > 0) return light;
    }
    return null;
  }

  private bindPrimaryLight(light: DirectionalLight): void {
    if (this.primaryLight === light && this.primaryGenerator?.getLight() === light) return;

    const formerSecondary = this.secondaryDirectionalGenerators.get(light);
    if (formerSecondary) {
      this.disposeGenerator(formerSecondary);
      this.secondaryDirectionalGenerators.delete(light);
    }
    this.disposePrimaryGenerator();
    this.primaryLight = light;
    this.primaryGenerator = this.createPrimaryGenerator(light);

    this.syncSceneMeshes(true);
  }

  /** WebGL 引擎优先使用级联阴影；性能缓存档和 NullEngine 回退到单张阴影贴图。 */
  private createPrimaryGenerator(light: DirectionalLight): ShadowGenerator {
    if (!this.isCachedProfile() && engineSupportsCascadedShadows(this.scene)) {
      return this.createCascadeGenerator(light);
    }
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
    // 屏幕深度归约的半精度上界会把最远平面接收面裁到级联之外。
    // 保留有界 shadowMaxZ 和稳定级联范围，避免俯视场景只剩模型自阴影。
    generator.autoCalcDepthBounds = false;
    generator.depthClamp = true;
    generator.bias = this.settings.bias;
    generator.normalBias = this.settings.normalBias;
    generator.darkness = this.settings.darkness;
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = quality.filteringQuality;
    generator.shadowMaxZ = this.resolveShadowDistance();
    this.configureShadowMapRefresh(generator);
    this.attachHybridCache(generator);
    return generator;
  }

  /** 在不支持 CSM 时仍使用方向光阴影，并限制 shadowMaxZ 以避免厂房尺度下贴图分辨率不足。 */
  private createBasicGenerator(light: DirectionalLight): ShadowGenerator {
    const quality = SHADOW_QUALITY_CONFIG[this.settings.quality];
    light.autoUpdateExtends = true;
    light.autoCalcShadowZBounds = true;
    const generator = new ShadowGenerator(quality.mapSize, light);
    generator.bias = this.settings.bias;
    generator.normalBias = this.settings.normalBias;
    generator.darkness = this.settings.darkness;
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = quality.filteringQuality;
    light.shadowMaxZ = this.resolveShadowDistance();
    this.configureShadowMapRefresh(generator);
    this.attachHybridCache(generator);
    return generator;
  }

  private configureShadowMapRefresh(generator: ShadowGenerator): void {
    const shadowMap = generator.getShadowMap();
    if (!shadowMap) return;
    shadowMap.refreshRate = this.isCachedProfile() && !this.isHybrid()
      ? RenderTargetTexture.REFRESHRATE_RENDER_ONCE
      : RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
  }

  private isCachedProfile(): boolean {
    return SHADOW_QUALITY_CONFIG[this.settings.quality].cached;
  }

  private isHybrid(): boolean { return this.settings.mode === 'hybrid'; }

  private usesRealtimeShadows(): boolean {
    return this.settings.enabled && (this.settings.mode === 'realtime' || this.isHybrid());
  }

  private attachHybridCache(generator: ShadowGenerator): void {
    if (!this.isHybrid() || this.hybridCaches.has(generator)) return;
    const cache = new HybridShadowCache(generator, this.hybridMeshState);
    cache.setInvalidationMode(this.cacheInvalidationMode);
    cache.setEnabled(this.hybridOptions.cacheStaticShadows);
    this.hybridCaches.set(generator, cache);
  }

  private disposeGenerator(generator: ShadowGenerator): void {
    const cache = this.hybridCaches.get(generator);
    if (cache) {
      for (const key of ['staticRenders', 'dynamicRenders', 'cacheInvalidations', 'cacheHits', 'localInvalidations', 'localCacheHits', 'globalFallbacks'] as const) {
        this.retiredHybridMetrics[key] += cache.metrics[key];
      }
      for (const reason of Object.keys(cache.metrics.globalFallbackReasons) as HybridShadowFallbackReason[]) {
        this.retiredHybridMetrics.globalFallbackReasons[reason] = (this.retiredHybridMetrics.globalFallbackReasons[reason] ?? 0)
          + cache.metrics.globalFallbackReasons[reason]!;
      }
      cache.dispose();
      this.hybridCaches.delete(generator);
    }
    generator.dispose();
  }

  /** hybrid 对全部方向灯生成阴影；旧模式继续保留单一主方向灯策略。 */
  private syncSecondaryDirectionals(): void {
    const desired = this.isHybrid() && this.settings.enabled
      ? new Set([...this.entityDirectionals.values()].filter(light => light !== this.primaryLight
        && !light.isDisposed() && light.isEnabled() && light.intensity > 0))
      : new Set<DirectionalLight>();
    let changed = false;
    for (const [light, generator] of this.secondaryDirectionalGenerators) {
      if (!desired.has(light)) {
        this.disposeGenerator(generator);
        this.secondaryDirectionalGenerators.delete(light);
        changed = true;
      }
    }
    for (const light of desired) {
      if (this.secondaryDirectionalGenerators.has(light)) continue;
      this.secondaryDirectionalGenerators.set(light, this.createBasicGenerator(light));
      changed = true;
    }
    if (changed) { this.syncSceneMeshes(true); this.refreshReceiverLightDefines(); }
  }

  private disposeSecondaryDirectionals(): void {
    for (const generator of this.secondaryDirectionalGenerators.values()) this.disposeGenerator(generator);
    this.secondaryDirectionalGenerators.clear();
  }

  private updateHybridMaterialLights(): void {
    const lights = this.scene.lights.filter(light => !light.isDisposed() && light.isEnabled() && light.intensity > 0);
    const hybrid = this.isHybrid();
    if (!hybrid && !lights.some(light => light.metadata?.glowStripLight === true)) {
      if (this.hybridMaterialLightLimits.size || this.hybridMaterialObservers.size) this.restoreHybridMaterialLights();
      return;
    }
    const signature = (hybrid ? 'hybrid:' : 'glow:') + lights.map(light => `${light.uniqueId}:${(light.getShadowGenerator(this.scene.activeCamera)
      ?? light.getShadowGenerator())?.getShadowMap()?.uniqueId ?? ''}:${light.metadata?.glowStripLight === true
        ? light.includedOnlyMeshes.map(mesh => mesh.uniqueId).join('.') : ''}`).join(',');
    if (!this.hybridMaterialsDirty && signature === this.hybridLightingSignature) return;
    this.hybridMaterialsDirty = false;
    this.hybridLightingSignature = signature;
    const count = hybrid ? lights.filter(light => light.metadata?.glowStripLight !== true).length : 0;
    const samplerLimit = this.scene.getEngine().getCaps().maxTexturesImageUnits;
    const errors = new Set<string>();
    const materialTargets = new Map<PBRMaterial | StandardMaterial, number>();
    for (const mesh of this.scene.meshes) {
      if (!this.hybridMaterialObservers.has(mesh)) {
        this.hybridMaterialObservers.set(mesh, mesh.onMaterialChangedObservable.add(() => { this.hybridMaterialsDirty = true; }));
      }
      // 共享材质按实际受光网格的最大灯位计算，避免灯带总数扩大整个场景的灯光上限。
      const effectiveLights = mesh instanceof InstancedMesh ? mesh.sourceMesh.lightSources : mesh.lightSources;
      let requiredLightSlots = 0;
      effectiveLights.forEach((light, index) => {
        if (light.isEnabled() && light.intensity > 0) requiredLightSlots = index + 1;
      });
      const hasGlowLight = effectiveLights.some(light => light.metadata?.glowStripLight === true && light.isEnabled() && light.intensity > 0);
      if (!hybrid && !hasGlowLight) continue;
      for (const material of collectMeshMaterials(mesh)) {
        if (!(material instanceof PBRMaterial || material instanceof StandardMaterial)) continue;
        if (hybrid) {
          const shadowSamplers = mesh.receiveShadows ? mesh.lightSources.filter(light => light.isEnabled() && light.intensity > 0
            && (light.getShadowGenerator(this.scene.activeCamera) ?? light.getShadowGenerator())).length : 0;
          const requiredSamplers = this.getRequiredSamplerCount(mesh, material, shadowSamplers);
          if (samplerLimit > 0 && requiredSamplers > samplerLimit) {
            errors.add(`混合阴影材质“${material.name}”至少需要 ${requiredSamplers} 个片元采样器，`
              + `当前显卡仅支持 ${samplerLimit} 个。无法保证全部灯光及贴图，请调整场景后重试。`);
          }
        }
        if (!this.hybridMaterialLightLimits.has(material)) this.hybridMaterialLightLimits.set(material, material.maxSimultaneousLights);
        const original = this.hybridMaterialLightLimits.get(material)!;
        let target: number;
        if (hybrid) target = Math.max(count, hasGlowLight ? requiredLightSlots : 0, original);
        else {
          // 计算原上限内的普通灯排位；零强度灯也占 Babylon shader 的灯位。
          let ordinarySlots = 0, retainedSlots = 0, hasReachableGlow = false;
          effectiveLights.forEach((light, index) => {
            if (light.metadata?.glowStripLight === true) {
              if (light.isEnabled() && light.intensity > 0 && index < original + 2) {
                hasReachableGlow = true;
                retainedSlots = index + 1;
              }
            } else if (ordinarySlots++ < original) retainedSlots = index + 1;
          });
          // 无可用灯带灯位时不扩容，避免只激活原本不可见的普通灯。
          target = hasReachableGlow ? Math.min(original + 2, Math.max(original, retainedSlots)) : original;
        }
        materialTargets.set(material, Math.max(materialTargets.get(material) ?? 0, target));
      }
    }
    // 普通模式不再受灯带影响的材质立即恢复原来的灯光上限。
    if (!hybrid) for (const [material, original] of this.hybridMaterialLightLimits) {
      if (materialTargets.has(material)) continue;
      if (material.maxSimultaneousLights !== original) {
        const frozen = material.isFrozen;
        if (frozen) material.unfreeze();
        material.maxSimultaneousLights = original;
        material.markAsDirty(Material.LightDirtyFlag);
        if (frozen) { material.freeze(); material.markDirty(true); }
      }
      this.hybridMaterialLightLimits.delete(material);
    }
    for (const [material, target] of materialTargets) {
      if (material.maxSimultaneousLights === target) continue;
      const frozen = material.isFrozen;
      if (frozen) material.unfreeze();
      material.maxSimultaneousLights = target;
      material.markAsDirty(Material.LightDirtyFlag);
      if (frozen) { material.freeze(); material.markDirty(true); }
    }
    this.hybridValidationErrors = [...errors];
    const errorSignature = this.hybridValidationErrors.join('\n');
    if (errorSignature && errorSignature !== this.hybridValidationSignature) console.error(errorSignature);
    this.hybridValidationSignature = errorSignature;
  }

  private restoreHybridMaterialLights(): void {
    for (const [material, count] of this.hybridMaterialLightLimits) {
      const frozen = material.isFrozen;
      if (frozen) material.unfreeze();
      material.maxSimultaneousLights = count;
      material.markAsDirty(Material.LightDirtyFlag);
      if (frozen) { material.freeze(); material.markDirty(true); }
    }
    this.hybridMaterialLightLimits.clear();
    this.hybridValidationErrors = [];
    this.hybridValidationSignature = '';
    this.hybridLightingSignature = '';
    this.hybridMaterialsDirty = true;
    this.clearHybridMaterialObservers();
  }

  private clearHybridMaterialObservers(): void {
    for (const [mesh, observer] of this.hybridMaterialObservers) mesh.onMaterialChangedObservable.remove(observer);
    this.hybridMaterialObservers.clear();
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
    mesh.setEnabled(false);
    return mesh;
  }

  private updateCatcherBounds(): void {
    // 接收面未启用时包围盒无人读取；启用只能经 applySettings 写入设置后强制同步网格，届时会重新计算。
    if (!this.settings.enabled || !this.settings.catcherEnabled) {
      this.catcher.setEnabled(false);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let found = false;

    for (const mesh of this.knownMeshes) {
      if (mesh === this.catcher || mesh.isDisposed() || !mesh.isEnabled()) continue;
      if (!isShadowCaster(mesh) && !isShadowReceiver(mesh, !this.isCachedProfile())) continue;
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

    // 没有物理模型时保留空场景；POI 显示内容不需要一块实心接收地面。
    this.catcher.setEnabled(found && this.settings.enabled && this.settings.catcherEnabled);
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

  private resolveShadowDistance(): number {
    if (this.settings.distanceMeters > 0) return this.settings.distanceMeters;

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

  private applyGeneratorTuning(): void {
    const generators = [...this.localGenerators.values(), ...this.secondaryDirectionalGenerators.values()];
    if (this.primaryGenerator) generators.push(this.primaryGenerator);
    for (const generator of generators) {
      generator.darkness = this.settings.darkness;
      generator.bias = this.resolveGeneratorBias(generator.getLight());
      generator.normalBias = this.settings.normalBias;
    }
  }

  /** 透视深度在远离 near plane 后高度非线性，直接沿用方向光偏移会吞掉近米级投影。 */
  private resolveGeneratorBias(light: Light): number {
    return this.isHybrid() && light instanceof SpotLight
      ? this.settings.bias * (light.shadowMinZ ?? 0.05)
      : this.settings.bias;
  }

  private updateShadowDistance(): void {
    const distance = this.resolveShadowDistance();
    if (this.primaryGenerator instanceof CascadedShadowGenerator) {
      this.primaryGenerator.shadowMaxZ = distance;
      return;
    }
    if (this.primaryLight) this.primaryLight.shadowMaxZ = distance;
  }

  private disposePrimaryGenerator(): void {

    if (!this.primaryGenerator) {
      this.primaryLight = null;
      return;
    }
    this.disposeGenerator(this.primaryGenerator);
    this.primaryGenerator = null;
    this.primaryLight = null;
  }

}
