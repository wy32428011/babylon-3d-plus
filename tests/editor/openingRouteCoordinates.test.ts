import assert from 'node:assert/strict';
import test from 'node:test';
import { openingUvFromPointer, openingRouteCurve } from '../../src/editor/opening/openingRouteCoordinates.ts';

test('底图拾点使用实际尺寸，保留边缘零值并限制拖动范围', () => {
  const rectangle = { left: 20, top: 40, width: 500, height: 250 };
  assert.deepEqual(openingUvFromPointer(20, 40, rectangle), { x: 0, y: 0 });
  assert.deepEqual(openingUvFromPointer(270, 165, rectangle), { x: .5, y: .5 });
  assert.deepEqual(openingUvFromPointer(-100, 1000, rectangle), { x: 0, y: 1 });
  assert.equal(openingUvFromPointer(0, 0, { ...rectangle, width: 0 }), null);
});

test('飞线曲线包含两个 UV 端点且曲率只改变控制点', () => {
  const from = { x: .1, y: .2 }, to = { x: .8, y: .6 };
  const line = openingRouteCurve(from, to, 0);
  const curve = openingRouteCurve(from, to, .3);
  assert.match(line, /^M 100 200 Q /);
  assert.match(curve, / 800 600$/);
  assert.notEqual(line, curve);
});
