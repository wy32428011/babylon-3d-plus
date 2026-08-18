import '@babylonjs/loaders';
import { configureLocalBabylonDecoders } from './localDecoderConfiguration';

configureLocalBabylonDecoders();
import {
  AbstractMesh,
  type AnimationGroup,
  AssetContainer,
  Color3,
  CreateGreasedLine,
  DirectionalLight,
  GreasedLineMeshColorDistributionType,
  GreasedLineMeshMaterialType,
  type GreasedLineSimpleMaterial,
  HemisphericLight,
  LinesMesh,
  Light,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  type Nullable,
  type Observer,
  PBRMaterial,
  Plane,
  PointLight,
  Quaternion,
  Scene,
  SceneLoader,
  StandardMaterial,
  Texture,
  TransformNode,
  type ISceneLoaderProgressEvent,
  type Node,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import { collectFolderRuntimeEntityIds, createEntityHierarchyStateMap } from '../../editor/model/entityHierarchy';
import type {
  CadReferenceComponent,
  LightComponent,
  LocatorComponent,
  LocatorStorageDepth,
  MeshKind,
  MeshRendererComponent,
  ModelAssetComponent,
  ModelGeneratorComponent,
  ModelGeneratorTarget,
  TransformComponent,
} from '../../editor/model/components';
import type {
  ModelExpression,
  ModelParameterBinding,
  ModelParameterValue,
  ModelParameterValues,
} from '../../editor/model/modelParameters';
import {
  BUILT_IN_BOX_SIZE_METERS,
  BUILT_IN_PLANE_SIZE_METERS,
  BUILT_IN_SPHERE_DIAMETER_METERS,
  getBuiltInMeshGroundOffsetMeters,
} from '../../editor/model/builtInMeshGeometry';
import type { Vector3Data } from '../../editor/model/math';
import { createGroupSpatialInfo, type GroupSpatialInfoResult } from '../../editor/model/groupSpatialInfo';
import { MODEL_ARRAY_COPY_COUNT_MAX, MODEL_ARRAY_MIN_SPAN_METERS } from '../../editor/model/modelArray';
import {
  createModelAssetCode,
  createSceneSkyboxSettingsFromEntity,
  getSceneSkyboxEntity,
  getSceneSkyboxSettings,
  isPointInsideSkyboxSphere,
  type FetchConfig,
  type SceneDocument,
  type SceneEnvironmentSettings,
} from '../../editor/model/SceneDocument';
import { LocatorFetchRuntime, type FetchContainerRecord } from './LocatorFetchRuntime';
import { createId } from '../../shared/ids';
import type { TelemetryBindingComponent } from '../../editor/model/telemetryBinding';
import {
  createModelGeneratorTargetSignature,
  createRuntimeModelAssetFromTarget,
} from '../../editor/model/modelGenerator';
import { resolveModelGeneratorTargetFromSnapshot } from './modelGeneratorRuntime';
import {
  CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET,
  consumeCadReferenceParseResult,
  parseCadReferenceDxf,
  type CadReferenceParseResult,
} from '../../editor/cad/cadReference';
import { createCadReferenceDxfWorkerTask } from '../../editor/cad/cadReferenceWorkerClient';
import {
  ExternalModelScriptRuntime,
  type ExternalModelScriptRuntimeMode,
  type ExternalModelScriptTelemetrySnapshot,
} from './ExternalModelScriptRuntime';
import { SceneSkyboxRuntime } from './SceneSkyboxRuntime';
import { SceneShadowRuntime } from './SceneShadowRuntime';
import { EditorLightMarkerRuntime } from './EditorLightMarkerRuntime';
import { EditorAutoPatrolRuntime, type AutoPatrolMarkerPick } from './EditorAutoPatrolRuntime';
import {
  SceneEnvironmentRuntime,
  type SceneEnvironmentApplyOptions,
} from './SceneEnvironmentRuntime';
import type {
  EnvironmentApplyResult,
  EnvironmentRuntimeSnapshot,
  EnvironmentWorldBounds,
} from '../../editor/model/environmentRuntime';
import {
  isMeasurableModelMesh,
  measureModelSizeMeters,
  measureEntityMeshesSpanMetersAlongWorldDirection,
  type ModelMeasurementResult,
} from './modelMeasurement';
import { resolveModelTextureAssetUrl } from '../assets/modelTextureAssetUrl';
import { intersectWorldRayWithModelDisplayBounds } from './modelPickBounds';
import { PoiEffectRuntime } from './effects/PoiEffectRuntime';
import {
  captureModelTelemetryPreviewBaseline,
  restoreModelTelemetryPreviewBaseline,
  type ModelTelemetryPreviewBaseline,
} from './telemetry/telemetryPreviewBaseline';
import {
  collectSpecializedTelemetryConflictKeys,
  resolveSpecializedTelemetryBinding,
  resolveSpecializedTelemetrySnapshot,
  type ResolvedSpecializedTelemetryBinding,
  type SpecializedTelemetryDeviceType,
} from './telemetry/specializedTelemetryBinding';
import { resolveLocatorBoxIndex, resolveLocatorCellSupportWorldPosition } from './telemetry/stackerStorageLocation';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from './runtimeValueUtils';
import {
  clampNumber,
  computeRootRelativeWorldMatrix,
  createLocalAxis,
  createPointWorldBounds,
  filterTopLevelMotionNodes,
  findModelNodes,
  findModelNodesByName,
  getHorizontalModelAxis,
  getMeshWorldBounds,
  getMeshesWorldBottomCenter,
  getModelAxis,
  getModelTransformNodes,
  getNodeMeshes,
  getNodeWorldBounds,
  getNodeWorldRotation,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  isFiniteVector3,
  lerpNumber,
  lerpVector,
  mergeWorldBounds,
  moveNumberTowards,
  moveVectorTowards,
  normalizeVector,
  projectPointOntoAxis,
  projectWorldBoundsOntoAxis,
  transformWorldBounds,
  uniqueTransformNodes,
  worldDeltaToParentLocalDelta,
  type RuntimeWorldBounds,
} from './runtimeNodeGeometry';
import {
  deviceTelemetryStore,
  readBooleanField,
  readIntegerField,
  readNumberField,
  readStringField,
  type DeviceTelemetrySnapshot,
  type StackerTelemetrySnapshot,
} from '../mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore, type TelemetryRuntimeDiagnosticStatus } from '../mqtt/telemetryRuntimeDiagnostics';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import { AssetLoadScheduler } from './AssetLoadScheduler';
import {
  resolveModelAssetSharedInstancingPolicy,
  SharedModelAssetCache,
} from './SharedModelAssetCache';
import {
  prepareInstancedMeshesForSelectionOutline,
  repairInstancedMeshBufferContainers,
} from './instancedSelectionBuffers';
import { EntityArrayThinInstanceBatch } from './EntityArrayThinInstanceBatch';
import {
  EntityGroupTranslationPreview,
  type EntityGroupTranslationTarget,
} from './EntityGroupTranslationPreview';
import {
  EntityGroupRotationPreview,
  type EntityGroupRotationTarget,
} from './EntityGroupRotationPreview';
import {
  createConveyorTelemetryState,
  createRgvTelemetryState,
  createStackerTelemetryState,
  isConveyorModelAsset,
  isConveyorRuntimeModel,
  isRgvModelAsset,
  isStackerModelAsset,
  readConveyorCargoSurfaceOffset,
  readConveyorCargoTravelConfig,
  resetConveyorTelemetryState,
  resetRgvTelemetryState,
  resetStackerTelemetryState,
} from './telemetry/specialized/specializedModelAssets';
import {
  SpecializedTelemetryRuntime,
} from './telemetry/specialized/SpecializedTelemetryRuntime';
import type { SpecializedTelemetryHost } from './telemetry/specialized/types';
import {
  STACKER_CARGO_COLOR,
  STACKER_CARGO_EMISSIVE_COLOR,
  STACKER_CARGO_SIZE,
  CONVEYOR_CARGO_COLOR,
  CONVEYOR_CARGO_EMISSIVE_COLOR,
  CONVEYOR_CARGO_SIZE,
  RGV_CARGO_COLOR,
  RGV_CARGO_EMISSIVE_COLOR,
  RGV_CARGO_SIZE,
} from './telemetry/specialized/types';
import type {
  ConveyorCargoTravelConfig,
  ConveyorModelTelemetryState,
  GeneratedCargoKind,
  GeneratedCargoRuntimeEntry,
  RgvModelTelemetryState,
  StackerModelTelemetryState,
} from './telemetry/specialized/types';
import { mergeSceneRuntimeHighlightEntityIds } from './sceneRuntimeHighlight';
import {
  clearSceneSelectionHighlight,
  createSceneSelectionHighlightLayer,
  setSceneSelectionHighlightGroups,
  type SceneSelectionHighlightLayer,
} from './sceneSelectionHighlight';
import { isRuntimeModelSelectionCandidate } from './sceneRuntimeSelection';

const SELECTED_MATERIAL_COLOR = '#f7d774';
const FALLBACK_MATERIAL_COLOR = '#8ab4f8';
const LOCATOR_EDGE_COLOR = '#19c7d4';
const MODEL_GENERATOR_MARKER_COLOR = '#19c7d4';
const MODEL_GENERATOR_MARKER_ALPHA = 0.65;
const LOCATOR_SURFACE_ALPHA = 0.025;
const SELECTED_LOCATOR_SURFACE_ALPHA = 0.08;
const LOCATOR_CONTIGUOUS_EPSILON = 1e-6;
const EDITOR_ENTITY_ID_METADATA_KEY = 'editorEntityId';
const CHAIN_CONVEYOR_MODEL_KEYS = new Set(['chain-conveyor', 'newchain-conveyor']);
const CHAIN_CONVEYOR_SCRIPT_FILENAMES = new Set([
  'chain-conveyor.model.ts',
  'newchain-conveyor.model.ts',
]);

type EditorMeshMetadata = {
  [EDITOR_ENTITY_ID_METADATA_KEY]?: unknown;
};

type ModelRuntimeAssetHandle = {
  kind: 'owned-container' | 'shared-instance';
  animationGroups: AnimationGroup[];
  dispose: () => void;
};

type LoadedModelRuntimeAssets =
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

type EntityArrayPreviewKind = 'mesh' | 'locator' | 'cad-reference' | 'model' | 'poi';
type EntityArrayPreviewStrategy = 'clone-hierarchy' | 'matrix-instances' | 'poi-static';

type EntityArrayPreviewSource = {
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

type EntityArrayPreviewEntry = {
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
  assetRevision: string | null;
  assetSignature: string;
  entitySnapshot: Entity | null;
  assetCode: string;
  telemetryBinding: TelemetryBindingComponent | null;
  stackerCapable: boolean;
  conveyorCapable: boolean;
  rgvCapable: boolean;
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
  stackerTelemetry: StackerModelTelemetryState;
  conveyorTelemetry: ConveyorModelTelemetryState;
  rgvTelemetry: RgvModelTelemetryState;
  stackerTelemetryReady: boolean;
  telemetryPreviewBaseline: ModelTelemetryPreviewBaseline | null;
  /**
   * 合批阵列中仅承载遥测身份的代理条目：指向提供几何与脚本配置的宿主模型（源模型或参数变体）。
   * 普通模型为 undefined；代理条目无网格，渲染仍由宿主批次的 thinInstance 承担。
   */
  telemetryProxySource?: ModelRuntimeEntry;
};

/** 同一源模型下，一个独立参数组合只保留一个隐藏脚本宿主和一个 thinInstance 批次。 */
type ModelArrayParameterVariantRuntimeEntry = {
  key: string;
  sourceEntityId: string;
  renderSignature: string;
  representativeEntityId: string;
  entities: Entity[];
  sourceLayerMasks: Map<number, number>;
  parameterOnlyChangedEntityId: string | null;
  model: ModelRuntimeEntry;
};

type ModelGeneratorMarkerRuntimeEntry = {
  mesh: Mesh;
  material: StandardMaterial;
};

type ModelGeneratorMeshOutputRuntimeEntry = {
  kind: 'mesh';
  target: Extract<ModelGeneratorTarget, { kind: 'mesh' }>;
  mesh: Mesh;
  material: StandardMaterial;
};

type ModelGeneratorModelOutputRuntimeEntry = {
  kind: 'model';
  model: ModelRuntimeEntry;
};

type ModelGeneratorOutputRuntimeEntry = ModelGeneratorMeshOutputRuntimeEntry | ModelGeneratorModelOutputRuntimeEntry;

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
  loadToken: number;
  failedTargetSignatures: Set<string>;
  reportedLoadFailureKeys: Set<string>;
  activeSnapshot: DeviceTelemetrySnapshot | null;
  metadata: Record<string, unknown>;
  onTerminalLoadFailure?: () => void;
};

export type ModelGeneratorRuntimeEntry = GeneratedOutputOwnerRuntimeEntry & {
  markerRoot: TransformNode;
  marker: ModelGeneratorMarkerRuntimeEntry;
  selected: boolean;
  runtimeConfigSignature: string;
};

type ResolvedModelGeneratorTarget = {
  target: ModelGeneratorTarget | null;
  role: 'default' | 'conditional';
  snapshot: DeviceTelemetrySnapshot | null;
};

type ModelParameterRuntimeTarget = AbstractMesh | TransformNode | Material;
type ModelParameterBaselineValue = boolean | number | string | Vector3Data | Texture | null;

export type LocatorRuntimeEntry = {
  entityId: string;
  root: TransformNode;
  /** 全部货格共用的薄实例填充网格：一格一实例，整货架一次 draw call。 */
  fillMesh: Mesh;
  /** 全部货格边线合并的线框网格（12 边 × 格数），仅描边不拾取。 */
  edgeLines: LinesMesh;
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
  deviceAssetCode: string;
  rowNumber: number;
  storageDepth: LocatorStorageDepth;
};

/** 绑定货格渲染网格时使用的实测步距；缺省时回退货格自身 长度+间隔 公式。 */
type LocatorBindingSteps = {
  columnStepX: number;
  layerStepY: number;
};

/** 货架脚本写入 contentRoot metadata 的内置货格布局，坐标为货架实体根节点局部米空间。 */
type BuiltInSlotLayoutInfo = {
  firstCellCenterX: number;
  firstLayerSurfaceY: number;
  columnSpacing: number;
  layerStepY: number;
  depthCenterZ: number;
};

type CadReferenceRuntimeEntry = {
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
};

/** 输送线编辑器轨迹可视化：虚线 + 方向箭头，仅编辑态、非拾取。 */
type ConveyorTrajectoryRuntimeEntry = {
  signature: string;
  root: TransformNode;
  lineMeshes: Mesh[];
  arrowMeshes: Mesh[];
  arrowMaterials: StandardMaterial[];
  flowObserver: Observer<Scene>;
};

/** 轨迹行程上下文：中心点（模型局部）、行走轴与世界方向、行程长度、支撑面局部高度。 */
type ConveyorTrajectoryContext = {
  centerLocal: Vector3;
  travelAxisName: 'x' | 'z';
  travelAxisWorld: Vector3;
  spanMeters: number;
  /** 货物支撑面（设备包围盒上表面 + cargo.surfaceOffset）在模型局部空间的 y 高度，与 conveyorDriver 的 surfaceLiftMeters 同源。 */
  surfaceYLocal: number;
};

type EntityRuntimeState = {
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
function readCurrentThinInstanceMatrices(mesh: Mesh): Matrix[] | null {
  const count = mesh.thinInstanceCount;
  const matrixData = mesh._thinInstanceDataStorage?.matrixData;
  if (matrixData && matrixData.length >= count * 16) {
    return Array.from({ length: count }, (_, index) => Matrix.FromArray(matrixData, index * 16));
  }
  const cached = mesh.thinInstanceGetWorldMatrices();
  return cached.length >= count ? cached.slice(0, count).map((matrix) => matrix.clone()) : null;
}

function readRuntimeTimestampMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** 规范化模型脚本引用，只以精确文件名兼容本地路径、URL 和旧场景编码。 */
function normalizeModelScriptFilename(value: unknown): string | null {
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
function isChainConveyorModelAsset(modelAsset: ModelAssetComponent): boolean {
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

export class SceneRuntime {
  private readonly meshes = new Map<string, Mesh>();
  private readonly locators = new Map<string, LocatorRuntimeEntry>();
  private readonly locatorTargets = new Map<string, LocatorRuntimeEntry>();
  private readonly locatorDeviceIndex = new Map<string, Map<number, LocatorRuntimeEntry[]>>();
  private readonly cadReferences = new Map<string, CadReferenceRuntimeEntry>();
  private readonly conveyorTrajectories = new Map<string, ConveyorTrajectoryRuntimeEntry>();
  private _trajectoryVisible = false;
  private readonly models = new Map<string, ModelRuntimeEntry>();
  /** 阵列副本保留完整 Scene Entity；相同参数组合共享一个脚本宿主，而不是逐实体加载模型。 */
  private readonly modelArrayInstanceEntities = new Map<string, Entity>();
  private readonly modelArrayParameterVariants = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
  private readonly modelArrayParameterVariantByEntityId = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
  /** 合批 conveyor 实例的遥测代理（key=实例实体 ID）：无几何，仅承载设备身份与遥测状态。 */
  private readonly modelArrayTelemetryProxies = new Map<string, ModelRuntimeEntry>();
  private readonly pendingModelArraySourceResyncs = new Map<string, string | null>();
  private readonly pendingModelArrayVariantRenderSuppressions = new Set<TransformNode>();
  private readonly suppressedModelArrayVariantRootsThisFrame = new Set<TransformNode>();
  private readonly modelArrayJsonSignatureCache = new WeakMap<object, string>();
  private readonly modelArrayTransientJsonSignatureCache = new WeakMap<object, string>();
  private readonly modelArrayCanonicalSignatureIds = new Map<string, number>();
  private modelArrayCanonicalSignatureSequence = 0;
  private readonly modelArrayBatchByMeshUniqueId = new Map<number, EntityArrayThinInstanceBatch>();
  private modelArrayGizmoProxy: { entityId: string; node: TransformNode } | null = null;
  private entityGroupGizmoProxy: {
    groupId: string;
    entityIds: string[];
    tool: 'translate' | 'rotate';
    node: TransformNode;
  } | null = null;
  private readonly modelGenerators = new Map<string, ModelGeneratorRuntimeEntry>();
  private readonly generatedOutputOwners = new Map<string, GeneratedOutputOwnerRuntimeEntry>();
  /** fetch 数据驱动的定位线框渲染运行时，按定位线框实体组织。 */
  private readonly locatorFetchRuntimes = new Map<string, LocatorFetchRuntime>();
  /** fetch 请求代际戳与每排最新请求序号：响应仅在仍是该排最新请求时应用，防止乱序覆盖。 */
  private fetchRequestGeneration = 0;
  private readonly latestFetchRequestByRow = new Map<number, number>();
  /** 运行预览开始时捕获的 fetch 配置，供事件驱动的单排同步复用。 */
  private fetchConfigSnapshot: FetchConfig | null = null;
  /** 已放货到 fetch 驱动定位线框、等待单排同步响应后再销毁的 MQTT 货箱（按排号分组）。 */
  private readonly fetchKeptCargoByRow = new Map<number, Set<string>>();
  private readonly lights = new Map<string, Light>();
  private readonly lightMarkerRuntime: EditorLightMarkerRuntime;
  private readonly autoPatrolMarkerRuntime: EditorAutoPatrolRuntime;
  private readonly entityStates = new Map<string, EntityRuntimeState>();
  private readonly syncedEntities = new Map<string, Entity>();
  private selectedEntityIds = new Set<string>();
  private localHighlightedEntityIds = new Set<string>();
  private externalHighlightedEntityIds = new Set<string>();
  private hierarchySelectionIds: string[] | null = null;
  private readonly modelSelectionOutlineLayer: SceneSelectionHighlightLayer;
  private readonly assetLoadScheduler = new AssetLoadScheduler();
  private readonly sharedModelAssetCache = new SharedModelAssetCache();
  private readonly telemetryObserver: Nullable<Observer<Scene>>;
  private readonly groupTransformPreviewObserver: Nullable<Observer<Scene>>;
  private readonly modelArrayVariantRenderSuppressionObserver: Nullable<Observer<Scene>>;
  private readonly modelArrayVariantRenderRestoreObserver: Nullable<Observer<Scene>>;
  private readonly poiEffectRuntime: PoiEffectRuntime;
  private readonly specializedTelemetryRuntime: SpecializedTelemetryRuntime;
  private readonly shadowRuntime: SceneShadowRuntime;
  private readonly skyboxRuntime: SceneSkyboxRuntime;
  private readonly environmentRuntime: SceneEnvironmentRuntime;
  private readonly reportedDuplicateLocatorTargets = new Set<string>();
  private readonly reportedOverlappingLocatorRanges = new Set<string>();
  private telemetryPreviewActive = false;
  private modelArrayIdentityMode: SceneRuntimeModelArrayIdentityMode = 'device';
  private readonly reportedCargoIssues = new Set<string>();
  private outlinedModelArrayBatches = new Set<EntityArrayThinInstanceBatch>();
  private fullSyncCount = 0;
  private selectionSyncCount = 0;
  private lastFullSyncDurationMs = 0;
  private maxFullSyncDurationMs = 0;
  private lastSelectionSyncDurationMs = 0;
  private maxSelectionSyncDurationMs = 0;
  private lastSelectionChangedEntityCount = 0;
  private entityArrayPreview: EntityArrayPreviewEntry | null = null;
  private groupTranslationPreview: EntityGroupTranslationPreview | null = null;
  private pendingGroupTranslationDelta: Vector3Data | null = null;
  private groupRotationPreview: EntityGroupRotationPreview | null = null;
  private pendingGroupRotationMatrix: number[] | null = null;
  private modelLoadSequence = 0;
  /** 模型加载进度单元序号与最近上报字节进度；单元在 loadModelRuntimeAssets 或环境加载期间登记。 */
  private modelLoadProgressSequence = 0;
  private modelLoadProgressReportSequence = 0;
  private modelLoadProgressStartedCount = 0;
  private modelLoadProgressSettledCount = 0;
  private readonly activeModelLoadProgress = new Map<number, {
    fileName: string | null;
    loaded: number;
    total: number;
    reportedAt: number;
  }>();

  constructor(
    private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
    private readonly onModelMeasurementChanged: (entityId: string) => void = () => undefined,
    onEnvironmentSnapshot: (snapshot: EnvironmentRuntimeSnapshot) => void = () => undefined,
    private readonly onModelLoadProgress?: (progress: SceneRuntimeModelLoadProgress) => void,
  ) {
    this.modelSelectionOutlineLayer = createSceneSelectionHighlightLayer(scene, undefined, this.pushLog);
    this.poiEffectRuntime = new PoiEffectRuntime(scene);
    this.shadowRuntime = new SceneShadowRuntime(scene);
    this.lightMarkerRuntime = new EditorLightMarkerRuntime(scene);
    this.autoPatrolMarkerRuntime = new EditorAutoPatrolRuntime(scene);
    this.skyboxRuntime = new SceneSkyboxRuntime(scene, this.pushLog);
    this.environmentRuntime = new SceneEnvironmentRuntime(scene, {
      // 环境底座模型与场景模型并行加载，作为独立进度单元合并进同一份加载快照。
      loadAssetContainer: (rootUrl, fileName, signal) => {
        const sequence = this.beginModelLoadProgressUnit(fileName);
        const promise = this.loadAssetContainer(rootUrl, fileName, signal, (event) => {
          this.updateModelLoadProgressUnit(sequence, event);
        });
        void promise.then(
          () => this.settleModelLoadProgressUnit(sequence),
          () => this.settleModelLoadProgressUnit(sequence),
        );
        return promise;
      },
      onSnapshot: onEnvironmentSnapshot,
      pushLog: this.pushLog,
    });
    this.specializedTelemetryRuntime = new SpecializedTelemetryRuntime(scene, this.createSpecializedTelemetryHost());
    this.groupTransformPreviewObserver = this.scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
      this.flushGroupTranslationPreview();
      this.flushGroupRotationPreview();
    });
    this.modelArrayVariantRenderSuppressionObserver = this.scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
      this.suppressPendingModelArrayVariantHostsForRender();
    });
    this.modelArrayVariantRenderRestoreObserver = this.scene.onAfterRenderObservable.add(() => {
      this.restoreSuppressedModelArrayVariantHostsAfterRender();
    });
    this.telemetryObserver = this.scene.onBeforeRenderObservable.add(() => this.applyDeviceTelemetryFrame());
  }

  /** 构造专用遥测门面所需的宿主委托对象。 */
  private createSpecializedTelemetryHost(): SpecializedTelemetryHost {
    return {
      pushLog: (message) => this.pushLog(message),
      collectModels: () => {
        const models: { entityId: string; model: ModelRuntimeEntry }[] = [];
        for (const [entityId, model] of this.models.entries()) {
          models.push({ entityId, model });
        }
        for (const variant of this.modelArrayParameterVariants.values()) {
          models.push({ entityId: variant.representativeEntityId, model: variant.model });
        }
        for (const [entityId, proxy] of this.modelArrayTelemetryProxies.entries()) {
          models.push({ entityId, model: proxy });
        }
        return models;
      },
      findLocatorByDevice: (assetCode, x, y, z) => this.findLocatorByDevice(assetCode, x, y, z),
      findLocatorsByDevice: (assetCode) => this.findLocatorsByDevice(assetCode),
      resolveCargoGeneratorForModel: (model) => this.resolveCargoGeneratorForModel(model),
      resolveColumnTargetPose: (entityId) => this.resolveColumnTargetPose(entityId),
      resolveFetchDriveRowForLocator: (locator) => this.resolveFetchDriveRowForLocator(locator),
      suppressFetchCellForLocator: (locator, column, layer) => this.suppressFetchCellForLocator(locator, column, layer),
      handleFetchRowSync: (row) => this.handleFetchRowSync(row),
      keepCargoForFetchRowSync: (row, assetCode, cargoKey) => this.keepCargoForFetchRowSync(row, assetCode, cargoKey),
      updateExternalScriptContext: (model, telemetry) => this.updateModelExternalScriptRuntimeContext(model, 'runtime', telemetry, true),
      refreshModelArrayRepresentation: (model) => this.refreshModelArrayRuntimeRepresentation(model),
      getGeneratedCargoFallbackSpec: (kind) => this.getGeneratedCargoFallbackSpec(kind),
      ensureGeneratedCargoFallback: (cargo, kind) => this.ensureGeneratedCargoFallback(cargo, kind),
      ensureGeneratedCargoOutputOwner: (cargo, kind, component, snapshot) => this.ensureGeneratedCargoOutputOwner(cargo, kind, component, snapshot),
      syncGeneratedCargoVisual: (cargo, kind, snapshot, generator) => this.syncGeneratedCargoVisual(cargo, kind, snapshot, generator),
      setGeneratedCargoRootPose: (cargo, position, rotation, scaling) => this.setGeneratedCargoRootPose(cargo, position, rotation, scaling),
      disposeGeneratedCargo: (cargo) => this.disposeGeneratedCargo(cargo),
      getModelWorldBounds: (model) => this.getModelWorldBounds(model),
    } as SpecializedTelemetryHost;
  }

  /** 为 fetch thinInstance 加载模型模板：走完整资产加载管线并应用单位换算。 */
  private async loadModelTemplateForFetch(target: ModelGeneratorTarget): Promise<{ meshes: Mesh[]; dispose: () => void } | null> {
    if (target.kind !== 'model') return null;

    const modelAsset = createRuntimeModelAssetFromTarget(target, 'FETCH_TMPL');
    if (!modelAsset) return null;

    try {
      const { rootUrl, fileName } = this.splitAssetUrl(
        this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision),
      );

      const container = await this.loadAssetContainer(rootUrl, fileName);
      container.addAllToScene();

      // GLB 的 meshes[0] 通常是无几何的 __root__ 节点，须过滤出真正有顶点的 mesh
      const meshes = container.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
      if (meshes.length === 0) {
        container.dispose();
        return null;
      }

      let scaleNode: TransformNode | null = null;
      const unitScale = modelAsset.unitScaleToMeters;
      if (unitScale !== 1) {
        scaleNode = new TransformNode('_fetch_tmpl_scale', this.scene);
        scaleNode.scaling = new Vector3(unitScale, unitScale, unitScale);
        for (const rootNode of container.rootNodes) {
          rootNode.parent = scaleNode;
        }
      }

      // 与 normalizeModelContentOrigin 同语义：把内容包围盒底部中心平移到原点，
      // getLocatorBoxWorldMatrix 的格口矩阵平移即底面中心，实例落位后货物底部贴合格口。
      const anchorNode = new TransformNode('_fetch_tmpl_anchor', this.scene);
      if (scaleNode) scaleNode.parent = anchorNode;
      else {
        for (const rootNode of container.rootNodes) {
          rootNode.parent = anchorNode;
        }
      }
      const bottomCenter = getMeshesWorldBottomCenter(meshes);
      if (bottomCenter) anchorNode.position = bottomCenter.scale(-1);

      return {
        meshes,
        dispose: () => {
          container.dispose();
          anchorNode.dispose();
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`Fetch 模板模型加载失败：${message}`);
      return null;
    }
  }

  /** 进入运行预览时执行一次全量库存同步；无 fetch 驱动定位线框时直接返回。 */
  async handleFetchDriveEvent(fetchConfig: FetchConfig): Promise<void> {
    this.fetchConfigSnapshot = fetchConfig;
    const targets = this.collectFetchDriveLocators();
    if (targets.length === 0) return;

    const generation = ++this.fetchRequestGeneration;
    for (const target of targets) {
      this.latestFetchRequestByRow.set(target.locatorComponent.rowNumber, generation);
    }

    const records = await this.fetchInventoryRecords(fetchConfig, []);
    if (records === null) return;

    for (const target of targets) {
      // 全量响应到达时该排可能已有更新的单排请求，跳过避免旧数据覆盖新状态
      if (this.latestFetchRequestByRow.get(target.locatorComponent.rowNumber) !== generation) continue;
      this.applyFetchRecordsToLocator(records, target);
    }
  }

  /** 堆垛机放货/取货完成后同步单排库存；同排多台定位线框共享一次请求。 */
  handleFetchRowSync(rowNumber: number): void {
    const fetchConfig = this.fetchConfigSnapshot;
    if (!fetchConfig?.url) return;
    const targets = this.collectFetchDriveLocators()
      .filter((target) => target.locatorComponent.rowNumber === rowNumber);
    if (targets.length === 0) return;

    const generation = ++this.fetchRequestGeneration;
    this.latestFetchRequestByRow.set(rowNumber, generation);

    void (async () => {
      const records = await this.fetchInventoryRecords(fetchConfig, [String(rowNumber)]);
      if (records === null) return;
      if (this.latestFetchRequestByRow.get(rowNumber) !== generation) return;
      for (const target of targets) {
        this.applyFetchRecordsToLocator(records, target);
        // 响应应用后再解除格口抑制：此时 records 已反映取/放结果，解除不会闪出旧货物
        this.locatorFetchRuntimes.get(target.entityId)?.clearSuppressedCells();
      }
      this.disposeFetchKeptCargoForRow(rowNumber);
    })();
  }

  /** 统一发 fetch 库存请求：rows 为空数组时服务端返回全量数据；失败时记日志并返回 null。 */
  private async fetchInventoryRecords(fetchConfig: FetchConfig, rows: string[]): Promise<FetchContainerRecord[] | null> {
    if (!fetchConfig.url) return null;

    try {
      const response = await fetch(fetchConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': fetchConfig.apiKey,
        },
        body: JSON.stringify({ rows }),
      });

      if (!response.ok) {
        this.pushLog(`Fetch 请求失败：HTTP ${response.status}`);
        return null;
      }

      const data: { records: FetchContainerRecord[] } = (await response.json())?.data;
      return data?.records ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`Fetch 处理异常：${message}`);
      return null;
    }
  }

  /** 收集当前启用了 fetch 数据驱动的定位线框及其运行时快照。 */
  private collectFetchDriveLocators(): Array<{
    entityId: string;
    locatorEntry: LocatorRuntimeEntry;
    locatorComponent: LocatorComponent;
  }> {
    const targets: Array<{ entityId: string; locatorEntry: LocatorRuntimeEntry; locatorComponent: LocatorComponent }> = [];
    for (const [entityId, locatorEntry] of this.locators) {
      const locatorComponent = this.syncedEntities.get(entityId)?.components.locator;
      if (!locatorComponent?.fetchDrive?.enabled) continue;
      targets.push({ entityId, locatorEntry, locatorComponent });
    }
    return targets;
  }

  /** 把（可能未按排过滤的）库存记录分发到单条定位线框的 fetch 渲染运行时。 */
  private applyFetchRecordsToLocator(
    records: FetchContainerRecord[],
    target: { entityId: string; locatorEntry: LocatorRuntimeEntry; locatorComponent: LocatorComponent },
  ): void {
    const fetchRuntime = this.locatorFetchRuntimes.get(target.entityId);
    if (!fetchRuntime) return;

    const generatorId = target.locatorComponent.fetchDrive?.cargoGeneratorId;
    const generatorComponent = generatorId
      ? this.modelGenerators.get(generatorId)?.component ?? null
      : null;

    void fetchRuntime.applyRecords(
      records,
      target.locatorEntry,
      target.locatorComponent,
      generatorComponent,
      (locator, column, layer) => this.getLocatorBoxWorldMatrix(locator, column, layer),
      (modelTarget) => this.loadModelTemplateForFetch(modelTarget),
    );
  }

  /** 定位线框启用 fetch 驱动时返回其排号，否则返回 null（MQTT 落位语义保持不变）。 */
  private resolveFetchDriveRowForLocator(locator: LocatorRuntimeEntry): number | null {
    const component = this.syncedEntities.get(locator.entityId)?.components.locator;
    return component?.fetchDrive?.enabled ? locator.rowNumber : null;
  }

  /** 设备取货/放货期间抑制 locator 某格口的 fetch 渲染，货物改由设备侧渲染；未启用 fetch 返回 null。 */
  private suppressFetchCellForLocator(locator: LocatorRuntimeEntry, column: number, layer: number): number | null {
    const rowNumber = this.resolveFetchDriveRowForLocator(locator);
    if (rowNumber === null) return null;
    const fetchRuntime = this.locatorFetchRuntimes.get(locator.entityId);
    if (!fetchRuntime) return null;
    fetchRuntime.suppressCell(column, layer);
    return rowNumber;
  }

  /** 放货到 fetch 驱动定位线框后保留 MQTT 货箱，等待单排同步响应时销毁，避免网络延迟造成视觉空窗；返回是否为首次登记。 */
  private keepCargoForFetchRowSync(rowNumber: number | null, assetCode: string, cargoKey: string): boolean {
    if (rowNumber === null) return false;
    const key = JSON.stringify([assetCode, cargoKey]);
    let keys = this.fetchKeptCargoByRow.get(rowNumber);
    if (!keys) {
      keys = new Set();
      this.fetchKeptCargoByRow.set(rowNumber, keys);
    }
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }

  /** 单排同步响应应用后销毁该排保留的 MQTT 货箱，渲染权完全交给 fetch 批次。 */
  private disposeFetchKeptCargoForRow(rowNumber: number): void {
    const keys = this.fetchKeptCargoByRow.get(rowNumber);
    if (!keys) return;
    this.fetchKeptCargoByRow.delete(rowNumber);
    for (const key of keys) {
      this.specializedTelemetryRuntime.disposeStackerCargoByKey(key);
    }
  }

  /** 释放指定定位线框的 fetch 渲染运行时。 */
  private disposeLocatorFetchRuntime(entityId: string): void {
    const fetchRuntime = this.locatorFetchRuntimes.get(entityId);
    if (!fetchRuntime) return;
    fetchRuntime.dispose();
    this.locatorFetchRuntimes.delete(entityId);
  }

  /** 开始 MQTT 运行预览；该方法幂等，并在真正驱动前清空上一次预览残留运行态。 */
  beginTelemetryPreview(): void {
    if (this.telemetryPreviewActive) return;
    this.clearEntityArrayPreview();
    this.clearFolderGroupGizmoTarget();
    this.telemetryPreviewActive = true;
    this.lightMarkerRuntime.setPreviewActive(true);
    this.autoPatrolMarkerRuntime.setPreviewActive(true);
    this.clearTelemetryPreviewRuntimeState();
    this.updateAllExternalScriptRuntimeContexts('runtime', null);
    this.clearModelGeneratorLoadFailureCache();
    this.syncAllModelGeneratorPresentations();
    this.refreshAllBuiltInSlotRenderability();
  }

  /** 结束 MQTT 运行预览；该方法幂等，按驱动关闭、运行态清理、模型恢复的顺序回到编辑态。 */
  endTelemetryPreview(): void {
    const hadPreviewState = this.telemetryPreviewActive
      || [...this.models.values()].some((model) => model.telemetryPreviewBaseline)
      || [...this.generatedOutputOwners.values()].some((owner) => (
        owner.output?.kind === 'model' && owner.output.model.telemetryPreviewBaseline !== null
      ));
    if (!hadPreviewState) return;

    this.telemetryPreviewActive = false;
    this.lightMarkerRuntime.setPreviewActive(false);
    this.autoPatrolMarkerRuntime.setPreviewActive(false);
    this.specializedTelemetryRuntime.disposeAllCargo();
    for (const fetchRuntime of this.locatorFetchRuntimes.values()) {
      fetchRuntime.clearAllBatches();
    }
    this.latestFetchRequestByRow.clear();
    this.fetchKeptCargoByRow.clear();
    this.fetchConfigSnapshot = null;
    for (const model of this.models.values()) {
      if (model.telemetryPreviewBaseline) {
        restoreModelTelemetryPreviewBaseline(model.telemetryPreviewBaseline);
        model.telemetryPreviewBaseline = null;
      }
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      const model = owner.output.model;
      if (model.telemetryPreviewBaseline) {
        restoreModelTelemetryPreviewBaseline(model.telemetryPreviewBaseline);
        model.telemetryPreviewBaseline = null;
      }
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
    }
    // 合批阵列代表模型同样接受遥测驱动（collectModels 合并视图），退出时必须一并清理
    for (const variant of this.modelArrayParameterVariants.values()) {
      resetStackerTelemetryState(variant.model);
      resetConveyorTelemetryState(variant.model);
      resetRgvTelemetryState(variant.model);
    }
    for (const proxy of this.modelArrayTelemetryProxies.values()) {
      resetConveyorTelemetryState(proxy);
    }
    this.clearTelemetryPreviewRuntimeState();
    this.updateAllExternalScriptRuntimeContexts('edit', null);
    this.clearModelGeneratorLoadFailureCache();
    this.syncAllModelGeneratorPresentations();
    this.refreshAllBuiltInSlotRenderability();
  }

  /** 发布 Viewer 在首次同步前永久禁用编辑器专用灯光标记。 */
  disableEditorLightMarkers(): void {
    this.lightMarkerRuntime.disable();
  }

  /** 发布 Viewer 在首次同步前永久禁用巡检原点、节点和路径辅助对象。 */
  disableEditorAutoPatrolMarkers(): void {
    this.autoPatrolMarkerRuntime.disable();
  }

  /** 同步路线与节点子选区；节点 ID 是编辑器 transient 状态，不写入场景文档。 */
  setAutoPatrolSelection(routeId: string | null, waypointId: string | null): void {
    this.autoPatrolMarkerRuntime.setSelection(routeId, waypointId);
  }

  /** 同步播放目标高亮。 */
  setAutoPatrolPlaybackTarget(routeId: string | null, waypointIndex: number | null): void {
    this.autoPatrolMarkerRuntime.setPlaybackTarget(routeId, waypointIndex);
  }

  getAutoPatrolWaypointGizmoTarget(entityId: string, waypointId: string): TransformNode | null {
    if (!this.isEntityTransformEditable(entityId)) return null;
    return this.autoPatrolMarkerRuntime.getWaypointGizmoTarget(entityId, waypointId);
  }

  previewAutoPatrolWaypointTransform(entityId: string, waypointId: string, transform: TransformComponent): void {
    this.autoPatrolMarkerRuntime.previewWaypointTransform(entityId, waypointId, transform);
  }

  /** 根据实体 ID 获取当前运行时中可被 Gizmo 绑定的 Babylon 节点。 */
  getGizmoTargetByEntityId(entityId: string | null): AbstractMesh | TransformNode | null {
    if (!entityId) return null;
    if (!this.isEntityTransformEditable(entityId)) return null;

    const modelArrayInstance = this.modelArrayInstanceEntities.get(entityId);
    if (modelArrayInstance) return this.getOrCreateModelArrayGizmoProxy(modelArrayInstance);
    const sourceModel = this.models.get(entityId);
    if (sourceModel?.modelArrayBatch && sourceModel.entitySnapshot) {
      return this.getOrCreateModelArrayGizmoProxy(sourceModel.entitySnapshot);
    }

    return (
      this.meshes.get(entityId) ??
      this.skyboxRuntime.getMesh(entityId) ??
      this.locators.get(entityId)?.root ??
      this.cadReferences.get(entityId)?.root ??
      this.models.get(entityId)?.root ??
      this.modelGenerators.get(entityId)?.markerRoot ??
      this.poiEffectRuntime.getGizmoTarget(entityId) ??
      this.lightMarkerRuntime.getGizmoTarget(entityId) ??
      this.autoPatrolMarkerRuntime.getRouteGizmoTarget(entityId) ??
      null
    );
  }

  /** 返回当前群组完整世界包围盒，供 Inspector 展示中心位置和包围尺寸。 */
  getEntityGroupSpatialInfo(entityIds: readonly string[]): GroupSpatialInfoResult {
    return createGroupSpatialInfo(entityIds, this.getEntitiesWorldBounds([...entityIds]));
  }

  /** 在完整选区世界包围盒中心创建或更新不可见变换代理；包围盒或当前工具目标未就绪时保持禁用。 */
  getFolderGroupGizmoTarget(
    groupId: string,
    entityIds: readonly string[],
    tool: 'translate' | 'rotate' = 'translate',
  ): TransformNode | null {
    const uniqueEntityIds = [...new Set(entityIds)].filter((entityId) => Boolean(entityId));
    if (uniqueEntityIds.length === 0) {
      this.entityGroupGizmoProxy?.node.setEnabled(false);
      return null;
    }

    let proxy = this.entityGroupGizmoProxy;
    if (!proxy) {
      const node = new Mesh('__entityGroupTransformGizmoProxy', this.scene);
      node.isPickable = false;
      proxy = {
        groupId,
        entityIds: uniqueEntityIds,
        tool,
        node,
      };
      this.entityGroupGizmoProxy = proxy;
    }
    proxy.groupId = groupId;
    proxy.entityIds = uniqueEntityIds;
    proxy.tool = tool;

    const bounds = this.getEntitiesWorldBounds(uniqueEntityIds);
    const ready = Boolean(
      bounds?.geometryReady
      && bounds.resolvedEntityCount === uniqueEntityIds.length
      && bounds.geometryReadyEntityCount === uniqueEntityIds.length
      && this.areEntityGroupTransformTargetsReady(uniqueEntityIds, tool),
    );
    if (!bounds || !ready) {
      proxy.node.setEnabled(false);
      return proxy.node;
    }

    proxy.node.setEnabled(true);
    proxy.node.position.copyFromFloats(bounds.center.x, bounds.center.y, bounds.center.z);
    proxy.node.rotationQuaternion = null;
    proxy.node.rotation.copyFromFloats(0, 0, 0);
    proxy.node.scaling.copyFromFloats(1, 1, 1);
    proxy.node.computeWorldMatrix(true);
    return proxy.node;
  }

  /** 完整包围盒和对应运行时目标均就绪后，才允许开始组合移动或旋转。 */
  isEntityGroupTransformReady(
    entityIds: readonly string[],
    tool: 'translate' | 'rotate',
  ): boolean {
    const uniqueEntityIds = [...new Set(entityIds)].filter((entityId) => Boolean(entityId));
    if (uniqueEntityIds.length === 0) return false;

    const bounds = this.getEntitiesWorldBounds(uniqueEntityIds);
    if (
      !bounds?.geometryReady
      || bounds.resolvedEntityCount !== uniqueEntityIds.length
      || bounds.geometryReadyEntityCount !== uniqueEntityIds.length
    ) return false;

    return this.areEntityGroupTransformTargetsReady(uniqueEntityIds, tool);
  }

  /** 当前工具所需的全部运行时写入目标均存在时，组合 Gizmo 才可见或开始拖拽。 */
  private areEntityGroupTransformTargetsReady(
    entityIds: readonly string[],
    tool: 'translate' | 'rotate',
  ): boolean {
    return entityIds.every((entityId) => (
      tool === 'rotate'
        ? this.resolveGroupRotationTarget(entityId) !== null
        : this.resolveGroupTranslationTarget(entityId) !== null
    ));
  }

  /** 隐藏群组代理并取消任何尚未提交的运行时预览。 */
  clearFolderGroupGizmoTarget(): void {
    this.cancelFolderGroupTransforms();
    this.entityGroupGizmoProxy?.node.setEnabled(false);
  }

  /** 建立文件夹组运行时平移会话；未加载成员会在后续批次就绪时自动接回。 */
  beginFolderGroupTranslation(
    entityIds: readonly string[],
    beforePositions: Readonly<Record<string, Vector3Data>>,
  ): boolean {
    if (this.telemetryPreviewActive) return false;
    this.cancelFolderGroupTransforms();

    const validEntityIds = [...new Set(entityIds)].filter((entityId) => {
      const position = beforePositions[entityId];
      return Boolean(
        position
        && Number.isFinite(position.x)
        && Number.isFinite(position.y)
        && Number.isFinite(position.z),
      );
    });
    if (validEntityIds.length === 0) return false;

    const baselines = Object.fromEntries(validEntityIds.map((entityId) => {
      const position = beforePositions[entityId];
      return [entityId, { x: position.x, y: position.y, z: position.z }];
    }));
    this.groupTranslationPreview = new EntityGroupTranslationPreview(
      validEntityIds,
      baselines,
      (entityId) => this.resolveGroupTranslationTarget(entityId),
    );
    this.pendingGroupTranslationDelta = null;
    this.groupTranslationPreview.refresh();
    return true;
  }

  /** 记录最新绝对 delta，并在下一次 active-mesh 评估前合并为一次运行时更新。 */
  updateFolderGroupTranslation(delta: Vector3Data): boolean {
    if (
      !this.groupTranslationPreview
      || !Number.isFinite(delta.x)
      || !Number.isFinite(delta.y)
      || !Number.isFinite(delta.z)
    ) return false;

    this.pendingGroupTranslationDelta = { x: delta.x, y: delta.y, z: delta.z };
    return true;
  }

  /** 取消整组预览并恢复节点、灯光与 thinInstance 矩阵基线。 */
  cancelFolderGroupTranslation(): void {
    const preview = this.groupTranslationPreview;
    if (!preview) return;

    this.pendingGroupTranslationDelta = null;
    this.groupTranslationPreview = null;
    preview.cancel();
    this.refreshFolderGroupGizmoProxyPosition();
  }

  /** 完成整组预览并保留当前画面，等待场景文档同步权威位置。 */
  finishFolderGroupTranslation(): void {
    const preview = this.groupTranslationPreview;
    if (!preview) return;

    this.flushGroupTranslationPreview();
    this.groupTranslationPreview = null;
    this.pendingGroupTranslationDelta = null;
    preview.finish();
  }

  /** 建立文件夹组运行时旋转会话；最终 Transform 对全部成员计算，未加载成员也可随提交写回。 */
  beginFolderGroupRotation(
    entityIds: readonly string[],
    beforeTransforms: Readonly<Record<string, TransformComponent>>,
  ): boolean {
    if (this.telemetryPreviewActive) return false;
    this.cancelFolderGroupTransforms();

    this.groupRotationPreview = new EntityGroupRotationPreview(
      entityIds,
      beforeTransforms,
      (entityId) => this.resolveGroupRotationTarget(entityId),
    );
    this.pendingGroupRotationMatrix = null;
    if (this.groupRotationPreview.refresh()) return true;

    this.groupRotationPreview.cancel();
    this.groupRotationPreview = null;
    return false;
  }

  /** 记录最新绝对世界增量矩阵，并在下一次 active-mesh 评估前合并为一次运行时更新。 */
  updateFolderGroupRotation(deltaMatrix: readonly number[]): boolean {
    if (
      !this.groupRotationPreview
      || deltaMatrix.length !== 16
      || !deltaMatrix.every(Number.isFinite)
    ) return false;

    this.pendingGroupRotationMatrix = [...deltaMatrix];
    return true;
  }

  /** 返回当前旋转会话为全部成员计算出的最终 Transform。 */
  getFolderGroupRotationTransforms(): Record<string, TransformComponent> | null {
    this.flushGroupRotationPreview();
    return this.groupRotationPreview?.getTransforms() ?? null;
  }

  /** 取消整组旋转预览并恢复普通节点与 thinInstance 完整矩阵基线。 */
  cancelFolderGroupRotation(): void {
    const preview = this.groupRotationPreview;
    if (!preview) return;

    this.pendingGroupRotationMatrix = null;
    this.groupRotationPreview = null;
    preview.cancel();
    this.refreshFolderGroupGizmoProxyPosition();
  }

  /** 完成整组旋转预览并保留当前画面，等待场景文档同步权威 Transform。 */
  finishFolderGroupRotation(): void {
    const preview = this.groupRotationPreview;
    if (!preview) return;

    this.flushGroupRotationPreview();
    this.groupRotationPreview = null;
    this.pendingGroupRotationMatrix = null;
    preview.finish();
  }

  /** 把同一渲染帧内最后一次旋转矩阵应用到轻量预览会话。 */
  private flushGroupRotationPreview(): void {
    const preview = this.groupRotationPreview;
    const deltaMatrix = this.pendingGroupRotationMatrix;
    if (!preview || !deltaMatrix) return;

    this.pendingGroupRotationMatrix = null;
    preview.update(deltaMatrix);
  }

  /** 同时取消文件夹平移和旋转会话，供选区/文档/运行模式切换统一清理。 */
  private cancelFolderGroupTransforms(): void {
    this.cancelFolderGroupTranslation();
    this.cancelFolderGroupRotation();
  }

  /** 把同一渲染帧内最后一次拖拽 delta 应用到轻量预览会话。 */
  private flushGroupTranslationPreview(): void {
    const preview = this.groupTranslationPreview;
    const delta = this.pendingGroupTranslationDelta;
    if (!preview || !delta) return;

    this.pendingGroupTranslationDelta = null;
    preview.update(delta);
  }

  /** 异步模型或批次就绪后重新解析群组变换目标，并保持上一帧已应用的绝对结果。 */
  private refreshGroupTransformPreviewTargets(): void {
    const translationPreview = this.groupTranslationPreview;
    const rotationPreview = this.groupRotationPreview;
    translationPreview?.refresh();
    rotationPreview?.refresh();
    // 活动拖动期间代理位姿由 Gizmo 权威控制；异步几何只接入预览目标，
    // 否则包围盒中心变化会被误算进相对 delta。
    if (!translationPreview && !rotationPreview) this.refreshFolderGroupGizmoProxyPosition();
  }

  /** 运行时基线恢复或异步几何就绪后，把群组代理放回完整选区包围盒中心。 */
  private refreshFolderGroupGizmoProxyPosition(): void {
    const proxy = this.entityGroupGizmoProxy;
    if (!proxy || proxy.node.isDisposed()) return;

    const bounds = this.getEntitiesWorldBounds(proxy.entityIds);
    if (
      !bounds?.geometryReady
      || bounds.resolvedEntityCount !== proxy.entityIds.length
      || bounds.geometryReadyEntityCount !== proxy.entityIds.length
      || !this.areEntityGroupTransformTargetsReady(proxy.entityIds, proxy.tool)
    ) {
      proxy.node.setEnabled(false);
      return;
    }
    proxy.node.setEnabled(true);
    proxy.node.position.copyFromFloats(bounds.center.x, bounds.center.y, bounds.center.z);
    proxy.node.rotationQuaternion = null;
    proxy.node.rotation.copyFromFloats(0, 0, 0);
    proxy.node.scaling.copyFromFloats(1, 1, 1);
    proxy.node.computeWorldMatrix(true);
  }

  /** 将逻辑实体解析为普通位置目标或共享 thinInstance 批次目标。 */
  private resolveGroupTranslationTarget(entityId: string): EntityGroupTranslationTarget | null {
    const batch = this.resolveModelArrayBatchForEntityId(entityId);
    if (batch) return { kind: 'batch', batch };

    const autoPatrolTarget = this.autoPatrolMarkerRuntime.getRouteTransformTarget(entityId);
    const autoPatrolEntity = this.syncedEntities.get(entityId);
    if (autoPatrolTarget && autoPatrolEntity?.components.autoPatrol) {
      return {
        kind: 'position',
        identity: autoPatrolTarget,
        setPosition: (position) => {
          this.autoPatrolMarkerRuntime.previewRouteTransform(entityId, {
            ...autoPatrolEntity.components.transform,
            position,
          });
        },
      };
    }

    const node = (
      this.meshes.get(entityId)
      ?? this.skyboxRuntime.getMesh(entityId)
      ?? this.locators.get(entityId)?.root
      ?? this.cadReferences.get(entityId)?.root
      ?? this.models.get(entityId)?.root
      ?? this.modelGenerators.get(entityId)?.markerRoot
      ?? this.poiEffectRuntime.getGizmoTarget(entityId)
      ?? null
    );
    if (node && !node.isDisposed()) {
      return {
        kind: 'position',
        identity: node,
        setPosition: (position) => {
          if (node.isDisposed()) return;
          node.position.copyFromFloats(position.x, position.y, position.z);
          node.computeWorldMatrix(true);
        },
      };
    }

    const light = this.lights.get(entityId);
    if (!light || light.isDisposed()) return null;
    const markerTarget = this.lightMarkerRuntime.getGizmoTarget(entityId);
    return {
      kind: 'position',
      identity: markerTarget ?? light,
      setPosition: (position) => {
        this.applyGroupTranslationLightPosition(light, position);
        this.lightMarkerRuntime.setPosition(entityId, position);
      },
    };
  }

  /** 将逻辑实体解析为普通完整 Transform 目标或共享 thinInstance 旋转批次目标。 */
  private resolveGroupRotationTarget(entityId: string): EntityGroupRotationTarget | null {
    const batch = this.resolveModelArrayBatchForEntityId(entityId);
    if (batch) return { kind: 'batch', batch };

    const autoPatrolTarget = this.autoPatrolMarkerRuntime.getRouteTransformTarget(entityId);
    const autoPatrolEntity = this.syncedEntities.get(entityId);
    if (autoPatrolTarget && autoPatrolEntity?.components.autoPatrol) {
      return {
        kind: 'transform',
        identity: autoPatrolTarget,
        setTransform: (transform) => {
          this.autoPatrolMarkerRuntime.previewRouteTransform(entityId, transform);
        },
      };
    }

    const node = (
      this.meshes.get(entityId)
      ?? this.skyboxRuntime.getMesh(entityId)
      ?? this.locators.get(entityId)?.root
      ?? this.cadReferences.get(entityId)?.root
      ?? this.models.get(entityId)?.root
      ?? this.modelGenerators.get(entityId)?.markerRoot
      ?? this.poiEffectRuntime.getGizmoTarget(entityId)
      ?? null
    );
    if (node && !node.isDisposed()) {
      return {
        kind: 'transform',
        identity: node,
        setTransform: (transform) => {
          if (node.isDisposed()) return;
          this.applyTransform(node, transform);
          node.computeWorldMatrix(true);
        },
      };
    }

    const light = this.lights.get(entityId);
    if (!light || light.isDisposed()) return null;
    const markerTarget = this.lightMarkerRuntime.getGizmoTarget(entityId);
    return {
      kind: 'transform',
      identity: markerTarget ?? light,
      setTransform: (transform) => {
        this.applyGroupRotationLightTransform(light, transform);
        this.lightMarkerRuntime.setTransform(entityId, transform);
      },
    };
  }

  /** 灯光旋转预览复用正式同步语义，方向光同时更新世界位置和方向。 */
  private applyGroupRotationLightTransform(light: Light, transform: TransformComponent): void {
    if (light instanceof HemisphericLight) {
      light.direction.copyFrom(this.vectorFromTransformPosition(transform, new Vector3(0, 1, 0)));
      return;
    }
    if (light instanceof DirectionalLight) {
      light.position.copyFrom(this.vectorFromTransformPosition(transform, Vector3.Zero()));
      light.direction.copyFrom(this.directionFromRotation(transform));
      return;
    }
    if (light instanceof PointLight) {
      light.position.copyFrom(this.vectorFromTransformPosition(transform, Vector3.Zero()));
    }
  }

  /** 灯光预览复用正式同步语义：半球光位置字段表示方向，其余灯光表示世界位置。 */
  private applyGroupTranslationLightPosition(light: Light, position: Vector3Data): void {
    const vector = new Vector3(position.x, position.y, position.z);
    if (light instanceof HemisphericLight) {
      if (vector.lengthSquared() <= 1e-12) vector.copyFromFloats(0, 1, 0);
      light.direction.copyFrom(vector);
      return;
    }
    if (light instanceof DirectionalLight || light instanceof PointLight) {
      light.position.copyFrom(vector);
    }
  }

  /** 天空盒包围当前相机时不参与背景拾取；相机位于球外时恢复球面点击选择。 */
  private isEntityPickableFromActiveCamera(entityId: string): boolean {
    const entity = this.syncedEntities.get(entityId);
    if (!entity?.components.skybox) return true;
    const camera = this.scene.cameraToUseForPointers ?? this.scene.activeCamera;
    if (!camera) return false;
    const position = camera.globalPosition;
    return !isPointInsideSkyboxSphere(entity.components.transform, {
      x: position.x,
      y: position.y,
      z: position.z,
    });
  }

  /** 优先拾取巡检节点编号；路线原点返回 waypointId=null。 */
  pickAutoPatrolAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): AutoPatrolMarkerPick | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;
    const picks = this.scene.multiPick(point.x, point.y, (mesh) => {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || !mesh.isPickable) {
        return false;
      }
      return this.autoPatrolMarkerRuntime.readPick(mesh) !== null;
    }) ?? [];
    picks.sort((left, right) => left.distance - right.distance);
    for (const picked of picks) {
      const result = this.autoPatrolMarkerRuntime.readPick(picked.pickedMesh ?? null);
      if (result) return result;
    }
    return null;
  }

  /** 在画布客户端坐标位置拾取可编辑 Mesh，并把 thinInstanceIndex 还原为具体阵列实体 ID。 */
  pickEntityIdAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null {
    return this.pickSceneEntityIdAtCanvasPoint(clientX, clientY, canvas, 'editable');
  }

  /** 运行预览和发布 Viewer 只读拾取真实业务模型；locked 不影响查看，但隐藏和辅助对象仍被过滤。 */
  pickRuntimeModelEntityIdAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): string | null {
    return this.pickSceneEntityIdAtCanvasPoint(clientX, clientY, canvas, 'runtime-model');
  }

  /** 按编辑或运行态策略执行最近可见实体拾取，并统一处理 thinInstance 与模型显示范围兜底。 */
  private pickSceneEntityIdAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    mode: 'editable' | 'runtime-model',
  ): string | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;
    const isCandidate = (entityId: string): boolean => mode === 'runtime-model'
      ? this.isRuntimeModelSceneSelectable(entityId)
      : this.isEntityScenePickable(entityId) && this.isEntityPickableFromActiveCamera(entityId);

    const picks = this.scene.multiPick(point.x, point.y, (mesh) => {
      // Babylon 传入自定义 predicate 后会跳过默认的 enabled / visible / pickable 判断。
      // 运行态故意忽略 authoring lock 导致的 isPickable=false，但仍保留真实显隐约束。
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0) return false;
      const batch = this.modelArrayBatchByMeshUniqueId.get(mesh.uniqueId);
      if (batch) return mode === 'runtime-model' || (mesh.isPickable && batch.hasPickableEntities());
      if (mode === 'editable' && !mesh.isPickable) return false;
      const entityId = this.readEntityIdFromMesh(mesh);
      return entityId !== null && isCandidate(entityId);
    }) ?? [];
    picks.sort((left, right) => left.distance - right.distance);

    for (const picked of picks) {
      const entityId = this.readEntityIdFromMesh(
        picked.pickedMesh ?? null,
        typeof picked.thinInstanceIndex === 'number' ? picked.thinInstanceIndex : null,
      );
      if (entityId && isCandidate(entityId)) return entityId;
    }

    const camera = this.scene.cameraToUseForPointers ?? this.scene.activeCamera;
    if (!camera) return null;
    const ray = this.scene.createPickingRay(point.x, point.y, Matrix.Identity(), camera);
    let nearestEntityId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    // 精确三角面完全未命中时，才用模型当前显示范围填补细杆/梁之间的空隙；
    // 真实可见几何仍保持优先，避免前方货架抢走透过空格看到的后方模型。
    for (const [entityId, model] of this.models) {
      if (model.modelArrayBatch || !isCandidate(entityId)) continue;
      const modelAsset = model.entitySnapshot?.components.modelAsset;
      if (modelAsset && isChainConveyorModelAsset(modelAsset)) continue;
      const distance = intersectWorldRayWithModelDisplayBounds(ray, model.root, model.contentRoot);
      if (distance === null || distance >= nearestDistance) continue;
      nearestEntityId = entityId;
      nearestDistance = distance;
    }

    return nearestEntityId;
  }
  /** 将画布客户端坐标投射到世界 y=0 地面平面，用于拖拽释放时按鼠标位置放置模型。 */
  getGroundPointAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): Vector3Data | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    const camera = this.scene.activeCamera;
    if (!point || !camera) return null;

    const ray = this.scene.createPickingRay(point.x, point.y, Matrix.Identity(), camera);
    const groundPlane = Plane.FromPositionAndNormal(Vector3.Zero(), Vector3.Up());
    const distance = ray.intersectsPlane(groundPlane);
    if (distance === null || !Number.isFinite(distance) || distance < 0) return null;

    const hitPoint = ray.origin.add(ray.direction.scale(distance));
    if (!Number.isFinite(hitPoint.x) || !Number.isFinite(hitPoint.y) || !Number.isFinite(hitPoint.z)) return null;

    return { x: hitPoint.x, y: 0, z: hitPoint.z };
  }

  /**
   * 读取普通导入模型沿实体自身 X/Y/Z 轴的实际米制尺寸。
   * 加载与脚本初始化完成前返回 loading；没有有效可见几何时返回 unavailable。
   */
  getModelMeasurement(entityId: string): ModelMeasurementResult {
    const model = this.models.get(entityId);
    if (model) {
      if (!model.assetHandle || !model.measurementReady) return { status: 'loading', sizeMeters: null };
      const sizeMeters = measureModelSizeMeters(model.root, model.contentRoot);
      return sizeMeters
        ? { status: 'ready', sizeMeters }
        : { status: 'unavailable', sizeMeters: null };
    }

    const instanceEntity = this.modelArrayInstanceEntities.get(entityId);
    const sourceModel = instanceEntity ? this.resolveModelArrayRenderModel(instanceEntity) : null;
    if (!instanceEntity || !sourceModel) return { status: 'unavailable', sizeMeters: null };
    if (!sourceModel.assetHandle || !sourceModel.measurementReady) return { status: 'loading', sizeMeters: null };

    const points = this.getModelArrayInstanceWorldPoints(instanceEntity, sourceModel);
    const axes = this.getTransformWorldAxes(instanceEntity.components.transform);
    const spans = points && axes ? this.measureWorldPointsAlongAxes(points, axes) : null;
    return spans
      ? { status: 'ready', sizeMeters: { x: spans[0], y: spans[1], z: spans[2] } }
      : { status: 'unavailable', sizeMeters: null };
  }

  /** 设置输送线轨迹可视化的全局开关，控制所有已创建轨迹的显示/隐藏。 */
  setTrajectoryVisible(visible: boolean): void {
    this._trajectoryVisible = visible;
    for (const [entityId, entry] of this.conveyorTrajectories) {
      entry.root.setEnabled(visible && this.isEntityVisible(entityId));
    }
  }

  /** 读取支持实体沿指定世界方向的有效几何跨度，供 Shift+Gizmo 阵列使用。 */
  getEntityArrayGeometry(entityId: string, worldDirection: Vector3Data): {
    direction: Vector3Data;
    spanMeters: number;
  } | null {
    const direction = new Vector3(worldDirection.x, worldDirection.y, worldDirection.z);
    const lengthSquared = direction.lengthSquared();
    if (!Number.isFinite(lengthSquared) || lengthSquared <= MODEL_ARRAY_MIN_SPAN_METERS ** 2) return null;
    direction.normalize();
    const normalizedDirection = { x: direction.x, y: direction.y, z: direction.z };

    const instanceEntity = this.modelArrayInstanceEntities.get(entityId);
    const sourceModel = instanceEntity ? this.resolveModelArrayRenderModel(instanceEntity) : null;
    if (instanceEntity && sourceModel) {
      if (!sourceModel.assetHandle || !sourceModel.measurementReady) return null;
      const points = this.getModelArrayInstanceWorldPoints(instanceEntity, sourceModel);
      const spanMeters = points
        ? this.measureWorldPointsAlongAxes(points, [direction])?.[0] ?? null
        : null;
      if (!Number.isFinite(spanMeters) || spanMeters === null || spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) return null;
      return { direction: normalizedDirection, spanMeters };
    }

    const source = this.resolveEntityArrayPreviewSource(entityId);
    if (!source?.geometryReady || source.root.isDisposed()) return null;
    const spanMeters = measureEntityMeshesSpanMetersAlongWorldDirection(
      source.geometryMeshes,
      normalizedDirection,
    );
    if (!Number.isFinite(spanMeters) || spanMeters === null || spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) return null;

    return { direction: normalizedDirection, spanMeters };
  }

  /**
   * 更新 Shift 阵列的临时预览；模型使用隔离 Geometry 承载 thinInstance 矩阵，避免同几何批次互相覆盖。
   * 临时对象不进入实体映射、选择、脚本、MQTT、持久化或命令历史。
   */
  updateEntityArrayPreview(
    entityId: string,
    worldDirection: Vector3Data,
    copyCount: number,
    spacingMeters: number,
  ): boolean {
    const source = this.resolveEntityArrayPreviewSource(entityId);
    const geometry = this.getEntityArrayGeometry(entityId, worldDirection);
    if (!source || !geometry) {
      this.clearEntityArrayPreview();
      return false;
    }

    const normalizedCopyCount = Math.min(
      MODEL_ARRAY_COPY_COUNT_MAX,
      Math.max(0, Math.floor(Number.isFinite(copyCount) ? copyCount : 0)),
    );
    if (normalizedCopyCount === 0) {
      this.clearEntityArrayPreview();
      return true;
    }

    const normalizedSpacingMeters = Number.isFinite(spacingMeters) ? Math.max(0, spacingMeters) : 0;
    if (
      this.entityArrayPreview
      && (
        this.entityArrayPreview.sourceEntityId !== entityId
        || this.entityArrayPreview.sourceRoot !== source.root
        || this.entityArrayPreview.sourceKind !== source.kind
        || this.entityArrayPreview.sourceStrategy !== source.strategy
      )
    ) {
      this.clearEntityArrayPreview();
    }
    this.entityArrayPreview ??= {
      sourceEntityId: entityId,
      sourceRoot: source.root,
      sourceKind: source.kind,
      sourceStrategy: source.strategy,
      activeStrategy: source.strategy,
      clones: [],
      matrixPreview: null,
      poiBoundsMaterial: null,
      placementSignature: '',
    };

    const preview = this.entityArrayPreview;
    const arrayStepMeters = geometry.spanMeters + normalizedSpacingMeters;
    const placementSignature = [
      normalizedCopyCount,
      geometry.direction.x,
      geometry.direction.y,
      geometry.direction.z,
      geometry.spanMeters,
      normalizedSpacingMeters,
      source.root.position.x,
      source.root.position.y,
      source.root.position.z,
      source.root.rotation.x,
      source.root.rotation.y,
      source.root.rotation.z,
      source.root.scaling.x,
      source.root.scaling.y,
      source.root.scaling.z,
    ].join('|');
    if (preview.placementSignature === placementSignature) return true;

    if (preview.activeStrategy === 'matrix-instances') {
      preview.matrixPreview ??= EntityArrayThinInstanceBatch.create(entityId, source.previewMeshes);
      let matrixUpdated = false;
      if (preview.matrixPreview && source.modelArraySourceRoot && source.modelArrayBaseTransform) {
        const previewInstances = Array.from({ length: normalizedCopyCount }, (_, index) => {
          const offsetMultiplier = arrayStepMeters * (index + 1);
          return {
            entityId: `__modelArrayPreview_${index}`,
            transform: {
              position: {
                x: source.modelArrayBaseTransform!.position.x + geometry.direction.x * offsetMultiplier,
                y: source.modelArrayBaseTransform!.position.y + geometry.direction.y * offsetMultiplier,
                z: source.modelArrayBaseTransform!.position.z + geometry.direction.z * offsetMultiplier,
              },
              rotation: { ...source.modelArrayBaseTransform!.rotation },
              scale: { ...source.modelArrayBaseTransform!.scale },
            },
            pickable: false,
          };
        });
        source.modelArraySourceRoot.computeWorldMatrix(true);
        matrixUpdated = preview.matrixPreview.updateEntityTransforms(
          source.modelArraySourceRoot.getWorldMatrix().clone(),
          previewInstances,
        );
      } else {
        matrixUpdated = preview.matrixPreview?.update(normalizedCopyCount, geometry.direction, arrayStepMeters) ?? false;
      }
      if (matrixUpdated) {
        preview.placementSignature = placementSignature;
        return true;
      }

      preview.matrixPreview?.dispose();
      preview.matrixPreview = null;
      if (source.kind === 'model') {
        // 模型阵列禁止退回逐副本节点克隆；矩阵批次不可用时直接阻止本次预览。
        this.clearEntityArrayPreview();
        return false;
      }
      preview.activeStrategy = 'clone-hierarchy';
    }

    while (preview.clones.length < normalizedCopyCount) {
      const cloneIndex = preview.clones.length + 1;
      const clonedNode = this.createEntityArrayPreviewClone(source, preview, entityId, cloneIndex);
      if (!clonedNode) {
        this.clearEntityArrayPreview();
        return false;
      }
      preview.clones.push(clonedNode);
    }

    while (preview.clones.length > normalizedCopyCount) {
      preview.clones.pop()?.dispose(false, false);
    }

    for (let index = 0; index < preview.clones.length; index += 1) {
      const clone = preview.clones[index];
      const offsetMultiplier = arrayStepMeters * (index + 1);
      clone.position.copyFromFloats(
        source.root.position.x + geometry.direction.x * offsetMultiplier,
        source.root.position.y + geometry.direction.y * offsetMultiplier,
        source.root.position.z + geometry.direction.z * offsetMultiplier,
      );
      clone.computeWorldMatrix(true);
    }
    preview.placementSignature = placementSignature;

    return true;
  }

  /** 清除当前全部临时阵列批次或克隆，不释放源实体的材质、纹理或几何资源。 */
  clearEntityArrayPreview(): void {
    if (!this.entityArrayPreview) return;

    for (const clone of this.entityArrayPreview.clones) {
      clone.dispose(false, false);
    }
    this.entityArrayPreview.matrixPreview?.dispose();
    this.entityArrayPreview.poiBoundsMaterial?.dispose(false, false);
    this.entityArrayPreview = null;
  }

  /** 汇总多个实体的世界包围盒，供场景聚焦和模型阵列读取中心、尺寸与几何就绪状态。 */
  getEntitiesWorldBounds(entityIds: string[]): {
    center: Vector3Data;
    sizeMeters: Vector3Data;
    radiusMeters: number;
    geometryReady: boolean;
    requestedEntityCount: number;
    resolvedEntityCount: number;
    geometryReadyEntityCount: number;
    missingEntityCount: number;
    notReadyEntityCount: number;
    missingEntityIds: string[];
    notReadyEntityIds: string[];
  } | null {
    let mergedBounds: RuntimeWorldBounds | null = null;
    let geometryReady = true;
    let resolvedEntityCount = 0;
    let geometryReadyEntityCount = 0;
    let missingEntityCount = 0;
    let notReadyEntityCount = 0;
    const missingEntityIds: string[] = [];
    const notReadyEntityIds: string[] = [];
    const uniqueEntityIds = [...new Set(entityIds)];

    for (const entityId of uniqueEntityIds) {
      const bounds = this.getEntityWorldBounds(entityId);
      if (!bounds) {
        geometryReady = false;
        missingEntityCount += 1;
        if (missingEntityIds.length < 32) missingEntityIds.push(entityId);
        continue;
      }
      resolvedEntityCount += 1;
      if (this.isEntityWorldBoundsReady(entityId)) {
        geometryReadyEntityCount += 1;
      } else {
        geometryReady = false;
        notReadyEntityCount += 1;
        if (notReadyEntityIds.length < 32) notReadyEntityIds.push(entityId);
      }
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (!mergedBounds) return null;

    const center = mergedBounds.minimum.add(mergedBounds.maximum).scale(0.5);
    const size = mergedBounds.maximum.subtract(mergedBounds.minimum);
    const radiusMeters = Math.max(0.5, size.length() / 2);

    return {
      center: { x: center.x, y: center.y, z: center.z },
      sizeMeters: { x: size.x, y: size.y, z: size.z },
      radiusMeters,
      geometryReady,
      requestedEntityCount: uniqueEntityIds.length,
      resolvedEntityCount,
      geometryReadyEntityCount,
      missingEntityCount,
      notReadyEntityCount,
      missingEntityIds,
      notReadyEntityIds,
    };
  }

  /** 设置发布 Viewer 的本地持久选区，不影响编辑器权威选区和外部定位高亮。 */
  setLocalHighlightEntityIds(entityIds: readonly string[]): void {
    this.setTransientHighlightEntityIds('local', entityIds);
  }

  /** 清除发布 Viewer 的本地持久选区。 */
  clearLocalHighlight(): void {
    this.setLocalHighlightEntityIds([]);
  }

  /** 设置不影响编辑器选区的外部临时描边。 */
  setExternalHighlightEntityIds(entityIds: readonly string[]): void {
    this.setTransientHighlightEntityIds('external', entityIds);
  }

  /** 清除外部临时描边，同时保留编辑器和 Viewer 本地选区。 */
  clearExternalHighlight(): void {
    this.setExternalHighlightEntityIds([]);
  }

  /** 差量替换指定临时高亮来源，并只刷新前后变化实体的表现。 */
  private setTransientHighlightEntityIds(
    source: 'local' | 'external',
    entityIds: readonly string[],
  ): void {
    const currentEntityIds = source === 'local'
      ? this.localHighlightedEntityIds
      : this.externalHighlightedEntityIds;
    const nextEntityIds = new Set(entityIds.filter((entityId) => typeof entityId === 'string' && entityId.length > 0));
    const changedEntityIds = new Set<string>();
    for (const entityId of currentEntityIds) {
      if (!nextEntityIds.has(entityId)) changedEntityIds.add(entityId);
    }
    for (const entityId of nextEntityIds) {
      if (!currentEntityIds.has(entityId)) changedEntityIds.add(entityId);
    }
    if (changedEntityIds.size === 0) return;

    if (source === 'local') this.localHighlightedEntityIds = nextEntityIds;
    else this.externalHighlightedEntityIds = nextEntityIds;
    for (const entityId of [...changedEntityIds]) {
      this.appendBuiltInSlotEntityIdsForHost(entityId, changedEntityIds);
    }
    for (const entityId of changedEntityIds) {
      const entity = this.syncedEntities.get(entityId);
      if (entity) this.syncEntityPresentation(entity, this.isEntityHighlighted(entityId));
    }
    this.rebuildModelSelectionOutline();
  }
  /** 判断实体的真实几何是否已就绪，避免模型加载或外置脚本初始化中的临时包围盒参与正式阵列。 */
  private isEntityWorldBoundsReady(entityId: string): boolean {
    const model = this.models.get(entityId);
    if (model) {
      if (!model.assetHandle || !model.stackerTelemetryReady) return false;
      return !model.modelArrayBatch || model.modelArrayBatch.hasEntityId(entityId);
    }

    const modelArrayInstance = this.modelArrayInstanceEntities.get(entityId);
    if (modelArrayInstance) {
      const renderModel = this.resolveModelArrayRenderModel(modelArrayInstance);
      return Boolean(
        renderModel?.assetHandle
        && renderModel.measurementReady
        && renderModel.modelArrayBatch?.hasEntityId(entityId),
      );
    }

    const modelGenerator = this.modelGenerators.get(entityId);
    if (modelGenerator) return true;

    const cadReference = this.cadReferences.get(entityId);
    if (cadReference) return cadReference.geometryReady && cadReference.lineMeshes.length > 0;

    return this.meshes.has(entityId)
      || this.skyboxRuntime.hasEntity(entityId)
      || this.locators.has(entityId)
      || this.lights.has(entityId)
      || this.poiEffectRuntime.has(entityId)
      || Boolean(this.syncedEntities.get(entityId)?.components.autoPatrol);
  }

  /** 将浏览器客户端坐标转换为 Babylon 画布内拾取坐标，并过滤画布外输入。 */
  private getCanvasPickPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  /** 根据运行时对象类型读取单个实体的世界包围盒。 */
  private getEntityWorldBounds(entityId: string): RuntimeWorldBounds | null {
    const primitiveMesh = this.meshes.get(entityId);
    if (primitiveMesh) return getMeshWorldBounds(primitiveMesh);

    const skyboxMesh = this.skyboxRuntime.getMesh(entityId);
    if (skyboxMesh) return getMeshWorldBounds(skyboxMesh);

    const locator = this.locators.get(entityId);
    if (locator) {
      // fillMesh 的局部包围盒已覆盖全部薄实例格子，直接读世界包围盒即可。
      const bounds = getMeshWorldBounds(locator.fillMesh);
      if (bounds) return bounds;
    }

    const cadReference = this.cadReferences.get(entityId);
    if (cadReference) return this.getCadReferenceWorldBounds(cadReference);

    const modelArrayInstance = this.modelArrayInstanceEntities.get(entityId);
    const modelArrayRenderModel = modelArrayInstance ? this.resolveModelArrayRenderModel(modelArrayInstance) : null;
    if (modelArrayInstance && modelArrayRenderModel) {
      return this.getModelArrayInstanceWorldBounds(modelArrayInstance, modelArrayRenderModel);
    }

    const model = this.models.get(entityId);
    if (model) return this.getModelWorldBounds(model);

    const modelGenerator = this.modelGenerators.get(entityId);
    if (modelGenerator) return this.getModelGeneratorWorldBounds(modelGenerator);

    const light = this.lights.get(entityId);
    if (light) return this.getLightWorldBounds(light);

    const autoPatrolEntity = this.syncedEntities.get(entityId);
    if (autoPatrolEntity?.components.autoPatrol) {
      const position = autoPatrolEntity.components.transform.position;
      return createPointWorldBounds(new Vector3(position.x, position.y, position.z));
    }

    const poiEffectMeshes = this.poiEffectRuntime.getWorldBoundsMeshes(entityId);
    if (poiEffectMeshes.length > 0) {
      let mergedBounds: RuntimeWorldBounds | null = null;
      for (const mesh of poiEffectMeshes) {
        const bounds = getMeshWorldBounds(mesh);
        if (!bounds) continue;
        mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
      }
      if (mergedBounds) return mergedBounds;
    }

    return null;
  }

  /** 检查 Mesh 自身和模型内部祖先；实体根可能因显隐或矩阵批次被禁用，不作为几何失效依据。 */
  private isModelBoundsMesh(model: ModelRuntimeEntry, mesh: AbstractMesh): boolean {
    if (!isMeasurableModelMesh(mesh)) return false;

    let ancestor = mesh.parent;
    while (ancestor && ancestor !== model.root) {
      if (!ancestor.isEnabled(false)) return false;
      ancestor = ancestor.parent;
    }
    return ancestor === model.root;
  }

  /** 导入模型只汇总内部层级有效且有顶点的子网格包围盒，加载中则回退到模型根节点位置。 */
  private getModelWorldBounds(model: ModelRuntimeEntry): RuntimeWorldBounds | null {
    // 遥测代理没有自身网格：把宿主模型的世界包围盒按两台设备的相对位姿换算到代理位姿。
    const proxySource = model.telemetryProxySource;
    if (proxySource) {
      const sourceBounds = this.getModelWorldBounds(proxySource);
      if (!sourceBounds) return null;
      const relativeMatrix = computeRootRelativeWorldMatrix(proxySource.root, model.root);
      return relativeMatrix ? transformWorldBounds(sourceBounds, relativeMatrix) : null;
    }

    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const mesh of model.meshes) {
      if (!this.isModelBoundsMesh(model, mesh)) continue;
      const bounds = getMeshWorldBounds(mesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;

    model.root.computeWorldMatrix(true);
    return createPointWorldBounds(model.root.getAbsolutePosition());
  }

  /** 按实体参数组合返回真正提供几何的源模型或隐藏参数脚本宿主。 */
  private resolveModelArrayRenderModel(entity: Entity): ModelRuntimeEntry | null {
    const variant = this.modelArrayParameterVariantByEntityId.get(entity.id);
    if (variant) return variant.model;

    const sourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    return sourceEntityId ? this.models.get(sourceEntityId) ?? null : null;
  }

  /** 将源模型有效网格的世界包围盒角点转换到一个独立矩阵实例的世界空间。 */
  private getModelArrayInstanceWorldPoints(entity: Entity, sourceModel: ModelRuntimeEntry): Vector3[] | null {
    sourceModel.root.computeWorldMatrix(true);
    const inverseSourceRoot = sourceModel.root.getWorldMatrix().clone();
    const determinant = inverseSourceRoot.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return null;
    inverseSourceRoot.invert();

    const targetWorldMatrix = this.createEntityTransformMatrix(entity.components.transform);
    const points: Vector3[] = [];
    for (const mesh of sourceModel.meshes) {
      if (!this.isModelBoundsMesh(sourceModel, mesh)) continue;
      mesh.computeWorldMatrix(true);
      const meshWorldMatrix = mesh.getWorldMatrix().clone();
      const hasThinInstances = mesh instanceof Mesh && mesh.thinInstanceCount > 0;
      const thinInstanceMatrices = hasThinInstances ? readCurrentThinInstanceMatrices(mesh) : null;
      if (hasThinInstances && !thinInstanceMatrices) return null;
      const sourceWorldMatrices = hasThinInstances
        ? thinInstanceMatrices!.map((matrix) => matrix.multiply(meshWorldMatrix))
        : [meshWorldMatrix];

      // 必须从 Geometry 原始局部包围盒出发；先使用 world AABB 再旋转会二次放大斜置部件，
      // 导致负缩放或旋转阵列实例的聚焦/测量范围与真实批次不一致。
      const boundingBox = (mesh.rawBoundingInfo ?? mesh.getBoundingInfo()).boundingBox;
      for (const sourceWorldMatrix of sourceWorldMatrices) {
        const finalWorldMatrix = sourceWorldMatrix.multiply(inverseSourceRoot).multiply(targetWorldMatrix);
        for (const localCorner of boundingBox.vectors) {
          const targetWorldCorner = Vector3.TransformCoordinates(localCorner, finalWorldMatrix);
          if (isFiniteVector3(targetWorldCorner)) points.push(targetWorldCorner);
        }
      }
    }
    return points.length > 0 ? points : null;
  }

  /** 计算单个独立矩阵实例的世界轴对齐包围盒。 */
  private getModelArrayInstanceWorldBounds(entity: Entity, sourceModel: ModelRuntimeEntry): RuntimeWorldBounds | null {
    const points = this.getModelArrayInstanceWorldPoints(entity, sourceModel);
    if (!points) return createPointWorldBounds(
      new Vector3(
        entity.components.transform.position.x,
        entity.components.transform.position.y,
        entity.components.transform.position.z,
      ),
    );

    let minimum = points[0].clone();
    let maximum = points[0].clone();
    for (let index = 1; index < points.length; index += 1) {
      minimum = Vector3.Minimize(minimum, points[index]);
      maximum = Vector3.Maximize(maximum, points[index]);
    }
    return { minimum, maximum };
  }

  /** 从实体 Transform 构造与无父节点 TransformNode 一致的世界矩阵。 */
  private createEntityTransformMatrix(transform: TransformComponent): Matrix {
    return Matrix.Compose(
      new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
      Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
      new Vector3(transform.position.x, transform.position.y, transform.position.z),
    );
  }

  /** 读取实体局部 X/Y/Z 轴在世界空间的单位方向。 */
  private getTransformWorldAxes(transform: TransformComponent): [Vector3, Vector3, Vector3] | null {
    const matrix = this.createEntityTransformMatrix(transform);
    const axes = [Vector3.Right(), Vector3.Up(), Vector3.Forward()]
      .map((axis) => Vector3.TransformNormal(axis, matrix));
    if (axes.some((axis) => !Number.isFinite(axis.lengthSquared()) || axis.lengthSquared() <= 1e-12)) {
      return null;
    }
    return axes.map((axis) => axis.normalize()) as [Vector3, Vector3, Vector3];
  }

  /** 测量显式世界点集沿一组单位方向的投影跨度。 */
  private measureWorldPointsAlongAxes(points: readonly Vector3[], axes: readonly Vector3[]): number[] | null {
    if (points.length === 0 || axes.length === 0) return null;
    const minimum = axes.map(() => Number.POSITIVE_INFINITY);
    const maximum = axes.map(() => Number.NEGATIVE_INFINITY);

    for (const point of points) {
      for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
        const projection = Vector3.Dot(point, axes[axisIndex]);
        if (!Number.isFinite(projection)) return null;
        minimum[axisIndex] = Math.min(minimum[axisIndex], projection);
        maximum[axisIndex] = Math.max(maximum[axisIndex], projection);
      }
    }
    return minimum.map((value, index) => Math.max(0, maximum[index] - value));
  }

  /** 模型生成器包围盒始终只描述编辑态配置标记，不包含任何运行时自动货物。 */
  private getModelGeneratorWorldBounds(modelGenerator: ModelGeneratorRuntimeEntry): RuntimeWorldBounds | null {
    const markerBounds = getMeshWorldBounds(modelGenerator.marker.mesh);
    if (markerBounds) return markerBounds;

    modelGenerator.markerRoot.computeWorldMatrix(true);
    return createPointWorldBounds(modelGenerator.markerRoot.getAbsolutePosition());
  }

  /** CAD 参考层优先按所有线稿 Mesh 合并包围盒，加载中则回退到根节点位置。 */
  private getCadReferenceWorldBounds(cadReference: CadReferenceRuntimeEntry): RuntimeWorldBounds | null {
    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const lineMesh of cadReference.lineMeshes) {
      const bounds = getMeshWorldBounds(lineMesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;

    cadReference.root.computeWorldMatrix(true);
    return createPointWorldBounds(cadReference.root.getAbsolutePosition());
  }

  /** 灯光没有可见体积时用其位置生成一个小包围盒。 */
  private getLightWorldBounds(light: Light): RuntimeWorldBounds {
    if (light instanceof DirectionalLight || light instanceof PointLight) {
      return createPointWorldBounds(light.position);
    }

    return createPointWorldBounds(new Vector3(0, 2, 0));
  }

  /** 将编辑器文档增量同步到 Babylon 运行时场景，并记录完整同步耗时。 */
  sync(
    document: SceneDocument,
    hierarchySelectionIds?: readonly string[],
    options: SceneRuntimeSyncOptions = {},
  ): void {
    const nextModelArrayIdentityMode = options.modelArrayIdentityMode ?? 'device';
    const modelArrayIdentityModeChanged = this.modelArrayIdentityMode !== nextModelArrayIdentityMode;
    this.modelArrayIdentityMode = nextModelArrayIdentityMode;
    this.setHierarchySelectionIds(document, hierarchySelectionIds);
    this.cancelFolderGroupTransforms();
    const startedAt = readRuntimeTimestampMs();
    try {
      this.syncDocument(document, modelArrayIdentityModeChanged);
    } finally {
      const durationMs = Math.max(0, readRuntimeTimestampMs() - startedAt);
      this.fullSyncCount += 1;
      this.lastFullSyncDurationMs = durationMs;
      this.maxFullSyncDurationMs = Math.max(this.maxFullSyncDurationMs, durationMs);
    }
  }

  /**
   * 只同步一个实体的模型参数值。调用方已确认 Store 本次原子更新未改变其它场景内容；
   * 因此这里不重建层级状态、组件 ID 集合或 Locator 索引，只刷新目标及其所属矩阵源。
   */
  syncModelParameters(
    document: SceneDocument,
    entityId: string,
    hierarchySelectionIds?: readonly string[],
    options?: SceneRuntimeSyncOptions,
  ): void {
    const nextModelArrayIdentityMode = options?.modelArrayIdentityMode ?? this.modelArrayIdentityMode;
    if (nextModelArrayIdentityMode !== this.modelArrayIdentityMode) {
      this.sync(document, hierarchySelectionIds, { modelArrayIdentityMode: nextModelArrayIdentityMode });
      return;
    }
    this.setHierarchySelectionIds(document, hierarchySelectionIds);
    this.cancelFolderGroupTransforms();
    const entity = document.entities[entityId];
    const previousEntity = this.syncedEntities.get(entityId);
    if (!entity?.components.modelAsset || !previousEntity?.components.modelAsset) {
      this.sync(document, hierarchySelectionIds, { modelArrayIdentityMode: this.modelArrayIdentityMode });
      return;
    }

    const dirtyModelArraySourceIds = new Set<string>();
    const previousSourceEntityId = previousEntity.components.modelArrayInstance?.sourceEntityId;
    const nextSourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    if (previousSourceEntityId) dirtyModelArraySourceIds.add(previousSourceEntityId);
    if (nextSourceEntityId) dirtyModelArraySourceIds.add(nextSourceEntityId);
    if (!entity.components.modelArrayInstance) dirtyModelArraySourceIds.add(entity.id);

    this.syncEntity(entity, this.isEntityHighlighted(entityId));
    this.syncedEntities.set(entityId, entity);
    this.syncAllModelArrayBatches(document, dirtyModelArraySourceIds, entityId);
    this.syncModelArrayTelemetryProxies();
    this.disposeStaleModelArrayGizmoProxy();
    this.rebuildModelSelectionOutline();
  }

  /** 把高亮状态依赖宿主/副本的绑定货格实体 ID 追加进刷新集合。 */
  private appendBuiltInSlotEntityIdsForHost(hostEntityId: string, target: Set<string>): void {
    for (const entity of this.syncedEntities.values()) {
      if (entity.components.locator?.builtInBinding?.hostEntityId === hostEntityId) target.add(entity.id);
    }
  }

  /**
   * 只同步选区变化。普通单选只访问旧/新目标实体以及对应共享模型或矩阵批次，
   * 不重新扫描 entityIds、加载模型、执行参数脚本或重建 Locator 索引。
   */
  syncSelection(document: SceneDocument, hierarchySelectionIds?: readonly string[]): void {
    this.setHierarchySelectionIds(document, hierarchySelectionIds);
    this.cancelFolderGroupTransforms();
    const startedAt = readRuntimeTimestampMs();
    let changedEntityCount = 0;
    try {
      const nextSelectedEntityIds = this.resolveSelectedEntityIds(document);
      const changedEntityIds = new Set<string>();
      for (const entityId of this.selectedEntityIds) {
        if (!nextSelectedEntityIds.has(entityId)) changedEntityIds.add(entityId);
      }
      for (const entityId of nextSelectedEntityIds) {
        if (!this.selectedEntityIds.has(entityId)) changedEntityIds.add(entityId);
      }

      changedEntityCount = changedEntityIds.size;
      if (changedEntityCount === 0) return;

      const nextHighlightSet = mergeSceneRuntimeHighlightEntityIds(
        nextSelectedEntityIds,
        this.localHighlightedEntityIds,
        this.externalHighlightedEntityIds,
      );
      for (const entityId of [...changedEntityIds]) {
        this.appendBuiltInSlotEntityIdsForHost(entityId, changedEntityIds);
      }

      for (const entityId of changedEntityIds) {
        const entity = document.entities[entityId] ?? this.syncedEntities.get(entityId);
        if (!entity) continue;
        this.syncEntityPresentation(entity, this.isEntityHighlighted(entityId, nextSelectedEntityIds), nextHighlightSet);
      }

      this.selectedEntityIds = nextSelectedEntityIds;
      this.rebuildModelSelectionOutline();
    } finally {
      const durationMs = Math.max(0, readRuntimeTimestampMs() - startedAt);
      this.selectionSyncCount += 1;
      this.lastSelectionSyncDurationMs = durationMs;
      this.maxSelectionSyncDurationMs = Math.max(this.maxSelectionSyncDurationMs, durationMs);
      this.lastSelectionChangedEntityCount = changedEntityCount;
    }
  }

  /** 返回 Scene View HUD 使用的低频运行时同步指标快照。 */
  getPerformanceMetrics(): SceneRuntimePerformanceMetrics {
    const modelArrayBatches = new Set<EntityArrayThinInstanceBatch>();
    for (const model of this.models.values()) {
      if (model.modelArrayBatch) modelArrayBatches.add(model.modelArrayBatch);
    }
    for (const variant of this.modelArrayParameterVariants.values()) {
      if (variant.model.modelArrayBatch) modelArrayBatches.add(variant.model.modelArrayBatch);
    }

    let modelArrayBatchEntityCount = 0;
    let modelArrayBatchMeshCount = 0;
    for (const batch of modelArrayBatches) {
      modelArrayBatchEntityCount += batch.getEntityIds().length;
      modelArrayBatchMeshCount += batch.meshes.length;
    }
    // 保留旧报告字段作为发布防回归守卫；正式路径已删除代理 API，所有实体均为原模型 Geometry。
    const modelArrayScreenSpaceProxyBatchCount = 0;
    const modelArraySolidProxyEntityCount = 0;
    const modelArrayFrameProxyEntityCount = 0;
    const modelArrayProxyEntityCount = 0;
    const modelArrayDetailedEntityCount = modelArrayBatchEntityCount;

    return {
      fullSyncCount: this.fullSyncCount,
      selectionSyncCount: this.selectionSyncCount,
      lastFullSyncDurationMs: this.lastFullSyncDurationMs,
      maxFullSyncDurationMs: this.maxFullSyncDurationMs,
      lastSelectionSyncDurationMs: this.lastSelectionSyncDurationMs,
      maxSelectionSyncDurationMs: this.maxSelectionSyncDurationMs,
      lastSelectionChangedEntityCount: this.lastSelectionChangedEntityCount,
      modelRuntimeCount: this.models.size,
      modelArrayInstanceEntityCount: this.modelArrayInstanceEntities.size,
      modelArrayParameterVariantCount: this.modelArrayParameterVariants.size,
      modelArrayBatchCount: modelArrayBatches.size,
      modelArrayBatchEntityCount,
      modelArrayBatchMeshCount,
      modelArrayScreenSpaceProxyBatchCount,
      modelArraySolidProxyEntityCount,
      modelArrayFrameProxyEntityCount,
      modelArrayProxyEntityCount,
      modelArrayDetailedEntityCount,
    };
  }

  /** 完整同步文档内容；调用方负责统计耗时。 */
  private syncDocument(document: SceneDocument, forceModelArrayResync = false): void {
    const previousEntityStates = new Map(this.entityStates);
    const previousHighlightedEntityIds = mergeSceneRuntimeHighlightEntityIds(
      this.selectedEntityIds,
      this.localHighlightedEntityIds,
      this.externalHighlightedEntityIds,
    );
    const dirtyModelArraySourceIds = new Set<string>();

    this.entityStates.clear();
    const hierarchyStates = createEntityHierarchyStateMap(document.entityIds, document.entities);
    for (const [entityId, state] of hierarchyStates) this.entityStates.set(entityId, state);

    const primitiveMeshIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.meshRenderer)),
    );
    const locatorIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.locator)),
    );
    const cadReferenceIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.cadReference)),
    );
    const modelArrayInstanceIds = new Set(
      document.entityIds.filter((entityId) => Boolean(
        document.entities[entityId]?.components.modelAsset
        && document.entities[entityId]?.components.modelArrayInstance,
      )),
    );
    const modelIds = new Set(
      document.entityIds.filter((entityId) => Boolean(
        document.entities[entityId]?.components.modelAsset
        && !document.entities[entityId]?.components.modelArrayInstance,
      )),
    );
    const modelGeneratorIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.modelGenerator)),
    );
    if (forceModelArrayResync) {
      for (const modelId of modelIds) dirtyModelArraySourceIds.add(modelId);
    }

    const lightIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.light)),
    );
    const poiEffectIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.poiEffect)),
    );
    const autoPatrolIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.autoPatrol)),
    );
    const previewSourceId = this.entityArrayPreview?.sourceEntityId;
    if (previewSourceId && this.poiEffectRuntime.has(previewSourceId) && !poiEffectIds.has(previewSourceId)) {
      this.clearEntityArrayPreview();
    }
    this.poiEffectRuntime.disposeMissing(poiEffectIds);
    this.autoPatrolMarkerRuntime.disposeMissing(autoPatrolIds);

    for (const [entityId, mesh] of this.meshes.entries()) {
      if (!primitiveMeshIds.has(entityId)) {
        this.disposeMesh(entityId, mesh);
      }
    }

    for (const [entityId, locator] of this.locators.entries()) {
      if (!locatorIds.has(entityId)) {
        this.disposeLocator(entityId, locator);
      }
    }

    for (const [entityId, cadReference] of this.cadReferences.entries()) {
      if (!cadReferenceIds.has(entityId)) {
        this.disposeCadReference(entityId, cadReference);
      }
    }

    for (const [entityId, model] of this.models.entries()) {
      if (!modelIds.has(entityId)) {
        this.disposeModel(entityId, model);
      }
    }

    for (const entityId of [...this.modelArrayInstanceEntities.keys()]) {
      if (modelArrayInstanceIds.has(entityId)) continue;
      const previousSourceId = this.modelArrayInstanceEntities.get(entityId)?.components.modelArrayInstance?.sourceEntityId;
      if (previousSourceId) dirtyModelArraySourceIds.add(previousSourceId);
      this.modelArrayInstanceEntities.delete(entityId);
      const trajectory = this.conveyorTrajectories.get(entityId);
      if (trajectory) this.disposeConveyorTrajectory(entityId, trajectory);
    }
    for (const [entityId, modelGenerator] of this.modelGenerators.entries()) {
      if (!modelGeneratorIds.has(entityId)) {
        this.disposeModelGenerator(entityId, modelGenerator);
      }
    }

    for (const [entityId, light] of this.lights.entries()) {
      if (!lightIds.has(entityId)) {
        this.disposeLight(entityId, light);
      }
    }
    this.lightMarkerRuntime.disposeMissing(lightIds);

    for (const entityId of [...this.syncedEntities.keys()]) {
      if (!document.entities[entityId]) this.syncedEntities.delete(entityId);
    }
    for (const entityId of this.localHighlightedEntityIds) {
      if (!document.entities[entityId]) this.localHighlightedEntityIds.delete(entityId);
    }
    for (const entityId of this.externalHighlightedEntityIds) {
      if (!document.entities[entityId]) this.externalHighlightedEntityIds.delete(entityId);
    }

    const selectedEntityIds = this.resolveSelectedEntityIds(document);
    const nextHighlightSet = mergeSceneRuntimeHighlightEntityIds(
      selectedEntityIds,
      this.localHighlightedEntityIds,
      this.externalHighlightedEntityIds,
    );

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;

      const selected = this.isEntityHighlighted(entityId, selectedEntityIds);
      const previousEntity = this.syncedEntities.get(entityId);
      const previousState = previousEntityStates.get(entityId);
      const nextState = this.entityStates.get(entityId);
      const entityChanged = previousEntity !== entity;
      const runtimeStateChanged = !this.areEntityRuntimeStatesEqual(previousState, nextState);
      const slotBinding = entity.components.locator?.builtInBinding;
      const slotHostHighlightChanged = slotBinding
        ? previousHighlightedEntityIds.has(slotBinding.hostEntityId)
          !== this.isEntityHighlighted(slotBinding.hostEntityId, nextHighlightSet)
        : false;
      const presentationChanged = previousHighlightedEntityIds.has(entityId) !== selected
        || runtimeStateChanged
        || slotHostHighlightChanged;
      if (entityChanged || runtimeStateChanged) {
        const previousSourceId = previousEntity?.components.modelArrayInstance?.sourceEntityId;
        const nextSourceId = entity.components.modelArrayInstance?.sourceEntityId;
        if (previousSourceId) dirtyModelArraySourceIds.add(previousSourceId);
        if (nextSourceId) dirtyModelArraySourceIds.add(nextSourceId);
        if (entity.components.modelAsset && !entity.components.modelArrayInstance) {
          dirtyModelArraySourceIds.add(entity.id);
        }
      }

      if (entityChanged || !this.hasCompleteRuntimeEntity(entity)) {
        this.syncEntity(entity, selected, nextHighlightSet);
      } else if (presentationChanged) {
        this.syncEntityPresentation(entity, selected, nextHighlightSet);
      }

      this.syncedEntities.set(entityId, entity);
    }

    this.syncSkybox(document);
    this.syncAllModelArrayBatches(document, dirtyModelArraySourceIds);
    this.syncModelArrayTelemetryProxies();
    this.disposeStaleModelArrayGizmoProxy();
    this.selectedEntityIds = selectedEntityIds;
    this.rebuildLocatorTargetIndex(document);
    this.rebuildModelSelectionOutline();
  }

  /** 判断实体已有的 Babylon 对象是否覆盖其全部运行时组件；缺失时回退完整同步。 */
  private hasCompleteRuntimeEntity(entity: Entity): boolean {
    if (entity.components.meshRenderer && !this.meshes.has(entity.id)) return false;
    if (entity.components.skybox && !this.skyboxRuntime.hasEntity(entity.id)) return false;
    if (entity.components.locator && !this.locators.has(entity.id)) return false;
    if (entity.components.cadReference && !this.cadReferences.has(entity.id)) return false;
    if (entity.components.modelAsset) {
      if (entity.components.modelArrayInstance && !this.modelArrayInstanceEntities.has(entity.id)) return false;
      if (!entity.components.modelArrayInstance && !this.models.has(entity.id)) return false;
    }
    if (entity.components.modelGenerator && !this.modelGenerators.has(entity.id)) return false;
    if (entity.components.poiEffect && !this.poiEffectRuntime.has(entity.id)) return false;
    if (entity.components.light && !this.lights.has(entity.id)) return false;
    if (entity.components.light && !this.lightMarkerRuntime.isComplete(entity)) return false;
    if (entity.components.autoPatrol && !this.autoPatrolMarkerRuntime.isComplete(entity)) return false;
    return true;
  }

  /** 比较实体有效显隐和锁定状态，避免未变化实体重复进入完整同步链。 */
  private areEntityRuntimeStatesEqual(
    previous: EntityRuntimeState | undefined,
    next: EntityRuntimeState | undefined,
  ): boolean {
    return previous?.visible === next?.visible && previous?.locked === next?.locked;
  }

  /** 仅刷新选择、显隐和锁定相关表现，不重复执行模型加载、参数或外置脚本。 */
  private syncEntityPresentation(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    this.clearEntityArrayPreviewIfSource(entity.id);
    const primitiveMesh = this.meshes.get(entity.id);
    const meshRenderer = entity.components.meshRenderer;
    if (primitiveMesh && meshRenderer) {
      this.applyMeshInteractivity(primitiveMesh, entity.id);
      this.applyPrimitiveMeshAppearance(primitiveMesh, meshRenderer, selected);
    }

    if (entity.components.skybox) this.syncSkyboxEntity(entity, selected);

    const locator = this.locators.get(entity.id);
    if (locator && entity.components.locator) {
      this.applyLocatorStyle(locator, selected);
      this.applyLocatorInteractivity(locator, entity, highlightSet);
    }

    const cadReference = this.cadReferences.get(entity.id);
    if (cadReference) {
      this.applyCadReferenceInteractivity(cadReference, entity.id);
    }

    if (entity.components.modelArrayInstance) {
      this.modelArrayInstanceEntities.set(entity.id, entity);
      if (this.modelArrayGizmoProxy?.entityId === entity.id) {
        this.applyTransform(this.modelArrayGizmoProxy.node, entity.components.transform);
        this.modelArrayGizmoProxy.node.computeWorldMatrix(true);
      }
    } else {
      const model = this.models.get(entity.id);
      if (model) {
        this.applyModelSelection(model, selected);
        this.applyModelInteractivity(model, entity.id, highlightSet);
      }
    }

    const modelGenerator = this.modelGenerators.get(entity.id);
    if (modelGenerator) {
      modelGenerator.selected = selected;
      this.applyModelGeneratorPresentation(modelGenerator);
    }

    if (entity.components.poiEffect) {
      this.poiEffectRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.autoPatrol) {
      this.autoPatrolMarkerRuntime.syncPresentation(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    const light = this.lights.get(entity.id);
    light?.setEnabled(this.isEntityVisible(entity.id));
    if (light && entity.components.light) {
      this.lightMarkerRuntime.syncPresentation(
        entity.id,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    const trajectory = this.conveyorTrajectories.get(entity.id);
    if (trajectory) this.refreshConveyorTrajectoryRoot(entity, trajectory.root);
  }

  /** 货箱运行问题按稳定 key 只写一次 Console。 */
  private reportCargoIssue(key: string, message: string): void {
    if (this.reportedCargoIssues.has(key)) return;
    this.reportedCargoIssues.add(key);
    this.pushLog(message);
  }

  /** 读取设备绑定的模型生成器运行时条目；绑定失效时回退内置几何体并提示一次。 */
  private resolveCargoGeneratorForModel(model: ModelRuntimeEntry): ModelGeneratorRuntimeEntry | null {
    const generatorId = model.telemetryBinding?.cargoGeneratorId?.trim();
    if (!generatorId) return null;
    const generator = this.modelGenerators.get(generatorId) ?? null;
    if (!generator) {
      this.reportCargoIssue(
        `cargo-generator-missing:${model.assetCode}:${generatorId}`,
        `设备 ${model.assetCode} 绑定的模型生成器已被删除，货箱回退内置几何体。`,
      );
    }
    return generator;
  }

  /** 按实体 ID 解析 RGV 列接驳位实体的世界位姿：依次查模型、定位线框、基础网格和合批阵列实例。 */
  private resolveColumnTargetPose(entityId: string): { position: Vector3; rotation: Quaternion } | null {
    const model = this.models.get(entityId);
    if (model) {
      return { position: model.root.getAbsolutePosition(), rotation: getNodeWorldRotation(model.root) };
    }
    const locator = this.locators.get(entityId);
    if (locator) {
      return { position: locator.root.getAbsolutePosition(), rotation: getNodeWorldRotation(locator.root) };
    }
    const mesh = this.meshes.get(entityId);
    if (mesh) {
      return { position: mesh.getAbsolutePosition(), rotation: getNodeWorldRotation(mesh) };
    }
    // 合批阵列实例没有独立运行时节点；其实体 Transform 就是批次实例的世界矩阵，直接等价于 root 位姿。
    const arrayInstance = this.modelArrayInstanceEntities.get(entityId);
    if (arrayInstance) {
      const transform = arrayInstance.components.transform;
      return {
        position: new Vector3(transform.position.x, transform.position.y, transform.position.z),
        rotation: Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
      };
    }
    return null;
  }


  /** 同步球形天空盒实体；没有实体时兼容旧 sceneSettings.skybox。 */
  syncSkybox(document: SceneDocument): void {
    const entity = getSceneSkyboxEntity(document);
    if (entity?.components.skybox) {
      this.syncSkyboxEntity(entity, this.resolveSelectedEntityIds(document).has(entity.id));
      return;
    }

    const skybox = getSceneSkyboxSettings(document);
    if (!skybox) {
      this.skyboxRuntime.sync(null);
      return;
    }
    this.skyboxRuntime.sync({
      entityId: null,
      skybox,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: skybox.rotationDegrees * Math.PI / 180, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      visible: true,
      pickable: false,
      selected: false,
    });
  }

  /** 将天空盒实体的 Transform、层级显隐、锁定与选中态同步到球体运行时。 */
  private syncSkyboxEntity(entity: Entity, selected: boolean): void {
    const skybox = createSceneSkyboxSettingsFromEntity(entity);
    if (!skybox) {
      this.skyboxRuntime.sync(null);
      return;
    }
    this.skyboxRuntime.sync({
      entityId: entity.id,
      skybox,
      transform: entity.components.transform,
      visible: this.isEntityVisible(entity.id),
      pickable: this.isEntityScenePickable(entity.id),
      selected,
    });
  }

  /** 同步场景级环境底座模型；环境不写入实体索引，也不能被场景点击选中。 */
  syncEnvironment(environment: SceneEnvironmentSettings | null): void {
    this.environmentRuntime.sync(environment);
  }

  /** 事务式加载候选环境；成功前保留当前有效环境。 */
  applyEnvironment(
    environment: SceneEnvironmentSettings,
    options: SceneEnvironmentApplyOptions,
  ): Promise<EnvironmentApplyResult> {
    return this.environmentRuntime.apply(environment, options);
  }

  /** 返回环境根节点供临时 Gizmo 调整；旧版摆放环境不开放该入口。 */
  getEnvironmentGizmoTarget(): TransformNode | null {
    return this.environmentRuntime.getGizmoTarget();
  }

  /** 返回当前环境的世界包围盒，供聚焦与 Inspector 摘要使用。 */
  getEnvironmentWorldBounds(): EnvironmentWorldBounds | null {
    return this.environmentRuntime.getWorldBounds();
  }

  /** 切换环境调整态的静态矩阵冻结与辅助包围框。 */
  setEnvironmentAdjustmentActive(active: boolean): void {
    this.environmentRuntime.setAdjustmentActive(active);
  }

  dispose(): void {
    this.clearEntityArrayPreview();
    this.cancelFolderGroupTransforms();
    this.entityGroupGizmoProxy?.node.dispose(false, false);
    this.entityGroupGizmoProxy = null;
    this.modelArrayGizmoProxy?.node.dispose(false, false);
    this.modelArrayGizmoProxy = null;
    this.environmentRuntime.dispose();
    this.assetLoadScheduler.dispose();
    if (this.telemetryObserver) {
      this.scene.onBeforeRenderObservable.remove(this.telemetryObserver);
    }
    if (this.groupTransformPreviewObserver) {
      this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.groupTransformPreviewObserver);
    }
    if (this.modelArrayVariantRenderSuppressionObserver) {
      this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.modelArrayVariantRenderSuppressionObserver);
    }
    if (this.modelArrayVariantRenderRestoreObserver) {
      this.scene.onAfterRenderObservable.remove(this.modelArrayVariantRenderRestoreObserver);
    }
    this.restoreSuppressedModelArrayVariantHostsAfterRender();
    this.pendingModelArrayVariantRenderSuppressions.clear();
    this.endTelemetryPreview();
    for (const [entityId, mesh] of this.meshes.entries()) {
      this.disposeMesh(entityId, mesh);
    }
    for (const [entityId, locator] of this.locators.entries()) {
      this.disposeLocator(entityId, locator);
    }
    for (const [entityId, cadReference] of this.cadReferences.entries()) {
      this.disposeCadReference(entityId, cadReference);
    }
    for (const [entityId, trajectory] of this.conveyorTrajectories.entries()) {
      this.disposeConveyorTrajectory(entityId, trajectory);
    }
    for (const [entityId, model] of this.models.entries()) {
      this.disposeModel(entityId, model);
    }
    for (const variant of [...this.modelArrayParameterVariants.values()]) {
      this.disposeModelArrayParameterVariant(variant);
    }
    for (const [entityId, proxy] of [...this.modelArrayTelemetryProxies.entries()]) {
      this.disposeModelArrayTelemetryProxy(entityId, proxy);
    }
    for (const [entityId, modelGenerator] of this.modelGenerators.entries()) {
      this.disposeModelGenerator(entityId, modelGenerator);
    }
    this.poiEffectRuntime.dispose();
    this.specializedTelemetryRuntime.dispose();
    for (const [entityId, light] of this.lights.entries()) {
      this.disposeLight(entityId, light);
    }
    this.lightMarkerRuntime.dispose();
    this.autoPatrolMarkerRuntime.dispose();
    this.shadowRuntime.dispose();
    this.skyboxRuntime.dispose();
    this.sharedModelAssetCache.dispose();
    this.modelSelectionOutlineLayer.dispose();
    this.meshes.clear();
    this.locators.clear();
    this.locatorTargets.clear();
    this.reportedDuplicateLocatorTargets.clear();
    this.reportedOverlappingLocatorRanges.clear();
    this.cadReferences.clear();
    this.conveyorTrajectories.clear();
    this.models.clear();
    this.modelArrayInstanceEntities.clear();
    this.modelArrayParameterVariants.clear();
    this.modelArrayParameterVariantByEntityId.clear();
    this.pendingModelArraySourceResyncs.clear();
    this.pendingModelArrayVariantRenderSuppressions.clear();
    this.suppressedModelArrayVariantRootsThisFrame.clear();
    this.modelArrayCanonicalSignatureIds.clear();
    this.modelArrayCanonicalSignatureSequence = 0;
    this.modelArrayBatchByMeshUniqueId.clear();
    this.modelGenerators.clear();
    this.generatedOutputOwners.clear();
    this.lights.clear();
    this.entityStates.clear();
    this.syncedEntities.clear();
    this.selectedEntityIds.clear();
    this.localHighlightedEntityIds.clear();
    this.externalHighlightedEntityIds.clear();
    this.reportedCargoIssues.clear();
    this.outlinedModelArrayBatches.clear();
  }

  /** 按组件类型同步单个实体的运行时表现。 */
  private syncEntity(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    this.clearEntityArrayPreviewIfSource(entity.id);
    if (entity.components.meshRenderer) {
      this.syncPrimitiveMeshEntity(entity, selected);
    }

    if (entity.components.skybox) {
      this.syncSkyboxEntity(entity, selected);
    }

    if (entity.components.locator) {
      this.syncLocatorEntity(entity, selected, highlightSet);
    }

    if (entity.components.cadReference) {
      this.syncCadReferenceEntity(entity);
    }

    if (entity.components.modelAsset) {
      if (entity.components.modelArrayInstance) this.syncModelArrayInstanceEntity(entity, highlightSet);
      else this.syncModelEntity(entity, selected, highlightSet);
    }

    if (entity.components.modelGenerator) {
      this.syncModelGeneratorEntity(entity, selected);
    }

    if (entity.components.poiEffect) {
      this.poiEffectRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.autoPatrol) {
      this.autoPatrolMarkerRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.light) {
      this.syncLightEntity(entity, selected);
    }
  }

  /** 重建虚拟定位线框资产编号索引与设备绑定索引，供 to_x/to_y/to_z 快速查找目标位。 */
  private rebuildLocatorTargetIndex(document: SceneDocument): void {
    this.locatorTargets.clear();
    this.locatorDeviceIndex.clear();
    const duplicateAssetIds = new Set<string>();

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      const locatorComponent = entity?.components.locator;
      const assetId = locatorComponent?.assetId.trim();
      const locator = this.locators.get(entityId);
      if (!assetId || !locator || duplicateAssetIds.has(assetId)) continue;

      locator.assetId = assetId;
      if (this.locatorTargets.has(assetId)) {
        this.locatorTargets.delete(assetId);
        duplicateAssetIds.add(assetId);
        continue;
      }
      this.locatorTargets.set(assetId, locator);

      // 构建设备绑定索引
      const deviceCode = locatorComponent?.deviceAssetCode?.trim();
      if (deviceCode) {
        const rowNumber = locatorComponent?.rowNumber ?? 1;
        let rowMap = this.locatorDeviceIndex.get(deviceCode);
        if (!rowMap) {
          rowMap = new Map();
          this.locatorDeviceIndex.set(deviceCode, rowMap);
        }
        const list = rowMap.get(rowNumber) ?? [];
        list.push(locator);
        rowMap.set(rowNumber, list);
      }
    }

    for (const assetId of duplicateAssetIds) {
      if (this.reportedDuplicateLocatorTargets.has(assetId)) continue;
      this.reportedDuplicateLocatorTargets.add(assetId);
      this.pushLog(`库位资产编号冲突，已停止目标绑定：${assetId}`);
    }
    for (const assetId of [...this.reportedDuplicateLocatorTargets]) {
      if (!duplicateAssetIds.has(assetId)) this.reportedDuplicateLocatorTargets.delete(assetId);
    }

    // 同设备同排的列/层范围重叠检测：front_ 定位要求唯一命中，重叠时在编辑期即告警，运行时拒绝定位
    const overlappingPairs = new Set<string>();
    for (const [deviceCode, rowMap] of this.locatorDeviceIndex) {
      for (const [rowNumber, list] of rowMap) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const a = list[i];
            const b = list[j];
            const columnOverlap = a.startColumn < b.startColumn + b.columns && b.startColumn < a.startColumn + a.columns;
            const layerOverlap = a.startLayer < b.startLayer + b.layers && b.startLayer < a.startLayer + a.layers;
            if (!columnOverlap || !layerOverlap) continue;
            const pairKey = `${deviceCode}:${rowNumber}:${[a.assetId, b.assetId].sort().join('|')}`;
            overlappingPairs.add(pairKey);
            if (this.reportedOverlappingLocatorRanges.has(pairKey)) continue;
            this.reportedOverlappingLocatorRanges.add(pairKey);
            this.pushLog(`错误：定位线框「${a.assetId}」（列${a.startColumn}-${a.startColumn + a.columns - 1} 层${a.startLayer}-${a.startLayer + a.layers - 1}）与「${b.assetId}」（列${b.startColumn}-${b.startColumn + b.columns - 1} 层${b.startLayer}-${b.startLayer + b.layers - 1}）关联同一设备 ${deviceCode} 排${rowNumber} 且范围重叠，front_ 定位将拒绝命中重叠区域，请调整使范围互不重叠。`);
          }
        }
      }
    }
    for (const key of [...this.reportedOverlappingLocatorRanges]) {
      if (!overlappingPairs.has(key)) this.reportedOverlappingLocatorRanges.delete(key);
    }
  }

  /** 按设备编号 + 排号 + 列/层范围查找目标 Locator：front_ 定位要求 (x, y, z) 唯一命中，零个或多个（同排范围重叠）命中都返回 null。 */
  private findLocatorByDevice(
    deviceAssetCode: string,
    toX: number,
    toY: number,
    toZ: number,
  ): LocatorRuntimeEntry | null {
    const rowMap = this.locatorDeviceIndex.get(deviceAssetCode);
    if (!rowMap) return null;
    const list = rowMap.get(toZ);
    if (!list?.length) return null;
    let matched: LocatorRuntimeEntry | null = null;
    for (const locator of list) {
      const covered = toX >= locator.startColumn && toX < locator.startColumn + locator.columns
        && toY >= locator.startLayer && toY < locator.startLayer + locator.layers;
      if (!covered) continue;
      if (matched) return null;
      matched = locator;
    }
    return matched;
  }

  /** 返回设备绑定的全部 Locator（所有排），无绑定时返回空数组。 */
  private findLocatorsByDevice(deviceAssetCode: string): LocatorRuntimeEntry[] {
    const rowMap = this.locatorDeviceIndex.get(deviceAssetCode);
    if (!rowMap) return [];
    const result: LocatorRuntimeEntry[] = [];
    for (const list of rowMap.values()) result.push(...list);
    return result;
  }

  /** 在 Locator 的 boxes 网格中根据列/层定位具体 box 的世界矩阵，平移对齐 box 底面中心（货物支撑位）。 */
  private getLocatorBoxWorldMatrix(locator: LocatorRuntimeEntry, toX: number, toY: number): Matrix | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      startLayer: locator.startLayer,
      columns: locator.columns,
      layers: locator.layers,
      toX,
      toY,
    });
    if (boxIndex === null) return null;
    const supportPosition = resolveLocatorCellSupportWorldPosition(locator, boxIndex);
    if (!supportPosition) return null;
    // 货物模板原点即底部支撑点：矩阵平移取格子底面中心，与 stacker 接管货物的支撑位一致
    const worldMatrix = locator.root.getWorldMatrix().clone();
    worldMatrix.setTranslation(supportPosition);
    return worldMatrix;
  }


  /** 保存调用方提供的 transient Hierarchy 选区；未提供时回退到场景主选对象。 */
  private setHierarchySelectionIds(
    document: SceneDocument,
    hierarchySelectionIds?: readonly string[],
  ): void {
    this.hierarchySelectionIds = hierarchySelectionIds === undefined
      ? null
      : [...new Set(hierarchySelectionIds)].filter((entityId) => Boolean(document.entities[entityId]));
  }

  /** 外部描边只叠加展示，不修改编辑器的权威选区。 */
  private isEntityHighlighted(
    entityId: string,
    selectedEntityIds: ReadonlySet<string> = this.selectedEntityIds,
  ): boolean {
    return selectedEntityIds.has(entityId)
      || this.localHighlightedEntityIds.has(entityId)
      || this.externalHighlightedEntityIds.has(entityId);
  }
  /** 将普通实体和文件夹多选统一展开为全部需要高亮的运行时实体。 */
  private resolveSelectedEntityIds(document: SceneDocument): Set<string> {
    const selectionIds = this.hierarchySelectionIds
      ?? (document.selectedEntityId ? [document.selectedEntityId] : []);
    const selectedEntityIds = new Set<string>();

    for (const selectionId of selectionIds) {
      const selectedEntity = document.entities[selectionId];
      if (!selectedEntity) continue;
      if (!selectedEntity.isFolder) {
        selectedEntityIds.add(selectedEntity.id);
        continue;
      }
      for (const entityId of collectFolderRuntimeEntityIds(document.entities, selectedEntity.id)) {
        selectedEntityIds.add(entityId);
      }
    }
    return selectedEntityIds;
  }

  /** 同步基础几何体 Mesh 类型、Transform 与选中材质状态。 */
  private syncPrimitiveMeshEntity(entity: Entity, selected: boolean): void {
    const meshRenderer = entity.components.meshRenderer;
    if (!meshRenderer) return;

    let mesh = this.meshes.get(entity.id);
    if (mesh && mesh.metadata?.editorMeshKind !== meshRenderer.meshKind) {
      this.disposeMesh(entity.id, mesh);
      mesh = undefined;
    }

    if (!mesh) {
      mesh = this.createMesh(entity);
      this.meshes.set(entity.id, mesh);
    }

    this.applyTransform(mesh, entity.components.transform);
    this.applyMeshInteractivity(mesh, entity.id);

    this.applyPrimitiveMeshAppearance(mesh, meshRenderer, selected);
  }

  /** 刷新基础 Mesh 原始材质；选中反馈统一由选择高亮层绘制，不改写模型表面。 */
  private applyPrimitiveMeshAppearance(mesh: Mesh, meshRenderer: MeshRendererComponent, _selected: boolean): void {
    const material = mesh.material instanceof StandardMaterial ? mesh.material : new StandardMaterial(`${mesh.name}_mat`, this.scene);
    material.diffuseColor = this.readColor(meshRenderer.materialColor);
    material.emissiveColor = Color3.Black();
    mesh.material = material;
  }

  /** 同步虚拟定位线框的根 Transform、业务尺寸和选中态线框颜色。 */
  private syncLocatorEntity(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    const locator = entity.components.locator;
    if (!locator) return;

    const binding = locator.builtInBinding ?? null;
    const hostEntry = binding ? this.models.get(binding.hostEntityId) ?? null : null;
    // 阵列副本没有独立模型宿主：副本参数与源分化后经参数变体渲染，布局必须读实际渲染它的模型。
    const arrayHostEntity = !hostEntry && binding
      ? this.modelArrayInstanceEntities.get(binding.hostEntityId) ?? null
      : null;
    const arrayHostRenderEntry = arrayHostEntity ? this.resolveModelArrayRenderModel(arrayHostEntity) : null;
    const bound = Boolean(binding && (hostEntry || (arrayHostEntity && arrayHostRenderEntry)));
    const hostBindingConfig = bound && binding
      ? this.syncedEntities.get(binding.hostEntityId)?.components.modelAsset?.builtInSlotBindingConfig
        ?? arrayHostEntity?.components.modelAsset?.builtInSlotBindingConfig
        ?? hostEntry?.entitySnapshot?.components.modelAsset?.builtInSlotBindingConfig
        ?? arrayHostRenderEntry?.entitySnapshot?.components.modelAsset?.builtInSlotBindingConfig
      : undefined;
    const columnSign = hostBindingConfig?.columnDirection === '-x' ? -1 : 1;
    const layout = bound
      ? this.readBuiltInSlotLayout(hostEntry?.contentRoot.metadata ?? arrayHostRenderEntry?.contentRoot.metadata)
      : null;
    const bindingSteps = bound
      ? {
          columnStepX: columnSign * (layout?.columnSpacing ?? locator.length + locator.columnGap),
          layerStepY: layout?.layerStepY ?? locator.height + locator.layerGap,
        }
      : null;
    const signature = this.createLocatorSignature(locator, bindingSteps);

    let runtimeLocator = this.locators.get(entity.id);
    if (runtimeLocator && runtimeLocator.root.isDisposed()) {
      // 模型重载会递归销毁挂在模型根下的货格节点；条目仍在但节点已死，必须整体重建（重挂 parent 无法复活）。
      this.locators.delete(entity.id);
      runtimeLocator = undefined;
    }
    if (!runtimeLocator) {
      runtimeLocator = this.createLocator(entity.id, locator, bindingSteps);
      runtimeLocator.signature = signature;
      this.locators.set(entity.id, runtimeLocator);
    }

    if (bound && binding && (hostEntry || arrayHostEntity)) {
      const offset = binding.originOffset;
      const localPosition = layout
        ? {
            x: columnSign * layout.firstCellCenterX + offset.x,
            y: layout.firstLayerSurfaceY + offset.y,
            z: layout.depthCenterZ + offset.z,
          }
        // 布局 metadata 未就绪（脚本尚未运行），先落在货架局部原点，脚本就绪后由 refreshBuiltInSlotBindings 修正。
        : { x: offset.x, y: offset.y, z: offset.z };
      if (hostEntry) {
        runtimeLocator.root.parent = hostEntry.root;
        runtimeLocator.root.position.set(localPosition.x, localPosition.y, localPosition.z);
        runtimeLocator.root.rotationQuaternion = null;
        runtimeLocator.root.rotation.set(0, 0, 0);
        runtimeLocator.root.scaling.set(1, 1, 1);
      } else if (arrayHostEntity) {
        // 阵列副本在场景中没有宿主节点：把源布局点经副本实体 transform 转到世界空间。
        const hostTransform = arrayHostEntity.components.transform;
        const hostMatrix = Matrix.Compose(
          new Vector3(hostTransform.scale.x, hostTransform.scale.y, hostTransform.scale.z),
          Quaternion.RotationYawPitchRoll(hostTransform.rotation.y, hostTransform.rotation.x, hostTransform.rotation.z),
          new Vector3(hostTransform.position.x, hostTransform.position.y, hostTransform.position.z),
        );
        const worldPosition = Vector3.TransformCoordinates(
          new Vector3(localPosition.x, localPosition.y, localPosition.z),
          hostMatrix,
        );
        runtimeLocator.root.parent = null;
        runtimeLocator.root.position.copyFrom(worldPosition);
        runtimeLocator.root.rotationQuaternion = null;
        runtimeLocator.root.rotation.set(hostTransform.rotation.x, hostTransform.rotation.y, hostTransform.rotation.z);
        runtimeLocator.root.scaling.set(hostTransform.scale.x, hostTransform.scale.y, hostTransform.scale.z);
      }
      // 宿主可能被阵列批次挂起（根节点保持启用），货格显隐由绑定条件统一计算。
      runtimeLocator.root.setEnabled(this.computeBuiltInSlotRenderable(entity, highlightSet));
    } else {
      if (runtimeLocator.root.parent) runtimeLocator.root.parent = null;
      this.applyTransform(runtimeLocator.root, entity.components.transform);
    }
    runtimeLocator.assetId = locator.assetId;
    runtimeLocator.deviceAssetCode = locator.deviceAssetCode;
    runtimeLocator.rowNumber = locator.rowNumber;
    runtimeLocator.columns = locator.columns;
    runtimeLocator.layers = locator.layers;
    runtimeLocator.startColumn = locator.startColumn;
    runtimeLocator.startLayer = locator.startLayer;
    runtimeLocator.storageDepth = locator.storageDepth;
    runtimeLocator.cellSize = { length: locator.length, height: locator.height, width: locator.width };

    const locatorMetadata = { assetId: locator.assetId };
    runtimeLocator.root.metadata = { ...(runtimeLocator.root.metadata ?? {}), storageLocation: locatorMetadata };

    if (runtimeLocator.signature !== signature) {
      // Rebuild grid
      const cellSteps = {
        columnStepX: bindingSteps?.columnStepX ?? locator.length + locator.columnGap,
        layerStepY: bindingSteps?.layerStepY ?? locator.height + locator.layerGap,
      };
      runtimeLocator.fillMesh.dispose(false, false);
      runtimeLocator.edgeLines.dispose(false, false);
      const rebuilt = this.buildLocatorGridMeshes(entity.id, locator, runtimeLocator.root, runtimeLocator.material, cellSteps);
      runtimeLocator.fillMesh = rebuilt.fillMesh;
      runtimeLocator.edgeLines = rebuilt.edgeLines;
      runtimeLocator.cellSteps = cellSteps;
      runtimeLocator.signature = signature;
    }

    runtimeLocator.fillMesh.metadata = { ...(runtimeLocator.fillMesh.metadata ?? {}), storageLocation: locatorMetadata };
    this.applyLocatorStyle(runtimeLocator, selected);
    this.applyLocatorInteractivity(runtimeLocator, entity, highlightSet);

    if (locator.fetchDrive?.enabled) {
      if (!this.locatorFetchRuntimes.has(entity.id)) {
        this.locatorFetchRuntimes.set(entity.id, new LocatorFetchRuntime(this.scene, entity.id, (message) => this.pushLog(message)));
      }
    } else {
      this.disposeLocatorFetchRuntime(entity.id);
    }
  }

  /** 同步 CAD/DXF 网格参考层，线稿不可拾取，只作为建模布局底图。 */
  private syncCadReferenceEntity(entity: Entity): void {
    const cadReference = entity.components.cadReference;
    if (!cadReference) return;

    const existing = this.cadReferences.get(entity.id);
    if (
      existing &&
      (existing.sourceUrl !== cadReference.sourceUrl || existing.unitScaleToMeters !== cadReference.unitScaleToMeters)
    ) {
      this.disposeCadReference(entity.id, existing);
    }

    const current = this.cadReferences.get(entity.id);
    if (current) {
      this.applyTransform(current.root, entity.components.transform);
      this.applyCadReferenceStyle(current, cadReference);
      this.applyCadReferenceInteractivity(current, entity.id);
      return;
    }

    const root = new TransformNode(`${entity.id}_cadReferenceRoot`, this.scene);
    this.applyTransform(root, entity.components.transform);

    const loadToken = ++this.modelLoadSequence;
    const pending: CadReferenceRuntimeEntry = {
      sourceUrl: cadReference.sourceUrl,
      unitScaleToMeters: cadReference.unitScaleToMeters,
      root,
      lineMeshes: [],
      highlighted: false,
      loadToken,
      lineColor: cadReference.lineColor,
      opacity: cadReference.opacity,
      geometryReady: false,
      cancelLoad: null,
    };
    this.cadReferences.set(entity.id, pending);
    this.applyCadReferenceInteractivity(pending, entity.id);

    const cachedGeometry = consumeCadReferenceParseResult(cadReference.sourceUrl, cadReference.unitScaleToMeters);
    if (cachedGeometry) {
      void Promise.resolve().then(async () => {
        const activeEntry = this.cadReferences.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.sourceUrl !== cadReference.sourceUrl) {
          return;
        }

        try {
          await this.applyCadReferenceGeometry(entity.id, activeEntry, cachedGeometry);
        } catch (error) {
          console.warn('CAD 参考图加载失败', error);
          if (this.cadReferences.get(entity.id)?.loadToken === loadToken) {
            this.disposeCadReference(entity.id, activeEntry);
          }
        }
      });
      return;
    }

    const shouldUseLargeDxfWorker = cadReference.importMode === 'large-preview' || (
      cadReference.polylineCount >= CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET.maxPolylines * 0.5
      || cadReference.pointCount >= CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET.maxPoints * 0.5
    );
    let geometryPromise: Promise<CadReferenceParseResult>;
    if (shouldUseLargeDxfWorker) {
      const workerTask = createCadReferenceDxfWorkerTask(cadReference.sourceUrl, undefined, cadReference.unitScaleToMeters);
      pending.cancelLoad = workerTask.cancel;
      geometryPromise = workerTask.promise;
    } else {
      const abortController = new AbortController();
      pending.cancelLoad = () => abortController.abort();
      geometryPromise = fetch(resolveRuntimeAssetUrl(cadReference.sourceUrl), { signal: abortController.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const content = await response.text();
          return parseCadReferenceDxf(content, { unitScaleToMeters: cadReference.unitScaleToMeters });
        });
    }

    void geometryPromise
      .then(async (geometry) => {
        const activeEntry = this.cadReferences.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.sourceUrl !== cadReference.sourceUrl) {
          return;
        }

        activeEntry.cancelLoad = null;
        await this.applyCadReferenceGeometry(entity.id, activeEntry, geometry);
      })
      .catch((error) => {
        const activeEntry = this.cadReferences.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken) return;
        activeEntry.cancelLoad = null;
        console.warn('CAD 参考图加载失败。', error);
        if (activeEntry.loadToken === loadToken) {
          this.disposeCadReference(entity.id, activeEntry);
        }
      });
  }

  /** 记录独立矩阵实例实体；其几何由 sourceEntityId 对应源模型的批次统一提交。 */
  private syncModelArrayInstanceEntity(
    entity: Entity,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    this.modelArrayInstanceEntities.set(entity.id, entity);
    if (this.modelArrayGizmoProxy?.entityId === entity.id) {
      this.applyTransform(this.modelArrayGizmoProxy.node, entity.components.transform);
      this.modelArrayGizmoProxy.node.computeWorldMatrix(true);
    }
    // 绑定到副本的内置货格挂在场景根下、按副本位姿换算世界坐标；副本位移后需重算跟随。
    for (const slotEntity of this.syncedEntities.values()) {
      if (slotEntity.components.locator?.builtInBinding?.hostEntityId !== entity.id) continue;
      this.syncLocatorEntity(slotEntity, this.isEntityHighlighted(slotEntity.id), highlightSet);
    }
  }

  /** 同步 glTF/GLB 模型资源，并通过加载 token 避免异步过期结果污染当前场景。 */
  private syncModelEntity(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;

    const assetSignature = this.createModelAssetSignature(modelAsset);
    const existing = this.models.get(entity.id);
    if (existing && existing.assetSignature !== assetSignature) {
      this.disposeModel(entity.id, existing);
    }

    const current = this.models.get(entity.id);
    if (current) {
      current.entitySnapshot = entity;
      // 脚本宿主可能因上一帧矩阵批次而禁用；参数与脚本更新前先恢复节点计算。
      current.root.setEnabled(true);
      this.applyTransform(current.root, entity.components.transform);
      if (current.assetCode !== modelAsset.assetCode) {
        this.specializedTelemetryRuntime.disposeCargoForAssetCode(current.assetCode);
        resetStackerTelemetryState(current);
        resetConveyorTelemetryState(current);
        resetRgvTelemetryState(current);
      }
      current.assetCode = modelAsset.assetCode;
      current.telemetryBinding = entity.components.telemetryBinding ?? null;
      current.assetRevision = modelAsset.assetRevision ?? null;
      current.assetSignature = assetSignature;
      current.stackerCapable = isStackerModelAsset(modelAsset);
      current.conveyorCapable = isConveyorModelAsset(modelAsset);
      current.rgvCapable = isRgvModelAsset(modelAsset);
      current.stackerTelemetry.rootBasePosition = current.root.position.clone();
      current.rgvTelemetry.rootBasePosition = current.root.position.clone();
      // contentRoot 既承载源单位换算，也允许参数脚本在其上叠加尺寸缩放；同一资产同步时不得覆盖脚本输出。
      // lengthUnit / unitScaleToMeters 已进入 assetSignature，单位契约变化会走完整重载。
      this.applyModelParameters(entity, current);
      this.syncExternalModelScripts(entity, current);
      this.applyModelSelection(current, selected);
      this.applyModelInteractivity(current, entity.id, highlightSet);
      this.syncConveyorTrajectory(entity, current);
      return;
    }

    const root = new TransformNode(`${entity.id}_modelRoot`, this.scene);
    const contentRoot = new TransformNode(`${entity.id}_modelContentRoot`, this.scene);
    contentRoot.parent = root;
    this.applyTransform(root, entity.components.transform);
    this.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const loadToken = ++this.modelLoadSequence;
    const loadAbortController = new AbortController();
    const pending: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature,
      entitySnapshot: entity,
      assetCode: modelAsset.assetCode,
      telemetryBinding: entity.components.telemetryBinding ?? null,
      stackerCapable: isStackerModelAsset(modelAsset),
      conveyorCapable: isConveyorModelAsset(modelAsset),
      rgvCapable: isRgvModelAsset(modelAsset),
      root,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken,
      cancelLoad: () => loadAbortController.abort(),
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: createStackerTelemetryState(root),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
    };
    this.models.set(entity.id, pending);
    this.applyModelSelection(pending, selected);
    this.applyModelInteractivity(pending, entity.id);

    void this.loadModelRuntimeAssets(modelAsset, assetSignature, loadAbortController.signal)
      .then((loadedAssets) => {
        const activeEntry = this.models.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.assetSignature !== assetSignature) {
          loadedAssets.handle.dispose();
          return;
        }

        activeEntry.cancelLoad = null;
        activeEntry.assetHandle = loadedAssets.handle;
        if (loadedAssets.kind === 'owned-container') {
          activeEntry.meshes = loadedAssets.meshes;
          this.parentTopLevelModelNodes(activeEntry, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) {
            rootNode.parent = activeEntry.contentRoot;
          }
        }

        const latestEntity = activeEntry.entitySnapshot ?? entity;
        this.refreshModelEntityMeshes(latestEntity, activeEntry);
        this.normalizeModelContentOrigin(activeEntry);
        this.applyModelParameters(latestEntity, activeEntry);
        this.syncExternalModelScripts(latestEntity, activeEntry);
        this.applyModelSelection(activeEntry, activeEntry.highlighted);
        this.applyModelInteractivity(activeEntry, latestEntity.id);
        this.rebuildModelSelectionOutline();
        this.syncConveyorTrajectory(latestEntity, activeEntry);
        this.refreshGroupTransformPreviewTargets();
      })
      .catch((error) => {
        const activeEntry = this.models.get(entity.id);
        if (activeEntry?.loadToken === loadToken) {
          this.disposeModel(entity.id, activeEntry);
          const message = error instanceof Error ? error.message : String(error);
          this.pushLog(`模型加载失败：${message}`);
        }
      });
  }

  /** 按模型资产能力选择独占容器或安全共享实例加载路径。 */
  private async loadModelRuntimeAssets(
    modelAsset: ModelAssetComponent,
    assetSignature: string,
    loadSignal?: AbortSignal,
  ): Promise<LoadedModelRuntimeAssets> {
    const { rootUrl, fileName } = this.splitAssetUrl(
      this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision),
    );

    const loadSequence = this.beginModelLoadProgressUnit(fileName);
    try {
      const instancingPolicy = resolveModelAssetSharedInstancingPolicy(modelAsset);
      if (instancingPolicy.mode === 'shared-instance') {
        const sharedInstance = await this.sharedModelAssetCache.instantiate(
          assetSignature,
          () => this.loadAssetContainer(rootUrl, fileName, undefined, (event) => {
            this.updateModelLoadProgressUnit(loadSequence, event);
          }),
          (sourceName) => sourceName,
        );
        return {
          kind: 'shared-instance',
          handle: {
            kind: 'shared-instance',
            animationGroups: sharedInstance.entries.animationGroups,
            dispose: sharedInstance.dispose,
          },
          rootNodes: sharedInstance.entries.rootNodes,
        };
      }

      const container = await this.loadAssetContainer(rootUrl, fileName, loadSignal, (event) => {
        this.updateModelLoadProgressUnit(loadSequence, event);
      });
      try {
        container.addAllToScene();
        return {
          kind: 'owned-container',
          handle: {
            kind: 'owned-container',
            animationGroups: container.animationGroups,
            dispose: () => container.dispose(),
          },
          meshes: container.meshes,
          transformNodes: container.transformNodes,
        };
      } catch (error) {
        container.dispose();
        throw error;
      }
    } finally {
      this.settleModelLoadProgressUnit(loadSequence);
    }
  }

  /** 登记一个模型或环境加载进度单元（按文件名跟踪当前下载目标）。 */
  private beginModelLoadProgressUnit(fileName: string): number {
    const sequence = ++this.modelLoadProgressSequence;
    this.modelLoadProgressStartedCount += 1;
    this.activeModelLoadProgress.set(sequence, {
      fileName,
      loaded: 0,
      total: 0,
      reportedAt: -1,
    });
    this.notifyModelLoadProgressChanged();
    return sequence;
  }

  /** 把 SceneLoader 的字节进度合并进对应加载单元；容器内多文件时按当前文件进度折算。 */
  private updateModelLoadProgressUnit(sequence: number, event: ISceneLoaderProgressEvent): void {
    const active = this.activeModelLoadProgress.get(sequence);
    if (!active) return;
    active.loaded = event.loaded;
    active.total = event.total;
    active.reportedAt = ++this.modelLoadProgressReportSequence;
    this.notifyModelLoadProgressChanged();
  }

  /** 结算一个加载单元：移出在途表并累加已结算单元数。 */
  private settleModelLoadProgressUnit(sequence: number): void {
    if (this.activeModelLoadProgress.delete(sequence)) {
      this.modelLoadProgressSettledCount += 1;
    }
    this.notifyModelLoadProgressChanged();
  }

  /** 有订阅方时重新计算并推送模型加载进度快照。 */
  private notifyModelLoadProgressChanged(): void {
    if (!this.onModelLoadProgress) return;
    this.onModelLoadProgress(this.computeModelLoadProgress());
  }

  /** 按单元数汇总已结算与在途单元，生成 0-1 的总体进度；在途单元按当前文件字节折算。 */
  private computeModelLoadProgress(): SceneRuntimeModelLoadProgress {
    const totalCount = this.modelLoadProgressStartedCount;
    const settledCount = this.modelLoadProgressSettledCount;
    let weightedSettled = settledCount;
    let latestReportedAt = -1;
    let currentFile: string | null = null;
    let currentFilePercent: number | null = null;
    for (const progress of this.activeModelLoadProgress.values()) {
      const fraction = progress.total > 0
        ? Math.min(1, Math.max(0, progress.loaded / progress.total))
        : 0;
      weightedSettled += fraction;
      if (progress.reportedAt >= latestReportedAt) {
        latestReportedAt = progress.reportedAt;
        currentFile = progress.fileName;
        currentFilePercent = progress.total > 0 ? fraction : null;
      }
    }
    const percent = totalCount > 0
      ? Math.min(1, Math.max(0, weightedSettled / totalCount))
      : 1;
    return {
      loading: this.activeModelLoadProgress.size > 0 || settledCount < totalCount,
      percent,
      completedCount: settledCount,
      totalCount,
      currentFile,
      filePercent: currentFilePercent,
    };
  }

  /** 同步模型生成器配置标记；实体 Transform 只影响 markerRoot，不影响任何自动货物。 */
  private syncModelGeneratorEntity(entity: Entity, selected: boolean): void {
    const component = entity.components.modelGenerator;
    if (!component) return;

    let runtimeEntry = this.modelGenerators.get(entity.id);
    if (!runtimeEntry) {
      const markerRoot = new TransformNode(`${entity.id}_modelGeneratorMarkerRoot`, this.scene);
      const root = new TransformNode(`${entity.id}_modelGeneratorOutputRoot`, this.scene);
      runtimeEntry = {
        entityId: entity.id,
        entityName: entity.name,
        editorEntityId: null,
        runtimeAssetCode: createModelAssetCode('GEN', entity.id),
        root,
        markerRoot,
        marker: this.createModelGeneratorMarker(entity.id, markerRoot),
        component,
        selected,
        output: null,
        activeTargetSignature: null,
        loadToken: 0,
        failedTargetSignatures: new Set(),
        reportedLoadFailureKeys: new Set(),
        activeSnapshot: null,
        metadata: { modelGeneratorCargo: true, generatorEntityId: entity.id },
        runtimeConfigSignature: '',
      };
      this.modelGenerators.set(entity.id, runtimeEntry);
      this.generatedOutputOwners.set(runtimeEntry.entityId, runtimeEntry);
    }

    const runtimeConfigSignature = this.createModelGeneratorRuntimeConfigSignature(component);
    if (runtimeEntry.runtimeConfigSignature && runtimeEntry.runtimeConfigSignature !== runtimeConfigSignature) {
      this.specializedTelemetryRuntime.disposeCargoForGenerator(entity.id);
      this.disposeModelGeneratorOutput(runtimeEntry);
      runtimeEntry.activeTargetSignature = null;
      runtimeEntry.activeSnapshot = null;
    }
    runtimeEntry.entityName = entity.name;
    runtimeEntry.component = component;
    runtimeEntry.runtimeConfigSignature = runtimeConfigSignature;
    runtimeEntry.selected = selected;
    this.applyTransform(runtimeEntry.markerRoot, entity.components.transform);
    this.applyModelGeneratorPresentation(runtimeEntry);
  }

  /** 在编辑态与运行态切换时允许全部生成输出重新尝试失败目标。 */
  private clearModelGeneratorLoadFailureCache(): void {
    for (const owner of this.generatedOutputOwners.values()) {
      owner.failedTargetSignatures.clear();
    }
  }

  /** 在编辑态与预览态切换时批量刷新所有模型生成器配置标记。 */
  private syncAllModelGeneratorPresentations(): void {
    for (const runtimeEntry of this.modelGenerators.values()) {
      this.applyModelGeneratorPresentation(runtimeEntry);
    }
  }

  /** 对解析结果去重，同一目标签名不会重复销毁和加载。 */
  private syncModelGeneratorResolvedTarget(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    resolution: ResolvedModelGeneratorTarget,
  ): void {
    runtimeEntry.activeSnapshot = resolution.snapshot;
    const target = resolution.target;
    if (!target) {
      if (runtimeEntry.activeTargetSignature !== null || runtimeEntry.output) {
        runtimeEntry.loadToken += 1;
        this.disposeModelGeneratorOutput(runtimeEntry);
        runtimeEntry.activeTargetSignature = null;
      }
      return;
    }

    const targetSignature = createModelGeneratorTargetSignature(target);
    if (runtimeEntry.failedTargetSignatures.has(targetSignature)) {
      if (resolution.role === 'conditional') {
        this.syncModelGeneratorResolvedTarget(runtimeEntry, {
          target: runtimeEntry.component.defaultTarget,
          role: 'default',
          snapshot: resolution.snapshot,
        });
        return;
      }

      if (runtimeEntry.activeTargetSignature !== targetSignature || runtimeEntry.output) {
        runtimeEntry.loadToken += 1;
        this.disposeModelGeneratorOutput(runtimeEntry);
        runtimeEntry.activeTargetSignature = targetSignature;
      }
      runtimeEntry.onTerminalLoadFailure?.();
      return;
    }

    if (runtimeEntry.activeTargetSignature === targetSignature) {
      this.applyGeneratedOutputPresentation(runtimeEntry);
      return;
    }

    runtimeEntry.loadToken += 1;
    this.disposeModelGeneratorOutput(runtimeEntry);
    runtimeEntry.activeTargetSignature = targetSignature;

    if (target.kind === 'mesh') {
      runtimeEntry.output = this.createModelGeneratorMeshOutput(runtimeEntry, target);
      this.applyGeneratedOutputPresentation(runtimeEntry);
      return;
    }

    this.loadModelGeneratorModelOutput(runtimeEntry, target, targetSignature, resolution);
  }

  /** 异步加载生成器导入模型输出；过期 token 的容器会立即丢弃。 */
  private loadModelGeneratorModelOutput(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    target: Extract<ModelGeneratorTarget, { kind: 'model' }>,
    targetSignature: string,
    resolution: ResolvedModelGeneratorTarget,
  ): void {
    const modelAsset = createRuntimeModelAssetFromTarget(
      target,
      runtimeEntry.runtimeAssetCode,
    );
    if (!modelAsset) {
      this.handleModelGeneratorLoadFailure(runtimeEntry, targetSignature, resolution, new Error('目标模型快照无效'));
      return;
    }

    const modelRoot = new TransformNode(`${runtimeEntry.entityId}_generatedModelRoot`, this.scene);
    const contentRoot = new TransformNode(`${runtimeEntry.entityId}_generatedModelContentRoot`, this.scene);
    modelRoot.parent = runtimeEntry.root;
    contentRoot.parent = modelRoot;
    this.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const modelLoadToken = ++this.modelLoadSequence;
    const model: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature: this.createModelAssetSignature(modelAsset),
      entitySnapshot: null,
      assetCode: modelAsset.assetCode,
      telemetryBinding: null,
      stackerCapable: isStackerModelAsset(modelAsset),
      conveyorCapable: isConveyorModelAsset(modelAsset),
      rgvCapable: isRgvModelAsset(modelAsset),
      root: modelRoot,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken: modelLoadToken,
      cancelLoad: null,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: createStackerTelemetryState(modelRoot),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(modelRoot),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
    };
    runtimeEntry.output = { kind: 'model', model };
    const generatorLoadToken = runtimeEntry.loadToken;
    this.applyGeneratedOutputPresentation(runtimeEntry);

    void this.loadModelRuntimeAssets(modelAsset, model.assetSignature)
      .then((loadedAssets) => {
        const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
        const activeOutput = activeEntry?.output;
        if (
          !activeEntry
          || activeEntry.loadToken !== generatorLoadToken
          || activeEntry.activeTargetSignature !== targetSignature
          || activeOutput?.kind !== 'model'
          || activeOutput.model !== model
        ) {
          loadedAssets.handle.dispose();
          return;
        }

        model.assetHandle = loadedAssets.handle;
        if (loadedAssets.kind === 'owned-container') {
          model.meshes = loadedAssets.meshes;
          this.parentTopLevelModelNodes(model, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) {
            rootNode.parent = model.contentRoot;
          }
        }

        this.refreshModelGeneratorModelMeshes(activeEntry);
        this.normalizeModelContentOrigin(model);
        this.applyModelAssetParameters(modelAsset, model);
        this.syncModelGeneratorExternalScripts(activeEntry, modelAsset, model);
        this.applyGeneratedOutputPresentation(activeEntry);
      })
      .catch((error) => {
        const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
        const activeOutput = activeEntry?.output;
        if (
          !activeEntry
          || activeEntry.loadToken !== generatorLoadToken
          || activeEntry.activeTargetSignature !== targetSignature
          || activeOutput?.kind !== 'model'
          || activeOutput.model !== model
        ) return;

        this.disposeModelGeneratorOutput(activeEntry);
        this.handleModelGeneratorLoadFailure(activeEntry, targetSignature, resolution, error);
      });
  }

  /** 记录一次模型加载失败；规则覆盖模型失败时在同一有效信号下回退共享生成模板。 */
  private handleModelGeneratorLoadFailure(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    targetSignature: string,
    resolution: ResolvedModelGeneratorTarget,
    error: unknown,
  ): void {
    runtimeEntry.failedTargetSignatures.add(targetSignature);
    runtimeEntry.activeTargetSignature = targetSignature;
    const failureKey = `${resolution.role}:${targetSignature}`;
    if (!runtimeEntry.reportedLoadFailureKeys.has(failureKey)) {
      runtimeEntry.reportedLoadFailureKeys.add(failureKey);
      const message = error instanceof Error ? error.message : String(error);
      const targetLabel = resolution.role === 'conditional' ? '规则覆盖模型' : '共享生成模板';
      const fallbackLabel = resolution.role === 'conditional' ? '，已回退共享生成模板' : '';
      this.pushLog(`模型生成器“${runtimeEntry.entityName}”${targetLabel}加载失败${fallbackLabel}：${message}`);
    }

    if (resolution.role === 'conditional') {
      this.syncModelGeneratorResolvedTarget(runtimeEntry, {
        target: runtimeEntry.component.defaultTarget,
        role: 'default',
        snapshot: resolution.snapshot,
      });
      return;
    }

    runtimeEntry.onTerminalLoadFailure?.();
    this.applyGeneratedOutputPresentation(runtimeEntry);
  }

  /** 将当前 MQTT 快照作为只读运行上下文注入生成模型脚本。 */
  private updateModelGeneratorOutputRuntimeContext(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    if (runtimeEntry.output?.kind !== 'model') return;
    const telemetry = this.telemetryPreviewActive && runtimeEntry.activeSnapshot
      ? this.createExternalScriptTelemetrySnapshot(runtimeEntry.activeSnapshot)
      : null;
    this.updateModelExternalScriptRuntimeContext(
      runtimeEntry.output.model,
      this.telemetryPreviewActive ? 'runtime' : 'edit',
      telemetry,
    );
  }

  /** 同步灯光类型、位置/方向、强度及编辑器标记。 */
  private syncLightEntity(entity: Entity, selected: boolean): void {
    const lightComponent = entity.components.light;
    if (!lightComponent) return;

    let light = this.lights.get(entity.id);
    if (light && !this.isLightKind(light, lightComponent.lightKind)) {
      this.disposeLight(entity.id, light);
      light = undefined;
    }

    if (!light) {
      light = this.createLight(entity.id, lightComponent);
      this.lights.set(entity.id, light);
    }

    this.shadowRuntime.syncLight(entity.id, light);
    light.intensity = lightComponent.intensity;
    light.setEnabled(this.isEntityVisible(entity.id));
    this.lightMarkerRuntime.sync(
      entity,
      selected,
      this.isEntityVisible(entity.id),
      this.isEntityScenePickable(entity.id),
    );

    const transform = entity.components.transform;
    if (light instanceof HemisphericLight) {
      light.direction = this.vectorFromTransformPosition(transform, new Vector3(0, 1, 0));
      return;
    }

    if (light instanceof DirectionalLight) {
      light.position = this.vectorFromTransformPosition(transform, Vector3.Zero());
      light.direction = this.directionFromRotation(transform);
      return;
    }

    if (light instanceof PointLight) {
      light.position = this.vectorFromTransformPosition(transform, Vector3.Zero());
    }
  }

  /** 每帧把最新 MQTT 设备遥测分发到对应设备运行时。 */
  private applyDeviceTelemetryFrame(): void {
    if (!this.telemetryPreviewActive) return;
    this.specializedTelemetryRuntime.clearInactiveDiagnostics();
    this.captureReadyTelemetryPreviewBaselines();
    const deltaSeconds = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    this.specializedTelemetryRuntime.applyFrame(deltaSeconds);
  }

  /** 为已加载且 ready 的模型捕获本次预览基线，异步 GLB 后续 ready 时会在首个驱动帧前补捕获。 */
  private captureReadyTelemetryPreviewBaselines(): void {
    for (const model of this.models.values()) {
      if (model.telemetryPreviewBaseline || !model.assetHandle || !model.stackerTelemetryReady) continue;
      model.telemetryPreviewBaseline = captureModelTelemetryPreviewBaseline({ root: model.root, contentRoot: model.contentRoot });
      if (this.specializedTelemetryRuntime.resolveDeviceType(model) === 'stacker') {
        this.specializedTelemetryRuntime.primeStackerTargetReference(model);
      } else if (this.specializedTelemetryRuntime.resolveDeviceType(model) === 'conveyor') {
        this.specializedTelemetryRuntime.primeConveyorLinkCaches(model);
      }
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      const model = owner.output.model;
      if (model.telemetryPreviewBaseline || !model.assetHandle || !model.stackerTelemetryReady) continue;
      model.telemetryPreviewBaseline = captureModelTelemetryPreviewBaseline({ root: model.root, contentRoot: model.contentRoot });
    }
    // 遥测代理无几何无需捕获基线，但探测邻居/行程缓存需要同样的预热；就绪状态跟随宿主。
    for (const proxy of this.modelArrayTelemetryProxies.values()) {
      if (!proxy.assetHandle || !proxy.stackerTelemetryReady) continue;
      if (this.specializedTelemetryRuntime.resolveDeviceType(proxy) === 'conveyor') {
        this.specializedTelemetryRuntime.primeConveyorLinkCaches(proxy);
      }
    }
  }

  /** 清空 SceneRuntime 级别的预览诊断、metadata 和已上报状态，不影响模型注册或编译绑定。 */
  private clearTelemetryPreviewRuntimeState(): void {
    this.specializedTelemetryRuntime.clearReportedState();
    for (const model of this.models.values()) {
      this.specializedTelemetryRuntime.clearDiagnosticsForModel(model);
    }
    for (const variant of this.modelArrayParameterVariants.values()) {
      this.specializedTelemetryRuntime.clearDiagnosticsForModel(variant.model);
    }
    for (const proxy of this.modelArrayTelemetryProxies.values()) {
      this.specializedTelemetryRuntime.clearDiagnosticsForModel(proxy);
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind === 'model') {
        this.specializedTelemetryRuntime.clearDiagnosticsForModel(owner.output.model);
      }
    }
  }

  /** 批量同步外置脚本运行上下文，预览开始和结束时用于清空或恢复模式。 */
  private updateAllExternalScriptRuntimeContexts(
    mode: ExternalModelScriptRuntimeMode,
    telemetry: ExternalModelScriptTelemetrySnapshot | null,
  ): void {
    for (const model of this.models.values()) {
      this.updateModelExternalScriptRuntimeContext(model, mode, telemetry);
    }
    for (const variant of this.modelArrayParameterVariants.values()) {
      this.updateModelExternalScriptRuntimeContext(variant.model, mode, telemetry);
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      this.updateModelExternalScriptRuntimeContext(owner.output.model, mode, telemetry);
    }
  }

  /** 同步单个模型的外置脚本上下文，未启用脚本的模型会被安全跳过。 */
  private updateModelExternalScriptRuntimeContext(
    model: ModelRuntimeEntry,
    mode: ExternalModelScriptRuntimeMode,
    telemetry: ExternalModelScriptTelemetrySnapshot | null,
    deferArrayRefresh = false,
  ): boolean {
    const runtime = model.externalScriptRuntime;
    if (!runtime) return false;

    const preparedArrayHost = this.prepareModelArrayRuntimeMutation(model);
    runtime.updateRuntimeContext({ mode, telemetry });
    if (preparedArrayHost && !deferArrayRefresh) this.refreshModelArrayRuntimeRepresentation(model);
    return preparedArrayHost;
  }

  /** 从设备遥测快照提取外置脚本可消费的最小上下文，避免泄漏可变 store 对象。 */
  private createExternalScriptTelemetrySnapshot(snapshot: DeviceTelemetrySnapshot): ExternalModelScriptTelemetrySnapshot {
    return {
      deviceType: snapshot.deviceType,
      assetCode: snapshot.assetCode,
      faulted: snapshot.faulted,
      fields: { ...snapshot.fields },
    };
  }


  /** 根据货物类型读取旧版 Box 回退尺寸和材质，保证无模板场景行为不变。 */
  private getGeneratedCargoFallbackSpec(kind: GeneratedCargoKind): {
    size: Vector3;
    color: string;
    emissiveColor: string;
  } {
    if (kind === 'stacker') {
      return { size: STACKER_CARGO_SIZE, color: STACKER_CARGO_COLOR, emissiveColor: STACKER_CARGO_EMISSIVE_COLOR };
    }
    if (kind === 'rgv') {
      return { size: RGV_CARGO_SIZE, color: RGV_CARGO_COLOR, emissiveColor: RGV_CARGO_EMISSIVE_COLOR };
    }
    return { size: CONVEYOR_CARGO_SIZE, color: CONVEYOR_CARGO_COLOR, emissiveColor: CONVEYOR_CARGO_EMISSIVE_COLOR };
  }

  /** 为普通自动货物创建旧版 Box 回退；root 表示底部支撑点，Mesh 局部上移半高。 */
  private ensureGeneratedCargoFallback(cargo: GeneratedCargoRuntimeEntry, kind: GeneratedCargoKind): void {
    if (cargo.fallback) return;
    const spec = this.getGeneratedCargoFallbackSpec(kind);
    const mesh = MeshBuilder.CreateBox(
      `${kind}_cargo_${sanitizeBabylonName(cargo.assetCode)}_${sanitizeBabylonName(cargo.containerCode)}`,
      { width: spec.size.x, height: spec.size.y, depth: spec.size.z },
      this.scene,
    );
    const material = new StandardMaterial(`${mesh.name}_mat`, this.scene);
    material.diffuseColor = Color3.FromHexString(spec.color);
    material.emissiveColor = Color3.FromHexString(spec.emissiveColor);
    mesh.parent = cargo.root;
    mesh.position.y = spec.size.y / 2;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      generatedCargo: true,
      cargoKind: kind,
      sourceAssetCode: cargo.assetCode,
      containerCode: cargo.containerCode,
      fallback: true,
    };
    cargo.fallback = { mesh, material };
  }

  /** 释放普通货物的旧版 Box 回退，不影响已加载生成模板。 */
  private disposeGeneratedCargoFallback(cargo: GeneratedCargoRuntimeEntry): void {
    if (!cargo.fallback) return;
    cargo.fallback.material.dispose();
    cargo.fallback.mesh.dispose();
    cargo.fallback = null;
  }

  /** 为普通货物按需创建共享生成输出宿主，并登记异步加载查找表。 */
  private ensureGeneratedCargoOutputOwner(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    component: ModelGeneratorComponent,
    snapshot: DeviceTelemetrySnapshot,
  ): GeneratedOutputOwnerRuntimeEntry {
    if (cargo.outputOwner) {
      cargo.outputOwner.component = component;
      cargo.outputOwner.activeSnapshot = snapshot;
      return cargo.outputOwner;
    }

    const runtimeId = createId(`runtime_${kind}_cargo`);
    const owner: GeneratedOutputOwnerRuntimeEntry = {
      entityId: runtimeId,
      entityName: `${kind === 'stacker' ? '堆垛机' : '输送机'} ${cargo.assetCode} 货物 ${cargo.containerCode}`,
      editorEntityId: null,
      // 匿名货物（无 containerCode）回退设备编号：生成器模型目标要求 runtimeAssetCode 非空，否则判定快照无效回退内置 Box
      runtimeAssetCode: cargo.containerCode || cargo.assetCode,
      root: cargo.root,
      component,
      output: null,
      activeTargetSignature: null,
      loadToken: 0,
      failedTargetSignatures: new Set(),
      reportedLoadFailureKeys: new Set(),
      activeSnapshot: snapshot,
      metadata: {
        generatedCargo: true,
        cargoKind: kind,
        sourceAssetCode: cargo.assetCode,
        containerCode: cargo.containerCode,
      },
      onTerminalLoadFailure: () => {
        if (cargo.outputOwner === owner) this.ensureGeneratedCargoFallback(cargo, kind);
      },
    };
    cargo.outputOwner = owner;
    this.generatedOutputOwners.set(owner.entityId, owner);
    return owner;
  }

  /** 根据设备绑定的生成器规则同步普通货物外观；无可用模板时回退旧版 Box。 */
  private syncGeneratedCargoVisual(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    snapshot: DeviceTelemetrySnapshot,
    generator: ModelGeneratorRuntimeEntry | null,
  ): void {
    cargo.generatorEntityId = generator?.entityId ?? null;
    const component = generator?.component ?? null;
    const resolution = component ? resolveModelGeneratorTargetFromSnapshot(component, snapshot) : null;
    if (!component || !resolution) {
      this.disposeGeneratedCargoOutputOwner(cargo);
      this.ensureGeneratedCargoFallback(cargo, kind);
      return;
    }

    const owner = this.ensureGeneratedCargoOutputOwner(cargo, kind, component, snapshot);
    owner.component = component;
    owner.activeSnapshot = snapshot;
    const targetSignature = createModelGeneratorTargetSignature(resolution.target);
    if (!owner.failedTargetSignatures.has(targetSignature)) {
      this.disposeGeneratedCargoFallback(cargo);
    }
    this.syncModelGeneratorResolvedTarget(owner, resolution);
    if (owner.output) this.disposeGeneratedCargoFallback(cargo);
  }

  /** 注销普通货物生成输出宿主并释放当前输出，但保留货物支撑点根节点。 */
  private disposeGeneratedCargoOutputOwner(cargo: GeneratedCargoRuntimeEntry): void {
    const owner = cargo.outputOwner;
    if (!owner) return;
    owner.loadToken += 1;
    this.disposeModelGeneratorOutput(owner);
    owner.failedTargetSignatures.clear();
    owner.reportedLoadFailureKeys.clear();
    this.generatedOutputOwners.delete(owner.entityId);
    cargo.outputOwner = null;
  }

  /** 释放普通自动货物的模板、Box 回退和支撑点根节点。 */
  private disposeGeneratedCargo(cargo: GeneratedCargoRuntimeEntry): void {
    this.disposeGeneratedCargoFallback(cargo);
    this.disposeGeneratedCargoOutputOwner(cargo);
    cargo.root.dispose();
  }

  /** 设置普通自动货物世界支撑点、朝向和缩放（箱位含镜像时缩放保留负号）；root 无父级，不受 POI Transform 影响。 */
  private setGeneratedCargoRootPose(cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion, scaling?: Vector3 | null): void {
    cargo.root.position.copyFrom(position);
    cargo.root.rotationQuaternion = rotation.clone();
    cargo.root.scaling.copyFrom(scaling ?? Vector3.OneReadOnly);
    cargo.root.computeWorldMatrix(true);
    cargo.outputOwner && this.applyGeneratedOutputPresentation(cargo.outputOwner);
  }


  /** 创建编辑态空生成器的青色线框标记；标记只属于 Babylon 运行时。 */
  private createModelGeneratorMarker(entityId: string, root: TransformNode): ModelGeneratorMarkerRuntimeEntry {
    const mesh = MeshBuilder.CreateBox(`${entityId}_modelGeneratorMarker`, { size: 0.8 }, this.scene);
    const material = new StandardMaterial(`${entityId}_modelGeneratorMarkerMaterial`, this.scene);
    material.disableLighting = true;
    material.wireframe = true;
    material.alpha = MODEL_GENERATOR_MARKER_ALPHA;
    material.diffuseColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);
    material.emissiveColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);

    mesh.parent = root;
    mesh.position.y = 0.4;
    mesh.material = material;
    mesh.metadata = { ...(mesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };
    return { mesh, material };
  }

  /** 创建内置基础网格生成输出，并挂到生成器稳定根节点下。 */
  private createModelGeneratorMeshOutput(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    target: Extract<ModelGeneratorTarget, { kind: 'mesh' }>,
  ): ModelGeneratorMeshOutputRuntimeEntry {
    const mesh = this.createModelGeneratorMesh(runtimeEntry.entityId, target.meshKind);
    const material = new StandardMaterial(
      `${runtimeEntry.entityId}_generated_${target.meshKind}_material`,
      this.scene,
    );
    mesh.parent = runtimeEntry.root;
    mesh.position.y = getBuiltInMeshGroundOffsetMeters(target.meshKind);
    mesh.material = material;
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      editorMeshKind: target.meshKind,
      ...runtimeEntry.metadata,
      ...(runtimeEntry.editorEntityId ? { [EDITOR_ENTITY_ID_METADATA_KEY]: runtimeEntry.editorEntityId } : {}),
    };
    mesh.isPickable = runtimeEntry.editorEntityId !== null;

    return {
      kind: 'mesh',
      target,
      mesh,
      material,
    };
  }

  /** 按内置类型创建生成器输出 Mesh，几何语义与模型库基础网格保持一致。 */
  private createModelGeneratorMesh(entityId: string, meshKind: MeshKind): Mesh {
    if (meshKind === 'sphere') {
      return MeshBuilder.CreateSphere(`${entityId}_generatedSphere`, { diameter: BUILT_IN_SPHERE_DIAMETER_METERS }, this.scene);
    }
    if (meshKind === 'plane') {
      return MeshBuilder.CreateGround(
        `${entityId}_generatedPlane`,
        { width: BUILT_IN_PLANE_SIZE_METERS, height: BUILT_IN_PLANE_SIZE_METERS },
        this.scene,
      );
    }
    return MeshBuilder.CreateBox(
      `${entityId}_generatedCube`,
      { size: BUILT_IN_BOX_SIZE_METERS },
      this.scene,
    );
  }

  /** 按集中米制基准创建内置 Mesh，避免普通实体与模型生成器出现尺寸差异。 */
  private createMesh(entity: Entity): Mesh {
    const meshKind = entity.components.meshRenderer?.meshKind ?? 'cube';

    if (meshKind === 'sphere') {
      const mesh = MeshBuilder.CreateSphere(entity.id, { diameter: BUILT_IN_SPHERE_DIAMETER_METERS }, this.scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    if (meshKind === 'plane') {
      const mesh = MeshBuilder.CreateGround(
        entity.id,
        { width: BUILT_IN_PLANE_SIZE_METERS, height: BUILT_IN_PLANE_SIZE_METERS },
        this.scene,
      );
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    const mesh = MeshBuilder.CreateBox(entity.id, { size: BUILT_IN_BOX_SIZE_METERS }, this.scene);
    mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
    return mesh;
  }

  /** 创建虚拟定位线框：根节点交给 Gizmo；填充面与边线各一个网格，整货架只产生两次 draw call。 */
  private createLocator(entityId: string, locator: LocatorComponent, bindingSteps?: LocatorBindingSteps | null): LocatorRuntimeEntry {
    const root = new TransformNode(`${entityId}_locatorRoot`, this.scene);
    const material = new StandardMaterial(`${entityId}_locatorMat`, this.scene);

    material.disableLighting = true;
    material.alpha = LOCATOR_SURFACE_ALPHA;
    material.diffuseColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);
    material.emissiveColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);

    const cellSteps: LocatorBindingSteps = {
      columnStepX: bindingSteps?.columnStepX ?? locator.length + locator.columnGap,
      layerStepY: bindingSteps?.layerStepY ?? locator.height + locator.layerGap,
    };
    const { fillMesh, edgeLines } = this.buildLocatorGridMeshes(entityId, locator, root, material, cellSteps);

    return { entityId, root, fillMesh, edgeLines, cellSteps, cellSize: { length: locator.length, height: locator.height, width: locator.width }, material, assetId: '', signature: '', columns: locator.columns, layers: locator.layers, startColumn: locator.startColumn, startLayer: locator.startLayer, deviceAssetCode: locator.deviceAssetCode, rowNumber: locator.rowNumber, storageDepth: locator.storageDepth };
  }

  /**
   * 生成货格的填充网格与合并边线网格。
   * 格子中心公式（列 × 列步距, 高/2 + 层 × 层步距, 0）是渲染与支撑位解析的共同来源，改动必须两边同步。
   * 连续网格（步距等于格子尺寸）时合并为单个覆盖盒 + 通长网格线，软渲染下避免上万实例的顶点处理。
   */
  private buildLocatorGridMeshes(
    entityId: string,
    locator: LocatorComponent,
    root: TransformNode,
    material: StandardMaterial,
    cellSteps: LocatorBindingSteps,
  ): { fillMesh: Mesh; edgeLines: LinesMesh } {
    const { length, height, width, columns, layers } = locator;
    const cellCount = Math.max(1, columns * layers);
    const contiguous =
      Math.abs(cellSteps.columnStepX - length) < LOCATOR_CONTIGUOUS_EPSILON &&
      Math.abs(cellSteps.layerStepY - height) < LOCATOR_CONTIGUOUS_EPSILON;

    const halfLength = length / 2;
    const halfHeight = height / 2;
    const halfWidth = width / 2;
    const edgeLines: Vector3[][] = [];

    let fillMesh: Mesh;
    if (contiguous) {
      const spanX = (columns - 1) * cellSteps.columnStepX + length;
      const spanY = (layers - 1) * cellSteps.layerStepY + height;
      fillMesh = MeshBuilder.CreateBox(`${entityId}_locatorFill`, { width: spanX, height: spanY, depth: width }, this.scene);
      fillMesh.position.set((columns - 1) * cellSteps.columnStepX / 2, spanY / 2, 0);

      const minX = -halfLength;
      const maxX = minX + spanX;
      const maxY = spanY;
      for (const z of [-halfWidth, halfWidth]) {
        for (let i = 0; i <= columns; i += 1) {
          const x = minX + i * cellSteps.columnStepX;
          edgeLines.push([new Vector3(x, 0, z), new Vector3(x, maxY, z)]);
        }
        for (let j = 0; j <= layers; j += 1) {
          const y = j * cellSteps.layerStepY;
          edgeLines.push([new Vector3(minX, y, z), new Vector3(maxX, y, z)]);
        }
      }
      for (let i = 0; i <= columns; i += 1) {
        for (let j = 0; j <= layers; j += 1) {
          const x = minX + i * cellSteps.columnStepX;
          const y = j * cellSteps.layerStepY;
          edgeLines.push([new Vector3(x, y, -halfWidth), new Vector3(x, y, halfWidth)]);
        }
      }
    } else {
      fillMesh = MeshBuilder.CreateBox(`${entityId}_locatorFill`, { width: length, height, depth: width }, this.scene);
      const matrices = new Float32Array(cellCount * 16);
      for (let layer = 0; layer < layers; layer += 1) {
        for (let col = 0; col < columns; col += 1) {
          const cellIndex = layer * columns + col;
          const centerX = col * cellSteps.columnStepX;
          const centerY = height / 2 + layer * cellSteps.layerStepY;
          Matrix.Translation(centerX, centerY, 0).copyToArray(matrices, cellIndex * 16);

          const minX = centerX - halfLength;
          const maxX = centerX + halfLength;
          const minY = centerY - halfHeight;
          const maxY = centerY + halfHeight;
          const minZ = -halfWidth;
          const maxZ = halfWidth;
          edgeLines.push(
            [new Vector3(minX, minY, minZ), new Vector3(maxX, minY, minZ)],
            [new Vector3(maxX, minY, minZ), new Vector3(maxX, minY, maxZ)],
            [new Vector3(maxX, minY, maxZ), new Vector3(minX, minY, maxZ)],
            [new Vector3(minX, minY, maxZ), new Vector3(minX, minY, minZ)],
            [new Vector3(minX, maxY, minZ), new Vector3(maxX, maxY, minZ)],
            [new Vector3(maxX, maxY, minZ), new Vector3(maxX, maxY, maxZ)],
            [new Vector3(maxX, maxY, maxZ), new Vector3(minX, maxY, maxZ)],
            [new Vector3(minX, maxY, maxZ), new Vector3(minX, maxY, minZ)],
            [new Vector3(minX, minY, minZ), new Vector3(minX, maxY, minZ)],
            [new Vector3(maxX, minY, minZ), new Vector3(maxX, maxY, minZ)],
            [new Vector3(maxX, minY, maxZ), new Vector3(maxX, maxY, maxZ)],
            [new Vector3(minX, minY, maxZ), new Vector3(minX, maxY, maxZ)],
          );
        }
      }
      fillMesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
      fillMesh.thinInstanceRefreshBoundingInfo(true);
    }
    fillMesh.parent = root;
    fillMesh.material = material;
    fillMesh.metadata = { [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };

    const edgeLinesMesh = MeshBuilder.CreateLineSystem(`${entityId}_locatorEdges`, { lines: edgeLines }, this.scene);
    edgeLinesMesh.parent = root;
    edgeLinesMesh.color = Color3.FromHexString(LOCATOR_EDGE_COLOR);
    edgeLinesMesh.alpha = 1;
    edgeLinesMesh.isPickable = false;
    return { fillMesh, edgeLines: edgeLinesMesh };
  }

  /** 读取货架脚本写入 contentRoot metadata 的内置货格实测布局；字段缺失或非有限数字时视为未就绪。 */
  private readBuiltInSlotLayout(metadata: unknown): BuiltInSlotLayoutInfo | null {
    if (!isPlainRecord(metadata)) return null;
    const layout = metadata.builtInSlotLayout;
    if (!isPlainRecord(layout)) return null;
    const read = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const firstCellCenterX = read(layout.firstCellCenterX);
    const firstLayerSurfaceY = read(layout.firstLayerSurfaceY);
    const columnSpacing = read(layout.columnSpacing);
    const layerStepY = read(layout.layerStepY);
    const depthCenterZ = read(layout.depthCenterZ);
    if (firstCellCenterX === null || firstLayerSurfaceY === null || columnSpacing === null || layerStepY === null || depthCenterZ === null) {
      return null;
    }
    return { firstCellCenterX, firstLayerSurfaceY, columnSpacing, layerStepY, depthCenterZ };
  }

  private createLocatorSignature(locator: LocatorComponent, bindingSteps?: LocatorBindingSteps | null): string {
    return [
      locator.length.toFixed(3),
      locator.height.toFixed(3),
      locator.width.toFixed(3),
      String(locator.columns),
      String(locator.layers),
      locator.columnGap.toFixed(3),
      locator.layerGap.toFixed(3),
      bindingSteps ? `${bindingSteps.columnStepX.toFixed(3)}|${bindingSteps.layerStepY.toFixed(3)}` : 'free',
    ].join('|');
  }

  /** 根据组件类型创建对应 Babylon Light。 */
  private createLight(entityId: string, light: LightComponent): Light {
    if (light.lightKind === 'directional') {
      return new DirectionalLight(entityId, new Vector3(0, -1, 0), this.scene);
    }

    if (light.lightKind === 'point') {
      return new PointLight(entityId, Vector3.Zero(), this.scene);
    }

    return new HemisphericLight(entityId, new Vector3(0, 1, 0), this.scene);
  }

  /** 按实体运行时类型解析阵列测量和预览所需的稳定根节点与真实几何。 */
  private resolveEntityArrayPreviewSource(entityId: string): EntityArrayPreviewSource | null {
    const primitiveMesh = this.meshes.get(entityId);
    if (primitiveMesh) {
      return {
        kind: 'mesh',
        root: primitiveMesh,
        geometryMeshes: [primitiveMesh],
        previewMeshes: [primitiveMesh],
        geometryReady: !primitiveMesh.isDisposed(),
        strategy: 'clone-hierarchy',
      };
    }

    const locator = this.locators.get(entityId);
    if (locator) {
      const renderMeshes: AbstractMesh[] = [locator.fillMesh, locator.edgeLines];
      return {
        kind: 'locator',
        root: locator.root,
        geometryMeshes: renderMeshes,
        previewMeshes: renderMeshes,
        geometryReady: true,
        strategy: 'clone-hierarchy',
      };
    }

    const cadReference = this.cadReferences.get(entityId);
    if (cadReference) {
      return {
        kind: 'cad-reference',
        root: cadReference.root,
        geometryMeshes: cadReference.lineMeshes,
        previewMeshes: cadReference.lineMeshes,
        geometryReady: cadReference.geometryReady && cadReference.lineMeshes.length > 0,
        strategy: 'clone-hierarchy',
      };
    }

    const modelArrayInstance = this.modelArrayInstanceEntities.get(entityId);
    const modelArraySource = modelArrayInstance ? this.resolveModelArrayRenderModel(modelArrayInstance) : null;
    if (modelArrayInstance && modelArraySource) {
      const meshes = modelArraySource.contentRoot.getChildMeshes(false);
      return {
        kind: 'model',
        root: this.getOrCreateModelArrayGizmoProxy(modelArrayInstance),
        geometryMeshes: meshes,
        previewMeshes: meshes,
        geometryReady: Boolean(modelArraySource.assetHandle && modelArraySource.measurementReady),
        strategy: 'matrix-instances',
        modelArraySourceRoot: modelArraySource.root,
        modelArrayBaseTransform: modelArrayInstance.components.transform,
      };
    }

    const model = this.models.get(entityId);
    if (model) {
      const meshes = model.contentRoot.getChildMeshes(false);
      return {
        kind: 'model',
        root: model.root,
        geometryMeshes: meshes,
        previewMeshes: meshes,
        geometryReady: Boolean(model.assetHandle && model.measurementReady),
        strategy: 'matrix-instances',
      };
    }

    const poi = this.poiEffectRuntime.getEntityArraySource(entityId);
    if (poi) {
      return {
        kind: 'poi',
        root: poi.root,
        geometryMeshes: poi.geometryMeshes,
        previewMeshes: poi.previewMeshes,
        geometryReady: poi.geometryMeshes.length > 0,
        strategy: 'poi-static',
      };
    }

    return null;
  }

  /** 创建单个临时阵列副本；POI 只复制静态视觉 Mesh 或粒子范围代理。 */
  private createEntityArrayPreviewClone(
    source: EntityArrayPreviewSource,
    preview: EntityArrayPreviewEntry,
    entityId: string,
    cloneIndex: number,
  ): TransformNode | null {
    const cloneName = `__entityArrayPreview_${entityId}_${cloneIndex}`;
    if (source.strategy !== 'poi-static') {
      const clone = source.root.clone(cloneName, null, false);
      if (!clone) return null;
      this.prepareEntityArrayPreviewClone(clone);
      this.copyThinInstanceBuffersForPreviewClone(source.root, clone);
      return clone;
    }

    const cloneRoot = source.root.clone(cloneName, null, true);
    if (!cloneRoot) return null;

    for (let meshIndex = 0; meshIndex < source.previewMeshes.length; meshIndex += 1) {
      const sourceMesh = source.previewMeshes[meshIndex];
      const cloneMesh = sourceMesh.clone(`${cloneName}_mesh_${meshIndex}`, cloneRoot, true);
      if (!cloneMesh) {
        cloneRoot.dispose(false, false);
        return null;
      }

      const metadata = sourceMesh.metadata as Record<string, unknown> | null | undefined;
      if (metadata?.effectBoundsProxy === true) {
        cloneMesh.isVisible = true;
        cloneMesh.visibility = 1;
        cloneMesh.material = this.getOrCreatePoiArrayBoundsMaterial(preview);
      }
    }

    this.prepareEntityArrayPreviewClone(cloneRoot);
    return cloneRoot;
  }

  /** 复用一个轻量半透明材质显示纯粒子 POI 的效果范围代理。 */
  private getOrCreatePoiArrayBoundsMaterial(preview: EntityArrayPreviewEntry): StandardMaterial {
    if (preview.poiBoundsMaterial) return preview.poiBoundsMaterial;

    const material = new StandardMaterial('__entityArrayPoiBoundsMaterial', this.scene);
    const color = Color3.FromHexString('#55C8FF');
    material.disableLighting = true;
    material.alpha = 0.18;
    material.diffuseColor = color;
    material.emissiveColor = color;
    material.backFaceCulling = false;
    preview.poiBoundsMaterial = material;
    return material;
  }

  /** 当前源实体被删除、重建或锁定时立即释放其临时阵列预览。 */
  private clearEntityArrayPreviewIfSource(entityId: string): void {
    if (this.entityArrayPreview?.sourceEntityId === entityId) this.clearEntityArrayPreview();
  }

  /** 清理临时阵列克隆的交互状态，并恢复共享矩阵实例的公开缓冲容器。 */
  private prepareEntityArrayPreviewClone(root: TransformNode): void {
    const nodes: Node[] = [root, ...root.getDescendants(false)];
    const previewMeshes: AbstractMesh[] = [];
    for (const node of nodes) {
      node.metadata = null;
      if (node instanceof AbstractMesh) {
        previewMeshes.push(node);
        node.isPickable = false;
        node.actionManager = null;
      }
    }

    // 递归 clone 不会继承 InstancedMesh.instancedBuffers；源 Mesh 已注册选择缓冲时必须在首帧前补齐。
    repairInstancedMeshBufferContainers(previewMeshes);
  }

  /**
   * 递归 clone 同样不携带 thinInstance 矩阵缓冲；从源拷贝，预览副本才能呈现全部实例。
   * 子克隆按 `克隆根名.源相对路径` 命名（见 TransformNode/Mesh._copySource），按相对路径回溯源 Mesh。
   */
  private copyThinInstanceBuffersForPreviewClone(sourceRoot: TransformNode, cloneRoot: TransformNode): void {
    const clonePrefix = `${cloneRoot.name}.`;
    const cloneMeshesByPath = new Map<string, AbstractMesh>();
    for (const node of cloneRoot.getDescendants(false)) {
      if (node instanceof AbstractMesh && node.name.startsWith(clonePrefix)) {
        cloneMeshesByPath.set(node.name.slice(clonePrefix.length), node);
      }
    }
    if (cloneMeshesByPath.size === 0) return;

    const relativePathOf = (node: Node): string => {
      const parts: string[] = [];
      let current: Node | null = node;
      while (current && current !== sourceRoot) {
        parts.unshift(current.name);
        current = current.parent;
      }
      return parts.join('.');
    };
    for (const node of sourceRoot.getDescendants(false)) {
      if (!(node instanceof Mesh) || node.thinInstanceCount === 0) continue;
      const matrixData = node._thinInstanceDataStorage?.matrixData;
      const cloneMesh = cloneMeshesByPath.get(relativePathOf(node));
      if (!matrixData || !(cloneMesh instanceof Mesh)) continue;
      cloneMesh.thinInstanceSetBuffer('matrix', new Float32Array(matrixData), 16, true);
      cloneMesh.thinInstanceRefreshBoundingInfo(true);
    }
  }

  /** 释放实体对应的 Mesh 与材质资源。 */
  private disposeMesh(entityId: string, mesh: Mesh): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    mesh.material?.dispose();
    mesh.dispose();
    this.meshes.delete(entityId);
  }

  /** 释放虚拟定位线框的根节点、填充/边线网格和材质。 */
  private disposeLocator(entityId: string, locator: LocatorRuntimeEntry): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    this.disposeLocatorFetchRuntime(entityId);
    locator.fillMesh.dispose(false, false);
    locator.edgeLines.dispose(false, false);
    locator.material.dispose();
    locator.root.dispose(false, true);
    this.locators.delete(entityId);
  }

  /** 释放 CAD 参考图的所有线稿 Mesh 与根节点。 */
  private disposeCadReference(entityId: string, cadReference: CadReferenceRuntimeEntry): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    cadReference.cancelLoad?.();
    cadReference.cancelLoad = null;
    for (const lineMesh of cadReference.lineMeshes) {
      lineMesh.dispose();
    }
    cadReference.root.dispose();
    this.cadReferences.delete(entityId);
  }

  // ===== 输送线轨迹可视化 =====

  /** 同步输送线轨迹：conveyor 且模型就绪时创建（trajectoryDirection 缺省按 'x'），反之释放。 */
  private syncConveyorTrajectory(entity: Entity, model: ModelRuntimeEntry | null): void {
    const binding = entity.components.telemetryBinding;
    const enabled = Boolean(
      binding
      && binding.deviceType === 'conveyor'
      && model?.assetHandle
      && model.measurementReady,
    );
    if (!enabled || !model) {
      const existing = this.conveyorTrajectories.get(entity.id);
      if (existing) this.disposeConveyorTrajectory(entity.id, existing);
      return;
    }

    const context = this.resolveConveyorTrajectoryContext(entity, model);
    const signature = this.createConveyorTrajectorySignature(entity, context);
    const existing = this.conveyorTrajectories.get(entity.id);
    if (existing && existing.signature === signature) {
      // 轨迹挂独立根节点（阵列源模型 root 会被合批挂起禁用），实体移动/显隐变化只刷新根节点。
      this.refreshConveyorTrajectoryRoot(entity, existing.root);
      return;
    }
    if (existing) this.disposeConveyorTrajectory(entity.id, existing);
    this.createConveyorTrajectory(entity, context, signature);
  }

  /** 轨迹根的变换与显隐：跟随实体 Transform、实体可见性与全局开关。 */
  private refreshConveyorTrajectoryRoot(entity: Entity, root: TransformNode): void {
    this.applyTransform(root, entity.components.transform);
    root.setEnabled(this._trajectoryVisible && this.isEntityVisible(entity.id));
  }

  /** 同步某源模型全部阵列实例的输送线轨迹：几何取自实例所在批次（参数变体或源模型）。 */
  private syncConveyorTrajectoriesForArrayInstances(sourceEntityId: string): void {
    for (const instanceEntity of this.modelArrayInstanceEntities.values()) {
      const instance = instanceEntity.components.modelArrayInstance;
      if (!instance || instance.sourceEntityId !== sourceEntityId) continue;
      const variant = this.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      const model = variant?.model ?? this.models.get(instance.sourceEntityId) ?? null;
      this.syncConveyorTrajectory(instanceEntity, model);
    }
  }

  private createConveyorTrajectorySignature(entity: Entity, context: ConveyorTrajectoryContext): string {
    const round = (v: Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    return JSON.stringify([
      entity.components.telemetryBinding?.trajectoryDirection ?? 'x',
      context.travelAxisName,
      round(context.centerLocal),
      context.spanMeters.toFixed(4),
      context.surfaceYLocal.toFixed(4),
    ]);
  }

  /** 与 conveyorDriver 同源的行程计算：cargo.travel 配置行走轴 + 包围盒投影，转模型局部空间。 */
  private resolveConveyorTrajectoryContext(entity: Entity, model: ModelRuntimeEntry): ConveyorTrajectoryContext {
    const travelConfig = readConveyorCargoTravelConfig(model);
    const travelAxisName = travelConfig.axis;
    const configuredNodes = this.findEditorConveyorMotionNodes(model, travelConfig);
    const conveyorNodes = configuredNodes.length > 0
      ? configuredNodes
      : findModelNodes(model, this.scene, /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i);
    const bounds = (conveyorNodes.length > 0 ? getNodesWorldBounds(conveyorNodes) : null)
      ?? this.getModelWorldBounds(model);
    if (!bounds) {
      return { centerLocal: Vector3.Zero(), travelAxisName, travelAxisWorld: Vector3.Right(), spanMeters: 0, surfaceYLocal: 0 };
    }
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const travelAxisWorld = getHorizontalModelAxis(model.root, travelAxisName);
    const projected = projectWorldBoundsOntoAxis(bounds, travelAxisWorld);
    const spanMeters = Math.max(0, projected.max - projected.min);

    model.root.computeWorldMatrix(true);
    const rootWorldInverse = model.root.getWorldMatrix().clone();
    rootWorldInverse.invert();
    const centerLocal = Vector3.TransformCoordinates(center, rootWorldInverse);
    // 与 conveyorDriver.resolveConveyorCargoTravelContext 同源：包围盒沿竖直轴投影最高点 + cargo.surfaceOffset。
    const upAxisWorld = getModelAxis(model.root, 'y');
    const liftWorld = projectWorldBoundsOntoAxis(bounds, upAxisWorld).max
      - Vector3.Dot(center, upAxisWorld)
      + readConveyorCargoSurfaceOffset(model);
    const surfaceYLocal = Vector3.TransformCoordinates(center.add(upAxisWorld.scale(liftWorld)), rootWorldInverse).y;
    return { centerLocal, travelAxisName, travelAxisWorld, spanMeters, surfaceYLocal };
  }

  private findEditorConveyorMotionNodes(model: ModelRuntimeEntry, config: ConveyorCargoTravelConfig): TransformNode[] {
    if (config.nodes.length > 0) {
      return filterTopLevelMotionNodes(findModelNodesByName(model, this.scene, config.nodes));
    }
    if (config.fallbackPattern) {
      let pattern: RegExp | null = null;
      try { pattern = new RegExp(config.fallbackPattern, 'i'); } catch { pattern = null; }
      return pattern ? filterTopLevelMotionNodes(findModelNodes(model, this.scene, pattern)) : [];
    }
    return [];
  }

  /** 创建轨迹虚线 + 方向箭头；全部网格非拾取，挂独立根节点（阵列源模型 root 会被合批挂起禁用）。 */
  private createConveyorTrajectory(entity: Entity, context: ConveyorTrajectoryContext, signature: string): void {
    if (context.spanMeters <= 0.001) return;

    const half = context.spanMeters / 2;
    const baseY = context.surfaceYLocal;
    const startBase = context.centerLocal.subtract(createLocalAxis(context.travelAxisName).scale(half));
    const endBase = context.centerLocal.add(createLocalAxis(context.travelAxisName).scale(half));
    const start = new Vector3(startBase.x, baseY, startBase.z);
    const end = new Vector3(endBase.x, baseY, endBase.z);

    const root = new TransformNode(`${entity.id}_conveyorTrajectoryRoot`, this.scene);
    this.refreshConveyorTrajectoryRoot(entity, root);

    // 流光渐变：颜色表沿虚线均匀分布（COLOR_DISTRIBUTION_TYPE_LINE），每帧滚动相位形成
    // 从起点流向终点的亮度波；箭头按各自在线上的位置同步脉冲。base 为暗部亮度。
    const flowSteps = 64;
    const flowBaseIntensity = 0.2;
    const flowSpeed = 1.0; // m/s，亮度波推进速度
    const flowColors: Color3[] = [];
    for (let i = 0; i < flowSteps; i += 1) flowColors.push(Color3.White());

    const dashCount = clampNumber(Math.round(context.spanMeters / 1.2), 2, 12);
    const line = CreateGreasedLine(
      `${entity.id}_conveyorTrajectoryLine`,
      { points: [start, end], updatable: false },
      {
        materialType: GreasedLineMeshMaterialType.MATERIAL_TYPE_SIMPLE,
        color: Color3.White(),
        width: 0.035,
        sizeAttenuation: false,
        useDash: true,
        dashCount,
        dashRatio: 0.45,
        useColors: true,
        colors: flowColors,
        colorDistributionType: GreasedLineMeshColorDistributionType.COLOR_DISTRIBUTION_TYPE_LINE,
      },
      this.scene,
    );
    line.parent = root;
    line.isPickable = false;

    // trajectoryDirection 为模型本地坐标：与本地行走轴点积判定箭头/流光是否翻转。
    const trajectoryDirLocal = this.readTrajectoryLocalDirection(entity.components.telemetryBinding?.trajectoryDirection ?? 'x');
    const localDir = normalizeVector(end.subtract(start), createLocalAxis(context.travelAxisName));
    const flip = Vector3.Dot(trajectoryDirLocal, localDir) < 0;
    const arrowDir = flip ? localDir.scale(-1) : localDir;
    const dot = Vector3.Dot(new Vector3(1, 0, 0), arrowDir);
    const cross = Vector3.Cross(new Vector3(1, 0, 0), arrowDir);
    const arrowQuat = cross.lengthSquared() < 0.0001
      ? (dot < 0 ? Quaternion.RotationAxis(new Vector3(0, 1, 0), Math.PI) : Quaternion.Identity())
      : Quaternion.RotationAxis(cross, Math.acos(clampNumber(dot, -1, 1)));

    // 平面 › 形箭头：两片扁盒从尖端向后张开，无柄无锥头；每臂独立材质以支持脉冲亮度。
    const chevronAngle = Math.PI / 4.5;
    const chevronArmLength = 0.26;
    const arrowCount = clampNumber(Math.round(context.spanMeters / 3), 2, 5);
    const arrowMeshes: Mesh[] = [];
    const arrowMaterials: StandardMaterial[] = [];
    for (let i = 0; i < arrowCount; i += 1) {
      const t = (i + 1) / (arrowCount + 1);
      const arrowRoot = new TransformNode(`${entity.id}_conveyorTrajectoryArrow_${i}`, this.scene);
      arrowRoot.parent = root;
      arrowRoot.position = Vector3.Lerp(start, end, t);
      arrowRoot.rotationQuaternion = arrowQuat;

      for (const side of [-1, 1]) {
        const arm = MeshBuilder.CreateBox(
          `${arrowRoot.name}_arm_${side}`,
          { width: chevronArmLength, height: 0.015, depth: 0.035 },
          this.scene,
        );
        arm.parent = arrowRoot;
        arm.rotation.y = -side * (Math.PI - chevronAngle);
        arm.position = new Vector3(
          -Math.cos(chevronAngle) * chevronArmLength * 0.5,
          0,
          side * Math.sin(chevronAngle) * chevronArmLength * 0.5,
        );
        const armMaterial = new StandardMaterial(`${arrowRoot.name}_armMat_${side}`, this.scene);
        armMaterial.diffuseColor = Color3.White();
        armMaterial.emissiveColor = Color3.White();
        armMaterial.disableLighting = true;
        armMaterial.alpha = 0.9;
        armMaterial.backFaceCulling = false;
        armMaterial.disableDepthWrite = true;
        arm.material = armMaterial;
        arm.isPickable = false;
        arrowMeshes.push(arm);
        arrowMaterials.push(armMaterial);
      }
    }

    // phase ∈ [0,1] 为沿货物流向的归一化位置，time 为当前波相位；波头最亮向后衰减。
    const flowIntensity = (phase: number, time: number): number => {
      const d = phase - time;
      const f = d - Math.floor(d);
      const pulse = Math.pow(1 - f, 3);
      return flowBaseIntensity + (1 - flowBaseIntensity) * pulse;
    };
    const updateFlow = (time: number): void => {
      for (let i = 0; i < flowSteps; i += 1) {
        const phase = i / (flowSteps - 1);
        const v = flowIntensity(flip ? 1 - phase : phase, time);
        flowColors[i].set(v, v, v);
      }
      (line.material as GreasedLineSimpleMaterial).setColors(flowColors);
      for (let i = 0; i < arrowCount; i += 1) {
        const t = (i + 1) / (arrowCount + 1);
        const v = flowIntensity(flip ? 1 - t : t, time);
        arrowMaterials[i * 2].emissiveColor.set(v, v, v);
        arrowMaterials[i * 2 + 1].emissiveColor.set(v, v, v);
      }
    };
    updateFlow(0);

    let flowTime = 0;
    const flowObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (!root.isEnabled()) return;
      const dtSeconds = this.scene.getEngine().getDeltaTime() / 1000;
      flowTime = (flowTime + (dtSeconds * flowSpeed) / context.spanMeters) % 1;
      updateFlow(flowTime);
    });

    this.conveyorTrajectories.set(entity.id, {
      signature,
      root,
      lineMeshes: [line],
      arrowMeshes,
      arrowMaterials,
      flowObserver,
    });
  }

  /** trajectoryDirection 配置值转模型本地坐标向量（与 conveyorDriver 的本地语义一致）。 */
  private readTrajectoryLocalDirection(direction: string): Vector3 {
    if (direction === '-x') return new Vector3(-1, 0, 0);
    if (direction === 'z') return new Vector3(0, 0, 1);
    if (direction === '-z') return new Vector3(0, 0, -1);
    return new Vector3(1, 0, 0);
  }

  private disposeConveyorTrajectory(entityId: string, entry: ConveyorTrajectoryRuntimeEntry): void {
    this.scene.onBeforeRenderObservable.remove(entry.flowObserver);
    for (const lineMesh of entry.lineMeshes) lineMesh.dispose(false, true);
    for (const mesh of entry.arrowMeshes) mesh.dispose();
    for (const armMaterial of entry.arrowMaterials) armMaterial.dispose();
    entry.root.dispose();
    this.conveyorTrajectories.delete(entityId);
  }

  /** 释放导入模型的容器、根节点与所有子资源。 */
  private disposeModel(entityId: string, model: ModelRuntimeEntry): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    const trajectory = this.conveyorTrajectories.get(entityId);
    if (trajectory) this.disposeConveyorTrajectory(entityId, trajectory);
    model.telemetryPreviewBaseline = null;
    model.cancelLoad?.();
    model.cancelLoad = null;
    this.endModelArrayHostRenderSuppression(model);
    this.applyModelSelection(model, false);
    this.restoreModelArrayHostMeshes(model);
    model.root.setEnabled(true);
    model.externalScriptRuntime?.dispose();
    for (const texture of model.textureCache.values()) {
      texture.dispose();
    }
    this.disposeModelArrayParameterVariantsForSource(entityId);
    this.disposeModelArrayBatch(model);
    model.assetHandle?.dispose();
    this.specializedTelemetryRuntime.disposeCargoForAssetCode(model.assetCode);
    model.contentRoot.dispose();
    model.root.dispose();
    model.modelArraySuspendedMeshes.clear();
    this.models.delete(entityId);
    this.onModelMeasurementChanged(entityId);
  }

  /** 为模型生成器完整运行时配置生成稳定签名，配置变化时统一释放旧自动货物。 */
  private createModelGeneratorRuntimeConfigSignature(component: ModelGeneratorComponent): string {
    return JSON.stringify({
      defaultTarget: component.defaultTarget,
      rules: component.rules,
    });
  }

  /** 释放生成器当前派生输出；稳定根节点和空状态标记保持不变。 */
  private disposeModelGeneratorOutput(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    const output = runtimeEntry.output;
    if (!output) return;
    this.disposeModelGeneratorOutputValue(output);
    runtimeEntry.output = null;
  }

  /** 释放任意生成器派生输出。 */
  private disposeModelGeneratorOutputValue(output: ModelGeneratorOutputRuntimeEntry): void {
    if (output.kind === 'mesh') {
      output.material.dispose();
      output.mesh.dispose();
      return;
    }

    const model = output.model;
    model.telemetryPreviewBaseline = null;
    this.applyModelSelection(model, false);
    model.externalScriptRuntime?.dispose();
    for (const texture of model.textureCache.values()) {
      texture.dispose();
    }
    model.assetHandle?.dispose();
    model.contentRoot.dispose();
    model.root.dispose();
  }

  /** 释放模型生成器配置标记、独立输出根节点、以其为模板的货物和异步资源。 */
  private disposeModelGenerator(entityId: string, runtimeEntry: ModelGeneratorRuntimeEntry): void {
    runtimeEntry.loadToken += 1;
    this.specializedTelemetryRuntime.disposeCargoForGenerator(entityId);
    this.disposeModelGeneratorOutput(runtimeEntry);
    runtimeEntry.marker.material.dispose();
    runtimeEntry.marker.mesh.dispose();
    runtimeEntry.markerRoot.dispose();
    runtimeEntry.root.dispose();
    runtimeEntry.failedTargetSignatures.clear();
    runtimeEntry.reportedLoadFailureKeys.clear();
    this.generatedOutputOwners.delete(runtimeEntry.entityId);
    this.modelGenerators.delete(entityId);
  }

  private disposeLight(entityId: string, light: Light): void {
    this.shadowRuntime.removeLight(entityId);
    this.lightMarkerRuntime.disposeEntity(entityId);
    light.dispose();
    this.lights.delete(entityId);
  }

  /** 从普通 Mesh 元数据或矩阵批次 thinInstanceIndex 中读取编辑器实体 ID。 */
  private readEntityIdFromMesh(mesh: AbstractMesh | null, thinInstanceIndex: number | null = null): string | null {
    if (!mesh) return null;

    const modelArrayBatch = this.modelArrayBatchByMeshUniqueId.get(mesh.uniqueId);
    if (modelArrayBatch && thinInstanceIndex !== null) {
      return modelArrayBatch.getEntityIdForThinInstance(mesh, thinInstanceIndex);
    }

    const metadata = mesh.metadata as EditorMeshMetadata | null | undefined;
    const entityId = metadata?.[EDITOR_ENTITY_ID_METADATA_KEY];

    return typeof entityId === 'string'
      && (
        this.meshes.has(entityId)
        || this.locators.has(entityId)
        || this.models.has(entityId)
        || this.modelArrayInstanceEntities.has(entityId)
        || this.modelGenerators.has(entityId)
        || this.poiEffectRuntime.has(entityId)
        || this.lightMarkerRuntime.has(entityId)
        || this.autoPatrolMarkerRuntime.has(entityId)
        || this.skyboxRuntime.hasEntity(entityId)
      )
      ? entityId
      : null;
  }

  /** 判断实体当前是否应在 Babylon 场景中显示。 */
  private isEntityVisible(entityId: string): boolean {
    return this.entityStates.get(entityId)?.visible !== false;
  }

  /** 判断实体是否允许被 Scene View 鼠标拾取。 */
  private isEntityScenePickable(entityId: string): boolean {
    const state = this.entityStates.get(entityId);
    if (state?.visible === false || state?.locked === true) return false;
    // 内置货格绑定期间位置由货架驱动，场景内点击穿透到货架。
    if (this.syncedEntities.get(entityId)?.components.locator?.builtInBinding) return false;
    return true;
  }

  /** 运行预览和发布 Viewer 的只读选择只要求模型可见，不继承 authoring lock。 */
  private isRuntimeModelSceneSelectable(entityId: string): boolean {
    return isRuntimeModelSelectionCandidate(
      this.syncedEntities.get(entityId),
      this.entityStates.get(entityId),
    );
  }

  /** 判断实体是否允许绑定 Transform Gizmo。 */
  private isEntityTransformEditable(entityId: string): boolean {
    return this.isEntityScenePickable(entityId);
  }

  /** 将显隐和锁定状态应用到可拾取 Mesh。 */
  private applyMeshInteractivity(mesh: AbstractMesh, entityId: string): void {
    const visible = this.isEntityVisible(entityId);
    mesh.isVisible = visible;
    mesh.isPickable = visible && this.isEntityScenePickable(entityId);
  }

  /**
   * 计算绑定货格当前是否应渲染：编辑态仅当眼睛开关开启且宿主或货格自身被选中时显示；
   * 运行预览与发布模式一律隐藏。非绑定货格返回 true，不受管控。
   */
  private computeBuiltInSlotRenderable(
    entity: Entity,
    selectedEntityIds: ReadonlySet<string> = this.selectedEntityIds,
  ): boolean {
    if (this.telemetryPreviewActive) return false;
    const binding = entity.components.locator?.builtInBinding;
    if (!binding) return true;
    const hostState = this.entityStates.get(binding.hostEntityId);
    if (!hostState || hostState.visible === false) return false;
    if (!this.isEntityVisible(entity.id)) return false;
    return this.isEntityHighlighted(binding.hostEntityId, selectedEntityIds)
      || this.isEntityHighlighted(entity.id, selectedEntityIds);
  }

  /** 预览开关切换时全量重算绑定货格显隐；幂等，未创建的 locator 条目直接跳过。 */
  private refreshAllBuiltInSlotRenderability(): void {
    for (const entity of this.syncedEntities.values()) {
      if (!entity.components.locator?.builtInBinding) continue;
      const locator = this.locators.get(entity.id);
      if (locator) locator.root.setEnabled(this.computeBuiltInSlotRenderable(entity));
    }
  }

  /** 货格交互：填充网格承载拾取（薄实例拾取解析到实体），边线只跟随显隐。 */
  private applyLocatorInteractivity(
    locator: LocatorRuntimeEntry,
    entity: Entity,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    this.applyMeshInteractivity(locator.fillMesh, entity.id);
    locator.edgeLines.isVisible = this.isEntityVisible(entity.id);
    if (entity.components.locator?.builtInBinding) {
      locator.root.setEnabled(this.computeBuiltInSlotRenderable(entity, highlightSet));
    }
  }

  /** 将显隐和锁定状态应用到导入模型的根节点与子 Mesh。 */
  private applyModelInteractivity(
    model: ModelRuntimeEntry,
    entityId: string,
    highlightSet: ReadonlySet<string> = this.selectedEntityIds,
  ): void {
    const keepScriptHostActive = model.externalScriptStarting
      && (Boolean(model.modelArrayBatch) || model.modelArraySuspendedMeshes.size > 0);
    const visible = keepScriptHostActive || this.isEntityVisible(entityId);
    if (model.modelArrayBatch && !keepScriptHostActive) {
      this.suspendModelArrayHost(model);
    } else {
      this.restoreModelArrayHostMeshes(model);
      const pickable = !keepScriptHostActive && visible && this.isEntityScenePickable(entityId);
      model.root.setEnabled(visible);
      for (const mesh of model.meshes) {
        mesh.isPickable = pickable;
      }
    }
    // 绑定货格挂在 model.root 下但不属于模型网格；宿主挂起期间根节点保持启用，货格显隐由绑定条件统一计算。
    for (const slotEntity of this.syncedEntities.values()) {
      if (slotEntity.components.locator?.builtInBinding?.hostEntityId !== entityId) continue;
      this.locators.get(slotEntity.id)?.root.setEnabled(this.computeBuiltInSlotRenderable(slotEntity, highlightSet));
    }
  }

  /**
   * 阵列批次已经承载源实体本身和全部逻辑实例时，脚本宿主只保留节点与几何引用。
   * 将其从 scene.meshes 移除，避免 Babylon 每帧重复遍历同一套隐藏叶 Mesh。
   * 根节点保持启用：绑定货格等外来子节点挂在 root 下，不属于模型网格，不能连带隐藏。
   */
  private suspendModelArrayHost(model: ModelRuntimeEntry): void {
    for (const mesh of model.meshes) {
      if (mesh.isDisposed()) continue;
      if (this.scene.removeMesh(mesh) >= 0) model.modelArraySuspendedMeshes.add(mesh);
      mesh.isPickable = false;
    }
  }

  /** 阵列取消或降级时，只把本运行时主动移除的宿主 Mesh 放回场景。 */
  private restoreModelArrayHostMeshes(model: ModelRuntimeEntry): void {
    if (model.modelArraySuspendedMeshes.size === 0) return;
    for (const mesh of model.modelArraySuspendedMeshes) {
      if (!mesh.isDisposed() && !this.scene.meshes.includes(mesh)) this.scene.addMesh(mesh);
    }
    model.modelArraySuspendedMeshes.clear();
  }

  /** 仅同步模型生成器配置标记；自动货物不继承实体显隐、锁定或选中状态。 */
  private applyModelGeneratorPresentation(runtimeEntry: ModelGeneratorRuntimeEntry): void {
    const visible = this.isEntityVisible(runtimeEntry.entityId);
    const pickable = visible && this.isEntityScenePickable(runtimeEntry.entityId);
    const showMarker = visible && !this.telemetryPreviewActive;

    runtimeEntry.markerRoot.setEnabled(visible);
    runtimeEntry.marker.mesh.isVisible = showMarker;
    runtimeEntry.marker.mesh.isPickable = showMarker && pickable;
    runtimeEntry.marker.material.alpha = runtimeEntry.selected ? 1 : MODEL_GENERATOR_MARKER_ALPHA;
    runtimeEntry.marker.material.diffuseColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);
    runtimeEntry.marker.material.emissiveColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);
  }

  /** 统一同步生成输出可视状态；运行时自动货物始终不可拾取。 */
  private applyGeneratedOutputPresentation(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    if (runtimeEntry.output?.kind === 'mesh') {
      runtimeEntry.output.mesh.isVisible = true;
      runtimeEntry.output.mesh.isPickable = false;
      runtimeEntry.output.material.diffuseColor = this.readColor(runtimeEntry.output.target.materialColor);
      runtimeEntry.output.material.emissiveColor = Color3.Black();
      return;
    }

    if (runtimeEntry.output?.kind === 'model') {
      runtimeEntry.output.model.root.setEnabled(true);
      this.applyModelSelection(runtimeEntry.output.model, false);
      for (const mesh of runtimeEntry.output.model.meshes) {
        mesh.isPickable = false;
      }
      this.updateModelGeneratorOutputRuntimeContext(runtimeEntry);
    }
  }

  /** 根据解析后的紧凑 CAD 几何分批创建 Babylon 线稿，避免大图纸制造海量 Vector3 临时对象。 */
  private async applyCadReferenceGeometry(
    entityId: string,
    cadReference: CadReferenceRuntimeEntry,
    geometry: CadReferenceParseResult,
  ): Promise<void> {
    const maxBatchPointCount = 60_000;
    const maxBatchPolylineCount = 4_000;

    for (const layer of geometry.layers) {
      let polylineIndex = 0;
      let pointOffset = 0;
      let batchIndex = 0;

      while (polylineIndex < layer.polylinePointCounts.length) {
        const currentPointCount = layer.polylinePointCounts[polylineIndex];
        if (currentPointCount > maxBatchPointCount) {
          let remainingPointCount = currentPointCount;
          let chunkPointOffset = pointOffset;
          while (remainingPointCount > 1) {
            if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
            const chunkPointCount = Math.min(maxBatchPointCount, remainingPointCount);
            this.createCadReferenceLineBatch(
              entityId,
              cadReference,
              layer.name,
              batchIndex,
              layer.positions.slice(chunkPointOffset * 3, (chunkPointOffset + chunkPointCount) * 3),
              new Uint32Array([chunkPointCount]),
            );
            batchIndex += 1;
            await this.waitForCadReferenceRenderFrame();

            if (chunkPointCount === remainingPointCount) break;
            chunkPointOffset += chunkPointCount - 1;
            remainingPointCount -= chunkPointCount - 1;
          }

          pointOffset += currentPointCount;
          polylineIndex += 1;
          continue;
        }

        const batchPointOffset = pointOffset;
        const batchPolylineIndex = polylineIndex;
        let batchPointCount = 0;
        let batchPolylineCount = 0;

        while (polylineIndex < layer.polylinePointCounts.length) {
          const polylinePointCount = layer.polylinePointCounts[polylineIndex];
          if (polylinePointCount > maxBatchPointCount) break;
          const exceedsBatchBudget = batchPolylineCount > 0 && (
            batchPolylineCount >= maxBatchPolylineCount
            || batchPointCount + polylinePointCount > maxBatchPointCount
          );
          if (exceedsBatchBudget) break;

          batchPointCount += polylinePointCount;
          batchPolylineCount += 1;
          pointOffset += polylinePointCount;
          polylineIndex += 1;
        }

        if (batchPolylineCount === 0) continue;
        if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
        this.createCadReferenceLineBatch(
          entityId,
          cadReference,
          layer.name,
          batchIndex,
          layer.positions.slice(batchPointOffset * 3, (batchPointOffset + batchPointCount) * 3),
          layer.polylinePointCounts.slice(batchPolylineIndex, batchPolylineIndex + batchPolylineCount),
        );
        batchIndex += 1;
        await this.waitForCadReferenceRenderFrame();
      }
    }

    if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
    cadReference.geometryReady = cadReference.lineMeshes.length > 0;
    this.applyCadReferenceLineMeshStyle(cadReference);
    this.applyCadReferenceInteractivity(cadReference, entityId);
    this.refreshGroupTransformPreviewTargets();
  }

  /** 判断当前 CAD 分批任务是否仍属于场景中的有效加载记录。 */
  private isActiveCadReferenceLoad(entityId: string, cadReference: CadReferenceRuntimeEntry): boolean {
    const activeEntry = this.cadReferences.get(entityId);
    return activeEntry === cadReference && activeEntry.loadToken === cadReference.loadToken;
  }

  /** 从紧凑点数组直接创建单个受控大小的 CAD LinesMesh，避免二次对象化和通用 Builder 拷贝。 */
  private createCadReferenceLineBatch(
    entityId: string,
    cadReference: CadReferenceRuntimeEntry,
    layerName: string,
    batchIndex: number,
    positions: Float32Array,
    polylinePointCounts: Uint32Array,
  ): void {
    let segmentCount = 0;
    for (const pointCount of polylinePointCounts) {
      segmentCount += Math.max(0, pointCount - 1);
    }

    const indices = new Uint16Array(segmentCount * 2);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const pointCount of polylinePointCounts) {
      for (let pointIndex = 1; pointIndex < pointCount; pointIndex += 1) {
        indices[indexOffset] = vertexOffset + pointIndex - 1;
        indices[indexOffset + 1] = vertexOffset + pointIndex;
        indexOffset += 2;
      }
      vertexOffset += pointCount;
    }

    const lineMesh = new LinesMesh(
      `${entityId}_cadLayer_${sanitizeBabylonName(layerName)}_${batchIndex}`,
      this.scene,
      null,
      null,
      undefined,
      false,
      true,
    );
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.applyToMesh(lineMesh, false);
    lineMesh.parent = cadReference.root;
    lineMesh.isPickable = false;
    lineMesh.metadata = { ...(lineMesh.metadata ?? {}), cadReferenceLayer: layerName };
    cadReference.lineMeshes.push(lineMesh);
  }

  /** 在 CAD 批次之间让出一帧，使编辑器输入、进度和重绘保持响应。 */
  private waitForCadReferenceRenderFrame(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  /** CAD 参考图永远不参与鼠标拾取，只响应 Hierarchy 显隐。 */
  private applyCadReferenceInteractivity(cadReference: CadReferenceRuntimeEntry, entityId: string): void {
    const visible = this.isEntityVisible(entityId);
    cadReference.root.setEnabled(visible);

    for (const lineMesh of cadReference.lineMeshes) {
      lineMesh.isPickable = false;
    }
  }

  /** 根据组件显示参数刷新 CAD 参考图线稿颜色和透明度。 */
  private applyCadReferenceStyle(
    cadReference: CadReferenceRuntimeEntry,
    cadReferenceComponent: CadReferenceComponent,
  ): void {
    cadReference.lineColor = cadReferenceComponent.lineColor;
    cadReference.opacity = cadReferenceComponent.opacity;
    this.applyCadReferenceLineMeshStyle(cadReference);
  }

  /** 把 CAD 参考图运行时记录里的最新样式应用到所有线稿 Mesh。 */
  private applyCadReferenceLineMeshStyle(cadReference: CadReferenceRuntimeEntry): void {
    const color = this.readColor(cadReference.lineColor);
    const alpha = Math.min(1, Math.max(0, cadReference.opacity));

    for (const lineMesh of cadReference.lineMeshes) {
      lineMesh.color = color;
      lineMesh.alpha = alpha;
    }
  }

  /** 根据选中状态更新 locator 填充面与边线颜色。 */
  private applyLocatorStyle(entry: LocatorRuntimeEntry, selected: boolean): void {
    const color = selected ? SELECTED_MATERIAL_COLOR : LOCATOR_EDGE_COLOR;
    const color3 = Color3.FromHexString(color);

    entry.material.alpha = selected ? SELECTED_LOCATOR_SURFACE_ALPHA : LOCATOR_SURFACE_ALPHA;
    entry.material.diffuseColor = color3;
    entry.material.emissiveColor = color3;
    entry.edgeLines.color = color3;
  }

  /** 读取材质颜色，非法颜色回退到默认编辑器颜色。 */
  private readColor(hexColor: string): Color3 {
    try {
      return Color3.FromHexString(hexColor);
    } catch {
      return Color3.FromHexString(FALLBACK_MATERIAL_COLOR);
    }
  }

  /** 将编辑器 Transform 写入 Babylon 节点。 */
  private applyTransform(target: AbstractMesh | TransformNode, transform: TransformComponent): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotationQuaternion = null;
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  /** 为当前选中的矩阵实例复用一个无几何 TransformNode，Gizmo 拖动仍回写该逻辑实体。 */
  private getOrCreateModelArrayGizmoProxy(entity: Entity): TransformNode {
    if (!this.modelArrayGizmoProxy || this.modelArrayGizmoProxy.node.isDisposed()) {
      this.modelArrayGizmoProxy = {
        entityId: entity.id,
        node: new TransformNode('__modelArrayInstanceGizmoProxy', this.scene),
      };
    }

    this.modelArrayGizmoProxy.entityId = entity.id;
    this.applyTransform(this.modelArrayGizmoProxy.node, entity.components.transform);
    this.modelArrayGizmoProxy.node.computeWorldMatrix(true);
    return this.modelArrayGizmoProxy.node;
  }

  /**
   * 完整同步结束后回收不再由矩阵阵列承载的 Gizmo 代理。
   * 正式阵列的原模型也使用该代理；若只检查 modelArrayInstance，拖动首帧同步会销毁当前目标。
   */
  private disposeStaleModelArrayGizmoProxy(): void {
    const proxy = this.modelArrayGizmoProxy;
    if (!proxy) return;
    if (
      this.modelArrayInstanceEntities.has(proxy.entityId)
      || Boolean(this.models.get(proxy.entityId)?.modelArrayBatch)
    ) {
      return;
    }

    proxy.node.dispose(false, false);
    this.modelArrayGizmoProxy = null;
  }

  /** 将模型或环境源单位换算到米，避免污染可被 Gizmo 写回的实体根 Transform。 */
  private applyModelUnitScale(target: TransformNode, unitScaleToMeters: number): void {
    target.scaling = new Vector3(unitScaleToMeters, unitScaleToMeters, unitScaleToMeters);
  }

  /** 根据实体模型资产把声明式参数绑定应用到模型节点、网格和材质。 */
  private applyModelParameters(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;
    this.applyModelAssetParameters(modelAsset, model);
  }

  /** 应用完整模型资产快照中的默认参数，普通模型和生成模型共用同一逻辑。 */
  private applyModelAssetParameters(modelAsset: ModelAssetComponent, model: ModelRuntimeEntry): void {
    if (!modelAsset.parameterConfig || !modelAsset.parameterValues || !model.assetHandle) return;

    const signature = JSON.stringify({ config: modelAsset.parameterConfig, values: modelAsset.parameterValues });
    if (model.parameterSignature === signature) return;

    this.resetModelParameterTargets(model);

    for (const binding of modelAsset.parameterConfig.bindings) {
      this.applyModelParameterBinding(binding, modelAsset.parameterValues, modelAsset, model);
    }

    for (const rule of modelAsset.parameterConfig.rules ?? []) {
      if (this.evaluateBooleanExpression(rule.when, modelAsset.parameterValues)) {
        for (const binding of rule.set) {
          this.applyModelParameterBinding(binding, modelAsset.parameterValues, modelAsset, model);
        }
      }
    }

    model.parameterSignature = signature;
  }

  /** 货架脚本更新布局 metadata 后，重同步其全部绑定货格的位置与网格步距。 */
  private refreshBuiltInSlotBindings(hostEntityId: string): void {
    const hostEntity = this.syncedEntities.get(hostEntityId) ?? null;
    const hostAsset = hostEntity?.components.modelAsset;
    const hostRenderSignature = hostAsset
      ? this.createModelArrayRenderSignature(hostAsset, hostEntity?.components.telemetryBinding)
      : null;
    for (const entity of this.syncedEntities.values()) {
      const locator = entity.components.locator;
      const boundHostId = locator?.builtInBinding?.hostEntityId;
      if (!boundHostId) continue;
      if (boundHostId === hostEntityId) {
        this.syncLocatorEntity(entity, this.isEntityHighlighted(entity.id));
        continue;
      }
      // 绑定到阵列副本的货格跟随副本渲染源的布局更新；副本参数与源已分化时改由参数变体脚本就绪后刷新。
      const boundHost = this.syncedEntities.get(boundHostId) ?? this.modelArrayInstanceEntities.get(boundHostId);
      if (boundHost?.components.modelArrayInstance?.sourceEntityId !== hostEntityId) continue;
      const boundHostAsset = boundHost.components.modelAsset;
      if (
        hostRenderSignature
        && boundHostAsset
        && this.createModelArrayRenderSignature(boundHostAsset, boundHost.components.telemetryBinding) !== hostRenderSignature
      ) {
        continue;
      }
      this.syncLocatorEntity(entity, this.isEntityHighlighted(entity.id));
    }
  }

  /** 同步普通模型包外置脚本，并在脚本就绪后刷新模型呈现。 */
  private syncExternalModelScripts(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;
    this.syncModelAssetExternalScripts(modelAsset, model, (current) => {
      const latestEntity = current.entitySnapshot ?? entity;
      this.refreshModelEntityMeshes(latestEntity, current);
      this.syncModelArrayBatch(latestEntity, current);
      this.applyModelInteractivity(current, latestEntity.id);
      this.applyModelSelection(current, current.highlighted);
      this.rebuildModelSelectionOutline();
      this.onModelMeasurementChanged(latestEntity.id);
      this.syncConveyorTrajectory(latestEntity, current);
      this.refreshBuiltInSlotBindings(latestEntity.id);
      this.refreshGroupTransformPreviewTargets();
    });
  }

  /** 同步生成模型外置脚本；只注入生成器快照，不注册独立遥测运动实体。 */
  private syncModelGeneratorExternalScripts(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
  ): void {
    this.syncModelAssetExternalScripts(modelAsset, model, (current) => {
      const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
      if (activeEntry?.output?.kind !== 'model' || activeEntry.output.model !== current) return;
      this.refreshModelGeneratorModelMeshes(activeEntry);
      this.applyGeneratedOutputPresentation(activeEntry);
    });
  }

  /** 收集普通模型脚本生成的额外 Mesh，并统一补齐实体拾取元数据。 */
  private refreshModelEntityMeshes(entity: Entity, model: ModelRuntimeEntry): void {
    this.refreshModelMeshes(model, { [EDITOR_ENTITY_ID_METADATA_KEY]: entity.id });
  }

  /** 收集模型脚本在稳定根节点下创建的额外 Mesh，并补齐生成器拾取元数据。 */
  private refreshModelGeneratorModelMeshes(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    if (runtimeEntry.output?.kind !== 'model') return;
    const model = runtimeEntry.output.model;
    this.refreshModelMeshes(model, {
      ...runtimeEntry.metadata,
      ...(runtimeEntry.editorEntityId ? { [EDITOR_ENTITY_ID_METADATA_KEY]: runtimeEntry.editorEntityId } : {}),
    });
    if (!runtimeEntry.editorEntityId) {
      for (const mesh of model.meshes) {
        mesh.isPickable = false;
      }
    }
  }

  /** 从模型稳定根节点重新收集全部活动 Mesh，并合并运行时元数据。 */
  private refreshModelMeshes(model: ModelRuntimeEntry, metadata: Record<string, unknown>): void {
    // 只收集 contentRoot 下的模型自身内容：绑定货格挂在 model.root 下，混入会被阵列批次克隆、挂起时移出场景。
    model.meshes = [...new Set(model.contentRoot.getChildMeshes(false))]
      .filter((mesh) => !mesh.isDisposed());
    repairInstancedMeshBufferContainers(model.meshes);
    for (const mesh of model.meshes) {
      mesh.metadata = { ...(mesh.metadata ?? {}), ...metadata };
    }
  }

  /** 在文档实体完成同步后，按源模型统一刷新全部独立逻辑实例的矩阵批次。 */
  private syncAllModelArrayBatches(
    document: SceneDocument,
    sourceEntityIds: ReadonlySet<string>,
    parameterOnlyChangedEntityId?: string,
  ): void {
    for (const sourceEntityId of sourceEntityIds) {
      const model = this.models.get(sourceEntityId);
      if (!model) continue;
      const sourceEntity = document.entities[sourceEntityId];
      if (!sourceEntity?.components.modelAsset || sourceEntity.components.modelArrayInstance) {
        this.disposeModelArrayBatch(model);
        this.disposeModelArrayParameterVariantsForSource(sourceEntityId);
        continue;
      }
      this.syncModelArrayBatch(sourceEntity, model, parameterOnlyChangedEntityId);
    }
  }

  /**
   * 合批 conveyor 只失去渲染身份，不失去设备身份：为每台启用遥测的非代表实例维护一个
   * 无几何遥测代理（独立 assetCode/binding/遥测状态），几何查询经 telemetryProxySource
   * 换算回宿主模型，链路协议与货物走行无需拆批即可逐设备运行。
   */
  private syncModelArrayTelemetryProxies(): void {
    const desired = new Map<string, { entity: Entity; host: ModelRuntimeEntry }>();
    for (const instanceEntity of this.modelArrayInstanceEntities.values()) {
      const modelAsset = instanceEntity.components.modelAsset;
      const binding = instanceEntity.components.telemetryBinding;
      // 无显式绑定的实例与真实模型一致：按 assetCode 走默认绑定解析，不得跳过代理创建。
      if (!modelAsset || binding?.enabled === false) continue;
      // devType 归一化在导入边界已统一小写；文件名关键词识别兜底未声明 devType 的旧包。
      const devType = modelAsset.dataDrivenConfig?.device?.devType?.trim().toLowerCase();
      if (devType !== 'conveyor' && !isConveyorModelAsset(modelAsset)) continue;

      const variant = this.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      if (variant) {
        // 变体代表机的位姿与身份由变体宿主模型直接承载，无需代理。
        if (variant.representativeEntityId === instanceEntity.id) continue;
        desired.set(instanceEntity.id, { entity: instanceEntity, host: variant.model });
        continue;
      }

      // 未映射变体：与源同签名说明由源批次承载；签名不同则参数变体宿主尚未就绪，等重同步后再建代理。
      const sourceEntityId = instanceEntity.components.modelArrayInstance?.sourceEntityId;
      const sourceModel = sourceEntityId ? this.models.get(sourceEntityId) : null;
      const sourceEntity = sourceModel?.entitySnapshot ?? null;
      const sourceModelAsset = sourceEntity?.components.modelAsset;
      if (!sourceModel || !sourceEntity || !sourceModelAsset) continue;
      if (
        this.createModelArrayRenderSignature(modelAsset, binding)
        !== this.createModelArrayRenderSignature(sourceModelAsset, sourceEntity.components.telemetryBinding)
      ) {
        continue;
      }
      desired.set(instanceEntity.id, { entity: instanceEntity, host: sourceModel });
    }

    for (const [entityId, proxy] of [...this.modelArrayTelemetryProxies.entries()]) {
      const target = desired.get(entityId);
      if (!target || proxy.telemetryProxySource !== target.host) {
        this.disposeModelArrayTelemetryProxy(entityId, proxy);
      }
    }
    for (const [entityId, target] of desired) {
      const proxy = this.modelArrayTelemetryProxies.get(entityId)
        ?? this.createModelArrayTelemetryProxy(target.entity, target.host);
      proxy.entitySnapshot = target.entity;
      proxy.assetCode = target.entity.components.modelAsset?.assetCode ?? proxy.assetCode;
      proxy.telemetryBinding = target.entity.components.telemetryBinding ?? null;
      this.applyTransform(proxy.root, target.entity.components.transform);
    }
  }

  /** 创建合批 conveyor 实例的遥测代理：加载/就绪门控通过访问器跟随宿主，避免异步时序两处各写一份。 */
  private createModelArrayTelemetryProxy(entity: Entity, host: ModelRuntimeEntry): ModelRuntimeEntry {
    const modelAsset = entity.components.modelAsset;
    const root = new TransformNode(`__telemetryProxy_${sanitizeBabylonName(entity.id)}`, this.scene);
    const contentRoot = new TransformNode(`__telemetryProxyContent_${sanitizeBabylonName(entity.id)}`, this.scene);
    contentRoot.parent = root;
    this.applyTransform(root, entity.components.transform);

    const proxy: ModelRuntimeEntry = {
      sourceUrl: modelAsset?.sourceUrl ?? host.sourceUrl,
      assetRevision: modelAsset?.assetRevision ?? null,
      assetSignature: host.assetSignature,
      entitySnapshot: entity,
      assetCode: modelAsset?.assetCode ?? '',
      telemetryBinding: entity.components.telemetryBinding ?? null,
      stackerCapable: false,
      conveyorCapable: true,
      rgvCapable: false,
      root,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken: 0,
      cancelLoad: null,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: true,
      stackerTelemetry: createStackerTelemetryState(root),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
      telemetryProxySource: host,
    };
    Object.defineProperty(proxy, 'assetHandle', { get: () => host.assetHandle });
    Object.defineProperty(proxy, 'stackerTelemetryReady', { get: () => host.stackerTelemetryReady });
    this.modelArrayTelemetryProxies.set(entity.id, proxy);
    return proxy;
  }

  /** 销毁遥测代理：代理自身没有网格与资产，只释放位姿节点子树。 */
  private disposeModelArrayTelemetryProxy(entityId: string, proxy: ModelRuntimeEntry): void {
    if (this.modelArrayTelemetryProxies.get(entityId) !== proxy) return;
    this.modelArrayTelemetryProxies.delete(entityId);
    if (!proxy.root.isDisposed()) proxy.root.dispose(false, false);
  }

  /**
   * 将引用同一源模型的 N 个独立 Scene Entity 一次性提交为 thinInstance 矩阵。
   * 每个实体继续拥有独立名称、资产编号、Transform、显隐、锁定、删除和选择语义。
   */
  private syncModelArrayBatch(
    entity: Entity,
    model: ModelRuntimeEntry,
    parameterOnlyChangedEntityId?: string,
  ): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;

    const instanceEntities = [...this.modelArrayInstanceEntities.values()]
      .filter((instanceEntity) => (
        instanceEntity.components.modelArrayInstance?.sourceEntityId === entity.id
      ));
    const legacyItems = entity.components.modelArray?.items ?? [];
    if (instanceEntities.length === 0 && legacyItems.length === 0) {
      this.disposeModelArrayBatch(model);
      this.disposeModelArrayParameterVariantsForSource(entity.id);
      model.modelArrayFailureSignature = '';
      this.applyModelInteractivity(model, entity.id);
      return;
    }

    const previousVariantByEntityId = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
    for (const instanceEntity of instanceEntities) {
      const previousVariant = this.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      if (previousVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)) {
        previousVariantByEntityId.set(instanceEntity.id, previousVariant);
      }
    }

    const sourceRenderSignature = this.createModelArrayRenderSignature(
      modelAsset,
      entity.components.telemetryBinding,
    );
    const groups = new Map<string, Entity[]>();
    for (const instanceEntity of instanceEntities) {
      const instanceModelAsset = instanceEntity.components.modelAsset;
      const renderSignature = instanceModelAsset
        ? this.createModelArrayRenderSignature(instanceModelAsset, instanceEntity.components.telemetryBinding)
        : sourceRenderSignature;
      const group = groups.get(renderSignature) ?? [];
      group.push(instanceEntity);
      groups.set(renderSignature, group);
    }

    const baseInstances = groups.get(sourceRenderSignature) ?? [];
    groups.delete(sourceRenderSignature);
    const activeVariantKeys = new Set<string>();
    const targetVariantByEntityId = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
    for (const [renderSignature, entities] of groups) {
      const key = this.createModelArrayParameterVariantKey(entity.id, renderSignature);
      this.rekeyReusableModelArrayParameterVariant(entity.id, key, renderSignature, entities, activeVariantKeys);
      activeVariantKeys.add(key);
      const variant = this.syncModelArrayParameterVariant(
        entity,
        key,
        renderSignature,
        entities,
        parameterOnlyChangedEntityId && entities.some((item) => item.id === parameterOnlyChangedEntityId)
          ? parameterOnlyChangedEntityId
          : undefined,
      );
      if (!variant) continue;
      for (const instanceEntity of entities) targetVariantByEntityId.set(instanceEntity.id, variant);
    }

    const renderEntitiesByVariant = new Map<ModelArrayParameterVariantRuntimeEntry, Entity[]>();
    const renderEntityIdsByVariant = new Map<ModelArrayParameterVariantRuntimeEntry, Set<string>>();
    const fallbackBaseInstances: Entity[] = [];
    const retainedVariantKeys = new Set(activeVariantKeys);
    const appendVariantEntity = (variant: ModelArrayParameterVariantRuntimeEntry, instanceEntity: Entity): void => {
      const renderEntityIds = renderEntityIdsByVariant.get(variant) ?? new Set<string>();
      if (renderEntityIds.has(instanceEntity.id)) return;
      renderEntityIds.add(instanceEntity.id);
      renderEntityIdsByVariant.set(variant, renderEntityIds);
      const renderEntities = renderEntitiesByVariant.get(variant) ?? [];
      renderEntities.push(instanceEntity);
      renderEntitiesByVariant.set(variant, renderEntities);
      retainedVariantKeys.add(variant.key);
    };

    for (const instanceEntity of instanceEntities) {
      const targetVariant = targetVariantByEntityId.get(instanceEntity.id);
      if (!targetVariant) continue;
      if (this.isModelArrayBatchCurrent(targetVariant.model, targetVariant.renderSignature)) {
        appendVariantEntity(targetVariant, instanceEntity);
        continue;
      }

      const previousVariant = previousVariantByEntityId.get(instanceEntity.id);
      if (previousVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)) {
        appendVariantEntity(previousVariant, instanceEntity);
      } else if (model.modelArrayBatch?.hasEntityId(instanceEntity.id)) {
        fallbackBaseInstances.push(instanceEntity);
      }
    }

    const baseBatchCurrent = this.isModelArrayBatchCurrent(model, sourceRenderSignature);
    const mustKeepPreviousBaseBatch = !baseBatchCurrent && fallbackBaseInstances.length > 0;
    if (mustKeepPreviousBaseBatch) {
      for (const baseInstance of baseInstances) {
        const previousVariant = previousVariantByEntityId.get(baseInstance.id);
        if (previousVariant?.model.modelArrayBatch?.hasEntityId(baseInstance.id)) {
          appendVariantEntity(previousVariant, baseInstance);
        }
      }
    }

    for (const variant of this.modelArrayParameterVariants.values()) {
      if (variant.sourceEntityId !== entity.id) continue;
      const targetEntities = variant.entities.filter((instanceEntity) => (
        targetVariantByEntityId.get(instanceEntity.id) === variant
        && this.isModelArrayBatchCurrent(variant.model, variant.renderSignature)
      ));
      for (const targetEntity of targetEntities) appendVariantEntity(variant, targetEntity);
    }

    for (const [variant, renderEntities] of renderEntitiesByVariant) {
      if (!this.isModelArrayBatchCurrent(variant.model, variant.renderSignature)) continue;
      const representative = variant.entities.find((item) => item.id === variant.representativeEntityId)
        ?? variant.entities[0]
        ?? renderEntities[0];
      if (!representative) continue;
      this.syncModelArrayBatchForEntities(representative, variant.model, renderEntities, [], {
        sourceEntityId: variant.sourceEntityId,
        namePrefix: '__modelArrayParameterVariantThinInstance',
        variantKey: variant.key,
        renderSignature: variant.renderSignature,
        resolveLayerMask: (mesh) => variant.sourceLayerMasks.get(mesh.uniqueId) ?? mesh.layerMask,
        parameterOnlyChangedEntityId,
      });
    }

    if (!mustKeepPreviousBaseBatch) {
      const baseRenderEntities: Entity[] = [];
      const baseRenderEntityIds = new Set<string>();
      for (const renderEntity of [entity, ...baseInstances, ...fallbackBaseInstances]) {
        if (baseRenderEntityIds.has(renderEntity.id)) continue;
        baseRenderEntityIds.add(renderEntity.id);
        baseRenderEntities.push(renderEntity);
      }
      this.syncModelArrayBatchForEntities(entity, model, baseRenderEntities, legacyItems, {
        sourceEntityId: entity.id,
        namePrefix: '__modelArrayThinInstance',
        renderSignature: sourceRenderSignature,
        parameterOnlyChangedEntityId,
      });
    } else {
      // 源参数已变化而副本的旧参数宿主尚未 ready：完整保留旧批次，等待新宿主就绪后原子切换。
      this.suspendModelArrayHost(model);
    }

    for (const [entityId, variant] of this.modelArrayParameterVariantByEntityId) {
      if (variant.sourceEntityId === entity.id) this.modelArrayParameterVariantByEntityId.delete(entityId);
    }
    for (const instanceEntity of instanceEntities) {
      const targetVariant = targetVariantByEntityId.get(instanceEntity.id);
      if (targetVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)
        && this.isModelArrayBatchCurrent(targetVariant.model, targetVariant.renderSignature)) {
        this.modelArrayParameterVariantByEntityId.set(instanceEntity.id, targetVariant);
        continue;
      }
      const previousVariant = previousVariantByEntityId.get(instanceEntity.id);
      if (previousVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)
        && (Boolean(targetVariant) || mustKeepPreviousBaseBatch)) {
        this.modelArrayParameterVariantByEntityId.set(instanceEntity.id, previousVariant);
      }
    }

    this.disposeMissingModelArrayParameterVariants(entity.id, retainedVariantKeys);
    this.syncConveyorTrajectoriesForArrayInstances(entity.id);
  }

  /** 编辑态资产编号不影响外观；运行态仅对启用遥测的真实阵列按设备身份隔离宿主。 */
  private createModelArrayRenderSignature(
    modelAsset: ModelAssetComponent,
    telemetryBinding: TelemetryBindingComponent | null | undefined = null,
  ): string {
    const telemetryIdentity = this.modelArrayIdentityMode === 'device'
      && telemetryBinding
      && telemetryBinding.enabled !== false
      ? {
          assetCode: modelAsset.assetCode,
          binding: this.createModelArrayJsonSignature(telemetryBinding),
        }
      : null;
    return JSON.stringify({
      sourcePath: modelAsset.sourcePath,
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      lengthUnit: modelAsset.lengthUnit,
      unitScaleToMeters: modelAsset.unitScaleToMeters,
      instancingMode: resolveModelAssetSharedInstancingPolicy(modelAsset).mode,
      scripts: (modelAsset.scriptAssets ?? []).map((script) => ({
        path: script.path,
        name: script.name,
        source: this.createModelArrayCanonicalStringSignature(script.sourceUrl),
      })),
      parameterScripts: this.createModelArrayJsonSignature(modelAsset.parameterScriptMetadata),
      animationScripts: this.createModelArrayJsonSignature(modelAsset.animationScriptMetadata),
      parameterConfig: this.createModelArrayJsonSignature(modelAsset.parameterConfig),
      parameterValues: this.createModelArrayTransientJsonSignature(modelAsset.parameterValues),
      dataDrivenConfig: this.createModelArrayJsonSignature(modelAsset.dataDrivenConfig),
      telemetryIdentity,
    });
  }

  /** 参数值可能随滑块持续变化，不进入长期驻留缓存，避免编辑会话内无界增长。 */
  private createModelArrayTransientJsonSignature(value: unknown): string {
    if (value === undefined) return '-';
    if (value !== null && typeof value === 'object') {
      const cached = this.modelArrayTransientJsonSignatureCache.get(value);
      if (cached) return cached;
      const signature = this.serializeModelArrayJsonValue(value);
      this.modelArrayTransientJsonSignatureCache.set(value, signature);
      return signature;
    }
    return this.serializeModelArrayJsonValue(value);
  }

  /** 对不可变 JSON 快照缓存精确的场景内编号，既避免大字符串重复拼接，也不存在哈希碰撞。 */
  private createModelArrayJsonSignature(value: unknown): string {
    if (value === undefined) return '-';
    if (value !== null && typeof value === 'object') {
      const cached = this.modelArrayJsonSignatureCache.get(value);
      if (cached) return cached;
      const signature = this.createModelArrayCanonicalStringSignature(this.serializeModelArrayJsonValue(value));
      this.modelArrayJsonSignatureCache.set(value, signature);
      return signature;
    }
    return this.createModelArrayCanonicalStringSignature(this.serializeModelArrayJsonValue(value));
  }

  private serializeModelArrayJsonValue(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((item) => this.serializeModelArrayJsonValue(item)).join(',')}]`;

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${this.serializeModelArrayJsonValue(record[key])}`)
      .join(',')}}`;
  }

  private createModelArrayCanonicalStringSignature(value: string): string {
    const existingId = this.modelArrayCanonicalSignatureIds.get(value);
    if (existingId !== undefined) return `s${existingId}`;
    const nextId = ++this.modelArrayCanonicalSignatureSequence;
    this.modelArrayCanonicalSignatureIds.set(value, nextId);
    return `s${nextId}`;
  }

  private createModelArrayParameterVariantKey(sourceEntityId: string, renderSignature: string): string {
    return `${sourceEntityId}\u0000${renderSignature}`;
  }

  /** 单实体或整组连续调参时复用已就绪宿主，避免每次滑块变化都重新加载并启动脚本。 */
  private rekeyReusableModelArrayParameterVariant(
    sourceEntityId: string,
    nextKey: string,
    nextRenderSignature: string,
    entities: readonly Entity[],
    reservedKeys: ReadonlySet<string>,
  ): void {
    if (this.modelArrayParameterVariants.has(nextKey)) return;
    const entityIds = new Set(entities.map((entity) => entity.id));
    const reusable = [...this.modelArrayParameterVariants.values()].find((variant) => (
      variant.sourceEntityId === sourceEntityId
      && !reservedKeys.has(variant.key)
      && variant.model.assetHandle !== null
      && !variant.model.externalScriptStarting
      && variant.entities.length === entityIds.size
      && variant.entities.every((entity) => entityIds.has(entity.id))
    ));
    if (!reusable) return;

    this.modelArrayParameterVariants.delete(reusable.key);
    reusable.key = nextKey;
    reusable.renderSignature = nextRenderSignature;
    this.modelArrayParameterVariants.set(nextKey, reusable);
  }

  /** 为一个不同参数组合创建或刷新唯一脚本宿主；组内所有逻辑实体继续共享一个矩阵批次。 */
  private syncModelArrayParameterVariant(
    sourceEntity: Entity,
    key: string,
    renderSignature: string,
    entities: Entity[],
    parameterOnlyChangedEntityId?: string,
  ): ModelArrayParameterVariantRuntimeEntry | null {
    const representative = entities[0];
    const modelAsset = representative?.components.modelAsset;
    if (!representative || !modelAsset) return null;

    const assetSignature = this.createModelAssetSignature(modelAsset);
    let variant = this.modelArrayParameterVariants.get(key);
    if (variant && variant.model.assetSignature !== assetSignature) {
      this.disposeModelArrayParameterVariant(variant);
      variant = undefined;
    }

    if (!variant) {
      variant = this.createModelArrayParameterVariant(
        sourceEntity,
        key,
        renderSignature,
        representative,
        entities,
        modelAsset,
        assetSignature,
        parameterOnlyChangedEntityId,
      );
      return variant;
    }

    variant.representativeEntityId = representative.id;
    variant.entities = entities;
    variant.parameterOnlyChangedEntityId = parameterOnlyChangedEntityId ?? null;
    const model = variant.model;
    model.entitySnapshot = representative;
    model.assetCode = modelAsset.assetCode;
    model.telemetryBinding = representative.components.telemetryBinding ?? null;
    model.assetRevision = modelAsset.assetRevision ?? null;
    model.assetSignature = assetSignature;
    model.stackerCapable = isStackerModelAsset(modelAsset);
    model.conveyorCapable = isConveyorModelAsset(modelAsset);
    model.rgvCapable = isRgvModelAsset(modelAsset);
    this.applyTransform(model.root, representative.components.transform);
    // 参数变体宿主的单位缩放只在创建时设置；重复同步保留脚本叠加在 contentRoot 上的参数缩放。
    if (!model.assetHandle) return variant;
    if (this.isModelArrayBatchCurrent(model, renderSignature) && !model.externalScriptStarting) {
      return variant;
    }

    this.restoreModelArrayParameterVariantHost(variant);
    this.applyModelAssetParameters(modelAsset, model);
    this.syncModelArrayParameterVariantExternalScripts(variant, modelAsset);
    return variant;
  }

  private createModelArrayParameterVariant(
    sourceEntity: Entity,
    key: string,
    renderSignature: string,
    representative: Entity,
    entities: Entity[],
    modelAsset: ModelAssetComponent,
    assetSignature: string,
    parameterOnlyChangedEntityId?: string,
  ): ModelArrayParameterVariantRuntimeEntry {
    const variantSequence = ++this.modelLoadSequence;
    const root = new TransformNode(`__modelArrayParameterVariant_${sourceEntity.id}_${variantSequence}`, this.scene);
    const contentRoot = new TransformNode(`__modelArrayParameterVariantContent_${sourceEntity.id}_${variantSequence}`, this.scene);
    contentRoot.parent = root;
    this.applyTransform(root, representative.components.transform);
    this.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const loadAbortController = new AbortController();
    const model: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature,
      entitySnapshot: representative,
      assetCode: modelAsset.assetCode,
      telemetryBinding: representative.components.telemetryBinding ?? null,
      stackerCapable: isStackerModelAsset(modelAsset),
      conveyorCapable: isConveyorModelAsset(modelAsset),
      rgvCapable: isRgvModelAsset(modelAsset),
      root,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken: variantSequence,
      cancelLoad: () => loadAbortController.abort(),
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: createStackerTelemetryState(root),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
    };
    const variant: ModelArrayParameterVariantRuntimeEntry = {
      key,
      sourceEntityId: sourceEntity.id,
      renderSignature,
      representativeEntityId: representative.id,
      entities,
      sourceLayerMasks: new Map(),
      parameterOnlyChangedEntityId: parameterOnlyChangedEntityId ?? null,
      model,
    };
    this.modelArrayParameterVariants.set(key, variant);

    void this.loadModelRuntimeAssets(modelAsset, assetSignature, loadAbortController.signal)
      .then((loadedAssets) => {
        const activeVariant = this.modelArrayParameterVariants.get(key);
        if (!activeVariant || activeVariant.model !== model || model.loadToken !== variantSequence) {
          loadedAssets.handle.dispose();
          return;
        }

        model.cancelLoad = null;
        model.assetHandle = loadedAssets.handle;
        if (loadedAssets.kind === 'owned-container') {
          model.meshes = loadedAssets.meshes;
          this.parentTopLevelModelNodes(model, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) rootNode.parent = model.contentRoot;
        }

        const latestEntity = activeVariant.entities.find((item) => item.id === activeVariant.representativeEntityId)
          ?? activeVariant.entities[0]
          ?? representative;
        const latestModelAsset = latestEntity.components.modelAsset ?? modelAsset;
        model.entitySnapshot = latestEntity;
        this.refreshModelMeshes(model, {
          modelArrayParameterVariant: true,
          modelArraySourceEntityId: sourceEntity.id,
        });
        this.normalizeModelContentOrigin(model);
        this.applyModelAssetParameters(latestModelAsset, model);
        // 编译/启动外置脚本期间宿主必须保持 enabled 和原渲染属性，兼容脚本测量、scene.meshes 查找与克隆。
        // 仅在 Active Mesh 评估期间临时禁用根节点，旧批次继续显示，避免宿主与批次重叠闪烁。
        this.beginModelArrayParameterVariantRenderSuppression(activeVariant);
        this.syncModelArrayParameterVariantExternalScripts(activeVariant, latestModelAsset);
      })
      .catch((error) => {
        const activeVariant = this.modelArrayParameterVariants.get(key);
        if (!activeVariant || activeVariant.model !== model || model.loadToken !== variantSequence) return;
        this.disposeModelArrayParameterVariant(activeVariant);
        const message = error instanceof Error ? error.message : String(error);
        this.pushLog(`模型“${representative.name}”阵列参数脚本宿主加载失败：${message}`);
      });

    return variant;
  }

  /** 参数脚本完成后刷新脚本生成 Mesh，并只把最终静态外观提交给该参数组的 thinInstance 批次。 */
  private syncModelArrayParameterVariantExternalScripts(
    variant: ModelArrayParameterVariantRuntimeEntry,
    modelAsset: ModelAssetComponent,
  ): void {
    this.syncModelAssetExternalScripts(modelAsset, variant.model, (current) => {
      const activeVariant = this.modelArrayParameterVariants.get(variant.key);
      if (!activeVariant || activeVariant.model !== current) return;

      this.refreshModelMeshes(current, {
        modelArrayParameterVariant: true,
        modelArraySourceEntityId: activeVariant.sourceEntityId,
      });
      this.hideModelArrayParameterVariantHost(activeVariant);
      this.endModelArrayParameterVariantRenderSuppression(activeVariant);
      const representative = activeVariant.entities.find((entity) => entity.id === activeVariant.representativeEntityId)
        ?? activeVariant.entities[0];
      if (representative) {
        this.syncModelArrayBatchForEntities(representative, current, activeVariant.entities, [], {
          sourceEntityId: activeVariant.sourceEntityId,
          namePrefix: '__modelArrayParameterVariantThinInstance',
          variantKey: activeVariant.key,
          renderSignature: activeVariant.renderSignature,
          resolveLayerMask: (mesh) => activeVariant.sourceLayerMasks.get(mesh.uniqueId) ?? mesh.layerMask,
        });
      }
      for (const instanceEntity of activeVariant.entities) this.onModelMeasurementChanged(instanceEntity.id);
      // 变体批次已承载这些副本：先切换渲染源映射，绑定货格才能读到变体布局而非阵列源布局。
      for (const instanceEntity of activeVariant.entities) {
        if (
          current.modelArrayBatch?.hasEntityId(instanceEntity.id)
          && this.isModelArrayBatchCurrent(current, activeVariant.renderSignature)
        ) {
          this.modelArrayParameterVariantByEntityId.set(instanceEntity.id, activeVariant);
        }
        this.refreshBuiltInSlotBindings(instanceEntity.id);
      }
      this.rebuildModelSelectionOutline();
      const parameterOnlyChangedEntityId = activeVariant.parameterOnlyChangedEntityId ?? undefined;
      activeVariant.parameterOnlyChangedEntityId = null;
      if (this.isModelArrayBatchCurrent(current, activeVariant.renderSignature)) {
        this.scheduleModelArraySourceResync(activeVariant.sourceEntityId, parameterOnlyChangedEntityId);
      }
    });
  }

  /** 新参数宿主异步初始化时保留脚本可见状态，只在每帧 Active Mesh 评估阶段禁止绘制。 */
  private beginModelArrayParameterVariantRenderSuppression(variant: ModelArrayParameterVariantRuntimeEntry): void {
    this.beginModelArrayHostRenderSuppression(variant.model);
  }

  /** 参数脚本最终 Mesh 已转入 layerMask=0 后结束逐帧临时禁用，并恢复脚本宿主 enabled 状态。 */
  private endModelArrayParameterVariantRenderSuppression(variant: ModelArrayParameterVariantRuntimeEntry): void {
    this.endModelArrayHostRenderSuppression(variant.model);
  }

  /** 脚本异步刷新期间只保留宿主的脚本可见性，禁止它和上一份有效批次同时参与绘制。 */
  private beginModelArrayHostRenderSuppression(model: ModelRuntimeEntry): void {
    if (!model.root.isDisposed()) this.pendingModelArrayVariantRenderSuppressions.add(model.root);
  }

  /** 脚本完成并原子提交新批次后，结束宿主的逐帧渲染屏蔽。 */
  private endModelArrayHostRenderSuppression(model: ModelRuntimeEntry): void {
    const root = model.root;
    this.pendingModelArrayVariantRenderSuppressions.delete(root);
    if (this.suppressedModelArrayVariantRootsThisFrame.delete(root) && !root.isDisposed()) {
      root.setEnabled(true);
    }
  }

  /** 在 onBeforeActiveMeshesEvaluation 中临时禁用 pending 宿主；脚本编译和生命周期在帧间仍读取完整启用状态。 */
  private suppressPendingModelArrayVariantHostsForRender(): void {
    this.restoreSuppressedModelArrayVariantHostsAfterRender();
    for (const root of this.pendingModelArrayVariantRenderSuppressions) {
      if (root.isDisposed() || !root.isEnabled(false)) continue;
      root.setEnabled(false);
      this.suppressedModelArrayVariantRootsThisFrame.add(root);
    }
  }

  /** 每帧渲染完成后立即恢复宿主，避免临时渲染状态污染参数脚本基线。 */
  private restoreSuppressedModelArrayVariantHostsAfterRender(): void {
    for (const root of this.suppressedModelArrayVariantRootsThisFrame) {
      if (!root.isDisposed()) root.setEnabled(true);
    }
    this.suppressedModelArrayVariantRootsThisFrame.clear();
  }

  /** 参数变体异步 ready 后合并同一源的多次请求，并在微任务中完成最终原子换批。 */
  private scheduleModelArraySourceResync(
    sourceEntityId: string,
    parameterOnlyChangedEntityId?: string,
  ): void {
    const nextChangedEntityId = parameterOnlyChangedEntityId ?? null;
    if (this.pendingModelArraySourceResyncs.has(sourceEntityId)) {
      const pendingChangedEntityId = this.pendingModelArraySourceResyncs.get(sourceEntityId) ?? null;
      if (pendingChangedEntityId !== nextChangedEntityId) {
        // 同一微任务窗口内出现不同变化来源时不能再假设只有一个参数实体变化。
        this.pendingModelArraySourceResyncs.set(sourceEntityId, null);
      }
      return;
    }

    this.pendingModelArraySourceResyncs.set(sourceEntityId, nextChangedEntityId);
    queueMicrotask(() => {
      const changedEntityId = this.pendingModelArraySourceResyncs.get(sourceEntityId) ?? undefined;
      this.pendingModelArraySourceResyncs.delete(sourceEntityId);
      const sourceModel = this.models.get(sourceEntityId);
      const sourceEntity = sourceModel?.entitySnapshot;
      if (!sourceModel || !sourceEntity?.components.modelAsset || sourceEntity.components.modelArrayInstance) return;
      this.syncModelArrayBatch(sourceEntity, sourceModel, changedEntityId);
      this.syncModelArrayTelemetryProxies();
      this.rebuildModelSelectionOutline();
    });
  }

  /** 先保存脚本宿主的原渲染层；批次创建期间仍需读取完整世界矩阵和视觉状态。 */
  private hideModelArrayParameterVariantHost(variant: ModelArrayParameterVariantRuntimeEntry): void {
    const activeMeshIds = new Set<number>();
    for (const mesh of variant.model.meshes) {
      if (mesh.isDisposed()) continue;
      activeMeshIds.add(mesh.uniqueId);
      variant.sourceLayerMasks.set(mesh.uniqueId, mesh.layerMask);
      mesh.layerMask = 0;
      mesh.isPickable = false;
    }
    for (const meshId of variant.sourceLayerMasks.keys()) {
      if (!activeMeshIds.has(meshId)) variant.sourceLayerMasks.delete(meshId);
    }
  }

  /** 参数更新前恢复宿主节点与原渲染层；Mesh 无需重新加入场景，脚本通过稳定节点引用直接更新。 */
  private restoreModelArrayParameterVariantHost(variant: ModelArrayParameterVariantRuntimeEntry): void {
    variant.model.root.setEnabled(true);
    for (const mesh of variant.model.meshes) {
      const layerMask = variant.sourceLayerMasks.get(mesh.uniqueId);
      if (layerMask !== undefined) mesh.layerMask = layerMask;
    }
  }

  /** 在运行态脚本或遥测修改前恢复当前阵列宿主；返回是否需要在修改后重提批次。 */
  private prepareModelArrayRuntimeMutation(model: ModelRuntimeEntry): boolean {
    if (!model.modelArrayBatch && model.modelArraySuspendedMeshes.size === 0) return false;
    const variant = [...this.modelArrayParameterVariants.values()].find((item) => item.model === model);
    if (variant) this.restoreModelArrayParameterVariantHost(variant);
    this.restoreModelArrayHostMeshes(model);
    model.root.setEnabled(true);
    return true;
  }

  /**
   * 运行态脚本/遥测可能改变 Transform、显隐、材质或增删 Mesh；重新收集宿主并更新当前参数组，
   * Geometry/网格集合未变时仅改写矩阵和材质，不重复创建批次。
   */
  private refreshModelArrayRuntimeRepresentation(model: ModelRuntimeEntry): void {
    if (!model.modelArrayBatch && model.modelArraySuspendedMeshes.size === 0) return;
    const variant = [...this.modelArrayParameterVariants.values()].find((item) => item.model === model);
    if (variant) {
      const activeVariant = this.modelArrayParameterVariants.get(variant.key);
      if (!activeVariant || activeVariant.model !== model) return;
      const representative = activeVariant.entities.find((entity) => entity.id === activeVariant.representativeEntityId)
        ?? activeVariant.entities[0];
      if (!representative) return;
      this.refreshModelMeshes(model, {
        modelArrayParameterVariant: true,
        modelArraySourceEntityId: activeVariant.sourceEntityId,
      });
      this.hideModelArrayParameterVariantHost(activeVariant);
      this.syncModelArrayBatchForEntities(representative, model, activeVariant.entities, [], {
        sourceEntityId: activeVariant.sourceEntityId,
        namePrefix: '__modelArrayParameterVariantThinInstance',
        variantKey: activeVariant.key,
        renderSignature: activeVariant.renderSignature,
        resolveLayerMask: (mesh) => activeVariant.sourceLayerMasks.get(mesh.uniqueId) ?? mesh.layerMask,
      });
      for (const entity of activeVariant.entities) this.onModelMeasurementChanged(entity.id);
      return;
    }

    const entity = model.entitySnapshot;
    const modelAsset = entity?.components.modelAsset;
    if (!entity || !modelAsset || entity.components.modelArrayInstance) return;
    this.refreshModelEntityMeshes(entity, model);
    const sourceRenderSignature = this.createModelArrayRenderSignature(
      modelAsset,
      entity.components.telemetryBinding,
    );
    const baseInstances = [...this.modelArrayInstanceEntities.values()].filter((instanceEntity) => {
      if (instanceEntity.components.modelArrayInstance?.sourceEntityId !== entity.id) return false;
      const instanceAsset = instanceEntity.components.modelAsset;
      return !instanceAsset || this.createModelArrayRenderSignature(
        instanceAsset,
        instanceEntity.components.telemetryBinding,
      ) === sourceRenderSignature;
    });
    this.syncModelArrayBatchForEntities(
      entity,
      model,
      [entity, ...baseInstances],
      entity.components.modelArray?.items ?? [],
      {
        sourceEntityId: entity.id,
        namePrefix: '__modelArrayThinInstance',
        renderSignature: sourceRenderSignature,
      },
    );
    this.onModelMeasurementChanged(entity.id);
    for (const instanceEntity of baseInstances) this.onModelMeasurementChanged(instanceEntity.id);
  }

  /** 判断当前批次是否已经承载给定视觉签名的完整 Geometry。 */
  private isModelArrayBatchCurrent(model: ModelRuntimeEntry, renderSignature: string): boolean {
    return Boolean(
      model.modelArrayBatch
      && model.modelArraySourceSignature.startsWith(`${renderSignature}|representation:original-geometry|`),
    );
  }

  /** 基础源和参数变体共用的矩阵批次提交路径。 */
  private syncModelArrayBatchForEntities(
    entity: Entity,
    model: ModelRuntimeEntry,
    instanceEntities: readonly Entity[],
    legacyItems: ReadonlyArray<NonNullable<Entity['components']['modelArray']>['items'][number]>,
    options: {
      sourceEntityId: string;
      namePrefix: string;
      renderSignature: string;
      variantKey?: string;
      resolveLayerMask?: (mesh: AbstractMesh) => number;
      parameterOnlyChangedEntityId?: string;
    },
  ): void {
    const totalInstanceCount = instanceEntities.length + legacyItems.length;
    if (totalInstanceCount === 0) {
      this.disposeModelArrayBatch(model);
      model.modelArrayFailureSignature = '';
      if (options.variantKey) this.suspendModelArrayHost(model);
      else this.applyModelInteractivity(model, entity.id);
      return;
    }
    if (!model.assetHandle || !model.measurementReady) return;

    const sourceMeshes = model.meshes.filter((mesh) => (
      !mesh.isDisposed() && mesh.getTotalVertices() > 0
    ));
    // 批次 Geometry 与脚本宿主隔离；参数或脚本输入变化时必须重建，才能复制最新顶点数据。
    const sourceSignature = `${options.renderSignature}|representation:original-geometry|${sourceMeshes
      .map((mesh) => `${mesh.uniqueId}:${mesh.geometry?.uniqueId ?? 0}:${mesh instanceof Mesh ? mesh.thinInstanceCount : 0}`)
      .join('|')}`;
    const failureSignature = `${options.variantKey ?? 'base'}:${sourceSignature}:${totalInstanceCount}`;

    if (sourceMeshes.length === 0) {
      if (model.modelArrayBatch) this.suspendModelArrayHost(model);
      else if (options.variantKey) this.suspendModelArrayHost(model);
      else this.applyModelInteractivity(model, entity.id);
      this.reportModelArrayBatchFailure(entity, model, failureSignature, '参数脚本执行后没有可渲染 Mesh，已保留上一份有效阵列');
      return;
    }

    const parameterOnlyChangedEntityId = options.parameterOnlyChangedEntityId;
    if (
      parameterOnlyChangedEntityId
      && model.modelArrayBatch
      && model.modelArraySourceSignature === sourceSignature
    ) {
      const shouldContainChangedEntity = instanceEntities.some((instance) => (
        instance.id === parameterOnlyChangedEntityId && this.isEntityVisible(instance.id)
      )) || (
        legacyItems.length > 0
        && entity.id === parameterOnlyChangedEntityId
        && this.isEntityVisible(entity.id)
      );
      if (model.modelArrayBatch.hasEntityId(parameterOnlyChangedEntityId) === shouldContainChangedEntity) {
        // 参数值变化未改变当前批次成员、Transform、显隐或拾取状态，复用既有 GPU 矩阵缓冲。
        model.modelArrayFailureSignature = '';
        this.suspendModelArrayHost(model);
        this.refreshGroupTransformPreviewTargets();
        return;
      }
    }

    const visibleInstances = instanceEntities
      .filter((instanceEntity) => this.isEntityVisible(instanceEntity.id))
      .map((instanceEntity) => ({
        entityId: instanceEntity.id,
        transform: instanceEntity.components.transform,
        pickable: this.isEntityScenePickable(instanceEntity.id),
      }));
    // 兼容尚未经过反序列化迁移的内存场景；旧隐藏项继续映射回源实体。
    for (const item of legacyItems) {
      if (!this.isEntityVisible(entity.id)) continue;
      visibleInstances.push({
        entityId: entity.id,
        transform: {
          ...entity.components.transform,
          position: {
            x: entity.components.transform.position.x + item.offset.x,
            y: entity.components.transform.position.y + item.offset.y,
            z: entity.components.transform.position.z + item.offset.z,
          },
        },
        pickable: this.isEntityScenePickable(entity.id),
      });
    }

    model.root.computeWorldMatrix(true);
    if (!model.modelArrayBatch || model.modelArraySourceSignature !== sourceSignature) {
      let candidate: EntityArrayThinInstanceBatch | null = null;
      try {
        candidate = EntityArrayThinInstanceBatch.create(options.sourceEntityId, sourceMeshes, {
          interactive: true,
          mergeStaticMeshesByMaterial: true,
          sourceRootWorldMatrix: model.root.getWorldMatrix().clone(),
          metadata: {
            modelArraySourceEntityId: options.sourceEntityId,
            ...(options.variantKey ? { modelArrayParameterVariant: true } : {}),
          },
          namePrefix: options.namePrefix,
          resolveLayerMask: options.resolveLayerMask,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.pushLog(`模型“${entity.name}”阵列批次创建失败：${message}`);
      }

      if (!candidate || !candidate.updateEntityTransforms(model.root.getWorldMatrix().clone(), visibleInstances)) {
        candidate?.dispose();
        if (model.modelArrayBatch) this.suspendModelArrayHost(model);
        else if (options.variantKey) this.suspendModelArrayHost(model);
        else this.applyModelInteractivity(model, entity.id);
        this.reportModelArrayBatchFailure(
          entity,
          model,
          failureSignature,
          candidate
            ? '矩阵数量超过保护上限、Transform 非法或参数脚本输出 Mesh 不支持批量实例，已保留上一份有效阵列'
            : '参数脚本输出 Mesh 不支持批量实例，已保留上一份有效阵列',
        );
        return;
      }

      const previousBatch = model.modelArrayBatch;
      model.modelArrayBatch = candidate;
      model.modelArraySourceSignature = sourceSignature;
      for (const mesh of candidate.meshes) this.modelArrayBatchByMeshUniqueId.set(mesh.uniqueId, candidate);
      if (previousBatch) this.disposeModelArrayBatchResources(previousBatch);
    } else if (!model.modelArrayBatch.updateEntityTransforms(model.root.getWorldMatrix().clone(), visibleInstances)) {
      this.suspendModelArrayHost(model);
      this.reportModelArrayBatchFailure(
        entity,
        model,
        failureSignature,
        '矩阵数量超过保护上限、Transform 非法或参数脚本输出 Mesh 不支持批量实例，已保留上一份有效阵列',
      );
      return;
    }

    for (const mesh of model.modelArrayBatch.meshes) {
      this.modelArrayBatchByMeshUniqueId.set(mesh.uniqueId, model.modelArrayBatch);
    }
    model.modelArrayFailureSignature = '';
    this.suspendModelArrayHost(model);
    this.refreshGroupTransformPreviewTargets();
  }

  private disposeMissingModelArrayParameterVariants(sourceEntityId: string, activeKeys: ReadonlySet<string>): void {
    for (const variant of [...this.modelArrayParameterVariants.values()]) {
      if (variant.sourceEntityId === sourceEntityId && !activeKeys.has(variant.key)) {
        this.disposeModelArrayParameterVariant(variant);
      }
    }
  }

  private disposeModelArrayParameterVariantsForSource(sourceEntityId: string): void {
    for (const variant of [...this.modelArrayParameterVariants.values()]) {
      if (variant.sourceEntityId === sourceEntityId) this.disposeModelArrayParameterVariant(variant);
    }
  }

  private disposeModelArrayParameterVariant(variant: ModelArrayParameterVariantRuntimeEntry): void {
    if (this.modelArrayParameterVariants.get(variant.key) !== variant) return;
    this.modelArrayParameterVariants.delete(variant.key);
    for (const entity of variant.entities) {
      if (this.modelArrayParameterVariantByEntityId.get(entity.id) === variant) {
        this.modelArrayParameterVariantByEntityId.delete(entity.id);
      }
    }

    const model = variant.model;
    this.endModelArrayParameterVariantRenderSuppression(variant);
    model.cancelLoad?.();
    model.cancelLoad = null;
    this.restoreModelArrayParameterVariantHost(variant);
    this.restoreModelArrayHostMeshes(model);
    model.root.setEnabled(true);
    model.externalScriptRuntime?.dispose();
    model.externalScriptRuntime = null;
    for (const texture of model.textureCache.values()) texture.dispose();
    model.textureCache.clear();
    this.disposeModelArrayBatch(model);
    model.assetHandle?.dispose();
    model.assetHandle = null;
    model.contentRoot.dispose();
    model.root.dispose();
    model.modelArraySuspendedMeshes.clear();
    for (const entity of variant.entities) this.onModelMeasurementChanged(entity.id);
  }

  /** 同一失败形态只记录一次，避免场景同步循环刷屏。 */
  private reportModelArrayBatchFailure(
    entity: Entity,
    model: ModelRuntimeEntry,
    failureSignature: string,
    reason: string,
  ): void {
    if (model.modelArrayFailureSignature === failureSignature) return;
    model.modelArrayFailureSignature = failureSignature;
    this.pushLog(`模型“${entity.name}”矩阵阵列创建失败：${reason}。`);
  }

  /** 释放一个正式矩阵阵列批次的隔离 Geometry，但保留源模型几何、材质和纹理。 */
  private disposeModelArrayBatchResources(modelArrayBatch: EntityArrayThinInstanceBatch): void {
    this.outlinedModelArrayBatches.delete(modelArrayBatch);
    for (const mesh of modelArrayBatch.meshes) {
      this.modelArrayBatchByMeshUniqueId.delete(mesh.uniqueId);
    }
    modelArrayBatch.dispose();
  }

  private disposeModelArrayBatch(model: ModelRuntimeEntry): void {
    if (!model.modelArrayBatch) {
      model.modelArraySourceSignature = '';
      return;
    }

    const modelArrayBatch = model.modelArrayBatch;
    model.modelArrayBatch = null;
    model.modelArraySourceSignature = '';
    this.disposeModelArrayBatchResources(modelArrayBatch);
    this.refreshGroupTransformPreviewTargets();
  }

  /** 同步模型资产脚本生命周期，普通模型和生成模型共享同一份受控实现。 */
  private syncModelAssetExternalScripts(
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
    onSettled: (current: ModelRuntimeEntry) => void,
  ): void {
    if (!model.assetHandle) return;
    // 阵列会把脚本宿主 Mesh 移出 scene.meshes；生命周期执行前临时恢复，兼容按场景列表查找部件的模型包。
    // 参数/脚本更新的最终批次统一由 onSettled 原子提交；上下文注入阶段只恢复宿主，不得提前缩减旧批次覆盖。
    // 异步 start 完成前保持根节点启用，避免旧脚本把 enabled=false 捕获为参数基线。
    const hadArrayHost = Boolean(model.modelArrayBatch) || model.modelArraySuspendedMeshes.size > 0;
    this.restoreModelArrayHostMeshes(model);
    if (hadArrayHost) {
      model.root.setEnabled(true);
      this.beginModelArrayHostRenderSuppression(model);
    }
    this.syncModelScriptMetadata(model.contentRoot, modelAsset);
    const settle = (current: ModelRuntimeEntry): void => {
      try {
        onSettled(current);
      } finally {
        this.endModelArrayHostRenderSuppression(current);
      }
    };

    const scriptAssets = modelAsset.scriptAssets ?? [];
    if (scriptAssets.length === 0) {
      model.externalScriptRuntime?.dispose();
      model.externalScriptRuntime = null;
      model.externalScriptSignature = '';
      model.externalScriptStarting = false;
      model.measurementReady = true;
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
      model.stackerTelemetryReady = true;
      settle(model);
      return;
    }

    const signature = JSON.stringify({
      assetRevision: modelAsset.assetRevision ?? null,
      scripts: scriptAssets.map((scriptAsset) => ({
        path: scriptAsset.path,
        sourceUrl: scriptAsset.sourceUrl,
        name: scriptAsset.name,
      })),
      parameterScripts: modelAsset.parameterScriptMetadata ?? [],
      animationScripts: modelAsset.animationScriptMetadata ?? [],
    });

    const runtimeMode = this.telemetryPreviewActive ? 'runtime' : 'edit';
    if (!model.externalScriptRuntime || model.externalScriptSignature !== signature) {
      model.externalScriptStarting = true;
      model.measurementReady = false;
      model.stackerTelemetryReady = false;
      model.externalScriptRuntime?.dispose();
      model.externalScriptRuntime = new ExternalModelScriptRuntime(model.contentRoot, modelAsset);
      model.externalScriptSignature = signature;
      this.updateModelExternalScriptRuntimeContext(model, runtimeMode, null, true);
      model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
      model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);

      const runtime = model.externalScriptRuntime;
      const loadToken = model.loadToken;
      void runtime.start()
        .then(() => {
          const current = this.findActiveModelRuntimeEntry(runtime);
          if (!current || current.loadToken !== loadToken) return;
          this.updateModelExternalScriptRuntimeContext(current, this.telemetryPreviewActive ? 'runtime' : 'edit', null, true);
          runtime.update();
          resetStackerTelemetryState(current);
          resetConveyorTelemetryState(current);
          resetRgvTelemetryState(current);
          current.externalScriptStarting = false;
          current.measurementReady = true;
          current.stackerTelemetryReady = true;
          settle(current);
        })
        .catch((error) => {
          const current = this.findActiveModelRuntimeEntry(runtime);
          if (!current || current.loadToken !== loadToken) return;
          current.externalScriptStarting = false;
          current.measurementReady = true;
          resetStackerTelemetryState(current);
          resetConveyorTelemetryState(current);
          resetRgvTelemetryState(current);
          current.stackerTelemetryReady = true;
          const message = error instanceof Error ? error.message : String(error);
          this.pushLog(`模型脚本初始化失败，已回退基础几何与测量：${message}`);
          settle(current);
        });
      return;
    }

    model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
    model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);
    this.updateModelExternalScriptRuntimeContext(model, runtimeMode, null, true);
    if (model.externalScriptStarting) return;

    model.externalScriptRuntime.update();
    resetStackerTelemetryState(model);
    resetConveyorTelemetryState(model);
    resetRgvTelemetryState(model);
    model.measurementReady = true;
    model.stackerTelemetryReady = true;
    settle(model);
  }

  /** 在普通模型和生成器派生模型中查找仍处于活动状态的脚本宿主。 */
  private findActiveModelRuntimeEntry(runtime: ExternalModelScriptRuntime): ModelRuntimeEntry | null {
    for (const model of this.models.values()) {
      if (model.externalScriptRuntime === runtime) return model;
    }
    for (const variant of this.modelArrayParameterVariants.values()) {
      if (variant.model.externalScriptRuntime === runtime) return variant.model;
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind === 'model' && owner.output.model.externalScriptRuntime === runtime) {
        return owner.output.model;
      }
    }
    return null;
  }

  /** 把实例资产编号和 meta.json 脚本参数写回 Babylon 节点 metadata，供运行时和动画识别读取。 */
  private syncModelScriptMetadata(target: TransformNode, modelAsset: ModelAssetComponent): void {
    const scripts = (modelAsset.parameterScriptMetadata ?? []).map((script) => {
      const clonedScript = this.cloneJsonValue(script);
      if (!isPlainRecord(clonedScript)) return clonedScript;

      const values = isPlainRecord(clonedScript.values) ? { ...clonedScript.values } : {};
      for (const [key, value] of Object.entries(modelAsset.parameterValues ?? {})) {
        const previousValue = isPlainRecord(values[key]) ? values[key] : {};
        values[key] = { ...previousValue, value };
      }
      clonedScript.values = values;
      return clonedScript;
    });

    const previousMetadata = target.metadata ?? {};
    const previousModelAssetMetadata = isPlainRecord(previousMetadata.modelAsset)
      ? previousMetadata.modelAsset
      : {};

    target.metadata = {
      ...previousMetadata,
      assetCode: modelAsset.assetCode,
      modelAsset: {
        ...previousModelAssetMetadata,
        assetCode: modelAsset.assetCode,
      },
      scripts,
    };
  }

  /** 克隆可序列化脚本元数据，避免运行时改动污染场景文档。 */
  private cloneJsonValue(value: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      return value;
    }
  }

  private applyModelParameterBinding(
    binding: ModelParameterBinding,
    values: ModelParameterValues,
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
  ): void {
    const value = this.evaluateModelExpression(binding.value, values);
    if (value === null) return;

    const targets = this.resolveModelParameterTargets(binding, model);
    for (const target of targets) {
      this.applyModelParameterValueToTarget(target, binding.property, value, modelAsset, model);
    }
  }

  private resolveModelParameterTargets(binding: ModelParameterBinding, model: ModelRuntimeEntry): ModelParameterRuntimeTarget[] {
    if (binding.target.kind === 'material') {
      const materials = new Map<string, Material>();
      for (const mesh of model.meshes) {
        if (mesh.material?.name === binding.target.name) materials.set(mesh.material.uniqueId.toString(), mesh.material);
      }
      return [...materials.values()];
    }

    if (binding.target.kind === 'mesh') {
      return model.meshes.filter((mesh) => mesh.name === binding.target.name);
    }

    return model.root.getChildTransformNodes(false).filter((node) => node.name === binding.target.name);
  }

  private getModelParameterBaselineKey(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
  ): string {
    return `${target.uniqueId}:${property}`;
  }

  private rememberModelParameterBaseline(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
    model: ModelRuntimeEntry,
  ): void {
    const key = this.getModelParameterBaselineKey(target, property);
    if (model.parameterBaseline.has(key)) return;

    if (property === 'visible') {
      if (target instanceof AbstractMesh) {
        model.parameterBaseline.set(key, target.isVisible);
        return;
      }

      if (target instanceof TransformNode) {
        model.parameterBaseline.set(key, target.isEnabled());
      }
      return;
    }

    if ((property === 'position' || property === 'rotation' || property === 'scaling') && target instanceof TransformNode) {
      const vector = target[property];
      model.parameterBaseline.set(key, { x: vector.x, y: vector.y, z: vector.z });
      return;
    }

    if ((property === 'baseColor' || property === 'emissiveColor') && target instanceof Material) {
      const color = this.readMaterialColor(target, property);
      model.parameterBaseline.set(key, color);
      return;
    }

    if (property === 'alpha' && target instanceof Material) {
      model.parameterBaseline.set(key, target.alpha);
      return;
    }

    if (property === 'baseTexture' && target instanceof Material) {
      model.parameterBaseline.set(key, this.readMaterialTexture(target));
    }
  }

  private resetModelParameterTargets(model: ModelRuntimeEntry): void {
    for (const [key, value] of model.parameterBaseline.entries()) {
      const [uniqueIdText, property] = key.split(':') as [string, ModelParameterBinding['property']];
      const target = this.findModelParameterTargetByUniqueId(model, Number(uniqueIdText));
      if (!target) continue;

      this.restoreModelParameterBaseline(target, property, value);
    }
  }

  private findModelParameterTargetByUniqueId(model: ModelRuntimeEntry, uniqueId: number): ModelParameterRuntimeTarget | null {
    for (const mesh of model.meshes) {
      if (mesh.uniqueId === uniqueId) return mesh;
      if (mesh.material?.uniqueId === uniqueId) return mesh.material;
    }

    for (const node of model.root.getChildTransformNodes(false)) {
      if (node.uniqueId === uniqueId) return node;
    }

    return null;
  }

  private restoreModelParameterBaseline(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
    value: ModelParameterBaselineValue,
  ): void {
    if (property === 'visible' && typeof value === 'boolean') {
      if (target instanceof AbstractMesh) target.isVisible = value;
      if (target instanceof TransformNode) target.setEnabled(value);
      return;
    }

    if ((property === 'position' || property === 'rotation' || property === 'scaling') && this.isVector3Value(value) && target instanceof TransformNode) {
      target[property] = new Vector3(value.x, value.y, value.z);
      return;
    }

    if ((property === 'baseColor' || property === 'emissiveColor') && typeof value === 'string' && target instanceof Material) {
      this.applyMaterialColor(target, property, value);
      return;
    }

    if (property === 'alpha' && typeof value === 'number' && target instanceof Material) {
      target.alpha = value;
      return;
    }

    if (property === 'baseTexture' && target instanceof Material) {
      this.applyMaterialTexture(target, value instanceof Texture ? value : null);
    }
  }

  private applyModelParameterValueToTarget(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
    value: ModelParameterValue,
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
  ): void {
    this.rememberModelParameterBaseline(target, property, model);

    if (property === 'visible') {
      if (typeof value !== 'boolean') return;
      if (target instanceof AbstractMesh) target.isVisible = value;
      if (target instanceof TransformNode) target.setEnabled(value);
      return;
    }

    if (property === 'position' || property === 'rotation' || property === 'scaling') {
      if (!this.isVector3Value(value) || !(target instanceof TransformNode)) return;
      target[property] = new Vector3(value.x, value.y, value.z);
      return;
    }

    if (property === 'baseColor' || property === 'emissiveColor') {
      if (typeof value !== 'string' || !(target instanceof Material)) return;
      this.applyMaterialColor(target, property, value);
      return;
    }

    if (property === 'alpha') {
      if (typeof value !== 'number' || !(target instanceof Material)) return;
      target.alpha = Math.min(1, Math.max(0, value));
      return;
    }

    if (property === 'baseTexture') {
      if (typeof value !== 'string' || !(target instanceof Material)) return;
      const texture = this.loadOrReuseTexture(value, modelAsset, model);
      if (texture) this.applyMaterialTexture(target, texture);
    }
  }

  private evaluateBooleanExpression(expression: ModelExpression, values: ModelParameterValues): boolean {
    return this.evaluateModelExpression(expression, values) === true;
  }

  private evaluateModelExpression(expression: ModelExpression, values: ModelParameterValues): ModelParameterValue | null {
    if (typeof expression === 'number') return Number.isFinite(expression) ? expression : null;
    if (typeof expression === 'string' || typeof expression === 'boolean') return expression;
    if (this.isVector3Value(expression)) return expression;

    if ('param' in expression) {
      return values[expression.param] ?? null;
    }

    if ('vector3' in expression) {
      const [x, y, z] = expression.vector3.map((item) => this.evaluateModelExpression(item, values));
      return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? { x, y, z } : null;
    }

    const args = expression.args.map((item) => this.evaluateModelExpression(item, values));
    const numbers = args.filter((arg): arg is number => typeof arg === 'number' && Number.isFinite(arg));

    switch (expression.op) {
      case 'add': return numbers.reduce((sum, value) => sum + value, 0);
      case 'sub': return numbers.length >= 2 ? numbers.slice(1).reduce((result, value) => result - value, numbers[0]) : null;
      case 'mul': return numbers.reduce((result, value) => result * value, 1);
      case 'div': return numbers.length === 2 && numbers[1] !== 0 ? numbers[0] / numbers[1] : null;
      case 'min': return numbers.length > 0 ? Math.min(...numbers) : null;
      case 'max': return numbers.length > 0 ? Math.max(...numbers) : null;
      case 'clamp': return numbers.length === 3 ? Math.min(numbers[2], Math.max(numbers[1], numbers[0])) : null;
      case 'lerp': return numbers.length === 3 ? numbers[0] + (numbers[1] - numbers[0]) * numbers[2] : null;
      case 'eq': return args[0] === args[1];
      case 'neq': return args[0] !== args[1];
      case 'gt': return numbers.length === 2 ? numbers[0] > numbers[1] : false;
      case 'gte': return numbers.length === 2 ? numbers[0] >= numbers[1] : false;
      case 'lt': return numbers.length === 2 ? numbers[0] < numbers[1] : false;
      case 'lte': return numbers.length === 2 ? numbers[0] <= numbers[1] : false;
      case 'and': return args.every(Boolean);
      case 'or': return args.some(Boolean);
      case 'not': return !args[0];
      case 'if': return args[0] ? args[1] ?? null : args[2] ?? null;
      default: return null;
    }
  }

  private isVector3Value(value: unknown): value is Vector3Data {
    return (
      typeof value === 'object' &&
      value !== null &&
      'x' in value &&
      'y' in value &&
      'z' in value &&
      typeof value.x === 'number' &&
      Number.isFinite(value.x) &&
      typeof value.y === 'number' &&
      Number.isFinite(value.y) &&
      typeof value.z === 'number' &&
      Number.isFinite(value.z)
    );
  }

  /** 判断值是否为普通对象，用于安全处理模型脚本 JSON 元数据。 */

  private applyMaterialColor(material: Material, property: 'baseColor' | 'emissiveColor', value: string): void {
    const color = this.readColor(value);
    if (material instanceof StandardMaterial) {
      if (property === 'baseColor') material.diffuseColor = color;
      if (property === 'emissiveColor') material.emissiveColor = color;
      return;
    }

    if (material instanceof PBRMaterial) {
      if (property === 'baseColor') material.albedoColor = color;
      if (property === 'emissiveColor') material.emissiveColor = color;
    }
  }

  private readMaterialColor(material: Material, property: 'baseColor' | 'emissiveColor'): string | null {
    if (material instanceof StandardMaterial) {
      const color = property === 'baseColor' ? material.diffuseColor : material.emissiveColor;
      return color.toHexString();
    }

    if (material instanceof PBRMaterial) {
      const color = property === 'baseColor' ? material.albedoColor : material.emissiveColor;
      return color.toHexString();
    }

    return null;
  }

  private applyMaterialTexture(material: Material, texture: Texture | null): void {
    if (material instanceof StandardMaterial) {
      material.diffuseTexture = texture;
      return;
    }

    if (material instanceof PBRMaterial) {
      material.albedoTexture = texture;
    }
  }

  private readMaterialTexture(material: Material): Texture | null {
    if (material instanceof StandardMaterial) {
      return material.diffuseTexture instanceof Texture ? material.diffuseTexture : null;
    }

    if (material instanceof PBRMaterial) {
      return material.albedoTexture instanceof Texture ? material.albedoTexture : null;
    }

    return null;
  }

  /** 使用共享贴图解析器加载或复用 Babylon 纹理，保证材质绑定和外置脚本参数语义一致。 */
  private loadOrReuseTexture(reference: string, modelAsset: ModelAssetComponent, model: ModelRuntimeEntry): Texture | null {
    const textureUrl = resolveModelTextureAssetUrl(reference, {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision,
    });
    if (!textureUrl) return null;

    const existing = model.textureCache.get(textureUrl);
    if (existing) return existing;

    const texture = new Texture(textureUrl, this.scene);
    model.textureCache.set(textureUrl, texture);
    return texture;
  }

  /** 用模型源 URL、导入版本和实例化策略生成加载签名，同路径覆盖或策略变化时都能重新载入。 */
  private createModelAssetSignature(modelAsset: ModelAssetComponent): string {
    return JSON.stringify({
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      lengthUnit: modelAsset.lengthUnit,
      unitScaleToMeters: modelAsset.unitScaleToMeters,
      instancingMode: resolveModelAssetSharedInstancingPolicy(modelAsset).mode,
    });
  }

  /** 给运行时资源 URL 追加导入版本参数，绕开浏览器和 Electron 对同路径资源的缓存。 */
  private resolveVersionedRuntimeAssetUrl(sourceUrl: string, assetRevision: string | undefined | null): string {
    const runtimeUrl = resolveRuntimeAssetUrl(sourceUrl);
    if (!assetRevision) return runtimeUrl;

    const separator = runtimeUrl.includes('?') ? '&' : '?';
    return `${runtimeUrl}${separator}assetRevision=${encodeURIComponent(assetRevision)}`;
  }

  /** 记录模型选中状态；普通模型、共享实例和矩阵阵列统一由场景选择高亮层描边。 */
  private applyModelSelection(model: ModelRuntimeEntry, selected: boolean): void {
    model.highlighted = selected;
  }

  /** 根据逻辑实体直接定位所属矩阵批次，避免选择变化扫描全部源模型和参数变体。 */
  private resolveModelArrayBatchForEntityId(entityId: string): EntityArrayThinInstanceBatch | null {
    const parameterVariant = this.modelArrayParameterVariantByEntityId.get(entityId);
    if (parameterVariant?.model.modelArrayBatch) return parameterVariant.model.modelArrayBatch;

    const sourceBatch = this.models.get(entityId)?.modelArrayBatch;
    if (sourceBatch) return sourceBatch;

    const instanceEntity = this.modelArrayInstanceEntities.get(entityId);
    const sourceEntityId = instanceEntity?.components.modelArrayInstance?.sourceEntityId;
    return sourceEntityId ? this.models.get(sourceEntityId)?.modelArrayBatch ?? null : null;
  }

  /**
   * 只从当前选区推导基础 Mesh、普通模型、共享实例和矩阵阵列描边。普通单选为 O(1)，文件夹整组选中为 O(selected)，
   * 不再展开全部可见实体 ID 或拼接全场景 signature；批次内部再按差量刷新实例选择缓冲。
   */
  private rebuildModelSelectionOutline(): void {
    const selectedModelGroups: AbstractMesh[][] = [];
    const selectedArrayEntityIdsByBatch = new Map<EntityArrayThinInstanceBatch, Set<string>>();
    const highlightedEntityIds = mergeSceneRuntimeHighlightEntityIds(
      this.selectedEntityIds,
      this.localHighlightedEntityIds,
      this.externalHighlightedEntityIds,
    );

    for (const entityId of highlightedEntityIds) {
      const primitiveMesh = this.meshes.get(entityId);
      if (primitiveMesh && !primitiveMesh.isDisposed() && primitiveMesh.getTotalVertices() > 0) {
        selectedModelGroups.push([primitiveMesh]);
      }

      const model = this.models.get(entityId);
      if (model && !model.modelArrayBatch && model.highlighted) {
        const meshes = model.meshes.filter((mesh) => !mesh.isDisposed() && mesh.getTotalVertices() > 0);
        if (meshes.length > 0) selectedModelGroups.push(meshes);
      }

      const batch = this.resolveModelArrayBatchForEntityId(entityId);
      if (!batch) continue;
      const selectedEntityIds = selectedArrayEntityIdsByBatch.get(batch) ?? new Set<string>();
      selectedEntityIds.add(entityId);
      selectedArrayEntityIdsByBatch.set(batch, selectedEntityIds);
    }

    for (const previousBatch of this.outlinedModelArrayBatches) {
      if (selectedArrayEntityIdsByBatch.has(previousBatch)) continue;
      if (previousBatch.meshes.some((mesh) => !mesh.isDisposed())) {
        previousBatch.setSelectionMask(new Set(), 0);
      }
    }

    // 先写入批次维护的权威选择缓冲，再把当前活动的原模型 Mesh 交给场景选择高亮层。
    // 这样只高亮目标逻辑实体，不会因共享 Geometry 或 thinInstance 批次而整类高亮。
    let nextArraySelectionId = selectedModelGroups.length + 1;
    const selectedArrayGroups = [...selectedArrayEntityIdsByBatch.entries()]
      .map(([batch, selectedEntityIds]) => {
        const selectionId = nextArraySelectionId;
        nextArraySelectionId += 1;
        batch.setSelectionMask(selectedEntityIds, selectionId);
        const meshes = batch.meshes.filter((mesh) => (
          !mesh.isDisposed() && mesh.thinInstanceCount > 0 && mesh.getTotalVertices() > 0
        ));
        return meshes.length > 0 ? { batch, meshes, selectedEntityIds, selectionId } : null;
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);
    const nextOutlinedModelArrayBatches = new Set(selectedArrayGroups.map((group) => group.batch));

    const selectedGlowGroups = [
      ...selectedModelGroups,
      ...selectedArrayGroups.map((group) => group.meshes),
    ];
    if (selectedGlowGroups.length === 0) {
      // 选择效果会为遮挡正确的描边延迟启用全场景 DepthRenderer；空选区必须主动释放。
      clearSceneSelectionHighlight(this.modelSelectionOutlineLayer, this.scene);
      this.outlinedModelArrayBatches = nextOutlinedModelArrayBatches;
      return;
    }

    prepareInstancedMeshesForSelectionOutline(selectedGlowGroups.flat());
    setSceneSelectionHighlightGroups(this.modelSelectionOutlineLayer, selectedGlowGroups);

    for (const group of selectedArrayGroups) {
      // addSelection() 会临时把整个 thinInstance 批次改为选中；再次绑定权威缓冲只保留目标实体。
      group.batch.setSelectionMask(group.selectedEntityIds, group.selectionId);
    }

    this.outlinedModelArrayBatches = nextOutlinedModelArrayBatches;
  }


  /** 仅把 glTF 顶层节点挂到模型内容节点，保留模型内部层级、骨骼和动画关系。 */
  private parentTopLevelModelNodes(model: ModelRuntimeEntry, transformNodes: TransformNode[]): void {
    const allImportedNodes = new Set([...model.meshes, ...transformNodes]);

    for (const node of allImportedNodes) {
      if (!node.parent || !allImportedNodes.has(node.parent as AbstractMesh | TransformNode)) {
        node.parent = model.contentRoot;
      }
    }
  }

  /** 将导入模型内容的底部中心归一到实体根节点，避免源模型巨大坐标偏移影响场景放置。 */
  private normalizeModelContentOrigin(model: ModelRuntimeEntry): void {
    model.root.computeWorldMatrix(true);

    // 只测量模型自身内容：绑定货格等外来子节点可能在异步加载完成前就挂到 root 下，
    // 参与测量会把归一化原点带偏（粘贴含内置货格的货架时原点跑到整排中点）。
    const childMeshes = model.contentRoot.getChildMeshes(false).filter(isMeasurableModelMesh);
    if (childMeshes.length === 0) return;

    const bottomCenter = getMeshesWorldBottomCenter(childMeshes);
    if (!bottomCenter) return;

    const inverseRootMatrix = model.root.getWorldMatrix().clone().invert();
    const localBottomCenter = Vector3.TransformCoordinates(bottomCenter, inverseRootMatrix);

    for (const child of model.root.getChildren()) {
      if (child instanceof TransformNode) {
        child.position.subtractInPlace(localBottomCenter);
      }
    }
  }

  /** 通过统一并发调度器加载 Babylon 资产容器，限制批量模型解析和 GPU 上传峰值。 */
  private loadAssetContainer(
    rootUrl: string,
    fileName: string,
    loadSignal?: AbortSignal,
    onProgress?: (event: ISceneLoaderProgressEvent) => void,
  ): Promise<AssetContainer> {
    return this.assetLoadScheduler.run(
      () => SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.scene, onProgress),
      loadSignal,
    );
  }

  /** 把完整资源 URL 拆成 Babylon SceneLoader 需要的 rootUrl 和 fileName。 */
  private splitAssetUrl(sourceUrl: string): { rootUrl: string; fileName: string } {
    const lastSlashIndex = sourceUrl.lastIndexOf('/');
    if (lastSlashIndex < 0) {
      return { rootUrl: '', fileName: sourceUrl };
    }

    return {
      rootUrl: sourceUrl.slice(0, lastSlashIndex + 1),
      fileName: sourceUrl.slice(lastSlashIndex + 1),
    };
  }

  /** 从 Transform 位置生成向量，零向量时回退到默认值。 */
  private vectorFromTransformPosition(transform: TransformComponent, fallback: Vector3): Vector3 {
    const vector = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    return vector.lengthSquared() > 0 ? vector : fallback;
  }

  /** 使用实体旋转估算 DirectionalLight 方向。 */
  private directionFromRotation(transform: TransformComponent): Vector3 {
    const direction = new Vector3(0, -1, 0);
    const matrix = Matrix.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z);
    return Vector3.TransformNormal(direction, matrix).normalize();
  }

  /** 判断已存在灯光是否仍匹配组件要求的灯光类型。 */
  private isLightKind(light: Light, lightKind: LightComponent['lightKind']): boolean {
    return (
      (lightKind === 'hemispheric' && light instanceof HemisphericLight) ||
      (lightKind === 'directional' && light instanceof DirectionalLight) ||
      (lightKind === 'point' && light instanceof PointLight)
    );
  }
}
