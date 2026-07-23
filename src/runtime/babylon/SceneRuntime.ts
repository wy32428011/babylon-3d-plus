import '@babylonjs/loaders';
import {
  AbstractMesh,
  type AnimationGroup,
  AssetContainer,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  HighlightLayer,
  InstancedMesh,
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
  SelectionOutlineLayer,
  StandardMaterial,
  Texture,
  TransformNode,
  type Node,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type {
  CadReferenceComponent,
  LightComponent,
  LocatorComponent,
  LocatorStorageDepth,
  MeshKind,
  MeshRendererComponent,
  ModelAssetComponent,
  ModelGeneratorBinding,
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
import { MODEL_ARRAY_COPY_COUNT_MAX, MODEL_ARRAY_MIN_SPAN_METERS } from '../../editor/model/modelArray';
import { createModelAssetCode, type SceneDocument, type SceneEnvironmentSettings } from '../../editor/model/SceneDocument';
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
import {
  calculateEnvironmentOriginLeftOffset,
  ENVIRONMENT_FALLBACK_LEFT_OFFSET_METERS,
} from './environmentPlacement';
import {
  isMeasurableModelMesh,
  measureModelSizeMeters,
  measureEntityMeshesSpanMetersAlongWorldDirection,
  type ModelMeasurementResult,
} from './modelMeasurement';
import { resolveModelTextureAssetUrl } from '../assets/modelTextureAssetUrl';
import { GenericTelemetryMotionRuntime } from './telemetry/GenericTelemetryMotionRuntime';
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
import { resolveLocatorBoxIndex, resolveStackerStorageForkReach, resolveStackerStorageTargetOffsets, type StackerStorageTargetOffsets } from './telemetry/stackerStorageLocation';
import {
  WarehouseFlowCoordinator,
  type WarehouseConveyorFrame,
  type WarehouseInboundState,
  type WarehouseOutboundState,
  type WarehouseStackerFrame,
} from './warehouse/WarehouseFlowCoordinator';
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
import { ModelGeneratorFetchRuntime } from './ModelGeneratorFetchRuntime';

const SELECTED_MATERIAL_COLOR = '#f7d774';
const SELECTED_EMISSIVE_COLOR = '#332400';
const FALLBACK_MATERIAL_COLOR = '#8ab4f8';
const LOCATOR_EDGE_COLOR = '#19c7d4';
const MODEL_GENERATOR_MARKER_COLOR = '#19c7d4';
const MODEL_GENERATOR_MARKER_ALPHA = 0.65;
const LOCATOR_SURFACE_ALPHA = 0.025;
const SELECTED_LOCATOR_SURFACE_ALPHA = 0.08;
const EDITOR_ENTITY_ID_METADATA_KEY = 'editorEntityId';
const STACKER_CALIBRATION_RATE = 4;
const STACKER_TARGET_SPEED_METERS_PER_SECOND = 1.2;
const STACKER_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND = 0.8;
const STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND = 0.3;
const STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND = 0.25;
const STACKER_RPM_TO_METERS_PER_SECOND = 0.01;
const STACKER_CARGO_COLOR = '#d8a03a';
const STACKER_CARGO_EMISSIVE_COLOR = '#3a2508';
const STACKER_CARGO_SIZE = new Vector3(0.8, 0.42, 0.8);
const CONVEYOR_CARGO_COLOR = '#4fa3d8';
const CONVEYOR_CARGO_EMISSIVE_COLOR = '#09283a';
const CONVEYOR_CARGO_SIZE = new Vector3(0.72, 0.34, 0.72);
const CONVEYOR_ANONYMOUS_CARGO_CODE = '__anonymous__';
const CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS = 1.2;
const CONVEYOR_DEFAULT_ROTATE_SPEED_DEGREES_PER_SECOND = 180;
const CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND = 0.3;
const STACKER_FALLBACK_FIXED_NODE_NAMES = ['guidaoshang.1', 'guidaoxia.2'];
const STACKER_FALLBACK_TRAVEL_NODE_NAMES = [
  'dingbuhuagui2.3',
  'dingbuhuagui1.4',
  'dingbu.5',
  'dibu.6',
  'lizhu1.11',
  'lizhu2.12',
  'dianji.7',
  'caozuotai.8',
  'xiang.13',
  'huocha.9',
  'huocha2.10',
];

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
type EntityArrayPreviewStrategy = 'clone-hierarchy' | 'poi-static';

type EntityArrayPreviewSource = {
  kind: EntityArrayPreviewKind;
  root: TransformNode;
  geometryMeshes: readonly AbstractMesh[];
  previewMeshes: readonly AbstractMesh[];
  geometryReady: boolean;
  strategy: EntityArrayPreviewStrategy;
};

type EntityArrayPreviewEntry = {
  sourceEntityId: string;
  sourceRoot: TransformNode;
  sourceKind: EntityArrayPreviewKind;
  clones: TransformNode[];
  poiBoundsMaterial: StandardMaterial | null;
  placementSignature: string;
};

type ModelRuntimeEntry = {
  sourceUrl: string;
  assetRevision: string | null;
  assetSignature: string;
  assetCode: string;
  telemetryBinding: TelemetryBindingComponent | null;
  stackerCapable: boolean;
  conveyorCapable: boolean;
  root: TransformNode;
  contentRoot: TransformNode;
  assetHandle: ModelRuntimeAssetHandle | null;
  meshes: AbstractMesh[];
  highlighted: boolean;
  highlightedMeshes: Set<Mesh>;
  loadToken: number;
  parameterSignature: string;
  parameterBaseline: Map<string, ModelParameterBaselineValue>;
  textureCache: Map<string, Texture>;
  externalScriptRuntime: ExternalModelScriptRuntime | null;
  externalScriptSignature: string;
  externalScriptStarting: boolean;
  measurementReady: boolean;
  stackerTelemetry: StackerModelTelemetryState;
  conveyorTelemetry: ConveyorModelTelemetryState;
  stackerTelemetryReady: boolean;
  telemetryPreviewBaseline: ModelTelemetryPreviewBaseline | null;
};

type SpecializedTelemetryRuntimeEntry = {
  entityId: string;
  model: ModelRuntimeEntry;
  binding: ResolvedSpecializedTelemetryBinding;
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
type GeneratedOutputOwnerRuntimeEntry = {
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

/** 已从生成器脱离并由仓储流独立管理的货物实例。 */
type WarehouseCargoRuntimeEntry = {
  cargoCode: string;
  locatorKey: string;
  root: TransformNode;
  output: ModelGeneratorOutputRuntimeEntry;
};

/** 仓储流三设备的完整绑定集合。 */
type ResolvedWarehouseFlowBindings = {
  inbound: ModelGeneratorBinding;
  stacker: ModelGeneratorBinding;
  outbound: ModelGeneratorBinding;
};

/** 输送机入/出料与 MQTT 前/后端的世界锚点和当前平台朝向。 */
type WarehouseConveyorAnchors = {
  infeed: Vector3;
  outfeed: Vector3;
  mqttFront: Vector3 | null;
  mqttBack: Vector3 | null;
  hasExplicitMqttEndpoints: boolean;
  spanMeters: number;
  rotation: Quaternion;
};

/** YZJ 模型局部方向参数；MQTT 前后端缺失时继续兼容旧入/出料路径。 */
type WarehouseConveyorSides = {
  infeed: 'left' | 'right' | 'front' | 'rear';
  outfeed: 'left' | 'right' | 'front' | 'rear';
  mqttFront: 'left' | 'right' | 'front' | 'rear' | null;
  mqttBack: 'left' | 'right' | 'front' | 'rear' | null;
  hasExplicitMqttEndpoints: boolean;
};

/** 仓储流当前选中的堆垛机货叉侧和作业字段。 */
type WarehouseStackerActivity = WarehouseStackerFrame & {
  snapshot: DeviceTelemetrySnapshot;
};

type ModelGeneratorRuntimeEntry = GeneratedOutputOwnerRuntimeEntry & {
  markerRoot: TransformNode;
  marker: ModelGeneratorMarkerRuntimeEntry;
  selected: boolean;
  warehouseCoordinator: WarehouseFlowCoordinator;
  warehouseActiveResolution: ResolvedModelGeneratorTarget | null;
  warehouseCargos: Map<string, WarehouseCargoRuntimeEntry>;
  runtimeConfigSignature: string;
  reportedWarehouseIssues: Set<string>;
};

type ResolvedModelGeneratorTarget = {
  target: ModelGeneratorTarget | null;
  role: 'default' | 'conditional';
  snapshot: DeviceTelemetrySnapshot | null;
};

type ModelParameterRuntimeTarget = AbstractMesh | TransformNode | Material;
type ModelParameterBaselineValue = boolean | number | string | Vector3Data | Texture | null;

export type LocatorRuntimeEntry = {
  root: TransformNode;
  boxes: Mesh[];
  material: StandardMaterial;
  assetId: string;
  signature: string;
  columns: number;
  layers: number;
  startColumn: number;
  deviceAssetCode: string;
  rowNumber: number;
  storageDepth: LocatorStorageDepth;
};

type StackerTravelConstraint = {
  axis: Vector3;
  trackMin: number;
  trackMax: number;
  movingMin: number;
  movingMax: number;
};

type StackerForkSide = 'front' | 'back';

type StackerForkReachConfig = {
  stageOne: number;
  stageTwo: number;
  total: number;
};

type StackerForkOffsetParts = {
  totalOffset: number;
  stageOneOffset: number;
  stageTwoOffset: number;
  activeStage: 0 | 1 | 2;
};

type StackerForkNodeGroups = {
  frontNodes: TransformNode[];
  backNodes: TransformNode[];
  frontStageOneNodes: TransformNode[];
  frontStageTwoNodes: TransformNode[];
  backStageOneNodes: TransformNode[];
  backStageTwoNodes: TransformNode[];
};

type GeneratedCargoKind = 'stacker' | 'conveyor';

type GeneratedCargoFallbackRuntimeEntry = {
  mesh: Mesh;
  material: StandardMaterial;
};

/** 普通自动货物共享字段；root 始终表示货物底部支撑点。 */
type GeneratedCargoRuntimeEntry = {
  assetCode: string;
  containerCode: string;
  root: TransformNode;
  outputOwner: GeneratedOutputOwnerRuntimeEntry | null;
  fallback: GeneratedCargoFallbackRuntimeEntry | null;
};

type StackerCargoRuntimeEntry = GeneratedCargoRuntimeEntry & {
  placedLocatorKey: string | null;
};

type StackerModelTelemetryState = {
  rootBasePosition: Vector3;
  /** 行走机构的虚拟世界位置；模型根节点和上下轨道保持静止。 */
  rootPosition: Vector3 | null;
  /** 基于固定轨道和行走机构基线计算的轨道约束，防止遥测把机体推出轨道。 */
  travelConstraint: StackerTravelConstraint | null;
  /** 货叉未伸出时用于对齐库位的世界坐标锚点。 */
  targetReferencePosition: Vector3 | null;
  liftOffset: number;
  frontForkOffset: number;
  backForkOffset: number;
  lastFrameTimeMs: number;
  frontForkDirection: number;
  backForkDirection: number;
  frontCargoCode: string | null;
  backCargoCode: string | null;
  nodeBaselines: Map<TransformNode, Vector3>;
  lastTargetKey: string | null;
};

type ConveyorNodeBaseline = {
  position: Vector3;
};

type ConveyorModelTelemetryState = {
  cargoCode: string | null;
  cargoTravelOffset: number;
  motionOffsets: Map<string, number>;
  nodeBaselines: Map<TransformNode, ConveyorNodeBaseline>;
};

type ConveyorCargoRuntimeEntry = GeneratedCargoRuntimeEntry;

type ConveyorMotionConfig = {
  key: string;
  fields: string[];
  kind: 'rotate' | 'translate';
  axis: 'x' | 'y' | 'z';
  actionMap: Record<string, number>;
  speed: number;
  nodes: string[];
  fallbackPattern: string | null;
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

type EnvironmentRuntimeEntry = {
  sourceUrl: string;
  unitScaleToMeters: number;
  root: TransformNode;
  container: AssetContainer | null;
  loadToken: number;
};

type EntityRuntimeState = {
  visible: boolean;
  locked: boolean;
};

type RuntimeWorldBounds = {
  minimum: Vector3;
  maximum: Vector3;
};

export class SceneRuntime {
  private readonly meshes = new Map<string, Mesh>();
  private readonly locators = new Map<string, LocatorRuntimeEntry>();
  private readonly locatorTargets = new Map<string, LocatorRuntimeEntry>();
  private readonly locatorDeviceIndex = new Map<string, Map<number, LocatorRuntimeEntry[]>>();
  private readonly cadReferences = new Map<string, CadReferenceRuntimeEntry>();
  private readonly models = new Map<string, ModelRuntimeEntry>();
  private readonly modelGenerators = new Map<string, ModelGeneratorRuntimeEntry>();
  private readonly generatedOutputOwners = new Map<string, GeneratedOutputOwnerRuntimeEntry>();
  private readonly stackerCargoMeshes = new Map<string, StackerCargoRuntimeEntry>();
  private readonly conveyorCargoMeshes = new Map<string, ConveyorCargoRuntimeEntry>();
  private readonly lights = new Map<string, Light>();
  private readonly entityStates = new Map<string, EntityRuntimeState>();
  private readonly syncedEntities = new Map<string, Entity>();
  private selectedEntityIds = new Set<string>();
  private readonly modelHighlightLayer: HighlightLayer;
  private readonly modelSelectionOutlineLayer: SelectionOutlineLayer;
  private readonly assetLoadScheduler = new AssetLoadScheduler();
  private readonly sharedModelAssetCache = new SharedModelAssetCache();
  private readonly fetchRuntimes = new Map<string, ModelGeneratorFetchRuntime>();
  private readonly telemetryObserver: Nullable<Observer<Scene>>;
  private readonly genericTelemetryMotionRuntime: GenericTelemetryMotionRuntime;
  private readonly poiEffectRuntime: PoiEffectRuntime;
  private readonly reportedMissingTargets = new Set<string>();
  private readonly reportedDuplicateLocatorTargets = new Set<string>();
  private readonly reportedInvalidStackerBoxTargets = new Set<string>();
  private readonly lastReportedStackerTargetSignatures = new Map<string, string>();
  private readonly reportedFaults = new Map<string, string>();
  private readonly reportedStatuses = new Map<string, string>();
  private telemetryPreviewActive = false;
  private environment: EnvironmentRuntimeEntry | null = null;
  private activeModelGeneratorEntityId: string | null = null;
  private reportedModelGeneratorConflictSignature = '';
  private sharedModelSelectionOutlineSignature = '';
  private entityArrayPreview: EntityArrayPreviewEntry | null = null;
  private modelLoadSequence = 0;
  private environmentLoadSequence = 0;

  constructor(
    private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
    private readonly onModelMeasurementChanged: (entityId: string) => void = () => undefined,
  ) {
    this.modelHighlightLayer = new HighlightLayer('EditorModelHighlightLayer', scene);
    this.modelSelectionOutlineLayer = new SelectionOutlineLayer('EditorInstancedModelSelectionOutlineLayer', scene);
    this.modelSelectionOutlineLayer.outlineColor = Color3.FromHexString(SELECTED_MATERIAL_COLOR);
    this.genericTelemetryMotionRuntime = new GenericTelemetryMotionRuntime(scene, { pushLog: this.pushLog });
    this.poiEffectRuntime = new PoiEffectRuntime(scene);
    this.telemetryObserver = this.scene.onBeforeRenderObservable.add(() => this.applyDeviceTelemetryFrame());
  }

  /** 处理 fetch 数据源模式的外部事件。 */
  async handleFetchGeneratorEvent(fetchConfig: { url: string; apiKey: string }): Promise<void> {
    for (const [entityId, fetchRuntime] of this.fetchRuntimes) {
      const runtimeEntry = this.generatedOutputOwners.get(entityId);
      if (!runtimeEntry) continue;
      await fetchRuntime.handleEvent(
        fetchConfig,
        runtimeEntry.component,
        (assetId) => {
          const assetIdTrimmed = assetId.trim();
          return this.locatorTargets.get(assetIdTrimmed) ?? null;
        },
        (locator, column, layer) => this.getLocatorBoxWorldMatrix(locator, column, layer),
        (target) => this.loadModelTemplateForFetch(target),
      );
    }
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

      return {
        meshes,
        dispose: () => {
          container.dispose();
          scaleNode?.dispose();
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`Fetch 模板模型加载失败：${message}`);
      return null;
    }
  }

  /** 开始 MQTT 运行预览；该方法幂等，并在真正驱动前清空上一次预览残留运行态。 */
  beginTelemetryPreview(): void {
    if (this.telemetryPreviewActive) return;
    this.clearEntityArrayPreview();
    this.telemetryPreviewActive = true;
    this.genericTelemetryMotionRuntime.beginPreview();
    this.clearTelemetryPreviewRuntimeState();
    this.updateAllExternalScriptRuntimeContexts('runtime', null);
    this.clearModelGeneratorLoadFailureCache();
    this.syncAllModelGeneratorPresentations();
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
    this.genericTelemetryMotionRuntime.endPreview();
    this.disposeAllTelemetryRuntimeCargo();
    for (const fetchRuntime of this.fetchRuntimes.values()) {
      fetchRuntime.clearAllBatches();
    }
    this.resetAllWarehouseFlows();
    for (const model of this.models.values()) {
      if (model.telemetryPreviewBaseline) {
        restoreModelTelemetryPreviewBaseline(model.telemetryPreviewBaseline);
        model.telemetryPreviewBaseline = null;
      }
      this.resetStackerTelemetryState(model);
      this.resetConveyorTelemetryState(model);
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      const model = owner.output.model;
      if (model.telemetryPreviewBaseline) {
        restoreModelTelemetryPreviewBaseline(model.telemetryPreviewBaseline);
        model.telemetryPreviewBaseline = null;
      }
      this.resetStackerTelemetryState(model);
      this.resetConveyorTelemetryState(model);
    }
    this.clearTelemetryPreviewRuntimeState();
    this.updateAllExternalScriptRuntimeContexts('edit', null);
    this.clearModelGeneratorLoadFailureCache();
    this.syncAllModelGeneratorPresentations();
  }

  /** 根据实体 ID 获取当前运行时中可被 Gizmo 绑定的 Babylon 节点。 */
  getGizmoTargetByEntityId(entityId: string | null): AbstractMesh | TransformNode | null {
    if (!entityId) return null;
    if (!this.isEntityTransformEditable(entityId)) return null;

    return (
      this.meshes.get(entityId) ??
      this.locators.get(entityId)?.root ??
      this.cadReferences.get(entityId)?.root ??
      this.models.get(entityId)?.root ??
      this.modelGenerators.get(entityId)?.markerRoot ??
      this.poiEffectRuntime.getGizmoTarget(entityId) ??
      null
    );
  }

  /** 在画布客户端坐标位置拾取可编辑 Mesh，并返回对应实体 ID。 */
  pickEntityIdAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;

    const picked = this.scene.pick(point.x, point.y, (mesh) => {
      const entityId = this.readEntityIdFromMesh(mesh);
      return entityId !== null && this.isEntityScenePickable(entityId);
    });

    const entityId = this.readEntityIdFromMesh(picked?.pickedMesh ?? null);
    return entityId && this.isEntityScenePickable(entityId) ? entityId : null;
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
    if (!model) return { status: 'unavailable', sizeMeters: null };
    if (!model.assetHandle || !model.measurementReady) return { status: 'loading', sizeMeters: null };

    const sizeMeters = measureModelSizeMeters(model.root, model.contentRoot);
    return sizeMeters
      ? { status: 'ready', sizeMeters }
      : { status: 'unavailable', sizeMeters: null };
  }

  /** 读取支持实体沿指定世界方向的有效几何跨度，供 Shift+Gizmo 阵列使用。 */
  getEntityArrayGeometry(entityId: string, worldDirection: Vector3Data): {
    direction: Vector3Data;
    spanMeters: number;
  } | null {
    const source = this.resolveEntityArrayPreviewSource(entityId);
    if (!source?.geometryReady || source.root.isDisposed()) return null;

    const direction = new Vector3(worldDirection.x, worldDirection.y, worldDirection.z);
    const lengthSquared = direction.lengthSquared();
    if (!Number.isFinite(lengthSquared) || lengthSquared <= MODEL_ARRAY_MIN_SPAN_METERS ** 2) return null;
    direction.normalize();

    const normalizedDirection = { x: direction.x, y: direction.y, z: direction.z };
    const spanMeters = measureEntityMeshesSpanMetersAlongWorldDirection(
      source.geometryMeshes,
      normalizedDirection,
    );
    if (!Number.isFinite(spanMeters) || spanMeters === null || spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) return null;

    return { direction: normalizedDirection, spanMeters };
  }

  /**
   * 更新 Shift 阵列的临时实体克隆。
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
      )
    ) {
      this.clearEntityArrayPreview();
    }
    this.entityArrayPreview ??= {
      sourceEntityId: entityId,
      sourceRoot: source.root,
      sourceKind: source.kind,
      clones: [],
      poiBoundsMaterial: null,
      placementSignature: '',
    };

    while (this.entityArrayPreview.clones.length < normalizedCopyCount) {
      const cloneIndex = this.entityArrayPreview.clones.length + 1;
      const clonedNode = this.createEntityArrayPreviewClone(source, this.entityArrayPreview, entityId, cloneIndex);
      if (!clonedNode) {
        this.clearEntityArrayPreview();
        return false;
      }
      this.entityArrayPreview.clones.push(clonedNode);
    }

    while (this.entityArrayPreview.clones.length > normalizedCopyCount) {
      this.entityArrayPreview.clones.pop()?.dispose(false, false);
    }

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
    ].join('|');
    if (this.entityArrayPreview.placementSignature === placementSignature) return true;
    this.entityArrayPreview.placementSignature = placementSignature;

    for (let index = 0; index < this.entityArrayPreview.clones.length; index += 1) {
      const clone = this.entityArrayPreview.clones[index];
      const offsetMultiplier = arrayStepMeters * (index + 1);
      clone.position.copyFromFloats(
        source.root.position.x + geometry.direction.x * offsetMultiplier,
        source.root.position.y + geometry.direction.y * offsetMultiplier,
        source.root.position.z + geometry.direction.z * offsetMultiplier,
      );
      clone.computeWorldMatrix(true);
    }

    return true;
  }

  /** 清除当前全部临时阵列克隆，不释放源实体共享的材质、纹理或几何资源。 */
  clearEntityArrayPreview(): void {
    if (!this.entityArrayPreview) return;

    for (const clone of this.entityArrayPreview.clones) {
      clone.dispose(false, false);
    }
    this.entityArrayPreview.poiBoundsMaterial?.dispose(false, false);
    this.entityArrayPreview = null;
  }

  /** 汇总多个实体的世界包围盒，供场景聚焦和模型阵列读取中心、尺寸与几何就绪状态。 */
  getEntitiesWorldBounds(entityIds: string[]): {
    center: Vector3Data;
    sizeMeters: Vector3Data;
    radiusMeters: number;
    geometryReady: boolean;
  } | null {
    let mergedBounds: RuntimeWorldBounds | null = null;
    let geometryReady = true;

    for (const entityId of entityIds) {
      const bounds = this.getEntityWorldBounds(entityId);
      if (!bounds) {
        geometryReady = false;
        continue;
      }
      if (!this.isEntityWorldBoundsReady(entityId)) geometryReady = false;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
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
    };
  }

  /** 判断实体的真实几何是否已就绪，避免模型加载或外置脚本初始化中的临时包围盒参与正式阵列。 */
  private isEntityWorldBoundsReady(entityId: string): boolean {
    const model = this.models.get(entityId);
    if (model) return model.assetHandle !== null && model.stackerTelemetryReady;

    const modelGenerator = this.modelGenerators.get(entityId);
    if (modelGenerator) return true;

    const cadReference = this.cadReferences.get(entityId);
    if (cadReference) return cadReference.geometryReady && cadReference.lineMeshes.length > 0;

    return this.meshes.has(entityId) || this.locators.has(entityId) || this.lights.has(entityId) || this.poiEffectRuntime.has(entityId);
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
    if (primitiveMesh) return this.getMeshWorldBounds(primitiveMesh);

    const locator = this.locators.get(entityId);
    if (locator && locator.boxes.length > 0) return this.getMeshWorldBounds(locator.boxes[0]);

    const cadReference = this.cadReferences.get(entityId);
    if (cadReference) return this.getCadReferenceWorldBounds(cadReference);

    const model = this.models.get(entityId);
    if (model) return this.getModelWorldBounds(model);

    const modelGenerator = this.modelGenerators.get(entityId);
    if (modelGenerator) return this.getModelGeneratorWorldBounds(modelGenerator);

    const light = this.lights.get(entityId);
    if (light) return this.getLightWorldBounds(light);

    const poiEffectMeshes = this.poiEffectRuntime.getWorldBoundsMeshes(entityId);
    if (poiEffectMeshes.length > 0) {
      let mergedBounds: RuntimeWorldBounds | null = null;
      for (const mesh of poiEffectMeshes) {
        const bounds = this.getMeshWorldBounds(mesh);
        if (!bounds) continue;
        mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
      }
      if (mergedBounds) return mergedBounds;
    }

    return null;
  }

  /** 从 Mesh 的 Babylon BoundingInfo 读取世界空间包围盒。 */
  private getMeshWorldBounds(mesh: AbstractMesh): RuntimeWorldBounds | null {
    mesh.computeWorldMatrix(true);
    const boundingBox = mesh.getBoundingInfo().boundingBox;
    if (!this.isFiniteVector3(boundingBox.minimumWorld) || !this.isFiniteVector3(boundingBox.maximumWorld)) return null;

    return {
      minimum: boundingBox.minimumWorld.clone(),
      maximum: boundingBox.maximumWorld.clone(),
    };
  }

  /** 导入模型优先汇总子网格包围盒，加载中则回退到模型根节点位置。 */
  private getModelWorldBounds(model: ModelRuntimeEntry): RuntimeWorldBounds | null {
    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const mesh of model.meshes) {
      const bounds = this.getMeshWorldBounds(mesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;

    model.root.computeWorldMatrix(true);
    return this.createPointWorldBounds(model.root.getAbsolutePosition());
  }

  /** 模型生成器包围盒始终只描述编辑态配置标记，不包含任何运行时自动货物。 */
  private getModelGeneratorWorldBounds(modelGenerator: ModelGeneratorRuntimeEntry): RuntimeWorldBounds | null {
    const markerBounds = this.getMeshWorldBounds(modelGenerator.marker.mesh);
    if (markerBounds) return markerBounds;

    modelGenerator.markerRoot.computeWorldMatrix(true);
    return this.createPointWorldBounds(modelGenerator.markerRoot.getAbsolutePosition());
  }

  /** CAD 参考层优先按所有线稿 Mesh 合并包围盒，加载中则回退到根节点位置。 */
  private getCadReferenceWorldBounds(cadReference: CadReferenceRuntimeEntry): RuntimeWorldBounds | null {
    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const lineMesh of cadReference.lineMeshes) {
      const bounds = this.getMeshWorldBounds(lineMesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;

    cadReference.root.computeWorldMatrix(true);
    return this.createPointWorldBounds(cadReference.root.getAbsolutePosition());
  }

  /** 灯光没有可见体积时用其位置生成一个小包围盒。 */
  private getLightWorldBounds(light: Light): RuntimeWorldBounds {
    if (light instanceof DirectionalLight || light instanceof PointLight) {
      return this.createPointWorldBounds(light.position);
    }

    return this.createPointWorldBounds(new Vector3(0, 2, 0));
  }

  /** 合并两个世界包围盒。 */
  private mergeWorldBounds(left: RuntimeWorldBounds, right: RuntimeWorldBounds): RuntimeWorldBounds {
    return {
      minimum: Vector3.Minimize(left.minimum, right.minimum),
      maximum: Vector3.Maximize(left.maximum, right.maximum),
    };
  }

  /** 使用一个世界坐标点构造最小可用包围盒。 */
  private createPointWorldBounds(point: Vector3): RuntimeWorldBounds {
    const center = this.isFiniteVector3(point) ? point : Vector3.Zero();
    const padding = new Vector3(0.25, 0.25, 0.25);

    return {
      minimum: center.subtract(padding),
      maximum: center.add(padding),
    };
  }

  /** 过滤异常包围盒数值，避免相机被移动到 NaN/Infinity。 */
  private isFiniteVector3(vector: Vector3): boolean {
    return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
  }

  /** 将编辑器文档增量同步到 Babylon 运行时场景，未变化实体只刷新必要的展示状态。 */
  sync(document: SceneDocument): void {
    const previousEntityStates = new Map(this.entityStates);
    const previousSelectedEntityIds = this.selectedEntityIds;

    this.entityStates.clear();
    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;

      this.entityStates.set(entityId, this.resolveEntityRuntimeState(document, entity));
    }

    const primitiveMeshIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.meshRenderer)),
    );
    const locatorIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.locator)),
    );
    const cadReferenceIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.cadReference)),
    );
    const modelIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.modelAsset)),
    );
    const modelGeneratorEntityIds = document.entityIds.filter(
      (entityId) => Boolean(document.entities[entityId]?.components.modelGenerator),
    );
    const modelGeneratorIds = new Set(modelGeneratorEntityIds);
    const nextActiveModelGeneratorEntityId = modelGeneratorEntityIds[0] ?? null;
    if (this.activeModelGeneratorEntityId !== nextActiveModelGeneratorEntityId) {
      this.disposeAllTelemetryRuntimeCargo();
      this.resetAllWarehouseFlows();
      this.activeModelGeneratorEntityId = nextActiveModelGeneratorEntityId;
    }
    this.reportModelGeneratorConflicts(modelGeneratorEntityIds);

    const lightIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.light)),
    );
    const poiEffectIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.poiEffect)),
    );
    const previewSourceId = this.entityArrayPreview?.sourceEntityId;
    if (previewSourceId && this.poiEffectRuntime.has(previewSourceId) && !poiEffectIds.has(previewSourceId)) {
      this.clearEntityArrayPreview();
    }
    this.poiEffectRuntime.disposeMissing(poiEffectIds);

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

    for (const entityId of [...this.syncedEntities.keys()]) {
      if (!document.entities[entityId]) this.syncedEntities.delete(entityId);
    }

    const selectedEntityIds = this.resolveSelectedEntityIds(document);

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;

      const selected = selectedEntityIds.has(entityId);
      const previousEntity = this.syncedEntities.get(entityId);
      const previousState = previousEntityStates.get(entityId);
      const nextState = this.entityStates.get(entityId);
      const entityChanged = previousEntity !== entity;
      const presentationChanged = previousSelectedEntityIds.has(entityId) !== selected
        || !this.areEntityRuntimeStatesEqual(previousState, nextState);

      if (entityChanged || !this.hasCompleteRuntimeEntity(entity)) {
        this.syncEntity(entity, selected);
      } else if (presentationChanged) {
        this.syncEntityPresentation(entity, selected);
      }

      this.syncedEntities.set(entityId, entity);
    }

    this.selectedEntityIds = selectedEntityIds;
    this.rebuildLocatorTargetIndex(document);
    this.rebuildSharedModelSelectionOutline();
  }

  /** 判断实体已有的 Babylon 对象是否覆盖其全部运行时组件；缺失时回退完整同步。 */
  private hasCompleteRuntimeEntity(entity: Entity): boolean {
    if (entity.components.meshRenderer && !this.meshes.has(entity.id)) return false;
    if (entity.components.locator && !this.locators.has(entity.id)) return false;
    if (entity.components.cadReference && !this.cadReferences.has(entity.id)) return false;
    if (entity.components.modelAsset && !this.models.has(entity.id)) return false;
    if (entity.components.modelGenerator && !this.modelGenerators.has(entity.id)) return false;
    if (entity.components.poiEffect && !this.poiEffectRuntime.has(entity.id)) return false;
    if (entity.components.light && !this.lights.has(entity.id)) return false;
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
  private syncEntityPresentation(entity: Entity, selected: boolean): void {
    this.clearEntityArrayPreviewIfSource(entity.id);
    const primitiveMesh = this.meshes.get(entity.id);
    const meshRenderer = entity.components.meshRenderer;
    if (primitiveMesh && meshRenderer) {
      this.applyMeshInteractivity(primitiveMesh, entity.id);
      this.applyPrimitiveMeshAppearance(primitiveMesh, meshRenderer, selected);
    }

    const locator = this.locators.get(entity.id);
    if (locator && entity.components.locator) {
      this.applyLocatorStyle(locator, selected);
      for (const box of locator.boxes) {
        this.applyMeshInteractivity(box, entity.id);
      }
    }

    const cadReference = this.cadReferences.get(entity.id);
    if (cadReference) {
      this.applyCadReferenceInteractivity(cadReference, entity.id);
    }

    const model = this.models.get(entity.id);
    if (model) {
      this.applyModelSelection(model, selected);
      this.applyModelInteractivity(model, entity.id);
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

    this.lights.get(entity.id)?.setEnabled(this.isEntityVisible(entity.id));
  }

  /** 多个生成器只启用场景顺序中的第一个，并对同一冲突集合仅记录一次诊断。 */
  private reportModelGeneratorConflicts(entityIds: string[]): void {
    if (entityIds.length <= 1) {
      this.reportedModelGeneratorConflictSignature = '';
      return;
    }

    const signature = entityIds.join('|');
    if (this.reportedModelGeneratorConflictSignature === signature) return;
    this.reportedModelGeneratorConflictSignature = signature;
    this.pushLog(`场景存在 ${entityIds.length} 个模型生成器，仅启用 Hierarchy 中第一个作为全局自动模型管理器。`);
  }

  /** 读取当前场景唯一生效的全局模型生成器运行时条目。 */
  private getActiveModelGenerator(): ModelGeneratorRuntimeEntry | null {
    if (!this.activeModelGeneratorEntityId) return null;
    return this.modelGenerators.get(this.activeModelGeneratorEntityId) ?? null;
  }

  /** 同步场景级环境底座模型；环境不写入实体索引，也不能被场景点击选中。 */
  syncEnvironment(environment: SceneEnvironmentSettings | null): void {
    const sourceUrl = environment?.activeVariantUrl ?? null;
    if (!sourceUrl) {
      this.disposeEnvironment();
      return;
    }

    const unitScaleToMeters = environment?.unitScaleToMeters ?? 1;
    if (this.environment?.sourceUrl === sourceUrl && this.environment.unitScaleToMeters === unitScaleToMeters) return;

    this.disposeEnvironment();

    const root = new TransformNode('EnvironmentRoot', this.scene);
    this.applyModelUnitScale(root, unitScaleToMeters);
    const loadToken = ++this.environmentLoadSequence;
    this.environment = { sourceUrl, unitScaleToMeters, root, container: null, loadToken };

    const { rootUrl, fileName } = this.splitAssetUrl(resolveRuntimeAssetUrl(sourceUrl));

    void this.loadAssetContainer(rootUrl, fileName)
      .then((container) => {
        const activeEnvironment = this.environment;
        if (!activeEnvironment || activeEnvironment.loadToken !== loadToken || activeEnvironment.sourceUrl !== sourceUrl) {
          container.dispose();
          return;
        }

        container.addAllToScene();
        activeEnvironment.container = container;
        this.parentTopLevelEnvironmentNodes(activeEnvironment);
        this.positionEnvironmentLeftOfOrigin(activeEnvironment);

        for (const mesh of container.meshes) {
          mesh.isPickable = false;
        }
      })
      .catch((error) => {
        const activeEnvironment = this.environment;
        if (!activeEnvironment || activeEnvironment.loadToken !== loadToken) return;

        this.disposeEnvironment();
        const message = error instanceof Error ? error.message : String(error);
        this.pushLog(`环境模型加载失败：${message}`);
      });
  }

  dispose(): void {
    this.clearEntityArrayPreview();
    this.assetLoadScheduler.dispose();
    if (this.telemetryObserver) {
      this.scene.onBeforeRenderObservable.remove(this.telemetryObserver);
    }
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
    for (const [entityId, model] of this.models.entries()) {
      this.disposeModel(entityId, model);
    }
    for (const [entityId, modelGenerator] of this.modelGenerators.entries()) {
      this.disposeModelGenerator(entityId, modelGenerator);
    }
    this.genericTelemetryMotionRuntime.dispose();
    this.poiEffectRuntime.dispose();
    for (const cargo of this.stackerCargoMeshes.values()) {
      this.disposeStackerCargo(cargo);
    }
    for (const cargo of this.conveyorCargoMeshes.values()) {
      this.disposeConveyorCargo(cargo);
    }
    for (const [entityId, light] of this.lights.entries()) {
      this.disposeLight(entityId, light);
    }
    this.disposeEnvironment();
    this.sharedModelAssetCache.dispose();
    this.modelSelectionOutlineLayer.dispose();
    this.modelHighlightLayer.dispose();
    this.meshes.clear();
    this.locators.clear();
    this.locatorTargets.clear();
    this.reportedDuplicateLocatorTargets.clear();
    this.cadReferences.clear();
    this.models.clear();
    this.modelGenerators.clear();
    this.generatedOutputOwners.clear();
    this.stackerCargoMeshes.clear();
    this.conveyorCargoMeshes.clear();
    this.lights.clear();
    this.entityStates.clear();
    this.syncedEntities.clear();
    this.selectedEntityIds.clear();
    this.activeModelGeneratorEntityId = null;
    this.reportedModelGeneratorConflictSignature = '';
    this.sharedModelSelectionOutlineSignature = '';
  }

  /** 按组件类型同步单个实体的运行时表现。 */
  private syncEntity(entity: Entity, selected: boolean): void {
    this.clearEntityArrayPreviewIfSource(entity.id);
    if (entity.components.meshRenderer) {
      this.syncPrimitiveMeshEntity(entity, selected);
    }

    if (entity.components.locator) {
      this.syncLocatorEntity(entity, selected);
    }

    if (entity.components.cadReference) {
      this.syncCadReferenceEntity(entity);
    }

    if (entity.components.modelAsset) {
      this.syncModelEntity(entity, selected);
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

    if (entity.components.light) {
      this.syncLightEntity(entity);
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
  }

  /** 按设备编号 + 排号 + 列/层范围查找目标 Locator，支持多 Locator 绑定同一设备。 */
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
    for (const locator of list) {
      if (toX >= locator.startColumn && toX < locator.startColumn + locator.columns && toY >= 1 && toY <= locator.layers) {
        return locator;
      }
    }
    return null;
  }

  /** 在 Locator 的 boxes 网格中根据列/层定位具体 box 的世界矩阵。 */
  private getLocatorBoxWorldMatrix(locator: LocatorRuntimeEntry, toX: number, toY: number): Matrix | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      columns: locator.columns,
      layers: locator.layers,
      toX,
      toY,
    });
    const box = boxIndex === null ? null : locator.boxes[boxIndex];
    if (!box) return null;
    box.computeWorldMatrix(true);
    return box.getWorldMatrix();
  }

  /** 解析堆垛机运动目标：设备网格匹配路径精确到格口支撑位，assetId 直查保持定位框根节点语义。 */
  private resolveStackerTargetPosition(
    locator: LocatorRuntimeEntry,
    assetCode: string,
    toX: number | null,
    toY: number | null,
    toZ: number | null,
  ): Vector3 {
    const rootPosition = locator.root.getAbsolutePosition();
    if (!assetCode || toX === null || toY === null || toZ === null) return rootPosition;
    return this.resolveLocatorBoxSupportPosition(locator, toX, toY) ?? rootPosition;
  }

  /** 解析目标格口的支撑位世界坐标：水平取 box 中心、高度取 box 底面，越界时返回 null 由调用方回退。 */
  private resolveLocatorBoxSupportPosition(
    locator: LocatorRuntimeEntry,
    toX: number,
    toY: number,
  ): Vector3 | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      columns: locator.columns,
      layers: locator.layers,
      toX,
      toY,
    });
    const box = boxIndex === null ? null : locator.boxes[boxIndex];
    if (!box) {
      const reportKey = `${locator.assetId}:${toX}:${toY}`;
      if (!this.reportedInvalidStackerBoxTargets.has(reportKey)) {
        this.reportedInvalidStackerBoxTargets.add(reportKey);
        this.pushLog(`库位 ${locator.assetId} 不存在格口 列${toX} 层${toY}，已回退定位框根节点。`);
      }
      return null;
    }

    const bounds = this.getMeshWorldBounds(box);
    if (!bounds) return null;
    return new Vector3(
      (bounds.minimum.x + bounds.maximum.x) / 2,
      bounds.minimum.y,
      (bounds.minimum.z + bounds.maximum.z) / 2,
    );
  }

  /** 将文件夹选中转换为子实体选中集合，用于在场景中高亮整组对象。 */
  private resolveSelectedEntityIds(document: SceneDocument): Set<string> {
    const selectedEntityId = document.selectedEntityId;
    const selectedEntity = selectedEntityId ? document.entities[selectedEntityId] : null;
    if (!selectedEntity) return new Set();

    if (!selectedEntity.isFolder) return new Set([selectedEntity.id]);

    return new Set(
      selectedEntity.childrenIds.filter((childId) => {
        const childEntity = document.entities[childId];
        return Boolean(childEntity && !childEntity.isFolder);
      }),
    );
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

  /** 根据实体材质与选择状态刷新基础 Mesh 外观，不重建几何。 */
  private applyPrimitiveMeshAppearance(mesh: Mesh, meshRenderer: MeshRendererComponent, selected: boolean): void {
    const material = mesh.material instanceof StandardMaterial ? mesh.material : new StandardMaterial(`${mesh.name}_mat`, this.scene);
    material.diffuseColor = selected ? Color3.FromHexString(SELECTED_MATERIAL_COLOR) : this.readColor(meshRenderer.materialColor);
    material.emissiveColor = selected ? Color3.FromHexString(SELECTED_EMISSIVE_COLOR) : Color3.Black();
    mesh.material = material;
  }

  /** 同步虚拟定位线框的根 Transform、业务尺寸和选中态线框颜色。 */
  private syncLocatorEntity(entity: Entity, selected: boolean): void {
    const locator = entity.components.locator;
    if (!locator) return;

    const signature = this.createLocatorSignature(locator);

    let runtimeLocator = this.locators.get(entity.id);
    if (!runtimeLocator) {
      runtimeLocator = this.createLocator(entity.id, locator);
      runtimeLocator.signature = signature;
      this.locators.set(entity.id, runtimeLocator);
    }

    this.applyTransform(runtimeLocator.root, entity.components.transform);
    runtimeLocator.assetId = locator.assetId;
    runtimeLocator.deviceAssetCode = locator.deviceAssetCode;
    runtimeLocator.rowNumber = locator.rowNumber;
    runtimeLocator.columns = locator.columns;
    runtimeLocator.layers = locator.layers;
    runtimeLocator.startColumn = locator.startColumn;
    runtimeLocator.storageDepth = locator.storageDepth;

    const locatorMetadata = { assetId: locator.assetId };
    runtimeLocator.root.metadata = { ...(runtimeLocator.root.metadata ?? {}), storageLocation: locatorMetadata };

    if (runtimeLocator.signature !== signature) {
      // Rebuild grid
      for (const box of runtimeLocator.boxes) {
        box.dispose(false, false);
      }
      runtimeLocator.boxes = this.createLocatorBoxes(entity.id, locator, runtimeLocator.root, runtimeLocator.material);
      runtimeLocator.signature = signature;
    }

    for (const box of runtimeLocator.boxes) {
      box.metadata = { ...(box.metadata ?? {}), storageLocation: locatorMetadata };
    }
    this.applyLocatorStyle(runtimeLocator, selected);
    for (const box of runtimeLocator.boxes) {
      this.applyMeshInteractivity(box, entity.id);
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

  /** 同步 glTF/GLB 模型资源，并通过加载 token 避免异步过期结果污染当前场景。 */
  private syncModelEntity(entity: Entity, selected: boolean): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;

    const assetSignature = this.createModelAssetSignature(modelAsset);
    const existing = this.models.get(entity.id);
    if (existing && existing.assetSignature !== assetSignature) {
      this.disposeModel(entity.id, existing);
    }

    const current = this.models.get(entity.id);
    if (current) {
      this.applyTransform(current.root, entity.components.transform);
      if (current.assetCode !== modelAsset.assetCode) {
        this.disposeStackerCargoForAssetCode(current.assetCode);
        this.disposeConveyorCargoForAssetCode(current.assetCode);
        current.stackerTelemetry.frontCargoCode = null;
        current.stackerTelemetry.backCargoCode = null;
        this.resetConveyorTelemetryState(current);
      }
      current.assetCode = modelAsset.assetCode;
      current.telemetryBinding = entity.components.telemetryBinding ?? null;
      current.assetRevision = modelAsset.assetRevision ?? null;
      current.assetSignature = assetSignature;
      current.stackerCapable = this.isStackerModelAsset(modelAsset);
      current.conveyorCapable = this.isConveyorModelAsset(modelAsset);
      current.stackerTelemetry.rootBasePosition = current.root.position.clone();
      this.applyModelUnitScale(current.contentRoot, modelAsset.unitScaleToMeters);
      this.applyModelParameters(entity, current);
      this.syncExternalModelScripts(entity, current);
      this.applyModelSelection(current, selected);
      this.applyModelInteractivity(current, entity.id);
      return;
    }

    const root = new TransformNode(`${entity.id}_modelRoot`, this.scene);
    const contentRoot = new TransformNode(`${entity.id}_modelContentRoot`, this.scene);
    contentRoot.parent = root;
    this.applyTransform(root, entity.components.transform);
    this.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const loadToken = ++this.modelLoadSequence;
    const pending: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature,
      assetCode: modelAsset.assetCode,
      telemetryBinding: entity.components.telemetryBinding ?? null,
      stackerCapable: this.isStackerModelAsset(modelAsset),
      conveyorCapable: this.isConveyorModelAsset(modelAsset),
      root,
      contentRoot,
      assetHandle: null,
      meshes: [],
      highlighted: false,
      highlightedMeshes: new Set(),
      loadToken,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: this.createStackerTelemetryState(root),
      conveyorTelemetry: this.createConveyorTelemetryState(),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
    };
    this.models.set(entity.id, pending);
    this.applyModelSelection(pending, selected);
    this.applyModelInteractivity(pending, entity.id);

    void this.loadModelRuntimeAssets(modelAsset, assetSignature)
      .then((loadedAssets) => {
        const activeEntry = this.models.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.assetSignature !== assetSignature) {
          loadedAssets.handle.dispose();
          return;
        }

        activeEntry.assetHandle = loadedAssets.handle;
        if (loadedAssets.kind === 'owned-container') {
          activeEntry.meshes = loadedAssets.meshes;
          this.parentTopLevelModelNodes(activeEntry, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) {
            rootNode.parent = activeEntry.contentRoot;
          }
        }

        const latestEntity = this.syncedEntities.get(entity.id) ?? entity;
        this.refreshModelEntityMeshes(latestEntity, activeEntry);
        this.normalizeModelContentOrigin(activeEntry);
        this.applyModelParameters(latestEntity, activeEntry);
        this.syncExternalModelScripts(latestEntity, activeEntry);
        this.applyModelSelection(activeEntry, activeEntry.highlighted);
        this.applyModelInteractivity(activeEntry, latestEntity.id);
        this.rebuildSharedModelSelectionOutline();
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
  ): Promise<LoadedModelRuntimeAssets> {
    const { rootUrl, fileName } = this.splitAssetUrl(
      this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision),
    );

    const instancingPolicy = resolveModelAssetSharedInstancingPolicy(modelAsset);
    if (instancingPolicy.mode === 'shared-instance') {
      const sharedInstance = await this.sharedModelAssetCache.instantiate(
        assetSignature,
        () => this.loadAssetContainer(rootUrl, fileName),
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

    const container = await this.loadAssetContainer(rootUrl, fileName);
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
        warehouseCoordinator: new WarehouseFlowCoordinator(),
        warehouseActiveResolution: null,
        warehouseCargos: new Map(),
        runtimeConfigSignature: '',
        reportedWarehouseIssues: new Set(),
      };
      this.modelGenerators.set(entity.id, runtimeEntry);
      this.generatedOutputOwners.set(runtimeEntry.entityId, runtimeEntry);
    }

    if (component.dataSource === 'fetch' && !this.fetchRuntimes.has(entity.id)) {
      this.fetchRuntimes.set(entity.id, new ModelGeneratorFetchRuntime(this.scene, entity.id, this.pushLog));
    } else if (component.dataSource !== 'fetch' && this.fetchRuntimes.has(entity.id)) {
      this.fetchRuntimes.get(entity.id)?.dispose();
      this.fetchRuntimes.delete(entity.id);
    }

    const runtimeConfigSignature = this.createModelGeneratorRuntimeConfigSignature(component);
    if (runtimeEntry.runtimeConfigSignature && runtimeEntry.runtimeConfigSignature !== runtimeConfigSignature) {
      if (runtimeEntry.entityId === this.activeModelGeneratorEntityId) {
        this.disposeAllTelemetryRuntimeCargo();
      }
      this.resetModelGeneratorWarehouseFlow(runtimeEntry);
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
      assetCode: modelAsset.assetCode,
      telemetryBinding: null,
      stackerCapable: this.isStackerModelAsset(modelAsset),
      conveyorCapable: this.isConveyorModelAsset(modelAsset),
      root: modelRoot,
      contentRoot,
      assetHandle: null,
      meshes: [],
      highlighted: false,
      highlightedMeshes: new Set(),
      loadToken: modelLoadToken,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: this.createStackerTelemetryState(modelRoot),
      conveyorTelemetry: this.createConveyorTelemetryState(),
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

  /** 同步灯光类型、位置/方向和强度。 */
  private syncLightEntity(entity: Entity): void {
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

    light.intensity = lightComponent.intensity;
    light.setEnabled(this.isEntityVisible(entity.id));

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
    this.clearInactiveSpecializedTelemetryDiagnostics();
    this.captureReadyTelemetryPreviewBaselines();
    const deltaSeconds = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    this.applyStackerTelemetryFrame();
    this.applyConveyorTelemetryFrame();
    this.updateWarehouseFlowFrames(deltaSeconds);
    this.applyWarehouseFlowVisuals();
    this.genericTelemetryMotionRuntime.applyFrame(deltaSeconds);
  }

  /** 为已加载且 ready 的模型捕获本次预览基线，异步 GLB 后续 ready 时会在首个驱动帧前补捕获。 */
  private captureReadyTelemetryPreviewBaselines(): void {
    for (const model of this.models.values()) {
      if (model.telemetryPreviewBaseline || !model.assetHandle || !model.stackerTelemetryReady) continue;
      model.telemetryPreviewBaseline = captureModelTelemetryPreviewBaseline({ root: model.root, contentRoot: model.contentRoot });
      if (this.resolveSpecializedTelemetryDeviceType(model) === 'stacker') {
        this.getStackerTargetReferencePosition(model);
      }
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      const model = owner.output.model;
      if (model.telemetryPreviewBaseline || !model.assetHandle || !model.stackerTelemetryReady) continue;
      model.telemetryPreviewBaseline = captureModelTelemetryPreviewBaseline({ root: model.root, contentRoot: model.contentRoot });
    }
  }

  /** 清空 SceneRuntime 级别的预览诊断、metadata 和已上报状态，不影响模型注册或编译绑定。 */
  private clearTelemetryPreviewRuntimeState(): void {
    telemetryRuntimeDiagnosticsStore.clear();
    this.reportedMissingTargets.clear();
    this.reportedFaults.clear();
    this.reportedStatuses.clear();
    this.reportedInvalidStackerBoxTargets.clear();
    this.lastReportedStackerTargetSignatures.clear();
    for (const model of this.models.values()) {
      this.clearSpecializedTelemetryDiagnosticsForModel(model);
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind === 'model') {
        this.clearSpecializedTelemetryDiagnosticsForModel(owner.output.model);
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
  ): void {
    model.externalScriptRuntime?.updateRuntimeContext({ mode, telemetry });
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

  /** 清理所有专用 Stacker/Conveyor 运行时货物，保证结束预览不污染编辑态场景。 */
  private disposeAllTelemetryRuntimeCargo(): void {
    for (const cargo of this.stackerCargoMeshes.values()) {
      this.disposeStackerCargo(cargo);
    }
    this.stackerCargoMeshes.clear();
    for (const cargo of this.conveyorCargoMeshes.values()) {
      this.disposeConveyorCargo(cargo);
    }
    this.conveyorCargoMeshes.clear();
  }

  /** 清除模型 root/contentRoot 上的遥测运行态 metadata，避免预览状态泄漏到编辑态 Inspector。 */
  private clearSpecializedTelemetryDiagnosticsForModel(model: ModelRuntimeEntry): void {
    for (const node of [model.root, model.contentRoot]) {
      if (!node.metadata || typeof node.metadata !== 'object') continue;
      const metadata = { ...(node.metadata as Record<string, unknown>) };
      delete metadata.telemetryRuntime;
      delete metadata.telemetry;
      delete metadata.stackerTelemetry;
      delete metadata.conveyorTelemetry;
      node.metadata = metadata;
    }
  }

  /** 每帧把最新 MQTT stacker 遥测应用到完整主键匹配且无冲突的模型实例。 */
  private applyStackerTelemetryFrame(): void {
    const candidates = this.collectSpecializedTelemetryModels('stacker');
    const conflictKeys = collectSpecializedTelemetryConflictKeys(candidates.map((candidate) => candidate.binding));
    const deltaSeconds = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    const nowMs = Date.now();

    for (const candidate of candidates) {
      const snapshot = this.resolveSpecializedTelemetryFrameSnapshot(candidate, conflictKeys, nowMs);
      this.updateModelExternalScriptRuntimeContext(
        candidate.model,
        'runtime',
        snapshot ? this.createExternalScriptTelemetrySnapshot(snapshot) : null,
      );
      if (!snapshot) continue;
      this.applyStackerTelemetryToModel(candidate.model, snapshot as StackerTelemetrySnapshot, deltaSeconds);
    }
  }

  /** 每帧把最新 MQTT conveyor 遥测应用到完整主键匹配且无冲突的模型实例。 */
  private applyConveyorTelemetryFrame(): void {
    const candidates = this.collectSpecializedTelemetryModels('conveyor');
    const conflictKeys = collectSpecializedTelemetryConflictKeys(candidates.map((candidate) => candidate.binding));
    const deltaSeconds = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    const nowMs = Date.now();

    for (const candidate of candidates) {
      const snapshot = this.resolveSpecializedTelemetryFrameSnapshot(candidate, conflictKeys, nowMs);
      this.updateModelExternalScriptRuntimeContext(
        candidate.model,
        'runtime',
        snapshot ? this.createExternalScriptTelemetrySnapshot(snapshot) : null,
      );
      if (!snapshot) continue;
      this.applyConveyorTelemetryToModel(candidate.model, snapshot, deltaSeconds);
    }
  }

  /** 收集最终选择当前专用类型的模型，并把实例绑定归一成完整遥测主键。 */
  private collectSpecializedTelemetryModels(
    deviceType: SpecializedTelemetryDeviceType,
  ): SpecializedTelemetryRuntimeEntry[] {
    const candidates: SpecializedTelemetryRuntimeEntry[] = [];
    for (const [entityId, model] of this.models.entries()) {
      if (!model.assetHandle || !model.stackerTelemetryReady) continue;
      if (this.resolveSpecializedTelemetryDeviceType(model) !== deviceType) continue;

      const binding = resolveSpecializedTelemetryBinding({
        modelAssetCode: model.assetCode,
        deviceType,
        binding: model.telemetryBinding,
      });
      if (!binding) continue;
      candidates.push({ entityId, model, binding });
    }
    return candidates;
  }

  /** 为同时命中多种专用能力的模型选择唯一驱动类型，实例绑定优先、无绑定时 Stacker 优先。 */
  private resolveSpecializedTelemetryDeviceType(model: ModelRuntimeEntry): SpecializedTelemetryDeviceType | null {
    if (model.telemetryBinding?.enabled === false) return null;
    const configuredDeviceType = model.telemetryBinding?.deviceType.trim().toLowerCase();
    if (configuredDeviceType) {
      if (configuredDeviceType === 'stacker' && model.stackerCapable) return 'stacker';
      if (configuredDeviceType === 'conveyor' && this.isConveyorRuntimeModel(model)) return 'conveyor';
      return null;
    }
    if (model.stackerCapable) return 'stacker';
    if (this.isConveyorRuntimeModel(model)) return 'conveyor';
    return null;
  }

  /** 仅在模型没有任何有效专用绑定时清理诊断，避免另一专用类型遍历覆盖有效状态。 */
  private clearInactiveSpecializedTelemetryDiagnostics(): void {
    for (const [entityId, model] of this.models.entries()) {
      if (!model.assetHandle || !model.stackerTelemetryReady) continue;
      const isSpecialized = model.stackerCapable || this.isConveyorRuntimeModel(model);
      if (!isSpecialized || this.resolveSpecializedTelemetryDeviceType(model)) continue;
      this.clearSpecializedTelemetryDiagnostics(entityId, model);
    }
  }

  /** 解析当前帧专用快照，并统一处理冲突、离线、断流和诊断状态。 */
  private resolveSpecializedTelemetryFrameSnapshot(
    candidate: SpecializedTelemetryRuntimeEntry,
    conflictKeys: ReadonlySet<string>,
    nowMs: number,
  ): DeviceTelemetrySnapshot | null {
    const { entityId, model, binding } = candidate;
    const snapshot = resolveSpecializedTelemetrySnapshot(deviceTelemetryStore, binding);
    const conflictReportKey = `specialized-conflict:${binding.key}`;

    if (conflictKeys.has(binding.key)) {
      const errors = ['绑定冲突：同一 sourceId/deviceType/assetCode 匹配多个专用模型，已停止驱动。'];
      this.writeSpecializedTelemetryDiagnostics(entityId, model, binding, {
        online: false,
        stale: false,
        faulted: snapshot?.faulted ?? false,
        conflict: true,
        lastReceivedAt: snapshot?.receivedAt ?? null,
        errors,
      }, snapshot ?? undefined);
      if (this.reportedStatuses.get(conflictReportKey) !== 'conflict') {
        this.reportedStatuses.set(conflictReportKey, 'conflict');
        this.pushLog(
          `专用遥测绑定冲突，已停止驱动：sourceId=${binding.sourceId}，deviceType=${binding.deviceType}，assetCode=${binding.assetCode}`,
        );
      }
      return null;
    }

    this.reportedStatuses.delete(conflictReportKey);
    if (!snapshot) {
      this.writeSpecializedTelemetryDiagnostics(entityId, model, binding, {
        online: false,
        stale: false,
        faulted: false,
        conflict: false,
        lastReceivedAt: null,
        errors: [],
      });
      return null;
    }

    const stale = nowMs - snapshot.receivedAt > binding.staleAfterMs;
    this.writeSpecializedTelemetryDiagnostics(entityId, model, binding, {
      online: !stale && !snapshot.faulted,
      stale,
      faulted: snapshot.faulted,
      conflict: false,
      lastReceivedAt: snapshot.receivedAt,
      errors: [],
    }, snapshot);
    return stale ? null : snapshot;
  }

  /** 把专用驱动诊断写入 Babylon metadata 和只读外部 store，不进入场景文档或撤销历史。 */
  private writeSpecializedTelemetryDiagnostics(
    entityId: string,
    model: ModelRuntimeEntry,
    binding: ResolvedSpecializedTelemetryBinding,
    status: TelemetryRuntimeDiagnosticStatus,
    snapshot?: DeviceTelemetrySnapshot,
  ): void {
    const runtimeMetadata = { ...status, errors: [...status.errors] };
    for (const node of [model.root, model.contentRoot]) {
      node.metadata = { ...(node.metadata ?? {}), telemetryRuntime: runtimeMetadata };
    }
    telemetryRuntimeDiagnosticsStore.upsert(entityId, {
      ...runtimeMetadata,
      sourceId: snapshot?.sourceId ?? binding.sourceId,
      deviceType: snapshot?.deviceType ?? binding.deviceType,
      assetCode: snapshot?.assetCode ?? binding.assetCode,
      topic: snapshot?.topic ?? null,
      sequence: snapshot?.sequence ?? null,
      sourceTimestamp: snapshot?.sourceTimestamp ?? null,
      fields: snapshot?.fields ?? {},
      message: snapshot?.message ?? '',
      nodeTargets: [],
      boneTargets: [],
      animationTargets: [],
    });
  }

  /** 清理禁用或类型错配的专用绑定诊断，避免 Inspector 展示过期状态。 */
  private clearSpecializedTelemetryDiagnostics(entityId: string, model: ModelRuntimeEntry): void {
    telemetryRuntimeDiagnosticsStore.delete(entityId);
    for (const node of [model.root, model.contentRoot]) {
      if (!node.metadata || typeof node.metadata !== 'object') continue;
      const metadata = { ...(node.metadata as Record<string, unknown>) };
      delete metadata.telemetryRuntime;
      node.metadata = metadata;
    }
  }

  /** 对单台 stacker 应用根节点、载货台和前后叉的遥测驱动。 */
  private applyStackerTelemetryToModel(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    const toX = readIntegerField(snapshot.fields, 'to_x');
    const toY = readIntegerField(snapshot.fields, 'to_y');
    const toZ = readIntegerField(snapshot.fields, 'to_z');
    const targetLocator = (snapshot.assetCode && toX !== null && toY !== null && toZ !== null)
      ? this.findLocatorByDevice(snapshot.assetCode, toX, toY, toZ)
      : snapshot.targetLocationKey
        ? this.locatorTargets.get(snapshot.targetLocationKey) ?? null
        : null;
    this.reportStackerRuntimeState(snapshot, targetLocator);
    this.writeDeviceTelemetryMetadata(model, snapshot);

    const targetPosition = targetLocator
      ? this.resolveStackerTargetPosition(targetLocator, snapshot.assetCode, toX, toY, toZ)
      : null;
    const targetOffsets = targetPosition ? this.resolveStackerTargetMotionOffsets(model, targetPosition) : null;
    this.reportStackerTargetProjection(model, targetLocator, targetPosition, targetOffsets, toX, toY);
    this.applyStackerRootMotion(model, snapshot, targetOffsets?.travelOffset ?? null, deltaSeconds);
    this.applyStackerLiftMotion(model, snapshot, targetOffsets?.liftOffset ?? null, deltaSeconds);
    this.applyStackerForkMotion(model, snapshot, targetPosition, deltaSeconds, targetLocator);
    this.applyStackerNodeMotionOffsets(model);
    this.applyStackerCargoMotion(model, snapshot, targetLocator, targetPosition);
    this.writeStackerTelemetryMetadata(model, snapshot, targetLocator);
  }

  /** 对单条输送线应用滚筒/链条动作、货物占位和状态 metadata。 */
  private applyConveyorTelemetryToModel(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    this.reportConveyorRuntimeState(snapshot);
    this.writeDeviceTelemetryMetadata(model, snapshot);

    if (!snapshot.faulted) {
      this.applyConveyorMotion(model, snapshot, deltaSeconds);
    }

    this.applyConveyorCargoMotion(model, snapshot, deltaSeconds);
  }

  /** 每帧读取全局生成器三台严格绑定设备，推进仓储协调器并处理货物生命周期事件。 */
  private updateWarehouseFlowFrames(deltaSeconds: number): void {
    const runtimeEntry = this.getActiveModelGenerator();
    if (!runtimeEntry?.component.warehouseFlow?.enabled) return;

    const nowMs = Date.now();
    const bindings = this.resolveWarehouseFlowBindings(runtimeEntry);
    if (!bindings) return;

    const ttlMs = runtimeEntry.component.metadataTtlSeconds * 1000;
    const inboundSnapshot = this.resolveWarehouseBindingSnapshot(bindings.inbound, nowMs, ttlMs);
    const stackerSnapshot = this.resolveWarehouseBindingSnapshot(bindings.stacker, nowMs, ttlMs);
    const outboundSnapshot = this.resolveWarehouseBindingSnapshot(bindings.outbound, nowMs, ttlMs);
    const inboundModel = this.findModelByWarehouseBinding(runtimeEntry, bindings.inbound, 'conveyor');
    const stackerModel = this.findModelByWarehouseBinding(runtimeEntry, bindings.stacker, 'stacker');
    const outboundModel = this.findModelByWarehouseBinding(runtimeEntry, bindings.outbound, 'conveyor');
    const inboundAnchors = inboundModel ? this.resolveWarehouseConveyorAnchors(inboundModel) : null;
    const outboundAnchors = outboundModel ? this.resolveWarehouseConveyorAnchors(outboundModel) : null;
    const inboundFrame = this.createWarehouseConveyorFrame(inboundSnapshot, inboundAnchors);
    const flowState = runtimeEntry.warehouseCoordinator.getState();
    const stackerActivity = this.createWarehouseStackerActivity(runtimeEntry, stackerSnapshot);
    const outboundFrame = this.createWarehouseConveyorFrame(outboundSnapshot, outboundAnchors);
    const pendingResolution = flowState.inbound
      ? runtimeEntry.warehouseActiveResolution
      : this.resolveWarehouseCargoTarget(runtimeEntry, inboundSnapshot);
    const update = runtimeEntry.warehouseCoordinator.update({
      nowMs,
      deltaSeconds,
      ttlMs,
      canStartInbound: Boolean(pendingResolution?.target),
      inbound: inboundFrame,
      stacker: stackerActivity,
      outbound: outboundFrame,
      storedCargos: [...runtimeEntry.warehouseCargos.values()].map((cargo) => ({
        cargoCode: cargo.cargoCode,
        locatorKey: cargo.locatorKey,
      })),
    });

    if (update.events.startInboundCargoCode && pendingResolution?.target) {
      runtimeEntry.warehouseActiveResolution = pendingResolution;
      runtimeEntry.metadata = {
        ...runtimeEntry.metadata,
        containerCode: update.events.startInboundCargoCode,
      };
      this.clearWarehouseIssue(runtimeEntry, 'target-missing');
    }
    if (update.events.cancelInboundCargoCode) {
      runtimeEntry.warehouseActiveResolution = null;
      this.resetGeneratedOutputRoot(runtimeEntry.root);
    }
    if (update.events.storeInboundCargo) {
      const stored = this.storeWarehouseInboundCargo(
        runtimeEntry,
        update.events.storeInboundCargo.cargoCode,
        update.events.storeInboundCargo.locatorKey,
      );
      if (stored) {
        runtimeEntry.warehouseCoordinator.acknowledgeInboundStored(update.events.storeInboundCargo.cargoCode);
        runtimeEntry.warehouseActiveResolution = null;
      }
    }
    if (update.events.completeOutboundCargoCode) {
      const cargo = runtimeEntry.warehouseCargos.get(update.events.completeOutboundCargoCode);
      if (cargo) {
        this.disposeWarehouseCargo(cargo);
        runtimeEntry.warehouseCargos.delete(update.events.completeOutboundCargoCode);
      }
      runtimeEntry.warehouseCoordinator.acknowledgeOutboundCompleted(update.events.completeOutboundCargoCode);
    }
    if (update.events.conflictMessage) {
      this.reportWarehouseIssue(runtimeEntry, 'cargo-conflict:' + update.events.conflictMessage, update.events.conflictMessage);
    }

    this.syncModelGeneratorResolvedTarget(runtimeEntry, runtimeEntry.warehouseActiveResolution ?? {
      target: null,
      role: 'default',
      snapshot: null,
    });

    if (!pendingResolution?.target && inboundFrame?.frontHasGoods) {
      this.reportWarehouseIssue(runtimeEntry, 'target-missing', '1004 前端有货，但模型生成器没有可用共享模板或规则目标。');
    }
  }

  /** 从仓储流配置中解析三条稳定绑定，并严格检查设备类型和完整主键。 */
  private resolveWarehouseFlowBindings(runtimeEntry: ModelGeneratorRuntimeEntry): ResolvedWarehouseFlowBindings | null {
    const warehouseFlow = runtimeEntry.component.warehouseFlow;
    if (!warehouseFlow?.enabled) return null;
    const byId = new Map(runtimeEntry.component.bindings.map((binding) => [binding.id, binding]));
    const inbound = byId.get(warehouseFlow.inboundBindingId);
    const stacker = byId.get(warehouseFlow.stackerBindingId);
    const outbound = byId.get(warehouseFlow.outboundBindingId);
    const bindings = [inbound, stacker, outbound];
    if (bindings.some((binding) => !binding?.sourceId.trim() || !binding.deviceType.trim() || !binding.assetCode.trim())) {
      this.reportWarehouseIssue(runtimeEntry, 'binding-missing', '仓储流绑定缺失 sourceId、deviceType 或 assetCode，已停止驱动。');
      return null;
    }
    if (inbound!.deviceType.trim().toLowerCase() !== 'conveyor'
      || stacker!.deviceType.trim().toLowerCase() !== 'stacker'
      || outbound!.deviceType.trim().toLowerCase() !== 'conveyor') {
      this.reportWarehouseIssue(runtimeEntry, 'binding-type', '仓储流设备类型必须依次为 conveyor、stacker、conveyor。');
      return null;
    }
    this.clearWarehouseIssue(runtimeEntry, 'binding-missing');
    this.clearWarehouseIssue(runtimeEntry, 'binding-type');
    return { inbound: inbound!, stacker: stacker!, outbound: outbound! };
  }

  /** 按完整主键读取未超时快照；stale 时返回 null，使协调器保持当前位置。 */
  private resolveWarehouseBindingSnapshot(
    binding: ModelGeneratorBinding,
    nowMs: number,
    ttlMs: number,
  ): DeviceTelemetrySnapshot | null {
    const snapshot = deviceTelemetryStore.getSnapshot(
      binding.assetCode.trim(),
      binding.deviceType.trim().toLowerCase(),
      binding.sourceId.trim(),
    );
    if (!snapshot || nowMs - snapshot.receivedAt > ttlMs) return null;
    return snapshot;
  }

  /** 查找与仓储绑定完整主键一致的唯一设备模型，绝不按名称或唯一数量猜测。 */
  private findModelByWarehouseBinding(
    runtimeEntry: ModelGeneratorRuntimeEntry,
    binding: ModelGeneratorBinding,
    deviceType: SpecializedTelemetryDeviceType,
  ): ModelRuntimeEntry | null {
    const matches = [...this.models.values()].filter((model) => {
      if (!model.assetHandle || !model.stackerTelemetryReady) return false;
      const resolved = resolveSpecializedTelemetryBinding({
        modelAssetCode: model.assetCode,
        deviceType,
        binding: model.telemetryBinding,
      });
      return resolved?.sourceId === binding.sourceId.trim()
        && resolved.deviceType === binding.deviceType.trim().toLowerCase()
        && resolved.assetCode === binding.assetCode.trim();
    });
    const missingIssueKey = 'model-missing:' + binding.id;
    const conflictIssueKey = 'model-conflict:' + binding.id;
    if (matches.length === 1) {
      this.clearWarehouseIssue(runtimeEntry, missingIssueKey);
      this.clearWarehouseIssue(runtimeEntry, conflictIssueKey);
      return matches[0];
    }
    if (matches.length > 1) {
      this.clearWarehouseIssue(runtimeEntry, missingIssueKey);
      this.reportWarehouseIssue(
        runtimeEntry,
        conflictIssueKey,
        `仓储流绑定 ${binding.deviceType}/${binding.assetCode} 命中多个模型，已停止驱动。`,
      );
      return null;
    }
    this.clearWarehouseIssue(runtimeEntry, conflictIssueKey);
    this.reportWarehouseIssue(
      runtimeEntry,
      missingIssueKey,
      `仓储流绑定 ${binding.deviceType}/${binding.assetCode} 未找到严格匹配的场景模型，已停止驱动。`,
    );
    return null;
  }

  /** 把 Conveyor 快照转换为协调器需要的前后光电、方向和实际跨度。 */
  private createWarehouseConveyorFrame(
    snapshot: DeviceTelemetrySnapshot | null,
    anchors: WarehouseConveyorAnchors | null,
  ): WarehouseConveyorFrame | null {
    if (!snapshot || !anchors) return null;
    return {
      containerCode: this.readContainerCode(snapshot, 'containerCode'),
      frontHasGoods: readBooleanField(snapshot.fields, 'front_has_goods') === true,
      backHasGoods: readBooleanField(snapshot.fields, 'back_has_goods') === true,
      movementX: readIntegerField(snapshot.fields, 'movement_x') ?? 0,
      movementY: readIntegerField(snapshot.fields, 'movement_y') ?? 0,
      liftAtLow: readBooleanField(snapshot.fields, 'lift_at_low'),
      liftAtHigh: readBooleanField(snapshot.fields, 'lift_at_high'),
      faulted: snapshot.faulted,
      receivedAt: snapshot.receivedAt,
      spanMeters: anchors.spanMeters,
    };
  }

  /** 从 DDJ2 前后叉状态中解析唯一活动侧；双叉同时活跃且无法消歧时冻结仓储流。 */
  private createWarehouseStackerActivity(
    runtimeEntry: ModelGeneratorRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot | null,
  ): WarehouseStackerActivity | null {
    if (!snapshot) return null;

    const candidates = (['front', 'back'] as const).map((side): WarehouseStackerActivity | null => {
      const command = readIntegerField(snapshot.fields, `${side}_command`);
      const movementZ = readIntegerField(snapshot.fields, `${side}_movement_z`);
      const containerCode = this.readContainerCode(snapshot, `${side}_containerCode`);
      const active = Boolean(containerCode)
        || this.isWarehouseStackerCommandActive(command)
        || (movementZ !== null && movementZ !== 0);
      if (!active) return null;
      return {
        snapshot,
        side,
        command,
        movementZ,
        containerCode,
        targetLocationKey: snapshot.targetLocationKey,
        faulted: snapshot.faulted,
        receivedAt: snapshot.receivedAt,
      };
    }).filter((candidate): candidate is WarehouseStackerActivity => Boolean(candidate));

    const issueKey = 'stacker-side-conflict';
    if (candidates.length === 0) {
      this.clearWarehouseIssue(runtimeEntry, issueKey);
      return null;
    }
    if (candidates.length === 1) {
      this.clearWarehouseIssue(runtimeEntry, issueKey);
      return candidates[0];
    }

    const chooseFork = readIntegerField(snapshot.fields, 'to_choose_fork')
      ?? readIntegerField(snapshot.fields, 'choose_fork');
    const chosenSide = chooseFork === 1 ? 'front' : (chooseFork === 2 ? 'back' : null);
    if (chosenSide) {
      const chosen = candidates.find((candidate) => candidate.side === chosenSide);
      if (chosen) {
        this.clearWarehouseIssue(runtimeEntry, issueKey);
        return chosen;
      }
    }

    const state = runtimeEntry.warehouseCoordinator.getState();
    const expectedCargoCodes = new Set(
      [state.outbound?.cargoCode, state.inbound?.cargoCode].filter((value): value is string => Boolean(value)),
    );
    const expectedMatches = candidates.filter((candidate) => (
      Boolean(candidate.containerCode) && expectedCargoCodes.has(candidate.containerCode!)
    ));
    if (expectedMatches.length === 1) {
      this.clearWarehouseIssue(runtimeEntry, issueKey);
      return expectedMatches[0];
    }

    const storedMatches = candidates.filter((candidate) => (
      Boolean(candidate.containerCode) && runtimeEntry.warehouseCargos.has(candidate.containerCode!)
    ));
    if (storedMatches.length === 1) {
      this.clearWarehouseIssue(runtimeEntry, issueKey);
      return storedMatches[0];
    }

    const cargoCommandCandidates = candidates.filter((candidate) => this.isWarehouseStackerCargoCommand(candidate.command));
    if (cargoCommandCandidates.length === 1) {
      this.clearWarehouseIssue(runtimeEntry, issueKey);
      return cargoCommandCandidates[0];
    }

    const commandedCandidates = candidates.filter((candidate) => this.isWarehouseStackerCommandActive(candidate.command));
    if (commandedCandidates.length === 1) {
      this.clearWarehouseIssue(runtimeEntry, issueKey);
      return commandedCandidates[0];
    }

    this.reportWarehouseIssue(runtimeEntry, issueKey, 'DDJ2 前后叉同时存在活动证据且无法唯一匹配条码，已冻结货物接管。');
    return null;
  }

  /** 判断命令是否直接承载取货、搬运或放货阶段，用于双叉消歧时优先选择真实作业侧。 */
  private isWarehouseStackerCargoCommand(command: number | null): boolean {
    return command !== null && command >= 1 && command <= 5;
  }

  /** 仓储流程只把 1..7、10、11 视为活动命令，急停和未知状态不接管货物。 */
  private isWarehouseStackerCommandActive(command: number | null): boolean {
    return command !== null && ((command >= 1 && command <= 7) || command === 10 || command === 11);
  }

  /** 仓储入库触发时复用全局单快照规则解析，位置仍由仓储状态机决定。 */
  private resolveWarehouseCargoTarget(
    runtimeEntry: ModelGeneratorRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot | null,
  ): ResolvedModelGeneratorTarget | null {
    return snapshot ? resolveModelGeneratorTargetFromSnapshot(runtimeEntry.component, snapshot) : null;
  }

  /** 根据协调器阶段把全局生成器活动输出和已入库实例放到真实设备/库位世界锚点。 */
  private applyWarehouseFlowVisuals(): void {
    const runtimeEntry = this.getActiveModelGenerator();
    if (!runtimeEntry?.component.warehouseFlow?.enabled) return;

    const bindings = this.resolveWarehouseFlowBindings(runtimeEntry);
    if (!bindings) return;
    const inboundModel = this.findModelByWarehouseBinding(runtimeEntry, bindings.inbound, 'conveyor');
    const stackerModel = this.findModelByWarehouseBinding(runtimeEntry, bindings.stacker, 'stacker');
    const outboundModel = this.findModelByWarehouseBinding(runtimeEntry, bindings.outbound, 'conveyor');
    const inboundAnchors = inboundModel ? this.resolveWarehouseConveyorAnchors(inboundModel) : null;
    const outboundAnchors = outboundModel ? this.resolveWarehouseConveyorAnchors(outboundModel) : null;
    const ttlMs = runtimeEntry.component.metadataTtlSeconds * 1000;
    const stackerSnapshot = this.resolveWarehouseBindingSnapshot(bindings.stacker, Date.now(), ttlMs);
    const state = runtimeEntry.warehouseCoordinator.getState();
    const stackerActivity = this.createWarehouseStackerActivity(runtimeEntry, stackerSnapshot);

    if (state.inbound && runtimeEntry.output) {
      const pose = this.resolveWarehouseInboundPose(
        state.inbound,
        inboundAnchors,
        stackerModel,
        stackerActivity,
      );
      if (pose) this.setWarehouseRootPose(runtimeEntry.root, pose.position, pose.rotation);
    }

    if (state.outbound) {
      const cargo = runtimeEntry.warehouseCargos.get(state.outbound.cargoCode);
      if (!cargo) return;
      const pose = this.resolveWarehouseOutboundPose(
        state.outbound,
        outboundAnchors,
        stackerModel,
        stackerActivity,
      );
      if (pose) this.setWarehouseRootPose(cargo.root, pose.position, pose.rotation);
    }
  }

  /** 解析入库货物在 1004、DDJ2 货叉和目标库位之间的世界姿态。 */
  private resolveWarehouseInboundPose(
    state: WarehouseInboundState,
    inboundAnchors: WarehouseConveyorAnchors | null,
    stackerModel: ModelRuntimeEntry | null,
    stackerActivity: WarehouseStackerActivity | null,
  ): { position: Vector3; rotation: Quaternion } | null {
    if (state.phase === 'inbound-front'
      || state.phase === 'inbound-transfer'
      || state.phase === 'inbound-back'
      || state.phase === 'inbound-lifting') {
      if (!inboundAnchors) return null;
      const conveyorPath = this.resolveWarehouseConveyorPath(inboundAnchors, 'front-to-back');
      return {
        position: this.lerpVector(conveyorPath.start, conveyorPath.end, state.progress),
        rotation: inboundAnchors.rotation,
      };
    }
    if (!stackerModel || !stackerActivity || !state.stackerSide) return null;
    const forkPosition = this.getWarehouseStackerForkSupportPosition(stackerModel, state.stackerSide);
    const stackerRotation = this.getNodeWorldRotation(stackerModel.root);
    if (state.phase === 'inbound-pickup') {
      const retracting = stackerActivity.movementZ === 2 || stackerActivity.movementZ === 4;
      const picked = stackerActivity.command === 2 || retracting;
      if (!picked && inboundAnchors) {
        const conveyorPath = this.resolveWarehouseConveyorPath(inboundAnchors, 'front-to-back');
        return { position: conveyorPath.end, rotation: inboundAnchors.rotation };
      }
      return { position: forkPosition, rotation: stackerRotation };
    }
    if (state.phase === 'inbound-carrying') {
      return { position: forkPosition, rotation: stackerRotation };
    }

    const locator = state.targetLocationKey ? this.locatorTargets.get(state.targetLocationKey) ?? null : null;
    if (!locator) return { position: forkPosition, rotation: stackerRotation };
    const reach = this.readStackerForkReachConfig(stackerModel);
    const forkOffset = state.stackerSide === 'front'
      ? stackerModel.stackerTelemetry.frontForkOffset
      : stackerModel.stackerTelemetry.backForkOffset;
    const placingProgress = this.getStackerCargoPlacingProgress(stackerActivity.command, forkOffset, reach);
    const locatorPosition = this.getWarehouseLocatorSupportPosition(locator);
    return {
      position: this.lerpVector(forkPosition, locatorPosition, placingProgress),
      rotation: placingProgress >= 1 ? this.getNodeWorldRotation(locator.root) : stackerRotation,
    };
  }

  /** 解析出库货物从库位、DDJ2 到 1005 前端的世界姿态。 */
  private resolveWarehouseOutboundPose(
    state: WarehouseOutboundState,
    outboundAnchors: WarehouseConveyorAnchors | null,
    stackerModel: ModelRuntimeEntry | null,
    stackerActivity: WarehouseStackerActivity | null,
  ): { position: Vector3; rotation: Quaternion } | null {
    if (state.phase === 'outbound-transfer' || state.phase === 'outbound-front') {
      if (!outboundAnchors) return null;
      const conveyorPath = this.resolveWarehouseConveyorPath(outboundAnchors, 'back-to-front');
      return {
        position: this.lerpVector(conveyorPath.start, conveyorPath.end, state.progress),
        rotation: outboundAnchors.rotation,
      };
    }
    if (state.phase === 'outbound-lowering') {
      if (!outboundAnchors) return null;
      const conveyorPath = this.resolveWarehouseConveyorPath(outboundAnchors, 'back-to-front');
      return { position: conveyorPath.start, rotation: outboundAnchors.rotation };
    }
    if (!stackerModel || !state.stackerSide) return null;
    const forkPosition = this.getWarehouseStackerForkSupportPosition(stackerModel, state.stackerSide);
    const stackerRotation = this.getNodeWorldRotation(stackerModel.root);
    if (state.phase === 'outbound-carrying') {
      return { position: forkPosition, rotation: stackerRotation };
    }
    if (state.phase === 'outbound-handoff') {
      if (!outboundAnchors) return { position: forkPosition, rotation: stackerRotation };
      const conveyorPath = this.resolveWarehouseConveyorPath(outboundAnchors, 'back-to-front');
      return {
        position: this.lerpVector(forkPosition, conveyorPath.start, state.progress),
        rotation: state.progress >= 1 ? outboundAnchors.rotation : stackerRotation,
      };
    }

    const locator = this.locatorTargets.get(state.sourceLocatorKey) ?? null;
    if (!locator) return { position: forkPosition, rotation: stackerRotation };
    const locatorPosition = this.getWarehouseLocatorSupportPosition(locator);
    const retracting = stackerActivity?.movementZ === 2 || stackerActivity?.movementZ === 4;
    const picked = stackerActivity?.command === 2 || retracting;
    return picked
      ? { position: forkPosition, rotation: stackerRotation }
      : { position: locatorPosition, rotation: this.getNodeWorldRotation(locator.root) };
  }

  /** 从 YZJ 物流方向 metadata 和真实几何计算入/出料、MQTT 前/后端锚点。 */
  private resolveWarehouseConveyorAnchors(model: ModelRuntimeEntry): WarehouseConveyorAnchors | null {
    const sides = this.readWarehouseConveyorFlowSides(model);
    const pathBounds = this.getModelWorldBounds(model);
    if (!sides || !pathBounds) return null;
    const supportNodes = this.findModelNodesByName(model, ['Ban.4', 'GT.3']);
    const supportBounds = this.getNodesWorldBounds(supportNodes) ?? pathBounds;
    const pathCenter = pathBounds.minimum.add(pathBounds.maximum).scale(0.5);
    pathCenter.y = supportBounds.maximum.y + 0.01;
    const infeed = this.createWarehouseConveyorSideAnchor(model.root, pathBounds, pathCenter, sides.infeed);
    const outfeed = this.createWarehouseConveyorSideAnchor(model.root, pathBounds, pathCenter, sides.outfeed);
    const mqttFront = sides.mqttFront
      ? this.createWarehouseConveyorSideAnchor(model.root, pathBounds, pathCenter, sides.mqttFront)
      : null;
    const mqttBack = sides.mqttBack
      ? this.createWarehouseConveyorSideAnchor(model.root, pathBounds, pathCenter, sides.mqttBack)
      : null;
    const spanMeters = sides.hasExplicitMqttEndpoints && mqttFront && mqttBack
      ? Vector3.Distance(mqttFront, mqttBack)
      : Vector3.Distance(infeed, outfeed);
    if (!Number.isFinite(spanMeters) || spanMeters <= 0.05) return null;
    return {
      infeed,
      outfeed,
      mqttFront,
      mqttBack,
      hasExplicitMqttEndpoints: sides.hasExplicitMqttEndpoints,
      spanMeters,
      rotation: this.getNodeWorldRotation(model.root),
    };
  }

  /** 读取全部物流 metadata 后再回退脚本参数，避免旧节点提前掩盖新 MQTT 前后端。 */
  private readWarehouseConveyorFlowSides(model: ModelRuntimeEntry): WarehouseConveyorSides | null {
    let metadataInfeed: WarehouseConveyorSides['infeed'] | null = null;
    let metadataOutfeed: WarehouseConveyorSides['outfeed'] | null = null;
    let metadataMqttFront: WarehouseConveyorSides['infeed'] | null = null;
    let metadataMqttBack: WarehouseConveyorSides['outfeed'] | null = null;
    let hasExplicitMetadataEndpoints = false;

    for (const node of this.getModelTransformNodes(model)) {
      const metadata = this.isPlainRecord(node.metadata) ? node.metadata : {};
      const logisticsFlow = this.isPlainRecord(metadata.logisticsFlow) ? metadata.logisticsFlow : null;
      if (!logisticsFlow) continue;

      const hasInfeed = Object.hasOwn(logisticsFlow, 'infeedSide');
      const hasOutfeed = Object.hasOwn(logisticsFlow, 'outfeedSide');
      if (hasInfeed || hasOutfeed) {
        const infeed = logisticsFlow.infeedSide;
        const outfeed = logisticsFlow.outfeedSide;
        if (!this.isWarehouseTransferSide(infeed) || !this.isWarehouseTransferSide(outfeed)) return null;
        if ((metadataInfeed !== null && metadataInfeed !== infeed)
          || (metadataOutfeed !== null && metadataOutfeed !== outfeed)) {
          return null;
        }
        metadataInfeed = infeed;
        metadataOutfeed = outfeed;
      }

      const hasMqttFront = Object.hasOwn(logisticsFlow, 'frontSide');
      const hasMqttBack = Object.hasOwn(logisticsFlow, 'backSide');
      if (hasMqttFront || hasMqttBack) {
        const mqttFront = logisticsFlow.frontSide;
        const mqttBack = logisticsFlow.backSide;
        if (!hasMqttFront
          || !hasMqttBack
          || !this.isWarehouseTransferSide(mqttFront)
          || !this.isWarehouseTransferSide(mqttBack)
          || mqttFront === mqttBack) {
          return null;
        }
        if (hasExplicitMetadataEndpoints
          && (metadataMqttFront !== mqttFront || metadataMqttBack !== mqttBack)) {
          return null;
        }
        metadataMqttFront = mqttFront;
        metadataMqttBack = mqttBack;
        hasExplicitMetadataEndpoints = true;
      }
    }

    const parameterInfeed = this.readModelScriptString(model, 'infeedSide');
    const parameterOutfeed = this.readModelScriptString(model, 'outfeedSide');
    const infeed = metadataInfeed ?? parameterInfeed;
    const outfeed = metadataOutfeed ?? parameterOutfeed;
    if (!this.isWarehouseTransferSide(infeed) || !this.isWarehouseTransferSide(outfeed)) return null;
    if (hasExplicitMetadataEndpoints) {
      return this.createWarehouseConveyorSides(infeed, outfeed, metadataMqttFront, metadataMqttBack);
    }

    const parameterMqttFront = this.readModelScriptString(model, 'frontSide');
    const parameterMqttBack = this.readModelScriptString(model, 'backSide');
    return this.createWarehouseConveyorSides(infeed, outfeed, parameterMqttFront, parameterMqttBack);
  }

  /** 校验四向参数并区分旧包缺失映射与新包错误映射，错误映射必须 fail-closed。 */
  private createWarehouseConveyorSides(
    infeed: WarehouseConveyorSides['infeed'],
    outfeed: WarehouseConveyorSides['outfeed'],
    mqttFront: unknown,
    mqttBack: unknown,
  ): WarehouseConveyorSides | null {
    const hasAnyMqttEndpoint = mqttFront !== null && mqttFront !== undefined && mqttFront !== ''
      || mqttBack !== null && mqttBack !== undefined && mqttBack !== '';
    if (!hasAnyMqttEndpoint) {
      return { infeed, outfeed, mqttFront: null, mqttBack: null, hasExplicitMqttEndpoints: false };
    }
    if (!this.isWarehouseTransferSide(mqttFront)
      || !this.isWarehouseTransferSide(mqttBack)
      || mqttFront === mqttBack) {
      return null;
    }
    return { infeed, outfeed, mqttFront, mqttBack, hasExplicitMqttEndpoints: true };
  }

  /** 按仓储角色选择空间路径：入库前到后，出库后到前；旧包保持入料到出料。 */
  private resolveWarehouseConveyorPath(
    anchors: WarehouseConveyorAnchors,
    direction: 'front-to-back' | 'back-to-front',
  ): { start: Vector3; end: Vector3 } {
    if (!anchors.hasExplicitMqttEndpoints || !anchors.mqttFront || !anchors.mqttBack) {
      return { start: anchors.infeed, end: anchors.outfeed };
    }
    return direction === 'front-to-back'
      ? { start: anchors.mqttFront, end: anchors.mqttBack }
      : { start: anchors.mqttBack, end: anchors.mqttFront };
  }

  /** 按模型局部方向把世界包围盒投影端点转换为货物支撑点。 */
  private createWarehouseConveyorSideAnchor(
    root: TransformNode,
    bounds: RuntimeWorldBounds,
    center: Vector3,
    side: string,
  ): Vector3 {
    const direction = this.getWarehouseTransferSideDirection(root, side);
    const projectedBounds = this.projectWorldBoundsOntoAxis(bounds, direction);
    const centerProjection = Vector3.Dot(center, direction);
    const span = Math.max(0, projectedBounds.max - projectedBounds.min);
    const margin = Math.min(0.18, span * 0.08);
    return center.add(direction.scale(projectedBounds.max - centerProjection - margin));
  }

  /** 将 YZJ left/right/front/rear 映射为模型旋转后的世界方向。 */
  private getWarehouseTransferSideDirection(root: TransformNode, side: string): Vector3 {
    if (side === 'right') return this.getModelAxis(root, 'x').scale(-1);
    if (side === 'front') return this.getModelAxis(root, 'z').scale(-1);
    if (side === 'rear') return this.getModelAxis(root, 'z');
    return this.getModelAxis(root, 'x');
  }

  /** 判断字符串是否为 YZJ 支持的四向物流侧。 */
  private isWarehouseTransferSide(value: unknown): value is 'left' | 'right' | 'front' | 'rear' {
    return value === 'left' || value === 'right' || value === 'front' || value === 'rear';
  }

  /** 从模型脚本参数 metadata 中读取字符串值。 */
  private readModelScriptString(model: ModelRuntimeEntry, key: string): string | null {
    const scripts = Array.isArray(model.contentRoot.metadata?.scripts) ? model.contentRoot.metadata.scripts : [];
    for (const script of scripts) {
      if (!this.isPlainRecord(script)) continue;
      const values = this.isPlainRecord(script.values) ? script.values : {};
      const raw = values[key];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (this.isPlainRecord(raw) && typeof raw.value === 'string' && raw.value.trim()) return raw.value.trim();
    }
    return null;
  }

  /** 读取指定货叉整组节点的顶面支撑点，使任意生成模型以底面贴合货叉。 */
  private getWarehouseStackerForkSupportPosition(model: ModelRuntimeEntry, side: StackerForkSide): Vector3 {
    const groups = this.findStackerForkNodeGroups(model);
    const bounds = this.getNodesWorldBounds(side === 'front' ? groups.frontNodes : groups.backNodes);
    if (!bounds) return model.root.getAbsolutePosition();
    return new Vector3(
      (bounds.minimum.x + bounds.maximum.x) / 2,
      bounds.maximum.y + 0.01,
      (bounds.minimum.z + bounds.maximum.z) / 2,
    );
  }

  /** 使用 locator 盒体底面作为生成模型原点，保证模型落在定位框内部而不是悬在中心高度。 */
  private getWarehouseLocatorSupportPosition(locator: LocatorRuntimeEntry): Vector3 {
    const bounds = locator.boxes.length > 0 ? this.getMeshWorldBounds(locator.boxes[0]) : null;
    const position = locator.root.getAbsolutePosition();
    return new Vector3(position.x, bounds?.minimum.y ?? position.y, position.z);
  }

  /** 设置仓储货物根节点世界姿态；根节点无父级，因此可直接写入。 */
  private setWarehouseRootPose(root: TransformNode, position: Vector3, rotation: Quaternion): void {
    root.position.copyFrom(position);
    root.rotationQuaternion = rotation.clone();
    root.computeWorldMatrix(true);
  }

  /** 将自动货物输出根节点恢复到无位姿基线，避免继承 POI 配置标记 Transform。 */
  private resetGeneratedOutputRoot(root: TransformNode): void {
    root.position.copyFromFloats(0, 0, 0);
    root.scaling.copyFromFloats(1, 1, 1);
    root.rotation.copyFromFloats(0, 0, 0);
    root.rotationQuaternion = Quaternion.Identity();
    root.computeWorldMatrix(true);
  }

  /** 根据模型脚本 dataDriven.motion 配置驱动 Conveyor 节点。 */
  private applyConveyorMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    for (const config of this.readConveyorMotionConfigs(model)) {
      const direction = this.readConveyorMotionDirection(snapshot, config);
      if (direction === 0) continue;

      const nodes = this.findConveyorMotionNodes(model, config);
      if (nodes.length === 0) continue;

      if (config.kind === 'rotate') {
        const speed = this.readConveyorRotationSpeed(snapshot, config);
        this.rotateConveyorNodes(nodes, config.axis, direction * speed * deltaSeconds);
      } else {
        const nextOffset = this.updateConveyorMotionOffset(model, config, direction * config.speed * deltaSeconds);
        this.translateConveyorNodesFromBaseline(model, nodes, config.axis, nextOffset);
      }
    }
  }

  /** 根据 containerCode 或 container_quantity 创建输送线上只存在于运行时的货物盒。 */
  private applyConveyorCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    if (this.isWarehouseFlowManagedModel(model, 'conveyor')) {
      this.disposeConveyorCargoForAssetCode(model.assetCode);
      model.conveyorTelemetry.cargoCode = null;
      model.conveyorTelemetry.cargoTravelOffset = 0;
      return;
    }

    const containerCode = this.readContainerCode(snapshot, 'containerCode');
    const containerQuantity = readNumberField(snapshot.fields, 'container_quantity') ?? 0;
    const activeContainerCode = containerCode ?? (containerQuantity > 0 ? CONVEYOR_ANONYMOUS_CARGO_CODE : null);
    if (!activeContainerCode) {
      this.disposeConveyorCargoForAssetCode(model.assetCode);
      model.conveyorTelemetry.cargoCode = null;
      return;
    }
    if (model.conveyorTelemetry.cargoCode && model.conveyorTelemetry.cargoCode !== activeContainerCode) {
      this.disposeConveyorCargoForAssetCode(model.assetCode);
    }

    const movementDirection = this.readConveyorMovementDirection(readIntegerField(snapshot.fields, 'movement_x'));
    if (!snapshot.faulted && movementDirection !== 0) {
      model.conveyorTelemetry.cargoTravelOffset = this.wrapConveyorOffset(
        model.conveyorTelemetry.cargoTravelOffset + movementDirection * CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND * deltaSeconds,
      );
    }

    const cargo = this.getOrCreateConveyorCargo(model.assetCode, activeContainerCode);
    this.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot);
    this.setGeneratedCargoRootPose(
      cargo,
      this.getConveyorCargoPosition(model),
      this.getNodeWorldRotation(model.root),
    );
    model.conveyorTelemetry.cargoCode = activeContainerCode;
  }

  /** 按货叉初始世界锚点把 Locator 绝对坐标换算成运行时偏移。 */
  private resolveStackerTargetMotionOffsets(model: ModelRuntimeEntry, targetPosition: Vector3) {
    const referencePosition = this.getStackerTargetReferencePosition(model);
    const travelAxis = this.getHorizontalModelAxis(model.root, 'z');
    return resolveStackerStorageTargetOffsets({
      targetTravelCoordinate: Vector3.Dot(targetPosition, travelAxis),
      targetLiftCoordinate: targetPosition.y,
      referenceTravelCoordinate: Vector3.Dot(referencePosition, travelAxis),
      referenceLiftCoordinate: referencePosition.y,
    });
  }

  /** 目标位变化时在 Console 打印一次行走/升降/货叉投影距离，便于联调核对格口级目标。 */
  private reportStackerTargetProjection(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    targetOffsets: StackerStorageTargetOffsets | null,
    toX: number | null,
    toY: number | null,
  ): void {
    const signature = targetLocator && targetPosition
      ? `${targetLocator.assetId}:${toX}:${toY}:${targetPosition.x.toFixed(3)}:${targetPosition.y.toFixed(3)}:${targetPosition.z.toFixed(3)}`
      : 'none';
    if (this.lastReportedStackerTargetSignatures.get(model.assetCode) === signature) return;
    this.lastReportedStackerTargetSignatures.set(model.assetCode, signature);
    if (!targetLocator || !targetPosition || !targetOffsets) return;

    const forkAxis = this.getModelAxis(model.root, 'x');
    const referencePosition = this.getStackerTargetReferencePosition(model);
    const forkProjection = Math.abs(Vector3.Dot(targetPosition.subtract(referencePosition), forkAxis));
    const reach = this.readStackerForkReachConfig(model);
    const stageLabel = forkProjection > reach.stageOne + 0.001 ? '两段' : '一段';
    this.pushLog(
      `堆垛机 ${model.assetCode} 目标 ${targetLocator.assetId}（列${toX} 层${toY}）：` +
      `box 支撑位 (${targetPosition.x.toFixed(3)}, ${targetPosition.y.toFixed(3)}, ${targetPosition.z.toFixed(3)})，` +
      `行走投影偏移 ${targetOffsets.travelOffset.toFixed(3)}m，升降投影偏移 ${targetOffsets.liftOffset.toFixed(3)}m，` +
      `货叉投影距离 ${forkProjection.toFixed(3)}m（一段行程 ${reach.stageOne}m，判定${stageLabel}）。`,
    );
  }

  /** 读取并缓存前后一段货叉的初始世界中心，缺失货叉时回退到载货台。 */
  private getStackerTargetReferencePosition(model: ModelRuntimeEntry): Vector3 {
    const state = model.stackerTelemetry;
    if (state.targetReferencePosition) return state.targetReferencePosition;

    const forkGroups = this.findStackerForkNodeGroups(model);
    const forkNodes = this.uniqueTransformNodes([
      ...forkGroups.frontStageOneNodes,
      ...forkGroups.backStageOneNodes,
    ]);
    const bounds = this.getNodesWorldBounds(forkNodes)
      ?? this.getNodesWorldBounds(this.findStackerPlatformNodes(model));
    state.targetReferencePosition = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : state.rootBasePosition.clone();
    return state.targetReferencePosition;
  }

  /** 根据 distance_x 校准行走机构虚拟位置，并在有目标位或 movement_x 时沿轨道推进。 */
  private applyStackerRootMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetTravelOffset: number | null,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const travelAxis = this.getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    const distanceX = readNumberField(snapshot.fields, 'distance_x');
    if (distanceX !== null && targetTravelOffset === null) {
      const calibratedPosition = state.rootBasePosition.add(travelAxis.scale(distanceX));
      state.rootPosition = this.lerpVector(
        state.rootPosition,
        this.constrainStackerTravelPosition(model, calibratedPosition, travelAxis),
        this.getCalibrationAlpha(deltaSeconds),
      );
    }

    if (!snapshot.faulted) {
      if (targetTravelOffset !== null) {
        const rootTargetPosition = this.constrainStackerTravelPosition(
          model,
          state.rootBasePosition.add(travelAxis.scale(targetTravelOffset)),
          travelAxis,
        );
        const forkMoving = (readIntegerField(snapshot.fields, 'front_movement_z') ?? 0) !== 0
          || (readIntegerField(snapshot.fields, 'back_movement_z') ?? 0) !== 0;
        if (forkMoving) {
          state.rootPosition = rootTargetPosition;
        } else {
          state.rootPosition = this.moveVectorTowards(
            state.rootPosition,
            rootTargetPosition,
            STACKER_TARGET_SPEED_METERS_PER_SECOND * deltaSeconds,
          );
        }
      } else {
        const direction = this.readTravelDirection(readIntegerField(snapshot.fields, 'movement_x'));
        const speed = this.readSpeed(snapshot, 'rpm_x', STACKER_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND);
        if (direction !== 0) {
          state.rootPosition = state.rootPosition.add(travelAxis.scale(direction * speed * deltaSeconds));
        }
      }
    }

    state.rootPosition = this.constrainStackerTravelPosition(model, state.rootPosition, travelAxis);
  }

  /** 根据 distance_y 校准载货台高度，并按目标位层高或 movement_y 推进升降。 */
  private applyStackerLiftMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLiftOffset: number | null,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const distanceY = readNumberField(snapshot.fields, 'distance_y');
    if (distanceY !== null && targetLiftOffset === null) {
      state.liftOffset = this.lerpNumber(state.liftOffset, distanceY, this.getCalibrationAlpha(deltaSeconds));
    }

    if (!snapshot.faulted) {
      if (targetLiftOffset !== null) {
        const forkMoving = (readIntegerField(snapshot.fields, 'front_movement_z') ?? 0) !== 0
          || (readIntegerField(snapshot.fields, 'back_movement_z') ?? 0) !== 0;
        if (forkMoving) {
          state.liftOffset = targetLiftOffset;
        } else {
          state.liftOffset = this.moveNumberTowards(
            state.liftOffset,
            targetLiftOffset,
            STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND * deltaSeconds,
          );
        }
      } else {
        const direction = this.readLiftDirection(readIntegerField(snapshot.fields, 'movement_y'));
        const speed = this.readSpeed(snapshot, 'rpm_y', STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND);
        state.liftOffset = Math.max(0, state.liftOffset + direction * speed * deltaSeconds);
      }
    }

  }

  /** 根据前后叉编码值和 movement_z 信号分别驱动两组货叉伸缩。 */
  private applyStackerForkMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetPosition: Vector3 | null,
    deltaSeconds: number,
    targetLocator: LocatorRuntimeEntry | null,
  ): void {
    const frontMovement = readIntegerField(snapshot.fields, 'front_movement_z');
    const backMovement = readIntegerField(snapshot.fields, 'back_movement_z');
    const frontForkSpeed = this.readSpeed(snapshot, 'front_rpm_z', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const backForkSpeed = this.readSpeed(snapshot, 'back_rpm_z', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const reach = this.readStackerForkReachConfig(model);
    const targetForkReach = snapshot.hasTargetLocation && targetLocator
      ? resolveStackerStorageForkReach(targetLocator.storageDepth, reach.stageOne, reach.stageTwo)
      : null;
    const state = model.stackerTelemetry;

    state.frontForkOffset = this.updateForkOffset(
      state.frontForkOffset,
      this.resolveForkCalibrationDistance(
        model,
        'front',
        targetPosition,
        this.resolveTargetLocatorForkDistance(targetForkReach, frontMovement),
      ),
      frontMovement,
      frontForkSpeed,
      targetForkReach ?? reach.total,
      deltaSeconds,
      snapshot.faulted,
      (direction) => {
        state.frontForkDirection = direction;
      },
      state.frontForkDirection,
    );
    state.backForkOffset = this.updateForkOffset(
      state.backForkOffset,
      this.resolveForkCalibrationDistance(
        model,
        'back',
        targetPosition,
        this.resolveTargetLocatorForkDistance(targetForkReach, backMovement),
      ),
      backMovement,
      backForkSpeed,
      targetForkReach ?? reach.total,
      deltaSeconds,
      snapshot.faulted,
      (direction) => {
        state.backForkDirection = direction;
      },
      state.backForkDirection,
    );

  }

  /** 更新单侧货叉偏移：编码器/目标投影优先校准，movement_z 只在没有距离时兜底。 */
  private updateForkOffset(
    currentOffset: number,
    distance: number | null,
    movement: number | null,
    speed: number,
    maxReach: number,
    deltaSeconds: number,
    faulted: boolean,
    rememberDirection: (direction: number) => void,
    lastDirection: number,
  ): number {
    let nextOffset = currentOffset;
    const movementDirection = this.readForkDirection(movement, nextOffset);
    if (movementDirection === 1 || movementDirection === -1) rememberDirection(movementDirection);

    if (distance !== null) {
      const calibrationDirection = Math.sign(distance) || Math.sign(nextOffset) || lastDirection || 1;
      nextOffset = this.lerpNumber(
        nextOffset,
        this.clampNumber(Math.abs(distance), 0, maxReach) * calibrationDirection,
        this.getCalibrationAlpha(deltaSeconds),
      );
      return this.clampForkOffset(nextOffset, maxReach);
    }

    if (faulted) return this.clampForkOffset(nextOffset, maxReach);

    if (movement === 2 || movement === 4) {
      return this.moveNumberTowards(this.clampForkOffset(nextOffset, maxReach), 0, speed * deltaSeconds);
    }

    return this.clampForkOffset(nextOffset + movementDirection * speed * deltaSeconds, maxReach);
  }

  /** 读取模型脚本中的两段货叉行程配置，Inspector 参数优先于 dataDriven 默认值。 */
  private readStackerForkReachConfig(model: ModelRuntimeEntry): StackerForkReachConfig {
    const stageOne = this.readPositiveStackerModelNumber(
      model,
      'forkStageOneReach',
      this.readStackerDataDrivenNumber(model, ['motion', 'fork', 'stageOneReach']) ?? 0.8,
    );
    const stageTwo = this.readNonNegativeStackerModelNumber(
      model,
      'forkStageTwoReach',
      this.readStackerDataDrivenNumber(model, ['motion', 'fork', 'stageTwoReach']) ?? 0.8,
    );

    return {
      stageOne,
      stageTwo,
      total: Math.max(0, stageOne + stageTwo),
    };
  }

  /** 将货叉总偏移拆分成第一段和第二段，保留正负方向语义。 */
  private splitForkOffset(offset: number, reach: StackerForkReachConfig): StackerForkOffsetParts {
    const direction = Math.sign(offset) || 1;
    const absoluteOffset = this.clampNumber(Math.abs(offset), 0, reach.total);
    const stageOneDistance = Math.min(absoluteOffset, reach.stageOne);
    const stageTwoDistance = Math.max(0, absoluteOffset - reach.stageOne);

    return {
      totalOffset: absoluteOffset * direction,
      stageOneOffset: stageOneDistance * direction,
      stageTwoOffset: stageTwoDistance * direction,
      activeStage: stageTwoDistance > 0.001 ? 2 : (stageOneDistance > 0.001 ? 1 : 0),
    };
  }

  /** 将货叉偏移限制在两段总行程内。 */
  private clampForkOffset(offset: number, maxReach: number): number {
    const reach = Math.max(0, maxReach);
    return this.clampNumber(offset, -reach, reach);
  }

  /** 按目标定位框在模型局部 X 轴上的投影计算伸出距离，符号表示方向。 */
  private resolveForkCalibrationDistance(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    targetPosition: Vector3 | null,
    targetForkDistance: number | null,
  ): number | null {
    if (!targetPosition) return null;

    const forkGroups = this.findStackerForkNodeGroups(model);
    const candidateNodes = side === 'front'
      ? [forkGroups.frontStageOneNodes, forkGroups.frontStageTwoNodes, forkGroups.frontNodes]
      : [forkGroups.backStageOneNodes, forkGroups.backStageTwoNodes, forkGroups.backNodes];
    const forkBounds = this.getNodesWorldBounds(candidateNodes.find((n) => n.length > 0) ?? []);
    if (!forkBounds) return null;

    const forkCenter = forkBounds.minimum.add(forkBounds.maximum).scale(0.5);
    const forkAxis = this.getModelAxis(model.root, 'x');
    const projectedDistance = Vector3.Dot(targetPosition.subtract(forkCenter), forkAxis);
    if (!Number.isFinite(projectedDistance)) return null;

    if (targetForkDistance !== null) return Math.sign(projectedDistance) * targetForkDistance;
    return projectedDistance;
  }

  /** 根据 MQTT 动作信号或目标库位返回货叉伸出/归零距离。 */
  private resolveTargetLocatorForkDistance(targetForkReach: number | null, movement: number | null): number | null {
    if (targetForkReach === null) return null;
    if (movement === 2 || movement === 4) return 0;
    if (movement === 1 || movement === 3) return targetForkReach;
    if (targetForkReach > 0) return targetForkReach;
    return null;
  }

  /** 从 Stacker 脚本 metadata 或当前参数值读取正数参数。 */
  private readPositiveStackerModelNumber(model: ModelRuntimeEntry, key: string, fallback: number): number {
    const value = this.readStackerModelNumber(model, key);
    return value !== null && value > 0 ? value : fallback;
  }

  /** 从 Stacker 脚本 metadata 或当前参数值读取非负参数。 */
  private readNonNegativeStackerModelNumber(model: ModelRuntimeEntry, key: string, fallback: number): number {
    const value = this.readStackerModelNumber(model, key);
    return value !== null && value >= 0 ? value : fallback;
  }

  /** 读取模型脚本 values 中的数值字段。 */
  private readStackerModelNumber(model: ModelRuntimeEntry, key: string): number | null {
    const scripts = Array.isArray(model.contentRoot.metadata?.scripts) ? model.contentRoot.metadata.scripts : [];
    for (const script of scripts) {
      if (!this.isPlainRecord(script)) continue;
      const values = this.isPlainRecord(script.values) ? script.values : {};
      const rawValue = this.readWrappedNumber(values[key]);
      if (rawValue !== null) return rawValue;
    }

    return null;
  }

  /** 读取模型脚本 dataDriven 配置中的数值字段。 */
  private readStackerDataDrivenNumber(model: ModelRuntimeEntry, path: string[]): number | null {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const value = this.readNumberPath(dataDriven, path);
      if (value !== null) return value;
    }

    return null;
  }

  /** 兼容 meta.json 中 { value } 包装和普通数值。 */
  private readWrappedNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (this.isPlainRecord(value)) {
      const nestedValue = value.value ?? value.currentValue ?? value.defaultValue;
      if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) return nestedValue;
    }
    return null;
  }

  /** 根据前叉/后叉托盘条码驱动货物：取货时随叉运动，放货时进入目标定位线框。 */
  private applyStackerCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
  ): void {
    if (this.isWarehouseFlowManagedModel(model, 'stacker')) {
      this.disposeStackerCargoForAssetCode(model.assetCode);
      return;
    }

    const frontContainerCode = this.readContainerCode(snapshot, 'front_containerCode');
    const backContainerCode = this.readContainerCode(snapshot, 'back_containerCode');

    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, targetPosition, 'front', frontContainerCode);
    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, targetPosition, 'back', backContainerCode);
  }

  /** 让指定货叉上的托盘在叉尖和目标 locator 之间运动，放货完成后留在 locator 内。 */
  private applyStackerForkCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    side: StackerForkSide,
    containerCode: string | null,
  ): void {
    const command = readIntegerField(snapshot.fields, side === 'front' ? 'front_command' : 'back_command');
    const activeContainerCode = this.resolveStackerForkCargoCode(model, side, containerCode, command, targetLocator);
    if (!activeContainerCode) return;

    const cargo = this.getOrCreateStackerCargo(model.assetCode, activeContainerCode);
    this.syncGeneratedCargoVisual(cargo, 'stacker', snapshot);
    const forkPosition = this.getStackerForkCargoPosition(model, side);
    const supportPosition = targetLocator
      ? targetPosition ?? this.getWarehouseLocatorSupportPosition(targetLocator)
      : null;
    const reach = this.readStackerForkReachConfig(model);
    const placingProgress = this.getStackerCargoPlacingProgress(command, side === 'front'
      ? model.stackerTelemetry.frontForkOffset
      : model.stackerTelemetry.backForkOffset, reach);
    const nextPosition = supportPosition && placingProgress > 0
      ? this.lerpVector(forkPosition, supportPosition, placingProgress)
      : forkPosition;

    const nextRotation = targetLocator && placingProgress >= 1
      ? this.getNodeWorldRotation(targetLocator.root)
      : this.getNodeWorldRotation(model.root);
    this.setGeneratedCargoRootPose(cargo, nextPosition, nextRotation);
    if (supportPosition && placingProgress >= 1 && snapshot.targetLocationKey) {
      cargo.placedLocatorKey = snapshot.targetLocationKey;
      this.setStackerForkCargoCode(model, side, null);
    }
  }

  /** 读取托盘条码，空字符串表示当前叉没有可视化货物。 */
  private readContainerCode(snapshot: DeviceTelemetrySnapshot, key: string): string | null {
    const value = readStringField(snapshot.fields, key)?.trim();
    return value ? value : null;
  }

  /** 在条码清空但仍处于放货命令时，沿用上一帧货物编号完成落位。 */
  private resolveStackerForkCargoCode(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    containerCode: string | null,
    command: number | null,
    targetLocator: LocatorRuntimeEntry | null,
  ): string | null {
    if (containerCode) {
      const previousContainerCode = this.getStackerForkCargoCode(model, side);
      if (previousContainerCode && previousContainerCode !== containerCode) {
        this.disposeUnplacedStackerCargo(model.assetCode, previousContainerCode);
      }
      this.setStackerForkCargoCode(model, side, containerCode);
      return containerCode;
    }

    const previousContainerCode = this.getStackerForkCargoCode(model, side);
    if (previousContainerCode && targetLocator && this.isStackerCargoPlacingCommand(command)) {
      return previousContainerCode;
    }

    this.setStackerForkCargoCode(model, side, null);
    return null;
  }

  /** 判断当前货叉状态是否正在把货物交接到目标定位框。 */
  private isStackerCargoPlacingCommand(command: number | null): boolean {
    return command === 3 || command === 4 || command === 5;
  }

  /** 根据货物类型读取旧版 Box 回退尺寸和材质，保证无模板场景行为不变。 */
  private getGeneratedCargoFallbackSpec(kind: GeneratedCargoKind): {
    size: Vector3;
    color: string;
    emissiveColor: string;
  } {
    return kind === 'stacker'
      ? { size: STACKER_CARGO_SIZE, color: STACKER_CARGO_COLOR, emissiveColor: STACKER_CARGO_EMISSIVE_COLOR }
      : { size: CONVEYOR_CARGO_SIZE, color: CONVEYOR_CARGO_COLOR, emissiveColor: CONVEYOR_CARGO_EMISSIVE_COLOR };
  }

  /** 为普通自动货物创建旧版 Box 回退；root 表示底部支撑点，Mesh 局部上移半高。 */
  private ensureGeneratedCargoFallback(cargo: GeneratedCargoRuntimeEntry, kind: GeneratedCargoKind): void {
    if (cargo.fallback) return;
    const spec = this.getGeneratedCargoFallbackSpec(kind);
    const mesh = MeshBuilder.CreateBox(
      `${kind}_cargo_${this.sanitizeBabylonName(cargo.assetCode)}_${this.sanitizeBabylonName(cargo.containerCode)}`,
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
      runtimeAssetCode: cargo.containerCode,
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

  /** 根据全局生成器规则同步普通货物外观；无可用模板时回退旧版 Box。 */
  private syncGeneratedCargoVisual(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    snapshot: DeviceTelemetrySnapshot,
  ): void {
    const component = this.getActiveModelGenerator()?.component ?? null;
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

  /** 设置普通自动货物世界支撑点和朝向；root 无父级，不受 POI Transform 影响。 */
  private setGeneratedCargoRootPose(cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion): void {
    cargo.root.position.copyFrom(position);
    cargo.root.rotationQuaternion = rotation.clone();
    cargo.root.computeWorldMatrix(true);
    cargo.outputOwner && this.applyGeneratedOutputPresentation(cargo.outputOwner);
  }

  /** 创建或复用某个条码的堆垛机运行时货物。 */
  private getOrCreateStackerCargo(assetCode: string, containerCode: string): StackerCargoRuntimeEntry {
    const key = this.getStackerCargoKey(assetCode, containerCode);
    const existing = this.stackerCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `stacker_cargo_root_${this.sanitizeBabylonName(assetCode)}_${this.sanitizeBabylonName(containerCode)}`,
      this.scene,
    );
    const entry: StackerCargoRuntimeEntry = {
      assetCode,
      containerCode,
      root,
      outputOwner: null,
      fallback: null,
      placedLocatorKey: null,
    };
    this.stackerCargoMeshes.set(key, entry);
    return entry;
  }

  /** 货物跟随最远段叉节点包围盒中心，确保始终定位在货叉实际伸出位置而非全部叉节点几何中心。 */
  private getStackerForkCargoPosition(model: ModelRuntimeEntry, side: StackerForkSide): Vector3 {
    const forkGroups = this.findStackerForkNodeGroups(model);
    const stageTwoNodes = side === 'front' ? forkGroups.frontStageTwoNodes : forkGroups.backStageTwoNodes;
    const allNodes = side === 'front' ? forkGroups.frontNodes : forkGroups.backNodes;
    const nodes = stageTwoNodes.length > 0 ? stageTwoNodes : allNodes;
    const bounds = this.getNodesWorldBounds(nodes);
    if (!bounds) return model.root.getAbsolutePosition();

    const upAxis = this.getModelAxis(model.root, 'y');
    const legacyCenter = bounds.minimum
      .add(bounds.maximum)
      .scale(0.5)
      .add(upAxis.scale(STACKER_CARGO_SIZE.y * 0.75));
    return legacyCenter.subtract(upAxis.scale(STACKER_CARGO_SIZE.y / 2));
  }

  /** 放货中逐步进入目标框，放货完成时完全落入目标框。 */
  private getStackerCargoPlacingProgress(command: number | null, forkOffset: number, reach: StackerForkReachConfig): number {
    if (command === 5) return 1;
    if (command === 4) return 0.85;
    if (command === 3) return Math.max(0.45, Math.min(0.95, Math.abs(forkOffset) / Math.max(0.1, reach.total)));
    return 0;
  }

  /** 读取某侧货叉当前正在携带或放货中的托盘编号。 */
  private getStackerForkCargoCode(model: ModelRuntimeEntry, side: StackerForkSide): string | null {
    return side === 'front' ? model.stackerTelemetry.frontCargoCode : model.stackerTelemetry.backCargoCode;
  }

  /** 更新某侧货叉当前货物编号，只保存运行时内存状态。 */
  private setStackerForkCargoCode(model: ModelRuntimeEntry, side: StackerForkSide, containerCode: string | null): void {
    if (side === 'front') {
      model.stackerTelemetry.frontCargoCode = containerCode;
      return;
    }

    model.stackerTelemetry.backCargoCode = containerCode;
  }

  /** 清理还没有落位的旧货物，避免条码切换后遗留在叉尖半路。 */
  private disposeUnplacedStackerCargo(assetCode: string, containerCode: string): void {
    const key = this.getStackerCargoKey(assetCode, containerCode);
    const cargo = this.stackerCargoMeshes.get(key);
    if (!cargo || cargo.placedLocatorKey) return;

    this.disposeStackerCargo(cargo);
    this.stackerCargoMeshes.delete(key);
  }

  /** 读取任意节点的世界旋转，货物在叉上跟设备，落位后跟定位框。 */
  private getNodeWorldRotation(node: TransformNode): Quaternion {
    const rotation = Quaternion.Identity();
    node.computeWorldMatrix(true).decompose(undefined, rotation);
    return rotation;
  }

  /** 读取模型脚本声明的输送线运动配置，运行时只接受 devType=conveyor 的 dataDriven 配置。 */
  private readConveyorMotionConfigs(model: ModelRuntimeEntry): ConveyorMotionConfig[] {
    const configs: ConveyorMotionConfig[] = [];
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      if (!this.isPlainRecord(dataDriven)) continue;
      const deviceConfig = this.isPlainRecord(dataDriven.device) ? dataDriven.device : {};
      const devType = typeof deviceConfig.devType === 'string' ? deviceConfig.devType.trim().toLowerCase() : '';
      if (devType !== 'conveyor') continue;

      const motionConfig = this.isPlainRecord(dataDriven.motion) ? dataDriven.motion : null;
      if (!motionConfig) continue;

      for (const [key, rawConfig] of Object.entries(motionConfig)) {
        const config = this.readConveyorMotionConfig(key, rawConfig);
        if (config) configs.push(config);
      }
    }

    return configs;
  }

  /** 把单个 dataDriven.motion 配置归一成运行时可直接执行的输送线动作。 */
  private readConveyorMotionConfig(key: string, rawConfig: unknown): ConveyorMotionConfig | null {
    if (!this.isPlainRecord(rawConfig)) return null;

    const rawKind = typeof rawConfig.kind === 'string' ? rawConfig.kind.trim().toLowerCase() : '';
    if (rawKind !== 'rotate' && rawKind !== 'translate') return null;
    const kind: ConveyorMotionConfig['kind'] = rawKind;

    const rawAxis = typeof rawConfig.axis === 'string' ? rawConfig.axis.trim().toLowerCase() : '';
    const axis: ConveyorMotionConfig['axis'] = rawAxis === 'x' || rawAxis === 'y' || rawAxis === 'z'
      ? rawAxis
      : 'z';
    const fallbackSpeed = kind === 'rotate'
      ? CONVEYOR_DEFAULT_ROTATE_SPEED_DEGREES_PER_SECOND
      : CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND;
    const rawSpeed = typeof rawConfig.speed === 'number' ? rawConfig.speed : Number(rawConfig.speed);
    const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : fallbackSpeed;
    const fields = this.readStringArrayPath(rawConfig, ['fields']);
    const nodes = this.readStringArrayPath(rawConfig, ['nodes']);
    const rawFallbackPattern = typeof rawConfig.fallbackPattern === 'string' ? rawConfig.fallbackPattern.trim() : '';

    return {
      key,
      fields: fields.length > 0 ? fields : (kind === 'rotate' ? ['movement_x', 'rotation'] : ['movement_x']),
      kind,
      axis,
      actionMap: this.readConveyorActionMap(rawConfig.actionMap),
      speed,
      nodes,
      fallbackPattern: rawFallbackPattern || null,
    };
  }

  /** 读取 movement 编码映射，缺省遵循 0=停、1=正向、2=反向。 */
  private readConveyorActionMap(rawActionMap: unknown): Record<string, number> {
    const actionMap: Record<string, number> = { 0: 0, 1: 1, 2: -1 };
    if (!this.isPlainRecord(rawActionMap)) return actionMap;

    for (const [key, value] of Object.entries(rawActionMap)) {
      const numberValue = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(numberValue)) {
        actionMap[key] = numberValue;
      }
    }

    return actionMap;
  }

  /** 判断当前模型是否具备输送线驱动能力，脚本声明优先于文件名兜底识别。 */
  private isConveyorRuntimeModel(model: ModelRuntimeEntry): boolean {
    return model.conveyorCapable || this.readConveyorMotionConfigs(model).length > 0;
  }

  /** 通过模型包脚本、路径和资产编号兜底识别输送线模型。 */
  private isConveyorModelAsset(modelAsset: ModelAssetComponent): boolean {
    const signature = JSON.stringify([
      modelAsset.assetCode,
      modelAsset.sourcePath,
      modelAsset.sourceUrl,
      modelAsset.parameterScriptMetadata ?? [],
      modelAsset.animationScriptMetadata ?? [],
    ]).toLowerCase();

    return signature.includes('conveyor')
      || signature.includes('roller-conveyor')
      || signature.includes('chain-conveyor')
      || signature.includes('输送')
      || signature.includes('滚筒')
      || signature.includes('链条');
  }

  /** 创建输送线运行时状态，所有运动偏移和货物占位只保存在内存。 */
  private createConveyorTelemetryState(): ConveyorModelTelemetryState {
    return {
      cargoCode: null,
      cargoTravelOffset: 0,
      motionOffsets: new Map(),
      nodeBaselines: new Map(),
    };
  }

  /** 模型脚本或资产编号变化后重置输送线基线，避免旧节点偏移污染新模型。 */
  private resetConveyorTelemetryState(model: ModelRuntimeEntry): void {
    model.conveyorTelemetry.cargoCode = null;
    model.conveyorTelemetry.cargoTravelOffset = 0;
    model.conveyorTelemetry.motionOffsets.clear();
    model.conveyorTelemetry.nodeBaselines.clear();
  }

  /** 按 motion.fields 读取输送线方向，支持模型脚本自定义 actionMap。 */
  private readConveyorMotionDirection(snapshot: DeviceTelemetrySnapshot, config: ConveyorMotionConfig): number {
    for (const field of config.fields) {
      const fieldValue = readNumberField(snapshot.fields, field);
      if (fieldValue === null) continue;

      const mappedValue = config.actionMap[String(Math.trunc(fieldValue))];
      if (Number.isFinite(mappedValue)) return mappedValue;
      return this.readConveyorMovementDirection(fieldValue);
    }

    return 0;
  }

  /** 输送线 movement_x 编码：0 静止，1 正向，2 反向，正负数做现场兼容兜底。 */
  private readConveyorMovementDirection(value: number | null): number {
    if (value === 1) return 1;
    if (value === 2) return -1;
    if (value !== null && value > 0) return 1;
    if (value !== null && value < 0) return -1;
    return 0;
  }

  /** 读取滚筒角速度，rotation 大于 3 时按度/秒处理，否则沿用模型脚本默认速度。 */
  private readConveyorRotationSpeed(snapshot: DeviceTelemetrySnapshot, config: ConveyorMotionConfig): number {
    const rotationSpeed = readNumberField(snapshot.fields, 'rotation');
    const degreesPerSecond = rotationSpeed !== null && rotationSpeed > 3 ? rotationSpeed : config.speed;
    return degreesPerSecond * Math.PI / 180;
  }

  /** 查找输送线 motion 声明的节点，优先精确名称，失败后按 fallbackPattern 或通用名称兜底。 */
  private findConveyorMotionNodes(model: ModelRuntimeEntry, config: ConveyorMotionConfig): TransformNode[] {
    const configuredNodes = config.nodes.length > 0
      ? this.findConfiguredConveyorMotionNodes(model, config.nodes)
      : [];
    if (configuredNodes.length > 0) return this.filterTopLevelMotionNodes(configuredNodes);

    const fallbackPattern = this.createConveyorFallbackPattern(config.fallbackPattern);
    return fallbackPattern ? this.filterTopLevelMotionNodes(this.findModelNodes(model, fallbackPattern)) : [];
  }

  /**
   * 按 motion.nodes 收集原始节点及其参数化运行时克隆。
   * 参数脚本通过 metadata.motionSourceNodeName 声明克隆继承哪个源节点的遥测动作，
   * 同时兼容旧脚本已经写入的 metadata.sourceNodeName。
   */
  private findConfiguredConveyorMotionNodes(model: ModelRuntimeEntry, names: string[]): TransformNode[] {
    const nameSet = new Set(names);
    return this.getModelTransformNodes(model).filter((node) => {
      if (nameSet.has(String(node.name ?? ''))) return true;
      const sourceNodeName = this.readParametricMotionSourceNodeName(node);
      return sourceNodeName !== null && nameSet.has(sourceNodeName);
    });
  }

  /** 读取参数化克隆继承的源运动节点名，普通场景节点不会进入该兼容链路。 */
  private readParametricMotionSourceNodeName(node: TransformNode): string | null {
    if (!this.isPlainRecord(node.metadata) || node.metadata.generatedByParametricRuntime !== true) return null;
    const sourceNodeName = typeof node.metadata.motionSourceNodeName === 'string'
      ? node.metadata.motionSourceNodeName
      : typeof node.metadata.sourceNodeName === 'string'
        ? node.metadata.sourceNodeName
        : '';
    const normalizedName = sourceNodeName.trim();
    return normalizedName || null;
  }

  /** 创建模型脚本显式声明的兜底正则；未声明或非法时跳过，避免猜中静态结构。 */
  private createConveyorFallbackPattern(patternText: string | null): RegExp | null {
    if (!patternText) return null;
    try {
      return new RegExp(patternText, 'i');
    } catch {
      return null;
    }
  }

  /** 按局部轴旋转滚筒节点，兼容 GLB 节点使用 rotationQuaternion 的情况。 */
  private rotateConveyorNodes(nodes: TransformNode[], axis: 'x' | 'y' | 'z', radians: number): void {
    if (Math.abs(radians) <= 0.000001) return;
    const deltaRotation = Quaternion.RotationAxis(this.createLocalAxis(axis), radians);

    for (const node of nodes) {
      if (node.rotationQuaternion) {
        node.rotationQuaternion = node.rotationQuaternion.multiply(deltaRotation);
      } else {
        node.rotation[axis] += radians;
      }
    }
  }

  /** 更新链条平移偏移，使用循环偏移避免节点长期漂移到模型外。 */
  private updateConveyorMotionOffset(model: ModelRuntimeEntry, config: ConveyorMotionConfig, delta: number): number {
    const previousOffset = model.conveyorTelemetry.motionOffsets.get(config.key) ?? 0;
    const nextOffset = this.wrapConveyorOffset(previousOffset + delta);
    model.conveyorTelemetry.motionOffsets.set(config.key, nextOffset);
    return nextOffset;
  }

  /** 从首次驱动前的节点基线出发做局部轴平移，避免每帧累计误差。 */
  private translateConveyorNodesFromBaseline(
    model: ModelRuntimeEntry,
    nodes: TransformNode[],
    axis: 'x' | 'y' | 'z',
    offset: number,
  ): void {
    const localOffset = this.createLocalAxis(axis).scale(offset);
    for (const node of this.filterTopLevelMotionNodes(nodes)) {
      const baseline = this.getConveyorNodeBaseline(model, node);
      node.position = baseline.position.add(localOffset);
    }
  }

  /** 读取输送线节点基线，模型重新加载或脚本变化时会被 resetConveyorTelemetryState 清空。 */
  private getConveyorNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): ConveyorNodeBaseline {
    const existing = model.conveyorTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = { position: node.position.clone() };
    model.conveyorTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 把连续偏移约束在一个短循环内，适合链条和货物的运行时视觉表现。 */
  private wrapConveyorOffset(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const loop = CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS;
    const halfLoop = loop / 2;
    return ((((value + halfLoop) % loop) + loop) % loop) - halfLoop;
  }

  /** 创建或复用输送线运行时货物；可视模板不写入场景文档。 */
  private getOrCreateConveyorCargo(assetCode: string, containerCode: string): ConveyorCargoRuntimeEntry {
    const key = this.getConveyorCargoKey(assetCode, containerCode);
    const existing = this.conveyorCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `conveyor_cargo_root_${this.sanitizeBabylonName(assetCode)}_${this.sanitizeBabylonName(containerCode)}`,
      this.scene,
    );
    const entry: ConveyorCargoRuntimeEntry = {
      assetCode,
      containerCode,
      root,
      outputOwner: null,
      fallback: null,
    };
    this.conveyorCargoMeshes.set(key, entry);
    return entry;
  }

  /** 基于输送线几何包围盒计算货物底部支撑点，并沿输送方向加入短循环偏移。 */
  private getConveyorCargoPosition(model: ModelRuntimeEntry): Vector3 {
    const configuredNodes = this.readConveyorMotionConfigs(model).flatMap((config) => this.findConveyorMotionNodes(model, config));
    const conveyorNodes = configuredNodes.length > 0
      ? configuredNodes
      : this.findModelNodes(model, /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i);
    const bounds = (conveyorNodes.length > 0 ? this.getNodesWorldBounds(conveyorNodes) : null) ?? this.getModelWorldBounds(model);
    const center = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : model.root.getAbsolutePosition();
    const upAxis = this.getModelAxis(model.root, 'y');
    const legacyCenter = center.add(upAxis.scale(CONVEYOR_CARGO_SIZE.y * 0.75));
    const travelAxis = this.getHorizontalModelAxis(model.root, this.readConveyorCargoTravelAxis(model));

    return legacyCenter
      .subtract(upAxis.scale(CONVEYOR_CARGO_SIZE.y / 2))
      .add(travelAxis.scale(model.conveyorTelemetry.cargoTravelOffset));
  }

  /** 推断货物沿模型局部 x/z 哪个方向移动，滚筒线默认垂直于滚筒轴。 */
  private readConveyorCargoTravelAxis(model: ModelRuntimeEntry): 'x' | 'z' {
    const configs = this.readConveyorMotionConfigs(model);
    const translateConfig = configs.find((config) => config.kind === 'translate' && config.axis !== 'y');
    if (translateConfig?.axis === 'x' || translateConfig?.axis === 'z') return translateConfig.axis;

    const rotateConfig = configs.find((config) => config.kind === 'rotate');
    if (rotateConfig?.axis === 'x') return 'z';
    return 'x';
  }

  /** 生成输送线运行时货物的无歧义唯一键，允许设备编号和条码包含任意分隔符。 */
  private getConveyorCargoKey(assetCode: string, containerCode: string): string {
    return JSON.stringify([assetCode, containerCode]);
  }

  /** 删除指定输送线实例生成的运行时货物，不影响其他设备。 */
  private disposeConveyorCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.conveyorCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.disposeConveyorCargo(cargo);
      this.conveyorCargoMeshes.delete(key);
    }
  }

  /** 释放单个输送线运行时货物的模板、回退 Box 和支撑点根节点。 */
  private disposeConveyorCargo(cargo: ConveyorCargoRuntimeEntry): void {
    this.disposeGeneratedCargo(cargo);
  }

  /** 生成堆垛机运行时货物的无歧义唯一键，允许设备编号和条码包含任意分隔符。 */
  private getStackerCargoKey(assetCode: string, containerCode: string): string {
    return JSON.stringify([assetCode, containerCode]);
  }

  /** 写入通用设备 telemetry metadata，供脚本、调试面板和现场排查读取。 */
  private writeDeviceTelemetryMetadata(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): void {
    const telemetryMetadata = {
      deviceType: snapshot.deviceType,
      assetCode: snapshot.assetCode,
      payloadDeviceCode: snapshot.payloadDeviceCode,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedAt: snapshot.receivedAt,
      faulted: snapshot.faulted,
      message: snapshot.message,
      fields: { ...snapshot.fields },
    };

    model.root.metadata = {
      ...(model.root.metadata ?? {}),
      telemetry: telemetryMetadata,
    };
    model.contentRoot.metadata = {
      ...(model.contentRoot.metadata ?? {}),
      telemetry: telemetryMetadata,
    };
  }

  /** 写入堆垛机兼容 metadata，保留旧调试入口 stackerTelemetry。 */
  private writeStackerTelemetryMetadata(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
  ): void {
    const forkReach = this.readStackerForkReachConfig(model);
    const frontFork = this.splitForkOffset(model.stackerTelemetry.frontForkOffset, forkReach);
    const backFork = this.splitForkOffset(model.stackerTelemetry.backForkOffset, forkReach);
    const telemetryMetadata = {
      assetCode: snapshot.assetCode,
      payloadDeviceCode: snapshot.payloadDeviceCode,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedAt: snapshot.receivedAt,
      currentLocationKey: snapshot.currentLocationKey,
      targetLocationKey: snapshot.targetLocationKey,
      targetFound: Boolean(targetLocator),
      hasTargetLocation: snapshot.hasTargetLocation,
      faulted: snapshot.faulted,
      message: snapshot.message,
      fields: snapshot.fields,
      forkReach,
      forkOffsets: {
        front: frontFork,
        back: backFork,
      },
    };

    model.root.metadata = {
      ...(model.root.metadata ?? {}),
      stackerTelemetry: telemetryMetadata,
    };
    model.contentRoot.metadata = {
      ...(model.contentRoot.metadata ?? {}),
      stackerTelemetry: telemetryMetadata,
    };
  }

  /** 对故障和目标位缺失做一次性 Console 提示，避免每帧刷屏。 */
  private reportStackerRuntimeState(snapshot: StackerTelemetrySnapshot, targetLocator: LocatorRuntimeEntry | null): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const mode = readIntegerField(snapshot.fields, 'mode');
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const statusSignature = JSON.stringify([mode, frontCommand, backCommand, snapshot.message]);
    if (this.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.reportedStatuses.set(deviceKey, statusSignature);
      this.pushLog(
        `Stacker ${snapshot.assetCode} 状态：mode=${mode ?? '未知'}，front=${frontCommand ?? '未知'}，back=${backCommand ?? '未知'}${snapshot.message ? `，${snapshot.message}` : ''}`,
      );
    }

    if (snapshot.hasTargetLocation && !targetLocator && snapshot.targetLocationKey) {
      const missingTargetKey = `${deviceKey}:${snapshot.targetLocationKey}`;
      if (!this.reportedMissingTargets.has(missingTargetKey)) {
        this.reportedMissingTargets.add(missingTargetKey);
        this.pushLog(`Stacker ${snapshot.assetCode} 未找到目标定位线框：${snapshot.targetLocationKey}`);
      }
    }

    if (!snapshot.faulted) {
      this.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.reportedFaults.get(deviceKey) === faultMessage) return;

    this.reportedFaults.set(deviceKey, faultMessage);
    this.pushLog(`Stacker ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** 对输送线状态和故障做节流日志，实时字段仍完整写入 metadata。 */
  private reportConveyorRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const mode = readIntegerField(snapshot.fields, 'mode');
    const task = readIntegerField(snapshot.fields, 'task');
    const movementX = readIntegerField(snapshot.fields, 'movement_x');
    const statusSignature = JSON.stringify([mode, task, movementX, snapshot.message]);
    if (this.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.reportedStatuses.set(deviceKey, statusSignature);
      this.pushLog(
        `Conveyor ${snapshot.assetCode} 状态：mode=${mode ?? '未知'}，task=${task ?? '未知'}，movement_x=${movementX ?? '未知'}${snapshot.message ? `，${snapshot.message}` : ''}`,
      );
    }

    if (!snapshot.faulted) {
      this.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.reportedFaults.get(deviceKey) === faultMessage) return;

    this.reportedFaults.set(deviceKey, faultMessage);
    this.pushLog(`Conveyor ${snapshot.assetCode} 故障：${faultMessage}`);
  }

  /** 创建 stacker 遥测运行态，所有偏移都只保存在内存中。 */
  private createStackerTelemetryState(root: TransformNode): StackerModelTelemetryState {
    return {
      rootBasePosition: root.position.clone(),
      rootPosition: null,
      travelConstraint: null,
      targetReferencePosition: null,
      liftOffset: 0,
      frontForkOffset: 0,
      backForkOffset: 0,
      lastFrameTimeMs: performance.now(),
      frontForkDirection: 1,
      backForkDirection: 1,
      frontCargoCode: null,
      backCargoCode: null,
      nodeBaselines: new Map(),
      lastTargetKey: null,
    };
  }

  /** 通过模型包脚本、元数据或路径判断当前导入模型是否是 stacker。 */
  private isStackerModelAsset(modelAsset: ModelAssetComponent): boolean {
    const signature = JSON.stringify([
      modelAsset.assetCode,
      modelAsset.sourcePath,
      modelAsset.sourceUrl,
      modelAsset.parameterScriptMetadata ?? [],
      modelAsset.animationScriptMetadata ?? [],
    ]).toLowerCase();

    return signature.includes('stacker') || signature.includes('堆垛机');
  }

  /** 将行走、升降和货叉伸缩合成为每个节点的一次性世界偏移，避免重叠节点被后续动作覆盖。 */
  private applyStackerNodeMotionOffsets(model: ModelRuntimeEntry): void {
    const state = model.stackerTelemetry;
    const travelPosition = state.rootPosition ?? state.rootBasePosition;
    const travelWorldOffset = travelPosition.subtract(state.rootBasePosition);
    const liftWorldOffset = this.getModelAxis(model.root, 'y').scale(state.liftOffset);
    const forkAxis = this.getModelAxis(model.root, 'x');
    const forkReach = this.readStackerForkReachConfig(model);
    const frontOffset = this.splitForkOffset(state.frontForkOffset, forkReach);
    const backOffset = this.splitForkOffset(state.backForkOffset, forkReach);
    const {
      frontStageOneNodes,
      frontStageTwoNodes,
      backStageOneNodes,
      backStageTwoNodes,
    } = this.findStackerForkNodeGroups(model);
    const offsets = new Map<TransformNode, Vector3>();

    this.addStackerWorldOffset(offsets, this.filterTopLevelMotionNodes(this.findStackerTravelNodes(model)), travelWorldOffset);
    this.addStackerWorldOffset(offsets, this.filterTopLevelMotionNodes(this.findStackerLiftNodes(model)), liftWorldOffset);
    this.addStackerForkStageOffsets(offsets, frontStageOneNodes, frontStageTwoNodes, forkAxis, frontOffset);
    this.addStackerForkStageOffsets(offsets, backStageOneNodes, backStageTwoNodes, forkAxis, backOffset);
    this.setStackerForkStageTwoNodesEnabled(frontStageTwoNodes, Math.abs(frontOffset.stageTwoOffset) > 0.001);
    this.setStackerForkStageTwoNodesEnabled(backStageTwoNodes, Math.abs(backOffset.stageTwoOffset) > 0.001);
    this.offsetNodesFromBaselineByWorldOffsets(model, offsets);
  }

  /** 将单侧货叉总偏移拆到一段/二段节点；没有二段节点时保持旧模型整体伸缩行为。 */
  private addStackerForkStageOffsets(
    offsets: Map<TransformNode, Vector3>,
    stageOneNodes: TransformNode[],
    stageTwoNodes: TransformNode[],
    forkAxis: Vector3,
    offset: StackerForkOffsetParts,
  ): void {
    if (stageTwoNodes.length === 0) {
      this.addStackerWorldOffset(offsets, this.filterTopLevelMotionNodes(stageOneNodes), forkAxis.scale(offset.totalOffset));
      return;
    }

    this.addStackerWorldOffset(offsets, this.filterTopLevelMotionNodes(stageOneNodes), forkAxis.scale(offset.stageOneOffset));
    this.addStackerWorldOffset(offsets, this.filterTopLevelMotionNodes(stageTwoNodes), forkAxis.scale(offset.totalOffset));
  }

  /** 第二段收纳时隐藏克隆件，避免与第一段重叠产生闪烁；非 _stage2 标记的节点不参与显隐切换。 */
  private setStackerForkStageTwoNodesEnabled(nodes: TransformNode[], enabled: boolean): void {
    for (const node of nodes) {
      if (!this.isStackerForkStageTwoNode(node)) continue;
      node.setEnabled(enabled);
    }
  }

  /** 查找随水平行走机构移动的节点；优先使用模型脚本 dataDriven 声明，缺失时回退当前 Stacker GLB 名称。 */
  private findStackerTravelNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readStackerMotionNodeNames(model, 'travel');
    const configuredNodes = configuredNames.length > 0 ? this.findModelNodesByName(model, configuredNames) : [];
    if (configuredNodes.length > 0) {
      const forkGroups = this.findStackerForkNodeGroups(model);
      return this.excludeStackerFixedNodes(model, this.uniqueTransformNodes([
        ...configuredNodes,
        ...forkGroups.frontStageTwoNodes,
        ...forkGroups.backStageTwoNodes,
      ]));
    }

    const exactNodes = this.findModelNodesByName(model, STACKER_FALLBACK_TRAVEL_NODE_NAMES);
    if (exactNodes.length > 0) {
      return this.excludeStackerFixedNodes(model, exactNodes);
    }

    return this.excludeStackerFixedNodes(
      model,
      this.findModelNodes(model, /dingbuhuagui|dingbu|dibu|lizhu|dianji|caozuotai|xiang|huocha|顶部|底部|立柱|电机|操作台|载货|货叉/i),
    );
  }

  /** 查找模型脚本声明或当前 GLB 中的固定轨道节点，水平遥测不会直接写入这些节点。 */
  private findStackerFixedNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNodes = this.findModelNodesByName(model, this.readStackerFixedNodeNames(model));
    if (configuredNodes.length > 0) return configuredNodes;
    return this.findModelNodesByName(model, STACKER_FALLBACK_FIXED_NODE_NAMES);
  }

  /** 从候选运动节点中剔除固定轨道节点，避免上下轨道被 movement_x 带动。 */
  private excludeStackerFixedNodes(model: ModelRuntimeEntry, nodes: TransformNode[]): TransformNode[] {
    const fixedNodes = new Set(this.findStackerFixedNodes(model));
    return nodes.filter((node) => !fixedNodes.has(node));
  }

  /** 将行走虚拟位置限制在固定轨道范围内，避免目标位或编码器值把机体推出轨道端点。 */
  private constrainStackerTravelPosition(model: ModelRuntimeEntry, position: Vector3, travelAxis: Vector3): Vector3 {
    const state = model.stackerTelemetry;
    const projectedPosition = this.projectPointOntoAxis(state.rootBasePosition, travelAxis, position);
    const constraint = this.getStackerTravelConstraint(model, travelAxis);
    if (!constraint) return projectedPosition;

    const requestedDelta = Vector3.Dot(projectedPosition.subtract(state.rootBasePosition), constraint.axis);
    const minDelta = constraint.trackMin - constraint.movingMin;
    const maxDelta = constraint.trackMax - constraint.movingMax;
    const clampedDelta = minDelta <= maxDelta
      ? this.clampNumber(requestedDelta, minDelta, maxDelta)
      : (constraint.trackMin + constraint.trackMax - constraint.movingMin - constraint.movingMax) / 2;

    return state.rootBasePosition.add(constraint.axis.scale(clampedDelta));
  }

  /** 读取或创建 Stacker 轨道约束，固定轨道决定可行范围，行走机构基线决定端点余量。 */
  private getStackerTravelConstraint(model: ModelRuntimeEntry, travelAxis: Vector3): StackerTravelConstraint | null {
    const state = model.stackerTelemetry;
    if (state.travelConstraint && Vector3.Dot(state.travelConstraint.axis, travelAxis) > 0.999) {
      return state.travelConstraint;
    }

    const fixedBounds = this.getNodesProjectedBounds(this.findStackerFixedNodes(model), travelAxis);
    const movingBounds = this.getNodesProjectedBounds(this.findStackerTravelNodes(model), travelAxis);
    if (!fixedBounds || !movingBounds) return null;

    state.travelConstraint = {
      axis: travelAxis.clone(),
      trackMin: fixedBounds.min,
      trackMax: fixedBounds.max,
      movingMin: movingBounds.min,
      movingMax: movingBounds.max,
    };
    return state.travelConstraint;
  }

  /** 查找载货台和货叉节点，升降时这两类部件需要一起动。 */
  private findStackerLiftNodes(model: ModelRuntimeEntry): TransformNode[] {
    return this.uniqueTransformNodes([
      ...this.findStackerPlatformNodes(model),
      ...this.findStackerForkNodeGroups(model).frontNodes,
      ...this.findStackerForkNodeGroups(model).backNodes,
    ]);
  }

  /** 查找 stacker 载货台节点。 */
  private findStackerPlatformNodes(model: ModelRuntimeEntry): TransformNode[] {
    const namedNodes = this.findModelNodesByName(model, ['xiang.13']);
    return namedNodes.length > 0 ? namedNodes : this.findModelNodes(model, /platform|cargo|bay|xiang|台|仓/i);
  }

  /** 查找前后货叉节点，精确命名优先，名称变化时按顺序兜底。 */
  private findStackerForkNodeGroups(model: ModelRuntimeEntry): StackerForkNodeGroups {
    const exactFrontStageOneNodes = this.findModelNodesByName(model, ['huocha.9']).filter((node) => !this.isStackerForkStageTwoNode(node));
    const exactBackStageOneNodes = this.findModelNodesByName(model, ['huocha2.10']).filter((node) => !this.isStackerForkStageTwoNode(node));
    const exactFrontStageTwoNodes = this.findModelNodesByName(model, ['huocha.9_stage2']);
    const exactBackStageTwoNodes = this.findModelNodesByName(model, ['huocha2.10_stage2']);
    if (exactFrontStageOneNodes.length > 0 || exactBackStageOneNodes.length > 0) {
      const hasStageTwoClones = exactFrontStageTwoNodes.length > 0 || exactBackStageTwoNodes.length > 0;
      if (!hasStageTwoClones) {
        // 无 _stage2 克隆件：huocha.9 两段都参与得 totalOffset，huocha2.10 只参与一段得 stageOneOffset
        const frontMainNodes = exactFrontStageOneNodes;
        const frontAuxNodes = exactBackStageOneNodes;
        return {
          frontNodes: this.uniqueTransformNodes([...frontMainNodes, ...frontAuxNodes]),
          backNodes: this.uniqueTransformNodes([...frontMainNodes, ...frontAuxNodes]),
          frontStageOneNodes: frontAuxNodes,
          frontStageTwoNodes: frontMainNodes,
          backStageOneNodes: [],
          backStageTwoNodes: [],
        };
      }
      return {
        frontNodes: this.uniqueTransformNodes([...exactFrontStageOneNodes, ...exactFrontStageTwoNodes]),
        backNodes: this.uniqueTransformNodes([...exactBackStageOneNodes, ...exactBackStageTwoNodes]),
        frontStageOneNodes: exactFrontStageOneNodes,
        frontStageTwoNodes: exactFrontStageTwoNodes,
        backStageOneNodes: exactBackStageOneNodes,
        backStageTwoNodes: exactBackStageTwoNodes,
      };
    }

    const forkNodes = this.findModelNodes(model, /fork|叉|huocha|cha\d*/i);
    const stageOneNodes = forkNodes.filter((node) => !this.isStackerForkStageTwoNode(node));
    const stageTwoNodes = forkNodes.filter((node) => this.isStackerForkStageTwoNode(node));
    const frontStageOneNodes = stageOneNodes.slice(0, 1);
    const backStageOneNodes = stageOneNodes.slice(1, 2);
    return {
      frontNodes: this.uniqueTransformNodes([...frontStageOneNodes, ...stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'front')]),
      backNodes: this.uniqueTransformNodes([...backStageOneNodes, ...stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'back')]),
      frontStageOneNodes,
      frontStageTwoNodes: stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'front'),
      backStageOneNodes,
      backStageTwoNodes: stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'back'),
    };
  }

  /** 判断节点是否为参数脚本生成的第二段货叉。 */
  private isStackerForkStageTwoNode(node: TransformNode): boolean {
    const metadata = this.isPlainRecord(node.metadata) ? node.metadata : {};
    return metadata.stackerForkStage === 2 || String(node.name ?? '').endsWith('_stage2');
  }

  /** 读取第二段货叉所属侧，元数据缺失时按节点名称兜底。 */
  private readStackerForkSide(node: TransformNode): StackerForkSide | null {
    const metadata = this.isPlainRecord(node.metadata) ? node.metadata : {};
    if (metadata.stackerForkSide === 'front' || metadata.stackerForkSide === 'back') return metadata.stackerForkSide;
    const name = String(node.name ?? '').toLowerCase();
    if (name.includes('huocha2') || name.includes('back')) return 'back';
    if (name.includes('huocha') || name.includes('front')) return 'front';
    return null;
  }

  /** 读取模型脚本 dataDriven.motion.<key>.nodes 中声明的节点名。 */
  private readStackerMotionNodeNames(model: ModelRuntimeEntry, motionKey: string): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = this.readStringArrayPath(dataDriven, ['motion', motionKey, 'nodes']);
      if (nodes.length > 0) return nodes;
    }

    return [];
  }

  /** 读取模型脚本 dataDriven.fixedNodes 中声明的固定节点名。 */
  private readStackerFixedNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = this.readStringArrayPath(dataDriven, ['fixedNodes']);
      if (nodes.length > 0) return nodes;
    }

    return STACKER_FALLBACK_FIXED_NODE_NAMES;
  }

  /** 按路径读取字符串数组，保证外置模型脚本配置只以安全 JSON 形态参与节点选择。 */
  private readStringArrayPath(source: unknown, path: string[]): string[] {
    let current: unknown = source;
    for (const key of path) {
      if (!this.isPlainRecord(current)) return [];
      current = current[key];
    }

    if (!Array.isArray(current)) return [];
    return current.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  /** 按路径读取数值配置，供模型脚本 dataDriven 扩展字段使用。 */
  private readNumberPath(source: unknown, path: string[]): number | null {
    let current: unknown = source;
    for (const key of path) {
      if (!this.isPlainRecord(current)) return null;
      current = current[key];
    }

    return typeof current === 'number' && Number.isFinite(current) ? current : null;
  }

  /** 在导入模型子树中按精确名称查找节点。 */
  private findModelNodesByName(model: ModelRuntimeEntry, names: string[]): TransformNode[] {
    const nameSet = new Set(names);
    return this.getModelTransformNodes(model).filter((node) => nameSet.has(String(node.name ?? '')));
  }

  /** 在导入模型子树中按名称正则查找节点。 */
  private findModelNodes(model: ModelRuntimeEntry, pattern: RegExp): TransformNode[] {
    return this.getModelTransformNodes(model).filter((node) => pattern.test(String(node.name ?? '')));
  }

  /** 汇总模型内容根节点、TransformNode 与 Mesh，过滤模型实体根节点本身。 */
  private getModelTransformNodes(model: ModelRuntimeEntry): TransformNode[] {
    const nodes = [
      model.contentRoot,
      ...model.root.getChildTransformNodes(false),
      ...model.meshes,
      ...this.scene.transformNodes,
      ...this.scene.meshes,
    ].filter((node) => node !== model.root && node.isDescendantOf?.(model.root));

    return this.uniqueTransformNodes(nodes);
  }

  /** 过滤同一运动分组中的子级节点，避免父子同时写入相同动作后产生双倍位移。 */
  private filterTopLevelMotionNodes(nodes: TransformNode[]): TransformNode[] {
    const uniqueNodes = this.uniqueTransformNodes(nodes);
    return uniqueNodes.filter((node) => {
      return !uniqueNodes.some((candidate) => candidate !== node && node.isDescendantOf?.(candidate));
    });
  }

  /** 累加一组节点的世界位移，后续统一转换到各自父级本地坐标。 */
  private addStackerWorldOffset(offsets: Map<TransformNode, Vector3>, nodes: TransformNode[], worldOffset: Vector3): void {
    for (const node of nodes) {
      const existing = offsets.get(node) ?? Vector3.Zero();
      offsets.set(node, existing.add(worldOffset));
    }
  }

  /** 读取一组节点的世界包围盒在指定轨道轴上的投影范围。 */
  private getNodesProjectedBounds(nodes: TransformNode[], axis: Vector3): { min: number; max: number } | null {
    const bounds = this.getNodesWorldBounds(nodes);
    return bounds ? this.projectWorldBoundsOntoAxis(bounds, axis) : null;
  }

  /** 合并一组节点及其子网格的世界包围盒。 */
  private getNodesWorldBounds(nodes: TransformNode[]): RuntimeWorldBounds | null {
    let mergedBounds: RuntimeWorldBounds | null = null;
    for (const node of nodes) {
      const bounds = this.getNodeWorldBounds(node);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
    }
    return mergedBounds;
  }

  /** 读取单个节点自身或子网格包围盒，没有可见网格时退回节点世界位置。 */
  private getNodeWorldBounds(node: TransformNode): RuntimeWorldBounds | null {
    const meshes = this.getNodeMeshes(node);
    let mergedBounds: RuntimeWorldBounds | null = null;
    for (const mesh of meshes) {
      const bounds = this.getMeshWorldBounds(mesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;
    node.computeWorldMatrix(true);
    return this.createPointWorldBounds(node.getAbsolutePosition());
  }

  /** 收集节点自身和后代 Mesh，用于从真实几何范围计算轨道端点。 */
  private getNodeMeshes(node: TransformNode): AbstractMesh[] {
    const meshes = new Set<AbstractMesh>();
    if (node instanceof AbstractMesh) meshes.add(node);
    for (const childMesh of node.getChildMeshes(false)) {
      meshes.add(childMesh);
    }
    return [...meshes];
  }

  /** 将世界 AABB 投影到任意轴上，使用 8 个角点避免旋转模型时范围偏小。 */
  private projectWorldBoundsOntoAxis(bounds: RuntimeWorldBounds, axis: Vector3): { min: number; max: number } {
    const corners = [
      new Vector3(bounds.minimum.x, bounds.minimum.y, bounds.minimum.z),
      new Vector3(bounds.minimum.x, bounds.minimum.y, bounds.maximum.z),
      new Vector3(bounds.minimum.x, bounds.maximum.y, bounds.minimum.z),
      new Vector3(bounds.minimum.x, bounds.maximum.y, bounds.maximum.z),
      new Vector3(bounds.maximum.x, bounds.minimum.y, bounds.minimum.z),
      new Vector3(bounds.maximum.x, bounds.minimum.y, bounds.maximum.z),
      new Vector3(bounds.maximum.x, bounds.maximum.y, bounds.minimum.z),
      new Vector3(bounds.maximum.x, bounds.maximum.y, bounds.maximum.z),
    ];
    const values = corners.map((corner) => Vector3.Dot(corner, axis));
    return { min: Math.min(...values), max: Math.max(...values) };
  }

  /** 按世界位移写回节点位置，兼容模型内容根节点的毫米缩放、旋转和父级层级。 */
  private offsetNodesFromBaselineByWorldOffsets(model: ModelRuntimeEntry, offsets: Map<TransformNode, Vector3>): void {
    for (const [node, worldOffset] of offsets) {
      const baseline = this.getTelemetryNodeBaseline(model, node);
      const localOffset = this.worldDeltaToParentLocalDelta(node, worldOffset);
      node.position = baseline.add(localOffset);
    }
  }

  /** 记录遥测动作前的节点基线位置。 */
  private getTelemetryNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): Vector3 {
    const existing = model.stackerTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = node.position.clone();
    model.stackerTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 读取模型局部轴在世界空间中的水平投影，用于把 distance_x 映射到行走方向。 */
  private getHorizontalModelAxis(root: TransformNode, axis: 'x' | 'z'): Vector3 {
    const worldAxis = this.getModelAxis(root, axis);
    worldAxis.y = 0;
    return this.normalizeVector(worldAxis, axis === 'x' ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1));
  }

  /** 读取模型局部轴在世界空间中的方向，用于升降和货叉动作适配旋转后的模型。 */
  private getModelAxis(root: TransformNode, axis: 'x' | 'y' | 'z'): Vector3 {
    const localAxis = this.createLocalAxis(axis);
    const worldMatrix = root.computeWorldMatrix(true);
    const worldAxis = Vector3.TransformNormal(localAxis, worldMatrix);
    return this.normalizeVector(worldAxis, localAxis);
  }

  /** 创建局部坐标轴单位向量。 */
  private createLocalAxis(axis: 'x' | 'y' | 'z'): Vector3 {
    if (axis === 'x') return new Vector3(1, 0, 0);
    if (axis === 'y') return new Vector3(0, 1, 0);
    return new Vector3(0, 0, 1);
  }

  /** 把目标点投影到轨道轴上，保证有目标位时只沿轨道移动。 */
  private projectPointOntoAxis(origin: Vector3, axis: Vector3, point: Vector3): Vector3 {
    const distance = Vector3.Dot(point.subtract(origin), axis);
    return origin.add(axis.scale(distance));
  }

  /** 把世界位移转换为节点父级本地位移，避免 contentRoot 源单位缩放导致位移量错误。 */
  private worldDeltaToParentLocalDelta(node: TransformNode, worldOffset: Vector3): Vector3 {
    const parent = node.parent;
    const parentWorldMatrix = parent?.computeWorldMatrix?.(true) ?? parent?.getWorldMatrix?.();
    const inverseParentWorldMatrix = parentWorldMatrix?.clone?.();
    if (!inverseParentWorldMatrix?.invert) return worldOffset.clone();
    inverseParentWorldMatrix.invert();
    return Vector3.TransformNormal(worldOffset, inverseParentWorldMatrix);
  }

  /** movement_x：0 静止，1 前进，2 后退。 */
  private readTravelDirection(value: number | null): number {
    if (value === 1) return 1;
    if (value === 2) return -1;
    return 0;
  }

  /** movement_y：0 原位，1 上升，2 下降。 */
  private readLiftDirection(value: number | null): number {
    if (value === 1) return 1;
    if (value === 2) return -1;
    return 0;
  }

  /** movement_z：1 右伸，2 左缩，3 左伸，4 右缩。 */
  private readForkDirection(value: number | null, currentOffset: number): number {
    if (value === 1) return 1;
    if (value === 3) return -1;
    if (value === 2 || value === 4) return currentOffset === 0 ? 0 : -Math.sign(currentOffset);
    return 0;
  }

  /** 使用 rpm 字段换算速度；没有有效 rpm 时回退模型默认速度。 */
  private readSpeed(snapshot: StackerTelemetrySnapshot, rpmKey: string, fallbackSpeed: number): number {
    const rpm = readNumberField(snapshot.fields, rpmKey);
    if (rpm === null || rpm <= 0) return fallbackSpeed;
    return Math.max(fallbackSpeed * 0.25, rpm * STACKER_RPM_TO_METERS_PER_SECOND);
  }

  /** 根据帧时间计算编码器校准插值权重。 */
  private getCalibrationAlpha(deltaSeconds: number): number {
    return Math.min(1, Math.max(0, deltaSeconds * STACKER_CALIBRATION_RATE));
  }

  /** 数值线性插值。 */
  private lerpNumber(from: number, to: number, alpha: number): number {
    return from + (to - from) * alpha;
  }

  /** 向目标数值移动指定最大步长。 */
  private moveNumberTowards(from: number, to: number, maxDelta: number): number {
    const delta = to - from;
    if (Math.abs(delta) <= maxDelta) return to;
    return from + Math.sign(delta) * maxDelta;
  }

  /** 向目标向量移动指定最大步长。 */
  private moveVectorTowards(from: Vector3, to: Vector3, maxDelta: number): Vector3 {
    const delta = to.subtract(from);
    const distance = delta.length();
    if (distance <= maxDelta || distance <= 0.000001) return to.clone();
    return from.add(delta.scale(maxDelta / distance));
  }

  /** 向量线性插值。 */
  private lerpVector(from: Vector3, to: Vector3, alpha: number): Vector3 {
    return from.add(to.subtract(from).scale(alpha));
  }

  /** 归一化向量，异常时使用兜底方向。 */
  private normalizeVector(vector: Vector3, fallback: Vector3): Vector3 {
    const length = vector.length();
    if (!Number.isFinite(length) || length <= 0.000001) return fallback.clone();
    return vector.scale(1 / length);
  }

  /** 将数值限制在闭区间内。 */
  private clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /** 按引用去重 TransformNode 数组。 */
  private uniqueTransformNodes(nodes: TransformNode[]): TransformNode[] {
    return [...new Set(nodes)];
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

  /** 创建虚拟定位线框：根节点交给 Gizmo，子级透明盒网格负责拾取和边线显示。 */
  private createLocator(entityId: string, locator: LocatorComponent): LocatorRuntimeEntry {
    const root = new TransformNode(`${entityId}_locatorRoot`, this.scene);
    const material = new StandardMaterial(`${entityId}_locatorMat`, this.scene);

    material.disableLighting = true;
    material.alpha = LOCATOR_SURFACE_ALPHA;
    material.diffuseColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);
    material.emissiveColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);

    const boxes = this.createLocatorBoxes(entityId, locator, root, material);

    return { root, boxes, material, assetId: '', signature: '', columns: locator.columns, layers: locator.layers, startColumn: locator.startColumn, deviceAssetCode: locator.deviceAssetCode, rowNumber: locator.rowNumber, storageDepth: locator.storageDepth };
  }

  private createLocatorBoxes(entityId: string, locator: LocatorComponent, root: TransformNode, material: StandardMaterial): Mesh[] {
    const boxes: Mesh[] = [];
    const { length, height, width, columns, layers, columnGap, layerGap } = locator;

    for (let layer = 0; layer < layers; layer += 1) {
      for (let col = 0; col < columns; col += 1) {
        const box = MeshBuilder.CreateBox(`${entityId}_locatorBox_${col}_${layer}`, { width: length, height, depth: width }, this.scene);
        box.parent = root;
        box.position.set(col * (length + columnGap), height / 2 + layer * (height + layerGap), 0);
        box.isPickable = true;
        box.material = material;
        box.metadata = { ...(box.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };
        box.enableEdgesRendering();
        box.edgesWidth = 2;
        box.edgesColor = this.color4FromHex(LOCATOR_EDGE_COLOR, 1);
        boxes.push(box);
      }
    }
    return boxes;
  }

  private createLocatorSignature(locator: LocatorComponent): string {
    return [
      locator.length.toFixed(3),
      locator.height.toFixed(3),
      locator.width.toFixed(3),
      String(locator.columns),
      String(locator.layers),
      locator.columnGap.toFixed(3),
      locator.layerGap.toFixed(3),
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
      return {
        kind: 'locator',
        root: locator.root,
        geometryMeshes: locator.boxes,
        previewMeshes: locator.boxes,
        geometryReady: locator.boxes.length > 0,
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

    const model = this.models.get(entityId);
    if (model) {
      const meshes = model.contentRoot.getChildMeshes(false);
      return {
        kind: 'model',
        root: model.root,
        geometryMeshes: meshes,
        previewMeshes: meshes,
        geometryReady: Boolean(model.assetHandle && model.measurementReady),
        strategy: 'clone-hierarchy',
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
    if (source.strategy === 'clone-hierarchy') {
      const clone = source.root.clone(cloneName, null, false);
      if (!clone) return null;
      this.prepareEntityArrayPreviewClone(clone);
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

  /** 清理临时阵列克隆的实体 metadata 与拾取能力，避免它们进入编辑器交互链路。 */
  private prepareEntityArrayPreviewClone(root: TransformNode): void {
    const nodes: Node[] = [root, ...root.getDescendants(false)];
    for (const node of nodes) {
      node.metadata = null;
      if (node instanceof AbstractMesh) {
        node.isPickable = false;
        node.actionManager = null;
      }
    }
  }

  /** 释放实体对应的 Mesh 与材质资源。 */
  private disposeMesh(entityId: string, mesh: Mesh): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    mesh.material?.dispose();
    mesh.dispose();
    this.meshes.delete(entityId);
  }

  /** 释放虚拟定位线框的根节点、网格盒和材质。 */
  private disposeLocator(entityId: string, locator: LocatorRuntimeEntry): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    for (const box of locator.boxes) {
      box.dispose(false, false);
    }
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

  /** 释放导入模型的容器、根节点与所有子资源。 */
  private disposeModel(entityId: string, model: ModelRuntimeEntry): void {
    this.clearEntityArrayPreviewIfSource(entityId);
    this.genericTelemetryMotionRuntime.disposeModel(entityId);
    model.telemetryPreviewBaseline = null;
    this.applyModelSelection(model, false);
    model.externalScriptRuntime?.dispose();
    for (const texture of model.textureCache.values()) {
      texture.dispose();
    }
    model.assetHandle?.dispose();
    model.contentRoot.dispose();
    model.root.dispose();
    this.models.delete(entityId);
    this.onModelMeasurementChanged(entityId);
  }

  /** 将当前生成器输出脱离稳定根节点并登记为可长期驻留库位的仓储货物。 */
  private storeWarehouseInboundCargo(
    runtimeEntry: ModelGeneratorRuntimeEntry,
    cargoCode: string,
    locatorKey: string,
  ): boolean {
    const output = runtimeEntry.output;
    if (!output || !this.isModelGeneratorOutputReady(output)) return false;
    const locatorIssueKey = 'locator-missing:' + locatorKey;
    const locator = this.locatorTargets.get(locatorKey) ?? null;
    if (!locator) {
      this.reportWarehouseIssue(runtimeEntry, locatorIssueKey, `目标库位 ${locatorKey} 不存在或编号不唯一，货物保持在 DDJ2。`);
      return false;
    }
    this.clearWarehouseIssue(runtimeEntry, locatorIssueKey);
    if (runtimeEntry.warehouseCargos.has(cargoCode)) {
      this.reportWarehouseIssue(runtimeEntry, 'stored-duplicate:' + cargoCode, `货物 ${cargoCode} 已存在，拒绝重复入库。`);
      return false;
    }
    if ([...runtimeEntry.warehouseCargos.values()].some((cargo) => cargo.locatorKey === locatorKey)) {
      this.reportWarehouseIssue(runtimeEntry, 'locator-occupied:' + locatorKey, `库位 ${locatorKey} 已有运行时货物，拒绝覆盖。`);
      return false;
    }

    const cargoRoot = new TransformNode(
      `${runtimeEntry.entityId}_warehouseCargo_${this.sanitizeBabylonName(cargoCode)}`,
      this.scene,
    );
    this.setWarehouseRootPose(
      cargoRoot,
      this.getWarehouseLocatorSupportPosition(locator),
      this.getNodeWorldRotation(locator.root),
    );
    const outputNode = output.kind === 'model' ? output.model.root : output.mesh;
    outputNode.parent = cargoRoot;
    if (output.kind === 'model') {
      this.applyModelSelection(output.model, false);
      output.model.meshes.forEach((mesh) => {
        mesh.isPickable = false;
      });
    } else {
      output.mesh.isPickable = false;
    }

    runtimeEntry.warehouseCargos.set(cargoCode, { cargoCode, locatorKey, root: cargoRoot, output });
    runtimeEntry.output = null;
    runtimeEntry.activeTargetSignature = null;
    runtimeEntry.activeSnapshot = null;
    runtimeEntry.loadToken += 1;
    this.resetGeneratedOutputRoot(runtimeEntry.root);
    this.pushLog(`仓储流“${runtimeEntry.entityName}”已将货物 ${cargoCode} 放入库位 ${locatorKey}。`);
    return true;
  }

  /** 判断生成器输出是否已经具备可脱离的完整资源。 */
  private isModelGeneratorOutputReady(output: ModelGeneratorOutputRuntimeEntry): boolean {
    return output.kind === 'mesh' || Boolean(output.model.assetHandle && output.model.stackerTelemetryReady);
  }

  /** 停止预览时统一释放所有仓储货物并恢复生成器基础 Transform。 */
  private resetAllWarehouseFlows(): void {
    for (const runtimeEntry of this.modelGenerators.values()) {
      this.resetModelGeneratorWarehouseFlow(runtimeEntry);
    }
  }

  /** 重置单个生成器的仓储协调器、活动输出、已存实例和运行时诊断。 */
  private resetModelGeneratorWarehouseFlow(runtimeEntry: ModelGeneratorRuntimeEntry): void {
    for (const cargo of runtimeEntry.warehouseCargos.values()) {
      this.disposeWarehouseCargo(cargo);
    }
    runtimeEntry.warehouseCargos.clear();
    this.disposeModelGeneratorOutput(runtimeEntry);
    runtimeEntry.activeTargetSignature = null;
    runtimeEntry.activeSnapshot = null;
    runtimeEntry.warehouseCoordinator.reset();
    runtimeEntry.warehouseActiveResolution = null;
    runtimeEntry.reportedWarehouseIssues.clear();
    this.resetGeneratedOutputRoot(runtimeEntry.root);
  }

  /** 释放已脱离生成器的仓储货物根节点和完整派生输出。 */
  private disposeWarehouseCargo(cargo: WarehouseCargoRuntimeEntry): void {
    this.disposeModelGeneratorOutputValue(cargo.output);
    cargo.root.dispose();
  }

  /** 判断当前专用模型是否由任一有效仓储流绑定托管，用于关闭旧默认 Box 货物。 */
  private isWarehouseFlowManagedModel(model: ModelRuntimeEntry, deviceType: SpecializedTelemetryDeviceType): boolean {
    const resolved = resolveSpecializedTelemetryBinding({
      modelAssetCode: model.assetCode,
      deviceType,
      binding: model.telemetryBinding,
    });
    if (!resolved) return false;
    const runtimeEntry = this.getActiveModelGenerator();
    const warehouseFlow = runtimeEntry?.component.warehouseFlow;
    if (!runtimeEntry || !warehouseFlow?.enabled) return false;

    const bindingIds = deviceType === 'stacker'
      ? [warehouseFlow.stackerBindingId]
      : [warehouseFlow.inboundBindingId, warehouseFlow.outboundBindingId];
    for (const bindingId of bindingIds) {
      const binding = runtimeEntry.component.bindings.find((item) => item.id === bindingId);
      if (!binding?.sourceId.trim() || !binding.deviceType.trim() || !binding.assetCode.trim()) continue;
      if (binding.sourceId.trim() === resolved.sourceId
        && binding.deviceType.trim().toLowerCase() === resolved.deviceType
        && binding.assetCode.trim() === resolved.assetCode) return true;
    }
    return false;
  }

  /** 同一仓储问题只写一次 Console，恢复后可按稳定 key 解除去重。 */
  private reportWarehouseIssue(runtimeEntry: ModelGeneratorRuntimeEntry, key: string, message: string): void {
    if (runtimeEntry.reportedWarehouseIssues.has(key)) return;
    runtimeEntry.reportedWarehouseIssues.add(key);
    this.pushLog(`仓储流“${runtimeEntry.entityName}”：${message}`);
  }

  /** 解除已恢复问题的去重 key。 */
  private clearWarehouseIssue(runtimeEntry: ModelGeneratorRuntimeEntry, key: string): void {
    runtimeEntry.reportedWarehouseIssues.delete(key);
  }

  /** 为模型生成器完整运行时配置生成稳定签名，配置变化时统一释放旧自动货物。 */
  private createModelGeneratorRuntimeConfigSignature(component: ModelGeneratorComponent): string {
    return JSON.stringify({
      defaultTarget: component.defaultTarget,
      rules: component.rules,
      metadataTtlSeconds: component.metadataTtlSeconds,
      bindings: component.bindings,
      warehouseFlow: component.warehouseFlow ?? null,
    });
  }

  /** 释放生成器当前派生输出；稳定根节点和空状态标记保持不变。 */
  private disposeModelGeneratorOutput(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    const output = runtimeEntry.output;
    if (!output) return;
    this.disposeModelGeneratorOutputValue(output);
    runtimeEntry.output = null;
  }

  /** 释放任意生成器派生输出，供当前输出和已脱离仓储实例共用。 */
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

  /** 释放模型生成器配置标记、独立输出根节点、仓储货物和异步资源。 */
  private disposeModelGenerator(entityId: string, runtimeEntry: ModelGeneratorRuntimeEntry): void {
    runtimeEntry.loadToken += 1;
    this.resetModelGeneratorWarehouseFlow(runtimeEntry);
    runtimeEntry.marker.material.dispose();
    runtimeEntry.marker.mesh.dispose();
    runtimeEntry.markerRoot.dispose();
    runtimeEntry.root.dispose();
    runtimeEntry.failedTargetSignatures.clear();
    runtimeEntry.reportedLoadFailureKeys.clear();
    this.generatedOutputOwners.delete(runtimeEntry.entityId);
    this.modelGenerators.delete(entityId);
    this.fetchRuntimes.get(entityId)?.dispose();
    this.fetchRuntimes.delete(entityId);
  }

  /** 释放当前环境底座模型，切换场景或切换效果时避免 Babylon 资源残留。 */
  private disposeEnvironment(): void {
    if (!this.environment) return;

    this.environment.container?.dispose();
    this.environment.root.dispose();
    this.environment = null;
  }

  /** 删除指定 Stacker 实例生成的运行时货物，不污染场景文档。 */
  private disposeStackerCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.stackerCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.disposeStackerCargo(cargo);
      this.stackerCargoMeshes.delete(key);
    }
  }

  /** 释放单个堆垛机运行时货物的模板、回退 Box 和支撑点根节点。 */
  private disposeStackerCargo(cargo: StackerCargoRuntimeEntry): void {
    this.disposeGeneratedCargo(cargo);
  }

  /** 释放灯光资源。 */
  private disposeLight(entityId: string, light: Light): void {
    light.dispose();
    this.lights.delete(entityId);
  }

  /** 从 Mesh 元数据中读取编辑器实体 ID。 */
  private readEntityIdFromMesh(mesh: AbstractMesh | null): string | null {
    const metadata = mesh?.metadata as EditorMeshMetadata | null | undefined;
    const entityId = metadata?.[EDITOR_ENTITY_ID_METADATA_KEY];

    return typeof entityId === 'string'
      && (
        this.meshes.has(entityId)
        || this.locators.has(entityId)
        || this.models.has(entityId)
        || this.modelGenerators.has(entityId)
        || this.poiEffectRuntime.has(entityId)
      )
      ? entityId
      : null;
  }

  /** 判断实体当前是否应在 Babylon 场景中显示。 */
  private isEntityVisible(entityId: string): boolean {
    return this.entityStates.get(entityId)?.visible !== false;
  }

  /** 合并实体自身与直属分组文件夹的显示/锁定状态。 */
  private resolveEntityRuntimeState(document: SceneDocument, entity: Entity): EntityRuntimeState {
    const parentEntity = entity.parentId ? document.entities[entity.parentId] : null;

    return {
      visible: entity.visible !== false && parentEntity?.visible !== false,
      locked: entity.locked === true || parentEntity?.locked === true,
    };
  }

  /** 判断实体是否允许被 Scene View 鼠标拾取。 */
  private isEntityScenePickable(entityId: string): boolean {
    const state = this.entityStates.get(entityId);
    return state?.visible !== false && state?.locked !== true;
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

  /** 将显隐和锁定状态应用到导入模型的根节点与子 Mesh。 */
  private applyModelInteractivity(model: ModelRuntimeEntry, entityId: string): void {
    const visible = this.isEntityVisible(entityId);
    const pickable = visible && this.isEntityScenePickable(entityId);

    model.root.setEnabled(visible);
    for (const mesh of model.meshes) {
      mesh.isPickable = pickable;
    }
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
      `${entityId}_cadLayer_${this.sanitizeBabylonName(layerName)}_${batchIndex}`,
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

  /** 根据选中状态更新全部 locator 盒子边线和表面颜色。 */
  private applyLocatorStyle(entry: LocatorRuntimeEntry, selected: boolean): void {
    const color = selected ? SELECTED_MATERIAL_COLOR : LOCATOR_EDGE_COLOR;
    const color3 = Color3.FromHexString(color);

    entry.material.alpha = selected ? SELECTED_LOCATOR_SURFACE_ALPHA : LOCATOR_SURFACE_ALPHA;
    entry.material.diffuseColor = color3;
    entry.material.emissiveColor = color3;

    for (const box of entry.boxes) {
      box.edgesWidth = selected ? 4 : 2;
      box.edgesColor = this.color4FromHex(color, 1);
    }
  }

  /** 从十六进制颜色生成带透明度的 Color4，用于 Babylon edgesRenderer。 */
  private color4FromHex(hexColor: string, alpha: number): Color4 {
    const color = this.readColor(hexColor);
    return new Color4(color.r, color.g, color.b, alpha);
  }

  /** 读取材质颜色，非法颜色回退到默认编辑器颜色。 */
  private readColor(hexColor: string): Color3 {
    try {
      return Color3.FromHexString(hexColor);
    } catch {
      return Color3.FromHexString(FALLBACK_MATERIAL_COLOR);
    }
  }

  /** 把外部图层名压缩成 Babylon 对象名可读片段。 */
  private sanitizeBabylonName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'layer';
  }

  /** 将编辑器 Transform 写入 Babylon 节点。 */
  private applyTransform(target: AbstractMesh | TransformNode, transform: TransformComponent): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotationQuaternion = null;
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
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

  /** 同步普通模型包外置脚本，并在脚本就绪后接回既有遥测运动链。 */
  private syncExternalModelScripts(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;
    this.syncModelAssetExternalScripts(modelAsset, model, (current) => {
      this.refreshModelEntityMeshes(entity, current);
      this.applyModelInteractivity(current, entity.id);
      this.applyModelSelection(current, current.highlighted);
      this.rebuildSharedModelSelectionOutline();
      this.syncGenericTelemetryMotion(entity, current);
      this.onModelMeasurementChanged(entity.id);
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
    model.meshes = [...new Set(model.root.getChildMeshes(false))]
      .filter((mesh) => !mesh.isDisposed());
    for (const mesh of model.meshes) {
      mesh.metadata = { ...(mesh.metadata ?? {}), ...metadata };
    }
  }

  /** 同步模型资产脚本生命周期，普通模型和生成模型共享同一份受控实现。 */
  private syncModelAssetExternalScripts(
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
    onSettled: (current: ModelRuntimeEntry) => void,
  ): void {
    if (!model.assetHandle) return;
    this.syncModelScriptMetadata(model.contentRoot, modelAsset);

    const scriptAssets = modelAsset.scriptAssets ?? [];
    if (scriptAssets.length === 0) {
      model.externalScriptRuntime?.dispose();
      model.externalScriptRuntime = null;
      model.externalScriptSignature = '';
      model.externalScriptStarting = false;
      model.measurementReady = true;
      this.resetStackerTelemetryState(model);
      this.resetConveyorTelemetryState(model);
      model.stackerTelemetryReady = true;
      onSettled(model);
      return;
    }

    const signature = JSON.stringify({
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
      this.updateModelExternalScriptRuntimeContext(model, runtimeMode, null);
      model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
      model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);

      const runtime = model.externalScriptRuntime;
      const loadToken = model.loadToken;
      void runtime.start()
        .then(() => {
          const current = this.findActiveModelRuntimeEntry(runtime);
          if (!current || current.loadToken !== loadToken) return;
          this.updateModelExternalScriptRuntimeContext(current, this.telemetryPreviewActive ? 'runtime' : 'edit', null);
          runtime.update();
          this.resetStackerTelemetryState(current);
          this.resetConveyorTelemetryState(current);
          current.externalScriptStarting = false;
          current.measurementReady = true;
          current.stackerTelemetryReady = true;
          onSettled(current);
        })
        .catch((error) => {
          const current = this.findActiveModelRuntimeEntry(runtime);
          if (!current || current.loadToken !== loadToken) return;
          current.externalScriptStarting = false;
          current.measurementReady = true;
          this.resetStackerTelemetryState(current);
          this.resetConveyorTelemetryState(current);
          current.stackerTelemetryReady = true;
          const message = error instanceof Error ? error.message : String(error);
          this.pushLog(`模型脚本初始化失败，已回退基础几何与测量：${message}`);
          onSettled(current);
        });
      return;
    }

    model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
    model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);
    this.updateModelExternalScriptRuntimeContext(model, runtimeMode, null);
    if (model.externalScriptStarting) return;

    model.externalScriptRuntime.update();
    this.resetStackerTelemetryState(model);
    this.resetConveyorTelemetryState(model);
    model.measurementReady = true;
    model.stackerTelemetryReady = true;
    onSettled(model);
  }

  /** 在普通模型和生成器派生模型中查找仍处于活动状态的脚本宿主。 */
  private findActiveModelRuntimeEntry(runtime: ExternalModelScriptRuntime): ModelRuntimeEntry | null {
    for (const model of this.models.values()) {
      if (model.externalScriptRuntime === runtime) return model;
    }
    for (const owner of this.generatedOutputOwners.values()) {
      if (owner.output?.kind === 'model' && owner.output.model.externalScriptRuntime === runtime) {
        return owner.output.model;
      }
    }
    return null;
  }

  /** 同步通用遥测运动引擎，专用 Stacker/Conveyor 模型默认跳过避免双重驱动。 */
  private syncGenericTelemetryMotion(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset || !model.assetHandle) return;

    this.genericTelemetryMotionRuntime.syncModel({
      entityId: entity.id,
      root: model.root,
      contentRoot: model.contentRoot,
      modelAsset,
      binding: entity.components.telemetryBinding ?? null,
      externalDataDrivenConfigs: model.externalScriptRuntime?.getDataDrivenConfigs() ?? [],
      specializedDriver: model.stackerCapable || this.isConveyorRuntimeModel(model),
      loadToken: model.loadToken,
      baselineRevision: this.createGenericTelemetryBaselineRevision(entity, model),
      animationGroups: model.assetHandle?.animationGroups ?? [],
    });
  }

  /** 生成通用遥测基线签名，参数、脚本、资产或实体 Transform 变化时重建运行态基线。 */
  private createGenericTelemetryBaselineRevision(entity: Entity, model: ModelRuntimeEntry): string {
    return JSON.stringify({
      transform: entity.components.transform,
      parameterSignature: model.parameterSignature,
      externalScriptSignature: model.externalScriptSignature,
      assetSignature: model.assetSignature,
      loadToken: model.loadToken,
    });
  }

  /** 模型完成归一化和外置脚本初始化后，重新建立 Stacker 遥测基线。 */
  private resetStackerTelemetryState(model: ModelRuntimeEntry): void {
    model.stackerTelemetry.rootBasePosition = model.root.position.clone();
    model.stackerTelemetry.rootPosition = null;
    model.stackerTelemetry.travelConstraint = null;
    model.stackerTelemetry.targetReferencePosition = null;
    model.stackerTelemetry.liftOffset = 0;
    model.stackerTelemetry.frontForkOffset = 0;
    model.stackerTelemetry.backForkOffset = 0;
    model.stackerTelemetry.frontForkDirection = 1;
    model.stackerTelemetry.backForkDirection = 1;
    model.stackerTelemetry.frontCargoCode = null;
    model.stackerTelemetry.backCargoCode = null;
    model.stackerTelemetry.nodeBaselines.clear();
    model.stackerTelemetry.lastTargetKey = null;
  }

  /** 把实例资产编号和 meta.json 脚本参数写回 Babylon 节点 metadata，供运行时和动画识别读取。 */
  private syncModelScriptMetadata(target: TransformNode, modelAsset: ModelAssetComponent): void {
    const scripts = (modelAsset.parameterScriptMetadata ?? []).map((script) => {
      const clonedScript = this.cloneJsonValue(script);
      if (!this.isPlainRecord(clonedScript)) return clonedScript;

      const values = this.isPlainRecord(clonedScript.values) ? { ...clonedScript.values } : {};
      for (const [key, value] of Object.entries(modelAsset.parameterValues ?? {})) {
        const previousValue = this.isPlainRecord(values[key]) ? values[key] : {};
        values[key] = { ...previousValue, value };
      }
      clonedScript.values = values;
      return clonedScript;
    });

    const previousMetadata = target.metadata ?? {};
    const previousModelAssetMetadata = this.isPlainRecord(previousMetadata.modelAsset)
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
  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
  }

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

  /** 根据模型资源类型应用普通 Mesh 高亮或记录共享实例描边状态。 */
  private applyModelSelection(model: ModelRuntimeEntry, selected: boolean): void {
    if (model.assetHandle?.kind === 'shared-instance') {
      for (const mesh of model.highlightedMeshes) {
        this.modelHighlightLayer.removeMesh(mesh);
      }
      model.highlightedMeshes.clear();
      model.highlighted = selected;
      return;
    }

    const currentMeshes = new Set(
      model.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && !mesh.isDisposed()),
    );

    if (selected) {
      for (const mesh of currentMeshes) {
        if (model.highlightedMeshes.has(mesh)) continue;
        this.modelHighlightLayer.addMesh(mesh, Color3.FromHexString(SELECTED_MATERIAL_COLOR));
        model.highlightedMeshes.add(mesh);
      }
      for (const mesh of [...model.highlightedMeshes]) {
        if (currentMeshes.has(mesh)) continue;
        this.modelHighlightLayer.removeMesh(mesh);
        model.highlightedMeshes.delete(mesh);
      }
    } else {
      for (const mesh of model.highlightedMeshes) {
        this.modelHighlightLayer.removeMesh(mesh);
      }
      model.highlightedMeshes.clear();
    }

    model.highlighted = selected;
  }

  /** 重建全部共享模型实例的选择描边，确保单个实例选中不会污染同源模型。 */
  private rebuildSharedModelSelectionOutline(): void {
    const selectedGroups = [...this.models.values()]
      .filter((model) => model.assetHandle?.kind === 'shared-instance' && model.highlighted)
      .map((model) => model.meshes.filter((mesh) => !mesh.isDisposed() && mesh.getTotalVertices() > 0))
      .filter((meshes) => meshes.length > 0);
    const signature = selectedGroups
      .map((meshes) => meshes.map((mesh) => mesh.uniqueId).join(','))
      .join('|');
    if (signature === this.sharedModelSelectionOutlineSignature) return;

    this.sharedModelSelectionOutlineSignature = signature;
    this.modelSelectionOutlineLayer.clearSelection();
    this.prepareSharedModelSelectionMeshes(selectedGroups.flat());
    for (const meshes of selectedGroups) {
      this.modelSelectionOutlineLayer.addSelection(meshes);
    }
  }

  /**
   * 在 clearSelection 之后、addSelection 之前补齐公开 instancedBuffers 容器。
   * 若 sourceMesh 仍有 instancedBuffers，说明 Babylon 已保留其它实例缓冲注册；此时必须确保同源全部实例都有公开容器，避免重新写 instanceSelectionId 时命中 null。
   * 若 sourceMesh.instancedBuffers 不存在，则不提前创建，让 registerInstancedBuffer 原生初始化 source 与 source.instances。
   */
  private prepareSharedModelSelectionMeshes(meshes: AbstractMesh[]): void {
    const preparedSources = new Set<Mesh>();
    for (const mesh of meshes) {
      if (!(mesh instanceof InstancedMesh)) continue;

      const sourceMesh = mesh.sourceMesh;
      if (!sourceMesh.instancedBuffers || preparedSources.has(sourceMesh)) continue;

      for (const instance of sourceMesh.instances) {
        if (!instance.instancedBuffers) {
          instance.instancedBuffers = {};
        }
      }
      preparedSources.add(sourceMesh);
    }
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

  /** 将环境模型的顶层节点挂到独立根节点下，避免污染场景实体层级。 */
  private parentTopLevelEnvironmentNodes(environment: EnvironmentRuntimeEntry): void {
    const meshes = environment.container?.meshes ?? [];
    const transformNodes = environment.container?.transformNodes ?? [];
    const allImportedNodes = new Set([...meshes, ...transformNodes]);

    for (const node of allImportedNodes) {
      if (!node.parent || !allImportedNodes.has(node.parent as AbstractMesh | TransformNode)) {
        node.parent = environment.root;
      }
    }
  }

  /**
   * 根据有效环境网格的世界包围盒放置根节点，使整个 GLB 位于世界原点左侧并落到地面。
   * 环境模型仍保持不可选中，也不会写入场景实体层级。
   */
  private positionEnvironmentLeftOfOrigin(environment: EnvironmentRuntimeEntry): void {
    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const mesh of environment.container?.meshes ?? []) {
      if (mesh.getTotalVertices() <= 0) continue;

      const bounds = this.getMeshWorldBounds(mesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (!mergedBounds) {
      environment.root.position.copyFromFloats(-ENVIRONMENT_FALLBACK_LEFT_OFFSET_METERS, 0, 0);
      environment.root.computeWorldMatrix(true);
      return;
    }

    const offset = calculateEnvironmentOriginLeftOffset(mergedBounds.minimum, mergedBounds.maximum);
    if (!offset) {
      environment.root.position.copyFromFloats(-ENVIRONMENT_FALLBACK_LEFT_OFFSET_METERS, 0, 0);
      environment.root.computeWorldMatrix(true);
      return;
    }

    environment.root.position.copyFromFloats(offset.x, offset.y, offset.z);
    environment.root.computeWorldMatrix(true);
  }

  /** 将导入模型内容的底部中心归一到实体根节点，避免源模型巨大坐标偏移影响场景放置。 */
  private normalizeModelContentOrigin(model: ModelRuntimeEntry): void {
    model.root.computeWorldMatrix(true);

    const childMeshes = model.root.getChildMeshes(false).filter(isMeasurableModelMesh);
    if (childMeshes.length === 0) return;

    let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

    for (const mesh of childMeshes) {
      mesh.computeWorldMatrix(true);
      const boundingInfo = mesh.getBoundingInfo();
      minimum = Vector3.Minimize(minimum, boundingInfo.boundingBox.minimumWorld);
      maximum = Vector3.Maximize(maximum, boundingInfo.boundingBox.maximumWorld);
    }

    if (!Number.isFinite(minimum.x) || !Number.isFinite(minimum.y) || !Number.isFinite(minimum.z)) return;
    if (!Number.isFinite(maximum.x) || !Number.isFinite(maximum.y) || !Number.isFinite(maximum.z)) return;

    const bottomCenter = new Vector3(
      (minimum.x + maximum.x) / 2,
      minimum.y,
      (minimum.z + maximum.z) / 2,
    );
    const inverseRootMatrix = model.root.getWorldMatrix().clone().invert();
    const localBottomCenter = Vector3.TransformCoordinates(bottomCenter, inverseRootMatrix);

    for (const child of model.root.getChildren()) {
      if (child instanceof TransformNode) {
        child.position.subtractInPlace(localBottomCenter);
      }
    }
  }

  /** 通过统一并发调度器加载 Babylon 资产容器，限制批量模型解析和 GPU 上传峰值。 */
  private loadAssetContainer(rootUrl: string, fileName: string): Promise<AssetContainer> {
    return this.assetLoadScheduler.run(() => SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.scene));
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
