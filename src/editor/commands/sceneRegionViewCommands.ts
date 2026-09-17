import type { Command } from './Command';
import type { SceneRegionView } from '../model/sceneRegionViews';

/** 只替换区域列表，撤销不能回滚期间更新的其它场景设置。 */
export function updateSceneRegionViewsCommand(before: readonly SceneRegionView[], after: readonly SceneRegionView[], label: string): Command {
  const previous = structuredClone([...before]);
  const next = structuredClone([...after]);
  return {
    label,
    execute: scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings, regionViews: structuredClone(next) } }),
    undo: scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings, regionViews: structuredClone(previous) } }),
  };
}
