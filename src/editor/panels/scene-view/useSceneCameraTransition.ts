import { useEffect } from 'react';
import { type BabylonViewport } from '../../../runtime/babylon/createEngine';
import { applySavedSceneCameraView } from '../../../runtime/babylon/sceneCameraView';
import { type AutoPatrolPlaybackController } from '../../../runtime/babylon/AutoPatrolPlaybackController';
import { useEditorStore } from '../../store/editorStore';
import { type SceneDocument } from '../../model/SceneDocument';
import { type ManualRoamRuntime, type ManualRoamSnapshot } from '../../../runtime/roam/ManualRoamRuntime';
import { isScenePreparationActive } from '../../loading/scenePreparationProgress';
import type { RefObject } from 'react';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Options = {
  cameraResetRequest: EditorState['cameraResetRequest'];
  manualRoamSnapshot: ManualRoamSnapshot;
  viewportRef: RefObject<BabylonViewport | null>;
  cameraProjection: EditorState['cameraProjection'];
  cameraOrientation: EditorState['cameraOrientation'];
  cameraPoseSaveRequest: EditorState['cameraPoseSaveRequest'];
  consumeCameraPoseSaveRequest: EditorState['consumeCameraPoseSaveRequest'];
  regionViewRequest: EditorState['regionViewRequest'];
  manualRoamRef: RefObject<ManualRoamRuntime | null>;
  stopOpening: () => void;
  pauseHistoryReplay: () => void;
  autoPatrolPlaybackRef: RefObject<AutoPatrolPlaybackController | null>;
  consumeCameraResetRequest: EditorState['consumeCameraResetRequest'];
  sceneDocument: SceneDocument;
};

/** 保留视口原有执行顺序和依赖，集中管理相机视角。 */
export function useSceneCameraTransition({
  cameraResetRequest, manualRoamSnapshot, viewportRef, cameraProjection, cameraOrientation, cameraPoseSaveRequest, consumeCameraPoseSaveRequest, regionViewRequest, manualRoamRef, stopOpening, pauseHistoryReplay, autoPatrolPlaybackRef, consumeCameraResetRequest, sceneDocument,
}: Options) {
  /** 复位请求由原子视角应用负责，普通切换则先同步投影再驱动方向动画。 */
  useEffect(() => {
    if (cameraResetRequest || manualRoamSnapshot.enabled) return;
    viewportRef.current?.setCameraProjection(cameraProjection);
  }, [cameraProjection, cameraResetRequest, manualRoamSnapshot.enabled, viewportRef]);

  useEffect(() => {
    if (cameraResetRequest || manualRoamSnapshot.enabled) return;
    viewportRef.current?.setCameraOrientation(cameraOrientation);
  }, [cameraOrientation, cameraResetRequest, manualRoamSnapshot.enabled, viewportRef]);

  useEffect(() => {
    if (!cameraPoseSaveRequest) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    consumeCameraPoseSaveRequest(cameraPoseSaveRequest.id, viewport.getCameraPose());
  }, [cameraPoseSaveRequest, consumeCameraPoseSaveRequest, viewportRef]);

  useEffect(() => {
    if (!regionViewRequest) return;
    const state = useEditorStore.getState();
    if (regionViewRequest.sceneSessionId !== state.sceneSessionId || state.regionViewRequest?.id !== regionViewRequest.id) return;
    const finish = state.consumeRegionViewRequest;
    const viewport = viewportRef.current;
    if (!viewport || isScenePreparationActive()) {
      finish(regionViewRequest.id, undefined, '场景尚未就绪，请加载完成后重试');
      return;
    }
    if (state.runtimeMode !== 'edit') { finish(regionViewRequest.id); return; }
    try {
      if (regionViewRequest.kind === 'save') {
        if (manualRoamRef.current?.getSnapshot().enabled) throw new Error('请先退出手动漫游，再保存区域视角');
        finish(regionViewRequest.id, viewport.getCameraView());
      } else {
        const view = state.scene.sceneSettings.regionViews.find(item => item.id === regionViewRequest.regionViewId);
        if (!view) throw new Error('区域视角不存在，可能已被删除');
        stopOpening();
        pauseHistoryReplay();
        autoPatrolPlaybackRef.current?.stop();
        manualRoamRef.current?.setEnabled(false);
        viewport.applyCameraView({ ...view.camera, viewDistance: state.scene.sceneSettings.camera.viewDistance }, { animate: false });
        finish(regionViewRequest.id);
      }
    } catch (error) {
      finish(regionViewRequest.id, undefined, error instanceof Error ? error.message : '区域视角操作失败');
    }
  }, [regionViewRequest, pauseHistoryReplay, viewportRef, manualRoamRef, autoPatrolPlaybackRef, stopOpening]);

  useEffect(() => {
    if (!cameraResetRequest) return;
    stopOpening();
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
    viewportRef, manualRoamRef, stopOpening]);
}
