import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleChartMarkerPolygons, intersectScreenPolygons } from '../../src/runtime/babylon/chartMarkerVisibility.ts';

function screen(id, left, top, right, bottom, depth) {
  return {
    id,
    corners: [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y]) => ({
      x, y, depth: typeof depth === 'function' ? depth(x, y) : depth,
    })),
  };
}

function area(polygons) {
  return polygons.reduce((sum, polygon) => sum + Math.abs(polygon.reduce((value, point, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return value + point.x * next.y - next.x * point.y;
  }, 0)) / 2, 0);
}

function covers(polygons, x, y) {
  return polygons.some(polygon => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  });
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `实际面积 ${actual}，预期 ${expected}`);
}

test('分离立标和仅边缘接触的立标保留完整可见区域，不修改输入', () => {
  const screens = [screen('a', 0, 0, 2, 2, 0.8), screen('b', 3, 0, 5, 2, 0.2), screen('c', 0, 2, 2, 4, 0.1)];
  const snapshot = structuredClone(screens);
  const visible = getVisibleChartMarkerPolygons(screens);
  for (const id of ['a', 'b', 'c']) close(area(visible.get(id)), 4);
  assert.deepEqual(screens, snapshot);
});

test('前牌仅扣除重叠区域，全遮挡时后牌为空', () => {
  let visible = getVisibleChartMarkerPolygons([screen('back', 0, 0, 4, 2, 0.8), screen('front', 2, 0, 5, 2, 0.2)]);
  close(area(visible.get('back')), 4);
  close(area(visible.get('front')), 6);
  assert.ok(covers(visible.get('back'), 1, 1));
  assert.equal(covers(visible.get('back'), 3, 1), false);
  visible = getVisibleChartMarkerPolygons([screen('back', 0, 0, 4, 2, 0.8), screen('front', -1, -1, 5, 3, 0.2)]);
  assert.deepEqual(visible.get('back'), []);
});

test('倾斜大牌中心虽较远，近端仍遮住不相交的小牌', () => {
  const visible = getVisibleChartMarkerPolygons([
    screen('tilted', 0, 0, 10, 10, x => 0.1 + x * 0.08),
    screen('small', 1, 1, 2, 2, 0.4),
  ]);
  close(area(visible.get('tilted')), 100);
  assert.deepEqual(visible.get('small'), []);
});

test('交叉立标按交线两侧的实际深度分别显示，支持反向绕序', () => {
  const first = screen('rising', 0, 0, 4, 2, x => 0.2 + x * 0.1);
  const second = screen('falling', 0, 0, 4, 2, x => 0.6 - x * 0.1);
  second.corners.reverse();
  const visible = getVisibleChartMarkerPolygons([first, second]);
  close(area(visible.get('rising')), 4);
  close(area(visible.get('falling')), 4);
  assert.ok(covers(visible.get('rising'), 1, 1));
  assert.equal(covers(visible.get('rising'), 3, 1), false);
  assert.ok(covers(visible.get('falling'), 3, 1));
  assert.equal(covers(visible.get('falling'), 1, 1), false);
});

test('多个遮挡区域相交时差集保留分离片段，不重复扣除或输出重叠面积', () => {
  const visible = getVisibleChartMarkerPolygons([
    screen('back', 0, 0, 10, 10, 0.9),
    screen('vertical', 2, 0, 4, 10, 0.3),
    screen('horizontal', 0, 4, 10, 6, 0.2),
  ]);
  close(area(visible.get('back')), 64);
  close(area(visible.get('vertical')), 16);
  close(area(visible.get('horizontal')), 20);
  for (const [x, y] of [[1, 1], [8, 1], [1, 8], [8, 8]]) assert.ok(covers(visible.get('back'), x, y));
  assert.equal(covers(visible.get('back'), 3, 5), false);
});

test('斜边四边形与斜向深度交线使用精确多边形边界', () => {
  const diamond = { id: 'diamond', corners: [[0, 2], [2, 0], [4, 2], [2, 4]].map(([x, y]) => ({ x, y, depth: 0.8 })) };
  const diamondVisible = getVisibleChartMarkerPolygons([diamond, screen('strip', 1, -1, 3, 5, 0.2)]);
  close(area(diamondVisible.get('diamond')), 2);
  assert.ok(covers(diamondVisible.get('diamond'), 0.5, 2));
  assert.ok(covers(diamondVisible.get('diamond'), 3.5, 2));
  assert.equal(covers(diamondVisible.get('diamond'), 2, 2), false);

  const diagonalVisible = getVisibleChartMarkerPolygons([
    screen('tilted', 0, 0, 4, 4, (x, y) => 0.2 + (x + y) * 0.05),
    screen('flat', 0, 0, 4, 4, 0.4),
  ]);
  close(area(diagonalVisible.get('tilted')), 8);
  close(area(diagonalVisible.get('flat')), 8);
  assert.ok(covers(diagonalVisible.get('tilted'), 1, 1));
  assert.ok(covers(diagonalVisible.get('flat'), 3, 3));
});

test('同一深度按输入次序稳定保留后面的立标', () => {
  const first = screen('first', 0, 0, 4, 2, (x, y) => 0.2 + x * 0.02 + y * 0.03);
  const second = { ...structuredClone(first), id: 'second' };
  const visible = getVisibleChartMarkerPolygons([first, second]);
  assert.deepEqual(visible.get('first'), []);
  close(area(visible.get('second')), 8);
});

test('退化或非有限坐标不遮挡有效立标，也不生成非法路径', () => {
  const screens = [
    screen('valid', 0, 0, 4, 2, 0.8),
    screen('line', 0, 1, 4, 1, 0.1),
    screen('point', 1, 1, 1, 1, 0.1),
    screen('invalid', 0, 0, Number.POSITIVE_INFINITY, 2, 0.1),
    screen('invalid-depth', 0, 0, 4, 2, Number.NaN),
    { id: 'empty', corners: [] },
  ];
  const visible = getVisibleChartMarkerPolygons(screens);
  close(area(visible.get('valid')), 8);
  for (const item of screens.slice(1)) assert.deepEqual(visible.get(item.id), []);
  assert.equal(getVisibleChartMarkerPolygons([]).size, 0);
});

test('内容区域与可见片段求交，支持不同绕向且不改变输入', () => {
  const content = screen('content', 1, 1, 5, 4, 0.5).corners;
  const fragment = screen('fragment', 3, 0, 7, 3, 0.5).corners;
  const snapshot = structuredClone({ content, fragment });
  for (const a of [content, [...content].reverse()]) {
    for (const b of [fragment, [...fragment].reverse()]) {
      const intersection = intersectScreenPolygons(a, b);
      close(area([intersection]), 4);
      assert.ok(covers([intersection], 4, 2));
      assert.equal(covers([intersection], 2, 2), false);
      assert.equal(covers([intersection], 4, 3.5), false);
    }
  }
  assert.deepEqual({ content, fragment }, snapshot);
});

test('内容区域无交集、仅边缘相接或退化时不输出点击孔', () => {
  const content = screen('content', 1, 1, 5, 4, 0.5).corners;
  for (const clip of [
    screen('separate', 6, 1, 7, 4, 0.5).corners,
    screen('edge', 5, 1, 7, 4, 0.5).corners,
    screen('line', 2, 1, 2, 4, 0.5).corners,
    screen('invalid', Number.NaN, 1, 3, 4, 0.5).corners,
    [],
  ]) assert.deepEqual(intersectScreenPolygons(content, clip), []);
});
