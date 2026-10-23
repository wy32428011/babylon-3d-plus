import { type useEditorStore } from '../../store/editorStore';
import { useEffect } from 'react';
import { type BabylonViewport } from '../../../runtime/babylon/createEngine';
import { type SceneRuntime } from '../../../runtime/babylon/SceneRuntime';
import { type SceneFocusPerformanceMetrics } from '../../../runtime/babylon/ScenePerformanceMonitor';
import { SKYBOX_FOCUS_VIEW_DISTANCE_METERS, SCENE_VIEW_DISTANCE_MAX, type SceneDocument } from '../../model/SceneDocument';
import { type ManualRoamRuntime } from '../../../runtime/roam/ManualRoamRuntime';
import type { RefObject } from 'react';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Options = {
  sceneFocusRequest: EditorState['sceneFocusRequest'];
  runtimeRef: RefObject<SceneRuntime | null>;
  viewportRef: RefObject<BabylonViewport | null>;
  manualRoamRef: RefObject<ManualRoamRuntime | null>;
  sceneDocumentRef: RefObject<SceneDocument | null>;
  sceneFocusPerformanceRef: RefObject<SceneFocusPerformanceMetrics | null>;
  consumeSceneFocusRequest: EditorState['consumeSceneFocusRequest'];
  environmentFocusRequest: EditorState['environmentFocusRequest'];
  sceneDocument: SceneDocument;
  consumeEnvironmentFocusRequest: EditorState['consumeEnvironmentFocusRequest'];
};

/** 保留视口原有执行顺序和依赖，集中管理场景聚焦。 */
export function useSceneFocusTransition({
  sceneFocusRequest, runtimeRef, viewportRef, manualRoamRef, sceneDocumentRef, sceneFocusPerformanceRef, consumeSceneFocusRequest, environmentFocusRequest, sceneDocument, consumeEnvironmentFocusRequest,
}: Options) {
  useEffect(() => {
    if (!sceneFocusRequest) return;

    const runtime = runtimeRef.current;
    const viewport = viewportRef.current;
    if (!runtime || !viewport) return;

    const bounds = runtime.getEntitiesFocusBounds(sceneFocusRequest.entityIds);
    if (bounds) {
      manualRoamRef.current?.setEnabled(false);
      const currentScene = sceneDocumentRef.current;
      const containsSkybox = sceneFocusRequest.entityIds.some((entityId) => (
        Boolean(currentScene?.entities[entityId]?.components.skybox)
      ));
      const containsCad = sceneFocusRequest.entityIds.some(entityId => Boolean(currentScene?.entities[entityId]?.components.cadReference));
      // CAD 参考层按完整实例范围取景，不能套用普通模型 3m 聚焦上限。
      viewport.setViewDistance(
        containsSkybox
          ? SKYBOX_FOCUS_VIEW_DISTANCE_METERS
          : containsCad
            ? Math.min(SCENE_VIEW_DISTANCE_MAX, Math.max(currentScene?.sceneSettings.camera.viewDistance ?? SCENE_VIEW_DISTANCE_MAX, Math.ceil(bounds.radiusMeters * 4)))
            : currentScene?.sceneSettings.camera.viewDistance ?? SCENE_VIEW_DISTANCE_MAX,
      );
      viewport.focusOnBounds(
        bounds,
        containsSkybox
          ? { animate: false, maxRadiusMeters: Number.POSITIVE_INFINITY, useModelFocusAngle: false }
          : containsCad
            ? { ...sceneFocusRequest.transition, maxRadiusMeters: Number.POSITIVE_INFINITY, useModelFocusAngle: false }
            : sceneFocusRequest.transition,
      );
      sceneFocusPerformanceRef.current = {
        ...bounds,
        focusedAt: new Date().toISOString(),
      };
    }
    consumeSceneFocusRequest(sceneFocusRequest.id);
  }, [sceneFocusRequest, consumeSceneFocusRequest, runtimeRef, viewportRef, manualRoamRef, sceneDocumentRef, sceneFocusPerformanceRef]);

  /** 聚焦全局环境，并在超大厂区场景中临时提高可视距离但不超过 20 km。 */
  useEffect(() => {
    if (!environmentFocusRequest) return;

    const runtime = runtimeRef.current;
    const viewport = viewportRef.current;
    if (!runtime || !viewport) return;

    const bounds = runtime.getEnvironmentWorldBounds();
    if (bounds) {
      manualRoamRef.current?.setEnabled(false);
      const requiredViewDistance = Math.min(
        SCENE_VIEW_DISTANCE_MAX,
        Math.max(sceneDocument.sceneSettings.camera.viewDistance, Math.ceil(bounds.radiusMeters * 4)),
      );
      viewport.setViewDistance(requiredViewDistance);
      viewport.focusOnBounds(bounds, {
        animate: false,
        maxRadiusMeters: Number.POSITIVE_INFINITY,
        useModelFocusAngle: false,
      });
    }
    consumeEnvironmentFocusRequest(environmentFocusRequest.id);
  }, [
    consumeEnvironmentFocusRequest,
    environmentFocusRequest,
    sceneDocument.sceneSettings.camera.viewDistance,
    runtimeRef, viewportRef, manualRoamRef]);
}
