import type { ConveyorArrowEffectConfig, PoiEffectComponent } from '../model/components';
import { sanitizeConveyorArrowEffect } from '../model/conveyorArrowEffect';

type Props = { component: PoiEffectComponent; disabled: boolean; onChange: (component: PoiEffectComponent, label: string) => void };

export function ConveyorArrowEffectInspector({ component, disabled, onChange }: Props) {
  const config = sanitizeConveyorArrowEffect(component.conveyorArrow, component.effectKind);
  const commit = (patch: Partial<ConveyorArrowEffectConfig>) => {
    if (!disabled) onChange({ ...component, conveyorArrow: { ...config, ...patch } }, '更新输送箭头配置');
  };
  const repeated = ['conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-double'].includes(component.effectKind);
  const fields = [
    { key: 'length', label: '长度（米）', min: 0.1, max: 10000, step: 0.1 },
    { key: 'width', label: '宽度（米）', min: 0.1, max: 10000, step: 0.1 },
    { key: 'opacity', label: '不透明度', min: 0, max: 1, step: 0.05 },
    ...(repeated ? [{ key: 'count' as const, label: '箭头/分段数量', min: 1, max: 32, step: 1 }] : []),
  ] as const;
  return <div data-testid="conveyor-arrow-effect-inspector" style={{ display: 'grid', gap: 8 }}>
    {fields.map(field => <label className="number-row" key={field.key} style={{ gridTemplateColumns: '112px minmax(0, 1fr)' }}><span>{field.label}</span>
      <input type="number" aria-label={field.label} disabled={disabled} min={field.min} max={field.max} step={field.step}
        value={config[field.key]}
        onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) commit({ [field.key]: event.target.valueAsNumber }); }} />
    </label>)}
    <label className="mqtt-config-dialog-checkbox"><input type="checkbox" disabled={disabled} checked={config.reverse}
      onChange={event => commit({ reverse: event.target.checked })} />反向</label>
    <p className="muted">默认沿局部 +X 方向，铺在 X/Z 平面。调整位置高度贴合输送面，旋转可改变朝向；速度为 0 时静止，不透明度为 0 时隐藏。也可将库卡片拖入设备的“表面箭头”样式框。</p>
  </div>;
}
