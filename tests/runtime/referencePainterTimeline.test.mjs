import assert from 'node:assert/strict';
import test from 'node:test';
import { createPainter } from '../../src/runtime/opening/reference/referencePainter.js';
import { createDefaultReferenceOpening } from '../../src/editor/model/sceneOpeningReference.ts';
import { getReferenceOpeningFrame } from '../../src/runtime/opening/referenceOpeningTimeline.ts';

function fixture(t, breathing = { enabled: true, intensity: .65, periodSeconds: 4 }) {
  const effectsArcs = [];
  const radius = value => {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Canvas2D radius (${value}) is negative or non-finite`);
  };
  const canvas = arcs => {
    const surface = { width: 1600, height: 900 };
    const gradient = () => ({ addColorStop() {} });
    const context = new Proxy({
      canvas: surface, globalAlpha: 1,
      arc(x, y, r) { radius(r); arcs?.push({ x, y, r }); },
      ellipse(_x, _y, rx, ry) { radius(rx); radius(ry); },
      createLinearGradient: gradient,
      createRadialGradient(_x0, _y0, r0, _x1, _y1, r1) { radius(r0); radius(r1); return gradient(); },
    }, { get: (target, key) => key in target ? target[key] : () => undefined });
    surface.getContext = () => context;
    return surface;
  };
  // 调用真实 painter，仅替代 Canvas；半径沿用浏览器的有限非负约束。
  const withDocument = action => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas() } });
    try { return action(); } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete globalThis.document;
    }
  };
  const reference = createDefaultReferenceOpening();
  const painter = withDocument(() => createPainter(canvas(), canvas(effectsArcs),
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, { naturalWidth: 512, naturalHeight: 512 }])), {
      worldOrigin: [reference.worldOrigin.x, reference.worldOrigin.y],
      chinaOrigin: [reference.chinaOrigin.x, reference.chinaOrigin.y],
      worldDestinations: reference.worldDestinations.map(p => [p.name, p.x, p.y]),
      chinaDestinations: reference.chinaDestinations.map(p => [p.name, p.x, p.y]),
      worldRoutesEnabled: true, chinaRoutesEnabled: true, breathing,
    }));
  t.after(() => painter.dispose());
  return { painter, reference, draw: (referenceSeconds, actualSeconds) => {
    effectsArcs.length = 0;
    withDocument(() => painter.draw(referenceSeconds, true, actualSeconds));
    return effectsArcs.map(arc => ({ ...arc }));
  } };
}

test('六秒开场全球业务的真实失败时刻仍绘制有效脉冲，不能产生负半径', t => {
  const f = fixture(t);
  const arcs = f.draw(17.540833332717412, 1.6974999999403948);
  const pulses = arcs.filter(arc => arc.r !== 1.7);
  assert.ok(pulses.length > 0, '保持动态终点脉冲，不通过关闭特效规避错误');
  assert.ok(pulses.every(arc => arc.r >= 3 && arc.r < 11));
});

test('短时长、长时长及阶段零停留在正播和反向寻帧时半径始终有效', t => {
  const f = fixture(t);
  for (const total of [6, 62, 300]) {
    const reference = { ...f.reference, stageDurations: f.reference.stageDurations.map(value => value * total / 62) };
    const times = [0, total, ...Array.from({ length: 181 }, (_, i) => total * i / 180)];
    let boundary = 0;
    for (const duration of reference.stageDurations) {
      boundary += duration;
      times.push(Math.max(0, boundary - 1e-7), boundary, Math.min(total, boundary + 1e-7));
    }
    for (const elapsed of [...times, ...times.toReversed()]) {
      const frame = getReferenceOpeningFrame(elapsed, reference);
      assert.doesNotThrow(() => f.draw(frame.referenceSeconds, frame.elapsedSeconds), `total=${total}, elapsed=${elapsed}`);
    }
  }
  const zeroHold = { ...f.reference, stageDurations: [.1, .1, 0, .1, .1, 0, .1, .1, .1] };
  for (const elapsed of [0, .1, .2, .3, .4, .5, .6, .7, .6, .4, .2, 0]) {
    const frame = getReferenceOpeningFrame(elapsed, zeroHold);
    assert.doesNotThrow(() => f.draw(frame.referenceSeconds, frame.elapsedSeconds));
  }
});

test('脉冲寻帧确定、随真实时钟继续变化，静态呼吸配置保持稳定', t => {
  const f = fixture(t);
  const first = f.draw(20, 2);
  f.draw(39, 3.5); f.draw(16.5, .5);
  assert.deepEqual(f.draw(20, 2), first);
  assert.notDeepEqual(f.draw(20, 2.25), first);
  for (const breathing of [
    { enabled: false, intensity: .65, periodSeconds: 4 },
    { enabled: true, intensity: 0, periodSeconds: 2 },
    { enabled: true, intensity: 1, periodSeconds: 10 },
  ]) {
    const current = fixture(t, breathing);
    const early = current.draw(39, 1), late = current.draw(39, 1.5);
    if (!breathing.enabled || breathing.intensity === 0) assert.deepEqual(early, late);
    else assert.notDeepEqual(early, late);
  }
});
