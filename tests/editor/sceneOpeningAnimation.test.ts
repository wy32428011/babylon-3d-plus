import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultSceneOpeningAnimation,
  normalizeSceneOpeningAnimation,
} from '../../src/editor/model/sceneOpeningAnimation.ts';

test('旧场景默认关闭开场，并且默认坐标与数组互相独立', () => {
  const first = normalizeSceneOpeningAnimation(undefined);
  const second = createDefaultSceneOpeningAnimation();
  assert.equal(first.enabled, false);
  assert.equal(first.durationSeconds, 18);
  assert.equal(first.motionPreference, 'normal');
  assert.equal(first.afterOpening, 'stay');
  assert.deepEqual(first.destination, { name: '惠山区', longitude: 120.3, latitude: 31.68 });
  first.destination.name = '改名';
  first.destinations[0].name = '改城市';
  assert.equal(second.destination.name, '惠山区');
  assert.notEqual(first.destinations[0].name, second.destinations[0].name);
});

test('显式配置保留关闭项、零经纬度、空标题和空飞线列表', () => {
  const value = {
    ...createDefaultSceneOpeningAnimation(), enabled: true, allowSkip: false,
    title: '', subtitle: '', durationSeconds: 23.5, motionPreference: 'reduced',
    destination: { name: '赤道参考点', longitude: 0, latitude: 0 }, destinations: [],
  };
  assert.deepEqual(normalizeSceneOpeningAnimation(value), value);
});

test('坏坐标隔离、未知模板停用、异常时长回退，不污染原始对象', () => {
  const input = {
    enabled: true, template: 'external-url', durationSeconds: NaN,
    destination: { name: '坏坐标', longitude: 999, latitude: 10 },
    destinations: [null, { name: '坏', longitude: 120, latitude: 100 },
      { name: '伦敦', longitude: -0.1276, latitude: 51.5072 }],
  };
  const value = normalizeSceneOpeningAnimation(input);
  assert.equal(value.enabled, false);
  assert.equal(value.durationSeconds, 18);
  assert.equal(value.destination.name, '惠山区');
  assert.deepEqual(value.destinations, [{ name: '伦敦', longitude: -0.1276, latitude: 51.5072 }]);
  assert.equal(input.destinations.length, 3);
  assert.deepEqual(normalizeSceneOpeningAnimation(null), createDefaultSceneOpeningAnimation());
  assert.equal(normalizeSceneOpeningAnimation({ durationSeconds: -1 }).durationSeconds, 6);
  assert.equal(normalizeSceneOpeningAnimation({ durationSeconds: 9999 }).durationSeconds, 90);
});

test('中国停留和五个默认地区兼容旧配置，列表不与其它场景或全球飞线共享', () => {
  const expected = [
    { name: '四川', longitude: 104.0665, latitude: 30.5723 },
    { name: '上海', longitude: 121.4737, latitude: 31.2304 },
    { name: '杭州', longitude: 120.1551, latitude: 30.2741 },
    { name: '深圳', longitude: 114.0579, latitude: 22.5431 },
    { name: '安徽', longitude: 117.2272, latitude: 31.8206 },
  ];
  const oldSettings = { enabled: true, durationSeconds: 23.5, destinations: [] };
  const normalized = normalizeSceneOpeningAnimation(oldSettings);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.durationSeconds, 23.5);
  assert.equal(normalized.chinaHoldSeconds, 6);
  assert.deepEqual(normalized.chinaDestinations, expected);
  assert.deepEqual(normalized.destinations, []);
  normalized.chinaDestinations[0].name = '已编辑';
  assert.deepEqual(createDefaultSceneOpeningAnimation().chinaDestinations, expected);
  assert.deepEqual(oldSettings, { enabled: true, durationSeconds: 23.5, destinations: [] });
});

test('中国停留零秒、空地区列表及自定义坐标保留，关闭不会清除配置', () => {
  const settings = createDefaultSceneOpeningAnimation();
  const empty = normalizeSceneOpeningAnimation({ ...settings, enabled: false, chinaHoldSeconds: 0, chinaDestinations: [] });
  assert.equal(empty.chinaHoldSeconds, 0);
  assert.deepEqual(empty.chinaDestinations, []);
  assert.deepEqual(empty.destinations, settings.destinations);
  assert.equal(empty.durationSeconds, 18);
  const custom = [{ name: '自定义区域', longitude: 0, latitude: 0 }];
  const disabled = normalizeSceneOpeningAnimation({ ...settings, enabled: false, chinaHoldSeconds: 9.5, chinaDestinations: custom });
  assert.equal(disabled.chinaHoldSeconds, 9.5);
  assert.deepEqual(disabled.chinaDestinations, custom);
  assert.notEqual(disabled.chinaDestinations, custom);
});

test('中国停留异常值回退或钳制，坏地区隔离且不影响全球列表', () => {
  assert.equal(normalizeSceneOpeningAnimation({ chinaHoldSeconds: NaN }).chinaHoldSeconds, 6);
  assert.equal(normalizeSceneOpeningAnimation({ chinaHoldSeconds: Infinity }).chinaHoldSeconds, 6);
  assert.equal(normalizeSceneOpeningAnimation({ chinaHoldSeconds: -1 }).chinaHoldSeconds, 0);
  assert.equal(normalizeSceneOpeningAnimation({ chinaHoldSeconds: 301 }).chinaHoldSeconds, 300);
  assert.equal(normalizeSceneOpeningAnimation({ chinaHoldSeconds: '3' }).chinaHoldSeconds, 6);
  const value = normalizeSceneOpeningAnimation({ destinations: [], chinaDestinations: [null,
    { name: '坏坐标', longitude: 190, latitude: 30 },
    { name: ' 上海 ', longitude: 121.4737, latitude: 31.2304 }] });
  assert.deepEqual(value.destinations, []);
  assert.deepEqual(value.chinaDestinations, [{ name: '上海', longitude: 121.4737, latitude: 31.2304 }]);
});

test('旧场景仍关闭开场，旧开场缺呼吸字段时补入默认强度和周期', () => {
  const empty = normalizeSceneOpeningAnimation(undefined);
  assert.equal(empty.enabled, false);
  assert.equal(empty.breathingEnabled, true);
  assert.equal(empty.breathingIntensity, 0.65);
  assert.equal(empty.breathingPeriodSeconds, 4);
  const existing = normalizeSceneOpeningAnimation({ enabled: true, chinaHoldSeconds: 0, chinaDestinations: [] });
  assert.equal(existing.enabled, true);
  assert.equal(existing.breathingEnabled, true);
  assert.equal(existing.breathingIntensity, 0.65);
  assert.equal(existing.breathingPeriodSeconds, 4);
  assert.equal(existing.chinaHoldSeconds, 0);
  assert.deepEqual(existing.chinaDestinations, []);
});

test('显式关闭呼吸及零强度保留，不改变中国停留和全球地区数据', () => {
  const defaults = createDefaultSceneOpeningAnimation();
  const saved = { ...defaults, breathingEnabled: false, breathingIntensity: 0, breathingPeriodSeconds: 8.5 };
  assert.deepEqual(normalizeSceneOpeningAnimation(saved), saved);
  assert.deepEqual(saved.chinaDestinations, defaults.chinaDestinations);
  assert.deepEqual(saved.destinations, defaults.destinations);
  assert.equal(saved.chinaHoldSeconds, 6);
  assert.equal(normalizeSceneOpeningAnimation({ ...saved, breathingEnabled: true }).breathingIntensity, 0);
});

test('呼吸强度和周期拒绝非数字并限制范围，保留合法小数', () => {
  const invalid = normalizeSceneOpeningAnimation({ breathingEnabled: 'false', breathingIntensity: NaN, breathingPeriodSeconds: Infinity });
  assert.equal(invalid.breathingEnabled, true);
  assert.equal(invalid.breathingIntensity, 0.65);
  assert.equal(invalid.breathingPeriodSeconds, 4);
  assert.equal(normalizeSceneOpeningAnimation({ breathingIntensity: -1 }).breathingIntensity, 0);
  assert.equal(normalizeSceneOpeningAnimation({ breathingIntensity: 2 }).breathingIntensity, 1);
  assert.equal(normalizeSceneOpeningAnimation({ breathingIntensity: '0' }).breathingIntensity, 0.65);
  assert.equal(normalizeSceneOpeningAnimation({ breathingPeriodSeconds: 0 }).breathingPeriodSeconds, 2);
  assert.equal(normalizeSceneOpeningAnimation({ breathingPeriodSeconds: 99 }).breathingPeriodSeconds, 10);
  const decimals = normalizeSceneOpeningAnimation({ breathingIntensity: 0.375, breathingPeriodSeconds: 3.25 });
  assert.equal(decimals.breathingIntensity, 0.375);
  assert.equal(decimals.breathingPeriodSeconds, 3.25);
});
