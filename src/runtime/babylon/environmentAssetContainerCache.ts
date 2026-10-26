import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene, Node } from '@babylonjs/core';
import { beginSceneAssetTrace, type SceneAssetTrace } from './SceneLoadDiagnostics.ts';
import type { AssetCloneTiming } from './SharedModelAssetCache.ts';
import type { ProjectOpenSpanRef } from '../../../electron/shared/projectOpenTrace.ts';

export type AcquireEnvironmentWorkingContainerOptions = {
  cacheKey: string;
  scene: Scene;
  loadSource: () => Promise<AssetContainer>;
  onClone?: (durationMs: number, failed: boolean, timing?: AssetCloneTiming) => void;
  trace?: SceneAssetTrace;
};

type CachedEnvironmentSource = {
  promise: Promise<AssetContainer>;
  container: AssetContainer | null;
  disposed: boolean;
  sourceRef: ProjectOpenSpanRef | null;
};

/**
 * 会话级环境源容器缓存。
 * 源 GLB 只解析一次，每次应用场景时克隆工作副本；释放工作副本不会丢掉源几何和贴图。
 */
export class EnvironmentAssetContainerCache {
  private readonly entries = new Map<string, CachedEnvironmentSource>();
  private disposed = false;
  private hits = 0;
  private misses = 0;
  private cloneCount = 0;
  private cloneMs = 0;

  getMetrics() {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size,
      cloneCount: this.cloneCount, cloneMs: this.cloneMs };
  }

  /**
   * 取得可加入场景的环境工作容器。
   * 同源并发请求共享一次解析；工作副本的材质是克隆，幽灵显示不会污染源。
   */
  async acquireWorkingContainer(
    options: AcquireEnvironmentWorkingContainerOptions,
  ): Promise<AssetContainer> {
    if (this.disposed) throw new Error('环境资源缓存已释放，无法加载环境模型。');
    const entry = this.acquireSource(options);
    const waitToken = beginSceneAssetTrace(options.trace, 'templateWait', entry.sourceRef ? { links: [entry.sourceRef] } : undefined);
    let source: AssetContainer;
    try { source = await entry.promise; waitToken?.end(); }
    catch (error) { waitToken?.end('error', 'operation-failed'); throw error; }
    const cloneToken = beginSceneAssetTrace(options.trace, 'environmentClone');
    const startedAt = performance.now();
    let failed = true;
    try {
      const working = createWorkingContainer(options.scene, source);
      this.cloneCount += 1;
      this.cloneMs += performance.now() - startedAt;
      failed = false;
      return working;
    } finally {
      const endedAtMs = performance.now();
      cloneToken?.end(failed ? 'error' : 'ok', failed ? 'operation-failed' : undefined);
      try { options.onClone?.(endedAtMs - startedAt, failed, { startedAtMs: startedAt, endedAtMs }); }
      catch (error) { console.warn('[Scene load] 环境克隆计时观察器失败。', error); }
    }
  }

  /** 释放全部源容器。工作副本仍由 SceneEnvironmentRuntime 各自 dispose。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.disposed = true;
      entry.container?.dispose();
    }
    this.entries.clear();
  }

  private acquireSource(
    options: AcquireEnvironmentWorkingContainerOptions,
  ): CachedEnvironmentSource {
    const cached = this.entries.get(options.cacheKey);
    if (cached) {
      this.hits += 1;
      return cached;
    }

    this.misses += 1;
    const sourceToken = beginSceneAssetTrace(options.trace, 'modelAcquire');
    const entry: CachedEnvironmentSource = {
      promise: Promise.resolve().then(async () => {
        try {
          const container = await options.loadSource();
          if (this.disposed || entry.disposed || this.entries.get(options.cacheKey) !== entry) {
            container.dispose();
            throw new Error('环境源容器在解析完成前已失效。');
          }
          entry.container = container;
          sourceToken?.end();
          return container;
        } catch (error) {
          sourceToken?.end('error', 'operation-failed');
          if (this.entries.get(options.cacheKey) === entry) this.entries.delete(options.cacheKey);
          throw error;
        }
      }),
      container: null,
      disposed: false,
      sourceRef: sourceToken?.ref ?? null,
    };
    this.entries.set(options.cacheKey, entry);
    return entry;
  }
}

/** 从源容器克隆一套独立节点和材质，并移出场景，交给现有 addToScene 事务。 */
function createWorkingContainer(scene: Scene, source: AssetContainer): AssetContainer {
  const sourceMeshes = [...source.meshes], removeCloneObservers: Array<() => void> = [];
  try {
    for (const mesh of new Set(sourceMeshes)) {
      if (!(mesh instanceof Mesh) || hasVertexDeformation(mesh)) continue;
      const observer = mesh.onClonedObservable.add(clone => {
        if (!(clone instanceof Mesh) || clone === mesh || hasVertexDeformation(clone)) return;
        // Babylon clone 已计算好包围盒，但会为完整 POSITION 再保留 Vector3[]。
        // 静态环境按每个 clone 立即释放这份可重建缓存，避免共享 VB 被大量 primitive 展开占满主堆。
        if (clone._internalAbstractMeshDataInfo !== mesh._internalAbstractMeshDataInfo) {
          clone._internalAbstractMeshDataInfo._positions = null;
        }
      });
      removeCloneObservers.push(() => { mesh.onClonedObservable.remove(observer); });
    }
    try {
      const instantiated = source.instantiateModelsToScene(
        (sourceName) => sourceName,
        true,
        { doNotInstantiate: true },
      );
      const working = harvestInstantiatedEntries(scene, instantiated);
      const sourceMeshSet = new Set(sourceMeshes);
      const harvestedSourceMeshes = working.meshes.some((mesh) => sourceMeshSet.has(mesh));
      if (working.meshes.length > 0 && !harvestedSourceMeshes) {
        working.removeAllFromScene();
        return working;
      }
      if (!harvestedSourceMeshes) instantiated.dispose();
    } catch {
      // NullEngine 或手搓测试容器可能无法实例化，回退到逐网格克隆。
    }
    return cloneSourceMeshes(scene, sourceMeshes);
  } finally {
    for (const remove of removeCloneObservers) remove();
  }
}

/** 骨骼、形变及顶点烘焙动画仍保留 Babylon 原本的位置缓存行为。 */
function hasVertexDeformation(mesh: Mesh): boolean {
  return Boolean(mesh.skeleton || mesh.morphTargetManager || mesh.bakedVertexAnimationManager);
}

/** 把 instantiateModelsToScene 产生的克隆节点收进独立 AssetContainer。 */
function harvestInstantiatedEntries(scene: Scene, instantiated: {
  rootNodes: Node[];
  skeletons: AssetContainer['skeletons'];
  animationGroups: AssetContainer['animationGroups'];
}): AssetContainer {
  const working = new AssetContainer(scene);
  const visited = new Set<Node>();

  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node instanceof AbstractMesh) working.meshes.push(node);
    else if (node instanceof TransformNode) working.transformNodes.push(node);
    else if (node instanceof Camera) working.cameras.push(node);
    else if (node instanceof Light) working.lights.push(node);
    for (const child of node.getChildren()) visit(child);
  };

  for (const root of instantiated.rootNodes) {
    working.rootNodes.push(root);
    visit(root);
  }

  const materials = new Set<Material>();
  for (const mesh of working.meshes) {
    if (mesh.material) collectMaterials(mesh.material, materials);
    if (mesh.skeleton && !working.skeletons.includes(mesh.skeleton)) {
      working.skeletons.push(mesh.skeleton);
    }
  }
  for (const skeleton of instantiated.skeletons) {
    if (!working.skeletons.includes(skeleton)) working.skeletons.push(skeleton);
  }
  working.materials.push(...materials);
  working.animationGroups.push(...instantiated.animationGroups);
  return working;
}

/** NullEngine 测试容器可能无法走 instantiateModelsToScene，回退到逐网格克隆。 */
function cloneSourceMeshes(scene: Scene, sourceMeshes: readonly AbstractMesh[]): AssetContainer {
  const working = new AssetContainer(scene);
  for (const mesh of sourceMeshes) {
    const cloned = mesh.clone(mesh.name, null, false);
    if (!cloned) continue;
    if (mesh.material) {
      const clonedMaterial = mesh.material.clone(`${mesh.material.name}-clone`);
      if (clonedMaterial) cloned.material = clonedMaterial;
    }
    if (cloned.getScene() === scene) scene.removeMesh(cloned, true);
    if (cloned.material && cloned.material.getScene() === scene) {
      scene.removeMaterial(cloned.material);
    }
    working.meshes.push(cloned);
    working.rootNodes.push(cloned);
    if (cloned.material) working.materials.push(cloned.material);
  }
  if (working.meshes.length === 0) {
    throw new Error('环境源容器克隆失败：没有可渲染网格。');
  }
  return working;
}

/** 收集网格材质及其子材质，供工作副本独立幽灵显示。 */
function collectMaterials(material: Material, materials: Set<Material>): void {
  materials.add(material);
  const subMaterials = (material as Material & { subMaterials?: Array<Material | null> }).subMaterials;
  if (!Array.isArray(subMaterials)) return;
  for (const subMaterial of subMaterials) {
    if (subMaterial) materials.add(subMaterial);
  }
}
