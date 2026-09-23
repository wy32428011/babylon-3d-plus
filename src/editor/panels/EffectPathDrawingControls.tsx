import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PoiEffectComponent } from '../model/components';
import { cancelEffectPathDrawing, commitEffectPathDrawing, getEffectPathDrawing, getEffectPathDrawingMode, startEffectPathDrawing, subscribeEffectPathDrawing, undoEffectPathDrawingPoint } from '../model/effectPathDrawing';

type Props = { entityId: string; component: PoiEffectComponent; disabled?: boolean; onChange: (component: PoiEffectComponent, label: string) => void };

export function EffectPathDrawingControls({ entityId, component, disabled, onChange }: Props) {
  const session = useSyncExternalStore(subscribeEffectPathDrawing, getEffectPathDrawing, getEffectPathDrawing);
  const active = session?.entityId === entityId;
  const mode = getEffectPathDrawingMode(component.effectKind);
  const regions = Array.isArray(component.configuration?.parameters.regions) ? component.configuration.parameters.regions : [];
  const [regionId, setRegionId] = useState(() => typeof regions[0]?.id === 'string' ? regions[0].id : '区域1');
  useEffect(() => { setRegionId(typeof regions[0]?.id === 'string' ? regions[0].id : '区域1'); }, [entityId, component.effectKind]);
  useEffect(() => () => cancelEffectPathDrawing(entityId), [entityId]);
  useEffect(() => { if (active && (disabled || session.effectKind !== component.effectKind)) cancelEffectPathDrawing(entityId); }, [active, disabled, entityId, component.effectKind, session]);
  if (!mode) return null;
  return <div className="inspector-subsection" data-effect-path-drawing={entityId}>
    <div className="inspector-subsection-title">场景绘制{mode === 'path' ? '路径' : '轮廓'}</div>
    {component.effectKind === 'region-level' ? <label className="inspector-row"><span>绘制区域 ID</span><input aria-label="绘制区域 ID" disabled={disabled || active} list={`effect-draw-regions-${entityId}`} value={regionId} maxLength={120} onChange={event => setRegionId(event.target.value)} /><datalist id={`effect-draw-regions-${entityId}`}>{regions.map(region => <option key={String(region.id)} value={String(region.id)}>{String(region.name ?? region.id)}</option>)}</datalist></label> : null}
    <div className="inspector-button-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <button type="button" disabled={disabled || active || (component.effectKind === 'region-level' && !regionId.trim())} onClick={() => startEffectPathDrawing(entityId, component.effectKind, regionId)}>场景绘制</button>
      {active ? <>
        <button type="button" disabled={disabled || !session.points.length} onClick={undoEffectPathDrawingPoint}>撤销绘制点</button>
        <button type="button" disabled={disabled} onClick={() => { const next = commitEffectPathDrawing(component); if (next) onChange(next, '应用特效场景绘制'); }}>应用绘制</button>
        <button type="button" onClick={() => cancelEffectPathDrawing(entityId)}>取消</button>
      </> : null}
    </div>
    {active ? <div role="status" aria-live="polite">已绘制 {session.points.length} / 128 个点。左键点击场景地面添加；Esc 取消。{mode === 'wall' ? '光墙按自身局部 X/Z 轮廓与已有底部标高显示。' : ''}</div> : <div className="inspector-help">在场景中点击绘制，确认后一次应用。轮廓自动闭合，已有配置保留到确认。</div>}
    {active && session.error ? <div role="alert" className="inspector-error">{session.error}</div> : null}
    {component.effectKind === 'fly-line' ? <div className="muted">飞线使用首尾点作为起终点，弧高由特效属性设置。</div> : null}
  </div>;
}
