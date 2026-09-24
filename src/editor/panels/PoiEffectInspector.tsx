import { EffectConfigurationInspector } from './EffectConfigurationInspector';
import { EffectPathDrawingControls } from './EffectPathDrawingControls';
import { ENVIRONMENT_EFFECT_TARGET_ID, isEnvironmentBuildingEffectKind } from '../model/environmentBuildingEffect';
import { PoiEffectAppearanceFields } from './PoiEffectAppearanceFields';
import type { ChangeEvent } from 'react';
import type { PoiEffectComponent, PoiEffectKind } from '../model/components';
import {
  POI_EFFECT_DEFINITIONS,
  VISIBLE_POI_EFFECT_DEFINITIONS,
  createDefaultPoiEffectComponent,
} from '../model/poiEffect';
import { useEditorStore } from '../store/editorStore';

type PoiEffectInspectorProps = {
  component: PoiEffectComponent;
  disabled?: boolean;
};


/** 渲染并编辑内置 EFF 的通用 Inspector 表单。 */
export function PoiEffectInspector({ component, disabled = false }: PoiEffectInspectorProps) {
  const updateSelectedPoiEffect = useEditorStore((state) => state.updateSelectedPoiEffect);
  const controlsDisabled = disabled;
  const legacyDefinition = !VISIBLE_POI_EFFECT_DEFINITIONS.some(item => item.kind === component.effectKind)
    ? POI_EFFECT_DEFINITIONS.find(item => item.kind === component.effectKind) : undefined;
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);

  /** 提交完整组件配置，由 Store 负责写入选中实体和撤销历史。 */
  function commitComponent(nextComponent: PoiEffectComponent, label: string): void {
    if (controlsDisabled) return;
    updateSelectedPoiEffect(nextComponent, label);
  }

  /** 切换特效类型时应用该类型的默认颜色和数值参数。 */
  function handleKindChange(event: ChangeEvent<HTMLSelectElement>): void {
    const nextKind = event.target.value as PoiEffectKind;
    const next = createDefaultPoiEffectComponent(nextKind);
    if (component.visual?.targetEntityId === ENVIRONMENT_EFFECT_TARGET_ID && isEnvironmentBuildingEffectKind(nextKind) && next.visual) {
      next.visual.targetEntityId = ENVIRONMENT_EFFECT_TARGET_ID;
    }
    if (component.configuration) next.configuration = { ...component.configuration, parameters: {} };
    commitComponent(next, '切换特效类型');
  }

  /** 更新启用状态，不改变当前特效类型和其他参数。 */
  function handleEnabledChange(event: ChangeEvent<HTMLInputElement>): void {
    commitComponent({ ...component, enabled: event.target.checked }, '切换特效启用状态');
  }

  return (
    <fieldset className="transform-fieldset" disabled={controlsDisabled}>
      <legend>特效</legend>

      <label className="inspector-row">
        <span>特效类型</span>
        <select disabled={controlsDisabled} value={component.effectKind} onChange={handleKindChange}>
          {legacyDefinition && <option value={legacyDefinition.kind}>{legacyDefinition.name}（旧版 · 兼容已有场景）</option>}
          {VISIBLE_POI_EFFECT_DEFINITIONS.map((definition) => (
            <option key={definition.kind} value={definition.kind}>
              {definition.name}（{definition.subtitle}）
            </option>
          ))}
        </select>
      </label>

      <label className="mqtt-config-dialog-checkbox">
        <input checked={component.enabled} disabled={controlsDisabled} type="checkbox" onChange={handleEnabledChange} />
        启用特效
      </label>

      <PoiEffectAppearanceFields component={component} disabled={controlsDisabled} onChange={commitComponent} instanceKey={selectedEntityId ?? undefined} />
      {component.effectKind !== 'light-wall-fence' && <p className="muted">
        {component.visual?.targetEntityId === ENVIRONMENT_EFFECT_TARGET_ID
          ? '特效直接作用于环境模型，位置、旋转与缩放请在场景的环境属性中调整。'
          : '坐标约定：Position = 锚点，Rotation = 方向，Scale = 范围。'}
      </p>}
      <EffectConfigurationInspector key={`${selectedEntityId}:${component.effectKind}`} component={component} disabled={controlsDisabled} onChange={commitComponent} />
      {selectedEntityId && <EffectPathDrawingControls entityId={selectedEntityId} component={component} disabled={controlsDisabled} onChange={commitComponent} />}
    </fieldset>
  );
}


