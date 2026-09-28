import assert from 'node:assert/strict';
import test from 'node:test';
import { createPainter } from '../../src/runtime/opening/reference/referencePainter.js';

function fixture() {
  const strokes = [], stack = [];
  let points = [];
  const context = { globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '',
    save() { stack.push({ globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, strokeStyle: this.strokeStyle }); },
    restore() { Object.assign(this, stack.pop()); },
    beginPath() { points = []; }, moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
    stroke() { strokes.push({ points: [...points], width: this.lineWidth, alpha: this.globalAlpha, color: this.strokeStyle }); },
    createLinearGradient() { return { addColorStop() {} }; }, createRadialGradient() { return { addColorStop() {} }; },
  };
  const proxy = new Proxy(context, { get(target, key) { return key in target ? target[key] : () => {}; } });
  return { strokes, canvas: { width: 1600, height: 900, getContext: () => proxy } };
}

test('参考飞线配置真实改变颜色透明度、宽度、起点和曲率，零宽隐藏线段', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fixture().canvas };
  try {
    const draw = (style = {}) => {
      const back = fixture(), effects = fixture();
      const images = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, { naturalWidth: 16, naturalHeight: 9 }]));
      const painter = createPainter(back.canvas, effects.canvas, images, { worldOrigin: [.7, .35], chinaOrigin: [.7, .5],
        worldDestinations: [['目标', .8, .5]], chinaDestinations: [], worldRoutesEnabled: true, chinaRoutesEnabled: false,
        worldRouteOverrides: [{ id: 'r', name: '目标', from: { x: .2, y: .5 }, to: { x: .8, y: .5 }, ...style }],
        breathing: { enabled: false, intensity: 0, periodSeconds: 4 } });
      painter.draw(20, false, 20); painter.dispose();
      return effects.strokes.find(stroke => stroke.points.length === 81);
    };
    const route = draw({ color: '#ff000080', width: 5, curvature: 0 });
    assert.ok(route); assert.equal(route.color, 'rgba(255,0,0,0.64)'); assert.equal(route.width, 5);
    assert.ok(Math.abs(route.alpha - 128 / 255) < 1e-10);
    assert.deepEqual(route.points[0], [374, 430]);
    assert.ok(route.points.every(point => Math.abs(point[1] - 430) < 1e-10));
    assert.ok(draw({ curvature: .4 }).points[40][1] < 430);
    assert.equal(draw({ width: 0 }), undefined);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
