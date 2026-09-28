import assert from 'node:assert/strict';
import test from 'node:test';
import { flightWindowOpacity, resolveFlightWindow, layoutFlightLabels, wrapFlightLabel } from '../../src/runtime/opening/geographicOpeningFlightsLayout.ts';
import { projectGeographicPoint } from '../../src/runtime/opening/geographicOpeningMath.ts';

test('全球原时窗保持5秒进入、8秒开始淡退、9秒清空', () => {
  const window = resolveFlightWindow();
  for (const time of [-1, 0, 5, 9, 30, Number.NaN]) assert.equal(flightWindowOpacity(time, window), 0);
  assert.equal(flightWindowOpacity(6, window), 1);
  assert.equal(flightWindowOpacity(8, window), 1);
  assert.ok(flightWindowOpacity(8.5, window) > 0 && flightWindowOpacity(8.5, window) < 1);
});

test('国内时窗按真实停留秒数计算，短停留和零停留均不会出现负数或残影', () => {
  for (const endTime of [0, 0.2, 1, 6, 30]) {
    const window = resolveFlightWindow({ startTime: 0, endTime, fadeDuration: 0.65 });
    assert.equal(flightWindowOpacity(-0.01, window), 0);
    assert.equal(flightWindowOpacity(endTime, window), 0);
    assert.equal(flightWindowOpacity(endTime + 10, window), 0);
    if (endTime > 0) assert.equal(flightWindowOpacity(endTime / 2, window), 1);
    for (let step = 0; step <= 20; step++) {
      const value = flightWindowOpacity(step / 20 * endTime, window);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    }
  }
  assert.equal(flightWindowOpacity(1, resolveFlightWindow({ startTime: 4, endTime: 1 })), 0);
});

const intersects = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => (
  Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2
);

test('默认沪杭皖近距离地区标签避让，保留真实经纬锚点并产生引导线', () => {
  const points = [[104.07, 30.67], [121.47, 31.23], [120.16, 30.25], [114.06, 22.54], [117.23, 31.82]];
  const origin = projectGeographicPoint(120.3, 31.68, 1);
  const inputs = points.map(([lon, lat], index) => {
    const p = projectGeographicPoint(lon, lat, 1);
    return { index, anchorX: p[0], anchorY: p[1], width: 0.12, height: 0.046 };
  });
  const original = structuredClone(inputs);
  const labels = layoutFlightLabels(inputs, { originX: origin[0], originY: origin[1], referenceViewHeight: 0.5 });
  assert.equal(labels.length, 5);
  labels.forEach((label, i) => {
    assert.equal(label.anchorX, original[i].anchorX);
    assert.equal(label.anchorY, original[i].anchorY);
    assert.ok(Math.hypot(label.x - label.anchorX, label.y - label.anchorY) > 0.02);
    for (const other of labels.slice(i + 1)) assert.equal(intersects(label, other), false);
  });
  assert.deepEqual(inputs, original, '布局不修改真实地点或调用者数据');
  assert.deepEqual(layoutFlightLabels(inputs, { originX: origin[0], originY: origin[1], referenceViewHeight: 0.5 }), labels);
});

test('空列表不补回默认地区，32个重合锚点仍有有限且不相交的标签布局', () => {
  assert.deepEqual(layoutFlightLabels([], { originX: 0, originY: 0, referenceViewHeight: 1 }), []);
  const labels = layoutFlightLabels(Array.from({ length: 32 }, (_, index) => ({ index, anchorX: 0, anchorY: 0, width: 0.22, height: 0.08 })), { originX: 0, originY: 0, referenceViewHeight: 1 });
  assert.equal(labels.length, 32);
  labels.forEach((label, i) => {
    assert.ok(Number.isFinite(label.x) && Number.isFinite(label.y));
    for (const other of labels.slice(i + 1)) assert.equal(intersects(label, other), false);
  });
});

test('较长地区名称按行显示，中文与Unicode字符不丢失或切坏', () => {
  const text = '安徽省合肥市示意区域🌐扩展名称';
  const lines = wrapFlightLabel(text, 6);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => Array.from(line).length <= 6));
  assert.deepEqual(wrapFlightLabel('上海'), ['上海']);
});
