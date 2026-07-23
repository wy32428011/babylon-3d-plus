import type { AbstractMesh, InstancedMesh, Mesh } from '@babylonjs/core';

/** Babylon 公开实例缓冲容器在注册/清理选择描边期间可能暂时为空。 */
function ensureInstancedBufferContainer(mesh: AbstractMesh): void {
  if (!mesh.instancedBuffers) {
    mesh.instancedBuffers = {};
  }
}

/** 读取真实 InstancedMesh 的共享源；使用 isAnInstance 避免依赖跨模块 instanceof。 */
function resolveInstanceSourceMesh(mesh: AbstractMesh): Mesh | null {
  if (!mesh.isAnInstance) return null;
  return (mesh as InstancedMesh).sourceMesh ?? null;
}

/**
 * 修复脚本或异步加载刚创建的实例缓冲容器。
 * 仅当 sourceMesh 已注册实例缓冲时处理，避免给从未参与矩阵缓冲的普通实例增加状态。
 */
export function repairInstancedMeshBufferContainers(meshes: readonly AbstractMesh[]): void {
  for (const mesh of meshes) {
    const sourceMesh = resolveInstanceSourceMesh(mesh);
    if (!sourceMesh?.instancedBuffers) continue;
    ensureInstancedBufferContainer(mesh);
  }
}

/**
 * 在 SelectionOutlineLayer.clearSelection() 与 addSelection() 之间恢复矩阵实例缓冲不变量。
 * Babylon 在 sourceMesh 已有其它 instancedBuffers 时不会重新初始化每个实例的公开容器，
 * 因此必须同时覆盖当前选中实例和同源全部实例，避免渲染阶段读取 instanceSelectionId 时命中 null。
 */
export function prepareInstancedMeshesForSelectionOutline(meshes: readonly AbstractMesh[]): void {
  const sourceMeshes = new Set<Mesh>();

  for (const mesh of meshes) {
    const sourceMesh = resolveInstanceSourceMesh(mesh);
    if (!sourceMesh) continue;

    ensureInstancedBufferContainer(sourceMesh);
    ensureInstancedBufferContainer(mesh);
    sourceMeshes.add(sourceMesh);
  }

  for (const sourceMesh of sourceMeshes) {
    for (const instance of sourceMesh.instances) {
      ensureInstancedBufferContainer(instance);
    }
  }
}
