import { type SceneModelEntranceSettings } from '../../model/sceneModelEntrance';
import { type SceneOpeningConfig } from '../../model/sceneOpeningAnimation';
import { type FailedSceneResources } from '../../assets/restoreFailedSceneResources';
import { type AlarmManagerComponent } from '../../model/alarmManager';
import { type EntityLightingSettings, type LightingNodeOverride, type LightingClassificationEntry, type SceneLightingBakeSettings, type SceneLightingBakeSnapshot } from '../../../../electron/shared/sceneLightingBakeContract';
import type { ManualRoamAvatar } from '../../model/components';
import { type LightingManagerTab, type LightingManagerFocus, type LightingManagementDraft, type LightingManagementResult } from '../lightingManagementState';
import { type SceneRegionCamera } from '../../model/sceneRegionViews';
import { type CommandHistory } from '../../commands/CommandHistory';
import { type FolderGroupRotationInput, type FolderGroupTranslationInput, type HierarchyGroupRotationInput, type HierarchyGroupTranslationInput } from '../../commands/entityCommands';
import { type CameraOrientation, type CameraProjection, type StandardCameraOrientation, type EditorGridCellSize, type EditorGridSettings } from '../../../runtime/babylon/createEngine';
import type { AssetEntry } from '../../assets/AssetDatabase';
import type { AutoPatrolComponent, CadReferenceComponent, ClickEventBindingComponent, ChartMarkerComponent, DataPlatformScreenComponent, DeviceSpawnerComponent, LightComponent, LightKind, LocatorComponent, MeshKind, ModelGeneratorComponent, PoiEffectComponent, PoiEffectKind, SkyboxComponent, TransformComponent } from '../../model/components';
import type { Entity } from '../../model/Entity';
import type { DataPlatformChartAssetEntry } from '../../assets/dataPlatformChartLibrary';
import { type SceneCameraPose, type FetchConfig, type MqttConfig, type SceneEnvironmentSettings, type SceneEnvironmentTransform, type SceneSkyboxSettings, type SceneSensitivitySettings, type SceneDocument } from '../../model/SceneDocument';
import type { Vector3Data } from '../../model/math';
import type { AutoPatrolPlaybackSnapshot } from '../../../runtime/babylon/AutoPatrolPlaybackController';
import type { SceneModelStatisticsSnapshot } from '../../model/sceneModelStatistics';
import { type EnvironmentApplyRequest, type EnvironmentApplyResult, type EnvironmentRuntimeSnapshot } from '../../model/environmentRuntime';
import { type ModelParameterValue, type ModelParameterValues } from '../../model/modelParameters';
import type { ModelMeasurementResult } from '../../../runtime/babylon/modelMeasurement';
import type { GroupSpatialInfoResult } from '../../model/groupSpatialInfo';
import { type RuntimePreviewReadiness } from '../../model/mqttConfigUtils';
import type { EditorRuntimeMode } from '../../model/editorRuntimeMode';
import { type CadReferenceLoadStatus } from '../../cad/cadReferenceLoadStatus';
import type { StateCreator } from 'zustand';
import type { ProjectOpenTraceContext } from '../../../../electron/shared/projectOpenTrace';

export type EditorLog = {
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
  tone?: 'active' | 'success' | 'error' | 'canceled';
  entityId?: string;
};

export type EntityClipboardEntry = {
  rootId: string;
  entities: Entity[];
};

export type EntityClipboard = {
  id: string;
  entries: EntityClipboardEntry[];
};

export type EntityArrayDirection = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

export type EntityArrayRequest = {
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

/** 聚焦请求的相机动画选项；缺省保持即时跳变。 */
export type SceneFocusTransition = {
  animate: boolean;
  durationMs?: number;
  /** false 时保持当前观察方向，只平移聚焦居中（点击事件绑定聚焦用）。 */
  useModelFocusAngle?: boolean;
  /** 聚焦距离倍率，>1 时离目标更远一些。 */
  radiusScale?: number;
};

export type SceneFocusRequest = {
  id: string;
  entityIds: string[];
  transition?: SceneFocusTransition;
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

export type OpeningAnimationPreviewRequest = {
  requestId: string;
  sceneSessionId: string;
  action: 'play' | 'stop';
};

export type RegionViewRequest = {
  id: string;
  sceneSessionId: string;
  kind: 'save' | 'apply';
  regionViewId?: string;
  name: string;
};

export type AutoPatrolCameraRequest =
  | { id: string; kind: 'capture'; entityId: string; waypointId: string | null }
  | { id: string; kind: 'focus'; entityId: string; waypointId: string };

export type AutoPatrolPlaybackRequest = {
  id: string;
  action:
    | 'start'
    | 'pause'
    | 'resume'
    | 'skip'
    | 'stop'
    | 'emergency-stop'
    | 'return'
    | 'set-rate'
    | 'set-view'
    | 'resume-auto-view'
    | 'trigger-event';
  routeId: string | null;
  payload?: string | number | null;
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

export type TransformField = 'position' | 'rotation' | 'scale';

export type TransformTool = 'translate' | 'rotate' | 'scale';

export type TransformSpace = 'local' | 'global';

export type GroupTransformModeRestore = {
  tool: TransformTool;
  space: TransformSpace;
};

export type TransformSnapSettingKey = 'position' | 'rotationDegrees' | 'scale';

export type SceneSensitivitySettingKey = keyof SceneSensitivitySettings;

export type EnvironmentApplyOptions = {
  preserveSceneResourceUrls?: boolean;
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

export type EditorState = {
  compositionEditRootId: string | null;
  compositionSaveRequest: { id: string; sceneSessionId: string; ids: string[] } | null;
  requestCompositionSave: () => void;
  setCompositionEditRoot: (id: string | null) => void;
  commitCompositionEdit: (before: SceneDocument, after: SceneDocument, label: string) => boolean;
  scene: SceneDocument;
  sceneSessionId: string;
  persistedSceneContent: string;
  runtimeMode: EditorRuntimeMode;
  /** 仅本次编辑器运行预览使用，不写入场景文件或撤销历史。 */
  runtimePerformanceEnabled: boolean;
  history: CommandHistory;
  latestSceneResourceTransaction: { before: SceneDocument; history: CommandHistory; after: SceneDocument; issues: string[]; kind?: 'local-recovery' } | null;
  latestSceneResourceRecovery: { before: SceneDocument; after: SceneDocument } | null;
  sceneResourceIssues: string[];
  recordSceneResourceIssues: (sceneSessionId: string, issues: string[]) => void;
  hierarchySelectionIds: string[];
  entityClipboard: EntityClipboard | null;
  entityArrayRequest: EntityArrayRequest | null;
  sceneFocusRequest: SceneFocusRequest | null;
  environmentApplyRequest: EnvironmentApplyRequest | null;
  environmentRuntimeOverride: SceneEnvironmentSettings | null;
  sceneResourcePolicy: 'local-refresh' | 'data-platform-refresh' | 'preserve-snapshot';
  environmentStartupRelinkSessionId: string | null;
  sceneStartupResourceSessionId: string | null;
  sceneSourceFilePath: string | null;
  localSceneEnvironmentRecoveryChoice: NonNullable<LocalSceneResourceSyncResult['environmentRecoveryChoice']> | null;
  localSceneEnvironmentRecoveryAcceptance: NonNullable<LocalSceneResourceSyncRequest['acceptEnvironmentRevision']> | null;
  environmentRuntimeSnapshot: EnvironmentRuntimeSnapshot;
  sceneModelStatistics: SceneModelStatisticsSnapshot | null;
  environmentAdjustmentActive: boolean;
  environmentFocusRequest: { id: string } | null;
  projectAssetFocusRequest: ProjectAssetFocusRequest | null;
  revealHierarchyEntityRequest: { id: string; entityId: string } | null;
  cameraPoseSaveRequest: CameraPoseSaveRequest | null;
  openingAnimationPreviewRequest: OpeningAnimationPreviewRequest | null;
  updateSceneOpeningAnimation: (patch: SceneOpeningConfig | null) => void;
  updateSceneModelEntranceSettings: (patch: Partial<SceneModelEntranceSettings>) => void;
  requestOpeningAnimationPreview: (action: OpeningAnimationPreviewRequest['action']) => void;
  consumeOpeningAnimationPreviewRequest: (requestId: string, sceneSessionId: string) => void;
  regionViewRequest: RegionViewRequest | null;
  regionViewMessage: string | null;
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
  startRuntimePreview: (options?: { performance?: boolean }) => RuntimePreviewReadiness;
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
  lightingBakePreflight: import('../lightingManagementState').LightingManagerPreflightState;
  lightingBakePreflightRequest: { id: string; scene: SceneDocument; sceneSessionId: string } | null;
  requestLightingBakePreflight: () => void;
  completeLightingBakePreflight: (id: string, report: import('../../../../electron/shared/sceneLightingBakePreflight').LightingBakePreflight) => void;
  failLightingBakePreflight: (id: string, message: string) => void;
  lightingBakeTaskHistory: import('../../../../electron/shared/sceneLightingBakeTasks').LightingBakeTaskHistory | null;
  lightingBakeTaskHistoryError: string | null;
  refreshLightingBakeTaskHistory: () => Promise<void>;
  cleanupLightingBakeTasks: (taskIds: string[]) => Promise<void>;
  lightingRuntimeDiagnostic: import('../../../runtime/babylon/lightingRuntimeDiagnostic').LightingRuntimeDiagnostic | null;
  setLightingRuntimeDiagnostic: (diagnostic: import('../../../runtime/babylon/lightingRuntimeDiagnostic').LightingRuntimeDiagnostic | null) => void;
  lightingShadowCosts: import('../../../runtime/babylon/lightingShadowCosts').LightingShadowMetrics | null;
  setLightingShadowCosts: (costs: import('../../../runtime/babylon/lightingShadowCosts').LightingShadowMetrics | null) => void;
  lightingDraftPreview: import('../lightingManagementState').LightingDraftPreview | null;
  setLightingDraftPreview: (draft: import('../lightingManagementState').LightingManagementDraft | null) => LightingManagementResult;
  lightingBakeRequest: { id: string } | null;
  lightingGpuCapabilityProfile: import('../../../runtime/babylon/gpuCapabilityProfile').GpuCapabilityProfile | null;
  setLightingGpuCapabilityProfile: (profile: import('../../../runtime/babylon/gpuCapabilityProfile').GpuCapabilityProfile | null) => void;
  lightingManagerOpen: boolean;
  lightingManagerTab: LightingManagerTab;
  lightingManagerFocus: LightingManagerFocus | null;
  lightingManagerPreview: string | null;
  lightingManagerPreviewError: string | null;
  lightingManagerPreviewRequest: number;
  openLightingManager: (options?: { tab?: LightingManagerTab; entityIds?: string[]; nodeKey?: string }) => void;
  closeLightingManager: () => void;
  setLightingManagerTab: (tab: LightingManagerTab) => void;
  refreshLightingManagerPreview: () => void;
  applyLightingManagementDraft: (draft: LightingManagementDraft) => LightingManagementResult;
  lightingBakeStatus: { phase: 'idle' | 'preparing' | 'baking' | 'applying' | 'error' | 'cancelled'; message: string | null; progress?: number; source?: 'runtime' };
  setLightingBakeRuntimeError: (message: string | null) => void;
  requestLightingBake: () => void;
  cancelLightingBake: () => void;
  completeLightingBake: (requestId: string, snapshot: SceneLightingBakeSnapshot) => void;
  failLightingBake: (requestId: string, message: string) => void;
  updateLightingBakeSettings: (patch: Partial<SceneLightingBakeSettings>) => void;
  clearLightingBake: () => void;
  updateEntityLightingSettings: (entityIds: string[], patch: Partial<EntityLightingSettings>) => void;
  updateLightingNodeOverride: (entityId: string, nodeKey: string, patch: Partial<LightingNodeOverride> | null) => void;
  lightingClassification: LightingClassificationEntry[];
  lightingInspectorEntityIds: string[];
  lightingInspectorClassification: LightingClassificationEntry[];
  lightingInspectorClassificationStale: boolean;
  setLightingInspectorEntityIds: (entityIds: string[]) => void;
  setLightingClassification: (entries: LightingClassificationEntry[]) => void;
  lightingDebugVisible: boolean;
  setLightingDebugVisible: (visible: boolean) => void;
  lightingComparisonEnabled: boolean;
  setLightingComparisonEnabled: (enabled: boolean) => void;
  lightingNodeFocusRequest: { entityId: string; nodeKey: string; sequence: number } | null;
  focusLightingNode: (entityId: string, nodeKey: string) => void;
  updateEnvironmentConfig: (environment: SceneEnvironmentSettings | null) => void;
  setDefaultCargoGenerator: (generatorId: string | null) => void;
  requestEnvironmentApply: (
    environment: SceneEnvironmentSettings,
    options?: EnvironmentApplyOptions,
  ) => string | null;
  completeEnvironmentApply: (requestId: string, result: EnvironmentApplyResult) => void;
  failEnvironmentApply: (requestId: string, message: string) => void;
  setEnvironmentRuntimeSnapshot: (snapshot: EnvironmentRuntimeSnapshot) => void;
  setSceneModelStatistics: (snapshot: SceneModelStatisticsSnapshot | null, expectedSceneSessionId: string) => void;
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
  applyPreparedSkyboxEnvironment: (entityId: string | null, source: SceneSkyboxSettings, environment: import('../../../../electron/shared/sceneSkyboxContract').SkyboxEnvironmentResource) => void;
  placeSkybox: (skybox: SceneSkyboxSettings) => void;
  updateSelectedSkybox: (patch: Partial<Pick<SkyboxComponent, 'intensity' | 'resolution'>>) => void;
  setEnvironmentActiveVariant: (sourceUrl: string) => void;
  requestCameraPoseSave: () => void;
  requestRegionView: (kind: RegionViewRequest['kind'], name: string, regionViewId?: string) => void;
  consumeRegionViewRequest: (requestId: string, camera?: SceneRegionCamera, error?: string) => void;
  renameRegionView: (id: string, name: string) => void;
  moveRegionView: (id: string, direction: 'up' | 'down') => void;
  reorderRegionView: (id: string, targetId: string, position: 'before' | 'after') => void;
  deleteRegionView: (id: string) => void;
  consumeCameraPoseSaveRequest: (requestId: string, pose: SceneCameraPose) => void;
  requestCameraReset: () => void;
  consumeCameraResetRequest: (requestId: string) => void;
  selectAutoPatrolWaypoint: (waypointId: string | null) => void;
  requestAutoPatrolCapture: () => void;
  requestAutoPatrolFocus: (waypointId: string) => void;
  consumeAutoPatrolCameraRequest: (requestId: string, pose?: SceneCameraPose, captureError?: string) => void;
  requestAutoPatrolPlayback: (
    action: AutoPatrolPlaybackRequest['action'],
    routeId?: string | null,
    payload?: AutoPatrolPlaybackRequest['payload'],
  ) => void;
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
  createDeviceSpawner: (placementPosition?: Vector3Data) => void;
  createAutoPatrol: (placementPosition?: Vector3Data) => void;
  createManualRoamSpawn: (placementPosition?: Vector3Data) => void;
  setManualRoamAvatar: (entityId: string, avatar: ManualRoamAvatar | null) => void;
  createPoiEffect: (effectKind: PoiEffectKind, placementPosition?: Vector3Data, targetEntityId?: string) => void;
  createChartMarker: (placementPosition?: Vector3Data) => void;
  createAlarmManager: (placementPosition?: Vector3Data) => void;
  updateAlarmManager: (entityId: string, patch: Partial<AlarmManagerComponent>) => void;
  updateChartMarker: (entityId: string, patch: Partial<ChartMarkerComponent>) => void;
  bindChartMarkerScreen: (entityId: string, source: DataPlatformChartAssetEntry | null) => boolean;
  createClickEventBinding: (placementPosition?: Vector3Data) => void;
  createFolder: () => void;
  importModelAsset: (asset: AssetEntry, placementPosition?: Vector3Data) => void;
  finishLatestSceneResources: (sceneSessionId: string, expectedScene: SceneDocument, error?: string, failed?: FailedSceneResources) => void;
  commitLatestSceneResources: (sceneSessionId: string, before: SceneDocument, after: SceneDocument, issues?: string[]) => boolean;
  finishSceneStartupResourcePreparation: (sceneSessionId: string) => void;
  beginLocalSceneResourceRecovery: (sceneSessionId: string) => void;
  setLocalSceneEnvironmentRecoveryChoice: (sceneSessionId: string, choice: NonNullable<LocalSceneResourceSyncResult['environmentRecoveryChoice']> | null) => void;
  acceptLocalSceneEnvironmentRecoveryChoice: (sceneSessionId: string, expectedChoice: NonNullable<LocalSceneResourceSyncResult['environmentRecoveryChoice']>) => boolean;
  commitRecoveredLocalSceneResources: (sceneSessionId: string, before: SceneDocument, after: SceneDocument) => boolean;
  refreshModelInstancesFromAssets: (assets: AssetEntry[], options?: { preserveResolvedSnapshots?: boolean }) => number;
  importCadReference: () => Promise<void>;
  cancelCadImport: () => void;
  dismissCadImportProgress: () => void;
  reportCadReferenceRuntimeLoad: (status: CadReferenceLoadStatus) => void;
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
  requestSceneFocusForSelection: (entityIds?: string[], transition?: SceneFocusTransition) => void;
  requestProjectAssetFocusForEntity: (entityId: string | null) => void;
  consumeSceneFocusRequest: (requestId: string) => void;
  requestRevealHierarchyEntity: (entityId: string) => void;
  consumeRevealHierarchyEntityRequest: (requestId: string) => void;
  consumeProjectAssetFocusRequest: (requestId: string) => void;
  renameSelectedEntity: (name: string) => void;
  deleteSelectedEntity: () => void;
  updateSelectedTransform: (field: TransformField, axis: keyof Vector3Data, value: number) => void;
  updateSelectedMaterialColor: (materialColor: string) => void;
  updateSelectedDataPlatformScreen: (patch: Partial<Pick<DataPlatformScreenComponent, 'renderMode'>>) => void;
  updateSelectedLocator: (patch: Partial<LocatorComponent>) => void;
  updateSelectedCadReference: (patch: Partial<Pick<CadReferenceComponent, 'lineColor' | 'opacity'>>) => void;
  updateSelectedLight: (patch: Partial<LightComponent>) => void;
  updateSelectedModelAssetCode: (assetCode: string) => void;
  updateSelectedModelGenerator: (component: ModelGeneratorComponent, label?: string) => void;
  updateSelectedDeviceSpawner: (component: DeviceSpawnerComponent, label?: string) => void;
  updateSelectedClickEventBinding: (component: ClickEventBindingComponent, label?: string) => void;
  updateSelectedPoiEffect: (component: PoiEffectComponent, label?: string) => void;
  updateSelectedAutoPatrol: (component: AutoPatrolComponent, label?: string) => void;
  commitSelectedAutoPatrolWaypointTransform: (waypointId: string, transform: TransformComponent) => void;
  updateSelectedTelemetryBinding: (binding: import('../../model/telemetryBinding').TelemetryBindingComponent | null) => void;
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
  loadScene: (onFailure?: (message: string) => void) => Promise<boolean>;
  loadSceneFromFile: (filePath: string, isCurrent?: () => boolean, deferEnvironmentUntilSync?: boolean, openTrace?: ProjectOpenTraceContext) => Promise<boolean>;
  loadSceneFromContent: (content: string, sourceName: string) => boolean;
  pushLog: (message: string) => void;
};

/** 所有 Slice 共用同一个 Zustand store；跨域命令仍通过一次 set 原子提交。 */
export type EditorSlice<Keys extends keyof EditorState> = StateCreator<EditorState, [], [], Pick<EditorState, Keys>>;
