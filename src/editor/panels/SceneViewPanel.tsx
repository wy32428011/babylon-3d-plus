import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import {
  createBabylonViewport,
  type BabylonViewport,
  type BabylonViewportRuntimeStatus,
} from '../../runtime/babylon/createEngine';
import { MqttStackerTelemetryClient } from '../../runtime/mqtt/MqttStackerTelemetryClient';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import {
  TransformGizmoController,
  type ModelArrayDragUpdate,
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
  MODEL_ARRAY_MIN_SPAN_METERS,
} from '../model/modelArray';
import { EntityArrayDialog, type EntityArrayDialogValue } from '../ui/EntityArrayDialog';

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


type ModelArrayDialogState = {
  sourceEntityId: string;
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
function describeModelArrayDrag(update: ModelArrayDragUpdate): {
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

/** 校验 Shift 阵列弹框中的数量、间距、源模型和同步名称/编号。 */
function getModelArrayDialogError(
  scene: SceneDocument,
  dialog: ModelArrayDialogState,
): string | null {
  const parameterError = getEntityArrayParameterError(
    dialog.value.copyCount,
    dialog.value.spacingMeters,
  );
  if (parameterError) return parameterError;
  if (!Number.isFinite(dialog.spanMeters) || dialog.spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) {
    return '源模型在当前轴上的尺寸无效。';
  }

  const source = scene.entities[dialog.sourceEntityId];
  const parent = source?.parentId ? scene.entities[source.parentId] : null;
  if (!source?.components.modelAsset || source.locked || parent?.locked) {
    return '源模型已失效、被锁定或不再是普通导入模型。';
  }

  return getEntityArrayIdentifierError(
    scene,
    [dialog.sourceEntityId],
    dialog.value.copyCount,
    dialog.value.assetNumberRule,
  );
}

export function SceneViewPanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<BabylonViewport | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const gizmoRef = useRef<TransformGizmoController | null>(null);
  const mqttTelemetryClientRef = useRef<MqttStackerTelemetryClient | null>(null);
  const clickSnapshotRef = useRef<PointerClickSnapshot | null>(null);
  const sceneDocumentRef = useRef<SceneDocument | null>(null);
  const selectedEntityIdRef = useRef<string | null>(null);
  const runtimeModeRef = useRef<EditorRuntimeMode>('edit');
  const modelArrayDialogRef = useRef<ModelArrayDialogState | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [modelArrayDialog, setModelArrayDialog] = useState<ModelArrayDialogState | null>(null);
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
  const cameraTopViewRequest = useEditorStore((state) => state.cameraTopViewRequest);
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
  const consumeCameraTopViewRequest = useEditorStore((state) => state.consumeCameraTopViewRequest);
  const setSelectedModelMeasurement = useEditorStore((state) => state.setSelectedModelMeasurement);
  const pushLog = useEditorStore((state) => state.pushLog);
  const stopRuntimePreview = useEditorStore((state) => state.stopRuntimePreview);
  const isRuntimePreview = runtimeMode === 'preview';

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
  const closeModelArrayDialog = useCallback((): void => {
    modelArrayDialogRef.current = null;
    setModelArrayDialog(null);
    runtimeRef.current?.clearModelArrayPreview();
  }, []);

  useEffect(() => {
    sceneDocumentRef.current = sceneDocument;
    selectedEntityIdRef.current = selectedEntityId;
    modelArrayDialogRef.current = modelArrayDialog;
  }, [sceneDocument, selectedEntityId, modelArrayDialog]);


  /** 源模型、单选状态或编辑模式失效时取消弹框，避免临时克隆悬挂。 */
  useEffect(() => {
    if (!modelArrayDialog) return;

    const source = sceneDocument.entities[modelArrayDialog.sourceEntityId];
    const parent = source?.parentId ? sceneDocument.entities[source.parentId] : null;
    const activeSelectionIds = hierarchySelectionIds.length > 0
      ? hierarchySelectionIds.filter((entityId) => Boolean(sceneDocument.entities[entityId]))
      : selectedEntityId
        ? [selectedEntityId]
        : [];
    const sourceInvalid = !source?.components.modelAsset
      || source.locked
      || parent?.locked
      || selectedEntityId !== modelArrayDialog.sourceEntityId
      || activeSelectionIds.length !== 1
      || activeSelectionIds[0] !== modelArrayDialog.sourceEntityId;

    if (isRuntimePreview || sourceInvalid) closeModelArrayDialog();
  }, [
    closeModelArrayDialog,
    hierarchySelectionIds,
    isRuntimePreview,
    modelArrayDialog,
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
      viewport = createBabylonViewport(canvasRef.current, handleRuntimeStatus);
      runtime = new SceneRuntime(viewport.scene, pushLog, (entityId) => {
        const currentRuntime = runtimeRef.current;
        if (!currentRuntime || selectedEntityIdRef.current !== entityId) return;
        publishSelectedModelMeasurement(currentRuntime, entityId);
      });
      gizmo = new TransformGizmoController(viewport.scene, {
        previewTransform: previewEntityTransform,
        commitTransform: commitEntityTransform,
        beginModelArrayDrag: (context) => {
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
          if (modelArrayDialogRef.current) {
            pushLog('模型阵列已阻止：请先完成或取消当前阵列弹框。');
            return null;
          }
          if (activeSelectionIds.length !== 1 || activeSelectionIds[0] !== context.entityId) {
            pushLog('模型阵列已阻止：Shift 拖拽仅支持单个选中的导入模型。');
            return null;
          }
          if (!source?.components.modelAsset || source.locked || parent?.locked) {
            pushLog('模型阵列已阻止：请选择一个未锁定的普通导入模型。');
            return null;
          }

          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime) return null;
          const geometry = currentRuntime.getModelArrayGeometry(context.entityId, context.positiveDirection);
          if (!geometry) {
            pushLog('模型阵列已阻止：模型几何尚未加载完成或当前轴尺寸无效。');
            return null;
          }

          currentRuntime.clearModelArrayPreview();
          return { spanMeters: geometry.spanMeters };
        },
        previewModelArrayDrag: (update) => {
          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime) return;
          if (update.copyCount === 0) {
            currentRuntime.clearModelArrayPreview();
            return;
          }
          currentRuntime.updateModelArrayPreview(
            update.entityId,
            update.direction,
            update.copyCount,
            0,
          );
        },
        completeModelArrayDrag: (update) => {
          const currentRuntime = runtimeRef.current ?? runtime;
          if (!currentRuntime || update.copyCount === 0) {
            currentRuntime?.clearModelArrayPreview();
            return;
          }
          if (!currentRuntime.updateModelArrayPreview(update.entityId, update.direction, update.copyCount, 0)) {
            currentRuntime.clearModelArrayPreview();
            pushLog('模型阵列失败：无法创建模型临时预览。');
            return;
          }

          const description = describeModelArrayDrag(update);
          const dialog: ModelArrayDialogState = {
            sourceEntityId: update.entityId,
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
          modelArrayDialogRef.current = dialog;
          setModelArrayDialog(dialog);
        },
        cancelModelArrayDrag: () => {
          (runtimeRef.current ?? runtime)?.clearModelArrayPreview();
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

    const resize = () => initializedViewport.engine.resize();
    const cancelActiveGizmoDrag = () => initializedGizmo.cancelActiveDrag();
    window.addEventListener('resize', resize);
    window.addEventListener('blur', cancelActiveGizmoDrag);
    resize();

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', cancelActiveGizmoDrag);
      initializedMqttTelemetryClient?.dispose();
      initializedGizmo.dispose();
      initializedRuntime.dispose();
      initializedViewport.dispose();
      viewportRef.current = null;
      runtimeRef.current = null;
      gizmoRef.current = null;
      mqttTelemetryClientRef.current = null;
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

  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;
    if (isRuntimePreview) return;

    runtime.sync(sceneDocument);
    const selectedTarget = runtime.getGizmoTargetByEntityId(selectedEntityId);
    gizmo.attachToTarget(selectedTarget, selectedEntityId);
    publishSelectedModelMeasurement(runtime, selectedEntityId);
  }, [sceneDocument, selectedEntityId, isRuntimePreview, publishSelectedModelMeasurement]);

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
      runtime.sync(currentSceneDocument);
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

  /** 消费 Toolbar 的临时俯视请求，并在 Babylon 视口完成切换后清理请求。 */
  useEffect(() => {
    if (!cameraTopViewRequest) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.setTopView();
    consumeCameraTopViewRequest(cameraTopViewRequest.id);
  }, [cameraTopViewRequest, consumeCameraTopViewRequest]);

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

  const modelArrayDialogValidationError = modelArrayDialog
    ? modelArrayDialog.commitError ?? getModelArrayDialogError(sceneDocument, modelArrayDialog)
    : null;

  /** 修改弹框参数时同步刷新临时 Babylon 阵列，不写入场景或命令历史。 */
  function handleModelArrayDialogChange(value: EntityArrayDialogValue): void {
    if (!modelArrayDialog) return;

    const nextDialog = { ...modelArrayDialog, value, commitError: null };
    modelArrayDialogRef.current = nextDialog;
    setModelArrayDialog(nextDialog);

    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (getEntityArrayParameterError(value.copyCount, value.spacingMeters)) {
      runtime.clearModelArrayPreview();
      return;
    }
    runtime.updateModelArrayPreview(
      nextDialog.sourceEntityId,
      nextDialog.direction,
      value.copyCount,
      value.spacingMeters,
    );
  }

  /** 原子校验并提交正式阵列；失败时保留弹框和临时预览。 */
  function handleConfirmModelArrayDialog(): void {
    const dialog = modelArrayDialogRef.current;
    if (!dialog) return;

    const validationError = getModelArrayDialogError(sceneDocumentRef.current ?? sceneDocument, dialog);
    if (validationError) {
      const nextDialog = { ...dialog, commitError: validationError };
      modelArrayDialogRef.current = nextDialog;
      setModelArrayDialog(nextDialog);
      return;
    }

    const runtime = runtimeRef.current;
    const geometry = runtime?.getModelArrayGeometry(dialog.sourceEntityId, dialog.direction);
    if (!geometry) {
      const error = '模型几何尚未加载完成或当前轴尺寸无效。';
      const nextDialog = { ...dialog, commitError: error };
      modelArrayDialogRef.current = nextDialog;
      setModelArrayDialog(nextDialog);
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
      modelArrayDialogRef.current = nextDialog;
      setModelArrayDialog(nextDialog);
      return;
    }

    closeModelArrayDialog();
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
      {modelArrayDialog ? (
        <EntityArrayDialog
          assetNumberedSourceCount={1}
          directionLabel={modelArrayDialog.directionLabel}
          onCancel={closeModelArrayDialog}
          onChange={handleModelArrayDialogChange}
          onConfirm={handleConfirmModelArrayDialog}
          synchronizeModelIdentity
          validationError={modelArrayDialogValidationError}
          value={modelArrayDialog.value}
        />
      ) : null}
    </section>
  );
}
