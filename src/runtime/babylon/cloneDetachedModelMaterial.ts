import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { canBatchDetachedMaterialInitialization } from './SceneShaderWarmup.ts';
import { withNewMaterialDirtyGuard } from './withNewMaterialDirtyGuard.ts';

const nativeClones = new Set<Material['clone']>([PBRMaterial.prototype.clone, StandardMaterial.prototype.clone]);
const metrics = new WeakMap<Scene, { optimized: number; fallback: number }>();
export function getDetachedMaterialCloneMetrics(scene: Scene) { return { ...(metrics.get(scene) ?? { optimized: 0, fallback: 0 }) }; }

/**
 * 模型作者显式使用的新材质构建入口，不替换 Babylon.clone 或任何旧脚本。
 * 仅同步原生克隆可合并尚未绑定材质的 dirty 传播；定制方法、插件、纹理与创建监听走原方法。
 */
export function cloneDetachedModelMaterial(source: Material, clone: Material['clone'], name: string): Material | null {
  // 由调用点先取 clone 再求值 name，保留原成员调用的 getter/参数求值顺序与 receiver。
  const original = () => Reflect.apply(clone, source, [name]) as Material | null;
  if (!nativeClones.has(clone)) return original();
  const scene = Object.getOwnPropertyDescriptor(source, '_scene')?.value as Scene | undefined;
  if (!scene || typeof scene !== 'object') return original();
  let counts = metrics.get(scene);
  if (!counts) { counts = { optimized: 0, fallback: 0 }; metrics.set(scene, counts); }
  if (!canBatchDetachedMaterialInitialization(source, scene)) { counts.fallback++; return original(); }
  counts.optimized++;
  return withNewMaterialDirtyGuard(scene, original);
}
