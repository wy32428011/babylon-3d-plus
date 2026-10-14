import type { CadReferenceGeometryLayer } from './cadReference';

/**
 * Babylon 把 thinInstance 的 world0..3 属性写入 Geometry，多个 Mesh 共用它会覆盖矩阵。
 * CAD 所有显示组使用同一线色，合并同原型批次的实例即可同时共享几何并保留全部位置。
 */
export function mergeCadReferenceRenderLayers(layers: readonly CadReferenceGeometryLayer[]): CadReferenceGeometryLayer[] {
  const result: CadReferenceGeometryLayer[] = [];
  const groups = new Map<string, { index: number; layers: CadReferenceGeometryLayer[] }>();
  for (const layer of layers) {
    if (!layer.isChunk || !layer.geometryKey || !layer.instanceMatrices) { result.push(layer); continue; }
    const group = groups.get(layer.geometryKey);
    if (group) group.layers.push(layer);
    else { groups.set(layer.geometryKey, { index: result.length, layers: [layer] }); result.push(layer); }
  }
  const matrixIds = new Map<Float32Array, number>();
  const combinedMatrices = new Map<string, Float32Array>();
  for (const group of groups.values()) {
    if (group.layers.length === 1) continue;
    const matrices = group.layers.map(layer => layer.instanceMatrices!);
    const key = matrices.map(matrix => {
      if (!matrixIds.has(matrix)) matrixIds.set(matrix, matrixIds.size);
      return matrixIds.get(matrix)!;
    }).join(',');
    let combined = combinedMatrices.get(key);
    if (!combined) {
      combined = new Float32Array(matrices.reduce((total, matrix) => total + matrix.length, 0));
      let offset = 0;
      for (const matrix of matrices) { combined.set(matrix, offset); offset += matrix.length; }
      combinedMatrices.set(key, combined);
    }
    result[group.index] = { ...group.layers[0], instanceMatrices: combined, instanceCount: combined.length / 16,
      entityCount: group.layers.reduce((total, layer) => total + layer.entityCount, 0),
      polylineCount: group.layers.reduce((total, layer) => total + layer.polylineCount, 0),
      pointCount: group.layers.reduce((total, layer) => total + layer.pointCount, 0) };
  }
  return result;
}
