import '@babylonjs/loaders';
import {
  AbstractMesh,
  AssetContainer,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  HighlightLayer,
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
  Vector3,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type {
  CadReferenceComponent,
  LightComponent,
  LocatorComponent,
  ModelAssetComponent,
  TransformComponent,
} from '../../editor/model/components';
import type {
  ModelExpression,
  ModelParameterBinding,
  ModelParameterValue,
  ModelParameterValues,
} from '../../editor/model/modelParameters';
import type { Vector3Data } from '../../editor/model/math';
import type { SceneDocument, SceneEnvironmentSettings } from '../../editor/model/SceneDocument';
import {
  consumeCadReferenceParseResult,
  parseCadReferenceDxf,
  type CadReferenceParseResult,
} from '../../editor/cad/cadReference';
import { ExternalModelScriptRuntime } from './ExternalModelScriptRuntime';
import {
  deviceTelemetryStore,
  readIntegerField,
  readNumberField,
  readStringField,
  type DeviceTelemetrySnapshot,
  type StackerTelemetrySnapshot,
} from '../mqtt/deviceTelemetry';
import { resolveRelativeEditorAssetUrl, resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';

const SELECTED_MATERIAL_COLOR = '#f7d774';
const SELECTED_EMISSIVE_COLOR = '#332400';
const FALLBACK_MATERIAL_COLOR = '#8ab4f8';
const LOCATOR_EDGE_COLOR = '#19c7d4';
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

type ModelRuntimeEntry = {
  sourceUrl: string;
  assetRevision: string | null;
  assetSignature: string;
  assetCode: string;
  stackerCapable: boolean;
  conveyorCapable: boolean;
  root: TransformNode;
  contentRoot: TransformNode;
  container: AssetContainer | null;
  meshes: AbstractMesh[];
  highlighted: boolean;
  loadToken: number;
  parameterSignature: string;
  parameterBaseline: Map<string, ModelParameterBaselineValue>;
  textureCache: Map<string, Texture>;
  externalScriptRuntime: ExternalModelScriptRuntime | null;
  externalScriptSignature: string;
  stackerTelemetry: StackerModelTelemetryState;
  conveyorTelemetry: ConveyorModelTelemetryState;
  stackerTelemetryReady: boolean;
};

type ModelParameterRuntimeTarget = AbstractMesh | TransformNode | Material;
type ModelParameterBaselineValue = boolean | number | string | Vector3Data | Texture | null;

type LocatorRuntimeEntry = {
  root: TransformNode;
  box: Mesh;
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

type StackerCargoRuntimeEntry = {
  assetCode: string;
  containerCode: string;
  mesh: Mesh;
  material: StandardMaterial;
  placedLocatorKey: string | null;
};

type StackerModelTelemetryState = {
  rootBasePosition: Vector3;
  /** 行走机构的虚拟世界位置；模型根节点和上下轨道保持静止。 */
  rootPosition: Vector3 | null;
  /** 基于固定轨道和行走机构基线计算的轨道约束，防止遥测把机体推出轨道。 */
  travelConstraint: StackerTravelConstraint | null;
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

type ConveyorCargoRuntimeEntry = {
  assetCode: string;
  containerCode: string;
  mesh: Mesh;
  material: StandardMaterial;
};

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
};

type EnvironmentRuntimeEntry = {
  sourceUrl: string;
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
  private readonly cadReferences = new Map<string, CadReferenceRuntimeEntry>();
  private readonly models = new Map<string, ModelRuntimeEntry>();
  private readonly stackerCargoMeshes = new Map<string, StackerCargoRuntimeEntry>();
  private readonly conveyorCargoMeshes = new Map<string, ConveyorCargoRuntimeEntry>();
  private readonly lights = new Map<string, Light>();
  private readonly entityStates = new Map<string, EntityRuntimeState>();
  private readonly modelHighlightLayer: HighlightLayer;
  private readonly telemetryObserver: Nullable<Observer<Scene>>;
  private readonly reportedMissingTargets = new Set<string>();
  private readonly reportedFaults = new Map<string, string>();
  private readonly reportedStatuses = new Map<string, string>();
  private environment: EnvironmentRuntimeEntry | null = null;
  private modelLoadSequence = 0;
  private environmentLoadSequence = 0;

  constructor(
    private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
  ) {
    this.modelHighlightLayer = new HighlightLayer('EditorModelHighlightLayer', scene);
    this.telemetryObserver = this.scene.onBeforeRenderObservable.add(() => this.applyDeviceTelemetryFrame());
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

  /** 汇总多个实体的世界包围盒，供 Scene View 执行右键菜单的场景聚焦。 */
  getEntitiesWorldBounds(entityIds: string[]): { center: Vector3Data; radiusMeters: number } | null {
    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const entityId of entityIds) {
      const bounds = this.getEntityWorldBounds(entityId);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? this.mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (!mergedBounds) return null;

    const center = mergedBounds.minimum.add(mergedBounds.maximum).scale(0.5);
    const radiusMeters = Math.max(0.5, mergedBounds.maximum.subtract(mergedBounds.minimum).length() / 2);

    return {
      center: { x: center.x, y: center.y, z: center.z },
      radiusMeters,
    };
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
    if (locator) return this.getMeshWorldBounds(locator.box);

    const cadReference = this.cadReferences.get(entityId);
    if (cadReference) return this.getCadReferenceWorldBounds(cadReference);

    const model = this.models.get(entityId);
    if (model) return this.getModelWorldBounds(model);

    const light = this.lights.get(entityId);
    if (light) return this.getLightWorldBounds(light);

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

  /** 将编辑器文档同步到 Babylon 运行时场景。 */
  sync(document: SceneDocument): void {
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
    const lightIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.light)),
    );

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

    for (const [entityId, light] of this.lights.entries()) {
      if (!lightIds.has(entityId)) {
        this.disposeLight(entityId, light);
      }
    }

    const selectedEntityIds = this.resolveSelectedEntityIds(document);

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;

      this.syncEntity(entity, selectedEntityIds.has(entityId));
    }

    this.rebuildLocatorTargetIndex(document);
  }

  /** 同步场景级环境底座模型；环境不写入实体索引，也不能被场景点击选中。 */
  syncEnvironment(environment: SceneEnvironmentSettings | null): void {
    const sourceUrl = environment?.activeVariantUrl ?? null;
    if (!sourceUrl) {
      this.disposeEnvironment();
      return;
    }

    if (this.environment?.sourceUrl === sourceUrl) return;

    this.disposeEnvironment();

    const root = new TransformNode('EnvironmentRoot', this.scene);
    const loadToken = ++this.environmentLoadSequence;
    this.environment = { sourceUrl, root, container: null, loadToken };

    const { rootUrl, fileName } = this.splitAssetUrl(resolveRuntimeAssetUrl(sourceUrl));

    void SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.scene)
      .then((container) => {
        const activeEnvironment = this.environment;
        if (!activeEnvironment || activeEnvironment.loadToken !== loadToken || activeEnvironment.sourceUrl !== sourceUrl) {
          container.dispose();
          return;
        }

        container.addAllToScene();
        activeEnvironment.container = container;
        this.parentTopLevelEnvironmentNodes(activeEnvironment);

        for (const mesh of container.meshes) {
          mesh.isPickable = false;
        }
      })
      .catch((error) => {
        const activeEnvironment = this.environment;
        if (activeEnvironment?.loadToken === loadToken) {
          this.disposeEnvironment();
        }

        const message = error instanceof Error ? error.message : String(error);
        this.pushLog(`环境模型加载失败：${message}`);
      });
  }

  dispose(): void {
    if (this.telemetryObserver) {
      this.scene.onBeforeRenderObservable.remove(this.telemetryObserver);
    }
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
    this.modelHighlightLayer.dispose();
    this.meshes.clear();
    this.locators.clear();
    this.locatorTargets.clear();
    this.cadReferences.clear();
    this.models.clear();
    this.stackerCargoMeshes.clear();
    this.conveyorCargoMeshes.clear();
    this.lights.clear();
    this.entityStates.clear();
  }

  /** 按组件类型同步单个实体的运行时表现。 */
  private syncEntity(entity: Entity, selected: boolean): void {
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

    if (entity.components.light) {
      this.syncLightEntity(entity);
    }
  }

  /** 重建虚拟定位线框资产编号索引，供 to_x/to_y/to_z 快速查找目标位。 */
  private rebuildLocatorTargetIndex(document: SceneDocument): void {
    this.locatorTargets.clear();

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      const assetId = entity?.components.locator?.assetId.trim();
      const locator = this.locators.get(entityId);
      if (!assetId || !locator) continue;

      this.locatorTargets.set(assetId, locator);
    }
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

    const material = mesh.material instanceof StandardMaterial ? mesh.material : new StandardMaterial(`${entity.id}_mat`, this.scene);
    material.diffuseColor = selected ? Color3.FromHexString(SELECTED_MATERIAL_COLOR) : this.readColor(meshRenderer.materialColor);
    material.emissiveColor = selected ? Color3.FromHexString(SELECTED_EMISSIVE_COLOR) : Color3.Black();
    mesh.material = material;
  }

  /** 同步虚拟定位线框的根 Transform、业务尺寸和选中态线框颜色。 */
  private syncLocatorEntity(entity: Entity, selected: boolean): void {
    const locator = entity.components.locator;
    if (!locator) return;

    let runtimeLocator = this.locators.get(entity.id);
    if (!runtimeLocator) {
      runtimeLocator = this.createLocator(entity.id);
      this.locators.set(entity.id, runtimeLocator);
    }

    this.applyTransform(runtimeLocator.root, entity.components.transform);
    this.applyLocatorDimensions(runtimeLocator.box, locator);
    this.applyLocatorStyle(runtimeLocator.box, selected);
    this.applyMeshInteractivity(runtimeLocator.box, entity.id);
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
    };
    this.cadReferences.set(entity.id, pending);
    this.applyCadReferenceInteractivity(pending, entity.id);

    const cachedGeometry = consumeCadReferenceParseResult(cadReference.sourceUrl, cadReference.unitScaleToMeters);
    if (cachedGeometry) {
      void Promise.resolve().then(() => {
        const activeEntry = this.cadReferences.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.sourceUrl !== cadReference.sourceUrl) {
          return;
        }

        try {
          this.applyCadReferenceGeometry(entity.id, activeEntry, cachedGeometry);
        } catch (error) {
          console.warn('CAD 参考图加载失败', error);
          if (this.cadReferences.get(entity.id)?.loadToken === loadToken) {
            this.disposeCadReference(entity.id, activeEntry);
          }
        }
      });
      return;
    }

    void fetch(resolveRuntimeAssetUrl(cadReference.sourceUrl))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((content) => {
        const activeEntry = this.cadReferences.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.sourceUrl !== cadReference.sourceUrl) {
          return;
        }

        const geometry = parseCadReferenceDxf(content, { unitScaleToMeters: cadReference.unitScaleToMeters });
        this.applyCadReferenceGeometry(entity.id, activeEntry, geometry);
      })
      .catch((error) => {
        console.warn('CAD 参考图加载失败。', error);
        const activeEntry = this.cadReferences.get(entity.id);
        if (activeEntry?.loadToken === loadToken) {
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
      stackerCapable: this.isStackerModelAsset(modelAsset),
      conveyorCapable: this.isConveyorModelAsset(modelAsset),
      root,
      contentRoot,
      container: null,
      meshes: [],
      highlighted: false,
      loadToken,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      stackerTelemetry: this.createStackerTelemetryState(root),
      conveyorTelemetry: this.createConveyorTelemetryState(),
      stackerTelemetryReady: false,
    };
    this.models.set(entity.id, pending);
    this.applyModelInteractivity(pending, entity.id);

    const { rootUrl, fileName } = this.splitAssetUrl(this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision));

    void SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.scene)
      .then((container) => {
        const activeEntry = this.models.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.assetSignature !== assetSignature) {
          container.dispose();
          return;
        }

        container.addAllToScene();
        activeEntry.container = container;
        activeEntry.meshes = container.meshes;
        this.parentTopLevelModelNodes(activeEntry);
        this.normalizeModelContentOrigin(activeEntry);

        for (const mesh of activeEntry.meshes) {
          mesh.metadata = { ...(mesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entity.id };
        }
        this.applyModelParameters(entity, activeEntry);
        this.syncExternalModelScripts(entity, activeEntry);
        this.applyModelSelection(activeEntry, selected);
        this.applyModelInteractivity(activeEntry, entity.id);
      })
      .catch(() => {
        const activeEntry = this.models.get(entity.id);
        if (activeEntry?.loadToken === loadToken) {
          this.disposeModel(entity.id, activeEntry);
        }
      });
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
    this.applyStackerTelemetryFrame();
    this.applyConveyorTelemetryFrame();
  }

  /** 每帧把最新 MQTT stacker 遥测应用到匹配的模型实例。 */
  private applyStackerTelemetryFrame(): void {
    const snapshots = deviceTelemetryStore.getSnapshotsByDeviceType('stacker') as StackerTelemetrySnapshot[];
    if (snapshots.length === 0) return;

    const snapshotAssetCodes = new Set(snapshots.map((snapshot) => snapshot.assetCode));
    const telemetryModels = [...this.models.values()].filter(
      (model) => model.container && model.stackerTelemetryReady && snapshotAssetCodes.has(model.assetCode),
    );
    if (telemetryModels.length === 0) return;

    const deltaSeconds = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    for (const model of telemetryModels) {
      const snapshot = this.resolveStackerTelemetrySnapshot(model);
      if (!snapshot) continue;

      this.applyStackerTelemetryToModel(model, snapshot, deltaSeconds);
    }
  }

  /** 按模型资产编号精确匹配 Stacker 遥测，避免现场编号配置错误时误驱动唯一模型。 */
  private resolveStackerTelemetrySnapshot(model: ModelRuntimeEntry): StackerTelemetrySnapshot | null {
    return deviceTelemetryStore.getSnapshot(model.assetCode, 'stacker') as StackerTelemetrySnapshot | null;
  }

  /** 每帧把最新 MQTT conveyor 遥测应用到匹配的输送线模型实例。 */
  private applyConveyorTelemetryFrame(): void {
    const snapshots = deviceTelemetryStore.getSnapshotsByDeviceType('conveyor');
    if (snapshots.length === 0) return;

    const snapshotAssetCodes = new Set(snapshots.map((snapshot) => snapshot.assetCode));
    const telemetryModels = [...this.models.values()].filter((model) => {
      return model.container
        && model.stackerTelemetryReady
        && snapshotAssetCodes.has(model.assetCode)
        && this.isConveyorRuntimeModel(model);
    });
    if (telemetryModels.length === 0) return;

    const deltaSeconds = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    for (const model of telemetryModels) {
      const snapshot = this.resolveConveyorTelemetrySnapshot(model);
      if (!snapshot) continue;

      this.applyConveyorTelemetryToModel(model, snapshot, deltaSeconds);
    }
  }

  /** 按模型资产编号精确匹配 Conveyor 遥测，避免不同线体编号被唯一兜底误绑。 */
  private resolveConveyorTelemetrySnapshot(model: ModelRuntimeEntry): DeviceTelemetrySnapshot | null {
    return deviceTelemetryStore.getSnapshot(model.assetCode, 'conveyor');
  }

  /** 对单台 stacker 应用根节点、载货台和前后叉的遥测驱动。 */
  private applyStackerTelemetryToModel(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    const targetLocator = snapshot.targetLocationKey ? this.locatorTargets.get(snapshot.targetLocationKey) ?? null : null;
    this.reportStackerRuntimeState(snapshot, targetLocator);
    this.writeDeviceTelemetryMetadata(model, snapshot);

    const targetPosition = targetLocator?.root.getAbsolutePosition() ?? null;
    this.applyStackerRootMotion(model, snapshot, targetPosition, deltaSeconds);
    this.applyStackerLiftMotion(model, snapshot, targetPosition, deltaSeconds);
    this.applyStackerForkMotion(model, snapshot, targetPosition, deltaSeconds);
    this.applyStackerNodeMotionOffsets(model);
    this.applyStackerCargoMotion(model, snapshot, targetLocator);
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
    cargo.mesh.position.copyFrom(this.getConveyorCargoPosition(model));
    cargo.mesh.rotationQuaternion = this.getNodeWorldRotation(model.root);
    cargo.mesh.setEnabled(true);
    model.conveyorTelemetry.cargoCode = activeContainerCode;
  }

  /** 根据 distance_x 校准行走机构虚拟位置，并在有目标位或 movement_x 时沿轨道推进。 */
  private applyStackerRootMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetPosition: Vector3 | null,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const travelAxis = this.getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    const distanceX = readNumberField(snapshot.fields, 'distance_x');
    if (distanceX !== null) {
      const calibratedPosition = state.rootBasePosition.add(travelAxis.scale(distanceX));
      state.rootPosition = this.lerpVector(
        state.rootPosition,
        this.constrainStackerTravelPosition(model, calibratedPosition, travelAxis),
        this.getCalibrationAlpha(deltaSeconds),
      );
    }

    if (!snapshot.faulted) {
      if (targetPosition) {
        const rootTargetPosition = this.constrainStackerTravelPosition(
          model,
          this.projectPointOntoAxis(state.rootBasePosition, travelAxis, targetPosition),
          travelAxis,
        );
        state.rootPosition = this.moveVectorTowards(
          state.rootPosition,
          rootTargetPosition,
          STACKER_TARGET_SPEED_METERS_PER_SECOND * deltaSeconds,
        );
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
    targetPosition: Vector3 | null,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const distanceY = readNumberField(snapshot.fields, 'distance_y');
    if (distanceY !== null) {
      state.liftOffset = this.lerpNumber(state.liftOffset, distanceY, this.getCalibrationAlpha(deltaSeconds));
    }

    if (!snapshot.faulted) {
      if (targetPosition) {
        const targetLiftOffset = Math.max(0, targetPosition.y - state.rootBasePosition.y);
        state.liftOffset = this.moveNumberTowards(
          state.liftOffset,
          targetLiftOffset,
          STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND * deltaSeconds,
        );
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
  ): void {
    const frontMovement = readIntegerField(snapshot.fields, 'front_movement_z');
    const backMovement = readIntegerField(snapshot.fields, 'back_movement_z');
    const frontDistance = readNumberField(snapshot.fields, 'front_distance_z', 'ront_distance_z');
    const backDistance = readNumberField(snapshot.fields, 'back_distance_z');
    const frontForkSpeed = this.readSpeed(snapshot, 'front_rpm_z', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const backForkSpeed = this.readSpeed(snapshot, 'back_rpm_z', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const reach = this.readStackerForkReachConfig(model);
    const state = model.stackerTelemetry;
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const frontContainerCode = this.readContainerCode(snapshot, 'front_containerCode');
    const backContainerCode = this.readContainerCode(snapshot, 'back_containerCode');

    state.frontForkOffset = this.updateForkOffset(
      state.frontForkOffset,
      this.resolveForkCalibrationDistance(
        model,
        'front',
        frontDistance,
        targetPosition,
        this.shouldUseForkTargetProjection(frontMovement, frontCommand, frontContainerCode),
      ),
      frontMovement,
      frontForkSpeed,
      reach.total,
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
        backDistance,
        targetPosition,
        this.shouldUseForkTargetProjection(backMovement, backCommand, backContainerCode),
      ),
      backMovement,
      backForkSpeed,
      reach.total,
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
      const calibrationDirection = movementDirection || Math.sign(nextOffset) || lastDirection || 1;
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

  /** 编码器优先；缺少编码器时按目标定位框在模型局部 X 轴上的投影估算伸出距离。 */
  private resolveForkCalibrationDistance(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    encodedDistance: number | null,
    targetPosition: Vector3 | null,
    useTargetProjection: boolean,
  ): number | null {
    if (encodedDistance !== null) return encodedDistance;
    if (!targetPosition || !useTargetProjection) return null;

    const forkGroups = this.findStackerForkNodeGroups(model);
    const stageOneNodes = side === 'front' ? forkGroups.frontStageOneNodes : forkGroups.backStageOneNodes;
    const forkBounds = this.getNodesWorldBounds(stageOneNodes);
    if (!forkBounds) return null;

    const forkCenter = forkBounds.minimum.add(forkBounds.maximum).scale(0.5);
    const forkAxis = this.getModelAxis(model.root, 'x');
    const projectedDistance = Math.abs(Vector3.Dot(targetPosition.subtract(forkCenter), forkAxis));
    return Number.isFinite(projectedDistance) ? projectedDistance : null;
  }

  /** 只有有命令、动作或叉上货物的一侧才用目标 locator 估算行程，避免无编码器时两侧同时被目标牵引。 */
  private shouldUseForkTargetProjection(movement: number | null, command: number | null, containerCode: string | null): boolean {
    return movement !== null && movement !== 0
      || command !== null && command > 0 && command !== 8
      || Boolean(containerCode);
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
  ): void {
    const frontContainerCode = this.readContainerCode(snapshot, 'front_containerCode');
    const backContainerCode = this.readContainerCode(snapshot, 'back_containerCode');

    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, 'front', frontContainerCode);
    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, 'back', backContainerCode);
  }

  /** 让指定货叉上的托盘在叉尖和目标 locator 之间运动，放货完成后留在 locator 内。 */
  private applyStackerForkCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    side: StackerForkSide,
    containerCode: string | null,
  ): void {
    const command = readIntegerField(snapshot.fields, side === 'front' ? 'front_command' : 'back_command');
    const activeContainerCode = this.resolveStackerForkCargoCode(model, side, containerCode, command, targetLocator);
    if (!activeContainerCode) return;

    const cargo = this.getOrCreateStackerCargo(model.assetCode, activeContainerCode);
    const forkPosition = this.getStackerForkCargoPosition(model, side);
    const targetPosition = targetLocator?.root.getAbsolutePosition() ?? null;
    const reach = this.readStackerForkReachConfig(model);
    const placingProgress = this.getStackerCargoPlacingProgress(command, side === 'front'
      ? model.stackerTelemetry.frontForkOffset
      : model.stackerTelemetry.backForkOffset, reach);
    const nextPosition = targetPosition && placingProgress > 0
      ? this.lerpVector(forkPosition, targetPosition, placingProgress)
      : forkPosition;

    cargo.mesh.position.copyFrom(nextPosition);
    cargo.mesh.rotationQuaternion = targetLocator && placingProgress >= 1
      ? this.getNodeWorldRotation(targetLocator.root)
      : this.getNodeWorldRotation(model.root);
    cargo.mesh.setEnabled(true);
    if (targetPosition && placingProgress >= 1 && snapshot.targetLocationKey) {
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

  /** 创建或复用某个条码的运行时托盘盒。 */
  private getOrCreateStackerCargo(assetCode: string, containerCode: string): StackerCargoRuntimeEntry {
    const key = this.getStackerCargoKey(assetCode, containerCode);
    const existing = this.stackerCargoMeshes.get(key);
    if (existing) return existing;

    const mesh = MeshBuilder.CreateBox(`stacker_cargo_${this.sanitizeBabylonName(assetCode)}_${this.sanitizeBabylonName(containerCode)}`, {
      width: STACKER_CARGO_SIZE.x,
      height: STACKER_CARGO_SIZE.y,
      depth: STACKER_CARGO_SIZE.z,
    }, this.scene);
    const material = new StandardMaterial(`${mesh.name}_mat`, this.scene);
    material.diffuseColor = Color3.FromHexString(STACKER_CARGO_COLOR);
    material.emissiveColor = Color3.FromHexString(STACKER_CARGO_EMISSIVE_COLOR);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.metadata = { ...(mesh.metadata ?? {}), stackerCargo: true, assetCode, containerCode };

    const entry: StackerCargoRuntimeEntry = {
      assetCode,
      containerCode,
      mesh,
      material,
      placedLocatorKey: null,
    };
    this.stackerCargoMeshes.set(key, entry);
    return entry;
  }

  /** 基于叉节点的世界包围盒计算托盘中心位置，保证货物真实跟随前叉或后叉。 */
  private getStackerForkCargoPosition(model: ModelRuntimeEntry, side: StackerForkSide): Vector3 {
    const forkGroups = this.findStackerForkNodeGroups(model);
    const nodes = side === 'front' ? forkGroups.frontNodes : forkGroups.backNodes;
    const bounds = this.getNodesWorldBounds(nodes);
    if (!bounds) return model.root.getAbsolutePosition();

    return bounds.minimum.add(bounds.maximum).scale(0.5).add(this.getModelAxis(model.root, 'y').scale(STACKER_CARGO_SIZE.y * 0.75));
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
    const configuredNodes = config.nodes.length > 0 ? this.findModelNodesByName(model, config.nodes) : [];
    if (configuredNodes.length > 0) return this.filterTopLevelMotionNodes(configuredNodes);

    const fallbackPattern = this.createConveyorFallbackPattern(config.fallbackPattern);
    return fallbackPattern ? this.filterTopLevelMotionNodes(this.findModelNodes(model, fallbackPattern)) : [];
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

  /** 创建或复用输送线运行时货物，占位物不写入场景文档。 */
  private getOrCreateConveyorCargo(assetCode: string, containerCode: string): ConveyorCargoRuntimeEntry {
    const key = this.getConveyorCargoKey(assetCode, containerCode);
    const existing = this.conveyorCargoMeshes.get(key);
    if (existing) return existing;

    const mesh = MeshBuilder.CreateBox(`conveyor_cargo_${this.sanitizeBabylonName(assetCode)}_${this.sanitizeBabylonName(containerCode)}`, {
      width: CONVEYOR_CARGO_SIZE.x,
      height: CONVEYOR_CARGO_SIZE.y,
      depth: CONVEYOR_CARGO_SIZE.z,
    }, this.scene);
    const material = new StandardMaterial(`${mesh.name}_mat`, this.scene);
    material.diffuseColor = Color3.FromHexString(CONVEYOR_CARGO_COLOR);
    material.emissiveColor = Color3.FromHexString(CONVEYOR_CARGO_EMISSIVE_COLOR);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.metadata = { ...(mesh.metadata ?? {}), conveyorCargo: true, assetCode, containerCode };

    const entry: ConveyorCargoRuntimeEntry = {
      assetCode,
      containerCode,
      mesh,
      material,
    };
    this.conveyorCargoMeshes.set(key, entry);
    return entry;
  }

  /** 基于输送线几何包围盒计算货物位置，并沿输送方向加入短循环偏移。 */
  private getConveyorCargoPosition(model: ModelRuntimeEntry): Vector3 {
    const configuredNodes = this.readConveyorMotionConfigs(model).flatMap((config) => this.findConveyorMotionNodes(model, config));
    const conveyorNodes = configuredNodes.length > 0
      ? configuredNodes
      : this.findModelNodes(model, /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i);
    const bounds = (conveyorNodes.length > 0 ? this.getNodesWorldBounds(conveyorNodes) : null) ?? this.getModelWorldBounds(model);
    const center = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : model.root.getAbsolutePosition();
    const verticalOffset = this.getModelAxis(model.root, 'y').scale(CONVEYOR_CARGO_SIZE.y * 0.75);
    const travelAxis = this.getHorizontalModelAxis(model.root, this.readConveyorCargoTravelAxis(model));

    return center
      .add(verticalOffset)
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

  /** 生成输送线运行时货物的唯一键。 */
  private getConveyorCargoKey(assetCode: string, containerCode: string): string {
    return `${assetCode}:${containerCode}`;
  }

  /** 删除指定输送线实例生成的运行时货物，不影响其他设备。 */
  private disposeConveyorCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.conveyorCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.disposeConveyorCargo(cargo);
      this.conveyorCargoMeshes.delete(key);
    }
  }

  /** 释放单个输送线运行时货物及其材质。 */
  private disposeConveyorCargo(cargo: ConveyorCargoRuntimeEntry): void {
    cargo.material.dispose();
    cargo.mesh.dispose();
  }

  /** 生成堆垛机运行时货物的唯一键。 */
  private getStackerCargoKey(assetCode: string, containerCode: string): string {
    return `${assetCode}:${containerCode}`;
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
    const deviceKey = `${snapshot.deviceType}:${snapshot.assetCode}`;
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
    const deviceKey = `${snapshot.deviceType}:${snapshot.assetCode}`;
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

  /** 第二段收纳时隐藏克隆件，避免与第一段重叠产生闪烁。 */
  private setStackerForkStageTwoNodesEnabled(nodes: TransformNode[], enabled: boolean): void {
    for (const node of nodes) {
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
      ...(model.container?.transformNodes ?? []),
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

  private createMesh(entity: Entity): Mesh {
    const meshKind = entity.components.meshRenderer?.meshKind ?? 'cube';

    if (meshKind === 'sphere') {
      const mesh = MeshBuilder.CreateSphere(entity.id, { diameter: 1 }, this.scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    if (meshKind === 'plane') {
      const mesh = MeshBuilder.CreateGround(entity.id, { width: 2, height: 2 }, this.scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    const mesh = MeshBuilder.CreateBox(entity.id, { size: 1 }, this.scene);
    mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
    return mesh;
  }

  /** 创建虚拟定位线框：根节点交给 Gizmo，子级透明盒负责拾取和边线显示。 */
  private createLocator(entityId: string): LocatorRuntimeEntry {
    const root = new TransformNode(`${entityId}_locatorRoot`, this.scene);
    const box = MeshBuilder.CreateBox(`${entityId}_locatorBox`, { size: 1 }, this.scene);
    const material = new StandardMaterial(`${entityId}_locatorMat`, this.scene);

    material.disableLighting = true;
    material.alpha = LOCATOR_SURFACE_ALPHA;
    material.diffuseColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);
    material.emissiveColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);

    box.parent = root;
    box.isPickable = true;
    box.material = material;
    box.metadata = { ...(box.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };
    box.enableEdgesRendering();
    box.edgesWidth = 2;
    box.edgesColor = this.color4FromHex(LOCATOR_EDGE_COLOR, 1);

    return { root, box };
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

  /** 释放实体对应的 Mesh 与材质资源。 */
  private disposeMesh(entityId: string, mesh: Mesh): void {
    mesh.material?.dispose();
    mesh.dispose();
    this.meshes.delete(entityId);
  }

  /** 释放虚拟定位线框的根节点、拾取盒和材质。 */
  private disposeLocator(entityId: string, locator: LocatorRuntimeEntry): void {
    locator.box.material?.dispose();
    locator.box.dispose();
    locator.root.dispose();
    this.locators.delete(entityId);
  }

  /** 释放 CAD 参考图的所有线稿 Mesh 与根节点。 */
  private disposeCadReference(entityId: string, cadReference: CadReferenceRuntimeEntry): void {
    for (const lineMesh of cadReference.lineMeshes) {
      lineMesh.dispose();
    }
    cadReference.root.dispose();
    this.cadReferences.delete(entityId);
  }

  /** 释放导入模型的容器、根节点与所有子资源。 */
  private disposeModel(entityId: string, model: ModelRuntimeEntry): void {
    this.applyModelSelection(model, false);
    model.externalScriptRuntime?.dispose();
    this.disposeStackerCargoForAssetCode(model.assetCode);
    this.disposeConveyorCargoForAssetCode(model.assetCode);
    for (const texture of model.textureCache.values()) {
      texture.dispose();
    }
    model.container?.dispose();
    model.contentRoot.dispose();
    model.root.dispose();
    this.models.delete(entityId);
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

  /** 释放单个运行时托盘盒及其材质。 */
  private disposeStackerCargo(cargo: StackerCargoRuntimeEntry): void {
    cargo.material.dispose();
    cargo.mesh.dispose();
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
      && (this.meshes.has(entityId) || this.locators.has(entityId) || this.models.has(entityId))
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

  /** 根据解析后的 CAD 几何批量创建 Babylon 线稿层。 */
  private applyCadReferenceGeometry(
    entityId: string,
    cadReference: CadReferenceRuntimeEntry,
    geometry: CadReferenceParseResult,
  ): void {
    for (const layer of geometry.layers) {
      if (layer.polylines.length === 0) continue;

      const lineMesh = MeshBuilder.CreateLineSystem(
        `${entityId}_cadLayer_${this.sanitizeBabylonName(layer.name)}`,
        {
          lines: layer.polylines.map((polyline) =>
            polyline.map((point) => new Vector3(point.x, point.y, point.z)),
          ),
        },
        this.scene,
      );
      lineMesh.parent = cadReference.root;
      lineMesh.isPickable = false;
      lineMesh.metadata = { ...(lineMesh.metadata ?? {}), cadReferenceLayer: layer.name };
      cadReference.lineMeshes.push(lineMesh);
    }

    this.applyCadReferenceLineMeshStyle(cadReference);
    this.applyCadReferenceInteractivity(cadReference, entityId);
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

  /** 将 locator 的业务尺寸映射到子级盒体，保持根节点 Transform 不被尺寸污染。 */
  private applyLocatorDimensions(box: Mesh, locator: LocatorComponent): void {
    box.scaling = new Vector3(locator.length, locator.height, locator.width);
  }

  /** 根据选中状态更新 locator 边线和极低透明交互面的颜色。 */
  private applyLocatorStyle(box: Mesh, selected: boolean): void {
    const color = selected ? SELECTED_MATERIAL_COLOR : LOCATOR_EDGE_COLOR;
    const color3 = Color3.FromHexString(color);

    box.edgesWidth = selected ? 4 : 2;
    box.edgesColor = this.color4FromHex(color, 1);

    if (box.material instanceof StandardMaterial) {
      box.material.alpha = selected ? SELECTED_LOCATOR_SURFACE_ALPHA : LOCATOR_SURFACE_ALPHA;
      box.material.diffuseColor = color3;
      box.material.emissiveColor = color3;
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
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  /** 将导入模型源单位换算到米，避免污染可被 Gizmo 写回的实体根 Transform。 */
  private applyModelUnitScale(target: TransformNode, unitScaleToMeters: number): void {
    target.scaling = new Vector3(unitScaleToMeters, unitScaleToMeters, unitScaleToMeters);
  }

  /** 根据参数配置把声明式绑定应用到模型节点、网格和材质。 */
  private applyModelParameters(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset?.parameterConfig || !modelAsset.parameterValues || !model.container) return;

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

  /** 同步模型包外置脚本的元数据、参数值和生命周期。 */
  private syncExternalModelScripts(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset || !model.container) return;

    this.syncModelScriptMetadata(model.contentRoot, modelAsset);

    const scriptAssets = modelAsset.scriptAssets ?? [];
    if (scriptAssets.length === 0) {
      model.externalScriptRuntime?.dispose();
      model.externalScriptRuntime = null;
      model.externalScriptSignature = '';
      this.resetStackerTelemetryState(model);
      this.resetConveyorTelemetryState(model);
      model.stackerTelemetryReady = true;
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

    if (!model.externalScriptRuntime || model.externalScriptSignature !== signature) {
      model.stackerTelemetryReady = false;
      model.externalScriptRuntime?.dispose();
      model.externalScriptRuntime = new ExternalModelScriptRuntime(model.contentRoot, modelAsset);
      model.externalScriptSignature = signature;
      model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
      model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);

      const runtime = model.externalScriptRuntime;
      const loadToken = model.loadToken;
      void runtime.start().then(() => {
        const current = [...this.models.values()].find((entry) => entry.externalScriptRuntime === runtime);
        if (!current || current.loadToken !== loadToken) return;
        runtime.update();
        this.resetStackerTelemetryState(current);
        this.resetConveyorTelemetryState(current);
        current.stackerTelemetryReady = true;
      });
      return;
    }

    model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
    model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);
    model.externalScriptRuntime.update();
    this.resetStackerTelemetryState(model);
    this.resetConveyorTelemetryState(model);
    model.stackerTelemetryReady = true;
  }

  /** 模型完成归一化和外置脚本初始化后，重新建立 Stacker 遥测基线。 */
  private resetStackerTelemetryState(model: ModelRuntimeEntry): void {
    model.stackerTelemetry.rootBasePosition = model.root.position.clone();
    model.stackerTelemetry.rootPosition = null;
    model.stackerTelemetry.travelConstraint = null;
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

    return (model.container?.transformNodes ?? []).filter((node) => node.name === binding.target.name);
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

    for (const node of model.container?.transformNodes ?? []) {
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

  private loadOrReuseTexture(relativePath: string, modelAsset: ModelAssetComponent, model: ModelRuntimeEntry): Texture | null {
    const textureUrl = this.resolveModelRelativeAssetUrl(modelAsset, relativePath);
    if (!textureUrl) return null;

    const existing = model.textureCache.get(textureUrl);
    if (existing) return existing;

    const texture = new Texture(textureUrl, this.scene);
    model.textureCache.set(textureUrl, texture);
    return texture;
  }

  private resolveModelRelativeAssetUrl(modelAsset: ModelAssetComponent, relativePath: string): string | null {
    const editorAssetUrl = resolveRelativeEditorAssetUrl(modelAsset.sourceUrl, relativePath, /\.(png|jpe?g|webp)$/i);
    return editorAssetUrl ? this.resolveVersionedRuntimeAssetUrl(editorAssetUrl, modelAsset.assetRevision) : null;
  }

  /** 用模型源 URL 和导入版本生成加载签名，同路径覆盖时也能触发重新载入。 */
  private createModelAssetSignature(modelAsset: ModelAssetComponent): string {
    return JSON.stringify({
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
    });
  }

  /** 给运行时资源 URL 追加导入版本参数，绕开浏览器和 Electron 对同路径资源的缓存。 */
  private resolveVersionedRuntimeAssetUrl(sourceUrl: string, assetRevision: string | undefined | null): string {
    const runtimeUrl = resolveRuntimeAssetUrl(sourceUrl);
    if (!assetRevision) return runtimeUrl;

    const separator = runtimeUrl.includes('?') ? '&' : '?';
    return `${runtimeUrl}${separator}assetRevision=${encodeURIComponent(assetRevision)}`;
  }

  /** 根据选中状态给导入模型添加或移除 HighlightLayer 高亮，不破坏原始材质。 */
  private applyModelSelection(model: ModelRuntimeEntry, selected: boolean): void {
    if (model.highlighted === selected) return;

    for (const mesh of model.meshes) {
      if (!(mesh instanceof Mesh)) continue;

      if (selected) {
        this.modelHighlightLayer.addMesh(mesh, Color3.FromHexString(SELECTED_MATERIAL_COLOR));
      } else {
        this.modelHighlightLayer.removeMesh(mesh);
      }
    }

    model.highlighted = selected;
  }

  /** 仅把 glTF 顶层节点挂到模型内容节点，保留模型内部层级、骨骼和动画关系。 */
  private parentTopLevelModelNodes(model: ModelRuntimeEntry): void {
    const transformNodes = model.container?.transformNodes ?? [];
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

  /** 将导入模型内容的底部中心归一到实体根节点，避免源模型巨大坐标偏移影响场景放置。 */
  private normalizeModelContentOrigin(model: ModelRuntimeEntry): void {
    model.root.computeWorldMatrix(true);

    const childMeshes = model.root.getChildMeshes(false);
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
