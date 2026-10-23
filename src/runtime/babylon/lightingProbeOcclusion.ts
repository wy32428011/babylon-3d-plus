import { Ray } from '@babylonjs/core/Culling/ray.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

export type LightingProbeOccluder = { key: string; mesh: Mesh; getWorldMatrix: () => Matrix | null };
type PreparedOccluder = { key: string; mesh: Mesh; world: Matrix; inverse: Matrix; minimum: Vector3; maximum: Vector3 };

/** 一次同步动态绑定更新内复用矩阵和包围盒；不得跨调用或跨帧保存。 */
export class LightingProbeOcclusionQuery {
  readonly stats = { matrixReads: 0, matrixInversions: 0, boundsTests: 0, triangleTests: 0 };
  private readonly prepared = new Map<LightingProbeOccluder, PreparedOccluder | null>();

  constructor(private readonly sources: readonly LightingProbeOccluder[]) {}

  private prepare(source: LightingProbeOccluder): PreparedOccluder | null {
    if (this.prepared.has(source)) return this.prepared.get(source)!;
    this.stats.matrixReads++;
    const currentWorld = source.getWorldMatrix();
    if (!currentWorld) { this.prepared.set(source, null); return null; }
    // getWorldMatrix 可能返回业务系统复用的可变矩阵，快照必须拥有自己的值。
    const world = currentWorld.clone(), inverse = Matrix.Invert(world);
    this.stats.matrixInversions++;
    const box = source.mesh.rawBoundingInfo?.boundingBox ?? source.mesh.getBoundingInfo().boundingBox;
    const minimum = new Vector3(Infinity, Infinity, Infinity), maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let corner = 0; corner < 8; corner++) {
      const local = new Vector3(corner & 1 ? box.maximum.x : box.minimum.x,
        corner & 2 ? box.maximum.y : box.minimum.y, corner & 4 ? box.maximum.z : box.minimum.z);
      const point = Vector3.TransformCoordinates(local, world);
      minimum.minimizeInPlace(point); maximum.maximizeInPlace(point);
    }
    const prepared = { key: source.key, mesh: source.mesh, world, inverse, minimum, maximum };
    this.prepared.set(source, prepared);
    return prepared;
  }

  visible(position: Vector3, point: readonly [number, number, number], receiverKey = ''): boolean {
    const offset = Vector3.FromArray(point).subtract(position), distance = offset.length();
    if (distance < 0.001) return true;
    const direction = offset.scale(1 / distance);
    const ray = new Ray(position.add(direction.scale(0.005)), direction, Math.max(0, distance - 0.01));
    for (const source of this.sources) {
      if (source.key === receiverKey) continue;
      const candidate = this.prepare(source); if (!candidate) continue;
      this.stats.boundsTests++;
      // 世界 AABB 只剔除确定不相交者，旋转、镜像及非均匀缩放仍交给原三角形检测。
      if (!ray.intersectsBoxMinMax(candidate.minimum, candidate.maximum)) continue;
      this.stats.triangleTests++;
      const hit = candidate.mesh.intersects(Ray.Transform(ray, candidate.inverse), true, undefined, false, candidate.world);
      if (hit.hit && hit.distance < distance - 0.01) return false;
    }
    return true;
  }
}
