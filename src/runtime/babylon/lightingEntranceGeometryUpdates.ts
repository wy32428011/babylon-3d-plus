import type { Geometry } from '@babylonjs/core/Meshes/geometry.js';

type Scope = { listeners: Set<object> };
const scopes = new WeakMap<Geometry, Scope>();

/** 只覆盖入口自有同步属性写；离开调用栈立即撤销，不允许跨帧或任意属性豁免。 */
export function withLightingEntranceAttributeUpdate<T>(geometry: Geometry | null, run: () => T): T {
  if (!geometry) return run();
  const previous = scopes.get(geometry); scopes.set(geometry, { listeners: new Set() });
  try { return run(); }
  finally { if (previous) scopes.set(geometry, previous); else scopes.delete(geometry); }
}

/** 在转发原callback前消费本listener的同步票据，重入的业务写不能借外层入口scope放行。 */
export function consumeLightingEntranceAttributeUpdate(geometry: Geometry, kind: string | undefined, listener: object): boolean {
  const current = scopes.get(geometry);
  if (!current || kind !== 'dtEntranceInstance' || current.listeners.has(listener)) return false;
  current.listeners.add(listener); return true;
}
