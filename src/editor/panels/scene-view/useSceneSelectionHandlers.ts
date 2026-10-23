import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { appendEffectPathDrawingPoint, getEffectPathDrawing, setEffectPathDrawingError } from '../../model/effectPathDrawing';
import { findCompositionRoot } from '../../composition/composition';
import { type PointerEvent, type WheelEvent } from 'react';
import { type BabylonViewport } from '../../../runtime/babylon/createEngine';
import { DIGITAL_TWIN_CAMERA_CONTROL_STANDARD } from '../../../runtime/babylon/cameraControlStandard';
import { completeSceneModelSelectionPointer, createSceneModelSelectionPointerSnapshot, updateSceneModelSelectionPointerSnapshot, type SceneModelSelectionPointerSnapshot } from '../../../shared/sceneModelSelectionPointer';
import { buildClickEventAssetClickedPayload, CLICK_EVENT_FOCUS_DURATION_MS, CLICK_EVENT_FOCUS_RADIUS_SCALE, resolveClickEventBindingClick, resolveGeneratedUnitClick, type ClickEventBindingPickedCell } from '../../model/clickEventBinding';
import { DIGITAL_TWIN_BRIDGE_CHANNEL, DIGITAL_TWIN_BRIDGE_VERSION, DIGITAL_TWIN_EDITOR_PREVIEW_SESSION_ID } from '../../../player/digitalTwinInteractionProtocol';
import { type SceneRuntime } from '../../../runtime/babylon/SceneRuntime';
import { type AutoPatrolPlaybackController } from '../../../runtime/babylon/AutoPatrolPlaybackController';
import { type TransformGizmoController } from '../../../runtime/babylon/TransformGizmoController';
import { useEditorStore } from '../../store/editorStore';
import type { EditorRuntimeMode } from '../../model/editorRuntimeMode';
import { toggleHierarchyEntitySelection } from '../../model/entityHierarchy';
import { type ManualRoamRuntime } from '../../../runtime/roam/ManualRoamRuntime';
import type { RefObject } from 'react';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Options = {
  runtimeModeRef: RefObject<EditorRuntimeMode>;
  clickSnapshotRef: RefObject<SceneModelSelectionPointerSnapshot | null>;
  effectDrawingPointerRef: RefObject<number | null>;
  runtimeRef: RefObject<SceneRuntime | null>;
  gizmoRef: RefObject<TransformGizmoController | null>;
  pauseHistoryReplay: () => void;
  autoPatrolPlaybackRef: RefObject<AutoPatrolPlaybackController | null>;
  isRuntimePreview: boolean;
  handleChartMarkerClick: (entityId: string) => boolean;
  manualRoamRef: RefObject<ManualRoamRuntime | null>;
  viewportRef: RefObject<BabylonViewport | null>;
  clickProductHighlightIdRef: RefObject<string | null>;
  selectEntity: EditorState['selectEntity'];
};

/** 保留视口原有执行顺序和依赖，集中管理指针拾取。 */
export function useSceneSelectionHandlers({
  runtimeModeRef, clickSnapshotRef, effectDrawingPointerRef, runtimeRef, gizmoRef, pauseHistoryReplay, autoPatrolPlaybackRef, isRuntimePreview, handleChartMarkerClick, manualRoamRef, viewportRef, clickProductHighlightIdRef, selectEntity,
}: Options) {
  /** 记录主指针左键按下位置与 Ctrl/Cmd 状态，用于区分多选点击和相机拖拽。 */
  function handleEffectPathPointerDownCapture(event: PointerEvent<HTMLCanvasElement>): void {
    const drawing = getEffectPathDrawing();
    if (!drawing || event.button !== 0 || runtimeModeRef.current !== 'edit') return;
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
    clickSnapshotRef.current = null;
    effectDrawingPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const runtime = runtimeRef.current;
    const target = runtime?.getGizmoTargetByEntityId(drawing.entityId);
    const world = runtime?.getGroundPointAtCanvasPoint(event.clientX, event.clientY, event.currentTarget);
    if (!target || target.isDisposed() || !world) { setEffectPathDrawingError('无法取得地面落点，请调整视角或等待特效加载。'); return; }
    const matrix = target.computeWorldMatrix(true);
    if (Math.abs(matrix.determinant()) < 1e-12) { setEffectPathDrawingError('特效缩放过小或为零，无法转换局部坐标。'); return; }
    const local = Vector3.TransformCoordinates(new Vector3(world.x, world.y, world.z), matrix.clone().invert());
    if (drawing.mode === 'wall') {
      const elevation = useEditorStore.getState().scene.entities[drawing.entityId]?.components.poiEffect?.configuration?.parameters.elevation;
      local.y = typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : 0;
    }
    const displayed = Vector3.TransformCoordinates(local, matrix);
    appendEffectPathDrawingPoint({ x: displayed.x, y: displayed.y, z: displayed.z }, { x: local.x, y: local.y, z: local.z });
  }
  function handleEffectPathPointerMoveCapture(event: PointerEvent<HTMLCanvasElement>): void {
    if (effectDrawingPointerRef.current !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
  }
  function handleEffectPathPointerUpCapture(event: PointerEvent<HTMLCanvasElement>): void {
    if (effectDrawingPointerRef.current !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
    effectDrawingPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

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
    // 任何新点击先清空「忽略固定轨道」排除；点击事件 trigger 分支随后按需重建，避免残留污染手动选中。
    runtimeRef.current?.setClickHighlightTrackExclusion([]);

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
    const previewGeneratedHit = isRuntimePreview
      ? runtimeRef.current?.pickGeneratedUnitClickTargetAtCanvasPoint(
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
      // 生成器产物按真实几何命中优先；常规命中只是包围盒兜底时按距离比较。
      const generatedUnit = previewGeneratedHit
        && (!previewModelHit || !previewModelHit.precise || previewGeneratedHit.distance < previewModelHit.distance)
        ? previewGeneratedHit.hit
        : null;
      const resolution = (generatedUnit ? resolveGeneratedUnitClick(state.scene, generatedUnit) : null)
        ?? resolveClickEventBindingClick(state.scene, pickedEntityId, pickedCell);
      if (resolution.kind !== 'pass-through') {
        // 命中 show-chart 效果时向宿主页面发送点击事件；编辑器无握手流程，用固定会话标识 + 通配 origin（仅开发预览）。
        const assetClickedPayload = buildClickEventAssetClickedPayload(state.scene, resolution);
        if (assetClickedPayload) {
          const slotText = assetClickedPayload.slot
            ? `，库位 ${assetClickedPayload.slot.row}-${assetClickedPayload.slot.column}-${assetClickedPayload.slot.layer}`
            : '';
          const unitText = assetClickedPayload.unit
            ? assetClickedPayload.unit.kind === 'cargo'
              ? `，产物货箱 ${assetClickedPayload.unit.containerCode || '匿名'}`
              : `，产物设备 ${assetClickedPayload.unit.assetCode || '未知编号'}`
            : '';
          const hostText = assetClickedPayload.host
            ? `，承运设备 ${assetClickedPayload.host.name ?? assetClickedPayload.host.entityId}（${assetClickedPayload.host.assetCode ?? '未设置'}）`
            : '';
          const framed = window.parent !== window;
          state.pushLog(
            `点击事件绑定：展示图表事件（资产编号 ${assetClickedPayload.assetCode ?? '未设置'}${slotText}${unitText}${hostText}，图表id ${assetClickedPayload.chartId ?? '未配置'}）${framed ? '已发送至宿主页面' : '未嵌入宿主页面，仅记录'}`,
          );
          if (framed) {
            window.parent.postMessage({
              channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
              version: DIGITAL_TWIN_BRIDGE_VERSION,
              sessionId: DIGITAL_TWIN_EDITOR_PREVIEW_SESSION_ID,
              type: 'event.assetClicked',
              payload: assetClickedPayload,
            }, '*');
          }
        }
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
          // 生成产物的高亮目标可能是没有文档实体的动态设备实例合成 id，走运行时高亮而非编辑器选区。
          const hasEntityTarget = state.scene.entities[resolution.entityId] !== undefined;
          if (resolution.effects.includes('highlight')) {
            runtimeRef.current?.setClickHighlightTrackExclusion(
              resolution.highlightExcludeFixedTrack ? [resolution.entityId] : [],
            );
            if (hasEntityTarget) {
              clickProductHighlightIdRef.current = null;
              runtimeRef.current?.setLocalHighlightEntityIds([]);
              state.selectEntity(resolution.entityId);
            } else {
              clickProductHighlightIdRef.current = resolution.entityId;
              runtimeRef.current?.setLocalHighlightEntityIds([resolution.entityId]);
              // 产物高亮与编辑器选区互斥：旧选中设备不清掉会残留双高亮，也表现为切不回产物。
              state.selectEntity(null);
            }
          }
          if (resolution.effects.includes('focus')) {
            if (hasEntityTarget) {
              state.requestSceneFocusForSelection([resolution.entityId], {
                animate: true,
                durationMs: CLICK_EVENT_FOCUS_DURATION_MS,
              });
            } else {
              const bounds = runtimeRef.current?.getEntitiesFocusBounds([resolution.entityId]);
              if (bounds) {
                manualRoamRef.current?.setEnabled(false);
                viewportRef.current?.focusOnBounds(bounds, {
                  animate: true,
                  durationMs: CLICK_EVENT_FOCUS_DURATION_MS,
                });
              }
            }
          }
        } else if (resolution.kind === 'clear') {
          clickProductHighlightIdRef.current = null;
          runtimeRef.current?.setLocalSlotHighlight('', null);
          runtimeRef.current?.setLocalHighlightEntityIds([]);
          state.selectEntity(null);
        }
        return;
      }
    }
    // 预览下点击转入常规选择路径（点空白或未接管模型）时，产物本地高亮一并清除。
    if (isRuntimePreview && clickProductHighlightIdRef.current) {
      clickProductHighlightIdRef.current = null;
      runtimeRef.current?.setLocalHighlightEntityIds([]);
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
    const compositionState = useEditorStore.getState();
    const compositionRoot = pickedEntityId ? findCompositionRoot(compositionState.scene, pickedEntityId) : null;
    selectEntity(compositionRoot && compositionState.compositionEditRootId !== compositionRoot ? compositionRoot : pickedEntityId);
  }
  /** 指针流程被浏览器取消时丢弃点击快照，并取消尚未完成的 Shift 阵列拖拽。 */
  function handleCanvasPointerCancel(): void {
    effectDrawingPointerRef.current = null;
    clickSnapshotRef.current = null;
    gizmoRef.current?.cancelActiveDrag();
  }

  /** 滚轮缩放属于手动相机接管，立即暂停自动巡检。 */
  function handleCanvasWheel(_event: WheelEvent<HTMLCanvasElement>): void {
    pauseHistoryReplay();
    autoPatrolPlaybackRef.current?.notifyManualInput();
    autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
  }

  return { handleEffectPathPointerDownCapture, handleEffectPathPointerMoveCapture, handleEffectPathPointerUpCapture, handleCanvasPointerDown, handleCanvasPointerMove, handleCanvasPointerUp, handleCanvasPointerCancel, handleCanvasWheel };
}
