import type { Command } from './Command';
import type { SceneOpeningConfig } from '../model/sceneOpeningAnimation';

/** 撤销仅替换开场配置，避免回滚随后保存的相机或其它场景设置。 */
export function updateSceneOpeningAnimationCommand(
  before: SceneOpeningConfig | undefined,
  after: SceneOpeningConfig | undefined,
): Command {
  const previous = before === undefined ? undefined : structuredClone(before);
  const next = structuredClone(after);
  return {
    label: '修改开场动画',
    execute: scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings, openingAnimation: structuredClone(next) } }),
    undo: scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings,
      openingAnimation: previous === undefined ? undefined : structuredClone(previous) } }),
  };
}
