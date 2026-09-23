import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{ captureComposition, instantiateComposition, validateComposition, transformComposition, groupComposition, planCompositionUpgrade }] = await importIsolatedTypeScriptModules<[typeof import('../../src/editor/composition/composition')]>(['src/editor/composition/composition.ts']);
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { Entity } from '../../src/editor/model/Entity.ts';

const transform = (x = 0) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const model = (id: string, x: number): Entity => ({ id, name: id, parentId: null, childrenIds: [], components: { transform: transform(x), meshRenderer: { meshKind: 'cube', materialColor: '#ffffff' } } });
const scene = (): SceneDocument => ({ version: 1, name: '组合测试', entities: { a: model('a', 10), b: model('b', 13) }, entityIds: ['a', 'b'], selectedEntityId: 'a', sceneSettings: {}, mqttConfig: {}, fetchConfig: {} } as SceneDocument);

test('组合往返保留相对关系，重复实例化产生独立 ID', () => {
  const captured = captureComposition(scene(), ['a', 'b'], '组合');
  const first = instantiateComposition(captured.definition, { x: 100, y: 2, z: 3 });
  const second = instantiateComposition(captured.definition, { x: 200, y: 0, z: 0 });
  assert.equal(first.entities[1].components.transform.position.x - first.entities[0].components.transform.position.x, 3);
  assert.equal(new Set([...first.entities, ...second.entities].map(e => e.id)).size, 4);
  assert.equal(first.root.composition?.schemaVersion, 1);
  assert.equal(scene().entities.a.components.transform.position.x, 10);
});

test('拖回卡片保存成员变化，不记录组合整体摆放位置', () => {
  const original = scene();
  const captured = captureComposition(original, ['a', 'b'], '组合');
  const grouped = groupComposition(original, captured, { libraryId: 'local-1', revision: '1' });
  const root = grouped.entities[grouped.selectedEntityId!];
  const moved = transformComposition(grouped, root.id, { ...root.components.transform, position: { x: 999, y: 5, z: 8 } });
  assert.deepEqual(captureComposition(moved, [root.id], '组合').definition, captured.definition);
  const changed = structuredClone(moved);
  changed.entities.b.components.transform.position.x += 2;
  assert.notDeepEqual(captureComposition(changed, [root.id], '组合').definition, captured.definition);
});

test('成员自身非等比缩放经过组合旋转和等比缩放仍保持尺寸比例', () => {
  const s = scene(); s.entities.a.components.transform.scale = { x: 2, y: 3, z: 4 };
  const c = captureComposition(s, ['a', 'b'], '组合');
  const grouped = groupComposition(s, c, { libraryId: 'local-1', revision: '1' });
  const id = grouped.selectedEntityId!;
  const moved = transformComposition(grouped, id, { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0.2, y: 1, z: 0.1 }, scale: { x: 2, y: 2, z: 2 } });
  assert.ok(Math.abs(moved.entities.a.components.transform.scale.y / moved.entities.a.components.transform.scale.x - 1.5) < 1e-5);
  assert.throws(() => transformComposition(grouped, id, { ...transform(), scale: { x: 1, y: 2, z: 1 } }), /等比/);
});

test('拒绝单模型、非法层级和非有限变换', () => {
  assert.throws(() => captureComposition(scene(), ['a'], '组合'), /两个/);
  const c = captureComposition(scene(), ['a', 'b'], '组合').definition;
  const bad = structuredClone(c); bad.nodes[0].parentId = bad.nodes[0].id;
  assert.throws(() => validateComposition(bad), /层级/);
  const badTransform = structuredClone(c); badTransform.nodes[0].components.transform.position.x = NaN;
  assert.throws(() => validateComposition(badTransform), /变换/);
});

test('大世界坐标组合保持成员间厘米级距离', () => {
  const s = scene(); s.entities.a.components.transform.position.x = 100000000.1; s.entities.b.components.transform.position.x = 100000000.3;
  const c = captureComposition(s, ['a', 'b'], '精密组合');
  const placed = instantiateComposition(c.definition, {x:0,y:0,z:0});
  assert.ok(Math.abs(placed.entities[1].components.transform.position.x - placed.entities[0].components.transform.position.x - 0.2) < 1e-6);
});

test('显式采用库版本保留整体位姿、成员身份及其他实例', () => {
  const base=scene(),capture=captureComposition(base,['a','b'],'组合');
  let grouped=groupComposition(base,capture,{libraryId:'library',revision:'v1'});
  const rootId=grouped.selectedEntityId!;
  grouped=transformComposition(grouped,rootId,{position:{x:100,y:2,z:3},rotation:{x:0,y:0,z:0},scale:{x:2,y:2,z:2}});
  const other=instantiateComposition(capture.definition,{x:300,y:0,z:0});
  grouped={...grouped,entityIds:[...grouped.entityIds,other.root.id,...other.entities.map(e=>e.id)],entities:{...grouped.entities,[other.root.id]:other.root,...Object.fromEntries(other.entities.map(e=>[e.id,e]))}};
  const next=structuredClone(capture.definition);next.nodes[1].components.transform.position.x+=4;
  const plan=planCompositionUpgrade(grouped,rootId,next,{libraryId:'library',revision:'v2'});
  assert.deepEqual(plan.scene.entities[rootId].components.transform,grouped.entities[rootId].components.transform);
  assert.equal(plan.scene.entities.b.components.transform.position.x,111);
  assert.deepEqual(plan.scene.entities[other.root.id],grouped.entities[other.root.id]);
  assert.equal(plan.scene.entities[rootId].composition?.instanceId,grouped.entities[rootId].composition?.instanceId);
  assert.equal(plan.retained,2);
});
