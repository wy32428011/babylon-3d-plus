import { create } from 'zustand';
import type { EditorState } from './slices/editorStoreTypes';
import { createSceneDocumentSlice } from './slices/sceneDocumentSlice';
import { createSelectionAndViewportSlice } from './slices/selectionAndViewportSlice';
import { createProjectAssetsSlice } from './slices/projectAssetsSlice';
import { createDataPlatformAndPublishSlice } from './slices/dataPlatformAndPublishSlice';
import { createLightingManagerSlice } from './slices/lightingManagerSlice';
import { createRuntimePreviewAndTelemetrySlice } from './slices/runtimePreviewAndTelemetrySlice';

export type { CadImportProgress, EntityArrayDirection, ResolvedEntityArrayInput, EntityArrayCommitResult, SceneFocusTransition, SceneFocusRequest, ProjectAssetFocusRequest, CameraPoseSaveRequest, CameraResetRequest, OpeningAnimationPreviewRequest, RegionViewRequest, AutoPatrolCameraRequest, AutoPatrolPlaybackRequest, SelectedModelMeasurement, SelectedGroupSpatialInfo, GroupInspectorTransformField, GroupInspectorTransformRequest, TransformTool, TransformSpace, TransformSnapSettingKey, SceneSensitivitySettingKey, EnvironmentApplyOptions, EnvironmentDisplayPatch, TransformSnapSettings } from './slices/editorStoreTypes';

/** 保留公开的单一 Store；Slice 共享同一 set/get/api 与命令历史。 */
export const useEditorStore = create<EditorState>((...store) => ({
  ...createSceneDocumentSlice(...store),
  ...createSelectionAndViewportSlice(...store),
  ...createProjectAssetsSlice(...store),
  ...createDataPlatformAndPublishSlice(...store),
  ...createLightingManagerSlice(...store),
  ...createRuntimePreviewAndTelemetrySlice(...store),
}));
