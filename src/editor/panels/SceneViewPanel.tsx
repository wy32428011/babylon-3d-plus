import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import {
  createBabylonViewport,
  type BabylonViewport,
  type BabylonViewportRuntimeStatus,
} from '../../runtime/babylon/createEngine';
import { MqttStackerTelemetryClient } from '../../runtime/mqtt/MqttStackerTelemetryClient';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { TransformGizmoController } from '../../runtime/babylon/TransformGizmoController';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  decodeBuiltInAssetDragPayload,
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import { useEditorStore, type EntityArrayDirection } from '../store/editorStore';
import { getBuiltInMeshGroundOffsetMeters } from '../model/builtInMeshGeometry';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import type { SceneCameraPose, SceneDocument } from '../model/SceneDocument';

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
  const [viewportError, setViewportError] = useState<string | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
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

  useEffect(() => {
    sceneDocumentRef.current = sceneDocument;
    selectedEntityIdRef.current = selectedEntityId;
  }, [sceneDocument, selectedEntityId]);

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

  /** 指针流程被浏览器取消时丢弃待判定的点击快照。 */
  function handleCanvasPointerCancel(): void {
    clickSnapshotRef.current = null;
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
    window.addEventListener('resize', resize);
    resize();

    return () => {
      window.removeEventListener('resize', resize);
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
          onPointerCancel={handleCanvasPointerCancel}
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
    </section>
  );
}
