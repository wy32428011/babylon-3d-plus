import type { Entity } from '../../editor/model/Entity';

export type SpawnedDeviceInspectorSnapshot = {
  entityId: string;
  entity: Entity;
  spawnerEntityId: string;
  spawnerName: string;
};

type Listener = () => void;

/** 动态设备的只读 Inspector 快照；实体仍只属于运行时，不写入 SceneDocument。 */
export class SpawnedDeviceInspectorStore {
  private readonly snapshots = new Map<string, SpawnedDeviceInspectorSnapshot>();
  private readonly listeners = new Set<Listener>();

  register(snapshot: SpawnedDeviceInspectorSnapshot): void {
    this.snapshots.set(snapshot.entityId, snapshot);
    this.emitChange();
  }

  getSnapshot(entityId: string | null | undefined): SpawnedDeviceInspectorSnapshot | null {
    return entityId ? this.snapshots.get(entityId) ?? null : null;
  }

  delete(entityId: string): void {
    if (this.snapshots.delete(entityId)) this.emitChange();
  }

  clear(): void {
    if (this.snapshots.size === 0) return;
    this.snapshots.clear();
    this.emitChange();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

export const spawnedDeviceInspectorStore = new SpawnedDeviceInspectorStore();
