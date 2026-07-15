import type { ChangeEvent } from 'react';
import type { PoiEffectComponent, PoiEffectKind } from '../model/components';
import {
  POI_EFFECT_DEFINITIONS,
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
  { key: 'intensity', label: '强度', min: POI_EFFECT_INTENSITY_MIN, max: POI_EFFECT_INTENSITY_MAX, step: 0.1, commitLabel: '更新 POI 特效强度' },
  { key: 'speed', label: '速度', min: POI_EFFECT_SPEED_MIN, max: POI_EFFECT_SPEED_MAX, step: 0.1, commitLabel: '更新 POI 特效速度' },
  { key: 'density', label: '密度', min: POI_EFFECT_DENSITY_MIN, max: POI_EFFECT_DENSITY_MAX, step: 0.1, commitLabel: '更新 POI 特效密度' },
];

/** 将输入数值限制在特效参数允许范围内，避免 Inspector 写入运行时无法解释的值。 */
function clampEffectNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 渲染并编辑 POI 内置 EFF 的通用 Inspector 表单。 */
export function PoiEffectInspector({ component, disabled = false }: PoiEffectInspectorProps) {
  const updateSelectedPoiEffect = useEditorStore((state) => state.updateSelectedPoiEffect);
  const controlsDisabled = disabled;

  /** 提交完整组件配置，由 Store 负责写入选中实体和撤销历史。 */
  function commitComponent(nextComponent: PoiEffectComponent, label: string): void {
    if (controlsDisabled) return;
    updateSelectedPoiEffect(nextComponent, label);
  }

  /** 切换特效类型时应用该类型的默认颜色和数值参数。 */
  function handleKindChange(event: ChangeEvent<HTMLSelectElement>): void {
    const nextKind = event.target.value as PoiEffectKind;
    commitComponent(createDefaultPoiEffectComponent(nextKind), '切换 POI 特效类型');
  }

  /** 更新启用状态，不改变当前特效类型和其他参数。 */
  function handleEnabledChange(event: ChangeEvent<HTMLInputElement>): void {
    commitComponent({ ...component, enabled: event.target.checked }, '切换 POI 特效启用状态');
  }

  /** 更新主颜色，颜色控件保证输出浏览器兼容的十六进制字符串。 */
  function handlePrimaryColorChange(event: ChangeEvent<HTMLInputElement>): void {
    commitComponent({ ...component, primaryColor: event.target.value }, '更新 POI 特效主颜色');
  }

  /** 更新辅助颜色，供运行时渲染渐变、边缘光或粒子尾迹使用。 */
  function handleSecondaryColorChange(event: ChangeEvent<HTMLInputElement>): void {
    commitComponent({ ...component, secondaryColor: event.target.value }, '更新 POI 特效辅助颜色');
  }

  /** 更新强度、速度、密度等数值字段，并在写入前夹紧到定义范围。 */
  function handleNumberChange(field: NumberFieldConfig, valueText: string): void {
    if (valueText === '') return;
    const value = clampEffectNumber(Number(valueText), field.min, field.max, component[field.key]);
    commitComponent({ ...component, [field.key]: value }, field.commitLabel);
  }

  return (
    <fieldset className="transform-fieldset">
      <legend>POI 特效</legend>

      <label className="inspector-row">
        <span>特效类型</span>
        <select disabled={controlsDisabled} value={component.effectKind} onChange={handleKindChange}>
          {POI_EFFECT_DEFINITIONS.map((definition) => (
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

      <label className="inspector-row">
        <span>主颜色</span>
        <input disabled={controlsDisabled} type="color" value={component.primaryColor} onChange={handlePrimaryColorChange} />
      </label>

      <label className="inspector-row">
        <span>辅助颜色</span>
        <input disabled={controlsDisabled} type="color" value={component.secondaryColor} onChange={handleSecondaryColorChange} />
      </label>

      {NUMBER_FIELDS.map((field) => (
        <label className="number-row" key={field.key}>
          <span>{field.label}</span>
          <input
            disabled={controlsDisabled}
            max={field.max}
            min={field.min}
            step={field.step}
            type="number"
            value={component[field.key]}
            onChange={(event) => handleNumberChange(field, event.target.value)}
          />
        </label>
      ))}

      <p className="muted">
        坐标约定：Position = 锚点，Rotation = 方向，Scale = 范围。
      </p>
    </fieldset>
  );
}


