import { COMPOSITION_DRAG, parseCompositionDragPayload } from '../../composition/composition';
import { placeComposition } from '../../composition/compositionActions';
import type { CompositionLibraryApi } from '../../../../electron/shared/compositionTypes';
import { type DragEvent } from 'react';
import { type SceneModelSelectionPointerSnapshot } from '../../../shared/sceneModelSelectionPointer';
import { type SceneRuntime } from '../../../runtime/babylon/SceneRuntime';
import { BUILT_IN_ASSET_DRAG_MIME_TYPE, decodeBuiltInAssetDragPayload, decodeModelAssetDragPayload, decodeSkyboxAssetDragPayload, MODEL_ASSET_DRAG_MIME_TYPE, SKYBOX_ASSET_DRAG_MIME_TYPE } from '../../assets/AssetDatabase';
import { useEditorStore } from '../../store/editorStore';
import { DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE, decodeDataPlatformScreenDragPayload } from '../../assets/dataPlatformScreenDrag';
import { getBuiltInMeshGroundOffsetMeters } from '../../model/builtInMeshGeometry';
import { SCENE_THEME_DRAG_MIME_TYPE, isSceneThemePresetId } from '../../model/sceneTheme';
import { getSceneSkyboxSettings, type SceneDocument } from '../../model/SceneDocument';
import { createSceneSkyboxFromAsset } from '../../assets/skyboxAssets';
import { ensureVirtualConveyorAsset } from '../../assets/virtualConveyorAsset';
import { isScenePreparationActive } from '../../loading/scenePreparationProgress';
import type { RefObject } from 'react';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Options = {
  isRuntimePreview: boolean;
  runtimeRef: RefObject<SceneRuntime | null>;
  clickSnapshotRef: RefObject<SceneModelSelectionPointerSnapshot | null>;
  sceneDocument: SceneDocument;
  placeSkybox: EditorState['placeSkybox'];
  importModelAsset: EditorState['importModelAsset'];
  createAutoPatrol: EditorState['createAutoPatrol'];
  createManualRoamSpawn: EditorState['createManualRoamSpawn'];
  createModelGenerator: EditorState['createModelGenerator'];
  createDeviceSpawner: EditorState['createDeviceSpawner'];
  createClickEventBinding: EditorState['createClickEventBinding'];
  createChartMarker: EditorState['createChartMarker'];
  createPoiEffect: EditorState['createPoiEffect'];
  createMesh: EditorState['createMesh'];
  createLocator: EditorState['createLocator'];
  createLight: EditorState['createLight'];
  pushLog: EditorState['pushLog'];
};

/** 保留视口原有执行顺序和依赖，集中管理资源拖放。 */
export function useSceneAssetDropHandler({
  isRuntimePreview, runtimeRef, clickSnapshotRef, sceneDocument, placeSkybox, importModelAsset, createAutoPatrol, createManualRoamSpawn, createModelGenerator, createDeviceSpawner, createClickEventBinding, createChartMarker, createPoiEffect, createMesh, createLocator, createLight, pushLog,
}: Options) {
  /** 仅当拖拽数据是可创建场景实体的资源时允许浏览器在 Scene 画布触发 drop。 */
  function handleCanvasDragOver(event: DragEvent<HTMLCanvasElement>): void {
    if (isRuntimePreview) return;

    if (event.dataTransfer.types.includes(SCENE_THEME_DRAG_MIME_TYPE)) {
      event.preventDefault();
      const state = useEditorStore.getState();
      event.dataTransfer.dropEffect = isScenePreparationActive() || Boolean(state.lightingBakeRequest)
        || state.environmentApplyRequest || state.environmentRuntimeSnapshot.phase === 'loading' ? 'none' : 'copy';
      return;
    }

    if (event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE)) {
      event.preventDefault();
      const entityId = runtimeRef.current?.pickEntityIdAtCanvasPoint(event.clientX, event.clientY, event.currentTarget);
      const marker = entityId ? useEditorStore.getState().scene.entities[entityId]?.components.chartMarker : null;
      event.dataTransfer.dropEffect = marker ? 'copy' : 'none';
      return;
    }

    const hasSupportedPayload =
      event.dataTransfer.types.includes(COMPOSITION_DRAG) ||
      event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE) ||
      event.dataTransfer.types.includes(SKYBOX_ASSET_DRAG_MIME_TYPE) ||
      event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE);
    if (!hasSupportedPayload) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /** 历史主题资源只打开统一管理器，避免拖入时绕过草稿直接改灯。 */
  function handleCanvasDrop(event: DragEvent<HTMLCanvasElement>): void {
    if (isRuntimePreview) {
      event.preventDefault();
      clickSnapshotRef.current = null;
      return;
    }

    if (event.dataTransfer.types.includes(SCENE_THEME_DRAG_MIME_TYPE)) {
      event.preventDefault();
      clickSnapshotRef.current = null;
      const state = useEditorStore.getState();
      if (isScenePreparationActive() || state.runtimeMode !== 'edit' || state.lightingBakeRequest
        || state.environmentApplyRequest || state.environmentRuntimeSnapshot.phase === 'loading') return;
      const presetId = event.dataTransfer.getData(SCENE_THEME_DRAG_MIME_TYPE);
      if (isSceneThemePresetId(presetId)) {
        state.openLightingManager({ tab: 'overview' });
      }
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

    const compositionPayload = event.dataTransfer.getData(COMPOSITION_DRAG);
    if (compositionPayload) {
      event.preventDefault(); clickSnapshotRef.current = null;
      const session = useEditorStore.getState().sceneSessionId;
      let payload: {id:string;revision?:string};
      try {
        payload = parseCompositionDragPayload(compositionPayload);
      } catch (error) { useEditorStore.getState().pushLog(String(error)); return; }
      void (window.editorApi as unknown as CompositionLibraryApi).loadComposition(payload.id, payload.revision).then(entry => {
        if (useEditorStore.getState().sceneSessionId !== session) return;
        if (!entry) throw new Error('组合卡片已不存在，请刷新资源库。');
        placeComposition(entry, placementPosition);
      }).catch(e => useEditorStore.getState().pushLog(String(e.message ?? e)));
      return;
    }
    const rawSkyboxPayload = event.dataTransfer.getData(SKYBOX_ASSET_DRAG_MIME_TYPE);
    const skyboxAsset = decodeSkyboxAssetDragPayload(rawSkyboxPayload);
    if (skyboxAsset) {
      event.preventDefault();
      clickSnapshotRef.current = null;
      const currentSkybox = getSceneSkyboxSettings(sceneDocument);
      placeSkybox(createSceneSkyboxFromAsset(skyboxAsset, currentSkybox));
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

    if (builtInAsset.kind === 'device-spawner') {
      createDeviceSpawner(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'click-event-binding') {
      createClickEventBinding(placementPosition);
      return;
    }

    if (builtInAsset.kind === 'alarm-manager') { useEditorStore.getState().createAlarmManager(placementPosition); return; }
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

    if (builtInAsset.kind === 'virtual-conveyor') {
      void (async () => {
        const result = await ensureVirtualConveyorAsset();
        if (!result.asset) {
          pushLog(result.error ?? '虚拟输送线模型包不可用。');
          return;
        }
        importModelAsset(result.asset, placementPosition);
      })();
      return;
    }

    if (builtInAsset.kind === 'locator') {
      createLocator(placementPosition);
      return;
    }

    createLight(builtInAsset.lightKind, placementPosition);
  }

  return { handleCanvasDragOver, handleCanvasDrop };
}
