import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { OPENING_PACKAGE_MAX_ROUTES, type OpeningPoint, type OpeningRoute, type OpeningRouteStyle } from '../../shared/opening/openingPackage';
import { OpeningField, openingColorInputValue } from './OpeningField';
import { openingRouteCurve, openingUvFromPointer } from './openingRouteCoordinates';

type Endpoint = 'from' | 'to';
type DragState = { id: string; endpoint: Endpoint; point: OpeningPoint; pointerId: number };

export function OpeningRouteEditor({ routes, style, origin, backgroundUrl, imageCoordinates = false, disabled, onChange }: {
  routes: OpeningRoute[]; style?: OpeningRouteStyle; origin?: OpeningPoint; backgroundUrl?: string;
  imageCoordinates?: boolean; disabled: boolean; onChange: (routes: OpeningRoute[]) => void;
}) {
  const [selectedId, setSelectedId] = useState(routes[0]?.id ?? '');
  const [picking, setPicking] = useState<Endpoint | null>(null);
  const [draft, setDraft] = useState<DragState | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAspectRatio, setImageAspectRatio] = useState(16 / 9);
  const dragRef = useRef<DragState | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const selected = routes.find(route => route.id === selectedId);
  useEffect(() => {
    if (!routes.some(route => route.id === selectedId)) setSelectedId(routes[0]?.id ?? '');
  }, [routes, selectedId]);
  useEffect(() => { setImageFailed(false); setImageAspectRatio(16 / 9); }, [backgroundUrl]);
  useEffect(() => { if (disabled) { dragRef.current = null; setDraft(null); setPicking(null); } }, [disabled]);

  function update(id: string, patch: Partial<OpeningRoute>) {
    if (!disabled) onChange(routes.map(route => route.id === id ? { ...route, ...patch } : route));
  }
  function pointerPoint(event: PointerEvent): OpeningPoint | null {
    return mapRef.current ? openingUvFromPointer(event.clientX, event.clientY, mapRef.current.getBoundingClientRect()) : null;
  }
  function startDrag(event: PointerEvent<SVGCircleElement>, route: OpeningRoute, endpoint: Endpoint) {
    if (disabled) return;
    event.preventDefault(); event.stopPropagation();
    setSelectedId(route.id); setPicking(null);
    const active = { id: route.id, endpoint, point: route[endpoint], pointerId: event.pointerId };
    dragRef.current = active; setDraft(active);
    mapRef.current?.setPointerCapture(event.pointerId);
  }
  function finishDrag(event: PointerEvent, cancel = false) {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    dragRef.current = null; setDraft(null);
    if (mapRef.current?.hasPointerCapture(event.pointerId)) mapRef.current.releasePointerCapture(event.pointerId);
    if (!cancel && !disabled) update(active.id, { [active.endpoint]: active.point });
  }
  const displayed = routes.map(route => draft && draft.id === route.id ? { ...route, [draft.endpoint]: draft.point } : route);
  const defaults = { color: '#55d9ff', width: 2, speed: .35, curvature: .2, trail: .15, pulse: true, ...style };
  const aspectRatio = imageCoordinates ? imageAspectRatio : 16 / 9;

  return <div className="opening-route-editor">
    <p className="muted">选择飞线后点击“拾取起点 / 终点”，再点击底图；也可直接拖动点位。UV 左上为 (0,0)，右下为 (1,1)。{imageCoordinates ? '参考包使用完整原底图坐标。' : '通用包使用 16:9 画面坐标，底图按 16:9 裁切。'}</p>
    <div className="opening-route-toolbar">
      <button type="button" disabled={disabled || routes.length >= OPENING_PACKAGE_MAX_ROUTES} onClick={() => {
        const route: OpeningRoute = { id: `route-${crypto.randomUUID()}`, name: `飞线 ${routes.length + 1}`,
          from: origin ? { ...origin } : { x: .5, y: .5 }, to: { x: .72, y: .3 } };
        onChange([...routes, route]); setSelectedId(route.id);
      }}>添加飞线</button>
      <button type="button" disabled={disabled || !selected} aria-pressed={picking === 'from'} onClick={() => setPicking(picking === 'from' ? null : 'from')}>拾取起点</button>
      <button type="button" disabled={disabled || !selected} aria-pressed={picking === 'to'} onClick={() => setPicking(picking === 'to' ? null : 'to')}>拾取终点</button>
    </div>
    <div ref={mapRef} className="opening-route-map" role="group" aria-label="飞线 UV 底图" data-picking={Boolean(picking)}
      style={{ aspectRatio, minHeight: 0 }}
      onPointerDown={event => {
        if (disabled || !picking || !selected) return;
        const point = pointerPoint(event); if (point) update(selected.id, { [picking]: point }); setPicking(null);
      }} onPointerMove={event => {
        const active = dragRef.current;
        if (disabled || !active || active.pointerId !== event.pointerId) return;
        const point = pointerPoint(event); if (!point) return;
        dragRef.current = { ...active, point }; setDraft(dragRef.current);
      }} onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)}
      onLostPointerCapture={event => finishDrag(event, true)}>
      {backgroundUrl && !imageFailed ? <img src={backgroundUrl} alt="飞线底图" draggable={false}
        style={{ objectFit: imageCoordinates ? 'contain' : 'cover' }} onLoad={event => {
          const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setImageAspectRatio(img.naturalWidth / img.naturalHeight);
        }}
        onError={() => setImageFailed(true)} /> : null}
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="飞线与起终点">
        {displayed.map(route => {
          const active = route.id === selectedId;
          return <g key={route.id} opacity={active ? 1 : .55}>
            <path d={openingRouteCurve(route.from, route.to, route.curvature ?? defaults.curvature)}
              stroke={route.color ?? defaults.color} strokeWidth={active ? 3 : 1.5}
              onPointerDown={event => { if (!picking) { event.stopPropagation(); setSelectedId(route.id); } }} />
            {(['from', 'to'] as const).map(endpoint => <circle key={endpoint} cx={route[endpoint].x * 1000} cy={route[endpoint].y * 1000}
              r={active ? 15 : 10} fill={endpoint === 'from' ? '#ffd479' : route.color ?? defaults.color}
              stroke={active ? '#fff' : '#07151e'} strokeWidth={2} role="button" tabIndex={disabled ? -1 : 0}
              aria-label={`${route.name}${endpoint === 'from' ? '起点' : '终点'}`} aria-disabled={disabled}
              onPointerDown={event => startDrag(event, route, endpoint)} onKeyDown={event => {
                if (disabled) return;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(route.id); setPicking(endpoint); return; }
                const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
                const delta = directions[event.key]; if (!delta) return; event.preventDefault();
                setSelectedId(route.id); const step = event.shiftKey ? .05 : .01;
                update(route.id, { [endpoint]: { x: Math.max(0, Math.min(1, route[endpoint].x + delta[0] * step)), y: Math.max(0, Math.min(1, route[endpoint].y + delta[1] * step)) } });
              }} />)}
            {active ? <text transform={`translate(${route.to.x * 1000 + 20} ${route.to.y * 1000 - 20}) scale(1 ${aspectRatio})`}>{route.name}</text> : null}
          </g>;
        })}
      </svg>
    </div>
    {imageFailed ? <p role="alert" className="opening-package-status">底图加载失败，请检查素材；仍可编辑 UV 坐标。</p> : null}
    {picking && selected ? <p role="status" className="muted">点击底图设置“{selected.name}”的{picking === 'from' ? '起点' : '终点'}。</p> : null}
    <label className="inspector-row"><span>飞线列表（{routes.length}）</span><select aria-label="飞线列表" value={selected?.id ?? ''} disabled={!routes.length}
      onChange={event => { setSelectedId(event.target.value); setPicking(null); }}>
      {!routes.length ? <option value="">未添加飞线</option> : null}
      {routes.map(route => <option key={route.id} value={route.id}>{route.name}</option>)}
    </select></label>
    {selected ? <div className="opening-route-selected" key={selected.id}>
      <OpeningField label="飞线名称" value={selected.name} maxLength={160} disabled={disabled} onCommit={name => update(selected.id, { name })} />
      {(['from', 'to'] as const).map(endpoint => <div key={endpoint}>{(['x', 'y'] as const).map(axis =>
        <OpeningField key={axis} label={`${endpoint === 'from' ? '起点' : '终点'} UV ${axis.toUpperCase()}`} value={selected[endpoint][axis]}
          min={0} max={1} disabled={disabled} onCommit={value => update(selected.id, { [endpoint]: { ...selected[endpoint], [axis]: Number(value) } })} />)}</div>)}
      <label className="inspector-row"><span>飞线颜色</span><input type="color" aria-label="飞线颜色" value={openingColorInputValue(selected.color ?? defaults.color)}
        disabled={disabled} onChange={event => update(selected.id, { color: event.target.value })} /></label>
      {([
        ['width', '线宽', 0, 20], ['speed', '流动速度', 0, 10], ['curvature', '曲率', -1, 1], ['trail', '拖尾比例', 0, 1],
      ] as const).map(([key, label, min, max]) => <OpeningField key={key} label={label} value={selected[key] ?? defaults[key]} min={min} max={max}
        disabled={disabled} onCommit={value => update(selected.id, { [key]: Number(value) })} />)}
      <label className="inspector-row"><span>点位脉冲</span><input type="checkbox" checked={selected.pulse ?? defaults.pulse} disabled={disabled}
        onChange={event => update(selected.id, { pulse: event.target.checked })} /></label>
      <button type="button" disabled={disabled} onClick={() => { setPicking(null); onChange(routes.filter(route => route.id !== selected.id)); }}>删除所选飞线</button>
    </div> : <p className="muted">空列表不绘制飞线。</p>}
  </div>;
}
