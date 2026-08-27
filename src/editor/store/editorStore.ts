import { create } from 'zustand';
import {
  createCommandHistory,
  executeCommand,
  redoCommand,
  undoCommand,
  type CommandHistory,
} from '../commands/CommandHistory';
import {
  commitFolderGroupRotation as commitFolderGroupRotationState,
  commitFolderGroupTranslation as commitFolderGroupTranslationState,
  commitHierarchyGroupRotation as commitHierarchyGroupRotationState,
  commitHierarchyGroupTranslation as commitHierarchyGroupTranslationState,
  updateAutoPatrolCommand,
  createEntityCommand,
  createFolderCommand,
  moveEntitiesToFolderCommand,
  renameEntityCommand,
  updateCadReferenceCommand,
  updateSceneDocumentCommand,
  updateSceneDefaultCargoGeneratorCommand,
  updateSceneEnvironmentCommand,
  updateEntityLockCommand,
  updateEntityVisibilityCommand,
  updateLightCommand,
  updateLocatorCommand,
  updateMeshRendererCommand,
  updateModelAssetCodeCommand,
  updateModelGeneratorCommand,
  updatePoiEffectCommand,
  updateModelParameterValuesCommand,
  updateTelemetryBindingCommand,
  updateTransformCommand,
  type FolderGroupRotationInput,
  type FolderGroupTranslationInput,
  type HierarchyGroupRotationInput,
  type HierarchyGroupTranslationInput,
} from '../commands/entityCommands';
import {
  DEFAULT_EDITOR_GRID_SETTINGS,
  EDITOR_GRID_CELL_SIZES,
  type CameraOrientation,
  type CameraProjection,
  type StandardCameraOrientation,
  type EditorGridCellSize,
  type EditorGridSettings,
} from '../../runtime/babylon/createEngine';
import type { AssetEntry } from '../assets/AssetDatabase';
import { createImportedAssetIndexes, findImportedAssetForModelAsset } from '../assets/modelAssetRelink';
import { createId } from '../../shared/ids';
import type {
  AutoPatrolComponent,
  AutoPatrolWaypoint,
  CadReferenceComponent,
  LightComponent,
  LightKind,
  LocatorComponent,
  LocatorFetchDriveConfig,
  MeshKind,
  MeshRendererComponent,
  ModelAssetComponent,
  ModelAssetTemplate,
  ModelGeneratorComponent,
  ModelGeneratorTarget,
  PoiEffectComponent,
  PoiEffectKind,
  SkyboxComponent,
  TransformComponent,
} from '../model/components';
import type { Entity } from '../model/Entity';
import { resolveLightTransformTool } from '../model/lightEditor';
import { STANDARD_CAMERA_VIEW_LABELS } from '../model/cameraOrientation';
import {
  collectEntitySubtreeIds,
  getTopLevelHierarchyEntityIds,
  isEntityAncestorOf,
  isEntityEffectivelyLocked,
  isEntityEffectivelyVisible,
  isHierarchyGroupTransformSelection,
  resolveHierarchyGroupTransformSelection,
} from '../model/entityHierarchy';
import { createArrayAssetNumber, getArrayAssetNumberRuleError } from '../model/arrayAssetNumbering';
import {
  createEntityArrayName,
  createModelArrayIdentity,
  ENTITY_NAME_MAX_LENGTH,
  getEntityArrayIdentifierError,
  getEntityArrayParameterError,
  MODEL_ARRAY_COPY_COUNT_MAX,
  MODEL_ARRAY_ITEM_COUNT_MAX,
  normalizeModelArrayDirection,
} from '../model/modelArray';
import {
  MODEL_ASSET_CODE_MAX_LENGTH,
  createDefaultSceneEnvironmentTransform,
  createEmptySceneDocument,
  createAutoPatrolEntity,
  createCadReferenceEntity,
  createFolderEntity,
  createLightEntity,
  createLocatorEntity,
  createManualRoamSpawnEntity,
  createMeshEntity,
  createModelEntity,
  createModelGeneratorEntity,
  createPoiEffectEntity,
  createSkyboxComponent,
  createSkyboxEntity,
  getSceneSkyboxEntity,
  getSceneSkyboxSettings,
  createModelAssetCode,
  extractModelAssetCodePrefix,
  normalizeSkyboxSphereScale,
  sanitizeFetchConfig,
  sanitizeMqttConfig,
  sanitizeSceneEnvironment,
  sanitizeSceneSkybox,
  sanitizeSceneSensitivityValue,
  sanitizeSceneShadowSettings,
  isSceneShadowSettingsEqual,
  sanitizeSceneViewDistance,
  SCENE_SKYBOX_VIEW_DISTANCE_MIN,
  type SceneCameraPose,
  type FetchConfig,
  type MqttConfig,
  type SceneEnvironmentSettings,
  type SceneEnvironmentTransform,
  type SceneSkyboxSettings,
  type SceneSensitivitySettings,
  type SceneShadowSettings,
  type SceneDocument,
} from '../model/SceneDocument';
import {
  containsManualRoamSpawnEntity,
  findManualRoamSpawnEntity,
} from '../model/manualRoamSpawn';
import type { Vector3Data } from '../model/math';
import {
  AUTO_PATROL_MAX_WAYPOINTS,
  cloneAutoPatrolComponent,
  createAutoPatrolWaypointFromWorldPose,
  sanitizeAutoPatrolComponent,
  updateAutoPatrolWaypointView,
} from '../model/autoPatrol';
import type { AutoPatrolPlaybackSnapshot } from '../../runtime/babylon/AutoPatrolPlaybackController';
import { vector3 } from '../model/math';
import {
  deriveLocatorDimensionsFromBinding,
  findBuiltInSlotEntityId,
  getBuiltInSlotBindingConfig,
  patchBuiltInSlotDimensions,
  type BuiltInSlotBindingConfig,
} from '../model/builtInSlotBinding';
import {
  createIdleEnvironmentRuntimeSnapshot,
  hasManagedEnvironmentCacheReference,
  resolveEnvironmentRuntimeSettings,
  type EnvironmentApplyRequest,
  type EnvironmentApplyResult,
  type EnvironmentRuntimeSnapshot,
} from '../model/environmentRuntime';
import {
  areModelParameterValuesEqual,
  cloneModelParameterValues,
  findModelParameterDefinition,
  normalizeModelParameterConfig,
  sanitizeModelParameterValue,
  sanitizeModelParameterValues,
  type ModelParameterValue,
  type ModelParameterValues,
} from '../model/modelParameters';
import { createModelLengthUnitInfo, type ModelLengthUnitInfo } from '../model/sceneUnits';
import type { ModelMeasurementResult } from '../../runtime/babylon/modelMeasurement';
import type { GroupSpatialInfoResult } from '../model/groupSpatialInfo';
import {
  isMqttConfigEqual,
  validateRuntimePreviewConfig,
  type RuntimePreviewReadiness,
} from '../model/mqttConfigUtils';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import {
  cloneModelGeneratorComponent,
  createModelGeneratorTargetFromAsset,
  sanitizeModelGeneratorComponent,
} from '../model/modelGenerator';
import {
  createDefaultTelemetryBinding,
  hasModelDataDrivenMotionKey,
  normalizeTelemetryBindingComponent,
} from '../model/telemetryBinding';
import { sanitizePoiEffectComponent } from '../model/poiEffect';
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
import {
  CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES,
  createCadReferenceComponentMetadata,
  rememberCadReferenceParseResult,
  sanitizeCadReferenceDisplayPatch,
} from '../cad/cadReference';
import { formatCadReferenceUnitSummary } from '../cad/cadUnits';
import { parseCadReferenceDxfForImport } from '../cad/cadReferenceWorkerClient';

type EditorLog = {
  id: string;
  message: string;
};

export type CadImportProgress = {
  id: string;
  active: boolean;
  percent: number;
  label: string;
  detail: string;
  fileName: string | null;
};

type EntityClipboardEntry = {
  rootId: string;
  entities: Entity[];
};

type EntityClipboard = {
  id: string;
  entries: EntityClipboardEntry[];
};

export type EntityArrayDirection = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

type EntityArrayRequest = {
  id: string;
  sourceIds: string[];
  copyCount: number;
  direction: EntityArrayDirection;
  spacingMeters: number;
  assetNumberRule: string;
};

export type ResolvedEntityArrayInput = {
  sourceIds: string[];
  copyCount: number;
  directionVector: Vector3Data;
  selectionSpanMeters: number;
  spacingMeters: number;
  assetNumberRule: string;
};

export type EntityArrayCommitResult =
  | { ok: true; duplicatedIds: string[]; modelArrayItemIds: string[]; createdCount: number }
  | { ok: false; error: string };

export type SceneFocusRequest = {
  id: string;
  entityIds: string[];
};

export type ProjectAssetFocusRequest = {
  id: string;
  sourcePath: string;
  sourceUrl: string;
  entityName: string;
};

export type CameraPoseSaveRequest = {
  id: string;
  orientation: CameraOrientation;
  projection: CameraProjection;
};

export type CameraResetRequest = {
  id: string;
};

export type AutoPatrolCameraRequest =
  | { id: string; kind: 'capture'; entityId: string; waypointId: string | null }
  | { id: string; kind: 'focus'; entityId: string; waypointId: string };

export type AutoPatrolPlaybackRequest = {
  id: string;
  action: 'start' | 'pause' | 'resume' | 'stop' | 'return';
  routeId: string | null;
};

/** 当前 Inspector 选中模型的运行时米制测量快照；该状态不进入场景持久化或撤销历史。 */
export type SelectedModelMeasurement = ModelMeasurementResult & { entityId: string };

/** 当前 Hierarchy 群组的运行时空间快照；旋转取实际参与成员中的第一个对象作为参考。 */
export type SelectedGroupSpatialInfo = GroupSpatialInfoResult & {
  groupId: string;
  rotation: Vector3Data;
};

export type GroupInspectorTransformField = 'position' | 'rotation';

export type GroupInspectorTransformRequest = {
  id: string;
  groupId: string;
  field: GroupInspectorTransformField;
  axis: keyof Vector3Data;
  value: number;
};

type TransformField = 'position' | 'rotation' | 'scale';
export type TransformTool = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'global';

type GroupTransformModeRestore = {
  tool: TransformTool;
  space: TransformSpace;
};
export type TransformSnapSettingKey = 'position' | 'rotationDegrees' | 'scale';
export type SceneSensitivitySettingKey = keyof SceneSensitivitySettings;

export type EnvironmentApplyOptions = {
  autoAlign?: boolean;
  focusAfterLoad?: boolean;
  commandLabel?: string;
  successMessage?: string;
  persistSceneChange?: boolean;
  runtimeEnvironment?: SceneEnvironmentSettings;
  expectedSceneSessionId?: string;
  expectedEnvironmentState?: {
    environment: SceneEnvironmentSettings | null;
    applyRequestId: string | null;
  };
};

export type EnvironmentDisplayPatch = Partial<Pick<
  SceneEnvironmentSettings,
  'visible' | 'opacity' | 'placementMode' | 'transform'
>>;

export type TransformSnapSettings = {
  enabled: boolean;
  position: number;
  rotationDegrees: number;
  scale: number;
};

const DEFAULT_SNAP_SETTINGS: TransformSnapSettings = {
  enabled: false,
  position: 0.5,
  rotationDegrees: 15,
  scale: 0.1,
};

const RADIANS_TO_DEGREES = 180 / Math.PI;

const AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT: AutoPatrolPlaybackSnapshot = {
  phase: 'idle',
  routeId: null,
  routeName: null,
  currentWaypointIndex: null,
  waypointCount: 0,
  pausedByManualInput: false,
  canReturnToStart: false,
};

const LOCATOR_MIN_DIMENSION = 0.01;
const LOCATOR_ASSET_ID_MAX_LENGTH = 128;

/** 比较两份模型测量快照，避免相同运行时结果触发无意义的 React 重渲染。 */
function areSelectedModelMeasurementsEqual(
  left: SelectedModelMeasurement | null,
  right: SelectedModelMeasurement | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.entityId !== right.entityId || left.status !== right.status) return false;
  if (left.status !== 'ready' || right.status !== 'ready') return true;

  return Math.abs(left.sizeMeters.x - right.sizeMeters.x) <= 1e-6
    && Math.abs(left.sizeMeters.y - right.sizeMeters.y) <= 1e-6
    && Math.abs(left.sizeMeters.z - right.sizeMeters.z) <= 1e-6;
}

/** 比较群组空间快照，避免相同包围盒结果触发 Inspector 重渲染。 */
function areSelectedGroupSpatialInfosEqual(
  left: SelectedGroupSpatialInfo | null,
  right: SelectedGroupSpatialInfo | null,
): boolean {
  if (left === right) return true;
  if (
    !left
    || !right
    || left.groupId !== right.groupId
    || left.status !== right.status
    || left.memberCount !== right.memberCount
  ) return false;
  if (
    Math.abs(left.rotation.x - right.rotation.x) > 1e-6
    || Math.abs(left.rotation.y - right.rotation.y) > 1e-6
    || Math.abs(left.rotation.z - right.rotation.z) > 1e-6
  ) return false;
  if (left.status !== 'ready' || right.status !== 'ready') return true;

  return Math.abs(left.center.x - right.center.x) <= 1e-6
    && Math.abs(left.center.y - right.center.y) <= 1e-6
    && Math.abs(left.center.z - right.center.z) <= 1e-6
    && Math.abs(left.sizeMeters.x - right.sizeMeters.x) <= 1e-6
    && Math.abs(left.sizeMeters.y - right.sizeMeters.y) <= 1e-6
    && Math.abs(left.sizeMeters.z - right.sizeMeters.z) <= 1e-6;
}

/** 模型阵列方向到世界坐标单位偏移的映射，负方向通过向量符号表达。 */
const ENTITY_ARRAY_DIRECTION_VECTORS: Record<EntityArrayDirection, Vector3Data> = {
  x: { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

type EditorState = {
  scene: SceneDocument;
  sceneSessionId: string;
  persistedSceneContent: string;
  runtimeMode: EditorRuntimeMode;
  history: CommandHistory;
  hierarchySelectionIds: string[];
  entityClipboard: EntityClipboard | null;
  entityArrayRequest: EntityArrayRequest | null;
  sceneFocusRequest: SceneFocusRequest | null;
  environmentApplyRequest: EnvironmentApplyRequest | null;
  environmentRuntimeOverride: SceneEnvironmentSettings | null;
  environmentStartupRelinkSessionId: string | null;
  environmentRuntimeSnapshot: EnvironmentRuntimeSnapshot;
  environmentAdjustmentActive: boolean;
  environmentFocusRequest: { id: string } | null;
  projectAssetFocusRequest: ProjectAssetFocusRequest | null;
  revealHierarchyEntityRequest: { id: string; entityId: string } | null;
  cameraPoseSaveRequest: CameraPoseSaveRequest | null;
  cameraResetRequest: CameraResetRequest | null;
  selectedAutoPatrolWaypointId: string | null;
  autoPatrolCameraRequest: AutoPatrolCameraRequest | null;
  autoPatrolPlaybackRequest: AutoPatrolPlaybackRequest | null;
  autoPatrolPlaybackSnapshot: AutoPatrolPlaybackSnapshot;
  cameraOrientation: CameraOrientation;
  cameraProjection: CameraProjection;
  selectedModelMeasurement: SelectedModelMeasurement | null;
  selectedGroupSpatialInfo: SelectedGroupSpatialInfo | null;
  groupInspectorTransformRequest: GroupInspectorTransformRequest | null;
  cadImportProgress: CadImportProgress | null;
  logs: EditorLog[];
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  groupTransformModeRestore: GroupTransformModeRestore | null;
  snapSettings: TransformSnapSettings;
  gridSettings: EditorGridSettings;
  trajectoryVisible: boolean;
  startRuntimePreview: () => RuntimePreviewReadiness;
  stopRuntimePreview: () => void;
  setTransformTool: (tool: TransformTool) => void;
  setTransformSpace: (space: TransformSpace) => void;
  setSnapEnabled: (enabled: boolean) => void;
  updateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  setGridVisible: (visible: boolean) => void;
  setGridCellSize: (cellSizeMeters: EditorGridCellSize) => void;
  setTrajectoryVisible: (visible: boolean) => void;
  renameScene: (name: string) => void;
  resetSceneToBlank: () => void;
  setCameraViewDistance: (viewDistance: number) => void;
  updateSensitivitySetting: (key: SceneSensitivitySettingKey, value: number) => void;
  updateShadowSettings: (patch: Partial<SceneShadowSettings>) => void;
  updateEnvironmentConfig: (environment: SceneEnvironmentSettings | null) => void;
  setDefaultCargoGenerator: (generatorId: string | null) => void;
  requestEnvironmentApply: (
    environment: SceneEnvironmentSettings,
    options?: EnvironmentApplyOptions,
  ) => string | null;
  completeEnvironmentApply: (requestId: string, result: EnvironmentApplyResult) => void;
  failEnvironmentApply: (requestId: string, message: string) => void;
  setEnvironmentRuntimeSnapshot: (snapshot: EnvironmentRuntimeSnapshot) => void;
  updateEnvironmentDisplay: (patch: EnvironmentDisplayPatch, label: string) => void;
  previewEnvironmentTransform: (transform: SceneEnvironmentTransform) => void;
  commitEnvironmentTransform: (
    before: SceneEnvironmentTransform,
    after: SceneEnvironmentTransform,
  ) => void;
  setEnvironmentAdjustmentActive: (active: boolean) => void;
  requestEnvironmentFocus: () => void;
  consumeEnvironmentFocusRequest: (requestId: string) => void;
  convertLegacyEnvironmentToSceneBase: () => void;
  updateSkyboxConfig: (skybox: SceneSkyboxSettings | null) => void;
  placeSkybox: (skybox: SceneSkyboxSettings, placementPosition?: Vector3Data) => void;
  updateSelectedSkybox: (patch: Partial<Pick<SkyboxComponent, 'intensity' | 'resolution'>>) => void;
  setEnvironmentActiveVariant: (sourceUrl: string) => void;
  requestCameraPoseSave: () => void;
  consumeCameraPoseSaveRequest: (requestId: string, pose: SceneCameraPose) => void;
  requestCameraReset: () => void;
  consumeCameraResetRequest: (requestId: string) => void;
  selectAutoPatrolWaypoint: (waypointId: string | null) => void;
  requestAutoPatrolCapture: () => void;
  requestAutoPatrolFocus: (waypointId: string) => void;
  consumeAutoPatrolCameraRequest: (requestId: string, pose?: SceneCameraPose) => void;
  requestAutoPatrolPlayback: (action: AutoPatrolPlaybackRequest['action'], routeId?: string | null) => void;
  consumeAutoPatrolPlaybackRequest: (requestId: string) => void;
  setAutoPatrolPlaybackSnapshot: (snapshot: AutoPatrolPlaybackSnapshot) => void;
  setCameraOrientation: (orientation: CameraOrientation) => void;
  toggleCameraStandardView: (orientation: StandardCameraOrientation) => void;
  setCameraProjection: (projection: CameraProjection) => void;
  setSelectedModelMeasurement: (measurement: SelectedModelMeasurement | null) => void;
  setSelectedGroupSpatialInfo: (info: SelectedGroupSpatialInfo | null) => void;
  requestSelectedGroupTransform: (
    field: GroupInspectorTransformField,
    axis: keyof Vector3Data,
    value: number,
  ) => void;
  consumeGroupInspectorTransformRequest: (requestId: string) => void;
  createMesh: (meshKind: MeshKind, placementPosition?: Vector3Data) => void;
  createLocator: (placementPosition?: Vector3Data) => void;
  createLight: (lightKind: LightKind, placementPosition?: Vector3Data) => void;
  createModelGenerator: (placementPosition?: Vector3Data) => void;
  createAutoPatrol: (placementPosition?: Vector3Data) => void;
  createManualRoamSpawn: (placementPosition?: Vector3Data) => void;
  createPoiEffect: (effectKind: PoiEffectKind, placementPosition?: Vector3Data) => void;
  createFolder: () => void;
  importModelAsset: (asset: AssetEntry, placementPosition?: Vector3Data) => void;
  refreshModelInstancesFromAssets: (assets: AssetEntry[]) => number;
  importCadReference: () => Promise<void>;
  loadSceneAsset: (asset: AssetEntry) => Promise<void>;
  selectEntity: (entityId: string | null) => void;
  selectHierarchyEntities: (entityIds: string[], primaryEntityId: string | null) => void;
  moveEntitiesToFolder: (entityIds: string[], folderId: string | null) => void;
  toggleEntityVisible: (entityId: string) => void;
  toggleEntityLocked: (entityId: string) => void;
  hideSelectedEntities: () => void;
  lockSelectedEntities: () => void;
  copySelectedEntities: () => void;
  pasteEntityClipboard: (targetFolderId?: string | null) => void;
  requestEntityArray: (copyCount: number, direction: EntityArrayDirection, spacingMeters: number, assetNumberRule: string) => void;
  resolveEntityArrayRequest: (requestId: string, selectionSpanMeters: number | null) => void;
  commitResolvedEntityArray: (input: ResolvedEntityArrayInput) => EntityArrayCommitResult;
  groupSelectedEntities: () => void;
  ungroupSelectedEntities: () => void;
  requestSceneFocusForSelection: () => void;
  requestProjectAssetFocusForEntity: (entityId: string | null) => void;
  consumeSceneFocusRequest: (requestId: string) => void;
  requestRevealHierarchyEntity: (entityId: string) => void;
  consumeRevealHierarchyEntityRequest: (requestId: string) => void;
  consumeProjectAssetFocusRequest: (requestId: string) => void;
  renameSelectedEntity: (name: string) => void;
  deleteSelectedEntity: () => void;
  updateSelectedTransform: (field: TransformField, axis: keyof Vector3Data, value: number) => void;
  updateSelectedMaterialColor: (materialColor: string) => void;
  updateSelectedLocator: (patch: Partial<LocatorComponent>) => void;
  updateSelectedCadReference: (patch: Partial<Pick<CadReferenceComponent, 'lineColor' | 'opacity'>>) => void;
  updateSelectedLight: (patch: Partial<LightComponent>) => void;
  updateSelectedModelAssetCode: (assetCode: string) => void;
  updateSelectedModelGenerator: (component: ModelGeneratorComponent, label?: string) => void;
  updateSelectedPoiEffect: (component: PoiEffectComponent, label?: string) => void;
  updateSelectedAutoPatrol: (component: AutoPatrolComponent, label?: string) => void;
  commitSelectedAutoPatrolWaypointTransform: (waypointId: string, transform: TransformComponent) => void;
  updateSelectedTelemetryBinding: (binding: import('../model/telemetryBinding').TelemetryBindingComponent | null) => void;
  restoreSelectedTelemetryBindingDefault: () => void;
  updateSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
  previewSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
  commitSelectedModelParameterValues: (before: ModelParameterValues, after: ModelParameterValues) => void;
  previewEntityTransform: (entityId: string, transform: TransformComponent) => void;
  commitEntityTransform: (entityId: string, before: TransformComponent, after: TransformComponent) => void;
  commitFolderGroupTranslation: (input: FolderGroupTranslationInput) => boolean;
  commitFolderGroupRotation: (input: FolderGroupRotationInput) => boolean;
  commitHierarchyGroupTranslation: (input: HierarchyGroupTranslationInput) => boolean;
  commitHierarchyGroupRotation: (input: HierarchyGroupRotationInput) => boolean;
  previewSelectedTransform: (transform: TransformComponent) => void;
  commitSelectedTransform: (before: TransformComponent, after: TransformComponent) => void;
  updateMqttConfig: (config: MqttConfig) => void;
  updateFetchConfig: (config: FetchConfig) => void;
  undo: () => void;
  redo: () => void;
  newScene: () => void;
  hasUnsavedChanges: () => boolean;
  markScenePersisted: (content?: string) => void;
  saveScene: () => Promise<boolean>;
  loadScene: () => Promise<boolean>;
  loadSceneFromFile: (filePath: string) => Promise<boolean>;
  loadSceneFromContent: (content: string, sourceName: string) => boolean;
  pushLog: (message: string) => void;
};

/** 判断当前 store 是否处于运行预览只读模式。 */
function isRuntimePreviewState(state: EditorState): boolean {
  return state.runtimeMode === 'preview';
}

/** 在运行预览中拦截会修改场景文档或历史记录的入口。 */
function guardRuntimePreviewMutation(state: EditorState, actionLabel: string): EditorState {
  if (!isRuntimePreviewState(state)) return state;
  return {
    ...state,
    logs: prependLog(state.logs, `运行预览只读：已阻止${actionLabel}。`),
  };
}

function createLog(message: string): EditorLog {
  return { id: crypto.randomUUID(), message };
}

function prependLog(logs: EditorLog[], message: string): EditorLog[] {
  return [createLog(message), ...logs].slice(0, 100);
}

/** 生成切换场景后的统一状态，避免旧场景的历史、选区和剪贴板泄漏到新场景。 */
function createLoadedSceneState(state: EditorState, scene: SceneDocument, message: string): Partial<EditorState> {
  const camera = scene.sceneSettings.camera;
  const sceneSessionId = createId('scene_session');

  return {
    scene,
    sceneSessionId,
    persistedSceneContent: serializeScene(scene),
    history: createCommandHistory(),
    hierarchySelectionIds: [],
    entityClipboard: null,
    entityArrayRequest: null,
    sceneFocusRequest: null,
    environmentApplyRequest: null,
    environmentRuntimeOverride: null,
    environmentStartupRelinkSessionId: hasManagedEnvironmentCacheReference(scene.sceneSettings.environment)
      ? sceneSessionId
      : null,
    environmentRuntimeSnapshot: createIdleEnvironmentRuntimeSnapshot(),
    environmentAdjustmentActive: false,
    environmentFocusRequest: null,
    projectAssetFocusRequest: null,
    revealHierarchyEntityRequest: null,
    cameraPoseSaveRequest: null,
    cameraResetRequest: { id: createId('camera_reset') },
    selectedAutoPatrolWaypointId: null,
    autoPatrolCameraRequest: null,
    autoPatrolPlaybackRequest: null,
    autoPatrolPlaybackSnapshot: AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT,
    cameraOrientation: camera.savedOrientation,
    cameraProjection: camera.savedProjection,
    selectedModelMeasurement: null,
    transformTool: state.groupTransformModeRestore?.tool ?? state.transformTool,
    transformSpace: state.groupTransformModeRestore?.space ?? state.transformSpace,
    groupTransformModeRestore: null,
    logs: prependLog(state.logs, message),
  };
}

/** 打开任意场景或新建空白场景后异步同步环境模型。 */
async function syncDataPlatformEnvironmentsAfterWorkspaceOpen(pushLog: (message: string) => void): Promise<void> {
  if (!window.editorApi?.syncDataPlatformEnvironments) return;

  try {
    const currentEnvironment = useEditorStore.getState().scene.sceneSettings.environment;
    const started = await window.editorApi.syncDataPlatformEnvironments({
      expectedSourceKey: currentEnvironment?.source === 'data-platform'
        ? currentEnvironment.dataPlatformSourceKey
        : undefined,
    });
    if (started) pushLog('编辑工作区已打开，正在后台同步数据中台环境模型。');
    else pushLog('编辑工作区已打开，但环境模型同步未启动；已阻止加载未重关联的旧缓存路径。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`编辑工作区已打开，但启动环境模型同步失败：${message}`);
  }
}

/** 本地场景成功加载后异步同步共享模型库；同步失败不影响已经打开的场景。 */
async function syncDataPlatformModelsAfterLocalSceneLoad(pushLog: (message: string) => void): Promise<void> {
  if (!window.editorApi?.syncDataPlatformModels) return;

  try {
    const started = await window.editorApi.syncDataPlatformModels();
    if (started) pushLog('本地场景已加载，正在同步数据中台全部模型。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`本地场景已加载，但启动数据中台模型同步失败：${message}`);
  }
}

/** 本地场景成功加载后异步同步数据中台图片库；同步失败不影响已经打开的场景。 */
async function syncDataPlatformImagesAfterLocalSceneLoad(pushLog: (message: string) => void): Promise<void> {
  if (!window.editorApi?.syncDataPlatformImages) return;

  try {
    const started = await window.editorApi.syncDataPlatformImages();
    if (started) pushLog('本地场景已加载，正在同步数据中台图片库。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`本地场景已加载，但启动数据中台图片同步失败：${message}`);
  }
}

/** 归一化导入进度，避免 UI 收到越界百分比后产生异常宽度。 */
function createCadImportProgress(
  id: string,
  percent: number,
  label: string,
  detail: string,
  fileName: string | null,
): CadImportProgress {
  return {
    id,
    active: true,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    label,
    detail,
    fileName,
  };
}

/** 给 React 一帧时间渲染阶段变化，避免大 DXF 同步解析前 UI 来不及显示进度。 */
function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

/** 读取 CAD 文件响应体，并在浏览器支持流读取时按字节数更新真实读取进度。 */
async function readCadResponseText(
  response: Response,
  fileSizeBytes: number,
  onProgress: (percent: number, detail: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  const totalBytes = fileSizeBytes > 0 ? fileSizeBytes : Number(response.headers.get('content-length') ?? 0);

  if (!reader) {
    onProgress(38, '正在读取 CAD 文件...');
    const content = await response.text();
    onProgress(68, 'CAD 文件读取完成。');
    return content;
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    receivedBytes += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));

    const readRatio = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    const percent = totalBytes > 0 ? 18 + readRatio * 50 : Math.min(68, 18 + Math.log2(receivedBytes + 1) * 3);
    const detail = totalBytes > 0
      ? `已读取 ${Math.round(readRatio * 100)}%。`
      : `已读取 ${(receivedBytes / 1024 / 1024).toFixed(1)} MB。`;
    onProgress(percent, detail);
  }

  chunks.push(decoder.decode());
  onProgress(68, 'CAD 文件读取完成。');
  return chunks.join('');
}

function cloneVector3(vector: Vector3Data): Vector3Data {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function cloneTransform(transform: TransformComponent): TransformComponent {
  return {
    position: cloneVector3(transform.position),
    rotation: cloneVector3(transform.rotation),
    scale: cloneVector3(transform.scale),
  };
}

/** 对实体 Transform 应用组件级不变量；特殊编辑标记不允许产生无效缩放或倾斜。 */
function normalizeTransformForEntity(entity: Entity, transform: TransformComponent): TransformComponent {
  const normalized = cloneTransform(transform);
  if (entity.components.skybox) normalized.scale = normalizeSkyboxSphereScale(normalized.scale);
  if (entity.components.autoPatrol) normalized.scale = { x: 1, y: 1, z: 1 };
  if (entity.components.manualRoamSpawn) {
    normalized.rotation = { x: 0, y: normalized.rotation.y, z: 0 };
    normalized.scale = { x: 1, y: 1, z: 1 };
  }
  return normalized;
}

/** 群组事务写入前逐实体收敛 Transform，确保撤销基线和目标值都遵守组件约束。 */
function normalizeGroupRotationTransforms(
  scene: SceneDocument,
  entityIds: readonly string[],
  transforms: Readonly<Record<string, TransformComponent>>,
): Record<string, TransformComponent> {
  const normalizedTransforms = { ...transforms };
  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    const transform = transforms[entityId];
    if (entity && transform) {
      normalizedTransforms[entityId] = normalizeTransformForEntity(entity, transform);
    }
  }
  return normalizedTransforms;
}

function cloneMeshRenderer(meshRenderer: MeshRendererComponent): MeshRendererComponent {
  return {
    meshKind: meshRenderer.meshKind,
    materialColor: meshRenderer.materialColor,
  };
}

function cloneLocator(locator: LocatorComponent): LocatorComponent {
  return {
    assetId: locator.assetId,
    storageDepth: locator.storageDepth,
    length: locator.length,
    width: locator.width,
    height: locator.height,
    columns: locator.columns,
    layers: locator.layers,
    startColumn: locator.startColumn,
    startLayer: locator.startLayer,
    columnReversed: locator.columnReversed,
    columnGap: locator.columnGap,
    layerGap: locator.layerGap,
    deviceAssetCode: locator.deviceAssetCode,
    rowNumber: locator.rowNumber,
    ...(locator.fetchDrive ? { fetchDrive: { ...locator.fetchDrive } } : {}),
    ...(locator.builtInBinding
      ? { builtInBinding: { hostEntityId: locator.builtInBinding.hostEntityId, originOffset: { ...locator.builtInBinding.originOffset } } }
      : {}),
  };
}

function cloneCadReference(cadReference: CadReferenceComponent): CadReferenceComponent {
  return cloneJsonValue(cadReference);
}

function cloneLight(light: LightComponent): LightComponent {
  return {
    lightKind: light.lightKind,
    intensity: light.intensity,
  };
}

function cloneModelAsset(modelAsset: ModelAssetComponent): ModelAssetComponent {
  return cloneJsonValue(modelAsset);
}

function getSelectedModelParameterValues(state: EditorState): ModelParameterValues | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  if (!modelAsset?.parameterConfig) return null;

  return cloneModelParameterValues(modelAsset.parameterValues ?? {});
}

function patchModelParameterValue(
  values: ModelParameterValues,
  key: string,
  value: ModelParameterValue,
): ModelParameterValues {
  return {
    ...cloneModelParameterValues(values),
    [key]: value,
  };
}

function sanitizeSelectedModelParameterValue(
  state: EditorState,
  key: string,
  value: ModelParameterValue,
): ModelParameterValue | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  const definition = findModelParameterDefinition(modelAsset?.parameterConfig, key);
  if (!definition) return null;

  return sanitizeModelParameterValue(definition, value);
}

function isFiniteVector3(vector: Vector3Data): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function sanitizeVector3(value: Vector3Data | undefined, fallback = { x: 0, y: 0, z: 0 }): Vector3Data {
  if (!value || !isFiniteVector3(value)) return cloneVector3(fallback);
  return cloneVector3(value);
}

function isFiniteTransform(transform: TransformComponent): boolean {
  return (
    isFiniteVector3(transform.position) &&
    isFiniteVector3(transform.rotation) &&
    isFiniteVector3(transform.scale)
  );
}

function areVector3Equal(left: Vector3Data, right: Vector3Data): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function areTransformsEqual(left: TransformComponent, right: TransformComponent): boolean {
  return (
    areVector3Equal(left.position, right.position) &&
    areVector3Equal(left.rotation, right.rotation) &&
    areVector3Equal(left.scale, right.scale)
  );
}

function sanitizePositiveNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** 清洗允许 0 的非负数值，非法值使用回退值，负数收敛到 0。 */
function sanitizeNonNegativeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function sanitizeLocatorDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(LOCATOR_MIN_DIMENSION, value);
}

function sanitizeLocatorGap(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(10, value));
}

function sanitizeLocatorAssetId(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return value.trim().slice(0, LOCATOR_ASSET_ID_MAX_LENGTH);
}

function sanitizeModelAssetCode(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const normalizedAssetCode = value.trim().slice(0, MODEL_ASSET_CODE_MAX_LENGTH);
  return normalizedAssetCode || fallback;
}

function sanitizeLocatorInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 清理定位线框 fetch 驱动 patch：undefined 保留原值，非法引用编号按空处理。 */
function sanitizeLocatorFetchDrivePatch(
  value: LocatorFetchDriveConfig | undefined,
  before: LocatorFetchDriveConfig | undefined,
): LocatorFetchDriveConfig | undefined {
  if (value === undefined) return before;
  const cargoGeneratorId = typeof value.cargoGeneratorId === 'string' ? value.cargoGeneratorId.trim().slice(0, 128) : '';
  return {
    enabled: value.enabled === true,
    ...(cargoGeneratorId ? { cargoGeneratorId } : {}),
  };
}

function areLocatorFetchDrivesEqual(left: LocatorFetchDriveConfig | undefined, right: LocatorFetchDriveConfig | undefined): boolean {
  if (!left || !right) return left === right;
  return left.enabled === right.enabled && (left.cargoGeneratorId ?? '') === (right.cargoGeneratorId ?? '');
}

/** 清理内置货格绑定 patch：undefined 保留原值；绑定身份只能由启用/停用流程改写，这里仅允许调整 originOffset。 */
function sanitizeLocatorBuiltInBindingPatch(
  value: LocatorComponent['builtInBinding'] | undefined,
  before: LocatorComponent['builtInBinding'],
): LocatorComponent['builtInBinding'] {
  if (value === undefined) return before;
  if (!before) return undefined;
  const read = (offset: number | undefined, fallback: number): number => (
    typeof offset === 'number' && Number.isFinite(offset) ? offset : fallback
  );
  return {
    hostEntityId: before.hostEntityId,
    originOffset: {
      x: read(value.originOffset?.x, before.originOffset.x),
      y: read(value.originOffset?.y, before.originOffset.y),
      z: read(value.originOffset?.z, before.originOffset.z),
    },
  };
}

function areLocatorsEqual(left: LocatorComponent, right: LocatorComponent): boolean {
  return (
    left.assetId === right.assetId &&
    left.storageDepth === right.storageDepth &&
    left.length === right.length &&
    left.width === right.width &&
    left.height === right.height &&
    left.columns === right.columns &&
    left.layers === right.layers &&
    left.startColumn === right.startColumn &&
    left.startLayer === right.startLayer &&
    left.columnReversed === right.columnReversed &&
    left.columnGap === right.columnGap &&
    left.layerGap === right.layerGap &&
    left.deviceAssetCode === right.deviceAssetCode &&
    left.rowNumber === right.rowNumber &&
    areLocatorFetchDrivesEqual(left.fetchDrive, right.fetchDrive) &&
    areLocatorBuiltInBindingsEqual(left.builtInBinding, right.builtInBinding)
  );
}

function areLocatorBuiltInBindingsEqual(
  left: LocatorComponent['builtInBinding'],
  right: LocatorComponent['builtInBinding'],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.hostEntityId === right.hostEntityId &&
    left.originOffset.x === right.originOffset.x &&
    left.originOffset.y === right.originOffset.y &&
    left.originOffset.z === right.originOffset.z
  );
}

function areCadReferencesEqual(left: CadReferenceComponent, right: CadReferenceComponent): boolean {
  return left.lineColor === right.lineColor && left.opacity === right.opacity;
}

function sanitizeEntityName(name: string): string {
  return name.trim().slice(0, ENTITY_NAME_MAX_LENGTH);
}

function sanitizeSceneName(name: string): string {
  return name.trim().slice(0, 128);
}

function isColorLike(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function sanitizeGridCellSize(value: EditorGridCellSize): EditorGridCellSize {
  return EDITOR_GRID_CELL_SIZES.includes(value) ? value : DEFAULT_EDITOR_GRID_SETTINGS.cellSizeMeters;
}

function isSceneEnvironmentEqual(
  left: SceneEnvironmentSettings | null,
  right: SceneEnvironmentSettings | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSceneSkyboxEqual(left: SceneSkyboxSettings | null, right: SceneSkyboxSettings | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type UpsertSkyboxEntityOptions = {
  placementPosition?: Vector3Data;
  revealEntity?: boolean;
  selectEntity: boolean;
};

/** 创建启用天空盒后的场景设置，并把相机距离提升到 12 km 安全下限。 */
function createSceneSettingsWithSkybox(scene: SceneDocument): SceneDocument['sceneSettings'] {
  return {
    ...scene.sceneSettings,
    camera: {
      ...scene.sceneSettings.camera,
      viewDistance: sanitizeSceneViewDistance(
        scene.sceneSettings.camera.viewDistance,
        SCENE_SKYBOX_VIEW_DISTANCE_MIN,
      ),
    },
    skybox: null,
  };
}

/** 在场景中创建或更新唯一球形天空盒实体，并清除旧 sceneSettings.skybox 镜像。 */
function upsertSkyboxEntityInScene(
  scene: SceneDocument,
  skybox: SceneSkyboxSettings,
  options: UpsertSkyboxEntityOptions,
): { scene: SceneDocument; entityId: string; created: boolean } {
  const existing = getSceneSkyboxEntity(scene);
  const placementPosition = options.placementPosition
    ? sanitizeVector3(options.placementPosition)
    : undefined;

  if (!existing) {
    const entity = createSkyboxEntity(skybox, placementPosition);
    return {
      entityId: entity.id,
      created: true,
      scene: {
        ...scene,
        entityIds: [...scene.entityIds, entity.id],
        entities: { ...scene.entities, [entity.id]: entity },
        selectedEntityId: options.selectEntity ? entity.id : scene.selectedEntityId,
        sceneSettings: createSceneSettingsWithSkybox(scene),
      },
    };
  }

  const transform = normalizeTransformForEntity(existing, existing.components.transform);
  transform.rotation.y = skybox.rotationDegrees * Math.PI / 180;
  if (placementPosition) transform.position = placementPosition;
  const updatedEntity: Entity = {
    ...existing,
    visible: options.revealEntity ? true : existing.visible,
    components: {
      ...existing.components,
      transform,
      skybox: createSkyboxComponent(skybox),
    },
  };
  return {
    entityId: existing.id,
    created: false,
    scene: {
      ...scene,
      entities: { ...scene.entities, [existing.id]: updatedEntity },
      selectedEntityId: options.selectEntity ? existing.id : scene.selectedEntityId,
      sceneSettings: createSceneSettingsWithSkybox(scene),
    },
  };
}

/** 删除场景中的球形天空盒实体，同时清除旧场景级兼容字段。 */
function removeSkyboxEntitiesFromScene(scene: SceneDocument): SceneDocument {
  const skyboxEntityIds = scene.entityIds.filter((entityId) => Boolean(scene.entities[entityId]?.components.skybox));
  const withoutEntities = skyboxEntityIds.length > 0 ? deleteEntitiesInScene(scene, skyboxEntityIds) : scene;
  if (!withoutEntities.sceneSettings.skybox) return withoutEntities;
  return {
    ...withoutEntities,
    sceneSettings: { ...withoutEntities.sceneSettings, skybox: null },
  };
}

/** 根据新导入的资产快照生成场景实例的新 modelAsset，同时保留现场资产编号。 */
function createRefreshedModelAsset(modelAsset: ModelAssetComponent, asset: AssetEntry): ModelAssetComponent {
  const parameterConfig = normalizeModelParameterConfig(asset.parameterConfig) ?? undefined;
  const unitInfo: ModelLengthUnitInfo = createModelLengthUnitInfo(asset.lengthUnit);

  return {
    assetCode: modelAsset.assetCode,
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    ...(asset.assetRevision ? { assetRevision: asset.assetRevision } : {}),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(asset.scriptAssets?.length ? { scriptAssets: cloneJsonValue(asset.scriptAssets) } : {}),
    ...(asset.parameterScriptMetadata?.length ? { parameterScriptMetadata: cloneJsonValue(asset.parameterScriptMetadata) } : {}),
    ...(asset.animationScriptMetadata?.length ? { animationScriptMetadata: cloneJsonValue(asset.animationScriptMetadata) } : {}),
    ...(asset.dataDrivenConfig ? { dataDrivenConfig: cloneJsonValue(asset.dataDrivenConfig) } : {}),
    ...(asset.builtInSlotBindingConfig ? { builtInSlotBindingConfig: cloneJsonValue(asset.builtInSlotBindingConfig) } : {}),
    ...(parameterConfig
      ? {
          parameterConfig,
          parameterValues: sanitizeModelParameterValues(parameterConfig, modelAsset.parameterValues),
        }
      : {}),
  };
}

/** 比较可序列化元数据，供字段级模型快照比较复用。 */
function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** 判断刷新前后的模型资产快照是否等价，用于避免写入空的撤销历史。 */
function areModelAssetsEqual(left: ModelAssetComponent, right: ModelAssetComponent): boolean {
  return (
    left.assetCode === right.assetCode &&
    left.sourcePath === right.sourcePath &&
    left.sourceUrl === right.sourceUrl &&
    (left.assetRevision ?? '') === (right.assetRevision ?? '') &&
    left.lengthUnit === right.lengthUnit &&
    left.unitScaleToMeters === right.unitScaleToMeters &&
    areJsonValuesEqual(left.scriptAssets, right.scriptAssets) &&
    areJsonValuesEqual(left.parameterScriptMetadata, right.parameterScriptMetadata) &&
    areJsonValuesEqual(left.animationScriptMetadata, right.animationScriptMetadata) &&
    areJsonValuesEqual(left.dataDrivenConfig, right.dataDrivenConfig) &&
    areJsonValuesEqual(left.builtInSlotBindingConfig, right.builtInSlotBindingConfig) &&
    areJsonValuesEqual(left.parameterConfig, right.parameterConfig) &&
    areModelParameterValuesEqual(left.parameterValues ?? {}, right.parameterValues ?? {})
  );
}

/** 使用本轮导入资产刷新单个生成目标；内置 Mesh 和未匹配目标保持原值。 */
function refreshModelGeneratorTargetFromImportedAssets(
  target: ModelGeneratorTarget | null,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
): { target: ModelGeneratorTarget | null; refreshedCount: number } {
  if (!target || target.kind !== 'model') return { target, refreshedCount: 0 };

  const importedAsset = findImportedAssetForModelAsset(target.modelAsset, indexes);
  if (!importedAsset) return { target, refreshedCount: 0 };

  const refreshedTarget = createModelGeneratorTargetFromAsset(importedAsset);
  if (!refreshedTarget || areJsonValuesEqual(target, refreshedTarget)) return { target, refreshedCount: 0 };
  return { target: refreshedTarget, refreshedCount: 1 };
}

/** 刷新模型生成器的默认目标和每条规则目标，生成器绑定及规则文本保持不变。 */
function refreshModelGeneratorFromImportedAssets(
  modelGenerator: ModelGeneratorComponent,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
): { modelGenerator: ModelGeneratorComponent; refreshedCount: number } {
  const defaultResult = refreshModelGeneratorTargetFromImportedAssets(modelGenerator.defaultTarget, indexes);
  let refreshedCount = defaultResult.refreshedCount;
  const rules = modelGenerator.rules.map((rule) => {
    const result = refreshModelGeneratorTargetFromImportedAssets(rule.target, indexes);
    refreshedCount += result.refreshedCount;
    return result.target === rule.target ? rule : { ...rule, target: result.target };
  });

  if (refreshedCount === 0) return { modelGenerator, refreshedCount };
  return {
    modelGenerator: {
      ...modelGenerator,
      defaultTarget: defaultResult.target,
      rules,
    },
    refreshedCount,
  };
}

/** 批量刷新场景中的普通模型实例和模型生成器目标，并返回刷新引用数量。 */
function refreshSceneModelAssetsFromImportedAssets(
  scene: SceneDocument,
  assets: AssetEntry[],
): { scene: SceneDocument; refreshedCount: number; detachedMotionInstanceCount: number } {
  const indexes = createImportedAssetIndexes(assets);
  let refreshedCount = 0;
  let detachedMotionInstanceCount = 0;
  const entities: SceneDocument['entities'] = { ...scene.entities };

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;

    let components = entity.components;
    let entityChanged = false;
    const modelAsset = entity.components.modelAsset;
    if (modelAsset) {
      const importedAsset = findImportedAssetForModelAsset(modelAsset, indexes);
      if (importedAsset) {
        const refreshedModelAsset = createRefreshedModelAsset(modelAsset, importedAsset);
        if (!areModelAssetsEqual(modelAsset, refreshedModelAsset)) {
          refreshedCount += 1;
          components = { ...components, modelAsset: refreshedModelAsset };
          entityChanged = true;
        }
      }
    }

    const modelGenerator = entity.components.modelGenerator;
    if (modelGenerator) {
      const generatorResult = refreshModelGeneratorFromImportedAssets(modelGenerator, indexes);
      if (generatorResult.refreshedCount > 0) {
        refreshedCount += generatorResult.refreshedCount;
        components = { ...components, modelGenerator: generatorResult.modelGenerator };
        entityChanged = true;
      }
    }

    if (entityChanged) entities[entityId] = { ...entity, components };
  }

  // 元数据刷新后以最终模型快照判定；实例或其源新增 motion 都必须立即退出旧合批。
  for (const entityId of scene.entityIds) {
    const entity = entities[entityId];
    const sourceEntityId = entity?.components.modelArrayInstance?.sourceEntityId;
    if (!entity || !sourceEntityId) continue;

    const sourceEntity = entities[sourceEntityId];
    if (
      !hasModelDataDrivenMotionKey(entity.components.modelAsset?.dataDrivenConfig)
      && !hasModelDataDrivenMotionKey(sourceEntity?.components.modelAsset?.dataDrivenConfig)
    ) {
      continue;
    }

    const { modelArrayInstance: _modelArrayInstance, ...components } = entity.components;
    entities[entityId] = { ...entity, components };
    detachedMotionInstanceCount += 1;
  }

  if (refreshedCount === 0 && detachedMotionInstanceCount === 0) {
    return { scene, refreshedCount, detachedMotionInstanceCount };
  }

  return {
    scene: {
      ...scene,
      entities,
    },
    refreshedCount,
    detachedMotionInstanceCount,
  };
}

function getSelectedEntity(state: EditorState) {
  const selectedId = state.scene.selectedEntityId;
  if (!selectedId) return null;
  return state.scene.entities[selectedId] ?? null;
}

/** 判断普通实体是否允许编辑，文件夹不参与 Transform 类编辑。 */
function isRuntimeEntityEditable(scene: SceneDocument, entity: Entity | null | undefined): entity is Entity {
  return Boolean(entity && !entity.isFolder && !isEntityEffectivelyLocked(scene.entities, entity));
}

/** 过滤 Hierarchy 多选 ID，避免 UI 状态引用已经不存在的实体。 */
function sanitizeHierarchySelection(scene: SceneDocument, entityIds: string[]): string[] {
  return [...new Set(entityIds)].filter((entityId) => Boolean(scene.entities[entityId]));
}

/** 群组选区临时强制世界坐标移动/旋转，恢复单选时还原进入群组前的用户工具偏好。 */
function resolveSelectionTransformMode(
  state: Pick<EditorState, 'transformTool' | 'transformSpace' | 'groupTransformModeRestore'>,
  scene: SceneDocument,
  hierarchySelectionIds: readonly string[],
): Pick<EditorState, 'transformTool' | 'transformSpace' | 'groupTransformModeRestore'> {
  if (isHierarchyGroupTransformSelection(scene, hierarchySelectionIds)) {
    return {
      transformTool: state.transformTool === 'rotate' ? 'rotate' : 'translate',
      transformSpace: 'global',
      groupTransformModeRestore: state.groupTransformModeRestore ?? {
        tool: state.transformTool,
        space: state.transformSpace,
      },
    };
  }

  const requestedTool = state.groupTransformModeRestore?.tool ?? state.transformTool;
  const requestedSpace = state.groupTransformModeRestore?.space ?? state.transformSpace;
  const selectedEntity = scene.selectedEntityId ? scene.entities[scene.selectedEntityId] : null;
  const lightKind = selectedEntity?.components.light?.lightKind;
  const transformTool = (selectedEntity?.components.autoPatrol || selectedEntity?.components.manualRoamSpawn)
    && requestedTool === 'scale'
    ? 'translate'
    : lightKind
      ? resolveLightTransformTool(lightKind, requestedTool)
      : requestedTool;
  return {
    transformTool,
    transformSpace: requestedSpace,
    groupTransformModeRestore: null,
  };
}

/** 根据当前场景生成不重名的新建文件夹名称。 */
function createNextFolderName(scene: SceneDocument): string {
  const folderNames = new Set(
    scene.entityIds
      .map((entityId) => scene.entities[entityId])
      .filter((entity) => entity?.isFolder)
      .map((entity) => entity.name),
  );

  for (let index = 1; index < 1000; index += 1) {
    const name = `新建文件夹 ${index}`;
    if (!folderNames.has(name)) return name;
  }

  return `新建文件夹 ${Date.now()}`;
}

/** 复制普通 JSON 数据，避免剪贴板和新实体共享参数化模型等嵌套引用。 */
function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 深拷贝实体组件，确保复制/粘贴后的实例可独立编辑。 */
function cloneEntityComponents(entity: Entity): Entity['components'] {
  return {
    transform: cloneTransform(entity.components.transform),
    ...(entity.components.meshRenderer ? { meshRenderer: cloneMeshRenderer(entity.components.meshRenderer) } : {}),
    ...(entity.components.skybox ? { skybox: cloneJsonValue(entity.components.skybox) } : {}),
    ...(entity.components.locator ? { locator: cloneLocator(entity.components.locator) } : {}),
    ...(entity.components.cadReference ? { cadReference: cloneCadReference(entity.components.cadReference) } : {}),
    ...(entity.components.modelAsset ? { modelAsset: cloneModelAsset(entity.components.modelAsset) } : {}),
    ...(entity.components.modelArray
      ? {
          modelArray: {
            items: entity.components.modelArray.items.map((item) => ({
              ...item,
              offset: cloneVector3(item.offset),
            })),
          },
        }
      : {}),
    ...(entity.components.modelArrayInstance
      ? { modelArrayInstance: { ...entity.components.modelArrayInstance } }
      : {}),
    ...(entity.components.modelGenerator ? { modelGenerator: cloneModelGeneratorComponent(entity.components.modelGenerator) } : {}),
    ...(entity.components.telemetryBinding ? { telemetryBinding: cloneJsonValue(entity.components.telemetryBinding) } : {}),
    ...(entity.components.poiEffect ? { poiEffect: { ...entity.components.poiEffect } } : {}),
    ...(entity.components.autoPatrol ? { autoPatrol: cloneAutoPatrolComponent(entity.components.autoPatrol) } : {}),
    ...(entity.components.manualRoamSpawn ? { manualRoamSpawn: {} } : {}),
    ...(entity.components.camera ? { camera: { ...entity.components.camera } } : {}),
    ...(entity.components.light ? { light: cloneLight(entity.components.light) } : {}),
  };
}

/** 生成不会和当前场景重名的普通复制/粘贴名称；阵列会显式覆盖为数字递增名称。 */
function createUniqueEntityName(existingNames: Set<string>, baseName: string): string {
  const trimmedBaseName = sanitizeEntityName(baseName) || '对象';
  const firstCandidate = `${trimmedBaseName} 副本`;
  if (!existingNames.has(firstCandidate)) {
    existingNames.add(firstCandidate);
    return firstCandidate;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${trimmedBaseName} 副本 ${index}`;
    if (!existingNames.has(candidate)) {
      existingNames.add(candidate);
      return candidate;
    }
  }

  const fallbackName = `${trimmedBaseName} 副本 ${Date.now()}`;
  existingNames.add(fallbackName);
  return fallbackName;
}

/** 阵列副本资产编号覆盖目标，避免混合组件实体同时改写两套业务编号。 */
type EntityAssetNumberOverride = {
  kind: 'modelAsset' | 'locator';
  value: string;
};

/** 读取实体当前资产编号目标；导入模型优先于定位线框。 */
function getEntityAssetNumberTarget(entity: Entity): EntityAssetNumberOverride | null {
  if (entity.components.modelAsset) {
    return { kind: 'modelAsset', value: entity.components.modelAsset.assetCode };
  }
  if (entity.components.locator) {
    return { kind: 'locator', value: entity.components.locator.assetId };
  }
  return null;
}

/** 判断实体是否携带阵列可管理的资产编号字段。 */
function hasEntityAssetNumber(entity: Entity): boolean {
  return getEntityAssetNumberTarget(entity) !== null;
}

/** 生成不重复的自动巡检名称：自动巡检、自动巡检 2、…。 */
function createNextAutoPatrolName(scene: SceneDocument): string {
  const existingNames = new Set(Object.values(scene.entities).map((entity) => entity.name));
  const baseName = '自动巡检';
  if (!existingNames.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

/** 返回当前仍有效的巡检节点子选区。 */
function sanitizeSelectedAutoPatrolWaypointId(
  scene: SceneDocument,
  waypointId: string | null,
): string | null {
  if (!waypointId || !scene.selectedEntityId) return null;
  const waypoints = scene.entities[scene.selectedEntityId]?.components.autoPatrol?.waypoints;
  return waypoints?.some((waypoint) => waypoint.id === waypointId) ? waypointId : null;
}

/** 生成不重复的模型生成器名称：模型生成器、模型生成器 2、… */
function createNextModelGeneratorName(scene: SceneDocument): string {
  const existingNames = new Set(Object.values(scene.entities).map((entity) => entity.name));
  const baseName = '模型生成器';
  if (!existingNames.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

/** 创建与场景实体隔离的剪贴板快照，并按当前子树归一化层级字段。 */
function cloneEntityForClipboard(entity: Entity, parentId: string | null, childrenIds: string[]): Entity {
  return {
    ...entity,
    parentId,
    childrenIds: [...childrenIds],
    components: cloneEntityComponents(entity),
  };
}

type EntityClipboardSnapshot = {
  entries: EntityClipboardEntry[];
  folderCount: number;
  entityCount: number;
};

/**
 * 把 Hierarchy 选区转换为互不重叠的完整子树快照。
 * 祖先与任意深度后代同时选中时只保留最高层根条目，空文件夹继续保留。
 */
function createEntityClipboardSnapshot(scene: SceneDocument, selectedIds: string[]): EntityClipboardSnapshot {
  const rootIds = getTopLevelHierarchyEntityIds(scene.entities, selectedIds);
  const entries: EntityClipboardEntry[] = [];
  let folderCount = 0;
  let entityCount = 0;

  for (const rootId of rootIds) {
    const subtreeIds = collectEntitySubtreeIds(scene.entities, rootId);
    const includedIds = subtreeIds.filter((entityId) => Boolean(scene.entities[entityId]));
    if (!includedIds.includes(rootId)) continue;

    const includedIdSet = new Set(includedIds);
    // 绑定到被复制子树内宿主的内置货格一并打包；粘贴时按 ID 映射重建绑定关系。
    for (const entity of Object.values(scene.entities)) {
      const hostEntityId = entity.components.locator?.builtInBinding?.hostEntityId;
      if (hostEntityId && includedIdSet.has(hostEntityId) && !includedIdSet.has(entity.id)) {
        includedIds.push(entity.id);
        includedIdSet.add(entity.id);
      }
    }
    const snapshotEntities = includedIds.flatMap((entityId) => {
      const entity = scene.entities[entityId];
      if (!entity) return [];
      const parentId = entityId === rootId || !entity.parentId || !includedIdSet.has(entity.parentId)
        ? null
        : entity.parentId;
      const childrenIds = entity.isFolder
        ? entity.childrenIds.filter((childId) => includedIdSet.has(childId))
        : [];
      return [cloneEntityForClipboard(entity, parentId, childrenIds)];
    });

    entries.push({ rootId, entities: snapshotEntities });
    folderCount += snapshotEntities.filter((entity) => entity.isFolder).length;
    entityCount += snapshotEntities.filter((entity) => !entity.isFolder).length;
  }

  return { entries, folderCount, entityCount };
}

/** 生成人类可读的文件夹/实体数量摘要，用于复制与粘贴日志。 */
function formatEntityClipboardCount(folderCount: number, entityCount: number): string {
  const parts: string[] = [];
  if (folderCount > 0) parts.push(`${folderCount} 个文件夹`);
  if (entityCount > 0) parts.push(`${entityCount} 个对象`);
  return parts.join('、') || '0 个对象';
}

type EntityDuplicateOverrides = {
  id?: string;
  name?: string;
  assetNumber?: EntityAssetNumberOverride;
};

/** 创建普通实体副本，复制所有业务组件；阵列场景可按需调整 Transform 位置。 */
function createDuplicatedRuntimeEntity(
  source: Entity,
  parentId: string | null,
  offset: Vector3Data | null,
  existingNames: Set<string>,
  overrides: EntityDuplicateOverrides = {},
): Entity {
  const id = overrides.id ?? createId('entity');
  const components = cloneEntityComponents(source);
  if (offset) {
    components.transform = {
      ...components.transform,
      position: {
        x: components.transform.position.x + offset.x,
        y: components.transform.position.y + offset.y,
        z: components.transform.position.z + offset.z,
      },
    };
  }
  if (components.modelAsset) {
    components.modelAsset = {
      ...components.modelAsset,
      assetCode:
        overrides.assetNumber?.kind === 'modelAsset'
          ? overrides.assetNumber.value
          : createModelAssetCode(extractModelAssetCodePrefix(components.modelAsset.assetCode), id),
    };
  }
  if (components.autoPatrol) {
    components.autoPatrol = { ...components.autoPatrol, autoStart: false };
  }
  if (components.locator) {
    components.locator = {
      ...components.locator,
      // 复制定位线框必须生成唯一资产编号，否则运行时按 assetId 去重会丢弃副本（设备定位失效）
      assetId:
        overrides.assetNumber?.kind === 'locator'
          ? overrides.assetNumber.value
          : createModelAssetCode(extractModelAssetCodePrefix(components.locator.assetId), id),
    };
  }

  const name = overrides.name ?? createUniqueEntityName(existingNames, source.name);
  if (overrides.name) existingNames.add(overrides.name);

  return {
    ...source,
    id,
    name,
    parentId,
    childrenIds: [],
    components,
  };
}

/**
 * 创建模型阵列的轻量 Scene Entity。
 * 只复制实例级 Transform、资产编号和关联字段；大型模型模板元数据保持只读共享，避免 1000 级阵列重复 JSON 深拷贝。
 */
function createModelArrayInstanceEntity(
  source: Entity,
  sourceEntityId: string,
  offset: Vector3Data,
  name: string,
  assetCode: string,
  existingNames: Set<string>,
): Entity {
  const modelAsset = source.components.modelAsset;
  if (!modelAsset) throw new Error('模型阵列源缺少 modelAsset。');

  const components: Entity['components'] = {
    ...source.components,
    transform: {
      ...source.components.transform,
      position: {
        x: source.components.transform.position.x + offset.x,
        y: source.components.transform.position.y + offset.y,
        z: source.components.transform.position.z + offset.z,
      },
    },
    modelAsset: { ...modelAsset, assetCode },
    modelArrayInstance: { sourceEntityId },
  };
  delete components.modelArray;
  existingNames.add(name);

  return {
    ...source,
    id: createId('entity'),
    name,
    parentId: source.parentId,
    childrenIds: [],
    components,
  };
}

type PreparedEntityClipboardPaste = {
  entities: Entity[];
  rootEntityIds: string[];
  folderCount: number;
  entityCount: number;
};

/** 为一次粘贴生成全新的子树 ID，并在两阶段处理中重建任意深度父子关系。 */
function prepareEntityClipboardPaste(
  scene: SceneDocument,
  clipboard: EntityClipboard,
  parentId: string | null,
): PreparedEntityClipboardPaste {
  const existingNames = new Set(Object.values(scene.entities).map((entity) => entity.name));
  const entities: Entity[] = [];
  const rootEntityIds: string[] = [];
  const duplicatedIdBySourceId = new Map<string, string>();
  let folderCount = 0;
  let entityCount = 0;

  for (const entry of clipboard.entries) {
    const sourceById = new Map(entry.entities.map((entity) => [entity.id, entity]));
    const copyableSources = entry.entities;
    const copyableIdSet = new Set(copyableSources.map((entity) => entity.id));
    if (!copyableIdSet.has(entry.rootId)) continue;

    for (const source of copyableSources) {
      duplicatedIdBySourceId.set(source.id, createId(source.isFolder ? 'folder' : 'entity'));
    }

    for (const source of copyableSources) {
      const duplicatedId = duplicatedIdBySourceId.get(source.id);
      if (!duplicatedId) continue;
      const duplicatedParentId = source.id === entry.rootId
        ? parentId
        : source.parentId && copyableIdSet.has(source.parentId)
          ? duplicatedIdBySourceId.get(source.parentId) ?? parentId
          : parentId;

      if (source.isFolder) {
        const folder: Entity = {
          ...source,
          id: duplicatedId,
          name: createUniqueEntityName(existingNames, source.name),
          isFolder: true,
          parentId: duplicatedParentId,
          childrenIds: source.childrenIds.flatMap((childId) => {
            if (!copyableIdSet.has(childId) || !sourceById.has(childId)) return [];
            const duplicatedChildId = duplicatedIdBySourceId.get(childId);
            return duplicatedChildId ? [duplicatedChildId] : [];
          }),
          components: cloneEntityComponents(source),
        };
        entities.push(folder);
        folderCount += 1;
      } else {
        const duplicated = createDuplicatedRuntimeEntity(
          source,
          duplicatedParentId,
          null,
          existingNames,
          { id: duplicatedId },
        );
        const binding = duplicated.components.locator?.builtInBinding;
        if (binding) {
          // 宿主同批粘贴则按 ID 映射重建绑定；宿主不在剪贴板内则解除绑定，避免悬空引用。
          const remappedHostId = duplicatedIdBySourceId.get(binding.hostEntityId);
          const locator = { ...duplicated.components.locator! };
          if (remappedHostId) locator.builtInBinding = { hostEntityId: remappedHostId, originOffset: { ...binding.originOffset } };
          else delete locator.builtInBinding;
          duplicated.components = { ...duplicated.components, locator };
        }
        entities.push(duplicated);
        entityCount += 1;
      }
    }

    const duplicatedRootId = duplicatedIdBySourceId.get(entry.rootId);
    if (duplicatedRootId) rootEntityIds.push(duplicatedRootId);
  }

  // 内置货格资产编号跟随宿主货架副本的编号（宿主粘贴时会生成新编号）
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const binding = entity.components.locator?.builtInBinding;
    if (!binding) continue;
    const host = entities.find((candidate) => candidate.id === binding.hostEntityId);
    const assetCode = host?.components.modelAsset?.assetCode;
    if (!assetCode || entity.components.locator!.assetId === assetCode) continue;
    entities[index] = {
      ...entity,
      components: {
        ...entity.components,
        locator: { ...entity.components.locator!, assetId: assetCode },
      },
    };
  }

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const sourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    const duplicatedSourceId = sourceEntityId ? duplicatedIdBySourceId.get(sourceEntityId) : null;
    if (!duplicatedSourceId) continue;
    entities[index] = {
      ...entity,
      components: {
        ...entity.components,
        modelArrayInstance: { sourceEntityId: duplicatedSourceId },
      },
    };
  }

  return { entities, rootEntityIds, folderCount, entityCount };
}

/** 返回当前 Hierarchy 主选区，兼容只有 Scene 单选但没有多选数组的情况。 */
function getActiveHierarchySelectionIds(state: EditorState): string[] {
  if (state.hierarchySelectionIds.length > 0) {
    return sanitizeHierarchySelection(state.scene, state.hierarchySelectionIds);
  }

  return state.scene.selectedEntityId && state.scene.entities[state.scene.selectedEntityId]
    ? [state.scene.selectedEntityId]
    : [];
}

/** 过滤可被当前批量命令改写的实体，继承锁定的对象会被保护。 */
function getUnlockedSelectionIds(state: EditorState, entityIds = getActiveHierarchySelectionIds(state)): string[] {
  return entityIds.filter((entityId) => {
    const entity = state.scene.entities[entityId];
    return Boolean(entity && !isEntityEffectivelyLocked(state.scene.entities, entity));
  });
}

/** 过滤批量复制、阵列和群组可处理的普通运行时实体。 */
function getSelectedRuntimeEntityIds(state: EditorState): string[] {
  return getUnlockedSelectionIds(state).filter((entityId) => {
    const entity = state.scene.entities[entityId];
    return Boolean(entity && !entity.isFolder);
  });
}

/** 按右键目标推导粘贴父文件夹：文件夹内粘贴，对象则贴到同级。 */
function resolvePasteParentId(scene: SceneDocument, targetFolderId: string | null | undefined): string | null {
  if (!targetFolderId) return null;
  const targetFolder = scene.entities[targetFolderId];
  return targetFolder?.isFolder ? targetFolder.id : null;
}

/** 从选区展开 Scene View 聚焦目标，文件夹会递归解析全部普通后代。 */
function resolveSceneFocusEntityIds(scene: SceneDocument, entityIds: string[]): string[] {
  const resolvedIds: string[] = [];

  for (const entityId of getTopLevelHierarchyEntityIds(scene.entities, entityIds)) {
    const entity = scene.entities[entityId];
    if (!entity) continue;
    if (!entity.isFolder) {
      resolvedIds.push(entityId);
      continue;
    }

    for (const descendantId of collectEntitySubtreeIds(scene.entities, entityId, false)) {
      if (scene.entities[descendantId] && !scene.entities[descendantId].isFolder) {
        resolvedIds.push(descendantId);
      }
    }
  }

  return [...new Set(resolvedIds)];
}

/** 批量设置实体显示状态，并保持场景选择引用有效。 */
function setEntitiesVisibleInScene(scene: SceneDocument, entityIds: string[], visible: boolean): SceneDocument {
  const entities = { ...scene.entities };
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.visible === visible) continue;
    entities[entityId] = { ...entity, visible };
  }

  return { ...scene, entities };
}

/** 批量设置实体锁定状态，并保持场景选择引用有效。 */
function setEntitiesLockedInScene(scene: SceneDocument, entityIds: string[], locked: boolean): SceneDocument {
  const entities = { ...scene.entities };
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.locked === locked) continue;
    entities[entityId] = { ...entity, locked };
  }

  return { ...scene, entities };
}

/**
 * 收集“显示被祖先隐藏的实体”时需要一并显示的隐藏祖先。
 * 图标展示的是继承后的有效显隐；只翻转实体自身无法让被文件夹隐藏的模型真正出现。
 */
function collectVisibilityShowTargetIds(entities: Record<string, Entity>, entityId: string): string[] {
  const targetIds = [entityId];
  const visited = new Set<string>([entityId]);
  let currentId = entities[entityId]?.parentId ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = entities[currentId];
    if (!current) break;
    if (current.visible === false) targetIds.push(currentId);
    currentId = current.parentId ?? null;
  }
  return targetIds;
}

/**
 * 收集“解锁被祖先锁定的实体”时需要一并解锁的锁定祖先。
 * 与显隐按钮一致：按钮按继承后的有效锁定状态切换，否则会把子实体自身 locked 反向翻转。
 */
function collectLockUnlockTargetIds(entities: Record<string, Entity>, entityId: string): string[] {
  const targetIds = [entityId];
  const visited = new Set<string>([entityId]);
  let currentId = entities[entityId]?.parentId ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = entities[currentId];
    if (!current) break;
    if (current.locked === true) targetIds.push(currentId);
    currentId = current.parentId ?? null;
  }
  return targetIds;
}

/** 沿被移除文件夹向上查找最近仍存在的父文件夹。 */
function resolveNearestSurvivingParentId(
  scene: SceneDocument,
  parentId: string | null,
  removedIds: ReadonlySet<string>,
): string | null {
  const visited = new Set<string>();
  let currentId = parentId;

  while (currentId && removedIds.has(currentId) && !visited.has(currentId)) {
    visited.add(currentId);
    currentId = scene.entities[currentId]?.parentId ?? null;
  }

  return currentId && scene.entities[currentId]?.isFolder ? currentId : null;
}

/** 在移除文件夹容器时按原顺序展开其内容，供删除和解组共同保持层级顺序。 */
function collectPromotedChildrenIds(
  scene: SceneDocument,
  childIds: readonly string[],
  removedIds: ReadonlySet<string>,
  targetParentId: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [...childIds].reverse();

  while (stack.length > 0) {
    const childId = stack.pop();
    if (!childId || visited.has(childId)) continue;
    const child = scene.entities[childId];
    if (!child) continue;
    visited.add(childId);

    if (removedIds.has(childId)) {
      if (child.isFolder) {
        for (let index = child.childrenIds.length - 1; index >= 0; index -= 1) {
          stack.push(child.childrenIds[index]);
        }
      }
      continue;
    }

    if (resolveNearestSurvivingParentId(scene, child.parentId, removedIds) === targetParentId) {
      result.push(childId);
    }
  }

  return result;
}

/** 为声明了内置货格绑定的宿主实体创建货格实体（幂等，调用方需先确认不存在）。货格与宿主同级，绑定身份记录在 builtInBinding.hostEntityId。 */
function createBuiltInSlotEntityInScene(
  scene: SceneDocument,
  hostEntityId: string,
  config: BuiltInSlotBindingConfig,
): SceneDocument {
  const host = scene.entities[hostEntityId];
  if (!host) return scene;

  const slotEntity = createLocatorEntity(host.components.transform.position);
  slotEntity.name = '内置货格';
  slotEntity.parentId = host.parentId;
  const derived = deriveLocatorDimensionsFromBinding(config, host.components.modelAsset?.parameterValues);
  slotEntity.components.locator = {
    ...slotEntity.components.locator!,
    ...derived,
    // 资产编号由宿主货架驱动，创建即对齐，之后随货架编号同步
    assetId: host.components.modelAsset?.assetCode ?? slotEntity.components.locator!.assetId,
    builtInBinding: { hostEntityId, originOffset: vector3() },
  };

  const hostIndex = scene.entityIds.indexOf(hostEntityId);
  const entityIds = [...scene.entityIds];
  entityIds.splice(hostIndex >= 0 ? hostIndex + 1 : entityIds.length, 0, slotEntity.id);

  const hostParent = host.parentId ? scene.entities[host.parentId] : null;
  return {
    ...scene,
    entityIds,
    entities: {
      ...scene.entities,
      ...(hostParent?.isFolder
        ? { [hostParent.id]: { ...hostParent, childrenIds: [...hostParent.childrenIds, slotEntity.id] } }
        : {}),
      [slotEntity.id]: slotEntity,
    },
  };
}

/**
 * 宿主模型参数变化后的内置货格副作用：按启用参数创建/删除货格（幂等），并按声明派生维度。
 * 仅在提交路径调用；preview 路径只应调用 patchBuiltInSlotDimensions。
 */
function applyBuiltInSlotSideEffects(scene: SceneDocument, hostEntityId: string): SceneDocument {
  const host = scene.entities[hostEntityId];
  const config = getBuiltInSlotBindingConfig(host);
  if (!host || !config) return scene;

  const enabled = host.components.modelAsset?.parameterValues?.[config.enabledParam] === true;
  const slotEntityId = findBuiltInSlotEntityId(scene, hostEntityId);

  let next = scene;
  if (enabled && !slotEntityId) {
    next = createBuiltInSlotEntityInScene(scene, hostEntityId, config);
  } else if (!enabled && slotEntityId) {
    next = deleteEntitiesInScene(scene, [slotEntityId]);
  }
  return patchBuiltInSlotDimensions(next, hostEntityId);
}

/** 批量删除实体；文件夹保持非级联语义，未删除内容提升到最近仍存在的父级。 */
function deleteEntitiesInScene(scene: SceneDocument, entityIds: string[]): SceneDocument {
  const deletingIds = new Set(entityIds.filter((entityId) => Boolean(scene.entities[entityId])));
  if (deletingIds.size === 0) return scene;

  // 内置货格是宿主模型的附属物，随宿主一并删除而非提升为孤儿实体。
  for (const entity of Object.values(scene.entities)) {
    if (deletingIds.has(entity.id)) continue;
    const hostEntityId = entity.components.locator?.builtInBinding?.hostEntityId;
    if (hostEntityId && deletingIds.has(hostEntityId)) deletingIds.add(entity.id);
  }

  // 删除阵列源时提升第一个未删除实例为新源，避免其余独立模型因悬空引用一起消失。
  const promotedSources = new Map<string, string>();
  for (const deletingId of deletingIds) {
    const deletingEntity = scene.entities[deletingId];
    if (!deletingEntity?.components.modelAsset || deletingEntity.components.modelArrayInstance) continue;
    const promoted = scene.entityIds.find((entityId) => (
      !deletingIds.has(entityId)
      && scene.entities[entityId]?.components.modelArrayInstance?.sourceEntityId === deletingId
    ));
    if (promoted) promotedSources.set(deletingId, promoted);
  }

  const entities: Record<string, Entity> = {};
  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (deletingIds.has(entityId)) continue;

    const parentId = resolveNearestSurvivingParentId(scene, entity.parentId, deletingIds);
    const childrenIds = entity.isFolder
      ? collectPromotedChildrenIds(scene, entity.childrenIds, deletingIds, entityId)
      : [];
    const promotedSourceId = entity.components.modelArrayInstance
      ? promotedSources.get(entity.components.modelArrayInstance.sourceEntityId)
      : undefined;
    let components = entity.components;
    if (promotedSources.get(entity.components.modelArrayInstance?.sourceEntityId ?? '') === entityId) {
      components = { ...entity.components };
      delete components.modelArrayInstance;
      delete components.modelArray;
    } else if (promotedSourceId) {
      components = {
        ...entity.components,
        modelArrayInstance: { sourceEntityId: promotedSourceId },
      };
    }

    const telemetryBinding = components.telemetryBinding;
    if (telemetryBinding?.cargoGeneratorId && deletingIds.has(telemetryBinding.cargoGeneratorId)) {
      components = {
        ...components,
        telemetryBinding: { ...telemetryBinding, cargoGeneratorId: undefined },
      };
    }

    const locator = components.locator;
    if (locator?.fetchDrive?.cargoGeneratorId && deletingIds.has(locator.fetchDrive.cargoGeneratorId)) {
      components = {
        ...components,
        locator: { ...locator, fetchDrive: { ...locator.fetchDrive, cargoGeneratorId: undefined } },
      };
    }

    entities[entityId] =
      parentId === entity.parentId
      && childrenIds.length === entity.childrenIds.length
      && childrenIds.every((childId, index) => childId === entity.childrenIds[index])
      && components === entity.components
        ? entity
        : { ...entity, parentId, childrenIds, components };
  }

  const selectedReplacement = scene.selectedEntityId
    ? promotedSources.get(scene.selectedEntityId) ?? null
    : null;
  const selectedEntityId =
    scene.selectedEntityId && !deletingIds.has(scene.selectedEntityId) && entities[scene.selectedEntityId]
      ? scene.selectedEntityId
      : selectedReplacement;

  const defaultCargoGeneratorId =
    scene.sceneSettings.defaultCargoGeneratorId && deletingIds.has(scene.sceneSettings.defaultCargoGeneratorId)
      ? null
      : scene.sceneSettings.defaultCargoGeneratorId;

  return {
    ...scene,
    entityIds: scene.entityIds.filter((entityId) => !deletingIds.has(entityId)),
    entities,
    selectedEntityId,
    sceneSettings: defaultCargoGeneratorId === scene.sceneSettings.defaultCargoGeneratorId
      ? scene.sceneSettings
      : { ...scene.sceneSettings, defaultCargoGeneratorId },
  };
}

/** 把新实体插入场景并更新目标文件夹的子项列表。 */
function insertDuplicatedEntitiesInScene(
  scene: SceneDocument,
  duplicatedEntities: Entity[],
  parentId: string | null,
): SceneDocument {
  const entities = { ...scene.entities };
  for (const entity of duplicatedEntities) {
    entities[entity.id] = entity;
  }

  if (parentId && entities[parentId]?.isFolder) {
    const folder = entities[parentId];
    entities[parentId] = {
      ...folder,
      childrenIds: [...folder.childrenIds, ...duplicatedEntities.map((entity) => entity.id)],
    };
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, ...duplicatedEntities.map((entity) => entity.id)],
    entities,
    selectedEntityId: duplicatedEntities[0]?.id ?? scene.selectedEntityId,
  };
}

/** 插入带完整父子关系的剪贴板副本，并把独立实体挂到已有目标文件夹。 */
function insertClipboardEntitiesInScene(
  scene: SceneDocument,
  duplicatedEntities: Entity[],
  rootEntityIds: string[],
): SceneDocument {
  const duplicatedIdSet = new Set(duplicatedEntities.map((entity) => entity.id));
  const entities: Record<string, Entity> = { ...scene.entities };
  const existingParentAdditions = new Map<string, string[]>();

  for (const entity of duplicatedEntities) {
    entities[entity.id] = entity;
    if (!entity.parentId || duplicatedIdSet.has(entity.parentId)) continue;

    const additions = existingParentAdditions.get(entity.parentId) ?? [];
    additions.push(entity.id);
    existingParentAdditions.set(entity.parentId, additions);
  }

  for (const [parentId, childIds] of existingParentAdditions.entries()) {
    const parent = entities[parentId];
    if (!parent?.isFolder) continue;
    entities[parentId] = {
      ...parent,
      childrenIds: [...parent.childrenIds, ...childIds.filter((childId) => !parent.childrenIds.includes(childId))],
    };
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, ...duplicatedEntities.map((entity) => entity.id)],
    entities,
    selectedEntityId: rootEntityIds[0] ?? scene.selectedEntityId,
  };
}

/** 返回模型矩阵实例最终引用的独立源实体，避免对已有阵列副本再次阵列时形成引用链。 */
function resolveModelArraySourceEntityId(scene: SceneDocument, source: Entity): string {
  const referencedSourceId = source.components.modelArrayInstance?.sourceEntityId;
  const referencedSource = referencedSourceId ? scene.entities[referencedSourceId] : null;
  return referencedSource?.components.modelAsset && !referencedSource.components.modelArrayInstance
    ? referencedSource.id
    : source.id;
}

/** 统计一个源模型已经拥有的独立矩阵实例，并兼容尚未迁移的旧版隐藏阵列项。 */
function countModelArrayInstances(scene: SceneDocument, sourceEntityId: string): number {
  const source = scene.entities[sourceEntityId];
  let count = source?.components.modelArray?.items.length ?? 0;
  for (const entity of Object.values(scene.entities)) {
    if (entity.components.modelArrayInstance?.sourceEntityId === sourceEntityId) count += 1;
  }
  return count;
}

type PreparedResolvedEntityArray =
  | {
      ok: true;
      sourceIds: string[];
      copyCount: number;
      spacingMeters: number;
      primarySourceId: string | null;
      duplicatedEntities: Entity[];
    }
  | { ok: false; error: string };

/** 基于已解析的轴向跨度与世界方向创建正式阵列实体，但不直接写入场景。 */
function prepareResolvedEntityArray(
  state: EditorState,
  input: ResolvedEntityArrayInput,
): PreparedResolvedEntityArray {
  const parameterError = getEntityArrayParameterError(input.copyCount, input.spacingMeters);
  if (parameterError) return { ok: false, error: parameterError };

  const direction = normalizeModelArrayDirection(input.directionVector);
  if (!direction) return { ok: false, error: '阵列方向无效。' };
  if (!Number.isFinite(input.selectionSpanMeters) || input.selectionSpanMeters < 0) {
    return { ok: false, error: '对象轴向尺寸无效。' };
  }

  const requestedSourceIds = [...new Set(input.sourceIds)];
  const sourceIds = requestedSourceIds.filter((sourceId) => {
    const source = state.scene.entities[sourceId];
    return Boolean(
      source
      && !source.isFolder
      && !source.components.modelGenerator
      && !source.components.skybox
      && !source.components.manualRoamSpawn
      && !isEntityEffectivelyLocked(state.scene.entities, source),
    );
  });
  if (sourceIds.length === 0 || sourceIds.length !== requestedSourceIds.length) {
    return { ok: false, error: '原选区已失效、被锁定或包含不支持阵列的模型生成器/天空盒/手动漫游初始位置。' };
  }

  const copyCount = input.copyCount;
  const spacingMeters = input.spacingMeters;
  const assetNumberRule = input.assetNumberRule.trim();
  const identifierError = getEntityArrayIdentifierError(
    state.scene,
    sourceIds,
    copyCount,
    assetNumberRule,
  );
  if (identifierError) return { ok: false, error: identifierError };

  const arrayStepMeters = input.selectionSpanMeters + spacingMeters;
  const maximumOffsetMeters = arrayStepMeters * copyCount;
  if (!Number.isFinite(arrayStepMeters) || !Number.isFinite(maximumOffsetMeters)) {
    return { ok: false, error: '净间距或副本数量过大。' };
  }

  const modelSourceSelectionCounts = new Map<string, number>();
  for (const sourceId of sourceIds) {
    const source = state.scene.entities[sourceId];
    if (!source?.components.modelAsset) continue;
    const modelSourceId = resolveModelArraySourceEntityId(state.scene, source);
    modelSourceSelectionCounts.set(modelSourceId, (modelSourceSelectionCounts.get(modelSourceId) ?? 0) + 1);
  }
  for (const [modelSourceId, selectedSourceCount] of modelSourceSelectionCounts) {
    const modelSource = state.scene.entities[modelSourceId];
    const nextInstanceCount = countModelArrayInstances(state.scene, modelSourceId) + copyCount * selectedSourceCount;
    if (nextInstanceCount > MODEL_ARRAY_ITEM_COUNT_MAX) {
      return {
        ok: false,
        error: `模型“${modelSource?.name ?? modelSourceId}”的阵列实例总数不能超过 ${MODEL_ARRAY_ITEM_COUNT_MAX}。`,
      };
    }
  }

  const existingNames = new Set(Object.values(state.scene.entities).map((entity) => entity.name));
  const duplicatedEntities: Entity[] = [];

  for (let copyIndex = 1; copyIndex <= copyCount; copyIndex += 1) {
    const offset = {
      x: direction.x * arrayStepMeters * copyIndex,
      y: direction.y * arrayStepMeters * copyIndex,
      z: direction.z * arrayStepMeters * copyIndex,
    };

    for (const sourceId of sourceIds) {
      const source = state.scene.entities[sourceId];
      if (!source || source.isFolder) continue;

      if (source.components.modelAsset) {
        const identity = createModelArrayIdentity(
          source.name,
          source.components.modelAsset.assetCode,
          copyIndex,
          assetNumberRule,
        );
        if (!identity.ok) return identity;

        const copyEntity = createModelArrayInstanceEntity(
          source,
          resolveModelArraySourceEntityId(state.scene, source),
          offset,
          identity.name,
          identity.assetCode,
          existingNames,
        );
        duplicatedEntities.push(copyEntity);

        // 源模型开着内置货格时副本同步生成绑定货格；副本无独立模型宿主，
        // 运行时经 modelArrayInstanceEntities 解析其渲染源布局后放置。
        const sourceSlotId = findBuiltInSlotEntityId(state.scene, sourceId);
        const sourceSlot = sourceSlotId ? state.scene.entities[sourceSlotId] : null;
        const sourceBinding = sourceSlot?.components.locator?.builtInBinding;
        if (sourceSlot && sourceBinding) {
          const slotNameResult = createEntityArrayName(sourceSlot.name, copyIndex);
          if (!slotNameResult.ok) return slotNameResult;
          const slotOverrides: EntityDuplicateOverrides = { name: slotNameResult.name };
          const slotCopy = createDuplicatedRuntimeEntity(sourceSlot, sourceSlot.parentId, offset, existingNames, slotOverrides);
          slotCopy.components = {
            ...slotCopy.components,
            locator: {
              ...slotCopy.components.locator!,
              // 内置货格资产编号跟随宿主货架副本，不按规则独立生成
              assetId: copyEntity.components.modelAsset?.assetCode ?? slotCopy.components.locator!.assetId,
              builtInBinding: { hostEntityId: copyEntity.id, originOffset: { ...sourceBinding.originOffset } },
            },
          };
          duplicatedEntities.push(slotCopy);
        }
        continue;
      }

      const overrides: EntityDuplicateOverrides = {};
      const nameResult = createEntityArrayName(source.name, copyIndex);
      if (!nameResult.ok) return nameResult;
      overrides.name = nameResult.name;

      const assetNumberTarget = getEntityAssetNumberTarget(source);
      if (assetNumberTarget) {
        const assetNumberResult = createArrayAssetNumber(
          assetNumberTarget.value,
          copyIndex,
          assetNumberRule,
        );
        if (!assetNumberResult.ok) return assetNumberResult;
        overrides.assetNumber = { kind: assetNumberTarget.kind, value: assetNumberResult.value };
      }

      duplicatedEntities.push(
        createDuplicatedRuntimeEntity(source, source.parentId, offset, existingNames, overrides),
      );
    }
  }

  const primarySourceId =
    state.scene.selectedEntityId && sourceIds.includes(state.scene.selectedEntityId)
      ? state.scene.selectedEntityId
      : sourceIds[0] ?? null;

  return {
    ok: true,
    sourceIds,
    copyCount,
    spacingMeters,
    primarySourceId,
    duplicatedEntities,
  };
}

/** 用一条命令插入全部阵列实体，并保持原始主对象选中。 */
function createResolvedEntityArrayCommand(prepared: Extract<PreparedResolvedEntityArray, { ok: true }>) {
  return updateSceneDocumentCommand('模型阵列', (scene) => {
    let nextScene = scene;
    const groupedByParent = new Map<string | null, Entity[]>();
    for (const entity of prepared.duplicatedEntities) {
      const list = groupedByParent.get(entity.parentId) ?? [];
      list.push(entity);
      groupedByParent.set(entity.parentId, list);
    }

    for (const [parentId, entities] of groupedByParent.entries()) {
      nextScene = insertDuplicatedEntitiesInScene(nextScene, entities, parentId);
    }

    return {
      ...nextScene,
      selectedEntityId: prepared.primarySourceId,
    };
  });
}

function groupEntitiesInScene(scene: SceneDocument, entityIds: string[]): SceneDocument {
  const groupingIdSet = new Set(entityIds.filter((entityId) => {
    const entity = scene.entities[entityId];
    return Boolean(entity && !entity.isFolder);
  }));
  if (groupingIdSet.size === 0) return scene;

  const firstGroupingEntity = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .find((entity) => Boolean(entity && groupingIdSet.has(entity.id)));
  const commonParentId = firstGroupingEntity
    && [...groupingIdSet].every((entityId) => scene.entities[entityId]?.parentId === firstGroupingEntity.parentId)
      ? firstGroupingEntity.parentId
      : null;
  const orderedGroupingIds = commonParentId
    ? scene.entities[commonParentId]?.childrenIds.filter((entityId) => groupingIdSet.has(entityId)) ?? []
    : scene.entityIds.filter((entityId) => groupingIdSet.has(entityId));
  if (orderedGroupingIds.length === 0) return scene;

  const folder = {
    ...createFolderEntity(`群组 ${orderedGroupingIds.length}`),
    parentId: commonParentId,
    childrenIds: orderedGroupingIds,
  };
  const entities: Record<string, Entity> = {
    ...scene.entities,
    [folder.id]: folder,
  };

  for (const entityId of orderedGroupingIds) {
    const entity = entities[entityId];
    if (entity) entities[entityId] = { ...entity, parentId: folder.id };
  }

  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (!entity.isFolder) continue;
    const firstGroupedIndex = entity.childrenIds.findIndex((childId) => groupingIdSet.has(childId));
    const childrenIds = entity.childrenIds.filter((childId) => !groupingIdSet.has(childId));
    if (entityId === commonParentId) {
      childrenIds.splice(firstGroupedIndex >= 0 ? firstGroupedIndex : childrenIds.length, 0, folder.id);
    }
    if (
      childrenIds.length !== entity.childrenIds.length
      || childrenIds.some((childId, index) => childId !== entity.childrenIds[index])
    ) {
      entities[entityId] = { ...entity, childrenIds };
    }
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, folder.id],
    entities,
    selectedEntityId: folder.id,
  };
}

/** 解组文件夹：只移除文件夹容器，直属内容按原顺序提升到原父级。 */
function ungroupFoldersInScene(scene: SceneDocument, folderIds: string[]): SceneDocument {
  const ungroupingIds = new Set(
    folderIds.filter((folderId) => scene.entities[folderId]?.isFolder),
  );
  if (ungroupingIds.size === 0) return scene;

  const entities: Record<string, Entity> = {};
  let selectedEntityId: string | null = null;

  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (ungroupingIds.has(entityId)) continue;
    const parentId = resolveNearestSurvivingParentId(scene, entity.parentId, ungroupingIds);
    const childrenIds = entity.isFolder
      ? collectPromotedChildrenIds(scene, entity.childrenIds, ungroupingIds, entityId)
      : [];
    if (selectedEntityId === null && parentId !== entity.parentId) selectedEntityId = entityId;
    entities[entityId] =
      parentId === entity.parentId
      && childrenIds.length === entity.childrenIds.length
      && childrenIds.every((childId, index) => childId === entity.childrenIds[index])
        ? entity
        : { ...entity, parentId, childrenIds };
  }

  return {
    ...scene,
    entityIds: scene.entityIds.filter((entityId) => !ungroupingIds.has(entityId)),
    entities,
    selectedEntityId,
  };
}

const initialEditorScene = createEmptySceneDocument();

export const useEditorStore = create<EditorState>((set, get) => ({
  scene: initialEditorScene,
  sceneSessionId: createId('scene_session'),
  persistedSceneContent: serializeScene(initialEditorScene),
  runtimeMode: 'edit',
  history: createCommandHistory(),
  hierarchySelectionIds: [],
  entityClipboard: null,
  entityArrayRequest: null,
  sceneFocusRequest: null,
  environmentApplyRequest: null,
  environmentRuntimeOverride: null,
  environmentStartupRelinkSessionId: null,
  environmentRuntimeSnapshot: createIdleEnvironmentRuntimeSnapshot(),
  environmentAdjustmentActive: false,
  environmentFocusRequest: null,
  projectAssetFocusRequest: null,
  revealHierarchyEntityRequest: null,
  cameraPoseSaveRequest: null,
  cameraResetRequest: null,
  selectedAutoPatrolWaypointId: null,
  autoPatrolCameraRequest: null,
  autoPatrolPlaybackRequest: null,
  autoPatrolPlaybackSnapshot: AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT,
  cameraOrientation: 'orbit',
  cameraProjection: 'perspective',
  selectedModelMeasurement: null,
  selectedGroupSpatialInfo: null,
  groupInspectorTransformRequest: null,
  cadImportProgress: null,
  logs: [{ id: 'log_boot', message: '编辑器已启动。' }],
  transformTool: 'translate',
  transformSpace: 'local',
  groupTransformModeRestore: null,
  snapSettings: DEFAULT_SNAP_SETTINGS,
  gridSettings: DEFAULT_EDITOR_GRID_SETTINGS,
  trajectoryVisible: false,
  startRuntimePreview: () => {
    const currentState = get();
    if (currentState.environmentApplyRequest || currentState.environmentRuntimeSnapshot.phase === 'loading') {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'environment-load-active',
        message: '请等待环境模型加载完成。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }
    if (currentState.environmentStartupRelinkSessionId === currentState.sceneSessionId) {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'environment-relink-active',
        message: '请等待环境模型完成当前缓存重关联，或重新选择/清除环境模型。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }
    if (currentState.cadImportProgress?.active) {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'cad-import-active',
        message: '请等待 CAD 导入完成。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }

    const readiness = validateRuntimePreviewConfig(currentState.scene.mqttConfig, {
      electronMqttAvailable: typeof window !== 'undefined' && typeof window.editorApi?.mqttConfigure === 'function',
    });
    if (!readiness.ok) {
      set((state) => ({ logs: prependLog(state.logs, `运行预览预检失败：${readiness.message}`) }));
      return readiness;
    }

    set((state) => {
      if (state.runtimeMode === 'preview') return state;
      return {
        runtimeMode: 'preview',
        environmentAdjustmentActive: false,
        cameraPoseSaveRequest: null,
        autoPatrolCameraRequest: null,
        selectedAutoPatrolWaypointId: null,
        logs: prependLog(state.logs, '已进入运行预览模式。'),
      };
    });
    return readiness;
  },
  stopRuntimePreview: () => {
    set((state) => {
      if (state.runtimeMode === 'edit') return state;
      return {
        runtimeMode: 'edit',
        logs: prependLog(state.logs, '已停止运行预览模式。'),
      };
    });
  },
  setTransformTool: (tool) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换变换工具');
      if (isHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds)) {
        const resolvedTool = tool === 'rotate' ? 'rotate' : 'translate';
        if (tool === 'scale') {
          return {
            transformTool: resolvedTool,
            transformSpace: 'global',
            logs: prependLog(state.logs, '选区群组不支持缩放，已切回世界坐标移动工具。'),
          };
        }
        if (state.transformTool === resolvedTool && state.transformSpace === 'global') return state;
        return {
          transformTool: resolvedTool,
          transformSpace: 'global',
          logs: prependLog(state.logs, `切换群组工具：${resolvedTool}`),
        };
      }

      const selectedEntity = getSelectedEntity(state);
      const selectedLightKind = selectedEntity?.components.light?.lightKind;
      const patrolScaleUnsupported = Boolean(selectedEntity?.components.autoPatrol && tool === 'scale');
      const resolvedTool = patrolScaleUnsupported
        ? 'translate'
        : selectedLightKind
          ? resolveLightTransformTool(selectedLightKind, tool)
          : tool;
      if ((selectedLightKind || patrolScaleUnsupported) && resolvedTool !== tool) {
        return {
          transformTool: resolvedTool,
          logs: prependLog(
            state.logs,
            patrolScaleUnsupported
              ? '自动巡检不支持缩放，已切回移动工具。'
              : `${selectedLightKind} 灯光不支持 ${tool}，已切回移动工具。`,
          ),
        };
      }
      if (state.transformTool === resolvedTool) return state;

      return {
        transformTool: resolvedTool,
        logs: prependLog(state.logs, `切换工具：${resolvedTool}`),
      };
    });
  },
  setTransformSpace: (space) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换坐标空间');
      if (isHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds) && space !== 'global') {
        return {
          transformTool: state.transformTool === 'scale' ? 'translate' : state.transformTool,
          transformSpace: 'global',
          logs: prependLog(state.logs, '选区群组移动和旋转仅支持世界坐标，已忽略局部坐标切换。'),
        };
      }
      if (state.transformSpace === space) return state;

      return {
        transformSpace: space,
        logs: prependLog(state.logs, `切换坐标空间：${space}`),
      };
    });
  },
  setSnapEnabled: (enabled) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换吸附');
      if (state.snapSettings.enabled === enabled) return state;

      return {
        snapSettings: {
          ...state.snapSettings,
          enabled,
        },
        logs: prependLog(state.logs, enabled ? '开启 Gizmo 吸附。' : '关闭 Gizmo 吸附。'),
      };
    });
  },
  updateSnapSetting: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改吸附参数');
      const nextValue = sanitizePositiveNumber(value, DEFAULT_SNAP_SETTINGS[key]);
      if (state.snapSettings[key] === nextValue) return state;

      return {
        snapSettings: {
          ...state.snapSettings,
          [key]: nextValue,
        },
      };
    });
  },
  setGridVisible: (visible) => {
    set((state) => {
      if (state.gridSettings.visible === visible) return state;

      return {
        gridSettings: {
          ...state.gridSettings,
          visible,
        },
        logs: prependLog(state.logs, visible ? '显示地面网格。' : '隐藏地面网格。'),
      };
    });
  },
  setGridCellSize: (cellSizeMeters) => {
    set((state) => {
      const nextCellSizeMeters = sanitizeGridCellSize(cellSizeMeters);
      if (state.gridSettings.cellSizeMeters === nextCellSizeMeters) return state;

      return {
        gridSettings: {
          ...state.gridSettings,
          cellSizeMeters: nextCellSizeMeters,
        },
        logs: prependLog(state.logs, `网格格子大小：${nextCellSizeMeters} m。`),
      };
    });
  },
  setTrajectoryVisible: (visible) => {
    set((state) => {
      if (state.trajectoryVisible === visible) return state;
      return {
        trajectoryVisible: visible,
        logs: prependLog(state.logs, visible ? '显示输送线货物轨迹。' : '隐藏输送线货物轨迹。'),
      };
    });
  },
  renameScene: (name) => {
    const nextName = sanitizeSceneName(name);
    if (!nextName) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名场景');
      if (state.scene.name === nextName) return state;

      const command = updateSceneDocumentCommand('重命名场景', (scene) => ({
        ...scene,
        name: nextName,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${nextName}`),
      };
    });
  },
  resetSceneToBlank: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '清空场景');
      return createLoadedSceneState(state, createEmptySceneDocument(), '场景已初始化。');
    });
  },
  setCameraViewDistance: (viewDistance) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改相机距离');
      const minimum = getSceneSkyboxSettings(state.scene)
        ? SCENE_SKYBOX_VIEW_DISTANCE_MIN
        : undefined;
      const nextViewDistance = sanitizeSceneViewDistance(viewDistance, minimum);
      if (state.scene.sceneSettings.camera.viewDistance === nextViewDistance) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            camera: {
              ...state.scene.sceneSettings.camera,
              viewDistance: nextViewDistance,
            },
          },
        },
      };
    });
  },
  updateSensitivitySetting: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改相机灵敏度');
      const nextValue = sanitizeSceneSensitivityValue(value);
      if (state.scene.sceneSettings.sensitivity[key] === nextValue) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            sensitivity: {
              ...state.scene.sceneSettings.sensitivity,
              [key]: nextValue,
            },
          },
        },
      };
    });
  },
  updateShadowSettings: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改场景阴影');
      const before = state.scene.sceneSettings.shadows;
      const next = sanitizeSceneShadowSettings({ ...before, ...patch });
      if (isSceneShadowSettingsEqual(before, next)) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            shadows: next,
          },
        },
      };
    });
  },
  updateEnvironmentConfig: (environment) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改环境模型');
      const before = state.scene.sceneSettings.environment;
      const nextEnvironment = sanitizeSceneEnvironment(environment);
      if (isSceneEnvironmentEqual(before, nextEnvironment)) return state;

      const historyBefore = resolveEnvironmentRuntimeSettings(
        before,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      const command = updateSceneEnvironmentCommand('更新环境模型', historyBefore, nextEnvironment);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        environmentApplyRequest: null,
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        environmentAdjustmentActive: false,
        environmentRuntimeSnapshot: nextEnvironment
          ? state.environmentRuntimeSnapshot
          : createIdleEnvironmentRuntimeSnapshot(),
        logs: prependLog(state.logs, nextEnvironment ? '环境模型已更新。' : '环境模型已清除。'),
      };
    });
  },
  setDefaultCargoGenerator: (generatorId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改默认模型生成器');
      const before = state.scene.sceneSettings.defaultCargoGeneratorId;
      const after = generatorId?.trim() || null;
      if (before === after) return state;

      const command = updateSceneDefaultCargoGeneratorCommand(before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, after ? '默认模型生成器已更新。' : '默认模型生成器已清除。'),
      };
    });
  },
  requestEnvironmentApply: (environment, options = {}) => {
    let requestId: string | null = null;
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '加载环境模型');
      if (options.expectedSceneSessionId && options.expectedSceneSessionId !== state.sceneSessionId) return state;
      if (
        options.expectedEnvironmentState
        && (
          !isSceneEnvironmentEqual(
            state.scene.sceneSettings.environment,
            options.expectedEnvironmentState.environment,
          )
          || (state.environmentApplyRequest?.id ?? null) !== options.expectedEnvironmentState.applyRequestId
        )
      ) return state;
      const normalized = sanitizeSceneEnvironment(environment);
      if (!normalized) {
        return { logs: prependLog(state.logs, '环境模型配置无效，未开始加载。') };
      }

      const explicitRuntimeEnvironment = options.runtimeEnvironment
        ? sanitizeSceneEnvironment(options.runtimeEnvironment)
        : null;
      if (options.runtimeEnvironment && !explicitRuntimeEnvironment) {
        return { logs: prependLog(state.logs, '环境模型当前缓存配置无效，未开始加载。') };
      }
      if (
        state.environmentStartupRelinkSessionId === state.sceneSessionId
        && hasManagedEnvironmentCacheReference(normalized)
        && !explicitRuntimeEnvironment
      ) {
        return {
          logs: prependLog(state.logs, '环境模型正在重关联当前缓存，已阻止加载旧机器路径。'),
        };
      }

      const resolvedRuntimeEnvironment = explicitRuntimeEnvironment
        ? explicitRuntimeEnvironment
        : resolveEnvironmentRuntimeSettings(normalized, state.environmentRuntimeOverride);
      const runtimeEnvironment = explicitRuntimeEnvironment
        ? explicitRuntimeEnvironment
        : resolvedRuntimeEnvironment && !isSceneEnvironmentEqual(normalized, resolvedRuntimeEnvironment)
          ? resolvedRuntimeEnvironment
          : undefined;

      requestId = createId('environment-load');
      const request: EnvironmentApplyRequest = {
        id: requestId,
        environment: normalized,
        autoAlign: options.autoAlign === true,
        focusAfterLoad: options.focusAfterLoad === true,
        commandLabel: options.commandLabel?.trim() || '更新环境模型',
        successMessage: options.successMessage?.trim() || '环境模型已更新。',
        persistSceneChange: options.persistSceneChange !== false,
        runtimeEnvironment,
      };
      return {
        environmentApplyRequest: request,
        environmentAdjustmentActive: false,
        environmentRuntimeSnapshot: {
          ...state.environmentRuntimeSnapshot,
          phase: 'loading',
          requestId,
          sourceUrl: runtimeEnvironment?.activeVariantUrl ?? normalized.activeVariantUrl,
          message: '环境模型正在加载...',
        },
      };
    });
    return requestId;
  },
  completeEnvironmentApply: (requestId, applyResult) => {
    set((state) => {
      const request = state.environmentApplyRequest;
      if (!request || request.id !== requestId) return state;
      const nextEnvironment = sanitizeSceneEnvironment(applyResult.environment);
      if (!nextEnvironment) {
        return {
          environmentApplyRequest: null,
          environmentRuntimeSnapshot: {
            ...applyResult.snapshot,
            phase: 'error',
            message: '环境模型加载完成，但返回配置无效。',
          },
          logs: prependLog(state.logs, '环境模型加载失败：运行时返回配置无效。'),
        };
      }

      const before = state.scene.sceneSettings.environment;
      const historyBefore = request.persistSceneChange
        ? resolveEnvironmentRuntimeSettings(
          before,
          state.environmentRuntimeOverride,
          { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
        )
        : before;
      const command = updateSceneEnvironmentCommand(request.commandLabel, historyBefore, nextEnvironment);
      const result = !request.persistSceneChange || isSceneEnvironmentEqual(before, nextEnvironment)
        ? { scene: state.scene, history: state.history }
        : executeCommand(state.scene, state.history, command);
      return {
        ...result,
        environmentApplyRequest: null,
        environmentRuntimeOverride: request.persistSceneChange ? null : nextEnvironment,
        environmentStartupRelinkSessionId: null,
        environmentRuntimeSnapshot: applyResult.snapshot,
        environmentAdjustmentActive: false,
        environmentFocusRequest: request.focusAfterLoad ? { id: createId('environment-focus') } : state.environmentFocusRequest,
        logs: prependLog(state.logs, request.successMessage),
      };
    });
  },
  failEnvironmentApply: (requestId, message) => {
    set((state) => {
      if (state.environmentApplyRequest?.id !== requestId) return state;
      return {
        environmentApplyRequest: null,
        environmentRuntimeSnapshot: {
          ...state.environmentRuntimeSnapshot,
          phase: 'error',
          requestId,
          message,
        },
        logs: prependLog(state.logs, `环境模型加载失败：${message}`),
      };
    });
  },
  setEnvironmentRuntimeSnapshot: (snapshot) => {
    set((state) => {
      if (JSON.stringify(state.environmentRuntimeSnapshot) === JSON.stringify(snapshot)) return state;
      return { environmentRuntimeSnapshot: snapshot };
    });
  },
  updateEnvironmentDisplay: (patch, label) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const before = resolveEnvironmentRuntimeSettings(
        state.scene.sceneSettings.environment,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      if (!before) return state;
      const after = sanitizeSceneEnvironment({ ...before, ...patch });
      if (!after || isSceneEnvironmentEqual(before, after)) return state;

      const command = updateSceneEnvironmentCommand(label, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        environmentAdjustmentActive: after.visible && after.opacity > 0 ? state.environmentAdjustmentActive : false,
        logs: prependLog(state.logs, label),
      };
    });
  },
  previewEnvironmentTransform: (transform) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览环境变换');
      const environment = resolveEnvironmentRuntimeSettings(
        state.scene.sceneSettings.environment,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      if (!environment || environment.placementMode !== 'scene-base') return state;
      const nextEnvironment = sanitizeSceneEnvironment({ ...environment, transform });
      if (!nextEnvironment || isSceneEnvironmentEqual(environment, nextEnvironment)) return state;
      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            environment: nextEnvironment,
          },
        },
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
      };
    });
  },
  commitEnvironmentTransform: (beforeTransform, afterTransform) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交环境变换');
      const current = resolveEnvironmentRuntimeSettings(
        state.scene.sceneSettings.environment,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      if (!current || current.placementMode !== 'scene-base') return state;
      const before = sanitizeSceneEnvironment({ ...current, transform: beforeTransform });
      const after = sanitizeSceneEnvironment({ ...current, transform: afterTransform });
      if (!before || !after || isSceneEnvironmentEqual(before, after)) return state;

      const command = updateSceneEnvironmentCommand('调整环境模型', before, after);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        logs: prependLog(state.logs, '环境模型 Transform 已更新。'),
      };
    });
  },
  setEnvironmentAdjustmentActive: (active) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return active
        ? guardRuntimePreviewMutation(state, '调整环境模型')
        : { environmentAdjustmentActive: false };
      const environment = state.scene.sceneSettings.environment;
      const nextActive = Boolean(
        active
        && environment?.placementMode === 'scene-base'
        && environment.visible
        && environment.opacity > 0,
      );
      if (state.environmentAdjustmentActive === nextActive) return state;
      return { environmentAdjustmentActive: nextActive };
    });
  },
  requestEnvironmentFocus: () => {
    set((state) => state.scene.sceneSettings.environment
      ? { environmentFocusRequest: { id: createId('environment-focus') } }
      : state);
  },
  consumeEnvironmentFocusRequest: (requestId) => {
    set((state) => state.environmentFocusRequest?.id === requestId
      ? { environmentFocusRequest: null }
      : state);
  },
  convertLegacyEnvironmentToSceneBase: () => {
    const state = get();
    const environment = state.scene.sceneSettings.environment;
    if (!environment || environment.placementMode !== 'legacy-left') return;
    get().requestEnvironmentApply(
      {
        ...environment,
        placementMode: 'scene-base',
        transform: createDefaultSceneEnvironmentTransform(),
      },
      {
        autoAlign: true,
        focusAfterLoad: true,
        commandLabel: '转换环境为场景底座',
        successMessage: '旧版环境已转换为场景底座。',
      },
    );
  },
  updateSkyboxConfig: (skybox) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改天空盒');
      const nextSkybox = sanitizeSceneSkybox(skybox);
      const currentSkybox = getSceneSkyboxSettings(state.scene);
      if (isSceneSkyboxEqual(currentSkybox, nextSkybox)) return state;

      const command = updateSceneDocumentCommand('更新天空盒', (scene) => (
        nextSkybox
          ? upsertSkyboxEntityInScene(scene, nextSkybox, { selectEntity: false }).scene
          : removeSkyboxEntitiesFromScene(scene)
      ));
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds);
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, nextSkybox ? '天空盒球体已更新。' : '天空盒球体已清除。'),
      };
    });
  },
  placeSkybox: (skybox, placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '放置天空盒');
      const nextSkybox = sanitizeSceneSkybox(skybox);
      if (!nextSkybox) return state;
      let targetEntityId: string | null = null;
      let created = false;
      const command = updateSceneDocumentCommand('放置天空盒球体', (scene) => {
        const result = upsertSkyboxEntityInScene(scene, nextSkybox, {
          placementPosition,
          revealEntity: true,
          selectEntity: true,
        });
        targetEntityId = result.entityId;
        created = result.created;
        return result.scene;
      });
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = targetEntityId ? [targetEntityId] : state.hierarchySelectionIds;
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, created ? '天空盒球体已创建。' : '天空盒球体已更新并选中。'),
      };
    });
  },
  updateSelectedSkybox: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改天空盒');
      const entity = getSelectedEntity(state);
      const current = entity?.components.skybox;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;
      const currentSettings = getSceneSkyboxSettings(state.scene);
      if (!currentSettings) return state;
      const nextSettings = sanitizeSceneSkybox({ ...currentSettings, ...patch });
      if (!nextSettings) return state;
      const nextComponent = createSkyboxComponent(nextSettings);
      if (areJsonValuesEqual(current, nextComponent)) return state;

      const command = updateSceneDocumentCommand('更新天空盒参数', (scene) => ({
        ...scene,
        entities: {
          ...scene.entities,
          [entity.id]: {
            ...scene.entities[entity.id],
            components: { ...scene.entities[entity.id].components, skybox: nextComponent },
          },
        },
        sceneSettings: { ...scene.sceneSettings, skybox: null },
      }));
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, `${command.label}: ${entity.name}`) };
    });
  },
  setEnvironmentActiveVariant: (sourceUrl) => {
    const state = get();
    if (isRuntimePreviewState(state)) {
      set((current) => guardRuntimePreviewMutation(current, '切换环境效果'));
      return;
    }
    const environment = state.scene.sceneSettings.environment;
    if (!environment || environment.activeVariantUrl === sourceUrl) return;
    const activeVariant = environment.variants.find((variant) => variant.sourceUrl === sourceUrl);
    if (!activeVariant) return;

    get().requestEnvironmentApply(
      { ...environment, activeVariantUrl: activeVariant.sourceUrl },
      {
        autoAlign: false,
        focusAfterLoad: false,
        commandLabel: '切换环境效果',
        successMessage: `切换环境效果：${activeVariant.name}`,
      },
    );
  },
  requestCameraPoseSave: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存当前视角');
      return {
        cameraPoseSaveRequest: {
          id: createId('camera_pose_save'),
          orientation: state.cameraOrientation,
          projection: state.cameraProjection,
        },
        logs: prependLog(state.logs, '准备保存当前视角。'),
      };
    });
  },
  consumeCameraPoseSaveRequest: (requestId, pose) => {
    set((state) => {
      const request = state.cameraPoseSaveRequest;
      if (request?.id !== requestId) return state;
      if (isRuntimePreviewState(state)) {
        return {
          cameraPoseSaveRequest: null,
          logs: prependLog(state.logs, '运行预览只读：已取消待保存的相机位姿。'),
        };
      }

      return {
        cameraPoseSaveRequest: null,
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            camera: {
              ...state.scene.sceneSettings.camera,
              savedPose: pose,
              savedOrientation: request.orientation,
              savedProjection: request.projection,
            },
          },
        },
        logs: prependLog(state.logs, '当前视角已保存。'),
      };
    });
  },
  requestCameraReset: () => {
    set((state) => ({
      cameraResetRequest: { id: createId('camera_reset') },
      cameraOrientation: state.scene.sceneSettings.camera.savedOrientation,
      cameraProjection: state.scene.sceneSettings.camera.savedProjection,
      logs: prependLog(state.logs, '准备复位视角。'),
    }));
  },
  consumeCameraResetRequest: (requestId) => {
    set((state) => {
      if (state.cameraResetRequest?.id !== requestId) return state;

      return {
        cameraResetRequest: null,
        logs: prependLog(state.logs, '视角已复位。'),
      };
    });
  },
  selectAutoPatrolWaypoint: (waypointId) => {
    set((state) => {
      const selectedEntity = getSelectedEntity(state);
      const autoPatrol = selectedEntity?.components.autoPatrol;
      const selectedAutoPatrolWaypointId = autoPatrol?.waypoints.some((waypoint) => waypoint.id === waypointId)
        ? waypointId
        : null;
      if (state.selectedAutoPatrolWaypointId === selectedAutoPatrolWaypointId) return state;
      return {
        selectedAutoPatrolWaypointId,
        transformTool: selectedAutoPatrolWaypointId && state.transformTool === 'scale' ? 'translate' : state.transformTool,
      };
    });
  },
  requestAutoPatrolCapture: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '录制巡检点位');
      if (state.autoPatrolPlaybackSnapshot.phase !== 'idle' && state.autoPatrolPlaybackSnapshot.phase !== 'completed') {
        return { logs: prependLog(state.logs, '巡检运行中不能录制点位，请先停止巡检。') };
      }
      const entity = getSelectedEntity(state);
      const autoPatrol = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !autoPatrol) return state;
      const waypointId = sanitizeSelectedAutoPatrolWaypointId(state.scene, state.selectedAutoPatrolWaypointId);
      if (!waypointId && autoPatrol.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS) {
        return { logs: prependLog(state.logs, `单条巡检路线最多支持 ${AUTO_PATROL_MAX_WAYPOINTS} 个节点。`) };
      }
      return {
        autoPatrolCameraRequest: {
          id: createId('patrol_camera'),
          kind: 'capture',
          entityId: entity.id,
          waypointId,
        },
      };
    });
  },
  requestAutoPatrolFocus: (waypointId) => {
    set((state) => {
      const entity = getSelectedEntity(state);
      const autoPatrol = entity?.components.autoPatrol;
      if (!entity || !autoPatrol?.waypoints.some((waypoint) => waypoint.id === waypointId)) return state;
      return {
        selectedAutoPatrolWaypointId: waypointId,
        autoPatrolCameraRequest: { id: createId('patrol_camera'), kind: 'focus', entityId: entity.id, waypointId },
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
      };
    });
  },
  consumeAutoPatrolCameraRequest: (requestId, pose) => {
    set((state) => {
      const request = state.autoPatrolCameraRequest;
      if (!request || request.id !== requestId) return state;
      if (request.kind === 'focus') return { autoPatrolCameraRequest: null };
      if (!pose) {
        return {
          autoPatrolCameraRequest: null,
          logs: prependLog(state.logs, 'Scene View 尚未就绪，无法录制巡检视角。'),
        };
      }
      const entity = state.scene.entities[request.entityId];
      const current = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) {
        return { autoPatrolCameraRequest: null, selectedAutoPatrolWaypointId: null };
      }

      const before = cloneAutoPatrolComponent(current);
      const captured = createAutoPatrolWaypointFromWorldPose(
        pose,
        entity.components.transform,
        request.waypointId ?? undefined,
      );
      let selectedWaypointId = captured.id;
      let waypoints: AutoPatrolWaypoint[];
      const existingIndex = request.waypointId
        ? current.waypoints.findIndex((waypoint) => waypoint.id === request.waypointId)
        : -1;
      if (existingIndex >= 0) {
        const existing = current.waypoints[existingIndex];
        const replacement: AutoPatrolWaypoint = {
          ...captured,
          id: existing.id,
          travelDurationSeconds: existing.travelDurationSeconds,
          dwellSeconds: existing.dwellSeconds,
          arrivalActions: [],
        };
        waypoints = current.waypoints.map((waypoint, index) => index === existingIndex ? replacement : waypoint);
        selectedWaypointId = existing.id;
      } else {
        if (current.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS) {
          return {
            autoPatrolCameraRequest: null,
            logs: prependLog(state.logs, `单条巡检路线最多支持 ${AUTO_PATROL_MAX_WAYPOINTS} 个节点。`),
          };
        }
        waypoints = [...current.waypoints, captured];
      }
      const after = sanitizeAutoPatrolComponent({ ...current, waypoints });
      if (!after) return { autoPatrolCameraRequest: null };
      const label = existingIndex >= 0 ? '覆盖巡检点位视角' : '添加巡检点位';
      const command = updateAutoPatrolCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        autoPatrolCameraRequest: null,
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        selectedAutoPatrolWaypointId: selectedWaypointId,
        logs: prependLog(state.logs, `${label}：节点 ${after.waypoints.findIndex((waypoint) => waypoint.id === selectedWaypointId) + 1}`),
      };
    });
  },
  requestAutoPatrolPlayback: (action, routeId) => {
    set((state) => {
      let resolvedRouteId = routeId ?? null;
      if (action === 'start' && !resolvedRouteId) {
        const selected = getSelectedEntity(state);
        resolvedRouteId = selected?.components.autoPatrol ? selected.id : null;
      }
      if (action === 'start') {
        const component = resolvedRouteId ? state.scene.entities[resolvedRouteId]?.components.autoPatrol : null;
        if (!component?.enabled) return { logs: prependLog(state.logs, '巡检路线未启用，无法开始。') };
        if (component.waypoints.length < 2) return { logs: prependLog(state.logs, '巡检路线至少需要两个节点。') };
      }
      return {
        autoPatrolPlaybackRequest: {
          id: createId('patrol_playback'),
          action,
          routeId: resolvedRouteId,
        },
      };
    });
  },
  consumeAutoPatrolPlaybackRequest: (requestId) => {
    set((state) => state.autoPatrolPlaybackRequest?.id === requestId
      ? { autoPatrolPlaybackRequest: null }
      : state);
  },
  setAutoPatrolPlaybackSnapshot: (snapshot) => {
    set((state) => areJsonValuesEqual(state.autoPatrolPlaybackSnapshot, snapshot)
      ? state
      : { autoPatrolPlaybackSnapshot: snapshot });
  },
  /** 切换编辑器视口朝向；只有显式“保存当前视角”才会把当前值写入场景文档。 */
  setCameraOrientation: (orientation) => {
    set((state) => {
      if (state.cameraOrientation === orientation) return state;
      const message = orientation === 'orbit'
        ? '已退出标准视角硬锁。'
        : `已进入${STANDARD_CAMERA_VIEW_LABELS[orientation].chinese}硬锁。`;
      return { cameraOrientation: orientation, logs: prependLog(state.logs, message) };
    });
  },
  /** 点击标准面时原子切换硬锁并强制正交；再次点击当前面只退出硬锁，保留投影。 */
  toggleCameraStandardView: (orientation) => {
    set((state) => {
      const label = STANDARD_CAMERA_VIEW_LABELS[orientation].chinese;
      if (state.cameraOrientation === orientation) {
        return {
          cameraOrientation: 'orbit',
          logs: prependLog(state.logs, `已退出${label}硬锁。`),
        };
      }
      return {
        cameraOrientation: orientation,
        cameraProjection: 'orthographic',
        logs: prependLog(state.logs, `已进入${label}硬锁并切换为正交投影。`),
      };
    });
  },
  /** 切换编辑器视口投影；普通切换只影响会话，显式保存视角后才持久化。 */
  setCameraProjection: (projection) => {
    set((state) => {
      if (state.cameraProjection === projection) return state;
      return {
        cameraProjection: projection,
        logs: prependLog(state.logs, projection === 'orthographic' ? '已切换为正交投影。' : '已切换为透视投影。'),
      };
    });
  },
  setSelectedModelMeasurement: (measurement) => {
    set((state) => {
      if (measurement && state.scene.selectedEntityId !== measurement.entityId) return state;
      if (areSelectedModelMeasurementsEqual(state.selectedModelMeasurement, measurement)) return state;
      return { selectedModelMeasurement: measurement };
    });
  },
  setSelectedGroupSpatialInfo: (info) => {
    set((state) => {
      if (areSelectedGroupSpatialInfosEqual(state.selectedGroupSpatialInfo, info)) return state;
      return { selectedGroupSpatialInfo: info };
    });
  },
  requestSelectedGroupTransform: (field, axis, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改群组空间信息');
      if (!Number.isFinite(value)) return state;

      const selection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
      if (selection.status !== 'ready') {
        const message = selection.status === 'blocked'
          ? '群组空间信息修改已阻止：选区内包含锁定对象。'
          : selection.status === 'empty'
            ? '群组空间信息修改已取消：群组内没有可变换对象。'
            : '群组空间信息修改已取消：当前不再是群组选区。';
        return { logs: prependLog(state.logs, message) };
      }
      if (
        field === 'rotation'
        && axis !== 'y'
        && containsManualRoamSpawnEntity(state.scene, selection.entityIds)
      ) {
        return {
          groupInspectorTransformRequest: null,
          logs: prependLog(state.logs, '含手动漫游初始位置的群组仅允许绕 Y 轴旋转。'),
        };
      }

      return {
        groupInspectorTransformRequest: {
          id: createId('group_inspector_transform'),
          groupId: selection.groupId,
          field,
          axis,
          value,
        },
      };
    });
  },
  consumeGroupInspectorTransformRequest: (requestId) => {
    set((state) => state.groupInspectorTransformRequest?.id === requestId
      ? { groupInspectorTransformRequest: null }
      : state);
  },
  createMesh: (meshKind, placementPosition) => {
    const entity = createMeshEntity(meshKind, sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建网格');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createLocator: (placementPosition) => {
    const entity = createLocatorEntity(sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建定位器');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createLight: (lightKind, placementPosition) => {
    const entity = createLightEntity(lightKind, placementPosition ? sanitizeVector3(placementPosition) : undefined);
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建灯光');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createAutoPatrol: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建自动巡检');
      const baseEntity = createAutoPatrolEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextAutoPatrolName(state.scene) };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  /** 手动漫游初始位置全场唯一；重复放置只移动并选中已有实体。 */
  createManualRoamSpawn: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '设置手动漫游初始位置');

      const existing = findManualRoamSpawnEntity(state.scene);
      if (existing) {
        const hierarchySelectionIds = [existing.id];
        const selectedScene = { ...state.scene, selectedEntityId: existing.id };
        if (!placementPosition) {
          return {
            scene: selectedScene,
            hierarchySelectionIds,
            ...resolveSelectionTransformMode(state, selectedScene, hierarchySelectionIds),
          };
        }
        if (isEntityEffectivelyLocked(state.scene.entities, existing)) {
          return {
            scene: selectedScene,
            hierarchySelectionIds,
            logs: prependLog(state.logs, '手动漫游初始位置已锁定，无法移动。'),
            ...resolveSelectionTransformMode(state, selectedScene, hierarchySelectionIds),
          };
        }

        const before = cloneTransform(existing.components.transform);
        const after = normalizeTransformForEntity(existing, {
          ...before,
          position: sanitizeVector3(placementPosition),
        });
        if (areTransformsEqual(before, after)) {
          return {
            scene: selectedScene,
            hierarchySelectionIds,
            ...resolveSelectionTransformMode(state, selectedScene, hierarchySelectionIds),
          };
        }

        const command = updateTransformCommand(existing.id, before, after);
        const result = executeCommand(state.scene, state.history, command);
        const movedScene = { ...result.scene, selectedEntityId: existing.id };
        return {
          ...result,
          scene: movedScene,
          hierarchySelectionIds,
          ...resolveSelectionTransformMode(state, movedScene, hierarchySelectionIds),
          logs: prependLog(state.logs, '移动手动漫游初始位置'),
        };
      }

      const entity = createManualRoamSpawnEntity(sanitizeVector3(placementPosition));
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, '创建手动漫游初始位置'),
      };
    });
  },
  createModelGenerator: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建模型生成器');

      const baseEntity = createModelGeneratorEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextModelGeneratorName(state.scene) };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  /** 创建可撤销的 POI 内置 EFF 实体，并把新实体设为当前选择。 */
  createPoiEffect: (effectKind, placementPosition) => {
    const entity = createPoiEffectEntity(effectKind, sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建 EFF 特效');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createFolder: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '新建文件夹');
      const selectedEntity = getSelectedEntity(state);
      const parentId = selectedEntity?.isFolder
        && !isEntityEffectivelyLocked(state.scene.entities, selectedEntity)
          ? selectedEntity.id
          : null;
      const folder = createFolderEntity(createNextFolderName(state.scene));
      const command = createFolderCommand(folder, parentId);
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = [folder.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  importModelAsset: (asset, placementPosition) => {
    if (asset.kind !== 'model') return;

    const displayName = asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '');
    const unitInfo: ModelLengthUnitInfo = createModelLengthUnitInfo(asset.lengthUnit);
    const entity = createModelEntity(
      asset.path,
      asset.sourceUrl,
      displayName,
      unitInfo,
      sanitizeVector3(placementPosition),
      normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
      asset.scriptAssets,
      asset.parameterScriptMetadata,
      asset.animationScriptMetadata,
      asset.defaultAssetCode,
      asset.assetRevision,
      asset.dataDrivenConfig,
      asset.builtInSlotBindingConfig,
    );
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '导入模型');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `导入模型：${asset.name}`),
      };
    });
  },
  refreshModelInstancesFromAssets: (assets) => {
    let refreshedCount = 0;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '刷新模型实例');
      const refreshResult = refreshSceneModelAssetsFromImportedAssets(state.scene, assets);
      refreshedCount = refreshResult.refreshedCount;
      if (refreshResult.scene === state.scene) return state;

      const command = updateSceneDocumentCommand('刷新导入模型', () => refreshResult.scene);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(
          state.logs,
          refreshedCount > 0
            ? `已刷新 ${refreshedCount} 个场景模型实例${refreshResult.detachedMotionInstanceCount > 0 ? `，并拆分 ${refreshResult.detachedMotionInstanceCount} 个 motion 合批实例` : ''}。`
            : `已拆分 ${refreshResult.detachedMotionInstanceCount} 个 motion 合批实例。`,
        ),
      };
    });

    return refreshedCount;
  },
  importCadReference: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '导入 CAD'));
      return;
    }

    if (get().cadImportProgress?.active) {
      set((state) => ({ logs: prependLog(state.logs, 'CAD 正在导入，请等待当前任务完成。') }));
      return;
    }

    if (!window.editorApi?.importCadFile) {
      set((state) => ({ logs: prependLog(state.logs, '导入 CAD 需要 Electron 桌面环境。') }));
      return;
    }

    const importProgressId = crypto.randomUUID();

    try {
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 8, '选择 CAD 文件', '等待选择 .dxf 文件...', null),
      });

      const result = await window.editorApi.importCadFile();
      if (result.canceled || !result.filePath || !result.sourceUrl) {
        set((state) => ({
          cadImportProgress: null,
          logs: prependLog(state.logs, '已取消导入 CAD。'),
        }));
        return;
      }

      const sourceUrl = result.sourceUrl;
      const displayName = result.filePath.split(/[\\/]/).pop()?.replace(/\.dxf$/i, '') || 'CAD参考图';
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 14, '准备读取 CAD', `正在打开 ${displayName}...`, displayName),
      });

      const parseResult = await parseCadReferenceDxfForImport({
        sourceUrl,
        fileSizeBytes: result.fileSizeBytes,
        readSmallFileText: async (onProgress) => {
          const response = await fetch(sourceUrl);
          if (!response.ok) {
            throw new Error(`读取 CAD 文件失败：HTTP ${response.status}`);
          }
          return readCadResponseText(response, result.fileSizeBytes, onProgress);
        },
        onProgress: ({ percent, detail }) => {
          set({
            cadImportProgress: createCadImportProgress(importProgressId, percent, '解析 CAD 图元', detail, displayName),
          });
        },
      });
      rememberCadReferenceParseResult(sourceUrl, parseResult);
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 92, '创建参考层', '正在写入场景并同步到网格层...', displayName),
      });

      const entity = createCadReferenceEntity(
        result.filePath,
        sourceUrl,
        displayName,
        createCadReferenceComponentMetadata(parseResult, {
          sourceFileSizeBytes: result.fileSizeBytes,
          importMode: result.fileSizeBytes >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES ? 'large-preview' : 'exact',
        }),
      );
      const command = createEntityCommand(entity);

      set((state) => {
        const commandResult = executeCommand(state.scene, state.history, command);
        const hierarchySelectionIds = [entity.id];
        return {
          ...commandResult,
          cadImportProgress: createCadImportProgress(importProgressId, 100, '导入完成', 'CAD 参考图已创建。', displayName),
          hierarchySelectionIds,
          ...resolveSelectionTransformMode(state, commandResult.scene, hierarchySelectionIds),
          logs: prependLog(
            state.logs,
            parseResult.budgetLimited
              ? `导入CAD参考图：${displayName}，${formatCadReferenceUnitSummary(parseResult)}，已按大文件预算截取 ${parseResult.polylineCount} 条折线，${parseResult.pointCount} 个点`
              : `导入CAD参考图：${displayName}，${formatCadReferenceUnitSummary(parseResult)}，${parseResult.polylineCount} 条折线，${parseResult.pointCount} 个点`
          ),
        };
      });
      setTimeout(() => {
        set((state) => (
          state.cadImportProgress?.id === importProgressId
            ? { cadImportProgress: null }
            : state
        ));
      }, 900);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        cadImportProgress: createCadImportProgress(importProgressId, 100, '导入失败', message, state.cadImportProgress?.fileName ?? null),
        logs: prependLog(state.logs, `导入 CAD 失败：${message}`),
      }));
      setTimeout(() => {
        set((state) => (
          state.cadImportProgress?.id === importProgressId
            ? { cadImportProgress: null }
            : state
        ));
      }, 1600);
    }
  },
  loadSceneAsset: async (asset) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载资产场景'));
      return;
    }

    if (asset.kind !== 'scene') return;

    try {
      const result = await window.editorApi.readTextFile({ filePath: asset.path });
      const scene = deserializeScene(result.content);

      set((state) => {
        if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '加载资产场景');
        return createLoadedSceneState(state, scene, `场景已加载：${asset.name}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载资产场景失败：${message}`) }));
    }
  },
  selectEntity: (entityId) => {
    set((state) => {
      const selectedEntityId = entityId && state.scene.entities[entityId] ? entityId : null;
      const scene = {
        ...state.scene,
        selectedEntityId,
      };
      const hierarchySelectionIds = selectedEntityId ? [selectedEntityId] : [];
      return {
        scene,
        hierarchySelectionIds,
        selectedModelMeasurement: null,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, scene, hierarchySelectionIds),
      };
    });
  },
  selectHierarchyEntities: (entityIds, primaryEntityId) => {
    set((state) => {
      const hierarchySelectionIds = sanitizeHierarchySelection(state.scene, entityIds);
      const selectedEntityId = primaryEntityId && hierarchySelectionIds.includes(primaryEntityId)
        ? primaryEntityId
        : hierarchySelectionIds[hierarchySelectionIds.length - 1] ?? null;

      const scene = {
        ...state.scene,
        selectedEntityId,
      };
      return {
        scene,
        hierarchySelectionIds,
        selectedModelMeasurement: null,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, scene, hierarchySelectionIds),
      };
    });
  },
  moveEntitiesToFolder: (entityIds, folderId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '拖放移动对象');
      const targetFolder = folderId ? state.scene.entities[folderId] : null;
      if (folderId && !targetFolder?.isFolder) return state;
      if (targetFolder && isEntityEffectivelyLocked(state.scene.entities, targetFolder)) return state;

      const movableIds = getTopLevelHierarchyEntityIds(state.scene.entities, entityIds).filter((entityId) => {
        const entity = state.scene.entities[entityId];
        return Boolean(
          entity
          && entity.parentId !== folderId
          && !isEntityEffectivelyLocked(state.scene.entities, entity)
        );
      });
      if (
        movableIds.length === 0
        || (
          folderId
          && movableIds.some((entityId) => (
            entityId === folderId
            || isEntityAncestorOf(state.scene.entities, entityId, folderId)
          ))
        )
      ) {
        return state;
      }

      const command = moveEntitiesToFolderCommand(movableIds, folderId);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${movableIds.length} 个项目`),
      };
    });
  },
  toggleEntityVisible: (entityId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换显隐');
      const entities = state.scene.entities;
      const entity = entities[entityId];
      if (!entity) return state;

      // 按钮图标展示继承后的有效显隐；点击也按有效状态切换：
      // 显示被祖先隐藏的模型时必须连同隐藏祖先一起显示，
      // 否则会把自身 visible 反向翻转为 false，保存重开后模型永远无法出现。
      const effectivelyVisible = isEntityEffectivelyVisible(entities, entity);
      const command = effectivelyVisible
        ? updateEntityVisibilityCommand(entityId, true, false)
        : updateSceneDocumentCommand('显示对象', (scene) => setEntitiesVisibleInScene(
            scene,
            collectVisibilityShowTargetIds(scene.entities, entityId),
            true,
          ));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  toggleEntityLocked: (entityId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换锁定');
      const entities = state.scene.entities;
      const entity = entities[entityId];
      if (!entity) return state;

      // 与显隐按钮一致：图标展示继承后的有效锁定；解锁被祖先锁定的实体时
      // 必须连同锁定祖先一起解锁，否则会把自身 locked 反向翻转为 true。
      const effectivelyLocked = isEntityEffectivelyLocked(entities, entity);
      const command = effectivelyLocked
        ? updateSceneDocumentCommand('解锁对象', (scene) => setEntitiesLockedInScene(
            scene,
            collectLockUnlockTargetIds(scene.entities, entityId),
            false,
          ))
        : updateEntityLockCommand(entityId, false, true);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  hideSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '隐藏对象');
      const targetIds = getUnlockedSelectionIds(state);
      const changingIds = targetIds.filter((entityId) => state.scene.entities[entityId]?.visible !== false);
      if (changingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('隐藏对象', (scene) => setEntitiesVisibleInScene(scene, changingIds, false));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${changingIds.length} 个对象`),
      };
    });
  },
  lockSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '锁定对象');
      const targetIds = getUnlockedSelectionIds(state);
      const changingIds = targetIds.filter((entityId) => state.scene.entities[entityId]?.locked !== true);
      if (changingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('锁定对象', (scene) => setEntitiesLockedInScene(scene, changingIds, true));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${changingIds.length} 个对象`),
      };
    });
  },
  copySelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '复制对象');
      const selectedIds = getActiveHierarchySelectionIds(state);
      const containsSkybox = getTopLevelHierarchyEntityIds(state.scene.entities, selectedIds).some((rootId) => (
        collectEntitySubtreeIds(state.scene.entities, rootId)
          .some((entityId) => Boolean(state.scene.entities[entityId]?.components.skybox))
      ));
      if (containsSkybox) {
        return { logs: prependLog(state.logs, '球形天空盒是场景唯一对象，不能复制或随文件夹复制。') };
      }
      const containsManualRoamSpawn = getTopLevelHierarchyEntityIds(state.scene.entities, selectedIds).some((rootId) => (
        collectEntitySubtreeIds(state.scene.entities, rootId)
          .some((entityId) => Boolean(state.scene.entities[entityId]?.components.manualRoamSpawn))
      ));
      if (containsManualRoamSpawn) {
        return { logs: prependLog(state.logs, '手动漫游初始位置是场景唯一对象，不能复制或随文件夹复制。') };
      }
      const snapshot = createEntityClipboardSnapshot(state.scene, selectedIds);
      if (snapshot.entries.length === 0) return state;

      return {
        entityClipboard: {
          id: createId('clipboard'),
          entries: snapshot.entries,
        },
        logs: prependLog(
          state.logs,
          `复制对象: ${formatEntityClipboardCount(snapshot.folderCount, snapshot.entityCount)}`,
        ),
      };
    });
  },
  pasteEntityClipboard: (targetFolderId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '粘贴对象');
      const clipboard = state.entityClipboard;
      if (!clipboard || clipboard.entries.length === 0) return state;
      if (clipboard.entries.some((entry) => entry.entities.some((entity) => Boolean(entity.components.skybox)))) {
        return { logs: prependLog(state.logs, '剪贴板包含球形天空盒，已拒绝创建重复天空盒。') };
      }
      if (clipboard.entries.some((entry) => entry.entities.some((entity) => Boolean(entity.components.manualRoamSpawn)))) {
        return { logs: prependLog(state.logs, '剪贴板包含手动漫游初始位置，已拒绝创建重复出生点。') };
      }

      const selectedEntity = getSelectedEntity(state);
      const inferredTargetFolderId =
        targetFolderId === undefined
          ? selectedEntity?.isFolder
            ? selectedEntity.id
            : selectedEntity?.parentId ?? null
          : targetFolderId;
      const parentId = resolvePasteParentId(state.scene, inferredTargetFolderId);
      const parentFolder = parentId ? state.scene.entities[parentId] : null;
      if (parentFolder && isEntityEffectivelyLocked(state.scene.entities, parentFolder)) return state;

      const prepared = prepareEntityClipboardPaste(state.scene, clipboard, parentId);

      const command = updateSceneDocumentCommand('粘贴对象', (scene) =>
        insertClipboardEntitiesInScene(scene, prepared.entities, prepared.rootEntityIds),
      );
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, prepared.rootEntityIds);
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${formatEntityClipboardCount(prepared.folderCount, prepared.entityCount)}`,
        ),
      };
    });
  },
  requestEntityArray: (copyCount, direction, spacingMeters, assetNumberRule) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '阵列对象');
      const sourceIds = getSelectedRuntimeEntityIds(state);
      if (sourceIds.length === 0) return state;

      const normalizedAssetNumberRule = assetNumberRule.trim();
      const ruleError = getArrayAssetNumberRuleError(normalizedAssetNumberRule);
      if (ruleError) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, `模型阵列失败：${ruleError}`),
        };
      }

      const assetNumberedSourceCount = sourceIds.reduce((count, sourceId) => {
        const source = state.scene.entities[sourceId];
        return source && hasEntityAssetNumber(source) ? count + 1 : count;
      }, 0);
      if (normalizedAssetNumberRule && assetNumberedSourceCount !== 1) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：自定义资产编号规则仅支持一个带资产编号的源对象。'),
        };
      }

      const normalizedCopyCount = Math.min(
        MODEL_ARRAY_COPY_COUNT_MAX,
        Math.max(1, Math.floor(Number.isFinite(copyCount) ? copyCount : 3)),
      );
      const normalizedDirection = ENTITY_ARRAY_DIRECTION_VECTORS[direction] ? direction : 'x';
      const spacing = sanitizeNonNegativeNumber(spacingMeters, 1);

      return {
        entityArrayRequest: {
          id: createId('entity_array'),
          sourceIds,
          copyCount: normalizedCopyCount,
          direction: normalizedDirection,
          spacingMeters: spacing,
          assetNumberRule: normalizedAssetNumberRule,
        },
      };
    });
  },
  resolveEntityArrayRequest: (requestId, selectionSpanMeters) => {
    set((state) => {
      const request = state.entityArrayRequest;
      if (!request || request.id !== requestId) return state;
      if (!Number.isFinite(selectionSpanMeters) || selectionSpanMeters === null || selectionSpanMeters < 0) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：选区几何尚未加载完成，请稍后重试。'),
        };
      }

      const prepared = prepareResolvedEntityArray(state, {
        sourceIds: request.sourceIds,
        copyCount: request.copyCount,
        directionVector: ENTITY_ARRAY_DIRECTION_VECTORS[request.direction] ?? ENTITY_ARRAY_DIRECTION_VECTORS.x,
        selectionSpanMeters,
        spacingMeters: request.spacingMeters,
        assetNumberRule: request.assetNumberRule,
      });
      if (!prepared.ok) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, `模型阵列失败：${prepared.error}`),
        };
      }

      const command = createResolvedEntityArrayCommand(prepared);
      const result = executeCommand(state.scene, state.history, command);
      const modelArrayItemIds = prepared.duplicatedEntities
        .filter((entity) => Boolean(entity.components.modelArrayInstance))
        .map((entity) => entity.id);
      const duplicatedIds = prepared.duplicatedEntities
        .filter((entity) => !entity.components.modelArrayInstance)
        .map((entity) => entity.id);
      const createdCount = prepared.duplicatedEntities.length;

      return {
        ...result,
        entityArrayRequest: null,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, prepared.sourceIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${createdCount} 个对象，净间距 ${prepared.spacingMeters} m`,
        ),
      };
    });
  },
  commitResolvedEntityArray: (input) => {
    let commitResult: EntityArrayCommitResult = { ok: false, error: '模型阵列未执行。' };

    set((state) => {
      if (isRuntimePreviewState(state)) {
        const error = '运行预览期间不能创建模型阵列。';
        commitResult = { ok: false, error };
        return { logs: prependLog(state.logs, `模型阵列失败：${error}`) };
      }

      const prepared = prepareResolvedEntityArray(state, input);
      if (!prepared.ok) {
        commitResult = { ok: false, error: prepared.error };
        return { logs: prependLog(state.logs, `模型阵列失败：${prepared.error}`) };
      }

      const command = createResolvedEntityArrayCommand(prepared);
      const result = executeCommand(state.scene, state.history, command);
      const modelArrayItemIds = prepared.duplicatedEntities
        .filter((entity) => Boolean(entity.components.modelArrayInstance))
        .map((entity) => entity.id);
      const duplicatedIds = prepared.duplicatedEntities
        .filter((entity) => !entity.components.modelArrayInstance)
        .map((entity) => entity.id);
      const createdCount = prepared.duplicatedEntities.length;
      commitResult = { ok: true, duplicatedIds, modelArrayItemIds, createdCount };

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, prepared.sourceIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${createdCount} 个对象，净间距 ${prepared.spacingMeters} m`,
        ),
      };
    });

    return commitResult;
  },
  groupSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '群组对象');
      const groupingIds = getSelectedRuntimeEntityIds(state);
      if (groupingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('群组对象', (scene) => groupEntitiesInScene(scene, groupingIds));
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${groupingIds.length} 个对象`),
      };
    });
  },
  ungroupSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '解组对象');
      const selectionIds = getUnlockedSelectionIds(state);
      const folderIds = selectionIds.flatMap((entityId) => {
        const entity = state.scene.entities[entityId];
        if (!entity) return [];
        if (entity.isFolder) return [entity.id];
        return entity.parentId ? [entity.parentId] : [];
      });
      const ungroupingIds = [...new Set(folderIds)].filter((folderId) => {
        const folder = state.scene.entities[folderId];
        return Boolean(folder?.isFolder && !isEntityEffectivelyLocked(state.scene.entities, folder));
      });
      if (ungroupingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('解组对象', (scene) => ungroupFoldersInScene(scene, ungroupingIds));
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${ungroupingIds.length} 个分组`),
      };
    });
  },
  requestSceneFocusForSelection: () => {
    set((state) => {
      const focusIds = resolveSceneFocusEntityIds(state.scene, getActiveHierarchySelectionIds(state));
      if (focusIds.length === 0) return state;

      return {
        sceneFocusRequest: {
          id: createId('scene_focus'),
          entityIds: focusIds,
        },
        logs: prependLog(state.logs, `场景聚焦: ${focusIds.length} 个对象`),
      };
    });
  },
  requestProjectAssetFocusForEntity: (entityId) => {
    set((state) => {
      const entity = entityId ? state.scene.entities[entityId] : getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!entity || !modelAsset) {
        return { logs: prependLog(state.logs, '库聚焦仅支持导入模型。') };
      }

      return {
        projectAssetFocusRequest: {
          id: createId('asset_focus'),
          sourcePath: modelAsset.sourcePath,
          sourceUrl: modelAsset.sourceUrl,
          entityName: entity.name,
        },
        logs: prependLog(state.logs, `库聚焦: ${entity.name}`),
      };
    });
  },
  consumeSceneFocusRequest: (requestId) => {
    set((state) => {
      if (state.sceneFocusRequest?.id !== requestId) return state;
      return { sceneFocusRequest: null };
    });
  },
  requestRevealHierarchyEntity: (entityId) => {
    set((state) => {
      if (!state.scene.entities[entityId]) return state;
      return {
        revealHierarchyEntityRequest: {
          id: createId('reveal_hierarchy'),
          entityId,
        },
      };
    });
  },
  consumeRevealHierarchyEntityRequest: (requestId) => {
    set((state) => {
      if (state.revealHierarchyEntityRequest?.id !== requestId) return state;
      return { revealHierarchyEntityRequest: null };
    });
  },
  consumeProjectAssetFocusRequest: (requestId) => {
    set((state) => {
      if (state.projectAssetFocusRequest?.id !== requestId) return state;
      return { projectAssetFocusRequest: null };
    });
  },
  renameSelectedEntity: (name) => {
    const nextName = sanitizeEntityName(name);
    if (!nextName) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名对象');
      const entity = getSelectedEntity(state);
      if (!entity || isEntityEffectivelyLocked(state.scene.entities, entity) || entity.name === nextName) return state;

      const command = renameEntityCommand(entity.id, entity.name, nextName);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${nextName}`),
      };
    });
  },
  deleteSelectedEntity: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '删除对象');
      const selectedEntity = getSelectedEntity(state);
      const selectedWaypointId = sanitizeSelectedAutoPatrolWaypointId(
        state.scene,
        state.selectedAutoPatrolWaypointId,
      );
      if (selectedWaypointId && isRuntimeEntityEditable(state.scene, selectedEntity) && selectedEntity.components.autoPatrol) {
        const current = selectedEntity.components.autoPatrol;
        const before = cloneAutoPatrolComponent(current);
        const after = cloneAutoPatrolComponent({
          ...current,
          autoStart: current.autoStart,
          waypoints: current.waypoints.filter((waypoint) => waypoint.id !== selectedWaypointId),
        });
        const command = updateAutoPatrolCommand(selectedEntity.id, before, after, '删除巡检点位');
        const result = executeCommand(state.scene, state.history, command);
        return {
          ...result,
          selectedAutoPatrolWaypointId: null,
          autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
          logs: prependLog(state.logs, command.label),
        };
      }
      const deletingIds = getUnlockedSelectionIds(state);
      if (deletingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('删除对象', (scene) => deleteEntitiesInScene(scene, deletingIds));
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds);
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${deletingIds.length} 个对象`),
      };
    });
  },
  updateSelectedTransform: (field, axis, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改变换');
      const entity = getSelectedEntity(state);
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;
      if (entity.components.locator?.builtInBinding) return state;

      const before = normalizeTransformForEntity(entity, entity.components.transform);
      const candidate = cloneTransform(before);
      if (entity.components.skybox && field === 'scale') {
        candidate.scale = normalizeSkyboxSphereScale({ x: value, y: value, z: value });
      } else {
        candidate[field][axis] = value;
      }
      const after = normalizeTransformForEntity(entity, candidate);
      if (areTransformsEqual(before, after)) return state;

      const command = updateTransformCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedMaterialColor: (materialColor) => {
    if (!isColorLike(materialColor)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改材质颜色');
      const entity = getSelectedEntity(state);
      const meshRenderer = entity?.components.meshRenderer;
      if (!isRuntimeEntityEditable(state.scene, entity) || !meshRenderer || meshRenderer.materialColor === materialColor) return state;

      const before = cloneMeshRenderer(meshRenderer);
      const after = { ...before, materialColor };
      const command = updateMeshRendererCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedLocator: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改定位器');
      const entity = getSelectedEntity(state);
      const locator = entity?.components.locator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !locator) return state;

      const before = cloneLocator(locator);
      const after: LocatorComponent = {
        // 内置货格资产编号始终跟随宿主货架，忽略外部 patch
        assetId: before.builtInBinding ? before.assetId : sanitizeLocatorAssetId(patch.assetId, before.assetId),
        storageDepth: patch.storageDepth === 'far' ? 'far' : (patch.storageDepth === 'near' ? 'near' : before.storageDepth),
        length: sanitizeLocatorDimension(patch.length, before.length),
        width: sanitizeLocatorDimension(patch.width, before.width),
        height: sanitizeLocatorDimension(patch.height, before.height),
        columns: sanitizeLocatorInt(patch.columns, before.columns, 1, 100),
        layers: sanitizeLocatorInt(patch.layers, before.layers, 1, 100),
        startColumn: sanitizeLocatorInt(patch.startColumn, before.startColumn, 0, 999),
        startLayer: sanitizeLocatorInt(patch.startLayer, before.startLayer, 0, 999),
        columnReversed: patch.columnReversed ?? before.columnReversed,
        columnGap: sanitizeLocatorGap(patch.columnGap, before.columnGap),
        layerGap: sanitizeLocatorGap(patch.layerGap, before.layerGap),
        deviceAssetCode: patch.deviceAssetCode !== undefined ? patch.deviceAssetCode.trim().slice(0, 128) : before.deviceAssetCode,
        rowNumber: sanitizeLocatorInt(patch.rowNumber, before.rowNumber, 0, 999),
        fetchDrive: sanitizeLocatorFetchDrivePatch(patch.fetchDrive, before.fetchDrive),
        builtInBinding: sanitizeLocatorBuiltInBindingPatch(patch.builtInBinding, before.builtInBinding),
      };

      if (areLocatorsEqual(before, after)) return state;

      const command = updateLocatorCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedCadReference: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改 CAD 参考图');
      const entity = getSelectedEntity(state);
      const cadReference = entity?.components.cadReference;
      if (!isRuntimeEntityEditable(state.scene, entity) || !cadReference) return state;

      const before = cloneCadReference(cadReference);
      const after = sanitizeCadReferenceDisplayPatch(before, patch);
      if (areCadReferencesEqual(before, after)) return state;

      const command = updateCadReferenceCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedLight: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改灯光');
      const entity = getSelectedEntity(state);
      const light = entity?.components.light;
      if (!isRuntimeEntityEditable(state.scene, entity) || !light) return state;

      const before = cloneLight(light);
      const after: LightComponent = {
        ...before,
        ...patch,
        intensity: patch.intensity === undefined ? before.intensity : sanitizePositiveNumber(patch.intensity, before.intensity),
      };

      if (before.lightKind === after.lightKind && before.intensity === after.intensity) return state;

      const command = updateLightCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        ...resolveSelectionTransformMode(state, result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedModelAssetCode: (assetCode) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改资产编号');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset) return state;

      const before = modelAsset.assetCode;
      const after = sanitizeModelAssetCode(assetCode, before);
      if (before === after) return state;

      const command = updateModelAssetCodeCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${after}`),
      };
    });
  },
  updateSelectedModelGenerator: (component, label = '更新模型生成器') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.modelGenerator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const normalized = sanitizeModelGeneratorComponent(component);
      if (!normalized) return state;
      const before = cloneModelGeneratorComponent(current);
      const after = cloneModelGeneratorComponent(normalized);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updateModelGeneratorCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  /** 更新选中 EFF 的完整配置快照，并通过命令历史支持撤销和重做。 */
  updateSelectedPoiEffect: (component, label = '更新 EFF 特效') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.poiEffect;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const before = { ...current };
      const after = sanitizePoiEffectComponent(component);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updatePoiEffectCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, `${command.label}: ${entity.name}`) };
    });
  },
  updateSelectedAutoPatrol: (component, label = '更新自动巡检') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;
      const sanitized = sanitizeAutoPatrolComponent(component);
      if (!sanitized) return state;
      const after = cloneAutoPatrolComponent({
        ...sanitized,
        autoStart: sanitized.autoStart,
      });
      const before = cloneAutoPatrolComponent(current);
      if (areJsonValuesEqual(before, after)) return state;

      const command = after.autoStart
        ? updateSceneDocumentCommand(label, (scene) => {
            const entities = { ...scene.entities };
            for (const entityId of scene.entityIds) {
              const candidate = entities[entityId];
              const candidatePatrol = candidate?.components.autoPatrol;
              if (!candidatePatrol) continue;
              const nextPatrol = entityId === entity.id
                ? after
                : candidatePatrol.autoStart
                  ? { ...candidatePatrol, autoStart: false }
                  : candidatePatrol;
              if (nextPatrol === candidatePatrol) continue;
              entities[entityId] = {
                ...candidate,
                components: { ...candidate.components, autoPatrol: nextPatrol },
              };
            }
            return { ...scene, entities };
          })
        : updateAutoPatrolCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        selectedAutoPatrolWaypointId: sanitizeSelectedAutoPatrolWaypointId(
          result.scene,
          state.selectedAutoPatrolWaypointId,
        ),
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  commitSelectedAutoPatrolWaypointTransform: (waypointId, transform) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '调整巡检点位');
      const entity = getSelectedEntity(state);
      const current = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;
      const waypointIndex = current.waypoints.findIndex((waypoint) => waypoint.id === waypointId);
      if (waypointIndex < 0) return state;
      const updatedWaypoint = updateAutoPatrolWaypointView(
        current.waypoints[waypointIndex],
        entity.components.transform,
        {
          position: transform.position,
          headingDegrees: transform.rotation.y * RADIANS_TO_DEGREES,
          pitchDegrees: -transform.rotation.x * RADIANS_TO_DEGREES,
        },
      );
      const before = cloneAutoPatrolComponent(current);
      const after = cloneAutoPatrolComponent({
        ...current,
        waypoints: current.waypoints.map((waypoint, index) => index === waypointIndex ? updatedWaypoint : waypoint),
      });
      if (areJsonValuesEqual(before, after)) return state;
      const command = updateAutoPatrolCommand(entity.id, before, after, '调整巡检点位');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        selectedAutoPatrolWaypointId: waypointId,
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedTelemetryBinding: (binding) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改遥测绑定');
      const entity = getSelectedEntity(state);
      if (!entity?.components.modelAsset) return state;
      const before = entity.components.telemetryBinding ?? null;
      const after = binding ? normalizeTelemetryBindingComponent(binding) : null;
      if (JSON.stringify(before) === JSON.stringify(after)) return state;
      const command = updateTelemetryBindingCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label) };
    });
  },
  restoreSelectedTelemetryBindingDefault: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '恢复遥测绑定');
      const entity = getSelectedEntity(state);
      const devType = entity?.components.modelAsset?.dataDrivenConfig?.device.devType;
      if (!entity || !devType) return state;
      const before = entity.components.telemetryBinding ?? null;
      const after = createDefaultTelemetryBinding(devType);
      if (JSON.stringify(before) === JSON.stringify(after)) return state;
      const command = updateTelemetryBindingCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, '已恢复模型默认数据驱动绑定') };
    });
  },
  updateSelectedModelParameterValue: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
      if (sanitizedValue === null) return state;

      const before = getSelectedModelParameterValues(state);
      if (!before) return state;

      const after = patchModelParameterValue(before, key, sanitizedValue);
      if (areModelParameterValuesEqual(before, after)) return state;

      // 声明了内置货格绑定时，参数变化与货格副作用（创建/删除/维度派生）合并为单条快照命令，保证 undo 整体回滚。
      const command = getBuiltInSlotBindingConfig(entity)
        ? updateSceneDocumentCommand('更新模型参数', (scene) => applyBuiltInSlotSideEffects(
            updateModelParameterValuesCommand(entity.id, before, after).execute(scene),
            entity.id,
          ))
        : updateModelParameterValuesCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewSelectedModelParameterValue: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
      if (sanitizedValue === null) return state;

      const before = getSelectedModelParameterValues(state);
      if (!before) return state;

      const after = patchModelParameterValue(before, key, sanitizedValue);
      if (areModelParameterValuesEqual(before, after)) return state;

      const previewScene: SceneDocument = {
        ...state.scene,
        entities: {
          ...state.scene.entities,
          [entity.id]: {
            ...entity,
            components: {
              ...entity.components,
              modelAsset: {
                ...modelAsset,
                parameterValues: after,
              },
            },
          },
        },
      };

      // preview 不写撤销历史，仅同步派生货格维度；创建/解绑由 commit 路径处理。
      return {
        scene: patchBuiltInSlotDimensions(previewScene, entity.id),
      };
    });
  },
  commitSelectedModelParameterValues: (before, after) => {
    if (areModelParameterValuesEqual(before, after)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedBefore = sanitizeModelParameterValues(modelAsset.parameterConfig, before);
      const sanitizedAfter = sanitizeModelParameterValues(modelAsset.parameterConfig, after);
      if (areModelParameterValuesEqual(sanitizedBefore, sanitizedAfter)) return state;

      const command = getBuiltInSlotBindingConfig(entity)
        ? updateSceneDocumentCommand('更新模型参数', (scene) => applyBuiltInSlotSideEffects(
            updateModelParameterValuesCommand(entity.id, sanitizedBefore, sanitizedAfter).execute(scene),
            entity.id,
          ))
        : updateModelParameterValuesCommand(entity.id, sanitizedBefore, sanitizedAfter);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewEntityTransform: (entityId, transform) => {
    if (!isFiniteTransform(transform)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览变换');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;
      if (entity.components.locator?.builtInBinding) return state;

      const normalizedTransform = normalizeTransformForEntity(entity, transform);
      if (areTransformsEqual(entity.components.transform, normalizedTransform)) return state;

      return {
        scene: {
          ...state.scene,
          entities: {
            ...state.scene.entities,
            [entityId]: {
              ...entity,
              components: {
                ...entity.components,
                transform: normalizedTransform,
              },
            },
          },
        },
      };
    });
  },
  commitEntityTransform: (entityId, before, after) => {
    if (!isFiniteTransform(before) || !isFiniteTransform(after)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交变换');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;
      if (entity.components.locator?.builtInBinding) return state;

      const normalizedBefore = normalizeTransformForEntity(entity, before);
      const normalizedAfter = normalizeTransformForEntity(entity, after);
      if (areTransformsEqual(normalizedBefore, normalizedAfter)) return state;

      const command = updateTransformCommand(entityId, normalizedBefore, normalizedAfter);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  commitFolderGroupTranslation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '移动文件夹对象');
      }

      const result = commitFolderGroupTranslationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        input,
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  commitFolderGroupRotation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '旋转文件夹对象');
      }

      const normalizedInput = {
        ...input,
        beforeTransforms: normalizeGroupRotationTransforms(
          state.scene,
          input.entityIds,
          input.beforeTransforms,
        ),
        afterTransforms: normalizeGroupRotationTransforms(
          state.scene,
          input.entityIds,
          input.afterTransforms,
        ),
      };
      const result = commitFolderGroupRotationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        normalizedInput,
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  commitHierarchyGroupTranslation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '移动选中对象');
      }

      const result = commitHierarchyGroupTranslationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        input,
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  commitHierarchyGroupRotation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '旋转选中对象');
      }

      const result = commitHierarchyGroupRotationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        {
          ...input,
          beforeTransforms: normalizeGroupRotationTransforms(
            state.scene,
            input.entityIds,
            input.beforeTransforms,
          ),
          afterTransforms: normalizeGroupRotationTransforms(
            state.scene,
            input.entityIds,
            input.afterTransforms,
          ),
        },
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  previewSelectedTransform: (transform) => {
    const selectedId = get().scene.selectedEntityId;
    if (!selectedId) return;

    get().previewEntityTransform(selectedId, transform);
  },
  commitSelectedTransform: (before, after) => {
    const selectedId = get().scene.selectedEntityId;
    if (!selectedId) return;

    get().commitEntityTransform(selectedId, before, after);
  },
  updateMqttConfig: (config) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存 MQTT 配置');
      const mqttConfig = sanitizeMqttConfig(config);
      if (isMqttConfigEqual(state.scene.mqttConfig, mqttConfig)) {
        return state;
      }

      const command = updateSceneDocumentCommand('更新 MQTT 配置', (scene) => ({
        ...scene,
        mqttConfig,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(
          state.logs,
          `MQTT 配置已保存：${mqttConfig.simulatorEnabled ? `本地模拟 ${mqttConfig.simulatorAssetCode}/${mqttConfig.simulatorScenario}` : mqttConfig.address || '未设置地址'}，Topic ${mqttConfig.topic}，${mqttConfig.enabled ? '已启用' : '未启用'}`,
        ),
      };
    });
  },
  updateFetchConfig: (config) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存 Fetch 配置');
      const fetchConfig = sanitizeFetchConfig(config);
      const command = updateSceneDocumentCommand('更新 Fetch 配置', (scene) => ({
        ...scene,
        fetchConfig,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `Fetch 配置已保存：${fetchConfig.url || '未设置地址'}`),
      };
    });
  },
  undo: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '撤销');
      const result = undoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: sanitizeSelectedAutoPatrolWaypointId(
          result.scene,
          state.selectedAutoPatrolWaypointId,
        ),
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        environmentApplyRequest: null,
        environmentAdjustmentActive: false,
        environmentFocusRequest: null,
        logs: prependLog(state.logs, 'Undo'),
      };
    });
  },
  redo: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重做');
      const result = redoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: sanitizeSelectedAutoPatrolWaypointId(
          result.scene,
          state.selectedAutoPatrolWaypointId,
        ),
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        environmentApplyRequest: null,
        environmentAdjustmentActive: false,
        environmentFocusRequest: null,
        logs: prependLog(state.logs, 'Redo'),
      };
    });
  },
  newScene: () => {
    let opened = false;
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '新建场景');
      opened = true;
      return createLoadedSceneState(state, createEmptySceneDocument(), '已新建空白场景。');
    });
    if (opened) void syncDataPlatformEnvironmentsAfterWorkspaceOpen((message) => get().pushLog(message));
  },
  hasUnsavedChanges: () => {
    const state = get();
    return serializeScene(state.scene) !== state.persistedSceneContent;
  },
  markScenePersisted: (content) => {
    const persistedSceneContent = content ?? serializeScene(get().scene);
    set({ persistedSceneContent });
  },
  saveScene: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '保存场景'));
      return false;
    }

    const sceneSnapshot = get().scene;

    try {
      const content = serializeScene(sceneSnapshot);
      const result = await window.editorApi.saveScene({
        suggestedName: `${sceneSnapshot.name}.scene.json`,
        content,
      });

      if (result.canceled) {
        set((state) => ({ logs: prependLog(state.logs, '已取消保存场景。') }));
        return false;
      }

      set((state) => ({
        persistedSceneContent: content,
        logs: prependLog(state.logs, `场景已保存：${result.filePath ?? '未知路径'}`),
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `保存场景失败：${message}`) }));
      return false;
    }
  },
  loadScene: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载场景'));
      return false;
    }

    try {
      const result = await window.editorApi.loadScene();

      if (result.canceled || result.content === null) {
        set((state) => ({ logs: prependLog(state.logs, '已取消加载场景。') }));
        return false;
      }

      const scene = deserializeScene(result.content);

      set((state) => createLoadedSceneState(state, scene, `场景已加载：${result.filePath ?? scene.name}`));
      void syncDataPlatformModelsAfterLocalSceneLoad((message) => get().pushLog(message));
      void syncDataPlatformEnvironmentsAfterWorkspaceOpen((message) => get().pushLog(message));
      void syncDataPlatformImagesAfterLocalSceneLoad((message) => get().pushLog(message));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载场景失败：${message}`) }));
      return false;
    }
  },
  loadSceneFromFile: async (filePath) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载最近场景'));
      return false;
    }

    try {
      if (!window.editorApi?.loadSceneFile) {
        throw new Error('按路径加载场景需要 Electron 桌面环境。');
      }

      const result = await window.editorApi.loadSceneFile({ filePath });

      if (result.canceled || result.content === null) {
        set((state) => ({ logs: prependLog(state.logs, '已取消加载场景。') }));
        return false;
      }

      const scene = deserializeScene(result.content);
      set((state) => createLoadedSceneState(state, scene, `场景已加载：${result.filePath ?? scene.name}`));
      void syncDataPlatformModelsAfterLocalSceneLoad((message) => get().pushLog(message));
      void syncDataPlatformEnvironmentsAfterWorkspaceOpen((message) => get().pushLog(message));
      void syncDataPlatformImagesAfterLocalSceneLoad((message) => get().pushLog(message));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载最近场景失败：${message}`) }));
      return false;
    }
  },
  loadSceneFromContent: (content, sourceName) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载内置场景'));
      return false;
    }

    try {
      const scene = deserializeScene(content);
      set((state) => createLoadedSceneState(state, scene, `场景已加载：${sourceName || scene.name}`));
      void syncDataPlatformEnvironmentsAfterWorkspaceOpen((message) => get().pushLog(message));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载内置场景失败：${message}`) }));
      return false;
    }
  },
  pushLog: (message) => {
    set((state) => ({ logs: prependLog(state.logs, message) }));
  },
}));
