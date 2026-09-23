import { ConveyorArrowEffectInspector } from './ConveyorArrowEffectInspector';
import { isConveyorArrowEffectKind } from '../model/conveyorArrowEffect';
import { EffectConfigurationInspector } from './EffectConfigurationInspector';
import { EffectPathDrawingControls } from './EffectPathDrawingControls';
import { ENVIRONMENT_EFFECT_TARGET_ID, isEnvironmentBuildingEffectKind } from '../model/environmentBuildingEffect';
import { LightWallFenceInspector } from './LightWallFenceInspector';
import { DigitalTwinEffectInspector } from './DigitalTwinEffectInspector';
import { isDigitalTwinEffectKind } from '../model/digitalTwinEffect';
import type { ChangeEvent } from 'react';
import type { PoiEffectComponent, PoiEffectKind } from '../model/components';
import {
  POI_EFFECT_DEFINITIONS,
  VISIBLE_POI_EFFECT_DEFINITIONS,
  POI_EFFECT_DENSITY_MAX,
  POI_EFFECT_DENSITY_MIN,
  POI_EFFECT_INTENSITY_MAX,
  POI_EFFECT_INTENSITY_MIN,
  POI_EFFECT_SPEED_MAX,
  POI_EFFECT_SPEED_MIN,
  createDefaultPoiEffectComponent,
} from '../model/poiEffect';
import { useEditorStore } from '../store/editorStore';

type PoiEffectInspectorProps = {
  component: PoiEffectComponent;
  disabled?: boolean;
};


type NumberFieldConfig = {
  key: 'intensity' | 'speed' | 'density';
  label: string;
  min: number;
  max: number;
  step: number;
  commitLabel: string;
};

const NUMBER_FIELDS: readonly NumberFieldConfig[] = [
  { key: 'intensity', label: '强度', min: POI_EFFECT_INTENSITY_MIN, max: POI_EFFECT_INTENSITY_MAX, step: 0.1, commitLabel: '更新特效强度' },
  { key: 'speed', label: '速度', min: POI_EFFECT_SPEED_MIN, max: POI_EFFECT_SPEED_MAX, step: 0.1, commitLabel: '更新特效速度' },
  { key: 'density', label: '密度', min: POI_EFFECT_DENSITY_MIN, max: POI_EFFECT_DENSITY_MAX, step: 0.1, commitLabel: '更新特效密度' },
];


const STATIC_EFFECTS = new Set(['model-outline', 'model-edges', 'model-emissive', 'height-gradient', 'xray', 'floor-expand', 'explode', 'clip-section', 'roof-fade', 'heatmap', 'region-level', 'data-bars', 'camera-frustum', 'environment-fog']);
const DENSITY_EFFECTS = new Set(['rain', 'snow', 'flame', 'smoke-plume', 'flow-arrows', 'pipe-flow']);

/** 不展示当前运行时不消费的通用参数。 */
function isCommonEffectFieldVisible(kind: PoiEffectKind, field: NumberFieldConfig['key']): boolean {
  if (field === 'speed') return !STATIC_EFFECTS.has(kind);
  if (field === 'density') return DENSITY_EFFECTS.has(kind);
  return true;
}

/** 将输入数值限制在特效参数允许范围内，避免 Inspector 写入运行时无法解释的值。 */
function clampEffectNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 渲染并编辑内置 EFF 的通用 Inspector 表单。 */
export function PoiEffectInspector({ component, disabled = false }: PoiEffectInspectorProps) {
  const updateSelectedPoiEffect = useEditorStore((state) => state.updateSelectedPoiEffect);
  const controlsDisabled = disabled;
  const isDigitalTwinEffect = isDigitalTwinEffectKind(component.effectKind);
  const isConveyorArrow = isConveyorArrowEffectKind(component.effectKind);
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

  /** 更新主颜色，颜色控件保证输出浏览器兼容的十六进制字符串。 */
  function handlePrimaryColorChange(event: ChangeEvent<HTMLInputElement>): void {
    commitComponent({ ...component, primaryColor: event.target.value }, '更新特效主颜色');
  }

  /** 更新辅助颜色，供运行时渲染渐变、边缘光或粒子尾迹使用。 */
  function handleSecondaryColorChange(event: ChangeEvent<HTMLInputElement>): void {
    commitComponent({ ...component, secondaryColor: event.target.value }, '更新特效辅助颜色');
  }

  /** 更新强度、速度、密度等数值字段，并在写入前夹紧到定义范围。 */
  function handleNumberChange(field: NumberFieldConfig, valueText: string): void {
    if (valueText === '') return;
    const min = (isDigitalTwinEffect || isConveyorArrow) && field.key === 'speed' ? 0 : field.min;
    const value = clampEffectNumber(Number(valueText), min, field.max, component[field.key]);
    commitComponent({ ...component, [field.key]: value }, field.commitLabel);
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

      {component.effectKind === 'light-wall-fence' ? (
        <LightWallFenceInspector key={selectedEntityId} component={component} disabled={controlsDisabled} onChange={commitComponent} />
      ) : <>
      <label className="inspector-row">
        <span>主颜色</span>
        <input disabled={controlsDisabled} type="color" value={component.primaryColor} onChange={handlePrimaryColorChange} />
      </label>

      <label className="inspector-row">
        <span>辅助颜色</span>
        <input disabled={controlsDisabled} type="color" value={component.secondaryColor} onChange={handleSecondaryColorChange} />
      </label>

      {NUMBER_FIELDS.filter(field => isConveyorArrow ? field.key !== 'density' : !isDigitalTwinEffect || isCommonEffectFieldVisible(component.effectKind, field.key)).map((field) => (
        <label className="number-row" key={field.key}>
          <span>{field.label}</span>
          <input
            disabled={controlsDisabled}
            max={field.max}
            min={(isDigitalTwinEffect || isConveyorArrow) && field.key === 'speed' ? 0 : field.min}
            step={field.step}
            type="number"
            value={component[field.key]}
            onChange={(event) => handleNumberChange(field, event.target.value)}
          />
        </label>
      ))}

      {isConveyorArrow && <ConveyorArrowEffectInspector component={component} disabled={controlsDisabled} onChange={commitComponent} />}
      {isDigitalTwinEffect && <DigitalTwinEffectInspector key={`${selectedEntityId}:${component.effectKind}`} component={component} disabled={controlsDisabled} onChange={commitComponent} />}
      <p className="muted">
        {component.visual?.targetEntityId === ENVIRONMENT_EFFECT_TARGET_ID
          ? '特效直接作用于环境模型，位置、旋转与缩放请在场景的环境属性中调整。'
          : '坐标约定：Position = 锚点，Rotation = 方向，Scale = 范围。'}
      </p>
      </>}
      <EffectConfigurationInspector key={`${selectedEntityId}:${component.effectKind}`} component={component} disabled={controlsDisabled} onChange={commitComponent} />
      {selectedEntityId && <EffectPathDrawingControls entityId={selectedEntityId} component={component} disabled={controlsDisabled} onChange={commitComponent} />}
    </fieldset>
  );
}


