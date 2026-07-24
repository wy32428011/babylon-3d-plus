import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import {
  createBabylonViewport,
  type BabylonViewport,
  type BabylonViewportRuntimeStatus,
} from '../../runtime/babylon/createEngine';
import { MqttStackerTelemetryClient } from '../../runtime/mqtt/MqttStackerTelemetryClient';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import {
  ScenePerformanceMonitor,
  type EditModeThinInstancePlanPerformanceMetrics,
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
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import {
  useEditorStore,
  type EntityArrayDirection,
} from '../store/editorStore';
import { getBuiltInMeshGroundOffsetMeters } from '../model/builtInMeshGeometry';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import type { SceneCameraPose, SceneDocument } from '../model/SceneDocument';
import type { Vector3Data } from '../model/math';
import {
  getEntityArrayIdentifierError,
  getEntityArrayParameterError,
  getShiftEntityArrayIdentityBehavior,
  isShiftEntityArraySupported,
  MODEL_ARRAY_MIN_SPAN_METERS,
} from '../model/modelArray';
import {
  createEditModeModelThinInstancePlan,
  type EditModeModelThinInstancePlan,
} from '../model/editModeModelThinInstances';
import { EntityArrayDialog, type EntityArrayDialogValue } from '../ui/EntityArrayDialog';
import '../../styles/scene-performance.css';

const CLICK_SELECTION_TOLERANCE_PX = 4;
const CAMERA_POSE_CHANGE_EPSILON = 1e-6;

type PointerClickSnapshot = {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  cameraPose: SceneCameraPose | null;
  cameraDragged: boolean;
};


type EntityArrayDialogState = {
  sourceEntityId: string;
  sourceSceneDocument: SceneDocument;
  direction: Vector3Data;
  spanMeters: number;
  directionLabel: string;
  value: EntityArrayDialogValue;
  commitError: string | null;
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

/** 判断指针交互前后相机是否发生有效位姿变化，让真实视角拖拽优先于模型拾取。 */
function hasCameraPoseChanged(before: SceneCameraPose | null, after: SceneCameraPose | null): boolean {
  if (!before || !after) return false;

  return (
    Math.abs(after.alpha - before.alpha) > CAMERA_POSE_CHANGE_EPSILON ||
    Math.abs(after.beta - before.beta) > CAMERA_POSE_CHANGE_EPSILON ||
    Math.abs(after.radius - before.radius) > CAMERA_POSE_CHANGE_EPSILON ||
    Math.abs(after.target.x - before.target.x) > CAMERA_POSE_CHANGE_EPSILON ||
    Math.abs(after.target.y - before.target.y) > CAMERA_POSE_CHANGE_EPSILON ||
    Math.abs(after.target.z - before.target.z) > CAMERA_POSE_CHANGE_EPSILON
  );
}

/** 判断 Babylon 相机是否已经累计本帧用户输入，覆盖位姿尚未刷新到 alpha/beta 的快速拖拽。 */
function hasPendingCameraInput(viewport: BabylonViewport | null): boolean {
  const movement = viewport?.camera.movement;
  if (!movement) return false;

  return (
    movement.activeInput ||
    Math.abs(movement.zoomAccumulatedPixels) > CAMERA_POSE_CHANGE_EPSILON ||
    movement.panAccumulatedPixels.lengthSquared() > CAMERA_POSE_CHANGE_EPSILON ||
    movement.rotationAccumulatedPixels.lengthSquared() > CAMERA_POSE_CHANGE_EPSILON
  );
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
  const mqttTelemetryClientRef = useRef<MqttStackerTelemetryClient | null>(null);
  const performanceMonitorRef = useRef<ScenePerformanceMonitor | null>(null);
  const clickSnapshotRef = useRef<PointerClickSnapshot | null>(null);
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
  const selectedEntityIdRef = useRef<string | null>(null);
  const runtimeModeRef = useRef<EditorRuntimeMode>('edit');
  const entityArrayDialogRef = useRef<EntityArrayDialogState | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [entityArrayDialog, setEntityArrayDialog] = useState<EntityArrayDialogState | null>(null);
  const [performanceSnapshot, setPerformanceSnapshot] = useState<ScenePerformanceSnapshot | null>(null);
  const [performanceHudExpanded, setPerformanceHudExpanded] = useState(false);
  const sceneDocument = useEditorStore((state) => state.scene);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const hierarchySelectionIds = useEditorStore((state) => state.hierarchySelectionIds);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const entityArrayRequest = useEditorStore((state) => state.entityArrayRequest);
  const sceneFocusRequest = useEditorStore((state) => state.sceneFocusRequest);
  const cameraPoseSaveRequest = useEditorStore((state) => state.cameraPoseSaveRequest);
  const cameraResetRequest = useEditorStore((state) => state.cameraResetRequest);
  const cameraOrientation = useEditorStore((state) => state.cameraOrientation);
  const cameraProjection = useEditorStore((state) => state.cameraProjection);
  const selectEntity = useEditorStore((state) => state.selectEntity);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const createModelGenerator = useEditorStore((state) => state.createModelGenerator);
  const createPoiEffect = useEditorStore((state) => state.createPoiEffect);
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const previewEntityTransform = useEditorStore((state) => state.previewEntityTransform);
  const commitEntityTransform = useEditorStore((state) => state.commitEntityTransform);
  const resolveEntityArrayRequest = useEditorStore((state) => state.resolveEntityArrayRequest);
  const commitResolvedEntityArray = useEditorStore((state) => state.commitResolvedEntityArray);
  const consumeSceneFocusRequest = useEditorStore((state) => state.consumeSceneFocusRequest);
  const consumeCameraPoseSaveRequest = useEditorStore((state) => state.consumeCameraPoseSaveRequest);
  const consumeCameraResetRequest = useEditorStore((state) => state.consumeCameraResetRequest);
  const setSelectedModelMeasurement = useEditorStore((state) => state.setSelectedModelMeasurement);
  const pushLog = useEditorStore((state) => state.pushLog);
  const stopRuntimePreview = useEditorStore((state) => state.stopRuntimePreview);
  const isRuntimePreview = runtimeMode === 'preview';
  const editModeThinInstancePlanComputation = useMemo(() => {
    const startedAt = readScenePanelTimestampMs();
    const plan = createEditModeModelThinInstancePlan(
      sceneDocument,
      editModeThinInstancePlanRef.current ?? undefined,
    );
    return {
      plan,
      durationMs: Math.max(0, readScenePanelTimestampMs() - startedAt),
      entityCount: sceneDocument.entityIds.length,
    };
  }, [sceneDocument.entityIds, sceneDocument.entities]);
  const editModeThinInstancePlan = editModeThinInstancePlanComputation.plan;
  const editRuntimeSceneDocument = useMemo(
    () => editModeThinInstancePlan.entities === sceneDocument.entities
      ? sceneDocument
      : { ...sceneDocument, entities: editModeThinInstancePlan.entities },
    [editModeThinInstancePlan.entities, sceneDocument],
  );

  /** 把当前普通导入模型的运行时尺寸发布到临时 Inspector 状态。 */
  const publishSelectedModelMeasurement = useCallback((runtime: SceneRuntime, entityId: string | null): void => {
    const currentScene = sceneDocumentRef.current;
    const selectedEntity = entityId && currentScene ? currentScene.entities[entityId] : null;
    if (!entityId || !selectedEntity?.components.modelAsset) {
      setSelectedModelMeasurement(null);
      return;
    }

    const measurement = runtime.getModelMeasurement(entityId);
    setSelectedModelMeasurement({ entityId, ...measurement });
  }, [setSelectedModelMeasurement]);


  /** 清除 Shift 阵列弹框和全部 Babylon 临时克隆。 */
  const closeEntityArrayDialog = useCallback((): void => {
    entityArrayDialogRef.current = null;
    setEntityArrayDialog(null);
    runtimeRef.current?.clearEntityArrayPreview();
  }, []);

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
    sceneDocumentRef.current = sceneDocument;
    editRuntimeSceneDocumentRef.current = editRuntimeSceneDocument;
    selectedEntityIdRef.current = selectedEntityId;
    entityArrayDialogRef.current = entityArrayDialog;
  }, [
    editModeThinInstancePlan,
    editModeThinInstancePlanComputation,
    editRuntimeSceneDocument,
    sceneDocument,
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

  /** 记录左键按下位置，用于区分单击选中和拖拽旋转视角。 */
  function handleCanvasPointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0 || gizmoRef.current?.isPointerUsingGizmo()) {
      clickSnapshotRef.current = null;
      return;
    }

    clickSnapshotRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      cameraPose: viewportRef.current?.getCameraPose() ?? null,
      cameraDragged: false,
    };
  }

  /** 在本次左键会话中锁存真实相机输入，避免快速微拖拽尚未刷新位姿时仍被当作模型点击。 */
  function handleCanvasPointerMove(event: PointerEvent<HTMLCanvasElement>): void {
    const snapshot = clickSnapshotRef.current;
    if (!snapshot || snapshot.pointerId !== event.pointerId || (event.buttons & 1) === 0) return;
    if (event.movementX === 0 && event.movementY === 0) return;

    const pointerId = event.pointerId;
    queueMicrotask(() => {
      const currentSnapshot = clickSnapshotRef.current;
      if (!currentSnapshot || currentSnapshot.pointerId !== pointerId) return;

      const viewport = viewportRef.current;
      const currentCameraPose = viewport?.getCameraPose() ?? null;
      if (hasPendingCameraInput(viewport) || hasCameraPoseChanged(currentSnapshot.cameraPose, currentCameraPose)) {
        currentSnapshot.cameraDragged = true;
      }
    });
  }

  /** 左键释放时先让视角拖拽优先，只有未驱动相机的短距离交互才执行对象拾取。 */
  function handleCanvasPointerUp(event: PointerEvent<HTMLCanvasElement>): void {
    const snapshot = clickSnapshotRef.current;
    clickSnapshotRef.current = null;

    if (!snapshot || snapshot.pointerId !== event.pointerId || snapshot.button !== event.button) return;
    if (gizmoRef.current?.isPointerUsingGizmo()) return;

    const currentCameraPose = viewportRef.current?.getCameraPose() ?? null;
    if (snapshot.cameraDragged || hasCameraPoseChanged(snapshot.cameraPose, currentCameraPose)) return;

    const movedDistance = Math.hypot(event.clientX - snapshot.clientX, event.clientY - snapshot.clientY);
    if (movedDistance > CLICK_SELECTION_TOLERANCE_PX) return;

    const pickedEntityId = runtimeRef.current?.pickEntityIdAtCanvasPoint(
      event.clientX,
      event.clientY,
      event.currentTarget,
    );
    selectEntity(pickedEntityId ?? null);
  }

  /** 指针流程被浏览器取消时丢弃点击快照，并取消尚未完成的 Shift 阵列拖拽。 */
  function handleCanvasPointerCancel(): void {
    clickSnapshotRef.current = null;
    gizmoRef.current?.cancelActiveDrag();
  }

  /** 仅当拖拽数据是模型资产或内置资源时允许浏览器在 Scene 画布触发 drop。 */
  function handleCanvasDragOver(event: DragEvent<HTMLCanvasElement>): void {
    if (isRuntimePreview) return;

    const hasSupportedPayload =
      event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE) ||
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
      runtime = new SceneRuntime(viewport.scene, pushLog, (entityId) => {
        const currentRuntime = runtimeRef.current;
        if (!currentRuntime || selectedEntityIdRef.current !== entityId) return;
        publishSelectedModelMeasurement(currentRuntime, entityId);
      });
      gizmo = new TransformGizmoController(viewport.scene, {
        previewTransform: previewEntityTransform,
        commitTransform: commitEntityTransform,
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
      });
      mqttTelemetryClient = new MqttStackerTelemetryClient(pushLog);
    } catch (error) {
      console.error('Scene View 渲染引擎初始化失败。', error);
      mqttTelemetryClient?.dispose();
      gizmo?.dispose();
      runtime?.dispose();
      viewport?.dispose();
      setViewportError(`Scene View 渲染引擎初始化失败：${getErrorMessage(error)}`);
      stopRuntimePreview();
      return;
    }

    const initializedViewport = viewport;
    const initializedRuntime = runtime;
    const initializedGizmo = gizmo;
    const initializedMqttTelemetryClient = mqttTelemetryClient;
    viewportRef.current = viewport;
    runtimeRef.current = runtime;
    gizmoRef.current = gizmo;
    mqttTelemetryClientRef.current = mqttTelemetryClient;

    try {
      performanceMonitor = new ScenePerformanceMonitor(viewport.engine, viewport.scene, {
        getRuntimeMetrics: () => runtimeRef.current?.getPerformanceMetrics() ?? initializedRuntime.getPerformanceMetrics(),
        getEditThinInstancePlanMetrics: () => editModeThinInstancePlanPerformanceRef.current,
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
      initializedGizmo.dispose();
      initializedRuntime.dispose();
      initializedViewport.dispose();
      viewportRef.current = null;
      runtimeRef.current = null;
      gizmoRef.current = null;
      mqttTelemetryClientRef.current = null;
      performanceMonitorRef.current = null;
      setPerformanceSnapshot(null);
      setSelectedModelMeasurement(null);
    };
  }, [
    previewEntityTransform,
    commitEntityTransform,
    publishSelectedModelMeasurement,
    pushLog,
    setSelectedModelMeasurement,
    stopRuntimePreview,
  ]);

  /** 文档内容变化才进入完整 SceneRuntime 同步；纯选择变化由下方专用 effect 处理。 */
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;
    if (isRuntimePreview || runtimeModeRef.current !== 'edit') return;

    runtime.sync(editRuntimeSceneDocument);
    const selectedTarget = runtime.getGizmoTargetByEntityId(selectedEntityIdRef.current);
    gizmo.attachToTarget(selectedTarget, selectedEntityIdRef.current);
    publishSelectedModelMeasurement(runtime, selectedEntityIdRef.current);
  }, [
    editRuntimeSceneDocument.entityIds,
    editRuntimeSceneDocument.entities,
    isRuntimePreview,
    publishSelectedModelMeasurement,
  ]);

  /** 单选/文件夹选区变化只刷新目标表现、Gizmo 和 Inspector 测量，不重新扫描全场景。 */
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;
    if (isRuntimePreview || runtimeModeRef.current !== 'edit') return;

    runtime.syncSelection(editRuntimeSceneDocument);
    const selectedTarget = runtime.getGizmoTargetByEntityId(selectedEntityId);
    gizmo.attachToTarget(selectedTarget, selectedEntityId);
    publishSelectedModelMeasurement(runtime, selectedEntityId);
  }, [editRuntimeSceneDocument, selectedEntityId, isRuntimePreview, publishSelectedModelMeasurement]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    const client = mqttTelemetryClientRef.current;
    if (!runtime || !gizmo || !client) return;
    if (runtimeModeRef.current === runtimeMode) return;
    runtimeModeRef.current = runtimeMode;

    if (!isRuntimePreview) {
      const currentSceneDocument = sceneDocumentRef.current;
      if (!currentSceneDocument) return;
      client.dispose();
      runtime.endTelemetryPreview();
      runtime.sync(editRuntimeSceneDocumentRef.current ?? currentSceneDocument);
      const selectedTarget = runtime.getGizmoTargetByEntityId(selectedEntityIdRef.current);
      gizmo.attachToTarget(selectedTarget, selectedEntityIdRef.current);
      publishSelectedModelMeasurement(runtime, selectedEntityIdRef.current);
      return;
    }

    try {
      const currentSceneDocument = sceneDocumentRef.current;
      if (!currentSceneDocument) return;
      gizmo.attachToTarget(null, null);
      runtime.sync(currentSceneDocument);
      runtime.beginTelemetryPreview();
      client.updateConfig(mqttConfig);
      publishSelectedModelMeasurement(runtime, selectedEntityIdRef.current);
      void runtime.handleFetchGeneratorEvent(currentSceneDocument.fetchConfig);
    } catch (error) {
      const message = getErrorMessage(error);
      pushLog(`运行预览初始化失败：${message}`);
      stopRuntimePreview();
    }
  }, [runtimeMode, isRuntimePreview, mqttConfig, publishSelectedModelMeasurement, pushLog, stopRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) return;
    mqttTelemetryClientRef.current?.updateConfig(mqttConfig);
  }, [mqttConfig, isRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) gizmoRef.current?.setTool(transformTool);
  }, [transformTool, isRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) gizmoRef.current?.setTransformSpace(transformSpace);
  }, [transformSpace, isRuntimePreview]);

  useEffect(() => {
    if (!isRuntimePreview) gizmoRef.current?.setSnapSettings(snapSettings);
  }, [snapSettings, isRuntimePreview]);

  useEffect(() => {
    viewportRef.current?.setGridSettings(gridSettings);
  }, [gridSettings]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const runtime = runtimeRef.current;
    if (!viewport || !runtime) return;

    viewport.setViewDistance(sceneDocument.sceneSettings.camera.viewDistance);
    viewport.setSensitivity(sceneDocument.sceneSettings.sensitivity);
    runtime.syncEnvironment(sceneDocument.sceneSettings.environment);
  }, [sceneDocument.sceneSettings]);

  /**
   * 把持久的视图状态同步到 Babylon 视口，状态驱动天然幂等。
   * 注意声明顺序必须先于 cameraResetRequest 的消费 effect：复位视角会同时把
   * orientation 置回 'orbit'，需要先退出俯视的角度锁定再应用保存的位姿。
   */
  useEffect(() => {
    viewportRef.current?.setCameraOrientation(cameraOrientation);
  }, [cameraOrientation]);

  useEffect(() => {
    viewportRef.current?.setCameraProjection(cameraProjection);
  }, [cameraProjection]);

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

    viewport.applyCameraPose(sceneDocument.sceneSettings.camera.savedPose);
    consumeCameraResetRequest(cameraResetRequest.id);
  }, [cameraResetRequest, consumeCameraResetRequest, sceneDocument.sceneSettings.camera.savedPose]);

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
    if (bounds) viewport.focusOnBounds(bounds);
    consumeSceneFocusRequest(sceneFocusRequest.id);
  }, [sceneFocusRequest, consumeSceneFocusRequest]);

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
        />
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
