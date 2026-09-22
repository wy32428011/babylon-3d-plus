import type { Command } from './Command';
import type { SceneSettings } from '../model/SceneDocument';

/** 仅回写主题及其拥有的主光参数，不回滚设备、环境资源和其它场景设置。 */
export function updateSceneThemeCommand(before: Pick<SceneSettings, 'theme' | 'shadows'>, after: Pick<SceneSettings, 'theme' | 'shadows'>, label: string): Command {
  const previous = structuredClone(before), next = structuredClone(after);
  const shadowKeys = (Object.keys(after.shadows) as (keyof SceneSettings['shadows'])[])
    .filter(key => before.shadows[key] !== after.shadows[key]);
  const apply = (scene: Parameters<Command['execute']>[0], snapshot: typeof before) => ({
    ...scene, sceneSettings: { ...scene.sceneSettings, theme: structuredClone(snapshot.theme),
      shadows: { ...scene.sceneSettings.shadows, ...Object.fromEntries(shadowKeys.map(key => [key, structuredClone(snapshot.shadows[key])])) } },
  });
  return { label, execute: scene => apply(scene, next), undo: scene => apply(scene, previous) };
}
