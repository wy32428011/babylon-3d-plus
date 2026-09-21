import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultLightWallFence, parseLightWallPoints, validateLightWallPoints, sanitizeLightWallFence } from '../../src/editor/model/lightWallFence.ts';

test('默认围栏是独立的闭合矩形配置', () => {
  const a = createDefaultLightWallFence();
  const b = createDefaultLightWallFence();
  assert.equal(a.height, 3); assert.equal(a.opacity, 0.75);
  assert.equal(a.points.length, 4); assert.equal(validateLightWallPoints(a.points), null);
  a.points[0].x = 99; assert.equal(b.points[0].x, -5);
});

test('轮廓支持凹多边形、中文逗号和重复闭合终点', () => {
  const points = parseLightWallPoints('0,0\n6，0\n6 3\n3,3\n3,6\n0,6\n0,0');
  assert.equal(points.length, 6);
  assert.equal(validateLightWallPoints(points), null);
  assert.equal(validateLightWallPoints([...points].reverse()), null);
});

test('拒绝短边、共线、自交、超量、超界及非数值轮廓', () => {
  for (const text of ['0,0\n1,1', '0,0\n1,0\n2,0', '0,0\n3,3\n0,3\n3,0', '0,0\n0,0\n3,3', '0,0\nNaN,1\n2,3', '0,0\n100001,0\n0,3', '0,0,1\n2,0\n0,2']) {
    assert.throws(() => parseLightWallPoints(text), /轮廓|坐标|顶点/);
  }
  assert.ok(validateLightWallPoints(Array.from({ length: 129 }, (_, i) => ({ x: Math.cos(i), z: Math.sin(i) }))));
  assert.ok(validateLightWallPoints([{ x: 0, z: 0 }, { x: 0.0001, z: 0 }, { x: 0, z: 1 }]));
});

test('参数规范化保留零透明度，限制高度且不共享轮廓引用', () => {
  const input = createDefaultLightWallFence();
  const result = sanitizeLightWallFence({ ...input, height: Infinity, opacity: 0 });
  assert.equal(result.height, 3); assert.equal(result.opacity, 0);
  assert.notEqual(result.points, input.points);
  assert.equal(sanitizeLightWallFence({ ...input, height: -2, opacity: 2 }).height, 0.1);
  assert.equal(sanitizeLightWallFence({ ...input, height: 2000, opacity: -1 }).height, 1000);
  assert.deepEqual(sanitizeLightWallFence(undefined), createDefaultLightWallFence());
});
