import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/** 只用于已核对指纹、米制、前向 +Z 的 EQ_People，在真实 bind 空间内处理裤身和衣摆。 */
export function shapeEqPeopleSeat(vertices, normals, tangents, garmentIndices, hip) {
  const halfWidth = 0.165; // 骨盆两侧以内，避开原走姿下贴近身体的袖片
  const halfHeight = 0.195;
  const maxInset = 0.018;
  const depthFade = 0.09;
  for (const index of garmentIndices) {
    const p = vertices[index];
    const x = (p.x - hip.x) / halfWidth;
    const y = (p.y - (hip.y - 0.035)) / halfHeight;
    const depth = Math.min(1, (hip.z - p.z - 0.01) / depthFade);
    if (Math.abs(x) >= 1 || Math.abs(y) >= 1 || depth <= 0) continue;

    // 两裤片和衣摆内外层使用同一空间位移。各边界的位移和一阶导数均为零。
    const lateral = 1 - x ** 4;
    const vertical = 1 - y * y;
    const inset = maxInset * lateral ** 2 * vertical ** 2;
    const rear = depth * depth * (3 - 2 * depth);
    p.z += inset * rear;

    // F=(x,y,z+位移)。按 J 的逆转置更新源法线，按 J 更新切线，保留原平滑组和切线手性。
    const slope = 2 * maxInset * lateral * vertical * rear;
    const dx = slope * vertical * (-4 * x ** 3 / halfWidth);
    const dy = slope * lateral * (-2 * y / halfHeight);
    const zz = 1 - inset * 6 * depth * (1 - depth) / depthFade;
    const n = Vector3.FromArray(normals, index * 3);
    new Vector3(zz * n.x - dx * n.z, zz * n.y - dy * n.z, n.z)
      .normalize().toArray(normals, index * 3);
    const t = Vector3.FromArray(tangents, index * 4);
    new Vector3(t.x, t.y, dx * t.x + dy * t.y + zz * t.z)
      .normalize().toArray(tangents, index * 4);
  }
}
