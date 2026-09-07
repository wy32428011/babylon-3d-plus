import { type AbstractMesh, Matrix, Mesh, MultiMaterial, PBRMaterial, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core';
import type { ShadowBakeSurface } from './EnvironmentShadowBake';

export type GroundShadowReceiver = { surface: ShadowBakeSurface; min: Vector3; max: Vector3; area: number; triangles: Vector3[][] };

/** 高度不同且投影范围相交的表面分开烘焙，分组只影响贴图区块，不拆分场景模型。 */
export function partitionGroundShadowLayers(receivers: readonly GroundShadowReceiver[]): GroundShadowReceiver[][] {
  const layers: GroundShadowReceiver[][] = [];
  for (const receiver of [...receivers].sort((a, b) => a.max.y - b.max.y)) {
    const layer = layers.find(group => group.every(other => Math.abs(receiver.max.y - other.max.y) <= 1
      || Math.min(receiver.max.x, other.max.x) <= Math.max(receiver.min.x, other.min.x)
      || Math.min(receiver.max.z, other.max.z) <= Math.max(receiver.min.z, other.min.z)));
    if (layer) layer.push(receiver); else layers.push([receiver]);
  }
  return layers;
}

/** 检查真实三角形投影，不能把有厂房洞口的道路包围盒误当作整块实心地面。 */
export function groundReceiversOverlapXZ(a: GroundShadowReceiver, b: GroundShadowReceiver): boolean {
  if (Math.min(a.max.x, b.max.x) <= Math.max(a.min.x, b.min.x)
    || Math.min(a.max.z, b.max.z) <= Math.max(a.min.z, b.min.z)) return false;
  const overlap = (first: Vector3[], second: Vector3[]) => {
    for (const triangle of [first, second]) for (let i = 0; i < 3; i++) {
      const from = triangle[i], to = triangle[(i + 1) % 3];
      const x = from.z - to.z, z = to.x - from.x;
      const one = first.map(point => point.x * x + point.z * z);
      const two = second.map(point => point.x * x + point.z * z);
      if (Math.max(...one) <= Math.min(...two) + 1e-6 || Math.max(...two) <= Math.min(...one) + 1e-6) return false;
    }
    return true;
  };
  if (overlap(a.triangles[0], b.triangles[0])) return true;
  const size = Math.min(32, Math.ceil(Math.sqrt(b.triangles.length)));
  const width = Math.max(1e-6, b.max.x - b.min.x), depth = Math.max(1e-6, b.max.z - b.min.z);
  const cells = new Map<number, number[]>();
  const range = (triangle: Vector3[]) => [
    Math.max(0, Math.floor((Math.min(...triangle.map(p => p.x)) - b.min.x) / width * size)),
    Math.min(size - 1, Math.floor((Math.max(...triangle.map(p => p.x)) - b.min.x) / width * size)),
    Math.max(0, Math.floor((Math.min(...triangle.map(p => p.z)) - b.min.z) / depth * size)),
    Math.min(size - 1, Math.floor((Math.max(...triangle.map(p => p.z)) - b.min.z) / depth * size)),
  ];
  let references = 0;
  b.triangles.forEach((triangle, index) => {
    const [x0, x1, z0, z1] = range(triangle);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (++references > 1_000_000) throw new Error('多层地面结构过于复杂，请按楼层拆分后更新阴影。');
      const key = z * size + x, list = cells.get(key) ?? []; list.push(index); cells.set(key, list);
    }
  });
  for (const triangle of a.triangles) {
    const [x0, x1, z0, z1] = range(triangle), tested = new Set<number>();
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const index of cells.get(z * size + x) ?? []) {
      if (!tested.has(index) && overlap(triangle, b.triangles[index])) return true;
      tested.add(index);
    }
  }
  return false;
}

function transformVertex(data: ArrayLike<number>, index: number, world: Matrix): Vector3 {
  return Vector3.TransformCoordinates(new Vector3(data[index * 3], data[index * 3 + 1], data[index * 3 + 2]), world);
}

function supportsStaticMask(material: ShadowBakeSurface['material']): boolean {
  if (material instanceof PBRMaterial || material instanceof StandardMaterial) return true;
  return material instanceof MultiMaterial && material.subMaterials.every(child => !child || supportsStaticMask(child));
}

/** 按真正被索引使用的三角形识别地面，避免 glTF 多材质 primitive 的共享顶点扩大包围盒。 */
export function inspectGroundReceiver(surface: ShadowBakeSurface): GroundShadowReceiver | null {
  const mesh = surface.mesh;
  if (!(mesh instanceof Mesh) || !mesh.isEnabled() || !mesh.isVisible || !supportsStaticMask(surface.material)) return null;
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind), indices = mesh.getIndices();
  if (!positions || !indices?.length) return null;
  const world = mesh.computeWorldMatrix(true);
  const vertices = new Map<number, Vector3>();
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const point = (index: number) => {
    let value = vertices.get(index);
    if (!value) { value = transformVertex(positions, index, world); vertices.set(index, value); min.minimizeInPlace(value); max.maximizeInPlace(value); }
    return value;
  };
  let horizontal = 0, total = 0;
  const triangles: Vector3[][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = point(indices[i]), b = point(indices[i + 1]), c = point(indices[i + 2]);
    const normal = Vector3.Cross(b.subtract(a), c.subtract(a));
    const twiceArea = normal.length(); total += twiceArea;
    if (twiceArea > 1e-6 && Math.abs(normal.y) >= twiceArea * 0.95) { horizontal += twiceArea; triangles.push([a, b, c]); }
  }
  if (!Number.isFinite(total) || !triangles.length || total < 0.5 || horizontal / total < 0.9 || max.y - min.y > 1) return null;
  return { surface, min, max, area: horizontal / 2, triangles };
}

/** 只选设备附近、位于设备底部之下的地面，玻璃窗、屋顶与深埋底板不占用烘焙预算。 */
export function selectGroundShadowReceivers(surfaces: ShadowBakeSurface[], deviceCasters: AbstractMesh[]): GroundShadowReceiver[] {
  const candidates = surfaces.map(inspectGroundReceiver).filter((value): value is GroundShadowReceiver => value !== null);
  const selected = new Set<GroundShadowReceiver>();
  for (const caster of deviceCasters) {
    caster.computeWorldMatrix(true);
    const bounds = caster.getBoundingInfo().boundingBox;
    const nearby = candidates.filter(candidate => candidate.max.y <= bounds.minimumWorld.y + 0.75
      && candidate.max.y >= bounds.minimumWorld.y - 3
      && candidate.max.x >= bounds.minimumWorld.x - 2 && candidate.min.x <= bounds.maximumWorld.x + 2
      && candidate.max.z >= bounds.minimumWorld.z - 2 && candidate.min.z <= bounds.maximumWorld.z + 2);
    if (!nearby.length) continue;
    // 同一厂区室内地坪和室外道路可能有小高差；两者都要保留，后续按真实投影检查楼层重叠。
    for (const candidate of nearby) selected.add(candidate);
  }
  return [...selected];
}

/** 第三套 UV 只写入环境工作副本，保留原色常用的 UV0/UV1。 */
export function applyGroundShadowUv(mesh: AbstractMesh, bounds: readonly number[]): void {
  if (!(mesh instanceof Mesh)) throw new Error(`环境表面「${mesh.name}」不能接收静态地面遮罩。`);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error(`环境表面「${mesh.name}」缺少位置数据。`);
  const world = mesh.computeWorldMatrix(true);
  const uv = new Float32Array(positions.length / 3 * 2);
  for (let i = 0; i < positions.length / 3; i++) {
    const point = transformVertex(positions, i, world);
    uv[i * 2] = (point.x - bounds[0]) / (bounds[2] - bounds[0]);
    uv[i * 2 + 1] = (point.z - bounds[1]) / (bounds[3] - bounds[1]);
  }
  mesh.makeGeometryUnique();
  mesh.setVerticesData(VertexBuffer.UV3Kind, uv, false, 2);
}
