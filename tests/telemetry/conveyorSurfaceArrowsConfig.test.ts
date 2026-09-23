import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultConveyorSurfaceArrowsConfig, normalizeConveyorSurfaceArrowsConfig } from '../../src/editor/model/conveyorSurfaceArrows.ts';

test('旧场景不自动启用表面箭头，默认配置实例互相独立', () => {
  for (const value of [undefined, null, false, [], 'arrow', 1]) {
    assert.equal(normalizeConveyorSurfaceArrowsConfig(value), undefined);
  }
  const first = createDefaultConveyorSurfaceArrowsConfig();
  const second = createDefaultConveyorSurfaceArrowsConfig();
  assert.equal(first.enabled, false);
  assert.equal(first.length, 0);
  assert.equal(first.width, 0);
  assert.equal(first.surfaceNode, '');
  first.color = '#ffffff';
  assert.equal(second.color, '#39d8ff');
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
  assert.equal(result.enabled, false);
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
