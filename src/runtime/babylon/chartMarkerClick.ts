import { getChartMarkerClickEvents } from '../../editor/model/chartMarker';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { ChartMarkerThemeScreen } from '../../editor/model/components';

export type ChartMarkerClickEffects = {
  focusEntity: (entityId: string) => boolean;
  selectEntity: (entityId: string) => void;
  refreshMarker: (entityId: string) => void;
  showTheme: (screen: ChartMarkerThemeScreen) => void;
  reportError: (message: string) => void;
};

/** 编辑器预览与 Viewer 共用动作顺序；失效目标只跳过当前动作。 */
export function executeChartMarkerClick(
  scene: SceneDocument,
  markerId: string,
  effects: ChartMarkerClickEffects,
): boolean {
  const marker = Object.hasOwn(scene.entities, markerId) ? scene.entities[markerId] : undefined;
  if (!marker?.components.chartMarker) return false;
  const events = getChartMarkerClickEvents(marker.components.chartMarker, markerId);
  if (!events.some((event) => event.actions.length > 0)) return false;
  const errors: string[] = [];
  for (const event of events) {
    if (event.type !== 'left-click') continue;
    for (const action of event.actions) {
      if (action.type === 'refresh') {
        effects.refreshMarker(markerId);
        continue;
      }
      if (action.type === 'theme') {
        if (action.screen) effects.showTheme(action.screen);
        else errors.push(`图表立标“${marker.name}”的主题展示尚未绑定大屏。`);
        continue;
      }
      const target = Object.hasOwn(scene.entities, action.targetEntityId) ? scene.entities[action.targetEntityId] : undefined;
      if (!target) {
        errors.push(`图表立标“${marker.name}”的${action.type === 'focus' ? '对象聚焦' : '选中物体'}目标${action.targetEntityId ? '已不存在' : '尚未设置'}。`);
        continue;
      }
      if (action.type === 'select') effects.selectEntity(target.id);
      else if (!effects.focusEntity(target.id)) errors.push(`对象“${target.name}”的三维几何尚未就绪，无法聚焦。`);
    }
  }
  if (errors.length > 0) effects.reportError([...new Set(errors)].join('\n'));
  return true;
}
