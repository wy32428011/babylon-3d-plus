import type { PoiEffectComponent } from './components';
import type { Vector3Data } from './math';
import { createDefaultDigitalTwinEffectConfig } from './digitalTwinEffect';
import { createDefaultLightWallFence, validateLightWallPoints } from './lightWallFence';
import { createDefaultEffectConfiguration } from './effectConfigurationValidation';

export type EffectPathDrawingMode = 'path' | 'area' | 'wall';
export type EffectPathDrawingPoint = { readonly world: Vector3Data; readonly local: Vector3Data };
export type EffectPathDrawingSession = {
  readonly entityId: string;
  readonly effectKind: string;
  readonly mode: EffectPathDrawingMode;
  readonly regionId: string;
  readonly points: readonly EffectPathDrawingPoint[];
  readonly error: string | null;
};

const pathKinds = new Set(['flow-path', 'flow-arrows', 'fly-line', 'motion-trail', 'path-reveal', 'pipe-flow', 'evacuation-route']);
const areaKinds = new Set(['boundary-flow', 'area-fill', 'water-surface', 'region-level']);
let session: EffectPathDrawingSession | null = null;
const listeners = new Set<() => void>();
const publish = (next: EffectPathDrawingSession | null) => { session = next; for (const listener of [...listeners]) listener(); };

export function getEffectPathDrawingMode(kind: string): EffectPathDrawingMode | null {
  return kind === 'light-wall-fence' ? 'wall' : areaKinds.has(kind) ? 'area' : pathKinds.has(kind) ? 'path' : null;
}
export function getEffectPathDrawing(): EffectPathDrawingSession | null { return session; }
export function subscribeEffectPathDrawing(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function startEffectPathDrawing(entityId: string, effectKind: string, regionId = ''): boolean {
  const mode = getEffectPathDrawingMode(effectKind);
  if (!entityId || !mode) return false;
  publish({ entityId, effectKind, mode, regionId: regionId.trim().slice(0, 120), points: [], error: null });
  return true;
}
export function cancelEffectPathDrawing(entityId?: string): void { if (session && (!entityId || entityId === session.entityId)) publish(null); }
export function setEffectPathDrawingError(error: string): void { if (session) publish({ ...session, error }); }

export function appendEffectPathDrawingPoint(world: Vector3Data, local: Vector3Data): boolean {
  if (!session) return false;
  if (session.points.length >= 128) { setEffectPathDrawingError('最多绘制 128 个点。'); return false; }
  if ([world, local].some(point => !point || [point.x, point.y, point.z].some(value => !Number.isFinite(value) || Math.abs(value) > 100000))) {
    setEffectPathDrawingError('绘制坐标需要是 ±100000 米以内的有限数值。'); return false;
  }
  const previous = session.points.at(-1)?.local;
  if (previous && Math.hypot(local.x - previous.x, local.y - previous.y, local.z - previous.z) < .001) {
    setEffectPathDrawingError('相邻绘制点至少间隔 0.001 米。'); return false;
  }
  publish({ ...session, error: null, points: [...session.points, { world: { ...world }, local: { ...local } }] });
  return true;
}
export function undoEffectPathDrawingPoint(): void {
  if (session) publish({ ...session, error: null, points: session.points.slice(0, -1) });
}

function crosses(a: Vector3Data, b: Vector3Data, c: Vector3Data, d: Vector3Data): boolean {
  const cross = (u: Vector3Data, v: Vector3Data, w: Vector3Data) => (v.x - u.x) * (w.z - u.z) - (v.z - u.z) * (w.x - u.x);
  const epsilon = 1e-8;
  if (Math.max(a.x, b.x) + epsilon < Math.min(c.x, d.x) || Math.max(c.x, d.x) + epsilon < Math.min(a.x, b.x) || Math.max(a.z, b.z) + epsilon < Math.min(c.z, d.z) || Math.max(c.z, d.z) + epsilon < Math.min(a.z, b.z)) return false;
  return cross(a, b, c) * cross(a, b, d) <= epsilon && cross(c, d, a) * cross(c, d, b) <= epsilon;
}

export function getEffectPathDrawingValidation(component: PoiEffectComponent): string | null {
  if (!session) return '没有正在绘制的路径。';
  if (session.effectKind !== component.effectKind) return '特效类型已变化，请重新绘制。';
  const closed = session.mode !== 'path' || component.configuration?.parameters.closed === true;
  const minimum = closed ? 3 : 2;
  if (session.points.length < minimum) return `至少绘制 ${minimum} 个点后才能应用。`;
  if (closed) {
    const error = validateLightWallPoints(session.points.map(point => point.local));
    if (error) return error;
  } else {
    const points = session.points.map(point => point.world);
    for (let i = 0; i < points.length - 1; i++) {
      if (i + 2 < points.length) {
        const a = points[i], b = points[i + 1], c = points[i + 2];
        const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
        if (Math.abs(cross) < 1e-8 && (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z) < 0) return '路径不能折返重叠。';
      }
      for (let j = i + 2; j < points.length - 1; j++) if (crosses(points[i], points[i + 1], points[j], points[j + 1])) return '路径不能自交或重叠。';
    }
  }
  if (session.effectKind === 'region-level' && !session.regionId) return '请填写或选择需要绘制的区域 ID。';
  return null;
}

/** 只在确认时返回新组件；草稿从未进入场景 Store 或撤销历史。 */
export function commitEffectPathDrawing(component: PoiEffectComponent): PoiEffectComponent | null {
  const current = session;
  if (!current) return null;
  const error = getEffectPathDrawingValidation(component);
  if (error) { setEffectPathDrawingError(error); return null; }
  const points = current.points.map(point => ({ ...point.local }));
  let next: PoiEffectComponent;
  if (current.mode === 'wall') next = { ...component, lightWall: { ...(component.lightWall ?? createDefaultLightWallFence()), points: points.map(({ x, z }) => ({ x, z })) } };
  else if (current.effectKind === 'region-level') {
    const configuration = component.configuration ?? createDefaultEffectConfiguration(component);
    const regions = Array.isArray(configuration.parameters.regions) ? configuration.parameters.regions : [];
    const index = regions.findIndex(region => region.id === current.regionId);
    if (index < 0 && regions.length >= 64) { setEffectPathDrawingError('最多配置 64 个区域，请先选择已有区域。'); return null; }
    const region = index >= 0 ? { ...regions[index], points } : { id: current.regionId, name: current.regionId, value: 0, points };
    next = { ...component, configuration: { ...configuration, parameters: { ...configuration.parameters, regions: index >= 0 ? regions.map((row, i) => i === index ? region : row) : [...regions, region] } } };
  } else {
    next = { ...component, visual: { ...(component.visual ?? createDefaultDigitalTwinEffectConfig(component.effectKind)), points } };
    if (current.effectKind === 'water-surface') {
      const configuration = component.configuration ?? createDefaultEffectConfiguration(component);
      next.configuration = { ...configuration, parameters: { ...configuration.parameters, usePolygon: true } };
    }
  }
  publish(null);
  return next;
}
