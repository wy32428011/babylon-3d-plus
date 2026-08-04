import type { SceneCameraSettings } from '../../editor/model/SceneDocument';
import type { CameraViewApplicationOptions } from './ArcRotateCameraViewController';

export type SceneCameraViewController = {
  applyCameraView: (settings: SceneCameraSettings, options: Required<CameraViewApplicationOptions>) => void;
};

/**
 * 恢复场景显式保存的完整视角。编辑器默认恢复标准面硬锁；Viewer 可只恢复画面并保持自由轨道。
 */
export function applySavedSceneCameraView(
  controller: SceneCameraViewController,
  settings: SceneCameraSettings,
  options: CameraViewApplicationOptions = {},
): void {
  controller.applyCameraView(settings, {
    animate: options.animate ?? true,
    lockStandardOrientation: options.lockStandardOrientation ?? true,
  });
}
