import {
  AbstractMesh,
  BoundingInfo,
  Constants,
  type InstancedMesh,
  type Material,
  Matrix,
  type Observer,
  PBRMaterial,
  Mesh,
  Quaternion,
  RenderingGroup,
  StandardMaterial,
  SubMesh,
  type Plane,
  type Scene,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import type { Vector3Data } from '../../editor/model/math';

const ENTITY_ARRAY_MATRIX_INSTANCE_LIMIT = 1_000_000;
const ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON = 1e-12;
const ENTITY_ARRAY_ROTATION_SCALE_EPSILON = 1e-6;
const INSTANCE_SELECTION_ID_BUFFER = 'instanceSelectionId';
const FRONT_TO_BACK_RENDERING_GROUPS_BY_SCENE = new WeakMap<Scene, Set<number>>();
/** 正式矩阵批次按空间顺序分片，让 Babylon 能以批次包围盒做视锥裁剪；不减少任何实例或几何。 */
const FORMAL_BATCH_MIN_INSTANCES_PER_PARTITION = 128;
const FORMAL_BATCH_MAX_INSTANCES_PER_PARTITION = 65_536;
const FORMAL_BATCH_TARGET_VERTEX_INVOCATIONS_PER_PARTITION = 32_000_000;
const FORMAL_BATCH_MIN_PARTITION_SPAN_METERS = 32;
/** 单个合并载体的静态顶点预算，避免把高密度内部 thinInstance 意外展开成超大 Geometry。 */
const STATIC_MERGE_MAX_VERTICES = 262_144;
const STATIC_MERGE_MAX_INDICES = 786_432;
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
  // SelectionOutline/thinInstance 生命周期结束后 Babylon 可能在共享 Geometry 上保留这些实例属性；
  // getSourceMatrixCount() 已保证此处没有活动 thinInstance，静态 VertexData 合并应忽略它们。
  'world0',
  'world1',
  'world2',
  'world3',
  VertexBuffer.MatricesIndicesKind,
  VertexBuffer.MatricesWeightsKind,
  VertexBuffer.MatricesIndicesExtraKind,
  VertexBuffer.MatricesWeightsExtraKind,
]);

type EntityArrayMatrixOrientation = 1 | -1;
type EntityArrayFrustumContainment = -1 | 0 | 1 | 2;

type EntityArrayMatrixBatch = {
  mesh: Mesh;
  sourceMesh: AbstractMesh;
  batchSource: Mesh;
  /** 当前提交给 GPU 的可见矩阵缓冲，容量保持为完整分片大小。 */
  matrixBuffer: Float32Array | null;
  selectionBuffer: Float32Array | null;
  /** 当前可见 thinInstanceIndex 到逻辑实体索引的映射。 */
  entityIndexBuffer: Uint32Array | null;
  entityInstanceRangeStarts: Int32Array | null;
  entityInstanceRangeCounts: Uint32Array | null;
  /** 完整分片数据不受相机裁剪影响，供相机移动时重新生成可见前缀。 */
  sourceMatrixBuffer: Float32Array | null;
  sourceEntityIndexBuffer: Uint32Array | null;
  visibleSourceIndexBuffer: Uint32Array | null;
  cullingScratchIndexBuffer: Uint32Array | null;
  visibleSourceIndexCount: number;
  fullBoundingInfo: BoundingInfo | null;
  requestedVisible: boolean;
  requestedPickable: boolean;
  orientation: EntityArrayMatrixOrientation;
  partitionIndex: number;
  /** -1 未评估、0 完全在视锥外、1 相交、2 完全在视锥内。 */
  lastFrustumContainment: EntityArrayFrustumContainment;
  /** 隐藏参数脚本宿主时，批次仍使用宿主隐藏前的渲染层。 */
  layerMask: number | null;
};

type EntityArrayMatrixCandidate = {
  meshIndex: number;
  sourceMesh: AbstractMesh;
  /** 同一 Geometry 的静态叶 Mesh 可共享一个批次，矩阵仍逐叶保留。 */
  sourceMeshes: AbstractMesh[];
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
  matrixScratchByOrientation: Partial<Record<EntityArrayMatrixOrientation, Float32Array>>;
  entityIndexScratchByOrientation: Partial<Record<EntityArrayMatrixOrientation, Uint32Array>>;
};

type CapturedEntityArrayMatrix = {
  matrix: Matrix;
  orientation: EntityArrayMatrixOrientation;
};

type PreparedEntityArraySpatialPartitions = {
  sourceInstanceIndexesByPartition: number[][] | null;
  batches: EntityArrayMatrixBatch[];
};

type EntityArrayTransformPreviewBatch = {
  batch: EntityArrayMatrixBatch;
  sourceInstanceIndexes: Uint32Array;
  sourceInstanceIndexSet: Set<number>;
  baselineFullBoundingInfo: BoundingInfo | null;
};

type EntityArrayTranslationPreviewBatch = EntityArrayTransformPreviewBatch & {
  baselineTranslations: Float64Array;
};

type EntityArrayTranslationPreviewSession = {
  batches: EntityArrayTranslationPreviewBatch[];
};

type EntityArrayRotationPreviewBatch = EntityArrayTransformPreviewBatch & {
  baselineMatrices: Float64Array;
};

type EntityArrayRotationPreviewSession = {
  batches: EntityArrayRotationPreviewBatch[];
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

    for (const prepared of preparedPlans) {
      const activeBatches = new Set<EntityArrayMatrixBatch>();
      if (prepared.positiveBatch && prepared.positiveBuffer && prepared.positiveEntityIndexes) {
        if (this.interactive && prepared.positiveSpatialPartitions) {
          for (const batch of this.commitPreparedSpatialEntityPartitions(
            prepared.positiveBuffer,
            prepared.positiveEntityIndexes,
            instances,
            prepared.positiveSpatialPartitions,
          )) activeBatches.add(batch);
        } else if (prepared.positiveEntityRangeStarts && prepared.positiveEntityRangeCounts) {
          prepared.positiveBatch.entityIndexBuffer = prepared.positiveEntityIndexes;
          prepared.positiveBatch.entityInstanceRangeStarts = prepared.positiveEntityRangeStarts;
          prepared.positiveBatch.entityInstanceRangeCounts = prepared.positiveEntityRangeCounts;
          commitMatrixBuffer(prepared.positiveBatch, prepared.positiveBuffer, prepared.plan.positiveCount, true);
          applyBatchInteractionState(prepared.positiveBatch, true, hasPickableEntity);
          activeBatches.add(prepared.positiveBatch);
        }
      }
      if (prepared.negativeBatch && prepared.negativeBuffer && prepared.negativeEntityIndexes) {
        if (this.interactive && prepared.negativeSpatialPartitions) {
          for (const batch of this.commitPreparedSpatialEntityPartitions(
            prepared.negativeBuffer,
            prepared.negativeEntityIndexes,
            instances,
            prepared.negativeSpatialPartitions,
          )) activeBatches.add(batch);
        } else if (prepared.negativeEntityRangeStarts && prepared.negativeEntityRangeCounts) {
          prepared.negativeBatch.entityIndexBuffer = prepared.negativeEntityIndexes;
          prepared.negativeBatch.entityInstanceRangeStarts = prepared.negativeEntityRangeStarts;
          prepared.negativeBatch.entityInstanceRangeCounts = prepared.negativeEntityRangeCounts;
          commitMatrixBuffer(prepared.negativeBatch, prepared.negativeBuffer, prepared.plan.negativeCount, true);
          applyBatchInteractionState(prepared.negativeBatch, true, hasPickableEntity);
          activeBatches.add(prepared.negativeBatch);
        }
      }
      this.deactivateUnusedBatches(prepared.plan.source, activeBatches);
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
    this.cullingDirty = true;
    this.updateFrustumCulling();
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
   */
  private commitPreparedSpatialEntityPartitions(
    matrixBuffer: Float32Array,
    entityIndexBuffer: Uint32Array,
    instances: readonly EntityArrayThinInstanceTransform[],
    prepared: PreparedEntityArraySpatialPartitions,
  ): EntityArrayMatrixBatch[] {
    const partitions = prepared.sourceInstanceIndexesByPartition;
    if (!partitions) {
      const batch = prepared.batches[0]!;
      this.commitInteractiveBatchSource(batch, matrixBuffer, entityIndexBuffer, instances.length);
      applyBatchInteractionState(
        batch,
        true,
        entityIndexBuffer.some((entityIndex) => instances[entityIndex]?.pickable === true),
      );
      return [batch];
    }

    const activeBatches: EntityArrayMatrixBatch[] = [];
    for (let partitionIndex = 0; partitionIndex < partitions.length; partitionIndex += 1) {
      const sourceInstanceIndexes: number[] = partitions[partitionIndex]!;
      const batch = prepared.batches[partitionIndex]!;
      const partitionMatrixBuffer = acquireFloatBuffer(batch.sourceMatrixBuffer, sourceInstanceIndexes.length * 16);
      const partitionEntityIndexes = acquireEntityIndexBuffer(
        batch.sourceEntityIndexBuffer,
        sourceInstanceIndexes.length,
      );
      let pickable = false;

      for (let partitionInstanceIndex = 0; partitionInstanceIndex < sourceInstanceIndexes.length; partitionInstanceIndex += 1) {
        const sourceInstanceIndex: number = sourceInstanceIndexes[partitionInstanceIndex];
        const entityIndex = entityIndexBuffer[sourceInstanceIndex];
        partitionMatrixBuffer.set(
          matrixBuffer.subarray(sourceInstanceIndex * 16, sourceInstanceIndex * 16 + 16),
          partitionInstanceIndex * 16,
        );
        partitionEntityIndexes[partitionInstanceIndex] = entityIndex;
        if (instances[entityIndex]?.pickable) pickable = true;
      }

      this.commitInteractiveBatchSource(
        batch,
        partitionMatrixBuffer,
        partitionEntityIndexes,
        instances.length,
      );
      applyBatchInteractionState(batch, true, pickable);
      activeBatches.push(batch);
    }
    return activeBatches;
  }

  /** 保存完整分片，并使用独立 GPU 缓冲承载当前可见前缀，避免相机裁剪破坏完整矩阵。 */
  private commitInteractiveBatchSource(
    batch: EntityArrayMatrixBatch,
    sourceMatrixBuffer: Float32Array,
    sourceEntityIndexBuffer: Uint32Array,
    entityCount: number,
  ): void {
    const instanceCount = sourceEntityIndexBuffer.length;
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
    renderMatrixBuffer.set(completeSourceMatrixBuffer);
    renderEntityIndexBuffer.set(completeSourceEntityIndexBuffer);
    batch.entityIndexBuffer = renderEntityIndexBuffer;
    const ranges = createEntityInstanceRanges(renderEntityIndexBuffer, entityCount, instanceCount);
    batch.entityInstanceRangeStarts = ranges.starts;
    batch.entityInstanceRangeCounts = ranges.counts;
    const visibleSourceIndexes = acquireEntityIndexBuffer(batch.visibleSourceIndexBuffer, instanceCount);
    for (let index = 0; index < instanceCount; index += 1) visibleSourceIndexes[index] = index;
    batch.visibleSourceIndexBuffer = visibleSourceIndexes;
    batch.visibleSourceIndexCount = instanceCount;
    commitMatrixBuffer(batch, renderMatrixBuffer, instanceCount, true);
    const bounds = batch.mesh.getBoundingInfo().boundingBox;
    batch.fullBoundingInfo = new BoundingInfo(bounds.minimumWorld.clone(), bounds.maximumWorld.clone());
    batch.lastFrustumContainment = -1;
    this.cullingDirty = true;
  }

  /** 相机变化时只上传保守视锥内的实例；完整源矩阵、参数脚本和逻辑实体始终保留。 */
  private updateFrustumCulling(refreshSelectionMask = true): boolean {
    const scene = this.scene;
    const frustumPlanes = scene?.frustumPlanes;
    const camera = scene?.activeCamera;
    if (!this.interactive || !camera || !frustumPlanes?.length) return false;
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
      layoutChanged = this.updateBatchFrustumVisibility(batch, frustumPlanes, forceMatrixUpdate)
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
    frustumPlanes: Plane[],
    forceMatrixUpdate: boolean,
  ): boolean {
    const sourceMatrixBuffer = batch.sourceMatrixBuffer;
    const sourceEntityIndexBuffer = batch.sourceEntityIndexBuffer;
    const fullBoundingInfo = batch.fullBoundingInfo;
    if (!sourceMatrixBuffer || !sourceEntityIndexBuffer || !fullBoundingInfo) return false;
    const sourceInstanceCount = sourceEntityIndexBuffer.length;

    let containment: EntityArrayFrustumContainment;
    if (!fullBoundingInfo.isInFrustum(frustumPlanes)) {
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
    if (containment !== 0) {
      const hasDynamicVertexDeformation = (batch.mesh.skeleton?.bones.length ?? 0) > 0
        || (batch.mesh.morphTargetManager?.numTargets ?? 0) > 0
        || batch.mesh.bakedVertexAnimationManager?.isEnabled === true;
      const canFineCullOriginalGeometry = containment !== 2
        && !hasDynamicVertexDeformation
        && !!batch.mesh.rawBoundingInfo;
      if (canFineCullOriginalGeometry && batch.mesh.rawBoundingInfo) {
        const sourceBox = batch.mesh.rawBoundingInfo.boundingBox;
        batch.mesh.computeWorldMatrix(true);
        const batchWorldMatrix = batch.mesh.getWorldMatrix();
        for (let sourceIndex = 0; sourceIndex < sourceInstanceCount; sourceIndex += 1) {
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
          scratchIndexes[sourceIndex] = sourceIndex;
        }
        visibleCount = sourceInstanceCount;
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
    if (sameVisibleLayout && !forceMatrixUpdate) return false;
    const visibleLayoutChanged = !sameVisibleLayout;

    const renderMatrixBuffer = acquireIndependentFloatBuffer(
      batch.matrixBuffer,
      sourceMatrixBuffer,
      sourceMatrixBuffer.length,
    );
    for (let visibleIndex = 0; visibleIndex < visibleCount; visibleIndex += 1) {
      const sourceIndex = scratchIndexes[visibleIndex];
      const sourceOffset = sourceIndex * 16;
      renderMatrixBuffer.set(sourceMatrixBuffer.subarray(sourceOffset, sourceOffset + 16), visibleIndex * 16);
    }
    if (sameVisibleLayout) {
      // 纯矩阵位移不改变可见顺序时复用实体索引和范围缓冲，拖动帧只上传矩阵。
      commitMatrixBuffer(batch, renderMatrixBuffer, visibleCount, false);
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

    this.cullingDirty = true;
    if (!this.updateFrustumCulling()) {
      for (const preview of session.batches) this.syncEntityTransformPreviewRenderBuffer(preview);
    }
  }

  /** 捕获目标逻辑实体的完整矩阵基线，后续旋转预览始终按绝对世界增量矩阵重算。 */
  beginEntityRotationPreview(entityIds: ReadonlySet<string>): boolean {
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
      applyBatchInteractionState(batch, visible, pickable && this.interactive);
    }
  }

  /** 只释放批次自身的隔离 Geometry，保留源材质、纹理、骨骼和源模型节点。 */
  dispose(): void {
    if (this.frustumObserver && this.scene) {
      this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.frustumObserver);
      this.frustumObserver = null;
    }
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
    this.translationPreviewSession = null;
    this.rotationPreviewSession = null;
    this.entityLayoutRevision = 0;
    this.selectionLayoutRevision = -1;
  }
}

/**
 * 将脚本生成的同 Geometry 静态叶 Mesh 聚合为一个矩阵源。
 * 与直接合并顶点不同，这会保留每个叶 Mesh 的完整相对矩阵，使货架梁柱、滚筒等重复部件可逐实例视锥裁剪。
 */
function groupRepeatedStaticGeometryCandidates(
  candidates: readonly EntityArrayMatrixCandidate[],
): EntityArrayMatrixCandidate[] {
  const grouped = new Map<string, EntityArrayMatrixCandidate[]>();
  const output: EntityArrayMatrixCandidate[] = [];
  const materialSignatureCache = new Map<Material, string | null>();

  for (const candidate of candidates) {
    const staticKey = createStaticMergeKey(candidate, materialSignatureCache);
    const geometryId = candidate.batchSource.geometry?.uniqueId;
    if (!staticKey || geometryId === undefined) {
      output.push(candidate);
      continue;
    }
    const key = `${geometryId}|${staticKey}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    if (group.length < 2) {
      output.push(...group);
      continue;
    }
    const representative = group.reduce((best, candidate) => (
      candidate.meshIndex < best.meshIndex ? candidate : best
    ));
    output.push({
      ...representative,
      meshIndex: Math.min(...group.map((candidate) => candidate.meshIndex)),
      sourceMeshes: group.flatMap((candidate) => candidate.sourceMeshes),
    });
  }

  return output.sort((left, right) => left.meshIndex - right.meshIndex);
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
    // Babylon 新建的跨 Geometry 无索引载体即使补齐 drawArrays 标记，PBR 纹理/光照仍可能与原 Mesh 不一致。
    // LineList/LineStrip 等拓扑也不能按三角形翻面；跨 Geometry 合并仅允许有索引三角形列表。
    if (!isIndexedTriangleListMergeCandidate(candidate)) {
      output.push(candidate);
      continue;
    }
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

/** 跨 Geometry 顶点烘焙只接受有索引三角形列表，避免反射变换破坏线或 strip 拓扑。 */
function isIndexedTriangleListMergeCandidate(candidate: EntityArrayMatrixCandidate): boolean {
  const { sourceMesh, batchSource } = candidate;
  const totalIndices = batchSource.getTotalIndices();
  if (totalIndices <= 0 || totalIndices % 3 !== 0) return false;
  const fillMode = batchSource.overrideRenderingFillMode
    ?? sourceMesh.material?.fillMode
    ?? Constants.MATERIAL_TriangleFillMode;
  if (fillMode !== Constants.MATERIAL_TriangleFillMode) return false;
  return batchSource.subMeshes.every((subMesh) => subMesh.indexCount % 3 === 0);
}

/** 返回只有视觉状态完全兼容时才相同的静态合并键。 */
function createStaticMergeKey(
  candidate: EntityArrayMatrixCandidate,
  materialSignatureCache: Map<Material, string | null>,
): string | null {
  const { sourceMesh, batchSource } = candidate;
  if (candidate.sourceMeshes.length !== 1 || getSourceMatrixCount(sourceMesh) !== 1) return null;
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
  // SelectionOutline/DepthRenderer 会在首次渲染后给标准材质追加 onBind observer；
  // observer 数量不是视觉属性，若据此拒绝合并，同一场景重导入后会从百级批次退化回数千批次。
  if ((material.animations?.length ?? 0) > 0 || material.stencil.enabled) {
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
      // Geometry 已经烘焙为一个载体，但仍保留全部源 Mesh 作为覆盖诊断，避免合并后无法确认部件完整性。
      sourceMeshes: candidates.flatMap((candidate) => candidate.sourceMeshes),
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

/** 捕获同 Geometry 叶 Mesh 的全部源根局部矩阵；任一源无效时原子失败，避免静默丢部件。 */
function captureCandidateSourceWorldMatrices(
  source: EntityArrayMatrixSource,
  inverseSourceRoot: Matrix,
): Matrix[] {
  const matrices: Matrix[] = [];
  for (const sourceMesh of source.sourceMeshes) {
    const sourceWorldMatrices = captureSourceWorldMatrices(sourceMesh);
    if (sourceWorldMatrices.length === 0) return [];
    for (const matrix of sourceWorldMatrices) matrices.push(matrix.multiply(inverseSourceRoot));
  }
  return matrices;
}

/**
 * 捕获源 Mesh 当前真正参与渲染的世界矩阵。
 * 已有 thinInstance 时需先组合 Mesh 世界矩阵，把局部实例矩阵转换为最终世界矩阵。
 */
function captureSourceWorldMatrices(mesh: AbstractMesh): Matrix[] {
  mesh.computeWorldMatrix(true);
  const meshWorldMatrix = mesh.getWorldMatrix().clone();
  if (!(mesh instanceof Mesh) || mesh.thinInstanceCount <= 0) return [meshWorldMatrix];

  const thinInstanceMatrices = readCurrentThinInstanceMatrices(mesh);
  if (!thinInstanceMatrices) return [];
  return thinInstanceMatrices.map((matrix) => matrix.multiply(meshWorldMatrix));
}

/**
 * Babylon 9.12 的 thinInstanceBufferUpdated('matrix') 不会清空 worldMatrices 缓存；
 * 优先读取当前连续 matrixData，只有不可用时才回退公共缓存。
 */
function readCurrentThinInstanceMatrices(mesh: Mesh): Matrix[] | null {
  const count = mesh.thinInstanceCount;
  const matrixData = mesh._thinInstanceDataStorage?.matrixData;
  if (matrixData && matrixData.length >= count * 16) {
    return Array.from({ length: count }, (_, index) => Matrix.FromArray(matrixData, index * 16));
  }
  const cached = mesh.thinInstanceGetWorldMatrices();
  return cached.length >= count ? cached.slice(0, count).map((matrix) => matrix.clone()) : null;
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
  partitionIndex: number,
): EntityArrayMatrixBatch {
  const orientationSuffix = orientation < 0 ? '_negativeOrientation' : '';
  const partitionSuffix = partitionIndex > 0 ? `_partition${partitionIndex}` : '';
  const batchName = `${source.namePrefix}_${source.entityId}_${source.meshIndex}${orientationSuffix}${partitionSuffix}`;
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
  ensureBatchMeshHasGlobalSubMesh(batchMesh);
  const batch: EntityArrayMatrixBatch = {
    mesh: batchMesh,
    sourceMesh: source.sourceMesh,
    batchSource: source.batchSource,
    matrixBuffer: null,
    selectionBuffer: null,
    entityIndexBuffer: null,
    entityInstanceRangeStarts: null,
    entityInstanceRangeCounts: null,
    sourceMatrixBuffer: null,
    sourceEntityIndexBuffer: null,
    visibleSourceIndexBuffer: null,
    cullingScratchIndexBuffer: null,
    visibleSourceIndexCount: 0,
    fullBoundingInfo: null,
    requestedVisible: false,
    requestedPickable: false,
    orientation,
    partitionIndex,
    lastFrustumContainment: -1,
    layerMask: source.layerMask,
  };
  prepareBatchMesh(batch, interactive, source.metadata);
  return batch;
}

/** 统一批次的 indexed/unindexed 与全局 SubMesh 语义；缺少 SubMesh 时 active mesh 不会产生绘制。 */
function ensureBatchMeshHasGlobalSubMesh(mesh: Mesh): void {
  const totalVertices = mesh.getTotalVertices();
  if (totalVertices <= 0) return;
  const totalIndices = mesh.getTotalIndices();
  mesh.isUnIndexed = totalIndices === 0;
  if (mesh.subMeshes.length > 0) return;
  new SubMesh(0, 0, totalVertices, 0, totalIndices || totalVertices, mesh);
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

  // clone() 会复制源批次的用户 thinInstance 顶点缓冲；新分片必须从空选择缓冲开始。
  batchMesh.thinInstanceSetBuffer(INSTANCE_SELECTION_ID_BUFFER, null);
  batchMesh.thinInstanceSetBuffer('matrix', null);
  syncBatchSourcePresentation(batch);

  batchMesh.metadata = metadata ? { ...metadata } : null;
  batchMesh.actionManager = null;
  batchMesh.isPickable = interactive;
  batchMesh.thinInstanceEnablePicking = interactive;
  batchMesh.doNotSerialize = true;
  batchMesh.doNotSyncBoundingInfo = true;
  batchMesh.alwaysSelectAsActiveMesh = !interactive;
  configureBatchFrontToBackRendering(batch, interactive);
  batchMesh.setEnabled(false);
}

/**
 * Babylon 默认按材质排列不透明队列；正式大场景批次改为前到后，利用 Early-Z 减少 PBR 片元过绘制。
 * 透明队列保持 Babylon 默认 back-to-front，不改变混合结果。
 */
function configureBatchFrontToBackRendering(batch: EntityArrayMatrixBatch, interactive: boolean): void {
  if (!interactive) return;
  const scene = batch.mesh.getScene();
  const renderingGroupId = batch.mesh.renderingGroupId;
  let configuredGroups = FRONT_TO_BACK_RENDERING_GROUPS_BY_SCENE.get(scene);
  if (!configuredGroups) {
    configuredGroups = new Set();
    FRONT_TO_BACK_RENDERING_GROUPS_BY_SCENE.set(scene, configuredGroups);
  }
  if (configuredGroups.has(renderingGroupId)) return;
  scene.setRenderingOrder(
    renderingGroupId,
    RenderingGroup.frontToBackSortCompare,
    RenderingGroup.frontToBackSortCompare,
    null,
  );
  configuredGroups.add(renderingGroupId);
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
  batch.requestedVisible = visible;
  batch.requestedPickable = pickable;
  syncBatchEffectiveInteractionState(batch);
}

function syncBatchEffectiveInteractionState(batch: EntityArrayMatrixBatch): void {
  syncBatchSourcePresentation(batch);
  const effectiveVisible = batch.requestedVisible
    && batch.mesh.thinInstanceCount > 0
    && batch.sourceMesh.isEnabled(false)
    && batch.sourceMesh.isVisible
    && batch.sourceMesh.visibility > 0;
  batch.mesh.isVisible = effectiveVisible;
  batch.mesh.setEnabled(effectiveVisible);
  batch.mesh.isPickable = effectiveVisible && batch.requestedPickable;
  batch.mesh.thinInstanceEnablePicking = effectiveVisible && batch.requestedPickable;
}

/**
 * 所有正式批次都按单次 GPU 顶点调用量动态分片，而不是把普通 Geometry 固定切成 512 实例。
 * 同材质静态叶 Mesh 已在上游安全烘焙为较大 Geometry；这里让小 Geometry 承载更多实例、
 * 大 Geometry 自动收紧实例数，在不删减几何的前提下同时约束 Draw Call 和单批 GPU 峰值。
 */
function resolveFormalBatchMaxInstancesPerPartition(source: EntityArrayMatrixSource): number {
  const verticesPerInstance = Math.max(1, source.batchSource.getTotalVertices());
  return Math.max(
    FORMAL_BATCH_MIN_INSTANCES_PER_PARTITION,
    Math.min(
      FORMAL_BATCH_MAX_INSTANCES_PER_PARTITION,
      Math.floor(FORMAL_BATCH_TARGET_VERTEX_INVOCATIONS_PER_PARTITION / verticesPerInstance),
    ),
  );
}

/**
 * 超过动态阈值且世界平移跨度足够大时，生成固定数量的平衡空间分片。
 * 分片数严格等于 ceil(instanceCount / maxInstancesPerPartition)，只改善包围盒紧致度。
 */
function createSpatialMatrixPartitions(
  matrixBuffer: Float32Array,
  entityIndexBuffer: Uint32Array,
  instanceCount: number,
  maxInstancesPerPartition: number,
): number[][] | null {
  if (instanceCount <= maxInstancesPerPartition) return null;
  const instanceIndexes = Array.from({ length: instanceCount }, (_, index) => index);
  const bounds = measureMatrixTranslationBounds(matrixBuffer, instanceIndexes);
  if (Math.max(...bounds.spans) < FORMAL_BATCH_MIN_PARTITION_SPAN_METERS) return null;

  const partitionCount = Math.ceil(instanceCount / maxInstancesPerPartition);
  const axisDivisions = chooseSpatialPartitionAxisDivisions(bounds.spans, partitionCount);
  let partitions: number[][] = [instanceIndexes];
  for (const { axis, divisions } of axisDivisions) {
    const nextPartitions: number[][] = [];
    for (const partition of partitions) {
      partition.sort(createMatrixTranslationComparator(matrixBuffer, axis, bounds.spans));
      for (let divisionIndex = 0; divisionIndex < divisions; divisionIndex += 1) {
        const start = Math.floor(partition.length * divisionIndex / divisions);
        const end = Math.floor(partition.length * (divisionIndex + 1) / divisions);
        if (end > start) nextPartitions.push(partition.slice(start, end));
      }
    }
    partitions = nextPartitions;
  }

  for (const partition of partitions) {
    // 同一实体在分片内保持连续，SelectionOutline 才能继续使用有界区间差量更新。
    partition.sort((left, right) => entityIndexBuffer[left] - entityIndexBuffer[right] || left - right);
  }
  return partitions;
}

type MatrixTranslationBounds = {
  spans: [number, number, number];
};

type SpatialPartitionAxisDivision = {
  axis: number;
  divisions: number;
};

/**
 * 把固定分片数因式分解到有效空间轴；以量化切片后的包围盒长宽高尽量接近为目标。
 * 例如 200m x 50m 的 10 个分片会选择 5 x 2，而不是 10 条贯穿完整 Z 轴的长条。
 */
function chooseSpatialPartitionAxisDivisions(
  spans: readonly number[],
  partitionCount: number,
): SpatialPartitionAxisDivision[] {
  const axisOrder = [0, 1, 2].sort((left, right) => spans[right] - spans[left] || left - right);
  let bestDivisions: [number, number, number] = [partitionCount, 1, 1];
  let bestScore = Number.POSITIVE_INFINITY;

  for (let first = 1; first <= partitionCount; first += 1) {
    if (partitionCount % first !== 0) continue;
    const remaining = partitionCount / first;
    for (let second = 1; second <= remaining; second += 1) {
      if (remaining % second !== 0) continue;
      const third = remaining / second;
      const divisions = [first, second, third].sort((left, right) => right - left) as [number, number, number];
      const score = scoreSpatialPartitionDivisions(spans, axisOrder, divisions);
      if (score < bestScore) {
        bestScore = score;
        bestDivisions = divisions;
      }
    }
  }

  return axisOrder
    .map((axis, index) => ({ axis, divisions: bestDivisions[index] }))
    .filter(({ divisions }) => divisions > 1);
}

function scoreSpatialPartitionDivisions(
  spans: readonly number[],
  axisOrder: readonly number[],
  divisions: readonly number[],
): number {
  const cellSpans: number[] = [];
  let invalidAxisPenalty = 0;
  for (let index = 0; index < axisOrder.length; index += 1) {
    const span = spans[axisOrder[index]];
    const division = divisions[index];
    if (span <= 1e-6) {
      if (division > 1) invalidAxisPenalty += division * 1_000_000;
      continue;
    }
    cellSpans.push(span / division);
  }
  if (cellSpans.length <= 1) return invalidAxisPenalty;
  const logarithms = cellSpans.map((span) => Math.log(Math.max(span, 1e-6)));
  const mean = logarithms.reduce((total, value) => total + value, 0) / logarithms.length;
  const variance = logarithms.reduce((total, value) => total + (value - mean) ** 2, 0);
  return invalidAxisPenalty + variance;
}

function createMatrixTranslationComparator(
  matrixBuffer: Float32Array,
  primaryAxis: number,
  spans: readonly number[],
): (left: number, right: number) => number {
  const axisOrder = [primaryAxis, ...[0, 1, 2]
    .filter((axis) => axis !== primaryAxis)
    .sort((left, right) => spans[right] - spans[left] || left - right)];
  const translationOffsets = axisOrder.map((axis) => 12 + axis);
  return (left, right) => {
    const leftOffset = left * 16;
    const rightOffset = right * 16;
    for (const translationOffset of translationOffsets) {
      const delta = matrixBuffer[leftOffset + translationOffset] - matrixBuffer[rightOffset + translationOffset];
      if (delta !== 0) return delta;
    }
    return left - right;
  };
}

function measureMatrixTranslationBounds(
  matrixBuffer: Float32Array,
  instanceIndexes: readonly number[],
): MatrixTranslationBounds {
  const minimums = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const maximums = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const instanceIndex of instanceIndexes) {
    const matrixOffset = instanceIndex * 16 + 12;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = matrixBuffer[matrixOffset + axis];
      minimums[axis] = Math.min(minimums[axis], value);
      maximums[axis] = Math.max(maximums[axis], value);
    }
  }
  return {
    spans: [
      maximums[0] - minimums[0],
      maximums[1] - minimums[1],
      maximums[2] - minimums[2],
    ],
  };
}

function createEntityInstanceRanges(
  entityIndexBuffer: Uint32Array,
  entityCount: number,
  instanceCount = entityIndexBuffer.length,
): { starts: Int32Array; counts: Uint32Array } {
  const starts = createEntityRangeStarts(entityCount);
  const counts = new Uint32Array(entityCount);
  for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
    appendEntityInstanceRange(starts, counts, entityIndexBuffer[instanceIndex], instanceIndex);
  }
  return { starts, counts };
}

function acquireIndependentFloatBuffer(
  current: Float32Array | null,
  source: Float32Array,
  length: number,
): Float32Array {
  return current && current !== source && current.length === length ? current : new Float32Array(length);
}

function acquireIndependentEntityIndexBuffer(
  current: Uint32Array | null,
  source: Uint32Array,
  length: number,
): Uint32Array {
  return current && current !== source && current.length === length ? current : new Uint32Array(length);
}

/**
 * 将局部 AABB 通过实例仿射矩阵视为平行六面体，并以中心/三个半轴投影做保守视锥测试。
 * 相比最大轴包围球，这对货架、轨道、输送线等长条几何显著减少假可见；
 * 非均匀缩放、旋转甚至剪切仍使用完整线性矩阵投影，不会误裁真实可见几何。
 */
function isTransformedBoxInFrustum(
  localCenter: Vector3,
  localExtent: Vector3,
  worldMatrix: Matrix,
  frustumPlanes: Plane[],
  scratchCenter: Vector3,
): boolean {
  Vector3.TransformCoordinatesToRef(localCenter, worldMatrix, scratchCenter);
  const matrix = worldMatrix.m;
  for (const plane of frustumPlanes) {
    const normal = plane.normal;
    const projectedRadius = (
      localExtent.x * Math.abs(normal.x * matrix[0] + normal.y * matrix[1] + normal.z * matrix[2])
      + localExtent.y * Math.abs(normal.x * matrix[4] + normal.y * matrix[5] + normal.z * matrix[6])
      + localExtent.z * Math.abs(normal.x * matrix[8] + normal.y * matrix[9] + normal.z * matrix[10])
    );
    const signedDistance = Vector3.Dot(normal, scratchCenter) + plane.d;
    // 非有限矩阵继续保留实例，由后续 Babylon 渲染路径处理，绝不能因诊断优化误删几何。
    if (!Number.isFinite(projectedRadius) || !Number.isFinite(signedDistance)) return true;
    if (signedDistance < -projectedRadius) return false;
  }
  return true;
}

function isFiniteVector3Data(value: Vector3Data): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function cloneBoundingInfo(bounds: BoundingInfo | null): BoundingInfo | null {
  if (!bounds) return null;
  return new BoundingInfo(
    bounds.boundingBox.minimumWorld.clone(),
    bounds.boundingBox.maximumWorld.clone(),
  );
}

function calculateTransformedExtentToRef(localExtent: Vector3, worldMatrix: Matrix, result: Vector3): void {
  const matrix = worldMatrix.m;
  result.set(
    localExtent.x * Math.abs(matrix[0]) + localExtent.y * Math.abs(matrix[4]) + localExtent.z * Math.abs(matrix[8]),
    localExtent.x * Math.abs(matrix[1]) + localExtent.y * Math.abs(matrix[5]) + localExtent.z * Math.abs(matrix[9]),
    localExtent.x * Math.abs(matrix[2]) + localExtent.y * Math.abs(matrix[6]) + localExtent.z * Math.abs(matrix[10]),
  );
}

function acquireFloatBuffer(current: Float32Array | null, length: number): Float32Array {
  return current?.length === length ? current : new Float32Array(length);
}

/** 候选矩阵不得复用当前正在渲染或供视锥裁剪读取的缓冲。 */
function acquireDetachedFloatBuffer(
  current: Float32Array | null,
  batches: readonly EntityArrayMatrixBatch[],
  length: number,
): Float32Array {
  const conflictsWithActiveBatch = current !== null && batches.some((batch) => (
    batch.matrixBuffer === current || batch.sourceMatrixBuffer === current
  ));
  return current && !conflictsWithActiveBatch && current.length === length
    ? current
    : new Float32Array(length);
}

/** 候选实体索引不得覆盖当前 GPU 前缀、完整分片或裁剪临时索引。 */
function acquireDetachedEntityIndexBuffer(
  current: Uint32Array | null,
  batches: readonly EntityArrayMatrixBatch[],
  length: number,
): Uint32Array {
  const conflictsWithActiveBatch = current !== null && batches.some((batch) => (
    batch.entityIndexBuffer === current
    || batch.sourceEntityIndexBuffer === current
    || batch.visibleSourceIndexBuffer === current
    || batch.cullingScratchIndexBuffer === current
  ));
  return current && !conflictsWithActiveBatch && current.length === length
    ? current
    : new Uint32Array(length);
}


/** 清空闲置主载体的历史峰值矩阵/选择/包围盒缓冲，但保留唯一 Geometry 供后续重建。 */
function resetInactiveBatchBuffers(batch: EntityArrayMatrixBatch): void {
  batch.mesh.thinInstanceSetBuffer(INSTANCE_SELECTION_ID_BUFFER, null);
  batch.mesh.thinInstanceSetBuffer('matrix', null);
  batch.mesh.thinInstanceCount = 0;
  batch.matrixBuffer = null;
  batch.selectionBuffer = null;
  batch.entityIndexBuffer = null;
  batch.entityInstanceRangeStarts = null;
  batch.entityInstanceRangeCounts = null;
  batch.sourceMatrixBuffer = null;
  batch.sourceEntityIndexBuffer = null;
  batch.visibleSourceIndexBuffer = null;
  batch.cullingScratchIndexBuffer = null;
  batch.visibleSourceIndexCount = 0;
  batch.fullBoundingInfo = null;
  batch.lastFrustumContainment = -1;
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

function isFiniteMatrixData(value: readonly number[]): boolean {
  return value.length === 16 && value.every(Number.isFinite);
}

function isRigidTransformMatrix(matrix: Matrix): boolean {
  if (!isFiniteMatrix(matrix)) return false;
  const scaling = new Vector3();
  const rotation = new Quaternion();
  const translation = new Vector3();
  if (!matrix.decompose(scaling, rotation, translation)) return false;
  return Math.abs(scaling.x - 1) <= ENTITY_ARRAY_ROTATION_SCALE_EPSILON
    && Math.abs(scaling.y - 1) <= ENTITY_ARRAY_ROTATION_SCALE_EPSILON
    && Math.abs(scaling.z - 1) <= ENTITY_ARRAY_ROTATION_SCALE_EPSILON;
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
