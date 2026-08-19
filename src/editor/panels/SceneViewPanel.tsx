import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type WheelEvent } from 'react';
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
import { findBuiltInSlotEntityId } from '../model/builtInSlotBinding';
import { MqttStackerTelemetryClient } from '../../runtime/mqtt/MqttStackerTelemetryClient';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { createEntityGroupRotationDeltaMatrix } from '../../runtime/babylon/EntityGroupRotationPreview';
import {
  AutoPatrolPlaybackController,
  collectAutoPatrolPlaybackRoutes,
  findAutoStartPatrolRoute,
  type AutoPatrolPlaybackRoute,
} from '../../runtime/babylon/AutoPatrolPlaybackController';
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
import { getBuiltInMeshGroundOffsetMeters } from '../model/builtInMeshGeometry';
import { getLightEditorCapabilities } from '../model/lightEditor';
import { getAutoPatrolWaypointWorldPose } from '../model/autoPatrol';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import {
  getSceneSkyboxSettings,
  SKYBOX_FOCUS_VIEW_DISTANCE_METERS,
  SCENE_VIEW_DISTANCE_MAX,
  type SceneDocument,
} from '../model/SceneDocument';
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
  const mqttTelemetryClientRef = useRef<MqttStackerTelemetryClient | null>(null);
  const performanceMonitorRef = useRef<ScenePerformanceMonitor | null>(null);
  const sceneFocusPerformanceRef = useRef<SceneFocusPerformanceMetrics | null>(null);
  const clickSnapshotRef = useRef<SceneModelSelectionPointerSnapshot | null>(null);
  const sceneDocumentRef = useRef<SceneDocument | null>(null);
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
  const sceneDocument = useEditorStore((state) => state.scene);
  const sceneSessionId = useEditorStore((state) => state.sceneSessionId);
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
  const createPoiEffect = useEditorStore((state) => state.createPoiEffect);
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
  const hierarchyGroupTransformSelection = useMemo(
    () => resolveHierarchyGroupTransformSelection(sceneDocument, hierarchySelectionIds),
    [hierarchySelectionIds, sceneDocument],
  );

  const sceneRuntimeReadinessGeneration = sceneSessionId;

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

    const referenceEntityId = groupSelection.entityIds[0] ?? null;
    const rotation = referenceEntityId
      ? state.scene.entities[referenceEntityId]?.components.transform.rotation
      : null;
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
      const target = runtime.getFolderGroupGizmoTarget(
        groupSelection.groupId,
        groupSelection.entityIds,
        groupTool,
      );
      gizmo.attachToGroupTarget(target, groupSelection.groupId);
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
      supportedTools: selectedEntity?.components.autoPatrol
        ? ['translate', 'rotate']
        : lightCapabilities?.supportedTools,
      entityArrayEnabled: lightCapabilities === null && !selectedEntity?.components.autoPatrol,
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

    const pickedEntityId = isRuntimePreview
      ? runtimeRef.current?.pickRuntimeModelEntityIdAtCanvasPoint(
          selectionClick.clientX,
          selectionClick.clientY,
          event.currentTarget,
        ) ?? null
      : runtimeRef.current?.pickEntityIdAtCanvasPoint(
          selectionClick.clientX,
          selectionClick.clientY,
          event.currentTarget,
        ) ?? null;
    // 货架被点中时顺带反解内置货格命中格，输出 排-列-层 方便对照泊位；不改变任何选中行为。
    if (pickedEntityId) {
      const state = useEditorStore.getState();
      const locatorEntityId = findBuiltInSlotEntityId(state.scene, pickedEntityId);
      const cell = locatorEntityId
        ? runtimeRef.current?.pickLocatorCellAtCanvasPoint(
            selectionClick.clientX,
            selectionClick.clientY,
            event.currentTarget,
            locatorEntityId,
          ) ?? null
        : null;
      if (cell) {
        const host = state.scene.entities[pickedEntityId];
        const assetCode = host?.components.modelAsset?.assetCode;
        const hostLabel = `${host?.name ?? pickedEntityId}${assetCode ? `（${assetCode}）` : ''}`;
        state.pushLog(`命中货格：${hostLabel} ${cell.row}-${cell.column}-${cell.layer}（排-列-层）`);
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
    selectEntity(pickedEntityId);
  }
  /** 指针流程被浏览器取消时丢弃点击快照，并取消尚未完成的 Shift 阵列拖拽。 */
  function handleCanvasPointerCancel(): void {
    clickSnapshotRef.current = null;
    gizmoRef.current?.cancelActiveDrag();
  }

  /** 滚轮缩放属于手动相机接管，立即暂停自动巡检。 */
  function handleCanvasWheel(_event: WheelEvent<HTMLCanvasElement>): void {
    autoPatrolPlaybackRef.current?.notifyManualInput();
    autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
  }

  /** 仅当拖拽数据是模型资产或内置资源时允许浏览器在 Scene 画布触发 drop。 */
  function handleCanvasDragOver(event: DragEvent<HTMLCanvasElement>): void {
    if (isRuntimePreview) return;

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

    if (builtInAsset.kind === 'model-generator') {
      createModelGenerator(placementPosition);
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
    let unsubscribeAutoPatrolSnapshot: (() => void) | null = null;
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
      autoPatrolPlayback = new AutoPatrolPlaybackController({
        readPose: () => viewport!.getCameraPose(),
        writePose: (pose) => viewport!.applyCameraPose(pose, { animate: false }),
        now: readScenePanelTimestampMs,
        subscribeFrame: (callback) => {
          const observer = viewport!.scene.onBeforeRenderObservable.add(callback);
          return () => viewport?.scene.onBeforeRenderObservable.remove(observer);
        },
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
      unsubscribeAutoPatrolSnapshot?.();
      autoPatrolPlayback?.dispose();
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
    const initializedUnsubscribeAutoPatrolSnapshot = unsubscribeAutoPatrolSnapshot;
    const initializedMqttTelemetryClient = mqttTelemetryClient;
    viewportRef.current = viewport;
    setViewportCamera(viewport.camera);
    runtimeRef.current = runtime;
    gizmoRef.current = gizmo;
    autoPatrolPlaybackRef.current = autoPatrolPlayback;
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
    const resize = () => initializedViewport.engine.resize();
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
      initializedUnsubscribeAutoPatrolSnapshot?.();
      initializedAutoPatrolPlayback?.dispose();
      initializedGizmo.dispose();
      initializedRuntime.dispose();
      initializedViewport.dispose();
      viewportRef.current = null;
      setViewportCamera(null);
      runtimeRef.current = null;
      gizmoRef.current = null;
      autoPatrolPlaybackRef.current = null;
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
      if (preparationState.sceneSessionId !== sceneSessionId || preparationState.completed) {
        stopReadinessPolling();
        return;
      }
      if (preparationState.assetRefreshStatus !== 'settled') {
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

      reportSceneRuntimeProgress(sceneSessionId, {
        generation: sceneRuntimeReadinessGeneration,
        totalModels: modelEntityIds.length,
        settledModels,
        expectedBatchedEntities,
        batchedEntities,
        stable,
      });

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
        && !preparationState.completed
      ) {
        intervalId = window.setInterval(sampleReadiness, 250);
      }
    };

    const unsubscribeScenePreparation = subscribeScenePreparation(() => {
      const preparationState = getScenePreparationSnapshot();
      if (preparationState.sceneSessionId !== sceneSessionId || preparationState.completed) {
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
      const referenceEntityId = selection.entityIds[0];
      const currentRotation = state.scene.entities[referenceEntityId]?.components.transform.rotation;
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
      consumeAutoPatrolCameraRequest(autoPatrolCameraRequest.id, viewport?.getCameraPose());
      return;
    }

    const entity = sceneDocument.entities[autoPatrolCameraRequest.entityId];
    const waypoint = entity?.components.autoPatrol?.waypoints.find((item) => (
      item.id === autoPatrolCameraRequest.waypointId
    ));
    if (viewport && entity && waypoint) {
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

    let result: { ok: true } | { ok: false; error: string } | null = null;
    switch (autoPatrolPlaybackRequest.action) {
      case 'start':
        result = autoPatrolPlaybackRequest.routeId
          ? controller.start(autoPatrolPlaybackRequest.routeId)
          : { ok: false, error: '未选择巡检路线。' };
        break;
      case 'pause':
        result = controller.pause(false);
        break;
      case 'resume':
        result = controller.resume();
        break;
      case 'stop':
        controller.stop();
        break;
      case 'return':
        result = controller.returnToStart();
        break;
    }
    if (result && !result.ok) pushLog(result.error);
    consumeAutoPatrolPlaybackRequest(autoPatrolPlaybackRequest.id);
  }, [autoPatrolPlaybackRequest, consumeAutoPatrolPlaybackRequest, pushLog]);

  /** 每次进入运行预览只尝试一次自动启动；退出时停止且保留当前视角。 */
  useEffect(() => {
    const controller = autoPatrolPlaybackRef.current;
    if (!controller) return;
    if (!isRuntimePreview) {
      if (autoPatrolPreviewStartedRef.current) controller.stop();
      autoPatrolPreviewStartedRef.current = false;
      return;
    }
    if (autoPatrolPreviewStartedRef.current) return;
    autoPatrolPreviewStartedRef.current = true;
    controller.setRoutes(autoPatrolRoutes);
    const route = findAutoStartPatrolRoute(autoPatrolRoutes);
    if (!route) return;
    const result = controller.start(route.entityId);
    if (!result.ok) pushLog(result.error);
  }, [autoPatrolRoutes, isRuntimePreview, pushLog]);

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
      autoPatrolPlaybackRef.current?.notifyManualInput();
      autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [requestAutoPatrolCapture]);

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
    runtime.syncSkybox(sceneDocument);
    if (!environmentApplyRequest && !environmentAdjustmentActive) {
      runtime.syncEnvironment(sceneDocument.sceneSettings.environment);
    }
  }, [
    environmentAdjustmentActive,
    environmentApplyRequest,
    sceneDocument.sceneSettings,
  ]);

  /** 复位请求由原子视角应用负责，普通切换则先同步投影再驱动方向动画。 */
  useEffect(() => {
    if (cameraResetRequest) return;
    viewportRef.current?.setCameraProjection(cameraProjection);
  }, [cameraProjection, cameraResetRequest]);

  useEffect(() => {
    if (cameraResetRequest) return;
    viewportRef.current?.setCameraOrientation(cameraOrientation);
  }, [cameraOrientation, cameraResetRequest]);

  useEffect(() => {
    if (!cameraPoseSaveRequest) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    consumeCameraPoseSaveRequest(cameraPoseSaveRequest.id, viewport.getCameraPose());
  }, [cameraPoseSaveRequest, consumeCameraPoseSaveRequest]);

  useEffect(() => {
    if (!cameraResetRequest) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    applySavedSceneCameraView(viewport, sceneDocument.sceneSettings.camera);
    consumeCameraResetRequest(cameraResetRequest.id);
  }, [cameraResetRequest, consumeCameraResetRequest, sceneDocument.sceneSettings.camera]);

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
      const currentScene = sceneDocumentRef.current;
      const containsSkybox = sceneFocusRequest.entityIds.some((entityId) => (
        Boolean(currentScene?.entities[entityId]?.components.skybox)
      ));
      viewport.setViewDistance(
        containsSkybox
          ? SKYBOX_FOCUS_VIEW_DISTANCE_METERS
          : currentScene?.sceneSettings.camera.viewDistance ?? SCENE_VIEW_DISTANCE_MAX,
      );
      viewport.focusOnBounds(bounds);
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
      const requiredViewDistance = Math.min(
        SCENE_VIEW_DISTANCE_MAX,
        Math.max(sceneDocument.sceneSettings.camera.viewDistance, Math.ceil(bounds.radiusMeters * 4)),
      );
      viewport.setViewDistance(requiredViewDistance);
      viewport.focusOnBounds(bounds);
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
        <ViewportOrientationCompass
          camera={viewportCamera}
          disabled={Boolean(viewportError)}
          onReset={requestCameraReset}
          onToggleStandardView={toggleCameraStandardView}
          orientation={cameraOrientation}
        />
        {isRuntimePreview && autoPatrolRoutes.length > 0 ? (
          <AutoPatrolControls
            routes={autoPatrolRoutes}
            snapshot={autoPatrolPlaybackSnapshot}
            onAction={(action, routeId) => requestAutoPatrolPlayback(action, routeId)}
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
