import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { DrawWrapper } from '@babylonjs/core/Materials/drawWrapper.js';

/**
 * Babylon 9.12 的全场景材质/灯光标脏只遍历 scene.meshes，无法更新 AssetContainer 中的共享源。
 * 实例仍使用源网格的灯列表与绘制缓存，因此配置变化时需刷新实际被实例引用的离场源。
 */
export function refreshDetachedInstanceSourceMaterials(scene: Scene): number {
  return refreshDetachedSourceMeshes(scene, instanceSources(scene));
}

/** 冻结环境即使已注册，也会在 PBR 就绪检查中跳过 dirty；显式恢复检查并保留已编译资源。 */
export function refreshSceneLightingMaterialDrawCaches(scene: Scene): number {
  const sources: AbstractMesh[] = [...instanceSources(scene)];
  for (const mesh of scene.meshes) {
    if (mesh instanceof InstancedMesh || mesh.isDisposed()) continue;
    if (!mesh.material?.isFrozen && !mesh.subMeshes?.some(subMesh => subMesh.getMaterial()?.isFrozen)) continue;
    sources.push(mesh);
  }
  return refreshSources(scene, sources, true);
}

/** 空闲模板重新激活时，调用方提供当次容器的源；多个等待者只需成功提交者刷新一次。 */
export function refreshDetachedSourceMeshes(scene: Scene, sources: Iterable<AbstractMesh>): number {
  return refreshSources(scene, sources, false);
}

function refreshSources(scene: Scene, sources: Iterable<AbstractMesh>, includeRegistered: boolean): number {
  const registered = new Set(scene.meshes), refreshed = new Set<Mesh>();
  for (const mesh of sources) {
    const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
    if (!source || source.isDisposed() || source.getScene() !== scene || (!includeRegistered && registered.has(source)) || refreshed.has(source)) continue;
    refreshed.add(source);
    // 沿用 Babylon 的灯光筛选规则；不把隐藏模板注册回场景，也不修改材质或冻结状态。
    const disposedLights = source.lightSources.some(light => light.isDisposed());
    if (!registered.has(source)) source._resyncLightSources();
    for (const subMesh of source.subMeshes ?? []) {
      const wrappers = new Set<DrawWrapper>(subMesh._drawWrappers.filter(Boolean));
      if (subMesh._drawWrapperOverride) wrappers.add(subMesh._drawWrapperOverride);
      for (const wrapper of wrappers) {
        // 与 Material.markDirty(true) 一致，保留 previousEffect 以继续使用原生 shader hot-swap。
        wrapper._wasPreviouslyReady = false;
        wrapper._wasPreviouslyUsingInstances = null;
        wrapper._forceRebindOnNextCall = true;
        if (wrapper.defines && typeof wrapper.defines !== 'string') {
          wrapper.defines.markAllAsDirty();
          // 离场源收不到原生 removeLightSource 通知，禁止 hot-swap 继续使用已释放灯光的旧 shader。
          if (disposedLights) wrapper.defines.markAsLightDirty(true);
        }
      }
    }
  }
  if (refreshed.size) scene.resetCachedMaterial();
  return refreshed.size;
}

function* instanceSources(scene: Scene): Iterable<Mesh> {
  for (const mesh of scene.meshes) if (mesh instanceof InstancedMesh && !mesh.isDisposed()) yield mesh.sourceMesh;
}
