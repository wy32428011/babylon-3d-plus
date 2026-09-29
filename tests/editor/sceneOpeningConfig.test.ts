import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSceneOpeningConfig, resolvePackageOpeningSettings } from '../../src/editor/model/sceneOpeningAnimation.ts';

test('无开场绑定不创建任何参考模板参数，解除绑定返回空状态', () => {
  assert.equal(normalizeSceneOpeningConfig(undefined), undefined);
  assert.equal(normalizeSceneOpeningConfig(null), undefined);
  assert.equal(normalizeSceneOpeningConfig({ template: 'none' }), undefined);
});
test('旧参考配置原样保留但不自动播放，异常包也不能启动', () => {
  const legacy = { enabled: true, template: 'reference-huishan', reference: { stageDurations: [9,7,0,6,4,0,6,6,8] } };
  assert.deepEqual(normalizeSceneOpeningConfig(legacy), legacy);
  assert.equal(resolvePackageOpeningSettings(legacy).enabled, false);
  assert.equal(resolvePackageOpeningSettings({ enabled: true, template: 'package', package: {} }).enabled, false);
});
test('包实例不保存内置模板默认参数，关闭和零值不会被开启或补全', () => {
  const config = normalizeSceneOpeningConfig({ template: 'package', enabled: false, allowSkip: false,
    package: { id: 'test' }, reference: { brandName: '不应串入' }, breathingIntensity: 0 });
  assert.equal(config?.enabled, false);
  assert.equal(config?.allowSkip, false);
  assert.equal(config?.breathingIntensity, 0);
  assert.equal('reference' in config!, false);
  assert.equal('destinations' in config!, false);
});
