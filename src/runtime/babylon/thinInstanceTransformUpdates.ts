import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { TransformComponent } from '../../editor/model/components';
import type { CapturedEntityArrayMatrix, EntityArrayMatrixBatch, EntityArrayMatrixSource, EntityArrayThinInstanceTransform } from './thinInstanceBatchTypes';
import { applyNegativeOrientationCarrierToBuffer, captureCandidateSourceWorldMatrices, createTransformMatrix, getMatrixOrientation, resolveFormalBatchMaxInstancesPerPartition } from './thinInstanceMatrixBuilder';

/** 只借用本模块拥有的完整矩阵布局；相机压缩、预览或载体替换后必须重新建立快照。 */
type BatchLayout = {
  batch: EntityArrayMatrixBatch;
  sourceMatrices: Float32Array;
  renderMatrices: Float32Array;
  sourceIndexes: Uint32Array;
  rangeStarts: Int32Array;
  rangeCounts: Uint32Array;
  geometry: EntityArrayMatrixBatch['mesh']['geometry'];
  orientation: EntityArrayMatrixBatch['orientation'];
};
type SourceLayout = {
  source: EntityArrayMatrixSource;
  sourceMeshes: EntityArrayMatrixSource['sourceMeshes'];
  matrices: CapturedEntityArrayMatrix[];
  geometry: EntityArrayMatrixSource['batchSource']['geometry'];
  rootLocalGeometryBaked: boolean;
  batches: BatchLayout[];
};
export type EntityArrayTransformSnapshot = {
  instances: Array<Pick<EntityArrayThinInstanceTransform, 'entityId' | 'transform'>>;
  sources: SourceLayout[];
};
export type EntityArrayTransformPatch = { batch: EntityArrayMatrixBatch; rows: number[]; matrices: Float32Array };
export type PreparedEntityArrayTransformUpdate = {
  patches: EntityArrayTransformPatch[];
  changes: Array<{ index: number; transform: TransformComponent }>;
};

function copyTransform(transform: TransformComponent): TransformComponent {
  return { position: { ...transform.position }, rotation: { ...transform.rotation }, scale: { ...transform.scale } };
}
function sameTransform(left: TransformComponent, right: TransformComponent): boolean {
  return left.position.x === right.position.x && left.position.y === right.position.y && left.position.z === right.position.z
    && left.rotation.x === right.rotation.x && left.rotation.y === right.rotation.y && left.rotation.z === right.rotation.z
    && left.scale.x === right.scale.x && left.scale.y === right.scale.y && left.scale.z === right.scale.z;
}

function layoutIsCurrent(layout: BatchLayout): boolean {
  const { batch, sourceMatrices, renderMatrices, sourceIndexes, rangeStarts, rangeCounts } = layout;
  const count = sourceIndexes.length;
  return !batch.mesh.isDisposed() && batch.mesh.geometry === layout.geometry && batch.requestedVisible
    && batch.orientation === layout.orientation && batch.partitionIndex === 0
    && batch.sourceMatrixBuffer === sourceMatrices && batch.matrixBuffer === renderMatrices
    && batch.sourceEntityIndexBuffer === sourceIndexes && batch.entityInstanceRangeStarts === rangeStarts
    && batch.entityInstanceRangeCounts === rangeCounts && batch.mesh.thinInstanceCount === count
    && batch.mesh._thinInstanceDataStorage.matrixData === renderMatrices
    && batch.visibleSourceIndexCount === count && !!batch.visibleSourceIndexBuffer && !!batch.entityIndexBuffer
    && sourceIndexes.every((entityIndex, row) => batch.visibleSourceIndexBuffer![row] === row
      && batch.entityIndexBuffer![row] === entityIndex);
}

/** 保存完整数值输入而不是调用方的可变 Transform 引用，不能凭 ID/数量相同认定内容未变。 */
export function captureEntityArrayTransformSnapshot(
  plans: readonly { source: EntityArrayMatrixSource; sourceMatrices: CapturedEntityArrayMatrix[]; positiveCount: number; negativeCount: number }[],
  instances: readonly EntityArrayThinInstanceTransform[],
): EntityArrayTransformSnapshot | null {
  const sources: SourceLayout[] = [];
  for (const plan of plans) {
    const batches: BatchLayout[] = [];
    for (const orientation of [1, -1] as const) {
      const count = orientation > 0 ? plan.positiveCount : plan.negativeCount;
      if (count === 0) continue;
      // 超过阈值时位移可能改变既有空间排序；保留原分片算法，不让增量路径改变拾取索引语义。
      if (count > resolveFormalBatchMaxInstancesPerPartition(plan.source)) return null;
      const batch = plan.source.batches.find(item => item.orientation === orientation && item.partitionIndex === 0);
      if (!batch?.sourceMatrixBuffer || !batch.matrixBuffer || !batch.sourceEntityIndexBuffer
        || !batch.entityInstanceRangeStarts || !batch.entityInstanceRangeCounts
        || batch.sourceEntityIndexBuffer.length !== count || batch.sourceMatrixBuffer.length !== count * 16
        || batch.matrixBuffer.length !== count * 16 || batch.entityInstanceRangeStarts.length !== instances.length
        || batch.entityInstanceRangeCounts.length !== instances.length) return null;
      const layout: BatchLayout = { batch, sourceMatrices: batch.sourceMatrixBuffer, renderMatrices: batch.matrixBuffer,
        sourceIndexes: batch.sourceEntityIndexBuffer, rangeStarts: batch.entityInstanceRangeStarts,
        rangeCounts: batch.entityInstanceRangeCounts, geometry: batch.mesh.geometry, orientation: batch.orientation };
      if (!layoutIsCurrent(layout)) return null;
      batches.push(layout);
    }
    sources.push({ source: plan.source, sourceMeshes: [...plan.source.sourceMeshes], matrices: plan.sourceMatrices,
      geometry: plan.source.batchSource.geometry, rootLocalGeometryBaked: plan.source.rootLocalGeometryBaked, batches });
  }
  return { instances: instances.map(instance => ({ entityId: instance.entityId, transform: copyTransform(instance.transform) })), sources };
}

/** 全部校验和矩阵计算先于写入；未知源变更、方向换组或可见/空间布局变化交还原全量事务。 */
export function prepareEntityArrayTransformUpdate(
  snapshot: EntityArrayTransformSnapshot,
  inverseSourceRoot: Matrix,
  instances: readonly EntityArrayThinInstanceTransform[],
): PreparedEntityArrayTransformUpdate | null {
  if (instances.length !== snapshot.instances.length) return null;
  const changed: Array<{ index: number; matrix: CapturedEntityArrayMatrix; transform: TransformComponent }> = [];
  for (let index = 0; index < instances.length; index++) {
    const next = instances[index], previous = snapshot.instances[index];
    if (next.entityId !== previous.entityId) return null;
    if (sameTransform(next.transform, previous.transform)) continue;
    const matrix = createTransformMatrix(next.transform), orientation = getMatrixOrientation(matrix);
    const previousOrientation = getMatrixOrientation(createTransformMatrix(previous.transform));
    if (!orientation || orientation !== previousOrientation) return null;
    changed.push({ index, matrix: { matrix, orientation }, transform: copyTransform(next.transform) });
    if (changed.length > Math.min(64, Math.max(1, Math.floor(instances.length / 4)))) return null;
  }

  const patches: EntityArrayTransformPatch[] = [];
  const world = new Matrix();
  for (const entry of snapshot.sources) {
    const { source } = entry;
    if (source.batchSource.geometry !== entry.geometry || source.rootLocalGeometryBaked !== entry.rootLocalGeometryBaked
      || source.sourceMeshes.length !== entry.sourceMeshes.length
      || source.sourceMeshes.some((mesh, index) => mesh !== entry.sourceMeshes[index] || mesh.isDisposed())
      || entry.batches.some(layout => !layoutIsCurrent(layout)
        || layout.sourceIndexes.length > resolveFormalBatchMaxInstancesPerPartition(source))) return null;
    // 内部 thinInstance 与普通源节点都可能在同一数量下移动，必须逐值核对真实相对矩阵。
    const current = source.rootLocalGeometryBaked ? [Matrix.Identity()] : captureCandidateSourceWorldMatrices(source, inverseSourceRoot);
    if (current.length !== entry.matrices.length || current.some((matrix, index) =>
      matrix.m.some((value, component) => value !== entry.matrices[index].matrix.m[component]))) return null;

    for (const layout of entry.batches) {
      const count = changed.reduce((sum, change) => sum + layout.rangeCounts[change.index], 0);
      if (!count) continue;
      const matrices = new Float32Array(count * 16);
      const rows: number[] = [];
      for (const change of changed) {
        let row = layout.rangeStarts[change.index];
        const end = row + layout.rangeCounts[change.index];
        for (const sourceMatrix of entry.matrices) {
          const orientation = sourceMatrix.orientation === change.matrix.orientation ? 1 : -1;
          if (orientation !== layout.batch.orientation) continue;
          if (row < 0 || row >= end || layout.sourceIndexes[row] !== change.index) return null;
          const offset = rows.length * 16;
          sourceMatrix.matrix.multiplyToRef(change.matrix.matrix, world);
          world.copyToArray(matrices, offset);
          if (orientation < 0) applyNegativeOrientationCarrierToBuffer(matrices, offset);
          let different = false;
          for (let component = 0; component < 16; component++) {
            const value = matrices[offset + component];
            if (!Number.isFinite(value)) return null;
            if (value !== layout.sourceMatrices[row * 16 + component]) different = true;
          }
          if (different) rows.push(row);
          row++;
        }
        if (row !== end) return null;
      }
      if (rows.length) patches.push({ batch: layout.batch, rows, matrices: matrices.subarray(0, rows.length * 16) });
    }
  }
  return { patches, changes: changed.map(({ index, transform }) => ({ index, transform })) };
}
