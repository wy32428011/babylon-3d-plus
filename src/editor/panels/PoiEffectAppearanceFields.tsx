import type { PoiEffectComponent, PoiEffectKind } from '../model/components';
import { isConveyorArrowEffectKind } from '../model/conveyorArrowEffect';
import { isDigitalTwinEffectKind } from '../model/digitalTwinEffect';
import { POI_EFFECT_DENSITY_MAX, POI_EFFECT_DENSITY_MIN, POI_EFFECT_INTENSITY_MAX, POI_EFFECT_INTENSITY_MIN, POI_EFFECT_SPEED_MAX, POI_EFFECT_SPEED_MIN } from '../model/poiEffect';
import { ConveyorArrowEffectInspector } from './ConveyorArrowEffectInspector';
import { DigitalTwinEffectInspector } from './DigitalTwinEffectInspector';
import { EffectParameterInspector } from './EffectConfigurationInspector';
import { LightWallFenceInspector } from './LightWallFenceInspector';

type Props = {
  component: PoiEffectComponent;
  disabled: boolean;
  onChange: (component: PoiEffectComponent, label: string) => void;
  instanceKey?: string;
  alarmAppearance?: boolean;
};
type NumberField = { key: 'intensity' | 'speed' | 'density'; label: string; min: number; max: number; step: number };
const NUMBER_FIELDS: readonly NumberField[] = [
  { key: 'intensity', label: '强度', min: POI_EFFECT_INTENSITY_MIN, max: POI_EFFECT_INTENSITY_MAX, step: 0.1 },
  { key: 'speed', label: '速度', min: POI_EFFECT_SPEED_MIN, max: POI_EFFECT_SPEED_MAX, step: 0.1 },
  { key: 'density', label: '密度', min: POI_EFFECT_DENSITY_MIN, max: POI_EFFECT_DENSITY_MAX, step: 0.1 },
];
const STATIC_EFFECTS = new Set(['model-color', 'alarm-label', 'alarm-zone', 'model-outline', 'model-edges', 'model-emissive', 'height-gradient', 'xray', 'floor-expand', 'explode', 'clip-section', 'roof-fade', 'heatmap', 'region-level', 'data-bars', 'camera-frustum', 'environment-fog']);
const DENSITY_EFFECTS = new Set(['rain', 'snow', 'flame', 'smoke-plume', 'flow-arrows', 'pipe-flow']);

function commonFieldVisible(kind: PoiEffectKind, field: NumberField['key']): boolean {
  if (field === 'speed') return !STATIC_EFFECTS.has(kind);
  if (field === 'density') return DENSITY_EFFECTS.has(kind);
  return true;
}

/** 普通特效和报警外观共用外观字段；写入对象由调用方决定。 */
export function PoiEffectAppearanceFields({ component, disabled, onChange, instanceKey, alarmAppearance = false }: Props) {
  const digitalTwin = isDigitalTwinEffectKind(component.effectKind);
  const conveyorArrow = isConveyorArrowEffectKind(component.effectKind);
  const commit = (next: PoiEffectComponent, label: string) => { if (!disabled) onChange(next, label); };
  return <>
    {component.effectKind === 'light-wall-fence' ? <LightWallFenceInspector key={instanceKey} component={component} disabled={disabled} onChange={commit} /> : <>
      <label className="inspector-row"><span>主颜色</span>
        <input aria-label="主颜色" disabled={disabled} type="color" value={component.primaryColor}
          onChange={event => commit({ ...component, primaryColor: event.target.value }, '更新特效主颜色')} />
      </label>
      <label className="inspector-row"><span>辅助颜色</span>
        <input aria-label="辅助颜色" disabled={disabled} type="color" value={component.secondaryColor}
          onChange={event => commit({ ...component, secondaryColor: event.target.value }, '更新特效辅助颜色')} />
      </label>
      {NUMBER_FIELDS.filter(field => conveyorArrow ? field.key !== 'density' : !digitalTwin || commonFieldVisible(component.effectKind, field.key)).map(field => {
        const min = (digitalTwin || conveyorArrow) && field.key === 'speed' ? 0 : field.min;
        return <label className="number-row" key={field.key}><span>{field.label}</span>
          <input aria-label={field.label} disabled={disabled} type="number" value={component[field.key]} min={min} max={field.max} step={field.step}
            onChange={event => {
              if (!event.target.value || !Number.isFinite(Number(event.target.value))) return;
              commit({ ...component, [field.key]: Math.min(field.max, Math.max(min, Number(event.target.value))) }, `更新特效${field.label}`);
            }} />
        </label>;
      })}
      {conveyorArrow && <ConveyorArrowEffectInspector component={component} disabled={disabled} onChange={commit} />}
      {digitalTwin && <DigitalTwinEffectInspector key={`${instanceKey}:${component.effectKind}`} component={component} disabled={disabled} onChange={commit} hideTargetBinding={alarmAppearance} />}
    </>}
    {alarmAppearance && <div className="effect-configuration"><EffectParameterInspector component={component} disabled={disabled} onChange={commit} /></div>}
  </>;
}
