import type { LightingProbeVolume, LightingProbeBounds } from '../../../electron/shared/sceneLightingProbeVolumes';
import { LightingManagerNumberField, LightingManagerToggle } from './LightingBakeManagerWidgets';

type Props = { volumes?: LightingProbeVolume[]; bounds?: LightingProbeBounds; disabled: boolean; onChange: (volumes: LightingProbeVolume[]) => void };
const AXES = ['X', 'Y', 'Z'] as const;

/** 区域使用世界坐标，只限制探针分布，不裁掉烘焙遮挡和反弹几何。 */
export function LightingBakeManagerProbeVolumes({ volumes = [], bounds, disabled, onChange }: Props) {
  const sceneBounds = bounds && [...bounds.min, ...bounds.max].every(Number.isFinite) ? {
    min: [...bounds.min] as [number, number, number],
    max: bounds.max.map((value, axis) => Math.max(value, bounds.min[axis] + 1)) as [number, number, number],
  } : undefined;
  function update(id: string, patch: Partial<LightingProbeVolume>) { onChange(volumes.map(volume => volume.id === id ? { ...volume, ...patch } : volume)); }
  function coordinate(volume: LightingProbeVolume, side: 'min' | 'max', axis: number, value: number) {
    const coordinates = [...volume[side]] as [number, number, number]; coordinates[axis] = value; update(volume.id, { [side]: coordinates });
  }
  return <details className="lighting-manager-advanced lighting-manager-probe-volumes">
    <summary>探针覆盖区域（{volumes.length}）</summary>
    <p className="lighting-manager-note">没有启用区域时覆盖全场。启用区域使用世界坐标（米），只限定探针分布；全场静态几何仍参与遮挡与反弹。重叠位置自动去重。</p>
    {volumes.map((volume, index) => <article key={volume.id} className="lighting-manager-probe-volume">
      <div className="lighting-manager-card-heading"><strong>区域 {index + 1}</strong><button type="button" disabled={disabled} onClick={() => onChange(volumes.filter(item => item.id !== volume.id))}>移除区域 {index + 1}</button></div>
      <label className="lighting-manager-field"><span>名称</span><input aria-label={'探针区域 ' + (index + 1) + ' 名称'} value={volume.name} maxLength={80} disabled={disabled} onChange={event => update(volume.id, { name: event.target.value })} /></label>
      <LightingManagerToggle label={'启用探针区域 ' + (index + 1)} checked={volume.enabled} disabled={disabled} onChange={enabled => update(volume.id, { enabled })} />
      <div className="lighting-manager-probe-coordinates">{(['min', 'max'] as const).map(side => <fieldset key={side} disabled={disabled}><legend>{side === 'min' ? '最小坐标' : '最大坐标'}</legend>{AXES.map((axis, ordinal) => <LightingManagerNumberField key={axis}
        label={'区域 ' + (index + 1) + (side === 'min' ? ' 最小 ' : ' 最大 ') + axis} value={volume[side][ordinal]} unit="m" step={0.5}
        min={side === 'min' ? -Number.MAX_SAFE_INTEGER : volume.min[ordinal] + 0.001} max={side === 'max' ? Number.MAX_SAFE_INTEGER : volume.max[ordinal] - 0.001}
        disabled={disabled} onChange={value => coordinate(volume, side, ordinal, value)} />)}</fieldset>)}</div>
      <p className="lighting-manager-note">每个轴的最小坐标必须小于最大坐标。</p>
      {sceneBounds && <button type="button" disabled={disabled} onClick={() => update(volume.id, sceneBounds)}>使用当前预检场景范围</button>}
    </article>)}
    <button type="button" disabled={disabled} onClick={() => onChange([...volumes, { id: crypto.randomUUID(), name: '覆盖区域 ' + (volumes.length + 1), enabled: true,
      min: sceneBounds?.min ?? [-5, 0, -5], max: sceneBounds?.max ?? [5, 5, 5] }])}>添加覆盖区域</button>
  </details>;
}
