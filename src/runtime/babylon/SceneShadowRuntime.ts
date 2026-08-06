import {
  type AbstractMesh,
  DirectionalLight,
  type Light,
  LinesMesh,
  type Nullable,
  type Observer,
  PointLight,
  type Scene,
  ShadowGenerator,
} from '@babylonjs/core';

const SHADOW_MAP_SIZE = 1024;
const SHADOW_BIAS = 0.0005;
const SHADOW_NORMAL_BIAS = 0.02;
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

/** 编辑器辅助网格和天空盒不应写入阴影贴图，否则会遮蔽整个数字孪生场景。 */
function isShadowSurface(mesh: AbstractMesh): boolean {
  if (mesh instanceof LinesMesh || mesh.name === 'EditorGroundGrid' || hasNonShadowAncestor(mesh)) return false;
  if (mesh.name === 'LegacySceneSkyboxSphere' || mesh.name.endsWith('_skyboxSphere')) return false;

  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  return metadata?.editorSkyboxSphere !== true && metadata?.editorAutoPatrolMarker !== true;
}

/** Babylon 半球光不支持阴影；方向光和点光使用同一套动态 Mesh 注册策略。 */
function supportsShadows(light: Light): light is DirectionalLight | PointLight {
  return light instanceof DirectionalLight || light instanceof PointLight;
}

/** 集中管理场景灯光的阴影生成器和动态 Mesh 注册。 */
export class SceneShadowRuntime {
  private readonly scene: Scene;
  private readonly generators = new Map<string, ShadowGenerator>();
  private readonly knownMeshes = new Set<AbstractMesh>();
  private readonly meshSyncObserver: Nullable<Observer<Scene>>;
  private meshCollectionSignature = '';
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.meshSyncObserver = scene.onBeforeRenderObservable.add(() => {
      this.syncSceneMeshes();
    });
  }

  /** 为支持阴影的实体灯光创建生成器；类型切换时替换旧生成器。 */
  syncLight(entityId: string, light: Light): void {
    if (this.disposed) return;
    if (!supportsShadows(light)) {
      this.removeLight(entityId);
      return;
    }

    const current = this.generators.get(entityId);
    if (current?.getLight() === light) return;
    this.removeLight(entityId);

    if (light instanceof DirectionalLight) {
      light.autoUpdateExtends = true;
      light.autoCalcShadowZBounds = true;
    }

    const generator = new ShadowGenerator(SHADOW_MAP_SIZE, light);
    generator.bias = SHADOW_BIAS;
    generator.normalBias = SHADOW_NORMAL_BIAS;
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.generators.set(entityId, generator);

    this.syncSceneMeshes(true);
  }

  /** 释放灯光对应的 GPU 阴影贴图。 */
  removeLight(entityId: string): void {
    const generator = this.generators.get(entityId);
    if (!generator) return;
    generator.dispose();
    this.generators.delete(entityId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.meshSyncObserver) {
      this.scene.onBeforeRenderObservable.remove(this.meshSyncObserver);
    }
    for (const generator of this.generators.values()) {
      generator.dispose();
    }
    this.generators.clear();
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
      for (const generator of this.generators.values()) {
        generator.removeShadowCaster(knownMesh, false);
      }
      this.knownMeshes.delete(knownMesh);
    }

    for (const mesh of meshes) {
      this.knownMeshes.add(mesh);
      this.registerMesh(mesh);
    }
  }

  /** 新增和异步加载 Mesh 共用该入口，确保同时具备投射与接收阴影能力。 */
  private registerMesh(mesh: AbstractMesh): void {
    if (!isShadowSurface(mesh)) {
      mesh.receiveShadows = false;
      for (const generator of this.generators.values()) {
        generator.removeShadowCaster(mesh, false);
      }
      return;
    }

    mesh.receiveShadows = true;
    for (const generator of this.generators.values()) {
      const renderList = generator.getShadowMap()?.renderList;
      if (!renderList?.includes(mesh)) generator.addShadowCaster(mesh, false);
    }
  }
}
