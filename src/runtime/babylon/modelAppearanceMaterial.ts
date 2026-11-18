import type { Material } from '@babylonjs/core/Materials/material.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';

type Appearance = { base: Material | null; layers: Material[] };
const appearances = new WeakMap<AbstractMesh, Appearance>();

function currentAppearance(mesh: AbstractMesh): Appearance | undefined {
  const appearance = appearances.get(mesh);
  return appearance && mesh.material === appearance.layers.at(-1) ? appearance : undefined;
}

/** 光照读取设备的底层材质；原生实例的 material getter 委托给源网格。 */
export function getModelAppearanceBaseMaterial(mesh: AbstractMesh): Material | null {
  const owner = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  const appearance = currentAppearance(owner);
  return appearance ? appearance.base : owner.material;
}

/** 光照切换工作材质时仍显示当前外观，消警时再展示最新的底层材质。 */
export function setModelAppearanceBaseMaterial(mesh: AbstractMesh, material: Material | null): void {
  const appearance = currentAppearance(mesh);
  if (appearance) appearance.base = material;
  else mesh.material = material;
}

/** 临时颜色和表面特效只拥有自己的显示层。外部直接换材质时，释放不覆盖它。 */
export function applyModelAppearanceMaterial(mesh: AbstractMesh, material: Material): () => void {
  const appearance: Appearance = currentAppearance(mesh) ?? { base: mesh.material, layers: [] };
  appearance.layers.push(material);
  appearances.set(mesh, appearance);
  mesh.material = material;
  return () => {
    const index = appearance.layers.indexOf(material);
    if (index < 0) return;
    const ownsDisplay = currentAppearance(mesh) === appearance && mesh.material === material;
    appearance.layers.splice(index, 1);
    if (ownsDisplay && !mesh.isDisposed()) mesh.material = appearance.layers.at(-1) ?? appearance.base;
    if (!appearance.layers.length && appearances.get(mesh) === appearance) appearances.delete(mesh);
  };
}
