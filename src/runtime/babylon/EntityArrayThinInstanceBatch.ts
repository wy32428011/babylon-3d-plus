import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Observer, Plane, Scene } from '@babylonjs/core';
import type { Vector3Data } from '../../editor/model/math';
import { ENTITY_ARRAY_MATRIX_INSTANCE_LIMIT, ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON, INSTANCE_SELECTION_ID_BUFFER, type EntityArrayMatrixOrientation, type EntityArrayFrustumContainment, type EntityArrayMatrixBatch, type EntityArrayMatrixCandidate, type EntityArrayMatrixSource, type CapturedEntityArrayMatrix, type PreparedEntityArraySpatialPartitions, type EntityArrayTransformPreviewBatch, type EntityArrayTranslationPreviewBatch, type EntityArrayTranslationPreviewSession, type EntityArrayRotationPreviewBatch, type EntityArrayRotationPreviewSession, type EntityArrayThinInstanceBatchOptions, type EntityArrayThinInstanceTransform, type EntityArrayLightingInstance } from './thinInstanceBatchTypes';
import { groupRepeatedStaticGeometryCandidates, mergeStaticCandidatesByMaterial } from './thinInstanceStaticGeometry';
import { resolveBatchSourceMesh, getSourceMatrixCount, captureCandidateSourceWorldMatrices, captureSourceWorldMatrices, captureMatrixOrientations, getMatrixOrientation, createMatrixBatch, applyBatchOrientation, isCommittedBatchStateUnchanged, commitMatrixBuffer, applyBatchInteractionState, syncBatchEffectiveInteractionState, resolveFormalBatchMaxInstancesPerPartition, createSpatialMatrixPartitions, createEntityInstanceRanges, acquireIndependentFloatBuffer, acquireIndependentEntityIndexBuffer, acquireFloatBuffer, acquireDetachedFloatBuffer, acquireDetachedEntityIndexBuffer, resetInactiveBatchBuffers, applyNegativeOrientationCarrierToBuffer, acquireEntityIndexBuffer, createEntityRangeStarts, appendEntityInstanceRange, writeSelectionRange, isFiniteMatrixData, isRigidTransformMatrix, createTransformMatrix, isFiniteVector3, isFiniteTransform, isFiniteMatrix, disposeBatches } from './thinInstanceMatrixBuilder';
import { isTransformedBoxInFrustum, isFiniteVector3Data, cloneBoundingInfo, calculateTransformedExtentToRef } from './thinInstanceFrustum';
import { copyMatrixRows, matrixUploadRangesForRows, sparseMatrixUploadsEnabled } from './thinInstanceSparseUpdates';
import { captureEntityArrayTransformSnapshot, prepareEntityArrayTransformUpdate, type EntityArrayTransformSnapshot } from './thinInstanceTransformUpdates';
export type { EntityArrayThinInstanceBatchOptions, EntityArrayThinInstanceTransform, EntityArrayLightingInstance } from './thinInstanceBatchTypes';


export class EntityArrayThinInstanceBatch {
  readonly meshes: Mesh[];

  private readonly previewOffsets: Vector3Data[] = [];
  private readonly batchByMeshUniqueId = new Map<number, EntityArrayMatrixBatch>();
  private readonly batches: EntityArrayMatrixBatch[];
  private entityIds: string[] = [];
  private readonly entityIndexById = new Map<string, number>();
  private pickableEntityIds = new Set<string>();
  private selectedEntityIds = new Set<string>();
  private lightingHiddenInstances = new Map<number, ReadonlySet<number>>();
  private selectionId = 0;
  private entityLayoutRevision = 0;
  private lightingSourceRevision = 0;
  private selectionLayoutRevision = -1;
  private readonly scene: Scene | null;
  private frustumObserver: Observer<Scene> | null = null;
  private readonly lastFrustumMatrix = new Float64Array(16);
  private hasLastFrustumMatrix = false;
  private cullingDirty = true;
  private readonly cullingInstanceMatrix = new Matrix();
  private readonly cullingWorldMatrix = new Matrix();
  private readonly cullingCenter = new Vector3();
  private readonly transformPreviewExtent = new Vector3();
  private readonly rotationPreviewBaselineMatrix = new Matrix();
  private readonly rotationPreviewResultMatrix = new Matrix();
  private translationPreviewSession: EntityArrayTranslationPreviewSession | null = null;
  private rotationPreviewSession: EntityArrayRotationPreviewSession | null = null;
  private transformUpdateSnapshot: EntityArrayTransformSnapshot | null = null;

  private constructor(
    private readonly sources: EntityArrayMatrixSource[],
    batches: EntityArrayMatrixBatch[],
    private readonly interactive: boolean,
  ) {
    this.batches = batches;
    this.meshes = batches.map((batch) => batch.mesh);
    for (const batch of batches) this.batchByMeshUniqueId.set(batch.mesh.uniqueId, batch);
    this.scene = batches[0]?.mesh.getScene() ?? null;
    if (interactive && this.scene) {
      this.frustumObserver = this.scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
        this.updateFrustumCulling();
      });
    }
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
        sourceMeshes: [sourceMesh],
        batchSource,
        layerMask: options.resolveLayerMask?.(sourceMesh) ?? null,
        rootLocalVertexData: null,
        rootLocalGeometryBaked: false,
        sourceRootWorldMatrix: null,
      });
    }

    if (candidates.length === 0) return null;

    if (options.mergeStaticMeshesByMaterial && options.sourceRootWorldMatrix) {
      candidates = groupRepeatedStaticGeometryCandidates(candidates);
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
          matrixScratchByOrientation: {},
          entityIndexScratchByOrientation: {},
        };
        const batch = createMatrixBatch(source, 1, interactive, false, 0);
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

  /** 更新等距预览矩阵；步长保留正负方向，相同数量时复用已有 Float32Array。 */
  update(copyCount: number, direction: Vector3Data, arrayStepMeters: number): boolean {
    if (
      !Number.isSafeInteger(copyCount)
      || copyCount < 1
      || !isFiniteVector3(direction)
      || !Number.isFinite(arrayStepMeters)
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
    this.transformUpdateSnapshot = null;

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
    if (this.translationPreviewSession) this.endEntityTranslationPreview(true);
    if (this.rotationPreviewSession) this.endEntityRotationPreview(true);
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

    if (this.tryUpdateEntityTransformsIncrementally(inverseSourceRoot, instances)) return true;
    this.transformUpdateSnapshot = null;

    // 实体布局（顺序与 ID 集合）不变是跳过批次提交的前提：picking 的实体映射依赖该顺序。
    const nextEntityIds = instances.map((instance) => instance.entityId);
    const entityLayoutUnchanged = nextEntityIds.length === this.entityIds.length
      && nextEntityIds.every((entityId, index) => this.entityIds[index] === entityId);

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
        : captureCandidateSourceWorldMatrices(source, inverseSourceRoot);
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

    const batchPreparationSnapshots = new Map(this.batches.map((batch) => [batch, {
      orientation: batch.orientation,
      partitionIndex: batch.partitionIndex,
    }]));
    for (const plan of plans) {
      const batchByOrientation = this.prepareOrientationBatches(
        plan.source,
        plan.positiveCount,
        plan.negativeCount,
      );
      if (!batchByOrientation) {
        this.rollbackPreparedBatches(batchPreparationSnapshots);
        return false;
      }
      plan.batchByOrientation = batchByOrientation;
    }

    const hasPickableEntity = instances.some((instance) => instance.pickable);
    const scratchWorldMatrix = new Matrix();
    const preparedPlans: Array<{
      plan: (typeof plans)[number];
      positiveBatch: EntityArrayMatrixBatch | undefined;
      negativeBatch: EntityArrayMatrixBatch | undefined;
      positiveBuffer: Float32Array | null;
      negativeBuffer: Float32Array | null;
      positiveEntityIndexes: Uint32Array | null;
      negativeEntityIndexes: Uint32Array | null;
      positiveEntityRangeStarts: Int32Array | null;
      positiveEntityRangeCounts: Uint32Array | null;
      negativeEntityRangeStarts: Int32Array | null;
      negativeEntityRangeCounts: Uint32Array | null;
      positiveSpatialPartitions: PreparedEntityArraySpatialPartitions | null;
      negativeSpatialPartitions: PreparedEntityArraySpatialPartitions | null;
    }> = [];

    for (const plan of plans) {
      const positiveBatch = plan.batchByOrientation[1];
      const negativeBatch = plan.batchByOrientation[-1];
      const positiveBuffer = positiveBatch
        ? acquireDetachedFloatBuffer(
          plan.source.matrixScratchByOrientation[1] ?? null,
          plan.source.batches,
          plan.positiveCount * 16,
        )
        : null;
      const negativeBuffer = negativeBatch
        ? acquireDetachedFloatBuffer(
          plan.source.matrixScratchByOrientation[-1] ?? null,
          plan.source.batches,
          plan.negativeCount * 16,
        )
        : null;
      const positiveEntityIndexes = positiveBatch
        ? acquireDetachedEntityIndexBuffer(
          plan.source.entityIndexScratchByOrientation[1] ?? null,
          plan.source.batches,
          plan.positiveCount,
        )
        : null;
      const negativeEntityIndexes = negativeBatch
        ? acquireDetachedEntityIndexBuffer(
          plan.source.entityIndexScratchByOrientation[-1] ?? null,
          plan.source.batches,
          plan.negativeCount,
        )
        : null;
      if (positiveBuffer) plan.source.matrixScratchByOrientation[1] = positiveBuffer;
      if (negativeBuffer) plan.source.matrixScratchByOrientation[-1] = negativeBuffer;
      if (positiveEntityIndexes) plan.source.entityIndexScratchByOrientation[1] = positiveEntityIndexes;
      if (negativeEntityIndexes) plan.source.entityIndexScratchByOrientation[-1] = negativeEntityIndexes;
      const positiveEntityRangeStarts = positiveBatch && !this.interactive
        ? createEntityRangeStarts(instances.length)
        : null;
      const positiveEntityRangeCounts = positiveBatch && !this.interactive
        ? new Uint32Array(instances.length)
        : null;
      const negativeEntityRangeStarts = negativeBatch && !this.interactive
        ? createEntityRangeStarts(instances.length)
        : null;
      const negativeEntityRangeCounts = negativeBatch && !this.interactive
        ? new Uint32Array(instances.length)
        : null;
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
            if (positiveEntityRangeStarts && positiveEntityRangeCounts) {
              appendEntityInstanceRange(
                positiveEntityRangeStarts,
                positiveEntityRangeCounts,
                entityIndex,
                positiveInstanceIndex,
              );
            }
            positiveMatrixOffset += 16;
            positiveInstanceIndex += 1;
            continue;
          }

          scratchWorldMatrix.copyToArray(negativeBuffer!, negativeMatrixOffset);
          applyNegativeOrientationCarrierToBuffer(negativeBuffer!, negativeMatrixOffset);
          negativeEntityIndexes![negativeInstanceIndex] = entityIndex;
          if (negativeEntityRangeStarts && negativeEntityRangeCounts) {
            appendEntityInstanceRange(
              negativeEntityRangeStarts,
              negativeEntityRangeCounts,
              entityIndex,
              negativeInstanceIndex,
            );
          }
          negativeMatrixOffset += 16;
          negativeInstanceIndex += 1;
        }
      }

      preparedPlans.push({
        plan,
        positiveBatch,
        negativeBatch,
        positiveBuffer,
        negativeBuffer,
        positiveEntityIndexes,
        negativeEntityIndexes,
        positiveEntityRangeStarts,
        positiveEntityRangeCounts,
        negativeEntityRangeStarts,
        negativeEntityRangeCounts,
        positiveSpatialPartitions: null,
        negativeSpatialPartitions: null,
      });
    }

    if (this.interactive) {
      // 所有方向/空间分片先完成资源准备，再允许任何现有批次写入，失败时画面保持原样。
      for (const prepared of preparedPlans) {
        if (prepared.positiveBatch && prepared.positiveBuffer && prepared.positiveEntityIndexes) {
          prepared.positiveSpatialPartitions = this.prepareSpatialEntityPartitions(
            prepared.plan.source,
            1,
            prepared.positiveBuffer,
            prepared.positiveEntityIndexes,
          );
          if (!prepared.positiveSpatialPartitions) {
            this.rollbackPreparedBatches(batchPreparationSnapshots);
            return false;
          }
        }
        if (prepared.negativeBatch && prepared.negativeBuffer && prepared.negativeEntityIndexes) {
          prepared.negativeSpatialPartitions = this.prepareSpatialEntityPartitions(
            prepared.plan.source,
            -1,
            prepared.negativeBuffer,
            prepared.negativeEntityIndexes,
          );
          if (!prepared.negativeSpatialPartitions) {
            this.rollbackPreparedBatches(batchPreparationSnapshots);
            return false;
          }
        }
      }
    }

    let committedAnyBatch = false;
    for (const prepared of preparedPlans) {
      const activeBatches = new Set<EntityArrayMatrixBatch>();
      if (prepared.positiveBatch && prepared.positiveBuffer && prepared.positiveEntityIndexes) {
        if (this.interactive && prepared.positiveSpatialPartitions) {
          const committed = this.commitPreparedSpatialEntityPartitions(
            prepared.positiveBuffer,
            prepared.positiveEntityIndexes,
            instances,
            prepared.positiveSpatialPartitions,
            entityLayoutUnchanged,
          );
          for (const batch of committed.batches) activeBatches.add(batch);
          committedAnyBatch = committedAnyBatch || committed.committedAny;
        } else if (prepared.positiveEntityRangeStarts && prepared.positiveEntityRangeCounts) {
          if (!(entityLayoutUnchanged && isCommittedBatchStateUnchanged(
            prepared.positiveBatch.matrixBuffer,
            prepared.positiveBatch.entityIndexBuffer,
            prepared.positiveBuffer,
            prepared.positiveEntityIndexes,
          ))) {
            prepared.positiveBatch.entityIndexBuffer = prepared.positiveEntityIndexes;
            prepared.positiveBatch.entityInstanceRangeStarts = prepared.positiveEntityRangeStarts;
            prepared.positiveBatch.entityInstanceRangeCounts = prepared.positiveEntityRangeCounts;
            commitMatrixBuffer(prepared.positiveBatch, prepared.positiveBuffer, prepared.plan.positiveCount, true);
            committedAnyBatch = true;
          }
          applyBatchInteractionState(prepared.positiveBatch, true, hasPickableEntity);
          activeBatches.add(prepared.positiveBatch);
        }
      }
      if (prepared.negativeBatch && prepared.negativeBuffer && prepared.negativeEntityIndexes) {
        if (this.interactive && prepared.negativeSpatialPartitions) {
          const committed = this.commitPreparedSpatialEntityPartitions(
            prepared.negativeBuffer,
            prepared.negativeEntityIndexes,
            instances,
            prepared.negativeSpatialPartitions,
            entityLayoutUnchanged,
          );
          for (const batch of committed.batches) activeBatches.add(batch);
          committedAnyBatch = committedAnyBatch || committed.committedAny;
        } else if (prepared.negativeEntityRangeStarts && prepared.negativeEntityRangeCounts) {
          if (!(entityLayoutUnchanged && isCommittedBatchStateUnchanged(
            prepared.negativeBatch.matrixBuffer,
            prepared.negativeBatch.entityIndexBuffer,
            prepared.negativeBuffer,
            prepared.negativeEntityIndexes,
          ))) {
            prepared.negativeBatch.entityIndexBuffer = prepared.negativeEntityIndexes;
            prepared.negativeBatch.entityInstanceRangeStarts = prepared.negativeEntityRangeStarts;
            prepared.negativeBatch.entityInstanceRangeCounts = prepared.negativeEntityRangeCounts;
            commitMatrixBuffer(prepared.negativeBatch, prepared.negativeBuffer, prepared.plan.negativeCount, true);
            committedAnyBatch = true;
          }
          applyBatchInteractionState(prepared.negativeBatch, true, hasPickableEntity);
          activeBatches.add(prepared.negativeBatch);
        }
      }
      this.deactivateUnusedBatches(prepared.plan.source, activeBatches);
    }

    this.entityIds = nextEntityIds;
    this.entityIndexById.clear();
    for (let entityIndex = 0; entityIndex < this.entityIds.length; entityIndex += 1) {
      this.entityIndexById.set(this.entityIds[entityIndex], entityIndex);
    }
    this.pickableEntityIds = new Set(
      instances.filter((instance) => instance.pickable).map((instance) => instance.entityId),
    );
    // 无真实提交时既不推进布局版本也不强制裁剪重算；相机移动由 updateFrustumCulling 自行检测。
    if (committedAnyBatch) {
      this.entityLayoutRevision += 1;
      this.cullingDirty = true;
    }
    this.updateFrustumCulling();
    this.transformUpdateSnapshot = this.interactive ? captureEntityArrayTransformSnapshot(plans, instances) : null;
    return true;
  }

  /** 稳定完整布局只重算实际变化的实体行；仍执行原交互、边界和光照失效链。 */
  private tryUpdateEntityTransformsIncrementally(
    inverseSourceRoot: Matrix,
    instances: readonly EntityArrayThinInstanceTransform[],
  ): boolean {
    const snapshot = this.transformUpdateSnapshot;
    if (!this.interactive || !snapshot) return false;
    const prepared = prepareEntityArrayTransformUpdate(snapshot, inverseSourceRoot, instances);
    if (!prepared) return false;
    // 提交期间异常不得留下可复用的旧快照；下次同步仍可按原全量事务恢复。
    this.transformUpdateSnapshot = null;
    for (const source of snapshot.sources) for (const { batch } of source.batches) {
      applyBatchOrientation(batch, batch.orientation);
    }
    for (const { batch, rows, matrices } of prepared.patches) {
      const sourceMatrices = batch.sourceMatrixBuffer!;
      const renderMatrices = batch.matrixBuffer!;
      for (let index = 0; index < rows.length; index++) {
        const row = matrices.subarray(index * 16, index * 16 + 16);
        sourceMatrices.set(row, rows[index] * 16);
        renderMatrices.set(row, rows[index] * 16);
      }
      const count = batch.sourceEntityIndexBuffer!.length;
      batch.mesh._thinInstanceDataStorage.worldMatrices = null;
      commitMatrixBuffer(batch, renderMatrices, count, true, matrixUploadRangesForRows(rows, count));
      const bounds = batch.mesh.getBoundingInfo().boundingBox;
      batch.fullBoundingInfo = new BoundingInfo(bounds.minimumWorld.clone(), bounds.maximumWorld.clone());
      batch.lastFrustumContainment = -1;
      this.lightingSourceRevision += 1;
    }
    for (const source of snapshot.sources) for (const { batch, sourceIndexes } of source.batches) {
      applyBatchInteractionState(batch, true, sourceIndexes.some(index => instances[index].pickable));
    }
    this.pickableEntityIds = new Set(instances.filter(instance => instance.pickable).map(instance => instance.entityId));
    if (prepared.patches.length) {
      this.entityLayoutRevision += 1;
      this.cullingDirty = true;
    }
    this.updateFrustumCulling(true, new Set(snapshot.sources.flatMap(source => source.batches.map(layout => layout.batch))));
    for (const change of prepared.changes) snapshot.instances[change.index].transform = change.transform;
    this.transformUpdateSnapshot = snapshot;
    return true;
  }

  /** 资源准备失败时移除本次新建的空分片，并恢复既有载体方向。 */
  private rollbackPreparedBatches(
    snapshots: ReadonlyMap<EntityArrayMatrixBatch, {
      orientation: EntityArrayMatrixOrientation;
      partitionIndex: number;
    }>,
  ): void {
    for (const source of this.sources) {
      for (const batch of [...source.batches]) {
        const snapshot = snapshots.get(batch);
        if (snapshot) {
          applyBatchOrientation(batch, snapshot.orientation);
          batch.partitionIndex = snapshot.partitionIndex;
          continue;
        }
        this.batchByMeshUniqueId.delete(batch.mesh.uniqueId);
        const sourceIndex = source.batches.indexOf(batch);
        if (sourceIndex >= 0) source.batches.splice(sourceIndex, 1);
        const batchIndex = this.batches.indexOf(batch);
        if (batchIndex >= 0) this.batches.splice(batchIndex, 1);
        const meshIndex = this.meshes.indexOf(batch.mesh);
        if (meshIndex >= 0) this.meshes.splice(meshIndex, 1);
        disposeBatches([batch]);
      }
    }
  }

  /** 为一个源 Mesh 准备当前实际需要的正/负方向主批次。 */
  private prepareOrientationBatches(
    source: EntityArrayMatrixSource,
    positiveCount: number,
    negativeCount: number,
  ): Partial<Record<EntityArrayMatrixOrientation, EntityArrayMatrixBatch>> | null {
    if (positiveCount <= 0 && negativeCount <= 0) return {};

    // 临时预览保持原有最多正/负两个 Mesh 的轻量路径，不创建空间分区。
    if (!this.interactive) {
      const primaryBatch = source.batches[0];
      if (positiveCount <= 0 || negativeCount <= 0) {
        const orientation: EntityArrayMatrixOrientation = negativeCount > 0 ? -1 : 1;
        applyBatchOrientation(primaryBatch, orientation);
        primaryBatch.partitionIndex = 0;
        return { [orientation]: primaryBatch };
      }

      applyBatchOrientation(primaryBatch, 1);
      primaryBatch.partitionIndex = 0;
      let negativeBatch = source.batches[1];
      if (!negativeBatch) {
        try {
          negativeBatch = createMatrixBatch(source, -1, this.interactive, true, 0);
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
        negativeBatch.partitionIndex = 0;
      }
      return { 1: primaryBatch, [-1]: negativeBatch };
    }

    const result: Partial<Record<EntityArrayMatrixOrientation, EntityArrayMatrixBatch>> = {};
    const reservedBatches = new Set<EntityArrayMatrixBatch>();
    if (positiveCount > 0) {
      const positiveBatch = this.ensureOrientationPartitionBatch(source, 1, 0, reservedBatches);
      if (!positiveBatch) return null;
      result[1] = positiveBatch;
      reservedBatches.add(positiveBatch);
    }
    if (negativeCount > 0) {
      const negativeBatch = this.ensureOrientationPartitionBatch(source, -1, 0, reservedBatches);
      if (!negativeBatch) return null;
      result[-1] = negativeBatch;
      reservedBatches.add(negativeBatch);
    }
    return result;
  }

  /** 获取或创建指定方向和空间分区的固定 Geometry 批次。 */
  private ensureOrientationPartitionBatch(
    source: EntityArrayMatrixSource,
    orientation: EntityArrayMatrixOrientation,
    partitionIndex: number,
    reservedBatches: ReadonlySet<EntityArrayMatrixBatch> | null = null,
  ): EntityArrayMatrixBatch | null {
    const existing = source.batches.find((batch) => (
      batch.orientation === orientation && batch.partitionIndex === partitionIndex
    ));
    if (existing) {
      applyBatchOrientation(existing, orientation);
      return existing;
    }
    // 初次提交若源几何本身为负 determinant，可直接复用尚未写入矩阵的默认正方向载体。
    const unusedInitialBatch = partitionIndex === 0
      ? source.batches.find((batch) => (
        !reservedBatches?.has(batch)
        && batch.partitionIndex === 0
        && batch.matrixBuffer === null
        && batch.mesh.thinInstanceCount === 0
      ))
      : null;
    if (unusedInitialBatch) {
      unusedInitialBatch.partitionIndex = 0;
      applyBatchOrientation(unusedInitialBatch, orientation);
      return unusedInitialBatch;
    }

    try {
      const batch = createMatrixBatch(source, orientation, this.interactive, true, partitionIndex);
      source.batches.push(batch);
      this.batches.push(batch);
      this.meshes.push(batch.mesh);
      this.batchByMeshUniqueId.set(batch.mesh.uniqueId, batch);
      return batch;
    } catch (error) {
      console.warn('创建模型阵列空间分区批次失败。', error);
      return null;
    }
  }

  /** 正式批次提交前创建全部方向/空间载体；本阶段不得改写任何有效矩阵。 */
  private prepareSpatialEntityPartitions(
    source: EntityArrayMatrixSource,
    orientation: EntityArrayMatrixOrientation,
    matrixBuffer: Float32Array,
    entityIndexBuffer: Uint32Array,
  ): PreparedEntityArraySpatialPartitions | null {
    const sourceInstanceIndexesByPartition = createSpatialMatrixPartitions(
      matrixBuffer,
      entityIndexBuffer,
      entityIndexBuffer.length,
      resolveFormalBatchMaxInstancesPerPartition(source),
    );
    const partitionCount = sourceInstanceIndexesByPartition?.length ?? 1;
    const batches: EntityArrayMatrixBatch[] = [];
    for (let partitionIndex = 0; partitionIndex < partitionCount; partitionIndex += 1) {
      const batch = this.ensureOrientationPartitionBatch(source, orientation, partitionIndex);
      if (!batch) return null;
      batches.push(batch);
    }
    return { sourceInstanceIndexesByPartition, batches };
  }

  /**
   * 使用已完成资源准备的批次按世界平移主跨度提交有界分片。
   * 每个分片保留全部矩阵、材质和几何，只利用独立包围盒恢复 Babylon 的批次级视锥裁剪。
   * 布局未变且逐元素比对全等的分片跳过提交，返回 committedAny 供上层决定是否强制裁剪重算。
   */
  private commitPreparedSpatialEntityPartitions(
    matrixBuffer: Float32Array,
    entityIndexBuffer: Uint32Array,
    instances: readonly EntityArrayThinInstanceTransform[],
    prepared: PreparedEntityArraySpatialPartitions,
    entityLayoutUnchanged: boolean,
  ): { batches: EntityArrayMatrixBatch[]; committedAny: boolean } {
    const partitions = prepared.sourceInstanceIndexesByPartition;
    if (!partitions) {
      const batch = prepared.batches[0]!;
      let committed = false;
      if (!(entityLayoutUnchanged && isCommittedBatchStateUnchanged(
        batch.sourceMatrixBuffer,
        batch.sourceEntityIndexBuffer,
        matrixBuffer,
        entityIndexBuffer,
      ))) {
        this.commitInteractiveBatchSource(batch, matrixBuffer, entityIndexBuffer, instances.length);
        committed = true;
      }
      applyBatchInteractionState(
        batch,
        true,
        entityIndexBuffer.some((entityIndex) => instances[entityIndex]?.pickable === true),
      );
      return { batches: [batch], committedAny: committed };
    }

    const activeBatches: EntityArrayMatrixBatch[] = [];
    let committedAny = false;
    for (let partitionIndex = 0; partitionIndex < partitions.length; partitionIndex += 1) {
      const sourceInstanceIndexes: number[] = partitions[partitionIndex]!;
      const batch = prepared.batches[partitionIndex]!;
      const previousMatrices = batch.sourceMatrixBuffer;
      const previousIndexes = batch.sourceEntityIndexBuffer;
      const partitionMatrixBuffer = acquireFloatBuffer(previousMatrices, sourceInstanceIndexes.length * 16);
      const partitionEntityIndexes = acquireEntityIndexBuffer(
        previousIndexes,
        sourceInstanceIndexes.length,
      );
      // 沿用既有缓冲时逐行先比对再覆盖：全等则整片跳过提交；长度变化必然视为有变化。
      let unchanged = entityLayoutUnchanged
        && previousMatrices !== null
        && previousIndexes !== null
        && partitionMatrixBuffer === previousMatrices
        && partitionEntityIndexes === previousIndexes;
      let pickable = false;

      for (let partitionInstanceIndex = 0; partitionInstanceIndex < sourceInstanceIndexes.length; partitionInstanceIndex += 1) {
        const sourceInstanceIndex: number = sourceInstanceIndexes[partitionInstanceIndex];
        const entityIndex = entityIndexBuffer[sourceInstanceIndex];
        if (unchanged && previousMatrices && previousIndexes) {
          const targetOffset = partitionInstanceIndex * 16;
          const sourceOffset = sourceInstanceIndex * 16;
          if (previousIndexes[partitionInstanceIndex] !== entityIndex) {
            unchanged = false;
          } else {
            for (let element = 0; element < 16; element += 1) {
              if (previousMatrices[targetOffset + element] !== matrixBuffer[sourceOffset + element]) {
                unchanged = false;
                break;
              }
            }
          }
        }
        partitionMatrixBuffer.set(
          matrixBuffer.subarray(sourceInstanceIndex * 16, sourceInstanceIndex * 16 + 16),
          partitionInstanceIndex * 16,
        );
        partitionEntityIndexes[partitionInstanceIndex] = entityIndex;
        if (instances[entityIndex]?.pickable) pickable = true;
      }

      if (!unchanged) {
        this.commitInteractiveBatchSource(
          batch,
          partitionMatrixBuffer,
          partitionEntityIndexes,
          instances.length,
        );
        committedAny = true;
      }
      applyBatchInteractionState(batch, true, pickable);
      activeBatches.push(batch);
    }
    return { batches: activeBatches, committedAny };
  }

  /** 保存完整分片，并使用独立 GPU 缓冲承载当前可见前缀，避免相机裁剪破坏完整矩阵。 */
  private commitInteractiveBatchSource(
    batch: EntityArrayMatrixBatch,
    sourceMatrixBuffer: Float32Array,
    sourceEntityIndexBuffer: Uint32Array,
    entityCount: number,
  ): void {
    const instanceCount = sourceEntityIndexBuffer.length;
    this.lightingSourceRevision += 1;
    const completeSourceMatrixBuffer = acquireIndependentFloatBuffer(
      batch.sourceMatrixBuffer,
      sourceMatrixBuffer,
      sourceMatrixBuffer.length,
    );
    const completeSourceEntityIndexBuffer = acquireIndependentEntityIndexBuffer(
      batch.sourceEntityIndexBuffer,
      sourceEntityIndexBuffer,
      instanceCount,
    );
    completeSourceMatrixBuffer.set(sourceMatrixBuffer);
    completeSourceEntityIndexBuffer.set(sourceEntityIndexBuffer);
    batch.sourceMatrixBuffer = completeSourceMatrixBuffer;
    batch.sourceEntityIndexBuffer = completeSourceEntityIndexBuffer;
    const renderMatrixBuffer = acquireIndependentFloatBuffer(
      batch.matrixBuffer,
      completeSourceMatrixBuffer,
      completeSourceMatrixBuffer.length,
    );
    const renderEntityIndexBuffer = acquireIndependentEntityIndexBuffer(
      batch.entityIndexBuffer,
      completeSourceEntityIndexBuffer,
      instanceCount,
    );
    // 只有当前完整可见布局与新实体顺序相同，才能保留 GPU 布局并只上传变化行。
    const stableLayout = sparseMatrixUploadsEnabled(batch.mesh.getScene())
      && batch.matrixBuffer === renderMatrixBuffer && batch.mesh.thinInstanceCount === instanceCount
      && batch.visibleSourceIndexCount === instanceCount && batch.entityIndexBuffer?.length === instanceCount
      && completeSourceEntityIndexBuffer.every((value, index) => batch.entityIndexBuffer![index] === value
        && batch.visibleSourceIndexBuffer?.[index] === index);
    const uploadRanges = copyMatrixRows(renderMatrixBuffer, completeSourceMatrixBuffer, instanceCount, stableLayout);
    renderEntityIndexBuffer.set(completeSourceEntityIndexBuffer);
    batch.entityIndexBuffer = renderEntityIndexBuffer;
    const ranges = createEntityInstanceRanges(renderEntityIndexBuffer, entityCount, instanceCount);
    batch.entityInstanceRangeStarts = ranges.starts;
    batch.entityInstanceRangeCounts = ranges.counts;
    const visibleSourceIndexes = acquireEntityIndexBuffer(batch.visibleSourceIndexBuffer, instanceCount);
    for (let index = 0; index < instanceCount; index += 1) visibleSourceIndexes[index] = index;
    batch.visibleSourceIndexBuffer = visibleSourceIndexes;
    batch.visibleSourceIndexCount = instanceCount;
    commitMatrixBuffer(batch, renderMatrixBuffer, instanceCount, true, uploadRanges);
    const bounds = batch.mesh.getBoundingInfo().boundingBox;
    batch.fullBoundingInfo = new BoundingInfo(bounds.minimumWorld.clone(), bounds.maximumWorld.clone());
    batch.lastFrustumContainment = -1;
    this.cullingDirty = true;
  }

  /** 相机变化时只上传保守视锥内的实例；完整源矩阵、参数脚本和逻辑实体始终保留。 */
  private updateFrustumCulling(
    refreshSelectionMask = true,
    currentMatrixBatches?: ReadonlySet<EntityArrayMatrixBatch>,
  ): boolean {
    const scene = this.scene;
    const frustumPlanes = scene?.frustumPlanes;
    const camera = scene?.activeCamera;
    if (!this.interactive || !scene) return false;
    const effectiveFrustumPlanes = camera && frustumPlanes?.length ? frustumPlanes : null;
    const transformValues = scene.getTransformMatrix().m;
    const forceMatrixUpdate = this.cullingDirty;
    let frustumChanged = !this.hasLastFrustumMatrix;
    if (!frustumChanged) {
      for (let index = 0; index < 16; index += 1) {
        if (this.lastFrustumMatrix[index] !== transformValues[index]) {
          frustumChanged = true;
          break;
        }
      }
    }
    if (!forceMatrixUpdate && !frustumChanged) return false;
    this.cullingDirty = false;
    this.hasLastFrustumMatrix = true;
    this.lastFrustumMatrix.set(transformValues);

    let layoutChanged = false;
    for (const batch of this.batches) {
      if (!batch.requestedVisible || !batch.sourceMatrixBuffer || !batch.sourceEntityIndexBuffer) continue;
      layoutChanged = this.updateBatchFrustumVisibility(batch, effectiveFrustumPlanes, forceMatrixUpdate, currentMatrixBatches?.has(batch) === true)
        || layoutChanged;
    }
    if (layoutChanged) {
      this.entityLayoutRevision += 1;
      if (refreshSelectionMask) this.setSelectionMask(this.selectedEntityIds, this.selectionId);
    }
    return true;
  }

  private updateBatchFrustumVisibility(
    batch: EntityArrayMatrixBatch,
    frustumPlanes: Plane[] | null,
    forceMatrixUpdate: boolean,
    renderMatricesCurrent = false,
  ): boolean {
    const sourceMatrixBuffer = batch.sourceMatrixBuffer;
    const sourceEntityIndexBuffer = batch.sourceEntityIndexBuffer;
    const fullBoundingInfo = batch.fullBoundingInfo;
    if (!sourceMatrixBuffer || !sourceEntityIndexBuffer || !fullBoundingInfo) return false;
    const sourceInstanceCount = sourceEntityIndexBuffer.length;

    let containment: EntityArrayFrustumContainment;
    if (!frustumPlanes) {
      containment = 2;
    } else if (!fullBoundingInfo.isInFrustum(frustumPlanes)) {
      containment = 0;
    } else {
      containment = fullBoundingInfo.isCompletelyInFrustum(frustumPlanes) ? 2 : 1;
    }
    if (
      !forceMatrixUpdate
      && containment === batch.lastFrustumContainment
      && containment !== 1
    ) {
      return false;
    }
    batch.lastFrustumContainment = containment;

    const scratchIndexes = acquireEntityIndexBuffer(batch.cullingScratchIndexBuffer, sourceInstanceCount);
    let visibleCount = 0;
    const lightingHidden = this.lightingHiddenInstances.get(batch.mesh.uniqueId);
    if (containment !== 0) {
      const hasDynamicVertexDeformation = (batch.mesh.skeleton?.bones.length ?? 0) > 0
        || (batch.mesh.morphTargetManager?.numTargets ?? 0) > 0
        || batch.mesh.bakedVertexAnimationManager?.isEnabled === true;
      const canFineCullOriginalGeometry = containment !== 2
        && !hasDynamicVertexDeformation
        && !!batch.mesh.rawBoundingInfo;
      if (canFineCullOriginalGeometry && batch.mesh.rawBoundingInfo && frustumPlanes) {
        const sourceBox = batch.mesh.rawBoundingInfo.boundingBox;
        batch.mesh.computeWorldMatrix(true);
        const batchWorldMatrix = batch.mesh.getWorldMatrix();
        for (let sourceIndex = 0; sourceIndex < sourceInstanceCount; sourceIndex += 1) {
          if (lightingHidden?.has(sourceIndex)) continue;
          Matrix.FromArrayToRef(sourceMatrixBuffer, sourceIndex * 16, this.cullingInstanceMatrix);
          this.cullingInstanceMatrix.multiplyToRef(batchWorldMatrix, this.cullingWorldMatrix);
          if (!isTransformedBoxInFrustum(
            sourceBox.center,
            sourceBox.extendSize,
            this.cullingWorldMatrix,
            frustumPlanes,
            this.cullingCenter,
          )) continue;
          scratchIndexes[visibleCount] = sourceIndex;
          visibleCount += 1;
        }
      } else {
        for (let sourceIndex = 0; sourceIndex < sourceInstanceCount; sourceIndex += 1) {
          if (lightingHidden?.has(sourceIndex)) continue;
          scratchIndexes[visibleCount++] = sourceIndex;
        }
      }
    }

    const previousIndexes = batch.visibleSourceIndexBuffer;
    let sameVisibleLayout = visibleCount === batch.visibleSourceIndexCount && !!previousIndexes;
    if (sameVisibleLayout && previousIndexes) {
      for (let index = 0; index < visibleCount; index += 1) {
        if (previousIndexes[index] !== scratchIndexes[index]) {
          sameVisibleLayout = false;
          break;
        }
      }
    }
    // 受控变换增量已同步当前完整渲染布局；视锥布局未变时不能再复制并全量上传同一批矩阵。
    if (sameVisibleLayout && (!forceMatrixUpdate || renderMatricesCurrent)) return false;
    const visibleLayoutChanged = !sameVisibleLayout;

    const renderMatrixBuffer = acquireIndependentFloatBuffer(
      batch.matrixBuffer,
      sourceMatrixBuffer,
      sourceMatrixBuffer.length,
    );
    const uploadRanges = copyMatrixRows(renderMatrixBuffer, sourceMatrixBuffer, visibleCount,
      sameVisibleLayout && renderMatrixBuffer === batch.matrixBuffer && sparseMatrixUploadsEnabled(batch.mesh.getScene()), scratchIndexes);
    if (sameVisibleLayout) {
      // 纯矩阵位移不改变可见顺序时复用实体索引和范围缓冲，拖动帧只上传矩阵。
      commitMatrixBuffer(batch, renderMatrixBuffer, visibleCount, false, uploadRanges);
      return false;
    }

    const renderEntityIndexBuffer = acquireIndependentEntityIndexBuffer(
      batch.entityIndexBuffer,
      sourceEntityIndexBuffer,
      sourceInstanceCount,
    );
    for (let visibleIndex = 0; visibleIndex < visibleCount; visibleIndex += 1) {
      renderEntityIndexBuffer[visibleIndex] = sourceEntityIndexBuffer[scratchIndexes[visibleIndex]];
    }
    batch.entityIndexBuffer = renderEntityIndexBuffer;
    const entityRanges = createEntityInstanceRanges(
      renderEntityIndexBuffer,
      this.entityIds.length,
      visibleCount,
    );
    batch.entityInstanceRangeStarts = entityRanges.starts;
    batch.entityInstanceRangeCounts = entityRanges.counts;
    commitMatrixBuffer(batch, renderMatrixBuffer, visibleCount, false);
    batch.visibleSourceIndexBuffer = scratchIndexes;
    batch.cullingScratchIndexBuffer = previousIndexes;
    batch.visibleSourceIndexCount = visibleCount;
    syncBatchEffectiveInteractionState(batch);
    return visibleLayoutChanged;
  }

  /** 释放不再使用的空间/方向分片；每个源只保留一个空主载体供后续快速复用。 */
  private deactivateUnusedBatches(
    source: EntityArrayMatrixSource,
    activeBatches: ReadonlySet<EntityArrayMatrixBatch>,
  ): void {
    const retainedPrimary = source.batches[0] ?? null;
    for (const batch of [...source.batches]) {
      if (activeBatches.has(batch)) continue;
      if (batch.sourceMatrixBuffer?.length) this.lightingSourceRevision += 1;
      if (batch === retainedPrimary) {
        resetInactiveBatchBuffers(batch);
        applyBatchInteractionState(batch, false, false);
        continue;
      }

      this.batchByMeshUniqueId.delete(batch.mesh.uniqueId);
      const sourceIndex = source.batches.indexOf(batch);
      if (sourceIndex >= 0) source.batches.splice(sourceIndex, 1);
      const batchIndex = this.batches.indexOf(batch);
      if (batchIndex >= 0) this.batches.splice(batchIndex, 1);
      const meshIndex = this.meshes.indexOf(batch.mesh);
      if (meshIndex >= 0) this.meshes.splice(meshIndex, 1);
      disposeBatches([batch]);
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

  /** 一次性导出完整权威实例；不读取只含当前相机可见前缀的 GPU 缓冲。 */
  getLightingInstances(): EntityArrayLightingInstance[] {
    const result: EntityArrayLightingInstance[] = [];
    for (const batch of this.batches) {
      // 非交互组合批次没有视锥前缀，其 matrixBuffer 就是完整权威布局。
      const matrices = this.interactive ? batch.sourceMatrixBuffer : batch.matrixBuffer;
      const entities = this.interactive ? batch.sourceEntityIndexBuffer : batch.entityIndexBuffer;
      if (!batch.requestedVisible || !matrices || !entities) continue;
      batch.mesh.computeWorldMatrix(true);
      const carrierWorld = batch.mesh.getWorldMatrix();
      for (let sourceIndex = 0; sourceIndex < entities.length; sourceIndex += 1) {
        const entityId = this.entityIds[entities[sourceIndex]];
        if (!entityId) continue;
        const worldMatrix = Matrix.FromArray(matrices, sourceIndex * 16).multiply(carrierWorld);
        result.push({ mesh: batch.mesh, sourceMesh: batch.sourceMesh, entityId, sourceIndex, worldMatrix });
      }
    }
    return result;
  }

  /** 只反映权威矩阵/逻辑显隐变化；视锥、选择与光照可见前缀重排不递增。 */
  getLightingRevision(): number { return this.lightingSourceRevision; }

  /** 供场景协调器识别本类受控的视锥观察器，避免把业务脚本新增的观察器误当系统回调。 */
  getControlledSceneObservers(): readonly Observer<Scene>[] {
    return this.frustumObserver ? [this.frustumObserver] : [];
  }

  /** 不读取可见前缀，也不为显隐检查构造逐实例 Matrix。 */
  isLightingInstanceVisible(mesh: AbstractMesh, sourceIndex: number): boolean {
    const batch = this.batchByMeshUniqueId.get(mesh.uniqueId);
    const entities = this.interactive ? batch?.sourceEntityIndexBuffer : batch?.entityIndexBuffer;
    return !!batch && !!entities && Number.isInteger(sourceIndex) && sourceIndex >= 0
      && sourceIndex < entities.length && batch.requestedVisible
      && batch.sourceMesh.isEnabled(false) && batch.sourceMesh.isVisible && batch.sourceMesh.visibility > 0;
  }

  /** 使用逻辑实体的拾取设置，不能读取被视锥/光照隐藏前缀清空后的载体聚合值。 */
  isLightingInstancePickable(mesh: AbstractMesh, sourceIndex: number): boolean {
    const batch = this.batchByMeshUniqueId.get(mesh.uniqueId);
    const entityIndex = batch?.sourceEntityIndexBuffer?.[sourceIndex];
    const entityId = entityIndex === undefined ? undefined : this.entityIds[entityIndex];
    return this.interactive && this.isLightingInstanceVisible(mesh, sourceIndex)
      && entityId !== undefined && this.pickableEntityIds.has(entityId);
  }

  /** O(1) 查询完整分片中的当前世界矩阵；返回独立 Matrix，隐藏替身不会影响查询。 */
  getLightingInstanceWorldMatrix(mesh: AbstractMesh, sourceIndex: number): Matrix | null {
    const batch = this.batchByMeshUniqueId.get(mesh.uniqueId);
    const matrices = this.interactive ? batch?.sourceMatrixBuffer : batch?.matrixBuffer;
    const entities = this.interactive ? batch?.sourceEntityIndexBuffer : batch?.entityIndexBuffer;
    if (!batch || !matrices || !entities || !Number.isInteger(sourceIndex)
      || sourceIndex < 0 || sourceIndex >= entities.length) return null;
    batch.mesh.computeWorldMatrix(true);
    return Matrix.FromArray(matrices, sourceIndex * 16).multiply(batch.mesh.getWorldMatrix());
  }

  /** 只让已由独立光照几何接管的叶实例退出主渲染，源矩阵和逻辑实体始终完整保留。 */
  setLightingHiddenInstances(hidden: ReadonlyMap<number, ReadonlySet<number>>): void {
    const next = new Map<number, ReadonlySet<number>>();
    for (const [meshId, indexes] of hidden) {
      const count = this.batchByMeshUniqueId.get(meshId)?.sourceEntityIndexBuffer?.length ?? 0;
      const valid = new Set([...indexes].filter(index => Number.isInteger(index) && index >= 0 && index < count));
      if (valid.size) next.set(meshId, valid);
    }
    const unchanged = next.size === this.lightingHiddenInstances.size && [...next].every(([meshId, indexes]) => {
      const previous = this.lightingHiddenInstances.get(meshId);
      return previous?.size === indexes.size && [...indexes].every(index => previous.has(index));
    });
    if (unchanged) return;
    this.lightingHiddenInstances = next;
    this.cullingDirty = true;
    this.updateFrustumCulling();
  }

  /** 返回当前矩阵顺序对应的可见逻辑实体 ID，供选择描边和参数变体映射复用。 */
  getEntityIds(): readonly string[] {
    return this.entityIds;
  }

  /** 判断逻辑实体是否已经进入当前权威矩阵布局，供全景验收识别批次创建失败或模型缺失。 */
  hasEntityId(entityId: string): boolean {
    return this.entityIndexById.has(entityId);
  }

  /** 判断当前批次是否至少有一个可拾取逻辑实体。 */
  hasPickableEntities(): boolean {
    return this.pickableEntityIds.size > 0;
  }

  /** 捕获目标逻辑实体的矩阵平移基线，后续预览始终按绝对 delta 重算。 */
  beginEntityTranslationPreview(entityIds: ReadonlySet<string>): boolean {
    this.transformUpdateSnapshot = null;
    if (this.translationPreviewSession) this.endEntityTranslationPreview(true);
    if (this.rotationPreviewSession) this.endEntityRotationPreview(true);
    const selectedEntityIndexes = new Set<number>();
    for (const entityId of entityIds) {
      const entityIndex = this.entityIndexById.get(entityId);
      if (entityIndex !== undefined) selectedEntityIndexes.add(entityIndex);
    }
    if (selectedEntityIndexes.size === 0) return false;

    const previewBatches: EntityArrayTranslationPreviewBatch[] = [];
    for (const batch of this.batches) {
      const sourceMatrices = batch.sourceMatrixBuffer;
      const sourceEntityIndexes = batch.sourceEntityIndexBuffer;
      if (!sourceMatrices || !sourceEntityIndexes) continue;

      const matchingIndexes: number[] = [];
      for (let sourceIndex = 0; sourceIndex < sourceEntityIndexes.length; sourceIndex += 1) {
        if (selectedEntityIndexes.has(sourceEntityIndexes[sourceIndex])) matchingIndexes.push(sourceIndex);
      }
      if (matchingIndexes.length === 0) continue;

      const sourceInstanceIndexes = Uint32Array.from(matchingIndexes);
      const baselineTranslations = new Float64Array(sourceInstanceIndexes.length * 3);
      for (let index = 0; index < sourceInstanceIndexes.length; index += 1) {
        const matrixOffset = sourceInstanceIndexes[index] * 16;
        const translationOffset = index * 3;
        baselineTranslations[translationOffset] = sourceMatrices[matrixOffset + 12];
        baselineTranslations[translationOffset + 1] = sourceMatrices[matrixOffset + 13];
        baselineTranslations[translationOffset + 2] = sourceMatrices[matrixOffset + 14];
      }
      previewBatches.push({
        batch,
        sourceInstanceIndexes,
        sourceInstanceIndexSet: new Set(sourceInstanceIndexes),
        baselineTranslations,
        baselineFullBoundingInfo: cloneBoundingInfo(batch.fullBoundingInfo),
      });
    }
    if (previewBatches.length === 0) return false;

    this.translationPreviewSession = { batches: previewBatches };
    return true;
  }

  /** 只改写预览目标的平移分量；Geometry、分片、实体映射和选择缓冲保持不变。 */
  updateEntityTranslationPreview(delta: Vector3Data): boolean {
    const session = this.translationPreviewSession;
    if (!session || !isFiniteVector3Data(delta)) return false;

    for (const preview of session.batches) {
      const sourceMatrices = preview.batch.sourceMatrixBuffer;
      if (!sourceMatrices) continue;
      for (let index = 0; index < preview.sourceInstanceIndexes.length; index += 1) {
        const matrixOffset = preview.sourceInstanceIndexes[index] * 16;
        const translationOffset = index * 3;
        // 负 determinant 批次的 Mesh carrier 固定镜像 X；其局部矩阵 X 位移需反向写入，
        // 最终与 carrier 世界矩阵相乘后才能保持同方向的世界 delta。
        sourceMatrices[matrixOffset + 12] = preview.baselineTranslations[translationOffset]
          + delta.x * preview.batch.orientation;
        sourceMatrices[matrixOffset + 13] = preview.baselineTranslations[translationOffset + 1] + delta.y;
        sourceMatrices[matrixOffset + 14] = preview.baselineTranslations[translationOffset + 2] + delta.z;
      }
      this.refreshEntityTransformPreviewBatch(preview);
    }

    this.lightingSourceRevision += 1;
    this.cullingDirty = true;
    if (!this.updateFrustumCulling()) {
      for (const preview of session.batches) this.syncEntityTransformPreviewRenderBuffer(preview);
    }
    return true;
  }

  /** 结束逻辑实体平移预览；取消时恢复基线，提交前可保留当前画面等待文档同步接管。 */
  endEntityTranslationPreview(restore: boolean): void {
    const session = this.translationPreviewSession;
    if (!session) return;
    this.translationPreviewSession = null;

    if (!restore) return;
    for (const preview of session.batches) {
      const sourceMatrices = preview.batch.sourceMatrixBuffer;
      if (!sourceMatrices) continue;
      for (let index = 0; index < preview.sourceInstanceIndexes.length; index += 1) {
        const matrixOffset = preview.sourceInstanceIndexes[index] * 16;
        const translationOffset = index * 3;
        sourceMatrices[matrixOffset + 12] = preview.baselineTranslations[translationOffset];
        sourceMatrices[matrixOffset + 13] = preview.baselineTranslations[translationOffset + 1];
        sourceMatrices[matrixOffset + 14] = preview.baselineTranslations[translationOffset + 2];
      }
      preview.batch.fullBoundingInfo = cloneBoundingInfo(preview.baselineFullBoundingInfo);
      this.syncEntityTransformPreviewMeshBounds(preview.batch);
    }

    this.lightingSourceRevision += 1;
    this.cullingDirty = true;
    if (!this.updateFrustumCulling()) {
      for (const preview of session.batches) this.syncEntityTransformPreviewRenderBuffer(preview);
    }
  }

  /** 捕获目标逻辑实体的完整矩阵基线，后续旋转预览始终按绝对世界增量矩阵重算。 */
  beginEntityRotationPreview(entityIds: ReadonlySet<string>): boolean {
    this.transformUpdateSnapshot = null;
    if (this.rotationPreviewSession) this.endEntityRotationPreview(true);
    if (this.translationPreviewSession) this.endEntityTranslationPreview(true);
    const selectedEntityIndexes = new Set<number>();
    for (const entityId of entityIds) {
      const entityIndex = this.entityIndexById.get(entityId);
      if (entityIndex !== undefined) selectedEntityIndexes.add(entityIndex);
    }
    if (selectedEntityIndexes.size === 0) return false;

    const previewBatches: EntityArrayRotationPreviewBatch[] = [];
    for (const batch of this.batches) {
      const sourceMatrices = batch.sourceMatrixBuffer;
      const sourceEntityIndexes = batch.sourceEntityIndexBuffer;
      if (!sourceMatrices || !sourceEntityIndexes) continue;

      const matchingIndexes: number[] = [];
      for (let sourceIndex = 0; sourceIndex < sourceEntityIndexes.length; sourceIndex += 1) {
        if (selectedEntityIndexes.has(sourceEntityIndexes[sourceIndex])) matchingIndexes.push(sourceIndex);
      }
      if (matchingIndexes.length === 0) continue;

      const sourceInstanceIndexes = Uint32Array.from(matchingIndexes);
      const baselineMatrices = new Float64Array(sourceInstanceIndexes.length * 16);
      for (let index = 0; index < sourceInstanceIndexes.length; index += 1) {
        const matrixOffset = sourceInstanceIndexes[index] * 16;
        baselineMatrices.set(sourceMatrices.subarray(matrixOffset, matrixOffset + 16), index * 16);
      }
      previewBatches.push({
        batch,
        sourceInstanceIndexes,
        sourceInstanceIndexSet: new Set(sourceInstanceIndexes),
        baselineMatrices,
        baselineFullBoundingInfo: cloneBoundingInfo(batch.fullBoundingInfo),
      });
    }
    if (previewBatches.length === 0) return false;

    this.rotationPreviewSession = { batches: previewBatches };
    return true;
  }

  /** 将同一刚体世界增量矩阵应用到目标实体的全部源实例，保持 determinant 分片和实体映射不变。 */
  updateEntityRotationPreview(deltaMatrixData: readonly number[]): boolean {
    const session = this.rotationPreviewSession;
    if (!session || !isFiniteMatrixData(deltaMatrixData)) return false;
    const deltaMatrix = Matrix.FromArray(Array.from(deltaMatrixData));
    if (!isRigidTransformMatrix(deltaMatrix)) return false;

    // 先验证全部 carrier，再统一改写源矩阵，避免后续批次不可逆时留下部分旋转结果。
    const preparedBatches: Array<{
      preview: EntityArrayRotationPreviewBatch;
      sourceMatrices: Float32Array;
      carrierLocalDelta: Matrix;
    }> = [];
    for (const preview of session.batches) {
      const sourceMatrices = preview.batch.sourceMatrixBuffer;
      if (!sourceMatrices) return false;

      preview.batch.mesh.computeWorldMatrix(true);
      const carrierWorldMatrix = preview.batch.mesh.getWorldMatrix().clone();
      const inverseCarrierWorldMatrix = carrierWorldMatrix.clone();
      const determinant = inverseCarrierWorldMatrix.determinant();
      if (!Number.isFinite(determinant) || Math.abs(determinant) <= ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON) {
        return false;
      }
      inverseCarrierWorldMatrix.invert();
      const carrierLocalDelta = carrierWorldMatrix.multiply(deltaMatrix).multiply(inverseCarrierWorldMatrix);
      if (!isFiniteMatrix(carrierLocalDelta)) return false;
      preparedBatches.push({ preview, sourceMatrices, carrierLocalDelta });
    }

    for (const { preview, sourceMatrices, carrierLocalDelta } of preparedBatches) {
      for (let index = 0; index < preview.sourceInstanceIndexes.length; index += 1) {
        Matrix.FromArrayToRef(preview.baselineMatrices, index * 16, this.rotationPreviewBaselineMatrix);
        this.rotationPreviewBaselineMatrix.multiplyToRef(carrierLocalDelta, this.rotationPreviewResultMatrix);
        this.rotationPreviewResultMatrix.copyToArray(
          sourceMatrices,
          preview.sourceInstanceIndexes[index] * 16,
        );
      }
      this.refreshEntityTransformPreviewBatch(preview);
    }

    this.lightingSourceRevision += 1;
    this.cullingDirty = true;
    if (!this.updateFrustumCulling()) {
      for (const preview of session.batches) this.syncEntityTransformPreviewRenderBuffer(preview);
    }
    return true;
  }

  /** 结束逻辑实体旋转预览；取消时恢复完整矩阵和包围盒基线。 */
  endEntityRotationPreview(restore: boolean): void {
    const session = this.rotationPreviewSession;
    if (!session) return;
    this.rotationPreviewSession = null;

    if (!restore) return;
    for (const preview of session.batches) {
      const sourceMatrices = preview.batch.sourceMatrixBuffer;
      if (!sourceMatrices) continue;
      for (let index = 0; index < preview.sourceInstanceIndexes.length; index += 1) {
        sourceMatrices.set(
          preview.baselineMatrices.subarray(index * 16, index * 16 + 16),
          preview.sourceInstanceIndexes[index] * 16,
        );
      }
      preview.batch.fullBoundingInfo = cloneBoundingInfo(preview.baselineFullBoundingInfo);
      this.syncEntityTransformPreviewMeshBounds(preview.batch);
    }

    this.lightingSourceRevision += 1;
    this.cullingDirty = true;
    if (!this.updateFrustumCulling()) {
      for (const preview of session.batches) this.syncEntityTransformPreviewRenderBuffer(preview);
    }
  }

  /** 刷新预览矩阵对应的当前可见 GPU 区间，并扩展完整分片包围盒。 */
  private refreshEntityTransformPreviewBatch(preview: EntityArrayTransformPreviewBatch): void {
    const baselineBounds = preview.baselineFullBoundingInfo?.boundingBox;
    if (baselineBounds) {
      const minimum = baselineBounds.minimumWorld.clone();
      const maximum = baselineBounds.maximumWorld.clone();
      const rawBounds = preview.batch.mesh.rawBoundingInfo?.boundingBox;
      const sourceMatrices = preview.batch.sourceMatrixBuffer;
      if (rawBounds && sourceMatrices) {
        preview.batch.mesh.computeWorldMatrix(true);
        const batchWorldMatrix = preview.batch.mesh.getWorldMatrix();
        for (const sourceIndex of preview.sourceInstanceIndexes) {
          Matrix.FromArrayToRef(sourceMatrices, sourceIndex * 16, this.cullingInstanceMatrix);
          this.cullingInstanceMatrix.multiplyToRef(batchWorldMatrix, this.cullingWorldMatrix);
          Vector3.TransformCoordinatesToRef(rawBounds.center, this.cullingWorldMatrix, this.cullingCenter);
          calculateTransformedExtentToRef(rawBounds.extendSize, this.cullingWorldMatrix, this.transformPreviewExtent);
          minimum.set(
            Math.min(minimum.x, this.cullingCenter.x - this.transformPreviewExtent.x),
            Math.min(minimum.y, this.cullingCenter.y - this.transformPreviewExtent.y),
            Math.min(minimum.z, this.cullingCenter.z - this.transformPreviewExtent.z),
          );
          maximum.set(
            Math.max(maximum.x, this.cullingCenter.x + this.transformPreviewExtent.x),
            Math.max(maximum.y, this.cullingCenter.y + this.transformPreviewExtent.y),
            Math.max(maximum.z, this.cullingCenter.z + this.transformPreviewExtent.z),
          );
        }
      }
      preview.batch.fullBoundingInfo = new BoundingInfo(minimum, maximum);
      preview.batch.lastFrustumContainment = -1;
      this.syncEntityTransformPreviewMeshBounds(preview.batch);
    }
  }

  /** 使用完整预览世界包围盒保持 Mesh active，避免视锥进出后沿用旧可见前缀边界。 */
  private syncEntityTransformPreviewMeshBounds(batch: EntityArrayMatrixBatch): void {
    const fullBounds = cloneBoundingInfo(batch.fullBoundingInfo);
    if (fullBounds) batch.mesh.setBoundingInfo(fullBounds);
  }

  /** 当前相机可见前缀保持原布局时，只覆盖受影响的矩阵行。 */
  private syncEntityTransformPreviewRenderBuffer(preview: EntityArrayTransformPreviewBatch): void {
    const batch = preview.batch;
    const sourceMatrices = batch.sourceMatrixBuffer;
    const renderMatrices = batch.matrixBuffer;
    const visibleSourceIndexes = batch.visibleSourceIndexBuffer;
    if (!sourceMatrices || !renderMatrices || !visibleSourceIndexes) return;

    let changed = false;
    for (let visibleIndex = 0; visibleIndex < batch.visibleSourceIndexCount; visibleIndex += 1) {
      const sourceIndex = visibleSourceIndexes[visibleIndex];
      if (!preview.sourceInstanceIndexSet.has(sourceIndex)) continue;
      const sourceOffset = sourceIndex * 16;
      renderMatrices.set(sourceMatrices.subarray(sourceOffset, sourceOffset + 16), visibleIndex * 16);
      changed = true;
    }
    if (!changed) return;

    batch.mesh.thinInstanceBufferUpdated('matrix');
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
    const selectionIdChanged = this.selectionId !== nextSelectionId;
    this.selectedEntityIds = nextSelectedEntityIds;
    this.selectionId = nextSelectionId;
    const layoutChanged = this.selectionLayoutRevision !== this.entityLayoutRevision;
    if (!layoutChanged && !selectionIdChanged && changedEntityIds.size === 0) {
      // SelectionOutlineLayer.addSelection() 会把 thinInstance 属性替换成整批全选数组。
      // 即使逻辑选区未变化，也必须重新绑定本批次维护的权威缓冲，避免同类型实体一起高亮。
      for (const batch of this.batches) {
        if (batch.mesh.thinInstanceCount <= 0 || !batch.selectionBuffer) continue;
        batch.mesh.thinInstanceSetBuffer(
          INSTANCE_SELECTION_ID_BUFFER,
          batch.selectionBuffer,
          1,
          false,
        );
      }
      return;
    }

    for (const batch of this.batches) {
      const instanceCount = batch.mesh.thinInstanceCount;
      if (instanceCount <= 0) continue;

      const previousSelectionBuffer = batch.selectionBuffer;
      const selectionCapacity = Math.max(instanceCount, batch.entityIndexBuffer?.length ?? 0);
      const selectionBuffer = acquireFloatBuffer(previousSelectionBuffer, selectionCapacity);
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

      // Babylon 的描边层可能已经替换 Mesh 内部绑定的数据引用；不能只通知旧 GPU 缓冲更新。
      // 每次选择同步都重新绑定权威数组，确保同批次中只有目标逻辑实体获得 Selection ID。
      batch.mesh.thinInstanceSetBuffer(INSTANCE_SELECTION_ID_BUFFER, selectionBuffer, 1, false);
      batch.selectionBuffer = selectionBuffer;
    }

    this.selectionLayoutRevision = this.entityLayoutRevision;
  }

  /** 同步整体显隐和拾取状态，主要供临时预览及兼容调用使用。 */
  setInteractionState(visible: boolean, pickable: boolean): void {
    for (const batch of this.batches) {
      if (batch.requestedVisible !== visible) this.lightingSourceRevision += 1;
      applyBatchInteractionState(batch, visible, pickable && this.interactive);
    }
  }

  /** 只释放批次自身的隔离 Geometry，保留源材质、纹理、骨骼和源模型节点。 */
  dispose(): void {
    this.transformUpdateSnapshot = null;
    if (this.frustumObserver && this.scene) {
      this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.frustumObserver);
      this.frustumObserver = null;
    }
    disposeBatches(this.batches);
    this.lightingHiddenInstances.clear();
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
    this.translationPreviewSession = null;
    this.rotationPreviewSession = null;
    this.entityLayoutRevision = 0;
    this.selectionLayoutRevision = -1;
  }
}
