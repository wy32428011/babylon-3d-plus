import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLightSettings, WARM_WORK_LIGHT_SETTINGS } from '../../src/editor/model/lightSettings.ts';

test('旧灯光保留强度且不注入扩展默认值', () => {
  for (const lightKind of ['hemispheric', 'directional', 'point']) {
    assert.deepEqual(normalizeLightSettings({ lightKind, intensity: 0.7 }), { lightKind, intensity: 0.7 });
  }
  assert.equal(normalizeLightSettings({ lightKind: 'point', intensity: 0 }).intensity, 0);
});

test('合法灯光颜色、照射范围和夜间行为可以完整保存', () => {
  assert.deepEqual(normalizeLightSettings({
    lightKind: 'hemispheric', intensity: 1.2, color: ' #A0B1C2 ', groundColor: '#203040', range: 30,
    nightBehavior: 'keep',
  }), {
    lightKind: 'hemispheric', intensity: 1.2, color: '#a0b1c2', groundColor: '#203040', range: 30,
    nightBehavior: 'keep',
  });
  assert.equal(normalizeLightSettings({ lightKind: 'directional', intensity: 1, nightBehavior: 'dim' }).nightBehavior, 'dim');
});

test('畸形和非有限输入不能进入灯光运行参数', () => {
  const expected = { lightKind: 'hemispheric', intensity: 1 };
  for (const input of [null, undefined, [], 42, 'point']) assert.deepEqual(normalizeLightSettings(input), expected);
  for (const range of [0, -1, NaN, Infinity, '30']) {
    const normalized = normalizeLightSettings({ lightKind: 'point', intensity: 1, color: '<script>', groundColor: '#abc', range, nightBehavior: 'unknown' });
    assert.deepEqual(normalized, { lightKind: 'point', intensity: 1 });
  }
  assert.deepEqual(normalizeLightSettings({ lightKind: 'unknown', intensity: -2 }), expected);
  assert.deepEqual(normalizeLightSettings({ intensity: Infinity }), expected);
});

test('暖白作业灯显式保持夜间亮度，参数经清洗后稳定', () => {
  assert.equal(WARM_WORK_LIGHT_SETTINGS.color, '#ffd6a3');
  assert.equal(WARM_WORK_LIGHT_SETTINGS.nightBehavior, 'keep');
  assert.ok(WARM_WORK_LIGHT_SETTINGS.range > 0);
  assert.deepEqual(normalizeLightSettings(WARM_WORK_LIGHT_SETTINGS), WARM_WORK_LIGHT_SETTINGS);
  const light = normalizeLightSettings({ ...WARM_WORK_LIGHT_SETTINGS, range: undefined });
  assert.equal('range' in light, false);
});


test('聚光灯和矩形面光参数保留、拒绝无效数值', () => {
  const spot = { lightKind: 'spot', intensity: 2, angle: Math.PI / 3, exponent: 0, range: 20 };
  const area = { lightKind: 'rectArea', intensity: 3, width: 4, height: 2 };
  assert.deepEqual(normalizeLightSettings(spot), spot);
  assert.deepEqual(normalizeLightSettings(area), area);
  for (const value of [-1, NaN, Infinity, '2']) {
    const light = normalizeLightSettings({ lightKind: 'spot', intensity: 1, angle: value, exponent: value, width: value, height: value });
    assert.deepEqual(light, { lightKind: 'spot', intensity: 1 });
  }
  for (const angle of [0, Math.PI, Math.PI * 2]) assert.equal(normalizeLightSettings({ angle }).angle, undefined);
  assert.equal(normalizeLightSettings({ width: 0, height: 0 }).width, undefined);
});
