import { ModelEntranceRuntime } from '../ModelEntranceRuntime';
import type { GeneratedUnitClickHit } from '../../../editor/model/clickEventBinding';
import { Material } from '@babylonjs/core/Materials/material.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { AnimationGroup, Observer, Node } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { ChartMarkerComponent, DataPlatformScreenComponent, LocatorStorageDepth, ModelAssetComponent, ModelGeneratorComponent, ModelGeneratorTarget, TransformComponent } from '../../../editor/model/components';
import type { Vector3Data } from '../../../editor/model/math';
import type { TelemetryBindingComponent } from '../../../editor/model/telemetryBinding';
import { type CompositionNodeTree } from '../composition/compositionCargoBuilder';
import { ExternalModelScriptRuntime, getExternalModelScriptLoadDiagnostics } from '../ExternalModelScriptRuntime';
import { SceneSkyboxRuntime } from '../SceneSkyboxRuntime';
import type { EnvironmentRuntimeSnapshot } from '../../../editor/model/environmentRuntime';
import { type ModelTelemetryPreviewBaseline } from '../telemetry/telemetryPreviewBaseline';
import { isPlainRecord } from '../runtimeValueUtils';
import { getMeshWorldBounds, getThinInstanceMeshWorldBounds, type RuntimeWorldBounds } from '../runtimeNodeGeometry';
import { type DeviceTelemetrySnapshot } from '../../mqtt/deviceTelemetry';
import { SceneLoadDiagnostics } from '../SceneLoadDiagnostics';
import type { PublishedAssetCache } from '../../assets/publishedAssetCache';
import { EnvironmentAssetContainerCache } from '../environmentAssetContainerCache';
import { SharedModelAssetCache } from '../SharedModelAssetCache';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import type { ConveyorModelTelemetryState, HcliftModelTelemetryState, LiftModelTelemetryState, RgvModelTelemetryState, ShuttleModelTelemetryState, StackerModelTelemetryState } from '../telemetry/specialized/types';


export const SELECTED_MATERIAL_COLOR = '#f0a500';
export const FALLBACK_MATERIAL_COLOR = '#8ab4f8';
export const LOCATOR_EDGE_COLOR = '#19c7d4';
export const MODEL_GENERATOR_MARKER_COLOR = '#19c7d4';
export const MODEL_GENERATOR_MARKER_ALPHA = 0.65;
export const DEVICE_SPAWNER_MARKER_COLOR = '#f2a33c';
export const LOCATOR_SURFACE_ALPHA = 0.025;
export const SELECTED_LOCATOR_SURFACE_ALPHA = 0.08;
export const LOCATOR_CONTIGUOUS_EPSILON = 1e-6;
/** 列号标签纹理边长与尺寸夹取范围（米）；标签仅在选中高亮时创建内容。 */
export const LOCATOR_COLUMN_LABEL_TEXTURE_SIZE = 128;
export const LOCATOR_COLUMN_LABEL_MIN_SIZE = 0.12;
export const LOCATOR_COLUMN_LABEL_MAX_SIZE = 0.8;
export const SLOT_HIGHLIGHT_SIZE_SCALE = 1.04;
export const SLOT_HIGHLIGHT_SURFACE_ALPHA = 0.22;
// WebGL 线宽恒为 1px，货格高亮框改用细盒体实现真实厚度（3cm）。
export const SLOT_HIGHLIGHT_EDGE_THICKNESS = 0.03;
export const EDITOR_ENTITY_ID_METADATA_KEY = 'editorEntityId';
export const CHAIN_CONVEYOR_MODEL_KEYS = new Set(['chain-conveyor', 'newchain-conveyor']);

export type DataPlatformScreenOverlayItem = {
  entityId: string;
  name?: string;
  chartMarker?: boolean;
  alarmMediaType?: 'video' | 'third-party';
  markerStyle?: Required<ChartMarkerComponent>;
  markerText?: string;
  projectId?: string;
  screenId?: string;
  mesh: Mesh;
  screenUrl?: string;
  thumbnailUrl?: string;
  renderMode?: DataPlatformScreenComponent['renderMode'];
};
export const CHAIN_CONVEYOR_SCRIPT_FILENAMES = new Set([
  'chain-conveyor.model.ts',
  'newchain-conveyor.model.ts',
]);

export type EditorMeshMetadata = {
  [EDITOR_ENTITY_ID_METADATA_KEY]?: unknown;
};

export type ModelRuntimeAssetHandle = {
  kind: 'owned-container' | 'shared-instance';
  animationGroups: AnimationGroup[];
  dispose: () => void;
};

export type LoadedModelRuntimeAssets =
  | {
    kind: 'owned-container';
    handle: ModelRuntimeAssetHandle;
    meshes: AbstractMesh[];
    transformNodes: TransformNode[];
  }
  | {
    kind: 'shared-instance';
    handle: ModelRuntimeAssetHandle;
    rootNodes: Node[];
  };

export type EntityArrayPreviewKind = 'mesh' | 'locator' | 'cad-reference' | 'model' | 'poi';
export type EntityArrayPreviewStrategy = 'clone-hierarchy' | 'matrix-instances' | 'poi-static';

export type EntityArrayPreviewSource = {
  kind: EntityArrayPreviewKind;
  root: TransformNode;
  geometryMeshes: readonly AbstractMesh[];
  previewMeshes: readonly AbstractMesh[];
  geometryReady: boolean;
  strategy: EntityArrayPreviewStrategy;
  /** 阵列副本预览需把源几何根局部矩阵组合到当前逻辑实体 Transform。 */
  modelArraySourceRoot?: TransformNode;
  modelArrayBaseTransform?: TransformComponent;
};

export type EntityArrayPreviewEntry = {
  sourceEntityId: string;
  sourceRoot: TransformNode;
  sourceKind: EntityArrayPreviewKind;
  sourceStrategy: EntityArrayPreviewStrategy;
  activeStrategy: EntityArrayPreviewStrategy;
  clones: TransformNode[];
  matrixPreview: EntityArrayThinInstanceBatch | null;
  poiBoundsMaterial: StandardMaterial | null;
  placementSignature: string;
};

export type ModelRuntimeEntry = {
  sourceUrl: string;
  /** 生成输出没有持久实体快照，保留其实际解析后的来源供场景规则读取。 */
  resolvedModelAsset?: ModelAssetComponent;
  assetRevision: string | null;
  assetSignature: string;
  entitySnapshot: Entity | null;
  assetCode: string;
  telemetryBinding: TelemetryBindingComponent | null;
  stackerCapable: boolean;
  conveyorCapable: boolean;
  rgvCapable: boolean;
  liftCapable: boolean;
  root: TransformNode;
  contentRoot: TransformNode;
  assetHandle: ModelRuntimeAssetHandle | null;
  meshes: AbstractMesh[];
  /** 因模型阵列批次而从 scene.meshes 暂时移除的脚本宿主 Mesh。 */
  modelArraySuspendedMeshes: Set<AbstractMesh>;
  modelArrayBatch: EntityArrayThinInstanceBatch | null;
  modelArraySourceSignature: string;
  modelArrayFailureSignature: string;
  highlighted: boolean;
  loadToken: number;
  cancelLoad: (() => void) | null;
  parameterSignature: string;
  parameterBaseline: Map<string, ModelParameterBaselineValue>;
  textureCache: Map<string, Texture>;
  externalScriptRuntime: ExternalModelScriptRuntime | null;
  externalScriptSignature: string;
  externalScriptStarting: boolean;
  measurementReady: boolean;
  /** 本地允许显示基础几何，但严格场景同步仍须拒绝失败的脚本初始化。 */
  readinessError?: string;
  stackerTelemetry: StackerModelTelemetryState;
  conveyorTelemetry: ConveyorModelTelemetryState;
  rgvTelemetry: RgvModelTelemetryState;
  shuttleTelemetry: ShuttleModelTelemetryState;
  liftTelemetry: LiftModelTelemetryState;
  hcliftTelemetry: HcliftModelTelemetryState;
  stackerTelemetryReady: boolean;
  telemetryPreviewBaseline: ModelTelemetryPreviewBaseline | null;
  /**
   * 合批阵列中仅承载遥测身份的代理条目：指向提供几何与脚本配置的宿主模型（源模型或参数变体）。
   * 普通模型为 undefined；代理条目无网格，渲染仍由宿主批次的 thinInstance 承担。
   */
  telemetryProxySource?: ModelRuntimeEntry;
};

/** 同一源模型下，一个独立参数组合只保留一个隐藏脚本宿主和一个 thinInstance 批次。 */
export type ModelArrayParameterVariantRuntimeEntry = {
  key: string;
  sourceEntityId: string;
  renderSignature: string;
  representativeEntityId: string;
  entities: Entity[];
  sourceLayerMasks: Map<number, number>;
  parameterOnlyChangedEntityId: string | null;
  model: ModelRuntimeEntry;
};

export type ModelGeneratorMarkerRuntimeEntry = {
  mesh: Mesh;
  material: StandardMaterial;
};

export type DeviceSpawnerMarkerRuntimeEntry = {
  root: TransformNode;
  mesh: Mesh;
  material: StandardMaterial;
};

export type ModelGeneratorMeshOutputRuntimeEntry = {
  kind: 'mesh';
  target: Extract<ModelGeneratorTarget, { kind: 'mesh' }>;
  mesh: Mesh;
  material: StandardMaterial;
};

export type ModelGeneratorModelOutputRuntimeEntry = {
  kind: 'model';
  model: ModelRuntimeEntry;
};

/** 组合输出的单个成员：模型（可带阵列批次）或内置网格，挂在组合层级树的对应节点下。 */
export type ModelGeneratorCompositionMemberRuntimeEntry = {
  nodeId: string;
  memberRoot: TransformNode;
  model: ModelRuntimeEntry | null;
  mesh: Mesh | null;
  material: StandardMaterial | null;
  arrayBatch: EntityArrayThinInstanceBatch | null;
};

export type ModelGeneratorCompositionOutputRuntimeEntry = {
  kind: 'composition';
  tree: CompositionNodeTree;
  members: ModelGeneratorCompositionMemberRuntimeEntry[];
};

export type ModelGeneratorOutputRuntimeEntry = ModelGeneratorMeshOutputRuntimeEntry | ModelGeneratorModelOutputRuntimeEntry | ModelGeneratorCompositionOutputRuntimeEntry;

/** 组合内单个阵列组的实例上限（含源成员自身），防止异常组合数据撑爆矩阵缓冲。 */
export const COMPOSITION_ARRAY_MAX_INSTANCES = 256;

/** fetch 组合模板展开后的 Mesh 总数上限，防止阵列克隆制造超大顶点烘焙。 */
export const COMPOSITION_FETCH_MAX_PARTS = 1024;

/** 可复用生成输出宿主，统一承载仓储货物和普通设备货物的异步模型生命周期。 */
export type GeneratedOutputOwnerRuntimeEntry = {
  entityId: string;
  entityName: string;
  editorEntityId: string | null;
  runtimeAssetCode: string;
  root: TransformNode;
  component: ModelGeneratorComponent;
  output: ModelGeneratorOutputRuntimeEntry | null;
  activeTargetSignature: string | null;
  activeModelTarget?: Extract<ModelGeneratorTarget, { kind: 'model' }> | null;
  loadToken: number;
  failedTargetSignatures: Set<string>;
  reportedLoadFailureKeys: Set<string>;
  activeSnapshot: DeviceTelemetrySnapshot | null;
  metadata: Record<string, unknown>;
  onTerminalLoadFailure?: () => void;
  readinessError?: string;
};

export type ModelGeneratorRuntimeEntry = GeneratedOutputOwnerRuntimeEntry & {
  markerRoot: TransformNode;
  marker: ModelGeneratorMarkerRuntimeEntry;
  selected: boolean;
  runtimeConfigSignature: string;
};

export type ResolvedModelGeneratorTarget = {
  target: ModelGeneratorTarget | null;
  role: 'default' | 'conditional';
  snapshot: DeviceTelemetrySnapshot | null;
};

export type ModelParameterRuntimeTarget = AbstractMesh | TransformNode | Material;
export type ParameterTextureAssignment = { texture: Texture | null; previous: ParameterTextureAssignment | null };
export type ModelParameterBaselineValue = boolean | number | string | Vector3Data | Texture | null;

/** 定位线框单个列号标签的渲染资源；texture 在 NullEngine 等无 canvas 环境为 null（不创建标签）。 */
export type LocatorColumnLabel = {
  mesh: Mesh;
  material: StandardMaterial;
  texture: DynamicTexture;
};

export type LocatorRuntimeEntry = {
  entityId: string;
  root: TransformNode;
  /** 全部货格共用的薄实例填充网格：一格一实例，整货架一次 draw call。 */
  fillMesh: Mesh;
  /** 全部货格边线合并的线框网格（12 边 × 格数），仅描边不拾取。 */
  edgeLines: LinesMesh;
  /** 列号标签的挂载节点（locator root 子级），选中高亮时整体启用。 */
  columnLabelsRoot: TransformNode;
  /** 各列顶部的列号标签；内容随网格重建，显隐由选中态控制。 */
  columnLabels: LocatorColumnLabel[];
  /** 构建网格时实际使用的步距；解析格子世界坐标必须与渲染公式同源。 */
  cellSteps: LocatorBindingSteps;
  /** 单个货格的尺寸（米）：length=列向，height=层向，width=深度方向。 */
  cellSize: { length: number; height: number; width: number };
  material: StandardMaterial;
  assetId: string;
  signature: string;
  columns: number;
  layers: number;
  startColumn: number;
  startLayer: number;
  /** 列反向：true 时大数列映射到靠近原点的几何索引 0；仅影响编号换算，不改几何。 */
  columnReversed: boolean;
  deviceAssetCode: string;
  /** 关联巷道编号：多穿小车按巷道+排+列层定位货格/站台，空串表示不参与巷道索引。 */
  aisleCode: string;
  rowNumber: number;
  storageDepth: LocatorStorageDepth;
  /** 绑定种类：'slot' 普通货格（缺省）；'layerChangePlatform' 换层站台（固定 1 列，位于暂存台头部）。 */
  kind: 'slot' | 'layerChangePlatform';
  /** 换层站台的轨道尽头端面世界坐标（仅 kind='layerChangePlatform' 且 layout 声明 trackEndX 时存在）；小车走行钳制边界。 */
  platformTrackEndWorld: Vector3 | null;
  /** 内置货格留存：设备放货后货物保留在格口直到再次取货（fetch 格口持久抑制）。 */
  retainCargo: boolean;
};

/** 单格高亮状态：entityId 为货格（虚拟定位线框）实体，coordinate 为业务 排-列-层。 */
export type LocatorSlotHighlightState = {
  entityId: string;
  coordinate: { row: number; column: number; layer: number };
};

export type LocatorSlotHighlightOverlay = {
  entityId: string;
  coordinate: { row: number; column: number; layer: number };
  fillMesh: Mesh;
  edgeFrame: TransformNode;
  material: StandardMaterial;
  edgeMaterial: StandardMaterial;
};

/** 绑定货格渲染网格时使用的实测步距；缺省时回退货格自身 长度+间隔 公式。 */
export type LocatorBindingSteps = {
  columnStepX: number;
  layerStepY: number;
};

/** 内置货格单排布局：进深中心 + 该排进深（缺省沿用货格自身宽度）。 */
export type BuiltInSlotRowLayoutInfo = {
  depthCenterZ: number;
  depthZ?: number;
};

/** 货架脚本写入 contentRoot metadata 的内置货格布局，坐标为货架实体根节点局部米空间。 */
export type BuiltInSlotLayoutInfo = {
  firstCellCenterX: number;
  firstLayerSurfaceY: number;
  columnSpacing: number;
  layerStepY: number;
  depthCenterZ: number;
  /** 多排布局；缺省表示单排（等价于用 depthCenterZ 与货格自身宽度）。 */
  rows?: BuiltInSlotRowLayoutInfo[];
};

/** 货架脚本写入 contentRoot metadata 的换层站台布局（暂存台头部 1 列），坐标为货架实体根节点局部米空间。 */
export type LayerChangePlatformLayoutInfo = {
  /** 站台格中心 X（列向） */
  centerX: number;
  firstLayerSurfaceY: number;
  layerStepY: number;
  depthCenterZ: number;
  /** 轨道尽头端面 X（列向，宿主局部坐标）：站台远端锚点，小车车体不得越过此边界。 */
  trackEndX?: number;
};

export type CadReferenceRuntimeEntry = {
  sourceUrl: string;
  unitScaleToMeters: number;
  root: TransformNode;
  lineMeshes: LinesMesh[];
  highlighted: boolean;
  loadToken: number;
  lineColor: string;
  opacity: number;
  geometryReady: boolean;
  cancelLoad: (() => void) | null;
  abortController: AbortController;
  unregisterCancellation: () => void;
};

/** 输送线编辑器轨迹可视化：虚线 + 方向箭头，仅编辑态、非拾取。 */
export type ConveyorTrajectoryRuntimeEntry = {
  signature: string;
  root: TransformNode;
  lineMeshes: Mesh[];
  arrowMeshes: Mesh[];
  arrowMaterials: StandardMaterial[];
  flowObserver: Observer<Scene>;
};

/** 轨迹行程上下文：中心点（模型局部）、行走轴与世界方向、行程长度、支撑面局部高度。 */
export type ConveyorTrajectoryContext = {
  centerLocal: Vector3;
  travelAxisName: 'x' | 'z';
  travelAxisWorld: Vector3;
  spanMeters: number;
  /** 货物支撑面（设备包围盒上表面 + cargo.surfaceOffset）在模型局部空间的 y 高度，与 conveyorDriver 的 surfaceLiftMeters 同源。 */
  surfaceYLocal: number;
};

export type EntityRuntimeState = {
  visible: boolean;
  locked: boolean;
};

export type SceneRuntimeModelArrayIdentityMode = 'visual' | 'device';

export type SceneRuntimeSyncOptions = {
  /** 编辑态仅按可见外观分组；运行态按设备身份隔离遥测宿主。 */
  modelArrayIdentityMode?: SceneRuntimeModelArrayIdentityMode;
};

/**
 * 场景模型（含环境底座）加载进度快照，供发布 Viewer 和运行预览展示进度条。
 * 每个进度单元对应一次资产容器加载：普通模型、参数变体宿主、生成模型输出或环境模型。
 */
export type SceneRuntimeModelLoadProgress = {
  /** 当前是否仍有加载单元在途（下载、解析或排队）。 */
  loading: boolean;
  /** 总体进度 0-1：已结算单元按个数计，在途单元按当前文件字节进度折算。 */
  percent: number;
  /** 已结算（成功或失败）的加载单元数。 */
  completedCount: number;
  /** 已登记的加载单元总数。 */
  totalCount: number;
  /** 最近上报下载进度的文件名；无在途下载时为 null。 */
  currentFile: string | null;
  /** 当前文件字节进度 0-1；文件大小未知时为 null。 */
  filePercent: number | null;
};

export type SceneRuntimePerformanceMetrics = {
  loading: ReturnType<SceneLoadDiagnostics['snapshot']> & {
    environmentPhase: EnvironmentRuntimeSnapshot['phase'];
    skybox: ReturnType<SceneSkyboxRuntime['getReadiness']>;
    skyboxTiming: ReturnType<SceneSkyboxRuntime['getLoadDiagnostics']>;
    externalScripts: ReturnType<typeof getExternalModelScriptLoadDiagnostics>;
    pendingModelCount: number;
    failedModelAcquisitions: number;
    modelCache: ReturnType<SharedModelAssetCache['getMetrics']>;
    environmentCache: ReturnType<EnvironmentAssetContainerCache['getMetrics']>;
    entrance: ReturnType<ModelEntranceRuntime['getSnapshot']>;
    resources: ReturnType<PublishedAssetCache['getLoadDiagnostics']> | null;
  };
  fullSyncCount: number;
  selectionSyncCount: number;
  lastFullSyncDurationMs: number;
  maxFullSyncDurationMs: number;
  lastSelectionSyncDurationMs: number;
  maxSelectionSyncDurationMs: number;
  lastSelectionChangedEntityCount: number;
  modelRuntimeCount: number;
  modelArrayInstanceEntityCount: number;
  modelArrayParameterVariantCount: number;
  modelArrayBatchCount: number;
  modelArrayBatchEntityCount: number;
  modelArrayBatchMeshCount: number;
  modelArrayScreenSpaceProxyBatchCount: number;
  modelArraySolidProxyEntityCount: number;
  modelArrayFrameProxyEntityCount: number;
  modelArrayProxyEntityCount: number;
  modelArrayDetailedEntityCount: number;
};

/** 浏览器和 Node smoke 共用的高精度计时入口。 */
/**
 * Babylon 9.12 的 thinInstanceBufferUpdated('matrix') 不会清空 worldMatrices 缓存；
 * 读取当前连续 matrixData，避免包围盒和阵列重建使用旧矩阵。
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

export function readRuntimeTimestampMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** 规范化模型脚本引用，只以精确文件名兼容本地路径、URL 和旧场景编码。 */
export function normalizeModelScriptFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const reference = trimmed.replace(/\\/g, '/').split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    // 损坏的转义不应阻断场景拾取，也不能通过部分规范化误识别模型。
    return null;
  }
  const path = decoded.replace(/\\/g, '/');
  const filename = path.split('/').pop()?.trim().toLowerCase() ?? '';
  return filename || null;
}

/** 精确识别新旧链条机模型，缺失或近似元数据时保持普通模型历史拾取行为。 */
export function isChainConveyorModelAsset(modelAsset: ModelAssetComponent): boolean {
  const metadataEntries = Array.isArray(modelAsset.parameterScriptMetadata)
    ? modelAsset.parameterScriptMetadata
    : [];
  for (const metadata of metadataEntries) {
    if (!isPlainRecord(metadata)) continue;
    if (CHAIN_CONVEYOR_SCRIPT_FILENAMES.has(normalizeModelScriptFilename(metadata.scriptFilename) ?? '')) {
      return true;
    }

    const values = isPlainRecord(metadata.values) ? metadata.values : null;
    const modelKeyValue = values && isPlainRecord(values.modelKey) ? values.modelKey.value : null;
    if (
      typeof modelKeyValue === 'string'
      && CHAIN_CONVEYOR_MODEL_KEYS.has(modelKeyValue.trim().toLowerCase())
    ) {
      return true;
    }

    const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
    for (const field of fields) {
      if (!isPlainRecord(field) || field.key !== 'modelKey' || typeof field.defaultValue !== 'string') continue;
      if (CHAIN_CONVEYOR_MODEL_KEYS.has(field.defaultValue.trim().toLowerCase())) return true;
    }
  }

  const scriptAssets = Array.isArray(modelAsset.scriptAssets) ? modelAsset.scriptAssets : [];
  for (const scriptAsset of scriptAssets) {
    if (!isPlainRecord(scriptAsset)) continue;
    for (const reference of [scriptAsset.name, scriptAsset.path, scriptAsset.sourceUrl]) {
      if (CHAIN_CONVEYOR_SCRIPT_FILENAMES.has(normalizeModelScriptFilename(reference) ?? '')) return true;
    }
  }
  return false;
}

/**
 * 从生成物网格元数据解析点击命中；非生成物或缺关键字段返回 null。
 * 动态设备实例自带资产编号，上报自身；货箱高亮/聚焦落在货物输出宿主自身，
 * 同时透传箱号与点击瞬间的承运设备，供事件载荷说明归属。
 */
export function readGeneratedUnitClickTarget(mesh: AbstractMesh): GeneratedUnitClickHit | null {
  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  if (!metadata) return null;

  const spawnerEntityId = typeof metadata.spawnerEntityId === 'string' ? metadata.spawnerEntityId : '';
  if (spawnerEntityId) {
    const spawnedEntityId = typeof metadata.spawnedEntityId === 'string' ? metadata.spawnedEntityId : '';
    if (!spawnedEntityId) return null;
    return {
      bindingEntityId: spawnerEntityId,
      assetCode: typeof metadata.spawnedAssetCode === 'string' ? metadata.spawnedAssetCode : '',
      highlightEntityId: spawnedEntityId,
      unitKind: 'spawned-device',
    };
  }

  const generatorEntityId = typeof metadata.generatorEntityId === 'string' ? metadata.generatorEntityId : '';
  if (!generatorEntityId) return null;
  const hostEntityId = typeof metadata.hostEntityId === 'string' ? metadata.hostEntityId : '';
  const containerCode = typeof metadata.containerCode === 'string' ? metadata.containerCode : '';
  return {
    bindingEntityId: generatorEntityId,
    assetCode: typeof metadata.sourceAssetCode === 'string' ? metadata.sourceAssetCode : '',
    // 货物输出宿主缺失时留空：高亮与会话聚焦对空 id 安全跳过，不误打到生成器标记本身。
    highlightEntityId: typeof metadata.generatedUnitEntityId === 'string' ? metadata.generatedUnitEntityId : '',
    unitKind: 'cargo',
    ...(containerCode ? { containerCode } : {}),
    ...(hostEntityId ? { hostEntityId } : {}),
  };
}

/** 收集生成输出宿主的全部网格；与 applyGeneratedOutputMetadata 的下发范围一致。 */
export function collectGeneratedOutputMeshes(output: ModelGeneratorOutputRuntimeEntry | null): AbstractMesh[] {
  if (!output) return [];
  if (output.kind === 'mesh') return [output.mesh];
  if (output.kind === 'model') return [...output.model.meshes];
  const meshes: AbstractMesh[] = [];
  for (const member of output.members) {
    if (member.model) meshes.push(...member.model.meshes);
    if (member.mesh) meshes.push(member.mesh);
    // 阵列成员的源 Mesh 已退出场景，几何由 thinInstance 批次承载。
    if (member.arrayBatch) meshes.push(...member.arrayBatch.meshes);
  }
  return meshes;
}

/** 读取生成产物网格的世界包围盒；thinInstance 批次网格必须逐实例取并集而非基座几何。 */
export function getGeneratedOutputMeshWorldBounds(mesh: AbstractMesh): RuntimeWorldBounds | null {
  if (mesh instanceof Mesh && mesh.thinInstanceCount > 0) return getThinInstanceMeshWorldBounds(mesh);
  return getMeshWorldBounds(mesh);
}