import { AbstractMesh, Mesh } from '@babylonjs/core';
import type { ManualRoamPoint } from './manualRoamCollisionBounds.ts';

/** 低于该顶点数的网格保留椭球对三角碰撞，成本可接受。 */
export const MANUAL_ROAM_CHEAP_TRIANGLE_VERTEX_LIMIT = 2048;
/** 超过廉价顶点数但最大边不超过该尺寸的物体用 AABB 代理，避免走进实心盒子。 */
export const MANUAL_ROAM_COMPACT_PROXY_MAX_EXTENT_METERS = 8;

export type ManualRoamCollisionStyle = 'ignore' | 'native-triangle' | 'aabb-proxy' | 'local-triangle';

/**
 * 判断网格是否应排除出漫游碰撞世界。
 * 人物、辅助层、代理体和天空盒都不参与场景碰撞登记。
 */
export function isManualRoamCollisionExcludedMesh(mesh: AbstractMesh): boolean {
  if (mesh.isDisposed() || mesh.getTotalVertices() <= 0 || mesh.infiniteDistance) return true;
  if (mesh.getClassName() === 'LinesMesh') return true;
  const metadata = mesh.metadata as Record<string, unknown> | null;
  if (
    metadata?.manualRoamAvatar
    || metadata?.manualRoamCollider
    || metadata?.manualRoamCollisionProxy
    || metadata?.manualRoamLocalTriangleCollider
    || metadata?.manualRoamFallbackGround
    || metadata?.editorGroundGrid
    || metadata?.editorAutoPatrolMarker
    || metadata?.editorManualRoamSpawn
    || metadata?.editorShadowCatcher
    || metadata?.editorSkyboxSphere
  ) return true;
  const name = mesh.name.toLowerCase();
  return name.includes('skybox')
    || name.includes('gizmo')
    || name.includes('marker')
    || name.includes('trajectory')
    || name.includes('highlight');
}

/**
 * 按网格规模选择碰撞策略：廉价三角、紧凑 AABB 或邻域局部三角。
 * thin instance 由既有代理解析器处理，这里一律忽略。
 */
export function resolveManualRoamCollisionStyle(mesh: AbstractMesh): ManualRoamCollisionStyle {
  if (isManualRoamCollisionExcludedMesh(mesh)) return 'ignore';
  if (mesh instanceof Mesh && mesh.thinInstanceCount > 0) return 'ignore';
  const vertexCount = mesh.getTotalVertices();
  if (vertexCount <= 0) return 'ignore';
  if (vertexCount <= MANUAL_ROAM_CHEAP_TRIANGLE_VERTEX_LIMIT) return 'native-triangle';
  const extent = getMeshWorldMaxExtentMeters(mesh);
  if (extent <= MANUAL_ROAM_COMPACT_PROXY_MAX_EXTENT_METERS) return 'aabb-proxy';
  return 'local-triangle';
}

/** 读取网格世界 AABB 的最长边，供碰撞策略判断物体是否可走入内部。 */
export function getMeshWorldMaxExtentMeters(mesh: AbstractMesh): number {
  mesh.computeWorldMatrix();
  const box = mesh.getBoundingInfo().boundingBox;
  return Math.max(
    Math.abs(box.maximumWorld.x - box.minimumWorld.x),
    Math.abs(box.maximumWorld.y - box.minimumWorld.y),
    Math.abs(box.maximumWorld.z - box.minimumWorld.z),
  );
}

/** 判断点是否落在世界 AABB 的给定半径内，用于邻域碰撞登记。 */
export function isManualRoamPointNearWorldAabb(
  position: Readonly<ManualRoamPoint>,
  minimum: Readonly<ManualRoamPoint>,
  maximum: Readonly<ManualRoamPoint>,
  radiusMeters: number,
): boolean {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return false;
  const dx = Math.max(minimum.x - position.x, 0, position.x - maximum.x);
  const dy = Math.max(minimum.y - position.y, 0, position.y - maximum.y);
  const dz = Math.max(minimum.z - position.z, 0, position.z - maximum.z);
  return dx * dx + dy * dy + dz * dz <= radiusMeters * radiusMeters;
}
