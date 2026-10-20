import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, TransformNode } from '@babylonjs/core';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import { clearLiftMotionFrame, getLiftMotionFrame, publishLiftMotionFrame } from '../../src/runtime/babylon/telemetry/liftMotionState';
import { createHcliftTelemetryState, createLiftTelemetryState, resetHcliftTelemetryState, resetLiftTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';

function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('lift', scene);
  const model = { root, liftTelemetry: createLiftTelemetryState(root), hcliftTelemetry: createHcliftTelemetryState(root) } as ModelRuntimeEntry;
  return { model, dispose: () => { scene.dispose(); engine.dispose(); } };
}

test('提升机三通道按模型隔离、记录帧号及世界工位轴并清除非有效位移', () => {
  const h = makeHarness();
  const other = makeHarness();
  try {
    assert.equal(getLiftMotionFrame(h.model), null);
    const axis = { x: 0, y: 0, z: -1 };
    publishLiftMotionFrame(h.model, 42, 0.5, { lift: -2, front: 1, back: Number.NaN, axis });
    assert.deepEqual(getLiftMotionFrame(h.model), {
      frameId: 42, lift: { direction: -1, speed: 4 },
      front: { direction: 1, speed: 2, axis }, back: { direction: 0, speed: 0, axis },
    });
    assert.equal(getLiftMotionFrame(other.model), null);
    axis.z = 1;
    assert.equal(getLiftMotionFrame(h.model)!.front.axis!.z, -1, '摘要轴不得跟随调用方对象突变');
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      publishLiftMotionFrame(h.model, 43, dt, { lift: 1, front: 1, back: 1 });
      assert.deepEqual(getLiftMotionFrame(h.model)!.lift, { direction: 0, speed: 0 });
      assert.deepEqual(getLiftMotionFrame(h.model)!.front, { direction: 0, speed: 0 });
    }
    clearLiftMotionFrame(h.model);
    assert.equal(getLiftMotionFrame(h.model), null);
  } finally { h.dispose(); other.dispose(); }
});

test('真实预览原地重置和遥测对象替换立即使提升机摘要失效', () => {
  const h = makeHarness();
  try {
    for (const reset of [resetLiftTelemetryState, resetHcliftTelemetryState]) {
      publishLiftMotionFrame(h.model, 1, 0.1, { lift: 1, front: 1, back: 1 });
      reset(h.model);
      assert.equal(getLiftMotionFrame(h.model), null);
    }
    publishLiftMotionFrame(h.model, 2, 0.1, { lift: 1, front: 0, back: 0 });
    h.model.liftTelemetry = createLiftTelemetryState(h.model.root);
    assert.equal(getLiftMotionFrame(h.model), null);
    publishLiftMotionFrame(h.model, 3, 0.1, { lift: 1, front: 0, back: 0 });
    h.model.hcliftTelemetry = createHcliftTelemetryState(h.model.root);
    assert.equal(getLiftMotionFrame(h.model), null);
  } finally { h.dispose(); }
});
