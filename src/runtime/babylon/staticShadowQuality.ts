import { type AbstractMesh, Vector3 } from '@babylonjs/core';
import type { GroundShadowReceiver } from './staticShadowReceivers';

export type ShadowBounds = [number, number, number, number];
export const SHADOW_BAKE_TEXELS_PER_METER = 128;

/** 将包围盒沿太阳方向投向接收高度，包含悬空部件和低角度太阳产生的长阴影。 */
export function projectedShadowBounds(mesh: AbstractMesh, height: number, direction: Vector3): ShadowBounds | null {
  mesh.computeWorldMatrix(true);
  const box = mesh.getBoundingInfo().boundingBox;
  if (box.maximumWorld.y < height || direction.y >= -1e-5) return null;
  const result: ShadowBounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const x of [box.minimumWorld.x, box.maximumWorld.x])
    for (const y of [Math.max(height, box.minimumWorld.y), box.maximumWorld.y])
      for (const z of [box.minimumWorld.z, box.maximumWorld.z]) {
        const distance = (height - y) / direction.y;
        const px = x + distance * direction.x, pz = z + distance * direction.z;
        result[0] = Math.min(result[0], px); result[1] = Math.min(result[1], pz);
        result[2] = Math.max(result[2], px); result[3] = Math.max(result[3], pz);
      }
  return result;
}

/** 只把像素用于可能有阴影的区域；楼层之间不再争抢同一张 4096 图集。 */
export function planGroundShadowLayer(receivers: GroundShadowReceiver[], casters: AbstractMesh[], direction: Vector3, maxSide: number) {
  const bounds: ShadowBounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const receiver of receivers) for (const caster of casters) for (const y of [receiver.min.y, receiver.max.y]) {
    const projected = projectedShadowBounds(caster, y, direction);
    if (!projected) continue;
    const x0 = Math.max(receiver.min.x, projected[0]), z0 = Math.max(receiver.min.z, projected[1]);
    const x1 = Math.min(receiver.max.x, projected[2]), z1 = Math.min(receiver.max.z, projected[3]);
    if (x1 < x0 || z1 < z0) continue;
    bounds[0] = Math.min(bounds[0], x0); bounds[1] = Math.min(bounds[1], z0);
    bounds[2] = Math.max(bounds[2], x1); bounds[3] = Math.max(bounds[3], z1);
  }
  if (!bounds.every(Number.isFinite)) return null;
  // 白色边界保证接收面超出烘焙区域时，CLAMP 不会把边缘阴影拉长到整块地面。
  bounds[0] -= 0.25; bounds[1] -= 0.25; bounds[2] += 0.25; bounds[3] += 0.25;
  const spanX = bounds[2] - bounds[0], spanZ = bounds[3] - bounds[1];
  const density = Math.min(SHADOW_BAKE_TEXELS_PER_METER, maxSide / Math.max(spanX, spanZ));
  return { receivers, bounds, width: Math.max(16, Math.ceil(spanX * density)), height: Math.max(16, Math.ceil(spanZ * density)) };
}
