import type { TransformComponent } from '../model/components';
import type { SceneDocument } from '../model/SceneDocument';
import type { Entity } from '../model/Entity';

export type TransformPreviewSnapshot = {
  token: number;
  sceneSessionId: string;
  entityId: string;
  transform: TransformComponent;
};
export type TransformPreviewSession = {
  token: number;
  sceneSessionId: string;
  sceneId: string;
  entityId: string;
  before: TransformComponent;
  lineage: string;
  asset: unknown;
};
const copy = (value: TransformComponent): TransformComponent => ({
  position: { ...value.position }, rotation: { ...value.rotation }, scale: { ...value.scale },
});
export function equalPreviewTransform(a: TransformComponent, b: TransformComponent): boolean {
  return (['position', 'rotation', 'scale'] as const).every(field => (['x', 'y', 'z'] as const).every(axis => a[field][axis] === b[field][axis]));
}
function lineage(scene: SceneDocument, entityId: string): string {
  const result: unknown[] = [], seen = new Set<string>();
  let id: string | null | undefined = entityId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const entity: Entity | undefined = scene.entities[id];
    if (!entity) return '!missing';
    if (entity.locked === true) return '!locked';
    result.push([id, entity.parentId, entity.locked, id === entityId ? null : entity.components.transform]);
    id = entity.parentId;
  }
  return id ? '!cycle' : JSON.stringify(result);
}

/** Inspector 临时坐标不进入文档、撤销栈或保存载荷；代次阻止旧拖拽清理新会话。 */
export class TransformPreviewStore {
  private snapshot: TransformPreviewSnapshot | null = null;
  private sequence = 0;
  private listeners = new Set<() => void>();
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  begin(sceneSessionId: string, scene: SceneDocument, entityId: string, before: TransformComponent): TransformPreviewSession {
    const token = ++this.sequence;
    const session = { token, sceneSessionId, sceneId: scene.id, entityId, before: copy(before),
      lineage: lineage(scene, entityId), asset: scene.entities[entityId]?.components.modelAsset };
    this.snapshot = { token, sceneSessionId, entityId, transform: copy(before) };
    this.emit();
    return session;
  }
  publish(session: TransformPreviewSession, transform: TransformComponent): void {
    if (this.snapshot?.token !== session.token || equalPreviewTransform(this.snapshot.transform, transform)) return;
    this.snapshot = { ...this.snapshot, transform: copy(transform) };
    this.emit();
  }
  clear(session: TransformPreviewSession): void {
    if (this.snapshot?.token !== session.token) return;
    this.snapshot = null;
    this.emit();
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

/** 外部编辑、锁定、祖先/场景切换都使旧拖拽失效，取消时以当前文档为准。 */
export function isTransformPreviewSessionValid(session: TransformPreviewSession, state: {
  sceneSessionId: string; scene: SceneDocument; runtimeMode: string;
}): boolean {
  const entity = state.scene.entities[session.entityId];
  const currentLineage = lineage(state.scene, session.entityId);
  return state.runtimeMode === 'edit' && state.sceneSessionId === session.sceneSessionId && state.scene.id === session.sceneId
    && state.scene.selectedEntityId === session.entityId && Boolean(entity) && !entity.locked
    && equalPreviewTransform(entity.components.transform, session.before)
    && entity.components.modelAsset === session.asset && !currentLineage.startsWith('!') && currentLineage === session.lineage;
}
export const transformPreviewStore = new TransformPreviewStore();
