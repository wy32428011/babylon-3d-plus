import type { Command } from './Command';
import { normalizeSceneModelEntranceSettings, type SceneModelEntranceSettings } from '../model/sceneModelEntrance.ts';

/** 每条命令保留独立配置快照，撤销不回滚相机、开场及其他场景设置。 */
export function updateSceneModelEntranceCommand(
  before: SceneModelEntranceSettings | undefined,
  after: SceneModelEntranceSettings,
): Command {
  const previous = before === undefined ? undefined : normalizeSceneModelEntranceSettings(before);
  const next = normalizeSceneModelEntranceSettings(after);
  return {
    label: '修改模型入场动画',
    execute: scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings, modelEntrance: structuredClone(next) } }),
    undo: scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings, modelEntrance: structuredClone(previous) } }),
  };
}
