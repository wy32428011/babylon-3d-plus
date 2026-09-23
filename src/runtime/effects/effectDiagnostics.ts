import type { EffectDiagnostic } from '../../editor/model/effectConfiguration';
const values = new Map<string, EffectDiagnostic>();
const listeners = new Set<() => void>();
const resumeActions = new Map<string, () => void>();
const selectionActions = new Map<string, (targetId: string | null) => void>();
let snapshot: ReadonlyMap<string, EffectDiagnostic> = new Map();
export const getEffectDiagnostics = (): ReadonlyMap<string, EffectDiagnostic> => snapshot;
export function registerEffectFollowSelection(id: string, callback: ((targetId: string | null) => void) | null): void {
  if (callback) selectionActions.set(id, callback); else selectionActions.delete(id);
}
export function selectEffectFollowTarget(id: string, targetId: string | null): void { selectionActions.get(id)?.(targetId); }
export function registerEffectFollowResume(id: string, callback: (() => void) | null): void { if(callback)resumeActions.set(id,callback);else resumeActions.delete(id); }
export function resumeEffectFollow(id: string): void { resumeActions.get(id)?.(); }
export const getEffectDiagnostic = (id: string): EffectDiagnostic | undefined => values.get(id);
export const subscribeEffectDiagnostics = (callback: () => void): (() => void) => { listeners.add(callback); return () => listeners.delete(callback); };
export function publishEffectDiagnostic(id: string, diagnostic: EffectDiagnostic): void {
  values.set(id, diagnostic); snapshot = new Map(values); for (const listener of listeners) listener();
}
export function clearEffectDiagnostic(id: string): void {
  selectionActions.delete(id);
  if (values.delete(id)) { snapshot = new Map(values); for (const listener of listeners) listener(); }
}
