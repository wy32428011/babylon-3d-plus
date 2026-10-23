import { createScenePerformanceReportHandlers } from './scene-view/scenePerformanceReports';
import { useSceneFocusTransition } from './scene-view/useSceneFocusTransition';
import { useSceneCameraTransition } from './scene-view/useSceneCameraTransition';
import { useSceneKeyboardShortcuts } from './scene-view/useSceneKeyboardShortcuts';
import { useSceneLightingPreview } from './scene-view/useSceneLightingPreview';
import { useSceneAssetDropHandler } from './scene-view/useSceneAssetDropHandler';
import { useSceneSelectionHandlers } from './scene-view/useSceneSelectionHandlers';
import { SceneViewportOverlays } from './scene-view/SceneViewportOverlays';
import { ScenePerformanceHud } from './scene-view/ScenePerformanceHud';
import {
  transformPreviewStore,
  isTransformPreviewSessionValid,
  type TransformPreviewSession,
} from '../store/transformPreviewStore';
import { subscribeCadReferenceLoadStatus } from '../cad/cadReferenceLoadStatus';


import { useEditorOpeningAnimation } from '../opening/useEditorOpeningAnimation';
import { SceneModelEntrancePlayback } from '../../shared/opening/SceneModelEntrancePlayback';

import { normalizeSceneModelEntranceSettings } from '../model/sceneModelEntrance';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import {
  cancelEffectPathDrawing,
  getEffectPathDrawing,
  subscribeEffectPathDrawing,
} from '../model/effectPathDrawing';
import { CompositionEditStatus } from '../composition/CompositionControls';
import { findCompositionRoot } from '../composition/composition';


import { shouldValidateSceneModelResources } from '../assets/sceneModelSyncTransaction';
import { environmentPreparationStore } from '../loading/environmentPreparationProgress';
import { executeChartMarkerClick } from '../../runtime/babylon/chartMarkerClick';
import { CHART_MARKER_REFRESH_EVENT } from '../../shared/chartMarkerEmbed';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createBabylonViewport,
  isSoftwareWebGLFallbackAllowed,
  type BabylonViewport,
  type BabylonViewportRuntimeStatus,
} from '../../runtime/babylon/createEngine';

import { type SceneModelSelectionPointerSnapshot } from '../../shared/sceneModelSelectionPointer';

import { CLICK_EVENT_FOCUS_DURATION_MS } from '../model/clickEventBinding';

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
import { createSceneCameraPoseFromReplayCamera, type AutoPatrolInspectionReplayCamera } from '../../runtime/patrol/AutoPatrolInspectionReplayController';
import type { AutoPatrolInspectionRecordStore } from '../../runtime/patrol/AutoPatrolInspectionRecordStore';
import {
  ScenePerformanceMonitor,
  type EditModeThinInstancePlanPerformanceMetrics,
  type SceneFocusPerformanceMetrics,
  type ScenePerformanceSnapshot,
} from '../../runtime/babylon/ScenePerformanceMonitor';
import {
  createEditorPerformanceRunSession,
  type EditorPerformanceRunSession,
  type EditorPerformanceRunSnapshot,
} from '../runtime/editorPerformanceRunSession';
import { TransformGizmoController, type EntityArrayDragUpdate } from '../../runtime/babylon/TransformGizmoController';

import { useEditorStore, type EntityArrayDirection } from '../store/editorStore';


import { getLightEditorCapabilities } from '../model/lightEditor';

import {
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
import { type SceneDocument } from '../model/SceneDocument';
import { resolveEnvironmentRuntimeSettings } from '../model/environmentRuntime';


import type { Vector3Data } from '../model/math';
import { createGroupPositionDelta } from '../model/groupSpatialInfo';
import {
  resolveHierarchyGroupTransformSelection,
  isEntityEffectivelyLocked,
  type HierarchyGroupTransformReadySelection,
} from '../model/entityHierarchy';
import {
  getEntityArrayIdentifierError,
  getCompositionArrayInfo,
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




import type { DataPlatformScreenCommand } from '../../runtime/babylon/dataPlatformScreenBridge';
import { buildDigitalTwinAssetIndex, findDigitalTwinAsset } from '../../shared/digitalTwinAssetCodes';
import { useAutoPatrolInspectionHistory } from '../../shared/ui/useAutoPatrolInspectionHistory';

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
  isScenePreparationSettled,
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

const SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING = '模型加载或 Geometry 合批超过 120 秒，仍在等待全部模型渲染就绪，请查看加载性能报告。';

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
  if (!isShiftEntityArraySupported(source) || !source || isEntityEffectivelyLocked(scene.entities, source)) {
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
  useEffect(() => subscribeCadReferenceLoadStatus(status => {
    useEditorStore.getState().reportCadReferenceRuntimeLoad(status);
  }), []);
  const gizmoRef = useRef<TransformGizmoController | null>(null);
  const transformPreviewSessionRef = useRef<TransformPreviewSession | null>(null);
  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe(state => {
      const session = transformPreviewSessionRef.current;
      if (session && !isTransformPreviewSessionValid(session, state)) gizmoRef.current?.cancelActiveDrag();
    });
    return () => {
      unsubscribe();
      const session = transformPreviewSessionRef.current;
      if (session) transformPreviewStore.clear(session);
      transformPreviewSessionRef.current = null;
    };
  }, []);

  const autoPatrolPlaybackRef = useRef<AutoPatrolPlaybackController | null>(null);
  const manualRoamRef = useRef<ManualRoamRuntime | null>(null);
  const mqttTelemetryClientRef = useRef<MqttStackerTelemetryClient | null>(null);
  const performanceMonitorRef = useRef<ScenePerformanceMonitor | null>(null);
  const performanceRunSessionRef = useRef<EditorPerformanceRunSession | null>(null);
  const sceneFocusPerformanceRef = useRef<SceneFocusPerformanceMetrics | null>(null);
  const clickSnapshotRef = useRef<SceneModelSelectionPointerSnapshot | null>(null);
  // 预览下产物高亮走运行时本地通道（合成 id），记录目标以便点击转入常规选择路径时清除。
  const clickProductHighlightIdRef = useRef<string | null>(null);
  const effectDrawingPointerRef = useRef<number | null>(null);
  const effectDrawing = useSyncExternalStore(subscribeEffectPathDrawing, getEffectPathDrawing, getEffectPathDrawing);
  const sceneDocumentRef = useRef<SceneDocument | null>(null);
  const editRuntimeSceneDocumentRef = useRef<SceneDocument | null>(null);
  const statisticsSceneSessionRef = useRef<string | null>(null);
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
  const skyboxResourceRetryKeyRef = useRef<string | null>(null);
  const failedResourceRetrySessionRef = useRef<string | null>(null);
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
  const detailedGpuWorkloadsEnabledRef = useRef(false);
  const [performanceRunHudExpanded, setPerformanceRunHudExpanded] = useState(true);
  const [performanceRunSnapshot, setPerformanceRunSnapshot] = useState<EditorPerformanceRunSnapshot | null>(null);
  const [sceneRuntimeNaturallyReady, setSceneRuntimeNaturallyReady] = useState(false);
  const [manualRoamSnapshot, setManualRoamSnapshot] = useState<ManualRoamSnapshot>(createInitialManualRoamSnapshot);
  const [autoPatrolRecordStore, setAutoPatrolRecordStore] = useState<AutoPatrolInspectionRecordStore | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);
  const sceneSessionId = useEditorStore((state) => state.sceneSessionId);
  const sceneStartupResourceSessionId = useEditorStore((state) => state.sceneStartupResourceSessionId);
  const sceneRuntimeStartupDeferred = sceneStartupResourceSessionId === sceneSessionId;
  const performanceRunSceneSessionIdRef = useRef(sceneSessionId);
  const manualRoamSceneSessionIdRef = useRef(sceneSessionId);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const runtimePerformanceEnabled = useEditorStore((state) => state.runtimePerformanceEnabled);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const hierarchySelectionIds = useEditorStore((state) => state.hierarchySelectionIds);

  useEffect(() => () => cancelEffectPathDrawing(), [sceneSessionId]);
  useEffect(() => {
    if (!effectDrawing) return;
    const entity = sceneDocument.entities[effectDrawing.entityId];
    if (runtimeMode !== 'edit' || selectedEntityId !== effectDrawing.entityId || !entity || entity.locked || entity.components.poiEffect?.effectKind !== effectDrawing.effectKind) cancelEffectPathDrawing();
  }, [effectDrawing, runtimeMode, selectedEntityId, sceneDocument.entities]);
  const effectDrawingEntityId = effectDrawing?.entityId;
  useEffect(() => {
    if (effectDrawingEntityId === undefined) {
      const pointerId = effectDrawingPointerRef.current;
      const canvas = canvasRef.current;
      if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      effectDrawingPointerRef.current = null;
      return;
    }
    clickSnapshotRef.current = null;
    gizmoRef.current?.cancelActiveDrag();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !getEffectPathDrawing()) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancelEffectPathDrawing();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [effectDrawingEntityId]);

  // 绘制预览只挂在真实特效根节点下；草稿变动、切场景和取消均释放自有资源。
  useEffect(() => {
    const viewport = viewportRef.current;
    const target = effectDrawing ? runtimeRef.current?.getGizmoTargetByEntityId(effectDrawing.entityId) : null;
    if (!effectDrawing || !viewport || !target || target.isDisposed() || !effectDrawing.points.length) return;
    const previewRoot = new TransformNode('__effectPathDrawingPreview', viewport.scene);
    previewRoot.parent = target;
    const tint = effectDrawing.error ? new Color3(1, .3, .2) : new Color3(.15, .85, 1);
    const material = new StandardMaterial('__effectPathDrawingMaterial', viewport.scene);
    material.disableLighting = true; material.emissiveColor = tint; material.disableDepthWrite = true; material.depthFunction = Constants.ALWAYS;
    const points = effectDrawing.points.map(point => new Vector3(point.local.x, point.local.y, point.local.z));
    target.computeWorldMatrix(true);
    const scale = target.absoluteScaling;
    const diameter = .3 / Math.max(.001, Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    const markers = points.map((point, index) => {
      const marker = MeshBuilder.CreateSphere('__effectPathDrawingPoint_' + index, { diameter, segments: 6 }, viewport.scene);
      marker.parent = previewRoot; marker.position.copyFrom(point); marker.material = material;
      marker.isPickable = false; marker.renderingGroupId = 3; marker.metadata = { editorOverlay: true, effectPathDrawing: true };
      return marker;
    });
    const closed = effectDrawing.mode !== 'path' || sceneDocument.entities[effectDrawing.entityId]?.components.poiEffect?.configuration?.parameters.closed === true;
    const line = points.length >= 2 ? MeshBuilder.CreateTube('__effectPathDrawingLine', { path: closed && points.length >= 3 ? [...points, points[0]] : points, radius: diameter / 7, tessellation: 6 }, viewport.scene) : null;
    if (line) { line.parent = previewRoot; line.material = material; line.isPickable = false; line.renderingGroupId = 3; line.metadata = { editorOverlay: true, effectPathDrawing: true }; }
    return () => { line?.dispose(false, false); for (const marker of markers) marker.dispose(false, false); material.dispose(); previewRoot.dispose(); };
  }, [effectDrawing, viewportCamera, sceneSessionId, sceneDocument.entities]);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const trajectoryVisible = useEditorStore((state) => state.trajectoryVisible);
  const entityArrayRequest = useEditorStore((state) => state.entityArrayRequest);
  const sceneFocusRequest = useEditorStore((state) => state.sceneFocusRequest);
  const environmentApplyRequest = useEditorStore((state) => state.environmentApplyRequest);
  const lightingBakeRequest = useEditorStore(state => state.lightingBakeRequest);
  const lightingDebugVisible = useEditorStore(state => state.lightingDebugVisible);
  const lightingComparisonEnabled = useEditorStore(state => state.lightingComparisonEnabled);
  const lightingNodeFocusRequest = useEditorStore(state => state.lightingNodeFocusRequest);
  const lightingManagerOpen = useEditorStore(state => state.lightingManagerOpen);
  const lightingManagerPreviewRequest = useEditorStore(state => state.lightingManagerPreviewRequest);
  const environmentRuntimeOverride = useEditorStore((state) => state.environmentRuntimeOverride);
  const environmentStartupRelinkSessionId = useEditorStore((state) => state.environmentStartupRelinkSessionId);
  const environmentAdjustmentActive = useEditorStore((state) => state.environmentAdjustmentActive);
  const environmentRuntimePhase = useEditorStore((state) => state.environmentRuntimeSnapshot.phase);
  const environmentFocusRequest = useEditorStore((state) => state.environmentFocusRequest);
  const cameraPoseSaveRequest = useEditorStore((state) => state.cameraPoseSaveRequest);
  const regionViewRequest = useEditorStore((state) => state.regionViewRequest);
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
  const createDeviceSpawner = useEditorStore((state) => state.createDeviceSpawner);
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
  const isPerformanceRun = isRuntimePreview && runtimePerformanceEnabled;
  const isPerformanceHudExpanded = isPerformanceRun ? performanceRunHudExpanded : performanceHudExpanded;
  const showPerformanceHud = Boolean(performanceSnapshot && (props.performanceHudVisible || isPerformanceRun));
  detailedGpuWorkloadsEnabledRef.current = showPerformanceHud && isPerformanceHudExpanded;
  const hasStoppedPerformanceReport = !isPerformanceRun && performanceRunSnapshot?.phase === 'stopped';
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
    const bounds = runtime.getEntitiesFocusBounds([entityId]);
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
        const bounds = runtime.getEntitiesFocusBounds([targetId]);
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
  const { entityIds: sceneEntityIds, entities: sceneEntities } = sceneDocument;
  const cachedParameterSceneChange = modelParameterSceneChangeRef.current;
  // 参数变更识别读取当前文档上下文；昂贵的分组仍只随实体图或识别结果变化。
  const parameterSceneChangeEntityId = editModeThinInstancePlanRef.current
    ? cachedParameterSceneChange?.entities === sceneEntities
      ? cachedParameterSceneChange.entityId
      : resolveModelParameterOnlySceneChangeEntityId(sceneDocumentRef.current, sceneDocument)
    : null;
  const editModeThinInstancePlanComputation = useMemo(() => {
    const startedAt = readScenePanelTimestampMs();
    const previousPlan = editModeThinInstancePlanRef.current;
    const parameterSyncEntityId = parameterSceneChangeEntityId;
    const entityGraph = { entityIds: sceneEntityIds, entities: sceneEntities };
    const plan = parameterSyncEntityId && previousPlan
      ? patchEditModeModelThinInstancePlanForModelParameters(entityGraph, previousPlan, parameterSyncEntityId)
      : createEditModeModelThinInstancePlan(entityGraph, previousPlan ?? undefined);
    return {
      plan,
      parameterSyncEntityId,
      durationMs: Math.max(0, readScenePanelTimestampMs() - startedAt),
      entityCount: sceneEntityIds.length,
    };
  }, [sceneEntityIds, sceneEntities, parameterSceneChangeEntityId]);
  const editModeThinInstancePlan = editModeThinInstancePlanComputation.plan;
  const modelParameterSyncEntityId = editModeThinInstancePlanComputation.parameterSyncEntityId;
  const editRuntimeSceneDocument = useMemo(
    () => editModeThinInstancePlan.entities === sceneDocument.entities
      ? sceneDocument
      : { ...sceneDocument, entities: editModeThinInstancePlan.entities },
    [editModeThinInstancePlan.entities, sceneDocument],
  );
  const resolvedSceneRuntimeEnvironment = resolveEnvironmentRuntimeSettings(
    sceneDocument.sceneSettings.environment,
    environmentRuntimeOverride,
    { deferEnvironmentLoad: environmentStartupRelinkSessionId === sceneSessionId },
  );
  const sceneRuntimeEnvironmentSourceUrl = (
    environmentApplyRequest?.runtimeEnvironment
    ?? environmentApplyRequest?.environment
    ?? resolvedSceneRuntimeEnvironment
  )?.activeVariantUrl ?? null;
  // 待远程重关联时运行时URL为空，但场景要求的环境仍须参与就绪门控。
  const sceneRuntimeEnvironmentExpected = Boolean(
    environmentApplyRequest?.environment ?? sceneDocument.sceneSettings.environment,
  );
  const autoPatrolRoutes = useMemo<AutoPatrolPlaybackRoute[]>(
    () => collectAutoPatrolPlaybackRoutes({ entityIds: sceneEntityIds, entities: sceneEntities }),
    [sceneEntityIds, sceneEntities],
  );
  /** 未摆放手动漫游 POI 时不展示运行预览漫游面板。 */
  const hasManualRoamSpawn = useMemo(
    () => hasManualRoamSpawnEntity({ entityIds: sceneEntityIds, entities: sceneEntities }),
    [sceneEntityIds, sceneEntities],
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
  const sceneResourcesReady = preparationState.sceneSessionId === sceneSessionId
    && preparationState.assetRefreshStatus === 'settled'
    && scenePreparationNaturallyCompleted
    && (!sceneDocument.sceneSettings.environment || environmentRuntimePhase === 'ready');
  const [entrancePreparation, setEntrancePreparation] = useState<ReturnType<SceneRuntime['getModelEntranceSnapshot']> | null>(null);
  const [entranceReadySession, setEntranceReadySession] = useState<string | null>(null);
  const [entrancePreparationError, setEntrancePreparationError] = useState<string | null>(null);
  const entranceRequired = isRuntimePreview && normalizeSceneModelEntranceSettings(sceneDocument.sceneSettings.modelEntrance).enabled;
  const sceneReadyForAutoPatrol = sceneResourcesReady && (!entranceRequired || entranceReadySession === sceneSessionId);
  const opening = useEditorOpeningAnimation({
    viewport: viewportRef.current, ready: sceneReadyForAutoPatrol,
    sceneDocument, sceneSessionId, isRuntimePreview,
    getEnvironmentSnapshot: () => {
      if (!runtimeRef.current) throw new Error('场景运行时尚未就绪，无法读取环境模型。');
      return runtimeRef.current.getOpeningEnvironmentSnapshot();
    },
  });
  const modelEntrancePlayback = useRef<SceneModelEntrancePlayback | null>(null);
  useEffect(() => {
    setEntranceReadySession(null); setEntrancePreparation(null); setEntrancePreparationError(null);
    if (!isRuntimePreview || !sceneResourcesReady || !entranceRequired) return;
    const runtime = runtimeRef.current;
    const container = viewportRef.current?.engine.getRenderingCanvas()?.parentElement;
    if (!runtime || !container) return;
    const controller = new AbortController();
    const playback = new SceneModelEntrancePlayback({ runtime, container, signal: controller.signal,
      settings: normalizeSceneModelEntranceSettings(sceneDocument.sceneSettings.modelEntrance),
      isReady: () => runtime.isModelEntranceReady(),
      onError: error => pushLog('模型入场未播放，已恢复正常模型：' + getErrorMessage(error)),
    });
    modelEntrancePlayback.current = playback;
    const sample = () => { if (!controller.signal.aborted) setEntrancePreparation(runtime.getModelEntranceSnapshot()); };
    sample(); const timer = window.setInterval(sample, 100);
    void playback.ready.then(async () => {
      if (controller.signal.aborted) return;
      sample(); await runtime.waitForInitialRenderReady(controller.signal);
      if (!controller.signal.aborted) setEntranceReadySession(sceneSessionId);
    }).catch(error => {
      if (!controller.signal.aborted) {
        playback.dispose(); pushLog('入场首帧验证失败，已恢复正常模型：' + getErrorMessage(error));
        setEntrancePreparationError(getErrorMessage(error));
      }
    }).finally(() => { window.clearInterval(timer); sample(); });
    return () => {
      controller.abort(); window.clearInterval(timer); playback.dispose();
      if (modelEntrancePlayback.current === playback) modelEntrancePlayback.current = null;
    };
  }, [isRuntimePreview, sceneResourcesReady, entranceRequired, sceneSessionId, sceneDocument.sceneSettings.modelEntrance, pushLog]);
  useEffect(() => {
    if (sceneReadyForAutoPatrol && opening.settled) modelEntrancePlayback.current?.start();
  }, [sceneReadyForAutoPatrol, opening.settled]);

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
        groupSelection.selectionIds.length === 1 && state.scene.entities[groupSelection.selectionIds[0]]?.composition ? state.scene.entities[groupSelection.selectionIds[0]].components.transform.position : undefined,
      );
      gizmo.attachToGroupTarget(target, groupSelection.groupId, {
        rotationAxes: containsManualRoamSpawn ? ['y'] : undefined,
        entityArraySourceId: groupSelection.selectionIds.length === 1
          && state.scene.entities[groupSelection.selectionIds[0]]?.composition
          ? groupSelection.selectionIds[0] : undefined,
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
    const activeSelectionIds = hierarchySelectionIds.length > 0
      ? hierarchySelectionIds.filter((entityId) => Boolean(sceneDocument.entities[entityId]))
      : selectedEntityId
        ? [selectedEntityId]
        : [];
    const sourceInvalid = sceneDocument !== entityArrayDialog.sourceSceneDocument
      || !isShiftEntityArraySupported(source)
      || !source
      || isEntityEffectivelyLocked(sceneDocument.entities, source)
      || Boolean(getCompositionArrayInfo(sceneDocument, [entityArrayDialog.sourceEntityId], 1)?.error)
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

  const { handleEffectPathPointerDownCapture, handleEffectPathPointerMoveCapture, handleEffectPathPointerUpCapture, handleCanvasPointerDown, handleCanvasPointerMove, handleCanvasPointerUp, handleCanvasPointerCancel, handleCanvasWheel } = useSceneSelectionHandlers({
    runtimeModeRef, clickSnapshotRef, effectDrawingPointerRef, runtimeRef, gizmoRef, pauseHistoryReplay, autoPatrolPlaybackRef, isRuntimePreview, handleChartMarkerClick, manualRoamRef, viewportRef, clickProductHighlightIdRef, selectEntity,
  });

  const { handleCanvasDragOver, handleCanvasDrop } = useSceneAssetDropHandler({
    isRuntimePreview, runtimeRef, clickSnapshotRef, sceneDocument, placeSkybox, importModelAsset, createAutoPatrol, createManualRoamSpawn, createModelGenerator, createDeviceSpawner, createClickEventBinding, createChartMarker, createPoiEffect, createMesh, createLocator, createLight, pushLog,
  });

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
        requireHardwareAcceleration: !isSoftwareWebGLFallbackAllowed(),
        onLog: pushLog,
        initialSensitivity: useEditorStore.getState().scene.sceneSettings.sensitivity,
        isScenePreparing: () => isScenePreparationActive() && useEditorStore.getState().runtimeMode !== 'preview',
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
      runtime.onModelStatisticsChanged = (snapshot) => {
        const state = useEditorStore.getState();
        const session = statisticsSceneSessionRef.current;
        if (runtimeRef.current !== runtime || !session || session !== state.sceneSessionId) return;
        state.setSceneModelStatistics(snapshot, session);
      };
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
        preloadAvatar: hasManualRoamSpawnEntity(useEditorStore.getState().scene),
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
        beginTransformDrag: (entityId, _before) => {
          const state = useEditorStore.getState();
          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime || state.runtimeMode !== 'edit' || state.scene.selectedEntityId !== entityId
            || !state.scene.entities[entityId] || isEntityEffectivelyLocked(state.scene.entities, state.scene.entities[entityId])
            || !currentRuntime.beginSingleTransformPreview(entityId, state.scene.entities[entityId].components.transform)) return false;
          transformPreviewSessionRef.current = transformPreviewStore.begin(state.sceneSessionId, state.scene, entityId, state.scene.entities[entityId].components.transform);
          return true;
        },
        isTransformDragValid: entityId => {
          const session = transformPreviewSessionRef.current;
          return Boolean(session && session.entityId === entityId && isTransformPreviewSessionValid(session, useEditorStore.getState()));
        },
        previewRuntimeTransform: (entityId, transform) => {
          (runtimeRef.current ?? runtime)?.updateSingleTransformPreview(entityId, transform);
        },
        previewTransform: (entityId, transform) => {
          const session = transformPreviewSessionRef.current;
          if (!session || session.entityId !== entityId) { previewEntityTransform(entityId, transform); return; }
          transformPreviewStore.publish(session, transform);
        },
        cancelTransformDrag: () => {
          const session = transformPreviewSessionRef.current;
          transformPreviewSessionRef.current = null;
          if (session) transformPreviewStore.clear(session);
          const currentRuntime = runtimeRef.current ?? runtime;
          currentRuntime?.endSingleTransformPreview();
          const state = useEditorStore.getState();
          currentRuntime?.sync(state.runtimeMode === 'edit'
              ? { ...state.scene, entities: createEditModeModelThinInstancePlan(state.scene, editModeThinInstancePlanRef.current ?? undefined).entities }
              : state.scene, state.hierarchySelectionIds, { modelArrayIdentityMode: state.runtimeMode === 'edit' ? 'visual' : 'device' });
        },
        commitTransform: (entityId, before, after) => {
          const session = transformPreviewSessionRef.current;
          transformPreviewSessionRef.current = null;
          (runtimeRef.current ?? runtime)?.endSingleTransformPreview();
          try {
            if (!session || isTransformPreviewSessionValid(session, useEditorStore.getState())) commitEntityTransform(entityId, session?.before ?? before, after);
          } finally {
            if (session) transformPreviewStore.clear(session);
            const state = useEditorStore.getState();
            (runtimeRef.current ?? runtime)?.sync(state.runtimeMode === 'edit'
              ? { ...state.scene, entities: createEditModeModelThinInstancePlan(state.scene, editModeThinInstancePlanRef.current ?? undefined).entities }
              : state.scene, state.hierarchySelectionIds, { modelArrayIdentityMode: state.runtimeMode === 'edit' ? 'visual' : 'device' });
          }
        },
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
          const compositionInfo = currentScene ? getCompositionArrayInfo(currentScene, [context.entityId], 1) : null;
          if (!isShiftEntityArraySupported(source) || !source || !currentScene
            || isEntityEffectivelyLocked(currentScene.entities, source) || compositionInfo?.error) {
            pushLog(`模型阵列已阻止：${compositionInfo?.error ?? '请选择一个未锁定且支持阵列的场景对象。'}`);
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
      const failedState = useEditorStore.getState();
      failedState.setSceneModelStatistics({ sceneId: failedState.scene.id, phase: 'error',
        modelTriangleCount: 0, environmentTriangleCount: 0 }, failedState.sceneSessionId);
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
    runtime.onAlarmActivated = event => {
      if (event.focusCamera) {
        const bounds = runtime?.getEntitiesFocusBounds([event.targetId]);
        if (bounds) { manualRoam?.setEnabled(false); viewport?.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS }); }
      }
      if (event.theme) pushLog('告警主题“' + event.theme.name + '”已触发，发布后在数据中台大屏中展示。');
    };
    runtimeRef.current = runtime;
    gizmoRef.current = gizmo;
    autoPatrolPlaybackRef.current = autoPatrolPlayback;
    manualRoamRef.current = manualRoam;
    mqttTelemetryClientRef.current = mqttTelemetryClient;

    try {
      performanceMonitor = new ScenePerformanceMonitor(viewport.engine, viewport.scene, {
        collectDetailedGpuWorkloads: () => detailedGpuWorkloadsEnabledRef.current,
        getRuntimeMetrics: () => runtimeRef.current?.getPerformanceMetrics() ?? initializedRuntime.getPerformanceMetrics(),
        getEditThinInstancePlanMetrics: () => editModeThinInstancePlanPerformanceRef.current,
        getSceneFocusMetrics: () => sceneFocusPerformanceRef.current,
      });
      performanceMonitorRef.current = performanceMonitor;
      performanceMonitor.start((snapshot) => {
        setPerformanceSnapshot(snapshot);
        const state = useEditorStore.getState();
        const session = performanceRunSessionRef.current;
        if (!session || !state.runtimePerformanceEnabled || state.runtimeMode !== 'preview') return;
        session.record(snapshot, initializedRuntime.getTelemetryPerformanceMetrics());
        setPerformanceRunSnapshot(session.getSnapshot());
      });
    } catch (error) {
      console.warn('Scene View 性能监控初始化失败，渲染功能不受影响。', error);
      pushLog(`Scene View 性能监控初始化失败：${getErrorMessage(error)}`);
    }

    runtime.registerHostSceneObservers();
    const initializedPerformanceMonitor = performanceMonitor;
    const canvas = canvasRef.current;
    // Project 内容会改变中列 auto 行高；元素自身尺寸变化不会触发 window.resize。
    const resize = () => initializedViewport.resize();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(resize);
    if (canvas) resizeObserver?.observe(canvas);
    const cancelActiveGizmoDrag = () => initializedGizmo.cancelActiveDrag();
    const cancelGizmoOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') initializedGizmo.cancelActiveDrag();
    };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', cancelActiveGizmoDrag);
    window.addEventListener('keydown', cancelGizmoOnEscape);
    resize();

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', cancelActiveGizmoDrag);
      window.removeEventListener('keydown', cancelGizmoOnEscape);
      performanceRunSessionRef.current?.stop(initializedRuntime.getTelemetryPerformanceMetrics());
      initializedRuntime.setTelemetryPerformanceTimingEnabled(false);
      initializedPerformanceMonitor?.dispose();
      initializedMqttTelemetryClient?.dispose();
      initializedUnsubscribeManualRoamSnapshot?.();
      initializedManualRoam?.dispose();
      initializedUnsubscribeAutoPatrolSnapshot?.();
      initializedAutoPatrolPlayback?.dispose();
      initializedAutoPatrolIntegration?.dispose();
      setAutoPatrolRecordStore(null);
      initializedGizmo.dispose();
      initializedRuntime.onModelStatisticsChanged = undefined;
      statisticsSceneSessionRef.current = null;
      const currentState = useEditorStore.getState();
      currentState.setSceneModelStatistics(null, currentState.sceneSessionId);
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
    if (!hasManualRoamSpawn) return;
    manualRoamRef.current?.setAvatarUrl(resolveManualRoamAvatarSource(sceneDocument));
  }, [sceneDocument, hasManualRoamSpawn]);

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

  useSceneLightingPreview({
    lightingBakeRequest, runtimeRef, isRuntimePreview, sceneSessionId, lightingDebugVisible, lightingComparisonEnabled, lightingNodeFocusRequest, lightingManagerOpen, viewportRef, statisticsSceneSessionRef, lightingManagerPreviewRequest, sceneDocument,
  });

  /** 参数值变化走单实体同步；其它文档内容变化才进入完整 SceneRuntime 同步。 */
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    // 前序快照effect先发布当前文档；结构同步保持实体/会话门控。
    const currentDocument = editRuntimeSceneDocumentRef.current;
    if (!runtime || !gizmo || !currentDocument) return;
    if (isRuntimePreview || runtimeModeRef.current !== 'edit') return;
    if (sceneRuntimeStartupDeferred) return;

    statisticsSceneSessionRef.current = sceneSessionId;
    runtime.beginSceneSession(sceneSessionId);
    gizmo.cancelActiveGroupDrag();
    if (modelParameterSyncEntityId) {
      runtime.syncModelParameters(
        currentDocument,
        modelParameterSyncEntityId,
        useEditorStore.getState().hierarchySelectionIds,
        { modelArrayIdentityMode: 'visual' },
      );
    } else {
      runtime.sync(
        currentDocument,
        useEditorStore.getState().hierarchySelectionIds,
        { modelArrayIdentityMode: 'visual' },
      );
    }
    // 同一文档重开时运行时可能复用相同统计；新会话仍需主动发布首份快照。
    useEditorStore.getState().setSceneModelStatistics(runtime.getModelStatistics(), sceneSessionId);
    attachCurrentSelectionGizmo(runtime, gizmo);
    publishSelectedInspectorSpatialInfo(runtime, selectedEntityIdRef.current);
  }, [
    sceneSessionId,
    editRuntimeSceneDocument.entityIds,
    editRuntimeSceneDocument.entities,
    modelParameterSyncEntityId,
    sceneRuntimeStartupDeferred,
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
    const totalSceneModels = modelEntityIds.length + (sceneRuntimeEnvironmentExpected ? 1 : 0);
    const expectedBatchedEntities = countExpectedSceneBatchedEntities(
      sceneDocument.entityIds,
      editRuntimeSceneDocument.entities,
    );
    let active = true;
    let lastSignature = '';
    let intervalId: number | null = null;
    let renderedSignature: string | null = null;
    let renderWait: { signature: string; controller: AbortController } | null = null;

    const resetRenderWait = (): void => {
      renderWait?.controller.abort();
      renderWait = null;
      renderedSignature = null;
    };

    const stopReadinessPolling = (): void => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const sampleReadiness = (): void => {
      if (!active) return;
      const currentEditor = useEditorStore.getState();
      if (currentEditor.sceneSessionId !== sceneSessionId
        || currentEditor.scene !== sceneDocument) {
        resetRenderWait();
        stopReadinessPolling();
        return;
      }
      const preparationState = getScenePreparationSnapshot();
      if (
        preparationState.sceneSessionId !== sceneSessionId
        || isScenePreparationSettled(preparationState)
      ) {
        stopReadinessPolling();
        return;
      }
      if (preparationState.modelSyncStatus === 'pending' || preparationState.modelSyncStatus === 'active'
        || preparationState.assetRefreshStatus !== 'settled'
        || currentEditor.sceneStartupResourceSessionId === sceneSessionId) {
        resetRenderWait();
        setSceneRuntimeNaturallyReady(false);
        sceneRuntimeReadinessStableSamplesRef.current = 0;
        sceneRuntimeReadinessStartedAtRef.current = readScenePanelTimestampMs();
        sceneRuntimeTimeoutLoggedRef.current = false;
        lastSignature = '';
        return;
      }
      if (preparationState.runtime.generation !== sceneRuntimeReadinessGeneration) {
        resetRenderWait();
        sceneRuntimeReadinessStableSamplesRef.current = 0;
        sceneRuntimeReadinessStartedAtRef.current = readScenePanelTimestampMs();
        sceneRuntimeTimeoutLoggedRef.current = false;
        lastSignature = '';
      }

      const settleRuntimeAfterTimeout = (): void => {
        if (sceneRuntimeTimeoutLoggedRef.current) return;
        sceneRuntimeTimeoutLoggedRef.current = true;
        if (shouldValidateSceneModelResources(useEditorStore.getState(), sceneDocument)) {
          const error = useEditorStore.getState().sceneResourcePolicy === 'local-refresh'
            ? '本地场景资源未能在规定时间内完成加载与首帧渲染，请重新检查场景资源。'
            : '部分场景资源未能在规定时间内完成加载与首帧渲染，可继续编辑，发布前请重新同步。';
          useEditorStore.getState().finishLatestSceneResources(sceneSessionId, sceneDocument, error);
          environmentPreparationStore.fail(sceneSessionId, error);
          settleSceneRuntimeWithWarning(sceneSessionId, error);
          stopReadinessPolling();
          return;
        }
        pushLog(SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING);
        settleSceneRuntimeWithWarning(sceneSessionId, SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING);
      };
      const runtime = runtimeRef.current;
      if (!runtime) {
        reportSceneRuntimeProgress(sceneSessionId, {
          generation: sceneRuntimeReadinessGeneration,
          totalModels: totalSceneModels,
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

      const skyboxResourceRefreshKey = JSON.stringify([
        sceneSessionId, preparationState.modelSyncRunId, preparationState.assetRefreshId,
      ]);
      if (skyboxResourceRetryKeyRef.current !== skyboxResourceRefreshKey) {
        skyboxResourceRetryKeyRef.current = skyboxResourceRefreshKey;
        // 新会话首次打开不重试；只有该场景后续完整资源检查完成才重建失败宿主。
        if (failedResourceRetrySessionRef.current === sceneSessionId) {
          runtime.retryFailedSceneResources(editRuntimeSceneDocument, currentEditor.hierarchySelectionIds);
        }
        failedResourceRetrySessionRef.current = sceneSessionId;
        runtime.retrySkyboxLoading();
      }
      if (shouldValidateSceneModelResources(useEditorStore.getState(), sceneDocument)) {
        const failedEntityIds = sceneDocument.entityIds.filter(id => runtime.getModelReadinessError(id));
        const error = failedEntityIds.map(id => {
          const detail = runtime.getModelReadinessError(id);
          return detail ? `${sceneDocument.entities[id]?.name || id}：${detail}` : null;
        }).filter(Boolean).join('\n');
        if (error) {
          useEditorStore.getState().finishLatestSceneResources(sceneSessionId, sceneDocument, error, { entityIds: failedEntityIds });
          environmentPreparationStore.fail(sceneSessionId, error);
          settleSceneRuntimeWithWarning(sceneSessionId, error);
          stopReadinessPolling();
          return;
        }
      }
      const skyboxReadiness = runtime.getSkyboxReadiness();
      if (skyboxReadiness.phase === 'error') {
        const error = skyboxReadiness.message || `天空盒资源加载失败：${skyboxReadiness.sourceUrl || '未知资源'}`;
        currentEditor.recordSceneResourceIssues(sceneSessionId, [error]);
        currentEditor.finishLatestSceneResources(sceneSessionId, sceneDocument, error);
        environmentPreparationStore.fail(sceneSessionId, error);
        settleSceneRuntimeWithWarning(sceneSessionId, error);
        stopReadinessPolling();
        return;
      }
      let settledModels = 0;
      for (const entityId of modelEntityIds) {
        if (runtime.isModelReady(entityId)) settledModels += 1;
      }
      const environmentSnapshot = useEditorStore.getState().environmentRuntimeSnapshot;
      if (shouldValidateSceneModelResources(currentEditor, sceneDocument)
        && sceneRuntimeEnvironmentExpected && environmentSnapshot.phase === 'error'
        && environmentSnapshot.sourceUrl === sceneRuntimeEnvironmentSourceUrl) {
        const error = environmentSnapshot.message || '场景环境模型加载失败，已保留环境配置，可继续编辑。';
        currentEditor.finishLatestSceneResources(sceneSessionId, sceneDocument, error, { environment: true });
        environmentPreparationStore.fail(sceneSessionId, error);
        settleSceneRuntimeWithWarning(sceneSessionId, error);
        stopReadinessPolling();
        return;
      }
      const environmentReady = !sceneRuntimeEnvironmentExpected || (
        sceneRuntimeEnvironmentSourceUrl !== null
        && environmentSnapshot.phase === 'ready'
        && environmentSnapshot.sourceUrl === sceneRuntimeEnvironmentSourceUrl
      );
      if (sceneRuntimeEnvironmentSourceUrl && environmentReady) settledModels += 1;
      const runtimeMetrics = runtime.getPerformanceMetrics();
      const batchedEntities = Math.min(expectedBatchedEntities, runtimeMetrics.modelArrayBatchEntityCount);
      const readyNow = settledModels >= totalSceneModels
        && batchedEntities >= expectedBatchedEntities
        && skyboxReadiness.phase !== 'loading'
        && runtimeMetrics.loading.cargoPreload.pendingCount === 0;
      const signature = [
        settledModels,
        batchedEntities,
        runtimeMetrics.modelArrayBatchMeshCount,
        environmentSnapshot.phase,
        environmentSnapshot.sourceUrl ?? '',
        skyboxReadiness.phase,
        skyboxReadiness.sourceUrl ?? '',
        runtimeMetrics.loading.cargoPreload.pendingCount,
      ].join(':');
      sceneRuntimeReadinessStableSamplesRef.current = readyNow && signature === lastSignature
        ? sceneRuntimeReadinessStableSamplesRef.current + 1
        : readyNow ? 1 : 0;
      lastSignature = signature;
      const geometryStable = sceneRuntimeReadinessStableSamplesRef.current >= 2;
      if (!geometryStable) resetRenderWait();
      const currentScene = viewportRef.current?.scene;
      if (geometryStable && currentScene && renderedSignature !== signature && renderWait?.signature !== signature) {
        resetRenderWait();
        const controller = new AbortController();
        renderWait = { signature, controller };
        // 最终脚本/批次稳定后再等材质就绪及完整首帧，不能用采样间隔推测已经显示。
        void runtime.waitForInitialRenderReady(controller.signal).then(() => {
          if (!active || controller.signal.aborted || lastSignature !== signature) return;
          renderedSignature = signature;
          renderWait = null;
          sampleReadiness();
        }).catch((error) => {
          if (!active || controller.signal.aborted) return;
          pushLog(`场景首帧等待失败：${getErrorMessage(error)}`);
        });
      }
      const stable = geometryStable && renderedSignature === signature;
      if (stable) {
        setSceneRuntimeNaturallyReady(true);
        useEditorStore.getState().finishLatestSceneResources(sceneSessionId, sceneDocument);
        if (useEditorStore.getState().sceneResourceIssues.length === 0) {
          environmentPreparationStore.clearError(sceneSessionId);
        }
      }

      reportSceneRuntimeProgress(sceneSessionId, {
        generation: sceneRuntimeReadinessGeneration,
        totalModels: totalSceneModels,
        settledModels,
        expectedBatchedEntities,
        batchedEntities,
        stable,
        waitingResource: skyboxReadiness.phase === 'loading'
          ? '正在读取、解码或预过滤天空盒，完成后验证场景首帧…'
          : runtimeMetrics.loading.cargoPreload.pendingCount > 0
            ? '正在预取并解码货物模板，完成后验证场景首帧…'
            : !environmentReady
              ? `正在准备环境模型：${sceneDocument.sceneSettings.environment?.displayName || '场景环境'}`
              : null,
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
        && !isScenePreparationSettled(preparationState)
      ) {
        intervalId = window.setInterval(sampleReadiness, 250);
      }
    };

    const unsubscribeScenePreparation = subscribeScenePreparation(() => {
      const preparationState = getScenePreparationSnapshot();
      if (
        preparationState.sceneSessionId !== sceneSessionId
        || isScenePreparationSettled(preparationState)
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
      resetRenderWait();
      unsubscribeScenePreparation();
      stopReadinessPolling();
    };
  }, [
    editRuntimeSceneDocument,
    editRuntimeSceneDocument.entities,
    sceneDocument,
    sceneDocument.entityIds,
    sceneRuntimeEnvironmentSourceUrl,
    sceneRuntimeEnvironmentExpected,
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
        selection.selectionIds.length === 1 && state.scene.entities[selection.selectionIds[0]]?.composition ? state.scene.entities[selection.selectionIds[0]].components.transform.position : spatialInfo.center,
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
    const runtime = runtimeRef.current;
    const state = useEditorStore.getState();
    if (performanceRunSceneSessionIdRef.current !== sceneSessionId) {
      performanceRunSceneSessionIdRef.current = sceneSessionId;
      performanceRunSessionRef.current = null;
      setPerformanceRunSnapshot(null);
    }
    if (!runtime || !isPerformanceRun || !state.runtimePerformanceEnabled || state.runtimeMode !== 'preview') return;
    runtime.setTelemetryPerformanceTimingEnabled(true);
    const monitor = performanceMonitorRef.current;
    runtime.withControlledSceneObservers(() => monitor?.setFrameTimingEnabled(true, 2_000));
    const session = createEditorPerformanceRunSession(runtime.getTelemetryPerformanceMetrics(), Date.now,
      () => monitor?.getFrameTimingReport() ?? null);
    performanceRunSessionRef.current = session;
    setPerformanceRunSnapshot(session.getSnapshot());
    setPerformanceRunHudExpanded(true);
    return () => {
      session.stop(runtime.getTelemetryPerformanceMetrics());
      monitor?.setFrameTimingEnabled(false);
      runtime.setTelemetryPerformanceTimingEnabled(false);
      setPerformanceRunSnapshot(session.getSnapshot());
    };
  }, [isPerformanceRun, sceneSessionId]);

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
          // 与实际录制使用同一视角，避免固定眼高把不同楼层的节点误判为过近。
          const capturedWaypoint = createAutoPatrolWaypointFromWorldPose(
            pose,
            entity.components.transform,
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

  const stopOpeningForPatrol = opening.stop;
  /** Inspector 和悬浮控制器通过 Store 发出一次性播放命令。 */
  useEffect(() => {
    if (!autoPatrolPlaybackRequest) return;
    stopOpeningForPatrol();
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
    stopOpeningForPatrol,
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
      opening.stop();
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

  useSceneKeyboardShortcuts({
    pauseHistoryReplay, autoPatrolPlaybackRef, requestAutoPatrolCapture, environmentAdjustmentActive, setEnvironmentAdjustmentActive,
  });


  useEffect(() => {
    viewportRef.current?.setGridSettings(gridSettings);
  }, [gridSettings]);

  useEffect(() => {
    runtimeRef.current?.setTrajectoryVisible(trajectoryVisible);
  }, [trajectoryVisible]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const runtime = runtimeRef.current;
    // 场景设置单独同步，实体/选区变化不扩大此effect的触发边界。
    const currentDocument = sceneDocumentRef.current;
    if (!viewport || !runtime || !currentDocument) return;

    viewport.setViewDistance(currentDocument.sceneSettings.camera.viewDistance);
    viewport.setSensitivity(currentDocument.sceneSettings.sensitivity);
    if (sceneRuntimeStartupDeferred) return;
    runtime.syncDefaultCargoGenerator(currentDocument.sceneSettings.defaultCargoGeneratorId);
    runtime.syncAppearance(currentDocument);
    runtime.syncLighting(currentDocument);
    runtime.syncSkybox(currentDocument);
    if (!environmentApplyRequest && !environmentAdjustmentActive) {
      runtime.syncEnvironment(resolveEnvironmentRuntimeSettings(
        currentDocument.sceneSettings.environment,
        environmentRuntimeOverride,
        { deferEnvironmentLoad: environmentStartupRelinkSessionId === sceneSessionId },
      ));
    }
  }, [
    environmentAdjustmentActive,
    environmentApplyRequest,
    environmentRuntimeOverride,
    environmentStartupRelinkSessionId,
    sceneRuntimeStartupDeferred,
    sceneSessionId,
    sceneDocument.sceneSettings,
  ]);

  useSceneCameraTransition({
    cameraResetRequest, manualRoamSnapshot, viewportRef, cameraProjection, cameraOrientation, cameraPoseSaveRequest, consumeCameraPoseSaveRequest, regionViewRequest, manualRoamRef, stopOpening: opening.stop, pauseHistoryReplay, autoPatrolPlaybackRef, consumeCameraResetRequest, sceneDocument,
  });

  useEffect(() => {
    if (!entityArrayRequest) return;

    const runtime = runtimeRef.current;
    if (!runtime) {
      resolveEntityArrayRequest(entityArrayRequest.id, null);
      return;
    }

    const axis = getEntityArrayAxis(entityArrayRequest.direction);
    const source = sceneDocumentRef.current?.entities[entityArrayRequest.sourceIds[0]];
    const bounds = source?.composition ? null : runtime.getEntitiesWorldBounds(entityArrayRequest.sourceIds);
    const worldDirection = { x: axis === 'x' ? 1 : 0, y: axis === 'y' ? 1 : 0, z: axis === 'z' ? 1 : 0 };
    const selectionSpanMeters = source?.composition
      ? runtime.getEntityArrayGeometry(source.id, worldDirection)?.spanMeters ?? null
      : bounds?.geometryReady ? bounds.sizeMeters[axis] : null;
    resolveEntityArrayRequest(entityArrayRequest.id, selectionSpanMeters);
  }, [entityArrayRequest, resolveEntityArrayRequest]);

  useSceneFocusTransition({
    sceneFocusRequest, runtimeRef, viewportRef, manualRoamRef, sceneDocumentRef, sceneFocusPerformanceRef, consumeSceneFocusRequest, environmentFocusRequest, sceneDocument, consumeEnvironmentFocusRequest,
  });

  const entityArrayDialogValidationError = entityArrayDialog
    ? entityArrayDialog.commitError ?? getEntityArrayDialogError(sceneDocument, entityArrayDialog)
    : null;
  const entityArraySource = entityArrayDialog
    ? sceneDocument.entities[entityArrayDialog.sourceEntityId]
    : null;
  const entityArrayIdentityBehavior = getShiftEntityArrayIdentityBehavior(entityArraySource);
  const entityArrayAssetNumberedSourceCount = entityArrayIdentityBehavior === 'asset-number' ? 1 : 0;
  const compositionArrayInfo = entityArrayDialog
    ? getCompositionArrayInfo(sceneDocument, [entityArrayDialog.sourceEntityId], entityArrayDialog.value.copyCount)
    : null;

  /** 修改弹框参数时同步刷新临时 Babylon 阵列，不写入场景或命令历史。 */
  function handleEntityArrayDialogChange(value: EntityArrayDialogValue): void {
    if (!entityArrayDialog) return;

    const nextDialog = { ...entityArrayDialog, value, commitError: null };
    entityArrayDialogRef.current = nextDialog;
    setEntityArrayDialog(nextDialog);

    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (getEntityArrayDialogError(sceneDocumentRef.current ?? sceneDocument, nextDialog)) {
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

  const { handleCopyPerformanceReport, handleCopyPerformanceRunReport } = createScenePerformanceReportHandlers({
    performanceMonitorRef, performanceRunSessionRef, pushLog, getErrorMessage,
  });

  const overlayViewport = viewportRef.current;
  const overlayRuntime = runtimeRef.current;

  return (
    <section className={isRuntimePreview ? 'scene-panel scene-panel-preview' : 'scene-panel'}>
      <h2 className="scene-title"><span>Scene</span><CompositionEditStatus /></h2>
      <div className={(isRuntimePreview ? 'scene-viewport scene-viewport-preview' : 'scene-viewport') + (isRuntimePreview && opening.active ? ' opening-presentation-active' : '')}>
        <canvas
          ref={canvasRef}
          className="scene-canvas"
          onDragOver={handleCanvasDragOver}
          onDoubleClick={event => {
            if (isRuntimePreview) return;
            const id = runtimeRef.current?.pickEntityIdAtCanvasPoint(event.clientX, event.clientY, event.currentTarget);
            const state = useEditorStore.getState(), root = id ? findCompositionRoot(state.scene, id) : null;
            if (root) { state.setCompositionEditRoot(root); state.selectEntity(id!); }
          }}
          onDrop={handleCanvasDrop}
          onPointerDownCapture={handleEffectPathPointerDownCapture}
          onPointerMoveCapture={handleEffectPathPointerMoveCapture}
          onPointerUpCapture={handleEffectPathPointerUpCapture}
          onDoubleClickCapture={event => { if (getEffectPathDrawing()) { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); } }}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancelCapture={handleCanvasPointerCancel}
          onWheel={handleCanvasWheel}
        />
        <SceneViewportOverlays {...{
          isPerformanceRun, sceneResourcesReady, entranceRequired, entranceReadySession, sceneSessionId, entrancePreparationError, entrancePreparation, opening, isRuntimePreview, overlayViewport, overlayRuntime, canvasRef, handleDataPlatformScreenCommand, hierarchySelectionIds, selectedEntityId, handleViewportDataPlatformScreenCommand, sceneDocument, viewportCamera, viewportError, manualRoamSnapshot, pauseHistoryReplay, autoPatrolPlaybackRef, requestCameraReset, toggleCameraStandardView, cameraOrientation, hasManualRoamSpawn, handleManualRoamConfig, manualRoamRef, handleManualRoamEnabled, handleManualRoamLocomotionMode, handleManualRoamTouchAction, handleManualRoamViewMode, autoPatrolRoutes, autoPatrolHistory, autoPatrolPlaybackSnapshot, requestAutoPatrolPlayback, handleHistoryAction, environmentAdjustmentActive,
        }} performanceHud={<ScenePerformanceHud {...{
          showPerformanceHud, hasStoppedPerformanceReport, isPerformanceHudExpanded, performanceSnapshot, isPerformanceRun, setPerformanceRunHudExpanded, setPerformanceHudExpanded, performanceRunSnapshot, handleCopyPerformanceRunReport, handleCopyPerformanceReport,
        }} />} />
      </div>
      {entityArrayDialog ? (
        <EntityArrayDialog
          assetNumberedSourceCount={entityArrayAssetNumberedSourceCount}
          compositionArray={compositionArrayInfo ?? undefined}
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
