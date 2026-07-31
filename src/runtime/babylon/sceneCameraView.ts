import type {
  SceneCameraOrientation,
  SceneCameraPose,
  SceneCameraProjection,
  SceneCameraSettings,
} from '../../editor/model/SceneDocument';

export type SceneCameraViewController = {
  applyCameraPose: (pose: SceneCameraPose | null) => void;
  setCameraOrientation: (orientation: SceneCameraOrientation) => void;
  setCameraProjection: (projection: SceneCameraProjection) => void;
};

/**
 * 原子化恢复场景保存视角：先解除旧场景的俯视锁，再恢复位姿和投影，最后进入目标朝向。
 * 该顺序避免直接加载俯视场景时把上一场景位姿缓存为退出俯视后的错误位置。
 */
export function applySavedSceneCameraView(
  controller: SceneCameraViewController,
  settings: SceneCameraSettings,
): void {
  controller.setCameraOrientation('orbit');
  controller.applyCameraPose(settings.savedPose);
  controller.setCameraProjection(settings.savedProjection);
  controller.setCameraOrientation(settings.savedOrientation);
}
