import {
  buildClickEventAssetClickedPayload,
  resolveClickEventBindingClick,
  resolveGeneratedUnitClick,
  type ClickEventAssetClickedPayload,
  type ClickEventBindingPickedCell,
  type GeneratedUnitClickHit,
} from '../editor/model/clickEventBinding';
import type { SceneDocument } from '../editor/model/SceneDocument';
import { buildDeviceContext } from '../editor/model/deviceContext';
import type { DigitalTwinDeviceContext } from './digitalTwinInteractionProtocol';
import type { DigitalTwinSlotCoordinate } from '../shared/digitalTwinSlotCodes';

type ViewerModelClickEffects = {
  beginSelection?: () => void;
  updateSelection: (entityIds: readonly string[]) => void;
  setSlotHighlight: (entityId: string, cell: DigitalTwinSlotCoordinate | null) => void;
  focusTarget: (entityId: string, cell?: DigitalTwinSlotCoordinate) => void;
  followTarget?: (entityId: string, cell?: DigitalTwinSlotCoordinate) => void;
  triggerManualEvents: (entityId: string) => void;
  /** 整体替换「忽略固定轨道」的高亮排除集合；非点击事件触发的高亮路径应传空数组。 */
  setHighlightExcludeTrack: (entityIds: readonly string[]) => void;
  /** 命中 show-chart 效果时向宿主页面发送点击事件。 */
  emitAssetClicked?: (payload: ClickEventAssetClickedPayload) => void;
  /** 独立选择上下文，不依赖 show-chart 或高模绑定；空白/取消发送 null。 */
  emitDeviceContext?: (context: DigitalTwinDeviceContext | null) => void;
  /** 绑定了设备身份时通知新宿主，旧 v1 点击保持原状。 */
  emitInspectionDeviceSelected?: (entityId: string, generated: boolean) => void;
  /** 仅显式动作打开详情；生成器产物必须另有实例绑定。 */
  openInspectionDetail?: (entityId: string, generated: boolean) => void;
  /** 绑定包含数据中台大屏标识时，请求已握手的宿主切换大屏。 */
  showScreen?: (screen: { projectId: string; screenId: string }) => void;
};

/** 鼠标拾取与搜索共用点击绑定；搜索已完成聚焦，可跳过事件中的二次相机移动。generatedUnit 为生成器产物命中，优先于按设备类型匹配的常规点击。 */
export function createViewerModelClickHandler(scene: SceneDocument, effects: ViewerModelClickEffects) {
  return (
    targetEntityId: string | null,
    pickedCell: ClickEventBindingPickedCell | null = null,
    options: { focus?: boolean; generatedUnit?: GeneratedUnitClickHit | null; fromFocusCommand?: boolean } = {},
  ): void => {
    const entityId = (targetEntityId && scene.entities[targetEntityId]?.components.locator?.builtInBinding?.hostEntityId)
      || targetEntityId;
    // 命中生成产物时按产物自身的绑定决策；生成器未配置点击事件则回落到常规点击。
    const resolution = (options.generatedUnit ? resolveGeneratedUnitClick(scene, options.generatedUnit) : null)
      ?? resolveClickEventBindingClick(scene, entityId, pickedCell);
    if (resolution.kind !== 'ignore') {
      effects.beginSelection?.();
      const selectedEntityId = resolution.kind === 'clear' ? null
        : resolution.kind === 'pass-through' ? entityId : resolution.entityId;
      effects.emitDeviceContext?.(resolution.kind === 'clear' ? null
        : buildDeviceContext(scene, selectedEntityId, options.generatedUnit));
    }
    const assetClickedPayload = buildClickEventAssetClickedPayload(scene, resolution);
    if (assetClickedPayload) effects.emitAssetClicked?.(assetClickedPayload);
    if (resolution.kind === 'trigger' || resolution.kind === 'trigger-cell') {
      effects.emitInspectionDeviceSelected?.(resolution.entityId, Boolean(options.generatedUnit));
    }
    if (!options.fromFocusCommand && (resolution.kind === 'trigger' || resolution.kind === 'trigger-cell')
      && (resolution.effects as readonly string[]).includes('open-inspection-detail')) {
      effects.openInspectionDetail?.(resolution.entityId, Boolean(options.generatedUnit));
    }
    if ((resolution.kind === 'trigger' || resolution.kind === 'trigger-cell') && resolution.screen) {
      effects.showScreen?.(resolution.screen);
    }
    if (resolution.kind === 'pass-through') {
      if (entityId) effects.emitInspectionDeviceSelected?.(entityId, Boolean(options.generatedUnit));
      effects.setHighlightExcludeTrack([]);
      effects.updateSelection(entityId ? [entityId] : []);
      if (entityId) effects.triggerManualEvents(entityId);
      return;
    }
    if (resolution.kind === 'clear') {
      effects.setHighlightExcludeTrack([]);
      effects.updateSelection([]);
      effects.setSlotHighlight('', null);
      return;
    }
    if (resolution.kind === 'ignore') return;
    if (resolution.kind === 'trigger-cell') {
      effects.setHighlightExcludeTrack([]);
      if (resolution.effects.includes('highlight')) {
        effects.updateSelection([]);
        effects.setSlotHighlight(resolution.locatorEntityId, resolution.cell);
        effects.triggerManualEvents(resolution.entityId);
      } else {
        effects.setSlotHighlight('', null);
      }
      if (options.focus !== false && resolution.effects.includes('follow')) {
        effects.followTarget?.(resolution.locatorEntityId, resolution.cell);
      } else if (options.focus !== false && resolution.effects.includes('focus')) {
        effects.focusTarget(resolution.locatorEntityId, resolution.cell);
      }
      return;
    }
    effects.setSlotHighlight('', null);
    effects.setHighlightExcludeTrack(resolution.highlightExcludeFixedTrack ? [resolution.entityId] : []);
    if (resolution.effects.includes('highlight')) {
      effects.updateSelection([resolution.entityId]);
      effects.triggerManualEvents(resolution.entityId);
    }
    if (options.focus !== false && resolution.effects.includes('follow')) {
      effects.followTarget?.(resolution.entityId);
    } else if (options.focus !== false && resolution.effects.includes('focus')) {
      effects.focusTarget(resolution.entityId);
    }
  };
}
