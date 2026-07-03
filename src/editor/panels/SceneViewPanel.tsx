import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { createBabylonViewport, type BabylonViewport } from '../../runtime/babylon/createEngine';
import { MqttStackerTelemetryClient } from '../../runtime/mqtt/MqttStackerTelemetryClient';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { TransformGizmoController } from '../../runtime/babylon/TransformGizmoController';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  decodeBuiltInAssetDragPayload,
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import { useEditorStore } from '../store/editorStore';

const CLICK_SELECTION_TOLERANCE_PX = 4;

type PointerClickSnapshot = {
  button: number;
  clientX: number;
  clientY: number;
};

/** 将未知异常转换成可展示的简短消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SceneViewPanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<BabylonViewport | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const gizmoRef = useRef<TransformGizmoController | null>(null);
  const mqttTelemetryClientRef = useRef<MqttStackerTelemetryClient | null>(null);
  const clickSnapshotRef = useRef<PointerClickSnapshot | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const cameraSettings = useEditorStore((state) => state.cameraSettings);
  const sceneFocusRequest = useEditorStore((state) => state.sceneFocusRequest);
  const selectEntity = useEditorStore((state) => state.selectEntity);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const previewEntityTransform = useEditorStore((state) => state.previewEntityTransform);
  const commitEntityTransform = useEditorStore((state) => state.commitEntityTransform);
  const consumeSceneFocusRequest = useEditorStore((state) => state.consumeSceneFocusRequest);
  const pushLog = useEditorStore((state) => state.pushLog);

  /** 记录左键按下位置，用于区分单击选中和拖拽旋转视角。 */
  function handleCanvasPointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0 || gizmoRef.current?.isPointerUsingGizmo()) {
      clickSnapshotRef.current = null;
      return;
    }

    clickSnapshotRef.current = {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  /** 左键短距离释放时执行对象拾取，空白区域会清空当前选择。 */
  function handleCanvasPointerUp(event: PointerEvent<HTMLCanvasElement>): void {
    const snapshot = clickSnapshotRef.current;
    clickSnapshotRef.current = null;

    if (!snapshot || snapshot.button !== event.button) return;
    if (gizmoRef.current?.isPointerUsingGizmo()) return;

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
    const hasSupportedPayload =
      event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE) ||
      event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE);
    if (!hasSupportedPayload) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /** 在鼠标释放位置把模型资产或内置资源投射到地面平面并创建场景实体。 */
  function handleCanvasDrop(event: DragEvent<HTMLCanvasElement>): void {
    const placementPosition = runtimeRef.current?.getGroundPointAtCanvasPoint(
      event.clientX,
      event.clientY,
      event.currentTarget,
    ) ?? { x: 0, y: 0, z: 0 };

    const rawModelPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
    const modelAsset = decodeModelAssetDragPayload(rawModelPayload);
    if (modelAsset) {
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

    if (builtInAsset.kind === 'mesh') {
      createMesh(builtInAsset.meshKind, placementPosition);
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

    try {
      viewport = createBabylonViewport(canvasRef.current);
      runtime = new SceneRuntime(viewport.scene, pushLog);
      gizmo = new TransformGizmoController(viewport.scene, {
        previewTransform: previewEntityTransform,
        commitTransform: commitEntityTransform,
      });
      mqttTelemetryClient = new MqttStackerTelemetryClient(pushLog);
      setViewportError(null);
    } catch (error) {
      console.error('Scene View 渲染引擎初始化失败。', error);
      mqttTelemetryClient?.dispose();
      gizmo?.dispose();
      runtime?.dispose();
      viewport?.dispose();
      setViewportError(`Scene View 渲染引擎初始化失败：${getErrorMessage(error)}`);
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
    };
  }, [previewEntityTransform, commitEntityTransform, pushLog]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;

    runtime.sync(sceneDocument);
    const selectedTarget = runtime.getGizmoTargetByEntityId(selectedEntityId);
    gizmo.attachToTarget(selectedTarget, selectedEntityId);
  }, [sceneDocument, selectedEntityId]);

  useEffect(() => {
    mqttTelemetryClientRef.current?.updateConfig(mqttConfig);
  }, [mqttConfig]);

  useEffect(() => {
    gizmoRef.current?.setTool(transformTool);
  }, [transformTool]);

  useEffect(() => {
    gizmoRef.current?.setTransformSpace(transformSpace);
  }, [transformSpace]);

  useEffect(() => {
    gizmoRef.current?.setSnapSettings(snapSettings);
  }, [snapSettings]);

  useEffect(() => {
    viewportRef.current?.setGridSettings(gridSettings);
  }, [gridSettings]);

  useEffect(() => {
    viewportRef.current?.setCameraSettings(cameraSettings);
  }, [cameraSettings]);

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
    <section className="scene-panel">
      <h2>Scene</h2>
      <div className="scene-viewport">
        <canvas
          ref={canvasRef}
          className="scene-canvas"
          onDragOver={handleCanvasDragOver}
          onDrop={handleCanvasDrop}
          onPointerDown={handleCanvasPointerDown}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerCancel}
        />
        {viewportError ? (
          <div className="scene-error" role="alert">
            <strong>Scene View 无法启动</strong>
            <p>{viewportError}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
