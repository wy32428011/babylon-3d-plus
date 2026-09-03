import { executeChartMarkerClick } from '../../runtime/babylon/chartMarkerClick';
import { CHART_MARKER_REFRESH_EVENT } from '../../shared/chartMarkerEmbed';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import {
  createBabylonViewport,
  type BabylonViewport,
  type BabylonViewportRuntimeStatus,
} from '../../runtime/babylon/createEngine';
import { DIGITAL_TWIN_CAMERA_CONTROL_STANDARD } from '../../runtime/babylon/cameraControlStandard';
import {
  completeSceneModelSelectionPointer,
  createSceneModelSelectionPointerSnapshot,
  updateSceneModelSelectionPointerSnapshot,
  type SceneModelSelectionPointerSnapshot,
} from '../../shared/sceneModelSelectionPointer';
import { applySavedSceneCameraView } from '../../runtime/babylon/sceneCameraView';
import {
  CLICK_EVENT_FOCUS_DURATION_MS,
  CLICK_EVENT_FOCUS_RADIUS_SCALE,
  resolveClickEventBindingClick,
  type ClickEventBindingPickedCell,
} from '../model/clickEventBinding';
import { MqttStackerTelemetryClient } from '../../runtime/mqtt/MqttStackerTelemetryClient';
import { SceneRuntime, type DataPlatformScreenOverlayItem } from '../../runtime/babylon/SceneRuntime';
import { createEntityGroupRotationDeltaMatrix } from '../../runtime/babylon/EntityGroupRotationPreview';
import {
  AutoPatrolPlaybackController,
  collectAutoPatrolPlaybackRoutes,
  findAutoStartPatrolRoute,
  type AutoPatrolPlaybackRoute,
} from '../../runtime/babylon/AutoPatrolPlaybackController';
import { AutoPatrolRuntimeIntegration } from '../../runtime/patrol/AutoPatrolRuntimeIntegration';
import {
  createSceneCameraPoseFromReplayCamera,
  type AutoPatrolInspectionReplayCamera,
} from '../../runtime/patrol/AutoPatrolInspectionReplayController';
import type { AutoPatrolInspectionRecordStore } from '../../runtime/patrol/AutoPatrolInspectionRecordStore';
import {
  ScenePerformanceMonitor,
  type EditModeThinInstancePlanPerformanceMetrics,
  type SceneFocusPerformanceMetrics,
  type ScenePerformanceSnapshot,
} from '../../runtime/babylon/ScenePerformanceMonitor';
import {
  TransformGizmoController,
  type EntityArrayDragUpdate,
} from '../../runtime/babylon/TransformGizmoController';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  decodeBuiltInAssetDragPayload,
  decodeModelAssetDragPayload,
  decodeSkyboxAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
  SKYBOX_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import {
  useEditorStore,
  type EntityArrayDirection,
} from '../store/editorStore';
import { DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE, decodeDataPlatformScreenDragPayload } from '../assets/dataPlatformScreenDrag';
import { getBuiltInMeshGroundOffsetMeters } from '../model/builtInMeshGeometry';
import { getLightEditorCapabilities } from '../model/lightEditor';
import {
  AUTO_PATROL_EYE_HEIGHT_METERS,
  createAutoPatrolWaypointFromWorldPose,
  getAutoPatrolWaypointWorldPose,
  validateAutoPatrolRoute,
} from '../model/autoPatrolInspection';
import {
  containsManualRoamSpawnEntity,
  hasManualRoamSpawnEntity,
  resolveManualRoamGroupRotationReference,
  resolveManualRoamSpawnPose,
  resolveManualRoamAvatarSource,
} from '../model/manualRoamSpawn';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import {
  getSceneSkyboxSettings,
  SKYBOX_FOCUS_VIEW_DISTANCE_METERS,
  SCENE_VIEW_DISTANCE_MAX,
  type SceneDocument,
} from '../model/SceneDocument';
import { resolveEnvironmentRuntimeSettings } from '../model/environmentRuntime';
import { createSceneSkyboxFromAsset } from '../assets/skyboxAssets';
import type { Vector3Data } from '../model/math';
import { createGroupPositionDelta } from '../model/groupSpatialInfo';
import {
  resolveHierarchyGroupTransformSelection,
  toggleHierarchyEntitySelection,
  type HierarchyGroupTransformReadySelection,
} from '../model/entityHierarchy';
import {
  getEntityArrayIdentifierError,
  getEntityArrayParameterError,
  getShiftEntityArrayIdentityBehavior,
  isShiftEntityArraySupported,
  MODEL_ARRAY_MIN_SPAN_METERS,
} from '../model/modelArray';
import {
  createEditModeModelThinInstancePlan,
  patchEditModeModelThinInstancePlanForModelParameters,
  resolveModelParameterOnlySceneChangeEntityId,
  type EditModeModelThinInstancePlan,
} from '../model/editModeModelThinInstances';
import { EntityArrayDialog, type EntityArrayDialogValue } from '../ui/EntityArrayDialog';
import { ViewportOrientationCompass } from '../ui/ViewportOrientationCompass';
import { AutoPatrolControls } from '../../shared/ui/AutoPatrolControls';
import { DataPlatformScreenOverlay } from '../../runtime/babylon/DataPlatformScreenOverlay';
import { DataPlatformViewportScreenOverlay } from '../../runtime/babylon/DataPlatformViewportScreenOverlay';
import type { DataPlatformScreenCommand } from '../../runtime/babylon/dataPlatformScreenBridge';
import { buildDigitalTwinAssetIndex, findDigitalTwinAsset } from '../../shared/digitalTwinAssetCodes';
import { useAutoPatrolInspectionHistory } from '../../shared/ui/useAutoPatrolInspectionHistory';
import { ManualRoamControls } from '../../shared/ui/ManualRoamControls';
import {
  createInitialManualRoamSnapshot,
  ManualRoamRuntime,
  type ManualRoamSnapshot,
  type ManualRoamTouchAction,
} from '../../runtime/roam/ManualRoamRuntime';
import type {
  ManualRoamConfig,
  ManualRoamLocomotionMode,
  ManualRoamViewMode,
} from '../../runtime/roam/manualRoamCore';
import { createDefaultManualRoamCollisionBoundsResolver } from '../../runtime/roam/manualRoamCollisionBounds';
import {
  beginScenePreparation,
  countExpectedSceneBatchedEntities,
  getScenePreparationSnapshot,
  hasScenePreparationRuntimeTimedOut,
  isScenePreparationActive,
  reportSceneRuntimeProgress,
  settleSceneRuntimeWithWarning,
  subscribeScenePreparation,
} from '../loading/scenePreparationProgress';
import '../../styles/scene-performance.css';

type EntityArrayDialogState = {
  sourceEntityId: string;
  sourceSceneDocument: SceneDocument;
  direction: Vector3Data;
  spanMeters: number;
  directionLabel: string;
  value: EntityArrayDialogValue;
  commitError: string | null;
};

const SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING = '模型加载或 Geometry 合批超过 120 秒，已解除蒙版，请在 Console 检查失败模型。';

type HierarchyGroupTranslationSession = HierarchyGroupTransformReadySelection & {
  sourceSceneDocument: SceneDocument;
};

type HierarchyGroupRotationSession = HierarchyGroupTransformReadySelection & {
  sourceSceneDocument: SceneDocument;
};

/** 将未知异常转换成可展示的简短消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 浏览器与 smoke 环境共用的高精度计时入口。 */
function readScenePanelTimestampMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** HUD 只展示两位以内的稳定数字，原始报告仍保留完整精度。 */
function formatPerformanceMetric(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

/** 复制性能报告；Clipboard API 被策略禁用时回退到临时 textarea。 */
async function copyScenePerformanceReport(report: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(report);
      return;
    } catch {
      // Electron 权限或非安全上下文会进入同步 fallback。
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = report;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus();
    textarea.select();
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error('系统剪贴板拒绝复制。');
}

/** 从带正负号的阵列方向读取唯一世界坐标轴。 */
function getEntityArrayAxis(direction: EntityArrayDirection): 'x' | 'y' | 'z' {
  const axis = direction.replace('-', '');
  if (axis === 'y' || axis === 'z') return axis;
  return 'x';
}


/** 将 Shift 拖拽结果映射为弹框兼容的方向值与可读标签。 */
function describeEntityArrayDrag(update: EntityArrayDragUpdate): {
  direction: EntityArrayDirection;
  label: string;
} {
  const dot = update.direction.x * update.positiveDirection.x
    + update.direction.y * update.positiveDirection.y
    + update.direction.z * update.positiveDirection.z;
  const negative = dot < 0;
  const direction = `${negative ? '-' : ''}${update.axis}` as EntityArrayDirection;
  return {
    direction,
    label: `${negative ? '-' : '+'}${update.axis.toUpperCase()}（${update.space === 'local' ? '局部' : '世界'}）`,
  };
}

/** 校验 Shift 阵列弹框中的数量、间距、源对象和名称/编号规则。 */
function getEntityArrayDialogError(
  scene: SceneDocument,
  dialog: EntityArrayDialogState,
): string | null {
  const parameterError = getEntityArrayParameterError(
    dialog.value.copyCount,
    dialog.value.spacingMeters,
  );
  if (parameterError) return parameterError;
  if (scene !== dialog.sourceSceneDocument) return '阵列源场景已切换，请重新开始 Shift 拖拽。';
  if (!Number.isFinite(dialog.spanMeters) || dialog.spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) {
    return '源对象在当前轴上的尺寸无效。';
  }

  const source = scene.entities[dialog.sourceEntityId];
  const parent = source?.parentId ? scene.entities[source.parentId] : null;
  if (!isShiftEntityArraySupported(source) || source?.locked || parent?.locked) {
    return '源对象已失效、被锁定或不再支持 Shift 阵列。';
  }

  return getEntityArrayIdentifierError(
    scene,
    [dialog.sourceEntityId],
    dialog.value.copyCount,
    dialog.value.assetNumberRule,
  );
}

type SceneViewPanelProps = {
  performanceHudVisible: boolean;
};

export function SceneViewPanel(props: SceneViewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<BabylonViewport | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const gizmoRef = useRef<TransformGizmoController | null>(null);
  const autoPatrolPlaybackRef = useRef<AutoPatrolPlaybackController | null>(null);
  const manualRoamRef = useRef<ManualRoamRuntime | null>(null);
  const mqttTelemetryClientRef = useRef<MqttStackerTelemetryClient | null>(null);
  const performanceMonitorRef = useRef<ScenePerformanceMonitor | null>(null);
  const sceneFocusPerformanceRef = useRef<SceneFocusPerformanceMetrics | null>(null);
  const clickSnapshotRef = useRef<SceneModelSelectionPointerSnapshot | null>(null);
  const sceneDocumentRef = useRef<SceneDocument | null>(null);
  const editRuntimeSceneDocumentRef = useRef<SceneDocument | null>(null);
  const editModeThinInstancePlanRef = useRef<EditModeModelThinInstancePlan | null>(null);
  const editModeThinInstancePlanPerformanceRef = useRef<EditModeThinInstancePlanPerformanceMetrics>({
    planCount: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    entityCount: 0,
    groupCount: 0,
    thinInstanceEntityCount: 0,
  });
  const recordedEditModeThinInstancePlanComputationRef = useRef<object | null>(null);
  const modelParameterSceneChangeRef = useRef<{ entities: SceneDocument['entities']; entityId: string | null } | null>(null);
  const sceneRuntimeReadinessStableSamplesRef = useRef(0);
  const sceneRuntimeReadinessStartedAtRef = useRef(0);
  const sceneRuntimeTimeoutLoggedRef = useRef(false);
  const selectedEntityIdRef = useRef<string | null>(null);
  const autoPatrolPreviewStartedRef = useRef(false);
  const autoPatrolPreviewAutoStartCancelledRef = useRef(false);
  const runtimeModeRef = useRef<EditorRuntimeMode>('edit');
  const entityArrayDialogRef = useRef<EntityArrayDialogState | null>(null);
  const hierarchyGroupTranslationRef = useRef<HierarchyGroupTranslationSession | null>(null);
  const hierarchyGroupRotationRef = useRef<HierarchyGroupRotationSession | null>(null);
  const hierarchyGroupStatusLogSignatureRef = useRef('');
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [viewportCamera, setViewportCamera] = useState<BabylonViewport['camera'] | null>(null);
  const [entityArrayDialog, setEntityArrayDialog] = useState<EntityArrayDialogState | null>(null);
  const [performanceSnapshot, setPerformanceSnapshot] = useState<ScenePerformanceSnapshot | null>(null);
  const [performanceHudExpanded, setPerformanceHudExpanded] = useState(false);
  const [sceneRuntimeNaturallyReady, setSceneRuntimeNaturallyReady] = useState(false);
  const [manualRoamSnapshot, setManualRoamSnapshot] = useState<ManualRoamSnapshot>(createInitialManualRoamSnapshot);
  const [autoPatrolRecordStore, setAutoPatrolRecordStore] = useState<AutoPatrolInspectionRecordStore | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);
  const sceneSessionId = useEditorStore((state) => state.sceneSessionId);
  const manualRoamSceneSessionIdRef = useRef(sceneSessionId);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const hierarchySelectionIds = useEditorStore((state) => state.hierarchySelectionIds);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const trajectoryVisible = useEditorStore((state) => state.trajectoryVisible);
  const entityArrayRequest = useEditorStore((state) => state.entityArrayRequest);
  const sceneFocusRequest = useEditorStore((state) => state.sceneFocusRequest);
  const environmentApplyRequest = useEditorStore((state) => state.environmentApplyRequest);
  const environmentRuntimeOverride = useEditorStore((state) => state.environmentRuntimeOverride);
  const environmentStartupRelinkSessionId = useEditorStore((state) => state.environmentStartupRelinkSessionId);
  const environmentAdjustmentActive = useEditorStore((state) => state.environmentAdjustmentActive);
  const environmentRuntimePhase = useEditorStore((state) => state.environmentRuntimeSnapshot.phase);
  const environmentFocusRequest = useEditorStore((state) => state.environmentFocusRequest);
  const cameraPoseSaveRequest = useEditorStore((state) => state.cameraPoseSaveRequest);
  const cameraResetRequest = useEditorStore((state) => state.cameraResetRequest);
  const cameraOrientation = useEditorStore((state) => state.cameraOrientation);
  const cameraProjection = useEditorStore((state) => state.cameraProjection);
  const selectedAutoPatrolWaypointId = useEditorStore((state) => state.selectedAutoPatrolWaypointId);
  const autoPatrolCameraRequest = useEditorStore((state) => state.autoPatrolCameraRequest);
  const autoPatrolPlaybackRequest = useEditorStore((state) => state.autoPatrolPlaybackRequest);
  const autoPatrolPlaybackSnapshot = useEditorStore((state) => state.autoPatrolPlaybackSnapshot);
  const selectEntity = useEditorStore((state) => state.selectEntity);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const createModelGenerator = useEditorStore((state) => state.createModelGenerator);
  const createAutoPatrol = useEditorStore((state) => state.createAutoPatrol);
  const createManualRoamSpawn = useEditorStore((state) => state.createManualRoamSpawn);
  const createPoiEffect = useEditorStore((state) => state.createPoiEffect);
  const createChartMarker = useEditorStore((state) => state.createChartMarker);
  const createClickEventBinding = useEditorStore((state) => state.createClickEventBinding);
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const placeSkybox = useEditorStore((state) => state.placeSkybox);
  const previewEntityTransform = useEditorStore((state) => state.previewEntityTransform);
  const commitEntityTransform = useEditorStore((state) => state.commitEntityTransform);
  const previewEnvironmentTransform = useEditorStore((state) => state.previewEnvironmentTransform);
  const commitEnvironmentTransform = useEditorStore((state) => state.commitEnvironmentTransform);
  const completeEnvironmentApply = useEditorStore((state) => state.completeEnvironmentApply);
  const failEnvironmentApply = useEditorStore((state) => state.failEnvironmentApply);
  const setEnvironmentRuntimeSnapshot = useEditorStore((state) => state.setEnvironmentRuntimeSnapshot);
  const setEnvironmentAdjustmentActive = useEditorStore((state) => state.setEnvironmentAdjustmentActive);
  const commitHierarchyGroupTranslation = useEditorStore((state) => state.commitHierarchyGroupTranslation);
  const commitHierarchyGroupRotation = useEditorStore((state) => state.commitHierarchyGroupRotation);
  const resolveEntityArrayRequest = useEditorStore((state) => state.resolveEntityArrayRequest);
  const commitResolvedEntityArray = useEditorStore((state) => state.commitResolvedEntityArray);
  const consumeSceneFocusRequest = useEditorStore((state) => state.consumeSceneFocusRequest);
  const consumeEnvironmentFocusRequest = useEditorStore((state) => state.consumeEnvironmentFocusRequest);
  const consumeCameraPoseSaveRequest = useEditorStore((state) => state.consumeCameraPoseSaveRequest);
  const consumeCameraResetRequest = useEditorStore((state) => state.consumeCameraResetRequest);
  const requestCameraReset = useEditorStore((state) => state.requestCameraReset);
  const toggleCameraStandardView = useEditorStore((state) => state.toggleCameraStandardView);
  const requestAutoPatrolCapture = useEditorStore((state) => state.requestAutoPatrolCapture);
  const consumeAutoPatrolCameraRequest = useEditorStore((state) => state.consumeAutoPatrolCameraRequest);
  const consumeAutoPatrolPlaybackRequest = useEditorStore((state) => state.consumeAutoPatrolPlaybackRequest);
  const requestAutoPatrolPlayback = useEditorStore((state) => state.requestAutoPatrolPlayback);
  const setSelectedModelMeasurement = useEditorStore((state) => state.setSelectedModelMeasurement);
  const setSelectedGroupSpatialInfo = useEditorStore((state) => state.setSelectedGroupSpatialInfo);

  const groupInspectorTransformRequest = useEditorStore((state) => state.groupInspectorTransformRequest);
  const consumeGroupInspectorTransformRequest = useEditorStore((state) => state.consumeGroupInspectorTransformRequest);
  const pushLog = useEditorStore((state) => state.pushLog);
  const stopRuntimePreview = useEditorStore((state) => state.stopRuntimePreview);
  const isRuntimePreview = runtimeMode === 'preview';
  const handleDataPlatformScreenCommand = useCallback((
    _item: DataPlatformScreenOverlayItem | null,
    command: DataPlatformScreenCommand,
  ): void => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (command.type === 'screen.clearSelection') {
      runtime.clearExternalHighlight();
      return;
    }

    const entityId = command.payload.entityId
      ?? (command.payload.assetCode
        ? (() => {
          const lookup = findDigitalTwinAsset(buildDigitalTwinAssetIndex(sceneDocument), command.payload.assetCode);
          return lookup.status === 'found' ? lookup.entityId : null;
        })()
        : null);
    if (!entityId || !sceneDocument.entities[entityId]) {
      pushLog('大屏联动目标不存在或资产编号不唯一。');
      return;
    }

    runtime.setExternalHighlightEntityIds([entityId]);
    if (command.type !== 'screen.focusEntity') return;
    const bounds = runtime.getEntitiesWorldBounds([entityId]);
    if (!bounds || !viewportRef.current) {
      pushLog('大屏联动目标的三维几何尚未就绪。');
      return;
    }
    viewportRef.current.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS });
  }, [pushLog, sceneDocument]);
  const handleViewportDataPlatformScreenCommand = useCallback((command: DataPlatformScreenCommand): void => {
    handleDataPlatformScreenCommand(null, command);
  }, [handleDataPlatformScreenCommand]);
  const applyHistoryReplayCamera = useCallback((camera: AutoPatrolInspectionReplayCamera): void => {
    viewportRef.current?.applyCameraPose(createSceneCameraPoseFromReplayCamera(camera), { animate: false });
  }, []);
  const beginHistoryReplay = useCallback((): void => {
    autoPatrolPreviewAutoStartCancelledRef.current = true;
    const pendingRequest = useEditorStore.getState().autoPatrolPlaybackRequest;
    if (pendingRequest?.action === 'start' || pendingRequest?.action === 'resume') {
      useEditorStore.getState().consumeAutoPatrolPlaybackRequest(pendingRequest.id);
    }
    manualRoamRef.current?.setEnabled(false);
    autoPatrolPlaybackRef.current?.stop();
    viewportRef.current?.cancelCameraTransition('manual-input');
  }, []);
  const {
    history: autoPatrolHistory,
    handleHistoryAction,
    pauseReplay: pauseHistoryReplay,
  } = useAutoPatrolInspectionHistory({
    recordStore: autoPatrolRecordStore,
    scopeId: sceneDocument.id,
    applyCamera: applyHistoryReplayCamera,
    onReplayStart: beginHistoryReplay,
    onError: pushLog,
  });
  const handleChartMarkerClick = useCallback((entityId: string): boolean => {
    const state = useEditorStore.getState();
    const runtime = runtimeRef.current;
    if (state.runtimeMode !== 'preview' || !runtime) return false;
    pauseHistoryReplay();
    return executeChartMarkerClick(state.scene, entityId, {
      focusEntity: (targetId) => {
        const bounds = runtime.getEntitiesWorldBounds([targetId]);
        if (!bounds || !viewportRef.current) return false;
        manualRoamRef.current?.setEnabled(false);
        autoPatrolPlaybackRef.current?.notifyManualInput();
        viewportRef.current.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS });
        return true;
      },
      selectEntity: (targetId) => {
        runtime.setLocalSlotHighlight('', null);
        state.setEnvironmentAdjustmentActive(false);
        state.selectEntity(targetId);
      },
      refreshMarker: (markerId) => window.dispatchEvent(new CustomEvent(CHART_MARKER_REFRESH_EVENT, { detail: markerId })),
      showTheme: () => {
        state.pushLog('主题展示需从数据中台大屏中嵌入的数字孪生触发，编辑器预览未连接大屏宿主。');
      },
      reportError: state.pushLog,
    });
  }, [pauseHistoryReplay]);
  const editModeThinInstancePlanComputation = useMemo(() => {
    const startedAt = readScenePanelTimestampMs();
    const previousPlan = editModeThinInstancePlanRef.current;
    const cachedParameterSceneChange = modelParameterSceneChangeRef.current;
    const parameterSyncEntityId = previousPlan
      ? cachedParameterSceneChange?.entities === sceneDocument.entities
        ? cachedParameterSceneChange.entityId
        : resolveModelParameterOnlySceneChangeEntityId(sceneDocumentRef.current, sceneDocument)
      : null;
    const plan = parameterSyncEntityId && previousPlan
      ? patchEditModeModelThinInstancePlanForModelParameters(sceneDocument, previousPlan, parameterSyncEntityId)
      : createEditModeModelThinInstancePlan(sceneDocument, previousPlan ?? undefined);
    return {
      plan,
      parameterSyncEntityId,
      durationMs: Math.max(0, readScenePanelTimestampMs() - startedAt),
      entityCount: sceneDocument.entityIds.length,
    };
  }, [sceneDocument.entityIds, sceneDocument.entities]);
  const editModeThinInstancePlan = editModeThinInstancePlanComputation.plan;
  const modelParameterSyncEntityId = editModeThinInstancePlanComputation.parameterSyncEntityId;
  const editRuntimeSceneDocument = useMemo(
    () => editModeThinInstancePlan.entities === sceneDocument.entities
      ? sceneDocument
      : { ...sceneDocument, entities: editModeThinInstancePlan.entities },
    [editModeThinInstancePlan.entities, sceneDocument],
  );
  const autoPatrolRoutes = useMemo<AutoPatrolPlaybackRoute[]>(
    () => collectAutoPatrolPlaybackRoutes(sceneDocument),
    [sceneDocument.entityIds, sceneDocument.entities],
  );
  /** 未摆放手动漫游 POI 时不展示运行预览漫游面板。 */
  const hasManualRoamSpawn = useMemo(
    () => hasManualRoamSpawnEntity(sceneDocument),
    [sceneDocument.entityIds, sceneDocument.entities],
  );
  const hierarchyGroupTransformSelection = useMemo(
    () => resolveHierarchyGroupTransformSelection(sceneDocument, hierarchySelectionIds),
    [hierarchySelectionIds, sceneDocument],
  );

  const sceneRuntimeReadinessGeneration = sceneSessionId;
  const preparationState = useSyncExternalStore(
    subscribeScenePreparation,
    getScenePreparationSnapshot,
    getScenePreparationSnapshot,
  );
  const scenePreparationNaturallyCompleted = (
    preparationState.completed && !preparationState.runtime.forcedSettled
  ) || sceneRuntimeNaturallyReady;
  const sceneReadyForAutoPatrol = preparationState.sceneSessionId === sceneSessionId
    && preparationState.assetRefreshStatus === 'settled'
    && scenePreparationNaturallyCompleted
    && (!sceneDocument.sceneSettings.environment || environmentRuntimePhase === 'ready');

  /** 发布当前单模型尺寸和 Hierarchy 群组世界包围盒，二者都只进入临时 Inspector 状态。 */
  const publishSelectedInspectorSpatialInfo = useCallback((runtime: SceneRuntime, entityId: string | null): void => {
    const state = useEditorStore.getState();
    const currentScene = sceneDocumentRef.current ?? state.scene;
    const selectedEntity = entityId ? currentScene.entities[entityId] : null;
    if (!entityId || !selectedEntity?.components.modelAsset) {
      setSelectedModelMeasurement(null);
    } else {
      const measurement = runtime.getModelMeasurement(entityId);
      setSelectedModelMeasurement({ entityId, ...measurement });
    }

    const groupSelection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
    if (!groupSelection.groupId || groupSelection.status === 'unavailable') {
      setSelectedGroupSpatialInfo(null);
      return;
    }

    const rotation = resolveManualRoamGroupRotationReference(state.scene, groupSelection.entityIds);
    setSelectedGroupSpatialInfo({
      groupId: groupSelection.groupId,
      rotation: rotation ? { ...rotation } : { x: 0, y: 0, z: 0 },
      ...runtime.getEntityGroupSpatialInfo(groupSelection.entityIds),
    });
  }, [setSelectedGroupSpatialInfo, setSelectedModelMeasurement]);


  /** 清除 Shift 阵列弹框和全部 Babylon 临时克隆。 */
  const closeEntityArrayDialog = useCallback((): void => {
    entityArrayDialogRef.current = null;
    setEntityArrayDialog(null);
    runtimeRef.current?.clearEntityArrayPreview();
  }, []);

  /** 根据当前 Store 选区绑定普通实体或 Hierarchy 群组代理 Gizmo。 */
  const attachCurrentSelectionGizmo = useCallback((
    runtime: SceneRuntime,
    gizmo: TransformGizmoController,
  ): void => {
    const state = useEditorStore.getState();
    const selectedPatrolRouteId = state.scene.selectedEntityId
      && state.scene.entities[state.scene.selectedEntityId]?.components.autoPatrol
      ? state.scene.selectedEntityId
      : null;
    runtime.setAutoPatrolSelection(
      selectedPatrolRouteId,
      selectedPatrolRouteId ? state.selectedAutoPatrolWaypointId : null,
    );
    if (state.environmentAdjustmentActive) {
      runtime.clearFolderGroupGizmoTarget();
      gizmo.attachToEnvironmentTarget(runtime.getEnvironmentGizmoTarget());
      return;
    }

    const groupSelection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
    if (groupSelection.status === 'ready') {
      const groupTool = state.transformTool === 'rotate' ? 'rotate' : 'translate';
      const containsManualRoamSpawn = containsManualRoamSpawnEntity(state.scene, groupSelection.entityIds);
      const target = runtime.getFolderGroupGizmoTarget(
        groupSelection.groupId,
        groupSelection.entityIds,
        groupTool,
      );
      gizmo.attachToGroupTarget(target, groupSelection.groupId, {
        rotationAxes: containsManualRoamSpawn ? ['y'] : undefined,
      });
      return;
    }
    if (groupSelection.status !== 'unavailable') {
      runtime.clearFolderGroupGizmoTarget();
      gizmo.attachToTarget(null, null);
      return;
    }

    const selectedEntityId = state.scene.selectedEntityId;
    const selectedEntity = selectedEntityId ? state.scene.entities[selectedEntityId] : null;
    const selectedWaypointId = selectedEntity?.components.autoPatrol
      ? state.selectedAutoPatrolWaypointId
      : null;
    if (selectedEntityId && selectedWaypointId) {
      const waypointTarget = runtime.getAutoPatrolWaypointGizmoTarget(selectedEntityId, selectedWaypointId);
      gizmo.attachToTarget(waypointTarget, selectedEntityId, {
        subTargetId: selectedWaypointId,
        supportedTools: ['translate', 'rotate'],
        entityArrayEnabled: false,
        rotationAxes: ['x', 'y'],
      });
      runtime.clearFolderGroupGizmoTarget();
      return;
    }

    const lightCapabilities = selectedEntity?.components.light
      ? getLightEditorCapabilities(selectedEntity.components.light.lightKind)
      : null;
    const target = runtime.getGizmoTargetByEntityId(selectedEntityId);
    gizmo.attachToTarget(target, selectedEntityId, {
      uniformScaleOnly: Boolean(selectedEntity?.components.skybox),
      supportedTools: selectedEntity?.components.autoPatrol || selectedEntity?.components.manualRoamSpawn
        ? ['translate', 'rotate']
        : lightCapabilities?.supportedTools,
      entityArrayEnabled: lightCapabilities === null
        && !selectedEntity?.components.autoPatrol
        && !selectedEntity?.components.manualRoamSpawn,
      rotationAxes: selectedEntity?.components.manualRoamSpawn ? ['y'] : undefined,
    });
    runtime.clearFolderGroupGizmoTarget();
  }, []);

  /** 空群组、锁定成员或异步几何未就绪时只提示一次。 */
  useEffect(() => {
    if (isRuntimePreview || hierarchyGroupTransformSelection.status === 'unavailable') {
      hierarchyGroupStatusLogSignatureRef.current = '';
      return;
    }

    if (hierarchyGroupTransformSelection.status === 'ready') {
      const runtime = runtimeRef.current;
      const groupTool = transformTool === 'rotate' ? 'rotate' : 'translate';
      if (!runtime || runtime.isEntityGroupTransformReady(hierarchyGroupTransformSelection.entityIds, groupTool)) {
        hierarchyGroupStatusLogSignatureRef.current = '';
        return;
      }
      const signature = `loading:${hierarchyGroupTransformSelection.groupId}`;
      if (hierarchyGroupStatusLogSignatureRef.current === signature) return;
      hierarchyGroupStatusLogSignatureRef.current = signature;
      pushLog('选区群组暂不可变换：选中对象仍在加载、缺少有效包围盒或运行时目标，全部就绪后将自动显示组合 Gizmo。');
      return;
    }

    const signature = hierarchyGroupTransformSelection.status === 'blocked'
      ? `blocked:${hierarchyGroupTransformSelection.groupId}:${hierarchyGroupTransformSelection.lockedEntityIds.join('|')}`
      : `empty:${hierarchyGroupTransformSelection.groupId}`;
    if (hierarchyGroupStatusLogSignatureRef.current === signature) return;
    hierarchyGroupStatusLogSignatureRef.current = signature;

    if (hierarchyGroupTransformSelection.status === 'blocked') {
      pushLog(
        `选区群组变换已阻止：选中节点或文件夹后代中有 ${hierarchyGroupTransformSelection.lockedEntityIds.length} 个锁定对象。`,
      );
      return;
    }
    pushLog('当前选区没有可移动或旋转的场景对象，无法显示组合 Gizmo。');
  }, [hierarchyGroupTransformSelection, isRuntimePreview, pushLog, transformTool]);

  useEffect(() => {
    editModeThinInstancePlanRef.current = editModeThinInstancePlan;
    if (recordedEditModeThinInstancePlanComputationRef.current !== editModeThinInstancePlanComputation) {
      const previousMetrics = editModeThinInstancePlanPerformanceRef.current;
      editModeThinInstancePlanPerformanceRef.current = {
        planCount: previousMetrics.planCount + 1,
        lastDurationMs: editModeThinInstancePlanComputation.durationMs,
        maxDurationMs: Math.max(previousMetrics.maxDurationMs, editModeThinInstancePlanComputation.durationMs),
        entityCount: editModeThinInstancePlanComputation.entityCount,
        groupCount: editModeThinInstancePlan.groupCount,
        thinInstanceEntityCount: editModeThinInstancePlan.thinInstanceEntityCount,
      };
      recordedEditModeThinInstancePlanComputationRef.current = editModeThinInstancePlanComputation;
    }
    modelParameterSceneChangeRef.current = {
      entities: sceneDocument.entities,
      entityId: modelParameterSyncEntityId,
    };
    sceneDocumentRef.current = sceneDocument;
    editRuntimeSceneDocumentRef.current = editRuntimeSceneDocument;
    selectedEntityIdRef.current = selectedEntityId;
    entityArrayDialogRef.current = entityArrayDialog;
  }, [
    editModeThinInstancePlan,
    editModeThinInstancePlanComputation,
    editRuntimeSceneDocument,
    sceneDocument,
    modelParameterSyncEntityId,
    selectedEntityId,
    entityArrayDialog,
  ]);


  /** 源对象、单选状态或编辑模式失效时取消弹框，避免临时克隆悬挂。 */
  useEffect(() => {
    if (!entityArrayDialog) return;

    const source = sceneDocument.entities[entityArrayDialog.sourceEntityId];
    const parent = source?.parentId ? sceneDocument.entities[source.parentId] : null;
    const activeSelectionIds = hierarchySelectionIds.length > 0
      ? hierarchySelectionIds.filter((entityId) => Boolean(sceneDocument.entities[entityId]))
      : selectedEntityId
        ? [selectedEntityId]
        : [];
    const sourceInvalid = sceneDocument !== entityArrayDialog.sourceSceneDocument
      || !isShiftEntityArraySupported(source)
      || source?.locked
      || parent?.locked
      || selectedEntityId !== entityArrayDialog.sourceEntityId
      || activeSelectionIds.length !== 1
      || activeSelectionIds[0] !== entityArrayDialog.sourceEntityId;

    if (isRuntimePreview || sourceInvalid) closeEntityArrayDialog();
  }, [
    closeEntityArrayDialog,
    hierarchySelectionIds,
    isRuntimePreview,
    entityArrayDialog,
    sceneDocument,
    selectedEntityId,
  ]);

  /** 记录主指针左键按下位置与 Ctrl/Cmd 状态，用于区分多选点击和相机拖拽。 */
  function handleCanvasPointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (gizmoRef.current?.isPointerUsingGizmo()) {
      clickSnapshotRef.current = null;
      return;
    }

    clickSnapshotRef.current = createSceneModelSelectionPointerSnapshot({
      pointerId: event.pointerId,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      isPrimary: event.isPrimary,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    if (clickSnapshotRef.current) return;

    pauseHistoryReplay();
    autoPatrolPlaybackRef.current?.notifyManualInput();
    autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
  }

  /** 只累计真实指针位移；超过点击阈值后才把本次会话视为相机手动接管。 */
  function handleCanvasPointerMove(event: PointerEvent<HTMLCanvasElement>): void {
    const snapshot = clickSnapshotRef.current;
    if (!snapshot || snapshot.pointerId !== event.pointerId || (event.buttons & 1) === 0) return;

    const nextSnapshot = updateSceneModelSelectionPointerSnapshot(snapshot, event);
    clickSnapshotRef.current = nextSnapshot;
    const clickTolerancePx = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.selection.clickTolerancePx;
    if (snapshot.maxTravelDistancePx <= clickTolerancePx && nextSnapshot.maxTravelDistancePx > clickTolerancePx) {
      pauseHistoryReplay();
      autoPatrolPlaybackRef.current?.notifyManualInput();
      autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
    }
  }

  /** 左键释放时只依据真实指针轨迹判断点击，自动巡检产生的相机位姿变化不会取消拾取。 */
  function handleCanvasPointerUp(event: PointerEvent<HTMLCanvasElement>): void {
    const snapshot = clickSnapshotRef.current;
    if (!snapshot || snapshot.pointerId !== event.pointerId || snapshot.button !== event.button) return;
    clickSnapshotRef.current = null;
    if (gizmoRef.current?.isPointerUsingGizmo()) return;

    const selectionClick = completeSceneModelSelectionPointer(
      snapshot,
      event,
      DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.selection.clickTolerancePx,
    );
    if (!selectionClick) return;
    pauseHistoryReplay();

    if (!isRuntimePreview) {
      const patrolPick = runtimeRef.current?.pickAutoPatrolAtCanvasPoint(
        selectionClick.clientX,
        selectionClick.clientY,
        event.currentTarget,
      );
      if (patrolPick) {
        const state = useEditorStore.getState();
        state.setEnvironmentAdjustmentActive(false);
        if (selectionClick.toggleSelection) {
          const nextSelection = toggleHierarchyEntitySelection(
            state.scene,
            state.hierarchySelectionIds,
            state.scene.selectedEntityId,
            patrolPick.entityId,
          );
          state.selectHierarchyEntities(nextSelection.entityIds, nextSelection.primaryEntityId);
        } else {
          state.selectEntity(patrolPick.entityId);
          state.selectAutoPatrolWaypoint(patrolPick.waypointId);
        }
        return;
      }
    }

    if (isRuntimePreview) {
      const markerId = runtimeRef.current?.pickChartMarkerAtCanvasPoint(
        selectionClick.clientX, selectionClick.clientY, event.currentTarget,
      );
      if (markerId && handleChartMarkerClick(markerId)) return;
    }
    const previewModelHit = isRuntimePreview
      ? runtimeRef.current?.pickRuntimeModelHitAtCanvasPoint(
          selectionClick.clientX,
          selectionClick.clientY,
          event.currentTarget,
        ) ?? null
      : null;
    let pickedEntityId = isRuntimePreview
      ? previewModelHit?.entityId ?? null
      : runtimeRef.current?.pickEntityIdAtCanvasPoint(
          selectionClick.clientX,
          selectionClick.clientY,
          event.currentTarget,
        ) ?? null;
    // 货格反解改为对所有内置货格填充体做射线检测取最近命中：货架是框架，透过前排空格时
    // 模型拾取会命中后排货架（穿透到另一排），填充体深度比较保证最近一排的格子胜出。
    const cellHit = runtimeRef.current?.pickBuiltInSlotCellAtCanvasPoint(
      selectionClick.clientX,
      selectionClick.clientY,
      event.currentTarget,
    ) ?? null;
    let pickedCell: ClickEventBindingPickedCell | null = null;
    if (isRuntimePreview) {
      // 包围盒兜底命中（precise=false）是穿过框架空隙后的保守估计，不得压过货格解析命中：
      // 否则端面点击会先被货架前方巷道设备的包围盒截获，开口空洞永远点不中。
      if (cellHit && (!previewModelHit || !previewModelHit.precise || previewModelHit.entityId === cellHit.hostEntityId || cellHit.distance < previewModelHit.distance)) {
        pickedEntityId = cellHit.hostEntityId;
        pickedCell = { locatorEntityId: cellHit.locatorEntityId, row: cellHit.row, column: cellHit.column, layer: cellHit.layer };
        const state = useEditorStore.getState();
        const host = state.scene.entities[pickedEntityId];
        const assetCode = host?.components.modelAsset?.assetCode;
        const hostLabel = `${host?.name ?? pickedEntityId}${assetCode ? `（${assetCode}）` : ''}`;
        state.pushLog(`命中货格：${hostLabel} ${cellHit.row}-${cellHit.column}-${cellHit.layer}（排-列-层）`);
      }
    } else if (cellHit && pickedEntityId && cellHit.hostEntityId === pickedEntityId) {
      pickedCell = { locatorEntityId: cellHit.locatorEntityId, row: cellHit.row, column: cellHit.column, layer: cellHit.layer };
      const state = useEditorStore.getState();
      const host = state.scene.entities[pickedEntityId];
      const assetCode = host?.components.modelAsset?.assetCode;
      const hostLabel = `${host?.name ?? pickedEntityId}${assetCode ? `（${assetCode}）` : ''}`;
      state.pushLog(`命中货格：${hostLabel} ${cellHit.row}-${cellHit.column}-${cellHit.layer}（排-列-层）`);
    }
    // 运行预览下场景存在已注册设备类型的点击事件绑定时点击行为全接管：
    // 命中注册设备按事件效果执行（点击单元优先于点击，命中货格只高亮单格线框），
    // 点未注册模型无效果，点空白清除选中与单格高亮；Ctrl 多选同样被吞。
    if (isRuntimePreview) {
      const state = useEditorStore.getState();
      const resolution = resolveClickEventBindingClick(state.scene, pickedEntityId, pickedCell);
      if (resolution.kind !== 'pass-through') {
        if (resolution.kind === 'trigger-cell') {
          state.setEnvironmentAdjustmentActive(false);
          if (resolution.effects.includes('highlight')) {
            runtimeRef.current?.setLocalSlotHighlight(resolution.locatorEntityId, resolution.cell);
          } else {
            runtimeRef.current?.setLocalSlotHighlight('', null);
          }
          if (resolution.effects.includes('focus')) {
            const bounds = runtimeRef.current?.getLocatorCellWorldBounds(resolution.locatorEntityId, resolution.cell);
            if (bounds) {
              manualRoamRef.current?.setEnabled(false);
              viewportRef.current?.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS, useModelFocusAngle: false, radiusScale: CLICK_EVENT_FOCUS_RADIUS_SCALE });
            }
          }
        } else if (resolution.kind === 'trigger') {
          runtimeRef.current?.setLocalSlotHighlight('', null);
          state.setEnvironmentAdjustmentActive(false);
          if (resolution.effects.includes('highlight')) {
            state.selectEntity(resolution.entityId);
          }
          if (resolution.effects.includes('focus')) {
            state.requestSceneFocusForSelection([resolution.entityId], {
              animate: true,
              durationMs: CLICK_EVENT_FOCUS_DURATION_MS,
              useModelFocusAngle: false,
              radiusScale: CLICK_EVENT_FOCUS_RADIUS_SCALE,
            });
          }
        } else if (resolution.kind === 'clear') {
          runtimeRef.current?.setLocalSlotHighlight('', null);
          state.selectEntity(null);
        }
        return;
      }
    }
    if (selectionClick.toggleSelection) {
      if (!pickedEntityId) return;
      const state = useEditorStore.getState();
      state.setEnvironmentAdjustmentActive(false);
      const nextSelection = toggleHierarchyEntitySelection(
        state.scene,
        state.hierarchySelectionIds,
        state.scene.selectedEntityId,
        pickedEntityId,
      );
      state.selectHierarchyEntities(nextSelection.entityIds, nextSelection.primaryEntityId);
      return;
    }

    if (pickedEntityId) useEditorStore.getState().setEnvironmentAdjustmentActive(false);
    if (isRuntimePreview && pickedEntityId) {
      autoPatrolPlaybackRef.current?.triggerManualEventsForTarget(pickedEntityId);
    }
    selectEntity(pickedEntityId);
  }
  /** 指针流程被浏览器取消时丢弃点击快照，并取消尚未完成的 Shift 阵列拖拽。 */
  function handleCanvasPointerCancel(): void {
    clickSnapshotRef.current = null;
    gizmoRef.current?.cancelActiveDrag();
  }

  /** 滚轮缩放属于手动相机接管，立即暂停自动巡检。 */
  function handleCanvasWheel(_event: WheelEvent<HTMLCanvasElement>): void {
    pauseHistoryReplay();
    autoPatrolPlaybackRef.current?.notifyManualInput();
    autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
  }

  /** 仅当拖拽数据是可创建场景实体的资源时允许浏览器在 Scene 画布触发 drop。 */
  function handleCanvasDragOver(event: DragEvent<HTMLCanvasElement>): void {
    if (isRuntimePreview) return;

    if (event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE)) {
      event.preventDefault();
      const entityId = runtimeRef.current?.pickEntityIdAtCanvasPoint(event.clientX, event.clientY, event.currentTarget);
      const marker = entityId ? useEditorStore.getState().scene.entities[entityId]?.components.chartMarker : null;
      event.dataTransfer.dropEffect = marker ? 'copy' : 'none';
      return;
    }

    const hasSupportedPayload =
      event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE) ||
      event.dataTransfer.types.includes(SKYBOX_ASSET_DRAG_MIME_TYPE) ||
      event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE);
    if (!hasSupportedPayload) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /** 在鼠标释放位置把模型资产或内置资源投射到地面平面并创建场景实体。 */
  function handleCanvasDrop(event: DragEvent<HTMLCanvasElement>): void {
    if (isRuntimePreview) {
      event.preventDefault();
      clickSnapshotRef.current = null;
      return;
    }

    if (event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE)) {
      event.preventDefault();
      clickSnapshotRef.current = null;
      const source = decodeDataPlatformScreenDragPayload(event.dataTransfer.getData(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE));
      const entityId = runtimeRef.current?.pickEntityIdAtCanvasPoint(event.clientX, event.clientY, event.currentTarget);
      const state = useEditorStore.getState();
      if (!source || !entityId || !state.bindChartMarkerScreen(entityId, source)) {
        state.pushLog('请将有效大屏拖到未锁定的图表立标，或选中立标后拖到右侧大屏槽位。');
      } else state.selectEntity(entityId);
      return;
    }

    const placementPosition = runtimeRef.current?.getGroundPointAtCanvasPoint(
      event.clientX,
      event.clientY,
      event.currentTarget,
    ) ?? { x: 0, y: 0, z: 0 };

    const rawSkyboxPayload = event.dataTransfer.getData(SKYBOX_ASSET_DRAG_MIME_TYPE);
    const skyboxAsset = decodeSkyboxAssetDragPayload(rawSkyboxPayload);
    if (skyboxAsset) {
      event.preventDefault();
      clickSnapshotRef.current = null;
      const currentSkybox = getSceneSkyboxSettings(sceneDocument);
      placeSkybox(createSceneSkyboxFromAsset(skyboxAsset, currentSkybox), placementPosition);
      return;
    }

    const rawModelPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
    const modelAsset = decodeModelAssetDragPayload(rawModelPayload);
    if (modelAsset?.libraryKind === 'model') {
      event.preventDefault();
      clickSnapshotRef.current = null;
      importModelAsset(modelAsset, placementPosition);
      return;
    }

    const rawBuiltInPayload = event.dataTransfer.getData(BUILT_IN_ASSET_DRAG_MIME_TYPE);
    const builtInAsset = decodeBuiltInAssetDragPayload(rawBuiltInPayload);
    if (!builtInAsset) return;

    event.preventDefault();
    clickSnapshotRef.current = null;

    if (builtInAsset.kind === 'auto-patrol') {
      createAutoPatrol(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'manual-roam-spawn') {
      createManualRoamSpawn(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'model-generator') {
      createModelGenerator(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'click-event-binding') {
      createClickEventBinding(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'chart-marker') {
      createChartMarker(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'poi-effect') {
      createPoiEffect(builtInAsset.effectKind, placementPosition);
      return;
    }

    if (builtInAsset.kind === 'mesh') {
      const groundOffsetMeters = getBuiltInMeshGroundOffsetMeters(builtInAsset.meshKind);
      createMesh(builtInAsset.meshKind, {
        ...placementPosition,
        y: placementPosition.y + groundOffsetMeters,
      });
      return;
    }

    if (builtInAsset.kind === 'locator') {
      createLocator(placementPosition);
      return;
    }

    createLight(builtInAsset.lightKind, placementPosition);
  }

  useEffect(() => {
    if (!canvasRef.current) return;

    let viewport: BabylonViewport | null = null;
    let runtime: SceneRuntime | null = null;
    let gizmo: TransformGizmoController | null = null;
    let autoPatrolPlayback: AutoPatrolPlaybackController | null = null;
    let autoPatrolIntegration: AutoPatrolRuntimeIntegration | null = null;
    let manualRoam: ManualRoamRuntime | null = null;
    let unsubscribeAutoPatrolSnapshot: (() => void) | null = null;
    let unsubscribeManualRoamSnapshot: (() => void) | null = null;
    let mqttTelemetryClient: MqttStackerTelemetryClient | null = null;
    let performanceMonitor: ScenePerformanceMonitor | null = null;

    /** 处理 Babylon 运行状态回调，让渲染异常复用现有 scene-error 遮罩并在恢复时写入 Console。 */
    const handleRuntimeStatus = (status: BabylonViewportRuntimeStatus): void => {
      switch (status.type) {
        case 'context-lost':
          setViewportError(status.message);
          pushLog(status.message);
          break;
        case 'context-restored':
        case 'render-recovered':
          setViewportError(null);
          pushLog(status.message);
          break;
        case 'render-error':
          console.error('Scene View 渲染循环异常。', status.error);
          setViewportError(status.message);
          pushLog(status.message);
          break;
      }
    };

    setViewportError(null);

    try {
      viewport = createBabylonViewport(canvasRef.current, handleRuntimeStatus, {
        requireHardwareAcceleration: true,
        onLog: pushLog,
        initialSensitivity: useEditorStore.getState().scene.sceneSettings.sensitivity,
      });
      runtime = new SceneRuntime(
        viewport.scene,
        pushLog,
        (entityId) => {
          const currentRuntime = runtimeRef.current;
          if (!currentRuntime) return;
          const state = useEditorStore.getState();
          const groupSelection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
          const selectedEntityId = selectedEntityIdRef.current;
          if (selectedEntityId !== entityId && !groupSelection.entityIds.includes(entityId)) return;
          publishSelectedInspectorSpatialInfo(currentRuntime, selectedEntityId);
        },
        setEnvironmentRuntimeSnapshot,
      );
      autoPatrolIntegration = new AutoPatrolRuntimeIntegration({
        engine: viewport.engine,
        scopeId: (sceneDocumentRef.current ?? useEditorStore.getState().scene).id,
        getCamera: () => viewport?.camera ?? null,
        getInspectionContext: () => {
          const snapshot = autoPatrolPlayback?.getSnapshot();
          return {
            taskId: snapshot?.taskId ?? null,
            routeId: snapshot?.routeId ?? null,
            routeName: snapshot?.routeName ?? null,
          };
        },
        setHighlightedEntityIds: (entityIds) => {
          if (entityIds.length > 0) {
            runtime?.setLocalHighlightEntityIds(entityIds);
            return;
          }
          const state = useEditorStore.getState();
          const selectedIds = state.hierarchySelectionIds.length > 0
            ? state.hierarchySelectionIds.filter((entityId) => Boolean(state.scene.entities[entityId]))
            : state.scene.selectedEntityId
              ? [state.scene.selectedEntityId]
              : [];
          runtime?.setLocalHighlightEntityIds(selectedIds);
        },
        onError: (message, error) => {
          console.error(message, error);
          pushLog(message);
        },
      });
      setAutoPatrolRecordStore(autoPatrolIntegration.recordStore);
      autoPatrolPlayback = new AutoPatrolPlaybackController({
        readPose: () => viewport!.getCameraPose(),
        writePose: (pose) => viewport!.applyCameraPose(pose, { animate: false }),
        now: readScenePanelTimestampMs,
        wallNow: Date.now,
        subscribeFrame: (callback) => {
          const observer = viewport!.scene.onBeforeRenderObservable.add(callback);
          return () => viewport?.scene.onBeforeRenderObservable.remove(observer);
        },
        captureScreenshot: autoPatrolIntegration.captureScreenshot,
        onInspectionEvent: autoPatrolIntegration.onInspectionEvent,
        onInspectionScreenshot: autoPatrolIntegration.onInspectionScreenshot,
        onInspectionStart: autoPatrolIntegration.onInspectionStart,
        onInspectionTrajectory: autoPatrolIntegration.onInspectionTrajectory,
        onInspectionRecord: autoPatrolIntegration.onInspectionRecord,
      });
      autoPatrolPlayback.setRoutes(collectAutoPatrolPlaybackRoutes(sceneDocumentRef.current ?? useEditorStore.getState().scene));
      unsubscribeAutoPatrolSnapshot = autoPatrolPlayback.subscribe(() => {
        const snapshot = autoPatrolPlayback?.getSnapshot();
        if (!snapshot) return;
        useEditorStore.getState().setAutoPatrolPlaybackSnapshot(snapshot);
        (runtimeRef.current ?? runtime)?.setAutoPatrolPlaybackTarget(
          snapshot.routeId,
          snapshot.currentWaypointIndex,
        );
      });
      useEditorStore.getState().setAutoPatrolPlaybackSnapshot(autoPatrolPlayback.getSnapshot());
      manualRoam = new ManualRoamRuntime({
        scene: viewport.scene,
        engine: viewport.engine,
        camera: viewport.camera,
        canvas: canvasRef.current,
        avatarUrl: resolveManualRoamAvatarSource(useEditorStore.getState().scene),
        resolveSpawnPose: () => resolveManualRoamSpawnPose(
          sceneDocumentRef.current ?? useEditorStore.getState().scene,
        ),
        resolveCollisionBounds: createDefaultManualRoamCollisionBoundsResolver({
          getSceneDocument: () => editRuntimeSceneDocumentRef.current ?? useEditorStore.getState().scene,
          getRuntime: () => runtime,
          getMeshes: () => viewport!.scene.meshes,
        }),
        setOrbitControlsEnabled: viewport.setCameraControlsEnabled,
        onActivated: () => {
          viewport!.cancelCameraTransition('manual-input');
          viewport!.setCameraOrientation('orbit', { animate: false });
          autoPatrolPlayback?.stop();
          autoPatrolPreviewStartedRef.current = false;
        },
        onDeactivated: () => {
          const state = useEditorStore.getState();
          viewport!.setCameraProjection(state.cameraProjection);
          viewport!.setCameraOrientation(state.cameraOrientation, { animate: false });
        },
        onManualInput: () => {
          autoPatrolPlayback?.notifyManualInput();
          autoPatrolPlayback?.notifyCameraChangedWhilePaused();
        },
        onLog: pushLog,
      });
      unsubscribeManualRoamSnapshot = manualRoam.subscribe(() => {
        if (manualRoam) setManualRoamSnapshot(manualRoam.getSnapshot());
      });
      setManualRoamSnapshot(manualRoam.getSnapshot());
      gizmo = new TransformGizmoController(viewport.scene, {
        previewTransform: previewEntityTransform,
        commitTransform: commitEntityTransform,
        previewSubTransform: (entityId, waypointId, transform) => {
          (runtimeRef.current ?? runtime)?.previewAutoPatrolWaypointTransform(entityId, waypointId, transform);
        },
        commitSubTransform: (_entityId, waypointId, _before, after) => {
          useEditorStore.getState().commitSelectedAutoPatrolWaypointTransform(waypointId, after);
        },
        previewEnvironmentTransform,
        commitEnvironmentTransform,
        beginEntityArrayDrag: (context) => {
          const currentScene = sceneDocumentRef.current;
          const currentState = useEditorStore.getState();
          const source = currentScene?.entities[context.entityId];
          const parent = source?.parentId && currentScene ? currentScene.entities[source.parentId] : null;
          const activeSelectionIds = currentState.hierarchySelectionIds.length > 0
            ? currentState.hierarchySelectionIds.filter((entityId) => Boolean(currentScene?.entities[entityId]))
            : currentState.scene.selectedEntityId
              ? [currentState.scene.selectedEntityId]
              : [];

          if (runtimeModeRef.current !== 'edit') {
            pushLog('模型阵列已阻止：运行预览期间不能使用 Shift 拖拽阵列。');
            return null;
          }
          if (entityArrayDialogRef.current) {
            pushLog('模型阵列已阻止：请先完成或取消当前阵列弹框。');
            return null;
          }
          if (activeSelectionIds.length !== 1 || activeSelectionIds[0] !== context.entityId) {
            pushLog('模型阵列已阻止：Shift 拖拽仅支持单个选中的场景对象。');
            return null;
          }
          if (!isShiftEntityArraySupported(source) || source?.locked || parent?.locked) {
            pushLog('模型阵列已阻止：请选择一个未锁定且支持阵列的场景对象。');
            return null;
          }

          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime) return null;
          const geometry = currentRuntime.getEntityArrayGeometry(context.entityId, context.positiveDirection);
          if (!geometry) {
            pushLog('模型阵列已阻止：对象几何尚未加载完成或当前轴尺寸无效。');
            return null;
          }

          currentRuntime.clearEntityArrayPreview();
          return { spanMeters: geometry.spanMeters };
        },
        previewEntityArrayDrag: (update) => {
          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime) return;
          if (update.copyCount === 0) {
            currentRuntime.clearEntityArrayPreview();
            return;
          }
          currentRuntime.updateEntityArrayPreview(
            update.entityId,
            update.direction,
            update.copyCount,
            0,
          );
        },
        completeEntityArrayDrag: (update) => {
          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime || update.copyCount === 0) {
            currentRuntime?.clearEntityArrayPreview();
            return;
          }
          if (!currentRuntime.updateEntityArrayPreview(update.entityId, update.direction, update.copyCount, 0)) {
            currentRuntime.clearEntityArrayPreview();
            pushLog('模型阵列失败：无法创建阵列临时预览。');
            return;
          }

          const description = describeEntityArrayDrag(update);
          const dialog: EntityArrayDialogState = {
            sourceEntityId: update.entityId,
            sourceSceneDocument: sceneDocumentRef.current ?? useEditorStore.getState().scene,
            direction: update.direction,
            spanMeters: update.spanMeters,
            directionLabel: description.label,
            value: {
              copyCount: update.copyCount,
              direction: description.direction,
              spacingMeters: 0,
              assetNumberRule: '',
            },
            commitError: null,
          };
          entityArrayDialogRef.current = dialog;
          setEntityArrayDialog(dialog);
        },
        cancelEntityArrayDrag: () => {
          (runtimeRef.current ?? runtime)?.clearEntityArrayPreview();
        },
        beginGroupTranslation: (groupId) => {
          hierarchyGroupRotationRef.current = null;
          const state = useEditorStore.getState();
          const currentRuntime = runtimeRef.current ?? runtime;
          const selection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
          if (!currentRuntime) return false;
          if (runtimeModeRef.current !== 'edit') {
            pushLog('选区群组移动已阻止：运行预览期间不能编辑场景位置。');
            return false;
          }
          if (entityArrayDialogRef.current) {
            pushLog('选区群组移动已阻止：请先完成或取消当前阵列弹框。');
            return false;
          }
          if (selection.status !== 'ready' || selection.groupId !== groupId) {
            pushLog('选区群组移动已阻止：当前选区、成员或锁定状态已经变化。');
            return false;
          }
          if (!currentRuntime.isEntityGroupTransformReady(selection.entityIds, 'translate')) {
            pushLog('选区群组移动已阻止：选中对象仍在加载、缺少有效包围盒或运行时目标。');
            return false;
          }

          currentRuntime.clearEntityArrayPreview();
          if (!currentRuntime.beginFolderGroupTranslation(selection.entityIds, selection.beforePositions)) {
            pushLog('选区群组移动已阻止：没有可用于运行时预览的有效成员。');
            return false;
          }
          hierarchyGroupTranslationRef.current = {
            ...selection,
            sourceSceneDocument: state.scene,
          };
          return true;
        },
        previewGroupTranslation: (groupId, delta) => {
          const session = hierarchyGroupTranslationRef.current;
          if (!session || session.groupId !== groupId) return;
          (runtimeRef.current ?? runtime)?.updateFolderGroupTranslation(delta);
        },
        commitGroupTranslation: (groupId, delta) => {
          const currentRuntime = runtimeRef.current ?? runtime;
          const session = hierarchyGroupTranslationRef.current;
          hierarchyGroupTranslationRef.current = null;
          if (!currentRuntime || !session || session.groupId !== groupId) {
            currentRuntime?.cancelFolderGroupTranslation();
            return;
          }

          const committed = commitHierarchyGroupTranslation({
            sourceSceneDocument: session.sourceSceneDocument,
            groupId: session.groupId,
            entityIds: session.entityIds,
            beforePositions: session.beforePositions,
            delta,
          });
          if (committed) currentRuntime.finishFolderGroupTranslation();
          else currentRuntime.cancelFolderGroupTranslation();
        },
        cancelGroupTranslation: () => {
          hierarchyGroupTranslationRef.current = null;
          (runtimeRef.current ?? runtime)?.cancelFolderGroupTranslation();
        },
        beginGroupRotation: (groupId) => {
          hierarchyGroupTranslationRef.current = null;
          const state = useEditorStore.getState();
          const currentRuntime = runtimeRef.current ?? runtime;
          const selection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
          if (!currentRuntime) return false;
          if (runtimeModeRef.current !== 'edit') {
            pushLog('选区群组旋转已阻止：运行预览期间不能编辑场景 Transform。');
            return false;
          }
          if (entityArrayDialogRef.current) {
            pushLog('选区群组旋转已阻止：请先完成或取消当前阵列弹框。');
            return false;
          }
          if (selection.status !== 'ready' || selection.groupId !== groupId) {
            pushLog('选区群组旋转已阻止：当前选区、成员或锁定状态已经变化。');
            return false;
          }
          if (!currentRuntime.isEntityGroupTransformReady(selection.entityIds, 'rotate')) {
            pushLog('选区群组旋转已阻止：选中对象仍在加载、缺少有效包围盒或运行时目标。');
            return false;
          }

          currentRuntime.clearEntityArrayPreview();
          if (!currentRuntime.beginFolderGroupRotation(selection.entityIds, selection.beforeTransforms)) {
            pushLog('选区群组旋转已阻止：没有可用于运行时预览的有效成员。');
            return false;
          }
          hierarchyGroupRotationRef.current = {
            ...selection,
            sourceSceneDocument: state.scene,
          };
          return true;
        },
        previewGroupRotation: (groupId, deltaMatrix) => {
          const session = hierarchyGroupRotationRef.current;
          if (!session || session.groupId !== groupId) return;
          (runtimeRef.current ?? runtime)?.updateFolderGroupRotation(deltaMatrix);
        },
        commitGroupRotation: (groupId, deltaMatrix) => {
          const currentRuntime = runtimeRef.current ?? runtime;
          const session = hierarchyGroupRotationRef.current;
          hierarchyGroupRotationRef.current = null;
          if (!currentRuntime || !session || session.groupId !== groupId) {
            currentRuntime?.cancelFolderGroupRotation();
            return;
          }

          currentRuntime.updateFolderGroupRotation(deltaMatrix);
          const afterTransforms = currentRuntime.getFolderGroupRotationTransforms();
          if (!afterTransforms) {
            currentRuntime.cancelFolderGroupRotation();
            return;
          }
          const committed = commitHierarchyGroupRotation({
            sourceSceneDocument: session.sourceSceneDocument,
            groupId: session.groupId,
            entityIds: session.entityIds,
            beforeTransforms: session.beforeTransforms,
            afterTransforms,
          });
          if (committed) currentRuntime.finishFolderGroupRotation();
          else currentRuntime.cancelFolderGroupRotation();
        },
        cancelGroupRotation: () => {
          hierarchyGroupRotationRef.current = null;
          (runtimeRef.current ?? runtime)?.cancelFolderGroupRotation();
        },
      });
      mqttTelemetryClient = new MqttStackerTelemetryClient(pushLog);
    } catch (error) {
      console.error('Scene View 渲染引擎初始化失败。', error);
      mqttTelemetryClient?.dispose();
      unsubscribeManualRoamSnapshot?.();
      manualRoam?.dispose();
      unsubscribeAutoPatrolSnapshot?.();
      autoPatrolPlayback?.dispose();
      autoPatrolIntegration?.dispose();
      setAutoPatrolRecordStore(null);
      gizmo?.dispose();
      runtime?.dispose();
      viewport?.dispose();
      setViewportCamera(null);
      setViewportError(`Scene View 渲染引擎初始化失败：${getErrorMessage(error)}`);
      stopRuntimePreview();
      return;
    }

    const initializedViewport = viewport;
    const initializedRuntime = runtime;
    const initializedGizmo = gizmo;
    const initializedAutoPatrolPlayback = autoPatrolPlayback;
    const initializedAutoPatrolIntegration = autoPatrolIntegration;
    const initializedManualRoam = manualRoam;
    const initializedUnsubscribeAutoPatrolSnapshot = unsubscribeAutoPatrolSnapshot;
    const initializedUnsubscribeManualRoamSnapshot = unsubscribeManualRoamSnapshot;
    const initializedMqttTelemetryClient = mqttTelemetryClient;
    viewportRef.current = viewport;
    setViewportCamera(viewport.camera);
    runtimeRef.current = runtime;
    gizmoRef.current = gizmo;
    autoPatrolPlaybackRef.current = autoPatrolPlayback;
    manualRoamRef.current = manualRoam;
    mqttTelemetryClientRef.current = mqttTelemetryClient;

    try {
      performanceMonitor = new ScenePerformanceMonitor(viewport.engine, viewport.scene, {
        getRuntimeMetrics: () => runtimeRef.current?.getPerformanceMetrics() ?? initializedRuntime.getPerformanceMetrics(),
        getEditThinInstancePlanMetrics: () => editModeThinInstancePlanPerformanceRef.current,
        getSceneFocusMetrics: () => sceneFocusPerformanceRef.current,
      });
      performanceMonitorRef.current = performanceMonitor;
      performanceMonitor.start(setPerformanceSnapshot);
    } catch (error) {
      console.warn('Scene View 性能监控初始化失败，渲染功能不受影响。', error);
      pushLog(`Scene View 性能监控初始化失败：${getErrorMessage(error)}`);
    }

    const initializedPerformanceMonitor = performanceMonitor;
    const canvas = canvasRef.current;
    // Project 内容会改变中列 auto 行高；元素自身尺寸变化不会触发 window.resize。
    const resize = () => initializedViewport.resize();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(resize);
    if (canvas) resizeObserver?.observe(canvas);
    const cancelActiveGizmoDrag = () => initializedGizmo.cancelActiveDrag();
    window.addEventListener('resize', resize);
    window.addEventListener('blur', cancelActiveGizmoDrag);
    resize();

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', cancelActiveGizmoDrag);
      initializedPerformanceMonitor?.dispose();
      initializedMqttTelemetryClient?.dispose();
      initializedUnsubscribeManualRoamSnapshot?.();
      initializedManualRoam?.dispose();
      initializedUnsubscribeAutoPatrolSnapshot?.();
      initializedAutoPatrolPlayback?.dispose();
      initializedAutoPatrolIntegration?.dispose();
      setAutoPatrolRecordStore(null);
      initializedGizmo.dispose();
      initializedRuntime.dispose();
      initializedViewport.dispose();
      viewportRef.current = null;
      setViewportCamera(null);
      runtimeRef.current = null;
      gizmoRef.current = null;
      autoPatrolPlaybackRef.current = null;
      manualRoamRef.current = null;
      mqttTelemetryClientRef.current = null;
      performanceMonitorRef.current = null;
      setPerformanceSnapshot(null);
      setSelectedModelMeasurement(null);
      setSelectedGroupSpatialInfo(null);
    };
  }, [
    previewEntityTransform,
    commitEntityTransform,
    previewEnvironmentTransform,
    commitEnvironmentTransform,
    commitHierarchyGroupRotation,
    commitHierarchyGroupTranslation,
    publishSelectedInspectorSpatialInfo,
    pushLog,
    setEnvironmentRuntimeSnapshot,
    setSelectedGroupSpatialInfo,
    setSelectedModelMeasurement,
    stopRuntimePreview,
  ]);

  useEffect(() => {
    if (manualRoamSceneSessionIdRef.current === sceneSessionId) return;
    manualRoamSceneSessionIdRef.current = sceneSessionId;
    manualRoamRef.current?.invalidateSpawn();
  }, [sceneSessionId]);

  /** 运行预览中删除出生点后立即退出漫游，避免面板已隐藏但相机仍被占用。 */
  useEffect(() => {
    if (hasManualRoamSpawn) return;
    if (!manualRoamRef.current?.getSnapshot().enabled) return;
    manualRoamRef.current.setEnabled(false);
  }, [hasManualRoamSpawn]);

  useEffect(() => {
    manualRoamRef.current?.setAvatarUrl(resolveManualRoamAvatarSource(sceneDocument));
  }, [sceneDocument]);

  /** 执行 Store 发起的候选环境事务；旧环境会保留到候选加载成功。 */
  useEffect(() => {
    if (!environmentApplyRequest) return;

    const runtime = runtimeRef.current;
    if (!runtime) {
      failEnvironmentApply(environmentApplyRequest.id, 'Scene View 尚未就绪，无法加载环境模型。');
      return;
    }

    let active = true;
    void runtime.applyEnvironment(environmentApplyRequest.runtimeEnvironment ?? environmentApplyRequest.environment, {
      requestId: environmentApplyRequest.id,
      autoAlign: environmentApplyRequest.autoAlign,
    }).then((result) => {
      if (active) completeEnvironmentApply(environmentApplyRequest.id, result);
    }).catch((error) => {
      if (!active) return;
      const message = getErrorMessage(error);
      failEnvironmentApply(environmentApplyRequest.id, message);
    });

    return () => {
      active = false;
    };
  }, [environmentApplyRequest, completeEnvironmentApply, failEnvironmentApply]);

  /** 参数值变化走单实体同步；其它文档内容变化才进入完整 SceneRuntime 同步。 */
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;
    if (isRuntimePreview || runtimeModeRef.current !== 'edit') return;

    gizmo.cancelActiveGroupDrag();
    if (modelParameterSyncEntityId) {
      runtime.syncModelParameters(
        editRuntimeSceneDocument,
        modelParameterSyncEntityId,
        useEditorStore.getState().hierarchySelectionIds,
        { modelArrayIdentityMode: 'visual' },
      );
    } else {
      runtime.sync(
        editRuntimeSceneDocument,
        useEditorStore.getState().hierarchySelectionIds,
        { modelArrayIdentityMode: 'visual' },
      );
    }
    attachCurrentSelectionGizmo(runtime, gizmo);
    publishSelectedInspectorSpatialInfo(runtime, selectedEntityIdRef.current);
  }, [
    editRuntimeSceneDocument.entityIds,
    editRuntimeSceneDocument.entities,
    modelParameterSyncEntityId,
    isRuntimePreview,
    attachCurrentSelectionGizmo,
    publishSelectedInspectorSpatialInfo,
  ]);

  /**
   * 场景打开或模型资源修订变化后，持续观察真实加载与 thinInstance 指标。
   * 连续两个采样周期一致才解除蒙版，避免脚本微任务刚结束但最终 Geometry 尚未提交。
   */
  useEffect(() => {
    beginScenePreparation(sceneSessionId);
    setSceneRuntimeNaturallyReady(false);
    sceneRuntimeReadinessStableSamplesRef.current = 0;
    sceneRuntimeReadinessStartedAtRef.current = readScenePanelTimestampMs();
    sceneRuntimeTimeoutLoggedRef.current = false;
    const modelEntityIds = sceneDocument.entityIds.filter((entityId) => {
      const entity = editRuntimeSceneDocument.entities[entityId];
      return Boolean(entity?.components.modelAsset && !entity.components.modelArrayInstance);
    });
    const expectedBatchedEntities = countExpectedSceneBatchedEntities(
      sceneDocument.entityIds,
      editRuntimeSceneDocument.entities,
    );
    let active = true;
    let lastSignature = '';
    let intervalId: number | null = null;

    const stopReadinessPolling = (): void => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const sampleReadiness = (): void => {
      if (!active) return;
      const preparationState = getScenePreparationSnapshot();
      if (
        preparationState.sceneSessionId !== sceneSessionId
        || (preparationState.completed && !preparationState.runtime.forcedSettled)
      ) {
        stopReadinessPolling();
        return;
      }
      if (preparationState.assetRefreshStatus !== 'settled') {
        setSceneRuntimeNaturallyReady(false);
        sceneRuntimeReadinessStableSamplesRef.current = 0;
        sceneRuntimeReadinessStartedAtRef.current = readScenePanelTimestampMs();
        sceneRuntimeTimeoutLoggedRef.current = false;
        lastSignature = '';
        return;
      }
      if (preparationState.runtime.generation !== sceneRuntimeReadinessGeneration) {
        sceneRuntimeReadinessStableSamplesRef.current = 0;
        sceneRuntimeReadinessStartedAtRef.current = readScenePanelTimestampMs();
        sceneRuntimeTimeoutLoggedRef.current = false;
        lastSignature = '';
      }

      const settleRuntimeAfterTimeout = (): void => {
        if (sceneRuntimeTimeoutLoggedRef.current) return;
        sceneRuntimeTimeoutLoggedRef.current = true;
        pushLog(SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING);
        settleSceneRuntimeWithWarning(sceneSessionId, SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING);
      };
      const runtime = runtimeRef.current;
      if (!runtime) {
        reportSceneRuntimeProgress(sceneSessionId, {
          generation: sceneRuntimeReadinessGeneration,
          totalModels: modelEntityIds.length,
          settledModels: 0,
          expectedBatchedEntities,
          batchedEntities: 0,
          stable: false,
        });
        if (hasScenePreparationRuntimeTimedOut(
          sceneRuntimeReadinessStartedAtRef.current,
          readScenePanelTimestampMs(),
        )) {
          settleRuntimeAfterTimeout();
        }
        return;
      }

      let settledModels = 0;
      for (const entityId of modelEntityIds) {
        if (runtime.getModelMeasurement(entityId).status !== 'loading') settledModels += 1;
      }
      const runtimeMetrics = runtime.getPerformanceMetrics();
      const batchedEntities = Math.min(expectedBatchedEntities, runtimeMetrics.modelArrayBatchEntityCount);
      const readyNow = settledModels >= modelEntityIds.length
        && batchedEntities >= expectedBatchedEntities;
      const signature = `${settledModels}:${batchedEntities}:${runtimeMetrics.modelArrayBatchMeshCount}`;
      sceneRuntimeReadinessStableSamplesRef.current = readyNow && signature === lastSignature
        ? sceneRuntimeReadinessStableSamplesRef.current + 1
        : readyNow ? 1 : 0;
      lastSignature = signature;
      const stable = sceneRuntimeReadinessStableSamplesRef.current >= 2;
      if (stable) setSceneRuntimeNaturallyReady(true);

      reportSceneRuntimeProgress(sceneSessionId, {
        generation: sceneRuntimeReadinessGeneration,
        totalModels: modelEntityIds.length,
        settledModels,
        expectedBatchedEntities,
        batchedEntities,
        stable,
      });
      if (stable && preparationState.runtime.forcedSettled) stopReadinessPolling();

      if (
        !stable
        && hasScenePreparationRuntimeTimedOut(
          sceneRuntimeReadinessStartedAtRef.current,
          readScenePanelTimestampMs(),
        )
      ) {
        settleRuntimeAfterTimeout();
      }
    };

    const startReadinessPolling = (): void => {
      if (!active || intervalId !== null) return;
      const preparationState = getScenePreparationSnapshot();
      if (
        active
        && preparationState.sceneSessionId === sceneSessionId
        && (!preparationState.completed || preparationState.runtime.forcedSettled)
      ) {
        intervalId = window.setInterval(sampleReadiness, 250);
      }
    };

    const unsubscribeScenePreparation = subscribeScenePreparation(() => {
      const preparationState = getScenePreparationSnapshot();
      if (
        preparationState.sceneSessionId !== sceneSessionId
        || (preparationState.completed && !preparationState.runtime.forcedSettled)
      ) {
        stopReadinessPolling();
        return;
      }
      startReadinessPolling();
    });

    sampleReadiness();
    startReadinessPolling();
    return () => {
      active = false;
      unsubscribeScenePreparation();
      stopReadinessPolling();
    };
  }, [
    editRuntimeSceneDocument.entities,
    sceneDocument.entityIds,
    sceneRuntimeReadinessGeneration,
    sceneSessionId,
    pushLog,
  ]);

  /** Hierarchy 选区变化只刷新目标表现、Gizmo 和 Inspector 测量，不重新扫描全场景。 */
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;
    if (isRuntimePreview) {
      runtime.syncSelection(editRuntimeSceneDocument, hierarchySelectionIds);
      gizmo.attachToTarget(null, null);
      publishSelectedInspectorSpatialInfo(runtime, selectedEntityId);
      return;
    }
    if (runtimeModeRef.current !== 'edit') return;

    gizmo.cancelActiveGroupDrag();
    runtime.syncSelection(editRuntimeSceneDocument, hierarchySelectionIds);
    attachCurrentSelectionGizmo(runtime, gizmo);
    publishSelectedInspectorSpatialInfo(runtime, selectedEntityId);
  }, [
    attachCurrentSelectionGizmo,
    editRuntimeSceneDocument,
    hierarchySelectionIds,
    selectedEntityId,
    selectedAutoPatrolWaypointId,
    isRuntimePreview,
    publishSelectedInspectorSpatialInfo,
  ]);

  /** 把 Inspector 中的群组绝对位置/旋转转换为现有原子群组事务。 */
  useEffect(() => {
    const request = groupInspectorTransformRequest;
    if (!request) return;

    const runtime = runtimeRef.current;
    if (!runtime) return;

    try {
      const state = useEditorStore.getState();
      const selection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
      if (state.runtimeMode !== 'edit') {
        pushLog('群组空间信息修改已阻止：运行预览期间不能编辑场景。');
        return;
      }
      if (entityArrayDialogRef.current) {
        pushLog('群组空间信息修改已阻止：请先完成或取消当前阵列弹框。');
        return;
      }
      if (selection.status !== 'ready' || selection.groupId !== request.groupId) {
        pushLog('群组空间信息修改已取消：当前选区、成员或锁定状态已经变化。');
        return;
      }

      const spatialInfo = runtime.getEntityGroupSpatialInfo(selection.entityIds);
      if (spatialInfo.status !== 'ready') {
        pushLog('群组空间信息修改已阻止：选中对象仍在加载或缺少完整世界包围盒。');
        return;
      }

      if (request.field === 'position') {
        const delta = createGroupPositionDelta(spatialInfo.center, request.axis, request.value);
        if (!delta) {
          pushLog('群组位置修改已取消：目标位置无效。');
          return;
        }
        if (Math.abs(delta.x) <= 1e-9 && Math.abs(delta.y) <= 1e-9 && Math.abs(delta.z) <= 1e-9) return;

        commitHierarchyGroupTranslation({
          sourceSceneDocument: state.scene,
          groupId: selection.groupId,
          entityIds: selection.entityIds,
          beforePositions: selection.beforePositions,
          delta,
        });
        return;
      }

      if (!runtime.isEntityGroupTransformReady(selection.entityIds, 'rotate')) {
        pushLog('群组旋转修改已阻止：选中对象仍在加载或缺少运行时旋转目标。');
        return;
      }
      const currentRotation = resolveManualRoamGroupRotationReference(state.scene, selection.entityIds);
      if (!currentRotation) {
        pushLog('群组旋转修改已取消：无法读取参考对象旋转。');
        return;
      }
      const targetRotation = { ...currentRotation, [request.axis]: request.value };
      if (Math.abs(targetRotation[request.axis] - currentRotation[request.axis]) <= 1e-9) return;

      const deltaMatrix = createEntityGroupRotationDeltaMatrix(
        spatialInfo.center,
        currentRotation,
        targetRotation,
      );
      if (!deltaMatrix) {
        pushLog('群组旋转修改已取消：目标旋转无效。');
        return;
      }

      runtime.clearEntityArrayPreview();
      if (!runtime.beginFolderGroupRotation(selection.entityIds, selection.beforeTransforms)) {
        pushLog('群组旋转修改已阻止：没有可用于运行时预览的有效成员。');
        return;
      }
      runtime.updateFolderGroupRotation(deltaMatrix);
      const afterTransforms = runtime.getFolderGroupRotationTransforms();
      if (!afterTransforms) {
        runtime.cancelFolderGroupRotation();
        pushLog('群组旋转修改已取消：无法计算目标 Transform。');
        return;
      }

      const committed = commitHierarchyGroupRotation({
        sourceSceneDocument: state.scene,
        groupId: selection.groupId,
        entityIds: selection.entityIds,
        beforeTransforms: selection.beforeTransforms,
        afterTransforms,
      });
      if (committed) runtime.finishFolderGroupRotation();
      else runtime.cancelFolderGroupRotation();
    } finally {
      consumeGroupInspectorTransformRequest(request.id);
    }
  }, [
    commitHierarchyGroupRotation,
    commitHierarchyGroupTranslation,
    consumeGroupInspectorTransformRequest,
    groupInspectorTransformRequest,
    pushLog,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    const client = mqttTelemetryClientRef.current;
    if (!runtime || !gizmo || !client) return;
    if (runtimeModeRef.current === runtimeMode) return;
    runtimeModeRef.current = runtimeMode;

    // 运行模式只切换脚本、动画和遥测生命周期，保留已完成的 Geometry 合批及逻辑实体参数。
    if (!isRuntimePreview) {
      manualRoamRef.current?.setEnabled(false);
      client.dispose();
      gizmo.cancelActiveDrag();
      runtime.endTelemetryPreview();
      attachCurrentSelectionGizmo(runtime, gizmo);
      publishSelectedInspectorSpatialInfo(runtime, selectedEntityIdRef.current);
      return;
    }

    try {
      const currentSceneDocument = sceneDocumentRef.current;
      if (!currentSceneDocument) return;
      gizmo.cancelActiveDrag();
      gizmo.attachToTarget(null, null);
      runtime.clearFolderGroupGizmoTarget();
      runtime.beginTelemetryPreview();
      client.updateConfig(mqttConfig);
      publishSelectedInspectorSpatialInfo(runtime, selectedEntityIdRef.current);
      void runtime.handleFetchDriveEvent(currentSceneDocument.fetchConfig);
    } catch (error) {
      const message = getErrorMessage(error);
      pushLog(`运行预览初始化失败：${message}`);
      stopRuntimePreview();
    }
  }, [attachCurrentSelectionGizmo, runtimeMode, isRuntimePreview, mqttConfig, publishSelectedInspectorSpatialInfo, pushLog, stopRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) return;
    mqttTelemetryClientRef.current?.updateConfig(mqttConfig);
  }, [mqttConfig, isRuntimePreview]);

  /** 环境调整态优先占用 Gizmo；进入预览或退出调整时恢复普通实体选区。 */
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;

    const active = environmentAdjustmentActive && !isRuntimePreview;
    if (isRuntimePreview) {
      gizmo.attachToEnvironmentTarget(null);
      runtime.setEnvironmentAdjustmentActive(false);
      if (environmentAdjustmentActive) setEnvironmentAdjustmentActive(false);
      return;
    }

    if (active) {
      runtime.setEnvironmentAdjustmentActive(true);
      attachCurrentSelectionGizmo(runtime, gizmo);
    } else {
      // 先让 Gizmo 完成或回滚当前拖动，再冻结环境静态矩阵。
      attachCurrentSelectionGizmo(runtime, gizmo);
      runtime.setEnvironmentAdjustmentActive(false);
    }
    gizmo.setTool(transformTool);
    gizmo.setTransformSpace(transformSpace);
  }, [
    attachCurrentSelectionGizmo,
    environmentAdjustmentActive,
    environmentRuntimePhase,
    isRuntimePreview,
    setEnvironmentAdjustmentActive,
    transformSpace,
    transformTool,
  ]);

  useEffect(() => {
    if (!isRuntimePreview) gizmoRef.current?.setTool(transformTool);
  }, [transformTool, isRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) gizmoRef.current?.setTransformSpace(transformSpace);
  }, [transformSpace, isRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) gizmoRef.current?.setSnapSettings(snapSettings);
  }, [snapSettings, isRuntimePreview]);

  /** 场景路线变化时刷新播放控制器；活动路线被删除、禁用或修改会由控制器安全停止。 */
  useEffect(() => {
    autoPatrolPlaybackRef.current?.setRoutes(autoPatrolRoutes);
  }, [autoPatrolRoutes]);

  /** 消费 F1 录制和 Inspector 聚焦请求。 */
  useEffect(() => {
    if (!autoPatrolCameraRequest) return;
    const viewport = viewportRef.current;
    if (autoPatrolCameraRequest.kind === 'capture') {
      const pose = viewport?.getCameraPose();
      const entity = sceneDocument.entities[autoPatrolCameraRequest.entityId];
      const component = entity?.components.autoPatrol;
      if (viewport && pose && entity && component && !autoPatrolCameraRequest.waypointId) {
        const previousWaypoint = component.waypoints.at(-1);
        if (previousWaypoint) {
          const capturedWaypoint = createAutoPatrolWaypointFromWorldPose(
            pose,
            entity.components.transform,
            undefined,
            { eyeHeightMeters: AUTO_PATROL_EYE_HEIGHT_METERS },
          );
          const proximityIssue = validateAutoPatrolRoute(
            { waypoints: [previousWaypoint, capturedWaypoint] },
            entity.components.transform,
          ).find((issue) => issue.code === 'waypoints-too-close');
          if (proximityIssue) {
            consumeAutoPatrolCameraRequest(
              autoPatrolCameraRequest.id,
              undefined,
              `无法添加点位：${proximityIssue.message}`,
            );
            return;
          }
        }
      }
      consumeAutoPatrolCameraRequest(autoPatrolCameraRequest.id, pose);
      return;
    }

    const entity = sceneDocument.entities[autoPatrolCameraRequest.entityId];
    const waypoint = entity?.components.autoPatrol?.waypoints.find((item) => (
      item.id === autoPatrolCameraRequest.waypointId
    ));
    if (viewport && entity && waypoint) {
      manualRoamRef.current?.setEnabled(false);
      autoPatrolPlaybackRef.current?.stop();
      viewport.applyCameraPose(
        getAutoPatrolWaypointWorldPose(waypoint, entity.components.transform),
        { animate: true },
      );
    }
    consumeAutoPatrolCameraRequest(autoPatrolCameraRequest.id);
  }, [autoPatrolCameraRequest, consumeAutoPatrolCameraRequest, sceneDocument.entities]);

  /** Inspector 和悬浮控制器通过 Store 发出一次性播放命令。 */
  useEffect(() => {
    if (!autoPatrolPlaybackRequest) return;
    const controller = autoPatrolPlaybackRef.current;
    if (!controller) return;
    if (
      (autoPatrolPlaybackRequest.action === 'start'
        || autoPatrolPlaybackRequest.action === 'resume')
      && !isRuntimePreview
    ) {
      consumeAutoPatrolPlaybackRequest(autoPatrolPlaybackRequest.id);
      return;
    }
    if (
      (autoPatrolPlaybackRequest.action === 'start'
        || autoPatrolPlaybackRequest.action === 'resume')
      && !sceneReadyForAutoPatrol
    ) return;
    if (
      autoPatrolPlaybackRequest.action === 'start'
      || autoPatrolPlaybackRequest.action === 'resume'
      || autoPatrolPlaybackRequest.action === 'pause'
      || autoPatrolPlaybackRequest.action === 'stop'
      || autoPatrolPlaybackRequest.action === 'emergency-stop'
      || autoPatrolPlaybackRequest.action === 'return'
    ) {
      autoPatrolPreviewAutoStartCancelledRef.current = true;
    }
    pauseHistoryReplay();

    let result: { ok: true } | { ok: false; error: string } | null = null;
    switch (autoPatrolPlaybackRequest.action) {
      case 'start':
        manualRoamRef.current?.setEnabled(false);
        result = autoPatrolPlaybackRequest.routeId
          ? controller.start(autoPatrolPlaybackRequest.routeId)
          : { ok: false, error: '未选择巡检路线。' };
        break;
      case 'pause':
        result = controller.pause(false);
        break;
      case 'resume':
        manualRoamRef.current?.setEnabled(false);
        result = controller.resume();
        break;
      case 'skip':
        result = controller.skipCurrentWaypoint();
        break;
      case 'stop':
        controller.stop();
        break;
      case 'emergency-stop':
        controller.emergencyStop();
        break;
      case 'return':
        result = controller.returnToStart();
        break;
      case 'set-rate':
        result = controller.setPlaybackRate(
          typeof autoPatrolPlaybackRequest.payload === 'number'
            ? autoPatrolPlaybackRequest.payload
            : Number.NaN,
        );
        break;
      case 'set-view': {
        const viewMode = autoPatrolPlaybackRequest.payload;
        if (viewMode === 'first-person' || viewMode === 'third-person' || viewMode === 'orbit') {
          manualRoamRef.current?.setEnabled(false);
          result = controller.setManualViewMode(viewMode);
        } else {
          result = { ok: false, error: '巡检视角参数无效。' };
        }
        break;
      }
      case 'resume-auto-view':
        result = controller.resumeAutomaticView();
        break;
      case 'trigger-event':
        result = typeof autoPatrolPlaybackRequest.payload === 'string'
          ? controller.triggerManualEvent(autoPatrolPlaybackRequest.payload)
          : { ok: false, error: '手动巡检事件参数无效。' };
        break;
    }
    if (result && !result.ok) pushLog(result.error);
    consumeAutoPatrolPlaybackRequest(autoPatrolPlaybackRequest.id);
  }, [
    autoPatrolPlaybackRequest,
    consumeAutoPatrolPlaybackRequest,
    isRuntimePreview,
    pauseHistoryReplay,
    pushLog,
    sceneReadyForAutoPatrol,
  ]);

  /** 每次进入运行预览只尝试一次自动启动；退出时停止且保留当前视角。 */
  useEffect(() => {
    const controller = autoPatrolPlaybackRef.current;
    if (!controller) return;
    if (!isRuntimePreview) {
      if (autoPatrolPreviewStartedRef.current) controller.stop();
      autoPatrolPreviewStartedRef.current = false;
      autoPatrolPreviewAutoStartCancelledRef.current = false;
      return;
    }
    if (autoPatrolPreviewStartedRef.current) return;
    if (autoPatrolPreviewAutoStartCancelledRef.current) return;
    if (!sceneReadyForAutoPatrol) return;
    autoPatrolPreviewStartedRef.current = true;
    controller.setRoutes(autoPatrolRoutes);
    const route = findAutoStartPatrolRoute(autoPatrolRoutes);
    if (!route) return;
    const result = controller.start(route.entityId);
    if (!result.ok) pushLog(result.error);
  }, [autoPatrolRoutes, isRuntimePreview, pushLog, sceneReadyForAutoPatrol]);

  /** 启用或关闭运行预览手动漫游；场景没有出生点 POI 时拒绝启用。 */
  function handleManualRoamEnabled(enabled: boolean): void {
    if (enabled && !hasManualRoamSpawn) return;
    if (enabled) {
      autoPatrolPreviewAutoStartCancelledRef.current = true;
      const pendingRequest = useEditorStore.getState().autoPatrolPlaybackRequest;
      if (pendingRequest?.action === 'start' || pendingRequest?.action === 'resume') {
        consumeAutoPatrolPlaybackRequest(pendingRequest.id);
      }
      pauseHistoryReplay();
    }
    manualRoamRef.current?.setEnabled(enabled);
  }

  function handleManualRoamViewMode(viewMode: ManualRoamViewMode): void {
    manualRoamRef.current?.setViewMode(viewMode);
  }

  function handleManualRoamLocomotionMode(mode: ManualRoamLocomotionMode): void {
    manualRoamRef.current?.setLocomotionMode(mode);
  }

  function handleManualRoamConfig(patch: Partial<ManualRoamConfig>): void {
    manualRoamRef.current?.updateConfig(patch);
  }

  function handleManualRoamTouchAction(action: ManualRoamTouchAction, pressed: boolean): void {
    manualRoamRef.current?.setTouchAction(action, pressed);
  }

  /** F1 只在非输入态、编辑模式且选中巡检路线时录制或覆盖当前相机视角。 */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isScenePreparationActive()) {
        event.preventDefault();
        return;
      }
      const target = event.target;
      const inputFocused = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (inputFocused || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'F1') {
        const state = useEditorStore.getState();
        const entity = state.scene.selectedEntityId ? state.scene.entities[state.scene.selectedEntityId] : null;
        if (state.runtimeMode !== 'edit' || !entity?.components.autoPatrol) return;
        event.preventDefault();
        if (event.repeat) return;
        state.requestAutoPatrolCapture();
        return;
      }

      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC'].includes(event.code)) return;
      const interactiveControlFocused = target instanceof HTMLElement
        && Boolean(target.closest('button, a, [role="button"]'));
      if (interactiveControlFocused) return;
      pauseHistoryReplay();
      autoPatrolPlaybackRef.current?.notifyManualInput();
      autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [pauseHistoryReplay, requestAutoPatrolCapture]);

  /** Esc 随时结束环境临时调整，不影响当前普通实体选择。 */
  useEffect(() => {
    if (!environmentAdjustmentActive) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isScenePreparationActive()) return;
      if (event.key !== 'Escape') return;
      setEnvironmentAdjustmentActive(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [environmentAdjustmentActive, setEnvironmentAdjustmentActive]);


  useEffect(() => {
    viewportRef.current?.setGridSettings(gridSettings);
  }, [gridSettings]);

  useEffect(() => {
    runtimeRef.current?.setTrajectoryVisible(trajectoryVisible);
  }, [trajectoryVisible]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const runtime = runtimeRef.current;
    if (!viewport || !runtime) return;

    viewport.setViewDistance(sceneDocument.sceneSettings.camera.viewDistance);
    viewport.setSensitivity(sceneDocument.sceneSettings.sensitivity);
    runtime.syncShadows(sceneDocument.sceneSettings.shadows);
    runtime.syncSkybox(sceneDocument);
    if (!environmentApplyRequest && !environmentAdjustmentActive) {
      runtime.syncEnvironment(resolveEnvironmentRuntimeSettings(
        sceneDocument.sceneSettings.environment,
        environmentRuntimeOverride,
        { deferManagedCacheLoad: environmentStartupRelinkSessionId === sceneSessionId },
      ));
    }
  }, [
    environmentAdjustmentActive,
    environmentApplyRequest,
    environmentRuntimeOverride,
    environmentStartupRelinkSessionId,
    sceneSessionId,
    sceneDocument.sceneSettings,
  ]);

  /** 复位请求由原子视角应用负责，普通切换则先同步投影再驱动方向动画。 */
  useEffect(() => {
    if (cameraResetRequest || manualRoamSnapshot.enabled) return;
    viewportRef.current?.setCameraProjection(cameraProjection);
  }, [cameraProjection, cameraResetRequest, manualRoamSnapshot.enabled]);

  useEffect(() => {
    if (cameraResetRequest || manualRoamSnapshot.enabled) return;
    viewportRef.current?.setCameraOrientation(cameraOrientation);
  }, [cameraOrientation, cameraResetRequest, manualRoamSnapshot.enabled]);

  useEffect(() => {
    if (!cameraPoseSaveRequest) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    consumeCameraPoseSaveRequest(cameraPoseSaveRequest.id, viewport.getCameraPose());
  }, [cameraPoseSaveRequest, consumeCameraPoseSaveRequest]);

  useEffect(() => {
    if (!cameraResetRequest) return;
    if (manualRoamSnapshot.enabled) {
      consumeCameraResetRequest(cameraResetRequest.id);
      manualRoamRef.current?.reset();
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    applySavedSceneCameraView(viewport, sceneDocument.sceneSettings.camera);
    consumeCameraResetRequest(cameraResetRequest.id);
  }, [
    cameraResetRequest,
    consumeCameraResetRequest,
    manualRoamSnapshot.enabled,
    sceneDocument.sceneSettings.camera,
  ]);

  useEffect(() => {
    if (!entityArrayRequest) return;

    const runtime = runtimeRef.current;
    if (!runtime) {
      resolveEntityArrayRequest(entityArrayRequest.id, null);
      return;
    }

    const bounds = runtime.getEntitiesWorldBounds(entityArrayRequest.sourceIds);
    const axis = getEntityArrayAxis(entityArrayRequest.direction);
    const selectionSpanMeters = bounds?.geometryReady ? bounds.sizeMeters[axis] : null;
    resolveEntityArrayRequest(entityArrayRequest.id, selectionSpanMeters);
  }, [entityArrayRequest, resolveEntityArrayRequest]);

  useEffect(() => {
    if (!sceneFocusRequest) return;

    const runtime = runtimeRef.current;
    const viewport = viewportRef.current;
    if (!runtime || !viewport) return;

    const bounds = runtime.getEntitiesWorldBounds(sceneFocusRequest.entityIds);
    if (bounds) {
      manualRoamRef.current?.setEnabled(false);
      const currentScene = sceneDocumentRef.current;
      const containsSkybox = sceneFocusRequest.entityIds.some((entityId) => (
        Boolean(currentScene?.entities[entityId]?.components.skybox)
      ));
      viewport.setViewDistance(
        containsSkybox
          ? SKYBOX_FOCUS_VIEW_DISTANCE_METERS
          : currentScene?.sceneSettings.camera.viewDistance ?? SCENE_VIEW_DISTANCE_MAX,
      );
      viewport.focusOnBounds(
        bounds,
        containsSkybox
          ? { animate: false, maxRadiusMeters: Number.POSITIVE_INFINITY, useModelFocusAngle: false }
          : sceneFocusRequest.transition,
      );
      sceneFocusPerformanceRef.current = {
        ...bounds,
        focusedAt: new Date().toISOString(),
      };
    }
    consumeSceneFocusRequest(sceneFocusRequest.id);
  }, [sceneFocusRequest, consumeSceneFocusRequest]);


  /** 聚焦全局环境，并在超大厂区场景中临时提高可视距离但不超过 20 km。 */
  useEffect(() => {
    if (!environmentFocusRequest) return;

    const runtime = runtimeRef.current;
    const viewport = viewportRef.current;
    if (!runtime || !viewport) return;

    const bounds = runtime.getEnvironmentWorldBounds();
    if (bounds) {
      manualRoamRef.current?.setEnabled(false);
      const requiredViewDistance = Math.min(
        SCENE_VIEW_DISTANCE_MAX,
        Math.max(sceneDocument.sceneSettings.camera.viewDistance, Math.ceil(bounds.radiusMeters * 4)),
      );
      viewport.setViewDistance(requiredViewDistance);
      viewport.focusOnBounds(bounds, {
        animate: false,
        maxRadiusMeters: Number.POSITIVE_INFINITY,
        useModelFocusAngle: false,
      });
    }
    consumeEnvironmentFocusRequest(environmentFocusRequest.id);
  }, [
    consumeEnvironmentFocusRequest,
    environmentFocusRequest,
    sceneDocument.sceneSettings.camera.viewDistance,
  ]);

  const entityArrayDialogValidationError = entityArrayDialog
    ? entityArrayDialog.commitError ?? getEntityArrayDialogError(sceneDocument, entityArrayDialog)
    : null;
  const entityArraySource = entityArrayDialog
    ? sceneDocument.entities[entityArrayDialog.sourceEntityId]
    : null;
  const entityArrayIdentityBehavior = getShiftEntityArrayIdentityBehavior(entityArraySource);
  const entityArrayAssetNumberedSourceCount = entityArrayIdentityBehavior === 'asset-number' ? 1 : 0;

  /** 修改弹框参数时同步刷新临时 Babylon 阵列，不写入场景或命令历史。 */
  function handleEntityArrayDialogChange(value: EntityArrayDialogValue): void {
    if (!entityArrayDialog) return;

    const nextDialog = { ...entityArrayDialog, value, commitError: null };
    entityArrayDialogRef.current = nextDialog;
    setEntityArrayDialog(nextDialog);

    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (getEntityArrayParameterError(value.copyCount, value.spacingMeters)) {
      runtime.clearEntityArrayPreview();
      return;
    }
    runtime.updateEntityArrayPreview(
      nextDialog.sourceEntityId,
      nextDialog.direction,
      value.copyCount,
      value.spacingMeters,
    );
  }

  /** 原子校验并提交正式阵列；失败时保留弹框和临时预览。 */
  function handleConfirmEntityArrayDialog(): void {
    const dialog = entityArrayDialogRef.current;
    if (!dialog) return;

    const validationError = getEntityArrayDialogError(sceneDocumentRef.current ?? sceneDocument, dialog);
    if (validationError) {
      const nextDialog = { ...dialog, commitError: validationError };
      entityArrayDialogRef.current = nextDialog;
      setEntityArrayDialog(nextDialog);
      return;
    }

    const runtime = runtimeRef.current;
    const geometry = runtime?.getEntityArrayGeometry(dialog.sourceEntityId, dialog.direction);
    if (!geometry) {
      const error = '对象几何尚未加载完成或当前轴尺寸无效。';
      const nextDialog = { ...dialog, commitError: error };
      entityArrayDialogRef.current = nextDialog;
      setEntityArrayDialog(nextDialog);
      return;
    }

    const result = commitResolvedEntityArray({
      sourceIds: [dialog.sourceEntityId],
      copyCount: dialog.value.copyCount,
      directionVector: geometry.direction,
      selectionSpanMeters: geometry.spanMeters,
      spacingMeters: dialog.value.spacingMeters,
      assetNumberRule: dialog.value.assetNumberRule,
    });
    if (!result.ok) {
      const nextDialog = { ...dialog, commitError: result.error };
      entityArrayDialogRef.current = nextDialog;
      setEntityArrayDialog(nextDialog);
      return;
    }

    closeEntityArrayDialog();
  }

  /** 复制最近一分钟 Scene View 指标，便于在不同显卡设备上对比 CPU/GPU 瓶颈。 */
  async function handleCopyPerformanceReport(): Promise<void> {
    const monitor = performanceMonitorRef.current;
    if (!monitor) {
      pushLog('Scene View 性能报告尚未就绪。');
      return;
    }

    try {
      await copyScenePerformanceReport(monitor.createReport());
      pushLog('Scene View 性能报告已复制到剪贴板。');
    } catch (error) {
      pushLog(`Scene View 性能报告复制失败：${getErrorMessage(error)}`);
    }
  }

  const overlayViewport = viewportRef.current;
  const overlayRuntime = runtimeRef.current;

  return (
    <section className={isRuntimePreview ? 'scene-panel scene-panel-preview' : 'scene-panel'}>
      <h2>Scene</h2>
      <div className={isRuntimePreview ? 'scene-viewport scene-viewport-preview' : 'scene-viewport'}>
        <canvas
          ref={canvasRef}
          className="scene-canvas"
          onDragOver={handleCanvasDragOver}
          onDrop={handleCanvasDrop}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancelCapture={handleCanvasPointerCancel}
          onWheel={handleCanvasWheel}
        />
        {overlayViewport && overlayRuntime ? (
          <DataPlatformScreenOverlay
            canvas={canvasRef.current}
            interactive={isRuntimePreview}
            onCommand={handleDataPlatformScreenCommand}
            runtime={overlayRuntime}
            selectedEntityIds={hierarchySelectionIds.length > 0
              ? hierarchySelectionIds
              : selectedEntityId
                ? [selectedEntityId]
                : []}
            scene={overlayViewport.scene}
          />
        ) : null}
        <DataPlatformViewportScreenOverlay
          interactive={isRuntimePreview}
          onCommand={handleViewportDataPlatformScreenCommand}
          screen={sceneDocument.sceneSettings.viewportScreen}
          selectedEntityIds={hierarchySelectionIds.length > 0
            ? hierarchySelectionIds
            : selectedEntityId
              ? [selectedEntityId]
              : []}
        />
        <ViewportOrientationCompass
          camera={viewportCamera}
          disabled={Boolean(viewportError) || (isRuntimePreview && manualRoamSnapshot.enabled)}
          onReset={() => {
            pauseHistoryReplay();
            autoPatrolPlaybackRef.current?.notifyManualInput();
            autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
            requestCameraReset();
          }}
          onToggleStandardView={(orientation) => {
            pauseHistoryReplay();
            autoPatrolPlaybackRef.current?.notifyManualInput();
            autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
            toggleCameraStandardView(orientation);
          }}
          orientation={cameraOrientation}
        />
        {isRuntimePreview && hasManualRoamSpawn ? (
          <ManualRoamControls
            snapshot={manualRoamSnapshot}
            onConfigChange={handleManualRoamConfig}
            onDebugCollidersChange={(visible) => manualRoamRef.current?.setDebugColliders(visible)}
            onEnabledChange={handleManualRoamEnabled}
            onLocomotionModeChange={handleManualRoamLocomotionMode}
            onPointerLock={() => manualRoamRef.current?.requestPointerLock()}
            onReset={() => manualRoamRef.current?.reset()}
            onTouchAction={handleManualRoamTouchAction}
            onViewModeChange={handleManualRoamViewMode}
            onVirtualMove={(right, forward) => manualRoamRef.current?.setVirtualMovement(right, forward)}
          />
        ) : null}
        {isRuntimePreview
          && (autoPatrolRoutes.length > 0 || Boolean(autoPatrolHistory?.records.length))
          && !manualRoamSnapshot.enabled ? (
          <AutoPatrolControls
            routes={autoPatrolRoutes}
            snapshot={autoPatrolPlaybackSnapshot}
            onAction={(action, routeId, payload) => requestAutoPatrolPlayback(action, routeId, payload)}
            history={autoPatrolHistory}
            onHistoryAction={handleHistoryAction}
          />
        ) : null}
        {performanceSnapshot && props.performanceHudVisible ? (
          <div className={performanceHudExpanded ? 'scene-performance-hud expanded' : 'scene-performance-hud'}>
            <button
              aria-expanded={performanceHudExpanded}
              className="scene-performance-summary"
              onClick={() => setPerformanceHudExpanded((expanded) => !expanded)}
              title="展开或收起 Scene View 性能指标"
              type="button"
            >
              <strong>{formatPerformanceMetric(performanceSnapshot.fps, 0)} FPS</strong>
              <span>{formatPerformanceMetric(performanceSnapshot.frameTimeMs)} ms</span>
              <span>{performanceSnapshot.drawCalls} DC</span>
            </button>
            {performanceHudExpanded ? (
              <div className="scene-performance-details" role="status">
                <dl>
                  <div><dt>Frame / Render</dt><dd>{formatPerformanceMetric(performanceSnapshot.frameTimeMs)} / {formatPerformanceMetric(performanceSnapshot.renderTimeMs)} ms</dd></div>
                  <div><dt>GPU frame</dt><dd>{performanceSnapshot.gpuFrameTimeMs === null ? 'N/A' : `${formatPerformanceMetric(performanceSnapshot.gpuFrameTimeMs)} ms`}</dd></div>
                  <div><dt>Active eval</dt><dd>{formatPerformanceMetric(performanceSnapshot.activeMeshesEvaluationMs)} ms</dd></div>
                  <div><dt>Draw Calls</dt><dd>{performanceSnapshot.drawCalls}</dd></div>
                  <div><dt>Meshes</dt><dd>{performanceSnapshot.activeMeshes} / {performanceSnapshot.totalMeshes}</dd></div>
                  <div><dt>Vertices</dt><dd>{performanceSnapshot.totalVertices.toLocaleString()}</dd></div>
                  <div><dt>Thin instances</dt><dd>{performanceSnapshot.thinInstances.toLocaleString()}</dd></div>
                  <div><dt>Active thin</dt><dd>{performanceSnapshot.activeThinInstances.toLocaleString()}</dd></div>
                  <div><dt>GPU vertex calls</dt><dd>{performanceSnapshot.estimatedActiveVertexInvocations.toLocaleString()}</dd></div>
                  <div><dt>GPU triangle calls</dt><dd>{performanceSnapshot.estimatedActiveTriangleInvocations.toLocaleString()}</dd></div>
                  <div><dt>双面顶点</dt><dd>{performanceSnapshot.gpuMaterialTotals.doubleSidedVertexInvocations.toLocaleString()}</dd></div>
                  <div><dt>Alpha test / blend</dt><dd>{performanceSnapshot.gpuMaterialTotals.alphaTestedVertexInvocations.toLocaleString()} / {performanceSnapshot.gpuMaterialTotals.alphaBlendedVertexInvocations.toLocaleString()}</dd></div>
                  <div><dt>原模型 / 代理</dt><dd>{performanceSnapshot.runtime.modelArrayDetailedEntityCount.toLocaleString()} / {performanceSnapshot.runtime.modelArrayProxyEntityCount.toLocaleString()}</dd></div>
                  <div><dt>完整同步</dt><dd>{formatPerformanceMetric(performanceSnapshot.runtime.lastFullSyncDurationMs)} ms</dd></div>
                  <div><dt>选择同步</dt><dd>{formatPerformanceMetric(performanceSnapshot.runtime.lastSelectionSyncDurationMs)} ms / {performanceSnapshot.runtime.lastSelectionChangedEntityCount} 个</dd></div>
                  <div><dt>编辑态分组</dt><dd>{formatPerformanceMetric(performanceSnapshot.editThinInstancePlan.lastDurationMs)} ms / {performanceSnapshot.editThinInstancePlan.entityCount.toLocaleString()} 个</dd></div>
                  <div><dt>Long Task</dt><dd>{performanceSnapshot.longTaskCount} / {formatPerformanceMetric(performanceSnapshot.longTaskDurationMs)} ms</dd></div>
                </dl>
                <button className="scene-performance-copy" onClick={() => void handleCopyPerformanceReport()} type="button">
                  复制最近一分钟报告
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {isRuntimePreview ? (
          <span aria-live="polite" className="scene-preview-badge" role="status">运行预览</span>
        ) : null}
        {!isRuntimePreview && environmentAdjustmentActive ? (
          <span aria-live="polite" className="scene-environment-adjustment-badge" role="status">
            正在调整环境（Esc 结束）
          </span>
        ) : null}
        {viewportError ? (
          <div className="scene-error" role="alert">
            <strong>Scene View 暂时不可用</strong>
            <p>{viewportError}</p>
          </div>
        ) : null}
      </div>
      {entityArrayDialog ? (
        <EntityArrayDialog
          assetNumberedSourceCount={entityArrayAssetNumberedSourceCount}
          directionLabel={entityArrayDialog.directionLabel}
          onCancel={closeEntityArrayDialog}
          onChange={handleEntityArrayDialogChange}
          onConfirm={handleConfirmEntityArrayDialog}
          validationError={entityArrayDialogValidationError}
          value={entityArrayDialog.value}
        />
      ) : null}
    </section>
  );
}
