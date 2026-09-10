import assert from 'node:assert/strict';
import test from 'node:test';
import { repairPublishSceneSkyboxes } from '../../src/editor/deployment/repairPublishSceneSkyboxes.ts';

function fixture() {
  const skybox = { packagePath: 'D:/old', sourcePath: 'D:/old/sky.exr', sourceUrl: 'editor-asset://old',
    format: 'exr', intensity: 0.75, rotationY: 2.3, custom: { preserved: true } };
  const scene: any = { id: 'scene', entityIds: ['sky', 'other'], entities: {
    sky: { id: 'sky', name: '天空', components: { skybox: { ...skybox }, transform: { x: 3 } } },
    other: { id: 'other', components: { skybox: { ...skybox } } },
  }, sceneSettings: { skybox: { ...skybox } } };
  const recovery: any = { replacements: [], skyboxReplacements: [
    { entityId: null, sourceUrl: skybox.sourceUrl, skybox: { ...skybox, sourcePath: 'C:/new/sky.exr', sourceUrl: 'editor-asset://new', packagePath: 'C:/new' } },
    { entityId: 'sky', sourceUrl: skybox.sourceUrl, skybox: { ...skybox, sourcePath: 'C:/new/sky.exr', sourceUrl: 'editor-asset://new', packagePath: 'C:/new' } },
  ] };
  return { scene, recovery };
}

test('准确恢复场景和指定实体天空盒，保留参数和其他实体且原文档不变', () => {
  const { scene, recovery } = fixture();
  const before = structuredClone(scene);
  const result = repairPublishSceneSkyboxes(scene, recovery);
  assert.equal(result.restoredCount, 2);
  assert.equal(result.scene.sceneSettings.skybox.sourceUrl, 'editor-asset://new');
  assert.equal(result.scene.entities.sky.components.skybox.intensity, 0.75);
  assert.equal(result.scene.entities.sky.components.skybox.rotationY, 2.3);
  assert.deepEqual(result.scene.entities.sky.components.transform, { x: 3 });
  assert.deepEqual(result.scene.entities.other, scene.entities.other);
  assert.deepEqual(scene, before);
});

test('无替换时保留文档引用', () => {
  const { scene } = fixture();
  assert.equal(repairPublishSceneSkyboxes(scene, { replacements: [] } as any).scene, scene);
});

test('实体或源URL已变化时拒绝迟到恢复结果', () => {
  for (const change of ['entity', 'source']) {
    const { scene, recovery } = fixture();
    if (change === 'entity') delete scene.entities.sky;
    else scene.entities.sky.components.skybox.sourceUrl = 'newer-source';
    assert.throws(() => repairPublishSceneSkyboxes(scene, recovery), /天空盒.*变化/);
    assert.equal(scene.sceneSettings.skybox.sourceUrl, 'editor-asset://old');
  }
});

test('恢复数据不覆盖原渲染参数，也不与结果共享可变对象', () => {
  const { scene, recovery } = fixture();
  recovery.skyboxReplacements[0].skybox.intensity = 99;
  const result = repairPublishSceneSkyboxes(scene, recovery);
  assert.equal(result.scene.sceneSettings.skybox.intensity, 0.75);
  recovery.skyboxReplacements[0].skybox.custom.preserved = false;
  assert.equal(result.scene.sceneSettings.skybox.custom.preserved, true);
});

test('兼容仅有sourcePath的天空盒，缺省sourceUrl按主进程空字符串匹配', () => {
  for (const value of [undefined, null, '']) {
    const { scene, recovery } = fixture();
    scene.sceneSettings.skybox.sourceUrl = value;
    recovery.skyboxReplacements = [{ ...recovery.skyboxReplacements[0], sourceUrl: '' }];
    const result = repairPublishSceneSkyboxes(scene, recovery);
    assert.equal(result.restoredCount, 1);
    assert.equal(result.scene.sceneSettings.skybox.sourceUrl, 'editor-asset://new');
    assert.equal(result.scene.sceneSettings.skybox.rotationY, 2.3);
  }
});
