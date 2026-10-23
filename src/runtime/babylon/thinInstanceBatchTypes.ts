import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';



export const ENTITY_ARRAY_MATRIX_INSTANCE_LIMIT = 1_000_000;
export const ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON = 1e-12;
export const ENTITY_ARRAY_ROTATION_SCALE_EPSILON = 1e-6;
export const INSTANCE_SELECTION_ID_BUFFER = 'instanceSelectionId';
export const FRONT_TO_BACK_RENDERING_GROUPS_BY_SCENE = new WeakMap<Scene, Set<number>>();
/** 正式矩阵批次按空间顺序分片，让 Babylon 能以批次包围盒做视锥裁剪；不减少任何实例或几何。 */
export const FORMAL_BATCH_MIN_INSTANCES_PER_PARTITION = 128;
export const FORMAL_BATCH_MAX_INSTANCES_PER_PARTITION = 65_536;
export const FORMAL_BATCH_TARGET_VERTEX_INVOCATIONS_PER_PARTITION = 32_000_000;
export const FORMAL_BATCH_MIN_PARTITION_SPAN_METERS = 32;
/** 单个合并载体的静态顶点预算，避免把高密度内部 thinInstance 意外展开成超大 Geometry。 */
export const STATIC_MERGE_MAX_VERTICES = 262_144;
export const STATIC_MERGE_MAX_INDICES = 786_432;
export const STATIC_MERGE_VERTEX_KINDS = new Set([
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

export type EntityArrayMatrixOrientation = 1 | -1;
export type EntityArrayFrustumContainment = -1 | 0 | 1 | 2;

export type EntityArrayMatrixBatch = {
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

export type EntityArrayMatrixCandidate = {
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

export type EntityArrayMatrixSource = EntityArrayMatrixCandidate & {
  entityId: string;
  metadata: Record<string, unknown> | null;
  namePrefix: string;
  batches: EntityArrayMatrixBatch[];
  matrixScratchByOrientation: Partial<Record<EntityArrayMatrixOrientation, Float32Array>>;
  entityIndexScratchByOrientation: Partial<Record<EntityArrayMatrixOrientation, Uint32Array>>;
};

export type CapturedEntityArrayMatrix = {
  matrix: Matrix;
  orientation: EntityArrayMatrixOrientation;
};

export type PreparedEntityArraySpatialPartitions = {
  sourceInstanceIndexesByPartition: number[][] | null;
  batches: EntityArrayMatrixBatch[];
};

export type EntityArrayTransformPreviewBatch = {
  batch: EntityArrayMatrixBatch;
  sourceInstanceIndexes: Uint32Array;
  sourceInstanceIndexSet: Set<number>;
  baselineFullBoundingInfo: BoundingInfo | null;
};

export type EntityArrayTranslationPreviewBatch = EntityArrayTransformPreviewBatch & {
  baselineTranslations: Float64Array;
};

export type EntityArrayTranslationPreviewSession = {
  batches: EntityArrayTranslationPreviewBatch[];
};

export type EntityArrayRotationPreviewBatch = EntityArrayTransformPreviewBatch & {
  baselineMatrices: Float64Array;
};

export type EntityArrayRotationPreviewSession = {
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
export type EntityArrayLightingInstance = {
  mesh: Mesh;
  sourceMesh: AbstractMesh;
  entityId: string;
  /** 完整分片内的稳定索引，与相机裁剪后的 thinInstanceIndex 不同。 */
  sourceIndex: number;
  worldMatrix: Matrix;
};