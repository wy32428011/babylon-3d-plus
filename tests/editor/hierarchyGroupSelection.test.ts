import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHierarchyGroupTransformSelection,
  resolveHierarchyGroupTransformSelection,
  toggleHierarchyEntitySelection,
} from '../../src/editor/model/entityHierarchy.ts';
import type { TransformComponent } from '../../src/editor/model/components.ts';
import type { Entity } from '../../src/editor/model/Entity.ts';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';

function transform(x: number, y = 0, z = 0): TransformComponent {
  return {
    position: { x, y, z },
    rotation: { x: 0.1, y: 0.2, z: 0.3 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function entity(
  id: string,
  parentId: string | null,
  overrides: Partial<Entity> = {},
): Entity {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    parentId,
    childrenIds: [],
    components: { transform: transform(id.length) },
    ...overrides,
  } as Entity;
}

function folder(
  id: string,
  parentId: string | null,
  childrenIds: string[],
  overrides: Partial<Entity> = {},
): Entity {
  return entity(id, parentId, {
    isFolder: true,
    childrenIds,
    ...overrides,
  });
}

function sceneOf(entities: Entity[], selectedEntityId: string | null): SceneDocument {
  return {
    version: 1,
    name: 'Hierarchy group selection test',
    entityIds: entities.map(({ id }) => id),
    entities: Object.fromEntries(entities.map((item) => [item.id, item])),
    selectedEntityId,
    mqttConfig: {},
    sceneSettings: {},
    fetchConfig: {},
  } as SceneDocument;
}

test('Ctrl/Cmd 追加选中，并在移除主选后回退到最近加入的剩余实体', () => {
  const first = entity('first', null);
  const second = entity('second', null);
  const third = entity('third', null);
  const scene = sceneOf([first, second, third], first.id);

  const withSecond = toggleHierarchyEntitySelection(scene, [first.id], first.id, second.id);
  assert.deepEqual(withSecond.entityIds, [first.id, second.id]);
  assert.equal(withSecond.primaryEntityId, second.id);

  const withThird = toggleHierarchyEntitySelection(
    scene,
    withSecond.entityIds,
    withSecond.primaryEntityId,
    third.id,
  );
  assert.deepEqual(withThird.entityIds, [first.id, second.id, third.id]);
  assert.equal(withThird.primaryEntityId, third.id);

  const withoutThird = toggleHierarchyEntitySelection(
    scene,
    withThird.entityIds,
    withThird.primaryEntityId,
    third.id,
  );
  assert.deepEqual(withoutThird.entityIds, [first.id, second.id]);
  assert.equal(withoutThird.primaryEntityId, second.id);

  const withoutFirst = toggleHierarchyEntitySelection(
    scene,
    withoutThird.entityIds,
    withoutThird.primaryEntityId,
    first.id,
  );
  assert.deepEqual(withoutFirst.entityIds, [second.id]);
  assert.equal(withoutFirst.primaryEntityId, second.id);
});

test('普通实体多选解析为可原子移动和旋转的群组', () => {
  const first = entity('first', null, { components: { transform: transform(1) } } as Partial<Entity>);
  const second = entity('second', null, { components: { transform: transform(2) } } as Partial<Entity>);
  const scene = sceneOf([first, second], second.id);

  assert.equal(isHierarchyGroupTransformSelection(scene, [first.id, second.id]), true);
  assert.equal(isHierarchyGroupTransformSelection(scene, [first.id]), false);

  const resolution = resolveHierarchyGroupTransformSelection(scene, [first.id, second.id]);
  assert.equal(resolution.status, 'ready');
  assert.deepEqual(resolution.entityIds, [first.id, second.id]);
  assert.equal(resolution.primaryEntityId, second.id);
  assert.deepEqual(resolution.beforePositions, {
    [first.id]: { x: 1, y: 0, z: 0 },
    [second.id]: { x: 2, y: 0, z: 0 },
  });
});

test('文件夹与其后代混合多选会递归展开并去重', () => {
  const root = folder('root', null, ['first', 'nested']);
  const first = entity('first', root.id, { components: { transform: transform(1) } } as Partial<Entity>);
  const nested = folder('nested', root.id, ['second']);
  const second = entity('second', nested.id, { components: { transform: transform(2) } } as Partial<Entity>);
  const outside = entity('outside', null, { components: { transform: transform(3) } } as Partial<Entity>);
  const scene = sceneOf([root, first, nested, second, outside], outside.id);

  const resolution = resolveHierarchyGroupTransformSelection(scene, [root.id, second.id, outside.id]);
  assert.equal(resolution.status, 'ready');
  assert.deepEqual(
    resolution.entityIds,
    [first.id, second.id, outside.id],
    '文件夹后代和显式选中的同一实体只能变换一次',
  );
});

test('任一选中成员或祖先锁定时原子阻止整个群组', () => {
  const lockedFolder = folder('locked-folder', null, ['locked-child'], { locked: true });
  const lockedChild = entity('locked-child', lockedFolder.id);
  const free = entity('free', null);
  const scene = sceneOf([lockedFolder, lockedChild, free], free.id);

  const resolution = resolveHierarchyGroupTransformSelection(scene, [lockedChild.id, free.id]);
  assert.equal(resolution.status, 'blocked');
  assert.deepEqual(resolution.lockedEntityIds, [lockedChild.id]);
});

test('单个普通实体不创建群组，单个空文件夹返回空群组', () => {
  const emptyFolder = folder('empty', null, []);
  const single = entity('single', null);
  const scene = sceneOf([emptyFolder, single], emptyFolder.id);

  assert.equal(resolveHierarchyGroupTransformSelection(scene, [single.id]).status, 'unavailable');
  assert.equal(resolveHierarchyGroupTransformSelection(scene, [emptyFolder.id]).status, 'empty');
});
