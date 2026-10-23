import { createCommandHistory } from '../../commands/CommandHistory';
import { createId } from '../../../shared/ids';
import { type SceneDocument } from '../../model/SceneDocument';
import type { AutoPatrolPlaybackSnapshot } from '../../../runtime/babylon/AutoPatrolPlaybackController';
import { createIdleEnvironmentRuntimeSnapshot, hasManagedEnvironmentCacheReference } from '../../model/environmentRuntime';
import { serializeScene } from '../../project/SceneSerializer';
import type { EditorState } from './editorStoreTypes';
import { prependLog } from './editorMutationGuard';

export const AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT: AutoPatrolPlaybackSnapshot = {
  phase: 'idle',
  routeId: null,
  routeName: null,
  currentWaypointIndex: null,
  waypointCount: 0,
  pausedByManualInput: false,
  canReturnToStart: false,
  playbackRate: 1,
  viewMode: 'orbit',
  automaticViewMode: 'orbit',
  manualCameraOverride: false,
  taskId: null,
  eventCount: 0,
  lastEvent: null,
};

/** 生成切换场景后的统一状态，避免旧场景的历史、选区和剪贴板泄漏到新场景。 */
export function createLoadedSceneState(state: EditorState, scene: SceneDocument, message: string): Partial<EditorState> {
  const camera = scene.sceneSettings.camera;
  const sceneSessionId = createId('scene_session');

  return {
    scene,
    sceneSessionId,
    runtimePerformanceEnabled: false,
    lightingBakeRequest: null,
    lightingManagerOpen: false,
    lightingManagerTab: 'overview',
    lightingManagerFocus: null,
    lightingManagerPreview: null,
    lightingManagerPreviewError: null,
    lightingManagerPreviewRequest: 0,
    lightingBakeStatus: { phase: 'idle', message: null },
    lightingClassification: [],
    lightingDebugVisible: false,
    lightingComparisonEnabled: false,
    lightingNodeFocusRequest: null,
    compositionEditRootId: null,
    compositionSaveRequest: null,
    persistedSceneContent: serializeScene(scene),
    history: createCommandHistory(),
    latestSceneResourceTransaction: null,
    latestSceneResourceRecovery: null,
    sceneResourceIssues: [],
    hierarchySelectionIds: [],
    entityClipboard: null,
    entityArrayRequest: null,
    sceneFocusRequest: null,
    environmentApplyRequest: null,
    environmentRuntimeOverride: null,
    sceneResourcePolicy: 'preserve-snapshot',
    sceneStartupResourceSessionId: null,
    sceneSourceFilePath: null,
    localSceneEnvironmentRecoveryChoice: null,
    localSceneEnvironmentRecoveryAcceptance: null,
    environmentStartupRelinkSessionId: hasManagedEnvironmentCacheReference(scene.sceneSettings.environment)
      ? sceneSessionId
      : null,
    environmentRuntimeSnapshot: createIdleEnvironmentRuntimeSnapshot(),
    sceneModelStatistics: null,
    environmentAdjustmentActive: false,
    environmentFocusRequest: null,
    projectAssetFocusRequest: null,
    revealHierarchyEntityRequest: null,
    cameraPoseSaveRequest: null,
    openingAnimationPreviewRequest: null,
    regionViewRequest: null,
    regionViewMessage: null,
    cameraResetRequest: { id: createId('camera_reset') },
    selectedAutoPatrolWaypointId: null,
    autoPatrolCameraRequest: null,
    autoPatrolPlaybackRequest: null,
    autoPatrolPlaybackSnapshot: AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT,
    cameraOrientation: camera.savedOrientation,
    cameraProjection: camera.savedProjection,
    selectedModelMeasurement: null,
    transformTool: state.groupTransformModeRestore?.tool ?? state.transformTool,
    transformSpace: state.groupTransformModeRestore?.space ?? state.transformSpace,
    groupTransformModeRestore: null,
    logs: prependLog(state.logs, message),
  };
}
