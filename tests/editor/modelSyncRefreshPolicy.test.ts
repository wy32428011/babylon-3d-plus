import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterProjectModelsForSyncRefresh,
  shouldRefreshProjectModelsAfterSync,
} from '../../src/editor/assets/modelSyncRefreshPolicy.ts';

test('模型同步失败或仍在运行时不刷新场景模型', () => {
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'failed', libraryChanged: true }), false);
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'downloading', libraryChanged: true }), false);
});

test('增量同步只有实际修改模型库时才刷新场景模型', () => {
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'completed', libraryChanged: false }), false);
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'completed', libraryChanged: true }), true);
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'completed', runtimeChangedResourceKeys: [] }), false);
  assert.equal(shouldRefreshProjectModelsAfterSync({
    phase: 'completed',
    runtimeChangedResourceKeys: ['model:1'],
  }), true);
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'completed', changedCount: 0 }), false);
});

test('旧主进程未返回变更摘要时保守执行一次刷新', () => {
  assert.equal(shouldRefreshProjectModelsAfterSync({ phase: 'completed' }), true);
});

test('只把运行时 revision 变化的模型资产交给场景刷新', () => {
  const assets = [
    { path: 'D:\\Assets\\Models\\Model-1-水泵\\pump.glb', packagePath: 'D:\\Assets\\Models\\Model-1-水泵' },
    { path: 'D:\\Assets\\Models\\ComboModels\\Combo-2-泵组\\combo.glb', packagePath: 'D:\\Assets\\Models\\ComboModels\\Combo-2-泵组' },
    { path: 'D:\\Assets\\Models\\Local\\local.glb', packagePath: 'D:\\Assets\\Models\\Local' },
  ];
  assert.deepEqual(filterProjectModelsForSyncRefresh(assets, ['combo:2']), [assets[1]]);
  assert.deepEqual(filterProjectModelsForSyncRefresh(assets, []), []);
  assert.deepEqual(filterProjectModelsForSyncRefresh(assets, null), assets);
});
