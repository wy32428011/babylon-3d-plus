import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSceneRegionViews, updateRegionView, validateRegionViewName } from '../../src/editor/model/sceneRegionViews.ts';
import { updateSceneRegionViewsCommand } from '../../src/editor/commands/sceneRegionViewCommands.ts';

const camera = { savedPose: { alpha: 1, beta: 1.2, radius: 30, target: { x: 4, y: 2, z: -8 } }, savedOrientation: 'orbit', savedProjection: 'perspective' } as const;
const view = { id: 'region-1', name: '入库区', camera };

test('旧场景为空列表；有效视角独立复制并保持 ID、顺序和投影', () => {
  assert.deepEqual(normalizeSceneRegionViews(undefined), { views: [], issues: [] });
  const input = [view, { ...view, id: 'region-2', name: '出库区', camera: { ...camera, savedProjection: 'orthographic' } }];
  const result = normalizeSceneRegionViews(input);
  assert.deepEqual(result.views, input);
  assert.notEqual(result.views[0].camera.savedPose.target, camera.savedPose.target);
  assert.equal(result.issues.length, 0);
});

test('非法位姿及重复 ID 隔离并报告，不生成默认原点视角', () => {
  const result = normalizeSceneRegionViews([view, view, { ...view, id: 'bad', camera: { ...camera, savedPose: null } }, { ...view, id: 'nan', camera: { ...camera, savedPose: { ...camera.savedPose, radius: NaN } } }]);
  assert.deepEqual(result.views, [view]);
  assert.equal(result.issues.length, 3);
});

test('有界列表与名称校验覆盖损坏输入及上限', () => {
  assert.equal(normalizeSceneRegionViews({}).issues.length, 1);
  const many = Array.from({ length: 257 }, (_, index) => ({ ...view, id: `v${index}`, name: `区域${index}` }));
  const limited = normalizeSceneRegionViews(many);
  assert.equal(limited.views.length, 256);
  assert.equal(limited.issues.length, 1);
  assert.match(validateRegionViewName('长'.repeat(81), [])!, /80/);
  assert.throws(() => updateRegionView([view], view.id, { camera: { ...camera, savedPose: { ...camera.savedPose, radius: -1 } } }), /无效/);
  assert.equal(normalizeSceneRegionViews([null, { ...view, name: '' }, { ...view, id: 'x'.repeat(257) }]).views.length, 0);
});

test('覆盖更新只更新相机；删除后的 ID 不重新创建；名称校验排除自己', () => {
  const nextCamera = { ...camera, savedPose: { ...camera.savedPose, radius: 60 } };
  assert.deepEqual(updateRegionView([view], view.id, { camera: nextCamera }), [{ ...view, camera: nextCamera }]);
  assert.throws(() => updateRegionView([], view.id, { camera: nextCamera }), /不存在/);
  assert.equal(validateRegionViewName(' 入库区 ', [view], view.id), null);
  assert.match(validateRegionViewName('入库区', [view])!, /已存在/);
  assert.match(validateRegionViewName(' ', [])!, /不能为空/);
});

test('撤销区域视角只恢复列表，保留期间的相机和其它场景设置', () => {
  const scene = { name: '工厂', sceneSettings: { camera: { viewDistance: 12000 }, regionViews: [view] } } as any;
  const command = updateSceneRegionViewsCommand([view], [], '删除区域视角');
  const deleted = command.execute(scene);
  const updated = { ...deleted, name: '新工厂', sceneSettings: { ...deleted.sceneSettings, camera: { viewDistance: 15000 } } };
  const restored = command.undo(updated as any);
  assert.deepEqual(restored.sceneSettings.regionViews, [view]);
  assert.equal(restored.name, '新工厂');
  assert.equal(restored.sceneSettings.camera.viewDistance, 15000);
});
