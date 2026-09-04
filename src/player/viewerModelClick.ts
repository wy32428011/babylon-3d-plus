import {
  buildClickEventAssetClickedPayload,
  resolveClickEventBindingClick,
  type ClickEventAssetClickedPayload,
  type ClickEventBindingPickedCell,
} from '../editor/model/clickEventBinding';
import type { SceneDocument } from '../editor/model/SceneDocument';
import type { DigitalTwinSlotCoordinate } from '../shared/digitalTwinSlotCodes';

type ViewerModelClickEffects = {
  updateSelection: (entityIds: readonly string[]) => void;
  setSlotHighlight: (entityId: string, cell: DigitalTwinSlotCoordinate | null) => void;
  focusTarget: (entityId: string, cell?: DigitalTwinSlotCoordinate) => void;
  triggerManualEvents: (entityId: string) => void;
  /** 命中 show-chart 效果时向宿主页面发送点击事件。 */
  emitAssetClicked?: (payload: ClickEventAssetClickedPayload) => void;
  /** 绑定包含数据中台大屏标识时，请求已握手的宿主切换大屏。 */
  showScreen?: (screen: { projectId: string; screenId: string }) => void;
};

/** 鼠标拾取与搜索共用点击绑定；搜索已完成聚焦，可跳过事件中的二次相机移动。 */
export function createViewerModelClickHandler(scene: SceneDocument, effects: ViewerModelClickEffects) {
  return (
    targetEntityId: string | null,
    pickedCell: ClickEventBindingPickedCell | null = null,
    options: { focus?: boolean } = {},
  ): void => {
    const entityId = (targetEntityId && scene.entities[targetEntityId]?.components.locator?.builtInBinding?.hostEntityId)
      || targetEntityId;
    const resolution = resolveClickEventBindingClick(scene, entityId, pickedCell);
    const assetClickedPayload = buildClickEventAssetClickedPayload(scene, resolution);
    if (assetClickedPayload) effects.emitAssetClicked?.(assetClickedPayload);
    if ((resolution.kind === 'trigger' || resolution.kind === 'trigger-cell') && resolution.screen) {
      effects.showScreen?.(resolution.screen);
    }
    if (resolution.kind === 'pass-through') {
      effects.updateSelection(entityId ? [entityId] : []);
      if (entityId) effects.triggerManualEvents(entityId);
      return;
    }
    if (resolution.kind === 'clear') {
      effects.updateSelection([]);
      effects.setSlotHighlight('', null);
      return;
    }
    if (resolution.kind === 'ignore') return;
    if (resolution.kind === 'trigger-cell') {
      if (resolution.effects.includes('highlight')) {
        effects.updateSelection([]);
        effects.setSlotHighlight(resolution.locatorEntityId, resolution.cell);
        effects.triggerManualEvents(resolution.entityId);
      } else {
        effects.setSlotHighlight('', null);
      }
      if (options.focus !== false && resolution.effects.includes('focus')) {
        effects.focusTarget(resolution.locatorEntityId, resolution.cell);
      }
      return;
    }
    effects.setSlotHighlight('', null);
    if (resolution.effects.includes('highlight')) {
      effects.updateSelection([resolution.entityId]);
      effects.triggerManualEvents(resolution.entityId);
    }
    if (options.focus !== false && resolution.effects.includes('focus')) {
      effects.focusTarget(resolution.entityId);
    }
  };
}
