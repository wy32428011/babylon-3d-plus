import { useEffect, useRef, type DragEvent, type PointerEvent } from 'react';
import { createBabylonViewport, type BabylonViewport } from '../../runtime/babylon/createEngine';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { TransformGizmoController } from '../../runtime/babylon/TransformGizmoController';
import {
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

export function SceneViewPanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<BabylonViewport | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const gizmoRef = useRef<TransformGizmoController | null>(null);
  const clickSnapshotRef = useRef<PointerClickSnapshot | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const selectEntity = useEditorStore((state) => state.selectEntity);
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const previewEntityTransform = useEditorStore((state) => state.previewEntityTransform);
  const commitEntityTransform = useEditorStore((state) => state.commitEntityTransform);

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

  /** 仅当拖拽数据是模型资产时允许浏览器在 Scene 画布触发 drop。 */
  function handleCanvasDragOver(event: DragEvent<HTMLCanvasElement>): void {
    if (!event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /** 在鼠标释放位置把模型资产投射到地面平面并创建场景实体。 */
  function handleCanvasDrop(event: DragEvent<HTMLCanvasElement>): void {
    const rawPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
    const asset = decodeModelAssetDragPayload(rawPayload);
    if (!asset) return;

    event.preventDefault();
    clickSnapshotRef.current = null;

    const placementPosition = runtimeRef.current?.getGroundPointAtCanvasPoint(
      event.clientX,
      event.clientY,
      event.currentTarget,
    ) ?? { x: 0, y: 0, z: 0 };
    importModelAsset(asset, placementPosition);
  }

  useEffect(() => {
    if (!canvasRef.current) return;

    const viewport = createBabylonViewport(canvasRef.current);
    const runtime = new SceneRuntime(viewport.scene);
    const gizmo = new TransformGizmoController(viewport.scene, {
      previewTransform: previewEntityTransform,
      commitTransform: commitEntityTransform,
    });
    viewportRef.current = viewport;
    runtimeRef.current = runtime;
    gizmoRef.current = gizmo;

    const resize = () => viewport.engine.resize();
    window.addEventListener('resize', resize);
    resize();

    return () => {
      window.removeEventListener('resize', resize);
      gizmo.dispose();
      runtime.dispose();
      viewport.engine.dispose();
      viewportRef.current = null;
      runtimeRef.current = null;
      gizmoRef.current = null;
    };
  }, [previewEntityTransform, commitEntityTransform]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;

    runtime.sync(sceneDocument);
    const selectedTarget = runtime.getGizmoTargetByEntityId(selectedEntityId);
    gizmo.attachToTarget(selectedTarget, selectedEntityId);
  }, [sceneDocument, selectedEntityId]);

  useEffect(() => {
    gizmoRef.current?.setTool(transformTool);
  }, [transformTool]);

  useEffect(() => {
    gizmoRef.current?.setTransformSpace(transformSpace);
  }, [transformSpace]);

  useEffect(() => {
    gizmoRef.current?.setSnapSettings(snapSettings);
  }, [snapSettings]);

  return (
    <section className="scene-panel">
      <h2>Scene</h2>
      <canvas
        ref={canvasRef}
        className="scene-canvas"
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
        onPointerDown={handleCanvasPointerDown}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerCancel}
      />
    </section>
  );
}
