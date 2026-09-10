import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ appType: 'custom', configFile: false, root: process.cwd(),
  server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
after(() => vite.close());
const { restoreFailedSceneResources } = await vite.ssrLoadModule('/src/editor/assets/restoreFailedSceneResources.ts');
const url = (revision: string, id = '123') => `editor-asset://local/${encodeURIComponent(`C:/${revision}/Model-${id}-rack/model.glb`)}`;

test('新版脚本失败只恢复失败资源组的所有实例及间接引用，保留成功组与参数', () => {
  const asset = (id = '123', width = 0) => ({ sourceUrl: url('old', id), parameterValues: { width }, scriptAssets: ['old-script'] });
  const before = { entities: {
    first: { components: { modelAsset: asset(), transform: { x: 10 } } },
    second: { components: { modelAsset: asset('123', 8) } },
    success: { components: { modelAsset: asset('456', 4) } },
    indirect: { components: { modelGenerator: { defaultTarget: { kind: 'model', assetId: 'old-id', modelAsset: asset('123', 3) } },
      clickEventBinding: { deviceSlots: [{ deviceType: { sourceUrl: url('old'), assetId: 'old-id' } }] } } },
  }, sceneSettings: { environment: { sourceUrl: 'old-env' } } };
  const current = structuredClone(before);
  for (const [id, entity] of Object.entries(current.entities)) {
    if ('modelAsset' in entity.components) Object.assign(entity.components.modelAsset, { sourceUrl: url('new', id === 'success' ? '456' : '123'), scriptAssets: ['new-script'] });
  }
  current.entities.indirect.components.modelGenerator.defaultTarget.assetId = 'new-id';
  current.entities.indirect.components.modelGenerator.defaultTarget.modelAsset.sourceUrl = url('new');
  current.entities.indirect.components.clickEventBinding.deviceSlots[0].deviceType = { sourceUrl: url('new'), assetId: 'new-id' };
  current.entities.first.components.transform.x = 20;
  const snapshot = structuredClone(current);
  const restored = restoreFailedSceneResources(before, current, { entityIds: ['first'] });
  assert.deepEqual(restored.entities.first.components.modelAsset, before.entities.first.components.modelAsset);
  assert.equal(restored.entities.first.components.transform.x, 20);
  assert.deepEqual(restored.entities.second, before.entities.second);
  assert.deepEqual(restored.entities.indirect, before.entities.indirect);
  assert.deepEqual(restored.entities.success, current.entities.success);
  assert.deepEqual(current, snapshot);
  assert.equal(restoreFailedSceneResources(before, restored, { entityIds: ['first'] }), restored, '重复错误不反复重建已恢复的场景');
});

test('环境失败仅恢复原环境，超时未知失败资源不猜测或清空场景', () => {
  const before = { entities: {}, sceneSettings: { environment: { sourceUrl: 'snapshot', opacity: .4 } } };
  const current = { entities: {}, sceneSettings: { environment: { sourceUrl: 'latest', opacity: .4 } } };
  assert.deepEqual(restoreFailedSceneResources(before, current, { environment: true }), before);
  assert.equal(restoreFailedSceneResources(before, before, { environment: true }), before);
  assert.equal(restoreFailedSceneResources(before, current, {}), current);
  assert.equal(restoreFailedSceneResources(before, current, { entityIds: ['missing'] }), current);
});
