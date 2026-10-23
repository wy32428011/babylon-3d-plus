import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import { RenderingGroup } from '@babylonjs/core/Rendering/renderingGroup.js';
import type { InstancedMesh } from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import type { Vector3Data } from '../../editor/model/math';
import { ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON, ENTITY_ARRAY_ROTATION_SCALE_EPSILON, INSTANCE_SELECTION_ID_BUFFER, FRONT_TO_BACK_RENDERING_GROUPS_BY_SCENE, FORMAL_BATCH_MIN_INSTANCES_PER_PARTITION, FORMAL_BATCH_MAX_INSTANCES_PER_PARTITION, FORMAL_BATCH_TARGET_VERTEX_INVOCATIONS_PER_PARTITION, FORMAL_BATCH_MIN_PARTITION_SPAN_METERS, type EntityArrayMatrixOrientation, type EntityArrayMatrixBatch, type EntityArrayMatrixSource, type CapturedEntityArrayMatrix } from './thinInstanceBatchTypes';


export function resolveBatchSourceMesh(mesh: AbstractMesh): Mesh | null {
  if (mesh instanceof Mesh) return mesh;
  if (!mesh.isAnInstance) return null;
  return (mesh as InstancedMesh).sourceMesh ?? null;
}

/** 读取源 Mesh 当前真正参与渲染的矩阵数量。 */
export function getSourceMatrixCount(mesh: AbstractMesh): number {
  return mesh instanceof Mesh && mesh.thinInstanceCount > 0 ? mesh.thinInstanceCount : 1;
}

/** 捕获同 Geometry 叶 Mesh 的全部源根局部矩阵；任一源无效时原子失败，避免静默丢部件。 */
export function captureCandidateSourceWorldMatrices(
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
export function captureSourceWorldMatrices(mesh: AbstractMesh): Matrix[] {
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
export function readCurrentThinInstanceMatrices(mesh: Mesh): Matrix[] | null {
  const count = mesh.thinInstanceCount;
  const matrixData = mesh._thinInstanceDataStorage?.matrixData;
  if (matrixData && matrixData.length >= count * 16) {
    return Array.from({ length: count }, (_, index) => Matrix.FromArray(matrixData, index * 16));
  }
  const cached = mesh.thinInstanceGetWorldMatrices();
  return cached.length >= count ? cached.slice(0, count).map((matrix) => matrix.clone()) : null;
}

/** 捕获矩阵的 determinant 方向；退化矩阵继续按正方向提交，保持既有零缩放语义。 */
export function captureMatrixOrientations(matrices: readonly Matrix[]): CapturedEntityArrayMatrix[] | null {
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
export function getMatrixOrientation(matrix: Matrix): EntityArrayMatrixOrientation | null {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant)) return null;
  return determinant < -ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON ? -1 : 1;
}


/** 为同一个几何源创建固定数量批次中的一个 Mesh。 */
export function createMatrixBatch(
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
export function ensureBatchMeshHasGlobalSubMesh(mesh: Mesh): void {
  const totalVertices = mesh.getTotalVertices();
  if (totalVertices <= 0) return;
  const totalIndices = mesh.getTotalIndices();
  mesh.isUnIndexed = totalIndices === 0;
  if (mesh.subMeshes.length > 0) return;
  new SubMesh(0, 0, totalVertices, 0, totalIndices || totalVertices, mesh);
}

/** 把几何源克隆重置为世界批次，并隔离源节点的行为与动画绑定。 */
export function prepareBatchMesh(
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
export function configureBatchFrontToBackRendering(batch: EntityArrayMatrixBatch, interactive: boolean): void {
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
export function applyBatchOrientation(
  batch: EntityArrayMatrixBatch,
  orientation: EntityArrayMatrixOrientation,
): void {
  batch.orientation = orientation;
  // carrier 始终是无父级的固定坐标系，实体/父组变换保存在实例矩阵内；改绕序时才重建世界矩阵。
  batch.mesh.unfreezeWorldMatrix();
  batch.mesh.scaling.copyFromFloats(orientation, 1, 1);
  batch.mesh.freezeWorldMatrix(batch.mesh.computeWorldMatrix(true));
}

/** 让批次持续共享源 Mesh 的最终视觉资源，而不复制脚本或实体状态。 */
export function syncBatchSourcePresentation(batch: EntityArrayMatrixBatch): void {
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

/** 逐元素比对矩阵与实体索引缓冲：全等时跳过提交，避免每帧重写 GPU 缓冲与包围盒。 */
export function isCommittedBatchStateUnchanged(
  matrixBuffer: Float32Array | null,
  entityIndexBuffer: Uint32Array | null,
  nextMatrixBuffer: Float32Array,
  nextEntityIndexBuffer: Uint32Array,
): boolean {
  if (!matrixBuffer || !entityIndexBuffer) return false;
  if (matrixBuffer.length !== nextMatrixBuffer.length || entityIndexBuffer.length !== nextEntityIndexBuffer.length) return false;
  for (let index = 0; index < nextMatrixBuffer.length; index += 1) {
    if (matrixBuffer[index] !== nextMatrixBuffer[index]) return false;
  }
  for (let index = 0; index < nextEntityIndexBuffer.length; index += 1) {
    if (entityIndexBuffer[index] !== nextEntityIndexBuffer[index]) return false;
  }
  return true;
}

/** 一次注册或更新矩阵缓冲，并按需刷新正式阵列整体包围盒。 */
export function commitMatrixBuffer(
  batch: EntityArrayMatrixBatch,
  matrixBuffer: Float32Array,
  instanceCount: number,
  refreshBoundingInfo: boolean,
): void {
  if (matrixBuffer !== batch.matrixBuffer) {
    batch.mesh.thinInstanceSetBuffer('matrix', matrixBuffer, 16, false);
    batch.matrixBuffer = matrixBuffer;
    batch.mesh.thinInstanceCount = instanceCount;
  } else {
    // Babylon 按调用时的 thinInstanceCount 决定上传矩阵行数，扩容时必须先更新数量。
    batch.mesh.thinInstanceCount = instanceCount;
    batch.mesh.thinInstanceBufferUpdated('matrix');
  }
  syncBatchSourcePresentation(batch);
  if (refreshBoundingInfo) batch.mesh.thinInstanceRefreshBoundingInfo(true);
}

/** 批次不继承源实体根节点的 enabled 状态，使各逻辑实例可以独立显隐。 */
export function applyBatchInteractionState(
  batch: EntityArrayMatrixBatch,
  visible: boolean,
  pickable: boolean,
): void {
  batch.requestedVisible = visible;
  batch.requestedPickable = pickable;
  syncBatchEffectiveInteractionState(batch);
}

export function syncBatchEffectiveInteractionState(batch: EntityArrayMatrixBatch): void {
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
export function resolveFormalBatchMaxInstancesPerPartition(source: EntityArrayMatrixSource): number {
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
export function createSpatialMatrixPartitions(
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

export type MatrixTranslationBounds = {
  spans: [number, number, number];
};

export type SpatialPartitionAxisDivision = {
  axis: number;
  divisions: number;
};

/**
 * 把固定分片数因式分解到有效空间轴；以量化切片后的包围盒长宽高尽量接近为目标。
 * 例如 200m x 50m 的 10 个分片会选择 5 x 2，而不是 10 条贯穿完整 Z 轴的长条。
 */
export function chooseSpatialPartitionAxisDivisions(
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

export function scoreSpatialPartitionDivisions(
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

export function createMatrixTranslationComparator(
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

export function measureMatrixTranslationBounds(
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

export function createEntityInstanceRanges(
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

export function acquireIndependentFloatBuffer(
  current: Float32Array | null,
  source: Float32Array,
  length: number,
): Float32Array {
  return current && current !== source && current.length === length ? current : new Float32Array(length);
}

export function acquireIndependentEntityIndexBuffer(
  current: Uint32Array | null,
  source: Uint32Array,
  length: number,
): Uint32Array {
  return current && current !== source && current.length === length ? current : new Uint32Array(length);
}

export function acquireFloatBuffer(current: Float32Array | null, length: number): Float32Array {
  return current?.length === length ? current : new Float32Array(length);
}

/** 候选矩阵不得复用当前正在渲染或供视锥裁剪读取的缓冲。 */
export function acquireDetachedFloatBuffer(
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
export function acquireDetachedEntityIndexBuffer(
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
export function resetInactiveBatchBuffers(batch: EntityArrayMatrixBatch): void {
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
export function applyNegativeOrientationCarrierToBuffer(buffer: Float32Array, offset: number): void {
  buffer[offset] = -buffer[offset];
  buffer[offset + 4] = -buffer[offset + 4];
  buffer[offset + 8] = -buffer[offset + 8];
  buffer[offset + 12] = -buffer[offset + 12];
}

export function acquireEntityIndexBuffer(current: Uint32Array | null, length: number): Uint32Array {
  return current?.length === length ? current : new Uint32Array(length);
}

/** 使用 -1 标记当前方向批次中没有实例的逻辑实体。 */
export function createEntityRangeStarts(entityCount: number): Int32Array {
  const starts = new Int32Array(entityCount);
  starts.fill(-1);
  return starts;
}

/** 以实体索引记录方向批次内的连续实例区间，避免为每个 Mesh 创建字符串 Map。 */
export function appendEntityInstanceRange(
  starts: Int32Array,
  counts: Uint32Array,
  entityIndex: number,
  instanceIndex: number,
): void {
  if (starts[entityIndex] < 0) starts[entityIndex] = instanceIndex;
  counts[entityIndex] += 1;
}

/** 只改写目标逻辑实体对应的实例选择区间。 */
export function writeSelectionRange(
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

export function isFiniteMatrixData(value: readonly number[]): boolean {
  return value.length === 16 && value.every(Number.isFinite);
}

export function isRigidTransformMatrix(matrix: Matrix): boolean {
  if (!isFiniteMatrix(matrix)) return false;
  const scaling = new Vector3();
  const rotation = new Quaternion();
  const translation = new Vector3();
  if (!matrix.decompose(scaling, rotation, translation)) return false;
  return Math.abs(scaling.x - 1) <= ENTITY_ARRAY_ROTATION_SCALE_EPSILON
    && Math.abs(scaling.y - 1) <= ENTITY_ARRAY_ROTATION_SCALE_EPSILON
    && Math.abs(scaling.z - 1) <= ENTITY_ARRAY_ROTATION_SCALE_EPSILON;
}

export function createTransformMatrix(transform: TransformComponent): Matrix {
  return Matrix.Compose(
    new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
    new Vector3(transform.position.x, transform.position.y, transform.position.z),
  );
}

export function isFiniteVector3(vector: Vector3Data): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function isFiniteTransform(transform: TransformComponent): boolean {
  return isFiniteVector3(transform.position) && isFiniteVector3(transform.rotation) && isFiniteVector3(transform.scale);
}

export function isFiniteMatrix(matrix: Matrix): boolean {
  return matrix.m.every((value) => Number.isFinite(value));
}

/** 幂等释放已创建的矩阵批次。 */
export function disposeBatches(batches: readonly EntityArrayMatrixBatch[]): void {
  for (const batch of batches) {
    if (batch.mesh.isDisposed()) continue;
    batch.mesh.thinInstanceSetBuffer(INSTANCE_SELECTION_ID_BUFFER, null);
    batch.mesh.thinInstanceSetBuffer('matrix', null);
    batch.mesh.dispose(false, false);
  }
}