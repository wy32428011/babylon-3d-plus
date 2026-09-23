import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultConveyorSurfaceArrowsConfig, getConveyorSurfaceArrowDirectionError, normalizeConveyorSurfaceArrowsConfig } from '../../src/editor/model/conveyorSurfaceArrows.ts';

test('默认启用表面箭头，默认配置及点位映射实例互相独立', () => {
  for (const value of [undefined, null, false, [], 'arrow', 1]) {
    assert.equal(normalizeConveyorSurfaceArrowsConfig(value), undefined);
  }
  const first = createDefaultConveyorSurfaceArrowsConfig();
  const second = createDefaultConveyorSurfaceArrowsConfig();
  assert.equal(first.enabled, true);
  assert.equal(first.length, 0);
  assert.equal(first.width, 0);
  assert.equal(first.surfaceNode, '');
  first.color = '#ffffff';
  assert.equal(second.color, '#39d8ff');
  assert.equal(first.style, 'conveyor-direction');
  assert.equal(first.breathingEnabled, true);
  assert.deepEqual(second.directionBinding, { mode: 'model', field: 'movement_x', forwardValue: '1', reverseValue: '2', stopValue: '0' });
  first.directionBinding.field = 'other';
  assert.equal(second.directionBinding.field, 'movement_x');
});

test('有效配置保留关闭、静止、自动范围和负向位置微调，归一化幂等', () => {
  const result = normalizeConveyorSurfaceArrowsConfig({
    enabled: false, speed: 0, opacity: 0, length: 0, width: 0,
    offsetAlong: -2, offsetAcross: -0.2, surfaceNode: '  Conveyor.Top  ', color: '#AABBCC',
  });
  assert.equal(result?.enabled, false);
  assert.equal(result?.speed, 0);
  assert.equal(result?.opacity, 0);
  assert.equal(result?.length, 0);
  assert.equal(result?.width, 0);
  assert.equal(result?.offsetAlong, -2);
  assert.equal(result?.offsetAcross, -0.2);
  assert.equal(result?.surfaceNode, 'Conveyor.Top');
  assert.equal(result?.color, '#aabbcc');
  assert.deepEqual(normalizeConveyorSurfaceArrowsConfig(result), result);
});

test('非有限数字回退并限制负尺寸、透明度和箭头中心间距', () => {
  const defaults = createDefaultConveyorSurfaceArrowsConfig();
  const result = normalizeConveyorSurfaceArrowsConfig({
    enabled: 'true', surfaceOffset: NaN, offsetAlong: Infinity, width: -20,
    arrowLength: 2, arrowWidth: -1, spacing: 0.1, opacity: 50,
    color: 'url(script)', speed: -1, unknown: 'discarded',
  });
  assert.ok(result);
  assert.equal(result.enabled, true);
  assert.equal(result.surfaceOffset, defaults.surfaceOffset);
  assert.equal(result.offsetAlong, defaults.offsetAlong);
  assert.equal(result.width, 0);
  assert.ok(result.arrowWidth > 0);
  assert.ok(result.spacing >= result.arrowLength + 0.02);
  assert.equal(result.opacity, 1);
  assert.equal(result.color, defaults.color);
  assert.equal(result.speed, 0);
  assert.equal('unknown' in result, false);
  for (const value of Object.values(result)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
});

test('样式呼吸和自定义值保留，旧对象默认补齐，非法样式只回退内置箭头', () => {
  const normalized = normalizeConveyorSurfaceArrowsConfig({
    style: 'moving-double-arrow', breathingEnabled: false, breathingStrength: 0, breathingPeriod: 2.5,
    directionBinding: { mode: 'point', field: 'motor.direction', forwardValue: '001', reverseValue: '002', stopValue: '000' },
  })!;
  assert.equal(normalized.style, 'moving-double-arrow');
  assert.equal(normalized.breathingEnabled, false);
  assert.equal(normalized.breathingStrength, 0);
  assert.equal(normalized.directionBinding.forwardValue, '001');
  assert.deepEqual(normalizeConveyorSurfaceArrowsConfig(normalized), normalized);
  assert.equal(normalizeConveyorSurfaceArrowsConfig({ style: 'fire' })?.style, 'conveyor-direction');
  assert.match(getConveyorSurfaceArrowDirectionError({ mode: 'point', field: 'direction', forwardValue: '1', reverseValue: '1 ', stopValue: '0' })!, /互不相同/);
});
