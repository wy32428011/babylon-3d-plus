import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultReferenceOpening, getReferenceOpeningDuration } from '../../src/editor/model/sceneOpeningReference.ts';
import { createDefaultSceneOpeningAnimation, normalizeSceneOpeningAnimation } from '../../src/editor/model/sceneOpeningAnimation.ts';

test('参考模板默认62秒九阶段，UV数据完整保留40个全球与34个国内目的地', () => {
  const settings = createDefaultSceneOpeningAnimation();
  assert.equal(settings.enabled, false);
  assert.equal(settings.template, 'reference-huishan');
  assert.deepEqual(settings.reference.stageDurations, [9, 7, 8, 6, 4, 8, 6, 6, 8]);
  assert.equal(getReferenceOpeningDuration(settings), 62);
  assert.equal(getReferenceOpeningDuration(settings.reference), 62);
  assert.deepEqual(settings.reference.worldOrigin, { x: .709, y: .335 });
  assert.deepEqual(settings.reference.chinaOrigin, { x: .707, y: .520 });
  assert.equal(settings.reference.worldDestinations.length, 40);
  assert.equal(settings.reference.chinaDestinations.length, 34);
  assert.deepEqual(settings.reference.worldDestinations[0], { name: '美国西部', x: .14, y: .30 });
  assert.deepEqual(settings.reference.chinaDestinations.at(-1), { name: '澳门', x: .608, y: .786 });
  settings.reference.worldDestinations[0].name = '编辑过';
  assert.equal(createDefaultReferenceOpening().worldDestinations[0].name, '美国西部');
});

test('参考配置保留false、零停留、零UV和空列表，拒绝坏UV而不当经纬度', () => {
  const initial = createDefaultSceneOpeningAnimation();
  const saved = { ...initial, allowSkip: false, breathingEnabled: false, breathingIntensity: 0,
    reference: { ...initial.reference, showUI: false, quality: 'low', heroTitle: '',
      stageDurations: [9, 7, 0, 6, 4, 0, 6, 6, 8], worldOrigin: { x: 0, y: 0 },
      worldDestinations: [], chinaDestinations: [{ name: '边角', x: 0, y: 1 }] } };
  const restored = normalizeSceneOpeningAnimation(saved);
  assert.deepEqual(restored, saved);
  assert.equal(getReferenceOpeningDuration(restored), 46);
  const invalid = normalizeSceneOpeningAnimation({ ...saved, reference: { ...saved.reference,
    chinaDestinations: [{ name: '经纬度不能当UV', x: 120, y: 31 }, { name: '合法', x: .5, y: .5 }] } });
  assert.deepEqual(invalid.reference.chinaDestinations, [{ name: '合法', x: .5, y: .5 }]);
});

test('旧时长按54秒参考轴迁移，旧零停留和空列表尊重，旧档案不被派生回写', () => {
  const old = { enabled: true, template: 'globe-huishan', durationSeconds: 27, chinaHoldSeconds: 0,
    destinations: [], chinaDestinations: [], allowSkip: false, breathingEnabled: false, breathingIntensity: 0 };
  const migrated = normalizeSceneOpeningAnimation(old);
  assert.equal(migrated.template, 'reference-huishan');
  assert.deepEqual(migrated.reference.stageDurations, [4.5, 3.5, 4, 3, 2, 0, 3, 3, 4]);
  assert.equal(getReferenceOpeningDuration(migrated), 27);
  assert.equal(migrated.durationSeconds, 27);
  assert.equal(migrated.chinaHoldSeconds, 0);
  assert.deepEqual(migrated.reference.worldDestinations, []);
  assert.deepEqual(migrated.reference.chinaDestinations, []);
  assert.equal(migrated.allowSkip, false);
  assert.equal(migrated.breathingEnabled, false);
});

test('旧列表只按已知名字匹配参考UV，未知点保留档案并给出迁移提示', () => {
  const locations = [{ name: '四川', longitude: 104.0665, latitude: 30.5723 },
    { name: '自定义厂区', longitude: 119.6, latitude: 32.8 }];
  const migrated = normalizeSceneOpeningAnimation({ template: 'globe-huishan', chinaDestinations: locations });
  assert.deepEqual(migrated.chinaDestinations, locations);
  assert.deepEqual(migrated.reference.chinaDestinations, [{ name: '四川', x: .456, y: .56 }]);
  assert.ok(migrated.reference.legacyUnmappedNames?.some(name => name.includes('自定义厂区')));
  assert.deepEqual(normalizeSceneOpeningAnimation(migrated), migrated);
});
