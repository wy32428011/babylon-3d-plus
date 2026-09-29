import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpeningPublishPlan } from '../../electron/shared/openingPublishPlan.ts';
const signal = () => new AbortController().signal;
const input = (enabled = true) => ({ scene: { entities: { device: { position: 42 } }, sceneSettings: {
  openingAnimation: { enabled, template: 'package', package: { id: 'missing', manifestUrl: 'C:\\project\\Assets\\OpeningPackages\\missing\\manifest.json', config: { values: { count: 0, title: '' } } } },
} } });
test('无包和停用包的DIST不解析开场，不改变三维数据或输入', async () => {
  const original = input(false), before = structuredClone(original);
  const result = await createOpeningPublishPlan(original, { mode: 'dist', signal: signal(), resolve: async () => { throw Error('不应解析'); } });
  assert.equal('openingAnimation' in result.scene.scene.sceneSettings, false);
  assert.deepEqual(result.scene.scene.entities, original.scene.entities);
  assert.equal(result.scene.scene.entities, original.scene.entities, '开场计划不能破坏三维资源预检的对象身份');
  assert.deepEqual(original, before); assert.deepEqual(result.warnings, []);
});
test('缺包只降级开场，SOURCE保留零值和空文案且转换本机路径', async () => {
  const original = input(), before = structuredClone(original);
  for (const mode of ['source','dist'] as const) {
    const result = await createOpeningPublishPlan(original, { mode, signal: signal(), resolve: async () => { throw Error('素材缺失'); } });
    assert.equal(result.opening, null); assert.match(result.warnings[0], /三维场景继续发布.*素材缺失/);
    if (mode === 'source') {
      assert.equal(result.scene.scene.sceneSettings.openingAnimation.enabled, false);
      assert.deepEqual(result.scene.scene.sceneSettings.openingAnimation.package.config.values, { count: 0, title: '' });
      assert.equal(result.scene.scene.sceneSettings.openingAnimation.package.manifestUrl, 'Assets/OpeningPackages/missing/manifest.json');
    } else assert.equal('openingAnimation' in result.scene.scene.sceneSettings, false);
    assert.deepEqual(original, before);
  }
});
test('不支持的可选渲染器可降级，但取消必须立即传播', async () => {
  const result = await createOpeningPublishPlan(input(), { mode: 'dist', signal: signal(), validateViewer: async () => { throw Error('协议不支持'); }, resolve: async () => { throw Error('不能继续读取'); } });
  assert.match(result.warnings[0], /协议不支持/);
  const controller = new AbortController();
  await assert.rejects(createOpeningPublishPlan(input(), { mode: 'dist', signal: controller.signal,
    resolve: async () => { controller.abort(); throw Error('中断'); } }), { name: 'AbortError' });
});
test('有效关闭包可在SOURCE备份，旧内置配置只保留档案而不作为DIST运行内容', async () => {
  const resolved = { files: ['image.webp'] };
  const result = await createOpeningPublishPlan(input(false), { mode: 'source', signal: signal(), resolve: async () => resolved });
  assert.deepEqual(result.opening, resolved);
  const legacy = input(); legacy.scene.sceneSettings.openingAnimation.template = 'reference-huishan';
  const plain = await createOpeningPublishPlan(legacy, { mode: 'dist', signal: signal(), resolve: async () => { throw Error('不能解析旧模板'); } });
  assert.equal('openingAnimation' in plain.scene.scene.sceneSettings, false); assert.match(plain.warnings[0], /尚未迁移/);
});
