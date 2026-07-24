import {
  AbstractMesh,
  type InstancedMesh,
  type Material,
  Matrix,
  PBRMaterial,
  Mesh,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import type { Vector3Data } from '../../editor/model/math';

const ENTITY_ARRAY_MATRIX_INSTANCE_LIMIT = 1_000_000;
const ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON = 1e-12;
const INSTANCE_SELECTION_ID_BUFFER = 'instanceSelectionId';
/** 单个合并载体的静态顶点预算，避免把高密度内部 thinInstance 意外展开成超大 Geometry。 */
const STATIC_MERGE_MAX_VERTICES = 1_000_000;
const STATIC_MERGE_MAX_INDICES = 3_000_000;
const STATIC_MERGE_VERTEX_KINDS = new Set([
  VertexBuffer.PositionKind,
  VertexBuffer.NormalKind,
  VertexBuffer.TangentKind,
  VertexBuffer.UVKind,
  VertexBuffer.UV2Kind,
  VertexBuffer.UV3Kind,
  VertexBuffer.UV4Kind,
  VertexBuffer.UV5Kind,
  VertexBuffer.UV6Kind,
  VertexBuffer.ColorKind,
  INSTANCE_SELECTION_ID_BUFFER,
  VertexBuffer.MatricesIndicesKind,
  VertexBuffer.MatricesWeightsKind,
  VertexBuffer.MatricesIndicesExtraKind,
  VertexBuffer.MatricesWeightsExtraKind,
]);

type EntityArrayMatrixOrientation = 1 | -1;

type EntityArrayMatrixBatch = {
  mesh: Mesh;
  sourceMesh: AbstractMesh;
  batchSource: Mesh;
  matrixBuffer: Float32Array | null;
  selectionBuffer: Float32Array | null;
  entityIndexBuffer: Uint32Array | null;
  entityInstanceRangeStarts: Int32Array | null;
  entityInstanceRangeCounts: Uint32Array | null;
  orientation: EntityArrayMatrixOrientation;
  /** 隐藏参数脚本宿主时，批次仍使用宿主隐藏前的渲染层。 */
  layerMask: number | null;
};

type EntityArrayMatrixCandidate = {
  meshIndex: number;
  sourceMesh: AbstractMesh;
  batchSource: Mesh;
  layerMask: number | null;
  /** 已烘焙到源模型根节点局部空间的静态合并 Geometry。 */
  rootLocalVertexData: VertexData | null;
  rootLocalGeometryBaked: boolean;
  sourceRootWorldMatrix: Matrix | null;
};

type EntityArrayMatrixSource = EntityArrayMatrixCandidate & {
  entityId: string;
  metadata: Record<string, unknown> | null;
  namePrefix: string;
  batches: EntityArrayMatrixBatch[];
};

type CapturedEntityArrayMatrix = {
  matrix: Matrix;
  orientation: EntityArrayMatrixOrientation;
};

export type EntityArrayThinInstanceBatchOptions = {
  /** 正式阵列允许拾取并刷新整体包围盒；临时预览保持不可交互。 */
  interactive?: boolean;
  metadata?: Record<string, unknown> | null;
  namePrefix?: string;
  /** 可覆盖批次 Mesh 的渲染层，避免隐藏脚本宿主后把 layerMask=0 传播到正式实例。 */
  resolveLayerMask?: (sourceMesh: AbstractMesh) => number;
  /** 正式静态模型阵列可按材质合并叶 Mesh；预览和动态模型默认保持逐 Mesh 路径。 */
  mergeStaticMeshesByMaterial?: boolean;
  /** 合并 Geometry 使用的源模型根世界矩阵，顶点会烘焙到该根节点局部空间。 */
  sourceRootWorldMatrix?: Matrix;
};

/** 一个可独立编辑、但与同组实体共享静态外观资源的矩阵实例。 */
export type EntityArrayThinInstanceTransform = {
  entityId: string;
  transform: TransformComponent;
  pickable: boolean;
};

/**
 * 使用固定数量的批次 Mesh 和 thinInstance 矩阵显示模型阵列。
 * 每个源可渲染 Mesh 通常只创建一个批次；正负 determinant 混合时最多使用两个方向批次。
 * 逻辑模型数量只体现在连续矩阵缓冲中，不会退回逐模型节点刷出。
 */
export class EntityArrayThinInstanceBatch {
  readonly meshes: Mesh[];

  private readonly previewOffsets: Vector3Data[] = [];
  private readonly batchByMeshUniqueId = new Map<number, EntityArrayMatrixBatch>();
  private readonly batches: EntityArrayMatrixBatch[];
  private entityIds: string[] = [];
  private readonly entityIndexById = new Map<string, number>();
  private pickableEntityIds = new Set<string>();
  private selectedEntityIds = new Set<string>();
  private selectionId = 0;
  private entityLayoutRevision = 0;
  private selectionLayoutRevision = -1;

  private constructor(
    private readonly sources: EntityArrayMatrixSource[],
    batches: EntityArrayMatrixBatch[],
    private readonly interactive: boolean,
  ) {
    this.batches = batches;
    this.meshes = batches.map((batch) => batch.mesh);
    for (const batch of batches) this.batchByMeshUniqueId.set(batch.mesh.uniqueId, batch);
  }

  /** 从当前模型的可渲染 Mesh 快照创建矩阵批次；没有有效几何时返回 null。 */
  static create(
    entityId: string,
    sourceMeshes: readonly AbstractMesh[],
    options: EntityArrayThinInstanceBatchOptions = {},
  ): EntityArrayThinInstanceBatch | null {
    let candidates: EntityArrayMatrixCandidate[] = [];

    for (let meshIndex = 0; meshIndex < sourceMeshes.length; meshIndex += 1) {
      const sourceMesh = sourceMeshes[meshIndex];
      if (sourceMesh.isDisposed() || sourceMesh.getTotalVertices() <= 0) continue;

      const batchSource = resolveBatchSourceMesh(sourceMesh);
      if (!batchSource || getSourceMatrixCount(sourceMesh) <= 0) return null;
      candidates.push({
        meshIndex,
        sourceMesh,
        batchSource,
        layerMask: options.resolveLayerMask?.(sourceMesh) ?? null,
        rootLocalVertexData: null,
        rootLocalGeometryBaked: false,
        sourceRootWorldMatrix: null,
      });
    }

    if (candidates.length === 0) return null;

    if (options.mergeStaticMeshesByMaterial && options.sourceRootWorldMatrix) {
      candidates = mergeStaticCandidatesByMaterial(candidates, options.sourceRootWorldMatrix);
    }

    const interactive = options.interactive === true;
    const sources: EntityArrayMatrixSource[] = [];
    const batches: EntityArrayMatrixBatch[] = [];
    try {
      for (const candidate of candidates) {
        const source: EntityArrayMatrixSource = {
          ...candidate,
          entityId,
          metadata: options.metadata ? { ...options.metadata } : null,
          namePrefix: options.namePrefix ?? '__entityArrayMatrix',
          batches: [],
        };
        const batch = createMatrixBatch(source, 1, interactive, false);
        source.batches.push(batch);
        sources.push(source);
        batches.push(batch);
      }
    } catch (error) {
      disposeBatches(batches);
      console.warn('创建模型阵列矩阵批次失败。', error);
      return null;
    }

    return new EntityArrayThinInstanceBatch(sources, batches, interactive);
  }

  /** 更新等距预览矩阵；相同数量时复用已有 Float32Array。 */
  update(copyCount: number, direction: Vector3Data, arrayStepMeters: number): boolean {
    if (
      !Number.isSafeInteger(copyCount)
      || copyCount < 1
      || !isFiniteVector3(direction)
      || !Number.isFinite(arrayStepMeters)
      || arrayStepMeters < 0
    ) {
      return false;
    }

    while (this.previewOffsets.length < copyCount) {
      this.previewOffsets.push({ x: 0, y: 0, z: 0 });
    }
    this.previewOffsets.length = copyCount;
    for (let copyIndex = 0; copyIndex < copyCount; copyIndex += 1) {
      const offsetMultiplier = arrayStepMeters * (copyIndex + 1);
      const offset = this.previewOffsets[copyIndex];
      offset.x = direction.x * offsetMultiplier;
      offset.y = direction.y * offsetMultiplier;
      offset.z = direction.z * offsetMultiplier;
    }

    return this.updateOffsets(this.previewOffsets);
  }

  /**
   * 一次性把全部预览偏移写入每个源 Mesh 的 thinInstance 矩阵缓冲。
   * 源模型当前已有 thinInstance 时，会先展开源矩阵再与每个阵列偏移组合。
   */
  updateOffsets(offsets: readonly Vector3Data[]): boolean {
    if (offsets.length < 1 || offsets.some((offset) => !isFiniteVector3(offset))) return false;

    const plans: Array<{
      source: EntityArrayMatrixSource;
      sourceMatrices: CapturedEntityArrayMatrix[];
      positiveCount: number;
      negativeCount: number;
      batchByOrientation: Partial<Record<EntityArrayMatrixOrientation, EntityArrayMatrixBatch>>;
    }> = [];
    let totalInstanceCount = 0;
    for (const source of this.sources) {
      const sourceWorldMatrices = source.rootLocalGeometryBaked && source.sourceRootWorldMatrix
        ? [source.sourceRootWorldMatrix.clone()]
        : captureSourceWorldMatrices(source.sourceMesh);
      const sourceMatrices = captureMatrixOrientations(sourceWorldMatrices);
      if (!sourceMatrices) return false;

      const positiveSourceCount = sourceMatrices.filter((entry) => entry.orientation > 0).length;
      const negativeSourceCount = sourceMatrices.length - positiveSourceCount;
      const positiveCount = positiveSourceCount * offsets.length;
      const negativeCount = negativeSourceCount * offsets.length;
      totalInstanceCount += positiveCount + negativeCount;
      if (!Number.isSafeInteger(totalInstanceCount) || totalInstanceCount > ENTITY_ARRAY_MATRIX_INSTANCE_LIMIT) {
        return false;
      }
      plans.push({
        source,
        sourceMatrices,
        positiveCount,
        negativeCount,
        batchByOrientation: {},
      });
    }

    for (const plan of plans) {
      const batchByOrientation = this.prepareOrientationBatches(
        plan.source,
        plan.positiveCount,
        plan.negativeCount,
      );
      if (!batchByOrientation) return false;
      plan.batchByOrientation = batchByOrientation;
    }

    for (const plan of plans) {
      const positiveBatch = plan.batchByOrientation[1];
      const negativeBatch = plan.batchByOrientation[-1];
      const positiveBuffer = positiveBatch
        ? acquireFloatBuffer(positiveBatch.matrixBuffer, plan.positiveCount * 16)
        : null;
      const negativeBuffer = negativeBatch
        ? acquireFloatBuffer(negativeBatch.matrixBuffer, plan.negativeCount * 16)
        : null;
      let positiveOffset = 0;
      let negativeOffset = 0;

      for (const offset of offsets) {
        for (const sourceMatrix of plan.sourceMatrices) {
          if (sourceMatrix.orientation > 0) {
            sourceMatrix.matrix.copyToArray(positiveBuffer!, positiveOffset);
            positiveBuffer![positiveOffset + 12] += offset.x;
            positiveBuffer![positiveOffset + 13] += offset.y;
            positiveBuffer![positiveOffset + 14] += offset.z;
            positiveOffset += 16;
            continue;
          }

          sourceMatrix.matrix.copyToArray(negativeBuffer!, negativeOffset);
          negativeBuffer![negativeOffset + 12] += offset.x;
          negativeBuffer![negativeOffset + 13] += offset.y;
          negativeBuffer![negativeOffset + 14] += offset.z;
          // Babylon 只按批次 Mesh 的世界矩阵修正 winding；把固定 X 镜像放到 Mesh，
          // thinInstance 左乘逆镜像后仍得到完全相同的最终世界矩阵。
          applyNegativeOrientationCarrierToBuffer(negativeBuffer!, negativeOffset);
          negativeOffset += 16;
        }
      }

      if (positiveBatch && positiveBuffer) {
        positiveBatch.entityIndexBuffer = null;
        positiveBatch.entityInstanceRangeStarts = null;
        positiveBatch.entityInstanceRangeCounts = null;
        commitMatrixBuffer(positiveBatch, positiveBuffer, plan.positiveCount, this.interactive);
        applyBatchInteractionState(positiveBatch, true, this.interactive);
      }
      if (negativeBatch && negativeBuffer) {
        negativeBatch.entityIndexBuffer = null;
        negativeBatch.entityInstanceRangeStarts = null;
        negativeBatch.entityInstanceRangeCounts = null;
        commitMatrixBuffer(negativeBatch, negativeBuffer, plan.negativeCount, this.interactive);
        applyBatchInteractionState(negativeBatch, true, this.interactive);
      }
      this.deactivateUnusedBatches(plan.source, new Set(Object.values(plan.batchByOrientation)));
    }

    this.entityIds = [];
    this.entityIndexById.clear();
    this.pickableEntityIds.clear();
    this.selectedEntityIds.clear();
    this.selectionId = 0;
    this.entityLayoutRevision += 1;
    this.selectionLayoutRevision = -1;
    return true;
  }

  /**
   * 将 N 个独立模型实体的完整 Transform 一次性组合为连续矩阵缓冲。
   * sourceRootWorldMatrix 用于把源 Mesh 世界矩阵还原到模型根局部空间，再应用每个逻辑实体的世界 Transform。
   */
  updateEntityTransforms(
    sourceRootWorldMatrix: Matrix,
    instances: readonly EntityArrayThinInstanceTransform[],
  ): boolean {
    if (!isFiniteMatrix(sourceRootWorldMatrix) || instances.some((instance) => (
      !instance.entityId || !isFiniteTransform(instance.transform)
    ))) {
      return false;
    }

    const inverseSourceRoot = sourceRootWorldMatrix.clone();
    const determinant = inverseSourceRoot.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) <= ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON) {
      return false;
    }
    inverseSourceRoot.invert();

    const entityMatrices = instances.map((instance) => {
      const matrix = createTransformMatrix(instance.transform);
      const orientation = getMatrixOrientation(matrix);
      return orientation ? { matrix, orientation } : null;
    });
    if (entityMatrices.some((entry) => entry === null)) return false;
    const capturedEntityMatrices = entityMatrices as CapturedEntityArrayMatrix[];
    const positiveEntityCount = capturedEntityMatrices.filter((entry) => entry.orientation > 0).length;
    const negativeEntityCount = capturedEntityMatrices.length - positiveEntityCount;

    const plans: Array<{
      source: EntityArrayMatrixSource;
      sourceMatrices: CapturedEntityArrayMatrix[];
      positiveCount: number;
      negativeCount: number;
      batchByOrientation: Partial<Record<EntityArrayMatrixOrientation, EntityArrayMatrixBatch>>;
    }> = [];
    let totalInstanceCount = 0;
    for (const source of this.sources) {
      const sourceRelativeMatrices = source.rootLocalGeometryBaked
        ? [Matrix.Identity()]
        : captureSourceWorldMatrices(source.sourceMesh).map((matrix) => matrix.multiply(inverseSourceRoot));
      if (sourceRelativeMatrices.length === 0) return false;
      const sourceMatrices = captureMatrixOrientations(sourceRelativeMatrices);
      if (!sourceMatrices) return false;

      const positiveSourceCount = sourceMatrices.filter((entry) => entry.orientation > 0).length;
      const negativeSourceCount = sourceMatrices.length - positiveSourceCount;
      const positiveCount = positiveSourceCount * positiveEntityCount
        + negativeSourceCount * negativeEntityCount;
      const negativeCount = positiveSourceCount * negativeEntityCount
        + negativeSourceCount * positiveEntityCount;
      totalInstanceCount += positiveCount + negativeCount;
      if (!Number.isSafeInteger(totalInstanceCount) || totalInstanceCount > ENTITY_ARRAY_MATRIX_INSTANCE_LIMIT) {
        return false;
      }
      plans.push({
        source,
        sourceMatrices,
        positiveCount,
        negativeCount,
        batchByOrientation: {},
      });
    }

    for (const plan of plans) {
      const batchByOrientation = this.prepareOrientationBatches(
        plan.source,
        plan.positiveCount,
        plan.negativeCount,
      );
      if (!batchByOrientation) return false;
      plan.batchByOrientation = batchByOrientation;
    }

    const hasPickableEntity = instances.some((instance) => instance.pickable);
    const scratchWorldMatrix = new Matrix();
    for (const plan of plans) {
      const positiveBatch = plan.batchByOrientation[1];
      const negativeBatch = plan.batchByOrientation[-1];
      const positiveBuffer = positiveBatch
        ? acquireFloatBuffer(positiveBatch.matrixBuffer, plan.positiveCount * 16)
        : null;
      const negativeBuffer = negativeBatch
        ? acquireFloatBuffer(negativeBatch.matrixBuffer, plan.negativeCount * 16)
        : null;
      const positiveEntityIndexes = positiveBatch
        ? acquireEntityIndexBuffer(positiveBatch.entityIndexBuffer, plan.positiveCount)
        : null;
      const negativeEntityIndexes = negativeBatch
        ? acquireEntityIndexBuffer(negativeBatch.entityIndexBuffer, plan.negativeCount)
        : null;
      const positiveEntityRangeStarts = positiveBatch ? createEntityRangeStarts(instances.length) : null;
      const positiveEntityRangeCounts = positiveBatch ? new Uint32Array(instances.length) : null;
      const negativeEntityRangeStarts = negativeBatch ? createEntityRangeStarts(instances.length) : null;
      const negativeEntityRangeCounts = negativeBatch ? new Uint32Array(instances.length) : null;
      let positiveMatrixOffset = 0;
      let negativeMatrixOffset = 0;
      let positiveInstanceIndex = 0;
      let negativeInstanceIndex = 0;

      for (let entityIndex = 0; entityIndex < capturedEntityMatrices.length; entityIndex += 1) {
        const entityMatrix = capturedEntityMatrices[entityIndex];
        for (const sourceMatrix of plan.sourceMatrices) {
          sourceMatrix.matrix.multiplyToRef(entityMatrix.matrix, scratchWorldMatrix);
          const orientation = sourceMatrix.orientation === entityMatrix.orientation ? 1 : -1;
          if (orientation > 0) {
            scratchWorldMatrix.copyToArray(positiveBuffer!, positiveMatrixOffset);
            positiveEntityIndexes![positiveInstanceIndex] = entityIndex;
            appendEntityInstanceRange(
              positiveEntityRangeStarts!,
              positiveEntityRangeCounts!,
              entityIndex,
              positiveInstanceIndex,
            );
            positiveMatrixOffset += 16;
            positiveInstanceIndex += 1;
            continue;
          }

          scratchWorldMatrix.copyToArray(negativeBuffer!, negativeMatrixOffset);
          applyNegativeOrientationCarrierToBuffer(negativeBuffer!, negativeMatrixOffset);
          negativeEntityIndexes![negativeInstanceIndex] = entityIndex;
          appendEntityInstanceRange(
            negativeEntityRangeStarts!,
            negativeEntityRangeCounts!,
            entityIndex,
            negativeInstanceIndex,
          );
          negativeMatrixOffset += 16;
          negativeInstanceIndex += 1;
        }
      }

      if (
        positiveBatch
        && positiveBuffer
        && positiveEntityIndexes
        && positiveEntityRangeStarts
        && positiveEntityRangeCounts
      ) {
        positiveBatch.entityIndexBuffer = positiveEntityIndexes;
        positiveBatch.entityInstanceRangeStarts = positiveEntityRangeStarts;
        positiveBatch.entityInstanceRangeCounts = positiveEntityRangeCounts;
        commitMatrixBuffer(positiveBatch, positiveBuffer, plan.positiveCount, true);
        applyBatchInteractionState(positiveBatch, true, hasPickableEntity);
      }
      if (
        negativeBatch
        && negativeBuffer
        && negativeEntityIndexes
        && negativeEntityRangeStarts
        && negativeEntityRangeCounts
      ) {
        negativeBatch.entityIndexBuffer = negativeEntityIndexes;
        negativeBatch.entityInstanceRangeStarts = negativeEntityRangeStarts;
        negativeBatch.entityInstanceRangeCounts = negativeEntityRangeCounts;
        commitMatrixBuffer(negativeBatch, negativeBuffer, plan.negativeCount, true);
        applyBatchInteractionState(negativeBatch, true, hasPickableEntity);
      }
      this.deactivateUnusedBatches(plan.source, new Set(Object.values(plan.batchByOrientation)));
    }

    this.entityIds = instances.map((instance) => instance.entityId);
    this.entityIndexById.clear();
    for (let entityIndex = 0; entityIndex < this.entityIds.length; entityIndex += 1) {
      this.entityIndexById.set(this.entityIds[entityIndex], entityIndex);
    }
    this.pickableEntityIds = new Set(
      instances.filter((instance) => instance.pickable).map((instance) => instance.entityId),
    );
    this.entityLayoutRevision += 1;
    return true;
  }

  /** 为一个源 Mesh 准备当前实际需要的正/负方向批次；仅在混合方向时增加第二个固定批次。 */
  private prepareOrientationBatches(
    source: EntityArrayMatrixSource,
    positiveCount: number,
    negativeCount: number,
  ): Partial<Record<EntityArrayMatrixOrientation, EntityArrayMatrixBatch>> | null {
    if (positiveCount <= 0 && negativeCount <= 0) return {};

    const primaryBatch = source.batches[0];
    if (positiveCount <= 0 || negativeCount <= 0) {
      const orientation: EntityArrayMatrixOrientation = negativeCount > 0 ? -1 : 1;
      applyBatchOrientation(primaryBatch, orientation);
      return { [orientation]: primaryBatch };
    }

    applyBatchOrientation(primaryBatch, 1);
    let negativeBatch = source.batches[1];
    if (!negativeBatch) {
      try {
        negativeBatch = createMatrixBatch(source, -1, this.interactive, true);
      } catch (error) {
        console.warn('创建模型阵列负方向矩阵批次失败。', error);
        return null;
      }
      source.batches.push(negativeBatch);
      this.batches.push(negativeBatch);
      this.meshes.push(negativeBatch.mesh);
      this.batchByMeshUniqueId.set(negativeBatch.mesh.uniqueId, negativeBatch);
    } else {
      applyBatchOrientation(negativeBatch, -1);
    }

    return { 1: primaryBatch, [-1]: negativeBatch };
  }

  /** 禁用当前方向不再使用的批次，但保留缓冲以供后续 Transform 改变时复用。 */
  private deactivateUnusedBatches(
    source: EntityArrayMatrixSource,
    activeBatches: ReadonlySet<EntityArrayMatrixBatch>,
  ): void {
    for (const batch of source.batches) {
      if (activeBatches.has(batch)) continue;
      batch.mesh.thinInstanceCount = 0;
      batch.entityIndexBuffer = null;
      batch.entityInstanceRangeStarts = null;
      batch.entityInstanceRangeCounts = null;
      applyBatchInteractionState(batch, false, false);
    }
  }

  /** 根据批次 Mesh 和 Babylon thinInstanceIndex 还原具体逻辑实体 ID。 */
  getEntityIdForThinInstance(mesh: AbstractMesh, thinInstanceIndex: number): string | null {
    const batch = this.batchByMeshUniqueId.get(mesh.uniqueId);
    if (
      !batch
      || !Number.isInteger(thinInstanceIndex)
      || thinInstanceIndex < 0
      || thinInstanceIndex >= batch.mesh.thinInstanceCount
      || !batch.entityIndexBuffer
    ) {
      return null;
    }

    return this.entityIds[batch.entityIndexBuffer[thinInstanceIndex]] ?? null;
  }

  /** 返回当前矩阵顺序对应的可见逻辑实体 ID，供选择描边和参数变体映射复用。 */
  getEntityIds(): readonly string[] {
    return this.entityIds;
  }

  /** 判断当前批次是否至少有一个可拾取逻辑实体。 */
  hasPickableEntities(): boolean {
    return this.pickableEntityIds.size > 0;
  }

  /**
   * 给 SelectionOutlineLayer 覆盖逐 thinInstance 的选择 ID。
   * 布局未变化时只改写前后选区涉及的连续实例区间，不再为一次单选扫描整个批次。
   */
  setSelectionMask(selectedEntityIds: ReadonlySet<string>, selectionId: number): void {
    const nextSelectedEntityIds = new Set(selectedEntityIds);
    const changedEntityIds = new Set<string>();
    for (const entityId of this.selectedEntityIds) {
      if (!nextSelectedEntityIds.has(entityId)) changedEntityIds.add(entityId);
    }
    for (const entityId of nextSelectedEntityIds) {
      if (!this.selectedEntityIds.has(entityId)) changedEntityIds.add(entityId);
    }

    const nextSelectionId = Number.isFinite(selectionId) ? selectionId : 0;
    const layoutChanged = this.selectionLayoutRevision !== this.entityLayoutRevision;
    const selectionIdChanged = this.selectionId !== nextSelectionId;
    if (!layoutChanged && !selectionIdChanged && changedEntityIds.size === 0) return;

    for (const batch of this.batches) {
      const instanceCount = batch.mesh.thinInstanceCount;
      if (instanceCount <= 0) continue;

      const previousSelectionBuffer = batch.selectionBuffer;
      const selectionBuffer = acquireFloatBuffer(previousSelectionBuffer, instanceCount);
      const bufferReplaced = selectionBuffer !== previousSelectionBuffer;
      const rangeStarts = batch.entityInstanceRangeStarts;
      const rangeCounts = batch.entityInstanceRangeCounts;

      if (layoutChanged || bufferReplaced) {
        selectionBuffer.fill(0);
        if (rangeStarts && rangeCounts) {
          for (const entityId of nextSelectedEntityIds) {
            writeSelectionRange(
              selectionBuffer,
              this.entityIndexById.get(entityId),
              rangeStarts,
              rangeCounts,
              nextSelectionId,
            );
          }
        }
      } else if (rangeStarts && rangeCounts) {
        for (const entityId of changedEntityIds) {
          writeSelectionRange(
            selectionBuffer,
            this.entityIndexById.get(entityId),
            rangeStarts,
            rangeCounts,
            nextSelectedEntityIds.has(entityId) ? nextSelectionId : 0,
          );
        }
        if (selectionIdChanged) {
          for (const entityId of nextSelectedEntityIds) {
            writeSelectionRange(
              selectionBuffer,
              this.entityIndexById.get(entityId),
              rangeStarts,
              rangeCounts,
              nextSelectionId,
            );
          }
        }
      } else {
        selectionBuffer.fill(0);
      }

      if (bufferReplaced) {
        batch.mesh.thinInstanceSetBuffer(INSTANCE_SELECTION_ID_BUFFER, selectionBuffer, 1, false);
      } else {
        batch.mesh.thinInstanceBufferUpdated(INSTANCE_SELECTION_ID_BUFFER);
      }
      batch.selectionBuffer = selectionBuffer;
    }

    this.selectedEntityIds = nextSelectedEntityIds;
    this.selectionId = nextSelectionId;
    this.selectionLayoutRevision = this.entityLayoutRevision;
  }


  /** 同步整体显隐和拾取状态，主要供临时预览及兼容调用使用。 */
  setInteractionState(visible: boolean, pickable: boolean): void {
    for (const batch of this.batches) {
      applyBatchInteractionState(batch, visible, pickable && this.interactive);
    }
  }

  /** 只释放批次自身的隔离 Geometry，保留源材质、纹理、骨骼和源模型节点。 */
  dispose(): void {
    disposeBatches(this.batches);
    this.batches.length = 0;
    this.sources.length = 0;
    this.meshes.length = 0;
    this.previewOffsets.length = 0;
    this.batchByMeshUniqueId.clear();
    this.entityIds = [];
    this.entityIndexById.clear();
    this.pickableEntityIds.clear();
    this.selectedEntityIds.clear();
    this.selectionId = 0;
    this.entityLayoutRevision = 0;
    this.selectionLayoutRevision = -1;
  }
}

/**
 * 把同材质静态叶 Mesh 合并为源根局部 Geometry。
 * 透明、骨骼、Morph、动态顶点动画、复杂 SubMesh 和已有内部 thinInstance 保持原批次路径。
 */
function mergeStaticCandidatesByMaterial(
  candidates: readonly EntityArrayMatrixCandidate[],
  sourceRootWorldMatrix: Matrix,
): EntityArrayMatrixCandidate[] {
  if (!isFiniteMatrix(sourceRootWorldMatrix)) return [...candidates];
  const rootDeterminant = sourceRootWorldMatrix.determinant();
  if (!Number.isFinite(rootDeterminant) || Math.abs(rootDeterminant) <= ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON) {
    return [...candidates];
  }

  const inverseSourceRoot = sourceRootWorldMatrix.clone();
  inverseSourceRoot.invert();
  const grouped = new Map<string, EntityArrayMatrixCandidate[]>();
  const output: EntityArrayMatrixCandidate[] = [];
  const materialSignatureCache = new Map<Material, string | null>();

  for (const candidate of candidates) {
    const key = createStaticMergeKey(candidate, materialSignatureCache);
    if (!key) {
      output.push(candidate);
      continue;
    }
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    let chunk: EntityArrayMatrixCandidate[] = [];
    let chunkVertices = 0;
    let chunkIndices = 0;
    const flush = (): void => {
      if (chunk.length < 2) {
        output.push(...chunk);
      } else {
        const merged = createMergedStaticCandidate(chunk, sourceRootWorldMatrix, inverseSourceRoot);
        if (merged) output.push(merged);
        else output.push(...chunk);
      }
      chunk = [];
      chunkVertices = 0;
      chunkIndices = 0;
    };

    for (const candidate of group) {
      const vertexCount = candidate.batchSource.getTotalVertices();
      const indexCount = candidate.batchSource.getTotalIndices();
      if (vertexCount > STATIC_MERGE_MAX_VERTICES || indexCount > STATIC_MERGE_MAX_INDICES) {
        flush();
        output.push(candidate);
        continue;
      }
      if (
        chunk.length > 0
        && (
          chunkVertices + vertexCount > STATIC_MERGE_MAX_VERTICES
          || chunkIndices + indexCount > STATIC_MERGE_MAX_INDICES
        )
      ) {
        flush();
      }
      chunk.push(candidate);
      chunkVertices += vertexCount;
      chunkIndices += indexCount;
    }
    flush();
  }

  return output.sort((left, right) => left.meshIndex - right.meshIndex);
}

/** 返回只有视觉状态完全兼容时才相同的静态合并键。 */
function createStaticMergeKey(
  candidate: EntityArrayMatrixCandidate,
  materialSignatureCache: Map<Material, string | null>,
): string | null {
  const { sourceMesh, batchSource } = candidate;
  if (getSourceMatrixCount(sourceMesh) !== 1) return null;
  if (batchSource.getClassName() !== 'Mesh' || batchSource.subMeshes.length !== 1) return null;
  if (!batchSource.geometry) return null;
  const totalVertices = batchSource.getTotalVertices();
  const totalIndices = batchSource.getTotalIndices();
  const subMesh = batchSource.subMeshes[0];
  if (
    subMesh.verticesStart !== 0
    || subMesh.verticesCount !== totalVertices
    || (totalIndices > 0 && (subMesh.indexStart !== 0 || subMesh.indexCount !== totalIndices))
  ) {
    return null;
  }
  if (totalIndices <= 0 && totalVertices % 3 !== 0) return null;
  const vertexKinds = batchSource.getVerticesDataKinds().slice().sort();
  if (vertexKinds.some((kind) => !STATIC_MERGE_VERTEX_KINDS.has(kind))) return null;
  if (sourceMesh.skeleton || sourceMesh.morphTargetManager || sourceMesh.bakedVertexAnimationManager) return null;
  if (sourceMesh.billboardMode !== 0 || sourceMesh.infiniteDistance) return null;

  const material = sourceMesh.material;
  try {
    if (material?.needAlphaBlendingForMesh(sourceMesh)) return null;
  } catch {
    return null;
  }
  const materialSignature = material
    ? getMaterialAppearanceSignature(material, materialSignatureCache)
    : 'none';
  if (!materialSignature) return null;

  return [
    materialSignature,
    candidate.layerMask ?? sourceMesh.layerMask,
    sourceMesh.renderingGroupId,
    sourceMesh.alphaIndex,
    sourceMesh.visibility,
    sourceMesh.isVisible ? 1 : 0,
    sourceMesh.isEnabled(false) ? 1 : 0,
    sourceMesh.receiveShadows ? 1 : 0,
    sourceMesh.hasVertexAlpha ? 1 : 0,
    sourceMesh.useVertexColors ? 1 : 0,
    sourceMesh.applyFog ? 1 : 0,
    batchSource.sideOrientation,
    batchSource.overrideRenderingFillMode ?? -1,
    material?.sideOrientation ?? -1,
    batchSource.getTotalIndices() > 0 ? 'indexed' : 'unindexed',
    vertexKinds.join(','),
  ].join('|');
}

/** 仅对无动态绑定的标准/PBR 材质生成有界视觉签名，避免序列化 GLB 内嵌纹理拖慢场景加载。 */
function getMaterialAppearanceSignature(
  material: Material,
  cache: Map<Material, string | null>,
): string | null {
  if (cache.has(material)) return cache.get(material) ?? null;
  if ((material.animations?.length ?? 0) > 0 || material.onBindObservable.hasObservers() || material.stencil.enabled) {
    cache.set(material, null);
    return null;
  }
  const textures = material.getActiveTextures();
  if (textures.some((texture) => (
    texture.isRenderTarget
    || (texture.animations?.length ?? 0) > 0
    || !['Texture', 'CubeTexture'].includes(texture.getClassName())
  ))) {
    cache.set(material, null);
    return null;
  }

  const materialBase = material as Material & {
    textureRepetitionMode?: number;
    textureRepetitionHexTilingParams?: unknown;
  };
  const base = [
    normalizeMaterialAppearanceName(material.name),
    material.alpha,
    material.backFaceCulling,
    material.cullBackFaces,
    material.sideOrientation,
    material.alphaMode,
    material.needDepthPrePass,
    material.disableDepthWrite,
    material.disableColorWrite,
    material.forceDepthWrite,
    material.depthFunction,
    material.separateCullingPass,
    material.fogEnabled,
    material.pointSize,
    material.zOffset,
    material.zOffsetUnits,
    material.pointsCloud,
    material.fillMode,
    materialBase.textureRepetitionMode ?? null,
    materialBase.textureRepetitionHexTilingParams ?? null,
    ...textures.map(createTextureAppearanceSignature),
  ];
  let signature: string | null = null;

  if (material instanceof PBRMaterial) {
    if (
      material.clearCoat.isEnabled
      || material.anisotropy.isEnabled
      || material.sheen.isEnabled
      || material.iridescence.isEnabled
      || material.detailMap.isEnabled
      || material.subSurface.isRefractionEnabled
      || material.subSurface.isTranslucencyEnabled
      || material.subSurface.isScatteringEnabled
    ) {
      cache.set(material, null);
      return null;
    }
    signature = JSON.stringify([
      'PBRMaterial',
      ...base,
      material.albedoColor.asArray(),
      material.ambientColor.asArray(),
      material.reflectivityColor.asArray(),
      material.reflectionColor.asArray(),
      material.emissiveColor.asArray(),
      material.metallicReflectanceColor.asArray(),
      material.metallic,
      material.roughness,
      material.microSurface,
      material.indexOfRefraction,
      material.directIntensity,
      material.emissiveIntensity,
      material.environmentIntensity,
      material.specularIntensity,
      material.metallicF0Factor,
      material.baseWeight,
      material.ambientTextureStrength,
      material.ambientTextureImpactOnAnalyticalLights,
      material.transparencyMode,
      material.disableBumpMap,
      material.disableLighting,
      material.maxSimultaneousLights,
      material.twoSidedLighting,
      material.invertNormalMapX,
      material.invertNormalMapY,
      material.forceNormalForward,
      material.unlit,
      material.useAlphaFromAlbedoTexture,
      material.forceAlphaTest,
      material.alphaCutOff,
      material.useSpecularOverAlpha,
      material.useRoughnessFromMetallicTextureAlpha,
      material.useRoughnessFromMetallicTextureGreen,
      material.useMetallnessFromMetallicTextureBlue,
      material.useAmbientOcclusionFromMetallicTextureRed,
      material.useOnlyMetallicFromMetallicReflectanceTexture,
      material.useLightmapAsShadowmap,
      material.useMicroSurfaceFromReflectivityMapAlpha,
      material.useAmbientInGrayScale,
      material.useAutoMicroSurfaceFromReflectivityMap,
      material.usePhysicalLightFalloff,
      material.useGLTFLightFalloff,
      material.useRadianceOverAlpha,
      material.useObjectSpaceNormalMap,
      material.useParallax,
      material.useParallaxOcclusion,
      material.parallaxScaleBias,
      material.forceIrradianceInFragment,
      material.useAlphaFresnel,
      material.useLinearAlphaFresnel,
      material.enableSpecularAntiAliasing,
      material.useHorizonOcclusion,
      material.useRadianceOcclusion,
      material.applyDecalMapAfterDetailMap,
    ]);
  } else if (material instanceof StandardMaterial) {
    if (
      material.detailMap.isEnabled
      || material.diffuseFresnelParameters
      || material.opacityFresnelParameters
      || material.reflectionFresnelParameters
      || material.refractionFresnelParameters
      || material.emissiveFresnelParameters
    ) {
      cache.set(material, null);
      return null;
    }
    signature = JSON.stringify([
      'StandardMaterial',
      ...base,
      material.diffuseColor.asArray(),
      material.ambientColor.asArray(),
      material.specularColor.asArray(),
      material.emissiveColor.asArray(),
      material.specularPower,
      material.roughness,
      material.indexOfRefraction,
      material.invertRefractionY,
      material.disableLighting,
      material.maxSimultaneousLights,
      material.twoSidedLighting,
      material.invertNormalMapX,
      material.invertNormalMapY,
      material.useAlphaFromDiffuseTexture,
      material.alphaCutOff,
      material.useEmissiveAsIllumination,
      material.linkEmissiveWithDiffuse,
      material.useSpecularOverAlpha,
      material.useReflectionOverAlpha,
      material.useObjectSpaceNormalMap,
      material.useParallax,
      material.useParallaxOcclusion,
      material.parallaxScaleBias,
      material.useLightmapAsShadowmap,
      material.useReflectionFresnelFromSpecular,
      material.useGlossinessFromSpecularMapAlpha,
      material.applyDecalMapAfterDetailMap,
    ]);
  }

  cache.set(material, signature);
  return signature;
}

/** 使用 URL、采样、UV 和纹理视觉状态生成有界签名，不依赖运行时 texture uniqueId。 */
function createTextureAppearanceSignature(
  texture: ReturnType<Material['getActiveTextures']>[number],
): string {
  const sampledTexture = texture as typeof texture & {
    url?: string | null;
    uOffset?: number;
    vOffset?: number;
    uScale?: number;
    vScale?: number;
    uAng?: number;
    vAng?: number;
    wAng?: number;
    uRotationCenter?: number;
    vRotationCenter?: number;
    wRotationCenter?: number;
    homogeneousRotationInUVTransform?: boolean;
    wrapR?: number;
    anisotropicFilteringLevel?: number;
    invertZ?: boolean;
    lodLevelInAlpha?: boolean;
    lodGenerationOffset?: number;
    lodGenerationScale?: number;
    linearSpecularLOD?: boolean;
    invertY?: boolean;
    samplingMode?: number;
    noMipmap?: boolean;
    optimizeUVAllocation?: boolean;
    isBlocking?: boolean;
    is3D?: boolean;
    is2DArray?: boolean;
    _useSRGBBuffer?: boolean;
  };
  return JSON.stringify([
    texture.getClassName(),
    texture.name,
    sampledTexture.url ?? null,
    texture.coordinatesIndex,
    texture.coordinatesMode,
    texture.level,
    sampledTexture.uOffset ?? 0,
    sampledTexture.vOffset ?? 0,
    sampledTexture.uScale ?? 1,
    sampledTexture.vScale ?? 1,
    sampledTexture.uAng ?? 0,
    sampledTexture.vAng ?? 0,
    sampledTexture.wAng ?? 0,
    sampledTexture.uRotationCenter ?? 0.5,
    sampledTexture.vRotationCenter ?? 0.5,
    sampledTexture.wRotationCenter ?? 0.5,
    sampledTexture.homogeneousRotationInUVTransform ?? false,
    texture.wrapU,
    texture.wrapV,
    sampledTexture.wrapR ?? 1,
    texture.hasAlpha,
    texture.getAlphaFromRGB,
    texture.gammaSpace,
    texture.isCube,
    sampledTexture.is3D ?? false,
    sampledTexture.is2DArray ?? false,
    sampledTexture.anisotropicFilteringLevel ?? 0,
    sampledTexture.invertZ ?? false,
    sampledTexture.lodLevelInAlpha ?? false,
    sampledTexture.lodGenerationOffset ?? 0,
    sampledTexture.lodGenerationScale ?? 0,
    sampledTexture.linearSpecularLOD ?? false,
    sampledTexture.invertY ?? false,
    sampledTexture.samplingMode ?? null,
    sampledTexture.noMipmap ?? false,
    sampledTexture.optimizeUVAllocation ?? true,
    sampledTexture.isBlocking ?? true,
    sampledTexture._useSRGBBuffer ?? false,
  ]);
}

/** GLB 导入和参数脚本会给等价克隆追加运行时序号；只移除这些已知非视觉后缀。 */
function normalizeMaterialAppearanceName(name: string): string {
  return name
    .replace(/_(?:chain|gd|hcts|wlts)_\d+$/i, '')
    .replace(/_parametric_\d+$/i, '');
}

/** 提取独立 VertexData，应用正确的世界到源根局部变换，再合并为单材质 Geometry。 */
function createMergedStaticCandidate(
  candidates: readonly EntityArrayMatrixCandidate[],
  sourceRootWorldMatrix: Matrix,
  inverseSourceRoot: Matrix,
): EntityArrayMatrixCandidate | null {
  const vertexDatas: VertexData[] = [];
  try {
    for (const candidate of candidates) {
      const vertexData = VertexData.ExtractFromMesh(candidate.batchSource, true, true);
      if (!vertexData.positions || vertexData.positions.length === 0) return null;
      candidate.sourceMesh.computeWorldMatrix(true);
      const rootLocalMatrix = candidate.sourceMesh.getWorldMatrix().multiply(inverseSourceRoot);
      if (!transformVertexDataPreservingNormals(vertexData, rootLocalMatrix)) return null;
      vertexDatas.push(vertexData);
    }

    const merged = vertexDatas[0];
    if (!merged) return null;
    if (vertexDatas.length > 1) merged.merge(vertexDatas.slice(1), true, false, false, false);
    const representative = candidates[0];
    return {
      ...representative,
      meshIndex: Math.min(...candidates.map((candidate) => candidate.meshIndex)),
      rootLocalVertexData: merged,
      rootLocalGeometryBaked: true,
      sourceRootWorldMatrix: sourceRootWorldMatrix.clone(),
    };
  } catch (error) {
    console.warn('合并模型阵列静态 Geometry 失败，已回退逐 Mesh 批次。', error);
    return null;
  }
}

/** VertexData.transform 对非均匀缩放直接变换法线；这里用逆转置矩阵恢复正确光照。 */
function transformVertexDataPreservingNormals(vertexData: VertexData, matrix: Matrix): boolean {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON) return false;

  const sourceNormals = vertexData.normals ? Float32Array.from(vertexData.normals) : null;
  const sourceTangents = vertexData.tangents ? Float32Array.from(vertexData.tangents) : null;
  vertexData.transform(matrix);

  const normalMatrix = matrix.clone();
  normalMatrix.invert();
  normalMatrix.transpose();
  const transformed = new Vector3();

  if (sourceNormals && vertexData.normals) {
    for (let offset = 0; offset < sourceNormals.length; offset += 3) {
      Vector3.TransformNormalFromFloatsToRef(
        sourceNormals[offset],
        sourceNormals[offset + 1],
        sourceNormals[offset + 2],
        normalMatrix,
        transformed,
      );
      transformed.normalize();
      vertexData.normals[offset] = transformed.x;
      vertexData.normals[offset + 1] = transformed.y;
      vertexData.normals[offset + 2] = transformed.z;
    }
  }

  if (sourceTangents && vertexData.tangents) {
    const handedness = determinant < 0 ? -1 : 1;
    for (let offset = 0; offset < sourceTangents.length; offset += 4) {
      // 切线是表面方向，必须走线性模型矩阵；只有法线使用逆转置矩阵。
      Vector3.TransformNormalFromFloatsToRef(
        sourceTangents[offset],
        sourceTangents[offset + 1],
        sourceTangents[offset + 2],
        matrix,
        transformed,
      );
      transformed.normalize();
      vertexData.tangents[offset] = transformed.x;
      vertexData.tangents[offset + 1] = transformed.y;
      vertexData.tangents[offset + 2] = transformed.z;
      vertexData.tangents[offset + 3] = sourceTangents[offset + 3] * handedness;
    }
  }
  if (determinant < 0 && !vertexData.indices && !flipUnindexedTriangleFaces(vertexData)) return false;
  return true;
}

/** 为普通 Mesh 或 InstancedMesh 找到可克隆的几何源。 */
/** 反射变换下无索引三角形没有 index buffer 可翻面，必须交换每个三角形的后两个顶点。 */
function flipUnindexedTriangleFaces(vertexData: VertexData): boolean {
  const vertexCount = (vertexData.positions?.length ?? 0) / 3;
  if (!Number.isInteger(vertexCount) || vertexCount % 3 !== 0) return false;
  for (let vertex = 0; vertex < vertexCount; vertex += 3) {
    swapVertexAttribute(vertexData.positions, 3, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.normals, 3, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.tangents, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.colors, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs2, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs3, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs4, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs5, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs6, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesIndices, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesWeights, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesIndicesExtra, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesWeightsExtra, 4, vertex + 1, vertex + 2);
  }
  return true;
}

function swapVertexAttribute(
  values: { length: number; [index: number]: number } | null | undefined,
  stride: number,
  leftVertex: number,
  rightVertex: number,
): void {
  if (!values) return;
  const leftOffset = leftVertex * stride;
  const rightOffset = rightVertex * stride;
  for (let component = 0; component < stride; component += 1) {
    const value = values[leftOffset + component];
    values[leftOffset + component] = values[rightOffset + component];
    values[rightOffset + component] = value;
  }
}

function resolveBatchSourceMesh(mesh: AbstractMesh): Mesh | null {
  if (mesh instanceof Mesh) return mesh;
  if (!mesh.isAnInstance) return null;
  return (mesh as InstancedMesh).sourceMesh ?? null;
}

/** 读取源 Mesh 当前真正参与渲染的矩阵数量。 */
function getSourceMatrixCount(mesh: AbstractMesh): number {
  return mesh instanceof Mesh && mesh.thinInstanceCount > 0 ? mesh.thinInstanceCount : 1;
}

/**
 * 捕获源 Mesh 当前真正参与渲染的世界矩阵。
 * 已有 thinInstance 时需先组合 Mesh 世界矩阵，把局部实例矩阵转换为最终世界矩阵。
 */
function captureSourceWorldMatrices(mesh: AbstractMesh): Matrix[] {
  mesh.computeWorldMatrix(true);
  const meshWorldMatrix = mesh.getWorldMatrix().clone();
  if (!(mesh instanceof Mesh) || mesh.thinInstanceCount <= 0) return [meshWorldMatrix];

  const thinInstanceMatrices = mesh.thinInstanceGetWorldMatrices();
  if (thinInstanceMatrices.length < mesh.thinInstanceCount) return [];
  return thinInstanceMatrices
    .slice(0, mesh.thinInstanceCount)
    .map((matrix) => matrix.multiply(meshWorldMatrix));
}

/** 捕获矩阵的 determinant 方向；退化矩阵继续按正方向提交，保持既有零缩放语义。 */
function captureMatrixOrientations(matrices: readonly Matrix[]): CapturedEntityArrayMatrix[] | null {
  if (matrices.length === 0) return null;
  const captured: CapturedEntityArrayMatrix[] = [];
  for (const matrix of matrices) {
    const orientation = getMatrixOrientation(matrix);
    if (!orientation) return null;
    captured.push({ matrix, orientation });
  }
  return captured;
}

/** 非有限 determinant 视为非法；接近零的退化矩阵不需要反面修正。 */
function getMatrixOrientation(matrix: Matrix): EntityArrayMatrixOrientation | null {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant)) return null;
  return determinant < -ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON ? -1 : 1;
}

/** 为同一个几何源创建固定数量批次中的一个 Mesh。 */
function createMatrixBatch(
  source: EntityArrayMatrixSource,
  orientation: EntityArrayMatrixOrientation,
  interactive: boolean,
  secondary: boolean,
): EntityArrayMatrixBatch {
  const batchName = `${source.namePrefix}_${source.entityId}_${source.meshIndex}${secondary ? '_negativeOrientation' : ''}`;
  let batchMesh: Mesh;
  if (source.rootLocalGeometryBaked) {
    if (secondary && source.batches[0]) {
      batchMesh = source.batches[0].mesh.clone(batchName, null, true);
      batchMesh.makeGeometryUnique();
    } else {
      const rootLocalVertexData = source.rootLocalVertexData;
      if (!rootLocalVertexData) throw new Error('静态合并 Geometry 已释放，无法重复创建主批次。');
      batchMesh = new Mesh(batchName, source.batchSource.getScene());
      rootLocalVertexData.applyToMesh(batchMesh, false);
      // GPU Geometry 已创建后释放大数组引用；负方向批次后续直接克隆主批次。
      source.rootLocalVertexData = null;
    }
  } else {
    batchMesh = source.batchSource.clone(batchName, null, true);
    // Babylon 将 thinInstance 的 world0-world3 顶点缓冲挂在 Geometry 上；若批次继续共享源 Geometry，
    // 同一几何的多个辊筒/克隆批次会互相覆盖矩阵缓冲，最终全部叠到最后一个位置。
    batchMesh.makeGeometryUnique();
  }
  const batch: EntityArrayMatrixBatch = {
    mesh: batchMesh,
    sourceMesh: source.sourceMesh,
    batchSource: source.batchSource,
    matrixBuffer: null,
    selectionBuffer: null,
    entityIndexBuffer: null,
    entityInstanceRangeStarts: null,
    entityInstanceRangeCounts: null,
    orientation,
    layerMask: source.layerMask,
  };
  prepareBatchMesh(batch, interactive, source.metadata);
  return batch;
}

/** 把几何源克隆重置为世界批次，并隔离源节点的行为与动画绑定。 */
function prepareBatchMesh(
  batch: EntityArrayMatrixBatch,
  interactive: boolean,
  metadata: Record<string, unknown> | null,
): void {
  const batchMesh = batch.mesh;
  batchMesh.unfreezeWorldMatrix();
  batchMesh.parent = null;
  batchMesh.position.setAll(0);
  batchMesh.rotation.setAll(0);
  batchMesh.rotationQuaternion = null;
  batchMesh.billboardMode = 0;
  batchMesh.infiniteDistance = false;
  batchMesh.setPivotMatrix(Matrix.Identity());
  batchMesh.setPreTransformMatrix(Matrix.Identity());
  applyBatchOrientation(batch, batch.orientation);

  batchMesh.thinInstanceSetBuffer('matrix', null);
  syncBatchSourcePresentation(batch);

  batchMesh.metadata = metadata ? { ...metadata } : null;
  batchMesh.actionManager = null;
  batchMesh.isPickable = interactive;
  batchMesh.thinInstanceEnablePicking = interactive;
  batchMesh.doNotSerialize = true;
  batchMesh.doNotSyncBoundingInfo = true;
  batchMesh.alwaysSelectAsActiveMesh = !interactive;
  batchMesh.setEnabled(false);
}

/**
 * Babylon 的材质正反面判断只读取批次 Mesh 世界矩阵，不读取逐 thinInstance determinant。
 * 负方向批次把固定 X 镜像放到 Mesh 世界矩阵，实例矩阵再乘逆镜像以保持最终世界姿态不变。
 */
function applyBatchOrientation(
  batch: EntityArrayMatrixBatch,
  orientation: EntityArrayMatrixOrientation,
): void {
  batch.orientation = orientation;
  batch.mesh.scaling.copyFromFloats(orientation, 1, 1);
  batch.mesh.computeWorldMatrix(true);
}

/** 让批次持续共享源 Mesh 的最终视觉资源，而不复制脚本或实体状态。 */
function syncBatchSourcePresentation(batch: EntityArrayMatrixBatch): void {
  const { mesh, sourceMesh, batchSource } = batch;
  const sourceMaterial = sourceMesh.material;
  const materialSideOrientation = sourceMaterial?.sideOrientation;
  mesh.sideOrientation = batchSource.sideOrientation;
  if (mesh.material !== sourceMaterial) mesh.material = sourceMaterial;
  // Mesh.material setter 可能根据批次 Mesh 的坐标系提示改写共享材质，必须恢复源材质原值。
  if (sourceMaterial && sourceMaterial.sideOrientation !== materialSideOrientation) {
    sourceMaterial.sideOrientation = materialSideOrientation ?? null;
  }
  mesh.overrideRenderingFillMode = batchSource.overrideRenderingFillMode;
  mesh.skeleton = sourceMesh.skeleton;
  mesh.morphTargetManager = sourceMesh.morphTargetManager;
  mesh.bakedVertexAnimationManager = sourceMesh.bakedVertexAnimationManager;
  mesh.visibility = sourceMesh.visibility;
  mesh.renderingGroupId = sourceMesh.renderingGroupId;
  mesh.alphaIndex = sourceMesh.alphaIndex;
  mesh.layerMask = batch.layerMask ?? sourceMesh.layerMask;
  mesh.receiveShadows = sourceMesh.receiveShadows;
  mesh.hasVertexAlpha = sourceMesh.hasVertexAlpha;
  mesh.useVertexColors = sourceMesh.useVertexColors;
  mesh.computeBonesUsingShaders = sourceMesh.computeBonesUsingShaders;
  mesh.numBoneInfluencers = sourceMesh.numBoneInfluencers;
  mesh.applyFog = sourceMesh.applyFog;
}

/** 一次注册或更新矩阵缓冲，并按需刷新正式阵列整体包围盒。 */
function commitMatrixBuffer(
  batch: EntityArrayMatrixBatch,
  matrixBuffer: Float32Array,
  instanceCount: number,
  refreshBoundingInfo: boolean,
): void {
  if (matrixBuffer !== batch.matrixBuffer) {
    batch.mesh.thinInstanceSetBuffer('matrix', matrixBuffer, 16, false);
    batch.matrixBuffer = matrixBuffer;
  } else {
    batch.mesh.thinInstanceBufferUpdated('matrix');
  }
  batch.mesh.thinInstanceCount = instanceCount;
  syncBatchSourcePresentation(batch);
  if (refreshBoundingInfo) batch.mesh.thinInstanceRefreshBoundingInfo(true);
}

/** 批次不继承源实体根节点的 enabled 状态，使各逻辑实例可以独立显隐。 */
function applyBatchInteractionState(
  batch: EntityArrayMatrixBatch,
  visible: boolean,
  pickable: boolean,
): void {
  syncBatchSourcePresentation(batch);
  const effectiveVisible = visible
    && batch.sourceMesh.isEnabled(false)
    && batch.sourceMesh.isVisible
    && batch.sourceMesh.visibility > 0;
  batch.mesh.isVisible = effectiveVisible;
  batch.mesh.setEnabled(effectiveVisible);
  batch.mesh.isPickable = effectiveVisible && pickable;
  batch.mesh.thinInstanceEnablePicking = effectiveVisible && pickable;
}

function acquireFloatBuffer(current: Float32Array | null, length: number): Float32Array {
  return current?.length === length ? current : new Float32Array(length);
}

/** 左乘固定 X 镜像只需反转矩阵第一行，避免为每个实例再执行一次完整 4x4 乘法。 */
function applyNegativeOrientationCarrierToBuffer(buffer: Float32Array, offset: number): void {
  buffer[offset] = -buffer[offset];
  buffer[offset + 4] = -buffer[offset + 4];
  buffer[offset + 8] = -buffer[offset + 8];
  buffer[offset + 12] = -buffer[offset + 12];
}

function acquireEntityIndexBuffer(current: Uint32Array | null, length: number): Uint32Array {
  return current?.length === length ? current : new Uint32Array(length);
}

/** 使用 -1 标记当前方向批次中没有实例的逻辑实体。 */
function createEntityRangeStarts(entityCount: number): Int32Array {
  const starts = new Int32Array(entityCount);
  starts.fill(-1);
  return starts;
}

/** 以实体索引记录方向批次内的连续实例区间，避免为每个 Mesh 创建字符串 Map。 */
function appendEntityInstanceRange(
  starts: Int32Array,
  counts: Uint32Array,
  entityIndex: number,
  instanceIndex: number,
): void {
  if (starts[entityIndex] < 0) starts[entityIndex] = instanceIndex;
  counts[entityIndex] += 1;
}

/** 只改写目标逻辑实体对应的实例选择区间。 */
function writeSelectionRange(
  buffer: Float32Array,
  entityIndex: number | undefined,
  starts: Int32Array,
  counts: Uint32Array,
  selectionId: number,
): void {
  if (entityIndex === undefined) return;
  const start = starts[entityIndex];
  const count = counts[entityIndex];
  if (start < 0 || count <= 0) return;
  buffer.fill(selectionId, start, start + count);
}

function createTransformMatrix(transform: TransformComponent): Matrix {
  return Matrix.Compose(
    new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
    new Vector3(transform.position.x, transform.position.y, transform.position.z),
  );
}

function isFiniteVector3(vector: Vector3Data): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteTransform(transform: TransformComponent): boolean {
  return isFiniteVector3(transform.position) && isFiniteVector3(transform.rotation) && isFiniteVector3(transform.scale);
}

function isFiniteMatrix(matrix: Matrix): boolean {
  return matrix.m.every((value) => Number.isFinite(value));
}

/** 幂等释放已创建的矩阵批次。 */
function disposeBatches(batches: readonly EntityArrayMatrixBatch[]): void {
  for (const batch of batches) {
    if (batch.mesh.isDisposed()) continue;
    batch.mesh.thinInstanceSetBuffer(INSTANCE_SELECTION_ID_BUFFER, null);
    batch.mesh.thinInstanceSetBuffer('matrix', null);
    batch.mesh.dispose(false, false);
  }
}
