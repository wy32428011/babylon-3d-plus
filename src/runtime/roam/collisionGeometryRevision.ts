import { VertexBuffer, type Geometry } from '@babylonjs/core';

type GeometryUpdate = Geometry['onGeometryUpdated'];
type RevisionState = {
  revision: number;
  references: number;
  callback: GeometryUpdate;
  previous: GeometryUpdate;
};

const revisions = new WeakMap<Geometry, RevisionState>();

/** 多个碰撞世界共享一次几何变更监听，保留应用已有回调和最后一次释放时的所有权。 */
export function acquireCollisionGeometryRevision(geometry: Geometry) {
  let state = revisions.get(geometry);
  if (!state) {
    state = { revision: 0, references: 0, callback: geometry.onGeometryUpdated, previous: geometry.onGeometryUpdated };
    revisions.set(geometry, state);
    install(geometry, state);
  }
  const shared = state;
  shared.references += 1;
  let released = false;
  return {
    read(): number {
      if (!released && geometry.onGeometryUpdated !== shared.callback) {
        // 外部替换了回调时不能假定期间没有几何更新；重新登记并使旧索引失效。
        shared.revision += 1;
        install(geometry, shared);
      }
      return shared.revision;
    },
    release(): void {
      if (released) return;
      released = true;
      shared.references -= 1;
      if (shared.references > 0) return;
      if (geometry.onGeometryUpdated === shared.callback) geometry.onGeometryUpdated = shared.previous;
      revisions.delete(geometry);
    },
  };
}

function install(geometry: Geometry, state: RevisionState): void {
  const previous = geometry.onGeometryUpdated;
  // 捕获当次回调而非读取可变 previous，避免应用包装旧回调后重新接入形成递归。
  const callback: GeometryUpdate = function (this: Geometry, updated, kind) {
    if (kind === undefined || kind === VertexBuffer.PositionKind) state.revision += 1;
    previous?.call(this, updated, kind);
  };
  state.previous = previous;
  state.callback = callback;
  geometry.onGeometryUpdated = callback;
}
