import assert from 'node:assert/strict';
import test from 'node:test';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { TransformComponent } from '../../src/editor/model/components.ts';
import { TransformPreviewStore, equalPreviewTransform, isTransformPreviewSessionValid } from '../../src/editor/store/transformPreviewStore.ts';

const transform = (x = 0): TransformComponent => ({
  position: { x, y: 0, z: -0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0, y: 1, z: 1 },
});
function fixture() {
  const entity = (id: string, parentId: string | null, isFolder = false) => ({
    id, name: id, parentId, locked: false, visible: true, isFolder, childrenIds: [],
    components: { transform: transform(), ...(id === 'child' ? { modelAsset: { parameterValues: { count: 0, enabled: false } } } : {}) },
  });
  const scene = {
    id: 'scene-a', name: 'scene-a', selectedEntityId: 'child', entityIds: ['root', 'parent', 'child'],
    entities: { root: entity('root', null, true), parent: entity('parent', 'root', true), child: entity('child', 'parent') },
  } as unknown as SceneDocument;
  return { scene, sceneSessionId: 'session-a', runtimeMode: 'edit' };
}

test('轻预览保留 0、false 与原文档，快照复制输入并且不创建历史', () => {
  const state = fixture();
  const original = JSON.stringify(state.scene);
  const store = new TransformPreviewStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const before = transform();
  const session = store.begin(state.sceneSessionId, state.scene, 'child', before);
  before.position.x = 300;
  assert.equal(store.getSnapshot()?.transform.position.x, 0);
  assert.equal(store.getSnapshot()?.transform.scale.x, 0);
  assert.equal(session.before.position.x, 0);
  assert.ok(session.lineage.includes('false'));
  assert.equal(isTransformPreviewSessionValid(session, state), true);
  const initialSnapshot = store.getSnapshot();
  store.publish(session, transform());
  assert.equal(store.getSnapshot(), initialSnapshot);
  assert.equal(notifications, 1, '相同坐标不通知 Inspector');
  const after = transform(2);
  store.publish(session, after);
  after.position.x = 700;
  assert.equal(store.getSnapshot()?.transform.position.x, 2);
  assert.equal(notifications, 2);
  assert.equal(JSON.stringify(state.scene), original, '预览未改文档、asset 中的 0/false 或序列化载荷');
  assert.equal('history' in store, false);
  unsubscribe();
  store.clear(session);
  assert.equal(notifications, 2);
});

test('旧 token 的 publish/clear 无法覆盖或清理新会话，clear 可重复调用', () => {
  const state = fixture();
  const store = new TransformPreviewStore();
  const old = store.begin(state.sceneSessionId, state.scene, 'child', transform());
  const current = store.begin('session-new', { ...state.scene, id: 'scene-new' }, 'child', transform(3));
  const snapshot = store.getSnapshot();
  store.publish(old, transform(8));
  store.clear(old);
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(snapshot?.sceneSessionId, 'session-new');
  assert.equal(snapshot?.transform.position.x, 3);
  store.clear(current);
  store.clear(current);
  assert.equal(store.getSnapshot(), null);
});

test('切 sceneSession、sceneId、选中、运行态或删除实体均使旧会话失效', () => {
  const state = fixture();
  const store = new TransformPreviewStore();
  const session = store.begin(state.sceneSessionId, state.scene, 'child', transform());
  assert.equal(isTransformPreviewSessionValid(session, { ...state, sceneSessionId: 'session-b' }), false);
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, id: 'scene-b' } }), false);
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, selectedEntityId: 'parent' } }), false);
  assert.equal(isTransformPreviewSessionValid(session, { ...state, runtimeMode: 'play' }), false);
  const { child: _removed, ...entities } = state.scene.entities;
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, entities } }), false);
});

test('外部 Inspector 编辑及 Undo 输入以当前持久 Transform 失效，预览后回到相同持久输入仍有效', () => {
  const state = fixture();
  const store = new TransformPreviewStore();
  const session = store.begin(state.sceneSessionId, state.scene, 'child', transform());
  store.publish(session, transform(10));
  assert.equal(isTransformPreviewSessionValid(session, state), true, '轻预览没有改写持久 before');
  const child = state.scene.entities.child;
  const changed = (value: TransformComponent) => ({ ...state, scene: { ...state.scene, entities: {
    ...state.scene.entities, child: { ...child, components: { ...child.components, transform: value } },
  } } });
  assert.equal(isTransformPreviewSessionValid(session, changed(transform(5))), false, '外部 Inspector 编辑');
  assert.equal(isTransformPreviewSessionValid(session, changed(transform(-5))), false, 'Undo 恢复的旧命令输入');
  assert.equal(isTransformPreviewSessionValid(session, changed(transform())), true, '等值不可变副本属于同一持久输入');
});

test('自身和祖先锁定、父级或祖先变换变化使会话失效，普通改名保持有效', () => {
  const state = fixture();
  const store = new TransformPreviewStore();
  const session = store.begin(state.sceneSessionId, state.scene, 'child', transform());
  for (const id of ['child', 'parent', 'root']) {
    const entity = state.scene.entities[id];
    const changed = { ...state, scene: { ...state.scene, entities: { ...state.scene.entities, [id]: { ...entity, locked: true } } } };
    assert.equal(isTransformPreviewSessionValid(session, changed), false, `${id} 锁定`);
  }
  const parent = state.scene.entities.parent;
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, entities: {
    ...state.scene.entities, parent: { ...parent, components: { ...parent.components, transform: transform(2) } },
  } } }), false);
  const child = state.scene.entities.child;
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, entities: {
    ...state.scene.entities, child: { ...child, parentId: 'root' },
  } } }), false);
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, entities: {
    ...state.scene.entities, parent: { ...parent, name: 'renamed parent' },
  } } }), true);
});

test('参数或资产副本替换使会话失效，等值 Transform 副本不受影响', () => {
  const state = fixture();
  const store = new TransformPreviewStore();
  const session = store.begin(state.sceneSessionId, state.scene, 'child', transform());
  const child = state.scene.entities.child;
  const modelAsset = child.components.modelAsset!;
  const entities = { ...state.scene.entities, child: { ...child, components: {
    ...child.components, modelAsset: { ...modelAsset, parameterValues: { count: 1, enabled: false } },
  } } };
  assert.equal(isTransformPreviewSessionValid(session, { ...state, scene: { ...state.scene, entities } }), false);
  assert.equal(equalPreviewTransform(transform(), structuredClone(transform())), true);
  assert.equal(equalPreviewTransform(transform(), transform(1)), false);
});

for (const kind of ['locked', 'missing', 'cycle']) {
  test(`初始祖先 ${kind} 时不能成为有效拖拽`, () => {
    const state = fixture();
    if (kind === 'locked') state.scene.entities.parent.locked = true;
    if (kind === 'missing') state.scene.entities.child.parentId = 'missing';
    if (kind === 'cycle') state.scene.entities.parent.parentId = 'child';
    const store = new TransformPreviewStore();
    const session = store.begin(state.sceneSessionId, state.scene, 'child', transform());
    assert.equal(isTransformPreviewSessionValid(session, state), false, kind);
    store.clear(session);
    assert.equal(store.getSnapshot(), null);
  });
}
