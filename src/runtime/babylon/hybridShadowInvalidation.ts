import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { AbstractMesh, Matrix, SubMesh, ThinEngine } from '@babylonjs/core';

export type HybridShadowInvalidationMode = 'global' | 'local';
export type HybridShadowFallbackReason = 'unsupported-projection' | 'custom-shadow-rendering' | 'unreliable-bounds'
  | 'geometry-update' | 'custom-material' | 'submission-mismatch' | 'rendering-group-change' | 'history-overflow';
export type HybridShadowInvalidationMetrics = {
  invalidationMode?: HybridShadowInvalidationMode;
  /** 按 face 归因；localCacheHits 只计因局部证明免于全局 revision 重绘的命中。 */
  localInvalidations?: number;
  localCacheHits?: number;
  globalFallbacks?: number;
  globalFallbackReasons?: Partial<Record<HybridShadowFallbackReason, number>>;
};
export type HybridShadowBounds = readonly [number, number, number, number, number, number];
export type HybridShadowBoundsSnapshot = {
  bounds: HybridShadowBounds | null;
  fallbackReason: HybridShadowFallbackReason | null;
  renderingGroupId: number;
};
export type HybridShadowChange = {
  meshId: number;
  reason: 'membership' | 'signature' | 'geometry' | 'rendering-group';
  oldStatic: boolean;
  newStatic: boolean;
  oldBounds: HybridShadowBounds | null;
  newBounds: HybridShadowBounds | null;
  fallbackReason: HybridShadowFallbackReason | null;
};
type VersionedChange = HybridShadowChange & { revision: number };
type ProjectionPlane = readonly [number, number, number, number];
export type HybridShadowProjection = { planes: ProjectionPlane[]; padding: number };
export type HybridShadowChangeDecision = { invalidated: boolean; fallbackReason: HybridShadowFallbackReason | null };

/** 场景共享有界历史；游标属于 face，慢灯/停用后恢复的灯不能消费或清空别人的变更。 */
export class HybridShadowChangeHistory {
  private readonly changes: VersionedChange[] = [];
  private floorRevision = 0;
  private start = 0;
  private readonly capacity = 512;

  reset(revision: number): void {
    this.changes.length = 0;
    this.start = 0;
    this.floorRevision = revision;
  }

  record(revision: number, change: HybridShadowChange): void {
    const entry = { ...change, revision };
    if (this.changes.length < this.capacity) this.changes.push(entry);
    else {
      this.floorRevision = this.changes[this.start].revision;
      this.changes[this.start] = entry;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  evaluate(sinceRevision: number, projection: HybridShadowProjection): HybridShadowChangeDecision {
    if (sinceRevision < this.floorRevision) return { invalidated: true, fallbackReason: 'history-overflow' };
    for (let index = 0; index < this.changes.length; index++) {
      const change = this.changes[(this.start + index) % this.changes.length];
      if (change.revision <= sinceRevision) continue;
      if (change.fallbackReason) return { invalidated: true, fallbackReason: change.fallbackReason };
      if ((change.oldStatic && !change.oldBounds) || (change.newStatic && !change.newBounds)) {
        return { invalidated: true, fallbackReason: 'unreliable-bounds' };
      }
      if ((change.oldStatic && intersectsProjection(change.oldBounds!, projection))
        || (change.newStatic && intersectsProjection(change.newBounds!, projection))) {
        return { invalidated: true, fallbackReason: null };
      }
    }
    return { invalidated: false, fallbackReason: null };
  }
}

function hasReliableMeshBounds(mesh: AbstractMesh): mesh is Mesh {
  return mesh instanceof Mesh && !!mesh.geometry && !mesh.instances.length && !mesh.hasThinInstances
    && !mesh.skeleton && !mesh.morphTargetManager && !mesh.bakedVertexAnimationManager?.isEnabled
    && !mesh.doNotSyncBoundingInfo && !mesh.getBoundingInfo().isLocked && !mesh.getLODLevels().length
    && !mesh.getVertexBuffer('position')?.isUpdatable();
}

export function getHybridShadowSubMeshFallback(subMesh: SubMesh): HybridShadowFallbackReason | null {
  const mesh = subMesh.getEffectiveMesh();
  if (!hasReliableMeshBounds(mesh)) return 'unreliable-bounds';
  if (mesh !== subMesh.getRenderingMesh() || mesh !== subMesh.getMesh() || subMesh.getReplacementMesh()) return 'submission-mismatch';
  const material = subMesh.getMaterial();
  const className = material?.getClassName();
  if (mesh.getMaterialForRenderPass(mesh.getScene().getEngine().currentRenderPassId)
    || !material || material.shadowDepthWrapper || !['StandardMaterial', 'PBRMaterial', 'PBRMetallicRoughnessMaterial', 'PBRSpecularGlossinessMaterial'].includes(className!)) {
    return 'custom-material';
  }
  return null;
}

export function captureHybridShadowBounds(mesh: AbstractMesh, world: Matrix, boundsUncertain: boolean): HybridShadowBoundsSnapshot {
  const snapshot: HybridShadowBoundsSnapshot = { bounds: null, fallbackReason: null, renderingGroupId: mesh.renderingGroupId };
  // 不读顶点来重建 bounds，也不信任未更新包围盒的 GPU/可更新几何和实例批次。
  if (!hasReliableMeshBounds(mesh)) {
    snapshot.fallbackReason = 'unreliable-bounds';
    return snapshot;
  }
  if (boundsUncertain) {
    snapshot.fallbackReason = 'geometry-update';
    return snapshot;
  }
  for (const subMesh of mesh.subMeshes ?? []) {
    const reason = getHybridShadowSubMeshFallback(subMesh);
    if (reason) { snapshot.fallbackReason = reason; return snapshot; }
  }
  const m = world.asArray(), box = mesh.getBoundingInfo().boundingBox;
  const low = box.minimum, high = box.maximum;
  if (!Array.from(m).every(Number.isFinite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1
    || ![low.x, low.y, low.z, high.x, high.y, high.z].every(Number.isFinite)
    || low.x > high.x || low.y > high.y || low.z > high.z) {
    snapshot.fallbackReason = 'unreliable-bounds';
    return snapshot;
  }
  // 用本地 bounds 和已签名的矩阵计算世界 AABB，兼容冻结矩阵直接写 m 后 Babylon 的旧 world bounds。
  const min = [m[12], m[13], m[14]], max = [...min];
  const lows = [low.x, low.y, low.z], highs = [high.x, high.y, high.z];
  for (let axis = 0; axis < 3; axis++) for (let component = 0; component < 3; component++) {
    const first = m[axis * 4 + component] * lows[axis], second = m[axis * 4 + component] * highs[axis];
    min[component] += Math.min(first, second);
    max[component] += Math.max(first, second);
  }
  const bounds = [...min, ...max] as [number, number, number, number, number, number];
  if (bounds.every(Number.isFinite)) snapshot.bounds = bounds;
  else snapshot.fallbackReason = 'unreliable-bounds';
  return snapshot;
}

export function getHybridShadowProjectionFallback(generator: ShadowGenerator): HybridShadowFallbackReason | null {
  const light = generator.getLight(), scene = light.getScene();
  // 仅证明固定实际透视投影；方向光/CSM 深度钳制及自动范围继续依赖全局版本。
  if (!(light instanceof PointLight || light instanceof SpotLight)
    || !Number.isFinite(light.shadowMinZ) || !Number.isFinite(light.shadowMaxZ)
    || light.shadowMinZ! <= 0 || light.shadowMaxZ! <= light.shadowMinZ!
    || Boolean(light.customProjectionMatrixBuilder) || !scene.floatingOriginOffset.equalsToFloats(0, 0, 0)) return 'unsupported-projection';
  if (generator.constructor !== ShadowGenerator || generator.customShaderOptions || Boolean(generator.customAllowRendering)
    || generator.onBeforeShadowMapRenderObservable.hasObservers() || generator.onBeforeShadowMapRenderMeshObservable.hasObservers()
    || Boolean(scene.customLODSelector)) return 'custom-shadow-rendering';
  const map = generator.getShadowMap();
  if (!map?.renderList || map.getCustomRenderList || Boolean(map.renderListPredicate) || map.forceLayerMaskCheck) return 'submission-mismatch';
  return null;
}

/** 提取实际 clip 空间六平面，包含原生 depth bias，normalBias 则扩张世界 bounds。 */
export function createHybridShadowProjection(matrix: Matrix, generator: ShadowGenerator, engine: ThinEngine): HybridShadowProjection | null {
  const m = matrix.asArray();
  if (!Array.from(m).every(Number.isFinite) || !Number.isFinite(generator.bias) || !Number.isFinite(generator.normalBias)) return null;
  const depthTexture = generator.usePercentageCloserFiltering || generator.useContactHardeningShadow;
  const depthBias = depthTexture ? generator.bias * (engine.useReverseDepthBuffer ? -1 : 1) * (engine.isNDCHalfZRange ? 0.5 : 1) : 0;
  const x = [m[0], m[4], m[8], m[12]], y = [m[1], m[5], m[9], m[13]], w = [m[3], m[7], m[11], m[15]];
  const z = [m[2], m[6], m[10], m[14]].map((value, index) => value + depthBias * w[index]);
  const add = (a: number[], b: number[], sign: number) => a.map((value, index) => value + sign * b[index]) as [number, number, number, number];
  const planes = [add(w, x, 1), add(w, x, -1), add(w, y, 1), add(w, y, -1),
    engine.isNDCHalfZRange ? z as [number, number, number, number] : add(w, z, 1), add(w, z, -1)];
  if (planes.some(plane => !plane.every(Number.isFinite) || Math.hypot(plane[0], plane[1], plane[2]) === 0)) return null;
  return { planes, padding: Math.abs(generator.normalBias) };
}

function intersectsProjection(bounds: HybridShadowBounds, projection: HybridShadowProjection): boolean {
  for (const [x, y, z, d] of projection.planes) {
    const px = (x >= 0 ? bounds[3] : bounds[0]) + (x >= 0 ? projection.padding : -projection.padding);
    const py = (y >= 0 ? bounds[4] : bounds[1]) + (y >= 0 ? projection.padding : -projection.padding);
    const pz = (z >= 0 ? bounds[5] : bounds[2]) + (z >= 0 ? projection.padding : -projection.padding);
    const distance = x * px + y * py + z * pz + d;
    const tolerance = 1e-5 * Math.max(1, Math.abs(x * px) + Math.abs(y * py) + Math.abs(z * pz) + Math.abs(d));
    if (distance < -tolerance) return false;
  }
  return true;
}
