import {
  InstancedMesh,
  LinesMesh,
  Material,
  Mesh,
  MultiMaterial,
  type AbstractMesh,
} from '@babylonjs/core';

export type ModelTriangleStatisticsOptions = {
  /** 业务阵列有独立全量实例登记时，可只读取一份源几何面数。 */
  includeThinInstances?: boolean;
};

const EDITOR_HELPER_FLAGS = [
  'digitalTwinEffectProxy',
  'effectBoundsProxy',
  'editorGroundGrid',
  'editorOverlay',
  'editorSkyboxSphere',
  'editorShadowCatcher',
  'editorAutoPatrolMarker',
  'editorManualRoamSpawn',
  'editorChartMarker',
] as const;

function countTopologyTriangles(elementCount: number, fillMode: number): number {
  if (!Number.isFinite(elementCount) || elementCount < 3) return 0;
  switch (fillMode) {
    case Material.PointFillMode:
    case Material.PointListDrawMode:
    case Material.LineListDrawMode:
    case Material.LineLoopDrawMode:
    case Material.LineStripDrawMode:
      return 0;
    case Material.TriangleStripDrawMode:
    case Material.TriangleFanDrawMode:
      return Math.max(0, Math.floor(elementCount) - 2);
    default:
      // 线框只改变三角面的画法，仍保留源几何的三角面数量。
      return Math.floor(elementCount / 3);
  }
}

/**
 * 按模型源几何统计三角面，只读取数量元数据，避免为大模型复制顶点或索引。
 * 显隐、材质双面及相机 LOD 选择不改变总量；备用 LOD 和编辑辅助不计入。
 * 原生薄实例不额外包含源自身；其缓冲区容量可能大于实际数量，不能用容量推断实例数。
 */
export function countModelMeshTriangles(
  mesh: AbstractMesh,
  options: ModelTriangleStatisticsOptions = {},
): number {
  if (mesh.isDisposed() || mesh instanceof LinesMesh || mesh.isBlocked) return 0;
  if (mesh instanceof InstancedMesh && (mesh.sourceMesh instanceof LinesMesh || mesh.sourceMesh.isBlocked)) return 0;
  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  if (metadata && (EDITOR_HELPER_FLAGS.some((flag) => metadata[flag] === true) || metadata.effectRole)) return 0;

  const geometryMesh = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  const totalIndices = mesh.getTotalIndices();
  const useIndices = !(geometryMesh instanceof Mesh && geometryMesh.isUnIndexed) && totalIndices > 0;
  const material = mesh.material;
  let triangleCount = 0;
  if (mesh.subMeshes?.length) {
    for (const subMesh of mesh.subMeshes) {
      const subMaterial = material instanceof MultiMaterial ? material.getSubMaterial(subMesh.materialIndex) : material;
      const elementCount = useIndices ? subMesh.indexCount : subMesh.verticesCount;
      triangleCount += countTopologyTriangles(elementCount, subMaterial?.fillMode ?? Material.TriangleFillMode);
    }
  } else {
    const elementCount = useIndices ? totalIndices : mesh.getTotalVertices();
    triangleCount = countTopologyTriangles(elementCount, material?.fillMode ?? Material.TriangleFillMode);
  }

  const thinInstanceCount = options.includeThinInstances !== false && mesh instanceof Mesh
    ? mesh.thinInstanceCount
    : 0;
  // Babylon 的薄实例会替代源网格绘制；源自身也必须显式登记为薄实例才计入。
  return triangleCount * (thinInstanceCount > 0 ? thinInstanceCount : 1);
}
